// E2E scenarios for the Moon provider.
//
// A Moonrepo workspace uses `.moon/workspace.yml` and per-project `moon.yml`
// files. Lattice discovers the workspace via `.moon/` and reads the project
// graph from `moon project-graph --json` — the same one-call contract as the
// Nx provider, but without Nx installed. These scenarios prove that Lattice's
// analysis, graph construction, and boundary enforcement work through the Moon
// provider against a real installed CLI.
import { execSync } from "node:child_process";
import { existsSync, writeSync } from "node:fs";
import { join } from "node:path";

import { describe as vitestDescribe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import { createMoonConsumer, commitFiles } from "./helpers/consumer.mjs";
import { lattice } from "./helpers/run.mjs";
import { MOON_LIB_REACHES_APP } from "./fixtures/violations.mjs";

// Can the `moon` CLI run here at all? The fixture is a Moon workspace and the
// Moon provider calls `moon project-graph --json`; the consumer installs
// `@moonrepo/cli` as a devDependency, so Moon lives in the consumer's own
// `node_modules/.bin`. This probe only asks whether Moon runs on this platform
// (the consumer's install would fail otherwise, with a more confusing error).
let moonAvailable = false;
let moonProbeFailure = "";
try {
  execSync("npx moon --version", { stdio: "pipe" });
  moonAvailable = true;
} catch (cause) {
  // The last few meaningful lines only: a failing `npx` prints a screenful of
  // registry and config warnings ahead of the fact, and a reason nobody reads
  // to the end of is barely better than no reason.
  moonProbeFailure = String(cause?.stderr || cause?.message || cause)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-3)
    .join(" · ");
}

// A whole E2E file that vanishes is byte-for-byte identical to one that
// passed — `../../../AGENTS.md`'s invariant, applied to a suite rather than to
// a diagnostic list. Nothing upstream catches it either: `ci.yml`'s E2E job
// fails a shard that resolves NO test file and one that resolves fewer files
// than shards, and an all-skipped file is neither.
//
// So in CI an unavailable Moon is a FAILURE, never a skip. `@moonrepo/cli` is
// a declared devDependency of the consumer fixture this suite builds, and CI
// runs on a platform Moon ships for, so "Moon cannot run" there is a real
// breakage — a broken install, a removed dependency, a platform the release
// dropped — and every one of those is a thing to fix rather than to step over.
//
// Locally the skip stays, because a contributor without a working Moon should
// still be able to run the rest of the suite. What it may not do is stay
// SILENT: the reason is printed, so a developer who sees the Moon scenarios
// missing knows why rather than assuming they passed.
const moonRequired = Boolean(process.env.CI);
const unavailableReason =
  "lattice e2e: `npx moon --version` could not run, so the Moon E2E scenarios did not execute. " +
  "`@moonrepo/cli` is a declared devDependency of the consumer fixture, so on a supported " +
  `platform this is a broken install rather than an unsupported one. Probe failure: ${moonProbeFailure}`;

const describe = moonAvailable ? vitestDescribe : vitestDescribe.skip;

if (!moonAvailable) {
  if (moonRequired) {
    // A registered, failing test rather than a module-scope throw: a
    // collection error names the file, this names the REASON, in the
    // reporter's own list where a reader is already looking for what went
    // wrong.
    vitestDescribe("Moon", () => {
      it("has a runnable Moon CLI, which CI requires rather than skips", () => {
        throw new Error(unavailableReason);
      });
    });
  } else {
    // Written to the real stderr descriptor, not through `console`. Measured
    // against vitest 4.1.11: a file whose every test is skipped has its
    // console output dropped by the default reporter, and so does a test that
    // calls `ctx.skip()` — through either channel the reason never reaches the
    // terminal, and the run prints a bare skipped count that reads exactly
    // like a suite nobody needed. `writeSync(2, …)` is below the interception
    // and always arrives.
    writeSync(2, `\n${unavailableReason}\n\n`);
  }
}

let artifact;
let moonConsumer;

describe("Moon", () => {
  // Inside the suite, not at module scope: with the scenarios skipped these
  // hooks must not run either. `packArtifact` + `createMoonConsumer` install a
  // whole consumer workspace, and doing that for a suite that will not use it
  // turns an honest skip into a slow one — and, in the CI branch above, buries
  // the named failure under an install error from the same missing Moon.
  beforeAll(() => {
    artifact = packArtifact();
    moonConsumer = createMoonConsumer(artifact);
  });

  afterAll(() => {
    moonConsumer?.cleanup();
    artifact?.cleanup();
  });

  it("exits 0 on a clean Moon tree and states what it inspected", () => {
    const result = lattice(moonConsumer.root, ["check"]);
    expect(result.exitCode).toBe(0);
    // "no violations" is a claim about coverage too — a 0 that inspected
    // nothing is the same silence as no check at all.
    expect(result.stdout).toMatch(/[1-9]\d* import/);
    expect(result.stdout).toMatch(/[1-9]\d* file/);
    expect(result.stdout).toMatch(/[1-9]\d* project/);
  });

  it("exits 0 on a clean Moon tree for graph and states project and edge counts", () => {
    const result = lattice(moonConsumer.root, ["graph"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/[1-9]\d* project/);
    expect(result.stdout).toMatch(/[1-9]\d* edge/);
  });

  it("exits 1 on a violating Moon tree, naming the rule and position", () => {
    // Each violating test needs its own consumer to avoid mutating the shared
    // clean consumer. Create a fresh one.
    const violator = createMoonConsumer(artifact);
    try {
      commitFiles(violator.root, MOON_LIB_REACHES_APP, "core reaches up into cli");
      const result = lattice(violator.root, ["check"]);
      expect(result.exitCode).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("onlyTagsConstraintViolation");
      expect(output).toMatch(/libs\/core\/src\/index\.ts:\d+:\d+/);
    } finally {
      violator.cleanup();
    }
  });

  // #262, end to end: a dependency a human wrote into `moon.yml` with NO
  // import behind it. `evaluate()` structurally cannot reach it — there is no
  // import site to iterate — so the only thing that can judge it is
  // `declaredEdgeViolationsForCheck`, which selects on `edge.type ===
  // "implicit"`. Moon spells hand-declared `source: "explicit"`, the inverse
  // of Lattice's word; while the provider matched the two by spelling, this
  // exact tree printed `no declared-edge violations` and exited 0.
  //
  // `core` is `type-lib` and `cli` is `type-app`, and the fixture's constraint
  // table lets `type-lib` depend on `type-lib` only — so the declaration alone
  // is a violation, with not a line of source touched.
  it("exits 1 on a dependency declared only in moon.yml, with no import behind it", () => {
    const violator = createMoonConsumer(artifact);
    try {
      commitFiles(
        violator.root,
        {
          "libs/core/moon.yml":
            "id: core\n" +
            "language: typescript\n" +
            "layer: library\n" +
            "stack: backend\n" +
            "tags:\n" +
            "  - type-lib\n" +
            "  - lang-ts\n" +
            "dependsOn:\n" +
            "  - cli\n",
        },
        "core declares a dependency on the cli app, and imports nothing",
      );
      const result = lattice(violator.root, ["check"]);
      const output = `${result.stdout}${result.stderr}`;
      expect(result.exitCode).toBe(1);
      expect(output).toContain("onlyTagsConstraintViolation");

      // And it is reported AS a declared edge — not as an import site it does
      // not have. The edge line, not a bare `/core/` and `/cli/`: the
      // constraint message alone contains both words, so those two regexes
      // matched whatever the report said, including nothing about this edge.
      expect(output).toContain("core → cli");

      // The file a declared-edge finding names is the whole of its address —
      // there is no import site, so nothing else sends a reader to the
      // declaration. It therefore has to be a file this workspace HAS: a Moon
      // tree is refused outright for carrying `lattice.json`
      // (`../src/commands/context.mjs`), so reporting that name here would
      // send every reader to a path the workspace is forbidden to contain,
      // and the combined-output regexes this replaces could not see the
      // difference.
      const json = lattice(violator.root, ["check", "--format", "json"]);
      expect(json.json).not.toBeNull();
      const findings = json.json.result.declaredEdges.findings;
      expect(findings).toHaveLength(1);
      const [finding] = findings;
      expect(finding.source).toBe("core");
      expect(finding.target).toBe("cli");
      expect(existsSync(join(violator.root, finding.file))).toBe(true);
      // Explicitly: `dependsOn` is declared in the declaring project's own
      // `moon.yml`, so that is the file — the Moon counterpart of the
      // `<projectRoot>/project.json` an Nx declared-edge finding names.
      expect(finding.file).toBe("libs/core/moon.yml");
      // The text a human reads names the same path, not a second one.
      expect(output).toContain(`${finding.file}  ${finding.messageId}`);
    } finally {
      violator.cleanup();
    }
  });

  // REPLACES a test that ran `check` on the untouched consumer and asserted
  // exit 0 — byte-for-byte what "exits 0 on a clean Moon tree" already
  // asserts on the same fixture, and true under the OLD, inverted mapping
  // too. It was presented as #262's false-positive guard and could not fail
  // for the reason it existed.
  //
  // The false-positive claim only means something if the two mappings give
  // different answers here. They do, but not in the exit code: `web → api`
  // and `api → core` are hand-declared in the fixture's `moon.yml` files
  // (`dependsOn`, which Moon reports as `source: "explicit"` — measured
  // against moon 2.4.6) and both are PERMITTED, so either mapping exits 0.
  // What separates them is whether those edges were judged AS declarations at
  // all: with the mapping right they carry Lattice's `implicit` type and
  // `check` states the coverage claim it judged them under; with it inverted
  // the graph holds no `implicit` edge, `declaredEdges` is `null`, and a run
  // that judged nothing exits 0 looking exactly like this one.
  it("judges the fixture's permitted hand-declared edges AS declarations, and reports none", () => {
    const result = lattice(moonConsumer.root, ["check", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    const declaredEdges = result.json.result.declaredEdges;
    // Not null, and judged: the permitted declarations were looked at. `null`
    // is the inverted mapping's answer — "no declared edges here" — which the
    // exit code cannot tell apart from "looked, found nothing".
    expect(declaredEdges).not.toBeNull();
    expect(declaredEdges.judged).toBeGreaterThanOrEqual(2);
    // And nothing manufactured from them: a fix for a missed violation that
    // invents false ones is not a fix.
    expect(declaredEdges.findings).toEqual([]);

    // The direction itself, per edge rather than counted. Under the inverted
    // mapping each of these is `static`, and the import-derived edge for the
    // same pair dedupes onto that same triple — so there is no spelling of
    // the wrong mapping that leaves an `implicit` edge here.
    const graph = lattice(moonConsumer.root, ["graph", "--format", "json"]);
    const typesFor = (source, target) =>
      graph.json.result.dependencies
        .filter((edge) => edge.source === source && edge.target === target)
        .map((edge) => edge.type);
    expect(typesFor("web", "api")).toContain("implicit");
    expect(typesFor("api", "core")).toContain("implicit");
  });

  it("produces a valid JSON envelope for check on a clean Moon tree", () => {
    const result = lattice(moonConsumer.root, ["check", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("check");
    expect(result.json.schemaVersion).toBe(2);
    expect(result.json.status).toBe("ok");
    expect(result.json.exitCode).toBe(0);
    expect(result.json.coverage.complete).toBe(true);
    expect(result.json.coverage.notAnalyzed).toEqual([]);
    expect(result.json.coverage.imports).toBeGreaterThan(0);
    expect(result.json.coverage.analyzedFiles).toBeGreaterThan(0);
  });

  it("produces a valid JSON envelope for graph on a clean Moon tree", () => {
    const result = lattice(moonConsumer.root, ["graph", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("graph");
    expect(result.json.schemaVersion).toBe(2);
    expect(result.json.status).toBe("ok");
    expect(result.json.coverage.complete).toBe(true);
    expect(Array.isArray(result.json.result.projects)).toBe(true);
    expect(Array.isArray(result.json.result.dependencies)).toBe(true);
  });

  it("includes expected project names in the graph JSON output", () => {
    const result = lattice(moonConsumer.root, ["graph", "--format", "json"]);
    const names = result.json.result.projects.map((p) => p.name);
    expect(names).toContain("web");
    expect(names).toContain("cli");
    expect(names).toContain("api");
    expect(names).toContain("core");
  });

  it("diff exits 0 and reports no changes against a self-baseline", () => {
    const baselineFile = join(moonConsumer.root, "baseline-moon.json");
    lattice(moonConsumer.root, ["graph", "--format", "json", "--output", baselineFile]);
    const result = lattice(moonConsumer.root, ["diff", baselineFile]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no changes");
  });

  it("impact reports direct and transitive dependents for a leaf project", () => {
    const result = lattice(moonConsumer.root, ["impact", "core", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("impact");
    expect(result.json.result.dependents).toContain("api");
    expect(result.json.result.dependents).toContain("web");
  });

  it("explain explains a violating import site", () => {
    const violator = createMoonConsumer(artifact);
    try {
      commitFiles(violator.root, MOON_LIB_REACHES_APP, "core reaches up into cli");
      // libs/core/src/index.ts line 1: `import { cli } from "@acme/cli"`
      // Position 1:21 is where the specifier "@acme/cli" starts.
      const result = lattice(violator.root, [
        "explain",
        "libs/core/src/index.ts:1:21",
        "--format",
        "json",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.json).not.toBeNull();
      expect(result.json.result.import.specifier).toBe("@acme/cli");
      expect(result.json.result.import.sourceProject).toBe("core");
      expect(result.json.result.import.targetProject).toBe("cli");
      expect(result.json.result.violations).not.toBeNull();
      expect(result.json.result.violations[0].messageId).toBe("onlyTagsConstraintViolation");
    } finally {
      violator.cleanup();
    }
  });

  it("uses the Moon provider — provider is moon, not native or nx", () => {
    // The fixture has `.moon/` but no `lattice.json` and no `nx.json`, so
    // the Moon provider is the one that runs. Assert the JSON envelope's
    // `workspace.provider` field.
    const result = lattice(moonConsumer.root, ["graph", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json.workspace.provider).toBe("moon");
  });

  it("context returns project tags and constraints on a Moon tree", () => {
    const result = lattice(moonConsumer.root, ["context", "core", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("context");
    expect(result.json.result.tags).toContain("layer:library");
    expect(result.json.result.constraints.length).toBeGreaterThanOrEqual(1);
  });

  it("context warns in coverage.notes that per-edge verdicts cover only depConstraints", () => {
    const result = lattice(moonConsumer.root, ["context", "core", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json.coverage.notes).toHaveLength(1);
    expect(result.json.coverage.notes[0]).toContain("depConstraints");
  });
});

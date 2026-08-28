import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

import { check, EXIT, parseCheckArgs, runCli } from "../cli.mjs";
import { computePolicyFingerprint } from "./commands/graph.mjs";
import { loadBoundaryConfigFile } from "./config.mjs";
import { readProjectGraph } from "./providers/nx.mjs";
import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../spawn-budget.mjs";

// Every test in this file that exercises the process boundary makes one or
// more spawned cold starts (`run`, and every raw `spawnSync("git", ...)`
// below), so the whole FILE runs under the derived spawn-test ceiling rather
// than vitest's 5000 ms default (#249's failing test lived here) — one
// module-scope call, not a `{ timeout: SPAWN_TEST_BUDGET_MS }` repeated on
// whichever blocks someone remembered to mark. `vi.setConfig` "updates
// configuration options specifically for the current test file" and vitest
// resets it after the file runs, so this cannot leak into another file.
// `../spawn-budget.mjs` owns both numbers; `spawn-budget.test.mjs` is the
// gate that requires this call rather than trusting the import alone.
vi.setConfig({ testTimeout: SPAWN_TEST_BUDGET_MS });

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
// This package's own directory — the one ancestor whose `node_modules` a
// `mkdtemp` fixture can walk up to and actually reach a real, hoisted
// `@nx/eslint-plugin` install. Only used by the ESLint boundaryConfig dialect
// fixture below; every other fixture in this file needs no such plugin.
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

/** Runs the real executable, the way a shell, a hook, or CI would. */
const run = (args) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    // One spawned child gets the shared single-spawn budget; without any
    // bound, a wedged spawn blocks this thread indefinitely — a state no
    // vitest timeout can interrupt, since the thread is stuck inside the
    // syscall. `../spawn-budget.mjs` owns both halves of that pair. cf. #41
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
  });

/**
 * A workspace with two Go projects on opposite sides of the layer axis, and one
 * import that crosses it the wrong way. Small, real files on disk: the analyzer
 * reads them, the rule engine judges them, the report renders them — only Nx
 * and git are injected, because neither has anything to say about whether an
 * import is allowed.
 */
const root = mkdtempSync(join(tmpdir(), "polyglot-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (relativePath, text) => {
  mkdirSync(join(root, relativePath, ".."), { recursive: true });
  writeFileSync(join(root, relativePath), text);
};

write(
  "nx.json",
  `${JSON.stringify({
    plugins: [
      {
        plugin: "@ecoma-io/archkeep/nx",
        options: { boundaryConfig: "module-boundaries.config.mjs" },
      },
    ],
  })}\n`,
);
write(
  "module-boundaries.config.mjs",
  `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
);
write("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
write("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
write("libs/adapter/adapter.go", "package adapter\n");
// The measured hole, reproduced: a domain package importing an adapter. ESLint
// answers "File ignored because no matching configuration was supplied" for a
// `.go` file, so its project's lint target exits 0 over exactly this.
write(
  "libs/domain/doc.go",
  `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
);

const graph = {
  nodes: {
    domain: {
      name: "domain",
      type: "lib",
      data: { root: "libs/domain", tags: ["layer:domain"] },
    },
    adapter: {
      name: "adapter",
      type: "lib",
      data: { root: "libs/adapter", tags: ["layer:adapter"] },
    },
  },
  dependencies: { domain: [], adapter: [] },
};

const files = [
  "nx.json",
  "module-boundaries.config.mjs",
  "libs/domain/go.mod",
  "libs/domain/doc.go",
  "libs/adapter/go.mod",
  "libs/adapter/adapter.go",
];

const context = { cwd: root, readGraph: () => graph, listFiles: () => files };

/** `runCli`'s whole outside world: two capturing streams plus the seams above. */
const env = () => {
  const out = [];
  const err = [];
  return {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    lines: { out, err },
    ...context,
  };
};

describe("checking a real tree", () => {
  it("reports a layer-crossing Go import at the line and column that wrote it", async () => {
    // The one assertion the whole tool exists for. A developer fixes this from
    // the line alone, so the line has to carry the position, the rule, the
    // message, and the constraint row that decided it.
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      context,
    );

    expect(violations).toBe(1);
    expect(report).toContain("libs/domain/doc.go:5:2  onlyTagsConstraintViolation");
    expect(report).toContain(
      'A project tagged with "layer:domain" can only depend on libs tagged with "layer:domain"',
    );
    expect(report).toContain('import      "example.com/adapter" (static)  domain → adapter');
    expect(report).toContain(
      "constraint  sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain]",
    );
  });

  it("states what it inspected alongside the count, so the verdict is a claim about coverage too", async () => {
    const { report } = await check({ format: "text", config: null, paths: [] }, context);
    expect(report).toMatch(/1 import in 2 files across 2 projects/);
  });

  it("says nothing about go.work in a workspace that has none — no manifest, no check, no claim", async () => {
    const { report, goWorkDrift } = await check(
      { format: "text", config: null, paths: [] },
      context,
    );
    expect(goWorkDrift).toBe(0);
    expect(report).not.toContain("go.work");
  });

  it("says nothing about path aliases in a workspace with no tsconfig — no table, no check, no claim", async () => {
    // The paths hygiene check's silent case, on the main fixture precisely
    // because it never writes a tsconfig: a workspace without the table must
    // pay nothing and hear nothing.
    const { report, tsconfigPathsDead } = await check(
      { format: "text", config: null, paths: [] },
      context,
    );
    expect(tsconfigPathsDead).toBe(0);
    expect(report).not.toContain("tsconfig");
  });

  it("renders the same verdict as SARIF, located at the same position", async () => {
    const { report } = await check({ format: "sarif", config: null, paths: [] }, context);
    const [result] = JSON.parse(report).runs[0].results;
    expect(result.ruleId).toBe("onlyTagsConstraintViolation");
    expect(result.locations[0].physicalLocation).toEqual({
      artifactLocation: { uri: "libs/domain/doc.go" },
      region: { startLine: 5, startColumn: 2 },
    });
  });

  it("renders the same verdict in the JSON envelope, with goWork and tsconfigPaths named null", async () => {
    // The silent-direction pair for a workspace with neither manifest: `check`
    // must say so by naming absence explicitly (`null`), never by omitting
    // the field or defaulting it to an empty "checked" object a reader could
    // mistake for "checked, and clean". The checked-and-clean half of each
    // pair lives beside its own manifest's dedicated fixture, further down
    // this file.
    const { report, violations } = await check(
      { format: "json", config: null, paths: [] },
      context,
    );
    const envelope = JSON.parse(report);
    expect(violations).toBe(1);
    expect(envelope.status).toBe("findings");
    expect(envelope.exitCode).toBe(1);
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.imports).toBeGreaterThan(0);
    // The canonical verdict of the same counts: findings is `fail`, and the
    // decision agrees with the status by construction.
    expect(envelope.decision).toEqual({ verdict: "fail" });
    expect(envelope.result.violations).toHaveLength(1);
    expect(envelope.result.violations[0]).toMatchObject({
      sourceFile: "libs/domain/doc.go",
      line: 5,
      column: 2,
      messageId: "onlyTagsConstraintViolation",
    });
    expect(envelope.result.goWork).toBeNull();
    expect(envelope.result.tsconfigPaths).toBeNull();
  });

  it("stamps the check envelope with git provenance — commit and dirty flag, the same resolveProvenance every command uses (D-10)", async () => {
    // D-10: `check`'s JSON envelope used to carry NO provenance, so a CI run
    // over a dirty tree presented an abstract claim about a tree state it did
    // not name. Every envelope command now resolves provenance through the one
    // `resolveProvenance`. This fixture is a real git repo, so the bytes are
    // real: HEAD short-sha + the dirty flag from `git status --porcelain`.
    const repo = mkdtempSync(join(tmpdir(), "polyglot-cli-provenance-"));
    try {
      const g = (...args) =>
        spawnSync("git", args, {
          cwd: repo,
          encoding: "utf8",
          timeout: SPAWN_BUDGET_MS,
          killSignal: "SIGKILL",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
            HOME: process.env.HOME,
          },
        }).status;
      const git = (...args) => {
        const r = spawnSync("git", args, {
          cwd: repo,
          encoding: "utf8",
          timeout: SPAWN_BUDGET_MS,
          killSignal: "SIGKILL",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
            HOME: process.env.HOME,
          },
        });
        return r.stdout.trim();
      };
      const repoWrite = (relativePath, text) => {
        mkdirSync(join(repo, relativePath, ".."), { recursive: true });
        writeFileSync(join(repo, relativePath), text);
      };
      expect(g("init", "-q", "-b", "main")).toBe(0);
      repoWrite("nx.json", readFileSync(join(root, "nx.json"), "utf8"));
      repoWrite(
        "module-boundaries.config.mjs",
        readFileSync(join(root, "module-boundaries.config.mjs"), "utf8"),
      );
      repoWrite("libs/domain/go.mod", readFileSync(join(root, "libs/domain/go.mod"), "utf8"));
      repoWrite("libs/domain/doc.go", readFileSync(join(root, "libs/domain/doc.go"), "utf8"));
      repoWrite("libs/adapter/go.mod", readFileSync(join(root, "libs/adapter/go.mod"), "utf8"));
      repoWrite(
        "libs/adapter/adapter.go",
        readFileSync(join(root, "libs/adapter/adapter.go"), "utf8"),
      );
      expect(g("add", "-A")).toBe(0);
      expect(g("commit", "-m", "fixture")).toBe(0);
      const head = git("rev-parse", "HEAD");

      const streams = {
        out: (t) => streams.lines.out.push(t),
        err: (t) => streams.lines.err.push(t),
        lines: { out: [], err: [] },
        cwd: repo,
        listFiles: () => files,
        readGraph: () => graph,
      };
      expect(await runCli(["check", "--format", "json"], streams)).toBe(EXIT.violations);
      const envelope = JSON.parse(streams.lines.out.join("\n"));
      expect(envelope.workspace).toBeDefined();
      expect(envelope.workspace.provenance).toEqual({ commit: head, remote: null, dirty: false });

      // Dirty: touching a tracked file flips the flag, so a stamped-but-stale
      // run can never claim a clean tree.
      repoWrite("libs/domain/go.mod", "module example.com/domain\n\ngo 1.25\n");
      const dirtyStreams = {
        out: (t) => dirtyStreams.lines.out.push(t),
        err: (t) => dirtyStreams.lines.err.push(t),
        lines: { out: [], err: [] },
        cwd: repo,
        listFiles: () => files,
        readGraph: () => graph,
      };
      await runCli(["check", "--format", "json"], dirtyStreams);
      const dirtyEnvelope = JSON.parse(dirtyStreams.lines.out.join("\n"));
      expect(dirtyEnvelope.workspace.provenance.commit).toBe(head);
      expect(dirtyEnvelope.workspace.provenance.dirty).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("exits 3 on a commitless git repository instead of reporting a clean empty run (D-17)", async () => {
    // The silent direction this case exists to end: `git init` with nothing
    // committed. `git ls-files` answers an empty list with exit 0, so a check
    // run over this tree would previously print "0 imports in 0 files" and
    // exit 0 — byte-for-byte identical to a clean workspace, while the run
    // never looked at a single file. `resolveProvenance` now refuses the
    // unborn-HEAD state loudly, and `check` resolves it BEFORE any verdict, so
    // BOTH report formats are a loud could-not-look.
    const repo = mkdtempSync(join(tmpdir(), "polyglot-cli-commitless-"));
    try {
      const g = (...args) =>
        spawnSync("git", args, {
          cwd: repo,
          encoding: "utf8",
          timeout: SPAWN_BUDGET_MS,
          killSignal: "SIGKILL",
          env: { ...process.env, HOME: process.env.HOME },
        }).status;
      const repoWrite = (relativePath, text) => {
        mkdirSync(join(repo, relativePath, ".."), { recursive: true });
        writeFileSync(join(repo, relativePath), text);
      };
      expect(g("init", "-q", "-b", "main")).toBe(0);
      repoWrite("nx.json", readFileSync(join(root, "nx.json"), "utf8"));
      repoWrite(
        "module-boundaries.config.mjs",
        readFileSync(join(root, "module-boundaries.config.mjs"), "utf8"),
      );
      // Files exist on disk but nothing is ever committed — `git ls-files`
      // reports exactly what it would on a clean index, which is nothing.
      const commitlessStreams = () => {
        const out = [];
        const err = [];
        return {
          out: (text) => out.push(text),
          err: (text) => err.push(text),
          lines: { out, err },
          cwd: repo,
          listFiles: () => [],
          readGraph: () => graph,
        };
      };
      const textStreams = commitlessStreams();
      expect(await runCli(["check"], textStreams)).toBe(EXIT.error);
      const textErr = textStreams.lines.err.join("\n");
      expect(textErr).toContain("no commits");
      // No verdict bytes reach the primary stream — the run never claimed a
      // clean tree, which is the point of the exit code.
      expect(textStreams.lines.out.join("\n")).not.toContain("no boundary violations");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("exits 3 on a commitless git repository through provenance too, naming the missing evidence (D-17)", async () => {
    // The provenance command previously printed "provenance unavailable — not
    // a git repository or git not installed" for this state — a false
    // statement, since `.git` IS present — followed by "✔ every governance
    // row carries an origin", and exited 0. A tree whose own git cannot name
    // its state must be a loud could-not-look, never an empty clean record.
    const repo = mkdtempSync(join(tmpdir(), "polyglot-cli-provenance-commitless-"));
    try {
      const g = (...args) =>
        spawnSync("git", args, {
          cwd: repo,
          encoding: "utf8",
          timeout: SPAWN_BUDGET_MS,
          killSignal: "SIGKILL",
          env: { ...process.env, HOME: process.env.HOME },
        }).status;
      const repoWrite = (relativePath, text) => {
        mkdirSync(join(repo, relativePath, ".."), { recursive: true });
        writeFileSync(join(repo, relativePath), text);
      };
      expect(g("init", "-q", "-b", "main")).toBe(0);
      repoWrite("nx.json", readFileSync(join(root, "nx.json"), "utf8"));
      const out = [];
      const err = [];
      const streams = {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        lines: { out, err },
        cwd: repo,
        listFiles: () => [],
        readGraph: () => graph,
      };
      expect(await runCli(["provenance"], streams)).toBe(EXIT.error);
      expect(streams.lines.err.join("\n")).toContain("no commits");
      expect(streams.lines.out.join("\n")).not.toContain(
        "✔ every governance row carries an origin",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("renders the exact byte sequence for the violating fixture — a golden pin against silent format drift", async () => {
    // Every other assertion in this describe block checks a substring; this
    // one checks the whole thing, so a change that reorders a line or drops a
    // space between two of them — invisible to `toContain` — still goes red.
    const { report } = await check({ format: "text", config: null, paths: [] }, context);
    // Computed from the real fixture and the real fingerprint function, not
    // written as a literal — pinning a copy of the hash here would let the two
    // drift apart silently the moment either one changed.
    const fingerprint = computePolicyFingerprint(
      await loadBoundaryConfigFile(join(root, "module-boundaries.config.mjs")),
    );
    expect(report).toBe(
      [
        `policy  module-boundaries.config.mjs — fingerprint ${fingerprint}`,
        "",
        "libs/domain/doc.go:5:2  onlyTagsConstraintViolation",
        '    A project tagged with "layer:domain" can only depend on libs tagged with "layer:domain"',
        '  import      "example.com/adapter" (static)  domain → adapter',
        "  constraint  sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain]",
        "",
        "✖ 1 boundary violation in 1 file (1 import in 2 files across 2 projects)",
        // No unowned-files section, and that is an assertion rather than an
        // omission. This fixture's one tracked analyzable file outside a
        // project root IS its boundary law, which `./commands/context.mjs`'s
        // `unownedAnalyzableFiles` excludes: the law is not source judged by
        // the law, and counting it would make this golden — and every real
        // report — change with the config's filename. The differential in
        // `./config-spelling.integration.test.mjs` is what proved that.
      ].join("\n"),
    );
  });

  it("agrees on the same verdict across text, sarif and json — one computation, three renderings", async () => {
    const formats = ["text", "sarif", "json"];
    const results = await Promise.all(
      formats.map((format) => check({ format, config: null, paths: [] }, context)),
    );
    for (const result of results) {
      expect(result.violations).toBe(1);
      expect(result.goWorkDrift).toBe(0);
      expect(result.tsconfigPathsDead).toBe(0);
      expect(result.unchecked).toBe(0);
    }
    const streamsPerFormat = formats.map(() => env());
    const exitCodes = await Promise.all(
      formats.map((format, index) =>
        runCli(["check", "--format", format], streamsPerFormat[index]),
      ),
    );
    expect(exitCodes).toEqual([EXIT.violations, EXIT.violations, EXIT.violations]);
  });

  it("reads the boundary law from --config, whose location is not the tree being judged", async () => {
    // The law's location and the tree being judged are two facts. Pointing at a
    // table that permits the import must clear it without moving which
    // workspace is analyzed.
    const permissive = join(root, "permissive.config.mjs");
    writeFileSync(
      permissive,
      readFileSync(join(root, "module-boundaries.config.mjs"), "utf8").replace(
        '{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }',
        '{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] }',
      ),
    );
    const { report, violations, analyzed } = await check(
      { format: "text", config: permissive, paths: [] },
      context,
    );
    expect(violations).toBe(0);
    expect(analyzed).toBe(2);
    expect(report).toContain("✔ no boundary violations");
  });

  it("renders a clean JSON envelope, still counting the now-permitted import", async () => {
    // The other half of the pair above: `status: "ok"` requires more than
    // zero violations — it requires the coverage that earned it. A clean
    // envelope over zero analyzed imports would be indistinguishable from one
    // that skipped analysis entirely.
    const permissive = join(root, "permissive.config.mjs");
    writeFileSync(
      permissive,
      readFileSync(join(root, "module-boundaries.config.mjs"), "utf8").replace(
        '{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }',
        '{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] }',
      ),
    );
    const { report } = await check({ format: "json", config: permissive, paths: [] }, context);
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.imports).toBeGreaterThan(0);
    expect(envelope.result.violations).toEqual([]);
    // A fully-read, clean tree carries the `pass` decision — complete
    // coverage plus zero findings, the only counts that earn it.
    expect(envelope.decision).toEqual({ verdict: "pass" });
  });

  describe("naming the law that governed a clean run (P1-01)", () => {
    // The audit's own reproduction: two DIFFERENT policies over the IDENTICAL
    // tree, both permissive enough to report zero violations — the exact
    // silent pair a weak `--config` substituted for a strict one would
    // produce. Before this, the two reports were byte-identical in every
    // format: nothing anywhere said which law had actually run, so a reader
    // could not tell a clean run under the strict law from one whose gate had
    // quietly been swapped for a weaker one.
    const weak = join(root, "weak.config.mjs");
    writeFileSync(
      weak,
      `export const depConstraints = [];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
    );
    const satisfied = join(root, "satisfied.config.mjs");
    writeFileSync(
      satisfied,
      readFileSync(join(root, "module-boundaries.config.mjs"), "utf8").replace(
        '{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }',
        '{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] }',
      ),
    );

    it("prints a different text report for each policy, both clean, each naming its own file", async () => {
      const under = async (config) =>
        (await check({ format: "text", config, paths: [] }, context)).report;
      const weakReport = await under(weak);
      const satisfiedReport = await under(satisfied);

      expect(weakReport).toContain("✔ no boundary violations");
      expect(satisfiedReport).toContain("✔ no boundary violations");
      // The silent-direction assertion itself: same tree, same zero-violation
      // verdict, but NOT the same bytes — the policy line is what tells them
      // apart, and it is the first line of each report.
      expect(weakReport).not.toBe(satisfiedReport);
      const weakFirstLine = weakReport.split("\n\n")[0];
      const satisfiedFirstLine = satisfiedReport.split("\n\n")[0];
      expect(weakFirstLine).not.toBe(satisfiedFirstLine);
      expect(weakFirstLine).toMatch(/^policy {2}weak\.config\.mjs — fingerprint [0-9a-f]{64}$/);
      expect(satisfiedFirstLine).toMatch(
        /^policy {2}satisfied\.config\.mjs — fingerprint [0-9a-f]{64}$/,
      );
    });

    it("carries a different result.policy in the JSON envelope for each policy, both status ok", async () => {
      const envelopeUnder = async (config) =>
        JSON.parse((await check({ format: "json", config, paths: [] }, context)).report);
      const weakEnvelope = await envelopeUnder(weak);
      const satisfiedEnvelope = await envelopeUnder(satisfied);

      expect(weakEnvelope.status).toBe("ok");
      expect(satisfiedEnvelope.status).toBe("ok");
      expect(weakEnvelope.result.violations).toEqual([]);
      expect(satisfiedEnvelope.result.violations).toEqual([]);
      // Before P1-01's fix, `result` carried no `policy` key at all, so these
      // two envelopes' `result` objects were `{violations: []}` — identical —
      // regardless of which config produced them.
      expect(weakEnvelope.result.policy).toEqual({
        profile: null,
        source: "weak.config.mjs",
        fingerprint: expect.any(String),
      });
      expect(satisfiedEnvelope.result.policy).toEqual({
        profile: null,
        source: "satisfied.config.mjs",
        fingerprint: expect.any(String),
      });
      expect(weakEnvelope.result.policy.fingerprint).not.toBe(
        satisfiedEnvelope.result.policy.fingerprint,
      );
    });

    it("carries a different policy in the SARIF run-level properties for each policy", async () => {
      const runUnder = async (config) =>
        JSON.parse((await check({ format: "sarif", config, paths: [] }, context)).report).runs[0];
      const weakRun = await runUnder(weak);
      const satisfiedRun = await runUnder(satisfied);

      expect(weakRun.results).toEqual([]);
      expect(satisfiedRun.results).toEqual([]);
      expect(weakRun.properties.policy.source).toBe("weak.config.mjs");
      expect(satisfiedRun.properties.policy.source).toBe("satisfied.config.mjs");
      expect(weakRun.properties.policy.fingerprint).not.toBe(
        satisfiedRun.properties.policy.fingerprint,
      );
    });
  });

  it("pins every field of the violation object in the JSON envelope", async () => {
    // Five fields — `constraint`, `specifier`, `kind`, `sourceProject`,
    // `targetProject` — could silently disappear from the JSON output and no
    // existing test would notice. The text golden test catches format drift in
    // text; this test catches structural drift in JSON.
    const { report } = await check({ format: "json", config: null, paths: [] }, context);
    const envelope = JSON.parse(report);
    expect(envelope.result.violations).toHaveLength(1);
    expect(envelope.result.violations[0]).toEqual({
      sourceFile: "libs/domain/doc.go",
      line: 5,
      column: 2,
      specifier: "example.com/adapter",
      kind: "static",
      messageId: "onlyTagsConstraintViolation",
      message: expect.any(String),
      sourceProject: "domain",
      targetProject: "adapter",
      constraint: { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
      data: expect.any(Object),
    });
  });

  it("pins the SARIF property-bag fields that carry project and import metadata", async () => {
    // SARIF carries `specifier`, `importKind`, `sourceProject`, and
    // `targetProject` in the `properties` bag — none of the existing SARIF
    // tests pin these values against the fixture. A formatter change that
    // dropped them would be invisible.
    const { report } = await check({ format: "sarif", config: null, paths: [] }, context);
    const result = JSON.parse(report).runs[0].results[0];
    expect(result.properties.specifier).toBe("example.com/adapter");
    expect(result.properties.importKind).toBe("static");
    expect(result.properties.sourceProject).toBe("domain");
    expect(result.properties.targetProject).toBe("adapter");
  });

  it("scopes to the paths it is given, and finds nothing in the clean half", async () => {
    const { report, violations } = await check(
      { format: "text", config: null, paths: ["libs/adapter"] },
      context,
    );
    expect(violations).toBe(0);
    expect(report).toContain("in 1 file across 2 projects");
  });
});

describe("check reports violations in a stable total order, not git's index order (E-F10)", () => {
  // `listTrackedFiles` returns `git ls-files` output verbatim, and nothing
  // downstream sorted it: `analyzeWorkspace` iterates files in that order,
  // `evaluate()` preserves the site order, and the report renders the
  // violations array as-is. Byte-identity held only because git's index
  // happened to sort paths. This fixture feeds `check` two different
  // `listFiles` orderings of the SAME tree and requires the rendered bytes to
  // be identical — which the fix (`sortViolations` at the check boundary)
  // guarantees and the old order-inheriting behaviour would fail.
  const orderRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-order-"));
  afterAll(() => rmSync(orderRoot, { recursive: true, force: true }));

  const writeOrder = (relativePath, text) => {
    mkdirSync(join(orderRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(orderRoot, relativePath), text);
  };

  writeOrder(
    "nx.json",
    `${JSON.stringify({
      plugins: [
        {
          plugin: "@ecoma-io/archkeep/nx",
          options: { boundaryConfig: "module-boundaries.config.mjs" },
        },
      ],
    })}\n`,
  );
  writeOrder(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeOrder("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeOrder(
    "libs/domain/doc.go",
    `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
  );
  writeOrder(
    "libs/domain/other.go",
    `// Package domain imports the same adapter a second time, from a later line.
package domain

import "example.com/adapter"

var _ = adapter.Name
`,
  );
  writeOrder("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeOrder("libs/adapter/adapter.go", "package adapter\n");

  // Two different orders of the same tree. Sorted by (sourceFile, line,
  // column, messageId) they produce one canonical sequence; fed to `check`
  // as-is they would produce two different violation orders — A puts
  // `other.go` (line 4) first, B puts `doc.go` (line 5) first, so without the
  // sort the byte streams differ.
  const orderFilesA = [
    "libs/domain/other.go",
    "libs/domain/doc.go",
    "libs/domain/go.mod",
    "libs/adapter/adapter.go",
    "libs/adapter/go.mod",
    "module-boundaries.config.mjs",
    "nx.json",
  ];
  const orderFilesB = [
    "libs/domain/doc.go",
    "libs/domain/other.go",
    "nx.json",
    "module-boundaries.config.mjs",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
    "libs/domain/go.mod",
  ];
  const orderGraph = {
    nodes: {
      domain: {
        name: "domain",
        type: "lib",
        data: { root: "libs/domain", tags: ["layer:domain"] },
      },
      adapter: {
        name: "adapter",
        type: "lib",
        data: { root: "libs/adapter", tags: ["layer:adapter"] },
      },
    },
    dependencies: { domain: [], adapter: [] },
  };
  const orderContextA = {
    cwd: orderRoot,
    readGraph: () => orderGraph,
    listFiles: () => orderFilesA,
  };
  const orderContextB = {
    cwd: orderRoot,
    readGraph: () => orderGraph,
    listFiles: () => orderFilesB,
  };

  it("renders byte-identical reports regardless of the order git hands the file list over", async () => {
    const runA = await check({ format: "text", config: null, paths: [] }, orderContextA);
    const runB = await check({ format: "text", config: null, paths: [] }, orderContextB);
    // Both runs find the same two violations — the point of the second file
    // is a real ordering difference, not a count difference.
    expect(runA.violations).toBe(2);
    expect(runB.violations).toBe(2);
    expect(runA.report).toBe(runB.report);
    // And the canonical order is (sourceFile, line, column, messageId) with
    // sourceFile primary: doc.go's block import at 5:2 sorts before other.go's
    // single-line import at 4:8 because "libs/domain/doc.go" <
    // "libs/domain/other.go", even though other.go's line 4 is earlier — the
    // sort key, not the file-list order, decides the byte sequence.
    const docGo = runA.report.indexOf("libs/domain/doc.go:5:2");
    const otherGo = runA.report.indexOf("libs/domain/other.go:4:8");
    expect(docGo).toBeGreaterThan(-1);
    expect(otherGo).toBeGreaterThan(-1);
    expect(docGo).toBeLessThan(otherGo);
  });

  it("keeps the same canonical order in the JSON envelope's violation list", async () => {
    const runA = await check({ format: "json", config: null, paths: [] }, orderContextA);
    const runB = await check({ format: "json", config: null, paths: [] }, orderContextB);
    expect(runA.report).toBe(runB.report);
    const orderA = JSON.parse(runA.report).result.violations.map((v) => v.sourceFile);
    const orderB = JSON.parse(runB.report).result.violations.map((v) => v.sourceFile);
    expect(orderA).toEqual(orderB);
    expect(orderA).toEqual(["libs/domain/doc.go", "libs/domain/other.go"]);
  });
});

describe("honouring Module Federation remotes in the app-import ban", () => {
  // `nx graph --file=` carries no Module Federation fact (see
  // `annotateMFERemotes` in `./workspace.mjs`), so the CLI computes it from the
  // config files on disk the way upstream does. Two apps, near-identical: one
  // exposes a remote, the other only hosts. Upstream flags only the second, so
  // this run must too — in both directions, because the exemption over-firing
  // (waiving the host) is the silent one nobody would ever report.
  const mfeRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-mfe-"));
  afterAll(() => rmSync(mfeRoot, { recursive: true, force: true }));

  const writeMfe = (relativePath, text) => {
    mkdirSync(join(mfeRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(mfeRoot, relativePath), text);
  };

  const CONSUMER_GO = [
    "package consumer",
    "",
    "import (",
    '\t"example.com/widgets"',
    '\t"example.com/portal"',
    ")",
    "",
    "var _ = widgets.Name",
    "var _ = portal.Name",
    "",
  ].join("\n");

  writeMfe("nx.json", "{}\n");
  writeMfe(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "zone:site", onlyDependOnLibsWithTags: ["zone:site"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeMfe("libs/consumer/go.mod", "module example.com/consumer\n\ngo 1.24\n");
  writeMfe("libs/consumer/consumer.go", CONSUMER_GO);
  writeMfe("apps/widgets/go.mod", "module example.com/widgets\n\ngo 1.24\n");
  writeMfe("apps/widgets/widgets.go", "package widgets\n");
  writeMfe(
    "apps/widgets/module-federation.config.js",
    "module.exports = { exposes: { './Widget': './src/widget' } };\n",
  );
  writeMfe("apps/portal/go.mod", "module example.com/portal\n\ngo 1.24\n");
  writeMfe("apps/portal/portal.go", "package portal\n");
  // The near-identical config: it names remotes and exposes nothing.
  writeMfe(
    "apps/portal/module-federation.config.js",
    "module.exports = { remotes: ['widgets'] };\n",
  );

  const mfeContext = {
    cwd: mfeRoot,
    readGraph: () => ({
      nodes: {
        consumer: {
          name: "consumer",
          type: "lib",
          data: { root: "libs/consumer", tags: ["zone:site"] },
        },
        widgets: {
          name: "widgets",
          type: "app",
          data: { root: "apps/widgets", tags: ["zone:site"] },
        },
        portal: { name: "portal", type: "app", data: { root: "apps/portal", tags: ["zone:site"] } },
      },
      dependencies: { consumer: [], widgets: [], portal: [] },
    }),
    listFiles: () => [
      "nx.json",
      "module-boundaries.config.mjs",
      "libs/consumer/go.mod",
      "libs/consumer/consumer.go",
      "apps/widgets/go.mod",
      "apps/widgets/widgets.go",
      "apps/widgets/module-federation.config.js",
      "apps/portal/go.mod",
      "apps/portal/portal.go",
      "apps/portal/module-federation.config.js",
    ],
  };

  // The position a reader acts on, computed from the fixture rather than
  // written as a literal, so editing the fixture moves both sides.
  const lines = CONSUMER_GO.split("\n");
  const portalLine = lines.findIndex((line) => line.includes("example.com/portal")) + 1;
  const portalColumn = lines[portalLine - 1].indexOf('"') + 1;

  it("flags the import of the app that exposes nothing, exactly as upstream would", async () => {
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      mfeContext,
    );

    expect(violations).toBe(1);
    expect(report).toContain(`libs/consumer/consumer.go:${portalLine}:${portalColumn}`);
    expect(report).toContain("noImportsOfApps");
  });

  it("does not flag the import of the remote, which upstream exempts", async () => {
    // The false positive this change removes: before the adapters populated
    // `mfeRemote`, this exact import was reported as `noImportsOfApps`.
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      mfeContext,
    );

    expect(violations).toBe(1);
    expect(report).not.toContain("example.com/widgets");
  });
});

describe("the go.work drift check", () => {
  // Its own fixture, because go.work drift is exactly the state the main
  // fixture must not carry: a clean two-module workspace whose go.work is
  // edited per case. Only Nx and git are injected — the parser reads the real
  // file and the real comparison judges it, so what is pinned here is the
  // whole path a consumer's `check` takes.
  const workRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-gowork-"));
  afterAll(() => rmSync(workRoot, { recursive: true, force: true }));

  const writeWork = (relativePath, text) => {
    mkdirSync(join(workRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(workRoot, relativePath), text);
  };

  writeWork("nx.json", "{}\n");
  writeWork(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeWork("libs/store/go.mod", "module example.com/store\n\ngo 1.24\n");
  writeWork("libs/store/store.go", "package store\n");
  writeWork("libs/pricing/go.mod", "module example.com/pricing\n\ngo 1.24\n");
  writeWork("libs/pricing/pricing.go", "package pricing\n");

  const workContext = {
    cwd: workRoot,
    readGraph: () => ({
      nodes: {
        store: { name: "store", type: "lib", data: { root: "libs/store", tags: ["layer:domain"] } },
        pricing: {
          name: "pricing",
          type: "lib",
          data: { root: "libs/pricing", tags: ["layer:domain"] },
        },
      },
      dependencies: { store: [], pricing: [] },
    }),
    listFiles: () => [
      "nx.json",
      "module-boundaries.config.mjs",
      "go.work",
      "libs/store/go.mod",
      "libs/store/store.go",
      "libs/pricing/go.mod",
      "libs/pricing/pricing.go",
    ],
  };

  const workEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      ...workContext,
    };
  };

  it("exits 1 on a project missing from the use list, with zero boundary violations to blame", async () => {
    // The breaking half of this change, deliberately: a workspace whose
    // imports are all legal and whose go.work has quietly fallen behind was
    // exit 0 before this check existed, and that green was the drift being
    // invisible.
    writeWork("go.work", "go 1.24\n\nuse ./libs/store\n");
    const streams = workEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("✔ no boundary violations");
    expect(report).toContain("go.work  goWorkMissingUse");
    expect(report).toContain('"pricing"');
    expect(report).toContain("✖ go.work drifts from the project graph: 1 finding");
  });

  it("exits 1 on a stale use entry, locating it at the line and column that wrote it", async () => {
    const goWork = "go 1.24\n\nuse (\n\t./libs/store\n\t./libs/pricing\n\t./libs/checkout\n)\n";
    writeWork("go.work", goWork);
    // Position computed from the fixture, so editing it moves both sides.
    const lines = goWork.split("\n");
    const line = lines.findIndex((candidate) => candidate.includes("./libs/checkout")) + 1;
    const column = lines[line - 1].indexOf("./libs/checkout") + 1;
    const streams = workEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    expect(streams.lines.out.join("\n")).toContain(`go.work:${line}:${column}  goWorkStaleUse`);
  });

  it("exits 0 when the use list and the graph agree, and claims that agreement out loud", async () => {
    writeWork("go.work", "go 1.24\n\nuse (\n\t./libs/store\n\t./libs/pricing\n)\n");
    const streams = workEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.ok);
    expect(streams.lines.out.join("\n")).toContain(
      "✔ go.work agrees with the project graph (2 Go module projects)",
    );
  });

  it("carries the clean agreement into the JSON envelope as goWork.checked with no findings", async () => {
    // The checked-and-clean half of the null/checked pair: a workspace WITH a
    // go.work that agrees with the graph must say `checked: true, findings:
    // []` — never `null`, which is reserved for "no go.work at all"
    // (`checking a real tree` above pins that half).
    writeWork("go.work", "go 1.24\n\nuse (\n\t./libs/store\n\t./libs/pricing\n)\n");
    const { report, goWorkDrift } = await check(
      { format: "json", config: null, paths: [] },
      workContext,
    );
    expect(goWorkDrift).toBe(0);
    const envelope = JSON.parse(report);
    expect(envelope.result.goWork).toEqual({ checked: true, findings: [] });
  });

  it("exits 3 on a go.work it cannot parse — a malformed file must never read as 'no drift'", async () => {
    // The silent direction, end to end: an unclosed block truncates the use
    // list, and a parser that shrugged would hand the comparison an empty one,
    // reporting every module as missing at best and nothing at worst. The run
    // refuses a verdict instead.
    writeWork("go.work", "go 1.24\n\nuse (\n\t./libs/store\n");
    const streams = workEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("could not be analyzed at all");
    expect(report).toContain("go.work:3: 'use (' block is never closed");
    expect(report).not.toContain("goWorkMissingUse");
  });

  it("exits 3 on a go.work that is not a go.work file at all, not a clean agreement — audit P1-03", async () => {
    // The exact shape the audit reported: a go.work fetched through a
    // redirect that actually served an HTML error page tokenizes with no
    // unterminated block or string, so before the keyword validation this
    // fix adds, every line fell through the "future directive" skip and the
    // file read as zero `use` entries — exit 0, "go.work agrees with the
    // project graph", an affirmative claim about a file that was never
    // really read (the finding's own evidence). It must refuse a verdict
    // instead, the same as the unclosed-block case above.
    writeWork(
      "go.work",
      "<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head>\n<body>404 Not Found</body></html>\n",
    );
    const streams = workEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("could not be analyzed at all");
    expect(report).toContain("go.work:1: unknown directive: <!DOCTYPE");
    expect(report).not.toContain("goWorkMissingUse");
    expect(report).not.toContain("agrees with the project graph");
  });

  it("carries drift into the SARIF report as results, so a code-scanning consumer sees the red", async () => {
    writeWork("go.work", "go 1.24\n\nuse ./libs/store\n");
    const { report, violations, goWorkDrift } = await check(
      { format: "sarif", config: null, paths: [] },
      workContext,
    );
    expect(violations).toBe(0);
    expect(goWorkDrift).toBe(1);
    const run = JSON.parse(report).runs[0];
    const [result] = run.results;
    expect(result.ruleId).toBe("goWorkMissingUse");
    expect(run.tool.driver.rules[result.ruleIndex].id).toBe("goWorkMissingUse");
    expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe("go.work");
  });

  it("counts drift findings on the stderr summary of an --output run, beside the violations", async () => {
    writeWork("go.work", "go 1.24\n\nuse ./libs/store\n");
    const target = join(workRoot, "drift.sarif");
    const streams = workEnv();
    expect(await runCli(["check", "--format", "sarif", "--output", target], streams)).toBe(
      EXIT.violations,
    );
    expect(streams.lines.err.join("\n")).toContain("1 go.work drift finding");
  });
});

describe("a failing fitness function reaches every report face (bugs A and E)", () => {
  // Its own fixture: a clean boundary (no depConstraints violation) so a
  // fitness-only failure is isolated from every other finding kind. The
  // domain→adapter edge that the fitness function judges is injected straight
  // onto the graph, the same way the go.work fixture above injects its own
  // edges — a fitness function reads `commandContext.graph.dependencies`
  // directly (`../governance/fitness-rules.mjs`), never the analyzed imports.
  const fitnessRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-fitness-"));
  afterAll(() => rmSync(fitnessRoot, { recursive: true, force: true }));

  const writeFitness = (relativePath, text) => {
    mkdirSync(join(fitnessRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(fitnessRoot, relativePath), text);
  };

  writeFitness("nx.json", "{}\n");
  writeFitness(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const fitness = [
  {
    name: "domain-may-not-reach-adapter",
    match: ["*"],
    condition: {
      type: "layer-dependency",
      from: "layer:domain",
      to: "layer:adapter",
      direction: "forbidden",
    },
    reason: "the domain layer must never reach the adapter",
  },
];
`,
  );
  writeFitness("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeFitness("libs/domain/doc.go", "package domain\n");
  writeFitness("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeFitness("libs/adapter/adapter.go", "package adapter\n");

  const fitnessContext = {
    cwd: fitnessRoot,
    readGraph: () => ({
      nodes: {
        domain: {
          name: "domain",
          type: "lib",
          data: { root: "libs/domain", tags: ["layer:domain"] },
        },
        adapter: {
          name: "adapter",
          type: "lib",
          data: { root: "libs/adapter", tags: ["layer:adapter"] },
        },
      },
      dependencies: { domain: [{ target: "adapter" }], adapter: [] },
    }),
    listFiles: () => [
      "nx.json",
      "module-boundaries.config.mjs",
      "libs/domain/go.mod",
      "libs/domain/doc.go",
      "libs/adapter/go.mod",
      "libs/adapter/adapter.go",
    ],
  };

  const fitnessEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      ...fitnessContext,
    };
  };

  it("carries a failing fitness function into the SARIF report as a result, so a code-scanning consumer sees the red (bug A)", async () => {
    // Before this fix, `buildSarifLog` had no fitness arm: on a fitness-only
    // failure — no boundary violation, no go.work/tsconfig/intent finding —
    // the whole `results` array was empty and no notification named the
    // failure either, despite `check` exiting 1 on it.
    const { report, violations, fitnessFail } = await check(
      { format: "sarif", config: null, paths: [] },
      fitnessContext,
    );
    expect(violations).toBe(0);
    expect(fitnessFail).toBe(1);
    const run = JSON.parse(report).runs[0];
    expect(run.results.length).toBeGreaterThan(0);
    const [result] = run.results;
    expect(result.ruleId).toBe("fitnessFunctionFailed");
    expect(run.tool.driver.rules[result.ruleIndex].id).toBe("fitnessFunctionFailed");
    expect(result.message.text).toContain("domain-may-not-reach-adapter");
  });

  it("counts the fitness failure on the stderr summary of an --output run, beside the violations (bug E)", async () => {
    // Before this fix, the summary line enumerated every other finding kind
    // (violations, waived, declared-edge, go.work, tsconfig, intent,
    // unchecked) but never fitness, even though fitness drives the exit code
    // exactly like every one of those — a fitness-only failure logged
    // "0 violations …" beside a non-zero exit.
    const target = join(fitnessRoot, "fitness-check.json");
    const streams = fitnessEnv();
    expect(await runCli(["check", "--format", "json", "--output", target], streams)).toBe(
      EXIT.violations,
    );
    expect(streams.lines.err.join("\n")).toContain("1 fitness function failed");
  });
});

describe("decision.reason names every blocking no-verdict cause at once (bug D)", () => {
  // A malformed pyproject.toml (a whole-file analysis failure → `unchecked`)
  // and an architecture-intent.json boundary matching zero observed projects
  // (→ `intentUnresolved`) in the SAME run — two independent no-verdict
  // causes at once. `verdictFor`'s comment has always promised "when coverage
  // and intent both failed, name both", but the intent clause was gated
  // `unchecked === 0 && intentUnresolved > 0` — true only when coverage did
  // NOT also fail — so a tree failing both used to name only the file count,
  // hiding the unresolved intent boundary from a reader acting on the reason
  // string alone.
  it("names both coverage and intent in decision.reason when both fail together", async () => {
    const root = mkdtempSync(join(tmpdir(), "polyglot-cli-bugd-"));
    try {
      const w = (p, t) => {
        mkdirSync(join(root, p, ".."), { recursive: true });
        writeFileSync(join(root, p), t);
      };
      w(
        "archkeep.json",
        JSON.stringify({
          projects: { declared: [{ root: "apps/a", name: "a", type: "lib", tags: [] }] },
          coverage: {
            exempt: [{ path: "module-boundaries.config.mjs", reason: "workspace tooling config" }],
          },
        }),
      );
      w(
        "module-boundaries.config.mjs",
        `export const depConstraints = [];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: [],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
      );
      // Malformed TOML — `[project` never closes — the same audit-D-03 shape
      // used above, which becomes a whole-file failure (`unchecked`). A real
      // `.py` file under the project is required too: without one, analysis
      // never has a reason to read the project's manifest at all, and the
      // malformed file produces no failure to begin with.
      w("apps/a/pyproject.toml", '[project\nname = "a"\n');
      w("apps/a/src/a_main.py", "import os\nprint(os.getcwd())\n");
      // A boundary naming a project this workspace does not have — matches
      // zero observed projects, the same `unresolved` shape F01 exercises.
      w(
        "architecture-intent.json",
        JSON.stringify({
          version: "1",
          boundaries: [{ name: "ghost", match: ["name:does-not-exist"] }],
        }),
      );
      const files = [
        "archkeep.json",
        "module-boundaries.config.mjs",
        "apps/a/pyproject.toml",
        "apps/a/src/a_main.py",
        "architecture-intent.json",
      ];
      const streams = {
        out: (t) => streams.lines.out.push(t),
        err: (t) => streams.lines.err.push(t),
        lines: { out: [], err: [] },
        cwd: root,
        listFiles: () => files,
      };
      expect(await runCli(["check", "--format", "json"], streams)).toBe(EXIT.error);
      const envelope = JSON.parse(streams.lines.out.join("\n"));
      expect(envelope.status).toBe("no-verdict");
      expect(envelope.coverage.complete).toBe(false);
      expect(envelope.result.intent.unresolved.length).toBeGreaterThan(0);
      // Both halves named in the SAME reason string — the regression this
      // test guards against is the intent clause going silent the moment
      // coverage also failed.
      expect(envelope.decision.reason).toContain("could not be analyzed — coverage incomplete");
      expect(envelope.decision.reason).toContain(
        "architecture-intent boundary or row could not be established",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the go.work drift check in a workspace with no Go projects at all", () => {
  // Audit finding P1-03's exact evidence, reproduced end to end rather than
  // only at the parser: a workspace whose graph carries zero go.mod projects
  // has nothing on either side of `compareGoWork` to disagree about, so
  // before the keyword validation this fix adds, an unparseable go.work here
  // — HTML from a redirect, say — parsed to zero `use` entries and compared
  // clean against zero module projects: exit 0, "✔ go.work agrees with the
  // project graph", `checked: true` in the JSON envelope. An affirmative
  // claim about a file the run never actually read. This fixture has no
  // go.mod anywhere, on purpose, so that false agreement is the ONLY way
  // this go.work could have read as clean.
  const noGoRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-gowork-notgowork-"));
  afterAll(() => rmSync(noGoRoot, { recursive: true, force: true }));

  const writeNoGo = (relativePath, text) => {
    mkdirSync(join(noGoRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(noGoRoot, relativePath), text);
  };

  writeNoGo("nx.json", "{}\n");
  writeNoGo(
    "module-boundaries.config.mjs",
    `export const depConstraints = [];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeNoGo(
    "go.work",
    "<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head>\n<body>404 Not Found</body></html>\n",
  );

  const noGoContext = {
    cwd: noGoRoot,
    readGraph: () => ({ nodes: {}, dependencies: {} }),
    listFiles: () => ["nx.json", "module-boundaries.config.mjs", "go.work"],
  };

  const noGoEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      ...noGoContext,
    };
  };

  it("exits 3 instead of the false 'agrees with the project graph' the finding reported", async () => {
    const streams = noGoEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("could not be analyzed at all");
    expect(report).toContain("go.work:1: unknown directive: <!DOCTYPE");
    expect(report).not.toContain("agrees with the project graph");
  });

  it("counts the refusal as an uncovered file in the JSON envelope, never a silent checked: true", async () => {
    // `goWork` itself reads `null` either way — the same value a workspace
    // with no go.work at all would carry — so `unchecked` is the field that
    // must disambiguate "nothing to check" from "could not check this".
    const { goWorkDrift, unchecked } = await check(
      { format: "json", config: null, paths: [] },
      noGoContext,
    );
    expect(goWorkDrift).toBe(0);
    expect(unchecked).toBeGreaterThan(0);
  });
});

describe("the tsconfig paths hygiene check", () => {
  // Its own fixture, because a dead alias is exactly the state the main
  // fixture must not carry: a clean one-module Go workspace whose
  // tsconfig.base.json is rewritten per case. No TypeScript source at all,
  // deliberately — the table is a workspace fact, so the check must fire (and
  // refuse) even where no analyzed file ever imports through it. Only Nx and
  // git are injected: the real parse reads the real file and the real
  // judgement probes the real directories, so what is pinned here is the whole
  // path a consumer's `check` takes.
  const aliasRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-tspaths-"));
  afterAll(() => rmSync(aliasRoot, { recursive: true, force: true }));

  const writeAlias = (relativePath, text) => {
    mkdirSync(join(aliasRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(aliasRoot, relativePath), text);
  };

  writeAlias("nx.json", "{}\n");
  writeAlias(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeAlias("libs/store/go.mod", "module example.com/store\n\ngo 1.24\n");
  writeAlias("libs/store/store.go", "package store\n");

  const aliasContext = {
    cwd: aliasRoot,
    readGraph: () => ({
      nodes: {
        store: { name: "store", type: "lib", data: { root: "libs/store", tags: ["layer:domain"] } },
      },
      dependencies: { store: [] },
    }),
    listFiles: () => [
      "nx.json",
      "module-boundaries.config.mjs",
      "tsconfig.base.json",
      "libs/store/go.mod",
      "libs/store/store.go",
    ],
  };

  const aliasEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      ...aliasContext,
    };
  };

  const tsconfig = (compilerOptions) => JSON.stringify({ compilerOptions }, null, 2);

  it("exits 1 on an alias whose every target's directory is gone, with zero boundary violations to blame", async () => {
    // The breaking half of this change, deliberately: a workspace whose
    // imports are all legal and whose alias table has quietly rotted was exit
    // 0 before this check existed, and that green was the dead alias being
    // invisible.
    writeAlias(
      "tsconfig.base.json",
      tsconfig({ paths: { "@shop/catalog": ["libs/catalog/src/index.ts"] } }),
    );
    const streams = aliasEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("✔ no boundary violations");
    expect(report).toContain("tsconfig.base.json  tsconfigDeadPathAlias");
    expect(report).toContain('"@shop/catalog"');
    expect(report).toContain("libs/catalog/src/");
    expect(report).toContain("✖ dead tsconfig path aliases: 1 finding");
  });

  it("exits 0 while a target's prefix directory exists, and claims the coverage out loud", async () => {
    // `libs/store` is on disk, so the wildcard alias is alive by the stated
    // rule whatever a specifier substitutes — and the clean line must say how
    // many aliases that claim covers.
    writeAlias("tsconfig.base.json", tsconfig({ paths: { "@shop/store/*": ["libs/store/*"] } }));
    const streams = aliasEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.ok);
    expect(streams.lines.out.join("\n")).toContain(
      "✔ no dead tsconfig path aliases (1 alias judged in tsconfig.base.json)",
    );
  });

  it("carries the alive alias into the JSON envelope as tsconfigPaths.checked with no findings", async () => {
    // The checked-and-clean half of the null/checked pair: a workspace with a
    // `paths` table whose every alias resolves must say `checked: true,
    // findings: []` — never `null`, which is reserved for "no `paths` table
    // at all" (`checking a real tree` above pins that half).
    writeAlias("tsconfig.base.json", tsconfig({ paths: { "@shop/store/*": ["libs/store/*"] } }));
    const { report, tsconfigPathsDead } = await check(
      { format: "json", config: null, paths: [] },
      aliasContext,
    );
    expect(tsconfigPathsDead).toBe(0);
    const envelope = JSON.parse(report);
    expect(envelope.result.tsconfigPaths).toEqual({ checked: true, findings: [] });
  });

  it("says nothing when the tsconfig declares no paths — a table that does not exist makes no claim", async () => {
    writeAlias("tsconfig.base.json", tsconfig({ module: "nodenext" }));
    const streams = aliasEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.ok);
    expect(streams.lines.out.join("\n")).not.toContain("tsconfig");
  });

  it("exits 3 on a tsconfig it cannot load — a broken table must never read as 'no aliases'", async () => {
    // The silent direction, end to end, in a workspace with no TypeScript
    // source: nothing else ever loads this tsconfig, so a check that shrugged
    // here would leave the file broken and the run green. The run refuses a
    // verdict instead — which is also the one behaviour change a pure-Go
    // workspace can see from this check.
    writeAlias("tsconfig.base.json", "{ this is not JSON");
    const streams = aliasEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("could not be analyzed at all");
    expect(report).toContain("tsconfig.base.json");
    expect(report).toContain("not valid JSON");
    expect(report).not.toContain("tsconfigDeadPathAlias");
    expect(report).not.toContain("✔ no dead tsconfig path aliases");
  });

  it("exits 3 on a paths value that is not an array of strings, naming the alias it refused", async () => {
    // TypeScript's own parse accepts this shape without a diagnostic
    // (src/tsconfig-paths.mjs header), so reading it as an absent alias would
    // be the same silent direction with a subtler cause.
    writeAlias(
      "tsconfig.base.json",
      tsconfig({ paths: { "@shop/catalog": "libs/catalog/src/index.ts" } }),
    );
    const streams = aliasEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("could not be analyzed at all");
    expect(report).toContain('"@shop/catalog"');
    expect(report).toContain("no verdict");
  });

  it("carries a dead alias into the SARIF report as a result, so a code-scanning consumer sees the red", async () => {
    writeAlias(
      "tsconfig.base.json",
      tsconfig({ paths: { "@shop/catalog": ["libs/catalog/src/index.ts"] } }),
    );
    const { report, violations, tsconfigPathsDead } = await check(
      { format: "sarif", config: null, paths: [] },
      aliasContext,
    );
    expect(violations).toBe(0);
    expect(tsconfigPathsDead).toBe(1);
    const run = JSON.parse(report).runs[0];
    const [result] = run.results;
    expect(result.ruleId).toBe("tsconfigDeadPathAlias");
    expect(run.tool.driver.rules[result.ruleIndex].id).toBe("tsconfigDeadPathAlias");
    expect(result.locations[0].physicalLocation).toEqual({
      artifactLocation: { uri: "tsconfig.base.json" },
    });
    expect(result.properties).toEqual({
      alias: "@shop/catalog",
      targets: ["libs/catalog/src/index.ts"],
    });
  });

  it("counts dead aliases on the stderr summary of an --output run, beside the violations", async () => {
    writeAlias(
      "tsconfig.base.json",
      tsconfig({ paths: { "@shop/catalog": ["libs/catalog/src/index.ts"] } }),
    );
    const target = join(aliasRoot, "dead-alias.sarif");
    const streams = aliasEnv();
    expect(await runCli(["check", "--format", "sarif", "--output", target], streams)).toBe(
      EXIT.violations,
    );
    expect(streams.lines.err.join("\n")).toContain("1 dead tsconfig path alias");
  });
});

describe("honouring the two package.json facts the graph cannot carry", () => {
  // `nx graph --file=` carries neither `entryPoints` nor `declaredPackages`
  // (see `annotatePackageFacts` in `./workspace.mjs`), so the CLI computes both
  // from the manifests on disk the way upstream does per lint run. One
  // TypeScript project, real files, real `ts.resolveModuleName`; only Nx and
  // git are injected — and the injected graph node deliberately carries
  // NEITHER field, because computing them is exactly what is under test.
  const pkgRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-pkg-"));
  afterAll(() => rmSync(pkgRoot, { recursive: true, force: true }));

  const writePkg = (relativePath, text) => {
    mkdirSync(join(pkgRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(pkgRoot, relativePath), text);
  };

  writePkg("nx.json", "{}\n");
  writePkg(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "zone:kit", onlyDependOnLibsWithTags: ["zone:kit"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: true,
  checkNestedExternalImports: false,
};
`,
  );
  writePkg(
    "tsconfig.base.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: {
          "@fixture/gadgets": ["libs/gadgets/src/index.ts"],
          "@fixture/gadgets/models": ["libs/gadgets/src/models.ts"],
        },
      },
    }),
  );
  // The two manifests upstream unions: the workspace root's declares one
  // package, the project's own declares another — and the project's also
  // declares the secondary entry point.
  writePkg(
    "package.json",
    JSON.stringify({ name: "fixture", dependencies: { "direct-dep": "^1.0.0" } }),
  );
  writePkg(
    "libs/gadgets/package.json",
    JSON.stringify({
      name: "@fixture/gadgets",
      dependencies: { "local-dep": "^1.0.0" },
      exports: { ".": "./src/index.ts", "./models": "./src/models.ts" },
    }),
  );
  // All three packages are INSTALLED — an unresolvable specifier is reported
  // as transitive regardless of declaration (upstream the same), which would
  // let an always-empty `declaredPackages` pass the flagged case for the wrong
  // reason.
  for (const name of ["direct-dep", "local-dep", "transitive-dep"]) {
    writePkg(
      `node_modules/${name}/package.json`,
      JSON.stringify({
        name,
        version: "1.0.0",
        types: "./index.d.ts",
        exports: { ".": "./index.d.ts", "./*": "./*.d.ts" },
      }),
    );
    writePkg(`node_modules/${name}/index.d.ts`, "export declare const name: string;\n");
  }

  const INDEX_TS = [
    'import { name as direct } from "direct-dep";',
    'import { name as local } from "local-dep";',
    'import { name as transitive } from "transitive-dep";',
    "",
    "export const gadgets = [direct, local, transitive];",
    "",
  ].join("\n");
  writePkg("libs/gadgets/src/index.ts", INDEX_TS);
  writePkg("libs/gadgets/src/models.ts", 'export const models = "models";\n');
  // A file in the SECONDARY entry point's subtree importing it by alias —
  // upstream's `belongsToDifferentEntryPoint` exemption…
  writePkg(
    "libs/gadgets/src/deep/feature.ts",
    'import { models } from "@fixture/gadgets/models";\n\nexport const feature = models;\n',
  );
  // …and the near-identical import of the MAIN entry, which stays a cycle
  // through the barrel.
  const BARREL_TS =
    'import { gadgets } from "@fixture/gadgets";\n\nexport const viaBarrel = gadgets;\n';
  writePkg("libs/gadgets/src/barrel-user.ts", BARREL_TS);

  const pkgContext = {
    cwd: pkgRoot,
    readGraph: () => ({
      nodes: {
        gadgets: {
          name: "gadgets",
          type: "lib",
          data: { root: "libs/gadgets", tags: ["zone:kit"] },
        },
      },
      dependencies: { gadgets: [] },
    }),
    listFiles: () => [
      "nx.json",
      "module-boundaries.config.mjs",
      "tsconfig.base.json",
      "package.json",
      "libs/gadgets/package.json",
      "libs/gadgets/src/index.ts",
      "libs/gadgets/src/models.ts",
      "libs/gadgets/src/deep/feature.ts",
      "libs/gadgets/src/barrel-user.ts",
    ],
  };

  // Positions computed from the fixture, not written as literals: the offset
  // the analyzer records is the specifier literal's opening quote.
  const indexLines = INDEX_TS.split("\n");
  const transitiveLine = indexLines.findIndex((line) => line.includes("transitive-dep")) + 1;
  const transitiveColumn = indexLines[transitiveLine - 1].indexOf('"') + 1;
  const barrelColumn = BARREL_TS.split("\n")[0].indexOf('"') + 1;

  it("flags only the UNDECLARED package as transitive, from the union of both manifests", async () => {
    // Both directions at once: `transitive-dep` missing would mean
    // `declaredPackages` over-populated (a silently waived report upstream
    // makes); `direct-dep` or `local-dep` appearing would mean the root or the
    // project manifest was not read (the pre-change false alarm).
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      pkgContext,
    );

    expect(report).toContain(`libs/gadgets/src/index.ts:${transitiveLine}:${transitiveColumn}`);
    expect(report).toContain("noTransitiveDependencies");
    expect(report).not.toContain("direct-dep");
    expect(report).not.toContain("local-dep");
    expect(violations).toBe(2);
  });

  it("exempts the secondary-entry-point self-import and still flags the barrel one", async () => {
    // `feature.ts` importing `@fixture/gadgets/models` is upstream's
    // `belongsToDifferentEntryPoint` escape hatch — the pre-change false alarm
    // this field removes. `barrel-user.ts` importing the main entry is the
    // cycle that must survive it: losing that report would be `entryPoints`
    // over-firing, the silent direction.
    const { report } = await check({ format: "text", config: null, paths: [] }, pkgContext);

    expect(report).not.toContain("feature.ts");
    expect(report).toContain(`libs/gadgets/src/barrel-user.ts:1:${barrelColumn}`);
    expect(report).toContain("noSelfCircularDependencies");
  });
});

describe("checking a native archkeep.json tree — no nx.json, no nx installed", () => {
  // A second, independent tmpdir: `root`'s fixture carries `nx.json` and an
  // injected `readGraph`, and the whole point of this block is a tree where
  // neither exists. `nativeProvider` is reached through `check()`'s own
  // `hasNative` branch — nothing here injects a provider, the way the graph
  // fixture above injects `readGraph` — so this is the wiring itself under
  // test, not a stand-in for it.
  const nativeRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-"));
  afterAll(() => rmSync(nativeRoot, { recursive: true, force: true }));

  const writeNative = (relativePath, text) => {
    mkdirSync(join(nativeRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(nativeRoot, relativePath), text);
  };

  writeNative(
    "archkeep.json",
    JSON.stringify({
      projects: {
        declared: [
          { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
          { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
        ],
      },
      // `module-boundaries.config.mjs` sits at the workspace root, which no
      // declared project owns, and `.mjs` is an analyzable extension
      // (`LANGUAGE_BY_EXTENSION` in `../analysis/analyze.mjs`) — so without
      // this waiver the boundary law's own config file would be the
      // fixture's unclaimed file, which is real and not a fixture mistake:
      // any native workspace whose root carries tooling config alongside
      // `archkeep.json` needs exactly this waiver or a root-level project.
      coverage: {
        exempt: [
          {
            path: "module-boundaries.config.mjs",
            reason: "workspace tooling config at the root, not itself a project",
          },
        ],
      },
    }),
  );
  writeNative(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeNative("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeNative("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeNative("libs/adapter/adapter.go", "package adapter\n");
  writeNative("libs/adapter/README.md", "# adapter\n");
  // A tracked intent: without it, `drift` refuses ("drift is about a declared
  // intent"). Boundaries-only, with no allowed/forbidden rows — the two
  // boundaries each match one observed project, so the comparison is clean
  // without stating an opinion that would contradict the boundary law below
  // (which forbids domain→adapter). The `--output` path is what this block
  // pins.
  writeNative(
    "architecture-intent.json",
    JSON.stringify(
      {
        version: "1",
        boundaries: [
          { name: "domain", match: ["name:domain"] },
          { name: "adapter", match: ["name:adapter"] },
        ],
      },
      null,
      2,
    ),
  );
  // Same crossing as the Nx fixture above, so the two blocks prove the same
  // rule fires whichever provider supplied the graph.
  writeNative(
    "libs/domain/doc.go",
    `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
  );

  const nativeFiles = [
    "archkeep.json",
    "architecture-intent.json",
    "module-boundaries.config.mjs",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
    "libs/adapter/README.md",
  ];

  /**
   * `readGraph` is deliberately absent from this context — the native branch
   * of `check()` must never call it. If a future change wired the two
   * branches together carelessly and the native path started calling the Nx
   * `readGraph` seam, this undefined function would throw the moment it was
   * reached, rather than the test silently reusing the Nx fixture's graph and
   * passing for the wrong reason.
   */
  const nativeContext = { cwd: nativeRoot, listFiles: () => nativeFiles };
  const nativeEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      ...nativeContext,
    };
  };

  it("finds the same layer-crossing Go import with no nx.json and no Nx graph", async () => {
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      nativeContext,
    );
    expect(violations).toBe(1);
    expect(report).toContain("libs/domain/doc.go:5:2  onlyTagsConstraintViolation");
  });

  it("counts a tracked file whose literal import names a declared project but cannot resolve — exit 3, never a silent pass", async () => {
    // The fail-closed direction, end to end. A native (non-Nx) workspace with
    // no `tsconfig` `paths` mapping puts an import that names a DECLARED
    // project into a tracked file: the TypeScript resolver can answer "no such
    // module", so the edge that workspace-internal dependency would have
    // carried is missing and the file's boundary verdict is incomplete. That is
    // the same "could not look" the invariant singles out (`AGENTS.md`): an
    // empty violation list over a file the run could not fully judge reads
    // byte-identically to a clean workspace. The analyzer emits the literal
    // resolution failure as a WHOLE-FILE failure only when the specifier names
    // a declared project (`analysis/typescript.mjs`'s `namesDeclaredProject`),
    // so `check` counts the file toward `unchecked` and refuses a verdict
    // (exit 3). `runCli` closes the loop through the real CLI, the same seam
    // CI runs.
    const unresolvableRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-unresolvable-"));
    const writeU = (relativePath, text) => {
      mkdirSync(join(unresolvableRoot, relativePath, ".."), { recursive: true });
      writeFileSync(join(unresolvableRoot, relativePath), text);
    };
    try {
      // The `@billing/api` project is DECLARED with that exact name — an
      // import of it from a sibling project is a workspace-internal dependency
      // that must resolve to a project node. With no tsconfig `paths` mapping
      // it cannot, so the importing file's boundary verdict is incomplete.
      writeU(
        "archkeep.json",
        JSON.stringify({
          projects: {
            declared: [
              { name: "billing-core", root: "libs/billing/core", tags: ["scope:billing"] },
              { name: "@billing/api", root: "libs/billing/api", tags: ["scope:checkout"] },
            ],
          },
          coverage: {
            exempt: [
              {
                path: "module-boundaries.config.mjs",
                reason: "the boundary law is not part of any project",
              },
            ],
          },
        }),
      );
      writeU(
        "module-boundaries.config.mjs",
        `export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const depConstraints = [
  { sourceTag: "*", onlyDependOnLibsWithTags: ["*"] },
];
export const boundarySuppressions = [];
`,
      );
      writeU(
        "libs/billing/core/index.ts",
        'import { helper } from "@billing/api";\nexport const used = helper;\n',
      );
      writeU("libs/billing/api/index.ts", "export const helper = 42;\n");
      const uFiles = [
        "archkeep.json",
        "module-boundaries.config.mjs",
        "libs/billing/core/index.ts",
        "libs/billing/api/index.ts",
      ];
      const streams = {
        ...nativeEnv(),
        cwd: unresolvableRoot,
        listFiles: () => uFiles,
      };

      // The `check()` seam, in-process: the file lands in `notAnalyzed`, so the
      // run produced no verdict for it.
      const { report, violations, unchecked } = await check(
        { format: "text", config: null, paths: [] },
        streams,
      );
      expect(violations).toBe(0);
      expect(unchecked).toBe(1);
      expect(report).toContain("1 file could not be analyzed at all");
      expect(report).toContain(
        "TypeScript cannot resolve '@billing/api' from 'libs/billing/core/index.ts'",
      );

      // The CLI seam, the same verdict through the real exit code: RED on a
      // file the run could not fully look at, never a silent pass.
      const cliStreams = {
        ...nativeEnv(),
        cwd: unresolvableRoot,
        listFiles: () => uFiles,
      };
      expect(await runCli(["check"], cliStreams)).toBe(EXIT.error);
      expect(cliStreams.lines.out.join("\n")).toContain("could not be analyzed at all");
    } finally {
      rmSync(unresolvableRoot, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * Issue #218's workspace, written to its own tmpdir: one declared project,
   * a tracked `libs/version.ts` owned by no project, and an import of it.
   * `exemptVersion: false` writes the SAME tree without that exempt row, which
   * is the red-in-the-silent-direction companion — nothing else moves.
   */
  const writeExemptFixture = (fixtureRoot, { exemptVersion }) => {
    const writeF = (relativePath, text) => {
      mkdirSync(join(fixtureRoot, relativePath, ".."), { recursive: true });
      writeFileSync(join(fixtureRoot, relativePath), text);
    };
    writeF(
      "archkeep.json",
      JSON.stringify({
        projects: {
          declared: [{ root: "libs/core", name: "core", type: "lib", tags: ["layer:core"] }],
        },
        boundaryConfig: "module-boundaries.config.mjs",
        tsConfig: "tsconfig.base.json",
        coverage: {
          exempt: [
            { path: "module-boundaries.config.mjs", reason: "boundary law itself" },
            ...(exemptVersion
              ? [
                  {
                    path: "libs/version.ts",
                    reason: "a tracked workspace file owned by no project",
                  },
                ]
              : []),
          ],
        },
      }),
    );
    writeF(
      "module-boundaries.config.mjs",
      `export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const depConstraints = [
  { sourceTag: "layer:core", onlyDependOnLibsWithTags: ["layer:core"] },
];
`,
    );
    // Bundler resolution is what maps the `.js` spelling onto the `.ts`
    // sibling, exactly as the issue's workspace resolved them.
    writeF(
      "tsconfig.base.json",
      JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler" } }),
    );
    writeF("libs/version.ts", 'export const VERSION = "1.0.0";\n');
    writeF("libs/core/util.ts", 'export const UTIL = "util";\n');
    writeF(
      "libs/core/index.ts",
      'import { VERSION } from "../version.js";\n' +
        'import { UTIL } from "./util.js";\n' +
        "export const core = VERSION + UTIL;\n",
    );
    return [
      "archkeep.json",
      "module-boundaries.config.mjs",
      "tsconfig.base.json",
      "libs/version.ts",
      "libs/core/util.ts",
      "libs/core/index.ts",
    ];
  };

  it("leaves an import of a coverage-exempt file unconstrained, counted in the notes (#218)", async () => {
    const exemptRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-exempt-"));
    try {
      const files = writeExemptFixture(exemptRoot, { exemptVersion: true });
      const exemptContext = { cwd: exemptRoot, listFiles: () => files };

      // Both imports judged: the exempt-file one unconstrained, the sibling
      // `./util.js` control inside the project as it always was.
      const { report, violations } = await check(
        { format: "text", config: null, paths: [] },
        exemptContext,
      );
      expect(violations).toBe(0);
      expect(report).not.toContain("noRelativeOrAbsoluteExternals");
      expect(report).toContain("2 files exempted from coverage");
      expect(report).toContain(
        "1 import resolves into those files and is left unconstrained — " +
          "neither project edges nor external imports",
      );

      // The JSON envelope states the same fact on the surface that already
      // exists — coverage.notes — and the verdict stays clean.
      const { report: jsonReport } = await check(
        { format: "json", config: null, paths: [] },
        exemptContext,
      );
      const envelope = JSON.parse(jsonReport);
      expect(envelope.status).toBe("ok");
      expect(envelope.exitCode).toBe(EXIT.ok);
      expect(envelope.coverage.complete).toBe(true);
      expect(envelope.coverage.notes).toContain(
        "1 import resolves into those files and is left unconstrained — " +
          "neither project edges nor external imports",
      );
    } finally {
      rmSync(exemptRoot, { recursive: true, force: true });
    }
  });

  it("still reports the import when no exempt row covers the target file — the silent direction (#218)", async () => {
    const unexemptRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-unexempt-"));
    try {
      const files = writeExemptFixture(unexemptRoot, { exemptVersion: false });
      const { report, violations, unchecked } = await check(
        { format: "text", config: null, paths: [] },
        { cwd: unexemptRoot, listFiles: () => files },
      );
      // Both loud halves at once: the target file itself turns up as an
      // unclaimed whole-file failure, and the import keeps the verdict it had
      // before the exemption existed. A fix that silenced unresolved paths
      // wholesale turns this red.
      expect(violations).toBe(1);
      expect(unchecked).toBe(1);
      expect(report).toContain("noRelativeOrAbsoluteExternals");
    } finally {
      rmSync(unexemptRoot, { recursive: true, force: true });
    }
  });

  it("keeps an unresolved bare-package import a blind spot — a workspace with packages is normal", async () => {
    // The OTHER side of the discriminator, and what keeps the native selfcheck
    // green: a native copy of this repository sees hundreds of bare-package
    // imports (`vitest`, `@nx/eslint-plugin`, an uninstalled `left-pad`) that
    // cannot resolve because the tree ships no `node_modules`. Those are
    // legitimate package dependencies, NOT missing workspace edges — no
    // declared project is named `left-pad`. Failing the whole run on them would
    // make every package-owning workspace uncheckable. They stay positioned
    // blind spots (reported loudly, exit 0).
    const pkgRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-unresolvable-pkg-"));
    const writeP = (relativePath, text) => {
      mkdirSync(join(pkgRoot, relativePath, ".."), { recursive: true });
      writeFileSync(join(pkgRoot, relativePath), text);
    };
    try {
      writeP(
        "archkeep.json",
        JSON.stringify({
          projects: {
            declared: [{ name: "core", root: "libs/core", tags: ["scope:core"] }],
          },
          coverage: {
            exempt: [
              {
                path: "module-boundaries.config.mjs",
                reason: "the boundary law is not part of any project",
              },
            ],
          },
        }),
      );
      writeP(
        "module-boundaries.config.mjs",
        `export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const depConstraints = [
  { sourceTag: "*", onlyDependOnLibsWithTags: ["*"] },
];
export const boundarySuppressions = [];
`,
      );
      writeP("libs/core/index.ts", 'import { pad } from "left-pad";\nexport const used = pad;\n');
      const pFiles = ["archkeep.json", "module-boundaries.config.mjs", "libs/core/index.ts"];
      const streams = {
        ...nativeEnv(),
        cwd: pkgRoot,
        listFiles: () => pFiles,
      };

      const { report, violations, unchecked } = await check(
        { format: "text", config: null, paths: [] },
        streams,
      );
      expect(violations).toBe(0);
      expect(unchecked).toBe(0);
      // The blind spot is still reported — loud, never silent — but the verdict
      // stays `ok` because the import names no declared project.
      expect(report).toContain("left-pad");
      expect(report).toContain("TypeScript cannot resolve 'left-pad'");
      expect(report).not.toContain("could not be analyzed at all");

      const cliStreams = {
        ...nativeEnv(),
        cwd: pkgRoot,
        listFiles: () => pFiles,
      };
      expect(await runCli(["check"], cliStreams)).toBe(EXIT.ok);
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("writes a drift report to --output atomically, and names the fact on stderr", async () => {
    // The `--output` branch of `runDrift`: write to `<target>.tmp`, rename over
    // the target, print the comparison fact on stderr. Neither a `<target>.tmp`
    // left behind nor a missing/truncated target may survive the run, because
    // a report that half-appeared is the silent direction.
    const target = join(nativeRoot, "drift.json");
    const streams = nativeEnv();
    expect(await runCli(["drift", "--format", "json", "--output", target], streams)).toBe(EXIT.ok);
    expect(existsSync(`${target}.tmp`)).toBe(false);
    expect(streams.lines.err.join("\n")).toContain("1 edges → ");
    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written.command).toBe("drift");
    expect(written.result.intent.file).toBe("architecture-intent.json");
    expect(written.result.findings).toHaveLength(0);
    expect(written.coverage.complete).toBe(true);
  });

  it("--output refuses rather than writes through a symlink planted at <target>.tmp", async () => {
    // Every value in `--output` and every value in a report body — a project
    // name, an import specifier — comes from the tree being judged and is
    // attacker-supplied the moment a pull request adds one. Before
    // `writeOutputReport`'s `{flag: "wx"}` guard, a tracked symlink at
    // `<target>.tmp` made the write follow it and overwrite whatever the
    // symlink named, with attacker-chosen bytes, while reporting success.
    const outside = mkdtempSync(join(tmpdir(), "polyglot-cli-output-outside-"));
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "must not be touched\n");
    const target = join(nativeRoot, "planted.json");
    symlinkSync(secret, `${target}.tmp`);
    try {
      const streams = nativeEnv();
      expect(await runCli(["graph", "--format", "json", "--output", target], streams)).toBe(
        EXIT.error,
      );
      expect(streams.lines.err.join("\n")).toContain("could not write --output");
      // The symlink is left exactly as it was — refusing means never opening
      // the write, so there is nothing this run created to clean up.
      expect(lstatSync(`${target}.tmp`).isSymbolicLink()).toBe(true);
      expect(readFileSync(secret, "utf8")).toBe("must not be touched\n");
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(`${target}.tmp`, { force: true });
    }
  });

  it("--output refuses rather than silently truncating a pre-existing <target>.tmp", async () => {
    // The same guard's other half: a stray `.tmp` from a crashed prior run —
    // or any file that happens to collide with the name — used to be
    // silently overwritten and then renamed away. It must survive instead,
    // and the run must say so rather than reporting success over it.
    const target = join(nativeRoot, "collides.json");
    writeFileSync(`${target}.tmp`, "pre-existing data, not this run's to destroy\n");
    try {
      const streams = nativeEnv();
      expect(await runCli(["graph", "--format", "json", "--output", target], streams)).toBe(
        EXIT.error,
      );
      expect(readFileSync(`${target}.tmp`, "utf8")).toBe(
        "pre-existing data, not this run's to destroy\n",
      );
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(`${target}.tmp`, { force: true });
    }
  });

  it("--output refuses rather than silently overwriting the tracked architecture-intent.json", async () => {
    // `{flag: "wx"}` above protects the `.tmp` intermediate; it says nothing
    // about the FINAL name, and `renameSync` replaces whatever already sits
    // there unconditionally. Before `governanceOutputTargets`, `archkeep check
    // --output architecture-intent.json` — a copy-pasted flag, a typo'd
    // path, or a CI script a pull request edited — silently replaced the
    // tracked intent this fixture declares above with a check report, exit 0
    // (P1-24's own example command). The write must never even attempt a
    // `.tmp` file at this target: refused before either name is touched.
    const target = join(nativeRoot, "architecture-intent.json");
    const before = readFileSync(target, "utf8");
    const streams = nativeEnv();
    expect(await runCli(["check", "--format", "json", "--output", target], streams)).toBe(
      EXIT.error,
    );
    expect(streams.lines.err.join("\n")).toContain("resolves to 'architecture-intent.json'");
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("--output refuses rather than silently overwriting the tracked archkeep.json", async () => {
    const target = join(nativeRoot, "archkeep.json");
    const before = readFileSync(target, "utf8");
    const streams = nativeEnv();
    expect(await runCli(["graph", "--format", "json", "--output", target], streams)).toBe(
      EXIT.error,
    );
    expect(streams.lines.err.join("\n")).toContain("resolves to 'archkeep.json'");
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("--output refuses rather than silently overwriting the workspace's boundary-law file", async () => {
    // The un-overridden default name (`DEFAULT_OPTIONS.boundaryConfig`) —
    // this fixture never renames it via `--config`. Silently overwriting it
    // would also corrupt the very `module-boundaries.config.mjs` every other
    // `--config` test in this file `import()`s, which is exactly why THOSE
    // tests are careful to write a separate filename instead (see the next
    // test's own comment).
    const target = join(nativeRoot, "module-boundaries.config.mjs");
    const before = readFileSync(target, "utf8");
    const streams = nativeEnv();
    expect(await runCli(["graph", "--format", "json", "--output", target], streams)).toBe(
      EXIT.error,
    );
    expect(streams.lines.err.join("\n")).toContain("resolves to 'module-boundaries.config.mjs'");
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("--output still overwrites an ordinary, previously-written report — the documented CI reuse", async () => {
    // The governance guard above is deliberately narrow. `docs/usage/ci.md`'s
    // own recipe reruns `--output boundaries.json` on every push, relying on
    // the previous run's file being silently replaced — this is the
    // negative-space proof the new guard did not widen into refusing every
    // pre-existing target, only the fixed governance names.
    const target = join(nativeRoot, "reused-report.json");
    const first = nativeEnv();
    expect(await runCli(["graph", "--format", "json", "--output", target], first)).toBe(EXIT.ok);
    expect(existsSync(target)).toBe(true);
    const second = nativeEnv();
    expect(await runCli(["graph", "--format", "json", "--output", target], second)).toBe(EXIT.ok);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("folds a declared fitness function into the check verdict — a coverage-minimum over owned files", async () => {
    // A SEPARATE config filename, never `module-boundaries.config.mjs`: that
    // file was already `import()`ed during the describe-block setup, and ES
    // module import caching means a rewritten copy is not what the next
    // `loadBoundaryConfig` call reads. A fresh filename is imported clean.
    // The native fixture owns exactly two analyzable files (both `.go`), and
    // the analysis analyzed both, so a 100%-coverage minimum passes.
    writeNative(
      "fitness-full.config.mjs",
      `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const fitness = [
  {
    name: "full-coverage",
    match: ["*"],
    condition: { type: "coverage-minimum", statement: 100 },
    reason: "every owned file must be analyzed",
  },
];
`,
    );
    const { report, violations, unchecked } = await check(
      { format: "text", config: "fitness-full.config.mjs", paths: [] },
      nativeContext,
    );
    // Both files are analyzed; the layer crossing (domain→adapter) is still
    // a real boundary finding, and the fitness verdict is independent of it.
    expect(violations).toBe(1);
    expect(unchecked).toBe(0);
    expect(report).toContain("✔ full-coverage");
    expect(report).toContain("2/2 files analyzed (100%)");
  });

  it("exits 1 when a declared fitness function fails — a fitness fail is a finding (D-09)", async () => {
    // The `fitness` COMMAND's exit code was hardcoded 0 before D-09/F03 — the
    // verdict table printed `✖` but the process exited 0, so a CI gating on
    // `archkeep fitness` was green over a failing function. A `fail` verdict
    // must exit 1 (findings), the same lane `check` uses for a boundary
    // violation.
    writeNative(
      "fitness-fail.config.mjs",
      `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const fitness = [
  {
    name: "domain-may-not-reach-adapter",
    match: ["*"],
    condition: { type: "layer-dependency", from: "layer:domain", to: "layer:adapter", direction: "forbidden" },
    reason: "the domain layer must never reach the adapter",
  },
];
`,
    );
    const streams = nativeEnv();
    expect(await runCli(["fitness", "--config", "fitness-fail.config.mjs"], streams)).toBe(
      EXIT.violations,
    );
    const out = streams.lines.out.join("\n");
    expect(out).toContain("✖ domain-may-not-reach-adapter");
    expect(out).toContain("the build fails");
  });

  it("exits 3 when an intent row cites an unresolved decisionRef — the gate's face is never silent (F01)", async () => {
    // F01: `check` used to NEVER surface intent-row unresolved decisionRefs —
    // `drift`/`provenance` flag the identical row loudly, but the gate CI runs
    // was the one face that stayed silent. A clean boundary (this law ALLOWS
    // the domain→adapter crossing) plus an intent row citing a nonexistent
    // decisionRef must fold into the no-verdict lane: exit 3, with the
    // citation named in both the text and the JSON. A workspace that declared
    // an intended architecture whose governing decision does not exist cannot
    // claim `ok` on that axis.
    const root = mkdtempSync(join(tmpdir(), "polyglot-cli-f01-"));
    try {
      const w = (p, t) => {
        mkdirSync(join(root, p, ".."), { recursive: true });
        writeFileSync(join(root, p), t);
      };
      w(
        "archkeep.json",
        JSON.stringify({
          projects: {
            declared: [
              { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
              { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
            ],
          },
          coverage: {
            exempt: [{ path: "module-boundaries.config.mjs", reason: "workspace tooling config" }],
          },
        }),
      );
      w(
        "module-boundaries.config.mjs",
        `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:adapter", "layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
      );
      w("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
      w(
        "libs/domain/doc.go",
        'package domain\n\nimport "example.com/adapter"\n\nvar _ = adapter.Name\n',
      );
      w("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
      w("libs/adapter/adapter.go", "package adapter\n\nvar Name string\n");
      w(
        "architecture-intent.json",
        JSON.stringify({
          version: "1",
          boundaries: [
            { name: "domain", match: ["name:domain"] },
            { name: "adapter", match: ["name:adapter"] },
          ],
          forbidden: [
            {
              from: "adapter",
              to: "domain",
              reason: "adapter must not reach the domain",
              decisionRef: "9999-never-written",
            },
          ],
        }),
      );
      const files = [
        "archkeep.json",
        "module-boundaries.config.mjs",
        "architecture-intent.json",
        "libs/domain/go.mod",
        "libs/domain/doc.go",
        "libs/adapter/go.mod",
        "libs/adapter/adapter.go",
      ];
      const streams = {
        out: (t) => streams.lines.out.push(t),
        err: (t) => streams.lines.err.push(t),
        lines: { out: [], err: [] },
        cwd: root,
        listFiles: () => files,
      };
      // The boundary is clean — no violations. The run must still exit 3.
      expect(await runCli(["check", "--format", "json"], streams)).toBe(EXIT.error);
      const envelope = JSON.parse(streams.lines.out.join("\n"));
      expect(envelope.status).toBe("no-verdict");
      expect(envelope.result.unresolvedDecisionRefs).toEqual(["9999-never-written"]);
      expect(envelope.result.intent.unresolvedDecisionRefs).toEqual([
        { kind: "forbidden[0]", decisionRef: "9999-never-written" },
      ]);
      expect(envelope.decision.reason).toContain(
        "1 intent row cites a decisionRef that does not resolve",
      );

      const textStreams = {
        out: (t) => textStreams.lines.out.push(t),
        err: (t) => textStreams.lines.err.push(t),
        lines: { out: [], err: [] },
        cwd: root,
        listFiles: () => files,
      };
      await runCli(["check"], textStreams);
      const text = textStreams.lines.out.join("\n");
      expect(text).toContain("UNRESOLVED");
      expect(text).toContain("forbidden[0] decisionRef [9999-never-written]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 3 when a declared fitness function cannot be determined — never a pass", async () => {
    writeNative(
      "fitness-unknown.config.mjs",
      `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const fitness = [
  {
    name: "no-domain-yet",
    match: ["*"],
    condition: { type: "layer-dependency", from: "layer:service", to: "layer:domain", direction: "required" },
    reason: "a service layer will need the domain",
  },
];
`,
    );
    // Scoped to `libs/adapter` so the fixture's real domain→adapter crossing
    // (a findings-axis red, which would win the verdict) is not selected for
    // analysis — this test pins the no-verdict lane alone. The `--config`
    // flag loads the fresh config by path.
    const streams = nativeEnv();
    expect(
      await runCli(["check", "--config", "fitness-unknown.config.mjs", "libs/adapter"], streams),
    ).toBe(EXIT.error);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("⚠ no-domain-yet");
    expect(out).toContain("no matched project carries tag");
  });

  it("a path-scoped run reports coverage-minimum not_applicable rather than a partial number, and — since P1-19 — that alone no longer exits 3", async () => {
    // P0-1 regression (still guarded here): `fitnessSnapshot` used to put
    // `scoped` on the snapshot's top level, where `judgeFitnessRow` never read
    // it — so `check libs/adapter` over a `coverage-minimum` fitness claimed
    // `pass` over the one file it actually analyzed, the silent direction. The
    // flag now rides inside `analysis`, and `coverage-minimum` must never read
    // that partial view as a real number.
    //
    // P1-19 regression (this test's own reason to exist now): the fix for
    // P0-1 answered `unknown`, which folds into `check`'s exit code the same
    // as a genuine coverage hole — so `check libs/adapter` exited 3 here even
    // though the scoped subtree (`libs/adapter/adapter.go`, no imports at all)
    // has no problem of its own, and every other axis (boundary violations,
    // the tracked intent) is clean. The audit found this made `check <path>`
    // exit 3 UNCONDITIONALLY in any `coverage-minimum`-declaring workspace —
    // exactly the shape this repository's own root `module-boundaries.config.mjs`
    // declares — while four documentation/skill surfaces recommend a scoped
    // run as a fast pre-commit check with no warning that the combination
    // always failed. `coverage-minimum` now answers `not_applicable` instead:
    // still never `pass` (P0-1 stays fixed) and still a loud, named row (never
    // silent), but no longer folded into `fitnessFail`/`fitnessUnknown`, so
    // this clean scoped run now exits 0.
    writeNative(
      "fitness-scoped.config.mjs",
      `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const fitness = [
  {
    name: "scoped-coverage",
    match: ["*"],
    condition: { type: "coverage-minimum", statement: 100 },
    reason: "scoping must never read as full coverage",
  },
];
`,
    );
    const streams = nativeEnv();
    // `libs/adapter` scopes the run to one project's files; the other
    // project's files were not analyzed, so whole-tree coverage is not
    // determinable — but `libs/adapter/adapter.go` itself has no import at
    // all, so the scoped subset genuinely has nothing wrong with it.
    expect(
      await runCli(["check", "--config", "fitness-scoped.config.mjs", "libs/adapter"], streams),
    ).toBe(EXIT.ok);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("◌ scoped-coverage");
    expect(out).toContain("does not apply to a path-scoped run");
    // Never the silent direction either: a scoped run must not be read as a
    // measured full-coverage pass.
    expect(out).not.toContain("✔ scoped-coverage");
  });

  it("a real violation inside a scoped path still exits 1 in a coverage-minimum-declaring workspace — not_applicable never masks a finding (P1-19)", async () => {
    // The other silent direction P1-19's fix must not open: `not_applicable`
    // must never outrank a real finding. Scoped to `libs/domain` instead —
    // the side of the fixture's real domain→adapter crossing — so the
    // boundary violation is squarely IN scope this time, and the run must
    // still fail on it despite the very same `coverage-minimum` row being
    // declared and equally unable to judge a scoped run.
    writeNative(
      "fitness-scoped-violation.config.mjs",
      `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const fitness = [
  {
    name: "scoped-coverage",
    match: ["*"],
    condition: { type: "coverage-minimum", statement: 100 },
    reason: "scoping must never read as full coverage",
  },
];
`,
    );
    const streams = nativeEnv();
    expect(
      await runCli(
        ["check", "--config", "fitness-scoped-violation.config.mjs", "libs/domain"],
        streams,
      ),
    ).toBe(EXIT.violations);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("onlyTagsConstraintViolation");
    expect(out).toContain("◌ scoped-coverage");
  });

  it("judges drift-free against the verdict-shaped intent, not the raw file — a clean intent passes, never fail", async () => {
    // P0-2 regression: the `fitness` command used to hand `loadIntent`'s raw
    // normalized model (no `verdict`/`findings`/`unresolved`) to the
    // `drift-free` rule, whose final branch read `verdict === undefined` as
    // `fail` — so a clean intent reported `✖ drift-free` over "0 findings".
    // The command now reuses `driftForCheck`'s verdict-shaped intent, the same
    // one `check`'s fold builds. The native fixture tracks an
    // `architecture-intent.json` whose boundaries match the observed projects,
    // so the comparison is clean and the function must PASS.
    writeNative(
      "fitness-drift.config.mjs",
      `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const fitness = [
  {
    name: "intent-clean",
    match: ["*"],
    condition: { type: "drift-free" },
    reason: "this workspace declares an intent and must not drift from it",
  },
];
`,
    );
    const streams = nativeEnv();
    expect(await runCli(["fitness", "--config", "fitness-drift.config.mjs"], streams)).toBe(
      EXIT.ok,
    );
    const out = streams.lines.out.join("\n");
    expect(out).toContain("✔ intent-clean");
    expect(out).toContain("matches the observed graph");
  });

  it("exits 3 when the graph cannot see the workspace — the fitness command must not fold an incomplete-graph refusal into a verdict", async () => {
    // R2-Major regression: `fitnessCommand` used to wrap `driftForCheck` in a
    // catch-all that converted its fail-closed throw (an Nx workspace whose
    // `nx.json` does not register this plugin but whose tracked files include
    // polyglot manifests) into a `no-verdict` intent with exit 0. Every other
    // read-only command (`drift`, `graph`, `impact`, `explain`) exits 3 for
    // this same condition — a graph that cannot see the workspace must never
    // be judged as if it did. The command now lets the throw propagate, so the
    // run exits 3 naming the refusal.
    const root = mkdtempSync(join(tmpdir(), "fitness-cli-unregistered-"));
    try {
      const writeUnreg = (relativePath, text) => {
        mkdirSync(join(root, relativePath, ".."), { recursive: true });
        writeFileSync(join(root, relativePath), text);
      };
      writeUnreg("nx.json", JSON.stringify({})); // No plugins entry.
      writeUnreg(
        "module-boundaries.config.mjs",
        `export const depConstraints = [];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const fitness = [
  {
    name: "intent-clean",
    match: ["*"],
    condition: { type: "drift-free" },
    reason: "must not be judged over a graph that cannot see the workspace",
  },
];
`,
      );
      writeUnreg("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
      writeUnreg("libs/domain/doc.go", "package domain\n");
      const graph = {
        nodes: {
          domain: {
            name: "domain",
            type: "lib",
            data: { root: "libs/domain", tags: [] },
          },
        },
        dependencies: { domain: [] },
      };
      const files = [
        "nx.json",
        "module-boundaries.config.mjs",
        "libs/domain/go.mod",
        "libs/domain/doc.go",
      ];
      const streams = {
        out: (t) => streams.lines.out.push(t),
        err: (t) => streams.lines.err.push(t),
        lines: { out: [], err: [] },
        cwd: root,
        readGraph: () => graph,
        listFiles: () => files,
      };
      expect(await runCli(["fitness"], streams)).toBe(EXIT.error);
      const report = streams.lines.out.join("\n") + streams.lines.err.join("\n");
      expect(report).toContain("refusing to judge drift");
      expect(report).toContain("go.mod");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not crash when fitness is declared with no architecture-intent.json anywhere — the supported configuration where fitness lives in the policy file alone", async () => {
    // P1-14 regression: `fitnessCommand` called `driftForCheck` unconditionally
    // and built its own verdict-shaped `intent` straight from the result, so a
    // workspace that legitimately has no architecture-intent.json (fully
    // supported — fitness needs no intent file to run) reached
    // `judgeIntent(undefined, ...)` inside `driftForCheck`, which dereferenced
    // `intent.boundaries` on `undefined` and threw a raw, unhandled
    // `TypeError: Cannot read properties of undefined (reading 'boundaries')`
    // straight out to the operator instead of a verdict or a named refusal.
    // A self-contained fixture — never the shared `nativeRoot`/`nativeContext`
    // above, which always tracks an architecture-intent.json for the drift
    // tests — is the only way to exercise "fitness declared, no intent file at
    // all". One row needs no intent (`coverage-minimum`) and must still
    // evaluate normally; one row DOES need intent (`drift-free`) and must read
    // `unknown` — "cannot judge" — never a crash and never a false `pass`.
    const root = mkdtempSync(join(tmpdir(), "fitness-no-intent-"));
    try {
      const writeFixture = (relativePath, text) => {
        mkdirSync(join(root, relativePath, ".."), { recursive: true });
        writeFileSync(join(root, relativePath), text);
      };
      writeFixture(
        "archkeep.json",
        JSON.stringify({
          projects: {
            declared: [{ root: "libs/domain", name: "domain", tags: ["layer:domain"] }],
          },
          // `module-boundaries.config.mjs` sits at the workspace root, which no
          // declared project owns — the same waiver the shared native fixture
          // above needs and explains.
          coverage: {
            exempt: [
              {
                path: "module-boundaries.config.mjs",
                reason: "workspace tooling config at the root, not itself a project",
              },
            ],
          },
        }),
      );
      writeFixture(
        "module-boundaries.config.mjs",
        `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const fitness = [
  {
    name: "full-coverage",
    match: ["*"],
    condition: { type: "coverage-minimum", statement: 100 },
    reason: "every owned file must be analyzed",
  },
  {
    name: "intent-clean",
    match: ["*"],
    condition: { type: "drift-free" },
    reason: "must read unknown, never crash and never pass, with no intent file declared",
  },
];
`,
      );
      writeFixture("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
      writeFixture("libs/domain/doc.go", "package domain\n");
      // No architecture-intent.json anywhere in the fixture or its tracked-file
      // list — the exact condition the audit named.
      const files = [
        "archkeep.json",
        "module-boundaries.config.mjs",
        "libs/domain/go.mod",
        "libs/domain/doc.go",
      ];
      const streams = {
        out: (t) => streams.lines.out.push(t),
        err: (t) => streams.lines.err.push(t),
        lines: { out: [], err: [] },
        cwd: root,
        listFiles: () => files,
      };
      expect(await runCli(["fitness"], streams)).toBe(EXIT.error);
      const report = streams.lines.out.join("\n") + streams.lines.err.join("\n");
      expect(report).not.toContain("Cannot read properties of undefined");
      expect(report).not.toContain("TypeError");
      expect(report).toContain("✔ full-coverage");
      expect(report).toContain("⚠ intent-clean");
      expect(report).toContain("cannot judge drift-free — no architecture-intent.json is declared");
      // D-09: the run could not determine `intent-clean` (no intent file), so
      // it is `unknown`, and an unknown is exit 3 — "the supported
      // configuration" must not claim `pass` over an axis it did not judge.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says nothing about README.md, since it is not an analyzable file — the coverage near-miss that keeps the check usable", async () => {
    const { report, violations, unchecked } = await check(
      { format: "text", config: null, paths: [] },
      nativeContext,
    );
    expect(violations).toBe(1);
    expect(unchecked).toBe(0);
    expect(report).not.toContain("README.md");
  });

  it("exits 3 over a file no declared project owns, naming it — the unclaimed-file coverage hole", async () => {
    // The silent-direction failure this guards: an orphaned analyzable file
    // must not be dropped the way `createWorkspace` drops a file with no
    // owning project on the Nx path — it has to surface as a whole-file
    // failure and flip the exit code, exactly like an unreadable file does.
    // Scoped to `libs/adapter` so the domain→adapter crossing (a finding, not
    // a coverage hole) is not selected for analysis and does not conflate
    // exit 1 with exit 3 — the two are asserted apart in "the exit contract"
    // below, over the Nx fixture; this block only needs to prove the native
    // path reaches the same coverage-hole verdict at all.
    const streams = {
      ...nativeEnv(),
      listFiles: () => [...nativeFiles, "libs/orphan/orphan.py"],
    };
    writeNative("libs/orphan/orphan.py", "import os\n");
    expect(await runCli(["check", "libs/adapter"], streams)).toBe(EXIT.error);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("libs/orphan/orphan.py");
    expect(out).toContain("not owned by any project");
  });

  it("refuses a root carrying both nx.json and archkeep.json, naming the tree rather than guessing", async () => {
    const bothRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-both-"));
    try {
      writeFileSync(join(bothRoot, "nx.json"), "{}\n");
      writeFileSync(join(bothRoot, "archkeep.json"), "{}\n");
      const streams = {
        ...nativeEnv(),
        cwd: bothRoot,
        listFiles: () => ["nx.json", "archkeep.json"],
      };
      expect(await runCli(["check"], streams)).toBe(EXIT.error);
      expect(streams.lines.err.join("\n")).toContain("declares both nx.json and archkeep.json");
    } finally {
      rmSync(bothRoot, { recursive: true, force: true });
    }
  });

  it("--output refuses a symlinked intermediate directory resolving outside the workspace (G-02a)", async () => {
    // A committed symlink `sub -> /tmp/out` at the workspace root. Before
    // `containmentViolation` (`src/containment.mjs`), `archkeep check --output
    // sub/PWN.txt` wrote the report to `/tmp/out/PWN.txt` — OUTSIDE the
    // workspace — with the tree untouched and exit 0: a runner-write primitive
    // with the report's (tree-derived) bytes. New behavior: refused loudly
    // (exit 3), and neither the outside file nor a `.tmp` may appear.
    const outside = mkdtempSync(join(tmpdir(), "polyglot-cli-g02-outside-"));
    const escapeRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-g02a-"));
    try {
      const writeEscape = (relativePath, text) => {
        mkdirSync(join(escapeRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(escapeRoot, relativePath), text);
      };
      writeEscape(
        "archkeep.json",
        JSON.stringify({
          projects: { declared: [{ root: "libs/domain", name: "domain", tags: ["layer:domain"] }] },
          coverage: {
            exempt: [
              {
                path: "module-boundaries.config.mjs",
                reason: "workspace tooling config at the root, not itself a project",
              },
            ],
          },
        }),
      );
      writeEscape(
        "module-boundaries.config.mjs",
        `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
      );
      writeEscape("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
      writeEscape("libs/domain/doc.go", "package domain\n");
      symlinkSync(outside, join(escapeRoot, "sub"));
      const files = [
        "archkeep.json",
        "module-boundaries.config.mjs",
        "sub",
        "libs/domain/go.mod",
        "libs/domain/doc.go",
      ];
      const streams = {
        ...nativeEnv(),
        cwd: escapeRoot,
        listFiles: () => files,
      };
      const target = join(escapeRoot, "sub", "PWN.txt");
      expect(await runCli(["check", "--format", "json", "--output", target], streams)).toBe(
        EXIT.error,
      );
      expect(streams.lines.err.join("\n")).toContain("is refused");
      expect(streams.lines.err.join("\n")).toContain("sub");
      expect(existsSync(join(outside, "PWN.txt"))).toBe(false);
      expect(existsSync(join(escapeRoot, "PWN.txt"))).toBe(false);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(escapeRoot, { recursive: true, force: true });
    }
  });

  it("--output refuses a self-loop symlink that would land the write at the workspace root (G-02b)", async () => {
    // `sub -> .` resolves INSIDE the workspace, so realpath containment alone
    // passes — but the write would land at the workspace ROOT as `report.txt`,
    // not under `sub/`: a different location than the user named, byte-identical
    // to a clean run. The write policy's no-symlink-below-root rule catches it.
    const escapeRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-g02b-"));
    try {
      const writeEscape = (relativePath, text) => {
        mkdirSync(join(escapeRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(escapeRoot, relativePath), text);
      };
      writeEscape(
        "archkeep.json",
        JSON.stringify({
          projects: { declared: [{ root: "libs/domain", name: "domain", tags: ["layer:domain"] }] },
          coverage: {
            exempt: [
              {
                path: "module-boundaries.config.mjs",
                reason: "workspace tooling config at the root, not itself a project",
              },
            ],
          },
        }),
      );
      writeEscape(
        "module-boundaries.config.mjs",
        `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
      );
      writeEscape("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
      writeEscape("libs/domain/doc.go", "package domain\n");
      symlinkSync(escapeRoot, join(escapeRoot, "sub"));
      const files = [
        "archkeep.json",
        "module-boundaries.config.mjs",
        "sub",
        "libs/domain/go.mod",
        "libs/domain/doc.go",
      ];
      const streams = {
        ...nativeEnv(),
        cwd: escapeRoot,
        listFiles: () => files,
      };
      const target = join(escapeRoot, "sub", "report.txt");
      expect(await runCli(["check", "--format", "json", "--output", target], streams)).toBe(
        EXIT.error,
      );
      expect(streams.lines.err.join("\n")).toContain("is refused");
      expect(existsSync(join(escapeRoot, "report.txt"))).toBe(false);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(escapeRoot, { recursive: true, force: true });
    }
  });

  it("--output with a `..` across a symlinked intermediate writes the resolved path, not the kernel's (G-02c)", async () => {
    // The write escape's third shape: `sub -> <outside>` plus a target written
    // as `sub/../out2/PWN.txt`. Before the resolve-first contract, the check
    // ran on `resolve(cwd, target)` — which collapses `..` lexically and skips
    // the symlink — while the write used the raw string, where the kernel
    // follows `sub` out of the tree, then lets `..` climb to `<outside>/out2`.
    // The report landed OUTSIDE the workspace with exit 0, the tree untouched.
    // Now the identical resolved string feeds check AND write: `..` is
    // collapsed before the symlink is consulted, so the report lands at the
    // workspace-internal `<escapeRoot>/out2/PWN.txt` and the outside
    // `<outside>/out2/PWN.txt` never appears.
    const outsideRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-g02c-outside-"));
    const outside = join(outsideRoot, "out");
    const escapeRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-g02c-"));
    try {
      mkdirSync(outside, { recursive: true });
      const writeEscape = (relativePath, text) => {
        mkdirSync(join(escapeRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(escapeRoot, relativePath), text);
      };
      writeEscape(
        "archkeep.json",
        JSON.stringify({
          projects: { declared: [{ root: "libs/domain", name: "domain", tags: ["layer:domain"] }] },
          coverage: {
            exempt: [
              {
                path: "module-boundaries.config.mjs",
                reason: "workspace tooling config at the root, not itself a project",
              },
            ],
          },
        }),
      );
      writeEscape(
        "module-boundaries.config.mjs",
        `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
      );
      writeEscape("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
      writeEscape("libs/domain/doc.go", "package domain\n");
      // The kernel-equivalent landing (`<outside>/../out2/PWN.txt`) exists, so
      // the OLD code would have written there and reported success — the
      // silent direction this test pins.
      mkdirSync(join(outside, "..", "out2"), { recursive: true });
      // The resolved landing (`<escapeRoot>/out2/PWN.txt`) exists too, so the
      // NEW code's write succeeds inside the workspace.
      mkdirSync(join(escapeRoot, "out2"), { recursive: true });
      symlinkSync(outside, join(escapeRoot, "sub"));
      const files = [
        "archkeep.json",
        "module-boundaries.config.mjs",
        "sub",
        "libs/domain/go.mod",
        "libs/domain/doc.go",
      ];
      const streams = {
        ...nativeEnv(),
        cwd: escapeRoot,
        listFiles: () => files,
      };
      // Absolute, but spelled RAW — `join` would collapse the `..` lexically;
      // the kernel (and the OLD write) resolves `sub` first, then `..`, so the
      // raw spelling is exactly what used to escape.
      const rawTarget = `${escapeRoot}/sub/../out2/PWN.txt`;
      const resolvedTarget = join(escapeRoot, "out2", "PWN.txt");
      const kernelLanding = join(outsideRoot, "out2", "PWN.txt");
      expect(await runCli(["check", "--format", "json", "--output", rawTarget], streams)).toBe(
        EXIT.ok,
      );
      expect(existsSync(kernelLanding)).toBe(false);
      expect(existsSync(resolvedTarget)).toBe(true);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
      rmSync(escapeRoot, { recursive: true, force: true });
    }
  });

  it("treats a tracked symlink leaving the workspace as an unanalyzable file (G-10)", async () => {
    // Silent direction: before `containmentViolation` on the read side, the
    // committed symlink was followed by plain `readFileSync(join(root, path))`
    // and its import sites were judged AS workspace content — the outside file
    // appeared in `coverage.imports`, and its (here unresolvable) import was a
    // `blindSpot`, verdict still pass (exit 0). New behavior: the file cannot
    // be read as workspace content, so it is a whole-file failure — the run
    // must say so loudly (exit 3) instead of reporting a clean verdict.
    const readRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-g10-"));
    const outside = mkdtempSync(join(tmpdir(), "polyglot-cli-g10-outside-"));
    try {
      const writeRead = (relativePath, text) => {
        mkdirSync(join(readRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(readRoot, relativePath), text);
      };
      writeRead(
        "archkeep.json",
        JSON.stringify({
          projects: {
            declared: [
              { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
              { root: "net", name: "net", tags: ["layer:domain"] },
            ],
          },
          coverage: {
            exempt: [
              {
                path: "module-boundaries.config.mjs",
                reason: "workspace tooling config at the root, not itself a project",
              },
            ],
          },
        }),
      );
      writeRead(
        "module-boundaries.config.mjs",
        `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
      );
      writeRead("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
      writeRead("libs/domain/doc.go", "package domain\n");
      // The committed tracked symlink: `net/main.py -> <outside>/outsider.py`.
      writeFileSync(join(outside, "outsider.py"), "import os\n");
      mkdirSync(join(readRoot, "net"));
      symlinkSync(join(outside, "outsider.py"), join(readRoot, "net", "main.py"));
      const files = [
        "archkeep.json",
        "module-boundaries.config.mjs",
        "net/main.py",
        "libs/domain/go.mod",
        "libs/domain/doc.go",
      ];
      const streams = {
        ...nativeEnv(),
        cwd: readRoot,
        listFiles: () => files,
      };
      expect(await runCli(["check", "net", "--format", "json"], streams)).toBe(EXIT.error);
      const text = streams.lines.out.join("\n") + streams.lines.err.join("\n");
      expect(text).toContain("net/main.py");
      expect(text).toContain("could not be read");
    } finally {
      rmSync(readRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to read a symlinked archkeep.json that leaves the workspace as the model (G-10, model read)", async () => {
    // The G-10 class one level up: `check`'s native branch reads `archkeep.json`
    // as the workspace's OWN declaration — which projects exist, their tags,
    // the boundary law. A committed symlink `archkeep.json -> <outside>` handed
    // the outside model in as the workspace's declared facts, and the run had
    // no way to know it was judging against bytes this tree never committed:
    // verdict pass, exit 0 — byte-identical to a clean workspace. The CLI's
    // `readWorkspaceRoot` now applies the same containment rule as the analysis
    // reader, so a symlinked model is a loud "cannot load" failure (exit 3).
    const modelRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-g10-model-"));
    const outside = mkdtempSync(join(tmpdir(), "polyglot-cli-g10-model-outside-"));
    try {
      const writeModel = (relativePath, text) => {
        mkdirSync(join(modelRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(modelRoot, relativePath), text);
      };
      // The outside "model": a completely different workspace's declaration.
      writeFileSync(
        join(outside, "archkeep.json"),
        JSON.stringify({
          projects: {
            declared: [{ root: "attacker-lib", name: "attacker", tags: ["layer:domain"] }],
          },
          coverage: {
            exempt: [
              {
                path: "module-boundaries.config.mjs",
                reason: "workspace tooling config at the root, not itself a project",
              },
            ],
          },
        }),
      );
      writeModel(
        "module-boundaries.config.mjs",
        `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
      );
      // The committed tracked symlink: `archkeep.json -> <outside>/archkeep.json`.
      symlinkSync(join(outside, "archkeep.json"), join(modelRoot, "archkeep.json"));
      const files = ["archkeep.json", "module-boundaries.config.mjs"];
      const streams = {
        ...nativeEnv(),
        cwd: modelRoot,
        listFiles: () => files,
      };
      expect(await runCli(["check", "--format", "json"], streams)).toBe(EXIT.error);
      const text = streams.lines.out.join("\n") + streams.lines.err.join("\n");
      expect(text).toContain("archkeep.json");
      expect(text).toContain("cannot load");
    } finally {
      rmSync(modelRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked architecture-intent.json that leaves the workspace as the intent (G-10, intent read)", async () => {
    // The same G-10 class on the intent face: `check` reads a TRACKED root
    // `architecture-intent.json` as the workspace's intended architecture and
    // judges the observed graph against it. A committed symlink at that path
    // handed the OUTSIDE file's intent bytes in as the workspace's — before the
    // containment closure in `loadIntent`, a workspace with a symlinked intent
    // judged its architecture against bytes this tree never committed, and a
    // symlink resolving OUTSIDE was read as the tree's own intent. Now a
    // symlinked intent resolving outside the workspace is a loud no-verdict
    // (exit 3), never a silent verdict against the outside bytes.
    const intentRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-g10-intent-"));
    const outside = mkdtempSync(join(tmpdir(), "polyglot-cli-g10-intent-outside-"));
    try {
      const writeIntent = (relativePath, text) => {
        mkdirSync(join(intentRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(intentRoot, relativePath), text);
      };
      writeIntent(
        "archkeep.json",
        JSON.stringify({
          projects: { declared: [{ root: "libs/domain", name: "domain", tags: ["layer:domain"] }] },
          coverage: {
            exempt: [
              {
                path: "module-boundaries.config.mjs",
                reason: "workspace tooling config at the root, not itself a project",
              },
            ],
          },
        }),
      );
      writeIntent(
        "module-boundaries.config.mjs",
        `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
      );
      writeIntent("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
      writeIntent("libs/domain/doc.go", "package domain\n");
      // The committed tracked symlink: `architecture-intent.json -> <outside>`.
      // The OUTSIDE intent matches the observed graph (`domain`) with no
      // findings — read silently, it would render a clean intent verdict
      // (exit 0) from bytes this tree never committed: the silent direction.
      writeFileSync(
        join(outside, "intent.json"),
        JSON.stringify({
          version: "1",
          boundaries: [{ name: "domain", match: ["name:domain"] }],
        }),
      );
      symlinkSync(join(outside, "intent.json"), join(intentRoot, "architecture-intent.json"));
      const files = [
        "archkeep.json",
        "architecture-intent.json",
        "module-boundaries.config.mjs",
        "libs/domain/go.mod",
        "libs/domain/doc.go",
      ];
      const streams = {
        ...nativeEnv(),
        cwd: intentRoot,
        listFiles: () => files,
      };
      // A loud no-verdict — exit 3, naming the intent file — never a silent
      // clean verdict against the outside bytes (which would otherwise exit 0).
      expect(await runCli(["check", "--format", "json"], streams)).toBe(EXIT.error);
      const text = streams.lines.out.join("\n") + streams.lines.err.join("\n");
      expect(text).toContain("architecture-intent.json");
      expect(text).toContain("could not be established");
    } finally {
      rmSync(intentRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked nx.json that leaves the workspace as the registration (G-10, nx.json read)", async () => {
    // The same G-10 class on the Nx branch: `pluginIsRegistered`/`readPluginOptions`
    // read `nx.json` as the workspace's OWN registration — which plugin options
    // (boundaryConfig, tsConfig) apply. A committed symlink `nx.json ->
    // <outside>` handed the outside file in as that registration, so options
    // (and the boundary law they name) came from bytes this tree never
    // committed. The `readNxJsonOrNull` choke point now refuses with a loud
    // "cannot read" (exit 3), never a silent verdict against the outside file.
    const nxRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-g10-nx-"));
    const outside = mkdtempSync(join(tmpdir(), "polyglot-cli-g10-nx-outside-"));
    try {
      const writeNx = (relativePath, text) => {
        mkdirSync(join(nxRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(nxRoot, relativePath), text);
      };
      // The outside "registration": a different workspace's options.
      writeFileSync(
        join(outside, "nx.json"),
        JSON.stringify({ plugins: [{ plugin: "@ecoma-io/archkeep/nx", options: {} }] }),
      );
      writeNx(
        "module-boundaries.config.mjs",
        `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
      );
      // The committed tracked symlink: `nx.json -> <outside>/nx.json`.
      symlinkSync(join(outside, "nx.json"), join(nxRoot, "nx.json"));
      const files = ["nx.json", "module-boundaries.config.mjs"];
      const streams = {
        ...nativeEnv(),
        cwd: nxRoot,
        listFiles: () => files,
      };
      // Expect a loud refusal — either the command-context path (`pluginIsRegistered`)
      // or a later options read throws "cannot read nx.json".
      const exit = await runCli(["graph", "--format", "json"], streams);
      expect(exit).toBe(EXIT.error);
      const text = streams.lines.out.join("\n") + streams.lines.err.join("\n");
      expect(text).toContain("nx.json");
      expect(text).toContain("cannot read");
    } finally {
      rmSync(nxRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses --output targeting a boundary law renamed via archkeep.json (G-07)", async () => {
    // A native workspace whose `archkeep.json` names `law.mjs` as its boundary
    // config. Before `governanceOutputTargets` consulted `optionsForUsage`, the
    // guard only covered the DEFAULT name and the `--config` override, so
    // `archkeep graph --output law.mjs` silently replaced the renamed law with a
    // report, exit 0. New behavior: the ACTUAL law this run reads is guarded.
    const renameRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-g07-"));
    try {
      const writeRename = (relativePath, text) => {
        mkdirSync(join(renameRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(renameRoot, relativePath), text);
      };
      writeRename(
        "archkeep.json",
        JSON.stringify({
          projects: { declared: [{ root: "libs/domain", name: "domain", tags: ["layer:domain"] }] },
          boundaryConfig: "law.mjs",
          coverage: {
            exempt: [
              {
                path: "law.mjs",
                reason: "workspace tooling config at the root, not itself a project",
              },
            ],
          },
        }),
      );
      writeRename(
        "law.mjs",
        `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
      );
      writeRename("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
      writeRename("libs/domain/doc.go", "package domain\n");
      const files = ["archkeep.json", "law.mjs", "libs/domain/go.mod", "libs/domain/doc.go"];
      const streams = {
        ...nativeEnv(),
        cwd: renameRoot,
        listFiles: () => files,
      };
      const before = readFileSync(join(renameRoot, "law.mjs"), "utf8");
      const target = join(renameRoot, "law.mjs");
      expect(await runCli(["graph", "--format", "json", "--output", target], streams)).toBe(
        EXIT.error,
      );
      expect(streams.lines.err.join("\n")).toContain("resolves to 'law.mjs'");
      expect(readFileSync(join(renameRoot, "law.mjs"), "utf8")).toBe(before);
    } finally {
      rmSync(renameRoot, { recursive: true, force: true });
    }
  });

  it("still allows --output to a renamed law's target when the law is NOT the boundary config", async () => {
    // The G-07 guard must not widen into refusing every `law.mjs` in the tree —
    // only the ONE file this run reads as the boundary law is guarded. A
    // workspace with no declaration for `law.mjs` may write a report named that
    // way (the documented CI-reuse negative-space, extended to a renamed-law
    // shape).
    const freeRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-g07-free-"));
    try {
      const writeFree = (relativePath, text) => {
        mkdirSync(join(freeRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(freeRoot, relativePath), text);
      };
      writeFree(
        "archkeep.json",
        JSON.stringify({
          projects: { declared: [{ root: "libs/domain", name: "domain", tags: ["layer:domain"] }] },
          coverage: {
            exempt: [
              {
                path: "module-boundaries.config.mjs",
                reason: "workspace tooling config at the root, not itself a project",
              },
            ],
          },
        }),
      );
      writeFree(
        "module-boundaries.config.mjs",
        `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
      );
      writeFree("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
      writeFree("libs/domain/doc.go", "package domain\n");
      const files = [
        "archkeep.json",
        "module-boundaries.config.mjs",
        "libs/domain/go.mod",
        "libs/domain/doc.go",
      ];
      const streams = {
        ...nativeEnv(),
        cwd: freeRoot,
        listFiles: () => files,
      };
      const target = join(freeRoot, "law.mjs");
      expect(await runCli(["graph", "--format", "json", "--output", target], streams)).toBe(
        EXIT.ok,
      );
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(freeRoot, { recursive: true, force: true });
    }
  });

  it("refuses to capture a history snapshot through a workspace-internal symlinked dir (G-06)", async () => {
    // The `history --capture` writer runs the same containment check as
    // `--output` against the WORKSPACE root. A committed symlink
    // `.archkeep/history -> /tmp/out` makes `archkeep history .archkeep/history
    // --capture` the same runner-write escape as G-02 — refused loudly here,
    // never a snapshot landing outside the tree with a "history complete"
    // success line. The caller's own choice of an outside-in-string dir
    // (`--capture /var/archkeep/history`) is unchanged-by-design: that is a
    // user-supplied path, not a tree-committed symlink.
    const captureRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-g06-"));
    const outside = mkdtempSync(join(tmpdir(), "polyglot-cli-g06-outside-"));
    try {
      const writeCapture = (relativePath, text) => {
        mkdirSync(join(captureRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(captureRoot, relativePath), text);
      };
      writeCapture(
        "archkeep.json",
        JSON.stringify({
          projects: { declared: [{ root: "libs/domain", name: "domain", tags: ["layer:domain"] }] },
          coverage: {
            exempt: [
              {
                path: "module-boundaries.config.mjs",
                reason: "workspace tooling config at the root, not itself a project",
              },
            ],
          },
        }),
      );
      writeCapture(
        "module-boundaries.config.mjs",
        `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
      );
      writeCapture("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
      writeCapture("libs/domain/doc.go", "package domain\n");
      symlinkSync(outside, join(captureRoot, ".archkeep"));
      mkdirSync(join(outside, "history"), { recursive: true });
      const files = [
        "archkeep.json",
        "module-boundaries.config.mjs",
        ".archkeep",
        "libs/domain/go.mod",
        "libs/domain/doc.go",
      ];
      const streams = {
        ...nativeEnv(),
        cwd: captureRoot,
        listFiles: () => files,
      };
      expect(
        await runCli(["history", ".archkeep/history", "--capture", "--format", "json"], streams),
      ).toBe(EXIT.error);
      // The READ guard fires first now — `historyCommand` reads the dir before
      // it can write, and the read of a workspace-internal symlinked dir is
      // refused with the same loud exit 3 the write guard would have produced.
      // Either message names the same escape class; the read-side one is the
      // one that actually runs for `--capture`.
      expect(streams.lines.err.join("\n")).toContain("outside the workspace root");
      expect(streams.lines.err.join("\n")).toContain("cannot read the history directory");
      expect(readdirSync(join(outside, "history"))).toEqual([]);
    } finally {
      rmSync(captureRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("coverage.exempt is disclosed, not only enforced", () => {
  // `judgeCoverage` (`./providers/native/coverage.mjs`) always computed which
  // files a `coverage.exempt` row removed from `unclaimed` — the list existed
  // three layers deep and stopped there: `discover()` dropped it before
  // `check()` ever saw it, so an exempted file and a genuinely covered one
  // were byte-for-byte indistinguishable in the text report and in
  // `--format json`. A workspace could exempt an unbounded number of files,
  // forever, and nothing would ever say so. This block proves the count now
  // reaches both surfaces, without changing the exit code `coverage.exempt`
  // is meant to produce — the fixture below is otherwise clean, so exit 0 is
  // correct both before and after; what changes is whether the run says why
  // one of its two tracked files was never analyzed.
  const exemptRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-exempt-"));
  afterAll(() => rmSync(exemptRoot, { recursive: true, force: true }));

  const writeExempt = (relativePath, text) => {
    mkdirSync(join(exemptRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(exemptRoot, relativePath), text);
  };

  writeExempt(
    "archkeep.json",
    JSON.stringify({
      projects: { declared: [{ root: "libs/kept", name: "kept", tags: [] }] },
      // The boundary law's own config file sits at the workspace root, which
      // no declared project owns — exempted here too, or it would be a
      // second, unrelated unclaimed file this fixture never meant to test.
      coverage: {
        exempt: [
          { path: "module-boundaries.config.mjs", reason: "workspace tooling, not a project" },
          { path: "libs/vendored/**", reason: "vendored third-party, checked upstream" },
        ],
      },
    }),
  );
  writeExempt(
    "module-boundaries.config.mjs",
    `export const depConstraints = [];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeExempt("libs/kept/go.mod", "module example.com/kept\n\ngo 1.24\n");
  writeExempt("libs/kept/kept.go", "package kept\n");
  // Owned by no declared project, and would fail the run (exit 3, "not owned
  // by any project") without the exempt row above — this is the file the
  // exemption is legitimately for, not a fixture mistake.
  writeExempt("libs/vendored/vendored.go", "package vendored\n");

  const exemptContext = {
    cwd: exemptRoot,
    listFiles: () => [
      "archkeep.json",
      "module-boundaries.config.mjs",
      "libs/kept/go.mod",
      "libs/kept/kept.go",
      "libs/vendored/vendored.go",
    ],
  };

  it("names the exempted count on the summary line", async () => {
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      exemptContext,
    );
    expect(violations).toBe(0);
    expect(report).toContain("2 files exempted from coverage by archkeep.json's coverage.exempt");
  });

  it("carries the same note in the JSON envelope's coverage.notes", async () => {
    const { report } = await check({ format: "json", config: null, paths: [] }, exemptContext);
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("ok");
    expect(envelope.coverage.notes).toContain(
      "2 files exempted from coverage by archkeep.json's coverage.exempt",
    );
  });
});

describe("the unclaimed-file coverage hole, on the Nx and Moon providers too", () => {
  // P1-12: the native fixture above ("exits 3 over a file no declared project
  // owns, naming it") already proves native's own posture; this block proves
  // the Nx and Moon branches now reach the identical verdict over the
  // identical shape of tree, where they used to exit 0 with `coverage.complete:
  // true` — a tracked, analyzable file no declared project's root covers was
  // simply never selected for analysis, never counted, and never mentioned.
  // Each fixture is a small, self-contained tmpdir with one project and one
  // file sitting outside it — scoped to the declared project's own directory,
  // the same scoped-run rigor the native fixture's regression test applies,
  // so the orphan elsewhere in the tree cannot be hidden by naming a path
  // that excludes it.
  const permissiveBoundaryConfig = `export const depConstraints = [];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;

  it("exits 3 over a tracked Go file outside every declared Nx project, naming it — same posture as native", async () => {
    const nxRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-nx-unclaimed-"));
    try {
      const writeNx = (relativePath, text) => {
        mkdirSync(join(nxRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(nxRoot, relativePath), text);
      };
      writeNx("nx.json", "{}\n");
      writeNx("module-boundaries.config.mjs", permissiveBoundaryConfig);
      writeNx("libs/a/a.go", "package a\n");
      writeNx("libs/orphan/orphan.go", "package orphan\n");
      const graph = {
        nodes: { a: { name: "a", type: "lib", data: { root: "libs/a", tags: [] } } },
        dependencies: { a: [] },
      };
      const streams = {
        out: (t) => streams.lines.out.push(t),
        err: (t) => streams.lines.err.push(t),
        lines: { out: [], err: [] },
        cwd: nxRoot,
        readGraph: () => graph,
        listFiles: () => [
          "nx.json",
          "module-boundaries.config.mjs",
          "libs/a/a.go",
          "libs/orphan/orphan.go",
        ],
      };
      expect(await runCli(["check", "libs/a"], streams)).toBe(EXIT.error);
      const out = streams.lines.out.join("\n");
      expect(out).toContain("libs/orphan/orphan.go");
      expect(out).toContain("not owned by any project");
    } finally {
      rmSync(nxRoot, { recursive: true, force: true });
    }
  });

  it("exits 3 over a tracked Go file outside every declared Moon project, naming it — same posture as native", async () => {
    const moonRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-moon-unclaimed-"));
    try {
      const writeMoon = (relativePath, text) => {
        mkdirSync(join(moonRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(moonRoot, relativePath), text);
      };
      writeMoon(".moon/workspace.yml", "projects:\n  a: libs/a\n");
      writeMoon("module-boundaries.config.mjs", permissiveBoundaryConfig);
      writeMoon("libs/a/a.go", "package a\n");
      writeMoon("libs/orphan/orphan.go", "package orphan\n");
      const graph = {
        nodes: { a: { name: "a", type: "lib", data: { root: "libs/a", tags: [] } } },
        dependencies: { a: [] },
      };
      const streams = {
        out: (t) => streams.lines.out.push(t),
        err: (t) => streams.lines.err.push(t),
        lines: { out: [], err: [] },
        cwd: moonRoot,
        readGraph: () => graph,
        listFiles: () => [
          ".moon/workspace.yml",
          "module-boundaries.config.mjs",
          "libs/a/a.go",
          "libs/orphan/orphan.go",
        ],
      };
      expect(await runCli(["check", "libs/a"], streams)).toBe(EXIT.error);
      const out = streams.lines.out.join("\n");
      expect(out).toContain("libs/orphan/orphan.go");
      expect(out).toContain("not owned by any project");
    } finally {
      rmSync(moonRoot, { recursive: true, force: true });
    }
  });

  it("reports coverage.complete: false and status no-verdict in the JSON envelope over the Nx orphan, never status ok", async () => {
    // The JSON twin of the exit-code assertion above: a caller branching on
    // `coverage.complete` or `status` alone must see the same refusal a
    // caller branching on the exit code sees — this is the exact asymmetry
    // the finding names ("exit 3 under native and exit 0 with complete: true
    // under Nx and Moon").
    const nxRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-nx-unclaimed-json-"));
    try {
      const writeNx = (relativePath, text) => {
        mkdirSync(join(nxRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(nxRoot, relativePath), text);
      };
      writeNx("nx.json", "{}\n");
      writeNx("module-boundaries.config.mjs", permissiveBoundaryConfig);
      writeNx("libs/a/a.go", "package a\n");
      writeNx("libs/orphan/orphan.go", "package orphan\n");
      const graph = {
        nodes: { a: { name: "a", type: "lib", data: { root: "libs/a", tags: [] } } },
        dependencies: { a: [] },
      };
      const { report } = await check(
        { format: "json", config: null, paths: [] },
        {
          cwd: nxRoot,
          readGraph: () => graph,
          listFiles: () => [
            "nx.json",
            "module-boundaries.config.mjs",
            "libs/a/a.go",
            "libs/orphan/orphan.go",
          ],
        },
      );
      const envelope = JSON.parse(report);
      expect(envelope.status).toBe("no-verdict");
      expect(envelope.exitCode).toBe(3);
      expect(envelope.coverage.complete).toBe(false);
      expect(envelope.coverage.notAnalyzed).toEqual([
        {
          file: "libs/orphan/orphan.go",
          reason: expect.stringContaining("not owned by any project"),
        },
      ]);
      expect(envelope.decision.verdict).toBe("unknown");
    } finally {
      rmSync(nxRoot, { recursive: true, force: true });
    }
  });
});

describe("check judges a declared edge with no import site behind it", () => {
  // `evaluate()` iterates only import sites (`src/rules/README.md`: "analysis
  // records and the loaded config, nothing else"), so an `implicitDependencies`
  // edge — declared, never written as an import — reached no rule at all
  // before this fix: `check` reported a clean tree while `context`/`impact`
  // (walking `graph.dependencies` directly) already showed the same edge as a
  // tag violation. `domain` here declares `implicitDependencies: ["adapter"]`
  // and carries NO Go import of `adapter` anywhere — the fixture's only edge
  // is the declared one — so a violation only appears if `check` judges
  // declared edges at all.
  const declaredRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-declared-edge-"));
  afterAll(() => rmSync(declaredRoot, { recursive: true, force: true }));

  const writeDeclared = (relativePath, text) => {
    mkdirSync(join(declaredRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(declaredRoot, relativePath), text);
  };

  writeDeclared(
    "archkeep.json",
    JSON.stringify({
      projects: {
        declared: [
          {
            root: "libs/domain",
            name: "domain",
            tags: ["layer:domain"],
            implicitDependencies: ["adapter"],
          },
          { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
        ],
      },
      coverage: {
        exempt: [
          {
            path: "module-boundaries.config.mjs",
            reason: "workspace tooling config at the root, not itself a project",
          },
        ],
      },
    }),
  );
  writeDeclared(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeDeclared("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  // No import of adapter anywhere — the only edge this fixture has is the
  // `implicitDependencies` row above.
  writeDeclared("libs/domain/doc.go", "package domain\n");
  writeDeclared("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeDeclared("libs/adapter/adapter.go", "package adapter\n");

  const declaredContext = {
    cwd: declaredRoot,
    listFiles: () => [
      "archkeep.json",
      "module-boundaries.config.mjs",
      "libs/domain/go.mod",
      "libs/domain/doc.go",
      "libs/adapter/go.mod",
      "libs/adapter/adapter.go",
    ],
  };

  it("fails the run and names the declared edge, with no import-site violations", async () => {
    const { report, violations, declaredEdgeFindings } = await check(
      { format: "text", config: null, paths: [] },
      declaredContext,
    );
    // The silent-direction proof: evaluate()'s own import-site path finds
    // nothing (there is no import), yet the run still fails.
    expect(violations).toBe(0);
    expect(declaredEdgeFindings).toBe(1);
    expect(report).toContain("onlyTagsConstraintViolation");
    expect(report).toContain("domain → adapter");
    expect(report).toContain("declared-edge violations: 1 finding");
  });

  it("carries the finding in the JSON envelope's result.declaredEdges, exit 1", async () => {
    const { report } = await check({ format: "json", config: null, paths: [] }, declaredContext);
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("findings");
    expect(envelope.exitCode).toBe(EXIT.violations);
    expect(envelope.result.violations).toEqual([]);
    expect(envelope.result.declaredEdges.judged).toBe(1);
    expect(envelope.result.declaredEdges.findings).toHaveLength(1);
    expect(envelope.result.declaredEdges.findings[0]).toMatchObject({
      messageId: "onlyTagsConstraintViolation",
      source: "domain",
      target: "adapter",
      file: "archkeep.json",
    });
  });

  it("runCli exits 1 through the same real dispatch a CI pipeline uses", async () => {
    const out = [];
    const err = [];
    const env = { out: (t) => out.push(t), err: (t) => err.push(t), ...declaredContext };
    const exitCode = await runCli(["check"], env);
    expect(exitCode).toBe(EXIT.violations);
    expect(out.join("\n")).toContain("onlyTagsConstraintViolation");
  });
});

describe("check quotes an unresolved decisionRef loudly rather than as a confirmed authority (P1-02)", () => {
  // The audit's own reproduction: a depConstraints row's decisionRef names an
  // ADR id nothing records, `resolveDecisionRef`
  // (`./governance/adr-registry.mjs`) had zero production call sites, and a
  // live violation quoted the citation verbatim — exactly as if it were a
  // confirmed authority. `docs/adr/` here holds one REAL record, bound to a
  // DIFFERENT id, so the registry read this fixture drives is genuine (not
  // an ENOENT-to-empty-registry shortcut) and still answers "unknown" for
  // the row's own id.
  const decisionRefRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-decisionref-"));
  afterAll(() => rmSync(decisionRefRoot, { recursive: true, force: true }));

  const writeDecisionRef = (relativePath, text) => {
    mkdirSync(join(decisionRefRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(decisionRefRoot, relativePath), text);
  };

  // `loadAdrRegistry` reads this directory by a constant, so the fixture has
  // to use the same name. Held as a variable — the same reason the ADR
  // marker-resolution block above does — so no source line here spells a
  // `docs/adr/<id>.md` path whole: that reads to `check-docs-links` as this
  // file citing a decision record in THIS repository, on a path that
  // resolves nowhere. The fixture's tree is not this tree.
  const DECISIONREF_ADR_DIR = "docs/adr";
  const DECISIONREF_ADR_FILE = "0001-unrelated.md";

  writeDecisionRef(
    "archkeep.json",
    JSON.stringify({
      projects: {
        declared: [
          { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
          { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
        ],
      },
      coverage: {
        exempt: [
          {
            path: "module-boundaries.config.mjs",
            reason: "workspace tooling config at the root, not itself a project",
          },
        ],
      },
    }),
  );
  writeDecisionRef(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  {
    sourceTag: "layer:domain",
    onlyDependOnLibsWithTags: ["layer:domain"],
    decisionRef: "9999-does-not-exist",
  },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeDecisionRef("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeDecisionRef(
    "libs/domain/doc.go",
    'package domain\n\nimport "example.com/adapter"\n\nvar _ = adapter.Name\n',
  );
  writeDecisionRef("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeDecisionRef("libs/adapter/adapter.go", "package adapter\n\nvar Name string\n");
  // A real, valid ADR — proves the registry this fixture reads is genuine:
  // the row's citation still fails to resolve against it, because its id is
  // a different one.
  writeDecisionRef(
    `${DECISIONREF_ADR_DIR}/${DECISIONREF_ADR_FILE}`,
    "---\nid: 0001-unrelated\nstatus: accepted\n---\n\n# Unrelated decision\n",
  );

  const decisionRefContext = {
    cwd: decisionRefRoot,
    listFiles: () => [
      "archkeep.json",
      "module-boundaries.config.mjs",
      "libs/domain/go.mod",
      "libs/domain/doc.go",
      "libs/adapter/go.mod",
      "libs/adapter/adapter.go",
      `${DECISIONREF_ADR_DIR}/${DECISIONREF_ADR_FILE}`,
    ],
  };

  it("fires the real violation and flags the citation as UNRESOLVED, never as a confirmed authority", async () => {
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      decisionRefContext,
    );
    expect(violations).toBe(1);
    expect(report).toContain("onlyTagsConstraintViolation");
    expect(report).toContain("decisionRef [9999-does-not-exist]");
    expect(report).toContain("UNRESOLVED");
    expect(report).toContain("no matching ADR, rule, or fitness record");
  });

  it("carries the same fact in the JSON envelope, additively, without touching exit code or status", async () => {
    const { report } = await check({ format: "json", config: null, paths: [] }, decisionRefContext);
    const envelope = JSON.parse(report);
    // Findings still drive the exit code — an unresolved citation is a
    // documentation fact about the row, not a second reason to fail the run.
    expect(envelope.status).toBe("findings");
    expect(envelope.exitCode).toBe(EXIT.violations);
    expect(envelope.result.unresolvedDecisionRefs).toEqual(["9999-does-not-exist"]);
    // The row itself is untouched — a consumer already parsing
    // `result.violations[].constraint.decisionRef` sees the same raw value
    // it always did.
    expect(envelope.result.violations[0].constraint.decisionRef).toBe("9999-does-not-exist");
  });

  it("runCli still exits 1 through the same real dispatch a CI pipeline uses", async () => {
    const out = [];
    const err = [];
    const env = { out: (t) => out.push(t), err: (t) => err.push(t), ...decisionRefContext };
    const exitCode = await runCli(["check"], env);
    expect(exitCode).toBe(EXIT.violations);
    expect(out.join("\n")).toContain("UNRESOLVED");
  });
});

describe("the waivers surface, end to end", () => {
  // A third native tmpdir whose boundary law carries a `boundarySuppressions`
  // waiver row over the same layer-crossing import, so the whole pipeline is
  // exercised: the config validator accepts the extended row, `check` reports
  // the waived count, and `waivers` lists the surface with its term.
  const waiversRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-waivers-"));
  afterAll(() => rmSync(waiversRoot, { recursive: true, force: true }));

  const writeWaivers = (relativePath, text) => {
    mkdirSync(join(waiversRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(waiversRoot, relativePath), text);
  };

  writeWaivers(
    "archkeep.json",
    JSON.stringify({
      projects: {
        declared: [
          { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
          { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
        ],
      },
      // The root config file is workspace tooling, not a project — an
      // unclaimed file becomes a whole-file failure, and a command that
      // refuses incomplete coverage (waivers now among them) would otherwise
      // read this tree as "could not look". Same reason every native fixture
      // that asserts a completed verdict names its config here. The `--config`
      // test's `alt-boundaries.mjs` is NOT exempted: it is written mid-run and
      // never listed in the tracked files, so coverage never sees it — and an
      // exemption naming a file that exists in no unclaimed set is itself a
      // config error.
      coverage: {
        exempt: [
          {
            path: "module-boundaries.config.mjs",
            reason: "workspace tooling config at the root, not itself a project",
          },
        ],
      },
    }),
  );
  writeWaivers(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const boundarySuppressions = [
  {
    path: "libs/domain/doc.go",
    reason: "the adapter seam lands next release",
    expiresAt: "2999-01-01T00:00:00.000Z",
    origin: "ticket-42",
  },
];
`,
  );
  writeWaivers("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeWaivers(
    "libs/domain/doc.go",
    `package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
  );
  writeWaivers("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeWaivers("libs/adapter/adapter.go", "package adapter\n");

  const waiversFiles = [
    "archkeep.json",
    "module-boundaries.config.mjs",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
  ];

  const waiversContext = { cwd: waiversRoot, listFiles: () => waiversFiles };
  const waiversEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      ...waiversContext,
    };
  };

  it("waivers exits 0, lists the active waiver with its term and the violation it covers", async () => {
    const streams = waiversEnv();
    expect(await runCli(["waivers"], streams)).toBe(EXIT.ok);
    const text = streams.lines.out.join("\n");
    expect(text).toContain("1 waiver on the table");
    expect(text).toContain("libs/domain/doc.go");
    expect(text).toContain("1 current violation");
    expect(text).toContain("2999-01-01T00:00:00.000Z");
    expect(text).toContain("origin: ticket-42");
    expect(text).toContain("reason: the adapter seam lands next release");
  });

  it("waivers --format json writes the envelope with the term facts", async () => {
    const streams = waiversEnv();
    expect(await runCli(["waivers", "--format", "json"], streams)).toBe(EXIT.ok);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.command).toBe("waivers");
    expect(envelope.status).toBe("ok");
    expect(envelope.result.waivers).toHaveLength(1);
    expect(envelope.result.waivers[0].status).toBe("active");
    expect(envelope.result.waivers[0].expiresAt).toBe("2999-01-01T00:00:00.000Z");
  });

  it("waivers --config reads the law from the named file, resolving against cwd", async () => {
    // The waiver surface rides the boundary law, so `--config` must pick a
    // different law for one run exactly as it does for `check` — a flag the
    // same run's `check` would honour, kept in the loop by a flag test.
    writeWaivers(
      "alt-boundaries.mjs",
      `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const boundarySuppressions = [
  {
    path: "libs/domain/doc.go",
    reason: "a different row under a different law",
    expiresAt: "2999-02-02T00:00:00.000Z",
    origin: "ticket-43",
  },
];
`,
    );
    const streams = waiversEnv();
    expect(await runCli(["waivers", "--config", "alt-boundaries.mjs"], streams)).toBe(EXIT.ok);
    const text = streams.lines.out.join("\n");
    expect(text).toContain("a different row under a different law");
    expect(text).toContain("2999-02-02T00:00:00.000Z");
    expect(text).toContain("origin: ticket-43");
  });

  it("check still exits 1 over a waived violation — accepting must not flip 1→0", async () => {
    const streams = waiversEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    // The stdout report names the accepted violation and its term rather than
    // pretending the tree is clean.
    expect(streams.lines.out.join("\n")).toContain("accepted violations: 1 boundary violation");
    expect(streams.lines.out.join("\n")).toContain("accepted until 2999-01-01T00:00:00.000Z");
  });

  it("an expired waiver re-asserts the violation in check text/SARIF/JSON and surfaces expired in waivers", async () => {
    // The silent direction for a term: an expiry the calendar cannot hold is
    // rejected at config load (config.test.mjs), and a term that HAS lapsed
    // must not stay a waiver. Run the SAME tree under a boundary law whose row
    // term is already in the past (a distinct filename, so the module cache
    // loads the flip fresh — rewriting the existing file would re-import the
    // cached 2999 law) and require the violation to be live again everywhere a
    // developer could look, never silently re-accepted.
    writeWaivers(
      "past-boundaries.mjs",
      `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const boundarySuppressions = [
  {
    path: "libs/domain/doc.go",
    reason: "the adapter seam lands next release",
    expiresAt: "2020-01-01T00:00:00.000Z",
    origin: "ticket-42",
  },
];
`,
    );

    // `check` — the violation is a plain finding again, with the re-assert
    // evidence visible in the line a developer jumps to, and a non-zero exit.
    const checkStreams = waiversEnv();
    expect(await runCli(["check", "--config", "past-boundaries.mjs"], checkStreams)).toBe(
      EXIT.violations,
    );
    const checkText = checkStreams.lines.out.join("\n");
    expect(checkText).toContain("evidence   expired waiver");
    expect(checkText).not.toContain("accepted until");

    // SARIF — the same re-assert rides the same byte stream a SARIF uploader
    // reads, so an upload never silences an expired term.
    const sarifStreams = waiversEnv();
    expect(
      await runCli(["check", "--format", "sarif", "--config", "past-boundaries.mjs"], sarifStreams),
    ).toBe(EXIT.violations);
    const sarif = JSON.parse(sarifStreams.lines.out.join("\n"));
    const results = sarif.runs[0].results;
    expect(results).toHaveLength(1);
    expect(results[0].properties.evidence).toBe("expired waiver");

    // JSON — the envelope's failure carries the evidence too, the same object
    // the `--format json` consumers parse.
    const jsonStreams = waiversEnv();
    expect(
      await runCli(["check", "--format", "json", "--config", "past-boundaries.mjs"], jsonStreams),
    ).toBe(EXIT.violations);
    const envelope = JSON.parse(jsonStreams.lines.out.join("\n"));
    expect(envelope.result.violations).toHaveLength(1);
    expect(envelope.result.violations[0].evidence).toBe("expired waiver");
    expect(envelope.result.waived).toBeUndefined();

    // `waivers` — the same row is now reported as expired, not active: a term
    // that lapsed is surfaced loudly on the surface that used to accept it.
    const wvStreams = waiversEnv();
    expect(await runCli(["waivers", "--config", "past-boundaries.mjs"], wvStreams)).toBe(EXIT.ok);
    const wvText = wvStreams.lines.out.join("\n");
    expect(wvText).toContain("1 expired, 0 cover nothing right now");
    expect(wvText).toMatch(/expired \d+ms ago/);
  });

  it("waivers refuses a tree it could not fully read — exit 3, never a stale-looking surface", async () => {
    // The silent direction named in the coverage-refusal: a file the analyzer
    // never judged contributes no finding, so a waiver naming it would read as
    // "covers nothing" about a finding the run never looked at. `check` treats
    // the same tree as no-verdict (3); the waiver surface must do the same
    // rather than complete with "1 waiver on the table".
    const streams = {
      ...waiversEnv(),
      listFiles: () => [...waiversFiles, "libs/domain/absent.go"],
    };
    expect(await runCli(["waivers"], streams)).toBe(EXIT.error);
    expect(streams.lines.err.join("\n")).toContain("incomplete coverage");
  });
});

describe("context --plan, the agent architecture planning context, end to end", () => {
  // A native tree with the same two-project layer-crossing shape as the block
  // above PLUS a second, two-direction change, so the plan's whole-tree verdict
  // and scoped reporting can both be observed. `--plan` runs the real whole-tree
  // `analyzeWorkspace` + `evaluate` — nothing is injected, so the plan's
  // "violations are the full-workspace verdict" claim is the wiring under test.
  const planRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-plan-"));
  afterAll(() => rmSync(planRoot, { recursive: true, force: true }));

  const writePlan = (relativePath, text) => {
    mkdirSync(join(planRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(planRoot, relativePath), text);
  };

  writePlan(
    "archkeep.json",
    JSON.stringify({
      projects: {
        declared: [
          { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
          { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
          { root: "libs/util", name: "util", tags: ["layer:util"] },
        ],
      },
      coverage: {
        exempt: [
          {
            path: "module-boundaries.config.mjs",
            reason: "workspace tooling config at the root, not itself a project",
          },
        ],
      },
    }),
  );
  writePlan(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter", "layer:util"] },
  { sourceTag: "layer:util", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writePlan("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writePlan("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writePlan("libs/util/go.mod", "module example.com/util\n\ngo 1.24\n");
  writePlan("libs/adapter/adapter.go", "package adapter\n");
  writePlan("libs/util/util.go", "package util\n");
  // The crossing: domain imports adapter (forbidden — domain may only reach
  // domain). A change scoped to libs/adapter should NOT surface it for
  // reporting, even though the whole-tree verdict computes it.
  writePlan(
    "libs/domain/doc.go",
    `// Package domain.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
  );
  // A legitimate adapter → util edge, so the plan shows a real dependency edge
  // and a real impact list.
  writePlan(
    "libs/adapter/handler.go",
    `package adapter

import (
	"example.com/util"
)

var _ = util.Name
`,
  );

  const planFiles = [
    "archkeep.json",
    "module-boundaries.config.mjs",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
    "libs/adapter/handler.go",
    "libs/util/go.mod",
    "libs/util/util.go",
  ];

  const planContext = { cwd: planRoot, listFiles: () => planFiles };
  const planEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      ...planContext,
    };
  };

  it("reports a complete plan (exit 0) with the violation in scope when the target project is the violator", async () => {
    // A change to `domain` is in scope of the domain→adapter crossing, so the
    // plan must surface that violation — the whole-tree verdict, scoped for
    // reporting, agrees with what a full `check` would say.
    const streams = planEnv();
    expect(await runCli(["context", "domain", "--plan"], streams)).toBe(EXIT.ok);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("planning context complete");
    expect(out).toContain("Project  domain");
    expect(out).toContain("Violations (1 in scope of this change)");
    expect(out).toContain("libs/domain/doc.go");
  });

  it("scopes reporting away from a violation outside the change's projects", async () => {
    // A change to `util` scoped to libs/util touches a project with no
    // violating imports, so the plan shows 0 in-scope violations even though
    // the whole-tree verdict computed the domain crossing — the whole-graph
    // claim, narrowed only for reporting.
    const streams = planEnv();
    expect(await runCli(["context", "util", "--plan", "libs/util"], streams)).toBe(EXIT.ok);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("Project  util");
    expect(out).toContain("Violations (0 in scope of this change)");
    expect(out).not.toContain("libs/domain/doc.go");
  });

  it("shows impact: who depends on the target project", async () => {
    // adapter depends on util directly, and domain depends on adapter (even
    // though that edge is a violation) — so util's dependents are both direct
    // and transitive.
    const streams = planEnv();
    expect(await runCli(["context", "util", "--plan"], streams)).toBe(EXIT.ok);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("2 projects depend on it");
    expect(out).toContain("direct 1, transitive 1");
    expect(out).toContain("adapter");
  });

  it("scopes the change by trailing path: a path into libs/adapter limits the affected projects", async () => {
    // With a scope path pointing at libs/adapter, the affected-projects list
    // narrows to adapter, and the domain crossing (outside that scope) is not
    // reported.
    const streams = planEnv();
    expect(await runCli(["context", "util", "--plan", "libs/adapter"], streams)).toBe(EXIT.ok);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("affected projects  adapter");
    expect(out).not.toContain("libs/domain/doc.go");
  });

  it("is deterministic: two runs over the unchanged tree produce identical bytes", async () => {
    const first = planEnv();
    const second = planEnv();
    expect(await runCli(["context", "domain", "--plan", "--format", "json"], first)).toBe(EXIT.ok);
    expect(await runCli(["context", "domain", "--plan", "--format", "json"], second)).toBe(EXIT.ok);
    expect(first.lines.out.join("")).toBe(second.lines.out.join(""));
  });

  it("carries the plan under result.plan in the JSON envelope, with a variant marker", async () => {
    const streams = planEnv();
    expect(await runCli(["context", "domain", "--plan", "--format", "json"], streams)).toBe(
      EXIT.ok,
    );
    const envelope = JSON.parse(streams.lines.out.join(""));
    expect(envelope.command).toBe("context");
    expect(envelope.result.plan.variant).toBe("plan");
    // The plain context fields stay at top level (additive envelope).
    expect(envelope.result.project).toBe("domain");
    expect(envelope.result.tags).toEqual(["layer:domain"]);
    expect(envelope.result.constraints).toHaveLength(1);
    expect(envelope.result.dependencies).toBeDefined();
    // Planning sections present.
    expect(envelope.result.plan.architecture.projects.length).toBe(3);
    expect(envelope.result.plan.impact).toHaveLength(1);
    expect(envelope.result.plan.verify.length).toBeGreaterThanOrEqual(1);
    expect(envelope.result.plan.drift.goWork).toBeNull();
    expect(envelope.result.plan.drift.tsconfigPaths).toBeNull();
    expect(envelope.result.plan.policyFingerprint).toBeDefined();
  });

  it("reports the plan's drift and architecture in the text output", async () => {
    const streams = planEnv();
    expect(await runCli(["context", "domain", "--plan"], streams)).toBe(EXIT.ok);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("Drift");
    expect(out).toContain("go.work        not judged (no manifest to read)");
    expect(out).toContain("tsconfig paths not judged (no manifest to read)");
    expect(out).toContain("projects           3");
    expect(out).toContain("dependencies       ");
  });

  it("keeps the plain context path unchanged: --plan is strictly additive", async () => {
    // The plain `context` command must keep producing its own document even
    // though --plan now exists alongside it — the plan feature adds a new
    // renderer without corrupting the shared preamble that existed before.
    const plain = planEnv();
    expect(await runCli(["context", "domain"], plain)).toBe(EXIT.ok);
    const plainOut = plain.lines.out.join("");
    expect(plainOut).toContain("✔ context complete");
    expect(plainOut).toContain("Project  domain");
    expect(plainOut).toContain("Constraints (1 row matches):");
    // The plan renderer is a *different* document with its own header and its
    // own worded constraints section — not the plain document with sections
    // appended. Both live, neither replaces the other.
    const plans = planEnv();
    expect(await runCli(["context", "domain", "--plan"], plans)).toBe(EXIT.ok);
    const planOut = plans.lines.out.join("");
    expect(planOut).toContain("✔ planning context complete");
    expect(planOut).toContain("Project  domain");
  });

  it("folds the canonical architecture-intent verdict into result.plan when a tracked intent exists", async () => {
    // The phase-4 pact: context --plan must consume the SAME canonical intent
    // the drift/check commands share, not a parallel model. A tracked intent
    // that forbids the observed domain → adapter edge must surface as
    // plan.intent.verdict = "findings" with the file named — the empty-result
    // invariant applied to the planning document.
    writePlan(
      "architecture-intent.json",
      JSON.stringify({
        version: "1",
        boundaries: [
          { name: "domains", match: ["tag:layer:domain"] },
          { name: "adapters", match: ["tag:layer:adapter"] },
        ],
        forbidden: [
          {
            from: "domains",
            to: "adapters",
            reason: "adapter layers must stay below domain layers",
          },
        ],
      }),
    );
    const tracked = [...planFiles, "architecture-intent.json"];
    const streams = planEnv();
    streams.listFiles = () => tracked;
    expect(await runCli(["context", "domain", "--plan", "--format", "json"], streams)).toBe(
      EXIT.ok,
    );
    const envelope = JSON.parse(streams.lines.out.join(""));
    expect(envelope.result.plan.intent.verified).toBe(true);
    expect(envelope.result.plan.intent.file).toBe("architecture-intent.json");
    expect(envelope.result.plan.intent.verdict).toBe("findings");
    const edge = envelope.result.plan.intent.findings.find(
      (f) => f.source === "domain" && f.target === "adapter",
    );
    expect(edge).toBeDefined();
    // The text report states the verdict, so a reader of the terminal sees the
    // same contract as the JSON consumer.
    const text = planEnv();
    text.listFiles = () => tracked;
    expect(await runCli(["context", "domain", "--plan"], text)).toBe(EXIT.ok);
    expect(text.lines.out.join("")).toContain("Intent (verified)");
    expect(text.lines.out.join("")).toContain("1 finding");
  });
});

describe("the .json boundaryConfig dialect, end to end through the native provider", () => {
  // A third, independent tmpdir: same two-project layer-crossing shape as the
  // native `archkeep.json` block above, but `boundaryConfig` names a `.json`
  // file instead of `.mjs` — unlike `.mjs`, `.json` is not an analyzable
  // extension (`LANGUAGE_BY_EXTENSION` in `../src/analysis/registry.mjs`), so
  // this fixture needs no coverage waiver for its own policy file.
  const jsonRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-json-"));
  afterAll(() => rmSync(jsonRoot, { recursive: true, force: true }));

  const writeJson = (relativePath, text) => {
    mkdirSync(join(jsonRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(jsonRoot, relativePath), text);
  };

  const wellFormedPolicy = () => ({
    depConstraints: [
      { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
      { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
    ],
    moduleBoundaryOptions: {
      allow: [],
      buildTargets: ["build"],
      enforceBuildableLibDependency: false,
      allowCircularSelfDependency: false,
      checkDynamicDependenciesExceptions: [],
      ignoredCircularDependencies: [],
      banTransitiveDependencies: false,
      checkNestedExternalImports: false,
    },
  });

  writeJson(
    "archkeep.json",
    JSON.stringify({
      boundaryConfig: "policy.json",
      projects: {
        declared: [
          { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
          { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
        ],
      },
    }),
  );
  writeJson("policy.json", JSON.stringify(wellFormedPolicy()));
  writeJson("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeJson("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeJson("libs/adapter/adapter.go", "package adapter\n");
  // Same crossing as the `.mjs`-dialect native fixture above, so the two
  // blocks prove the same rule fires whichever dialect wrote the policy.
  writeJson(
    "libs/domain/doc.go",
    `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
  );

  const jsonFiles = [
    "archkeep.json",
    "policy.json",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
  ];
  const jsonContext = { cwd: jsonRoot, listFiles: () => jsonFiles };
  const jsonEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      ...jsonContext,
    };
  };

  it("finds the same layer-crossing Go import through a .json policy file as the .mjs dialect finds", async () => {
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      jsonContext,
    );
    expect(violations).toBe(1);
    expect(report).toContain("libs/domain/doc.go:5:2  onlyTagsConstraintViolation");
  });

  // The red-direction case: an empty constraint table is well-formed, and the
  // report must still state what it inspected — a missing coverage line here
  // would be indistinguishable from a run that silently checked nothing.
  it("still states what it inspected when the .json policy's constraint table is empty", async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-json-empty-"));
    try {
      const writeEmpty = (relativePath, text) => {
        mkdirSync(join(emptyRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(emptyRoot, relativePath), text);
      };
      writeEmpty(
        "archkeep.json",
        JSON.stringify({
          boundaryConfig: "policy.json",
          projects: { declared: [{ root: "libs/only", name: "only", tags: [] }] },
        }),
      );
      writeEmpty("policy.json", JSON.stringify({ ...wellFormedPolicy(), depConstraints: [] }));
      writeEmpty("libs/only/go.mod", "module example.com/only\n\ngo 1.24\n");
      writeEmpty("libs/only/doc.go", "package only\n");
      const streams = {
        ...jsonEnv(),
        cwd: emptyRoot,
        listFiles: () => ["archkeep.json", "policy.json", "libs/only/go.mod", "libs/only/doc.go"],
      };
      expect(await runCli(["check"], streams)).toBe(EXIT.ok);
      expect(streams.lines.out.join("\n")).toContain(
        "✔ no boundary violations (0 imports in 1 file across 1 project)",
      );
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("reads a --config pointed at a .json file, relative to cwd", async () => {
    const streams = jsonEnv();
    expect(await runCli(["check", "--config", "policy.json"], streams)).toBe(EXIT.violations);
    expect(streams.lines.out.join("\n")).toContain(
      "libs/domain/doc.go:5:2  onlyTagsConstraintViolation",
    );
  });

  it("reads a --config pointed at a .json file by absolute path", async () => {
    const streams = jsonEnv();
    expect(await runCli(["check", "--config", join(jsonRoot, "policy.json")], streams)).toBe(
      EXIT.violations,
    );
    expect(streams.lines.out.join("\n")).toContain(
      "libs/domain/doc.go:5:2  onlyTagsConstraintViolation",
    );
  });

  it("exits 3 and names the key when a --config .json file carries an unrecognised top-level key", async () => {
    const badRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-json-bad-key-"));
    try {
      const writeBad = (relativePath, text) => {
        mkdirSync(join(badRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(badRoot, relativePath), text);
      };
      writeBad(
        "archkeep.json",
        JSON.stringify({ projects: { declared: [{ root: "libs/only", name: "only", tags: [] }] } }),
      );
      writeBad("bad.json", JSON.stringify({ ...wellFormedPolicy(), depConstraint: [] }));
      writeBad("libs/only/go.mod", "module example.com/only\n\ngo 1.24\n");
      const streams = {
        ...jsonEnv(),
        cwd: badRoot,
        listFiles: () => ["archkeep.json", "bad.json", "libs/only/go.mod"],
      };
      expect(await runCli(["check", "--config", "bad.json"], streams)).toBe(EXIT.error);
      expect(streams.lines.err.join("\n")).toContain(
        "depConstraint: not a recognised top-level key",
      );
    } finally {
      rmSync(badRoot, { recursive: true, force: true });
    }
  });
});

describe("an Nx-tree workspace with a .json boundaryConfig, driven through the CLI", () => {
  // Everything above named ".json boundaryConfig" so far runs it through
  // `nativeProvider` — a workspace with no `nx.json` at all. `readPluginOptions`
  // (`../src/options.mjs`) is the OTHER route to a `boundaryConfig` filename,
  // reached only from a real `nx.json` on disk (`check()`'s non-native branch
  // reads it directly, never injected), so this fixture needs a real one —
  // `env()`/`context` above inject `readGraph` instead of an `nx` binary, but
  // `nx.json` itself still has to exist for `readPluginOptions` to find the
  // plugin's `options.boundaryConfig` entry at all. This is the case
  // `boundary-config.mjs`'s extension dispatch (the LSP face) and
  // `loadBoundaryConfigFile`'s (the CLI/Nx face) both exist to reach, and
  // until this test existed neither an Nx tree's `.json` verdict nor its
  // report text was pinned anywhere — only the native path's was.
  const nxJsonRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-nx-json-"));
  afterAll(() => rmSync(nxJsonRoot, { recursive: true, force: true }));

  const writeNxJson = (relativePath, text) => {
    mkdirSync(join(nxJsonRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(nxJsonRoot, relativePath), text);
  };

  writeNxJson(
    "nx.json",
    JSON.stringify({
      plugins: [{ plugin: "@ecoma-io/archkeep/nx", options: { boundaryConfig: "policy.json" } }],
    }),
  );
  writeNxJson(
    "policy.json",
    JSON.stringify({
      depConstraints: [
        { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
        {
          sourceTag: "layer:adapter",
          onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"],
        },
      ],
      moduleBoundaryOptions: {
        allow: [],
        buildTargets: ["build"],
        enforceBuildableLibDependency: false,
        allowCircularSelfDependency: false,
        checkDynamicDependenciesExceptions: [],
        ignoredCircularDependencies: [],
        banTransitiveDependencies: false,
        checkNestedExternalImports: false,
      },
    }),
  );
  writeNxJson("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeNxJson("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeNxJson("libs/adapter/adapter.go", "package adapter\n");
  // Same crossing as the top fixture's `.mjs` config, so the two prove the
  // same rule fires whichever dialect the workspace's `nx.json` names.
  writeNxJson(
    "libs/domain/doc.go",
    `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
  );

  const nxJsonGraph = {
    nodes: {
      domain: {
        name: "domain",
        type: "lib",
        data: { root: "libs/domain", tags: ["layer:domain"] },
      },
      adapter: {
        name: "adapter",
        type: "lib",
        data: { root: "libs/adapter", tags: ["layer:adapter"] },
      },
    },
    dependencies: { domain: [], adapter: [] },
  };
  const nxJsonFiles = [
    "nx.json",
    "policy.json",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
  ];
  const nxJsonContext = {
    cwd: nxJsonRoot,
    readGraph: () => nxJsonGraph,
    listFiles: () => nxJsonFiles,
  };

  it("pins the verdict, not just the exit code: same violation, same position, same message as the .mjs dialect", async () => {
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      nxJsonContext,
    );
    expect(violations).toBe(1);
    expect(report).toContain("libs/domain/doc.go:5:2  onlyTagsConstraintViolation");
    expect(report).toContain(
      'A project tagged with "layer:domain" can only depend on libs tagged with "layer:domain"',
    );
    expect(report).toContain('import      "example.com/adapter" (static)  domain → adapter');
  });
});

describe("boundaryConfig as an inline policy object in archkeep.json, end to end", () => {
  const wellFormedPolicy = () => ({
    depConstraints: [
      { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
      { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
    ],
    moduleBoundaryOptions: {
      allow: [],
      buildTargets: ["build"],
      enforceBuildableLibDependency: false,
      allowCircularSelfDependency: false,
      checkDynamicDependenciesExceptions: [],
      ignoredCircularDependencies: [],
      banTransitiveDependencies: false,
      checkNestedExternalImports: false,
    },
  });

  /** Builds a fresh tmpdir workspace carrying the given inline `boundaryConfig` value. */
  const buildInlineWorkspace = (boundaryConfig) => {
    const inlineRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-inline-"));
    const writeInline = (relativePath, text) => {
      mkdirSync(join(inlineRoot, relativePath, ".."), { recursive: true });
      writeFileSync(join(inlineRoot, relativePath), text);
    };
    writeInline(
      "archkeep.json",
      JSON.stringify({
        boundaryConfig,
        projects: {
          declared: [
            { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
            { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
          ],
        },
      }),
    );
    writeInline("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
    writeInline("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
    writeInline("libs/adapter/adapter.go", "package adapter\n");
    writeInline(
      "libs/domain/doc.go",
      `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
    );
    const files = [
      "archkeep.json",
      "libs/domain/go.mod",
      "libs/domain/doc.go",
      "libs/adapter/go.mod",
      "libs/adapter/adapter.go",
    ];
    const out = [];
    const err = [];
    return {
      root: inlineRoot,
      streams: {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        lines: { out, err },
        cwd: inlineRoot,
        listFiles: () => files,
      },
    };
  };

  it("finds a real violation from a policy inlined in archkeep.json, with no separate config file at all", async () => {
    const { root: inlineRoot, streams } = buildInlineWorkspace(wellFormedPolicy());
    try {
      expect(await runCli(["check"], streams)).toBe(EXIT.violations);
      expect(streams.lines.out.join("\n")).toContain(
        "libs/domain/doc.go:5:2  onlyTagsConstraintViolation",
      );
    } finally {
      rmSync(inlineRoot, { recursive: true, force: true });
    }
  });

  it("exits 3 and names the offending row when an inline policy's constraint table is malformed", async () => {
    const policy = {
      ...wellFormedPolicy(),
      depConstraints: [{ onlyDependOnLibsWithTags: ["layer:domain"] }],
    };
    const { root: inlineRoot, streams } = buildInlineWorkspace(policy);
    try {
      expect(await runCli(["check"], streams)).toBe(EXIT.error);
      expect(streams.lines.err.join("\n")).toContain("boundaryConfig.depConstraints[0]");
    } finally {
      rmSync(inlineRoot, { recursive: true, force: true });
    }
  });

  it("exits 3 with the exact message when boundaryConfig is neither a string nor an object", async () => {
    const { root: inlineRoot, streams } = buildInlineWorkspace(42);
    try {
      expect(await runCli(["check"], streams)).toBe(EXIT.error);
      expect(streams.lines.err.join("\n")).toContain(
        "boundaryConfig: must be a string (a filename) or an object (an inline policy), got number (42)",
      );
    } finally {
      rmSync(inlineRoot, { recursive: true, force: true });
    }
  });
});

describe("an inline boundaryConfig's policy fingerprint survives graph into history (P1-25)", () => {
  // `runGraph`'s own copy of the file/inline config-resolution ladder stopped
  // at the file-string arm: a native workspace's INLINE `boundaryConfig` fell
  // through to `null`, so `graph --output` never wrote a `result.policy`
  // fingerprint for one — unlike every other command's copy of this ladder
  // (`diff`, `history --capture`, `check`, ...), which all carry the third
  // "inline object" arm alongside the "file string" one. Two such fingerprint-less
  // snapshots, captured on either side of a real inline-policy edit, carried
  // the same "no policy" identity, so `history` classified the transition
  // "unchanged" and reported "no architectural change recorded" — silently,
  // exactly as if the law had never moved. The same edit made to a
  // FILE-named `boundaryConfig` was already reported correctly, because that
  // copy of the ladder was never missing the arm.
  const policyWith = (banTransitiveDependencies) => ({
    depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
    moduleBoundaryOptions: {
      allow: [],
      buildTargets: ["build"],
      enforceBuildableLibDependency: false,
      allowCircularSelfDependency: false,
      checkDynamicDependenciesExceptions: [],
      ignoredCircularDependencies: [],
      banTransitiveDependencies,
      checkNestedExternalImports: false,
    },
  });

  const trackedFiles = [
    "archkeep.json",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
  ];

  /** Builds a fresh tmpdir native workspace carrying the given inline policy. */
  const buildRoot = (boundaryConfig) => {
    const root = mkdtempSync(join(tmpdir(), "polyglot-cli-inline-policy-history-"));
    const write = (relativePath, text) => {
      mkdirSync(join(root, relativePath, ".."), { recursive: true });
      writeFileSync(join(root, relativePath), text);
    };
    write(
      "archkeep.json",
      JSON.stringify({
        boundaryConfig,
        projects: {
          declared: [
            { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
            { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
          ],
        },
      }),
    );
    write("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
    write("libs/domain/doc.go", "package domain\n");
    write("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
    write("libs/adapter/adapter.go", "package adapter\n");
    return root;
  };

  /** A fresh stream pair per call, so one call's captured output never bleeds into another's assertions. */
  const streamsFor = (root) => {
    const out = [];
    const err = [];
    return {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      cwd: root,
      listFiles: () => trackedFiles,
    };
  };

  it("graph --output carries a policy.fingerprint for an inline boundaryConfig, the same as a file-named one", async () => {
    const root = buildRoot(policyWith(false));
    const histDir = mkdtempSync(join(tmpdir(), "polyglot-cli-inline-policy-history-dir-"));
    try {
      const snapshotPath = join(histDir, "0001-baseline.json");
      expect(
        await runCli(["graph", "--format", "json", "--output", snapshotPath], streamsFor(root)),
      ).toBe(EXIT.ok);
      const envelope = JSON.parse(readFileSync(snapshotPath, "utf8"));
      expect(envelope.result.policy).toBeDefined();
      expect(typeof envelope.result.policy.fingerprint).toBe("string");
      expect(envelope.result.policy.fingerprint.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(histDir, { recursive: true, force: true });
    }
  });

  it("history reports a policy change across two inline-boundaryConfig graph snapshots, instead of silently claiming none", async () => {
    const root = buildRoot(policyWith(false));
    const histDir = mkdtempSync(join(tmpdir(), "polyglot-cli-inline-policy-history-dir-"));
    try {
      expect(
        await runCli(
          ["graph", "--format", "json", "--output", join(histDir, "0001-baseline.json")],
          streamsFor(root),
        ),
      ).toBe(EXIT.ok);

      // A real architectural-law edit: the graph (projects, edges) does not
      // move, only the policy — `banTransitiveDependencies` flips from false
      // to true. No project or edge is added, removed, or retagged.
      writeFileSync(
        join(root, "archkeep.json"),
        JSON.stringify({
          boundaryConfig: policyWith(true),
          projects: {
            declared: [
              { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
              { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
            ],
          },
        }),
      );

      expect(
        await runCli(
          ["graph", "--format", "json", "--output", join(histDir, "0002-head.json")],
          streamsFor(root),
        ),
      ).toBe(EXIT.ok);

      // The JSON record: the structured signal a consumer's tooling reads.
      const jsonStreams = streamsFor(root);
      expect(await runCli(["history", histDir, "--format", "json"], jsonStreams)).toBe(EXIT.ok);
      const record = JSON.parse(jsonStreams.lines.out.join("\n"));
      const [transition] = record.result.transitions;
      // The silent-direction assertion: before the fix this is `null` — both
      // snapshots carry no fingerprint at all, so the comparison could not be
      // made, which is indistinguishable from a workspace that never captured
      // a policy in the first place.
      expect(transition.policyChanged).toBe(true);
      expect(transition.architectureChanged).toBe(false);

      // The terminal report: the exact human-facing claim the audit measured.
      // Before the fix this reads "✔ no architectural change recorded across
      // the snapshots" with no policy signal at all — byte-for-byte what an
      // unedited workspace would print.
      const textStreams = streamsFor(root);
      expect(await runCli(["history", histDir], textStreams)).toBe(EXIT.ok);
      const report = textStreams.lines.out.join("\n");
      expect(report).toContain(
        "policy (the declared architectural intent) changed between these snapshots",
      );
      expect(report).toContain(
        "✔ no architectural change recorded across the snapshots (only policy, provider, or drift signals)",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(histDir, { recursive: true, force: true });
    }
  });
});

describe("a profile is resolved by every command that reads a boundary law, not just check (P1-26, P1-17)", () => {
  // `check`'s own copy of the file/inline/profile config-resolution ladder
  // has always recognised a `profiles` plugin option: `hasProfiles` routes
  // `--config`/`boundaryConfig` through the registry as a profile NAME
  // instead of a filename. Every other command's copy did not — it fell
  // straight to `loadBoundaryConfig(root, "<profile-name>")`, which builds a
  // path like `<root>/strict`, finds no `.mjs`/`.js`/`.json` extension, and
  // refuses with "names an unsupported boundaryConfig extension '(none)'" —
  // a message that blames a typo nobody made, because the real problem is
  // that command never learned profiles exist. `graph` and `diff` failing
  // this way is the same root cause as a separate finding (P1-17): a
  // profile workspace could not produce a graph snapshot with a policy
  // fingerprint, and `diff` could not compare one against a later run.
  //
  // Now that all 11 copies call the one `resolvePolicy` in `cli.mjs`, this
  // block drives ten of the previously-broken ones — every one this repo's
  // own `docs/concepts/profiles.md` used to name as "cannot see the
  // profile-resolved law" — over a single shared, read-only fixture, plus a
  // dedicated one for the fingerprint-change scenario below (mutated
  // mid-test, so it stays out of the shared fixture the way P1-25's own
  // `buildRoot` pattern keeps a mutation from bleeding into other cases).
  const profRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-profiles-"));
  afterAll(() => rmSync(profRoot, { recursive: true, force: true }));

  const writeProf = (relativePath, text) => {
    mkdirSync(join(profRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(profRoot, relativePath), text);
  };

  writeProf(
    "nx.json",
    JSON.stringify({
      plugins: [
        {
          plugin: "@ecoma-io/archkeep/nx",
          options: { boundaryConfig: "strict", profiles: "law-profiles.json" },
        },
      ],
    }),
  );
  writeProf(
    "law-profiles.json",
    JSON.stringify({
      version: 1,
      profiles: [
        {
          name: "strict",
          block: {
            depConstraints: [
              { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
            ],
            moduleBoundaryOptions: {
              allow: [],
              buildTargets: ["build"],
              enforceBuildableLibDependency: false,
              allowCircularSelfDependency: false,
              checkDynamicDependenciesExceptions: [],
              ignoredCircularDependencies: [],
              banTransitiveDependencies: false,
              checkNestedExternalImports: false,
            },
            // Gives `waivers` a real row to list, proving the profile's
            // `boundarySuppressions` — not only its `depConstraints` — reach
            // the command through the shared resolver.
            boundarySuppressions: [
              {
                path: "libs/domain/doc.go",
                reason: "the adapter seam lands next release",
                expiresAt: "2999-01-01T00:00:00.000Z",
                origin: "ticket-91",
              },
            ],
          },
        },
      ],
    }),
  );
  writeProf("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeProf(
    "libs/domain/doc.go",
    `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
  );
  writeProf("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeProf("libs/adapter/adapter.go", "package adapter\n");

  const profGraph = {
    nodes: {
      domain: {
        name: "domain",
        type: "lib",
        data: { root: "libs/domain", tags: ["layer:domain"] },
      },
      adapter: {
        name: "adapter",
        type: "lib",
        data: { root: "libs/adapter", tags: ["layer:adapter"] },
      },
    },
    dependencies: {
      domain: [
        { source: "domain", target: "adapter", sourceFile: "libs/domain/doc.go", type: "static" },
      ],
      adapter: [],
    },
  };
  const profFiles = [
    "nx.json",
    "law-profiles.json",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
  ];
  const profEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      cwd: profRoot,
      readGraph: () => profGraph,
      listFiles: () => profFiles,
    };
  };

  // The exact wrong-reason message every one of the ten sites used to fail
  // with — its absence is the direct assertion that this call site now
  // recognises `profiles` at all, independent of whatever its own legitimate
  // verdict turns out to be.
  const WRONG_REASON = "unsupported boundaryConfig extension";

  /**
   * A workspace whose plugin options select a profile NAME the registry does
   * not contain, as its DEFAULT (`boundaryConfig`) — the shape `graph` (which
   * takes no `--config`) is forced to fail by. Committed to a throwaway git
   * repo so the commitless-noise guards are not what the test sees.
   * Returns the root; the caller removes it.
   */
  const writeGap1UnknownProfileRoot = () => {
    const gapRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-profiles-unknown-"));
    writeGap1Files(gapRoot, {
      version: 1,
      profiles: [
        {
          name: "strict",
          block: {
            depConstraints: [],
            moduleBoundaryOptions: withAllBoundaryOptions({}),
          },
        },
      ],
    });
    return gapRoot;
  };

  /**
   * A workspace whose registry declares two profiles that base on each other —
   * `a` on `b` on `a` — so any profile-selected command refuses by name.
   * Returns the root; the caller removes it.
   */
  const writeGap1CycleRoot = () => {
    const cycleRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-profiles-cycle-"));
    // `a` exists and IS the selected profile, so its cycle is what refuses —
    // a registry whose cycle hides behind a name no one asked for would read
    // as "profile not found" and never exercise the cycle arm.
    writeGap1Files(
      cycleRoot,
      {
        version: 1,
        profiles: [
          {
            name: "a",
            base: "b",
            block: {
              depConstraints: [],
              moduleBoundaryOptions: withAllBoundaryOptions({}),
            },
          },
          {
            name: "b",
            base: "a",
            block: {
              depConstraints: [],
              moduleBoundaryOptions: withAllBoundaryOptions({}),
            },
          },
        ],
      },
      "a",
    );
    return cycleRoot;
  };

  const withAllBoundaryOptions = (overrides) => ({
    allow: [],
    buildTargets: ["build"],
    enforceBuildableLibDependency: false,
    allowCircularSelfDependency: false,
    checkDynamicDependenciesExceptions: [],
    ignoredCircularDependencies: [],
    banTransitiveDependencies: false,
    checkNestedExternalImports: false,
    ...overrides,
  });

  const writeGap1Files = (gapRoot, registry, profileName = "no-such-profile") => {
    const gapWrite = (relativePath, text) => {
      mkdirSync(join(gapRoot, relativePath, ".."), { recursive: true });
      writeFileSync(join(gapRoot, relativePath), text);
    };
    gapWrite(
      "nx.json",
      JSON.stringify({
        plugins: [
          {
            plugin: "@ecoma-io/archkeep/nx",
            options: { boundaryConfig: profileName, profiles: "law-profiles.json" },
          },
        ],
      }),
    );
    gapWrite("law-profiles.json", JSON.stringify(registry));
  };

  it("check already resolved the named profile before this fix, and still does through the shared resolver", async () => {
    const streams = profEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    expect(streams.lines.out.join("\n")).toContain(
      "accepted violations: 1 boundary violation waived",
    );
  });

  it("check exits 3 on a profile name the registry does not contain, naming the profile", async () => {
    // The unit-level refusal (`resolveProfile` throwing) is only half the
    // contract the audit asked for: at the CLI, selecting a nonexistent
    // profile must be a could-not-look (exit 3) that names WHICH profile was
    // asked for — not a generic "could not load config" that hides the real
    // cause. Red direction: if the ladder regressed to resolve the name as a
    // bare file path, this exits 3 with the wrong message
    // (`WRONG_REASON`), which this assertion forbids.
    const streams = profEnv();
    expect(await runCli(["check", "--config", "no-such-profile"], streams)).toBe(EXIT.error);
    const errText = streams.lines.err.join("\n");
    expect(errText).not.toContain(WRONG_REASON);
    expect(errText).toContain('profile "no-such-profile" does not exist');
  });

  it("graph exits 3 on a profile name the registry does not contain, naming the profile", async () => {
    // `graph` takes no `--config` (`GRAPH_FLAG_HELP`), so the failing name is
    // the workspace's own `boundaryConfig` option — the same "profile as a
    // name, not a file" state the command must refuse by name.
    const gapRoot = writeGap1UnknownProfileRoot();
    try {
      const streams = profEnv();
      streams.cwd = gapRoot;
      expect(await runCli(["graph", "--format", "json"], streams)).toBe(EXIT.error);
      const text = streams.lines.out.join("\n") + streams.lines.err.join("\n");
      expect(text).not.toContain(WRONG_REASON);
      expect(text).toContain('profile "no-such-profile" does not exist');
    } finally {
      rmSync(gapRoot, { recursive: true, force: true });
    }
  });

  it("a profiles registry whose base chain cycles is refused by name at every profile-selected command (exit 3)", async () => {
    // The base-cycle half of "a profile selected by name must resolve":
    // `resolveProfile` throws on a cycle, and the loader surfaces it as a
    // malformed-registry refusal that names the cycle. Red direction: read as
    // "no base" the stack would shed inherited rows and the run would look
    // clean.
    const cycleRoot = writeGap1CycleRoot();
    try {
      const out = [];
      const err = [];
      const streams = {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        lines: { out, err },
        cwd: cycleRoot,
        readGraph: () => ({ nodes: {}, dependencies: {} }),
        listFiles: () => ["nx.json", "law-profiles.json"],
      };
      expect(await runCli(["check"], streams)).toBe(EXIT.error);
      const text = streams.lines.out.join("\n") + streams.lines.err.join("\n");
      expect(text).toContain("base chain contains a cycle");
    } finally {
      rmSync(cycleRoot, { recursive: true, force: true });
    }
  });

  it("graph resolves the profile and carries a policy fingerprint (P1-17)", async () => {
    const streams = profEnv();
    expect(await runCli(["graph", "--format", "json"], streams)).toBe(EXIT.ok);
    expect(streams.lines.err.join("\n")).not.toContain(WRONG_REASON);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.result.policy).toBeDefined();
    expect(typeof envelope.result.policy.fingerprint).toBe("string");
    expect(envelope.result.policy.fingerprint.length).toBeGreaterThan(0);
  });

  it("waivers resolves the profile's boundarySuppressions, not only check's own copy of the ladder", async () => {
    const streams = profEnv();
    expect(await runCli(["waivers"], streams)).toBe(EXIT.ok);
    const text = streams.lines.out.join("\n");
    expect(text).not.toContain(WRONG_REASON);
    expect(text).toContain("1 waiver on the table");
    expect(text).toContain("origin: ticket-91");
  });

  it("fitness reaches its OWN no-fitness-declared refusal, not the config-loading one — proof the block was actually read", async () => {
    // A profile's `block` cannot carry a `fitness` key at all
    // (`docs/concepts/profiles.md`, "A profile's block carries exactly three
    // keys"), so the CORRECT failure for this fixture is fitness's own
    // "declares no fitness functions" — a real, named limit. Reaching THAT
    // message rather than the ladder's is itself proof the profile's block
    // was resolved and inspected, not just that the command stopped crashing.
    const streams = profEnv();
    expect(await runCli(["fitness"], streams)).toBe(EXIT.error);
    const errText = streams.lines.err.join("\n");
    expect(errText).not.toContain(WRONG_REASON);
    expect(errText).toContain("requires a policy that declares fitness functions");
  });

  it("impact resolves the profile and reports the real dependent", async () => {
    const streams = profEnv();
    expect(await runCli(["impact", "adapter"], streams)).toBe(EXIT.ok);
    const text = streams.lines.out.join("\n");
    expect(text).not.toContain(WRONG_REASON);
    expect(text).toContain("1 project depends on adapter");
  });

  it("explain judges the site against the profile's own depConstraints row", async () => {
    const streams = profEnv();
    expect(await runCli(["explain", "libs/domain/doc.go:5:2", "--format", "json"], streams)).toBe(
      EXIT.ok,
    );
    expect(streams.lines.err.join("\n")).not.toContain(WRONG_REASON);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.result.violations).toHaveLength(1);
    expect(envelope.result.violations[0].messageId).toBe("onlyTagsConstraintViolation");
  });

  it("context lists the constraint row the profile declared for domain", async () => {
    const streams = profEnv();
    expect(await runCli(["context", "domain", "--format", "json"], streams)).toBe(EXIT.ok);
    expect(streams.lines.err.join("\n")).not.toContain(WRONG_REASON);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.result.constraints).toContainEqual(
      expect.objectContaining({ sourceTag: "layer:domain" }),
    );
  });

  it("history --capture carries a policy fingerprint under a profile-selected workspace", async () => {
    const histDir = mkdtempSync(join(tmpdir(), "polyglot-cli-profiles-hist-"));
    try {
      const streams = profEnv();
      expect(await runCli(["history", histDir, "--capture"], streams)).toBe(EXIT.ok);
      expect(streams.lines.err.join("\n")).not.toContain(WRONG_REASON);
      const [snapshot] = readdirSync(histDir).filter(
        (name) => name.endsWith(".json") && !name.endsWith(".json.tmp"),
      );
      const envelope = JSON.parse(readFileSync(join(histDir, snapshot), "utf8"));
      expect(envelope.result.policy).toBeDefined();
      expect(typeof envelope.result.policy.fingerprint).toBe("string");
    } finally {
      rmSync(histDir, { recursive: true, force: true });
    }
  });

  it("debt resolves the profile and reaches its own missing-intent refusal, not the ladder's", async () => {
    const debtDir = mkdtempSync(join(tmpdir(), "polyglot-cli-profiles-debt-"));
    try {
      // A snapshot first: `debt` refuses an EMPTY snapshot directory before it
      // ever loads the intent (`commands/debt.mjs` — "there is no record to age
      // the ledger against"), so an unpopulated tmpdir would stop the run one
      // gate short of the intent refusal this case is about. Capturing one
      // keeps the assertion below aimed at the depth it was written for.
      expect(await runCli(["history", debtDir, "--capture"], profEnv())).toBe(EXIT.ok);
      const streams = profEnv();
      expect(await runCli(["debt", debtDir], streams)).toBe(EXIT.error);
      const errText = streams.lines.err.join("\n");
      expect(errText).not.toContain(WRONG_REASON);
      expect(errText).toContain("requires a tracked architecture-intent.json");
    } finally {
      rmSync(debtDir, { recursive: true, force: true });
    }
  });

  it("health resolves the profile and reports a full verdict", async () => {
    const streams = profEnv();
    expect(await runCli(["health"], streams)).toBe(EXIT.ok);
    const text = streams.lines.out.join("\n");
    expect(text).not.toContain(WRONG_REASON);
    expect(text).toContain("health over complete coverage");
  });

  it("report resolves the profile and names the law that governed the document", async () => {
    // The whole point of the governance document is that ONE law governs all
    // of it, so a profile-selected workspace is exactly where a second law
    // could sneak in: the sections are composed from four commands, and only
    // `resolvePolicy`'s single answer being threaded through all of them keeps
    // them citing the same table. A profile that failed to resolve would reach
    // the ladder's message instead of the document.
    const streams = profEnv();
    expect(await runCli(["report"], streams)).toBe(EXIT.ok);
    const text = streams.lines.out.join("\n");
    expect(text).not.toContain(WRONG_REASON);
    expect(text).toContain("architecture governance report");
    expect(text).toContain("report over complete coverage");
    expect(text).toContain("policy      ");
    // Descriptive over a tree whose `explain` case above finds a real
    // violation: the document reports it and still exits 0, because only
    // `check` and `fitness` carry the findings lane.
    expect(text).toContain("could not inspect");
  });

  it("report refuses a second positional argument as a usage error", async () => {
    const streams = profEnv();
    expect(await runCli(["report", "one", "two"], streams)).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("report takes at most one positional argument");
  });

  it("diff detects a real policy change under an unchanged profile NAME (P1-17)", async () => {
    // Its own tmpdir workspace, mutated mid-test — kept separate from the
    // read-only fixture above for the same reason P1-25's `buildRoot` factory
    // is: a mutation here must never be able to affect another case.
    const policyWith = (banTransitiveDependencies) => ({
      version: 1,
      profiles: [
        {
          name: "strict",
          block: {
            depConstraints: [
              { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
            ],
            moduleBoundaryOptions: {
              allow: [],
              buildTargets: ["build"],
              enforceBuildableLibDependency: false,
              allowCircularSelfDependency: false,
              checkDynamicDependenciesExceptions: [],
              ignoredCircularDependencies: [],
              banTransitiveDependencies,
              checkNestedExternalImports: false,
            },
          },
        },
      ],
    });

    const diffRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-profiles-diff-"));
    const histDir = mkdtempSync(join(tmpdir(), "polyglot-cli-profiles-diff-hist-"));
    const registryPath = join(diffRoot, "law-profiles.json");
    const write = (relativePath, text) => {
      mkdirSync(join(diffRoot, relativePath, ".."), { recursive: true });
      writeFileSync(join(diffRoot, relativePath), text);
    };
    try {
      write(
        "nx.json",
        JSON.stringify({
          plugins: [
            {
              plugin: "@ecoma-io/archkeep/nx",
              options: { boundaryConfig: "strict", profiles: "law-profiles.json" },
            },
          ],
        }),
      );
      writeFileSync(registryPath, JSON.stringify(policyWith(false)));
      write("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
      write("libs/domain/doc.go", "package domain\n");
      write("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
      write("libs/adapter/adapter.go", "package adapter\n");

      const diffGraph = {
        nodes: {
          domain: { name: "domain", type: "lib", data: { root: "libs/domain", tags: [] } },
          adapter: { name: "adapter", type: "lib", data: { root: "libs/adapter", tags: [] } },
        },
        dependencies: { domain: [], adapter: [] },
      };
      const diffFiles = [
        "nx.json",
        "law-profiles.json",
        "libs/domain/go.mod",
        "libs/domain/doc.go",
        "libs/adapter/go.mod",
        "libs/adapter/adapter.go",
      ];
      const diffEnv = () => {
        const out = [];
        const err = [];
        return {
          out: (text) => out.push(text),
          err: (text) => err.push(text),
          lines: { out, err },
          cwd: diffRoot,
          readGraph: () => diffGraph,
          listFiles: () => diffFiles,
        };
      };

      const baselineFile = join(histDir, "0001-baseline.json");
      const graphStreams = diffEnv();
      expect(
        await runCli(["graph", "--format", "json", "--output", baselineFile], graphStreams),
      ).toBe(EXIT.ok);

      // A real architectural-law edit under the SAME profile NAME — no
      // project or edge moves, only the policy `banTransitiveDependencies`
      // flips, the identical technique P1-25's own regression test used for
      // an inline `boundaryConfig`.
      writeFileSync(registryPath, JSON.stringify(policyWith(true)));

      const diffStreams = diffEnv();
      expect(await runCli(["diff", baselineFile, "--format", "json"], diffStreams)).toBe(EXIT.ok);
      expect(diffStreams.lines.err.join("\n")).not.toContain(WRONG_REASON);
      const envelope = JSON.parse(diffStreams.lines.out.join("\n"));
      expect(envelope.result.policyMismatch).toBeDefined();
      expect(envelope.result.policyMismatch.baseline.fingerprint).not.toBe(
        envelope.result.policyMismatch.head.fingerprint,
      );

      const textStreams = diffEnv();
      expect(await runCli(["diff", baselineFile], textStreams)).toBe(EXIT.ok);
      expect(textStreams.lines.out.join("\n")).toContain(
        "policy changed between baseline and head",
      );
    } finally {
      rmSync(diffRoot, { recursive: true, force: true });
      rmSync(histDir, { recursive: true, force: true });
    }
  });

  it("refuses a profiles registry whose symlinked intermediate leaves the workspace (G-10, profiles read)", async () => {
    // The `profiles` option is tree-derived (`nx.json`/`archkeep.json` options)
    // exactly like `boundaryConfig`, so a committed symlink in an intermediate
    // component of it hands OUTSIDE profile rows in as the workspace's law —
    // the boundary config read escape (G-10) held on the profiles arm, which
    // `resolvePolicy` used to reach straight through `loadProfileRegistry`'s
    // plain read. Red direction: the outside registry names a profile whose
    // block is permissive; read silently it would resolve the run against
    // outside bytes and report its verdict.
    const profEscape = mkdtempSync(join(tmpdir(), "polyglot-cli-profiles-escape-"));
    const outside = mkdtempSync(join(tmpdir(), "polyglot-cli-profiles-escape-outside-"));
    try {
      const writeEscape = (relativePath, text) => {
        mkdirSync(join(profEscape, relativePath, ".."), { recursive: true });
        writeFileSync(join(profEscape, relativePath), text);
      };
      writeEscape(
        "nx.json",
        JSON.stringify({
          plugins: [
            {
              plugin: "@ecoma-io/archkeep/nx",
              options: { boundaryConfig: "strict", profiles: "sub/law-profiles.json" },
            },
          ],
        }),
      );
      writeEscape(
        "module-boundaries.config.mjs",
        `export const depConstraints = [];
export const moduleBoundaryOptions = [];
`,
      );
      // The outside registry: a permissive profile the workspace never wrote.
      writeFileSync(
        join(outside, "law-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: [
            {
              name: "strict",
              block: { depConstraints: [], moduleBoundaryOptions: [] },
            },
          ],
        }),
      );
      mkdirSync(join(profEscape, "sub"), { recursive: true });
      rmSync(join(profEscape, "sub"), { recursive: true, force: true });
      symlinkSync(outside, join(profEscape, "sub"));
      const out = [];
      const err = [];
      const streams = {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        lines: { out, err },
        cwd: profEscape,
        readGraph: () => ({ nodes: {}, dependencies: {} }),
        listFiles: () => ["nx.json", "module-boundaries.config.mjs", "sub/law-profiles.json"],
      };
      expect(await runCli(["graph", "--format", "json"], streams)).toBe(EXIT.error);
      const text = streams.lines.out.join("\n") + streams.lines.err.join("\n");
      expect(text).toContain("law-profiles.json");
      expect(text).toContain("outside the workspace root");
    } finally {
      rmSync(profEscape, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("scoping a native check must not narrow the graph it is judged against", () => {
  // The silent-direction bug this guards: on the native path `graph.dependencies`
  // is DERIVED from analyzed import sites (`./src/providers/native/graph.mjs`),
  // unlike the Nx path where `nx graph` supplies the whole workspace's
  // dependencies independent of `--paths`. Analyzing only the requested scope
  // BEFORE building the graph would drop the far side of a cycle from
  // `dependencies` entirely, and `archkeep check libs/a` on this fixture would
  // exit 0 over a real a → b → a cycle — silence indistinguishable from a
  // workspace with no cycle at all.
  const cycleRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-cycle-"));
  afterAll(() => rmSync(cycleRoot, { recursive: true, force: true }));

  const writeCycle = (relativePath, text) => {
    mkdirSync(join(cycleRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(cycleRoot, relativePath), text);
  };

  writeCycle(
    "archkeep.json",
    JSON.stringify({
      projects: {
        declared: [
          { root: "libs/a", name: "a", tags: ["layer:x"] },
          { root: "libs/b", name: "b", tags: ["layer:x"] },
        ],
      },
      coverage: {
        exempt: [
          {
            path: "module-boundaries.config.mjs",
            reason: "workspace tooling config at the root, not itself a project",
          },
        ],
      },
    }),
  );
  writeCycle(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:x", onlyDependOnLibsWithTags: ["layer:x"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeCycle("libs/a/go.mod", "module example.com/a\n\ngo 1.24\n");
  writeCycle(
    "libs/a/doc.go",
    `// Package a is one half of a cycle that only closes through b.
package a

import (
	"example.com/b"
)

var _ = b.Name
`,
  );
  writeCycle("libs/b/go.mod", "module example.com/b\n\ngo 1.24\n");
  writeCycle(
    "libs/b/doc.go",
    `// Package b closes the cycle back to a.
package b

import (
	"example.com/a"
)

var _ = a.Name
`,
  );

  const cycleFiles = [
    "archkeep.json",
    "module-boundaries.config.mjs",
    "libs/a/go.mod",
    "libs/a/doc.go",
    "libs/b/go.mod",
    "libs/b/doc.go",
  ];

  const cycleContext = { cwd: cycleRoot, listFiles: () => cycleFiles };

  it("finds the a -> b -> a cycle over the whole tree", async () => {
    // Control case, unscoped: proves the fixture really is a cycle before the
    // scoped case below is trusted to say anything about scoping.
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      cycleContext,
    );
    expect(violations).toBe(2);
    expect(report).toContain("noCircularDependencies");
  });

  it("still reports the cycle when scoped to just one side of it", async () => {
    const { report, violations } = await check(
      { format: "text", config: null, paths: ["libs/a"] },
      cycleContext,
    );
    expect(violations).toBe(1);
    expect(report).toContain("libs/a/doc.go");
    expect(report).toContain("noCircularDependencies");
    // The other side of the cycle is out of scope, so it is not itself
    // reported — proving this is the real filter-after-analyze behaviour and
    // not an accidental widening that reports everything regardless of scope.
    expect(report).not.toContain("libs/b/doc.go");
  });
});

describe("a path scoped to an untracked file must not read as clean (P1-04)", () => {
  // The audit's exact reproduction: this tool's whole file universe is
  // `git ls-files` (`../workspace.mjs`'s header), so a file that exists on
  // disk but was never `git add`ed is invisible to it. `selectFiles` used to
  // fall through silently to an empty selection, and a scoped `check` over a
  // path that matched nothing analyzed 0 files and reported a clean tree —
  // byte-for-byte indistinguishable from a workspace with no violation at
  // all. Same fixture shape as the cycle-scoping describe block above, reused
  // here because a circular-dependency finding is exactly the violation class
  // the audit's own reproduction hit, and it is what proves this is the SAME
  // bytes on disk, not a different, cleaner file.
  const untrackedRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-untracked-"));
  afterAll(() => rmSync(untrackedRoot, { recursive: true, force: true }));

  const writeUntracked = (relativePath, text) => {
    mkdirSync(join(untrackedRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(untrackedRoot, relativePath), text);
  };

  writeUntracked(
    "archkeep.json",
    JSON.stringify({
      projects: {
        declared: [
          { root: "libs/a", name: "a", tags: ["layer:x"] },
          { root: "libs/b", name: "b", tags: ["layer:x"] },
        ],
      },
      coverage: {
        exempt: [
          {
            path: "module-boundaries.config.mjs",
            reason: "workspace tooling config at the root, not itself a project",
          },
        ],
      },
    }),
  );
  writeUntracked(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:x", onlyDependOnLibsWithTags: ["layer:x"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeUntracked("libs/a/go.mod", "module example.com/a\n\ngo 1.24\n");
  // Written to disk exactly like every other fixture file below — the bug is
  // that `listFiles` (standing in for `git ls-files`) can omit it below while
  // it still exists here, the same as a file that was never `git add`ed.
  writeUntracked(
    "libs/a/doc.go",
    `// Package a is one half of a cycle that only closes through b.
package a

import (
	"example.com/b"
)

var _ = b.Name
`,
  );
  writeUntracked("libs/b/go.mod", "module example.com/b\n\ngo 1.24\n");
  writeUntracked(
    "libs/b/doc.go",
    `// Package b closes the cycle back to a.
package b

import (
	"example.com/a"
)

var _ = a.Name
`,
  );

  const trackedFiles = [
    "archkeep.json",
    "module-boundaries.config.mjs",
    "libs/a/go.mod",
    "libs/a/doc.go",
    "libs/b/go.mod",
    "libs/b/doc.go",
  ];
  // `libs/a/doc.go` — the file carrying the cycle-closing import — is on disk
  // (written above) but absent here: the exact shape `git ls-files` answers
  // for a file that exists but has never been `git add`ed.
  const untrackedFileList = trackedFiles.filter((file) => file !== "libs/a/doc.go");

  it("exits usage rather than clean when the scoped path matches no tracked file", async () => {
    const streams = { ...env(), cwd: untrackedRoot, listFiles: () => untrackedFileList };
    expect(await runCli(["check", "libs/a/doc.go"], streams)).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("matches no tracked file");
    // Not the silent old behaviour: no clean report was ever printed for a
    // run that never actually inspected the file.
    expect(streams.lines.out.join("\n")).not.toContain("no boundary violations");
  });

  it("finds the real circular-dependency violation once the exact same bytes are tracked", async () => {
    // The audit's contrast, reproduced: identical file content at the same
    // path — the only difference from the case above is whether `listFiles`
    // (standing in for `git ls-files`) names it.
    const streams = { ...env(), cwd: untrackedRoot, listFiles: () => trackedFiles };
    expect(await runCli(["check", "libs/a/doc.go"], streams)).toBe(EXIT.violations);
    expect(streams.lines.out.join("\n")).toContain("noCircularDependencies");
  });

  it("exits usage on a scoped path that does not exist at all, the typo case", async () => {
    const streams = { ...env(), cwd: untrackedRoot, listFiles: () => trackedFiles };
    expect(await runCli(["check", "libs/nonexistent"], streams)).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("matches no tracked file");
  });

  it("still selects cleanly when scoped to a real, tracked, merely unowned path", async () => {
    // `module-boundaries.config.mjs` is tracked but owned by no project (no
    // declared project's root covers it) — a legitimate, genuinely empty
    // slice, and must not be refused the way the untracked case above is.
    const streams = { ...env(), cwd: untrackedRoot, listFiles: () => trackedFiles };
    expect(await runCli(["check", "module-boundaries.config.mjs"], streams)).toBe(EXIT.ok);
    expect(streams.lines.out.join("\n")).toContain("no boundary violations");
  });
});

describe("a declared workspaceLayout must reach the rule engine, not just validate and vanish", () => {
  // The silent-direction bug: `archkeep.json`'s `workspaceLayout` used to be
  // validated by `./src/providers/native/model.mjs` and then dropped —
  // `buildNativeGraph` never attached it to the graph object `evaluate()`
  // reads, so every native check ran against the Nx DEFAULT layout
  // (`libs`/`apps`) regardless of what a workspace actually declared. A
  // workspace using a custom `libsDir` would see an absolute import into one
  // of its own libraries reported as an unremarkable external import instead
  // of the boundary-crossing spelling it is.
  const layoutRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-layout-"));
  afterAll(() => rmSync(layoutRoot, { recursive: true, force: true }));

  const writeLayout = (relativePath, text) => {
    mkdirSync(join(layoutRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(layoutRoot, relativePath), text);
  };

  const modelWith = (workspaceLayout) =>
    JSON.stringify({
      projects: {
        declared: [
          { root: "packages/a", name: "a" },
          { root: "packages/b", name: "b" },
        ],
      },
      ...(workspaceLayout ? { workspaceLayout } : {}),
      coverage: {
        exempt: [
          {
            path: "module-boundaries.config.mjs",
            reason: "workspace tooling config at the root, not itself a project",
          },
        ],
      },
    });

  writeLayout(
    "module-boundaries.config.mjs",
    `export const depConstraints = [];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeLayout("packages/a/go.mod", "module example.com/a\n\ngo 1.24\n");
  // The specifier's literal text is what the absolute-import check reads
  // (`../rules/index.mjs`'s `imp = site.specifier`) — a custom `libsDir` of
  // `packages` makes `packages/b/thing` an absolute path into another
  // project's library the same way a default-layout workspace reads
  // `libs/b`. Written in TypeScript because the check judges a
  // JavaScript-family spelling: a Go module path of the same shape is a name
  // the check must not read as a path (#376), so a `.go` file can no longer
  // carry the crossing this test exists to catch.
  writeLayout(
    "packages/a/doc.ts",
    'import { Name } from "packages/b/thing";\n\nexport const name = Name;\n',
  );
  writeLayout("packages/b/go.mod", "module example.com/b\n\ngo 1.24\n");

  const layoutFiles = [
    "module-boundaries.config.mjs",
    "packages/a/go.mod",
    "packages/a/doc.ts",
    "packages/b/go.mod",
  ];

  it("with a custom libsDir declared, catches the absolute import into another library", async () => {
    writeLayout("archkeep.json", modelWith({ appsDir: "applications", libsDir: "packages" }));
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      { cwd: layoutRoot, listFiles: () => [...layoutFiles, "archkeep.json"] },
    );
    expect(violations).toBe(1);
    expect(report).toContain("noRelativeOrAbsoluteImportsAcrossLibraries");
  });

  it("without workspaceLayout declared, the default libs/apps layout misses it — the exact gap the declared layout must close", async () => {
    writeLayout("archkeep.json", modelWith(undefined));
    const { violations } = await check(
      { format: "text", config: null, paths: [] },
      { cwd: layoutRoot, listFiles: () => [...layoutFiles, "archkeep.json"] },
    );
    expect(violations).toBe(0);
  });
});

describe("an Nx-tree workspaceLayout must reach the rule engine the same way archkeep.json's does", () => {
  // The Nx-side counterpart to the native block above: `nx.json`'s
  // `workspaceLayout` used to be read nowhere in this package —
  // `readProjectGraph` (`./providers/nx.mjs`) merged nothing from disk onto
  // the graph `evaluate()` reads, so a workspace with a custom `libsDir`
  // still had its boundary rules judged against the Nx DEFAULT layout
  // (`libs`/`apps`). `check()`'s `readGraph` context seam is injected with the
  // real `readProjectGraph`, faking only the `nx graph` subprocess spawn
  // (`run`), so the real `nx.json` merge logic in `./providers/nx.mjs` runs
  // against a real file on disk — the same thing `findWorkspaceRoot` and
  // `readPluginOptions` inside `check()` do unconditionally and cannot be
  // injected around.
  const nxLayoutRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-nx-layout-"));
  afterAll(() => rmSync(nxLayoutRoot, { recursive: true, force: true }));

  const writeNxLayout = (relativePath, text) => {
    mkdirSync(join(nxLayoutRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(nxLayoutRoot, relativePath), text);
  };

  writeNxLayout(
    "module-boundaries.config.mjs",
    `export const depConstraints = [];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeNxLayout("packages/a/go.mod", "module example.com/a\n\ngo 1.24\n");
  // TypeScript, not Go, for the reason the native block above states: the
  // absolute-import check judges a JavaScript-family spelling (#376).
  writeNxLayout(
    "packages/a/doc.ts",
    'import { Name } from "packages/b/thing";\n\nexport const name = Name;\n',
  );
  writeNxLayout("packages/b/go.mod", "module example.com/b\n\ngo 1.24\n");

  const nxLayoutFiles = [
    "nx.json",
    "module-boundaries.config.mjs",
    "packages/a/go.mod",
    "packages/a/doc.ts",
    "packages/b/go.mod",
  ];

  // Stands in for the `nx graph` subprocess spawn only — the graph shape a
  // real `nx graph --file=` write produces for this tree, with no
  // `workspaceLayout` key of its own, so the only source of that fact is the
  // real `readProjectGraph` merge this test exists to exercise.
  const fakeNxGraphRun = (_file, args) => {
    const fileArg = args.find((arg) => arg.startsWith("--file="));
    const target = fileArg.slice("--file=".length);
    writeFileSync(
      target,
      JSON.stringify({
        graph: {
          nodes: {
            a: { name: "a", type: "lib", data: { root: "packages/a" } },
            b: { name: "b", type: "lib", data: { root: "packages/b" } },
          },
          dependencies: {},
        },
      }),
    );
    return "";
  };

  it("with a custom libsDir declared in nx.json, catches the absolute import into another library", async () => {
    writeNxLayout(
      "nx.json",
      JSON.stringify({ workspaceLayout: { appsDir: "applications", libsDir: "packages" } }),
    );
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      {
        cwd: nxLayoutRoot,
        readGraph: (root) => readProjectGraph(root, { run: fakeNxGraphRun }),
        listFiles: () => nxLayoutFiles,
      },
    );
    expect(violations).toBe(1);
    expect(report).toContain("noRelativeOrAbsoluteImportsAcrossLibraries");
  });

  it("without workspaceLayout declared, the default libs/apps layout misses it — the exact gap the declared layout must close", async () => {
    writeNxLayout("nx.json", JSON.stringify({}));
    const { violations } = await check(
      { format: "text", config: null, paths: [] },
      {
        cwd: nxLayoutRoot,
        readGraph: (root) => readProjectGraph(root, { run: fakeNxGraphRun }),
        listFiles: () => nxLayoutFiles,
      },
    );
    expect(violations).toBe(0);
  });
});

describe("the exit contract", () => {
  it("exits 1 when the tree violates a boundary — the code a hook and CI block on", async () => {
    const streams = env();
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    expect(streams.lines.out.join("\n")).toContain("libs/domain/doc.go:5:2");
  });

  it("separates a mistyped command from a failing check by exit code", () => {
    const unknown = run(["frobnicate"]);
    expect(unknown.status).toBe(EXIT.usage);
    expect(unknown.stderr).toContain("unknown command 'frobnicate'");

    const bare = run([]);
    expect(bare.status).toBe(EXIT.usage);
    expect(bare.stderr).toContain("no command given");
  });

  it("refuses a command name inherited from Object.prototype the same way it refuses any other unknown command", () => {
    // `COMMANDS[commandName]` with no own-property guard would answer
    // `toString`/`__proto__`/`constructor` from `Object.prototype` instead of
    // `undefined`, pass the `!command` check, and crash on `command.run` —
    // a TypeError and exit 1, not the usage error every other unregistered
    // command word gets. Exit code has to be checked as IS 2, not merely
    // "not 0", or a regression back to the TypeError's exit 1 would slip
    // through a looser assertion.
    const toStringResult = run(["toString"]);
    expect(toStringResult.status).toBe(EXIT.usage);
    expect(toStringResult.stderr).toContain("unknown command 'toString'");

    const protoResult = run(["__proto__"]);
    expect(protoResult.status).toBe(EXIT.usage);
    expect(protoResult.stderr).toContain("unknown command '__proto__'");
  });

  it("rejects a mistyped option instead of reading it as a path that selects nothing", () => {
    // `--fromat sarif` read as two paths would select no files and report a
    // clean tree: a green run that inspected nothing.
    const result = run(["check", "--fromat", "sarif"]);
    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toContain("unknown option '--fromat'");
  });

  it("registers debt as a descriptive command with its own usage error", () => {
    // A mistyped `debt` (no trailing 't') already falls into the unknown-
    // command bucket above; this pins that `debt` itself is registered and
    // its positional-argument contract is what a missing `<dir>` trips, NOT
    // "unknown command". Regression direction: an unregistered command would
    // report the usage error for the wrong reason.
    const result = run(["debt"]);
    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toContain("debt takes exactly one positional argument");

    const mixed = run(["debt", "a", "b"]);
    expect(mixed.status).toBe(EXIT.usage);
    expect(mixed.stderr).toContain("debt takes exactly one positional argument");
    expect(mixed.stderr).toContain("got 2");
  });

  it("distinguishes a run that could not complete from a tree that is clean", async () => {
    // Exit 3, never 0 and never 1: a checker that could not look must not be
    // mistaken for one that looked and found nothing. The fixture is a real
    // git repository with no marker anywhere in it, so the walk is bounded by
    // the repository's top level (`findWorkspaceRoot`) and the refusal holds
    // on any machine, whatever sits above its temporary directory — the
    // machine shape that reported #339 had `~/.moon` up there, and a walk
    // reading only marker presence made these two tests environment-dependent.
    const streams = env();
    streams.cwd = mkdtempSync(join(tmpdir(), "polyglot-not-a-workspace-"));
    spawnSync("git", ["init", "--quiet"], { cwd: streams.cwd, encoding: "utf8" });
    afterAll(() => rmSync(streams.cwd, { recursive: true, force: true }));
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    expect(streams.lines.err.join("\n")).toContain("no workspace root above");
  });

  // S9: the message used to name only `nx.json`, which pointed a native-only
  // reader (`archkeep.json`, no Nx anywhere) at the wrong marker to create —
  // and creating an `nx.json` next to an existing `archkeep.json` does not fix
  // the "no root found" case at all, it trades it for the dual-marker refusal
  // above. The silent-direction risk this pins: a message naming only one
  // marker reads as correct advice right up until a native-only reader acts
  // on it, so the fix has to be provable by what the string actually
  // contains, not by matching against a single word in it.
  it("names both root markers in the not-a-workspace message, not just nx.json", async () => {
    const streams = env();
    streams.cwd = mkdtempSync(join(tmpdir(), "polyglot-not-a-workspace-both-markers-"));
    spawnSync("git", ["init", "--quiet"], { cwd: streams.cwd, encoding: "utf8" });
    afterAll(() => rmSync(streams.cwd, { recursive: true, force: true }));
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    const message = streams.lines.err.join("\n");
    expect(message).toContain("nx.json");
    expect(message).toContain("archkeep.json");
  });

  // #339's machine shape, end to end: a bare `.moon` — moonrepo's user-level
  // state directory, no `workspace.yml` in it — above a real git repository
  // carrying no workspace marker. Before the fix the walk read only directory
  // presence, climbed out of the repository, selected the home directory as a
  // "Moon workspace", and failed loading a `module-boundaries.config.mjs`
  // that was never written. Exit 3 either way — the defect is that the
  // message depended on what sat above the caller, so both halves are pinned:
  // the honest refusal AND the absence of the phantom-config failure. The
  // "home" is a fixture directory, so the case runs anywhere.
  it("refuses honestly when a bare .moon sits above the enclosing git repository", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyglot-phantom-home-"));
    afterAll(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, ".moon"));
    const repo = join(home, "work", "repo");
    mkdirSync(join(repo, "packages", "app"), { recursive: true });
    spawnSync("git", ["init", "--quiet"], { cwd: repo, encoding: "utf8" });

    const streams = env();
    streams.cwd = join(repo, "packages", "app");
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    const message = streams.lines.err.join("\n");
    expect(message).toContain("no workspace root above");
    expect(message).toContain(".moon/workspace.yml");
    expect(message).not.toContain("cannot load");
  });

  it("calls a path outside the tree a usage error, since retyping it is the fix", async () => {
    const streams = env();
    expect(await runCli(["check", "/somewhere/else"], streams)).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("outside the workspace");
  });

  it("refuses to exit 0 over a file it could not analyze, because 0 is read as 'checked, and fine'", async () => {
    // The same principle as the case above, applied to a run that DID start.
    // The clean half of the tree, plus one file the analyzer never got a
    // verdict about: the summary counts it, so exit 0 would report coverage
    // this run does not have. Exit 3 — no verdict — not 1, which would claim
    // a boundary was crossed.
    const streams = {
      ...env(),
      listFiles: () => [...files, "libs/adapter/absent.go"],
    };
    expect(await runCli(["check", "libs/adapter"], streams)).toBe(EXIT.error);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("✔ no boundary violations");
    expect(report).toContain("1 file could not be analyzed at all");
    expect(report).toContain("libs/adapter/absent.go  could not be read");
  });

  it("reports status no-verdict in the JSON envelope over the same unreadable file, never status ok", async () => {
    // The JSON twin of the case above: a caller branching on `status` alone
    // must see the same refusal a caller branching on the exit code sees —
    // `jsonEnvelope` (`src/report/json.mjs`) would throw before shipping
    // `status: "ok"` here, but this pins the whole path end to end rather
    // than only the throw.
    const streams = {
      ...env(),
      listFiles: () => [...files, "libs/adapter/absent.go"],
    };
    const exitCode = await runCli(["check", "libs/adapter", "--format", "json"], streams);
    expect(exitCode).toBe(EXIT.error);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.status).toBe("no-verdict");
    expect(envelope.exitCode).toBe(3);
    expect(envelope.coverage.complete).toBe(false);
    expect(envelope.coverage.notAnalyzed).toEqual([
      { file: "libs/adapter/absent.go", reason: expect.stringContaining("could not be read") },
    ]);
    // The canonical four-state verdict of the same run: a tree that could not
    // be fully read emits `unknown` — never the `pass` that would read as
    // "checked, and fine" — with the reason naming which half could not look.
    expect(envelope.decision.verdict).toBe("unknown");
    expect(envelope.decision.reason).toContain("could not be analyzed");
  });

  it("still exits 1 when the tree is dirty AND a file could not be analyzed, since that verdict is certain", async () => {
    // Precedence matters to a caller that branches: a violation is a finding
    // it can act on, and the unanalyzed file is listed in the same report
    // either way. Only a run with no findings may be downgraded to "no
    // verdict".
    const streams = { ...env(), listFiles: () => [...files, "libs/domain/absent.go"] };
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    expect(streams.lines.out.join("\n")).toContain("could not be analyzed at all");
  });
});

describe("surfacing an ESLint boundaryConfig dialect's note on the coverage line (S2)", () => {
  // A `mkdtemp` directory INSIDE this package, not under the OS tmpdir — the
  // same reason `eslint-config.integration.test.mjs`'s `fixtureRoot()` picks
  // its location: `@nx/eslint-plugin` resolves by walking a file's own
  // ancestor directories, and only an ancestor of this package's own
  // `node_modules` reaches this workspace's real, hoisted install.
  const eslintRoot = mkdtempSync(join(packageRoot, ".cli-eslint-config-fixture-"));
  afterAll(() => rmSync(eslintRoot, { recursive: true, force: true }));

  const writeEslint = (relativePath, text) => {
    mkdirSync(join(eslintRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(eslintRoot, relativePath), text);
  };

  writeEslint("nx.json", "{}\n");
  // The canonical `nx g @nx/eslint` shape (B1): every glob a bare
  // source-extension pattern, no directory component — accepted tree-wide,
  // with a note this test exists to see rendered.
  writeEslint(
    "eslint.config.mjs",
    `export default [
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        { depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }] },
      ],
    },
  },
];
`,
  );
  writeEslint("libs/store/go.mod", "module example.com/store\n\ngo 1.24\n");
  writeEslint("libs/store/store.go", "package store\n");

  const eslintContext = {
    cwd: eslintRoot,
    readGraph: () => ({
      nodes: {
        store: { name: "store", type: "lib", data: { root: "libs/store", tags: ["layer:domain"] } },
      },
      dependencies: { store: [] },
    }),
    listFiles: () => ["nx.json", "eslint.config.mjs", "libs/store/go.mod", "libs/store/store.go"],
  };

  it(
    "renders the note on the report's coverage line, next to what was inspected",
    { timeout: 30_000 },
    async () => {
      // The budget is explicit for the reason
      // `./conformance/presets-published.integration.test.mjs`'s pack test states
      // its own: this case does REAL work whose cost vitest's 5s default was
      // never sized for, and the red it produces reads like a regression in the
      // thing under test rather than like a clock.
      //
      // The work is loading a real ESLint flat config through the real resolver,
      // which pulls in `@nx/eslint-plugin` and `eslint` themselves. Measured
      // three ways on one tree: 600ms when a sibling file in the same vitest
      // worker had already imported that graph, 2.7s in isolation paying the
      // cold import, and past 5s on the Node 24 CI lane. Which of the three this
      // test gets is decided by vitest's file-to-worker assignment, so a commit
      // that adds a test file ANYWHERE can flip it — one did, which is how this
      // line came to be written.
      const { report, violations } = await check(
        { format: "text", config: join(eslintRoot, "eslint.config.mjs"), paths: [] },
        eslintContext,
      );
      expect(violations).toBe(0);
      // The claim of no violations must sit beside the coverage sentence, and
      // the coverage sentence must carry the note — a note computed and never
      // shown would be the silent direction with extra steps.
      expect(report).toContain("✔ no boundary violations");
      expect(report).toContain("scopes @nx/enforce-module-boundaries under files");
      expect(report).toContain("applied the table tree-wide");
    },
  );
});

describe("the option surface", () => {
  it("accepts a flag's value attached or separate, the two forms a shell produces", () => {
    expect(parseCheckArgs(["--format=sarif", "libs"])).toEqual({
      format: "sarif",
      output: null,
      config: null,
      evidenceOut: null,
      paths: ["libs"],
    });
    expect(parseCheckArgs(["--format", "sarif"]).format).toBe("sarif");
  });

  it("names the formats it has when given one it does not", () => {
    expect(() => parseCheckArgs(["--format", "junit"])).toThrow(/expected one of text, sarif/);
  });

  it("writes the report to --output and still says on stderr what the run found", async () => {
    // The file is what CI uploads; the log line is what a human reading a red
    // job sees, and without it the job would say nothing about why it failed.
    const target = join(root, "boundaries.sarif");
    const streams = env();
    expect(await runCli(["check", "--format", "sarif", "--output", target], streams)).toBe(
      EXIT.violations,
    );
    expect(JSON.parse(readFileSync(target, "utf8")).version).toBe("2.1.0");
    expect(streams.lines.err.join("\n")).toContain("1 violation over 2 analyzed files");
  });

  it("writes --format json's envelope to --output silently, and still says on stderr what the run found", async () => {
    const target = join(root, "boundaries.json");
    const streams = env();
    expect(await runCli(["check", "--format", "json", "--output", target], streams)).toBe(
      EXIT.violations,
    );
    // "Silently" means stdout carries nothing — the envelope went to the
    // file, and printing it a second time would be a second, competing
    // rendering of the same run.
    expect(streams.lines.out).toEqual([]);
    const envelope = JSON.parse(readFileSync(target, "utf8"));
    expect(envelope.status).toBe("findings");
    expect(envelope.exitCode).toBe(1);
    expect(streams.lines.err.join("\n")).toContain("1 violation over 2 analyzed files");
  });

  it("exits 3 when --output cannot be written, naming the path — a report that never lands must not read as success", async () => {
    // The report exists in memory but no consumer will ever see it, which is
    // exactly a silent success if this returned 0 or 1 instead — named as a
    // no-verdict run, the same as every other "could not complete" condition.
    const target = join(root, "does-not-exist", "boundaries.json");
    const streams = env();
    expect(await runCli(["check", "--output", target], streams)).toBe(EXIT.error);
    expect(streams.lines.out).toEqual([]);
    expect(streams.lines.err.join("\n")).toContain(`could not write --output '${target}'`);
  });
});

describe("the usage message", () => {
  it("prints the surface, the config it reads, and the exit codes a caller branches on", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(EXIT.ok);
    expect(result.stdout).toContain("archkeep check");
    expect(result.stdout).toContain("module-boundaries.config.mjs");
    expect(result.stdout).toContain("--format text|sarif");
    expect(result.stdout).toContain("1 findings (violations, go.work drift, dead path aliases)");
  });
});

describe("the bare-path dispatcher", () => {
  // `archkeep <path>` with no command word at all has to keep working the way
  // it always did, now that a command word is a real option `runCli` has to
  // resolve first. Its own describe block because the two directions —an
  // existing path, and a word that is neither a command nor a path — are the
  // whole point of the ordering `runCli`'s header argues.
  it("runs check when the first argument is an existing path, with no command word at all", async () => {
    const withCommand = env();
    const bare = env();
    expect(await runCli(["check", "libs/adapter"], withCommand)).toBe(EXIT.ok);
    expect(await runCli(["libs/adapter"], bare)).toBe(EXIT.ok);
    // Not just "both exit 0" — the same report, because the bare form is
    // required to be indistinguishable from typing `check` explicitly.
    expect(bare.lines.out).toEqual(withCommand.lines.out);
  });

  it("exits 2 on a first argument that is neither a registered command nor an existing path", async () => {
    const streams = env();
    expect(await runCli(["notacommand"], streams)).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("unknown command 'notacommand'");
    // The distinct failure mode this is not: read as a path, it would select
    // no files and report a clean tree rather than refuse to run at all.
    expect(streams.lines.err.join("\n")).not.toContain("outside the workspace");
  });

  it("exits 2 on an empty-string first argument, rather than reading it as the workspace root", async () => {
    // `join(cwd, "")` is `cwd` itself, which always exists — without the
    // `maybeCommand !== ""` guard, `archkeep ""` reads as a path and runs a
    // whole-workspace check instead of the unknown-command refusal every
    // other non-command, non-path word gets.
    const streams = env();
    expect(await runCli([""], streams)).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("unknown command ''");
    expect(streams.lines.err.join("\n")).not.toContain("outside the workspace");
  });
});

describe("a Rust use whose braces do not balance, one blind spot the envelope must carry", () => {
  // Its own fixture: none of the Go-only fixtures above exercise a second
  // language, and the blind-spot half of `coverage` — a file that WAS
  // analyzed, with one site whose target is not statically knowable — needs a
  // real case to render rather than an empty array to trivially pass.
  const rustRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-rust-blind-"));
  afterAll(() => rmSync(rustRoot, { recursive: true, force: true }));

  const writeRust = (relativePath, text) => {
    mkdirSync(join(rustRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(rustRoot, relativePath), text);
  };

  writeRust("nx.json", "{}\n");
  writeRust(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeRust("libs/widget/Cargo.toml", '[package]\nname = "widget"\nversion = "0.1.0"\n');
  // A `use` whose braces do not balance is not a list this reader can split,
  // so it names no crate to resolve (`../src/analysis/rust.mjs`'s
  // `braceGroupArms` returns null and the caller keeps the loud answer) — the
  // file is analyzed, this one site is not, and that is a blind spot rather
  // than a whole-file failure: `coverage.complete` must stay true over it.
  //
  // A WELL-FORMED group is deliberately not the fixture any more: it resolves
  // now, one record per arm, so using it here would leave this case asserting
  // an empty blind-spot list and proving nothing.
  writeRust("libs/widget/src/lib.rs", "use {a::b, c::d\n;\n");

  const rustContext = {
    cwd: rustRoot,
    readGraph: () => ({
      nodes: {
        widget: {
          name: "widget",
          type: "lib",
          data: { root: "libs/widget", tags: ["layer:domain"] },
        },
      },
      dependencies: { widget: [] },
    }),
    listFiles: () => [
      "nx.json",
      "module-boundaries.config.mjs",
      "libs/widget/Cargo.toml",
      "libs/widget/src/lib.rs",
    ],
  };

  it("names the unsplittable-group site in coverage.blindSpots, and leaves coverage.complete true", async () => {
    const { report, violations, unchecked } = await check(
      { format: "json", config: null, paths: [] },
      rustContext,
    );
    expect(violations).toBe(0);
    expect(unchecked).toBe(0);
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("ok");
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.notAnalyzed).toEqual([]);
    expect(envelope.coverage.blindSpots).toEqual([
      {
        file: "libs/widget/src/lib.rs",
        line: 1,
        column: 5,
        reason: "'use {a::b, c::d' opens with a brace group, so it names no crate to resolve",
      },
    ]);
  });
});

describe("`graph` on the Nx fixture", () => {
  it("exits 0 and names every fixture project in text output", async () => {
    const streams = env();
    expect(await runCli(["graph"], streams)).toBe(EXIT.ok);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("domain");
    expect(report).toContain("adapter");
  });

  it("produces a valid JSON envelope with command graph, complete coverage, sorted projects", async () => {
    const streams = env();
    expect(await runCli(["graph", "--format", "json"], streams)).toBe(EXIT.ok);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.command).toBe("graph");
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.result.projects.map((p) => p.name)).toEqual(
      envelope.result.projects
        .map((p) => p.name)
        .slice()
        .sort(),
    );
  });

  it("never exits 1, even on the violating fixture where check does", async () => {
    // Silent direction: a graph that exits 1 over a boundary violation makes
    // the exit code ambiguous between "the graph is broken" and "the tree is
    // dirty" — the exact confusion check's distinct exit codes exist to avoid.
    const streams = env();
    const code = await runCli(["graph"], streams);
    expect(code).not.toBe(EXIT.violations);
    expect(code).toBe(EXIT.ok);
  });

  it("produces byte-identical JSON across two consecutive runs", async () => {
    const first = env();
    const second = env();
    await runCli(["graph", "--format", "json"], first);
    await runCli(["graph", "--format", "json"], second);
    expect(first.lines.out.join("\n")).toBe(second.lines.out.join("\n"));
  });
});

describe("`graph` on a native fixture with no nx resolvable", () => {
  const nativeGraphRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-graph-"));
  afterAll(() => rmSync(nativeGraphRoot, { recursive: true, force: true }));

  const writeNativeGraph = (relativePath, text) => {
    mkdirSync(join(nativeGraphRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(nativeGraphRoot, relativePath), text);
  };

  writeNativeGraph(
    "archkeep.json",
    JSON.stringify({
      boundaryConfig: "module-boundaries.config.mjs",
      projects: {
        declared: [
          { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
          { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
        ],
      },
      coverage: {
        exempt: [
          {
            path: "module-boundaries.config.mjs",
            reason: "workspace tooling config at the root, not itself a project",
          },
        ],
      },
    }),
  );
  writeNativeGraph(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeNativeGraph("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeNativeGraph("libs/domain/doc.go", "package domain\n");
  writeNativeGraph("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeNativeGraph("libs/adapter/adapter.go", "package adapter\n");

  const nativeGraphFiles = [
    "archkeep.json",
    "module-boundaries.config.mjs",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
  ];

  const nativeGraphEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      cwd: nativeGraphRoot,
      listFiles: () => nativeGraphFiles,
    };
  };

  it("exits 0 with the same payload shape as the Nx path", async () => {
    const streams = nativeGraphEnv();
    expect(await runCli(["graph", "--format", "json"], streams)).toBe(EXIT.ok);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.command).toBe("graph");
    expect(envelope.workspace.provider).toBe("native");
    expect(envelope.coverage.complete).toBe(true);
    expect(Array.isArray(envelope.result.projects)).toBe(true);
    expect(envelope.result.projects.length).toBeGreaterThan(0);
    expect(Array.isArray(envelope.result.dependencies)).toBe(true);
  });
});

describe("`check` names the polyglot coverage gap when the plugin is unregistered but manifests exist", () => {
  // The silent direction for #38: an Nx workspace with polyglot manifests but
  // the plugin unregistered exits 0 and says nothing about the missing edges —
  // a consumer's `nx affected` and `@nx/enforce-module-boundaries` silently
  // under-cover Go/Rust/Python. The degraded-coverage note closes that gap
  // without changing the exit code, because `check`'s own analysis still
  // covers what the Nx graph does not.
  const gapRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-coverage-gap-"));
  afterAll(() => rmSync(gapRoot, { recursive: true, force: true }));

  const writeGap = (relativePath, text) => {
    mkdirSync(join(gapRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(gapRoot, relativePath), text);
  };

  // nx.json with NO plugins entry — the plugin is not registered.
  writeGap("nx.json", JSON.stringify({}));
  writeGap(
    "module-boundaries.config.mjs",
    `export const depConstraints = [];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeGap("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeGap("libs/domain/doc.go", "package domain\n");

  const gapGraph = {
    nodes: {
      domain: {
        name: "domain",
        type: "lib",
        data: { root: "libs/domain", tags: [] },
      },
    },
    dependencies: { domain: [] },
  };
  const gapFiles = [
    "nx.json",
    "module-boundaries.config.mjs",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
  ];

  it("mentions the coverage gap and the go.mod in the text report", async () => {
    const { report } = await check(
      { format: "text", config: null, paths: [] },
      { cwd: gapRoot, readGraph: () => gapGraph, listFiles: () => gapFiles },
    );
    expect(report).toContain("nx.json does not register this plugin");
    expect(report).toContain("libs/domain/go.mod");
    expect(report).toContain("nx affected");
  });

  it("still exits 0 — the coverage gap is informational, not a finding", async () => {
    const { violations } = await check(
      { format: "text", config: null, paths: [] },
      { cwd: gapRoot, readGraph: () => gapGraph, listFiles: () => gapFiles },
    );
    expect(violations).toBe(0);
  });

  it("carries the coverage gap in the JSON envelope's coverage object", async () => {
    const { report } = await check(
      { format: "json", config: null, paths: [] },
      { cwd: gapRoot, readGraph: () => gapGraph, listFiles: () => gapFiles },
    );
    const envelope = JSON.parse(report);
    // Selected by kind rather than by position: this fixture's own
    // `module-boundaries.config.mjs` sits under no project root, so it also
    // earns the `unowned-files` gap (#263, the describe below). Two gaps of
    // different kinds are the point of the list — an assertion on
    // `coverageGaps[0]` would pin an ordering neither producer promises.
    const gap = envelope.coverage.coverageGaps.find(
      (entry) => entry.kind === "unregistered-plugin",
    );
    expect(gap).toBeDefined();
    expect(gap.manifests).toContain("libs/domain/go.mod");
  });

  it("does not mention the coverage gap when the plugin is registered", async () => {
    // The complement: registering the plugin removes the gap. Use the main
    // fixture (which registers the plugin) to confirm the absence.
    const { report } = await check({ format: "text", config: null, paths: [] }, context);
    expect(report).not.toContain("coverage gap");
    expect(report).not.toContain("does not register this plugin");
  });
});

describe("`check` counts the tracked analyzable files no project owns", () => {
  // #263, the silent direction: a tracked `.mjs`/`.ts`/`.vue` file outside
  // every declared project is skipped — documented and unchanged — but it was
  // also absent from every coverage surface. `analyzedFiles` counted only
  // owned files, `notAnalyzed`/`coverageGaps`/`notes` were empty, `complete`
  // was `true`, and a declared `coverage-minimum: 100` passed at 100%. The
  // report a consumer read was byte-identical to one over a tree where every
  // file really was owned. Measured on this repository at the time: 50 of 425
  // tracked analyzable files, 11.8% of the tree, outside the verdict with
  // nothing saying so.
  //
  // What must NOT move is everything else. Counting them as uncovered would
  // make `coverage.complete` false, which is `status: "no-verdict"` and exit 3
  // (`../../../docs/reference/exit-codes.md`) — turning `check` red for nearly
  // every real Nx or Moon consumer on code they did not touch, this
  // repository's own final CI step included. So: a counted gap, and no verdict
  // moves. The third test below is the one that holds that line.
  const unownedRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-unowned-files-"));
  afterAll(() => rmSync(unownedRoot, { recursive: true, force: true }));

  const writeUnowned = (relativePath, text) => {
    mkdirSync(join(unownedRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(unownedRoot, relativePath), text);
  };

  // The plugin IS registered here, so the only gap this fixture can produce is
  // the unowned-files one — nothing borrows the unregistered-plugin gap's
  // green.
  writeUnowned(
    "nx.json",
    JSON.stringify({ plugins: [{ plugin: "@ecoma-io/archkeep/nx", options: {} }] }),
  );
  writeUnowned(
    "module-boundaries.config.mjs",
    `export const depConstraints = [];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeUnowned("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeUnowned("libs/domain/doc.go", "package domain\n");
  writeUnowned("tools/release.mjs", "export const release = 1;\n");
  writeUnowned("tools/publish.mjs", "export const publish = 1;\n");
  // Owned — inside the project's own root. It is what makes the guard below
  // able to fail: a file list holding no analyzable file at all would keep
  // that test green even against a gap that fires on everything.
  writeUnowned("libs/domain/tool.mjs", "export const tool = 1;\n");

  const unownedGraph = {
    nodes: {
      domain: { name: "domain", type: "lib", data: { root: "libs/domain", tags: [] } },
    },
    dependencies: { domain: [] },
  };
  // `tools/release.mjs` and `tools/publish.mjs` are tracked, analyzable, and
  // under no project root — the everyday shape this gap exists to count
  // rather than to fail on. `module-boundaries.config.mjs` is tracked and
  // analyzable too, and is deliberately NOT counted: it is the boundary law,
  // not source judged by it, and counting it would make the report vary with
  // the law's own filename (`./commands/context.mjs`'s
  // `unownedAnalyzableFiles`). It stays in this list so that exclusion is
  // exercised rather than assumed.
  const unownedFiles = [
    "nx.json",
    "module-boundaries.config.mjs",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "tools/release.mjs",
    "tools/publish.mjs",
  ];

  it("names them in the text report and in the JSON envelope's coverageGaps", async () => {
    const { report: text } = await check(
      { format: "text", config: null, paths: [] },
      { cwd: unownedRoot, readGraph: () => unownedGraph, listFiles: () => unownedFiles },
    );
    expect(text).toContain("2 tracked analyzable files (typescript) owned by no project");
    expect(text).toContain("tools/release.mjs");
    // The exclusion, pinned on the surface a reader actually reads. Without
    // it this count is 3 and the law's filename is one of the listed entries.
    // Matched with its leading indent, because the policy header one line
    // above names the same file and a bare substring test would pass on that.
    expect(text).not.toContain("\n    module-boundaries.config.mjs\n");

    const { report: json } = await check(
      { format: "json", config: null, paths: [] },
      { cwd: unownedRoot, readGraph: () => unownedGraph, listFiles: () => unownedFiles },
    );
    const gaps = JSON.parse(json).coverage.coverageGaps;
    // Non-empty at all is the assertion that goes red in the silent
    // direction: before this, an unowned analyzable file produced `[]`.
    expect(gaps.length).toBeGreaterThan(0);
    const gap = gaps.find((entry) => entry.kind === "unowned-files");
    expect(gap).toBeDefined();
    expect(gap.files).not.toContain("module-boundaries.config.mjs");
    // Tracked order, which on a real run is `git ls-files`' own sort.
    expect(gap.files).toEqual(["tools/release.mjs", "tools/publish.mjs"]);
    expect(gap.languages).toEqual(["typescript"]);
    expect(gap.provider).toBe("nx");
  });

  it("says nothing when every analyzable file is owned", async () => {
    // The guard: a gap that fires on every workspace is a line readers learn
    // to skip, and then it is worth nothing on the workspace that needed it.
    // Same fixture, minus the two unowned files.
    const ownedOnly = [
      "nx.json",
      "libs/domain/go.mod",
      "libs/domain/doc.go",
      "libs/domain/tool.mjs",
    ];
    const { report: text } = await check(
      { format: "text", config: "module-boundaries.config.mjs", paths: [] },
      { cwd: unownedRoot, readGraph: () => unownedGraph, listFiles: () => ownedOnly },
    );
    expect(text).not.toContain("owned by no project");

    const { report: json } = await check(
      { format: "json", config: "module-boundaries.config.mjs", paths: [] },
      { cwd: unownedRoot, readGraph: () => unownedGraph, listFiles: () => ownedOnly },
    );
    expect(
      JSON.parse(json).coverage.coverageGaps.filter((entry) => entry.kind === "unowned-files"),
    ).toEqual([]);
  });

  it("moves no verdict: exit 0, status ok, coverage.complete still true", async () => {
    // The decision this change was allowed to make, and the three it was not.
    // If this test ever needs relaxing, the change under it has become the
    // rejected option — "count them as uncovered" — wearing this one's name.
    const { report } = await check(
      { format: "json", config: null, paths: [] },
      { cwd: unownedRoot, readGraph: () => unownedGraph, listFiles: () => unownedFiles },
    );
    const envelope = JSON.parse(report);
    expect(envelope.coverage.coverageGaps.some((entry) => entry.kind === "unowned-files")).toBe(
      true,
    );
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(EXIT.ok);
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.notAnalyzed).toEqual([]);
  });
});

describe("`check` accepts unowned files through the policy's coverage.unowned", () => {
  // Issue #282: both unowned states used to be permanent — the TS/JS/Vue gap
  // warned on every run with no way to answer it, and a Go/Rust/Python
  // unclaimed file was a hard exit 3 with no accepted middle ground. A
  // `coverage.unowned` row turns either into a RECORDED acceptance: the run
  // still states every accepted file (the assertions below pin presence, not
  // merely the absence of the old warning — an acceptance that went
  // invisible would be the silent direction wearing a feature's name), but
  // the unanswerable warning and the exit 3 stop firing for it.
  const coverageRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-coverage-unowned-"));
  afterAll(() => rmSync(coverageRoot, { recursive: true, force: true }));

  const writeCov = (relativePath, text) => {
    mkdirSync(join(coverageRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(coverageRoot, relativePath), text);
  };

  const COV_OPTIONS = {
    allow: [],
    buildTargets: ["build"],
    enforceBuildableLibDependency: false,
    allowCircularSelfDependency: false,
    checkDynamicDependenciesExceptions: [],
    ignoredCircularDependencies: [],
    banTransitiveDependencies: false,
    checkNestedExternalImports: false,
  };
  const lawWith = (coverage) =>
    JSON.stringify({
      depConstraints: [],
      moduleBoundaryOptions: COV_OPTIONS,
      ...(coverage === null ? {} : { coverage }),
    });

  writeCov(
    "nx.json",
    JSON.stringify({ plugins: [{ plugin: "@ecoma-io/archkeep/nx", options: {} }] }),
  );
  // The `.json` dialect on purpose, twice over: it re-reads from disk on
  // every load (no module cache between the spellings below), and a tracked
  // `.json` is not an analyzable file, so the alternative law spellings do
  // not themselves join the unowned set the way extra `.mjs` laws would.
  writeCov(
    "law-accept.json",
    lawWith({
      unowned: [
        { path: "orphans/**", reason: "vendored fixture corpus imported wholesale" },
        { path: "tools/**", reason: "generated release tooling, judged by its own pipeline" },
      ],
    }),
  );
  writeCov(
    "law-partial.json",
    lawWith({ unowned: [{ path: "orphans/**", reason: "vendored fixture corpus" }] }),
  );
  writeCov(
    "law-tools.json",
    lawWith({ unowned: [{ path: "tools/**", reason: "generated release tooling" }] }),
  );
  writeCov("law-none.json", lawWith(null));
  writeCov("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeCov("libs/domain/doc.go", "package domain\n");
  writeCov("orphans/legacy.go", "package legacy\n");
  writeCov("tools/release.mjs", "export const release = 1;\n");

  const covGraph = {
    nodes: { domain: { name: "domain", type: "lib", data: { root: "libs/domain", tags: [] } } },
    dependencies: { domain: [] },
  };
  const covFiles = [
    "nx.json",
    "law-accept.json",
    "law-none.json",
    "law-partial.json",
    "law-tools.json",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "orphans/legacy.go",
    "tools/release.mjs",
  ];
  const covContext = (files = covFiles) => ({
    cwd: coverageRoot,
    readGraph: () => covGraph,
    listFiles: () => files,
  });

  it("records both unowned kinds as accepted — loudly, with no exit 3 and no permanent warning", async () => {
    const result = await check(
      { format: "text", config: "law-accept.json", paths: [] },
      covContext(),
    );
    expect(result.unchecked).toBe(0);
    expect(result.violations).toBe(0);
    const text = result.report;
    // Presence first: the acceptance is stated, files named.
    expect(text).toContain("accepted as coverage holes by the policy's coverage.unowned");
    expect(text).toContain("orphans/legacy.go");
    expect(text).toContain("tools/release.mjs");
    // Then absence: the permanent warning and the unclaimed refusal are gone.
    expect(text).not.toContain("— skipped");
    expect(text).not.toContain("is not owned by any project");

    const { report } = await check(
      { format: "json", config: "law-accept.json", paths: [] },
      covContext(),
    );
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(EXIT.ok);
    expect(envelope.coverage.complete).toBe(true);
    const gaps = envelope.coverage.coverageGaps;
    expect(gaps.filter((gap) => gap.kind === "unowned-files")).toEqual([]);
    const accepted = gaps.find((gap) => gap.kind === "accepted-unowned-files");
    expect(accepted).toBeDefined();
    // Tracked order, both languages, and the provider the remediation would
    // name — the same fields the warning gap carries.
    expect(accepted.files).toEqual(["orphans/legacy.go", "tools/release.mjs"]);
    expect(accepted.languages).toEqual(["go", "typescript"]);
    expect(accepted.provider).toBe("nx");
  });

  it("keeps today's behavior verbatim when the policy declares no coverage", async () => {
    const { report, unchecked } = await check(
      { format: "json", config: "law-none.json", paths: [] },
      covContext(),
    );
    expect(unchecked).toBe(1);
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("no-verdict");
    expect(envelope.coverage.notAnalyzed.map(({ file }) => file)).toEqual(["orphans/legacy.go"]);
    const gap = envelope.coverage.coverageGaps.find((entry) => entry.kind === "unowned-files");
    expect(gap.files).toEqual(["tools/release.mjs"]);
    expect(
      envelope.coverage.coverageGaps.filter((entry) => entry.kind === "accepted-unowned-files"),
    ).toEqual([]);
  });

  it("leaves an uncovered TS file's warning untouched while accepting the Go orphan", async () => {
    const result = await check(
      { format: "text", config: "law-partial.json", paths: [] },
      covContext(),
    );
    // The accepted Go orphan no longer refuses the run…
    expect(result.unchecked).toBe(0);
    expect(result.report).toContain("accepted as coverage holes");
    expect(result.report).toContain("orphans/legacy.go");
    // …and the uncovered TS file keeps today's warning verbatim.
    expect(result.report).toContain(
      "1 tracked analyzable file (typescript) owned by no project — skipped",
    );
    expect(result.report).toContain("tools/release.mjs");
  });

  it("keeps exit 3 for an unclaimed Go file no row covers", async () => {
    const { report, unchecked } = await check(
      { format: "json", config: "law-tools.json", paths: [] },
      covContext(),
    );
    expect(unchecked).toBe(1);
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("no-verdict");
    expect(envelope.coverage.notAnalyzed.map(({ file }) => file)).toEqual(["orphans/legacy.go"]);
    // The accepted TS file is still stated — acceptance and refusal coexist.
    expect(
      envelope.coverage.coverageGaps.find((entry) => entry.kind === "accepted-unowned-files").files,
    ).toEqual(["tools/release.mjs"]);
  });

  it("refuses a row whose last file gained an owner, naming the row — the native stale-row sentence", async () => {
    // Same law, but the tree no longer carries the files the row accepted:
    // the acceptance is dead, and dead must be a loud verdict (exit-3 class),
    // not a key that silently stops meaning anything.
    const owned = covFiles.filter(
      (file) => file !== "orphans/legacy.go" && file !== "tools/release.mjs",
    );
    await expect(
      check({ format: "text", config: "law-partial.json", paths: [] }, covContext(owned)),
    ).rejects.toThrow(
      /coverage\.unowned\[0\]: 'orphans\/\*\*' matches no unowned file this run judged/,
    );
  });

  it("surfaces the acceptances — path, reason, current coverage — through `archkeep waivers`", async () => {
    const out = [];
    const err = [];
    const exitCode = await runCli(["waivers", "--format", "json", "--config", "law-accept.json"], {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      ...covContext(),
    });
    expect(err).toEqual([]);
    expect(exitCode).toBe(EXIT.ok);
    const envelope = JSON.parse(out.join("\n"));
    expect(envelope.result.unownedAcceptances).toEqual([
      { path: "orphans/**", reason: "vendored fixture corpus imported wholesale", covered: 1 },
      {
        path: "tools/**",
        reason: "generated release tooling, judged by its own pipeline",
        covered: 1,
      },
    ]);

    const textOut = [];
    await runCli(["waivers", "--config", "law-accept.json"], {
      out: (text) => textOut.push(text),
      err: () => {},
      ...covContext(),
    });
    const text = textOut.join("\n");
    expect(text).toContain("2 coverage acceptances");
    expect(text).toContain("vendored fixture corpus imported wholesale");
  });

  it("accepts a Moon workspace's Go orphan the same way", async () => {
    const moonRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-coverage-moon-"));
    try {
      const writeMoon = (relativePath, text) => {
        mkdirSync(join(moonRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(moonRoot, relativePath), text);
      };
      writeMoon(".moon/workspace.yml", " ");
      writeMoon(
        "law.json",
        lawWith({ unowned: [{ path: "orphans/**", reason: "vendored fixture corpus" }] }),
      );
      writeMoon("orphans/legacy.go", "package legacy\n");
      writeMoon("libs/a/a.go", "package a\n");
      const moonGraph = {
        nodes: { a: { name: "a", type: "lib", data: { root: "libs/a", tags: [] } } },
        dependencies: { a: [] },
      };
      const { report, unchecked } = await check(
        { format: "json", config: "law.json", paths: [] },
        {
          cwd: moonRoot,
          readGraph: () => moonGraph,
          listFiles: () => [".moon/workspace.yml", "law.json", "libs/a/a.go", "orphans/legacy.go"],
        },
      );
      expect(unchecked).toBe(0);
      const envelope = JSON.parse(report);
      expect(envelope.status).toBe("ok");
      const accepted = envelope.coverage.coverageGaps.find(
        (entry) => entry.kind === "accepted-unowned-files",
      );
      expect(accepted.files).toEqual(["orphans/legacy.go"]);
      expect(accepted.provider).toBe("moon");
    } finally {
      rmSync(moonRoot, { recursive: true, force: true });
    }
  });

  it("refuses the key loudly on a native tree, naming archkeep.json's own channel", async () => {
    // One channel per decision per tree: a native workspace records the same
    // acceptance on `archkeep.json`'s coverage.exempt, so the policy key is
    // refused rather than carried as a second copy — the same posture the
    // `.moon`-beside-`archkeep.json` pair gets.
    const nativeCovRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-coverage-native-"));
    try {
      const writeNat = (relativePath, text) => {
        mkdirSync(join(nativeCovRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(nativeCovRoot, relativePath), text);
      };
      writeNat(
        "archkeep.json",
        JSON.stringify({
          projects: { declared: [{ root: "libs/a", name: "a", type: "lib", tags: [] }] },
        }),
      );
      writeNat(
        "law.json",
        lawWith({ unowned: [{ path: "orphans/**", reason: "vendored fixture corpus" }] }),
      );
      writeNat("libs/a/a.go", "package a\n");
      await expect(
        check(
          { format: "text", config: "law.json", paths: [] },
          {
            cwd: nativeCovRoot,
            listFiles: () => ["archkeep.json", "law.json", "libs/a/a.go"],
          },
        ),
      ).rejects.toThrow(/coverage\.exempt/);
    } finally {
      rmSync(nativeCovRoot, { recursive: true, force: true });
    }
  });
});

describe("`graph` refuses when the plugin is unregistered but polyglot manifests exist", () => {
  // Silent direction: a graph printed with no Go edges and exit 0 — the exact
  // failure AGENTS.md's opening paragraph describes.
  const unregisteredRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-unregistered-"));
  afterAll(() => rmSync(unregisteredRoot, { recursive: true, force: true }));

  const writeUnreg = (relativePath, text) => {
    mkdirSync(join(unregisteredRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(unregisteredRoot, relativePath), text);
  };

  writeUnreg(
    "nx.json",
    JSON.stringify({}), // No plugins entry — the plugin is not registered.
  );
  writeUnreg(
    "module-boundaries.config.mjs",
    `export const depConstraints = [];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeUnreg("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeUnreg("libs/domain/doc.go", "package domain\n");

  const unregGraph = {
    nodes: {
      domain: {
        name: "domain",
        type: "lib",
        data: { root: "libs/domain", tags: [] },
      },
    },
    dependencies: { domain: [] },
  };
  const unregFiles = [
    "nx.json",
    "module-boundaries.config.mjs",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
  ];

  it("exits 3 and names the go.mod and the plugins entry", async () => {
    const out = [];
    const err = [];
    const streams = {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      cwd: unregisteredRoot,
      readGraph: () => unregGraph,
      listFiles: () => unregFiles,
    };
    expect(await runCli(["graph"], streams)).toBe(EXIT.error);
    const report = out.join("\n") + err.join("\n");
    expect(report).toContain("go.mod");
    expect(report).toContain("plugins");
  });

  it("exits 0 when the same fixture registers the plugin", async () => {
    // The complement: registering the plugin removes the refusal.
    writeUnreg(
      "nx.json",
      JSON.stringify({
        plugins: [
          {
            plugin: "@ecoma-io/archkeep/nx",
            options: { boundaryConfig: "module-boundaries.config.mjs" },
          },
        ],
      }),
    );
    const out = [];
    const err = [];
    const streams = {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      cwd: unregisteredRoot,
      readGraph: () => unregGraph,
      listFiles: () => unregFiles,
    };
    expect(await runCli(["graph"], streams)).toBe(EXIT.ok);
  });

  it("check proceeds when the Nx plugin is unregistered and polyglot manifests exist", async () => {
    // `pluginGap` on CommandContext is computed but NOT consulted by `check`'s
    // refusal logic — only `graph` refuses. This test pins that: if `check`
    // were accidentally wired to refuse the same way `graph` does, it would
    // exit 3 instead of 0 or 1, and this test would catch the regression.
    // Restore the unregistered nx.json in case the test above overwrote it.
    writeUnreg("nx.json", JSON.stringify({}));
    const out = [];
    const err = [];
    const streams = {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      cwd: unregisteredRoot,
      readGraph: () => unregGraph,
      listFiles: () => unregFiles,
    };
    // Exit 0 (clean) or 1 (violations), NOT 3 (refusal).
    const exitCode = await runCli(["check"], streams);
    expect(exitCode).not.toBe(EXIT.error);
  });

  it("check notes no coverage gap for an unregistered plugin", async () => {
    // `pluginGap` is a documented product decision: the gap is known and
    // tracked separately. `check`'s JSON envelope does not carry a
    // polyglot-coverage-gap note in `coverage.notes`, because the gap lives
    // in `graph`'s refusal, not in `check`'s verdict. If wiring lands, this
    // test fails and gets updated.
    writeUnreg("nx.json", JSON.stringify({}));
    const out = [];
    const err = [];
    const streams = {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      cwd: unregisteredRoot,
      readGraph: () => unregGraph,
      listFiles: () => unregFiles,
    };
    await runCli(["check", "--format", "json"], streams);
    const envelope = JSON.parse(out.join("\n"));
    const gapNotes = (envelope.coverage.notes ?? []).filter((n) =>
      /polyglot|plugin.*gap|unregistered/i.test(n),
    );
    expect(gapNotes).toEqual([]);
  });
});

describe("`diff` round trip against the Nx fixture", () => {
  it("graph --output then diff on the unchanged tree exits 0 and reports no changes", async () => {
    const baselineFile = join(root, "round-trip-baseline.json");
    const graphStreams = env();
    expect(
      await runCli(["graph", "--format", "json", "--output", baselineFile], graphStreams),
    ).toBe(EXIT.ok);
    const diffStreams = env();
    expect(await runCli(["diff", baselineFile], diffStreams)).toBe(EXIT.ok);
    expect(diffStreams.lines.out.join("\n")).toContain("no changes");
    // Clean up.
    try {
      rmSync(baselineFile, { force: true });
    } catch {
      // Already gone.
    }
  });

  it("adding a project between runs shows the added project in diff", async () => {
    // Capture baseline from the current fixture.
    const baselineFile = join(root, "added-project-baseline.json");
    const graphStreams = env();
    expect(
      await runCli(["graph", "--format", "json", "--output", baselineFile], graphStreams),
    ).toBe(EXIT.ok);

    // Add a third project to the fixture.
    const addedRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-added-"));
    afterAll(() => rmSync(addedRoot, { recursive: true, force: true }));
    const writeAdded = (relativePath, text) => {
      mkdirSync(join(addedRoot, relativePath, ".."), { recursive: true });
      writeFileSync(join(addedRoot, relativePath), text);
    };
    writeAdded(
      "nx.json",
      `${JSON.stringify({
        plugins: [
          {
            plugin: "@ecoma-io/archkeep/nx",
            options: { boundaryConfig: "module-boundaries.config.mjs" },
          },
        ],
      })}\n`,
    );
    writeAdded(
      "module-boundaries.config.mjs",
      `export const depConstraints = [];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
    );
    writeAdded("libs/a/go.mod", "module example.com/a\n\ngo 1.24\n");
    writeAdded("libs/a/a.go", "package a\n");
    writeAdded("libs/b/go.mod", "module example.com/b\n\ngo 1.24\n");
    writeAdded("libs/b/b.go", "package b\n");
    // The new project.
    writeAdded("libs/c/go.mod", "module example.com/c\n\ngo 1.24\n");
    writeAdded("libs/c/c.go", "package c\n");

    const addedGraph = {
      nodes: {
        a: { name: "a", type: "lib", data: { root: "libs/a", tags: [] } },
        b: { name: "b", type: "lib", data: { root: "libs/b", tags: [] } },
        c: { name: "c", type: "lib", data: { root: "libs/c", tags: [] } },
      },
      dependencies: { a: [], b: [], c: [] },
    };
    const addedFiles = [
      "nx.json",
      "module-boundaries.config.mjs",
      "libs/a/go.mod",
      "libs/a/a.go",
      "libs/b/go.mod",
      "libs/b/b.go",
      "libs/c/go.mod",
      "libs/c/c.go",
    ];
    const out = [];
    const err = [];
    const diffStreams = {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      cwd: addedRoot,
      readGraph: () => addedGraph,
      listFiles: () => addedFiles,
    };
    const diffResult = await runCli(["diff", baselineFile, "--format", "json"], diffStreams);
    expect(diffResult).toBe(EXIT.ok);
    const envelope = JSON.parse(out.join("\n"));
    expect(envelope.result.addedProjects.map((p) => p.name)).toContain("c");
    // Clean up.
    try {
      rmSync(baselineFile, { force: true });
    } catch {
      // Already gone.
    }
  });
});

describe("`diff` argument and baseline validation", () => {
  it("exits 2 with no argument — diff requires exactly one baseline file", async () => {
    const streams = env();
    expect(await runCli(["diff"], streams)).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("exactly one positional argument");
  });

  it("exits 3 on a nonexistent baseline file, naming the path", async () => {
    const streams = env();
    expect(await runCli(["diff", "/nonexistent/path/baseline.json"], streams)).toBe(EXIT.error);
    const errText = streams.lines.err.join("\n");
    // The error comes from either the file-read failure or parseBaseline.
    expect(errText).toContain("/nonexistent/path/baseline.json");
  });

  it("exits 3 on a check --format json envelope, saying it is a check report", async () => {
    // A check report envelope has command "check", not "graph" — diff must
    // refuse it rather than silently misreading its shape.
    const checkEnvelopeFile = join(root, "check-envelope.json");
    writeFileSync(
      checkEnvelopeFile,
      JSON.stringify({
        schemaVersion: 2,
        command: "check",
        status: "ok",
        exitCode: 0,
        coverage: {
          complete: true,
          projects: 2,
          analyzedFiles: 2,
          imports: 1,
          notAnalyzed: [],
          blindSpots: [],
          notes: [],
        },
        result: { violations: [], goWork: null, tsconfigPaths: null },
      }),
    );
    const streams = env();
    expect(await runCli(["diff", checkEnvelopeFile], streams)).toBe(EXIT.error);
    const errText = streams.lines.err.join("\n");
    expect(errText).toContain("check");
    // Clean up.
    try {
      rmSync(checkEnvelopeFile, { force: true });
    } catch {
      // Already gone.
    }
  });
});

describe("`history` capture and describe against the Nx fixture", () => {
  // `runCli` drives the real command wiring in-process (parseArgs with the
  // boolean `--capture`, the history run function, envelope render), over the
  // injected graph — the half the spawned-subprocess E2E cannot cover because
  // cli.mjs is excluded from in-process coverage. The history directory lives
  // outside the workspace tree so the captured snapshot is not itself tracked.
  const histDir = mkdtempSync(join(tmpdir(), "polyglot-cli-hist-"));
  afterAll(() => rmSync(histDir, { recursive: true, force: true }));

  it("captures the workspace graph and describes it as JSON", async () => {
    const streams = env();
    expect(await runCli(["history", histDir, "--capture"], streams)).toBe(EXIT.ok);

    const files = readdirSync(histDir);
    const snapshots = files
      .filter((name) => name.endsWith(".json") && !name.endsWith(".json.tmp"))
      .sort();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatch(/^0001-[0-9a-f]{8}\.json$/);

    const envelope = JSON.parse(readFileSync(join(histDir, snapshots[0]), "utf8"));
    expect(envelope.command).toBe("graph");
    expect(envelope.status).toBe("ok");
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.result.projects.map((p) => p.name).sort()).toEqual(["adapter", "domain"]);

    // The record, as JSON, carries the one snapshot and no transitions.
    const describeStreams = env();
    expect(await runCli(["history", histDir, "--format", "json"], describeStreams)).toBe(EXIT.ok);
    const record = JSON.parse(describeStreams.lines.out.join("\n"));
    expect(record.command).toBe("history");
    expect(record.status).toBe("ok");
    expect(record.result.snapshots).toHaveLength(1);
    expect(record.result.transitions).toEqual([]);
  });

  it("deduplicates a capture when the architecture did not change", async () => {
    const streams = env();
    expect(await runCli(["history", histDir, "--capture"], streams)).toBe(EXIT.ok);
    const files = readdirSync(histDir).filter(
      (name) => name.endsWith(".json") && !name.endsWith(".json.tmp"),
    );
    expect(files).toHaveLength(1);
    expect(streams.lines.out.join("\n")).toContain("already the last snapshot");
  });

  it("refuses to write the report back into the history directory it reads", async () => {
    // The self-footgun guard: --output inside the history dir would be read
    // back as a (refused) snapshot on the next run, so it must be a usage
    // error rather than a silent poison.
    const streams = env();
    expect(
      await runCli(
        ["history", histDir, "--format", "json", "--output", join(histDir, "report.json")],
        streams,
      ),
    ).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("inside the history directory");
    expect(existsSync(join(histDir, "report.json"))).toBe(false);
  });

  it("refuses an absolute --output path whose '..' segments resolve into the history directory (bug C)", async () => {
    // Same guard as above, but the path is absolute AND carries a `..` that
    // only resolves into the history directory after normalization. Before
    // this fix, `isAbsolute(options.output) ? options.output : resolve(cwd,
    // options.output)` used the absolute branch raw — unresolved — so
    // `dirname(outputAbs)` never matched the history directory and the guard
    // was skipped. `writeOutputReport` itself resolves the path correctly, so
    // the run used to succeed and land the report INSIDE the directory
    // `history` reads, poisoning every later run — exactly the silent
    // self-footgun the guard above exists to prevent.
    const streams = env();
    // Built with string interpolation, not `join()` — `path.join` normalizes
    // the `..` away before it ever reaches the CLI, which would leave
    // `options.output` as a plain in-dir path the OLD code already refused,
    // pinning nothing. A literal `..` has to survive to `runHistory` for this
    // case to exercise the difference between the raw and the resolved path.
    const sneaky = `${histDir}/escape/../report.json`;
    expect(
      await runCli(["history", histDir, "--format", "json", "--output", sneaky], streams),
    ).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("inside the history directory");
    expect(existsSync(join(histDir, "report.json"))).toBe(false);
  });

  it("ignores a .json.tmp left by an interrupted capture", async () => {
    // Atomic capture writes `<name>.json.tmp` then renames; an interrupted
    // write leaves the tmp behind, and that must never count as a snapshot.
    const streams = env();
    const leaveTmp = mkdtempSync(join(tmpdir(), "polyglot-cli-hist-tmp-"));
    try {
      writeFileSync(join(leaveTmp, "0001-deadbeef.json.tmp"), "partial garbage");
      expect(await runCli(["history", leaveTmp, "--capture"], streams)).toBe(EXIT.ok);
      const names = readdirSync(leaveTmp).sort();
      // The stray tmp remains (it is not deleted), and the capture wrote one
      // real snapshot that is not the tmp itself.
      expect(names).toContain("0001-deadbeef.json.tmp");
      const snapshots = names.filter((n) => n.endsWith(".json") && !n.endsWith(".json.tmp"));
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatch(/^0001-[0-9a-f]{8}\.json$/);
    } finally {
      rmSync(leaveTmp, { recursive: true, force: true });
    }
  });

  it("exits 3 on a history directory with no snapshots", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "polyglot-cli-hist-empty-"));
    try {
      const streams = env();
      expect(await runCli(["history", emptyDir], streams)).toBe(EXIT.error);
      expect(streams.lines.err.join("\n")).toContain("contains no snapshots");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("adr resolves a workspace root by every marker a root may carry", () => {
  // The command had no end-to-end test at all, and the gap hid a real defect:
  // `resolveWorkspaceRootForUsage` kept its own copy of the marker list naming
  // `nx.json` and `archkeep.json` only, so `adr` answered "needs a workspace
  // root — no nx.json, archkeep.json, or .moon marker found" on every Moon tree
  // — naming `.moon` in the very sentence that proved it had not looked for it.
  // This repository is a Moon workspace whose every architecture-intent row
  // carries `decisionRef: "0001-boundary-levels"`, so the one command that can
  // resolve that reference could never run on the tree it governs.
  //
  // Each marker gets its own case rather than one case for the fixed one: a
  // list that lost an entry is exactly the regression, and a test covering
  // only the entry that broke last time would not see the next one go.
  // `loadAdrRegistry` reads this directory by a constant, so the fixture has to
  // use the same name. Held as a variable so no source line here spells a
  // `docs/adr/<id>.md` path whole — see the note at the writeFileSync below.
  const ADR_FIXTURE_DIR = "docs/adr";

  const markers = [
    ["nx.json", "nx.json", "{}\n"],
    ["archkeep.json", "archkeep.json", '{"projects":[]}\n'],
    [".moon", ".moon/workspace.yml", "projects: []\n"],
    [".config/moon", ".config/moon/workspace.yml", "projects: []\n"],
  ];

  for (const [label, markerPath, markerBody] of markers) {
    it(`reads the registry in a workspace rooted by ${label}`, () => {
      const adrRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-adr-"));
      try {
        mkdirSync(join(adrRoot, dirname(markerPath)), { recursive: true });
        writeFileSync(join(adrRoot, markerPath), markerBody);
        // The record's name is joined on rather than written as one literal:
        // spelled whole, `docs/adr/<id>.md` reads to `check-docs-links` as this
        // file citing a decision record in THIS repository, and the gate fails
        // on a path that resolves nowhere. The fixture's tree is not this tree.
        mkdirSync(join(adrRoot, ADR_FIXTURE_DIR), { recursive: true });
        writeFileSync(
          join(adrRoot, ADR_FIXTURE_DIR, "0001-layering.md"),
          "---\nstatus: accepted\n---\n\n# Layering\n",
        );
        // The registry reads only git-tracked files (P1-21) — `git ls-files`
        // has to see this fixture's own record, or the fix under test would
        // exclude it exactly like the untracked scratch file it is not.
        spawnSync("git", ["init", "--quiet"], { cwd: adrRoot, encoding: "utf8" });
        spawnSync("git", ["add", "-A"], { cwd: adrRoot, encoding: "utf8" });

        const result = spawnSync(process.execPath, [CLI, "adr"], {
          cwd: adrRoot,
          encoding: "utf8",
          timeout: 30_000,
          killSignal: "SIGKILL",
        });

        // The silent direction here is exit 3 with an empty registry read as
        // "nothing recorded": both this assertion and the next have to hold,
        // because a run that could not find the root and a run that found a
        // root with no ADRs both print no record.
        expect(result.status, `${label}: ${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("0001-layering");
      } finally {
        rmSync(adrRoot, { recursive: true, force: true });
      }
    });
  }
});

describe("checking a tree with a pyproject.toml analysis cannot read (audit D-03)", () => {
  // Audit finding D-03's exact evidence, reproduced end to end: a Python
  // project whose `pyproject.toml` is malformed TOML — `[project` with no
  // closing `]` — while its `.py` imports still resolve. Before the fix, the
  // layout reader reported the project unmodelled and the run exited 0 with
  // coverage "complete": a green verdict about a workspace whose manifest
  // said nothing this tool could read. The silent direction is not an empty
  // result but an affirmative one — the run's own text said "no boundary
  // violations" and "coverage complete" while the module index was missing a
  // whole project. A malformed manifest is a hole in every run, so the whole
  // file becomes a failure (exit 3), regardless of the boundary config and
  // regardless of which paths a scoped run names.
  const d03Root = mkdtempSync(join(tmpdir(), "polyglot-cli-d03-"));
  afterAll(() => rmSync(d03Root, { recursive: true, force: true }));

  const writeD03 = (relativePath, text) => {
    mkdirSync(join(d03Root, relativePath, ".."), { recursive: true });
    writeFileSync(join(d03Root, relativePath), text);
  };

  writeD03(
    "archkeep.json",
    JSON.stringify({
      projects: {
        declared: [
          { root: "apps/a", name: "a", type: "lib", tags: [] },
          { root: "apps/b", name: "b", type: "lib", tags: [] },
        ],
      },
      coverage: {
        exempt: [
          {
            path: "module-boundaries.config.mjs",
            reason: "audit fixture policy file",
          },
        ],
      },
    }),
  );
  writeD03(
    "module-boundaries.config.mjs",
    `export const depConstraints = [{ sourceTag: "*", onlyDependOnLibsWithTags: ["*"] }];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: [],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  // The audit fixture's malformed manifest: `[project` never closes.
  writeD03("apps/a/pyproject.toml", '[project\nname = "a"\n');
  writeD03("apps/a/src/a_main.py", "import bpkg\nprint(bpkg.VALUE)\n");
  writeD03(
    "apps/b/pyproject.toml",
    '[project]\nname = "b"\ndependencies = ["c @ file:///not/root-anchored"]\n',
  );
  writeD03("apps/b/src/bpkg/__init__.py", "VALUE = 1\n");

  const d03Files = [
    "archkeep.json",
    "module-boundaries.config.mjs",
    "apps/a/pyproject.toml",
    "apps/a/src/a_main.py",
    "apps/b/pyproject.toml",
    "apps/b/src/bpkg/__init__.py",
  ];

  // The import still resolves — `bpkg` is the OTHER project, the one whose
  // manifest is fine — so this is a workspace whose imports work while one
  // manifest cannot be read. The malformed manifest must be the reason the
  // run fails, not a miss by the resolver.
  const d03Context = { cwd: d03Root, listFiles: () => d03Files };

  it("exits 3 instead of the 'no boundary violations, coverage complete' the finding reported", async () => {
    const out = [];
    const err = [];
    const streams = {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      ...d03Context,
    };
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("could not be analyzed at all");
    expect(report).toContain("apps/a/pyproject.toml");
    expect(report).toContain("not valid TOML");
    // The affirmative half of the old silent run — "no boundary violations,
    // coverage complete" — must not survive: the failure line may sit beside
    // a counted-imports line, but nothing may claim the run is complete.
    expect(report).not.toContain("coverage complete");
  });

  it("carries the unreadable manifest into the JSON envelope as a not-analyzed file", async () => {
    const { report } = await check({ format: "json", config: null, paths: [] }, d03Context);
    const envelope = JSON.parse(report);
    expect(envelope.coverage.complete).toBe(false);
    expect(envelope.coverage.notAnalyzed).toEqual([
      {
        file: "apps/a/pyproject.toml",
        reason:
          "its pyproject.toml cannot be fully read: its `pyproject.toml` is not valid TOML, so nothing it declares can be read",
      },
    ]);
    expect(envelope.status).toBe("no-verdict");
    expect(envelope.exitCode).toBe(EXIT.error);
    expect(envelope.decision.verdict).toBe("unknown");
    expect(envelope.decision.reason).toContain("coverage incomplete");
  });
});

describe("one tree, four languages — Go, Rust, Python and TypeScript in a single check (P0-polyglot)", () => {
  // The per-language e2e fixtures (`e2e/languages/`) prove each language alone;
  // this block proves the same engine analyses ALL of them in ONE check over
  // ONE tree, and draws graph edges for each language side by side. The trees
  // reuse the e2e fixtures' layered architecture (domain → application → api)
  // with a distinct language per project, so a language that stopped producing
  // records, a manifest edge, or a boundary verdict would go red here.
  //
  // Cross-language facts worth naming: the `application -> domain` edge is a
  // RUST Cargo `path = "../domain"` dependency landing on a GO project (the
  // resolver needs only the target's project root, not a Cargo manifest of its
  // own); `api -> application` is a PYTHON `[tool.uv.sources]` dependency
  // landing on a RUST project; `web -> api` is a TYPESCRIPT `@poly/api` import
  // landing on a PYTHON project. Each language's resolver sees only its own
  // projects for SOURCE imports, but the manifest edges cross the seams.
  const polyglotRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-combined-"));
  afterAll(() => rmSync(polyglotRoot, { recursive: true, force: true }));

  const writePoly = (relativePath, text) => {
    mkdirSync(join(polyglotRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(polyglotRoot, relativePath), text);
  };

  const buildTree = () => {
    writePoly("libs/domain/go.mod", "module example.test/domain\n\ngo 1.22\n");
    writePoly("libs/domain/value.go", 'package domain\n\nconst Name = "domain"\n');
    writePoly("libs/domain/src/index.ts", 'export const name: string = "domain";\n');
    writePoly(
      "libs/application/Cargo.toml",
      '[package]\nname = "application"\nversion = "0.1.0"\nedition = "2021"\n\n' +
        '[dependencies]\ndomain = { path = "../domain" }\n',
    );
    writePoly("libs/application/Cargo.lock", "");
    writePoly("libs/application/src/lib.rs", "use domain::Name;\n\npub const APP: &str = Name;\n");
    writePoly(
      "libs/application/src/index.ts",
      'import { name } from "@poly/domain";\n\nexport const app = name;\n',
    );
    writePoly(
      "libs/api/pyproject.toml",
      '[project]\nname = "api"\nversion = "0.1.0"\ndependencies = ["application"]\n\n' +
        "[tool.uv.sources]\napplication = { workspace = true }\n",
    );
    writePoly("libs/api/src/api/__init__.py", "from application import APP\n\nAPI = APP\n");
    writePoly(
      "libs/api/src/index.ts",
      'import { app } from "@poly/application";\n\nexport const api = app;\n',
    );
    // In the clean variant `web` is layer:api (api may reach api/application/
    // domain); in the api-crossing variant `web` is layer:domain, so this same
    // import violates the domain-only-on-domain row — a TypeScript site crossing
    // into a Python-managed project.
    writePoly(
      "libs/web/src/index.ts",
      'import { api } from "@poly/api";\n\nexport const web = api;\n',
    );
  };

  const writeModel = (webTag) => {
    writePoly(
      "archkeep.json",
      JSON.stringify({
        boundaryConfig: "module-boundaries.config.mjs",
        tsConfig: "tsconfig.json",
        projects: {
          declared: [
            { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
            { root: "libs/application", name: "application", tags: ["layer:application"] },
            { root: "libs/api", name: "api", tags: ["layer:api"] },
            { root: "libs/web", name: "web", tags: [webTag] },
          ],
        },
        coverage: {
          exempt: [
            {
              path: "module-boundaries.config.mjs",
              reason: "workspace tooling config at the root, not itself a project",
            },
          ],
        },
      }),
    );
    writePoly(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          paths: {
            "@poly/domain": ["./libs/domain/src/index.ts"],
            "@poly/application": ["./libs/application/src/index.ts"],
            "@poly/api": ["./libs/api/src/index.ts"],
          },
        },
      }),
    );
    writePoly(
      "module-boundaries.config.mjs",
      `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:application", onlyDependOnLibsWithTags: ["layer:application", "layer:domain"] },
  { sourceTag: "layer:api", onlyDependOnLibsWithTags: ["layer:api", "layer:application", "layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const boundarySuppressions = [];
`,
    );
  };

  buildTree();
  writeModel("layer:api");

  const polyglotStreams = (extra = {}) => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      cwd: polyglotRoot,
      // The fixture is not a git repo, so the file list is injected the same
      // way every other integration fixture here injects `listFiles` — the
      // native provider reads the tree off this list, not off git.
      listFiles: () => [
        "archkeep.json",
        "tsconfig.json",
        "module-boundaries.config.mjs",
        "libs/domain/go.mod",
        "libs/domain/value.go",
        "libs/domain/src/index.ts",
        "libs/application/Cargo.toml",
        "libs/application/Cargo.lock",
        "libs/application/src/lib.rs",
        "libs/application/src/index.ts",
        "libs/api/pyproject.toml",
        "libs/api/src/api/__init__.py",
        "libs/api/src/index.ts",
        "libs/web/src/index.ts",
      ],
      ...extra,
    };
  };

  it("exits 0 on the clean tree with all four languages analyzed and no crossings", async () => {
    const streams = polyglotStreams();
    expect(await runCli(["check", "--format", "json"], streams)).toBe(EXIT.ok);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.projects).toBe(4);
    // 4 source files with imports carry the analysis: the Go value.go has no
    // import, so the four importing files are application/lib.rs (Rust),
    // api/__init__.py (Python), and the three .ts indexes. The `.go`, `.rs`,
    // `.py` and `.ts` analyzers must ALL have run.
    expect(envelope.coverage.analyzedFiles).toBeGreaterThanOrEqual(6);
    expect(envelope.coverage.imports).toBeGreaterThanOrEqual(3);
    expect(envelope.result.violations).toEqual([]);
  });

  it("draws graph nodes and edges for every language in one run", async () => {
    const streams = polyglotStreams();
    expect(await runCli(["graph", "--format", "json"], streams)).toBe(EXIT.ok);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.result.projects.map((p) => p.name).sort()).toEqual([
      "api",
      "application",
      "domain",
      "web",
    ]);
    const edges = envelope.result.dependencies
      .map((e) => `${e.source}->${e.target}:${e.type}`)
      .sort();
    expect(edges).toContain("application->domain:static");
    expect(edges).toContain("api->application:static");
    expect(edges).toContain("web->api:static");
  });

  it("exits 1 on the crossing and names the TypeScript file that wrote it", async () => {
    // The same tree, one tag changed: `web` becomes layer:domain, so its
    // (clean-run-allowed) import of layer:api is a boundary crossing. The
    // checker must agree with the law — exit 1 — and pinpoint the TypeScript
    // site that wrote it.
    writeModel("layer:domain");
    const streams = polyglotStreams();
    expect(await runCli(["check", "--format", "json"], streams)).toBe(EXIT.violations);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.result.violations).toEqual([
      expect.objectContaining({
        sourceFile: "libs/web/src/index.ts",
        messageId: "onlyTagsConstraintViolation",
      }),
    ]);
  });
});

describe("a backslash path inside an otherwise-valid root is a loud could-not-look, never a clean run (P0-backslash)", () => {
  // `model.test.mjs` rejects a backslash in a project ROOT; this is the next
  // rung the audit asked to pin: a FILE REFERENCE written with backslashes
  // (`libs\core\src\index.ts`) inside a tree whose root is the valid
  // `libs/core`. On this tool's posix-style matching the backslash name is
  // byte-distinct from every `/`-joined path, so the declared root sees no
  // tracked file under it and the model refuses — exit 3, deterministically,
  // in every command that reads the tree. The red direction: if that refusal
  // ever became a silent normalization (or a drop), the same tree would exit
  // 0 with "no boundary violations" over a file the run never looked at.
  const backslashRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-backslash-"));
  afterAll(() => rmSync(backslashRoot, { recursive: true, force: true }));

  const writeBackslash = (relativePath, text) => {
    mkdirSync(join(backslashRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(backslashRoot, relativePath), text);
  };

  writeBackslash(
    "archkeep.json",
    JSON.stringify({
      boundaryConfig: "module-boundaries.config.mjs",
      projects: {
        declared: [{ root: "libs/core", name: "core", tags: ["layer:domain"] }],
      },
      coverage: {
        exempt: [
          {
            path: "module-boundaries.config.mjs",
            reason: "workspace tooling config at the root, not itself a project",
          },
        ],
      },
    }),
  );
  writeBackslash(
    "module-boundaries.config.mjs",
    `export const depConstraints = [];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );

  const backslashStreams = () => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      cwd: backslashRoot,
      // The literal filename on disk is `libs\core\src\index.ts` (a real
      // backslash character), exactly what `git ls-files` would report for a
      // Windows-checked-out tree. Injected because the fixture is not a repo.
      listFiles: () => [
        "archkeep.json",
        "module-boundaries.config.mjs",
        "libs\\core\\src\\index.ts",
      ],
    };
  };

  it("exits 3 for both check and graph, naming the unbacked root, identically across runs", async () => {
    const checkFirst = backslashStreams();
    const checkSecond = backslashStreams();
    expect(await runCli(["check"], checkFirst)).toBe(EXIT.error);
    expect(await runCli(["check"], checkSecond)).toBe(EXIT.error);
    const checkErr = checkFirst.lines.err.join("\n");
    expect(checkErr).toContain("root 'libs/core' has no tracked file under it");
    // Deterministic: two runs produce byte-identical refusal text. A run that
    // normalized the backslash sometimes and refused other times would break
    // the byte-identity contract the reports promise.
    expect(checkFirst.lines.err.join("\n")).toBe(checkSecond.lines.err.join("\n"));
    // Never a clean verdict over the file the run could not attribute.
    expect(checkFirst.lines.out.join("\n")).not.toContain("no boundary violations");

    const graphStreams = backslashStreams();
    expect(await runCli(["graph", "--format", "json"], graphStreams)).toBe(EXIT.error);
    expect(graphStreams.lines.err.join("\n")).toContain(
      "root 'libs/core' has no tracked file under it",
    );
  });
});

describe("dead rows of the boundary law", () => {
  // Issues #217 and #231: a `boundarySuppressions` row that accepts nothing
  // and a `depConstraints` row that selects nothing were both silent, while
  // the equivalent stale `coverage.exempt` row refused the whole run. This
  // suite drives the real engine over the issues' own four-file workspace
  // shape — native provider, two TS projects, one crossing import — and pins
  // the refusal, its exit code, its exemptions, and the false-positive guards
  // around it. Every case is red in the silent direction: delete the refusal
  // from cli.mjs and each dead-row case below goes green while the row sits
  // in the table unread.
  //
  // Each test writes its OWN law filename: a config module is loaded with
  // `import()`, Node caches it by URL, and a second test rewriting the same
  // path in the same process would silently run under the first test's law.
  const root = mkdtempSync(join(tmpdir(), "polyglot-cli-dead-rows-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const w = (relativePath, text) => {
    mkdirSync(join(root, relativePath, ".."), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  };

  w(
    "tsconfig.base.json",
    JSON.stringify({
      compilerOptions: { module: "ESNext", moduleResolution: "bundler", target: "ES2022" },
    }),
  );
  w("libs/feature/index.ts", 'export const feature = "feature";\n');
  w(
    "libs/core/index.ts",
    'import { feature } from "../feature/index.js";\nexport const core = feature;\n',
  );

  /** The eight options every policy must state. */
  const OPTIONS = [
    "export const moduleBoundaryOptions = {",
    "  allow: [],",
    "  buildTargets: [],",
    "  enforceBuildableLibDependency: false,",
    "  allowCircularSelfDependency: false,",
    "  checkDynamicDependenciesExceptions: [],",
    "  ignoredCircularDependencies: [],",
    "  banTransitiveDependencies: false,",
    "  checkNestedExternalImports: false,",
    "};",
  ].join("\n");

  /** Writes the declared projects plus one exempt row per extra tracked file. */
  const declare = (extraExempt = [], boundaryConfig) => {
    w(
      "archkeep.json",
      JSON.stringify({
        projects: {
          declared: [
            { root: "libs/core", name: "core", type: "lib", tags: ["layer:core"] },
            { root: "libs/feature", name: "feature", type: "lib", tags: ["layer:feature"] },
          ],
        },
        // The law's name is a per-workspace option (`src/options.mjs`), and
        // each test names ITS OWN module — a fixed default would miss files
        // that do not exist, and a shared one would collide with Node's
        // import() cache across tests.
        ...(boundaryConfig === undefined ? {} : { boundaryConfig }),
        coverage: {
          exempt: extraExempt.map((path) => ({ path, reason: "boundary law itself" })),
        },
      }),
    );
  };

  /** A fresh law module per call — a new URL each time, so no cached law leaks between tests. */
  let lawCounter = 0;
  const writeLaw = (body) => {
    const name = `law-${++lawCounter}.mjs`;
    w(name, `${body}\n${OPTIONS}\n`);
    declare([name], name);
    return name;
  };

  const streams = (tracked = []) => {
    const s = {
      out: (t) => s.lines.out.push(t),
      err: (t) => s.lines.err.push(t),
      lines: { out: [], err: [] },
      cwd: root,
      listFiles: () => [
        "archkeep.json",
        "tsconfig.base.json",
        "libs/core/index.ts",
        "libs/feature/index.ts",
        ...tracked,
      ],
    };
    return s;
  };

  it("#217: a permanent suppression covering nothing refuses the run, naming the row", async () => {
    const law = writeLaw(
      [
        "export const depConstraints = [",
        '  { sourceTag: "layer:core", onlyDependOnLibsWithTags: ["layer:core"] },',
        "];",
        "export const boundarySuppressions = [",
        '  { path: "libs/nothing/here/**", messageId: "noRelativeOrAbsoluteImportsAcrossLibraries", reason: "the code this covered is gone" },',
        "];",
      ].join("\n"),
    );
    const s = streams([law]);
    expect(await runCli(["check"], s)).toBe(EXIT.error);
    const err = s.lines.err.join("\n");
    expect(err).toContain("describes a workspace that does not match the tree:");
    expect(err).toContain("boundarySuppressions[0]: 'libs/nothing/here/**' matches no violation");
  });

  it("#216 end to end: suppressing the spelling verdict reveals the tag verdict behind it", async () => {
    // Issue #216's run 2 was exit 0 with an empty findings list while the edge
    // stayed in the tree. The same workspace now reports the constraint the
    // row had been hiding along with the spelling — exit 1, never 0 — and the
    // dead-row machinery stays quiet because this row IS doing work.
    const law = writeLaw(
      [
        "export const depConstraints = [",
        '  { sourceTag: "layer:core", onlyDependOnLibsWithTags: ["layer:core"] },',
        "];",
        "export const boundarySuppressions = [",
        '  { path: "libs/core/**", messageId: "noRelativeOrAbsoluteImportsAcrossLibraries", reason: "single-package repository" },',
        "];",
      ].join("\n"),
    );
    const s = streams([law]);
    expect(await runCli(["check"], s)).toBe(EXIT.violations);
    expect(s.lines.out.join("\n")).toContain("onlyTagsConstraintViolation");
    expect(s.lines.err.join("\n")).not.toContain("matches no violation");
  });

  it("#216 arithmetic end to end: a row covering only a hidden candidate is not stale", async () => {
    // The waiver surface measures each row against the raw candidate set:
    // with the spelling verdict removed by the first row, the second row's
    // hit sits BEHIND it in the chain — under the pre-#216 baseline (first
    // candidates only) that second row read as covering nothing while doing
    // real work. Both rows together still hide everything they name, so the
    // gate stays quiet; the run reports what remains.
    const law = writeLaw(
      [
        "export const depConstraints = [",
        '  { sourceTag: "layer:core", onlyDependOnLibsWithTags: ["layer:core"] },',
        "];",
        "export const boundarySuppressions = [",
        '  { path: "libs/core/**", messageId: "noRelativeOrAbsoluteImportsAcrossLibraries", reason: "spelling accepted" },',
        '  { path: "libs/core/**", messageId: "onlyTagsConstraintViolation", reason: "axis accepted" },',
        "];",
      ].join("\n"),
    );
    const s = streams([law]);
    expect(await runCli(["check"], s)).toBe(EXIT.ok);
    expect(s.lines.err.join("\n")).not.toContain("matches no violation");
  });

  it("an expired waiver covering nothing is refused; an active one resting is not", async () => {
    const law = (expiresAt) =>
      [
        "export const depConstraints = [];",
        "export const boundarySuppressions = [",
        expiresAt === null
          ? '  { path: "libs/nothing/here/**", reason: "idle" },'
          : `  { path: "libs/nothing/here/**", reason: "idle", expiresAt: "${expiresAt}" },`,
        "];",
      ].join("\n");
    // Expired: the term lapsed, the row can never come back into force, and
    // it accepts nothing — refused beside the permanent rows, named with its
    // lapse date.
    let name = writeLaw(law("2026-01-01T00:00:00.000Z"));
    const expiredStreams = streams([name]);
    expect(await runCli(["check"], expiredStreams)).toBe(EXIT.error);
    expect(expiredStreams.lines.err.join("\n")).toContain("(expired 2026-01-01T00:00:00.000Z)");

    // Active and idle: a fixed violation leaves its waiver waiting until
    // expiry — the documented lifecycle, informational via `archkeep waivers`,
    // never fatal here. The tree's crossing import still reports (exit 1).
    name = writeLaw(law("2099-01-01T00:00:00.000Z"));
    const activeStreams = streams([name]);
    expect(await runCli(["check"], activeStreams)).toBe(EXIT.violations);
    expect(activeStreams.lines.err.join("\n")).not.toContain("matches no violation");
  });

  it("a scoped run does not refuse a dead row it cannot know about", async () => {
    const law = writeLaw(
      [
        "export const depConstraints = [];",
        "export const boundarySuppressions = [",
        '  { path: "libs/nothing/here/**", messageId: "noRelativeOrAbsoluteImportsAcrossLibraries", reason: "the code this covered is gone" },',
        "];",
      ].join("\n"),
    );
    // One file: the run judges part of the tree, and a row covering nothing
    // in what it saw may cover plenty in what it did not. The in-scope
    // finding stands (exit 1); the refusal must not fire on top of it.
    const s = streams([law]);
    expect(await runCli(["check", "libs/core/index.ts"], s)).toBe(EXIT.violations);
    expect(s.lines.err.join("\n")).not.toContain("matches no violation");
  });

  it("#231: a sourceTag no project carries refuses the authored law", async () => {
    const law = writeLaw(
      [
        "export const depConstraints = [",
        '  { sourceTag: "layer:corre", onlyDependOnLibsWithTags: ["layer:core"] },',
        "];",
        "export const boundarySuppressions = [];",
      ].join("\n"),
    );
    const s = streams([law]);
    expect(await runCli(["check"], s)).toBe(EXIT.error);
    const err = s.lines.err.join("\n");
    expect(err).toContain("depConstraints[0]");
    expect(err).toContain("'layer:corre'");
    expect(err).toContain("selects no source");
  });

  it("#231: a notDependOnLibsWithTags entry naming no carried tag refuses the authored law", async () => {
    const law = writeLaw(
      [
        "export const depConstraints = [",
        '  { sourceTag: "layer:core", notDependOnLibsWithTags: ["grade:gonte"] },',
        "];",
        "export const boundarySuppressions = [];",
      ].join("\n"),
    );
    const s = streams([law]);
    expect(await runCli(["check"], s)).toBe(EXIT.error);
    expect(s.lines.err.join("\n")).toContain("notDependOnLibsWithTags[0]: 'grade:gonte'");
  });

  it("law read from node_modules — an adopted pack — is exempt from the dead-constraint refusal", async () => {
    // A shipped pack is data adopted wholesale (`docs/usage/presets.md`):
    // written for trees that instantiate its style at their own pace, so its
    // uninstantiated layers must not refuse the adopter's run. The exemption
    // is keyed on WHERE THE LAW LIVES — a dependency install — not on which
    // flag resolved it, which is why the pin goes through `--config`.
    const packLaw = join("node_modules", "style-pack", "law.mjs");
    w(
      packLaw,
      [
        "export const depConstraints = [",
        '  { sourceTag: "layer:someday", onlyDependOnLibsWithTags: ["layer:someday"] },',
        "];",
        OPTIONS,
        "export const boundarySuppressions = [];",
      ].join("\n"),
    );
    declare([packLaw], packLaw);
    const s = streams([packLaw]);
    expect(await runCli(["check", "--config", packLaw], s)).toBe(EXIT.violations);
    expect(s.lines.err.join("\n")).not.toContain("selects no source");
  });
});

// ---------------------------------------------------------------------------
// A declared-edge violation points at the file that really declares it
// ---------------------------------------------------------------------------

describe("a declared-edge finding names the declaring file of the provider that answered", () => {
  // A finding with no import site borrows its location from whatever declared
  // the edge, and every non-Nx provider used to borrow `archkeep.json` — which
  // a Moon workspace is REFUSED for carrying (`./commands/context.mjs`'s
  // `refusal(moonMarker, ARCHKEEP_MODEL_FILE)` exits 3 on a Moon tree that has
  // one). So the reported path provably could not exist on the tree it was
  // reported for, and the SARIF `uri` built from it is the shape GitHub's code
  // scanning drops in silence — an annotation that never appears on a run that
  // exits 1. #262 made this the common case rather than a corner: once Moon's
  // `explicit` was mapped to this package's `implicit`, every hand-written
  // `dependsOn` reaches the declared-edge path.
  //
  // Pinned as the exact rendered path and the exact SARIF `uri`, and both are
  // then resolved against the fixture on disk. A substring assertion over the
  // combined output is satisfied by the constraint message alone, which names
  // the two projects too — it goes green on the defect.
  const fixtures = [];
  afterAll(() => {
    for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  });

  const LAW = `export const depConstraints = [
  { sourceTag: "type-lib", onlyDependOnLibsWithTags: ["type-lib"] },
  { sourceTag: "type-app", onlyDependOnLibsWithTags: ["type-lib", "type-app"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const boundarySuppressions = [];
`;

  /** Writes `files` into a fresh temp root and returns it. */
  const workspace = (prefix, files) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    fixtures.push(dir);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  };

  const streamsOver = (cwd, tracked, graph) => {
    const streams = {
      out: (text) => streams.lines.out.push(text),
      err: (text) => streams.lines.err.push(text),
      lines: { out: [], err: [] },
      cwd,
      listFiles: () => tracked,
      ...(graph === undefined ? {} : { readGraph: () => graph }),
    };
    return streams;
  };

  /** The one SARIF result a declared-edge run produces. */
  const declaredEdgeResult = (sarifText) => {
    const results = JSON.parse(sarifText).runs[0].results;
    expect(results).toHaveLength(1);
    return results[0];
  };

  // A Moon tree: `core` is a lib, `cli` is an app, and `libs/core/moon.yml`
  // names `dependsOn: [cli]` with no import behind it — the shape
  // `docs/integrations/moon.md` documents as a declared-edge violation.
  const MOON_FILES = {
    ".moon/workspace.yml": "projects:\n  core: libs/core\n  cli: apps/cli\n",
    "module-boundaries.config.mjs": LAW,
    "libs/core/moon.yml":
      "id: core\nlanguage: typescript\nlayer: library\ntags:\n  - type-lib\ndependsOn:\n  - cli\n",
    "apps/cli/moon.yml": "id: cli\nlanguage: typescript\nlayer: application\ntags:\n  - type-app\n",
  };
  const MOON_TRACKED = Object.keys(MOON_FILES);
  const moonGraph = () => ({
    nodes: {
      core: { name: "core", type: "lib", data: { root: "libs/core", tags: ["type-lib"] } },
      cli: { name: "cli", type: "app", data: { root: "apps/cli", tags: ["type-app"] } },
    },
    // Archkeep's `implicit`, which is what `../src/providers/moon.mjs` maps
    // Moon's own `explicit` (hand-written `dependsOn`) onto.
    dependencies: { core: [{ source: "core", target: "cli", type: "implicit" }], cli: [] },
  });

  it("renders the owning moon.yml — a path that exists in the tree — never archkeep.json", async () => {
    const root = workspace("archkeep-declared-edge-moon-", MOON_FILES);
    const streams = streamsOver(root, MOON_TRACKED, moonGraph());
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("libs/core/moon.yml  onlyTagsConstraintViolation");
    // The defect's own output, byte for byte: a Moon tree cannot carry this
    // file, so a finding naming it points at nothing.
    expect(out).not.toContain("archkeep.json");
    // And the path is real. `toContain` above pins the spelling; this pins
    // that the spelling names something a reader can open.
    expect(existsSync(join(root, "libs/core/moon.yml"))).toBe(true);
  });

  it("says dependsOn, not implicitDependencies, on a provider that has no such field", async () => {
    const root = workspace("archkeep-declared-edge-moon-noun-", MOON_FILES);
    const streams = streamsOver(root, MOON_TRACKED, moonGraph());
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("a dependsOn edge crosses a boundary");
    expect(out).not.toContain("implicitDependencies");
  });

  it("emits a SARIF uri that is repository-relative and resolves in the tree", async () => {
    const root = workspace("archkeep-declared-edge-moon-sarif-", MOON_FILES);
    const streams = streamsOver(root, MOON_TRACKED, moonGraph());
    expect(await runCli(["check", "--format", "sarif"], streams)).toBe(EXIT.violations);
    const result = declaredEdgeResult(streams.lines.out.join("\n"));
    const uri = result.locations[0].physicalLocation.artifactLocation.uri;
    expect(uri).toBe("libs/core/moon.yml");
    // The three properties GitHub's code scanning silently drops a result for
    // failing — the same contract `./custom-rules/host.mjs`'s
    // `isWorkspaceRelative` holds a wasm rule's own findings to.
    expect(uri.startsWith("/")).toBe(false);
    expect(uri.split("/")).not.toContain("..");
    expect(existsSync(join(root, uri))).toBe(true);
  });

  it("still names archkeep.json on the native provider, whose declaration really lives there", async () => {
    // The other direction: the fix must not move a path that was already
    // right. A native row's `implicitDependencies` is validated off
    // `archkeep.json` wherever the row itself sits, so that file IS the
    // declaration site — and it exists on this tree.
    const root = workspace("archkeep-declared-edge-native-", {
      "archkeep.json": `${JSON.stringify({
        projects: {
          declared: [
            {
              name: "core",
              root: "libs/core",
              type: "lib",
              tags: ["type-lib"],
              implicitDependencies: ["cli"],
            },
            { name: "cli", root: "apps/cli", type: "app", tags: ["type-app"] },
          ],
        },
      })}\n`,
      "module-boundaries.config.mjs": LAW,
      "libs/core/README.md": "core\n",
      "apps/cli/README.md": "cli\n",
    });
    // The law is read off disk, not off the tracked list, and a native
    // workspace judges coverage over EVERY analyzable language — a tracked,
    // unowned `.mjs` at the root is an unclaimed-file failure that has
    // nothing to do with this test.
    const tracked = ["archkeep.json", "libs/core/README.md", "apps/cli/README.md"];
    const streams = streamsOver(root, tracked);
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("archkeep.json  onlyTagsConstraintViolation");
    expect(out).toContain("an implicitDependencies edge crosses a boundary");
    expect(existsSync(join(root, "archkeep.json"))).toBe(true);
  });

  it("still names the source project's own project.json on the Nx provider", async () => {
    // The Nx arm was the only one that ever derived a per-project path, and
    // it is the shape the Moon arm now copies — pinned so a later
    // simplification of the shared helper cannot quietly collapse it back to
    // a bare `project.json` at the root.
    const root = workspace("archkeep-declared-edge-nx-", {
      "nx.json": `${JSON.stringify({
        plugins: [
          {
            plugin: "@ecoma-io/archkeep/nx",
            options: { boundaryConfig: "module-boundaries.config.mjs" },
          },
        ],
      })}\n`,
      "module-boundaries.config.mjs": LAW,
      "libs/core/project.json": `${JSON.stringify({ name: "core", implicitDependencies: ["cli"] })}\n`,
      "apps/cli/project.json": `${JSON.stringify({ name: "cli" })}\n`,
    });
    const tracked = [
      "nx.json",
      "module-boundaries.config.mjs",
      "libs/core/project.json",
      "apps/cli/project.json",
    ];
    const streams = streamsOver(root, tracked, moonGraph());
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("libs/core/project.json  onlyTagsConstraintViolation");
    expect(out).toContain("an implicitDependencies edge crosses a boundary");
    expect(existsSync(join(root, "libs/core/project.json"))).toBe(true);
  });
});

describe("delta: capture → mutate → compare over a real fixture", () => {
  // Its own tree rather than the file's shared one, because these tests
  // MUTATE the workspace between capture and compare — the capture/compare
  // pair is the command's whole contract, and no other block's fixture may
  // change under it.
  const deltaRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-delta-"));
  afterAll(() => rmSync(deltaRoot, { recursive: true, force: true }));

  const writeDelta = (relativePath, text) => {
    mkdirSync(join(deltaRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(deltaRoot, relativePath), text);
  };

  writeDelta(
    "nx.json",
    `${JSON.stringify({
      plugins: [
        {
          plugin: "@ecoma-io/archkeep/nx",
          options: { boundaryConfig: "module-boundaries.config.mjs" },
        },
      ],
    })}\n`,
  );
  writeDelta(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer-kernel", onlyDependOnLibsWithTags: ["layer-kernel"] },
  { sourceTag: "layer-outer", onlyDependOnLibsWithTags: ["layer-outer", "layer-kernel"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: [],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeDelta("libs/kernel/go.mod", "module example.invalid/kernel\n\ngo 1.24\n");
  writeDelta("libs/kernel/kernel.go", 'package kernel\n\nconst Name = "kernel"\n');
  writeDelta("libs/outer/go.mod", "module example.invalid/outer\n\ngo 1.24\n");
  writeDelta("libs/outer/outer.go", 'package outer\n\nconst Name = "outer"\n');

  const deltaGraph = {
    nodes: {
      kernel: {
        name: "kernel",
        type: "lib",
        data: { root: "libs/kernel", tags: ["layer-kernel"] },
      },
      outer: {
        name: "outer",
        type: "lib",
        data: { root: "libs/outer", tags: ["layer-outer"] },
      },
    },
    dependencies: { kernel: [], outer: [] },
  };

  const deltaFiles = [
    "nx.json",
    "module-boundaries.config.mjs",
    "libs/kernel/go.mod",
    "libs/kernel/kernel.go",
    "libs/outer/go.mod",
    "libs/outer/outer.go",
  ];

  const deltaEnv = (files = deltaFiles) => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      cwd: deltaRoot,
      readGraph: () => deltaGraph,
      listFiles: () => files,
    };
  };

  const baselinePath = join(deltaRoot, "delta-base.json");

  it("captures a baseline at base and reports an unchanged tree as a verifiable clean claim", async () => {
    const capture = deltaEnv();
    expect(await runCli(["delta", "--capture", "--output", baselinePath], capture)).toBe(EXIT.ok);
    expect(capture.lines.err.join("\n")).toContain("delta baseline captured");
    expect(existsSync(baselinePath)).toBe(true);

    // The same tree against its own baseline: exit 0, and the report states
    // WHAT was compared rather than printing bare silence.
    const compare = deltaEnv();
    expect(await runCli(["delta", baselinePath], compare)).toBe(EXIT.ok);
    const text = compare.lines.out.join("\n");
    expect(text).toContain("✔ no introduced violations — compared baseline");
    expect(text).toMatch(/2 projects\)/u);
  });

  it("classifies a violation the mutation introduced, at the site that wrote it, exit 1", async () => {
    // The mutation: the kernel starts importing the outer layer, which the
    // law above forbids. Real file, real analyzer, real rules — only Nx and
    // git are injected.
    writeDelta(
      "libs/kernel/reach.go",
      'package kernel\n\nimport (\n\t"example.invalid/outer"\n)\n\nvar _ = outer.Name\n',
    );
    const mutatedFiles = [...deltaFiles, "libs/kernel/reach.go"];

    const compare = deltaEnv(mutatedFiles);
    expect(await runCli(["delta", baselinePath], compare)).toBe(EXIT.violations);
    const text = compare.lines.out.join("\n");
    expect(text).toContain("⚠ 1 introduced violation");
    expect(text).toContain("kernel → outer  onlyTagsConstraintViolation");
    expect(text).toContain("at libs/kernel/reach.go:4:2");

    const json = deltaEnv(mutatedFiles);
    expect(await runCli(["delta", baselinePath, "--format", "json"], json)).toBe(EXIT.violations);
    const envelope = JSON.parse(json.lines.out.join("\n"));
    expect(envelope.command).toBe("delta");
    expect(envelope.status).toBe("findings");
    expect(envelope.exitCode).toBe(1);
    expect(envelope.result.summary.introduced).toBe(1);
    expect(envelope.result.violations.introduced[0]).toMatchObject({
      messageId: "onlyTagsConstraintViolation",
      sourceProject: "kernel",
      target: "outer",
    });
  });

  it("classifies the reverse run as resolved, never as clean silence", async () => {
    // A baseline captured over the VIOLATING tree, compared against the clean
    // one: the base side of the re-judgment must produce the violation from
    // the stored snapshot — the silent-direction case, held end to end.
    const violatingFiles = [...deltaFiles, "libs/kernel/reach.go"];
    const violatingBase = join(deltaRoot, "delta-base-violating.json");
    const capture = deltaEnv(violatingFiles);
    expect(await runCli(["delta", "--capture", "--output", violatingBase], capture)).toBe(EXIT.ok);

    const compare = deltaEnv();
    expect(await runCli(["delta", violatingBase], compare)).toBe(EXIT.ok);
    const text = compare.lines.out.join("\n");
    expect(text).toContain("✔ 1 resolved violation");
    expect(text).toContain("kernel → outer  onlyTagsConstraintViolation");
  });

  it("renders the introduced finding as SARIF end to end: capture, mutate, compare with --format sarif", async () => {
    // Same mutation as the exit-1 test above — the head tree still carries
    // libs/kernel/reach.go — so this pins the third face of the same verdict.
    const mutatedFiles = [...deltaFiles, "libs/kernel/reach.go"];
    const compare = deltaEnv(mutatedFiles);
    expect(await runCli(["delta", baselinePath, "--format", "sarif"], compare)).toBe(
      EXIT.violations,
    );
    const log = JSON.parse(compare.lines.out.join("\n"));
    expect(log.version).toBe("2.1.0");
    expect(log.runs[0].columnKind).toBe("utf16CodeUnits");
    // The exit-1 red case, end to end: a gate exiting 1 must never upload an
    // empty results array.
    expect(log.runs[0].results.length).toBeGreaterThan(0);
    const [result] = log.runs[0].results;
    expect(result.ruleId).toBe("onlyTagsConstraintViolation");
    expect(log.runs[0].tool.driver.rules[result.ruleIndex].id).toBe(result.ruleId);
    expect(result.message.text).toContain("0 occurrences at base");
    const { artifactLocation, region } = result.locations[0].physicalLocation;
    expect(artifactLocation.uri).toBe("libs/kernel/reach.go");
    expect(artifactLocation.uri.split("/")).not.toContain("..");
    expect(region).toEqual({ startLine: 4, startColumn: 2 });
    expect(result.properties).toMatchObject({ delta: "introduced", baseCount: 0, headCount: 1 });
    expect(log.runs[0].invocations[0].executionSuccessful).toBe(true);
  });

  it("writes the SARIF to --output, ready for upload-sarif, with the exit code unchanged", async () => {
    const mutatedFiles = [...deltaFiles, "libs/kernel/reach.go"];
    const sarifPath = join(deltaRoot, "delta.sarif");
    const compare = deltaEnv(mutatedFiles);
    expect(
      await runCli(["delta", baselinePath, "--format", "sarif", "--output", sarifPath], compare),
    ).toBe(EXIT.violations);
    expect(compare.lines.err.join("\n")).toContain("delta complete");
    const log = JSON.parse(readFileSync(sarifPath, "utf8"));
    expect(log.runs[0].results.length).toBeGreaterThan(0);
  });

  it("still rejects sarif on the descriptive verbs — delta is the only one that gained it", async () => {
    // `graph` and `diff` produce no findings, and SARIF's results[] is a
    // findings container (`DELTA_FORMATS`' comment in ../cli.mjs).
    for (const verb of [["graph"], ["diff", baselinePath]]) {
      const streams = deltaEnv();
      expect(await runCli([...verb, "--format", "sarif"], streams)).toBe(EXIT.usage);
      expect(streams.lines.err.join("\n")).toContain("unknown format 'sarif'");
    }
  });

  it("refuses a baseline that is not an evidence snapshot, exit 3, naming the file", async () => {
    const junk = join(deltaRoot, "not-a-snapshot.json");
    writeFileSync(junk, '{"schemaVersion": 999}\n');
    const compare = deltaEnv();
    expect(await runCli(["delta", junk], compare)).toBe(EXIT.error);
    expect(compare.lines.err.join("\n")).toContain("not-a-snapshot.json");
  });

  it("holds the spawned usage contract: missing baseline, extra positional, unknown flag — all exit 2", () => {
    const spawnDelta = (args) =>
      spawnSync(process.execPath, [CLI, "delta", ...args], {
        cwd: deltaRoot,
        encoding: "utf8",
        timeout: SPAWN_BUDGET_MS,
        killSignal: "SIGKILL",
      });

    const missing = spawnDelta([]);
    expect(missing.status).toBe(EXIT.usage);
    expect(missing.stderr).toContain("exactly one positional argument");

    const extra = spawnDelta(["one.json", "two.json"]);
    expect(extra.status).toBe(EXIT.usage);

    const capturePositional = spawnDelta(["--capture", "stray.json"]);
    expect(capturePositional.status).toBe(EXIT.usage);
    expect(capturePositional.stderr).toContain("--capture takes no positional arguments");

    const typo = spawnDelta(["--fromat", "json", "base.json"]);
    expect(typo.status).toBe(EXIT.usage);
    expect(typo.stderr).toContain("unknown option '--fromat'");
  });
});

describe("delta: custom-rule findings, end to end with a committed reference rule", () => {
  // Its own fixture tree (the shared delta one above must keep its
  // no-custom-rules byte-compat claims), with the Go SDK's committed
  // reference artifact copied in and declared by digest — the same file the
  // cross-SDK conformance gate proves (`./conformance/rule-sdks.mjs`).
  const customRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-delta-custom-"));
  afterAll(() => rmSync(customRoot, { recursive: true, force: true }));

  const referenceWasm = fileURLToPath(
    new URL("../../archkeep-rule-sdk-go/examples/forbidden_tag_dependency.wasm", import.meta.url),
  );
  const referenceSha256 = readFileSync(`${referenceWasm}.sha256`, "utf8").trim();

  const writeCustom = (relativePath, contents) => {
    mkdirSync(join(customRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(customRoot, relativePath), contents);
  };

  writeCustom(
    "nx.json",
    `${JSON.stringify({
      plugins: [
        {
          plugin: "@ecoma-io/archkeep/nx",
          options: { boundaryConfig: "module-boundaries.config.mjs" },
        },
      ],
    })}\n`,
  );
  writeCustom(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer-kernel", onlyDependOnLibsWithTags: ["*"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: [],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const customRules = [
  {
    name: "forbidden-tag-dependency",
    artifact: "tools/rules/forbidden-tag-dependency.wasm",
    sha256: "${referenceSha256}",
    reason: "nothing may depend on the infra layer",
    params: { forbiddenTag: "layer-infra", exemptTags: [] },
  },
];
`,
  );
  writeCustom("tools/rules/forbidden-tag-dependency.wasm", readFileSync(referenceWasm));
  writeCustom("libs/kernel/go.mod", "module example.invalid/kernel\n\ngo 1.24\n");
  writeCustom("libs/kernel/kernel.go", 'package kernel\n\nconst Name = "kernel"\n');
  writeCustom("libs/infra/go.mod", "module example.invalid/infra\n\ngo 1.24\n");
  writeCustom("libs/infra/infra.go", 'package infra\n\nconst Name = "infra"\n');

  const graphOf = (withEdge) => ({
    nodes: {
      kernel: {
        name: "kernel",
        type: "lib",
        data: { root: "libs/kernel", tags: ["layer-kernel"] },
      },
      infra: {
        name: "infra",
        type: "lib",
        data: { root: "libs/infra", tags: ["layer-infra"] },
      },
    },
    dependencies: {
      kernel: withEdge ? [{ source: "kernel", target: "infra", type: "static" }] : [],
      infra: [],
    },
  });

  const customFiles = [
    "nx.json",
    "module-boundaries.config.mjs",
    "tools/rules/forbidden-tag-dependency.wasm",
    "libs/kernel/go.mod",
    "libs/kernel/kernel.go",
    "libs/infra/go.mod",
    "libs/infra/infra.go",
  ];

  const customEnv = (withEdge) => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      cwd: customRoot,
      readGraph: () => graphOf(withEdge),
      listFiles: () => customFiles,
    };
  };

  const customBaseline = join(customRoot, "delta-base.json");

  it("captures the custom-rule blocks and classifies an introduced custom finding as exit 1", async () => {
    // Capture at a base with no kernel → infra edge: the reference rule
    // passes there. The snapshot must carry the two blocks.
    const capture = customEnv(false);
    expect(await runCli(["delta", "--capture", "--output", customBaseline], capture)).toBe(EXIT.ok);
    const snapshot = JSON.parse(readFileSync(customBaseline, "utf8"));
    expect(snapshot.customRules).toEqual([
      {
        name: "forbidden-tag-dependency",
        artifact: "tools/rules/forbidden-tag-dependency.wasm",
        sha256: referenceSha256,
        params: { forbiddenTag: "layer-infra", exemptTags: [] },
      },
    ]);
    expect(Array.isArray(snapshot.owned)).toBe(true);

    // Head grows the edge into the forbidden tag: the boundary law allows it
    // ("*"), so ONLY the custom rule can catch it — the delta that was
    // invisible before this feature (the silent direction, held end to end).
    const compare = customEnv(true);
    expect(await runCli(["delta", customBaseline, "--format", "json"], compare)).toBe(
      EXIT.violations,
    );
    const envelope = JSON.parse(compare.lines.out.join("\n"));
    expect(envelope.status).toBe("findings");
    expect(envelope.result.summary.introduced).toBe(0);
    expect(envelope.result.summary.customFindings.introduced).toBe(1);
    expect(envelope.result.customRules.findings.introduced[0]).toMatchObject({
      ruleId: "custom/forbidden-tag-dependency/dependency-on-forbidden-tag",
      project: "kernel",
    });

    const text = customEnv(true);
    expect(await runCli(["delta", customBaseline], text)).toBe(EXIT.violations);
    expect(text.lines.out.join("\n")).toContain("1 introduced custom finding");
  });

  it("answers exit 3 against a baseline captured without custom-rule evidence", async () => {
    // A baseline whose capturing policy declared no rules: every declared
    // head rule must classify unknown rather than the absence reading as
    // "no custom findings existed at base".
    const oldBaseline = JSON.parse(readFileSync(customBaseline, "utf8"));
    delete oldBaseline.customRules;
    delete oldBaseline.owned;
    const oldPath = join(customRoot, "delta-base-old.json");
    writeFileSync(oldPath, `${JSON.stringify(oldBaseline, null, 2)}\n`);

    const compare = customEnv(false);
    expect(await runCli(["delta", oldPath], compare)).toBe(EXIT.error);
    expect(compare.lines.out.join("\n")).toContain("re-capture the baseline");
  });
});

describe("an unreadable JVM source refuses the run (#374)", () => {
  // The issue's own tree: `app` imports `com.example.domain.Policy` across a
  // law that forbids it, and the ONE tracked file declaring that package is
  // unreadable — a dangling symlink, one of #374's named causes, which the
  // containment check passes because its deepest existing ancestor is inside
  // the root while the read itself returns null. Only Nx and git are
  // injected; the unreadable bytes are real files on disk, so what is pinned
  // here is the whole path a consumer's `check` takes.
  const jvmRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-jvm-unreadable-"));
  afterAll(() => rmSync(jvmRoot, { recursive: true, force: true }));

  const writeJvm = (relativePath, text) => {
    mkdirSync(join(jvmRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(jvmRoot, relativePath), text);
  };

  writeJvm(
    "nx.json",
    `${JSON.stringify({
      plugins: [
        {
          plugin: "@ecoma-io/archkeep/nx",
          options: { boundaryConfig: "module-boundaries.config.mjs" },
        },
      ],
    })}\n`,
  );
  // The law forbids exactly what the fixture imports: layer:app reaching
  // layer:domain. With the declaration READABLE this tree is a finding
  // (exit 1) — the readable twin of this fixture is what makes the refusal
  // below provably about the read, not about the law.
  writeJvm(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:app"] },
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: [],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
  );
  writeJvm(
    "libs/app/src/main/java/com/example/app/Service.java",
    "package com.example.app;\n\nimport com.example.domain.Policy;\n\nclass Service {\n  Policy policy;\n}\n",
  );
  // The tracked-but-unreadable declaration: Policy.java -> nowhere.java.
  mkdirSync(join(jvmRoot, "libs/domain/src/main/java/com/example/domain"), { recursive: true });
  symlinkSync(
    join(jvmRoot, "libs/domain/src/main/java/com/example/domain/nowhere.java"),
    join(jvmRoot, "libs/domain/src/main/java/com/example/domain/Policy.java"),
  );

  const jvmContext = {
    cwd: jvmRoot,
    readGraph: () => ({
      nodes: {
        app: { name: "app", type: "lib", data: { root: "libs/app", tags: ["layer:app"] } },
        domain: {
          name: "domain",
          type: "lib",
          data: { root: "libs/domain", tags: ["layer:domain"] },
        },
      },
      dependencies: { app: [], domain: [] },
    }),
    listFiles: () => [
      "nx.json",
      "module-boundaries.config.mjs",
      "libs/app/src/main/java/com/example/app/Service.java",
      "libs/domain/src/main/java/com/example/domain/Policy.java",
    ],
  };

  const jvmEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      ...jvmContext,
    };
  };

  it("refuses a scoped run that excludes the unreadable file, naming it", async () => {
    // The silent direction, held end to end. Before the funnel this exact
    // run exited 0: the analyzer track never saw the file (out of the
    // requested scope), the package index dropped it without a word, every
    // import of com.example.domain classified external, and no verdict named
    // the crossing — byte-for-byte indistinguishable from a clean tree.
    const streams = jvmEnv();
    expect(await runCli(["check", "libs/app"], streams)).toBe(EXIT.error);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("libs/domain/src/main/java/com/example/domain/Policy.java");
    expect(report).toContain("JVM source could not be read for the package index");
  });

  it("composes with the analyzer track's own whole-file failure, as the .NET twin does", async () => {
    // Unscoped, the same unreadable file is heard by BOTH tracks — the
    // analyzer's own "could not be read" and the package index's row for
    // the same file. The funnel states the fact once: the run still
    // refuses, and the report names the file in ONE row rather than
    // counting the same unreadable file twice (`dedupeWholeFileFailures`
    // in `../analysis/source-util.mjs`). The scoped run above still
    // carries the index's own sentence, because there it is the only
    // witness.
    const streams = jvmEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("could not be read");
    expect(report.match(/Policy\.java/g)).toHaveLength(1);
  });

  it("reports the crossing itself once the declaration is readable — the refusal is about the read", async () => {
    // The control: the SAME tree with the symlink replaced by the bytes it
    // stood for turns the run into the finding it always should have been,
    // proving the two refusals above name the unreadable declaration, not a
    // broken fixture.
    rmSync(join(jvmRoot, "libs/domain/src/main/java/com/example/domain/Policy.java"));
    writeJvm(
      "libs/domain/src/main/java/com/example/domain/Policy.java",
      "package com.example.domain;\n\npublic class Policy {}\n",
    );
    const streams = jvmEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("libs/app/src/main/java/com/example/app/Service.java");
  });
});

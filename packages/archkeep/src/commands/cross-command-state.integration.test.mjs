// Cross-command state identity: the invariants that hold BETWEEN commands,
// which no single command's own suite can pin. Each command's tests prove the
// command answers its own question; this file proves the answers agree — that
// `diff`, `delta` and `evolution` name one changed edge with one spelling,
// that `impact`/`scenario`'s alignment names what the events name, that a
// snapshot's identity survives the hand-off from the command that wrote it to
// the commands that read it, and that `check` and `reconcile` judge one intent
// file to one verdict.
//
// Why this file exists (`#590`): every one of these invariants was violated or
// unpinned at some point — the evolution envelope once carried TWO edge
// spellings (`→` and `>`) and every command-local test stayed green, because
// nothing compared the vocabularies to each other. A regression that lands
// between commands lands green today unless a test spans them.
//
// The invariants are numbered e1–e7 as `#590` lists them. e8 (a fully-attested
// decision reaching `provenanceCoverage` 1 / a reachable `overallComplete`)
// is NOT here: it is a derivation-soundness case against
// `deriveEvidenceGates`, owned with the evidence-gate fix, not with identity.
//
// The fixture is a REAL git repository through the native provider — the same
// arrangement `./evolution.cli.integration.test.mjs` argues for: the mechanism
// under test includes git's own behavior, and no stub can prove the
// cross-command half.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EXIT, runCli } from "../../cli.mjs";
import { edgeEvolutionIdentity } from "../governance/evolution-event.mjs";
import { snapshotIdentity } from "./history.mjs";
import { environmentForTree } from "../workspace.mjs";
import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../../spawn-budget.mjs";

vi.setConfig({ testTimeout: SPAWN_TEST_BUDGET_MS });

/** The canonical identity of the fixture's one crossing edge, spelled once. */
const CROSSING = edgeEvolutionIdentity({
  source: "alpha",
  target: "beta",
  type: "static",
});

/**
 * The virtual edge the scenario's `dependency_added` must create. The e3
 * change below needs this to be a real edge in the scenario alignment — the
 * assertion naming it is RED until the change carries `edgeType`, because a
 * refused change never produces the edge (#598).
 */
const VIRTUAL = edgeEvolutionIdentity({
  source: "beta",
  target: "alpha",
  type: "static",
});

/**
 * Runs git in `cwd` through the same environment guard production uses, with
 * the single-spawn budget on every child (the same arrangement
 * `./evolution.cli.integration.test.mjs` states in full).
 */
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    env: environmentForTree(),
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
  });

/** Identity flags keeping every fixture commit independent of the machine. */
const GIT_IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

const ONE_ROW = '  { sourceTag: "layer:a", onlyDependOnLibsWithTags: ["layer:b"] },';
/** The eight options a valid boundary law must carry, per `policyFrom`. */
const OPTIONS = `export const moduleBoundaryOptions = {
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
const law = (rows) => `export const depConstraints = [\n${rows}\n];\n${OPTIONS}`;

const MODEL = () =>
  JSON.stringify(
    {
      projects: {
        declared: [
          { root: "libs/alpha", name: "alpha", tags: ["layer:a"] },
          { root: "libs/beta", name: "beta", tags: ["layer:b"] },
        ],
      },
      coverage: {
        exempt: [{ path: "module-boundaries.config.mjs", reason: "the workspace's own law" }],
      },
    },
    null,
    2,
  );

const ALPHA_CLEAN = `package alpha

func Name() string { return "alpha" }
`;
const ALPHA_REACHING = `package alpha

import "example.com/beta"

func Name() string { return "alpha" + beta.Suffix() }
`;
const BETA = `package beta

func Suffix() string { return "-beta" }
`;

let root;
/** The timeline's commit SHAs — declared together, assigned in `beforeAll`. @type {{c1: string, c2: string}} */
let shas;
let baselinePath;
let graphPath;

/** Writes `text` to `relativePath` under the fixture root. */
const write = (relativePath, text) => {
  mkdirSync(join(root, relativePath, ".."), { recursive: true });
  writeFileSync(join(root, relativePath), text);
};

/** Stages everything in `tree` and commits; returns the SHA. */
const commitIn = (tree, message) => {
  git(tree, ...GIT_IDENTITY, "add", "-A");
  git(tree, ...GIT_IDENTITY, "commit", "-q", "-m", message);
  return git(tree, "rev-parse", "HEAD").trim();
};

/** Stages everything in the main fixture and commits; returns the SHA. */
const commit = (message) => commitIn(root, message);

/** Checks out a commit by SHA. */
const checkout = (sha) => {
  git(root, "checkout", "-q", sha);
};

/** Drives the CLI in-process over the fixture, capturing streams. */
const arch = async (argv) => {
  const out = [];
  const err = [];
  const exitCode = await runCli(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: root,
  });
  return { exitCode, out: out.join("\n"), err: err.join("\n"), json: null };
};

/** `arch` + JSON parse of the envelope on stdout. */
const archJson = async (argv) => {
  const run = await arch(argv);
  return { ...run, envelope: JSON.parse(run.out) };
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "archkeep-cross-command-"));
  git(root, "init", "-q", "-b", "main");

  write("archkeep.json", `${MODEL()}\n`);
  write("module-boundaries.config.mjs", law(ONE_ROW));
  write("libs/alpha/go.mod", "module example.com/alpha\n\ngo 1.22\n");
  write("libs/alpha/alpha.go", ALPHA_CLEAN);
  write("libs/beta/go.mod", "module example.com/beta\n\ngo 1.22\n");
  write("libs/beta/beta.go", BETA);
  const c1 = commit("introduce the two-project architecture");

  write("libs/alpha/alpha.go", ALPHA_REACHING);
  const c2 = commit("alpha reaches beta");
  shas = { c1, c2 };

  // The evidence artifacts: both captured at C1, the commit whose tree the
  // rest of the timeline is compared against — the graph snapshot `diff`
  // reads and the delta baseline `delta` reads (two formats, two capture
  // commands; neither format is the other's input).
  checkout(shas.c1);
  baselinePath = join(root, "..", "cross-command-baseline.json");
  const capture = await arch(["delta", "--capture", "--output", baselinePath]);
  expect(capture.exitCode).toBe(EXIT.ok);
  graphPath = join(root, "..", "cross-command-graph.json");
  const graphRun = await arch(["graph", "--format", "json", "--output", graphPath]);
  expect(graphRun.exitCode).toBe(EXIT.ok);
  checkout(shas.c2);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  rmSync(join(root ?? "", "..", "cross-command-baseline.json"), { force: true });
  rmSync(join(root ?? "", "..", "cross-command-graph.json"), { force: true });
});

describe("e1 — one edge, one spelling across diff, delta and the delta event", () => {
  it("diff names the added edge by its raw triple, which maps to the canonical identity", async () => {
    const run = await archJson(["diff", graphPath, "--format", "json"]);
    expect(run.exitCode).toBe(EXIT.ok);
    const { addedEdges } = run.envelope.result;
    expect(addedEdges).toHaveLength(1);
    expect(edgeEvolutionIdentity(addedEdges[0])).toBe(CROSSING);
  });

  it("delta's affected.boundaries spell the same edge the diff's triple maps to", async () => {
    const run = await archJson(["delta", baselinePath, "--format", "json"]);
    expect(run.exitCode).toBe(EXIT.ok);
    // Edge-only transition: the classification's boundary set IS the edge set.
    expect(run.envelope.result.affected.boundaries).toEqual([CROSSING]);
  });

  it("the delta event's observed edges and affected.boundaries carry one vocabulary", async () => {
    const eventDir = mkdtempSync(join(tmpdir(), "archkeep-cross-command-events-"));
    try {
      const run = await arch(["delta", baselinePath, "--event-out", eventDir]);
      expect(run.exitCode).toBe(EXIT.ok);
      const names = readdirSync(eventDir).filter((name) => name.endsWith(".json"));
      expect(names).toHaveLength(1);
      const event = JSON.parse(readFileSync(join(eventDir, names[0]), "utf8"));
      // The event is the stored record other commands read back; its two
      // vocabularies must agree BY VALUE, not by a per-reader re-mapping.
      expect(event.observed.edges.added).toEqual([CROSSING]);
      expect(event.affected.boundaries).toEqual([CROSSING]);
    } finally {
      rmSync(eventDir, { recursive: true, force: true });
    }
  });
});

describe("e2 — the evolution summary agrees with its own transitions", () => {
  let envelope;

  beforeAll(async () => {
    const run = await archJson(["evolution", "--base", shas.c1, "--format", "json"]);
    expect(run.exitCode).toBe(EXIT.ok);
    envelope = run.envelope;
  });

  it("each transition's observed edges and affected.boundaries are the same strings", () => {
    const [transition] = envelope.result.transitions;
    // Per-transition observed edges stay RAW `{source,target,type}` triples;
    // only the summary maps them to canonical strings. The comparison goes
    // through the one identity function rather than assuming either spelling.
    expect(transition.comparison.observed.edges.added.map(edgeEvolutionIdentity)).toEqual([
      CROSSING,
    ]);
    expect(transition.comparison.affected.boundaries).toContain(CROSSING);
  });

  it("the summary's union and the transitions' per-transition sets agree", () => {
    const { summary } = envelope.result;
    expect(summary.observed.edges.added).toEqual([CROSSING]);
    // `affected.boundaries` unions added AND removed edges per transition, so
    // for this one-edge timeline the union is the one edge either way.
    expect(summary.affected.boundaries).toEqual([CROSSING]);
  });
});

describe("e3 — impact and scenario alignments name what the events name", () => {
  it("impact's evolutionAlignment.boundaries spell the crossing edge canonically", async () => {
    // Impact constrains per DEPENDENT: `computeImpactConstraints` keys its
    // entries by dependent and the rows name the edges INTO the target, so
    // the alpha→beta edge is visible from `beta`'s alignment — alpha is its
    // one dependent.
    const run = await archJson(["impact", "beta", "--format", "json"]);
    expect(run.exitCode).toBe(EXIT.ok);
    expect(run.envelope.result.impactStatement.evolutionAlignment.boundaries).toContain(CROSSING);
  });

  it("scenario's evolutionAlignment.boundaries agree with impact's on both sides", async () => {
    // A change that APPLIES — `edgeType` is what makes `dependency_added`
    // apply rather than refuse (#598) — and leaves the alpha→beta edge
    // standing, so both sides of the comparison are expected to name the
    // same crossing edge the events name.
    const scenarioFile = join(root, "..", "cross-command-scenario.json");
    writeFileSync(
      scenarioFile,
      `${JSON.stringify(
        {
          changes: [
            { type: "dependency_added", source: "beta", target: "alpha", edgeType: "static" },
          ],
        },
        null,
        2,
      )}\n`,
    );
    try {
      const run = await archJson([
        "scenario",
        "beta",
        "--scenario-file",
        scenarioFile,
        "--format",
        "json",
      ]);
      expect(run.exitCode).toBe(EXIT.ok);
      // The change applied (#598): a refused change leaves `refused`
      // populated, and every alignment assertion below would then pass off
      // the standing edge alone — the exact way this test stayed green while
      // pinning nothing.
      expect(run.envelope.result.refused).toBeUndefined();
      expect(run.envelope.result.current.evolutionAlignment.boundaries).toContain(CROSSING);
      expect(run.envelope.result.scenario.evolutionAlignment.boundaries).toContain(CROSSING);
    } finally {
      rmSync(scenarioFile, { force: true });
    }
  });

  it("the applied direction lands in the TARGET side's alignment (#598)", async () => {
    // The alignment names edges INTO the target (`buildEvolutionAlignment`
    // reads them off `computeImpactConstraints`, which keys its rows by
    // dependent), so the beta→alpha virtual edge never reaches `scenario
    // beta`'s alignment — it reaches `scenario alpha`'s, where beta is a
    // dependent and beta→alpha is an edge into the target. Asserting it
    // there is the applied-direction pin, and it stays RED without
    // `edgeType`: a refused `dependency_added` adds no dependent, so no
    // alignment boundary over this edge can exist, and the before-state
    // assertion below shows the alignment named none of it beforehand.
    const scenarioFile = join(root, "..", "cross-command-scenario-applied.json");
    writeFileSync(
      scenarioFile,
      `${JSON.stringify(
        {
          changes: [
            { type: "dependency_added", source: "beta", target: "alpha", edgeType: "static" },
          ],
        },
        null,
        2,
      )}\n`,
    );
    try {
      const run = await archJson([
        "scenario",
        "alpha",
        "--scenario-file",
        scenarioFile,
        "--format",
        "json",
      ]);
      expect(run.exitCode).toBe(EXIT.ok);
      expect(run.envelope.result.refused).toBeUndefined();
      // Before: nobody depends on alpha, so the alignment names no boundary
      // over this edge — the before-state that makes the assertion below
      // load-bearing rather than vacuous.
      expect(run.envelope.result.current.evolutionAlignment.boundaries).not.toContain(VIRTUAL);
      // After: beta is a dependent and beta→alpha is an edge into the
      // target — the alignment names it, spelled by the one identity
      // function the events use.
      expect(run.envelope.result.scenario.impact.dependents).toContain("beta");
      expect(run.envelope.result.scenario.evolutionAlignment.boundaries).toContain(VIRTUAL);
    } finally {
      rmSync(scenarioFile, { force: true });
    }
  });
});

describe("e5 — a snapshot's identity survives the write→read hand-off", () => {
  it("the id `history --capture` reports is the identity of the graph it stored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archkeep-cross-command-hist-"));
    try {
      const capture = await archJson(["history", dir, "--capture", "--format", "json"]);
      expect(capture.exitCode).toBe(EXIT.ok);
      expect(capture.envelope.result.captured).not.toBeFalsy();
      const capturedId = capture.envelope.result.captured.id;
      expect(capturedId).toEqual(expect.any(String));

      // Read the stored snapshot file back through a DIFFERENT entry point
      // (`history` without --capture) and recompute the identity from its own
      // fields — write-side identity against read-side data.
      const listed = await archJson(["history", dir, "--format", "json"]);
      expect(listed.exitCode).toBe(EXIT.ok);
      const [snapshot] = listed.envelope.result.snapshots.slice(-1);
      expect(snapshot.id).toBe(capturedId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("snapshotIdentity recomputed from the envelope's own graph equals the stored id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archkeep-cross-command-hist2-"));
    try {
      const capture = await archJson(["history", dir, "--capture", "--format", "json"]);
      expect(capture.exitCode).toBe(EXIT.ok);
      const names = readdirSync(dir).filter(
        (name) => name.endsWith(".json") && !name.startsWith("."),
      );
      expect(names).toHaveLength(1);
      const stored = JSON.parse(readFileSync(join(dir, names[0]), "utf8"));
      // The stored file IS a graph envelope; the identity function reads the
      // same four facts (projects, dependencies, policy fingerprint) the
      // capture read, so both entry points must derive one id.
      const recomputed = snapshotIdentity({
        projects: stored.result.projects,
        dependencies: stored.result.dependencies,
        policy: stored.result.policy,
      });
      expect(recomputed).toBe(capture.envelope.result.captured.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("e7 — edge records that reach identity carry exactly the triple", () => {
  it("the graph envelope's dependency records have exactly {source, target, type}", async () => {
    const run = await archJson(["graph", "--format", "json"]);
    expect(run.exitCode).toBe(EXIT.ok);
    // `result.dependencies` is the FLAT array of edge records the envelope
    // carries, not a map keyed by source.
    const dependencies = run.envelope.result.dependencies;
    expect(Array.isArray(dependencies)).toBe(true);
    expect(dependencies.length).toBeGreaterThan(0);
    for (const edge of dependencies) {
      // The precondition that makes `snapshotIdentity` (raw hashing) and
      // `computeDiff` (triple keys) agree: no fourth field can enter the
      // identity without entering the diff, because none exists.
      expect(Object.keys(edge).sort()).toEqual(["source", "target", "type"]);
    }
  });
});

describe("e6 — one intent file, two judges, one verdict", () => {
  let e6Root;

  beforeAll(async () => {
    e6Root = mkdtempSync(join(tmpdir(), "archkeep-cross-command-intent-"));
    git(e6Root, "init", "-q", "-b", "main");
    const writeIn = (relativePath, text) => {
      mkdirSync(join(e6Root, relativePath, ".."), { recursive: true });
      writeFileSync(join(e6Root, relativePath), text);
    };
    writeIn("archkeep.json", `${MODEL()}\n`);
    writeIn("module-boundaries.config.mjs", law(ONE_ROW));
    writeIn("libs/alpha/go.mod", "module example.com/alpha\n\ngo 1.22\n");
    writeIn("libs/alpha/alpha.go", ALPHA_REACHING);
    writeIn("libs/beta/go.mod", "module example.com/beta\n\ngo 1.22\n");
    writeIn("libs/beta/beta.go", BETA);
    // The SAME law the observed graph crosses, now also declared forbidden in
    // the intent file both `check` and `reconcile` read.
    writeIn(
      "architecture-intent.json",
      `${JSON.stringify(
        {
          version: "1",
          boundaries: [
            { name: "alpha", match: ["name:alpha"] },
            { name: "beta", match: ["name:beta"] },
          ],
          dependencies: {
            forbidden: [{ source: "alpha", target: "beta" }],
          },
        },
        null,
        2,
      )}\n`,
    );
    commitIn(e6Root, "introduce the crossing architecture");
  });

  afterAll(() => {
    if (e6Root) rmSync(e6Root, { recursive: true, force: true });
  });

  it("check reports the forbidden edge as its one intent finding, exit 1", async () => {
    const out = [];
    const err = [];
    const exitCode = await runCli(["check", "--format", "json"], {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      cwd: e6Root,
    });
    expect(exitCode).toBe(EXIT.violations);
    const envelope = JSON.parse(out.join(""));
    const findings = envelope.result.intent.findings;
    expect(findings).toHaveLength(1);
    // The one message id the judge emits for an observed forbidden dependency —
    // the same id `reconcile` classifies the row with below.
    expect(findings[0].rule).toBe("dependencyForbidden");
  });

  it("reconcile classifies that same row violated — never satisfied", async () => {
    const out = [];
    const err = [];
    const exitCode = await runCli(["reconcile", "--format", "json"], {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      cwd: e6Root,
    });
    // Descriptive: the violation is reported, not gated.
    expect(exitCode).toBe(EXIT.ok);
    const envelope = JSON.parse(out.join(""));
    const rows = envelope.result.scores.intentRows;
    const forbidden = rows.find((row) => row.intentRow?.key === "alpha → beta");
    expect(forbidden).toBeTruthy();
    // The classification is the judge's own message id for the row — the same
    // string `check`'s finding above carries, so the two judges name one
    // verdict with one vocabulary.
    expect(forbidden.classification).toBe("dependencyForbidden");
    expect(forbidden.state).toBe("unexpected");
  });
});

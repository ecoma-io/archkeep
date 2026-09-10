/**
 * The repeated-run byte-identity gate (#630): `check`, `graph`, `diff`,
 * `delta`, `drift`, and `reconcile --propose`, each run N times over one
 * frozen fixture tree with `--format json`, must produce N byte-identical
 * stdout streams — compared as raw bytes, normalizing nothing.
 *
 * Why this file exists: every other determinism test here pins WHAT an output
 * says (field order, array sortedness, one value per field). None of them can
 * see the failure class #630 was filed for — one session observed 2 of ~14
 * identical `check --format json` runs diverge byte-wise, with a structural
 * diff of two adjacent runs showing zero field-level difference, and the
 * source remains unidentified. A per-field assertion cannot see that class by
 * construction (the diff showed no field difference), and a single-run test
 * cannot see it at all; only comparing whole bytes across repeated runs can.
 * So this file compares bytes and nothing else — no parse, no key sort, no
 * trim — because any normalization would be exactly the second opinion that
 * lets a real divergence pass.
 *
 * Each run is a real spawned CLI process over the fixture, the way a
 * consumer's CI runs it: the suspected transient was observed ACROSS process
 * cold starts, so the gate repeats cold starts rather than calls in one warm
 * process. Every command in the roster whose stdout bytes a consumer diffs
 * is gated here under the same comparator: the descriptive commands
 * (`graph`, `diff`, `delta`, `drift`) compose it the same way `check` does,
 * and `reconcile --propose` (#863) joins because its ranked candidate list is
 * exactly the output an unstable sort would reorder between runs while each
 * run still looks correct.
 *
 * The comparator is under test FIRST: a byte gate whose comparator compared
 * lengths, or trimmed, or short-circuited after the first pair would be a
 * gate that passes everything while looking strict. The self-test injects a
 * divergent stream — one differing byte at equal length, and a
 * newline-only divergence, the two shapes a normalization would hide — and
 * requires the throw, so the product assertions cannot pass vacuously.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EXIT } from "./verdict.mjs";
import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../spawn-budget.mjs";
import { environmentForTree } from "./workspace.mjs";

vi.setConfig({ testTimeout: SPAWN_TEST_BUDGET_MS });

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));

/**
 * Runs per gate. Each run is a full spawned CLI process, so N stays modest to
 * keep the suite's time sane; four is past the smallest N that can distinguish
 * "two runs agreed" from "the output is stable" — a third breaks a coin-flip
 * pair, a fourth bounds a one-off flake the same way.
 */
const RUNS = 4;

// ---------------------------------------------------------------------------
// The comparator, and its own tests
// ---------------------------------------------------------------------------

/** The offset of the first differing byte, or the shared length when one stream is a prefix of the other. */
function firstDifferingOffset(a, b) {
  const shared = Math.min(a.length, b.length);
  for (let offset = 0; offset < shared; offset += 1) {
    if (a[offset] !== b[offset]) return offset;
  }
  return shared;
}

/**
 * Throws unless every run's stdout is byte-identical to the first.
 *
 * @param {{stdout: Buffer}[]} runs Spawn results, in run order.
 * @returns {void}
 * @throws {Error} naming the first diverging run, both byte lengths, and the
 *   first differing offset — the minimum needed to start diffing a real
 *   divergence without re-running anything.
 */
function assertStreamsByteIdentical(runs) {
  const first = runs[0].stdout;
  for (let index = 1; index < runs.length; index += 1) {
    if (runs[index].stdout.equals(first)) continue;
    throw new Error(
      `run ${index} diverged from run 0 byte-wise: run 0 is ${first.length} bytes, run ${index} is ` +
        `${runs[index].stdout.length} bytes, first differing offset ` +
        `${firstDifferingOffset(first, runs[index].stdout)} — an output that moved between ` +
        `identical runs over an unchanged tree (#630)`,
    );
  }
}

describe("the byte-identity comparator", () => {
  const STABLE = Buffer.from('{"status":"ok","violations":[]}\n');

  it("accepts N identical streams without normalizing them", () => {
    const runs = [0, 1, 2].map(() => ({ stdout: STABLE }));
    expect(() => assertStreamsByteIdentical(runs)).not.toThrow();
  });

  it("rejects a stream that differs by ONE byte at equal length", () => {
    // Equal length is the shape a length comparison would pass; the differing
    // byte is the shape a lossy (parse-and-restringe) comparison could
    // round-trip back into agreement.
    const divergent = Buffer.from('{"status":"no","violations":[]}\n');
    expect(divergent.length).toBe(STABLE.length);
    expect(() =>
      assertStreamsByteIdentical([{ stdout: STABLE }, { stdout: STABLE }, { stdout: divergent }]),
    ).toThrow(/run 2 diverged from run 0.*first differing offset 11/u);
  });

  it("rejects a stream that differs ONLY by a trailing newline", () => {
    // Whitespace is the divergence a trim would hide; the gate normalizes
    // nothing, so a byte the tool stopped writing still fails the gate.
    const divergent = Buffer.from('{"status":"ok","violations":[]}');
    expect(() => assertStreamsByteIdentical([{ stdout: STABLE }, { stdout: divergent }])).toThrow(
      /run 1 diverged from run 0/,
    );
  });
});

// ---------------------------------------------------------------------------
// The frozen fixture trees, and the gates themselves
// ---------------------------------------------------------------------------

const LAW = `export const depConstraints = [
  { sourceTag: "layer:a", onlyDependOnLibsWithTags: ["layer:a"] },
  { sourceTag: "layer:b", onlyDependOnLibsWithTags: ["layer:b"] },
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
`;

const MODEL = () =>
  `${JSON.stringify(
    {
      projects: {
        declared: [
          { root: "libs/alpha", name: "alpha", tags: ["layer:a"] },
          { root: "libs/beta", name: "beta", tags: ["layer:b"] },
          { root: "libs/gamma", name: "gamma", tags: ["layer:a"] },
        ],
      },
      // The workspace's own law is not a project's source; naming it here is
      // what keeps coverage COMPLETE — without the row the run withholds its
      // verdict over the unowned file, and a gate over a no-verdict run would
      // gate nothing.
      coverage: {
        exempt: [{ path: "module-boundaries.config.mjs", reason: "the workspace's own law" }],
      },
    },
    null,
    2,
  )}\n`;

/**
 * A minimal architecture-intent: one boundary matching every project the
 * fixture's graph observes, with no rows — nothing required, nothing
 * forbidden, so `drift`'s verdict over the frozen tree is "no drift" and the
 * gate measures only whether that verdict's bytes move between runs.
 */
const INTENT = `${JSON.stringify({
  version: "1",
  boundaries: [{ name: "all-projects", match: ["name:alpha", "name:beta", "name:gamma"] }],
})}\n`;

/**
 * The reconcile gate's intent: the same boundary, plus two existence rows
 * that DIVERGE from the frozen tree — a required project that does not exist
 * (`absent`, severity 3) and a forbidden project that does (`unexpected`,
 * severity 4). Two candidate severities are the point: an unstable sort in
 * the `--propose` ranking would swap them between runs while each run
 * individually looks correct. This is NOT the shared fixture's intent — the
 * check/drift gates above measure the minimal no-drift model's bytes, and
 * `check` also reads a tracked intent file, so the divergent one is
 * workspace-scoped to the reconcile root.
 */
const RECONCILE_INTENT = `${JSON.stringify({
  version: "1",
  boundaries: [{ name: "all-projects", match: ["name:alpha", "name:beta", "name:gamma"] }],
  projects: {
    required: [{ name: "delta", tags: [] }],
    forbidden: [{ name: "gamma" }],
  },
})}\n`;

const GO_MOD = (name) => `module example.com/${name}\n\ngo 1.22\n`;
/** gamma reaches alpha on one layer — legal. */
const GAMMA = `package gamma

import "example.com/alpha"

func Name() string { return alpha.Name() }
`;
const BETA = `package beta

func Name() string { return "beta" }
`;
/** alpha clean; the violating tree reaches down into beta. */
const ALPHA_CLEAN = `package alpha

func Name() string { return "alpha" }
`;
const ALPHA_REACHING = `package alpha

import "example.com/beta"

func Name() string { return "alpha" + beta.Name() }
`;

/** Identity flags keeping the fixture's commit independent of the machine. */
const GIT_IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

/**
 * Builds a frozen native-provider workspace: three Go projects, everything
 * committed, nothing left for another writer to change. `violating` decides
 * whether alpha's one import crosses the layer axis; `intent` defaults to the
 * shared minimal model the check/drift gates measure, and the reconcile gate
 * overrides it with the divergent `RECONCILE_INTENT`.
 */
function makeFrozenWorkspace(violating, intent = INTENT) {
  const root = mkdtempSync(
    join(tmpdir(), `archkeep-byte-identity-${violating ? "violating" : "clean"}-`),
  );
  const write = (relativePath, text) => {
    mkdirSync(join(root, relativePath, ".."), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  };
  write("architecture-intent.json", intent);
  write("archkeep.json", MODEL());
  write("module-boundaries.config.mjs", LAW);
  write("libs/alpha/go.mod", GO_MOD("alpha"));
  write("libs/alpha/alpha.go", violating ? ALPHA_REACHING : ALPHA_CLEAN);
  write("libs/beta/go.mod", GO_MOD("beta"));
  write("libs/beta/beta.go", BETA);
  write("libs/gamma/go.mod", GO_MOD("gamma"));
  write("libs/gamma/gamma.go", GAMMA);
  const git = (args) =>
    spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: SPAWN_BUDGET_MS,
      killSignal: "SIGKILL",
      env: environmentForTree(),
    });
  for (const args of [
    ["init", "-q", "-b", "main"],
    GIT_IDENTITY.concat(["add", "-A"]),
    GIT_IDENTITY.concat(["commit", "-q", "-m", "fixture"]),
  ]) {
    const run = git(args);
    expect(run.status).toBe(0);
  }
  return root;
}

/** Spawns the real CLI over `root`, capturing stdout as bytes. */
const runCli = (root, args) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: "buffer",
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
    env: environmentForTree(),
  });

/** `check --format json` — the gate this file existed for (#630). */
const runCheck = (root) => runCli(root, ["check", "--format", "json"]);
/** `graph --format json` — the descriptive snapshot `diff` reads as its baseline. */
const runGraph = (root) => runCli(root, ["graph", "--format", "json"]);
/** `diff <baseline> --format json` — compares a graph snapshot against the live head. */
const runDiff = (root, baselinePath) => runCli(root, ["diff", baselinePath, "--format", "json"]);
/** `delta <baseline> --format json` — classifies violations moved since the evidence snapshot. */
const runDelta = (root, baselinePath) => runCli(root, ["delta", baselinePath, "--format", "json"]);
/** `drift --format json` — compares the observed architecture against the declared intent. */
const runDrift = (root) => runCli(root, ["drift", "--format", "json"]);
/** `reconcile --propose --format json` — the ranked candidate list reconcile emits. */
const runReconcile = (root) => runCli(root, ["reconcile", "--propose", "--format", "json"]);

let cleanRoot;
let violatingRoot;
/** Graph-envelope baseline for `diff`, captured from `graph --format json` over cleanRoot. */
let diffBaselinePath;
/** Evidence-snapshot baseline for `delta`, captured from `delta --capture` over cleanRoot. */
let deltaBaselinePath;
/** Frozen reconcile workspace: the clean tree plus the divergent RECONCILE_INTENT. */
let reconcileRoot;

beforeAll(() => {
  cleanRoot = makeFrozenWorkspace(false);
  violatingRoot = makeFrozenWorkspace(true);
  reconcileRoot = makeFrozenWorkspace(false, RECONCILE_INTENT);

  // The descriptive commands take a baseline file as their input. Each is
  // captured ONCE from the same frozen tree every gate below runs over, then
  // reused unchanged — the input the N runs share. `graph`'s output IS the
  // envelope shape `diff`'s `parseBaseline` validates; `delta --capture`
  // writes the evidence snapshot `delta`'s compare mode reads.
  const graphRun = runGraph(cleanRoot);
  expect(graphRun.status).toBe(EXIT.ok);
  diffBaselinePath = join(cleanRoot, "diff-baseline.json");
  writeFileSync(diffBaselinePath, graphRun.stdout);

  deltaBaselinePath = join(cleanRoot, "delta-baseline.json");
  const captureRun = runCli(cleanRoot, ["delta", "--capture", "--output", deltaBaselinePath]);
  expect(captureRun.status).toBe(EXIT.ok);
});

afterAll(() => {
  for (const root of [cleanRoot, violatingRoot, reconcileRoot]) {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("check --format json — repeated runs over one frozen tree (#630)", () => {
  it(`produces byte-identical stdout across ${RUNS} runs over a violating tree`, () => {
    const runs = Array.from({ length: RUNS }, () => runCheck(violatingRoot));
    // The tree is frozen, so even the exit verdict must be identical — a run
    // that could not look (exit 3) is not a byte-identical finding.
    for (const run of runs) {
      expect(run.status).toBe(EXIT.violations);
    }
    assertStreamsByteIdentical(runs);
  });

  it(`produces byte-identical stdout across ${RUNS} runs over a clean tree`, () => {
    // The clean side is the half the audit's divergence was observed on: this
    // repository's own tree checks clean, so an empty violations array, the
    // coverage block, and the provenance header are the bytes that moved.
    const runs = Array.from({ length: RUNS }, () => runCheck(cleanRoot));
    for (const run of runs) {
      expect(run.status).toBe(EXIT.ok);
    }
    assertStreamsByteIdentical(runs);
  });
});

describe("graph/delta/diff/drift — repeated runs over one frozen tree (#630)", () => {
  // Every gate below runs over cleanRoot — the half the audit's divergence
  // was observed on — with `beforeAll`'s frozen baselines as the shared
  // input. A tree that cannot change cannot produce a differing byte: any
  // difference between runs is the command leaking something run-varying
  // (a timestamp, a Map iteration order, a Math.random() tie-break) into
  // bytes a downstream pipeline diffs. The silent direction is the killer:
  // a command whose stdout happens to agree on every sample run ships, and
  // the divergence surfaces only in a consumer's cache — so the gate, like
  // every run-varying seed, must fail LOUDLY when it sees a difference,
  // never paper over one.

  it(`graph produces byte-identical stdout across ${RUNS} runs`, () => {
    const runs = Array.from({ length: RUNS }, () => runGraph(cleanRoot));
    for (const run of runs) {
      expect(run.status).toBe(EXIT.ok);
    }
    assertStreamsByteIdentical(runs);
  });

  it(`diff produces byte-identical stdout across ${RUNS} runs`, () => {
    // Baseline and head are the same frozen tree, so the diff verdict is
    // "no changes" every run — the bytes that could move are the envelope's
    // summary counts and any ordering inside `result`.
    const runs = Array.from({ length: RUNS }, () => runDiff(cleanRoot, diffBaselinePath));
    for (const run of runs) {
      expect(run.status).toBe(EXIT.ok);
    }
    assertStreamsByteIdentical(runs);
  });

  it(`delta produces byte-identical stdout across ${RUNS} runs`, () => {
    // Baseline evidence and live analysis describe the same frozen tree, so
    // every run classifies the same nothing-introduced verdict — the bytes
    // that could move are the introduced/resolved counts and any ordering
    // inside `result`.
    const runs = Array.from({ length: RUNS }, () => runDelta(cleanRoot, deltaBaselinePath));
    for (const run of runs) {
      expect(run.status).toBe(EXIT.ok);
    }
    assertStreamsByteIdentical(runs);
  });

  it(`drift produces byte-identical stdout across ${RUNS} runs`, () => {
    // The intent and the graph are both frozen, so the verdict is the same
    // no-drift every run — the bytes that could move are the resolved
    // boundary rows and any ordering inside `result`.
    const runs = Array.from({ length: RUNS }, () => runDrift(cleanRoot));
    for (const run of runs) {
      expect(run.status).toBe(EXIT.ok);
    }
    assertStreamsByteIdentical(runs);
  });
});

describe("reconcile --propose --format json — repeated runs over one frozen tree (#863)", () => {
  // Reconcile documents byte-determinism (src/commands/reconcile.mjs): every
  // scored element and every --propose candidate is keyed and sorted by plain
  // string comparison, so runs over an unchanged tree and intent produce
  // byte-identical output. The candidate RANKING is the exposure — an
  // unstable sort would silently reorder proposals between runs while each
  // run individually looks correct, exactly the class a per-field or
  // single-run assertion cannot see and only this byte gate across cold
  // starts can. The workspace's intent (RECONCILE_INTENT) diverges from the
  // frozen tree on two existence planes of different severity, so the ranked
  // list is non-empty and an unstable sort has something to reorder.

  it(`produces byte-identical stdout across ${RUNS} runs`, () => {
    const runs = Array.from({ length: RUNS }, () => runReconcile(reconcileRoot));
    // Reconcile is descriptive — it never exits 1, and a run that could not
    // reach a verdict (exit 3) is not a byte-identical finding.
    for (const run of runs) {
      expect(run.status).toBe(EXIT.ok);
    }
    assertStreamsByteIdentical(runs);
  });

  it(`leaves the intent file byte-identical across ${RUNS} runs`, () => {
    // Reconcile is READ-ONLY by design — writing back is a manual, reviewable
    // step the operator performs. N runs over the frozen tree may not move a
    // single byte of architecture-intent.json.
    const before = readFileSync(join(reconcileRoot, "architecture-intent.json"));
    for (let index = 0; index < RUNS; index += 1) {
      expect(runReconcile(reconcileRoot).status).toBe(EXIT.ok);
    }
    expect(readFileSync(join(reconcileRoot, "architecture-intent.json")).equals(before)).toBe(true);
  });
});

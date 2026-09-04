/**
 * The repeated-run byte-identity gate (#630): `check --format json`, run N
 * times over one frozen fixture tree, must produce N byte-identical stdout
 * streams — compared as raw bytes, normalizing nothing.
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
 * process. `check` is the one command gated here because it is the one whose
 * bytes the audit hashed; the same comparator below is what a second command's
 * gate would compose.
 *
 * The comparator is under test FIRST: a byte gate whose comparator compared
 * lengths, or trimmed, or short-circuited after the first pair would be a
 * gate that passes everything while looking strict. The self-test injects a
 * divergent stream — one differing byte at equal length, and a
 * newline-only divergence, the two shapes a normalization would hide — and
 * requires the throw, so the product assertions cannot pass vacuously.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * whether alpha's one import crosses the layer axis.
 */
function makeFrozenWorkspace(violating) {
  const root = mkdtempSync(
    join(tmpdir(), `archkeep-byte-identity-${violating ? "violating" : "clean"}-`),
  );
  const write = (relativePath, text) => {
    mkdirSync(join(root, relativePath, ".."), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  };
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
const runCheck = (root) =>
  spawnSync(process.execPath, [CLI, "check", "--format", "json"], {
    cwd: root,
    encoding: "buffer",
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
    env: environmentForTree(),
  });

let cleanRoot;
let violatingRoot;

beforeAll(() => {
  cleanRoot = makeFrozenWorkspace(false);
  violatingRoot = makeFrozenWorkspace(true);
});

afterAll(() => {
  for (const root of [cleanRoot, violatingRoot]) {
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

/**
 * The verb→exit matrix: every command the CLI declares, driven against BOTH
 * sides of its exit contract.
 *
 * Exit codes are what a CI consumer branches on, yet the suites pinned them
 * unevenly: `discover`/`reconcile` had no refusal-direction assertion at all,
 * `health`/`impact`/`explain` pinned only their zero side, `provenance` only
 * its refusal side, and a regression that flipped any of those contracts
 * would have passed everything while CI consumers branched on a number that
 * no longer meant what the docs say (`docs/reference/cli.md`). This table is
 * the completion of that matrix, and the roster guard below is what keeps it
 * complete: keys must equal `COMMAND_NAMES` in both directions, so a verb
 * added to `../cli.mjs` fails here on the day it lands unless someone decides
 * both sides of its contract.
 *
 * Every row runs in-process through `runCli` — the harness
 * `./cli.integration.test.mjs` establishes — over one healthy workspace plus
 * three deliberately broken ones, each broken in a way that verb really
 * meets: a boundary law that cannot load, coverage that cannot complete, and
 * a repository whose own git cannot name its state. The expectations are the
 * documented contract (`docs/reference/json-output.md`'s status ladder): 0
 * completed-and-descriptive, 1 findings, 2 usage, 3 could-not-look.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COMMAND_NAMES, EXIT, runCli } from "../cli.mjs";
import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../spawn-budget.mjs";

/** The crossing import every healthy-world verdict is computed over. */
const DOC_GO = [
  "// Package domain is the layer everything else points at.",
  "package domain",
  "",
  "import (",
  '\t"example.com/adapter"',
  ")",
  "",
  "var _ = adapter.Name",
].join("\n");

/** Options block every boundary-config dialect must carry. */
const MODULE_OPTIONS = `export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: [],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;

/** The workspace's own law: permissive rows, one passing fitness function. */
const PERMISSIVE_LAW = `export const depConstraints = [];
${MODULE_OPTIONS}
export const fitness = [
  {
    name: "cycle-free",
    match: ["*"],
    condition: { type: "cycle-free" },
    reason: "a cycle makes every layer statement unfalsifiable",
  },
];
`;

/** The override law: the crossing import violates BOTH lanes it declares. */
const STRICT_LAW = `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
${MODULE_OPTIONS}
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
`;

/** The declared architecture, consistent with the observed graph below. */
const INTENT = `${JSON.stringify(
  {
    version: "1",
    boundaries: [
      { name: "domain", match: ["name:domain"] },
      { name: "adapter", match: ["name:adapter"] },
    ],
    allowed: [{ from: "domain", to: "adapter" }],
  },
  null,
  2,
)}\n`;

const NX_JSON = `${JSON.stringify({
  plugins: [
    {
      plugin: "@ecoma-io/archkeep/nx",
      options: { boundaryConfig: "module-boundaries.config.mjs" },
    },
  ],
})}\n`;

/** The observed graph: one edge, and it crosses the strict law. */
const GRAPH = {
  nodes: {
    domain: { name: "domain", type: "lib", data: { root: "libs/domain", tags: ["layer:domain"] } },
    adapter: {
      name: "adapter",
      type: "lib",
      data: { root: "libs/adapter", tags: ["layer:adapter"] },
    },
  },
  dependencies: { domain: [{ source: "domain", target: "adapter", type: "static" }] },
};

const WORLD_FILES = [
  "nx.json",
  "module-boundaries.config.mjs",
  "architecture-intent.json",
  "libs/domain/go.mod",
  "libs/domain/doc.go",
  "libs/adapter/go.mod",
  "libs/adapter/adapter.go",
];

const writeTree = (root, entries) => {
  for (const [path, text] of Object.entries(entries)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

const world = mkdtempSync(join(tmpdir(), "archkeep-exit-matrix-"));
const brokenRoot = mkdtempSync(join(tmpdir(), "archkeep-exit-matrix-broken-"));
const incompleteRoot = mkdtempSync(join(tmpdir(), "archkeep-exit-matrix-incomplete-"));
const commitlessRoot = mkdtempSync(join(tmpdir(), "archkeep-exit-matrix-commitless-"));
const changeRoot = mkdtempSync(join(tmpdir(), "archkeep-exit-matrix-change-"));
const artifactsDir = mkdtempSync(join(tmpdir(), "archkeep-exit-matrix-artifacts-"));
const histDir = mkdtempSync(join(tmpdir(), "archkeep-exit-matrix-hist-"));
const emptyHistDir = mkdtempSync(join(tmpdir(), "archkeep-exit-matrix-hist-empty-"));
afterAll(() => {
  for (const dir of [
    world,
    brokenRoot,
    incompleteRoot,
    commitlessRoot,
    changeRoot,
    artifactsDir,
    histDir,
    emptyHistDir,
  ]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

writeTree(world, {
  "nx.json": NX_JSON,
  "module-boundaries.config.mjs": PERMISSIVE_LAW,
  "strict.config.mjs": STRICT_LAW,
  "architecture-intent.json": INTENT,
  "libs/domain/go.mod": "module example.com/domain\n\ngo 1.24\n",
  "libs/domain/doc.go": DOC_GO,
  "libs/adapter/go.mod": "module example.com/adapter\n\ngo 1.24\n",
  "libs/adapter/adapter.go": 'package adapter\n\nconst Name = "adapter"\n',
});

// The broken world: a boundary law that cannot LOAD. Every command that
// resolves the workspace's policy meets it and must refuse loudly rather
// than judge under no law at all.
writeTree(brokenRoot, {
  "nx.json": NX_JSON,
  // `[` never closes — a SyntaxError at import time, not a validation miss.
  "module-boundaries.config.mjs": "export const depConstraints = [",
  "libs/core/go.mod": "module example.com/core\n\ngo 1.24\n",
  "libs/core/core.go": "package core\n",
});

// The incomplete world: a Go file NO declared project owns. That is a
// whole-file failure at the preamble layer, the exact state `drift`,
// `reconcile` and `debt` must refuse on — every absent score would be
// ambiguous between "gone" and "never seen".
writeTree(incompleteRoot, {
  "nx.json": NX_JSON,
  "module-boundaries.config.mjs": PERMISSIVE_LAW,
  "libs/core/go.mod": "module example.com/core\n\ngo 1.24\n",
  "libs/core/core.go": "package core\n",
  // Tracked, analyzable, owned by nobody.
  "libs/orphan/orphan.go": "package orphan\n",
});

// The commitless world: a real repository whose HEAD is unborn. Its own git
// cannot name its state, which is a loud could-not-look (`EXIT.error`) —
// never "no origin claim", which is a factually different statement. The
// marker is the fixture's own: without it, root discovery could resolve to
// some workspace-shaped ANCESTOR of the temp directory and the row would
// fail for a reason that has nothing to do with the unborn HEAD.
writeTree(commitlessRoot, { "nx.json": NX_JSON });
spawnSync(
  "git",
  ["init", "-q", "-b", "main"],
  // Bounded like every spawn (#41): an unbounded child here would wedge the
  // worker inside the syscall, a state no vitest timeout can interrupt.
  { cwd: commitlessRoot, encoding: "utf8", timeout: SPAWN_BUDGET_MS, killSignal: "SIGKILL" },
);

// The change world: a REAL repository with one commit, because the `change`
// contract pins its base by provenance commit — the one verb whose happy path
// cannot run without git being able to name the tree. Same identity hygiene
// as every fixture: the commit's author is not this machine.
writeTree(changeRoot, {
  "nx.json": NX_JSON,
  "module-boundaries.config.mjs": PERMISSIVE_LAW,
});
spawnSync("git", ["init", "-q", "-b", "main"], {
  cwd: changeRoot,
  encoding: "utf8",
  timeout: SPAWN_BUDGET_MS,
  killSignal: "SIGKILL",
});
spawnSync(
  "git",
  ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"],
  { cwd: changeRoot, encoding: "utf8", timeout: SPAWN_BUDGET_MS, killSignal: "SIGKILL" },
);

/**
 * Each world's injected outside: cwd plus the two seams. Real git is NOT
 * among them — the healthy worlds are not repositories, so provenance is
 * legitimately `null`, and the commitless world IS one, which is the point
 * of its row.
 *
 * @returns {{cwd: string, readGraph: Function, listFiles: Function}}
 */
const seamFor = {
  world: () => ({ cwd: world, readGraph: () => GRAPH, listFiles: () => WORLD_FILES }),
  broken: () => ({
    cwd: brokenRoot,
    readGraph: () => ({ nodes: {}, dependencies: {} }),
    listFiles: () => [
      "nx.json",
      "module-boundaries.config.mjs",
      "libs/core/go.mod",
      "libs/core/core.go",
    ],
  }),
  incomplete: () => ({
    cwd: incompleteRoot,
    readGraph: () => ({
      nodes: { core: { name: "core", type: "lib", data: { root: "libs/core", tags: [] } } },
      dependencies: {},
    }),
    listFiles: () => [
      "nx.json",
      "module-boundaries.config.mjs",
      "libs/core/go.mod",
      "libs/core/core.go",
      "libs/orphan/orphan.go",
    ],
  }),
  commitless: () => ({
    cwd: commitlessRoot,
    readGraph: () => ({ nodes: {}, dependencies: {} }),
    listFiles: () => ["nx.json"],
  }),
  change: () => ({
    cwd: changeRoot,
    readGraph: () => GRAPH,
    listFiles: () => ["nx.json", "module-boundaries.config.mjs"],
  }),
};

/** Capturing streams for one in-process run. */
const streams = () => {
  const out = [];
  const err = [];
  return { out: (t) => out.push(t), err: (t) => err.push(t), lines: { out, err } };
};

let baseline;
let deltaBaseline;
let changeBaseline;
let changeIntent;
let changeIntentWrongBase;
beforeAll(async () => {
  // `diff` compares against a snapshot the tool itself wrote, and
  // `health`/`report`/`debt` read a history the tool itself captured — both
  // produced here, once, so each matrix row stays independent of the others'
  // order. `delta` reads an evidence baseline of its own format, captured by
  // the same command whose row consumes it.
  baseline = join(artifactsDir, "baseline.json");
  const graphRun = { ...streams(), ...seamFor.world() };
  expect(await runCli(["graph", "--format", "json", "--output", baseline], graphRun)).toBe(EXIT.ok);
  const captureRun = { ...streams(), ...seamFor.world() };
  expect(await runCli(["history", histDir, "--capture"], captureRun)).toBe(EXIT.ok);
  deltaBaseline = join(artifactsDir, "delta-baseline.json");
  const deltaCaptureRun = { ...streams(), ...seamFor.world() };
  expect(await runCli(["delta", "--capture", "--output", deltaBaseline], deltaCaptureRun)).toBe(
    EXIT.ok,
  );

  // `change` reads an evidence baseline captured in its own committed world
  // (its manifest pins the provenance commit) plus two manifests written from
  // that snapshot's own provenance: the correct pin for the ok row, and a
  // deliberately wrong one for the refused row — the quiet-direction case,
  // which must exit 3 rather than reconcile against a base nobody declared.
  changeBaseline = join(artifactsDir, "change-baseline.json");
  const changeCaptureRun = { ...streams(), ...seamFor.change() };
  expect(await runCli(["delta", "--capture", "--output", changeBaseline], changeCaptureRun)).toBe(
    EXIT.ok,
  );
  const capturedCommit = JSON.parse(readFileSync(changeBaseline, "utf8")).provenance.commit;
  const manifestFor = (commit) =>
    `${JSON.stringify(
      {
        version: "1",
        base: { commit },
        projects: { add: [], remove: [] },
        edges: { add: [], remove: [] },
        constraints: {},
      },
      null,
      2,
    )}\n`;
  changeIntent = join(artifactsDir, "change-intent.json");
  writeFileSync(changeIntent, manifestFor(capturedCommit));
  changeIntentWrongBase = join(artifactsDir, "change-intent-wrong-base.json");
  writeFileSync(changeIntentWrongBase, manifestFor("0".repeat(40)));
});

/**
 * The matrix. One row per verb in `COMMAND_NAMES`; each side names the world
 * it runs in and the exit the docs promise. `ok` pins the completed side of
 * the contract — descriptive verbs always 0, the two finding-lane verbs over
 * a clean tree 0 — and `refused` pins the other side, whichever honest
 * non-zero that verb's contract produces: a finding (1), a usage error (2),
 * or a could-not-look (3). An `argv` may be a function when it embeds a path
 * that only exists once `beforeAll` has run — a table built at module load
 * would otherwise capture the variable's undefined before-value.
 *
 * @type {Record<string, {ok: {world: string, argv: string[]|Function, exit: number},
 *   refused: {world: string, argv: string[]|Function, exit: number,
 *   stderrContains?: string}}>}
 */
const MATRIX = {
  check: {
    ok: { world: "world", argv: ["check"], exit: EXIT.ok },
    refused: {
      world: "world",
      argv: ["check", "--config", "strict.config.mjs"],
      exit: EXIT.violations,
    },
  },
  graph: {
    ok: { world: "world", argv: ["graph", "--format", "json"], exit: EXIT.ok },
    refused: { world: "broken", argv: ["graph", "--format", "json"], exit: EXIT.error },
  },
  diff: {
    ok: { world: "world", argv: () => ["diff", baseline], exit: EXIT.ok },
    refused: {
      world: "world",
      argv: () => ["diff", join(artifactsDir, "no-such-baseline.json")],
      exit: EXIT.error,
    },
  },
  delta: {
    // An unchanged tree against its own baseline: nothing introduced, exit 0.
    ok: { world: "world", argv: () => ["delta", deltaBaseline], exit: EXIT.ok },
    refused: {
      world: "world",
      argv: () => ["delta", join(artifactsDir, "no-such-evidence.json")],
      exit: EXIT.error,
    },
  },
  change: {
    // The committed change world, its own baseline captured there, and a
    // manifest pinning that snapshot's real provenance commit: matched, 0.
    ok: {
      world: "change",
      argv: () => ["change", changeBaseline, "--intent", changeIntent],
      exit: EXIT.ok,
    },
    refused: {
      // The same everything, pinned to a commit the snapshot was never
      // captured at — unproven (3), never a quiet match.
      world: "change",
      argv: () => ["change", changeBaseline, "--intent", changeIntentWrongBase],
      exit: EXIT.error,
    },
  },
  discover: {
    ok: { world: "world", argv: ["discover"], exit: EXIT.ok },
    refused: { world: "world", argv: ["discover", "libs/domain"], exit: EXIT.usage },
  },
  drift: {
    ok: { world: "world", argv: ["drift"], exit: EXIT.ok },
    refused: { world: "incomplete", argv: ["drift"], exit: EXIT.error },
  },
  reconcile: {
    ok: { world: "world", argv: ["reconcile"], exit: EXIT.ok },
    refused: { world: "incomplete", argv: ["reconcile"], exit: EXIT.error },
  },
  waivers: {
    ok: { world: "world", argv: ["waivers"], exit: EXIT.ok },
    refused: {
      world: "world",
      argv: ["waivers", "--config", "no-such-law.config.mjs"],
      exit: EXIT.error,
    },
  },
  fitness: {
    ok: { world: "world", argv: ["fitness"], exit: EXIT.ok },
    refused: {
      world: "world",
      argv: ["fitness", "--config", "strict.config.mjs"],
      exit: EXIT.violations,
    },
  },
  history: {
    ok: { world: "world", argv: ["history", histDir, "--capture"], exit: EXIT.ok },
    refused: { world: "world", argv: ["history", emptyHistDir], exit: EXIT.error },
  },
  trajectory: {
    // The same captured history `history`/`debt` read — a trajectory over it
    // is descriptive aggregation, exit 0.
    ok: { world: "world", argv: ["trajectory", histDir], exit: EXIT.ok },
    refused: { world: "world", argv: ["trajectory", emptyHistDir], exit: EXIT.error },
  },
  health: {
    ok: { world: "world", argv: ["health", histDir], exit: EXIT.ok },
    refused: { world: "broken", argv: ["health"], exit: EXIT.error },
  },
  report: {
    ok: { world: "world", argv: ["report", histDir], exit: EXIT.ok },
    refused: { world: "broken", argv: ["report"], exit: EXIT.error },
  },
  debt: {
    ok: { world: "world", argv: ["debt", histDir], exit: EXIT.ok },
    refused: { world: "incomplete", argv: ["debt", histDir], exit: EXIT.error },
  },
  impact: {
    ok: { world: "world", argv: ["impact", "adapter"], exit: EXIT.ok },
    refused: { world: "world", argv: ["impact"], exit: EXIT.usage },
  },
  explain: {
    ok: { world: "world", argv: ["explain", "libs/domain/doc.go:5:2"], exit: EXIT.ok },
    refused: { world: "world", argv: ["explain"], exit: EXIT.usage },
  },
  context: {
    ok: { world: "world", argv: ["context", "domain"], exit: EXIT.ok },
    refused: { world: "world", argv: ["context"], exit: EXIT.usage },
  },
  provenance: {
    ok: { world: "world", argv: ["provenance"], exit: EXIT.ok },
    refused: {
      world: "commitless",
      argv: ["provenance"],
      exit: EXIT.error,
      // Named, not accidental: the run must refuse because THIS repository
      // has no commits — not because root discovery landed somewhere else.
      stderrContains: "no commits",
    },
  },
  adr: {
    ok: { world: "world", argv: ["adr"], exit: EXIT.ok },
    refused: { world: "world", argv: ["adr", "one", "two"], exit: EXIT.usage },
  },
};

// The rows spawn transitively — `resolveProvenance` runs git inside every
// command's context, and the commitless row refuses through a real git
// failure — so the suite takes the derived per-test ceiling, not vitest's
// untouched 5 s default (`../spawn-budget.mjs`).
describe("the verb→exit matrix", { timeout: SPAWN_TEST_BUDGET_MS }, () => {
  it("covers every command the CLI declares — a new verb cannot land without exit coverage", () => {
    // Both directions, the roster guard: a verb added to `../cli.mjs`
    // without a row fails here, and a row left behind by a removed verb
    // fails too — the matrix can only shrink by decision.
    expect(Object.keys(MATRIX).sort()).toEqual([...COMMAND_NAMES].sort());
  });

  it("gives every row two sides with numeric exits", () => {
    for (const [verb, sides] of Object.entries(MATRIX)) {
      for (const [side, spec] of Object.entries(sides)) {
        const argv = typeof spec.argv === "function" ? spec.argv() : spec.argv;
        expect(
          { verb, side, argv0: argv[0], exit: spec.exit },
          `${verb}.${side} must be a well-formed row`,
        ).toEqual({ verb, side, argv0: verb, exit: expect.any(Number) });
        expect([0, 1, 2, 3]).toContain(spec.exit);
      }
    }
  });

  it.each(Object.keys(MATRIX))("%s answers both sides of its exit contract", async (verb) => {
    const { ok, refused } = MATRIX[verb];
    const argvOf = (spec) => (typeof spec.argv === "function" ? spec.argv() : spec.argv);

    const okRun = { ...streams(), ...seamFor[ok.world]() };
    const okExit = await runCli(argvOf(ok), okRun);
    expect({ verb, side: "ok", exit: okExit, stderr: okRun.lines.err.join("\n") }).toEqual({
      verb,
      side: "ok",
      exit: ok.exit,
      stderr: expect.any(String),
    });

    const refusedRun = { ...streams(), ...seamFor[refused.world]() };
    const refusedExit = await runCli(argvOf(refused), refusedRun);
    const said = [...refusedRun.lines.err, ...refusedRun.lines.out].join("\n");
    if (refused.stderrContains !== undefined) {
      expect(said).toContain(refused.stderrContains);
    }
    expect({
      verb,
      side: "refused",
      exit: refusedExit,
      said,
    }).toEqual({
      verb,
      side: "refused",
      exit: refused.exit,
      // A non-zero exit must SAY why — a silent failure code is its own
      // silent direction, so the refusal stream may not be empty.
      said: expect.stringMatching(/\S/u),
    });
  });
});

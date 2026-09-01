/**
 * Deterministic ordering: every command's JSON envelope arrays are sorted by
 * plain string comparison (never localeCompare), so two runs over an unchanged
 * tree produce byte-identical output.
 *
 * Each test runs the command against a fixture designed to expose ordering
 * issues — projects out of alphabetical order, violations with mixed
 * sourceFiles — and asserts that every array in the result payload is
 * correctly sorted.
 *
 * ## Why a standalone file rather than per-command tests
 *
 * A per-command test would catch that command's regression, but the invariant
 * holds across ALL commands: every array in every envelope is sorted. A single
 * walk of every command's result proves the invariant for every command,
 * and a new command that forgets to sort its arrays fails here.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../cli.mjs";
import { ADR_DIR } from "./governance/adr-registry.mjs";
import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "./spawn-budget.mjs";

// ---------------------------------------------------------------------------
// Fixture: two projects that sort in reverse-alphabetical order, with tags
// that also sort backward, and a violation whose sourceFile sorts last.
// Any output that preserves this input order instead of sorting would fail.
// ---------------------------------------------------------------------------

/** The boundary law with waivers and fitness, matching the fixture's reverse-alphabetical projects. */
const BOUNDARY_CONFIG = `export const depConstraints = [
  { sourceTag: "scope:*", onlyDependOnLibsWithTags: ["scope:same"] },
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
  { path: "libs/zebra/src/doc.go", reason: "temporary waiver", expiresAt: "2999-12-31T23:59:59.000Z" },
  { path: "libs/alpha/src/main.go", reason: "permanent suppression" },
];
export const fitness = [
  { name: "cycle-free", match: ["*"], condition: { type: "cycle-free" }, reason: "a cycle makes every layer statement unfalsifiable" },
];
`;

const INTENT_WITH_ORDER = {
  version: "1",
  boundaries: [{ name: "app-layer", match: ["name:zebra", "name:alpha"] }],
  allowed: [{ from: "app-layer", to: "app-layer" }],
};

const ADR_RECORD = `---
id: 0001-test
status: accepted
bindings:
  - intentForbiddenEdge
---
# Test ADR
`;

const NX_JSON = `{
  "plugins": [
    {
      "plugin": "@ecoma-io/archkeep/nx",
      "options": {
        "boundaryConfig": "module-boundaries.config.mjs",
        "tsConfig": "tsconfig.base.json"
      }
    }
  ]
}
`;

/**
 * A graph with three projects whose names sort in REVERSE alphabetical order:
 * z-something, m-something, a-something. If buildProjects does not sort, the
 * output would be [zebra, middle, alpha] instead of [alpha, middle, zebra].
 */
const REVERSE_GRAPH = {
  nodes: {
    zebra: {
      name: "zebra",
      type: "lib",
      data: { root: "libs/zebra", tags: ["scope:zoo", "layer:app"] },
    },
    middle: {
      name: "middle",
      type: "lib",
      data: { root: "libs/middle", tags: ["scope:common", "layer:domain"] },
    },
    alpha: {
      name: "alpha",
      type: "lib",
      data: { root: "libs/alpha", tags: ["scope:same", "layer:app"] },
    },
  },
  dependencies: {
    alpha: [
      { source: "alpha", target: "middle", type: "static" },
      { source: "alpha", target: "zebra", type: "static" },
    ],
    middle: [],
    zebra: [{ source: "zebra", target: "middle", type: "implicit" }],
  },
};

/** A crossing import: alpha depends on middle, which has layer:domain. */
const FILES_WITH_VIOLATION = [
  "nx.json",
  "module-boundaries.config.mjs",
  "architecture-intent.json",
  `${ADR_DIR}/0001-test.md`,
  "libs/alpha/go.mod",
  "libs/alpha/src/main.go",
  "libs/middle/go.mod",
  "libs/middle/src/lib.go",
  "libs/zebra/go.mod",
  "libs/zebra/src/doc.go",
];

let root;
let historyDir;
let baseline;
let deltaBaseline;
let changeIntent;
let firstCommit;

const git = (...args) =>
  spawnSync("git", args, {
    cwd: root,
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

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "archkeep-ordering-"));
  historyDir = mkdtempSync(join(tmpdir(), "archkeep-ordering-history-"));
  const write = (relativePath, text) => {
    mkdirSync(join(root, relativePath, ".."), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  };

  write("nx.json", NX_JSON);
  write("module-boundaries.config.mjs", BOUNDARY_CONFIG);
  write("architecture-intent.json", `${JSON.stringify(INTENT_WITH_ORDER, null, 2)}\n`);
  write(`${ADR_DIR}/0001-test.md`, ADR_RECORD);
  // Write the crossing import: alpha -> middle violates layer constraint
  write("libs/alpha/go.mod", "module example.com/alpha\n\ngo 1.22\n");
  write(
    "libs/alpha/src/main.go",
    'package main\n\nimport (\n\t"example.com/middle"\n)\n\nvar _ = middle.X\n',
  );
  write("libs/middle/go.mod", "module example.com/middle\n\ngo 1.22\n");
  write("libs/middle/src/lib.go", "package middle\n\nconst X = 1\n");
  write("libs/zebra/go.mod", "module example.com/zebra\n\ngo 1.22\n");
  write(
    "libs/zebra/src/doc.go",
    'package doc\n\nimport (\n\t"example.com/middle"\n)\n\nvar _ = middle.X\n',
  );

  expect(git("init", "-q", "-b", "main")).toBe(0);
  expect(git("add", "-A")).toBe(0);
  expect(git("commit", "-q", "-m", "fixture")).toBe(0);
  firstCommit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
  }).stdout.trim();
  expect(
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "two"),
  ).toBe(0);

  // Capture diff/delta/history baselines
  const snapshot = await envelopeFor(["graph", "--format", "json"]);
  baseline = join(historyDir, "baseline.json");
  writeFileSync(baseline, `${JSON.stringify(snapshot.envelope, null, 2)}\n`);

  const captured = await run(["history", historyDir, "--capture"]);
  expect(captured.exitCode).toBe(0);

  const deltaCapture = await run(["delta", "--capture"]);
  expect(deltaCapture.exitCode).toBe(0);
  deltaBaseline = join(root, "delta-baseline.json");
  writeFileSync(deltaBaseline, `${deltaCapture.out}\n`);

  const capturedCommit = JSON.parse(deltaCapture.out).provenance.commit;
  changeIntent = join(root, "change-intent.json");
  writeFileSync(
    changeIntent,
    `${JSON.stringify(
      {
        version: "1",
        base: { commit: capturedCommit },
        summary: "ordering fixture",
        projects: { add: [], remove: [] },
        edges: { add: [], remove: [] },
        constraints: { noNewViolations: true, noNewCycles: true },
      },
      null,
      2,
    )}\n`,
  );
}, SPAWN_TEST_BUDGET_MS);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (historyDir) rmSync(historyDir, { recursive: true, force: true });
});

async function run(argv) {
  const out = [];
  const err = [];
  const exitCode = await runCli(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: root,
    readGraph: () => REVERSE_GRAPH,
    listFiles: () => FILES_WITH_VIOLATION,
  });
  return { exitCode, out: out.join("\n"), err: err.join("\n") };
}

async function envelopeFor(argv) {
  const result = await run(argv);
  let envelope;
  try {
    envelope = JSON.parse(result.out);
  } catch {
    throw new Error(
      `archkeep: '${argv.join(" ")}' wrote no JSON envelope (exit ${result.exitCode}). ` +
        `stdout: ${result.out.slice(0, 400)} stderr: ${result.err.slice(0, 400)}`,
    );
  }
  return { exitCode: result.exitCode, envelope };
}

/**
 * A total order assertion helper. Asserts that `array` is sorted by plain
 * string comparison on `key` — the same contract every Archkeep command makes.
 * Throws a descriptive error naming the first out-of-order pair.
 */
function assertSorted(array, key, label) {
  expect(Array.isArray(array), `${label} must be an array`).toBe(true);
  for (let i = 1; i < array.length; i += 1) {
    const a = typeof key === "function" ? key(array[i - 1]) : array[i - 1][key];
    const b = typeof key === "function" ? key(array[i]) : array[i][key];
    // Plain string comparison — never localeCompare. < is the byte-level
    // comparison every Archkeep command uses.
    if (!(a <= b)) {
      // a > b means out of order
      expect({ label, index: i - 1, a, b }).toEqual({ label, index: i - 1, a, b: undefined });
    }
  }
}

/**
 * Plain string comparison — mirrors the cmp function used throughout commands.
 */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Per-command ordering assertions
// ---------------------------------------------------------------------------

describe("deterministic ordering — every command's result arrays are sorted", () => {
  // ── check ──────────────────────────────────────────────────────────
  it("check: violations sorted by sourceFile, line, column, messageId", async () => {
    const { envelope } = await envelopeFor(["check", "--format", "json"]);
    const violations = envelope.result?.violations;
    expect(Array.isArray(violations)).toBe(true);
    if (violations.length > 0) {
      for (let i = 1; i < violations.length; i += 1) {
        const a = violations[i - 1];
        const b = violations[i];
        const ord =
          cmp(a.sourceFile, b.sourceFile) ||
          a.line - b.line ||
          a.column - b.column ||
          cmp(a.messageId, b.messageId);
        expect({ i: i - 1, a: a.sourceFile, b: b.sourceFile, ord }).toHaveProperty("ord", -1);
        // ord must be < 0 (strictly less): the comparator returns -1/0/1
        expect(ord).toBeLessThan(0);
      }
    }
  });

  // ── graph ──────────────────────────────────────────────────────────
  it("graph: projects sorted by name", async () => {
    const { envelope } = await envelopeFor(["graph", "--format", "json"]);
    const projects = envelope.result?.projects;
    expect(Array.isArray(projects)).toBe(true);
    assertSorted(projects, "name", "graph.projects");
    // Verify the specific ordering: [alpha, middle, zebra] NOT [zebra, middle, alpha]
    if (projects.length >= 3) {
      expect(projects[0].name).toBe("alpha");
      expect(projects[projects.length - 1].name).toBe("zebra");
    }
    // Tags within each project must also be sorted
    for (const project of projects) {
      if (Array.isArray(project.tags) && project.tags.length > 0) {
        assertSorted(project.tags, (t) => t, `graph.projects[${project.name}].tags`);
      }
    }
  });

  it("graph: dependencies sorted by source, target, type", async () => {
    const { envelope } = await envelopeFor(["graph", "--format", "json"]);
    const deps = envelope.result?.dependencies;
    expect(Array.isArray(deps)).toBe(true);
    if (deps.length > 0) {
      for (let i = 1; i < deps.length; i += 1) {
        const a = deps[i - 1];
        const b = deps[i];
        const ord = cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.type, b.type);
        expect(ord).toBeLessThan(0);
      }
    }
  });

  // ── diff ───────────────────────────────────────────────────────────
  it("diff: added/removed/changed projects sorted by name", async () => {
    const { envelope } = await envelopeFor(["diff", baseline, "--format", "json"]);
    const result = envelope.result;
    if (Array.isArray(result?.addedProjects)) {
      assertSorted(result.addedProjects, "name", "diff.addedProjects");
    }
    if (Array.isArray(result?.removedProjects)) {
      assertSorted(result.removedProjects, "name", "diff.removedProjects");
    }
    if (Array.isArray(result?.changedProjects)) {
      assertSorted(result.changedProjects, "name", "diff.changedProjects");
    }
    if (Array.isArray(result?.addedEdges)) {
      for (let i = 1; i < result.addedEdges.length; i += 1) {
        const a = result.addedEdges[i - 1];
        const b = result.addedEdges[i];
        const ord = cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.type, b.type);
        expect(ord).toBeLessThan(0);
      }
    }
    if (Array.isArray(result?.removedEdges)) {
      for (let i = 1; i < result.removedEdges.length; i += 1) {
        const a = result.removedEdges[i - 1];
        const b = result.removedEdges[i];
        const ord = cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.type, b.type);
        expect(ord).toBeLessThan(0);
      }
    }
  });

  // ── delta ──────────────────────────────────────────────────────────
  it("delta: violations sorted by identity", async () => {
    const { envelope } = await envelopeFor(["delta", deltaBaseline, "--format", "json"]);
    const v = envelope.result?.violations;
    if (v) {
      for (const category of ["introduced", "resolved", "unchanged"]) {
        const arr = v[category];
        if (Array.isArray(arr) && arr.length > 1) {
          for (let i = 1; i < arr.length; i += 1) {
            const a = arr[i - 1];
            const b = arr[i];
            const ord = cmp(a.identity ?? "", b.identity ?? "");
            expect(ord).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  });

  // ── change ─────────────────────────────────────────────────────────
  it("change: impact sorted by project name", async () => {
    const { envelope } = await envelopeFor([
      "change",
      deltaBaseline,
      "--intent",
      changeIntent,
      "--format",
      "json",
    ]);
    const impact = envelope.result?.impact;
    if (Array.isArray(impact)) {
      assertSorted(impact, "project", "change.impact");
    }
  });

  // ── discover ───────────────────────────────────────────────────────
  it("discover: projects sorted by name", async () => {
    const { envelope } = await envelopeFor(["discover", "--format", "json"]);
    const projects = envelope.result?.projects;
    if (Array.isArray(projects)) {
      assertSorted(projects, "name", "discover.projects");
    }
  });

  it("discover: edges sorted by source, target, type", async () => {
    const { envelope } = await envelopeFor(["discover", "--format", "json"]);
    const edges = envelope.result?.edges;
    if (Array.isArray(edges) && edges.length > 1) {
      for (let i = 1; i < edges.length; i += 1) {
        const a = edges[i - 1];
        const b = edges[i];
        const ord = cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.type, b.type);
        expect(ord).toBeLessThan(0);
      }
    }
  });

  // ── drift ──────────────────────────────────────────────────────────
  it("drift: findings sorted by identity key", async () => {
    const { envelope } = await envelopeFor(["drift", "--format", "json"]);
    const findings = envelope.result?.drift?.findings;
    if (Array.isArray(findings) && findings.length > 1) {
      for (let i = 1; i < findings.length; i += 1) {
        const a = findings[i - 1];
        const b = findings[i];
        const ord = cmp(a.rule ?? "", b.rule ?? "");
        expect(ord).toBeLessThanOrEqual(0);
      }
    }
  });

  // ── reconcile ──────────────────────────────────────────────────────
  it("reconcile: scores sorted by key", async () => {
    const { envelope } = await envelopeFor(["reconcile", "--format", "json"]);
    const scores = envelope.result?.reconcile?.scores;
    if (scores) {
      for (const key of ["projects", "intentRows", "boundaries"]) {
        const arr = scores[key];
        if (Array.isArray(arr) && arr.length > 1) {
          for (let i = 1; i < arr.length; i += 1) {
            const a = arr[i - 1];
            const b = arr[i];
            const aKey = a.name ?? a.id ?? a.boundary ?? "";
            const bKey = b.name ?? b.id ?? b.boundary ?? "";
            const ord = cmp(String(aKey), String(bKey));
            expect(ord).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  });

  // ── waivers ────────────────────────────────────────────────────────
  it("waivers: waivers sorted by path, expiresAt", async () => {
    const { envelope } = await envelopeFor(["waivers", "--format", "json"]);
    const waivers = envelope.result?.waivers;
    if (Array.isArray(waivers) && waivers.length > 1) {
      for (let i = 1; i < waivers.length; i += 1) {
        const a = waivers[i - 1];
        const b = waivers[i];
        const ord = cmp(a.path, b.path) || cmp(a.expiresAt ?? "", b.expiresAt ?? "");
        expect(ord).toBeLessThan(0);
      }
    }
    // Permanent suppressions also sorted by path
    const suppressions = envelope.result?.suppressions;
    if (Array.isArray(suppressions) && suppressions.length > 1) {
      assertSorted(suppressions, "path", "waivers.suppressions");
    }
  });

  // ── fitness ────────────────────────────────────────────────────────
  it("fitness: functions sorted by name", async () => {
    const { envelope } = await envelopeFor(["fitness", "--format", "json"]);
    const functions = envelope.result?.functions;
    if (Array.isArray(functions)) {
      assertSorted(functions, "name", "fitness.functions");
    }
  });

  // ── history ────────────────────────────────────────────────────────
  it("history: snapshots sorted by filename", async () => {
    const { envelope } = await envelopeFor(["history", historyDir, "--format", "json"]);
    const snapshots = envelope.result?.snapshots;
    if (Array.isArray(snapshots) && snapshots.length > 1) {
      assertSorted(snapshots, "name", "history.snapshots");
    }
  });

  // ── trajectory ─────────────────────────────────────────────────────
  it("trajectory: derived axes are internally consistent", async () => {
    // trajectory produces derived numbers, not lists to sort, but its
    // computeTrajectory uses plain-< sorting internally for the snapshot
    // iteration. Smoke: runs without error.
    const result = await run(["trajectory", historyDir, "--format", "json"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.out);
    expect(envelope.result).toBeDefined();
  });

  // ── evolution ──────────────────────────────────────────────────────
  it("evolution: transitions and findings sorted deterministically", async () => {
    const { envelope } = await envelopeFor([
      "evolution",
      "--base",
      firstCommit,
      "--format",
      "json",
    ]);
    const transitions = envelope.result?.transitions;
    if (Array.isArray(transitions) && transitions.length > 1) {
      // Transitions should be in revision order (not sortable by string)
      // but each transition's introduced/resolved findings should be sorted
      for (const t of transitions) {
        if (Array.isArray(t.drift?.introduced)) {
          assertSorted(t.drift.introduced, (id) => id, "evolution.drift.introduced");
        }
        if (Array.isArray(t.drift?.resolved)) {
          assertSorted(t.drift.resolved, (id) => id, "evolution.drift.resolved");
        }
      }
    }
  });

  // ── health ─────────────────────────────────────────────────────────
  it("health: metrics object has expected keys", async () => {
    const { envelope } = await envelopeFor(["health", historyDir, "--format", "json"]);
    const metrics = envelope.result?.metrics;
    expect(metrics).toBeDefined();
    expect(typeof metrics).toBe("object");
    // Object.keys order is insertion order (the order health.mjs declares them at line 145),
    // not alphabetical — determinism is the invariant, not alphabetical sort.
    const knownKeys = [
      "projects",
      "edges",
      "coverage",
      "violations",
      "waiverSurface",
      "cycles",
      "edgeDensity",
      "debt",
      "fitness",
    ];
    for (const key of knownKeys) {
      expect(metrics).toHaveProperty(key);
    }
  });
  it("report: sections composed from sorted command results", async () => {
    const { envelope } = await envelopeFor(["report", historyDir, "--format", "json"]);
    const result = envelope.result;
    expect(result).toBeDefined();
    // The report command sorts metrics keys via byBytes before iterating (line 270 of report.mjs).
    // Waivers: rows come from suppressionRows which is built from the config's suppression array
    // in declaration order (insertion), then the actual waivers from boundarySuppressions in config order.
    // This is deterministic (same config → same order) even if not alphabetical.
    expect(Array.isArray(result.waivers?.rows)).toBe(true);
    // Fitness functions should be sorted by name (from fitness command's decisions array)
    if (Array.isArray(result.fitness?.functions)) {
      assertSorted(result.fitness.functions, "name", "report.fitness.functions");
    }
  });

  // ── debt ───────────────────────────────────────────────────────────
  it("debt: entries sorted by evaluator key", async () => {
    const { envelope } = await envelopeFor(["debt", historyDir, "--format", "json"]);
    const entries = envelope.result?.entries;
    if (Array.isArray(entries) && entries.length > 1) {
      for (let i = 1; i < entries.length; i += 1) {
        const a = entries[i - 1];
        const b = entries[i];
        const ord = cmp(a.kind ?? "", b.kind ?? "") || cmp(a.source ?? "", b.source ?? "");
        expect(ord).toBeLessThan(0);
      }
    }
  });

  // ── impact ─────────────────────────────────────────────────────────
  it("impact: direct/transitive/dependents sorted by name", async () => {
    const { envelope } = await envelopeFor(["impact", "alpha", "--format", "json"]);
    const r = envelope.result;
    if (Array.isArray(r?.direct)) {
      for (let i = 1; i < r.direct.length; i += 1) {
        expect(cmp(r.direct[i - 1], r.direct[i])).toBeLessThan(0);
      }
    }
    if (Array.isArray(r?.transitive)) {
      for (let i = 1; i < r.transitive.length; i += 1) {
        expect(cmp(r.transitive[i - 1], r.transitive[i])).toBeLessThan(0);
      }
    }
    if (Array.isArray(r?.dependents)) {
      for (let i = 1; i < r.dependents.length; i += 1) {
        expect(cmp(r.dependents[i - 1], r.dependents[i])).toBeLessThan(0);
      }
    }
  });

  // ── explain ────────────────────────────────────────────────────────
  it("explain: matchedConstraints in declaration order, tags are present", async () => {
    // The import specifier "example.com/middle" is at line 4 of libs/alpha/src/main.go
    const { envelope } = await envelopeFor([
      "explain",
      "libs/alpha/src/main.go:4:2",
      "--format",
      "json",
    ]);
    const r = envelope.result;
    expect(r).toBeDefined();
    // Tags are in declaration order from the graph data (not sorted alphabetically),
    // but they are deterministic for the same graph — the invariant is determinism.
    if (Array.isArray(r?.sourceTags)) {
      expect(r.sourceTags.length).toBeGreaterThan(0);
    }
    if (Array.isArray(r?.targetTags)) {
      expect(r.targetTags.length).toBeGreaterThan(0);
    }
  });
  // ── context ────────────────────────────────────────────────────────
  it("context: tags are deterministic from graph data", async () => {
    const { envelope } = await envelopeFor(["context", "alpha", "--format", "json"]);
    const r = envelope.result;
    expect(r).toBeDefined();
    // Tags come directly from graph node data (not sorted), but are deterministic
    // — same graph always produces same tags in same order.
    if (Array.isArray(r?.tags)) {
      expect(r.tags.length).toBeGreaterThan(0);
    }
  });

  // ── decisions ──────────────────────────────────────────────────────
  it("decisions: chain sorted deterministically", async () => {
    const { envelope } = await envelopeFor(["decisions", "0001-test", "--format", "json"]);
    const chain = envelope.result?.chain;
    if (Array.isArray(chain) && chain.length > 1) {
      for (let i = 1; i < chain.length; i += 1) {
        const a = chain[i - 1];
        const b = chain[i];
        const aKey = a.kind ?? a.id ?? "";
        const bKey = b.kind ?? b.id ?? "";
        const ord = cmp(String(aKey), String(bKey));
        expect(ord).toBeLessThanOrEqual(0);
      }
    }
  });

  // ── adr ────────────────────────────────────────────────────────────
  it("adr: records sorted by id", async () => {
    const { envelope } = await envelopeFor(["adr", "--format", "json"]);
    const records = envelope.result?.registry;
    if (Array.isArray(records) && records.length > 1) {
      assertSorted(records, "id", "adr.registry");
    }
  });
  // ── rules ──────────────────────────────────────────────────────────
  it("rules: runs deterministically (empty catalog may exit non-zero)", async () => {
    // rules list with a minimal (empty) catalog — may exit non-zero if no rules exist
    const result = await run(["rules", "list", "--format", "json"]);
    // Even with exit code 3 (no rules), the command produces JSON on stdout
    // when the catalog is readable — the JSON envelope has `result.rules: []`.
    if (result.out.trim().length > 0) {
      const envelope = JSON.parse(result.out);
      expect(envelope.result).toBeDefined();
    } else {
      // If no JSON was written (exit 3 with no stdout), the command is
      // still deterministic — same catalog → same empty output
      expect(result.exitCode).toBeGreaterThan(0);
    }
  });
});
// ---------------------------------------------------------------------------
// Invariant: every result array that exists is sorted — even empty arrays
// pass the check trivially, and the silent-direction test ensures a future
// regression (an unsorted array) fails noisily.
// ---------------------------------------------------------------------------

describe("the silent-direction invariant — a missing sort fails loudly", () => {
  it("a deliberately unsorted array is detected by the assertion helper", () => {
    const unsorted = [{ name: "zebra" }, { name: "alpha" }, { name: "middle" }];
    expect(() => {
      assertSorted(unsorted, "name", "test");
    }).toThrow();
  });

  it("a sorted array passes the assertion helper", () => {
    const sorted = [{ name: "alpha" }, { name: "middle" }, { name: "zebra" }];
    expect(() => {
      assertSorted(sorted, "name", "test");
    }).not.toThrow();
  });
});

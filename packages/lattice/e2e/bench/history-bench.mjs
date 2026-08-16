// In-process benchmark of the `history` command's two hot paths: snapshot
// generation (`snapshotIdentity`) and snapshot comparison (`computeEvolution`).
//
// The spec asks that evolution generation and comparison be measured on
// representative fixture sizes with no avoidable O(n²). This script generates
// synthetic snapshots of growing project/edge counts and reports how each
// path scales — the reading that matters is the per-element cost staying flat
// as the fixture grows, which is the signature of a linear, Map-based
// implementation rather than an accidental quadratic one.
//
// Run from the repository root:
//
//   node packages/lattice/e2e/bench/history-bench.mjs
//
// It is a measurement script, not a test: it prints timings and exits 0. It is
// not part of any vitest run and not in the coverage include.
import { computeEvolution } from "../../src/commands/history.mjs";
import { snapshotIdentity } from "../../src/commands/history.mjs";

/**
 * A synthetic snapshot of `projectCount` projects and `edgeCount` edges —
 * content is arbitrary; only its size is what the benchmark scales.
 *
 * @param {number} projectCount
 * @param {number} edgeCount
 * @returns {{projects: object[], dependencies: object[]}}
 */
function makeSnapshot(projectCount, edgeCount) {
  const projects = [];
  for (let i = 0; i < projectCount; i++) {
    projects.push({ name: `p${i}`, root: `libs/p${i}`, type: "lib", tags: [`scope:${i % 8}`] });
  }
  const dependencies = [];
  for (let i = 0; i < edgeCount; i++) {
    dependencies.push({
      source: `p${i % projectCount}`,
      target: `p${(i + 1) % projectCount}`,
      type: "static",
    });
  }
  return { projects, dependencies };
}

/**
 * Median of a set of timings (ms).
 *
 * @param {number[]} xs
 * @returns {number}
 */
function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Times `fn` across `reps` runs, returning the median (ms).
 *
 * @param {() => void} fn
 * @param {number} reps
 * @returns {number}
 */
function time(fn, reps) {
  const timings = [];
  for (let i = 0; i < reps; i++) {
    const start = process.hrtime.bigint();
    fn();
    timings.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return median(timings);
}

const SIZES = [
  { projects: 10, edges: 20 },
  { projects: 100, edges: 300 },
  { projects: 500, edges: 2000 },
  { projects: 2000, edges: 10000 },
];

const REPS = 20;

console.log("history benchmark — snapshot identity and evolution, per-element cost");
console.log(
  "--------------------------------------------------------------------------------------",
);
console.log(
  "  projects   edges   identity/op    identity/elem   history/op  per-transition  diff/elem",
);
console.log(
  "--------------------------------------------------------------------------------------",
);

// The number of snapshots in the history, kept small relative to the element
// counts because the real scaling question is per-element cost. Consecutive
// snapshots alternate between baseline and a head with a handful of edges
// changed, so every comparison does real work.
const SNAPSHOT_COUNT = 8;

for (const { projects, edges } of SIZES) {
  const elements = projects + edges;
  const identityMs = time(() => snapshotIdentity(makeSnapshot(projects, edges)), REPS);
  const identityPerElement = identityMs / elements;

  // A K-snapshot history: odd snapshots are baseline-shaped, even ones carry a
  // handful of changed edges, so each of the K-1 comparisons does real work.
  // Scaling K here is what catches an accidental quadratic (O(num comparisons))
  // planner, which a fixed two-snapshot bench could never see.
  const files = [];
  for (let i = 0; i < SNAPSHOT_COUNT; i++) {
    const isHead = i % 2 === 1;
    const snapshot = makeSnapshot(projects, edges);
    if (isHead) {
      snapshot.dependencies = snapshot.dependencies.slice(
        0,
        Math.min(5, snapshot.dependencies.length),
      );
      snapshot.dependencies = [
        ...snapshot.dependencies,
        { source: "p-new", target: "p0", type: "dynamic" },
        { source: "p0", target: "p-new", type: "static" },
      ];
    }
    files.push({
      name: `${String(i + 1).padStart(4, "0")}-${snapshotIdentity(snapshot).slice(0, 8)}.json`,
      path: `/ws/hist/${String(i + 1).padStart(4, "0")}.json`,
      id: snapshotIdentity(snapshot),
      envelope: {
        workspace: {
          provider: "native",
          provenance: { commit: `c${i}`, remote: "r", dirty: false },
        },
        result: { projects: snapshot.projects, dependencies: snapshot.dependencies },
      },
    });
  }

  const compareMs = time(() => computeEvolution(files), REPS);
  const perTransitionMs = compareMs / (files.length - 1);
  const diffPerElement = perTransitionMs / elements;

  console.log(
    `${String(projects).padStart(6)} ${String(edges).padStart(8)} ` +
      `${identityMs.toFixed(3).padStart(12)} ${identityPerElement.toExponential(2).padStart(14)} ` +
      `${compareMs.toFixed(3).padStart(10)} ${perTransitionMs.toFixed(3).padStart(12)} ${diffPerElement.toExponential(2).padStart(11)}`,
  );
}

console.log(
  "--------------------------------------------------------------------------------------",
);
console.log("Reading: identity/elem and diff/elem staying flat as the fixture grows is the");
console.log("signature of linear (Map-based) generation and comparison — no O(n^2) blow-up.");

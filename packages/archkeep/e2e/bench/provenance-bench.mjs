// In-process benchmark of the `provenance` command's hot path in
// `buildProvenanceGraph`: the decision → row binding-edge scan.
//
// Ledger F7: binding edges are built at O(decisions × bindings × rows), the
// row-side normalization `stripRuleFitnessPrefix(row.id ?? row.label ?? "")`
// recomputed once per binding per row, and provenance had no benchmark — the
// existing bench covers snapshot identity and evolution only (#889). This
// script scales the graph over synthetic decision/row/binding shapes and
// reports per-element cost; the reading that matters is whether the cost at
// realistic scale (hundreds of ADR records, thousands of rows) is worth the
// one optimization the block admits: hoisting the row-side normalization —
// a pure function of the row list — out of the scan.
//
// Run from the repository root:
//
//   node packages/archkeep/e2e/bench/provenance-bench.mjs
//
// It is a measurement script, not a test: it prints timings and exits 0 —
// unless a fixture produced the wrong binding-edge count, in which case it
// exits 1 (an empty-edge bench proves nothing). It is not part of any vitest
// run and not in the coverage include.
import { buildProvenanceGraph } from "../../src/governance/provenance-graph.mjs";

/** The identity vocabulary size: rows share names, so a binding of one name
 *  matches a realistic slice of rows — neither none nor all. */
const NAME_COUNT = 96;

/**
 * Synthetic provenance input: `decisionCount` ADR records with
 * `bindingsPerDecision` bindings each, and `rowCount` governance rows whose
 * identities come from a small vocabulary so a binding matches a realistic
 * share of the rows. Row shapes cycle through the four the binding scan
 * actually sees: a plain identity, a `rule:`-prefixed identity, a
 * `fitness:`-prefixed label, and a descriptive label no binding targets — so
 * `stripRuleFitnessPrefix` cost is real, and both the match and the
 * never-match paths are exercised. Bindings are plain names (the `rule:`/
 * `fitness:` prefixes are a row-side spelling), drawn deterministically by
 * index arithmetic — no RNG, same input every run.
 *
 * @param {number} decisionCount
 * @param {number} rowCount
 * @param {number} bindingsPerDecision
 * @returns {{
 *   repo: {commit: string, remote: string, dirty: boolean},
 *   rows: object[],
 *   records: object[],
 *   byId: Map<string, object>,
 *   knownFitness: Set<string>,
 *   decisionLifecycle: object[],
 * }}
 */
function makeInput(decisionCount, rowCount, bindingsPerDecision) {
  const records = [];
  for (let i = 0; i < decisionCount; i++) {
    const bindings = [];
    for (let b = 0; b < bindingsPerDecision; b++) {
      bindings.push(`name-${(i * 5 + b * 7) % NAME_COUNT}`);
    }
    const id = `${String(i).padStart(4, "0")}-bench`;
    records.push({
      id,
      status: "active",
      supersedes: [],
      supersededBy: [],
      bindings,
      created: "2026-01-01",
      updated: "2026-09-01",
    });
  }

  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const name = `name-${(i * 7) % NAME_COUNT}`;
    const kind = `depConstraints[${i}]`;
    const shape = i % 6;
    const row = { kind, attested: true, origin: { by: "t", tool: "b" } };
    if (shape === 0 || shape === 1) {
      // Plain identity + descriptive label (matches a plain binding as-is).
      row.id = name;
      row.label = `row ${i} binds ${name}`;
    } else if (shape === 2) {
      // `rule:`-prefixed identity — needs stripRuleFitnessPrefix to match.
      row.id = `rule:${name}`;
      row.label = `row ${i} binds ${name}`;
    } else if (shape === 3) {
      // `fitness:`-prefixed identity — the other strip path.
      row.id = `fitness:${name}`;
      row.label = `row ${i} binds ${name}`;
    } else if (shape === 4) {
      // No id; `fitness:`-prefixed label — the label-only strip path.
      row.label = `fitness:${name}`;
    } else {
      // No id, descriptive label only — never matches any binding.
      row.label = `row ${i} of ${rowCount}`;
    }
    rows.push(row);
  }

  const byId = new Map(records.map((r) => [r.id, r]));
  const decisionLifecycle = records.map((r) => ({
    id: r.id,
    status: "active",
    authority: true,
    created: r.created,
    updated: r.updated,
    supersedes: [],
    supersededBy: [],
    bindings: r.bindings,
    attribution: {
      createdBy: { by: "t <t@example.com>", tool: "git", on: "2026-01-02T00:00:00.000Z" },
      lastChangedBy: { by: "t <t@example.com>", tool: "git", on: "2026-09-01T00:00:00.000Z" },
    },
    attested: true,
    note: null,
  }));

  return {
    repo: { commit: "c", remote: "r", dirty: false },
    rows,
    records,
    byId,
    knownFitness: new Set(),
    decisionLifecycle,
  };
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
  { decisions: 100, rows: 1000 },
  { decisions: 100, rows: 5000 },
  { decisions: 100, rows: 10000 },
  { decisions: 500, rows: 1000 },
  { decisions: 500, rows: 5000 },
  { decisions: 500, rows: 10000 },
  { decisions: 1000, rows: 1000 },
  { decisions: 1000, rows: 5000 },
  { decisions: 1000, rows: 10000 },
];

// Same convention as history-bench: medians over 20 reps.
const BINDINGS = [0, 1, 5];
const REPS = 20;

const PAD = (w) => (s) => String(s).padStart(w);

console.log("provenance benchmark — buildProvenanceGraph binding edges, per-element cost");
console.log(
  "--------------------------------------------------------------------------------------",
);
console.log(
  `  ${PAD(8)("decisions")} ${PAD(8)("rows")} ${PAD(8)("bindings")} ${PAD(12)("graph/op")} ${PAD(14)("per-element")} ${PAD(9)("binding edges")}`,
);
console.log(
  "--------------------------------------------------------------------------------------",
);

for (const { decisions, rows } of SIZES) {
  for (const bindings of BINDINGS) {
    const input = makeInput(decisions, rows, bindings);

    // Sanity: the fixture must actually produce binding edges when bindings
    // are declared — an empty-edge bench proves nothing — and none when they
    // are not. Counted on one build, outside the timed loop.
    const graph = buildProvenanceGraph(input);
    const bindingEdges = graph.edges.filter((e) => e.kind === "binding").length;
    if (bindingEdges > 0 !== bindings > 0) {
      console.error(
        `provenance bench: fixture invariant broken — decisions=${decisions} rows=${rows} ` +
          `bindings=${bindings} produced ${bindingEdges} binding edges (expected ${bindings > 0 ? "> 0" : "0"}).`,
      );
      process.exit(1);
    }

    const graphMs = time(() => buildProvenanceGraph(input), REPS);
    // Per-element denominator: every (decision × row) pair scanned per
    // binding; bindings = 0 scans nothing, so the denominator falls back to
    // the pair count, making that row the non-binding baseline.
    const elements = decisions * rows * Math.max(bindings, 1);
    const perElement = graphMs / elements;

    console.log(
      `${PAD(8)(decisions)} ${PAD(8)(rows)} ${PAD(8)(bindings)} ` +
        `${PAD(12)(graphMs.toFixed(3))} ${PAD(14)(perElement.toExponential(2))} ${PAD(9)(bindingEdges)}`,
    );
  }
}

console.log(
  "--------------------------------------------------------------------------------------",
);
console.log("Reading: per-element cost staying flat as decisions × rows × bindings grow is the");
console.log(
  "signature of the (linear-per-binding) scan the block performs; a rising curve is O(n^2)",
);
console.log("in disguise. bindings = 0 is the non-binding baseline — the graph build without the");
console.log("scan — and the gap to bindings = 1 is the scan's own cost per (decision × row)");
console.log("element. The realistic reading for a repository is the hundreds-of-records ×");
console.log("thousands-of-rows band. The optimization the block admits — hoisting the row-side");
console.log("stripRuleFitnessPrefix into a map — was prototyped and measured against this curve");
console.log("(interleaved A/B over identical fixtures, byte-identical output) and bought nothing:");
console.log("the per-element constant is the loop and its comparisons, not the strip. No");
console.log("optimization lands; this bench is the tripwire that catches one moving the constant.");

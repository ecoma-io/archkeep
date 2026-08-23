/**
 * The reconcile report's terminal rendering, pinned where the command test
 * cannot be: `../commands/reconcile.test.mjs` drives the whole command and
 * pinned its clean path by the sentence alone (`✔ no divergence`) — so a
 * regression that rendered that verdict over WRONG or ZEROED counts (files
 * never scanned, edges never checked) stayed green while the report claimed a
 * coverage it did not have. The counts clause is the half a reader acts on,
 * which is why it is pinned here against numbers COMPUTED FROM THE FIXTURE —
 * the same pattern `../lsp/diagnostics.test.mjs` uses for positions — plus
 * the two edges of the proposal block: an empty candidate list and no
 * candidates asked for at all.
 *
 * This module decides nothing (`./reconcile-text.mjs`'s own header); these
 * tests hold its prose to the numbers it was handed.
 */
import { describe, expect, it } from "vitest";

import { formatReconcileReport } from "./reconcile-text.mjs";

/** One scored element, minimally filled — only what the renderer reads. */
const scored = (name, state, classification = state) => ({
  plane: "project",
  name,
  state,
  severity: 1,
  classification,
  intentRow: null,
  confidence: "stated",
});

/** Empty score groups — every plane present, nothing diverging. */
const emptyScores = () => ({
  projects: [],
  edges: [],
  tags: [],
  boundaries: [],
  intentRows: [],
});

describe("formatReconcileReport — the clean path", () => {
  it("renders the counts it was handed, beside the verdict", () => {
    const projects = [
      { name: "core", root: "libs/core" },
      { name: "util", root: "libs/util" },
    ];
    const edges = [[{ source: "core", target: "util" }], [{ source: "util", target: "core" }]];
    const observed = {
      projects: projects.length,
      edges: edges.reduce((count, list) => count + list.length, 0),
      implicitEdges: 0,
    };
    const intent = { fingerprint: "f".repeat(64), rows: 3 };

    const text = formatReconcileReport({
      scores: emptyScores(),
      candidates: null,
      intent,
      observed,
    });

    // Every number below is read back off the fixture objects above, so
    // changing the fixture moves the expectation with it: a zeroed or stale
    // count in the rendering cannot agree with a fixture that says otherwise.
    expect(text).toContain(`intent    ${intent.fingerprint} — ${intent.rows} rows`);
    expect(text).toContain(`observed  ${observed.projects} projects, ${observed.edges} edges`);
    expect(text).toContain(
      `✔ no divergence — the observed architecture matches the intended model ` +
        `(${observed.projects} projects and ${observed.edges} edges)`,
    );
  });

  it("uses the singular a reader actually sees at one project, one edge, one row", () => {
    const text = formatReconcileReport({
      scores: emptyScores(),
      candidates: null,
      intent: { fingerprint: "a".repeat(64), rows: 1 },
      observed: { projects: 1, edges: 1, implicitEdges: 0 },
    });
    expect(text).toContain("observed  1 project, 1 edge");
    expect(text).toContain("(1 project and 1 edge)");
    expect(text).toContain("— 1 row\n");
  });

  it("names the implicit edges it excluded, in both places a count appears", () => {
    const text = formatReconcileReport({
      scores: emptyScores(),
      candidates: null,
      intent: { fingerprint: "b".repeat(64), rows: 2 },
      observed: { projects: 2, edges: 4, implicitEdges: 3 },
    });
    // The observed line excludes them explicitly…
    expect(text).toContain("observed  2 projects, 4 edges (3 implicit edges excluded)");
    // …and so does the verdict's own counts clause — the one place a reader
    // checks whether "no divergence" covered everything.
    expect(text).toContain("(2 projects and 4 edges (3 implicit excluded))");
  });

  it("renders the all-zero edge without inventing coverage", () => {
    // The renderer's own empty-input edge: zero of everything must still say
    // zero, in every clause — never a bare "no divergence" that reads as a
    // claim about a comparison that inspected nothing.
    const text = formatReconcileReport({
      scores: emptyScores(),
      candidates: null,
      intent: { fingerprint: "c".repeat(64), rows: 0 },
      observed: { projects: 0, edges: 0, implicitEdges: 0 },
    });
    expect(text).toContain("observed  0 projects, 0 edges");
    expect(text).toContain("(0 projects and 0 edges)");
    expect(text).toContain("— 0 rows");
  });
});

describe("formatReconcileReport — the proposal face", () => {
  /** @type {import("../governance/reconcile-candidates.mjs").CandidateEdit} */
  const candidate = {
    kind: "removal",
    name: "ghost",
    evidence: "projectMissing",
    proposed: true,
    notAuthoritative: true,
    edit: { action: "remove", section: "projects.required", reason: "projectMissing" },
    plane: "project",
    state: "absent",
    severity: 1,
    intentRow: { plane: "project", index: 0, kind: "required", key: "ghost" },
  };

  it("announces an EMPTY candidate list as zero candidates — and prints no rows, no waiver line", () => {
    // The silent-direction edge: `--propose` over an agreement produces a
    // proposal block with nothing in it. It must still SAY zero — silence
    // would be indistinguishable from the flag being ignored — and it must
    // not print the apply-with-review footer that exists to follow REAL
    // rows: a warning line under no rows warns about nothing.
    const text = formatReconcileReport({
      scores: emptyScores(),
      candidates: [],
      intent: { fingerprint: "d".repeat(64), rows: 1 },
      observed: { projects: 1, edges: 0, implicitEdges: 0 },
    });
    expect(text).toContain(
      "proposal  0 candidates, ranked — proposed, not authoritative, never written",
    );
    expect(text).not.toContain("apply none of these");
  });

  it("lists each candidate under the proposal header, with the review line after real rows", () => {
    const text = formatReconcileReport({
      scores: emptyScores(),
      candidates: [candidate],
      intent: { fingerprint: "e".repeat(64), rows: 1 },
      observed: { projects: 1, edges: 0, implicitEdges: 0 },
    });
    expect(text).toContain(
      "proposal  1 candidate, ranked — proposed, not authoritative, never written",
    );
    expect(text).toContain("removal  ghost  (remove in projects.required — projectMissing)");
    expect(text).toContain(
      "apply none of these without review; architecture-intent.json is untouched",
    );
  });
});

describe("formatReconcileReport — the diverging path", () => {
  it("totals the diverging elements across planes and ends with the counts clause", () => {
    const scores = {
      ...emptyScores(),
      projects: [scored("ghost", "absent", "projectMissing"), scored("core", "match", "match")],
      edges: [
        {
          plane: "edge",
          name: "core → adapter",
          state: "unexpected",
          severity: 1,
          classification: "dependencyForbidden",
          intentRow: null,
          confidence: "stated",
        },
      ],
    };
    const text = formatReconcileReport({
      scores,
      candidates: null,
      intent: { fingerprint: "1".repeat(64), rows: 2 },
      observed: { projects: 2, edges: 1, implicitEdges: 0 },
    });
    // One heading per DIVERGING plane, counting that plane alone…
    expect(text).toContain("⚠ 1 element: observed projects the model does not match");
    expect(text).toContain("⚠ 1 element: observed edges the model does not match");
    // …with the matching element left out entirely and the diverging ones
    // carrying their state symbols.
    expect(text).toContain("- ghost  (projectMissing)");
    expect(text).not.toContain("(match)\n");
    expect(text).toContain("+ core → adapter  (dependencyForbidden)");
    // …and the total naming both planes' contributions.
    expect(text).toContain("2 divergences (2 projects and 1 edge)");
  });
});

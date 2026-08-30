/**
 * The W2 additions on the history/trajectory surface: transition records
 * carry the canonical evolution `classifications` (computed, never a second
 * opinion), and the trajectory envelope carries a `trends` block over the
 * SAME comparable transitions the axes count.
 *
 * The two invariants these tests hold:
 *
 * 1. **Additive** — every pre-existing key of a transition record keeps its
 *    value; only `classifications` is appended, and the classification is a
 *    fact about the transition, never a change to one of the existing facts.
 * 2. **An empty result is a claim** — an unclassifiable (one-sided)
 *    transition yields NO fabricated class and a disclosure note; a
 *    trajectory with insufficient or fully-incomparable history yields
 *    `trends: null`, never a zero-filled block.
 */

import { describe, expect, it } from "vitest";

import {
  classifyTransition,
  computeEvolution,
  historyCommand,
  snapshotIdentity,
} from "./history.mjs";
import { INSUFFICIENT_HISTORY, computeTrajectory, trajectoryCommand } from "./trajectory.mjs";
import { formatHistoryReport } from "../report/history-text.mjs";
import { formatTrajectoryReport } from "../report/trajectory-text.mjs";
import { SCHEMA_VERSION } from "../report/json.mjs";

/**
 * A complete graph envelope, malformed nowhere — the same fixture shape
 * `./trajectory.test.mjs` builds, because these tests drive the SAME reader
 * contract (`readSnapshots`' output) the command owns.
 *
 * @param {object} [opts]
 * @param {Array<{name: string, root?: string, type?: string, tags?: string[]}>} [opts.projects]
 * @param {Array<{source: string, target: string, type: string}>} [opts.dependencies]
 * @param {string|null} [opts.provider]
 * @param {string|null} [opts.commit] `null` records NO provenance at all.
 * @param {boolean} [opts.dirty]
 * @param {string} [opts.policy] The policy fingerprint, omitted entirely when
 *   not given — the "no law recorded" state, a different fact from any
 *   fingerprint value.
 */
function envelope({
  projects = [{ name: "a", root: "libs/a", type: "lib", tags: [] }],
  dependencies = [],
  provider = "native",
  commit = "abc",
  dirty = false,
  policy,
} = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    command: "graph",
    workspace: {
      root: "/ws",
      provider,
      marker: "archkeep.json",
      provenance: commit ? { commit, remote: "https://example.test/repo.git", dirty } : null,
    },
    status: "ok",
    exitCode: 0,
    coverage: {
      complete: true,
      projects: projects.length,
      analyzedFiles: 2,
      imports: 1,
      notAnalyzed: [],
      blindSpots: [],
      notes: [],
    },
    result: {
      projects,
      dependencies,
      ...(policy !== undefined ? { policy: { fingerprint: policy } } : {}),
    },
  };
}

/** Shorthand project builders. */
const p = (name) => ({ name, root: `libs/${name}`, type: "lib", tags: [] });

/**
 * Shapes envelopes into what `readSnapshots` returns: `{files: [...]}` in
 * history order, each entry carrying its computed identity.
 *
 * @param {object[]} envelopes
 * @returns {{files: Array<{name: string, path: string, envelope: object, id: string}>}}
 */
function snapshots(envelopes) {
  const pad = `${envelopes.length}`.length;
  return {
    files: envelopes.map((envelope, i) => {
      const result = {
        projects: envelope.result.projects,
        dependencies: envelope.result.dependencies,
        ...(envelope.result.policy ? { policy: envelope.result.policy } : {}),
      };
      return {
        name: `${String(i + 1).padStart(Math.max(4, pad), "0")}-fixture.json`,
        path: `/ws/hist/${String(i + 1).padStart(Math.max(4, pad), "0")}-fixture.json`,
        envelope: {
          coverage: envelope.coverage,
          result,
          workspace: {
            provider: envelope.workspace.provider,
            provenance: envelope.workspace.provenance,
          },
        },
        id: snapshotIdentity(result),
      };
    }),
  };
}

describe("classifyTransition — classifications are canonical, additive facts", () => {
  it("classifies a structural change as CHANGE and leaves every existing key untouched", () => {
    const read = snapshots([
      envelope({ projects: [p("a")] }),
      envelope({ projects: [p("a"), p("b")] }),
    ]);
    const { record } = classifyTransition(read.files[0], read.files[1]);

    expect(record.classifications).toEqual(["CHANGE"]);
    // The additive pin, with literal values: the record carries exactly the
    // pre-W2 keys — unchanged values, same order — plus the appended
    // `classifications`. Nothing renamed, nothing re-ordered, nothing
    // re-interpreted.
    expect(record).toEqual({
      from: read.files[0].name,
      to: read.files[1].name,
      architectureChanged: true,
      changes: {
        addedProjects: [{ name: "b", root: "libs/b", type: "lib", tags: [] }],
        removedProjects: [],
        changedProjects: [],
        addedEdges: [],
        removedEdges: [],
      },
      policyChanged: null,
      policyOneSided: false,
      provenanceChanged: false,
      providerChanged: false,
      codeDrift: false,
      notes: [],
      classifications: ["CHANGE"],
    });
  });

  it("classifies verifiable code drift as DRIFT", () => {
    const read = snapshots([
      envelope({ projects: [p("a")], policy: "fp-1", commit: "abc" }),
      envelope({ projects: [p("a")], policy: "fp-1", commit: "def" }),
    ]);
    const { record } = classifyTransition(read.files[0], read.files[1]);

    expect(record.codeDrift).toBe(true);
    expect(record.classifications).toEqual(["DRIFT"]);
  });

  it("never fabricates DRIFT or CHANGE on a one-sided policy pair — a note says why", () => {
    // One side records the boundary law, the other does not: the pair cannot
    // be compared, so it is disclosed, never folded into a clean class.
    const read = snapshots([
      envelope({ projects: [p("a")], policy: "fp-1" }),
      envelope({ projects: [p("a")] }),
    ]);
    const { record, meta } = classifyTransition(read.files[0], read.files[1]);

    expect(meta.policyOneSided).toBe(true);
    expect(record.classifications).toEqual([]);
    expect(record.notes.join(" ")).toMatch(/could not be compared/);
  });

  it("does not read a provider-only transition as a fully comparable unchanged pair", () => {
    // The classification vocabulary has no provider class, so the record
    // carries `[]` — but the "fully comparable, unchanged pair" disclosure
    // must NOT land here: the pair was disclosed as a carrier change.
    const read = snapshots([
      envelope({ projects: [p("a")], provider: "native", policy: "fp-1" }),
      envelope({ projects: [p("a")], provider: "nx", policy: "fp-1" }),
    ]);
    const { record } = classifyTransition(read.files[0], read.files[1]);

    expect(record.providerChanged).toBe(true);
    expect(record.classifications).toEqual([]);
    expect(record.notes.join(" ")).toMatch(/provider changed/);
    expect(record.notes.join(" ")).not.toMatch(/no classification applies/);
  });

  it("states the empty classification on a fully comparable, unchanged pair", () => {
    const read = snapshots([
      envelope({ projects: [p("a")], policy: "fp-1" }),
      envelope({ projects: [p("a")], policy: "fp-1" }),
    ]);
    const { record } = classifyTransition(read.files[0], read.files[1]);

    expect(record.classifications).toEqual([]);
    expect(record.notes.join(" ")).toMatch(/no classification applies/);
  });

  it("does not read a policy-only transition as an unchanged pair", () => {
    const read = snapshots([
      envelope({ projects: [p("a")], policy: "fp-1" }),
      envelope({ projects: [p("a")], policy: "fp-2" }),
    ]);
    const { record } = classifyTransition(read.files[0], read.files[1]);

    expect(record.policyChanged).toBe(true);
    expect(record.classifications).toEqual([]);
    expect(record.notes.join(" ")).toMatch(/policy \(the declared architectural intent\) changed/);
    expect(record.notes.join(" ")).not.toMatch(/no classification applies/);
  });

  it("lets computeEvolution be exactly the fold of classifyTransition, classifications included", () => {
    const files = snapshots([
      envelope({ projects: [p("a")], policy: "fp-1", commit: "abc" }),
      envelope({ projects: [p("a"), p("b")], policy: "fp-1", commit: "abc" }),
      envelope({ projects: [p("a"), p("b")], policy: "fp-1", commit: "def" }),
    ]).files;

    const folded = computeEvolution(files).transitions;
    const direct = [];
    for (let i = 0; i + 1 < files.length; i++) {
      direct.push(classifyTransition(files[i], files[i + 1]).record);
    }
    expect(folded).toEqual(direct);
    for (const transition of folded) {
      expect(Array.isArray(transition.classifications)).toBe(true);
    }
  });
});

describe("computeTrajectory — trends over comparable transitions", () => {
  it("counts per-class facts over 3+ comparable transitions", () => {
    // t1: a → [a,b]                     CHANGE
    // t2: [a,b] → [a,b] with advanced provenance  DRIFT
    // t3: [a,b] → [a,b,c]               CHANGE
    const read = snapshots([
      envelope({ projects: [p("a")], policy: "fp-1", commit: "aaa" }),
      envelope({ projects: [p("a"), p("b")], policy: "fp-1", commit: "aaa" }),
      envelope({ projects: [p("a"), p("b")], policy: "fp-1", commit: "bbb" }),
      envelope({ projects: [p("a"), p("b"), p("c")], policy: "fp-1", commit: "bbb" }),
    ]);
    const result = computeTrajectory(read.files);

    expect(result.available).toBe(true);
    expect(result.trends).toEqual({
      byClass: { CHANGE: 2, DRIFT: 1, VIOLATION: 0, REPAIR: 0, DECISION_CHANGE: 0 },
      violationsIntroduced: 0,
      violationsResolved: 0,
      comparableTransitions: 3,
      basis: "comparable transition classifications",
      note: expect.stringMatching(/no violation or repair evidence/u),
    });
  });

  it("derives trends from the same incomparable exclusion the axes disclose", () => {
    // t1 is comparable (CHANGE); t2 cannot be compared (policy one-sided) and
    // is excluded from the trend basis exactly as it is excluded from
    // `unchanged` — never silently folded in.
    const read = snapshots([
      envelope({ projects: [p("a")], policy: "fp-1" }),
      envelope({ projects: [p("a"), p("b")], policy: "fp-1" }),
      envelope({ projects: [p("a"), p("b")] }),
    ]);
    const result = computeTrajectory(read.files);

    expect(result.transitions.incomparable).toBe(1);
    expect(result.transitions.unchanged).toBe(0);
    expect(result.trends.comparableTransitions).toBe(1);
    expect(result.trends.byClass.CHANGE).toBe(1);
  });

  it("is idempotent — same snapshots, same trends, every run", () => {
    const read = snapshots([
      envelope({ projects: [p("a")], policy: "fp-1", commit: "aaa" }),
      envelope({ projects: [p("a"), p("b")], policy: "fp-1", commit: "aaa" }),
      envelope({ projects: [p("a"), p("b")], policy: "fp-1", commit: "bbb" }),
    ]);
    expect(computeTrajectory(read.files).trends).toEqual(computeTrajectory(read.files).trends);
  });

  it("returns null trends on insufficient history — never a zero-filled block", () => {
    // The SILENT direction: a zero-filled implementation (byClass all 0,
    // violations 0/0) must fail this test. One snapshot cannot show a trend.
    const read = snapshots([envelope({ projects: [p("a")] })]);
    const result = computeTrajectory(read.files);

    expect(result.available).toBe(false);
    expect(result.unavailableReason).toBe(INSUFFICIENT_HISTORY);
    expect(result.trends).toBeNull();
  });

  it("returns null trends when every transition is incomparable", () => {
    // Two observations, but the only pair cannot be compared: a zero-filled
    // trends block would claim "no change" over evidence this run could not
    // read. It must stay null.
    const read = snapshots([
      envelope({ projects: [p("a")], policy: "fp-1" }),
      envelope({ projects: [p("a")] }),
    ]);
    const result = computeTrajectory(read.files);

    expect(result.available).toBe(true);
    expect(result.trends).toBeNull();
  });
});

describe("trajectoryCommand — trends ride the envelope", () => {
  it("carries the trends block in the returned trajectory", () => {
    const read = snapshots([
      envelope({ projects: [p("a")], policy: "fp-1" }),
      envelope({ projects: [p("a"), p("b")], policy: "fp-1" }),
    ]);
    const result = trajectoryCommand(
      "/ws/hist",
      { root: "/ws", provider: "native", marker: "archkeep.json" },
      { io: { readSnapshots: () => read, resolveProvenance: () => null } },
    );

    expect(result.status).toBe("ok");
    expect(result.trajectory.trends).not.toBeNull();
    expect(result.trajectory.trends.byClass).toEqual({
      CHANGE: 1,
      DRIFT: 0,
      VIOLATION: 0,
      REPAIR: 0,
      DECISION_CHANGE: 0,
    });
  });
});

describe("historyCommand — classifications ride the envelope", () => {
  it("appends classifications to every transition without changing the envelope shape", () => {
    const read = snapshots([
      envelope({ projects: [p("a")] }),
      envelope({ projects: [p("a"), p("b")] }),
    ]);
    const result = historyCommand(
      "/ws/hist",
      {
        root: "/ws",
        provider: "native",
        marker: "archkeep.json",
        analysis: { failures: [], analyzed: 2, imports: 1 },
        graph: { nodes: {}, dependencies: {} },
      },
      { io: { readSnapshots: () => read } },
    );

    expect(result.status).toBe("ok");
    expect(result.evolution.transitions).toHaveLength(1);
    expect(result.evolution.transitions[0].classifications).toEqual(["CHANGE"]);
    expect(result.evolution.transitions[0].architectureChanged).toBe(true);
  });
});

describe("text reporters — appended lines only", () => {
  const coverage = { complete: true, projects: 2, analyzedFiles: 2, imports: 1, notes: [] };

  it("pins the history text form: existing lines byte-identical, classifications appended", () => {
    const read = snapshots([
      envelope({ projects: [p("a")], policy: "fp-1", commit: "abc" }),
      envelope({ projects: [p("a"), p("b")], policy: "fp-1", commit: "abc" }),
      envelope({ projects: [p("a"), p("b")], policy: "fp-1", commit: "def" }),
    ]);
    const evolution = computeEvolution(read.files);
    const text = formatHistoryReport({
      evolution: { dir: "/ws/hist", captured: null, ...evolution },
      coverage,
    });

    // The full form, pinned end to end. changed=1, so the footer names the
    // architectural change; the code-drift transition carries its own line
    // up top and is not counted as an architectural change below.
    expect(text).toBe(
      [
        "history  /ws/hist",
        "3 snapshots, 2 transitions (1 import in 2 files across 2 projects)",
        `0  ${read.files[0].name}  ${read.files[0].id.slice(0, 8)}`,
        `1  ${read.files[1].name}  ${read.files[1].id.slice(0, 8)}`,
        `2  ${read.files[2].name}  ${read.files[2].id.slice(0, 8)}`,
        `~ ${read.files[0].name} → ${read.files[1].name}  (architecture)`,
        "  classifications: CHANGE",
        "  + 1 added project",
        "    b  libs/b",
        `~ ${read.files[1].name} → ${read.files[2].name}  (code drift)`,
        "  classifications: DRIFT",
        "1 transition recorded an architectural change",
      ].join("\n"),
    );
  });

  it("renders the trends block and its basis in the trajectory text", () => {
    const read = snapshots([
      envelope({ projects: [p("a")], policy: "fp-1", commit: "aaa" }),
      envelope({ projects: [p("a"), p("b")], policy: "fp-1", commit: "aaa" }),
      envelope({ projects: [p("a"), p("b")], policy: "fp-1", commit: "bbb" }),
    ]);
    const result = trajectoryCommand(
      "/ws/hist",
      { root: "/ws", provider: "native", marker: "archkeep.json" },
      { io: { readSnapshots: () => read, resolveProvenance: () => null } },
    );
    const text = formatTrajectoryReport({ trajectory: result.trajectory, coverage });

    expect(text).toContain(
      "trends  CHANGE 1 · DRIFT 1 · VIOLATION 0 · REPAIR 0 · DECISION_CHANGE 0 · " +
        "violations introduced 0 · resolved 0",
    );
    expect(text).toContain(
      "trends basis  2 comparable transitions (comparable transition classifications)",
    );
    expect(text).toContain("no violation or repair evidence");
  });

  it("prints trends n/a on insufficient history instead of zeros", () => {
    const read = snapshots([envelope({ projects: [p("a")] })]);
    const result = trajectoryCommand(
      "/ws/hist",
      { root: "/ws", provider: "native", marker: "archkeep.json" },
      { io: { readSnapshots: () => read, resolveProvenance: () => null } },
    );
    const text = formatTrajectoryReport({ trajectory: result.trajectory, coverage });

    expect(text).toContain("trends  n/a");
    expect(text).not.toContain("trends  CHANGE 0");
  });
});

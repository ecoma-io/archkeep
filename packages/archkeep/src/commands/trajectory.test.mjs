import { describe, expect, it } from "vitest";

import { computeEvolution, classifyTransition, snapshotIdentity } from "./history.mjs";
import { INSUFFICIENT_HISTORY, computeTrajectory, trajectoryCommand } from "./trajectory.mjs";
import { formatTrajectoryReport } from "../report/trajectory-text.mjs";
import { SCHEMA_VERSION } from "../report/json.mjs";

/**
 * A complete graph envelope, malformed nowhere — the same fixture shape
 * `./history.test.mjs` builds, because these tests drive the SAME reader
 * contract (`readSnapshots`' output) through the command's IO seam.
 *
 * @param {object} [opts]
 * @param {Array<{name: string, root?: string, type?: string, tags?: string[]}>} [opts.projects]
 * @param {Array<{source: string, target: string, type: string}>} [opts.dependencies]
 * @param {string|null} [opts.provider]
 * @param {string|null} [opts.commit] `null` records NO provenance at all.
 * @param {boolean} [opts.dirty]
 * @param {string} [opts.policy] The policy fingerprint, omitted entirely when
 *   not given — the "no law recorded" state, which is a different fact from
 *   any fingerprint value.
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
/** Shorthand edge builders — `static` unless said otherwise. */
const e = (source, target, type = "static") => ({ source, target, type });

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

describe("computeTrajectory — an increasing trend", () => {
  it("counts exact deltas and events over three monotonically growing observations", () => {
    const read = snapshots([
      envelope({ projects: [p("a")], dependencies: [] }),
      envelope({ projects: [p("a"), p("b")], dependencies: [e("a", "b")] }),
      envelope({
        projects: [p("a"), p("b"), p("c")],
        dependencies: [e("a", "b"), e("a", "c"), e("b", "c")],
      }),
    ]);

    const t = computeTrajectory(read.files);
    expect(t.available).toBe(true);
    expect(t.unavailableReason).toBe(null);
    expect(t.transitions).toEqual({
      count: 2,
      architecture: 2,
      policy: 0,
      provider: 0,
      codeDrift: 0,
      incomparable: 0,
      unchanged: 0,
    });
    // Endpoints: a persisted, b and c arrived.
    expect(t.projects).toEqual({
      first: 1,
      current: 3,
      delta: 2,
      addedEvents: 2,
      removedEvents: 0,
      changedEvents: 0,
      introduced: 2,
      resolved: 0,
      persistent: 1,
    });
    expect(t.edges).toEqual({
      first: 0,
      current: 3,
      delta: 3,
      addedEvents: 3,
      removedEvents: 0,
      changedEvents: null,
      introduced: 3,
      resolved: 0,
      persistent: 0,
    });
  });
});

describe("computeTrajectory — regression and recovery (0 → 2 → 3 → 1 → 0)", () => {
  it("reports churn as events and net movement as zero, never conflating them", () => {
    const edgesAt = [
      [],
      [e("a", "b"), e("b", "a")],
      [e("a", "b"), e("b", "a"), e("a", "c")],
      [e("a", "b")],
      [],
    ];
    const read = snapshots(
      edgesAt.map((dependencies) => envelope({ projects: [p("a"), p("b"), p("c")], dependencies })),
    );

    const t = computeTrajectory(read.files);
    // Five transitions, five architectural ones — every pair moved.
    expect(t.transitions).toEqual({
      count: 4,
      architecture: 4,
      policy: 0,
      provider: 0,
      codeDrift: 0,
      incomparable: 0,
      unchanged: 0,
    });
    expect(t.edges).toEqual({
      first: 0,
      current: 0,
      // Net movement is ZERO — first and last observation agree...
      delta: 0,
      // ...but the series churned: two edges added, then two removed, one
      // more added twice, everything removed again.
      addedEvents: 3,
      removedEvents: 3,
      changedEvents: null,
      introduced: 0,
      resolved: 0,
      persistent: 0,
    });
    expect(t.projects.persistent).toBe(3); // a, b, c stayed throughout
  });

  it("keeps an entity present at both ends but missing in the middle out of `persistent`", () => {
    // A → B → A history: x vanishes from the middle observation. Endpoint
    // fields alone would call that stable; the persistence sweep must not.
    const read = snapshots([
      envelope({ projects: [p("x")], dependencies: [] }),
      envelope({ projects: [], dependencies: [] }),
      envelope({ projects: [p("x")], dependencies: [] }),
    ]);
    const t = computeTrajectory(read.files);
    expect(t.projects).toMatchObject({
      first: 1,
      current: 1,
      delta: 0,
      introduced: 0,
      resolved: 0,
      persistent: 0,
    });
    // The gap is visible where it belongs: as transition events.
    expect(t.projects.addedEvents).toBe(1);
    expect(t.projects.removedEvents).toBe(1);
  });
});

describe("computeTrajectory — persistence", () => {
  it("counts an item present in every observation as persistent", () => {
    const read = snapshots([
      envelope({
        projects: [p("core"), p("extra1")],
        dependencies: [e("core", "ring")],
      }),
      envelope({
        projects: [p("core"), p("extra1"), p("extra2")],
        dependencies: [e("core", "ring")],
      }),
      envelope({
        projects: [p("core")],
        dependencies: [e("core", "ring")],
      }),
    ]);
    const t = computeTrajectory(read.files);
    expect(t.projects.persistent).toBe(1); // core, through all three
    expect(t.edges.persistent).toBe(1); // core→ring, through all three
    // extra1 was in the first observation and gone from the last: resolved.
    // extra2 arrived after the start and left before the end, so the ENDPOINT
    // fields claim nothing about it — its churn lives in the events: one add
    // (into obs 1), two removals (extra1 and extra2 out of obs 1).
    expect(t.projects.resolved).toBe(1);
    expect(t.projects.addedEvents).toBe(1);
    expect(t.projects.removedEvents).toBe(2);
  });

  it("counts a removed item as resolved exactly once, from endpoint evidence", () => {
    const read = snapshots([
      envelope({ projects: [p("a"), p("b")] }),
      envelope({ projects: [p("a")] }),
      envelope({ projects: [p("a")] }),
    ]);
    const t = computeTrajectory(read.files);
    expect(t.projects).toMatchObject({
      removedEvents: 1,
      resolved: 1,
      introduced: 0,
      persistent: 1,
    });
  });

  it("does not call a reintroduced item resolved — removal and return are separate events", () => {
    const read = snapshots([
      envelope({ projects: [p("a"), p("b")] }),
      envelope({ projects: [p("a")] }),
      envelope({ projects: [p("a"), p("b")] }),
    ]);
    const t = computeTrajectory(read.files);
    // b left and came back: one removal event, one addition event, and the
    // endpoint sets happen to agree — so neither introduced nor resolved may
    // claim b moved, and persistence must exclude it (missing from the middle).
    expect(t.projects).toMatchObject({
      addedEvents: 1,
      removedEvents: 1,
      introduced: 0,
      resolved: 0,
      persistent: 1, // a only
    });
  });
});

describe("computeTrajectory — signal independence", () => {
  it("separates a policy-only evolution from the structural trajectory", () => {
    const read = snapshots([
      envelope({ projects: [p("a")], dependencies: [], policy: "fp-1" }),
      envelope({ projects: [p("a")], dependencies: [], policy: "fp-2" }),
      envelope({ projects: [p("a")], dependencies: [], policy: "fp-2" }),
    ]);
    const t = computeTrajectory(read.files);
    expect(t.transitions).toMatchObject({ count: 2, policy: 1, architecture: 0, unchanged: 1 });
    // No structural movement anywhere.
    expect(t.projects.delta).toBe(0);
    expect(t.edges.addedEvents).toBe(0);
    expect(t.edges.removedEvents).toBe(0);
  });

  it("counts code drift separately when provenance advances over a still architecture", () => {
    const read = snapshots([
      envelope({ projects: [p("a")], dependencies: [], commit: "aaa", policy: "fp-1" }),
      envelope({ projects: [p("a")], dependencies: [], commit: "bbb", policy: "fp-1" }),
    ]);
    const t = computeTrajectory(read.files);
    expect(t.transitions).toMatchObject({ count: 1, codeDrift: 1, architecture: 0, policy: 0 });
    // Code drift is not structural churn.
    expect(t.projects.delta).toBe(0);
    expect(t.edges.addedEvents).toBe(0);
  });

  it("never counts a pure provider migration as architecture churn", () => {
    const read = snapshots([
      envelope({
        projects: [p("a")],
        dependencies: [e("a", "b")],
        provider: "native",
      }),
      envelope({
        projects: [p("a")],
        dependencies: [e("a", "b")],
        provider: "nx",
      }),
    ]);
    const t = computeTrajectory(read.files);
    expect(t.transitions).toMatchObject({ count: 1, provider: 1, architecture: 0, unchanged: 0 });
    expect(t.projects.delta).toBe(0);
    expect(t.edges.delta).toBe(0);
  });

  it("counts a transition carrying several signals under EACH of them", () => {
    // Architecture AND provider AND policy all move in one pair — the signal
    // counters are independent facts, not a partition.
    const read = snapshots([
      envelope({ projects: [p("a")], provider: "native", policy: "fp-1" }),
      envelope({ projects: [p("a"), p("b")], provider: "nx", policy: "fp-2" }),
    ]);
    const t = computeTrajectory(read.files);
    expect(t.transitions).toEqual({
      count: 1,
      architecture: 1,
      policy: 1,
      provider: 1,
      codeDrift: 0,
      incomparable: 0,
      unchanged: 0,
    });
  });
});

describe("computeTrajectory — unknown evidence", () => {
  it("reports a one-sided policy fingerprint as incomparable, never as unchanged or changed", () => {
    const read = snapshots([
      envelope({ projects: [p("a")], dependencies: [], policy: "fp-1" }),
      envelope({ projects: [p("a")], dependencies: [] }), // no fingerprint at all
    ]);
    const t = computeTrajectory(read.files);
    expect(t.disclosures.policyOneSided).toBe(1);
    expect(t.transitions.incomparable).toBe(1);
    // The graph is identical, but "unchanged" claims every comparable signal
    // was compared and equal — the aggregate has no notes line to carry the
    // caveat, so the exclusion IS the disclosure.
    expect(t.transitions.unchanged).toBe(0);
    expect(t.transitions.policy).toBe(0);
  });

  it("reports one-sided provenance as incomparable and asserts no code drift on it", () => {
    const read = snapshots([
      envelope({ projects: [p("a")], dependencies: [], commit: "aaa" }),
      envelope({ projects: [p("a")], dependencies: [], commit: null }),
    ]);
    const t = computeTrajectory(read.files);
    expect(t.disclosures.provenanceOneSided).toBe(1);
    expect(t.transitions.incomparable).toBe(1);
    // Code drift needs BOTH sides to carry provenance — asserting drift on a
    // pair whose origin cannot be compared would fabricate a clean reading.
    expect(t.transitions.codeDrift).toBe(0);
    expect(t.transitions.unchanged).toBe(0);
  });

  it("reads a history where NEITHER side carries metadata as unchanged, not incomparable", () => {
    // No fingerprint anywhere is not asymmetry — there is nothing to compare
    // and nothing withheld. This is `snapshot-meta`'s three-state law applied
    // to aggregation: unverifiable-BY-ABSENCE differs from one-sided.
    const read = snapshots([
      envelope({ projects: [p("a")], dependencies: [], commit: null }),
      envelope({ projects: [p("a")], dependencies: [], commit: null }),
    ]);
    const t = computeTrajectory(read.files);
    expect(t.transitions.unchanged).toBe(1);
    expect(t.transitions.incomparable).toBe(0);
    expect(t.disclosures).toEqual({ policyOneSided: 0, provenanceOneSided: 0, crossRepo: 0 });
  });

  it("never reads a provenance-advancing pair without a policy fingerprint on either side as unchanged", () => {
    // F-HIST-1: both-absent is comparable only while nothing moved. Two
    // committed snapshots with no boundary law on either side carried real
    // code motion the tool cannot classify — incomparable, not unchanged,
    // and not disclosed as one-sided (that would be a false fact).
    const read = snapshots([
      envelope({ projects: [p("a")], dependencies: [], commit: "aaa" }),
      envelope({ projects: [p("a")], dependencies: [], commit: "bbb" }),
    ]);
    const t = computeTrajectory(read.files);
    expect(t.transitions.incomparable).toBe(1);
    expect(t.transitions.unchanged).toBe(0);
    expect(t.transitions.codeDrift).toBe(0);
    expect(t.disclosures.policyOneSided).toBe(0);
  });

  it("counts cross-repo pairs and dirty captures as disclosed facts", () => {
    const read = snapshots([
      envelope({
        projects: [p("a")],
        commit: "aaa",
        dirty: true,
      }),
      envelope({
        projects: [p("a")],
        commit: "bbb",
      }),
    ]);
    // Different remotes make the pair cross-repo; the baseline was dirty.
    read.files[1].envelope.workspace.provenance.remote = "https://example.test/other.git";
    const t = computeTrajectory(read.files);
    expect(t.disclosures.crossRepo).toBe(1);
    expect(t.observations.dirtyProvenance).toBe(1);
    expect(t.observations.withProvenance).toBe(2);
  });
});

describe("computeTrajectory — sparse histories", () => {
  it("refuses to derive a trend from ONE observation — insufficient, never zero", () => {
    const read = snapshots([envelope({ projects: [p("a")], dependencies: [e("a", "b")] })]);
    const t = computeTrajectory(read.files);
    expect(t.available).toBe(false);
    expect(t.unavailableReason).toBe(INSUFFICIENT_HISTORY);
    expect(t.transitions).toEqual({
      count: 0,
      architecture: 0,
      policy: 0,
      provider: 0,
      codeDrift: 0,
      incomparable: 0,
      unchanged: 0,
    });
    // Observational facts stay; every DERIVED number is null — a delta of 0
    // would claim stability over a history that cannot show movement.
    expect(t.projects).toEqual({
      first: 1,
      current: 1,
      delta: null,
      addedEvents: null,
      removedEvents: null,
      changedEvents: null,
      introduced: null,
      resolved: null,
      persistent: null,
    });
    expect(t.edges.delta).toBe(null);
    expect(t.edges.introduced).toBe(null);
    expect(t.observations.first).toBe(read.files[0].name);
    expect(t.observations.last).toBe(read.files[0].name);
  });

  it("names the observation basis explicitly", () => {
    const read = snapshots([envelope(), envelope()]);
    expect(computeTrajectory(read.files).observations.basis).toBe("graph_snapshots");
  });
});

describe("computeTrajectory — determinism and scale", () => {
  it("is byte-stable over repeated aggregation of the same bytes", () => {
    const read = snapshots([
      envelope({ projects: [p("a")], dependencies: [e("a", "b")] }),
      envelope({ projects: [p("a"), p("b")], dependencies: [e("a", "b"), e("b", "c")] }),
    ]);
    const a = JSON.stringify(computeTrajectory(read.files));
    const b = JSON.stringify(computeTrajectory(read.files));
    expect(a).toBe(b);
  });

  it("stays linear and exact over hundreds of observations", () => {
    // 300 observations whose edge count grows by one each step, then shrinks;
    // the expected totals have closed forms, so a quadratic accident that
    // mis-aggregates fails here rather than slow-running its way to green.
    const n = 300;
    const peak = 150;
    const envelopes = [];
    for (let i = 0; i < n; i++) {
      const size = i < peak ? i : n - i - 1;
      const dependencies = [];
      for (let j = 0; j < size; j++) dependencies.push(e(`p${j}`, "sink"));
      envelopes.push(envelope({ projects: [p("sink")], dependencies }));
    }
    const read = snapshots(envelopes);
    const t = computeTrajectory(read.files);

    // Every step up adds one edge; every step down removes one. The sizes run
    // 0..149, then hold 149 across the peak transition, then 149..0 — so the
    // peak pair is the one UNCHANGED transition and the rest all move: rises
    // contribute 149 adds, falls 149 removes. Exact, no estimation.
    expect(t.edges.addedEvents).toBe(149);
    expect(t.edges.removedEvents).toBe(149);
    expect(t.edges.first).toBe(0);
    expect(t.edges.current).toBe(0);
    expect(t.edges.delta).toBe(0);
    expect(t.edges.introduced).toBe(0);
    expect(t.edges.resolved).toBe(0);
    // No single edge survived every observation (each exists only around its
    // own index window), so nothing is persistent.
    expect(t.edges.persistent).toBe(0);
    expect(t.projects.persistent).toBe(1); // sink, throughout
    expect(t.transitions.architecture).toBe(n - 2);
  });
});

describe("classifyTransition / computeEvolution — one classification law", () => {
  const files = snapshots([
    envelope({ projects: [p("a")], provider: "native", policy: "fp-1" }),
    envelope({ projects: [p("a"), p("b")], provider: "nx", policy: "fp-1", commit: "bbb" }),
    envelope({ projects: [p("a"), p("b")], provider: "nx", policy: "fp-2", commit: null }),
  ]).files;

  it("lets computeEvolution be exactly the fold of classifyTransition over consecutive pairs", () => {
    const folded = computeEvolution(files).transitions;
    const direct = [];
    for (let i = 0; i + 1 < files.length; i++) {
      direct.push(classifyTransition(files[i], files[i + 1]).record);
    }
    expect(folded).toEqual(direct);
  });

  it("hands the raw metadata comparison beside the record, so aggregators need not parse notes", () => {
    const { record, meta } = classifyTransition(files[1], files[2]);
    // One side carries provenance, the other does not — the note says so in
    // prose, and meta says so in a field an aggregator can count.
    expect(record.notes.join(" ")).toMatch(/provenance could not be compared/);
    expect(meta.provenanceOneSided).toBe(true);
    expect(meta.policyChanged).toBe(true);
  });
});

describe("trajectoryCommand", () => {
  const commandContext = { root: "/ws", provider: "native", marker: "archkeep.json" };

  /** Runs the command over an injected history. */
  function run(read) {
    return trajectoryCommand("/ws/hist", commandContext, {
      io: {
        readSnapshots: () => read,
        resolveProvenance: () => ({ commit: "abc", remote: null, dirty: false }),
      },
    });
  }

  it("builds a descriptive ok envelope carrying the aggregated trajectory", async () => {
    const result = run(
      snapshots([
        envelope({ projects: [p("a")], dependencies: [] }),
        envelope({ projects: [p("a"), p("b")], dependencies: [e("a", "b")] }),
      ]),
    );
    expect(result.status).toBe("ok");

    const parsed = JSON.parse(result.report.json);
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parsed.command).toBe("trajectory");
    expect(parsed.status).toBe("ok");
    expect(parsed.exitCode).toBe(0);
    expect(parsed.result.dir).toBe("/ws/hist");
    expect(parsed.result.available).toBe(true);
    expect(parsed.result.transitions.count).toBe(1);

    // The coverage notes name the observation basis and the rule-impact limit
    // — the two claims a reader could otherwise misread.
    expect(parsed.coverage.complete).toBe(true);
    expect(parsed.coverage.notes.join("\n")).toMatch(/capture points, not commits/);
    expect(parsed.coverage.notes.join("\n")).toMatch(/rule-impact cannot be recomputed/);
  });

  it("produces byte-identical JSON over repeated runs of the same directory", () => {
    const read = snapshots([
      envelope({ projects: [p("a")], dependencies: [] }),
      envelope({ projects: [p("a")], dependencies: [e("a", "b")] }),
    ]);
    expect(run(read).report.json).toBe(run(read).report.json);
  });

  it("refuses an empty history directory loudly, never as a clean trajectory", () => {
    expect(() => run({ files: [] })).toThrow(/contains no snapshots/);
  });
});

describe("formatTrajectoryReport", () => {
  const coverage = {
    complete: true,
    notes: ["basis note", "rule-impact note"],
  };

  it("renders an available trajectory as counts with signs, never adjectives", () => {
    const read = snapshots([
      envelope({ projects: [p("a")], dependencies: [] }),
      envelope({ projects: [p("a"), p("b")], dependencies: [e("a", "b"), e("b", "a")] }),
    ]);
    const text = formatTrajectoryReport({ trajectory: runOf(read), coverage });
    expect(text.split("\n")[0]).toMatch(/^trajectory {2}\/ws\/hist$/);
    expect(text).toContain("2 observations (graph_snapshots), 1 transition");
    expect(text).toContain(
      "signals  architecture 1 · policy 0 · provider 0 · code drift 0 · incomparable 0 · unchanged 0",
    );
    expect(text).toContain(
      "projects  first 1 · current 2 · delta +1 · added 1 · removed 0 · changed 0 · introduced 1 · resolved 0 · persistent 1",
    );
    expect(text).toContain(
      "edges     first 0 · current 2 · delta +2 · added 2 · removed 0 · introduced 2 · resolved 0 · persistent 0",
    );
    expect(text).toContain(
      "disclosures  policy incomparable 0 · provenance incomparable 0 · cross-repo 0 · dirty captures 0 · with provenance 2",
    );
    expect(text).toContain("basis note");
  });

  it("states insufficient history instead of printing zeros", () => {
    const read = snapshots([envelope()]);
    const text = formatTrajectoryReport({ trajectory: runOf(read), coverage });
    expect(text).toContain("✖ insufficient_history: a trajectory needs at least two observations");
    expect(text).toContain("delta n/a");
    expect(text).toContain("persistent n/a");
    expect(text).not.toContain("delta +0");
  });

  /**
   * Wraps a fixture read into the shape the renderer reads.
   *
   * @param {{files: object[]}} read
   */
  function runOf(read) {
    return trajectoryCommand(
      "/ws/hist",
      { root: "/ws", provider: "native", marker: "archkeep.json" },
      {
        io: {
          readSnapshots: () => read,
          resolveProvenance: () => null,
        },
      },
    ).trajectory;
  }
});

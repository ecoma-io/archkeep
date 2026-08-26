import { describe, expect, it } from "vitest";

import { computeDiff } from "./diff.mjs";
import {
  classifyTransition,
  computeEvolution,
  historyCommand,
  snapshotIdentity,
} from "./history.mjs";
import { trajectoryCommand } from "./trajectory.mjs";

/**
 * Cross-command consistency for the history family: `history`, `trajectory`
 * and the raw diff all speak about the SAME stored snapshots, and this file
 * proves they cannot quietly disagree.
 *
 * The commands already share their machinery — `trajectory` imports
 * `readSnapshots` and `classifyTransition` from `history.mjs`, and
 * `classifyTransition` runs `diff.mjs`'s own `computeDiff` — so a disagreement
 * today would take a second, private implementation to create. That is exactly
 * the defect this file is built to catch: a future edit that reimplements one
 * of the three instead of reusing the shared function would pass every
 * command's own suite while two commands answered differently about the same
 * directory. Here, ONE synthetic snapshot set with KNOWN transitions drives
 * every face at once, and the counts must reconcile exactly.
 *
 * The silent direction this file pins, from `trajectory.mjs`'s header: unknown
 * evidence never becomes zero. A pair whose metadata could not be compared
 * (one snapshot carries no fingerprint or no provenance) lands in
 * `incomparable` and NEVER in `unchanged` — an aggregate has no notes line to
 * carry that disclosure, so the exclusion IS the disclosure. The fixture's
 * one-sided pairs exist to turn red on any refactor that folds them into the
 * clean bucket.
 */

let sequence = 0;

/**
 * One stored `graph --format json` snapshot in the exact shape `readSnapshots`
 * produces (the parsed envelope reduced to what the classifiers read).
 */
function snapshot({
  projects = [
    { name: "alpha", root: "libs/alpha", type: "lib", tags: [] },
    { name: "beta", root: "libs/beta", type: "lib", tags: [] },
  ],
  dependencies = [{ source: "alpha", target: "beta", type: "static" }],
  provider = "native",
  provenance,
  fingerprint,
} = {}) {
  sequence += 1;
  const name = `${String(sequence).padStart(4, "0")}-test.json`;
  const result = {
    projects,
    dependencies,
    ...(fingerprint ? { policy: { fingerprint } } : {}),
  };
  return {
    name,
    path: `/ws/hist/${name}`,
    envelope: {
      coverage: {
        complete: true,
        projects: projects.length,
        analyzedFiles: 2,
        imports: 1,
        notAnalyzed: [],
        blindSpots: [],
        notes: [],
      },
      result,
      workspace: { provider, provenance: provenance ?? null },
    },
    id: snapshotIdentity(result),
  };
}

/** The fixture history: five captures whose four transitions are known. */
function knownHistory() {
  const base = {
    projects: [
      { name: "alpha", root: "libs/alpha", type: "lib", tags: [] },
      { name: "beta", root: "libs/beta", type: "lib", tags: [] },
    ],
    dependencies: [{ source: "alpha", target: "beta", type: "static" }],
  };
  const grown = {
    projects: [...base.projects, { name: "gamma", root: "libs/gamma", type: "lib", tags: [] }],
    dependencies: [...base.dependencies, { source: "gamma", target: "beta", type: "static" }],
  };
  return [
    // s1 → s2: gamma and its edge appear — ARCHITECTURE change.
    snapshot({
      ...base,
      provenance: { commit: "c1", remote: "r", dirty: false },
      fingerprint: "fp-1",
    }),
    snapshot({
      ...grown,
      provenance: { commit: "c2", remote: "r", dirty: false },
      fingerprint: "fp-1",
    }),
    // s2 → s3: same graph, but NO fingerprint and NO provenance — the policy
    // and the origin are UNCOMPARABLE, not equal.
    snapshot({ ...grown }),
    // s3 → s4: graph unchanged, fingerprint back, provenance returns — still
    // incomparable (s3 has no fingerprint), never "policy changed".
    snapshot({
      ...grown,
      provenance: { commit: "c3", remote: "r", dirty: false },
      fingerprint: "fp-1",
    }),
    // s4 → s5: graph unchanged, policy comparable AND equal, provenance
    // advanced c3 → c4 — the one true CODE DRIFT transition.
    snapshot({
      ...grown,
      provenance: { commit: "c4", remote: "r", dirty: false },
      fingerprint: "fp-1",
    }),
  ];
}

const context = () => ({
  root: "/ws",
  provider: "native",
  marker: "archkeep.json",
  tracked: [],
  owned: [],
  graph: { nodes: {}, dependencies: {} },
  analysis: { analyzed: 0, analyzedFiles: [], imports: [], failures: [] },
  pluginGap: { registered: true, manifests: [] },
  options: {},
  unownedGap: { files: [], languages: [] },
  unclaimedGap: { files: [] },
});

describe("history ↔ trajectory ↔ evolution over one shared snapshot set", () => {
  const files = knownHistory();
  const ctx = context();
  const io = { readSnapshots: () => ({ files }) };

  it("history's transitions are exactly computeEvolution's over the same files", () => {
    const ran = historyCommand("/ws/hist", ctx, { io });
    expect(ran.evolution.transitions).toEqual(computeEvolution(files).transitions);
    expect(ran.evolution.transitions).toHaveLength(files.length - 1);
  });

  it("trajectory's signal counts reconcile with history's per-transition records", () => {
    const ran = historyCommand("/ws/hist", ctx, { io });
    const trajectory = trajectoryCommand("/ws/hist", ctx, {
      io: { ...io, resolveProvenance: () => null },
    });
    const records = ran.evolution.transitions;

    expect(trajectory.trajectory.transitions.count).toBe(records.length);
    expect(trajectory.trajectory.transitions.architecture).toBe(
      records.filter((t) => t.architectureChanged).length,
    );
    expect(trajectory.trajectory.transitions.policy).toBe(
      records.filter((t) => t.policyChanged === true).length,
    );
    expect(trajectory.trajectory.transitions.provider).toBe(
      records.filter((t) => t.providerChanged).length,
    );
    expect(trajectory.trajectory.transitions.codeDrift).toBe(
      records.filter((t) => t.codeDrift).length,
    );
  });

  it("the known transitions land in exactly the buckets they were built for", () => {
    // Behavior pinning over a KNOWN history — these numbers are the fixture's
    // whole point. If a classifier changes what any transition means, this
    // test goes red before any consumer notices a moved count.
    const trajectory = trajectoryCommand("/ws/hist", ctx, {
      io: { readSnapshots: () => ({ files }), resolveProvenance: () => null },
    }).trajectory.transitions;
    expect(trajectory.count).toBe(4);
    expect(trajectory.architecture).toBe(1);
    expect(trajectory.policy).toBe(0);
    expect(trajectory.provider).toBe(0);
    expect(trajectory.codeDrift).toBe(1);
    expect(trajectory.incomparable).toBe(2);
    expect(trajectory.unchanged).toBe(0);
  });

  it("unknown metadata never becomes unchanged — the one-sided pairs stay incomparable", () => {
    const [s2, s3] = [files[1], files[2]];
    const { record, meta } = classifyTransition(s2, s3);

    // `null` is could-not-be-compared; folding it into `false` is the exact
    // downgrade this file exists to catch (`docs/reference/json-output.md`,
    // history's transitions table).
    expect(meta.policyChanged).toBeNull();
    expect(meta.provenanceOneSided).toBe(true);
    expect(meta.policyOneSided).toBe(true);
    expect(record.policyChanged).toBeNull();
    expect(record.codeDrift).toBe(false);
    // And the disclosure is carried where a reader can see it:
    expect(record.notes.join("\n")).toMatch(/could not be compared/u);

    const trajectory = trajectoryCommand("/ws/hist", ctx, {
      io: { readSnapshots: () => ({ files }), resolveProvenance: () => null },
    }).trajectory.transitions;
    // Both one-sided pairs are counted as incomparable and NOT as unchanged:
    expect(trajectory.incomparable).toBeGreaterThanOrEqual(2);
    expect(trajectory.unchanged).toBe(0);
  });

  it("code drift requires a COMPARABLE policy — provenance advance alone never asserts it", () => {
    // The negative twin of the code-drift count: s4→s5 asserts codeDrift only
    // because both sides carry fingerprints that agree. s3→s4 advances
    // provenance across an incomparable policy and must assert nothing.
    const driftPair = classifyTransition(files[3], files[4]).record;
    expect(driftPair.codeDrift).toBe(true);
    expect(driftPair.architectureChanged).toBe(false);

    const blockedPair = classifyTransition(files[2], files[3]).record;
    expect(blockedPair.codeDrift).toBe(false);
  });
});

describe("history transitions agree with the raw diff over the same pair", () => {
  const files = knownHistory();

  /** computeDiff reads `{projects, dependencies}` off each side's result. */
  const structural = (from, to) => computeDiff(from.envelope.result, to.envelope.result);

  it("a transition's changes ARE the diff's added/removed sets, field for field", () => {
    const { record } = classifyTransition(files[0], files[1]);
    const expected = structural(files[0], files[1]);

    expect(record.changes.addedProjects).toEqual(expected.addedProjects);
    expect(record.changes.removedProjects).toEqual(expected.removedProjects);
    expect(record.changes.changedProjects).toEqual(expected.changedProjects);
    expect(record.changes.addedEdges).toEqual(expected.addedEdges);
    expect(record.changes.removedEdges).toEqual(expected.removedEdges);

    // The flag is derived from the same emptiness, not computed twice:
    expect(record.architectureChanged).toBe(true);
    expect(
      record.changes.addedProjects.length +
        record.changes.removedProjects.length +
        record.changes.changedProjects.length +
        record.changes.addedEdges.length +
        record.changes.removedEdges.length,
    ).toBeGreaterThan(0);
  });

  it("an architecture-identical pair yields empty change lists on BOTH faces", () => {
    // Silent-direction guard for the agreement itself: if `classifyTransition`
    // stopped calling `computeDiff` and started guessing "no changes" from the
    // identity alone, a metadata-only difference would pass here unnoticed —
    // so the emptiness is asserted against the live diff, not hardcoded.
    const [s4, s5] = [files[3], files[4]];
    const { record } = classifyTransition(s4, s5);
    const expected = structural(s4, s5);

    expect(record.architectureChanged).toBe(false);
    // A code-drift transition carries `changes: null` by contract — the graph
    // did not move, and null is not an empty diff. The emptiness claim lives
    // on the raw diff face, asserted live rather than hardcoded:
    expect(record.changes).toBeNull();
    expect(expected.addedEdges).toEqual([]);
    expect(expected.removedEdges).toEqual([]);
    expect(expected.addedProjects).toEqual([]);
  });

  it("tag array order is semantic identity, not noise both faces may normalize away", () => {
    // The deliberate counterpart to key-order invariance: `snapshotIdentity`
    // treats a reordered tags array as a different architecture, so a pair
    // that differs ONLY by tag order must read as changed everywhere —
    // history's flag, the raw diff's changedProjects, and the identity hash.
    const tagged = snapshot({
      projects: [
        { name: "alpha", root: "libs/alpha", type: "lib", tags: ["layer:a", "layer:b"] },
        { name: "beta", root: "libs/beta", type: "lib", tags: [] },
      ],
      dependencies: [],
      provenance: { commit: "c9", remote: "r", dirty: false },
      fingerprint: "fp-1",
    });
    const reorderedTags = snapshot({
      projects: [
        { name: "alpha", root: "libs/alpha", type: "lib", tags: ["layer:b", "layer:a"] },
        { name: "beta", root: "libs/beta", type: "lib", tags: [] },
      ],
      dependencies: [],
      provenance: { commit: "c9", remote: "r", dirty: false },
      fingerprint: "fp-1",
    });

    expect(tagged.id).not.toBe(reorderedTags.id);
    const { record } = classifyTransition(tagged, reorderedTags);
    expect(record.architectureChanged).toBe(true);
    expect(structural(tagged, reorderedTags).changedProjects).toHaveLength(1);
  });
});

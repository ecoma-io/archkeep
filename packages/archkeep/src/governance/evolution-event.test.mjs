import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  classifyEvolution,
  declarationDigest,
  eventDedupeKey,
  eventId,
  EVOLUTION_EVENT_SCHEMA_VERSION,
  EVENT_CLASSIFICATIONS,
} from "./evolution-event.mjs";

const base = { revision: "abc123", snapshot: "0001-11111111.json" };
const head = { revision: "def456", snapshot: "0002-22222222.json" };
const intent = {
  version: "1",
  base: { commit: "abc123" },
  summary: "Add the beta library and let it depend on alpha",
  projects: { add: ["libs/beta"], remove: [] },
  edges: { add: [{ from: "libs/beta", to: "libs/alpha" }], remove: [] },
  constraints: { noNewCycles: true },
};

/** A full event whose id/dedupeKey are derived from the canonical tuple. */
const makeEvent = (overrides = {}) => {
  const event = {
    schemaVersion: EVOLUTION_EVENT_SCHEMA_VERSION,
    kind: "reconcile",
    source: "change",
    base,
    head,
    declaration: { file: "change-intent.json", digest: declarationDigest(intent) },
    observed: {},
    findings: { introduced: [], resolved: [], unknown: [] },
    fitness: { verdictDeltas: [] },
    debt: { introduced: [], resolved: [] },
    classifications: [],
    disposition: "accepted",
    notes: [],
    affected: { projects: [], boundaries: [], constraints: [], decisions: [] },
    // TypeScript placeholders: the real values are derived below, from the one
    // canonical tuple — the same derivation `eventId`/`eventDedupeKey` own.
    id: "",
    dedupeKey: "",
    ...overrides,
  };
  event.dedupeKey = eventDedupeKey(event);
  event.id = eventId(event);
  return event;
};

describe("the evolution event constants", () => {
  it("fixes the schema version at 1", () => {
    expect(EVOLUTION_EVENT_SCHEMA_VERSION).toBe(1);
  });

  it("fixes the five classifications, in the canonical design order", () => {
    expect(EVENT_CLASSIFICATIONS).toEqual([
      "CHANGE",
      "DRIFT",
      "VIOLATION",
      "REPAIR",
      "DECISION_CHANGE",
    ]);
  });
});

describe("eventId", () => {
  it("is the sha256 of the canonical tuple, and stable across runs", () => {
    const event = makeEvent();
    expect(eventId(event)).toBe(createHash("sha256").update(eventDedupeKey(event)).digest("hex"));
    expect(eventId(event)).toHaveLength(64);
    expect(eventId(event)).toBe(eventId(makeEvent()));
  });

  it("changes when the base, head, or declaration digest changes", () => {
    const event = makeEvent();
    expect(eventId(event)).not.toBe(eventId(makeEvent({ base: { revision: "other" } })));
    expect(eventId(event)).not.toBe(eventId(makeEvent({ head: { revision: "other" } })));
    expect(eventId(event)).not.toBe(
      eventId(makeEvent({ declaration: { file: "x.json", digest: "different" } })),
    );
  });

  it("treats a declaration as part of the tuple — with and without differ", () => {
    const event = makeEvent();
    const withoutDeclaration = makeEvent({ declaration: undefined });
    expect(eventId(event)).not.toBe(eventId(withoutDeclaration));
  });

  it("never depends on recordedAt, notes, provenance, or any wall clock", () => {
    // The silent direction this refutes: an id that included the clock or the
    // narration would change between two runs over the SAME transition, so
    // rerunning could never prove idempotency. Every excluded field must be
    // able to differ with the id unchanged.
    const event = makeEvent();
    const later = {
      recordedAt: { by: "cron", tool: "archkeep:v1", on: "2099-01-01T00:00:00.000Z" },
    };
    const differentNotes = { notes: ["a completely different narrative"] };
    const differentProvenance = {
      provenance: [{ kind: "git-commit", ref: "deadbeef", author: "nobody" }],
    };
    expect(eventId(makeEvent({ recordedAt: later.recordedAt }))).toBe(eventId(event));
    expect(eventId(makeEvent({ notes: differentNotes.notes }))).toBe(eventId(event));
    expect(eventId(makeEvent({ provenance: differentProvenance.provenance }))).toBe(eventId(event));
  });
});

describe("declarationDigest", () => {
  it("excludes the prose summary — a re-worded summary leaves the digest unchanged", () => {
    const digest = declarationDigest(intent);
    const reworded = declarationDigest({
      ...intent,
      summary: "A completely different way of narrating the same declared change",
    });
    // The silent direction: the digest is the idempotency surface of a
    // change-intent, and prose is not semantics — a summary edit must not
    // change which event a declared change produces.
    expect(reworded).toBe(digest);
  });

  it("changes when any declarative part changes", () => {
    const digest = declarationDigest(intent);
    expect(declarationDigest({ ...intent, base: { commit: "other" } })).not.toBe(digest);
    expect(
      declarationDigest({ ...intent, projects: { add: ["libs/gamma"], remove: [] } }),
    ).not.toBe(digest);
    expect(
      declarationDigest({
        ...intent,
        edges: { add: [{ from: "libs/beta", to: "libs/gamma" }], remove: [] },
      }),
    ).not.toBe(digest);
    expect(declarationDigest({ ...intent, constraints: {} })).not.toBe(digest);
  });
});

describe("classifyEvolution — CHANGE", () => {
  it("classifies a non-empty structural diff as CHANGE", () => {
    const result = classifyEvolution({
      observed: {
        projects: { added: ["libs/beta"], removed: [], changed: [] },
        edges: { added: [{ source: "libs/beta", target: "libs/alpha", type: "dep" }], removed: [] },
      },
    });
    expect(result.classifications).toEqual(["CHANGE"]);
    expect(result.disposition).toBe("accepted");
    expect(result.affected.projects).toEqual(["libs/beta"]);
    expect(result.affected.boundaries).toEqual(["libs/beta>libs/alpha:dep"]);
  });
});

describe("classifyEvolution — the edge identity spelling", () => {
  it("maps triples through the one canonical spelling, always carrying the type", () => {
    const result = classifyEvolution({
      observed: {
        projects: { added: [], removed: [], changed: [] },
        edges: {
          added: [{ source: "libs/beta", target: "libs/alpha", type: "static" }],
          removed: [{ source: "libs/gamma", target: "libs/alpha", type: "" }],
        },
      },
    });
    expect(result.affected.boundaries).toEqual([
      "libs/beta>libs/alpha:static",
      "libs/gamma>libs/alpha:",
    ]);
  });

  // The deliberate wrong-shape inputs below are cast, never typed: the
  // function's contract refuses them at runtime, so the type checker must not
  // be asked to admit them.
  /** @param {*} input */
  const attempt = (input) => classifyEvolution(input);

  it("refuses a ready-made identity string — the spelling is output, never input", () => {
    // The silent direction: a caller that pre-mapped its edges under its own
    // spelling (diff's NUL key, say) would otherwise surface that private
    // spelling in `affected.boundaries` — byte-for-byte plausible-looking
    // data no reader can decode. Loud refusal instead.
    expect(() =>
      attempt({
        observed: {
          projects: { added: [], removed: [], changed: [] },
          edges: { added: ["libs/beta>libs/alpha:dep"], removed: [] },
        },
      }),
    ).toThrow(TypeError);
    // The diff-internal NUL spelling is equally refused — never silently
    // echoed into the event's affected identities.
    expect(() =>
      attempt({
        observed: {
          projects: { added: [], removed: [], changed: [] },
          edges: { added: ["libs/beta\0libs/alpha\0dep"], removed: [] },
        },
      }),
    ).toThrow(/identity string is classifyEvolution's own output spelling/);
  });

  it("refuses a triple whose source or target is not a non-empty string", () => {
    for (const edge of [
      { source: "", target: "libs/alpha", type: "dep" },
      { source: "libs/beta", target: "", type: "dep" },
      { source: "libs/beta", target: "libs/alpha" },
      "libs/beta>libs/alpha:dep",
    ]) {
      expect(() =>
        attempt({
          observed: {
            projects: { added: [], removed: [], changed: [] },
            edges: { added: [edge], removed: [] },
          },
        }),
      ).toThrow(TypeError);
    }
  });
});

describe("classifyEvolution — the empty result is a claim", () => {
  it("returns [] for a fully comparable, unchanged pair, with a note saying so", () => {
    const result = classifyEvolution({});
    expect(result.classifications).toEqual([]);
    expect(result.disposition).toBe("accepted");
    expect(result.notes).toEqual([
      "a fully comparable, unchanged pair — no classification applies",
    ]);
    expect(result.affected).toEqual({
      projects: [],
      boundaries: [],
      constraints: [],
      decisions: [],
    });
  });

  it("never reads a policy-only transition as DRIFT, and says the policy changed", () => {
    // The silent direction: a policy change with no other signal must not be
    // classified DRIFT (the predicate's "not merely a policy-only transition"
    // guard), and must not read as a clean unchanged pair.
    const result = classifyEvolution({ observed: { policyChanged: true } });
    expect(result.classifications).toEqual([]);
    expect(result.notes.some((note) => note.includes("policy"))).toBe(true);
  });

  it("discloses an all-waived introduction instead of classifying VIOLATION", () => {
    // The silent direction: a waiver state that were ignored would fabricate
    // a VIOLATION for entries the workspace explicitly accepted.
    const result = classifyEvolution({
      violations: { introduced: [{ id: "v1", waived: true }], resolved: [], unknown: [] },
    });
    expect(result.classifications).toEqual([]);
    expect(result.disposition).toBe("accepted");
    expect(result.notes.some((note) => note.includes("all waived"))).toBe(true);
  });
});

describe("classifyEvolution — VIOLATION", () => {
  it("classifies introduced non-waived violations as VIOLATION, rejected", () => {
    const result = classifyEvolution({
      violations: {
        introduced: [
          { id: "v1", waived: false },
          { id: "v2", waived: false },
        ],
        resolved: [],
        unknown: [],
      },
    });
    expect(result.classifications).toEqual(["VIOLATION"]);
    expect(result.disposition).toBe("rejected");
  });

  it("classifies a declared constraint fail as VIOLATION, rejected", () => {
    const result = classifyEvolution({
      declaredConstraints: [{ id: "noNewViolations", verdict: "fail" }],
    });
    expect(result.classifications).toEqual(["VIOLATION"]);
    expect(result.disposition).toBe("rejected");
    expect(result.affected.constraints).toEqual(["noNewViolations"]);
  });

  it("treats an undeterminable declared constraint as a note + no-verdict, never VIOLATION", () => {
    const result = classifyEvolution({
      declaredConstraints: [{ id: "noNewCycles", verdict: "unknown" }],
    });
    expect(result.classifications).toEqual([]);
    expect(result.disposition).toBe("no-verdict");
    expect(result.notes.some((note) => note.includes("could not be determined"))).toBe(true);
    expect(result.affected.constraints).toEqual(["noNewCycles"]);
  });
});

describe("classifyEvolution — REPAIR", () => {
  it("classifies resolved violations, resolved drift findings, and closed debt as REPAIR", () => {
    expect(
      classifyEvolution({ violations: { introduced: [], resolved: ["v1"], unknown: [] } })
        .classifications,
    ).toEqual(["REPAIR"]);
    expect(classifyEvolution({ driftFindingsResolved: ["drift-1"] }).classifications).toEqual([
      "REPAIR",
    ]);
    expect(classifyEvolution({ debtResolved: ["debt-1"] }).classifications).toEqual(["REPAIR"]);
  });
});

describe("classifyEvolution — DRIFT", () => {
  it("classifies a code-drift signal as DRIFT when the policy was comparable and unchanged", () => {
    const result = classifyEvolution({ codeDrift: true, observed: { policyChanged: false } });
    expect(result.classifications).toEqual(["DRIFT"]);
    expect(result.disposition).toBe("accepted");
  });

  it("classifies undeclared and unfulfilled declared-intent rows as DRIFT, rejected", () => {
    const undeclared = classifyEvolution({
      declaredIntentRows: [{ id: "row-1", verdict: "undeclared" }],
    });
    expect(undeclared.classifications).toEqual(["DRIFT"]);
    expect(undeclared.disposition).toBe("rejected");
    expect(undeclared.affected.constraints).toEqual(["row-1"]);

    const unfulfilled = classifyEvolution({
      declaredIntentRows: [{ id: "row-2", verdict: "unfulfilled" }],
    });
    expect(unfulfilled.classifications).toEqual(["DRIFT"]);
    expect(unfulfilled.disposition).toBe("rejected");
  });

  it("refuses to assert DRIFT from code drift when the policy comparison is one-sided", () => {
    // The silent direction: policyChanged null is "could not be compared",
    // never "the same" — asserting code drift on an unverifiable policy would
    // report a fact the input does not establish.
    const result = classifyEvolution({
      codeDrift: true,
      observed: { policyChanged: null, policyOneSided: true },
    });
    expect(result.classifications).toEqual([]);
    expect(result.notes.some((note) => note.includes("policy"))).toBe(true);
    expect(result.notes.some((note) => note.includes("code drift cannot be asserted"))).toBe(true);
  });

  it("discloses a provenance-advancing pair with no policy on either side, never reading it unchanged", () => {
    // F-HIST-1: both-absent is comparable only while provenance never moved
    // (see `commands/trajectory.mjs`). Advancing commits with no boundary law
    // on either side is real code motion the tool cannot classify — the
    // event must say so, and must NOT claim one-sidedness, which would be a
    // false fact about the pair.
    const result = classifyEvolution({
      observed: { policyChanged: null, provenanceChanged: true },
    });
    expect(result.classifications).toEqual([]);
    expect(
      result.notes.some((note) =>
        note.includes("records the boundary law while the provenance advanced"),
      ),
    ).toBe(true);
    expect(result.notes.some((note) => note.includes("fully comparable"))).toBe(false);
    expect(result.notes.some((note) => note.includes("one side of"))).toBe(false);
  });
});

describe("classifyEvolution — DECISION_CHANGE", () => {
  const registry = (records) => ({ records });

  it("classifies a status change on a shared ADR id, naming the decision", () => {
    const result = classifyEvolution({
      adrBase: registry([{ id: "0001-boundary", status: "active", supersedes: [] }]),
      adrHead: registry([{ id: "0001-boundary", status: "superseded", supersedes: [] }]),
    });
    expect(result.classifications).toEqual(["DECISION_CHANGE"]);
    expect(result.affected.decisions).toEqual(["0001-boundary"]);
  });

  it("classifies a new supersedes relation, naming both sides of the lineage move", () => {
    const result = classifyEvolution({
      adrBase: registry([{ id: "0001-boundary", status: "active", supersedes: [] }]),
      adrHead: registry([
        { id: "0001-boundary", status: "active", supersedes: [] },
        { id: "0002-revised", status: "active", supersedes: ["0001-boundary"] },
      ]),
    });
    expect(result.classifications).toEqual(["DECISION_CHANGE"]);
    expect(result.affected.decisions).toEqual(["0001-boundary", "0002-revised"]);
  });

  it("NOT asserted on a one-sided pair — the silent direction", () => {
    // The one-sided rule, mirror of policyOneSided: either side absent means
    // "could not be compared", never "no decision changed". Fabricating
    // DECISION_CHANGE (or its absence) from one registry would invent lineage.
    const result = classifyEvolution({
      adrBase: null,
      adrHead: registry([{ id: "0001-boundary", status: "active", supersedes: [] }]),
    });
    expect(result.classifications).toEqual([]);
    expect(result.notes.some((note) => note.includes("decision registry"))).toBe(true);
  });

  it("is never DRIFT — a supersession plus code drift classifies DECISION_CHANGE only", () => {
    const result = classifyEvolution({
      codeDrift: true,
      observed: { policyChanged: false },
      adrBase: registry([{ id: "0001-boundary", status: "active", supersedes: [] }]),
      adrHead: registry([{ id: "0001-boundary", status: "superseded", supersedes: [] }]),
    });
    expect(result.classifications).toEqual(["DECISION_CHANGE"]);
    expect(result.classifications).not.toContain("DRIFT");
  });

  it("leaves DRIFT available when the lineage could NOT be asserted (one-sided)", () => {
    const result = classifyEvolution({
      codeDrift: true,
      observed: { policyChanged: false },
      adrBase: null,
      adrHead: registry([{ id: "0001-boundary", status: "active", supersedes: [] }]),
    });
    expect(result.classifications).toEqual(["DRIFT"]);
    expect(result.classifications).not.toContain("DECISION_CHANGE");
  });
});

describe("classifyEvolution — verdict-relevant unknowns", () => {
  it("turns an unknown delta entry into a note + no-verdict, never a clean []", () => {
    // The silent direction this refutes: a delta entry that could not be
    // classified folded into "nothing happened" would read as a clean pair.
    const result = classifyEvolution({
      violations: {
        introduced: [],
        resolved: [],
        unknown: [{ id: "v-?maybe", reason: "identity not in either side's graph" }],
      },
    });
    expect(result.disposition).toBe("no-verdict");
    expect(result.notes.some((note) => note.includes("could not be classified"))).toBe(true);
    expect(result.notes.some((note) => note.includes("v-?maybe"))).toBe(true);
  });

  it("keeps other classifications alongside an unknown — the pair is not clean", () => {
    const result = classifyEvolution({
      observed: { projects: { added: ["libs/beta"], removed: [], changed: [] } },
      violations: {
        introduced: [],
        resolved: [],
        unknown: [{ id: "v-?", reason: "waived at base" }],
      },
    });
    expect(result.classifications).toEqual(["CHANGE"]);
    expect(result.disposition).toBe("no-verdict");
  });

  it("turns an unproven declared-intent row into a note + no-verdict", () => {
    const result = classifyEvolution({
      declaredIntentRows: [{ id: "row-1", verdict: "unproven" }],
    });
    expect(result.disposition).toBe("no-verdict");
    expect(result.notes.some((note) => note.includes("unproven"))).toBe(true);
    expect(result.affected.constraints).toEqual(["row-1"]);
  });
});

describe("classifyEvolution — output shape", () => {
  it("sorts classifications lexicographically when several facts hold", () => {
    const result = classifyEvolution({
      observed: {
        projects: { added: ["libs/beta"], removed: [], changed: [] },
        edges: { added: [], removed: [] },
      },
      violations: {
        introduced: [{ id: "v1", waived: false }],
        resolved: ["v0"],
        unknown: [],
      },
    });
    expect(result.classifications).toEqual(["CHANGE", "REPAIR", "VIOLATION"]);
    expect(result.disposition).toBe("rejected");
  });

  it("deduplicates and sorts affected identities", () => {
    const result = classifyEvolution({
      observed: {
        projects: { added: ["z-lib", "a-lib", "z-lib"], removed: [], changed: [] },
        edges: {
          added: [
            { source: "z-edge", target: "libs/beta", type: "dep" },
            { source: "a-edge", target: "libs/beta", type: "dep" },
            { source: "z-edge", target: "libs/beta", type: "dep" },
          ],
          removed: [],
        },
      },
      declaredConstraints: [
        { id: "c1", verdict: "fail" },
        { id: "c1", verdict: "fail" },
      ],
      declaredIntentRows: [{ id: "i1", verdict: "unfulfilled" }],
    });
    expect(result.affected.projects).toEqual(["a-lib", "z-lib"]);
    expect(result.affected.boundaries).toEqual(["a-edge>libs/beta:dep", "z-edge>libs/beta:dep"]);
    expect(result.affected.constraints).toEqual(["c1", "i1"]);
  });

  it("is deterministic — identical inputs produce identical output", () => {
    /** @type {import("./evolution-event.mjs").EvolutionEvidence} */
    const input = {
      observed: {
        projects: { added: ["libs/beta"], removed: [], changed: [] },
        edges: { added: [], removed: [] },
        policyChanged: false,
      },
      codeDrift: false,
      violations: {
        introduced: [{ id: "v1", waived: false }],
        resolved: ["v0"],
        unknown: [{ id: "v-?", reason: "unclassifiable" }],
      },
      declaredConstraints: [{ id: "c1", verdict: "fail" }],
      declaredIntentRows: [{ id: "i1", verdict: "undeclared" }],
      adrBase: null,
      adrHead: { records: [{ id: "0001-x", status: "active", supersedes: [] }] },
    };
    const first = classifyEvolution(input);
    const second = classifyEvolution(input);
    expect(second).toEqual(first);
  });
});

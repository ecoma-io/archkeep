// The (wave 3, W4) delta evolution surface: the §1 mapping
// (`./delta-classify.mjs`'s `classifyDeltaEvolution`), the disposition
// mapping (`./delta.mjs`'s `deltaDisposition`), and the event `deltaCommand`
// writes when given `--event-out`.
//
// The silent-direction discipline this file holds is the wave's own: an
// `unknown` delta entry is NEVER folded into a clean class — it raises a
// notes disclosure and forces disposition `no-verdict` — and an introduced
// entry whose every site is waived is NOT classified VIOLATION. A test that
// would pass if either fact were dropped must go red here.
//
// Integration cases drive the real `deltaCommand` (re-judging both sides
// through the real engine) against a tmpdir, the way `./delta.test.mjs`
// does, and read the written event back through the real store
// (`../governance/evolution-store.mjs`'s `readEvents`).
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalizeJson } from "../canonical.mjs";
import { readEvents } from "../governance/evolution-store.mjs";
import {
  classifyDeltaEvolution,
  deltaFindings,
  deltaVerdictDeltas,
  edgeEvolutionIdentity,
} from "./delta-classify.mjs";
import { captureDelta, deltaCommand, deltaDisposition } from "./delta.mjs";
import { parseEvidenceSnapshot } from "./delta-snapshot.mjs";
// ---------------------------------------------------------------------------
// Pure fixtures — invented names throughout.
// ---------------------------------------------------------------------------

const NOW = "2026-01-01T00:00:00.000Z";

const OPTIONS = {
  allow: [],
  buildTargets: [],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

/** The current law: alpha may only reach its own scope. */
function config(overrides = {}) {
  return {
    depConstraints: [{ sourceTag: "scope-invented", onlyDependOnLibsWithTags: ["scope-invented"] }],
    options: OPTIONS,
    suppressions: [],
    ...overrides,
  };
}

/** An engine-shape graph: two projects, one edge alpha → beta. */
function engineGraph() {
  return {
    nodes: {
      "acme-alpha": {
        name: "acme-alpha",
        type: "lib",
        data: { root: "libs/alpha", tags: ["scope-invented"] },
      },
      "acme-beta": {
        name: "acme-beta",
        type: "lib",
        data: { root: "libs/beta", tags: ["scope-shared"] },
      },
    },
    dependencies: {
      "acme-alpha": [{ source: "acme-alpha", target: "acme-beta", type: "static" }],
      "acme-beta": [],
    },
  };
}

/** A crossing import record — violates the law above when re-judged. */
function crossingRecord(overrides = {}) {
  return {
    sourceFile: "libs/alpha/src/service.go",
    line: 5,
    column: 2,
    specifier: "example.invalid/acme/beta",
    kind: "static",
    spelling: { path: false, relative: false, namesOnly: false },
    resolved: {
      target: "acme-beta",
      file: "libs/beta/src/beta.go",
      external: false,
      packageName: null,
    },
    ...overrides,
  };
}

/** One classified delta-violation entry, in the shape `classifyViolations` emits. */
function entry(overrides = {}) {
  return {
    messageId: "onlyTagsConstraintViolation",
    sourceProject: "acme-alpha",
    target: "acme-beta",
    targetIsSpecifier: false,
    constraint: { sourceTag: "scope-invented", onlyDependOnLibsWithTags: ["scope-invented"] },
    baseCount: 0,
    headCount: 1,
    baseSites: [],
    headSites: [],
    waived: false,
    ...overrides,
  };
}

/** The canonical identity string of the fixture constraint row. */
const CONSTRAINT_ID = canonicalizeJson({
  sourceTag: "scope-invented",
  onlyDependOnLibsWithTags: ["scope-invented"],
});

/**
 * A minimal delta result payload in the shape `deltaCommand`'s envelope
 * result has — `violations`/`unresolvable`/`policyChanged` and (only when the
 * run declared custom rules) `customRules`.
 */
function deltaOf({
  introduced = [],
  resolved = [],
  unchanged = [],
  unknown = [],
  unresolvableUnknown = [],
  customRules = false,
  customUnknown = [],
  policyChanged = false,
} = {}) {
  return {
    policyChanged,
    violations: { introduced, resolved, unchanged, unknown },
    unresolvable: {
      introduced: [],
      resolved: [],
      unchanged: [],
      unknown: unresolvableUnknown,
    },
    ...(customRules
      ? {
          customRules: {
            findings: { introduced: [], resolved: [], unchanged: [], unknown: customUnknown },
          },
        }
      : {}),
  };
}

/** An unknown violation entry — the reason is the load-bearing half. */
function unknownEntry(reason = "violation carries no usable messageId") {
  return { classification: "unknown", reason, violation: { sourceFile: "libs/alpha/src/a.go" } };
}

// ---------------------------------------------------------------------------
// classifyDeltaEvolution — the §1 mapping.
// ---------------------------------------------------------------------------

describe("classifyDeltaEvolution", () => {
  it("classifies a non-waived introduction as VIOLATION, rejected", () => {
    const result = classifyDeltaEvolution(deltaOf({ introduced: [entry()] }));
    expect(result.classifications).toEqual(["VIOLATION"]);
    expect(result.disposition).toBe("rejected");
  });

  it("classifies resolved violations as REPAIR", () => {
    const result = classifyDeltaEvolution(deltaOf({ resolved: ["r1"] }));
    expect(result.classifications).toEqual(["REPAIR"]);
  });

  it("classifies a mixed introduced + resolved delta as both classes, sorted", () => {
    const result = classifyDeltaEvolution(deltaOf({ resolved: ["r1"], introduced: [entry()] }));
    expect(result.classifications).toEqual(["REPAIR", "VIOLATION"]);
  });

  it("returns [] for a fully comparable, clean delta WITH the disclosure note", () => {
    const result = classifyDeltaEvolution(deltaOf());
    expect(result.classifications).toEqual([]);
    expect(result.notes).toContain(
      "a fully comparable, unchanged pair — no classification applies",
    );
  });

  it("is not classified DRIFT by a policy change alone — the policy note carries the disclosure", () => {
    const result = classifyDeltaEvolution(deltaOf({ policyChanged: true }));
    expect(result.classifications).toEqual([]);
    expect(result.notes.some((note) => note.includes("policy"))).toBe(true);
  });

  it("classifies structural change as CHANGE and names the affected projects", () => {
    const result = classifyDeltaEvolution(deltaOf(), {
      projects: { added: ["libs/beta"], removed: [], changed: [] },
      edges: { added: ["libs/beta>libs/alpha:static"], removed: [] },
    });
    expect(result.classifications).toEqual(["CHANGE"]);
    expect(result.affected.projects).toEqual(["libs/beta"]);
    expect(result.affected.boundaries).toEqual(["libs/beta>libs/alpha:static"]);
  });

  it("classifies a code-drift signal as DRIFT when the policy was comparable and unchanged", () => {
    const result = classifyDeltaEvolution(deltaOf(), { codeDrift: true });
    expect(result.classifications).toEqual(["DRIFT"]);
    expect(result.disposition).toBe("accepted");
  });

  // ---- The silent direction: unknowns are never folded into a clean class.

  it("turns an unknown violation entry into a note + no-verdict — never a clean []", () => {
    // The test that must go red if the unknown were dropped: a dropped unknown
    // leaves [] with the "fully comparable" note and an accepted disposition.
    const result = classifyDeltaEvolution(deltaOf({ unknown: [unknownEntry("no identity")] }));
    expect(result.disposition).toBe("no-verdict");
    expect(result.classifications).toEqual([]);
    expect(result.notes.some((note) => note.includes("could not be classified"))).toBe(true);
    expect(result.notes.some((note) => note.includes("a fully comparable, unchanged pair"))).toBe(
      false,
    );
  });

  it("turns an unresolvable-record unknown into a note + no-verdict", () => {
    const result = classifyDeltaEvolution(
      deltaOf({
        unresolvableUnknown: [{ classification: "unknown", reason: "no specifier", record: {} }],
      }),
    );
    expect(result.disposition).toBe("no-verdict");
    expect(result.notes.some((note) => note.includes("could not be classified"))).toBe(true);
  });

  it("turns a custom-rule unknown into a note + no-verdict", () => {
    const result = classifyDeltaEvolution(
      deltaOf({
        customRules: true,
        customUnknown: [
          { classification: "unknown", rule: "builtin:noBannedTag", reason: "wasm load failed" },
        ],
      }),
    );
    expect(result.disposition).toBe("no-verdict");
    expect(result.notes.some((note) => note.includes("could not be classified"))).toBe(true);
  });

  it("keeps an introduced VIOLATION alongside an unknown — the pair is not clean either", () => {
    const result = classifyDeltaEvolution(
      deltaOf({ introduced: [entry()], unknown: [unknownEntry("no identity")] }),
    );
    expect(result.classifications).toEqual(["VIOLATION"]);
    expect(result.disposition).toBe("no-verdict");
    expect(result.notes.some((note) => note.includes("could not be classified"))).toBe(true);
  });

  // ---- The waiver lane is respected.

  it("does NOT classify an all-waived introduction as VIOLATION, and says so", () => {
    // The test that must go red if waivers were ignored: the workspace
    // explicitly accepted these entries, and fabricating VIOLATION would
    // condemn a tracked acceptance.
    const result = classifyDeltaEvolution(deltaOf({ introduced: [entry({ waived: true })] }));
    expect(result.classifications).toEqual([]);
    expect(result.disposition).toBe("accepted");
    expect(result.notes).toContain(
      "introduced violations are all waived — not classified as VIOLATION",
    );
  });

  it("classifies VIOLATION when any introduced entry is not waived", () => {
    const result = classifyDeltaEvolution(
      deltaOf({ introduced: [entry({ waived: true }), entry({ waived: false })] }),
    );
    expect(result.classifications).toEqual(["VIOLATION"]);
    expect(result.disposition).toBe("rejected");
  });

  it("names the affected constraints from the introduced/resolved entries' rows", () => {
    const result = classifyDeltaEvolution(deltaOf({ introduced: [entry()], resolved: ["r1"] }));
    expect(result.affected.constraints).toEqual([CONSTRAINT_ID]);
  });
});

// ---------------------------------------------------------------------------
// deltaDisposition — the delta verb contract mapped to the event vocabulary.
// ---------------------------------------------------------------------------

describe("deltaDisposition", () => {
  it("accepts a clean comparable capture with no classifications", () => {
    expect(deltaDisposition({ status: "ok", classifications: [] })).toBe("accepted");
  });

  it("accepts an ok capture that carries a fact class (REPAIR, CHANGE, DRIFT)", () => {
    expect(deltaDisposition({ status: "ok", classifications: ["REPAIR"] })).toBe("accepted");
    expect(deltaDisposition({ status: "ok", classifications: ["CHANGE"] })).toBe("accepted");
  });

  it("rejects a findings capture — the VIOLATION the delta verb already folded", () => {
    expect(deltaDisposition({ status: "findings", classifications: ["VIOLATION"] })).toBe(
      "rejected",
    );
  });

  it("is no-verdict on any unknown — the delta verb wins over every class", () => {
    expect(deltaDisposition({ status: "no-verdict", classifications: [] })).toBe("no-verdict");
    expect(deltaDisposition({ status: "no-verdict", classifications: ["REPAIR"] })).toBe(
      "no-verdict",
    );
  });
});

// ---------------------------------------------------------------------------
// deltaFindings / deltaVerdictDeltas / edgeEvolutionIdentity.
// ---------------------------------------------------------------------------

describe("deltaFindings", () => {
  it("maps introduced/resolved entries to identity strings", () => {
    const findings = deltaFindings(
      deltaOf({
        introduced: [entry()],
        resolved: [entry({ target: "acme-gamma", constraint: null })],
      }),
    );
    expect(findings.introduced).toHaveLength(1);
    expect(findings.introduced[0]).toContain("onlyTagsConstraintViolation");
    expect(findings.resolved).toHaveLength(1);
    expect(findings.resolved[0]).toContain("acme-gamma");
  });

  it("carries every unknown family with its reason — violation, unresolvable, custom", () => {
    const findings = deltaFindings(
      deltaOf({
        unknown: [unknownEntry("no usable messageId")],
        unresolvableUnknown: [
          {
            classification: "unknown",
            reason: "no specifier",
            record: { specifier: "x.invalid/y" },
          },
        ],
        customRules: true,
        customUnknown: [{ classification: "unknown", rule: "r", reason: "load failed" }],
      }),
    );
    expect(findings.unknown.map((item) => item.id)).toEqual([
      "unidentifiable violation",
      "unresolvable import 'x.invalid/y'",
      "custom rule 'r'",
    ]);
    expect(findings.unknown.every((item) => typeof item.reason === "string")).toBe(true);
  });
});
describe("deltaVerdictDeltas", () => {
  it("reports a pass→fail move for an introduction", () => {
    expect(deltaVerdictDeltas(deltaOf({ introduced: [entry()] }))).toEqual([
      { constraint: CONSTRAINT_ID, base: "pass", head: "fail" },
    ]);
  });

  it("reports a fail→pass move for a resolution", () => {
    expect(
      deltaVerdictDeltas(deltaOf({ resolved: [entry({ baseCount: 1, headCount: 0 })] })),
    ).toEqual([{ constraint: CONSTRAINT_ID, base: "fail", head: "pass" }]);
  });

  it("is empty for a persistent violation — fail/fail moved nothing", () => {
    expect(
      deltaVerdictDeltas(deltaOf({ unchanged: [entry({ baseCount: 1, headCount: 1 })] })),
    ).toEqual([]);
  });

  it("is empty for occurrence growth — the verdict never flipped, the finding did", () => {
    expect(
      deltaVerdictDeltas(deltaOf({ introduced: [entry({ baseCount: 1, headCount: 2 })] })),
    ).toEqual([]);
  });
});

describe("edgeEvolutionIdentity", () => {
  it("spells the (source, target, type) identity the design's example shows", () => {
    expect(
      edgeEvolutionIdentity({ source: "libs/beta", target: "libs/alpha", type: "static" }),
    ).toBe("libs/beta>libs/alpha:static");
  });
});

// ---------------------------------------------------------------------------
// deltaCommand + --event-out: the record written, idempotently.
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "archkeep-delta-events-"));
const eventsDir = join(root, "events");
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * A resolved CommandContext with everything `delta` reads.
 */
function contextOf({ graph = engineGraph(), records = [], failures = [], owned = [] } = {}) {
  return {
    root,
    provider: "nx",
    marker: "nx.json",
    graph,
    analysis: {
      imports: records,
      failures,
      analyzed: 2,
      analyzedFiles: [],
      exemptedFiles: [],
    },
    owned,
    pluginGap: { registered: true, manifests: [] },
  };
}

/**
 * Captures a baseline over `records`, round-tripping through the real
 * serializer AND parser so the compare side consumes exactly what a file on
 * disk would have held.
 */
function baselineOf({ records = [], graph = engineGraph(), law = config() } = {}) {
  const { snapshot, text } = captureDelta(contextOf({ graph, records }), { config: law });
  return { snapshot, readBaseline: (path) => parseEvidenceSnapshot(text, path) };
}

describe("deltaCommand event output", () => {
  it("gains the additive classifications/affected fields on every run", async () => {
    const result = await deltaCommand(
      "/invented/base.json",
      contextOf({ records: [crossingRecord()] }),
      {
        config: config(),
        readBaseline: () => baselineOf().snapshot,
      },
    );
    expect(Array.isArray(result.delta.classifications)).toBe(true);
    expect(result.delta.classifications).toEqual(["VIOLATION"]);
    expect(result.delta.affected).toEqual({
      projects: [],
      boundaries: [],
      constraints: [CONSTRAINT_ID],
      decisions: [],
    });
  });

  it("writes a transition-kind delta event with the correct source and disposition", async () => {
    const law = config();
    const baseline = baselineOf({ law });
    const dir = join(eventsDir, "one");
    const result = await deltaCommand(
      "/invented/base.json",
      contextOf({ records: [crossingRecord()] }),
      {
        config: law,
        readBaseline: baseline.readBaseline,
        now: NOW,
        eventOut: dir,
      },
    );

    expect(result.eventWrite).toEqual({ id: expect.any(String), duplicate: false });
    const names = readdirSync(dir).filter((name) => name.endsWith(".json"));
    expect(names).toHaveLength(1);

    const [event] = readEvents(dir);
    expect(event.schemaVersion).toBe(1);
    expect(event.kind).toBe("transition");
    expect(event.source).toBe("delta");
    expect(event.classifications).toEqual(["VIOLATION"]);
    expect(event.disposition).toBe("rejected");
    expect(event.observed.policyChanged).toBe(false);
    expect(event.observed.providerChanged).toBe(false);
    expect(event.observed.architectureChanged).toBe(false);
    expect(event.observed.projects).toEqual({ added: [], removed: [], changed: [] });
    expect(event.findings.introduced).toHaveLength(1);
    expect(event.findings.unknown).toEqual([]);
    expect(event.affected.constraints).toEqual([CONSTRAINT_ID]);
    expect(event.fitness.verdictDeltas).toEqual([
      { constraint: CONSTRAINT_ID, base: "pass", head: "fail" },
    ]);
    expect(event.debt).toEqual({ introduced: [], resolved: [] });
    expect(event.base.evidence).toBe("/invented/base.json");
  });

  it("is idempotent — a rerun over the same transition writes nothing new", async () => {
    const law = config();
    const baseline = baselineOf({ law });
    const dir = join(eventsDir, "two");
    const run = () =>
      deltaCommand("/invented/base.json", contextOf({ records: [crossingRecord()] }), {
        config: law,
        readBaseline: baseline.readBaseline,
        now: NOW,
        eventOut: dir,
      });

    await run();
    const second = await run();
    expect(second.eventWrite.duplicate).toBe(true);
    expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  it("writes no file and keeps every existing report line when --event-out is absent", async () => {
    const law = config();
    const baseline = baselineOf({ law });
    const absentDir = join(eventsDir, "absent");
    const result = await deltaCommand(
      "/invented/base.json",
      contextOf({ records: [crossingRecord()] }),
      {
        config: law,
        readBaseline: baseline.readBaseline,
        now: NOW,
      },
    );
    expect(result.eventWrite).toBeNull();
    expect(existsSync(absentDir)).toBe(false);
    // The text report appends the additive block after the existing lines.
    expect(result.report.text).toContain(
      "baseline  /invented/base.json — unverified origin, 0 records, 2 projects",
    );
    expect(result.report.text).toContain("classifications  VIOLATION");
  });

  it("classifies a clean comparable delta with no event classes — the report says none", async () => {
    const law = config();
    const baseline = baselineOf({ law });
    const result = await deltaCommand("/invented/base.json", contextOf(), {
      config: law,
      readBaseline: baseline.readBaseline,
      now: NOW,
    });
    expect(result.status).toBe("ok");
    expect(result.delta.classifications).toEqual([]);
    expect(result.report.text).toContain("classifications  none");
  });
});

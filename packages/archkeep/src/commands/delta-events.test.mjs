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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../../spawn-budget.mjs";

import { canonicalizeJson } from "../canonical.mjs";
import { readEvents } from "../governance/evolution-store.mjs";
import { debtFactId } from "../governance/debt-ledger.mjs";
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
      edges: {
        added: [{ source: "libs/beta", target: "libs/alpha", type: "static" }],
        removed: [],
      },
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
    expect(deltaDisposition({ status: "ok" })).toBe("accepted");
  });

  it("accepts an ok capture that carries a fact class (REPAIR, CHANGE, DRIFT)", () => {
    // The status is the verb's own fold — the class riding along is not
    // consulted; `ok` means nothing gated, so the event is accepted.
    expect(deltaDisposition({ status: "ok" })).toBe("accepted");
  });

  it("rejects a findings capture — whatever class made the gate fail", () => {
    // `findings` IS the reject verdict: an introduced gating finding survived
    // the waiver table. The class does not matter — a custom-rule-only
    // introduced finding never reaches the VIOLATION predicate, and a
    // classifications scan would read it "accepted" (F-delta-disposition).
    expect(deltaDisposition({ status: "findings" })).toBe("rejected");
  });

  it("accepts an ok capture holding a WAIVED violation — the waiver is the acceptance", () => {
    // A waived introduced violation keeps the gate `ok` (a waiver is a
    // tracked acceptance, not a fix). Status is authoritative, the
    // classifications are not consulted, so the event reads "accepted"
    // exactly like the verb did — where a classifications scan would have
    // read the waiver as a rejection.
    expect(deltaDisposition({ status: "ok" })).toBe("accepted");
  });

  it("is no-verdict on any unknown — the delta verb wins over every class", () => {
    expect(deltaDisposition({ status: "no-verdict" })).toBe("no-verdict");
  });

  // The latch (#739): a stranger status is a bug in the caller, never a
  // disposition — the old fall-through folded any of these to `accepted`.
  it("throws on a stranger status — 'OK ' is not 'ok'", () => {
    expect(() => deltaDisposition({ status: /** @type {any} */ ("OK ") })).toThrow(
      'unknown delta status string ("OK ")',
    );
  });

  it("throws on an absent status", () => {
    expect(() => deltaDisposition(/** @type {any} */ ({}))).toThrow(
      "unknown delta status undefined (undefined)",
    );
  });

  it("throws on a typo'd status", () => {
    expect(() => deltaDisposition({ status: /** @type {any} */ ("ok_") })).toThrow(
      'unknown delta status string ("ok_")',
    );
  });
});

// ---------------------------------------------------------------------------
// The custom-rule half of the F-delta-disposition verification: the Go SDK's
// committed reference artifact, read the same way the cross-SDK conformance
// gate reads it (`../conformance/rule-sdks.mjs`) — a rule whose findings come
// from the evidence, so the two SIDES of a delta can genuinely disagree.
// ---------------------------------------------------------------------------

const REFERENCE_WASM = fileURLToPath(
  new URL("../../../archkeep-rule-sdk-go/examples/forbidden_tag_dependency.wasm", import.meta.url),
);
const referenceBytes = new Uint8Array(readFileSync(REFERENCE_WASM));
const referenceSha256 = readFileSync(`${REFERENCE_WASM}.sha256`, "utf8").trim();
const RULE_ARTIFACT = "tools/rules/forbidden-tag-dependency.wasm";
const readReferenceArtifact = (artifact) => (artifact === RULE_ARTIFACT ? referenceBytes : null);
const CUSTOM_OWNED = [{ file: "libs/alpha/src/service.go", project: "acme-alpha" }];

/** The head-permissive boundary law plus the declared custom rule. */
function customLaw() {
  return config({
    depConstraints: [{ sourceTag: "scope-invented", onlyDependOnLibsWithTags: ["*"] }],
    customRules: [
      {
        name: "forbidden-tag-dependency",
        artifact: RULE_ARTIFACT,
        sha256: referenceSha256,
        reason: "the shared scope stays unreachable",
        params: { exemptTags: [], forbiddenTag: "scope-shared" },
      },
    ],
  });
}

/** An engine graph WITHOUT the alpha → beta edge the reference rule condemns. */
function edgelessGraph() {
  const graph = engineGraph();
  graph.dependencies["acme-alpha"] = [];
  return graph;
}

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
// The event-writing tests stand on a REAL committed root: the F-delta-event-id
// contract refuses to write an evolution event unless the head is a committed,
// clean revision, so a head identity cannot be faked with a bare directory.
// The shared `root` above stays non-git for the runs that never write an event.
const gitRoot = join(root, "git");
const git = (...args) =>
  spawnSync("git", args, {
    cwd: gitRoot,
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
beforeAll(() => {
  mkdirSync(gitRoot, { recursive: true });
  writeFileSync(join(gitRoot, "README.md"), "fixture\n");
  expect(git("init", "-q", "-b", "main")).toBe(0);
  expect(git("add", "-A")).toBe(0);
  expect(git("commit", "-q", "-m", "base")).toBe(0);
}, SPAWN_TEST_BUDGET_MS);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * A resolved CommandContext with everything `delta` reads.
 */
function contextOf({
  graph = engineGraph(),
  records = [],
  failures = [],
  owned = [],
  root: contextRoot = root,
} = {}) {
  return {
    root: contextRoot,
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
function baselineOf({
  records = [],
  graph = engineGraph(),
  law = config(),
  owned = [],
  root: contextRoot = root,
} = {}) {
  const { snapshot, text } = captureDelta(contextOf({ graph, records, owned, root: contextRoot }), {
    config: law,
  });
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
    const baseline = baselineOf({ law, root: gitRoot });
    const dir = join(eventsDir, "one");
    const result = await deltaCommand(
      "/invented/base.json",
      contextOf({ records: [crossingRecord()], root: gitRoot }),
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
    expect(event.debt).toEqual({ introduced: [], resolved: [], note: expect.any(String) });
    // Each side names a STATE — the snapshot identity of the graph that side
    // was judged over — and the baseline's storage path is disclosed one
    // level up, outside the identity.
    expect(event.evidence).toBe("/invented/base.json");
    expect(event.base.snapshot).toMatch(/^[0-9a-f]{64}$/);
    expect(event.head.snapshot).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the event id stable when the baseline is relocated — identity never names a path", async () => {
    // The baseline's path is a storage reference on the machine that ran the
    // command; an event store committed to git is read by machines where that
    // path does not exist. The identity names the STATE the evidence holds,
    // never where the file sat — so the same transition judged over the same
    // evidence at a different path is the SAME event, and the store dedupes
    // it instead of appending a machine-specific twin.
    const law = config();
    const baseline = baselineOf({ law, root: gitRoot });
    /** @type {(baselinePath: string, dir: string) => Promise<object>} */
    const runAt = async (baselinePath, dir) => {
      await deltaCommand(baselinePath, contextOf({ records: [crossingRecord()], root: gitRoot }), {
        config: law,
        readBaseline: baseline.readBaseline,
        now: NOW,
        eventOut: join(eventsDir, dir),
      });
      const [event] = readEvents(join(eventsDir, dir));
      return event;
    };
    const here = await runAt("baseline.json", "relocate-here");
    const elsewhere = await runAt("/var/archkeep/elsewhere/baseline.json", "relocate-elsewhere");
    expect(elsewhere.dedupeKey).toBe(here.dedupeKey);
    expect(elsewhere.id).toBe(here.id);
    // The relocation is still disclosed — outside the identity.
    expect(here.evidence).toBe("baseline.json");
    expect(elsewhere.evidence).toBe("/var/archkeep/elsewhere/baseline.json");
  });

  it("re-judges the intent over base and head and emits the real debt id debt actually introduced", async () => {
    // The lifecycle closure for the delta producer (F-DEB-1 delta): with an
    // intent present, the event's debt ids are the SAME ids the ledger would
    // derive from the judged fact — not a fabricated clean ledger. Base has
    // both boundary sides populated but no forbidden path (clean); head adds
    // the forbidden edge (one drift finding introduced).
    const intentDoc = {
      version: "1",
      boundaries: [
        { name: "packages", match: ["tag:alpha"] },
        { name: "extensions", match: ["tag:beta"] },
      ],
      forbidden: [{ from: "packages", to: "extensions", reason: "engine must not reach out" }],
      allowed: [],
    };
    /** @param {string[]} tags */
    const alpha = (tags) => ({
      name: "acme-alpha",
      type: "lib",
      data: { root: "libs/alpha", tags },
    });
    /** @param {string[]} tags */
    const beta = (tags) => ({
      name: "acme-beta",
      type: "lib",
      data: { root: "libs/beta", tags },
    });
    // Both sides populated, no edge — nothing judged forbidden.
    const baseGraph = {
      nodes: { "acme-alpha": alpha(["alpha"]), "acme-beta": beta(["beta"]) },
      dependencies: { "acme-alpha": [], "acme-beta": [] },
    };
    // Head reaches extensions — the forbidden direct edge appears.
    const headGraph = {
      nodes: { "acme-alpha": alpha(["alpha"]), "acme-beta": beta(["beta"]) },
      dependencies: {
        "acme-alpha": [{ source: "acme-alpha", target: "acme-beta", type: "static" }],
        "acme-beta": [],
      },
    };
    const dir = join(eventsDir, "debt");
    const result = await deltaCommand(
      "/invented/base.json",
      contextOf({ graph: headGraph, root: gitRoot }),
      {
        config: config(),
        readBaseline: () => baselineOf({ graph: baseGraph, law: config(), root: gitRoot }).snapshot,
        now: NOW,
        eventOut: dir,
        loadIntentOverride: async () => intentDoc,
      },
    );
    expect(result.eventWrite).toEqual({ id: expect.any(String), duplicate: false });
    const [event] = readEvents(dir);
    expect(event.debt.introduced).toEqual([
      debtFactId("drift", {
        source: "acme-alpha",
        target: "acme-beta",
        rule: "intentForbiddenEdge",
      }),
    ]);
    expect(event.debt.resolved).toEqual([]);
    expect(event.debt.note).toBeUndefined();
  });

  it("is idempotent — a rerun over the same transition writes nothing new", async () => {
    const law = config();
    const baseline = baselineOf({ law, root: gitRoot });
    const dir = join(eventsDir, "two");
    const run = () =>
      deltaCommand(
        "/invented/base.json",
        contextOf({ records: [crossingRecord()], root: gitRoot }),
        {
          config: law,
          readBaseline: baseline.readBaseline,
          now: NOW,
          eventOut: dir,
        },
      );

    await run();
    const second = await run();
    expect(second.eventWrite.duplicate).toBe(true);
    expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  it("refuses to write an event from a commitless head (F-delta-event-id)", async () => {
    const law = config();
    const baseline = baselineOf({ law });
    // The shared `root` is NOT a git repository — the head carries no commit,
    // so an event written here would claim an identity nothing can reproduce
    // (every distinct head state collapses onto one id). Loud refusal, never
    // a silently aliased event.
    await expect(
      deltaCommand("/invented/base.json", contextOf({ records: [crossingRecord()] }), {
        config: law,
        readBaseline: baseline.readBaseline,
        now: NOW,
        eventOut: join(eventsDir, "commitless"),
      }),
    ).rejects.toThrow(/without a committed head/u);
  });

  it("refuses to write an event from a dirty working tree (F-delta-event-id)", async () => {
    const law = config();
    // Captured clean, before the tree is dirtied.
    const baseline = baselineOf({ law, root: gitRoot });
    // The dirt is a TRACKED-file edit, the state the gate exists for: a dirty
    // head names a commit its evidence does not back — two distinct
    // uncommitted states would collide on one event id. Untracked files are
    // not dirt (#683): the analysis reads `git ls-files`-tracked files only,
    // so a tree whose only change is untracked analyzed the same bytes and its
    // evidence still backs the commit it names.
    const readme = join(gitRoot, "README.md");
    const committed = readFileSync(readme, "utf8");
    writeFileSync(readme, `${committed}uncommitted\n`);
    try {
      await expect(
        deltaCommand(
          "/invented/base.json",
          contextOf({ records: [crossingRecord()], root: gitRoot }),
          {
            config: law,
            readBaseline: baseline.readBaseline,
            now: NOW,
            eventOut: join(eventsDir, "dirty"),
          },
        ),
      ).rejects.toThrow(/dirty working tree/u);
    } finally {
      writeFileSync(readme, committed);
    }
  });

  it("still judges a dirty head without --event-out — weaker evidence, disclosed, never a refusal", async () => {
    // The dirty-capability matrix's WEAKER_EVIDENCE row for the head side:
    // uncommitted state is readable evidence about uncommitted state — the
    // run proceeds and says so; only the event write (the test above) is
    // refused, because that is the write that would pin a commit the
    // evidence does not back.
    const law = config();
    const baseline = baselineOf({ law, root: gitRoot });
    const readme = join(gitRoot, "README.md");
    const committed = readFileSync(readme, "utf8");
    writeFileSync(readme, `${committed}uncommitted\n`);
    try {
      const result = await deltaCommand(
        "/invented/base.json",
        contextOf({ records: [crossingRecord()], root: gitRoot }),
        { config: law, readBaseline: baseline.readBaseline, now: NOW },
      );
      expect(result.coverage.notes.join(" ")).toMatch(/working tree is dirty/u);
    } finally {
      writeFileSync(readme, committed);
    }
  });

  it("writes the event when the only dirt is an untracked file — the gate is tracked-file dirt (#683)", async () => {
    const law = config();
    const baseline = baselineOf({ law, root: gitRoot });
    // The narrowed side of the gate above: an untracked scratch file cannot
    // unback the evidence — the analysis reads `git ls-files`-tracked files
    // only, so the analyzed bytes still are the commit's — and it must not
    // trip the refusal. The positive control goes red if the dirty bit ever
    // re-widens to bare `git status --porcelain`, which would block event
    // writes in any tree carrying editor swaps or scratch files.
    const probe = join(gitRoot, "untracked-probe.md");
    writeFileSync(probe, "scratch\n");
    try {
      const dir = join(eventsDir, "untracked-only");
      const result = await deltaCommand(
        "/invented/base.json",
        contextOf({ records: [crossingRecord()], root: gitRoot }),
        {
          config: law,
          readBaseline: baseline.readBaseline,
          now: NOW,
          eventOut: dir,
        },
      );
      expect(result.eventWrite).toEqual({ id: expect.any(String), duplicate: false });
    } finally {
      rmSync(probe, { force: true });
    }
  });

  it("rejects an event whose only gating finding is an introduced custom rule (F-delta-disposition)", async () => {
    const law = customLaw();
    // Base: no alpha → beta edge, so the reference rule passes. Head: the
    // edge exists, so the rule fails. The introduced custom finding is the
    // delta's ONLY gating finding — it never becomes a VIOLATION
    // classification, and before the fix a classifications scan read the
    // event "accepted" on an exit-1 run.
    const { readBaseline } = baselineOf({
      graph: edgelessGraph(),
      law,
      owned: CUSTOM_OWNED,
      root: gitRoot,
    });
    const dir = join(eventsDir, "custom-only");
    const result = await deltaCommand(
      "/invented/base.json",
      contextOf({ graph: engineGraph(), owned: CUSTOM_OWNED, root: gitRoot }),
      {
        config: law,
        readBaseline,
        now: NOW,
        eventOut: dir,
        readArtifact: readReferenceArtifact,
      },
    );
    expect(result.status).toBe("findings");
    expect(result.delta.classifications).not.toContain("VIOLATION");
    const [event] = readEvents(dir);
    expect(event.disposition).toBe("rejected");
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

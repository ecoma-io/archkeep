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
import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "../../cli.mjs";
import {
  declarationDigest,
  eventDedupeKey,
  eventId,
  EVOLUTION_EVENT_SCHEMA_VERSION,
} from "../governance/evolution-event.mjs";
import { debtFactId } from "../governance/debt-ledger.mjs";
import { parseChangeIntent } from "./change-intent.mjs";
import { changeCommand, reconcileDisposition, reconcileMaterialDelta } from "./change.mjs";
import { parseEvidenceSnapshot, serializeEvidenceSnapshot } from "./delta-snapshot.mjs";
import { captureDelta } from "./delta.mjs";
import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../../spawn-budget.mjs";

/**
 * Wave 3 change hardening (issue #503, design §5): the breadth guard, the
 * additive classification/affected/debt result fields, the reconcile
 * EvolutionEvent behind `--event-out`, and the pinned missing-baseline
 * refusal. The SILENT direction is what every block here refutes: an
 * empty-rows intent silently reconciling to matched, an unproven verdict
 * reading as accepted, and an `--event-out` flag that is accepted but writes
 * nothing.
 */

const FUTURE = "2027-01-01T00:00:00.000Z";

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

/** The current law: acme-api may only reach its own scope. */
function config(overrides = {}) {
  return {
    depConstraints: [{ sourceTag: "scope-invented", onlyDependOnLibsWithTags: ["scope-invented"] }],
    options: OPTIONS,
    suppressions: [],
    ...overrides,
  };
}

/** One project node in the engine shape. */
/**
 * @param {string} name
 * @param {string} root
 * @param {string[]} [tags]
 * @returns {{name: string, type: string, data: {root: string, tags: string[]}}}
 */
function node(name, root, tags = []) {
  return { name, type: "lib", data: { root, tags } };
}

/** The base architecture: two projects, no edges. */
/**
 * @returns {{nodes: Record<string, object>, dependencies: Record<string, object[]>}}
 */
function baseGraph() {
  return {
    nodes: {
      "acme-api": node("acme-api", "libs/api", ["scope-invented"]),
      "acme-db": node("acme-db", "libs/db", ["scope-shared"]),
    },
    dependencies: { "acme-api": [], "acme-db": [] },
  };
}

/** A crossing import record — violates the law above when re-judged. */
function crossingRecord(overrides = {}) {
  return {
    sourceFile: "libs/api/src/service.go",
    line: 5,
    column: 2,
    specifier: "example.invalid/acme/payments",
    kind: "static",
    spelling: { path: false, relative: false, namesOnly: false },
    resolved: {
      target: "acme-payments",
      file: "libs/payments/src/pay.go",
      external: false,
      packageName: null,
    },
    ...overrides,
  };
}

/**
 * The head where the change happened as declared: payments exists and api
 * reaches it.
 *
 * @returns {{nodes: Record<string, object>, dependencies: Record<string, object[]>}}
 */
function declaredHeadGraph() {
  return {
    nodes: {
      ...baseGraph().nodes,
      "acme-payments": node("acme-payments", "libs/payments", ["scope-shared"]),
    },
    dependencies: {
      ...baseGraph().dependencies,
      "acme-api": [{ source: "acme-api", target: "acme-payments", type: "static" }],
    },
  };
}

let root;

// A git command in the fixture, with an identity that does not read the
// machine's — the same arrangement `change.test.mjs` uses. The commit is
// load-bearing: the contract pins it as its base, and the event's refs come
// from the same provenance.
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

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "archkeep-change-harden-"));
  writeFileSync(join(root, "README.md"), "fixture\n");
  expect(git("init", "-q", "-b", "main")).toBe(0);
  expect(git("add", "-A")).toBe(0);
  expect(git("commit", "-q", "-m", "base")).toBe(0);
}, SPAWN_TEST_BUDGET_MS);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** A resolved CommandContext over `graph`/`records`, everything else clean. */
/**
 * @param {{graph?: object, records?: object[]}} [input]
 */
function contextOf({ graph = baseGraph(), records = [] } = {}) {
  return {
    root,
    provider: "nx",
    marker: "nx.json",
    graph,
    analysis: {
      imports: records,
      failures: [],
      analyzed: 2,
      analyzedFiles: [],
      exemptedFiles: [],
    },
    owned: [],
    pluginGap: { registered: true, manifests: [] },
  };
}

/** Captures the base tree, round-tripping through serializer AND parser. */
/**
 * @param {{graph?: object, records?: object[]}} [input]
 */
function baselineOf({ graph = baseGraph(), records = [] } = {}) {
  const { snapshot } = captureDelta(contextOf({ graph, records }), { config: config() });
  return {
    snapshot,
    readBaseline: (path) => parseEvidenceSnapshot(serializeEvidenceSnapshot(snapshot), path),
  };
}

/** A manifest pinning the fixture's actual base commit, by default. */
function manifest(overrides = {}) {
  return {
    version: "1",
    base: { commit: provenanceCommit() },
    projects: { add: ["acme-payments"], remove: [] },
    edges: { add: [{ from: "acme-api", to: "acme-payments" }], remove: [] },
    constraints: {},
    ...overrides,
  };
}

function provenanceCommit() {
  const status = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
  });
  return status.stdout.trim();
}

/** An empty-rows variation of the manifest — nothing declared, prose only. */
function emptyRowsManifest(overrides = {}) {
  return {
    ...manifest(),
    projects: { add: [], remove: [] },
    edges: { add: [], remove: [] },
    constraints: {},
    ...overrides,
  };
}

/**
 * Runs the command over injected readers, returning the full result. `now` is
 * always injected (FUTURE) so the event's `recordedAt` is deterministic.
 *
 * @param {{ctx?: object, baseline: {readBaseline: (path: string) => object},
 *   intent?: object|undefined, config?: object|undefined, eventOut?: string,
 *   writeEvent?: (dir: string, event: object) => {id: string, duplicate: boolean},
 *   loadIntentOverride?: (root: string, opts?: object) => Promise<object|undefined>}} input
 */
async function run({
  ctx,
  baseline,
  intent,
  config: law,
  eventOut,
  writeEvent,
  loadIntentOverride,
}) {
  return changeCommand("baseline.json", "intent.json", ctx ?? contextOf(), {
    config: law ?? config(),
    readBaseline: baseline.readBaseline,
    ...(intent === undefined
      ? {}
      : { readIntent: async () => parseChangeIntent(JSON.stringify(intent), "intent.json") }),
    now: FUTURE,
    ...(eventOut === undefined ? {} : { eventOut }),
    ...(writeEvent === undefined ? {} : { writeEvent }),
    ...(loadIntentOverride === undefined ? {} : { loadIntentOverride }),
  });
}

describe("the breadth guard", () => {
  it("refuses an empty-rows intent whose summary asserts a change — loudly, never a silent match", () => {
    expect(() =>
      parseChangeIntent(
        JSON.stringify(emptyRowsManifest({ summary: "add payments capability" })),
        "i.json",
      ),
    ).toThrow(/summary/);
  });

  it("accepts the same intent without a summary — a no-op declaration is a real one", () => {
    expect(() => parseChangeIntent(JSON.stringify(emptyRowsManifest()), "i.json")).not.toThrow();
  });

  it("accepts empty projects/edges when constraints are declared — a constraint IS a row", () => {
    expect(() =>
      parseChangeIntent(
        JSON.stringify(
          emptyRowsManifest({ summary: "guard the law", constraints: { noNewViolations: true } }),
        ),
        "i.json",
      ),
    ).not.toThrow();
  });

  it("accepts a summary once any project row exists", () => {
    expect(() =>
      parseChangeIntent(
        JSON.stringify(
          emptyRowsManifest({
            summary: "add payments",
            projects: { add: ["acme-payments"], remove: [] },
          }),
        ),
        "i.json",
      ),
    ).not.toThrow();
  });

  it("refuses through the command too — the guard lives in validation, before reconciliation", async () => {
    const baseline = baselineOf();
    await expect(
      run({
        ctx: contextOf({ graph: declaredHeadGraph() }),
        baseline,
        intent: emptyRowsManifest({ summary: "add payments capability" }),
      }),
    ).rejects.toThrow(/summary/);
  });
});

describe("reconcileMaterialDelta — the declared row's identity", () => {
  it("does not call one edge's observation another edge's promise kept", () => {
    // Two distinct (from, to) pairs that a weaker separator — or no separator
    // — would key identically (`("a:b","c")` and `("a","b:c")` both collapse
    // to "a:b:c" under ":"). Declaring one and observing the other must read
    // as unfulfilled AND undeclared, never as matched: this is the red
    // direction of the #613 consolidation, because a spelling that collapses
    // the two rows makes the reconciliation recognize a declaration it was
    // never handed — byte-for-byte indistinguishable from a kept promise.
    const intent = parseChangeIntent(
      JSON.stringify({
        version: "1",
        base: { commit: "c" },
        edges: { add: [{ from: "a:b", to: "c" }], remove: [] },
      }),
      "i.json",
    );
    const reconciliation = reconcileMaterialDelta(intent, {
      addedProjects: [],
      removedProjects: [],
      changedProjects: [],
      addedEdges: [{ source: "a", target: "b:c", type: "static" }],
      removedEdges: [],
    });
    expect(reconciliation.matched).toEqual([]);
    expect(reconciliation.missingExpected).toEqual([{ kind: "edge-added", from: "a:b", to: "c" }]);
    expect(reconciliation.unexpected).toEqual([
      { kind: "edge-added", from: "a", to: "b:c", type: "static" },
    ]);
  });
});

describe("reconcileDisposition", () => {
  it("accepts a matched verdict with every declared constraint passing", () => {
    expect(reconcileDisposition("matched", [{ verdict: "pass" }])).toBe("accepted");
  });

  it("accepts a matched verdict when no constraint was declared or judged", () => {
    expect(reconcileDisposition("matched", [])).toBe("accepted");
  });

  it("rejects undeclared and unfulfilled verdicts", () => {
    expect(reconcileDisposition("undeclared", [])).toBe("rejected");
    expect(reconcileDisposition("unfulfilled", [])).toBe("rejected");
  });

  it("rejects a matched verdict when a declared constraint failed", () => {
    expect(reconcileDisposition("matched", [{ verdict: "fail" }])).toBe("rejected");
  });

  it("answers no-verdict for an unproven verdict — never a fabricated acceptance", () => {
    expect(reconcileDisposition("unproven", [])).toBe("no-verdict");
  });

  it("answers no-verdict while a declared constraint could not be determined", () => {
    expect(reconcileDisposition("matched", [{ verdict: "unknown" }])).toBe("no-verdict");
  });
});

describe("the additive result fields", () => {
  it("classifies a matched change as CHANGE and names what it affected", async () => {
    const baseline = baselineOf();
    const result = await run({
      ctx: contextOf({ graph: declaredHeadGraph() }),
      baseline,
      intent: manifest({ summary: "add payments", constraints: { noNewViolations: true } }),
    });
    expect(result.status).toBe("ok");
    expect(result.changeIntent.reconciliation.verdict).toBe("matched");
    expect(result.changeIntent.classifications).toEqual(["CHANGE"]);
    expect(result.changeIntent.affected).toEqual({
      projects: ["acme-payments"],
      boundaries: ["acme-api>acme-payments:static"],
      constraints: ["no-new-violations"],
      decisions: [],
    });
    // No architecture-intent in the fixture — no debt ids, and the in-band
    // note says the ledger is empty because the intent file is absent.
    expect(result.changeIntent.debt).toEqual({
      introduced: [],
      resolved: [],
      note: expect.stringContaining("'architecture-intent.json' tracked"),
    });
  });

  it("classifies an unfulfilled declaration as DRIFT and names its debt", async () => {
    const baseline = baselineOf();
    const result = await run({
      ctx: contextOf(),
      baseline,
      intent: manifest({ summary: "add payments" }),
    });
    expect(result.changeIntent.reconciliation.verdict).toBe("unfulfilled");
    expect(result.changeIntent.classifications).toEqual(["DRIFT"]);
    expect(result.changeIntent.affected.constraints).toEqual(["intent"]);
    expect(result.changeIntent.debt).toEqual({
      introduced: [],
      resolved: [],
      note: expect.stringContaining("'architecture-intent.json' tracked"),
    });
  });

  it("classifies an undeclared delta as CHANGE+DRIFT with its debt", async () => {
    const baseline = baselineOf();
    const result = await run({
      ctx: contextOf({ graph: declaredHeadGraph() }),
      baseline,
      intent: emptyRowsManifest(),
    });
    expect(result.changeIntent.reconciliation.verdict).toBe("undeclared");
    expect(result.changeIntent.classifications).toEqual(["CHANGE", "DRIFT"]);
    // No intent file → no ledger ids; the note says why the debt is empty.
    expect(result.changeIntent.debt.introduced).toEqual([]);
    expect(result.changeIntent.debt.note).toEqual(
      expect.stringContaining("'architecture-intent.json' tracked"),
    );
  });

  it("still carries the fields on an unproven run — the classification answers no-verdict, never a shrug", async () => {
    const baseline = baselineOf();
    const result = await run({
      ctx: contextOf(),
      baseline,
      intent: manifest({ base: { commit: "0".repeat(40) }, summary: "add payments" }),
    });
    expect(result.status).toBe("no-verdict");
    expect(result.changeIntent.reconciliation.verdict).toBe("unproven");
    expect(result.changeIntent.classifications).toEqual([]);
    expect(result.changeIntent.affected.constraints).toEqual(["intent"]);
    // F-CHG-1: an unproven base never fabricates ledger ids — `debt` is the
    // fail-closed in-band note, not a partial reconstruction.
    expect(result.changeIntent.debt).toEqual({
      introduced: [],
      resolved: [],
      note: expect.stringContaining("base identity unproven"),
    });
  });

  it("judges the intent over base and head and emits the real debt id the change introduced (F-DEB-1 change)", async () => {
    // The lifecycle closure for the change producer: with an architecture
    // intent present and a proven base, `debt.introduced` names the SAME id
    // the ledger derives from the judged fact. Base populates both boundary
    // sides with no forbidden edge (clean); the declared head adds the
    // api→payments edge the intent forbids — one drift finding introduced.
    const intentDoc = {
      version: "1",
      boundaries: [
        { name: "packages", match: ["tag:scope-invented"] },
        { name: "shared", match: ["tag:scope-shared"] },
      ],
      forbidden: [{ from: "packages", to: "shared", reason: "engine must not reach shared" }],
      allowed: [],
    };
    const result = await run({
      ctx: contextOf({ graph: declaredHeadGraph() }),
      baseline: baselineOf(),
      intent: emptyRowsManifest(),
      config: config(),
      loadIntentOverride: async () => intentDoc,
    });
    expect(result.changeIntent.debt.introduced).toEqual([
      debtFactId("drift", {
        source: "acme-api",
        target: "acme-payments",
        rule: "intentForbiddenEdge",
      }),
    ]);
    expect(result.changeIntent.debt.resolved).toEqual([]);
    expect(result.changeIntent.debt.note).toBeUndefined();
  });
});

describe("the reconcile event (--event-out)", () => {
  it("writes nothing when the flag is absent — the run stays byte-identical", async () => {
    /** @type {{dir: string, event: object}[]} */
    const writes = [];
    const baseline = baselineOf();
    const result = await run({
      ctx: contextOf({ graph: declaredHeadGraph() }),
      baseline,
      intent: manifest({ summary: "add payments" }),
      writeEvent: (dir, event) => {
        writes.push({ dir, event });
        return { id: event.id, duplicate: false };
      },
    });
    expect(writes).toEqual([]);
    expect(result.report.text).not.toContain("event ");
  });

  it("writes the canonical reconcile event with kind, source, digest, refs and disposition", async () => {
    /** @type {{dir: string, event: object}[]} */
    const writes = [];
    const intent = manifest({ summary: "add payments", constraints: { noNewViolations: true } });
    const result = await run({
      ctx: contextOf({ graph: declaredHeadGraph() }),
      baseline: baselineOf(),
      intent,
      eventOut: "events",
      writeEvent: (dir, event) => {
        writes.push({ dir, event });
        return { id: event.id, duplicate: false };
      },
    });
    expect(writes).toHaveLength(1);
    const { dir, event } = writes[0];
    expect(dir).toBe("events");
    expect(event.schemaVersion).toBe(EVOLUTION_EVENT_SCHEMA_VERSION);
    expect(event.kind).toBe("reconcile");
    expect(event.source).toBe("change");
    expect(event.declaration).toEqual({ file: "intent.json", digest: declarationDigest(intent) });
    expect(event.base).toEqual({ revision: provenanceCommit(), evidence: "baseline.json" });
    expect(event.head).toEqual({ revision: provenanceCommit() });
    expect(event.observed.architectureChanged).toBe(true);
    expect(event.observed.projects).toEqual({ added: ["acme-payments"], removed: [], changed: [] });
    expect(event.observed.edges).toEqual({ added: ["acme-api>acme-payments:static"], removed: [] });
    expect(event.observed.policyChanged).toBe(false);
    expect(event.observed.providerChanged).toBe(false);
    expect(event.findings).toEqual({ introduced: [], resolved: [], unknown: [] });
    expect(event.fitness.verdictDeltas).toEqual([{ id: "no-new-violations", verdict: "pass" }]);
    expect(event.debt).toEqual({ introduced: [], resolved: [], note: expect.any(String) });
    expect(event.classifications).toEqual(["CHANGE"]);
    expect(event.disposition).toBe("accepted");
    expect(event.affected.projects).toEqual(["acme-payments"]);
    expect(event.provenance).toEqual([{ kind: "git-commit", ref: provenanceCommit() }]);
    expect(event.recordedAt).toEqual({ by: "change", tool: "archkeep:v1", on: FUTURE });
    // The identity is the canonical tuple, held by W1's own functions — the
    // event must not carry an id its dedupeKey cannot reproduce.
    expect(event.id).toBe(eventId(event));
    expect(event.dedupeKey).toBe(eventDedupeKey(event));
    expect(event.id).toHaveLength(64);
    // The report names the write, and only when the flag was passed.
    expect(result.report.text).toContain("event      reconcile/change ");
    expect(result.report.text).toContain("→ events");
  });

  it("is idempotent: a rerun over the same transition produces the same event id", async () => {
    const baseline = baselineOf();
    /** @type {(intent: object) => Promise<object>} */
    const oneRun = async (intent) => {
      /** @type {object[]} */
      const events = [];
      await run({
        ctx: contextOf({ graph: declaredHeadGraph() }),
        baseline,
        intent,
        eventOut: "events",
        writeEvent: (_dir, event) => {
          events.push(event);
          return { id: event.id, duplicate: false };
        },
      });
      return events[0];
    };
    const declared = manifest({ summary: "add payments" });
    const first = await oneRun(declared);
    const second = await oneRun(declared);
    expect(second.id).toBe(first.id);
    expect(second.dedupeKey).toBe(first.dedupeKey);
    // The digest excludes prose: a re-worded summary is the same transition,
    // same tuple, same id (prose is not semantics).
    const reworded = await oneRun(
      manifest({ summary: "a completely different way of saying the same change" }),
    );
    expect(reworded.id).toBe(first.id);
  });

  it("maps the violation delta into the event findings and rejects on it", async () => {
    /** @type {object[]} */
    const events = [];
    const baseline = baselineOf();
    const result = await run({
      ctx: contextOf({ graph: declaredHeadGraph(), records: [crossingRecord()] }),
      baseline,
      intent: manifest({ constraints: { noNewViolations: true } }),
      eventOut: "events",
      writeEvent: (_dir, event) => {
        events.push(event);
        return { id: event.id, duplicate: false };
      },
    });
    expect(result.changeIntent.classifications).toContain("VIOLATION");
    expect(events[0].findings.introduced).toHaveLength(1);
    expect(events[0].findings.introduced[0]).toMatch(/^[^:]+:[^:]+:[^:]+$/);
    expect(events[0].classifications).toContain("VIOLATION");
    expect(events[0].disposition).toBe("rejected");
    // The VIOLATION lives in the event `findings`; with no intent file the
    // `debt` sub-ledger stays empty and says so — the two never merge.
    expect(events[0].debt).toEqual({ introduced: [], resolved: [], note: expect.any(String) });
  });

  it("maps resolved violations into the event findings as REPAIR", async () => {
    /** @type {object[]} */
    const events = [];
    // The base carries the crossing (with the payments project present so the
    // record resolves); the head has neither — the violation is resolved.
    const baseline = baselineOf({ graph: declaredHeadGraph(), records: [crossingRecord()] });
    await run({
      ctx: contextOf({ graph: baseGraph(), records: [] }),
      baseline,
      intent: emptyRowsManifest(),
      eventOut: "events",
      writeEvent: (_dir, event) => {
        events.push(event);
        return { id: event.id, duplicate: false };
      },
    });
    expect(events[0].findings.resolved).toHaveLength(1);
    expect(events[0].classifications).toContain("REPAIR");
  });

  // The hostile-name half of the finding-id contract (#628): the two
  // violations below carried ONE id before the fix — a `:` in a project name
  // reads as the field separator — so the event's findings collapsed and the
  // introduced→resolved linkage could attribute one finding's repair to the
  // other. A manifest-declared name is an arbitrary string, so the collision
  // is a reachable input, not a theory.
  it("keeps two violations whose unescaped finding ids collided as two findings", async () => {
    /** @type {object[]} */
    const events = [];
    // `(source, target)` pairs chosen so the unescaped joins are identical:
    // `acme:api`→`pay` and `acme`→`api:pay` both joined to
    // `…:acme:api:pay`. Both violate the same law row, so both classify as
    // introduced by the delta (whose own key is structural), and only the
    // finding id flattened them into one.
    const hostileGraph = {
      nodes: {
        "acme:api": node("acme:api", "libs/acme-api", ["scope-invented"]),
        acme: node("acme", "libs/acme", ["scope-invented"]),
        pay: node("pay", "libs/pay", ["scope-shared"]),
        "api:pay": node("api:pay", "libs/api-pay", ["scope-shared"]),
      },
      dependencies: {
        "acme:api": [{ source: "acme:api", target: "pay", type: "static" }],
        acme: [{ source: "acme", target: "api:pay", type: "static" }],
        pay: [],
        "api:pay": [],
      },
    };
    /** @param {string} sourceFile @param {string} target */
    const hostileRecord = (sourceFile, target) =>
      crossingRecord({
        sourceFile,
        resolved: { target, file: null, external: false, packageName: null },
      });
    const baseline = baselineOf();
    await run({
      ctx: contextOf({
        graph: hostileGraph,
        records: [
          hostileRecord("libs/acme-api/src/a.go", "pay"),
          hostileRecord("libs/acme/src/b.go", "api:pay"),
        ],
      }),
      baseline,
      intent: emptyRowsManifest(),
      eventOut: "events",
      writeEvent: (_dir, event) => {
        events.push(event);
        return { id: event.id, duplicate: false };
      },
    });
    const introduced = events[0].findings.introduced;
    expect(introduced).toHaveLength(2);
    // The red direction: before the fix this set held ONE string, byte-for-
    // byte the event a workspace with a single violation produces.
    expect(new Set(introduced).size).toBe(2);
    expect(introduced).toContain("onlyTagsConstraintViolation:acme\\:api:pay");
    expect(introduced).toContain("onlyTagsConstraintViolation:acme:api\\:pay");
  });

  it("records no-verdict when the base identity is unproven — never accepted", async () => {
    /** @type {object[]} */
    const events = [];
    await run({
      ctx: contextOf(),
      baseline: baselineOf(),
      intent: manifest({ base: { commit: "0".repeat(40) }, summary: "add payments" }),
      eventOut: "events",
      writeEvent: (_dir, event) => {
        events.push(event);
        return { id: event.id, duplicate: false };
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].disposition).toBe("no-verdict");
    expect(events[0].classifications).toEqual([]);
    expect(events[0].notes).toEqual([
      "declared intent row 'intent' is unproven — its verdict could not be determined",
    ]);
  });
});

describe("the CLI surface", () => {
  const law = `export const depConstraints = [
  { sourceTag: "scope-invented", onlyDependOnLibsWithTags: ["scope-invented"] },
];

export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: [],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;

  const cliContext = () => ({
    cwd: root,
    readGraph: () => declaredHeadGraph(),
    // `libs/api/src/index.js` is owned by the acme-api project, so the run
    // judges at least one file — a run that judged nothing is the no-verdict
    // lane (#599) and would refuse before any of the refusals these tests
    // pin.
    listFiles: () => [
      "nx.json",
      "module-boundaries.config.mjs",
      "libs/api/src/index.js",
      "baseline.json",
      "intent.json",
    ],
  });

  const streams = () => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
    };
  };

  /** A real workspace on disk: marker, law, one owned source, baseline evidence, manifest. */
  const writeWorkspace = () => {
    writeFileSync(join(root, "nx.json"), "{}\n");
    writeFileSync(join(root, "module-boundaries.config.mjs"), `${law}\n`);
    mkdirSync(join(root, "libs", "api", "src"), { recursive: true });
    writeFileSync(join(root, "libs", "api", "src", "index.js"), 'export const api = "api";\n');
    const { text } = captureDelta(contextOf(), { config: config() });
    writeFileSync(join(root, "baseline.json"), text);
    writeFileSync(join(root, "intent.json"), `${JSON.stringify(manifest(), null, 2)}\n`);
  };

  it("pins the missing-baseline refusal at exit 3 — never a clean verdict", async () => {
    writeWorkspace();
    const s = streams();
    const exitCode = await runCli(["change", "no-such-baseline.json", "--intent", "intent.json"], {
      ...cliContext(),
      ...s,
    });
    expect(exitCode).toBe(3);
    expect(s.lines.err.join("\n")).toMatch(/baseline/);
    expect(s.lines.out.join("\n")).toBe("");
  });

  it("writes an idempotent event file with --event-out and none without", async () => {
    writeWorkspace();
    const eventsDir = join(root, "events");
    const argv = (dir) => [
      "change",
      "baseline.json",
      "--intent",
      "intent.json",
      ...(dir === undefined ? [] : ["--event-out", dir]),
    ];

    // Absent the flag: exit 0, and no event directory is even created — the
    // option's absence changes nothing about the run.
    const plain = streams();
    expect(await runCli(argv(undefined), { ...cliContext(), ...plain })).toBe(0);
    expect(existsSync(eventsDir)).toBe(false);
    expect(plain.lines.out.join("\n")).not.toContain("event ");

    // With the flag: one event file, canonical shape, exit code unchanged.
    const first = streams();
    expect(await runCli(argv("events"), { ...cliContext(), ...first })).toBe(0);
    const files = readdirSync(eventsDir).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-[0-9a-f]{8}\.json$/);
    const event = JSON.parse(readFileSync(join(eventsDir, files[0]), "utf8"));
    expect(event.kind).toBe("reconcile");
    expect(event.source).toBe("change");
    expect(event.declaration.digest).toBe(
      declarationDigest(parseChangeIntent(JSON.stringify(manifest()), "intent.json")),
    );
    expect(event.id).toBe(eventId(event));

    // Rerun: the store dedupes by the canonical tuple — still one file, and
    // the report says the write was a duplicate rather than staying silent.
    const second = streams();
    expect(await runCli(argv("events"), { ...cliContext(), ...second })).toBe(0);
    expect(readdirSync(eventsDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(second.lines.out.join("\n")).toContain("duplicate — nothing written");
  });
});

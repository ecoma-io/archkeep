import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "../../cli.mjs";
import { parseChangeIntent } from "./change-intent.mjs";
import { parseEvidenceSnapshot, serializeEvidenceSnapshot } from "./delta-snapshot.mjs";
import { captureDelta } from "./delta.mjs";
import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../../spawn-budget.mjs";
import { changeCommand } from "./change.mjs";

/**
 * What the `change` command guarantees: the reconciliation answers exactly
 * one question — did the delta match the declaration — with undeclared,
 * unfulfilled and unproven as three DIFFERENT outcomes; the workspace-law
 * axis stays informational beside it (never folded into the exit code);
 * constraints judge both sides under ONE current law through the shared
 * engine; and every could-not-look path refuses loudly instead of reading as
 * a clean or matched reconciliation.
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
// machine's — the same arrangement `../report/envelope-shape.integration.test.mjs`
// uses. The commit is load-bearing here: the contract pins it as its base.
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
  root = mkdtempSync(join(tmpdir(), "archkeep-change-command-"));
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
 * @param {{graph?: object, records?: object[], failures?: object[],
 *   pluginGap?: {registered: boolean, manifests: string[]}}} [input]
 */
function contextOf({ graph = baseGraph(), records = [], failures = [], pluginGap } = {}) {
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
    owned: [],
    pluginGap: pluginGap ?? { registered: true, manifests: [] },
  };
}

/** Captures the base tree, round-tripping through serializer AND parser. */
/**
 * @param {{graph?: object, records?: object[], law?: object,
 *   provenance?: object|null}} [input]
 */
function baselineOf({ graph = baseGraph(), records = [], law = config(), provenance } = {}) {
  const { snapshot } = captureDelta(contextOf({ graph, records }), { config: law });
  const stored = provenance === undefined ? snapshot : { ...snapshot, provenance };
  return {
    snapshot: stored,
    readBaseline: (path) => parseEvidenceSnapshot(serializeEvidenceSnapshot(stored), path),
  };
}

/** A manifest pinning the fixture's actual base commit, by default. */
function manifest(overrides = {}, commit = null) {
  const intent = {
    version: "1",
    base: { commit: commit ?? provenanceCommit() },
    projects: { add: ["acme-payments"], remove: [] },
    edges: { add: [{ from: "acme-api", to: "acme-payments" }], remove: [] },
    constraints: {},
    ...overrides,
  };
  return intent;
}

function provenanceCommit() {
  // resolveProvenance is the command's own seam into git; reading the same
  // fact here keeps the fixture honest about what a real manifest pins.
  const status = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
  });
  return status.stdout.trim();
}

/** Runs the command over injected readers, returning the full result. */
/**
 * @param {{ctx?: object, baseline: {readBaseline: (path: string) => object},
 *   intent?: object|undefined, config?: object|undefined, now?: string|undefined}} input
 */
async function run({ ctx, baseline, intent, config: law, now }) {
  return changeCommand("baseline.json", "intent.json", ctx ?? contextOf(), {
    config: law ?? config(),
    readBaseline: baseline.readBaseline,
    ...(intent === undefined
      ? {}
      : { readIntent: async () => parseChangeIntent(JSON.stringify(intent), "intent.json") }),
    ...(now === undefined ? {} : { now }),
  });
}

describe("the reconciliation verdicts", () => {
  it("answers matched when the delta is exactly the declared change", async () => {
    const baseline = baselineOf();
    const result = await run({
      ctx: contextOf({ graph: declaredHeadGraph() }),
      baseline,
      intent: manifest({
        summary: "add payments",
        constraints: { noNewViolations: true },
      }),
    });
    expect(result.status).toBe("ok");
    expect(result.changeIntent.reconciliation.verdict).toBe("matched");
    expect(result.changeIntent.reconciliation.unexpected).toEqual([]);
    expect(result.changeIntent.reconciliation.missingExpected).toEqual([]);
    expect(result.changeIntent.reconciliation.matched).toEqual([
      { kind: "edge-added", from: "acme-api", to: "acme-payments", type: "static" },
      { kind: "project-added", project: "acme-payments" },
    ]);
    expect(result.changeIntent.constraints[0]).toMatchObject({
      name: "no-new-violations",
      verdict: "pass",
    });
    // The informational law axis rides along without gating.
    expect(result.changeIntent.policy.liveViolations).toBe(0);
  });

  it("names an observed material change nothing declared as unexpected, not matched", async () => {
    const baseline = baselineOf();
    const head = declaredHeadGraph();
    head.nodes["acme-db2"] = node("acme-db2", "libs/db2", []);
    head.dependencies["acme-api"] = [
      ...head.dependencies["acme-api"],
      { source: "acme-api", target: "acme-db", type: "static" },
    ];
    const result = await run({ ctx: contextOf({ graph: head }), baseline, intent: manifest() });
    expect(result.status).toBe("findings");
    expect(result.changeIntent.reconciliation.verdict).toBe("undeclared");
    expect(result.changeIntent.reconciliation.matched).toHaveLength(2);
    expect(result.changeIntent.reconciliation.unexpected).toEqual([
      { kind: "edge-added", from: "acme-api", to: "acme-db", type: "static" },
      { kind: "project-added", project: "acme-db2" },
    ]);
  });

  it("reconciles several graph spellings of one declared dependency as the single declared fact", async () => {
    // Edges match on (from, to): whether the model spells the dependency
    // `static` or `dynamic` is its business, not the author's promise. The
    // abuse question — a lazy-load channel opened where only static use was
    // promised — belongs to noNewViolations/delta/check, not to the
    // declaration matcher.
    const baseline = baselineOf();
    const head = declaredHeadGraph();
    head.dependencies["acme-api"].push({
      source: "acme-api",
      target: "acme-payments",
      type: "dynamic",
    });
    const result = await run({ ctx: contextOf({ graph: head }), baseline, intent: manifest() });
    expect(result.status).toBe("ok");
    expect(result.changeIntent.reconciliation.verdict).toBe("matched");
    expect(result.changeIntent.reconciliation.matched).toEqual([
      { kind: "edge-added", from: "acme-api", to: "acme-payments", type: "dynamic" },
      { kind: "edge-added", from: "acme-api", to: "acme-payments", type: "static" },
      { kind: "project-added", project: "acme-payments" },
    ]);
  });

  it("keeps an unfulfilled declaration apart from undeclared — and never calls it matched", async () => {
    const baseline = baselineOf();
    // The project appeared but the edge never did.
    const head = declaredHeadGraph();
    head.dependencies["acme-api"] = [];
    const result = await run({ ctx: contextOf({ graph: head }), baseline, intent: manifest() });
    expect(result.status).toBe("findings");
    expect(result.changeIntent.reconciliation.verdict).toBe("unfulfilled");
    expect(result.changeIntent.reconciliation.unexpected).toEqual([]);
    expect(result.changeIntent.reconciliation.missingExpected).toEqual([
      { kind: "edge-added", from: "acme-api", to: "acme-payments" },
    ]);
  });

  it("reports a workspace-law failure beside a matched intent, gating neither", async () => {
    const baseline = baselineOf();
    // Structurally exactly as declared — but the new edge carries a violation
    // of the boundary law.
    const result = await run({
      ctx: contextOf({ graph: declaredHeadGraph(), records: [crossingRecord()] }),
      baseline,
      intent: manifest(),
    });
    // The law axis is evidence for the reviewer and never this command's
    // gate — `check` owns that verdict — so a matched reconciliation stays
    // `ok` while the live count rides beside it.
    expect(result.status).toBe("ok");
    expect(result.changeIntent.reconciliation.verdict).toBe("matched");
    expect(result.changeIntent.policy.liveViolations).toBeGreaterThan(0);
    // No constraint was declared, so none judged.
    expect(result.changeIntent.constraints).toEqual([]);
  });

  it("fails a declared no-new-violations constraint when the declared edge introduces one", async () => {
    const baseline = baselineOf();
    const result = await run({
      ctx: contextOf({ graph: declaredHeadGraph(), records: [crossingRecord()] }),
      baseline,
      intent: manifest({ constraints: { noNewViolations: true } }),
    });
    expect(result.status).toBe("findings");
    expect(result.changeIntent.reconciliation.verdict).toBe("matched");
    expect(result.changeIntent.constraints).toHaveLength(1);
    expect(result.changeIntent.constraints[0]).toMatchObject({
      name: "no-new-violations",
      verdict: "fail",
      evidence: { introduced: 1, introducedWaived: 0 },
    });
  });

  it("does not fail the violations constraint for an introduced violation an active waiver covers", async () => {
    const baseline = baselineOf();
    const result = await run({
      ctx: contextOf({ graph: declaredHeadGraph(), records: [crossingRecord()] }),
      baseline,
      intent: manifest({ constraints: { noNewViolations: true } }),
      config: config({
        suppressions: [{ path: "libs/api/**", reason: "accepted for now", expiresAt: FUTURE }],
      }),
    });
    expect(result.changeIntent.constraints[0]).toMatchObject({
      name: "no-new-violations",
      verdict: "pass",
      evidence: { introduced: 1, introducedWaived: 1 },
    });
  });

  it("fails a declared no-new-cycles constraint when the declared edges close one", async () => {
    const baseline = baselineOf({
      graph: {
        nodes: {
          a: node("a", "libs/a"),
          b: node("b", "libs/b"),
          c: node("c", "libs/c"),
        },
        dependencies: { a: [], b: [], c: [] },
      },
    });
    const edge = (from, to) => ({ source: from, target: to, type: "static" });
    const head = {
      nodes: baseline.snapshot.graph.projects.reduce(
        (nodes, project) => ({ ...nodes, [project.name]: node(project.name, project.root) }),
        {},
      ),
      dependencies: {
        a: [edge("a", "b")],
        b: [edge("b", "c")],
        c: [edge("c", "a")],
      },
    };
    const result = await run({
      ctx: contextOf({ graph: head }),
      baseline,
      intent: {
        version: "1",
        base: { commit: provenanceCommit() },
        projects: { add: [], remove: [] },
        edges: {
          add: [
            { from: "a", to: "b" },
            { from: "b", to: "c" },
            { from: "c", to: "a" },
          ],
          remove: [],
        },
        constraints: { noNewCycles: true },
      },
    });
    // Every edge was declared, so structurally this matched — and the cycle
    // constraint still fails it, on its own axis.
    expect(result.changeIntent.reconciliation.verdict).toBe("matched");
    expect(result.changeIntent.constraints[0]).toMatchObject({
      name: "no-new-cycles",
      verdict: "fail",
      evidence: { baseCyclicProjects: [], newCyclicProjects: ["a", "b", "c"] },
    });
    expect(result.status).toBe("findings");
  });

  it("treats source-only edits as no material change and matches an empty contract", async () => {
    const baseline = baselineOf();
    // An import between two EXISTING projects — source changed, architecture
    // did not. (It violates the law, which makes the informational axis show
    // it without the reconciliation caring.)
    const record = crossingRecord({
      specifier: "example.invalid/acme/db",
      resolved: {
        target: "acme-db",
        file: "libs/db/src/db.go",
        external: false,
        packageName: null,
      },
    });
    const result = await run({
      ctx: contextOf({ records: [record] }),
      baseline,
      intent: manifest({ projects: { add: [], remove: [] }, edges: { add: [], remove: [] } }),
    });
    expect(result.status).toBe("ok");
    expect(result.changeIntent.reconciliation.verdict).toBe("matched");
    // The import site was seen — as a violation axis, never as architecture.
    expect(result.coverage.imports).toBe(1);
    expect(result.changeIntent.policy.liveViolations).toBe(1);
  });

  it("reports a project whose metadata changed as undeclared — there is no surface that hides it", async () => {
    const baseline = baselineOf();
    const head = baseGraph();
    head.nodes["acme-db"].data.tags = ["scope-something-else"];
    const result = await run({
      ctx: contextOf({ graph: head }),
      baseline,
      intent: manifest({ projects: { add: [], remove: [] }, edges: { add: [], remove: [] } }),
    });
    expect(result.changeIntent.reconciliation.verdict).toBe("undeclared");
    expect(result.changeIntent.reconciliation.unexpected).toEqual([
      {
        kind: "project-changed",
        project: "acme-db",
        changes: [{ field: "tags", baseline: ["scope-shared"], head: ["scope-something-else"] }],
      },
    ]);
  });
});

describe("the base identity", () => {
  it("refuses to call anything matched when the pinned commit differs from the baseline", async () => {
    const baseline = baselineOf();
    const other = "f".repeat(40);
    const result = await run({
      ctx: contextOf({ graph: declaredHeadGraph() }),
      baseline,
      intent: manifest({}, other),
    });
    expect(result.status).toBe("no-verdict");
    expect(result.changeIntent.reconciliation.verdict).toBe("unproven");
    expect(result.changeIntent.reconciliation.reasons[0]).toContain(other.slice(0, 8));
    expect(result.changeIntent.reconciliation.reasons[0]).toContain(
      baseline.snapshot.provenance.commit.slice(0, 8),
    );
    // Constraints are left unevaluated over a base the run cannot vouch for.
    expect(result.changeIntent.constraints).toEqual([]);
  });

  it("answers unproven — never matched — when the baseline carries no provenance at all", async () => {
    const baseline = baselineOf({ provenance: null });
    const result = await run({ ctx: contextOf(), baseline, intent: manifest() });
    expect(result.status).toBe("no-verdict");
    expect(result.changeIntent.reconciliation.verdict).toBe("unproven");
    expect(result.changeIntent.reconciliation.reasons[0]).toMatch(/carries no provenance/);
  });
});

describe("refusals — every could-not-look path says so", () => {
  it("refuses a malformed baseline instead of reconciling against nothing", async () => {
    const baseline = {
      readBaseline: (path) => parseEvidenceSnapshot('{"schemaVersion":2}', path),
    };
    await expect(run({ ctx: contextOf(), baseline, intent: manifest() })).rejects.toThrow(
      /schemaVersion/,
    );
  });

  it("refuses a graph envelope handed over as the evidence baseline", async () => {
    await expect(
      run({
        ctx: contextOf(),
        baseline: {
          readBaseline: (path) =>
            parseEvidenceSnapshot('{"schemaVersion":2,"command":"graph"}', path),
        },
        intent: manifest(),
      }),
    ).rejects.toThrow(/schemaVersion/);
  });

  it("refuses a provider mismatch — names across two models are not evidence", async () => {
    const baseline = baselineOf();
    baseline.snapshot.provider = "native";
    await expect(
      run({
        ctx: contextOf(),
        baseline: {
          readBaseline: (path) =>
            parseEvidenceSnapshot(serializeEvidenceSnapshot(baseline.snapshot), path),
        },
        intent: manifest(),
      }),
    ).rejects.toThrow(/provider/);
  });

  it("refuses an unregistered plugin over polyglot manifests", async () => {
    const baseline = baselineOf();
    await expect(
      run({
        ctx: contextOf({ pluginGap: { registered: false, manifests: ["go.mod"] } }),
        baseline,
        intent: manifest(),
      }),
    ).rejects.toThrow(/refusing to reconcile a change intent.*registered/s);
  });

  it("refuses incomplete head coverage — a hole reads as a removal it may not be", async () => {
    const baseline = baselineOf();
    await expect(
      run({
        ctx: contextOf({
          failures: [{ sourceFile: "libs/db/broken.go", line: null, reason: "parse error" }],
        }),
        baseline,
        intent: manifest(),
      }),
    ).rejects.toThrow(/could not be analyzed/);
  });

  it("throws when the manifest references architecture the baseline does not contain", async () => {
    const baseline = baselineOf();
    await expect(
      run({
        ctx: contextOf(),
        baseline,
        intent: manifest({
          projects: { add: [], remove: [] },
          edges: { add: [{ from: "acme-api", to: "ghost" }], remove: [] },
        }),
      }),
    ).rejects.toThrow(/references architecture the captured baseline does not contain/);
  });

  it("throws when a duplicate declaration slips through an injected reader", async () => {
    const baseline = baselineOf();
    await expect(
      run({
        ctx: contextOf(),
        baseline,
        intent: manifest({
          projects: { add: ["x", "x"], remove: [] },
          edges: { add: [], remove: [] },
        }),
      }),
    ).rejects.toThrow(/duplicates projects\.add\[0\]/);
  });

  it("requires a boundary config", async () => {
    const baseline = baselineOf();
    await expect(
      changeCommand("baseline.json", "intent.json", contextOf(), {
        config: null,
        readBaseline: baseline.readBaseline,
        readIntent: async () => parseChangeIntent(JSON.stringify(manifest()), "intent.json"),
      }),
    ).rejects.toThrow(/without a boundary config/);
  });
});

describe("determinism", () => {
  it("is byte-identical across runs over the same inputs", async () => {
    const baseline = baselineOf();
    const args = {
      ctx: contextOf({ graph: declaredHeadGraph(), records: [crossingRecord()] }),
      baseline,
      intent: manifest({ summary: "add payments", constraints: { noNewViolations: true } }),
    };
    const first = await run(args);
    const second = await run(args);
    expect(first.report.json).toBe(second.report.json);
    expect(first.report.text).toBe(second.report.text);
  });

  it("is indifferent to declaration order — arrays are sets", async () => {
    const baseline = baselineOf();
    const head = declaredHeadGraph();
    head.nodes["acme-billing"] = node("acme-billing", "libs/billing", []);
    head.dependencies["acme-api"].push({
      source: "acme-api",
      target: "acme-billing",
      type: "static",
    });
    const ordered = {
      version: "1",
      base: { commit: provenanceCommit() },
      projects: { add: ["acme-payments", "acme-billing"], remove: [] },
      edges: {
        add: [
          { from: "acme-api", to: "acme-payments" },
          { from: "acme-api", to: "acme-billing" },
        ],
        remove: [],
      },
      constraints: {},
    };
    const reordered = {
      ...ordered,
      projects: { add: ["acme-billing", "acme-payments"], remove: [] },
      edges: {
        ...ordered.edges,
        add: [...ordered.edges.add].reverse(),
      },
    };
    const a = await run({
      ctx: contextOf({ graph: head }),
      baseline,
      intent: ordered,
    });
    const b = await run({
      ctx: contextOf({ graph: head }),
      baseline,
      intent: reordered,
    });
    expect(b.changeIntent.reconciliation.matched).toEqual(a.changeIntent.reconciliation.matched);
    expect(b.report.json).toBe(a.report.json);
  });

  it("lets two manifests differing only in summary reconcile identically", async () => {
    const baseline = baselineOf();
    const quiet = manifest({});
    const loud = manifest({ summary: "add payments capability" });
    const a = await run({
      ctx: contextOf({ graph: declaredHeadGraph() }),
      baseline,
      intent: quiet,
    });
    const b = await run({ ctx: contextOf({ graph: declaredHeadGraph() }), baseline, intent: loud });
    expect(b.changeIntent.reconciliation).toEqual(a.changeIntent.reconciliation);
  });
});

describe("the CLI surface", () => {
  it("refuses to run without --intent — usage error, not a silent reconciliation", async () => {
    const out = [];
    const err = [];
    const exitCode = await runCli(["change", "baseline.json"], {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      cwd: root,
    });
    expect(exitCode).toBe(2);
    expect(err.join("\n")).toMatch(/--intent/);
  });

  it("refuses the wrong positional count", async () => {
    const out = [];
    const err = [];
    const exitCode = await runCli(["change", "--intent", "i.json"], {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      cwd: root,
    });
    expect(exitCode).toBe(2);
    expect(err.join("\n")).toMatch(/exactly one positional argument/);
  });

  it("refuses --output pointing at the manifest itself", async () => {
    const out = [];
    const err = [];
    const exitCode = await runCli(
      ["change", "b.json", "--intent", "i.json", "--output", "i.json"],
      {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        cwd: root,
      },
    );
    expect(exitCode).toBe(2);
    expect(err.join("\n")).toMatch(/resolves to the change-intent manifest itself/);
  });

  it(
    "drives the real binary end-to-end over a fixture workspace",
    async () => {
      // A real (minimal) Nx workspace on disk: marker, law, baseline evidence
      // snapshot, and the manifest — every file the CLI reads from its path,
      // so nothing here bypasses the seams the process would use.
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
      writeFileSync(join(root, "nx.json"), "{}\n");
      writeFileSync(join(root, "module-boundaries.config.mjs"), `${law}\n`);
      const { text } = captureDelta(contextOf(), { config: config() });
      writeFileSync(join(root, "baseline.json"), text);
      writeFileSync(join(root, "intent.json"), `${JSON.stringify(manifest(), null, 2)}\n`);

      const out = [];
      const err = [];
      const exitCode = await runCli(
        ["change", "baseline.json", "--intent", "intent.json", "--format", "json"],
        {
          out: (text_) => out.push(text_),
          err: (text_) => err.push(text_),
          cwd: root,
          readGraph: () => declaredHeadGraph(),
          listFiles: () => [
            "nx.json",
            "module-boundaries.config.mjs",
            "baseline.json",
            "intent.json",
          ],
        },
      );
      expect(exitCode).toBe(0);
      const envelope = JSON.parse(out.join("\n"));
      expect(envelope.command).toBe("change");
      expect(envelope.result.reconciliation.verdict).toBe("matched");
    },
    SPAWN_TEST_BUDGET_MS,
  );
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { captureDelta, deltaCommand, evidenceGraphToProjectGraph } from "./delta.mjs";
import { parseEvidenceSnapshot, serializeEvidenceSnapshot } from "./delta-snapshot.mjs";
import { computePolicyFingerprint } from "./graph.mjs";

/**
 * What the delta command guarantees: both sides re-judged under ONE current
 * law and one shared instant, a base side that really produces violations
 * from a stored snapshot (the silent-direction case — a mis-shaped rebuilt
 * graph yielding zero base violations would classify every standing
 * violation as introduced, or mask base violations entirely), and an exit
 * fold where only non-waived introduced violations gate.
 */

// ---------------------------------------------------------------------------
// Fixtures — invented names throughout.
// ---------------------------------------------------------------------------

const FUTURE = "2027-01-01T00:00:00.000Z";
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
    spelling: { path: false, relative: false },
    resolved: {
      target: "acme-beta",
      file: "libs/beta/src/beta.go",
      external: false,
      packageName: null,
    },
    ...overrides,
  };
}

const root = mkdtempSync(join(tmpdir(), "archkeep-delta-command-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * A resolved CommandContext with everything `delta` reads.
 *
 * @param {{graph?: object, records?: object[], failures?: object[],
 *   pluginGap?: {registered: boolean, manifests: string[]}}} [input]
 */
function contextOf({ graph = engineGraph(), records = [], failures = [], pluginGap } = {}) {
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
    pluginGap: pluginGap ?? { registered: true, manifests: [] },
  };
}

/**
 * Captures a baseline over `records`, round-tripping through the real
 * serializer AND parser so every compare-side test consumes exactly what a
 * file on disk would have held.
 */
function baselineOf({ records = [], graph = engineGraph(), law = config() } = {}) {
  const { snapshot, text } = captureDelta(contextOf({ graph, records }), { config: law });
  return {
    snapshot,
    readBaseline: (path) => parseEvidenceSnapshot(text, path),
  };
}

// ---------------------------------------------------------------------------
// The stored-graph → engine-graph conversion.
// ---------------------------------------------------------------------------

describe("evidenceGraphToProjectGraph", () => {
  it("rebuilds nodes, edges, and the rule-relevant extras the snapshot re-attached", () => {
    const graph = evidenceGraphToProjectGraph({
      projects: [
        {
          name: "acme-alpha",
          root: "libs/alpha",
          type: "lib",
          tags: ["scope-invented"],
          targets: ["compile"],
          mfeRemote: true,
          entryPoints: ["libs/alpha/testing"],
          declaredPackages: ["acme-beta"],
        },
        { name: "acme-beta", root: "libs/beta", type: "lib", tags: [] },
      ],
      dependencies: [{ source: "acme-alpha", target: "acme-beta", type: "static" }],
      workspaceLayout: { appsDir: "products", libsDir: "modules" },
      exemptedFiles: ["vendor/generated.go"],
    });

    expect(graph.nodes["acme-alpha"]).toEqual({
      name: "acme-alpha",
      type: "lib",
      data: {
        root: "libs/alpha",
        tags: ["scope-invented"],
        targets: { compile: {} },
        mfeRemote: true,
        entryPoints: ["libs/alpha/testing"],
        declaredPackages: ["acme-beta"],
      },
    });
    // Absence stays absence: beta declared none of the extras, so the rebuilt
    // node carries none — `evaluate()` reads absence as "declares none".
    expect(graph.nodes["acme-beta"].data).toEqual({ root: "libs/beta", tags: [] });
    expect(graph.dependencies).toEqual({
      "acme-alpha": [{ source: "acme-alpha", target: "acme-beta", type: "static" }],
      "acme-beta": [],
    });
    expect(graph.workspaceLayout).toEqual({ appsDir: "products", libsDir: "modules" });
    expect(graph.exemptedFiles).toEqual(["vendor/generated.go"]);
  });
});

// ---------------------------------------------------------------------------
// Capture.
// ---------------------------------------------------------------------------

describe("captureDelta", () => {
  it("captures tool identity, provider, the policy fingerprint, and the records verbatim", () => {
    const law = config();
    const { snapshot } = captureDelta(contextOf({ records: [crossingRecord()] }), {
      config: law,
    });
    expect(snapshot.tool.name).toMatch(/\S/u);
    expect(snapshot.tool.version).toMatch(/\S/u);
    expect(snapshot.provider).toBe("nx");
    expect(snapshot.policyFingerprint).toBe(computePolicyFingerprint(law));
    expect(snapshot.records).toEqual([crossingRecord()]);
    expect(snapshot.coverage.complete).toBe(true);
  });

  it("serializes deterministically — two captures of one tree are byte-identical", () => {
    const a = captureDelta(contextOf({ records: [crossingRecord()] }), { config: config() });
    const b = captureDelta(contextOf({ records: [crossingRecord()] }), { config: config() });
    expect(serializeEvidenceSnapshot(a.snapshot)).toBe(serializeEvidenceSnapshot(b.snapshot));
  });

  it("refuses to capture without a boundary config — no fingerprint, no law-change claim later", () => {
    expect(() => captureDelta(contextOf(), { config: null })).toThrow(/boundary config/u);
  });

  it("refuses to capture over incomplete coverage", () => {
    const failures = [
      { sourceFile: "libs/alpha/src/broken.go", line: null, column: null, reason: "unreadable" },
    ];
    expect(() => captureDelta(contextOf({ failures }), { config: config() })).toThrow(
      /could not be analyzed/u,
    );
  });

  it("refuses an Nx workspace whose polyglot manifests the unregistered plugin cannot see", () => {
    const pluginGap = { registered: false, manifests: ["libs/alpha/go.mod"] };
    expect(() => captureDelta(contextOf({ pluginGap }), { config: config() })).toThrow(
      /not registered/u,
    );
  });
});

// ---------------------------------------------------------------------------
// Compare: the base side must really re-judge (the silent direction).
// ---------------------------------------------------------------------------

describe("deltaCommand", () => {
  it("re-judges a stored baseline into real violations — a base-side violation resolves, never vanishes", () => {
    // The silent-direction case this stage's design names: a baseline KNOWN to
    // contain a violating record must yield that violation when re-judged. If
    // the rebuilt graph were mis-shaped, base violations would be zero, this
    // entry would land in no bucket, and the delta would read clean.
    const { readBaseline } = baselineOf({ records: [crossingRecord()] });
    const result = deltaCommand("/invented/base.json", contextOf({ records: [] }), {
      config: config(),
      readBaseline,
      now: NOW,
    });

    expect(result.delta.summary.resolved).toBe(1);
    expect(result.delta.violations.resolved[0]).toMatchObject({
      messageId: "onlyTagsConstraintViolation",
      sourceProject: "acme-alpha",
      target: "acme-beta",
      baseCount: 1,
      headCount: 0,
    });
    expect(result.delta.summary.introduced).toBe(0);
    expect(result.status).toBe("ok");
  });

  it("classifies a head-only violation as introduced and folds it into exit 1", () => {
    const { readBaseline } = baselineOf({ records: [] });
    const result = deltaCommand("/invented/base.json", contextOf({ records: [crossingRecord()] }), {
      config: config(),
      readBaseline,
      now: NOW,
    });

    expect(result.status).toBe("findings");
    expect(result.delta.summary.introduced).toBe(1);
    const envelope = JSON.parse(result.report.json);
    expect(envelope.status).toBe("findings");
    expect(envelope.exitCode).toBe(1);
    expect(envelope.decision.verdict).toBe("fail");
    // Text and JSON agree on the same counts.
    expect(result.report.text).toContain("1 introduced violation");
    expect(envelope.result.summary).toEqual(result.delta.summary);
  });

  it("reports a waived introduced violation without failing the gate", () => {
    const { readBaseline } = baselineOf({ records: [] });
    const law = config({
      suppressions: [
        { path: "libs/alpha/**", reason: "accepted for the invented migration", expiresAt: FUTURE },
      ],
    });
    const result = deltaCommand("/invented/base.json", contextOf({ records: [crossingRecord()] }), {
      config: law,
      readBaseline,
      now: NOW,
    });

    expect(result.delta.summary.introduced).toBe(1);
    expect(result.delta.summary.introducedWaived).toBe(1);
    expect(result.delta.violations.introduced[0].waived).toBe(true);
    // Reported, not gating: the entry is in the report, the exit stays clean.
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.report.json).exitCode).toBe(0);
    expect(result.report.text).toContain("[waived]");
  });

  it("keeps a shrunk-but-present violation unchanged — a partial fix never reads as resolved", () => {
    const two = [crossingRecord({ line: 5 }), crossingRecord({ line: 9 })];
    const { readBaseline } = baselineOf({ records: two });
    const result = deltaCommand(
      "/invented/base.json",
      contextOf({ records: [crossingRecord({ line: 5 })] }),
      { config: config(), readBaseline, now: NOW },
    );

    expect(result.delta.summary.resolved).toBe(0);
    expect(result.delta.summary.unchanged).toBe(1);
    expect(result.delta.violations.unchanged[0].note).toMatch(/occurrencesReduced/u);
    expect(result.status).toBe("ok");
  });

  it("classifies unresolvable records as their own carried category, never as violations", () => {
    const phantom = crossingRecord({
      sourceFile: "libs/alpha/src/loader.ts",
      specifier: "@acme/phantom",
      resolved: null,
    });
    const { readBaseline } = baselineOf({ records: [] });
    const result = deltaCommand("/invented/base.json", contextOf({ records: [phantom] }), {
      config: config(),
      readBaseline,
      now: NOW,
    });

    expect(result.delta.summary.unresolvable.introduced).toBe(1);
    expect(result.delta.unresolvable.introduced[0]).toMatchObject({
      specifier: "@acme/phantom",
      sourceProject: "acme-alpha",
    });
    // Carried, not gating: no violation was introduced, so the delta is clean.
    expect(result.delta.summary.introduced).toBe(0);
    expect(result.status).toBe("ok");
  });

  it("answers no-verdict when an item cannot be classified — never a silently clean delta", () => {
    // A head record with no usable specifier can state no identity; the
    // classifier refuses to guess it into a bucket, and the run must fold
    // that refusal into exit 3 rather than report a clean comparison.
    const nameless = crossingRecord({ specifier: "", resolved: null });
    const { readBaseline } = baselineOf({ records: [] });
    const result = deltaCommand("/invented/base.json", contextOf({ records: [nameless] }), {
      config: config(),
      readBaseline,
      now: NOW,
    });

    expect(result.delta.summary.unresolvable.unknown).toBe(1);
    expect(result.status).toBe("no-verdict");
    const envelope = JSON.parse(result.report.json);
    expect(envelope.exitCode).toBe(3);
    expect(envelope.decision.verdict).toBe("unknown");
    expect(envelope.decision.reason).toMatch(/could not be classified/u);
  });

  it("refuses a baseline captured under a different provider — identity across models is not evidence", () => {
    const { snapshot } = baselineOf({ records: [] });
    const foreign = { ...snapshot, provider: "moon" };
    expect(() =>
      deltaCommand("/invented/base.json", contextOf(), {
        config: config(),
        readBaseline: () => foreign,
        now: NOW,
      }),
    ).toThrow(/'moon' provider.*'nx'/su);
  });

  it("refuses an incomplete head — a delta over a half-analyzed tree is not a verdict", () => {
    const { readBaseline } = baselineOf({ records: [] });
    const failures = [
      { sourceFile: "libs/alpha/src/broken.go", line: null, column: null, reason: "unreadable" },
    ];
    expect(() =>
      deltaCommand("/invented/base.json", contextOf({ failures }), {
        config: config(),
        readBaseline,
        now: NOW,
      }),
    ).toThrow(/could not be analyzed/u);
  });

  it("refuses to compare without a boundary config", () => {
    const { readBaseline } = baselineOf({ records: [] });
    expect(() =>
      deltaCommand("/invented/base.json", contextOf(), { config: null, readBaseline, now: NOW }),
    ).toThrow(/boundary config/u);
  });

  it("notes a policy change loudly instead of refusing — both sides answer to the current law", () => {
    const capturedUnder = config({
      depConstraints: [{ sourceTag: "scope-invented", onlyDependOnLibsWithTags: ["*"] }],
    });
    const { readBaseline } = baselineOf({ records: [crossingRecord()], law: capturedUnder });
    const result = deltaCommand("/invented/base.json", contextOf({ records: [crossingRecord()] }), {
      config: config(),
      readBaseline,
      now: NOW,
    });

    expect(result.delta.policyChanged).toBe(true);
    expect(result.coverage.notes.join("\n")).toMatch(/boundary law changed since capture/u);
    expect(result.report.text).toMatch(/boundary law changed since capture/u);
    // Under the CURRENT law both sides violate identically: unchanged, never
    // an introduced/resolved pair fabricated by the law's own movement.
    expect(result.delta.summary.unchanged).toBe(1);
    expect(result.delta.summary.introduced).toBe(0);
    expect(result.delta.summary.resolved).toBe(0);
  });

  it("notes dirty base provenance and a one-sided pair loudly, refusing neither", () => {
    const { snapshot } = baselineOf({ records: [] });
    const dirty = {
      ...snapshot,
      provenance: { commit: "0123456789abcdef0123456789abcdef01234567", remote: null, dirty: true },
    };
    const result = deltaCommand("/invented/base.json", contextOf(), {
      config: config(),
      readBaseline: () => dirty,
      now: NOW,
    });

    const notes = result.coverage.notes.join("\n");
    expect(notes).toMatch(/dirty working tree/u);
    // The fixture root is not a repository, so the head side carries no
    // provenance — disclosed, never read as "same repository".
    expect(notes).toMatch(/head carries no provenance/u);
    expect(result.status).toBe("ok");
  });
});

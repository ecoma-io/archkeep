import { describe, expect, it } from "vitest";

import { computeImpact } from "./impact.mjs";
import { collectImpact } from "./plan-context-command.mjs";
import { diffCommand } from "./diff.mjs";
import { deltaCommand } from "./delta.mjs";
import { buildEvidenceSnapshot, serializeEvidenceSnapshot } from "./delta-snapshot.mjs";
import { healthCommand } from "./health.mjs";
import { reportCommand } from "./report.mjs";
import { waiversCommand } from "./waivers.mjs";

/**
 * Cross-command consistency for the gate and composition faces.
 *
 * Three relationships, each protecting the shared authority boundary:
 *
 1. **`diff` ↔ `delta`** — both answer "which violations does this change
    introduce", through two DIFFERENT engines: `diff` judges added EDGES via
    `edge-constraints.mjs`'s tag rules; `delta` re-judges both sides'
    import-site RECORDS through the full rule engine. The documented narrowing
    (diff's rule impact covers only the depConstraints verdicts) is itself
    pinned here as a subset relation — so a future edit that quietly widens,
    narrows or re-filters either side breaks this file instead of a consumer.
 2. **`report` ↔ its sections' own commands** — the document claims it
    "composes health, waivers, fitness … through the same functions those
    commands run". That claim is measured: every number in the report must be
    the number the standalone command returns over the same context, law and
    clock. If report ever re-derives a metric of its own, the two faces drift
    while both suites stay green.
 3. **`impact` ↔ `context --plan`** — plan mode's impact section is
    `computeImpact` with a cap bolted on. Under the cap the two faces must be
    indistinguishable.

 * Everything is structured facts — ids, project pairs, counts — never prose.
 */

const NOW = "2026-01-15T09:00:00.000Z";

/** The eight options at their defaults (`loadBoundaryConfig`'s shape). */
const options = () => ({
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
});

const config = (extra = {}) => ({
  depConstraints: [{ sourceTag: "zone:x", onlyDependOnLibsWithTags: ["zone:x"] }],
  options: options(),
  suppressions: [],
  notes: [],
  ...extra,
});

/** Every messageId `judgeEdge` can emit — the set `diff.ruleImpact` is scoped to. */
const EDGE_MESSAGE_IDS = new Set([
  "onlyTagsConstraintViolation",
  "notTagsConstraintViolation",
  "emptyOnlyTagsConstraintViolation",
  "projectWithoutTagsCannotHaveDependencies",
]);

const nodes = {
  alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: ["zone:x"] } },
  beta: { name: "beta", type: "lib", data: { root: "libs/beta", tags: ["zone:y"] } },
};

/** An alpha→beta import site: legal by tags? No — zone:x may not reach zone:y. */
const site = ({ specifier = "@fixture/beta", relative = false } = {}) => ({
  sourceFile: "libs/alpha/src/index.ts",
  line: 3,
  column: 1,
  kind: "static",
  spelling: { path: relative, relative },
  resolved: { target: "beta", file: "libs/beta/src/index.ts", external: false, packageName: null },
  specifier,
});

const context = ({ withEdge = true } = {}) => ({
  root: "/ws",
  provider: "native",
  marker: "archkeep.json",
  tracked: [],
  owned: ["libs/alpha/src/index.ts"],
  graph: {
    nodes,
    dependencies: withEdge ? { alpha: [{ source: "alpha", target: "beta", type: "static" }] } : {},
  },
  analysis: {
    analyzed: 2,
    analyzedFiles: [],
    imports: withEdge ? [site()] : [],
    failures: [],
  },
  pluginGap: { registered: true, manifests: [] },
  options: {},
  unownedGap: { files: [], languages: [] },
  unclaimedGap: { files: [] },
});

describe("diff ↔ delta — one change, two engines, agreeing introductions", () => {
  /** The baseline side each command reads, built for its own dialect. */
  const diffBaseline = () => ({
    projects: [
      { name: "alpha", root: "libs/alpha", type: "lib", tags: ["zone:x"] },
      { name: "beta", root: "libs/beta", type: "lib", tags: ["zone:y"] },
    ],
    dependencies: [],
    coverage: {
      complete: true,
      projects: 2,
      analyzedFiles: 1,
      imports: 0,
      notAnalyzed: [],
      blindSpots: [],
    },
    policy: null,
    provider: "native",
    provenance: null,
    toolVersion: null,
  });
  const deltaBaseline = () =>
    JSON.parse(
      serializeEvidenceSnapshot(
        buildEvidenceSnapshot({
          tool: { name: "archkeep", version: "0.0.0-test" },
          provenance: { commit: "c1", remote: null, dirty: false },
          provider: "native",
          policyFingerprint: "fp-1",
          coverage: { complete: true, analyzedFiles: 1, notAnalyzed: [], blindSpots: [] },
          graph: { nodes, dependencies: {} },
          records: [],
        }),
      ),
    );

  const identity = (messageId, source, target) => `${messageId}|${source}->${target}`;

  it("both faces report exactly the same introduced tag violation", async () => {
    const ctx = context();
    const law = config();

    const diff = await diffCommand("baseline.json", ctx, {
      readBaseline: diffBaseline,
      config: law,
    });
    const delta = await deltaCommand("evidence.json", ctx, {
      readBaseline: deltaBaseline,
      config: law,
      now: NOW,
    });

    const introducedByDiff = (diff.diff.ruleImpact?.introduced ?? []).map((v) =>
      identity(v.messageId, v.source, v.target),
    );
    const introducedTaggedByDelta = delta.delta.violations.introduced
      .filter((v) => EDGE_MESSAGE_IDS.has(v.messageId))
      .map((v) => identity(v.messageId, v.sourceProject ?? "", v.target));

    // Both non-empty first: two empty arrays would also compare equal.
    expect(introducedByDiff.length).toBeGreaterThan(0);
    expect(introducedTaggedByDelta.length).toBeGreaterThan(0);
    expect(introducedTaggedByDelta.sort()).toEqual([...introducedByDiff].sort());
  });

  it("the narrowing is the documented one — diff sees only edge constraints", async () => {
    const ctx = context();
    const law = config();
    const relative = site({ specifier: "../../beta/src/index.ts", relative: true });
    const relativeCtx = {
      ...ctx,
      analysis: { ...ctx.analysis, imports: [relative] },
    };

    const diff = await diffCommand("baseline.json", relativeCtx, {
      readBaseline: diffBaseline,
      config: law,
    });
    const delta = await deltaCommand("evidence.json", relativeCtx, {
      readBaseline: deltaBaseline,
      config: law,
      now: NOW,
    });

    // The relative-path crossing is invisible to edge constraints but real to
    // the full engine — delta reports it, and diff deliberately does not:
    expect(
      delta.delta.violations.introduced.some(
        (v) => v.messageId !== undefined && !EDGE_MESSAGE_IDS.has(v.messageId),
      ),
    ).toBe(true);
    expect(
      (diff.diff.ruleImpact?.introduced ?? []).every((v) => EDGE_MESSAGE_IDS.has(v.messageId)),
    ).toBe(true);
  });

  it("a clean head reads clean on BOTH faces — neither invents an introduction", async () => {
    const ctx = context({ withEdge: false });
    const law = config();

    const diff = await diffCommand("baseline.json", ctx, {
      readBaseline: () => ({ ...diffBaseline(), projects: diffBaseline().projects }),
      config: law,
    });
    const delta = await deltaCommand("evidence.json", ctx, {
      readBaseline: deltaBaseline,
      config: law,
      now: NOW,
    });

    expect(diff.diff.ruleImpact?.introduced ?? []).toEqual([]);
    expect(delta.delta.violations.introduced).toEqual([]);
    expect(delta.status).toBe("ok");
  });
});

describe("report ↔ its sections' commands — composed, never re-derived", () => {
  /** One active waiver covering nothing yet, plus the live violation context. */
  const lawWithWaiver = () =>
    config({
      suppressions: [
        {
          path: "libs/alpha/**",
          reason: "known debt until refactor",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      ],
    });

  it("the metrics ARE health's metrics, verbatim", async () => {
    const ctx = context();
    const law = lawWithWaiver();

    const health = healthCommand(ctx, { config: law, intent: null, trendDir: null });
    const report = await reportCommand(ctx, {
      config: law,
      intent: null,
      trendDir: null,
      now: NOW,
    });

    expect(report.result.metrics).toEqual(health.metrics);
    expect(report.result.trends).toEqual(health.trends);
  });

  it("the waiver counts ARE waivers' counts over the same law and clock", async () => {
    const ctx = context();
    const law = lawWithWaiver();

    const surface = await waiversCommand(ctx, law, { now: NOW });
    const report = await reportCommand(ctx, {
      config: law,
      intent: null,
      trendDir: null,
      now: NOW,
    });

    expect(report.result.waivers.verdict).toBe("ok");
    expect(report.result.waivers.counts).toEqual({
      waivers: surface.waivers.waivers.length,
      covered: surface.waivers.covered,
      expired: surface.waivers.expired,
      stale: surface.waivers.stale,
      suppressions: surface.waivers.suppressions.length,
      suppressed: surface.waivers.suppressed,
    });
    // Row-for-row: what the document prints, the command answers too.
    const standaloneRows = [
      ...surface.waivers.waivers.map((row) => ({ path: row.path, covered: row.covered })),
      ...surface.waivers.suppressions.map((row) => ({ path: row.path, covered: row.covered })),
    ].sort((a, b) => (a.path < b.path ? -1 : 1));
    const documentRows = report.result.waivers.rows
      .map((row) => ({ path: row.path, covered: row.covered }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(documentRows).toEqual(standaloneRows);
  });

  it("no declared fitness functions → the document says not_applicable, like fitness would", async () => {
    const ctx = context();
    const law = lawWithWaiver();
    const report = await reportCommand(ctx, {
      config: law,
      intent: null,
      trendDir: null,
      now: NOW,
    });
    expect(report.result.fitness.verdict).toBe("not_applicable");
  });

  it("an uninspectable surface holds the whole document back — never a partial verdict", async () => {
    // Waivers refuses on whole-file failures; the document must carry that
    // refusal as an uninspectable surface, not silently drop the section.
    const ctx = context();
    ctx.analysis.failures = [
      { sourceFile: "libs/alpha/src/broken.go", line: null, column: null, reason: "unreadable" },
    ];
    const report = await reportCommand(ctx, {
      config: lawWithWaiver(),
      intent: null,
      trendDir: null,
      now: NOW,
    });

    expect(report.status).toBe("no-verdict");
    expect(report.result.uninspectable.map((entry) => entry.surface)).toContain("waivers");
  });
});

describe("impact ↔ context --plan — one blast-radius computation", () => {
  const diamond = {
    nodes: {
      core: { name: "core", type: "lib", data: { root: "libs/core", tags: [] } },
      beta: { name: "beta", type: "lib", data: { root: "libs/beta", tags: [] } },
      gamma: { name: "gamma", type: "lib", data: { root: "libs/gamma", tags: [] } },
      shell: { name: "shell", type: "lib", data: { root: "apps/shell", tags: [] } },
    },
    dependencies: {
      beta: [{ source: "beta", target: "core", type: "static" }],
      gamma: [{ source: "gamma", target: "core", type: "static" }],
      shell: [
        { source: "shell", target: "beta", type: "static" },
        { source: "shell", target: "gamma", type: "static" },
      ],
    },
  };

  it("plan mode's impact entries equal computeImpact under the cap", () => {
    const planned = collectImpact("core", [], diamond);
    expect(planned).toHaveLength(1);

    const direct = computeImpact("core", diamond);
    expect(planned[0].direct).toEqual(direct.direct);
    expect(planned[0].transitive).toEqual(direct.transitive);
    expect(planned[0].dependents).toEqual(direct.dependents);
    expect(planned[0].dependentsTotal).toBe(direct.dependents.length);
    expect(planned[0].hasMore).toBe(false);
  });

  it("the diamond reaches every dependent exactly once, on both faces", () => {
    const direct = computeImpact("core", diamond);
    expect(direct.dependents).toEqual(["beta", "gamma", "shell"]);
    expect(direct.transitive).toEqual(["shell"]);

    const scoped = collectImpact("core", ["beta"], diamond);
    expect(scoped.map((entry) => entry.project)).toEqual(["beta", "core"]);
    for (const entry of scoped) {
      const expected = computeImpact(entry.project, diamond);
      expect(entry.dependents).toEqual(expected.dependents);
    }
  });
});

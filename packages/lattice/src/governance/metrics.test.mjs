import { describe, expect, it } from "vitest";

import { suppressionCovers } from "../config.mjs";
import {
  boundaryMetrics,
  couplingMetrics,
  debtMetric,
  intentMetric,
  structuralMetrics,
} from "./metrics.mjs";

/**
 * The metrics unit surface. Every function is a pure function of records the
 * run already holds, so these tests hand it records — no filesystem, no clock.
 * The invariant under test is the module's own header: **a metric whose
 * evidence is unavailable is `unknown` or `not_applicable` — reading it as
 * zero is the error.** That is why a `not_applicable`/`unknown` metric must
 * carry `value: undefined`, and every case that asserts a measured count
 * asserts the evidence was complete.
 */

/** A `project` record in the shape `buildProjects` emits. */
const project = (name, { type = "lib", root = `libs/${name}`, tags = [] } = {}) => ({
  name,
  root,
  type,
  tags,
});

/** A full-coverage envelope. */
const coarse = (overrides = {}) => ({
  complete: true,
  projects: 2,
  analyzedFiles: 2,
  imports: 1,
  notAnalyzed: [],
  blindSpots: [],
  notes: [],
  ...overrides,
});

describe("structuralMetrics", () => {
  it("reports ok with the measured counts over complete evidence", () => {
    const model = { projects: [project("a"), project("b")], edges: [] };
    const result = structuralMetrics(model, coarse());
    expect(result.projects).toEqual({ verdict: "ok", value: 2 });
    expect(result.edges).toEqual({ verdict: "ok", value: 0 });
    expect(result.coverage).toEqual({ verdict: "ok", value: 0 });
  });

  it("reads unknown (never zero) when whole-file failures made the tree partial", () => {
    const result = structuralMetrics(
      { projects: [project("a")], edges: [] },
      coarse({
        complete: false,
        analyzedFiles: 1,
        notAnalyzed: [{ file: "libs/b/src/index.ts", reason: "parse error" }],
      }),
    );
    expect(result.projects.verdict).toBe("unknown");
    expect(result.projects.value).toBeUndefined();
    // The ratio 1/2 is measured, and its finding is that half the tree was
    // unread — the number behind the finding, not a folded-down zero.
    expect(result.coverage.verdict).toBe("findings");
    expect(result.coverage.value).toBe(0.5);
  });

  it("reads coverage unknown when no analyzable file was examined — a clean 1 would be a false claim", () => {
    const result = structuralMetrics(
      { projects: [], edges: [] },
      coarse({ complete: false, analyzedFiles: 0 }),
    );
    expect(result.coverage.verdict).toBe("unknown");
    expect(result.coverage.value).toBeUndefined();
  });

  it("keeps edges unknown when the graph's edges are incomplete even over complete files", () => {
    // The unregistered-plugin state: files read fully, but no polyglot edge
    // drawn. The edges metric must not read as a measured zero.
    const result = structuralMetrics({ projects: [project("a")], edges: [] }, coarse(), false);
    expect(result.edges.verdict).toBe("unknown");
    expect(result.edges.value).toBeUndefined();
    // The file-level coverage is still complete and measured.
    expect(result.projects.verdict).toBe("ok");
  });

  it("reports a coverage fraction under 1 as findings", () => {
    const result = structuralMetrics(
      { projects: [project("a")], edges: [] },
      coarse({ analyzedFiles: 2, notAnalyzed: [{ file: "b", reason: "no analyzer" }] }),
    );
    // 2/(2+1) < 1 → not full coverage → findings, with the ratio behind it.
    expect(result.coverage.verdict).toBe("findings");
    expect(result.coverage.value).toBe(2 / 3);
  });
});

describe("boundaryMetrics", () => {
  /** A full boundary config in the `loadBoundaryConfig` shape — every option
   * stated, because the validator rejects a missing one rather than defaulting
   * it (`config.mjs`: a default would be a second copy of a value the file
   * states). The values are upstream's own defaults, so only the
   * `depConstraints` below decides what the engine reports. */
  /** @param {object[]} [suppressions] @param {string} [now] A reference instant
   * for waiver expiration — carried on `config.now`, the same field the rule
   * engine's `applySuppressions` reads. */
  const cfg = (suppressions = [], now) => ({
    ...(now === undefined ? {} : { now }),
    depConstraints: [],
    options: {
      allow: [],
      buildTargets: ["build"],
      enforceBuildableLibDependency: false,
      allowCircularSelfDependency: false,
      checkDynamicDependenciesExceptions: [],
      ignoredCircularDependencies: [],
      banTransitiveDependencies: false,
      checkNestedExternalImports: false,
    },
    suppressions,
  });

  /** The simplest site the raw engine provably reports — a relative path that
   * lands inside another project (the same fixture `rules/index.test.mjs` uses
   * for `noRelativeOrAbsoluteImportsAcrossLibraries`). */
  const site = (sourceFile = "area/alpha/src/index.ts") => ({
    sourceFile,
    line: 3,
    column: 1,
    kind: "static",
    spelling: { path: true, relative: true },
    specifier: "../../beta/src/thing",
    resolved: {
      target: "beta",
      file: "area/beta/src/thing.ts",
      external: false,
      packageName: null,
    },
  });

  const graph = {
    nodes: {
      alpha: { name: "alpha", type: "lib", data: { root: "area/alpha", tags: ["scope:x"] } },
      beta: { name: "beta", type: "lib", data: { root: "area/beta", tags: ["scope:y"] } },
    },
    dependencies: {},
  };

  it("reports not_applicable — without a number — when the workspace has no boundary config", () => {
    const result = boundaryMetrics([site()], graph, null, coarse());
    expect(result.violations).toEqual({
      verdict: "not_applicable",
      note: "no boundary config; there is no law to judge against",
    });
    expect(result.violations.value).toBeUndefined();
    expect(result.waiverSurface).toMatchObject({ verdict: "not_applicable" });
    expect(result.waiverSurface.value).toBeUndefined();
  });

  it("reads unknown when a whole-file failure prevents a verdict — never zero", () => {
    const result = boundaryMetrics(
      [site(), site("libs/broken/src/index.ts")],
      graph,
      cfg(),
      coarse({
        complete: false,
        notAnalyzed: [{ file: "libs/broken/src/index.ts", reason: "parse error" }],
      }),
    );
    expect(result.violations).toEqual({
      verdict: "unknown",
      note: "the boundary could not be fully inspected",
    });
    expect(result.violations.value).toBeUndefined();
  });

  it("measures violations as raws minus suppressed", () => {
    const result = boundaryMetrics([site()], graph, cfg(), coarse());
    // The directory-crossing site is a violation; no suppression covers it.
    expect(result.violations).toEqual({ verdict: "findings", value: 1 });
  });

  it("measures the waiver surface as the suppressed count — a waived law is a fact on the books", () => {
    // Suppress the crossing at the exact file that crosses.
    const suppressions = [
      { path: "area/alpha/src/index.ts", reason: "legacy adapter, queued for extraction" },
    ];
    const result = boundaryMetrics([site()], graph, cfg(suppressions), coarse());
    expect(result.violations).toEqual({ verdict: "ok", value: 0 });
    expect(result.waiverSurface).toEqual({ verdict: "ok", value: 1 });
    expect(result.underWavedCount).toBe(1);
  });

  it("re-asserts an expired waiver — the metrics never write the boundary clean while the gate is live (F02)", () => {
    // A waiver that lapsed covers nothing: `suppressionCovers` alone matches
    // path+id and would have LEFT this violation in the waived bucket, so
    // `health`/`debt` reported the boundary "still suppressed" while `check`
    // was re-asserting the same row (evidence "expired waiver"). The metrics
    // must apply `suppressionFate` — an expired waiver is a live violation.
    const expired = {
      path: "area/alpha/src/index.ts",
      reason: "was true last quarter",
      expiresAt: "2026-01-01T00:00:00.000Z",
    };
    const now = "2026-08-19T00:00:00.000Z";
    const result = boundaryMetrics([site()], graph, cfg([expired], now), coarse());
    expect(result.violations).toEqual({ verdict: "findings", value: 1 });
    expect(result.waiverSurface).toEqual({ verdict: "ok", value: 0 });
    expect(result.underWavedCount).toBe(0);
  });

  it("counts an active waiver as waived — not re-asserted (the F02 complement)", () => {
    const active = {
      path: "area/alpha/src/index.ts",
      reason: "still under migration",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const now = "2026-08-19T00:00:00.000Z";
    const result = boundaryMetrics([site()], graph, cfg([active], now), coarse());
    expect(result.violations).toEqual({ verdict: "ok", value: 0 });
    expect(result.waiverSurface).toEqual({ verdict: "ok", value: 1 });
    expect(result.underWavedCount).toBe(1);
  });

  it("keeps waiverSurface ok-with-zero when no suppression covers anything", () => {
    const result = boundaryMetrics([site()], graph, cfg(), coarse());
    expect(result.waiverSurface).toEqual({ verdict: "ok", value: 0 });
  });

  it("counts a waived violation only when the suppression covers it", () => {
    const result = boundaryMetrics(
      [site()],
      graph,
      cfg([{ path: "libs/other/src/index.ts", reason: "does not touch the crossing file" }]),
      coarse(),
    );
    expect(result.violations).toEqual({ verdict: "findings", value: 1 });
    expect(result.waiverSurface).toEqual({ verdict: "ok", value: 0 });
  });

  it("applies suppressionCovers to the raw engine output — the same predicate evaluate uses", () => {
    const violating = { ...site(), messageId: "onlyTagsConstraintViolation" };
    const suppression = { path: "area/alpha/src/index.ts", reason: "waved" };
    expect(suppressionCovers(suppression, violating)).toBe(true);
  });
});

describe("intentMetric", () => {
  it("reports not_applicable when the workspace declares no intent — absence is a decision, not a gap", () => {
    const result = intentMetric(null);
    expect(result.verdict).toBe("not_applicable");
    expect(result.value).toBeUndefined();
  });

  it("reports ok when every row and boundary judged and held", () => {
    const result = intentMetric({ ok: true, findings: [], unresolved: [] });
    expect(result.verdict).toBe("ok");
    expect(result.value).toBe(0);
  });

  it("reports findings (with the found count) when intent is violated", () => {
    const result = intentMetric({
      ok: false,
      findings: [{ rule: "intentForbiddenEdge" }],
      unresolved: [],
    });
    expect(result.verdict).toBe("findings");
    expect(result.value).toBe(1);
  });

  it("reads unknown when a boundary matched no observed project — cannot verify is never clean", () => {
    const result = intentMetric({
      ok: false,
      findings: [],
      unresolved: [{ boundary: "packages", issue: "matches no observed project" }],
    });
    expect(result.verdict).toBe("unknown");
    expect(result.value).toBeUndefined();
  });
});

describe("couplingMetrics", () => {
  it("reports not_applicable density and cycles with no projects", () => {
    const result = couplingMetrics([], [], coarse());
    expect(result.edgeDensity.verdict).toBe("not_applicable");
    expect(result.cycles.verdict).toBe("not_applicable");
    expect(result.edgeDensity.value).toBeUndefined();
    expect(result.cycles.value).toBeUndefined();
  });

  it("reports density as a description and cycles as ok over a clean acyclic graph", () => {
    const projects = [project("a"), project("b")];
    const edges = [{ source: "a", target: "b", type: "static" }];
    const result = couplingMetrics(projects, edges, coarse());
    expect(result.edgeDensity).toEqual({ verdict: "ok", value: 0.5 });
    expect(result.cycles).toEqual({ verdict: "ok", value: 0 });
  });

  it("counts a mutual-reach pair as one cycle", () => {
    const projects = [project("a"), project("b")];
    const edges = [
      { source: "a", target: "b", type: "static" },
      { source: "b", target: "a", type: "static" },
    ];
    const { cycles } = couplingMetrics(projects, edges, coarse());
    expect(cycles.verdict).toBe("findings");
    expect(cycles.value).toBe(1);
  });

  it("reads unknown — not a measured zero — when the graph could be incomplete", () => {
    const projects = [project("a"), project("b")];
    const edges = [{ source: "a", target: "b", type: "static" }];
    const result = couplingMetrics(projects, edges, coarse({ complete: false }));
    expect(result.cycles.verdict).toBe("unknown");
    expect(result.cycles.value).toBeUndefined();
    expect(result.edgeDensity.verdict).toBe("unknown");
  });
});

describe("debtMetric", () => {
  it("reports not_applicable without a config — no law, no ledger", () => {
    const result = debtMetric(null);
    expect(result.verdict).toBe("not_applicable");
    expect(result.value).toBeUndefined();
  });

  it("reports ok at zero notes — a config that owes no debt", () => {
    expect(debtMetric({ notes: [] })).toEqual({ verdict: "ok", value: 0 });
  });

  it("reports the deferred rows as findings", () => {
    const result = debtMetric({
      notes: ["temp: replace the glob with a real list", "migrate pkg"],
    });
    expect(result.verdict).toBe("findings");
    expect(result.value).toBe(2);
  });
});

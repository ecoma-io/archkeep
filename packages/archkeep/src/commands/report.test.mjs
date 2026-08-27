import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { reportCommand } from "./report.mjs";
import { ADR_DIR } from "../governance/adr-registry.mjs";

// `reportCommand` composes whole commands rather than reaching past them, so
// these tests drive the REAL `healthCommand`/`waiversCommand`/`fitnessCommand`
// and the real registry reader over an in-memory command context — the same
// posture `health.test.mjs` takes. Nothing here stubs a verdict: a test that
// injected the answer would pin the stub, and the whole point of this command
// is that its numbers come from the functions that own them.
//
// Every test below has a silent-direction case attached: the assertion that
// matters is not "the message says unknown", it is "the document did not
// report a clean zero over evidence the run could not inspect", and each one
// would go red if the surface degraded to an empty list instead.

/** Fixture trees this file creates, torn down after each test. */
const trees = [];

afterEach(() => {
  while (trees.length > 0) rmSync(trees.pop(), { recursive: true, force: true });
});

/**
 * A real directory to run against — needed only by the tests that exercise the
 * ADR registry, which reads `docs/adr/` from disk.
 *
 * @param {{adrs?: Record<string, string>, adrDirIsAFile?: boolean}} [shape]
 * @returns {string} The tree root.
 */
function tree(shape = {}) {
  const root = mkdtempSync(join(tmpdir(), "archkeep-report-"));
  trees.push(root);
  if (shape.adrDirIsAFile === true) {
    mkdirSync(join(root, "docs"), { recursive: true });
    // A `docs/adr` that is not a directory: `readdirSync` fails with ENOTDIR,
    // which is the "registry exists but cannot be read" class — distinct from
    // ENOENT, which is the legitimate "this workspace records no ADRs".
    writeFileSync(join(root, ADR_DIR), "not a directory\n");
    return root;
  }
  if (shape.adrs !== undefined) {
    mkdirSync(join(root, ADR_DIR), { recursive: true });
    for (const [name, text] of Object.entries(shape.adrs)) {
      writeFileSync(join(root, ADR_DIR, name), text);
    }
  }
  return root;
}

/**
 * The fixture record's filename, and the tracked path it lives at. Composed
 * from the registry's own ADR_DIR rather than written out: a literal
 * "docs/adr/…" here would be a second copy of that constant AND would read to
 * the doc-reference gate as a citation of a file this repository does not
 * have (it is a path inside a temporary fixture tree, not a document).
 */
const ADR_FILE = "0001-layering.md";
const ADR_TRACKED = `${ADR_DIR}/${ADR_FILE}`;

/** One accepted record binding a fitness id. */
const ADR_TEXT = [
  "---",
  "id: 0001-layering",
  "status: accepted",
  "bindings:",
  "  - no-cycles",
  "---",
  "",
  "# Layering",
  "",
].join("\n");

/**
 * A minimal command context in the shape `resolveCommandContext` produces —
 * two projects, one edge, clean analysis, nothing tracked.
 *
 * @param {object} [overrides]
 */
function context(overrides = {}) {
  return {
    root: "/workspace",
    provider: "native",
    marker: "archkeep.json",
    tracked: [],
    owned: [],
    graph: {
      nodes: {
        alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: ["type-package"] } },
        beta: { name: "beta", type: "lib", data: { root: "libs/beta", tags: ["type-package"] } },
      },
      dependencies: {
        alpha: [{ source: "alpha", target: "beta", type: "static" }],
      },
    },
    analysis: {
      analyzed: 4,
      analyzedFiles: [],
      imports: [],
      failures: [],
    },
    pluginGap: { registered: true, manifests: [] },
    options: { boundaryConfig: "module-boundaries.config.mjs", boundaryConfigDeclared: false },
    // The two unowned-file lists `resolveCommandContext` always carries —
    // empty here because these fixtures own no orphan files; `waiversCommand`
    // matches the policy's `coverage.unowned` rows against both
    // (`./coverage-acceptance.mjs`).
    unownedGap: { files: [], languages: [] },
    unclaimedGap: { files: [] },
    ...overrides,
  };
}

/** A boundary law in the `loadBoundaryConfig` shape — every option stated. */
function config(extra = {}) {
  return {
    depConstraints: [{ sourceTag: "*", onlyDependOnLibsWithTags: ["*"] }],
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
    suppressions: [],
    notes: [],
    ...extra,
  };
}

/** A bare intent model: one boundary, one allowed row already observed. */
function intent(overrides = {}) {
  return {
    version: "1",
    boundaries: [{ name: "packages", match: ["tag:type-package"] }],
    allowed: [{ from: "packages", to: "packages" }],
    forbidden: [],
    ...overrides,
  };
}

describe("reportCommand — the status contract", () => {
  it("reaches a verdict when every surface could be inspected", async () => {
    const result = await reportCommand(context(), { config: config(), intent: intent() });

    expect(result.status).toBe("ok");
    expect(result.result.uninspectable).toEqual([]);
    expect(result.report.text).toContain("every surface reached a verdict");
    // The closing block is unconditional: an empty one is itself the claim.
    expect(result.report.text).toContain("could not inspect");
    expect(result.report.text).toContain("nothing — every surface in this report reached");
  });

  it("never carries the findings status, even with a live violation", async () => {
    // A law that forbids the edge the graph actually has: `check` would exit 1
    // over this tree. The report describes it and stays descriptive — the
    // command that owns the finding owns its exit code.
    const violating = config({
      depConstraints: [{ sourceTag: "type-package", notDependOnLibsWithTags: ["type-package"] }],
    });
    const result = await reportCommand(
      context({
        analysis: {
          analyzed: 1,
          analyzedFiles: ["libs/alpha/a.ts"],
          imports: [
            {
              sourceFile: "libs/alpha/a.ts",
              line: 1,
              column: 1,
              specifier: "beta",
              resolvedProject: "beta",
              sourceProject: "alpha",
              spelling: { path: false, relative: false, namesOnly: false },
            },
          ],
          failures: [],
        },
      }),
      { config: violating },
    );

    // Descriptive: the status vocabulary here has no `findings` member at all.
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.report.json).exitCode).toBe(0);
    expect(JSON.parse(result.report.json).status).toBe("ok");
  });

  it("carries no decision field — a document's status is not the architecture's verdict", async () => {
    const result = await reportCommand(context(), { config: config() });
    // The envelope's decision must agree with its status, and this status is
    // about inspectability. A `pass` decision over a tree with findings would
    // be the disagreement the envelope exists to refuse.
    expect(JSON.parse(result.report.json)).not.toHaveProperty("decision");
  });
});

describe("reportCommand — an unknown metric is never a clean zero", () => {
  it("turns a whole-file analysis failure into a named no-verdict", async () => {
    const ctx = context();
    ctx.analysis.failures = [
      { sourceFile: "libs/beta/b.go", line: null, column: null, reason: "parse error" },
    ];

    const result = await reportCommand(ctx, { config: config(), intent: intent() });

    expect(result.status).toBe("no-verdict");
    expect(JSON.parse(result.report.json).exitCode).toBe(3);
    // The silent direction: the violations metric must NOT read as a measured
    // zero over a tree the run could not fully read.
    expect(result.result.metrics.violations.verdict).toBe("unknown");
    expect(result.result.metrics.violations.value).toBeUndefined();
    // And the document must NAME it, with the reason the metric itself wrote.
    expect(result.result.uninspectable).toContainEqual({
      surface: "metric:violations",
      reason: "the boundary could not be fully inspected",
    });
    expect(result.report.text).toContain("metric:violations: the boundary could not be");
    expect(result.report.text).toContain("NO VERDICT");
    expect(result.report.text).not.toContain("every surface reached a verdict");
  });

  it("renders the unknown metric with no number beside it", async () => {
    const ctx = context();
    ctx.analysis.failures = [
      { sourceFile: "libs/beta/b.go", line: null, column: null, reason: "parse error" },
    ];
    const result = await reportCommand(ctx, { config: config() });
    // A metric line for an unknown metric carries the verdict word and the
    // note, never a count a reader could take for a measurement.
    expect(result.report.text).toMatch(/unknown\s+violations\s+\(the boundary could not/u);
    expect(result.report.text).not.toMatch(/unknown\s+violations\s+0/u);
  });
});

describe("reportCommand — a surface that refuses is unknown, never empty", () => {
  it("names a waiver surface it could not read", async () => {
    // `waiversCommand` refuses over incomplete coverage: a waiver naming a
    // file the run never analyzed would read as covering nothing.
    const ctx = context();
    ctx.analysis.failures = [
      { sourceFile: "libs/beta/b.go", line: null, column: null, reason: "parse error" },
    ];

    const result = await reportCommand(ctx, { config: config() });

    expect(result.result.waivers.verdict).toBe("unknown");
    // The silent direction: an empty row list with an `ok` verdict would read
    // as "no waivers — every boundary is enforced".
    expect(result.result.waivers.counts).toBeNull();
    expect(result.result.uninspectable.map((u) => u.surface)).toContain("waivers");
    expect(result.report.text).toContain("unknown         waivers");
    expect(result.status).toBe("no-verdict");
  });

  it("distinguishes a workspace with no law from one whose law could not be read", async () => {
    const result = await reportCommand(context(), { config: null });

    // No law is `not_applicable` and says so — never a zero-waiver claim, and
    // never an `unknown` that would claim the tool tried and could not look.
    expect(result.result.waivers.verdict).toBe("not_applicable");
    expect(result.result.waivers.note).toContain("no boundary law is declared");
    expect(result.status).toBe("ok");
    expect(result.result.uninspectable).toEqual([]);
  });

  it("names a fitness gate it could not determine", async () => {
    // `layer-dependency` over a tag no project carries is the registry's own
    // `unknown` — the fact it needed is missing, so it must not read `pass`.
    const withFitness = config({
      fitness: [
        {
          name: "no-cycles",
          match: ["tag:type-package"],
          condition: { type: "layer-dependency", from: "layer-nothing", to: "layer-absent" },
        },
      ],
    });

    const result = await reportCommand(context(), { config: withFitness });

    expect(result.result.fitness.verdict).toBe("unknown");
    expect(result.status).toBe("no-verdict");
    expect(result.result.uninspectable.map((u) => u.surface)).toContain("fitness:no-cycles");
  });

  it("reports not_applicable — not pass — when the law declares no gates", async () => {
    const result = await reportCommand(context(), { config: config() });

    expect(result.result.fitness.verdict).toBe("not_applicable");
    expect(result.result.fitness.functions).toEqual([]);
    expect(result.result.fitness.note).toContain("declares no fitness functions");
    // A workspace that declared no gates has not passed anything.
    expect(result.report.text).not.toContain("pass            fitness gates");
    expect(result.status).toBe("ok");
  });
});

describe("reportCommand — decisions link a governed row to its record", () => {
  it("resolves a citation to the ADR that records it", async () => {
    const root = tree({ adrs: { [ADR_FILE]: ADR_TEXT } });
    const result = await reportCommand(context({ root, tracked: [ADR_TRACKED] }), {
      config: config({
        depConstraints: [
          { sourceTag: "*", onlyDependOnLibsWithTags: ["*"], decisionRef: "0001-layering" },
        ],
      }),
    });

    expect(result.result.decisions.verdict).toBe("ok");
    expect(result.result.decisions.citations).toEqual([
      {
        kind: "depConstraints[0]",
        label: "depConstraints[0] *",
        decisionRef: "0001-layering",
        resolution: "adr",
        adr: { id: "0001-layering", status: "accepted" },
      },
    ]);
    expect(result.report.text).toContain("0001-layering (accepted)");
    expect(result.status).toBe("ok");
  });

  it("reads an unresolved citation as unknown, never a pass", async () => {
    const root = tree({ adrs: { [ADR_FILE]: ADR_TEXT } });
    const result = await reportCommand(context({ root, tracked: [ADR_TRACKED] }), {
      config: config({
        depConstraints: [
          { sourceTag: "*", onlyDependOnLibsWithTags: ["*"], decisionRef: "0009-does-not-exist" },
        ],
      }),
    });

    // The silent direction: a citation naming nothing must not render as a
    // documented row, and must not leave the document claiming a verdict.
    expect(result.result.decisions.verdict).toBe("unknown");
    expect(result.result.decisions.citations[0].resolution).toBe("unknown");
    expect(result.result.decisions.citations[0].adr).toBeNull();
    expect(result.status).toBe("no-verdict");
    expect(result.result.uninspectable.map((u) => u.surface)).toContain(
      "decisionRef:depConstraints[0] *",
    );
    expect(result.report.text).toContain("does not resolve");
  });

  it("walks the intent table's citations too, not only the constraint table", async () => {
    // Both tables of governed rows carry `decisionRef`, and the document holds
    // both to the same standard — stricter than `check`, which resolves both
    // and gates only the intent half. A test over `depConstraints` alone would
    // not have noticed the intent walk going missing.
    const root = tree({ adrs: { [ADR_FILE]: ADR_TEXT } });
    const result = await reportCommand(context({ root, tracked: [ADR_TRACKED] }), {
      config: config(),
      intent: intent({
        forbidden: [{ from: "packages", to: "packages", decisionRef: "0009-does-not-exist" }],
        allowed: [{ from: "packages", to: "packages", decisionRef: "0001-layering" }],
      }),
    });

    const byLabel = Object.fromEntries(
      result.result.decisions.citations.map((c) => [c.label, c.resolution]),
    );
    expect(byLabel["allowed[0] packages→packages"]).toBe("adr");
    expect(byLabel["forbidden[0] packages→packages"]).toBe("unknown");
    expect(result.status).toBe("no-verdict");
    expect(result.result.uninspectable.map((u) => u.surface)).toContain(
      "decisionRef:forbidden[0] packages→packages",
    );
  });

  it("holds the document back even when every metric is fine", async () => {
    // The pure case: complete coverage, a clean law, and one citation that
    // resolves to nothing. Health alone would say `ok`; the document may not.
    const root = tree({ adrs: { [ADR_FILE]: ADR_TEXT } });
    const withBadRef = config({
      depConstraints: [{ sourceTag: "*", onlyDependOnLibsWithTags: ["*"], decisionRef: "typo" }],
    });
    const result = await reportCommand(context({ root, tracked: [ADR_TRACKED] }), {
      config: withBadRef,
    });

    expect(Object.values(result.result.metrics).some((m) => m.verdict === "unknown")).toBe(false);
    expect(result.status).toBe("no-verdict");
    expect(JSON.parse(result.report.json).exitCode).toBe(3);
  });

  it("does not let an empty registry mask a citation that resolved to nothing", async () => {
    // The workspace records no ADRs AND a constraint row cites one. Reading
    // that surface as `not_applicable` would state a true sentence ("records
    // no decisions") in place of the one that matters ("this citation names
    // nothing"), which is the not_applicable/unknown collapse the whole
    // verdict vocabulary exists to prevent.
    const result = await reportCommand(context({ root: tree() }), {
      config: config({
        depConstraints: [
          { sourceTag: "*", onlyDependOnLibsWithTags: ["*"], decisionRef: "0009-missing" },
        ],
      }),
    });

    expect(result.result.decisions.registry.count).toBe(0);
    expect(result.result.decisions.verdict).toBe("unknown");
    expect(result.result.decisions.note).toBeNull();
    expect(result.status).toBe("no-verdict");
    expect(result.report.text).not.toContain("not_applicable  decisions");
  });

  it("distinguishes an empty registry from one it could not read", async () => {
    const empty = await reportCommand(context({ root: tree() }), { config: config() });
    expect(empty.result.decisions.verdict).toBe("not_applicable");
    expect(empty.result.decisions.registry.count).toBe(0);
    expect(empty.status).toBe("ok");

    const unreadable = await reportCommand(context({ root: tree({ adrDirIsAFile: true }) }), {
      config: config(),
    });
    // "Could not read the registry" must never read as "no ADRs": the count is
    // null rather than 0, the verdict is unknown, and the run has no verdict.
    expect(unreadable.result.decisions.verdict).toBe("unknown");
    expect(unreadable.result.decisions.registry.count).toBeNull();
    expect(unreadable.result.decisions.records).toEqual([]);
    expect(unreadable.status).toBe("no-verdict");
    expect(unreadable.result.uninspectable.map((u) => u.surface)).toContain("decisions");
  });

  it("reports an unknown ADR link for a gate when the registry could not be read", async () => {
    const withFitness = config({
      fitness: [
        { name: "cycle-free", match: ["tag:type-package"], condition: { type: "cycle-free" } },
      ],
    });
    const result = await reportCommand(context({ root: tree({ adrDirIsAFile: true }) }), {
      config: withFitness,
    });

    // `null` (could not look) rather than `[]` (no decision binds it): the two
    // are different statements and the report must not collapse them.
    expect(result.result.fitness.functions[0].adrs).toBeNull();
    expect(result.report.text).toContain("bound by: unknown");
  });
});

describe("reportCommand — provenance", () => {
  it("states an unestablished origin without withholding the verdict", async () => {
    // No git in the fixture root: `resolveProvenance` answers null, which is a
    // legitimate no-origin claim — `provenance` and `adr` both exit 0 over it.
    const result = await reportCommand(context({ root: tree() }), { config: config() });

    expect(result.result.provenance.established).toBe(false);
    expect(result.result.provenance.repo).toEqual({ commit: null, remote: null, dirty: null });
    expect(result.report.text).toContain("repo provenance unavailable");
    expect(result.status).toBe("ok");
  });

  it("names the law that governed the run, and every unattested row", async () => {
    const result = await reportCommand(context(), {
      config: config(),
      intent: intent(),
      policySource: "module-boundaries.config.mjs",
    });

    expect(result.report.text).toContain("policy      module-boundaries.config.mjs");
    // An intent `allowed` row and a depConstraints row, neither carrying an
    // origin block: both are named rather than counted away.
    expect(result.result.provenance.rows.total).toBe(2);
    expect(result.result.provenance.rows.unattested).toHaveLength(2);
    expect(result.report.text).toContain("no origin recorded, cannot attest");
    // A documentation finding, not an uninspected surface: `provenance` exits
    // 0 over it and so does this.
    expect(result.status).toBe("ok");
  });
});

describe("reportCommand — determinism", () => {
  it("produces byte-identical text and JSON over unchanged inputs", async () => {
    const root = tree({ adrs: { [ADR_FILE]: ADR_TEXT } });
    const io = () => ({
      config: config({
        suppressions: [
          {
            path: "libs/alpha/**",
            messageId: "noCircularDependencies",
            reason: "scheduled for removal",
            expiresAt: "2999-01-01T00:00:00.000Z",
          },
        ],
        depConstraints: [
          { sourceTag: "*", onlyDependOnLibsWithTags: ["*"], decisionRef: "0001-layering" },
        ],
      }),
      intent: intent(),
      now: "2026-01-01T00:00:00.000Z",
    });
    const ctx = () => context({ root, tracked: [ADR_TRACKED] });

    const first = await reportCommand(ctx(), io());
    const second = await reportCommand(ctx(), io());

    expect(second.report.text).toBe(first.report.text);
    expect(second.report.json).toBe(first.report.json);
    // The one clock-dependent number `waivers` carries is deliberately not on
    // a row here: two runs a millisecond apart would otherwise differ. (The
    // word still appears once, in the coverage note that says so — which is
    // why this asserts over the rows rather than the whole document.)
    for (const row of first.result.waivers.rows) {
      expect(row).not.toHaveProperty("remainingMs");
    }
  });

  it("judges a waiver's term against the injected clock", async () => {
    const expiring = config({
      suppressions: [
        {
          path: "libs/alpha/**",
          messageId: "noCircularDependencies",
          reason: "scheduled for removal",
          expiresAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const before = await reportCommand(context(), {
      config: expiring,
      now: "2025-01-01T00:00:00.000Z",
    });
    const after = await reportCommand(context(), {
      config: expiring,
      now: "2027-01-01T00:00:00.000Z",
    });

    expect(before.result.waivers.rows[0].status).toBe("active");
    expect(after.result.waivers.rows[0].status).toBe("expired");
    expect(after.result.waivers.counts.expired).toBe(1);
    // An expired waiver is a fact on the table, not an uninspectable surface:
    // the boundary it names is being re-asserted, which `check` reports.
    expect(after.status).toBe("ok");
  });
});

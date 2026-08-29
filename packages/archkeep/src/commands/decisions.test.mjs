import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { decisionsCommand } from "./decisions.mjs";
import { ADR_DIR } from "../governance/adr-registry.mjs";

/**
 * `decisionsCommand` composes the real wave-2 modules over a real `docs/adr/`
 * tree — no registry override exists, so these fixtures write actual ADR
 * markdown to a temp tree, the same posture `report.test.mjs` takes. Nothing
 * here stubs a verdict: the chain, the fitness derivation, and the exit code
 * all come from the functions that own them.
 *
 * Every test carries the silent-direction case: the assertion that matters is
 * not "the message says unresolved", it is "an unresolved reference reports a
 * loud no-verdict result (exit 3), never a clean ok (exit 0) over evidence the
 * walk could not inspect".
 */

/** Fixture trees created by this file, torn down after each test. */
const trees = [];

/** root -> the tracked ADR paths written into that tree, for `tracked`. */
const trackedByRoot = new Map();

afterEach(() => {
  while (trees.length > 0) rmSync(trees.pop(), { recursive: true, force: true });
  trackedByRoot.clear();
});

/**
 * A real directory with a `docs/adr/` tree.
 *
 * @param {{adrs?: Record<string, string>, adrDirIsAFile?: boolean}} [shape]
 * @returns {string} The tree root.
 */
function tree(shape = {}) {
  const root = mkdtempSync(join(tmpdir(), "archkeep-decisions-"));
  trees.push(root);
  if (shape.adrDirIsAFile === true) {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, ADR_DIR), "not a directory\n");
    return root;
  }
  if (shape.adrs !== undefined) {
    mkdirSync(join(root, ADR_DIR), { recursive: true });
    const tracked = [];
    for (const [name, text] of Object.entries(shape.adrs)) {
      writeFileSync(join(root, ADR_DIR, name), text);
      tracked.push(`${ADR_DIR}/${name}`);
    }
    trackedByRoot.set(root, tracked);
  }
  return root;
}

/** One accepted ADR binding a fitness gate name. */
const NO_CYCLES_ADR = [
  "---",
  "id: 0001-layers",
  "status: accepted",
  "bindings:",
  "  - fitness:no-cycles",
  "---",
  "",
  "# Layers",
  "",
].join("\n");

/** One accepted ADR with no bindings — cited by intent rows only. */
const CITED_ADR = ["---", "id: 0001-layers", "status: accepted", "---", "", "# Layers", ""].join(
  "\n",
);

/** One superseded ADR, superseded by an active one — for the lineage test. */
const SUPERSEDED_ADR = [
  "---",
  "id: 0001-layers",
  "status: superseded",
  "bindings:",
  "  - fitness:no-cycles",
  "---",
  "",
  "# Layers",
  "",
].join("\n");

/** One active ADR binding a fitness gate, superseding 0001. */
const SUPERSEDE_ADR = [
  "---",
  "id: 0002-layers-v2",
  "status: active",
  "supersedes:",
  "  - 0001-layers",
  "bindings:",
  "  - fitness:no-cycles",
  "---",
  "",
  "# Layers v2",
  "",
].join("\n");

/** A minimal command context in the `resolveCommandContext` shape. */
function context(root, overrides = {}) {
  return {
    root,
    provider: "native",
    marker: "archkeep.json",
    tracked: trackedByRoot.get(root) ?? [],
    owned: [],
    graph: {
      nodes: {
        alpha: {
          name: "alpha",
          type: "lib",
          data: { root: "libs/alpha", tags: ["type-package", "scope-core"] },
        },
        beta: {
          name: "beta",
          type: "lib",
          data: { root: "libs/beta", tags: ["type-package", "scope-core"] },
        },
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
    unownedGap: { files: [], languages: [] },
    unclaimedGap: { files: [] },
    ...overrides,
  };
}

/** A boundary law in the `loadBoundaryConfig` shape, every option stated. */
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

/** A bare intent model; rows may carry the governance block. */
function intent(overrides = {}) {
  return {
    version: "1",
    boundaries: [{ name: "packages", match: ["tag:type-package"] }],
    allowed: [{ from: "packages", to: "packages" }],
    forbidden: [],
    ...overrides,
  };
}

describe("decisionsCommand — the chain", () => {
  it("walks a resolved chain: exit 0, ok status, complete coverage, text includes governs/evidence", () => {
    const root = tree({ adrs: { "0001-layers.md": NO_CYCLES_ADR } });
    const ctx = context(root);
    // A declared gate named "no-cycles" gives the fitness:no-cycles binding a
    // row id to resolve against.
    const law = config({
      fitness: [
        {
          name: "no-cycles",
          match: ["*"],
          condition: { type: "cycle-free" },
          reason: "keep it acyclic",
        },
      ],
    });
    const result = decisionsCommand("adr:0001-layers", ctx, law, { intent: intent() });

    expect(result.status).toBe("ok");
    expect(result.coverage.complete).toBe(true);
    expect(result.result.walk.ok).toBe(true);
    expect(result.result.walk.unresolved).toEqual([]);
    expect(JSON.parse(result.report.json).exitCode).toBe(0);

    // The intent allowed row resolves through its citation when it names the
    // decision; the fitness gate binds through its name.
    const ids = result.result.walk.nodes.map((n) => n.id);
    expect(ids).toContain("0001-layers");
    expect(ids).toContain("no-cycles");

    const text = result.report.text;
    expect(text).toContain("0001-layers  (accepted)");
    expect(text).toContain("fitness:");
    expect(text).toContain("governs:");
    expect(text).toContain("evidence:");
    expect(text).not.toContain("unresolved:");
  });

  it("resolves an intent row that cites the decision through its decisionRef", () => {
    const root = tree({ adrs: { "0001-layers.md": CITED_ADR } });
    const ctx = context(root);
    const law = config();
    const it = intent({
      forbidden: [{ from: "packages", to: "packages", decisionRef: "0001-layers" }],
    });
    const result = decisionsCommand("0001-layers", ctx, law, { intent: it });

    expect(result.status).toBe("ok");
    const ids = result.result.walk.nodes.map((n) => n.id);
    expect(ids).toContain("forbidden[0] packages→packages");
    // The row is reached by the decisionRef citation, and it governs both
    // tagged projects (alpha and beta).
    const row = result.result.walk.nodes.find((n) => n.id === "forbidden[0] packages→packages");
    expect(row).toBeDefined();
    const governed = result.result.walk.edges
      .filter((e) => e.kind === "governs" && e.from === row.id)
      .map((e) => e.to)
      .sort();
    expect(governed).toEqual(["alpha", "beta"]);
  });

  it("reports a dangling binding as no-verdict (exit 3) with the ref in notAnalyzed", () => {
    const root = tree({ adrs: { "0001-layers.md": NO_CYCLES_ADR } });
    const ctx = context(root);
    // No fitness gate declared, so `fitness:no-cycles` binds no row → the
    // walk cannot resolve that hop.
    const result = decisionsCommand("0001-layers", ctx, config(), { intent: null });

    expect(result.status).toBe("no-verdict");
    expect(result.coverage.complete).toBe(false);
    expect(JSON.parse(result.report.json).exitCode).toBe(3);
    expect(
      result.result.walk.unresolved.some(
        (u) => u.kind === "binding" && u.ref === "fitness:no-cycles",
      ),
    ).toBe(true);
    // The dangling binding rides into coverage.notAnalyzed, never a clean list.
    expect(result.coverage.notAnalyzed.some((n) => n.file === "fitness:no-cycles")).toBe(true);

    // The text renders the loud unresolved block.
    expect(result.report.text).toContain("unresolved:");
    expect(result.report.text).toContain('"fitness:no-cycles" is bound by 0001-layers');
  });

  it("derives unverifiable fitness for a binding that names no declared gate", () => {
    const root = tree({ adrs: { "0001-layers.md": NO_CYCLES_ADR } });
    const ctx = context(root);
    const result = decisionsCommand("0001-layers", ctx, config(), { intent: null });
    expect(result.result.fitness).toMatchObject({
      id: "0001-layers",
      status: "accepted",
      level: "unverifiable",
      verified: false,
    });
  });

  it("overrides fitness verdicts via io for determinism", () => {
    const root = tree({ adrs: { "0001-layers.md": NO_CYCLES_ADR } });
    const ctx = context(root);
    const result = decisionsCommand("0001-layers", ctx, config(), {
      intent: null,
      fitnessVerdicts: [{ name: "no-cycles", verdict: "pass" }],
    });
    // `no-cycles` now resolves to a pass → enforced/verified.
    expect(result.result.fitness).toMatchObject({
      level: "enforced",
      verified: true,
    });
  });

  it("reports an unknown id as no-verdict (exit 3) with a decision-kind unresolved ref", () => {
    const root = tree({ adrs: { "0001-layers.md": NO_CYCLES_ADR } });
    const ctx = context(root);
    const result = decisionsCommand("9999-missing", ctx, config(), { intent: null });

    expect(result.status).toBe("no-verdict");
    expect(JSON.parse(result.report.json).exitCode).toBe(3);
    expect(
      result.result.walk.unresolved.some((u) => u.kind === "decision" && u.ref === "9999-missing"),
    ).toBe(true);
    expect(result.coverage.notAnalyzed.some((n) => n.file === "9999-missing.md")).toBe(true);
    expect(result.report.text).toContain("unresolved:");
  });

  it("accepts the adr: spelling of an existing id", () => {
    const root = tree({ adrs: { "0001-layers.md": NO_CYCLES_ADR } });
    const ctx = context(root);
    const law = config({
      fitness: [
        { name: "no-cycles", match: ["*"], condition: { type: "cycle-free" }, reason: "r" },
      ],
    });
    const result = decisionsCommand("adr:0001-layers", ctx, law, { intent: null });
    expect(result.status).toBe("ok");
    expect(result.result.decisionId).toBe("adr:0001-layers");
    expect(result.result.record.id).toBe("0001-layers");
  });

  it("derives supersededBy and sorts knownFitness", () => {
    const root = tree({
      adrs: {
        "0001-layers.md": SUPERSEDED_ADR,
        "0002-layers-v2.md": SUPERSEDE_ADR,
      },
    });
    const ctx = context(root);
    const law = config({
      fitness: [
        { name: "no-cycles", match: ["*"], condition: { type: "cycle-free" }, reason: "r" },
        { name: "no-drift", match: ["*"], condition: { type: "drift-free" }, reason: "r" },
      ],
    });
    const result = decisionsCommand("0001-layers", ctx, law, { intent: null });

    // 0001 is superseded by 0002.
    expect(result.result.record.supersededBy).toEqual(["0002-layers-v2"]);
    // knownFitness is the sorted set of binding ids across records, as
    // written (the `fitness:` prefix is stripped only at resolution time).
    expect(result.result.knownFitness).toEqual(["fitness:no-cycles"]);
  });

  it("never carries a top-level decision field in the envelope", () => {
    const root = tree({ adrs: { "0001-layers.md": NO_CYCLES_ADR } });
    const ctx = context(root);
    const law = config({
      fitness: [
        { name: "no-cycles", match: ["*"], condition: { type: "cycle-free" }, reason: "r" },
      ],
    });
    const result = decisionsCommand("0001-layers", ctx, law, { intent: null });
    const envelope = JSON.parse(result.report.json);
    expect("decision" in envelope).toBe(false);
    // The shape the wave-2 contract owns.
    expect(envelope.command).toBe("decisions");
    expect(envelope.result.decisionId).toBe("0001-layers");
  });

  it("throws on an unreadable registry — never a clean result", () => {
    const root = tree({ adrDirIsAFile: true });
    const ctx = context(root);
    expect(() => decisionsCommand("0001-layers", ctx, config(), { intent: null })).toThrow();
  });
});

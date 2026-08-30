import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { explainCommand } from "../commands/explain.mjs";
import { ADR_DIR } from "./adr-registry.mjs";
import { computeAffectedDecisions, detectDecisionChange } from "./decision-lineage.mjs";

/**
 * The Decision Governance wiring (Wave 3 §9): `computeAffectedDecisions`
 * resolves which recorded decisions govern a run's affected ids (and never
 * drops an unresolved citation), and `detectDecisionChange` answers whether
 * the decision lineage moved between two registry states — DECISION_CHANGE,
 * never DRIFT, and never asserted without both sides. The silent direction
 * this suite exists to pin: a one-sided comparison must NOT read as "no
 * decision changed", and an unresolved decisionRef must NOT read as clean —
 * both disclosures are asserted, byte-for-byte, or the test goes red.
 */

// ---------------------------------------------------------------------------
// Fixtures: in-memory registries (the `loadAdrRegistry` result shape) and
// on-disk ADR trees for the `explain` seam's head-registry read.
// ---------------------------------------------------------------------------

/** A registry as `loadAdrRegistry` returns it. */
function registryOf(entries) {
  return { records: entries, byId: new Map(entries.map((entry) => [entry.id, entry])) };
}

/** One accepted ADR binding a fitness gate — replaced at head. */
function ACCEPTED_ADR(overrides = {}) {
  return {
    id: "0001-layers",
    status: "accepted",
    supersedes: [],
    supersededBy: [],
    bindings: ["fitness:no-cycles"],
    ...overrides,
  };
}

/** The head's replacement: active, superseding 0001-layers. */
function ACTIVE_SUCCESSOR_ADR(overrides = {}) {
  return {
    id: "0002-active-layers",
    status: "active",
    supersedes: ["0001-layers"],
    supersededBy: [],
    bindings: ["fitness:no-cycles"],
    ...overrides,
  };
}

/** The base registry (before the supersession). */
function BASE_REGISTRY() {
  return registryOf([ACCEPTED_ADR()]);
}

/** The head registry (after the supersession) — the derived reverse link
 * (`supersededBy`) carried the way `loadAdrRegistry`'s `validateLineage`
 * derives it on every record. */
function HEAD_REGISTRY() {
  return registryOf([
    ACCEPTED_ADR({ status: "superseded", supersededBy: ["0002-active-layers"] }),
    ACTIVE_SUCCESSOR_ADR(),
  ]);
}

const trees = [];

/** A real tree under /tmp with `docs/adr/` holding the given record files. */
function treeWithAdrs(adrs) {
  const root = mkdtempSync(join(tmpdir(), "archkeep-decision-wiring-"));
  trees.push(root);
  mkdirSync(join(root, ADR_DIR), { recursive: true });
  for (const [name, text] of Object.entries(adrs)) {
    writeFileSync(join(root, ADR_DIR, name), text);
  }
  return root;
}

/** The head state as real ADR files (the same facts `HEAD_REGISTRY` holds). */
function headAdrFiles() {
  return {
    "0001-layers.md": [
      "---",
      "id: 0001-layers",
      "status: superseded",
      "bindings:",
      "  - fitness:no-cycles",
      "---",
      "",
      "# Layers",
      "",
    ].join("\n"),
    "0002-active-layers.md": [
      "---",
      "id: 0002-active-layers",
      "status: active",
      "supersedes:",
      "  - 0001-layers",
      "---",
      "",
      "# Active layers",
      "",
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// computeAffectedDecisions
// ---------------------------------------------------------------------------

describe("computeAffectedDecisions", () => {
  it("maps affected constraint/fitness ids to the ADRs binding them, in registry order", () => {
    const result = computeAffectedDecisions(
      HEAD_REGISTRY(),
      [{ id: "fitness:no-cycles", decisionRef: "0002-active-layers" }],
      [{ id: "constraint[0]", decisionRef: "0001-layers" }],
    );
    // Both rows name ids the registry's records bind — the fitness id directly
    // (0001 and 0002 both bind fitness:no-cycles, registry order) and the
    // constraint label through the two resolved ADRs' bindings.
    expect(result.lineage).toEqual([
      {
        id: "fitness:no-cycles",
        adrs: ["0001-layers", "0002-active-layers"],
        decisionRef: "0002-active-layers",
        resolution: "adr",
        record: {
          id: "0002-active-layers",
          status: "active",
          authority: true,
          supersedes: ["0001-layers"],
          supersededBy: [],
        },
      },
      {
        id: "constraint[0]",
        adrs: [],
        decisionRef: "0001-layers",
        resolution: "adr",
        record: {
          id: "0001-layers",
          status: "superseded",
          authority: false,
          supersedes: [],
          supersededBy: ["0002-active-layers"],
        },
      },
    ]);
    // `decisions` = the union of binding ADRs and adr-resolutions, sorted.
    expect(result.decisions).toEqual(["0001-layers", "0002-active-layers"]);
    expect(result.unresolvedNote).toBeUndefined();
  });

  it("resolves a decisionRef naming a registry-bound fitness id as 'fitness'", () => {
    const result = computeAffectedDecisions(
      registryOf([ACCEPTED_ADR()]),
      [{ id: "fitness:no-cycles", decisionRef: "fitness:no-cycles" }],
      [],
    );
    expect(result.lineage[0].resolution).toBe("fitness");
    expect(result.lineage[0].adrs).toEqual(["0001-layers"]);
    expect(result.unresolvedNote).toBeUndefined();
  });

  it("a row without a decisionRef resolves 'none' with its binding ADRs intact", () => {
    const result = computeAffectedDecisions(
      registryOf([ACCEPTED_ADR()]),
      [{ id: "fitness:no-cycles" }],
      [{ id: "constraint[0]" }],
    );
    expect(result.lineage.map((entry) => entry.resolution)).toEqual(["none", "none"]);
    expect(result.lineage[0].adrs).toEqual(["0001-layers"]);
  });

  it("SILENT DIRECTION — an unresolved decisionRef surfaces in the lineage AND the note, never dropped", () => {
    const result = computeAffectedDecisions(
      BASE_REGISTRY(),
      [{ id: "fitness:no-cycles", decisionRef: "0009-ghost" }],
      [],
    );
    expect(result.lineage[0].resolution).toBe("unknown");
    expect(result.lineage[0].reason).toContain("does not resolve");
    // The note names the ref — a run that dropped the citation would have no
    // note, and this assertion would go red.
    expect(result.unresolvedNote).toBe(
      'unresolved decisionRefs: "0009-ghost" — no matching ADR, rule, or fitness record',
    );
  });

  it("an absent registry binds nothing and every citation resolves unknown, disclosed", () => {
    const result = computeAffectedDecisions(
      null,
      [{ id: "hotspot", decisionRef: "0001-layers" }],
      [{ id: "constraint[0]" }],
    );
    expect(result.decisions).toEqual([]);
    expect(result.lineage[0].adrs).toEqual([]);
    expect(result.lineage[0].resolution).toBe("unknown");
    expect(result.lineage[1].resolution).toBe("none");
    expect(result.unresolvedNote).toContain('"0001-layers"');
  });

  it("dedupes and sorts governing decisions across rows carrying the same ADR", () => {
    const result = computeAffectedDecisions(
      HEAD_REGISTRY(),
      [{ id: "fitness:no-cycles", decisionRef: "0002-active-layers" }],
      [{ id: "constraint[1]", decisionRef: "0002-active-layers" }],
    );
    expect(result.decisions).toEqual(["0001-layers", "0002-active-layers"]);
  });

  it("is deterministic — two runs over the same input produce identical results", () => {
    const call = () =>
      computeAffectedDecisions(
        HEAD_REGISTRY(),
        [{ id: "fitness:no-cycles" }],
        [{ id: "constraint[0]" }],
      );
    expect(call()).toEqual(call());
  });
});

// ---------------------------------------------------------------------------
// detectDecisionChange
// ---------------------------------------------------------------------------

describe("detectDecisionChange", () => {
  it("supersedes when the same ADR id carries a different status between base and head", () => {
    const result = detectDecisionChange(BASE_REGISTRY(), HEAD_REGISTRY());
    expect(result.superseded).toBe(true);
    expect(result.notes).toEqual([]);
  });

  it("supersedes when a new supersedes relation appears between base and head", () => {
    // Statuses identical; head only adds the successor relationship.
    const base = registryOf([ACCEPTED_ADR()]);
    const head = registryOf([ACCEPTED_ADR(), ACTIVE_SUCCESSOR_ADR()]);
    const result = detectDecisionChange(base, head);
    expect(result.superseded).toBe(true);
    expect(result.notes).toEqual([]);
  });

  it("reports no supersession for identical registry states, with no notes", () => {
    const result = detectDecisionChange(HEAD_REGISTRY(), HEAD_REGISTRY());
    expect(result.superseded).toBe(false);
    expect(result.notes).toEqual([]);
  });

  it("SILENT DIRECTION — a one-sided comparison (head absent) never asserts DECISION_CHANGE", () => {
    const result = detectDecisionChange(BASE_REGISTRY(), null);
    expect(result.superseded).toBe(false);
    expect(result.notes).toEqual([
      "decision lineage not comparable — both registry states required",
    ]);
  });

  it("SILENT DIRECTION — a one-sided comparison (base absent) never asserts DECISION_CHANGE", () => {
    const result = detectDecisionChange(undefined, HEAD_REGISTRY());
    expect(result.superseded).toBe(false);
    expect(result.notes).toEqual([
      "decision lineage not comparable — both registry states required",
    ]);
  });

  it("both registry states absent is comparable and unasserted — no note, no supersession", () => {
    const result = detectDecisionChange(undefined, null);
    expect(result.superseded).toBe(false);
    expect(result.notes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// explainCommand — the optional base-registry seam
// ---------------------------------------------------------------------------

describe("explainCommand decision lineage seam", () => {
  /** A minimal boundary config with one constraint row, no decisionRef. */
  function config() {
    return {
      depConstraints: [
        { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
      ],
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
    };
  }

  /** Minimal command context — root points at a real tree when told to. */
  function commandContext(root = "/workspace") {
    return {
      root,
      provider: "native",
      marker: "archkeep.json",
      graph: {
        nodes: {
          alpha: {
            name: "alpha",
            type: "lib",
            data: { root: "libs/alpha", tags: ["layer:domain"] },
          },
          beta: {
            name: "beta",
            type: "lib",
            data: { root: "libs/beta", tags: ["layer:util"] },
          },
        },
        dependencies: {
          alpha: [{ target: "beta", type: "static" }],
        },
      },
      analysis: {
        analyzed: 2,
        imports: [
          {
            sourceFile: "libs/alpha/main.go",
            line: 10,
            column: 5,
            specifier: "beta",
            kind: "static",
            spelling: { path: false, relative: false, namesOnly: false },
            resolved: { target: "beta", file: "libs/beta/mod.go", external: false },
          },
        ],
        failures: [],
      },
      pluginGap: { registered: true, manifests: [] },
    };
  }

  afterEach(() => {
    for (const root of trees) rmSync(root, { recursive: true, force: true });
    trees.length = 0;
  });

  it("changes no byte without the option — no decisionChange field, no rendered line", () => {
    const result = explainCommand("libs/alpha/main.go:10:5", commandContext(), config());
    expect(Object.hasOwn(result.explanation, "decisionChange")).toBe(false);
    expect(result.report.text).not.toContain("decisionChange");
    expect(result.report.json).not.toContain("decisionChange");
    // Deterministic: same fixture, same bytes.
    const again = explainCommand("libs/alpha/main.go:10:5", commandContext(), config());
    expect(result.report.text).toBe(again.report.text);
    expect(result.report.json).toBe(again.report.json);
  });

  it("surfaces a supersession between a supplied base registry and the workspace's current one", () => {
    const root = treeWithAdrs(headAdrFiles());
    const result = explainCommand("libs/alpha/main.go:10:5", commandContext(root), config(), {
      baseRegistry: BASE_REGISTRY(),
    });
    expect(result.explanation.decisionChange).toEqual({
      superseded: true,
      comparable: true,
      notes: [],
    });
    expect(result.report.text).toContain(
      "decisionChange  superseded — the decision lineage moved between the compared registry states",
    );
    const envelope = JSON.parse(result.report.json);
    expect(envelope.result.decisionChange).toEqual({
      superseded: true,
      comparable: true,
      notes: [],
    });
  });

  it("states 'did not move' when the compared states are identical — never silence", () => {
    const root = treeWithAdrs(headAdrFiles());
    const result = explainCommand("libs/alpha/main.go:10:5", commandContext(root), config(), {
      baseRegistry: HEAD_REGISTRY(),
    });
    expect(result.explanation.decisionChange).toEqual({
      superseded: false,
      comparable: true,
      notes: [],
    });
    expect(result.report.text).toContain(
      "decisionChange  none — the decision lineage did not move between the compared registry states",
    );
  });

  it("SILENT DIRECTION — a one-sided base renders 'could not compare', never a move or a no-move", () => {
    const root = treeWithAdrs(headAdrFiles());
    const result = explainCommand("libs/alpha/main.go:10:5", commandContext(root), config(), {
      baseRegistry: null,
    });
    expect(result.explanation.decisionChange).toEqual({
      superseded: false,
      comparable: false,
      notes: ["decision lineage not comparable — both registry states required"],
    });
    expect(result.report.text).toContain("decisionChange  could not compare");
    // The rendered text must claim neither a move nor a no-move: a reader of
    // the plain report sees the disclosure, not a fabricated fact about a side
    // the comparison never held (F-DEC-1).
    expect(result.report.text).not.toContain("superseded —");
    expect(result.report.text).not.toContain("did not move");
  });

  it("an unreadable head registry resolves nothing and says so", () => {
    const root = mkdtempSync(join(tmpdir(), "archkeep-decision-wiring-"));
    trees.push(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    // `docs/adr` as a FILE — not a directory — makes the registry read fail.
    writeFileSync(join(root, ADR_DIR), "not a directory\n");
    const result = explainCommand("libs/alpha/main.go:10:5", commandContext(root), config(), {
      baseRegistry: BASE_REGISTRY(),
    });
    expect(result.explanation.decisionChange.superseded).toBe(false);
    expect(result.explanation.decisionChange.comparable).toBe(false);
    expect(result.explanation.decisionChange.notes[0]).toContain(
      "the decision registry could not be read",
    );
    // The plain report says the comparison could not happen, never that the
    // lineage did not move (F-DEC-1).
    expect(result.report.text).toContain("decisionChange  could not compare");
    expect(result.report.text).not.toContain("did not move");
  });
});

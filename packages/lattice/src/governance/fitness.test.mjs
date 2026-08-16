import { describe, expect, it } from "vitest";

import { canonicalizeJson } from "../canonical.mjs";
import {
  CONDITION_TYPES,
  evaluateFitness,
  findFitnessViolations,
  fitnessSnapshot,
  fitnessVerdictFor,
  judgeFitnessRow,
} from "./fitness-registry.mjs";
import { VERDICTS, fitnessVerdict, isVerdict } from "./verdict.mjs";

/** A provider-neutral graph shaped like `resolveCommandContext` produces. */
function graph(nodes, dependencies = {}) {
  return {
    nodes: Object.fromEntries(
      nodes.map(([name, root, tags = []]) => [name, { name, data: { root, tags } }]),
    ),
    dependencies,
  };
}

describe("the E0 verdict contract", () => {
  it("names exactly four verdicts", () => {
    expect(VERDICTS).toEqual(["pass", "fail", "unknown", "not_applicable"]);
  });

  it("requires a not_applicable verdict to name its reason (I4)", () => {
    expect(() =>
      fitnessVerdict({ verdict: "not_applicable", name: "x", evidence: {}, message: "y" }),
    ).toThrow(/notApplicableReason/);
    expect(
      fitnessVerdict({
        verdict: "not_applicable",
        name: "x",
        evidence: {},
        notApplicableReason: "why",
        message: "y",
      }).notApplicableReason,
    ).toBe("why");
  });

  it("guards the four verdicts and amplifies a verdict record", () => {
    expect(isVerdict("pass")).toBe(true);
    expect(isVerdict("maybe")).toBe(false);
    const decision = fitnessVerdict({
      verdict: "fail",
      name: "cycle-free",
      evidence: { cycles: 2 },
      message: "cycle",
      rows: [{ source: "a", target: "b" }],
    });
    expect(decision).toEqual({
      verdict: "fail",
      name: "cycle-free",
      evidence: { cycles: 2 },
      message: "cycle",
      rows: [{ source: "a", target: "b" }],
    });
  });

  it("throws on a verdict outside the four", () => {
    expect(() =>
      fitnessVerdict({ verdict: "maybe", name: "x", evidence: {}, message: "y" }),
    ).toThrow(/expected one of/);
  });
});

describe("fitness row validation (findFitnessViolations)", () => {
  it("accepts a well-formed list", () => {
    expect(
      findFitnessViolations([
        {
          name: "no-cycles",
          match: ["*"],
          condition: { type: "cycle-free" },
          reason: "keep it acyclic",
        },
      ]),
    ).toEqual([]);
  });

  it("rejects a non-array or an empty array — the silent-direction guard", () => {
    expect(findFitnessViolations({})[0]).toMatch(/must be an array/);
    expect(findFitnessViolations([])[0]).toMatch(/must not be empty/);
  });

  it("rejects a duplicate name", () => {
    const violations = findFitnessViolations([
      { name: "same", match: ["*"], condition: { type: "cycle-free" }, reason: "a" },
      { name: "same", match: ["*"], condition: { type: "cycle-free" }, reason: "b" },
    ]);
    expect(violations.some((v) => /declared more than once/.test(v))).toBe(true);
  });

  it("rejects an unknown key and a missing reason", () => {
    const violations = findFitnessViolations([
      { name: "x", match: ["*"], condition: { type: "cycle-free" }, reason: "", nope: 1 },
    ]);
    expect(violations.some((v) => /unknown key/.test(v))).toBe(true);
    expect(violations.some((v) => /reason/.test(v))).toBe(true);
  });

  it("rejects an empty match and a bad name", () => {
    const violations = findFitnessViolations([
      { name: "bad:name", match: [], condition: { type: "cycle-free" }, reason: "r" },
    ]);
    expect(violations.some((v) => /name/.test(v))).toBe(true);
    expect(violations.some((v) => /match/.test(v))).toBe(true);
  });

  it("rejects an unknown condition type by name", () => {
    const violations = findFitnessViolations([
      { name: "x", match: ["*"], condition: { type: "ai-guess" }, reason: "r" },
    ]);
    expect(violations.some((v) => /must be one of/.test(v))).toBe(true);
  });

  it("rejects wrong condition fields per type", () => {
    const violations = findFitnessViolations([
      {
        name: "x",
        match: ["*"],
        condition: { type: "layer-dependency", from: "a", to: "b", direction: "sideways" },
        reason: "r",
      },
      {
        name: "y",
        match: ["*"],
        condition: { type: "tag-conformance", from: "p", to: "q", toDependents: "sometimes" },
        reason: "r",
      },
      {
        name: "z",
        match: ["*"],
        condition: { type: "coverage-minimum", statement: 150 },
        reason: "r",
      },
      {
        name: "w",
        match: ["*"],
        condition: { type: "boundary-suppression-count-within-threshold", max: -1 },
        reason: "r",
      },
    ]);
    expect(violations.join("\n")).toMatch(/direction/);
    expect(violations.join("\n")).toMatch(/toDependents/);
    expect(violations.join("\n")).toMatch(/statement/);
    expect(violations.join("\n")).toMatch(/max/);
  });
});

describe("judgeFitnessRow — cycle-free", () => {
  it("passes a cycle-free matched set", () => {
    const row = { name: "no-cycles", match: ["*"], condition: { type: "cycle-free" }, reason: "r" };
    const g = graph(
      [
        ["a", "libs/a"],
        ["b", "libs/b"],
      ],
      { a: [{ source: "a", target: "b", type: "static" }] },
    );
    const decision = judgeFitnessRow(row, g, {}, null, []);
    expect(decision.verdict).toBe("pass");
    expect(decision.evidence).toEqual({ projects: 2, cycles: 0 });
  });

  it("fails when the matched set contains a cycle", () => {
    const row = { name: "no-cycles", match: ["*"], condition: { type: "cycle-free" }, reason: "r" };
    const g = graph(
      [
        ["a", "libs/a"],
        ["b", "libs/b"],
      ],
      {
        a: [{ source: "a", target: "b", type: "static" }],
        b: [{ source: "b", target: "a", type: "static" }],
      },
    );
    const decision = judgeFitnessRow(row, g, {}, null, []);
    expect(decision.verdict).toBe("fail");
    expect(decision.evidence.cycles).toBeGreaterThan(0);
  });

  it("reports not_applicable loudly when match selects no project", () => {
    const row = {
      name: "no-cycles",
      match: ["name:ghost"],
      condition: { type: "cycle-free" },
      reason: "r",
    };
    const decision = judgeFitnessRow(row, graph([["a", "libs/a"]]), {}, null, []);
    expect(decision.verdict).toBe("not_applicable");
    expect(decision.notApplicableReason).toMatch(/selects no observed project/);
    expect(decision.message).toMatch(/declared but matches nothing/);
  });
});

describe("judgeFitnessRow — layer-dependency", () => {
  const rows = {
    forbidden: {
      name: "no-adapter-to-domain",
      match: ["*"],
      condition: {
        type: "layer-dependency",
        from: "layer-adapter",
        to: "layer-domain",
        direction: "forbidden",
      },
      reason: "r",
    },
    required: {
      name: "needs-domain",
      match: ["*"],
      condition: {
        type: "layer-dependency",
        from: "layer-service",
        to: "layer-domain",
        direction: "required",
      },
      reason: "r",
    },
  };
  const g = graph(
    [
      ["adapter", "apps/adapter", ["layer-adapter"]],
      ["domain", "libs/domain", ["layer-domain"]],
      ["service", "libs/service", ["layer-service"]],
    ],
    {
      adapter: [{ source: "adapter", target: "domain", type: "static" }],
      service: [{ source: "service", target: "domain", type: "static" }],
    },
  );

  it("fails a forbidden layer edge", () => {
    const d = judgeFitnessRow(rows.forbidden, g, {}, null, []);
    expect(d.verdict).toBe("fail");
    expect(d.evidence.edges).toBe(1);
  });

  it("passes a forbidden layer edge that does not exist", () => {
    const d = judgeFitnessRow(
      rows.forbidden,
      graph([
        ["adapter", "apps/adapter", ["layer-adapter"]],
        ["domain", "libs/domain", ["layer-domain"]],
      ]),
      {},
      null,
      [],
    );
    expect(d.verdict).toBe("pass");
    expect(d.evidence.edges).toBe(0);
  });

  it("passes a required layer edge that exists", () => {
    const d = judgeFitnessRow(rows.required, g, {}, null, []);
    expect(d.verdict).toBe("pass");
  });

  it("fails a required layer edge that is missing", () => {
    const d = judgeFitnessRow(
      rows.required,
      graph([
        ["service", "libs/service", ["layer-service"]],
        ["domain", "libs/domain", ["layer-domain"]],
      ]),
      {},
      null,
      [],
    );
    expect(d.verdict).toBe("fail");
    expect(d.evidence.edges).toBe(0);
  });

  it("yields unknown, never pass, when a side tag no project carries", () => {
    const d = judgeFitnessRow(
      rows.forbidden,
      graph([["oracle", "libs/oracle", ["layer-domain"]]]),
      {},
      null,
      [],
    );
    expect(d.verdict).toBe("unknown");
    expect(d.message).toMatch(/no matched project carries tag/);
  });
});

describe("judgeFitnessRow — tag-conformance", () => {
  const onlyRow = {
    name: "domain-only",
    match: ["*"],
    condition: {
      type: "tag-conformance",
      from: "scope-app",
      to: "scope-domain",
      toDependents: "only",
    },
    reason: "r",
  };
  const neverRow = {
    name: "never-domain",
    match: ["*"],
    condition: {
      type: "tag-conformance",
      from: "scope-app",
      to: "scope-domain",
      toDependents: "never",
    },
    reason: "r",
  };

  it("passes when from-edges target only to-tagged projects", () => {
    const g = graph(
      [
        ["app", "apps/app", ["scope-app"]],
        ["domain", "libs/domain", ["scope-domain"]],
        ["infra", "libs/infra", ["scope-domain"]],
      ],
      {
        app: [
          { source: "app", target: "domain", type: "static" },
          { source: "app", target: "infra", type: "static" },
        ],
      },
    );
    expect(judgeFitnessRow(onlyRow, g, {}, null, []).verdict).toBe("pass");
  });

  it("fails when an app reaches a non-domain project", () => {
    const g = graph(
      [
        ["app", "apps/app", ["scope-app"]],
        ["domain", "libs/domain", ["scope-domain"]],
        ["other", "libs/other", []],
      ],
      { app: [{ source: "app", target: "other", type: "static" }] },
    );
    const d = judgeFitnessRow(onlyRow, g, {}, null, []);
    expect(d.verdict).toBe("fail");
    expect(d.evidence.violations).toBe(1);
  });

  it("fails never-condition when a from-edge reaches a to-tagged project", () => {
    const g = graph(
      [
        ["app", "apps/app", ["scope-app"]],
        ["domain", "libs/domain", ["scope-domain"]],
      ],
      { app: [{ source: "app", target: "domain", type: "static" }] },
    );
    expect(judgeFitnessRow(neverRow, g, {}, null, []).verdict).toBe("fail");
  });

  it("yields unknown when no matched project carries the from tag", () => {
    const d = judgeFitnessRow(
      onlyRow,
      graph([
        ["x", "libs/x", []],
        ["d", "libs/d", ["scope-domain"]],
      ]),
      {},
      null,
      [],
    );
    expect(d.verdict).toBe("unknown");
  });
});

describe("judgeFitnessRow — coverage-minimum", () => {
  it("passes when analyzed files meet the minimum", () => {
    const analysis = {
      coverage: { app: { owned: 10, analyzed: 9 }, lib: { owned: 5, analyzed: 5 } },
      owned: 15,
      analyzed: 14,
    };
    const row = {
      name: "cov",
      match: ["*"],
      condition: { type: "coverage-minimum", statement: 90 },
      reason: "r",
    };
    const d = judgeFitnessRow(
      row,
      graph([
        ["app", "apps/app"],
        ["lib", "libs/lib"],
      ]),
      analysis,
      null,
      [],
    );
    expect(d.verdict).toBe("pass");
    expect(d.evidence.percent).toBeCloseTo(93.33, 1);
  });

  it("fails below the minimum", () => {
    const analysis = { coverage: { app: { owned: 10, analyzed: 5 } }, owned: 10, analyzed: 5 };
    const row = {
      name: "cov",
      match: ["*"],
      condition: { type: "coverage-minimum", statement: 90 },
      reason: "r",
    };
    const d = judgeFitnessRow(row, graph([["app", "apps/app"]]), analysis, null, []);
    expect(d.verdict).toBe("fail");
  });

  it("yields unknown over zero owned files — never pass", () => {
    const analysis = { coverage: {}, owned: 0, analyzed: 0 };
    const row = {
      name: "cov",
      match: ["*"],
      condition: { type: "coverage-minimum", statement: 90 },
      reason: "r",
    };
    const d = judgeFitnessRow(row, graph([["app", "apps/app"]]), analysis, null, []);
    expect(d.verdict).toBe("unknown");
    expect(d.message).toMatch(/owns no tracked files/);
  });

  it("yields unknown on a path-scoped run — never a partial-number verdict", () => {
    const analysis = {
      coverage: { app: { owned: 10, analyzed: 10 } },
      owned: 10,
      analyzed: 10,
      scoped: true,
    };
    const row = {
      name: "cov",
      match: ["*"],
      condition: { type: "coverage-minimum", statement: 90 },
      reason: "r",
    };
    const d = judgeFitnessRow(row, graph([["app", "apps/app"]]), analysis, null, []);
    expect(d.verdict).toBe("unknown");
    expect(d.message).toMatch(/scoped to specific paths/);
  });
});

describe("judgeFitnessRow — boundary-suppression-count-within-threshold", () => {
  it("passes within the threshold", () => {
    const row = {
      name: "supps",
      match: ["*"],
      condition: { type: "boundary-suppression-count-within-threshold", max: 3 },
      reason: "r",
    };
    const d = judgeFitnessRow(row, graph([["a", "libs/a"]]), {}, null, [
      { path: "a" },
      { path: "b" },
    ]);
    expect(d.verdict).toBe("pass");
  });

  it("fails over the threshold", () => {
    const row = {
      name: "supps",
      match: ["*"],
      condition: { type: "boundary-suppression-count-within-threshold", max: 1 },
      reason: "r",
    };
    const d = judgeFitnessRow(row, graph([["a", "libs/a"]]), {}, null, [
      { path: "a" },
      { path: "b" },
    ]);
    expect(d.verdict).toBe("fail");
    expect(d.evidence).toEqual({ suppressions: 2, max: 1 });
  });
});

describe("judgeFitnessRow — drift-free", () => {
  it("passes on a clean intent verdict", () => {
    const row = { name: "no-drift", match: ["*"], condition: { type: "drift-free" }, reason: "r" };
    const d = judgeFitnessRow(
      row,
      graph([["a", "libs/a"]]),
      {},
      { verdict: "ok", findings: [], unresolved: [] },
      [],
    );
    expect(d.verdict).toBe("pass");
  });

  it("fails on intent findings", () => {
    const row = { name: "no-drift", match: ["*"], condition: { type: "drift-free" }, reason: "r" };
    const d = judgeFitnessRow(
      row,
      graph([["a", "libs/a"]]),
      {},
      { verdict: "findings", findings: [{ rule: "x" }], unresolved: [] },
      [],
    );
    expect(d.verdict).toBe("fail");
  });

  it("yields unknown on intent no-verdict — never pass", () => {
    const row = { name: "no-drift", match: ["*"], condition: { type: "drift-free" }, reason: "r" };
    const d = judgeFitnessRow(
      row,
      graph([["a", "libs/a"]]),
      {},
      { verdict: "no-verdict", findings: [], unresolved: [{ boundary: "b", issue: "empty" }] },
      [],
    );
    expect(d.verdict).toBe("unknown");
  });

  it("yields unknown when no intent is declared — never pass", () => {
    const row = { name: "no-drift", match: ["*"], condition: { type: "drift-free" }, reason: "r" };
    const d = judgeFitnessRow(row, graph([["a", "libs/a"]]), {}, null, []);
    expect(d.verdict).toBe("unknown");
    expect(d.message).toMatch(/no architecture-intent\.json/);
  });
});

describe("fitnessSnapshot and evaluateFitness", () => {
  it("attributes owned/analyzed per project from the file ownership map", () => {
    const commandContext = {
      graph: graph([
        ["app", "apps/app"],
        ["shy", "libs/shy"],
      ]),
      analysis: {
        analyzedFiles: ["apps/app/main.mjs"],
        imports: [],
        analyzed: 1,
      },
      owned: [
        { file: "apps/app/main.mjs", project: "app" },
        { file: "apps/app/util.mjs", project: "app" },
        { file: "libs/shy/api.mjs", project: "shy" },
      ],
    };
    const snapshot = fitnessSnapshot(commandContext);
    expect(snapshot.analysis.coverage).toEqual({
      app: { owned: 2, analyzed: 1 },
      shy: { owned: 1, analyzed: 0 },
    });
    expect(snapshot.analysis.owned).toBe(3);
    expect(snapshot.analysis.analyzed).toBe(1);
  });

  it("evaluates every declared row, in declaration order", () => {
    const rows = [
      { name: "one", match: ["*"], condition: { type: "cycle-free" }, reason: "r" },
      { name: "two", match: ["name:ghost"], condition: { type: "cycle-free" }, reason: "r" },
    ];
    const snapshot = {
      graph: graph([["a", "libs/a"]]),
      analysis: { coverage: {}, owned: 0, analyzed: 0 },
      intent: null,
      suppressions: [],
    };
    const decisions = evaluateFitness(rows, snapshot);
    expect(decisions.map((d) => d.verdict)).toEqual(["pass", "not_applicable"]);
  });

  it("aggregates: fail wins, then unknown, then pass", () => {
    const pass = { verdict: "pass", name: "a", evidence: {}, message: "m" };
    const fail = { verdict: "fail", name: "b", evidence: {}, message: "m" };
    const unknown = { verdict: "unknown", name: "c", evidence: {}, message: "m" };
    const notApplicable = { verdict: "not_applicable", name: "d", evidence: {}, message: "m" };
    expect(fitnessVerdictFor([unknown, pass]).verdict).toBe("unknown");
    expect(fitnessVerdictFor([fail, unknown, pass]).verdict).toBe("fail");
    expect(fitnessVerdictFor([pass, pass]).verdict).toBe("pass");
    expect(fitnessVerdictFor([notApplicable]).verdict).toBe("not_applicable");
    expect(fitnessVerdictFor([]).verdict).toBe("not_applicable");
  });
});

describe("determinism", () => {
  it("produces byte-identical evidence across two runs", () => {
    const rows = [
      {
        name: "layers",
        match: ["*"],
        condition: {
          type: "layer-dependency",
          from: "layer-adapter",
          to: "layer-domain",
          direction: "forbidden",
        },
        reason: "r",
      },
      {
        name: "cov",
        match: ["*"],
        condition: { type: "coverage-minimum", statement: 90 },
        reason: "r",
      },
    ];
    const g = graph(
      [
        ["adapter", "apps/adapter", ["layer-adapter"]],
        ["domain", "libs/domain", ["layer-domain"]],
      ],
      { adapter: [{ source: "adapter", target: "domain", type: "static" }] },
    );
    const analysis = {
      coverage: { adapter: { owned: 5, analyzed: 5 }, domain: { owned: 3, analyzed: 3 } },
      owned: 8,
      analyzed: 8,
    };
    const snapshot = {
      graph: g,
      analysis,
      intent: { verdict: "ok", findings: [], unresolved: [] },
      suppressions: [],
    };
    const first = evaluateFitness(rows, snapshot).map((d) => canonicalizeJson(d));
    const second = evaluateFitness(rows, snapshot).map((d) => canonicalizeJson(d));
    expect(first).toEqual(second);
  });

  it("declares all six built-in condition types", () => {
    expect(CONDITION_TYPES).toEqual([
      "cycle-free",
      "layer-dependency",
      "tag-conformance",
      "coverage-minimum",
      "boundary-suppression-count-within-threshold",
      "drift-free",
    ]);
  });
});

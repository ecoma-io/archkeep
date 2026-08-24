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

  it("round-trips a fitness row carrying the shared governance block (B-F19)", () => {
    // A fitness row is a policy decision like any other row, so it may carry
    // `origin`/`rationale`/`decisionRef`/`fitnessBindings` — the SAME shared
    // block `row-schema.mjs` validates for depConstraints and intent rows. A
    // row that claimed the block refused on an unknown key until this change.
    const row = {
      name: "no-cycles",
      match: ["*"],
      condition: { type: "cycle-free" },
      reason: "keep it acyclic",
      origin: { by: "jane@example.com", tool: "archkeep:v1" },
      rationale: "cycles make the graph unreadable",
      decisionRef: "adr:0001",
    };
    expect(findFitnessViolations([row])).toEqual([]);
  });

  it("rejects a fitnessBindings entry naming no declared fitness rule (F05)", () => {
    const violations = findFitnessViolations(
      [
        {
          name: "no-cycles",
          match: ["*"],
          condition: { type: "cycle-free" },
          reason: "keep it acyclic",
          fitnessBindings: ["fitness:undeclared"],
        },
      ],
      {
        resolve: (key, id) => key !== "fitnessBindings" || id === "fitness:declared",
        kindLabel: "declared fitness",
      },
    );
    expect(violations.some((v) => /fitness:undeclared.*does not resolve/.test(v))).toBe(true);
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

  // `match` selects the sources. A row scoped to the layer it governs is the
  // natural way to write one, and while the target side was scoped by `match`
  // too the edge below — the only violation there is — was discarded, so this
  // row could never fail. Scoping the sources is what the next case pins;
  // this one pins that the target is judged wherever it lands.
  it("fails on an edge leaving the matched set, so a scoped match can still fail", () => {
    const g = graph(
      [
        ["app", "apps/app", ["scope-app"]],
        ["domain", "libs/domain", ["scope-domain"]],
        ["util", "libs/util", ["scope-infra"]],
      ],
      { app: [{ source: "app", target: "util", type: "static" }] },
    );
    const d = judgeFitnessRow({ ...onlyRow, match: ["tag:scope-app"] }, g, {}, null, []);
    expect(d.verdict).toBe("fail");
    expect(d.evidence.violations).toBe(1);
    expect(d.rows).toEqual([{ source: "app", target: "util" }]);
  });

  it("does not judge a violating project the match does not select", () => {
    const g = graph(
      [
        ["app", "apps/app", ["scope-app"]],
        ["worker", "apps/worker", ["scope-app"]],
        ["domain", "libs/domain", ["scope-domain"]],
        ["util", "libs/util", ["scope-infra"]],
      ],
      {
        app: [{ source: "app", target: "domain", type: "static" }],
        worker: [{ source: "worker", target: "util", type: "static" }],
      },
    );
    const d = judgeFitnessRow({ ...onlyRow, match: ["name:app"] }, g, {}, null, []);
    expect(d.verdict).toBe("pass");
    expect(d.evidence.fromMembers).toBe(1);
    expect(d.evidence.edges).toBe(1);
  });

  it("counts one dependency once when it is both a manifest and an implicit edge", () => {
    const g = graph(
      [
        ["app", "apps/app", ["scope-app"]],
        ["domain", "libs/domain", ["scope-domain"]],
        ["util", "libs/util", ["scope-infra"]],
      ],
      {
        app: [
          { source: "app", target: "util", type: "static" },
          { source: "app", target: "util", type: "implicit" },
        ],
      },
    );
    const d = judgeFitnessRow({ ...onlyRow, match: ["tag:scope-app"] }, g, {}, null, []);
    expect(d.verdict).toBe("fail");
    expect(d.evidence.edges).toBe(1);
    expect(d.evidence.violations).toBe(1);
    expect(d.rows).toEqual([{ source: "app", target: "util" }]);
  });

  // An Nx graph's `dependencies` carry `npm:` targets that are absent from
  // `nodes` (`../commands/drift.test.mjs` and `../rules/reachability.test.mjs`
  // model the same shape). The native provider drops them, so a hand-built
  // native-shaped graph cannot see this: judged as a target "outside" the `to`
  // tag, every npm import from a from-tagged project would be a violation.
  it("does not judge a target that is not a project node", () => {
    const g = graph(
      [
        ["app", "apps/app", ["scope-app"]],
        ["domain", "libs/domain", ["scope-domain"]],
      ],
      {
        app: [
          { source: "app", target: "domain", type: "static" },
          { source: "app", target: "npm:lodash", type: "static" },
        ],
      },
    );
    const d = judgeFitnessRow({ ...onlyRow, match: ["tag:scope-app"] }, g, {}, null, []);
    expect(d.verdict).toBe("pass");
    // The in-graph edge is still judged, so this cannot pass by dropping
    // everything: one edge counted, and it is the project-to-project one.
    expect(d.evidence.edges).toBe(1);
    expect(d.rows).toEqual([]);
  });

  it("still fails on a project target while an npm target rides alongside it", () => {
    const g = graph(
      [
        ["app", "apps/app", ["scope-app"]],
        ["domain", "libs/domain", ["scope-domain"]],
        ["util", "libs/util", ["scope-infra"]],
      ],
      {
        app: [
          { source: "app", target: "npm:lodash", type: "static" },
          { source: "app", target: "util", type: "static" },
        ],
      },
    );
    const d = judgeFitnessRow({ ...onlyRow, match: ["tag:scope-app"] }, g, {}, null, []);
    expect(d.verdict).toBe("fail");
    expect(d.evidence.edges).toBe(1);
    expect(d.rows).toEqual([{ source: "app", target: "util" }]);
  });

  it("yields unknown, never pass, when no project anywhere carries the to tag (only)", () => {
    const g = graph(
      [
        ["app", "apps/app", ["scope-app"]],
        ["other", "libs/other", []],
      ],
      { app: [{ source: "app", target: "other", type: "static" }] },
    );
    const d = judgeFitnessRow(onlyRow, g, {}, null, []);
    expect(d.verdict).toBe("unknown");
    expect(d.evidence.toMembers).toBe(0);
    expect(d.message).toMatch(/only-condition could not be determined/);
  });

  it("yields unknown, never pass, when no project anywhere carries the to tag (never)", () => {
    const g = graph(
      [
        ["app", "apps/app", ["scope-app"]],
        ["other", "libs/other", []],
      ],
      { app: [{ source: "app", target: "other", type: "static" }] },
    );
    const d = judgeFitnessRow(neverRow, g, {}, null, []);
    expect(d.verdict).toBe("unknown");
    expect(d.evidence.toMembers).toBe(0);
    expect(d.message).toMatch(/never-condition could not be determined/);
  });

  // The `to` tag is read across the whole graph, not the matched set: a target
  // outside `match` still counts as a `to` project, so this edge conforms.
  // Reading membership off the matched set alone would report it as a
  // violation — loud, but a violation that is not real.
  it("reads the to tag off an unmatched target", () => {
    const g = graph(
      [
        ["app", "apps/app", ["scope-app"]],
        ["domain", "libs/domain", ["scope-domain"]],
      ],
      { app: [{ source: "app", target: "domain", type: "static" }] },
    );
    const d = judgeFitnessRow({ ...onlyRow, match: ["tag:scope-app"] }, g, {}, null, []);
    expect(d.verdict).toBe("pass");
    expect(d.evidence.edges).toBe(1);
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

  it("yields not_applicable on a path-scoped run — never a partial-number verdict, and never unknown either (P1-19)", () => {
    // P1-19: this used to yield `unknown`, which folds into `check`'s exit
    // code the same as a real coverage hole — so `check <path>` exited 3 in
    // ANY `coverage-minimum`-declaring workspace, regardless of what the
    // scoped path held or whether it was clean. `not_applicable` keeps the
    // P0-1 guarantee below (never a partial number read as `pass`) while no
    // longer forcing that exit — `fitnessVerdictFor`/`check`'s fold treat
    // `not_applicable` the same as a zero-matched `match`, never `pass` and
    // never folded into `fitnessFail`/`fitnessUnknown`.
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
    expect(d.verdict).toBe("not_applicable");
    expect(d.notApplicableReason).toMatch(/scoped to specific paths/);
    expect(d.message).toMatch(/does not apply to a path-scoped run/);
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

describe("judgeFitnessRow — tag-axis-isolation", () => {
  /** A two-module tree: each module has a published surface and a private inside. */
  const modules = graph(
    [
      ["orders-api", "libs/orders-api", ["module:orders", "layer:module"]],
      ["orders-internal", "libs/orders-internal", ["module:orders", "layer:module-internal"]],
      ["billing-api", "libs/billing-api", ["module:billing", "layer:module"]],
      ["billing-internal", "libs/billing-internal", ["module:billing", "layer:module-internal"]],
      ["kernel", "libs/kernel", ["layer:shared-kernel"]],
    ],
    {
      "orders-api": [
        { source: "orders-api", target: "orders-internal", type: "static" },
        { source: "orders-api", target: "billing-api", type: "static" },
        { source: "orders-api", target: "kernel", type: "static" },
      ],
      "orders-internal": [{ source: "orders-internal", target: "kernel", type: "static" }],
      "billing-internal": [{ source: "billing-internal", target: "billing-api", type: "static" }],
    },
  );

  /** The row the `modular-monolith-sealed-modules` profile ships. */
  const row = (condition, match = ["tag:layer:module", "tag:layer:module-internal"]) => ({
    name: "module-encapsulation",
    match,
    condition: { type: "tag-axis-isolation", ...condition },
    reason: "r",
  });

  it("passes when every judged edge stays inside its own partition", () => {
    const d = judgeFitnessRow(
      row({ axis: "module", exempt: ["tag:layer:module"] }),
      modules,
      {},
      null,
      [],
    );
    expect(d.verdict).toBe("pass");
    expect(d.evidence).toEqual({
      projects: 4,
      axis: "module",
      exempt: 2,
      unplaced: 0,
      crossings: 0,
    });
  });

  it("fails a cross-partition edge and names both partitions", () => {
    const leaking = graph(
      modules.nodes &&
        Object.entries(modules.nodes).map(([name, node]) => [name, node.data.root, node.data.tags]),
      {
        ...modules.dependencies,
        "orders-internal": [
          { source: "orders-internal", target: "billing-internal", type: "static" },
        ],
      },
    );
    const d = judgeFitnessRow(
      row({ axis: "module", exempt: ["tag:layer:module"] }),
      leaking,
      {},
      null,
      [],
    );
    expect(d.verdict).toBe("fail");
    expect(d.evidence.crossings).toBe(1);
    expect(d.rows).toEqual([
      {
        source: "orders-internal",
        target: "billing-internal",
        sourceValues: ["orders"],
        targetValues: ["billing"],
      },
    ]);
    expect(d.message).toContain("orders-internal (orders) → billing-internal (billing)");
  });

  it("reports a published surface reaching another module's inside — the shipped pack's blind spot", () => {
    // `modular-monolith`'s own `layer:module` row permits this edge, because
    // "another module's internals" and "its own" are the same tag to a tag
    // list. It is the false negative this condition exists to close, so the
    // exemption that lets a published surface be a TARGET must not also let
    // it be a permitted SOURCE of a crossing.
    const reaching = graph(
      Object.entries(modules.nodes).map(([name, node]) => [name, node.data.root, node.data.tags]),
      { "billing-api": [{ source: "billing-api", target: "orders-internal", type: "static" }] },
    );
    const d = judgeFitnessRow(
      row({ axis: "module", exempt: ["tag:layer:module"] }),
      reaching,
      {},
      null,
      [],
    );
    expect(d.verdict).toBe("fail");
    expect(d.rows.map((r) => `${r.source}->${r.target}`)).toEqual(["billing-api->orders-internal"]);
  });

  it("does not judge an edge whose target carries no value on the axis", () => {
    // The shared kernel belongs to no module, so it is nobody's partition
    // boundary. Judging it would report every legitimate kernel import.
    const d = judgeFitnessRow(row({ axis: "module" }), modules, {}, null, []);
    // `orders-api → billing-api` is a real crossing with no exemption in play;
    // the two kernel edges are not, and that is the assertion.
    expect(d.rows.map((r) => `${r.source}->${r.target}`)).toEqual(["orders-api->billing-api"]);
  });

  it("does not read a source that sits in no partition as crossing out of it", () => {
    // The near-miss for the source half of the crossing filter. Without the
    // `sourceValues.length > 0` guard, `[].some(...)` is false, `!false` is
    // true, and an unplaced SOURCE reaching a placed target reads as a
    // crossing — reporting a project the condition cannot judge instead of
    // saying it could not judge it.
    const d = judgeFitnessRow(
      row({ axis: "module" }, ["*"]),
      graph(
        [
          ["untagged", "libs/untagged", ["layer:module"]],
          ["billing-api", "libs/billing-api", ["module:billing"]],
        ],
        { untagged: [{ source: "untagged", target: "billing-api", type: "static" }] },
      ),
      {},
      null,
      [],
    );
    expect(d.verdict).toBe("unknown");
    expect(d.evidence.crossings).toBe(0);
    expect(d.evidence.unplaced).toBe(1);
  });

  it("judges a crossing into a project its match does not select", () => {
    // `edgesFrom` deliberately restricts only the SOURCE to the matched set,
    // where `edgesAmong` (used by the other conditions) restricts both. If it
    // restricted both, a partition boundary crossed into a project outside the
    // match — which is most of them, since `match` normally names one role —
    // would go unjudged. The silent direction, and the reason the helper
    // exists separately.
    const d = judgeFitnessRow(
      row({ axis: "module" }, ["tag:layer:module-internal"]),
      graph(
        [
          ["orders-internal", "libs/orders-internal", ["module:orders", "layer:module-internal"]],
          ["billing-api", "libs/billing-api", ["module:billing", "layer:module"]],
        ],
        {
          "orders-internal": [{ source: "orders-internal", target: "billing-api", type: "static" }],
        },
      ),
      {},
      null,
      [],
    );
    expect(d.verdict).toBe("fail");
    expect(d.rows.map((r) => r.target)).toEqual(["billing-api"]);
  });

  it("counts one edge once when the graph carries it twice", () => {
    // A provider deduplicates on `[source, target, type]`, so one dependency
    // can arrive as both a manifest edge and an implicit one. This condition
    // reads the pair and never the type, so both would otherwise be reported
    // and `crossings` would describe two edges where the graph has one.
    const d = judgeFitnessRow(
      row({ axis: "module" }, ["*"]),
      graph(
        [
          ["a", "libs/a", ["module:orders"]],
          ["b", "libs/b", ["module:billing"]],
        ],
        {
          a: [
            { source: "a", target: "b", type: "static" },
            { source: "a", target: "b", type: "implicit" },
          ],
        },
      ),
      {},
      null,
      [],
    );
    expect(d.evidence.crossings).toBe(1);
    expect(d.rows).toHaveLength(1);
  });

  it("places nothing on a bare axis tag that carries no value", () => {
    // `module:` names an axis and no value. Read as the partition `""`, every
    // project carrying one would land in the SAME partition and every edge
    // between them would pass.
    const d = judgeFitnessRow(
      row({ axis: "module" }, ["*"]),
      graph(
        [
          ["a", "libs/a", ["module:"]],
          ["b", "libs/b", ["module:"]],
        ],
        { a: [{ source: "a", target: "b", type: "static" }] },
      ),
      {},
      null,
      [],
    );
    expect(d.verdict).toBe("unknown");
    expect(d.evidence.unplaced).toBe(2);
  });

  it("names the projects it could not place even when it has a crossing to report", () => {
    // A `fail` that said nothing about them would report a partial look as a
    // whole one: the reader acts on the crossing and never learns that part of
    // the subject was never judged.
    const d = judgeFitnessRow(
      row({ axis: "module" }, ["*"]),
      graph(
        [
          ["a", "libs/a", ["module:orders"]],
          ["b", "libs/b", ["module:billing"]],
          ["unplaceable", "libs/unplaceable", ["layer:app"]],
        ],
        { a: [{ source: "a", target: "b", type: "static" }] },
      ),
      {},
      null,
      [],
    );
    expect(d.verdict).toBe("fail");
    expect(d.evidence.unplaced).toBe(1);
    expect(d.message).toContain("unplaceable");
  });

  it("yields unknown — never pass — when a matched project sits in no partition", () => {
    const d = judgeFitnessRow(
      row({ axis: "module" }, ["*"]),
      graph(
        [
          ["orders-api", "libs/orders-api", ["module:orders"]],
          ["kernel", "libs/kernel", ["layer:shared-kernel"]],
        ],
        { "orders-api": [{ source: "orders-api", target: "kernel", type: "static" }] },
      ),
      {},
      null,
      [],
    );
    expect(d.verdict).toBe("unknown");
    expect(d.evidence.unplaced).toBe(1);
    expect(d.message).toContain("kernel");
  });

  it("reports a crossing it found even where the picture is incomplete", () => {
    // Findings first, could-not-look second — the order `../../cli.mjs`'s
    // `verdictFor` uses for the run as a whole. Suppressing a determined
    // crossing behind `unknown` would lose it.
    const d = judgeFitnessRow(
      row({ axis: "module" }, ["*"]),
      graph(
        [
          ["orders-api", "libs/orders-api", ["module:orders"]],
          ["billing-api", "libs/billing-api", ["module:billing"]],
          ["kernel", "libs/kernel", ["layer:shared-kernel"]],
        ],
        { "orders-api": [{ source: "orders-api", target: "billing-api", type: "static" }] },
      ),
      {},
      null,
      [],
    );
    expect(d.verdict).toBe("fail");
    expect(d.evidence.unplaced).toBe(1);
    expect(d.evidence.crossings).toBe(1);
  });

  it("exempts nothing when `exempt` is absent or empty", () => {
    // `resolveMembers([])` seeds an implicit `*`, so routing an empty list
    // through it would exempt the whole workspace and turn every verdict
    // here into `pass`. Both spellings of "no exemption" are asserted.
    for (const condition of [{ axis: "module" }, { axis: "module", exempt: [] }]) {
      const d = judgeFitnessRow(row(condition), modules, {}, null, []);
      expect(d.verdict, JSON.stringify(condition)).toBe("fail");
      expect(d.evidence.exempt).toBe(0);
      expect(d.rows.map((r) => `${r.source}->${r.target}`)).toEqual(["orders-api->billing-api"]);
    }
  });

  it("exempts nothing from a list of only exclusions, rather than everything", () => {
    // `resolveMembers` seeds an implicit `*` for any list with no positive
    // selector, not only for the empty one. Read that way, `["!name:x"]`
    // exempts the whole workspace and this function passes on every tree. The
    // registry refuses such a list at load; this is the rule's own backstop,
    // and it errs toward exempting NOTHING.
    for (const exempt of [["!name:kernel"], ["!tag:layer:module", "!name:kernel"]]) {
      const d = judgeFitnessRow(row({ axis: "module", exempt }), modules, {}, null, []);
      expect(d.verdict, JSON.stringify(exempt)).toBe("fail");
      expect(d.evidence.exempt).toBe(0);
    }
  });

  it("treats a project on two values of the axis as sharing either one", () => {
    const shared = graph(
      [
        ["both", "libs/both", ["module:orders", "module:billing"]],
        ["orders-internal", "libs/orders-internal", ["module:orders"]],
        ["other", "libs/other", ["module:shipping"]],
      ],
      {
        both: [
          { source: "both", target: "orders-internal", type: "static" },
          { source: "both", target: "other", type: "static" },
        ],
      },
    );
    const d = judgeFitnessRow(row({ axis: "module" }, ["*"]), shared, {}, null, []);
    expect(d.verdict).toBe("fail");
    expect(d.rows.map((r) => r.target)).toEqual(["other"]);
    expect(d.rows[0].sourceValues).toEqual(["billing", "orders"]);
  });

  it("reads the partition off the FIRST colon of the tag", () => {
    const versioned = graph(
      [
        ["a", "libs/a", ["module:orders:v2"]],
        ["b", "libs/b", ["module:orders:v1"]],
      ],
      { a: [{ source: "a", target: "b", type: "static" }] },
    );
    const d = judgeFitnessRow(row({ axis: "module" }, ["*"]), versioned, {}, null, []);
    // Split on the last colon, both would be `orders` and this edge would pass.
    expect(d.verdict).toBe("fail");
    expect(d.rows[0]).toMatchObject({ sourceValues: ["orders:v2"], targetValues: ["orders:v1"] });
  });

  it("judges only the outgoing edges of a matched source", () => {
    const d = judgeFitnessRow(
      row({ axis: "module" }, ["tag:layer:module-internal"]),
      graph(
        Object.entries(modules.nodes).map(([name, node]) => [name, node.data.root, node.data.tags]),
        {
          "orders-api": [{ source: "orders-api", target: "billing-api", type: "static" }],
          "orders-internal": [
            { source: "orders-internal", target: "billing-internal", type: "static" },
          ],
        },
      ),
      {},
      null,
      [],
    );
    // `orders-api → billing-api` crosses the same boundary, but `orders-api`
    // is not matched, so it is not this function's subject.
    expect(d.rows.map((r) => r.source)).toEqual(["orders-internal"]);
  });

  it("is not_applicable when its match selects nothing, and says why (I4)", () => {
    const d = judgeFitnessRow(
      row({ axis: "module" }, ["tag:layer:nothing-carries-this"]),
      modules,
      {},
      null,
      [],
    );
    expect(d.verdict).toBe("not_applicable");
    expect(d.notApplicableReason).toContain("selects no observed project");
  });

  it("orders its rows deterministically", () => {
    const many = graph(
      [
        ["s", "libs/s", ["module:one"]],
        ["z", "libs/z", ["module:two"]],
        ["a", "libs/a", ["module:two"]],
        ["m", "libs/m", ["module:two"]],
      ],
      {
        s: [
          { source: "s", target: "z", type: "static" },
          { source: "s", target: "a", type: "static" },
          { source: "s", target: "m", type: "static" },
        ],
      },
    );
    const first = judgeFitnessRow(row({ axis: "module" }, ["*"]), many, {}, null, []);
    const second = judgeFitnessRow(row({ axis: "module" }, ["*"]), many, {}, null, []);
    expect(first.rows.map((r) => r.target)).toEqual(["a", "m", "z"]);
    expect(canonicalizeJson(first)).toBe(canonicalizeJson(second));
  });
});

describe("tag-axis-isolation row validation", () => {
  const row = (condition) => [
    {
      name: "iso",
      match: ["*"],
      condition: { type: "tag-axis-isolation", ...condition },
      reason: "r",
    },
  ];

  it("accepts axis alone and axis with selectors", () => {
    expect(findFitnessViolations(row({ axis: "module" }))).toEqual([]);
    expect(
      findFitnessViolations(row({ axis: "context", exempt: ["tag:share:published", "!name:x"] })),
    ).toEqual([]);
  });

  it("refuses an axis that carries its own separator", () => {
    // `module:orders` as an axis would read the partition off the second
    // colon, so it would match nothing while reading as policy.
    const [message] = findFitnessViolations(row({ axis: "module:orders" }));
    expect(message).toMatch(/contains ':'/u);
    expect(message).toContain('write "module"');
  });

  it("refuses a missing axis, a non-array exempt, and a selector nobody can parse", () => {
    expect(findFitnessViolations(row({}))[0]).toMatch(/condition\.axis: must be a non-empty/u);
    expect(findFitnessViolations(row({ axis: "m", exempt: "x" }))[0]).toMatch(
      /condition\.exempt: must be an array/u,
    );
    expect(findFitnessViolations(row({ axis: "m", exempt: ["tagz:x"] }))[0]).toMatch(
      /condition\.exempt\[0\]: must be a valid project selector/u,
    );
  });

  it("refuses an exempt list that names only exclusions", () => {
    // It would exempt every project except those, and so exempt the whole
    // workspace — a policy reading as "do not exempt legacy" that enforces
    // nothing at all.
    const [message] = findFitnessViolations(row({ axis: "m", exempt: ["!name:legacy"] }));
    expect(message).toMatch(/names only "!" selectors/u);
    // The spelling that really does mean "nearly everything" stays legal.
    expect(findFitnessViolations(row({ axis: "m", exempt: ["*", "!name:legacy"] }))).toEqual([]);
  });

  it("refuses a field this condition does not have", () => {
    expect(findFitnessViolations(row({ axis: "m", direction: "forbidden" }))[0]).toMatch(
      /condition\.direction: not a field of condition type "tag-axis-isolation"/u,
    );
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

  it("rides the scoped flag inside analysis, where judgeFitnessRow reads it — a path-scoped run must never answer pass", () => {
    // P0-1 regression: the flag used to sit on the snapshot's top level, which
    // `validateAndConfigure` never read, so a scoped run claimed full-coverage
    // `pass` over the files it happened to analyze. The snapshot must place it
    // where the rule reads it — `analysis.scoped`. P1-19 later moved the
    // verdict this reaches from `unknown` to `not_applicable` (an `unknown`
    // folded into `check`'s exit code the same as a real coverage hole, so a
    // scoped run exited 3 in any `coverage-minimum`-declaring workspace no
    // matter what the scoped path held) — this test's own guarantee is
    // unchanged by that: `not_applicable` is still never `pass`.
    const snapshot = fitnessSnapshot(
      {
        graph: graph([["app", "apps/app"]]),
        analysis: { analyzedFiles: ["apps/app/main.mjs"], imports: [], analyzed: 1 },
        owned: [{ file: "apps/app/main.mjs", project: "app" }],
      },
      { scoped: true },
    );
    expect(snapshot.analysis.scoped).toBe(true);
    const row = {
      name: "scoped-cov",
      match: ["*"],
      condition: { type: "coverage-minimum", statement: 100 },
      reason: "r",
    };
    const d = judgeFitnessRow(
      row,
      snapshot.graph,
      snapshot.analysis,
      snapshot.intent,
      snapshot.suppressions,
    );
    expect(d.verdict).not.toBe("pass");
    expect(d.verdict).toBe("not_applicable");
    expect(d.message).toMatch(/does not apply to a path-scoped run/);
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

  it("declares all seven built-in condition types", () => {
    expect(CONDITION_TYPES).toEqual([
      "cycle-free",
      "layer-dependency",
      "tag-conformance",
      "coverage-minimum",
      "boundary-suppression-count-within-threshold",
      "drift-free",
      "tag-axis-isolation",
    ]);
  });
});

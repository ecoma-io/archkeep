import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildRuleModule, invalidWasmBytes } from "../custom-rules/wasm-fixture.mjs";
import { customRulesForCheck, customRulesForDelta, declaresCustomRules } from "./custom-rules.mjs";

/**
 * The fold driven over an in-memory command context, with the one seam that
 * reaches outside the process — the artifact reader — injected. Real wasm
 * bytes throughout: the modules are emitted by `../custom-rules/wasm-fixture.mjs`
 * and compiled by Node's own validator, so nothing here is a stand-in for the
 * host's reading of the ABI. What IS under test is only this module's part:
 * which failures refuse the run, which become an `unknown` verdict, what a
 * decision record carries, and what a scoped run does before it reads
 * anything.
 *
 * `../custom-rules/host.test.mjs` owns the ABI's own refusals — one per step —
 * so they are not re-driven here; this file drives one of each CLASS, because
 * the class is what this module routes on.
 */

const RULE = "no-app-to-ring";
const FINDING = "reached-ring";
const OTHER_FINDING = "unplaced-reach";

const describeJson = (overrides = {}) =>
  JSON.stringify({
    contract: 1,
    name: RULE,
    needs: ["model", "graph", "imports", "policy"],
    findings: [
      { id: FINDING, message: "the app layer reached a ring internal" },
      { id: OTHER_FINDING, message: "a reach this rule could not place in a file" },
    ],
    ...overrides,
  });

const verdictJson = (overrides = {}) =>
  JSON.stringify({ contract: 1, verdict: "pass", findings: [], ...overrides });

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * A policy row plus the bytes it pins, so the two can never disagree — and the
 * self-description names the SAME rule the row declares, because the host
 * refuses a rule that calls itself something else.
 */
function declared(options = {}, { name = RULE, reason = "the ring stays private" } = {}) {
  const bytes = buildRuleModule({
    describeJson: describeJson({ name }),
    verdictJson: verdictJson(),
    ...options,
  });
  return {
    bytes,
    row: { name, artifact: `tools/rules/${name}.wasm`, sha256: sha256(bytes), reason },
  };
}

/** A command context carrying exactly the four facts the bundle is built from. */
function context(overrides = {}) {
  return {
    root: "/workspace",
    graph: {
      nodes: {
        app: { name: "app", data: { root: "libs/app", tags: ["layer-app"] } },
        ring: { name: "ring", data: { root: "libs/ring" } },
      },
      dependencies: { app: [{ source: "app", target: "ring", type: "static" }] },
    },
    owned: [
      { file: "libs/app/main.go", project: "app" },
      { file: "libs/ring/x.go", project: "ring" },
    ],
    analysis: {
      imports: [
        {
          sourceFile: "libs/app/main.go",
          line: 7,
          column: 2,
          specifier: "example.test/ring/internal",
          kind: "static",
        },
      ],
    },
    ...overrides,
  };
}

const POLICY = { depConstraints: [], options: {} };

/** Drives the fold with an in-memory artifact store. */
function fold(
  rules,
  { scoped = false, reads = [], commandContext = context(), collectEvidence = false } = {},
) {
  const bytesFor = new Map(rules.map(({ row, bytes }) => [row.artifact, bytes]));
  return customRulesForCheck(commandContext, {
    rows: rules.map(({ row }) => row),
    policy: POLICY,
    scoped,
    collectEvidence,
    readArtifact: (artifact) => {
      reads.push(artifact);
      return bytesFor.get(artifact) ?? null;
    },
  });
}

/**
 * The one bundle a single-rule fold built, as the document a rule reads.
 *
 * Going through the serialized bytes rather than reaching for `observedFacts`
 * is the point: what a rule is judged over is the wire, and a fact this module
 * failed to put on it is invisible from any other vantage.
 */
async function bundleFrom(commandContext) {
  const { evidence } = await fold([declared()], { commandContext, collectEvidence: true });
  expect(evidence).toHaveLength(1);
  return JSON.parse(new TextDecoder().decode(evidence[0].bytes));
}

describe("declaresCustomRules", () => {
  it("separates a workspace that declared none from a policy that could not be read", () => {
    expect(declaresCustomRules({ customRules: [{ name: RULE }] })).toBe(true);
    // An absent key is the workspace's decision; `null`/`undefined` is a
    // caller with no policy at all. Neither is "declared and empty" — the
    // config validator refuses that outright (`../config.mjs`).
    expect(declaresCustomRules({})).toBe(false);
    expect(declaresCustomRules(null)).toBe(false);
    expect(declaresCustomRules(undefined)).toBe(false);
  });
});

describe("the verdicts a loaded rule can reach", () => {
  it("carries a passing rule through as pass, with the declared reason beside it", async () => {
    const { decisions, overall } = await fold([declared()]);
    expect(overall.verdict).toBe("pass");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      verdict: "pass",
      name: RULE,
      reason: "the ring stays private",
      findings: [],
      evidence: { artifact: `tools/rules/${RULE}.wasm`, findings: 0 },
    });
    // The verified digest, not a second copy of the declaration: the bytes
    // hashed to this or the load would have refused.
    expect(decisions[0].evidence.sha256).toBe(sha256(declared().bytes));
  });

  it("namespaces every finding of a failing rule and keeps the positions it stated", async () => {
    const { decisions, overall } = await fold([
      declared({
        verdictJson: verdictJson({
          verdict: "fail",
          findings: [
            {
              id: FINDING,
              message: "libs/app reaches libs/ring's internals",
              sourceFile: "libs/app/main.go",
              line: 7,
              column: 2,
              project: "app",
            },
            { id: OTHER_FINDING, message: "and one reach nothing could be placed in a file" },
          ],
        }),
      }),
    ]);
    expect(overall.verdict).toBe("fail");
    expect(decisions[0].verdict).toBe("fail");
    expect(decisions[0].message).toBe("reported 2 findings");
    expect(decisions[0].findings).toEqual([
      {
        id: `custom/${RULE}/${FINDING}`,
        message: "libs/app reaches libs/ring's internals",
        sourceFile: "libs/app/main.go",
        line: 7,
        column: 2,
        project: "app",
      },
      // A finding with no position keeps none: an absent `sourceFile` is not
      // filled in, so nothing downstream can point a reader at a file the rule
      // never named.
      {
        id: `custom/${RULE}/${OTHER_FINDING}`,
        message: "and one reach nothing could be placed in a file",
      },
    ]);
  });

  it("keeps a rule's own unknown as unknown, with the reason it gave", async () => {
    const { decisions, overall } = await fold([
      declared({
        verdictJson: verdictJson({
          verdict: "unknown",
          reason: "the model carries no layer tags, so nothing could be compared",
        }),
      }),
    ]);
    expect(overall.verdict).toBe("unknown");
    expect(decisions[0].verdict).toBe("unknown");
    expect(decisions[0].message).toContain("the model carries no layer tags");
  });

  it("keeps a rule's own not_applicable as not_applicable, with its reason", async () => {
    const { decisions, overall } = await fold([
      declared({
        verdictJson: verdictJson({
          verdict: "not_applicable",
          notApplicableReason: "this workspace declares no ring project",
        }),
      }),
    ]);
    expect(overall.verdict).toBe("not_applicable");
    expect(decisions[0].notApplicableReason).toBe("this workspace declares no ring project");
  });

  it("turns an evaluate-class failure into unknown, never into a pass by omission", async () => {
    // The silent direction: a rule that traps mid-judgment has decided
    // nothing, and an empty findings list from it must not read as a clean
    // verdict.
    const { decisions, overall } = await fold([declared({ evaluateBehavior: "trap" })]);
    expect(overall.verdict).toBe("unknown");
    expect(decisions[0].verdict).toBe("unknown");
    expect(decisions[0].findings).toEqual([]);
    expect(decisions[0].message).toContain(`custom rule "${RULE}"`);
    expect(decisions[0].message).toContain("archkeep_evaluate trapped");
  });

  it("judges rules in declaration order and reports the whole catalogue each declares", async () => {
    const first = declared({}, { name: "aaa-first", reason: "first" });
    const second = declared({}, { name: "zzz-second", reason: "second" });
    const { decisions, catalogue } = await fold([second, first]);
    // Declaration order, not name order: a policy's row order is semantic.
    expect(decisions.map((decision) => decision.name)).toEqual(["zzz-second", "aaa-first"]);
    // Every entry a rule DECLARED, whether or not it fired — a rule described
    // only on the run that reported it would be nameless on the next.
    expect(catalogue).toEqual([
      {
        ruleId: `custom/zzz-second/${FINDING}`,
        rule: "zzz-second",
        findingId: FINDING,
        message: "the app layer reached a ring internal",
      },
      {
        ruleId: `custom/zzz-second/${OTHER_FINDING}`,
        rule: "zzz-second",
        findingId: OTHER_FINDING,
        message: "a reach this rule could not place in a file",
      },
      {
        ruleId: `custom/aaa-first/${FINDING}`,
        rule: "aaa-first",
        findingId: FINDING,
        message: "the app layer reached a ring internal",
      },
      {
        ruleId: `custom/aaa-first/${OTHER_FINDING}`,
        rule: "aaa-first",
        findingId: OTHER_FINDING,
        message: "a reach this rule could not place in a file",
      },
    ]);
  });
});

describe("load-class failures refuse the run", () => {
  it("refuses when the artifact yields no bytes, naming the rule and the reason", async () => {
    const rule = declared();
    // The silent direction, in one case: a policy declaring a rule whose
    // artifact is gone must not judge the tree without it and answer clean.
    await expect(
      customRulesForCheck(context(), {
        rows: [rule.row],
        policy: POLICY,
        readArtifact: () => null,
      }),
    ).rejects.toThrow(
      /custom rule "no-app-to-ring": the artifact "tools\/rules\/no-app-to-ring\.wasm" could not be read/u,
    );
  });

  it("refuses a hash mismatch, so the law CI ran is the law review saw", async () => {
    const rule = declared();
    const tampered = { ...rule, row: { ...rule.row, sha256: "0".repeat(64) } };
    await expect(fold([tampered])).rejects.toThrow(
      /custom rule "no-app-to-ring": the artifact hashes to [0-9a-f]{64}, and the policy pinned/u,
    );
  });

  it("refuses bytes that are not a module at all", async () => {
    const bytes = invalidWasmBytes();
    await expect(
      fold([
        {
          bytes,
          row: {
            name: RULE,
            artifact: `tools/rules/${RULE}.wasm`,
            sha256: sha256(bytes),
            reason: "r",
          },
        },
      ]),
    ).rejects.toThrow(/is not a valid WebAssembly module/u);
  });

  it("loads every declared rule before judging any, so a half-loadable law judges nothing", async () => {
    const good = declared({}, { name: "aaa-good" });
    const broken = declared({ omitExport: "archkeep_evaluate" }, { name: "zzz-broken" });
    const reads = [];
    await expect(fold([good, broken], { reads })).rejects.toThrow(
      /custom rule "zzz-broken": the module exports no function named "archkeep_evaluate"/u,
    );
    // Both artifacts were read — the refusal came from the loading pass, not
    // from a first rule that had already been judged and reported.
    expect(reads).toEqual(["tools/rules/aaa-good.wasm", "tools/rules/zzz-broken.wasm"]);
  });

  it("refuses when the evidence carries an import no project owns", async () => {
    // Attribution is the workspace layer's answer, supplied from the ownership
    // map. A site nothing claims is a site no rule can place, and dropping it
    // would judge the tree over evidence quietly missing a file.
    const orphaned = context({ owned: [{ file: "libs/ring/x.go", project: "ring" }] });
    await expect(fold([declared()], { commandContext: orphaned })).rejects.toThrow(
      /imports\[0\]\.sourceProject: must name the project the importing file belongs to/u,
    );
  });
});

describe("a path-scoped run", () => {
  it("answers not_applicable for every declared rule, and reads no artifact at all", async () => {
    const reads = [];
    const { decisions, overall, catalogue } = await fold([declared()], { scoped: true, reads });
    expect(overall.verdict).toBe("not_applicable");
    expect(decisions[0].verdict).toBe("not_applicable");
    expect(decisions[0].name).toBe(RULE);
    expect(decisions[0].reason).toBe("the ring stays private");
    expect(decisions[0].notApplicableReason).toContain("needs a full, unscoped run");
    // Nothing was loaded, so nothing can be described — and the row is still
    // there, loudly, rather than the rule vanishing from the run.
    expect(catalogue).toEqual([]);
    expect(reads).toEqual([]);
    // The declared digest is NOT presented as evidence: nothing hashed it.
    expect(decisions[0].evidence).toEqual({
      artifact: `tools/rules/${RULE}.wasm`,
      scoped: true,
    });
  });

  it("refuses nothing on a scoped run, even for an artifact that is gone", async () => {
    // The deliberate consequence of deciding before reading: a scoped run is
    // already a partial invocation, and it says so per rule rather than
    // failing on a law it was never going to apply.
    const rule = declared();
    const { decisions } = await customRulesForCheck(context(), {
      rows: [rule.row],
      policy: POLICY,
      scoped: true,
      readArtifact: () => null,
    });
    expect(decisions[0].verdict).toBe("not_applicable");
  });
});

describe("the facts this module puts on the wire", () => {
  // `observedFacts` reads a provider's graph, and a provider is free to leave
  // out what it has nothing to say about. Each fallback below is the branch
  // that decides what a rule SEES when it does — and a wrong one here is not
  // an exception anywhere, it is a rule judging a workspace that differs from
  // the real one in a way no failure names.

  it("files a node that states no name under the key it is filed at", async () => {
    // A graph whose node object carries no `name` is not a nameless project:
    // the key IS the name, and `buildEvidenceBundle` refuses a project without
    // one — so the fallback is what keeps a legitimate provider shape from
    // reaching the bundle's refusal as though the graph were unreadable.
    const graph = {
      nodes: {
        app: { data: { root: "libs/app", tags: ["layer-app"] } },
        ring: { name: "ring", data: { root: "libs/ring" } },
      },
      dependencies: {},
    };
    const bundle = await bundleFrom(context({ graph, owned: [], analysis: { imports: [] } }));

    expect(bundle.model.projects.map((project) => project.name)).toEqual(["app", "ring"]);
    expect(bundle.model.projects.find((project) => project.name === "app").root).toBe("libs/app");
  });

  it("carries an empty edge list for a graph that states no dependencies at all", async () => {
    // The state a provider reports for a workspace whose projects reach
    // nothing — and the one this fallback must not turn into a throw, because
    // "no edges" and "the graph could not be read" are the two claims the
    // whole contract exists to keep apart. The rule is handed an empty list,
    // which it can judge; there is nothing here to report as unknown.
    const graph = {
      nodes: { app: { name: "app", data: { root: "libs/app", tags: ["layer-app"] } } },
    };
    const bundle = await bundleFrom(context({ graph, owned: [], analysis: { imports: [] } }));

    expect(bundle.graph.edges).toEqual([]);
    expect(bundle.model.projects).toHaveLength(1);
  });

  it("reads a node's tags as the untagged project it is when the key is absent", async () => {
    // `ring` in the shared context carries no `tags`, and the empty list is a
    // FACT about it rather than a gap in what was read — the same reading
    // `../rules/` gives an untagged project.
    const bundle = await bundleFrom(context());
    expect(bundle.model.projects.find((project) => project.name === "ring").tags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// customRulesForDelta — the two-sided judgment
// ---------------------------------------------------------------------------

/**
 * A baseline snapshot shape holding exactly what the base side is rebuilt
 * from: the stored graph rows, the stored records, and the custom-rule pair.
 * The base tree differs from the head context (`context()` above) by one
 * import site, so a rule that echoes evidence could tell the sides apart.
 */
function baselineOf(overrides = {}) {
  return {
    graph: {
      projects: [
        { name: "app", root: "libs/app", tags: ["layer-app"] },
        { name: "ring", root: "libs/ring", tags: [] },
      ],
      dependencies: [{ source: "app", target: "ring", type: "static" }],
    },
    records: [
      {
        sourceFile: "libs/app/main.go",
        line: 7,
        column: 2,
        specifier: "example.test/ring/internal",
        kind: "static",
      },
    ],
    owned: [
      { file: "libs/app/main.go", project: "app" },
      { file: "libs/ring/x.go", project: "ring" },
    ],
    ...overrides,
  };
}

/**
 * The evidence-size threshold the asymmetric-applicability tests key a
 * `"by-length"` rule on: the base bundle (two projects, one edge, one short
 * import) serializes well under it, and `widerHeadContext` pushes the head
 * bundle well past it with one deliberately long specifier — so one module
 * answers the two sides differently while both run the identical bytes.
 */
const ASYMMETRY_THRESHOLD = 4096;

/** The head tree with one extra import whose specifier crosses the threshold. */
function widerHeadContext() {
  const base = context();
  return context({
    owned: [...base.owned, { file: "libs/app/big.go", project: "app" }],
    analysis: {
      imports: [
        ...base.analysis.imports,
        {
          sourceFile: "libs/app/big.go",
          line: 1,
          column: 1,
          specifier: `example.test/ring/${"pad".repeat(2000)}`,
          kind: "static",
        },
      ],
    },
  });
}

/** Drives the two-sided fold with an in-memory artifact store. */
function deltaFold(rules, { baseline, reads = [], commandContext = context() }) {
  const bytesFor = new Map(rules.map(({ row, bytes }) => [row.artifact, bytes]));
  return customRulesForDelta(commandContext, {
    rows: rules.map(({ row }) => row),
    policy: POLICY,
    baseline,
    readArtifact: (artifact) => {
      reads.push(artifact);
      return bytesFor.get(artifact) ?? null;
    },
  });
}

describe("customRulesForDelta", () => {
  it("judges a rule whose baseline row pins the identical law, over both sides", async () => {
    const rule = declared({
      verdictJson: verdictJson({
        verdict: "fail",
        findings: [{ id: FINDING, message: "reached", project: "app" }],
      }),
    });
    const baseline = baselineOf({
      customRules: [{ name: RULE, artifact: rule.row.artifact, sha256: rule.row.sha256 }],
    });
    const { judged, unknownRules, removedRules, catalogue } = await deltaFold([rule], {
      baseline,
    });
    expect(unknownRules).toEqual([]);
    expect(removedRules).toEqual([]);
    expect(judged).toHaveLength(1);
    expect(judged[0].name).toBe(RULE);
    expect(judged[0].sha256).toBe(rule.row.sha256);
    // Both sides carry the verdict document's findings verbatim —
    // un-namespaced, because the classifier owns the entry's spelling.
    expect(judged[0].baseFindings).toEqual([{ id: FINDING, message: "reached", project: "app" }]);
    expect(judged[0].headFindings).toEqual(judged[0].baseFindings);
    expect(catalogue.map((entry) => entry.ruleId)).toEqual([
      `custom/${RULE}/${FINDING}`,
      `custom/${RULE}/${OTHER_FINDING}`,
    ]);
  });

  it("routes digest drift to unknownRules, naming both digests, and reads no artifact", async () => {
    const rule = declared();
    const baseline = baselineOf({
      customRules: [{ name: RULE, artifact: rule.row.artifact, sha256: "0".repeat(64) }],
    });
    const reads = [];
    const { judged, unknownRules } = await deltaFold([rule], { baseline, reads });
    expect(judged).toEqual([]);
    expect(unknownRules).toHaveLength(1);
    expect(unknownRules[0].name).toBe(RULE);
    expect(unknownRules[0].reason).toContain("0".repeat(64));
    expect(unknownRules[0].reason).toContain(rule.row.sha256);
    expect(unknownRules[0].reason).toContain("law itself moved");
    // The silent direction: a drifted law must not be RUN and its findings
    // must not classify — nothing was even loaded for it.
    expect(reads).toEqual([]);
  });

  it("routes params drift to unknownRules — params ride the evidence, so they are law", async () => {
    const rule = declared();
    const withParams = { ...rule, row: { ...rule.row, params: { limit: 3 } } };
    const baseline = baselineOf({
      customRules: [
        {
          name: RULE,
          artifact: rule.row.artifact,
          sha256: rule.row.sha256,
          params: { limit: 4 },
        },
      ],
    });
    const { judged, unknownRules } = await deltaFold([withParams], { baseline });
    expect(judged).toEqual([]);
    expect(unknownRules[0].reason).toContain("params changed");
  });

  it("routes a rule the baseline never declared to unknownRules", async () => {
    const rule = declared();
    const baseline = baselineOf({ customRules: [] });
    const { judged, unknownRules } = await deltaFold([rule], { baseline });
    expect(judged).toEqual([]);
    expect(unknownRules[0].reason).toContain("no base-side evidence exists");
  });

  it("routes EVERY head rule to unknownRules when the baseline carries no custom blocks", async () => {
    // An old baseline, or one captured before the rules were declared: its
    // absence of blocks must never read as "no custom findings existed at
    // base" — that is the silent direction.
    const rule = declared();
    const { owned: _owned, ...old } = baselineOf();
    const reads = [];
    const { judged, unknownRules, removedRules } = await deltaFold([rule], {
      baseline: old,
      reads,
    });
    expect(judged).toEqual([]);
    expect(removedRules).toEqual([]);
    expect(unknownRules[0].reason).toContain("re-capture the baseline");
    expect(reads).toEqual([]);
  });

  it("names rules the baseline declares that the head no longer does as removed", async () => {
    const rule = declared();
    const baseline = baselineOf({
      customRules: [
        { name: RULE, artifact: rule.row.artifact, sha256: rule.row.sha256 },
        { name: "gone-rule", artifact: "tools/rules/gone-rule.wasm", sha256: "1".repeat(64) },
      ],
    });
    const { judged, removedRules } = await deltaFold([rule], { baseline });
    expect(judged).toHaveLength(1);
    expect(removedRules).toEqual(["gone-rule"]);
  });

  it("routes a rule that answers unknown to unknownRules, naming the side and its reason", async () => {
    const rule = declared({
      verdictJson: verdictJson({ verdict: "unknown", reason: "no layer tags to compare" }),
    });
    const baseline = baselineOf({
      customRules: [{ name: RULE, artifact: rule.row.artifact, sha256: rule.row.sha256 }],
    });
    const { judged, unknownRules } = await deltaFold([rule], { baseline });
    // The whole rule, not half of it: a one-sided judgment has no delta.
    expect(judged).toEqual([]);
    expect(unknownRules[0].reason).toContain("base side");
    expect(unknownRules[0].reason).toContain("no layer tags to compare");
  });

  it("routes an evaluate-class failure to unknownRules, never a pass by omission", async () => {
    const rule = declared({ evaluateBehavior: "trap" });
    const baseline = baselineOf({
      customRules: [{ name: RULE, artifact: rule.row.artifact, sha256: rule.row.sha256 }],
    });
    const { judged, unknownRules } = await deltaFold([rule], { baseline });
    expect(judged).toEqual([]);
    expect(unknownRules[0].reason).toContain("archkeep_evaluate trapped");
  });

  it("carries a not_applicable side as empty findings plus a note — a judged answer, not a failure", async () => {
    const rule = declared({
      verdictJson: verdictJson({
        verdict: "not_applicable",
        notApplicableReason: "this workspace declares no ring project",
      }),
    });
    const baseline = baselineOf({
      customRules: [{ name: RULE, artifact: rule.row.artifact, sha256: rule.row.sha256 }],
    });
    const { judged, unknownRules } = await deltaFold([rule], { baseline });
    expect(unknownRules).toEqual([]);
    expect(judged[0].baseFindings).toEqual([]);
    expect(judged[0].headFindings).toEqual([]);
    expect(judged[0].notes).toEqual([
      "base side: not applicable — this workspace declares no ring project",
      "head side: not applicable — this workspace declares no ring project",
    ]);
  });

  it("routes head-side not_applicable beside base findings to unknownRules — never resolved", async () => {
    // The silent direction: an empty head list from a rule that did not APPLY
    // at head would classify every base finding as resolved. The rule answers
    // by evidence size — the head context below carries one extra, very long
    // import, so the identical bytes judge the base side and refuse the head.
    const rule = declared({
      evaluateBehavior: "by-length",
      alternateWhenLengthAtLeast: ASYMMETRY_THRESHOLD,
      verdictJson: verdictJson({
        verdict: "fail",
        findings: [{ id: FINDING, message: "reached", project: "app" }],
      }),
      verdictJsonAlternate: verdictJson({
        verdict: "not_applicable",
        notApplicableReason: "the head tree declares no ring project",
      }),
    });
    const baseline = baselineOf({
      customRules: [{ name: RULE, artifact: rule.row.artifact, sha256: rule.row.sha256 }],
    });
    const { judged, unknownRules } = await deltaFold([rule], {
      baseline,
      commandContext: widerHeadContext(),
    });
    expect(judged).toEqual([]);
    expect(unknownRules).toHaveLength(1);
    expect(unknownRules[0].reason).toContain("did not apply at head");
    expect(unknownRules[0].reason).toContain("cannot be called resolved");
    expect(unknownRules[0].reason).toContain("the head tree declares no ring project");
  });

  it("routes base-side not_applicable beside head findings to unknownRules — never introduced", async () => {
    // The mirror image: an empty base list from a rule that did not APPLY at
    // base would classify every head finding as introduced.
    const rule = declared({
      evaluateBehavior: "by-length",
      alternateWhenLengthAtLeast: ASYMMETRY_THRESHOLD,
      verdictJson: verdictJson({
        verdict: "not_applicable",
        notApplicableReason: "the base capture declares no ring project",
      }),
      verdictJsonAlternate: verdictJson({
        verdict: "fail",
        findings: [{ id: FINDING, message: "reached", project: "app" }],
      }),
    });
    const baseline = baselineOf({
      customRules: [{ name: RULE, artifact: rule.row.artifact, sha256: rule.row.sha256 }],
    });
    const { judged, unknownRules } = await deltaFold([rule], {
      baseline,
      commandContext: widerHeadContext(),
    });
    expect(judged).toEqual([]);
    expect(unknownRules).toHaveLength(1);
    expect(unknownRules[0].reason).toContain("did not apply at base");
    expect(unknownRules[0].reason).toContain("cannot be called introduced");
  });

  it("hands the caller's timeoutMs to the host — a looping rule is refused under that budget", async () => {
    // The silent direction of a dropped option: a timeout that never reached
    // the host would leave a hostile rule the full default budget, and a
    // pipeline that believed it had bounded the run would be wrong with no
    // symptom until it hung. The reason naming the caller's own number is the
    // proof the value arrived.
    const rule = declared({ evaluateBehavior: "loop" });
    const baseline = baselineOf({
      customRules: [{ name: RULE, artifact: rule.row.artifact, sha256: rule.row.sha256 }],
    });
    const bytesFor = new Map([[rule.row.artifact, rule.bytes]]);
    const { judged, unknownRules } = await customRulesForDelta(context(), {
      rows: [rule.row],
      policy: POLICY,
      baseline,
      readArtifact: (artifact) => bytesFor.get(artifact) ?? null,
      timeoutMs: 400,
    });
    expect(judged).toEqual([]);
    expect(unknownRules[0].reason).toContain("400ms budget");
  });

  it("routes a base record the stored owned map does not claim to unknownRules", async () => {
    // The stored map is the only attribution the base side has; a record it
    // does not claim is evidence the bundle refuses, and the rule must say so
    // rather than being judged over the records that survived.
    const rule = declared();
    const baseline = baselineOf({
      customRules: [{ name: RULE, artifact: rule.row.artifact, sha256: rule.row.sha256 }],
      owned: [{ file: "libs/ring/x.go", project: "ring" }],
    });
    const { judged, unknownRules } = await deltaFold([rule], { baseline });
    expect(judged).toEqual([]);
    expect(unknownRules[0].reason).toContain("base-side evidence could not be assembled");
    expect(unknownRules[0].reason).toContain("sourceProject");
  });

  it("THROWS on a load-class failure — an unreadable head law refuses the delta", async () => {
    const rule = declared();
    const baseline = baselineOf({
      customRules: [{ name: RULE, artifact: rule.row.artifact, sha256: rule.row.sha256 }],
    });
    await expect(
      customRulesForDelta(context(), {
        rows: [rule.row],
        policy: POLICY,
        baseline,
        readArtifact: () => null,
      }),
    ).rejects.toThrow(/custom rule "no-app-to-ring": the artifact .* could not be read/u);
  });

  it("THROWS on a hash mismatch between the head bytes and the head declaration", async () => {
    const rule = declared();
    const tampered = { bytes: invalidWasmBytes(), row: rule.row };
    const baseline = baselineOf({
      customRules: [{ name: RULE, artifact: rule.row.artifact, sha256: rule.row.sha256 }],
    });
    await expect(deltaFold([tampered], { baseline })).rejects.toThrow(
      /the artifact hashes to [0-9a-f]{64}, and the policy pinned/u,
    );
  });
});

describe("what a decision says it found", () => {
  it("counts one finding in the singular", async () => {
    // Two findings are covered above; one is its own branch, and a message
    // reading "reported 1 findings" is the kind of thing a reader stops
    // trusting the rest of the line over.
    const { decisions } = await fold([
      declared({
        verdictJson: verdictJson({
          verdict: "fail",
          findings: [{ id: FINDING, message: "the app layer reached a ring internal" }],
        }),
      }),
    ]);

    expect(decisions[0].verdict).toBe("fail");
    expect(decisions[0].message).toBe("reported 1 finding");
    expect(decisions[0].evidence.findings).toBe(1);
  });
});

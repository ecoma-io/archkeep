import { describe, expect, it, vi } from "vitest";

// Both collaborators are mocked so this pins the TRANSFORM and not the content
// of the message table: the catalogue must be derived from whatever ids exist,
// which a fake two-id table proves and the real fifteen-id one would not
// (a hard-coded catalogue passes against the real table until upstream adds a
// sixteenth). `sarif.integration.test.mjs` drives the real pair.
vi.mock("../rules/messages.mjs", () => ({
  MESSAGE_IDS: ["firstRule", "secondRule"],
  MESSAGES: {
    firstRule: "First rule says {{what}}",
    secondRule: "Second rule says {{what}}\n\nAnd then some detail",
  },
}));
vi.mock("../go-work.mjs", () => ({
  GO_WORK_MESSAGE_IDS: ["driftRule"],
  GO_WORK_MESSAGES: { driftRule: "Drift rule's summary line\n\nAnd its detail" },
}));
vi.mock("../tsconfig-paths.mjs", () => ({
  TSCONFIG_PATHS_MESSAGE_IDS: ["deadAliasRule"],
  TSCONFIG_PATHS_MESSAGES: { deadAliasRule: "Dead alias rule's summary line\n\nAnd its detail" },
}));
vi.mock("../architecture-intent/judge.mjs", () => ({
  INTENT_MESSAGE_IDS: ["intentForbiddenEdge"],
  INTENT_MESSAGES: {
    intentForbiddenEdge: "Forbidden edge's summary line\n\nAnd its detail",
  },
}));
vi.mock("./text.mjs", () => ({ formatConstraint: () => "THE CONSTRAINT" }));

import {
  buildDeltaSarifLog,
  buildSarifLog,
  formatDeltaSarif,
  formatSarif,
  sarifCoverageGapNotification,
  sarifCustomRuleNotification,
  sarifCustomRuleResult,
  sarifDeltaResult,
  sarifFitnessNotification,
  sarifFitnessResult,
  sarifIntentNotification,
  sarifIntentResult,
  sarifRules,
  toUriReference,
} from "./sarif.mjs";

const violation = () => ({
  sourceFile: "acme/libs/engine-domain/doc.go",
  line: 12,
  column: 23,
  specifier: "example.com/acme/engine-adapters",
  kind: "static",
  messageId: "secondRule",
  message: "Second rule says no",
  sourceProject: "engine-domain",
  targetProject: "engine-adapters",
  constraint: { sourceTag: "layer:domain" },
  data: {},
});

const log = (overrides = {}) =>
  buildSarifLog({ violations: [], failures: [], ...overrides }).runs[0];

describe("the SARIF envelope", () => {
  it("declares the 2.1.0 schema and version GitHub validates the upload against", () => {
    const built = buildSarifLog({ violations: [], failures: [] });
    expect(built.version).toBe("2.1.0");
    expect(built.$schema).toContain("sarif-2.1.0");
  });

  it("states the column convention the analyzers actually use, rather than leaving it to a default", () => {
    // Columns count UTF-16 code units (../analysis/source-util.mjs). A consumer
    // assuming code points lands in the wrong column on any line with an emoji.
    expect(log().columnKind).toBe("utf16CodeUnits");
  });

  it("reports the run as successful even when it found violations, so GitHub keeps the results", () => {
    const [invocation] = log({ violations: [violation()] }).invocations;
    expect(invocation.executionSuccessful).toBe(true);
  });

  it("names the law that governed the run in the run-level property bag (P1-01)", () => {
    // A code-scanning consumer reading two uploads side by side could not
    // otherwise tell a strict run from one under a weaker policy — both a
    // clean and a violating log carried nothing naming the config, profile,
    // or fingerprint that produced it.
    const built = log({
      policy: { profile: "strict", source: "law-profiles.json", fingerprint: "deadbeef" },
    });
    expect(built.properties.policy).toEqual({
      profile: "strict",
      source: "law-profiles.json",
      fingerprint: "deadbeef",
    });
  });

  it("states a file-selected (non-profile) policy the same way, with profile null", () => {
    const built = log({
      policy: { profile: null, source: "module-boundaries.config.mjs", fingerprint: "cafef00d" },
    });
    expect(built.properties.policy).toEqual({
      profile: null,
      source: "module-boundaries.config.mjs",
      fingerprint: "cafef00d",
    });
  });

  it("carries no properties bag at all when no caller supplied a policy — unchanged bytes for any caller that predates it", () => {
    expect(log()).not.toHaveProperty("properties");
  });
});

describe("the rule catalogue", () => {
  it("lists every message id the engine can produce, not only the ones that fired", () => {
    // A catalogue that grew with the findings would describe a rule on the run
    // that reported it and leave it nameless on the next. The go.work drift
    // ids come after the upstream ones and the paths hygiene ids after those,
    // so every existing ruleIndex is stable.
    expect(sarifRules().map((rule) => rule.id)).toEqual([
      "firstRule",
      "secondRule",
      "driftRule",
      "deadAliasRule",
      "intentForbiddenEdge",
      "fitnessFunctionFailed",
    ]);
    expect(log().tool.driver.rules).toHaveLength(6);
  });

  it("keeps the whole template as the description and its first line as the summary", () => {
    const [, second] = sarifRules();
    expect(second.shortDescription.text).toBe("Second rule says {{what}}");
    expect(second.fullDescription.text).toContain("And then some detail");
  });

  it("configures every rule as an error, because this report exists to block a merge", () => {
    expect(sarifRules().every((rule) => rule.defaultConfiguration.level === "error")).toBe(true);
  });
});

describe("a result", () => {
  it("uses the upstream messageId as ruleId, and an index that points at that rule", () => {
    const [result] = log({ violations: [violation()] }).results;
    expect(result.ruleId).toBe("secondRule");
    expect(log().tool.driver.rules[result.ruleIndex].id).toBe("secondRule");
  });

  it("locates the finding at the workspace-relative path with 1-based line and column", () => {
    const [result] = log({ violations: [violation()] }).results;
    const { artifactLocation, region } = result.locations[0].physicalLocation;
    expect(artifactLocation.uri).toBe("acme/libs/engine-domain/doc.go");
    expect(region).toEqual({ startLine: 12, startColumn: 23 });
  });

  it("adds the import and the constraint to the message, the only text GitHub renders", () => {
    const [result] = log({ violations: [violation()] }).results;
    expect(result.message.text).toContain("Second rule says no");
    expect(result.message.text).toContain('Import "example.com/acme/engine-adapters"');
    expect(result.message.text).toContain("Constraint: THE CONSTRAINT");
  });

  it("spells a violation with no source or target project as the placeholder forms", () => {
    // A violation for a loose file importing an external package carries
    // neither project; the rendered detail must say so, never print undefined.
    const v = violation();
    delete v.sourceProject;
    delete v.targetProject;
    const [result] = log({ violations: [v] }).results;
    expect(result.message.text).toContain("from (no project)");
    expect(result.message.text).toContain("to (unresolved)");
  });

  it("keeps the upstream message verbatim in the property bag, so a comparison still has it", () => {
    const [result] = log({ violations: [violation()] }).results;
    expect(result.properties.upstreamMessage).toBe("Second rule says no");
  });

  it("includes the constraint's description and remediation in the property bag when present", () => {
    const v = violation();
    v.constraint = {
      sourceTag: "layer:domain",
      description: "Domain isolation",
      remediation: "Use an interface",
    };
    const [result] = log({ violations: [v] }).results;
    expect(result.properties.ruleDescription).toBe("Domain isolation");
    expect(result.properties.remediation).toBe("Use an interface");
  });

  it("omits description and remediation from the property bag when the constraint carries none", () => {
    const [result] = log({ violations: [violation()] }).results;
    expect(result.properties.ruleDescription).toBeUndefined();
    expect(result.properties.remediation).toBeUndefined();
  });
});

describe("a waived violation", () => {
  it("stays a result — error-level, in the list — with the acceptance facts in the property bag", () => {
    const v = violation();
    v.waivedBy = {
      path: "acme/libs/engine-domain/*",
      expiresAt: "2026-09-01T00:00:00.000Z",
      reason: "temp seam",
    };
    const [result] = log({ violations: [v] }).results;
    expect(result.level).toBe("error");
    expect(result.properties.accepted).toBe(true);
    expect(result.properties.acceptedUntil).toBe("2026-09-01T00:00:00.000Z");
    expect(result.properties.acceptedReason).toBe("temp seam");
  });

  it("carries no acceptance properties on a plain violation, so an unchanged tree's SARIF is unchanged", () => {
    const [result] = log({ violations: [violation()] }).results;
    expect(result.properties.accepted).toBeUndefined();
  });

  it("rides a warning notification naming the accepted count — a run still failing, never a green upload", () => {
    const v = violation();
    v.waivedBy = {
      path: "acme/libs/engine-domain/*",
      expiresAt: "2026-09-01T00:00:00.000Z",
      reason: "temp seam",
    };
    const built = log({ violations: [v] });
    const notifications = built.invocations[0].toolExecutionNotifications;
    expect(notifications[0].level).toBe("warning");
    expect(notifications[0].message.text).toContain("1 boundary violation accepted by waiver");
    expect(notifications[0].message.text).toContain("run stays non-zero");
  });

  it("re-asserted violations carry the evidence in the property bag", () => {
    const v = violation();
    v.evidence = "expired waiver";
    const [result] = log({ violations: [v] }).results;
    expect(result.properties.evidence).toBe("expired waiver");
  });
});

describe("a go.work drift finding", () => {
  const finding = (overrides = {}) => ({
    messageId: "driftRule",
    file: "go.work",
    line: 4,
    column: 2,
    directory: "libs/gone",
    project: null,
    message: "the drift, spelled out",
    ...overrides,
  });

  it("is a result whose ruleId resolves in the catalogue, exactly like a violation's", () => {
    // A drift finding that only reached the exit code would leave a
    // code-scanning consumer looking at a red job with an empty upload.
    const built = log({ goWork: { findings: [finding()], moduleProjects: 2 } });
    const [result] = built.results;
    expect(result.ruleId).toBe("driftRule");
    expect(built.tool.driver.rules[result.ruleIndex].id).toBe("driftRule");
    expect(result.level).toBe("error");
    expect(result.message.text).toBe("the drift, spelled out");
    expect(result.locations[0].physicalLocation).toEqual({
      artifactLocation: { uri: "go.work" },
      region: { startLine: 4, startColumn: 2 },
    });
  });

  it("carries no region for a missing-use finding, rather than a fabricated line 1", () => {
    const built = log({
      goWork: { findings: [finding({ line: null, column: null })], moduleProjects: 2 },
    });
    expect(built.results[0].locations[0].physicalLocation.region).toBeUndefined();
  });

  it("appears beside the violations, neither replacing the other", () => {
    const built = log({
      violations: [violation()],
      goWork: { findings: [finding()], moduleProjects: 2 },
    });
    expect(built.results.map((result) => result.ruleId)).toEqual(["secondRule", "driftRule"]);
  });
});

describe("a dead tsconfig path alias finding", () => {
  const deadAlias = (overrides = {}) => ({
    messageId: "deadAliasRule",
    file: "tsconfig.base.json",
    line: null,
    column: null,
    alias: "@acme/gone",
    targets: ["libs/gone/src/index.ts"],
    message: "the dead alias, spelled out",
    ...overrides,
  });

  it("is a result whose ruleId resolves in the catalogue, exactly like a violation's", () => {
    // A dead alias that only reached the exit code would leave a code-scanning
    // consumer looking at a red job with an empty upload — the same reasoning
    // as a drift finding.
    const built = log({ tsconfigPaths: { findings: [deadAlias()], aliases: 3, unjudged: 0 } });
    const [result] = built.results;
    expect(result.ruleId).toBe("deadAliasRule");
    expect(built.tool.driver.rules[result.ruleIndex].id).toBe("deadAliasRule");
    expect(result.level).toBe("error");
    expect(result.message.text).toBe("the dead alias, spelled out");
    expect(result.properties).toEqual({
      alias: "@acme/gone",
      targets: ["libs/gone/src/index.ts"],
    });
  });

  it("carries the artifact alone and no region — the finding is positionless by construction", () => {
    const built = log({ tsconfigPaths: { findings: [deadAlias()], aliases: 1, unjudged: 0 } });
    expect(built.results[0].locations[0].physicalLocation).toEqual({
      artifactLocation: { uri: "tsconfig.base.json" },
    });
  });

  it("appears beside the violations and the drift findings, none replacing another", () => {
    const built = log({
      violations: [violation()],
      goWork: {
        findings: [
          {
            messageId: "driftRule",
            file: "go.work",
            line: 4,
            column: 2,
            directory: "libs/gone",
            project: null,
            message: "the drift",
          },
        ],
        moduleProjects: 2,
      },
      tsconfigPaths: { findings: [deadAlias()], aliases: 1, unjudged: 0 },
    });
    expect(built.results.map((result) => result.ruleId)).toEqual([
      "secondRule",
      "driftRule",
      "deadAliasRule",
    ]);
  });
});

describe("an architecture-intent finding", () => {
  const intentFinding = (overrides = {}) => ({
    rule: "intentForbiddenEdge",
    source: "acme/libs/engine-domain",
    target: "acme/libs/engine-adapters",
    boundaryFrom: "domain",
    boundaryTo: "adapters",
    message: "core → adapters — architecture-intent.json forbids this reach",
    ...overrides,
  });

  it("is a result whose ruleId resolves in the catalogue, exactly like a violation's", () => {
    const built = log({ intent: { findings: [intentFinding()] } });
    const [result] = built.results;
    expect(result.ruleId).toBe("intentForbiddenEdge");
    expect(built.tool.driver.rules[result.ruleIndex].id).toBe("intentForbiddenEdge");
    expect(result.ruleIndex).toBe(
      // MESSAGE_IDS + GO_WORK_MESSAGE_IDS + TSCONFIG_PATHS_MESSAGE_IDS offsets.
      2 + 1 + 1,
    );
    expect(result.level).toBe("error");
    expect(result.message.text).toBe(
      "core → adapters — architecture-intent.json forbids this reach",
    );
    expect(result.properties).toEqual({
      source: "acme/libs/engine-domain",
      target: "acme/libs/engine-adapters",
      boundaryFrom: "domain",
      boundaryTo: "adapters",
    });
  });

  it("carries the intent file alone and no region — the finding is positionless by construction", () => {
    const built = log({ intent: { findings: [intentFinding()] } });
    expect(built.results[0].locations[0].physicalLocation).toEqual({
      artifactLocation: { uri: "architecture-intent.json" },
    });
  });

  it("appears beside the violations, drift findings and dead aliases, none replacing another", () => {
    const built = log({
      violations: [violation()],
      goWork: {
        findings: [
          {
            messageId: "driftRule",
            file: "go.work",
            line: 4,
            column: 2,
            directory: "libs/gone",
            project: null,
            message: "the drift",
          },
        ],
        moduleProjects: 2,
      },
      tsconfigPaths: {
        findings: [
          {
            messageId: "deadAliasRule",
            file: "tsconfig.base.json",
            line: null,
            column: null,
            alias: "@acme/gone",
            targets: ["libs/gone/src/index.ts"],
            message: "the dead alias",
          },
        ],
        aliases: 1,
        unjudged: 0,
      },
      intent: { findings: [intentFinding()] },
    });
    expect(built.results.map((result) => result.ruleId)).toEqual([
      "secondRule",
      "driftRule",
      "deadAliasRule",
      "intentForbiddenEdge",
    ]);
  });

  it("renders directly, not only through buildSarifLog", () => {
    const result = sarifIntentResult(intentFinding());
    expect(result.ruleId).toBe("intentForbiddenEdge");
    expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe(
      "architecture-intent.json",
    );
  });
});

describe("an unresolved architecture-intent boundary", () => {
  const noVerdict = (overrides = {}) => ({
    verdict: "no-verdict",
    findings: [],
    boundaries: [{ name: "domain" }],
    unresolved: [{ boundary: "domain", issue: "matched no observed project" }],
    ...overrides,
  });

  it("is not the log a clean run uploads — the silent direction this closes", () => {
    // The defect: `check` exits 3 on this intent while the SARIF it uploaded
    // was byte-identical to the one from a workspace with no intent at all.
    expect(buildSarifLog({ violations: [], failures: [], intent: noVerdict() })).not.toEqual(
      buildSarifLog({ violations: [], failures: [], intent: null }),
    );
  });

  it("rides one notification per boundary, naming the boundary and its issue", () => {
    const built = log({
      intent: noVerdict({
        unresolved: [
          { boundary: "domain", issue: "matched no observed project" },
          { boundary: "adapters", issue: "the row's target side matched nothing" },
        ],
      }),
    });
    expect(built.invocations[0].toolExecutionNotifications.map((n) => n.message.text)).toEqual([
      'architecture-intent.json reached no verdict on boundary "domain": matched no observed project',
      'architecture-intent.json reached no verdict on boundary "adapters": the row\'s target side matched nothing',
    ]);
    expect(
      built.invocations[0].toolExecutionNotifications.every((n) => n.level === "warning"),
    ).toBe(true);
  });

  it("is never a result — nothing judged that boundary, so no error-level annotation claims one", () => {
    expect(log({ intent: noVerdict() }).results).toEqual([]);
  });

  it("speaks even when the no-verdict names no boundary, rather than falling back to silence", () => {
    const built = log({ intent: noVerdict({ unresolved: [] }) });
    const [notification] = built.invocations[0].toolExecutionNotifications;
    expect(notification.level).toBe("warning");
    expect(notification.message.text).toContain("reached no verdict and named no boundary");
  });

  it("says nothing at all for a clean intent, so the fix cannot pass by notifying unconditionally", () => {
    const built = log({
      intent: { verdict: "ok", findings: [], unresolved: [], boundaries: [{ name: "domain" }] },
    });
    expect(built.results).toEqual([]);
    expect(built.invocations[0].toolExecutionNotifications).toEqual([]);
  });

  it("renders directly, not only through buildSarifLog", () => {
    expect(
      sarifIntentNotification({ boundary: "domain", issue: "matched no observed project" }),
    ).toEqual({
      level: "warning",
      message: {
        text: 'architecture-intent.json reached no verdict on boundary "domain": matched no observed project',
      },
    });
  });
});

describe("a fitness finding (bug A)", () => {
  // Before this fix, `buildSarifLog` had no fitness arm at all: `check
  // --format sarif` exits 1 on a `fail`-verdict fitness function
  // (`cli.mjs`'s `verdictFor`, `fitnessFail`) while this module produced zero
  // results and zero notifications for it — a red CI job with an empty
  // upload, the exact silent SARIF the rest of this file's kinds already
  // guard against.
  const failDecision = (overrides = {}) => ({
    name: "domain-may-not-reach-adapter",
    verdict: "fail",
    message: '1 edge carries "layer:domain" → "layer:adapter" — forbidden',
    ...overrides,
  });
  const unknownDecision = (overrides = {}) => ({
    name: "full-coverage",
    verdict: "unknown",
    message: "coverage-minimum cannot be judged for a scoped run",
    ...overrides,
  });

  it("is a result whose ruleId resolves in the catalogue, exactly like a violation's", () => {
    const built = log({ fitness: [failDecision()] });
    const [result] = built.results;
    expect(result.ruleId).toBe("fitnessFunctionFailed");
    expect(built.tool.driver.rules[result.ruleIndex].id).toBe("fitnessFunctionFailed");
    expect(result.level).toBe("error");
    expect(result.message.text).toContain("domain-may-not-reach-adapter");
    expect(result.message.text).toContain("forbidden");
    expect(result.properties.name).toBe("domain-may-not-reach-adapter");
  });

  it("carries the boundary policy file alone and no region — the finding is positionless by construction", () => {
    const built = log({
      fitness: [failDecision()],
      policy: { profile: null, source: "module-boundaries.config.mjs", fingerprint: "cafef00d" },
    });
    expect(built.results[0].locations[0].physicalLocation).toEqual({
      artifactLocation: { uri: "module-boundaries.config.mjs" },
    });
  });

  it("carries no locations at all when this run resolved no policy source — defensive, never a fabricated path", () => {
    const built = log({ fitness: [failDecision()] });
    expect(built.results[0].locations).toBeUndefined();
  });

  it("a pass or not_applicable decision produces neither a result nor a notification", () => {
    const built = log({
      fitness: [
        { name: "clean", verdict: "pass", message: "1 matched project, no violation" },
        {
          name: "unrelated",
          verdict: "not_applicable",
          message: "matches nothing",
          notApplicableReason: "no matched project",
        },
      ],
    });
    expect(built.results).toEqual([]);
    expect(built.invocations[0].toolExecutionNotifications).toEqual([]);
  });

  it("an unknown-verdict decision rides a notification, not a result — trouble the tool hit, not a verdict it reached", () => {
    const built = log({ fitness: [unknownDecision()] });
    expect(built.results).toEqual([]);
    const [notification] = built.invocations[0].toolExecutionNotifications;
    expect(notification.level).toBe("warning");
    expect(notification.message.text).toContain("full-coverage");
    expect(notification.message.text).toContain("could not be determined");
  });

  it("appears beside the violations, drift findings, dead aliases and intent findings, none replacing another", () => {
    const built = log({
      violations: [violation()],
      goWork: {
        findings: [
          {
            messageId: "driftRule",
            file: "go.work",
            line: 4,
            column: 2,
            directory: "libs/gone",
            project: null,
            message: "the drift",
          },
        ],
        moduleProjects: 2,
      },
      tsconfigPaths: {
        findings: [
          {
            messageId: "deadAliasRule",
            file: "tsconfig.base.json",
            line: null,
            column: null,
            alias: "@acme/gone",
            targets: ["libs/gone/src/index.ts"],
            message: "the dead alias",
          },
        ],
        aliases: 1,
        unjudged: 0,
      },
      intent: {
        findings: [
          {
            rule: "intentForbiddenEdge",
            source: "acme/libs/engine-domain",
            target: "acme/libs/engine-adapters",
            boundaryFrom: "domain",
            boundaryTo: "adapters",
            message: "core → adapters — architecture-intent.json forbids this reach",
          },
        ],
      },
      fitness: [failDecision()],
    });
    expect(built.results.map((result) => result.ruleId)).toEqual([
      "secondRule",
      "driftRule",
      "deadAliasRule",
      "intentForbiddenEdge",
      "fitnessFunctionFailed",
    ]);
  });

  it("renders directly, not only through buildSarifLog", () => {
    const result = sarifFitnessResult(failDecision(), "module-boundaries.config.mjs");
    expect(result.ruleId).toBe("fitnessFunctionFailed");
    expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe(
      "module-boundaries.config.mjs",
    );
    const notification = sarifFitnessNotification(unknownDecision());
    expect(notification.level).toBe("warning");
    expect(notification.message.text).toContain("full-coverage");
  });
});

describe("analysis failures", () => {
  it("travel as tool notifications, never as results — a blind spot is not a finding", () => {
    const built = log({
      failures: [{ sourceFile: "a/b.ts", line: 3, column: 8, reason: "cannot resolve 'x'" }],
    });
    expect(built.results).toEqual([]);
    const [notification] = built.invocations[0].toolExecutionNotifications;
    expect(notification.level).toBe("warning");
    expect(notification.message.text).toBe("cannot resolve 'x'");
    expect(notification.locations[0].physicalLocation.region).toEqual({
      startLine: 3,
      startColumn: 8,
    });
  });

  it("carry no region when the failure is about the file as a whole, rather than a fabricated line 1", () => {
    const built = log({
      failures: [{ sourceFile: "a/b.rs", line: null, column: null, reason: "unreadable" }],
    });
    const [notification] = built.invocations[0].toolExecutionNotifications;
    expect(notification.locations[0].physicalLocation.region).toBeUndefined();
  });
});

describe("path encoding", () => {
  it("leaves an ordinary path byte-identical, so the common case is unchanged", () => {
    expect(toUriReference("acme/libs/ui/src/index.ts")).toBe("acme/libs/ui/src/index.ts");
  });

  it("escapes what would otherwise break the URI, and never escapes the separators", () => {
    // A `#` truncates the reference at a fragment and a space is not a legal
    // URI character — either one gets the WHOLE upload rejected, not one result.
    expect(toUriReference("a dir/notes#1.ts")).toBe("a%20dir/notes%231.ts");
  });
});

describe("the serialised file", () => {
  it("round-trips as JSON and ends with a newline, so it lands readable in a log or a diff", () => {
    const text = formatSarif({ violations: [violation()], failures: [] });
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).runs[0].results).toHaveLength(1);
  });
});

describe("a custom rule's descriptors and results", () => {
  const catalogue = [
    { ruleId: "custom/a-rule/one", rule: "a-rule", findingId: "one", message: "First\n\nDetail" },
    { ruleId: "custom/a-rule/two", rule: "a-rule", findingId: "two", message: "Second" },
  ];
  const failing = (findings) => ({
    verdict: "fail",
    name: "a-rule",
    message: `reported ${findings.length} finding(s)`,
    reason: "declared because",
    findings,
  });

  it("appends one descriptor per catalogue entry, after every fixed id", () => {
    // The mocked tables above give four fixed ids plus the fitness one, so a
    // custom descriptor that landed anywhere else would renumber them.
    const ids = sarifRules(catalogue).map((rule) => rule.id);
    expect(ids.slice(-2)).toEqual(["custom/a-rule/one", "custom/a-rule/two"]);
    const [first] = sarifRules(catalogue).slice(-2);
    expect(first.shortDescription.text).toBe("First");
    expect(first.fullDescription.text).toBe("First\n\nDetail");
    expect(first.properties).toEqual({ customRule: "a-rule", findingId: "one" });
  });

  it("adds no descriptor at all when no custom rule was loaded", () => {
    expect(sarifRules()).toEqual(sarifRules([]));
    expect(sarifRules().some((rule) => rule.id.startsWith("custom/"))).toBe(false);
  });

  it("carries a region only as far as the rule stated a position", () => {
    // A column with no line is a position SARIF cannot express, and a
    // fabricated line would put the annotation on code the rule never named.
    expect(
      sarifCustomRuleResult({ id: "custom/a-rule/one", message: "m", sourceFile: "a/b.go" }, 7)
        .locations[0].physicalLocation.region,
    ).toBeUndefined();
    expect(
      sarifCustomRuleResult(
        { id: "custom/a-rule/one", message: "m", sourceFile: "a/b.go", line: 4 },
        7,
      ).locations[0].physicalLocation.region,
    ).toEqual({ startLine: 4 });
    expect(
      sarifCustomRuleResult(
        { id: "custom/a-rule/one", message: "m", sourceFile: "a/b.go", line: 4, column: 9 },
        7,
      ).locations[0].physicalLocation.region,
    ).toEqual({ startLine: 4, startColumn: 9 });
  });

  it("omits the location block entirely for a finding with no file, and keeps its project", () => {
    const result = sarifCustomRuleResult(
      { id: "custom/a-rule/two", message: "m", project: "app" },
      8,
    );
    expect(result.locations).toBeUndefined();
    expect(result.properties).toEqual({ project: "app" });
    expect(result.ruleIndex).toBe(8);
    // And no empty property bag when the rule named no project either — an
    // absent fact says the same thing an empty one would, with less noise.
    expect(
      sarifCustomRuleResult({ id: "custom/a-rule/two", message: "m" }, 8).properties,
    ).toBeUndefined();
  });

  it("resolves each result to its own descriptor through the log's catalogue", () => {
    const built = log({
      customRules: {
        catalogue,
        decisions: [
          failing([
            { id: "custom/a-rule/two", message: "second finding" },
            { id: "custom/a-rule/one", message: "first finding", sourceFile: "a/b.go", line: 1 },
          ]),
        ],
      },
    });
    expect(built.results).toHaveLength(2);
    for (const result of built.results) {
      expect(built.tool.driver.rules[result.ruleIndex].id).toBe(result.ruleId);
    }
  });

  it("reports nothing for a passing rule — an empty results array already means 'found nothing'", () => {
    const built = log({
      customRules: {
        catalogue,
        decisions: [
          { verdict: "pass", name: "a-rule", message: "clean", reason: "r", findings: [] },
        ],
      },
    });
    expect(built.results).toEqual([]);
    expect(built.invocations[0].toolExecutionNotifications).toEqual([]);
  });

  it("files an undetermined rule and one that did not apply as trouble, not as findings", () => {
    // The second half is the load-bearing one: without it a scoped run over a
    // workspace declaring custom rules uploads a log byte-identical to one
    // from a workspace that declares none.
    const built = log({
      customRules: {
        catalogue,
        decisions: [
          { verdict: "unknown", name: "a-rule", message: "it trapped", reason: "r", findings: [] },
          {
            verdict: "not_applicable",
            name: "b-rule",
            message: "scoped",
            notApplicableReason: "scoped",
            reason: "r",
            findings: [],
          },
        ],
      },
    });
    expect(built.results).toEqual([]);
    expect(built.invocations[0].toolExecutionNotifications.map((n) => n.message.text)).toEqual([
      'Custom rule "a-rule" could not be judged: it trapped',
      'Custom rule "b-rule" did not apply to this run: scoped',
    ]);
  });

  it("drops no finding a failing rule reported, whatever its own verdict fields say", () => {
    // The silent direction for this face: a `fail` verdict whose findings
    // never reached `results` would upload a red run with an empty log.
    const built = log({
      customRules: {
        catalogue,
        decisions: [failing([{ id: "custom/a-rule/one", message: "only finding" }])],
      },
    });
    expect(built.results.map((result) => result.ruleId)).toEqual(["custom/a-rule/one"]);
    expect(built.results[0].level).toBe("error");
  });

  it("names the notification's posture from the verdict", () => {
    expect(
      sarifCustomRuleNotification({ verdict: "unknown", name: "x", message: "why" }).message.text,
    ).toBe('Custom rule "x" could not be judged: why');
    expect(
      sarifCustomRuleNotification({ verdict: "not_applicable", name: "x", message: "why" }).message
        .text,
    ).toBe('Custom rule "x" did not apply to this run: why');
  });
});

describe("a degraded-coverage note", () => {
  const gap = {
    kind: "unregistered-plugin",
    manifests: ["libs/engine/go.mod", "libs/tools/Cargo.toml"],
  };

  it("is not the log a fully covered run uploads", () => {
    expect(buildSarifLog({ violations: [], failures: [], coverageGaps: [gap] })).not.toEqual(
      buildSarifLog({ violations: [], failures: [], coverageGaps: [] }),
    );
  });

  it("names what is uncovered and which manifests proved it, as a warning and never a result", () => {
    const built = log({ coverageGaps: [gap] });
    expect(built.results).toEqual([]);
    const [notification] = built.invocations[0].toolExecutionNotifications;
    expect(notification.level).toBe("warning");
    expect(notification.message.text).toBe(
      "nx.json does not register this plugin but 2 polyglot manifests found under " +
        "project roots — nx affected and @nx/enforce-module-boundaries will not cover " +
        "these edges: libs/engine/go.mod, libs/tools/Cargo.toml",
    );
  });

  it("names a gap of any other kind by its kind, rather than borrowing a cause that is not its own", () => {
    const text = sarifCoverageGapNotification({ kind: "some-later-gap" }).message.text;
    expect(text).toContain("some-later-gap");
    expect(text).not.toContain("nx.json");
  });

  it("says nothing when the run left no gap, so a fully covered workspace's log is unchanged", () => {
    expect(log({ coverageGaps: [] }).invocations[0].toolExecutionNotifications).toEqual([]);
    expect(log({}).invocations[0].toolExecutionNotifications).toEqual([]);
  });
});

describe("an unresolved decisionRef", () => {
  it("is not the log a run whose citations all resolve uploads", () => {
    expect(
      buildSarifLog({
        violations: [],
        failures: [],
        unresolvedDecisionRefs: new Set(["0007-gone"]),
      }),
    ).not.toEqual(
      buildSarifLog({ violations: [], failures: [], unresolvedDecisionRefs: new Set() }),
    );
  });

  it("names each citation in the text face's own words, sorted, as a warning and never a result", () => {
    const built = log({ unresolvedDecisionRefs: new Set(["0009-later", "0007-gone"]) });
    expect(built.results).toEqual([]);
    const notifications = built.invocations[0].toolExecutionNotifications;
    expect(notifications.map((n) => n.level)).toEqual(["warning", "warning"]);
    expect(notifications.map((n) => n.message.text)).toEqual([
      "decisionRef [0007-gone] (UNRESOLVED — no matching ADR, rule, or fitness record)",
      "decisionRef [0009-later] (UNRESOLVED — no matching ADR, rule, or fitness record)",
    ]);
  });

  it("takes the array face of the same set, so a caller holding the JSON envelope's list is not ignored", () => {
    const built = log({ unresolvedDecisionRefs: ["0007-gone"] });
    expect(built.invocations[0].toolExecutionNotifications).toHaveLength(1);
  });

  it("says nothing when every citation resolved", () => {
    expect(
      log({ unresolvedDecisionRefs: new Set() }).invocations[0].toolExecutionNotifications,
    ).toEqual([]);
    expect(log({}).invocations[0].toolExecutionNotifications).toEqual([]);
  });
});

describe("the delta log", () => {
  // The classifier's shapes (`../commands/delta-classify.mjs`), built by hand
  // so this file pins the TRANSFORM against the mocked two-id message table.
  const introducedEntry = (overrides = {}) => ({
    classification: "introduced",
    messageId: "secondRule",
    sourceProject: "engine-domain",
    target: "engine-adapters",
    targetIsSpecifier: false,
    constraint: { sourceTag: "layer:domain" },
    baseCount: 0,
    headCount: 2,
    reason: "absent at base",
    waived: false,
    baseSites: [],
    headSites: [
      { file: "acme/libs/engine-domain/a.go", line: 3, column: 2, specifier: "x", kind: "static" },
      { file: "acme/libs/engine-domain/b.go", line: 7, column: 4, specifier: "x", kind: "static" },
    ],
    ...overrides,
  });

  const emptyDelta = () => ({
    violations: { introduced: [], resolved: [], unchanged: [], unknown: [] },
    unresolvable: { introduced: [], resolved: [], unchanged: [], unknown: [] },
  });

  const deltaLog = (overrides = {}) =>
    buildDeltaSarifLog({
      delta: { ...emptyDelta(), ...overrides.delta },
      coverage: { notes: [], ...overrides.coverage },
      ...(overrides.customCatalogue ? { customCatalogue: overrides.customCatalogue } : {}),
    }).runs[0];

  describe("sarifDeltaResult", () => {
    it("resolves its ruleId in the same catalogue check's results resolve in — no second table", () => {
      const result = sarifDeltaResult(introducedEntry(), introducedEntry().headSites[0]);
      expect(result.ruleId).toBe("secondRule");
      expect(sarifRules()[result.ruleIndex].id).toBe(result.ruleId);
    });

    it("composes a non-empty message carrying both counts and the constraint", () => {
      const result = sarifDeltaResult(
        introducedEntry({
          baseCount: 1,
          headCount: 3,
          reason: "occurrence growth: 1 at base, 3 at head",
        }),
        introducedEntry().headSites[0],
      );
      expect(result.message.text.length).toBeGreaterThan(0);
      expect(result.message.text).toContain("1 occurrence at base");
      expect(result.message.text).toContain("3 at head");
      expect(result.message.text).toContain("THE CONSTRAINT");
      expect(result.level).toBe("error");
    });

    it("locates the head site 1-based, exactly as the analysis record carries it", () => {
      const result = sarifDeltaResult(introducedEntry(), {
        file: "acme/libs/engine-domain/a.go",
        line: 3,
        column: 2,
      });
      const { artifactLocation, region } = result.locations[0].physicalLocation;
      expect(artifactLocation.uri).toBe("acme/libs/engine-domain/a.go");
      expect(region).toEqual({ startLine: 3, startColumn: 2 });
    });

    it("carries the delta vocabulary in the property bag", () => {
      const result = sarifDeltaResult(introducedEntry(), introducedEntry().headSites[0]);
      expect(result.properties).toMatchObject({ delta: "introduced", baseCount: 0, headCount: 2 });
      expect(result.properties.accepted).toBeUndefined();
    });

    it("tags a waived-introduced entry accepted, in sarifResult's own vocabulary", () => {
      const result = sarifDeltaResult(
        introducedEntry({
          waived: true,
          waivedBy: { expiresAt: "2027-01-01T00:00:00Z", reason: "tracked debt" },
        }),
        introducedEntry().headSites[0],
      );
      expect(result.properties.accepted).toBe(true);
      expect(result.properties.acceptedUntil).toBe("2027-01-01T00:00:00Z");
      expect(result.properties.acceptedReason).toBe("tracked debt");
      // Still an error-level result: an accepted violation is still a violation.
      expect(result.level).toBe("error");
    });
  });

  describe("buildDeltaSarifLog", () => {
    it("never uploads an empty results array for an exit-1 delta — one result per head site", () => {
      // The silent-direction red case: a gate that exits 1 while its SARIF
      // face reports nothing is the empty upload this face exists to refuse.
      const built = deltaLog({
        delta: { violations: { ...emptyDelta().violations, introduced: [introducedEntry()] } },
      });
      expect(built.results).toHaveLength(2);
      expect(
        built.results.map((r) => r.locations[0].physicalLocation.artifactLocation.uri),
      ).toEqual(["acme/libs/engine-domain/a.go", "acme/libs/engine-domain/b.go"]);
    });

    it("never uploads a notification-free log for an exit-3 delta, whichever bucket the unknown sits in", () => {
      for (const delta of [
        {
          violations: {
            ...emptyDelta().violations,
            unknown: [{ classification: "unknown", reason: "no usable messageId", violation: {} }],
          },
        },
        {
          unresolvable: {
            ...emptyDelta().unresolvable,
            unknown: [{ classification: "unknown", reason: "no usable specifier", record: {} }],
          },
        },
        {
          customRules: {
            findings: {
              introduced: [],
              resolved: [],
              unchanged: [],
              unknown: [
                { classification: "unknown", rule: "no-forbidden", reason: "digest drift" },
              ],
            },
          },
        },
      ]) {
        const built = deltaLog({ delta });
        expect(built.results).toEqual([]);
        const notifications = built.invocations[0].toolExecutionNotifications;
        expect(notifications.length).toBeGreaterThan(0);
        expect(notifications[0].level).toBe("warning");
        expect(notifications[0].message.text.length).toBeGreaterThan(0);
      }
    });

    it("names the unknown custom rule in its notification", () => {
      const built = deltaLog({
        delta: {
          customRules: {
            findings: {
              introduced: [],
              resolved: [],
              unchanged: [],
              unknown: [
                { classification: "unknown", rule: "no-forbidden", reason: "digest drift" },
              ],
            },
          },
        },
      });
      const [notification] = built.invocations[0].toolExecutionNotifications;
      expect(notification.message.text).toContain('rule "no-forbidden"');
      expect(notification.message.text).toContain("digest drift");
    });

    it("renders an introduced custom finding through the end-of-catalogue descriptors", () => {
      const customCatalogue = [
        {
          ruleId: "custom/no-forbidden/found",
          rule: "no-forbidden",
          findingId: "found",
          message: "Forbidden thing found",
        },
      ];
      const built = deltaLog({
        customCatalogue,
        delta: {
          customRules: {
            findings: {
              introduced: [
                {
                  classification: "introduced",
                  rule: "no-forbidden",
                  findingId: "found",
                  ruleId: "custom/no-forbidden/found",
                  project: "engine-domain",
                  message: "Forbidden thing found",
                  baseCount: 0,
                  headCount: 1,
                  reason: "absent at base",
                  baseSites: [],
                  headSites: [{ file: "acme/libs/engine-domain/a.go", line: 4, column: 1 }],
                },
              ],
              resolved: [],
              unchanged: [],
              unknown: [],
            },
          },
        },
      });
      expect(built.results).toHaveLength(1);
      const [result] = built.results;
      // The descriptor sits past every fixed id — the custom tail assumption
      // `sarifRules` documents — and the id resolves in the SAME array.
      expect(result.ruleIndex).toBeGreaterThanOrEqual(6);
      expect(built.tool.driver.rules[result.ruleIndex].id).toBe("custom/no-forbidden/found");
      expect(result.message.text).toContain("0 occurrences at base");
      expect(result.properties).toMatchObject({ delta: "introduced", project: "engine-domain" });
    });

    it("carries every coverage note and each introduced unresolvable record as warnings", () => {
      const built = deltaLog({
        coverage: { notes: ["the boundary law changed since capture"] },
        delta: {
          unresolvable: {
            ...emptyDelta().unresolvable,
            introduced: [
              {
                classification: "introduced",
                specifier: "mystery/pkg",
                kind: "static",
                sourceProject: "engine-domain",
                baseCount: 0,
                headCount: 1,
                baseSites: [],
                headSites: [{ file: "acme/libs/engine-domain/a.go", line: 9, column: 2 }],
              },
            ],
          },
        },
      });
      const texts = built.invocations[0].toolExecutionNotifications.map((n) => n.message.text);
      expect(texts.some((t) => t.includes("the boundary law changed since capture"))).toBe(true);
      const unresolvable = built.invocations[0].toolExecutionNotifications.find((n) =>
        n.message.text.includes('"mystery/pkg"'),
      );
      expect(unresolvable.level).toBe("warning");
      expect(unresolvable.locations[0].physicalLocation.region.startLine).toBe(9);
    });

    it("keeps the envelope facts a rejected upload turns on: version, columnKind, executionSuccessful", () => {
      const log2 = buildDeltaSarifLog({ delta: emptyDelta(), coverage: { notes: [] } });
      expect(log2.version).toBe("2.1.0");
      expect(log2.runs[0].columnKind).toBe("utf16CodeUnits");
      expect(log2.runs[0].invocations[0].executionSuccessful).toBe(true);
    });
  });

  describe("formatDeltaSarif", () => {
    it("round-trips as JSON with a trailing newline", () => {
      const text = formatDeltaSarif({
        delta: {
          violations: { introduced: [introducedEntry()], resolved: [], unchanged: [], unknown: [] },
          unresolvable: emptyDelta().unresolvable,
        },
        coverage: { notes: [] },
      });
      expect(text.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(text);
      expect(parsed.runs[0].results).toHaveLength(2);
    });
  });
});

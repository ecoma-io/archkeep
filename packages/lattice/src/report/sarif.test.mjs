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
vi.mock("./text.mjs", () => ({ formatConstraint: () => "THE CONSTRAINT" }));

import { buildSarifLog, formatSarif, sarifRules, toUriReference } from "./sarif.mjs";

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
    ]);
    expect(log().tool.driver.rules).toHaveLength(4);
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

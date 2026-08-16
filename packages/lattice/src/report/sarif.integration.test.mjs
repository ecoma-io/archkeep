import { describe, expect, it } from "vitest";

import { DRIFT_MESSAGE_IDS } from "../drift/drift.mjs";
import { GO_WORK_MESSAGE_IDS, GO_WORK_MESSAGES } from "../go-work.mjs";
import { MESSAGE_IDS, renderMessage } from "../rules/messages.mjs";
import { TSCONFIG_PATHS_MESSAGE_IDS, TSCONFIG_PATHS_MESSAGES } from "../tsconfig-paths.mjs";

import { buildSarifLog } from "./sarif.mjs";

/**
 * The real message table, the real constraint renderer, and every `messageId`
 * the engine can produce — driven together, because the failure this guards
 * against is not a wrong string. It is a file GitHub's `upload-sarif` rejects:
 * the job stays green, no annotation ever appears, and nothing says why.
 *
 * So the assertions below are GitHub's documented requirements for a code
 * scanning upload, restated as checks rather than trusted:
 * `version`, `tool.driver.name`, a `ruleId` that resolves in the catalogue, a
 * non-empty `message.text`, and a physical location whose `uri` is repository
 * relative with a 1-based `startLine`. The full 2.1.0 schema is a superset of
 * these; what is pinned here is the subset a rejected upload turns on.
 */

/** One violation per `messageId`, rendered through the real message table. */
const everyViolation = () =>
  MESSAGE_IDS.map((messageId, index) => ({
    sourceFile: `acme/libs/engine-domain/file-${index}.go`,
    line: index + 1,
    column: index + 2,
    specifier: "@acme/engine-adapters",
    kind: "static",
    messageId,
    message: renderMessage(messageId, { sourceTag: "layer:domain", tags: "layer:util", imp: "x" }),
    sourceProject: "engine-domain",
    targetProject: "engine-adapters",
    constraint: { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:util"] },
    data: {},
  }));

/**
 * One drift finding per go.work `messageId` — the missing-use one positionless
 * (`line: null`), the shape `compareGoWork` really emits for an entry that
 * does not exist, so the region-handling below is exercised on both branches.
 */
const everyDriftFinding = () =>
  GO_WORK_MESSAGE_IDS.map((messageId, index) => ({
    messageId,
    file: "go.work",
    line: messageId === "goWorkMissingUse" ? null : index + 1,
    column: messageId === "goWorkMissingUse" ? null : 2,
    directory: "acme/libs/engine-domain",
    project: messageId === "goWorkMissingUse" ? "engine-domain" : null,
    message: GO_WORK_MESSAGES[messageId],
  }));

/**
 * One dead-alias finding per paths hygiene `messageId` — positionless
 * (`line: null`), the only shape `judgeTsconfigPaths` emits, so the
 * artifact-only location branch is the one exercised.
 */
const everyDeadAliasFinding = () =>
  TSCONFIG_PATHS_MESSAGE_IDS.map((messageId) => ({
    messageId,
    file: "tsconfig.base.json",
    line: null,
    column: null,
    alias: "@acme/engine-domain",
    targets: ["acme/libs/engine-domain/src/index.ts"],
    message: TSCONFIG_PATHS_MESSAGES[messageId],
  }));

/**
 * One architecture-drift finding per drift `messageId` — project/edge/tag
 * level, none carrying a source position, so the artifact-only location branch
 * (`sarifDriftResult`) is the one exercised.
 */
const everyArchDriftFinding = () =>
  DRIFT_MESSAGE_IDS.map((messageId) => ({
    messageId,
    kind: "dependencyForbidden",
    row: { source: "engine-domain", target: "engine-adapters", forbid: true },
    detail: "",
    project: null,
    source: "engine-domain",
    target: "engine-adapters",
    message: "the architecture drift, spelled out",
  }));

const log = buildSarifLog({
  violations: everyViolation(),
  failures: [
    { sourceFile: "acme/apps/site/app/app.vue", line: 2, column: 40, reason: "cannot resolve" },
    { sourceFile: "a/b.rs", line: null, column: null, reason: "could not be read" },
  ],
  goWork: { findings: everyDriftFinding(), moduleProjects: 2 },
  tsconfigPaths: { findings: everyDeadAliasFinding(), aliases: 3, unjudged: 0 },
  drift: { intent: { file: "architecture-intent.config.mjs" }, findings: everyArchDriftFinding() },
});

describe("the SARIF log against what GitHub requires of an upload", () => {
  it("declares version 2.1.0 and a named driver, the two fields an upload is rejected without", () => {
    expect(log.version).toBe("2.1.0");
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0].tool.driver.name).toBe("lattice");
  });

  it("gives every rule the engine can report a descriptor with an id, so no finding is nameless", () => {
    const ids = log.runs[0].tool.driver.rules.map((rule) => rule.id);
    expect(ids).toEqual([
      ...MESSAGE_IDS,
      ...GO_WORK_MESSAGE_IDS,
      ...TSCONFIG_PATHS_MESSAGE_IDS,
      ...DRIFT_MESSAGE_IDS,
    ]);
    expect(ids.every((id) => typeof id === "string" && id !== "")).toBe(true);
  });

  it("resolves every result's ruleId and ruleIndex against that catalogue", () => {
    const { rules } = log.runs[0].tool.driver;
    for (const result of log.runs[0].results) {
      expect(rules[result.ruleIndex]).toBeDefined();
      expect(rules[result.ruleIndex].id).toBe(result.ruleId);
    }
  });

  it("carries a non-empty message and one of SARIF's own levels on every result", () => {
    for (const result of log.runs[0].results) {
      expect(result.message.text.length).toBeGreaterThan(0);
      expect(["none", "note", "warning", "error"]).toContain(result.level);
    }
  });

  it("locates every result at a repository-relative path with a 1-based line and column", () => {
    for (const result of log.runs[0].results) {
      const { artifactLocation, region } = result.locations[0].physicalLocation;
      // An absolute path, a `file:` URI, or a `..` escape are the three shapes
      // GitHub cannot map onto a file in the checkout — the annotation is then
      // dropped silently, which is worse than a red upload.
      expect(artifactLocation.uri.startsWith("/")).toBe(false);
      expect(artifactLocation.uri).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
      expect(artifactLocation.uri.split("/")).not.toContain("..");
      if (
        result.ruleId === "goWorkMissingUse" ||
        result.ruleId === "tsconfigDeadPathAlias" ||
        DRIFT_MESSAGE_IDS.includes(result.ruleId)
      ) {
        // The results about a thing that does not exist — a use entry never
        // written, an alias with no position in the parsed options, an intent
        // row judged against the whole tree rather than any file position — no
        // region, rather than a fabricated line 1 marking text the finding is
        // not about.
        expect(region).toBeUndefined();
        continue;
      }
      expect(region.startLine).toBeGreaterThanOrEqual(1);
      expect(region.startColumn).toBeGreaterThanOrEqual(1);
    }
  });

  it("reports one result per violation, drift finding and dead alias, and none for a failure", () => {
    expect(log.runs[0].results).toHaveLength(
      MESSAGE_IDS.length +
        GO_WORK_MESSAGE_IDS.length +
        TSCONFIG_PATHS_MESSAGE_IDS.length +
        DRIFT_MESSAGE_IDS.length,
    );
    expect(log.runs[0].invocations[0].toolExecutionNotifications).toHaveLength(2);
  });

  it("survives a JSON round trip unchanged, which is the only form GitHub ever sees", () => {
    expect(JSON.parse(JSON.stringify(log))).toEqual(log);
  });
});

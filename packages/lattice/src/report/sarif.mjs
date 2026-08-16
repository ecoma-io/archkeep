/**
 * SARIF 2.1.0 — the machine-readable half of the report, written for GitHub's
 * `upload-sarif`. No schema validator is installed in this workspace; what
 * `sarif.integration.test.mjs` pins is the subset of the 2.1.0 schema a
 * rejected upload turns on. A file GitHub silently rejects is worse than no
 * file at all: the job stays green, the annotations never appear, and nothing
 * says why.
 *
 * Four fields carry the whole value and each is easy to get subtly wrong:
 *
 * - **`ruleId` is upstream's `messageId`, spelled exactly.** That is the same
 *   contract `../rules/messages.mjs` keeps for the text: two tools that both
 *   say "error" agree on nothing until they name the same rule, and a
 *   differential comparison against `@nx/enforce-module-boundaries` has nothing
 *   to compare otherwise. The rule catalogue is DERIVED from that module's
 *   message table, so a rule added upstream cannot be missing here.
 * - **`artifactLocation.uri` is workspace-relative**, which is what GitHub
 *   resolves an annotation against. The analysis contract already produces
 *   workspace-relative paths, so this module only has to not break one — it
 *   percent-encodes per segment, because a path containing a space or a `#` is
 *   not a valid URI reference and the whole run is rejected for one file.
 * - **`region` is 1-based** in both axes, matching the analysis records; SARIF
 *   agrees, so nothing is converted. `columnKind` is stated rather than left to
 *   the default because the analyzers made a real choice — columns count UTF-16
 *   code units (`../analysis/source-util.mjs`) — and a consumer that assumed
 *   code points would land in the wrong column on any line with an emoji.
 * - **`level` is `error`** on every result. This report exists to block a
 *   merge; a warning would render as an annotation nobody has to act on.
 *
 * Analysis failures are NOT results. A file this tool could not parse is a
 * place it has no verdict about, and filing it as a finding would put a
 * boundary alert on code that may well be clean. They travel as
 * `invocations[].toolExecutionNotifications`, which is SARIF's own slot for
 * "the tool had trouble here", at `warning` — `executionSuccessful` stays true
 * because the run did complete. go.work drift findings and dead tsconfig path
 * aliases ARE results, under their own rule ids: they are verdicts the run
 * fails on, not trouble it hit (`sarifGoWorkResult`,
 * `sarifTsconfigPathsResult`).
 *
 * **The driver carries no `version`/`semanticVersion`, and that is now a gap
 * rather than a decision.** It was written when this package was unversioned and
 * unpublished, where any number would have been invented; the package has a real
 * version and a registry entry today, so a consumer comparing two SARIF uploads
 * has no way to tell which build produced which. Filling it in changes the
 * reported output, which is the one kind of change this repository treats as
 * breaking even when no API moved, so it lands as its own decision rather than
 * as a side effect of a comment being corrected.
 */
import { DRIFT_MESSAGE_IDS, DRIFT_MESSAGES } from "../drift/drift.mjs";
import { GO_WORK_MESSAGE_IDS, GO_WORK_MESSAGES } from "../go-work.mjs";
import { MESSAGE_IDS, MESSAGES } from "../rules/messages.mjs";
import { TSCONFIG_PATHS_MESSAGE_IDS, TSCONFIG_PATHS_MESSAGES } from "../tsconfig-paths.mjs";

import { formatConstraint } from "./text.mjs";

/** The schema every consumer of this file validates against. */
export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
export const SARIF_VERSION = "2.1.0";

/**
 * A workspace-relative path as a URI reference: each segment percent-encoded,
 * separators left alone.
 *
 * `encodeURIComponent` and not `encodeURI`: the latter leaves `#` and `?`
 * unescaped, and a file named `notes#1.ts` would truncate the URI at the
 * fragment. Unreserved characters — letters, digits, `-`, `_`, `.`, `~` — pass
 * through untouched, so an ordinary path is byte-identical to its input.
 *
 * @param {string} path Workspace-relative, `/`-separated.
 * @returns {string}
 */
export function toUriReference(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * The rule catalogue: one descriptor per `messageId` a run can produce — the
 * upstream boundary ids in `MESSAGE_IDS` order, then this package's own
 * go.work drift ids, then its tsconfig paths hygiene ids, so `ruleIndex` is an
 * index into this exact array.
 *
 * Every id is listed, not only the ones that fired. A GitHub alert shows the
 * rule's description beside the finding, and a catalogue that grew only as
 * violations appeared would describe a rule on the run that reported it and
 * leave it nameless on the next. Both halves are derived from their message
 * tables rather than restated, so an id added to either cannot go missing.
 *
 * `shortDescription` is the template's first line and `fullDescription` the
 * whole template, `{{placeholder}}`s intact — the placeholders are honest here:
 * they show which facts the message interpolates, which is exactly what a rule
 * description should say. The go.work, tsconfig paths and drift rules carry no
 * `upstreamRule` property, because they have none: ESLint has no notion of
 * go.work, dead aliases, or architecture intent.
 *
 * @returns {object[]}
 */
export function sarifRules() {
  return [
    ...MESSAGE_IDS.map((id) => ({
      id,
      name: id,
      shortDescription: { text: MESSAGES[id].split("\n")[0] },
      fullDescription: { text: MESSAGES[id] },
      defaultConfiguration: { level: "error" },
      properties: { upstreamRule: "@nx/enforce-module-boundaries" },
    })),
    ...GO_WORK_MESSAGE_IDS.map((id) => ({
      id,
      name: id,
      shortDescription: { text: GO_WORK_MESSAGES[id].split("\n")[0] },
      fullDescription: { text: GO_WORK_MESSAGES[id] },
      defaultConfiguration: { level: "error" },
    })),
    ...TSCONFIG_PATHS_MESSAGE_IDS.map((id) => ({
      id,
      name: id,
      shortDescription: { text: TSCONFIG_PATHS_MESSAGES[id].split("\n")[0] },
      fullDescription: { text: TSCONFIG_PATHS_MESSAGES[id] },
      defaultConfiguration: { level: "error" },
    })),
    ...DRIFT_MESSAGE_IDS.map((id) => ({
      id,
      name: id,
      shortDescription: {
        text: DRIFT_MESSAGES.find((m) => m.id === id).template,
      },
      fullDescription: {
        text: DRIFT_MESSAGES.find((m) => m.id === id).template,
      },
      defaultConfiguration: { level: "error" },
    })),
  ];
}

/**
 * One violation as a SARIF result.
 *
 * The message is the rendered upstream text plus the one fact a GitHub
 * annotation cannot show otherwise: which import, between which projects, under
 * which constraint row. GitHub renders `message.text` and nothing else, so a
 * developer reading the alert would otherwise see a rule about tags with no way
 * to tell which line of their file it is about. The verbatim upstream text
 * stays available, unmodified, in the property bag.
 *
 * @param {object} violation A `Violation` from `../rules/`.
 * @returns {object}
 */
export function sarifResult(violation) {
  const detail =
    `Import ${JSON.stringify(violation.specifier)} (${violation.kind}) ` +
    `from ${violation.sourceProject ?? "(no project)"} ` +
    `to ${violation.targetProject ?? "(unresolved)"}. ` +
    `Constraint: ${formatConstraint(violation.constraint)}`;
  return {
    ruleId: violation.messageId,
    ruleIndex: MESSAGE_IDS.indexOf(violation.messageId),
    level: "error",
    message: { text: `${violation.message}\n\n${detail}` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: toUriReference(violation.sourceFile) },
          region: { startLine: violation.line, startColumn: violation.column },
        },
      },
    ],
    properties: {
      upstreamMessage: violation.message,
      specifier: violation.specifier,
      importKind: violation.kind,
      sourceProject: violation.sourceProject,
      targetProject: violation.targetProject,
      ...(violation.constraint?.description
        ? { ruleDescription: violation.constraint.description }
        : {}),
      ...(violation.constraint?.remediation
        ? { remediation: violation.constraint.remediation }
        : {}),
    },
  };
}

/**
 * One go.work drift finding as a SARIF result.
 *
 * A result and not a notification, deliberately: drift is a verdict the run
 * fails on, exactly like a violation, and a finding that only reached the exit
 * code would leave a code-scanning consumer looking at a red job with an empty
 * upload. A missing-use finding is about an entry that does not exist, so its
 * location carries the artifact alone rather than a fabricated line 1 — the
 * same reasoning as `sarifNotification` below.
 *
 * @param {object} finding A finding from `../go-work.mjs` `compareGoWork`.
 * @returns {object}
 */
export function sarifGoWorkResult(finding) {
  const physicalLocation = { artifactLocation: { uri: toUriReference(finding.file) } };
  if (finding.line !== null) {
    physicalLocation.region = { startLine: finding.line, startColumn: finding.column };
  }
  return {
    ruleId: finding.messageId,
    ruleIndex: MESSAGE_IDS.length + GO_WORK_MESSAGE_IDS.indexOf(finding.messageId),
    level: "error",
    message: { text: finding.message },
    locations: [{ physicalLocation }],
    properties: {
      directory: finding.directory,
      project: finding.project,
    },
  };
}

/**
 * One dead tsconfig path alias as a SARIF result.
 *
 * A result for the same reason a go.work drift finding is one: it is a verdict
 * the run fails on. The finding is positionless by construction — the parsed
 * compiler options carry no source positions, and under `extends` the alias
 * may not be declared in the file the workspace names — so the location
 * carries the artifact alone rather than a fabricated line 1, the reasoning
 * `sarifNotification` states.
 *
 * @param {object} finding A finding from `../tsconfig-paths.mjs`.
 * @returns {object}
 */
export function sarifTsconfigPathsResult(finding) {
  return {
    ruleId: finding.messageId,
    ruleIndex:
      MESSAGE_IDS.length +
      GO_WORK_MESSAGE_IDS.length +
      TSCONFIG_PATHS_MESSAGE_IDS.indexOf(finding.messageId),
    level: "error",
    message: { text: finding.message },
    locations: [{ physicalLocation: { artifactLocation: { uri: toUriReference(finding.file) } } }],
    properties: {
      alias: finding.alias,
      targets: finding.targets,
    },
  };
}

/**
 * One architecture-drift finding as a SARIF result.
 *
 * A result for the same reason a go.work drift finding is one: it is a verdict
 * the run fails on. A finding is project- or edge-level by construction — the
 * intent row names a project, a tag pair, or a `source -> target` dependency,
 * never a source position — so the location carries the artifact (the intent
 * file) alone rather than a fabricated line 1, the reasoning `sarifNotification`
 * states. The message id, the intent row, and the observed fact all reach the
 * property bag so a developer reading the alert has the whole comparison.
 *
 * @param {object} finding A finding from `../drift/drift.mjs` `computeDrift`.
 * @param {string} intentFile The intent file the finding is about,
 *   workspace-relative.
 * @returns {object}
 */
export function sarifDriftResult(finding, intentFile) {
  return {
    ruleId: finding.messageId,
    ruleIndex:
      MESSAGE_IDS.length +
      GO_WORK_MESSAGE_IDS.length +
      TSCONFIG_PATHS_MESSAGE_IDS.length +
      DRIFT_MESSAGE_IDS.indexOf(finding.messageId),
    level: "error",
    message: { text: finding.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: toUriReference(intentFile) },
        },
      },
    ],
    properties: {
      kind: finding.kind,
      row: finding.row,
      ...(finding.detail !== "" ? { detail: finding.detail } : {}),
      ...(finding.project !== null ? { project: finding.project } : {}),
      ...(finding.source !== null ? { source: finding.source } : {}),
      ...(finding.target !== null ? { target: finding.target } : {}),
    },
  };
}

/**
 * One analysis failure as a tool-execution notification.
 *
 * A failure with no position is about the file as a whole (`line`/`column`
 * `null` in the contract), and SARIF's `region` has no way to say "somewhere in
 * here" — so the location carries the artifact alone rather than a fabricated
 * line 1, which would put a marker on code that has nothing to do with it.
 *
 * @param {object} failure An `AnalysisFailure`.
 * @returns {object}
 */
export function sarifNotification(failure) {
  const physicalLocation = { artifactLocation: { uri: toUriReference(failure.sourceFile) } };
  if (failure.line !== null) {
    physicalLocation.region = { startLine: failure.line, startColumn: failure.column };
  }
  return {
    level: "warning",
    message: { text: failure.reason },
    locations: [{ physicalLocation }],
  };
}

/**
 * The whole SARIF log.
 *
 * @param {{violations: object[], failures: object[],
 *   goWork?: {findings: object[], moduleProjects?: number}|null,
 *   tsconfigPaths?: {findings: object[], aliases?: number, unjudged?: number}|null,
 *   drift?: {intent: {file: string}|null, findings: object[]}|null}} run
 * @returns {object} A SARIF 2.1.0 log, ready to `JSON.stringify`.
 */
export function buildSarifLog({ violations, failures, goWork, tsconfigPaths, drift }) {
  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: { driver: { name: "lattice", rules: sarifRules() } },
        columnKind: "utf16CodeUnits",
        results: [
          ...violations.map(sarifResult),
          ...(goWork?.findings ?? []).map(sarifGoWorkResult),
          ...(tsconfigPaths?.findings ?? []).map(sarifTsconfigPathsResult),
          ...(drift?.findings ?? []).map((finding) =>
            sarifDriftResult(finding, drift.intent?.file ?? "architecture-intent.config.mjs"),
          ),
        ],
        invocations: [
          {
            // True even on a red run: the tool did its job, and the findings
            // are results rather than errors. Reporting false here makes GitHub
            // treat the upload as a broken analysis and drop the annotations.
            executionSuccessful: true,
            toolExecutionNotifications: failures.map(sarifNotification),
          },
        ],
      },
    ],
  };
}

/**
 * The SARIF log as the bytes to write — pretty-printed with a trailing newline,
 * so a file that lands in a diff or a log stays readable.
 *
 * @param {{violations: object[], failures: object[],
 *   goWork?: {findings: object[], moduleProjects?: number}|null,
 *   tsconfigPaths?: {findings: object[], aliases?: number, unjudged?: number}|null,
 *   drift?: {intent: {file: string}|null, findings: object[]}|null}} run
 * @returns {string}
 */
export function formatSarif(run) {
  return `${JSON.stringify(buildSarifLog(run), null, 2)}\n`;
}

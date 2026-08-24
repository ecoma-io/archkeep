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
 * `sarifTsconfigPathsResult`). A `fail`-verdict fitness function follows the
 * same rule — it is exactly as build-failing as a boundary violation
 * (`verdictFor`'s `fitnessFail`) — while an `unknown`-verdict one (the run
 * could not determine it) is trouble the tool hit, not a finding, so it rides
 * a notification instead (`sarifFitnessResult`, `sarifFitnessNotification`).
 * A declared custom rule (`../commands/custom-rules.mjs`) splits the same way,
 * with one addition its own function argues: a rule that did NOT apply is a
 * notification too, because "did not apply" and "applied and found nothing"
 * are the two states an empty results array cannot tell apart.
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
import { INTENT_MESSAGE_IDS, INTENT_MESSAGES } from "../architecture-intent/judge.mjs";
import { GO_WORK_MESSAGE_IDS, GO_WORK_MESSAGES } from "../go-work.mjs";
import { MESSAGE_IDS, MESSAGES } from "../rules/messages.mjs";
import { TSCONFIG_PATHS_MESSAGE_IDS, TSCONFIG_PATHS_MESSAGES } from "../tsconfig-paths.mjs";

import { formatConstraint } from "./text.mjs";

/** The schema every consumer of this file validates against. */
export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
export const SARIF_VERSION = "2.1.0";

/**
 * The single rule id every failing fitness function's result shares — see
 * `sarifRules()`'s own comment for why one id stands in for the whole
 * open-ended, workspace-declared set.
 */
export const FITNESS_FAILED_RULE_ID = "fitnessFunctionFailed";

/**
 * A workspace-relative path as a URI reference: each segment percent-encoded,
 * separators left alone.
 *
 * `encodeURIComponent` and not `encodeURI`: the latter leaves `#` and `?`
 * unescaped, and a file named `notes#1.ts` would truncate the URI at the
 * fragment. Unreserved characters — letters, digits, `-`, `_`, `.`, `~` — pass
 * through untouched, so an ordinary path is byte-identical to its input.
 *
 * **This function encodes; it does not vet.** A path that is absolute or
 * carries a `..` segment is one GitHub's code scanning drops without saying
 * so, and the producer that could hand one over unbidden — a custom rule's
 * finding, the only `uri` here whose value comes from wasm this engine did not
 * write — is refused where its verdict is JUDGED rather than where it is
 * rendered: `../custom-rules/host.mjs`'s `isWorkspaceRelative`, whose comment
 * argues the layering. Every other caller's path is the tool's own fact:
 * `git ls-files` output for a violation or an analysis failure, a graph node's
 * project root for a declared edge, a literal for `go.work` and
 * `architecture-intent.json`.
 *
 * There is deliberately no guard THROWING here, and the reason is the two
 * remaining callers rather than a preference: the `tsConfig` option and a
 * `--config` policy file are names the WORKSPACE chose, and either may
 * legitimately point outside the tree — `../../cli.mjs`'s `resolvePolicy`
 * reports the second as `relative(root, configPath)`, an escaping path a
 * fitness result then locates against. A throw would turn those supported runs
 * into a crash, and a silent rewrite would be worse than either, because it
 * would point the reader at a different file with full confidence
 * (`../../AGENTS.md`).
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
 * go.work drift ids, then its tsconfig paths hygiene ids, then its
 * architecture-intent ids, so `ruleIndex` is an index into this exact array.
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
 * description should say. The drift rules carry no `upstreamRule` property,
 * because they have none: ESLint has no notion of go.work.
 *
 * A custom rule's catalogue rides at the END of the array, after every fixed
 * id, because every `ruleIndex` above is computed as an offset from the fixed
 * tables' lengths — a descriptor inserted anywhere else would renumber ids
 * this file has already shipped. The entries are the ones each loaded rule
 * DECLARED it can report (`../commands/custom-rules.mjs`), not the ones that
 * fired: a rule described only on the run that reported it and nameless on the
 * next is exactly what the paragraph above refuses for the built-in ids.
 *
 * @param {{ruleId: string, rule: string, findingId: string, message: string}[]} [customCatalogue]
 * @returns {object[]}
 */
export function sarifRules(customCatalogue = []) {
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
    ...INTENT_MESSAGE_IDS.map((id) => ({
      id,
      name: id,
      shortDescription: { text: INTENT_MESSAGES[id].split("\n")[0] },
      fullDescription: { text: INTENT_MESSAGES[id] },
      defaultConfiguration: { level: "error" },
    })),
    // One entry, not a catalogue: a fitness function's `name` is
    // workspace-declared and open-ended (`../governance/fitness-registry.mjs`),
    // unlike the fixed message-id tables above, so it cannot be pre-catalogued
    // the same way — the specific function is named in the result's message
    // and `properties.name` instead (`sarifFitnessResult`).
    {
      id: FITNESS_FAILED_RULE_ID,
      name: FITNESS_FAILED_RULE_ID,
      shortDescription: { text: "A declared fitness function failed its verdict." },
      fullDescription: {
        text:
          "A fitness function declared in the boundary policy's `fitness` list judged its " +
          "matched projects and returned `fail` — the function name and reason are in the " +
          "result message and the `name` property.",
      },
      defaultConfiguration: { level: "error" },
    },
    ...customCatalogue.map((entry) => ({
      id: entry.ruleId,
      name: entry.ruleId,
      shortDescription: { text: entry.message.split("\n")[0] },
      fullDescription: { text: entry.message },
      defaultConfiguration: { level: "error" },
      properties: { customRule: entry.rule, findingId: entry.findingId },
    })),
  ];
}

/**
 * Where a custom rule's descriptors begin in `sarifRules()`'s array — every
 * fixed id, then the one fitness entry. Derived from the same tables the
 * offsets above are, so a message id added to any of them moves this with it.
 */
const CUSTOM_RULE_INDEX_BASE =
  MESSAGE_IDS.length +
  GO_WORK_MESSAGE_IDS.length +
  TSCONFIG_PATHS_MESSAGE_IDS.length +
  INTENT_MESSAGE_IDS.length +
  1;

/**
 * One custom-rule finding as a SARIF result.
 *
 * A result for the same reason a go.work drift finding is one: `check` fails
 * the build on a `fail`-verdict custom rule (`verdictFor`'s `customRuleFail`),
 * and a red job uploading an empty results array is the silent SARIF every
 * finding kind above exists to avoid.
 *
 * The location block is OMITTED entirely when the finding names no
 * `sourceFile` — a custom rule may judge the workspace as a whole, and SARIF
 * has no way to say "somewhere in this repository" that is not a fabricated
 * path. `region` follows the same rule one level down: present only when the
 * rule stated a line, and carrying `startColumn` only when it stated one too,
 * because a column with no line is a position SARIF cannot express.
 *
 * @param {{id: string, message: string, sourceFile?: string, line?: number,
 *   column?: number, project?: string}} finding A finding from
 *   `../commands/custom-rules.mjs`, its `id` already namespaced.
 * @param {number} ruleIndex Its descriptor's index in `sarifRules()`.
 * @returns {object}
 */
export function sarifCustomRuleResult(finding, ruleIndex) {
  const physicalLocation =
    finding.sourceFile === undefined
      ? null
      : {
          artifactLocation: { uri: toUriReference(finding.sourceFile) },
          ...(finding.line === undefined
            ? {}
            : {
                region: {
                  startLine: finding.line,
                  ...(finding.column === undefined ? {} : { startColumn: finding.column }),
                },
              }),
        };
  return {
    ruleId: finding.id,
    ruleIndex,
    level: "error",
    message: { text: finding.message },
    // Both blocks below are present only when the rule stated the fact behind
    // them: an empty property bag and a location naming no file each say
    // nothing an absent one does not, the same "no fact, no claim" bargain
    // every other optional field in this file keeps.
    ...(finding.project === undefined ? {} : { properties: { project: finding.project } }),
    ...(physicalLocation === null ? {} : { locations: [{ physicalLocation }] }),
  };
}

/**
 * One custom rule that reached no verdict, as a tool-execution notification.
 *
 * Two verdicts ride this lane rather than one, and the second is the reason
 * this function exists at all:
 *
 * - `unknown` — the rule loaded and could not judge. Trouble the tool hit, not
 *   a verdict it reached, exactly as `sarifFitnessNotification` treats an
 *   undetermined fitness function.
 * - `not_applicable` — the rule did not apply, which today means a path-scoped
 *   run (`../commands/custom-rules.mjs`). Unlike a passing rule, which really
 *   did look and really did find nothing, a rule that did not apply looked at
 *   nothing — and with no notification a scoped run over a workspace declaring
 *   custom rules would upload a SARIF log byte-identical to one from a
 *   workspace that declares none. That indistinguishability is the defect the
 *   empty-result invariant names (`../../../../AGENTS.md`), so the log says so.
 *
 * A `pass` gets nothing, deliberately: "no results" is SARIF's own way of
 * saying "looked, found nothing", which is exactly what a passing rule means.
 *
 * @param {{name: string, verdict: string, message: string}} decision
 * @returns {object}
 */
export function sarifCustomRuleNotification(decision) {
  const posture =
    decision.verdict === "not_applicable" ? "did not apply to this run" : "could not be judged";
  return {
    level: "warning",
    message: { text: `Custom rule "${decision.name}" ${posture}: ${decision.message}` },
  };
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
      // A waived violation is still a result — the run still fails — but the
      // properties say why it is present: an active waiver accepts it (with
      // its expiry), or an expired one re-asserted it. Absent on a plain
      // violation, so an unchanged tree produces unchanged SARIF.
      ...(violation.waivedBy
        ? {
            accepted: true,
            acceptedUntil: violation.waivedBy.expiresAt,
            acceptedReason: violation.waivedBy.reason,
          }
        : {}),
      ...(violation.evidence ? { evidence: violation.evidence } : {}),
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
 * One declared-edge violation as a SARIF result — an `implicit`-typed graph
 * edge (Nx's and `archkeep.json`'s `implicitDependencies`, a `moon.yml`'s
 * `dependsOn`) that crosses a `depConstraints` boundary with no import site
 * behind it.
 *
 * `messageId` is one of the same three `depConstraints` ids `sarifResult`
 * already catalogues (`onlyTagsConstraintViolation`,
 * `notTagsConstraintViolation`, `projectWithoutTagsCannotHaveDependencies`) —
 * `judgeEdge` (`../commands/edge-constraints.mjs`) reuses the identical
 * tag-matching functions `evaluate()`'s import-site path does, so the rule IS
 * the same rule and needs no second entry in `sarifRules()`; only the
 * `ruleIndex` lookup is shared, via `MESSAGE_IDS` rather than a second table.
 *
 * Positionless by construction — a declaration has no import statement to
 * point a `region` at — so the location carries the declaring manifest alone,
 * the same convention `sarifIntentResult` uses for a graph-edge finding with
 * no source site of its own.
 *
 * `finding.file` is that manifest, chosen per provider by `../../cli.mjs`'s
 * `declaredEdgeManifest`, and it has to be a path the reader's checkout
 * really contains: GitHub's code scanning drops a result whose `uri` names no
 * such file, without saying so — the identical failure
 * `../custom-rules/host.mjs`'s `isWorkspaceRelative` refuses for a wasm
 * rule's own findings. A Moon workspace got `archkeep.json` here until that
 * function learned the provider, which is a file a Moon tree is refused for
 * carrying at all.
 *
 * @param {object} finding A finding from `../commands/edge-constraints.mjs`'s
 *   `declaredEdgeViolationsForCheck`, extended with `file` — workspace-relative.
 * @returns {object}
 */
export function sarifDeclaredEdgeResult(finding) {
  return {
    ruleId: finding.messageId,
    ruleIndex: MESSAGE_IDS.indexOf(finding.messageId),
    level: "error",
    message: { text: finding.message },
    locations: [{ physicalLocation: { artifactLocation: { uri: toUriReference(finding.file) } } }],
    properties: {
      source: finding.source,
      target: finding.target,
    },
  };
}

/**
 * One architecture-intent finding as a SARIF result.
 *
 * A result for the same reason a go.work drift finding is one: it is a verdict
 * the run fails on. The finding is positionless by construction — intent
 * judges graph edges, not source sites, and the violating dependency's origin
 * line is not part of the record (`../architecture-intent/judge.mjs`) — so the
 * location carries the intent file alone rather than a fabricated line 1, the
 * reasoning `sarifNotification` states.
 *
 * @param {object} finding A finding from `../architecture-intent/judge.mjs`.
 * @returns {object}
 */
export function sarifIntentResult(finding) {
  return {
    ruleId: finding.rule,
    ruleIndex:
      MESSAGE_IDS.length +
      GO_WORK_MESSAGE_IDS.length +
      TSCONFIG_PATHS_MESSAGE_IDS.length +
      INTENT_MESSAGE_IDS.indexOf(finding.rule),
    level: "error",
    message: { text: finding.message },
    locations: [
      {
        physicalLocation: { artifactLocation: { uri: toUriReference("architecture-intent.json") } },
      },
    ],
    properties: {
      source: finding.source,
      target: finding.target,
      boundaryFrom: finding.boundaryFrom,
      boundaryTo: finding.boundaryTo,
    },
  };
}

/**
 * One `fail`-verdict fitness function as a SARIF result.
 *
 * A result for the same reason a go.work drift finding is one: `check` fails
 * the build on it (`verdictFor`'s `fitnessFail`), and an empty results array
 * on that run would be exactly the silent SARIF this function exists to
 * close. Positionless by construction — a fitness verdict judges the graph,
 * not a source site — so the location carries the boundary policy file that
 * declared the function, when the run resolved one (it always does, in
 * practice: a fitness verdict cannot exist without the `fitness` list that
 * only a loaded policy carries), the same "artifact alone, never a fabricated
 * line 1" convention `sarifIntentResult` and `sarifNotification` state.
 *
 * @param {{name: string, message: string}} decision A `fail` verdict record
 *   from `evaluateFitness` (`../governance/fitness-registry.mjs`).
 * @param {string|null} [policySource] Workspace-relative path to the boundary
 *   policy file that declared the function, or `null`/absent when this run
 *   resolved none — defensive only.
 * @returns {object}
 */
export function sarifFitnessResult(decision, policySource = null) {
  const result = {
    ruleId: FITNESS_FAILED_RULE_ID,
    ruleIndex:
      MESSAGE_IDS.length +
      GO_WORK_MESSAGE_IDS.length +
      TSCONFIG_PATHS_MESSAGE_IDS.length +
      INTENT_MESSAGE_IDS.length,
    level: "error",
    message: { text: `Fitness function "${decision.name}" failed: ${decision.message}` },
    properties: { name: decision.name },
  };
  if (policySource !== null) {
    result.locations = [
      { physicalLocation: { artifactLocation: { uri: toUriReference(policySource) } } },
    ];
  }
  return result;
}

/**
 * One `unknown`-verdict fitness function as a tool-execution notification.
 *
 * Not a result: an `unknown` verdict means the run could not determine the
 * function (`check` exits 3 on it, never 1 — `verdictFor`'s `fitnessUnknown`),
 * which is trouble the tool hit rather than a verdict it reached, the same
 * distinction `sarifNotification` draws for an unparseable file.
 *
 * @param {{name: string, message: string}} decision An `unknown` verdict
 *   record from `evaluateFitness`.
 * @returns {object}
 */
export function sarifFitnessNotification(decision) {
  return {
    level: "warning",
    message: {
      text: `Fitness function "${decision.name}" could not be determined: ${decision.message}`,
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
 * One unresolved architecture-intent boundary as a tool-execution notification.
 *
 * Not a result, for the reason `sarifFitnessNotification` states: a boundary
 * that matched no observed project is one this run could not verify (`check`
 * exits 3 on it, never 1 — `verdictFor`'s `intentUnresolved` in
 * `../../cli.mjs`), which is trouble the tool hit rather than a verdict it
 * reached. Filing it as an error-level result would put a boundary alert on an
 * edge nothing judged.
 *
 * Before this it reached no SARIF field at all: `buildSarifLog` read
 * `intent.findings` alone, so a run that exited 3 because the intent could not
 * be established uploaded a log byte-identical to a clean run's, while the text
 * face printed the warning (`./text.mjs`'s `formatIntentSection`). That is the
 * empty-result invariant (`../../../../AGENTS.md`) failing on the one surface a
 * CI gate reads.
 *
 * @param {{boundary: string, issue: string}} entry One `unresolved` record —
 *   the boundary that could not be verified, and why.
 * @returns {object}
 */
export function sarifIntentNotification(entry) {
  return {
    level: "warning",
    message: {
      text: `architecture-intent.json reached no verdict on boundary "${entry.boundary}": ${entry.issue}`,
    },
  };
}

/**
 * How many unowned-file paths a coverage-gap notification names before it
 * says how many are left — the same bound, and the same argument, as
 * `./text.mjs`'s `UNOWNED_SAMPLE_LIMIT`. Held separately rather than imported
 * because the two faces choose their own presentation and a shared constant
 * would make one face's readability decision binding on the other's.
 */
const UNOWNED_SAMPLE_LIMIT = 10;

/**
 * One degraded-coverage note as a tool-execution notification.
 *
 * A `warning` and never a result: the run reached its verdict on everything it
 * could see, and a gap says an entire CLASS of edge sits outside what the
 * workspace's other tools cover — no rule was crossed, so an error-level
 * annotation would claim a judgment nothing made. Dropping it is still the
 * silent direction: an Nx workspace whose polyglot manifests `nx affected` and
 * `@nx/enforce-module-boundaries` cannot see looks exactly like one that has
 * none, which is why the text face already says so (`./text.mjs`'s
 * `formatCoverageGaps`) and why this face must not be the one that stays quiet.
 *
 * A gap of any other kind speaks in the words its own `kind` gives rather than
 * borrowing the unregistered-plugin sentence: a note naming the wrong cause is
 * worse than one that names only the kind, because a reader cannot tell it is
 * wrong.
 *
 * @param {{kind: string, manifests?: string[], files?: string[],
 *   languages?: string[]}} gap One record from the run's `coverageGaps`
 *   (`../commands/check.mjs`).
 * @returns {object}
 */
export function sarifCoverageGapNotification(gap) {
  const manifests = gap.manifests ?? [];
  const found = manifests.length > 0 ? `: ${manifests.join(", ")}` : "";
  if (gap.kind === "unregistered-plugin") {
    return {
      level: "warning",
      message: {
        text:
          `nx.json does not register this plugin but ${manifests.length} polyglot ` +
          `manifest${manifests.length === 1 ? "" : "s"} found under project roots — ` +
          `nx affected and @nx/enforce-module-boundaries will not cover these edges${found}`,
      },
    };
  }
  // Tracked analyzable files no project owns. The count and the languages are
  // the whole message: the paths live in the JSON envelope, and a SARIF
  // notification listing hundreds of them would be a log nobody can read
  // rather than a fact an uploader can act on. Bounded the same way the text
  // face bounds its own sample (`./text.mjs`'s `formatUnownedFilesGap`), and
  // for the same reason, with the remainder named rather than dropped.
  if (gap.kind === "unowned-files") {
    const files = gap.files ?? [];
    const languages = gap.languages ?? [];
    const spans = languages.length > 0 ? ` (${languages.join(", ")})` : "";
    const shown = files.slice(0, UNOWNED_SAMPLE_LIMIT);
    const remaining = files.length - shown.length;
    const listed =
      shown.length > 0
        ? `: ${shown.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`
        : "";
    return {
      level: "warning",
      message: {
        text:
          `${files.length} tracked analyzable file${files.length === 1 ? "" : "s"}${spans} ` +
          `owned by no project — skipped, so no boundary verdict in this run covers ` +
          `${files.length === 1 ? "it" : "them"}${listed}`,
      },
    };
  }
  // The accepted counterpart: the same bounded sample, saying the state is a
  // recorded acceptance (`coverage.unowned`) rather than an open question —
  // still a warning, because an accepted hole is still a hole, and this face
  // must not be the one that stops saying so.
  if (gap.kind === "accepted-unowned-files") {
    const files = gap.files ?? [];
    const languages = gap.languages ?? [];
    const spans = languages.length > 0 ? ` (${languages.join(", ")})` : "";
    const shown = files.slice(0, UNOWNED_SAMPLE_LIMIT);
    const remaining = files.length - shown.length;
    const listed =
      shown.length > 0
        ? `: ${shown.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`
        : "";
    return {
      level: "warning",
      message: {
        text:
          `${files.length} tracked analyzable file${files.length === 1 ? "" : "s"}${spans} ` +
          `owned by no project — accepted as coverage holes by the policy's coverage.unowned, ` +
          `so no boundary verdict in this run covers ` +
          `${files.length === 1 ? "it" : "them"}${listed}`,
      },
    };
  }
  return {
    level: "warning",
    message: {
      text:
        `Coverage gap "${gap.kind}" — part of this workspace is outside what the ` +
        `run's other tools cover${found}`,
    },
  };
}

/**
 * One unresolved `decisionRef` — a row citing an ADR, rule, or fitness record
 * that does not exist — as a tool-execution notification.
 *
 * The parenthetical is the text face's own, verbatim (`./text.mjs`'s
 * `formatConstraint`), so a reader grepping either face for a citation finds
 * the same string. A `warning` and not a result either way: the row claims an
 * authority this run could not establish, which is not a boundary anyone
 * crossed.
 *
 * The set carries both kinds of row, and the exit code separates them: an
 * intent row's unresolved citation folds into the no-verdict lane
 * (`verdictFor`'s `intentUnresolvedDecisionRefs` in `../../cli.mjs`), while a
 * `depConstraints` row's changes no exit code at all. That second kind is the
 * one this notification is load-bearing for — nothing else on this surface
 * says the authority a row cites does not exist, so without it the fact
 * reaches every face but the machine-readable one.
 *
 * @param {string} decisionRef The cited value, exactly as the row spelled it.
 * @returns {object}
 */
export function sarifDecisionRefNotification(decisionRef) {
  return {
    level: "warning",
    message: {
      text: `decisionRef [${decisionRef}] (UNRESOLVED — no matching ADR, rule, or fitness record)`,
    },
  };
}

/**
 * The whole SARIF log.
 *
 * `policy` — which law this run enforced — rides `runs[0].properties`, SARIF's
 * own generic property-bag extension point (the 2.1.0 schema's `propertyBag`,
 * the same mechanism `sarifResult`'s own `properties` already use for
 * per-finding metadata upstream SARIF has no field for). Before this, neither
 * a clean run nor a violating one carried anything at all naming the config,
 * profile, or fingerprint that produced it — a code-scanning consumer had no
 * way to tell a strict run from one under a weaker policy (P1-01). Absent
 * (never a `null`-valued key) when no caller supplied one, so a SARIF log
 * built by anything other than `check` — nothing does today — stays
 * byte-identical to before this field existed.
 *
 * `fitness` — the per-function verdict records `check` already computes
 * (`../governance/fitness-registry.mjs`'s `evaluateFitness`) — was the one
 * finding kind this function never rendered at all: `check --format sarif`
 * exits 1 on a `fail`-verdict fitness function (`verdictFor`'s `fitnessFail`)
 * while this function produced zero results and zero notifications for it, so
 * a red CI job uploaded an empty SARIF log. Each `fail` decision becomes a
 * result (`sarifFitnessResult`) and each `unknown` one a notification
 * (`sarifFitnessNotification`), the same fail/could-not-determine split every
 * other finding kind above already keeps. `fitnessOverall` carries no
 * information this function needs beyond what each decision's own `verdict`
 * already states, so it is not read here — `formatReport` (text) is the
 * consumer that needs the aggregate label.
 *
 * `customRules` — the per-rule verdict records and the finding catalogue
 * `../commands/custom-rules.mjs` produces — rides the same fail/could-not-tell
 * split: each `fail` decision's findings become results resolving to their own
 * descriptor, and each `unknown` or `not_applicable` decision becomes a
 * notification (`sarifCustomRuleNotification` argues why the second one is
 * there). A finding on a decision that is not `fail` produces no result: the
 * rule reached no failing verdict, so an error-level annotation would claim a
 * judgment it did not make, and the notification names the rule either way.
 *
 * Three facts the text face already prints reach this one as notifications,
 * each of them a way a red run used to upload a log a clean run could have
 * produced:
 *
 * - `intent.unresolved` — one per boundary the declared intent could not be
 *   verified against (`sarifIntentNotification`). `intent.verdict` is read
 *   only as the backstop below it: a `no-verdict` naming no boundary at all
 *   still speaks, because the exit code it produces has to be legible here
 *   too. This function read `intent.findings` and nothing else before, so a
 *   `check` exiting 3 on an intent it could not establish uploaded SARIF
 *   byte-identical to a clean run's.
 * - `coverageGaps` — coverage this run knows it did not provide: the polyglot
 *   edges nothing in the workspace covers, and the tracked analyzable files no
 *   project owns (`sarifCoverageGapNotification`).
 * - `unresolvedDecisionRefs` — every citation no ADR, rule, or fitness record
 *   answers (`sarifDecisionRefNotification`), sorted, which is the order
 *   `../../cli.mjs`'s JSON envelope lists the same set in: two faces of one
 *   run must not disagree about which citations failed to resolve.
 *
 * `notes` is deliberately not read. It is a mixed bag — which `boundaryConfig`
 * entry bound the table (`../eslint-config.mjs`'s `extractBoundaryRule`), an
 * allowed intent row with no statement, and the counts of imports left
 * unconstrained — and none of it is a verdict or a subject that has one
 * pending. Its coverage half belongs beside the run's other "what was
 * inspected" numbers (`analyzed`, `imports`, `projects`), which this face
 * carries none of either; filing it as a `warning` notification instead would
 * report trouble on a run that hit none. Carrying them all in
 * `runs[0].properties` is the shape that would fit, and it changes what an
 * unchanged workspace reports, so it is its own decision rather than a side
 * effect of this one.
 *
 * @param {{violations: object[], failures: object[],
 *   goWork?: {findings: object[], moduleProjects?: number}|null,
 *   tsconfigPaths?: {findings: object[], aliases?: number, unjudged?: number}|null,
 *   declaredEdges?: {findings: object[], judged?: number}|null,
 *   intent?: {verdict?: string, findings: object[],
 *     unresolved?: {boundary: string, issue: string}[]}|null,
 *   fitness?: {name: string, message: string, verdict: string}[],
 *   fitnessOverall?: {verdict: string},
 *   customRules?: {decisions: object[], catalogue: {ruleId: string, rule: string,
 *     findingId: string, message: string}[]}|null,
 *   coverageGaps?: {kind: string, manifests?: string[]}[],
 *   unresolvedDecisionRefs?: Iterable<string>|null,
 *   policy?: {profile: string|null, source: string, fingerprint: string}|null}} run
 * @returns {object} A SARIF 2.1.0 log, ready to `JSON.stringify`.
 */
export function buildSarifLog({
  violations,
  failures,
  goWork,
  tsconfigPaths,
  declaredEdges,
  intent,
  fitness,
  customRules,
  coverageGaps = [],
  // The `Set` `../../cli.mjs`'s `check` builds, taken as any iterable of
  // strings so a caller holding the JSON envelope's array is not a caller this
  // face silently ignores.
  unresolvedDecisionRefs = null,
  policy = null,
}) {
  const fitnessDecisions = fitness ?? [];
  const fitnessFailed = fitnessDecisions.filter((decision) => decision.verdict === "fail");
  const fitnessUnresolved = fitnessDecisions.filter((decision) => decision.verdict === "unknown");
  const customCatalogue = customRules?.catalogue ?? [];
  const customDecisions = customRules?.decisions ?? [];
  // The descriptor index a finding's namespaced id resolves to, so a result
  // and its `reportingDescriptor` are looked up from ONE array rather than
  // from two orderings that could drift apart.
  const customRuleIndex = new Map(
    customCatalogue.map((entry, index) => [entry.ruleId, CUSTOM_RULE_INDEX_BASE + index]),
  );
  const customResults = customDecisions
    .filter((decision) => decision.verdict === "fail")
    .flatMap((decision) =>
      (decision.findings ?? []).map((finding) =>
        // `-1` cannot arrive here: the host refuses a verdict naming a finding
        // id its own catalogue does not declare (`../custom-rules/host.mjs`'s
        // `findingViolation`), which is where "a finding SARIF drops" is
        // stopped. `?? -1` is what makes a regression in that guarantee a
        // visibly broken index rather than an `undefined` GitHub ignores.
        sarifCustomRuleResult(finding, customRuleIndex.get(finding.id) ?? -1),
      ),
    );
  const customNotifications = customDecisions.filter(
    (decision) => decision.verdict === "unknown" || decision.verdict === "not_applicable",
  );
  const intentUnresolved = intent?.unresolved ?? [];
  // `verdict` is read only as the fallback below: every no-verdict
  // `../../cli.mjs` builds carries the boundaries in `unresolved`, so the
  // second clause fires only for an intent that lost that detail on the way
  // here — and an exit-3 intent naming no boundary must still not upload the
  // log a clean run would have.
  const intentNotifications =
    intentUnresolved.length > 0
      ? intentUnresolved.map(sarifIntentNotification)
      : intent?.verdict === "no-verdict"
        ? [
            {
              level: "warning",
              message: {
                text:
                  `architecture-intent.json reached no verdict and named no boundary — ` +
                  `the intent could not be verified, and the run fails.`,
              },
            },
          ]
        : [];
  // Sorted, matching the JSON envelope's list of the same set
  // (`../../cli.mjs`'s `check`), so the two faces of one run cannot be read as
  // disagreeing about which citations resolved.
  const decisionRefNotifications = [...(unresolvedDecisionRefs ?? [])]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(sarifDecisionRefNotification);
  const waived = violations.filter((violation) => violation.waivedBy);
  // A waived count rides as a notification so a consumer scanning for "did
  // this run accept anything" finds it without reading every result's
  // properties. The results themselves are unchanged (still error-level: an
  // accepted violation is still a violation); this is the count the mission
  // calls out — additive, and never a `!` that would read as a new error.
  const waiverNote =
    waived.length > 0
      ? [
          {
            level: "warning",
            message: {
              text:
                `${waived.length} boundary violation${waived.length === 1 ? "" : "s"} ` +
                `accepted by waiver — the run stays non-zero, and each accepted ` +
                `violation re-asserts the moment its waiver expires (see result properties ` +
                `"acceptedUntil" on the accepted results).`,
            },
          },
        ]
      : [];
  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: { driver: { name: "archkeep", rules: sarifRules(customCatalogue) } },
        columnKind: "utf16CodeUnits",
        ...(policy == null ? {} : { properties: { policy } }),
        results: [
          ...violations.map(sarifResult),
          ...(goWork?.findings ?? []).map(sarifGoWorkResult),
          ...(tsconfigPaths?.findings ?? []).map(sarifTsconfigPathsResult),
          ...(declaredEdges?.findings ?? []).map(sarifDeclaredEdgeResult),
          ...(intent?.findings ?? []).map(sarifIntentResult),
          ...fitnessFailed.map((decision) => sarifFitnessResult(decision, policy?.source ?? null)),
          ...customResults,
        ],
        invocations: [
          {
            // True even on a red run: the tool did its job, and the findings
            // are results rather than errors. Reporting false here makes GitHub
            // treat the upload as a broken analysis and drop the annotations.
            executionSuccessful: true,
            toolExecutionNotifications: [
              ...failures.map(sarifNotification),
              ...decisionRefNotifications,
              ...intentNotifications,
              ...fitnessUnresolved.map(sarifFitnessNotification),
              ...customNotifications.map(sarifCustomRuleNotification),
              ...coverageGaps.map(sarifCoverageGapNotification),
              ...waiverNote,
            ],
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
 *   intent?: {verdict?: string, findings: object[],
 *     unresolved?: {boundary: string, issue: string}[]}|null,
 *   fitness?: {name: string, message: string, verdict: string}[],
 *   fitnessOverall?: {verdict: string},
 *   customRules?: {decisions: object[], catalogue: object[]}|null,
 *   coverageGaps?: {kind: string, manifests?: string[]}[],
 *   unresolvedDecisionRefs?: Iterable<string>|null,
 *   policy?: {profile: string|null, source: string, fingerprint: string}|null}} run
 * @returns {string}
 */
export function formatSarif(run) {
  return `${JSON.stringify(buildSarifLog(run), null, 2)}\n`;
}

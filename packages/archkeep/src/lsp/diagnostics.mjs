/**
 * Analysis records and rule verdicts, rendered as LSP `Diagnostic` objects.
 *
 * ## The coordinate conversion is the whole reason this module exists
 *
 * The analysis contract is **1-based** in both axes, because that is what a
 * `file:line:column` terminal report wants (`../analysis/contract.md`). The
 * Language Server Protocol is **0-based** in both axes. One subtraction stands
 * between the two, and getting it wrong does not fail loudly: every diagnostic
 * still appears, one line above or below the import it is about, and every
 * developer who follows it edits the wrong line. So the conversion lives in one
 * exported function with its own tests rather than inline at three call sites.
 *
 * The column axis needs no re-encoding to go with the subtraction. The contract
 * counts UTF-16 code units from the start of the line (`../analysis/source-util.mjs`),
 * and `positionEncoding` defaults to `utf-16` in the protocol, so the two axes
 * already measure the same unit. A server that negotiated `utf-8` positions
 * would have to re-encode here; this one advertises none, which leaves the
 * default in force.
 *
 * ## Two kinds of diagnostic, and why the difference is visible in `code`
 *
 * A **violation** carries the upstream `messageId` as its `code`, which is what
 * lets a reader match this server's verdict against the one
 * `@nx/enforce-module-boundaries` gives for the same import.
 *
 * A **failure** — a file that could not be parsed, read, or resolved — carries
 * `ANALYSIS_FAILURE_CODE`, deliberately not one of `MESSAGE_IDS`. The
 * distinction is the point: a consumer must be able to tell "a rule found
 * something" from "no rule could look", and a shared code would collapse them.
 */
import { MESSAGE_IDS } from "../rules/messages.mjs";

import { DIAGNOSTIC_SEVERITY, SERVER_INFO } from "./protocol.mjs";

/**
 * The `source` field on every diagnostic this server publishes — what an editor
 * prints beside the message to say which tool spoke. Taken from the server's
 * own identity so the two can never disagree.
 */
export const DIAGNOSTIC_SOURCE = SERVER_INFO.name; // used by its own test

/**
 * The `code` on a diagnostic that reports the ABSENCE of a verdict rather than
 * a verdict. Named to be impossible to mistake for a rule id, and asserted
 * against `MESSAGE_IDS` at load so a future upstream id cannot silently collide
 * with it.
 */
export const ANALYSIS_FAILURE_CODE = "analysisFailure"; // used by its own test

if (MESSAGE_IDS.includes(ANALYSIS_FAILURE_CODE)) {
  throw new Error(
    `archkeep: '${ANALYSIS_FAILURE_CODE}' is now an upstream messageId, so a ` +
      `diagnostic reporting a failed analysis is indistinguishable from a rule verdict. ` +
      `Rename the failure code.`,
  );
}

/**
 * A document's lines, as the position axes count them.
 *
 * Split on `\n` alone: the contract puts a `\r` at the END of the preceding
 * line and never at the start of the next one, so a CRLF file reports the same
 * columns as an LF one. Splitting on both would shift every column on every
 * line of a CRLF file by nothing and every line index by one — the same
 * off-by-one this module exists to prevent, arriving through the back door.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function documentLines(text) {
  return text.split("\n");
}

const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

/** Quote characters a specifier can be written between, in any language here. */
const QUOTES = new Set(['"', "'", "`"]);

/**
 * The LSP range covering the import at a 1-based `(line, column)`.
 *
 * Three things happen here, and each is a decision:
 *
 * 1. **The subtraction.** 1-based in, 0-based out, both axes.
 * 2. **The width comes from the document, not from the record.** The analyzers
 *    point at the start of the written specifier — which for TypeScript and Go
 *    is the OPENING QUOTE and for Rust and Python is the first character of the
 *    path itself. Reading the character actually at the start settles which,
 *    instead of this module carrying a per-language table that would have to be
 *    updated with every new analyzer.
 * 3. **Everything is clamped to the line.** A record can outrun its line
 *    legitimately: Rust collapses a `use` path wrapped across several lines
 *    into one specifier. A range past the end of a line is out of spec, and
 *    clients differ on whether they drop such a diagnostic or clip it — a
 *    dropped diagnostic is silence, which this server may not produce.
 *
 * @param {{line: number|null, column: number|null, specifier?: string}} at
 * @param {string[]} lines From `documentLines`.
 * @returns {{start: {line: number, character: number}, end: {line: number, character: number}}}
 */
export function rangeAt(at, lines) {
  // used by its own test
  // A failure about the file as a whole carries no position (`contract.md`
  // fixes it as an explicit `null`). It gets the first line, whole: a
  // zero-width range at the origin renders as an invisible caret in most
  // editors, and an invisible report of "this file was not checked" is the one
  // outcome this server is written to avoid.
  if (at.line === null || at.line === undefined) {
    return {
      start: { line: 0, character: 0 },
      end: { line: 0, character: lines[0]?.length ?? 0 },
    };
  }

  const line = clamp(at.line - 1, 0, Math.max(lines.length - 1, 0));
  const text = lines[line] ?? "";
  const startCharacter = clamp((at.column ?? 1) - 1, 0, text.length);
  const specifier = at.specifier ?? "";
  const quoted = QUOTES.has(text[startCharacter]);
  const width = quoted ? specifier.length + 2 : specifier.length;
  const endCharacter = clamp(startCharacter + width, startCharacter, text.length);

  return {
    start: { line, character: startCharacter },
    end: { line, character: endCharacter },
  };
}

/**
 * One boundary violation as a diagnostic.
 *
 * Severity is `error`, matching what `@nx/enforce-module-boundaries` reports
 * for the same import in this workspace's ESLint config. A boundary violation
 * downgraded to a warning here would make the same import red in a JS file and
 * yellow in a Go one, for no reason a reader could discover.
 *
 * @param {object} violation A `Violation` from `../rules/`.
 * @param {string[]} lines
 * @returns {object} LSP `Diagnostic`.
 */
export function violationDiagnostic(violation, lines) {
  return {
    range: rangeAt(violation, lines),
    severity: DIAGNOSTIC_SEVERITY.error,
    code: violation.messageId,
    source: DIAGNOSTIC_SOURCE,
    message: violation.message,
  };
}

/**
 * One analysis failure as a diagnostic.
 *
 * Severity is `warning` rather than `error`, and the reason is what the two
 * words mean to a reader: an error says "this import is wrong", a warning here
 * says "this file's imports were not all judged". Neither is silence, which is
 * the only property that must hold. The message says so in words, because a
 * severity alone does not tell a developer that the verdict is missing.
 *
 * @param {object} failure An `AnalysisFailure` from `../analysis/`.
 * @param {string[]} lines
 * @returns {object} LSP `Diagnostic`.
 */
export function failureDiagnostic(failure, lines) {
  return {
    range: rangeAt(failure, lines),
    severity: DIAGNOSTIC_SEVERITY.warning,
    code: ANALYSIS_FAILURE_CODE,
    source: DIAGNOSTIC_SOURCE,
    message:
      `Module boundaries were not fully checked here: ${failure.reason}. ` +
      `Imports this server could not read are not covered by the verdict below.`,
  };
}

/**
 * How many gaps one diagnostic names before it counts the rest.
 *
 * A message is read or it is skipped, and a list of forty paths is skipped. Five
 * is enough to start on and short enough to finish; the count that follows says
 * the rest are there.
 */
const NAMED_GAP_LIMIT = 5;

/**
 * A diagnostic for a verdict computed against an INCOMPLETE project graph.
 *
 * Different from `analysisFailedDiagnostic` in exactly the way that matters to
 * a reader: a rule pass did run over this document and what it found is below.
 * What is missing is part of the tree it was compared against, so the verdict
 * can be short a violation it had no way to see. Severity is `warning` for the
 * same reason `failureDiagnostic` is — "not all judged", not "this is wrong".
 *
 * One diagnostic carries every gap. One per gap would scale the marker count
 * with the breakage, and a developer who has just broken one `project.json`
 * would meet a wall of identical warnings on a file that has nothing to do
 * with it.
 *
 * @param {string[]} gaps From `./workspace-index.mjs`' `indexGaps`.
 * @param {string[]} lines
 * @returns {object} LSP `Diagnostic`.
 */
export function incompleteIndexDiagnostic(gaps, lines) {
  const named = gaps.slice(0, NAMED_GAP_LIMIT);
  const remaining = gaps.length - named.length;
  return {
    range: rangeAt({ line: null, column: null }, lines),
    severity: DIAGNOSTIC_SEVERITY.warning,
    code: ANALYSIS_FAILURE_CODE,
    source: DIAGNOSTIC_SOURCE,
    message:
      `Module boundaries were checked against an INCOMPLETE view of this workspace, so the ` +
      `verdict for this file can be missing violations it had no way to see: ` +
      `${named.join("; ")}${remaining > 0 ? `; and ${remaining} more` : ""}. ` +
      `Fix what is named here and every open file is re-checked against the whole tree.`,
  };
}

/**
 * A diagnostic for a document the server could not analyze AT ALL — the config
 * would not load, the workspace index could not be built, an analyzer threw.
 *
 * This is the diagnostic that makes "no diagnostics" mean "no violations". Its
 * severity is `error`: the file's boundary verdict is not merely incomplete, it
 * is absent, and an editor showing nothing would be showing a clean file.
 *
 * @param {string} reason
 * @param {string[]} lines
 * @returns {object} LSP `Diagnostic`.
 */
export function analysisFailedDiagnostic(reason, lines) {
  return {
    range: rangeAt({ line: null, column: null }, lines),
    severity: DIAGNOSTIC_SEVERITY.error,
    code: ANALYSIS_FAILURE_CODE,
    source: DIAGNOSTIC_SOURCE,
    message:
      `Module boundaries could not be checked for this file: ${reason}. ` +
      `This is NOT a clean result — no rule ran.`,
  };
}

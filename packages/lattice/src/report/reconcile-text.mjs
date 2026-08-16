/**
 * The terminal report for the `reconcile` command: the intended model and the
 * observed architecture compared element by element, then — with `--propose` —
 * the ranked candidate list of model edits.
 *
 * Every section states what it is a claim about: the intent fingerprint and
 * row count, the observed project and edge counts (implicit edges excluded and
 * counted), then the divergence in fixed plane order — projects, edges, tags,
 * boundaries, intent rows — each only when it has content and each ending with
 * a count. A clean reconciliation prints "✔ model and reality agree" — never
 * "0 divergences", which would be ambiguous over a partial comparison
 * (`../../../../AGENTS.md`). An `unknown` score prints as such, never as a
 * match.
 *
 * The `--propose` face ends with the ranked candidate list: one line per
 * candidate in list order (severity, then plane, then name — the order
 * `buildRankedCandidates` returned), each carrying its `proposed` /
 * `notAuthoritative` marker explicitly so a reader can never mistake the
 * description of an edit for an applied one.
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`../README.md`).
 */

/**
 * Neutralises control and terminal-escape sequences in a name or value before
 * it is printed — the same `sanitize` `history-text.mjs` uses, so a crafted
 * project/tag/edge name cannot inject escape sequences into a consumer's
 * terminal (`../../../../SECURITY.md`).
 *
 * @param {string} text
 * @returns {string}
 */
function sanitize(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/[\x00-\x1F\x7F]/g, (c) => {
    if (c === "\n") return "\\n";
    if (c === "\t") return "\\t";
    if (c === "\r") return "\\r";
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

/** The planes in report order. */
const PLANE_ORDER = ["projects", "edges", "tags", "boundaries", "intentRows"];

/** A one-line label per plane, for the diverging section. */
const PLANE_LABEL = new Map([
  ["projects", "observed projects the model does not match"],
  ["edges", "observed edges the model does not match"],
  ["tags", "required-tag and tag-rule divergence"],
  ["boundaries", "boundary membership divergence"],
  ["intentRows", "intent rows whose statement is not observed"],
]);

/** The state symbol a diverging element prints. */
const STATE_SYMBOL = new Map([
  ["unexpected", "+"],
  ["absent", "-"],
  ["unknown", "?"],
]);

/**
 * One diverging element as a line.
 *
 * @param {import("../governance/reconcile-score.mjs").ScoredElement} element
 * @returns {string}
 */
function formatElement(element) {
  const symbol = STATE_SYMBOL.get(element.state) ?? " ";
  return `  ${symbol} ${sanitize(element.name)}  (${sanitize(element.classification)})`;
}

/**
 * One candidate as a line.
 *
 * @param {import("../governance/reconcile-candidates.mjs").CandidateEdit} candidate
 * @returns {string}
 */
function formatCandidate(candidate) {
  const edit = candidate.edit;
  const where = edit.section ? `${edit.action} in ${edit.section}` : edit.action;
  return `  ${candidate.kind}  ${sanitize(candidate.name)}  (${sanitize(where)} — ${sanitize(edit.reason)})`;
}

/**
 * The whole reconcile report.
 *
 * @param {object} input
 * @param {object} input.scores From `reconcileScores`.
 * @param {import("../governance/reconcile-candidates.mjs").CandidateEdit[]|null} input.candidates
 *   The ranked candidate list, `null` unless `--propose`.
 * @param {{fingerprint: string, rows: number}} input.intent
 * @param {{projects: number, edges: number, implicitEdges: number}} input.observed
 * @returns {string}
 */
export function formatReconcileReport({ scores, candidates, intent, observed }) {
  const sections = [];

  sections.push(
    `intent    ${intent.fingerprint} — ${intent.rows} row${intent.rows === 1 ? "" : "s"}`,
  );
  const excluded =
    observed.implicitEdges > 0
      ? ` (${observed.implicitEdges} implicit edge${observed.implicitEdges === 1 ? "" : "s"} excluded)`
      : "";
  sections.push(
    `observed  ${observed.projects} project${observed.projects === 1 ? "" : "s"}, ` +
      `${observed.edges} edge${observed.edges === 1 ? "" : "s"}${excluded}`,
  );

  let total = 0;
  for (const plane of PLANE_ORDER) {
    const group = scores[plane] ?? [];
    const diverging = group.filter((element) => element.state !== "match");
    if (diverging.length === 0) continue;
    total += diverging.length;
    const word = diverging.length === 1 ? "element" : "elements";
    sections.push(`⚠ ${diverging.length} ${word}: ${PLANE_LABEL.get(plane)}`);
    for (const element of diverging) sections.push(formatElement(element));
  }

  const inspected =
    `${observed.projects} project${observed.projects === 1 ? "" : "s"}` +
    ` and ${observed.edges} edge${observed.edges === 1 ? "" : "s"}` +
    (observed.implicitEdges > 0 ? ` (${observed.implicitEdges} implicit excluded)` : "");

  if (total === 0) {
    sections.push(
      `✔ no divergence — the observed architecture matches the intended model (${inspected})`,
    );
  } else {
    sections.push(`${total} divergence${total === 1 ? "" : "s"} (${inspected})`);
  }

  if (candidates) {
    const listLabel = candidates.length === 1 ? "1 candidate" : `${candidates.length} candidates`;
    sections.push(`proposal  ${listLabel}, ranked — proposed, not authoritative, never written`);
    for (const candidate of candidates) sections.push(formatCandidate(candidate));
    if (candidates.length > 0) {
      sections.push(
        "           — apply none of these without review; architecture-intent.json is untouched",
      );
    }
  }

  return sections.join("\n");
}

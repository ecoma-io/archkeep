/**
 * The terminal report for the `drift` command: the observed architecture
 * compared against the declared intended one.
 *
 * Each section — one per finding kind, in a fixed taxonomy order — is printed
 * only when it has content, and always ends with a count. A section with zero
 * entries is absent from the report, and the summary line then names "no
 * drift" rather than "0 findings": the two must never look identical, because
 * "no drift" is a claim about a complete comparison while "0 findings" would
 * be ambiguous over a partial one (`../../../../AGENTS.md`). The header
 * states what was compared — the intent fingerprint, the row count, and the
 * observed projects and edges, including how many `implicit` edges were
 * excluded — so "no drift" always reads as a claim about the exact tree and
 * contract the run judged.
 *
 * The taxonomy is the judge's own ten-verb catalogue
 * (`../architecture-intent/judge.mjs`) — the message ids `findings` carry in
 * their `rule`. This report is deterministic as long as the taxonomy list is,
 * and it never re-sorts: the judge already orders findings by total key.
 *
 * `notes` — coverage warnings the judge attaches (`../architecture-intent/judge.mjs`'s
 * `verdict.notes`; today an `optional: true` allowed row the team has not
 * built yet) — fold into the "observed" summary line the same way `check`'s
 * text face folds its own `notes` into its "inspected" line
 * (`../report/text.mjs`'s `formatReport`): appended as `; note`, never a
 * section a caller could silently drop.
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`./README.md`).
 */

/** The taxonomy in report order. Every rule `judgeIntent` can emit appears here. */
const TAXONOMY = [
  "intentForbiddenEdge",
  "intentAllowedMissing",
  "projectMissing",
  "projectPresent",
  "projectTagMissing",
  "dependencyForbidden",
  "dependencyNotAllowed",
  "tagDependencyForbidden",
  "intentUnknownProject",
  "intentUnknownTag",
];

/** A one-line heading per finding kind, for the grouped section. */
const LEAVE_LABEL = new Map([
  ["intentForbiddenEdge", "dependencies the intended architecture forbids exist"],
  ["intentAllowedMissing", "dependencies the intended architecture allows are not being built"],
  ["projectMissing", "projects the intent requires are missing"],
  ["projectPresent", "projects the intent forbids are present"],
  ["projectTagMissing", "required projects lack required tags"],
  ["dependencyForbidden", "dependencies the intent forbids exist"],
  ["dependencyNotAllowed", "dependencies that are not allowed exist"],
  ["tagDependencyForbidden", "tag-forbidden dependencies exist"],
  ["intentUnknownProject", "intent rows name projects the architecture does not have"],
  ["intentUnknownTag", "tag rules name tags no project carries"],
]);

function formatFinding(finding) {
  // Edge findings are compact — the pair is the fact. Presence and tag
  // findings carry no source/target pair (the canonical judge sets both to
  // null there), so their message — which names the project or tag — is the
  // fact.
  switch (finding.rule) {
    case "intentForbiddenEdge":
    case "intentAllowedMissing":
    case "dependencyForbidden":
    case "dependencyNotAllowed":
    case "tagDependencyForbidden":
      return `  ${finding.source} → ${finding.target}`;
    default:
      return `  ${finding.message}`;
  }
}

/**
 * The whole drift report.
 *
 * @param {{findings: {rule: string, source: string|null, target: string|null,
 *   message: string}[],
 *   intent: {fingerprint: string, rows: number},
 *   observed: {projects: number, edges: number, implicitEdges: number},
 *   notes?: string[],
 *   unresolvedDecisionRefs?: {kind: string, decisionRef: string}[],
 *   decisionRefsChecked?: number}} input
 *   `unresolvedDecisionRefs` — rows whose `decisionRef` cites no ADR, rule, or
 *   fitness record this workspace's registry knows — is a documentation fact,
 *   not a drift finding: it is rendered in its own section and never folds
 *   into the finding count or the "no drift" claim below. `decisionRefsChecked`
 *   is how many rows carry a `decisionRef` at all (resolved or not) — the
 *   same "no fact, no claim" distinction `formatGoWork` states: a section
 *   appears when the axis was exercised, silence only when it was not, so
 *   "every citation resolves" is never confused with "nothing uses the field".
 *   `notes` — coverage warnings (an `optional: true` allowed row not yet
 *   built) — fold into the "observed" line; empty/absent changes nothing.
 * @returns {string}
 */
export function formatDriftReport({
  findings,
  intent,
  observed,
  notes = [],
  unresolvedDecisionRefs = [],
  decisionRefsChecked = unresolvedDecisionRefs.length,
}) {
  const sections = [];

  sections.push(
    `intent    ${intent.fingerprint} — ${intent.rows} row${intent.rows === 1 ? "" : "s"}`,
  );
  const excluded =
    observed.implicitEdges > 0
      ? ` (${observed.implicitEdges} implicit edge${observed.implicitEdges === 1 ? "" : "s"} excluded)`
      : "";
  // `notes` folds in here, the same "; note" convention `check`'s text face
  // uses for its own coverage notes — appended, not a section a caller could
  // silently drop.
  const notesSuffix = notes.length > 0 ? `; ${notes.join("; ")}` : "";
  sections.push(
    `observed  ${observed.projects} project${observed.projects === 1 ? "" : "s"}, ` +
      `${observed.edges} edge${observed.edges === 1 ? "" : "s"}${excluded}${notesSuffix}`,
  );

  const byId = new Map();
  for (const finding of findings) {
    if (!byId.has(finding.rule)) byId.set(finding.rule, []);
    byId.get(finding.rule).push(finding);
  }

  // `total` is taken from `findings.length` itself, never accumulated only
  // over the rules this walk visits: a finding whose `rule` the taxonomy does
  // not know must still be counted and rendered, under its own heading,
  // rather than silently dropped from both the report and the "no drift"
  // claim below (the invariant this module is judged against,
  // `../../../../AGENTS.md`).
  const total = findings.length;
  for (const rule of TAXONOMY) {
    const group = byId.get(rule) ?? [];
    if (group.length === 0) continue;
    const word = group.length === 1 ? "finding" : "findings";
    sections.push(`⚠ ${group.length} ${word}: ${LEAVE_LABEL.get(rule)}`);
    for (const finding of group) {
      sections.push(formatFinding(finding));
    }
  }

  const knownRules = new Set(TAXONOMY);
  const unclassified = findings.filter((finding) => !knownRules.has(finding.rule));
  if (unclassified.length > 0) {
    const word = unclassified.length === 1 ? "finding" : "findings";
    sections.push(
      `⚠ ${unclassified.length} unclassified ${word}: rule id not in this report's taxonomy`,
    );
    for (const finding of unclassified) {
      sections.push(`  [${finding.rule}] ${formatFinding(finding).trimStart()}`);
    }
  }

  const inspected =
    `${observed.projects} project${observed.projects === 1 ? "" : "s"}` +
    ` and ${observed.edges} edge${observed.edges === 1 ? "" : "s"}` +
    (observed.implicitEdges > 0 ? ` (${observed.implicitEdges} implicit excluded)` : "");

  if (total === 0) {
    sections.push(`✔ no drift — the observed architecture matches the intended one (${inspected})`);
  } else {
    sections.push(`${total} drift finding${total === 1 ? "" : "s"} (${inspected})`);
  }

  // A separate, non-verdict axis — rendered last, after the drift verdict
  // itself, so a clean "no drift" line never reads as though it also vouches
  // for an unresolvable decisionRef sitting above it. "No fact, no claim": a
  // workspace whose rows carry no decisionRef gets no section at all, but one
  // that DOES use the field and finds every citation clean still gets a
  // stated line — silence there would be indistinguishable from never
  // having checked, the same reasoning `formatGoWork` states for its own axis.
  if (unresolvedDecisionRefs.length > 0) {
    sections.push(
      [
        `⚠ ${unresolvedDecisionRefs.length} intent row${unresolvedDecisionRefs.length === 1 ? "" : "s"} ` +
          `cite${unresolvedDecisionRefs.length === 1 ? "s" : ""} a decisionRef that does not resolve ` +
          `to a known ADR, rule, or fitness record:`,
        ...unresolvedDecisionRefs.map(({ kind, decisionRef }) => `  ${kind} — "${decisionRef}"`),
      ].join("\n"),
    );
  } else if (decisionRefsChecked > 0) {
    sections.push(
      `✔ every decisionRef citation (${decisionRefsChecked}) resolves to a known ADR, rule, or fitness record`,
    );
  }

  return sections.join("\n");
}

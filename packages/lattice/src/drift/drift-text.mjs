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
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`../README.md`).
 */

/** The taxonomy in report order. Every id `computeDrift` can emit appears here; */
/** the report is deterministic as long as this list is, and it never re-sorts. */
const TAXONOMY = [
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
  switch (finding.messageId) {
    case "dependencyForbidden":
    case "dependencyNotAllowed":
    case "tagDependencyForbidden":
      return `  ${finding.source} → ${finding.target}`;
    case "intentUnknownProject":
    case "intentUnknownTag":
    case "projectMissing":
    case "projectPresent":
      return `  ${finding.row}`;
    case "projectTagMissing":
      return `  ${finding.row}  ${finding.detail}`;
    default:
      return `  ${finding.row}`;
  }
}

/**
 * The whole drift report.
 *
 * @param {{findings: import("./drift.mjs").DriftFinding[],
 *   intent: {fingerprint: string, rows: number},
 *   observed: {projects: number, edges: number, implicitEdges: number}}} input
 * @returns {string}
 */
export function formatDriftReport({ findings, intent, observed }) {
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

  const byId = new Map();
  for (const finding of findings) {
    if (!byId.has(finding.messageId)) byId.set(finding.messageId, []);
    byId.get(finding.messageId).push(finding);
  }

  let total = 0;
  for (const messageId of TAXONOMY) {
    const group = byId.get(messageId) ?? [];
    if (group.length === 0) continue;
    total += group.length;
    const word = group.length === 1 ? "finding" : "findings";
    sections.push(`⚠ ${group.length} ${word}: ${LEAVE_LABEL.get(messageId)}`);
    for (const finding of group) {
      sections.push(formatFinding(finding));
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

  return sections.join("\n");
}

/**
 * The terminal report for the `explain` command: one import site's judgment,
 * explained.
 *
 * The first line is `file:line:column`, unindented and with no prefix — the
 * same shape the terminal and the editor both make clickable, and the same
 * shape `./text.mjs` uses for violations. Everything after it is indented,
 * so the position line stands alone.
 *
 * Eight things are printed, each with a reader in mind:
 *
 * - the import specifier and its kind (what was written)
 * - the source project and its tags (who wrote it)
 * - the target project and its tags (where it reaches)
 * - the constraint row(s) that matched (which rule applied)
 * - the verdict (violation or allowed)
 * - the message, when there is one (what the verdict means in prose)
 * - for a violation: the allowed direction when the governing row states one,
 *   and a remediation line that is the author's declared guidance verbatim —
 *   or, when none is declared, an explicit pointer at the constraint row and
 *   its `decisionRef`, never a fix this renderer composed
 * - for a matched row carrying a `decisionRef`: the governing decision's
 *   status and authority, its context/rationale prose, and its supersession
 *   lineage — or, when the ref or the registry cannot be resolved, a loud
 *   UNRESOLVED line naming the reason (an empty result here would read as
 *   "no decision behind this row", which is a different claim)
 * - coverage information (whether this explanation is complete)
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`../README.md`).
 */

/** Two spaces of indent for detail lines. */
const DETAIL = "  ";

/**
 * Tags rendered as a bracketed list: `[layer:domain, scope:billing]`.
 * An empty list renders as `[]`.
 *
 * @param {string[]} tags
 * @returns {string}
 */
function formatTags(tags) {
  return `[${tags.join(", ")}]`;
}

/**
 * A project name with its tags: `billing-core [layer:domain, scope:billing]`.
 * A null project renders as `(unresolved)`.
 *
 * @param {string|null} name
 * @param {string[]} tags
 * @returns {string}
 */
function formatProject(name, tags) {
  if (name === null) return "(unresolved)";
  return `${name} ${formatTags(tags)}`;
}

/**
 * One constraint row rendered from the row's own keys — the same function
 * `./text.mjs`'s `formatConstraint` uses, copied here because that function
 * is not exported (it does not need to be; the two are parallel renderers).
 *
 * @param {object|null} constraint A `depConstraints` row, or `null`.
 * @returns {string}
 */
function formatConstraint(constraint) {
  if (!constraint) {
    return "not driven by a depConstraints row — this check fires before the table is read";
  }
  const source =
    "allSourceTags" in constraint
      ? `allSourceTags [${constraint.allSourceTags.join(", ")}]`
      : `sourceTag ${constraint.sourceTag}`;
  const rest = Object.entries(constraint)
    .filter(([key]) => key !== "sourceTag" && key !== "allSourceTags")
    .map(([key, value]) => `${key} [${(Array.isArray(value) ? value : [value]).join(", ")}]`);
  return [source, ...rest].join(" → ");
}

/**
 * One matched constraint row rendered as a readable line.
 *
 * @param {object} constraint A `depConstraints` row.
 * @returns {string}
 */
function formatMatchedConstraint(constraint) {
  return formatConstraint(constraint);
}

/**
 * The status line for one governing decision: `id  (status — authority)`.
 *
 * @param {object} entry A resolved `"adr"` chain entry.
 * @returns {string}
 */
function decisionStatusLine(entry) {
  const authority = entry.authority ? " — has authority" : " — no authority";
  return `${DETAIL}decision     ${entry.record.id}  (${entry.record.status}${authority})`;
}

/**
 * The first non-empty line of a prose field, trimmed to a display width.
 * The excerpt is a pointer, never a paraphrase — a reader who needs the whole
 * context opens the ADR.
 *
 * @param {string} text
 * @returns {string}
 */
function proseExcerpt(text) {
  const first = text.split("\n").find((line) => line.trim() !== "") ?? "";
  const trimmed = first.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

/**
 * One decision-chain entry as report lines. The chain never renders blank:
 * a ref the registry cannot resolve, and a ref that cannot be read at all,
 * both render as UNRESOLVED naming the reason (AGENTS.md: "an empty result
 * is a claim, not a shrug").
 *
 * @param {object} entry One `explanation.decisions` entry.
 * @returns {string[]}
 */
function formatDecisionEntry(entry) {
  if (entry.resolution === "unknown") {
    return [`${DETAIL}decisionRef  ${entry.ref} (UNRESOLVED — ${entry.reason})`];
  }
  if (entry.resolution === "fitness") {
    return [`${DETAIL}decisionRef  ${entry.ref} — a fitness rule this law declares`];
  }
  const lines = [decisionStatusLine(entry)];
  if (typeof entry.record.context === "string") {
    lines.push(`${DETAIL}context      ${proseExcerpt(entry.record.context)}`);
  }
  if (typeof entry.record.rationale === "string") {
    lines.push(`${DETAIL}rationale    ${proseExcerpt(entry.record.rationale)}`);
  }
  const supersedes = Array.isArray(entry.record.supersedes) ? entry.record.supersedes : [];
  const supersededBy = Array.isArray(entry.record.supersededBy) ? entry.record.supersededBy : [];
  if (supersedes.length > 0 || supersededBy.length > 0) {
    const parts = [];
    if (supersedes.length > 0) parts.push(`supersedes: ${supersedes.join(", ")}`);
    if (supersededBy.length > 0) parts.push(`superseded by: ${supersededBy.join(", ")}`);
    lines.push(`${DETAIL}lineage      ${parts.join(" · ")}`);
  } else {
    lines.push(`${DETAIL}lineage      none — no supersession chain is recorded for this decision`);
  }
  for (const gap of entry.lineage?.unresolved ?? []) {
    lines.push(`${DETAIL}lineage      UNRESOLVED — ${gap.reason}`);
  }
  return lines;
}

/**
 * The lineage-comparison disclosure — `explain`'s optional base-registry
 * seam, rendered only when the caller supplied a base registry and the
 * resolved-site explanation carries a `decisionChange` field. The fact is
 * stated either way — superseded or not — because "the lineage was compared
 * and did not move" must read differently from "no comparison happened"
 * (`../../../../AGENTS.md`: an empty result is a claim, never a shrug);
 * every disclosure note rides appended lines. Appended only: an explanation
 * that has no `decisionChange` field renders exactly as it did before.
 *
 * @param {{superseded: boolean, comparable: boolean, notes: string[]}} change
 *   A `detectDecisionChange` result. `superseded` is meaningful only when
 *   `comparable` is `true`; a non-comparable comparison (one-sided or
 *   unreadable) renders "could not compare", never "did not move", because
 *   the latter would assert a fact the comparison could not hold.
 * @returns {string[]}
 */
function formatDecisionChange(change) {
  const lines = [];
  if (change.comparable === false) {
    lines.push(
      `${DETAIL}decisionChange  could not compare — the decision lineage was not established between the compared registry states`,
    );
  } else if (change.superseded) {
    lines.push(
      `${DETAIL}decisionChange  superseded — the decision lineage moved between the compared registry states`,
    );
  } else {
    lines.push(
      `${DETAIL}decisionChange  none — the decision lineage did not move between the compared registry states`,
    );
  }
  for (const note of change.notes) {
    lines.push(`${DETAIL}decisionChange  ${note}`);
  }
  return lines;
}

/**
 * The whole explain report.
 *
 * @param {{explanation: object, coverage: object}} input
 * @returns {string}
 */
export function formatExplainReport({ explanation, coverage }) {
  const { site } = explanation;
  const sections = [];

  // The position line — same shape as a violation entry.
  sections.push(`${site.file}:${site.line}:${site.column}`);

  if (explanation.unresolvable) {
    sections.push(`${DETAIL}unresolvable  ${explanation.reason}`);
    sections.push(
      `${DETAIL}verdict      UNRESOLVABLE — this import site could not be resolved statically, ` +
        `so no judgment was reached`,
    );
  } else {
    const imp = explanation.import;
    sections.push(`${DETAIL}import       ${JSON.stringify(imp.specifier)} (${imp.kind})`);
    sections.push(
      `${DETAIL}source       ${formatProject(explanation.sourceProject, explanation.sourceTags)}`,
    );
    sections.push(
      `${DETAIL}target       ${formatProject(explanation.targetProject, explanation.targetTags)}`,
    );

    if (explanation.matchedConstraints.length > 0) {
      for (const constraint of explanation.matchedConstraints) {
        sections.push(`${DETAIL}constraint   ${formatMatchedConstraint(constraint)}`);
      }
    } else {
      sections.push(
        `${DETAIL}constraint   (none — the source project matches no depConstraints row)`,
      );
    }

    if (explanation.violations && explanation.violations.length > 0) {
      for (const v of explanation.violations) {
        sections.push(`${DETAIL}verdict      VIOLATION — ${v.messageId}`);
        // The rendered message — same indent as the violation report.
        const message = v.message
          .split("\n")
          .map((line) => (line === "" ? "" : `${DETAIL}    ${line}`))
          .join("\n");
        sections.push(message);
        if (v.constraint?.description) {
          sections.push(`${DETAIL}rule         ${v.constraint.description}`);
        }
        // The allowed direction, verbatim from the governing row when it
        // states one. A `notDependOnLibsWithTags` row states no allowed list,
        // and computing its complement here would be this renderer inventing
        // a direction the law never wrote — the constraint line above is the
        // honest answer there, so no line is printed.
        if (Array.isArray(v.constraint?.onlyDependOnLibsWithTags)) {
          sections.push(
            `${DETAIL}allowed      ${formatTags(v.constraint.onlyDependOnLibsWithTags)}`,
          );
        }
        // The remediation line is always printed for a violation: the
        // author's declared guidance verbatim, or an explicit pointer at
        // where guidance lives — never a fix this renderer composed, and
        // never silence a reader could mistake for "nothing to consult".
        if (v.constraint?.remediation) {
          sections.push(`${DETAIL}remediation  ${v.constraint.remediation}`);
        } else if (v.constraint) {
          const ref = v.constraint.decisionRef
            ? ` and its decisionRef ${v.constraint.decisionRef}`
            : "";
          sections.push(`${DETAIL}remediation  none declared — consult the constraint row${ref}`);
        } else {
          sections.push(
            `${DETAIL}remediation  none declared — no depConstraints row drives this check`,
          );
        }
      }
    } else {
      sections.push(`${DETAIL}verdict      allowed — no constraint was violated`);
    }
    // The lineage-comparison disclosure — present only when the explanation
    // carries it (the caller supplied a base registry); otherwise nothing
    // here renders, and the report is byte-for-byte what it was.
    if (explanation.decisionChange !== undefined) {
      sections.push(...formatDecisionChange(explanation.decisionChange));
    }

    // The "why does this constraint exist" chain — one block per governing
    // decision the matched rows name. Additive: an explanation whose rows
    // carry no `decisionRef` has no `decisions` list, and renders exactly as
    // it did before this section existed.
    for (const entry of explanation.decisions ?? []) {
      sections.push(...formatDecisionEntry(entry));
    }
  }

  // Coverage — same shape as every other command's footer.
  const inspected =
    `${coverage.imports} import${coverage.imports === 1 ? "" : "s"} in ` +
    `${coverage.analyzedFiles} file${coverage.analyzedFiles === 1 ? "" : "s"} across ` +
    `${coverage.projects} project${coverage.projects === 1 ? "" : "s"}`;

  if (coverage.complete) {
    sections.push(`✔ coverage complete (${inspected})`);
  } else {
    sections.push(
      `✖ coverage incomplete — ${coverage.notAnalyzed.length} file${coverage.notAnalyzed.length === 1 ? "" : "s"} ` +
        `could not be analyzed (${inspected})`,
    );
  }

  return sections.join("\n");
}

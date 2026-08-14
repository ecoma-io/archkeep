/**
 * The terminal report for the `explain` command: one import site's judgment,
 * explained.
 *
 * The first line is `file:line:column`, unindented and with no prefix — the
 * same shape the terminal and the editor both make clickable, and the same
 * shape `./text.mjs` uses for violations. Everything after it is indented,
 * so the position line stands alone.
 *
 * Seven things are printed, each with a reader in mind:
 *
 * - the import specifier and its kind (what was written)
 * - the source project and its tags (who wrote it)
 * - the target project and its tags (where it reaches)
 * - the constraint row(s) that matched (which rule applied)
 * - the verdict (violation or allowed)
 * - the message, when there is one (what the verdict means in prose)
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

    if (explanation.violation) {
      const v = explanation.violation;
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
      if (v.constraint?.remediation) {
        sections.push(`${DETAIL}remediation  ${v.constraint.remediation}`);
      }
    } else {
      sections.push(`${DETAIL}verdict      allowed — no constraint was violated`);
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

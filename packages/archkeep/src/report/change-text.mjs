/**
 * The terminal report for the `change` command: a declared change-intent
 * contract against the architectural delta actually observed
 * (`../commands/change.mjs`).
 *
 * The report is a review document, so it renders every axis separately and in
 * full: what was declared, what matched, what appeared without a declaration,
 * which declared changes never happened, how each declared constraint judged,
 * and — informational, never this command's verdict — how many live boundary
 * violations the tree currently carries under the current law, with `check`
 * named as the authority on that axis. A section renders only when it has
 * content; the closing line always states what was compared and with what
 * outcome, so an empty reconciliation is a verifiable claim rather than
 * silence (`../../../../AGENTS.md`).
 *
 * With `--event-out`, the report's first section names the reconcile event
 * that was recorded (id, directory, duplicate-or-written) — the one section
 * that renders only when the flag was passed, so the default report is
 * byte-identical to a pre-wave-3 run.
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`./README.md`).
 */

/** One expected-fact row as report lines. */
function factLines(entry) {
  switch (entry.kind) {
    case "project-added":
      return [`  + project ${entry.project}`];
    case "project-removed":
      return [`  - project ${entry.project}`];
    case "edge-added":
      return [
        `  + edge ${entry.from} -> ${entry.to}${entry.type === undefined ? "" : ` (${entry.type})`}`,
      ];
    case "edge-removed":
      return [
        `  - edge ${entry.from} -> ${entry.to}${entry.type === undefined ? "" : ` (${entry.type})`}`,
      ];
    case "project-changed": {
      const lines = [`  ! project ${entry.project} changed:`];
      for (const change of entry.changes ?? []) {
        lines.push(
          `      ${change.field}: ${JSON.stringify(change.baseline)} -> ${JSON.stringify(change.head)}`,
        );
      }
      return lines;
    }
    default:
      return [`  ? ${entry.kind} ${entry.project ?? `${entry.from} -> ${entry.to}`}`];
  }
}

/** One constraint verdict row as its report lines. */
function constraintLines(row) {
  const glyph = row.verdict === "pass" ? "✔" : row.verdict === "fail" ? "✗" : "?";
  return [`${glyph} ${row.name}: ${row.verdict} — ${row.message}`];
}

/** A side's identity for prose: its commit prefix, or an honest absence. */
function describeOrigin(provenance) {
  if (!provenance || typeof provenance.commit !== "string") return "unverified origin";
  const dirty = provenance.dirty ? ", dirty" : "";
  return `${provenance.commit.slice(0, 8)}${dirty}`;
}

/**
 * The whole change report.
 *
 * @param {{change: object, coverage: object, eventWritten?: object}} input
 *   `change` is `../commands/change.mjs`'s result payload; `coverage` its
 *   coverage block; `eventWritten` the reconcile event write result (`{dir,
 *   id, duplicate}`) — present ONLY when `--event-out` was passed, so the
 *   default report is byte-identical to a pre-wave-3 run.
 * @returns {string}
 */
export function formatChangeReport({ change, coverage, eventWritten }) {
  const { intent, baseline, head, reconciliation, constraints, policy } = change;
  const sections = [];

  // The reconcile event line renders ONLY when `--event-out` was passed and
  // the run wrote one (`../commands/change.mjs`): the write is opt-in output
  // the report makes observable rather than a file appearing silently.
  if (eventWritten !== undefined) {
    sections.push(
      `event      reconcile/change ${eventWritten.id.slice(0, 8)} → ${eventWritten.dir}` +
        (eventWritten.duplicate ? " (duplicate — nothing written)" : ""),
    );
  }

  sections.push(
    `intent     ${intent.file} — base ${intent.base.commit.slice(0, 8)}` +
      (intent.summary === undefined ? "" : `\n             "${intent.summary}"`),
  );
  sections.push(
    `baseline   ${baseline.path} — ${describeOrigin(baseline.provenance)}, ` +
      `${baseline.records} record${baseline.records === 1 ? "" : "s"}, ` +
      `${baseline.projects} project${baseline.projects === 1 ? "" : "s"}`,
  );
  sections.push(
    `head       ${describeOrigin(head.provenance)}, ` +
      `${head.projects} project${head.projects === 1 ? "" : "s"}`,
  );

  for (const note of coverage.notes ?? []) sections.push(`⚠ ${note}`);

  const verdictLine = {
    matched: "✔ MATCHED — the delta is exactly the declared change",
    undeclared: "⚠ UNDECLARED — the delta contains changes no declaration covers",
    unfulfilled: "✗ UNFULFILLED — nothing undeclared, but declared changes never happened",
    unproven: "? UNPROVEN — the base identity could not be established",
  }[reconciliation.verdict];
  sections.push(`reconciliation ${verdictLine}`);
  for (const reason of reconciliation.reasons) sections.push(`  because: ${reason}`);

  if (reconciliation.matched.length > 0) {
    sections.push(
      `✔ ${reconciliation.matched.length} declared change${reconciliation.matched.length === 1 ? "" : "s"} observed`,
      ...reconciliation.matched.flatMap(factLines),
    );
  }
  if (reconciliation.unexpected.length > 0) {
    sections.push(
      `! ${reconciliation.unexpected.length} undeclared material change${reconciliation.unexpected.length === 1 ? "" : "s"} — a review signal, not a law verdict`,
      ...reconciliation.unexpected.flatMap(factLines),
    );
  }
  if (reconciliation.missingExpected.length > 0) {
    sections.push(
      `? ${reconciliation.missingExpected.length} declared change${reconciliation.missingExpected.length === 1 ? "" : "s"} never observed`,
      ...reconciliation.missingExpected.flatMap(factLines),
    );
  }

  if (constraints.length > 0) {
    sections.push("declared constraints");
    sections.push(...constraints.flatMap(constraintLines));
  }

  // Informational on purpose: this number says what `check` would count right
  // now. It gates nothing here — collapsing it into the intent verdict would
  // hide one signal behind the other.
  sections.push(
    policy.liveViolations === null
      ? `workspace law  not evaluated — the run could not prove the base identity (archkeep check remains the authority)`
      : `workspace law  ${policy.liveViolations} live violation${policy.liveViolations === 1 ? "" : "s"} under the current law${policy.changedSinceBase ? ", which changed since capture" : ""} — informational; archkeep check remains the authoritative verdict`,
  );

  // The closing claim always states what was compared, so every outcome —
  // including a full match over an unchanged tree — is a verifiable statement
  // rather than silence.
  const declaredCount =
    intent.declared.projectsAdd +
    intent.declared.projectsRemove +
    intent.declared.edgesAdd +
    intent.declared.edgesRemove;
  sections.push(
    `reconciled ${declaredCount} declared change${declaredCount === 1 ? "" : "s"} and ` +
      `${constraints.length} declared constraint${constraints.length === 1 ? "" : "s"} — ` +
      `base ${describeOrigin(baseline.provenance)} (${baseline.projects} projects, ` +
      `${baseline.records} records) against head ${describeOrigin(head.provenance)} ` +
      `(${head.projects} projects)`,
  );

  return sections.join("\n");
}

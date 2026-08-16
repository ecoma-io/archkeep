/**
 * The terminal report for the agent architecture planning context: the
 * deterministic facts an agent reasons over before changing a project.
 *
 * The layout mirrors what `context`, `impact`, `graph` and `check` each print,
 * so a reader who has seen those commands recognises the same shapes here. The
 * coverage claim sits ABOVE everything — the reader must know whether the
 * result is complete before reading a single entry, the same reasoning as
 * `./impact-text.mjs`.
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`../README.md`). Every fact here comes from the
 * `result` object the command built; nothing is recomputed, and nothing is
 * guessed. Sections that are empty state so rather than printing nothing — a
 * plan with no violations and a plan the renderer forgot are not the same
 * document (`AGENTS.md`: "an empty result is a claim, not a shrug").
 */

import { formatConstraint } from "./text.mjs";

/** Two spaces of indent for detail lines. */
const DETAIL = "  ";

/**
 * The whole planning-context report.
 *
 * @param {{project: object, coverage: object}} input The `result` object the
 *   plan command built, plus its coverage.
 * @returns {string}
 */
export function formatPlanContextReport({ project, coverage }) {
  const sections = [];

  const inspected =
    `${coverage.imports} import${coverage.imports === 1 ? "" : "s"} in ` +
    `${coverage.analyzedFiles} file${coverage.analyzedFiles === 1 ? "" : "s"} across ` +
    `${coverage.projects} project${coverage.projects === 1 ? "" : "s"}`;

  if (coverage.complete) {
    sections.push(`✔ planning context complete (${inspected})`);
  } else {
    const notAnalyzedCount = coverage.notAnalyzed.length;
    sections.push(
      `✖ planning context incomplete — ${notAnalyzedCount} file${notAnalyzedCount === 1 ? "" : "s"} ` +
        `could not be analyzed, so these facts may be against an incomplete graph (${inspected})`,
    );
  }

  const plan = project.plan;

  // Target project, tags, policy fingerprint.
  const tagsText = project.tags.length > 0 ? project.tags.join(", ") : "none";
  sections.push(`Project  ${project.project}`);
  sections.push(`Tags     ${tagsText}`);
  sections.push(`Policy   fingerprint ${plan.policyFingerprint}`);

  // Intent-bearing constraints.
  if (project.constraints.length > 0) {
    const count = project.constraints.length;
    sections.push(`Constraints (${count} row${count === 1 ? "" : "s"} govern this project):`);
    for (const constraint of project.constraints) {
      sections.push(`${DETAIL}${formatConstraint(constraint)}`);
      if (constraint.description) {
        sections.push(`${DETAIL}  description  ${constraint.description}`);
      }
      if (constraint.remediation) {
        sections.push(`${DETAIL}  remediation   ${constraint.remediation}`);
      }
    }
  } else {
    sections.push(
      "Constraints  (no matching constraint rows — this project's tags match no depConstraints entry)",
    );
  }

  // Affected projects.
  sections.push("Architecture");
  sections.push(
    `${DETAIL}affected projects  ${plan.architecture.targets.length > 0 ? plan.architecture.targets.join(", ") : "(none given — the whole workspace is in scope)"}`,
  );
  sections.push(`${DETAIL}projects           ${plan.architecture.projects.length}`);
  sections.push(`${DETAIL}dependencies       ${plan.architecture.dependencies.length}`);

  // Impact, capped with overflow note.
  sections.push("Impact");
  for (const entry of plan.impact) {
    const capNote = entry.hasMore
      ? ` (… and ${entry.dependentsTotal - entry.dependents.length} more)`
      : "";
    const word = entry.dependentsTotal === 1 ? "project" : "projects";
    sections.push(
      `${DETAIL}${entry.project}: ${entry.dependentsTotal} ${word} depend${entry.dependentsTotal === 1 ? "s" : ""} on it` +
        ` (direct ${entry.direct.length}, transitive ${entry.transitive.length})${capNote}`,
    );
  }

  // Violations (scoped reporting, whole-tree verdict).
  sections.push(`Violations (${plan.violations.length} in scope of this change)`);
  if (plan.violations.length === 0) {
    sections.push(
      `${DETAIL}none — the full-workspace rule-engine verdict found no violations in scope`,
    );
  } else {
    for (const violation of plan.violations) {
      const edge =
        `${violation.sourceProject ?? "(no project)"} → ` +
        `${violation.targetProject ?? "(unresolved)"}`;
      sections.push(`${DETAIL}${edge}  ${violation.messageId}  ${violation.sourceFile}`);
    }
  }

  // Drift.
  sections.push("Drift");
  sections.push(`${DETAIL}go.work        ${driftText(plan.drift.goWork)}`);
  sections.push(`${DETAIL}tsconfig paths ${driftText(plan.drift.tsconfigPaths)}`);

  // Canonical Architecture Intent — the same fold `check` and `drift` report.
  const intentCount = plan.intent?.findings.length ?? 0;
  const intentUnresolved = plan.intent?.unresolved.length ?? 0;
  sections.push(`Intent (${plan.intent ? "verified" : "no intent declared"})`);
  if (!plan.intent) {
    sections.push(
      `${DETAIL}towards architecture-intent.json — the workspace declares no intent, so none is judged`,
    );
  } else {
    const verdict =
      intentCount > 0
        ? `${intentCount} finding${intentCount === 1 ? "" : "s"}`
        : intentUnresolved > 0
          ? `no-verdict (${intentUnresolved} unresolvable)`
          : "ok";
    sections.push(`${DETAIL}${plan.intent.verdict}: ${verdict} (${plan.intent.rows} rows)`);
  }

  // Verification commands.
  sections.push("Verify after the change");
  for (const command of plan.verify) {
    sections.push(`${DETAIL}${command}`);
  }

  return sections.join("\n");
}

/**
 * One drift section as text: a finding count, or the honest `null` answer —
 * "not judged", which is NOT "clean" (`AGENTS.md`).
 *
 * @param {{checked: boolean, findings: object[]}|null} drift
 * @returns {string}
 */
function driftText(drift) {
  if (drift === null) return "not judged (no manifest to read)";
  return drift.findings.length === 0
    ? "checked, no drift"
    : `${drift.findings.length} finding${drift.findings.length === 1 ? "" : "s"}`;
}

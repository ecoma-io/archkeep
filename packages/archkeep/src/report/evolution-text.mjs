/**
 * The terminal report for the `evolution` command: the selected revisions in
 * history order, each transition classified, and what the whole record can
 * and cannot say.
 *
 * Like `history-text.mjs`, counts end every section so a reader never decides
 * whether an omission is content or silence — and the summary line names the
 * range the record is a claim ABOUT, because "how the architecture evolved"
 * without naming the compared revisions is not a reproducible claim.
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`../README.md`); the transition formatters are
 * shared with `history-text.mjs` (`./snapshot-text.mjs`) so both commands
 * render one classification the same way.
 */

import { formatChanges, sanitize, transitionKind } from "./snapshot-text.mjs";

/**
 * The whole evolution report.
 *
 * @param {{result: {base: string, head: string,
 *   revisions: {commit: string, id: string}[],
 *   transitions: {from: string, to: string, architectureChanged: boolean,
 *     changes: object|null, policyChanged: boolean|null, policyOneSided: boolean,
 *     provenanceChanged: boolean|null, providerChanged: boolean,
 *     codeDrift: boolean, notes: string[], comparison?: object}[],
 *   summary?: object}, coverage: object}} input
 * @returns {string}
 */
export function formatEvolutionReport({ result, coverage }) {
  const sections = [];

  const transitionWord = result.transitions.length === 1 ? "transition" : "transitions";
  const revisionWord = result.revisions.length === 1 ? "revision" : "revisions";
  const inspected = `${coverage.imports} import${
    coverage.imports === 1 ? "" : "s"
  } in ${coverage.analyzedFiles} file${
    coverage.analyzedFiles === 1 ? "" : "s"
  } across ${coverage.projects} project${coverage.projects === 1 ? "" : "s"}`;

  sections.push(
    `evolution  ${sanitize(result.base.slice(0, 12))}..${sanitize(result.head.slice(0, 12))}`,
  );
  sections.push(
    `${result.revisions.length} ${revisionWord}, ${result.transitions.length} ${transitionWord} (${inspected})`,
  );

  for (const [i, revision] of result.revisions.entries()) {
    sections.push(`${i}  ${sanitize(revision.commit)}  ${revision.id.slice(0, 8)}`);
  }

  // The footer counts true architectural change only — the same discipline as
  // `history-text.mjs`: a policy or provider transition is a change to how the
  // record reads, not to the architecture itself.
  let changed = 0;
  for (const transition of result.transitions) {
    if (transition.architectureChanged) changed += 1;
    const kind = transitionKind(transition);
    sections.push(`~ ${sanitize(transition.from)} → ${sanitize(transition.to)}  (${kind})`);
    if (transition.changes) {
      for (const line of formatChanges(transition.changes)) sections.push(`  ${line}`);
    }
    for (const note of transition.notes) {
      sections.push(`  ${note}`);
    }
    // The per-transition comparison report — the eight questions answered on
    // this one revision pair (design §6), from the envelope fields the command
    // already computed. An incomparable axis is printed with its reason, never
    // folded into silence.
    if (transition.comparison) {
      sections.push(``);
      sections.push(
        `  comparison for ${sanitize(transition.from.slice(0, 12))} → ${sanitize(transition.to.slice(0, 12))}`,
      );
      sections.push(...formatComparisonSection(transition.comparison));
    }
  }

  if (changed === 0) {
    const anySignal = result.transitions.some(
      (t) => t.policyChanged === true || t.providerChanged || t.codeDrift,
    );
    sections.push(
      anySignal
        ? "✔ no architectural change across the selected revisions (only policy, provider, or drift signals)"
        : "✔ no change at all across the selected revisions",
    );
  } else {
    sections.push(
      `${changed} transition${changed === 1 ? "" : "s"} recorded an architectural change`,
    );
  }

  // The range-wide summary — the same eight questions answered over the whole
  // record, so a reader sees both the per-pair detail and the verdict carried
  // by all of them together (design §8). An axis that any pair could not
  // compare is reported as n/a with the reason, never as a fabricated clean
  // aggregate.
  if (result.summary) {
    sections.push(``);
    sections.push(`summary`);
    sections.push(...formatSummarySection(result.summary));
  }

  return sections.join("\n");
}

/**
 * Renders an incomparable axis marker as `n/a — <reason>` (design §6). An
 * axis that could not be answered is never folded into a clean "none".
 *
 * @param {{available: false, reason?: string}|undefined} axis
 * @returns {string}
 */
function naWithReason(axis) {
  return `n/a — ${axis?.reason ?? "not comparable"}`;
}

/**
 * Renders one verdict value: a verdict string as-is, an incomparable marker
 * as `n/a — <reason>`, and an absent value as `n/a` with a fallback reason.
 *
 * @param {string|{available: false, reason?: string}|undefined} value
 * @param {string} [fallbackReason]
 * @returns {string}
 */
function renderVerdict(value, fallbackReason) {
  if (value === undefined || value === null) return `n/a — ${fallbackReason ?? "unknown"}`;
  if (typeof value === "object" && value.available === false) {
    return `n/a — ${value.reason ?? "not comparable"}`;
  }
  return String(value);
}

/**
 * Names an edge for the report: `source→target:type` for the object shape the
 * diff produces, plain text otherwise.
 *
 * @param {object|string} edge
 * @returns {string}
 */
function edgeName(edge) {
  return edge && typeof edge === "object"
    ? `${edge.source}→${edge.target}${edge.type ? `:${edge.type}` : ""}`
    : String(edge);
}

/**
 * The report section for one transition's comparison (design §6) — the eight
 * questions answered for that single revision pair. Reads the envelope fields
 * the command computed; incomparable axes print `n/a — <reason>`, never a
 * fabricated clean answer.
 *
 * @param {object} comparison One `result.transitions[i].comparison`.
 * @returns {string[]} Report lines.
 */
function formatComparisonSection(comparison) {
  const out = [];
  const observed = comparison.observed ?? {};
  const projects = observed.projects ?? {};
  const edges = observed.edges ?? {};
  const projectName = (p) => (typeof p === "string" ? p : (p?.name ?? JSON.stringify(p)));
  const listLine = (label, items) =>
    items.length === 0 ? [] : [`  ${label}: ${items.join(", ")}`];

  out.push(`  disposition: ${comparison.disposition ?? "unknown"}`);
  const cls = comparison.classifications ?? [];
  out.push(`  classifications: ${cls.length === 0 ? "none" : cls.join(", ")}`);
  out.push(`  architecture changed: ${observed.architectureChanged ? "yes" : "no"}`);
  out.push(...listLine("projects added", (projects.added ?? []).map(projectName)));
  out.push(...listLine("projects removed", (projects.removed ?? []).map(projectName)));
  out.push(...listLine("projects changed", (projects.changed ?? []).map(projectName)));
  out.push(...listLine("edges added", (edges.added ?? []).map(edgeName)));
  out.push(...listLine("edges removed", (edges.removed ?? []).map(edgeName)));
  if (observed.policyChanged === true || observed.policyChanged === false) {
    out.push(`  policy changed: ${observed.policyChanged ? "yes" : "no"}`);
  }
  if (observed.policyOneSided === true) out.push(`  policy changed: one-sided`);
  if (observed.providerChanged === true || observed.providerChanged === false) {
    out.push(`  provider changed: ${observed.providerChanged ? "yes" : "no"}`);
  }
  if (observed.provenanceChanged === true) out.push(`  provenance changed: yes`);

  const findings = comparison.findings;
  if (findings?.available === false) out.push(`  drift findings: ${naWithReason(findings)}`);
  else if (findings) {
    out.push(
      `  drift findings: introduced ${findings.introduced.length}, resolved ${findings.resolved.length}` +
        (findings.unknown?.length ? `, unknown ${findings.unknown.length}` : ""),
    );
  }

  const debt = comparison.debt;
  if (debt?.available === false) out.push(`  debt: ${naWithReason(debt)}`);
  else if (debt)
    out.push(`  debt: introduced ${debt.introduced.length}, resolved ${debt.resolved.length}`);

  const fitness = comparison.fitness;
  if (fitness?.available === false) out.push(`  fitness: ${naWithReason(fitness)}`);
  else if (fitness?.verdictDeltas) {
    out.push(`  fitness:`);
    for (const delta of fitness.verdictDeltas) {
      out.push(`    ${delta.id}: ${renderVerdict(delta.base)} → ${renderVerdict(delta.head)}`);
    }
  }

  const cov = comparison.coverage;
  if (cov) {
    out.push(
      `  coverage: base ${cov.base?.projects ?? 0} project${cov.base?.projects === 1 ? "" : "s"} / ` +
        `${cov.base?.analyzedFiles ?? 0} files / ${cov.base?.imports ?? 0} imports; ` +
        `head ${cov.head?.projects ?? 0} / ${cov.head?.analyzedFiles ?? 0} / ${cov.head?.imports ?? 0}`,
    );
  }

  const affected = comparison.affected;
  if (affected) {
    if (affected.projects?.length) out.push(`  affected projects: ${affected.projects.join(", ")}`);
    if (affected.boundaries?.length)
      out.push(`  affected boundaries: ${affected.boundaries.join(", ")}`);
    if (affected.constraints?.length)
      out.push(`  affected constraints: ${affected.constraints.join(", ")}`);
    if (affected.decisions?.length)
      out.push(`  affected decisions: ${affected.decisions.join(", ")}`);
    if (
      !["projects", "boundaries", "constraints", "decisions", "lineage"].some(
        (key) => affected[key]?.length,
      )
    ) {
      out.push(`  affected: none`);
    }
  }

  for (const note of comparison.notes ?? []) out.push(`  note: ${note}`);
  return out;
}

/**
 * The report section for the whole-range summary (design §8) — the same eight
 * questions answered over every transition together. Any axis with an
 * incomparable transition prints `n/a — <reason>` naming that transition.
 *
 * @param {object} summary `result.summary`.
 * @returns {string[]} Report lines.
 */
function formatSummarySection(summary) {
  const out = [];
  out.push(`  transitions: ${summary.transitions}`);
  out.push(`  disposition: ${summary.disposition ?? "unknown"}`);
  const cls = summary.classifications ?? [];
  out.push(`  classifications: ${cls.length === 0 ? "none" : cls.join(", ")}`);

  const observed = summary.observed ?? {};
  const projects = observed.projects ?? {};
  const edges = observed.edges ?? {};
  const listLine = (label, items) =>
    items.length === 0 ? [] : [`  ${label}: ${items.join(", ")}`];
  out.push(
    `  architecture changed in ${observed.architectureChanged ?? 0} transition${
      observed.architectureChanged === 1 ? "" : "s"
    }`,
  );
  out.push(...listLine("projects added", projects.added ?? []));
  out.push(...listLine("projects removed", projects.removed ?? []));
  out.push(...listLine("projects changed", projects.changed ?? []));
  out.push(...listLine("edges added", (edges.added ?? []).map(edgeName)));
  out.push(...listLine("edges removed", (edges.removed ?? []).map(edgeName)));
  const policyChanged = observed.policyChanged;
  if (policyChanged !== undefined && policyChanged !== null) {
    out.push(
      typeof policyChanged === "object" && policyChanged.available === false
        ? `  policy: ${naWithReason(policyChanged)}`
        : `  policy changed: ${policyChanged}`,
    );
  }
  const findings = summary.findings;
  if (findings?.available === false) out.push(`  drift findings: ${naWithReason(findings)}`);
  else if (findings) {
    out.push(
      `  drift findings: introduced ${findings.introduced.length}, resolved ${findings.resolved.length}`,
    );
  }

  const debt = summary.debt;
  if (debt?.available === false) out.push(`  debt: ${naWithReason(debt)}`);
  else if (debt)
    out.push(`  debt: introduced ${debt.introduced.length}, resolved ${debt.resolved.length}`);

  const fitness = summary.fitness;
  if (fitness?.available === false) out.push(`  fitness: ${naWithReason(fitness)}`);
  else if (fitness?.verdictDeltas) {
    out.push(`  fitness:`);
    for (const delta of fitness.verdictDeltas) {
      out.push(`    ${delta.id}: ${renderVerdict(delta.base)} → ${renderVerdict(delta.head)}`);
    }
  }

  const affected = summary.affected;
  if (affected) {
    if (affected.projects?.length) out.push(`  affected projects: ${affected.projects.join(", ")}`);
    if (affected.boundaries?.length)
      out.push(`  affected boundaries: ${affected.boundaries.join(", ")}`);
    if (affected.constraints?.length)
      out.push(`  affected constraints: ${affected.constraints.join(", ")}`);
    if (affected.decisions?.length)
      out.push(`  affected decisions: ${affected.decisions.join(", ")}`);
  }

  for (const note of summary.notes ?? []) out.push(`  note: ${note}`);
  return out;
}

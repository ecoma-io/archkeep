/**
 * The terminal report for the `report` command: the architecture governance
 * document — the health metrics, the waiver surface, the fitness gates, the
 * recorded decisions each governed row cites, the run's provenance, and last
 * the evidence the run could not inspect.
 *
 * Three rules this renderer holds, all of them the empty-result invariant
 * (`../../../../AGENTS.md`) wearing a formatter's clothes:
 *
 * - **A surface that could not be established never renders as a clean
 *   zero.** Its verdict word is `unknown` and the reason it carries is
 *   printed beside it, and the same fact appears again in the closing
 *   `could not inspect` block. A reader skimming either one sees the gap.
 * - **`not_applicable` is loud too, and says why.** "The workspace declared
 *   none" and "the run could not look" are different sentences and must never
 *   read alike.
 * - **A citation that resolves to nothing is `unknown`, never a pass.** A
 *   governed row linking to an ADR the registry knows prints that record and
 *   its status; a row citing something unresolvable prints `unknown` with the
 *   ref that failed.
 *
 * The metric block is rendered through `./health-text.mjs`'s own
 * `formatMetricLine`/`HEALTH_METRIC_ORDER` rather than a second copy of them,
 * so `health` and `report` can never disagree about how a verdict looks or in
 * what order the metrics come.
 *
 * Determinism: every list here arrives already ordered by the command
 * (`../commands/report.mjs` states which order and why), and this module adds
 * no sort, no clock and no locale-sensitive comparison. It decides nothing —
 * a formatter that filtered would be a rule wearing a formatter's name
 * (`./README.md`).
 *
 * Plain text, not Markdown, deliberately: every identity in this document —
 * a project name, a waiver's glob, an ADR id, a fitness function's name —
 * comes from the workspace, and a Markdown rendering would have to escape
 * each one or silently render it wrong (a `_` in a project name, a `*` in a
 * suppression path). A document that quietly mis-renders the name of the
 * thing it is reporting on is the same class of defect as one that reports
 * nothing.
 */
import { HEALTH_METRIC_ORDER, formatCoverageHeadline, formatMetricLine } from "./health-text.mjs";

/** A section heading, with a blank line before it. */
function heading(title) {
  return `\n${title}`;
}

/**
 * The verdict word for a whole surface, aligned to the same column the metric
 * lines use, with the reason a non-measuring verdict must carry.
 *
 * @param {string} label
 * @param {{verdict: string, note?: string|null}} surface
 * @returns {string}
 */
function surfaceLine(label, surface) {
  const note = surface.note ? `  (${surface.note})` : "";
  return `  ${surface.verdict.padEnd(16)}${label}${note}`;
}

/**
 * The provenance block: where this run's facts came from. An unestablished
 * origin prints as a stated absence, never as a blank line a reader could
 * mistake for a clean commit.
 *
 * @param {object} provenance
 * @param {{root: string, provider: string, marker: string}} context
 * @returns {string[]}
 */
function provenanceLines(provenance, context) {
  const lines = [
    `  root        ${context.root}`,
    `  provider    ${context.provider} (${context.marker})`,
    `  policy      ${provenance.policySource ?? "none declared — no boundary law governs this run"}`,
  ];
  if (provenance.established) {
    lines.push(`  commit      ${provenance.repo.commit}${provenance.repo.dirty ? " (dirty)" : ""}`);
    lines.push(`  remote      ${provenance.repo.remote ?? "none configured"}`);
  } else {
    lines.push("  commit      repo provenance unavailable — this report carries no origin claim");
  }
  const { total, unattested } = provenance.rows;
  lines.push(
    `  rows        ${total} governed row${total === 1 ? "" : "s"}, ` +
      `${unattested.length} with no origin recorded`,
  );
  for (const row of unattested) {
    lines.push(`    unattested  ${row.label} — no origin recorded, cannot attest`);
  }
  return lines;
}

/**
 * The waiver block: the counts, then one line per suppression on the table.
 *
 * @param {object} waivers
 * @returns {string[]}
 */
function waiverLines(waivers) {
  // "waivers", not "waiver surface": the metric block above already carries a
  // line by that name, and the two are different facts — the metric counts
  // the violations a suppression currently covers, this section describes the
  // table those suppressions live in. Two labels reading alike is how a
  // reader comes to believe one number answers the other's question.
  const lines = [surfaceLine("waivers", waivers)];
  if (waivers.counts === null) return lines;
  const c = waivers.counts;
  lines.push(
    `    ${c.waivers} waiver${c.waivers === 1 ? "" : "s"} ` +
      `(${c.expired} expired, ${c.stale} covering nothing), ` +
      `${c.suppressions} permanent suppression${c.suppressions === 1 ? "" : "s"} ` +
      `hiding ${c.suppressed} violation${c.suppressed === 1 ? "" : "s"}`,
  );
  for (const row of waivers.rows) {
    const expiry = row.expiresAt === null ? "" : ` until ${row.expiresAt}`;
    lines.push(
      `    ${row.status.padEnd(10)}${row.path}${expiry} — covers ${row.covered} ` +
        `violation${row.covered === 1 ? "" : "s"}`,
    );
    if (row.reason !== null) lines.push(`      reason: ${row.reason}`);
  }
  return lines;
}

/**
 * The fitness block: one line per declared gate, with the ADR(s) binding it.
 *
 * `adrs: null` means the registry could not be read, which is a different
 * statement from `[]` ("no recorded decision binds this gate") and is printed
 * as such.
 *
 * @param {object} fitness
 * @returns {string[]}
 */
function fitnessLines(fitness) {
  const lines = [surfaceLine("fitness gates", fitness)];
  for (const fn of fitness.functions) {
    const bound =
      fn.adrs === null
        ? "  bound by: unknown — the decision registry could not be read"
        : fn.adrs.length > 0
          ? `  bound by: ${fn.adrs.join(", ")}`
          : "  bound by: no recorded decision";
    lines.push(`    ${fn.verdict.padEnd(16)}${fn.name}${bound}`);
    if (fn.verdict !== "pass" && fn.message !== null) lines.push(`      ${fn.message}`);
  }
  return lines;
}

/**
 * The decisions block: the registry, and every governed row that cites one.
 *
 * @param {object} decisions
 * @returns {string[]}
 */
function decisionLines(decisions) {
  const lines = [surfaceLine("decisions", decisions)];
  // "does not resolve" is a claim about the REF — that nothing in the
  // workspace answers to it. When the registry itself could not be read, that
  // claim is not one this run established: it could not look. The two get
  // different sentences, for the same reason `unknown` and `not_applicable`
  // do (`count: null` is how the command says the registry was unreadable).
  const registryUnread = decisions.registry.count === null;
  if (!registryUnread) {
    lines.push(
      `    ${decisions.registry.count} record${decisions.registry.count === 1 ? "" : "s"} in ` +
        `${decisions.registry.dir}/`,
    );
    for (const record of decisions.records) {
      const binds =
        record.bindings.length > 0
          ? `binds ${record.bindings.join(", ")}`
          : "binds nothing — not yet enforceable";
      // The record row is byte-identical to the pre-wave-2 line; the fitness
      // and "stands on" lines below it are additive surface (contract items
      // 3 + F/B), never a rewrite of what a longer-maintained reader expects.
      lines.push(`      ${record.id}  (${record.status})  ${binds}`);
      if (record.fitness !== undefined) {
        const fit = record.fitness;
        const reasonString =
          typeof fit.reason === "string"
            ? ` — ${fit.reason}`
            : fit.verified
              ? " — verified true: bound constraints resolve and pass"
              : "";
        lines.push(`          fitness: ${fit.level}${reasonString}`);
      }
      if (record.authority) {
        if (record.constraints.length > 0) {
          const refs = record.constraints.map((c) => `${c.kind} ${c.label}`).join(", ");
          lines.push(`          stands on: ${refs}`);
        } else {
          lines.push("          stands on: no governed row cites this decision");
        }
      }
    }
  }
  // The citations render even when the registry could not be read: that is
  // exactly the case where "does not resolve" must NOT be claimed and the
  // registry-unreadable sentence must. Skipping them here would print the
  // "unknown" verdict with no citation lines to back it — the silent direction.
  if (decisions.citations.length === 0) {
    lines.push("    no governed row cites a decisionRef");
  } else {
    for (const citation of decisions.citations) {
      const target =
        citation.resolution === "adr" && citation.adr !== null
          ? `${citation.adr.id} (${citation.adr.status})`
          : citation.resolution === "fitness"
            ? `${citation.decisionRef} — a fitness rule this law declares`
            : registryUnread
              ? `${citation.decisionRef} — unresolved: the decision registry could not be read`
              : `${citation.decisionRef} — does not resolve`;
      lines.push(`    ${citation.resolution.padEnd(10)}${citation.label} → ${target}`);
    }
  }
  if (
    !registryUnread &&
    Array.isArray(decisions.unresolvedDecisionRefs) &&
    decisions.unresolvedDecisionRefs.length > 0
  ) {
    lines.push("    unresolved decisionRefs:");
    for (const ref of decisions.unresolvedDecisionRefs) {
      lines.push(`      ${ref.kind} ${ref.label} → ${ref.reason}`);
    }
  }
  return lines;
}

/**
 * The whole governance report.
 *
 * @param {{coverage: object, metrics: object, trends: object|null,
 *   waivers: object, fitness: object, decisions: object, provenance: object,
 *   uninspectable: {surface: string, reason: string}[],
 *   context: {root: string, provider: string, marker: string}}} input
 * @returns {string}
 */
export function formatGovernanceReport({
  coverage,
  metrics,
  trends,
  waivers,
  fitness,
  decisions,
  provenance,
  uninspectable,
  context,
}) {
  const sections = [];

  // The document's own verdict, first: whether it could be established at
  // all. A reader who stops after one line must not read "no verdict" as
  // "healthy".
  sections.push(
    uninspectable.length === 0
      ? "architecture governance report — every surface reached a verdict"
      : `architecture governance report — NO VERDICT: ${uninspectable.length} ` +
          `surface${uninspectable.length === 1 ? "" : "s"} could not be inspected`,
  );

  sections.push(heading("provenance"));
  sections.push(...provenanceLines(provenance, context));

  sections.push(heading("health"));
  sections.push(formatCoverageHeadline(coverage, "report"));
  for (const { key, label } of HEALTH_METRIC_ORDER) {
    sections.push(formatMetricLine(label, metrics[key]));
  }

  sections.push(heading("governance surfaces"));
  sections.push(...waiverLines(waivers));
  sections.push(...fitnessLines(fitness));
  sections.push(...decisionLines(decisions));

  if (trends) {
    sections.push(heading("trends"));
    sections.push(
      `  ${trends.snapshots.length} snapshot${trends.snapshots.length === 1 ? "" : "s"}`,
    );
    for (const snapshot of trends.snapshots) {
      sections.push(
        `    ${snapshot.name}  ${snapshot.projects} projects, ${snapshot.dependencies} edges`,
      );
    }
    for (const note of trends.notes) sections.push(`    ${note}`);
  }

  // Last, and unconditional: an empty block is the claim "every surface was
  // inspectable", which is exactly what it must mean.
  sections.push(heading("could not inspect"));
  if (uninspectable.length === 0) {
    sections.push("  nothing — every surface in this report reached a verdict");
  } else {
    for (const gap of uninspectable) sections.push(`  ${gap.surface}: ${gap.reason}`);
  }

  return sections.join("\n");
}

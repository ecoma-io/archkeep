/**
 * The `decisions` command's text renderer — the deterministic chain
 * decision → governed rows → projects → findings → fitness, one function a
 * test drives for both the resolved and the unresolved walk.
 *
 * The renderer owns the invariant: a chain that could not walk every hop
 * (`walk.ok === false`) renders a loud unresolved block, never a clean-looking
 * chain. The walk (`../governance/decision-graph.mjs`) reports each
 * unresolved reference with a reason; this face prints them all, so a reader
 * sees which hop broke and why — the same refrain as every other surface in
 * this wave ("an empty result is a claim, not a shrug").
 *
 * It is a pure function of the walk result + the record + the fitness level;
 * it reads no files. The fitness line reuses the `fitness:` byte convention
 * `./adr-text.mjs` establishes, so the two decision surfaces cannot disagree
 * about what a level means.
 */

/** A status label for a record, in the same terms `./adr-text.mjs` uses. */
function statusLabel(status) {
  if (status === "accepted") return "accepted";
  if (status === "active") return "active";
  if (status === "superseded") return "superseded";
  if (status === "retired") return "retired";
  return "proposed";
}

/**
 * The `fitness:` line — byte-identical to `./adr-text.mjs`'s own, so a fitness
 * level means the same thing on the `adr` face and here.
 *
 * @param {{level: string, verified: boolean, reason?: string}|undefined} fitness
 * @returns {string}
 */
function fitnessLine(fitness) {
  if (fitness === undefined) return `fitness:      ${"(not measured)"}`;
  if (fitness.verified)
    return `fitness:      ${fitness.level} — verified true: bound constraints resolve and pass`;
  if (typeof fitness.reason === "string") {
    return `fitness:      ${fitness.level} — ${fitness.reason}`;
  }
  return `fitness:      ${fitness.level}`;
}

/** One prose field rendered for a record, first line carrying the label. */
function proseLines(label, text) {
  const first = text.split("\n")[0];
  const rest = text.split("\n").slice(1);
  const out = [`${label}${first}`];
  for (const line of rest) out.push(`${" ".repeat(label.length)}${line}`);
  return out;
}

/** The prose fields of one record, in the order the wave-2 contract names them. */
const PROSE_FIELDS = [
  ["context:     ", "context"],
  ["decision:    ", "decision"],
  ["rationale:   ", "rationale"],
  ["alternatives:", "alternatives"],
  ["consequences:", "consequences"],
  ["assumptions: ", "assumptions"],
];

/** The kind label a governed row node renders as. */
const ROW_KIND_LABEL = {
  intent: "intent row",
  constraint: "constraint",
  fitness: "fitness rule",
};

/**
 * Renders the deterministic decision chain for one record.
 *
 * @param {object} args
 * @param {string} args.decisionId The id the caller asked about.
 * @param {object} args.record The ADR record the chain is about.
 * @param {object} args.walk The `forwardDecision` walk
 *   (`../governance/decision-graph.mjs`): `{ok, nodes, edges, unresolved}`.
 * @param {{level: string, verified: boolean, reason?: string}|undefined}
 *   args.fitness The per-decision fitness level, computed by the caller.
 * @returns {string}
 */
export function formatDecisionChain({ decisionId, record, walk, fitness }) {
  const lines = [];

  // An id the registry does not know is a named unknown, never a clean chain:
  // the record is null, so there is no header to derive — the walk's
  // unresolved block below is the whole answer. The renderer must not throw
  // over a null record; that is precisely the case it exists to report.
  const header =
    record === null || record === undefined
      ? `${decisionId}  (unknown)`
      : `${record.id}  (${statusLabel(record.status)})`;
  lines.push(header, "-".repeat(header.length));

  if (record !== null && record !== undefined) {
    for (const [label, key] of PROSE_FIELDS) {
      const text = record[key];
      if (typeof text === "string" && text.trim() !== "") {
        lines.push(...proseLines(label, text));
      }
    }

    if ((record.supersedes ?? []).length > 0) {
      lines.push(`supersedes: ${record.supersedes.join(", ")}`);
    }

    lines.push(fitnessLine(fitness));
  }

  // The governed rows the decision attaches (decisionRef citations and
  // bindings): the "who stands on this decision" half of the chain.
  const rowNodes = walk.nodes.filter(
    (node) => node.kind === "constraint" || node.kind === "intent" || node.kind === "fitness",
  );
  if (rowNodes.length > 0) {
    lines.push("governs:");
    for (const node of rowNodes) {
      const governed = walk.edges
        .filter((edge) => edge.kind === "governs" && edge.from === node.id)
        .map((edge) => edge.to);
      const kind = ROW_KIND_LABEL[node.kind] ?? node.kind;
      const target = governed.length > 0 ? ` → ${governed.join(", ")}` : "";
      lines.push(`  ${node.id}  (${kind})${target}`);
    }
  } else {
    lines.push("governs: (none — recorded but not enforceable)");
  }

  // The evidence leg: every project the rows govern, and each project's
  // current findings. A project with no findings is a fact, stated as such.
  const projectNodes = walk.nodes.filter((node) => node.kind === "project");
  if (projectNodes.length > 0) {
    lines.push("evidence:");
    for (const project of projectNodes) {
      const findings = walk.nodes
        .filter((node) => node.kind === "finding")
        .filter((finding) =>
          walk.edges.some(
            (edge) => edge.kind === "finding" && edge.from === project.id && edge.to === finding.id,
          ),
        );
      if (findings.length === 0) {
        lines.push(`  ${project.id}: no current findings`);
      } else {
        for (const finding of findings) {
          const ruleId = finding.data?.ruleId ?? "";
          lines.push(`  ${project.id}: ${finding.label}${ruleId ? ` (${ruleId})` : ""}`);
        }
      }
    }
  }

  // The loud unresolved block — a walk that could not resolve every hop never
  // reads as a clean chain.
  if (!walk.ok) {
    lines.push("unresolved:");
    for (const entry of walk.unresolved) {
      lines.push(`  ${entry.ref}: ${entry.reason}`);
    }
  }

  return lines.join("\n");
}

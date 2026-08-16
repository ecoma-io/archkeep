/**
 * The `adr` command's text renderers — one function per surface the command
 * prints, all pure so a test drives them without a registry on disk.
 *
 * The renderers state the registry and its binding completeness, and never
 * invent a verdict the registry did not establish: an ADR with no bindings is
 * named "not yet enforceable", a binding naming no known rule/fitness is named
 * unknown, and an empty registry stays a sentence, never a table.
 */
import { ADR_DIR, ADR_STATUSES } from "../governance/adr-registry.mjs";

/** A status label for a record, in the text a human reads. */
function statusLabel(status) {
  if (status === "accepted") return "accepted";
  if (status === "superseded") return "superseded";
  return "proposed";
}

/**
 * Renders the whole registry: one block per record, each naming its status,
 * its supersession chain, and the rules/fitnesses it binds.
 *
 * @param {{records: object[], knownFitness?: Set<string>}} result
 * @returns {string}
 */
export function formatAdrDump({ records, knownFitness }) {
  if (records.length === 0) {
    return `no ADRs in ${ADR_DIR}/ — nothing is recorded, and nothing is enforceable through it`;
  }
  const known = knownFitness ?? new Set();
  const blocks = records.map((record) => {
    const header = `${record.id}  (${statusLabel(record.status)})`;
    const lines = [header, "-".repeat(header.length)];
    if (record.supersedes.length > 0) {
      lines.push(`supersedes: ${record.supersedes.join(", ")}`);
    }
    if (record.bindings.length > 0) {
      const bound = record.bindings.map((binding) =>
        known.has(binding) ? binding : `${binding} (unknown)`,
      );
      lines.push(`bindings:   ${bound.join(", ")}`);
    } else {
      lines.push(`bindings:   (none — not yet enforceable)`);
    }
    lines.push(`status set: ${ADR_STATUSES.join(", ")}`);
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

/**
 * Renders a reverse lookup: which ADRs bind a given rule/fitness id. An empty
 * answer is a sentence naming the unknown, never silence.
 *
 * @param {{fitnessId: string, adrIds: string[]}} result
 * @returns {string}
 */
export function formatAdrReverse({ fitnessId, adrIds }) {
  if (adrIds.length === 0) {
    return `no ADR in ${ADR_DIR}/ binds ${fitnessId} — it is not enforced by any recorded decision`;
  }
  return `${fitnessId} is bound by: ${adrIds.join(", ")}`;
}

/**
 * Renders a requested ADR id that matches the `NNN-slug` pattern but names no
 * file — the one case the command reads as unresolved, never as an empty
 * reverse lookup.
 *
 * @param {{adrId: string}} result
 * @returns {string}
 */
export function formatAdrMissing({ adrId }) {
  return (
    `no ADR ${adrId} in ${ADR_DIR}/ — nothing is recorded under that id, and a ` +
    `decisionRef naming it cannot resolve`
  );
}

/**
 * Renders one record's details.
 *
 * @param {{id: string, status: string, supersedes: string[], bindings: string[]}} record
 * @returns {string}
 */
export function formatAdrRecord(record) {
  const header = `${record.id}  (${statusLabel(record.status)})`;
  const lines = [header, "-".repeat(header.length)];
  if (record.supersedes.length > 0) {
    lines.push(`supersedes: ${record.supersedes.join(", ")}`);
  }
  if (record.bindings.length > 0) {
    lines.push(`bindings:   ${record.bindings.join(", ")}`);
  } else {
    lines.push(`bindings:   (none — not yet enforceable)`);
  }
  return lines.join("\n");
}

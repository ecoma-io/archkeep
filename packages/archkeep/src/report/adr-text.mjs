/**
 * The `adr` command's text renderers — one function per surface the command
 * prints, all pure so a test drives them without a registry on disk.
 *
 * The renderers state the registry and its binding completeness, and never
 * invent a verdict the registry did not establish: an ADR with no bindings is
 * named "not yet enforceable", a binding naming no known rule/fitness is named
 * unknown, and an empty registry stays a sentence, never a table. The dump and
 * the single-record report render one record's bindings through one function
 * (`bindingsLine`), so the two faces cannot disagree about which of them is
 * marked.
 */
import { ADR_DIR, ADR_STATUSES } from "../governance/adr-registry.mjs";

/** A status label for a record, in the text a human reads. */
function statusLabel(status) {
  if (status === "accepted") return "accepted";
  if (status === "active") return "active";
  if (status === "superseded") return "superseded";
  if (status === "retired") return "retired";
  return "proposed";
}

/**
 * The `fitness:` line for one record — the per-decision verification level
 * the command derives (`../governance/decision-fitness.mjs` owns the
 * vocabulary). The line is always printed with its reason when the level has
 * one; an `enforced` level carries none and says so. This command alone can
 * never verify anything (its header's "What it cannot assert" owns why), so
 * the level comes in precomputed from the caller — absent it, the line is an
 * explicit "(not measured)" that cannot be mistaken for a verdict.
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

/**
 * The `created:` / `updated:` metadata lines for one record, when the record
 * carries them. Absent frontmatter stays absent — these are the decision's
 * own committed timeline, never a wall-clock guess.
 *
 * @param {object} record
 * @returns {string[]}
 */
function timelineLines(record) {
  const lines = [];
  if (typeof record.created === "string") lines.push(`created:   ${record.created}`);
  if (typeof record.updated === "string") lines.push(`updated:   ${record.updated}`);
  return lines;
}

/**
 * The reverse lineage line — the records whose `supersedes` names this one,
 * derived at load by the registry and therefore always consistent with the
 * forward `supersedes:` line on the other record.
 *
 * @param {object} record
 * @returns {string[]}
 */
function supersededByLines(record) {
  if (!Array.isArray(record.supersededBy) || record.supersededBy.length === 0) return [];
  return [`supersededBy: ${record.supersededBy.join(", ")}`];
}

/**
 * One prose field rendered for the single-record view: the label on the
 * first line, continued lines aligned under the prose. A field that is
 * absent or blank renders nothing — the record's own body decides.
 *
 * @param {string} label The 12-wide `label:` prefix.
 * @param {string} text The field's markdown prose.
 * @returns {string[]}
 */
function proseLines(label, text) {
  const content = text.split("\n").map((line) => line.trimEnd());
  const out = [`${label}${content[0]}`];
  for (const line of content.slice(1)) {
    out.push(`${" ".repeat(label.length)}${line}`);
  }
  return out;
}

/** The prose fields of one record, in the order §3.2 of the wave 2 contract names them. */
const PROSE_FIELDS = [
  ["context:     ", "context"],
  ["decision:    ", "decision"],
  ["rationale:   ", "rationale"],
  ["alternatives:", "alternatives"],
  ["consequences:", "consequences"],
  ["assumptions: ", "assumptions"],
];

/**
 * The `bindings:` line for one record — the ONE place either face decides how
 * a binding is rendered.
 *
 * A binding names an id in the rule/fitness name space, and `../commands/adr.mjs`
 * cannot verify that anything declares it (its header's "What it cannot
 * assert" owns why). What it can do is say which ids the registry itself
 * mentions, and mark the rest — so `(unknown)` is the reader's signal that a
 * decision claims to bind something nothing here corroborates.
 *
 * This lived twice, and the second copy did not carry the marker at all:
 * `formatAdrRecord` took no known set, so `adr <NNN-slug>` printed a dangling
 * binding identically to an enforced one while `formatAdrDump` marked it on
 * the same record, and the JSON face carried the fact to a machine reader that
 * the terminal reader never saw. One function is what keeps the two faces from
 * disagreeing again.
 *
 * @param {{bindings: string[]}} record
 * @param {Set<string>} known The ids the registry's records mention.
 * @returns {string}
 */
function bindingsLine(record, known) {
  if (record.bindings.length === 0) {
    return `bindings:   (none — not yet enforceable)`;
  }
  const bound = record.bindings.map((binding) =>
    known.has(binding) ? binding : `${binding} (unknown)`,
  );
  return `bindings:   ${bound.join(", ")}`;
}

/**
 * Renders the whole registry: one block per record, each naming its status,
 * its supersession chain, and the rules/fitnesses it binds.
 *
 * @param {{records: object[], knownFitness?: Set<string>, fitnessById?:
 *   Map<string, {level: string, verified: boolean, reason?: string}>}} result
 * @returns {string}
 */
export function formatAdrDump({ records, knownFitness, fitnessById }) {
  if (records.length === 0) {
    return `no ADRs in ${ADR_DIR}/ — nothing is recorded, and nothing is enforceable through it`;
  }
  const known = knownFitness ?? new Set();
  const fitnessMap = fitnessById ?? new Map();
  const blocks = records.map((record) => {
    const header = `${record.id}  (${statusLabel(record.status)})`;
    const lines = [header, "-".repeat(header.length)];
    if (record.supersedes.length > 0) {
      lines.push(`supersedes: ${record.supersedes.join(", ")}`);
    }
    lines.push(...supersededByLines(record));
    lines.push(...timelineLines(record));
    lines.push(bindingsLine(record, known));
    lines.push(fitnessLine(fitnessMap.get(record.id)));
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
 * Renders one record's details — the `adr <NNN-slug>` face of the same record
 * the dump above renders, and it must mark an unknown binding the same way:
 * a reader who asked about one record sees strictly less than one who dumped
 * the registry otherwise, and what they stop seeing is the marker.
 *
 * Beyond the dump's lines it also renders the record's own prose (context,
 * decision, rationale, alternatives, consequences, assumptions) when the body
 * records them — this is the view a reader asking "why was this decided" gets.
 *
 * @param {{id: string, status: string, supersedes: string[], supersededBy?:
 *   string[], bindings: string[], created?: string, updated?: string, context?:
 *   string, decision?: string, rationale?: string, alternatives?: string,
 *   consequences?: string, assumptions?: string}} record
 * @param {Set<string>} [knownFitness] The ids the registry's records mention.
 *   Optional only so the parameter can be omitted where there is nothing to
 *   compare against; an absent set marks every binding rather than none,
 *   because "nothing corroborates this" is the honest answer when no set was
 *   supplied — never the quiet one.
 * @param {Map<string, {level: string, verified: boolean, reason?: string}>}
 *   [fitnessById] The fitness level per record id, computed by the caller
 *   (`../commands/adr.mjs`). Absent, a record's fitness line reads as the
 *   explicit "(not measured)" — never as a verdict this renderer invented.
 * @returns {string}
 */
export function formatAdrRecord(record, knownFitness, fitnessById) {
  const header = `${record.id}  (${statusLabel(record.status)})`;
  const lines = [header, "-".repeat(header.length)];
  if (record.supersedes.length > 0) {
    lines.push(`supersedes: ${record.supersedes.join(", ")}`);
  }
  lines.push(...supersededByLines(record));
  lines.push(...timelineLines(record));
  lines.push(bindingsLine(record, knownFitness ?? new Set()));
  lines.push(fitnessLine(fitnessById?.get(record.id)));
  for (const [label, key] of PROSE_FIELDS) {
    const text = record[key];
    if (typeof text === "string" && text.trim() !== "") {
      lines.push(...proseLines(label, text));
    }
  }
  return lines.join("\n");
}

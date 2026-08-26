/**
 * The terminal report for the `history` command: snapshots in history order,
 * each transition classified, and what the whole record can and cannot say.
 *
 * The summary line states what the record is a claim about — how many
 * snapshots, how many transitions, and the shape of the history the directory
 * actually holds. Counts end every section, so a reader is never left deciding
 * whether an omission is content or silence.
 *
 * The per-transition formatters live in `./snapshot-text.mjs`, beside the
 * ones `evolution-text.mjs` renders from — one home for the way a transition
 * becomes prose, so the two commands cannot disagree about it.
 */

import { formatChanges, transitionKind } from "./snapshot-text.mjs";

/**
 * The whole history report.
 *
 * @param {{evolution: {dir: string, captured: object|null,
 *   snapshots: {name: string, id: string}[],
 *   transitions: {from: string, to: string, architectureChanged: boolean,
 *     changes: object|null, policyChanged: boolean|null, providerChanged: boolean,
 *     codeDrift: boolean, notes: string[]}[]}, coverage: object}} input
 * @returns {string}
 */
export function formatHistoryReport({ evolution, coverage }) {
  const sections = [];

  const transitionWord = evolution.transitions.length === 1 ? "transition" : "transitions";
  const snapshotWord = evolution.snapshots.length === 1 ? "snapshot" : "snapshots";
  const inspected = `${coverage.imports} import${
    coverage.imports === 1 ? "" : "s"
  } in ${coverage.analyzedFiles} file${
    coverage.analyzedFiles === 1 ? "" : "s"
  } across ${coverage.projects} project${coverage.projects === 1 ? "" : "s"}`;

  sections.push(`history  ${evolution.dir}`);
  sections.push(
    `${evolution.snapshots.length} ${snapshotWord}, ${evolution.transitions.length} ${transitionWord} (${inspected})`,
  );

  if (evolution.captured) {
    sections.push(
      evolution.captured.duplicate
        ? `capture  ${evolution.captured.name} — already the last snapshot, no new file written`
        : `capture  ${evolution.captured.name} written`,
    );
  }

  for (const [i, snapshot] of evolution.snapshots.entries()) {
    sections.push(`${i}  ${snapshot.name}  ${snapshot.id.slice(0, 8)}`);
  }

  // The footer counts true architectural change only — a transition classified
  // as policy or provider is a change to the record's interpretation, not to
  // the architecture, so a policy-only history must not read as "N transitions
  // recorded an architectural change".
  let changed = 0;
  for (const transition of evolution.transitions) {
    if (transition.architectureChanged) changed += 1;
    const kind = transitionKind(transition);
    sections.push(`~ ${transition.from} → ${transition.to}  (${kind})`);
    if (transition.changes) {
      for (const line of formatChanges(transition.changes)) sections.push(`  ${line}`);
    }
    for (const note of transition.notes) {
      sections.push(`  ${note}`);
    }
  }

  if (evolution.transitions.length === 0) {
    // A single snapshot is a claim about a history of length one — it says so
    // rather than reporting "no changes", which would be ambiguous.
    sections.push(
      "✔ one snapshot, no transitions yet — capture again after an architectural change",
    );
  } else if (changed === 0) {
    const anySignal = evolution.transitions.some(
      (t) => t.policyChanged === true || t.providerChanged || t.codeDrift,
    );
    sections.push(
      anySignal
        ? "✔ no architectural change recorded across the snapshots (only policy, provider, or drift signals)"
        : "✔ no architectural change recorded across the snapshots",
    );
  } else {
    sections.push(
      `${changed} transition${changed === 1 ? "" : "s"} recorded an architectural change`,
    );
  }

  return sections.join("\n");
}

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
 *     changes: object|null, policyChanged: boolean|null, providerChanged: boolean,
 *     codeDrift: boolean, notes: string[]}[]}, coverage: object}} input
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

  return sections.join("\n");
}

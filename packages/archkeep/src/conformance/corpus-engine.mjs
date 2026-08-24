/**
 * The corpus's one way of asking the tool a question, and the pure functions
 * that judge the answer.
 *
 * `./engines.mjs` drives `analyzeFile` + `evaluate` directly, because the
 * differential beside it has to hand ESLint and this engine the identical
 * graph object. This corpus has no second engine to keep in step, so it asks
 * the question the way a consumer does instead: `../../cli.mjs`'s `check`,
 * over a real tree, in `--format json` — the whole shipped path, from
 * `archkeep.json` through discovery, analysis, the native graph and the rules,
 * out to the versioned envelope `../../../../docs/reference/json-output.md`
 * documents. A corpus that reassembled the pipeline itself could keep passing
 * while the composition a consumer actually runs came apart.
 *
 * Two seams make that possible with no git repository and no Nx install:
 * `check` takes `listFiles` (the tracked-file list, normally `git ls-files`)
 * and `readGraph` (Nx) as injectable arguments, and the native provider needs
 * neither of them for anything else.
 *
 * ## Why the verdict is compared as a key rather than a whole object
 *
 * A violation carries a rendered message, a constraint row and an
 * interpolation bag beside the four facts a label is about. Comparing whole
 * objects would make every case's labels a transcription of the tool's own
 * output — the shape that agrees with the engine by construction, including
 * when the engine is wrong. `findingKey` keeps exactly what a person can
 * decide in advance: which rule fired, in which file, on which import, and
 * between which two projects.
 *
 * Positions are checked, and they are checked against the FIXTURE rather than
 * against a literal in the label: `positionProblems` re-reads the line the
 * violation points at and requires the specifier to start there. A label
 * pinning `line: 5` would have to be re-typed whenever a fixture gains a
 * comment; a check that reads the file cannot go stale, and it still fails a
 * diagnostic that points at the wrong line — which is worse than no
 * diagnostic, because it sends the reader somewhere confidently wrong.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "../../cli.mjs";

/**
 * Runs `check` over one materialised case tree.
 *
 * @param {{root: string, files: string[], config?: string|null, paths?: string[]}} args
 *   `config` is a workspace-relative policy filename, or `null` for the
 *   workspace's own `boundaryConfig`; `paths` scopes which import sites are
 *   reported, which is how a per-file measurement is taken from a
 *   whole-workspace command.
 * @returns {Promise<{status: string, exitCode: number, coverage: object, violations: object[]}>}
 */
export async function runCorpusCheck({ root, files, config = null, paths = [] }) {
  const outcome = await check(
    { format: "json", config, paths },
    { cwd: root, listFiles: () => files },
  );
  const envelope = JSON.parse(outcome.report);
  return {
    status: envelope.status,
    exitCode: envelope.exitCode,
    coverage: envelope.coverage,
    violations: envelope.result.violations,
  };
}

/**
 * The project a workspace-relative file belongs to: longest declared root
 * wins, the same rule `../analysis/source-util.mjs`'s `projectOwning` applies
 * inside the tool.
 *
 * Derived here rather than labeled, so a probe never has to restate which
 * project its own file sits in — and so a finding attributed to the wrong
 * project fails against a fact the case already stated once, in its project
 * list.
 *
 * @param {{projects: {name: string, root: string}[]}} spec
 * @param {string} file Workspace-relative.
 * @returns {string|null}
 */
export function projectOwning(spec, file) {
  let owner = null;
  for (const project of spec.projects) {
    const inside = file === project.root || file.startsWith(`${project.root}/`);
    if (!inside) continue;
    if (owner === null || project.root.length > owner.root.length) owner = project;
  }
  return owner?.name ?? null;
}

/**
 * The four facts a label states about one finding, as one comparable string.
 *
 * @param {{messageId: string, sourceFile: string, specifier: string,
 *   sourceProject: string|null, targetProject: string|null}} finding
 * @returns {string}
 */
export function findingKey({ messageId, sourceFile, specifier, sourceProject, targetProject }) {
  return `${messageId} at ${sourceFile} on '${specifier}' (${sourceProject ?? "-"} -> ${targetProject ?? "-"})`;
}

/**
 * Every finding a case's probes claim, as keys.
 *
 * A probe states `{messageId, specifier, target}`; the source project comes
 * from the probe's own file and the case's project list, never from a label.
 *
 * @param {object} spec A case from `./corpus.mjs`.
 * @returns {string[]}
 */
export function expectedFindings(spec) {
  return spec.probes.flatMap((probe) =>
    probe.reports.map((report) =>
      findingKey({
        messageId: report.messageId,
        sourceFile: probe.file,
        specifier: report.specifier,
        sourceProject: projectOwning(spec, probe.file),
        targetProject: report.target ?? null,
      }),
    ),
  );
}

/**
 * The two directions a labeled corpus can be wrong in, kept apart because
 * they mean opposite things.
 *
 * `missing` is the silent direction: the corpus says this import is a
 * violation and the tool said nothing. `unexpected` is the loud one: the tool
 * reported something no label claims — which is either a new violation type
 * reaching this fixture or a false positive, and both are findings a person
 * has to look at.
 *
 * Pure, and taking both lists as arguments, for the reason
 * `../../../../AGENTS.md` states about the gate scripts: a function that ran
 * the tool AND decided about it could only be tested by stubbing the tool.
 *
 * @param {string[]} expected
 * @param {string[]} actual
 * @returns {{missing: string[], unexpected: string[]}}
 */
export function compareFindings(expected, actual) {
  const remaining = [...actual];
  const missing = [];
  for (const key of expected) {
    const at = remaining.indexOf(key);
    if (at === -1) missing.push(key);
    else remaining.splice(at, 1);
  }
  return { missing: missing.sort(), unexpected: remaining.sort() };
}

/**
 * Findings whose `line`/`column` do not land on the import they are about.
 *
 * The specifier must begin at the reported position, optionally behind the
 * quote a Go import path is written in — the one place any of the corpus's
 * languages puts a delimiter between the position an analyzer reports and the
 * text it reports about.
 *
 * @param {object[]} violations
 * @param {(file: string) => string} readText Workspace-relative reader.
 * @returns {string[]} One row per problem, naming the file and what was there.
 */
export function positionProblems(violations, readText) {
  const problems = [];
  for (const violation of violations) {
    // A Rust `use` path may wrap across lines, and the analyzer collapses the
    // whitespace when it records the specifier (`../analysis/rust.mjs`), so
    // the collapsed text cannot be searched for in one line. Every corpus
    // fixture writes its imports on one line; a specifier carrying a space is
    // therefore a fixture that stopped doing that, and is reported rather
    // than skipped.
    const lines = readText(violation.sourceFile).split("\n");
    const line = lines[violation.line - 1];
    if (line === undefined) {
      problems.push(
        `${violation.sourceFile}:${violation.line} — the file has only ${lines.length} lines`,
      );
      continue;
    }
    const at = line.slice(violation.column - 1);
    if (at.startsWith(violation.specifier) || at.startsWith(`"${violation.specifier}`)) continue;
    problems.push(
      `${violation.sourceFile}:${violation.line}:${violation.column} — expected '${violation.specifier}' ` +
        `to start there, found ${JSON.stringify(at.slice(0, 40))}`,
    );
  }
  return problems;
}

/** A workspace-relative reader over a materialised case root. */
export const readFrom = (root) => (relative) => readFileSync(join(root, relative), "utf8");

/**
 * Findings grouped by the file they were reported in, as counts.
 *
 * @param {object[]} violations
 * @returns {Map<string, number>}
 */
export function countsByFile(violations) {
  const counts = new Map();
  for (const violation of violations) {
    counts.set(violation.sourceFile, (counts.get(violation.sourceFile) ?? 0) + 1);
  }
  return counts;
}

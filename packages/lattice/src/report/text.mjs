/**
 * The terminal report: violations as lines a developer can act on without
 * opening anything else.
 *
 * The first line of every entry is `file:line:column`, unindented and with no
 * prefix, because that is the shape a terminal turns into a link and an editor
 * turns into a jump — it is also why the analysis record carries 1-based
 * positions at all (`../analysis/contract.md`). Everything after it is
 * indented, so a `grep` for `:` down the left margin lists exactly the sites.
 *
 * Four things are printed per violation and each has a reader in mind: the
 * `messageId` (the same id ESLint would report, so a search finds upstream's
 * documentation and a differential comparison has something to compare), the
 * rendered message (what is wrong), the import and the project pair (which
 * edge), and the constraint row that fired (WHY it is wrong — a message saying
 * a project "can only depend on libs tagged with X" does not say which line of
 * `module-boundaries.config.mjs` said so, and that is the line a fix has to
 * agree with).
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name, and it would disagree with the engine the first
 * time either changed (`README.md` beside this file).
 */
import { isWholeFileFailure } from "../analysis/source-util.mjs";

/** Two spaces of indent for a violation's detail lines, four for wrapped text. */
const DETAIL = "  ";
const CONTINUED = "    ";

/**
 * The constraint row that fired, rendered from the row's own keys rather than
 * from a list of the keys we expect. `@nx/enforce-module-boundaries` can grow a
 * constraint field, and a renderer enumerating today's four would silently drop
 * the new one from every report.
 *
 * @param {object|null} constraint A `depConstraints` row, or `null`.
 * @returns {string}
 */
export function formatConstraint(constraint) {
  if (!constraint) {
    // Nine of the fifteen checks are decided before the constraint table is
    // consulted — a relative path across projects, an import of an app, a
    // cycle. Saying so beats printing nothing, which reads as a missing field.
    return "not driven by a depConstraints row — this check fires before the table is read";
  }
  const source =
    "allSourceTags" in constraint
      ? `allSourceTags [${constraint.allSourceTags.join(", ")}]`
      : `sourceTag ${constraint.sourceTag}`;
  const rest = Object.entries(constraint)
    .filter(([key]) => key !== "sourceTag" && key !== "allSourceTags")
    .map(([key, value]) => `${key} [${(Array.isArray(value) ? value : [value]).join(", ")}]`);
  return [source, ...rest].join(" → ");
}

/** The project pair, with the two shapes a target can have spelled out. */
function formatEdge(violation) {
  const source = violation.sourceProject ?? "(no project)";
  const target = violation.targetProject ?? "(unresolved)";
  return `${source} → ${target}`;
}

/**
 * One violation as an entry: a clickable position line plus indented detail.
 *
 * Message templates are multi-line (a circular-dependency report carries the
 * cycle and the file chain), so every line of the message is indented to the
 * same column — an unindented continuation would read as a second violation at
 * a file called whatever the wrapped text started with.
 *
 * @param {object} violation A `Violation` from `../rules/`.
 * @returns {string}
 */
export function formatViolation(violation) {
  const message = violation.message
    .split("\n")
    .map((line) => (line === "" ? "" : `${CONTINUED}${line}`))
    .join("\n");
  return [
    `${violation.sourceFile}:${violation.line}:${violation.column}  ${violation.messageId}`,
    message,
    `${DETAIL}import      ${JSON.stringify(violation.specifier)} (${violation.kind})  ${formatEdge(violation)}`,
    `${DETAIL}constraint  ${formatConstraint(violation.constraint)}`,
  ].join("\n");
}

/** One failure as `file` or `file:line:column`, then its reason. */
const formatFailure = (failure) =>
  `${DETAIL}${isWholeFileFailure(failure) ? failure.sourceFile : `${failure.sourceFile}:${failure.line}:${failure.column}`}  ${failure.reason}`;

/**
 * What analysis could not read, resolve, or parse — printed on every run,
 * including a clean one, and never counted as a violation.
 *
 * Two sections, because the two things a failure can mean have opposite
 * consequences and one heading for both hid that for as long as it existed.
 *
 * A SITE failure is a blind spot: the file was analyzed, and one specifier in
 * it is not statically knowable — `import(url)` with a computed argument is
 * the honest example. The rest of the file still got a verdict. Failing the
 * run on these would let one unresolvable third-party specifier block a merge
 * over a boundary nobody crossed, and they are legitimately permanent.
 *
 * A WHOLE-FILE failure is a hole: nothing was read, parsed, or analyzed, so
 * this file contributed no verdict at all. The summary line above still counts
 * imports and files, so a reader who sees "no boundary violations" is being
 * told about coverage; a file in this section is coverage that is missing.
 * `cli.mjs` exits non-zero on these for that reason, and the heading says so
 * rather than leaving the exit code to be discovered.
 *
 * @param {object[]} failures `AnalysisFailure` records.
 * @returns {string}
 */
export function formatFailures(failures) {
  if (failures.length === 0) return "";
  const unchecked = failures.filter(isWholeFileFailure);
  const blind = failures.filter((failure) => !isWholeFileFailure(failure));
  const sections = [];

  if (unchecked.length > 0) {
    const files = new Set(unchecked.map((failure) => failure.sourceFile)).size;
    sections.push(
      [
        `✖ ${files} file${files === 1 ? "" : "s"} could not be analyzed at all, so ${files === 1 ? "it is" : "they are"} ` +
          `not covered by the verdict above and the run fails:`,
        ...unchecked.map(formatFailure),
      ].join("\n"),
    );
  }

  if (blind.length > 0) {
    sections.push(
      [
        `${blind.length} import${blind.length === 1 ? "" : "s"} could not be resolved. ` +
          `These are blind spots inside files that were analyzed, not verdicts — the run does not fail on them:`,
        ...blind.map(formatFailure),
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

/**
 * The go.work drift section — rendered only when the run HAS a go.work
 * verdict, decided nowhere here.
 *
 * `goWork` is `null` (or absent) when the workspace has no tracked root
 * go.work, and then this prints nothing: a workspace without the manifest pays
 * nothing and hears nothing. When the check ran, even a clean result is a
 * line, because "go.work agrees" is a claim about coverage the reader cannot
 * otherwise tell apart from "nothing looked" — the same reason the summary
 * line counts files (`../go-work.mjs` owns the findings' semantics).
 *
 * A finding with a position renders `go.work:line:column` like a violation; a
 * missing-use finding is about an entry that does not exist, so it renders the
 * file alone rather than a fabricated line 1.
 *
 * @param {{findings: object[], moduleProjects: number}|null|undefined} goWork
 * @returns {string} Empty exactly when there is no go.work verdict to render.
 */
export function formatGoWork(goWork) {
  if (goWork == null) return "";
  const { findings, moduleProjects } = goWork;
  const modules = `${moduleProjects} Go module project${moduleProjects === 1 ? "" : "s"}`;
  if (findings.length === 0) {
    return `✔ go.work agrees with the project graph (${modules})`;
  }
  const entries = findings.map((finding) => {
    const site =
      finding.line === null ? finding.file : `${finding.file}:${finding.line}:${finding.column}`;
    const message = finding.message
      .split("\n")
      .map((line) => (line === "" ? "" : `${CONTINUED}${line}`))
      .join("\n");
    return [`${site}  ${finding.messageId}`, message].join("\n");
  });
  return [
    entries.join("\n\n"),
    `✖ go.work drifts from the project graph: ${findings.length} ` +
      `finding${findings.length === 1 ? "" : "s"} (${modules}) — a developer's go build and ` +
      `CI select different module sets, and the run fails`,
  ].join("\n\n");
}

/**
 * The tsconfig paths hygiene section — rendered only when the run HAS a paths
 * verdict, decided nowhere here.
 *
 * `tsconfigPaths` is `null` (or absent) when the workspace has no tsconfig or
 * its tsconfig declares no `paths`, and then this prints nothing: a workspace
 * without the table pays nothing and hears nothing, the same bargain
 * `formatGoWork` states. When the check ran, even a clean result is a line
 * that counts the aliases judged — and separately the ones the check's rule
 * cannot judge (`../tsconfig-paths.mjs` header) — because "no dead aliases"
 * is a claim about coverage the reader cannot otherwise tell from silence.
 *
 * Findings are positionless by construction (the parsed options carry no
 * source positions, and under `extends` the alias may be declared in another
 * file), so every entry renders the file alone, never a fabricated line 1.
 *
 * @param {{tsConfig: string, findings: object[], aliases: number,
 *   unjudged: number}|null|undefined} tsconfigPaths
 * @returns {string} Empty exactly when there is no paths verdict to render.
 */
export function formatTsconfigPaths(tsconfigPaths) {
  if (tsconfigPaths == null) return "";
  const { tsConfig, findings, aliases, unjudged } = tsconfigPaths;
  const judged =
    `${aliases} alias${aliases === 1 ? "" : "es"} judged in ${tsConfig}` +
    (unjudged > 0 ? `, ${unjudged} outside this check's rule and not judged` : "");
  if (findings.length === 0) {
    return `✔ no dead tsconfig path aliases (${judged})`;
  }
  const entries = findings.map((finding) => {
    const message = finding.message
      .split("\n")
      .map((line) => (line === "" ? "" : `${CONTINUED}${line}`))
      .join("\n");
    return [`${finding.file}  ${finding.messageId}`, message].join("\n");
  });
  return [
    entries.join("\n\n"),
    `✖ dead tsconfig path aliases: ${findings.length} ` +
      `finding${findings.length === 1 ? "" : "s"} (${judged}) — no import matching ` +
      `${findings.length === 1 ? "this alias" : "these aliases"} can resolve through the ` +
      `paths table, and the run fails`,
  ].join("\n\n");
}

/**
 * The polyglot coverage gap section — rendered only when the Nx graph is known
 * to be missing polyglot edges that the checker's own analysis did cover.
 *
 * `coverageGaps` is `[]` (or absent) when there is no gap, and then this
 * prints nothing — the same bargain `formatGoWork` and `formatTsconfigPaths`
 * state: no fact, no claim. When the gap exists, it names the manifests and
 * says what is missing: `nx affected` will not trace through these edges, and
 * `@nx/enforce-module-boundaries` does not see them at all.
 *
 * This is not a finding (it does not change the exit code) and it is not a
 * refusal (the checker still judged every import it found). It is a
 * degraded-coverage note: the checker's verdict is valid, but the Nx graph
 * those edges were meant for is incomplete, and anyone relying on `nx affected`
 * or ESLint boundary enforcement for polyglot projects is under-covered.
 *
 * @param {object[]} coverageGaps Each entry has `kind` and `manifests`.
 * @returns {string} Empty exactly when there is no coverage gap to render.
 */
export function formatCoverageGaps(coverageGaps) {
  if (coverageGaps.length === 0) return "";
  const gap = coverageGaps[0];
  const count = gap.manifests.length;
  const label = `${count} polyglot manifest${count === 1 ? "" : "s"}`;
  const paths = gap.manifests.map((manifest) => `${CONTINUED}${manifest}`).join("\n");
  return (
    `⚠ nx.json does not register this plugin but ${label} ` +
    `found under project roots — nx affected and ` +
    `@nx/enforce-module-boundaries will not cover these edges\n${paths}\n` +
    `${DETAIL}register the plugin: "plugins": [{ "plugin": "@ecoma-io/lattice/nx" }]`
  );
}

/**
 * The whole report, violations first.
 *
 * The summary states what was inspected and not only what was found, because
 * "no violations" is a claim about coverage as much as about correctness: a run
 * that analyzed nothing and a clean tree print the same sentence otherwise, and
 * that indistinguishability is the defect this whole tool exists to end
 * (`../../CLAUDE.md`).
 *
 * @param {{violations: object[], failures: object[], analyzed: number, projects: number, imports: number, goWork?: object|null, tsconfigPaths?: object|null, coverageGaps?: object[], notes?: string[]}} run
 * @returns {string}
 */
export function formatReport({
  violations,
  failures,
  analyzed,
  projects,
  imports,
  goWork,
  tsconfigPaths,
  coverageGaps = [],
  notes = [],
}) {
  const inspected =
    `${imports} import${imports === 1 ? "" : "s"} in ${analyzed} file${analyzed === 1 ? "" : "s"} ` +
    `across ${projects} project${projects === 1 ? "" : "s"}` +
    // `boundaryConfig`-dialect facts a reader needs alongside the count —
    // today only the ESLint flat-config dialect ever populates this
    // (`../eslint-config.mjs`'s `extractBoundaryRule`), e.g. which entry
    // among several configuring the rule was binding.
    (notes.length > 0 ? `; ${notes.join("; ")}` : "");
  const sections = [];

  if (violations.length > 0) {
    sections.push(violations.map(formatViolation).join("\n\n"));
    const files = new Set(violations.map((violation) => violation.sourceFile)).size;
    sections.push(
      `✖ ${violations.length} boundary violation${violations.length === 1 ? "" : "s"} ` +
        `in ${files} file${files === 1 ? "" : "s"} (${inspected})`,
    );
  } else {
    sections.push(`✔ no boundary violations (${inspected})`);
  }

  const goWorkSection = formatGoWork(goWork);
  if (goWorkSection !== "") sections.push(goWorkSection);

  const tsconfigPathsSection = formatTsconfigPaths(tsconfigPaths);
  if (tsconfigPathsSection !== "") sections.push(tsconfigPathsSection);

  const coverageGapsSection = formatCoverageGaps(coverageGaps);
  if (coverageGapsSection !== "") sections.push(coverageGapsSection);

  const unresolved = formatFailures(failures);
  if (unresolved !== "") sections.push(unresolved);
  return sections.join("\n\n");
}

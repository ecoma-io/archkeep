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
  const lines = [
    `${violation.sourceFile}:${violation.line}:${violation.column}  ${violation.messageId}`,
    message,
    `${DETAIL}import      ${JSON.stringify(violation.specifier)} (${violation.kind})  ${formatEdge(violation)}`,
    `${DETAIL}constraint  ${formatConstraint(violation.constraint)}`,
  ];
  if (violation.constraint?.description) {
    lines.push(`${DETAIL}rule        ${violation.constraint.description}`);
  }
  if (violation.constraint?.remediation) {
    lines.push(`${DETAIL}remediation ${violation.constraint.remediation}`);
  }
  if (violation.evidence !== undefined) {
    // The one evidence a violation carries today: `"expired waiver"` — the row
    // that used to accept it lapsed, and the boundary is live again. Rendered
    // here so the re-assert is visible in the line a developer jumps to, not
    // only in the JSON.
    lines.push(`${DETAIL}evidence   ${violation.evidence}`);
  }
  return lines.join("\n");
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
 * The architecture-intent section — rendered only when the run HAS an intent
 * verdict, decided nowhere here.
 *
 * `intent` is `null` (or absent) when the workspace has no tracked root
 * `architecture-intent.json`, and then this prints nothing: a workspace
 * without the declaration pays nothing and hears nothing, the same bargain
 * `formatGoWork` and `formatTsconfigPaths` state. When the check ran, even a
 * clean result is a line that counts the boundaries judged, because
 * "architecture-intent agrees" is a claim about coverage the reader cannot
 * otherwise tell apart from "nothing looked" — the same reason the go.work
 * line counts modules.
 *
 * A no-verdict is a boundary (or a row side) that matched no observed project:
 * the intent for that boundary cannot be verified, which is not a clean
 * verdict. It renders as a warning line and the run fails (exit 3), the same
 * posture a whole-file failure takes — an empty boundary must never read as a
 * boundary that passed.
 *
 * @param {{verdict: "ok"|"findings"|"no-verdict", findings: object[],
 *   unresolved: object[], boundaries: object[]}|null|undefined} intent
 * @returns {string} Empty exactly when there is no intent verdict to render.
 */
export function formatIntentSection(intent) {
  if (intent == null) return "";
  const { verdict, findings, unresolved, boundaries } = intent;
  const count = boundaries.length;
  const label = `${count} boundar${count === 1 ? "y" : "ies"}`;
  if (verdict === "ok") {
    return `✔ architecture-intent agrees with the observed graph (${label})`;
  }
  if (verdict === "no-verdict") {
    const entries = unresolved.map((entry) => {
      const message = entry.issue
        .split("\n")
        .map((line) => (line === "" ? "" : `${CONTINUED}${line}`))
        .join("\n");
      return `${entry.boundary}  ${message}`;
    });
    return [
      entries.join("\n\n"),
      `⚠ architecture-intent.json reached no verdict on ${unresolved.length} ` +
        `boundar${unresolved.length === 1 ? "y" : "ies"} — the intent ` +
        `${unresolved.length === 1 ? "this boundary names" : "these boundaries name"} ` +
        `could not be verified, and the run fails`,
    ].join("\n\n");
  }
  const entries = findings.map((finding) => {
    const message = finding.message
      .split("\n")
      .map((line) => (line === "" ? "" : `${CONTINUED}${line}`))
      .join("\n");
    return `${finding.rule}  ${message}`;
  });
  return [
    entries.join("\n\n"),
    `✖ architecture-intent findings: ${findings.length} ` +
      `finding${findings.length === 1 ? "" : "s"} (${label}) — the intended ` +
      `architecture and the observed one disagree, and the run fails`,
  ].join("\n\n");
}

/**
 * The fitness section — one line per declared fitness function's verdict,
 * rendered only when the run's policy declared any (`fitness === undefined`).
 *
 * This is a verdict table, not a findings list: every declared function gets
 * its row, so "no fitness failed" always reads as a claim about the specific
 * functions that were judged. The overall verdict is a fourth line naming the
 * run's posture — `fail` wins, then `unknown`, then `pass`, exactly
 * `fitnessVerdictFor`'s ordering (`../governance/fitness-registry.mjs`) — and
 * a declared function whose `match` selected nothing shows `not_applicable`
 * with its reason: loud, never absent.
 *
 * @param {object[]} decisions Per-function verdict records from
 *   `evaluateFitness`.
 * @param {{verdict: string}} overall The aggregate from `fitnessVerdictFor`.
 * @returns {string} Empty exactly when the policy declared no fitness.
 */
export function formatFitnessSection(decisions, overall) {
  if (decisions.length === 0) return "";
  const verdictGlyph = { pass: "✔", fail: "✖", unknown: "⚠", not_applicable: "◌" };
  const rows = decisions
    .map((decision) => `${verdictGlyph[decision.verdict]} ${decision.name}  ${decision.message}`)
    .join("\n");
  const overallLabel = {
    pass: `✔ fitness: ${decisions.length} function${decisions.length === 1 ? "" : "s"} passed`,
    fail: `✖ fitness: ${overall.verdict} — the build fails`,
    unknown: `⚠ fitness: ${decisions.length} function${decisions.length === 1 ? "" : "s"} judged, some could not be determined — the run cannot claim pass`,
    not_applicable: `◌ fitness: every declared function matched nothing — nothing was judged`,
  }[overall.verdict];
  return `${rows}\n\n${overallLabel}`;
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
 * The accepted-violations section: every violation an ACTIVE waiver covered,
 * rendered with the waiver that accepts it and its expiry.
 *
 * A waived violation lives in `run.violations` (marked `waivedBy`) — it is
 * still a violation, still counted, still exit-1 — and this formatter splits
 * it out of the main list so a reader sees exactly what is being accepted and
 * for how long. The evidence of the acceptance is the reason the waiver row
 * carries.
 *
 * @param {object[]} waived Violations carrying `waivedBy`.
 * @returns {string}
 */
export function formatAcceptedViolations(waived) {
  const rows = waived.map((violation) => {
    const waiver = violation.waivedBy;
    return [
      formatViolation(violation),
      `${DETAIL}waiver    accepted until ${waiver.expiresAt}` +
        (waiver.origin ? ` (origin: ${waiver.origin})` : ""),
      `${DETAIL}reason    ${waiver.reason}`,
    ].join("\n");
  });
  const count = waived.length;
  return [
    `⚠ accepted violations: ${count} boundary violation${count === 1 ? "" : "s"} waived until their ` +
      `expiry — the boundary is still breached (the run stays non-zero), and each one below will ` +
      `re-assert the moment its waiver lapses:`,
    rows.join("\n\n"),
  ].join("\n\n");
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
* Waived violations are still `violations` (the engine marks them `waivedBy`,
 * it never removes them), so an all-waived run still renders non-zero — the
 * "waiving must not flip exit 1 → 0" invariant, in the report layer. The
 * summary line above only says "no boundary violations" when there is nothing
 * a waiver is covering either.
 *
 * @param {{violations: object[], failures: object[], analyzed: number, projects: number, imports: number, goWork?: object|null, tsconfigPaths?: object|null, intent?: object|null, fitness?: object|null, fitnessOverall?: {verdict: string}|null, coverageGaps?: object[], notes?: string[]}} run
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
  intent,
  fitness,
  fitnessOverall,
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

  const waived = violations.filter((violation) => violation.waivedBy);
  const live = violations.filter((violation) => !violation.waivedBy);

  if (live.length > 0) {
    sections.push(live.map(formatViolation).join("\n\n"));
    const files = new Set(live.map((violation) => violation.sourceFile)).size;
    sections.push(
      `✖ ${live.length} boundary violation${live.length === 1 ? "" : "s"} ` +
        `in ${files} file${files === 1 ? "" : "s"} (${inspected})`,
    );
  } else if (violations.length === 0) {
    sections.push(`✔ no boundary violations (${inspected})`);
  }

  if (waived.length > 0) {
    sections.push(formatAcceptedViolations(waived));
    // When every finding is waived the run is still NOT clean (exit 1), so the
    // summary says so rather than letting the accepted section read as a clean
    // tree. `waived` is the count word, deliberately not `!` — the finding is
    // accepted, not an error a reader must chase.
    if (live.length === 0) {
      sections.push(
        `✖ ${waived.length} boundary violation${waived.length === 1 ? "" : "s"} accepted (${inspected})`,
      );
    }
  }

  const goWorkSection = formatGoWork(goWork);
  if (goWorkSection !== "") sections.push(goWorkSection);

  const tsconfigPathsSection = formatTsconfigPaths(tsconfigPaths);
  if (tsconfigPathsSection !== "") sections.push(tsconfigPathsSection);

  const intentSection = formatIntentSection(intent);
  if (intentSection !== "") sections.push(intentSection);

  const fitnessSection = formatFitnessSection(fitness ?? [], fitnessOverall ?? { verdict: "pass" });
  if (fitnessSection !== "") sections.push(fitnessSection);

  const coverageGapsSection = formatCoverageGaps(coverageGaps);
  if (coverageGapsSection !== "") sections.push(coverageGapsSection);

  const unresolved = formatFailures(failures);
  if (unresolved !== "") sections.push(unresolved);
  return sections.join("\n\n");
}

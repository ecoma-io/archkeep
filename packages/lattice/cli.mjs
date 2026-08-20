#!/usr/bin/env node
/**
 * Command-line entry for the module-boundary enforcer — the surface that turns
 * a verdict into a failed build.
 *
 * `check` reads the project graph, analyzes every tracked source file a
 * project owns, judges the import sites against the workspace's boundary law,
 * and exits 1 if anything violates it. That closes a measured hole: a
 * layer-violating import in a Go file left `nx run <project>:lint` at exit 0,
 * because that target runs ESLint and ESLint answers "File ignored because no
 * matching configuration was supplied" for a `.go` file — the tags were a
 * declaration with no mechanism behind them.
 *
 * The three layers below it stay unaware of this one, which is what lets an
 * editor reuse them: `src/analysis/` never decides which files to visit,
 * `src/rules/` never reads a file, and `src/report/` never decides whether
 * something is a violation. This file owns the two decisions nobody else may
 * make — which tree to judge, and what the exit code means. `src/commands/context.mjs`
 * owns a third thing this file used to: which workspace, which provider,
 * which files, and what analyzing them found. `check` is the only command
 * built on it today; `src/commands/README.md` states the rule the next one
 * follows.
 *
 * When the workspace has a tracked `go.work` at its root, `check` also
 * compares its `use` list against the graph's go.mod projects
 * (`src/go-work.mjs` owns the mechanics): drift means a developer's `go build`
 * and CI select different module sets, so a drift finding fails the run the
 * way a violation does. The comparison is workspace-level and ignores path
 * scoping — two lists are being compared, not files analyzed.
 *
 * When the workspace tsconfig declares a `paths` table, `check` also judges
 * each alias for life (`src/tsconfig-paths.mjs` owns the rule and its limits):
 * an alias whose every target points into directories that do not exist
 * resolves no import, so it fails the run the way a violation does. Same
 * workspace-level shape as go.work — a table is judged, not files analyzed.
 *
 * Exit codes are part of the contract; a script calling this has to tell "your
 * tree is dirty" from "you typed it wrong" from "the checker itself broke":
 *   0  no violations, and every selected file was analyzed
 *   1  findings — boundary violations, go.work drift, dead tsconfig path
 *      aliases, or architecture-intent findings. `check` is the only command
 *      that can produce this exit code — every other verb this table might grow
 *      only ever reads.
 *   2  usage error — unknown command, unknown flag, missing argument, path
 *      outside the tree
 *   3  no verdict — no workspace, malformed config, the graph provider or git
 *      failed, a selected file could not be analyzed at all, or an
 *      architecture-intent boundary matched no observed project. Distinct from
 *      1 on purpose: a checker that could not look must never be mistaken for
 *      one that looked and found nothing.
 *
 * That last clause is why 3 covers a partial run and not only a total one. A
 * file with no analyzer, an unreadable file, a `tsconfig` that will not load —
 * each leaves a file the summary counts but no rule ever judged, and exiting 0
 * there is precisely the mistake the code exists to prevent. An import site
 * whose specifier is not statically knowable is NOT this case: that file was
 * judged, one position in it has no answer, and `src/report/text.mjs` prints
 * the two under separate headings for the same reason they get separate codes.
 *
 * `--format json` wraps the same verdict in the versioned envelope
 * `src/report/json.mjs` builds — `docs/reference/json-output.md` is the
 * published contract. It changes no exit code and no byte of the text
 * or SARIF report; it is a third rendering of a verdict every other format
 * already computes.
 *
 * `COMMANDS` below is a table rather than a `switch`, and `parseArgs` is
 * shared rather than hand-rolled per command, so a new command is a new
 * row rather than a second copy of the dispatch and flag-parsing this file
 * used to own alone. The table carries the whole command surface (`COMMANDS`
 * is the one copy of it; `docs/reference/cli.md` documents each row), with
 * three flags shared across most of them (`--format`, `--output`, `--config`)
 * and `history`'s boolean `--capture`, the first flag that takes no value. No subcommand nesting, and no shell completion to
 * generate, mean a plain table gets there without a framework; reach for one
 * only once a later command needs something this table cannot express.
 */
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { containmentViolation } from "./src/containment.mjs";
import { fileFailure, isWholeFileFailure } from "./src/analysis/source-util.mjs";
import { tsconfigPathsFacts } from "./src/analysis/typescript.mjs";
import { loadBoundaryConfig, loadBoundaryConfigFile, policyFrom } from "./src/config.mjs";
import { profilePolicy } from "./src/governance/profile-registry.mjs";
import {
  DEFAULT_OPTIONS,
  WORKSPACE_MARKERS,
  markersAt,
  resolveCommandContext,
} from "./src/commands/context.mjs";
import { contextCommand } from "./src/commands/context-command.mjs";
import { planContextCommand } from "./src/commands/plan-context-command.mjs";
import { adrCommand, readAdrContext } from "./src/commands/adr.mjs";
import { declaredFitnessNames, unresolvedDecisionRefRows } from "./src/governance/adr-registry.mjs";
import { diffCommand } from "./src/commands/diff.mjs";
import { declaredEdgeViolationsForCheck } from "./src/commands/edge-constraints.mjs";
import { discoverCommand } from "./src/commands/discover.mjs";
import { driftCommand, driftForCheck } from "./src/commands/drift.mjs";
import { fitnessCommand, fitnessForCheck } from "./src/commands/fitness.mjs";
import { reconcileCommand } from "./src/commands/reconcile.mjs";
import { computePolicyFingerprint, graphCommand } from "./src/commands/graph.mjs";
import { historyCommand } from "./src/commands/history.mjs";
import { healthCommand } from "./src/commands/health.mjs";
import { reportCommand } from "./src/commands/report.mjs";
import { debtCommand } from "./src/commands/debt.mjs";
import { explainCommand } from "./src/commands/explain.mjs";
import { impactCommand } from "./src/commands/impact.mjs";
import { resolveProvenance } from "./src/commands/provenance.mjs";
import { provenanceCommand } from "./src/commands/provenance-command.mjs";
import { waiversCommand } from "./src/commands/waivers.mjs";
import { INTENT_FILE, loadIntent } from "./src/architecture-intent/model.mjs";
import { isProgramEntry } from "./src/entry-point.mjs";
import { compareGoWork, parseGoWorkUse } from "./src/go-work.mjs";
import { readPluginOptions } from "./src/options.mjs";
import { buildDecision } from "./src/report/evidence.mjs";
import { jsonEnvelope, renderJson } from "./src/report/json.mjs";
import { formatSarif } from "./src/report/sarif.mjs";
import { formatReport } from "./src/report/text.mjs";

import { LATTICE_MODEL_FILE, loadNativeModel } from "./src/providers/native/model.mjs";
import { evaluate } from "./src/rules/index.mjs";
import { judgeTsconfigPaths } from "./src/tsconfig-paths.mjs";
import { findWorkspaceRoot, listTrackedFiles } from "./src/workspace.mjs";

/**
 * Workspace-relative read from `root`, the same default `createWorkspace`
 * builds when no reader is injected (`./src/workspace.mjs`) — duplicated
 * rather than imported for the reason `./src/commands/context.mjs` carries its
 * own copy of the same helper: `optionsForUsage` below needs one BEFORE any
 * `Workspace` exists, to hand `loadNativeModel` a reader for `lattice.json`
 * itself. `check` no longer needs a copy of its own — `resolveCommandContext`
 * owns that read now — which is why this is the only one left in this file.
 *
 * @param {string} root
 * @returns {(path: string) => string|null}
 */
function readWorkspaceRoot(root) {
  return (path) => {
    const abs = join(root, path);
    // Same containment rule as the `check` reader (`./src/containment.mjs`):
    // a tracked symlink whose realpath leaves the workspace hands `--help`
    // outside bytes as the workspace's own declaration. Refusing keeps a
    // symlinked `lattice.json` from being read as the model (`../G-10` class).
    if (containmentViolation(root, abs) !== null) return null;
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  };
}

export const EXIT = Object.freeze({
  ok: 0,
  violations: 1,
  usage: 2,
  error: 3,
});

/**
 * A total order over violations, so a report's byte sequence is an invariant
 * rather than an accident of git's index order.
 *
 * `listTrackedFiles` returns `git ls-files` output verbatim, and the analysis
 * and rule layers preserve exactly that order through `evaluate()` — which
 * makes byte-identity hold today only because git's index happens to sort
 * paths. A filesystem or git version that stopped guaranteeing that order
 * would silently reorder every report while the determinism contract
 * (`docs/reference/json-output.md`) still claimed byte-identity. Sorting here —
 * at the boundary between the engine and its reports — makes `(sourceFile,
 * line, column, messageId)` the one place a reorder could come from, and
 * plain `<` comparison means the ordering never varies with the invoking
 * environment's collation (`../../AGENTS.md`, the localeCompare invariant).
 *
 * @param {object[]} violations `Violation` records from `../src/rules/`.
 * @returns {object[]} A new array, sorted; the input is not mutated.
 */
export function sortViolations(violations) {
  return [...violations].sort((a, b) => {
    if (a.sourceFile !== b.sourceFile) return a.sourceFile < b.sourceFile ? -1 : 1;
    if (a.line !== b.line) return a.line < b.line ? -1 : 1;
    if (a.column !== b.column) return a.column < b.column ? -1 : 1;
    if (a.messageId !== b.messageId) return a.messageId < b.messageId ? -1 : 1;
    return 0;
  });
}

/** Renderers for the two formats whose output is a report, not an envelope. */
const FORMATS = Object.freeze({ text: formatReport, sarif: formatSarif });

/** Every format `check --format` accepts, in the order the help text lists them. */
const CHECK_FORMATS = Object.freeze(["text", "sarif", "json"]);

/**
 * Every format the descriptive commands (`graph`, `diff`) accept. Text and the
 * versioned JSON envelope — no SARIF, because a descriptive command does not
 * produce findings and SARIF's `results[]` is a findings container.
 */
const DESCRIBABLE_FORMATS = Object.freeze(["text", "json"]);

/**
 * Column `usage()`'s Options block aligns flag descriptions to. Matches the
 * hand-written text this table-driven rendering replaced, so deriving the
 * block from `COMMANDS` changes no byte of it.
 */
const FLAG_HELP_COLUMN = 24;

/**
 * One row of `usage()`'s Options block, and the source of the `flag`
 * `parseArgs` needs. Kept as the single place a flag's name, its parsed key,
 * and its printed description live — a hand-kept second list beside
 * `COMMANDS` is exactly the drift `usage()`'s header argues against.
 *
 * @typedef {object} FlagHelp
 * @property {string} flag The literal flag, e.g. `--format`.
 * @property {string} key The key `parseArgs` fills in the parsed options.
 * @property {string} arg The placeholder shown after the flag, e.g. `<file>`.
 * @property {readonly string[] | ((options: {boundaryConfig: string, inline?: boolean}) => readonly string[])} describe
 *   The description, one array entry per printed line. A function when the
 *   text depends on what THIS workspace's own `boundaryConfig` resolved to
 *   (`--config`'s second line, which names it).
 */

/**
 * Renders one `FlagHelp` as it appears in `--help`'s Options block: the flag
 * and its placeholder, padded to `FLAG_HELP_COLUMN` (or a bare 3-space gap
 * when the header itself already runs past that column), continuation lines
 * indented to the same column.
 *
 * @param {FlagHelp} flagHelp
 * @param {{boundaryConfig: string, inline?: boolean}} options
 * @returns {string}
 */
function renderFlagHelp(flagHelp, options) {
  const header = `  ${flagHelp.flag} ${flagHelp.arg}`;
  const gap = " ".repeat(Math.max(3, FLAG_HELP_COLUMN - header.length));
  const lines =
    typeof flagHelp.describe === "function" ? flagHelp.describe(options) : flagHelp.describe;
  const continuationIndent = " ".repeat(FLAG_HELP_COLUMN);
  return [
    `${header}${gap}${lines[0]}`,
    ...lines.slice(1).map((line) => `${continuationIndent}${line}`),
  ].join("\n");
}

/**
 * The help text, told what THIS workspace calls its boundary config.
 *
 * A function rather than a constant because the filename is a per-workspace
 * option now (`src/options.mjs`). Printing the default in a workspace that
 * renamed it would send the reader to look for a file that is not there — and
 * `--config`'s whole description is "instead of the one at the root", which
 * says nothing useful if the one at the root is misnamed in the sentence.
 *
 * `inline` is true only for a native workspace whose `lattice.json →
 * boundaryConfig` is the policy object itself rather than a filename
 * (`docs/reference/policy-schema.md`, "An inline policy, for lattice.json") — there
 * is then no file to name, no ESLint table it is shared with, and no
 * `nx.json` to change it through, so that case gets its own paragraph rather
 * than a sentence that assumes a filename exists.
 *
 * The command list AND the Options block both render straight from
 * `COMMANDS` — the command line from each row's `name`/`args`/`summary`, the
 * flag list from each row's `flagHelp` — so a command or a flag added later
 * cannot end up missing from `--help` the way a hand-kept second copy could,
 * and adding one changes no line of this function.
 *
 * @param {{boundaryConfig: string, inline?: boolean}} options
 */
const usage = ({ boundaryConfig, inline = false }) => {
  const commandLines = Object.values(COMMANDS)
    .map((command) => `  lattice ${command.name} ${command.args}   ${command.summary}`)
    .join("\n");
  // Flags are deduplicated by name across commands — today only `check` has
  // any, but a second command sharing `--format` must not print it twice.
  const seenFlags = new Set();
  const optionLines = Object.values(COMMANDS)
    .flatMap((command) => command.flagHelp)
    .filter((flagHelp) => {
      if (seenFlags.has(flagHelp.flag)) return false;
      seenFlags.add(flagHelp.flag);
      return true;
    })
    .map((flagHelp) => renderFlagHelp(flagHelp, { boundaryConfig, inline }))
    .join("\n");
  return `lattice — module-boundary enforcement across every language in the workspace

Usage:
${commandLines}
  lattice --help              Show this message

Options:
${optionLines}

${
  inline
    ? `Projects and tags come from lattice.json's own declared/inferred model; the rules come
from ${boundaryConfig} — an inline policy object on lattice.json's own \`boundaryConfig\`
field, not a separate file. There is no filename here for ESLint to share and no nx.json
to change it through; see docs/reference/policy-schema.md's "An inline policy" section.`
    : `Projects and tags come from the project graph (lattice.json or Nx); the rules come from
${boundaryConfig} at the workspace root — the same table ESLint
reads, so both enforcers answer from one source. That filename is a
convention and can be changed per workspace: through lattice.json's
\`boundaryConfig\` field, or the integration's \`boundaryConfig\` option in nx.json.`
}

Naming paths scopes the run to those files. That is a fast local pre-check and
not the gate: the cycle and lazy-load rules judge the file graph as a whole, so
a scoped run can miss what a whole-workspace run would find.

A workspace with a go.work at its root also has its use list compared against
every project's go.mod, whatever paths scope the run — a module in one list
and not the other means a developer's go build and CI build different trees.

A workspace whose tsconfig declares a paths table also has each alias judged
for life: an alias whose every target points into directories that do not
exist resolves no import, so it fails the run the way a violation does. The
table itself is never re-resolved — the check reads the same parsed tsconfig
the import resolver uses.

Exit codes: ${EXIT.ok} clean · ${EXIT.violations} findings (violations, go.work drift, dead path aliases) · ${EXIT.usage} usage error · ${EXIT.error} no verdict (a file could not be analyzed, or the run could not start)`;
};

/**
 * The options to WORD the help text with — best-effort, never fatal.
 *
 * `--help` has to work in a tree with a broken `nx.json`; refusing to print help
 * because the thing help would explain is misconfigured is the wrong order. A
 * real run reads the same options strictly, inside `check`, where a malformed
 * `nx.json` is a reason to stop rather than a reason to print a default.
 */
function optionsForUsage(cwd) {
  try {
    const root = resolveWorkspaceRootForUsage(cwd);
    if (root === null) return DEFAULT_OPTIONS;
    const { hasNx, hasNative } = markersAt(root);
    if (hasNative && !hasNx) {
      const model = loadNativeModel(root, { readFile: readWorkspaceRoot(root) });
      // An inline policy object has no filename to print — `${boundaryConfig}`
      // below would otherwise coerce it to the literal text "[object Object]",
      // which reads as a real (and wrong) filename rather than as the "there
      // is no file" it actually means. `inline: true` is what tells `usage()`
      // to print the paragraph that says so, instead of the one describing a
      // named file.
      return typeof model.boundaryConfig === "string"
        ? { boundaryConfig: model.boundaryConfig, tsConfig: model.tsConfig }
        : {
            boundaryConfig: "an inline policy in lattice.json",
            tsConfig: model.tsConfig,
            inline: true,
          };
    }
    return readPluginOptions(root);
  } catch {
    return DEFAULT_OPTIONS;
  }
}

/**
 * Walks up from `cwd` looking for any root marker — the same walk
 * `resolveCommandContext` does, kept separate here because `--help` has to work
 * with no workspace at all (returning `DEFAULT_OPTIONS`) while `check` throws
 * on exactly that condition; the two callers cannot share one function without
 * one of them losing its posture.
 *
 * They share the marker LIST all the same (`WORKSPACE_MARKERS`), because
 * differing postures are the reason for two functions and differing answers to
 * "what is a workspace root" never were. This walk used to hold its own copy
 * naming `nx.json` and `lattice.json` only, and the omission of `.moon` made
 * `adr` unusable on every Moon workspace — this repository included — while
 * its own error message named `.moon` as something it had looked for.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
function resolveWorkspaceRootForUsage(cwd) {
  return findWorkspaceRoot(cwd, WORKSPACE_MARKERS);
}

/**
 * Splits a command's arguments into its declared flags and a list of
 * positional paths.
 *
 * Shared by every command's table entry, rather than hand-rolled per command:
 * `spec.flags` maps each `--flag` this command accepts to the key it fills in
 * the returned object, `spec.defaults` seeds those keys before argv is read,
 * and `spec.formats` — when the command has one — is the closed list
 * `--format` must resolve to.
 *
 * Rejects an unknown `--flag` rather than treating it as a path: a typo like
 * `--fromat sarif` would otherwise be read as two paths, select no files, and
 * report a clean tree — the exact false green this tool exists to remove.
 *
 * @param {string[]} argv
 * @param {{flags: Record<string,string>, defaults: object, formats?: readonly string[],
 *   booleans?: readonly string[]}} spec
 * @returns {object} `{...spec.defaults, paths: string[]}`, with every declared
 *   flag's value substituted in.
 * @throws {Error} on an unknown flag, a missing value, or (when `spec.formats`
 *   is given) a `--format` value outside it.
 */
export function parseArgs(argv, spec) {
  const parsed = { ...spec.defaults, paths: [] };
  const booleans = new Set(spec.booleans ?? []);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      parsed.paths.push(arg);
      continue;
    }
    const [flag, inlineValue] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    const key = spec.flags[flag];
    if (!key) throw new Error(`unknown option '${flag}'`);
    if (booleans.has(key)) {
      // A boolean flag takes no value. `--capture` must not swallow the next
      // argument (the history directory) as its value the way a value-flag
      // would; the presence of the flag is the whole assertion.
      if (inlineValue !== undefined) {
        throw new Error(`'${flag}' takes no value`);
      }
      parsed[key] = true;
      continue;
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`'${flag}' needs a value`);
    parsed[key] = value;
  }
  if (spec.formats && !spec.formats.includes(parsed.format)) {
    throw new Error(
      `unknown format '${parsed.format}' — expected one of ${spec.formats.join(", ")}`,
    );
  }
  return parsed;
}

/**
 * `parseArgs` bound to `check`'s own flag spec — kept as its own export
 * because `src/cli.integration.test.mjs` already drives it directly, and a
 * refactor that moved its tests to `parseArgs` instead would be testing the
 * generic parser rather than the contract `check`'s callers rely on.
 *
 * @param {string[]} argv Arguments after `check`.
 * @returns {{format: string, output: string|null, config: string|null, paths: string[]}}
 * @throws {Error} on an unknown flag, a missing value, or an unknown format.
 */
export function parseCheckArgs(argv) {
  return parseArgs(argv, COMMANDS.check);
}

/**
 * The one place that turns a run's counts into the verdict every format
 * agrees on. `runCheck` uses it for the process's exit code; `check` uses the
 * same function to word its own `--format json` envelope's `status` and
 * `exitCode` fields — called once each, from the same counts, so the two can
 * never disagree about a run neither of them re-derives from the other.
 *
 * Findings first — boundary violations, go.work drift, dead tsconfig path
 * aliases and architecture-intent findings alike are verdicts, and a caller
 * that gets `findings` knows the tree is dirty whatever else the run could not
 * reach; the report lists the unreached files either way. A clean run with a
 * file nobody could analyze — or an architecture-intent boundary nobody could
 * verify — is the case that must not read `ok`, because `ok` is read as
 * "checked, and fine".
 *
 * The `decision` is the canonical 4-state verb of the same verdict
 * (`src/report/evidence.mjs`), built from the same counts so the envelope's
 * `status` and its `decision.verdict` cannot disagree: `ok`→`pass`,
 * `findings`→`fail`, `no-verdict`→`unknown`. `buildDecision` throws on any
 * invariant the counts violate (a `pass` over incomplete coverage, a `fail`
 * with no findings), which makes a regression in this mapping a loud error
 * rather than a silent one.
 *
 * @param {{violations: number, declaredEdgeFindings: number, goWorkDrift: number, tsconfigPathsDead: number, intentFindings: number, intentUnresolved: number, intentUnresolvedDecisionRefs?: number, unchecked: number, fitnessFail?: number, fitnessUnknown?: number}} counts
 * @returns {{status: "ok"|"findings"|"no-verdict", exitCode: 0|1|3, decision: object}}
 */
function verdictFor({
  violations,
  declaredEdgeFindings,
  goWorkDrift,
  tsconfigPathsDead,
  intentFindings,
  intentUnresolved,
  intentUnresolvedDecisionRefs = 0,
  unchecked,
  fitnessFail = 0,
  fitnessUnknown = 0,
}) {
  if (
    violations > 0 ||
    declaredEdgeFindings > 0 ||
    goWorkDrift > 0 ||
    tsconfigPathsDead > 0 ||
    intentFindings > 0 ||
    fitnessFail > 0
  ) {
    return {
      status: "findings",
      exitCode: EXIT.violations,
      decision: buildDecision({
        status: "findings",
        coverageComplete: unchecked === 0,
        findings:
          violations +
          declaredEdgeFindings +
          goWorkDrift +
          tsconfigPathsDead +
          intentFindings +
          fitnessFail,
      }),
    };
  }
  if (
    unchecked > 0 ||
    intentUnresolved > 0 ||
    intentUnresolvedDecisionRefs > 0 ||
    fitnessUnknown > 0
  ) {
    return {
      status: "no-verdict",
      exitCode: EXIT.error,
      decision: buildDecision({
        status: "no-verdict",
        coverageComplete: unchecked === 0,
        findings: 0,
        // The could-not-look condition, named so a reader knows WHICH half of
        // the run did not reach a verdict (I3). When read-only coverage and
        // intent both failed, name both — a reason naming only the file count
        // would hide the unresolved intent boundary from a reader acting on
        // the reason alone (it stays visible in result.intent.unresolved, and
        // status is still no-verdict, so nothing is silent). Each clause below
        // is independent of the others — none is gated on a sibling clause
        // being zero — so a tree that fails on several axes at once names
        // every one of them, not just the first the array happens to check.
        reason: [
          unchecked > 0
            ? `${unchecked} file${unchecked === 1 ? "" : "s"} could not be analyzed — coverage incomplete`
            : null,
          intentUnresolved > 0
            ? `${intentUnresolved} architecture-intent boundary or row${intentUnresolved === 1 ? "" : "s"} could not be established`
            : null,
          intentUnresolvedDecisionRefs > 0
            ? `${intentUnresolvedDecisionRefs} intent row${intentUnresolvedDecisionRefs === 1 ? "" : "s"} ${intentUnresolvedDecisionRefs === 1 ? "cites" : "cite"} a decisionRef that does not resolve`
            : null,
          fitnessUnknown > 0
            ? `${fitnessUnknown} fitness function${fitnessUnknown === 1 ? "" : "s"} could not be determined`
            : null,
        ]
          .filter(Boolean)
          .join("; "),
      }),
    };
  }
  return {
    status: "ok",
    exitCode: EXIT.ok,
    decision: buildDecision({
      status: "ok",
      coverageComplete: true,
      findings: 0,
    }),
  };
}

/**
 * Where a declared-edge finding's `implicitDependencies` entry lives, so the
 * finding can point somewhere real despite having no import site.
 *
 * Nx declares it per-project, in that project's own `project.json`. The
 * native provider validates it off `lattice.json` regardless of whether the
 * row itself sits in `lattice.json`'s `projects.declared` or a tracked
 * `project.json` (`src/providers/native/discover.mjs`'s union of the two) —
 * `lattice.json` is still the workspace's single source of truth that opted
 * either one in, the same reasoning `coverage.exempt`'s attribution above
 * uses. Moon cannot reach this function today: its edges never carry
 * `type: "implicit"` (a separate, tracked gap in the Moon provider), so
 * `declaredEdgeViolationsForCheck`'s filter never matches on a Moon graph.
 *
 * @param {{provider: string, graph: {nodes: object}}} commandContext
 * @param {string} sourceProject
 * @returns {string}
 */
function declaredEdgeManifest({ provider, graph }, sourceProject) {
  if (provider === "nx") {
    const root = graph.nodes[sourceProject]?.data?.root;
    return root ? `${root}/project.json` : "project.json";
  }
  return LATTICE_MODEL_FILE;
}

/**
 * Runs one `check`: workspace, analysis, rules, report.
 *
 * Returns the report and the counts rather than printing, so the caller owns
 * both the destination and the exit code — and so a test can read the verdict
 * without a subprocess.
 *
 * The workspace/provider/analysis preamble is `./src/commands/context.mjs`'s
 * `resolveCommandContext` — this function's whole body used to BE that
 * preamble, before a second command existed to need it too. What is still
 * this function's own: loading the boundary policy, the go.work drift check,
 * the tsconfig paths hygiene check, judging the rules, and rendering the
 * report in whichever format was asked for.
 *
 * `readGraph` and `listFiles` are the two seams that reach outside this
 * process — Nx and git — threaded straight through to `resolveCommandContext`.
 * Injectable for the same reason every resolver in this project takes its
 * readers: a test drives the real analysis, the real rules and the real
 * report over a fixture tree, and pins the exact `file:line:column` a
 * developer would act on, without an Nx installation or a git repository.
 *
 * @param {{format: string, config: string|null, paths: string[]}} options
 * @param {{cwd: string, readGraph?: Function, listFiles?: Function}} context
 * @returns {Promise<{report: string, violations: number, declaredEdgeFindings: number,
 *   goWorkDrift: number, tsconfigPathsDead: number, intentFindings: number,
 *   intentUnresolved: number, intentUnresolvedDecisionRefs: number, fitnessFail: number,
 *   fitnessUnknown: number, analyzed: number, unchecked: number, waived?: number}>}
 */
export async function check(options, { cwd, readGraph, listFiles = listTrackedFiles }) {
  const commandContext = resolveCommandContext(
    { cwd, paths: options.paths },
    { readGraph, listFiles },
  );
  const { root, graph, workspace, tracked } = commandContext;
  const { imports, exemptedFiles } = commandContext.analysis;
  const failures = [...commandContext.analysis.failures];
  const analyzed = commandContext.analysis.analyzed;

  // The config's location is a separate fact from the workspace root, which is
  // why `--config` does not move the root: pointed at a consumer's tree, the
  // tool and the law it enforces are in different trees, and the tree being
  // judged is still the consumer's. Loaded before the two workspace-level
  // checks below, the same order `check` has always used — a malformed
  // `--config` stops the run before either of them runs at all. `resolvePolicy`
  // owns the profile/file/inline priority — see its own doc for the order and
  // why a `profiles` registry, when named, takes `--config`/`boundaryConfig`
  // over as a profile NAME rather than a filename. `check` is the one caller
  // of the eleven that also needs to know WHICH profile/file resolved it —
  // `profile`/`source` — so its report can name the law that governed the run
  // (P1-01): a violating tree under a weak policy and a clean tree under a
  // strict one used to produce byte-identical output, with nothing anywhere in
  // the report saying which law had run. `profile` is `null` on every branch
  // but the profile one — stated, not omitted, the same "no fact, no claim"
  // bargain `goWork`/`tsconfigPaths` keep below for a feature a workspace does
  // not use either. `source` is always workspace-relative, the convention
  // every other file reference in this report already keeps (`sourceFile`,
  // `tsConfig`, intent's `file`).
  const {
    config,
    profile: policyProfile,
    source: policySource,
  } = await resolvePolicy(options, commandContext, cwd);
  // D-10: provenance is resolved once, up front — BEFORE any verdict — and
  // reused in the JSON envelope, so a commitless repository (an unborn HEAD,
  // which makes `git ls-files` report zero files) is a loud exit-3 could-not-
  // look in BOTH report formats instead of a quiet "0 imports in 0 files"
  // claim. `resolveProvenance` throws for that state; `null` here means "git
  // not available or not a repository at all", a legitimate no-origin-claim.
  const provenance = resolveProvenance(root);
  // The policy's own fingerprint, alongside its source — the SHA-256 of the
  // canonicalized policy (`depConstraints`/`options`/`suppressions`) that
  // `graph`/`diff`/`history` already share (`computePolicyFingerprint`,
  // `./src/commands/graph.mjs`), reused here rather than recomputed by hand so
  // two runs under the identical effective policy always agree, whichever of
  // `resolvePolicy`'s branches produced it. Unlike `graph`'s own optional
  // `result.policy` — absent when no config was given — `check` always loads
  // exactly one policy before it can judge anything, so `policy` is `null`
  // only on the one defensive arm `resolvePolicy` itself documents as
  // unreachable by any current provider.
  const policy = config
    ? {
        profile: policyProfile,
        source: policySource,
        fingerprint: computePolicyFingerprint(config),
      }
    : null;

  // The go.work drift check, keyed off the manifest's presence the way every
  // resolver keys off its language's manifest: no tracked root go.work, no
  // check and no mention. It ignores `options.paths` on purpose — two
  // workspace facts are compared, not files analyzed — and a go.work the
  // parser cannot read becomes a whole-file failure (exit 3) rather than a
  // truncated use list, because a use list cut short at the malformed line
  // would hide every stale entry below it while inventing missing-use
  // findings above it — a verdict about a file that was never read
  // (`src/go-work.mjs`).
  let goWork = null;
  if (tracked.includes("go.work")) {
    try {
      const goWorkText = workspace.readFile("go.work");
      if (goWorkText === null) throw new Error("go.work could not be read");
      goWork = compareGoWork({
        uses: parseGoWorkUse(goWorkText),
        workspaceRoot: root,
        projects: workspace.projects,
        files: tracked,
      });
    } catch (cause) {
      failures.push(
        fileFailure(
          "go.work",
          `${cause?.message ?? cause} — a go.work this tool cannot read is a coverage hole, ` +
            `not an empty use list, so the drift check reached no verdict`,
        ),
      );
    }
  }

  // The tsconfig paths hygiene check, keyed the same way: no `paths` table in
  // the workspace tsconfig — or no tsconfig at all — means no check and no
  // mention. The table, its base and the failure posture all come from the
  // resolver's own parsed context (`tsconfigPathsFacts`), so the file judged
  // here is provably the file `ts.resolveModuleName` reads, and a tsconfig
  // that failed to load is a whole-file failure (exit 3) here exactly as it is
  // at every TypeScript import site — never an absent table. Only existence is
  // asked of the filesystem, because the judgement is about directories on
  // disk, the same disk the resolver probes (`src/tsconfig-paths.mjs` owns the
  // rule and its limits). Like go.work, `options.paths` is ignored on purpose:
  // a workspace fact is judged, not files analyzed.
  let tsconfigPaths = null;
  {
    const facts = tsconfigPathsFacts(workspace);
    if (facts.configFailure !== null) {
      failures.push(
        fileFailure(
          facts.tsConfig,
          `${facts.configFailure} — and the paths hygiene check reached no verdict, because a ` +
            `tsconfig this tool cannot load is a coverage hole, not an empty alias table`,
        ),
      );
    } else if (facts.paths !== undefined) {
      tsconfigPaths = judgeTsconfigPaths({
        paths: facts.paths,
        base: facts.base,
        workspaceRoot: root,
        tsConfig: facts.tsConfig,
        directoryExists: (dir) => {
          try {
            return statSync(join(root, dir)).isDirectory();
          } catch {
            return false;
          }
        },
      });
      for (const { reason } of tsconfigPaths.malformed) {
        failures.push(fileFailure(facts.tsConfig, reason));
      }
    }
  }

  // The architecture-intent check, keyed the same way as go.work and tsconfig:
  // a tracked root `architecture-intent.json` means the workspace declared the
  // architecture it intends, and the observed graph is judged against it. An
  // intent file that fails to parse or validate is a no-verdict (exit 3) on
  // the intent axis rather than "no intent" — a declaration this tool cannot
  // establish must never read as one that was verified. It is NOT folded into
  // `failures`: that bucket means "a source file the analysis could not read",
  // and counting `architecture-intent.json` there would flip
  // `coverage.complete` and list it among `notAnalyzed` source holes, which a
  // reader would misread as a coverage problem with source files (the design
  // contract `docs/reference/architecture-intent.md` states: a malformed
  // intent renders as a distinct line, never as "N files could not be
  // analyzed"). It rides `intentUnresolved` instead, the same no-verdict lane
  // a zero-member boundary takes.
  /** @type {{verdict: "ok"|"findings"|"no-verdict", findings: object[], unresolved: object[], boundaries: object[], notes: object[], unresolvedDecisionRefs?: {kind: string, decisionRef: string}[]}|null} */
  let intent = null;
  // The intent rows that carry a `decisionRef`, for `check`'s own citation
  // pass — empty when no intent is tracked, and populated by the fold below
  // (F01: an intent row citing nothing the registry knows must be surfaced
  // the way `drift`/`provenance` surface it, not left silent).
  let intentDecisionRefRows = [];
  if (tracked.includes(INTENT_FILE)) {
    try {
      // The drift fold runs the same refuse-incomplete-graph guard the `drift`
      // command does: an Nx workspace whose polyglot manifests are invisible to
      // the graph must not have its intent judged against a graph that cannot
      // see them. `driftForCheck` is what `drift` and `check` share.
      const drift = await driftForCheck(commandContext, {
        loadIntentOverride: (root) => loadIntent(root, { tracked }),
      });
      intent = {
        verdict:
          drift.findings.length > 0
            ? "findings"
            : drift.unresolved.length > 0
              ? "no-verdict"
              : "ok",
        boundaries: drift.boundaries,
        findings: drift.findings,
        unresolved: drift.unresolved,
        notes: drift.notes,
      };
      // The fold's intent rows carrying a `decisionRef` — the rows `drift`/
      // `provenance` judge loudly, and which `check` must not leave silent
      // (F01). Captured here, outside the `intent` object, so the citation
      // pass below can judge them through the same registry as the boundary
      // rows.
      intentDecisionRefRows = drift.decisionRefRows;
    } catch (cause) {
      const reason =
        `${cause?.message ?? cause} — architecture-intent.json could not be ` +
        `established, so the intent check reached no verdict`;
      intent = {
        verdict: "no-verdict",
        findings: [],
        unresolved: [{ boundary: INTENT_FILE, issue: reason }],
        boundaries: [],
        notes: [],
      };
    }
  }

  const violations = sortViolations(evaluate(imports, graph, config));
  // An ACTIVE waiver keeps the violation it accepts in the findings list,
  // marked `waivedBy` — the run is still non-zero (waiving does not flip
  // exit 1 → 0), and this count is the additive "accepted violations" number
  // the report surfaces. Expired waivers re-assert in full (evidence
  // "expired waiver"), so they are ordinary violations here, never waived.
  const waived = violations.filter((violation) => violation.waivedBy).length;

  // `evaluate()` above judges only import sites, by design (`src/rules/README.md`:
  // "analysis records and the loaded config, nothing else"). An `implicit`-typed
  // graph edge — `implicitDependencies` in a `project.json`/`lattice.json` row —
  // has no import site behind it and so never reaches that loop, which used to
  // mean `check` reported nothing about it while `context`/`impact` (walking
  // `graph.dependencies` directly through the same `judgeEdge`) showed it as a
  // tag violation: an empty result that was not actually a clean verdict, the
  // exact defect this project's invariant forbids (`../../AGENTS.md`). Reusing
  // `judgeEdge` here — rather than a second implementation — is what guarantees
  // `check` can never disagree with what those commands already display for the
  // identical edge.
  const implicitEdges = Object.values(graph.dependencies ?? {})
    .flat()
    .filter((edge) => edge.type === "implicit").length;
  const declaredEdgeViolations = declaredEdgeViolationsForCheck(graph, config.depConstraints).map(
    (violation) => ({ ...violation, file: declaredEdgeManifest(commandContext, violation.source) }),
  );
  const declaredEdgeFindings = declaredEdgeViolations.length;
  // `null` — not `{checked: true, findings: []}` — when the graph has no
  // `implicit` edges at all: the same "no fact, no claim" bargain go.work and
  // tsconfig-paths state for a workspace that never uses the feature either,
  // so a workspace with no `implicitDependencies` anywhere pays nothing and
  // hears nothing, rather than a near-universal "0 implicit edges" line.
  const declaredEdges =
    implicitEdges === 0 ? null : { findings: declaredEdgeViolations, judged: implicitEdges };

  // A `depConstraints` row's `decisionRef` names the ADR (or rule/fitness id)
  // that supposedly authorizes it — but nothing verified that citation before
  // it reached a report: `rowSchemaViolations` (`src/governance/row-schema.mjs`)
  // has always had a resolution half gated on an injected `io.resolve`, and
  // `config.mjs` has never supplied one, so `resolveDecisionRef`
  // (`src/governance/adr-registry.mjs`) had zero production callers. A rule
  // bound to a nonexistent ADR id fired exactly as designed and the report
  // quoted the citation as if it were confirmed. Checked only when a row
  // actually carries one — the common case (no `docs/adr/` adopted yet) pays
  // no extra read. Report-only: an unresolved citation is a fact about the
  // rule's DOCUMENTATION, not about whether the boundary holds, so it changes
  // no byte of `verdictFor`'s inputs below — the same posture `provenance`
  // already takes for a row with no `origin` (`src/commands/provenance-command.mjs`).
  //
  // The intent's rows are judged through the SAME registry, in the SAME pass,
  // so `check` cannot disagree with `drift`/`provenance` about which intent
  // citations resolve. Unlike the boundary rows, an intent row with an
  // unresolved `decisionRef` folds into the no-verdict lane (exit 3) WHEN THE
  // INTENT IS APPLIED — a workspace that declared an intended architecture
  // whose governing decision does not exist cannot claim `ok` on that axis
  // (`drift`/`provenance` already flag the identical row loudly). That is the
  // F01 parity the audit names: `drift` and `provenance` both surface it, and
  // the gate CI runs must not be the one face that stays silent.
  const unresolvedDecisionRefs = new Set();
  const intentUnresolvedDecisionRefRows = [];
  {
    // Intent rows while the intent is actually tracked — the same gate the
    // fold above uses, so a workspace with no intent pays nothing and hears
    // nothing.
    const decisionRefRows = [
      ...config.depConstraints
        .map((row, index) => ({ kind: `depConstraints[${index}]`, row }))
        .filter(({ row }) => typeof row?.decisionRef === "string" && row.decisionRef.trim() !== ""),
      ...intentDecisionRefRows,
    ];
    if (decisionRefRows.length > 0) {
      const adrContext = readAdrContext(root, { tracked });
      // F04: the fitness half resolves against the ids the loaded policy
      // DECLARES (`declaredFitnessNames(config)`), never the ADRs' own
      // `bindings` — a citation cannot resolve itself.
      for (const row of unresolvedDecisionRefRows(
        decisionRefRows,
        adrContext.byId,
        declaredFitnessNames(config),
      )) {
        unresolvedDecisionRefs.add(row.decisionRef);
        if (row.kind.startsWith("depConstraints")) continue;
        intentUnresolvedDecisionRefRows.push({ kind: row.kind, decisionRef: row.decisionRef });
      }
    }
    // The unresolved intent citations ride the intent object so the text
    // report can render them inline (the same UNRESOLVED note the constraint
    // rows get), and so the JSON intent block names WHICH rows cited what.
    if (intent !== null && intentUnresolvedDecisionRefRows.length > 0) {
      intent.unresolvedDecisionRefs = intentUnresolvedDecisionRefRows;
    }
  }

  const goWorkDrift = goWork === null ? 0 : goWork.findings.length;
  const tsconfigPathsDead = tsconfigPaths === null ? 0 : tsconfigPaths.findings.length;
  const intentFindings = intent === null ? 0 : intent.findings.length;
  const intentUnresolved = intent === null ? 0 : intent.unresolved.length;

  // The fitness fold, keyed the same two ways every governance axis is: a
  // policy that declares fitness (the `fitness` export on the boundary
  // config) is judged against the run's own facts — the same graph, the same
  // analysis, the same intent verdict, the same suppressions `check` already
  // holds. Absence is a workspace decision (the key is omitted, never
  // `null`); presence without a number of declared rows is impossible (the
  // validator refuses an empty list). A declared function whose match selects
  // no project is `skipped` — loud, never folded into `pass`; a function the
  // run could not determine is `unknown`, which rides `fitnessUnknown`, the
  // same no-verdict lane a zero-member boundary takes. `scoped` marks the
  // path-scoped case (`check <path>`), where coverage over a matched
  // project's whole file set is not determinable — the registry answers that
  // `not_applicable`, never a partial-number verdict and never `unknown`
  // either (P1-19): `coverage-minimum` cannot be judged by ANY scoped run,
  // which is a fact about the run mode, not evidence of a coverage hole, so it
  // joins `skipped` in NOT riding `fitnessFail`/`fitnessUnknown` below — a
  // scoped run over an otherwise-clean subtree in a workspace that declares
  // `coverage-minimum` no longer exits 3 for a question this run was never in
  // a position to answer.
  let fitness = null;
  if (config.fitness !== undefined) {
    const { decisions, overall } = fitnessForCheck(commandContext, {
      rows: config.fitness,
      intent,
      suppressions: config.suppressions,
      scoped: options.paths.length > 0,
    });
    fitness = { decisions, overall };
  }
  const fitnessFail = fitness === null ? 0 : fitness.overall.verdict === "fail" ? 1 : 0;
  const fitnessUnknown = fitness === null ? 0 : fitness.overall.verdict === "unknown" ? 1 : 0;
  // Files the run produced no verdict about, counted here rather than
  // recomputed by the caller: the exit code, the text report and the JSON
  // envelope must all agree about which failures mean "not covered", and one
  // predicate is how they do.
  const unchecked = new Set(
    failures.filter(isWholeFileFailure).map((failure) => failure.sourceFile),
  ).size;
  // A `coverage.exempt` row removes a file from `unclaimed` before this run
  // ever sees it — legitimately, for vendored or generated code — but nothing
  // that removal produces was ever named in any report: an exempted file and
  // a genuinely covered one read identically in every surface `check`
  // produces. Stated as a note for the same reason the polyglot coverage gap
  // below is: the exit code and verdict are unchanged (this is what
  // `coverage.exempt` is FOR), but the silent direction — a reader unable to
  // tell that coverage narrowed at all — is closed.
  const exemptionNote =
    exemptedFiles.length > 0
      ? `${exemptedFiles.length} file${exemptedFiles.length === 1 ? "" : "s"} exempted from ` +
        `coverage by ${LATTICE_MODEL_FILE}'s coverage.exempt`
      : null;

  // Ready-to-ship policy facts have always been sourced from `boundaryConfig`
  // via `src/config.mjs`'s `notes`; the intent check's own coverage notes ride
  // the same seam so both surfaces (text and JSON) thread them identically —
  // today only an `"optional": true` allowed row whose statement is absent.
  const notes = [
    ...(config.notes ?? []),
    ...(intent === null ? [] : intent.notes),
    ...(exemptionNote === null ? [] : [exemptionNote]),
  ];

  // A polyglot coverage gap: the Nx graph carries no polyglot edges because
  // the plugin is not registered, but polyglot manifests exist under project
  // roots. The checker still judged every import it found — this is not a
  // finding and not a refusal — but `nx affected` and `@nx/enforce-module-boundaries`
  // are blind to Go, Rust and Python dependencies. Surfaced as a
  // degraded-coverage note so the silent direction (exit 0 with no mention) is
  // closed, without changing the exit code or verdict. The condition mirrors
  // `./src/commands/graph.mjs`'s refusal, which throws for the same state
  // because a descriptive command's output is the graph itself — here the
  // checker's own analysis covers what the graph does not, so a note is the
  // right level. cf. #38
  const coverageGaps =
    commandContext.provider === "nx" &&
    !commandContext.pluginGap.registered &&
    commandContext.pluginGap.manifests.length > 0
      ? [{ kind: "unregistered-plugin", manifests: commandContext.pluginGap.manifests }]
      : [];

  const report =
    options.format === "json"
      ? renderJson(
          jsonEnvelope({
            command: "check",
            context: {
              root,
              provider: commandContext.provider,
              marker: commandContext.marker,
              // D-10: provenance rides the SAME-envelope shape every other
              // command resolves through the one `resolveProvenance` — a check
              // report is byte-identifiable to the git HEAD it was run on, so
              // a dirty or un-stamped CI run cannot present a claim about a
              // different tree state. Resolved once at the top of `check` for
              // the reason that comment states.
              provenance,
            },
            // `verdictFor` returns `status`, `exitCode`, and the canonical
            // `decision` — the four-state verb of the same counts — so the
            // envelope's `decision.verdict` and its `status` are built from
            // exactly one computation and can never disagree.
            ...verdictFor({
              violations: violations.length,
              declaredEdgeFindings,
              goWorkDrift,
              tsconfigPathsDead,
              intentFindings,
              intentUnresolved,
              intentUnresolvedDecisionRefs: intentUnresolvedDecisionRefRows.length,
              unchecked,
              fitnessFail,
              fitnessUnknown,
            }),
            coverage: {
              complete: unchecked === 0,
              projects: Object.keys(graph.nodes).length,
              analyzedFiles: analyzed,
              imports: imports.length,
              notAnalyzed: failures
                .filter(isWholeFileFailure)
                .map(({ sourceFile, reason }) => ({ file: sourceFile, reason })),
              blindSpots: failures
                .filter((failure) => !isWholeFileFailure(failure))
                .map(({ sourceFile, line, column, reason }) => ({
                  file: sourceFile,
                  line,
                  column,
                  reason,
                })),
              notes,
              coverageGaps,
            },
            result: {
              // Named first: which law produced everything below it (P1-01).
              // Always present — `check` cannot judge anything without
              // loading exactly one policy — unlike `graph`'s own `policy`,
              // which is absent when no config was given to a purely
              // descriptive run.
              policy,
              violations,
              // Additive and optional: absent when the tree has no active
              // waivers, so an unchanged tree's JSON is unchanged. Never `!` —
              // the accepted count is a tracked decision, not a new error kind.
              ...(waived > 0 ? { waived } : {}),
              // Additive and optional, the same bargain: absent when every
              // depConstraints row's decisionRef resolves (or none carries
              // one) — an unchanged tree's JSON is unchanged. A row that fired
              // stays in `violations` with its raw `constraint.decisionRef`
              // untouched (byte-identical to today); this list is the
              // separate, resolved fact a consumer cross-checks it against,
              // never a mutation of the row itself.
              ...(unresolvedDecisionRefs.size > 0
                ? {
                    unresolvedDecisionRefs: [...unresolvedDecisionRefs].sort((a, b) =>
                      a < b ? -1 : a > b ? 1 : 0,
                    ),
                  }
                : {}),
              goWork: goWork === null ? null : { checked: true, findings: goWork.findings },
              tsconfigPaths:
                tsconfigPaths === null ? null : { checked: true, findings: tsconfigPaths.findings },
              // `declaredEdges` is `null` under the same "no fact, no claim"
              // bargain as goWork/tsconfigPaths above — computed once, right
              // where `implicitEdges` is counted.
              declaredEdges:
                declaredEdges === null
                  ? null
                  : {
                      checked: true,
                      judged: declaredEdges.judged,
                      findings: declaredEdges.findings,
                    },
              // Intent is a governance DECLARATION, absent when the workspace
              // chose not to make one: the key is omitted, never written as
              // null — the design contract `docs/reference/json-output.md` will
              // state ("never serialized as `null` — absent key, not null
              // value"). goWork/tsconfig leave a named null because those are
              // checks the tool can always run (they just found nothing);
              // intent absence is a workspace decision, not a finding of zero.
              ...(intent === null
                ? {}
                : {
                    intent: {
                      checked: true,
                      file: INTENT_FILE,
                      verdict: intent.verdict,
                      findings: intent.findings,
                      unresolved: intent.unresolved,
                      boundaries: intent.boundaries,
                      // The intent rows whose `decisionRef` does not resolve —
                      // the same citations `result.unresolvedDecisionRefs` lists
                      // values for, named here with their row so the JSON
                      // intent block is self-contained.
                      ...(intent.unresolvedDecisionRefs !== undefined
                        ? { unresolvedDecisionRefs: intent.unresolvedDecisionRefs }
                        : {}),
                    },
                  }),
              // Fitness is a policy DECLARATION too, absent when the workspace
              // chose not to declare functions — the same omitted-key-not-
              // null discipline the intent block above states.
              ...(fitness === null
                ? {}
                : {
                    fitness: {
                      checked: true,
                      verdict: fitness.overall.verdict,
                      functions: fitness.decisions,
                    },
                  }),
            },
          }),
        )
      : FORMATS[options.format]({
          policy,
          violations,
          failures,
          analyzed,
          imports: imports.length,
          projects: Object.keys(graph.nodes).length,
          goWork,
          tsconfigPaths,
          declaredEdges,
          intent,
          fitness: fitness?.decisions,
          fitnessOverall: fitness?.overall,
          // Only the ESLint boundaryConfig dialect ever produces one (see
          // `./src/eslint-config.mjs`'s `extractBoundaryRule`) — which entry it
          // bound when more than one configured the rule, or that the winning
          // entry was files-scoped under the accepted TS/JS shape. Computing it
          // and never showing it would be the silent direction with extra
          // steps, so it rides the same coverage line every other "what was
          // inspected" fact does (`src/report/text.mjs`'s `formatReport`).
          notes,
          coverageGaps,
          // `formatReport` (text) reads this to annotate an unresolved
          // decisionRef inline; `formatSarif` does not destructure it, so a
          // SARIF upload stays exactly as it renders today.
          unresolvedDecisionRefs,
        });

  return {
    report,
    violations: violations.length,
    waived,
    declaredEdgeFindings,
    goWorkDrift,
    tsconfigPathsDead,
    intentFindings,
    intentUnresolved,
    intentUnresolvedDecisionRefs: intentUnresolvedDecisionRefRows.length,
    fitnessFail,
    fitnessUnknown,
    analyzed,
    unchecked,
  };
}

/**
 * The fixed names `--output` may never resolve to, resolved the same ways
 * this file already resolves each of them elsewhere: `INTENT_FILE` and
 * `LATTICE_MODEL_FILE` are workspace-root-relative constants read at
 * `resolve(root, …)` wherever `check`/`drift` load them; the boundary law is
 * `options.config` resolved `isAbsolute(...) ? ... : resolve(cwd, ...)` — the
 * exact expression repeated at every other `options.config` read in this
 * file — falling back to the per-provider name `optionsForUsage(cwd)`
 * resolves (`nx.json`'s `plugins[].options.boundaryConfig`, a `lattice.json`
 * `boundaryConfig`, or the default), because that is the name this run's
 * `check`/`graph` actually load through `resolvePolicy`. A workspace that
 * renamed its law via `nx.json` or `lattice.json` is covered, not just the
 * default name and the `--config` override.
 *
 * `root === null` (no workspace reachable from `cwd`) returns an empty map
 * rather than throwing: every caller of `writeOutputReport` below already
 * resolved a workspace earlier in its own run, from this same `cwd`, or it
 * would not have reached the point of writing a report at all — this is a
 * defensive fallback, not a path any command here takes today.
 *
 * @param {string} cwd
 * @param {string|null|undefined} configOption This run's `options.config`.
 * @returns {Map<string, string>} absolute path → the name to name back in a
 *   refusal, for every fixed name that resolved.
 */
function governanceOutputTargets(cwd, configOption) {
  const root = resolveWorkspaceRootForUsage(cwd);
  if (root === null) return new Map();
  const boundaryConfigName =
    configOption ?? optionsForUsage(cwd).boundaryConfig ?? DEFAULT_OPTIONS.boundaryConfig;
  const boundaryConfigAbs = configOption
    ? isAbsolute(configOption)
      ? configOption
      : resolve(cwd, configOption)
    : resolve(root, boundaryConfigName);
  return new Map([
    [resolve(root, INTENT_FILE), INTENT_FILE],
    [resolve(root, LATTICE_MODEL_FILE), LATTICE_MODEL_FILE],
    [boundaryConfigAbs, boundaryConfigName],
  ]);
}

/**
 * Writes a rendered report to `--output`'s path, atomically and without
 * following a symlink planted at the temp path — the one function every
 * `run*` below calls rather than the 16 near-identical inline copies this
 * replaces.
 *
 * Refuses first, before any write is attempted, on two grounds. `outputPath`
 * resolving to a name `governanceOutputTargets` above guards — the workspace's
 * declared architecture intent, its native model file, or its boundary law,
 * however that law is named — is one. The other is containment: a
 * workspace-controlled symlink in an INTERMEDIATE directory component of
 * `outputPath` (`./src/containment.mjs`'s `containmentViolation` with
 * `forWrite: true`) would make this write land somewhere other than the path
 * the user named — outside the workspace entirely, or at the workspace root
 * for a `sub -> .` self-loop — with the run reporting success. That write is
 * refused loudly (`exit 3`, never a silent different-location write). `{flag:
 * "wx"}` below stops the temp write from following or truncating through
 * whatever already sits at `<target>.tmp`; it says nothing about the FINAL
 * name, and `renameSync` replaces whatever is there unconditionally — which
 * is exactly what makes an ordinary `--output` reusable across runs
 * (`docs/usage/ci.md`'s own recipe reruns `--output boundaries.json` on every
 * push, relying on the previous run's file being silently replaced). That
 * reuse is fine for a report; it is never fine for a file THIS TOOL reads as
 * the workspace's own declared fact — `lattice check --output
 * architecture-intent.json` (a copy-pasted flag, a typo'd path, or a CI
 * script a pull request edited) would otherwise silently replace a tracked
 * governance file with a report, exit 0, with the loss surfacing only later
 * and elsewhere, the first time something else tries to read the file it used
 * to be. Deliberately narrow: an arbitrary tracked file this tool never
 * assigns a meaning to is not refused, because refusing every pre-existing
 * target would break the documented reuse above.
 *
 * Written to a sibling `.tmp` file first, then renamed onto the target — a
 * rename within one directory is atomic, so a reader of `outputPath` (this
 * process crashing mid-write, or a second run racing this one) sees either
 * the previous complete file or the new complete one, never a truncated or
 * half-written report. No fsync: the guarantee this buys is "never a torn
 * file", not "survives a power loss".
 *
 * The temp write uses `{flag: "wx"}` — `O_CREAT|O_EXCL`, which POSIX
 * guarantees fails on a path that already exists WITHOUT following it if it
 * is a symlink, dangling or not. Every value in `--output` and every value in
 * a report body — a project name, a directory, an import specifier — comes
 * from the tree being judged and is attacker-supplied the moment a pull
 * request adds one (`../SECURITY.md`'s threat model). Before this guard, a
 * tracked symlink at `<target>.tmp` pointing outside the workspace made this
 * write follow it and overwrite whatever the symlink named, with
 * attacker-chosen bytes, while reporting success — the documented CI recipe
 * (`docs/usage/ci.md`) run against such a pull request was a runner-write
 * primitive. The same flag closes a second hole for free: a stray `.tmp` left
 * by a crashed prior run — or a file that happens to collide with the name —
 * used to be silently truncated and then renamed away; now the write refuses
 * with EEXIST, loud, rather than destroying a file this run did not create.
 * `renameSync` itself needs no equivalent guard against a SYMLINK: POSIX
 * `rename(2)` replaces whatever sits at the destination path — including a
 * symlink there — as a single directory-entry swap, and never dereferences it
 * to write through. It needs the governance guard above instead, because a
 * symlink was never the only thing worth protecting at that destination.
 *
 * The containment decision and the actual write share ONE resolved path.
 * `outputAbs = resolve(cwd, outputPath)` collapses `..` segments lexically, and
 * the tmp write and `renameSync` act on `outputAbs` — the same string the
 * governance and containment checks saw — never on the raw `outputPath`. This
 * is what closes the `..`-across-a-symlink corner of the intermediate-component
 * escape (`./src/containment.mjs`'s `containsDotDot` owns the mechanism): if
 * the write used the raw spelling, a `sub -> /tmp/out` plus `sub/../report.json`
 * would resolve the check to a clean path while the kernel, walking the raw
 * string, followed `sub` out of the tree. A written path that has no `..` left
 * in it cannot hide a symlink the kernel would walk later.
 *
 * @param {string} outputPath The `--output` flag as the user wrote it.
 * @param {string} text The rendered report, newline-terminated by the caller.
 * @param {{err: Function}} env
 * @param {string} cwd This run's working directory, for resolving both
 *   `outputPath` and the governance names above the same way.
 * @param {string|null|undefined} configOption This run's `options.config`.
 * @returns {boolean} `true` on success; `false` after reporting the failure
 *   to `env.err` — the caller's cue to return its own no-verdict exit code.
 */
function writeOutputReport(outputPath, text, env, cwd, configOption) {
  // `resolve` normalises BOTH branches — an absolute `--output` keeps its `..`
  // segments collapsed lexically, and a relative one resolves against this
  // run's `cwd`, not the process's. The identical `outputAbs` then feeds the
  // governance guard, the containment decision, AND the write.
  const outputAbs = isAbsolute(outputPath) ? resolve(outputPath) : resolve(cwd, outputPath);
  const guardedName = governanceOutputTargets(cwd, configOption).get(outputAbs);
  if (guardedName !== undefined) {
    env.err(
      `lattice: --output '${outputPath}' resolves to '${guardedName}' — this tool reads that ` +
        `file as the workspace's own declared fact, and overwriting it with a report would ` +
        `destroy the declaration instead. Write the report somewhere else.`,
    );
    return false;
  }
  const root = resolveWorkspaceRootForUsage(cwd);
  if (root !== null) {
    const violation = containmentViolation(root, outputAbs, { forWrite: true });
    if (violation !== null) {
      env.err(`lattice: --output '${outputPath}' is refused: ${violation}`);
      return false;
    }
  }
  const tmpOutput = `${outputAbs}.tmp`;
  let tmpCreated = false;
  try {
    writeFileSync(tmpOutput, text, { flag: "wx" });
    tmpCreated = true;
    renameSync(tmpOutput, outputAbs);
    return true;
  } catch (cause) {
    // Only clean up a `.tmp` THIS call created — an `EEXIST` from `wx` means
    // nothing was written, so there is nothing here to remove, and the path
    // may be attacker- or accident-owned rather than this run's own leftover.
    if (tmpCreated) {
      try {
        unlinkSync(tmpOutput);
      } catch {
        // Nothing this run can do about it either way.
      }
    }
    env.err(`lattice: could not write --output '${outputPath}': ${cause?.message ?? cause}`);
    return false;
  }
}

/**
 * `COMMANDS.check`'s `run`: drives `check`, writes the report where it
 * belongs, and returns the process's exit code. Everything about argv parsing
 * and where output goes lives here, not in `check` itself — `src/commands/README.md`'s
 * rule applied to the one command that predates that rule.
 *
 * @param {{format: string, output: string|null, config: string|null, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, readGraph?: Function, listFiles?: Function}}} runContext
 * @returns {Promise<number>}
 */
async function runCheck(options, { cwd, env }) {
  let result;
  try {
    result = await check(options, { cwd, readGraph: env.readGraph, listFiles: env.listFiles });
  } catch (error) {
    // A bad path argument — outside the tree, or matching no tracked file at
    // all (a typo, the wrong cwd, or a file not yet `git add`ed) — is the
    // user's mistake to retype; everything else is the run failing. The two
    // get different codes because only one is worth retrying with different
    // arguments.
    const usageError = /is outside the workspace|matches no tracked file/.test(
      error?.message ?? "",
    );
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = result.report.endsWith("\n") ? result.report : `${result.report}\n`;
    if (!writeOutputReport(options.output, reportText, env, cwd, options.config)) return EXIT.error;
    // The report went to a file, so the log would otherwise say nothing at all
    // about a run that just failed the build.
    env.err(
      `lattice: ${result.violations} violation${result.violations === 1 ? "" : "s"} ` +
        `over ${result.analyzed} analyzed file${result.analyzed === 1 ? "" : "s"}` +
        (result.waived > 0 ? ` (${result.waived} waived until their expiry)` : "") +
        (result.declaredEdgeFindings > 0
          ? `, ${result.declaredEdgeFindings} declared-edge finding${result.declaredEdgeFindings === 1 ? "" : "s"}`
          : "") +
        (result.goWorkDrift > 0
          ? `, ${result.goWorkDrift} go.work drift finding${result.goWorkDrift === 1 ? "" : "s"}`
          : "") +
        (result.tsconfigPathsDead > 0
          ? `, ${result.tsconfigPathsDead} dead tsconfig path alias${result.tsconfigPathsDead === 1 ? "" : "es"}`
          : "") +
        (result.intentFindings > 0
          ? `, ${result.intentFindings} architecture-intent finding${result.intentFindings === 1 ? "" : "s"}`
          : "") +
        // Fitness drives the exit code exactly like every count above it
        // (`verdictFor`) — omitting it here is what let a fitness-only
        // failure log "0 violations …" beside a non-zero exit.
        (result.fitnessFail > 0
          ? `, ${result.fitnessFail} fitness function${result.fitnessFail === 1 ? "" : "s"} failed`
          : "") +
        (result.fitnessUnknown > 0
          ? `, ${result.fitnessUnknown} fitness function${result.fitnessUnknown === 1 ? "" : "s"} undetermined`
          : "") +
        (result.unchecked > 0
          ? `, ${result.unchecked} file${result.unchecked === 1 ? "" : "s"} not analyzed`
          : "") +
        ` → ${options.output}`,
    );
  } else {
    env.out(result.report);
  }

  return verdictFor(result).exitCode;
}

/**
 * Whether the workspace's resolved options name a `profiles` registry — the
 * check command's signal to enforce by profile NAME rather than by file. A
 * workspace that never registered the plugin carries the default `profiles:
 * undefined`, which is the same "no registry, no named law" state as a
 * workspace that declared nothing.
 *
 * @param {object} options The resolved options from `resolveCommandContext`.
 * @returns {boolean}
 */
function hasProfiles(options) {
  return typeof options?.profiles === "string" && options.profiles !== "";
}

/**
 * The boundary-policy "ladder" every command that reads a boundary law
 * shares, in the one place all of them now call it from. Hand-copied 11
 * times before this — `check`, `graph`, `diff`, `waivers`, `fitness`,
 * `impact`, `explain`, `context`, `history`'s `--capture` branch, `debt`,
 * `health` — the duplication is what let two defects land in it independently:
 * P1-25 found `graph`'s copy alone missing the inline-object arm, and P1-26
 * found only `check`'s copy aware of a `profiles` registry at all — the other
 * ten tried to resolve a profile NAME as a file, and named the wrong problem
 * when it could not: `loadBoundaryConfigFile` refuses a bare name like
 * `"strict"` as "names an unsupported boundaryConfig extension '(none)'",
 * which blames a typo that was never made rather than naming the real gap —
 * that command never knew profiles existed. One function, called from all
 * eleven sites, is what makes that defect class structurally impossible to
 * reintroduce one copy at a time.
 *
 * Checked in order, and the first match wins:
 *
 * 1. A `profiles` registry, when the workspace names one
 *    (`commandContext.options.profiles`) — `--config`, or absent that
 *    `boundaryConfig`, is then a profile NAME resolved from that registry,
 *    never a filename or an inline object at the same time
 *    (`docs/concepts/profiles.md`, "Selecting by name": the two never mix at
 *    one field).
 * 2. `--config`, a FILE path, resolved against `cwd` rather than the
 *    workspace root — the tool and the law it enforces may be in different
 *    trees, and the tree being judged is still the consumer's.
 * 3. The workspace's own `boundaryConfig`: a filename
 *    (`loadBoundaryConfig`), or — native workspaces only — the policy
 *    inline, as an object rather than a filename (`policyFrom`).
 * 4. `null`, when the workspace declares no law at all. No current provider
 *    ever reaches this arm — `boundaryConfig` always resolves to a non-empty
 *    string or a truthy inline object (`./src/options.mjs`'s
 *    `DEFAULT_OPTIONS`, `./src/providers/native/model.mjs`'s
 *    `normalizeNativeModel`) — but the guard stays rather than calling
 *    `policyFrom(undefined, ...)` unconditionally, so a future provider that
 *    leaves the option unset degrades to "no policy" instead of a crash on a
 *    value that was never validated.
 *
 * `profile`/`source` name WHICH of the four arms fired and where its bytes
 * came from — `profile` is the resolved profile name (`null` on every arm but
 * the first), `source` is always workspace-relative, the convention every
 * other file reference in a report already keeps (`sourceFile`, `tsConfig`,
 * intent's `file`). Only `check` reads either field today (P1-01, naming the
 * law that governed a run in its own report), but they are returned
 * unconditionally rather than as a second, `check`-only code path, so the
 * eleven callers keep sharing the one ladder this function exists to be.
 *
 * @param {{config: string|null}} options The command's own parsed flags —
 *   only `config` is read here, so a command with no `--config` flag at all
 *   (`graph` takes none) simply never sets it and this arm is skipped.
 * @param {object} commandContext From `resolveCommandContext` — `root` and
 *   `options` (the workspace's resolved `boundaryConfig`/`profiles`) are read.
 * @param {string} cwd The process's working directory a relative `--config`
 *   resolves against — kept separate from the workspace root for the reason
 *   above.
 * @returns {Promise<{config: {depConstraints: object[], options: object, suppressions: object[], fitness?: object[], notes?: string[]}|null, profile: string|null, source: string|null}>}
 * @throws {Error} when a named profile, a `--config` file, or an inline
 *   policy cannot be resolved or is malformed — every arm's existing failure
 *   mode, unchanged by the extraction.
 */
async function resolvePolicy(options, commandContext, cwd) {
  const { root } = commandContext;
  if (hasProfiles(commandContext.options)) {
    const profileName = String(options.config ?? commandContext.options.boundaryConfig);
    const registryPath = resolve(root, commandContext.options.profiles);
    // `profiles` is a tree-derived filename (`nx.json`/`lattice.json` options),
    // so a tracked symlink in an intermediate component of it would hand
    // outside profile rows in as the workspace's — the same read escape
    // `loadBoundaryConfig` now refuses at `loadBoundaryConfig`; held here for
    // the profiles arm (`./src/containment.mjs`, the read-side G-10 closure).
    const violation = containmentViolation(root, registryPath);
    if (violation !== null) {
      throw new Error(`lattice: cannot load ${registryPath}: ${violation}`);
    }
    const config = profilePolicy(
      registryPath,
      profileName,
      options.config ?? commandContext.options.boundaryConfig,
    );
    return { config, profile: profileName, source: relative(root, registryPath) };
  }
  if (options.config) {
    const configPath = isAbsolute(options.config) ? options.config : resolve(cwd, options.config);
    const config = await loadBoundaryConfigFile(configPath);
    return { config, profile: null, source: relative(root, configPath) };
  }
  if (typeof commandContext.options.boundaryConfig === "string") {
    const config = await loadBoundaryConfig(root, commandContext.options.boundaryConfig);
    return {
      config,
      profile: null,
      source: relative(root, resolve(root, commandContext.options.boundaryConfig)),
    };
  }
  if (commandContext.options.boundaryConfig) {
    const config = policyFrom(
      commandContext.options.boundaryConfig,
      `${LATTICE_MODEL_FILE}'s inline boundaryConfig`,
    );
    return { config, profile: null, source: LATTICE_MODEL_FILE };
  }
  return { config: null, profile: null, source: null };
}

/**
 * `graph`'s `run`: resolves the command context, drives `graphCommand`, writes
 * the report where it belongs, and returns the process's exit code.
 *
 * @param {{format: string, output: string|null, config: string|null, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, readGraph?: Function, listFiles?: Function}}} runContext
 * @returns {Promise<number>}
 */
async function runGraph(options, { cwd, env }) {
  if (options.paths.length > 0) {
    env.err(`lattice: graph takes no positional arguments; got ${options.paths.join(", ")}`);
    return EXIT.usage;
  }

  let result;
  try {
    const commandContext = resolveCommandContext(
      { cwd },
      { readGraph: env.readGraph, listFiles: env.listFiles },
    );

    // Load the boundary config when --config is given or when the workspace
    // declares one, so the snapshot carries a policy fingerprint that `diff`
    // can use to warn when the policy changed between runs. Without a config,
    // the snapshot carries no policy identity — the consumer did not provide
    // one. A profile-selected workspace's `boundaryConfig` names a profile
    // rather than a file, resolved the same way `check` resolves it
    // (`resolvePolicy`), so the fingerprint moves with a profile edit the same
    // way it already does with a file or inline-object edit.
    const { config } = await resolvePolicy(options, commandContext, cwd);

    result = graphCommand(commandContext, { config });
  } catch (error) {
    const usageError = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = report.endsWith("\n") ? report : `${report}\n`;
    // `graph` has no `--config` flag (`GRAPH_FLAG_HELP`) — there is no
    // override to pass, only the workspace's un-overridden default to guard.
    if (!writeOutputReport(options.output, reportText, env, cwd, null)) return EXIT.error;
    env.err(
      `lattice: ${result.projects.length} projects, ${result.dependencies.length} edges ` +
        `→ ${options.output}`,
    );
  } else {
    env.out(report);
  }

  // Descriptive: 0 for answered, 3 for incomplete coverage.
  return result.status === "ok" ? EXIT.ok : EXIT.error;
}

/**
 * `diff`'s `run`: resolves the command context, reads the baseline, drives
 * `diffCommand`, writes the report, and returns the exit code.
 *
 * The baseline file is the single positional argument (a file, not a git ref).
 *
 * @param {{format: string, output: string|null, config: string|null, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, readGraph?: Function, listFiles?: Function}}} runContext
 * @returns {Promise<number>}
 */
async function runDiff(options, { cwd, env }) {
  if (options.paths.length !== 1) {
    env.err(
      `lattice: diff takes exactly one positional argument (the baseline file); ` +
        `got ${options.paths.length}`,
    );
    return EXIT.usage;
  }

  const baselinePath = isAbsolute(options.paths[0])
    ? options.paths[0]
    : resolve(cwd, options.paths[0]);

  let result;
  try {
    const commandContext = resolveCommandContext(
      { cwd },
      { readGraph: env.readGraph, listFiles: env.listFiles },
    );

    // Load the boundary config when --config is given or when the workspace
    // declares one, so rule-impact analysis is computed. Without a config,
    // the diff reports only structural changes — same as before. A
    // profile-selected workspace resolves the same way `check` does
    // (`resolvePolicy`), so a policy edit under an unchanged profile NAME is
    // still visible as a fingerprint change here.
    const { config } = await resolvePolicy(options, commandContext, cwd);

    result = diffCommand(baselinePath, commandContext, { config });
  } catch (error) {
    const usageError = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = report.endsWith("\n") ? report : `${report}\n`;
    if (!writeOutputReport(options.output, reportText, env, cwd, options.config)) return EXIT.error;
    env.err(`lattice: diff complete → ${options.output}`);
  } else {
    env.out(report);
  }

  // Diff is descriptive: 0 when it completes, never 1.
  return EXIT.ok;
}

/**
 * `drift`'s `run`: resolves the command context, drives `driftCommand`, writes
 * the report where it belongs, and returns the process's exit code.
 *
 * `drift` takes no positional arguments — the observed side is the whole
 * graph, and the intended side is the tracked root `architecture-intent.json`.
 *
 * @param {{format: string, output: string|null, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, readGraph?: Function, listFiles?: Function}}} runContext
 * @returns {Promise<number>}
 */
async function runDrift(options, { cwd, env }) {
  if (options.paths.length > 0) {
    env.err(`lattice: drift takes no positional arguments; got ${options.paths.join(", ")}`);
    return EXIT.usage;
  }

  let result;
  try {
    const commandContext = resolveCommandContext(
      { cwd },
      { readGraph: env.readGraph, listFiles: env.listFiles },
    );
    // The loaded policy — profile-aware the same way `check` is
    // (`resolvePolicy`), `null` when the workspace declares none. Drift reads
    // the intent's rows, and the fitness half of a row's `decisionRef`
    // resolves against the ids THIS policy declares (F04), so the same policy
    // that made the boundary law answerable to the model must answer here.
    // `drift` has no `--config` (`DRIFT_FLAG_HELP`), so `config` is always the
    // workspace's own default — resolvePolicy reads `options.config` as the
    // override, hence `null` here, which selects the workspace's configured
    // boundary law (or a profile, when one is registered).
    //
    // The failure is DEFERRED rather than thrown here. `drift`'s only reader of
    // this policy is the non-verdict decisionRef axis, and only for rows that
    // carry one, so a workspace with an intent and no boundary config was
    // exiting 3 over a law drift would never have opened — a fifth refusal
    // neither `docs/usage/drift.md` nor `reconcile`, which makes the same four,
    // ever had. `driftCommand` rethrows it, unchanged, at the one site that
    // reads the policy, so every workspace whose intent cites anything keeps the
    // exact exit-3 it had.
    let config = null;
    let configError = null;
    try {
      ({ config } = await resolvePolicy({ ...options, config: null }, commandContext, cwd));
    } catch (error) {
      configError = /** @type {Error} */ (error);
    }
    result = await driftCommand(commandContext, { config, configError });
  } catch (error) {
    const usageError = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = report.endsWith("\n") ? report : `${report}\n`;
    // `drift` has no `--config` flag (`DRIFT_FLAG_HELP`) — there is no
    // override to pass, only the workspace's un-overridden default to guard.
    if (!writeOutputReport(options.output, reportText, env, cwd, null)) return EXIT.error;
    env.err(
      `lattice: ${result.drift.observed.projects} projects, ${result.drift.observed.edges} edges ` +
        `→ ${options.output}`,
    );
  } else {
    env.out(report);
  }

  // Drift is descriptive: 0 when the comparison completes, never 1.
  return EXIT.ok;
}

/**
 * `provenance`'s `run`: resolves the command context, drives
 * `provenanceCommand`, writes the report where it belongs, and returns the
 * process's exit code.
 *
 * Provenance reads no graph and judges nothing — it describes where the run's
 * facts came from and which governance rows carry an origin. It is
 * fail-closed the way every descriptive command is: a malformed intent or
 * boundary config throws out of `provenanceCommand` → exit 3, so "rows
 * unlisted" never reads as "rows attested".
 *
 * @param {{format: string, output: string|null, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, readGraph?: Function, listFiles?: Function}}} runContext
 * @returns {Promise<number>}
 */
async function runProvenance(options, { cwd, env }) {
  if (options.paths.length > 0) {
    env.err(`lattice: provenance takes no positional arguments; got ${options.paths.join(", ")}`);
    return EXIT.usage;
  }

  let result;
  try {
    const commandContext = resolveCommandContext(
      { cwd },
      { readGraph: env.readGraph, listFiles: env.listFiles },
    );
    result = await provenanceCommand(commandContext);
  } catch (error) {
    const usageError = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = report.endsWith("\n") ? report : `${report}\n`;
    // `provenance` has no `--config` flag (`PROVENANCE_FLAG_HELP`) — there is
    // no override to pass, only the workspace's un-overridden default to guard.
    if (!writeOutputReport(options.output, reportText, env, cwd, null)) return EXIT.error;
    env.err(`lattice: ${result.rows.length} governance rows → ${options.output}`);
  } else {
    env.out(report);
  }

  // Provenance is descriptive — it never changes a verdict, so it never exits
  // 1. 0 when it completes; failures exit 3 up in the catch above.
  return EXIT.ok;
}

/**
 * `reconcile`'s `run`: resolves the command context, drives
 * `reconcileCommand`, writes the report where it belongs, and returns the
 * process's exit code.
 *
 * `--propose` is a boolean flag (the `--capture` pattern): it adds the ranked
 * candidate list to the report and result. Reconcile takes no positional
 * arguments, it never writes into architecture-intent.json, and it is
 * descriptive — 0 when the comparison completes, never 1.
 *
 * @param {{format: string, output: string|null, propose: boolean, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, readGraph?: Function, listFiles?: Function}}} runContext
 * @returns {Promise<number>}
 */
async function runReconcile(options, { cwd, env }) {
  if (options.paths.length > 0) {
    env.err(`lattice: reconcile takes no positional arguments; got ${options.paths.join(", ")}`);
    return EXIT.usage;
  }

  let result;
  try {
    const commandContext = resolveCommandContext(
      { cwd },
      { readGraph: env.readGraph, listFiles: env.listFiles },
    );
    result = await reconcileCommand(commandContext, {}, { propose: options.propose ?? false });
  } catch (error) {
    const usageError = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = report.endsWith("\n") ? report : `${report}\n`;
    // `reconcile` has no `--config` flag (`RECONCILE_FLAG_HELP`) — there is no
    // override to pass, only the workspace's un-overridden default to guard.
    if (!writeOutputReport(options.output, reportText, env, cwd, null)) return EXIT.error;
    env.err(
      `lattice: ${result.reconcile.observed.projects} projects, ${result.reconcile.observed.edges} edges ` +
        `→ ${options.output}`,
    );
  } else {
    env.out(report);
  }

  // Reconcile is descriptive: 0 when the comparison completes, never 1.
  return EXIT.ok;
}

/**
 * `waivers`' `run`: resolves the command context, drives `waiversCommand`,
 * writes the report where it belongs, and returns the process's exit code.
 *
 * A read-only command, modeled on `runDrift`: no positional arguments, the
 * same `text|json` formats, and exit 0 whenever the surface could be read —
 * it is descriptive, never the boundary-violation exit code that is `check`'s
 * alone.
 *
 * @param {{format: string, output: string|null, config: string|null, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, readGraph?: Function, listFiles?: Function}}} runContext
 * @returns {Promise<number>}
 */
async function runWaivers(options, { cwd, env }) {
  if (options.paths.length > 0) {
    env.err(`lattice: waivers takes no positional arguments; got ${options.paths.join(", ")}`);
    return EXIT.usage;
  }

  let result;
  try {
    const commandContext = resolveCommandContext(
      { cwd },
      { readGraph: env.readGraph, listFiles: env.listFiles },
    );

    // The waivers surface is part of the run's boundary law, so the law is
    // loaded the same way `check` loads it (`resolvePolicy`) and `--config`
    // wins the same way — resolved against the working directory, never
    // against this tool's own location, and a `profiles` registry resolves
    // `--config`/`boundaryConfig` as a profile NAME the same way `check`
    // does. A malformed law throws here, exit 3, exactly as in `check`.
    const { config } = await resolvePolicy(options, commandContext, cwd);

    result = await waiversCommand(commandContext, config);
  } catch (error) {
    const usageError = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = report.endsWith("\n") ? report : `${report}\n`;
    if (!writeOutputReport(options.output, reportText, env, cwd, options.config)) return EXIT.error;
    // This clause only, not the JSON envelope: a workspace with no permanent
    // suppressions sees this stderr line unchanged from before. A reader who
    // only glances at this confirmation must not see "N waivers on the
    // table" and conclude that is the whole surface when a
    // `boundarySuppressions` row with no `expiresAt` is hiding something the
    // file --output just wrote down.
    const suppressionNote =
      result.waivers.suppressions.length > 0
        ? `, ${result.waivers.suppressions.length} permanent suppression` +
          `${result.waivers.suppressions.length === 1 ? "" : "s"}`
        : "";
    env.err(
      `lattice: ${result.waivers.waivers.length} waivers${suppressionNote} on the table ` +
        `→ ${options.output}`,
    );
  } else {
    env.out(report);
  }

  // Waivers is descriptive: 0 when the surface could be read, never 1.
  return EXIT.ok;
}

/**
 * `fitness`'s `run`: resolves the command context, drives `fitnessCommand`,
 * writes the report where it belongs, and returns the process's exit code.
 *
 * Unlike `drift`, fitness is a VERDICT: a `fail` exits 1, an `unknown` exits 3,
 * and a run where everything passed (or did not apply) exits 0. The mapping
 * sits at the tail of this function, and `../src/commands/fitness.mjs` states
 * the posture — a failing fitness function is a finding, not a print job
 * (D-09). `check` folds the same `fail` into its own exit 1 by presence, so the
 * two faces agree; `check` and `fitness` are the only verbs whose verdict
 * carries that code.
 *
 * @param {{format: string, output: string|null, config: string|null, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, readGraph?: Function, listFiles?: Function}}} runContext
 * @returns {Promise<number>}
 */
async function runFitness(options, { cwd, env }) {
  if (options.paths.length > 0) {
    env.err(`lattice: fitness takes no positional arguments; got ${options.paths.join(", ")}`);
    return EXIT.usage;
  }

  let result;
  try {
    const commandContext = resolveCommandContext(
      { cwd },
      { readGraph: env.readGraph, listFiles: env.listFiles },
    );

    // Fitness is part of the run's boundary law, so the law is loaded the same
    // way `check` loads it (`resolvePolicy`) and `--config` wins the same
    // way — resolved against the working directory, never against this
    // tool's own location, profile-aware the same way `check` is. A malformed
    // law throws here, exit 3, exactly as in `check`. A profile's `block` may
    // carry a `fitness` key (`docs/concepts/profiles.md` now names four
    // block keys, fitness among them), so a profile-selected workspace folds
    // the declared functions the same way a file-selected one does — a
    // profile that declares none reaches `fitnessCommand`'s own "declares no
    // fitness functions" refusal below rather than a config-loading failure.
    const { config } = await resolvePolicy(options, commandContext, cwd);

    result = await fitnessCommand(commandContext, { config });
  } catch (error) {
    const usageError = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = report.endsWith("\n") ? report : `${report}\n`;
    if (!writeOutputReport(options.output, reportText, env, cwd, options.config)) return EXIT.error;
    env.err(
      `lattice: ${result.fitness.functions.length} fitness function` +
        `${result.fitness.functions.length === 1 ? "" : "s"} judged (${result.fitness.verdict}) ` +
        `→ ${options.output}`,
    );
  } else {
    env.out(report);
  }

  // `fitness` is a verdict, not a print job (D-09): `fail` exits 1, `unknown`
  // exits 3, and a run that completed with everything `pass` (or not
  // applicable) exits 0. The command's own status carries the pair, and the
  // JSON envelope asserts it; this mapping is the one process-level exit.
  return (
    { ok: EXIT.ok, findings: EXIT.violations, "no-verdict": EXIT.error }[result.status] ??
    EXIT.error
  );
}

/**
 * `impact`'s `run`: resolves the command context, drives `impactCommand`,
 * writes the report where it belongs, and returns the process's exit code.
 *
 * The project name is the single positional argument.
 *
 * @param {{format: string, output: string|null, config: string|null, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, readGraph?: Function, listFiles?: Function}}} runContext
 * @returns {Promise<number>}
 */
async function runImpact(options, { cwd, env }) {
  if (options.paths.length !== 1) {
    env.err(
      `lattice: impact takes exactly one positional argument (the project name); ` +
        `got ${options.paths.length}`,
    );
    return EXIT.usage;
  }

  const projectName = options.paths[0];

  let result;
  try {
    const commandContext = resolveCommandContext(
      { cwd },
      { readGraph: env.readGraph, listFiles: env.listFiles },
    );

    // Load the boundary config when --config is given or when the workspace
    // declares one, so constraint-impact analysis is computed — profile-aware
    // the same way `check` is (`resolvePolicy`).
    const { config } = await resolvePolicy(options, commandContext, cwd);

    result = impactCommand(projectName, commandContext, config);
  } catch (error) {
    const usageError =
      /is outside the workspace/.test(error?.message ?? "") ||
      /no project named/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = report.endsWith("\n") ? report : `${report}\n`;
    if (!writeOutputReport(options.output, reportText, env, cwd, options.config)) return EXIT.error;
    env.err(
      `lattice: ${result.impact.dependents.length} project` +
        `${result.impact.dependents.length === 1 ? "" : "s"}` +
        `${result.impact.dependents.length === 1 ? " depends" : " depend"} on ${projectName} ` +
        `→ ${options.output}`,
    );
  } else {
    env.out(report);
  }

  // Impact is descriptive: 0 when it completes, never 1.
  return EXIT.ok;
}

/**
 * `explain`'s `run`: resolves the command context, loads the boundary config,
 * drives `explainCommand`, writes the report, and returns the exit code.
 *
 * The site argument is the single positional argument (a `file:line:column`
 * string). `--config` is accepted, same as `check`, because the judgment
 * depends on which boundary law is in effect.
 *
 * @param {{format: string, output: string|null, config: string|null, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, readGraph?: Function, listFiles?: Function}}} runContext
 * @returns {Promise<number>}
 */
async function runExplain(options, { cwd, env }) {
  if (options.paths.length !== 1) {
    env.err(
      `lattice: explain takes exactly one positional argument (the site <file:line:column>); ` +
        `got ${options.paths.length}`,
    );
    return EXIT.usage;
  }

  const site = options.paths[0];

  let result;
  try {
    const commandContext = resolveCommandContext(
      { cwd },
      { readGraph: env.readGraph, listFiles: env.listFiles },
    );

    // The config's location is a separate fact from the workspace root.
    // Same loading logic as `check` (`resolvePolicy`) — a `--config`
    // overrides the workspace's own `boundaryConfig`, profile-aware the same
    // way `check` is.
    const { config } = await resolvePolicy(options, commandContext, cwd);

    result = explainCommand(site, commandContext, config);
  } catch (error) {
    const usageError =
      /is outside the workspace/.test(error?.message ?? "") ||
      /is not a valid site/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = report.endsWith("\n") ? report : `${report}\n`;
    if (!writeOutputReport(options.output, reportText, env, cwd, options.config)) return EXIT.error;
    env.err(`lattice: explain complete → ${options.output}`);
  } else {
    env.out(report);
  }

  // Descriptive: 0 for answered, 3 for incomplete coverage.
  return result.status === "ok" ? EXIT.ok : EXIT.error;
}

/**
 * `context`'s `run`: resolves the command context, loads the boundary config,
 * drives `contextCommand`, writes the report, and returns the exit code.
 *
 * The project name is the single positional argument. `--config` is accepted,
 * same as `check` and `explain`, because the answer depends on which boundary
 * law is in effect.
 *
 * @param {{format: string, output: string|null, config: string|null, plan: boolean, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, readGraph?: Function, listFiles?: Function}}} runContext
 * @returns {Promise<number>}
 */
async function runContextCommand(options, { cwd, env }) {
  // Without `--plan`, context takes exactly one positional (the project name);
  // with `--plan`, the first positional is still the project name and the rest
  // are the change's scope (paths the change touches).
  if (options.paths.length === 0) {
    env.err(`lattice: context takes a project name; got none`);
    return EXIT.usage;
  }
  if (options.paths.length !== 1 && !options.plan) {
    env.err(
      `lattice: context takes exactly one positional argument (the project name); ` +
        `got ${options.paths.length}`,
    );
    return EXIT.usage;
  }

  const projectName = options.paths[0];
  const scopePaths = options.plan ? options.paths.slice(1) : [];

  let result;
  try {
    // The command context is resolved over the WHOLE workspace. Scoping by
    // path is the plan command's decision (which projects the change touches),
    // not the preamble's: the rule verdict and the architecture snapshot must
    // be over the whole tree, and only reporting is narrowed. Passing no paths
    // here keeps the non-plan `context` path byte-for-byte identical to before.
    const commandContext = resolveCommandContext(
      { cwd },
      { readGraph: env.readGraph, listFiles: env.listFiles },
    );

    // The config's location is a separate fact from the workspace root.
    // Same loading logic as `check` and `explain` (`resolvePolicy`) — a
    // `--config` overrides the workspace's own `boundaryConfig`,
    // profile-aware the same way `check` is.
    const { config } = await resolvePolicy(options, commandContext, cwd);

    result = options.plan
      ? await planContextCommand(projectName, scopePaths, commandContext, config)
      : contextCommand(projectName, commandContext, config);
  } catch (error) {
    const usageError =
      /is outside the workspace/.test(error?.message ?? "") ||
      /no project named/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = report.endsWith("\n") ? report : `${report}\n`;
    if (!writeOutputReport(options.output, reportText, env, cwd, options.config)) return EXIT.error;
    env.err(`lattice: context complete → ${options.output}`);
  } else {
    env.out(report);
  }

  // Descriptive: 0 for answered, 3 for incomplete coverage.
  return result.status === "ok" ? EXIT.ok : EXIT.error;
}

/**
 * `adr`'s `run`: reads the ADR registry at the workspace root and renders it.
 *
 * The registry lives in `docs/adr/` in the tree being described, not in this
 * package's own tree, so the root comes from the current working directory —
 * the same walking `resolveCommandContext` does, but without the whole
 * project-graph preamble. `adr` never exits 1: a description of what is
 * recorded is never a finding. An unreadable registry (a malformed record, an
 * unreadable file, a bad filename) throws → exit 3; an id the user asked
 * about that the registry does not know → exit 3, the invariant.
 *
 * The tracked-file list is read the same way every other command reads it —
 * `env.listFiles ?? listTrackedFiles`, so a test can inject a fake the same
 * way `runCheck` and its siblings do — and handed to `adrCommand` so the
 * registry resolves only git-tracked records (`src/governance/adr-registry.mjs`'s
 * header). A `git ls-files` failure here throws the same as any other
 * unreadable registry, mapped to exit 3 below.
 *
 * @param {{format: string, output: string|null, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, listFiles?: typeof listTrackedFiles}}} runContext
 * @returns {Promise<number>}
 */
async function runAdr(options, { cwd, env }) {
  if (options.paths.length > 1) {
    env.err(
      `lattice: adr takes at most one positional argument (an ADR id); ` +
        `got ${options.paths.join(", ")}`,
    );
    return EXIT.usage;
  }

  const root = resolveWorkspaceRootForUsage(cwd);
  if (root === null) {
    env.err(
      `lattice: adr needs a workspace root — no nx.json, lattice.json, or .moon marker found ` +
        `walking up from ${cwd}`,
    );
    return EXIT.error;
  }

  let result;
  try {
    const tracked = (env.listFiles ?? listTrackedFiles)(root);
    result = adrCommand(root, { id: options.paths[0] }, { tracked });
  } catch (error) {
    env.err(String(error?.message ?? error));
    return EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = report.endsWith("\n") ? report : `${report}\n`;
    // `adr` has no `--config` flag (`ADR_FLAG_HELP`) — there is no override to
    // pass, only the workspace's un-overridden default to guard.
    if (!writeOutputReport(options.output, reportText, env, cwd, null)) return EXIT.error;
    env.err(`lattice: adr complete → ${options.output}`);
  } else {
    env.out(report);
  }

  // Descriptive: 0 for answered, 3 for incomplete coverage.
  return result.status === "ok" ? EXIT.ok : EXIT.error;
}

/**
 * `history`'s `run`: resolves the command context, optionally captures a
 * snapshot of the current workspace, drives `historyCommand`, writes the
 * report, and returns the exit code.
 *
 * The history directory is the single positional argument.
 *
 * @param {{format: string, output: string|null, capture: boolean, config: string|null, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, readGraph?: Function, listFiles?: Function}}} runContext
 * @returns {Promise<number>}
 */
async function runHistory(options, { cwd, env }) {
  if (options.paths.length !== 1) {
    env.err(
      `lattice: history takes exactly one positional argument (the history directory); ` +
        `got ${options.paths.length}`,
    );
    return EXIT.usage;
  }

  const dir = isAbsolute(options.paths[0])
    ? resolve(options.paths[0])
    : resolve(cwd, options.paths[0]);

  // A self-footgun guard: writing the history report back into the very
  // directory `history` reads would poison every later run (the report envelope
  // is a `history` envelope, which `parseBaseline` refuses as a non-`graph`
  // snapshot). Refuse loudly instead of eventually failing on a poisoned dir.
  if (options.output) {
    // `resolve()` on the absolute branch too — not just the raw path — the
    // same normalization `writeOutputReport` applies, so an absolute
    // `--output` carrying a `..` segment that resolves INTO the history
    // directory cannot slip past this guard unnormalized.
    const outputAbs = isAbsolute(options.output)
      ? resolve(options.output)
      : resolve(cwd, options.output);
    if (dirname(outputAbs) === dir) {
      env.err(
        `lattice: --output '${options.output}' is inside the history directory '${dir}' — ` +
          `writing the report there would be read back as a snapshot on the next run. ` +
          `Write it somewhere else.`,
      );
      return EXIT.usage;
    }
  }

  let result;
  try {
    const commandContext = resolveCommandContext(
      { cwd },
      { readGraph: env.readGraph, listFiles: env.listFiles },
    );

    // The boundary law's fingerprint when the workspace declares one, so a
    // captured snapshot records the policy it was taken under — the same
    // config loading `graph` uses (`resolvePolicy`, profile-aware the same
    // way `check` is), kept in one place so a capture and a standalone
    // `graph` never disagree about the current policy.
    let fingerprint = null;
    if (options.capture) {
      const { config } = await resolvePolicy(options, commandContext, cwd);
      if (config) {
        fingerprint = computePolicyFingerprint(config);
      }
    }

    result = historyCommand(dir, commandContext, {
      capture: options.capture,
      policyFingerprint: fingerprint,
    });
  } catch (error) {
    const usageError = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = report.endsWith("\n") ? report : `${report}\n`;
    if (!writeOutputReport(options.output, reportText, env, cwd, options.config)) return EXIT.error;
    env.err(`lattice: history complete → ${options.output}`);
  } else {
    env.out(report);
  }

  // History is descriptive: 0 when it completes, never 1.
  return EXIT.ok;
}

/**
 * `debt`'s `run`: resolves the command context, drives `debtCommand`, writes
 * the ledger report, and returns the exit code.
 *
 * The history directory is the single positional argument — the same
 * consumer-managed directory `history` reads, so a ledger ages across the
 * same snapshots the evolution record is built from.
 *
 * @param {{format: string, output: string|null, config: string|null, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, readGraph?: Function, listFiles?: Function}}} runContext
 * @returns {Promise<number>}
 */
async function runDebt(options, { cwd, env }) {
  if (options.paths.length !== 1) {
    env.err(
      `lattice: debt takes exactly one positional argument (the history directory); ` +
        `got ${options.paths.length}`,
    );
    return EXIT.usage;
  }

  const dir = isAbsolute(options.paths[0]) ? options.paths[0] : resolve(cwd, options.paths[0]);

  let result;
  try {
    const commandContext = resolveCommandContext(
      { cwd },
      { readGraph: env.readGraph, listFiles: env.listFiles },
    );

    // The boundary law the ledger ages waivers against — resolved the same way
    // `graph` and `diff` resolve it (`resolvePolicy`), so a `debt` run and a
    // `check` run never disagree about the current suppressions, and a
    // profile-selected workspace resolves the same way `check` does.
    const { config } = await resolvePolicy(options, commandContext, cwd);

    result = await debtCommand(dir, commandContext, { config });
  } catch (error) {
    const usageError = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = report.endsWith("\n") ? report : `${report}\n`;
    if (!writeOutputReport(options.output, reportText, env, cwd, options.config)) return EXIT.error;
    env.err(
      `lattice: ${result.ledger.total} debt entr` +
        `${result.ledger.total === 1 ? "y" : "ies"} → ${options.output}`,
    );
  } else {
    env.out(report);
  }

  // Debt is descriptive: 0 when the ledger completes, never 1.
  return EXIT.ok;
}

/**
 * `discover`'s `run`: resolves the command context, drives `discoverCommand`,
 * writes the report where it belongs, and returns the process's exit code.
 *
 * `discover` takes no positional arguments — the observed side is the whole
 * graph. `--propose` is opt-in: a proposal is a suggestion, and a workspace
 * that does not ask for one must not get one.
 *
 * @param {{format: string, output: string|null, propose: boolean, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, readGraph?: Function, listFiles?: Function}}} runContext
 * @returns {Promise<number>}
 */
async function runDiscover(options, { cwd, env }) {
  if (options.paths.length > 0) {
    env.err(`lattice: discover takes no positional arguments; got ${options.paths.join(", ")}`);
    return EXIT.usage;
  }

  let result;
  try {
    const commandContext = resolveCommandContext(
      { cwd },
      { readGraph: env.readGraph, listFiles: env.listFiles },
    );

    result = discoverCommand(commandContext, { propose: options.propose });
  } catch (error) {
    const usageError = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = report.endsWith("\n") ? report : `${report}\n`;
    // `discover` has no `--config` flag (`DISCOVER_FLAG_HELP`) — there is no
    // override to pass, only the workspace's un-overridden default to guard.
    if (!writeOutputReport(options.output, reportText, env, cwd, null)) return EXIT.error;
    env.err(
      `lattice: ${result.discovery.projects.length} projects, ${result.discovery.edges.length} ` +
        `edges` +
        (result.proposal
          ? `, ${result.proposal.boundaryAssertions.total} boundary assertions`
          : "") +
        ` → ${options.output}`,
    );
  } else {
    env.out(report);
  }

  // Discover is descriptive: 0 when it completes, never 1.
  return result.status === "ok" ? EXIT.ok : EXIT.error;
}

/**
 * `health`'s `run`: resolves the command context, drives `healthCommand`,
 * writes the report where it belongs, and returns the process's exit code.
 * `health`'s `run`: resolves the command context, drives `healthCommand`,
 * writes the report where it belongs, and returns the process's exit code.
 *
 * `health` takes no positional arguments — it measures the whole workspace.
 * The snapshot directory for trends is the single optional positional
 * argument, the same directory `history` reads.
 *
 * @param {{format: string, output: string|null, config: string|null, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, readGraph?: Function, listFiles?: Function}}} runContext
 * @returns {Promise<number>}
 */
async function runHealth(options, { cwd, env }) {
  if (options.paths.length > 1) {
    env.err(
      `lattice: health takes at most one positional argument (the snapshot directory for trends); ` +
        `got ${options.paths.length}`,
    );
    return EXIT.usage;
  }

  const trendDir =
    options.paths.length === 1
      ? isAbsolute(options.paths[0])
        ? options.paths[0]
        : resolve(cwd, options.paths[0])
      : null;

  let result;
  try {
    const commandContext = resolveCommandContext(
      { cwd },
      { readGraph: env.readGraph, listFiles: env.listFiles },
    );

    // The boundary law and the intent, the same loading every command does
    // (`resolvePolicy`) — a `--config` overrides the workspace's own
    // `boundaryConfig`, profile-aware the same way `check` is, and the
    // intent is the tracked root `architecture-intent.json` (or absent).
    const { config } = await resolvePolicy(options, commandContext, cwd);

    const intent = commandContext.tracked.includes(INTENT_FILE)
      ? await loadIntent(commandContext.root, { tracked: commandContext.tracked })
      : null;

    result = healthCommand(commandContext, { config, intent, trendDir });
  } catch (error) {
    const usageError = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = report.endsWith("\n") ? report : `${report}\n`;
    if (!writeOutputReport(options.output, reportText, env, cwd, options.config)) return EXIT.error;
    env.err(`lattice: health complete → ${options.output}`);
  } else {
    env.out(report);
  }

  // Health is descriptive: 0 when it reaches a verdict, 3 when any metric
  // reads unknown (the run could not fully inspect its own evidence).
  return result.status === "ok" ? EXIT.ok : EXIT.error;
}

/**
 * `report`'s `run`: resolves the command context and the one boundary law the
 * whole document is written against, drives `reportCommand`, writes the report
 * where it belongs, and returns the process's exit code.
 *
 * The positional argument, the flags and the exit-code lane are `health`'s —
 * `report` is the same posture over a wider document: descriptive, 0 when
 * every surface reached a verdict, 3 when any did not, 2 on a usage error. It
 * never exits 1, because the commands that own a finding own its exit code
 * (`./src/commands/report.mjs` argues both halves).
 *
 * @param {{format: string, output: string|null, config: string|null, paths: string[]}} options
 * @param {{cwd: string, env: {out: Function, err: Function, readGraph?: Function, listFiles?: Function}}} runContext
 * @returns {Promise<number>}
 */
async function runReport(options, { cwd, env }) {
  if (options.paths.length > 1) {
    env.err(
      `lattice: report takes at most one positional argument (the snapshot directory for trends); ` +
        `got ${options.paths.length}`,
    );
    return EXIT.usage;
  }

  const trendDir =
    options.paths.length === 1
      ? isAbsolute(options.paths[0])
        ? options.paths[0]
        : resolve(cwd, options.paths[0])
      : null;

  let result;
  try {
    const commandContext = resolveCommandContext(
      { cwd },
      { readGraph: env.readGraph, listFiles: env.listFiles },
    );

    // ONE law for the whole document — resolved exactly the way `check` and
    // `health` resolve theirs, and handed to every surface the report
    // composes, so no two sections can cite different laws.
    const { config, source } = await resolvePolicy(options, commandContext, cwd);

    const intent = commandContext.tracked.includes(INTENT_FILE)
      ? await loadIntent(commandContext.root, { tracked: commandContext.tracked })
      : null;

    result = await reportCommand(commandContext, {
      config,
      intent,
      trendDir,
      policySource: source,
    });
  } catch (error) {
    const usageError = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    // Atomic, symlink-safe write — `writeOutputReport`'s own docstring owns
    // the mechanism and the threat it closes.
    const reportText = report.endsWith("\n") ? report : `${report}\n`;
    if (!writeOutputReport(options.output, reportText, env, cwd, options.config)) return EXIT.error;
    // The confirmation names the no-verdict case, so a reader who only
    // glances at stderr cannot mistake a written document for an established
    // one (the same reason `waivers` states its permanent-suppression count
    // on this line).
    const gaps = result.result.uninspectable.length;
    const verdict =
      gaps === 0
        ? "every surface reached a verdict"
        : `NO VERDICT — ${gaps} surface${gaps === 1 ? "" : "s"} could not be inspected`;
    env.err(`lattice: report complete (${verdict}) → ${options.output}`);
  } else {
    env.out(report);
  }

  // Descriptive: 0 when every surface reached a verdict, 3 when any evidence
  // could not be inspected. Never 1.
  return result.status === "ok" ? EXIT.ok : EXIT.error;
}

/**
 * `check`'s own flags, described once — `usage()` renders this straight into
 * the Options block, and `flags` below (what `parseArgs` needs) is derived
 * from it rather than kept as a second list that could name a flag `--help`
 * does not, or the reverse.
 *
 * @type {readonly FlagHelp[]}
 */
const CHECK_FLAG_HELP = Object.freeze([
  Object.freeze({
    flag: "--format",
    key: "format",
    arg: "text|sarif|json",
    describe: Object.freeze([
      "Terminal report (default), SARIF 2.1.0 for GitHub",
      "code scanning, or the versioned JSON envelope",
      "docs/reference/json-output.md documents",
    ]),
  }),
  Object.freeze({
    flag: "--output",
    key: "output",
    arg: "<file>",
    describe: Object.freeze(["Write the report to a file instead of stdout"]),
  }),
  Object.freeze({
    flag: "--config",
    key: "config",
    arg: "<file>",
    describe: ({ boundaryConfig, inline }) =>
      Object.freeze([
        "Read the boundary law from here instead of",
        inline ? "the inline boundaryConfig in lattice.json" : `<workspace root>/${boundaryConfig}`,
      ]),
  }),
]);

/**
 * `graph`'s flags: text or JSON envelope, optional file output.
 *
 * @type {readonly FlagHelp[]}
 */
const GRAPH_FLAG_HELP = Object.freeze([
  Object.freeze({
    flag: "--format",
    key: "format",
    arg: "text|json",
    describe: Object.freeze([
      "Terminal report (default) or the versioned JSON envelope",
      "docs/reference/json-output.md documents",
    ]),
  }),
  Object.freeze({
    flag: "--output",
    key: "output",
    arg: "<file>",
    describe: Object.freeze(["Write the report to a file instead of stdout"]),
  }),
]);

/**
 * `diff`'s flags: text or JSON envelope, optional file output.
 * The baseline file is a positional argument (a file, not a git ref).
 *
 * @type {readonly FlagHelp[]}
 */
const DIFF_FLAG_HELP = Object.freeze([
  Object.freeze({
    flag: "--format",
    key: "format",
    arg: "text|json",
    describe: Object.freeze([
      "Terminal report (default) or the versioned JSON envelope",
      "docs/reference/json-output.md documents",
    ]),
  }),
  Object.freeze({
    flag: "--output",
    key: "output",
    arg: "<file>",
    describe: Object.freeze(["Write the report to a file instead of stdout"]),
  }),
  Object.freeze({
    flag: "--config",
    key: "config",
    arg: "<file>",
    describe: Object.freeze([
      "Read the boundary law from here instead of",
      "<workspace root>/module-boundaries.config.mjs",
    ]),
  }),
]);

/**
 * `drift`'s flags: text or JSON envelope, optional file output. The intent is
 * always read from the tracked root `architecture-intent.json` — the same one
 * `check` judges — so there is no `--config` flag: a descriptive comparison
 * of the observed tree against the declared intent needs no boundary law.
 *
 * @type {readonly FlagHelp[]}
 */
const RECONCILE_FLAG_HELP = Object.freeze([
  Object.freeze({
    flag: "--format",
    key: "format",
    arg: "text|json",
    describe: Object.freeze([
      "Terminal report (default) or the versioned JSON envelope",
      "docs/reference/json-output.md documents",
    ]),
  }),
  Object.freeze({
    flag: "--output",
    key: "output",
    arg: "<file>",
    describe: Object.freeze(["Write the report to a file instead of stdout"]),
  }),
  Object.freeze({
    flag: "--propose",
    key: "propose",
    arg: "",
    describe: Object.freeze([
      "Emit a ranked candidate list of model edits,",
      "marked proposed — never written into",
      "architecture-intent.json",
    ]),
  }),
]);

/**
 * `discover`'s flags: text or JSON envelope, optional file output, and an
 * opt-in `--propose` that derives candidate architecture. `--propose` is
 * explicit because a proposal is a suggestion: a workspace that does not ask
 * for one must not get one.
 *
 * @type {readonly FlagHelp[]}
 */
const DISCOVER_FLAG_HELP = Object.freeze([
  Object.freeze({
    flag: "--propose",
    key: "propose",
    arg: "",
    describe: Object.freeze([
      "Also derive candidate components, boundaries, tags and rules from",
      "the observed facts — every candidate marked proposed and not",
      "authoritative; nothing is ever written",
    ]),
  }),
  Object.freeze({
    flag: "--format",
    key: "format",
    arg: "text|json",
    describe: Object.freeze([
      "Terminal report (default) or the versioned JSON envelope",
      "docs/reference/json-output.md documents",
    ]),
  }),
  Object.freeze({
    flag: "--output",
    key: "output",
    arg: "<file>",
    describe: Object.freeze(["Write the report to a file instead of stdout"]),
  }),
]);

const DRIFT_FLAG_HELP = Object.freeze([
  Object.freeze({
    flag: "--format",
    key: "format",
    arg: "text|json",
    describe: Object.freeze([
      "Terminal report (default) or the versioned JSON envelope",
      "docs/reference/json-output.md documents",
    ]),
  }),
  Object.freeze({
    flag: "--output",
    key: "output",
    arg: "<file>",
    describe: Object.freeze(["Write the report to a file instead of stdout"]),
  }),
]);

/**
 * `provenance`'s flags: text or JSON envelope, optional file output. The
 * command itself has no positional arguments — it reads whichever workspace
 * the working directory is inside, so there is no `--config`: the rows it
 * reports come from that workspace's OWN declared intent and boundary config,
 * and a flag overriding either would report a provenance this run never
 * judged.
 *
 * @type {readonly FlagHelp[]}
 */
const PROVENANCE_FLAG_HELP = Object.freeze([
  Object.freeze({
    flag: "--format",
    key: "format",
    arg: "text|json",
    describe: Object.freeze([
      "Terminal report (default) or the versioned JSON envelope",
      "docs/reference/json-output.md documents",
    ]),
  }),
  Object.freeze({
    flag: "--output",
    key: "output",
    arg: "<file>",
    describe: Object.freeze(["Write the report to a file instead of stdout"]),
  }),
]);

/**
 * `waivers`' flags: text or JSON envelope, and optional file output — exactly
 * the descriptive-command pair (`text|json`, no SARIF: a waivers report is a
 * surface, not a findings container). Plus `--config` in the `diff` shape:
 * the waivers surface is part of the boundary law, so the law in effect for
 * one run is the same `--config` pick that run's `check` would make — a flag
 * `drift` deliberately lacks, because no drift FINDING is decided by the
 * boundary law. Drift does read it, for one non-verdict axis only: the fitness
 * half of a row's `decisionRef` resolves against the ids that law declares
 * (`runDrift`, and `./src/commands/drift.mjs`'s header). That axis changes no
 * finding and no exit code, so there is no run whose verdict a `--config` pick
 * here could move.
 *
 * @type {readonly FlagHelp[]}
 */
const WAIVERS_FLAG_HELP = DIFF_FLAG_HELP;

/**
 * `fitness`'s flags: text or JSON envelope, optional file output, and the
 * `--config` override every policy-reading command shares.
 *
 * @type {readonly FlagHelp[]}
 */
const FITNESS_FLAG_HELP = Object.freeze([
  Object.freeze({
    flag: "--format",
    key: "format",
    arg: "text|json",
    describe: Object.freeze([
      "Terminal report (default) or the versioned JSON envelope",
      "docs/reference/json-output.md documents",
    ]),
  }),
  Object.freeze({
    flag: "--output",
    key: "output",
    arg: "<file>",
    describe: Object.freeze(["Write the report to a file instead of stdout"]),
  }),
  Object.freeze({
    flag: "--config",
    key: "config",
    arg: "<file>",
    describe: (options) => [
      "Judge the fitness declared in this file",
      `(the workspace names ${options.boundaryConfig}${
        options.inline ? " — an inline policy object" : ""
      })`,
    ],
  }),
]);

/**
 * `history`'s flags: text or JSON envelope, optional file output, and the
 * boolean `--capture` that appends a snapshot of the current workspace
 * before building the record.
 *
 * @type {readonly FlagHelp[]}
 */
const HISTORY_FLAG_HELP = Object.freeze([
  Object.freeze({
    flag: "--format",
    key: "format",
    arg: "text|json",
    describe: Object.freeze([
      "Terminal report (default) or the versioned JSON envelope",
      "docs/reference/json-output.md documents",
    ]),
  }),
  Object.freeze({
    flag: "--output",
    key: "output",
    arg: "<file>",
    describe: Object.freeze(["Write the report to a file instead of stdout"]),
  }),
  Object.freeze({
    flag: "--capture",
    key: "capture",
    arg: "",
    describe: Object.freeze([
      "Write a snapshot of the current workspace into",
      "the history directory, then build the record",
    ]),
  }),
  Object.freeze({
    flag: "--config",
    key: "config",
    arg: "<file>",
    describe: ({ boundaryConfig, inline }) =>
      Object.freeze([
        "Read the boundary law from here instead of",
        inline ? "the inline boundaryConfig in lattice.json" : `<workspace root>/${boundaryConfig}`,
      ]),
  }),
]);

/**
 * `health`'s flags: text or JSON envelope, optional file output. The optional
 * positional argument is the snapshot directory for trends, the same directory
 * `history` reads.
 *
 * @type {readonly FlagHelp[]}
 */
const HEALTH_FLAG_HELP = Object.freeze([
  Object.freeze({
    flag: "--format",
    key: "format",
    arg: "text|json",
    describe: Object.freeze([
      "Terminal report (default) or the versioned JSON envelope",
      "docs/reference/json-output.md documents",
    ]),
  }),
  Object.freeze({
    flag: "--output",
    key: "output",
    arg: "<file>",
    describe: Object.freeze(["Write the report to a file instead of stdout"]),
  }),
  Object.freeze({
    flag: "--config",
    key: "config",
    arg: "<file>",
    describe: ({ boundaryConfig, inline }) =>
      Object.freeze([
        "Read the boundary law from here instead of",
        inline ? "the inline boundaryConfig in lattice.json" : `<workspace root>/${boundaryConfig}`,
      ]),
  }),
]);

/**
 * `report`'s flags: the same three `health` takes, for the same reasons — the
 * governance document is written against one boundary law, and `--config`
 * (or a profile name, in a workspace that names a `profiles` registry) is how
 * a caller says which. The optional positional argument is the snapshot
 * directory for trends, the same directory `history` reads.
 *
 * @type {readonly FlagHelp[]}
 */
const REPORT_FLAG_HELP = Object.freeze([
  Object.freeze({
    flag: "--format",
    key: "format",
    arg: "text|json",
    describe: Object.freeze([
      "Terminal report (default) or the versioned JSON envelope",
      "docs/reference/json-output.md documents",
    ]),
  }),
  Object.freeze({
    flag: "--output",
    key: "output",
    arg: "<file>",
    describe: Object.freeze(["Write the report to a file instead of stdout"]),
  }),
  Object.freeze({
    flag: "--config",
    key: "config",
    arg: "<file>",
    describe: ({ boundaryConfig, inline }) =>
      Object.freeze([
        "Read the boundary law from here instead of",
        inline ? "the inline boundaryConfig in lattice.json" : `<workspace root>/${boundaryConfig}`,
      ]),
  }),
]);

/**
 * `debt`'s flags: text or JSON envelope, optional file output, and the same
 * `--config` the other descriptive commands take, so a ledger ages the
 * suppressions of the exact law it was run under.
 *
 * @type {readonly FlagHelp[]}
 */
const DEBT_FLAG_HELP = Object.freeze([
  Object.freeze({
    flag: "--format",
    key: "format",
    arg: "text|json",
    describe: Object.freeze([
      "Terminal report (default) or the versioned JSON envelope",
      "docs/reference/json-output.md documents",
    ]),
  }),
  Object.freeze({
    flag: "--output",
    key: "output",
    arg: "<file>",
    describe: Object.freeze(["Write the report to a file instead of stdout"]),
  }),
  Object.freeze({
    flag: "--config",
    key: "config",
    arg: "<file>",
    describe: ({ boundaryConfig, inline }) =>
      Object.freeze([
        "Read the boundary law from here instead of",
        inline ? "the inline boundaryConfig in lattice.json" : `<workspace root>/${boundaryConfig}`,
      ]),
  }),
]);

/**
 * `impact`'s flags: text or JSON envelope, optional file output.
 * The project name is a positional argument.
 *
 * @type {readonly FlagHelp[]}
 */
const IMPACT_FLAG_HELP = Object.freeze([
  Object.freeze({
    flag: "--format",
    key: "format",
    arg: "text|json",
    describe: Object.freeze([
      "Terminal report (default) or the versioned JSON envelope",
      "docs/reference/json-output.md documents",
    ]),
  }),
  Object.freeze({
    flag: "--output",
    key: "output",
    arg: "<file>",
    describe: Object.freeze(["Write the report to a file instead of stdout"]),
  }),
  Object.freeze({
    flag: "--config",
    key: "config",
    arg: "<file>",
    describe: Object.freeze([
      "Read the boundary law from here instead of",
      "<workspace root>/module-boundaries.config.mjs",
    ]),
  }),
]);

/**
 * `explain`'s flags: text or JSON envelope, optional file output.
 * The site argument is positional. `--config` overrides the boundary law,
 * same as `check`, because the judgment depends on which rules are in effect.
 *
 * @type {readonly FlagHelp[]}
 */
const EXPLAIN_FLAG_HELP = Object.freeze([
  Object.freeze({
    flag: "--format",
    key: "format",
    arg: "text|json",
    describe: Object.freeze([
      "Terminal report (default) or the versioned JSON envelope",
      "docs/reference/json-output.md documents",
    ]),
  }),
  Object.freeze({
    flag: "--output",
    key: "output",
    arg: "<file>",
    describe: Object.freeze(["Write the report to a file instead of stdout"]),
  }),
  Object.freeze({
    flag: "--config",
    key: "config",
    arg: "<file>",
    describe: ({ boundaryConfig, inline }) =>
      Object.freeze([
        "Read the boundary law from here instead of",
        inline ? "the inline boundaryConfig in lattice.json" : `<workspace root>/${boundaryConfig}`,
      ]),
  }),
]);

/**
 * `context`'s flags: text or JSON envelope, optional file output.
 * The project name is a positional argument. `--config` overrides the boundary
 * law, same as `check` and `explain`, because the answer depends on which
 * rules are in effect.
 *
 * @type {readonly FlagHelp[]}
 */
const CONTEXT_FLAG_HELP = Object.freeze([
  Object.freeze({
    flag: "--plan",
    key: "plan",
    arg: "",
    describe: Object.freeze([
      "Request the agent planning context: current",
      "architecture, applicable policy (with Intent),",
      "impact, current violations, drift, coverage, and",
      "the commands that verify the change. Trailing",
      "paths scope the change; deterministic and",
      "never an LLM plan — Lattice produces facts,",
      "agents produce plans.",
    ]),
  }),
  Object.freeze({
    flag: "--format",
    key: "format",
    arg: "text|json",
    describe: Object.freeze([
      "Terminal report (default) or the versioned JSON envelope",
      "docs/reference/json-output.md documents",
    ]),
  }),
  Object.freeze({
    flag: "--output",
    key: "output",
    arg: "<file>",
    describe: Object.freeze(["Write the report to a file instead of stdout"]),
  }),
  Object.freeze({
    flag: "--config",
    key: "config",
    arg: "<file>",
    describe: ({ boundaryConfig, inline }) =>
      Object.freeze([
        "Read the boundary law from here instead of",
        inline ? "the inline boundaryConfig in lattice.json" : `<workspace root>/${boundaryConfig}`,
      ]),
  }),
]);

/**
 * `adr`'s flags: text or JSON envelope, optional file output. The registry is
 * always read from the tracked `docs/adr/` at the workspace root — there is no
 * `--config` flag, because `adr` describes what is recorded, and a description
 * needs no boundary law.
 *
 * @type {readonly FlagHelp[]}
 */
const ADR_FLAG_HELP = Object.freeze([
  Object.freeze({
    flag: "--format",
    key: "format",
    arg: "text|json",
    describe: Object.freeze([
      "Terminal report (default) or the versioned JSON envelope",
      "docs/reference/json-output.md documents",
    ]),
  }),
  Object.freeze({
    flag: "--output",
    key: "output",
    arg: "<file>",
    describe: Object.freeze(["Write the report to a file instead of stdout"]),
  }),
]);

/**
 * The command table `usage()` and `runCli` both read from — a command added
 * later is a new entry here, not a new branch in either. `args` is the
 * placeholder `usage()` prints after the command name; `flagHelp` is the
 * source both `usage()`'s Options block and `flags` (below) render from;
 * `defaults`/`formats` are the rest of `parseArgs`'s spec; `run` is what
 * `runCli` calls once argv has been split.
 */
const COMMANDS = Object.freeze({
  check: Object.freeze({
    name: "check",
    args: "[<path>...]",
    summary: "Check imports against the boundary rules",
    flagHelp: CHECK_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(CHECK_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null, config: null }),
    formats: CHECK_FORMATS,
    run: runCheck,
  }),
  graph: Object.freeze({
    name: "graph",
    args: "",
    summary: "Print the project graph as a deterministic snapshot",
    flagHelp: GRAPH_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(GRAPH_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null }),
    formats: DESCRIBABLE_FORMATS,
    run: runGraph,
  }),
  diff: Object.freeze({
    name: "diff",
    args: "<baseline>",
    summary: "Compare two graph snapshots edge by edge",
    flagHelp: DIFF_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(DIFF_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null, config: null }),
    formats: DESCRIBABLE_FORMATS,
    run: runDiff,
  }),
  discover: Object.freeze({
    name: "discover",
    args: "[--propose]",
    summary: "Report observed facts, and optionally propose candidate architecture",
    flagHelp: DISCOVER_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(DISCOVER_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null, propose: false }),
    formats: DESCRIBABLE_FORMATS,
    booleans: Object.freeze(["propose"]),
    run: runDiscover,
  }),
  drift: Object.freeze({
    name: "drift",
    args: "",
    summary: "Compare the observed architecture against the declared intent",
    flagHelp: DRIFT_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(DRIFT_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null }),
    formats: DESCRIBABLE_FORMATS,
    run: runDrift,
  }),
  reconcile: Object.freeze({
    name: "reconcile",
    args: "",
    summary: "Compare the declared intent against the observed architecture",
    flagHelp: RECONCILE_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(RECONCILE_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null, propose: false }),
    formats: DESCRIBABLE_FORMATS,
    booleans: Object.freeze(["propose"]),
    run: runReconcile,
  }),
  waivers: Object.freeze({
    name: "waivers",
    args: "",
    summary: "List the boundary waivers and permanent suppressions on the table",
    flagHelp: WAIVERS_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(WAIVERS_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null, config: null }),
    formats: DESCRIBABLE_FORMATS,
    run: runWaivers,
  }),
  fitness: Object.freeze({
    name: "fitness",
    args: "",
    summary: "Judge every declared fitness function against the workspace",
    flagHelp: FITNESS_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(FITNESS_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null, config: null }),
    formats: DESCRIBABLE_FORMATS,
    run: runFitness,
  }),
  history: Object.freeze({
    name: "history",
    args: "<dir>",
    summary: "Describe how the architecture evolved across snapshots",
    flagHelp: HISTORY_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(HISTORY_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null, capture: false, config: null }),
    formats: DESCRIBABLE_FORMATS,
    booleans: Object.freeze(["capture"]),
    run: runHistory,
  }),
  health: Object.freeze({
    name: "health",
    args: "[<snapshot-dir>]",
    summary: "Describe architecture health metrics and trends",
    flagHelp: HEALTH_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(HEALTH_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null, config: null }),
    formats: DESCRIBABLE_FORMATS,
    run: runHealth,
  }),
  report: Object.freeze({
    name: "report",
    args: "[<snapshot-dir>]",
    summary: "One governance document: how healthy the architecture is, and why",
    flagHelp: REPORT_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(REPORT_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null, config: null }),
    formats: DESCRIBABLE_FORMATS,
    run: runReport,
  }),
  debt: Object.freeze({
    name: "debt",
    args: "<dir>",
    summary: "Print the architecture-debt ledger across snapshots",
    flagHelp: DEBT_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(DEBT_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null, config: null }),
    formats: DESCRIBABLE_FORMATS,
    run: runDebt,
  }),
  impact: Object.freeze({
    name: "impact",
    args: "<project>",
    summary: "List projects that depend on the named project",
    flagHelp: IMPACT_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(IMPACT_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null, config: null }),
    formats: DESCRIBABLE_FORMATS,
    run: runImpact,
  }),
  explain: Object.freeze({
    name: "explain",
    args: "<file:line:column>",
    summary: "Explain the judgment for one import site",
    flagHelp: EXPLAIN_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(EXPLAIN_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null, config: null }),
    formats: DESCRIBABLE_FORMATS,
    run: runExplain,
  }),
  context: Object.freeze({
    name: "context",
    args: "<project> [--plan [<path>...]]",
    summary: "Show the architecture constraints that apply to a project",
    flagHelp: CONTEXT_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(CONTEXT_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null, config: null, plan: false }),
    formats: DESCRIBABLE_FORMATS,
    booleans: Object.freeze(["plan"]),
    run: runContextCommand,
  }),
  provenance: Object.freeze({
    name: "provenance",
    args: "",
    summary: "Describe where this run's facts came from and which rows carry an origin",
    flagHelp: PROVENANCE_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(PROVENANCE_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null }),
    formats: DESCRIBABLE_FORMATS,
    run: runProvenance,
  }),
  adr: Object.freeze({
    name: "adr",
    args: "[<id>]",
    summary: "List recorded architecture decisions and what each binds",
    flagHelp: ADR_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(ADR_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null }),
    formats: DESCRIBABLE_FORMATS,
    run: runAdr,
  }),
});

/**
 * Runs the CLI and returns its exit code.
 *
 * `env` is everything the command touches outside itself: its two streams, the
 * working directory that decides which tree is judged, and the Nx and git seams
 * `check` reaches through. A test supplies all four and reads the verdict
 * without capturing a process or standing up a workspace.
 *
 * The first positional argument names a command from `COMMANDS` — UNLESS it
 * names a path that exists, in which case there was never a command word at
 * all and the whole argv is `check`'s own: `lattice <path>` runs `check`
 * scoped to it, the same as `lattice check <path>` does. That is what keeps
 * `lattice <path>...` working the way it always has, and it is why the check
 * happens before the "not a registered command" branch — an existing path is
 * a path, never an unknown command.
 *
 * @param {string[]} argv Arguments after the script name.
 * @param {{out: (text: string) => void, err: (text: string) => void, cwd?: string,
 *   readGraph?: Function, listFiles?: Function}} env
 * @returns {Promise<number>} one of `EXIT`.
 */
export async function runCli(argv, env) {
  const cwd = env.cwd ?? process.cwd();
  // Resolved lazily and only where a message needs it, so the happy path pays
  // one root-marker read and a clean run pays none.
  const help = () => usage(optionsForUsage(cwd));

  if (argv[0] === "--help" || argv[0] === "-h") {
    env.out(help());
    return EXIT.ok;
  }

  const [maybeCommand, ...maybeRest] = argv;
  let commandName;
  let rest;
  if (maybeCommand === undefined) {
    commandName = undefined;
    rest = [];
  } else if (Object.hasOwn(COMMANDS, maybeCommand)) {
    commandName = maybeCommand;
    rest = maybeRest;
  } else if (
    maybeCommand !== "" &&
    existsSync(isAbsolute(maybeCommand) ? maybeCommand : join(cwd, maybeCommand))
  ) {
    // `maybeCommand !== ""` matters because `join(cwd, "")` is `cwd` itself,
    // which always exists — an empty first argument would otherwise read as
    // "the workspace root as a path" and run a whole-workspace check instead
    // of falling through to the unknown-command refusal below, the same way
    // any other word that is neither a command nor a real path does.
    commandName = "check";
    rest = argv;
  } else {
    commandName = maybeCommand;
    rest = maybeRest;
  }

  if (commandName === undefined) {
    env.err("lattice: no command given.");
    env.err(help());
    return EXIT.usage;
  }

  // `Object.hasOwn` rather than a bare lookup: `COMMANDS[commandName]` for an
  // inherited key like `toString`, `__proto__` or `constructor` would return
  // a function or object from `Object.prototype` instead of `undefined`,
  // pass the `!command` check below, and crash on `command.run` — a
  // TypeError and exit 1, not the usage error this branch exists to give.
  const command = Object.hasOwn(COMMANDS, commandName) ? COMMANDS[commandName] : undefined;
  if (!command) {
    env.err(
      `lattice: unknown command '${commandName}'. Valid commands: ${Object.keys(COMMANDS).join(", ")}.`,
    );
    env.err(help());
    return EXIT.usage;
  }

  let options;
  try {
    options = parseArgs(rest, command);
  } catch (error) {
    env.err(`lattice: ${error.message}`);
    env.err(help());
    return EXIT.usage;
  }

  return command.run(options, { cwd, env });
}

// Run only when invoked as a program, so importing this module for its exit
// codes or `runCli` does not execute a command as a side effect. `src/entry-point.mjs`
// says why that question is asked on real paths rather than on URLs.
if (isProgramEntry(import.meta.url)) {
  process.exit(
    await runCli(process.argv.slice(2), {
      out: (text) => process.stdout.write(`${text}\n`),
      err: (text) => process.stderr.write(`${text}\n`),
    }),
  );
}

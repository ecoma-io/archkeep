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
 *   1  findings — boundary violations, go.work drift, or dead tsconfig path
 *      aliases. `check` is the only command that can produce this exit code —
 *      every other verb this table might grow only ever reads.
 *   2  usage error — unknown command, unknown flag, missing argument, path
 *      outside the tree
 *   3  no verdict — no workspace, malformed config, the graph provider or git
 *      failed, or a selected file could not be analyzed at all. Distinct from
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
 * `--format json` (`check` only, for now) wraps the same verdict in the
 * versioned envelope `src/report/json.mjs` builds — `docs/usage/json-output.md`
 * is the published contract. It changes no exit code and no byte of the text
 * or SARIF report; it is a third rendering of a verdict every other format
 * already computes.
 *
 * `COMMANDS` below is a table rather than a `switch`, and `parseArgs` is
 * shared rather than hand-rolled per command, so a second command is a new
 * row rather than a second copy of the dispatch and flag-parsing this file
 * used to own alone. The table is built for a target of five commands, not
 * because that many exist yet — `check` is still the only row — but because
 * three flags shared across all of them (`--format`, `--output`, `--config`),
 * no subcommand nesting, and no shell completion to generate mean a plain
 * table gets there without a framework; reach for one only once a later
 * command needs something this table cannot express.
 */
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { fileFailure, isWholeFileFailure } from "./src/analysis/source-util.mjs";
import { tsconfigPathsFacts } from "./src/analysis/typescript.mjs";
import { loadBoundaryConfig, loadBoundaryConfigFile, policyFrom } from "./src/config.mjs";
import { DEFAULT_OPTIONS, markersAt, resolveCommandContext } from "./src/commands/context.mjs";
import { diffCommand } from "./src/commands/diff.mjs";
import { graphCommand } from "./src/commands/graph.mjs";
import { explainCommand } from "./src/commands/explain.mjs";
import { impactCommand } from "./src/commands/impact.mjs";
import { isProgramEntry } from "./src/entry-point.mjs";
import { compareGoWork, parseGoWorkUse } from "./src/go-work.mjs";
import { NX_CONFIG_FILE, readPluginOptions } from "./src/options.mjs";
import { jsonEnvelope, renderJson } from "./src/report/json.mjs";
import { formatSarif } from "./src/report/sarif.mjs";
import { formatReport } from "./src/report/text.mjs";
import { readProjectGraph } from "./src/providers/nx.mjs";
import { LATTICE_MODEL_FILE, loadNativeModel } from "./src/providers/native/model.mjs";
import { evaluate } from "./src/rules/index.mjs";
import { judgeTsconfigPaths } from "./src/tsconfig-paths.mjs";
import { listTrackedFiles } from "./src/workspace.mjs";

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
    try {
      return readFileSync(join(root, path), "utf8");
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
 * (`docs/usage/policy-file.md`, "An inline policy, for lattice.json") — there
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
to change it through; see docs/usage/policy-file.md's "An inline policy" section.`
    : `Projects and tags come from the Nx project graph; the rules come from
${boundaryConfig} at the workspace root — the same table ESLint
reads, so both enforcers answer from one source. That filename is the Nx
convention and can be changed per workspace, through the plugin's
\`boundaryConfig\` option in nx.json.`
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
 * Walks up from `cwd` looking for either root marker — the same walk
 * `resolveCommandContext` does, duplicated here because `--help` has to work
 * with no workspace at all (returning `DEFAULT_OPTIONS`) while `check` throws
 * on exactly that condition; the two callers cannot share one function without
 * one of them losing its posture.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
function resolveWorkspaceRootForUsage(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, NX_CONFIG_FILE)) || existsSync(join(dir, LATTICE_MODEL_FILE))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
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
 * @param {{flags: Record<string,string>, defaults: object, formats?: readonly string[]}} spec
 * @returns {object} `{...spec.defaults, paths: string[]}`, with every declared
 *   flag's value substituted in.
 * @throws {Error} on an unknown flag, a missing value, or (when `spec.formats`
 *   is given) a `--format` value outside it.
 */
export function parseArgs(argv, spec) {
  const parsed = { ...spec.defaults, paths: [] };
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
 * Findings first — boundary violations, go.work drift and dead tsconfig path
 * aliases alike are verdicts, and a caller that gets `findings` knows the tree
 * is dirty whatever else the run could not reach; the report lists the
 * unreached files either way. A clean run with a file nobody could analyze is
 * the case that must not read `ok`, because `ok` is read as "checked, and
 * fine".
 *
 * @param {{violations: number, goWorkDrift: number, tsconfigPathsDead: number, unchecked: number}} counts
 * @returns {{status: "ok"|"findings"|"no-verdict", exitCode: 0|1|3}}
 */
function verdictFor({ violations, goWorkDrift, tsconfigPathsDead, unchecked }) {
  if (violations > 0 || goWorkDrift > 0 || tsconfigPathsDead > 0) {
    return { status: "findings", exitCode: EXIT.violations };
  }
  return unchecked > 0
    ? { status: "no-verdict", exitCode: EXIT.error }
    : { status: "ok", exitCode: EXIT.ok };
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
 * @returns {Promise<{report: string, violations: number, goWorkDrift: number,
 *   tsconfigPathsDead: number, analyzed: number, unchecked: number}>}
 */
export async function check(
  options,
  { cwd, readGraph = readProjectGraph, listFiles = listTrackedFiles },
) {
  const commandContext = resolveCommandContext(
    { cwd, paths: options.paths },
    { readGraph, listFiles },
  );
  const { root, graph, workspace, tracked } = commandContext;
  const { imports } = commandContext.analysis;
  const failures = [...commandContext.analysis.failures];
  const analyzed = commandContext.analysis.analyzed;

  // The config's location is a separate fact from the workspace root, which is
  // why `--config` does not move the root: pointed at a consumer's tree, the
  // tool and the law it enforces are in different trees, and the tree being
  // judged is still the consumer's. Loaded before the two workspace-level
  // checks below, the same order `check` has always used — a malformed
  // `--config` stops the run before either of them runs at all.
  //
  // Typed explicitly because the three producers below disagree: the two
  // calls into `./src/config.mjs` (`loadBoundaryConfig`/`loadBoundaryConfigFile`)
  // are typed with the optional `notes`, and the direct `policyFrom` call for
  // a native workspace's inline `boundaryConfig` is typed without it — left
  // inferred, `tsc` narrows the union to whichever arm's return type is
  // narrowest and refuses the `notes` read below on that narrower type.
  /** @type {{ depConstraints: object[], options: object, suppressions: object[], notes?: string[] }} */
  const config = options.config
    ? await loadBoundaryConfigFile(
        isAbsolute(options.config) ? options.config : resolve(cwd, options.config),
      )
    : typeof commandContext.options.boundaryConfig === "string"
      ? await loadBoundaryConfig(root, commandContext.options.boundaryConfig)
      : policyFrom(
          commandContext.options.boundaryConfig,
          `${LATTICE_MODEL_FILE}'s inline boundaryConfig`,
        );

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

  const violations = evaluate(imports, graph, config);
  const goWorkDrift = goWork === null ? 0 : goWork.findings.length;
  const tsconfigPathsDead = tsconfigPaths === null ? 0 : tsconfigPaths.findings.length;
  // Files the run produced no verdict about, counted here rather than
  // recomputed by the caller: the exit code, the text report and the JSON
  // envelope must all agree about which failures mean "not covered", and one
  // predicate is how they do.
  const unchecked = new Set(
    failures.filter(isWholeFileFailure).map((failure) => failure.sourceFile),
  ).size;
  const notes = config.notes ?? [];

  const report =
    options.format === "json"
      ? renderJson(
          jsonEnvelope({
            command: "check",
            context: {
              root,
              provider: commandContext.provider,
              marker: commandContext.marker,
            },
            ...verdictFor({
              violations: violations.length,
              goWorkDrift,
              tsconfigPathsDead,
              unchecked,
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
            },
            result: {
              violations,
              goWork: goWork === null ? null : { checked: true, findings: goWork.findings },
              tsconfigPaths:
                tsconfigPaths === null ? null : { checked: true, findings: tsconfigPaths.findings },
            },
          }),
        )
      : FORMATS[options.format]({
          violations,
          failures,
          analyzed,
          imports: imports.length,
          projects: Object.keys(graph.nodes).length,
          goWork,
          tsconfigPaths,
          // Only the ESLint boundaryConfig dialect ever produces one (see
          // `./src/eslint-config.mjs`'s `extractBoundaryRule`) — which entry it
          // bound when more than one configured the rule, or that the winning
          // entry was files-scoped under the accepted TS/JS shape. Computing it
          // and never showing it would be the silent direction with extra
          // steps, so it rides the same coverage line every other "what was
          // inspected" fact does (`src/report/text.mjs`'s `formatReport`).
          notes,
        });

  return {
    report,
    violations: violations.length,
    goWorkDrift,
    tsconfigPathsDead,
    analyzed,
    unchecked,
  };
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
    // A path outside the tree is the user's typo, everything else is the run
    // failing; the two get different codes because only one is worth retrying
    // with different arguments.
    const usageError = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  if (options.output) {
    // Written to a sibling `.tmp` file first, then renamed onto the target —
    // a rename within one directory is atomic, so a reader of `options.output`
    // (this process crashing mid-write, or a second run racing this one) sees
    // either the previous complete file or the new complete one, never a
    // truncated or half-written report. No fsync: the guarantee this buys is
    // "never a torn file", not "survives a power loss".
    const tmpOutput = `${options.output}.tmp`;
    try {
      writeFileSync(tmpOutput, result.report.endsWith("\n") ? result.report : `${result.report}\n`);
      renameSync(tmpOutput, options.output);
    } catch (cause) {
      // Best-effort cleanup so a failed write does not leave a stray `.tmp`
      // file beside the target — swallowed on purpose, since the write above
      // already failed and this is cleanup, not the operation being reported.
      try {
        unlinkSync(tmpOutput);
      } catch {
        // Nothing to clean up, or nothing this run can do about it either way.
      }
      // The report exists in memory but the consumer will never see it — that
      // is precisely a silent success if this returned 0 or 1 instead. Named
      // as a no-verdict run, the same as every other "could not complete"
      // condition this tool refuses to answer past.
      env.err(`lattice: could not write --output '${options.output}': ${cause?.message ?? cause}`);
      return EXIT.error;
    }
    // The report went to a file, so the log would otherwise say nothing at all
    // about a run that just failed the build.
    env.err(
      `lattice: ${result.violations} violation${result.violations === 1 ? "" : "s"} ` +
        `over ${result.analyzed} analyzed file${result.analyzed === 1 ? "" : "s"}` +
        (result.goWorkDrift > 0
          ? `, ${result.goWorkDrift} go.work drift finding${result.goWorkDrift === 1 ? "" : "s"}`
          : "") +
        (result.tsconfigPathsDead > 0
          ? `, ${result.tsconfigPathsDead} dead tsconfig path alias${result.tsconfigPathsDead === 1 ? "" : "es"}`
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
 * `graph`'s `run`: resolves the command context, drives `graphCommand`, writes
 * the report where it belongs, and returns the process's exit code.
 *
 * @param {{format: string, output: string|null, paths: string[]}} options
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
    result = graphCommand(commandContext);
  } catch (error) {
    const usageError = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    const tmpOutput = `${options.output}.tmp`;
    try {
      writeFileSync(tmpOutput, report.endsWith("\n") ? report : `${report}\n`);
      renameSync(tmpOutput, options.output);
    } catch (cause) {
      try {
        unlinkSync(tmpOutput);
      } catch {
        // Nothing to clean up.
      }
      env.err(`lattice: could not write --output '${options.output}': ${cause?.message ?? cause}`);
      return EXIT.error;
    }
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
 * @param {{format: string, output: string|null, paths: string[]}} options
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
    result = diffCommand(baselinePath, commandContext);
  } catch (error) {
    const usageError = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    const tmpOutput = `${options.output}.tmp`;
    try {
      writeFileSync(tmpOutput, report.endsWith("\n") ? report : `${report}\n`);
      renameSync(tmpOutput, options.output);
    } catch (cause) {
      try {
        unlinkSync(tmpOutput);
      } catch {
        // Nothing to clean up.
      }
      env.err(`lattice: could not write --output '${options.output}': ${cause?.message ?? cause}`);
      return EXIT.error;
    }
    env.err(`lattice: diff complete → ${options.output}`);
  } else {
    env.out(report);
  }

  // Diff is descriptive: 0 when it completes, never 1.
  return EXIT.ok;
}

/**
 * `impact`'s `run`: resolves the command context, drives `impactCommand`,
 * writes the report where it belongs, and returns the process's exit code.
 *
 * The project name is the single positional argument.
 *
 * @param {{format: string, output: string|null, paths: string[]}} options
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
    result = impactCommand(projectName, commandContext);
  } catch (error) {
    const usageError =
      /is outside the workspace/.test(error?.message ?? "") ||
      /no project named/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usageError ? EXIT.usage : EXIT.error;
  }

  const report = options.format === "json" ? result.report.json : result.report.text;

  if (options.output) {
    const tmpOutput = `${options.output}.tmp`;
    try {
      writeFileSync(tmpOutput, report.endsWith("\n") ? report : `${report}\n`);
      renameSync(tmpOutput, options.output);
    } catch (cause) {
      try {
        unlinkSync(tmpOutput);
      } catch {
        // Nothing to clean up.
      }
      env.err(`lattice: could not write --output '${options.output}': ${cause?.message ?? cause}`);
      return EXIT.error;
    }
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
    // Same loading logic as `check` — a `--config` overrides the workspace's
    // own `boundaryConfig`.
    /** @type {{ depConstraints: object[], options: object, suppressions: object[], notes?: string[] }} */
    const config = options.config
      ? await loadBoundaryConfigFile(
          isAbsolute(options.config) ? options.config : resolve(cwd, options.config),
        )
      : typeof commandContext.options.boundaryConfig === "string"
        ? await loadBoundaryConfig(commandContext.root, commandContext.options.boundaryConfig)
        : policyFrom(
            commandContext.options.boundaryConfig,
            `${LATTICE_MODEL_FILE}'s inline boundaryConfig`,
          );

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
    const tmpOutput = `${options.output}.tmp`;
    try {
      writeFileSync(tmpOutput, report.endsWith("\n") ? report : `${report}\n`);
      renameSync(tmpOutput, options.output);
    } catch (cause) {
      try {
        unlinkSync(tmpOutput);
      } catch {
        // Nothing to clean up.
      }
      env.err(`lattice: could not write --output '${options.output}': ${cause?.message ?? cause}`);
      return EXIT.error;
    }
    env.err(`lattice: explain complete → ${options.output}`);
  } else {
    env.out(report);
  }

  // Descriptive: 0 for answered, 3 for incomplete coverage.
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
      "docs/usage/json-output.md documents",
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
      "docs/usage/json-output.md documents",
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
      "docs/usage/json-output.md documents",
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
      "docs/usage/json-output.md documents",
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
      "docs/usage/json-output.md documents",
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
    defaults: Object.freeze({ format: "text", output: null }),
    formats: DESCRIBABLE_FORMATS,
    run: runDiff,
  }),
  impact: Object.freeze({
    name: "impact",
    args: "<project>",
    summary: "List projects that depend on the named project",
    flagHelp: IMPACT_FLAG_HELP,
    flags: Object.freeze(Object.fromEntries(IMPACT_FLAG_HELP.map((f) => [f.flag, f.key]))),
    defaults: Object.freeze({ format: "text", output: null }),
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

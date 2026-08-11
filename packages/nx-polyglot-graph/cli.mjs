#!/usr/bin/env node
/**
 * Command-line entry for the module-boundary enforcer — the surface that turns
 * a verdict into a failed build.
 *
 * `check` reads the Nx project graph, analyzes every tracked source file a
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
 * make — which tree to judge, and what the exit code means.
 *
 * Exit codes are part of the contract; a script calling this has to tell "your
 * tree is dirty" from "you typed it wrong" from "the checker itself broke":
 *   0  no violations, and every selected file was analyzed
 *   1  boundary violations found
 *   2  usage error — unknown command, missing argument, path outside the tree
 *   3  no verdict — no workspace, malformed config, `nx graph` or `git` failed,
 *      or a selected file could not be analyzed at all. Distinct from 1 on
 *      purpose: a checker that could not look must never be mistaken for one
 *      that looked and found nothing.
 *
 * That last clause is why 3 covers a partial run and not only a total one. A
 * file with no analyzer, an unreadable file, a `tsconfig` that will not load —
 * each leaves a file the summary counts but no rule ever judged, and exiting 0
 * there is precisely the mistake the code exists to prevent. An import site
 * whose specifier is not statically knowable is NOT this case: that file was
 * judged, one position in it has no answer, and `src/report/text.mjs` prints
 * the two under separate headings for the same reason they get separate codes.
 *
 * Argument parsing stays hand-rolled while there is one command, which is also
 * what keeps this package's dependency list short enough to audit; reach for a
 * framework when several commands genuinely need one.
 */
import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { isWholeFileFailure } from "./src/analysis/source-util.mjs";
import { loadBoundaryConfig, loadBoundaryConfigFile } from "./src/config.mjs";
import { isProgramEntry } from "./src/entry-point.mjs";
import { DEFAULT_OPTIONS, readPluginOptions } from "./src/options.mjs";
import { formatSarif } from "./src/report/sarif.mjs";
import { formatReport } from "./src/report/text.mjs";
import { evaluate } from "./src/rules/index.mjs";
import {
  analyzeWorkspace,
  annotateMFERemotes,
  createWorkspace,
  findWorkspaceRoot,
  listTrackedFiles,
  readProjectGraph,
  selectFiles,
} from "./src/workspace.mjs";

export const EXIT = Object.freeze({
  ok: 0,
  violations: 1,
  usage: 2,
  error: 3,
});

const FORMATS = Object.freeze({ text: formatReport, sarif: formatSarif });

/**
 * The help text, told what THIS workspace calls its boundary config.
 *
 * A function rather than a constant because the filename is a per-workspace
 * option now (`src/options.mjs`). Printing the default in a workspace that
 * renamed it would send the reader to look for a file that is not there — and
 * `--config`'s whole description is "instead of the one at the root", which
 * says nothing useful if the one at the root is misnamed in the sentence.
 *
 * @param {{boundaryConfig: string}} options
 */
const usage = ({ boundaryConfig }) =>
  `nx-polyglot-graph — module-boundary enforcement across every language in the workspace

Usage:
  nx-polyglot-graph check [<path>...]   Check imports against the boundary rules
  nx-polyglot-graph --help              Show this message

Options:
  --format text|sarif   Terminal report (default), or SARIF 2.1.0 for GitHub code scanning
  --output <file>       Write the report to a file instead of stdout
  --config <file>       Read the boundary law from here instead of
                        <workspace root>/${boundaryConfig}

Projects and tags come from the Nx project graph; the rules come from
${boundaryConfig} at the workspace root — the same table ESLint
reads, so both enforcers answer from one source. That filename is the Nx
convention and can be changed per workspace, through the plugin's
\`boundaryConfig\` option in nx.json.

Naming paths scopes the run to those files. That is a fast local pre-check and
not the gate: the cycle and lazy-load rules judge the file graph as a whole, so
a scoped run can miss what a whole-workspace run would find.

Exit codes: ${EXIT.ok} clean · ${EXIT.violations} violations found · ${EXIT.usage} usage error · ${EXIT.error} no verdict (a file could not be analyzed, or the run could not start)`;

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
    const root = findWorkspaceRoot(cwd);
    return root === null ? DEFAULT_OPTIONS : readPluginOptions(root);
  } catch {
    return DEFAULT_OPTIONS;
  }
}

/**
 * Splits `check`'s arguments into options and paths.
 *
 * Rejects an unknown `--flag` rather than treating it as a path: a typo like
 * `--fromat sarif` would otherwise be read as two paths, select no files, and
 * report a clean tree — the exact false green this tool exists to remove.
 *
 * @param {string[]} argv Arguments after `check`.
 * @returns {{format: string, output: string|null, config: string|null, paths: string[]}}
 * @throws {Error} on an unknown flag, a missing value, or an unknown format.
 */
export function parseCheckArgs(argv) {
  const parsed = { format: "text", output: null, config: null, paths: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      parsed.paths.push(arg);
      continue;
    }
    const [flag, inlineValue] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    const key = { "--format": "format", "--output": "output", "--config": "config" }[flag];
    if (!key) throw new Error(`unknown option '${flag}'`);
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`'${flag}' needs a value`);
    parsed[key] = value;
  }
  if (!(parsed.format in FORMATS)) {
    throw new Error(
      `unknown format '${parsed.format}' — expected one of ${Object.keys(FORMATS).join(", ")}`,
    );
  }
  return parsed;
}

/**
 * Runs one `check`: graph, analysis, rules, report.
 *
 * Returns the report and the counts rather than printing, so the caller owns
 * both the destination and the exit code — and so a test can read the verdict
 * without a subprocess.
 *
 * `readGraph` and `listFiles` are the two seams that reach outside this process
 * — Nx and git. Injectable for the same reason every resolver in this project
 * takes its readers: a test drives the real analysis, the real rules and the
 * real report over a fixture tree, and pins the exact `file:line:column` a
 * developer would act on, without an Nx installation or a git repository.
 *
 * @param {{format: string, config: string|null, paths: string[]}} options
 * @param {{cwd: string, readGraph?: Function, listFiles?: Function}} context
 * @returns {Promise<{report: string, violations: number, analyzed: number}>}
 */
export async function check(
  options,
  { cwd, readGraph = readProjectGraph, listFiles = listTrackedFiles },
) {
  const root = findWorkspaceRoot(cwd);
  if (root === null) {
    throw new Error(
      `nx-polyglot-graph: no Nx workspace above ${cwd} — looked for an nx.json in every parent. ` +
        `The tree to judge is found from the working directory, never from this tool's own ` +
        `location: installed from the registry, this tool lives under the consumer's ` +
        `node_modules and the two are always different trees.`,
    );
  }

  // What this workspace calls the two files whose names are conventions rather
  // than contracts. Read before the config, because it decides which config.
  const pluginOptions = readPluginOptions(root);

  // The config's location is a separate fact from the workspace root, which is
  // why `--config` does not move the root: pointed at a consumer's tree, the
  // tool and the law it enforces are in different trees, and the tree being
  // judged is still the consumer's.
  const config = options.config
    ? await loadBoundaryConfigFile(
        isAbsolute(options.config) ? options.config : resolve(cwd, options.config),
      )
    : await loadBoundaryConfig(root, pluginOptions.boundaryConfig);

  const graph = readGraph(root);
  const tracked = listFiles(root);
  const { workspace, owned } = createWorkspace({
    root,
    graph,
    files: tracked,
    tsConfig: pluginOptions.tsConfig,
  });
  // `nx graph --file=` does not carry the Module Federation fact — see
  // `annotateMFERemotes` — so it is computed here, before the rules run, or
  // every import of a real remote app would be a false `noImportsOfApps`.
  annotateMFERemotes(graph.nodes, workspace.readFile);
  const selected = selectFiles(
    owned.map(({ file }) => file),
    options.paths,
    { root, cwd },
  );

  const { imports, failures, analyzed } = analyzeWorkspace(workspace, selected);
  const violations = evaluate(imports, graph, config);
  return {
    report: FORMATS[options.format]({
      violations,
      failures,
      analyzed,
      imports: imports.length,
      projects: Object.keys(graph.nodes).length,
    }),
    violations: violations.length,
    analyzed,
    // Files the run produced no verdict about, counted here rather than
    // recomputed by the caller: the exit code and the report must agree about
    // which failures mean "not covered", and one predicate is how they do.
    unchecked: new Set(failures.filter(isWholeFileFailure).map((failure) => failure.sourceFile))
      .size,
  };
}

/**
 * Runs the CLI and returns its exit code.
 *
 * `env` is everything the command touches outside itself: its two streams, the
 * working directory that decides which tree is judged, and the Nx and git seams
 * `check` reaches through. A test supplies all four and reads the verdict
 * without capturing a process or standing up a workspace.
 *
 * @param {string[]} argv Arguments after the script name.
 * @param {{out: (text: string) => void, err: (text: string) => void, cwd?: string,
 *   readGraph?: Function, listFiles?: Function}} env
 * @returns {Promise<number>} one of `EXIT`.
 */
export async function runCli(argv, env) {
  const [command, ...rest] = argv;
  const cwd = env.cwd ?? process.cwd();
  // Resolved lazily and only where a message needs it, so the happy path pays
  // one `nx.json` read and a clean run pays none.
  const help = () => usage(optionsForUsage(cwd));

  if (command === "--help" || command === "-h") {
    env.out(help());
    return EXIT.ok;
  }

  if (command !== "check") {
    env.err(
      command === undefined
        ? "nx-polyglot-graph: no command given."
        : `nx-polyglot-graph: unknown command '${command}'.`,
    );
    env.err(help());
    return EXIT.usage;
  }

  let options;
  try {
    options = parseCheckArgs(rest);
  } catch (error) {
    env.err(`nx-polyglot-graph: ${error.message}`);
    env.err(help());
    return EXIT.usage;
  }

  let result;
  try {
    result = await check(options, {
      cwd,
      readGraph: env.readGraph,
      listFiles: env.listFiles,
    });
  } catch (error) {
    // A path outside the tree is the user's typo, everything else is the run
    // failing; the two get different codes because only one is worth retrying
    // with different arguments.
    const usage = /is outside the workspace/.test(error?.message ?? "");
    env.err(String(error?.message ?? error));
    return usage ? EXIT.usage : EXIT.error;
  }

  if (options.output) {
    writeFileSync(
      options.output,
      result.report.endsWith("\n") ? result.report : `${result.report}\n`,
    );
    // The report went to a file, so the log would otherwise say nothing at all
    // about a run that just failed the build.
    env.err(
      `nx-polyglot-graph: ${result.violations} violation${result.violations === 1 ? "" : "s"} ` +
        `over ${result.analyzed} analyzed file${result.analyzed === 1 ? "" : "s"}` +
        (result.unchecked > 0
          ? `, ${result.unchecked} file${result.unchecked === 1 ? "" : "s"} not analyzed`
          : "") +
        ` → ${options.output}`,
    );
  } else {
    env.out(result.report);
  }

  // Violations first: they are a verdict, and a caller that gets 1 knows the
  // tree is dirty whatever else the run could not reach — the report lists the
  // unreached files either way. A clean run with a file nobody could analyze is
  // the case that must not return 0, because 0 is read as "checked, and fine".
  if (result.violations > 0) return EXIT.violations;
  return result.unchecked > 0 ? EXIT.error : EXIT.ok;
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

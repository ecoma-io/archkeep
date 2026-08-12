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
 *      aliases
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
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { fileFailure, isWholeFileFailure } from "./src/analysis/source-util.mjs";
import { tsconfigPathsFacts } from "./src/analysis/typescript.mjs";
import { loadBoundaryConfig, loadBoundaryConfigFile, policyFrom } from "./src/config.mjs";
import { isProgramEntry } from "./src/entry-point.mjs";
import { compareGoWork, parseGoWorkUse } from "./src/go-work.mjs";
import { DEFAULT_OPTIONS, NX_CONFIG_FILE, readPluginOptions } from "./src/options.mjs";
import { formatSarif } from "./src/report/sarif.mjs";
import { formatReport } from "./src/report/text.mjs";
import { readProjectGraph } from "./src/providers/nx.mjs";
import { LATTICE_MODEL_FILE, loadNativeModel } from "./src/providers/native/model.mjs";
import { nativeProvider } from "./src/providers/native/index.mjs";
import { evaluate } from "./src/rules/index.mjs";
import { judgeTsconfigPaths } from "./src/tsconfig-paths.mjs";
import {
  analyzeWorkspace,
  annotateMFERemotes,
  annotatePackageFacts,
  createWorkspace,
  findWorkspaceRoot,
  listTrackedFiles,
  selectFiles,
} from "./src/workspace.mjs";

/**
 * Workspace-relative read from `root`, the same default `createWorkspace`
 * builds when no reader is injected (`./src/workspace.mjs`) — duplicated
 * rather than imported because it is needed BEFORE a graph exists to build a
 * `Workspace` from: `readWorkspaceRoot(root)` names one project model, which
 * `loadNativeModel` and `nativeProvider.discover` both need before there is
 * anything to hand `createWorkspace`.
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

/**
 * The two facts that decide which project-model provider judges a workspace:
 * does `root` carry `nx.json`, `lattice.json`, or — a state `check` refuses —
 * both.
 *
 * @param {string} root
 * @returns {{hasNx: boolean, hasNative: boolean}}
 */
function markersAt(root) {
  return {
    hasNx: existsSync(join(root, NX_CONFIG_FILE)),
    hasNative: existsSync(join(root, LATTICE_MODEL_FILE)),
  };
}

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
 * `inline` is true only for a native workspace whose `lattice.json →
 * boundaryConfig` is the policy object itself rather than a filename
 * (`docs/usage/policy-file.md`, "An inline policy, for lattice.json") — there
 * is then no file to name, no ESLint table it is shared with, and no
 * `nx.json` to change it through, so that case gets its own paragraph rather
 * than a sentence that assumes a filename exists.
 *
 * @param {{boundaryConfig: string, inline?: boolean}} options
 */
const usage = ({ boundaryConfig, inline = false }) =>
  `lattice — module-boundary enforcement across every language in the workspace

Usage:
  lattice check [<path>...]   Check imports against the boundary rules
  lattice --help              Show this message

Options:
  --format text|sarif   Terminal report (default), or SARIF 2.1.0 for GitHub code scanning
  --output <file>       Write the report to a file instead of stdout
  --config <file>       Read the boundary law from here instead of
                        ${inline ? "the inline boundaryConfig in lattice.json" : `<workspace root>/${boundaryConfig}`}

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
    const root = findWorkspaceRoot(cwd, [NX_CONFIG_FILE, LATTICE_MODEL_FILE]);
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
 * @returns {Promise<{report: string, violations: number, goWorkDrift: number,
 *   tsconfigPathsDead: number, analyzed: number, unchecked: number}>}
 */
export async function check(
  options,
  { cwd, readGraph = readProjectGraph, listFiles = listTrackedFiles },
) {
  // Both markers in one walk (`./src/workspace.mjs`'s `findWorkspaceRoot`),
  // so a native root nested under an unrelated Nx tree — or vice versa — is
  // found from the working directory the same way either alone would be.
  // Which marker(s) the returned directory actually carries is then read
  // back below, because a walk that STOPPED at the first marker it saw could
  // never tell "only lattice.json here" from "both, one level up".
  const root = findWorkspaceRoot(cwd, [NX_CONFIG_FILE, LATTICE_MODEL_FILE]);
  if (root === null) {
    throw new Error(
      `lattice: no workspace root above ${cwd} — looked for an nx.json or a lattice.json in ` +
        `every parent. The tree to judge is found from the working directory, never from this ` +
        `tool's own location: installed from the registry, this tool lives under the consumer's ` +
        `node_modules and the two are always different trees.`,
    );
  }
  const { hasNx, hasNative } = markersAt(root);
  if (hasNx && hasNative) {
    throw new Error(
      `lattice: ${root} declares both nx.json and lattice.json — this tool judges a workspace ` +
        `against exactly one project model, and a tree carrying both is a decision nobody made ` +
        `rather than one this tool can make for them. Remove whichever one is not the ` +
        `workspace's real source of truth for projects and tags.`,
    );
  }

  const tracked = listFiles(root);
  let graph;
  let workspace;
  let owned;
  let config;
  let discoveredFailures = [];
  let imports;
  let failures;
  let analyzed;

  if (hasNative) {
    // No `nx graph`, no `nx.json`, and — verified by this branch existing at
    // all — no `nx` needing to be installed: `nativeProvider` is imported
    // from `./src/providers/native/index.mjs`, which imports nothing from
    // `./src/providers/nx.mjs` and nothing that resolves the `nx` package.
    const readFile = readWorkspaceRoot(root);
    const discovered = nativeProvider.discover({ root, files: tracked, readFile });
    discoveredFailures = discovered.failures;
    // A graph with nodes but no dependencies yet — `createWorkspace` only
    // ever reads `data.root` off each node, and dependencies are not known
    // until the import sites below are analyzed against these same projects.
    const preGraph = {
      nodes: Object.fromEntries(
        discovered.projects.map((project) => [
          project.name,
          { name: project.name, data: { root: project.root } },
        ]),
      ),
    };
    ({ workspace, owned } = createWorkspace({
      root,
      graph: preGraph,
      files: tracked,
      tsConfig: discovered.model.tsConfig,
    }));

    // Spec §3.5's order, and why it is not the Nx path's order: on the Nx
    // path `graph.dependencies` comes from `nx graph`, computed over the
    // WHOLE workspace regardless of `--paths`, so scoping only ever narrows
    // which import sites are handed to `evaluate()` for reporting. The
    // native path has no such independent source — `buildNativeGraph` (via
    // `nativeProvider.buildGraph`) DERIVES `dependencies` from import sites —
    // so analyzing only the requested scope first would drop every project
    // outside it from the dependency graph itself, and a cycle or a
    // transitive violation that only closes once the rest of the tree's
    // imports are counted would go unreported. Every owned file is analyzed
    // here, unconditionally; `selected` below only filters which of the
    // resulting sites are reported on.
    const wholeTreeAnalysis = analyzeWorkspace(
      workspace,
      owned.map(({ file }) => file),
    );
    graph = nativeProvider.buildGraph({
      discovered,
      importSites: wholeTreeAnalysis.imports,
    });
    annotateMFERemotes(graph.nodes, workspace.readFile);
    annotatePackageFacts(graph.nodes, workspace.readFile);
    // `discovered.model.boundaryConfig` is either a filename (the common
    // case, loaded below exactly like the Nx path loads one) or an inline
    // policy object — `docs/usage/lattice-json.md`'s second accepted shape
    // for the field. An inline object needs no separate load: `loadNativeModel`
    // already ran it through `findBoundaryConfigViolations`
    // (`./src/providers/native/model.mjs`) before `discover()` could return
    // it, so the call below re-runs that same check (cheap, and the one
    // place this reshape happens — `./src/config.mjs`'s `policyFrom`) rather
    // than reshaping the three keys here by hand, which is what silently
    // skipped validation on this branch before `policyFrom` existed.
    config = options.config
      ? await loadBoundaryConfigFile(
          isAbsolute(options.config) ? options.config : resolve(cwd, options.config),
        )
      : typeof discovered.model.boundaryConfig === "string"
        ? await loadBoundaryConfig(root, discovered.model.boundaryConfig)
        : policyFrom(
            discovered.model.boundaryConfig,
            `${LATTICE_MODEL_FILE}'s inline boundaryConfig`,
          );

    const selected = selectFiles(
      owned.map(({ file }) => file),
      options.paths,
      { root, cwd },
    );
    const selectedFiles = new Set(selected);
    imports = wholeTreeAnalysis.imports.filter((site) => selectedFiles.has(site.sourceFile));
    failures = wholeTreeAnalysis.failures.filter((failure) =>
      selectedFiles.has(failure.sourceFile),
    );
    analyzed = wholeTreeAnalysis.analyzedFiles.filter((file) => selectedFiles.has(file)).length;
  } else {
    // What this workspace calls the two files whose names are conventions
    // rather than contracts. Read before the config, because it decides
    // which config.
    const pluginOptions = readPluginOptions(root);

    graph = readGraph(root);
    ({ workspace, owned } = createWorkspace({
      root,
      graph,
      files: tracked,
      tsConfig: pluginOptions.tsConfig,
    }));
    // `nx graph --file=` does not carry the Module Federation fact — see
    // `annotateMFERemotes` — so it is computed here, before the rules run, or
    // every import of a real remote app would be a false `noImportsOfApps`.
    annotateMFERemotes(graph.nodes, workspace.readFile);
    // Nor the two `package.json` facts — `data.entryPoints` and
    // `data.declaredPackages`, see `annotatePackageFacts` — which decide the
    // secondary-entry-point exemptions and `noTransitiveDependencies`.
    annotatePackageFacts(graph.nodes, workspace.readFile);
    const selected = selectFiles(
      owned.map(({ file }) => file),
      options.paths,
      { root, cwd },
    );

    // The config's location is a separate fact from the workspace root,
    // which is why `--config` does not move the root: pointed at a
    // consumer's tree, the tool and the law it enforces are in different
    // trees, and the tree being judged is still the consumer's.
    config = options.config
      ? await loadBoundaryConfigFile(
          isAbsolute(options.config) ? options.config : resolve(cwd, options.config),
        )
      : await loadBoundaryConfig(root, pluginOptions.boundaryConfig);

    ({ imports, failures, analyzed } = analyzeWorkspace(workspace, selected));
  }

  // Unclaimed analyzable files — a native-only fact; the Nx path
  // (`./src/providers/nx.mjs`, `./src/workspace.mjs`) has no unclaimed-file
  // check of its own, per `./src/providers/native/coverage.mjs`'s header —
  // become the SAME whole-file `fileFailure` shape a language analyzer
  // produces for an unreadable file, so nothing downstream needs to know
  // which provider found the gap.
  failures.push(...discoveredFailures);

  // The go.work drift check, keyed off the manifest's presence the way every
  // resolver keys off its language's manifest: no tracked root go.work, no
  // check and no mention. It ignores `selected` on purpose — two workspace
  // facts are compared, not files analyzed — and a go.work the parser cannot
  // read becomes a whole-file failure (exit 3) rather than a truncated use
  // list, because a use list cut short at the malformed line would hide every
  // stale entry below it while inventing missing-use findings above it — a
  // verdict about a file that was never read (`src/go-work.mjs`).
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
  // rule and its limits). Like go.work, `selected` is ignored on purpose: a
  // workspace fact is judged, not files analyzed.
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
  return {
    report: FORMATS[options.format]({
      violations,
      failures,
      analyzed,
      imports: imports.length,
      projects: Object.keys(graph.nodes).length,
      goWork,
      tsconfigPaths,
    }),
    violations: violations.length,
    goWorkDrift: goWork === null ? 0 : goWork.findings.length,
    tsconfigPathsDead: tsconfigPaths === null ? 0 : tsconfigPaths.findings.length,
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
        ? "lattice: no command given."
        : `lattice: unknown command '${command}'.`,
    );
    env.err(help());
    return EXIT.usage;
  }

  let options;
  try {
    options = parseCheckArgs(rest);
  } catch (error) {
    env.err(`lattice: ${error.message}`);
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

  // Findings first — boundary violations, go.work drift and dead tsconfig
  // path aliases alike are verdicts, and a caller that gets 1 knows the tree
  // is dirty whatever else the run could not reach; the report lists the
  // unreached files either way. A clean run with a file nobody could analyze
  // is the case that must not return 0, because 0 is read as "checked, and
  // fine".
  if (result.violations > 0 || result.goWorkDrift > 0 || result.tsconfigPathsDead > 0) {
    return EXIT.violations;
  }
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

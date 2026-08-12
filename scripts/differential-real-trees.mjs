#!/usr/bin/env node
// Runs the conformance differential — this repository's boundary engine against
// the real `@nx/enforce-module-boundaries` — over REAL public Nx workspaces,
// pinned at fixed commits. The fixture suite in
// `packages/lattice/src/conformance/` proves the two engines agree
// about the situations someone thought to build; this script is the third
// condition its README names: agreement measured on trees nobody here built,
// under constraint tables and tag vocabularies this repository had no hand in.
//
// What one tree run does, in order, each step loud on failure:
//
//   1. shallow-clones the repository at its PINNED commit (`git fetch --depth 1
//      <url> <sha>`), and verifies `git rev-parse HEAD` answers that exact sha;
//   2. installs its dependencies with the tree's own lockfile (per-tree command
//      in the table below, with the measured reason where `npm ci` refuses);
//   3. computes the project graph with the TREE'S OWN nx (`node_modules/.bin/nx
//      graph --file=`), so the nodes and tags are what that workspace's Nx
//      actually reports, not a reconstruction;
//   4. spawns one child process per tree (`differential-real-trees-child.mjs` —
//      its header says why a process boundary is required) which runs BOTH
//      engines over every tracked file and compares verdicts per file;
//   5. classifies every difference against the ledger below, and checks the
//      empty-verdict claim for trees measured to contain violations.
//
// Exit codes mirror `packages/lattice/cli.mjs`: 0 clean, 1 findings
// (an unexplained difference, a stale ledger entry, or an empty verdict set
// where violations are known to exist), 2 usage, 3 infrastructure (clone,
// install, graph or child failure — a run that could not look must never read
// as a run that looked and found agreement).
//
// Nothing is cached between runs, deliberately. A fresh clone at a pinned sha
// costs seconds and cannot be stale; the installs cost a few minutes weekly.
// A cached tree or node_modules that silently survived a lockfile change would
// make the run test yesterday's inputs while printing today's shas — the exact
// false comfort a differential exists to refuse.
//
// This script runs from `.github/workflows/differential.yml` (scheduled +
// manual, NOT part of ci-gate — that file's header carries the argument), and
// locally as `node scripts/differential-real-trees.mjs`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import { environmentForTree } from "../packages/lattice/src/workspace.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Same meanings as the CLI's exit contract (`packages/lattice/cli.mjs`). */
export const EXIT = Object.freeze({ ok: 0, findings: 1, usage: 2, error: 3 });

/**
 * The real workspaces the differential runs against. Every entry is a public
 * repository under MIT or Apache-2.0, pinned to one commit, with a non-trivial
 * `depConstraints` table of its own — a tree whose only constraint row is
 * `*` → `*` would let both engines agree by having nothing to decide.
 *
 * How these two were found, and what was rejected, measured 2026-08-11 via
 * GitHub code search (`gh search code`) for `depConstraints` and for the
 * plugins that would mark a polyglot tree (`@naxodev/gonx`, `@monodon/rust`,
 * `@nxlv/python`, `@nx/vue` in `nx.json`):
 *
 * - nrwl/nx-examples — no license file, so its code cannot be pulled into a
 *   differential run here;
 * - nuclia/frontend, OpenAPITools/openapi-generator-cli — constraint table is
 *   the trivial `*` → `*`;
 * - nrwl/nx-console — a real table, but its graph needs a JDK (gradle plugin)
 *   plus `@nx/enterprise-cloud`, and most projects are `package.json`-based;
 *   rejected as unrunnable without a toolchain this harness must not require;
 * - codyslexia/nexa (Go), KBVE/kbve (Rust) — the only polyglot candidates that
 *   configure `depConstraints` at all; both tables are `*` → `*` and neither
 *   repository declares an OSI license. So: no qualifying real Go, Rust or
 *   Python Nx tree exists as of 2026-08-11, and no Vue one either
 *   (PWNDAO/pwn-sdks has a table but is GPL-3.0). The real-tree differential
 *   covers TypeScript and JavaScript for now, which is also the whole surface
 *   upstream can read — `.go`, `.rs` and `.py` files never reach the upstream
 *   rule, so a polyglot tree would widen this comparison by nothing until one
 *   with a real constraint table exists.
 *
 * `expectViolations` records a MEASURED fact about the pinned commit, not a
 * hope: linting every tracked file surfaces violations both trees' own
 * narrower lint setups do not run over (code-pushup's e2e mock fixtures cross
 * its `type:e2e` constraints — 25 verdicts; ng-doc's per-project
 * `eslint.config.mjs` files import the root config relatively across project
 * boundaries — 8 verdicts). A tree measured to contain violations where either
 * engine answers zero is a broken engine, not a clean tree.
 */
export const TREES = Object.freeze([
  {
    name: "code-pushup",
    url: "https://github.com/code-pushup/cli.git",
    sha: "ba41f9297e70d2f5ffdcd61f0138e5f150415859",
    license: "MIT",
    configFile: "eslint.config.js",
    // `npm ci` refuses this tree outright — its committed package-lock.json is
    // internally inconsistent (misses nice-napi@1.0.2 and node-addon-api@3.2.1,
    // measured at the pinned sha). `npm install` keeps every present entry at
    // its locked version and resolves only those two optional gaps.
    install: ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"],
    expectViolations: true,
  },
  {
    name: "ng-doc",
    url: "https://github.com/ng-doc/ng-doc.git",
    sha: "b595004d8925b5c93ae56f82a6439cd10e5de0cb",
    license: "MIT",
    configFile: "eslint.config.mjs",
    install: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    expectViolations: true,
  },
]);

/**
 * Explained differences between the two engines on the trees above — the same
 * held-from-both-sides shape as the fixture suite's deliberately-stricter
 * table. An entry explains a difference (`tree`, `direction`, `messageId`, and
 * a `sitePattern` regular expression the difference's `file:line:column` site
 * must match) and carries the reason a human accepted it. A difference no
 * entry explains fails the run; an entry no difference fires is stale and
 * fails the run too, because a ledger that outlives its difference is a
 * documented divergence that quietly stopped being checked.
 *
 * Empty as of the pinned shas: both engines report identical verdict sets on
 * both trees (25 + 8 verdicts, zero differences, measured 2026-08-11).
 */
export const LEDGER = Object.freeze([
  // { tree: "…", direction: "stricter"|"weaker", messageId: "…",
  //   sitePattern: "^…", reason: "…" }
]);

/**
 * Reads the `@nx/enforce-module-boundaries` entry off a tree's own flat ESLint
 * config, exactly as ESLint would bind it: the LAST entry that configures the
 * rule wins. Pure — the caller imports the config file and hands the array in.
 *
 * @param {object[]} flatConfig The tree's flat-config array.
 * @returns {{depConstraints: object[], options: object}} The constraint table
 *   and the remaining rule options, still the tree's own spelling.
 */
export function extractBoundaryRule(flatConfig) {
  if (!Array.isArray(flatConfig)) {
    throw new Error(
      "differential-real-trees: the tree's ESLint config default export is not a flat-config " +
        "array, so the boundary options cannot be read from it.",
    );
  }
  let entry;
  for (const item of flatConfig) {
    const value = item?.rules?.["@nx/enforce-module-boundaries"];
    if (value !== undefined) entry = value;
  }
  if (entry === undefined) {
    throw new Error(
      "differential-real-trees: no @nx/enforce-module-boundaries entry in the tree's ESLint " +
        "config — the tree no longer qualifies for this differential.",
    );
  }
  if (!Array.isArray(entry) || entry[0] === "off" || entry[0] === 0) {
    throw new Error(
      "differential-real-trees: the tree configures @nx/enforce-module-boundaries as " +
        `${JSON.stringify(entry)} — switched off or without options, there is no constraint ` +
        "table to compare against.",
    );
  }
  const { depConstraints = [], ...options } = entry[1] ?? {};
  return { depConstraints, options };
}

/**
 * Splits a tree's differences into explained (a ledger entry covers it),
 * unexplained (nothing does — a finding), and stale ledger entries (they cover
 * nothing that fired — also a finding, from the other side).
 *
 * @param {string} treeName
 * @param {{direction: string, messageId: string, site: string}[]} differences
 * @param {readonly object[]} ledger
 * @returns {{explained: object[], unexplained: object[], stale: object[]}}
 */
export function classifyDifferences(treeName, differences, ledger) {
  const entries = ledger.filter((entry) => entry.tree === treeName);
  const fired = new Set();
  const explained = [];
  const unexplained = [];
  for (const difference of differences) {
    const entry = entries.find(
      (candidate) =>
        candidate.direction === difference.direction &&
        candidate.messageId === difference.messageId &&
        new RegExp(candidate.sitePattern, "u").test(difference.site),
    );
    if (entry) {
      fired.add(entry);
      explained.push({ difference, entry });
    } else {
      unexplained.push(difference);
    }
  }
  return { explained, unexplained, stale: entries.filter((entry) => !fired.has(entry)) };
}

/**
 * The empty-verdict claim, checked. On a tree measured to contain violations,
 * an engine answering zero has not found a clean tree — it has stopped
 * looking, and two engines both answering zero would otherwise count as
 * perfect agreement. Each breach names the engine that went silent.
 *
 * @param {{name: string, sha: string, expectViolations: boolean}} tree
 * @param {{upstream: number, tool: number}} verdictCounts
 * @returns {string[]}
 */
export function emptyVerdictBreaches(tree, verdictCounts) {
  if (!tree.expectViolations) return [];
  const breaches = [];
  for (const [engine, count] of Object.entries(verdictCounts)) {
    if (count === 0) {
      breaches.push(
        `${tree.name}: ${engine} reported ZERO verdicts on a tree measured to contain ` +
          `violations at ${tree.sha} — that is a silent engine, not a clean tree.`,
      );
    }
  }
  return breaches;
}

/**
 * One tree's outcome, reduced to the three states the exit code can express.
 *
 * @param {{infrastructure?: string, unexplained: object[], stale: object[],
 *   breaches: string[]}} outcome
 * @returns {"infrastructure"|"findings"|"ok"}
 */
export function treeVerdict({ infrastructure, unexplained, stale, breaches }) {
  if (infrastructure) return "infrastructure";
  if (unexplained.length > 0 || stale.length > 0 || breaches.length > 0) return "findings";
  return "ok";
}

/**
 * The whole run's exit code. Infrastructure outranks findings: when any tree
 * could not be looked at, the run's verdict is incomplete and must not read as
 * "looked everywhere, found these findings".
 *
 * @param {("infrastructure"|"findings"|"ok")[]} verdicts
 * @returns {number}
 */
export function overallExit(verdicts) {
  if (verdicts.includes("infrastructure")) return EXIT.error;
  if (verdicts.includes("findings")) return EXIT.findings;
  return EXIT.ok;
}

/** An infrastructure-class failure: the run could not look, distinct from a finding. */
class InfrastructureError extends Error {}

/**
 * Runs a child process from an ARGUMENT ARRAY (`AGENTS.md`'s child-process
 * rule; nothing here is interpolated into a shell) with output passed through,
 * and throws the infrastructure class on any non-zero exit.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {string} cwd
 * @param {Record<string, string|undefined>} [extraEnv]
 */
function run(file, args, cwd, extraEnv = {}) {
  const result = spawnSync(file, args, {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...environmentForTree(process.env), ...extraEnv },
  });
  if (result.error) {
    throw new InfrastructureError(`${file} ${args.join(" ")}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new InfrastructureError(`${file} ${args.join(" ")} exited ${result.status}`);
  }
}

/** Like `run`, but captures stdout for a value the caller checks. */
function capture(file, args, cwd) {
  const result = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    env: environmentForTree(process.env),
  });
  if (result.error || result.status !== 0) {
    throw new InfrastructureError(
      `${file} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/**
 * Clones, installs and measures one tree; returns the child's report plus the
 * clone directory (kept on failure so the evidence is inspectable).
 *
 * @param {(typeof TREES)[number]} tree
 * @param {string} workdir Empty directory this run owns.
 * @returns {object} The child process's JSON report.
 */
function measureTree(tree, workdir) {
  const treeRoot = join(workdir, "tree");
  const graphPath = join(workdir, "graph.json");
  const resultPath = join(workdir, "result.json");

  console.log(`\n=== ${tree.name} — ${tree.url} @ ${tree.sha} (${tree.license}) ===`);
  run("git", ["init", "--quiet", treeRoot], workdir);
  run("git", ["fetch", "--quiet", "--depth", "1", tree.url, tree.sha], treeRoot);
  run("git", ["checkout", "--quiet", "--detach", tree.sha], treeRoot);
  const head = capture("git", ["rev-parse", "HEAD"], treeRoot);
  if (head !== tree.sha) {
    throw new InfrastructureError(`${tree.name}: cloned HEAD is ${head}, pinned sha ${tree.sha}`);
  }
  console.log(`cloned at ${head}`);

  console.log(`installing: ${tree.install.join(" ")}`);
  run(tree.install[0], tree.install.slice(1), treeRoot);

  const nxBin = join(treeRoot, "node_modules", ".bin", "nx");
  if (!existsSync(nxBin)) {
    throw new InfrastructureError(`${tree.name}: install produced no node_modules/.bin/nx`);
  }
  // The tree's own nx computes the graph. `--file=` writes OUTSIDE the clone so
  // the graph JSON can never appear in the tree's own file listing.
  run(process.execPath, [nxBin, "graph", `--file=${graphPath}`], treeRoot, {
    NX_DAEMON: "false",
  });
  if (!existsSync(graphPath)) {
    throw new InfrastructureError(`${tree.name}: nx graph exited 0 but wrote no ${graphPath}`);
  }

  run(
    process.execPath,
    [
      join(repoRoot, "scripts", "differential-real-trees-child.mjs"),
      treeRoot,
      tree.configFile,
      graphPath,
      resultPath,
    ],
    treeRoot,
    { NX_WORKSPACE_ROOT_PATH: treeRoot, NX_DAEMON: "false" },
  );
  if (!existsSync(resultPath)) {
    throw new InfrastructureError(`${tree.name}: the engine child exited 0 but wrote no report`);
  }
  return JSON.parse(readFileSync(resultPath, "utf8"));
}

/** Prints one tree's report and returns its outcome for the exit decision. */
function reportTree(tree, result) {
  const { counts, versions, differences, agreements } = result;
  console.log(
    `files: ${counts.tracked} tracked, ${counts.owned} owned by projects, ` +
      `${counts.analyzed} analyzed by this engine, ${counts.upstreamReadable} linted by upstream`,
  );
  console.log(
    `engines: @nx/eslint-plugin ${versions.plugin}, eslint ${versions.eslint}, ` +
      `node ${versions.node} (all pinned by this repository's lockfile)`,
  );
  console.log(
    `verdicts: upstream ${counts.upstreamVerdicts}, this engine ${counts.toolVerdicts}, ` +
      `agreeing ${agreements}`,
  );
  if (counts.analysisFailures > 0) {
    console.log(
      `analysis failures (this engine's could-not-look records, not verdicts): ` +
        `${counts.analysisFailures} — e.g. ${result.analysisFailureSample.join("; ")}`,
    );
  }
  // Every upstream verdict, so a reader can see WHAT agreed rather than only
  // how much; any verdict the engines disagree on reappears in the difference
  // lines below.
  for (const verdict of result.upstreamVerdicts) {
    console.log(`  upstream verdict ${verdict.messageId} @ ${verdict.site}`);
  }

  const { explained, unexplained, stale } = classifyDifferences(tree.name, differences, LEDGER);
  const breaches = emptyVerdictBreaches(tree, {
    upstream: counts.upstreamVerdicts,
    tool: counts.toolVerdicts,
  });
  for (const { difference, entry } of explained) {
    console.log(`explained ${difference.direction} ${difference.messageId} @ ${difference.site}`);
    console.log(`  ledger: ${entry.reason}`);
  }
  for (const difference of unexplained) {
    console.log(`UNEXPLAINED ${difference.direction} ${difference.messageId} @ ${difference.site}`);
    if (difference.detail) console.log(`  ${difference.detail}`);
  }
  for (const entry of stale) {
    console.log(
      `STALE ledger entry: ${entry.direction} ${entry.messageId} ${entry.sitePattern} no ` +
        `longer fires — remove it or say what changed.`,
    );
  }
  for (const breach of breaches) console.log(`EMPTY-VERDICT BREACH: ${breach}`);
  return { unexplained, stale, breaches };
}

function main() {
  if (process.argv.length > 2) {
    console.error("usage: node scripts/differential-real-trees.mjs (no arguments)");
    process.exit(EXIT.usage);
  }

  /** @type {("infrastructure"|"findings"|"ok")[]} */
  const verdicts = [];
  for (const tree of TREES) {
    const workdir = mkdtempSync(join(tmpdir(), `lattice-differential-${tree.name}-`));
    let outcome;
    try {
      const result = measureTree(tree, workdir);
      outcome = { infrastructure: undefined, ...reportTree(tree, result) };
      rmSync(workdir, { recursive: true, force: true });
    } catch (error) {
      // Any throw here means the run could not LOOK — clone, install, graph or
      // child failure — which must stay distinct from a difference between
      // engines. The clone is kept for inspection.
      outcome = {
        infrastructure: String(error?.message ?? error),
        unexplained: [],
        stale: [],
        breaches: [],
      };
      console.error(`INFRASTRUCTURE FAILURE for ${tree.name}: ${outcome.infrastructure}`);
      console.error(`clone kept at ${workdir}`);
    }
    verdicts.push(treeVerdict(outcome));
    console.log(`${tree.name}: ${verdicts.at(-1)}`);
  }

  const exit = overallExit(verdicts);
  console.log(
    `\ndifferential over ${TREES.length} real trees: ` +
      (exit === EXIT.ok
        ? "both engines agree everywhere the ledger does not already explain"
        : exit === EXIT.findings
          ? "FINDINGS — see UNEXPLAINED / STALE / EMPTY-VERDICT lines above"
          : "INCOMPLETE — at least one tree could not be measured"),
  );
  process.exit(exit);
}

/**
 * Run-vs-import guard, compared on real paths for the reason
 * `scripts/check-packages.mjs` documents on its own copy: through a symlinked
 * checkout the naive comparison is false and `main()` silently never runs.
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) main();

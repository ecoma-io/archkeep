#!/usr/bin/env node
// What the Go, Rust and Python analyzers actually read, on real repositories.
//
// `differential-real-trees.mjs` puts this engine's verdict beside real ESLint's
// on real public workspaces. It structurally cannot cover the three languages
// this tool exists for: `.go`, `.rs` and `.py` never reach the upstream rule,
// so upstream's silence is inability rather than a verdict, and there is no
// oracle to disagree with. Its own tree table records the second half of the
// problem — as of the day it was written, no public Nx workspace with a
// non-trivial constraint table and an OSI license was polyglot at all.
//
// So the question this lane asks is a different one, and it needs no oracle:
// **over thousands of files nobody here wrote, how much does each analyzer
// read, and how much does it report it could not?** Both numbers are pinned at
// a fixed commit, held EXACTLY in both directions:
//
//   - fewer records than pinned is an analyzer that went quiet on a syntax it
//     used to read — the silent direction, and the reason this lane exists;
//   - more is a change nobody measured, which is the same event seen from the
//     other side and equally worth a human deciding about;
//   - fewer FAILURES than pinned is not automatically good either: a failure
//     that stopped being reported is a file that now looks read.
//
// A pinned sha is what makes exactness legitimate. The tree cannot move under
// the harness, so any movement IS the harness changing.
//
// ## What this lane is not
//
// It is not a check of whether the verdicts are right — nothing here judges a
// boundary, and these repositories declare no architecture for this tool to
// enforce. It measures reading, not judging. A repository running `check` as a
// blocking gate is a different condition entirely
// (`docs/doctrine/roadmap.md`), and this lane does not stand in for it.
//
// It is also NOT a required check, for the reason `differential.yml`'s header
// argues at length about its own lane: it depends on third-party repositories
// being reachable, and gating every pull request on that is how a measurement
// lane gets deleted. It runs on the same weekly schedule, and a red run is a
// regression to be fixed rather than a flake to re-run.
//
// ## The facts come in as arguments
//
// `evaluate` takes measurements and returns breaches; only `measureTree`
// touches the network and the disk. That is why `coverage-real-trees.test.mjs`
// needs no clone — the same split `../AGENTS.md` states for the gate scripts.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeFile } from "../packages/lattice/src/analysis/analyze.mjs";

/**
 * The trees, pinned. Every entry is a public repository under a permissive
 * OSI license, at one commit, in one of the three languages the differential
 * cannot reach.
 *
 * The counts are MEASURED facts about the pinned commit — taken by running
 * this script's own reader on 2026-08-22 — not targets anybody chose. Each
 * tree names why its `unreadable` count is what it is, because an unexplained
 * failure count is a number nobody can act on:
 *
 * - **gin** reads clean: 0 failures over 99 Go files. Every import in the tree
 *   is a plain quoted specifier, which is the shape the Go analyzer's declared
 *   limits are written around.
 * - **ripgrep** hits a declared limit of the Rust analyzer 29 times, always the
 *   same one: `use { a::b, c::d };` — a top-level brace group naming no crate
 *   at its head. The analyzer reports each as a failure rather than dropping
 *   it, which is the loud direction, but those crate dependencies are invisible
 *   to the graph. That is a real gap this lane exists to have found, and it is
 *   recorded here rather than fixed in the same change: changing what is
 *   reported on an unchanged workspace is a breaking change (`../AGENTS.md`)
 *   and belongs in its own reviewed commit.
 * - **requests** hits the analysis contract's own decision twice: a dynamic
 *   import whose argument is not a literal resolves to nothing and is reported
 *   unresolvable rather than dropped (`packages/lattice/src/analysis/contract.md`).
 *   That is correct behaviour, and the count is pinned so it stays two.
 */
export const TREES = Object.freeze([
  Object.freeze({
    name: "gin",
    url: "https://github.com/gin-gonic/gin.git",
    sha: "dcaa4296d111981ffb31ac3eba90bb63e1eb5ab9",
    license: "MIT",
    language: "go",
    extensions: Object.freeze([".go"]),
    expected: Object.freeze({ sources: 99, records: 518, unreadable: 0 }),
  }),
  Object.freeze({
    name: "ripgrep",
    url: "https://github.com/BurntSushi/ripgrep.git",
    sha: "3fce3b5bb0236da2df6d99672afb8a719642eca7",
    license: "MIT",
    language: "rust",
    extensions: Object.freeze([".rs"]),
    expected: Object.freeze({ sources: 110, records: 439, unreadable: 29 }),
  }),
  Object.freeze({
    name: "requests",
    url: "https://github.com/psf/requests.git",
    sha: "8f8b212de8c2129d7954c6cd373762880375620a",
    license: "Apache-2.0",
    language: "python",
    extensions: Object.freeze([".py"]),
    expected: Object.freeze({ sources: 37, records: 326, unreadable: 2 }),
  }),
]);

/**
 * @typedef {object} Measurement
 * @property {string} name The tree's name.
 * @property {number} sources Files of the tree's language, tracked at the sha.
 * @property {number} records Import records the analyzer produced.
 * @property {number} unreadable Failure records the analyzer produced.
 */

/**
 * Every way a measurement can breach its pin, named.
 *
 * Exact in both directions, per this file's header. A range would let an
 * analyzer lose a fifth of what it reads and stay green, which is the only
 * failure this lane exists to catch.
 *
 * @param {readonly {name: string, expected: {sources: number, records: number,
 *   unreadable: number}}[]} trees
 * @param {Measurement[]} measurements
 * @returns {string[]} One sentence per breach; empty when every tree matches.
 */
export function evaluate(trees, measurements) {
  const breaches = [];
  const seen = new Map(measurements.map((measurement) => [measurement.name, measurement]));

  for (const tree of trees) {
    // A tree with no expectations at all would pass every comparison below by
    // having nothing to compare — the placeholder-green shape this repository
    // is built against. It is a table error, not a measurement, so it is
    // refused rather than reported as a breach nobody can fix in the tree.
    if (tree.expected.sources <= 0) {
      throw new Error(
        `lattice: ${tree.name} pins ${tree.expected.sources} source files — a tree with no ` +
          `sources measures nothing and would pass by comparing nothing.`,
      );
    }
    const measurement = seen.get(tree.name);
    if (measurement === undefined) {
      breaches.push(`${tree.name}: no measurement at all — the run could not look at this tree`);
      continue;
    }
    for (const key of /** @type {const} */ (["sources", "records", "unreadable"])) {
      if (measurement[key] !== tree.expected[key]) {
        breaches.push(
          `${tree.name}: ${key} is ${measurement[key]}, pinned at ${tree.expected[key]} — ` +
            (measurement[key] < tree.expected[key]
              ? "the analyzer reads less of this tree than it did, which is the silent direction"
              : "the analyzer's output moved and nobody measured it"),
        );
      }
    }
  }
  return breaches;
}

/**
 * One tree, cloned at its sha and read.
 *
 * Nothing is cached between runs, deliberately, and the reason is the one
 * `differential-real-trees.mjs` states for its own clones: a fresh clone at a
 * pinned sha cannot be stale, while a cache that survived a change to this
 * repository would measure yesterday's analyzers under today's numbers.
 *
 * The workspace handed to the analyzers declares ONE project rooted at the
 * repository root. That is enough for what is being measured — how much source
 * the analyzer reads — and deliberately not enough to make resolution
 * meaningful: these repositories declare no project model, and inventing one
 * would make the numbers a fact about the invention.
 *
 * @param {{name: string, url: string, sha: string, extensions: readonly string[]}} tree
 * @returns {Measurement}
 */
export function measureTree(tree) {
  const dir = mkdtempSync(join(tmpdir(), `lattice-coverage-${tree.name}-`));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    git("fetch", "-q", "--depth", "1", tree.url, tree.sha);
    git("checkout", "-q", "FETCH_HEAD");
    const head = git("rev-parse", "HEAD").trim();
    if (head !== tree.sha) {
      throw new Error(
        `lattice: ${tree.name} checked out ${head}, and the table pins ${tree.sha} — a ` +
          `measurement against a commit nobody pinned says nothing about the pinned one.`,
      );
    }

    const tracked = git("ls-files")
      .split("\n")
      .filter((line) => line !== "");
    const sources = tracked.filter((file) =>
      tree.extensions.some((extension) => file.endsWith(extension)),
    );
    const readFile = (path) => {
      try {
        return readFileSync(join(dir, path), "utf8");
      } catch {
        return null;
      }
    };
    const workspace = {
      root: dir,
      projects: [{ name: tree.name, root: "" }],
      filesOf: () => sources,
      readFile,
    };

    let records = 0;
    let unreadable = 0;
    for (const file of sources) {
      const text = readFile(file);
      if (text === null) {
        // A tracked file that cannot be read is not an analyzer result and
        // must not be counted as one; it is a broken checkout.
        throw new Error(`lattice: ${tree.name} could not read its own tracked file ${file}`);
      }
      const result = analyzeFile({ sourceFile: file, text, workspace });
      records += result.imports.length;
      unreadable += result.failures.length;
    }
    return { name: tree.name, sources: sources.length, records, unreadable };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Exit 0 clean, 1 on a breach, 3 when the run could not look. */
function main() {
  /** @type {Measurement[]} */
  const measurements = [];
  for (const tree of TREES) {
    try {
      const measurement = measureTree(tree);
      measurements.push(measurement);
      console.log(
        `${measurement.name.padEnd(10)} ${measurement.sources} ${tree.language} files, ` +
          `${measurement.records} import records, ${measurement.unreadable} reported unreadable`,
      );
    } catch (error) {
      // Could not look: the network, the host, or the checkout. Loud, and its
      // own exit code — a run that never read a tree must not be reported as a
      // run that read it and found the pinned numbers.
      console.error(`lattice: ${tree.name} could not be measured — ${error?.message ?? error}`);
      process.exit(3);
    }
  }

  const breaches = evaluate(TREES, measurements);
  if (breaches.length === 0) {
    console.log(`\n${TREES.length} trees, every pinned count matched.`);
    return;
  }
  console.error("");
  for (const breach of breaches) console.error(`✗ ${breach}`);
  console.error(
    `\n${breaches.length} pinned count(s) moved. Read the diff before repinning: a count that ` +
      `fell is an analyzer that went quiet on real code.`,
  );
  process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith("coverage-real-trees.mjs")) main();

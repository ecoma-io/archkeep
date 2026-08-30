/**
 * Fixture scaffolding for the Wave 3 W8 evolution-lifecycle conformance suite
 * (`../evolution-lifecycle.integration.test.mjs`). This module is the ONE home
 * for the real-git workspace builders that suite uses — a throwaway native Go
 * workspace per case, materialized through real `git`, driven through the real
 * `archkeep evolution` entry point.
 *
 * It deliberately reuses the native-workspace recipe already proven by
 * `../commands/evolution.cli.integration.test.mjs` (an `archkeep.json` model,
 * a `module-boundaries.config.mjs` law, and Go sources) rather than inventing
 * a second convention, and threads the same environment guard (`../process.mjs`).
 *
 * Nothing here decides a verdict. It builds trees and drives the CLI; the
 * assertions live in the suite. Keeping the builders here (and only here) is
 * what the W8 task boundary requires: fixture scaffolding lives in
 * `./fixtures/evolution-lifecycle/`, nowhere else.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT, runCli } from "../../../cli.mjs";
import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../../../spawn-budget.mjs";
import { environmentForTree } from "../../workspace.mjs";

export { SPAWN_TEST_BUDGET_MS, EXIT };

/** Identity flags keeping every fixture commit independent of the machine. */
const IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

/**
 * Runs git in `cwd` through the same environment guard production uses, with
 * the single-spawn budget on every child so a wedged git fails the test rather
 * than blocking the worker thread forever.
 */
export function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    env: environmentForTree(),
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
  });
}

/** Writes `text` to `root/relativePath`, creating parent directories. */
export function writeIn(root, relativePath, text) {
  mkdirSync(join(root, relativePath, ".."), { recursive: true });
  writeFileSync(join(root, relativePath), text);
}

/** Stages every change and commits with the fixture identity; returns the SHA. */
export function commit(root, message) {
  git(root, ...IDENTITY, "add", "-A");
  git(root, ...IDENTITY, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD").trim();
}

/** Resolves the current HEAD of the fixture. */
export function headOf(root) {
  return git(root, "rev-parse", "HEAD").trim();
}

/**
 * Opens a brand-new throwaway native git workspace (never the repository's own
 * tree). `archkeep.json` declares two Go projects on two layers, exactly the
 * MODEL `../commands/evolution.cli.integration.test.mjs` uses, so a case can
 * lay an edge between them and the native provider draws it.
 *
 * @returns {{root: string}}
 */
export function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "archkeep-lifecycle-"));
  git(root, "init", "-q", "-b", "main");
  writeIn(root, "archkeep.json", `${MODEL()}\n`);
  writeIn(root, "libs/alpha/go.mod", "module example.com/alpha\n\ngo 1.22\n");
  writeIn(root, "libs/beta/go.mod", "module example.com/beta\n\ngo 1.22\n");
  return { root };
}

/**
 * The native workspace model: two Go projects on two layers (alpha is
 * `layer:a`, beta is `layer:b`), the law file exempted from coverage.
 */
const MODEL = () =>
  JSON.stringify(
    {
      projects: {
        declared: [
          { root: "libs/alpha", name: "alpha", tags: ["layer:a"] },
          { root: "libs/beta", name: "beta", tags: ["layer:b"] },
        ],
      },
      coverage: {
        exempt: [{ path: "module-boundaries.config.mjs", reason: "the workspace's own law" }],
      },
    },
    null,
    2,
  );

/** The eight options a valid boundary law must carry, per `policyFrom`. */
const OPTIONS = `export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;

export const ALPHA_CLEAN = `package alpha

func Name() string { return "alpha" }
`;

export const ALPHA_REACHING = `package alpha

import (
	"example.com/beta"
)

func Name() string { return "alpha" + beta.Suffix() }
`;

export const BETA = `package beta

func Suffix() string { return "-beta" }
`;

/**
 * Writes a `module-boundaries.config.mjs` law at `root` with the given
 * `depConstraints` rows and optional `fitness` array.
 *
 * @param {string} root
 * @param {{rows?: string, fitness?: string}} [law]
 */
export function writeLaw(root, { rows = "", fitness } = {}) {
  writeIn(
    root,
    "module-boundaries.config.mjs",
    `export const depConstraints = [\n${rows}\n];\n${OPTIONS}` +
      (fitness === undefined ? "" : `\nexport const fitness = ${fitness};\n`),
  );
}

/**
 * A single permitted layer rule (a may reach b). The same ONE_ROW the
 * evolution CLI integration fixtures use, so an allowed alpha→beta edge never
 * trips a boundary rule.
 */
export const ALLOW_A_TO_B = `  { sourceTag: "layer:a", onlyDependOnLibsWithTags: ["layer:b"] },`;

/**
 * Writes `architecture-intent.json` at `root`. `sections` carries the top-level
 * keys directly (`version`, `boundaries`, `allowed`, `forbidden`,
 * `dependencies`, …); `version` defaults to "1".
 */
export function writeIntent(root, sections) {
  writeIn(root, "architecture-intent.json", `${JSON.stringify(sections, null, 2)}\n`);
}

/**
 * Writes one ADR record under `docs/adr/`, the shape `adr-registry.mjs` reads.
 * `record` is the frontmatter map (`{id, status, supersedes?, bindings?}`).
 */
export function writeAdr(root, filename, record) {
  const lines = ["---", `id: ${record.id}`, `status: ${record.status}`];
  if (record.supersedes?.length) {
    lines.push("supersedes:");
    for (const target of record.supersedes) lines.push(`  - ${target}`);
  }
  if (record.bindings?.length) {
    lines.push("bindings:");
    for (const binding of record.bindings) lines.push(`  - ${binding}`);
  }
  lines.push("---", "", `# ${record.id}`, "");
  writeIn(root, join("docs/adr", filename), `${lines.join("\n")}\n`);
}

/**
 * Drives the CLI in-process over `cwd`, capturing streams. Returns the exit
 * code and joined `out`/`err`. `runCli` is the real entry point
 * (`../cli.mjs`), never a shell-out to a binary named `archkeep`.
 */
export async function runEvolution(cwd, argv) {
  const out = [];
  const err = [];
  const exitCode = await runCli(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd,
  });
  return { exitCode, out: out.join("\n"), err: err.join("\n") };
}

/**
 * Invokes `evolution --base <base> [--head <head>] [--event-out <dir>] [--format json]`.
 *
 * @param {string} base The base revision (full SHA).
 * @param {{head?: string, eventOut?: string, format?: string}} [options]
 */
export function evolutionArgs(base, { head, eventOut, format = "json" } = {}) {
  const args = ["evolution", "--base", base];
  if (head) args.push("--head", head);
  if (eventOut) args.push("--event-out", eventOut);
  if (format) args.push("--format", format);
  return args;
}

/**
 * Parses the `--format json` envelope out of a successful evolution run.
 */
export function parseEnvelope(run) {
  if (run.exitCode !== EXIT.ok) throw new Error(`evolution exited ${run.exitCode}: ${run.err}`);
  return JSON.parse(run.out);
}

/** The parsed event files in `dir`, in filename order. */
export function readEvents(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".json.tmp"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

/** The event store's file names in `dir`, in filename order. */
export function eventFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".json.tmp"))
    .sort();
}

/** Removes a throwaway workspace. */
export function dispose(root) {
  rmSync(root, { recursive: true, force: true });
}

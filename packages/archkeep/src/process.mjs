/**
 * Process spawning, held apart from `./workspace.mjs` so a caller that only
 * needs to run a program does not also load `./workspace.mjs`'s import
 * graph.
 *
 * That graph runs through `./analysis/analyze.mjs` to `./analysis/typescript.mjs`,
 * which loads the TypeScript compiler at module scope. `./providers/nx.mjs`
 * only ever needed `runProcess` — to spawn `nx graph` — and so does
 * `./providers/native/` (`../AGENTS.md`, "`src/providers/` is the only
 * layer allowed to build a graph"): a native workspace with no
 * `tsconfig.base.json` at all still has to build one, and a provider that
 * pulled in `typescript` just to run `git ls-files` would fail before the
 * model it is judging ever mentioned TypeScript.
 *
 * `./workspace.mjs` re-exports both symbols below, so every import site that
 * predates this split keeps working unchanged.
 */
import { execFileSync } from "node:child_process";

/**
 * The environment variables that point git at a repository OTHER than the one
 * containing the directory it runs in. Each overrides `cwd`, so a spawn that
 * inherits them reads a different tree than the caller asked for.
 *
 * A git hook is the case that matters, and it is where this tool runs: git
 * exports `GIT_DIR` (and often `GIT_INDEX_FILE`) to every hook, so a `check`
 * or a language server started from `pre-commit`/`pre-push` would list the
 * ambient repository's files while resolving them against the root it was
 * given. Every read then fails against a path that belongs to another tree —
 * a verdict about the wrong workspace, or none at all.
 *
 * Which tree is judged is `root`'s decision alone. `GIT_CEILING_DIRECTORIES`
 * is in the list for the same reason from the other direction: it can stop
 * discovery before reaching the root the caller named.
 */
const AMBIENT_GIT_REDIRECTS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
];

/**
 * `env` with every ambient git redirect removed, for a spawn that must read
 * the tree it is pointed at. Nx gets it too — it shells out to git itself, and
 * a graph built from another repository's files is the same defect one layer
 * further away.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Record<string, string|undefined>}
 */
export function environmentForTree(env = process.env) {
  const clean = { ...env };
  for (const name of AMBIENT_GIT_REDIRECTS) delete clean[name];
  return clean;
}

/**
 * Runs a program and returns its stdout, throwing an `Error` that names the
 * program when it fails. The single seam every spawn in this project goes
 * through, so a test drives the whole scan without a git repository or an Nx
 * installation.
 *
 * @param {string} file Executable path.
 * @param {string[]} args
 * @param {string} cwd
 * @param {Record<string, string|undefined>} [env] Optional environment
 *   override. When omitted, `environmentForTree()` is used — which strips
 *   ambient git redirects from `process.env`.
 * @returns {string}
 */
export function runProcess(file, args, cwd, env) {
  try {
    return execFileSync(file, args, {
      cwd,
      env: env ?? environmentForTree(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (cause) {
    throw new Error(
      `archkeep: \`${[file, ...args].join(" ")}\` failed in ${cwd}: ` +
        `${cause?.stderr || cause?.message || cause}`,
      { cause },
    );
  }
}

/**
 * "Was this module run as a program, or imported?" — the one question both
 * executables ask, and the one they were both getting wrong once installed.
 *
 * The idiom this replaces compares `process.argv[1]` to `import.meta.url` as
 * URLs. Those two strings are produced differently: Node resolves symlinks
 * before it records a module's URL, and records `argv[1]` exactly as the caller
 * spelled it. Run the file by a path that goes through a symlink and the
 * comparison is false — the module loads, defines everything, runs nothing, and
 * the process exits 0.
 *
 * That is not a hypothetical spelling. pnpm's layout IS a symlink:
 * `node_modules/@scope/pkg` points into `node_modules/.pnpm/…`, so an installed
 * consumer launching `node node_modules/@scope/pkg/lsp.mjs` hits it every time.
 * Measured on a real `pnpm pack` + install: the language server answered an
 * `initialize` frame with no bytes on stdout, none on stderr, and exit 0. The
 * generated bin shim happens to `exec` the resolved path, which is why the CLI
 * looked fine through `pnpm exec` while the editor path — Claude Code launches
 * `${CLAUDE_PLUGIN_ROOT}/lsp.mjs` by path, with no shim in between — did not.
 *
 * Exit 0 and silence is the exact failure this project is built to refuse (a
 * server that published nothing is read as "checked, clean"), so the comparison
 * is made on real paths, where both spellings of the same file agree.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Resolves a path through symlinks, falling back to the path itself.
 *
 * A path that cannot be resolved — deleted between spawn and this call, or a
 * dangling link — is compared verbatim rather than throwing. Getting the answer
 * wrong there means an executable does not run; throwing means it crashes with
 * a stack trace naming a file the caller did not ask about.
 */
function realOrGiven(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True when `moduleUrl` names the file Node was told to run.
 *
 * @param {string} moduleUrl `import.meta.url` of the calling module.
 * @param {string | undefined} [argv1] The invoked path; defaults to `process.argv[1]`,
 *   which is absent when Node is run with `-e` or as a REPL — imported, not run.
 * @returns {boolean}
 */
export function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return realOrGiven(argv1) === realOrGiven(fileURLToPath(moduleUrl));
}

/**
 * tsconfig paths hygiene — the workspace-level check that the `paths` alias
 * table still points at code that exists.
 *
 * A `paths` alias whose every target rotted away is a silent lie with two
 * faces. An import of it stops resolving through the table — TypeScript falls
 * back to a node_modules lookup (measured: a dead mapping with an installed
 * package of the same name resolves to the package, `isExternalLibraryImport`
 * true) or reports the import unresolvable — so either the build breaks or,
 * worse, every boundary decision that keys off the alias quietly reads the
 * import as external instead of as the workspace source the alias promised.
 * Nothing else reports either state: the table is only ever consulted, never
 * judged. This module judges it.
 *
 * **This check judges the alias table itself and never resolves a specifier.**
 * `../analysis/typescript.mjs` delegates every real import to
 * `ts.resolveModuleName` precisely so this package never grows a second
 * resolver (docs/reference/languages.md § TypeScript), and a hygiene check that
 * probed candidate files per resolution mode would be that second resolver
 * wearing a janitor's coat. What it may honestly decide instead follows from
 * one measured fact about how TypeScript forms candidates from a target
 * (typescript 5.9.3, probed under node10, nodenext and bundler resolution):
 * every candidate derived from a target — extension substitution and
 * appending, `index.*` and `package.json` lookups below a directory target,
 * and the specifier text substituted at the target's `*` — lives at or below
 * the directory of the target's static prefix (the text before the first `*`;
 * the whole target when it has none).
 *
 * ## The rule, exactly
 *
 * Targets resolve against `baseUrl` when the tsconfig sets one, else against
 * the directory of the config file that declared `paths` (TypeScript's own
 * `pathsBasePath`; both measured). A target is **unreachable** when the
 * directory of its static prefix does not exist — no candidate TypeScript can
 * form from it can then name an existing file. An alias is **dead**, and a
 * finding, when its target list is empty or every target is unreachable.
 *
 * ## Limits, each the honest side of a line this package refuses to cross
 *
 * - **A dead mapping whose prefix directory still exists is not reported.**
 *   A target `libs/a/src/index.ts` whose file is gone while `libs/a/src/`
 *   remains may still resolve: measured, TypeScript then probes `index.tsx`,
 *   `index.d.ts`, `index.js`, even `index.ts.ts` and an `index.ts/` directory,
 *   and the probe set differs by resolution mode. Deciding it would mean
 *   reproducing that per-mode candidate set — the second resolver. No record.
 * - **A target whose prefix directory falls outside the workspace root is not
 *   judged** (a `../` escape, an absolute path elsewhere): this tool's view of
 *   the world ends at the root it was given. Counted, not reported.
 * - **A pattern with more than one `*` is not judged**: measured, TypeScript
 *   ignores such an alias entirely — zero candidate probes even for a
 *   specifier shaped to match — so its targets decide nothing. Counted.
 * - **A target with more than one `*` is judged**: only the first `*` is
 *   substituted (measured; later stars stay literal characters in the
 *   candidate), so every candidate still lives under the first star's prefix.
 * - **A `paths` value that is not an array of strings is a malformed table,
 *   not an absent one.** `ts.parseConfigFileTextToJson` and
 *   `ts.parseJsonConfigFileContent` both accept these shapes without a
 *   diagnostic (measured), and resolution then misbehaves — a bare-string
 *   value is iterated character by character, a non-string element throws
 *   mid-resolve. Read as "no aliases" they would be the silent direction, so
 *   they come back in `malformed` and `../cli.mjs` turns each into a
 *   whole-file failure (exit 3), the same posture the analyzer takes for a
 *   tsconfig that does not parse at all.
 * - **A substituted specifier containing `..` can escape the prefix
 *   directory.** The reachability model assumes the matched text stays inside
 *   it; an import written to traverse out of a mapping is outside this model,
 *   and the worst case is a finding naming an alias such an import still
 *   reaches — loud, never silent.
 *
 * **This check runs on the CLI surface only, not in the language server**, for
 * the reason `./go-work.mjs` states: it describes the workspace's table, not
 * any document being edited, and a workspace-level finding pinned to whichever
 * file is open would put the report where its fix is not. The table itself
 * comes from `../analysis/typescript.mjs`'s own parsed context — the same
 * file, the same parse, the same `extends` handling the resolver uses — so the
 * check and the resolver cannot disagree about what the workspace's tsconfig
 * says (`tsconfigPathsFacts` there).
 */
import { posix } from "node:path";

/**
 * What a hygiene finding means — one entry per `messageId`, the arrangement
 * `../report/sarif.mjs` derives its rule descriptors from, the same as
 * `./go-work.mjs`, so the id cannot be nameless in a code-scanning upload.
 */
export const TSCONFIG_PATHS_MESSAGES = Object.freeze({
  tsconfigDeadPathAlias:
    "A tsconfig paths alias maps only to targets whose directories do not exist: no import of it " +
    "can resolve through the alias table, so the build breaks — or silently resolves to an " +
    "installed package of the same name instead of the workspace source the alias promised.",
});

export const TSCONFIG_PATHS_MESSAGE_IDS = Object.freeze(Object.keys(TSCONFIG_PATHS_MESSAGES));

/** A workspace-relative directory for display, `""` being the root. */
const displayDir = (dir) => (dir === "" ? "the workspace root" : `${dir}/`);

/**
 * The workspace-relative directory every candidate formed from `target` must
 * live under, or `null` when that directory falls outside the workspace and
 * so cannot be judged from here.
 *
 * @param {string} target A `paths` target as written.
 * @param {string} base Absolute: `baseUrl` if set, else `pathsBasePath`.
 * @param {string} root Absolute workspace root, no trailing slash.
 * @returns {string|null} `""` for the root itself.
 */
function probeDirectory(target, base, root) {
  const starIndex = target.indexOf("*");
  const prefix = starIndex === -1 ? target : target.slice(0, starIndex);
  const joined = posix.isAbsolute(prefix)
    ? posix.normalize(prefix)
    : posix.normalize(posix.join(base, prefix));
  // A prefix ending at a separator names its directory itself; anything else
  // ends mid-segment (a partial name before `*`, or a whole target), and the
  // candidates live in its parent.
  const dir =
    prefix === "" || prefix.endsWith("/")
      ? joined.replace(/\/+$/u, "") || "/"
      : posix.dirname(joined);
  if (dir === root) return "";
  return dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : null;
}

/**
 * The dead aliases in a `paths` table — pure, facts as arguments, so the tests
 * need no filesystem: the table and its base come from the resolver's own
 * parsed context, and existence arrives as a predicate.
 *
 * @param {{ paths: Record<string, unknown>,
 *   base: string,
 *   workspaceRoot: string,
 *   tsConfig: string,
 *   directoryExists: (dir: string) => boolean }} facts `base` is absolute
 *   (`baseUrl` if the config sets one, else TypeScript's `pathsBasePath`);
 *   `directoryExists` takes a workspace-relative directory, `""` for the root.
 * @returns {{ tsConfig: string,
 *   findings: { messageId: string, file: string, line: null, column: null,
 *     alias: string, targets: string[], message: string }[],
 *   aliases: number, unjudged: number,
 *   malformed: { alias: string, reason: string }[] }} `aliases` counts the
 *   aliases that reached a dead-or-alive verdict and `unjudged` the ones the
 *   header's limits exclude, so the report can state coverage beside the
 *   verdict; `malformed` is for `../cli.mjs` to refuse loudly, never to skip.
 */
export function judgeTsconfigPaths({ paths, base, workspaceRoot, tsConfig, directoryExists }) {
  const root = workspaceRoot.replace(/\/+$/u, "");
  const findings = [];
  const malformed = [];
  let aliases = 0;
  let unjudged = 0;

  for (const [alias, targets] of Object.entries(paths)) {
    if (alias.indexOf("*") !== alias.lastIndexOf("*")) {
      // TypeScript ignores a multi-star pattern outright (header), so its
      // targets decide nothing — dead or alive would both be guesses.
      unjudged += 1;
      continue;
    }
    if (!Array.isArray(targets)) {
      malformed.push({
        alias,
        reason:
          `${tsConfig} maps "${alias}" to ${JSON.stringify(targets)}, not to an array of ` +
          `target paths, so the paths hygiene check reached no verdict about it — and ` +
          `TypeScript itself only diagnoses this shape when a full Program is built, which ` +
          `this tool never does`,
      });
      continue;
    }
    if (targets.some((target) => typeof target !== "string")) {
      malformed.push({
        alias,
        reason:
          `${tsConfig} maps "${alias}" to a target list with a non-string entry, so the ` +
          `paths hygiene check reached no verdict about it`,
      });
      continue;
    }

    const dirs = targets.map((target) => probeDirectory(target, base, root));
    if (dirs.includes(null)) {
      // At least one target lives outside the workspace root; whether it hits
      // a file is not knowable from inside this tree (header).
      unjudged += 1;
      continue;
    }
    aliases += 1;

    if (targets.length === 0) {
      findings.push(deadAlias(tsConfig, alias, targets, null));
      continue;
    }
    const missing = [...new Set(dirs)].filter((dir) => !directoryExists(dir));
    if (missing.length === new Set(dirs).size) {
      findings.push(deadAlias(tsConfig, alias, targets, missing));
    }
  }

  return { tsConfig, findings, aliases, unjudged, malformed };
}

/**
 * One dead-alias finding. Positionless on purpose: the parsed compiler options
 * carry no source positions, and under `extends` the alias may not even be
 * declared in the file the workspace names — the finding cites the table the
 * resolver actually reads, and a fabricated line 1 would mark text the alias
 * is not on (`../report/sarif.mjs` gives the same reasoning for go.work).
 *
 * @param {string} tsConfig The workspace tsconfig, workspace-relative.
 * @param {string} alias The pattern as written.
 * @param {string[]} targets The targets as written.
 * @param {string[]|null} missing The unreachable directories, `null` for an
 *   alias with no targets at all.
 */
function deadAlias(tsConfig, alias, targets, missing) {
  const message =
    missing === null
      ? `${tsConfig} maps "${alias}" to an empty target list — no import matching it can ever ` +
        `resolve through this alias. Give it a target, or delete it.`
      : `${tsConfig} maps "${alias}" only to ${targets.map((t) => `"${t}"`).join(", ")}, and ` +
        `every candidate those targets can name lives under ` +
        `${missing.map(displayDir).join(", ")} — which ${missing.length === 1 ? "does" : "do"} ` +
        `not exist. No import matching "${alias}" resolves through this alias: the build ` +
        `breaks on it, or it silently resolves to an installed package of the same name and ` +
        `every boundary decision reads the import as external. Point the alias at the moved ` +
        `source, or delete it.`;
  return {
    messageId: "tsconfigDeadPathAlias",
    file: tsConfig,
    line: null,
    column: null,
    alias,
    targets: [...targets],
    message,
  };
}

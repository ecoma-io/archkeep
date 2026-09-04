/** Shared manifest helpers for the per-language resolvers. */
import { parse as parseToml } from "smol-toml";

/**
 * Parses TOML, returning null instead of throwing on malformed input.
 *
 * A leading UTF-8 BOM is tolerated (`contract.md`, byte tolerance): smol-toml
 * rejects it outright (measured), so a manifest an editor wrote a BOM into
 * came back null and everything read from it vanished — a `Cargo.toml` crate
 * dropped out of the crate map and every import of it resolved as if it were
 * external, a `pyproject.toml`'s declared layout went unmodelled. Manifests
 * contribute no position to any record (`contract.md`), so removing the one
 * character here shifts nothing.
 *
 * The return type is deliberately loose: a manifest's shape is whatever its
 * author wrote, and every reader here guards each access with optional
 * chaining and typeof checks rather than trusting a declared shape.
 *
 * @param {string} text
 * @returns {Record<string, any> | null}
 */
export function parseManifest(text) {
  try {
    return parseToml(text.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

/** POSIX-normalizes `relative` against `baseDir` without touching the fs. */
export function normalizePath(baseDir, relative) {
  const segments = [];
  for (const part of `${baseDir}/${relative}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

/**
 * Like `normalizePath`, but answers `null` when the path climbs above the
 * workspace root instead of quietly staying there.
 *
 * `normalizePath` pops a `..` off an empty stack as a no-op, so
 * `libs/alpha` + `../../../elsewhere` comes back as `elsewhere` — an in-tree
 * spelling of a directory that is NOT in the tree. A caller comparing that
 * against project roots would then reason about the wrong directory in both
 * directions: a spurious match, or a "no project here" verdict about a path
 * the workspace never contained. `null` keeps the two cases apart: the target
 * lies outside the tree every project root is relative to, so no comparison
 * against those roots can mean anything.
 *
 * @param {string} baseDir Workspace-relative directory the path is written in.
 * @param {string} relative As written in the manifest.
 * @returns {string|null} Workspace-relative path, or `null` when it escapes.
 */
export function resolveWithinWorkspace(baseDir, relative) {
  const segments = [];
  for (const part of `${baseDir}/${relative}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else segments.push(part);
  }
  return segments.join("/");
}

/**
 * A pattern carrying any of these is routed to the glob matcher; everything
 * else compares equal. `(` rides for extglob — `+(x).txt` matches `x.txt`
 * (measured on Node v24) — the character #671 proved the table was missing.
 */
const GLOB_METACHARACTERS = /[*?[{(\\]/;

/**
 * Does a file's basename match any of a manifest-name pattern list — the
 * literal patterns by equality, only the glob patterns through `matchesGlob`.
 *
 * Why the split: the lists this serves (the polyglot manifest names, a
 * workspace's `projects.infer.manifests`) are mostly literals — `go.mod`,
 * `Cargo.toml`, `pom.xml` — with a wildcard like `*.csproj` riding beside
 * them, and the filters run once per tracked file. Measured, handing every
 * pattern to `path.posix.matchesGlob` costs seconds past ~100k files where
 * the equality scan it replaced was nanoseconds, because each call compiles
 * its pattern again. The matcher is injected so `../../providers/native/
 * model.mjs`'s validated one and raw `path.posix.matchesGlob` ride the same
 * fast path without this module reaching for either. The rule the table has
 * to hold: every pattern carrying a character that can alter the glob's
 * answer is routed to it, and everything else compares equal — a pattern
 * the table does not carry is literal outside constructs the table already
 * routes, so the two answers agree, and routing a literal anyway (an
 * unbalanced `a(b`) costs only the matcher call. #671: `(` was missing
 * from the table, so an extglob manifest pattern like `+(x).csproj` was
 * compared by equality and missed every file the pattern named.
 *
 * @param {string} base The basename under test.
 * @param {readonly string[]} patterns
 * @param {(value: string, pattern: string) => boolean} matchesGlob
 * @returns {boolean}
 */
export function basenameMatches(base, patterns, matchesGlob) {
  return patterns.some((pattern) =>
    GLOB_METACHARACTERS.test(pattern) ? matchesGlob(base, pattern) : pattern === base,
  );
}

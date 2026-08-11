/** Shared manifest helpers for the per-language resolvers. */
import { parse as parseToml } from "smol-toml";

/** Parses TOML, returning null instead of throwing on malformed input. */
export function parseManifest(text) {
  try {
    return parseToml(text);
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

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

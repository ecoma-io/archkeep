/**
 * The one place a path derived from workspace content is proven to stay
 * inside the workspace it came from.
 *
 * Two invariants share one mechanism, on both sides of the read/write
 * boundary:
 *
 * - **Reads.** A tracked path is `join(root, path)` for a path `git ls-files`
 *   returned, so the STRING is inside the tree by construction — but the OS
 *   resolves symlinks before the bytes arrive, and a tracked symlink (mode
 *   120000) whose target lives outside the tree hands the reader bytes the
 *   workspace never committed, judged as the workspace's own source. That is
 *   the read-side escape: outside code read into the verdict, reported clean.
 * - **Writes.** `--output` and `history --capture` both write a path the
 *   caller named. A workspace-controlled symlink in an INTERMEDIATE directory
 *   component redirects the write outside the tree — the bytes land
 *   somewhere other than the path named, with the run reporting success.
 *
 * The shared policy: the realpath of the deepest existing ancestor of the
 * target must resolve inside the realpath of the workspace root. Where
 * containment cannot be proven, the operation refuses — it never silently
 * reads the outside bytes or writes them elsewhere.
 *
 * Writes carry one additional rule, the determinism half of the escape: every
 * existing path component below the root must not itself be a symlink. A
 * `sub -> .` self-loop resolves INSIDE the workspace, so the realpath check
 * passes — but the write lands at the workspace root rather than under
 * `sub/`, a different location than the user named. Any symlinked intermediate
 * component makes the write's landing spot a function of the tree, not of the
 * name, so it is refused for writes (and only for writes: an internal symlink
 * is a legitimate tracked layout for READS, and stays allowed there).
 *
 * The workspace root is taken as the string `findWorkspaceRoot` returned,
 * not its realpath: a checkout reached through a symlinked mount
 * (`/workspaces/team -> /mnt/repos`) is the tool's legitimate view of the
 * tree, and only components BELOW the root string are inspected. A target
 * the caller names OUTSIDE the root string (`--output /tmp/report.json`) is
 * the caller's explicit choice, not a tree-derived path, and is left
 * untouched — the escape this refuses is a tree-controlled symlink
 * redirecting a name that was inside the tree.
 *
 * One contract binds the WRITE call sites: a target is `resolve`d ONCE, and
 * the identical resolved string feeds both the containment decision and the
 * actual write. A raw `..` segment is refused outright here (`containsDotDot`),
 * because `lstat` answers ENOENT for a non-collapsed `..` and the probe would
 * skip a symlink the kernel follows (`sub -> /tmp/out`, `sub/../x`); a caller
 * that forgets the `resolve` gets a loud refusal instead of a silent escape.
 *
 * Out of scope, deliberately: a write target spelled with a case that
 * STRING-differs from the workspace root on a case-INSENSITIVE filesystem
 * (macOS) reads as "explicitly outside" (`within` compares strings, and
 * `relative()` is case-insensitive only on Windows). The realpath containment
 * check — which would catch the escape through that path — runs only for
 * string-inside targets. Closing it would need to run the realpath probe for
 * every write, which would refuse the legitimate explicitly-outside target
 * (`--output /tmp/report.json`) that the string test deliberately exempts.
 * The corner requires a hand-typed case-mismatched flag on macOS; it is named
 * here rather than silently inherited.
 */
import { lstatSync as defaultLstat, realpathSync as defaultRealpath } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";

/**
 * Whether a path still carries a raw `..` segment. The containment probe
 * walks the path with `lstat`, which answers ENOENT for a non-collapsed
 * `..` — so a `..` that crosses a symlink (`sub -> /tmp/out`, target
 * `sub/../x`) lexically reads as contained while the kernel would first
 * follow `sub` out of the tree. A path with a `..` segment is therefore
 * REFUSED outright; a caller must `resolve()` it first and then hand the
 * SAME resolved string to both the containment check and the actual write.
 *
 * @param {string} absPath
 * @returns {boolean}
 */
function containsDotDot(absPath) {
  return absPath.split(/[\\/]/).includes("..");
}

/**
 * Whether `realPath` resolves outside `rootReal`, compared as path-component
 * sequences rather than via `relative()`'s string form. `relative()` yields
 * `..\…` on Windows, so testing the string `"../"` would let a same-drive
 * sibling (`C:\ws\x.go` vs `C:\out\x.go`) read as contained; comparing
 * components makes both separator families and differing drive letters plain
 * divergences. Inputs are `realpathSync` outputs, which are canonical
 * (no `..`, no trailing separator) by contract.
 *
 * @param {string} rootReal Realpath of the workspace root.
 * @param {string} realPath Realpath of a deeper existing ancestor.
 * @returns {boolean}
 */
export function pathEscapes(rootReal, realPath) {
  const rootParts = rootReal.split(/[\\/]/).filter((part) => part !== "");
  const realParts = realPath.split(/[\\/]/).filter((part) => part !== "");
  for (let i = 0; i < rootParts.length; i++) {
    if (rootParts[i] !== realParts[i]) return true;
  }
  return realParts.length < rootParts.length;
}

/**
 * Whether `absPath` is strictly below `root`, string-level (no symlink
 * resolution). The platform separator is honoured explicitly — `relative()`
 * yields `..\…` on Windows, so testing `"../"` alone would let a same-drive
 * sibling (`C:\ws\x.go` vs `C:\out\x.go`) read as contained.
 *
 * @param {string} root
 * @param {string} absPath
 * @returns {boolean}
 */
function within(root, absPath) {
  const rel = relative(root, absPath);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !rel.startsWith(".." + "/") &&
    !isAbsolute(rel)
  );
}

/**
 * The deepest ancestor of `absPath` that exists (lstat-able), or `null` when
 * no ancestor exists. `absPath` itself is tried first, then each parent — the
 * common `--output` target is a file that does not exist yet, whose parent
 * directory does.
 *
 * @param {string} absPath
 * @param {(path: string) => {isSymbolicLink: () => boolean}} lstat
 * @returns {string|null}
 */
function deepestExistingAncestor(absPath, lstat) {
  let probe = absPath;
  for (;;) {
    try {
      lstat(probe);
      return probe;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

/**
 * The containment violation for `absPath` against `root`, or `null` when the
 * path is contained.
 *
 * `forWrite: true` applies the write policy (below-root components may not be
 * symlinks); the default is the read policy (realpath containment only, so a
 * tracked internal symlink keeps working).
 *
 * `lstatSync`/`realpathSync` are injectable so the pure decision can be
 * tested without a filesystem — the same seam `../governance/adr-registry.mjs`
 * passes into this helper from its `loadAdrRegistry` io objects.
 *
 * @param {string} root Absolute workspace root, as `findWorkspaceRoot`
 *   returned it.
 * @param {string} absPath Absolute path to check.
 * @param {{forWrite?: boolean, lstatSync?: (path: string) => {isSymbolicLink: () => boolean},
 *   realpathSync?: (path: string) => string}} [io]
 * @returns {string|null} A reason the path is not contained, or `null`.
 */
export function containmentViolation(
  root,
  absPath,
  {
    forWrite = false,
    lstatSync: lstat = defaultLstat,
    realpathSync: realpath = defaultRealpath,
  } = {},
) {
  // A raw `..` is refused outright: the probe cannot prove where the kernel
  // would land (see `containsDotDot`), so passing a non-`resolve`d path in
  // here is a caller bug made loud. The write call sites resolve first and
  // hand the identical string to both check and write; the read call sites
  // receive tracker paths (`git ls-files`, LSP index), which resolve lexically.
  if (containsDotDot(absPath)) {
    return `'${absPath}' contains a '..' segment — resolve the path first so the containment check and the actual write land at the same place`;
  }
  if (forWrite && !within(root, absPath)) return null;
  const ancestor = deepestExistingAncestor(absPath, lstat);
  if (ancestor !== null) {
    let ancestorReal;
    try {
      ancestorReal = realpath(ancestor);
    } catch {
      ancestorReal = null;
    }
    if (ancestorReal !== null) {
      let rootReal;
      try {
        rootReal = realpath(root);
      } catch {
        rootReal = root;
      }
      if (pathEscapes(rootReal, ancestorReal)) {
        return (
          `'${ancestor}' resolves to '${ancestorReal}', outside the workspace root '${rootReal}' — ` +
          "a symlink in this tree must not lead out of it"
        );
      }
    }
  }
  if (forWrite) {
    const below = absPath
      .slice(root.length)
      .split(sep)
      .filter((part) => part !== "");
    // The final name itself is not walked: `renameSync` replaces a symlink at
    // the destination as a directory-entry swap and never dereferences it
    // (`../../cli.mjs`'s `writeOutputReport` docstring owns that half).
    let current = root;
    for (const part of below.slice(0, -1)) {
      current = `${current}${sep}${part}`;
      let stat;
      try {
        stat = lstat(current);
      } catch {
        // A component that does not exist is not a symlink; the write itself
        // will fail loudly on it (`ENOENT`), so this is not a silent path.
        continue;
      }
      if (stat.isSymbolicLink()) {
        return (
          `'${current}' is a symlink — writing through it would land somewhere other than the ` +
          `path '${absPath}' names, so the write is refused`
        );
      }
    }
  }
  return null;
}

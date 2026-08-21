/**
 * The three things every source-level analyzer needs and none of them should
 * answer twice: where a byte offset lands in the contract's 1-based
 * coordinates, which project owns a workspace-relative path, and a per-run
 * cache for the work that is per-workspace rather than per-file.
 *
 * Peer of `manifest-util.mjs`, which does the same job for the manifest
 * readers. The split is by input: that file parses TOML, this one reads
 * positions and project roots out of sources.
 */

/**
 * Where `offset` lands in `text`, in the contract's coordinates: line and
 * column both 1-based, because that is what an editor diagnostic and a
 * `file:line:column` terminal report want (`contract.md`).
 *
 * Column counts UTF-16 code units from the start of the line, which is what
 * `String.prototype.length`, TypeScript's own `getLineAndCharacterOfPosition`,
 * and the LSP's default position encoding all count. A line break is `\n`;
 * a CRLF file therefore reports the same columns, because the `\r` belongs to
 * the end of the preceding line and never to the start of the next one.
 *
 * @param {string} text
 * @param {number} offset Byte offset into `text`; clamped into range rather
 *   than trusted, so a caller's arithmetic slip yields a wrong position and
 *   not a crash mid-run.
 * @returns {{ line: number, column: number }}
 */
export function positionAt(text, offset) {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const lineStart = text.lastIndexOf("\n", clamped - 1) + 1;
  let line = 1;
  for (let i = 0; i < lineStart; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return { line, column: clamped - lineStart + 1 };
}

/**
 * The project owning `path`, by **longest**-prefix match on project roots.
 *
 * Longest and not first, and the difference is not cosmetic: a project nested
 * inside another's directory (`a/b` inside `a`) matches both roots, and a
 * first-match answer would attribute every one of its files to its parent —
 * every intra-project import would read as a boundary crossing, and every real
 * crossing out of the nested project would vanish into the parent.
 *
 * A project whose root is `""` (a workspace-root project) matches everything,
 * which is correct and still loses to any longer root.
 *
 * @param {{ name: string, root: string }[]} projects
 * @param {string} path Workspace-relative.
 * @returns {{ name: string, root: string }|null}
 */
export function projectOwning(projects, path) {
  let owner = null;
  for (const project of projects) {
    const root = project.root ?? "";
    if (root !== "" && path !== root && !path.startsWith(`${root}/`)) continue;
    if (owner === null || root.length > owner.root.length) owner = project;
  }
  return owner;
}

/**
 * Wraps `build` so it runs once per `workspace` object instead of once per
 * file.
 *
 * Every analyzer needs something derived from the whole tree before it can
 * resolve one specifier — the module path of each Go project, the crate name
 * of each Rust project, the importable module names of each Python project,
 * TypeScript's parsed compiler options. Rebuilding that per file turns a
 * whole-tree run into an O(files x projects) manifest re-read.
 *
 * Keyed on the workspace object identity through a `WeakMap`, not on
 * `workspace.root`: two runs over the same root with different injected
 * readers (a test's in-memory tree and the real one) must not share an answer,
 * and a caller that builds a fresh workspace per file simply gets no reuse
 * rather than a stale one.
 *
 * @template T
 * @param {(workspace: object) => T} build
 * @returns {(workspace: object) => T}
 */
export function perWorkspace(build) {
  const cache = new WeakMap();
  return (workspace) => {
    if (cache.has(workspace)) return cache.get(workspace);
    const value = build(workspace);
    cache.set(workspace, value);
    return value;
  };
}

/**
 * Every tracked file in a project whose basename is `basename`, at any depth.
 *
 * The graph resolvers next door look for `<projectRoot>/go.mod` and
 * `<projectRoot>/Cargo.toml` exactly, because an Nx EDGE needs one manifest to
 * stand for one project (`../../AGENTS.md` — one module/crate/package per
 * project root). Analysis attributes a FILE rather than a manifest, so it can
 * be broader without contradicting that: a crate or module nested inside a
 * project still belongs to the project whose directory contains it. A Tauri app
 * keeping its crate in `src-tauri/` — the layout Tauri prescribes — is the case
 * that reaches this.
 *
 * The two therefore disagree about that project, deliberately and in one
 * direction: analysis sees the crate, the graph draws no edge for it. That is
 * the documented modeling limit, surfaced rather than papered over.
 *
 * @param {object} workspace
 * @param {string} projectName
 * @param {string} basename
 * @returns {string[]} Workspace-relative paths.
 */
export function trackedManifests(workspace, projectName, basename) {
  return workspace
    .filesOf(projectName)
    .filter((file) => file === basename || file.endsWith(`/${basename}`));
}

/** An empty envelope, so a no-op and a clean file are the same shape. */
export const emptyResult = () => ({ imports: [], failures: [] });

/**
 * A failure about a file as a whole rather than one position — the shape
 * `contract.md` fixes for "could not be parsed, read, or resolved", with
 * `line`/`column` explicitly `null` rather than absent.
 *
 * @param {string} sourceFile
 * @param {string} reason
 * @returns {{ sourceFile: string, line: null, column: null, reason: string }}
 */
export const fileFailure = (sourceFile, reason) => ({
  sourceFile,
  line: null,
  column: null,
  reason,
});

/**
 * Whether a failure means the file has NO verdict at all, rather than one
 * import site inside it having none.
 *
 * The distinction is the difference between a blind spot and a hole. A site
 * failure says "this file was analyzed and one specifier in it is not
 * statically knowable" — a computed `import()` argument, or a literal package
 * import naming no declared project — and the other imports in it were still
 * judged. A whole-file failure says the file was never read, never parsed, had
 * no analyzer that could run, or imported a declared project it could not
 * resolve (a missing workspace edge), so "no violations here" is not a finding
 * about it; it is the absence of one. Only the shape carries this: a null
 * position is what the analysis contract already means by "about the file as a
 * whole", so callers ask here instead of re-testing `line === null` and
 * drifting apart.
 *
 * @param {{ line: number|null }} failure
 * @returns {boolean}
 */
export const isWholeFileFailure = (failure) => failure.line === null;

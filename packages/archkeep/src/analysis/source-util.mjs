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
 * The one text `lineStartsOf` last built an index for, and that index. One
 * entry, because one entry is the shape of the work: every caller walks ONE
 * file's import sites in a loop, so the file being asked about only changes
 * when the loop ends.
 *
 * Keyed by the string itself. Strings are immutable, so an index built from
 * one text is correct for any text equal to it — there is no stale answer to
 * guard against, only a hit or a miss. What proving that equality costs is
 * the subject of the hit path's own comment below.
 */
let indexedText = null;
/** @type {number[]|null} */
let indexedStarts = null;

/**
 * Where every line of `text` begins, as offsets into it: entry `i` is the
 * offset of line `i + 1`, so a 1-based line number reads straight off it and
 * the array is never empty (line 1 starts at 0, in an empty file too).
 *
 * Built by one scan of the text and memoized on the text it was built from,
 * which is what makes `positionAt` below cost a binary search per call
 * instead of a scan. **Treat the result as read-only** — it is shared with
 * every other caller asking about the same text.
 *
 * Measured, before this index existed: a Go file with 8000 import sites cost
 * 1668ms to position (2000 sites cost 108ms, 4000 cost 417ms — four times the
 * time for twice the sites, the signature of the quadratic every one of the
 * three source analyzers was paying), because each `positionAt` rescanned the
 * file from offset 0. Analyzed files are attacker-supplied
 * (`../../../../SECURITY.md`), so that was a denial of service reachable by
 * committing one large generated file.
 *
 * @param {string} text
 * @returns {number[]}
 */
export function lineStartsOf(text) {
  if (indexedStarts !== null && indexedText === text) {
    // Adopt the caller's string on the way out. `===` on two strings is
    // equality of CONTENT: the memoized index is right for any text equal to
    // the one it was built from, but proving that equality costs a compare of
    // the whole text unless the two are the same reference. Keeping the
    // reference the caller passed makes every later call from that caller a
    // pointer comparison — without it, two equal 116KB texts turned this memo
    // into a 116KB memcmp per lookup, which is the quadratic wearing a hat.
    indexedText = text;
    return indexedStarts;
  }
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  indexedText = text;
  indexedStarts = starts;
  return starts;
}

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
 * The answer is read off `lineStartsOf`'s index by binary search — the
 * greatest line start at or before the offset — rather than by scanning the
 * text, so a file's whole import list costs one scan plus a logarithmic
 * search per site. Every coordinate it can return is one the scanning version
 * returned: the index holds exactly the offsets `lastIndexOf("\n", …) + 1`
 * used to produce, and the line number is that entry's position in it.
 *
 * @param {string} text
 * @param {number} offset Byte offset into `text`; clamped into range rather
 *   than trusted, so a caller's arithmetic slip yields a wrong position and
 *   not a crash mid-run.
 * @param {number[]} [lineStarts] `text`'s line-start index, for a caller that
 *   already holds one. Defaults to the memoized `lineStartsOf(text)`, so a
 *   caller that passes nothing pays for the scan once per file rather than
 *   once per call — every existing caller is that caller.
 * @returns {{ line: number, column: number }}
 */
export function positionAt(text, offset, lineStarts = lineStartsOf(text)) {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= clamped) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: clamped - lineStarts[low] + 1 };
}

/**
 * The store behind `ownershipIndexOf`, which owns its keying contract.
 *
 * @type {WeakMap<{ name: string, root: string }[], { roots: string[], entries: { name: string, root: string }[] }>}
 */
const ownershipIndexes = new WeakMap();

/**
 * The projects of `projects` sorted by their roots ascending, beside those
 * normalized roots — the structure `projectOwning` binary-searches.
 *
 * Built once per projects ARRAY and keyed on its identity, for the same reason
 * `perWorkspace` below keys on the workspace object: every caller holds one
 * array steady for a whole run (`workspace.projects`, or the normalized copies
 * `../go-work.mjs` and `./python.mjs` assemble before their loops)
 * and asks it about every file, so one sort serves the run. A caller that
 * builds a fresh array per call gets no reuse rather than a stale answer — and
 * the array must not be mutated after a lookup, because a project pushed later
 * would be invisible to every later answer, which is the silent direction.
 *
 * The sort is stable and `firstRootAtOrAfter` is a lower bound, so of two
 * projects spelling one root the FIRST in the array is the one found — the tie
 * the linear scan this replaces broke with a strict `>`.
 *
 * @param {{ name: string, root: string }[]} projects
 * @returns {{ roots: string[], entries: { name: string, root: string }[] }}
 */
function ownershipIndexOf(projects) {
  let index = ownershipIndexes.get(projects);
  if (index === undefined) {
    // `root ?? ""` here is the one spelling decision the scan also made: a
    // project without a root is the workspace-root project, never a project
    // that owns nothing.
    const entries = [...projects].sort((a, b) => {
      const left = a.root ?? "";
      const right = b.root ?? "";
      return left < right ? -1 : left > right ? 1 : 0;
    });
    index = { roots: entries.map((project) => project.root ?? ""), entries };
    ownershipIndexes.set(projects, index);
  }
  return index;
}

/**
 * Root comparisons `projectOwning` has performed since the module loaded.
 *
 * Nothing in production reads it. It exists so the complexity test counts
 * deterministic operations instead of milliseconds — the wall-clock this
 * repository does not trust in a test (cf. #359, #369). Every comparison the
 * lookup makes is counted: one per binary-search step, one per equality probe.
 */
let rootComparisons = 0;
export const ownershipRootComparisons = () => rootComparisons;

/**
 * The first index in `roots` (sorted ascending) whose value is at or after
 * `probe` — the lower bound `projectOwning` walks ancestors with.
 *
 * @param {string[]} roots
 * @param {string} probe
 * @returns {number}
 */
function firstRootAtOrAfter(roots, probe) {
  let low = 0;
  let high = roots.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    rootComparisons++;
    if (roots[mid] < probe) low = mid + 1;
    else high = mid;
  }
  return low;
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
 * The answer is found by walking `path`'s ancestor prefixes from the longest —
 * `path` itself, then each prefix ending at one of its `/` boundaries, then
 * `""` — and asking the sorted roots for each: every root that can own `path`
 * IS one of those ancestors (`path === root`, `path.startsWith(root + "/")`,
 * or `root === ""`), ancestors strictly shorten as the walk strips segments,
 * and a longer ancestor sorts after a shorter one, so the first ancestor the
 * roots contain is the longest match. That turns the per-file, per-context
 * linear scan over every project into one sort per run plus a walk of
 * `log(projects)` comparisons per ancestor — the O(files × projects) term that
 * dominated very large monorepos (cf. #369): on the issue's shape, 5,000
 * projects and 200,000 files, the scan performed 1,000,000,000 root tests
 * where the walk performs about 8,000,000 comparisons, its one-time sort
 * included.
 *
 * @param {{ name: string, root: string }[]} projects
 * @param {string} path Workspace-relative.
 * @returns {{ name: string, root: string }|null}
 */
export function projectOwning(projects, path) {
  const { roots, entries } = ownershipIndexOf(projects);
  let candidate = path;
  for (;;) {
    const i = firstRootAtOrAfter(roots, candidate);
    rootComparisons++;
    if (i < roots.length && roots[i] === candidate) return entries[i];
    if (candidate === "") return null;
    const cut = candidate.lastIndexOf("/");
    candidate = cut === -1 ? "" : candidate.slice(0, cut);
  }
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
 * The hook-boundary posture every manifest reader and name index holds (#364):
 * a graph resolver whose model reports could-not-complete failures throws
 * rather than returning the edges it managed to draw. The CLI funnel turns the
 * same failure list into exit 3; the Nx hook has exactly one loud output — a
 * throw, which Nx wraps and turns into a failed graph computation — so the
 * throw is what keeps `nx affected` from under-selecting on a broken reactor.
 * The rule and its boundary (manifests and indexes throw; per-source import
 * reads keep the null-read posture) are argued once, in
 * `../../graph/create-dependencies.mjs`'s header.
 *
 * @param {string} reader The reader the failures came from, for the message's
 *   first sentence ("the Maven model", "the JVM package index", …).
 * @param {{ sourceFile: string, reason: string }[]} failures Whole-reader
 *   could-not-complete failures, as the models and indexes record them.
 * @returns {void} Nothing when the list is empty — a clean reader never calls
 *   attention to itself.
 * @throws {Error} naming every failing file and its reason.
 */
export const refuseUnreadTree = (reader, failures) => {
  if (failures.length === 0) return;
  const listed = failures.map(({ sourceFile, reason }) => `${sourceFile} (${reason})`);
  throw new Error(
    `archkeep: ${reader} could not fully read this tree — refusing to compute a ` +
      `graph over it: ${listed.join("; ")}. Fix or remove the files above: an edge ` +
      `quietly omitted for an unreadable manifest is the under-selection this ` +
      `plugin exists to close.`,
  );
};

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

/**
 * One whole-file failure per source file, first reason kept.
 *
 * The funnel that merges every failure source (`../commands/context.mjs`)
 * can legitimately hear about the same unreadable file twice — the language
 * analyzer's own read failure AND the package/namespace index's row for the
 * same file (`.NET`'s `dotnetIndexFailures`, the JVM's `jvmIndexFailures`).
 * The two rows state one fact — "this file could not be analyzed" — and a
 * consumer counting rows would be told "2 files" when one file failed, which
 * is exactly the kind of wrong number a report must not carry. Positioned
 * failures pass through untouched: several blind spots in one file are
 * several distinct facts, one per import site.
 *
 * @param {{ sourceFile: string, line: number|null }[]} failures
 * @returns {{ sourceFile: string, line: number|null }[]} Same order, whole-
 *   file rows deduplicated by `sourceFile`.
 */
export const dedupeWholeFileFailures = (failures) => {
  const seen = new Set();
  return failures.filter((failure) => {
    if (!isWholeFileFailure(failure)) return true;
    if (seen.has(failure.sourceFile)) return false;
    seen.add(failure.sourceFile);
    return true;
  });
};

/**
 * The markdown document track: machine-readable markers inside tracked
 * documents, resolved to graph edges the existing tag rows judge.
 *
 * A boundary law can declare a `markdown` block (`../config.mjs`'s
 * `findMarkdownViolations` owns the shape): a set of document globs and a set
 * of marker rows, each a regular expression whose first capture group names an
 * exported symbol — the `<!-- @api Button -->` an architecture-intent
 * document pairs with the component it documents. This module turns those
 * markers into `{source, target, type}` edges: source is the project that owns
 * the document, target is the project that exports the named symbol, and the
 * type is the row's declared edge kind (`resolvedExportOwner`, the one kind
 * today). Everything downstream of the fold is machinery that already existed:
 * `../providers/native/graph.mjs`'s `mergeDeclaredEdges` folds the edges into
 * the graph the way it folds the declared manifest track, and
 * `../rules/edge-constraints.mjs`'s `judgeEdge` — the same function
 * `declaredEdgeViolationsForCheck` runs `implicit` edges through — decides
 * each one against `depConstraints`. No rule knows this track exists, which is
 * the point: a document pairing is a project-to-project claim, and the claims
 * a workspace already wrote are the ones that should judge it.
 *
 * ## What this module deliberately is not
 *
 * It does not render markdown, lint prose, or index free text. The only bytes
 * read past the extension are lines matched by a configured marker row —
 * declared, machine-readable claims, the same contract the declared manifest
 * track reads a pom or a csproj under. A document whose every line matches no
 * row contributes nothing, and a workspace that declares no `markdown` block
 * pays nothing at all: the fold is unreachable without the block, so a
 * config-absent run is byte-identical to one this module never existed for.
 *
 * ## The export index, and why re-exports cannot own a symbol
 *
 * Resolution asks "which project publishes `Button`", and the engine has no
 * export table to ask — so the fold builds one, scanning every project-owned
 * TypeScript-language file's top-level exports once (`./typescript.mjs`'s
 * `exportedNamesOf`; `.vue` single-file components are not scanned, because
 * their public surface is the TypeScript barrel that re-exports it, and the
 * barrel is scanned). Names are kept in two tiers: a name a file DECLARES is
 * its project's, and wins over any number of projects that merely RE-EXPORT
 * it — an umbrella barrel re-exporting a library must not turn that library's
 * every symbol into an ambiguous claim. A name in neither tier is a document
 * claim the graph cannot honor, and the marker's file fails whole: a pairing
 * the tree cannot establish must never read as a clean one (`../../../AGENTS.md`,
 * "an empty result is a claim, not a shrug") — the same refusal posture the
 * declared manifest track holds for a pom it cannot read, and for the same
 * reason: the run would otherwise report a verdict computed over a track that
 * silently dropped a declared edge.
 */

import { safeMatchesGlob } from "../rules/match.mjs";
import { exportedNamesOf } from "./typescript.mjs";
import { languageOf } from "./registry.mjs";
import { fileFailure } from "./source-util.mjs";

/** The extension a file must carry to be a candidate document. */
const MARKDOWN_EXTENSION = ".md";

/**
 * The document track's fold, over an already-built context: every marker the
 * law's rows match in every document the law's globs include, resolved against
 * the workspace's exports.
 *
 * Edges are returned deduped by `(source, target, type)` — two markers in two
 * documents naming the same symbol are one dependency at project grain, the
 * same grain every other track reports at — and the caller folds them into the
 * graph with `../providers/native/graph.mjs`'s `mergeDeclaredEdges`, which
 * enforces the same key against the edges already there.
 *
 * Failures are WHOLE-FILE failures on the document that earned them, never
 * positioned rows: a marker the tree cannot resolve means the document's
 * pairing claim went unjudged, so the file has no verdict to claim and the
 * run's coverage says so (`unchecked`), with the reason naming the line and
 * the name. A positioned row would read as a resolved no — a verdict the run
 * does not hold.
 *
 * @param {{ tracked: string[], owned: {file: string, project: string}[],
 *   readFile: (path: string) => string|null, workspace: object,
 *   markdown: {include: string[], markers: {pattern: string, edge: string}[]} }} input
 *   `tracked` in the caller's file order (the run's determinism basis),
 *   `owned` the context's file→project map, `readFile` the workspace's own
 *   reader, `markdown` the loaded policy's markdown block.
 * @returns {{ edges: {source: string, target: string, type: string}[],
 *   claims: {source: string, target: string, type: string, file: string,
 *   line: number, column: number, name: string}[],
 *   failures: {sourceFile: string, reason: string}[], documents: number,
 *   judged: number, resolved: number, selfPaired: number,
 *   includeCounts: number[], rowMatches: number[] }}
 *   `edges` is the deduped graph fold; `claims` is the same resolution at
 *   marker grain — one record per resolved marker, carrying the document
 *   position the caller's verdicts must point at, which the deduped list
 *   deliberately does not. `documents` counts the files the include globs
 *   selected and read. `judged` counts markers extracted, `resolved` the
 *   ones that became an edge, `selfPaired` the ones whose document and symbol
 *   live in the same project (a legal claim that draws no edge — a project
 *   cannot depend on itself, the rule every track holds), `includeCounts` the
 *   per-pattern document counts and `rowMatches` the per-row match counts the
 *   caller's dead-law gate reads.
 */
export function foldMarkdownTrack({ tracked, owned, readFile, workspace, markdown }) {
  const documents = markdownIncludedFiles({ include: markdown.include, tracked });
  const includeCounts = markdown.include.map(
    (pattern) => documents.filter((file) => matchesInclude(file, pattern)).length,
  );
  /** @type {{ row: number, file: string, line: number, column: number, name: string }[]} */
  const markers = [];
  /** @type {{sourceFile: string, reason: string}[]} */
  const failures = [];
  const rowMatches = markdown.markers.map(() => 0);
  /** @type {(RegExp|null)[]} */
  const compiled = markdown.markers.map((row) => {
    try {
      return new RegExp(row.pattern, "u");
    } catch {
      // Load-time validation refuses an uncompilable pattern; this arm exists
      // so a hand-built config in a test degrades to "this row matches
      // nothing" instead of throwing past every caller that guards.
      return null;
    }
  });

  for (const file of documents) {
    const text = readFile(file);
    if (text === null) {
      failures.push(
        fileFailure(
          file,
          "cannot be read — the markdown track matched it, so its markers cannot be extracted " +
            "and its document claims cannot be judged",
        ),
      );
      continue;
    }
    const lines = text.split("\n");
    for (const [rowIndex, regex] of compiled.entries()) {
      if (regex === null) continue;
      for (const [at, line] of lines.entries()) {
        const match = regex.exec(line);
        if (match === null) continue;
        rowMatches[rowIndex] += 1;
        const name = match[1] ?? "";
        if (name.trim() === "") {
          failures.push(
            fileFailure(
              file,
              `line ${at + 1}: the marker matches markdown.markers[${rowIndex}] but captures an ` +
                `empty name — the row's first capture group must carry the exported symbol the ` +
                `document claims`,
            ),
          );
          continue;
        }
        markers.push({ row: rowIndex, file, line: at + 1, column: (match.index ?? 0) + 1, name });
      }
    }
  }

  const edges = [];
  /** @type {{source: string, target: string, type: string, file: string,
   * line: number, column: number, name: string}[]} */
  const claims = [];
  let resolved = 0;
  let selfPaired = 0;
  if (markers.length > 0) {
    const projectOfFile = new Map(owned.map(({ file, project }) => [file, project]));
    const index = exportIndexOf({ owned, readFile, workspace });
    for (const marker of markers) {
      // Declared beats re-exported: see this file's header. Candidates are
      // sorted because a Set's insertion order is file order, and a message
      // that names two projects must not name them in a different order on a
      // different checkout.
      const declaredOwners = index.declared.get(marker.name);
      const candidates = declaredOwners ?? index.reexported.get(marker.name) ?? new Set();
      if (candidates.size === 0) {
        failures.push(
          fileFailure(
            marker.file,
            `line ${marker.line}: the marker names '${marker.name}', which no tracked project ` +
              `exports — the pairing this document claims cannot be resolved to a project, so ` +
              `its edge was not drawn. Exports are scanned from TypeScript-language project ` +
              `files; either the symbol does not exist, is not exported from a project file, or ` +
              `its name is misspelt here`,
          ),
        );
        continue;
      }
      if (candidates.size > 1) {
        failures.push(
          fileFailure(
            marker.file,
            `line ${marker.line}: the marker names '${marker.name}', which more than one project ` +
              `exports — ${[...candidates]
                .sort()
                .map((name) => `'${name}'`)
                .join(", ")} — and a ` +
              `claim this tree cannot read one way must not be read as kept. Qualify the marker ` +
              `or narrow the export surface so the name resolves to one project`,
          ),
        );
        continue;
      }
      const source = projectOfFile.get(marker.file);
      const [target] = candidates;
      if (source === undefined) {
        failures.push(
          fileFailure(
            marker.file,
            `line ${marker.line}: the document is owned by no project, so the edge its marker ` +
              `claims has no source — include the document's directory in a project, or narrow ` +
              `markdown.include to documents that live inside one`,
          ),
        );
        continue;
      }
      if (source === target) {
        // A document pairing its own project's symbol: a legal claim that
        // carries no boundary weight — no project depends on itself, the rule
        // `buildDependencies` holds for every track — but a claim the row DID
        // match and resolve, so it counts as judged rather than vanishing.
        selfPaired += 1;
        continue;
      }
      resolved += 1;
      const edge = { source, target, type: markdown.markers[marker.row].edge };
      edges.push(edge);
      claims.push({
        ...edge,
        file: marker.file,
        line: marker.line,
        column: marker.column,
        name: marker.name,
      });
    }
  }

  return {
    edges: dedupeEdges(edges),
    claims,
    failures,
    documents: documents.length,
    judged: markers.length,
    resolved,
    selfPaired,
    includeCounts,
    rowMatches,
  };
}

/**
 * The tracked documents the law's globs select — tracked order preserved, and
 * restricted to markdown files: the track reads documents, and a glob whose
 * every match is some other kind of file selects nothing (loudly — the
 * caller's dead-law gate counts what each pattern actually matched).
 *
 * Exported for the dead-law gate and its tests, which need the same selection
 * the fold makes without re-deriving it a second way.
 *
 * @param {{include: string[], tracked: string[]}} input
 * @returns {string[]}
 */
export function markdownIncludedFiles({ include, tracked }) {
  // used by its own test
  return tracked.filter(
    (file) =>
      file.endsWith(MARKDOWN_EXTENSION) && include.some((pattern) => matchesInclude(file, pattern)),
  );
}

/**
 * Whether a tracked file matches one include pattern — `./rules/match.mjs`'s
 * `safeMatchesGlob`, the one matcher `boundarySuppressions` and
 * `coverage.exempt` rows use, so a glob spells the same language here it does
 * everywhere else in the policy.
 *
 * @param {string} file Workspace-relative path.
 * @param {string} pattern Workspace-relative glob.
 * @returns {boolean}
 */
function matchesInclude(file, pattern) {
  return safeMatchesGlob(file, pattern);
}

/**
 * The workspace's export index, built once per fold: every project-owned
 * TypeScript-language file's exported names, keyed by name to the set of
 * projects that declare or re-export them.
 *
 * A file whose read fails contributes nothing — and no failure of its own:
 * that file's analysis already reports the read to the caller's own funnel,
 * and a second row naming the same bytes would count one hole twice. A file
 * whose parse fails contributes what TypeScript could read, the posture
 * `exportedNamesOf` itself holds.
 *
 * @param {{ owned: {file: string, project: string}[], readFile: (path: string) => string|null,
 *   workspace: object }} input
 * @returns {{ declared: Map<string, Set<string>>, reexported: Map<string, Set<string>> }}
 */
function exportIndexOf({ owned, readFile, workspace }) {
  /** @type {Map<string, Set<string>>} */
  const declared = new Map();
  /** @type {Map<string, Set<string>>} */
  const reexported = new Map();
  const add = (map, names, project) => {
    for (const name of names) {
      if (name === "") continue;
      const holders = map.get(name) ?? new Set();
      holders.add(project);
      map.set(name, holders);
    }
  };
  for (const { file, project } of owned) {
    // `.vue` single-file components are TypeScript too, but their script
    // blocks live behind the SFC parser (`./vue.mjs`), and this index needs
    // only what a barrel already re-exports — see this file's header.
    if (languageOf(file) !== "typescript") continue;
    const text = readFile(file);
    if (text === null) continue;
    const names = exportedNamesOf({ sourceFile: file, text, workspace });
    add(declared, names.declared, project);
    add(reexported, names.reexported, project);
  }
  return { declared, reexported };
}

/**
 * One edge per `(source, target, type)` — the same canonical key
 * `buildDependencies` reduces import sites by, applied here so the fold's own
 * answer is canonical before the merge adds its dedup on top.
 *
 * @param {{source: string, target: string, type: string}[]} edges
 * @returns {{source: string, target: string, type: string}[]}
 */
function dedupeEdges(edges) {
  const seen = new Set();
  return edges.filter((edge) => {
    const key = JSON.stringify([edge.source, edge.target, edge.type]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

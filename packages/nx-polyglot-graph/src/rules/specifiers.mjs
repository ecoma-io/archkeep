/**
 * The rules decided on the raw import specifier — the text as written, before
 * anything resolves it.
 *
 * Four of the fifteen violations live here, and they are the reason the
 * analysis record keeps `specifier` verbatim instead of collapsing to a graph
 * edge (`../analysis/contract.md`, "superset of a graph edge"): the projects
 * involved can be entirely correct while the SPELLING is the violation.
 *
 * Upstream uses two relative-path predicates that differ by two characters, in
 * different places, deliberately or otherwise:
 *
 *   isRelative(s)      './' or '../'                       — used to decide
 *                      whether a specifier is a path worth resolving
 *   isRelativePath(s)  '.', '..', './' or '../'            — used to decide
 *                      whether an unresolvable import is a path at all, and
 *                      whether a self-import is spelled relatively
 *
 * A bare `.` or `..` is therefore a path to one and a package name to the
 * other, and collapsing them changes which rule fires on `import x from ".."`.
 * Only the first lives here. The second was a question about SPELLING, and
 * spelling is per-language: `.`, `..`, `./`, `../` is JavaScript's shape, while
 * Rust spells the same idea `crate::`/`self::`/`super::` and Python spells it
 * `.mod`/`..pkg`. It moved to the layer that knows which language it is reading
 * — every record now carries `spelling` (`../analysis/contract.md`), and
 * `isRelativePath`'s text lives on as `specifierSpelling` in
 * `../analysis/typescript.mjs`, applied to the family it was written for.
 *
 * `isRelative` stays because its caller below is path ARITHMETIC rather than a
 * judgement about spelling: it joins the specifier onto the source file's
 * directory, which only a filesystem path can survive.
 */
import { posix } from "node:path";
import { isBuiltin } from "node:module";

import { mapGlobToRegExp } from "./match.mjs";
import { findConstraintsFor } from "./tags.mjs";
import { pathExists } from "./reachability.mjs";

/**
 * Nx's default `workspaceLayout`. Applied when the graph does not carry one,
 * because upstream applies exactly this default when `nx.json` omits the key —
 * the value is intrinsic to the upstream contract, not a preference of ours
 * (Rule 14 rung 3), and getting it wrong changes which imports count as
 * "absolute into another project".
 */
export const DEFAULT_WORKSPACE_LAYOUT = Object.freeze({ libsDir: "libs", appsDir: "apps" });

/** `./x` or `../x` — upstream's `isRelative`, from `runtime-lint-utils`. */
export function isRelative(s) {
  return s.startsWith("./") || s.startsWith("../");
}

/**
 * The package a specifier belongs to: `@scope/pkg` for `@scope/pkg/deep/path`,
 * `pkg` for `pkg/deep/path`. Port of nx's `getPackageNameFromImportPath`.
 */
export function getPackageNameFromImportPath(importExpression) {
  if (importExpression.startsWith("@")) {
    return importExpression.split("/").slice(0, 2).join("/");
  }
  return importExpression.split("/")[0];
}

/**
 * Node built-ins, including the experimental ones Nx lists explicitly.
 *
 * `node:module`'s `isBuiltin` is the same function Nx calls, so the answer
 * agrees by construction rather than by a list we would have to maintain. It is
 * a Node built-in itself, so importing it keeps this layer's "built-ins only"
 * rule intact and adds no I/O — the check is a table lookup.
 *
 * It answers for NODE, and this engine also judges Go, Rust and Python. A Go
 * import of `net/http` reduces to the package `net`, which Node also has, so it
 * is treated as a built-in here. The only consequence is that
 * `banTransitiveDependencies` does not fire on it — the direction that produces
 * no false alarm, and `bannedExternalImports` still sees it (see `./index.mjs`,
 * which synthesises an external node for an external record whose specifier
 * names a package; a path names none and gets none).
 */
export function isBuiltinModuleImport(importExpr) {
  const packageName = getPackageNameFromImportPath(importExpr);
  return isBuiltin(packageName) || packageName === "node:sqlite";
}

/** Nx's `normalizeProjectRoot`: `''` is the workspace root, trailing `/` goes. */
export function normalizeProjectRoot(root) {
  const value = root === "" ? "." : root;
  return value && value.endsWith("/") ? value.substring(0, value.length - 1) : value;
}

/**
 * `projectRoot → projectName`, the map every path lookup walks.
 *
 * @param {Record<string, {data: {root: string}}>} nodes
 * @returns {Map<string, string>}
 */
export function createProjectRootMappings(nodes) {
  const mappings = new Map();
  for (const [name, node] of Object.entries(nodes)) {
    mappings.set(normalizeProjectRoot(node.data.root), name);
  }
  return mappings;
}

/**
 * The project owning a workspace-relative path, by walking up its directories
 * until one is a project root. Port of nx's `findProjectForPath`, with POSIX
 * path semantics fixed in — the analysis contract states every path it emits is
 * workspace-relative and `/`-separated, so there is no platform to detect.
 *
 * @returns {string|undefined} project name.
 */
export function findProjectForPath(filePath, projectRootMappings) {
  let currentPath = filePath;
  for (; currentPath !== posix.dirname(currentPath); currentPath = posix.dirname(currentPath)) {
    const found = projectRootMappings.get(currentPath);
    if (found) return found;
  }
  return projectRootMappings.get(currentPath);
}

/**
 * Is this specifier an absolute path into another project — `libs/foo/bar`,
 * `/apps/baz`? Port of `isAbsoluteImportIntoAnotherProject`.
 *
 * Note what it does NOT do: it never checks that the path lands in a different
 * project than the source. Writing `libs/foo/x` from inside `libs/foo` is
 * reported too, because the spelling is the violation.
 */
export function isAbsoluteImportIntoAnotherProject(
  imp,
  workspaceLayout = DEFAULT_WORKSPACE_LAYOUT,
) {
  return (
    imp.startsWith(`${workspaceLayout.libsDir}/`) ||
    imp.startsWith(`/${workspaceLayout.libsDir}/`) ||
    imp.startsWith(`${workspaceLayout.appsDir}/`) ||
    imp.startsWith(`/${workspaceLayout.appsDir}/`)
  );
}

/**
 * The project a relative specifier points into, by path arithmetic alone — no
 * extension probing, no `exports` conditions, exactly as upstream does it. A
 * relative import is judged on where its text lands in the tree, so it needs no
 * module resolver and this layer stays free of one.
 *
 * @returns {string|undefined} project name.
 */
export function getTargetProjectBasedOnRelativeImport(imp, sourceFile, projectRootMappings) {
  if (!isRelative(imp)) return undefined;
  const resolved = posix.normalize(posix.join(posix.dirname(sourceFile), imp));
  // Upstream resolves against an absolute workspace root, so a specifier
  // climbing out of the workspace clamps at `/` and then produces a nonsense
  // relative path. Here it stays visible as a leading `..`, and nothing outside
  // the workspace can be in a project — so there is no target, which is the
  // same verdict by a route that cannot accidentally match a project.
  if (resolved === ".." || resolved.startsWith("../")) return undefined;
  return findProjectForPath(resolved, projectRootMappings);
}

/**
 * Does this constraint ban this external import? Port of
 * `isConstraintBanningProject`, whose three steps each hide something:
 *
 * 1. The constraint only speaks about imports OF THIS PACKAGE. `imp` must be
 *    the package name itself or a path under it, otherwise the row is silent —
 *    which is what makes `nestedBannedExternalImportsViolation` so hard to
 *    trigger (see `hasBannedDependencies`).
 * 2. `bannedExternalImports` is matched with `mapGlobToRegExp` against the FULL
 *    specifier, so `@scope/pkg/*` bans the deep paths while leaving the entry
 *    point importable, and `@scope/pkg*` bans both.
 * 3. `allowedExternalImports` is an allowlist evaluated with `.every()`: an
 *    import is banned when it matches NONE of the entries. Two consequences —
 *    an absent list bans nothing (`undefined?.every` short-circuits), and an
 *    EMPTY list `[]` bans every import of the package, because `[].every()` is
 *    `true`. The empty case reads like "no restrictions" and means the opposite.
 *
 * @returns {boolean}
 */
export function isConstraintBanningProject(externalProject, constraint, imp) {
  const { allowedExternalImports, bannedExternalImports } = constraint;
  const { packageName } = externalProject.data;
  if (imp !== packageName && !imp.startsWith(`${packageName}/`)) return false;
  if (bannedExternalImports?.some((definition) => mapGlobToRegExp(definition).test(imp))) {
    return true;
  }
  return Boolean(
    allowedExternalImports?.every(
      (definition) => !imp.startsWith(packageName) || !mapGlobToRegExp(definition).test(imp),
    ),
  );
}

/**
 * The first constraint (matching the source project) that bans this external
 * import, or `undefined`.
 *
 * Upstream re-derives the source-matching filter inline here; it is
 * `findConstraintsFor` spelled a second way, so this calls the one
 * implementation rather than keeping a second that could drift. `find`, not
 * `filter`: one violation is reported, naming the first row that objects.
 */
export function hasBannedImport(sourceProject, targetProject, depConstraints, imp) {
  return findConstraintsFor(depConstraints, sourceProject).find((constraint) =>
    isConstraintBanningProject(targetProject, constraint, imp),
  );
}

/**
 * Every external dependency reachable from `source`, including its own.
 * Only computed when `checkNestedExternalImports` is on.
 *
 * @returns {{source: string, target: string, type?: string}[]}
 */
export function findTransitiveExternalDependencies(graph, reach, source) {
  if (!graph.externalNodes) return [];
  const externalDependencies = [];
  for (const projectName of Object.keys(graph.nodes)) {
    if (!pathExists(reach, source.name, projectName)) continue;
    for (const dependency of graph.dependencies?.[projectName] ?? []) {
      if (graph.externalNodes[dependency.target]) externalDependencies.push(dependency);
    }
  }
  return externalDependencies;
}

/**
 * The nested external dependencies this constraint bans, as
 * `[externalNode, violatingSourceNode, constraint]` triples.
 *
 * **Read the `imp` argument carefully.** It is the specifier of the import
 * being judged — which, at this point in the pipeline, resolves to a PROJECT,
 * not to any of the external packages being scanned. `isConstraintBanningProject`
 * returns false immediately unless that specifier is the nested package's name
 * or a path under it, so this fires only where a project's import alias and a
 * transitively-reachable package name coincide. That is upstream's behaviour in
 * `@nx/eslint-plugin` 23.1.1, reproduced rather than corrected: this engine's
 * contract is to agree with ESLint's verdict, and a "fixed" version here would
 * report violations ESLint does not, breaking the parity that makes the two
 * comparable. It is recorded as a finding instead.
 */
export function hasBannedDependencies(externalDependencies, graph, constraint, imp) {
  return externalDependencies
    .filter((dependency) =>
      isConstraintBanningProject(graph.externalNodes[dependency.target], constraint, imp),
    )
    .map((dep) => [graph.externalNodes[dep.target], graph.nodes[dep.source], constraint]);
}

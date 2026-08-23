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

import { assertMatchableSpecifier, mapGlobToRegExp } from "./match.mjs";
import { findConstraintsFor } from "./tags.mjs";
import { pathExists } from "./reachability.mjs";

/**
 * Nx's default `workspaceLayout`. Applied when the graph does not carry one,
 * because upstream applies exactly this default when `nx.json` omits the key —
 * the value is intrinsic to the upstream contract, not a preference of ours, and
 * getting it wrong changes which imports count as "absolute into another
 * project".
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
 * This is the door where a specifier meets a pattern the consumer wrote, and
 * so where the specifier's LENGTH is bounded — `./match.mjs`'s
 * `MAX_SPECIFIER_LENGTH` carries the measurement and
 * `assertMatchableSpecifier` the reason it throws instead of returning
 * `false`. The bound is checked before the package test rather than after,
 * because the question it answers is not "does this row speak about this
 * import" but "can this import be judged at all": a specifier this engine
 * declines to match is unjudged wherever it appears, and an unjudged site
 * reported as clean is the one outcome `../../../../AGENTS.md` ranks below a
 * wrong answer.
 *
 * @returns {boolean}
 */
export function isConstraintBanningProject(externalProject, constraint, imp) {
  assertMatchableSpecifier(imp, "import specifier judged against the constraint table");
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
  // Both maps are keyed by NAME — project names in `dependencies`, package
  // names in `externalNodes` — and both arrive as plain objects from
  // `JSON.parse` of `nx graph --file=`, so every lookup below is an
  // `Object.hasOwn` membership test rather than an index-and-hope. A project
  // literally named `constructor`, `toString`, `valueOf`, `hasOwnProperty` or
  // `__proto__` is otherwise answered by `Object.prototype`, and both reads
  // break loudly and uselessly: `dependencies["constructor"]` yields the
  // `Object` constructor FUNCTION, which `?? []` does not replace (a function
  // is not nullish) and `for…of` then rejects — measured, `TypeError: function
  // is not iterable` — while `externalNodes["toString"]` classifies a real
  // internal project as an external package and hands it to
  // `isConstraintBanningProject`, which destructures `.data` off
  // `Function.prototype.toString` and throws. An enforcer that throws reports
  // nothing at all, which `../../AGENTS.md` ranks below a wrong answer.
  const dependencies = graph.dependencies ?? {};
  for (const projectName of Object.keys(graph.nodes)) {
    if (!pathExists(reach, source.name, projectName)) continue;
    if (!Object.hasOwn(dependencies, projectName)) continue;
    for (const dependency of dependencies[projectName] ?? []) {
      if (Object.hasOwn(graph.externalNodes, dependency.target)) {
        externalDependencies.push(dependency);
      }
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
  // Exported, so it is reachable with a list this module did not build — the
  // membership guard belongs here too, not only in
  // `findTransitiveExternalDependencies` above. Same failure either way: an
  // inherited `Object.prototype` member reaching `isConstraintBanningProject`
  // is destructured for `.data` and throws, and a checker that throws reports
  // nothing.
  //
  // BOTH maps, for the same reason and by the same test. `nodes` is read by
  // `dependency.source` and its value becomes the violation's
  // `childProjectName` (`./index.mjs`), so a source named `constructor` or
  // `toString` yields a `Function` where a project node belongs and the report
  // names `Object` — a project no workspace has — while an absent `nodes`
  // throws on the index. A project genuinely named `constructor` is an OWN key
  // and still answers here; only the inherited phantoms are dropped, and a
  // phantom source names no project to report against.
  const externalNodes = graph.externalNodes ?? {};
  const nodes = graph.nodes ?? {};
  return externalDependencies
    .filter(
      (dependency) =>
        Object.hasOwn(externalNodes, dependency.target) &&
        Object.hasOwn(nodes, dependency.source) &&
        isConstraintBanningProject(externalNodes[dependency.target], constraint, imp),
    )
    .map((dep) => [externalNodes[dep.target], nodes[dep.source], constraint]);
}

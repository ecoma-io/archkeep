/**
 * The rules decided on the shape of the graph rather than on the text of the
 * import: cycles, self-cycles, apps, e2e suites, buildability, lazy loading,
 * and transitive package use.
 *
 * Three of these need a fact `@nx/enforce-module-boundaries` reads off the
 * filesystem — a `module-federation.config.js`, a project's `package.json`
 * `exports`, the packages a manifest declares. A rule here reads records and
 * nothing else (`../rules/README.md`), so each such fact is an OPTIONAL field
 * on the graph node, and **its absence fails closed**: the enforcer assumes the
 * exemption does not apply and reports. A false alarm a maintainer can see and
 * fix is recoverable; a boundary that quietly stops being enforced is the
 * failure this tool exists to end. Each site below names which field would
 * change its answer.
 */
import { posix } from "node:path";

import { checkCircularPath, circularPathHasPair } from "./reachability.mjs";

/** Nx's `DependencyType.dynamic`, the edge kind a lazy-loaded lib arrives by. */
const DYNAMIC = "dynamic";

/**
 * Does this project have a build target? Port of `hasBuildExecutor`, including
 * the `executor !== ''` test — a target declared with an empty executor string
 * does not make a library buildable.
 */
export function hasBuildExecutor(project, buildTargets = ["build"]) {
  const targets = project.data?.targets;
  return Boolean(
    targets && buildTargets.some((target) => targets[target] && targets[target].executor !== ""),
  );
}

/**
 * Is this app a Module Federation remote, and therefore importable?
 *
 * Upstream reads `module-federation.config.{js,ts}` beside the project and
 * looks for an `exposes:` key. Here it is `data.mfeRemote`, supplied by whoever
 * builds the graph. **Absent means false**, so an unmarked app is reported —
 * the closed direction, since the alternative is exempting every app from
 * `noImportsOfApps` on a fact we never checked.
 */
export function appIsMFERemote(project) {
  return project.data?.mfeRemote === true;
}

/**
 * The entry point a file belongs to, or `undefined`. Port of upstream's
 * `getEntryPoint`, over `data.entryPoints` (`{path, file}` pairs, the shape its
 * `parseExports` builds from a `package.json` `exports` map) instead of over
 * the filesystem.
 *
 * Not reproduced: upstream's `ng-package.json` fallback, which reads a file per
 * directory walked. A project with no entry-point data answers `undefined`
 * here, which is exactly what upstream answers for a library with no `exports`
 * — the common case, and the one that keeps `noSelfCircularDependencies` armed.
 */
export function entryPointOf(file, projectRoot, entryPoints) {
  // used by its own test
  if (!entryPoints || entryPoints.length === 0) return undefined;
  const fileEntryPoint = entryPoints.find((entry) => entry.file === file);
  if (fileEntryPoint) return fileEntryPoint.file;

  let parent = posix.join(file, "../");
  // Upstream's loop is `while (parent !== projectRoot + '/')` with no floor: a
  // file outside the project root walks past `.` and grows a `../` per turn,
  // forever. The `startsWith` exit is ours — a hung enforcer reports nothing at
  // all, which is the one outcome worse than a wrong answer.
  while (parent !== `${projectRoot}/` && parent.startsWith(`${projectRoot}/`)) {
    // `parent` always carries a trailing slash (`join(file, '../')` keeps it)
    // and an entry point's `path` never does (upstream builds it with
    // `joinPathFragments(projectRoot, basePath)`), so for entry points shaped
    // the way upstream shapes them this comparison cannot match and the walk
    // finds nothing. Reproduced rather than repaired: "no entry point" is what
    // keeps `noSelfCircularDependencies` and the lazy-load check armed, so
    // repairing it would open a hole rather than close one.
    const entryPoint = entryPoints.find((entry) => entry.path === parent);
    if (entryPoint) return entryPoint.file;
    parent = posix.join(parent, "../");
  }
  return undefined;
}

/**
 * The entry point an import resolved into, or `undefined` when it did not
 * resolve to a file or the target declares no entry points. Port of
 * `getSecondaryEntryPointPath`, with the analysis record's `resolved.file`
 * standing in for upstream's module resolution — the resolver already ran; this
 * layer never runs a second one.
 */
function secondaryEntryPointPath(resolvedFile, targetProject) {
  if (!resolvedFile) return undefined;
  return entryPointOf(resolvedFile, targetProject.data.root, targetProject.data?.entryPoints);
}

/**
 * Is the importing file in a DIFFERENT entry point of its own project than the
 * one it imported? Port of `belongsToDifferentEntryPoint` — the escape hatch
 * that lets a secondary entry point import its own package by alias.
 *
 * With no entry-point data both sides are `undefined`, so they are equal, so
 * this is false and the self-circular rule fires. Closed by default.
 */
export function belongsToDifferentEntryPoint(resolvedFile, sourceFile, sourceProject) {
  const importEntryPoint = secondaryEntryPointPath(resolvedFile, sourceProject);
  const sourceEntryPoint = entryPointOf(
    sourceFile,
    sourceProject.data.root,
    sourceProject.data?.entryPoints,
  );
  return importEntryPoint !== sourceEntryPoint;
}

/**
 * The FIRST path of DYNAMIC edges from `source` to `target`, as
 * `[source, ..., target]`, or `null` when none exists. The walk behind
 * `hasDynamicImport`, made to return the route it took so a verdict and its
 * evidence can come from the same traversal: the old predicate answered
 * "yes" over a transitive chain while the message went looking for files on
 * the DIRECT pair alone and printed an empty list (`noImportsOfLazyLoadedLibraries`
 * saying nothing is issue #281's shape).
 *
 * Traversal order and cycle guard are exactly the predicate's original ones —
 * edges in array order, first hit wins, `visited.indexOf` at entry with
 * `[...visited, source]` handed down — because this function is that code,
 * not a reimplementation of it.
 *
 * @returns {string[]|null}
 */
export function findDynamicImportPath(graph, sourceProjectName, targetProjectName, visited = []) {
  // used by its own test
  if (visited.indexOf(sourceProjectName) > -1) return null;
  for (const dependency of graph.dependencies?.[sourceProjectName] ?? []) {
    if (dependency.type !== DYNAMIC) continue;
    if (dependency.target === targetProjectName) {
      return [...visited, sourceProjectName, dependency.target];
    }
    const rest = findDynamicImportPath(graph, dependency.target, targetProjectName, [
      ...visited,
      sourceProjectName,
    ]);
    if (rest !== null) return rest;
  }
  return null;
}

/**
 * Does `source` reach `target` through any chain of DYNAMIC edges? Port of
 * upstream's `hasDynamicImport`, recursion and visited-list included — kept as
 * its own export because the lazy-load rule reads as a boolean at every call
 * site, but it now delegates to `findDynamicImportPath` rather than walking
 * separately: two traversals of one graph could disagree about which chain
 * fired, and then the verdict would name evidence for a route nobody walked.
 */
export function hasDynamicImport(graph, sourceProjectName, targetProjectName) {
  // used by its own test
  return findDynamicImportPath(graph, sourceProjectName, targetProjectName) !== null;
}

/**
 * Is this external package declared as a direct dependency of the importing
 * project?
 *
 * Upstream reads the workspace root's `package.json` and the source project's,
 * checking `dependencies`, `devDependencies` and `peerDependencies`. Here it is
 * `data.declaredPackages` on the source node — the union of both manifests,
 * assembled by whoever builds the graph. **Absent means "cannot prove it",
 * which counts as not direct**, so with `banTransitiveDependencies` on and no
 * such data every external import is reported. That is deliberately noisy: the
 * option is off by default, and a wall of violations sends a maintainer to
 * populate the field, where a silent pass would leave the option looking
 * enforced while enforcing nothing.
 */
export function isDirectDependency(sourceProject, externalProject) {
  const declared = sourceProject.data?.declaredPackages;
  if (!declared) return false;
  return declared.includes(externalProject.data.packageName);
}

/** `source → target` as one string, the key both file indexes are built on. */
const edgeKey = (source, target) => `${source}\0${target}`;

/**
 * An index of which FILES carry which project-to-project edge, used only to
 * render the two messages that name files.
 *
 * Upstream reads Nx's cached `projectFileMap`. This is derived from the import
 * sites the engine was handed, so it describes exactly what was analyzed: hand
 * the engine one file and the chain it prints names one file. Detection never
 * depends on it — a cycle is found in the graph, not in this index — so a
 * partial index shortens a message and can never hide a violation.
 *
 * @param {{sourceFile: string, sourceProject: string, targetProject: string|null, dynamic: boolean}[]} edges
 * @returns {{any: Map<string, string[]>, dynamic: Map<string, string[]>}}
 */
export function createFileDependencyIndex(edges) {
  const index = { any: new Map(), dynamic: new Map() };
  const push = (map, key, file) => {
    const files = map.get(key);
    if (!files) map.set(key, [file]);
    else if (!files.includes(file)) files.push(file);
  };
  for (const edge of edges) {
    if (!edge.targetProject || edge.targetProject === edge.sourceProject) continue;
    const key = edgeKey(edge.sourceProject, edge.targetProject);
    push(index.any, key, edge.sourceFile);
    if (edge.dynamic) push(index.dynamic, key, edge.sourceFile);
  }
  return index;
}

/** The files carrying each hop of a path — one entry per consecutive pair. */
export function findFilesInCircularPath(fileIndex, circularPath) {
  // used by its own test
  const chain = [];
  for (let i = 0; i < circularPath.length - 1; i++) {
    chain.push(fileIndex.any.get(edgeKey(circularPath[i].name, circularPath[i + 1].name)) ?? []);
  }
  return chain;
}

/** The files that lazy-load `target` from inside `source`. */
export function findFilesWithDynamicImports(fileIndex, sourceProjectName, targetProjectName) {
  // used by its own test
  return fileIndex.dynamic.get(edgeKey(sourceProjectName, targetProjectName)) ?? [];
}

/**
 * The cycle this import would close, and the message data for it — or `null`
 * when there is no cycle, or when one of its hops is excused by
 * `ignoredCircularDependencies`.
 *
 * @returns {{messageId: string, data: object}|null}
 */
export function circularViolation({
  reach,
  graph,
  sourceProject,
  targetProject,
  sourceFile,
  fileIndex,
  ignored,
}) {
  // The path runs from the TARGET back to the SOURCE — see `checkCircularPath`,
  // which owns that direction so this rule and the reachability layer cannot
  // end up disagreeing about which way a cycle is walked.
  const circularPath = checkCircularPath(reach, graph, sourceProject, targetProject);
  if (circularPath.length === 0 || circularPathHasPair(circularPath, ignored)) return null;

  const circularFilePath = findFilesInCircularPath(fileIndex, circularPath);
  // Upstream's own spacer: indirect hops with several files print one file per
  // line so a terminal does not receive one enormous line.
  const spacer = "  ";
  return {
    messageId: "noCircularDependencies",
    data: {
      sourceProjectName: sourceProject.name,
      targetProjectName: targetProject.name,
      path: circularPath.reduce((acc, v) => `${acc} -> ${v.name}`, sourceProject.name),
      filePaths: circularFilePath
        .map((files) => files.filter((f) => typeof f === "string"))
        .map((files) =>
          files.length > 1
            ? `[${files.map((f) => `\n${spacer}${spacer}${f}`).join(",")}\n${spacer}]`
            : // Upstream indexes `files[0]` unguarded, printing `undefined` for a
              // hop with no file to blame. Ours can legitimately have none —
              // a manifest-declared edge carries no import site — and a blank
              // bullet names nothing, so the hop says what it is instead.
              (files[0] ?? "(no source file — a manifest declares this dependency)"),
        )
        .reduce((acc, files) => `${acc}\n- ${files}`, `- ${sourceFile}`),
    },
  };
}

/**
 * `noImportsOfLazyLoadedLibraries` — a static import of a library that is also
 * lazy-loaded somewhere, which would defeat the lazy loading.
 *
 * Only a static import can trigger it, and upstream is precise about which:
 * `node.type === ImportDeclaration && importKind !== 'type'`. A `require()`
 * call, a dynamic `import()`, a re-export and a type-only import are all
 * exempt. Of those the analysis contract can distinguish everything except
 * `require()`, which it records as `kind: "static"` like an `import` statement
 * — so a `require()` of a lazy-loaded library is reported here where ESLint
 * would stay silent. Failing closed, and named as a divergence rather than
 * discovered later as a mismatch.
 *
 * Detection and evidence are two different facts and this function keeps them
 * on one walk: the GRAPH decides that the target is lazy-loaded (an edge may
 * come from manifest metadata no analyzer ever read), while the file index only
 * describes what this run analyzed. So every outcome names something — the
 * files of each hop when they are known, annotated with the chain when it took
 * more than one hop, or an explicit sentence saying the graph carries the chain
 * but no analyzed `import()` backs any hop of it. The empty string the old code
 * rendered for a transitive hit printed "lazy-loaded in these files:" over
 * nothing — indistinguishable from a clean run, which is exactly the silent
 * direction this package exists to end (#281). A direct pair renders byte for
 * byte as before; only the cases that used to print nothing changed.
 *
 * @returns {{messageId: string, data: object}|null}
 */
export function lazyLoadedViolation({
  graph,
  sourceProject,
  targetProject,
  resolvedFile,
  fileIndex,
}) {
  const path = findDynamicImportPath(graph, sourceProject.name, targetProject.name);
  if (path === null) return null;
  if (secondaryEntryPointPath(resolvedFile, targetProject)) return null;
  // One file list per consecutive hop, deduped in first-seen order — a file
  // that carries several hops of the chain is still one file to open.
  const chain = path.join(" -> ");
  const seen = new Set();
  const files = [];
  for (let i = 0; i < path.length - 1; i++) {
    for (const file of findFilesWithDynamicImports(fileIndex, path[i], path[i + 1])) {
      if (!seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  }
  const filePaths =
    files.length > 0
      ? path.length > 2
        ? files.map((file) => `- ${file} (${chain})`).join("\n")
        : files.map((file) => `- ${file}`).join("\n")
      : `(the project graph carries dynamic edges along ${chain}, but no analyzed import() names any file on that path — the evidence index only knows the files this run analyzed)`;
  return {
    messageId: "noImportsOfLazyLoadedLibraries",
    data: {
      targetProjectName: targetProject.name,
      filePaths,
    },
  };
}

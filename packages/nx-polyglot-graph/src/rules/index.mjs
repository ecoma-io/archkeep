/**
 * The rule engine: import sites in, violations out, one pure function.
 *
 * This reproduces `@nx/enforce-module-boundaries` over `ImportSite` records
 * instead of an ESLint AST, so the same fifteen checks reach `.go`, `.rs` and
 * `.py` — the languages ESLint cannot read at all, and where a layer-violating
 * import passes `lint` today because the project's lint target runs `eslint
 * project.json` and eslint answers "File ignored because no matching
 * configuration was supplied" for a `.go` file.
 *
 * `.vue` is NOT one of them, though this header used to say so:
 * `eslint.config.mjs` gives it `vue-eslint-parser` and the boundary rule block
 * there carries no `files` filter, so upstream judges a single-file component
 * and the two engines agree on it (`../conformance/README.md`).
 *
 * ## The order is the semantics
 *
 * Upstream's `run()` is a chain of `report(); return;` — most sites produce AT
 * MOST ONE violation, and which one depends on the order the checks are written
 * in. An engine that collected every applicable violation would report a
 * different set for the same file. The order below is upstream's, and the two
 * places that can emit more than one violation are marked where they occur:
 * the npm branch (a transitive-dependency report does not stop the banned-import
 * check) and the nested-banned check (one report per offending package).
 *
 * ## Where this engine is stricter than upstream, and why never the other way
 *
 * The dangerous failure for a boundary checker is a false NEGATIVE: reporting
 * clean while a violation exists. That is strictly worse than today's state,
 * where ESLint is right about JS/TS and silent elsewhere — silence you know
 * about beats a green light you cannot trust. So every judgement call in this
 * directory resolves toward reporting, and each one says so at its site. The
 * ones that change a verdict are collected in `README.md` beside this file.
 *
 * ## What it may read
 *
 * Records and the loaded config. No filesystem, no git, no Nx — which is what
 * lets both the CLI and the language server share one verdict, and what lets a
 * test drive all fifteen rules from fixtures with no workspace at all.
 *
 * @see ../analysis/contract.md for the `ImportSite` shape this consumes.
 */
import { findBoundaryConfigViolations, suppressionCovers } from "../config.mjs";

import { matchImportWithWildcard, findMatchingProjects } from "./match.mjs";
import { renderMessage } from "./messages.mjs";
import {
  buildReachability,
  circularPathHasPair,
  expandIgnoredCircularDependencies,
} from "./reachability.mjs";
import {
  createProjectRootMappings,
  DEFAULT_WORKSPACE_LAYOUT,
  findProjectForPath,
  findTransitiveExternalDependencies,
  getPackageNameFromImportPath,
  getTargetProjectBasedOnRelativeImport,
  hasBannedDependencies,
  hasBannedImport,
  isAbsoluteImportIntoAnotherProject,
  isBuiltinModuleImport,
} from "./specifiers.mjs";
import {
  appIsMFERemote,
  belongsToDifferentEntryPoint,
  circularViolation,
  createFileDependencyIndex,
  hasBuildExecutor,
  isDirectDependency,
  lazyLoadedViolation,
} from "./topology.mjs";
import {
  constraintSourceTagLabel,
  emptyOnlyTagsViolation,
  findConstraintsFor,
  notTagsViolation,
  onlyTagsViolation,
} from "./tags.mjs";

export { MESSAGE_IDS, MESSAGES, renderMessage } from "./messages.mjs";

/**
 * One boundary violation, carrying what a terminal line and an LSP diagnostic
 * both need — plus the constraint row that fired, so a report can explain the
 * verdict instead of only stating it.
 *
 * `messageId` is upstream's id spelled exactly. That is what makes a
 * differential comparison against ESLint possible at all: two tools that both
 * say "error" agree on nothing until they name the same rule.
 *
 * @typedef {object} Violation
 * @property {string} sourceFile Workspace-relative path of the importing file.
 * @property {number} line 1-based.
 * @property {number} column 1-based.
 * @property {string} specifier The import as written.
 * @property {string} kind The import kind from the analysis record.
 * @property {string} messageId One of `MESSAGE_IDS`.
 * @property {string} message The rendered message, as ESLint would print it.
 * @property {string|null} sourceProject
 * @property {string|null} targetProject Project name, `npm:<package>` for an
 *   external target, or `null` when the import resolved to neither.
 * @property {object|null} constraint The `depConstraints` row that fired.
 * @property {object} data The message's interpolation values, so a formatter
 *   can re-render without re-deriving them.
 */

/**
 * A project graph, in Nx's own shape so an adapter is a rename at most.
 *
 * Four fields are OPTIONAL and exist because upstream reads them off disk while
 * a rule here may not. Each is documented at the check that uses it, and each
 * fails closed when absent:
 *
 *   `nodes[n].data.mfeRemote`        — `noImportsOfApps` exemption
 *   `nodes[n].data.entryPoints`      — secondary entry points
 *   `nodes[n].data.declaredPackages` — `noTransitiveDependencies`
 *   `workspaceLayout`                — `{libsDir, appsDir}`, Nx's default when absent
 *
 * @typedef {object} ProjectGraph
 * @property {Record<string, object>} nodes Project nodes, `type` one of
 *   `app` | `lib` | `e2e`, `data.root` workspace-relative.
 * @property {Record<string, object>} [externalNodes] npm nodes, keyed as Nx
 *   keys them (`npm:react`), each with `data.packageName`.
 * @property {Record<string, {source: string, target: string, type?: string}[]>} [dependencies]
 * @property {{libsDir: string, appsDir: string}} [workspaceLayout]
 */

/** Nx's own node kinds. Anything else is an external node. */
const isProjectGraphProjectNode = (node) =>
  node.type === "app" || node.type === "e2e" || node.type === "lib";

/**
 * How the analyzer says this specifier is spelled, or a loud failure.
 *
 * This layer used to answer for itself, with one predicate shaped like
 * JavaScript's `./x`. That is wrong in every language whose imports are names
 * rather than paths, and it was measurably wrong: `use super::product_name` and
 * a Rust binary calling its own package's library crate were both reported as
 * `noSelfCircularDependencies` on an untouched tree. The fact is per-language,
 * the analyzer knows the language and this layer does not, so the record
 * carries it (`../analysis/contract.md`).
 *
 * A record that omits it **throws** rather than defaulting to the JavaScript
 * shape. A default would let the next analyzer inherit this bug in silence,
 * which is precisely how this one survived four languages.
 */
function spellingOf(site) {
  const spelling = site.spelling;
  if (typeof spelling?.path !== "boolean" || typeof spelling?.relative !== "boolean") {
    throw new Error(
      `nx-polyglot-graph: ${site.sourceFile}:${site.line}:${site.column} imports ` +
        `'${site.specifier}' in a record carrying no \`spelling\` — the analysis contract ` +
        `requires \`{ path, relative }\` on every import site, because whether a specifier ` +
        `is a path and whether it stays inside its own project are per-language questions ` +
        `only the analyzer can answer. See src/analysis/contract.md.`,
    );
  }
  return spelling;
}

/**
 * A specifier that is a PATH rather than a package name: `.`, `..`, `./x`,
 * `../x`, or an absolute `/x` in the JavaScript family, and nothing at all in
 * Go, Rust or Python, whose specifiers are names.
 *
 * Named once because two places must ask the identical question — the external
 * node lookup refuses exactly what the `!targetProject` branch reports as
 * `noRelativeOrAbsoluteExternals`. Two spellings of one test could drift apart,
 * and the gap between them would be a site that is given no target and then
 * reported by nothing (Rule 14). Making the answer language-aware moved where
 * it is computed, not how many places compute it.
 */
const isPathSpecifier = (site) => spellingOf(site).path;

/**
 * Everything the per-site evaluation needs, computed once for the whole run.
 * Building it per site would recompute the reachability matrix for every
 * import in the workspace.
 */
function createContext(importSites, graph, config) {
  if (!graph || typeof graph !== "object" || typeof graph.nodes !== "object" || !graph.nodes) {
    throw new Error("nx-polyglot-graph: evaluate() needs a project graph with a `nodes` map");
  }
  const violations = findBoundaryConfigViolations({
    depConstraints: config?.depConstraints,
    moduleBoundaryOptions: config?.options,
    boundarySuppressions: config?.suppressions,
  });
  if (violations.length > 0) {
    throw new Error(
      `nx-polyglot-graph: the boundary config given to evaluate() is malformed:\n  ` +
        violations.join("\n  "),
    );
  }

  // Checked for the whole run before any verdict, not lazily per branch: a
  // record whose analyzer never learned the question would otherwise be judged
  // silently everywhere the check does not happen to fall.
  for (const site of importSites) spellingOf(site);

  const mappings = createProjectRootMappings(graph.nodes);
  const reach = buildReachability(graph);
  // The file index describes what was analyzed, not what exists — see
  // `createFileDependencyIndex`. Built from the same records the rules judge so
  // there is one view of the tree, not two that can disagree.
  const fileIndex = createFileDependencyIndex(
    importSites.map((site) => ({
      sourceFile: site.sourceFile,
      sourceProject: findProjectForPath(site.sourceFile, mappings),
      targetProject: site.resolved?.target ?? null,
      dynamic: site.kind === "dynamic",
    })),
  );
  const externalByPackage = new Map();
  for (const node of Object.values(graph.externalNodes ?? {})) {
    if (node.data?.packageName) externalByPackage.set(node.data.packageName, node);
  }
  return {
    graph,
    depConstraints: config.depConstraints,
    options: config.options,
    suppressions: config.suppressions ?? [],
    workspaceLayout: graph.workspaceLayout ?? DEFAULT_WORKSPACE_LAYOUT,
    mappings,
    reach,
    fileIndex,
    externalByPackage,
    synthesizedExternals: new Map(),
    ignored: expandIgnoredCircularDependencies(
      config.options.ignoredCircularDependencies,
      graph,
      findMatchingProjects,
    ),
  };
}

/**
 * The external node an external specifier points at, or `undefined` when the
 * specifier is a path and so points at no package at all.
 *
 * Upstream looks the package up in `projectGraph.externalNodes` and BAILS when
 * it is not there — no target, no check. This engine synthesises one instead,
 * and that difference is deliberate: `src/graph/` does not register crates,
 * PyPI distributions or Go modules as external nodes (project CLAUDE.md — only
 * project↔project edges matter to `nx affected`), so bailing would mean
 * `bannedExternalImports` silently never fires for any language but JavaScript.
 * A ban that cannot fire is the false negative this tool exists to remove, so
 * the analysis record's own answer — it resolved outside every project, and
 * this is the package — is taken as sufficient.
 *
 * A PATH is where that stops, and it is not an exception to the mechanism but
 * its precondition: a package name is what the mechanism needs, and a path
 * never is one. Upstream is structurally the same — `TargetProjectLocator`'s
 * `findProjectFromImport` opens with `isRelativePath` and then only ever
 * resolves the path to a file, so a relative specifier never reaches its npm
 * lookup at all. Deriving a name from a path here produced garbage that looked
 * like a package (`".."` from `../../../outside/present`, `""` from
 * `/outside/present`), and any target — however synthetic — makes `evaluateSite`
 * skip the one branch that reports `noRelativeOrAbsoluteExternals`. Nothing is
 * lost by refusing: what is refused here is exactly what that branch reports.
 */
function externalNodeFor(site, ctx) {
  if (isPathSpecifier(site)) return undefined;
  const packageName = site.resolved.packageName ?? getPackageNameFromImportPath(site.specifier);
  const known = ctx.externalByPackage.get(packageName);
  if (known) return known;
  const synthesized = ctx.synthesizedExternals.get(packageName);
  if (synthesized) return synthesized;
  const node = { name: `npm:${packageName}`, type: "npm", data: { packageName } };
  ctx.synthesizedExternals.set(packageName, node);
  return node;
}

/**
 * The node an already-resolved record points at, or `undefined` when the record
 * could not resolve it — which upstream treats the same way it treats an import
 * its own locator could not place.
 *
 * A record naming a project the graph does not have is neither: it means the
 * analysis and the graph were computed against different trees, and every
 * verdict from that point on would be arbitrary. It throws.
 */
function resolveTargetNode(site, ctx) {
  const resolved = site.resolved;
  if (!resolved) return undefined;
  if (resolved.target) {
    const node = ctx.graph.nodes[resolved.target];
    if (!node) {
      throw new Error(
        `nx-polyglot-graph: ${site.sourceFile}:${site.line}:${site.column} imports ` +
          `'${site.specifier}', which analysis resolved to project '${resolved.target}' — ` +
          `a project the graph does not contain. The graph and the analysis records ` +
          `describe different trees; every verdict after this one would be guesswork.`,
      );
    }
    return node;
  }
  if (resolved.external) return externalNodeFor(site, ctx);
  return undefined;
}

/** Builds one `Violation`. */
function violationOf(site, sourceProject, targetProject, messageId, data = {}, constraint = null) {
  return {
    sourceFile: site.sourceFile,
    line: site.line,
    column: site.column,
    specifier: site.specifier,
    kind: site.kind,
    messageId,
    message: renderMessage(messageId, data),
    sourceProject: sourceProject?.name ?? null,
    targetProject: targetProject?.name ?? null,
    constraint,
    data,
  };
}

/**
 * The tag block — upstream's last step, and the one with the two inversions
 * that make or break a reimplementation.
 *
 * @returns {Violation[]}
 */
function evaluateConstraints(site, sourceProject, targetProject, ctx) {
  const { depConstraints, options, graph, reach } = ctx;
  if (depConstraints.length === 0) return [];

  const constraints = findConstraintsFor(depConstraints, sourceProject);
  // TRAP 1 — no matching constraint is an ERROR, not a pass. Upstream's own
  // comment: "when no constrains found => error. Force the user to provision
  // them." Read it the natural way and every untagged or mis-tagged project
  // escapes the boundary while the tool reports green.
  if (constraints.length === 0) {
    return [
      violationOf(
        site,
        sourceProject,
        targetProject,
        "projectWithoutTagsCannotHaveDependencies",
        {},
      ),
    ];
  }

  const transitiveExternalDeps = options.checkNestedExternalImports
    ? findTransitiveExternalDependencies(graph, reach, targetProject)
    : [];

  // TRAP 2 — every matching constraint must be satisfied. `findConstraintsFor`
  // returns an ARRAY and this loop is an AND: a project tagged `type:lib
  // scope:shared layer:domain license:sul` is held to all four rows of this
  // workspace's table. An OR here passes imports ESLint blocks.
  for (const constraint of constraints) {
    const tagVerdict =
      onlyTagsViolation(constraint, targetProject) ??
      emptyOnlyTagsViolation(constraint, targetProject) ??
      notTagsViolation(constraint, targetProject, graph, reach);
    if (tagVerdict) {
      return [
        violationOf(
          site,
          sourceProject,
          targetProject,
          tagVerdict.messageId,
          tagVerdict.data,
          constraint,
        ),
      ];
    }

    if (
      options.checkNestedExternalImports &&
      constraint.bannedExternalImports &&
      constraint.bannedExternalImports.length
    ) {
      const matches = hasBannedDependencies(
        transitiveExternalDeps,
        graph,
        constraint,
        site.specifier,
      );
      // One violation per offending package — the only check in the engine that
      // reports more than once for a single import site.
      if (matches.length > 0) {
        return matches.map(([, violatingSource, matchedConstraint]) =>
          violationOf(
            site,
            sourceProject,
            targetProject,
            "nestedBannedExternalImportsViolation",
            {
              sourceTag: constraintSourceTagLabel(matchedConstraint),
              childProjectName: violatingSource.name,
              imp: site.specifier,
            },
            matchedConstraint,
          ),
        );
      }
    }
  }
  return [];
}

/**
 * One import site, judged in upstream's order.
 *
 * @returns {Violation[]}
 */
function evaluateSite(site, ctx) {
  const { graph, options, mappings, reach, fileIndex, ignored, depConstraints } = ctx;
  const imp = site.specifier;

  // TRAP 3 — `allow` is matched against the RAW SPECIFIER with Nx's own
  // wildcard matcher, whose fallback branch is an unanchored `new RegExp(...)`.
  // Not the resolved file path, and not minimatch: swap in a glob library and
  // every existing escape hatch quietly stops matching. Checked first, so an
  // allowed specifier is exempt from all fifteen rules.
  if (options.allow.some((allowed) => matchImportWithWildcard(allowed, imp))) return [];

  const sourceProject = graph.nodes[findProjectForPath(site.sourceFile, mappings)];
  // A file in no project is outside the boundary system entirely.
  if (!sourceProject) return [];

  // Relative and absolute paths are judged on their TEXT, before any resolution:
  // the projects can be correct and the spelling still be the violation.
  const absoluteIntoAnotherProject = isAbsoluteImportIntoAnotherProject(imp, ctx.workspaceLayout);
  let targetProject = absoluteIntoAnotherProject
    ? graph.nodes[findProjectForPath(imp, mappings)]
    : graph.nodes[getTargetProjectBasedOnRelativeImport(imp, site.sourceFile, mappings)];

  if ((targetProject && sourceProject !== targetProject) || absoluteIntoAnotherProject) {
    return [
      violationOf(site, sourceProject, targetProject, "noRelativeOrAbsoluteImportsAcrossLibraries"),
    ];
  }

  targetProject = targetProject ?? resolveTargetNode(site, ctx);

  if (!targetProject) {
    // A bare `.` or `..` counts as a path at this point though it did not count
    // as one above — see `isPathSpecifier`, which `externalNodeFor` refuses on
    // so that every path reaching here is reported rather than given a target.
    if (isPathSpecifier(site)) {
      return [violationOf(site, sourceProject, null, "noRelativeOrAbsoluteExternals")];
    }
    if (options.banTransitiveDependencies && !isBuiltinModuleImport(imp)) {
      return [violationOf(site, sourceProject, null, "noTransitiveDependencies")];
    }
    return [];
  }

  // A file reaching its own project through the project's public alias instead
  // of a relative path: a cycle through the barrel, and invisible in an edge
  // list because the edge starts and ends at the same node.
  //
  // `spelling.relative` is the counter-evidence, and it is the record's answer
  // rather than this layer's: what counts as "instead of a relative path" is
  // `./x` in JavaScript, `crate::`/`self::`/`super::` or a sibling crate target
  // of the same Cargo package in Rust, a leading-dot import in Python, and in
  // Go any import landing back in the source file's own project — Go has no
  // relative import form at all, so treating one as evidence of a barrel cycle
  // would demand syntax the language does not have, and its compiler already
  // forbids the cycle this rule looks for.
  if (
    sourceProject === targetProject &&
    !circularPathHasPair([sourceProject, targetProject], ignored)
  ) {
    if (
      !options.allowCircularSelfDependency &&
      !spellingOf(site).relative &&
      !belongsToDifferentEntryPoint(site.resolved?.file ?? null, site.sourceFile, sourceProject)
    ) {
      return [
        violationOf(site, sourceProject, targetProject, "noSelfCircularDependencies", { imp }),
      ];
    }
    return [];
  }

  if (targetProject.type === "npm") {
    const found = [];
    // Upstream does NOT return between these two, so an import can be both
    // transitive and banned and be reported twice.
    if (
      options.banTransitiveDependencies &&
      // The builtin exemption is upstream's, moved here because this engine
      // synthesises external nodes for specifiers upstream would have left
      // unresolved — without it, `import fs from "node:fs"` would be reported
      // as a transitive dependency, which upstream never does.
      !isBuiltinModuleImport(imp) &&
      !isDirectDependency(sourceProject, targetProject)
    ) {
      found.push(violationOf(site, sourceProject, targetProject, "noTransitiveDependencies"));
    }
    const constraint = hasBannedImport(sourceProject, targetProject, depConstraints, imp);
    if (constraint) {
      found.push(
        violationOf(
          site,
          sourceProject,
          targetProject,
          "bannedExternalImportsViolation",
          { sourceTag: constraintSourceTagLabel(constraint), imp },
          constraint,
        ),
      );
    }
    // An npm target NEVER reaches the tag block below — so no external import
    // can produce `projectWithoutTagsCannotHaveDependencies`, however untagged
    // its source project is.
    return found;
  }

  if (!isProjectGraphProjectNode(targetProject)) return [];

  const circular = circularViolation({
    reach,
    graph,
    sourceProject,
    targetProject,
    sourceFile: site.sourceFile,
    fileIndex,
    ignored,
  });
  if (circular) {
    return [violationOf(site, sourceProject, targetProject, circular.messageId, circular.data)];
  }

  if (targetProject.type === "app" && !appIsMFERemote(targetProject)) {
    return [violationOf(site, sourceProject, targetProject, "noImportsOfApps")];
  }
  if (targetProject.type === "e2e") {
    return [violationOf(site, sourceProject, targetProject, "noImportsOfE2e")];
  }

  if (
    options.enforceBuildableLibDependency === true &&
    sourceProject.type === "lib" &&
    targetProject.type === "lib" &&
    hasBuildExecutor(sourceProject, options.buildTargets) &&
    !hasBuildExecutor(targetProject, options.buildTargets)
  ) {
    return [violationOf(site, sourceProject, targetProject, "noImportOfNonBuildableLibraries")];
  }

  // `kind === "static"` stands in for upstream's "an `import` declaration that
  // is not type-only". See `lazyLoadedViolation` for the one case the analysis
  // contract cannot separate — `require()` — and why it errs toward reporting.
  if (
    site.kind === "static" &&
    !options.checkDynamicDependenciesExceptions.some((pattern) =>
      matchImportWithWildcard(pattern, imp),
    )
  ) {
    const lazy = lazyLoadedViolation({
      graph,
      sourceProject,
      targetProject,
      resolvedFile: site.resolved?.file ?? null,
      fileIndex,
    });
    if (lazy) {
      return [violationOf(site, sourceProject, targetProject, lazy.messageId, lazy.data)];
    }
  }

  return evaluateConstraints(site, sourceProject, targetProject, ctx);
}

/**
 * Judges every import site against the workspace's boundary law.
 *
 * Pure: the same three arguments always produce the same violations, and none
 * of them is read from disk here.
 *
 * ## Suppressions are a filter over VERDICTS, never a skip over sites
 *
 * `config.suppressions` removes violations the workspace has decided to accept,
 * each carrying the reason it was accepted (`../config.mjs`). The filter runs
 * AFTER every site has been judged, and that ordering is the load-bearing part
 * rather than an implementation detail: skipping a suppressed file up front
 * would also skip the checks that make this function throw — a record naming a
 * project the graph does not have, a malformed config — and a suppression must
 * never be able to silence "I could not tell". A violation is a decision
 * someone can accept; a failure is the absence of one, and accepting it would
 * turn a blind spot into a green light.
 *
 * The suppression vocabulary has no field that could name a failure either: an
 * entry carries a path glob, an optional `messageId` out of `MESSAGE_IDS`, and
 * its reason. Analysis failures never reach this function at all — they travel
 * beside the records in the analyzer's envelope (`../analysis/contract.md`).
 *
 * @param {object[]} importSites Analysis records — see `../analysis/contract.md`.
 * @param {ProjectGraph} graph
 * @param {{depConstraints: object[], options: object, suppressions?: object[]}} config
 *   As `loadBoundaryConfig` returns it. An absent `suppressions` suppresses
 *   nothing, which is the direction that cannot hide a violation.
 * @returns {Violation[]} in the order the sites were given, minus the ones a
 *   suppression covers; a site may contribute zero, one, or (in two documented
 *   cases) several.
 * @throws {Error} when the config is malformed, when the graph has no `nodes`,
 *   when a record carries no `spelling`, or when a record names a project the
 *   graph does not contain. Loud on purpose: an enforcer that starts on a
 *   broken input and reports nothing is indistinguishable from a clean tree.
 */
export function evaluate(importSites, graph, config) {
  const ctx = createContext(importSites, graph, config);
  const violations = [];
  for (const site of importSites) violations.push(...evaluateSite(site, ctx));
  return violations.filter(
    (violation) => !ctx.suppressions.some((entry) => suppressionCovers(entry, violation)),
  );
}

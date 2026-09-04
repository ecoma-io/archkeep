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
 * The chain has a second reader: the suppression table. A suppression must
 * behave like a fix
 * (`../../../../docs/reference/violations.md`, "The order matters") —
 * suppressing the verdict a site reports has to reveal the next check down the
 * order at the same line, exactly as editing the specifier would. So
 * `candidateGroupsFor` yields, in order, every check's verdict the site could
 * produce if each earlier one were fixed, and the evaluation picks the first
 * group no suppression removes. With nothing suppressed, the first group is
 * emitted untouched: one violation per site, byte-for-byte the verdict
 * upstream's order defines. A group is yielded only where its own preconditions
 * hold on the site — a tags verdict needs a resolved target project, the
 * project-to-project block needs a project node — so a suppression can never
 * surface a verdict the site could not actually produce.
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
 * See ../analysis/contract.md for the `ImportSite` shape this consumes.
 */
import { findBoundaryConfigViolations, suppressionCovers } from "../config.mjs";
import { referenceTime } from "../governance/clock.mjs";
import { EXPIRED_WAIVER_EVIDENCE, suppressionFate } from "../governance/waiver.mjs";

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
 * @property {object} [waivedBy] The `boundarySuppressions` row that WAIVED
 *   this violation — present only on a violation an ACTIVE waiver accepted
 *   (`../governance/waiver.mjs`). A waived violation is still a violation:
 *   the run stays non-zero, and the row records why it is present.
 * @property {string} [evidence] Why a violation is present in the report when
 *   the table would have removed it — `"expired waiver"` for a violation
 *   whose waiver lapsed and re-asserted.
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
 *   `exemptedFiles`                  — coverage-exempt files; absent means none
 *
 * @typedef {object} ProjectGraph
 * @property {Record<string, object>} nodes Project nodes, `type` one of
 *   `app` | `lib` | `e2e`, `data.root` workspace-relative.
 * @property {Record<string, object>} [externalNodes] npm nodes, keyed as Nx
 *   keys them (`npm:react`), each with `data.packageName`.
 * @property {Record<string, {source: string, target: string, type?: string}[]>} [dependencies]
 * @property {{libsDir: string, appsDir: string}} [workspaceLayout]
 * @property {string[]} [exemptedFiles] Workspace-relative paths of the tracked,
 *   analyzable files a native workspace's `coverage.exempt` removed from
 *   coverage (`../providers/native/coverage.mjs`). CONCRETE paths, never the
 *   globs the rows are written with — the expansion happened once at
 *   discovery, over unowned files only, where a stale row is refused loudly.
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
  if (
    typeof spelling?.path !== "boolean" ||
    typeof spelling?.relative !== "boolean" ||
    typeof spelling?.namesOnly !== "boolean"
  ) {
    throw new Error(
      `archkeep: ${site.sourceFile}:${site.line}:${site.column} imports ` +
        `'${site.specifier}' in a record carrying no \`spelling\` — the analysis contract ` +
        `requires \`{ path, relative, namesOnly }\` on every import site, because whether a ` +
        `specifier is a path, whether it stays inside its own project, and whether its ` +
        `language has any path spelling at all are per-language questions only the analyzer ` +
        `can answer. See src/analysis/contract.md.`,
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
 * reported by nothing. Making the answer language-aware moved where
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
    throw new Error("archkeep: evaluate() needs a project graph with a `nodes` map");
  }
  const violations = findBoundaryConfigViolations({
    depConstraints: config?.depConstraints,
    moduleBoundaryOptions: config?.options,
    boundarySuppressions: config?.suppressions,
  });
  if (violations.length > 0) {
    throw new Error(
      `archkeep: the boundary config given to evaluate() is malformed:\n  ` +
        violations.join("\n  "),
    );
  }

  // Checked for the whole run before any verdict, not lazily per branch: a
  // record whose analyzer never learned the question would otherwise be judged
  // silently everywhere the check does not happen to fall.
  for (const site of importSites) spellingOf(site);

  // A `buildTargets` entry that matches NO project's declared targets is a
  // silent no-op — `hasBuildExecutor` compares exactly, so the entry selects
  // no project, and when `enforceBuildableLibDependency` is on the check
  // reads as live while no project can possibly satisfy it. That is the
  // exact silent direction this repository's invariant forbids, and it is
  // only answerable here, where the graph is in the room: `config.mjs` has
  // already refused entries carrying glob syntax at load (`targetPatternError`),
  // so anything reaching this check is a plain NAME that happens not to be
  // declared by any project — a typo, or a target the workspace renamed
  // without updating the option. Both are reported by name, loudly, rather
  // than judged into a rule that can never fire. When the flag is OFF the
  // entries are never read (`docs/reference/policy-schema.md`, "moduleBoundaryOptions"),
  // so there is nothing to check and no claim to make.
  const optionsValue = /** @type {object} */ (config?.options);
  if (optionsValue.enforceBuildableLibDependency === true && Object.keys(graph.nodes).length > 0) {
    // `graph.nodes` being empty is a genuinely empty tree — no project exists
    // for an entry to select, so there is no claim to make and no silent no-op
    // (an option that judges nothing on no projects is not a trap; one that
    // judges nothing while projects exist is). The check is only answerable
    // against a non-empty graph, and an empty one skips it rather than
    // refusing every command on a workspace that has nothing to judge.
    const declaredTargets = new Set(
      Object.values(graph.nodes).flatMap((node) => Object.keys(node.data?.targets ?? {}) ?? []),
    );
    for (const entry of /** @type {string[]} */ (optionsValue.buildTargets ?? [])) {
      if (!declaredTargets.has(entry)) {
        throw new Error(
          `archkeep: buildTargets entry '${entry}' matches no target declared by any project ` +
            `in the graph — under enforceBuildableLibDependency this entry is a silent no-op. ` +
            `Declare a target named '${entry}' on some project, or remove the entry. ` +
            `Declared targets: ${[...declaredTargets].join(", ") || "(none)"}`,
        );
      }
    }
  }

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
  // Coverage exemptions ride the graph the way `workspaceLayout` does: an
  // optional whole-graph fact the provider measured (`buildNativeGraph`, from
  // `judgeCoverage`'s concrete list). Anything that is not a list of strings
  // is read as NONE rather than guessed at — the fail-closed direction here is
  // toward reporting, because an exemption that does not apply leaves the
  // site's verdict exactly where it was before this field existed. The globs
  // never reach this layer at all; see `exemptResolvedFile` for why that is
  // the load-bearing half.
  const exemptedFiles = new Set(
    Array.isArray(graph.exemptedFiles)
      ? graph.exemptedFiles.filter((file) => typeof file === "string")
      : [],
  );
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
    exemptedFiles,
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
 * PyPI distributions or Go modules as external nodes (`../../AGENTS.md` — only
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
 * `/outside/present`), and any target — however synthetic — makes the site
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
        `archkeep: ${site.sourceFile}:${site.line}:${site.column} imports ` +
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

/**
 * The coverage-exempt file an import resolved to, or `null`.
 *
 * A `coverage.exempt` row answers the coverage question ("this tracked,
 * analyzable file legitimately belongs to no project") and, since #218, the
 * boundary question too: importing such a file is neither a project-to-project
 * edge nor an external one, so it is left unconstrained. The decision keys on
 * the RESOLVED FILE, not on the specifier's spelling, which is what makes a
 * relative `../x.js` and an alias pointing at the same file take one answer.
 *
 * ## Why this takes concrete paths and never re-globs
 *
 * This is the guard that keeps the exempt list from becoming a boundary-off
 * switch. The globs a workspace writes are expanded exactly once — in
 * `../providers/native/coverage.mjs`'s `judgeCoverage`, against the TRACKED,
 * ANALYZABLE files NO PROJECT OWNS, where a row matching none of them is
 * refused loudly as stale (`../providers/native/index.mjs`). What arrives here
 * is that expansion's output. So:
 *
 * - even a broad row (`**`, a whole directory) can only ever name files
 *   outside every project — a project-owned file cannot enter the list, so no
 *   import into one is ever silenced by it;
 * - membership is exact-path, so an import resolving to nothing real
 *   (`resolved.file` null), to a file outside the tree, or to an untracked
 *   file keeps the verdict it had before this mechanism existed.
 *
 * Exported because the run's own report must be able to say how many imports
 * took the unconstrained road (`../../../cli.mjs`'s coverage notes) without a
 * second copy of this predicate drifting from the engine's.
 *
 * @param {object} site An analysis record — see `../analysis/contract.md`.
 * @param {Set<string>} exemptedFiles The graph's concrete exempt-file set.
 * @returns {string|null} The exempt file the record resolved to.
 */
export function exemptResolvedFile(site, exemptedFiles) {
  if (!exemptedFiles || exemptedFiles.size === 0) return null;
  const file = site.resolved?.file;
  return typeof file === "string" && exemptedFiles.has(file) ? file : null;
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
 * Yielded as groups in the order this block has always reported: the first
 * firing check across all matching constraints is the first
 * group, and each later constraint's verdict — reachable only by fixing or
 * suppressing the one before it — is a later group. TRAP 2's AND semantics are
 * unchanged: the FIRST group is decided exactly as the early return decided
 * it, and nothing below it is judged into the verdict unless something removed
 * the group above.
 *
 * @returns {Generator<Violation[]>}
 */
function* constraintGroupsFor(site, sourceProject, targetProject, ctx) {
  const { depConstraints, options, graph, reach } = ctx;
  if (depConstraints.length === 0) return;

  const constraints = findConstraintsFor(depConstraints, sourceProject);
  // TRAP 1 — no matching constraint is an ERROR, not a pass. Upstream's own
  // comment: "when no constrains found => error. Force the user to provision
  // them." Read it the natural way and every untagged or mis-tagged project
  // escapes the boundary while the tool reports green. Nothing sits below the
  // tag block, so this ends the chain.
  if (constraints.length === 0) {
    yield [
      violationOf(
        site,
        sourceProject,
        targetProject,
        "projectWithoutTagsCannotHaveDependencies",
        {},
      ),
    ];
    return;
  }

  const transitiveExternalDeps = options.checkNestedExternalImports
    ? findTransitiveExternalDependencies(graph, reach, targetProject)
    : [];

  // TRAP 2 — every matching constraint must be satisfied. `findConstraintsFor`
  // returns an ARRAY and this loop is an AND: a project tagged `type:lib
  // scope:shared layer:domain license:internal` is held to all four rows of a
  // table carrying one row per axis. An OR here passes imports ESLint blocks.
  for (const constraint of constraints) {
    const tagVerdict =
      onlyTagsViolation(constraint, targetProject) ??
      emptyOnlyTagsViolation(constraint, targetProject) ??
      notTagsViolation(constraint, targetProject, graph, reach);
    if (tagVerdict) {
      yield [
        violationOf(
          site,
          sourceProject,
          targetProject,
          tagVerdict.messageId,
          tagVerdict.data,
          constraint,
        ),
      ];
      continue;
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
        yield matches.map(([, violatingSource, matchedConstraint]) =>
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
}

/**
 * One import site's whole candidate chain, in upstream's order.
 *
 * Each yielded array is a GROUP of simultaneous violations — what the site
 * reports at that point of the chain. Most checks yield one violation; two
 * places yield several at once, unchanged from upstream: the npm branch (a
 * transitive-dependency report does not stop the banned-import check) and the
 * nested-banned check (one report per offending package). The evaluation picks
 * the first group in which something survives the suppression table, so the
 * chain is only ever walked past a group the table removed entirely — a
 * suppression behaves like a fix, revealing the next check at the same line
 * (`../../../../docs/reference/violations.md`, "The order matters"), never
 * skipping a site or inventing a verdict whose preconditions do not hold.
 *
 * The places this generator RETURNS rather than yields-and-continues are the
 * places nothing below is genuinely reachable:
 *
 * - `allow`, a file in no project — outside the boundary system entirely;
 * - no resolved target — every check below needs one;
 * - a self-project import (`source === target`) whose self-pair the ignore map
 *   does not excuse — fixing the barrel round-trip lands back inside the same
 *   project, where none of those checks judge. A self-pair EXCUSED by
 *   `ignoredCircularDependencies` falls through exactly as this engine has
 *   always fallen through, so its chain reaches the project-to-project block;
 * - an npm target — upstream returns before the tag block, so no external
 *   import can produce a tags violation;
 * - a non-project node.
 *
 * Everything else CONTINUES: fixing a cycle leaves the same import to be
 * judged by the apps/e2e/buildable/lazy checks and the constraint table, which
 * is exactly what a suppression standing in for that fix must reveal.
 *
 * @param {object} site Analysis record — see `../analysis/contract.md`.
 * @param {object} ctx From `createContext`.
 * @returns {Generator<Violation[]>}
 */
function* candidateGroupsFor(site, ctx) {
  const { graph, options, mappings, reach, fileIndex, ignored, depConstraints } = ctx;
  const imp = site.specifier;

  // TRAP 3 — `allow` is matched against the RAW SPECIFIER with Nx's own
  // wildcard matcher, whose fallback branch is an unanchored `new RegExp(...)`.
  // Not the resolved file path, and not minimatch: swap in a glob library and
  // every existing escape hatch quietly stops matching. Checked first, so an
  // allowed specifier is exempt from all fifteen rules.
  if (options.allow.some((allowed) => matchImportWithWildcard(allowed, imp))) return;

  const sourceProject = graph.nodes[findProjectForPath(site.sourceFile, mappings)];
  // A file in no project is outside the boundary system entirely.
  if (!sourceProject) return;

  // Relative and absolute paths are judged on their TEXT, before any resolution:
  // the projects can be correct and the spelling still be the violation. The
  // absolute half is a JavaScript-family convention — a bare `libs/x` deep
  // import, a `/libs/x` absolute path — so it stands down entirely where the
  // analyzer declared the language has no path spelling at all
  // (`spelling.namesOnly`): a Go module path or a C# namespace beginning
  // `libs/` is a name, and the name is the only spelling the language has
  // (#376). The edge such an import resolves to is still judged by every check
  // below — only this spelling check stands down, so gating it too broadly
  // (on `spelling.path`, which is false for the bare JS form too) would trade
  // this loud bug for a silent one against ESLint.
  const absoluteIntoAnotherProject =
    !spellingOf(site).namesOnly && isAbsoluteImportIntoAnotherProject(imp, ctx.workspaceLayout);
  let targetProject = absoluteIntoAnotherProject
    ? graph.nodes[findProjectForPath(imp, mappings)]
    : graph.nodes[getTargetProjectBasedOnRelativeImport(imp, site.sourceFile, mappings)];

  if ((targetProject && sourceProject !== targetProject) || absoluteIntoAnotherProject) {
    yield [
      violationOf(site, sourceProject, targetProject, "noRelativeOrAbsoluteImportsAcrossLibraries"),
    ];
    // The spelling was the violation, not the edge: with the specifier written
    // through the project's public name — or with the spelling suppressed — the
    // SAME target project reaches the checks below. `targetProject` is already
    // resolved, so resolution is not run again.
  } else {
    // A coverage-exempt file is resolvable and unconstrained (#218): the record
    // resolved to a real tracked workspace file that `coverage.exempt` declared
    // to belong to no project, so this import is neither a project-to-project
    // edge nor an external one. It sits BEFORE `resolveTargetNode` because that
    // is what synthesises the external node: downstream of it a bare or aliased
    // specifier resolving into an exempt file has already become
    // `npm:<specifier>`, a package that does not exist, which is the false
    // description this branch exists to stop. A file a project owns can never
    // enter the exempt set (`exemptResolvedFile`), so this can only take a site
    // whose target is outside every project; a relative path resolving outside
    // every project still reaches `noRelativeOrAbsoluteExternals` below.
    if (
      !targetProject &&
      site.resolved?.target == null &&
      exemptResolvedFile(site, ctx.exemptedFiles) !== null
    ) {
      return;
    }
    targetProject = targetProject ?? resolveTargetNode(site, ctx);
  }

  if (!targetProject) {
    // A bare `.` or `..` counts as a path at this point though it did not count
    // as one above — see `isPathSpecifier`, which `externalNodeFor` refuses on
    // so that every path reaching here is reported rather than given a target.
    if (isPathSpecifier(site)) {
      yield [violationOf(site, sourceProject, null, "noRelativeOrAbsoluteExternals")];
      return;
    }
    if (options.banTransitiveDependencies && !isBuiltinModuleImport(imp)) {
      yield [violationOf(site, sourceProject, null, "noTransitiveDependencies")];
    }
    return;
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
  // The early return keeps upstream's shape — with one exception carried over
  // from the flat-list engine byte for byte: a self-pair the ignore map excuses
  // (`ignoredCircularDependencies: [["p", "p"]]`) fell through to the
  // project-to-project block below and still does. Restoring that fall-through
  // is what keeps a workspace with no suppressions byte-identical: measured
  // against this engine's previous revision, such an import reached the tag
  // block and could report `onlyTagsConstraintViolation` or
  // `noImportsOfApps` on the self-edge.
  if (
    sourceProject === targetProject &&
    !circularPathHasPair([sourceProject, targetProject], ignored)
  ) {
    if (
      !options.allowCircularSelfDependency &&
      !spellingOf(site).relative &&
      !belongsToDifferentEntryPoint(site.resolved?.file ?? null, site.sourceFile, sourceProject)
    ) {
      yield [
        violationOf(site, sourceProject, targetProject, "noSelfCircularDependencies", { imp }),
      ];
    }
    return;
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
    if (found.length > 0) yield found;
    return;
  }

  if (!isProjectGraphProjectNode(targetProject)) return;

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
    yield [violationOf(site, sourceProject, targetProject, circular.messageId, circular.data)];
  }

  if (targetProject.type === "app" && !appIsMFERemote(targetProject)) {
    yield [violationOf(site, sourceProject, targetProject, "noImportsOfApps")];
  } else if (targetProject.type === "e2e") {
    yield [violationOf(site, sourceProject, targetProject, "noImportsOfE2e")];
  }

  if (
    options.enforceBuildableLibDependency === true &&
    sourceProject.type === "lib" &&
    targetProject.type === "lib" &&
    hasBuildExecutor(sourceProject, options.buildTargets) &&
    !hasBuildExecutor(targetProject, options.buildTargets)
  ) {
    yield [violationOf(site, sourceProject, targetProject, "noImportOfNonBuildableLibraries")];
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
      yield [violationOf(site, sourceProject, targetProject, lazy.messageId, lazy.data)];
    }
  }

  yield* constraintGroupsFor(site, sourceProject, targetProject, ctx);
}

/**
 * Whether any SUPPRESSING row (fate `"suppress"` — a legacy row, no expiry)
 * covers this violation. A waiver's fates (`"waive"`, `"reassert"`) never
 * remove a violation, so they never decide which group a site reports — they
 * only annotate it (`../governance/waiver.mjs`).
 *
 * @param {object[]} suppressions The validated `boundarySuppressions` table.
 * @param {object} violation
 * @param {string} now Reference instant (ISO-8601).
 * @returns {boolean}
 */
function removedByTable(suppressions, violation, now) {
  for (const entry of suppressions) {
    if (!suppressionCovers(entry, violation)) continue;
    if (suppressionFate(entry, now) === "suppress") return true;
  }
  return false;
}

/**
 * The annotation the table puts on a violation that SURVIVES it: `waivedBy`
 * for an active waiver's acceptance, `evidence` for one whose term lapsed.
 * Copied rather than mutated so `evaluateRun`'s two results never share a
 * marked object — the raw superset states what the law found, unannotated.
 *
 * @param {object[]} suppressions The validated `boundarySuppressions` table.
 * @param {object} violation
 * @param {string} now Reference instant (ISO-8601).
 * @returns {object}
 */
function annotatedByTable(suppressions, violation, now) {
  for (const entry of suppressions) {
    if (!suppressionCovers(entry, violation)) continue;
    if (suppressionFate(entry, now) === "waive") return { ...violation, waivedBy: entry };
    return { ...violation, evidence: EXPIRED_WAIVER_EVIDENCE };
  }
  return violation;
}

/**
 * The suppression table applied to verdicts that did not come from
 * `evaluateRun`'s site walk — suppressing rows remove, active waivers mark
 * `waivedBy`, expired ones re-assert with `evidence`, exactly as the site walk
 * applies them, because a verdict must ride the same table whichever walk
 * produced it.
 *
 * The one caller is `./commands/check.mjs`'s markdown document track: its
 * edges are judged per edge through `./edge-constraints.mjs`'s `judgeEdge` —
 * they have no import site for `candidateGroupsFor` to walk, so there is no
 * group chain, only a flat list — but a suppression row that names a document
 * must silence the same verdict here it would silence on an import site, and
 * a waiver over one must annotate it the same way. Unlike the site walk there
 * is no second candidate group to fall through to: an edge's verdicts are all
 * reported together, so a row that removes some leaves the rest standing
 * rather than promoting anything.
 *
 * @param {object[]} suppressions The validated `boundarySuppressions` table.
 * @param {object[]} violations The unfiltered verdicts, in walk order.
 * @param {string} [now] Reference instant for waiver expiry; defaults to the
 *   shared governance clock, as `evaluateRun` does.
 * @returns {object[]} The survivors, in input order, annotations applied.
 */
export function applySuppressionTable(suppressions, violations, now = referenceTime()) {
  if (suppressions.length === 0) return violations;
  return violations
    .filter((violation) => !removedByTable(suppressions, violation, now))
    .map((violation) => annotatedByTable(suppressions, violation, now));
}

/**
 * One run of the engine over every import site: the judged verdict per site
 * plus the raw superset it was picked from.
 *
 * Per site, `candidateGroupsFor` yields the site's candidate groups in
 * upstream's order; this walk picks the FIRST group in which at least one
 * violation survives the suppression table. Groups before it — every verdict
 * the table removed entirely — are exactly what the raw superset carries above
 * the verdict, which is the arithmetic the waiver surface is built on:
 * `raw − evaluated = what the table hides`, per site, byte-for-byte. A group
 * partially covered keeps its surviving members (an npm target reported as
 * both transitive and banned, with only the transitive half suppressed, still
 * reports the banned half), unchanged from when the table filtered flat lists.
 *
 * @param {object[]} importSites Analysis records — see `../analysis/contract.md`.
 * @param {ProjectGraph} graph
 * @param {{depConstraints: object[], options: object, suppressions?: object[], now?: string}} config
 *   As `loadBoundaryConfig` returns it, plus an optional `now` (ISO-8601
 *   reference instant) used only to decide waiver expiry; defaults to the
 *   shared governance clock.
 * @returns {{violations: object[], rawViolations: object[]}} `violations` is
 *   the run's verdict — one group per site, waivers/expiry annotated;
 *   `rawViolations` is every candidate up to and including each site's selected
 *   group, unannotated. Exported for the one caller that needs both faces of a
 *   single walk (`cli.mjs`'s `check`, whose dead-suppression-row refusal
 *   measures each row against `rawViolations`) — everywhere else takes
 *   `evaluate` or `evaluateWithSuppressions`, which are this function's two
 *   fields under thinner names.
 */
export function evaluateRun(importSites, graph, config) {
  const ctx = createContext(importSites, graph, config);
  const now = config?.now ?? referenceTime();
  /** @type {object[]} */
  const violations = [];
  /** @type {object[]} */
  const rawViolations = [];
  for (const site of importSites) {
    /** @type {object[]} */
    const hidden = [];
    let selected = false;
    for (const group of candidateGroupsFor(site, ctx)) {
      const survivors =
        ctx.suppressions.length === 0
          ? group
          : group.filter((violation) => !removedByTable(ctx.suppressions, violation, now));
      if (survivors.length === 0) {
        hidden.push(...group);
        continue;
      }
      // The first group something survived in IS the site's verdict; everything
      // collected before it is what the table hid to get there.
      violations.push(
        ...survivors.map((violation) => annotatedByTable(ctx.suppressions, violation, now)),
      );
      rawViolations.push(...hidden, ...group);
      selected = true;
      break;
    }
    if (!selected) rawViolations.push(...hidden);
  }
  return { violations, rawViolations };
}

/**
 * The raw violations a site set produces BEFORE any suppression removes one,
 * as `evaluate` would see them — every candidate up to each site's selected
 * group, including the verdicts the table hides. `evaluate` itself reports the
 * filtered verdict — the boundary as it stands after the workspace accepted its
 * suppressions — while the waiver surface (how much of the law is currently
 * waived) needs the count that WAS suppressed, which the filtered result cannot
 * express. The two are a superset/subset: `waived = raw − evaluated`,
 * byte-for-byte.
 *
 * @param {object[]} importSites Analysis records — see `../analysis/contract.md`.
 * @param {ProjectGraph} graph
 * @param {{depConstraints: object[], options: object, suppressions?: object[]}} config
 * @returns {Violation[]} in the order the sites were given, nothing removed.
 */
export function evaluateWithSuppressions(importSites, graph, config) {
  return evaluateRun(importSites, graph, config).rawViolations;
}

/**
 * Judges every import site against the workspace's boundary law.
 *
 * Pure: the same three arguments always produce the same violations, and none
 * of them is read from disk here.
 *
 * ## Suppressions act on VERDICTS, never on sites — and a suppressed verdict
 * must behave like a fix
 *
 * `config.suppressions` decides what happens to violations the workspace
 * accepted, each carrying the reason it was accepted (`../config.mjs`). Every
 * site is judged before the table decides anything — the site's candidate
 * chain is walked until a verdict survives it — and that ordering is
 * load-bearing rather than an implementation detail: skipping a suppressed
 * file up front would also skip the checks that make this function throw — a
 * record naming a project the graph does not have, a malformed config — and a
 * suppression must never be able to silence "I could not tell". A violation is
 * a decision someone can accept; a failure is the absence of one, and
 * accepting it would turn a blind spot into a green light.
 *
 * What the table removes is one VERDICT, never the checks below it. The first
 * candidate group a suppressing row covers entirely is replaced by the next
 * group down the documented order — suppressing
 * `noRelativeOrAbsoluteImportsAcrossLibraries` on a cross-project import
 * surfaces whatever the constraint table says about the same edge, exactly as
 * rewriting the specifier would (`../../../../docs/reference/violations.md`,
 * "The order matters"). With nothing suppressed, the first group is emitted
 * untouched: one violation per site, byte-for-byte the verdict upstream's
 * order defines. A later group exists only where its own preconditions hold on
 * the site — a tags verdict needs a resolved target project — so fall-through
 * invents nothing.
 *
 * The suppression vocabulary has no field that could name a failure either: an
 * entry carries a path glob, an optional `messageId` out of `MESSAGE_IDS`, its
 * reason, and — for a waiver — `expiresAt`. Analysis failures never reach this
 * function at all — they travel beside the records in the analyzer's envelope
 * (`../analysis/contract.md`). Because the table never touches a failure, a
 * waiver over `unknown` is structurally impossible: a row can only match a
 * verdict this engine reached, and a verdict it could not reach never enters
 * this array. That same judge-before-suppress ordering is why a waiver cannot
 * promote `unknown` → `pass`: a logical consequence, not a second mechanism.
 *
 * Rows WITH `expiresAt` are waivers and mark rather than remove
 * (`../governance/waiver.mjs`): an ACTIVE waiver keeps the violation it covers
 * in the findings, marked `waivedBy` — the run stays non-zero, because
 * accepting a boundary breach for a fixed term is a tracked decision, not a
 * fix — and an EXPIRED one re-asserts with `evidence: "expired waiver"`.
 * Neither fate removes a verdict, so neither moves a site down its chain; the
 * empty-result invariant (`../../../../AGENTS.md`) holds in the waiving
 * direction too.
 *
 * `evaluateWithSuppressions` (above) is the raw superset this function folds
 * down — every candidate up to each site's selected group — so a caller that
 * needs to measure the waiver surface can see exactly what the table removed,
 * which the filtered result cannot express: `raw − evaluated` is the set of
 * verdicts the suppressions hid.
 *
 * @param {object[]} importSites Analysis records — see `../analysis/contract.md`.
 * @param {ProjectGraph} graph
 * @param {{depConstraints: object[], options: object, suppressions?: object[], now?: string}} config
 *   As `loadBoundaryConfig` returns it, plus an optional `now` (ISO-8601
 *   reference instant) used only to decide waiver expiry; defaults to the
 *   shared governance clock. An absent `suppressions` suppresses nothing, which
 *   is the direction that cannot hide a violation.
 * @returns {Violation[]} per site, the first candidate group no suppression
 *   removed — one violation in the common case, several only where upstream
 *   reports more than once for one site (the npm branch; nested-banned, once
 *   per offending package). Violations an ACTIVE waiver covers are present,
 *   marked `waivedBy`; ones an EXPIRED waiver covered are present with
 *   `evidence: "expired waiver"`.
 * @throws {Error} when the config is malformed, when the graph has no `nodes`,
 *   when a record carries no `spelling`, or when a record names a project the
 *   graph does not contain. Loud on purpose: an enforcer that starts on a
 *   broken input and reports nothing is indistinguishable from a clean tree.
 */
export function evaluate(importSites, graph, config) {
  return evaluateRun(importSites, graph, config).violations;
}

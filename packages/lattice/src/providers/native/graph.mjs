/**
 * Import edges and implicit edges, reduced to Nx's own dependency-map shape —
 * the second half of what `../../lsp/workspace-index.mjs` used to build by
 * hand, promoted here so a native `lattice.json` workspace and the language
 * server share one implementation rather than growing two that drift
 * (`../../../AGENTS.md`, "`src/providers/` is the layer that supplies a graph
 * to `evaluate()`").
 */
import { findMatchingProjects } from "../../rules/match.mjs";

/**
 * The dependency map, keyed by source project as Nx keys it.
 *
 * Two kinds of edge, and both are Nx's:
 *
 * - **Import edges**, from the analysis records. A `dynamic` import site
 *   becomes a `dynamic` edge, because `noImportsOfLazyLoadedLibraries` is
 *   decided on exactly that distinction (`../../rules/topology.mjs`).
 * - **Implicit edges**, from each project's `implicitDependencies`, expanded
 *   with the SAME matcher Nx uses — reached through `../../rules/match.mjs`
 *   rather than reimplemented, so a pattern that resolves one way for a
 *   constraint cannot resolve another way here.
 *
 * @param {{importSites: object[], nodes: Record<string, object>, projectOf: (file: string) => string|undefined}} input
 * @returns {Record<string, {source: string, target: string, type: string}[]>}
 */
export function buildDependencies({ importSites, nodes, projectOf }) {
  // Null-prototype: every key here is a project NAME, and project names come
  // from `lattice.json`'s own `projects.declared[].name` or a tracked
  // manifest's own `name` field — both attacker-supplied the moment a pull
  // request adds a project called `__proto__`. A plain `{}` literal answers
  // `dependencies["__proto__"] = […]` by reassigning the object's OWN
  // prototype rather than adding an entry (`Object.prototype`'s inherited
  // `__proto__` accessor), so the array this line means to store is silently
  // discarded and any read of `dependencies["__proto__"]` afterward returns
  // whatever the prototype now is — not an array, so the very next `.push`
  // onto it throws `TypeError: … .push is not a function`, taking the whole
  // graph build down over one project name. `Object.create(null)` has no
  // inherited `__proto__` accessor to collide with, so the key behaves like
  // every other project name: a real, own, enumerable entry.
  /** @type {Record<string, {source: string, target: string, type: string}[]>} */
  const dependencies = Object.create(null);
  const seen = new Set();
  // Nx's own rule for config files, reproduced over the same two dialect
  // spellings of the workspace-root project's root. `explicit-project-dependencies.js`
  // (the import-site half of nx's graph construction) drops every edge whose
  // TARGET is the workspace root, keeping only edges that originate in it —
  // `if (isRoot(source) || !isRoot(target))` — and names the gap it papers
  // over in its own TODO: "These edges technically should be allowed but we
  // need to figure out how to separate config files out from root". The root
  // project carries the tree's own config files (`eslint.config.*`,
  // `*.config.ts`, `global-setup.*`), and Nx drops exactly their imported
  // edges: measured on the code-pushup real tree at the pinned sha, `nx graph`
  // reports ZERO edges into the root `workspace` node while project-level
  // config files visibly import the root's — the import site exists, the
  // target-root edge is what Nx suppresses. So no edge here may point at the
  // workspace root, or the graph invents dependencies Nx never drew and
  // `noCircularDependencies` reports cycles that only close through that
  // node. `scripts/differential-real-trees.mjs`'s ledger carries the
  // full finding; Nx spells the root `"."` (`isRoot` reads `root === '.'`
  // verbatim) while this package's native `lattice.json` dialect spells it
  // `""` (`./discover.mjs`'s `discoverNativeProjects`), so both are
  // recognised here rather than one silently differing the other.
  const isRoot = (name) => {
    const root = nodes[name]?.data?.root;
    return root === "" || root === ".";
  };
  const add = (source, target, type) => {
    if (!source || !target || source === target) return;
    if (!nodes[target]) return;
    // `JSON.stringify` of the tuple, not a space-joined string: a project name
    // may contain a space — neither `./model.mjs`'s `declaredProjectViolations`
    // nor `./discover.mjs`'s manifest-sourced name resolution reject one (only
    // non-empty is required; npm's own naming rules, which forbid a space, bind
    // `package.json`'s name and nothing declared in `lattice.json` directly) —
    // so `${source} ${target} ${type}` collides whenever a space moves across
    // the join: source `"a b"` target `"c"` and source `"a"` target `"b c"`
    // both key to `"a b c static"`, and the second edge silently vanishes as a
    // false duplicate of the first. A JSON array has no such ambiguity: each
    // element is individually quoted and escaped.
    const key = JSON.stringify([source, target, type]);
    if (seen.has(key)) return;
    seen.add(key);
    (dependencies[source] ??= []).push({ source, target, type });
  };

  for (const site of importSites) {
    const source = projectOf(site.sourceFile);
    const target = site.resolved?.target;
    // The target-root skip, exactly as Nx applies it — and only to IMPORT
    // edges. Nx's implicit-dependency expansion (`applyImplicitDependencies`)
    // has no `isRoot` check, so a project.json naming the root as an implicit
    // dependency still draws the edge there; import sites are the one place
    // Nx refuses, and they are the one place this loop reproduces it. Keeping
    // `source->root` without also dropping `root->source` would misread the
    // real tree the other way (it would be a loud native-extra rather than a
    // cycle — config files visibly do import INTO the root, so the only
    // question is which side Nx withholds, and it withholds the target side).
    if (isRoot(target) && !isRoot(source)) continue;
    add(source, target, site.kind === "dynamic" ? "dynamic" : "static");
  }
  for (const [name, node] of Object.entries(nodes)) {
    const declared = node.data.implicitDependencies;
    if (!Array.isArray(declared) || declared.length === 0) continue;
    // A pattern the matcher rejects is a project-definition problem, and
    // `findMatchingProjects` throws naming it (`../../rules/match.mjs`). That
    // throw is left to propagate rather than caught here, for both callers of
    // this function: `./discover.mjs` validates every native
    // `implicitDependencies` entry — declared-row (`./model.mjs`'s
    // `declaredProjectViolations`) and `project.json`-sourced alike — before a
    // graph is ever built from them, so a native workspace never reaches this
    // line with a bad pattern in the first place; the throw below is dead code
    // on that path, not a silent one. `../../lsp/workspace-index.mjs`'s
    // `project.json` has no such validator, so its build CAN reach here with
    // one — and letting the exception propagate is the correct answer there
    // too: `../../lsp/server.mjs`'s `initialize`/`didOpen` handling already
    // wraps the whole index build in a `.catch()` that turns any thrown error
    // into a loud "could not analyze" state published to every open document,
    // exactly the failure mode `../../../AGENTS.md`'s invariant asks for. A
    // caught-and-dropped edge here used to reach that same bad pattern
    // silently: the project kept building, one implicit edge simply never
    // existed, and any boundary violation that edge would have carried read as
    // a clean workspace instead of one that could not be judged.
    const expanded = findMatchingProjects(declared, nodes);
    for (const target of expanded) add(name, target, "implicit");
  }
  return dependencies;
}

/**
 * The graph `evaluate()` judges, built from discovered native projects and
 * the import sites analysis found in them.
 *
 * Only `data.root` and `data.tags` are written here — the two facts this
 * provider actually measured (`./discover.mjs`). `entryPoints`,
 * `declaredPackages` and `mfeRemote` are NOT spread in from `lattice.json`;
 * they stay annotator-computed by the same functions the Nx path calls
 * (`../../workspace.mjs`'s `annotateMFERemotes`/`annotatePackageFacts`,
 * invoked by the caller afterward — see `../nx.mjs`'s
 * `ProjectModelProvider` doc for why that split holds for every provider).
 * `implicitDependencies` rides on `data` too, because `buildDependencies`
 * above reads it from there — the one field this provider both writes AND
 * reads back, by the same contract Nx's own `project.json` uses.
 *
 * `externalNodes` is never set: `../../rules/specifiers.mjs`'s
 * `findTransitiveExternalDependencies` already treats an absent
 * `graph.externalNodes` as "none", and `../../rules/index.mjs`'s
 * `externalNodeFor` synthesises a node for an external target on demand — a
 * native provider declaring npm-registry bookkeeping would be a second
 * source of truth for a fact this package already derives from the analysis
 * records.
 *
 * `data.targets` is synthesised, never measured: `lattice.json`'s
 * `projects.declared[].targets` names target NAMES only (spec §5), never an
 * executor or a config — this provider has no build system to ask for one.
 * Each declared name becomes `{executor: "lattice:declared"}`, a non-empty
 * executor string so `../../rules/topology.mjs`'s `hasBuildExecutor` (which
 * treats `executor === ''` as "not really buildable") reads it as real,
 * making `enforceBuildableLibDependency` live on a native tree the same way
 * it is on an Nx one. An empty `targets` list stays an ABSENT `data.targets`
 * rather than an empty object, so `hasBuildExecutor`'s own `Boolean(targets
 * && …)` sees "no targets" for a project that declared none, not a targets
 * table that happens to match nothing.
 *
 * `workspaceLayout` rides on the returned graph OBJECT, never inside a node's
 * `data` — it is a workspace-wide fact, not a per-project one, and
 * `../../rules/index.mjs`'s `createContext` reads it with exactly this
 * fallback: `graph.workspaceLayout ?? DEFAULT_WORKSPACE_LAYOUT`. Passing
 * `undefined` through (rather than defaulting it here) keeps that the only
 * place the default is ever applied — see `./model.mjs`'s
 * `normalizeNativeModel` for why a second default here could drift from it.
 *
 * `exemptedFiles` rides the same way — the CONCRETE list of files
 * `coverage.exempt` removed from coverage (`./coverage.mjs`'s `judgeCoverage`,
 * threaded through `../index.mjs`'s `buildGraph` from `discovered.exempted`),
 * never the globs the rows are written with. The rules layer matches import
 * resolutions against these exact paths (`../../rules/index.mjs`'s
 * `exemptResolvedFile`, #218), and the guard that keeps a broad row from
 * becoming a boundary-off switch lives in what `judgeCoverage` already does:
 * it expands rows over tracked, analyzable, UNOWNED files only, so a
 * project-owned file cannot enter this list no matter how wide its row is.
 * Absent when no file was exempted, so a graph with no exemptions stays
 * byte-identical to one this field never existed on.
 *
 * @param {{projects: {name: string, root: string, type: string, tags: string[], implicitDependencies: string[], targets: string[]}[], importSites: object[], projectOf: (file: string) => string|undefined, workspaceLayout?: {appsDir: string, libsDir: string}, exemptedFiles?: string[]}} args
 * @returns {{nodes: Record<string, object>, dependencies: Record<string, object[]>, workspaceLayout?: {appsDir: string, libsDir: string}, exemptedFiles?: string[]}}
 */
export function buildNativeGraph({
  projects,
  importSites,
  projectOf,
  workspaceLayout,
  exemptedFiles,
}) {
  // Null-prototype for the same reason `buildDependencies` above uses one: a
  // project literally named `__proto__` is a name this provider does not
  // control (it comes straight from `lattice.json` or a tracked manifest), and
  // a plain `{}` answers `nodes["__proto__"] = …` by repointing the object's
  // own prototype instead of adding an entry. That project would then vanish
  // from every `Object.keys(nodes)`/`Object.entries(nodes)` walk in this
  // module and in `../../rules/`, while `nodes["__proto__"]` kept reading back
  // truthy — an import INTO it would still resolve as a real target, but the
  // project's own outgoing edges, its tags, its type would all be invisible to
  // anything that iterates rather than looks up by name. Silent, and exactly
  // the shape `../../../AGENTS.md`'s invariant refuses: a workspace with a
  // `__proto__` project would read as one with fewer projects than it
  // declared, with no diagnostic naming why.
  /** @type {Record<string, object>} */
  const nodes = Object.create(null);
  for (const project of projects) {
    nodes[project.name] = {
      name: project.name,
      type: project.type,
      data: {
        root: project.root,
        tags: project.tags,
        implicitDependencies: project.implicitDependencies,
        ...(project.targets && project.targets.length > 0
          ? {
              targets: Object.fromEntries(
                project.targets.map((name) => [name, { executor: "lattice:declared" }]),
              ),
            }
          : {}),
      },
    };
  }
  return {
    nodes,
    dependencies: buildDependencies({ importSites, nodes, projectOf }),
    ...(workspaceLayout ? { workspaceLayout } : {}),
    ...(exemptedFiles && exemptedFiles.length > 0 ? { exemptedFiles } : {}),
  };
}

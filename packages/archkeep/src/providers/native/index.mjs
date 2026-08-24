/**
 * The native project-model provider: `archkeep.json`, no Nx installed, no
 * Nx-shaped `project.json` required.
 *
 * `../nx.mjs`'s `ProjectModelProvider` is a single call — `readProjectGraph`
 * — because Nx already resolved projects, tags and edges before this package
 * ever asked. Nothing here has done that resolving, so this provider's
 * contract is two calls instead of one: `discover` answers "which projects,
 * and which files does none of them own" from the tree alone, and `buildGraph`
 * turns that plus the import sites analysis found into the same
 * `{nodes, dependencies}` shape `../../rules/index.mjs`'s `evaluate` consumes.
 * The split exists because import-site analysis needs projects to already be
 * known (`../../workspace.mjs`'s `createWorkspace`/`analyzeWorkspace` resolve
 * every relative import against a project list), so a single `readGraph` call
 * would have to hide a whole analysis pass inside a provider — the layer this
 * package's `../../../AGENTS.md` reserves for `../../workspace.mjs` alone.
 *
 * This module imports NOTHING from `../../workspace.mjs`: that file's import
 * graph loads the TypeScript compiler at module scope
 * (`../../process.mjs`'s header), and a workspace with no `.ts` file in it, or no
 * `nx` installed, must still be able to discover its `archkeep.json` projects
 * without paying for a compiler it will never call.
 */
import { projectOwning } from "../../analysis/source-util.mjs";
import { ARCHKEEP_MODEL_FILE, loadNativeModel } from "./model.mjs";
import { discoverNativeProjects } from "./discover.mjs";
import { judgeCoverage } from "./coverage.mjs";
import { buildNativeGraph } from "./graph.mjs";

/**
 * `projectOf`, over `../../analysis/source-util.mjs`'s `projectOwning` — the
 * SAME longest-root-wins answer `../../workspace.mjs`'s `createWorkspace`
 * gives the Nx path, so a file's owner does not depend on which provider
 * found it.
 *
 * @param {{name: string, root: string}[]} projects
 * @returns {(file: string) => string|undefined}
 */
function projectOfFactory(projects) {
  return (file) => projectOwning(projects, file)?.name ?? undefined;
}

/**
 * Discovers a native workspace's projects and judges its coverage.
 *
 * Two failure classes, both loud (`../../../../../AGENTS.md`'s invariant): a model
 * defect — thrown by `loadNativeModel` or `discoverNativeProjects` — and a
 * stale coverage waiver, thrown here once discovery and coverage are both
 * known. An unclaimed file, and an unparseable `project.json`
 * (`./discover.mjs`'s `readProjectManifest`), are NOT throws: both become a
 * `fileFailure` — `./coverage.mjs`'s and `./discover.mjs`'s own — that ride
 * together in `DiscoveredWorkspace.failures`, because `../../../cli.mjs`'s
 * existing exit-3 path already turns any non-empty `unchecked` count into
 * that exit code once the failure reaches `../../report/text.mjs`'s
 * `formatFailures` — the same mechanism a language analyzer's own
 * `fileFailure` already uses, so nothing about either path is native-specific.
 *
 * @param {{root: string, files: string[], readFile: (path: string) => string|null}} args
 * @returns {{projects: {name: string, root: string, type: string, tags: string[], tagOrigins: Record<string, string[]>, implicitDependencies: string[], targets: string[]}[], projectOf: (file: string) => string|undefined, model: object, failures: object[], exempted: string[]}}
 * @throws {Error} on a malformed `archkeep.json`, a discovery defect, or a
 *   stale `coverage.exempt` row.
 */
export function discover({ root, files, readFile }) {
  const model = loadNativeModel(root, { readFile });
  const { projects, failures: discoveryFailures } = discoverNativeProjects({
    root,
    files,
    readFile,
    model,
  });
  const projectOf = projectOfFactory(projects);
  const coverage = judgeCoverage({ files, projectOf, exempt: model.coverage.exempt });

  if (coverage.stale.length > 0) {
    throw new Error(
      `archkeep: ${root}/${ARCHKEEP_MODEL_FILE} describes a workspace that does not match the ` +
        `tree:\n  ` +
        coverage.stale
          .map(
            (row) =>
              `coverage.exempt: '${row.path}' matches no unclaimed file — either the files it ` +
              `covered are now owned by a project, or the path was never right`,
          )
          .join("\n  "),
    );
  }

  // `coverage.exempted` used to stop here: `judgeCoverage` computed which
  // files a `coverage.exempt` row removed from `unclaimed`, and nothing past
  // this function ever read the list back — so a workspace could exempt an
  // unbounded number of files from coverage, forever, with no command, no
  // report line, and no JSON field ever naming a single one of them. An
  // exempted file and a genuinely covered one were byte-for-byte
  // indistinguishable in every surface this tool produces, which is exactly
  // the silent direction `../../../../../AGENTS.md`'s invariant forbids —
  // `check`'s own comment two lines above threatens a stale-exemption throw,
  // but nothing threatened the opposite failure: an exemption nobody could see.
  // `../../commands/context.mjs` threads this onto `CommandContext.analysis`
  // and `../../../cli.mjs`'s `check` reports the count beside every verdict,
  // the same "no violations is a claim about coverage too" treatment the
  // import/file/project counts already get.
  return {
    projects,
    projectOf,
    model,
    failures: [...discoveryFailures, ...coverage.failures],
    exempted: coverage.exempted,
  };
}

/**
 * Builds the graph `evaluate()` judges, from a `discover()` result and the
 * import sites analysis found across the discovered projects' files.
 *
 * `workspaceLayout` is threaded from `discovered.model` straight onto the
 * graph object returned — declared-or-absent, never defaulted here, the same
 * rule `./model.mjs`'s `normalizeNativeModel` documents (`../../rules/index.mjs`'s
 * `createContext` is the one place that ever applies `DEFAULT_WORKSPACE_LAYOUT`).
 *
 * `exemptedFiles` threads the same way, from `discovered.exempted`: the
 * concrete files `coverage.exempt` removed from coverage. This is the one
 * seam both faces of a native workspace flow through — this CLI's native
 * branch (`../../../src/commands/context.mjs`) and the language server's
 * (`../../../src/lsp/workspace-index.mjs`) both build their graphs here — so
 * threading it in the provider is what keeps an editor verdict and a
 * `archkeep check` verdict on the same exempt-file import from disagreeing.
 *
 * @param {{discovered: ReturnType<typeof discover>, importSites: object[]}} args
 * @returns {{nodes: Record<string, object>, dependencies: Record<string, object[]>, workspaceLayout?: {appsDir: string, libsDir: string}, exemptedFiles?: string[]}}
 */
export function buildGraph({ discovered, importSites }) {
  return buildNativeGraph({
    projects: discovered.projects,
    importSites,
    projectOf: discovered.projectOf,
    workspaceLayout: discovered.model.workspaceLayout,
    exemptedFiles: discovered.exempted,
  });
}

/**
 * The `ProjectModelProvider`-family object `../../../cli.mjs` selects when a
 * workspace root carries `archkeep.json` rather than `nx.json` (`../nx.mjs`'s
 * `ProjectModelProvider` doc explains the seam both providers implement, and
 * why this one's shape is two calls rather than `readProjectGraph`'s one).
 */
export const nativeProvider = {
  name: "native",
  marker: ARCHKEEP_MODEL_FILE,
  discover,
  buildGraph,
};

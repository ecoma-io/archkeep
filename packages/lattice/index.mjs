/**
 * The engine entry — what a consumer gets from `import "@ecoma-io/lattice"`.
 * Nx is one caller of this graph, not the only one: the CLI (`cli.mjs`) and
 * the language server (`lsp.mjs`) both work from these same primitives, and
 * this file is the surface a future integration (Bazel, Turborepo, a CI
 * action) would import instead of reaching into `src/` directly. The Nx
 * plugin itself lives at the `./nx` subpath (`nx.mjs`) — the one module
 * `nx.json → plugins` is allowed to name — precisely so that loading the
 * engine never pulls Nx's own startup path in for free.
 *
 * What's re-exported here is discovery (read a real workspace: the project
 * graph, tracked files, per-file analysis) and judgment (evaluate that
 * workspace against a boundary config) — the two halves `cli.mjs` composes.
 * Nothing under `src/rules/`, `src/analysis/`, or `src/report/` is duplicated
 * here; this module only re-exports their public functions. The one
 * exception is `createDependencies` below, which is not a re-export and
 * holds one line of logic: a guard against exactly this file being
 * misregistered as the Nx plugin face that `./nx` (`nx.mjs`) alone is meant
 * to be.
 */
export {
  annotateMFERemotes,
  annotatePackageFacts,
  analyzeWorkspace,
  createWorkspace,
  declaredPackages,
  environmentForTree,
  findWorkspaceRoot,
  listTrackedFiles,
  packageEntryPoints,
  projectIsMFERemote,
  runProcess,
  selectFiles,
} from "./src/workspace.mjs";

export { nxProvider, readProjectGraph } from "./src/providers/nx.mjs";

export {
  analyzeFile,
  analyzerFor,
  LANGUAGE_BY_EXTENSION,
  languageOf,
} from "./src/analysis/analyze.mjs";

export {
  findBoundaryConfigViolations,
  loadBoundaryConfig,
  loadBoundaryConfigFile,
  suppressionCovers,
} from "./src/config.mjs";

export { evaluate, MESSAGE_IDS, MESSAGES, renderMessage } from "./src/rules/index.mjs";

/**
 * The one export this file adds beyond a re-export, and it exists to fail
 * loudly rather than to do anything.
 *
 * Measured against nx 23.1.1 in this tree: a consumer writing
 * `"plugins": ["@ecoma-io/lattice"]` in `nx.json` — the bare package name,
 * missing the `/nx` — resolves to this file. Before this export existed the
 * file had neither `name` nor `createDependencies`, and Nx accepted that
 * silently: `nx graph` exited 0, printed no warning, and computed zero
 * polyglot edges, indistinguishable from a workspace with nothing to find.
 * That is the exact failure this project exists to refuse, one layer above
 * every check it ships: a misregistration that reads as a clean graph.
 *
 * Exporting `name` alongside this was tried and measured too, and dropped:
 * with only `name` added (still no `createDependencies`) Nx's behaviour did
 * not change at all — same exit 0, same silence, same empty graph — so it
 * buys nothing. `createDependencies` throwing is what Nx actually surfaces:
 * with this export in place, `nx graph` prints the message below to the
 * terminal, naming the fix. `name` is left for `./nx` alone to export, which
 * keeps this file from looking like a working plugin face — it is the
 * engine, not the face; `CLAUDE.md` ("Layout, and what each layer may know")
 * says which module carries which.
 *
 * @throws {Error} named `lattice: registered as the engine entry`, always.
 */
export function createDependencies() {
  throw new Error(
    "lattice: registered as the engine entry, not the Nx plugin face — nx.json named " +
      '"@ecoma-io/lattice" instead of "@ecoma-io/lattice/nx". Change the `plugin` value in ' +
      'nx.json to "@ecoma-io/lattice/nx" (README.md, "Installing it").',
  );
}

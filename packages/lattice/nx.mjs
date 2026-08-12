/**
 * Nx plugin entry — the module `nx.json → plugins` names, reached through this
 * package's `./nx` subpath export, and the only surface Nx itself is allowed
 * to know about.
 *
 * It holds no logic on purpose. Nx loads this file on every graph computation,
 * including on machines running a single unrelated target, so what it imports
 * is what every `nx` invocation pays for. Keeping the entry a re-export means
 * the rule engine, the CLI, and the language server can grow under `src/`
 * without any of it being dragged into Nx's own startup path — and it keeps
 * `CreateDependenciesContext`, the shape most likely to move under an Nx
 * upgrade, touching exactly one module (`src/graph/create-dependencies.mjs`).
 *
 * The plugin's own contract with Nx is the two names below: `name`, and a
 * `createDependencies` returning raw dependency records. The root entry
 * (`index.mjs`) is the engine those same primitives serve to the CLI and the
 * language server — Nx is one caller of the graph, not the only one.
 */
export {
  createDependencies,
  resolvePolyglotDependencies,
} from "./src/graph/create-dependencies.mjs";

export const name = "lattice";

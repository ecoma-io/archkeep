/**
 * The Nx project-model provider — the seam's first (and today, only)
 * implementation.
 *
 * `evaluate(importSites, graph, config)` in `../rules/index.mjs` is pure and
 * takes a graph it does not build (`../../CLAUDE.md`, "Layout, and what each
 * layer may know"). Something still has to produce that graph, and until this
 * module existed the answer was hardcoded into `../workspace.mjs`: `check()`
 * called `readProjectGraph` and there was nowhere else the graph could come
 * from. This file is that answer pulled out from behind the hardcoding — the
 * `ProjectModelProvider` contract below is what a second source (a
 * `lattice.json`-driven native model, with no Nx installed at all) will
 * implement beside this one, without `../workspace.mjs`, `../../cli.mjs`, or
 * `../lsp/` needing to know which provider they are holding.
 *
 * @typedef {object} ProjectModelProvider
 * @property {string} name Short, stable identifier — `"nx"` here — for a
 *   diagnostic that needs to say which provider answered (or failed to).
 * @property {(workspaceRoot: string, io?: object) => object} readProjectGraph
 *   The workspace root, plus whatever spawns/reads this provider needs
 *   injected for a test — and back comes the graph half of the shape
 *   `evaluate()` consumes: `{nodes, dependencies}`, plus `externalNodes` and
 *   `workspaceLayout` when the provider's source of truth carries them (this
 *   one's does not — `nx graph --file=` emits neither, see `readProjectGraph`
 *   below). Everything the source DOES emit must travel inside that one
 *   object, because a provider that dropped a field its source supplied would
 *   force a second call to the same source outside the seam. Three node facts
 *   deliberately do NOT come from the provider: `mfeRemote`, `entryPoints`
 *   and `declaredPackages` are annotated onto `graph.nodes` by the caller
 *   afterwards (`../../cli.mjs`, via `annotateMFERemotes` and
 *   `annotatePackageFacts`), read from disk the way upstream reads them — a
 *   provider that filled them in would only be overwritten.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runProcess } from "../workspace.mjs";

const require = createRequire(import.meta.url);

/**
 * Absolute path to Nx's own CLI entry — the JS file its `nx` bin points at.
 *
 * Spawned under this Node binary rather than through `pnpm nx`, which takes the
 * package manager's platform-specific bin shim out of the picture instead of
 * wrapping it, and leaves no shell for a `TMPDIR` carrying metacharacters to
 * reach. It resolves by Node's own rules from this file's location, and that is
 * correct rather than incidental: `nx` is a **peer** dependency, so what those
 * rules find is the copy the consumer installed — the same version answering
 * `pnpm nx` in their tree — and never a second one bundled in here. A tool that
 * shipped its own Nx could report a graph the workspace's own CLI disagrees with.
 *
 * `nx` is declared `peerDependenciesMeta.nx.optional`, so this resolution is
 * allowed to fail — but `check()` calls `readProjectGraph` unconditionally
 * (`../../cli.mjs`), so a workspace that never installed `nx` gets no working
 * `lattice check` at all: every run exits 3 with the diagnostic below. The
 * "Installing it" section of `../../README.md` states the same thing for a
 * reader outside this file. What this function must not do on failure is let
 * Node's own
 * `MODULE_NOT_FOUND` reach the caller: that error names a package specifier,
 * not a workspace-facing action, and `cli.mjs` prints `error.message` verbatim
 * on the exit-3 path — a raw resolver stack there would read as a bug in this
 * tool rather than the true cause, an absent peer.
 *
 * `resolveNx` is injectable for the same reason `run` is: this repository has
 * `nx` installed, so nothing here can drive the real "not installed" path
 * without faking the resolver — `nx.test.mjs` does exactly that, over a
 * `resolveNx` that throws the way `require.resolve` does when nothing on disk
 * answers `nx/package.json`. It takes no argument because it only ever
 * resolves that one specifier — accepting one and forwarding it to
 * `require`'s own resolver would hand that call a variable rather than a
 * literal, which is exactly the load `../conformance/boundary.test.mjs`
 * cannot see through and reports as opaque rather than trusting.
 *
 * @param {{ resolveNx?: () => string }} [io]
 * @throws {Error} named `lattice: nx is not installed`, when `resolveNx`
 *   cannot find it.
 */
function nxCli({ resolveNx = () => require.resolve("nx/package.json") } = {}) {
  let manifest;
  try {
    manifest = resolveNx();
  } catch (cause) {
    // Only an absent package earns the "not installed" story. Any other
    // resolver failure — say, an installed nx whose `exports` stopped exposing
    // `./package.json` — is a different fact, and renaming it here would send
    // the reader to install a package they already have.
    if (/** @type {{code?: string}} */ (cause)?.code !== "MODULE_NOT_FOUND") throw cause;
    throw new Error(
      "lattice: nx is not installed — `nx` is an optional peer dependency, needed only for " +
        "`lattice check`'s project-graph discovery (`nx graph`). Install it in this workspace, " +
        "or run a command that does not need the graph.",
      { cause },
    );
  }
  const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
  return join(dirname(manifest), typeof bin === "string" ? bin : bin.nx);
}

/**
 * The Nx project graph for `workspaceRoot`, in the shape `evaluate()` consumes.
 *
 * `nx graph --file=<json>` emits `{ graph: { nodes, dependencies } }` and no
 * `externalNodes`; the rule engine synthesises those from the analysis records
 * instead, which is what makes `bannedExternalImports` reachable for crates and
 * Go modules at all (`../rules/index.mjs` → `externalNodeFor`).
 *
 * @param {string} workspaceRoot
 * @param {{ run?: typeof runProcess, resolveNx?: () => string }} [io]
 *   Injectable spawn, and injectable Nx resolution (see `nxCli`).
 * @returns {object} `{ nodes, dependencies }`.
 */
export function readProjectGraph(workspaceRoot, { run = runProcess, resolveNx } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lattice-"));
  const file = join(dir, "graph.json");
  try {
    run(process.execPath, [nxCli({ resolveNx }), "graph", `--file=${file}`], workspaceRoot);
    const { graph } = JSON.parse(readFileSync(file, "utf8"));
    if (!graph?.nodes) {
      throw new Error(
        `lattice: \`nx graph\` produced no \`graph.nodes\` in ${file} — ` +
          `nothing can be judged against a graph with no projects in it`,
      );
    }
    return graph;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The `ProjectModelProvider` object a future provider-selection seam holds —
 * not consumed by anything yet (`cli.mjs` and `index.mjs` still import
 * `readProjectGraph` directly, the same function this wraps), but exported now
 * so a second provider has a real shape to match rather than a description of
 * one.
 *
 * @type {ProjectModelProvider}
 */
export const nxProvider = {
  name: "nx",
  readProjectGraph,
};

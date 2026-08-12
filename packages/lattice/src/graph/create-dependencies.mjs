/**
 * The graph layer: cross-project EDGES for Go, Rust, and Python, in the shape
 * Nx's `createDependencies` hook returns. Nothing else — nodes still come from
 * each project's hand-written `project.json`, and targets are never inferred
 * (`packages/lattice/CLAUDE.md`).
 *
 * This is the plugin half of the tool, and it is deliberately separate from
 * `../analysis/`. The two answer different questions over the same tree: the
 * graph asks "does project A depend on project B", which is all `nx affected`
 * can act on, while analysis asks "which import, written where, in what form" —
 * a superset a boundary rule needs and an Nx edge cannot carry
 * (`../analysis/contract.md`). Keeping them apart is what stops the graph from
 * growing fields Nx will drop and analysis from being trimmed to what Nx keeps.
 *
 * Each resolver reads tracked manifests and sources statically (regex for Go
 * imports, smol-toml for Cargo/pyproject manifests) so the graph computes
 * without any language toolchain installed. A workspace with no Go/Rust/Python
 * projects pays nothing: every resolver keys off `<projectRoot>/<manifest>`
 * existing in the project's tracked files. A resolver may THROW instead of
 * returning — the Python one does, for a declared path dependency it cannot
 * attribute to any project (`../analysis/python.mjs` header) — and the throw
 * is deliberate: edges and an error are the only two outputs this hook has,
 * and an edge quietly missing from the graph is the failure mode this plugin
 * exists to close.
 *
 * Resolver contract (kept identical across languages, see `../analysis/*.mjs`):
 *   resolve(projects, filesOf, readFile) -> [{ source, target, sourceFile, type }]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveGoDependencies } from "../analysis/go.mjs";
import { resolvePythonDependencies } from "../analysis/python.mjs";
import { resolveRustDependencies } from "../analysis/rust.mjs";
import { resolveOptions } from "../options.mjs";

/** Pure core over an abstract workspace; injectable for tests. */
export function resolvePolyglotDependencies(projects, filesOf, readFile) {
  const deps = [
    ...resolveGoDependencies(projects, filesOf, readFile),
    ...resolveRustDependencies(projects, filesOf, readFile),
    ...resolvePythonDependencies(projects, filesOf, readFile),
  ];
  // One edge per (source, target, sourceFile) — a Go project importing a
  // sibling from ten files yields ten sourceFile-attributed edges upstream
  // of us; Nx dedupes too, this just keeps the plugin's output canonical.
  const seen = new Set();
  return deps.filter((d) => {
    const key = `${d.source} ${d.target} ${d.sourceFile}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The Nx hook.
 *
 * `options` is validated and then not used, and both halves of that are
 * deliberate. Edge resolution reads language manifests, whose names are fixed
 * external contracts rather than options (`../options.mjs` says why) — so
 * nothing here needs a value from the table. Validating it anyway is what makes
 * a typo'd key fail at the FIRST graph computation, which every `nx` invocation
 * performs, instead of waiting for whichever later CLI or editor run happens to
 * read the same table. The alternative is a workspace that lints green all week
 * and discovers on Friday that its `tsConfig` was spelled `tsconfigBase` and no
 * path alias ever resolved.
 */
export const createDependencies = (options, context) => {
  resolveOptions(options);
  const projects = Object.entries(context.projects).map(([projectName, config]) => ({
    name: projectName,
    root: config.root,
  }));
  const filesOf = (projectName) =>
    (context.fileMap?.projectFileMap?.[projectName] ?? []).map((f) => f.file);
  const readFile = (workspaceRelativePath) => {
    try {
      return readFileSync(join(context.workspaceRoot, workspaceRelativePath), "utf8");
    } catch {
      return null;
    }
  };
  return resolvePolyglotDependencies(projects, filesOf, readFile);
};

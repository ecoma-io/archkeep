/**
 * Oracle 1: the same workspace, modelled twice — once as an Nx tree
 * (`nx.json`, `project.json`, a REAL `nx graph` spawn) and once as a native
 * tree (`lattice.json`, no `nx.json`, no Nx CLI reachable) — must agree.
 *
 * Every other test of `../nx.mjs` and `./index.mjs` proves each provider
 * correct against its own fixtures; none puts them side by side. That is
 * this file's one job: build one physical shape (two Go modules, one crossing
 * import, one boundary rule) twice, feed the SAME rule engine both providers'
 * output, and assert the node set, the dependency set, and the verdict list
 * come out identical. A provider that silently disagreed with the other on a
 * tag, a root spelling, or an edge would be a native workspace whose `check`
 * result depends on which project model it happened to run under — exactly
 * the drift `../../../../../AGENTS.md`'s invariant exists to rule out.
 *
 * `../nx.mjs`'s `readProjectGraph` spawns the real `nx` CLI resolved from
 * THIS repository's own `node_modules` (its own header explains why: `nx` is
 * a peer dependency resolved from the caller, never bundled). For that
 * resolution to succeed with no `pnpm install` run inside the fixture, the
 * fixture directory is created UNDER `packages/lattice/` itself — not the
 * system tmpdir every other integration test uses — so Node's own directory
 * walk-up finds this package's already-installed `node_modules/nx`. Verified
 * empirically before writing this file: the identical fixture shape spawned
 * against a bare system-tmpdir fails with `NX Could not find Nx modules`,
 * and succeeds once nested here with no other change.
 *
 * The Nx fixture's `nx.json` registers `../nx.mjs` — this package's own
 * plugin — as a LOCAL plugin, by relative path rather than by package name:
 * `nx graph` cannot draw a Go import edge on its own (`../../../../../AGENTS.md`'s
 * "what this repository is" — Nx reads TypeScript and stays quiet on
 * everything else), so without a plugin computing that edge the Nx side of
 * this comparison would trivially show zero dependencies and the test would
 * prove nothing. This is the plugin under test, so registering it here is
 * the same self-check `node packages/lattice/cli.mjs check` already runs
 * over this repository's OWN boundaries, aimed at a throwaway tree instead.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { normalizeProjectRoot } from "../../rules/specifiers.mjs";
import { evaluate } from "../../rules/index.mjs";
import { loadBoundaryConfig } from "../../config.mjs";
import { analyzeWorkspace, createWorkspace, selectFiles } from "../../workspace.mjs";
import { readProjectGraph } from "../nx.mjs";
import { nativeProvider } from "./index.mjs";

// `packages/lattice/`, three levels above this file (`native/` → `providers/`
// → `src/` → the package root) — see the header for why the Nx fixture must
// live under here rather than the system tmpdir.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const BOUNDARY_CONFIG = `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;

// One physical shape, written byte-identical into both trees below: two Go
// modules, tagged opposite the layer axis, with one import that crosses it
// the wrong way (`domain` reaching into `adapter`).
const GO_FILES = {
  "libs/domain/go.mod": "module example.com/domain\n\ngo 1.24\n",
  "libs/adapter/go.mod": "module example.com/adapter\n\ngo 1.24\n",
  "libs/adapter/adapter.go": 'package adapter\n\nvar Name = "adapter"\n',
  "libs/domain/doc.go": `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
};

/** @param {(path: string, text: string) => void} write */
function writeGoFiles(write) {
  for (const [path, text] of Object.entries(GO_FILES)) write(path, text);
}

describe("the Nx and native providers agree over one physical workspace", () => {
  const nxRoot = mkdtempSync(join(packageRoot, ".oracle-nx-"));
  const nativeRoot = mkdtempSync(join(packageRoot, ".oracle-native-"));
  afterAll(() => {
    rmSync(nxRoot, { recursive: true, force: true });
    rmSync(nativeRoot, { recursive: true, force: true });
  });

  const writeIn = (root) => (relativePath, text) => {
    mkdirSync(join(root, relativePath, ".."), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  };

  // --- the Nx tree: nx.json, project.json per project, this package's own
  // plugin registered by relative path so a real `nx graph` draws the Go edge.
  const writeNx = writeIn(nxRoot);
  writeNx(
    "nx.json",
    JSON.stringify({
      plugins: [
        {
          plugin: "../nx.mjs",
          options: { boundaryConfig: "module-boundaries.config.mjs" },
        },
      ],
    }),
  );
  writeNx("module-boundaries.config.mjs", BOUNDARY_CONFIG);
  writeNx("libs/domain/project.json", JSON.stringify({ name: "domain", tags: ["layer:domain"] }));
  writeNx(
    "libs/adapter/project.json",
    JSON.stringify({ name: "adapter", tags: ["layer:adapter"] }),
  );
  writeGoFiles(writeNx);
  const nxFiles = [
    "nx.json",
    "module-boundaries.config.mjs",
    "libs/domain/project.json",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/project.json",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
  ];

  // --- the native tree: lattice.json declares the identical two projects,
  // same names, same tags, same roots — no nx.json, no project.json, no `nx`
  // reachable from here at all.
  const writeNative = writeIn(nativeRoot);
  writeNative(
    "lattice.json",
    JSON.stringify({
      projects: {
        declared: [
          { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
          { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
        ],
      },
      coverage: {
        exempt: [
          {
            path: "module-boundaries.config.mjs",
            reason: "workspace tooling config at the root, not itself a project",
          },
        ],
      },
    }),
  );
  writeNative("module-boundaries.config.mjs", BOUNDARY_CONFIG);
  writeGoFiles(writeNative);
  const nativeFiles = [
    "lattice.json",
    "module-boundaries.config.mjs",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
  ];

  const readFileFrom = (root) => (path) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return null;
    }
  };

  /** Builds `{workspace, imports}` from an already-resolved graph and file list. */
  function analyze(root, graph, files, tsConfig) {
    const { workspace, owned } = createWorkspace({ root, graph, files, tsConfig });
    const selected = selectFiles(
      owned.map(({ file }) => file),
      [],
      { root, cwd: root },
    );
    return { workspace, ...analyzeWorkspace(workspace, selected) };
  }

  /** `{name → {root, type, tags}}`, comparable whichever provider produced it. */
  const nodeShape = (nodes) =>
    Object.fromEntries(
      Object.entries(nodes).map(([name, node]) => [
        name,
        {
          root: normalizeProjectRoot(node.data.root),
          type: node.type,
          tags: [...(node.data.tags ?? [])].sort(),
        },
      ]),
    );

  /** `["source target type", ...]`, sorted so build order cannot matter. */
  const dependencyShape = (dependencies) =>
    Object.values(dependencies)
      .flat()
      .map(({ source, target, type }) => `${source} ${target} ${type}`)
      .sort();

  /** `["messageId sourceFile:line:column", ...]`, sorted the same way. */
  const verdictShape = (violations) =>
    violations.map((v) => `${v.messageId} ${v.sourceFile}:${v.line}:${v.column}`).sort();

  // Spawning the real Nx CLI is slow relative to every other test here (a
  // subprocess Node start, a plugin load, a graph write to a tmp file) — this
  // test's own timeout is generous rather than the vitest default, so a
  // loaded CI runner does not flake a passing graph into a timeout.
  it("resolves the same node set, dependency set, and verdict from a real nx graph and from lattice.json", async () => {
    // The real Nx CLI, resolved from this repo's own node_modules — no fake
    // `readGraph`, unlike every other test in this package.
    const nxGraph = readProjectGraph(nxRoot);
    const nxAnalysis = analyze(nxRoot, nxGraph, nxFiles, undefined);

    const readFile = readFileFrom(nativeRoot);
    const discovered = nativeProvider.discover({ root: nativeRoot, files: nativeFiles, readFile });
    expect(discovered.failures).toEqual([]);
    const preGraph = {
      nodes: Object.fromEntries(
        discovered.projects.map((project) => [
          project.name,
          { name: project.name, data: { root: project.root } },
        ]),
      ),
    };
    const nativeAnalysis = analyze(nativeRoot, preGraph, nativeFiles, discovered.model.tsConfig);
    const nativeGraph = nativeProvider.buildGraph({
      discovered,
      importSites: nativeAnalysis.imports,
    });

    // 1. The node sets agree — same names, same roots (modulo Nx's own `''`
    // vs `'.'` normalization), same types, same tags.
    expect(nodeShape(nativeGraph.nodes)).toEqual(nodeShape(nxGraph.nodes));

    // 2. The dependency sets agree — the plugin registered in the Nx
    // fixture's `nx.json` and `./graph.mjs`'s `buildDependencies` both had to
    // find the SAME crossing import from the SAME Go source.
    expect(dependencyShape(nativeGraph.dependencies)).toEqual(
      dependencyShape(nxGraph.dependencies),
    );

    // 3. The rule engine, given each side's own graph and its own import
    // sites over the same boundary config, reaches the same verdict:
    // `domain` importing `adapter` violates `onlyDependOnLibsWithTags`, once,
    // wherever the graph came from.
    const nxConfig = await loadBoundaryConfig(nxRoot, "module-boundaries.config.mjs");
    const nativeConfig = await loadBoundaryConfig(nativeRoot, "module-boundaries.config.mjs");
    const nxViolations = evaluate(nxAnalysis.imports, nxGraph, nxConfig);
    const nativeViolations = evaluate(nativeAnalysis.imports, nativeGraph, nativeConfig);

    expect(nxViolations).toHaveLength(1);
    expect(verdictShape(nativeViolations)).toEqual(verdictShape(nxViolations));
  }, 30_000);
});

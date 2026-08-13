/**
 * The fixture workspaces the differential runs over — one Nx-shaped tree per
 * case, all inside a single throwaway root.
 *
 * ## Why one root and not one per case
 *
 * `@nx/enforce-module-boundaries` reads the workspace root through
 * `@nx/devkit`'s `workspaceRoot`, which is a module-level constant evaluated the
 * first time nx is loaded in a process. It cannot be changed afterwards, so a
 * process can serve exactly one workspace root. Every case therefore lives in
 * its own directory UNDER one root, and the whole differential runs in one
 * process instead of one process per case.
 *
 * Two consequences the case catalogue has to respect, both asserted here rather
 * than trusted: import aliases and fake package names are workspace-wide, so
 * they must be globally unique; project names are per-case (each case gets its
 * own graph) and only have to be unique within their case.
 *
 * ## Why the tree is on disk at all
 *
 * Upstream reads files this layer cannot hand it: a project's `package.json`
 * `exports` for entry points, `module-federation.config.js` for the MFE
 * exemption, the root and project `package.json` for `banTransitiveDependencies`,
 * and `tsconfig.base.json` for resolution. A fixture that only existed as a
 * graph object would exercise this engine and stub upstream, which is the
 * opposite of a differential test. So the tree is real, both engines read the
 * same bytes, and the graph object is the only thing handed to both.
 *
 * The root is a `mkdtemp` directory under the OS temp dir and nothing is ever
 * written inside the repository. That containment is what keeps this
 * repository's own lint, format and test targets from reaching a fixture:
 * there is nothing to reach until a test creates it, and nothing left after.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The environment variable nx reads before it computes a workspace root, named
 * once. Set before nx is ever loaded, it decides the root for the whole process.
 */
const NX_ROOT_ENV = "NX_WORKSPACE_ROOT_PATH";

/**
 * The compiler options a fixture's `tsconfig.base.json` carries.
 *
 * Copied from this workspace's own `tsconfig.base.json` rather than invented:
 * module resolution mode decides which specifiers resolve at all, and a fixture
 * resolving under different rules than the tree it stands in would prove
 * agreement about a workspace nobody has.
 */
const FIXTURE_COMPILER_OPTIONS = Object.freeze({
  target: "ES2022",
  module: "ESNext",
  moduleResolution: "Bundler",
  baseUrl: ".",
});

/** Creates a directory's parent chain and writes `text` into it. */
function write(root, relative, text) {
  const absolute = join(root, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

/**
 * Creates the throwaway root every case is materialised into and points nx at
 * it.
 *
 * **Call this before anything loads nx.** `@nx/devkit`'s `workspaceRoot` is
 * evaluated on first load and never re-read, so a later call would silently
 * leave upstream reading the real repository — every `package.json` and
 * `module-federation.config.js` lookup would answer about this workspace
 * instead of about the fixture. `assertNxRootIsFixture` is the loud check that
 * this ordering held.
 *
 * @returns {string} the absolute, symlink-resolved root.
 */
export function createFixtureRoot() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "polyglot-conformance-"));
  process.env[NX_ROOT_ENV] = root;
  return root;
}

/** Removes a fixture root and everything under it. */
export function removeFixtureRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

/**
 * Fails loudly when nx resolved a workspace root other than the fixture's.
 *
 * The failure this guards is silent and total: upstream would read the real
 * repository's files while judging fixture paths, and every disagreement the
 * suite reported would be an artefact of that. Checked once, after the engines
 * are loaded.
 *
 * @param {string} root
 * @param {string} nxWorkspaceRoot What `@nx/devkit` resolved.
 */
export function assertNxRootIsFixture(root, nxWorkspaceRoot) {
  if (nxWorkspaceRoot === root) return;
  throw new Error(
    `lattice conformance: nx resolved its workspace root to ${nxWorkspaceRoot}, ` +
      `not the fixture root ${root}. Something loaded nx before createFixtureRoot() ran, so ` +
      `upstream would read this repository's files while judging fixture paths — every ` +
      `verdict after this point would be an artefact of that.`,
  );
}

/** `{name, files}` of every fake package the catalogue installs, deduplicated. */
function collectExternals(cases) {
  const byName = new Map();
  for (const spec of cases) {
    for (const external of spec.externals ?? []) {
      const previous = byName.get(external.name);
      const serialized = JSON.stringify(external.files ?? {});
      if (previous && previous.serialized !== serialized) {
        throw new Error(
          `lattice conformance: case '${spec.id}' installs package ` +
            `'${external.name}' with different contents than an earlier case. Fake packages ` +
            `share one node_modules, so a name means one thing across the whole catalogue.`,
        );
      }
      byName.set(external.name, { external, serialized });
    }
  }
  return [...byName.values()].map((entry) => entry.external);
}

/** Every alias the catalogue declares, as workspace-relative targets. */
function collectAliases(cases) {
  const paths = {};
  const owner = new Map();
  for (const spec of cases) {
    for (const [alias, target] of Object.entries(spec.aliases ?? {})) {
      if (owner.has(alias)) {
        throw new Error(
          `lattice conformance: cases '${owner.get(alias)}' and '${spec.id}' both ` +
            `declare the alias '${alias}'. Aliases live in one shared tsconfig.base.json, so a ` +
            `duplicate would silently point one case's import into the other case's tree.`,
        );
      }
      owner.set(alias, spec.id);
      paths[alias] = [`${spec.id}/${target}`];
    }
  }
  return paths;
}

/** The package names every case wants the ROOT manifest to declare. */
function collectRootDependencies(cases) {
  const dependencies = {};
  for (const spec of cases) {
    for (const name of spec.rootDependencies ?? []) dependencies[name] = "1.0.0";
  }
  return dependencies;
}

/**
 * A default `package.json` for a fake package, wired so both a bare import and
 * a nested one resolve.
 *
 * `"./*": "./*.d.ts"` is what makes `@scope/pkg/sub` resolve under
 * `moduleResolution: "Bundler"`, which is the resolution mode this workspace
 * runs — a package whose deep path did not resolve would make every nested-path
 * case vacuous rather than failing.
 */
const fakePackageManifest = (name) =>
  `${JSON.stringify(
    {
      name,
      version: "1.0.0",
      types: "./index.d.ts",
      exports: { ".": "./index.d.ts", "./*": "./*.d.ts" },
    },
    null,
    2,
  )}\n`;

/** Writes the files every fixture root shares, once. */
function writeSharedRoot(root, cases) {
  write(root, "nx.json", "{}\n");
  write(
    root,
    "package.json",
    `${JSON.stringify(
      {
        name: "polyglot-conformance-fixture",
        version: "0.0.0",
        private: true,
        dependencies: collectRootDependencies(cases),
      },
      null,
      2,
    )}\n`,
  );
  write(
    root,
    "tsconfig.base.json",
    `${JSON.stringify(
      { compilerOptions: { ...FIXTURE_COMPILER_OPTIONS, paths: collectAliases(cases) } },
      null,
      2,
    )}\n`,
  );
  for (const external of collectExternals(cases)) {
    // `install: false` registers the external NODE without putting a package on
    // disk. The nested-ban cases need exactly that: the specifier must resolve
    // through a `paths` alias to a project, while the graph still knows a
    // package of that name exists somewhere in the dependency closure.
    if (external.install === false) continue;
    const files = external.files ?? { "index.d.ts": "export declare const value: number;\n" };
    write(root, `node_modules/${external.name}/package.json`, fakePackageManifest(external.name));
    for (const [relative, text] of Object.entries(files)) {
      write(root, `node_modules/${external.name}/${relative}`, text);
    }
  }
}

/**
 * The Nx project graph a case declares, in Nx's own shape.
 *
 * The four optional node fields this engine reads — `mfeRemote`, `entryPoints`,
 * `declaredPackages` and the project's `targets` — are attached here exactly as
 * the case asks, INCLUDING when it asks for them to be absent. Their absence is
 * what the fail-closed cases are about, so the materialiser must not helpfully
 * fill one in.
 */
function buildGraph(spec) {
  const nodes = {};
  for (const project of spec.projects) {
    const data = {
      root: `${spec.id}/${project.root}`,
      tags: project.tags ?? [],
      targets: project.targets ?? {},
    };
    if (project.mfeRemote !== undefined) data.mfeRemote = project.mfeRemote;
    if (project.declaredPackages !== undefined) data.declaredPackages = project.declaredPackages;
    if (project.entryPoints !== undefined) {
      data.entryPoints = project.entryPoints.map((entry) => ({
        path: `${spec.id}/${entry.path}`,
        file: `${spec.id}/${entry.file}`,
      }));
    }
    nodes[project.name] = { name: project.name, type: project.type ?? "lib", data };
  }

  const externalNodes = {};
  for (const external of spec.externals ?? []) {
    if (external.node === false) continue;
    externalNodes[`npm:${external.name}`] = {
      name: `npm:${external.name}`,
      type: "npm",
      data: { packageName: external.name, version: "1.0.0" },
    };
  }

  const dependencies = Object.fromEntries(Object.keys(nodes).map((name) => [name, []]));
  for (const edge of spec.edges ?? []) {
    dependencies[edge.source].push({
      source: edge.source,
      target: edge.target,
      type: edge.type ?? "static",
    });
  }
  const graph = { nodes, externalNodes, dependencies };
  if (spec.workspaceLayout !== undefined) graph.workspaceLayout = spec.workspaceLayout;
  return graph;
}

/**
 * Upstream's `projectFileMap`: every project's files, each carrying the graph
 * edges its project declares.
 *
 * Only two messages read it (`noCircularDependencies` and
 * `noImportsOfLazyLoadedLibraries`, both of which list files in their text), and
 * `findFilesWithDynamicImports` indexes it unguarded — a project missing from
 * the map throws rather than printing a shorter message. So every project gets
 * an entry, whether or not it owns any file.
 *
 * The dependency shape is nx's own two-element `[target, type]` form, which is
 * what `fileDataDepTarget`/`fileDataDepType` read.
 */
function buildProjectFileMap(spec) {
  const map = {};
  for (const project of spec.projects) {
    const deps = (spec.edges ?? [])
      .filter((edge) => edge.source === project.name)
      .map((edge) => [edge.target, edge.type ?? "static"]);
    map[project.name] = Object.keys(project.files ?? {}).map((relative) => ({
      file: `${spec.id}/${project.root}/${relative}`,
      deps,
    }));
  }
  return map;
}

/** Every source file the case owns, workspace-relative, in declaration order. */
function projectFiles(spec) {
  return spec.projects.flatMap((project) =>
    Object.keys(project.files ?? {}).map((relative) => `${spec.id}/${project.root}/${relative}`),
  );
}

/** Writes one case's tree: its projects, their files and manifests, plus loose files. */
function writeCase(root, spec) {
  for (const project of spec.projects) {
    const base = `${spec.id}/${project.root}`;
    for (const [relative, text] of Object.entries(project.files ?? {})) {
      write(root, `${base}/${relative}`, text);
    }
    if (project.packageJson) {
      write(root, `${base}/package.json`, `${JSON.stringify(project.packageJson, null, 2)}\n`);
    }
    if (project.moduleFederation) {
      write(root, `${base}/module-federation.config.js`, project.moduleFederation);
    }
  }
  for (const [relative, text] of Object.entries(spec.looseFiles ?? {})) {
    write(root, `${spec.id}/${relative}`, text);
  }
}

/**
 * Materialises the whole catalogue into `root`.
 *
 * @param {string} root From `createFixtureRoot`.
 * @param {object[]} cases The catalogue.
 * @param {object} defaultOptions The plugin's OWN `defaultOptions[0]`, read off
 *   the installed rule — never restated here, so a case states only what it
 *   changes and no copy of the eight option values can drift.
 * @returns {Map<string, object>} case id → everything both engines need.
 */
export function materialize(root, cases, defaultOptions) {
  writeSharedRoot(root, cases);
  const materialized = new Map();
  for (const spec of cases) {
    if (materialized.has(spec.id)) {
      throw new Error(`lattice conformance: duplicate case id '${spec.id}'`);
    }
    writeCase(root, spec);
    const { depConstraints: _ignored, ...optionDefaults } = defaultOptions;
    materialized.set(spec.id, {
      spec,
      graph: buildGraph(spec),
      projectFileMap: buildProjectFileMap(spec),
      files: projectFiles(spec),
      depConstraints: spec.depConstraints ?? [],
      // A case writes its suppression paths relative to its own tree, like
      // every other path it declares; the case-id prefix is added here, once,
      // the same way project roots and entry points get it above.
      suppressions: (spec.suppressions ?? []).map((entry) => ({
        ...entry,
        path: `${spec.id}/${entry.path}`,
      })),
      options: { ...optionDefaults, ...(spec.options ?? {}) },
      projects: spec.projects.map((project) => ({
        name: project.name,
        root: `${spec.id}/${project.root}`,
      })),
      workspaceLayout: spec.workspaceLayout,
    });
  }
  return materialized;
}

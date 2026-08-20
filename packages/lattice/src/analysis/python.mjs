/**
 * Python resolver — reads pyproject.toml with a real TOML parser (smol-toml),
 * no `uv` binary required.
 *
 * Model: one package per Nx project (`<projectRoot>/pyproject.toml`,
 * `[project].name`), and an edge exists only where the manifest EXPLICITLY
 * wires a dependency to a workspace path. A name that merely coincides with a
 * sibling package or a PyPI package never creates an edge — each tool's
 * documented semantics, not string matching. Three tools' declarations are
 * read, each against its current documentation (fetched 2026-08-11):
 *
 * - **uv** — a dependency string in `[project].dependencies`,
 *   `[project.optional-dependencies].*`, or `[dependency-groups].*` creates an
 *   edge only when `[tool.uv.sources]` routes that name to the workspace
 *   (`{ workspace = true }`) or to a path that is another project's directory.
 *   A source may also be uv's documented multiple-sources-by-marker form — an
 *   ARRAY of source tables, one selected per environment marker at install
 *   time — and each element is read the same way a lone table is; a static
 *   reader cannot evaluate the markers, so any entry that names a workspace
 *   project draws the edge. Quiet handling of a path source that resolves to
 *   no project is unchanged.
 * - **Poetry** — `name = { path = "…" }` in `[tool.poetry.dependencies]` or
 *   `[tool.poetry.group.<group>.dependencies]`
 *   (https://python-poetry.org/docs/dependency-specification/ §"Path
 *   dependencies", https://python-poetry.org/docs/managing-dependencies/
 *   §"Dependency groups"). An entry that is an array of tables — the
 *   documented multiple-constraints form — has each element read the same
 *   way. `develop` changes install mode, never whether the dependency exists,
 *   so it is ignored. The entry itself is the declaration in both of Poetry's
 *   modes: in the legacy layout `[tool.poetry.dependencies]` IS the dependency
 *   list, and in PEP 621 layout the docs state it "is only used to enrich
 *   `project.dependencies` for locking" — either way a `path` there is an
 *   explicit local wiring. The `[tool.poetry.dev-dependencies]` table of old
 *   Poetry versions is deliberately NOT read: it appears nowhere in the
 *   current documentation, and reading undocumented shapes is how a resolver
 *   drifts from the tool it mirrors.
 * - **PDM** — a requirement string in the same three dependency arrays, in the
 *   two root-anchored local-URL forms its docs write
 *   (https://pdm-project.org/latest/usage/dependency/ §"Local dependencies",
 *   https://pdm-project.org/latest/reference/pep621/ §"Relative paths"):
 *   `name @ file:///${PROJECT_ROOT}/<path>` (pdm-backend) and
 *   `name @ {root:uri}/<path>` (hatchling), plus the editable
 *   `-e file:///${PROJECT_ROOT}/<path>` entry form the monorepo guide puts in
 *   `[dependency-groups]` (https://pdm-project.org/latest/usage/advanced/).
 *   `${PROJECT_ROOT}` "will be expanded based on the project root" per those
 *   docs, i.e. against the manifest's own directory — the same base every
 *   relative `path` above resolves against. A `[tool.pdm.dev-dependencies]`
 *   table is deliberately NOT read for the same reason as Poetry's legacy
 *   table: current PDM docs route development groups through
 *   `[dependency-groups]`, which is already scanned.
 *
 * ## Where a declared path may land, and what each landing produces
 *
 * Relative paths resolve against the declaring manifest's directory. The
 * verdicts, in the order they are tested:
 *
 * - **Another Nx project's root** — an edge. Exactly the root: the
 *   one-manifest-per-project-root model (`packages/lattice/CLAUDE.md`)
 *   is what makes a directory-to-project attribution well defined at all.
 * - **The declaring project itself** (its root, or anything under it, such as
 *   a vendored wheel `file:///${PROJECT_ROOT}/vendor/x.whl`) — no edge. No
 *   cross-project wiring exists to lose.
 * - **Outside the workspace** (the path climbs above the root) — no edge, and
 *   that is a verdict rather than a shrug: whatever sits there is not a
 *   workspace project, so no project↔project edge can exist. Same answer an
 *   external PyPI package gets.
 * - **Anywhere else in the tree** — a directory that is no project's root, a
 *   file inside another project, a path that resolves to nothing — **throws**,
 *   failing graph computation with an error naming the manifest, the entry,
 *   and where the path landed. The graph hook has exactly two outputs, edges
 *   and a throw; a skipped entry here is an edge `nx affected` silently never
 *   sees on a wiring the manifest plainly states, and a stderr line during
 *   graph computation is scrollback, not a report. Throwing is the same door
 *   `../options.mjs` uses for an unknown key, and it is self-correcting in
 *   the way silence is not: the error says to point the path at the owning
 *   project's root, split the nested package into its own project, or fix the
 *   typo. A PDM local URL that is NOT root-anchored (an absolute `file:///…`,
 *   which the PDM docs note other build backends write) throws for the same
 *   reason from one step earlier: without the anchor this resolver cannot
 *   even say whether the target is in the tree.
 * - **A `pyproject.toml` that is not valid TOML** draws no edges and does NOT
 *   throw — deliberately asymmetric with the dangling path. Nx recomputes the
 *   graph on every invocation, so a manifest is malformed mid-keystroke in
 *   every editing session (`manifest-util.test.mjs` pins that survival), while
 *   a dangling path is a stable, readable claim. The loud report for a
 *   malformed manifest is the analysis layer's: `pythonPackageLayout` returns
 *   it as unmodelled, and imports then fail rather than resolve.
 *
 * ## Two resolutions, kept side by side, because they answer different things
 *
 * `resolvePythonDependencies` above is **manifest-level**: it reports what a
 * project DECLARED, which is what an Nx edge should carry. `analyzePython`
 * below is **source-level**: it reports what a file actually IMPORTS.
 *
 * They are not the same question, and the gap between them is a real false
 * negative rather than a theoretical one. A `.py` file that writes
 * `import other_project.thing` without any `[tool.uv.sources]` entry imports
 * perfectly at runtime — in a uv workspace both packages are installed and
 * both are on `sys.path` — while the manifest says nothing at all. The
 * manifest-level view sees no dependency; the boundary was still crossed.
 *
 * Neither replaces the other. A declared-but-unused dependency and an
 * undeclared-but-imported one are both findings, and the two views disagreeing
 * is itself the information.
 *
 * ## Import roots come from the filesystem, because that is what Python reads
 *
 * Python has no `ts.resolveModuleName` to delegate to, and it does not need
 * one: an import name is a directory or file name on `sys.path`. So the layout
 * itself is read:
 *
 * ```
 * src/<pkg>/__init__.py   -> import name <pkg>   (src layout)
 * <pkg>/__init__.py       -> import name <pkg>   (flat layout)
 * <mod>.py                -> import name <mod>   (single module)
 * ```
 *
 * Both bases — `<projectRoot>/src` and `<projectRoot>` — are read for every
 * project, in that order, because a src-layout project routinely still has a
 * root-level `conftest.py` that pytest makes importable as `conftest`. A file
 * is attributed to the first base that contains it, so a src-layout package is
 * never also indexed as `src.<pkg>`.
 *
 * ## Those two bases are not the whole layout, and assuming they were asserted a lie
 *
 * A package may sit anywhere its build backend says it does —
 * `[tool.setuptools] package-dir = {"" = "lib"}` and
 * `[tool.hatch.build.targets.wheel] packages = ["python/pkg"]` are both real,
 * both import fine at runtime, and neither puts a directory where the scan
 * above looks. Reading only the two default bases did not make that a blind
 * spot the tool reported; it made the import resolve to nothing, which the
 * branch below turned into `external: true` — a positive assertion that a
 * first-party project is a PyPI distribution. Every tag constraint then
 * evaporates, because `../rules/` returns from its `type === "npm"` branch
 * before the constraint block. The contract's "never guesses a target from a
 * name that looks similar" was being honoured in one direction and inverted in
 * the other: this guessed that NO project owns the name.
 *
 * So the declarations are read, with `smol-toml` — already a dependency, and
 * already parsing these same manifests one function up. Four shapes, because
 * each is a table lookup rather than a build backend reimplemented:
 *
 * ```
 * [tool.setuptools] package-dir = { "" = "lib" }        -> lib
 * [tool.setuptools.packages.find] where = ["lib"]       -> lib
 * [tool.hatch.build.targets.wheel] packages = ["py/x"]  -> py      (wheel path is `x`)
 * [tool.poetry] packages = [{ include = "x", from = "lib" }] -> lib
 * ```
 *
 * They are read whichever backend `[build-system]` names, because the table's
 * presence is the declaration; a manifest carries at most one of them.
 *
 * **Everything else is a FAILURE, never an `external: true`.** A `package-dir`
 * key other than `""` (which renames a package rather than naming a root), a
 * hatch `sources` rewrite, a poetry `to`, a `pyproject.toml` that is not valid
 * TOML, and a `[build-system] build-backend` this file does not read all mean
 * the same thing: some directory of this workspace may be importable under a
 * name nothing here knows. An import that then resolves to no project is
 * recorded with `resolved: null` and a failure saying which project's manifest
 * put the answer out of reach. That is louder than the silence it replaces and
 * strictly weaker than the falsehood it replaces.
 *
 * **PEP 420 namespace packages are the one case the filesystem cannot settle,
 * and here is what this does about it.** A directory with no `__init__.py` is
 * still importable, and worse, two projects may each contribute a different
 * subpackage to the SAME top-level namespace — which is the point of the
 * feature. A top-level name alone therefore cannot say which project an import
 * reached. So the index is not a list of top-level roots but a map of every
 * importable dotted path, and resolution matches the LONGEST dotted prefix:
 * `import ns.alpha.thing` resolves through `ns.alpha` to the project that owns
 * it, never through the shared `ns`. When the longest matching prefix is
 * genuinely owned by more than one project, that is reported as an ambiguity
 * with `resolved: null` — Python itself resolves it by `sys.path` order, which
 * no static reader can know, and guessing is what the contract forbids.
 *
 * Known parse limits, deliberate and pinned by tests. As with the Go and Rust
 * headers, the worst case of each is a spurious record naming text the file
 * really contains — never a missed project:
 *
 * - **Imports are matched per line**, with any indentation allowed. That is
 *   deliberate, not sloppy: it is what catches a function-local import and an
 *   import under `if TYPE_CHECKING:`, both of which cross a boundary. Python's
 *   own statement separators are followed rather than dropped at: a `;` opens
 *   a fresh statement to check on the same line, and a line ending in a bare
 *   `\` is joined with the next one first, the same explicit line-joining
 *   Python itself does — but only starting from a line that already opens
 *   with `from`/`import`, so an unrelated line elsewhere that happens to end
 *   in `\` (a comment noting a Windows path, say) never pulls a statement it
 *   has nothing to do with into this one. A statement that pulled continuation
 *   lines in this way and still could not be read as `from`/`import` is a
 *   failure naming the file rather than a silently dropped record — the same
 *   choice a brace-group `use` gets in the Rust analyzer below.
 * - **A parenthesised name list** — `import (a, b)` or `from x import (a, b)`,
 *   Black and isort's normalised multi-import spelling — is read the same way
 *   as the single-line comma list: the surrounding parens and any interior
 *   line breaks are stripped, and each name is a record. A paren group whose
 *   contents cannot be read as names is a failure, never a silently empty
 *   group (`parsePythonImportSites` pins both).
 * - **A triple-quoted string containing a line that looks like an import** is
 *   read as one. `#` comments are not, since the `#` precedes the keyword.
 * - **`if TYPE_CHECKING:` imports stay `kind: "static"`.** They are erased at
 *   runtime, so `type-only` is tempting, but a TYPE_CHECKING guard is a
 *   runtime conditional rather than a declaration that the dependency is
 *   absent — the module is still named, and the boundary is still crossed.
 *   Marking them `type-only` would let a rule that exempts erased imports
 *   exempt them, which is the bypass this tool exists to close.
 * - **`packageName` for an external import is the top-level import name**, not
 *   the PyPI distribution name. The two differ (`import PIL` ships as
 *   `pillow`) and only the import name is knowable from a source file.
 */
import { normalizePath, parseManifest, resolveWithinWorkspace } from "./manifest-util.mjs";
import {
  emptyResult,
  fileFailure,
  perWorkspace,
  positionAt,
  projectOwning,
} from "./source-util.mjs";

/** PEP 503 name normalization: case-insensitive, runs of `-_.` collapse to `-`. */
export function normalizePackageName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** The package name a PEP 508 requirement string refers to, or null. */
export function parseRequirementName(requirement) {
  const match = requirement.trim().match(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/);
  return match ? normalizePackageName(match[0]) : null;
}

/** Every dependency name a pyproject manifest declares, deduped. */
export function collectDeclaredDependencies(manifest) {
  const names = new Set();
  const groups = [
    manifest.project?.dependencies ?? [],
    ...Object.values(manifest.project?.["optional-dependencies"] ?? {}),
    ...Object.values(manifest["dependency-groups"] ?? {}),
  ];
  for (const group of groups) {
    for (const entry of group) {
      if (typeof entry !== "string") continue; // {include-group = …} tables
      const name = parseRequirementName(entry);
      if (name) names.add(name);
    }
  }
  return [...names];
}

/**
 * Poetry's documented path dependencies: `name = { path = "…" }` entries in
 * `[tool.poetry.dependencies]` and `[tool.poetry.group.<group>.dependencies]`,
 * including each element of a multiple-constraints array. See the header for
 * the doc pages and for the two tables deliberately not read.
 *
 * @param {object} manifest A parsed pyproject.toml.
 * @returns {{ name: string, path: string, unanchored?: undefined, declaredIn: string }[]}
 */
function poetryPathDependencies(manifest) {
  const tables = [];
  const main = manifest.tool?.poetry?.dependencies;
  if (main !== undefined) tables.push(["[tool.poetry.dependencies]", main]);
  const groups = manifest.tool?.poetry?.group;
  if (typeof groups === "object" && groups !== null && !Array.isArray(groups)) {
    for (const [groupName, group] of Object.entries(groups)) {
      const deps = group?.dependencies;
      if (deps !== undefined) {
        tables.push([`[tool.poetry.group.${groupName}.dependencies]`, deps]);
      }
    }
  }

  const entries = [];
  for (const [declaredIn, table] of tables) {
    if (typeof table !== "object" || table === null || Array.isArray(table)) continue;
    for (const [name, spec] of Object.entries(table)) {
      for (const constraint of Array.isArray(spec) ? spec : [spec]) {
        if (typeof constraint !== "object" || constraint === null) continue;
        if (typeof constraint.path !== "string") continue;
        entries.push({ name, path: constraint.path, declaredIn });
      }
    }
  }
  return entries;
}

/**
 * The two root-anchored spellings PDM's docs write a local dependency in.
 * `${PROJECT_ROOT}` is not expanded by TOML — it reaches this reader verbatim.
 */
const PDM_LOCAL_ANCHORS = ["file:///${PROJECT_ROOT}/", "{root:uri}/"];

/**
 * PDM's documented local-path requirements across the three dependency
 * arrays: `name @ <anchored-url>` and the editable `-e <anchored-url>` form.
 *
 * A `file:` URL WITHOUT one of the two anchors is returned with
 * `unanchored` set instead of a path — the docs note that backends other
 * than pdm-backend/hatchling "will write the absolute path instead", and an
 * absolute path gives this reader no way to place the target relative to the
 * tree, so the caller reports it rather than guessing. Any other URL (https,
 * git+…) and any plain name requirement is not a local path and yields
 * nothing here.
 *
 * @param {object} manifest A parsed pyproject.toml.
 * @returns {{ name: string|null, path?: string, unanchored?: string, declaredIn: string }[]}
 */
function pdmLocalDependencies(manifest) {
  const arrays = [
    ["[project] dependencies", manifest.project?.dependencies],
    ...Object.entries(manifest.project?.["optional-dependencies"] ?? {}).map(([extra, list]) => [
      `[project.optional-dependencies] ${extra}`,
      list,
    ]),
    ...Object.entries(manifest["dependency-groups"] ?? {}).map(([group, list]) => [
      `[dependency-groups] ${group}`,
      list,
    ]),
  ];

  const entries = [];
  for (const [declaredIn, list] of arrays) {
    if (!Array.isArray(list)) continue;
    for (const requirement of list) {
      if (typeof requirement !== "string") continue; // {include-group = …} tables
      const trimmed = requirement.trim();
      let name = null;
      let url;
      if (/^-e\s/.test(trimmed)) {
        url = trimmed.slice(2).trim();
      } else {
        // PEP 508 direct reference: `name[extras] @ URI ; markers`. The name
        // cannot contain `@`, so the first one is the separator; the URI runs
        // to the first whitespace, which is also where a marker would start.
        const at = trimmed.indexOf("@");
        if (at === -1) continue;
        name = parseRequirementName(trimmed.slice(0, at));
        url = trimmed.slice(at + 1).trim();
      }
      url = url.split(/\s/, 1)[0];
      const anchor = PDM_LOCAL_ANCHORS.find((prefix) => url.startsWith(prefix));
      if (anchor) {
        entries.push({ name, path: url.slice(anchor.length), declaredIn });
      } else if (url.startsWith("file:")) {
        entries.push({ name, unanchored: url, declaredIn });
      }
    }
  }
  return entries;
}

/**
 * Static edges between Python projects. Same contract as the other
 * resolvers: `projects` [{ name, root }], `filesOf(name)`, `readFile(path)`.
 *
 * @throws {Error} when a well-formed manifest declares a Poetry/PDM path
 *   dependency this resolver cannot attribute to a project — the header's
 *   "Where a declared path may land" section is the argument.
 */
export function resolvePythonDependencies(projects, filesOf, readFile) {
  const projectByPackage = new Map(); // normalized package name -> project name
  const packageProjectByRoot = new Map(); // uv path sources resolve against Python packages only
  const projectByRoot = new Map(); // every Nx project root, for declared path dependencies
  const packages = []; // manifests with a [project].name — the uv flow's scan set
  const manifests = []; // every parseable manifest — the Poetry/PDM flow's scan set
  const normalizedProjects = projects.map((project) => ({
    name: project.name,
    root: normalizePath(project.root, ""),
  }));
  for (const project of normalizedProjects) {
    projectByRoot.set(project.root, project.name);
  }
  for (const project of projects) {
    const manifestPath = normalizePath(project.root, "pyproject.toml");
    if (!filesOf(project.name).includes(manifestPath)) continue;
    const manifest = parseManifest(readFile(manifestPath) ?? "");
    if (manifest === null) continue; // malformed mid-keystroke must not fail the graph — see header
    manifests.push({ project, manifest, manifestPath });
    const packageName = manifest.project?.name;
    if (!packageName) continue; // a uv workspace root without [project] is not a package
    projectByPackage.set(normalizePackageName(packageName), project.name);
    // Keyed normalized: the only lookup (below) normalizes its side too, and
    // `normalizePath` collapses the Nx root spelling `"."` to `""` — keying
    // this map by the raw `project.root` left the root project's key (`"."`)
    // and a `path` source's lookup (`""`) unable to ever meet, so a uv `path`
    // source that named the workspace root drew no edge.
    packageProjectByRoot.set(normalizePath(project.root, ""), project.name);
    packages.push({ project, manifest, manifestPath });
  }

  const dependencies = [];
  for (const { project, manifest, manifestPath } of packages) {
    const sources = manifest.tool?.uv?.sources ?? {};
    const sourceOf = new Map(
      Object.entries(sources).map(([name, spec]) => [normalizePackageName(name), spec]),
    );
    for (const depName of collectDeclaredDependencies(manifest)) {
      const spec = sourceOf.get(depName);
      if (typeof spec !== "object" || spec === null) continue;
      // uv's documented multiple-sources-by-marker form is an ARRAY of source
      // tables rather than one: `beta = [{ workspace = true, marker = "…" },
      // { path = "…", marker = "…" }]`. Each entry is read the same way a lone
      // table is; the first entry that names a workspace project wins.
      let target = null;
      for (const entry of Array.isArray(spec) ? spec : [spec]) {
        if (typeof entry !== "object" || entry === null) continue;
        if (entry.workspace === true) {
          target = projectByPackage.get(depName) ?? null;
        } else if (typeof entry.path === "string") {
          target = packageProjectByRoot.get(normalizePath(project.root, entry.path)) ?? null;
        }
        if (target) break;
      }
      if (target && target !== project.name) {
        dependencies.push({
          source: project.name,
          target,
          sourceFile: manifestPath,
          type: "static",
        });
      }
    }
  }

  for (const { project, manifest, manifestPath } of manifests) {
    const declared = [...poetryPathDependencies(manifest), ...pdmLocalDependencies(manifest)];
    for (const entry of declared) {
      const label = entry.name === null ? "an editable entry" : `'${entry.name}'`;
      if (entry.unanchored !== undefined) {
        throw new Error(
          `lattice: ${manifestPath} declares ${label} in ${entry.declaredIn} with the ` +
            `local URL '${entry.unanchored}', which is not anchored to the manifest's directory. ` +
            `Only the documented root-anchored forms — 'file:///\${PROJECT_ROOT}/…' (pdm-backend) ` +
            `and '{root:uri}/…' (hatchling) — can be placed relative to the workspace, so this ` +
            `resolver cannot tell whether the target is a workspace project, and a dropped entry ` +
            `would be an edge \`nx affected\` silently never sees.`,
        );
      }
      const resolved = resolveWithinWorkspace(project.root, entry.path);
      if (resolved === null) continue; // left the workspace: not a workspace project, so no edge exists
      const target = projectByRoot.get(resolved);
      if (target === project.name) continue; // self-reference wires nothing new
      if (target !== undefined) {
        dependencies.push({
          source: project.name,
          target,
          sourceFile: manifestPath,
          type: "static",
        });
        continue;
      }
      const owner = projectOwning(normalizedProjects, resolved);
      if (owner?.name === project.name) continue; // inside its own tree: a vendored artifact, not a wiring
      const landed =
        owner === null
          ? `'${resolved}' — not in any Nx project's tree`
          : `'${resolved}', inside project '${owner.name}' but not at its root`;
      throw new Error(
        `lattice: ${manifestPath} declares ${label} in ${entry.declaredIn} as a path ` +
          `dependency on '${entry.path}', which resolves to ${landed}. An explicit workspace ` +
          `path this resolver cannot attribute to a project's root means the graph would be ` +
          `missing an edge \`nx affected\` needs, so none is handed over: point the path at the ` +
          `root of the project that owns that location, split a nested package into its own ` +
          `project, or fix the path.`,
      );
    }
  }

  // One edge per (source, target): the same sibling declared in several
  // groups, or by uv and Poetry at once, is still one dependency.
  const seen = new Set();
  return dependencies.filter((dependency) => {
    const key = `${dependency.source} ${dependency.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Is this specifier one of Python's relative forms — the `spelling.relative`
 * bit of the analysis record (`contract.md`)?
 *
 * `from . import x`, `from .mod import y`, `from ..pkg.sub import z`: a leading
 * dot count, resolved against the importing file's own package and unable to
 * name anything outside it (`resolveRelativeModule` reports the climb that
 * tries). These are Python's `./x` and `../x`, and the rule engine's old
 * JavaScript-shaped predicate saw only the two spellings that happen to
 * coincide — a bare `.` and `..` — while `.mod` and `..pkg` read as package
 * names to it.
 *
 * They are not filesystem paths, which is the other half: a dotted module name
 * is resolved on `sys.path`, never by path arithmetic against the source file,
 * so `spelling.path` is always false for Python. That distinction is what stops
 * an unresolvable `from . import x` from being reported as
 * `noRelativeOrAbsoluteExternals` — a message about a path, aimed at a name.
 *
 * @param {string} specifier As written.
 * @returns {boolean}
 */
const isRelativeImport = (specifier) => specifier.startsWith(".");

/** A name Python can spell in an import statement. */
const isImportableName = (name) => /^[A-Za-z_]\w*$/.test(name);

/** The directory `path` sits in, or `""` when it sits at the top. */
const parentDirectory = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * `[tool.setuptools]`: `package-dir` names an import root only under the `""`
 * key. Any other key maps ONE package name to a directory, which is a rename —
 * `{"pkg" = "lib/other"}` makes `lib/other` importable as `pkg`, and no base
 * this scan could add would produce that name.
 */
function setuptoolsDirectories(manifest) {
  const directories = [];
  const unmodelled = [];
  const setuptools = manifest.tool?.setuptools ?? {};

  const packageDir = setuptools["package-dir"];
  if (packageDir !== undefined) {
    if (typeof packageDir !== "object" || packageDir === null || Array.isArray(packageDir)) {
      unmodelled.push("its `[tool.setuptools] package-dir` is not a table");
    } else {
      for (const [name, directory] of Object.entries(packageDir)) {
        if (name === "" && typeof directory === "string") directories.push(directory);
        else unmodelled.push(`its \`[tool.setuptools] package-dir\` renames the package '${name}'`);
      }
    }
  }

  // `[tool.setuptools.packages.find] where` — a list of directories to search.
  // `packages` may instead be a plain array of import names, in which case
  // there is no `.find` table and the names live at the default bases.
  const where = setuptools.packages?.find?.where;
  if (where !== undefined) {
    if (Array.isArray(where) && where.every((entry) => typeof entry === "string")) {
      directories.push(...where);
    } else {
      unmodelled.push("its `[tool.setuptools.packages.find] where` is not a list of directories");
    }
  }
  return { directories, unmodelled };
}

/**
 * `[tool.hatch.build]` and its wheel target: `packages = ["python/pkg"]` ships
 * `python/pkg` into the wheel as `pkg`, so the import base is the entry's
 * PARENT. `sources` rewrites those paths arbitrarily and is not followed.
 */
function hatchDirectories(manifest) {
  const directories = [];
  const unmodelled = [];
  const build = manifest.tool?.hatch?.build ?? {};
  const tables = [
    ["[tool.hatch.build]", build],
    ["[tool.hatch.build.targets.wheel]", build.targets?.wheel ?? {}],
  ];
  for (const [label, table] of tables) {
    if (table.sources !== undefined) {
      unmodelled.push(`its \`${label} sources\` rewrites the path each package is imported under`);
    }
    if (table.packages === undefined) continue;
    if (!Array.isArray(table.packages) || table.packages.some((e) => typeof e !== "string")) {
      unmodelled.push(`its \`${label} packages\` is not a list of paths`);
      continue;
    }
    directories.push(...table.packages.map(parentDirectory));
  }
  return { directories, unmodelled };
}

/**
 * `[tool.poetry] packages`: each entry's `from` is the import base, defaulting
 * to the project root. `to` renames the package inside the wheel and is not
 * followed.
 */
function poetryDirectories(manifest) {
  const directories = [];
  const unmodelled = [];
  const packages = manifest.tool?.poetry?.packages;
  if (packages === undefined) return { directories, unmodelled };
  if (!Array.isArray(packages)) {
    unmodelled.push("its `[tool.poetry] packages` is not a list");
    return { directories, unmodelled };
  }
  for (const entry of packages) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      unmodelled.push("its `[tool.poetry] packages` holds an entry that is not a table");
    } else if (entry.to !== undefined) {
      unmodelled.push("its `[tool.poetry] packages` renames a package with `to`");
    } else {
      directories.push(typeof entry.from === "string" ? entry.from : "");
    }
  }
  return { directories, unmodelled };
}

/**
 * The `[build-system] build-backend` values whose package-location keys the
 * three readers above cover. A backend outside this list declares its packages
 * in keys nothing here reads — maturin's `[tool.maturin] python-source` and
 * scikit-build's `[tool.scikit-build] wheel.packages` are two — so its layout
 * is unknown rather than default. An ABSENT `build-backend` is setuptools by
 * PEP 517's fallback, which is read.
 */
const READ_BUILD_BACKENDS = new Set([
  "setuptools.build_meta",
  "setuptools.build_meta:__legacy__",
  "hatchling.build",
  "poetry.core.masonry.api",
  "poetry.masonry.api",
]);

/**
 * Where a project's `pyproject.toml` says its packages live, relative to the
 * project root — and everything it declares that this reader cannot follow.
 *
 * @param {string|null} manifestText Contents, or null when the project has no
 *   `pyproject.toml` at all — then it declares nothing and the filesystem scan
 *   is the whole answer, which is not a gap.
 * @returns {{ directories: string[], unmodelled: string[] }}
 */
export function pythonPackageLayout(manifestText) {
  if (manifestText === null) return { directories: [], unmodelled: [] };
  const manifest = parseManifest(manifestText);
  if (manifest === null) {
    return {
      directories: [],
      unmodelled: ["its `pyproject.toml` is not valid TOML, so nothing it declares can be read"],
    };
  }

  const directories = [];
  const unmodelled = [];
  // Read by table presence rather than by the declared backend: a manifest
  // carries at most one of these, and a `[tool.hatch…]` table means hatch
  // whether or not `[build-system]` bothered to say so.
  for (const read of [setuptoolsDirectories, hatchDirectories, poetryDirectories]) {
    const found = read(manifest);
    directories.push(...found.directories);
    unmodelled.push(...found.unmodelled);
  }

  const backend = manifest["build-system"]?.["build-backend"];
  if (backend !== undefined && !READ_BUILD_BACKENDS.has(backend)) {
    unmodelled.push(
      `it builds with '${backend}', whose package-location keys this reader does not read`,
    );
  }
  return { directories, unmodelled };
}

/**
 * The directories a project puts on `sys.path`: whatever its manifest declared,
 * then the two the filesystem answers with.
 *
 * The project root is always LAST. A declared subdirectory that also matched
 * the root first would index `lib/pkg/mod.py` as `lib.pkg.mod` — a dotted name
 * nothing imports — and the package would stay invisible for a second reason.
 */
const importBasesOf = (projectRoot, directories = []) => {
  const root = normalizePath(projectRoot, "");
  const declared = directories
    .map((directory) => normalizePath(projectRoot, directory))
    .filter((base) => base !== root);
  return [...new Set([...declared, normalizePath(projectRoot, "src"), root])];
};

/** `file` relative to `base`, or null when it is not under it. */
function relativeTo(base, file) {
  if (base === "") return file;
  return file.startsWith(`${base}/`) ? file.slice(base.length + 1) : null;
}

/** A `.py` file's path components below its import base, or null. */
function componentsOf(file, projectRoot, directories) {
  for (const base of importBasesOf(projectRoot, directories)) {
    const relative = relativeTo(base, file);
    if (relative === null) continue;
    return relative.slice(0, -".py".length).split("/");
  }
  return null;
}

/** The dotted path a `.py` file is importable as, relative to its base. */
function dottedNameOf(file, projectRoot, directories) {
  const parts = componentsOf(file, projectRoot, directories);
  if (parts === null) return null;
  if (parts[parts.length - 1] === "__init__") parts.pop();
  return parts.every(isImportableName) ? parts : null;
}

/**
 * The package a `.py` file lives IN, which is what a relative import is
 * resolved against. This is not the file's own dotted name: `pkg/__init__.py`
 * IS the package `pkg`, so `from . import x` inside it means `pkg`, while
 * `pkg/mod.py` sits in `pkg` and means the same thing from a different name.
 * Dropping the last path component answers both, which dropping `__init__`
 * first would not.
 */
function ownPackageOf(file, projectRoot, directories) {
  const parts = componentsOf(file, projectRoot, directories);
  if (parts === null) return null;
  parts.pop();
  return parts.every(isImportableName) ? parts : null;
}

/**
 * Every dotted name a project's tracked `.py` files make importable.
 *
 * Regular packages and modules map to the file that defines them. Every
 * directory prefix along the way is also recorded, with a null file, because
 * PEP 420 makes a directory importable whether or not it carries an
 * `__init__.py` — a prefix that DOES have one overwrites the null entry, so
 * the result does not depend on the order files arrive in.
 *
 * @param {string} projectRoot Workspace-relative.
 * @param {string[]} files The project's tracked files, workspace-relative.
 * @param {string[]} [directories] Extra import bases the manifest declared,
 *   relative to the project root; `pythonPackageLayout` reads them.
 * @returns {Map<string, { file: string|null, namespace: boolean }>}
 */
export function pythonModuleIndex(projectRoot, files, directories = []) {
  const index = new Map();
  for (const file of files) {
    if (!file.endsWith(".py")) continue;
    const parts = dottedNameOf(file, projectRoot, directories);
    if (parts === null || parts.length === 0) continue;
    index.set(parts.join("."), { file, namespace: false });
    for (let depth = 1; depth < parts.length; depth++) {
      const prefix = parts.slice(0, depth).join(".");
      if (!index.has(prefix)) index.set(prefix, { file: null, namespace: true });
    }
  }
  return index;
}

/**
 * A project's top-level import names — the `src/<pkg>` · `<pkg>` · `<mod>.py`
 * model stated in the header, derived from the same scan rather than from a
 * second one, so the two can never disagree.
 *
 * @param {string} projectRoot
 * @param {string[]} files
 * @param {string[]} [directories] As `pythonModuleIndex`.
 * @returns {string[]}
 */
export function pythonImportRoots(projectRoot, files, directories = []) {
  return [...pythonModuleIndex(projectRoot, files, directories).keys()]
    .filter((name) => !name.includes("."))
    .sort();
}

/**
 * Every Python project's module index, the global dotted-name map, and the
 * projects whose declared layout this reader could not follow.
 *
 * `unmodelled` is workspace-scoped on purpose. A package this reader cannot
 * locate could carry ANY top-level import name, so it is not the importing
 * project that is compromised but every name that resolves to nothing —
 * whichever file wrote it.
 *
 * @returns {{ byModule: Map<string, { project: string, file: string|null }[]>,
 *   directoriesOf: Map<string, string[]>,
 *   unmodelled: { project: string, root: string, reason: string }[] }}
 */
const pythonModulesOf = perWorkspace((workspace) => {
  const byModule = new Map(); // dotted name -> [{ project, file }]
  const directoriesOf = new Map(); // project name -> declared import bases
  const unmodelled = [];
  for (const project of workspace.projects) {
    const files = workspace.filesOf(project.name);
    if (!files.some((file) => file.endsWith(".py"))) continue;
    const manifestPath = normalizePath(project.root, "pyproject.toml");
    const layout = pythonPackageLayout(
      files.includes(manifestPath) ? (workspace.readFile(manifestPath) ?? null) : null,
    );
    directoriesOf.set(project.name, layout.directories);
    for (const reason of layout.unmodelled) {
      unmodelled.push({ project: project.name, root: project.root, reason });
    }
    for (const [dotted, entry] of pythonModuleIndex(project.root, files, layout.directories)) {
      const owners = byModule.get(dotted) ?? [];
      owners.push({ project: project.name, file: entry.file });
      byModule.set(dotted, owners);
    }
  }
  return { byModule, directoriesOf, unmodelled };
});

/**
 * Every Python project whose declared package layout this reader could not
 * follow, as whole-file failures attributed to its `pyproject.toml` —
 * workspace-scoped on purpose, and surfaced separately from per-import
 * resolution: a malformed manifest is a hole in every run, not only in the
 * files that happen to hit a name that reaches no project. The CLI funnels
 * these alongside the analyzers' own failures, so `check` reports the run
 * incomplete (exit 3) rather than clean while a project's manifest says
 * nothing this tool can read.
 *
 * @param {object} workspace
 * @returns {object[]} `fileFailure` shapes (`../analysis/source-util.mjs`).
 */
export const pythonUnmodelledFailures = (workspace) =>
  pythonModulesOf(workspace).unmodelled.map(({ root, reason }) =>
    fileFailure(
      normalizePath(root, "pyproject.toml"),
      `its pyproject.toml cannot be fully read: ${reason}`,
    ),
  );

/**
 * The project a dotted module name reaches, by longest matching prefix.
 *
 * @returns {{ owner: { project: string, file: string|null }, ambiguous?: undefined,
 *   prefix?: undefined }|{ ambiguous: string[], prefix: string, owner?: undefined }|null}
 *   `null` when no project claims any prefix — the module is external.
 */
function resolveModuleName(dotted, byModule) {
  const parts = dotted.split(".");
  for (let depth = parts.length; depth >= 1; depth--) {
    const prefix = parts.slice(0, depth).join(".");
    const owners = byModule.get(prefix);
    if (!owners) continue;
    const projects = [...new Set(owners.map((owner) => owner.project))];
    if (projects.length > 1) return { ambiguous: projects, prefix };
    return { owner: owners[0] };
  }
  return null;
}

/**
 * The absolute module a relative specifier names, or `null` when it climbs
 * past the top-level package — which Python rejects too, and which is how an
 * import escapes the project it was written in.
 *
 * @param {string} specifier As written: `.`, `..`, `.mod`, `..pkg.sub`.
 * @param {string[]} ownPackage The importing file's own package, dotted-split.
 */
function resolveRelativeModule(specifier, ownPackage) {
  const dots = /^\.+/.exec(specifier)[0].length;
  const climb = dots - 1;
  if (ownPackage.length - climb <= 0) return null;
  const rest = specifier.slice(dots);
  const parts = [
    ...ownPackage.slice(0, ownPackage.length - climb),
    ...(rest === "" ? [] : rest.split(".")),
  ];
  return parts.join(".");
}

const IMPORT_STATEMENT = /^[ \t]*import[ \t]+/;
// The space before `import` is mandatory after a module NAME — Python's
// tokenizer reads `.modimport` as one identifier and then has no `import`
// keyword left, a syntax error (verified: `python3 -c 'import ast;
// ast.parse("from .modimport x")'`) — but a bare run of dots needs none:
// `from .import x` and `from ..import y` are both valid (level=1/level=2,
// module=None), because a `.` is never part of an identifier and so already
// ends the token the same way whitespace would. The `(?<=\.)` alternative
// captures exactly that one case; a module-name arm can still satisfy it only
// by ending right after a dot, which is the same rule stated the other way.
const FROM_STATEMENT =
  /^([ \t]*from[ \t]+)(\.+[A-Za-z_][\w.]*|\.+|[A-Za-z_][\w.]*)(?:[ \t]+|(?<=\.))import\b/;
const DOTTED_NAME = /^[ \t]*([A-Za-z_][\w.]*)/;

/**
 * `text` with a parenthesised name group's parentheses blanked to spaces —
 * `import (a, b)` → `import  a, b `, and `from x import (a, b)` →
 * `from x import  a, b ` — Black and isort's normalised multi-import
 * spelling. The parens are blanked rather than removed so the result is the
 * same length as the source and a position in it is the same position in the
 * file (the record is read as `file:line:column`). The interior is left where
 * it is: the existing comma-name loop reads each name exactly as it does in
 * the single-line form, and a non-name interior (a call, a slice) reads its
 * first identifier or fails the caller's prefilter — never a silent empty
 * from a statement that plainly says `import`.
 *
 * @param {string} text One statement (a `;`-split piece, possibly the joined
 *   continuation of several physical lines).
 * @returns {string}
 */
function blankParenGroup(text) {
  const open = text.indexOf("(");
  if (open === -1) return text;
  const close = text.lastIndexOf(")");
  if (close <= open) return text;
  // One space in, one space out for each paren, so both lengths and offsets
  // survive the call.
  return `${text.slice(0, open)} ${text.slice(open + 1, close)} ${text.slice(close + 1)}`;
}

/** A `(` in `text` that no `)` closes — the marker of a paren group in
 * progress. String contents are skipped, so a `(` inside a string never opens
 * one, and a `#` comment is inert, so a paren written in prose after `#` —
 * `from x import (a, b)  # (see` — never looks like a group still open. A
 * trailing `(` in a comment joining the next physical line is how a real
 * `import` on that line silently vanished.
 *
 * `text` may be several physical lines already concatenated with no
 * separator (`joinContinuedStatement` appends each one directly, so no `\n`
 * marks where one ends and the next begins) — `lineStarts` names those
 * boundaries, the offset each later physical line begins at. Without them a
 * `#` on an EARLIER line reads as running to the end of the whole joined
 * blob rather than just that line, which is what let a comment before an
 * interior line's own content swallow every `)` still to come and every
 * import after it. A comment always ends at the next such boundary — or, on
 * the last physical line seen so far, at the end of `text` itself, the same
 * as before.
 *
 * @param {string} text
 * @param {number[]} [lineStarts] Ascending offsets into `text` where a new
 *   physical line begins; empty when `text` is a single line.
 */
function hasUnclosedParen(text, lineStarts = []) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") {
      const next = lineStarts.find((start) => start > i);
      if (next === undefined) break; // last physical line: comment runs to the end
      i = next - 1; // the loop's own `i++` lands exactly on the next line's start
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}
/** A line, or a `;`-separated piece of one, worth trying the statement forms on. */
const FROM_OR_IMPORT_HEAD = /^[ \t]*(?:from|import)\b/;
/** `importlib.import_module(`, a bare `import_module(`, and `__import__(`. */
const DYNAMIC_CALL = /\b(?:importlib\s*\.\s*)?import_module\s*\(\s*|\b__import__\s*\(\s*/g;
const STRING_LITERAL = /^(['"])([^'"\\]*)\1/;

/**
 * Python's own statement separator: `line` split at each `;`, with each
 * piece's start offset within `line`.
 *
 * The split is not string-aware — a `;` inside a string literal splits too —
 * but the only cost is a spurious piece that fails the `from`/`import`
 * prefilter right after, the same "worst case is a spurious record, never a
 * missed one" trade the header already makes for the triple-quoted-string
 * limit below.
 *
 * @param {string} line
 * @returns {{ text: string, start: number }[]}
 */
function splitStatements(line) {
  const pieces = [];
  let start = 0;
  for (const text of line.split(";")) {
    pieces.push({ text, start });
    start += text.length + 1;
  }
  return pieces;
}

/**
 * Python's explicit line-joining, starting at physical line `index`: a line
 * ending in a bare `\` continues onto the next one with the backslash and the
 * newline both gone, exactly as Python's own tokenizer joins them, and a
 * `from`/`import` line whose paren group stays open continues too — the
 * `import (a,` + `b,)` spelling Black and isort normalise to. Called only for
 * a line that already opens with `from`/`import` — see the caller — so this
 * never reaches into a line that has nothing to do with the statement, a
 * comment ending in `\` while noting a Windows path, say.
 *
 * Each continuation swaps exactly one character (the trailing `\`) for one (a
 * joining space) and then appends the next physical line whole, so the joined
 * text's length up to any given physical line's contribution always equals
 * the sum of the real lines before it. That is what lets `toOffset` translate
 * a position in the joined text back into the ORIGINAL source by arithmetic
 * alone, the same length-preserving trick Go's comment mask uses for the same
 * reason: the record is read as `file:line:column`, and a position computed
 * from a shortened copy would name a byte the file does not have.
 *
 * @param {string[]} physicalLines
 * @param {number[]} lineOffsets Absolute start offset of each physical line.
 * @param {number} index
 * @returns {{ text: string, end: number, toOffset: (i: number) => number }}
 */
function joinContinuedStatement(physicalLines, lineOffsets, index) {
  const segments = [{ start: 0, offset: lineOffsets[index] }];
  let text = physicalLines[index];
  let end = index;
  while (
    end + 1 < physicalLines.length &&
    // `segments[0].start` is always 0 (the start of `text` itself, not a
    // later line's boundary) — only the ones appended since are boundaries a
    // `#` comment must stop at.
    (text.endsWith("\\") ||
      hasUnclosedParen(
        text,
        segments.slice(1).map((s) => s.start),
      ))
  ) {
    end++;
    text = text.endsWith("\\") ? `${text.slice(0, -1)} ` : text; // swap `\` for a space
    segments.push({ start: text.length, offset: lineOffsets[end] });
    text += physicalLines[end];
  }
  const toOffset = (i) => {
    let segment = segments[0];
    for (const candidate of segments) {
      if (candidate.start > i) break;
      segment = candidate;
    }
    return segment.offset + (i - segment.start);
  };
  return { text, end, toOffset };
}

/**
 * Every import site in a `.py` source, in source order and without
 * deduplication — one entry per written import.
 *
 * @param {string} pythonText
 * @returns {{ specifier: string, kind: string, offset: number, literal: boolean,
 *   continuation?: boolean }[]}
 */
export function parsePythonImportSites(pythonText) {
  const sites = [];
  const physicalLines = pythonText.split("\n");
  const lineOffsets = [];
  for (let offset = 0, i = 0; i < physicalLines.length; i++) {
    lineOffsets.push(offset);
    offset += physicalLines[i].length + 1;
  }

  let index = 0;
  while (index < physicalLines.length) {
    const line = physicalLines[index];
    const continues =
      FROM_OR_IMPORT_HEAD.test(line) && (line.endsWith("\\") || hasUnclosedParen(line));
    const { text, end, toOffset } = continues
      ? joinContinuedStatement(physicalLines, lineOffsets, index)
      : { text: line, end: index, toOffset: (i) => lineOffsets[index] + i };

    let matchedAny = false;
    for (const piece of splitStatements(text)) {
      // `import (a, b)` / `from x import (a, b)` — blank the parens before
      // the statement forms are tried, so the group reads exactly like the
      // single-line comma list. Blanking rather than deleting keeps every
      // position inside the original text (`piece.start` maps back through
      // `toOffset`, and a shorter copy would name a byte the file has not).
      const pieceText = blankParenGroup(piece.text);
      if (!FROM_OR_IMPORT_HEAD.test(pieceText)) continue;
      const from = FROM_STATEMENT.exec(pieceText);
      if (from) {
        matchedAny = true;
        sites.push({
          specifier: from[2],
          kind: "static",
          offset: toOffset(piece.start + from[1].length),
          literal: true,
        });
        continue;
      }
      const statement = IMPORT_STATEMENT.exec(pieceText);
      if (!statement) continue;
      matchedAny = true;
      // `import a.b as c, x.y` is several written imports on one line, and
      // each gets its own record with its own column.
      let cursor = statement[0].length;
      for (const namePiece of pieceText.slice(cursor).split(",")) {
        const name = DOTTED_NAME.exec(namePiece);
        if (name) {
          sites.push({
            specifier: name[1],
            kind: "static",
            offset: toOffset(piece.start + cursor + name[0].length - name[1].length),
            literal: true,
          });
        }
        cursor += namePiece.length + 1;
      }
    }
    if (end > index && !matchedAny) {
      // Pulled one or more continuation lines to complete what looked like a
      // `from`/`import` statement, and the joined result still does not parse
      // as one — reported rather than silently dropped, the same choice a
      // brace-group `use` gets in the Rust analyzer below.
      sites.push({
        specifier: text.trim(),
        kind: "static",
        offset: toOffset(0),
        literal: false,
        continuation: true,
      });
    }
    index = end + 1;
  }

  for (const call of pythonText.matchAll(DYNAMIC_CALL)) {
    const offset = call.index + call[0].length;
    const rest = pythonText.slice(offset);
    const literal = STRING_LITERAL.exec(rest);
    sites.push(
      literal
        ? { specifier: literal[2], kind: "dynamic", offset, literal: true }
        : { specifier: /^[^),\n]*/.exec(rest)[0].trim(), kind: "dynamic", offset, literal: false },
    );
  }

  return sites.sort((a, b) => a.offset - b.offset);
}

/**
 * Analyzes one `.py` file.
 *
 * @param {{ sourceFile: string, text: string, workspace: object }} request
 * @returns {{ imports: object[], failures: object[] }}
 */
export function analyzePython({ sourceFile, text, workspace }) {
  const result = emptyResult();
  try {
    const { byModule, directoriesOf, unmodelled } = pythonModulesOf(workspace);
    const owner = projectOwning(workspace.projects, sourceFile);
    const ownPackage = owner
      ? ownPackageOf(sourceFile, owner.root, directoriesOf.get(owner.name) ?? [])
      : null;

    for (const site of parsePythonImportSites(text)) {
      const { line, column } = positionAt(text, site.offset);
      const record = {
        sourceFile,
        line,
        column,
        specifier: site.specifier,
        kind: site.kind,
        spelling: { path: false, relative: isRelativeImport(site.specifier) },
        resolved: null,
      };
      result.imports.push(record);
      const fail = (reason) => result.failures.push({ sourceFile, line, column, reason });

      if (site.continuation) {
        fail(
          `'${site.specifier}' looks like a \`from\`/\`import\` statement continued across a ` +
            `backslash-joined line, but does not parse as one once its continuation lines are ` +
            `joined — this reader cannot say what it imports`,
        );
        continue;
      }
      if (!site.literal) {
        fail(
          `dynamic import of '${site.specifier}' has a non-literal argument, ` +
            `so its target is not knowable statically`,
        );
        continue;
      }

      let absolute = site.specifier;
      if (site.specifier.startsWith(".")) {
        if (ownPackage === null) {
          fail(
            `relative import '${site.specifier}' cannot be resolved: '${sourceFile}' is not on any import root`,
          );
          continue;
        }
        absolute = resolveRelativeModule(site.specifier, ownPackage);
        if (absolute === null) {
          fail(
            `relative import '${site.specifier}' climbs past the top-level package of '${sourceFile}', ` +
              `which leaves the project's import root — Python rejects it the same way`,
          );
          continue;
        }
      }

      const resolution = resolveModuleName(absolute, byModule);
      if (resolution === null) {
        // Reaching no project is only evidence of a PyPI package when every
        // project's packages are where this reader can see them. Otherwise the
        // honest answer is that the name is unplaceable — asserting `external`
        // here is what let a first-party import cross a tag boundary silently.
        if (unmodelled.length > 0) {
          fail(
            `'${site.specifier}' reaches no project, and this reader cannot conclude it is ` +
              `external — ${unmodelled
                .map(
                  (entry) =>
                    `project '${entry.project}' may place its packages where this reader ` +
                    `cannot look: ${entry.reason}`,
                )
                .join("; ")}. A first-party package put there would look exactly like this.`,
          );
          continue;
        }
        record.resolved = {
          target: null,
          file: null,
          external: true,
          packageName: absolute.split(".")[0],
        };
      } else if (resolution.ambiguous) {
        fail(
          `'${site.specifier}' resolves through the namespace package '${resolution.prefix}', which ` +
            `${resolution.ambiguous.join(" and ")} both contribute to — Python picks by sys.path order, ` +
            `which no static reader can know`,
        );
      } else {
        record.resolved = {
          target: resolution.owner.project,
          file: resolution.owner.file,
          external: false,
          packageName: null,
        };
      }
    }
  } catch (cause) {
    result.failures.push(
      fileFailure(sourceFile, `Python analysis failed: ${cause?.message ?? cause}`),
    );
  }
  return result;
}

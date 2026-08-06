/**
 * Python resolver — reads pyproject.toml with a real TOML parser (smol-toml),
 * no `uv` binary required.
 *
 * Model: one package per Nx project (`<projectRoot>/pyproject.toml`,
 * `[project].name`), wired together the uv way: a dependency string in
 * `[project].dependencies`, `[project.optional-dependencies].*`, or
 * `[dependency-groups].*` creates an edge only when `[tool.uv.sources]`
 * routes that name to the workspace (`{ workspace = true }`) or to a path
 * that is another project's directory. A name that merely coincides with a
 * PyPI package never creates an edge — uv semantics, not string matching.
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
 *   import under `if TYPE_CHECKING:`, both of which cross a boundary. A line
 *   continued with `\` or a second statement after `;` is not followed.
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
import { normalizePath, parseManifest } from "./manifest-util.mjs";
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
 * Static edges between Python projects. Same contract as the other
 * resolvers: `projects` [{ name, root }], `filesOf(name)`, `readFile(path)`.
 */
export function resolvePythonDependencies(projects, filesOf, readFile) {
  const projectByPackage = new Map(); // normalized package name -> project name
  const projectByRoot = new Map();
  const packages = [];
  for (const project of projects) {
    const manifestPath = `${project.root}/pyproject.toml`;
    if (!filesOf(project.name).includes(manifestPath)) continue;
    const manifest = parseManifest(readFile(manifestPath) ?? "");
    const packageName = manifest?.project?.name;
    if (!packageName) continue; // a uv workspace root without [project] is not a package
    projectByPackage.set(normalizePackageName(packageName), project.name);
    projectByRoot.set(project.root, project.name);
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
      let target = null;
      if (spec.workspace === true) {
        target = projectByPackage.get(depName) ?? null;
      } else if (typeof spec.path === "string") {
        target = projectByRoot.get(normalizePath(project.root, spec.path)) ?? null;
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
  return dependencies;
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
 * @returns {{ byModule: Map<string, object[]>, directoriesOf: Map<string, string[]>,
 *   unmodelled: { project: string, reason: string }[] }}
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
    for (const reason of layout.unmodelled) unmodelled.push({ project: project.name, reason });
    for (const [dotted, entry] of pythonModuleIndex(project.root, files, layout.directories)) {
      const owners = byModule.get(dotted) ?? [];
      owners.push({ project: project.name, file: entry.file });
      byModule.set(dotted, owners);
    }
  }
  return { byModule, directoriesOf, unmodelled };
});

/**
 * The project a dotted module name reaches, by longest matching prefix.
 *
 * @returns {{ owner: object }|{ ambiguous: string[], prefix: string }|null}
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
const FROM_STATEMENT =
  /^([ \t]*from[ \t]+)(\.+[A-Za-z_][\w.]*|\.+|[A-Za-z_][\w.]*)([ \t]+import\b)/;
const DOTTED_NAME = /^[ \t]*([A-Za-z_][\w.]*)/;
/** `importlib.import_module(`, a bare `import_module(`, and `__import__(`. */
const DYNAMIC_CALL = /\b(?:importlib\s*\.\s*)?import_module\s*\(\s*|\b__import__\s*\(\s*/g;
const STRING_LITERAL = /^(['"])([^'"\\]*)\1/;

/**
 * Every import site in a `.py` source, in source order and without
 * deduplication — one entry per written import.
 *
 * @param {string} pythonText
 * @returns {{ specifier: string, kind: string, offset: number, literal: boolean }[]}
 */
export function parsePythonImportSites(pythonText) {
  const sites = [];
  let lineOffset = 0;
  for (const line of pythonText.split("\n")) {
    const from = FROM_STATEMENT.exec(line);
    if (from) {
      sites.push({
        specifier: from[2],
        kind: "static",
        offset: lineOffset + from[1].length,
        literal: true,
      });
    } else {
      const statement = IMPORT_STATEMENT.exec(line);
      if (statement) {
        // `import a.b as c, x.y` is several written imports on one line, and
        // each gets its own record with its own column.
        let cursor = statement[0].length;
        for (const piece of line.slice(cursor).split(",")) {
          const name = DOTTED_NAME.exec(piece);
          if (name) {
            sites.push({
              specifier: name[1],
              kind: "static",
              offset: lineOffset + cursor + name[0].length - name[1].length,
              literal: true,
            });
          }
          cursor += piece.length + 1;
        }
      }
    }
    lineOffset += line.length + 1;
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

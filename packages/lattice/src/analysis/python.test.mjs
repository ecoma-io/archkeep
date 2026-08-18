import { describe, expect, it } from "vitest";

import {
  analyzePython,
  collectDeclaredDependencies,
  normalizePackageName,
  parsePythonImportSites,
  parseRequirementName,
  pythonImportRoots,
  pythonModuleIndex,
  pythonPackageLayout,
  resolvePythonDependencies,
} from "./python.mjs";

describe("name normalization (PEP 503)", () => {
  it("collapses case and separator runs", () => {
    expect(normalizePackageName("Acme__Tool.Kit")).toBe("acme-tool-kit");
  });

  it("extracts the package name from a PEP 508 requirement string", () => {
    expect(parseRequirementName("acme-core>=1.2,<2")).toBe("acme-core");
    expect(parseRequirementName("Acme_Core[extra] ; python_version >= '3.12'")).toBe("acme-core");
    expect(parseRequirementName("")).toBeNull();
  });
});

describe("collectDeclaredDependencies", () => {
  it("gathers names across dependencies, optional groups, and dependency-groups", () => {
    // The parsed shape, written directly: this pins what `collect…` does with
    // a manifest, not how TOML gets turned into one (that is manifest-util's
    // own test). Keys are the literal TOML table names smol-toml produces.
    const manifest = {
      project: {
        name: "alpha",
        dependencies: ["acme-core>=1"],
        "optional-dependencies": { cli: ["click>=8"] },
      },
      "dependency-groups": { dev: ["pytest", { "include-group": "cli" }] },
    };
    expect(collectDeclaredDependencies(manifest).sort()).toEqual(["acme-core", "click", "pytest"]);
  });
});

describe("resolvePythonDependencies", () => {
  const projects = [
    { name: "alpha", root: "acme/libs/alpha" },
    { name: "beta", root: "acme/libs/beta" },
  ];
  const files = {
    alpha: ["acme/libs/alpha/pyproject.toml"],
    beta: ["acme/libs/beta/pyproject.toml"],
  };
  const filesOf = (name) => files[name] ?? [];
  const betaManifest = '[project]\nname = "acme-beta"\nversion = "0.1.0"\n';

  it("draws an edge only when tool.uv.sources routes the name to the workspace", () => {
    const contents = {
      "acme/libs/alpha/pyproject.toml": [
        "[project]",
        'name = "acme-alpha"',
        'version = "0.1.0"',
        'dependencies = ["acme-beta", "requests>=2"]',
        "[tool.uv.sources]",
        "acme-beta = { workspace = true }",
      ].join("\n"),
      "acme/libs/beta/pyproject.toml": betaManifest,
    };
    expect(resolvePythonDependencies(projects, filesOf, (p) => contents[p] ?? null)).toEqual([
      {
        source: "alpha",
        target: "beta",
        sourceFile: "acme/libs/alpha/pyproject.toml",
        type: "static",
      },
    ]);
  });

  it("resolves a path source against the declaring project's root", () => {
    const contents = {
      "acme/libs/alpha/pyproject.toml": [
        "[project]",
        'name = "acme-alpha"',
        'version = "0.1.0"',
        "[dependency-groups]",
        'dev = ["acme-beta"]',
        "[tool.uv.sources]",
        'acme_beta = { path = "../beta" }', // underscore spelling still matches
      ].join("\n"),
      "acme/libs/beta/pyproject.toml": betaManifest,
    };
    expect(resolvePythonDependencies(projects, filesOf, (p) => contents[p] ?? null)).toHaveLength(
      1,
    );
  });

  it("never edges on a bare name match — uv semantics, not string matching", () => {
    const contents = {
      "acme/libs/alpha/pyproject.toml": [
        "[project]",
        'name = "acme-alpha"',
        'version = "0.1.0"',
        'dependencies = ["acme-beta"]', // same name as the sibling, but no source entry
      ].join("\n"),
      "acme/libs/beta/pyproject.toml": betaManifest,
    };
    expect(resolvePythonDependencies(projects, filesOf, (p) => contents[p] ?? null)).toEqual([]);
  });
});

describe("resolvePythonDependencies — Poetry and PDM path declarations", () => {
  const projects = [
    { name: "alpha", root: "acme/libs/alpha" },
    { name: "beta", root: "acme/libs/beta" },
  ];
  const files = {
    alpha: ["acme/libs/alpha/pyproject.toml"],
    beta: ["acme/libs/beta/pyproject.toml"],
  };
  const filesOf = (name) => files[name] ?? [];
  const alphaEdge = {
    source: "alpha",
    target: "beta",
    sourceFile: "acme/libs/alpha/pyproject.toml",
    type: "static",
  };
  /** Resolves a two-project tree where alpha's manifest is `lines`. */
  const resolveWith = (lines) => {
    const contents = {
      "acme/libs/alpha/pyproject.toml": lines.join("\n"),
      "acme/libs/beta/pyproject.toml": '[project]\nname = "acme-beta"\nversion = "0.1.0"\n',
    };
    return resolvePythonDependencies(projects, filesOf, (p) => contents[p] ?? null);
  };

  it("draws an edge from a Poetry path dependency, whatever `develop` says", () => {
    // The silent-direction proof for the whole feature: with the Poetry reader
    // disabled this returns [], and the assertion goes red on a manifest that
    // plainly declares the wiring.
    expect(
      resolveWith([
        "[tool.poetry.dependencies]",
        'acme-beta = { path = "../beta", develop = true }',
      ]),
    ).toEqual([alphaEdge]);
  });

  it("draws an edge from a Poetry group dependency with a path", () => {
    expect(
      resolveWith(["[tool.poetry.group.dev.dependencies]", 'acme-beta = { path = "../beta" }']),
    ).toEqual([alphaEdge]);
  });

  it("reads each element of Poetry's multiple-constraints array form", () => {
    expect(
      resolveWith([
        "[tool.poetry.dependencies]",
        'acme-beta = [{ version = "^1.0", python = "<3.11" }, { path = "../beta", python = ">=3.11" }]',
      ]),
    ).toEqual([alphaEdge]);
  });

  it("draws no edge from a Poetry entry without a path, even when the name matches a sibling", () => {
    expect(
      resolveWith([
        "[tool.poetry.dependencies]",
        'acme-beta = "^1.0"',
        "[tool.poetry.group.dev.dependencies]",
        'acme-alpha-tools = { version = "^2", optional = true }',
      ]),
    ).toEqual([]);
  });

  it("does not require either manifest to carry [project] — Poetry's legacy layout", () => {
    // A pre-PEP-621 Poetry pair names the package under [tool.poetry] and has
    // no [project] table at all. Path attribution is by directory, so identity
    // is not needed on either end.
    const contents = {
      "acme/libs/alpha/pyproject.toml": [
        "[tool.poetry]",
        'name = "acme-alpha"',
        'version = "0.1.0"',
        "[tool.poetry.dependencies]",
        'acme-beta = { path = "../beta" }',
      ].join("\n"),
      "acme/libs/beta/pyproject.toml": '[tool.poetry]\nname = "acme-beta"\nversion = "0.1.0"\n',
    };
    expect(resolvePythonDependencies(projects, filesOf, (p) => contents[p] ?? null)).toEqual([
      alphaEdge,
    ]);
  });

  it("draws an edge from PDM's pdm-backend and hatchling local-URL forms", () => {
    for (const url of ["file:///${PROJECT_ROOT}/../beta", "{root:uri}/../beta"]) {
      expect(
        resolveWith([
          "[project]",
          'name = "acme-alpha"',
          'version = "0.1.0"',
          `dependencies = ["acme-beta @ ${url}"]`,
        ]),
        url,
      ).toEqual([alphaEdge]);
    }
  });

  it("draws an edge from PDM's editable entry in a dependency group", () => {
    expect(
      resolveWith(["[dependency-groups]", 'dev = ["-e file:///${PROJECT_ROOT}/../beta"]']),
    ).toEqual([alphaEdge]);
  });

  it("draws one edge when several groups declare the same sibling", () => {
    expect(
      resolveWith([
        "[project]",
        'name = "acme-alpha"',
        'version = "0.1.0"',
        'dependencies = ["acme-beta @ file:///${PROJECT_ROOT}/../beta"]',
        "[tool.poetry.dependencies]",
        'acme-beta = { path = "../beta" }',
        "[tool.poetry.group.dev.dependencies]",
        'acme-beta = { path = "../beta" }',
      ]),
    ).toEqual([alphaEdge]);
  });

  it("throws for a declared path that resolves to no project's tree", () => {
    // The loud direction, chosen on purpose: a dropped entry here is an edge
    // `nx affected` silently never sees on a wiring the manifest plainly
    // states. See the module header's landing table.
    expect(() =>
      resolveWith(["[tool.poetry.dependencies]", 'acme-beta = { path = "../nowhere" }']),
    ).toThrow(
      /acme\/libs\/alpha\/pyproject\.toml.*'acme-beta'.*'\.\.\/nowhere'.*not in any Nx project's tree/su,
    );
  });

  it("throws for a path inside another project that is not that project's root", () => {
    // A dependency on a sibling's built artifact is a real dependency on that
    // project, but the one-manifest-per-project-root model can only attribute
    // a root — so it is refused loudly rather than modeled wrongly.
    expect(() =>
      resolveWith([
        "[tool.poetry.dependencies]",
        'acme-beta = { path = "../beta/dist/acme-beta-0.1.0.tar.gz" }',
      ]),
    ).toThrow(/inside project 'beta' but not at its root/u);
  });

  it("throws for a PDM local URL that is not root-anchored", () => {
    // Backends other than pdm-backend/hatchling write absolute paths (PDM
    // docs, "Local dependencies"); without the anchor nothing says whether
    // the target is even in the tree, so guessing either way is out.
    expect(() =>
      resolveWith([
        "[project]",
        'name = "acme-alpha"',
        'version = "0.1.0"',
        'dependencies = ["acme-beta @ file:///opt/checkouts/beta"]',
      ]),
    ).toThrow(/not anchored/u);
  });

  it("draws nothing, quietly, for a path that leaves the workspace", () => {
    // Whatever sits outside the tree is not a workspace project, so "no edge"
    // is a verdict here, not a shrug — the same answer a PyPI dependency gets.
    expect(
      resolveWith([
        "[tool.poetry.dependencies]",
        'shared-lib = { path = "../../../../elsewhere/shared-lib" }',
      ]),
    ).toEqual([]);
  });

  it("draws nothing, quietly, for a vendored artifact inside the declaring project", () => {
    expect(
      resolveWith([
        "[project]",
        'name = "acme-alpha"',
        'version = "0.1.0"',
        'dependencies = ["first @ file:///${PROJECT_ROOT}/vendor/first-1.0.0-py2.py3-none-any.whl"]',
        "[tool.poetry.dependencies]",
        'acme-alpha-plugin = { path = "." }', // self-reference wires nothing new
      ]),
    ).toEqual([]);
  });

  it("draws nothing for URL dependencies that are not local paths", () => {
    expect(
      resolveWith([
        "[project]",
        'name = "acme-alpha"',
        'version = "0.1.0"',
        "dependencies = [",
        '  "pip @ git+https://github.com/pypa/pip.git@22.0",',
        '  "numpy @ https://github.com/numpy/numpy/releases/download/v1.20.0/numpy-1.20.0.tar.gz",',
        "]",
      ]),
    ).toEqual([]);
  });

  it("draws no edges from a manifest that is not valid TOML, and does not throw", () => {
    // Deliberately quiet HERE and loud elsewhere: Nx recomputes the graph on
    // every invocation, so a manifest is malformed mid-keystroke in every
    // editing session, and a throw would brick every `nx` command until the
    // file parses (`manifest-util.test.mjs` pins the survival). The loud
    // report is the analysis layer's: `pythonPackageLayout` returns the same
    // manifest as unmodelled, which the layout tests above pin.
    const contents = {
      "acme/libs/alpha/pyproject.toml": "[tool.poetry.dependencies\nbroken = { path = ",
      "acme/libs/beta/pyproject.toml": '[project]\nname = "acme-beta"\n',
    };
    expect(resolvePythonDependencies(projects, filesOf, (p) => contents[p] ?? null)).toEqual([]);
  });
});

describe("import roots derived from the layout", () => {
  it("reads a src layout, a flat layout and a single module the way Python does", () => {
    // Not from the manifest: setuptools, hatchling, poetry, pdm and flit each
    // declare packages differently, and the tree already states the answer all
    // five are trying to describe.
    expect(
      pythonImportRoots("libs/alpha", [
        "libs/alpha/pyproject.toml",
        "libs/alpha/src/alpha/__init__.py",
        "libs/alpha/src/alpha/service.py",
        "libs/alpha/conftest.py",
      ]),
    ).toEqual(["alpha", "conftest"]);

    expect(pythonImportRoots("libs/beta", ["libs/beta/beta/__init__.py"])).toEqual(["beta"]);
    expect(pythonImportRoots("libs/gamma", ["libs/gamma/gamma.py"])).toEqual(["gamma"]);
  });

  it("indexes a src-layout package under src, never also as `src.<pkg>`", () => {
    const index = pythonModuleIndex("libs/alpha", ["libs/alpha/src/alpha/service.py"]);
    expect([...index.keys()]).toEqual(["alpha.service", "alpha"]);
  });

  it("records a directory with no __init__.py, because PEP 420 still makes it importable", () => {
    const index = pythonModuleIndex("libs/alpha", ["libs/alpha/src/ns/alpha/thing.py"]);
    expect(index.get("ns")).toEqual({ file: null, namespace: true });
    expect(index.get("ns.alpha.thing")).toEqual({
      file: "libs/alpha/src/ns/alpha/thing.py",
      namespace: false,
    });
  });

  it("prefers a real __init__.py over the namespace entry regardless of file order", () => {
    const forward = ["libs/a/src/pkg/__init__.py", "libs/a/src/pkg/mod.py"];
    for (const files of [forward, [...forward].reverse()]) {
      expect(pythonModuleIndex("libs/a", files).get("pkg")).toEqual({
        file: "libs/a/src/pkg/__init__.py",
        namespace: false,
      });
    }
  });

  it("ignores a directory Python cannot spell in an import", () => {
    expect(pythonImportRoots("libs/a", ["libs/a/src/my-pkg/thing.py"])).toEqual([]);
  });

  it("reads a package through a directory only the manifest names", () => {
    // Without the declared directory the file still lands somewhere — under
    // the project root, as `lib.alpha` — which is worse than invisible: it is
    // a name nothing imports, so `import alpha` reaches no project at all.
    const files = ["libs/alpha/lib/alpha/__init__.py"];
    expect(pythonImportRoots("libs/alpha", files)).toEqual(["lib"]);
    expect(pythonImportRoots("libs/alpha", files, ["lib"])).toEqual(["alpha"]);
  });

  it("keeps the project root last, so a declared directory is never read through it", () => {
    // With the root first, `lib/alpha/thing.py` indexes as `lib.alpha.thing` —
    // a dotted name nothing imports — and the package stays invisible for a
    // second reason.
    const index = pythonModuleIndex("libs/alpha", ["libs/alpha/lib/alpha/thing.py"], ["lib"]);
    expect([...index.keys()]).toEqual(["alpha.thing", "alpha"]);
  });
});

describe("package locations a pyproject.toml declares", () => {
  const layoutOf = (toml) => pythonPackageLayout(toml);

  it("has nothing to say about a project with no manifest", () => {
    // No declaration is not a gap: the filesystem scan is the whole answer.
    expect(layoutOf(null)).toEqual({ directories: [], unmodelled: [] });
  });

  it("reads the four declarations a build backend states a directory in", () => {
    expect(layoutOf('[tool.setuptools]\npackage-dir = { "" = "lib" }\n').directories).toEqual([
      "lib",
    ]);
    expect(
      layoutOf('[tool.setuptools.packages.find]\nwhere = ["lib", "extra"]\n').directories,
    ).toEqual(["lib", "extra"]);
    // hatch ships `python/pkg` into the wheel as `pkg`, so the base is `python`.
    expect(
      layoutOf('[tool.hatch.build.targets.wheel]\npackages = ["python/pkg", "flat"]\n').directories,
    ).toEqual(["python", ""]);
    expect(
      layoutOf('[tool.poetry]\npackages = [{ include = "pkg", from = "lib" }, { include = "b" }]\n')
        .directories,
    ).toEqual(["lib", ""]);
  });

  it("reads the tables whichever backend the manifest names, because presence is the declaration", () => {
    // A `[tool.hatch…]` table means hatch even when `[build-system]` is absent,
    // which is exactly the manifest shape that hid a first-party package.
    const toml =
      '[build-system]\nrequires = ["setuptools"]\nbuild-backend = "setuptools.build_meta"\n\n' +
      '[tool.hatch.build.targets.wheel]\npackages = ["python/pkg"]\n';
    expect(layoutOf(toml)).toEqual({ directories: ["python"], unmodelled: [] });
  });

  it("refuses to answer for a package-dir key that renames rather than relocates", () => {
    // `{"pkg" = "lib/other"}` makes `lib/other` importable as `pkg`; no base
    // this scan could add would ever produce that name.
    const layout = layoutOf('[tool.setuptools]\npackage-dir = { pkg = "lib/other" }\n');
    expect(layout.directories).toEqual([]);
    expect(layout.unmodelled).toEqual([
      "its `[tool.setuptools] package-dir` renames the package 'pkg'",
    ]);
  });

  it("refuses to answer for a hatch sources rewrite or a poetry to-rename", () => {
    expect(
      layoutOf('[tool.hatch.build.targets.wheel]\npackages = ["a"]\nsources = ["a"]\n').unmodelled,
    ).toEqual([
      "its `[tool.hatch.build.targets.wheel] sources` rewrites the path each package is imported under",
    ]);
    expect(
      layoutOf('[tool.poetry]\npackages = [{ include = "pkg", to = "vendored" }]\n').unmodelled,
    ).toEqual(["its `[tool.poetry] packages` renames a package with `to`"]);
  });

  it("refuses to answer for a build backend whose keys it does not read", () => {
    // maturin's `[tool.maturin] python-source` and scikit-build's
    // `[tool.scikit-build] wheel.packages` both relocate packages in a key
    // nothing here reads, so "no declaration found" would be a false reading.
    const layout = layoutOf('[build-system]\nrequires = ["maturin"]\nbuild-backend = "maturin"\n');
    expect(layout.unmodelled).toEqual([
      "it builds with 'maturin', whose package-location keys this reader does not read",
    ]);
    // An ABSENT backend is setuptools by PEP 517's fallback, which IS read.
    expect(layoutOf('[project]\nname = "a"\n').unmodelled).toEqual([]);
  });

  it("refuses to answer for a manifest that is not valid TOML", () => {
    expect(layoutOf("[project\nname = 'a'\n").unmodelled).toEqual([
      "its `pyproject.toml` is not valid TOML, so nothing it declares can be read",
    ]);
  });

  it("refuses to answer for a declaration in a shape the reader cannot walk", () => {
    expect(layoutOf('[tool.setuptools]\npackage-dir = "lib"\n').unmodelled).toEqual([
      "its `[tool.setuptools] package-dir` is not a table",
    ]);
    expect(layoutOf("[tool.setuptools.packages.find]\nwhere = 3\n").unmodelled).toEqual([
      "its `[tool.setuptools.packages.find] where` is not a list of directories",
    ]);
    expect(layoutOf("[tool.hatch.build]\npackages = 3\n").unmodelled).toEqual([
      "its `[tool.hatch.build] packages` is not a list of paths",
    ]);
    expect(layoutOf('[tool.poetry]\npackages = "pkg"\n').unmodelled).toEqual([
      "its `[tool.poetry] packages` is not a list",
    ]);
    expect(layoutOf('[tool.poetry]\npackages = ["pkg"]\n').unmodelled).toEqual([
      "its `[tool.poetry] packages` holds an entry that is not a table",
    ]);
  });

  it("leaves a plain setuptools packages list alone, since those names sit at the default bases", () => {
    expect(layoutOf('[tool.setuptools]\npackages = ["pkg", "pkg.sub"]\n')).toEqual({
      directories: [],
      unmodelled: [],
    });
  });
});

describe("a Python package outside the two default bases", () => {
  /** A two-project tree where `storage`'s package sits wherever `manifest` says. */
  const workspaceWith = (manifest, packageDirectory) => {
    const files = {
      "apps/viewer/pyproject.toml": '[project]\nname = "viewer"\n',
      "apps/viewer/src/viewer/app.py": "import storage.secret\n",
      "libs/storage/pyproject.toml": manifest,
      [`libs/storage/${packageDirectory}/storage/__init__.py`]: "",
      [`libs/storage/${packageDirectory}/storage/secret.py`]: "TOKEN = 'x'\n",
    };
    const byProject = {
      viewer: Object.keys(files).filter((file) => file.startsWith("apps/viewer/")),
      storage: Object.keys(files).filter((file) => file.startsWith("libs/storage/")),
    };
    return {
      root: "/w",
      projects: [
        { name: "viewer", root: "apps/viewer" },
        { name: "storage", root: "libs/storage" },
      ],
      filesOf: (name) => byProject[name] ?? [],
      readFile: (path) => files[path] ?? null,
    };
  };

  const analyzeImporter = (manifest, packageDirectory) =>
    analyzePython({
      sourceFile: "apps/viewer/src/viewer/app.py",
      text: "import storage.secret\n",
      workspace: workspaceWith(manifest, packageDirectory),
    });

  it("is still a project, not a PyPI distribution that happens to share its name", () => {
    // The whole defect in one assertion. Resolving to nothing made the record
    // `external: true`, and `../rules/` returns from its `type === "npm"`
    // branch before any tag constraint is read — so a real cross-project import
    // produced neither a violation nor a failure. Not a blind spot: an answer,
    // and the wrong one.
    for (const [manifest, directory] of [
      ['[project]\nname = "storage"\n\n[tool.setuptools]\npackage-dir = { "" = "lib" }\n', "lib"],
      ['[project]\nname = "storage"\n\n[tool.setuptools.packages.find]\nwhere = ["lib"]\n', "lib"],
      [
        '[project]\nname = "storage"\n\n[tool.hatch.build.targets.wheel]\npackages = ["python/storage"]\n',
        "python",
      ],
      [
        '[project]\nname = "storage"\n\n[tool.poetry]\npackages = [{ include = "storage", from = "lib" }]\n',
        "lib",
      ],
    ]) {
      const { imports, failures } = analyzeImporter(manifest, directory);
      expect(failures, manifest).toEqual([]);
      expect(imports[0].resolved, manifest).toEqual({
        target: "storage",
        file: `libs/storage/${directory}/storage/secret.py`,
        external: false,
        packageName: null,
      });
    }
  });

  it("is recorded as unplaceable when its manifest declares a layout this reader cannot follow", () => {
    // The floor: stop asserting what is not known. A failure is a blind spot a
    // maintainer can see; `external: true` is a green light nobody can trust.
    const { imports, failures } = analyzeImporter(
      '[project]\nname = "storage"\n\n[tool.setuptools]\npackage-dir = { storage = "lib/vendor" }\n',
      "lib",
    );
    expect(imports[0].resolved).toBeNull();
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatch(/reaches no project.*cannot conclude it is external/su);
    expect(failures[0].reason).toMatch(/project 'storage'.*renames the package 'storage'/su);
    expect(failures[0].line).toBe(1);
  });

  it("withholds the external verdict from every unplaceable name, not only the matching one", () => {
    // A package this reader cannot locate could carry ANY top-level import
    // name, so the doubt is workspace-wide. Narrowing it to names that look
    // first-party would be the same guess in a smaller costume.
    const workspace = workspaceWith(
      '[project]\nname = "storage"\n\n[build-system]\nrequires = ["maturin"]\nbuild-backend = "maturin"\n',
      "lib",
    );
    const { imports, failures } = analyzePython({
      sourceFile: "apps/viewer/src/viewer/app.py",
      text: "import os\n",
      workspace,
    });
    expect(imports[0].resolved).toBeNull();
    expect(failures[0].reason).toMatch(/it builds with 'maturin'/u);
  });

  it("keeps calling a name external when every project's packages are where it can look", () => {
    // The near-miss. A reader that answered "unplaceable" for every stdlib
    // import would be honest and useless; the doubt has to be earned.
    const { imports, failures } = analyzePython({
      sourceFile: "apps/viewer/src/viewer/app.py",
      text: "import os\n",
      workspace: workspaceWith(
        '[project]\nname = "storage"\n\n[tool.setuptools]\npackage-dir = { "" = "lib" }\n',
        "lib",
      ),
    });
    expect(failures).toEqual([]);
    expect(imports[0].resolved).toEqual({
      target: null,
      file: null,
      external: true,
      packageName: "os",
    });
  });

  it("anchors a relative import at the package the manifest relocated, not one level up", () => {
    // The declared base decides the importing file's OWN package too. Read
    // against the default bases, `lib/storage/secret.py` sits in `lib.storage`
    // — a name nothing imports — so `from ..` lands on the invented `lib`
    // instead of leaving the top-level package the way Python says it does.
    const workspace = workspaceWith(
      '[project]\nname = "storage"\n\n[tool.setuptools]\npackage-dir = { "" = "lib" }\n',
      "lib",
    );
    const analyze = (text) =>
      analyzePython({ sourceFile: "libs/storage/lib/storage/secret.py", text, workspace });

    const inside = analyze("from . import sibling\n");
    expect(inside.failures).toEqual([]);
    expect(inside.imports[0].resolved).toMatchObject({ target: "storage", external: false });

    const climbing = analyze("from .. import escape\n");
    expect(climbing.imports[0].resolved).toBeNull();
    expect(climbing.failures[0].reason).toMatch(/climbs past the top-level package/u);
  });
});

describe("parsePythonImportSites", () => {
  it("reads both statement forms, and one record per name on a shared line", () => {
    const source = "import os, alpha.service as svc\nfrom beta.store import Thing\n";
    expect(
      parsePythonImportSites(source).map((site) => [
        site.specifier,
        source.slice(site.offset, site.offset + 3),
      ]),
    ).toEqual([
      ["os", "os,"],
      ["alpha.service", "alp"],
      ["beta.store", "bet"],
    ]);
  });

  it("reads every relative spelling, keeping the dots as written", () => {
    expect(
      parsePythonImportSites(
        [
          "from . import x",
          "from .. import y",
          "from .mod import z",
          "from ..pkg.sub import w",
        ].join("\n"),
      ).map((site) => site.specifier),
    ).toEqual([".", "..", ".mod", "..pkg.sub"]);
  });

  it("reads an indented import, which is what catches TYPE_CHECKING and function-local ones", () => {
    const source = [
      "if TYPE_CHECKING:",
      "    from alpha.model import Task",
      "",
      "def f():",
      "    import beta",
    ].join("\n");
    expect(parsePythonImportSites(source).map((site) => site.specifier)).toEqual([
      "alpha.model",
      "beta",
    ]);
  });

  it("does not read a commented-out import", () => {
    expect(parsePythonImportSites("# import fake\n#from fake import x\n")).toEqual([]);
  });

  it("reads a dynamic import and marks whether its argument was a literal", () => {
    const source = [
      'importlib.import_module("alpha.service")',
      "importlib.import_module(name)",
      '__import__("beta")',
    ].join("\n");
    expect(
      parsePythonImportSites(source).map((site) => [site.kind, site.specifier, site.literal]),
    ).toEqual([
      ["dynamic", "alpha.service", true],
      ["dynamic", "name", false],
      ["dynamic", "beta", true],
    ]);
  });

  // The two below pin what used to be a silent miss: a name after the line
  // break, or after the `;`, produced no record and no failure at all — a
  // real import reporting exactly like a clean file.
  it("joins a backslash-continued statement and reads every name in it", () => {
    const source = "import alpha, \\\n    beta\n";
    expect(parsePythonImportSites(source).map((site) => site.specifier)).toEqual(["alpha", "beta"]);
  });

  it("reads a statement that shares a physical line with another via `;`", () => {
    const source = "import alpha; import beta\n";
    expect(
      parsePythonImportSites(source).map((site) => [
        site.specifier,
        source.slice(site.offset, site.offset + 4),
      ]),
    ).toEqual([
      ["alpha", "alph"],
      ["beta", "beta"],
    ]);
  });

  it("resolves a `\\`-continued module name that sits ahead of a `;`-shared `import`, together", () => {
    // Realistic combinations of the two forms, not just each in isolation.
    expect(
      parsePythonImportSites("from alpha.core \\\n    import Thing\n").map(
        (site) => site.specifier,
      ),
    ).toEqual(["alpha.core"]);
    expect(
      parsePythonImportSites("import os; from alpha.core import Thing\n").map(
        (site) => site.specifier,
      ),
    ).toEqual(["os", "alpha.core"]);
  });

  it("never joins a line that has nothing to do with the continuation", () => {
    // The hazard a naive whole-file join would risk: an unrelated line ending
    // in a bare `\` — a comment noting a Windows path, here — must not pull
    // the import on the next line into it and hide it.
    const source = "# see C:\\\nimport alpha\n";
    expect(parsePythonImportSites(source).map((site) => site.specifier)).toEqual(["alpha"]);
  });

  it("reports a continuation it could not parse after joining, rather than dropping it", () => {
    // The residual, honestly-reported gap: a backslash landing inside the
    // dotted module name itself (not after it, and not in the name list) is
    // not reassembled into one contiguous name, so this is a loud blind spot
    // instead of a silently empty result.
    const source = "from pkg \\\n    .sub import foo\n";
    const [site] = parsePythonImportSites(source);
    expect(site.literal).toBe(false);
    expect(site.continuation).toBe(true);
  });
});

describe("analyzePython", () => {
  const workspace = {
    root: "/w",
    projects: [
      { name: "alpha", root: "libs/alpha" },
      { name: "beta", root: "libs/beta" },
    ],
    filesOf: (name) =>
      ({
        alpha: [
          "libs/alpha/pyproject.toml",
          "libs/alpha/src/alpha/__init__.py",
          "libs/alpha/src/alpha/service.py",
          "libs/alpha/src/alpha/deep/__init__.py",
          "libs/alpha/src/alpha/deep/thing.py",
        ],
        beta: [
          "libs/beta/pyproject.toml",
          "libs/beta/src/beta/__init__.py",
          "libs/beta/src/beta/store.py",
        ],
      })[name] ?? [],
    readFile: () => null,
  };
  const analyze = (text, sourceFile = "libs/alpha/src/alpha/service.py") =>
    analyzePython({ sourceFile, text, workspace });

  it("sees the cross-project import the manifest view cannot", () => {
    // The false negative this rewrite exists to close. Neither project
    // declares the other in `[tool.uv.sources]`, so the manifest resolver
    // draws nothing — yet the import works at runtime, both packages being on
    // sys.path in a uv workspace, and the boundary was crossed.
    expect(resolvePythonDependencies(workspace.projects, workspace.filesOf, () => null)).toEqual(
      [],
    );
    const { imports, failures } = analyze("from beta.store import Thing\n");
    expect(failures).toEqual([]);
    expect(imports[0]).toEqual({
      sourceFile: "libs/alpha/src/alpha/service.py",
      line: 1,
      column: 6,
      specifier: "beta.store",
      kind: "static",
      spelling: { path: false, relative: false },
      resolved: {
        target: "beta",
        file: "libs/beta/src/beta/store.py",
        external: false,
        packageName: null,
      },
    });
  });

  it("crosses a boundary named only after a backslash-continued line break", () => {
    // The silent-miss direction for case 3: before the fix, a name written
    // after the line break of a backslash-continued `import` statement
    // produced no record and no failure at all — a real cross-project import
    // reporting exactly like a clean file.
    const { imports, failures } = analyze("import os, \\\n    beta.store\n");
    expect(failures).toEqual([]);
    expect(imports).toHaveLength(2);
    expect(imports[1].specifier).toBe("beta.store");
    expect(imports[1].resolved.target).toBe("beta");
  });

  it("crosses a boundary named only after a `;` on the same line as another import", () => {
    // The silent-miss direction for case 4.
    const { imports, failures } = analyze("import os; import beta.store\n");
    expect(failures).toEqual([]);
    expect(imports).toHaveLength(2);
    expect(imports[1].specifier).toBe("beta.store");
    expect(imports[1].resolved.target).toBe("beta");
  });

  it("emits an import that never leaves the project", () => {
    const { imports } = analyze("import alpha.deep.thing\n");
    expect(imports[0].resolved).toEqual({
      target: "alpha",
      file: "libs/alpha/src/alpha/deep/thing.py",
      external: false,
      packageName: null,
    });
  });

  it("marks a stdlib or PyPI module external, named as the source spells it", () => {
    // `import PIL` ships as the distribution `pillow`; only the import name is
    // knowable from a source file, so that is what a glob must be written for.
    const { imports } = analyze("import os\nfrom PIL import Image\n");
    expect(imports.map((record) => record.resolved)).toEqual([
      { target: null, file: null, external: true, packageName: "os" },
      { target: null, file: null, external: true, packageName: "PIL" },
    ]);
  });

  it("keeps a TYPE_CHECKING import as a real static import of the project it names", () => {
    // Erased at runtime, but a runtime conditional is not a declaration that
    // the dependency is absent — the module is named and the boundary is
    // crossed. Marking it type-only would let a rule that exempts erased
    // imports exempt it, which is the bypass this tool closes.
    const { imports } = analyze(
      [
        "from typing import TYPE_CHECKING",
        "",
        "if TYPE_CHECKING:",
        "    from beta.store import Thing",
      ].join("\n"),
    );
    expect(imports[1]).toMatchObject({ line: 4, kind: "static", specifier: "beta.store" });
    expect(imports[1].resolved.target).toBe("beta");
  });

  it("resolves a relative import against the file's own package", () => {
    const { imports } = analyze("from . import deep\nfrom .deep import thing\n");
    expect(imports.map((record) => [record.specifier, record.resolved.file])).toEqual([
      [".", "libs/alpha/src/alpha/__init__.py"],
      [".deep", "libs/alpha/src/alpha/deep/__init__.py"],
    ]);
  });

  it("calls every leading-dot form relative, and none of them a path", () => {
    // Python's `./x` and `../x` — and the two the rules layer's old
    // JavaScript-shaped predicate got wrong in both directions: `.deep` and
    // `..beta` read as package names to it, while a bare `.` read as a
    // filesystem path, which is what `noRelativeOrAbsoluteExternals` is about
    // and a dotted module name is not.
    const { imports } = analyze(
      "from . import deep\nfrom .deep import thing\nfrom ..beta import store\nimport beta.store\n",
    );
    expect(imports.map((record) => [record.specifier, record.spelling])).toEqual([
      [".", { path: false, relative: true }],
      [".deep", { path: false, relative: true }],
      ["..beta", { path: false, relative: true }],
      ["beta.store", { path: false, relative: false }],
    ]);
  });

  it("still calls a relative import relative when it resolved to nothing", () => {
    // `from ... import escape` climbs out of the project and resolves to
    // nothing. The record is still spelled relatively, so nothing downstream
    // may call it a path: the honest output is the analysis failure, not a
    // violation about a path nobody wrote.
    const { imports, failures } = analyze("from ... import escape\n");
    expect(imports[0].spelling).toEqual({ path: false, relative: true });
    expect(imports[0].resolved).toBeNull();
    expect(failures).toHaveLength(1);
  });

  it("anchors a relative import in an __init__.py at its own package, not its parent", () => {
    // `pkg/__init__.py` IS `pkg`, so `from . import x` inside it means `pkg`.
    // Dropping `__init__` before taking the parent climbs one level too far
    // and resolves every relative import in every package one level wrong.
    const { imports } = analyze("from . import service\n", "libs/alpha/src/alpha/__init__.py");
    expect(imports[0].resolved.file).toBe("libs/alpha/src/alpha/__init__.py");
  });

  it("catches a relative import that climbs out of the project", () => {
    // `..` past the top-level package leaves the import root entirely, which
    // Python rejects too. Guessing a target for it is how a boundary gets
    // crossed by counting dots.
    const { imports, failures } = analyze("from ... import escape\n");
    expect(imports[0].resolved).toBeNull();
    expect(failures[0].reason).toMatch(/climbs past the top-level package/);
    expect(failures[0].line).toBe(1);
  });

  it("resolves a relative import that climbs sideways into another project", () => {
    // Two projects contributing to one namespace: `..` out of `ns.alpha` into
    // `ns.beta` is a real cross-project import, spelled with dots.
    const shared = {
      ...workspace,
      filesOf: (name) =>
        ({
          alpha: ["libs/alpha/src/ns/alpha/service.py"],
          beta: ["libs/beta/src/ns/beta/store.py"],
        })[name] ?? [],
    };
    const { imports } = analyzePython({
      sourceFile: "libs/alpha/src/ns/alpha/service.py",
      text: "from ..beta.store import Thing\n",
      workspace: shared,
    });
    expect(imports[0].resolved).toMatchObject({
      target: "beta",
      file: "libs/beta/src/ns/beta/store.py",
    });
  });

  it("resolves a namespace package by longest dotted prefix, not by its shared top level", () => {
    const shared = {
      ...workspace,
      filesOf: (name) =>
        ({
          alpha: ["libs/alpha/src/ns/alpha/thing.py"],
          beta: ["libs/beta/src/ns/beta/other.py"],
        })[name] ?? [],
    };
    const { imports, failures } = analyzePython({
      sourceFile: "libs/alpha/src/ns/alpha/thing.py",
      text: "import ns.beta.other\n",
      workspace: shared,
    });
    expect(failures).toEqual([]);
    expect(imports[0].resolved.target).toBe("beta");
  });

  it("reports a shared namespace as ambiguous rather than picking a project", () => {
    // Python resolves this by sys.path order, which no static reader can know.
    const shared = {
      ...workspace,
      filesOf: (name) =>
        ({
          alpha: ["libs/alpha/src/ns/alpha/thing.py"],
          beta: ["libs/beta/src/ns/beta/other.py"],
        })[name] ?? [],
    };
    const { imports, failures } = analyzePython({
      sourceFile: "libs/alpha/src/ns/alpha/thing.py",
      text: "import ns\n",
      workspace: shared,
    });
    expect(imports[0].resolved).toBeNull();
    expect(failures[0].reason).toMatch(/namespace package 'ns'.*alpha and beta/);
  });

  it("resolves a dynamic import with a literal argument like any other", () => {
    const { imports } = analyze('importlib.import_module("beta.store")\n');
    expect(imports[0]).toMatchObject({ kind: "dynamic", specifier: "beta.store" });
    expect(imports[0].resolved.target).toBe("beta");
  });

  it("records a dynamic import of a variable as unresolvable instead of guessing", () => {
    const { imports, failures } = analyze("importlib.import_module(plugin_name)\n");
    expect(imports[0]).toMatchObject({ kind: "dynamic", specifier: "plugin_name", resolved: null });
    expect(failures[0].reason).toMatch(/non-literal argument/);
  });

  it("returns an envelope rather than throwing when the workspace misbehaves", () => {
    const hostile = {
      ...workspace,
      filesOf: () => {
        throw new Error("graph unavailable");
      },
    };
    const result = analyzePython({ sourceFile: "a/b.py", text: "import os", workspace: hostile });
    expect(result.imports).toEqual([]);
    expect(result.failures[0].reason).toMatch(/graph unavailable/);
  });
});

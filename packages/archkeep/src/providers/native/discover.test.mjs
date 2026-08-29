import { describe, expect, it } from "vitest";

import { normalizeNativeModel } from "./model.mjs";
import { judgeCoverage } from "./coverage.mjs";
import { discoverNativeProjects, nodeTypeOf, PROJECT_CONFIG_FILE } from "./discover.mjs";

/** A model with every default applied, so each test only states what it bends. */
const modelOf = (raw) => normalizeNativeModel({ projects: { declared: [] }, ...raw });

/** An in-memory `readFile`, backed by a plain path → text map. */
const filesOf = (contents) => (path) => (path in contents ? contents[path] : null);

describe("PROJECT_CONFIG_FILE", () => {
  it("is the file Nx itself reads to learn a project exists", () => {
    expect(PROJECT_CONFIG_FILE).toBe("project.json");
  });
});

describe("nodeTypeOf", () => {
  it("reproduces Nx's own getProjectType, including the -e2e suffix rule", () => {
    expect(nodeTypeOf("checkout", "application")).toBe("app");
    expect(nodeTypeOf("checkout-e2e", "application")).toBe("e2e");
    expect(nodeTypeOf("e2e", "application")).toBe("e2e");
    expect(nodeTypeOf("checkout", "library")).toBe("lib");
    expect(nodeTypeOf("checkout", undefined)).toBe("lib");
  });
});

describe("discoverNativeProjects", () => {
  it("lets a declared name win over a project.json name at the same root", () => {
    const model = modelOf({
      projects: { declared: [{ root: "apps/a", name: "custom-a" }] },
    });
    const { projects } = discoverNativeProjects({
      root: "/repo",
      files: ["apps/a/project.json"],
      readFile: filesOf({ "apps/a/project.json": JSON.stringify({ name: "from-manifest" }) }),
      model,
    });
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("custom-a");
  });

  describe("name precedence for an inferred project, matching Nx's own chain exactly", () => {
    // Each rung is its own case: a test that only proved the top rung passes
    // even when the fallback two rungs down resolves the wrong name.
    it("prefers project.json's name over package.json's and the directory basename", () => {
      const model = modelOf({ projects: { declared: [], infer: {} } });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["libs/a/project.json", "libs/a/package.json"],
        readFile: filesOf({
          "libs/a/project.json": JSON.stringify({ name: "from-project-json" }),
          "libs/a/package.json": JSON.stringify({ name: "from-package-json" }),
        }),
        model,
      });
      expect(projects.map((p) => p.name)).toEqual(["from-project-json"]);
    });

    it("falls back to package.json's name when there is no project.json", () => {
      const model = modelOf({ projects: { declared: [], infer: {} } });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["libs/a/package.json"],
        readFile: filesOf({ "libs/a/package.json": JSON.stringify({ name: "from-package-json" }) }),
        model,
      });
      expect(projects.map((p) => p.name)).toEqual(["from-package-json"]);
    });

    // The bug this pins: `readPackageName` used to be called only when
    // `manifest` was falsy (`!manifest`), but a `project.json` that EXISTS
    // and simply omits `name` is still a truthy manifest — that guard skipped
    // `package.json` entirely and fell straight to the directory basename,
    // one rung early. `../../lsp/workspace-index.mjs`'s `discoverProjects`,
    // the oracle this precedence reproduces, reads `package.json`
    // unconditionally; this project.json-present-but-nameless case is the one
    // that told the two implementations apart.
    it("falls through project.json's name to package.json's when project.json omits name", () => {
      const model = modelOf({ projects: { declared: [], infer: {} } });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["libs/a/project.json", "libs/a/package.json"],
        readFile: filesOf({
          "libs/a/project.json": JSON.stringify({ tags: ["scope:a"] }),
          "libs/a/package.json": JSON.stringify({ name: "from-package-json" }),
        }),
        model,
      });
      expect(projects.map((p) => p.name)).toEqual(["from-package-json"]);
    });

    it("falls back to the directory basename when neither manifest names the project", () => {
      const model = modelOf({ projects: { declared: [], infer: {} } });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["libs/a/go.mod"],
        readFile: filesOf({ "libs/a/go.mod": "module example.com/a\n\ngo 1.24\n" }),
        model,
      });
      expect(projects.map((p) => p.name)).toEqual(["a"]);
    });
  });

  // Silent-direction: a duplicate declared root must not silently keep the
  // last-declared row — that would let a copy-pasted entry quietly shadow the
  // one a reader actually meant.
  it("throws on two declared rows naming the same root, rather than keeping the last one", () => {
    const model = modelOf({
      projects: {
        declared: [
          { root: "apps/a", name: "first" },
          { root: "apps/a", name: "second" },
        ],
      },
    });
    expect(() =>
      discoverNativeProjects({
        root: "/repo",
        files: ["apps/a/x.go"],
        readFile: filesOf({}),
        model,
      }),
    ).toThrow(/two rows declare the same root 'apps\/a'/);
  });

  // Silent-direction: a declared root with nothing backing it must not become
  // a project list that is merely shorter than expected — it has to throw,
  // naming the entry that does not hold up against the tree.
  it("throws on a declared root with no tracked file under it, not a silently shorter list", () => {
    const model = modelOf({ projects: { declared: [{ root: "apps/ghost" }] } });
    expect(() =>
      discoverNativeProjects({
        root: "/repo",
        files: ["apps/a/x.go"],
        readFile: filesOf({}),
        model,
      }),
    ).toThrow(/projects\.declared: root 'apps\/ghost' has no tracked file under it/);
  });

  // Spec §3.1, and the bug S2 fixes: an absent `projects.infer` means the
  // declared list is exhaustive — no inference runs at all — not "infer with
  // the defaults filled in." Silently running it anyway is the exact
  // silent-direction failure the model this file describes exists to refuse:
  // a vendored `package.json` (and any source file beside it) would be
  // claimed by a phantom project nobody in `archkeep.json` asked to include,
  // and every one of its files would read as owned rather than as the
  // coverage hole they actually are.
  describe("omitted projects.infer", () => {
    it("runs no inference at all — a directory with a matching manifest stays unclaimed", () => {
      const model = modelOf({ projects: { declared: [{ root: "apps/a" }] } });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["apps/a/x.go", "vendor/thing/package.json", "vendor/thing/index.js"],
        readFile: filesOf({ "vendor/thing/package.json": JSON.stringify({ name: "vendored" }) }),
        model,
      });
      expect(projects.map((p) => p.root)).toEqual(["apps/a"]);
    });

    it("leaves a vendored manifest's source file unclaimed — a coverage failure, not a project", () => {
      const model = modelOf({ projects: { declared: [{ root: "apps/a" }] } });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["apps/a/x.go", "vendor/thing/package.json", "vendor/thing/index.js"],
        readFile: filesOf({ "vendor/thing/package.json": JSON.stringify({ name: "vendored" }) }),
        model,
      });
      const rootByFile = (file) => projects.find((p) => file.startsWith(`${p.root}/`))?.root;
      const coverage = judgeCoverage({
        files: ["apps/a/x.go", "vendor/thing/index.js"],
        projectOf: rootByFile,
        exempt: [],
      });
      expect(coverage.unclaimed).toEqual(["vendor/thing/index.js"]);
      expect(coverage.failures).toHaveLength(1);
      expect(coverage.failures[0].sourceFile).toBe("vendor/thing/index.js");
    });
  });

  // The default anchor-exclusion policy (issue #371): a tracked manifest in a
  // directory that is data ABOUT the workspace — documentation, test
  // fixtures — must not anchor a phantom project the boundary rules then
  // judge as real. `./model.mjs`'s `DEFAULT_INFER_EXCLUDE` owns the set;
  // these tests pin both directions it exists to hold.
  describe("default anchor exclusions", () => {
    // Silent-direction: before the default set, this exact tree silently
    // grew phantom projects rooted at `docs/fixtures/example` and
    // `tests/fixtures/go-lib`, named and judged like production code.
    it("does not anchor a project on a tracked manifest inside docs/ or fixtures/ paths", () => {
      const model = modelOf({ projects: { declared: [{ root: "apps/a" }], infer: {} } });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: [
          "apps/a/x.go",
          "docs/fixtures/example/package.json",
          "tests/fixtures/go-lib/go.mod",
          "libs/b/__fixtures__/kotlin-embed/settings.gradle",
        ],
        readFile: filesOf({
          "docs/fixtures/example/package.json": JSON.stringify({ name: "example-app" }),
          "tests/fixtures/go-lib/go.mod": "module example.com/go-lib\n",
          "libs/b/__fixtures__/kotlin-embed/settings.gradle": "",
        }),
        model,
      });
      expect(projects.map((p) => p.root)).toEqual(["apps/a"]);
    });

    // The loudness half of the policy: dropping the anchor must not drop the
    // FILES. A fixture's analyzable sources surface through `judgeCoverage`
    // as unclaimed — the same channel the vendored-manifest case rides —
    // until the workspace records a reasoned `coverage.exempt` row for them.
    // Before the default set, the phantom project silently owned them.
    it("leaves a fixture's analyzable files as loud unclaimed coverage, not silently owned", () => {
      const model = modelOf({ projects: { declared: [{ root: "apps/a" }] } });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: [
          "apps/a/x.go",
          "docs/fixtures/example/package.json",
          "docs/fixtures/example/main.go",
        ],
        readFile: filesOf({
          "docs/fixtures/example/package.json": JSON.stringify({ name: "example-app" }),
        }),
        model,
      });
      // Attribution the way `./index.mjs`'s discover does it: a file belongs
      // to the project whose root contains it — and no discovered project
      // contains the fixture's files once its anchor is excluded.
      const rootByFile = (file) => projects.find((p) => file.startsWith(`${p.root}/`))?.root;
      const coverage = judgeCoverage({
        files: ["apps/a/x.go", "docs/fixtures/example/main.go"],
        projectOf: rootByFile,
        exempt: [],
      });
      expect(coverage.unclaimed).toEqual(["docs/fixtures/example/main.go"]);
      expect(coverage.failures).toHaveLength(1);
      expect(coverage.failures[0].sourceFile).toBe("docs/fixtures/example/main.go");
    });

    // `projects.declared` is the authoritative channel and never subject to
    // inference's exclusions: a workspace with a REAL project under docs/
    // declares it, and the default set must not eat the declaration.
    it("still discovers a declared project rooted under an excluded default path", () => {
      const model = modelOf({
        projects: { declared: [{ root: "docs/website", name: "docs-site" }], infer: {} },
      });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["docs/website/package.json", "docs/website/index.js"],
        readFile: filesOf({
          "docs/website/package.json": JSON.stringify({ name: "ignored-by-declaration" }),
        }),
        model,
      });
      expect(
        projects.map((p) => {
          return p.name;
        }),
      ).toEqual(["docs-site"]);
      expect(projects[0].root).toBe("docs/website");
    });

    // An explicit `exclude` list REPLACES the default (the `tsc` convention
    // for the same field) — `exclude: []` is the documented opt-out, and it
    // means it: the phantom comes back, because the workspace said so.
    it("anchors a fixture-shaped manifest again when the workspace opts out with exclude: []", () => {
      const model = modelOf({ projects: { declared: [], infer: { exclude: [] } } });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["docs/fixtures/example/package.json"],
        readFile: filesOf({
          "docs/fixtures/example/package.json": JSON.stringify({ name: "example-app" }),
        }),
        model,
      });
      expect(projects.map((p) => p.root)).toEqual(["docs/fixtures/example"]);
    });

    // The set matches whole path segments: `my-docs` and `test-fixtures` are
    // different segments, and a real project living under either anchors —
    // the same over-broad-by-name error the obj/bin half of this issue
    // repudiated, refused here before it can be made.
    it("matches whole segments only — my-docs and test-fixtures are not excluded", () => {
      const model = modelOf({ projects: { declared: [], infer: {} } });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["my-docs/tool/package.json", "test-fixtures/go-lib/go.mod"],
        readFile: filesOf({
          "my-docs/tool/package.json": JSON.stringify({ name: "doc-tool" }),
          "test-fixtures/go-lib/go.mod": "module example.com/lib\n",
        }),
        model,
      });
      expect(projects.map((p) => p.root).sort()).toEqual(["my-docs/tool", "test-fixtures/go-lib"]);
    });

    // `testdata/` is NOT in the default set — a manifest there anchors a
    // project by default. This is the baseline the extension feature builds
    // on: a workspace that calls its fixture directories `testdata/` sees a
    // phantom until it extends the guard.
    it("anchors a project on testdata/ by default — the name is not in the default set", () => {
      const model = modelOf({ projects: { declared: [], infer: {} } });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["libs/a/testdata/fixture/package.json"],
        readFile: filesOf({
          "libs/a/testdata/fixture/package.json": JSON.stringify({ name: "test-phantom" }),
        }),
        model,
      });
      expect(projects.map((p) => p.root)).toEqual(["libs/a/testdata/fixture"]);
    });

    // The extension surface: `excludeBeyondDefaults` adds patterns to the
    // default set without restating it, so a workspace with `testdata/`
    // directories can guard them without copying the three defaults by hand.
    it("does not anchor a project on testdata/ when excludeBeyondDefaults lists it", () => {
      const model = modelOf({
        projects: {
          declared: [{ root: "apps/a" }],
          infer: { excludeBeyondDefaults: ["**/testdata/**"] },
        },
      });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: [
          "apps/a/x.go",
          "libs/a/testdata/fixture/package.json",
          // The defaults still apply alongside the extras.
          "docs/fixtures/example/package.json",
        ],
        readFile: filesOf({
          "libs/a/testdata/fixture/package.json": JSON.stringify({ name: "test-phantom" }),
          "docs/fixtures/example/package.json": JSON.stringify({ name: "docs-phantom" }),
        }),
        model,
      });
      expect(projects.map((p) => p.root)).toEqual(["apps/a"]);
    });

    // Silent-direction guard: if the merge between `excludeBeyondDefaults`
    // and the defaults stopped working, the testdata manifest would anchor a
    // phantom project again — the same silent false-positive #371 closed.
    // `projects.declared` is still exempt (the test above already pins that
    // the default set does not eat declarations; the same applies here).
    it("leaves a testdata fixture's analyzable files as loud unclaimed coverage, not silently owned", () => {
      const model = modelOf({
        projects: {
          declared: [{ root: "apps/a" }],
          infer: { excludeBeyondDefaults: ["**/testdata/**"] },
        },
      });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: [
          "apps/a/x.go",
          "libs/a/testdata/fixture/package.json",
          "libs/a/testdata/fixture/main.go",
        ],
        readFile: filesOf({
          "libs/a/testdata/fixture/package.json": JSON.stringify({ name: "test-phantom" }),
        }),
        model,
      });
      expect(projects.map((p) => p.root)).toEqual(["apps/a"]);
      const rootByFile = (file) => projects.find((p) => file.startsWith(`${p.root}/`))?.root;
      const coverage = judgeCoverage({
        files: ["libs/a/testdata/fixture/main.go"],
        projectOf: rootByFile,
        exempt: [],
      });
      expect(coverage.unclaimed).toEqual(["libs/a/testdata/fixture/main.go"]);
      expect(coverage.failures).toHaveLength(1);
      expect(coverage.failures[0].sourceFile).toBe("libs/a/testdata/fixture/main.go");
    });
  });

  describe("name collisions", () => {
    it("throws when two different roots resolve to the same project name", () => {
      const model = modelOf({
        projects: { declared: [{ root: "apps/a", name: "shared" }], infer: {} },
      });
      expect(() =>
        discoverNativeProjects({
          root: "/repo",
          files: ["apps/a/x.go", "libs/b/package.json"],
          readFile: filesOf({ "libs/b/package.json": JSON.stringify({ name: "shared" }) }),
          model,
        }),
      ).toThrow(/'shared' names both/);
    });

    // The design spec's own check: on the happy path, an accidental overwrite
    // cannot pass unnoticed, because the project count and the name-set size
    // must agree.
    it("never lets one name silently overwrite another on the happy path", () => {
      const model = modelOf({
        projects: {
          declared: [
            { root: "apps/a", name: "a" },
            { root: "apps/b", name: "b" },
          ],
        },
      });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["apps/a/x.go", "apps/b/y.go"],
        readFile: filesOf({}),
        model,
      });
      expect(new Set(projects.map((p) => p.name)).size).toBe(projects.length);
    });
  });

  // Silent-direction: a projectRules row matching nothing must not read as "no
  // tags apply, clean run" — it has to throw, because a rule with a typo'd
  // glob is a defect in the model, not an empty but valid constraint.
  it("throws when a projectRules row matches no discovered project", () => {
    const model = modelOf({
      projects: { declared: [{ root: "apps/a" }] },
      projectRules: [{ match: "libs/**", tags: ["layer:util"] }],
    });
    expect(() =>
      discoverNativeProjects({
        root: "/repo",
        files: ["apps/a/x.go"],
        readFile: filesOf({}),
        model,
      }),
    ).toThrow(/projectRules\[0\]: 'libs\/\*\*' matches no discovered project/);
  });

  it("throws when the workspace describes zero projects", () => {
    const model = modelOf();
    expect(() =>
      discoverNativeProjects({ root: "/repo", files: ["README.md"], readFile: filesOf({}), model }),
    ).toThrow(/this workspace describes zero projects/);
  });

  describe("tag union", () => {
    it("unions tags from the declared row, project.json, and a matching rule, deduplicated", () => {
      const model = modelOf({
        projects: { declared: [{ root: "apps/a", tags: ["a", "shared"] }] },
        projectRules: [{ match: "apps/**", tags: ["c", "shared"] }],
      });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["apps/a/project.json"],
        readFile: filesOf({ "apps/a/project.json": JSON.stringify({ tags: ["b", "shared"] }) }),
        model,
      });
      expect(projects[0].tags).toEqual(["a", "b", "c", "shared"]);
      expect(projects[0].tagOrigins.a).toEqual(["declared"]);
      expect(projects[0].tagOrigins.b).toEqual(["project.json"]);
      expect(projects[0].tagOrigins.c).toEqual(["projectRules[0]"]);
      expect(projects[0].tagOrigins.shared.sort()).toEqual(
        ["declared", "project.json", "projectRules[0]"].sort(),
      );
    });

    // A tag is workspace TEXT — `projects.declared[].tags`, a `projectRules`
    // row, a tracked `project.json` — so a pull request can name one after any
    // member of `Object.prototype`. The origin map was a plain `{}`, and
    // `(tagOrigins[tag] ??= new Set()).add(origin)` then found the inherited
    // member instead of `undefined`, kept it, and called `.add` on it:
    // measured, `TypeError: tagOrigins[tag].add is not a function`, printed
    // verbatim with no `archkeep:` prefix, no file and no row, on the exit-3
    // path.
    //
    // The assertion that matters is the one on `tags`, not the one on
    // "does not throw". The near miss is worse than the bug: writing the key
    // onto a plain object repoints that object's prototype, so
    // `Object.keys(tagOrigins)` returns `[]` for it and the tag VANISHES from
    // the project's tag list — a project silently carrying one fewer tag than
    // it declared, which is every tag-keyed rule (`../../rules/tags.mjs`)
    // quietly not applying to it. A test that only checked for the absence of a
    // throw would pass that "fix".
    it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
      "keeps a tag literally named %s, with its origin, instead of crashing or losing it",
      (tag) => {
        const model = modelOf({
          projects: { declared: [{ root: "apps/a", tags: [tag, "real"] }] },
          projectRules: [{ match: "apps/**", tags: [tag] }],
        });
        const { projects } = discoverNativeProjects({
          root: "/repo",
          files: ["apps/a/x.go"],
          readFile: filesOf({}),
          model,
        });
        // In the sorted tag list, exactly like any other spelling — this is the
        // assertion a plain-assignment "fix" fails.
        expect(projects[0].tags).toEqual([tag, "real"].sort());
        // And a real own entry in the provenance map, carrying BOTH origins:
        // `Object.prototype.hasOwnProperty` is the direct proof of an own
        // property as distinct from an inherited one.
        expect(Object.prototype.hasOwnProperty.call(projects[0].tagOrigins, tag)).toBe(true);
        expect(Object.keys(projects[0].tagOrigins).sort()).toEqual([tag, "real"].sort());
        expect(projects[0].tagOrigins[tag].sort()).toEqual(["declared", "projectRules[0]"]);
        expect(projects[0].tagOrigins.real).toEqual(["declared"]);
      },
    );

    // "tags / rules": two different rows matching the same project, each
    // contributing a different tag — both must land, not just the last row
    // evaluated.
    it("applies tags from every matching projectRules row, not just one", () => {
      const model = modelOf({
        projects: { declared: [{ root: "apps/a" }] },
        projectRules: [
          { match: "apps/**", tags: ["scope:apps"] },
          { match: "apps/a", tags: ["team:checkout"] },
        ],
      });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["apps/a/x.go"],
        readFile: filesOf({}),
        model,
      });
      expect(projects[0].tags).toEqual(["scope:apps", "team:checkout"]);
    });
  });

  describe("type resolution order", () => {
    it("prefers a declared type over a matching rule's type and the manifest fallback", () => {
      const model = modelOf({
        projects: { declared: [{ root: "apps/a", type: "lib" }] },
        projectRules: [{ match: "apps/**", type: "app" }],
      });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["apps/a/project.json"],
        readFile: filesOf({
          "apps/a/project.json": JSON.stringify({ projectType: "application" }),
        }),
        model,
      });
      expect(projects[0].type).toBe("lib");
    });

    it("prefers a matching rule's type over the manifest-derived fallback", () => {
      const model = modelOf({
        projects: { declared: [{ root: "apps/a" }] },
        projectRules: [{ match: "apps/**", type: "e2e" }],
      });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["apps/a/project.json"],
        readFile: filesOf({
          "apps/a/project.json": JSON.stringify({ projectType: "application" }),
        }),
        model,
      });
      expect(projects[0].type).toBe("e2e");
    });

    it("falls back to nodeTypeOf's manifest-based answer when nothing else states a type", () => {
      const model = modelOf({ projects: { declared: [{ root: "apps/a" }] } });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["apps/a/project.json"],
        readFile: filesOf({
          "apps/a/project.json": JSON.stringify({ projectType: "application" }),
        }),
        model,
      });
      expect(projects[0].type).toBe("app");
    });
  });

  it("unions implicitDependencies from the declared row and the project's own project.json", () => {
    const model = modelOf({
      projects: { declared: [{ root: "apps/a", implicitDependencies: ["shared", "x"] }] },
    });
    const { projects } = discoverNativeProjects({
      root: "/repo",
      files: ["apps/a/project.json"],
      readFile: filesOf({
        "apps/a/project.json": JSON.stringify({ implicitDependencies: ["y", "shared"] }),
      }),
      model,
    });
    expect([...projects[0].implicitDependencies].sort()).toEqual(["shared", "x", "y"]);
  });

  // "discovery / bad manifest" (B3): the project still exists even when its
  // project.json will not parse — but that parse failure must not vanish
  // either. The silent-direction bug this pins against: a bare `JSON.parse`
  // swallowed in a `catch { return undefined }` cost the project every field
  // its manifest would have carried (`tags`, `type`, `implicitDependencies`)
  // with NOTHING anywhere naming why — indistinguishable from a project that
  // legitimately declares none of them. `readProjectManifest` now surfaces
  // the parse failure as a `fileFailure`, which `../../../cli.mjs`'s existing
  // exit-3 path already turns into a loud, non-zero exit once it reaches
  // `DiscoveredWorkspace.failures` (`./index.mjs`'s `discover`).
  it("keeps a declared project whose project.json is unparseable, and surfaces the parse failure loudly", () => {
    const model = modelOf({ projects: { declared: [{ root: "apps/a" }] } });
    const { projects, failures } = discoverNativeProjects({
      root: "/repo",
      files: ["apps/a/project.json"],
      readFile: filesOf({ "apps/a/project.json": "{not json" }),
      model,
    });
    expect(projects).toHaveLength(1);
    expect(projects[0].root).toBe("apps/a");
    expect(projects[0].name).toBe("a");
    expect(projects[0].tags).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0].sourceFile).toBe("apps/a/project.json");
    expect(failures[0].line).toBeNull();
  });

  // JSONC forms Nx itself accepts (a trailing comma, a `//` comment) must not
  // cost a project its manifest fields either — `readProjectManifest` reads
  // through `../../nx-json.mjs`'s `parseNxJson`, the same reader every other
  // config in this package trusts, rather than a bare `JSON.parse`.
  it("reads a project.json with a trailing comma, the same JSONC form Nx itself accepts", () => {
    const model = modelOf({ projects: { declared: [{ root: "apps/a" }] } });
    const { projects, failures } = discoverNativeProjects({
      root: "/repo",
      files: ["apps/a/project.json"],
      readFile: filesOf({
        "apps/a/project.json": '{\n  "name": "a",\n  "tags": ["scope:a"],\n}\n',
      }),
      model,
    });
    expect(failures).toEqual([]);
    expect(projects[0].tags).toEqual(["scope:a"]);
  });

  // The `package.json` half of the same fix, in `readPackageName`: it used to
  // read with a bare `JSON.parse`, so a JSONC `package.json` — a form Nx
  // itself accepts (measured against the installed `nx`,
  // `dist/plugins/package-json.js`'s `createNodeFromPackageJson`) — silently
  // lost its `name` and fell through to the directory basename instead,
  // naming the project differently than Nx would for a config Nx reads fine.
  it("reads a package.json with a trailing comma, the same JSONC form Nx itself accepts", () => {
    const model = modelOf({ projects: { declared: [], infer: {} } });
    const { projects, failures } = discoverNativeProjects({
      root: "/repo",
      files: ["libs/a/package.json"],
      readFile: filesOf({
        "libs/a/package.json": '{\n  "name": "from-package-json",\n}\n',
      }),
      model,
    });
    expect(failures).toEqual([]);
    expect(projects.map((p) => p.name)).toEqual(["from-package-json"]);
  });

  // Silent-direction: an unparseable `package.json` must not quietly fall
  // back to the directory basename — that would cost the project its real
  // identity (an import that targets it by name resolves as external rather
  // than cross-project) with nothing anywhere naming why. It must surface as
  // a `fileFailure`, the same as an unparseable `project.json` does above.
  it("keeps a declared project whose package.json is unparseable, and surfaces the parse failure loudly", () => {
    const model = modelOf({ projects: { declared: [{ root: "apps/a" }] } });
    const { projects, failures } = discoverNativeProjects({
      root: "/repo",
      files: ["apps/a/package.json"],
      readFile: filesOf({ "apps/a/package.json": "{not json" }),
      model,
    });
    expect(projects).toHaveLength(1);
    expect(projects[0].root).toBe("apps/a");
    // No project.json and an unparseable package.json: the name falls all
    // the way to the directory basename, but the parse failure is still
    // reported — the basename fallback and a silently-swallowed parse error
    // are not the same outcome.
    expect(projects[0].name).toBe("a");
    expect(failures).toHaveLength(1);
    expect(failures[0].sourceFile).toBe("apps/a/package.json");
    expect(failures[0].line).toBeNull();
  });

  // "discovery / nesting": a crate nested inside another project's directory
  // is still its own project when declared, and the deeper root is the longer
  // string — the fact a later longest-prefix `projectOf` lookup depends on to
  // attribute a file to the crate rather than the outer app.
  it("discovers a project nested inside another project's declared root", () => {
    const model = modelOf({
      projects: {
        declared: [{ root: "apps/a" }, { root: "apps/a/src-tauri" }],
      },
    });
    const { projects } = discoverNativeProjects({
      root: "/repo",
      files: ["apps/a/index.ts", "apps/a/src-tauri/Cargo.toml"],
      readFile: filesOf({}),
      model,
    });
    const roots = projects.map((p) => p.root).sort();
    expect(roots).toEqual(["apps/a", "apps/a/src-tauri"]);
    expect(roots[1].length).toBeGreaterThan(roots[0].length);
  });

  // B4 (discovery half): a manifest-sourced implicitDependencies entry gets
  // the same pattern check a declared row's own list already gets in
  // `./model.mjs`. Before this fix, an invalid pattern here reached
  // `./graph.mjs`'s `buildDependencies`, whose own `catch {}` drops the edge
  // in silence — a workspace with a typo'd `project.json` pattern would read
  // exactly like one with no such implicit dependency at all.
  it("throws when a project.json's implicitDependencies entry is a pattern the matcher rejects", () => {
    const model = modelOf({ projects: { declared: [{ root: "apps/a" }] } });
    expect(() =>
      discoverNativeProjects({
        root: "/repo",
        files: ["apps/a/project.json"],
        readFile: filesOf({
          "apps/a/project.json": JSON.stringify({ implicitDependencies: ["libs/*"] }),
        }),
        model,
      }),
    ).toThrow(/implicitDependencies entry 'libs\/\*'/);
  });

  // S1: two `projectRules` rows that both match a project but disagree on its
  // `type` used to resolve by `.find()` — first match silently wins, so
  // reordering the two rows in `archkeep.json` (a change that touches nothing
  // about the tree itself) could flip a project's type and, with it, which
  // import-ban rules apply to it. Spec D6 makes the disagreement itself the
  // fatal defect, so no ordering can produce a silently different verdict.
  describe("conflicting projectRules[].type for the same project", () => {
    it("throws naming both rows, rather than letting the first-listed row silently win", () => {
      const model = modelOf({
        projects: { declared: [{ root: "apps/a" }] },
        projectRules: [
          { match: "apps/**", type: "app" },
          { match: "apps/a", type: "lib" },
        ],
      });
      expect(() =>
        discoverNativeProjects({
          root: "/repo",
          files: ["apps/a/x.go"],
          readFile: filesOf({}),
          model,
        }),
      ).toThrow(/projectRules: \[0\], \[1\] disagree on 'apps\/a's type/);
    });

    it("throws the same way regardless of which row is listed first", () => {
      const model = modelOf({
        projects: { declared: [{ root: "apps/a" }] },
        projectRules: [
          { match: "apps/a", type: "lib" },
          { match: "apps/**", type: "app" },
        ],
      });
      expect(() =>
        discoverNativeProjects({
          root: "/repo",
          files: ["apps/a/x.go"],
          readFile: filesOf({}),
          model,
        }),
      ).toThrow(/projectRules: \[0\], \[1\] disagree/);
    });

    it("does not throw when every matching row agrees on the type — a tie is not a conflict", () => {
      const model = modelOf({
        projects: { declared: [{ root: "apps/a" }] },
        projectRules: [
          { match: "apps/**", type: "lib" },
          { match: "apps/a", type: "lib" },
        ],
      });
      const { projects } = discoverNativeProjects({
        root: "/repo",
        files: ["apps/a/x.go"],
        readFile: filesOf({}),
        model,
      });
      expect(projects[0].type).toBe("lib");
    });
  });

  // S4 (discovery half): `hasFile` used to accept a tracked FILE sharing its
  // exact path with a declared root — `file === declaredRoot` — so a
  // `README.md` sitting where `apps/ghost` names a project would validate a
  // root backed by nothing but a document. Only strict directory containment
  // (`file.startsWith(`${root}/`)`) counts.
  it("still throws on a declared root backed only by a tracked file of the exact same name, not a directory", () => {
    const model = modelOf({ projects: { declared: [{ root: "apps/ghost" }] } });
    expect(() =>
      discoverNativeProjects({
        root: "/repo",
        // A tracked file literally named "apps/ghost" — not "apps/ghost/…" —
        // must not be read as a directory backing the declared root.
        files: ["apps/ghost"],
        readFile: filesOf({}),
        model,
      }),
    ).toThrow(/projects\.declared: root 'apps\/ghost' has no tracked file under it/);
  });

  // S5: a declared row's `targets` names pass straight through to the
  // resolved project, unaffected by anything a real `project.json` states —
  // `archkeep.json` is this provider's only source for the fact "does this
  // project have a build target", the same way it is for `type` and `tags`.
  it("carries a declared row's targets through to the resolved project", () => {
    const model = modelOf({
      projects: { declared: [{ root: "apps/a", targets: ["build"] }] },
    });
    const { projects } = discoverNativeProjects({
      root: "/repo",
      files: ["apps/a/x.go"],
      readFile: filesOf({}),
      model,
    });
    expect(projects[0].targets).toEqual(["build"]);
  });

  it("defaults targets to an empty list when the declared row states none", () => {
    const model = modelOf({ projects: { declared: [{ root: "apps/a" }] } });
    const { projects } = discoverNativeProjects({
      root: "/repo",
      files: ["apps/a/x.go"],
      readFile: filesOf({}),
      model,
    });
    expect(projects[0].targets).toEqual([]);
  });
});

describe("maven inference (pom.xml in the default manifest list)", () => {
  const reactor = {
    "apps/api/pom.xml": "<project><artifactId>api</artifactId></project>",
    "libs/core/pom.xml": "<project><artifactId>core</artifactId></project>",
  };

  it("discovers a project per tracked pom.xml, named by directory basename", () => {
    // The same rule go.mod and Cargo.toml follow: the manifest anchors the
    // project, but never NAMES it — basename unless declared otherwise.
    const model = modelOf({ projects: { declared: [], infer: {} } });
    const { projects } = discoverNativeProjects({
      root: "/repo",
      files: Object.keys(reactor),
      readFile: filesOf(reactor),
      model,
    });
    expect(projects.map((project) => project.name).sort()).toEqual(["api", "core"]);
  });

  it("lets a declared row rename a pom-anchored project", () => {
    const model = modelOf({
      projects: { declared: [{ root: "apps/api", name: "http-api", tags: ["scope:public"] }] },
    });
    const { projects } = discoverNativeProjects({
      root: "/repo",
      files: Object.keys(reactor),
      readFile: filesOf(reactor),
      model,
    });
    const api = projects.find((project) => project.name === "http-api");
    expect(api.root).toBe("apps/api");
    expect(api.tags).toEqual(["scope:public"]);
  });

  it("infers no pom project when inference is restricted to another manifest", () => {
    // Restricting `manifests` to go.mod leaves the reactor unmodeled, which
    // is the designed loud zero-project state — discovery refuses rather
    // than describing a workspace it found nothing in.
    const model = modelOf({ projects: { declared: [], infer: { manifests: ["go.mod"] } } });
    expect(() =>
      discoverNativeProjects({
        root: "/repo",
        files: Object.keys(reactor),
        readFile: filesOf(reactor),
        model,
      }),
    ).toThrow(/zero projects/);
  });

  it("ignores target/ build output because it is untracked, like every manifest", () => {
    const model = modelOf({ projects: { declared: [], infer: {} } });
    const { projects } = discoverNativeProjects({
      root: "/repo",
      files: ["apps/api/pom.xml"],
      readFile: filesOf(reactor),
      model,
    });
    expect(projects.map((project) => project.root)).toEqual(["apps/api"]);
  });
});

describe("dotnet inference (*.csproj in the default manifest list)", () => {
  const tree = {
    "apps/api/Api.csproj": '<Project Sdk="Microsoft.NET.Sdk"></Project>',
    "libs/core/Core.csproj": '<Project Sdk="Microsoft.NET.Sdk"></Project>',
  };

  it("discovers a project per tracked .csproj, named by directory basename", () => {
    // The same rule go.mod and pom.xml follow: the manifest anchors the
    // project, but never NAMES it — basename unless declared otherwise.
    const model = modelOf({ projects: { declared: [], infer: {} } });
    const { projects } = discoverNativeProjects({
      root: "/repo",
      files: Object.keys(tree),
      readFile: filesOf(tree),
      model,
    });
    expect(projects.map((project) => project.name).sort()).toEqual(["api", "core"]);
  });

  it("never anchors a project on generated obj/ output, even when tracked", () => {
    // ADR 0006, Decision 2: build output is not a project. Without the
    // guard this tree would grow a phantom rooted at apps/api/obj.
    const model = modelOf({ projects: { declared: [], infer: {} } });
    const { projects } = discoverNativeProjects({
      root: "/repo",
      files: [...Object.keys(tree), "apps/api/obj/Api.generated.csproj"],
      readFile: filesOf({ ...tree, "apps/api/obj/Api.generated.csproj": "<Project />" }),
      model,
    });
    expect(projects.map((project) => project.root).sort()).toEqual(["apps/api", "libs/core"]);
  });

  // Issue #371's over-broad half: the exclusion used to fire on the NAME
  // `bin`/`obj` alone, so a legitimate project rooted under either was
  // silently absent from the model — byte-for-byte identical to a workspace
  // that never had it. Role-based judgment needs the owning `.csproj` beside
  // the segment (`./discover.mjs`'s `isDotnetGeneratedOutput`); with no owner
  // above it there is no evidence of build output, and anchoring is the loud
  // direction — a project that appears and can be inspected beats one that
  // silently never existed.
  it("anchors a legitimate .csproj under a directory merely NAMED bin or obj", () => {
    const model = modelOf({ projects: { declared: [], infer: {} } });
    const { projects } = discoverNativeProjects({
      root: "/repo",
      files: ["tools/bin/Cli.csproj", "libs/obj/Core.csproj"],
      readFile: filesOf({
        "tools/bin/Cli.csproj": "<Project />",
        "libs/obj/Core.csproj": "<Project />",
      }),
      model,
    });
    expect(projects.map((project) => project.root).sort()).toEqual(["libs/obj", "tools/bin"]);
  });

  // The same role signal holds at depth: MSBuild writes intermediate output
  // under per-configuration subdirectories (`obj/Debug/net8.0/…`), and the
  // owning manifest sits above the whole `obj` segment, not beside the file.
  it("never anchors generated output nested below an owned obj/ segment", () => {
    const model = modelOf({ projects: { declared: [], infer: {} } });
    const { projects } = discoverNativeProjects({
      root: "/repo",
      files: [...Object.keys(tree), "apps/api/obj/Debug/net8.0/Api.generated.csproj"],
      readFile: filesOf({
        ...tree,
        "apps/api/obj/Debug/net8.0/Api.generated.csproj": "<Project />",
      }),
      model,
    });
    expect(projects.map((project) => project.root).sort()).toEqual(["apps/api", "libs/core"]);
  });

  it("never anchors a project on generated bin/ output beside its owning .csproj", () => {
    const model = modelOf({ projects: { declared: [], infer: {} } });
    const { projects } = discoverNativeProjects({
      root: "/repo",
      files: [...Object.keys(tree), "apps/api/bin/Api.generated.csproj"],
      readFile: filesOf({ ...tree, "apps/api/bin/Api.generated.csproj": "<Project />" }),
      model,
    });
    expect(projects.map((project) => project.root).sort()).toEqual(["apps/api", "libs/core"]);
  });

  it("fails loudly when two .csproj files share one directory, naming both", () => {
    // ADR 0006, Decision 2: both files claim the name inference would
    // derive from that directory, and picking one silently would read the
    // other's references onto it.
    const model = modelOf({ projects: { declared: [], infer: {} } });
    expect(() =>
      discoverNativeProjects({
        root: "/repo",
        files: ["apps/api/Api.csproj", "apps/api/Api.Tests.csproj"],
        readFile: filesOf({
          "apps/api/Api.csproj": "<Project />",
          "apps/api/Api.Tests.csproj": "<Project />",
        }),
        model,
      }),
    ).toThrow(
      /two \.csproj files anchor the same root 'apps\/api'.*Api\.csproj.*Api\.Tests\.csproj/s,
    );
  });

  it("does not flag a pair inference is restricted away from", () => {
    // The guard judges exactly the files inference would anchor: a pair
    // under a manifest list without *.csproj is the declared list's
    // business, not an ambiguity.
    const model = modelOf({ projects: { declared: [], infer: { manifests: ["go.mod"] } } });
    expect(() =>
      discoverNativeProjects({
        root: "/repo",
        files: ["apps/api/Api.csproj", "apps/api/Api.Tests.csproj"],
        readFile: filesOf({}),
        model,
      }),
    ).toThrow(/zero projects/);
  });
});

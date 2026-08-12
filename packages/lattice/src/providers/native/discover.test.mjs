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
  // claimed by a phantom project nobody in `lattice.json` asked to include,
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
  // reordering the two rows in `lattice.json` (a change that touches nothing
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
  // `lattice.json` is this provider's only source for the fact "does this
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

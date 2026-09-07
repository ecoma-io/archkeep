/**
 * The static Nx acquisition's own tests — moved here with the code when
 * `../lsp/workspace-index.mjs`'s private discovery collapsed into the provider
 * seam, because a provider's contract is tested beside the provider.
 *
 * `nodeTypeOf` is NOT re-tested here: `./native/discover.test.mjs` already
 * pins it (the `-e2e` suffix rule, the `lib` fallback), and a second copy of
 * those assertions is a second copy that drifts.
 */
import { describe, expect, it } from "vitest";

import { PROJECT_CONFIG_FILE } from "./native/discover.mjs";
import { buildNodes, discoverProjects } from "./nx-static.mjs";

/** A tree as discovery reads one: a file list and a reader. */
function tree(files) {
  return {
    files: Object.keys(files),
    readFile: (path) => files[path] ?? null,
  };
}

describe("discovering the projects a tree declares", () => {
  it("takes the name a project states, then its package, then its directory", () => {
    // Nx's own precedence. Guessing a different name would attribute every one
    // of the project's files to a project the graph does not have, and the rule
    // engine throws rather than guess on that (`../rules/index.mjs`).
    const { projects } = discoverProjects(
      tree({
        [`stated/${PROJECT_CONFIG_FILE}`]: '{"name":"stated-name"}',
        [`packaged/${PROJECT_CONFIG_FILE}`]: "{}",
        "packaged/package.json": '{"name":"packaged-name"}',
        [`fallback/${PROJECT_CONFIG_FILE}`]: "{}",
      }),
    );

    expect(projects.map((p) => p.name).sort()).toEqual([
      "fallback",
      "packaged-name",
      "stated-name",
    ]);
    expect(projects.find((p) => p.name === "stated-name").root).toBe("stated");
  });

  it("reads every JSONC form Nx reads, because a project Nx has is a project", () => {
    // Nx parses `project.json` with jsonc-parser and `allowTrailingComma`, so
    // each file below names a project that exists everywhere else in the
    // toolchain — in `nx graph`, in ESLint's view, in `../../cli.mjs`. Dropping
    // one here takes it out of the graph, turns every import of it into an
    // external package, and paints a real crossing clean in the editor while
    // the CLI still fails on it.
    const { projects, skipped } = discoverProjects(
      tree({
        [`trailing-comma/${PROJECT_CONFIG_FILE}`]: '{"name":"trailing-comma","tags":["a"],}',
        [`line-comment/${PROJECT_CONFIG_FILE}`]: '{\n// the near side\n"name":"line-comment"\n}',
        [`block-comment/${PROJECT_CONFIG_FILE}`]: '{/* the far side */"name":"block-comment"}',
      }),
    );

    expect(skipped).toEqual([]);
    expect(projects.map((p) => p.name).sort()).toEqual([
      "block-comment",
      "line-comment",
      "trailing-comma",
    ]);
    expect(projects.find((p) => p.name === "trailing-comma").config.tags).toEqual(["a"]);
  });

  it("takes a package.json name through the same parser project.json goes through", () => {
    // Nx reads both files with `readJsonFile`. A `package.json` this could not
    // parse would silently fall through to the directory name — a project the
    // graph knows under one name and every constraint row names under another.
    const { projects } = discoverProjects(
      tree({
        [`somewhere/${PROJECT_CONFIG_FILE}`]: "{}",
        "somewhere/package.json":
          '{\n// published under a different name\n"name":"@scope/thing"\n}',
      }),
    );

    expect(projects.map((p) => p.name)).toEqual(["@scope/thing"]);
  });

  it("skips a project.json it cannot read instead of blanking the whole graph", () => {
    // One project being edited must not cost the verdict for every other. The
    // skip is reported so the server can say so rather than swallow it.
    const { projects, skipped } = discoverProjects(
      tree({
        [`good/${PROJECT_CONFIG_FILE}`]: '{"name":"good"}',
        [`broken/${PROJECT_CONFIG_FILE}`]: "{ this is not json",
      }),
    );

    expect(projects.map((p) => p.name)).toEqual(["good"]);
    expect(skipped).toEqual([
      { file: `broken/${PROJECT_CONFIG_FILE}`, reason: expect.stringContaining("not valid JSON") },
    ]);
  });

  it("gives a project.json at the tree root the empty root the path lookups expect", () => {
    // `''` is what `normalizeProjectRoot` turns into `'.'` and what
    // `projectOwning` treats as matching everything; `'.'` written here would
    // match no file at all, because no workspace-relative path starts with `./`.
    const { projects } = discoverProjects(tree({ [PROJECT_CONFIG_FILE]: '{"name":"root"}' }));

    expect(projects).toEqual([{ name: "root", root: "", config: { name: "root" } }]);
  });

  it("skips a project.json that is listed but cannot be read", () => {
    // A manifest that vanishes between the git listing and the read is a
    // skipped project, reported — a project silently absent from the graph is
    // the same defect this index exists to refuse.
    const { projects, skipped } = discoverProjects(
      tree({
        [`good/${PROJECT_CONFIG_FILE}`]: '{"name":"good"}',
        [`gone/${PROJECT_CONFIG_FILE}`]: undefined,
      }),
    );
    expect(projects.map((p) => p.name)).toEqual(["good"]);
    expect(skipped).toEqual([{ file: `gone/${PROJECT_CONFIG_FILE}`, reason: "could not be read" }]);
  });

  it("skips a project.json at the root that can end up with no usable name", () => {
    // No stated name, no package.json beside it, and the tree root — the name
    // chain has nothing left to fall back to. Such a project must be skipped
    // and SAID to be skipped, never guessed into the graph under a made-up
    // name.
    const { projects, skipped } = discoverProjects(tree({ [PROJECT_CONFIG_FILE]: "{}" }));
    expect(projects).toEqual([]);
    expect(skipped).toEqual([
      { file: PROJECT_CONFIG_FILE, reason: "declares no usable project name" },
    ]);
  });
});

describe("the nodes a project list becomes", () => {
  it("guarantees a tags array, because the tag rules read it unguarded", () => {
    const { nodes } = buildNodes([
      { name: "untagged", root: "libs/untagged", config: {} },
      { name: "tagged", root: "libs/tagged", config: { tags: ["zone:inner"] } },
    ]);

    expect(nodes.untagged.data.tags).toEqual([]);
    expect(nodes.tagged.data.tags).toEqual(["zone:inner"]);
    expect(nodes.untagged.data.root).toBe("libs/untagged");
  });

  it("detects duplicate project names and records them for loud reporting", () => {
    // Two projects resolving to the same name — the trigger for issue #375.
    // The first project wins; the second is shadowed and its files will match
    // no root, so they must be surfaced loudly rather than silently dropped.
    const { nodes, duplicateProjects } = buildNodes([
      { name: "billing", root: "libs/billing", config: { tags: ["scope:billing"] } },
      { name: "billing", root: "libs/billing-service", config: { tags: ["scope:billing"] } },
      { name: "domain", root: "libs/domain", config: { tags: ["scope:domain"] } },
    ]);

    // Only the first "billing" project is indexed — the duplicate is skipped
    expect(Object.keys(nodes)).toEqual(["billing", "domain"]);
    expect(nodes.billing.data.root).toBe("libs/billing");

    // Both colliding roots are recorded for the diagnostic
    expect(duplicateProjects).toEqual([
      { name: "billing", roots: ["libs/billing", "libs/billing-service"] },
    ]);
  });

  it("handles multiple duplicate name groups separately", () => {
    // Three pairs of projects with duplicate names
    const { nodes, duplicateProjects } = buildNodes([
      { name: "shared-a", root: "libs/a1", config: {} },
      { name: "shared-b", root: "libs/b1", config: {} },
      { name: "shared-a", root: "libs/a2", config: {} },
      { name: "shared-b", root: "libs/b2", config: {} },
      { name: "shared-c", root: "libs/c1", config: {} },
      { name: "shared-c", root: "libs/c2", config: {} },
    ]);

    // First of each group wins
    expect(Object.keys(nodes)).toEqual(["shared-a", "shared-b", "shared-c"]);
    expect(nodes["shared-a"].data.root).toBe("libs/a1");
    expect(nodes["shared-b"].data.root).toBe("libs/b1");
    expect(nodes["shared-c"].data.root).toBe("libs/c1");

    // All three duplicate groups are recorded
    expect(duplicateProjects).toHaveLength(3);
    expect(duplicateProjects).toContainEqual({
      name: "shared-a",
      roots: ["libs/a1", "libs/a2"],
    });
    expect(duplicateProjects).toContainEqual({
      name: "shared-b",
      roots: ["libs/b1", "libs/b2"],
    });
    expect(duplicateProjects).toContainEqual({
      name: "shared-c",
      roots: ["libs/c1", "libs/c2"],
    });
  });

  it("returns empty duplicateProjects when all names are unique", () => {
    const { duplicateProjects } = buildNodes([
      { name: "alpha", root: "libs/alpha", config: {} },
      { name: "beta", root: "libs/beta", config: {} },
      { name: "gamma", root: "libs/gamma", config: {} },
    ]);

    expect(duplicateProjects).toEqual([]);
  });
});

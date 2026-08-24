/**
 * Oracle 2 and Oracle 3: the same workspace, described by more than one
 * `archkeep.json`, must discover to the same projects.
 *
 * Every other test in this directory pins one document to one expected
 * result. This file inverts that: each `describe` block below is a GROUP of
 * documents that describe one physical tree by different means — declaring a
 * project outright, inferring it from a manifest, tagging it through
 * `projectRules` instead of a `tags` field, naming the workspace-root project
 * `''` versus leaving it to `project.json` to supply the name — and the only
 * assertion is that every document in a group normalizes to the SAME
 * discovered project, compared against the other documents in its group
 * rather than against a hand-written expectation. A provider whose declared
 * path and inferred path silently disagreed on a tag or a root spelling would
 * make a native workspace's `check` result depend on which spelling of
 * `archkeep.json` it happened to be reading — the exact drift
 * `../../../../../AGENTS.md`'s invariant rules out.
 *
 * `tagOrigins` is stripped before comparing: two spellings that reach the
 * same tag by different routes (a declared `tags` field vs. a matching
 * `projectRules` row) SHOULD disagree on provenance — that is the one thing
 * `tagOrigins` exists to record — while agreeing on everything the rule
 * engine (`../../rules/`) can actually see, which is tags, not their origin.
 */
import { describe, expect, it } from "vitest";

import { normalizeNativeModel } from "./model.mjs";
import { discoverNativeProjects } from "./discover.mjs";
import { normalizeProjectRoot } from "../../rules/specifiers.mjs";

/** A model with every default applied, so each spelling states only what it bends. */
const modelOf = (raw) => normalizeNativeModel({ projects: { declared: [] }, ...raw });

/** An in-memory `readFile`, backed by a plain path → text map. */
const filesOf = (contents) => (path) => (path in contents ? contents[path] : null);

/** A discovered project list, `tagOrigins` stripped and sorted by name — the
 * shape every spelling in a group is compared by. */
const comparable = (projects) =>
  [...projects]
    .map((project) => {
      const { tagOrigins: _tagOrigins, ...rest } = project;
      return { ...rest, tags: [...rest.tags].sort() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

/** Every document in `spellings` must discover to the identical project list. */
function expectAllEquivalent(spellings) {
  const results = spellings.map(({ files, readFile, model }) =>
    comparable(discoverNativeProjects({ root: "/workspace", files, readFile, model }).projects),
  );
  for (const result of results.slice(1)) {
    expect(result).toEqual(results[0]);
  }
}

describe("declared vs. inferred vs. projectRules-tagged — one project, three spellings", () => {
  const files = ["libs/domain/go.mod", "libs/domain/doc.go"];
  const readFile = filesOf({});

  it("all three discover 'domain' at libs/domain, type lib, tagged layer:domain", () => {
    expectAllEquivalent([
      // (a) fully declared: name, type and tags all stated outright.
      {
        files,
        readFile,
        model: modelOf({
          projects: {
            declared: [
              { root: "libs/domain", name: "domain", type: "lib", tags: ["layer:domain"] },
            ],
          },
        }),
      },
      // (b) fully inferred: go.mod names the project by its directory, and a
      // single projectRules row supplies both the type and the tag.
      {
        files,
        readFile,
        model: modelOf({
          projects: { declared: [], infer: {} },
          projectRules: [{ match: "libs/**", type: "lib", tags: ["layer:domain"] }],
        }),
      },
      // (c) mixed: declared for the name and type, but the tag arrives only
      // through a matching projectRules row rather than a declared field.
      {
        files,
        readFile,
        model: modelOf({
          projects: { declared: [{ root: "libs/domain", name: "domain", type: "lib" }] },
          projectRules: [{ match: "libs/**", tags: ["layer:domain"] }],
        }),
      },
    ]);
  });
});

describe("'' vs. project.json-inferred — the workspace-root project", () => {
  // A project.json at the tree root, present in every spelling below: spelling
  // (b) needs it to name the root project at all (`basenameOf('')` is `''`,
  // an invalid name with nothing else to fall back on), and spelling (a)
  // picking it up too proves the declared row's own tags UNION with the
  // manifest's rather than replacing them — the same union every other
  // project in this provider gets.
  const files = ["project.json"];
  const readFile = filesOf({
    "project.json": JSON.stringify({ name: "root", tags: ["scope:root"] }),
  });

  it("declaring root:'' and leaving it to project.json agree on the same project", () => {
    expectAllEquivalent([
      // (a) the workspace root named and tagged explicitly.
      {
        files,
        readFile,
        model: modelOf({
          projects: { declared: [{ root: "", name: "root", tags: ["scope:root"] }] },
        }),
      },
      // (b) no declared row at all, but projects.infer is present so its
      // default manifest list (which includes project.json) runs — the
      // project's name/tags then carry entirely from the manifest.
      {
        files,
        readFile,
        model: modelOf({ projects: { declared: [], infer: {} } }),
      },
    ]);
  });

  it("normalizes root:'' the same way ../../rules/specifiers.mjs normalizes an Nx workspace-root project", () => {
    const { projects } = discoverNativeProjects({
      root: "/workspace",
      files,
      readFile,
      model: modelOf({ projects: { declared: [], infer: {} } }),
    });
    expect(projects).toHaveLength(1);
    expect(normalizeProjectRoot(projects[0].root)).toBe(".");
  });
});

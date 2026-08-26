import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createDependencies } from "../../nx.mjs";

/**
 * Drives the real plugin entry point over a real filesystem fixture holding
 * a project pair per language — three for Python, one per manifest dialect
 * the resolver reads (uv, Poetry, PDM) — with the exact context shape Nx passes
 * (projects, fileMap.projectFileMap, workspaceRoot). What this pins: the
 * adapter wiring — ctx → resolver contract → raw dependency objects — not
 * the per-language parsing, which the unit tests own.
 *
 * Deliberately reached through `nx.mjs` rather than through the module
 * beside it: what Nx loads is that entry, so an entry that stopped re-exporting
 * `createDependencies` would leave every Go/Rust/Python edge out of the graph
 * while this file, pointed at the implementation, still passed.
 */
describe("createDependencies over a real workspace fixture", () => {
  const root = mkdtempSync(join(tmpdir(), "polyglot-graph-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const write = (rel, text) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };

  // Go pair
  write("go/one/go.mod", "module example.com/one\n\ngo 1.24\n");
  write("go/one/main.go", 'package main\n\nimport "example.com/two/lib"\n');
  write("go/two/go.mod", "module example.com/two\n\ngo 1.24\n");
  write("go/two/lib.go", "package two\n");
  // Rust pair
  write(
    "rs/a/Cargo.toml",
    '[package]\nname = "a"\nversion = "0.1.0"\n\n[dependencies]\nb = { path = "../b" }\n',
  );
  write("rs/b/Cargo.toml", '[package]\nname = "b"\nversion = "0.1.0"\n');
  // Python pair (uv)
  write(
    "py/p/pyproject.toml",
    '[project]\nname = "p"\nversion = "0"\ndependencies = ["q"]\n\n[tool.uv.sources]\nq = { workspace = true }\n',
  );
  write("py/q/pyproject.toml", '[project]\nname = "q"\nversion = "0"\n');
  // Python pair (Poetry path dependency)
  write(
    "py/r/pyproject.toml",
    '[tool.poetry]\nname = "r"\nversion = "0"\n\n[tool.poetry.dependencies]\ns = { path = "../s", develop = true }\n',
  );
  write("py/s/pyproject.toml", '[tool.poetry]\nname = "s"\nversion = "0"\n');
  // Python pair (PDM root-anchored local dependency)
  write(
    "py/t/pyproject.toml",
    '[project]\nname = "t"\nversion = "0"\ndependencies = ["u @ file:///${PROJECT_ROOT}/../u"]\n',
  );
  write("py/u/pyproject.toml", '[project]\nname = "u"\nversion = "0"\n');
  // Java pair, declared through Maven AND imported at source level: both
  // tracks draw their own edge, attributed to different source files.
  write(
    "jvm/lib/pom.xml",
    "<project><groupId>com.acme</groupId><artifactId>lib</artifactId><version>1</version></project>",
  );
  write("jvm/lib/src/main/java/com/acme/lib/Lib.java", "package com.acme.lib;\nclass Lib {}\n");
  write(
    "jvm/app/pom.xml",
    [
      "<project>",
      "  <groupId>com.acme</groupId>",
      "  <artifactId>app</artifactId>",
      "  <dependencies>",
      "    <dependency><groupId>com.acme</groupId><artifactId>lib</artifactId></dependency>",
      "  </dependencies>",
      "</project>",
    ].join("\n"),
  );
  write(
    "jvm/app/src/main/java/com/acme/app/App.java",
    "package com.acme.app;\nimport com.acme.lib.Lib;\nclass App { Lib lib; }\n",
  );

  const context = {
    workspaceRoot: root,
    projects: {
      "go-one": { root: "go/one" },
      "go-two": { root: "go/two" },
      "rs-a": { root: "rs/a" },
      "rs-b": { root: "rs/b" },
      "py-p": { root: "py/p" },
      "py-q": { root: "py/q" },
      "py-r": { root: "py/r" },
      "py-s": { root: "py/s" },
      "py-t": { root: "py/t" },
      "py-u": { root: "py/u" },
      "jvm-lib": { root: "jvm/lib" },
      "jvm-app": { root: "jvm/app" },
    },
    fileMap: {
      projectFileMap: {
        "go-one": [{ file: "go/one/go.mod" }, { file: "go/one/main.go" }],
        "go-two": [{ file: "go/two/go.mod" }, { file: "go/two/lib.go" }],
        "rs-a": [{ file: "rs/a/Cargo.toml" }],
        "rs-b": [{ file: "rs/b/Cargo.toml" }],
        "py-p": [{ file: "py/p/pyproject.toml" }],
        "py-q": [{ file: "py/q/pyproject.toml" }],
        "py-r": [{ file: "py/r/pyproject.toml" }],
        "py-s": [{ file: "py/s/pyproject.toml" }],
        "py-t": [{ file: "py/t/pyproject.toml" }],
        "py-u": [{ file: "py/u/pyproject.toml" }],
        "jvm-lib": [
          { file: "jvm/lib/pom.xml" },
          { file: "jvm/lib/src/main/java/com/acme/lib/Lib.java" },
        ],
        "jvm-app": [
          { file: "jvm/app/pom.xml" },
          { file: "jvm/app/src/main/java/com/acme/app/App.java" },
        ],
      },
    },
  };

  it("returns one static edge per language pair, each attributed to its source file", () => {
    const deps = createDependencies(undefined, context);
    expect(deps).toEqual([
      { source: "go-one", target: "go-two", sourceFile: "go/one/main.go", type: "static" },
      { source: "rs-a", target: "rs-b", sourceFile: "rs/a/Cargo.toml", type: "static" },
      { source: "py-p", target: "py-q", sourceFile: "py/p/pyproject.toml", type: "static" },
      { source: "py-r", target: "py-s", sourceFile: "py/r/pyproject.toml", type: "static" },
      { source: "py-t", target: "py-u", sourceFile: "py/t/pyproject.toml", type: "static" },
      // The two JVM tracks over one pair: the written import AND the pom's
      // declared dependency each draw their own edge — a declared-but-unused
      // dependency and an undeclared-but-imported one are both findings.
      {
        source: "jvm-app",
        target: "jvm-lib",
        sourceFile: "jvm/app/src/main/java/com/acme/app/App.java",
        type: "static",
      },
      { source: "jvm-app", target: "jvm-lib", sourceFile: "jvm/app/pom.xml", type: "static" },
    ]);
  });

  it("returns nothing for a workspace with no polyglot projects", () => {
    const tsOnly = {
      workspaceRoot: root,
      projects: { web: { root: "web" } },
      fileMap: { projectFileMap: { web: [{ file: "web/project.json" }] } },
    };
    expect(createDependencies(undefined, tsOnly)).toEqual([]);
  });

  it("emits one edge per pair even when a manifest declares the same dependency twice", () => {
    // A single Cargo.toml naming `b` in both [dependencies] and
    // [dev-dependencies] resolves to two identical records; the hook
    // dedupes by (source, target, sourceFile) so the output stays canonical.
    const dup = mkdtempSync(join(tmpdir(), "polyglot-graph-dup-"));
    afterAll(() => rmSync(dup, { recursive: true, force: true }));
    mkdirSync(join(dup, "rs/a"), { recursive: true });
    mkdirSync(join(dup, "rs/b"), { recursive: true });
    writeFileSync(
      join(dup, "rs/a/Cargo.toml"),
      [
        '[package]\nname = "a"\nversion = "0.1.0"',
        '[dependencies]\nb = { path = "../b" }',
        '[dev-dependencies]\nb = { path = "../b" }',
      ].join("\n\n"),
      "utf8",
    );
    writeFileSync(
      join(dup, "rs/b/Cargo.toml"),
      '[package]\nname = "b"\nversion = "0.1.0"\n',
      "utf8",
    );

    const deps = createDependencies(undefined, {
      workspaceRoot: dup,
      projects: { "rs-a": { root: "rs/a" }, "rs-b": { root: "rs/b" } },
      fileMap: {
        projectFileMap: {
          "rs-a": [{ file: "rs/a/Cargo.toml" }],
          "rs-b": [{ file: "rs/b/Cargo.toml" }],
        },
      },
    });
    expect(deps).toEqual([
      { source: "rs-a", target: "rs-b", sourceFile: "rs/a/Cargo.toml", type: "static" },
    ]);
  });

  it("still resolves a project whose files are missing from the file map", () => {
    // `context.fileMap?.projectFileMap?.[name] ?? []` — a project absent from
    // the map contributes no files, so no edges of its own, without breaking
    // the projects that ARE listed. Nx always fills the map; the fallback
    // exists so an odd context shape cannot crash every graph computation.
    const { "rs-b": _unlisted, ...rest } = context.fileMap.projectFileMap;
    const deps = createDependencies(undefined, {
      ...context,
      fileMap: { projectFileMap: rest },
    });
    // The rs-b manifest is unlisted, so the Rust project contributes nothing;
    // the Go, Python and JVM edges are drawn from the projects that ARE listed.
    expect(deps).toEqual([
      { source: "go-one", target: "go-two", sourceFile: "go/one/main.go", type: "static" },
      { source: "py-p", target: "py-q", sourceFile: "py/p/pyproject.toml", type: "static" },
      { source: "py-r", target: "py-s", sourceFile: "py/r/pyproject.toml", type: "static" },
      { source: "py-t", target: "py-u", sourceFile: "py/t/pyproject.toml", type: "static" },
      {
        source: "jvm-app",
        target: "jvm-lib",
        sourceFile: "jvm/app/src/main/java/com/acme/app/App.java",
        type: "static",
      },
      { source: "jvm-app", target: "jvm-lib", sourceFile: "jvm/app/pom.xml", type: "static" },
    ]);
  });

  it("draws no edge through a tracked symlink whose realpath leaves the workspace (G-10, plugin read)", () => {
    // Silent direction: every value `readFile` is handed comes from the tree's
    // own `fileMap` — attacker-supplied the moment a PR adds a tracked path. A
    // tracked symlink in that map whose realpath leaves the workspace would
    // feed OUTSIDE bytes to the Go/Rust/Python resolvers, drawing a dependency
    // edge from outside content into `nx affected`'s graph. The RED direction
    // here is a symlinked SOURCE file importing a sibling's module path:
    // followed, the symlink draws a `one -> two` edge from outside bytes;
    // refused, the read is null and no edge is drawn. (The hook cannot exit
    // non-zero by design; dropping the read is the loudest refusal available,
    // and `resolvePolyglotDependencies`'s contract pins null read → no edge.)
    const escape = mkdtempSync(join(tmpdir(), "polyglot-graph-escape-"));
    const outside = mkdtempSync(join(tmpdir(), "polyglot-graph-escape-outside-"));
    afterAll(() => rmSync(escape, { recursive: true, force: true }));
    afterAll(() => rmSync(outside, { recursive: true, force: true }));
    mkdirSync(join(escape, "go/one"), { recursive: true });
    mkdirSync(join(escape, "go/two"), { recursive: true });
    // Two real projects: `one` and its sibling `two` (module `example.com/two`).
    writeFileSync(join(escape, "go/one/go.mod"), "module example.com/one\n\ngo 1.24\n", "utf8");
    writeFileSync(join(escape, "go/two/go.mod"), "module example.com/two\n\ngo 1.24\n", "utf8");
    writeFileSync(join(escape, "go/two/lib.go"), "package two\n", "utf8");
    // The tracked symlink: `go/one/main.go` -> <outside>/main.go, and the
    // outside file imports the SIBLING's module path.
    writeFileSync(
      join(outside, "main.go"),
      'package one\n\nimport "example.com/two"\n\nvar _ = two.Name\n',
      "utf8",
    );
    symlinkSync(join(outside, "main.go"), join(escape, "go/one/main.go"));

    const deps = createDependencies(undefined, {
      workspaceRoot: escape,
      projects: { "go-one": { root: "go/one" }, "go-two": { root: "go/two" } },
      fileMap: {
        projectFileMap: {
          "go-one": [{ file: "go/one/go.mod" }, { file: "go/one/main.go" }],
          "go-two": [{ file: "go/two/go.mod" }, { file: "go/two/lib.go" }],
        },
      },
    });
    // Without the containment check, `go/one/main.go` reads the OUTSIDE
    // bytes, parses `import "example.com/two"`, and draws a `one -> two` edge
    // the workspace never committed. With it, the read is null, the file
    // produces no import, and the edge set is empty — the graph cannot lie
    // about the outside.
    expect(deps).toEqual([]);
  });

  it('draws edges to and from a root project (root "."), through the real plugin entry', () => {
    // `${project.root}/go.mod` for an Nx root project (root ".") built
    // "./go.mod" — matching no tracked file spelled "go.mod", so the root
    // project's module never entered the resolver's map: no edge FROM it
    // (its own imports resolved to nothing) and no edge TO it (nothing else
    // could match its module path either). This drives the real `nx.mjs`
    // entry over a real filesystem fixture, the same shape the unit test in
    // `analysis/go.test.mjs` pins at the resolver level — this one is the
    // tripwire for the adapter wiring around it.
    const rootFixture = mkdtempSync(join(tmpdir(), "polyglot-graph-root-"));
    afterAll(() => rmSync(rootFixture, { recursive: true, force: true }));
    mkdirSync(join(rootFixture, "libs/lib"), { recursive: true });
    writeFileSync(join(rootFixture, "go.mod"), "module example.com/acme/root\n\ngo 1.24\n", "utf8");
    writeFileSync(
      join(rootFixture, "main.go"),
      'package main\n\nimport "example.com/acme/lib"\n',
      "utf8",
    );
    writeFileSync(
      join(rootFixture, "libs/lib/go.mod"),
      "module example.com/acme/lib\n\ngo 1.24\n",
      "utf8",
    );
    writeFileSync(
      join(rootFixture, "libs/lib/pkg.go"),
      'package lib\n\nimport "example.com/acme/root"\n',
      "utf8",
    );

    const deps = createDependencies(undefined, {
      workspaceRoot: rootFixture,
      projects: { root: { root: "." }, lib: { root: "libs/lib" } },
      fileMap: {
        projectFileMap: {
          root: [{ file: "go.mod" }, { file: "main.go" }],
          lib: [{ file: "libs/lib/go.mod" }, { file: "libs/lib/pkg.go" }],
        },
      },
    });
    expect(deps).toEqual([
      { source: "root", target: "lib", sourceFile: "main.go", type: "static" },
      { source: "lib", target: "root", sourceFile: "libs/lib/pkg.go", type: "static" },
    ]);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createDependencies } from "../../index.mjs";

/**
 * Drives the real plugin entry point over a real filesystem fixture holding
 * a project pair per language — three for Python, one per manifest dialect
 * the resolver reads (uv, Poetry, PDM) — with the exact context shape Nx passes
 * (projects, fileMap.projectFileMap, workspaceRoot). What this pins: the
 * adapter wiring — ctx → resolver contract → raw dependency objects — not
 * the per-language parsing, which the unit tests own.
 *
 * Deliberately reached through `index.mjs` rather than through the module
 * beside it: what Nx loads is the entry, so an entry that stopped re-exporting
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
});

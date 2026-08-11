// Tests for verify-vsix.mjs.
//
// `evaluateVsix` takes every fact as an argument — the entry list, both
// manifests, the decision-module list — so these run with no vsix, no zip
// binary and no filesystem. What is deliberately NOT tested is the IO half
// that shells out to unzip: a test that stubbed unzip's answer would pin the
// stub, and the real thing is exercised by CI against the freshly packaged
// vsix on every pull request.
//
// Every check has a case that goes red in the silent direction: a tampered
// archive — the runtime dependency stripped, a decision module dropped, the
// engines floor drifted — must FAIL, because each of those installs cleanly
// and only breaks in the extension host of whoever trusted the green build.

import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateVsix, importedPackages } from "./verify-vsix.mjs";

/** A complete, correct vsix — each test tampers with one copy of this. */
function completeFixture() {
  // Typed as `evaluateVsix` receives it, not as this literal, so a test may
  // drop or replace a key — the tampering is the point of the fixture.
  /** @type {Record<string, any>} */
  const sourceManifest = {
    name: "lattice",
    version: "0.1.0",
    main: "./extension.mjs",
    icon: "icon.png",
    engines: { vscode: "^1.100.0", node: ">=22" },
    dependencies: { "vscode-languageclient": "10.1.0" },
    devDependencies: { "@types/vscode": "1.100.0", "@vscode/vsce": "3.9.2" },
  };
  return {
    entries: [
      "extension.vsixmanifest",
      "[Content_Types].xml",
      "extension/package.json",
      "extension/extension.mjs",
      "extension/icon.png",
      "extension/readme.md",
      "extension/LICENSE.txt",
      "extension/src/languages.mjs",
      "extension/src/status.mjs",
      "extension/node_modules/vscode-languageclient/package.json",
      "extension/node_modules/vscode-languageclient/lib/node/main.js",
      "extension/node_modules/vscode-jsonrpc/package.json",
    ],
    packagedManifest: structuredClone(sourceManifest),
    sourceManifest,
    decisionModules: ["src/languages.mjs", "src/status.mjs"],
    // What the entry point imports, extracted by `importedPackages` in the real
    // run. Only the entry point is scanned: extension.mjs is the one file in
    // the package allowed to import anything external, so its imports ARE the
    // package's runtime requirements.
    entryImports: ["vscode-languageclient"],
  };
}

test("a complete vsix passes, and every check reports what it saw", () => {
  const { lines, failures } = evaluateVsix(completeFixture());
  assert.deepEqual(failures, []);
  // Every line is a stated verdict — a check that ran without saying so would
  // be indistinguishable from a check that was deleted.
  assert.ok(lines.length >= 9);
  assert.ok(lines.every((line) => line.startsWith("ok   ")));
});

test("a vsix without the language client tree FAILS — it activates and dies on first import", () => {
  const fixture = completeFixture();
  fixture.entries = fixture.entries.filter(
    (e) => !e.startsWith("extension/node_modules/vscode-languageclient/"),
  );
  const { failures } = evaluateVsix(fixture);
  // Both dependency checks notice: the entry point's requirement is unmet, and
  // the declared list is not fully packaged.
  assert.equal(failures.length, 2);
  assert.match(failures[0], /vscode-languageclient/);
});

test("a manifest that lost the language client while keeping another dependency FAILS", () => {
  // The cubic P1 on this pull request: the declared-list check iterates the
  // manifest, so a manifest that dropped vscode-languageclient but still
  // declares something else hands it a nonempty list that passes. The
  // entry-import check judges from the code and must catch exactly this.
  const fixture = completeFixture();
  fixture.sourceManifest.dependencies = { "smol-toml": "1.7.1" };
  fixture.packagedManifest.dependencies = { "smol-toml": "1.7.1" };
  fixture.entries = fixture.entries
    .filter((e) => !e.startsWith("extension/node_modules/vscode-languageclient/"))
    .concat(["extension/node_modules/smol-toml/package.json"]);
  const { failures } = evaluateVsix(fixture);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /vscode-languageclient \(declared: false, packaged: false\)/);
});

test("a declared-but-unpackaged entry requirement FAILS and says which half is missing", () => {
  const fixture = completeFixture();
  fixture.entries = fixture.entries.filter(
    (e) => !e.startsWith("extension/node_modules/vscode-languageclient/"),
  );
  const { failures } = evaluateVsix(fixture);
  assert.match(failures[0], /vscode-languageclient \(declared: true, packaged: false\)/);
});

test("a manifest declaring no runtime dependencies FAILS instead of vacuously passing", () => {
  // The declared-list check iterates the manifest; an empty list would make
  // `every` true over nothing. That is the silent direction, so it is a failure
  // — and the entry-import check fails alongside it, because the requirement
  // the code carries is no longer declared.
  const fixture = completeFixture();
  fixture.sourceManifest.dependencies = {};
  const { failures } = evaluateVsix(fixture);
  assert.equal(failures.length, 2);
  assert.match(failures[1], /asserted nothing/);
});

test("an empty entry-import list FAILS instead of vacuously passing", () => {
  const fixture = completeFixture();
  fixture.entryImports = [];
  const { failures } = evaluateVsix(fixture);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /extraction broke/);
});

test("a vsix missing a decision module FAILS and names the missing file", () => {
  const fixture = completeFixture();
  fixture.entries = fixture.entries.filter((e) => e !== "extension/src/status.mjs");
  const { failures } = evaluateVsix(fixture);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /src\/status\.mjs/);
});

test("an empty decision-module list FAILS instead of vacuously passing", () => {
  const fixture = completeFixture();
  fixture.decisionModules = [];
  const { failures } = evaluateVsix(fixture);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /nothing was actually asserted/);
});

test("a vsix missing its entry point FAILS", () => {
  const fixture = completeFixture();
  fixture.entries = fixture.entries.filter((e) => e !== "extension/extension.mjs");
  const { failures } = evaluateVsix(fixture);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /entry point/);
});

test("a test file inside the vsix FAILS — .vscodeignore stopped doing its job", () => {
  const fixture = completeFixture();
  fixture.entries.push("extension/src/status.test.mjs");
  const { failures } = evaluateVsix(fixture);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /status\.test\.mjs/);
});

test("a missing icon or README or LICENSE each FAILS", () => {
  for (const gone of ["extension/icon.png", "extension/readme.md", "extension/LICENSE.txt"]) {
    const fixture = completeFixture();
    fixture.entries = fixture.entries.filter((e) => e !== gone);
    const { failures } = evaluateVsix(fixture);
    assert.equal(failures.length, 1, `removing ${gone} must fail exactly one check`);
  }
});

test("the README match is case-insensitive, because vsce lowercases it", () => {
  const fixture = completeFixture();
  fixture.entries = fixture.entries.map((e) =>
    e === "extension/readme.md" ? "extension/README.md" : e,
  );
  const { failures } = evaluateVsix(fixture);
  assert.deepEqual(failures, []);
});

test("a devDependency tree inside the vsix FAILS — the staging install packed dev deps", () => {
  const fixture = completeFixture();
  fixture.entries.push("extension/node_modules/@types/vscode/package.json");
  const { failures } = evaluateVsix(fixture);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /@types\/vscode/);
});

test("a drifted engines.vscode FAILS and states both values", () => {
  const fixture = completeFixture();
  fixture.packagedManifest.engines = { vscode: "^1.90.0" };
  const { failures } = evaluateVsix(fixture);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /\^1\.90\.0/);
  assert.match(failures[0], /\^1\.100\.0/);
});

test("a version mismatch FAILS — every other check would be blessing a stale artifact", () => {
  const fixture = completeFixture();
  fixture.packagedManifest.version = "0.0.9";
  const { failures } = evaluateVsix(fixture);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /0\.0\.9/);
});

test("multiple defects are all reported, not just the first", () => {
  const fixture = completeFixture();
  fixture.entries = fixture.entries.filter(
    (e) =>
      e !== "extension/extension.mjs" &&
      !e.startsWith("extension/node_modules/vscode-languageclient/"),
  );
  const { failures } = evaluateVsix(fixture);
  assert.equal(failures.length, 3);
});

test("importedPackages reads the entry point's requirements from its code", () => {
  const source = [
    `import { commands } from "vscode";`,
    `import languageClient from "vscode-languageclient/node";`,
    `import { createRequire } from "node:module";`,
    `import { parse } from "@scope/pkg/deep/path";`,
    `import "side-effect-pkg";`,
    `import {`,
    `  many,`,
    `  names,`,
    `} from "multiline-pkg";`,
    `import { helper } from "./src/helper.mjs";`,
  ].join("\n");
  // `vscode` is host-provided, `node:` ships with the host, relative paths are
  // packaged as files — what remains is what an install must carry.
  assert.deepEqual(importedPackages(source), [
    "vscode-languageclient",
    "@scope/pkg",
    "side-effect-pkg",
    "multiline-pkg",
  ]);
});

test("importedPackages ignores prose in comments and returns unique names once", () => {
  const source = [
    `// a comment saying: import stuff from "not-a-dep" is not an import`,
    `import a from "real-dep";`,
    `import b from "real-dep/subpath";`,
  ].join("\n");
  assert.deepEqual(importedPackages(source), ["real-dep"]);
});

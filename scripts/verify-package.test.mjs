// Tests for verify-package.mjs's shipped-import gate and for
// `parsePeerFloorMajor`, the pure half of the peer-floor lane this script
// imports from peer-floor.mjs.
//
// Every function under test here takes all of its facts as arguments, so these
// run with no workspace, no filesystem and no mocking framework — the logic
// already sits at the isolation boundary, the same place check-packages.mjs's
// `evaluate` occupies. What is deliberately NOT tested is `main()`: it exists
// to pack a tarball and install it into consumer workspaces, and a test that
// stubbed those answers would only pin the stub. The real thing is exercised by
// `node scripts/verify-package.mjs packages/archkeep` in the release lane,
// against real packed bytes.
//
// Each case is named by the state it pins. Both directions of the gate appear:
// code a dumber scanner would misread (comment prose quoting an import, a
// division slash, a regex containing `//`) stays clean, and code that genuinely
// dangles past the tarball boundary is named as a violation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePeerFloorMajor } from "./peer-floor.mjs";
import {
  maskSource,
  resolvesInside,
  shippedImportViolations,
  specifiersFrom,
} from "./verify-package.mjs";

// --- maskSource: the one lexical pass ---------------------------------------

test("a line comment is stripped, prose quoting an import included", () => {
  const { code, strings } = maskSource('const a = 1; // import x from "./gone.mjs"\nconst b = 2;');
  assert.ok(!code.includes("import"));
  assert.ok(!code.includes("gone.mjs"));
  assert.ok(code.includes("const b = 2;"));
  assert.deepEqual(strings, []);
});

test("a block comment is stripped", () => {
  const { code, strings } = maskSource('/* import x from "./gone.mjs" */ const a = 1;');
  assert.ok(!code.includes("import"));
  assert.ok(!code.includes("gone.mjs"));
  assert.deepEqual(strings, []);
});

test("quoted strings are masked, their values preserved in placeholder order", () => {
  const { code, strings } = maskSource(`const a = "first"; const b = 'second';`);
  assert.deepEqual(strings, ["first", "second"]);
  assert.ok(code.includes('"\uE0000\uE000"'));
  assert.ok(code.includes("'\uE0001\uE000'"));
  assert.ok(!code.includes("first"));
});

test("a template literal is masked as an empty string", () => {
  const { code, strings } = maskSource("const a = `hello ${name} world`;");
  assert.deepEqual(strings, [""]);
  assert.ok(code.includes("`"));
  assert.ok(!code.includes("hello"));
});

test("a regex literal in statement position, containing //, does not swallow the line", () => {
  const { code, strings } = maskSource('const re = /a[//]b/; import("./after.mjs");');
  assert.equal(code, 'const re =  ; import("\uE0000\uE000");');
  assert.deepEqual(strings, ["./after.mjs"]);
});

test("a single slash after a value is division, not a regex opener", () => {
  const { code, strings } = maskSource('const half = total/2; import("./kept.mjs");');
  assert.equal(code, 'const half = total/2; import("\uE0000\uE000");');
  assert.deepEqual(strings, ["./kept.mjs"]);
});

test("an escape keeps a string open through an embedded quote", () => {
  const { code, strings } = maskSource('const s = "a\\"b"; import("./kept.mjs");');
  assert.equal(code, 'const s = "\uE0000\uE000"; import("\uE0001\uE000");');
  assert.deepEqual(strings, ['a\\"b', "./kept.mjs"]);
});

// --- specifiersFrom: the four statement shapes ------------------------------

test("a static import-from fires", () => {
  assert.deepEqual(specifiersFrom('import x from "\uE0000\uE000";', ["./a.mjs"]), ["./a.mjs"]);
});

test("an export-from fires", () => {
  assert.deepEqual(specifiersFrom('export { x } from "\uE0000\uE000";', ["./a.mjs"]), ["./a.mjs"]);
});

test("a dynamic import with a string literal fires", () => {
  assert.deepEqual(specifiersFrom('const m = import("\uE0000\uE000");', ["./a.mjs"]), ["./a.mjs"]);
});

test("a side-effect import fires", () => {
  assert.deepEqual(specifiersFrom('import "\uE0000\uE000";', ["./a.mjs"]), ["./a.mjs"]);
});

test("specifiers dedupe in first-appearance order", () => {
  const { code, strings } = maskSource('import "./a.mjs"; import "./b.mjs"; import "./a.mjs";');
  assert.deepEqual(specifiersFrom(code, strings), ["./a.mjs", "./b.mjs"]);
});

test("a masked index beyond the given strings is ignored, not thrown or resolved", () => {
  assert.deepEqual(specifiersFrom('import "\uE0007\uE000";', ["decoy"]), []);
});

test("an import quoted inside a comment yields nothing", () => {
  const { code, strings } = maskSource('// import x from "./gone.mjs"\nexport const ok = 1;');
  assert.deepEqual(specifiersFrom(code, strings), []);
});

// --- resolvesInside: the tarball's own file set is the only filesystem ------

test("an exact hit resolves", () => {
  assert.ok(resolvesInside("./util.mjs", "src/a.mjs", new Set(["src/util.mjs"])));
});

test("an extensionless specifier probes .mjs", () => {
  assert.ok(resolvesInside("./util", "src/a.mjs", new Set(["src/util.mjs"])));
});

test("an extensionless specifier probes .js", () => {
  assert.ok(resolvesInside("./util", "src/a.mjs", new Set(["src/util.js"])));
});

test("an extensionless specifier probes index.mjs", () => {
  assert.ok(resolvesInside("./util", "src/a.mjs", new Set(["src/util/index.mjs"])));
});

test("an extensionless specifier probes index.js", () => {
  assert.ok(resolvesInside("./util", "src/a.mjs", new Set(["src/util/index.js"])));
});

test("a parent escape climbs past siblings and misses", () => {
  // `src/outside.mjs` ships: if `..` were ignored, the join would land on it
  // and this would pass for the wrong reason. The miss is the point.
  assert.equal(resolvesInside("../outside.mjs", "src/a.mjs", new Set(["src/outside.mjs"])), false);
});

test("a deep ../ chain resolves correctly within the tree", () => {
  assert.ok(resolvesInside("../../lib/x.mjs", "src/a/b/c.mjs", new Set(["src/lib/x.mjs"])));
});

// --- shippedImportViolations: the verdict -----------------------------------

const SHIPPED = new Set(["src/a.mjs", "src/b.mjs"]);

function violationsFor(sources, dependencyNames = [], packageName = "@ecoma-io/archkeep") {
  return shippedImportViolations(
    Object.keys(sources),
    (name) => sources[name],
    SHIPPED,
    dependencyNames,
    packageName,
  );
}

test("an undeclared bare specifier is a violation naming file, specifier and reason", () => {
  assert.deepEqual(violationsFor({ "src/a.mjs": 'import "left-pad";' }), [
    {
      file: "src/a.mjs",
      specifier: "left-pad",
      reason: "bare specifier covered by neither dependencies nor peerDependencies",
    },
  ]);
});

test("a bare specifier covered by a dependency is accepted", () => {
  assert.deepEqual(
    violationsFor({ "src/a.mjs": 'import { parse } from "smol-toml";' }, ["smol-toml"]),
    [],
  );
});

test("a bare specifier covered by a peerDependency is accepted", () => {
  assert.deepEqual(
    violationsFor({ "src/a.mjs": 'import ts from "typescript";' }, ["typescript"]),
    [],
  );
});

test("node builtins are skipped, both the node: form and the bare form", () => {
  assert.deepEqual(violationsFor({ "src/a.mjs": 'import fs from "node:fs"; import "fs";' }), []);
});

test("the package's self-name and its subpaths are skipped", () => {
  assert.deepEqual(
    violationsFor({
      "src/a.mjs": 'import self from "@ecoma-io/archkeep"; import "@ecoma-io/archkeep/cli.mjs";',
    }),
    [],
  );
});

test("a relative specifier landing on a shipped file is accepted", () => {
  assert.deepEqual(violationsFor({ "src/a.mjs": 'import { b } from "./b.mjs";' }), []);
});

test("a relative specifier landing on a missing file is a violation with the does-not-ship reason", () => {
  assert.deepEqual(violationsFor({ "src/a.mjs": 'import { g } from "./gone.mjs";' }), [
    {
      file: "src/a.mjs",
      specifier: "./gone.mjs",
      reason: "resolves to src/gone.mjs, which the tarball does not ship",
    },
  ]);
});

test("a subpath of a scoped dependency is covered by the dependency entry", () => {
  assert.deepEqual(
    violationsFor(
      {
        "src/a.mjs": 'import "@scope/dep"; import { x } from "@scope/dep/sub";',
      },
      ["@scope/dep"],
    ),
    [],
  );
});

// --- parsePeerFloorMajor: the floor the consumer lanes install against ------

test("reads the floor off >= comparators", () => {
  assert.equal(parsePeerFloorMajor(">=21"), 21);
  assert.equal(parsePeerFloorMajor(">=21.4.2"), 21);
});

test("a conjunction floors at its loosest >= comparator", () => {
  assert.equal(parsePeerFloorMajor(">=5 <7"), 5);
});

test("reads the floor off caret, tilde, and exact-major shapes", () => {
  assert.equal(parsePeerFloorMajor("^21"), 21);
  assert.equal(parsePeerFloorMajor("~21.1"), 21);
  assert.equal(parsePeerFloorMajor("21.x"), 21);
  assert.equal(parsePeerFloorMajor("21.4.2"), 21);
});

test("an unbounded range yields null, which the lane turns red", () => {
  // The silent direction: if the parser guessed a floor for an unbounded
  // range, the floor lane would test a version of its own invention while
  // reading green. null is the value the caller fails on.
  assert.equal(parsePeerFloorMajor("*"), null);
  assert.equal(parsePeerFloorMajor("latest"), null);
  assert.equal(parsePeerFloorMajor(""), null);
});

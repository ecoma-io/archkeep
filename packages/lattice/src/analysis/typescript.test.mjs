import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { analyzeTypeScript, packageNameOf, specifierSpelling } from "./typescript.mjs";

/**
 * An in-memory workspace with real path aliases. Resolution runs through
 * TypeScript's own resolver against these files, so a test that passes proves
 * `ts.resolveModuleName` was driven correctly — a hard-coded alias table would
 * fail every assertion below that changes the tree and expects the answer to
 * change with it.
 */
const workspaceWith = (files, projects) => ({
  root: "/w",
  projects,
  filesOf: (name) =>
    Object.keys(files).filter((file) => {
      const root = projects.find((project) => project.name === name)?.root;
      return root !== undefined && (file === root || file.startsWith(`${root}/`));
    }),
  // `?? null`, never `undefined`: the contract says a missing file reads as
  // null, and a fixture that overrides an entry to `undefined` is stating the
  // file is absent.
  readFile: (path) => files[path] ?? null,
});

const PROJECTS = [
  { name: "ui", root: "libs/ui" },
  { name: "ui-icons", root: "libs/ui/icons" }, // nested inside `ui` on purpose
  { name: "web", root: "apps/web" },
];

const tsconfig = (paths) =>
  JSON.stringify({
    compilerOptions: {
      module: "ESNext",
      moduleResolution: "Bundler",
      baseUrl: ".",
      paths,
    },
  });

const BASE_FILES = {
  "tsconfig.base.json": tsconfig({
    "@acme/ui": ["libs/ui/src/index.ts"],
    "@acme/ui/a11y": ["libs/ui/src/a11y.ts"],
    "@acme/icons": ["libs/ui/icons/src/index.ts"],
  }),
  "libs/ui/src/index.ts": "export const button = 1;",
  "libs/ui/src/a11y.ts": "export const scope = 1;",
  "libs/ui/src/Button.vue": "<template><button /></template>",
  "libs/ui/icons/src/index.ts": "export const icon = 1;",
  "apps/web/src/util.ts": "export const util = 1;",
  "node_modules/left-pad/package.json": JSON.stringify({ name: "left-pad", main: "index.js" }),
  "node_modules/left-pad/index.js": "module.exports = 1;",
  "node_modules/@acme-vendor/api/package.json": JSON.stringify({
    name: "@acme-vendor/api",
    main: "index.js",
  }),
  "node_modules/@acme-vendor/api/index.js": "module.exports = 1;",
  "node_modules/@acme-vendor/api/window.js": "module.exports = 1;",
};

/**
 * Analyzes `text` as `apps/web/src/main.ts` of the standard fixture tree.
 *
 * @param {string} text
 * @param {{ files?: Record<string, string>, sourceFile?: string, lang?: string }} [options]
 */
function analyze(text, { files = {}, sourceFile = "apps/web/src/main.ts", lang } = {}) {
  const workspace = workspaceWith({ ...BASE_FILES, ...files }, PROJECTS);
  return analyzeTypeScript({ sourceFile, text, workspace, lang });
}

describe("packageNameOf", () => {
  it("keeps both segments of a scoped package and drops the deep path", () => {
    // What a `bannedExternalImports` glob is matched against: the package, not
    // the file inside it. Getting this wrong makes `@tauri-apps/*` miss
    // `@tauri-apps/api/window`, which is the exact ban this workspace writes.
    expect(packageNameOf("@tauri-apps/api/window")).toBe("@tauri-apps/api");
    expect(packageNameOf("@tauri-apps/api")).toBe("@tauri-apps/api");
    expect(packageNameOf("left-pad/es/index.js")).toBe("left-pad");
    expect(packageNameOf("node:fs/promises")).toBe("node:fs");
  });

  it("names no package for a path, which is not one", () => {
    expect(packageNameOf("./sibling")).toBeNull();
    expect(packageNameOf("../../libs/ui")).toBeNull();
    expect(packageNameOf("/abs/path")).toBeNull();
    expect(packageNameOf("@scope-only")).toBeNull();
  });
});

describe("analyzeTypeScript — resolution through TypeScript's own resolver", () => {
  it("resolves a tsconfig path alias to the project that owns the file it points at", () => {
    const { imports, failures } = analyze('import { button } from "@acme/ui";');
    expect(failures).toEqual([]);
    expect(imports).toEqual([
      {
        sourceFile: "apps/web/src/main.ts",
        line: 1,
        column: 24, // the opening quote of `"@acme/ui"`
        specifier: "@acme/ui",
        kind: "static",
        spelling: { path: false, relative: false },
        resolved: {
          target: "ui",
          file: "libs/ui/src/index.ts",
          external: false,
          packageName: null,
        },
      },
    ]);
  });

  it("follows the alias table rather than the alias name — repoint it and the answer moves", () => {
    // The anti-hard-coding assertion. `@acme/ui` is unchanged; only the
    // tsconfig entry moves, and the resolved project must move with it. An
    // implementation that mapped names to projects from a table of its own
    // would still answer `ui` here.
    const repointed = analyze('import { icon } from "@acme/ui";', {
      files: { "tsconfig.base.json": tsconfig({ "@acme/ui": ["libs/ui/icons/src/index.ts"] }) },
    });
    expect(repointed.imports[0].resolved).toEqual({
      target: "ui-icons",
      file: "libs/ui/icons/src/index.ts",
      external: false,
      packageName: null,
    });
  });

  it("resolves a secondary entry to its own file, not to the package's main one", () => {
    const { imports } = analyze('import { scope } from "@acme/ui/a11y";');
    expect(imports[0].resolved.file).toBe("libs/ui/src/a11y.ts");
  });

  it("attributes a resolved file to the innermost project that owns it", () => {
    // `libs/ui/icons` sits inside `libs/ui`. A first-match project lookup
    // would call this `ui` and hide every edge into and out of `ui-icons`.
    const { imports } = analyze('import { icon } from "@acme/icons";');
    expect(imports[0].resolved.target).toBe("ui-icons");
  });

  it("marks a node_modules resolution external and names its package", () => {
    const { imports, failures } = analyze('import api from "@acme-vendor/api/window";');
    expect(failures).toEqual([]);
    expect(imports[0].resolved).toEqual({
      target: null,
      file: "node_modules/@acme-vendor/api/window.js",
      external: true,
      packageName: "@acme-vendor/api",
    });
  });

  it("marks a package installed inside a project's own directory external, not a self-import", () => {
    // The shape every publishable package in a workspace has: declaring its own
    // `dependencies` gives it its own `node_modules/`, which sits UNDER the
    // project root, so attribution by longest-root-prefix hands a vendored file
    // to the project and the import reads as the project importing itself.
    //
    // Measured, not hypothetical: the day this repository's own package
    // declared `smol-toml`, its self-check reported three
    // `noSelfCircularDependencies` violations advising that `import
    // "typescript"` be rewritten as a relative path. That rule fires before the
    // `depConstraints` table is read, so a consumer hitting it could not
    // configure their way out of a false verdict.
    const { imports, failures } = analyze('import { parse } from "vendored-dep";', {
      files: {
        "apps/web/node_modules/vendored-dep/package.json": JSON.stringify({
          name: "vendored-dep",
          main: "index.js",
        }),
        "apps/web/node_modules/vendored-dep/index.js": "module.exports = 1;",
      },
    });
    expect(failures).toEqual([]);
    expect(imports[0].resolved).toEqual({
      target: null,
      file: "apps/web/node_modules/vendored-dep/index.js",
      external: true,
      packageName: "vendored-dep",
    });
  });

  it("still names the owning project for a resolution that is not an installed package", () => {
    // The other side of the branch above, and the reason it is a narrow
    // pre-empt rather than "trust isExternalLibraryImport for everything": a
    // real cross-project resolution must still be attributed, or every edge the
    // boundary rules exist to judge would vanish into `external`.
    const { imports } = analyze('import { button } from "@acme/ui";');
    expect(imports[0].resolved).toMatchObject({ target: "ui", external: false });
  });

  it("marks a Node built-in external instead of calling it unresolvable", () => {
    // TypeScript's resolver structurally cannot resolve `node:fs` — there is
    // no package to find. Reporting it as a failure would be false, and would
    // bury every genuine failure under stdlib noise.
    const { imports, failures } = analyze(
      'import { readFileSync } from "node:fs";\nrequire("path");',
    );
    expect(failures).toEqual([]);
    expect(imports.map((record) => record.resolved)).toEqual([
      { target: null, file: null, external: true, packageName: "node:fs" },
      { target: null, file: null, external: true, packageName: "path" },
    ]);
  });

  it("resolves a relative import TypeScript declines, when the named file exists", () => {
    // A `.vue` or `.css` import is not a TypeScript module, but it is a real
    // path and it can cross a project boundary. Dropping it would make that
    // crossing invisible.
    const { imports, failures } = analyze('import Button from "../../../libs/ui/src/Button.vue";');
    expect(failures).toEqual([]);
    expect(imports[0].resolved).toEqual({
      target: "ui",
      file: "libs/ui/src/Button.vue",
      external: false,
      packageName: null,
    });
  });

  it("strips a bundler query suffix from the path while keeping the raw specifier", () => {
    const { imports } = analyze('import raw from "../../../libs/ui/src/Button.vue?raw";');
    expect(imports[0].specifier).toBe("../../../libs/ui/src/Button.vue?raw");
    expect(imports[0].resolved.file).toBe("libs/ui/src/Button.vue");
  });

  it("does not invent a file for a relative import that names nothing", () => {
    const { imports, failures } = analyze('import x from "./missing.vue";');
    expect(imports[0].resolved).toBeNull();
    expect(failures).toEqual([
      {
        sourceFile: "apps/web/src/main.ts",
        line: 1,
        column: 15,
        reason: "TypeScript cannot resolve './missing.vue' from 'apps/web/src/main.ts'",
      },
    ]);
  });
});

describe("analyzeTypeScript — the record every rule reads", () => {
  it("emits a relative import that never leaves the project", () => {
    // `contract.md` keeps these: `allowCircularSelfDependency` and a
    // nested-path ban are decided entirely on imports whose source and target
    // are the same project, and dropping them here makes both unimplementable.
    const { imports } = analyze('import { util } from "./util";');
    expect(imports[0].resolved).toEqual({
      target: "web",
      file: "apps/web/src/util.ts",
      external: false,
      packageName: null,
    });
  });

  it("emits one record per written import, not one per resolved dependency", () => {
    const { imports } = analyze(
      ['import { button } from "@acme/ui";', 'import { scope } from "@acme/ui";', ""].join("\n"),
    );
    expect(imports).toHaveLength(2);
    expect(imports.map((record) => record.line)).toEqual([1, 2]);
  });

  it("reports 1-based line and column at the specifier, in source order", () => {
    const text = ["const a = 1;", "", '  import { button } from "@acme/ui";'].join("\n");
    const { imports } = analyze(text);
    expect(imports[0].line).toBe(3);
    // Column points at the opening quote of the specifier, which is where an
    // editor should underline and where a `file:line:col` report should land.
    expect(text.split("\n")[2].slice(imports[0].column - 1)).toBe('"@acme/ui";');
  });

  it("keeps the specifier exactly as written, deep path and all", () => {
    const { imports } = analyze('import w from "@acme-vendor/api/window";');
    expect(imports[0].specifier).toBe("@acme-vendor/api/window");
  });

  it("states how each specifier is spelled, on the record the rules read", () => {
    // The rules layer no longer derives this, and the derivation it used to do
    // was JavaScript's shape applied to every language (`contract.md`). Pinned
    // through the analyzer and not only through `specifierSpelling` below,
    // because a field the classifier computes and the analyzer forgets to
    // attach reads downstream as an analyzer that predates the contract.
    const text = [
      'import a from "./util";',
      'import b from "@acme/ui";',
      'import c from "/rooted";',
    ].join("\n");
    expect(analyze(text).imports.map((record) => record.spelling)).toEqual([
      { path: true, relative: true },
      { path: false, relative: false },
      { path: true, relative: false },
    ]);
  });
});

describe("specifierSpelling", () => {
  // The JavaScript family is the one where "is it a path" and "does it stay
  // inside its own project" have the same answer, which is exactly why one
  // predicate downstream looked general enough to serve every language.
  it("calls a relative path both a path and relative, bare dots included", () => {
    for (const specifier of ["./a", "../a", ".", ".."]) {
      expect(specifierSpelling(specifier)).toEqual({ path: true, relative: true });
    }
  });

  it("calls a rooted path a path and not relative", () => {
    expect(specifierSpelling("/outside/present")).toEqual({ path: true, relative: false });
  });

  it("calls a package name neither, scoped or not", () => {
    for (const specifier of ["@scope/pkg", "pkg", "@scope/pkg/deep/path"]) {
      expect(specifierSpelling(specifier)).toEqual({ path: false, relative: false });
    }
  });

  it("has no opinion about another language's relative form, because it is not this language's", () => {
    // The scope guard. `super::x` and `..pkg` are relative in their own
    // languages and their own analyzers say so; this classifier answering for
    // them would be the JavaScript-shaped predicate rebuilt one layer down.
    for (const specifier of ["super::product_name", "..pkg.sub", "example.com/mod/pkg"]) {
      expect(specifierSpelling(specifier)).toEqual({ path: false, relative: false });
    }
  });

  it("calls a non-literal argument's source text neither", () => {
    expect(specifierSpelling("`./${dir}/x`")).toEqual({ path: false, relative: false });
  });
});

describe("analyzeTypeScript — import kinds", () => {
  const kindsOf = (text) =>
    analyze(text).imports.map((record) => `${record.kind} ${record.specifier}`);

  it("separates the four forms one edge would collapse into one", () => {
    expect(
      kindsOf(
        [
          'import { button } from "@acme/ui";',
          'import "./util";',
          'import type { T } from "@acme/ui/a11y";',
          'export { button } from "@acme/ui";',
          'export * from "./util";',
          'const later = await import("@acme/icons");',
          'const cjs = require("left-pad");',
          'import legacy = require("left-pad");',
        ].join("\n"),
      ),
    ).toEqual([
      "static @acme/ui",
      "static ./util",
      "type-only @acme/ui/a11y",
      "re-export @acme/ui",
      "re-export ./util",
      "dynamic @acme/icons",
      "static left-pad",
      "static left-pad",
    ]);
  });

  it("records `require.resolve` as static, the other callee upstream's require handler admits", () => {
    // Upstream's `getImportFromRequireCall` accepts a bare `require` identifier
    // AND a `require.resolve` member expression. A form that yields no record
    // is not one missing message: with no site, all fifteen rules are void on
    // that call, and the boundary reports clean because it never looked.
    //
    // `static`, like `require` itself: the specifier is literal, it survives to
    // runtime, and it is read where the statement stands. That the call returns
    // a path rather than the module's exports is a fact about its value, which
    // no rule reads.
    expect(kindsOf('const where = require.resolve("@acme/ui");')).toEqual(["static @acme/ui"]);
    expect(analyze('const where = require.resolve("@acme/ui");').imports[0].resolved.target).toBe(
      "ui",
    );
  });

  it("admits those two callee forms and no cousin of them", () => {
    // Widening past upstream would report where ESLint stays silent, and a
    // difference from ESLint has to be a decision someone wrote down. Upstream
    // demands an identifier property, so a computed `require["resolve"]` is out
    // there and out here for the same reason.
    expect(kindsOf('const w = require["resolve"]("@acme/ui");')).toEqual([]);
    expect(kindsOf('const w = require.paths("@acme/ui");')).toEqual([]);
    expect(kindsOf('const w = resolve("@acme/ui");')).toEqual([]);
    expect(kindsOf('const w = req.resolve("@acme/ui");')).toEqual([]);
  });

  it("calls a mixed import static, because part of it survives to runtime", () => {
    // `B` is a value. Calling the statement type-only would let a rule that
    // exempts erased imports exempt a real runtime dependency.
    expect(kindsOf('import { type A, B } from "@acme/ui";')).toEqual(["static @acme/ui"]);
    expect(kindsOf('import { type A, type B } from "@acme/ui";')).toEqual(["type-only @acme/ui"]);
    expect(kindsOf('import def, { type A } from "@acme/ui";')).toEqual(["static @acme/ui"]);
    expect(kindsOf('import * as ns from "@acme/ui";')).toEqual(["static @acme/ui"]);
  });

  it("calls an erased re-export type-only, because it leaves no runtime edge behind", () => {
    expect(kindsOf('export type { A } from "@acme/ui";')).toEqual(["type-only @acme/ui"]);
    expect(kindsOf('export { type A } from "@acme/ui";')).toEqual(["type-only @acme/ui"]);
    expect(kindsOf('export { type A, B } from "@acme/ui";')).toEqual(["re-export @acme/ui"]);
    expect(kindsOf('import type legacy = require("left-pad");')).toEqual(["type-only left-pad"]);
  });

  it("reads JSX and TSX without treating their syntax as an error", () => {
    const tsx = analyzeTypeScript({
      sourceFile: "apps/web/src/App.tsx",
      text: 'import { button } from "@acme/ui";\nexport const A = () => <div attr={1} />;\n',
      workspace: workspaceWith(BASE_FILES, PROJECTS),
    });
    expect(tsx.failures).toEqual([]);
    expect(tsx.imports[0].resolved.target).toBe("ui");
  });
});

describe("analyzeTypeScript — what it cannot know, reported rather than guessed", () => {
  it("records a non-literal dynamic import as unresolvable with its argument text", () => {
    // Silently dropping this is how a boundary gets bypassed by a template
    // literal: the site is real, only the target is unknowable.
    const { imports, failures } = analyze("const m = await import(`./${name}.js`);");
    expect(imports).toHaveLength(1);
    expect(imports[0].kind).toBe("dynamic");
    expect(imports[0].specifier).toBe("`./${name}.js`");
    expect(imports[0].resolved).toBeNull();
    expect(failures[0].reason).toMatch(/non-literal argument/);
    expect(failures[0].line).toBe(1);
  });

  it("records a non-literal require the same way rather than dropping it", () => {
    const { imports, failures } = analyze("const m = require(name);");
    expect(imports[0]).toMatchObject({ kind: "static", specifier: "name", resolved: null });
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toContain("'require(name)'");
  });

  it("names the call form the failure is about, so `require.resolve` is not reported as `require`", () => {
    // Both forms are `kind: "static"`, so the kind cannot name the construct.
    // A diagnostic that quotes a call the file does not contain sends its
    // reader looking for the wrong line.
    const { failures } = analyze("const m = require.resolve(name);");
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toContain("'require.resolve(name)'");
  });

  it("resolves a template literal that interpolates nothing", () => {
    const { imports } = analyze("const m = await import(`@acme/ui`);");
    expect(imports[0].resolved.target).toBe("ui");
  });

  it("records an argument-less import() instead of throwing on it", () => {
    const { imports, failures } = analyze("const m = import();");
    expect(imports[0]).toMatchObject({ kind: "dynamic", specifier: "", resolved: null });
    expect(failures.some((failure) => /non-literal/.test(failure.reason))).toBe(true);
  });
});

describe("analyzeTypeScript — a bad file must not blank a run", () => {
  it("returns the imports it did parse and reports the syntax error beside them", () => {
    // A tool that reports zero violations because it crashed on file three and
    // one that reports zero because the tree is clean print the same thing.
    const { imports, failures } = analyze('import { button } from "@acme/ui";\nconst = ;\n');
    expect(imports[0].resolved.target).toBe("ui");
    expect(failures.some((failure) => /parse error/.test(failure.reason))).toBe(true);
    expect(failures.every((failure) => failure.line >= 1)).toBe(true);
  });

  it("returns an envelope rather than throwing when the workspace itself misbehaves", () => {
    const hostile = {
      root: "/w",
      projects: PROJECTS,
      filesOf: () => [],
      readFile: () => {
        throw new Error("disk on fire");
      },
    };
    const result = analyzeTypeScript({
      sourceFile: "apps/web/src/main.ts",
      text: 'import "@acme/ui";',
      workspace: hostile,
    });
    expect(result.imports).toEqual([]);
    expect(result.failures[0].reason).toMatch(/disk on fire/);
  });

  it("reports a malformed tsconfig once per file, loudly, instead of silently losing every alias", () => {
    // A broken config drops every path alias, which would turn a whole
    // workspace's aliased imports into "unresolvable" with nothing naming the
    // one file that caused it.
    const { failures } = analyze('import { button } from "@acme/ui";', {
      files: { "tsconfig.base.json": "{ not json" },
    });
    expect(failures[0]).toMatchObject({ line: null, column: null });
    expect(failures[0].reason).toMatch(/tsconfig\.base\.json is not valid JSON/);
  });

  it("works without a tsconfig at all, since a workspace need not have one", () => {
    const { imports, failures } = analyze('import { util } from "./util";', {
      files: { "tsconfig.base.json": undefined },
    });
    expect(failures).toEqual([]);
    expect(imports[0].resolved.target).toBe("web");
  });

  it("reports a compiler-option error in the config rather than resolving against a broken one", () => {
    const { failures } = analyze('import "@acme/ui";', {
      files: {
        "tsconfig.base.json": JSON.stringify({ compilerOptions: { moduleResolution: "Nonsense" } }),
      },
    });
    expect(
      failures.some((failure) => /tsconfig\.base\.json is malformed/.test(failure.reason)),
    ).toBe(true);
  });
});

describe("the TypeScript API this analyzer delegates to", () => {
  // The manifest's `typescript` peer range and the guard at the top of
  // `typescript.mjs` are one fact in two files, and the failure mode of letting
  // them drift is the one that produced this suite: `>=5` admitted TypeScript 7,
  // whose entry point exports `version` and nothing else, and every consumer
  // installing `latest` got `Cannot read properties of undefined (reading 'TS')`
  // from a frozen object literal. These two hold the range to what the code
  // actually needs, in both directions.

  it("resolves every name the guard requires against the installed compiler", () => {
    // The guard throws at module load, so reaching this line at all proves the
    // installed TypeScript satisfies it. Naming the list again would just copy
    // the guard; what earns a test is that the analyzer WORKS here, which the
    // rest of this file already drives — this case pins the version that does.
    const [major] = ts.version.split(".").map(Number);
    expect(major, `typescript ${ts.version} is outside the declared peer range`).toBeLessThan(7);
    expect(major).toBeGreaterThanOrEqual(5);
  });

  it("declares a peer range that excludes the majors missing that API", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
        "utf8",
      ),
    );
    // Not a string comparison: the point is the bound EXISTS and is 7, because
    // an open `>=5` is what shipped the crash. A future 8 that restored the API
    // would move this deliberately, in the same edit as the guard.
    expect(manifest.peerDependencies.typescript).toBe(">=5 <7");
  });
});

describe("analyzeTypeScript — import-type queries (typeof import, import().Type)", () => {
  it("reads import('pkg').Foo as a type-only import with a string-literal specifier", () => {
    const { imports, failures } = analyze('type X = import("@acme/ui").Button;');
    expect(failures).toEqual([]);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      line: 1,
      column: 17,
      specifier: "@acme/ui",
      kind: "type-only",
      resolved: { target: "ui", external: false },
    });
  });

  it("reads typeof import('pkg') as a type-only import — exactly one site, not two", () => {
    const { imports, failures } = analyze(
      'const { logger }: typeof import("@acme/ui") = null as any;',
    );
    expect(failures).toEqual([]);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      line: 1,
      column: 33,
      specifier: "@acme/ui",
      kind: "type-only",
      resolved: { target: "ui", external: false },
    });
  });

  it("produces exactly one import site for typeof import — not a duplicate alongside any other form", () => {
    const { imports } = analyze(
      [
        'import type { T } from "@acme/ui";',
        'const x: typeof import("@acme/ui") = null as any;',
      ].join("\n"),
    );
    expect(imports).toHaveLength(2);
    expect(imports.map((r) => r.kind)).toEqual(["type-only", "type-only"]);
    expect(imports[0].line).toBe(1);
    expect(imports[1].line).toBe(2);
  });

  it("records a non-literal ImportType argument as unresolvable rather than dropping it", () => {
    const { imports, failures } = analyze("type X = typeof import(s).Foo;");
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      line: 1,
      column: 24,
      specifier: "s",
      kind: "type-only",
      resolved: null,
    });
    expect(failures).toHaveLength(1);
    // The callee 'import' appears in the failure reason, distinguishing this
    // form from a dynamic import() or require() with a non-literal argument.
    expect(failures[0].reason).toContain("'import(s)'");
    expect(failures[0].reason).toMatch(/non-literal argument/);
  });

  it("resolves the specifier through the same tsconfig path table as declarations", () => {
    const { imports, failures } = analyze('type Config = import("@acme/icons").Icon;');
    expect(failures).toEqual([]);
    expect(imports[0].resolved).toEqual({
      target: "ui-icons",
      file: "libs/ui/icons/src/index.ts",
      external: false,
      packageName: null,
    });
  });

  it("marks a node_modules ImportType specifier external, like any other", () => {
    const { imports, failures } = analyze('type P = import("left-pad").Pad;');
    expect(failures).toEqual([]);
    expect(imports[0].resolved).toMatchObject({
      target: null,
      external: true,
      packageName: "left-pad",
    });
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { evaluate } from "../rules/index.mjs";
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

/**
 * A `tsconfig.base.json` with these `paths`. `compilerOptions` overrides the
 * module/resolution defaults, because whether TypeScript's ordinary pass will
 * load a given target is a function of those options and not of the extension
 * alone — the `.json` block below is what measures that rather than asserting
 * it.
 */
const tsconfig = (paths, compilerOptions = {}) =>
  JSON.stringify({
    compilerOptions: {
      module: "ESNext",
      moduleResolution: "Bundler",
      baseUrl: ".",
      paths,
      ...compilerOptions,
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
    // A relative path names a FILE, not a package, so it can never name a
    // declared project by the `project.name` rule — it stays a positioned
    // blind spot (`contract.md`): the rest of the file's imports were judged,
    // and a path spelling is what the path rules report on.
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

  it("keeps a non-literal dynamic import a positioned blind spot, not a whole-file failure", () => {
    // The permanent case: a computed argument is not statically knowable, but
    // the rest of the file's imports WERE judged. It stays a site failure so
    // the report can show the position and `check` does not fail the run.
    const { imports, failures } = analyze(
      'const load = (name) => import(name);\nimport x from "./ok";',
    );
    const dynamic = imports.find((record) => record.kind === "dynamic");
    expect(dynamic.resolved).toBeNull();
    const failure = failures.find((failure) => /non-literal/.test(failure.reason));
    expect(failure).toMatchObject({ line: 1, column: 31 });
    expect(failure.line).toBe(1);
    expect(failure.column).toBe(31);
  });

  it("counts a literal import naming a declared project as a whole-file failure", () => {
    // The hole the invariant forbids: `web` is a declared project, the import
    // names it as a package, and the resolver cannot answer because there is no
    // `tsconfig` `paths` mapping and no `node_modules` entry. The edge that
    // workspace-internal dependency would have carried is missing — the file
    // could not be fully judged. It is a whole-file failure (`line: null`),
    // which is what makes `check` count the file toward `unchecked` (exit 3).
    // The tsconfig is dropped so the alias never resolves in the first place.
    const { failures } = analyze('import { local } from "web";', {
      files: { "tsconfig.base.json": undefined },
    });
    expect(failures).toEqual([
      {
        sourceFile: "apps/web/src/main.ts",
        line: null,
        column: null,
        reason: "TypeScript cannot resolve 'web' from 'apps/web/src/main.ts'",
      },
    ]);
  });

  it("keeps a literal import naming no declared project a positioned blind spot", () => {
    // `left-pad` is an installed third-party package in the fixture's
    // `node_modules`, but a workspace without it installed is a normal state —
    // failing the whole run on every unresolved package import would block
    // merges over dependencies nobody crossed. It stays a positioned blind
    // spot — reported loudly in the text report, but not a coverage hole that
    // changes the exit code.
    const { failures } = analyze('import { pad } from "left-pad";', {
      files: {
        "node_modules/left-pad/package.json": undefined,
        "node_modules/left-pad/index.js": undefined,
      },
    });
    expect(failures).toEqual([
      {
        sourceFile: "apps/web/src/main.ts",
        line: 1,
        column: 21,
        reason: "TypeScript cannot resolve 'left-pad' from 'apps/web/src/main.ts'",
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

describe("analyzeTypeScript — a non-relative specifier landing on a declined extension", () => {
  // The hole #264 reports, and it is not about `.vue`. TypeScript declines a
  // module whose extension it does not compile; a RELATIVE specifier of that
  // shape was already normalised and attributed, and a NON-RELATIVE one — a
  // `paths` alias, a `baseUrl` mapping — was dropped. Dropped, the record named
  // no target at all, which is `violations.md`'s "The order matters" step 4 and
  // not step 6 — the mechanism `./typescript.mjs`'s declined-extension branch
  // traces. The consequence is the one that matters here and is the same
  // either way, because steps 4 and 6 share rule 10: every `depConstraints` row
  // was skipped for the edge, and under `banTransitiveDependencies: false` —
  // the option's own default — that is a clean run and exit 0 over a real
  // boundary crossing.
  const aliasedTo = (target) => ({ "tsconfig.base.json": tsconfig({ "@acme/block": [target] }) });

  it("resolves an alias pointing at a .vue file to the project that owns it", () => {
    const { imports, failures } = analyze('import Block from "@acme/block";', {
      files: aliasedTo("libs/ui/src/Button.vue"),
    });
    expect(failures).toEqual([]);
    expect(imports[0].resolved).toEqual({
      target: "ui",
      file: "libs/ui/src/Button.vue",
      external: false,
      packageName: null,
    });
  });

  it("answers a .vue alias target exactly as it answers a .ts one", () => {
    // The whole bug in one assertion: the two runs differ only in the alias
    // TARGET, and before the fix the `.vue` one came back `external: true`
    // with `packageName: "@acme/block"` — a package the workspace does not
    // have — while the `.ts` one named the project. `external` is the field
    // the rule engine short-circuits on, so the two answers had to converge or
    // the `.vue` edge would keep skipping the constraint table.
    const viaVue = analyze('import Block from "@acme/block";', {
      files: aliasedTo("libs/ui/src/Button.vue"),
    });
    const viaTs = analyze('import Block from "@acme/block";', {
      files: aliasedTo("libs/ui/src/index.ts"),
    });
    expect(viaVue.imports[0].resolved.target).toBe(viaTs.imports[0].resolved.target);
    expect(viaVue.imports[0].resolved.external).toBe(viaTs.imports[0].resolved.external);
    expect(viaVue.imports[0].resolved.packageName).toBe(viaTs.imports[0].resolved.packageName);
  });

  it("follows the alias table rather than the extension — repoint it and the answer moves", () => {
    // The anti-hard-coding assertion the `.ts` case already carries, for the
    // declined-extension pass: `@acme/block` is unchanged and only the
    // tsconfig entry moves, across a project boundary. An implementation that
    // matched `.vue` against a table of its own would still answer `ui`.
    const repointed = analyze('import Block from "@acme/block";', {
      files: {
        ...aliasedTo("libs/ui/icons/src/Icon.vue"),
        "libs/ui/icons/src/Icon.vue": "<template><svg /></template>",
      },
    });
    expect(repointed.imports[0].resolved).toEqual({
      target: "ui-icons",
      file: "libs/ui/icons/src/Icon.vue",
      external: false,
      packageName: null,
    });
  });

  it("is general to every extension TypeScript declines, not special-cased to .vue", () => {
    // `.vue` is where it was reported because a component library is where a
    // boundary target IS a `.vue` file, but nothing about the mechanism is
    // Vue's: the resolver declines on the extension, and every extension it
    // declines took the same silent path.
    for (const [file, text] of [
      ["libs/ui/src/theme.css", ".a { color: red }"],
      ["libs/ui/src/logo.svg", "<svg />"],
      ["libs/ui/src/schema.graphql", "type Q { a: Int }"],
    ]) {
      const { imports } = analyze('import x from "@acme/block";', {
        files: { ...aliasedTo(file), [file]: text },
      });
      expect(imports[0].resolved).toEqual({
        target: "ui",
        file,
        external: false,
        packageName: null,
      });
    }
  });

  it("resolves a wildcard alias, because TypeScript still does the substitution", () => {
    // Nothing here matches a pattern or substitutes a `*` — that is the whole
    // argument for why this is not a second resolver. If the `*` arm broke,
    // this is the test that would say so.
    const { imports } = analyze('import Block from "@acme/blocks/Button";', {
      files: { "tsconfig.base.json": tsconfig({ "@acme/blocks/*": ["libs/ui/src/*.vue"] }) },
    });
    expect(imports[0].resolved).toMatchObject({ target: "ui", file: "libs/ui/src/Button.vue" });
  });

  it("does not invent a target for an alias whose file is not there", () => {
    // The load-bearing negative control for the pass itself. A dead alias must
    // stay unresolved — an alias that resolved because the resolver was
    // widened, rather than because a file exists, would be a fabricated edge.
    const { imports, failures } = analyze('import Block from "@acme/block";', {
      files: aliasedTo("libs/ui/src/Missing.vue"),
    });
    expect(imports[0].resolved).toBeNull();
    expect(failures).toEqual([
      {
        sourceFile: "apps/web/src/main.ts",
        line: 1,
        column: 19,
        reason: "TypeScript cannot resolve '@acme/block' from 'apps/web/src/main.ts'",
      },
    ]);
  });

  it("still calls a genuine external npm import external", () => {
    // The positive control the fix is judged against: widening one `fileExists`
    // answer must not turn an installed package into a workspace project.
    const { imports, failures } = analyze('import api from "@acme-vendor/api/window";');
    expect(failures).toEqual([]);
    expect(imports[0].resolved).toEqual({
      target: null,
      file: "node_modules/@acme-vendor/api/window.js",
      external: true,
      packageName: "@acme-vendor/api",
    });
  });

  it("leaves an extension TypeScript does load to the ordinary pass, untouched", () => {
    // The other half of the scope statement, under the fixture's own options
    // (`moduleResolution: "Bundler"`, `resolveJsonModule` unset) — the ONE
    // combination in which a `.json` alias target resolves in the ORDINARY
    // pass without the option being asked for. The declined-extension pass
    // must add nothing here. Every other combination is the block below, and
    // it is where this used to be wrong: the claim was that `.json` resolves
    // "even with `resolveJsonModule` off", and it does not.
    const { imports, failures } = analyze('import data from "@acme/block";', {
      files: {
        ...aliasedTo("libs/ui/src/data.json"),
        "libs/ui/src/data.json": JSON.stringify({ a: 1 }),
      },
    });
    expect(failures).toEqual([]);
    expect(imports[0].resolved).toEqual({
      target: "ui",
      file: "libs/ui/src/data.json",
      external: false,
      packageName: null,
    });
  });

  it("keeps a declined-extension file inside node_modules an external import", () => {
    // `isExternalLibraryImport` still decides before ownership, exactly as it
    // does for a resolution the ordinary pass made: an asset shipped by an
    // installed package is that package's, not a project's.
    const { imports, failures } = analyze('import "@acme-vendor/api/theme.css";', {
      files: { "node_modules/@acme-vendor/api/theme.css": ".a { color: red }" },
    });
    expect(failures).toEqual([]);
    expect(imports[0].resolved).toEqual({
      target: null,
      file: "node_modules/@acme-vendor/api/theme.css",
      external: true,
      packageName: "@acme-vendor/api",
    });
  });

  it("leaves the relative branch's narrower rules in charge of relative specifiers", () => {
    // The relative branch runs first and refuses extension probing outright.
    // `./Button` naming `Button.vue` must stay unresolved, or the declined pass
    // has quietly widened a rule that was narrow on purpose.
    const { imports } = analyze('import Button from "../../../libs/ui/src/Button";');
    expect(imports[0].resolved).toBeNull();
  });
});

describe("a non-relative specifier landing on a .json project source", () => {
  // The guard that decides whether the declined-extension pass may answer for a
  // `.json` remainder used to be a constant, on the claim that the ordinary
  // pass loads `.json` "even with `resolveJsonModule` off". Measured on
  // typescript 5.9.3, with `module` written beside `moduleResolution` exactly
  // as `MODES` below writes them, that is true in none of the five "off" cells:
  //
  //   resolveJsonModule | Classic | Node10 | Node16 | NodeNext | Bundler
  //   true              | loads   | loads  | loads  | loads    | loads
  //   false             | null    | null   | null   | null     | null
  //   unset             | null    | null   | null   | loads    | loads
  //
  // In every "null" cell the ordinary pass resolved nothing AND the guard
  // refused the widened pass its answer, so a project's `.json` source reached
  // by an alias was a boundary crossing neither pass could see — the silent
  // direction, in the workspaces this pass exists to serve.
  //
  // The table holds where the `.json` is supplied by the SPECIFIER. Measured
  // beside it: a `paths` TARGET that itself names the file — `{"@acme/data":
  // ["libs/ui/src/data.json"]}` or a `*.json` target template — loads in all
  // fifteen, which is why the two spellings are separated below rather than
  // driven from one fixture. The first is the hole; the second never had one.
  /** @type {[string, Record<string, unknown>][]} */
  const MODES = [
    ["Classic", { module: "ESNext", moduleResolution: "Classic" }],
    ["Node10", { module: "CommonJS", moduleResolution: "Node10" }],
    ["Node16", { module: "Node16", moduleResolution: "Node16" }],
    ["NodeNext", { module: "NodeNext", moduleResolution: "NodeNext" }],
    ["Bundler", { module: "ESNext", moduleResolution: "Bundler" }],
  ];
  /** @type {[string, Record<string, unknown>][]} */
  const RESOLVE_JSON_MODULE = [
    ["off", { resolveJsonModule: false }],
    ["on", { resolveJsonModule: true }],
    ["unset", {}],
  ];
  /** @param {[string, Record<string, unknown>][]} modes */
  const casesIn = (modes) =>
    modes.flatMap(([mode, moduleOptions]) =>
      RESOLVE_JSON_MODULE.map(([label, jsonOption]) => [
        mode,
        label,
        { ...moduleOptions, ...jsonOption },
      ]),
    );
  const cases = casesIn(MODES);
  // `Classic` walks parent directories, never `node_modules` — measured on
  // typescript 5.9.3, where it resolves neither `left-pad` nor a deep `.json`
  // inside a package, with the ordinary host and the widened one alike. So the
  // external control below runs in the four modes that HAVE a `node_modules`
  // walk to be judged by, and Classic gets its own case saying what it does.
  const nodeModulesCases = casesIn(MODES.filter(([mode]) => mode !== "Classic"));

  // The `.json` is written in the SPECIFIER and substituted through the `*`,
  // so the mapping supplies a directory and TypeScript decides the extension —
  // the shape the table above measures. Two projects carry the same file name
  // so that repointing the alias has somewhere to land.
  const wildcardAlias = (compilerOptions, target = "libs/ui/src/*") => ({
    "tsconfig.base.json": tsconfig({ "@acme/*": [target] }, compilerOptions),
    "libs/ui/src/data.json": JSON.stringify({ a: 1 }),
    "libs/ui/icons/src/data.json": JSON.stringify({ a: 2 }),
  });

  it.each(cases)(
    "names the owning project under moduleResolution %s with resolveJsonModule %s",
    (mode, label, compilerOptions) => {
      const { imports, failures } = analyze('import data from "@acme/data.json";', {
        files: wildcardAlias(compilerOptions),
      });
      expect(failures).toEqual([]);
      expect(imports[0].resolved).toEqual({
        target: "ui",
        file: "libs/ui/src/data.json",
        external: false,
        packageName: null,
      });
    },
  );

  it.each(cases)(
    "resolves a bare baseUrl mapping onto a .json source under %s / resolveJsonModule %s",
    (mode, label, compilerOptions) => {
      // The same hole without a `paths` table at all: `baseUrl` alone makes a
      // workspace-rooted specifier non-relative, so the relative branch never
      // sees it and the ordinary pass is the only thing that had a chance.
      const { imports, failures } = analyze('import data from "libs/ui/src/data.json";', {
        files: {
          "tsconfig.base.json": tsconfig({}, compilerOptions),
          "libs/ui/src/data.json": JSON.stringify({ a: 1 }),
        },
      });
      expect(failures).toEqual([]);
      expect(imports[0].resolved).toMatchObject({
        target: "ui",
        file: "libs/ui/src/data.json",
        external: false,
      });
    },
  );

  it.each(cases)(
    "follows the alias table rather than the extension under %s / resolveJsonModule %s",
    (mode, label, compilerOptions) => {
      // The anti-hard-coding half, in every mode: the specifier is unchanged
      // and only the tsconfig entry moves, across a project boundary. An
      // implementation matching `.json` against a table of its own would still
      // answer `ui`.
      const { imports } = analyze('import data from "@acme/data.json";', {
        files: wildcardAlias(compilerOptions, "libs/ui/icons/src/*"),
      });
      expect(imports[0].resolved).toMatchObject({
        target: "ui-icons",
        file: "libs/ui/icons/src/data.json",
      });
    },
  );

  it.each(cases)(
    "invents no target for a dead .json alias under %s / resolveJsonModule %s",
    (mode, label, compilerOptions) => {
      // The negative control the widening is judged against. Answering a
      // `fileExists` question TypeScript asked must not answer one it did not:
      // a target that is not there stays unresolved in every mode.
      const { imports } = analyze('import data from "@acme/missing.json";', {
        files: wildcardAlias(compilerOptions),
      });
      expect(imports[0].resolved).toBeNull();
    },
  );

  it.each(cases)(
    "leaves a paths target that names the .json itself to the ordinary pass under %s / resolveJsonModule %s",
    (mode, label, compilerOptions) => {
      // The other measured spelling, and the scope statement for the guard: a
      // mapped target carrying its own extension is loaded by the ordinary
      // pass in all fifteen cells, so the widened pass must add nothing. Same
      // answer either way — which is the point, since a difference here would
      // mean the two passes had formed opinions about one question.
      const { imports, failures } = analyze('import data from "@acme/data";', {
        files: {
          "tsconfig.base.json": tsconfig(
            { "@acme/data": ["libs/ui/src/data.json"] },
            compilerOptions,
          ),
          "libs/ui/src/data.json": JSON.stringify({ a: 1 }),
        },
      });
      expect(failures).toEqual([]);
      expect(imports[0].resolved).toMatchObject({
        target: "ui",
        file: "libs/ui/src/data.json",
        external: false,
      });
    },
  );

  it.each(nodeModulesCases)(
    "keeps a genuine external .json import external under %s / resolveJsonModule %s",
    (mode, label, compilerOptions) => {
      // The control the guard turns on: a `.json` shipped by an installed
      // package is that package's, never a project's, whichever pass resolved
      // it. `isExternalLibraryImport` decides before ownership.
      const { imports, failures } = analyze('import data from "@acme-vendor/api/data.json";', {
        files: {
          "tsconfig.base.json": tsconfig({}, compilerOptions),
          "node_modules/@acme-vendor/api/data.json": JSON.stringify({ a: 1 }),
        },
      });
      expect(failures).toEqual([]);
      expect(imports[0].resolved).toEqual({
        target: null,
        file: "node_modules/@acme-vendor/api/data.json",
        external: true,
        packageName: "@acme-vendor/api",
      });
    },
  );

  it("does not teach Classic a node_modules walk it never had", () => {
    // Why the control above skips Classic, measured rather than assumed:
    // Classic resolves NOTHING out of `node_modules` — not a plain package and
    // not a `.json` inside one — and the widened host must not change that. It
    // answers a `fileExists` question TypeScript asked; it does not add a
    // lookup rule, so a mode with no `node_modules` walk still has none.
    const classic = { module: "ESNext", moduleResolution: "Classic" };
    for (const specifier of ["left-pad", "@acme-vendor/api/data.json"]) {
      const { imports } = analyze(`import x from "${specifier}";`, {
        files: {
          "tsconfig.base.json": tsconfig({}, classic),
          "node_modules/@acme-vendor/api/data.json": JSON.stringify({ a: 1 }),
        },
      });
      expect(imports[0].resolved).toBeNull();
    }
  });
});

describe("a declined-extension alias target reaches the constraint table", () => {
  // #264's reportable run, end to end: analyzer → rule engine. Pinning the
  // analysis record alone would be half a test, because the record is not what
  // a consumer sees — the verdict is, and the whole failure was that the
  // verdict never got as far as `depConstraints`. A record that resolved to
  // nothing returns at step 4 of `violations.md`'s order, before the constraint
  // table is read.
  const NODES = {
    web: { name: "web", type: "app", data: { root: "apps/web", tags: ["layer:app"] } },
    ui: { name: "ui", type: "lib", data: { root: "libs/ui", tags: ["layer:ui"] } },
  };
  const CONFIG = {
    depConstraints: [{ sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:app"] }],
    options: {
      allow: [],
      buildTargets: ["build"],
      enforceBuildableLibDependency: false,
      allowCircularSelfDependency: false,
      checkDynamicDependenciesExceptions: [],
      ignoredCircularDependencies: [],
      // The value `@nx/enforce-module-boundaries` defaults to, this
      // repository's own config runs on, and #264 was reported against. With
      // it TRUE the misattributed edge at least produced a (wrong) violation;
      // with it FALSE — here — the crossing was a clean run and exit 0.
      banTransitiveDependencies: false,
      checkNestedExternalImports: false,
    },
    suppressions: [],
  };

  const verdictFor = (target) => {
    const { imports } = analyze('import Block from "@acme/block";', {
      files: { "tsconfig.base.json": tsconfig({ "@acme/block": [target] }) },
    });
    return evaluate(imports, { nodes: NODES, dependencies: { web: [], ui: [] } }, CONFIG);
  };

  it("reports the crossing instead of exiting clean, on the option's own default", () => {
    // The silent-direction assertion. Before the fix this array was EMPTY: the
    // alias resolved to nothing, the site fell to the engine's no-target branch
    // where an aliased specifier is neither a path nor a builtin, the
    // constraint table was never consulted, and `check` printed "no boundary
    // violations" and exited 0 over a primitive reaching straight into a
    // block's `.vue` source.
    const violations = verdictFor("libs/ui/src/Button.vue");
    expect(violations.map((violation) => violation.messageId)).toEqual([
      "onlyTagsConstraintViolation",
    ]);
    expect(violations[0]).toMatchObject({ sourceFile: "apps/web/src/main.ts", line: 1 });
  });

  it("gives the .vue target the same verdict as the .ts target one file over", () => {
    // The isolation the reporter used: two runs differing only in the alias
    // target. Same constraint table, same specifier, same source line — so any
    // difference in the verdict is the extension deciding a boundary question,
    // which is the bug.
    const viaVue = verdictFor("libs/ui/src/Button.vue");
    const viaTs = verdictFor("libs/ui/src/index.ts");
    expect(viaVue.map((violation) => violation.messageId)).toEqual(
      viaTs.map((violation) => violation.messageId),
    );
  });

  it("still reports nothing when the constraint table permits the edge", () => {
    // The positive control for the assertion above: an empty list has to be
    // reachable for the right reason, or "reports the crossing" would pass
    // against an engine that reported everything.
    const { imports } = analyze('import Block from "@acme/block";', {
      files: { "tsconfig.base.json": tsconfig({ "@acme/block": ["libs/ui/src/Button.vue"] }) },
    });
    const permissive = {
      ...CONFIG,
      depConstraints: [{ sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:ui"] }],
    };
    expect(
      evaluate(imports, { nodes: NODES, dependencies: { web: [], ui: [] } }, permissive),
    ).toEqual([]);
  });
});

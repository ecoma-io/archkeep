// JavaScript language fixture: three projects with ESM imports and one
// CommonJS `require()`. Proves JavaScript import discovery — the TypeScript
// analyzer handles `.js`/`.mjs`/`.cjs` files through the same parser, and
// resolution uses `tsconfig.json` paths (the same mechanism the TypeScript
// fixture uses, proving that JavaScript files are handled correctly).
//
// Architecture:
//   domain (layer:domain)     — no imports
//   application (layer:application) — imports domain (ESM)
//   api (layer:api)          — imports application (ESM) + domain (CJS require)
//
// The fixture uses `tsconfig.json` with `paths` for resolution, because
// `ts.resolveModuleName` marks anything resolved through `node_modules/`
// as an external library import (`isExternalLibraryImport`), which prevents
// cross-project edge creation. The `paths` mapping bypasses `node_modules/`
// and resolves directly to source files, allowing the analyzer to attribute
// them to the correct project.

import { LAYERED_BOUNDARY_CONFIG } from "./boundary-law.mjs";

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function javascriptLanguageFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-lang-javascript",
        private: true,
        type: "module",
        packageManager,
        devDependencies: {
          [packageName]: "*",
          typescript: peers.typescript,
        },
      },
      null,
      2,
    )}\n`,

    // tsconfig with paths mapping — resolution for `@example/*` specifiers.
    // No TypeScript-specific settings; this just provides the paths that
    // allow the analyzer to resolve cross-project imports.
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          paths: {
            "@example/domain": ["./libs/domain/src/index.mjs"],
            "@example/application": ["./libs/application/src/index.mjs"],
          },
        },
      },
      null,
      2,
    )}\n`,

    "lattice.json": `${JSON.stringify(
      {
        boundaryConfig: "module-boundaries.config.mjs",
        tsConfig: "tsconfig.json",
        projects: {
          declared: [
            { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
            { root: "libs/application", name: "application", tags: ["layer:application"] },
            { root: "libs/api", name: "api", tags: ["layer:api"] },
          ],
        },
        coverage: {
          exempt: [
            {
              path: "module-boundaries.config.mjs",
              reason: "workspace tooling config at the root, not itself a project",
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "module-boundaries.config.mjs": LAYERED_BOUNDARY_CONFIG,
    ".gitignore": "node_modules/\n.nx/\n",

    // Domain — leaf project, exports via ESM.
    "libs/domain/package.json": `${JSON.stringify(
      { name: "@example/domain", type: "module", main: "src/index.mjs" },
      null,
      2,
    )}\n`,
    "libs/domain/src/index.mjs": 'export const name = "domain";\n',

    // Application — imports domain via ESM.
    "libs/application/package.json": `${JSON.stringify(
      { name: "@example/application", type: "module", main: "src/index.mjs" },
      null,
      2,
    )}\n`,
    "libs/application/src/index.mjs":
      'import { name } from "@example/domain";\n\nexport const app = name;\n',

    // Api — imports application via ESM, and domain via CJS require.
    // The CJS require exercises the TypeScript analyzer's `require()` path,
    // which is the same path `@nx/enforce-module-boundaries` handles.
    "libs/api/package.json": `${JSON.stringify(
      { name: "@example/api", type: "module", main: "src/index.mjs" },
      null,
      2,
    )}\n`,
    "libs/api/src/index.mjs":
      'import { app } from "@example/application";\n' +
      'const { name } = require("@example/domain");\n\n' +
      "export const api = app;\n",
    // Also include a `.cjs` file to prove the CJS extension is analyzed.
    "libs/api/src/util.cjs":
      '// CommonJS module\nconst domain = require("@example/domain");\nmodule.exports = { domain };\n',
  };
}

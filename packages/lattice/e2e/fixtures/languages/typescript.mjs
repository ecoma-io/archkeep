// TypeScript language fixture: three projects with ESM imports and
// `import type`. Proves TypeScript import discovery, `ts.resolveModuleName`
// resolution through `tsconfig.json` paths, and boundary enforcement.
//
// Architecture:
//   domain (layer:domain)     — no imports
//   application (layer:application) — imports domain
//   api (layer:api)          — imports application + import type from domain

import { LAYERED_BOUNDARY_CONFIG } from "./boundary-law.mjs";

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function typescriptLanguageFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-lang-typescript",
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

    // tsconfig with paths mapping — TypeScript resolution depends on it.
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          paths: {
            "@example/domain": ["./libs/domain/src/index.ts"],
            "@example/application": ["./libs/application/src/index.ts"],
            "@example/api": ["./libs/api/src/index.ts"],
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

    // Domain — leaf project.
    "libs/domain/src/index.ts": 'export const name: string = "domain";\n',

    // Application — imports domain.
    "libs/application/src/index.ts":
      'import { name } from "@example/domain";\n\nexport const app = name;\n',

    // Api — imports application, plus `import type` from domain to exercise
    // the type-only path.
    "libs/api/src/index.ts":
      'import { app } from "@example/application";\n' +
      'import type { name } from "@example/domain";\n\n' +
      "export const api = app;\n",
  };
}

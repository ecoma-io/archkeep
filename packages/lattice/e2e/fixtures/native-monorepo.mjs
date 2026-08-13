// Native monorepo workspace: three Go projects with `lattice.json`, no `nx`.
//
// Proves "monorepo ≠ Nx" — multiple internal projects with a real dependency
// chain (`app → api → core`), all described in `lattice.json`, with no Nx
// involvement at all. The three-layer boundary law allows each layer to depend
// on itself and on layers below it.

import { MONOREPO_BOUNDARY_CONFIG } from "./boundary-law.mjs";

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function nativeMonorepoFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-native-monorepo",
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
    "lattice.json": `${JSON.stringify(
      {
        boundaryConfig: "module-boundaries.config.mjs",
        projects: {
          declared: [
            { root: "libs/core", name: "core", tags: ["layer:core"] },
            { root: "libs/api", name: "api", tags: ["layer:api"] },
            { root: "libs/app", name: "app", tags: ["layer:app"] },
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
    "module-boundaries.config.mjs": MONOREPO_BOUNDARY_CONFIG,
    ".gitignore": "node_modules/\n.nx/\n",
    "libs/core/go.mod": "module example.test/core\n\ngo 1.22\n",
    "libs/core/core.go": 'package core\n\nconst Name = "core"\n',
    "libs/api/go.mod":
      "module example.test/api\n\ngo 1.22\n\nrequire example.test/core v0.0.0\n\n" +
      "replace example.test/core => ../core\n",
    "libs/api/api.go": 'package api\n\nimport "example.test/core"\n\nvar _ = core.Name\n',
    "libs/app/go.mod":
      "module example.test/app\n\ngo 1.22\n\nrequire example.test/api v0.0.0\n\n" +
      "replace example.test/api => ../api\n",
    "libs/app/app.go": 'package app\n\nimport "example.test/api"\n\nvar _ = api.Name\n',
  };
}

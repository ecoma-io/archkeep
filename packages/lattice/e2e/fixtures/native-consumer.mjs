// Native consumer workspace: two Go projects with `lattice.json`, no `nx`.
//
// Same shape as `scripts/verify-package.mjs`'s `fixtureFilesNative` — `lattice.json`
// declares projects and tags, no `nx.json`, no `project.json`, no `nx` dependency.
// The coverage exemption for `module-boundaries.config.mjs` is required because
// `.mjs` is an analyzable extension and the root file is not itself a project.

import { BOUNDARY_CONFIG } from "./boundary-law.mjs";

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function nativeConsumerFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-native",
        private: true,
        type: "module",
        packageManager,
        // No `nx` — the peer is optional.
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
    "module-boundaries.config.mjs": BOUNDARY_CONFIG,
    ".gitignore": "node_modules/\n.nx/\n",
    "libs/core/go.mod": "module example.test/core\n\ngo 1.22\n",
    "libs/core/core.go": 'package core\n\nconst Name = "core"\n',
    "libs/app/go.mod":
      "module example.test/app\n\ngo 1.22\n\nrequire example.test/core v0.0.0\n\n" +
      "replace example.test/core => ../core\n",
    "libs/app/app.go": 'package app\n\nimport "example.test/core"\n\nvar _ = core.Name\n',
  };
}

// Nx consumer workspace: two Go projects with `nx.json` and `project.json`.
//
// Same shape as `scripts/verify-package.mjs`'s `fixtureFiles` — the fixture
// asks for `typescript` and `nx` by RANGE from the package's declared peers,
// so what installs here is what a consumer obeying the manifest would get.
//
// `nx.json` registers `@ecoma-io/archkeep/nx` (the `./nx` subpath, not the
// bare package — the bare package's `createDependencies` throws on purpose).

import { BOUNDARY_CONFIG } from "./boundary-law.mjs";

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function nxConsumerFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer",
        private: true,
        type: "module",
        packageManager,
        devDependencies: {
          [packageName]: "*",
          nx: peers.nx,
          typescript: peers.typescript,
        },
      },
      null,
      2,
    )}\n`,
    "nx.json": `${JSON.stringify(
      {
        plugins: [
          {
            plugin: `${packageName}/nx`,
            options: { boundaryConfig: "module-boundaries.config.mjs" },
          },
        ],
      },
      null,
      2,
    )}\n`,
    "module-boundaries.config.mjs": BOUNDARY_CONFIG,
    ".gitignore": "node_modules/\n.nx/\n",
    "libs/core/project.json": `${JSON.stringify(
      { name: "core", projectType: "library", tags: ["layer:core"] },
      null,
      2,
    )}\n`,
    "libs/core/go.mod": "module example.test/core\n\ngo 1.22\n",
    "libs/core/core.go": 'package core\n\nconst Name = "core"\n',
    "libs/app/project.json": `${JSON.stringify(
      { name: "app", projectType: "library", tags: ["layer:app"] },
      null,
      2,
    )}\n`,
    "libs/app/go.mod":
      "module example.test/app\n\ngo 1.22\n\nrequire example.test/core v0.0.0\n\n" +
      "replace example.test/core => ../core\n",
    "libs/app/app.go": 'package app\n\nimport "example.test/core"\n\nvar _ = core.Name\n',
  };
}

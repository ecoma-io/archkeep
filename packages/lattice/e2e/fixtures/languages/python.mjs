// Python language fixture: three packages with src-layout imports.
// Proves Python import discovery, dotted-module resolution, and
// `pyproject.toml` manifest dependency edges (uv `workspace = true`).
//
// Architecture:
//   domain (layer:domain)     — no imports from other packages
//   application (layer:application) — from domain import NAME
//   api (layer:api)          — from application import APP
//
// Uses the src-layout convention (`src/<package>/__init__.py`) which the
// Python analyzer supports. No Python runtime required — Lattice statically
// parses `.py` files and `pyproject.toml` manifests.

import { LAYERED_BOUNDARY_CONFIG } from "./boundary-law.mjs";

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function pythonLanguageFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-lang-python",
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

    // Domain — leaf package, src-layout.
    "libs/domain/pyproject.toml":
      '[project]\nname = "domain"\nversion = "0.1.0"\n\n' + "[tool.uv.sources]\n",
    "libs/domain/src/domain/__init__.py": 'NAME = "domain"\n',

    // Application — depends on domain via uv workspace source.
    "libs/application/pyproject.toml":
      '[project]\nname = "application"\nversion = "0.1.0"\ndependencies = ["domain"]\n\n' +
      "[tool.uv.sources]\ndomain = { workspace = true }\n",
    "libs/application/src/application/__init__.py": "from domain import NAME\n\nAPP = NAME\n",

    // Api — depends on application via uv workspace source.
    "libs/api/pyproject.toml":
      '[project]\nname = "api"\nversion = "0.1.0"\ndependencies = ["application"]\n\n' +
      "[tool.uv.sources]\napplication = { workspace = true }\n",
    "libs/api/src/api/__init__.py": "from application import APP\n\nAPI = APP\n",
  };
}

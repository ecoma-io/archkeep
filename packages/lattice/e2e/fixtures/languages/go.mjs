// Go language fixture: three modules with `application → domain` and
// `api → application` imports. Proves Go import discovery, module-path
// resolution, graph construction, and boundary enforcement.
//
// Architecture:
//   domain (layer:domain)     — no imports
//   application (layer:application) — imports domain
//   api (layer:api)          — imports application

import { LAYERED_BOUNDARY_CONFIG } from "./boundary-law.mjs";

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function goLanguageFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-lang-go",
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

    // Domain — leaf project, no Go imports beyond its own module.
    "libs/domain/go.mod": "module example.test/domain\n\ngo 1.22\n",
    "libs/domain/domain.go": 'package domain\n\nconst Name = "domain"\n',

    // Application — imports domain.
    "libs/application/go.mod":
      "module example.test/application\n\ngo 1.22\n\nrequire example.test/domain v0.0.0\n\n" +
      "replace example.test/domain => ../domain\n",
    "libs/application/application.go":
      'package application\n\nimport "example.test/domain"\n\nvar _ = domain.Name\n',

    // Api — imports application.
    "libs/api/go.mod":
      "module example.test/api\n\ngo 1.22\n\nrequire example.test/application v0.0.0\n\n" +
      "replace example.test/application => ../application\n",
    "libs/api/api.go":
      'package api\n\nimport "example.test/application"\n\nvar _ = application.Name\n',
  };
}

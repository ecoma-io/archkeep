// Architecture-Intent consumer fixture.
//
// A tiny workspace, small enough to live in one fixture, whose project set is
// identical across the native, Nx, and Moon providers: `libs/core` and
// `libs/app`. The intent file therefore uses bare **project names** as its
// boundary match selectors — the one selector form that resolves identically
// regardless of provider, so the SAME intent file judges the SAME verdict from
// the graph whichever provider discovered it.
//
// The native and Nx fixtures both tag `core` `layer:core` and `app`
// `layer:app`; intent boundaries are deliberately separate from the boundary
// policy tags, so this file uses `type-package`/`type-extension`-style intent
// boundaries matched by project name, carrying the boundary policy's own
// `layer:` tags untouched.

import { BOUNDARY_CONFIG } from "./boundary-law.mjs";

/** The declared architecture both consumers share. */
export function intentConsumerFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-intent",
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
    "archkeep.json": `${JSON.stringify(
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
    "architecture-intent.json": `${JSON.stringify(
      {
        version: "1",
        boundaries: [
          { name: "core", match: ["name:core"] },
          { name: "app", match: ["name:app"] },
        ],
        // The one relationship that really holds: `app` is allowed to import
        // `core`, and it does. `core` may not reach `app`.
        allowed: [{ from: "app", to: "core" }],
        forbidden: [{ from: "core", to: "app", reason: "core must never reach up" }],
      },
      null,
      2,
    )}\n`,
    ".gitignore": "node_modules/\n.nx/\n",
    "libs/core/go.mod": "module example.test/core\n\ngo 1.22\n",
    "libs/core/core.go": 'package core\n\nconst Name = "core"\n',
    "libs/app/go.mod":
      "module example.test/app\n\ngo 1.22\n\nrequire example.test/core v0.0.0\n\n" +
      "replace example.test/core => ../core\n",
    "libs/app/app.go": 'package app\n\nimport "example.test/core"\n\nvar _ = core.Name\n',
  };
}

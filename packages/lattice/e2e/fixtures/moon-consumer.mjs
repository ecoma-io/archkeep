// Moonrepo consumer workspace: four projects (web, api, core, cli) with
// `.moon/workspace.yml`, per-project `moon.yml` files, TypeScript and Go
// sources. No `nx` dependency, no `lattice.json`.
//
// The Moon provider discovers the workspace via `.moon/` and reads the project
// graph from `moon project-graph --json` — the same one-call contract as the
// Nx provider, but without Nx installed. Tags come from `moon.yml` rather than
// from `project.json` or `lattice.json`.
//
// The `pnpm-workspace.yaml` lists `apps/*` and `libs/*` so `workspace:*`
// protocol references in project `package.json` files resolve during
// `pnpm install`.
//
// Architecture:
//   web  (type-app, app)  — imports api (TypeScript)
//   cli  (type-app, lib)  — standalone library tagged type-app, no deps
//   api  (type-lib, lib)  — imports core (TypeScript + Go)
//   core (type-lib, lib)  — leaf project
//
// The `cli` project exists so the `MOON_LIB_REACHES_APP` violation fixture can
// make `core` import from a project carrying `type-app` but not `type-lib`.
// It MUST be a library (`layer: library`), not an application: `noImportsOfApps`
// fires before the tag constraint check, so a target with `type: "app"` would
// produce `noImportsOfApps` instead of `onlyTagsConstraintViolation`. By making
// `cli` a library with the `type-app` tag, the app-import check is bypassed and
// the tag constraint violation surfaces. `cli` has no `dependsOn`, so `core →
// cli` is acyclic and `noCircularDependencies` does not fire either.

import { MOON_BOUNDARY_CONFIG } from "./boundary-law.mjs";

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function moonConsumerFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-moon",
        private: true,
        type: "module",
        packageManager,
        // No `nx` — the peer is optional.
        devDependencies: {
          [packageName]: "*",
          typescript: peers.typescript,
          // Moon CLI is needed at runtime so the Moon provider can call
          // `moon project-graph --json`. It is not a peer dependency of
          // @ecoma-io/lattice — the provider finds `moon` via PATH.
          "@moonrepo/cli": "2.4.6",
        },
      },
      null,
      2,
    )}\n`,
    "pnpm-workspace.yaml":
      "packages:\n  - 'apps/*'\n  - 'libs/*'\nallowBuilds:\n  lefthook: false\n",
    ".moon/workspace.yml":
      "projects:\n" +
      "  web: 'apps/web'\n" +
      "  cli: 'libs/cli'\n" +
      "  api: 'libs/api'\n" +
      "  core: 'libs/core'\n" +
      "vcs:\n" +
      "  provider: other\n",
    "apps/web/moon.yml":
      "id: web\n" +
      "language: typescript\n" +
      "layer: application\n" +
      "stack: frontend\n" +
      "tags:\n" +
      "  - type-app\n" +
      "  - lang-ts\n" +
      "dependsOn:\n" +
      "  - api\n" +
      "tasks:\n" +
      "  build:\n" +
      "    command: 'echo build web'\n",
    "libs/cli/moon.yml":
      "id: cli\n" +
      "language: typescript\n" +
      "layer: library\n" +
      "stack: backend\n" +
      "tags:\n" +
      "  - type-app\n" +
      "  - lang-ts\n" +
      "tasks:\n" +
      "  build:\n" +
      "    command: 'echo build cli'\n",
    "libs/api/moon.yml":
      "id: api\n" +
      "language: typescript\n" +
      "layer: library\n" +
      "stack: backend\n" +
      "tags:\n" +
      "  - type-lib\n" +
      "  - lang-ts\n" +
      "dependsOn:\n" +
      "  - core\n" +
      "tasks:\n" +
      "  build:\n" +
      "    command: 'echo build api'\n",
    "libs/core/moon.yml":
      "id: core\n" +
      "language: typescript\n" +
      "layer: library\n" +
      "stack: backend\n" +
      "tags:\n" +
      "  - type-lib\n" +
      "  - lang-ts\n",
    "tsconfig.base.json": `${JSON.stringify(
      {
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          paths: {
            "@acme/web": ["./apps/web/src/main.ts"],
            "@acme/cli": ["./libs/cli/src/index.ts"],
            "@acme/api": ["./libs/api/src/index.ts"],
            "@acme/core": ["./libs/core/src/index.ts"],
          },
        },
      },
      null,
      2,
    )}\n`,
    "module-boundaries.config.mjs": MOON_BOUNDARY_CONFIG,
    ".gitignore": "node_modules/\n.moon/cache/\n",

    // TypeScript sources.
    "apps/web/src/main.ts": 'import { api } from "@acme/api";\n\nexport const app = api;\n',
    "libs/cli/src/index.ts": 'export const cli = "cli";\n',
    "libs/api/src/index.ts": 'import { core } from "@acme/core";\n\nexport const api = core;\n',
    "libs/core/src/index.ts": 'export const core = "core";\n',

    // Go modules.
    "libs/core/go.mod": "module acme.test/core\n\ngo 1.22\n",
    "libs/core/core.go": 'package core\n\nconst Name = "core"\n',
    "libs/api/go.mod":
      "module acme.test/api\n\ngo 1.22\n\nrequire acme.test/core v0.0.0\n\n" +
      "replace acme.test/core => ../core\n",
    "libs/api/api.go": 'package api\n\nimport "acme.test/core"\n\nvar _ = core.Name\n',

    // Package manifests — `workspace:*` resolves via `pnpm-workspace.yaml`.
    "apps/web/package.json": `${JSON.stringify(
      { name: "@acme/web", dependencies: { "@acme/api": "workspace:*" } },
      null,
      2,
    )}\n`,
    "libs/cli/package.json": `${JSON.stringify({ name: "@acme/cli" }, null, 2)}\n`,
    "libs/api/package.json": `${JSON.stringify(
      { name: "@acme/api", dependencies: { "@acme/core": "workspace:*" } },
      null,
      2,
    )}\n`,
    "libs/core/package.json": `${JSON.stringify({ name: "@acme/core" }, null, 2)}\n`,
  };
}

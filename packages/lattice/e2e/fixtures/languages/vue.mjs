// Vue language fixture: three projects with `.vue` SFCs using
// `<script setup lang="ts">`. Proves Vue SFC import discovery — the
// `vue/compiler-sfc` parser locates `<script>` blocks, blanks everything
// outside them, and hands the code to the TypeScript analyzer.
//
// Requires `vue` in devDependencies so `vue/compiler-sfc` resolves via
// `createRequire` — the lazy-load path that must work end-to-end.
//
// Architecture:
//   domain (layer:domain)     — plain TypeScript export (no .vue)
//   application (layer:application) — .vue SFC importing domain
//   api (layer:api)          — .vue SFC importing application

import { LAYERED_BOUNDARY_CONFIG } from "./boundary-law.mjs";

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function vueLanguageFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-lang-vue",
        private: true,
        type: "module",
        packageManager,
        devDependencies: {
          [packageName]: "*",
          typescript: peers.typescript,
          vue: peers.vue,
        },
      },
      null,
      2,
    )}\n`,

    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          paths: {
            "@example/domain": ["./libs/domain/src/index.ts"],
            "@example/application": ["./libs/application/src/index.ts"],
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

    // Domain — plain TypeScript export (no .vue needed at this layer).
    "libs/domain/src/index.ts": 'export const name: string = "domain";\n',

    // Application — a TypeScript barrel plus a Vue SFC that imports from domain.
    "libs/application/src/index.ts": 'export const label: string = "app";\n',
    "libs/application/src/App.vue":
      '<script setup lang="ts">\n' +
      'import { name } from "@example/domain";\n\n' +
      "const appLabel = name;\n" +
      "</script>\n" +
      "<template>\n" +
      "  <div>{{ appLabel }}</div>\n" +
      "</template>\n",

    // Api — a Vue SFC that imports from application.
    "libs/api/src/View.vue":
      '<script setup lang="ts">\n' +
      'import { label } from "@example/application";\n\n' +
      "const view = label;\n" +
      "</script>\n" +
      "<template>\n" +
      "  <span>{{ view }}</span>\n" +
      "</template>\n",
  };
}

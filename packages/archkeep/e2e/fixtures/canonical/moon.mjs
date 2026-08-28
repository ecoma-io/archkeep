// The canonical architecture as a Moonrepo consumer workspace: four
// TypeScript projects under `libs/`, discovered through `.moon/workspace.yml`.
// `dependsOn` is Moon's declared edge channel and `@canonical/*` imports
// resolved through `tsconfig.base.json` paths are the analysis channel — both
// agree with the canonical diagram, so the engine's per-pair dedupe must
// collapse them to ONE edge per pair (the dual-track contract, asserted e2e
// for the first time by this fixture).
//
// The `mutations` map cuts or adds BOTH channels together, so an expected
// removed edge is removed from every evidence source at once.

import { CANONICAL_BOUNDARY_CONFIG } from "../../helpers/canonical.mjs";

const CORE_TS = 'export const core = "core";\n';

const INFRASTRUCTURE_TS = 'export const infrastructure = "infrastructure";\n';

const APPLICATION_TS = `import { core } from "@canonical/core";
import { infrastructure } from "@canonical/infrastructure";

export const application = \`\${core}/\${infrastructure}\`;
`;

const API_TS = `import { application } from "@canonical/application";

export const api = application;
`;

const APPLICATION_TS_WITHOUT_INFRASTRUCTURE = `import { core } from "@canonical/core";

export const application = core;
`;

/** One `moon.yml`: id, language, tags, and the declared `dependsOn` list. */
const moonYml = (id, tags, dependsOn = []) => {
  let text = `id: ${id}\nlanguage: typescript\ntags:\n${tags
    .map((tag) => `  - ${tag}`)
    .join("\n")}\n`;
  if (dependsOn.length > 0) {
    text += `dependsOn:\n${dependsOn.map((dep) => `  - ${dep}`).join("\n")}\n`;
  }
  text += `tasks:\n  build:\n    command: 'echo build ${id}'\n`;
  return `${text}\n`;
};
/** One per-project `package.json` with its workspace dependencies. */
const projectPackageJson = (name, dependencies = {}) =>
  `${JSON.stringify(
    Object.keys(dependencies).length === 0 ? { name } : { name, dependencies },
    null,
    2,
  )}\n`;

const commented = (source) => `${source}\n// noop: a comment moves no edge.\n`;

const patch = (files, entries) => ({ ...files, ...entries });

const omit = (files, relatives) =>
  Object.fromEntries(Object.entries(files).filter(([relative]) => !relatives.includes(relative)));

const WORKSPACE_YML = `projects:
  core: 'libs/core'
  infrastructure: 'libs/infrastructure'
  application: 'libs/application'
  api: 'libs/api'
vcs:
  provider: other
`;

const TOOLING_FILES = {
  "libs/tooling/moon.yml": moonYml("tooling", ["layer/tooling"]),
  "libs/tooling/package.json": projectPackageJson("@canonical/tooling"),
  "libs/tooling/src/index.ts": 'export const tooling = "tooling";\n',
};

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function canonicalMoonFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-canonical-moon",
        private: true,
        type: "module",
        packageManager,
        // No `nx` — the peer is optional. The archkeep devDependency is
        // first so `fixtureFiles` swaps the one `"*"` for the tarball.
        // The Moon CLI is a runtime need of the provider (`moon
        // project-graph --json`), found via PATH, not a peer.
        devDependencies: {
          [packageName]: "*",
          typescript: peers.typescript,
          "@moonrepo/cli": "2.4.6",
        },
      },
      null,
      2,
    )}\n`,
    "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\nallowBuilds:\n  lefthook: false\n",
    ".moon/workspace.yml": WORKSPACE_YML,
    "tsconfig.base.json": `${JSON.stringify(
      {
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          paths: {
            "@canonical/core": ["./libs/core/src/index.ts"],
            "@canonical/infrastructure": ["./libs/infrastructure/src/index.ts"],
            "@canonical/application": ["./libs/application/src/index.ts"],
            "@canonical/api": ["./libs/api/src/index.ts"],
          },
        },
      },
      null,
      2,
    )}\n`,
    "module-boundaries.config.mjs": CANONICAL_BOUNDARY_CONFIG,
    ".gitignore": "node_modules/\n.moon/cache/\n",
    "libs/core/moon.yml": moonYml("core", ["layer/core"]),
    "libs/core/package.json": projectPackageJson("@canonical/core"),
    "libs/core/src/index.ts": CORE_TS,
    "libs/infrastructure/moon.yml": moonYml("infrastructure", ["layer/infrastructure"]),
    "libs/infrastructure/package.json": projectPackageJson("@canonical/infrastructure"),
    "libs/infrastructure/src/index.ts": INFRASTRUCTURE_TS,
    "libs/application/moon.yml": moonYml(
      "application",
      ["layer/application"],
      ["core", "infrastructure"],
    ),
    "libs/application/package.json": projectPackageJson("@canonical/application", {
      "@canonical/core": "workspace:*",
      "@canonical/infrastructure": "workspace:*",
    }),
    "libs/application/src/index.ts": APPLICATION_TS,
    "libs/api/moon.yml": moonYml("api", ["layer/api"], ["application"]),
    "libs/api/package.json": projectPackageJson("@canonical/api", {
      "@canonical/application": "workspace:*",
    }),
    "libs/api/src/index.ts": API_TS,
  };
}

/** The mutation transforms — registry rows in `./mutations.mjs`. */
export const mutations = {
  "noop-comment": (files) =>
    patch(files, {
      "libs/core/src/index.ts": commented(CORE_TS),
      "libs/infrastructure/src/index.ts": commented(INFRASTRUCTURE_TS),
      "libs/application/src/index.ts": commented(APPLICATION_TS),
      "libs/api/src/index.ts": commented(API_TS),
    }),

  "noop-whitespace": (files) =>
    patch(files, {
      "libs/application/src/index.ts": `import { core } from "@canonical/core";
import { infrastructure } from "@canonical/infrastructure";


export const application = \`\${core}/\${infrastructure}\`;

`,
    }),

  "noop-reorder": (files) =>
    patch(files, {
      "libs/application/src/index.ts": `import { infrastructure } from "@canonical/infrastructure";
import { core } from "@canonical/core";

export const application = \`\${core}/\${infrastructure}\`;
`,
      "libs/application/moon.yml": moonYml(
        "application",
        ["layer/application"],
        ["infrastructure", "core"],
      ),
    }),

  // Both channels at once: the TypeScript import carries the pair as
  // `static`, and the `dependsOn` entry as `implicit` — the same dual-record
  // shape the clean fixture's every edge has, so the diff moves two records.
  "add-edge-api-core": (files) =>
    patch(files, {
      "libs/api/src/index.ts": `import { application } from "@canonical/application";
import { core } from "@canonical/core";

export const api = application;

export const layer = core;
`,
      "libs/api/moon.yml": moonYml("api", ["layer/api"], ["application", "core"]),
      "libs/api/package.json": projectPackageJson("@canonical/api", {
        "@canonical/application": "workspace:*",
        "@canonical/core": "workspace:*",
      }),
    }),

  // Every channel carrying application→infrastructure is cut at once:
  // the import, Moon's `dependsOn`, and the workspace dependency.
  "remove-edge-application-infrastructure": (files) =>
    patch(files, {
      "libs/application/src/index.ts": APPLICATION_TS_WITHOUT_INFRASTRUCTURE,
      "libs/application/moon.yml": moonYml("application", ["layer/application"], ["core"]),
      "libs/application/package.json": projectPackageJson("@canonical/application", {
        "@canonical/core": "workspace:*",
      }),
    }),

  "reverse-application-core": (files) =>
    patch(files, {
      "libs/core/src/index.ts": `import { application } from "@canonical/application";

export const core = application;
`,
      "libs/core/moon.yml": moonYml("core", ["layer/core"], ["application"]),
      "libs/core/package.json": projectPackageJson("@canonical/core", {
        "@canonical/application": "workspace:*",
      }),
      "libs/application/src/index.ts": `import { infrastructure } from "@canonical/infrastructure";

export const application = infrastructure;
`,
      "libs/application/moon.yml": moonYml(
        "application",
        ["layer/application"],
        ["infrastructure"],
      ),
      "libs/application/package.json": projectPackageJson("@canonical/application", {
        "@canonical/infrastructure": "workspace:*",
      }),
    }),

  "infrastructure-reaches-application": (files) =>
    patch(files, {
      "libs/infrastructure/src/index.ts": `import { application } from "@canonical/application";

export const infrastructure = application;
`,
      "libs/infrastructure/moon.yml": moonYml(
        "infrastructure",
        ["layer/infrastructure"],
        ["application"],
      ),
      "libs/infrastructure/package.json": projectPackageJson("@canonical/infrastructure", {
        "@canonical/application": "workspace:*",
      }),
    }),

  "add-project-tooling": (files) =>
    patch(files, {
      ".moon/workspace.yml": `${WORKSPACE_YML.replace(
        "  api: 'libs/api'",
        "  api: 'libs/api'\n  tooling: 'libs/tooling'",
      )}`,
      "tsconfig.base.json": `${JSON.stringify(
        {
          compilerOptions: {
            module: "nodenext",
            moduleResolution: "nodenext",
            paths: {
              "@canonical/core": ["./libs/core/src/index.ts"],
              "@canonical/infrastructure": ["./libs/infrastructure/src/index.ts"],
              "@canonical/application": ["./libs/application/src/index.ts"],
              "@canonical/api": ["./libs/api/src/index.ts"],
              "@canonical/tooling": ["./libs/tooling/src/index.ts"],
            },
          },
        },
        null,
        2,
      )}\n`,
      ...TOOLING_FILES,
    }),

  "remove-project-infrastructure": (files) =>
    patch(
      omit(files, [
        "libs/infrastructure/moon.yml",
        "libs/infrastructure/package.json",
        "libs/infrastructure/src/index.ts",
      ]),
      {
        ".moon/workspace.yml": `${WORKSPACE_YML.replace("  infrastructure: 'libs/infrastructure'\n", "")}`,
        "tsconfig.base.json": `${JSON.stringify(
          {
            compilerOptions: {
              module: "nodenext",
              moduleResolution: "nodenext",
              paths: {
                "@canonical/core": ["./libs/core/src/index.ts"],
                "@canonical/application": ["./libs/application/src/index.ts"],
                "@canonical/api": ["./libs/api/src/index.ts"],
              },
            },
          },
          null,
          2,
        )}\n`,
        "libs/application/src/index.ts": APPLICATION_TS_WITHOUT_INFRASTRUCTURE,
        "libs/application/moon.yml": moonYml("application", ["layer/application"], ["core"]),
        "libs/application/package.json": projectPackageJson("@canonical/application", {
          "@canonical/core": "workspace:*",
        }),
      },
    ),
};

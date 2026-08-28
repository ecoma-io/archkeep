// The canonical architecture as an Nx consumer workspace: the same four Go
// projects and sources as `./native.mjs`, but discovered through `nx.json`
// plus per-project `project.json` files — `@ecoma-io/archkeep/nx` supplies
// the polyglot edges, Nx supplies the nodes, and no `archkeep.json` exists.
//
// The `mutations` map is transform-for-transform identical to the native
// fixture's (project add/remove touch `project.json` rows instead of
// `archkeep.json`), which is what makes native↔Nx parity a meaningful
// comparison: same architecture, same mutations, different config language.

import { CANONICAL_BOUNDARY_CONFIG, canonicalTags } from "../../helpers/canonical.mjs";

const CORE_GO = `package core

const Name = "core"
`;

const INFRASTRUCTURE_GO = `package infrastructure

const Region = "eu-west-1"
`;

const APPLICATION_GO = `package application

import (
\t"canonical.test/core"
\t"canonical.test/infrastructure"
)

// Service composes the two layers below it.
var Service = core.Name + "/" + infrastructure.Region
`;

const API_GO = `package api

import "canonical.test/application"

// Handler reaches down exactly one layer.
var Handler = application.Service
`;

const APPLICATION_GO_WITHOUT_INFRASTRUCTURE = `package application

import "canonical.test/core"

// Service composes the one layer still below it.
var Service = core.Name
`;

const goMod = (modulePath, requires = [], replaces = []) => {
  const sections = [`module ${modulePath}`, "go 1.22"];
  if (requires.length > 0) {
    sections.push(requires.map((requirement) => `require ${requirement} v0.0.0`).join("\n"));
  }
  if (replaces.length > 0) {
    sections.push(replaces.map(([from, to]) => `replace ${from} => ${to}`).join("\n"));
  }
  return `${sections.join("\n\n")}\n`;
};

/** One `project.json`: name, library type, and the canonical layer tag. */
const projectJson = (name) =>
  `${JSON.stringify({ name, projectType: "library", tags: canonicalTags(name) }, null, 2)}\n`;

const commented = (source) => `${source}\n// noop: a comment moves no edge.\n`;

const patch = (files, entries) => ({ ...files, ...entries });

const omit = (files, relatives) =>
  Object.fromEntries(Object.entries(files).filter(([relative]) => !relatives.includes(relative)));

const TOOLING_FILES = {
  "libs/tooling/project.json": projectJson("tooling"),
  "libs/tooling/go.mod": goMod("canonical.test/tooling"),
  "libs/tooling/tooling.go": `package tooling

const Version = "0"
`,
};

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function canonicalNxFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-canonical-nx",
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
    "module-boundaries.config.mjs": CANONICAL_BOUNDARY_CONFIG,
    ".gitignore": "node_modules/\n.nx/\n",
    "libs/core/project.json": projectJson("core"),
    "libs/core/go.mod": goMod("canonical.test/core"),
    "libs/core/core.go": CORE_GO,
    "libs/infrastructure/project.json": projectJson("infrastructure"),
    "libs/infrastructure/go.mod": goMod("canonical.test/infrastructure"),
    "libs/infrastructure/infrastructure.go": INFRASTRUCTURE_GO,
    "libs/application/project.json": projectJson("application"),
    "libs/application/go.mod": goMod(
      "canonical.test/application",
      ["canonical.test/core", "canonical.test/infrastructure"],
      [
        ["canonical.test/core", "../core"],
        ["canonical.test/infrastructure", "../infrastructure"],
      ],
    ),
    "libs/application/application.go": APPLICATION_GO,
    "libs/api/project.json": projectJson("api"),
    "libs/api/go.mod": goMod(
      "canonical.test/api",
      ["canonical.test/application"],
      [["canonical.test/application", "../application"]],
    ),
    "libs/api/api.go": API_GO,
  };
}

/** The mutation transforms — registry rows in `./mutations.mjs`. */
export const mutations = {
  "noop-comment": (files) =>
    patch(files, {
      "libs/core/core.go": commented(CORE_GO),
      "libs/infrastructure/infrastructure.go": commented(INFRASTRUCTURE_GO),
      "libs/application/application.go": commented(APPLICATION_GO),
      "libs/api/api.go": commented(API_GO),
    }),

  "noop-whitespace": (files) =>
    patch(files, {
      "libs/application/application.go": `package application

import (
\t"canonical.test/core"
\t"canonical.test/infrastructure"
)


// Service composes the two layers below it.

var Service = core.Name + "/" + infrastructure.Region

`,
    }),

  "noop-reorder": (files) =>
    patch(files, {
      "libs/application/application.go": `package application

import (
\t"canonical.test/infrastructure"
\t"canonical.test/core"
)

// Service composes the two layers below it.
var Service = core.Name + "/" + infrastructure.Region
`,
      "libs/application/go.mod": goMod(
        "canonical.test/application",
        ["canonical.test/infrastructure", "canonical.test/core"],
        [
          ["canonical.test/infrastructure", "../infrastructure"],
          ["canonical.test/core", "../core"],
        ],
      ),
    }),

  "add-edge-api-core": (files) =>
    patch(files, {
      "libs/api/api.go": `package api

import (
\t"canonical.test/application"
\t"canonical.test/core"
)

// Handler reaches down exactly one layer.
var Handler = application.Service

// Layer reaches two layers down — allowed by the law, and exactly one new edge.
var Layer = core.Name
`,
      "libs/api/go.mod": goMod(
        "canonical.test/api",
        ["canonical.test/application", "canonical.test/core"],
        [
          ["canonical.test/application", "../application"],
          ["canonical.test/core", "../core"],
        ],
      ),
    }),

  "remove-edge-application-infrastructure": (files) =>
    patch(files, {
      "libs/application/application.go": APPLICATION_GO_WITHOUT_INFRASTRUCTURE,
      "libs/application/go.mod": goMod(
        "canonical.test/application",
        ["canonical.test/core"],
        [["canonical.test/core", "../core"]],
      ),
    }),

  "reverse-application-core": (files) =>
    patch(files, {
      "libs/core/core.go": `package core

import "canonical.test/application"

// Name now reaches upward — a violation of the law, not of the syntax.
var Name = application.Service
`,
      "libs/core/go.mod": goMod(
        "canonical.test/core",
        ["canonical.test/application"],
        [["canonical.test/application", "../application"]],
      ),
      "libs/application/application.go": `package application

import "canonical.test/infrastructure"

// Service composes the other layer still below it.
var Service = infrastructure.Region
`,
      "libs/application/go.mod": goMod(
        "canonical.test/application",
        ["canonical.test/infrastructure"],
        [["canonical.test/infrastructure", "../infrastructure"]],
      ),
    }),

  "infrastructure-reaches-application": (files) =>
    patch(files, {
      "libs/infrastructure/infrastructure.go": `package infrastructure

import "canonical.test/application"

// Region now reaches upward into the application layer.
var Region = application.Service
`,
      "libs/infrastructure/go.mod": goMod(
        "canonical.test/infrastructure",
        ["canonical.test/application"],
        [["canonical.test/application", "../application"]],
      ),
    }),

  "add-project-tooling": (files) => patch(files, TOOLING_FILES),

  "remove-project-infrastructure": (files) =>
    patch(
      omit(files, [
        "libs/infrastructure/project.json",
        "libs/infrastructure/go.mod",
        "libs/infrastructure/infrastructure.go",
      ]),
      {
        "libs/application/application.go": APPLICATION_GO_WITHOUT_INFRASTRUCTURE,
        "libs/application/go.mod": goMod(
          "canonical.test/application",
          ["canonical.test/core"],
          [["canonical.test/core", "../core"]],
        ),
      },
    ),
};

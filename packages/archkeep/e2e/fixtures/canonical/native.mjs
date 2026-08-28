// The canonical architecture as a native consumer workspace: four Go
// projects declared in `archkeep.json`, one boundary law, no `nx`.
//
// Topology (see `../../helpers/canonical.mjs`):
//
//   core ← application ← api
//            │
//            └→ infrastructure
//
// Every `mutations` entry is a pure transform of this fixture's file map to
// the mutated tree. The expectations each mutation must produce — the exact
// delta and whether the law flags a violation — live in `./mutations.mjs`
// under the same names; a transform may never disagree with its registry row.

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

/**
 * One Go module file. `requires` are module paths, `replaces` are
 * `[from, to]` pairs — one line each, the same spelling the other Go
 * fixtures use.
 *
 * @param {string} modulePath The module's own path.
 * @param {string[]} [requires] Required module paths.
 * @param {Array<[string, string]>} [replaces] Module path → relative directory.
 * @returns {string} go.mod contents.
 */
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

/** The canonical `projects.declared` rows, tags included. */
const CANONICAL_ROWS = [
  { root: "libs/core", name: "core", tags: canonicalTags("core") },
  { root: "libs/infrastructure", name: "infrastructure", tags: canonicalTags("infrastructure") },
  { root: "libs/application", name: "application", tags: canonicalTags("application") },
  { root: "libs/api", name: "api", tags: canonicalTags("api") },
];

/**
 * @param {Array<{root: string, name: string, tags: string[]}>} projectRows
 *   The declared rows the config carries.
 * @returns {string} archkeep.json contents.
 */
const archkeepConfig = (projectRows) =>
  `${JSON.stringify(
    {
      boundaryConfig: "module-boundaries.config.mjs",
      projects: { declared: projectRows },
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
  )}\n`;

/** Adds a trailing comment to one Go source — graph-invisible by contract. */
const commented = (source) => `${source}\n// noop: a comment moves no edge.\n`;

/** Merges entries into a file map. */
const patch = (files, entries) => ({ ...files, ...entries });

/** Drops relative paths from a file map. */
const omit = (files, relatives) =>
  Object.fromEntries(Object.entries(files).filter(([relative]) => !relatives.includes(relative)));

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function canonicalNativeFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-canonical-native",
        private: true,
        type: "module",
        packageManager,
        // No `nx` — the peer is optional. The archkeep devDependency is
        // first so `fixtureFiles` swaps the one `"*"` for the tarball.
        devDependencies: {
          [packageName]: "*",
          typescript: peers.typescript,
        },
      },
      null,
      2,
    )}\n`,
    "archkeep.json": archkeepConfig(CANONICAL_ROWS),
    "module-boundaries.config.mjs": CANONICAL_BOUNDARY_CONFIG,
    ".gitignore": "node_modules/\n",
    "libs/core/go.mod": goMod("canonical.test/core"),
    "libs/core/core.go": CORE_GO,
    "libs/infrastructure/go.mod": goMod("canonical.test/infrastructure"),
    "libs/infrastructure/infrastructure.go": INFRASTRUCTURE_GO,
    "libs/application/go.mod": goMod(
      "canonical.test/application",
      ["canonical.test/core", "canonical.test/infrastructure"],
      [
        ["canonical.test/core", "../core"],
        ["canonical.test/infrastructure", "../infrastructure"],
      ],
    ),
    "libs/application/application.go": APPLICATION_GO,
    "libs/api/go.mod": goMod(
      "canonical.test/api",
      ["canonical.test/application"],
      [["canonical.test/application", "../application"]],
    ),
    "libs/api/api.go": API_GO,
  };
}

/**
 * The mutation transforms, keyed by the registry names in `./mutations.mjs`.
 * Each takes the clean file map and returns the mutated tree — a pure
 * function, so a suite can diff the maps to know which files to rewrite.
 *
 * @type {Record<string, (files: Record<string, string>) => Record<string, string>>}
 */
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

  // Reversing one edge means moving its import to the other project: the
  // old pair must disappear, not sit beside the new one.
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

  "add-project-tooling": (files) =>
    patch(files, {
      "archkeep.json": archkeepConfig([
        ...CANONICAL_ROWS,
        { root: "libs/tooling", name: "tooling", tags: canonicalTags("tooling") },
      ]),
      "libs/tooling/go.mod": goMod("canonical.test/tooling"),
      "libs/tooling/tooling.go": `package tooling

const Version = "0"
`,
    }),

  // The infrastructure row, sources, and the application side's import all
  // go together — removing a project removes its edges with it.
  "remove-project-infrastructure": (files) =>
    patch(omit(files, ["libs/infrastructure/go.mod", "libs/infrastructure/infrastructure.go"]), {
      "archkeep.json": archkeepConfig(
        CANONICAL_ROWS.filter((row) => row.name !== "infrastructure"),
      ),
      "libs/application/application.go": APPLICATION_GO_WITHOUT_INFRASTRUCTURE,
      "libs/application/go.mod": goMod(
        "canonical.test/application",
        ["canonical.test/core"],
        [["canonical.test/core", "../core"]],
      ),
    }),
};

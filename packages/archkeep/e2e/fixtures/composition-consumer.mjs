import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A feature-sliced Nx workspace with official generic rule composition.
//
// This fixture proves that shipped presets, official custom rules, and fitness
// functions all compose in a single `check` run. The workspace:
// - Selects the shipped vertical-slice preset via nx.json's `profiles` option
// - Declares a tag-cardinality rule limiting feature: tags to exactly 1 per project
// - Declares the slice-isolation fitness function from the existing fitness e2e
//
// The three-layer journey proves:
// 1. Clean tree (all three layers pass)
// 2. Boundary violation from preset constraint rows (kernel → slice is banned)
// 3. Custom rule violation (double feature: tag on one project)
// 4. Both violations simultaneously (boundary + rule, exit 1 with both findings)
// 5. Clean tree again (fix both violations)
//
// Why vertical-slice: Its constraint rows ban `layer:shared-kernel → layer:slice`,
// which is easy to create as a violation by adding a kernel import to a slice.
//
// Why tag-cardinality: It's the simplest official rule to demonstrate composition,
// with clear semantics (one feature: per slice) that complement the preset.

/** Read the sha256 from the rule's sidecar file at fixture load time. */
export const TAG_CARDINALITY_SHA256 = readFileSync(
  resolve(
    fileURLToPath(import.meta.url),
    "../../../../archkeep-rules/rules/tag-cardinality.wasm.sha256",
  ),
  "utf-8",
).trim();

/** Nx project graph: load profile + declare custom rules in same boundary config. */
export const NX_JSON = `{
  "extends": "nx/presets/npm.json",
  "tasksRunnerOptions": {
    "default": {
      "runner": "nx/tasks-runners/default",
      "options": {
        "cacheableOperations": ["build"]
      }
    }
  },
  "plugins": [
    {
      "plugin": "@ecoma-io/archkeep/nx",
      "options": {
        "boundaryConfig": "module-boundaries.config.mjs",
        "tsConfig": "tsconfig.base.json"
      }
    }
  ]
}
`;

/** Workspace boundary config: preset constraints + custom rule + fitness function. */
export const BOUNDARY_CONFIG = `export const depConstraints = [
  {
    sourceTag: "layer:slice",
    onlyDependOnLibsWithTags: ["layer:slice", "layer:shared-kernel"],
    description: "A slice owns its whole stack. The only thing it may reach outside itself is the shared kernel — and which slice it may reach is the feature: axis's question, not this row's.",
    remediation: "Move the collaborator into this slice, or promote the shared piece into layer:shared-kernel where every slice may see it."
  },
  {
    sourceTag: "layer:shared-kernel",
    onlyDependOnLibsWithTags: ["layer:shared-kernel"],
    description: "Everything depends on the kernel, so anything the kernel depends on is shared by every slice whether or not that slice asked.",
    remediation: "A kernel project reaching into a slice has made that slice part of the kernel; move the code, or move the dependency into the slice."
  }
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: true,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const boundarySuppressions = [];
export const fitness = [
  {
    name: "slice-isolation",
    match: ["tag:layer:slice"],
    condition: { type: "tag-axis-isolation", axis: "feature" },
    reason:
      "A slice owns its whole stack. Two slices coupling directly is the one thing this architecture is for, and the constraint rows above cannot see it: both sides carry layer:slice.",
  },
];

export const customRules = [
  {
    name: "tag-cardinality",
    artifact: "tools/rules/tag-cardinality.wasm",
    sha256: "${TAG_CARDINALITY_SHA256}",
    params: {
      axis: "feature",
      max: 1,
      match: ["layer:slice"],
    },
    reason:
      "Every slice owns exactly one feature context. A slice carrying multiple feature: tags is either miscategorized or represents a boundary violation the constraint rows cannot see.",
  },
];
`;

/** Project tags: each slice has layer:slice + exactly one feature: tag. */
export function projectTags({ doubleFeature = false } = {}) {
  const ordersTags = doubleFeature
    ? '["layer:slice", "feature:orders", "feature:catalog"]'
    : '["layer:slice", "feature:orders"]';
  return `{
    "declared": [
      { "root": "libs/orders", "name": "orders", "tags": ${ordersTags} },
      { "root": "libs/catalog", "name": "catalog", "tags": ["layer:slice", "feature:catalog"] },
      { "root": "libs/billing", "name": "billing", "tags": ["layer:slice", "feature:billing"] },
      { "root": "libs/kernel", "name": "kernel", "tags": ["layer:shared-kernel"] }
    ]
  }
`;
}

/** Go module files for clean vs boundary-violating states. */
export function goModuleFiles({ violatesBoundary = false, doubleFeature = false } = {}) {
  const kernelReachesSlice = violatesBoundary
    ? 'package kernel\n\nimport _ "example.test/orders"\n'
    : 'package kernel\n\nconst Name = "kernel"\n';

  const ordersTags = doubleFeature
    ? ["layer:slice", "feature:orders", "feature:catalog"]
    : ["layer:slice", "feature:orders"];

  // Clean state: orders → kernel (allowed by preset: slice may depend on shared-kernel)
  // Violating state: orders → nothing (breaks cycle when kernel imports catalog)
  const ordersImports = violatesBoundary
    ? 'package orders\n\nconst Name = "orders"\n'
    : 'package orders\n\nimport _ "example.test/kernel"\nconst Name = "orders"\n';

  return {
    "libs/kernel/go.mod": "module example.test/kernel\n\ngo 1.22\n",
    "libs/kernel/kernel.go": kernelReachesSlice,
    "libs/kernel/project.json": JSON.stringify({
      name: "kernel",
      tags: ["layer:shared-kernel"],
    }),

    "libs/orders/go.mod": "module example.test/orders\n\ngo 1.22\n",
    "libs/orders/orders.go": ordersImports,
    "libs/orders/project.json": JSON.stringify({
      name: "orders",
      tags: ordersTags,
    }),

    "libs/catalog/go.mod": "module example.test/catalog\n\ngo 1.22\n",
    "libs/catalog/catalog.go": 'package catalog\n\nconst Name = "catalog"\n',
    "libs/catalog/project.json": JSON.stringify({
      name: "catalog",
      tags: ["layer:slice", "feature:catalog"],
    }),

    "libs/billing/go.mod": "module example.test/billing\n\ngo 1.22\n",
    "libs/billing/billing.go": 'package billing\n\nconst Name = "billing"\n',
    "libs/billing/project.json": JSON.stringify({
      name: "billing",
      tags: ["layer:slice", "feature:billing"],
    }),
  };
}

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function compositionFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-composition",
        private: true,
        type: "module",
        packageManager,
        devDependencies: {
          [packageName]: "*",
          typescript: peers.typescript,
          nx: "*",
        },
      },
      null,
      2,
    )}\n`,

    "nx.json": NX_JSON,

    "module-boundaries.config.mjs": BOUNDARY_CONFIG,

    ".gitignore": "node_modules/\n.nx/\n",

    "tsconfig.base.json": `{
  "compilerOptions": {
    "module": "commonjs",
    "esModuleInterop": true,
    "strict": true
  }
}
`,

    ...goModuleFiles(),
  };
}

// A feature-sliced native workspace, for the fitness journey.
//
// Every slice carries the SAME `layer:slice` tag and a different `feature:`
// value. That is the shape the constraint table structurally cannot judge: a
// row names tag values, and "the same feature as the source" is not one — so
// `depConstraints` alone reads `orders → catalog` as a slice reaching a slice
// and permits it. The `tag-axis-isolation` fitness function below is the half
// that reads the `feature:` axis relative to the source, and it is the only
// thing in this workspace that can tell one slice from another.
//
// The three Go modules wire their edges through `require` + `replace`, so the
// graph the fitness function judges is the one the manifests really describe
// — not a hand-built object. That is what makes this file an end-to-end
// journey rather than a second unit test.

/** The workspace's law: the vertical-slice rows, plus the isolation function. */
export const SLICE_BOUNDARY_CONFIG = `export const depConstraints = [
  { sourceTag: "layer:slice", onlyDependOnLibsWithTags: ["layer:slice", "layer:shared-kernel"] },
  { sourceTag: "layer:shared-kernel", onlyDependOnLibsWithTags: ["layer:shared-kernel"] },
  { sourceTag: "layer:host", onlyDependOnLibsWithTags: ["layer:host", "layer:slice", "layer:shared-kernel"] },
];

export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
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
`;

/** `lattice.json` for this tree — `catalog`'s tags are what a test mutates. */
export function sliceModel({ catalogTags = ["layer:slice", "feature:catalog"] } = {}) {
  return `${JSON.stringify(
    {
      boundaryConfig: "module-boundaries.config.mjs",
      projects: {
        declared: [
          { root: "libs/orders", name: "orders", tags: ["layer:slice", "feature:orders"] },
          { root: "libs/catalog", name: "catalog", tags: catalogTags },
          { root: "libs/kernel", name: "kernel", tags: ["layer:shared-kernel"] },
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
  )}\n`;
}

/** `libs/orders/go.mod`, with or without the edge into the other slice. */
export function ordersManifest({ reachesCatalog = false } = {}) {
  const requires = [
    "require example.test/kernel v0.0.0",
    ...(reachesCatalog ? ["require example.test/catalog v0.0.0"] : []),
  ].join("\n\n");
  const replaces = [
    "replace example.test/kernel => ../kernel",
    ...(reachesCatalog ? ["replace example.test/catalog => ../catalog"] : []),
  ].join("\n");
  return `module example.test/orders\n\ngo 1.22\n\n${requires}\n\n${replaces}\n`;
}

/** `libs/orders/orders.go`, matching whichever manifest is in place. */
export function ordersSource({ reachesCatalog = false } = {}) {
  return reachesCatalog
    ? 'package orders\n\nimport (\n\t"example.test/catalog"\n\t"example.test/kernel"\n)\n\nvar _ = []any{catalog.Name, kernel.Name}\n'
    : 'package orders\n\nimport "example.test/kernel"\n\nvar _ = kernel.Name\n';
}

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function verticalSliceFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-vertical-slice",
        private: true,
        type: "module",
        packageManager,
        devDependencies: { [packageName]: "*", typescript: peers.typescript },
      },
      null,
      2,
    )}\n`,
    "lattice.json": sliceModel(),
    "module-boundaries.config.mjs": SLICE_BOUNDARY_CONFIG,
    ".gitignore": "node_modules/\n.nx/\n",
    "libs/kernel/go.mod": "module example.test/kernel\n\ngo 1.22\n",
    "libs/kernel/kernel.go": 'package kernel\n\nconst Name = "kernel"\n',
    "libs/catalog/go.mod":
      "module example.test/catalog\n\ngo 1.22\n\nrequire example.test/kernel v0.0.0\n\n" +
      "replace example.test/kernel => ../kernel\n",
    "libs/catalog/catalog.go":
      'package catalog\n\nimport "example.test/kernel"\n\nconst Name = "catalog"\n\nvar _ = kernel.Name\n',
    "libs/orders/go.mod": ordersManifest(),
    "libs/orders/orders.go": ordersSource(),
  };
}

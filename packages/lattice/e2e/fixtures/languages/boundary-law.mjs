// Three-layer boundary law for language fixtures.
//
// All six language fixtures share this constraint table so that the
// architecture semantics are comparable across languages. The vocabulary
// (`layer:domain`, `layer:application`, `layer:api`) is deliberately
// different from this repository's own `type:package`/`scope:nx` — a
// consumer's tag vocabulary must be independent of the tool's.

export const LAYERED_BOUNDARY_CONFIG = `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:application", onlyDependOnLibsWithTags: ["layer:application", "layer:domain"] },
  { sourceTag: "layer:api", onlyDependOnLibsWithTags: ["layer:api", "layer:application", "layer:domain"] },
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
`;

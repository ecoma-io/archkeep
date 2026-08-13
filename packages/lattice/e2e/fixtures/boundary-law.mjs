// The fixture boundary law: two tags this repository does not use.
//
// Same shape as `scripts/verify-package.mjs`'s `BOUNDARY_CONFIG` — the same
// two-tag vocabulary so a consumer workspace built from this config is
// architecturally independent of the tool's own `type:package`/`scope:nx`.
//
// All eight `moduleBoundaryOptions` are stated explicitly because the loader
// defaults nothing — a default would be a second copy of a value the
// workspace's own config already states.

export const BOUNDARY_CONFIG = `export const depConstraints = [
  { sourceTag: "layer:core", onlyDependOnLibsWithTags: ["layer:core"] },
  { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:app", "layer:core"] },
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

/** Three-layer boundary law for the native monorepo fixture. */
export const MONOREPO_BOUNDARY_CONFIG = `export const depConstraints = [
  { sourceTag: "layer:core", onlyDependOnLibsWithTags: ["layer:core"] },
  { sourceTag: "layer:api", onlyDependOnLibsWithTags: ["layer:api", "layer:core"] },
  { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:app", "layer:api", "layer:core"] },
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

/** Boundary law for the Moon consumer fixture. */
export const MOON_BOUNDARY_CONFIG = `export const depConstraints = [
  { sourceTag: "type-app", onlyDependOnLibsWithTags: ["type-lib"] },
  { sourceTag: "type-lib", onlyDependOnLibsWithTags: ["type-lib"] },
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

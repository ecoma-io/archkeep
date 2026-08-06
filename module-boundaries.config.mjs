/**
 * This workspace's module-boundary law, in one place, as data.
 *
 * It is here for two reasons, and the second is the one that matters.
 *
 * The first is that `lattice` is an Nx workspace like any other, and a workspace
 * that ships a boundary enforcer and does not state its own boundaries is
 * asking every consumer to trust a claim it never tested on itself.
 * `packages/nx-polyglot-graph/cli.mjs check` runs over this tree in CI, reads
 * this file, and either finds nothing or fails the build — so the tool's own
 * repository is its first consumer.
 *
 * The second is that this file is the only place where "the tool is universal"
 * stops being a design intention and becomes something a run can disprove. The
 * vocabulary below is `lattice`'s own — `type:package`, `scope:nx` — and it has
 * no overlap with the tags of the workspace the tool was extracted from. If any
 * project name, area, or tag value from that workspace had survived in the
 * source, this table would be the thing that fails, because none of those names
 * appear here to be found. `packages/nx-polyglot-graph/src/conformance/boundary.test.mjs`
 * states that constraint as a rule; this file is what exercises it.
 *
 * Shape is `@nx/enforce-module-boundaries`' own option object, and that is a
 * deliberate commitment rather than a convenience: the enforcer reproduces that
 * plugin's semantics for the languages ESLint cannot read, so the vocabulary a
 * reader has to learn is the plugin's documented one and not a local dialect.
 * `packages/nx-polyglot-graph/src/config.mjs` validates the shape on load, so a
 * malformed row fails where it is read rather than as a rule that silently
 * matches nothing — a constraint matching nothing does not error, it approves.
 *
 * **ESLint does not read this file in this workspace, and that is a fact about
 * the workspace rather than about the table.** The root `eslint.config.mjs` says
 * why there is no TypeScript configuration here: this repository holds an Nx
 * plugin written in plain ESM, so nothing is compiled and nothing imports across
 * projects through a `tsconfig.base.json` path alias — there is no
 * cross-project JavaScript import for `@nx/enforce-module-boundaries` to judge
 * yet. It gains a second reader in the change that lands the first project that
 * imports another, and the table is authored once here so that change wires a
 * reader rather than writing a second copy (Rule 14 rung 2).
 *
 * Root-owned, at the root, because the boundary spans every package: no one
 * package can own the rule that says which packages may import which.
 */

/**
 * The constraint table. A dependency must satisfy EVERY constraint whose
 * `sourceTag` its source project carries, so the axes below compose rather than
 * override.
 *
 * Both axes are narrow on purpose. Only tags a project in this tree actually
 * carries appear — a constraint whose source tag no project can hold proves
 * nothing while reading as protection, so a tag arrives in the change that
 * lands its first project and never in anticipation of one.
 */
export const depConstraints = [
  // Type axis. Everything publishable here is a `type:package`: a unit a
  // consumer installs from npm and runs inside their own `nx` process. The
  // constraint is therefore the strong form — a package may depend on a
  // package, and on nothing else. What it excludes today is a package reaching
  // into `scripts/`, which is this repository's own gate machinery and is not
  // shipped to anyone: a published package that imported it would resolve
  // nothing on a consumer's disk.
  { sourceTag: "type:package", onlyDependOnLibsWithTags: ["type:package"] },

  // Scope axis. `scope:nx` is the Nx-toolchain scope — plugins, and the
  // language server and CLI that share their analysis. A second scope arrives
  // with the first package that is not Nx tooling, and this row is what will
  // then keep the two from importing each other by accident.
  { sourceTag: "scope:nx", onlyDependOnLibsWithTags: ["scope:nx"] },
];

/**
 * The eight non-table options of `@nx/enforce-module-boundaries`, stated at the
 * values this workspace runs on.
 *
 * Every value equals the plugin's own default. They are written out anyway, and
 * that is the point: an option left implicit is an option only ESLint knows the
 * value of, and a second enforcer would have to guess it. Guessing
 * `banTransitiveDependencies` wrong makes two tools disagree about the same
 * import while both report confidently — which is exactly the split this file
 * exists to make impossible.
 *
 *   allow — import specifiers exempt from every check, matched with wildcards.
 *     Empty: no import in this workspace is above the boundary.
 *   buildTargets — the target names that make a project "buildable", read only
 *     by `enforceBuildableLibDependency`. Nx's own default name.
 *   enforceBuildableLibDependency — off, and it follows from what is here rather
 *     than from taste: nothing in this repository is built. Nx loads a plugin's
 *     entry point directly, so `packages/nx-polyglot-graph` has no `build`
 *     target at all (its `project.json` declares `lint` and `test` and nothing
 *     else, deliberately) and the check would have nothing true to say.
 *   allowCircularSelfDependency — off: a file reaching its own project through
 *     the project's public entry point instead of a relative path is a cycle
 *     through the barrel, and it stays an error.
 *   checkDynamicDependenciesExceptions — empty: an `import()` is held to the
 *     same constraints as a static import. A lazy boundary violation is still a
 *     boundary violation; it just fails later. This one is load-bearing here —
 *     the language server reaches Vue's SFC parser through a dynamic import so a
 *     workspace without Vue pays nothing, and that import must be judged.
 *   ignoredCircularDependencies — empty: no project pair is excused from the
 *     cycle check.
 *   banTransitiveDependencies — off. Third-party dependencies are declared in
 *     the root `package.json` and in each package's own manifest, and the rule
 *     would fire on internal packages where the entry-point edge is already the
 *     declaration.
 *   checkNestedExternalImports — off: `bannedExternalImports` is judged against
 *     what a project imports directly, not against what its dependencies drag
 *     in. There is no ban in the table above, so this option currently changes
 *     nothing; it is stated because leaving it implicit is what a second reader
 *     cannot recover.
 */
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

/**
 * The violations this workspace has decided to accept, each with the reason it
 * was accepted.
 *
 * Empty, and worth keeping as an empty declaration rather than deleting: the
 * list is where an accepted violation goes, and `reason` is mandatory —
 * `packages/nx-polyglot-graph/src/config.mjs` rejects an entry without one at
 * load. An unexplained suppression is indistinguishable from a boundary that
 * quietly stopped being enforced, and nobody can tell later whether it still
 * applies. An empty list is that rule satisfied; an absent list is the rule
 * having nowhere to live when the first exemption is proposed.
 *
 * A suppression removes a VERDICT and never a failure: the checker applies these
 * after judging every import, so a file listed here is still fully analyzed and
 * anything it could not resolve is still reported.
 */
export const boundarySuppressions = [];

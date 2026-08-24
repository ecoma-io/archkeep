/**
 * This workspace's module-boundary law, in one place, as data.
 *
 * It is here for two reasons, and the second is the one that matters.
 *
 * The first is that `archkeep` is an Nx workspace like any other, and a workspace
 * that ships a boundary enforcer and does not state its own boundaries is
 * asking every consumer to trust a claim it never tested on itself.
 * `packages/archkeep/cli.mjs check` runs over this tree in CI, reads
 * this file, and either finds nothing or fails the build — so the tool's own
 * repository is its first consumer.
 *
 * The second is that this file is the only place where "the tool is universal"
 * stops being a design intention and becomes something a run can disprove. The
 * vocabulary below is `archkeep`'s own — `type-package`, `scope-nx` — and it has
 * no overlap with the tags of the workspace the tool was extracted from. If any
 * project name, area, or tag value from that workspace had survived in the
 * source, this table would be the thing that fails, because none of those names
 * appear here to be found. `packages/archkeep/src/conformance/boundary.test.mjs`
 * states that constraint as a rule; this file is what exercises it.
 *
 * Tags use dash separators (`type-package`, `scope-nx`) rather than colons
 * (`type:package`, `scope:nx`) because Moon tags cannot contain colons
 * (`packages/archkeep/src/providers/moon.mjs`, `deriveTags`). The Moon
 * provider emits Moon's tags verbatim, and the constraint table must match
 * the provider. Nx- and native-path workspaces may use colons freely; this
 * repository uses Moon, so its tags follow Moon's syntax.
 *
 * Shape is `@nx/enforce-module-boundaries`' own option object, and that is a
 * deliberate commitment rather than a convenience: the enforcer reproduces that
 * plugin's semantics for the languages ESLint cannot read, so the vocabulary a
 * reader has to learn is the plugin's documented one and not a local dialect.
 * `packages/archkeep/src/config.mjs` validates the shape on load, so a
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
 * reader rather than writing a second copy.
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
  // Type axis. Everything publishable here is a `type-package`: a unit a
  // consumer installs from npm and runs inside their own `nx` process. The
  // constraint is therefore the strong form — a package may depend on a
  // package, and on nothing else. What it excludes today is a package reaching
  // into `scripts/`, which is this repository's own gate machinery and is not
  // shipped to anyone: a published package that imported it would resolve
  // nothing on a consumer's disk.
  { sourceTag: "type-package", onlyDependOnLibsWithTags: ["type-package"] },

  // `type-extension` is an editor client — today `packages/archkeep-vscode`, a
  // VS Code extension. It depends on the engine package at runtime (resolves
  // and drives the boundary server), and the constraint states that direction
  // as law: an extension may depend on a package, and on nothing else. Combined
  // with the `type-package` row above (packages may only depend on packages),
  // the enforced directions are:
  //
  //   archkeep-vscode → archkeep  ✅  allowed (extension depends on package)
  //   archkeep → archkeep-vscode  ❌  forbidden (package cannot depend on extension)
  //
  // The extension does not bundle the boundary server — it resolves the server
  // out of the workspace being edited and speaks to it over stdio, so the
  // diagnostics in the buffer come from the same version that workspace's
  // pipeline runs. That design decision is about how the dependency is
  // expressed (runtime resolution, not a bundled copy), not whether it exists.
  // An `import` of `@ecoma-io/archkeep` from the extension would be a
  // compile-time dependency the architecture allows; a bundled copy would be
  // one the architecture forbids, because a marketplace-pinned analyzer is free
  // to disagree with CI about the same import while both report confidently.
  //
  // **This row does not fire on this workspace today, and the reason is
  // measured.** Every way of writing the import was probed against this tree
  // after it gained its root `tsconfig.base.json` (module `nodenext`, no
  // `paths` — its header says why), typescript 5.9.3:
  //
  //   - By package name, as the tree stands (the extension declares no
  //     dependency on the engine): the specifier resolves to nothing and is
  //     reported as an unresolved blind spot — a loud record, never a verdict,
  //     so it never reaches this table.
  //   - By package name, with the server linked in as a workspace dependency:
  //     resolves, but to the pnpm link path
  //     (`packages/archkeep-vscode/node_modules/@ecoma-io/archkeep/index.mjs`),
  //     which classifies `external` — and an external target never reaches the
  //     tag block. `packages/archkeep/src/analysis/typescript.mjs`
  //     states why in its header — it does not call `realpath`, so a pnpm
  //     workspace link resolves to its link path instead of naming the project
  //     behind it. The tsconfig changed nothing here: `nodenext` resolution
  //     follows the same link.
  //   - By relative path: caught, but by `noRelativeOrAbsoluteImportsAcrossLibraries`,
  //     which fires before the constraint table is read at all.
  //
  // So the row changes no verdict in this workspace as it stands, and it is
  // kept anyway for the same reason the eight options below are written out at
  // their defaults: it is the value a second reader cannot recover from silence.
  // What makes it decide is a `paths` alias, not the tsconfig's mere existence:
  // mapping `@ecoma-io/archkeep` onto the project's own source in
  // `tsconfig.base.json` made the probe import resolve inside the workspace,
  // reach this table, and trip the constraint (`onlyDependOnLibsWithTags`
  // violation, exit 1 — measured, then reverted). This tree's tsconfig carries
  // no `paths`, so until one arrives the row stays a stated law with no case to
  // judge.
  { sourceTag: "type-extension", onlyDependOnLibsWithTags: ["type-package"] },

  // Scope axis. `scope-nx` is the Nx-toolchain scope — plugins, and the
  // language server and CLI that share their analysis. The second scope has
  // now arrived, so the two rows are read together: each scope may depend
  // inside itself and nowhere else.
  { sourceTag: "scope-nx", onlyDependOnLibsWithTags: ["scope-nx"] },

  // `scope-sdk` is the rule-authoring scope, and `packages/archkeep-rule-sdk-rust`
  // is the first package in this repository that is not Nx tooling — the
  // second scope the row above was written in anticipation of. An SDK is a
  // BINDING for the custom-rule contract
  // (`docs/adr/0002-custom-rules-one-contract.md`, "SDKs are bindings"): it is
  // compiled by a rule author, into an artifact a consumer's workspace
  // declares, and this repository never loads it. The engine is the other
  // side of that contract, and the two must not converge.
  //
  // What the pair of rows prevents, in the direction each is read:
  //
  //   archkeep → archkeep-rule-sdk-rust  ❌  the engine reaching into an SDK
  //   archkeep-rule-sdk-rust → archkeep  ❌  an SDK reaching into the engine
  //
  // The first is the one with teeth. An engine that imported an SDK would make
  // the contract's two sides one program, and "the host validates what the SDK
  // does not" — the split both this repository's host and that SDK's own
  // documentation lean on — would stop being checkable: a shared helper is a
  // shared assumption, and two validators that agree because they are the same
  // code prove nothing about the contract between them. The second is the same
  // sentence read backwards, and it also keeps a published crate from
  // depending on a package no crates.io consumer can resolve.
  //
  // **The row judges nothing on this workspace today, and that is measured
  // rather than assumed.** The crate declares two dependencies, serde and
  // serde_json, both resolved from crates.io, and nothing in this tree imports
  // it — `node packages/archkeep/cli.mjs check` over the three projects reports
  // no edge in either direction. It is stated anyway, for the reason the eight
  // options below are written out at their defaults: a law nobody wrote down
  // is a law the next package gets to define by accident.
  { sourceTag: "scope-sdk", onlyDependOnLibsWithTags: ["scope-sdk"] },
];

/**
 * The four governance keys a constraint row may carry, so a row's origin is
 * never silently dropped by the loader (`packages/archkeep/src/config.mjs`):
 * `origin` (who decided, with which tool, optionally when — the provenance
 * record `packages/archkeep/src/governance/provenance-record.mjs` owns),
 * `rationale` (why the rule exists), `decisionRef` (the decision that made it),
 * and `fitnessBindings` (the fitness functions that hold it honest). A row
 * without an origin is flagged by `archkeep provenance` as unattestable rather
 * than read as decided. The rows above carry no block because each was authored
 * before the governance keys existed; they remain valid and byte-identical.
 */

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
 *     entry point directly, so `packages/archkeep` has no `build`
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
 * The list is where an accepted violation goes, and `reason` is mandatory —
 * `packages/archkeep/src/config.mjs` rejects an entry without one at
 * load. An unexplained suppression is indistinguishable from a boundary that
 * quietly stopped being enforced, and nobody can tell later whether it still
 * applies. Each entry below carries its own whole argument; both are SDK rows,
 * and both are about a language whose only spelling for an import is the one
 * the message objects to.
 *
 * A suppression removes a VERDICT and never a failure: the checker applies these
 * after judging every import, so a file listed here is still fully analyzed and
 * anything it could not resolve is still reported.
 */
export const boundarySuppressions = [
  {
    path: "packages/archkeep-rule-sdk-ts/test/golden.test.mjs",
    messageId: "noRelativeOrAbsoluteImportsAcrossLibraries",
    reason:
      "the TS SDK's conformance harness drives the engine's real custom-rule host — the one SDK that can, because both sides are JavaScript in one tree. It is a test-time reach and nothing under assembly/ knows the engine exists, so the scope-sdk separation this table holds is intact in the shipped artifact.",
  },
  {
    // The companion to the row above, and a demonstration of why a suppression
    // now behaves like a fix: removing the spelling verdict used to silence
    // every check below it in silence, so this same edge's tags violation —
    // the harness reaches into `archkeep`'s source across the scope-sdk axis —
    // was never reported. With the fall-through in place it surfaced here,
    // and accepting it explicitly (same reach, same argument) keeps each
    // verdict's acceptance its own written row instead of one row hiding two.
    path: "packages/archkeep-rule-sdk-ts/test/golden.test.mjs",
    messageId: "onlyTagsConstraintViolation",
    reason:
      "the same test-time reach the spelling row above accepts: the conformance harness imports the engine's custom-rule host directly, which crosses the scope-sdk axis by construction. Nothing under assembly/ depends on archkeep, so the shipped SDK artifact stays inside its axis; only this one test file reaches across, and it does so because the contract under test IS the engine's host.",
  },
  {
    path: "packages/archkeep-rule-sdk-python/**/*.py",
    messageId: "noSelfCircularDependencies",
    reason:
      "`from archkeep_rule_sdk import ...` is the only spelling that resolves inside a Python rule's wasm carrier: the carrier registers the SDK runtime under that name in sys.modules, and there is no filesystem for the relative import this message recommends to walk. So the package's reference rule imports the SDK exactly as an outside author's rule does, and its tests import it exactly as the rule does. The rule being waived is about a language with two spellings for one import, where reaching a sibling file through the barrel is a real cycle — Python names a package one way, and taking the message's advice would produce an artifact that cannot load.",
  },
];

/**
 * The fitness functions this workspace holds itself to — every one judged by
 * `packages/archkeep/cli.mjs check` on the same observed facts as the constraint
 * table above, each verdict a `pass`/`fail`/`unknown`/`skipped` row.
 *
 * Fitness is folded into `check` by presence — there is no flag to forget, so a
 * workspace whose law declares a function is judged on every run. A function
 * that cannot be determined answers `unknown`, never `pass`, and the run exits
 * 3 (the same no-verdict machinery a malformed config uses); a failing function
 * exits 1 like any other finding.
 *
 * `coverage-minimum` counts the workspace's own analyzable tracked files:
 * Markdown, JSON and images are skipped before analysis (`languageOf`), and a
 * file that was owned but not analyzed counts as uncovered. The 100% bar is
 * the claim this repository makes about itself — every analyzable file it
 * owns is analyzed by the checker it ships, so a `.go`/`.rs`/`.py` file added
 * anywhere that is not analyzed turns this red by design.
 */
export const fitness = [
  {
    name: "own-tree-fully-analyzed",
    match: ["*"],
    condition: { type: "coverage-minimum", statement: 100 },
    reason:
      "this repository runs its own checker on itself in CI, so a tracked file its analysis does not read would be the silent direction this tool exists to end",
  },
];

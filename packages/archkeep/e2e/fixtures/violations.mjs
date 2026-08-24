// Files that produce specific violation types when committed into a consumer.
//
// Each entry is a set of files that, when added to a clean consumer and
// committed, produces a known violation. The consumer's existing boundary
// law (`layer:core` / `layer:app`) is what the violations violate.

/**
 * `core` reaches up into `app`: violates `onlyTagsConstraintViolation`
 * because `layer:core` may only depend on `layer:core`.
 *
 * Replaces `libs/core/go.mod` and adds `libs/core/violate.go`, plus
 * provides the `Thing` constant `app` now needs to export.
 */
export const CORE_REACHES_APP = {
  "libs/core/go.mod":
    "module example.test/core\n\ngo 1.22\n\nrequire example.test/app v0.0.0\n\n" +
    "replace example.test/app => ../app\n",
  "libs/core/violate.go": 'package core\n\nimport "example.test/app"\n\nvar _ = app.Thing\n',
  "libs/app/app.go": 'package app\n\nconst Thing = "app"\n',
};

/**
 * Relative import across project roots: violates
 * `noRelativeOrAbsoluteImportsAcrossLibraries`. A `.go` file in `core`
// uses a relative path to import from `app`'s directory.
 //
 // NOTE: Go does not have relative imports in the traditional sense — Go
 // imports are always by module path. This violation type is typically
 // triggered in TypeScript/JavaScript. For Go, the boundary violation
 // manifests as a tag constraint violation (CORE_REACHES_APP above).
 // This fixture is kept as a placeholder for TypeScript-based relative
 // import testing when a TypeScript fixture is added.
 */

/**
 * `core` reaches up into a `type-app`-tagged library in the Moon fixture:
 * violates `onlyTagsConstraintViolation` because `type-lib` may only depend
 * on `type-lib`, and `cli` carries `type-app` but not `type-lib`.
 *
 * Targets the `cli` project (a library tagged `type-app`, not an application):
 * - Using `web` would create a cycle (`web → api → core → web`), making
 *   `noCircularDependencies` fire before the tag constraint is checked.
 * - Using an `application`-layer project would make `noImportsOfApps` fire
 *   before the tag constraint.
 * `cli` is a `library`-layer project with `type-app` tag, no `dependsOn`, so
 * `core → cli` is acyclic, non-app, and the violation is
 * `onlyTagsConstraintViolation`.
 *
 * Replaces `libs/core/src/index.ts` with one that imports `@acme/cli`.
 */
export const MOON_LIB_REACHES_APP = {
  "libs/core/src/index.ts": 'import { cli } from "@acme/cli";\n\nexport const core = cli;\n',
};

// Per-language violation file maps: `domain` reaches up into `application`.
//
// Each entry is a set of files that, when committed into the corresponding
// clean language consumer, makes `domain` import from `application` —
// violating `onlyTagsConstraintViolation` because `layer:domain` may only
// depend on `layer:domain`.
//
// To avoid a circular dependency (application → domain + domain → application),
// each violation also replaces the application project's source file to remove
// its import from domain. Without this, `noCircularDependencies` would fire
// first and `onlyTagsConstraintViolation` would never be reported — the
// circular-dependency check short-circuits the tag constraint check.

/**
 * Go violation: `domain` imports `application`.
 * Replaces `libs/domain/go.mod` and adds `libs/domain/violate.go`.
 * Also replaces `libs/application/application.go` to remove the
 * domain import and prevent a circular dependency.
 */
export const GO_VIOLATION = {
  "libs/domain/go.mod":
    "module example.test/domain\n\ngo 1.22\n\nrequire example.test/application v0.0.0\n\n" +
    "replace example.test/application => ../application\n",
  "libs/domain/violate.go":
    'package domain\n\nimport "example.test/application"\n\nvar _ = application.Name\n',
  "libs/application/application.go": 'package application\n\nconst Name = "application"\n',
};

/**
 * TypeScript violation: `domain` imports `@example/application`.
 * Also replaces `libs/application/src/index.ts` to remove the
 * domain import and prevent a circular dependency.
 */
export const TYPESCRIPT_VIOLATION = {
  "libs/domain/violate.ts":
    'import { name } from "@example/application";\n\nexport const upward = name;\n',
  "libs/application/src/index.ts": 'export const app: string = "application";\n',
};

/**
 * JavaScript violation: `domain` imports `@example/application` (ESM).
 * Also replaces `libs/application/src/index.mjs` to remove the
 * domain import and prevent a circular dependency.
 */
export const JAVASCRIPT_VIOLATION = {
  "libs/domain/violate.mjs":
    'import { app } from "@example/application";\n\nexport const upward = app;\n',
  "libs/application/src/index.mjs": 'export const app = "application";\n',
};

/**
 * Vue violation: `domain` imports `@example/application` from a `.vue` SFC.
 * Also replaces `libs/application/src/App.vue` to remove the domain import
 * and prevent a circular dependency.
 */
export const VUE_VIOLATION = {
  "libs/domain/Violate.vue":
    '<script setup lang="ts">\nimport { label } from "@example/application";\nconst upward = label;\n</script>\n',
  "libs/application/src/App.vue":
    '<script setup lang="ts">\nconst appLabel = "application";\n</script>\n<template>\n  <div>{{ appLabel }}</div>\n</template>\n',
};

/**
 * Rust violation: `domain` crate uses `application`.
 * Also replaces `libs/application/src/lib.rs` to remove the
 * `use domain::NAME;` and prevent a circular dependency.
 */
export const RUST_VIOLATION = {
  "libs/domain/src/violate.rs": "use application::APP;\n\npub const UPWARD: &str = APP;\n",
  "libs/application/src/lib.rs": 'pub const APP: &str = "application";\n',
};

/**
 * Python violation: `domain` imports from `application`.
 * Also replaces `libs/application/src/application/__init__.py` to
 * remove the `from domain import NAME` and prevent a circular dependency.
 */
export const PYTHON_VIOLATION = {
  "libs/domain/src/domain/violate.py": "from application import APP\n\nUPWARD = APP\n",
  "libs/application/src/application/__init__.py": 'APP = "application"\n',
};

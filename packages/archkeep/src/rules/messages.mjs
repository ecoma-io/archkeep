/**
 * The violation message tables — one per finding domain — and the renderer
 * that fills the boundary table's templates.
 *
 * `MESSAGES` below is a verbatim copy of `meta.messages` in
 * `@nx/eslint-plugin`'s `enforce-module-boundaries` rule, and every key is
 * that rule's `messageId` spelled exactly. The ids are the contract: a
 * differential test can put this engine's verdict beside ESLint's for the
 * same import and compare ids, which is the only way to know the two agree
 * rather than merely both being red. `upstream.integration.test.mjs` reads
 * the installed plugin's source and fails when a copy here drifts from it.
 *
 * `GO_WORK_MESSAGES` and `TSCONFIG_PATHS_MESSAGES` are this package's own
 * domains — one entry per `messageId` a finding of that family can carry,
 * stating what it means. Their checks live beside the code that produces the
 * findings (`../../go-work.mjs`, `../../tsconfig-paths.mjs`); the message
 * text lives here, because this file is the one home every violation message
 * answers to and `../report/sarif.mjs` derives its rule descriptors from all
 * three tables — a kind added to any of them cannot be nameless in a
 * code-scanning upload.
 *
 * `MESSAGES` is copied rather than imported, and rather than derived: this
 * project may import Node built-ins and `typescript` only (`../../AGENTS.md`),
 * and importing the plugin would pull `@nx/devkit` — a project graph read —
 * into a layer whose whole point is being pure. The value is intrinsic to a
 * fixed external contract, it lives in exactly this one place, and the
 * integration test is what keeps the copy honest.
 */

/**
 * `messageId` → the template ESLint would render, `{{placeholder}}`s intact.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const MESSAGES = Object.freeze({
  noRelativeOrAbsoluteImportsAcrossLibraries: `Projects cannot be imported by a relative or absolute path, and must begin with a npm scope`,
  noRelativeOrAbsoluteExternals: `External resources cannot be imported using a relative or absolute path`,
  noCircularDependencies: `Circular dependency between "{{sourceProjectName}}" and "{{targetProjectName}}" detected: {{path}}\n\nCircular file chain:\n{{filePaths}}`,
  noSelfCircularDependencies: `Projects should use relative imports to import from other files within the same project. Use "./path/to/file" instead of import from "{{imp}}"`,
  noImportsOfApps: "Imports of apps are forbidden",
  noImportsOfE2e: "Imports of e2e projects are forbidden",
  noImportOfNonBuildableLibraries:
    "Buildable libraries cannot import or export from non-buildable libraries",
  noImportsOfLazyLoadedLibraries: `Static imports of lazy-loaded libraries are forbidden.\n\nLibrary "{{targetProjectName}}" is lazy-loaded in these files:\n{{filePaths}}`,
  projectWithoutTagsCannotHaveDependencies: `A project without tags matching at least one constraint cannot depend on any libraries`,
  bannedExternalImportsViolation: `A project tagged with "{{sourceTag}}" is not allowed to import "{{imp}}"`,
  nestedBannedExternalImportsViolation: `A project tagged with "{{sourceTag}}" is not allowed to import "{{imp}}". Nested import found at {{childProjectName}}`,
  noTransitiveDependencies: `Only packages defined in the "package.json" can be imported. Transitive or unresolvable dependencies are not allowed.`,
  onlyTagsConstraintViolation: `A project tagged with "{{sourceTag}}" can only depend on libs tagged with {{tags}}`,
  emptyOnlyTagsConstraintViolation: `A project tagged with "{{sourceTag}}" cannot depend on any libs with tags`,
  notTagsConstraintViolation: `A project tagged with "{{sourceTag}}" can not depend on libs tagged with {{tags}}\n\nViolation detected in:\n{{projects}}`,
});

/** Every `messageId` this engine can produce — the checklist, as data. */
export const MESSAGE_IDS = Object.freeze(Object.keys(MESSAGES));

/**
 * What each go.work drift finding means — one entry per `messageId` a finding
 * can carry. `../report/sarif.mjs` derives its rule descriptors from this
 * table, so a kind added here cannot be nameless in a code-scanning upload.
 * The findings themselves — including their rendered sentences — are built by
 * `compareGoWork` in `../../go-work.mjs`.
 */
export const GO_WORK_MESSAGES = Object.freeze({
  goWorkMissingUse:
    "A project's go.mod is not in go.work's use list: a developer's go build and gopls skip a " +
    "module the Nx graph covers, so dev machines and CI select different module sets.",
  goWorkStaleUse:
    "A go.work use entry names a directory with no tracked go.mod: go commands fail on developer " +
    "machines while CI, which never reads go.work, stays green.",
  goWorkUnmodeledUse:
    "A go.work use entry names a module the Nx graph does not model: it builds on developer " +
    "machines while nx affected and the boundary check never see it.",
  goWorkOutsideUse:
    "A go.work use entry points outside the workspace: developer builds include a module no run " +
    "over this workspace can cover.",
});

export const GO_WORK_MESSAGE_IDS = Object.freeze(Object.keys(GO_WORK_MESSAGES));

/**
 * What a tsconfig paths hygiene finding means — one entry per `messageId`, the
 * arrangement `../report/sarif.mjs` derives its rule descriptors from, so the
 * id cannot be nameless in a code-scanning upload. The finding — including its
 * rendered sentence — is built by `judgeTsconfigPaths` in
 * `../../tsconfig-paths.mjs`.
 */
export const TSCONFIG_PATHS_MESSAGES = Object.freeze({
  tsconfigDeadPathAlias:
    "A tsconfig paths alias maps only to targets whose directories do not exist: no import of it " +
    "can resolve through the alias table, so the build breaks — or silently resolves to an " +
    "installed package of the same name instead of the workspace source the alias promised.",
});

export const TSCONFIG_PATHS_MESSAGE_IDS = Object.freeze(Object.keys(TSCONFIG_PATHS_MESSAGES));

/**
 * Renders a message the way ESLint's own reporter does: `{{key}}` (whitespace
 * around the key tolerated) is replaced by `data[key]`, and a placeholder with
 * no matching key is LEFT IN PLACE rather than blanked. That last part is
 * deliberate upstream and worth keeping — a message reading `{{tags}}` tells a
 * reader the rule forgot to pass data, where an empty string reads as a rule
 * that found nothing to say.
 *
 * @param {string} messageId One of `MESSAGE_IDS`.
 * @param {Record<string, string|number>} [data] Interpolation values.
 * @returns {string}
 * @throws {Error} for an unknown id — a typo in a rule must not ship a
 *   violation whose text is the id itself.
 */
export function renderMessage(messageId, data = {}) {
  const template = MESSAGES[messageId];
  if (template === undefined) {
    throw new Error(
      `archkeep: no message template for '${messageId}' — ` +
        `ids must match @nx/enforce-module-boundaries exactly (one of ${MESSAGE_IDS.join(", ")})`,
    );
  }
  return template.replace(/\{\{([^{}]+?)\}\}/gu, (placeholder, key) => {
    const name = key.trim();
    return name in data ? String(data[name]) : placeholder;
  });
}

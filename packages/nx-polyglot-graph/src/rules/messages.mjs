/**
 * The fifteen violation messages, and the renderer that fills them.
 *
 * Every string below is a verbatim copy of `meta.messages` in
 * `@nx/eslint-plugin`'s `enforce-module-boundaries` rule, and every key is that
 * rule's `messageId` spelled exactly. The ids are the contract: a differential
 * test can put this engine's verdict beside ESLint's for the same import and
 * compare ids, which is the only way to know the two agree rather than merely
 * both being red. `src/rules/upstream.integration.test.mjs` reads the installed
 * plugin's source and fails when a copy here drifts from it.
 *
 * Copied rather than imported, and rather than derived: this
 * project may import Node built-ins and `typescript` only (`../../CLAUDE.md`),
 * and importing the plugin would pull `@nx/devkit` — a project graph read — into
 * a layer whose whole point is being pure. The value is intrinsic to a fixed
 * external contract, it lives in exactly this one place, and the integration
 * test is what keeps the copy honest.
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
      `nx-polyglot-graph: no message template for '${messageId}' — ` +
        `ids must match @nx/enforce-module-boundaries exactly (one of ${MESSAGE_IDS.join(", ")})`,
    );
  }
  return template.replace(/\{\{([^{}]+?)\}\}/gu, (placeholder, key) => {
    const name = key.trim();
    return name in data ? String(data[name]) : placeholder;
  });
}

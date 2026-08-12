/**
 * The tag axis: which constraints a source project is held to, and the three
 * verdicts those constraints can produce.
 *
 * Two semantics here are the opposite of the obvious implementation, and both
 * are load-bearing:
 *
 * **No matching constraint is an ERROR, not a pass.** `findConstraintsFor`
 * returning nothing means the source project's tags match no row in the table,
 * and upstream reports `projectWithoutTagsCannotHaveDependencies` — its own
 * comment reads "when no constrains found => error. Force the user to provision
 * them." The natural reading ("no rule said no, so it's fine") inverts it, and
 * every mis-tagged or untagged project then escapes the boundary silently. That
 * is the exact hole this tool exists to close, so the check is spelled out at
 * the call site in `./index.mjs` where the ordering is visible.
 *
 * **Several matching constraints are AND, not OR.** `findConstraintsFor`
 * returns an ARRAY and upstream loops over all of it. A project tagged
 * `type:lib scope:shared layer:domain license:internal` matches four rows of a
 * table carrying one row per axis, and the dependency must satisfy every one.
 * Implement OR and this engine passes imports ESLint blocks — the direction
 * that turns a boundary check into decoration.
 *
 * The third semantic worth stating: `notDependOnLibsWithTags` is TRANSITIVE.
 * It does not ask whether the imported project carries a forbidden tag, it asks
 * whether any project reachable from it does — the imported project included.
 */
import { tagMatches } from "./match.mjs";
import { getPath, pathExists } from "./reachability.mjs";

/** `"a", "b"` — how upstream renders a tag list inside a message. */
export function stringifyTags(tags) {
  return tags.map((t) => `"${t}"`).join(", ");
}

/** A row keyed on `allSourceTags` rather than a single `sourceTag`. */
export function isComboDepConstraint(depConstraint) {
  return !!depConstraint.allSourceTags;
}

/**
 * The `{{sourceTag}}` a message shows for a row. A combo row prints its tags
 * joined by `" and "`, which reads as `"a" and "b"` once the template's own
 * quotes are around it.
 */
export function constraintSourceTagLabel(constraint) {
  return isComboDepConstraint(constraint)
    ? constraint.allSourceTags.join('" and "')
    : constraint.sourceTag;
}

/** Does this project carry `tag`, in any of the four tag dialects? */
export function hasTag(project, tag) {
  return tagMatches(project.data?.tags || [], tag);
}

/** True when the project carries NONE of these tags — upstream's spelling. */
export function hasNoneOfTheseTags(project, tags) {
  return tags.filter((tag) => hasTag(project, tag)).length === 0;
}

/**
 * Every constraint row whose source matches this project. A combo row matches
 * only when the project carries ALL of its `allSourceTags`.
 *
 * The result is a list on purpose — see this file's header. Callers iterate it
 * and an empty list is an error, never a pass.
 *
 * @returns {object[]}
 */
export function findConstraintsFor(depConstraints, sourceProject) {
  return depConstraints.filter((constraint) =>
    isComboDepConstraint(constraint)
      ? constraint.allSourceTags.every((tag) => hasTag(sourceProject, tag))
      : hasTag(sourceProject, constraint.sourceTag),
  );
}

/**
 * Paths from `targetProject` to every project reachable from it that carries
 * one of `tags` — the target itself included, as a one-element path.
 *
 * This is why `notDependOnLibsWithTags` is transitive: importing a clean lib
 * that itself depends on a forbidden one is a violation, and the returned paths
 * are what the message prints so a reader can see the hop that did it.
 */
export function findDependenciesWithTags(targetProject, tags, graph, reach) {
  const reachable = Object.keys(graph.nodes).filter(
    (projectName) =>
      pathExists(reach, targetProject.name, projectName) &&
      tags.some((tag) => hasTag(graph.nodes[projectName], tag)),
  );
  return reachable.map((project) =>
    targetProject.name === project
      ? [targetProject]
      : getPath(reach, graph, targetProject.name, project),
  );
}

/**
 * `onlyDependOnLibsWithTags` with entries: the target must carry at least one
 * of them.
 *
 * @returns {{messageId: string, data: object}|null}
 */
export function onlyTagsViolation(constraint, targetProject) {
  const tags = constraint.onlyDependOnLibsWithTags;
  if (!tags || tags.length === 0) return null;
  if (!hasNoneOfTheseTags(targetProject, tags)) return null;
  return {
    messageId: "onlyTagsConstraintViolation",
    data: { sourceTag: constraintSourceTagLabel(constraint), tags: stringifyTags(tags) },
  };
}

/**
 * `onlyDependOnLibsWithTags: []` — an empty list, which is a rule of its own
 * and not the same as having no constraint at all: it says "may depend on
 * nothing that carries tags".
 *
 * The near-miss that must NOT fire is a target with no tags. Upstream requires
 * `targetProject.data.tags.length !== 0`, so an untagged dependency is
 * permitted by an empty-only row — which is consistent, since the row bans
 * tagged libs specifically.
 *
 * @returns {{messageId: string, data: object}|null}
 */
export function emptyOnlyTagsViolation(constraint, targetProject) {
  const tags = constraint.onlyDependOnLibsWithTags;
  if (!tags || tags.length !== 0) return null;
  if ((targetProject.data?.tags || []).length === 0) return null;
  return {
    messageId: "emptyOnlyTagsConstraintViolation",
    data: { sourceTag: constraintSourceTagLabel(constraint) },
  };
}

/**
 * `notDependOnLibsWithTags` — transitive, per this file's header.
 *
 * @returns {{messageId: string, data: object}|null}
 */
export function notTagsViolation(constraint, targetProject, graph, reach) {
  const tags = constraint.notDependOnLibsWithTags;
  if (!tags || tags.length === 0) return null;
  const projectPaths = findDependenciesWithTags(targetProject, tags, graph, reach);
  if (projectPaths.length === 0) return null;
  return {
    messageId: "notTagsConstraintViolation",
    data: {
      sourceTag: constraintSourceTagLabel(constraint),
      tags: stringifyTags(tags),
      projects: projectPaths
        .map((projectPath) => `- ${projectPath.map((p) => p.name).join(" -> ")}`)
        .join("\n"),
    },
  };
}

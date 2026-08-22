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
 * The `depConstraints` rows that match NO project in the graph as their
 * source — the one direction a constraint can be dead in. A row whose source
 * selector (`sourceTag`, or every tag of `allSourceTags` on one project)
 * selects nothing never applies to any import, so everything on its axis
 * passes while the config reads as enforced: the exact "a constraint matching
 * nothing does not error, it approves" mode the file loading this table
 * refuses shapes for but cannot see, because whether a tag is CARRIED is a
 * fact about the graph, which the loader deliberately never holds.
 *
 * Only the SOURCE side is asked, deliberately. A row whose
 * `onlyDependOnLibsWithTags` names a tag no project carries is not dead — it
 * is maximally strict, since `onlyTagsViolation` fires when the target carries
 * none of the permitted list, so an empty carrier set violates every
 * dependency. Loud, self-correcting, and none of this function's business.
 * Rows answered here go through `findConstraintsFor` itself — the same
 * matcher the per-site evaluation runs — so all four tag dialects
 * (`*`, `/regex/`, glob, exact) are judged by the one opinion, and a row over
 * a malformed selector (refused at load before any caller reaches here) is
 * skipped rather than crashed into.
 *
 * @param {object[]} depConstraints The validated constraint table.
 * @param {object} graph The project graph `{nodes}`.
 * @returns {{index: number, row: object}[]} In table order.
 */
export function unmatchedConstraintRows(depConstraints, graph) {
  const projects = Object.values(graph?.nodes ?? {});
  return depConstraints
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      if (!isPlainRow(row)) return false;
      return !projects.some((project) => findConstraintsFor([row], project).length > 0);
    });
}

/** @param {object} row @returns {boolean} */
function isPlainRow(row) {
  return (
    typeof row === "object" &&
    row !== null &&
    (typeof row.sourceTag === "string" ||
      (Array.isArray(row.allSourceTags) && row.allSourceTags.every((t) => typeof t === "string")))
  );
}

/**
 * The `notDependOnLibsWithTags` entries naming a tag no project carries — the
 * other direction a constraint can die in. A forbidden-target list whose every
 * value names nothing bans nothing, so the row reads as enforcing an axis it
 * has stopped guarding: a ban that evaporated is the silent direction itself.
 * (`onlyDependOnLibsWithTags` is deliberately absent here: a permitted list
 * naming nothing makes the row maximally STRICT — `onlyTagsViolation` fires
 * when the target carries none of the permitted list, so an empty carrier set
 * violates every dependency — which is loud, self-correcting, and none of this
 * function's business.)
 *
 * Each entry is asked through `hasTag` — the same matcher the transitive
 * verdict judges with — so all four tag dialects (`*`, `/regex/`, glob,
 * exact) are answered by the one opinion.
 *
 * @param {object[]} depConstraints The validated constraint table.
 * @param {object} graph The project graph `{nodes}`.
 * @returns {{index: number, position: number, tag: string}[]} In table order.
 */
export function orphanedNotDependOnTags(depConstraints, graph) {
  const projects = Object.values(graph?.nodes ?? {});
  const carried = (tag) => projects.some((project) => hasTag(project, tag));
  /** @type {{index: number, position: number, tag: string}[]} */
  const orphans = [];
  depConstraints.forEach((row, index) => {
    if (!isPlainRow(row)) return;
    const list = row.notDependOnLibsWithTags;
    if (!Array.isArray(list)) return;
    list.forEach((tag, position) => {
      if (typeof tag === "string" && !carried(tag)) orphans.push({ index, position, tag });
    });
  });
  return orphans;
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

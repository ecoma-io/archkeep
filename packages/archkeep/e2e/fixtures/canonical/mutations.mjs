// The canonical mutation registry: every architecture mutation the parity and
// differential suites apply, with the outcome each one must produce — the
// exact delta and whether the boundary law must flag a violation afterwards.
//
// The registry holds the EXPECTATIONS only. The transforms live beside each
// provider fixture (`e2e/fixtures/canonical/*.mjs` exports a `mutations` map
// keyed by these names), because a noop-reorder on a Gradle settings file and
// a noop-reorder on `moon.yml` are different edits to different languages.
// A provider that cannot express a mutation is a parity finding, not a skip:
// the suites iterate the registry and fail if a fixture's map is missing a name.

/** The project a mutation may add. Not part of the canonical architecture. */
export const MUTATION_PROJECT = "tooling";

/**
 * The shared mutation expectations.
 *
 * `violation` is what `check` must report AFTER the mutation: true means the
 * tree must fail the boundary law (exit 1, at least one violation, and
 * `violatingSource` named as an offending source project), false means it
 * must stay clean (exit 0). `refusal` overrides that with the exit-3
 * contract: the substring the refusal message must contain — the canonical
 * case is removing a project while its `sourceTag` row still sits in the
 * law, which would silently approve everything the row was written to
 * constrain. `delta` is the exact diff a baseline taken before the mutation
 * must produce against the mutated tree.
 *
 * @type {Array<{name: string, violation: boolean, delta: Record<string, string[] | []>, violatingSource?: string, refusal?: string}>}
 */
export const CANONICAL_MUTATIONS = [
  // No-ops: the graph must not move when nothing architectural moved.
  { name: "noop-comment", violation: false, delta: {} },
  { name: "noop-whitespace", violation: false, delta: {} },
  { name: "noop-reorder", violation: false, delta: {} },
  // Edge mutations: the delta must be exactly the mutated pair.
  { name: "add-edge-api-core", violation: false, delta: { addedEdges: ["api->core"] } },
  {
    name: "remove-edge-application-infrastructure",
    violation: false,
    delta: { removedEdges: ["application->infrastructure"] },
  },
  {
    name: "reverse-application-core",
    violation: true,
    delta: { addedEdges: ["core->application"], removedEdges: ["application->core"] },
    violatingSource: "core",
  },
  {
    name: "infrastructure-reaches-application",
    violation: true,
    delta: { addedEdges: ["infrastructure->application"] },
    violatingSource: "infrastructure",
  },
  // Project mutations.
  { name: "add-project-tooling", violation: false, delta: { addedProjects: [MUTATION_PROJECT] } },
  {
    name: "remove-project-infrastructure",
    violation: false,
    delta: { removedProjects: ["infrastructure"], removedEdges: ["application->infrastructure"] },
    // The law keeps its `layer/infrastructure` row on purpose: a constraint
    // whose sourceTag matches nothing must refuse loudly (exit 3), never
    // approve silently.
    refusal: "matches no project in the graph",
  },
];

/**
 * Candidate-architecture proposal — concrete facts, concrete candidates, no
 * LLM anywhere in the core path.
 *
 * This module derives candidate components, candidate boundary assertions,
 * candidate tag vocabularies and candidate rules from the same observed graph
 * `graph`/`drift`/`check` read — `src/commands/graph.mjs`'s `buildProjects` and
 * `buildDependencies` supply the `projects`/`edges` inputs. Every candidate
 * carries the evidence that produced it and an uncertainty marker, so a reader
 * can tell a strongly-implied structure from a weakly-suggested one.
 *
 * ## Proposal-only, and how that stays true
 *
 * The evaluator is pure: it takes an observed model and returns a proposal
 * object. It never reads a file, never writes a file, and never imports
 * `src/architecture-intent/model.mjs` — the module that LOADS a declaration.
 * Whether a proposal later becomes intent is a governance decision owned
 * elsewhere (`discover --propose` marks every candidate `proposed: true` and
 * `notAuthoritative: true`, and never writes `architecture-intent.json`);
 * this module cannot even express the write.
 *
 * ## The component model
 *
 * A component is a top-level directory grouping — the `projects[].root`'s
 * first path segment, or `""` at the tree root. One component model, shared
 * by every candidate kind, so the components a proposal names are the same
 * components its assertions and rules reason about.
 * ponytail: deeper directory prefixes (`libs/domain` vs `libs/adapters`) are
 * not split out; when a workspace's nested structure diverges from its
 * top-level one, the top-level grouping still surfaces the divergence as
 * cross-component edges, which the assertion and rule candidates carry.
 *
 * ## The uncertainty marker
 *
 * Every candidate carries `confidence: "high"|"medium"|"low"`:
 * - **high** — a direct observation of a structure the intent grammar can
 *   state (a tag the projects themselves carry, in the majority);
 * - **medium** — a claim derived from observations (a directory grouping is a
 *   "component", an edge crosses a "component" boundary);
 * - **low** — the evaluator's own vocabulary suggestion, which nothing
 *   observed states (the `scope:` axis implied by `scope:foo` tag shapes).
 *
 * The marker is bounded by construction — three values, assigned
 * deterministically from what was measured, never from the tree's own text.
 *
 * ## Determinism
 *
 * All leaves sort by plain string comparison, never `localeCompare`, so two
 * runs over an unchanged tree produce byte-identical proposals. The evaluator
 * re-sorts everything it builds; `projects`/`edges` order is irrelevant.
 *
 * ## The empty-result invariant
 *
 * A workspace with zero projects yields the empty proposal with `unknown:
 * true`, never fabricated candidates: nothing observed means nothing to
 * propose. Each candidate list carries `total` alongside `items`, so an
 * absent list is never ambiguous with a list the evaluator failed to build.
 */

/**
 * The uncertainty marker vocabulary — three values, the bound the "bounded
 * uncertainty markers" test asserts.
 */
export const CONFIDENCE = Object.freeze(["high", "medium", "low"]);

/**
 * The component model: every project's root's first path segment (`""` at the
 * tree root), keyed deterministically. Members sorted by project name, keys
 * sorted by string comparison.
 *
 * @param {{name: string, root: string, type?: string, tags: string[]}[]} projects
 *   From `src/commands/graph.mjs`'s `buildProjects`.
 * @returns {Map<string, {name: string, root: string, tags: string[]}[]>}
 */
export function componentsByDirectory(projects) {
  const buckets = new Map();
  for (const project of projects) {
    const component = project.root === "" ? "" : project.root.split("/")[0];
    let members = buckets.get(component);
    if (!members) {
      members = [];
      buckets.set(component, members);
    }
    members.push({ name: project.name, root: project.root, tags: project.tags });
  }
  for (const members of buckets.values()) {
    members.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  return new Map([...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The observed tags a strictly majority of a component's projects share — the
 * strongest evidence a tag axis exists: the projects themselves agree on it at
 * discovery time, so proposing it is a concrete fact, not a guess. Majority
 * (strictly more than half) rather than a threshold, so any pair of projects
 * that shares a tag is still proposed (2/3 shares, 1/2 does not) — the least
 * judgment the evidence supports.
 *
 * @param {Map<string, {name: string, tags: string[]}[]>} components From `componentsByDirectory`.
 * @returns {{tag: string, component: string, members: string[]}[]} Sorted.
 */
export function dominantTags(components) {
  const tags = [];
  for (const [component, members] of components) {
    if (members.length < 2) continue;
    const votes = new Map();
    for (const member of members) {
      for (const tag of member.tags) {
        votes.set(tag, (votes.get(tag) ?? 0) + 1);
      }
    }
    for (const [tag, count] of votes) {
      if (count > members.length / 2) {
        // `members` is the tag's BEARERS, not the whole component — the evidence
        // is that exactly these projects carry it, in a strict majority.
        const bearers = members.filter((member) => member.tags.includes(tag)).map((m) => m.name);
        tags.push({ tag, component, members: bearers });
      }
    }
  }
  return tags.sort((a, b) => {
    if (a.component !== b.component) return a.component < b.component ? -1 : 1;
    if (a.tag !== b.tag) return a.tag < b.tag ? -1 : 1;
    return 0;
  });
}

/**
 * The candidate vocabulary from a tag's own shape — `scope:foo` implies a
 * `scope:` axis, `layer:bar` a `layer:` one. The axis a tag already carries is
 * the least-assuming vocabulary candidate there is: it proposes no new word,
 * only names the axis the tags themselves spell.
 *
 * @param {{name: string, root: string, type?: string, tags: string[]}[]} projects
 * @returns {{axis: string, values: string[]}[]} Sorted by axis.
 */
export function tagAxes(projects) {
  const byAxis = new Map();
  for (const project of projects) {
    for (const tag of project.tags) {
      const colon = tag.indexOf(":");
      if (colon <= 0 || colon === tag.length - 1) continue;
      const axis = tag.slice(0, colon);
      const value = tag.slice(colon + 1);
      let values = byAxis.get(axis);
      if (!values) {
        values = [];
        byAxis.set(axis, values);
      }
      if (!values.includes(value)) values.push(value);
    }
  }
  return Array.from(byAxis.entries())
    .map(([axis, values]) => ({
      axis,
      values: values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    }))
    .sort((a, b) => (a.axis < b.axis ? -1 : a.axis > b.axis ? 1 : 0));
}

/**
 * Whether two projects belong to the same component — the relationship a
 * boundary assertion proposes ("these projects share a role") reads as "this
 * pair of projects are both members of this candidate component".
 *
 * @param {Map<string, {name: string}[]>} components From `componentsByDirectory`.
 * @param {string} source
 * @param {string} target
 * @returns {boolean}
 */
export function sameComponent(components, source, target) {
  for (const members of components.values()) {
    if (members.some((m) => m.name === source) && members.some((m) => m.name === target)) {
      return true;
    }
  }
  return false;
}

/**
 * The candidate boundary assertions: one per shared-directory component and
 * one per observed cross-component edge, each carrying the exact evidence
 * (component membership, or edge pair) that produced it.
 *
 * - **component** — "these projects share a role", proposed because they share
 *   a directory. The directory is observed; the shared role is the derived
 *   claim, hence medium confidence.
 * - **edge** — "source and target belong to different components", proposed
 *   because an observed edge crosses the component boundary. An
 *   intra-component edge emits no assertion on purpose: it observes no
 *   boundary crossing, so proposing a relationship over it would be a
 *   fabrication.
 *
 * @param {{projects: {name: string, root: string, type?: string, tags: string[]}[],
 *   edges: {source: string, target: string, type: string}[]}} observed
 * @returns {{kind: "edge"|"component", source?: string, target?: string,
 *   component?: string, evidence: object[], confidence: string}[]} Sorted.
 */
export function boundaryAssertions({ projects, edges }) {
  const components = componentsByDirectory(projects);
  const projectNames = new Set(projects.map((p) => p.name));
  /** @type {{kind: "edge"|"component", source: string|undefined, target: string|undefined,
   *   component: string|undefined, evidence: object[], confidence: "medium"}[]} */
  const assertions = [];

  for (const [component, members] of components) {
    if (members.length < 2) continue;
    assertions.push({
      kind: "component",
      source: members[0].name,
      target: undefined,
      component,
      evidence: members.map((member) => ({
        kind: "shared-directory",
        project: member.name,
        directory: component,
      })),
      confidence: "medium",
    });
  }

  for (const edge of edges) {
    if (!projectNames.has(edge.source) || !projectNames.has(edge.target)) continue;
    if (sameComponent(components, edge.source, edge.target)) continue;
    assertions.push({
      kind: "edge",
      source: edge.source,
      target: edge.target,
      component: undefined,
      evidence: [
        { kind: "observed-edge", source: edge.source, target: edge.target, type: edge.type },
      ],
      confidence: "medium",
    });
  }

  return assertions.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    if (a.target !== b.target) return (a.target ?? "") < (b.target ?? "") ? -1 : 1;
    return 0;
  });
}

/**
 * The candidate tag vocabulary: the majority-shared tags observed (the
 * strongest evidence — the projects themselves already agree, hence high
 * confidence), then the axes the tag strings spell (nothing observed states
 * the axis is real governance, hence low). The evaluator never proposes a tag
 * no project carries.
 *
 * @param {{name: string, root: string, type?: string, tags: string[]}[]} projects
 * @returns {{kind: "observed"|"suggested", tag: string|undefined, axis: string|undefined,
 *   component: string|undefined, members: string[]|undefined, values: string[]|undefined,
 *   evidence: object[], confidence: string}[]} Sorted.
 */
export function tagVocabulary(projects) {
  const components = componentsByDirectory(projects);
  /** @type {{kind: "observed"|"suggested", tag: string|undefined, axis: string|undefined,
   *   component: string|undefined, members: string[]|undefined, values: string[]|undefined,
   *   evidence: object[], confidence: "high"|"low"}[]} */
  const candidates = [];

  for (const { tag, component, members } of dominantTags(components)) {
    candidates.push({
      kind: "observed",
      tag,
      axis: undefined,
      component,
      members,
      values: undefined,
      evidence: [{ kind: "majority-shared-tag", tag, component, members }],
      confidence: "high",
    });
  }

  for (const { axis, values } of tagAxes(projects)) {
    candidates.push({
      kind: "suggested",
      tag: undefined,
      axis,
      component: undefined,
      members: undefined,
      values,
      evidence: [{ kind: "tag-shape", axis, values }],
      confidence: "low",
    });
  }

  return candidates.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    const aKey = a.tag ?? a.axis;
    const bKey = b.tag ?? b.axis;
    if (aKey !== bKey) return aKey < bKey ? -1 : 1;
    return 0;
  });
}

/**
 * The candidate rules: one `noDependency` candidate per observed
 * cross-component edge — "source must not depend on target" is the rule that
 * would make the observed separation real — and one `boundary` candidate per
 * component assertion. Each carries the assertion's evidence and confidence.
 *
 * @param {ReturnType<typeof boundaryAssertions>} assertions
 * @returns {{kind: "noDependency"|"boundary", source?: string, target?: string,
 *   component?: string, evidence: object[], confidence: string}[]} Sorted.
 */
export function candidateRules(assertions) {
  /** @type {{kind: "noDependency"|"boundary", source: string|undefined, target: string|undefined,
   *   component: string|undefined, evidence: object[], confidence: "medium"}[]} */
  const rules = [];
  for (const assertion of assertions) {
    if (assertion.kind === "edge") {
      rules.push({
        kind: "noDependency",
        source: assertion.source,
        target: assertion.target,
        component: undefined,
        evidence: assertion.evidence,
        confidence: "medium",
      });
    } else {
      rules.push({
        kind: "boundary",
        source: undefined,
        target: undefined,
        component: assertion.component,
        evidence: assertion.evidence,
        confidence: "medium",
      });
    }
  }
  return rules.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.source !== b.source) return (a.source ?? "") < (b.source ?? "") ? -1 : 1;
    if (a.target !== b.target) return (a.target ?? "") < (b.target ?? "") ? -1 : 1;
    return 0;
  });
}

/**
 * The full proposal over one observed model. Every candidate carries
 * `proposed: true` and `notAuthoritative: true` — the two markers that this is
 * a suggestion, never a decision.
 *
 * A zero-project model yields the empty proposal with `unknown: true`. Each
 * list carries `total` so an absent candidate class is never ambiguous with a
 * failed build.
 *
 * @param {{projects: {name: string, root: string, type?: string, tags: string[]}[],
 *   edges: {source: string, target: string, type: string}[]}} observed
 * @returns {{proposed: boolean, notAuthoritative: boolean, unknown: boolean,
 *   observed: {projects: number, edges: number},
 *   components: {items: object[], total: number},
 *   boundaryAssertions: {items: object[], total: number},
 *   tagVocabulary: {items: object[], total: number},
 *   rules: {items: object[], total: number},
 *   uncertainty: {high: number, medium: number, low: number}}}
 */
export function evaluateDiscovery(observed) {
  const projects = observed.projects ?? [];
  const edges = observed.edges ?? [];

  const withMarker = (item) => ({ ...item, proposed: true, notAuthoritative: true });

  if (projects.length === 0) {
    return {
      proposed: true,
      notAuthoritative: true,
      unknown: true,
      observed: { projects: 0, edges: edges.length },
      components: { items: [], total: 0 },
      boundaryAssertions: { items: [], total: 0 },
      tagVocabulary: { items: [], total: 0 },
      rules: { items: [], total: 0 },
      uncertainty: { high: 0, medium: 0, low: 0 },
    };
  }

  const components = componentsByDirectory(projects);
  // A candidate component is a directory grouping of two or more projects — a
  // single-project group is "a project", not "a component", so it is not worth
  // proposing. The grouping itself is derived, hence medium confidence.
  const componentItems = [...components.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([component, members]) =>
      withMarker({
        name: component === "" ? "(root)" : component,
        commonDirectory: component,
        projects: members.map((m) => m.name),
        evidence: members.map((member) => ({
          kind: "shared-directory",
          project: member.name,
          directory: component,
        })),
        confidence: "medium",
      }),
    );

  const assertions = boundaryAssertions({ projects, edges }).map(withMarker);
  const tags = tagVocabulary(projects).map(withMarker);
  const rules = candidateRules(assertions).map(withMarker);

  const all = [...componentItems, ...assertions, ...tags, ...rules];

  return {
    proposed: true,
    notAuthoritative: true,
    unknown: false,
    observed: { projects: projects.length, edges: edges.length },
    components: { items: componentItems, total: componentItems.length },
    boundaryAssertions: { items: assertions, total: assertions.length },
    tagVocabulary: { items: tags, total: tags.length },
    rules: { items: rules, total: rules.length },
    uncertainty: {
      high: all.filter((c) => c.confidence === "high").length,
      medium: all.filter((c) => c.confidence === "medium").length,
      low: all.filter((c) => c.confidence === "low").length,
    },
  };
}

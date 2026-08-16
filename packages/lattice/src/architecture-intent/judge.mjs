/**
 * Architecture Intent — judgment against the observed graph.
 *
 * The intent model (`./model.mjs`) is the contract; this module decides what
 * the observed architecture does about it. Pure: takes a provider-neutral
 * `{nodes, dependencies}` graph (the same shape `../../src/commands/context.mjs`
 * hands every command) and returns a verdict plus the records a report renders.
 * No I/O, no provider import — it reads the graph, not the workspace.
 *
 * The empty-result invariant (`../../../../AGENTS.md`) decides every branch:
 * a clean verdict is only ever returned when every row and every boundary was
 * actually judged. Three non-obvious choices follow from it:
 *
 *   - **A forbidden relationship is violated by ANY path** (direct or
 *     transitive), matching `notDependOnLibsWithTags` in `../../src/rules/tags.mjs`
 *     which already judges the transitive closure — intent and the boundary
 *     policy must not disagree about the same boundary. The witness path is
 *     reported for determinism.
 *   - **Allowing is observed, not assumed.** An `allowed` row declares an
 *     architecture statement the team intends to build; an `allowed` dep that
 *     is not observed is drift, and drift is the payoff of intent. It is a
 *     finding (exit 1) unless the row is `"optional": true`, which demotes its
 *     absence to a coverage note.
 *   - **A boundary (or a row side) that matches no observed project is not a
 *     clean verdict — it is a no-verdict.** Whether a selector names something
 *     real needs the graph, so it is decided here, not at load
 *     (`./model.mjs` stays nodes-free); "cannot verify this boundary" reads as
 *     no-verdict (exit 3), never as "intent passes".
 */

import { resolveMembers } from "./selectors.mjs";
import { buildReachability, getPath, pathExists } from "../../src/rules/reachability.mjs";

/**
 * What a finding means — one entry per `messageId`, the arrangement
 * `../../src/report/sarif.mjs` derives its rule descriptors from, the same as
 * `../../src/go-work.mjs` and `../../src/tsconfig-paths.mjs`.
 */
export const INTENT_MESSAGES = Object.freeze({
  intentForbiddenEdge:
    "A dependency this workspace's architecture-intent.json forbids appears in the observed " +
    "project graph — the architecture that is being built contradicts the one that was intended.",
  intentAllowedMissing:
    "A dependency this workspace's architecture-intent.json allows is not observed — the " +
    "intended architecture is not being built.",
  projectMissing:
    "the intent requires a project to exist, but the observed architecture has no project of that name",
  projectPresent: "the intent forbids a project, but the observed architecture contains it",
  projectTagMissing: "a required project lacks a required tag",
  dependencyForbidden: "a dependency the intent forbids exists in the observed architecture",
  dependencyNotAllowed: "an observed dependency is not among the dependencies the intent allows",
  tagDependencyForbidden:
    "a dependency the intent forbids between two tags exists in the observed architecture",
  intentUnknownProject: "an intent row names a project the observed architecture does not have",
  intentUnknownTag: "a tag rule names a tag no observed project carries",
});

export const INTENT_MESSAGE_IDS = Object.freeze(Object.keys(INTENT_MESSAGES));

/**
 * How a `from`/`to` side resolves: a declared boundary name wins (deterministic
 * — names can never contain `:` so they cannot collide with a selector), else
 * the side is an inline selector resolved against the graph.
 */
function sidePatterns(intent, side) {
  const declared = intent.boundaries.find((b) => b.name === side);
  if (declared) return { boundaryName: side, patterns: declared.match };
  // Not a declared name — an inline selector (`name:x`, `tag:x`, `directory:x`,
  // `*`, or a bare project name).
  return { boundaryName: null, patterns: [side] };
}

/**
 * A collision-free key for one (source, target) project pair. `JSON.stringify`
 * of the pair is unambiguous for any strings a graph can name, unlike a
 * delimiter join, which any delimiter could appear inside.
 *
 * @param {string} source
 * @param {string} target
 * @returns {string}
 */
function edgeKey(source, target) {
  return `${JSON.stringify(source)}>${JSON.stringify(target)}`;
}

/**
 * All the observed DIRECT edges, as (source, target) keys — built once, not
 * per row.
 *
 * @param {{nodes: object, dependencies?: object}} graph
 * @returns {Set<string>}
 */
function directEdges(graph) {
  const edges = new Set();
  for (const [source, dependencies] of Object.entries(graph.dependencies ?? {})) {
    for (const dependency of dependencies ?? []) {
      if (graph.nodes[dependency.target] !== undefined) {
        edges.add(edgeKey(source, dependency.target));
      }
    }
  }
  return edges;
}

/**
 * Judge an intent model against a graph.
 *
 * @param {object} intent The normalized model from `./model.mjs`.
 * @param {{nodes: object, dependencies?: object}} graph
 * @returns {{verdict: "ok"|"findings"|"no-verdict",
 *   findings: object[], unresolved: object[], boundaries: object[], notes: string[]}}
 *   `findings` are `{source, target, rule, boundaryFrom, boundaryTo, message}`;
 *   `unresolved` are `{boundary, issue}` for every empty side or empty
 *   boundary; `boundaries` are `{name, projects[]}` (sorted members); `notes`
 *   are coverage notes that change no verdict — today only an
 *   `"optional": true` `allowed` row whose statement is not yet built.
 */
export function judgeIntent(intent, graph) {
  const nodes = graph.nodes ?? {};
  const boundaries = intent.boundaries.map((b) => ({
    name: b.name,
    projects: resolveMembers(b.match, nodes),
  }));
  const byName = new Map(boundaries.map((b) => [b.name, b.projects]));
  const reach = buildReachability({ nodes, dependencies: graph.dependencies });
  const edges = directEdges({ nodes, dependencies: graph.dependencies });

  const findings = [];
  const unresolved = [];
  const notes = [];

  for (const boundary of boundaries) {
    if (boundary.projects.length === 0) {
      unresolved.push({
        boundary: boundary.name,
        issue: `matches no observed project — the intent for this boundary cannot be verified`,
      });
    }
  }

  const judgeRow = (row, listName) => {
    const from = sidePatterns(intent, row.from);
    const to = sidePatterns(intent, row.to);
    const fromMembers = byName.get(from.boundaryName) ?? resolveMembers(from.patterns, nodes);
    const toMembers = byName.get(to.boundaryName) ?? resolveMembers(to.patterns, nodes);

    if (fromMembers.length === 0 || toMembers.length === 0) {
      unresolved.push({
        boundary: from.boundaryName ?? row.from,
        issue: `the ${listName} row between "${row.from}" and "${row.to}" has a side with no observed projects — its intent cannot be verified`,
      });
      return;
    }

    if (listName === "forbidden") {
      // A single-project self-ban in disguise: both sides resolve to the same
      // ONE project, so no cross-pair can ever exist and the row can never
      // fire. Reading that as "clean — the ban holds" is the silent direction:
      // a ban that cannot fire and one that held are byte-identical. The
      // judge has the graph, so it decides here — a no-verdict, never clean.
      // The load-provable spellings (`name:x` vs `name:x`) are already
      // rejected at load (`../model.mjs`); this catches the ones only the
      // graph can prove (`{from: "packages", to: "name:x"}` where `x` is the
      // boundary's only member). A same multi-member set is NOT this case:
      // `*`→`*` and `packages`→`tag:type-package` both have real cross-pairs
      // and judge normally.
      if (fromMembers.length === 1 && toMembers.length === 1 && fromMembers[0] === toMembers[0]) {
        unresolved.push({
          boundary: from.boundaryName ?? row.from,
          issue:
            `the forbidden row between "${row.from}" and "${row.to}" resolves both ` +
            `sides to the single project "${fromMembers[0]}" — a self-ban that can ` +
            `never fire, and reading it as holding would be the silent direction`,
        });
        return;
      }
      // Every cross-pair. Self-pairs (source === target) are excluded: a
      // project reaching itself is not a dependency, and `{from: "*", to: "*"}`
      // must not report every project for self-reach.
      const pairs = [];
      for (const source of fromMembers) {
        for (const target of toMembers) {
          if (source === target) continue;
          if (pathExists(reach, source, target)) pairs.push([source, target]);
        }
      }
      if (pairs.length === 0) return; // a ban that holds is a clean verdict
      pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
      const [source, target] = pairs[0];
      const path = getPath(reach, { nodes }, source, target).map((n) => n.name);
      const witness = path.length > 1 ? path.join(" → ") : `${source} → ${target}`;
      findings.push({
        source,
        target,
        rule: "intentForbiddenEdge",
        boundaryFrom: from.boundaryName ?? row.from,
        boundaryTo: to.boundaryName ?? row.to,
        message:
          `${witness} — architecture-intent.json forbids "${row.from}" reaching "${row.to}"` +
          (from.boundaryName ? ` (boundary ${from.boundaryName})` : "") +
          (to.boundaryName ? ` to ${to.boundaryName}` : ""),
      });
      return;
    }

    // allowed.
    // A row satisfied when ANY distinct cross-pair edge is observed: the intent
    // statement "X may depend on Y" holds the moment one such dependency is
    // being built. `from` and `to` resolve to the same single-member set
    // (`{from: "module", to: "module"}` on a one-project boundary) yield no
    // distinct pair: nothing to be built, so nothing to miss — vacuously held.
    let held = false;
    for (const source of fromMembers) {
      for (const target of toMembers) {
        if (source === target) continue;
        if (edges.has(edgeKey(source, target))) {
          held = true;
          break;
        }
      }
      if (held) break;
    }
    if (held) return;
    // No distinct cross-pair exists — the statement is vacuous, not missing.
    if (fromMembers.length === 1 && toMembers.length === 1 && fromMembers[0] === toMembers[0])
      return;
    if (row.optional) {
      // Absence tolerated — aspirational, not drift — but it is still a
      // coverage note and the caller threads it into the report's coverage
      // notes, so a reader can tell "optional and absent" from "never checked".
      notes.push(
        `optional allowed intent "${row.from}" → "${row.to}" is not yet observed — aspirational, not drift`,
      );
      return;
    }
    const pairs = [];
    for (const source of fromMembers) {
      for (const target of toMembers) {
        if (source !== target) pairs.push([source, target]);
      }
    }
    pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
    const [source, target] = pairs[0] ?? [fromMembers[0], toMembers[0]];
    findings.push({
      source,
      target,
      rule: "intentAllowedMissing",
      boundaryFrom: from.boundaryName ?? row.from,
      boundaryTo: to.boundaryName ?? row.to,
      message:
        `architecture-intent.json allows "${row.from}" reaching "${row.to}", but no observed ` +
        `dependency between projects of the two sides satisfies it` +
        (from.boundaryName ? ` (boundary ${from.boundaryName})` : "") +
        (to.boundaryName ? ` and ${to.boundaryName}` : ""),
    });
  };

  for (const row of intent.forbidden) judgeRow(row, "forbidden");
  for (const row of intent.allowed) judgeRow(row, "allowed");

  // ── Drift sections (projects / dependencies / forbiddenTags) ─────────────
  // These judge existence facts by *name* and *tag* rather than by boundary
  // selector. `from`/`to` on a dependency row and `name` on a project row are
  // exact project names, never selectors — a typo'd name must be a loud
  // `intentUnknownProject`, not a boundary that silently matches nothing. Tag
  // rows reference tag values, judged against the union of every observed
  // project's tags.
  /** @type {Map<string, {name: string, tags: string[]}>} */
  const projectsByName = new Map();
  for (const [entryName, entry] of Object.entries(nodes)) {
    // Tags live under `data.tags` (the provider-neutral node shape the selector
    // engine reads) — read from there, never from a bare `tags` field.
    projectsByName.set(entryName, { name: entryName, tags: entry?.data?.tags ?? [] });
  }
  const known = (name) => projectsByName.has(name);
  const tagsOf = (name) => {
    const project = projectsByName.get(name);
    return project?.tags ?? [];
  };
  const tagVocabulary = new Set();
  for (const project of projectsByName.values())
    for (const tag of project.tags) tagVocabulary.add(tag);

  /**
   * `alreadyNamed` lets a drift rule skip a (source,target) pair a boundary or
   * project rule already reported, so no edge is ever two findings.
   */
  const alreadyNamed = (list, source, target) =>
    list.some((f) => f.source === source && f.target === target);

  /**
   * The observed direct edges as `[source, target]` pairs, built with the same
   * traversal `directEdges` above uses — the drift sections read the pair list
   * rather than parse `edgeKey` strings back apart. Order is irrelevant: the
   * final sort below is total.
   */
  const observedEdgePairs = [];
  for (const [source, dependencies] of Object.entries(graph.dependencies ?? {})) {
    for (const dependency of dependencies ?? []) {
      if (graph.nodes[dependency.target] !== undefined) {
        observedEdgePairs.push([source, dependency.target]);
      }
    }
  }

  for (const row of intent.dependencies?.forbidden ?? []) {
    const { source, target } = row;
    if (edges.has(edgeKey(source, target))) {
      findings.push({
        source,
        target,
        rule: "dependencyForbidden",
        boundaryFrom: null,
        boundaryTo: null,
        message: `${source} → ${target} — architecture-intent.json forbids this dependency, but the observed graph contains it`,
      });
    }
  }
  const hasDependencyAllowlist = (intent.dependencies?.allowed?.length ?? 0) > 0;
  if (hasDependencyAllowlist) {
    const allowedSet = new Set(
      (intent.dependencies.allowed ?? []).map((r) => `${r.source} ${r.target}`),
    );
    for (const [source, target] of observedEdgePairs) {
      if (alreadyNamed(findings, source, target) || allowedSet.has(`${source} ${target}`)) continue;
      findings.push({
        source,
        target,
        rule: "dependencyNotAllowed",
        boundaryFrom: null,
        boundaryTo: null,
        message: `${source} → ${target} — architecture-intent.json allows only the listed dependencies, and this one is not listed`,
      });
    }
  }
  for (const row of intent.forbiddenTags ?? []) {
    const { from, to } = row;
    const fromMissing = !tagVocabulary.has(from);
    const toMissing = !tagVocabulary.has(to);
    if (fromMissing || toMissing) {
      const missing = [fromMissing ? `"${from}"` : null, toMissing ? `"${to}"` : null]
        .filter(Boolean)
        .join(" and ");
      findings.push({
        source: null,
        target: null,
        rule: "intentUnknownTag",
        boundaryFrom: null,
        boundaryTo: null,
        message: `architecture-intent.json forbids a dependency from tag "${from}" to tag "${to}", but no observed project carries ${missing}`,
      });
    }
    for (const [source, target] of observedEdgePairs) {
      if (!known(source) || !known(target)) continue;
      if (tagsOf(source).includes(from) && tagsOf(target).includes(to)) {
        findings.push({
          source,
          target,
          rule: "tagDependencyForbidden",
          boundaryFrom: null,
          boundaryTo: null,
          message: `${source} → ${target} — architecture-intent.json forbids a dependency from any project carrying tag "${from}" to any project carrying tag "${to}"`,
        });
      }
    }
  }
  // Referenced-but-unknown project names in the dependency sections — a typo'd
  // name can never fire and must be loud, never silent.
  const referenced = new Set();
  for (const row of [
    ...(intent.dependencies?.allowed ?? []),
    ...(intent.dependencies?.forbidden ?? []),
  ]) {
    if (typeof row.source === "string") referenced.add(row.source);
    if (typeof row.target === "string") referenced.add(row.target);
  }
  for (const name of [...referenced].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!known(name)) {
      findings.push({
        source: null,
        target: null,
        rule: "intentUnknownProject",
        boundaryFrom: null,
        boundaryTo: null,
        message: `architecture-intent.json names project "${name}", but the observed architecture has no project of that name`,
      });
    }
  }
  if (intent.projects?.required) {
    for (const row of intent.projects.required) {
      const requiredTags = row.tags ?? [];
      if (!known(row.name)) {
        findings.push({
          source: null,
          target: null,
          rule: "projectMissing",
          boundaryFrom: null,
          boundaryTo: null,
          message: `architecture-intent.json requires project "${row.name}" to exist, but the observed architecture has no project of that name`,
        });
      }
      for (const tag of requiredTags) {
        if (!tagsOf(row.name).includes(tag)) {
          findings.push({
            source: null,
            target: null,
            rule: "projectTagMissing",
            boundaryFrom: null,
            boundaryTo: null,
            message: `architecture-intent.json requires project "${row.name}" to carry tag "${tag}", but it does not`,
          });
        }
      }
    }
  }
  if (intent.projects?.forbidden) {
    for (const row of intent.projects.forbidden) {
      if (known(row.name)) {
        findings.push({
          source: null,
          target: null,
          rule: "projectPresent",
          boundaryFrom: null,
          boundaryTo: null,
          message: `architecture-intent.json forbids project "${row.name}", but the observed architecture contains it`,
        });
      }
    }
  }

  // Determinism: findings by (source, target), unresolved by boundary, both
  // with plain `<` comparison (never localeCompare).
  findings.sort((a, b) =>
    a.source === b.source ? (a.target < b.target ? -1 : 1) : a.source < b.source ? -1 : 1,
  );
  unresolved.sort((a, b) => (a.boundary < b.boundary ? -1 : a.boundary > b.boundary ? 1 : 0));

  const verdict = findings.length > 0 ? "findings" : unresolved.length > 0 ? "no-verdict" : "ok";

  return { verdict, findings, unresolved, boundaries, notes };
}

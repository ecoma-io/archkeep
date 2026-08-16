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

  // Determinism: findings by (source, target), unresolved by boundary, both
  // with plain `<` comparison (never localeCompare).
  findings.sort((a, b) =>
    a.source === b.source ? (a.target < b.target ? -1 : 1) : a.source < b.source ? -1 : 1,
  );
  unresolved.sort((a, b) => (a.boundary < b.boundary ? -1 : a.boundary > b.boundary ? 1 : 0));

  const verdict = findings.length > 0 ? "findings" : unresolved.length > 0 ? "no-verdict" : "ok";

  return { verdict, findings, unresolved, boundaries, notes };
}

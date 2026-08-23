/**
 * The built-in reusable fitness conditions — small pure functions over the
 * observed snapshot, one per `condition.type`.
 *
 * Every function returns a decision `{verdict, evidence, message, rows?}`.
 * The invariant (AGENTS.md) decides the failure path of each one: a condition
 * that cannot determine its answer yields `unknown` with evidence saying which
 * half of the snapshot was missing — never `pass`. `pass` is only reachable
 * when the evidence the condition claims over was fully observed.
 *
 * Everything here is deterministic: sorted edges, sorted rows, plain `<`
 * comparison, and no clock. Time-based fitness belongs behind the shared clock
 * contract (E0), injected at the command boundary — see the registry.
 */
import { resolveMembers } from "../architecture-intent/selectors.mjs";
import { buildReachability } from "../rules/reachability.mjs";
import { fitnessVerdict } from "./verdict.mjs";

/** `data.tags` on a node is the provider-neutral place tags live. */
function tagsOf(nodes, name) {
  return nodes[name]?.data?.tags ?? [];
}

/** The direct `source → target` edges among the named projects, sorted. */
function edgesAmong(nodes, dependencies, names) {
  const inSet = new Set(names);
  const edges = [];
  for (const [source, list] of Object.entries(dependencies ?? {})) {
    if (!inSet.has(source)) continue;
    for (const dependency of list ?? []) {
      if (!inSet.has(dependency.target)) continue;
      edges.push({ source, target: dependency.target });
    }
  }
  return edges.sort((a, b) =>
    a.source === b.source ? (a.target < b.target ? -1 : 1) : a.source < b.source ? -1 : 1,
  );
}

/**
 * Whether the subgraph induced on `names` contains a cycle. Only multi-project
 * cycles are considered: every provider strips self-edges before the graph
 * reaches the rules (`../providers/native/graph.mjs` and
 * `../providers/moon.mjs` drop `source === target` edges, and the Nx graph
 * cannot carry one), so a self-loop cannot occur here and is not a `cycle-free`
 * finding.
 *
 * @param {{nodes: object, dependencies?: object}} graph
 * @param {string[]} names
 * @returns {string[]} The sorted names of projects on a cycle, `[]` when the
 *   subgraph is cycle-free.
 */
export function cyclicProjects(graph, names) {
  const { matrix } = buildReachability({
    nodes: graph.nodes,
    dependencies: graph.dependencies,
  });
  return names
    .filter((source) =>
      names.some(
        (target) => source !== target && matrix[source]?.[target] && matrix[target]?.[source],
      ),
    )
    .sort();
}

/** Direct edge data for a layer-dependency check, judged per condition. */
function layerEdges(nodes, dependencies, names, fromTag, toTag) {
  return edgesAmong(nodes, dependencies, names).filter(
    (edge) =>
      tagsOf(nodes, edge.source).includes(fromTag) && tagsOf(nodes, edge.target).includes(toTag),
  );
}

/** Whichever of `names` carry `tag` — the matched set, or every node. */
function taggedMembers(nodes, names, tag) {
  return names.filter((name) => tagsOf(nodes, name).includes(tag));
}

/**
 * `cycle-free` — no dependency cycle among the matched projects.
 */
export function cycleFree(nodes, dependencies, names) {
  const cycles = cyclicProjects({ nodes, dependencies }, names);
  if (cycles.length === 0) {
    return fitnessVerdict({
      verdict: "pass",
      name: "cycle-free",
      evidence: { projects: names.length, cycles: 0 },
      message: `${names.length} matched projects form no dependency cycle`,
      rows: [],
    });
  }
  return fitnessVerdict({
    verdict: "fail",
    name: "cycle-free",
    evidence: { projects: names.length, cycles: cycles.length, cyclicProjects: cycles },
    message:
      `${names.length} matched projects contain a dependency cycle through ` +
      `${cycles.join(", ")}`,
    rows: cycles.map((project) => ({ source: project, target: project })),
  });
}

/**
 * `layer-dependency` — no dependency edge from any matched project carrying
 * `from` to any carrying `to` (direction `"forbidden"`), or at least one such
 * edge (direction `"required"`).
 */
export function layerDependency(nodes, dependencies, names, { from, to, direction }) {
  const fromMembers = taggedMembers(nodes, names, from);
  const toMembers = taggedMembers(nodes, names, to);
  const edges = layerEdges(nodes, dependencies, names, from, to);

  // A condition whose source or target tag no matched project carries can
  // never be satisfied or violated — reading that as either verdict would be
  // the silent direction. `unknown` with the missing side named.
  if (fromMembers.length === 0 || toMembers.length === 0) {
    const missing = [
      fromMembers.length === 0 ? `"${from}"` : null,
      toMembers.length === 0 ? `"${to}"` : null,
    ]
      .filter(Boolean)
      .join(" and ");
    return fitnessVerdict({
      verdict: "unknown",
      name: `layer-dependency:${from}→${to}`,
      evidence: {
        projects: names.length,
        fromMembers: fromMembers.length,
        toMembers: toMembers.length,
      },
      message:
        `cannot judge layer-dependency "${from}"→"${to}" — no matched project carries tag ${missing}, ` +
        `so the condition could never be determined`,
      rows: [],
    });
  }

  if (direction === "required") {
    if (edges.length > 0) {
      return fitnessVerdict({
        verdict: "pass",
        name: `layer-dependency:${from}→${to}`,
        evidence: {
          projects: names.length,
          fromMembers: fromMembers.length,
          toMembers: toMembers.length,
          edges: edges.length,
        },
        message: `${edges.length} edge${edges.length === 1 ? "" : "s"} carry "${from}" → "${to}" as required`,
        rows: edges,
      });
    }
    return fitnessVerdict({
      verdict: "fail",
      name: `layer-dependency:${from}→${to}`,
      evidence: {
        projects: names.length,
        fromMembers: fromMembers.length,
        toMembers: toMembers.length,
        edges: 0,
      },
      message: `no observed dependency edge carries tag "${from}" → "${to}", but one is required`,
      rows: [],
    });
  }

  // direction "forbidden".
  if (edges.length === 0) {
    return fitnessVerdict({
      verdict: "pass",
      name: `layer-dependency:${from}→${to}`,
      evidence: {
        projects: names.length,
        fromMembers: fromMembers.length,
        toMembers: toMembers.length,
        edges: 0,
      },
      message: `no dependency edge carries "${from}" → "${to}", as forbidden`,
      rows: [],
    });
  }
  return fitnessVerdict({
    verdict: "fail",
    name: `layer-dependency:${from}→${to}`,
    evidence: {
      projects: names.length,
      fromMembers: fromMembers.length,
      toMembers: toMembers.length,
      edges: edges.length,
    },
    message: `${edges.length} edge${edges.length === 1 ? "" : "s"} carry "${from}" → "${to}" — forbidden`,
    rows: edges,
  });
}

/**
 * `tag-conformance` — every direct edge LEAVING a matched project that carries
 * `from` may only target (`toDependents: "only"`) or never target
 * (`toDependents: "never"`) a project carrying `to`.
 *
 * ## `match` selects the SOURCES, and only the sources
 *
 * The edges are built with `edgesFrom` below, which constrains the source and
 * nothing else — the same reading `tagAxisIsolation` gives `match`, through the
 * same function. Requiring the TARGET to be matched too is what this used to
 * do, and under `"only"` it deleted exactly the violations: an edge leaving the
 * matched set is precisely the crossing the condition forbids, so a row scoped
 * to the layer it governs (`match: ["tag:layer:app"]` — the natural way to
 * write one) could never fail. That is the silent direction, and it is why the
 * target side is not scoped by `match` here — only by being a project at all.
 *
 * `to` membership is therefore a fact about the whole graph rather than about
 * the matched set, and so is the guard below: a `to` tag NO project carries
 * anywhere makes the condition undeterminable under BOTH readings — a renamed
 * layer or a typo answering `pass` is the same silent direction one step
 * earlier. One rule, not one per `toDependents`.
 */
export function tagConformance(nodes, dependencies, names, { from, to, toDependents }) {
  const fromMembers = taggedMembers(nodes, names, from);
  if (fromMembers.length === 0) {
    return fitnessVerdict({
      verdict: "unknown",
      name: `tag-conformance:${from}`,
      evidence: { projects: names.length, fromMembers: 0 },
      message: `cannot judge tag-conformance "${from}" — no matched project carries tag "${from}"`,
      rows: [],
    });
  }
  const toMembers = taggedMembers(nodes, Object.keys(nodes), to);
  if (toMembers.length === 0) {
    return fitnessVerdict({
      verdict: "unknown",
      name: `tag-conformance:${from}`,
      evidence: { projects: names.length, fromMembers: fromMembers.length, toMembers: 0 },
      message:
        `cannot judge tag-conformance "${from}" — no project in the workspace carries tag "${to}", ` +
        `so the ${toDependents}-condition could not be determined`,
      rows: [],
    });
  }
  // A target that is not a project node is not this condition's business: an
  // Nx graph's `dependencies` carry `npm:`-prefixed external targets verbatim
  // (`../providers/nx.mjs` returns what `nx graph` emitted), and an external
  // package's boundary is `bannedExternalImports`', judged by
  // `../rules/index.mjs` against the specifier. Without this the `"only"`
  // reading would report every npm import as a tag violation and the rule
  // would be unusable on an Nx workspace. `tagAxisIsolation` below drops the
  // same targets by construction, through its `targetValues.length > 0` test.
  //
  // `Object.hasOwn`, never `nodes[edge.target]`: `nodes` is a caller-supplied
  // map and a project named `__proto__` or `toString` must not answer the
  // membership question by inheritance — the same guard
  // `../rules/reachability.mjs`'s `buildReachability` uses on this exact
  // lookup.
  const edges = edgesFrom(dependencies, fromMembers).filter((edge) =>
    Object.hasOwn(nodes, edge.target),
  );
  const nonConforming = edges.filter((edge) =>
    toDependents === "only" ? !toMembers.includes(edge.target) : toMembers.includes(edge.target),
  );

  if (nonConforming.length === 0) {
    return fitnessVerdict({
      verdict: "pass",
      name: `tag-conformance:${from}`,
      evidence: { projects: names.length, fromMembers: fromMembers.length, edges: edges.length },
      message:
        `${edges.length} edge${edges.length === 1 ? "" : "s"} from "${from}" ` +
        (toDependents === "only"
          ? `target only "${to}" projects as required`
          : `target no "${to}" projects as required`),
      rows: [],
    });
  }
  return fitnessVerdict({
    verdict: "fail",
    name: `tag-conformance:${from}`,
    evidence: {
      projects: names.length,
      fromMembers: fromMembers.length,
      edges: edges.length,
      violations: nonConforming.length,
    },
    message:
      `${nonConforming.length} edge${nonConforming.length === 1 ? "" : "s"} from "${from}" ` +
      (toDependents === "only"
        ? `target ${nonConforming.map((e) => `"${e.target}"`).join(", ")} outside "${to}"`
        : `target "${to}" projects, which is forbidden`),
    rows: nonConforming,
  });
}

/**
 * The values a project carries on one tag axis — the part after the first `:`
 * of every `axis:value` tag it has.
 *
 * Split on the FIRST colon, so a tag like `module:orders:v2` places the
 * project in the partition `orders:v2` rather than in `orders`. That is the
 * same reading `../rules/match.mjs` gives an `axis:value` tag, and the
 * alternative — splitting on the last colon, or refusing the tag — would
 * quietly move a project between partitions.
 *
 * @param {object} nodes
 * @param {string} name
 * @param {string} axis
 * @returns {string[]} Sorted, deduplicated. Empty when the project carries no
 *   tag on this axis, which is what `tagAxisIsolation` reads as "belongs to no
 *   partition".
 */
function axisValues(nodes, name, axis) {
  const prefix = `${axis}:`;
  const values = new Set();
  for (const tag of tagsOf(nodes, name)) {
    if (!tag.startsWith(prefix)) continue;
    const value = tag.slice(prefix.length);
    // A bare `module:` names an axis and no value. Reading it as the partition
    // `""` would put every project carrying one into the SAME partition and
    // pass every edge between them; leaving it out places the project nowhere,
    // which is the `unknown` branch below and the loud direction.
    if (value !== "") values.add(value);
  }
  return [...values].sort();
}

/**
 * The direct edges leaving any of `sources`, wherever they land — deduplicated
 * by the PAIR, and sorted.
 *
 * A provider deduplicates on `[source, target, type]`, so one `a → b`
 * dependency can appear twice when it is both a manifest edge and an implicit
 * one. Both callers judge the pair and never read `type`, so keeping both
 * would report the same dependency twice and put a count of 2 on an evidence
 * record describing one edge. That is the loud direction rather than the
 * silent one, which is why it is a count bug and not a verdict bug — but a
 * count in evidence is a claim about the graph, and this one would be wrong.
 */
function edgesFrom(dependencies, sources) {
  const inSet = new Set(sources);
  const seen = new Map();
  for (const [source, list] of Object.entries(dependencies ?? {})) {
    if (!inSet.has(source)) continue;
    for (const dependency of list ?? []) {
      seen.set(`${source}\u0000${dependency.target}`, { source, target: dependency.target });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.source === b.source ? (a.target < b.target ? -1 : 1) : a.source < b.source ? -1 : 1,
  );
}

/**
 * `tag-axis-isolation` — the partition check: two projects sitting on
 * different values of ONE tag axis may not depend on each other.
 *
 * ## Why this exists as a primitive
 *
 * Every other mechanism in this tool compares a project's tags against tag
 * values written in the policy: `onlyDependOnLibsWithTags` names the target
 * tags, `notDependOnLibsWithTags` names the forbidden ones,
 * `layer-dependency` names both sides. None of them can say "the same value
 * as the source", so a style whose boundary is a PARTITION — one module, one
 * bounded context, one feature slice, one service — has to be written as one
 * constraint row per partition, restated every time the tree grows a new one.
 *
 * That is not only verbose, it is wrong in both directions, and both were
 * measured on the packs this package ships (`../../presets/`):
 *
 *   - **False negative.** `modular-monolith`'s row lets `layer:module-internal`
 *     depend on `layer:module-internal`, because "its own module's internals"
 *     is not a thing a tag list can spell. One module's private implementation
 *     reaching another module's is permitted by the pack whose own row
 *     description forbids it.
 *   - **False positive.** `ddd-bounded-contexts-isolated`'s
 *     `notDependOnLibsWithTags: ["share:private"]` reports an import between
 *     two private projects of the SAME context, which is why that profile is
 *     documented as valid only where one project is one context.
 *
 * One axis-relative condition answers both, for every partitioned style, in
 * one row that does not change when a partition is added.
 *
 * ## What is judged, and what is not
 *
 * `match` selects the SOURCES. Every direct edge leaving a matched project is
 * judged when its target carries a value on `axis` and is not exempt; an edge
 * whose target carries no value on the axis belongs to no partition and is
 * not this condition's business (the shared kernel, a platform library, a
 * project on another axis entirely). `exempt` is the one escape, and it names
 * targets — a published contract, a module's public surface — so the pattern
 * "cross-partition through the published surface only" is one selector rather
 * than a second condition.
 *
 * Edges are DIRECT. A path laundered through a third project is a transitive
 * question, which `notDependOnLibsWithTags` already answers and answers
 * differently (it reports at the innocent hop). Naming the limit here is the
 * honest half: this condition is a claim about direct coupling.
 *
 * ## The verdict order, and why `fail` outranks `unknown`
 *
 * A matched project carrying no value on the axis cannot be placed in a
 * partition, so its edges cannot be judged. Reading that as "no violation"
 * is the silent direction, so it can never produce `pass`. It does not
 * suppress a crossing that WAS found, either: those are determined facts, and
 * hiding them behind `unknown` would lose findings. So the order is the one
 * `../../cli.mjs`'s `verdictFor` already uses for the run as a whole —
 * findings first, could-not-look second, clean last — with the unplaced count
 * carried in the evidence of whichever verdict is returned.
 *
 * @param {object} nodes
 * @param {object} dependencies
 * @param {string[]} names The matched projects — sources only.
 * @param {{axis: string, exempt?: string[]}} params
 * @returns {object}
 */
export function tagAxisIsolation(nodes, dependencies, names, { axis, exempt = [] }) {
  const ruleName = `tag-axis-isolation:${axis}`;
  // `resolveMembers` seeds an implicit `*` whenever a list carries NO positive
  // selector — not only when it is empty (`../architecture-intent/selectors.mjs`,
  // where "everything except…" is what a boundary's `match` means). Here that
  // reading would exempt the whole workspace and turn every verdict below into
  // `pass`, so a list with no positive selector never reaches that function.
  //
  // `exemptSelectorViolations` (`./fitness-registry.mjs`) refuses such a list at
  // load, by name, which is where an author is told about it. This is the
  // backstop for a caller that assembled a row without validating it, and it
  // errs toward exempting NOTHING — the stricter of the two answers, so the
  // gap it covers can only ever over-report.
  const exemptNames = new Set(
    exempt.some((selector) => !selector.startsWith("!")) ? resolveMembers(exempt, nodes) : [],
  );
  const unplaced = names.filter((name) => axisValues(nodes, name, axis).length === 0).sort();

  const crossings = edgesFrom(dependencies, names)
    .filter((edge) => !exemptNames.has(edge.target))
    .map((edge) => ({
      ...edge,
      sourceValues: axisValues(nodes, edge.source, axis),
      targetValues: axisValues(nodes, edge.target, axis),
    }))
    .filter(
      (edge) =>
        edge.sourceValues.length > 0 &&
        edge.targetValues.length > 0 &&
        !edge.sourceValues.some((value) => edge.targetValues.includes(value)),
    );

  const evidence = {
    projects: names.length,
    axis,
    exempt: exemptNames.size,
    unplaced: unplaced.length,
    crossings: crossings.length,
  };

  // Named once, appended to whichever verdict is returned. A `fail` that said
  // nothing about the projects it could not place would report a partial look
  // as a whole one: the reader acts on the crossings and never learns that part
  // of the subject was never judged.
  const unplacedNote =
    unplaced.length === 0
      ? ""
      : ` ${unplaced.length} matched project${unplaced.length === 1 ? "" : "s"} ` +
        `${unplaced.length === 1 ? "carries" : "carry"} no "${axis}:" tag, so ` +
        `${unplaced.length === 1 ? "its" : "their"} dependencies could not be placed: ` +
        `${unplaced.join(", ")}.`;

  if (crossings.length > 0) {
    return fitnessVerdict({
      verdict: "fail",
      name: ruleName,
      evidence,
      message:
        `${crossings.length} dependency edge${crossings.length === 1 ? "" : "s"} cross${crossings.length === 1 ? "es" : ""} ` +
        `a "${axis}:" boundary: ` +
        crossings
          .map(
            (edge) =>
              `${edge.source} (${edge.sourceValues.join("|")}) → ${edge.target} (${edge.targetValues.join("|")})`,
          )
          .join(", ") +
        (unplacedNote === "" ? "" : `.${unplacedNote}`),
      rows: crossings,
    });
  }

  if (unplaced.length > 0) {
    return fitnessVerdict({
      verdict: "unknown",
      name: ruleName,
      evidence,
      message: `cannot judge tag-axis-isolation on "${axis}:" —${unplacedNote}`,
      rows: [],
    });
  }

  return fitnessVerdict({
    verdict: "pass",
    name: ruleName,
    evidence,
    message: `${names.length} matched project${names.length === 1 ? "" : "s"} keep every dependency inside their own "${axis}:" partition`,
    rows: [],
  });
}

/**
 * `coverage-minimum` — at least `statement` percent of the matched projects'
 * owned files were actually analyzed by the workspace analysis. The observed
 * side is `analysis`' per-project file count vs the files the workspace owns;
 * a file that was owned but not analyzed counts as uncovered, never dropped —
 * the silent direction.
 */
export function coverageMinimum(analysis, names, { statement, scoped = false }) {
  if (names.length === 0) {
    return fitnessVerdict({
      verdict: "not_applicable",
      name: `coverage-minimum:${statement}%`,
      evidence: { projects: 0, coverage: null },
      notApplicableReason: "no matched projects, so coverage could not be claimed",
      message: "declared but matches no observed project — coverage could not be claimed",
      rows: [],
    });
  }
  // A path-scoped run analyzed a subset of owned files, so coverage over the
  // whole set is not determinable from it. Reading the partial number as a
  // verdict would be the silent direction — but this is not a case of TRYING
  // to judge and coming up short (`unknown`, I3's "could not look"): a scoped
  // `check <path>` is a deliberately different, partial invocation, and
  // coverage-minimum cannot be judged by ANY scoped run over ANY path, clean
  // or not — the same "did not apply" shape `not_applicable` already has above
  // for a `match` that selects zero projects, not a fresh meaning grafted onto
  // it (P1-19: this used to answer `unknown` here, which made `check <path>`
  // exit 3 unconditionally in any `coverage-minimum`-declaring workspace,
  // regardless of what the scoped path contained or whether it was clean —
  // this repository's own root `../../../../module-boundaries.config.mjs`
  // declares exactly such a row). `not_applicable` still names the reason (I4,
  // `./verdict.mjs`) and still renders as its own loud, distinct row
  // (`../report/text.mjs`'s `formatFitnessSection`) — never silent, and never
  // `pass` either, so a scoped run still cannot claim full coverage over files
  // it never looked at — but unlike `unknown` it does not fold into `check`'s
  // exit code (`../../cli.mjs`'s `fitnessUnknown`), so a scoped run over a
  // genuinely clean subtree no longer exits 3 for a coverage question it was
  // never in a position to answer.
  if (scoped) {
    return fitnessVerdict({
      verdict: "not_applicable",
      name: `coverage-minimum:${statement}%`,
      evidence: { projects: names.length, scoped: true },
      notApplicableReason:
        "this run was scoped to specific paths — coverage-minimum needs a full, unscoped run",
      message:
        `coverage-minimum over ${names.length} matched projects does not apply to a ` +
        `path-scoped run — it needs a full \`check\` with no paths to judge the whole tree`,
      rows: [],
    });
  }
  let owned = 0;
  let analyzed = 0;
  for (const name of names) {
    owned += analysis.coverage?.[name]?.owned ?? 0;
    analyzed += analysis.coverage?.[name]?.analyzed ?? 0;
  }
  if (owned === 0) {
    return fitnessVerdict({
      verdict: "unknown",
      name: `coverage-minimum:${statement}%`,
      evidence: { projects: names.length, owned: 0, analyzed: 0 },
      message:
        `cannot judge coverage-minimum over ${names.length} matched projects — the workspace ` +
        `owns no tracked files for them, so a coverage claim would be a guess`,
      rows: [],
    });
  }
  const percent = (analyzed / owned) * 100;
  if (percent >= statement) {
    return fitnessVerdict({
      verdict: "pass",
      name: `coverage-minimum:${statement}%`,
      evidence: {
        projects: names.length,
        owned,
        analyzed,
        percent: Math.round(percent * 100) / 100,
      },
      message:
        `${analyzed}/${owned} files analyzed (${Math.round(percent * 100) / 100}%), ` +
        `meets the ${statement}% minimum`,
      rows: [],
    });
  }
  return fitnessVerdict({
    verdict: "fail",
    name: `coverage-minimum:${statement}%`,
    evidence: { projects: names.length, owned, analyzed, percent: Math.round(percent * 100) / 100 },
    message:
      `${analyzed}/${owned} files analyzed (${Math.round(percent * 100) / 100}%), ` +
      `below the ${statement}% minimum`,
    rows: [],
  });
}

/**
 * `boundary-suppression-count-within-threshold` — the number of accepted
 * boundary suppressions in effect is at most `max`.
 */
export function suppressionThreshold({ max }, suppressions) {
  const count = suppressions.length;
  if (count <= max) {
    return fitnessVerdict({
      verdict: "pass",
      name: `boundary-suppressions:${max}`,
      evidence: { suppressions: count, max },
      message: `${count} accepted boundary suppressions is within the ${max} threshold`,
      rows: [],
    });
  }
  return fitnessVerdict({
    verdict: "fail",
    name: `boundary-suppressions:${max}`,
    evidence: { suppressions: count, max },
    message: `${count} accepted boundary suppressions exceeds the ${max} threshold`,
    rows: [],
  });
}

/**
 * `drift-free` — the workspace's tracked `architecture-intent.json` (when one
 * is present) judges clean against the observed graph. The intent judge's own
 * no-verdict (an empty boundary, a row side matching nothing) is `unknown`,
 * never `pass` — the same posture `check` renders it exit 3.
 */
export function driftFree(intent) {
  if (intent == null) {
    return fitnessVerdict({
      verdict: "unknown",
      name: "drift-free",
      evidence: { intent: null },
      message: "cannot judge drift-free — no architecture-intent.json is declared",
      rows: [],
    });
  }
  if (intent.verdict === "ok") {
    return fitnessVerdict({
      verdict: "pass",
      name: "drift-free",
      evidence: { intent: "ok", findings: 0 },
      message: "the declared architecture intent matches the observed graph",
      rows: [],
    });
  }
  if (intent.verdict === "no-verdict") {
    return fitnessVerdict({
      verdict: "unknown",
      name: "drift-free",
      evidence: { intent: "no-verdict", unresolved: intent.unresolved?.length ?? 0 },
      message:
        "cannot judge drift-free — the architecture intent reached no verdict on the observed graph",
      rows: [],
    });
  }
  return fitnessVerdict({
    verdict: "fail",
    name: "drift-free",
    evidence: { intent: "findings", findings: intent.findings?.length ?? 0 },
    message: `the declared architecture intent and the observed graph disagree (${intent.findings?.length ?? 0} finding${(intent.findings?.length ?? 0) === 1 ? "" : "s"})`,
    rows: [],
  });
}

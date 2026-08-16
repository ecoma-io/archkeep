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

/** Every matched project carrying `tag`. */
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
 * `tag-conformance` — matched-project edges carrying `from` may only target
 * (`toDependents: "only"`) or never target (`toDependents: "never"`) projects
 * carrying `to`.
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
  const toMembers = taggedMembers(nodes, names, to);
  const edges = edgesAmong(nodes, dependencies, names).filter((edge) =>
    fromMembers.includes(edge.source),
  );
  const nonConforming = edges.filter((edge) =>
    toDependents === "only" ? !toMembers.includes(edge.target) : toMembers.includes(edge.target),
  );

  if (toDependents === "never" && toMembers.length === 0) {
    return fitnessVerdict({
      verdict: "unknown",
      name: `tag-conformance:${from}`,
      evidence: { projects: names.length, fromMembers: fromMembers.length, toMembers: 0 },
      message: `cannot judge tag-conformance "${from}" — no matched project carries tag "${to}", so the never-condition could not be determined`,
      rows: [],
    });
  }

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
  // verdict would be the silent direction — `unknown` with the reason named.
  if (scoped) {
    return fitnessVerdict({
      verdict: "unknown",
      name: `coverage-minimum:${statement}%`,
      evidence: { projects: names.length, scoped: true },
      message:
        `cannot judge coverage-minimum over ${names.length} matched projects — this run ` +
        `was scoped to specific paths, so it inspected only part of the tree`,
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

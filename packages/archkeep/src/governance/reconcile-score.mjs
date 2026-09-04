/**
 * Model ↔ Reality reconciliation — the pure, deterministic scoring half.
 *
 * `drift` (../commands/drift.mjs) reports the intended rows the observed
 * architecture violates. Reconciliation is the two-sided mirror: it scores
 * every intent row and every observed element against the canonical intent
 * the workspace declared, so a reader sees not only what drifts but where the
 * model itself is silent, stricter, or stale. It is READ-ONLY — proposing
 * repair paths is the `--propose` face's job (../commands/reconcile.mjs), and
 * neither ever writes back into architecture-intent.json. Authority stays
 * with the intentional human or agent; this module reports divergence, never
 * edits.
 *
 * This module is pure: it takes the normalized intent model
 * (../architecture-intent/model.mjs), the observed project-model facts that
 * `drift`'s `buildObserved` already computed, and the verdict the canonical
 * judge (../architecture-intent/judge.mjs) emitted — it never re-scans the
 * graph, never re-derives the observed side, and never re-derives a verdict
 * (../commands/drift.mjs owns both derivations, and a second one would be a
 * second truth). No I/O, no provider import.
 *
 * ## The state vocabulary
 *
 * Every scored element carries one of four states, decided by what the intent
 * actually states — never by what it might mean:
 *
 * - `match` — the element agrees with the intent, or the intent does not
 *   govern that plane (silence is not a violation).
 * - `absent` — the intent explicitly requires the element and it is not
 *   observed.
 * - `unexpected` — the intent explicitly forbids the element and it is
 *   observed, or the intent governs a plane (an exhaustive allowlist, a
 *   declared existence model) and the element stands outside it.
 * - `unknown` — the observed side could not be established (a whole file the
 *   analysis could not read), so no verdict is possible. The one state that
 *   must never read as a claim (`../../../../AGENTS.md`).
 *
 * `severity` ranks the divergence a proposal would repair: the higher the
 * value, the earlier it sorts in a ranked candidate list (all `unexpected`
 * at 4 outrank all `absent` at 3; `match` is 0). `unknown` carries
 * `Infinity` — a verdict over an incomplete set outranks every number — and
 * `confidence` then says `"unverifiable"` so a reader can tell "cannot
 * establish" from "stated".
 *
 * Every output here is keyed deterministically: plain-string comparison
 * everywhere (never `localeCompare`), the same total-order rule every other
 * deterministic output in this package holds.
 */
import { isWholeFileFailure } from "../analysis/source-util.mjs";
import { resolveMembers } from "../architecture-intent/selectors.mjs";

/**
 * A collision-free key for one (boundaryFrom, boundaryTo) pair — matching
 * `edgeKey` in `../architecture-intent/judge.mjs`. A plain `${a}${b}` join
 * (as this used to be) lets two distinct pairs collide: `{from:"web",
 * to:"app-core"}` and `{from:"web-app", to:"core"}` both join to
 * `"webapp-core"`, so one divergent row's finding would be read back for the
 * other and silently score a `match` where a real `intentForbiddenEdge` or
 * `intentAllowedMissing` sits. `JSON.stringify` of each side is unambiguous
 * for any strings a graph can name, unlike a delimiter join, which any
 * delimiter could appear inside.
 *
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function boundaryKey(from, to) {
  return `${JSON.stringify(from)}>${JSON.stringify(to)}`;
}

/** The severity a state earns — the sort key a ranked proposal list uses. */
export const SEVERITY_ORDER = Object.freeze({
  // used by its own test
  unexpected: 4,
  absent: 3,
  match: 0,
  unknown: Infinity,
});

/**
 * A scored element.
 *
 * @typedef {object} ScoredElement
 * @property {string} plane One of `"project"`, `"edge"`, `"tag"`, `"boundary"`,
 *   or `"intent-row"`.
 * @property {string} name The project name, `source → target`, tag value, boundary
 *   name, or intent row identity (`from → to`).
 * @property {"match"|"absent"|"unexpected"|"unknown"} state
 * @property {number} severity
 * @property {string} classification A canonical judge message id, or `"match"`,
 *   or `"unanalyzed"`.
 * @property {object|null} intentRow `{plane, index, kind, key}` — the intent row
 *   this element states, `null` when no row states it.
 * @property {"stated"|"not governed"|"unverifiable"} confidence
 */

/**
 * The declared state of the intent's rows, reduced to the key sets the scoring
 * functions read — the same rows `model.mjs` validated and `judge.mjs` judged,
 * read the same way the file wrote them.
 */
function intentKeys(intent) {
  const projects = intent.projects ?? {};
  const dependencies = intent.dependencies ?? {};
  return {
    requiredNames: new Set((projects.required ?? []).map((row) => row.name)),
    forbiddenNames: new Set((projects.forbidden ?? []).map((row) => row.name)),
    allowedEdges: new Set(
      (dependencies.allowed ?? []).map((row) => `${row.source} → ${row.target}`),
    ),
    forbiddenEdges: new Set(
      (dependencies.forbidden ?? []).map((row) => `${row.source} → ${row.target}`),
    ),
    tagRules: intent.forbiddenTags ?? [],
    projectSectionDeclared: intent.projects !== undefined,
    edgeAllowlistDeclared: (dependencies.allowed?.length ?? 0) > 0,
  };
}

/**
 * Scores one observed project and its required tags.
 *
 * A project is `match` when the intent requires it (it exists — the intent's
 * existence statement is satisfied) or when the intent does not govern
 * existence at all. When the intent's `projects` section IS declared, a
 * project named in `projects.forbidden` is `unexpected`, and a project outside
 * the declared model is `unexpected` too — a declared existence model is
 * exhaustive, and a project it does not know is the model silently
 * under-selecting reality.
 *
 * @param {object} project `{name, data: {tags}}` from `buildObserved`.
 * @param {object} keys From `intentKeys`.
 * @param {Map<string, string[]>} requiredTagsByProject
 * @returns {{project: ScoredElement, tags: ScoredElement[]}}
 */
export function scoreProject(project, keys, requiredTagsByProject) {
  // used by its own test
  const tags = project.data?.tags ?? project.tags ?? [];
  const requiredTags = requiredTagsByProject.get(project.name) ?? [];
  const element = { plane: "project", name: project.name };

  /** @type {ScoredElement["state"]} */
  let state;
  let classification;
  /** @type {ScoredElement["confidence"]} */
  let confidence;
  if (keys.requiredNames.has(project.name)) {
    state = "match";
    classification = "match";
    confidence = "stated";
  } else if (keys.forbiddenNames.has(project.name)) {
    state = "unexpected";
    classification = "projectPresent";
    confidence = "stated";
  } else if (keys.projectSectionDeclared) {
    state = "unexpected";
    classification = "intentUnknownProject";
    confidence = "stated";
  } else {
    state = "match";
    classification = "match";
    confidence = "not governed";
  }

  /** @type {ScoredElement[]} */
  const tagScores = [];
  for (const tag of requiredTags) {
    if (!tags.includes(tag)) {
      tagScores.push({
        plane: "tag",
        name: `${project.name}  ${tag}`,
        state: "absent",
        severity: SEVERITY_ORDER.absent,
        classification: "projectTagMissing",
        intentRow: { plane: "project", index: 0, kind: "required", key: project.name },
        confidence: "stated",
      });
    }
  }

  /** @type {ScoredElement} */
  const projectScore = {
    ...element,
    state,
    severity: SEVERITY_ORDER[state],
    classification,
    intentRow: null,
    confidence,
  };

  return { project: projectScore, tags: tagScores };
}

/**
 * Scores one observed edge.
 *
 * The edge plane has two governance modes. A `dependencies.forbidden` row bans
 * a specific pair; a `dependencies.allowed` list, when present, is an
 * exhaustive allowlist — every observed pair outside it is `unexpected`. The
 * canonical judge's forbidden boundary rows and forbiddenTags rows report
 * their witness edges as findings (`intentForbiddenEdge`,
 * `tagDependencyForbidden`); those witnesses are passed in and scored as
 * `unexpected` so a boundary violation is never scored "match" merely because
 * the pair is not in a forbidden row. Every other pair is a match: silence in
 * the edge plane is not a violation.
 *
 * @param {{source: string, target: string}} edge
 * @param {object} keys From `intentKeys`.
 * @param {Set<string>} intentForbiddenPairs Witness edges of forbidden boundary rows.
 * @param {Set<string>} tagForbiddenPairs Witness edges of forbiddenTags rows.
 * @returns {ScoredElement}
 */
export function scoreEdge(edge, keys, intentForbiddenPairs, tagForbiddenPairs) {
  // used by its own test
  const key = `${edge.source} → ${edge.target}`;
  const element = { plane: "edge", name: key, intentRow: null };

  if (keys.forbiddenEdges.has(key)) {
    return {
      ...element,
      state: "unexpected",
      severity: SEVERITY_ORDER.unexpected,
      classification: "dependencyForbidden",
      confidence: "stated",
    };
  }
  if (keys.edgeAllowlistDeclared && !keys.allowedEdges.has(key)) {
    return {
      ...element,
      state: "unexpected",
      severity: SEVERITY_ORDER.unexpected,
      classification: "dependencyNotAllowed",
      confidence: "stated",
    };
  }
  if (tagForbiddenPairs.has(key)) {
    return {
      ...element,
      state: "unexpected",
      severity: SEVERITY_ORDER.unexpected,
      classification: "tagDependencyForbidden",
      confidence: "stated",
    };
  }
  if (intentForbiddenPairs.has(key)) {
    return {
      ...element,
      state: "unexpected",
      severity: SEVERITY_ORDER.unexpected,
      classification: "intentForbiddenEdge",
      confidence: "stated",
    };
  }
  return {
    ...element,
    state: "match",
    severity: SEVERITY_ORDER.match,
    classification: "match",
    confidence: "not governed",
  };
}

/**
 * Scores the intent's own rows — the per-intent-row divergence metric. One
 * score per row, in file order, so a ranked candidate list can name the row
 * it would edit by `intentRow.index`.
 *
 * Boundary `allowed`/`forbidden` rows are scored from the canonical judge's
 * findings (matched exactly by `from`/`to`): a `forbidden` row with an
 * `intentForbiddenEdge` finding is `unexpected`, an `allowed` row with an
 * `intentAllowedMissing` finding is `absent`. Project and dependency rows are
 * scored directly against the observed names and edges. A
 * `dependencies.allowed` row is an allowlist entry, not an existence claim —
 * its absence in the graph is not divergence, so it scores `match` either
 * way (the divergent direction is the observed edge outside the list, scored
 * per-observed-element as `dependencyNotAllowed`).
 *
 * @param {object} intent The normalized intent model.
 * @param {object} judgeVerdict `{findings}` from `judgeIntent`.
 * @param {object} observed `{projects, edges}` from `buildObserved`.
 * @param {Map<string, string[]>} tagsByProject The tags each observed project carries.
 * @returns {ScoredElement[]}
 */
export function scoreIntentRows(intent, judgeVerdict, observed, tagsByProject) {
  // used by its own test
  const rows = [];
  const observedNames = new Set(observed.projects.map((p) => p.name));
  const observedEdgeKeys = new Set(observed.edges.map((e) => `${e.source} → ${e.target}`));

  const boundaryFinding = new Map();
  for (const finding of judgeVerdict.findings) {
    if (finding.boundaryFrom === null) continue;
    boundaryFinding.set(boundaryKey(finding.boundaryFrom, finding.boundaryTo), finding.rule);
  }

  let index = 0;
  const row = (plane, name, state, classification, kind, key) => {
    /** @type {ScoredElement} */
    const entry = {
      plane,
      name,
      state: /** @type {ScoredElement["state"]} */ (state),
      severity: SEVERITY_ORDER[state],
      classification,
      intentRow: { plane, index, kind, key },
      confidence: state === "unknown" ? "unverifiable" : "stated",
    };
    rows.push(entry);
    index += 1;
    return entry;
  };

  const projects = intent.projects ?? {};
  for (const required of projects.required ?? []) {
    row(
      "project",
      required.name,
      observedNames.has(required.name) ? "match" : "absent",
      observedNames.has(required.name) ? "match" : "projectMissing",
      "required",
      required.name,
    );
  }
  for (const forbidden of projects.forbidden ?? []) {
    row(
      "project",
      forbidden.name,
      observedNames.has(forbidden.name) ? "unexpected" : "match",
      observedNames.has(forbidden.name) ? "projectPresent" : "match",
      "forbidden",
      forbidden.name,
    );
  }

  const dependencies = intent.dependencies ?? {};
  for (const allowed of dependencies.allowed ?? []) {
    const key = `${allowed.source} → ${allowed.target}`;
    // An allowlist entry makes no existence claim — present or absent, it is
    // the permission itself that is the statement, not the wiring.
    row("edge", key, "match", "match", "allowed", key);
  }
  for (const forbidden of dependencies.forbidden ?? []) {
    const key = `${forbidden.source} → ${forbidden.target}`;
    row(
      "edge",
      key,
      observedEdgeKeys.has(key) ? "unexpected" : "match",
      observedEdgeKeys.has(key) ? "dependencyForbidden" : "match",
      "forbidden",
      key,
    );
  }

  for (const tagRow of intent.forbiddenTags ?? []) {
    const key = `${tagRow.from} → ${tagRow.to}`;
    const violated = observed.edges.some((e) => {
      if (e.source === e.target) return false;
      const sourceTags = tagsByProject.get(e.source) ?? [];
      const targetTags = tagsByProject.get(e.target) ?? [];
      return sourceTags.includes(tagRow.from) && targetTags.includes(tagRow.to);
    });
    row(
      "tag",
      key,
      violated ? "unexpected" : "match",
      violated ? "tagDependencyForbidden" : "match",
      "tag-forbidden",
      key,
    );
  }

  for (const allowed of intent.allowed ?? []) {
    const rule = boundaryFinding.get(boundaryKey(allowed.from, allowed.to));
    row(
      "intent-row",
      `${allowed.from} → ${allowed.to}`,
      rule === "intentAllowedMissing" ? "absent" : "match",
      rule === "intentAllowedMissing" ? "intentAllowedMissing" : "match",
      "allowed",
      `${allowed.from} → ${allowed.to}`,
    );
  }
  for (const forbidden of intent.forbidden ?? []) {
    const rule = boundaryFinding.get(boundaryKey(forbidden.from, forbidden.to));
    row(
      "intent-row",
      `${forbidden.from} → ${forbidden.to}`,
      rule === "intentForbiddenEdge" ? "unexpected" : "match",
      rule === "intentForbiddenEdge" ? "intentForbiddenEdge" : "match",
      "forbidden",
      `${forbidden.from} → ${forbidden.to}`,
    );
  }

  return rows;
}

/**
 * Scores a whole observed set against the intent.
 *
 * `judgeVerdict` is the canonical judge's output and `observed` the fact set
 * `buildObserved` built — both provided, never re-derived. Whole-file analysis
 * failures shadow every project score as `unknown`, so a partial read can
 * never render as a claim (`../../../../AGENTS.md`).
 *
 * @param {object} intent The normalized intent model.
 * @param {object} judgeVerdict `{findings}` from `judgeIntent`.
 * @param {object} observed `{projects, edges}` from `buildObserved` (the
 *   project facts carry `name`, `root` (on `data`), and `tags` (on `data`)).
 * @param {object} analysis `{failures}` from the command context.
 * @returns {{projects: ScoredElement[], edges: ScoredElement[], tags: ScoredElement[],
 *   boundaries: ScoredElement[], intentRows: ScoredElement[], unknownFiles: object[]}}
 */
export function reconcileScores(intent, judgeVerdict, observed, analysis) {
  const tagsByProject = new Map();
  for (const project of observed.projects) {
    tagsByProject.set(project.name, project.data?.tags ?? project.tags ?? []);
  }

  const keys = intentKeys(intent);
  const requiredTagsByProject = new Map(
    (intent.projects?.required ?? []).map((row) => [row.name, row.tags ?? []]),
  );

  const projects = [];
  const tags = [];
  for (const project of observed.projects) {
    const { project: score, tags: tagScores } = scoreProject(project, keys, requiredTagsByProject);
    projects.push(score);
    tags.push(...tagScores);
  }
  projects.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  tags.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // The canonical judge's witness edges — the boundary and tag rules it
  // reported as violating pairs.
  const intentForbiddenPairs = new Set();
  const tagForbiddenPairs = new Set();
  for (const finding of judgeVerdict.findings) {
    if (finding.source === null || finding.target === null) continue;
    const pair = `${finding.source} → ${finding.target}`;
    if (finding.rule === "tagDependencyForbidden") tagForbiddenPairs.add(pair);
    else if (finding.rule === "intentForbiddenEdge") intentForbiddenPairs.add(pair);
  }

  const edges = observed.edges
    .map((edge) => scoreEdge(edge, keys, intentForbiddenPairs, tagForbiddenPairs))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const intentRows = scoreIntentRows(intent, judgeVerdict, observed, tagsByProject);

  const boundaries = (intent.boundaries ?? [])
    .map((boundary) => {
      const members = resolveMembers(boundary.match, observedNodes(observed));
      return {
        plane: "boundary",
        name: boundary.name,
        state: members.length > 0 ? "match" : "unknown",
        severity: members.length > 0 ? SEVERITY_ORDER.match : SEVERITY_ORDER.unknown,
        classification: members.length > 0 ? "match" : "intentUnknownProject",
        intentRow: null,
        confidence: members.length > 0 ? "stated" : "unverifiable",
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Whole-file failures shadow the whole observed side: a verdict over a tree
  // it could not fully read must never read as a claim.
  const unknownFiles = analysis.failures
    .filter(isWholeFileFailure)
    .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));
  if (unknownFiles.length > 0) {
    for (const score of projects) {
      score.state = "unknown";
      score.severity = SEVERITY_ORDER.unknown;
      score.classification = "unanalyzed";
      score.confidence = "unverifiable";
    }
  }

  return { projects, edges, tags, boundaries, intentRows, unknownFiles };
}

/**
 * The `{name: {data: {root, tags}}}` node shape `resolveMembers` reads, from
 * the observed project facts — the one place this module reconstructs a graph
 * shape, and it reconstructs only the fields the selector engine reads.
 *
 * @param {object} observed From `buildObserved`.
 * @returns {Record<string, {data: {root?: string, tags: string[]}}>}
 */
function observedNodes(observed) {
  /** @type {Record<string, {data: {root?: string, tags: string[]}}>} */
  const nodes = {};
  for (const project of observed.projects) {
    nodes[project.name] = {
      data: {
        root: project.data?.root ?? "",
        tags: project.data?.tags ?? project.tags ?? [],
      },
    };
  }
  return nodes;
}

/**
 * The `decisions` command: the deterministic chain behind one recorded
 * architecture decision — decision → the governed rows that stand on it
 * (intent + constraint + fitness) → the projects they govern → the current
 * evidence/findings, and the decision's verification level.
 *
 * It composes the wave-2 modules without owning any of them:
 *
 * - `../governance/adr-registry.mjs` — the read of `docs/adr/` and the
 *   record index (`readAdrContext` below is this module's thin wrapper);
 * - `../governance/decision-graph.mjs` — `forwardDecision`, the walk that
 *   attaches governed rows, projects and evidence, and reports every hop it
 *   cannot resolve in `walk.unresolved`;
 * - `../governance/decision-fitness.mjs` — `computeDecisionFitness`, the
 *   per-decision verification level;
 * - `./provenance-command.mjs` — `intentRows`/`configRows`, the same row
 *   walk `provenance` uses, so this command never holds a second copy of
 *   which rows exist.
 *
 * It is descriptive, like `adr`/`report`: it never exits 1. The chain is a
 * description of what is recorded and whether it is currently satisfied, not
 * a finding. What it DOES refuse, loudly (exit 3, never clean):
 *
 * - an unreadable registry — a read that throws propagates to the caller;
 * - a reference that does not resolve — either the positional `<id>` naming
 *   no ADR record, or any hop of the walk (`walk.unresolved`), including a
 *   binding that names no governed row. A chain that could not walk every hop
 *   is rendered as an unresolved block, never as a clean chain (the
 *   invariant, `../../../../AGENTS.md`).
 *
 * ## What the chain's Fitness leg verifies
 *
 * A decision's `bindings` name rule/fitness ids. This command walks the
 * workspace's declared `fitness` list (like `report` does) and evaluates
 * those functions against the same snapshot the `fitness` command builds, so
 * a binding that names a declared gate derives its real verdict. A binding
 * naming no declared gate derives `unverifiable` — the registry alone asserts
 * nothing, never a clean pass. The whole derivation is deterministic: the
 * same tree, the same law, the same chain.
 */
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatDecisionChain } from "../report/decisions-text.mjs";
import { readAdrContext } from "./adr.mjs";
import { forwardDecision } from "../governance/decision-graph.mjs";
import { computeDecisionFitness } from "../governance/decision-fitness.mjs";
import { stripAdrPrefix, stripRuleFitnessPrefix } from "../governance/adr-registry.mjs";
import { intentRows, configRows, rowLabel } from "./provenance-command.mjs";
import { evaluateFitness, fitnessSnapshot } from "../governance/fitness-registry.mjs";
import { driftForCheck } from "./drift.mjs";
import { hasTag, isComboDepConstraint } from "../rules/tags.mjs";
import { resolveMembers } from "../architecture-intent/selectors.mjs";
import { evaluate } from "../rules/index.mjs";

/**
 * The projects whose tags satisfy a constraint row's source selector — the
 * same match `findConstraintsFor` (`../rules/tags.mjs`) makes, so the row's
 * `governs` never disagrees with the row a rule actually applies to.
 *
 * @param {object} row A `depConstraints` row.
 * @param {object} graph The project graph.
 * @returns {string[]}
 */
function constraintGoverns(row, graph) {
  return Object.entries(graph.nodes)
    .filter(([, project]) =>
      isComboDepConstraint(row)
        ? row.allSourceTags.every((tag) => hasTag(project, tag))
        : hasTag(project, row.sourceTag),
    )
    .map(([name]) => name)
    .sort();
}

/**
 * Resolves one intent side (`from`/`to`/`name`/`source`/`target`) to the
 * projects it names: a declared boundary wins, else the side is an inline
 * selector. Mirrors `sidePatterns` (`../architecture-intent/judge.mjs`).
 *
 * @param {object} intent The normalized intent model.
 * @param {object} graph The project graph.
 * @param {string} side A boundary name or inline selector.
 * @returns {string[]}
 */
function sideProjects(intent, graph, side) {
  const declared = (intent.boundaries ?? []).find((b) => b.name === side);
  const patterns = declared ? declared.match : [side];
  return resolveMembers(patterns, graph.nodes);
}

/**
 * The projects one intent row governs, by row family — the "who does this
 * row bind" answer. A row with no resolvable side governs nothing, which is
 * itself a fact the walk reports (a governed project list is never assumed).
 *
 * @param {object} intent The normalized intent model.
 * @param {object} graph The project graph.
 * @param {object} row An intent row.
 * @returns {string[]}
 */
function intentRowGoverns(intent, graph, row) {
  if (typeof row.name === "string") return [row.name];
  if (typeof row.from === "string") {
    // `forbiddenTags` and the dependency rows claim the FROM side's edges;
    // `allowed`/`forbidden` claim the boundary between both sides.
    const from = sideProjects(intent, graph, row.from);
    if (typeof row.to === "string") {
      const to = sideProjects(intent, graph, row.to);
      return Array.from(new Set([...from, ...to])).sort();
    }
    return from;
  }
  return [];
}

/**
 * The verdicts of the workspace's declared fitness functions, folded into a
 * `{name, verdict}` list — the same `{name, verdict}` shape `fitness` emits,
 * so `computeDecisionFitness` can verify a decision's bound gates against
 * this run's real judgements. Deterministic: same tree, same law, same list.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {object} config The resolved boundary law.
 * @returns {Promise<object[]>} `[{name, verdict}, ...]`.
 */
async function fitnessVerdictsFor(commandContext, config) {
  if (!Array.isArray(config?.fitness) || config.fitness.length === 0) return [];
  // A `drift-free` gate judges the SAME verdict-shaped intent the `fitness`
  // command feeds its registry — `driftForCheck`'s, not the raw normalized
  // model the walk's intent rows are built from: that model carries no
  // `.verdict`, and a gate dispatched on it read as a fail over a clean tree
  // (#737). The construction mirrors `./fitness.mjs`'s `fitnessCommand` —
  // the same `drift.intent === undefined` → `null` resolution — so the two
  // faces derive identical rows from identical facts.
  const drift = await driftForCheck(commandContext);
  const intent =
    drift.intent === undefined
      ? null
      : {
          verdict:
            drift.findings.length > 0
              ? "findings"
              : drift.unresolved.length > 0
                ? "no-verdict"
                : "ok",
          boundaries: drift.boundaries,
          findings: drift.findings,
          unresolved: drift.unresolved,
          notes: drift.notes,
        };
  const snapshot = fitnessSnapshot(commandContext, {
    intent,
    suppressions: config.suppressions ?? [],
  });
  return evaluateFitness(config.fitness, snapshot).map((decision) => ({
    name: decision.name,
    verdict: decision.verdict,
  }));
}

/**
 * The verdict for one `decisions` run: the payload for both renderers, the
 * status, and the coverage that decides exit 0 against 3.
 *
 * @param {string} decisionId The ADR id to walk (`NNN-slug` or `adr:NNN-slug`).
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {object} config The resolved boundary law.
 * @param {{intent?: object|null, fitnessVerdicts?: object[]}} [io]
 *   `intent` is the normalized intent model (or null); `fitnessVerdicts`
 *   overrides the run's own evaluation — a test supplies a fixed list.
 * @returns {Promise<{status: "ok"|"no-verdict", result: object, coverage: object,
 *   report: {text: string, json: string}}>}
 * @throws {Error} on an unreadable registry, a malformed law, a
 *   `driftForCheck` refusal on the fitness leg's intent (an unreadable or
 *   invalid `architecture-intent.json`, an unregistered-plugin graph), or a
 *   config declaring fitness that fails to evaluate — exit-3 class.
 */
export async function decisionsCommand(decisionId, commandContext, config, io = {}) {
  const intent = io.intent ?? null;

  // The registry read — throws on an unreadable `docs/adr/`, which the caller
  // maps to exit 3. Never a clean result.
  const { records, byId, knownFitness } = readAdrContext(commandContext.root, {
    tracked: commandContext.tracked,
  });

  // The governed rows the walk attaches: intent rows and config constraint
  // rows, each carrying the governance block and the projects it governs.
  // `governs` is derived deterministically from the graph, so the walk never
  // has to re-resolve a selector.
  const rowsFromIntent = intent === null ? [] : intentRows(intent);
  /** @type {import("../governance/decision-graph.mjs").GovernedRow[]} */
  const rows = [
    ...rowsFromIntent.map(
      ({ kind, row }) =>
        /** @type {import("../governance/decision-graph.mjs").GovernedRow} */ ({
          id: rowLabel(kind, row),
          kind: "intent",
          decisionRef: row.decisionRef,
          governs: intentRowGoverns(intent, commandContext.graph, row),
        }),
    ),
    ...configRows(config).map(
      ({ kind, row }) =>
        /** @type {import("../governance/decision-graph.mjs").GovernedRow} */ ({
          id: rowLabel(kind, row),
          kind: "constraint",
          decisionRef: row.decisionRef,
          governs: constraintGoverns(row, commandContext.graph),
        }),
    ),
    // The declared fitness gates themselves, keyed by their name — the same
    // id space `declaredFitnessNames`/`stripRuleFitnessPrefix` use, so a
    // decision binding `fitness:cycle-free` resolves to the gate that exists.
    ...(Array.isArray(config?.fitness) ? config.fitness : []).map(
      (gate) =>
        /** @type {import("../governance/decision-graph.mjs").GovernedRow} */ ({
          id: gate.name,
          kind: "fitness",
          governs: resolveMembers(gate.match ?? ["*"], commandContext.graph.nodes),
        }),
    ),
  ];

  // The evidence leg: findings for the projects the rows govern, built from
  // the same evaluation `check` runs. A path-scoped or graph-less context
  // would leave this lookup undefined and `attachRowLeg` reports it as an
  // unresolved walk — never a quiet "no findings" claim.
  const violations = evaluate(commandContext.analysis.imports, commandContext.graph, config);
  const findingsByProject = new Map();
  for (const violation of violations) {
    const list = findingsByProject.get(violation.sourceProject) ?? [];
    list.push({
      id: `${violation.sourceFile}:${violation.line}:${violation.column}`,
      project: violation.sourceProject,
      ruleId: violation.messageId,
    });
    findingsByProject.set(violation.sourceProject, list);
  }

  const walk = forwardDecision(decisionId, {
    records,
    byId,
    knownFitness,
    rows,
    findingsByProject: (project) => findingsByProject.get(project) ?? [],
  });

  // The per-decision fitness derivation, folded with THIS run's verdicts —
  // the `{name, verdict}` list from the declared fitness gates above (or the
  // caller's override). `computeDecisionFitness`'s second argument carries
  // verdicts but is unused; the lookup is the single door, so it is null.
  const verdicts = io.fitnessVerdicts ?? (await fitnessVerdictsFor(commandContext, config));
  const verdictByName = new Map(verdicts.map((v) => [v.name, v]));
  const fitnessLookup = (bindingId) => verdictByName.get(stripRuleFitnessPrefix(bindingId));
  const fitnessById = new Map(
    computeDecisionFitness(records, null, fitnessLookup).map((entry) => [entry.id, entry]),
  );

  const record = byId.get(stripAdrPrefix(decisionId)) ?? null;
  const result = {
    decisionId,
    record,
    walk,
    fitness: record === null ? undefined : fitnessById.get(record.id),
    knownFitness: [...knownFitness].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };

  const unresolved = walk.unresolved;
  const status = walk.ok ? "ok" : "no-verdict";
  const exitCode = status === "ok" ? 0 : 3;

  const coverage = {
    complete: walk.ok,
    projects: Object.keys(commandContext.graph?.nodes ?? {}).length,
    analyzedFiles: commandContext.analysis?.analyzed ?? 0,
    imports: (commandContext.analysis?.imports ?? []).length,
    notAnalyzed: unresolved.map(({ ref, kind: ukind, reason }) => ({
      file: ukind === "decision" ? `${ref}.md` : ref,
      reason,
    })),
    blindSpots: [],
    notes: [],
  };

  const envelope = jsonEnvelope({
    command: "decisions",
    context: {
      root: commandContext.root,
      provider: commandContext.provider ?? "native",
      marker: "docs/adr",
      provenance: null,
    },
    status,
    exitCode,
    coverage,
    result,
  });

  const text = formatDecisionChain({
    decisionId,
    record,
    walk,
    fitness: result.fitness,
  });

  return {
    status,
    result,
    coverage,
    report: {
      text: `${text}\n`,
      json: renderJson(envelope),
    },
  };
}

/**
 * The `change` command: a declared change-intent contract reconciled against
 * the actual architectural delta.
 *
 * Three questions stay separate in this repository, and this module exists to
 * keep them that way. Whether the tree obeys the workspace's long-lived law is
 * `check`'s verdict. Why an architectural state arose is history's question.
 * THIS command answers only: **did the change produce exactly the material
 * architectural consequences its contract declared?** A change can be
 * policy-compliant but undeclared, policy-invalid but intent-matched, both,
 * or neither — every combination is reported on independent axes, and none is
 * collapsed into another.
 *
 * The material delta is not recomputed here. It is `./diff.mjs`'s
 * `computeDiff` over the baseline evidence snapshot's stored graph and the
 * head graph — projects added/removed/changed, edges added/removed — so a
 * "material architectural change" means exactly what `diff` has always meant,
 * never this module's second opinion about which edits count. Constraint
 * evaluation re-judges BOTH sides through the same engine under ONE current
 * law (`../rules/index.mjs` + `./delta-classify.mjs`, the `delta` arrangement)
 * and counts cycles through `../governance/fitness-rules.mjs`'s
 * `cyclicProjects`; no verdict below re-derives what those functions already
 * answer. The workspace-law axis is informational — computed through the same
 * engine, labeled as such, and never folded into this command's exit code:
 * `check` remains the authority on the law.
 *
 * ## Verdicts, and why unfulfilled is its own state
 *
 *   - `matched` — every declared fact is observed, nothing else changed.
 *   - `undeclared` — at least one OBSERVED material change no declaration
 *     covers. A review signal, not a governance failure: the result may still
 *     be legal architecture that simply was not promised.
 *   - `unfulfilled` — nothing undeclared, but at least one declared change
 *     never happened. Proven divergence between plan and outcome — not a
 *     failure to look, and never read as matched.
 *   - `unproven` — the base identity could not be established (the manifest's
 *     `base.commit` against the baseline's provenance), so no comparison this
 *     run makes can be attached to the architectures the author saw.
 *     Unproven MUST NOT become matched; when it holds, constraint rows are
 *     left unevaluated rather than reported over a base this run cannot vouch
 *     for.
 *
 * When unexpected and missing expectations coexist, the verdict reads
 * `undeclared` — the surprise is the reviewer's first question — and both
 * lists are always present in full, so precedence hides nothing.
 *
 * ## Exit fold
 *
 * `undeclared` or `unfulfilled`, or a failed declared constraint, is a
 * finding (exit 1) — the fourth verb whose verdict carries it, beside
 * `check`, `fitness` and `delta`. An unproven identity or an undeterminable
 * constraint is a no-verdict (exit 3). Matched with every declared constraint
 * passing is ok (exit 0). The workspace-law axis rides the envelope as
 * evidence only.
 *
 * Refusals (each a throw → exit 3 upstream): a manifest that fails shape or
 * reference validation, an unreadable/malformed/foreign-schema baseline,
 * incomplete baseline coverage, a provider mismatch, incomplete head
 * coverage, an unregistered-plugin graph over polyglot manifests, and a run
 * with no boundary law (constraints and the law fingerprint need one).
 *
 * This module computes and returns; `../../cli.mjs`'s `runChange` owns argv,
 * output destination and the process exit code (`./README.md`).
 */
import { classifyDelta } from "./delta-classify.mjs";
import { computeDiff } from "./diff.mjs";
import { buildDependencies, buildProjects, computePolicyFingerprint } from "./graph.mjs";
import {
  CONSTRAINT_ORDER,
  CONSTRAINT_ROW_NAMES,
  findChangeIntentReferenceViolations,
  readChangeIntent,
} from "./change-intent.mjs";
import {
  evidenceGraphToProjectGraph,
  refuseUnjudgeableHead,
  sourceProjectAttributor,
} from "./delta.mjs";
import { providerMismatch, readEvidenceSnapshot } from "./delta-snapshot.mjs";
import { cyclicProjects } from "../governance/fitness-rules.mjs";
import { fitnessVerdict } from "../governance/verdict.mjs";
import { buildDecision } from "../report/evidence.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatChangeReport } from "../report/change-text.mjs";
import { evaluateRun } from "../rules/index.mjs";
import { compareSnapshotMetadata } from "./snapshot-meta.mjs";
import { resolveProvenance } from "./provenance.mjs";

/**
 * One expected-fact row as the report and JSON carry it. Kept in one builder
 * so every list entry carries the same five-field vocabulary and a consumer
 * branches on `kind` alone.
 *
 * @param {{kind: string, project?: string, from?: string, to?: string,
 *   type?: string, changes?: object[]}} fields
 * @returns {object}
 */
const factRow = ({ kind, ...rest }) => ({ kind, ...rest });

/** Plain lexicographic comparison — never localeCompare (byte-determinism). */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Sort key for fact rows: kind first, then the identity fields in order. */
function cmpFacts(a, b) {
  return (
    cmp(a.kind, b.kind) ||
    cmp(a.project ?? "", b.project ?? "") ||
    cmp(a.from ?? "", b.from ?? "") ||
    cmp(a.to ?? "", b.to ?? "") ||
    cmp(a.type ?? "", b.type ?? "")
  );
}

/**
 * Reconciles a normalized change-intent contract against the structural diff
 * of the two graphs. Pure — the heart of the command, and the function a
 * future capability (trend context, predicted risk) composes rather than
 * replaces.
 *
 * Edge expectations match on `(from, to)` alone, deliberately: whether the
 * graph emits the dependency as a `static` or `dynamic` edge is the model's
 * spelling, not the author's promise, and requiring it would force the agent
 * to predict implementation detail. The observed type rides the row either
 * way. A project whose tags/type/root CHANGED between the sides has no
 * declaration surface in this version — any such row lands in
 * `unexpected` (`kind: "project-changed"`), the loud direction, because a
 * tag change alters which rows of the boundary law reach the project.
 *
 * @param {object} intent A `parseChangeIntent` result.
 * @param {{addedProjects: object[], removedProjects: object[],
 *   changedProjects: object[], addedEdges: object[], removedEdges: object[]}}
 *   delta `computeDiff`'s output for baseline vs head.
 * @returns {{matched: object[], unexpected: object[], missingExpected: object[]}}
 */
export function reconcileMaterialDelta(intent, delta) {
  const addedProjectNames = new Set(intent.projects.add);
  const removedProjectNames = new Set(intent.projects.remove);
  const edgeKey = ({ from, to }) => `${from}\u0000${to}`;
  const addEdgeKeys = new Set(intent.edges.add.map(edgeKey));
  const removeEdgeKeys = new Set(intent.edges.remove.map(edgeKey));

  /** @type {object[]} */
  const matched = [];
  /** @type {object[]} */
  const unexpected = [];

  for (const project of delta.addedProjects) {
    const row = factRow({ kind: "project-added", project: project.name });
    if (addedProjectNames.has(project.name)) matched.push(row);
    else unexpected.push(row);
  }
  for (const project of delta.removedProjects) {
    const row = factRow({ kind: "project-removed", project: project.name });
    if (removedProjectNames.has(project.name)) matched.push(row);
    else unexpected.push(row);
  }
  for (const edge of delta.addedEdges) {
    const row = factRow({
      kind: "edge-added",
      from: edge.source,
      to: edge.target,
      type: edge.type,
    });
    if (addEdgeKeys.has(edgeKey({ from: edge.source, to: edge.target }))) matched.push(row);
    else unexpected.push(row);
  }
  for (const edge of delta.removedEdges) {
    const row = factRow({
      kind: "edge-removed",
      from: edge.source,
      to: edge.target,
      type: edge.type,
    });
    if (removeEdgeKeys.has(edgeKey({ from: edge.source, to: edge.target }))) matched.push(row);
    else unexpected.push(row);
  }
  // No declaration surface in this version: a metadata change to a project
  // both sides have is always a surprise. Loud by construction — the silent
  // alternative would be dropping it, and a tag change moves the law.
  for (const changed of delta.changedProjects) {
    unexpected.push(
      factRow({
        kind: "project-changed",
        project: changed.name,
        changes: changed.changes,
      }),
    );
  }

  const observedAdded = new Set(delta.addedProjects.map((p) => p.name));
  const observedRemoved = new Set(delta.removedProjects.map((p) => p.name));
  const observedAddEdges = new Set(
    delta.addedEdges.map((edge) => edgeKey({ from: edge.source, to: edge.target })),
  );
  const observedRemoveEdges = new Set(
    delta.removedEdges.map((edge) => edgeKey({ from: edge.source, to: edge.target })),
  );

  // Declared but never observed — the unfulfilled half, kept apart from
  // `unexpected` because "the change did extra" and "the change skipped its
  // own plan" are different review conversations.
  /** @type {object[]} */
  const missingExpected = [];
  for (const name of intent.projects.add) {
    if (!observedAdded.has(name))
      missingExpected.push(factRow({ kind: "project-added", project: name }));
  }
  for (const name of intent.projects.remove) {
    if (!observedRemoved.has(name)) {
      missingExpected.push(factRow({ kind: "project-removed", project: name }));
    }
  }
  for (const edge of intent.edges.add) {
    if (!observedAddEdges.has(edgeKey(edge))) {
      missingExpected.push(factRow({ kind: "edge-added", from: edge.from, to: edge.to }));
    }
  }
  for (const edge of intent.edges.remove) {
    if (!observedRemoveEdges.has(edgeKey(edge))) {
      missingExpected.push(factRow({ kind: "edge-removed", from: edge.from, to: edge.to }));
    }
  }

  return {
    matched: matched.sort(cmpFacts),
    unexpected: unexpected.sort(cmpFacts),
    missingExpected: missingExpected.sort(cmpFacts),
  };
}

/**
 * The reconciliation verdict from its three lists — pure, and the one place
 * the precedence is stated. Precedence hides nothing: every list rides the
 * envelope in full whatever the verdict says.
 *
 * @param {{unexpected: object[], missingExpected: object[]}} lists
 * @param {string[]} unprovenReasons Why the base identity could not be proven.
 * @returns {"matched"|"undeclared"|"unfulfilled"|"unproven"}
 */
export function reconciliationVerdict(lists, unprovenReasons) {
  if (unprovenReasons.length > 0) return "unproven";
  if (lists.unexpected.length > 0) return "undeclared";
  if (lists.missingExpected.length > 0) return "unfulfilled";
  return "matched";
}

/**
 * Judges the constraints the contract declares, through the shared engine —
 * both sides re-judged under the CURRENT law and one shared instant, exactly
 * the `delta` arrangement, so a policy edit between capture and verify cannot
 * fabricate a pass or a fail. Rows appear only for DECLARED constraints: an
 * omitted key was never asserted, and inventing a row for it would report a
 * verdict nobody asked for.
 *
 * @param {object} intent A `parseChangeIntent` result.
 * @param {object} io Everything the judges share: the raw violation arrays
 *   and record arrays for both sides, the rebuilt base graph and the head
 *   graph, the current config, the shared instant, and the attribution
 *   function `classifyDelta` needs for unresolvable records.
 * @returns {object[]} `fitnessVerdict` rows in `CONSTRAINT_ORDER` order.
 */
function judgeDeclaredConstraints(intent, io) {
  /** @type {object[]} */
  const rows = [];
  const introducedUnknown =
    io.classification.violations.unknown.length + io.classification.unresolvable.unknown.length;
  for (const constraint of CONSTRAINT_ORDER) {
    if (intent.constraints[constraint] !== true) continue;
    const name = CONSTRAINT_ROW_NAMES[constraint];
    if (constraint === "noNewViolations") {
      if (introducedUnknown > 0) {
        rows.push(
          fitnessVerdict({
            verdict: "unknown",
            name,
            evidence: { introduced: io.classification.violations.introduced.length },
            message:
              `${introducedUnknown} delta item${introducedUnknown === 1 ? "" : "s"} could not ` +
              "be classified, so the introduced set may be incomplete — an unknown item is " +
              "never read as a clean introduction",
          }),
        );
        continue;
      }
      const introducedNotWaived = io.classification.violations.introduced.filter(
        (entry) => entry.waived !== true,
      );
      rows.push(
        fitnessVerdict({
          verdict: introducedNotWaived.length === 0 ? "pass" : "fail",
          name,
          evidence: {
            introduced: io.classification.violations.introduced.length,
            introducedWaived:
              io.classification.violations.introduced.length - introducedNotWaived.length,
          },
          message:
            introducedNotWaived.length === 0
              ? "no non-waived violation was introduced between the captured base and this tree"
              : `${introducedNotWaived.length} non-waived violation${introducedNotWaived.length === 1 ? "" : "s"} introduced since the captured base`,
        }),
      );
      continue;
    }
    if (constraint === "noNewCycles") {
      const newlyCyclic = io.cyclesHead.filter((project) => !io.cyclesBase.includes(project));
      rows.push(
        fitnessVerdict({
          verdict: newlyCyclic.length === 0 ? "pass" : "fail",
          name,
          evidence: {
            baseCyclicProjects: io.cyclesBase,
            headCyclicProjects: io.cyclesHead,
            newCyclicProjects: newlyCyclic,
          },
          message:
            newlyCyclic.length === 0
              ? "no project sits on a cycle at head that did not sit on one at the captured base"
              : `${newlyCyclic.length} project${newlyCyclic.length === 1 ? " is" : "s are"} on a cycle at head that ${newlyCyclic.length === 1 ? "was" : "were"} acyclic at the captured base: ${newlyCyclic.join(", ")}`,
        }),
      );
    }
  }
  return rows;
}

/**
 * Runs the `change` command: loads the contract and the baseline, proves the
 * base identity, computes the structural delta through `diff`'s own function,
 * reconciles, judges declared constraints, and folds everything into a
 * verdict the process exit code maps onto.
 *
 * @param {string} baselinePath Absolute path to the evidence snapshot
 *   (`archkeep delta --capture` output).
 * @param {string} intentPath Absolute path to the change-intent manifest.
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{config?: object|null, readBaseline?: (path: string) => object,
 *   readIntent?: (path: string) => Promise<object>, now?: string}} [io]
 *   The resolved boundary config (required — constraints are judged under it
 *   and the fingerprint identifies the law), injectable readers so tests drive
 *   the command without disk, and the shared reference instant. Both readers
 *   return VALIDATED domain objects — `readEvidenceSnapshot`'s parse and
 *   `parseChangeIntent`'s normalized contract respectively — the same seam
 *   contract `deltaCommand`'s `readBaseline` states; an injector handing back
 *   raw file contents skips the grammar this command trusts.
 * @returns {Promise<{status: "ok"|"findings"|"no-verdict",
 *   changeIntent: object, coverage: object, report: {text: string, json: string}}>}
 * @throws {Error} on every refusal the module header lists.
 */
export async function changeCommand(
  baselinePath,
  intentPath,
  commandContext,
  { config, readBaseline = readEvidenceSnapshot, readIntent, now } = {},
) {
  const { root, provider, marker, graph, analysis } = commandContext;

  // The one required member of `io`: constraints are judged under the current
  // law and the envelope records which law that was, so an undefined config
  // refuses here rather than degrading either.
  if (config === undefined || config === null) {
    throw new Error(
      "archkeep: cannot reconcile a change intent without a boundary config — the declared " +
        "constraints are judged under the current law and the envelope records which law that " +
        "was, and a run that resolves no law has neither.",
    );
  }

  refuseUnjudgeableHead(commandContext, "reconcile a change intent");

  const intent = await (readIntent ? readIntent(intentPath) : readChangeIntent(intentPath));

  const baseline = readBaseline(baselinePath);

  // Provider mismatch refuses here exactly as `delta` refuses: project
  // identity across two different models is not trustworthy, and matching a
  // declaration against names that may be artefacts would fabricate both
  // directions of the verdict.
  const mismatch = providerMismatch(baseline.provider, provider);
  if (mismatch !== null) {
    throw new Error(
      `archkeep: refusing to reconcile a change intent — ${mismatch}. Re-capture the ` +
        `baseline under this run's provider.`,
    );
  }

  // Reference validation before anything else consumes the declarations: a
  // fact that cannot exist in ANY descendant of this base is a defect in the
  // input, not a divergence to report.
  const referenceViolations = findChangeIntentReferenceViolations(
    intent,
    new Set(baseline.graph.projects.map((project) => project.name)),
  );
  if (referenceViolations.length > 0) {
    throw new Error(
      `archkeep: the change intent '${intentPath}' references architecture the captured ` +
        `baseline does not contain:\n  ${referenceViolations.join("\n  ")}`,
    );
  }

  // Base identity. The commit pin is the proof that the two sides compared
  // are the ones the author saw when writing the contract; without it the
  // run answers unproven with the reason named, never proceeds silently.
  const headProvenance = resolveProvenance(root);
  const headFingerprint = computePolicyFingerprint(config);
  /** @type {string[]} */
  const unprovenReasons = [];
  if (!baseline.provenance || typeof baseline.provenance.commit !== "string") {
    unprovenReasons.push(
      `the baseline '${baselinePath}' carries no provenance, so the contract's base.commit ` +
        `(${intent.base.commit}) cannot be verified against the tree it was captured from`,
    );
  } else if (baseline.provenance.commit !== intent.base.commit) {
    unprovenReasons.push(
      `the contract pins base.commit ${intent.base.commit}, but the baseline was captured at ` +
        `${baseline.provenance.commit} — comparing against a different base than the one the ` +
        `author declared`,
    );
  }

  const meta = compareSnapshotMetadata({
    baselineProvider: baseline.provider,
    headProvider: provider,
    baselineProvenance: baseline.provenance,
    headProvenance,
    baselineFingerprint: baseline.policyFingerprint,
    headFingerprint,
  });
  if (meta.crossRepo) {
    unprovenReasons.push(
      `the baseline's remote (${baseline.provenance?.remote}) differs from this tree's remote ` +
        `(${headProvenance?.remote}) — the comparison may span unrelated repositories`,
    );
  }

  const baseGraphForDiff = {
    projects: baseline.graph.projects,
    dependencies: baseline.graph.dependencies,
  };
  const headGraphForDiff = {
    projects: buildProjects(graph.nodes),
    dependencies: buildDependencies(graph.dependencies),
  };
  const structural = computeDiff(baseGraphForDiff, headGraphForDiff);
  const reconciliation = reconcileMaterialDelta(intent, structural);

  // Constraints and the law axis are computed over both sides re-judged under
  // ONE current law — the `delta` arrangement. Left unevaluated when the base
  // identity is unproven: a constraint pass over evidence this run cannot
  // attach to the declared base would read as a verdict about the wrong
  // trees.
  /** @type {object[]} */
  let constraints = [];
  let liveViolations = null;
  if (unprovenReasons.length === 0) {
    const configWithNow = now === undefined ? config : { ...config, now };
    const baseEngineGraph = evidenceGraphToProjectGraph(baseline.graph);
    const baseRaw = evaluateRun(baseline.records, baseEngineGraph, configWithNow).rawViolations;
    const headEval = evaluateRun(analysis.imports, graph, configWithNow);
    const classification = classifyDelta({
      baseViolations: baseRaw,
      headViolations: headEval.rawViolations,
      baseRecords: baseline.records,
      headRecords: analysis.imports,
      suppressions: config.suppressions ?? [],
      ...(now === undefined ? {} : { now }),
      sourceProjectOf: sourceProjectAttributor(graph, baseline.graph.projects),
    });
    constraints = judgeDeclaredConstraints(intent, {
      classification,
      cyclesBase: cyclicProjects(baseEngineGraph, Object.keys(baseEngineGraph.nodes)),
      cyclesHead: cyclicProjects(graph, Object.keys(graph.nodes)),
    });
    // The informational law axis: what `check` would count right now, after
    // the table — computed here so the envelope can show it beside the
    // intent verdict WITHOUT becoming a second gate over it.
    liveViolations = headEval.violations.length;
  }

  const verdict = reconciliationVerdict(reconciliation, unprovenReasons);
  const failedConstraints = constraints.filter((row) => row.verdict === "fail").length;
  const unknownConstraints = constraints.filter((row) => row.verdict === "unknown").length;
  const findings =
    reconciliation.unexpected.length + reconciliation.missingExpected.length + failedConstraints;

  /** @type {"ok"|"findings"|"no-verdict"} */
  let status;
  /** @type {0|1|3} */
  let exitCode;
  let decision;
  if (verdict === "unproven" || unknownConstraints > 0) {
    status = "no-verdict";
    exitCode = 3;
    decision = buildDecision({
      status,
      coverageComplete: true,
      findings: 0,
      reason:
        verdict === "unproven"
          ? `the change intent could not be verified against the declared base: ${unprovenReasons[0]}`
          : `${unknownConstraints} declared constraint${unknownConstraints === 1 ? "" : "s"} could not be determined`,
    });
  } else if (findings > 0) {
    status = "findings";
    exitCode = 1;
    decision = buildDecision({ status, coverageComplete: true, findings });
  } else {
    status = "ok";
    exitCode = 0;
    decision = buildDecision({ status, coverageComplete: true, findings: 0 });
  }

  /** @type {string[]} */
  const notes = [];
  if (meta.policyChanged === true) {
    notes.push(
      "the boundary law changed since capture — constraints were re-judged under the current " +
        "law applied to both sides, so a finding a policy edit created classifies as unchanged",
    );
  }
  if (meta.dirtyBaseline) {
    notes.push(
      "the baseline was captured from a dirty working tree — its evidence is not a reproducible " +
        "claim about the commit the contract pins",
    );
  }
  if (meta.dirtyHead) {
    notes.push(
      "this run's working tree is dirty — the head side describes uncommitted state, not the " +
        "commit HEAD names",
    );
  }
  if (meta.provenanceOneSided) {
    notes.push(
      "only one side carries repository provenance — the comparison cannot confirm both sides " +
        "come from the same repository",
    );
  }

  const coverage = {
    complete: true,
    projects: headGraphForDiff.projects.length,
    analyzedFiles: analysis.analyzed,
    imports: analysis.imports.length,
    notAnalyzed: [],
    blindSpots: [],
    notes,
  };

  const result = {
    intent: {
      file: intentPath,
      version: intent.version,
      base: { ...intent.base },
      ...(intent.summary === undefined ? {} : { summary: intent.summary }),
      declared: {
        projectsAdd: intent.projects.add.length,
        projectsRemove: intent.projects.remove.length,
        edgesAdd: intent.edges.add.length,
        edgesRemove: intent.edges.remove.length,
        constraints: CONSTRAINT_ORDER.filter((key) => intent.constraints[key] === true),
      },
    },
    baseline: {
      path: baselinePath,
      tool: baseline.tool,
      provider: baseline.provider,
      provenance: baseline.provenance,
      policyFingerprint: baseline.policyFingerprint,
      projects: baseline.graph.projects.length,
      records: baseline.records.length,
    },
    head: {
      provenance: headProvenance,
      policyFingerprint: headFingerprint,
      projects: headGraphForDiff.projects.length,
    },
    reconciliation: {
      verdict,
      reasons: unprovenReasons,
      matched: reconciliation.matched,
      unexpected: reconciliation.unexpected,
      missingExpected: reconciliation.missingExpected,
    },
    constraints,
    policy: {
      fingerprint: headFingerprint,
      changedSinceBase: meta.policyChanged === true,
      liveViolations,
    },
  };

  const envelope = jsonEnvelope({
    command: "change",
    context: { root, provider, marker, provenance: headProvenance },
    status,
    exitCode,
    coverage,
    result,
    decision,
  });

  return {
    status,
    changeIntent: result,
    coverage,
    report: {
      text: formatChangeReport({ change: result, coverage }),
      json: renderJson(envelope),
    },
  };
}

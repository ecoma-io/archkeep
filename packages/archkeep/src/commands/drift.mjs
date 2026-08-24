/**
 * The `drift` command: the observed architecture compared against the declared
 * intended one.
 *
 * Drift is a verdict, not a prediction: every finding names the intent row and
 * the observed fact that violates it. The observed side is the same project
 * graph `graph`/`diff`/`check` read, from any of the three providers — this
 * module reads only the resolved `CommandContext`, never a provider, so the
 * same intent produces the same verdict under Nx, Moon, or native. The
 * intended side is the one canonical contract the workspace declares:
 * `architecture-intent.json` at its root, the same file the `check` command
 * loads and judges (`../architecture-intent/model.mjs` and `judge.mjs`). There
 * is no parallel intent grammar and no `intentConfig` option — one contract,
 * one judge, one fingerprint.
 *
 * ## Two faces, one verdict
 *
 * `drift` is descriptive, exactly like `diff`: it prints the intent, the
 * findings, and the intent fingerprint, and it never exits 1. Only `check`
 * exits 1, and `check` folds drift in by presence — when an intent file is
 * present, `check` loads it and counts intent findings into its verdict (exit
 * 1 on findings, 3 on a malformed intent, exactly like go.work drift). There
 * is no `--drift` flag: an opt-in flag would make a forgotten flag
 * byte-identical to "no drift checked", which is the silent direction this
 * whole tool exists to end.
 *
 * ## Fail-closed
 *
 * This command refuses loudly on every path that cannot reach a verdict,
 * mirroring `diff`'s refusals:
 *
 * - the intent file cannot be read or parsed (strict JSON, validated) → throw
 *   → exit 3;
 * - the observed side is incomplete (`notAnalyzed` non-empty) → exit 3, the
 *   same reasoning as `diff` — every "project missing" would be ambiguous
 *   between "gone" and "never seen";
 * - an Nx workspace has polyglot manifests but the plugin is not registered →
 *   exit 3, the same refusal `graph`/`diff` make;
 * - a boundary or row side matched no observed project → exit 3, the same
 *   no-verdict `check` renders for the same state — "cannot verify" must never
 *   read as "no drift".
 *
 * An empty finding list must mean exactly "the observed architecture matches
 * the intended one".
 *
 * ## decisionRef resolution is a separate, non-verdict axis
 *
 * An intent row's `decisionRef` names the ADR (or rule/fitness id) that
 * supposedly authorizes it — unverified until now, because `resolveDecisionRef`
 * (`../governance/adr-registry.mjs`) had no production caller anywhere in this
 * package. `driftCommand` checks every row that carries one against the
 * workspace's ADR registry (`readAdrContext`, `./adr.mjs`) and lists what does
 * not resolve. This is a fact about the row's documentation, not about the
 * architecture: it never becomes a finding and never changes the exit code —
 * the same posture `./provenance-command.mjs` states for the identical axis,
 * for the identical reason `hasOrigin` never does either.
 *
 * This axis is also the ONLY thing in `drift` that reads the boundary law, and
 * it reads only the fitness ids that law DECLARES (`declaredFitnessNames`, F04)
 * — so the dependence is conditional on an intent row actually carrying a
 * `decisionRef`. `cli.mjs`'s `runDrift` therefore hands the policy load's
 * failure over as `io.configError` rather than throwing it where it happens:
 * a workspace with an intent and no boundary config used to exit 3 from a law
 * `drift` would never have opened, which is a refusal the four above do not
 * make and `../../../../docs/usage/drift.md` never documented. Deferred, not
 * dropped — when a row DOES carry a `decisionRef` the error is thrown here and
 * the exit-3 refusal is byte-identical to what it always was, because resolving
 * citations against an empty declared-fitness set would report rows unresolved
 * on the strength of a law nobody read.
 *
 * ## Determinism
 *
 * Findings are sorted by the judge's total key — plain string comparison
 * everywhere, never `localeCompare` — so two runs over an unchanged tree and
 * intent produce byte-identical text and JSON.
 */
import { isWholeFileFailure } from "../analysis/source-util.mjs";
import { buildDependencies, buildProjects } from "./graph.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { judgeIntent } from "../architecture-intent/judge.mjs";
import { computeIntentFingerprint } from "../architecture-intent/intent-fingerprint.mjs";
import { INTENT_FILE, loadIntent } from "../architecture-intent/model.mjs";
import { formatDriftReport } from "../report/drift-text.mjs";
import { readAdrContext } from "./adr.mjs";
import { intentRows as governanceIntentRows } from "./provenance-command.mjs";
import { declaredFitnessNames, unresolvedDecisionRefRows } from "../governance/adr-registry.mjs";

/**
 * The observed side of the comparison: the same project model `graph` builds.
 * Shared with `check` (which folds drift into its verdict by the same
 * `buildProjects`/`buildDependencies` pair `graph` and `diff` use), so the
 * descriptive command and the checker always compare the same observed facts.
 *
 * Edges whose target is not a project in the model are dropped, the same
 * filter the native provider's `buildDependencies` applies
 * (`./providers/native/graph.mjs`): an Nx graph can carry external edges
 * (`app → npm:lodash`) whose targets live outside the project set, and drift
 * judges the *architecture of the workspace's own projects* — an external
 * package is not a project an intent row can ever name. Without the filter the
 * two providers would disagree on the same tree, and content like an Nx
 * consumer with an allowlist would report every external dependency as
 * `dependencyNotAllowed`.
 *
 * `implicit` edges (build-ordering declarations, not code dependencies) are
 * dropped the same way and counted separately — the report states what it
 * excluded, and an empty finding list still means exactly "no drift among
 * code-dependency edges" (`@nx/enforce-module-boundaries` ignores implicit
 * edges too).
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @returns {{projects: object[], edges: object[], implicitEdges: number}}
 */
export function buildObserved(commandContext) {
  const { graph } = commandContext;
  const projects = buildProjects(graph.nodes);
  const projectNames = new Set(projects.map((project) => project.name));
  const edges = [];
  let implicitEdges = 0;
  for (const edge of buildDependencies(graph.dependencies)) {
    if (edge.type === "implicit") {
      implicitEdges += 1;
      continue;
    }
    if (projectNames.has(edge.source) && projectNames.has(edge.target)) {
      edges.push(edge);
    }
  }
  return { projects, edges, implicitEdges };
}

/**
 * Refuses a drift verdict over a graph known to be incomplete, the same
 * fail-closed condition `graph`/`diff`/`impact`/`explain` share. On an Nx
 * workspace whose `nx.json` does not register this plugin but whose tracked
 * files include polyglot manifests under project roots, the graph carries no
 * polyglot edges — every "project missing" and every absent forbidden edge
 * would be ambiguous between "the architecture changed" and "never seen".
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {string} [what] What the caller was doing, named in the refusal — the
 *   default "judge drift" reads true for every caller that reaches the shared
 *   guard (`graph`, `diff`, `impact`, `explain`, `fitness`, and now `waivers`),
 *   so each command's refusal names its own question rather than every one of
 *   them claiming to be a drift verdict.
 * @throws {Error} on the unregistered-plugin over polyglot manifests.
 */
export function refuseIncompleteGraph(commandContext, what = "judge drift") {
  const { provider, pluginGap } = commandContext;
  if (provider === "nx" && !pluginGap.registered && pluginGap.manifests.length > 0) {
    throw new Error(
      `archkeep: refusing to ${what} for an Nx workspace where this plugin is not ` +
        `registered but polyglot manifests exist under project roots ` +
        `(${pluginGap.manifests.join(", ")}). The graph would carry no polyglot edges, so a ${what} ` +
        `verdict would silently under-represent the real architecture. Register the plugin in ` +
        `nx.json: "plugins": [{ "plugin": "@ecoma-io/archkeep/nx" }], or remove the polyglot ` +
        `manifests if they are not in use.`,
    );
  }
}

/**
 * The drift verdict for `check`'s fold — the intent loaded, the observed side
 * compared, the findings counted. `check` and `../commands/plan-context-command.mjs`
 * call this only when the workspace actually HAS an intent file, but that is
 * their own choice, not a precondition this function requires: absence of an
 * intent is a workspace choice, not a finding (`../../../../AGENTS.md`: an
 * empty result must mean exactly "no drift"), so `intent === undefined` (no
 * tracked architecture-intent.json) returns a quiet result — `intent:
 * undefined` on the return, every list empty — instead of judging one, rather
 * than reaching `judgeIntent`, which assumes a normalized model and has no
 * absent case of its own. That is what lets `../commands/fitness.mjs`'s
 * `fitnessCommand` call this UNCONDITIONALLY: it must still reach the
 * `refuseIncompleteGraph` guard below whether or not intent is declared, so an
 * Nx workspace with an unregistered plugin over polyglot manifests refuses
 * loudly regardless. Every OTHER fail-closed condition — that same
 * unregistered-plugin refusal, an unreadable or invalid intent — still throws,
 * so `check` turns a malformed intent into exit 3 exactly like a malformed
 * go.work.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{loadIntentOverride?: (root: string) => Promise<object>}} [io]
 * @returns {Promise<{intent: {file: string, fingerprint: string, rows: number}|undefined,
 *   observed: {projects: number, edges: number, implicitEdges: number},
 *   findings: object[], unresolved: object[], boundaries: object[],
 *   notes: string[], decisionRefRows: {kind: string, row: object}[]}>} `intent`
 *   is `undefined` exactly when no architecture-intent.json is tracked — a
 *   caller building its own verdict-shaped intent reads that as "no intent
 *   declared", never as "declared and clean". `decisionRefRows` lists every
 *   intent row carrying a `decisionRef`, for `check`'s own citation pass.
 */
export async function driftForCheck(commandContext, io = {}) {
  refuseIncompleteGraph(commandContext);
  const intent = await (io.loadIntentOverride ?? loadIntent)(commandContext.root, {
    tracked: commandContext.tracked,
  });
  const observed = buildObserved(commandContext);
  const observedSummary = {
    projects: observed.projects.length,
    edges: observed.edges.length,
    implicitEdges: observed.implicitEdges,
  };
  if (intent === undefined) {
    return {
      intent: undefined,
      observed: observedSummary,
      findings: [],
      unresolved: [],
      boundaries: [],
      notes: [],
      decisionRefRows: [],
    };
  }
  const verdict = judgeIntent(intent, {
    nodes: commandContext.graph.nodes,
    dependencies: commandContext.graph.dependencies,
  });
  return {
    intent: {
      file: INTENT_FILE,
      fingerprint: computeIntentFingerprint(intent),
      rows: intentRows(intent),
    },
    observed: observedSummary,
    findings: verdict.findings,
    unresolved: verdict.unresolved,
    boundaries: verdict.boundaries,
    notes: verdict.notes,
    // The intent rows that carry a `decisionRef` — surfaced for `check`'s own
    // citation pass (F01) so the gate judges intent citations through the SAME
    // registry as `depConstraints` citations, instead of a second ADR read
    // with a second opinion about the same rows.
    decisionRefRows: intentDecisionRefRows(intent),
  };
}

/**
 * Every intent row that carries a `decisionRef` — the subset `check` folds
 * into its own citation check. The intent model itself stays inside
 * `driftForCheck` (the fold needs only the judge's verdict), so the rows that
 * would have been visible to a resolution pass are surfaced here, additively:
 * absent when the workspace declared no intent, empty when no row carries a
 * `decisionRef`. This is what lets `check` judge intent citations through the
 * SAME registry pass as `depConstraints` citations instead of a second ADR
 * read with a second opinion about the same rows.
 *
 * @param {object} intent The normalized intent model.
 * @returns {{kind: string, row: object}[]}
 */
export function intentDecisionRefRows(intent) {
  return governanceIntentRows(intent).filter(
    ({ row }) => typeof row?.decisionRef === "string" && row.decisionRef.trim() !== "",
  );
}

/**
 * The number of intent rows the judge's verdict is a claim about — boundaries,
 * allowed/forbidden boundary rows, project requirements, dependency rows, and
 * tag rows. `check` and the descriptive command both report it so "no drift"
 * always reads as a claim about a specific contract.
 *
 * @param {object} intent The normalized intent model.
 * @returns {number}
 */
function intentRows(intent) {
  return (
    (intent.boundaries?.length ?? 0) +
    (intent.allowed?.length ?? 0) +
    (intent.forbidden?.length ?? 0) +
    (intent.projects?.required?.length ?? 0) +
    (intent.projects?.forbidden?.length ?? 0) +
    (intent.dependencies?.allowed?.length ?? 0) +
    (intent.dependencies?.forbidden?.length ?? 0) +
    (intent.forbiddenTags?.length ?? 0)
  );
}

/**
 * Runs the `drift` command: loads the intent, refuses incomplete coverage,
 * and computes the verdict.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{loadIntentOverride?: (root: string) => Promise<object>,
 *   config?: object|null, configError?: Error|null,
 *   readAdrContextOverride?: typeof import("./adr.mjs").readAdrContext,
 *   loadAdrRegistryOverride?: typeof import("../governance/adr-registry.mjs").loadAdrRegistry}} [io]
 *   Injectable intent loader for tests. `readAdrContextOverride` (or the
 *   narrower `loadAdrRegistryOverride`, forwarded to the real
 *   `readAdrContext`) stands in for the ADR registry read that resolves each
 *   row's `decisionRef`. `configError` carries a boundary-policy load failure
 *   the caller chose not to throw at the load site — rethrown here, unchanged,
 *   only if an intent row actually cites something.
 * @returns {Promise<{status: "ok", drift: object, coverage: object,
 *   report: {text: string, json: string}}>}
 * @throws {Error} on every condition the header lists, all exit-3 class, plus
 *   a malformed ADR registry — the same loud refusal `provenance` makes for
 *   the identical read.
 */
export async function driftCommand(commandContext, io = {}) {
  const { root, provider, marker, analysis } = commandContext;

  refuseIncompleteGraph(commandContext);

  // A drift verdict cannot be established over a tree it could not fully read.
  const notAnalyzed = analysis.failures
    .filter(isWholeFileFailure)
    .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));

  if (notAnalyzed.length > 0) {
    throw new Error(
      `archkeep: drift has incomplete coverage — ${notAnalyzed.length} file` +
        `${notAnalyzed.length === 1 ? "" : "s"} could not be analyzed, so every "project missing" ` +
        `would be ambiguous between "gone" and "never seen". Fix the unanalyzed files and re-run.`,
    );
  }

  const intent = await (io.loadIntentOverride ?? loadIntent)(root, {
    tracked: commandContext.tracked,
  });
  if (intent === undefined) {
    throw new Error(
      `archkeep: drift requires a tracked ${INTENT_FILE} at the workspace root, but none ` +
        `is present — a workspace without an intended architecture cannot be judged for drift`,
    );
  }
  const observed = buildObserved(commandContext);
  const verdict = judgeIntent(intent, {
    nodes: commandContext.graph.nodes,
    dependencies: commandContext.graph.dependencies,
  });

  // An intent whose boundary or row side matched no observed project reached no
  // verdict on that row — "no drift" must never mean "cannot verify". `check`
  // renders the same state exit 3; the descriptive command must refuse loudly
  // rather than print "✔ no drift".
  if (verdict.unresolved.length > 0) {
    throw new Error(
      `archkeep: cannot compare the observed architecture to ${INTENT_FILE} — ` +
        verdict.unresolved
          .map(({ boundary, issue }) => `boundary/row ${boundary}: ${issue}`)
          .join("; ") +
        `. An intent that cannot be verified is not a clean one; fix the intent or the graph and re-run.`,
    );
  }

  // A row's `decisionRef` names the ADR (or rule/fitness id) that supposedly
  // authorizes it — unverified until now, the same gap `provenance` closes
  // for the identical rows through the identical `readAdrContext`/
  // `unresolvedDecisionRefRows` (`../governance/adr-registry.mjs`). This is a
  // documentation fact about the row, not about the architecture: it changes
  // no finding and no exit code, the same "descriptive, never a verdict"
  // posture `provenance` states for the exact same axis. Only the rows that
  // actually carry one are checked; a workspace that never uses the field
  // pays no extra read.
  const decisionRefRows = governanceIntentRows(intent).filter(
    ({ row }) => typeof row?.decisionRef === "string" && row.decisionRef.trim() !== "",
  );
  let unresolvedDecisionRefs = [];
  if (decisionRefRows.length > 0) {
    // The deferred policy-load failure, thrown at the one place the policy is
    // actually read (see the header's decisionRef section). `knownFitness`
    // below would otherwise be derived from a law that failed to load, and
    // every fitness-id citation would report unresolved on that basis — a
    // loud wrong answer standing in for a refusal.
    if (io.configError) throw io.configError;
    const adrContext = (io.readAdrContextOverride ?? readAdrContext)(root, {
      tracked: commandContext.tracked,
      loadAdrRegistryOverride: io.loadAdrRegistryOverride,
    });
    // F04: the fitness half resolves against the ids the workspace's policy
    // DECLARES (`declaredFitnessNames`, the `io.config` the caller holds),
    // never the ADRs' own `bindings` — a citation cannot resolve itself.
    unresolvedDecisionRefs = unresolvedDecisionRefRows(
      decisionRefRows,
      adrContext.byId,
      declaredFitnessNames(io.config),
    ).map(({ kind, decisionRef }) => ({ kind, decisionRef }));
  }

  // A deferred policy failure that never had to be thrown is still a thing this
  // run noticed and would otherwise say nothing about. It changes no finding —
  // no row cited anything, so the law was never consulted — but "noticed and
  // silent" is the posture this tool exists to refuse, so it rides the same
  // coverage notes an `optional: true` row does, in both faces.
  const notes = [...verdict.notes];
  if (io.configError && decisionRefRows.length === 0) {
    notes.push(
      `the workspace's boundary law could not be loaded (${io.configError.message}) — no intent ` +
        `row carries a decisionRef, so nothing in this verdict was judged against it`,
    );
  }

  const coverage = {
    complete: true,
    projects: observed.projects.length,
    analyzedFiles: analysis.analyzed,
    imports: analysis.imports.length,
    notAnalyzed: [],
    // Drift reads only the graph — provider failures are the same blind spots
    // every other command reports, and a blind spot never prevents a verdict.
    blindSpots: analysis.failures
      .filter((failure) => !isWholeFileFailure(failure))
      .map(({ sourceFile, line, column, reason }) => ({ file: sourceFile, line, column, reason })),
    // Coverage notes (e.g. an `optional: true` allowed row the team has not
    // built yet) ride here so "optional and absent" never reads as "never
    // checked".
    notes,
  };

  const context = { root, provider, marker, provenance: resolveProvenance(root) };
  const result = {
    intent: {
      file: INTENT_FILE,
      fingerprint: computeIntentFingerprint(intent),
      rows: intentRows(intent),
    },
    observed: {
      projects: observed.projects.length,
      edges: observed.edges.length,
      implicitEdges: observed.implicitEdges,
    },
    findings: verdict.findings,
    // Additive and optional: absent when every intent row's decisionRef
    // resolves (or none carries one) — a workspace that never uses the field
    // reads exactly as it did before this axis existed. A documentation fact
    // about the rows, never a drift finding: `verdict.findings` above is the
    // only thing this envelope's `status`/`exitCode` are a claim about.
    ...(unresolvedDecisionRefs.length > 0 ? { unresolvedDecisionRefs } : {}),
  };

  // Drift is descriptive — always status "ok" when it completes, never
  // "findings". A description of what drifts is not itself a finding; only
  // `check` exits 1.
  const status = "ok";
  const exitCode = 0;

  const envelope = jsonEnvelope({
    command: "drift",
    context,
    status,
    exitCode,
    coverage,
    result,
  });

  return {
    status,
    drift: result,
    coverage,
    report: {
      text: formatDriftReport({
        findings: verdict.findings,
        intent: { fingerprint: result.intent.fingerprint, rows: result.intent.rows },
        unresolvedDecisionRefs,
        decisionRefsChecked: decisionRefRows.length,
        observed: {
          projects: result.observed.projects,
          edges: result.observed.edges,
          implicitEdges: result.observed.implicitEdges,
        },
        // Coverage notes (e.g. an `optional: true` allowed row not yet
        // built) already ride `coverage.notes` above for the JSON envelope —
        // this is the SAME list reaching the text face too, so a warning that
        // exists in the coverage object does not stop at the reader who only
        // sees the terminal report. It is `notes`, not `verdict.notes`,
        // precisely so the deferred-policy note above cannot reach one face
        // and not the other.
        notes,
      }),
      json: renderJson(envelope),
    },
  };
}

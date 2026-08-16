/**
 * The `drift` command: the observed architecture compared against the declared
 * intended one.
 *
 * Drift is a verdict, not a prediction: every finding names the intent row and
 * the observed fact that violates it. The observed side is the same project
 * graph `graph`/`diff`/`check` read, from any of the three providers — this
 * module reads only the resolved `CommandContext`, never a provider, so the
 * same intent produces the same verdict under Nx, Moon, or native. The
 * intended side is the workspace-declared contract the `intentConfig` option
 * names (an `architecture-intent.config.mjs` at the workspace root by default).
 *
 * ## Two faces, one verdict
 *
 * `drift` is descriptive, exactly like `diff`: it prints the intent, the
 * findings, and the intent fingerprint, and it never exits 1. Only `check`
 * exits 1, and `check` folds drift in by presence — when an intent file is
 * present at the configured name, `check` loads it and counts drift findings
 * into its verdict (exit 1 on findings, 3 on a malformed intent, exactly like
 * go.work drift). There is no `--drift` flag: an opt-in flag would make a
 * forgotten flag byte-identical to "no drift checked", which is the silent
 * direction this whole tool exists to end, and since the intent schema ships
 * with this feature no pre-existing workspace can carry an intent file that an
 * upgrade would start judging — so presence-keying breaks nothing.
 *
 * ## Fail-closed
 *
 * This command refuses loudly on every path that cannot reach a verdict,
 * mirroring `diff`'s refusals:
 *
 * - the intent file cannot be read, parsed, or `import()`ed → throw → exit 3;
 * - the intent's shape is invalid (each rule validated by `./intent.mjs`,
 *   naming the row) → exit 3;
 * - the observed side is incomplete (`notAnalyzed` non-empty) → exit 3, the
 *   same reasoning as `diff` — every "project missing" would be ambiguous
 *   between "gone" and "never seen";
 * - an Nx workspace has polyglot manifests but the plugin is not registered →
 *   exit 3, the same refusal `graph`/`diff` make.
 *
 * An empty finding list must mean exactly "the observed architecture matches
 * the intended one".
 *
 * ## Determinism
 *
 * Findings are sorted by a total key — `(messageId, row, detail)` — with plain
 * string comparison everywhere, never `localeCompare`, so two runs over an
 * unchanged tree and intent produce byte-identical text and JSON.
 */
import { isWholeFileFailure } from "../analysis/source-util.mjs";
import { buildDependencies, buildProjects } from "./graph.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { computeDrift } from "../drift/drift.mjs";
import { formatDriftReport } from "../drift/drift-text.mjs";
import { computeIntentFingerprint } from "../drift/intent-fingerprint.mjs";
import { loadIntent } from "../drift/intent.mjs";

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
 * two providers would disagree on the same tree, and an Nx consumer with an
 * allowlist would report every external dependency as `dependencyNotAllowed`.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @returns {{projects: object[], edges: object[]}}
 */
export function buildObserved(commandContext) {
  const { graph } = commandContext;
  const projects = buildProjects(graph.nodes);
  const projectNames = new Set(projects.map((project) => project.name));
  const edges = buildDependencies(graph.dependencies).filter(
    (edge) => projectNames.has(edge.source) && projectNames.has(edge.target),
  );
  return { projects, edges };
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
 * @throws {Error} on the unregistered-plugin over polyglot manifests.
 */
export function refuseIncompleteGraph(commandContext) {
  const { provider, pluginGap } = commandContext;
  if (provider === "nx" && !pluginGap.registered && pluginGap.manifests.length > 0) {
    throw new Error(
      `lattice: refusing to judge drift for an Nx workspace where this plugin is not ` +
        `registered but polyglot manifests exist under project roots ` +
        `(${pluginGap.manifests.join(", ")}). The graph would carry no polyglot edges, so a drift ` +
        `verdict would silently under-represent the real architecture. Register the plugin in ` +
        `nx.json: "plugins": [{ "plugin": "@ecoma-io/lattice/nx" }], or remove the polyglot ` +
        `manifests if they are not in use.`,
    );
  }
}

/**
 * The drift verdict for `check`'s fold — the intent loaded, the observed side
 * compared, the findings counted. `check` calls this only when the workspace
 * actually HAS an intent file; absence of an intent is a workspace choice, not
 * a finding (`../../../../AGENTS.md`: an empty result must mean exactly "no
 * drift"). It throws on the same fail-closed conditions the descriptive
 * command does, so `check` turns a malformed intent into exit 3 exactly like a
 * malformed go.work.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{loadIntentOverride?: (root: string, intentConfig: string) => Promise<object>}} [io]
 * @returns {Promise<{intent: {file: string, fingerprint: string, rows: number},
 *   observed: {projects: number, edges: number, implicitEdges: number},
 *   findings: object[]}>}
 */
export async function driftForCheck(commandContext, io = {}) {
  refuseIncompleteGraph(commandContext);
  const intentConfig = commandContext.options.intentConfig;
  const intent = await (io.loadIntentOverride ?? loadIntent)(commandContext.root, intentConfig);
  const observed = buildObserved(commandContext);
  const verdict = computeDrift(intent, observed);
  return {
    intent: {
      file: intentConfig,
      fingerprint: computeIntentFingerprint(intent),
      rows: verdict.intentRows,
    },
    observed: {
      projects: verdict.projects,
      edges: verdict.edges,
      implicitEdges: verdict.implicitEdges,
    },
    findings: verdict.findings,
  };
}

/**
 * Runs the `drift` command: loads the intent, refuses incomplete coverage,
 * and computes the verdict.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{loadIntentOverride?: (root: string, intentConfig: string) => Promise<object>,
 *   config?: object|null}} [io] Injectable intent loader for tests; `config` is
 *   unused today and kept so a caller can later layer boundary-rule context on
 *   the verdict without reaching this module.
 * @returns {Promise<{status: "ok", drift: object, coverage: object,
 *   report: {text: string, json: string}}>}
 * @throws {Error} on every condition the header lists, all exit-3 class.
 */
export async function driftCommand(commandContext, io = {}) {
  const { root, provider, marker, analysis, options } = commandContext;
  const intentConfig = options.intentConfig;

  refuseIncompleteGraph(commandContext);

  // A drift verdict cannot be established over a tree it could not fully read.
  const notAnalyzed = analysis.failures
    .filter(isWholeFileFailure)
    .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));

  if (notAnalyzed.length > 0) {
    throw new Error(
      `lattice: drift has incomplete coverage — ${notAnalyzed.length} file` +
        `${notAnalyzed.length === 1 ? "" : "s"} could not be analyzed, so every "project missing" ` +
        `would be ambiguous between "gone" and "never seen". Fix the unanalyzed files and re-run.`,
    );
  }

  const intent = await (io.loadIntentOverride ?? loadIntent)(root, intentConfig);
  const observed = buildObserved(commandContext);
  const verdict = computeDrift(intent, observed);

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
    notes: [],
  };

  const context = { root, provider, marker, provenance: resolveProvenance(root) };
  const result = {
    intent: {
      file: intentConfig,
      fingerprint: computeIntentFingerprint(intent),
      rows: verdict.intentRows,
    },
    observed: {
      projects: verdict.projects,
      edges: verdict.edges,
      implicitEdges: verdict.implicitEdges,
    },
    findings: verdict.findings,
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
        observed: {
          projects: verdict.projects,
          edges: verdict.edges,
          implicitEdges: verdict.implicitEdges,
        },
      }),
      json: renderJson(envelope),
    },
  };
}

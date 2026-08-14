/**
 * The `graph` command: the project graph as a deterministic, serialisable
 * snapshot.
 *
 * `graph` reads the same project model every other command reads — Nx or
 * native, resolved by `./context.mjs` — and returns it as two sorted arrays:
 * one of projects and one of edges. It strips every internal field the rule
 * engine uses but that is not a fact about the consumer's architecture
 * (`../../CLAUDE.md` documents that snapshots do not publish `mfeRemote`,
 * `entryPoints`, or `declaredPackages`). It is descriptive: it never exits 1,
 * because a snapshot of what is is never a finding.
 *
 * What it needs from its caller is a `CommandContext` — the preamble every
 * command shares (`./context.mjs`). What it gives back is a `status`, the
 * payload for both the text and the JSON renderers, and enough coverage
 * information to build a correct envelope. It does not print, and it does not
 * decide the process's exit code — `../../cli.mjs` owns those
 * (`./README.md`).
 *
 * ## The unregistered-plugin refusal
 *
 * On an Nx workspace whose `nx.json` does not register this plugin but whose
 * tracked files include polyglot manifests under project roots, `graph`
 * refuses loudly rather than returning a snapshot whose edges silently
 * under-represent the real architecture. The refusal is narrowed to that
 * condition: a pure-TypeScript Nx workspace whose graph is complete without
 * this plugin is never refused. No escape flag: an option that made analysis
 * not run would turn an unknown result into an apparently valid snapshot.
 */
import { createHash } from "node:crypto";

import { isWholeFileFailure } from "../analysis/source-util.mjs";
import { DEFAULT_WORKSPACE_LAYOUT } from "../rules/specifiers.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatGraphReport } from "../report/graph-text.mjs";

/**
 * The fields stripped from every project node before it enters the snapshot.
 * Each of these is a fact about how this tool reads upstream, not a fact about
 * the consumer's architecture; publishing them in a versioned contract would
 * freeze upstream's internal shape into ours.
 */
const INTERNAL_DATA_FIELDS = Object.freeze(["mfeRemote", "entryPoints", "declaredPackages"]);

/**
 * Builds the project list for the graph snapshot: one entry per node, sorted
 * by name using plain string comparison (never `localeCompare` —
 * two runs over an unchanged tree must produce byte-identical JSON, and
 * `localeCompare` depends on locale and ICU data).
 *
 * `targets` is emitted as `Object.keys(node.data.targets)` only when the node
 * declares any — the field is omitted, not `[]`, because a native project
 * genuinely has no target table and an empty array would assert it has none
 * declared when the concept does not apply. Iterate with `Object.hasOwn`
 * guards because the native graph's null-prototype containers exist for
 * `__proto__` safety and a naive `for…in` over a reconstructed object undoes
 * it.
 *
 * @param {object} nodes The `graph.nodes` map from the project graph.
 * @returns {object[]}
 */
export function buildProjects(nodes) {
  return (
    Object.values(nodes)
      .map((node) => {
        // Strip internal fields: they belong to this tool's rule engine, not to
        // the consumer's architecture. The project's `data` object may carry
        // `mfeRemote`, `entryPoints` and `declaredPackages` — computed by
        // `../workspace.mjs`'s two annotators to reproduce upstream behaviour —
        // but a versioned contract that published them would freeze upstream's
        // internal shape into ours.
        const data = { ...node.data };
        for (const field of INTERNAL_DATA_FIELDS) {
          delete data[field];
        }
        const project = {
          name: node.name,
          root: data.root,
          type: node.type,
          tags: data.tags ?? [],
        };
        // Emit `targets` only when the node declares any. A native project has
        // no target table, and an empty array would falsely assert "zero
        // targets declared" when the concept does not apply.
        const targets =
          data.targets && Object.hasOwn(data, "targets")
            ? Object.keys(data.targets).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
            : undefined;
        if (targets !== undefined && targets.length > 0) {
          project.targets = targets;
        }
        return project;
      })
      // Plain string comparison — never localeCompare. Determinism is part of
      // the contract: two runs over an unchanged tree must produce byte-identical
      // JSON, because `diff`'s whole premise is that a difference in the bytes
      // means a difference in the architecture. localeCompare depends on the
      // locale and the Node build's ICU data, so a snapshot taken on CI and
      // diffed on a developer's machine could differ in order alone.
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  );
}

/**
 * Builds the flat sorted edge array from the Nx source-keyed dependency map.
 *
 * Edge identity is `(source, target, type)` — keying on `(source, target)`
 * alone would hide a `static`->`dynamic` change, a real architectural event.
 *
 * @param {object} dependencies The `graph.dependencies` map.
 * @returns {{source: string, target: string, type: string}[]}
 */
export function buildDependencies(dependencies) {
  const edges = [];
  for (const source of Object.keys(dependencies)) {
    if (!Object.hasOwn(dependencies, source)) continue;
    const targets = dependencies[source];
    for (const edge of targets) {
      edges.push({
        source,
        target: edge.target,
        type: edge.type,
      });
    }
  }
  return edges.sort((a, b) => {
    // Three-key lexicographic sort, plain string comparison throughout.
    if (a.source < b.source) return -1;
    if (a.source > b.source) return 1;
    if (a.target < b.target) return -1;
    if (a.target > b.target) return 1;
    if (a.type < b.type) return -1;
    if (a.type > b.type) return 1;
    return 0;
  });
}

/**
 * Computes a deterministic fingerprint for the boundary policy, so `diff`
 * can warn when the policy changed between runs without re-implementing the
 * config comparison logic.
 *
 * The fingerprint is SHA-256 of the canonicalized JSON for `depConstraints`,
 * `options`, and `suppressions` — the three fields that affect which
 * violations `evaluate` would produce. It changes only when the policy
 * changes, and it is provider-independent (no workspace root, no file paths).
 *
 * @param {object} config The loaded boundary config.
 * @returns {string} A hex-encoded SHA-256 fingerprint.
 */
export function computePolicyFingerprint(config) {
  const policy = {
    depConstraints: config.depConstraints ?? [],
    options: config.options ?? {},
    suppressions: config.suppressions ?? [],
  };
  // Canonicalise: sort object keys at every depth so insertion order does not
  // affect the hash. Semantic equality, not construction order, is the claim.
  const canonical = JSON.stringify(policy, (_, value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value)
          .sort()
          .reduce((sorted, key) => {
            sorted[key] = value[key];
            return sorted;
          }, {})
      : value,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Runs the `graph` command: resolves the command context, checks the
 * unregistered-plugin condition, and returns the snapshot.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{config?: object}} [io] Optional IO overrides. `config` is the loaded
 *   boundary config; when provided, a `policy` fingerprint is included in the
 *   snapshot so `diff` can warn when the policy changed between runs.
 * @returns {{status: "ok"|"no-verdict", projects: object[], dependencies: object[],
 *   workspaceLayout: {appsDir: string, libsDir: string}, workspaceLayoutSource: string,
 *   policy: {fingerprint: string}|undefined,
 *   coverage: object, report: {text: string, json: string}}}
 * @throws {Error} when an Nx workspace has polyglot manifests but the plugin
 *   is not registered — the graph would silently under-represent the real
 *   architecture.
 */
export function graphCommand(commandContext, { config = null } = {}) {
  const { root, provider, marker, graph, pluginGap } = commandContext;

  // Descriptive commands refuse when the graph is known to be incomplete.
  // On an Nx workspace, if the plugin is not registered but polyglot manifests
  // exist under project roots, the graph carries no polyglot edges and the
  // snapshot would be a lie about the architecture — every "removed" edge in a
  // later `diff` would be ambiguous between "gone" and "never seen".
  if (provider === "nx" && !pluginGap.registered && pluginGap.manifests.length > 0) {
    throw new Error(
      `lattice: refusing to build a graph snapshot for an Nx workspace where this plugin is ` +
        `not registered but polyglot manifests exist under project roots ` +
        `(${pluginGap.manifests.join(", ")}). The graph would carry no polyglot edges, ` +
        `so the snapshot would silently under-represent the real architecture. ` +
        `Register the plugin in nx.json: ` +
        `"plugins": [{ "plugin": "@ecoma-io/lattice/nx" }], or remove the polyglot manifests ` +
        `if they are not in use.`,
    );
  }

  const notAnalyzed = commandContext.analysis.failures
    .filter(isWholeFileFailure)
    .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));

  const complete = notAnalyzed.length === 0;
  const status = complete ? "ok" : "no-verdict";
  const exitCode = complete ? 0 : 3;

  const projects = buildProjects(graph.nodes);
  const dependencies = buildDependencies(graph.dependencies);

  // `workspaceLayout` is carried on the graph object when the provider knows
  // it. When absent, the engine's own default applies — imported from
  // `../rules/specifiers.mjs` rather than written a second time here, because
  // two copies of a default is how a report ends up describing a layout the
  // engine did not use.
  const workspaceLayout = Object.hasOwn(graph, "workspaceLayout")
    ? graph.workspaceLayout
    : DEFAULT_WORKSPACE_LAYOUT;
  const workspaceLayoutSource = Object.hasOwn(graph, "workspaceLayout") ? "declared" : "default";

  const coverage = {
    complete,
    projects: projects.length,
    analyzedFiles: commandContext.analysis.analyzed,
    imports: commandContext.analysis.imports.length,
    notAnalyzed,
    blindSpots: commandContext.analysis.failures
      .filter((f) => !isWholeFileFailure(f))
      .map(({ sourceFile, line, column, reason }) => ({ file: sourceFile, line, column, reason })),
    notes: [],
  };

  const context = { root, provider, marker };
  const result = {
    projects,
    dependencies,
    workspaceLayout,
    workspaceLayoutSource,
  };

  // When the boundary config is provided, include a policy fingerprint so
  // `diff` can warn when the policy changed between runs. Without a config,
  // the snapshot carries no policy identity — the consumer did not provide one.
  if (config) {
    result.policy = { fingerprint: computePolicyFingerprint(config) };
  }

  const envelope = jsonEnvelope({
    command: "graph",
    context,
    status,
    exitCode,
    coverage,
    result,
  });

  return {
    status,
    projects,
    dependencies,
    workspaceLayout,
    workspaceLayoutSource,
    policy: result.policy,
    coverage,
    report: {
      text: formatGraphReport({
        projects,
        dependencies,
        workspaceLayout,
        workspaceLayoutSource,
        coverage,
      }),
      json: renderJson(envelope),
    },
  };
}

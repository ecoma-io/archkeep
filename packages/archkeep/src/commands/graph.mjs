/**
 * The `graph` command: the project graph as a deterministic, serialisable
 * snapshot.
 *
 * `graph` reads the same project model every other command reads — Nx or
 * native, resolved by `./context.mjs` — and returns it as two sorted arrays:
 * one of projects and one of edges. It strips every internal field the rule
 * engine uses but that is not a fact about the consumer's architecture
 * (`../../AGENTS.md` documents that snapshots do not publish `mfeRemote`,
 * `entryPoints`, or `declaredPackages`). It is descriptive: it never exits 1,
 * because a snapshot of what is is never a finding.
 *
 * Its completeness verdict is not computed here: `graphCommand` composes
 * `./coverage-verdict.mjs`'s `coverageVerdict`, the one constructor every
 * refusal-contract face reads, so this snapshot's `status`/`exitCode` cannot
 * drift from the axes `check` judges completeness over. The graph-family
 * restatement this replaces is how the zero-analysis axis went missing here
 * while every other face carried it (#612).
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

import { canonicalizeJson } from "../canonical.mjs";
import { DEFAULT_WORKSPACE_LAYOUT } from "../rules/specifiers.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatGraphReport } from "../report/graph-text.mjs";
import { coverageIncompleteReasons } from "../verdict.mjs";
import { coverageVerdict } from "./coverage-verdict.mjs";
import { resolveProvenance } from "./provenance.mjs";

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
          tags: (data.tags ?? []).slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
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
 * `options`, `suppressions` and — when the policy declares them — the
 * `fitness`, `customRules`, `coverage` and `markdown` blocks, plus the
 * selected profile's NAME when the law was selected by name. Those are every
 * field of a loaded policy that states law: the first three decide which
 * violations `evaluate` produces, the fourth decides which fitness functions
 * `check` folds into the same exit code
 * (`../governance/fitness-registry.mjs`), and the fifth names the rule
 * artifacts a workspace declared, each pinned to the bytes its `sha256` claims
 * (`../config.mjs`'s `customRuleRowViolations`) — swap one row's hash or its
 * `params` and the policy says something different. The three after those are
 * argued at their keys below. A field that can fail a build and is not in the
 * hash is a law that can be rewritten while `diff` reports the policy
 * unchanged — the silent direction, and the reason the list here and
 * `policyFrom`'s return shape (`../config.mjs`) are revisited together.
 *
 * The conditional fields are included only when they are DECLARED, and the
 * absent case contributes no key rather than an empty array. A policy that
 * declares none therefore fingerprints exactly as it did before those fields
 * were covered, so extending the hash did not move every existing snapshot's
 * value — only those whose law it was failing to describe.
 *
 * @param {object} config The loaded boundary config.
 * @returns {string} A hex-encoded SHA-256 fingerprint.
 */
export function computePolicyFingerprint(config) {
  const policy = {
    depConstraints: config.depConstraints ?? [],
    options: config.options ?? {},
    suppressions: config.suppressions ?? [],
    ...(config.fitness === undefined ? {} : { fitness: config.fitness }),
    ...(config.customRules === undefined ? {} : { customRules: config.customRules }),
    // The acceptance channel is law the same way the blocks above are: a
    // `coverage.unowned` row withdraws an unclaimed file's whole-file failure
    // as a recorded acceptance (`../config.mjs`'s `findCoverageViolations`
    // owns the shape, `../commands/coverage-acceptance.mjs` matches it), so a
    // policy that records or removes an acceptance must not share a
    // fingerprint with one that does not — `diff`'s policy-changed warning
    // reads this hash (#709: the one block `policyFrom` sets that the hash
    // skipped). Conditional, like the three above, so a policy recording no
    // acceptance hashes exactly as it did before this key existed.
    ...(config.coverage === undefined ? {} : { coverage: config.coverage }),
    // The document track is law the same way the blocks above are: it
    // decides what this run judges, so a policy that adds or edits a
    // `markdown` block must not share a fingerprint with one that does not —
    // `diff`'s policy-changed warning reads this hash. Conditional, like the
    // three above, so a policy declaring no block hashes exactly as it did
    // before this key existed.
    ...(config.markdown === undefined ? {} : { markdown: config.markdown }),
    // The named selection is law identity the same way the blocks above are:
    // `profilePolicy` (`../governance/profile-registry.mjs`) sets this key
    // when the workspace selects a profile by name, and two profiles whose
    // resolved blocks converge are still two different named laws. Only
    // `check`'s report names the selection, so a hash blind to it would let a
    // `delta` across a switch report the law unchanged with nothing anywhere
    // saying it moved. Conditional, like the four above, so a policy
    // selected by file or inline — no `profile` key at all — hashes exactly
    // as it did before the selection was covered.
    ...(config.profile === undefined ? {} : { profile: config.profile }),
  };
  // Canonicalise: sort object keys at every depth so insertion order does not
  // affect the hash. Semantic equality, not construction order, is the claim —
  // the same canonicalizer the intent fingerprint uses
  // (`../architecture-intent/intent-fingerprint.mjs`), so two fingerprints
  // cannot drift from two serializations.
  const canonical = canonicalizeJson(policy);
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
      `archkeep: refusing to build a graph snapshot for an Nx workspace where this plugin is ` +
        `not registered but polyglot manifests exist under project roots ` +
        `(${pluginGap.manifests.join(", ")}). The graph would carry no polyglot edges, ` +
        `so the snapshot would silently under-represent the real architecture. ` +
        `Register the plugin in nx.json: ` +
        `"plugins": [{ "plugin": "@ecoma-io/archkeep/nx" }], or remove the polyglot manifests ` +
        `if they are not in use.`,
    );
  }

  // The completeness verdict is the shared constructor's, not this file's:
  // restating the axes here is how the `analyzed > 0` term went missing from
  // this face while `check` carried it (#612 — a run that judged no file at
  // all used to report `ok` / `complete: true` / exit 0, byte-for-byte the
  // envelope a clean workspace gets). `coverageVerdict` owns the one law —
  // no whole-file failure, no unjudged site, at least one file analyzed —
  // and the same return shape the envelope and the text face both read.
  const verdict = coverageVerdict(commandContext);
  const { complete, status, exitCode } = verdict;

  // The clauses the text face renders over an incomplete run, worded by the
  // same function `verdictFor` joins into `decision.reason` — one wording,
  // two renderings, and neither can drift from the other.
  const coverageIncomplete = coverageIncompleteReasons({
    unchecked: verdict.notAnalyzed.length,
    blindSpots: verdict.blindSpotCount,
    analyzed: commandContext.analysis.analyzed,
  });

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
    notAnalyzed: verdict.notAnalyzed,
    blindSpots: verdict.blindSpots,
    notes: [],
  };

  const context = { root, provider, marker, provenance: resolveProvenance(root) };
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
        coverageIncomplete,
      }),
      json: renderJson(envelope),
    },
  };
}

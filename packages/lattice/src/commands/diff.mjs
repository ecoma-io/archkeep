/**
 * The `diff` command: two graph snapshots compared, edge by edge.
 *
 * `diff` takes a baseline snapshot FILE (not a git ref —
 * a ref baseline means building a second graph at another commit, a much larger
 * claim about what the tool is allowed to do to a repository) and the head
 * context this run resolves, and computes what changed between them: projects
 * added, removed, or changed in metadata, and edges added, removed, or changed
 * in type. It is descriptive: it never exits 1, because a description of what changed is
 * never a finding (only `check` ever exits 1).
 *
 * When a boundary config is provided (via `--config` or the workspace's own
 * declaration), `diff` also computes the rule-impact: which boundary violations
 * the added edges introduce and which the removed edges resolve. This is
 * narrower than `check` — it checks only `depConstraints` (tag-based), not
 * npm/circular/lazy-load rules that need import-site details. A consumer who
 * needs the complete verdict should run `check`.
 *
 * `diff` refuses an incomplete baseline or head. If either side could not read
 * part of the tree, every "removed" project and edge is ambiguous between
 * "gone" and "never seen" — reporting the diff anyway would manufacture
 * architectural changes out of a broken run. Exit 3 with that sentence in the
 * message.
 *
 * What it needs from its caller is a `CommandContext` for the head, the path
 * to the baseline file, and an optional `readBaseline` seam (injected the same
 * way every IO seam in this codebase is — pure function of its arguments, no
 * filesystem in unit tests). What it gives back is a `status`, the diff
 * payload for both the text and the JSON renderers, and enough coverage
 * information to build a correct envelope. It does not print, and it does not
 * decide the process's exit code — `../../cli.mjs` owns those
 * (`./README.md`).
 *
 * ## The unregistered-plugin refusal
 *
 * Same as `graph`: on an Nx workspace whose `nx.json` does not register this
 * plugin but whose tracked files include polyglot manifests under project
 * roots, `diff` refuses loudly rather than computing a diff against a head
 * whose edges silently under-represent the real architecture.
 */
import { readFileSync } from "node:fs";

import { isWholeFileFailure } from "../analysis/source-util.mjs";
import { buildDependencies, buildProjects, computePolicyFingerprint } from "./graph.mjs";
import { computeRuleImpact } from "./edge-constraints.mjs";
import { SCHEMA_VERSION } from "../report/json.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatDiffReport } from "../report/diff-text.mjs";
import { resolveProvenance } from "./provenance.mjs";

/**
 * Reads and validates a baseline snapshot from `path`.
 *
 * Returns the parsed envelope's `result` (the `{projects, dependencies}`
 * payload) and `coverage`. Throws on every condition that would make the diff
 * dishonest: a file that cannot be read, an envelope whose schema version this
 * tool does not know, or a baseline whose coverage is not complete (every
 * "removed" entry would be ambiguous between "gone" and "never seen").
 *
 * @param {string} path Absolute path to the baseline JSON file.
 * @returns {{projects: object[], dependencies: object[], coverage: object, policy: object|null,
 *   provider: string|null, provenance: {commit: string, remote: string|null, dirty: boolean}|null}}
 * @throws {Error}
 */
function readBaselineFromDisk(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(
      `lattice: cannot read the baseline snapshot from '${path}': ${cause?.message ?? cause}`,
      { cause },
    );
  }

  return parseBaseline(text, path);
}

/**
 * Parses and validates a baseline snapshot from its text content. Separated
 * from `readBaselineFromDisk` so a test can inject the content without the
 * filesystem.
 *
 * @param {string} text The raw JSON text of the baseline envelope.
 * @param {string} path The path to name in error messages.
 * @returns {{projects: object[], dependencies: object[], coverage: object, policy: object|null,
 *   provider: string|null, provenance: {commit: string, remote: string|null, dirty: boolean}|null,
 *   toolVersion: string|null}}
 * @throws {Error}
 */
export function parseBaseline(text, path) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `lattice: the baseline snapshot at '${path}' is not valid JSON: ${cause?.message ?? cause}`,
      { cause },
    );
  }

  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error(
      `lattice: the baseline snapshot at '${path}' is not a JSON object — it is not a ` +
        `lattice graph envelope`,
    );
  }

  if (typeof envelope.schemaVersion !== "number") {
    throw new Error(
      `lattice: the baseline snapshot at '${path}' has no schemaVersion field — it is not a ` +
        `lattice graph envelope`,
    );
  }

  // A consumer that reads a schemaVersion it does not recognise should refuse
  // to parse the rest (`docs/usage/json-output.md`). This tool IS that
  // consumer when reading a baseline — a future schema version could change
  // the edge shape in ways this diff code would silently misinterpret.
  if (envelope.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `lattice: the baseline snapshot at '${path}' uses schemaVersion ${envelope.schemaVersion}, ` +
        `but this build only understands schemaVersion ${SCHEMA_VERSION}. A baseline from a later ` +
        `major version may have a different shape this diff would silently misread; upgrade ` +
        `lattice or regenerate the snapshot.`,
    );
  }

  if (envelope.command !== "graph") {
    throw new Error(
      `lattice: the baseline snapshot at '${path}' is a '${envelope.command}' envelope, not a ` +
        `'graph' envelope — diff requires a graph snapshot as its baseline`,
    );
  }

  if (!envelope.coverage?.complete) {
    throw new Error(
      `lattice: the baseline snapshot at '${path}' has incomplete coverage — every "removed" ` +
        `entry in the diff would be ambiguous between "gone" and "never seen", so diff refuses ` +
        `to compute against a baseline that could not fully read its tree`,
    );
  }

  if (!Array.isArray(envelope.result?.projects)) {
    throw new Error(
      `lattice: the baseline snapshot at '${path}' has no result.projects array — it is not a ` +
        `lattice graph snapshot`,
    );
  }

  if (!Array.isArray(envelope.result?.dependencies)) {
    throw new Error(
      `lattice: the baseline snapshot at '${path}' has no result.dependencies array — it is not a ` +
        `lattice graph snapshot`,
    );
  }

  // Per-record validation: every project must have a name and root, every
  // dependency must have source, target, and type. A malformed record would
  // make the diff silently miscompute which projects or edges changed.
  for (const [i, project] of envelope.result.projects.entries()) {
    if (typeof project.name !== "string" || typeof project.root !== "string") {
      throw new Error(
        `lattice: the baseline snapshot at '${path}' has a result.projects[${i}] record ` +
          `missing 'name' or 'root' — it is not a valid lattice project record`,
      );
    }
  }

  for (const [i, edge] of envelope.result.dependencies.entries()) {
    if (
      typeof edge.source !== "string" ||
      typeof edge.target !== "string" ||
      typeof edge.type !== "string"
    ) {
      throw new Error(
        `lattice: the baseline snapshot at '${path}' has a result.dependencies[${i}] record ` +
          `missing 'source', 'target', or 'type' — it is not a valid lattice dependency record`,
      );
    }
  }

  return {
    projects: envelope.result.projects,
    dependencies: envelope.result.dependencies,
    coverage: envelope.coverage,
    policy: envelope.result.policy ?? null,
    provider: envelope.workspace?.provider ?? null,
    provenance: envelope.workspace?.provenance ?? null,
    toolVersion: envelope.tool?.version ?? null,
  };
}

/**
 * Builds the head snapshot from the command context using the same
 * `buildProjects`/`buildDependencies` functions `graphCommand` uses, so the
 * baseline is the only thing that comes from outside the run.
 *
 * @param {object} commandContext
 * @returns {{projects: object[], dependencies: object[]}}
 */
function buildHeadSnapshot(commandContext) {
  const { graph } = commandContext;
  return {
    projects: buildProjects(graph.nodes),
    dependencies: buildDependencies(graph.dependencies),
  };
}

/**
 * Computes the diff between two graph snapshots.
 *
 * Edge identity is `(source, target, type)` — a `static` edge becoming
 * `dynamic` is an added edge under the new type and a removed edge under the
 * old one, which is exactly what a consumer wants to see: it is a real
 * architectural event, not an implementation detail.
 *
 * @param {{projects: object[], dependencies: object[]}} baseline
 * @param {{projects: object[], dependencies: object[]}} head
 * @returns {{addedProjects: object[], removedProjects: object[],
 *   changedProjects: {name: string, changes: {field: string, baseline: *, head: *}[]}[],
 *   addedEdges: object[], removedEdges: object[]}}
 */
export function computeDiff(baseline, head) {
  const baselineProjects = new Map(baseline.projects.map((p) => [p.name, p]));
  const headProjects = new Map(head.projects.map((p) => [p.name, p]));

  const addedProjects = [];
  const removedProjects = [];
  const changedProjects = [];

  for (const [name, project] of headProjects) {
    if (!baselineProjects.has(name)) {
      addedProjects.push(project);
      continue;
    }
    // Project exists in both — detect metadata changes.
    const baselineProject = baselineProjects.get(name);
    const changes = [];

    // Tags change: array content differs.
    const baselineTags = baselineProject.tags ?? [];
    const headTags = project.tags ?? [];
    if (baselineTags.length !== headTags.length || baselineTags.some((t, i) => t !== headTags[i])) {
      changes.push({ field: "tags", baseline: baselineTags, head: headTags });
    }

    // Type change: one is undefined and the other is not, or both defined but different.
    const baselineType = baselineProject.type ?? undefined;
    const headType = project.type ?? undefined;
    if (baselineType !== headType) {
      changes.push({
        field: "type",
        baseline: baselineType ?? null,
        head: headType ?? null,
      });
    }

    // Root change: project directory moved.
    if (baselineProject.root !== project.root) {
      changes.push({ field: "root", baseline: baselineProject.root, head: project.root });
    }

    if (changes.length > 0) {
      changedProjects.push({ name, changes });
    }
  }
  for (const [name, project] of baselineProjects) {
    if (!headProjects.has(name)) removedProjects.push(project);
  }
  // Deterministic order — plain string comparison.
  addedProjects.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  removedProjects.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  changedProjects.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Index edges by the (source, target, type) triple — the identity key.
  const baselineEdges = new Map(
    baseline.dependencies.map((e) => [`${e.source}\0${e.target}\0${e.type}`, e]),
  );
  const headEdges = new Map(
    head.dependencies.map((e) => [`${e.source}\0${e.target}\0${e.type}`, e]),
  );

  const addedEdges = [];
  const removedEdges = [];

  for (const [key, edge] of headEdges) {
    if (!baselineEdges.has(key)) addedEdges.push(edge);
  }
  for (const [key, edge] of baselineEdges) {
    if (!headEdges.has(key)) removedEdges.push(edge);
  }

  const edgeSort = (a, b) => {
    if (a.source < b.source) return -1;
    if (a.source > b.source) return 1;
    if (a.target < b.target) return -1;
    if (a.target > b.target) return 1;
    if (a.type < b.type) return -1;
    if (a.type > b.type) return 1;
    return 0;
  };
  addedEdges.sort(edgeSort);
  removedEdges.sort(edgeSort);

  return { addedProjects, removedProjects, changedProjects, addedEdges, removedEdges };
}

/**
 * Runs the `diff` command: reads the baseline, resolves the head context,
 * checks refusals, and computes the diff.
 *
 * @param {string} baselinePath Absolute path to the baseline JSON file.
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{readBaseline?: (path: string) => {projects: object[], dependencies: object[], coverage: object, policy?: object|null,
 *   provider?: string|null, provenance?: {commit: string, remote: string|null, dirty: boolean}|null,
 *   toolVersion?: string|null},
 *   config?: object}} [io]
 *   Injectable baseline reader, so a test drives the diff without a real file.
 *   When omitted, reads from the real filesystem. `config` is the loaded
 *   boundary config; when provided, rule-impact analysis is computed alongside
 *   the structural diff.
 * @returns {{status: "ok"|"no-verdict", diff: object, coverage: object,
 *   report: {text: string, json: string}}}
 * @throws {Error} when the baseline cannot be read or is incomplete, when
 *   the head is incomplete, or when an Nx workspace has polyglot manifests
 *   but the plugin is not registered.
 */
export function diffCommand(
  baselinePath,
  commandContext,
  { readBaseline = readBaselineFromDisk, config = null } = {},
) {
  const { root, provider, marker, pluginGap } = commandContext;

  // Descriptive commands refuse when the graph is known to be incomplete.
  if (provider === "nx" && !pluginGap.registered && pluginGap.manifests.length > 0) {
    throw new Error(
      `lattice: refusing to compute a diff for an Nx workspace where this plugin is ` +
        `not registered but polyglot manifests exist under project roots ` +
        `(${pluginGap.manifests.join(", ")}). The head graph would carry no polyglot edges, ` +
        `so the diff would silently under-represent the real architecture. ` +
        `Register the plugin in nx.json: ` +
        `"plugins": [{ "plugin": "@ecoma-io/lattice/nx" }], or remove the polyglot manifests ` +
        `if they are not in use.`,
    );
  }

  // Read and validate the baseline before looking at the head — a bad baseline
  // is a caller error, not a workspace fact, and it should name the file.
  const baseline = readBaseline(baselinePath);

  // Refuse an incomplete head — same reasoning as the incomplete baseline
  // refusal: every "added" or "removed" entry would be ambiguous.
  const notAnalyzed = commandContext.analysis.failures
    .filter(isWholeFileFailure)
    .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));

  if (notAnalyzed.length > 0) {
    throw new Error(
      `lattice: the head graph has incomplete coverage — ${notAnalyzed.length} file` +
        `${notAnalyzed.length === 1 ? "" : "s"} could not be analyzed, so every "added" or ` +
        `"removed" entry in the diff would be ambiguous between a real change and a coverage ` +
        `gap. Fix the unanalyzed files and re-run.`,
    );
  }

  const head = buildHeadSnapshot(commandContext);

  const diff = computeDiff(baseline, head);

  const coverage = {
    complete: true,
    projects: head.projects.length,
    analyzedFiles: commandContext.analysis.analyzed,
    imports: commandContext.analysis.imports.length,
    notAnalyzed: [],
    blindSpots: commandContext.analysis.failures
      .filter((f) => !isWholeFileFailure(f))
      .map(({ sourceFile, line, column, reason }) => ({ file: sourceFile, line, column, reason })),
    notes: [],
  };

  const context = { root, provider, marker, provenance: resolveProvenance(root) };
  const result = {
    baseline: {
      path: baselinePath,
      projects: baseline.projects.length,
      edges: baseline.dependencies.length,
      toolVersion: baseline.toolVersion,
    },
    head: { projects: head.projects.length, edges: head.dependencies.length },
    addedProjects: diff.addedProjects,
    removedProjects: diff.removedProjects,
    changedProjects: diff.changedProjects,
    addedEdges: diff.addedEdges,
    removedEdges: diff.removedEdges,
  };

  // Provider mismatch detection: when the baseline and head come from
  // different providers, structural differences may be provider-artefacts
  // rather than real architectural changes. A provider migration is a
  // legitimate use case, so this is a warning (coverage.note), not a
  // refusal.
  const baselineProvider = baseline.provider;
  if (baselineProvider && baselineProvider !== provider) {
    coverage.notes.push(
      `baseline provider (${baselineProvider}) differs from head provider (${provider}) — ` +
        `structural differences may be provider-artefacts rather than real architectural changes`,
    );
  }

  // Provenance mismatch: when both sides carry provenance with commit hashes,
  // a consumer can verify the baseline came from the same repository (or at
  // least the same commit). When the commits differ but the remote matches,
  // the diff is between two revisions of the same repository (the expected
  // case). When the remotes differ, the diff may be across unrelated
  // repositories — a coverage.note warns the consumer.
  const headProvenance = resolveProvenance(root);
  const baselineProvenance = baseline.provenance;

  if (baselineProvenance && headProvenance) {
    if (
      baselineProvenance.remote &&
      headProvenance.remote &&
      baselineProvenance.remote !== headProvenance.remote
    ) {
      coverage.notes.push(
        `baseline provenance remote (${baselineProvenance.remote}) differs from head provenance remote (${headProvenance.remote}) — ` +
          `the diff may be across unrelated repositories rather than two revisions of the same one`,
      );
    }
  } else if (baselineProvenance && !headProvenance) {
    coverage.notes.push(
      `baseline carries provenance but the head does not — the consumer cannot verify the diff is between revisions of the same repository`,
    );
  } else if (!baselineProvenance && headProvenance) {
    coverage.notes.push(
      `head carries provenance but the baseline does not — the consumer cannot verify the diff is between revisions of the same repository`,
    );
  }

  // Policy mismatch detection: when both the baseline and the head carry a
  // policy fingerprint and they disagree, the diff is computed against a
  // different policy than the one the baseline was judged under. Every
  // "introduced" or "resolved" violation in the rule-impact analysis may be an
  // artefact of the policy change, not of a structural change. Record the
  // mismatch so the consumer knows to interpret the diff with caution.
  const baselineFingerprint = baseline.policy?.fingerprint ?? null;
  const headFingerprint = config ? computePolicyFingerprint(config) : null;
  if (baselineFingerprint && headFingerprint && baselineFingerprint !== headFingerprint) {
    result.policyMismatch = {
      baseline: { fingerprint: baselineFingerprint },
      head: { fingerprint: headFingerprint },
    };
  }

  // One-sided policy warning: when only one side carries a policy fingerprint,
  // rule-impact numbers (if any) are based on an incomplete picture. The
  // consumer should interpret them with caution.
  if ((!baselineFingerprint && headFingerprint) || (baselineFingerprint && !headFingerprint)) {
    const side = baselineFingerprint ? "baseline" : "head";
    coverage.notes.push(
      `policy fingerprint is present only on the ${side} side — ` +
        `rule-impact results may not reflect the policy the other side was judged under`,
    );
  }

  // Rule-impact analysis: when the boundary config is provided, judge each
  // added/removed edge against the constraint table. This is not the full
  // `evaluate` pipeline — it checks only the `depConstraints` violations
  // that depend on project tags (3 of 15 violation types; not npm/circular/
  // lazy-load rules, which need import-site details). A consumer who needs
  // the complete verdict should run `check`.
  if (config && config.depConstraints) {
    const ruleImpact = computeRuleImpact(
      diff,
      commandContext.graph.nodes,
      commandContext.graph.dependencies,
      baseline.projects,
      baseline.dependencies,
      config.depConstraints,
    );
    result.ruleImpact = {
      introduced: ruleImpact.introduced,
      resolved: ruleImpact.resolved,
    };
    // The rule-impact analysis covers depConstraints only (3 of 15 violation
    // types). A consumer seeing no introduced/resolved violations must not
    // conclude the workspace is free of all boundary violations — only that
    // no depConstraints violations were introduced or resolved on the changed
    // edges. Run `check` for the complete verdict.
    coverage.notes.push(
      "per-edge rule-impact covers only depConstraints (3 of 15 violation types). " +
        "A dependency with no rule-impact may still violate npm-ban, circular-dependency, " +
        "lazy-load, or other rules that require import-site details. Run check for the " +
        "complete verdict.",
    );
  }

  // Diff is descriptive — always status "ok" when it completes. Even an
  // architecture with many changes is not a "finding" in the boundary-enforcement
  // sense; only `check` exits 1.
  const status = "ok";
  const exitCode = 0;

  const envelope = jsonEnvelope({
    command: "diff",
    context,
    status,
    exitCode,
    coverage,
    result,
  });

  return {
    status,
    diff: result,
    coverage,
    report: {
      text: formatDiffReport({ diff: result, coverage }),
      json: renderJson(envelope),
    },
  };
}

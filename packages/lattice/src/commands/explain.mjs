/**
 * The `explain` command: the judgment for one import site, explained.
 *
 * `explain` takes a `file:line:column` site, finds the matching import
 * record, and explains the judgment: which constraint row matched, which tags
 * applied, whether it is a violation and why. It is descriptive: it never
 * exits 1, because an explanation of what the rules decided is never a finding
 * (only `check` ever exits 1).
 *
 * What it needs from its caller is a site string, a `CommandContext`, and the
 * loaded boundary config — the preamble every command shares
 * (`./context.mjs`) plus the law the judgment was made under
 * (`../config.mjs`). What it gives back is a `status`, the explanation payload
 * for both the text and the JSON renderers, and enough coverage information to
 * build a correct envelope. It does not print, and it does not decide the
 * process's exit code — `../../cli.mjs` owns those (`./README.md`).
 *
 * ## The unregistered-plugin refusal
 *
 * Same as `graph`: on an Nx workspace whose `nx.json` does not register this
 * plugin but whose tracked files include polyglot manifests under project
 * roots, `explain` refuses loudly rather than explaining a judgment from a
 * graph whose edges silently under-represent the real architecture.
 */
import { isWholeFileFailure } from "../analysis/source-util.mjs";
import { evaluate } from "../rules/index.mjs";
import { findConstraintsFor } from "../rules/tags.mjs";
import { findProjectForPath, createProjectRootMappings } from "../rules/specifiers.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatExplainReport } from "../report/explain-text.mjs";
import { resolveProvenance } from "./provenance.mjs";

/**
 * Parses a `file:line:column` site string into its components.
 *
 * All three parts are required and must be positive integers. The file part
 * may contain any characters except the two colons that delimit the segments.
 *
 * @param {string} site A `file:line:column` string.
 * @returns {{ sourceFile: string, line: number, column: number }}
 * @throws {Error} when the site string is malformed.
 */
export function parseSite(site) {
  const lastColon = site.lastIndexOf(":");
  if (lastColon === -1 || lastColon === 0) {
    throw new Error(`lattice: '${site}' is not a valid site — expected <file>:<line>:<column>`);
  }
  const secondLastColon = site.lastIndexOf(":", lastColon - 1);
  if (secondLastColon === -1) {
    throw new Error(`lattice: '${site}' is not a valid site — expected <file>:<line>:<column>`);
  }
  const sourceFile = site.slice(0, secondLastColon);
  const lineStr = site.slice(secondLastColon + 1, lastColon);
  const columnStr = site.slice(lastColon + 1);

  if (!sourceFile) {
    throw new Error(`lattice: '${site}' is not a valid site — the file part is empty`);
  }

  const line = Number(lineStr);
  const column = Number(columnStr);
  if (!Number.isInteger(line) || line < 1) {
    throw new Error(
      `lattice: '${site}' is not a valid site — line must be a positive integer, got '${lineStr}'`,
    );
  }
  if (!Number.isInteger(column) || column < 1) {
    throw new Error(
      `lattice: '${site}' is not a valid site — column must be a positive integer, got '${columnStr}'`,
    );
  }
  return { sourceFile, line, column };
}

/**
 * Finds the import record matching a parsed site.
 *
 * An import record matches when its `sourceFile`, `line`, and `column` all
 * agree. At most one record should match a given site.
 *
 * @param {{sourceFile: string, line: number, column: number}} parsed
 * @param {object[]} imports The analysis import records.
 * @returns {object|null} The matching record, or `null`.
 */
export function findSite(parsed, imports) {
  return (
    imports.find(
      (site) =>
        site.sourceFile === parsed.sourceFile &&
        site.line === parsed.line &&
        site.column === parsed.column,
    ) ?? null
  );
}

/**
 * Finds the constraint rows that match a source project's tags.
 *
 * This is the "allowed" counterpart to `evaluate`: `evaluate` returns
 * violations, and this returns the constraints that WERE satisfied. A project
 * with no matching constraints would have been reported as
 * `projectWithoutTagsCannotHaveDependencies` by `evaluate`, so reaching this
 * function with no matches means the site was judged before the constraint
 * table was consulted (e.g. it was `allow`ed, or it reached an app).
 *
 * @param {object[]} depConstraints The config's constraint table.
 * @param {object} sourceProjectNode The graph node for the source project.
 * @returns {object[]}
 */
function findMatchingConstraints(depConstraints, sourceProjectNode) {
  return findConstraintsFor(depConstraints, sourceProjectNode);
}

/**
 * Runs the `explain` command: resolves the command context, finds the import
 * site, evaluates the rules, and returns the explanation.
 *
 * @param {string} site A `file:line:column` string.
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {object} config The loaded boundary config (from `loadBoundaryConfig`).
 * @returns {{status: "ok"|"no-verdict", explanation: object, coverage: object,
 *   report: {text: string, json: string}}}
 * @throws {Error} when the plugin is unregistered on a polyglot Nx workspace,
 *   when the site string is malformed, or when the site cannot be found.
 */
export function explainCommand(site, commandContext, config) {
  const { root, provider, marker, graph } = commandContext;

  // Descriptive commands refuse when the graph is known to be incomplete.
  if (
    provider === "nx" &&
    !commandContext.pluginGap.registered &&
    commandContext.pluginGap.manifests.length > 0
  ) {
    throw new Error(
      `lattice: refusing to explain a judgment for an Nx workspace where this plugin is ` +
        `not registered but polyglot manifests exist under project roots ` +
        `(${commandContext.pluginGap.manifests.join(", ")}). The graph would carry no polyglot edges, ` +
        `so the judgment would be against an incomplete graph. ` +
        `Register the plugin in nx.json: ` +
        `"plugins": [{ "plugin": "@ecoma-io/lattice/nx" }], or remove the polyglot manifests ` +
        `if they are not in use.`,
    );
  }

  const parsed = parseSite(site);

  const notAnalyzed = commandContext.analysis.failures
    .filter(isWholeFileFailure)
    .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));

  const complete = notAnalyzed.length === 0;
  const status = complete ? "ok" : "no-verdict";

  // Find the import record at this site.
  const record = findSite(parsed, commandContext.analysis.imports);

  if (record === null) {
    // Check whether the site's file had a whole-file failure.
    const wholeFileFailure = commandContext.analysis.failures.find(
      (f) => isWholeFileFailure(f) && f.sourceFile === parsed.sourceFile,
    );
    if (wholeFileFailure) {
      throw new Error(
        `lattice: ${parsed.sourceFile} could not be analyzed at all ` +
          `(${wholeFileFailure.reason}), so no import site at ` +
          `${parsed.sourceFile}:${parsed.line}:${parsed.column} exists to explain`,
      );
    }

    // Check whether this specific site had a site-level failure.
    const siteFailure = commandContext.analysis.failures.find(
      (f) =>
        !isWholeFileFailure(f) &&
        f.sourceFile === parsed.sourceFile &&
        f.line === parsed.line &&
        f.column === parsed.column,
    );

    if (siteFailure) {
      // Site-level failure: the file was analyzed but this import site is
      // unresolvable. Report it as such — the file was judged, one position
      // in it has no answer.
      const explanation = {
        site: { file: parsed.sourceFile, line: parsed.line, column: parsed.column },
        import: null,
        sourceProject: null,
        targetProject: null,
        sourceTags: [],
        targetTags: [],
        matchedConstraints: [],
        violations: null,
        unresolvable: true,
        reason: siteFailure.reason,
      };

      const context = { root, provider, marker, provenance: resolveProvenance(root) };
      const coverage = {
        complete,
        projects: Object.keys(graph.nodes).length,
        analyzedFiles: commandContext.analysis.analyzed,
        imports: commandContext.analysis.imports.length,
        notAnalyzed,
        blindSpots: commandContext.analysis.failures
          .filter((f) => !isWholeFileFailure(f))
          .map(({ sourceFile, line, column, reason }) => ({
            file: sourceFile,
            line,
            column,
            reason,
          })),
        notes: [],
      };

      const result = {
        site: explanation.site,
        unresolvable: true,
        reason: siteFailure.reason,
      };

      const envelope = jsonEnvelope({
        command: "explain",
        context,
        status,
        exitCode: complete ? 0 : 3,
        coverage,
        result,
      });

      return {
        status,
        explanation,
        coverage,
        report: {
          text: formatExplainReport({ explanation, coverage }),
          json: renderJson(envelope),
        },
      };
    }

    // No record and no failure at this site — the position does not exist.
    throw new Error(
      `lattice: no import site at ${parsed.sourceFile}:${parsed.line}:${parsed.column} — ` +
        `that position does not correspond to any import this tool found. ` +
        `Check the file, line and column; remember that line and column are 1-based.`,
    );
  }

  // Evaluate the rules to find violations for ALL sites, then filter to this
  // one. We run the full evaluation rather than a single-site evaluation
  // because `evaluate` is pure and some rules (circular dependencies, lazy
  // loading) depend on the whole file graph — they cannot be computed on one
  // site in isolation.
  const allViolations = evaluate(commandContext.analysis.imports, graph, config);
  const siteViolations = allViolations.filter(
    (v) =>
      v.sourceFile === parsed.sourceFile && v.line === parsed.line && v.column === parsed.column,
  );

  // Derive source and target projects from the graph.
  // `sourceProject` is NOT on the import record — the analysis contract
  // (`../analysis/contract.md`) keeps no project name on the record. It is
  // derived the same way `evaluate` derives it: by walking up the source
  // file's directory path against the project root mappings. `target` comes
  // from the record's resolved field, which the analysis resolver provides.
  const mappings = createProjectRootMappings(graph.nodes);
  const sourceProjectName = findProjectForPath(record.sourceFile, mappings) ?? null;
  const targetProjectName = record.resolved?.target ?? null;

  const sourceProjectNode = sourceProjectName ? (graph.nodes[sourceProjectName] ?? null) : null;
  const targetProjectNode = targetProjectName ? (graph.nodes[targetProjectName] ?? null) : null;

  const sourceTags = sourceProjectNode ? (sourceProjectNode.data?.tags ?? []) : [];
  const targetTags = targetProjectNode ? (targetProjectNode.data?.tags ?? []) : [];

  // Find which constraint rows match the source project's tags — this is the
  // "allowed" explanation. A project with no matching constraints would have
  // been flagged by `evaluate` as `projectWithoutTagsCannotHaveDependencies`.
  const matchedConstraints = sourceProjectNode
    ? findMatchingConstraints(config.depConstraints, sourceProjectNode)
    : [];

  let violations = null;
  if (siteViolations.length > 0) {
    // A site can produce multiple violations — e.g. `bannedExternalImports`
    // and `noTransitiveDependencies` can fire together. An agent seeing only
    // the first might fix it and be confused when `check` still fails. Return
    // all of them so the consumer sees the complete picture.
    violations = siteViolations.map((v) => ({
      messageId: v.messageId,
      message: v.message,
      constraint: v.constraint,
    }));
  }

  const explanation = {
    site: { file: parsed.sourceFile, line: parsed.line, column: parsed.column },
    import: {
      specifier: record.specifier,
      kind: record.kind,
      sourceProject: sourceProjectName,
      targetProject: targetProjectName,
    },
    sourceProject: sourceProjectName,
    targetProject: targetProjectName,
    sourceTags,
    targetTags,
    matchedConstraints,
    violations,
    unresolvable: false,
    reason: null,
  };

  const context = { root, provider, marker, provenance: resolveProvenance(root) };
  const coverage = {
    complete,
    projects: Object.keys(graph.nodes).length,
    analyzedFiles: commandContext.analysis.analyzed,
    imports: commandContext.analysis.imports.length,
    notAnalyzed,
    blindSpots: commandContext.analysis.failures
      .filter((f) => !isWholeFileFailure(f))
      .map(({ sourceFile, line, column, reason }) => ({ file: sourceFile, line, column, reason })),
    notes: [],
  };

  const result = {
    site: explanation.site,
    import: explanation.import,
    sourceTags,
    targetTags,
    matchedConstraints,
    violations,
  };

  const envelope = jsonEnvelope({
    command: "explain",
    context,
    status,
    exitCode: complete ? 0 : 3,
    coverage,
    result,
  });

  return {
    status,
    explanation,
    coverage,
    report: {
      text: formatExplainReport({ explanation, coverage }),
      json: renderJson(envelope),
    },
  };
}

/**
 * The `explain` command: the judgment for one import site, explained.
 *
 * `explain` takes a `file:line:column` site, finds the matching import
 * record, and explains the judgment: which constraint row matched, which tags
 * applied, whether it is a violation and why. It is descriptive: it never
 * exits 1, because an explanation of what the rules decided is never a finding
 * .
 *
 * What it needs from its caller is a site string, a `CommandContext`, and the
 * loaded boundary config — the preamble every command shares
 * (`./context.mjs`) plus the law the judgment was made under
 * (`../config.mjs`). What it gives back is a `status`, the explanation payload
 * for both the text and the JSON renderers, and enough coverage information to
 * build a correct envelope. It does not print, and it does not decide the
 * process's exit code — `../../cli.mjs` owns those (`./README.md`).
 *
 * ## The site verdict, and the two guaranteed violation keys
 *
 * `result.verdict` names the judgment for the ONE site being explained —
 * `"violation"`, `"clean"`, or `"unknown"` for an unresolvable site. It lives
 * inside `result`, never as an envelope-level `decision`: the envelope's
 * decision block must agree with `status`/`exitCode` (`../report/json.mjs`),
 * and explain is descriptive — a violating site is still exit 0, so a
 * site-level verdict is a different tier of fact from a run-level one.
 *
 * Every violation entry carries two guaranteed keys beside
 * `messageId`/`message`/`constraint`:
 *
 * - `remediation` — the author-declared `remediation` string from the
 *   governing constraint row, verbatim, or `null` when the workspace declared
 *   none. NEVER text this engine composed: Archkeep supplies evidence and the
 *   consumer decides (`../../../../docs/doctrine/architecture-authority.md`).
 * - `allowed` — the governing row's own `onlyDependOnLibsWithTags` list,
 *   verbatim from the law, or `null` when the row states no allowed list
 *   (a `notDependOnLibsWithTags` row, or a check no row drives). A complement
 *   computed from a ban list would be the engine inventing a direction the
 *   law never stated, so `null` plus the `constraint` row itself is the
 *   honest answer there.
 *
 * ## The unregistered-plugin refusal
 *
 * Same as `graph`: on an Nx workspace whose `nx.json` does not register this
 * plugin but whose tracked files include polyglot manifests under project
 * roots, `explain` refuses loudly rather than explaining a judgment from a
 * graph whose edges silently under-represent the real architecture.
 *
 * ## The "why does this constraint exist" chain
 *
 * A constraint row that carries a `decisionRef` claims a governing decision —
 * an ADR record, or a rule/fitness id the law declares. `explain` resolves
 * that claim against the workspace's ADR registry and walks it through the
 * governance graph (`../governance/decision-graph.mjs`), surfacing the
 * decision's status and authority, its rationale/context prose, and its
 * supersession lineage — not just the pointer. It is read-only, exactly like
 * the rest of `explain`: an agent is shown WHY the row exists, never handed
 * the authority to change the decision or the verdict.
 *
 * Resolution never changes the exit code and never invents a fact. A
 * `decisionRef` that resolves to nothing — or a registry that cannot be read
 * at all — renders as UNRESOLVED, the same loud wording `check`/`report`
 * use; a `rule:`/`fitness:`-shaped ref that the law declares renders as
 * exactly that, a fitness rule this law declares. Only an unresolved site or
 * incomplete analysis moves `status`, so an unchanged tree pays no changed
 * exit code. The registry is read lazily, only when a matched row actually
 * carries a `decisionRef` — the common case (no `docs/adr/` adopted yet)
 * pays no extra read.
 *
 * ## The lineage comparison (optional, additive)
 *
 * `explainCommand` accepts an optional `options.baseRegistry` — a base
 * ADR registry state to compare the workspace's current one against. When it
 * is supplied, the resolved-site explanation gains a `decisionChange` field:
 * whether the decision lineage moved between the two states
 * (`detectDecisionChange`, `../governance/decision-lineage.mjs` —
 * DECISION_CHANGE, never DRIFT, and never asserted without both registry
 * states: a one-sided base renders as a "not comparable" note). Without the
 * option — every current caller — the explanation is byte-for-byte what it
 * was: the field, and its rendered lines, exist only when the comparison was
 * requested.
 */
import {
  blindSpotRows,
  isWholeFileFailure,
  unresolvableLiteralCount,
} from "../analysis/source-util.mjs";
import { UsageError } from "../errors.mjs";
import { evaluate } from "../rules/index.mjs";
import { findConstraintsFor } from "../rules/tags.mjs";
import { findProjectForPath, createProjectRootMappings } from "../rules/specifiers.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatExplainReport } from "../report/explain-text.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { readAdrContext } from "./adr.mjs";
import { lineage } from "../governance/decision-graph.mjs";
import { unresolvedDecisionRefNote } from "./provenance-command.mjs";
import { detectDecisionChange } from "../governance/decision-lineage.mjs";
import {
  declaredFitnessNames,
  hasAuthority,
  resolveDecisionRef,
  stripAdrPrefix,
} from "../governance/adr-registry.mjs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Parses a `file:line:column` site string into its components.
 *
 * All three parts are required and must be positive integers. The file part
 * may contain any characters except the two colons that delimit the segments.
 *
 * @param {string} site A `file:line:column` string.
 * @returns {{ sourceFile: string, line: number, column: number }}
 * @throws {UsageError} when the site string is malformed.
 */
export function parseSite(site) {
  const lastColon = site.lastIndexOf(":");
  if (lastColon === -1 || lastColon === 0) {
    throw new UsageError(
      `archkeep: '${site}' is not a valid site — expected <file>:<line>:<column>`,
    );
  }
  const secondLastColon = site.lastIndexOf(":", lastColon - 1);
  if (secondLastColon === -1) {
    throw new UsageError(
      `archkeep: '${site}' is not a valid site — expected <file>:<line>:<column>`,
    );
  }
  const sourceFile = site.slice(0, secondLastColon);
  const lineStr = site.slice(secondLastColon + 1, lastColon);
  const columnStr = site.slice(lastColon + 1);

  if (!sourceFile) {
    throw new UsageError(`archkeep: '${site}' is not a valid site — the file part is empty`);
  }

  const line = Number(lineStr);
  const column = Number(columnStr);
  if (!Number.isInteger(line) || line < 1) {
    throw new UsageError(
      `archkeep: '${site}' is not a valid site — line must be a positive integer, got '${lineStr}'`,
    );
  }
  if (!Number.isInteger(column) || column < 1) {
    throw new UsageError(
      `archkeep: '${site}' is not a valid site — column must be a positive integer, got '${columnStr}'`,
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
 * Resolves the "why does this constraint exist" chain for every distinct
 * `decisionRef` the matched constraint rows carry, in first-sight order.
 *
 * A `decisionRef` names the ADR (or rule/fitness id) that authorizes the row.
 * Resolution is the registry's own (`resolveDecisionRef`); the walk that
 * surfaces status/authority/rationale/context and lineage is the governance
 * graph's (`lineage`). Failures are named, never silent:
 *
 * - a registry that cannot be read resolves nothing — every ref is `unknown`
 *   with the read failure as its reason, the same posture `report` takes for
 *   the same condition;
 * - a ref that resolves to no ADR, rule, or fitness record the registry knows
 *   is `unknown`, with `unresolvedDecisionRefNote`'s shared wording.
 *
 * Deterministic: matched-row order, distinct refs deduplicated on first
 * sight, and the walk's own registry (byte-sorted filename) order. Empty when
 * no matched row carries a `decisionRef` — the caller then changes no byte of
 * its explanation.
 *
 * @param {object[]} matchedConstraints The constraint rows that matched the
 *   explained site.
 * @param {string} root The workspace root, for the registry read.
 * @param {string[]} tracked Tracked files, for the registry read.
 * @param {object} config The loaded boundary config, for the declared-name
 *   half of `resolveDecisionRef`.
 * @returns {object[]} One entry per distinct ref: `resolution` is the
 *   registry's own `"adr" | "fitness" | "unknown"`; an `"adr"` entry carries
 *   the record's authority and prose facts plus the lineage walk.
 */
function resolveDecisionChains(matchedConstraints, root, tracked, config) {
  const refs = [];
  for (const row of matchedConstraints) {
    if (typeof row?.decisionRef !== "string" || row.decisionRef.trim() === "") continue;
    if (!refs.includes(row.decisionRef)) refs.push(row.decisionRef);
  }
  if (refs.length === 0) return [];

  let registry = null;
  let registryReason = null;
  try {
    registry = readAdrContext(root, { tracked });
  } catch (error) {
    registryReason = String(error?.message ?? error);
  }

  const knownFitness = declaredFitnessNames(config);
  return refs.map((ref) => {
    if (registry === null) {
      return {
        ref,
        resolution: "unknown",
        reason: `the decision registry could not be read: ${registryReason}`,
      };
    }
    const resolution = resolveDecisionRef(registry.byId, knownFitness, ref);
    if (resolution === "adr") {
      const record = registry.byId.get(stripAdrPrefix(ref));
      const recordFacts = { id: record.id, status: record.status };
      for (const key of [
        "created",
        "updated",
        "context",
        "decision",
        "rationale",
        "alternatives",
        "consequences",
        "assumptions",
      ]) {
        if (record[key] !== undefined) recordFacts[key] = record[key];
      }
      recordFacts.supersedes = record.supersedes;
      recordFacts.supersededBy = record.supersededBy;
      recordFacts.bindings = record.bindings;
      return {
        ref,
        resolution: "adr",
        authority: hasAuthority(record.status),
        record: recordFacts,
        lineage: lineage(record.id, {
          records: registry.records,
          byId: registry.byId,
          // The lineage walk reads only `records`/`byId`; the graph walk's
          // full shape is supplied so the call satisfies the type rather than
          // leaning on an unchecked subset.
          knownFitness,
          rows: [],
        }),
      };
    }
    if (resolution === "fitness") {
      return { ref, resolution: "fitness" };
    }
    return { ref, resolution: "unknown", reason: unresolvedDecisionRefNote(ref) };
  });
}

/**
 * The lineage-comparison seam: `detectDecisionChange` fed the caller-supplied
 * base registry and the workspace's current registry — the same
 * `readAdrContext` read the decision-chain walk makes, made only when the
 * caller asked for the comparison. A registry that cannot be read resolves
 * nothing and says so (the same fail-closed posture the chain walk takes for
 * the same condition), so a supersession is never asserted from a registry
 * that was never read.
 *
 * @param {{records: object[], byId: Map<string, object>}|null|undefined} baseRegistry
 *   The base state's registry (a `loadAdrRegistry` result), or `null` for a
 *   one-sided base — the comparison then discloses "not comparable" instead
 *   of asserting anything.
 * @param {string} root The workspace root, for the head registry read.
 * @param {string[]} tracked Tracked files, for the head registry read.
 * @returns {{superseded: boolean, comparable: boolean, notes: string[]}}
 */
function computeDecisionChange(baseRegistry, root, tracked) {
  let headRegistry;
  try {
    headRegistry = readAdrContext(root, { tracked });
  } catch (error) {
    return {
      superseded: false,
      comparable: false,
      notes: [`the decision registry could not be read: ${String(error?.message ?? error)}`],
    };
  }
  return detectDecisionChange(baseRegistry, headRegistry);
}

/**
 * Runs the `explain` command: resolves the command context, finds the import
 * site, evaluates the rules, and returns the explanation.
 *
 * @param {string} site A `file:line:column` string.
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {object} config The loaded boundary config (from `loadBoundaryConfig`).
 * @param {object} [options]
 * @param {{records: object[], byId: Map<string, object>}|null|undefined} [options.baseRegistry]
 *   The ADR registry at the comparison base (a `loadAdrRegistry` result), or
 *   `null` for a one-sided base. Supplied, the resolved-site explanation
 *   also carries a `decisionChange` field — whether the decision lineage
 *   moved between base and head (the workspace's current registry):
 *   DECISION_CHANGE, never DRIFT, and never asserted without both registry
 *   states (one-sided ⇒ a "not comparable" note, `detectDecisionChange`'s
 *   own contract). Absent — every current caller — the explanation changes
 *   no byte.
 * @returns {{status: "ok"|"no-verdict", explanation: object, coverage: object,
 *   report: {text: string, json: string}}}
 * @throws {Error} when the plugin is unregistered on a polyglot Nx workspace,
 *   when the site string is malformed, or when the site cannot be found.
 */
export function explainCommand(site, commandContext, config, options = {}) {
  const { root, provider, marker, graph } = commandContext;

  // Descriptive commands refuse when the graph is known to be incomplete.
  if (
    provider === "nx" &&
    !commandContext.pluginGap.registered &&
    commandContext.pluginGap.manifests.length > 0
  ) {
    throw new Error(
      `archkeep: refusing to explain a judgment for an Nx workspace where this plugin is ` +
        `not registered but polyglot manifests exist under project roots ` +
        `(${commandContext.pluginGap.manifests.join(", ")}). The graph would carry no polyglot edges, ` +
        `so the judgment would be against an incomplete graph. ` +
        `Register the plugin in nx.json: ` +
        `"plugins": [{ "plugin": "@ecoma-io/archkeep/nx" }], or remove the polyglot manifests ` +
        `if they are not in use.`,
    );
  }

  const parsed = parseSite(site);

  // Normalize the site's sourceFile to a workspace-relative path so it
  // matches the analysis record's sourceFile field (contract.md: workspace-relative).
  // Handles: absolute paths, cwd-relative paths, and backslash separators.
  const rawFile = parsed.sourceFile;
  const normalizedFile = isAbsolute(rawFile)
    ? relative(root, rawFile)
    : relative(root, resolve(root, rawFile));
  // Normalize backslash separators (Windows paths) to forward slashes.
  parsed.sourceFile = sep === "\\" ? normalizedFile.replaceAll("\\", "/") : normalizedFile;

  const notAnalyzed = commandContext.analysis.failures
    .filter(isWholeFileFailure)
    .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));

  // An unresolvable site was seen but never judged (#595): the graph is
  // missing whatever edge that site would have drawn, and rules that judge
  // the whole graph (circularity, lazy loading) would answer over a gap. The
  // explanation still reports — status no-verdict — naming the site in
  // `coverage.blindSpots`, the same contract `graph`/`discover` run.
  const blindSpotCount = unresolvableLiteralCount(commandContext.analysis.failures);
  const complete = notAnalyzed.length === 0 && blindSpotCount === 0;
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
        `archkeep: ${parsed.sourceFile} could not be analyzed at all ` +
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
        verdict: "unknown",
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
        blindSpots: blindSpotRows(commandContext.analysis.failures),
        notes: [],
      };

      const result = {
        site: explanation.site,
        verdict: "unknown",
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
      `archkeep: no import site at ${parsed.sourceFile}:${parsed.line}:${parsed.column} — ` +
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
    //
    // `remediation` and `allowed` are guaranteed keys (this file's header):
    // both are read verbatim off the governing constraint row, and both are
    // an explicit `null` — never absent — when the row does not state them,
    // so a consumer can tell "no declared remediation" from a field that
    // does not exist yet.
    violations = siteViolations.map((v) => ({
      messageId: v.messageId,
      message: v.message,
      constraint: v.constraint,
      remediation: typeof v.constraint?.remediation === "string" ? v.constraint.remediation : null,
      allowed: Array.isArray(v.constraint?.onlyDependOnLibsWithTags)
        ? v.constraint.onlyDependOnLibsWithTags
        : null,
    }));
  }

  const verdict = violations === null ? "clean" : "violation";

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
    verdict,
    unresolvable: false,
    reason: null,
  };
  // The "why does this constraint exist" chain — the governing decision(s)
  // behind the rows that matched this site, resolved through the ADR registry
  // and walked through the governance graph (`resolveDecisionChains`'s own
  // header argues the fail-closed wording and the determinism). Additive: an
  // explanation whose rows carry no `decisionRef` keeps every byte it had.
  const decisions = resolveDecisionChains(matchedConstraints, root, commandContext.tracked, config);
  if (decisions.length > 0) {
    explanation.decisions = decisions;
  }

  // The lineage-comparison seam (Wave 3 §9): when the caller supplies a base
  // registry, the resolved-site explanation also states whether the decision
  // lineage moved between base and head — DECISION_CHANGE, never DRIFT, and
  // never asserted without both registry states (a one-sided base ⇒ a
  // "not comparable" note, `detectDecisionChange`'s own contract). Absent
  // the option — every current caller — the explanation changes no byte:
  // the field and its rendered lines exist only when the comparison was
  // requested, and an unresolvable site (above) stays what it was.
  let decisionChange = null;
  if (options.baseRegistry !== undefined) {
    decisionChange = computeDecisionChange(options.baseRegistry, root, commandContext.tracked);
    explanation.decisionChange = decisionChange;
  }

  const context = { root, provider, marker, provenance: resolveProvenance(root) };
  const coverage = {
    complete,
    projects: Object.keys(graph.nodes).length,
    analyzedFiles: commandContext.analysis.analyzed,
    imports: commandContext.analysis.imports.length,
    notAnalyzed,
    blindSpots: blindSpotRows(commandContext.analysis.failures),
    notes: [],
  };

  const result = {
    site: explanation.site,
    import: explanation.import,
    sourceTags,
    targetTags,
    matchedConstraints,
    violations,
    verdict,
    ...(decisions.length > 0 ? { decisions } : {}),
    ...(decisionChange !== null ? { decisionChange } : {}),
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

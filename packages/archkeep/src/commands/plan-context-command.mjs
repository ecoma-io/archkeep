/**
 * The agent architecture planning context: the deterministic facts an agent
 * needs before it reasons about, plans, and executes a change in a
 * Archkeep-governed workspace.
 *
 * ## The boundary this module holds
 *
 * Archkeep produces deterministic architecture facts and constraints; an agent
 * produces reasoning, planning and code. This module never generates a plan,
 * never decides an implementation strategy, never modifies source code, and
 * never weakens architecture policy. Every field it emits is a fact the tree
 * or the boundary law states; the sections that cannot state a fact say so
 * (`null`, `[]`, or an explicit `no-verdict`), which is the empty-result
 * invariant (`../../../../AGENTS.md`) applied to a planning document.
 *
 * ## What it reports
 *
 * Scoped to a requested change (the target project plus optional paths), each
 * section is deterministic and independently verifiable:
 *
 * - **Current architecture** — the graph snapshot (`buildProjects`/
 *   `buildDependencies`) and which projects the change touches.
 * - **Applicable policy / Intent** — the constraint rows that govern the
 *   target project, each carrying its authored description and remediation
 *   (the workspace's "Intent"), plus the policy fingerprint for future diffs.
 * - **Impact** — every project that depends on the target project, separated
 *   direct/transitive, capped with an explicit overflow note.
 * - **Current violations** — the real rule engine verdict (`evaluate`) over
 *   the WHOLE analyzeable tree, scoped for reporting. This is what makes
 *   circular-dependency and lazy-load rules correct on every provider.
 * - **Drift** — go.work and tsconfig-path boundary drift, sourced from the
 *   same `compareGoWork`/`judgeTsconfigPaths` functions `check` uses.
 * - **Intent** — the canonical Architecture Intent verdict (`driftForCheck`,
 *   the object `drift` and `check` share), absent when the workspace declares
 *   no `architecture-intent.json`, no-verdict when one cannot be established.
 * - **Fitness** — the declared fitness functions that govern this workspace,
 *   with per-function verdicts (pass/fail/no-verdict) or a note that no
 *   fitness gates are declared.
 * - **Waivers** — active boundary waivers, each with its remaining term and
 *   how many violations it currently covers, plus permanent suppressions.
 * - **Decisions / ADRs in scope** — the decision lineage: which ADR, rule, or
 *   fitness record authorises each matched constraint row, resolved where
 *   possible and listed with their context.
 * - **Debt** — the architecture-debt snapshot for the target project (when a
 *   history directory is available): current violations, exemptions, and gaps,
 *   aged across the snapshot history.
 * - **Coverage / limitations** — complete vs no-verdict, with the exact files
 *   that could not be analyzed.
 * - **Verification commands** — the deterministic commands an agent runs after
 *   making the change.
 *
 * ## Why whole-tree for the rule verdict
 *
 * `evaluate(importSites, graph, config)` judges only the sites it is given,
 * and circular-dependency/lazy-load rules need the whole file index. Native
 * providers already analyze the whole tree (`src/commands/context.mjs`); Nx
 * and Moon scope before analyzing. For the planning context the rule verdict
 * must be over the whole analyzeable tree so that a plan scoped to one
 * project still reports a cycle that closes through another — the same fact a
 * full `check` would state. Violations are then filtered to the scoped
 * reporting set. This makes the plan's verdict correct on every provider.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

import { INTENT_FILE, loadIntent } from "../architecture-intent/model.mjs";
import { isWholeFileFailure } from "../analysis/source-util.mjs";
import { tsconfigPathsFacts } from "../analysis/typescript.mjs";
import { compareGoWork, parseGoWorkUse } from "../go-work.mjs";
import { judgeTsconfigPaths } from "../tsconfig-paths.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { evaluate } from "../rules/index.mjs";
import { analyzeWorkspace } from "../workspace.mjs";
import { driftForCheck } from "./drift.mjs";
import { computeImpact } from "./impact.mjs";
import { collectProjectContext } from "./context-command.mjs";
import { buildDependencies, buildProjects, computePolicyFingerprint } from "./graph.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { readAdrContext } from "./adr.mjs";
import { declaresFitness, fitnessForCheck } from "./fitness.mjs";
import { computeWaivers } from "./waivers.mjs";
import { declaredFitnessNames, unresolvedDecisionRefRows } from "../governance/adr-registry.mjs";
import { formatPlanContextReport } from "../report/plan-context-text.mjs";

/** How many dependents are listed before an explicit overflow note. */
export const DEPENDENT_CAP = 10;

/**
 * The projects a change touches: the target project, plus every project whose
 * files lie inside one of the given paths. A path pointing at a project root
 * resolves to that project; a path into a shared directory resolves to every
 * project owning a file there.
 *
 * @param {object} commandContext The `CommandContext` from `resolveCommandContext`.
 * @param {string[]} paths Optional workspace-relative paths the change touches.
 * @returns {string[]} Distinct affected project names, sorted.
 */
export function collectAffectedProjects(commandContext, paths) {
  const affected = new Set();
  for (const { file, project } of commandContext.owned ?? []) {
    for (const p of paths) {
      if (file === p || file.startsWith(`${p}/`)) {
        affected.add(project);
        break;
      }
    }
  }
  return [...affected].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The union of `computeImpact` over every project the change touches — the
 * complete blast radius, not just the single named project's. Dependents are
 * capped so a change at the bottom of a large graph does not produce an
 * unbounded document.
 *
 * @param {string} projectName The target project being changed.
 * @param {string[]} affected Every project the change touches.
 * @param {object} graph The project graph.
 * @returns {object[]}
 */
export function collectImpact(projectName, affected, graph) {
  const targets = [...new Set([projectName, ...affected])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return targets.map((target) => {
    const impact = computeImpact(target, graph);
    const capped = impact.dependents.slice(0, DEPENDENT_CAP);
    return {
      project: target,
      direct: impact.direct.slice(0, DEPENDENT_CAP),
      transitive: impact.transitive.slice(0, DEPENDENT_CAP),
      dependents: capped,
      dependentsTotal: impact.dependents.length,
      hasMore: impact.dependents.length > capped.length,
    };
  });
}

/**
 * The scope a path-scoped change is judged against: the set of project-owned
 * files whose project the change touches, or `null` for "no scope given" (the
 * whole workspace). `null` differs from `[]` on purpose — an empty scope is
 * indistinguishable from a path that matched no project, which is itself a
 * claim about the workspace the agent should see.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {string[]} affected Every project the change touches.
 * @returns {Set<string>|null}
 */
function scopedFiles(commandContext, affected) {
  if (affected.length === 0) return null;
  const files = new Set();
  for (const { file, project } of commandContext.owned ?? []) {
    if (affected.includes(project)) files.add(file);
  }
  return files;
}

/**
 * Whole-workspace drift: the same two checks `check` runs, sourced from the
 * same functions, keyed off each manifest's presence the same way. An absent
 * `go.work` or absent `paths` table is `null` — not judged, never "no drift" —
 * and a manifest that cannot be read is a whole-file failure that puts the run
 * in the 3-class (`no-verdict`), exactly as it does for `check`.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @returns {{goWork: object|null, tsconfigPaths: object|null, failures: object[]}}
 */
export function collectDrift(commandContext) {
  const { root, tracked, workspace } = commandContext;
  const failures = [];

  let goWork = null;
  if (tracked.includes("go.work")) {
    try {
      const goWorkText = workspace.readFile("go.work");
      if (goWorkText === null) throw new Error("go.work could not be read");
      goWork = compareGoWork({
        uses: parseGoWorkUse(goWorkText),
        workspaceRoot: root,
        projects: workspace.projects,
        files: tracked,
      });
    } catch (cause) {
      failures.push({
        sourceFile: "go.work",
        line: null,
        column: null,
        reason:
          `${cause?.message ?? cause} — a go.work this tool cannot read is a coverage hole, ` +
          `not an empty use list, so the drift check reached no verdict`,
      });
    }
  }

  let tsconfigPaths = null;
  const facts = tsconfigPathsFacts(workspace);
  if (facts.configFailure !== null) {
    failures.push({
      sourceFile: facts.tsConfig,
      line: null,
      column: null,
      reason:
        `${facts.configFailure} — and the paths hygiene check reached no verdict, because a ` +
        `tsconfig this tool cannot load is a coverage hole, not an empty alias table`,
    });
  } else if (facts.paths !== undefined) {
    tsconfigPaths = judgeTsconfigPaths({
      paths: facts.paths,
      base: facts.base,
      workspaceRoot: root,
      tsConfig: facts.tsConfig,
      directoryExists: (dir) => {
        try {
          return statSync(join(root, dir)).isDirectory();
        } catch {
          return false;
        }
      },
    });
    for (const { reason } of tsconfigPaths.malformed) {
      failures.push({ sourceFile: facts.tsConfig, line: null, column: null, reason });
    }
  }

  return { goWork, tsconfigPaths, failures };
}

/**
 * Compiles the planning context for a change to `projectName`, scoped to
 * `paths`, returning a `{status, coverage, result, report}` contract ready for
 * `cli.mjs` to render — the same shape `contextCommand` returns.
 *
 * The rule verdict is over the WHOLE analyzeable tree so whole-graph rules
 * (circular, lazy-load, transitive tag rules) are correct on every provider;
 * only reporting is scoped. Coverage is therefore computed over that whole
 * tree, so `complete` is honest: it is true exactly when no analyzeable file
 * in the workspace failed.
 *
 * @param {string} projectName The target project being changed.
 * @param {string[]} paths Optional workspace-relative paths the change touches.
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {object} config The loaded boundary config.
 * @returns {Promise<{status: "ok"|"no-verdict", exitCode: number, coverage: object,
 *   result: object, report: {text: string, json: string}}>}
 */
export async function planContextCommand(projectName, paths, commandContext, config) {
  const { root, provider, marker, graph, workspace, pluginGap, tracked } = commandContext;

  // The same refusal every descriptive command carries: on an Nx workspace
  // whose plugin is unregistered but whose tracked files include polyglot
  // manifests under project roots, the graph carries no polyglot edges, so the
  // architecture facts and the rule verdict would silently under-represent the
  // real architecture.
  if (provider === "nx" && !pluginGap.registered && pluginGap.manifests.length > 0) {
    throw new Error(
      `archkeep: refusing to build a planning context for an Nx workspace where this plugin is ` +
        `not registered but polyglot manifests exist under project roots ` +
        `(${pluginGap.manifests.join(", ")}). The graph would carry no polyglot edges, ` +
        `so the architecture facts shown would be against an incomplete graph. ` +
        `Register the plugin in nx.json: ` +
        `"plugins": [{ "plugin": "@ecoma-io/archkeep/nx" }], or remove the polyglot manifests ` +
        `if they are not in use.`,
    );
  }

  // The target project's tags, constraints and per-edge verdicts — the same
  // architecture context the ordinary `context` command reports, carried here
  // so the plan and the plain command cannot disagree about what the policy
  // says. `collectProjectContext` throws for a project absent from the graph,
  // which is the caller-error path `cli.mjs` maps to usage.
  const projectContext = collectProjectContext(projectName, graph, config);

  // A matched constraint row's `decisionRef` names the ADR (or rule/fitness
  // id) that supposedly authorizes it — the same gap the plain `context`
  // command closes for the identical rows, through the identical
  // `readAdrContext`/`unresolvedDecisionRefRows`
  // (`../governance/adr-registry.mjs`). The plan and the plain command must
  // not disagree about which citations resolve any more than they disagree
  // about the constraint rows themselves.
  const planDecisionRefRows = projectContext.constraints
    .map((row, index) => ({ kind: `constraints[${index}]`, row }))
    .filter(({ row }) => typeof row?.decisionRef === "string" && row.decisionRef.trim() !== "");
  let adrContext = null;
  let unresolvedDecisionRefs = new Set();
  if (planDecisionRefRows.length > 0) {
    adrContext = readAdrContext(root, { tracked });
    unresolvedDecisionRefs = new Set(
      // F04: the fitness half resolves against the ids THIS policy declares
      // (`declaredFitnessNames(config)`), never the ADRs' own `bindings`.
      unresolvedDecisionRefRows(
        planDecisionRefRows,
        adrContext.byId,
        declaredFitnessNames(config),
      ).map((row) => row.decisionRef),
    );
  }

  // Whole-tree analysis: the same import set `check` would judge, so the rule
  // verdict below is the full-workspace verdict regardless of provider.
  const wholeTree = analyzeWorkspace(
    workspace,
    (commandContext.owned ?? []).map(({ file }) => file),
  );
  const wholeVerdict = evaluate(wholeTree.imports, graph, config);

  // The change's own scoped failures plus the drift check's failures are what
  // decide coverage: every whole-file failure puts the run in the 3-class.
  const drift = collectDrift(commandContext);
  // The canonical Intent verdict, folded the way `check`'s does —
  // `driftForCheck` is what `drift` and `check` share, and the plan's Intent
  // section must not disagree with either. Absent when the workspace chose not
  // to make an intent (a workspace decision, not a finding); a deviant or
  // unreadable intent is a no-verdict exactly as it is for `check`, and rides
  // `intent`'s own no-verdict lane, never the file-coverage hole list.
  let intent = null;
  if (tracked.includes(INTENT_FILE)) {
    try {
      const intentDrift = await driftForCheck(commandContext, {
        loadIntentOverride: (root) => loadIntent(root, { tracked }),
      });
      intent = {
        verdict:
          intentDrift.findings.length > 0
            ? "findings"
            : intentDrift.unresolved.length > 0
              ? "no-verdict"
              : "ok",
        rows: intentDrift.intent.rows,
        boundaries: intentDrift.boundaries,
        findings: intentDrift.findings,
        unresolved: intentDrift.unresolved,
        notes: intentDrift.notes,
      };
    } catch (cause) {
      const reason =
        `${cause?.message ?? cause} — architecture-intent.json could not be ` +
        `established, so the intent check reached no verdict`;
      intent = {
        verdict: "no-verdict",
        rows: 0,
        findings: [],
        unresolved: [{ boundary: INTENT_FILE, issue: reason }],
        boundaries: [],
        notes: [],
      };
    }
  }

  // Fitness: the declared fitness functions that govern this workspace.
  // Composed from `fitnessForCheck` (not re-implemented) — the same verdict
  // `fitness` and `check` share. When the policy declares no fitness
  // functions, state so honestly rather than omitting the section.
  let fitness = null;
  if (declaresFitness(config)) {
    try {
      const fitnessResult = fitnessForCheck(commandContext, {
        rows: config.fitness,
        intent: intent ?? null,
        suppressions: config.suppressions ?? [],
        scoped: false,
      });
      fitness = {
        verified: true,
        decisions: fitnessResult.decisions,
        overall: fitnessResult.overall,
      };
    } catch (cause) {
      fitness = {
        verified: false,
        decisions: [],
        overall: { verdict: "no-verdict" },
        error: `${cause?.message ?? cause}`,
      };
    }
  }

  // Waivers: active boundary waivers from the policy's suppressions table.
  // Composed from `computeWaivers` — the same function `waivers` and `check`
  // use. When no suppressions are declared, the section states "none" rather
  // than omitting the key (the plan contract: every dimension present).
  const suppressions = config.suppressions ?? [];
  const waiversResult = suppressions.length > 0 ? computeWaivers(suppressions, wholeVerdict) : null;
  const waivers =
    waiversResult === null
      ? {
          declared: false,
          waivers: [],
          covered: 0,
          expired: 0,
          stale: 0,
          permanentSuppressions: [],
        }
      : {
          declared: true,
          waivers: waiversResult.waivers,
          covered: waiversResult.covered,
          expired: waiversResult.expired,
          stale: waiversResult.stale,
          permanentSuppressions: waiversResult.permanentSuppressions,
        };

  // Decisions / ADRs in scope: the positive lineage — which ADRs, rules, or
  // fitness IDs each matched constraint row cites and successfully resolves
  // against. The negative case (unresolved refs) already exists above as
  // `unresolvedDecisionRefs`; this is the resolved half.
  const decisions = [];
  if (planDecisionRefRows.length > 0 && adrContext !== null) {
    for (const { kind, row } of planDecisionRefRows) {
      const ref = row.decisionRef.trim();
      if (!unresolvedDecisionRefs.has(ref)) {
        const record = adrContext.byId.get(ref);
        decisions.push({
          decisionRef: ref,
          kind,
          resolved: true,
          record: record
            ? {
                id: record.id,
                title: record.title,
                status: record.status,
                ...(record.context ? { context: record.context } : {}),
              }
            : null,
        });
      }
    }
  }
  decisions.sort((a, b) =>
    a.decisionRef < b.decisionRef ? -1 : a.decisionRef > b.decisionRef ? 1 : 0,
  );
  const failures = [...wholeTree.failures, ...drift.failures];
  const notAnalyzed = failures
    .filter(isWholeFileFailure)
    .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));

  const affected = collectAffectedProjects(commandContext, paths);
  const scope = scopedFiles(commandContext, affected);
  const violations = wholeVerdict
    .filter((violation) => scope === null || scope.has(violation.sourceFile))
    // Deterministic order — `evaluate` returns sites in analysis order, which is
    // stable for an unchanged tree, but the plan contract runs across providers
    // and providers scope analysis differently; sort by the fields a reader acts
    // on so two runs over unchanged bytes match byte-for-byte (`AGENTS.md`).
    .sort(
      (a, b) =>
        (a.sourceFile < b.sourceFile ? -1 : a.sourceFile > b.sourceFile ? 1 : 0) ||
        a.line - b.line ||
        a.column - b.column ||
        (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0),
    );

  const complete = notAnalyzed.length === 0;
  const status = complete ? "ok" : "no-verdict";
  const exitCode = complete ? 0 : 3;

  const notes = [
    "violations are the full-workspace rule-engine verdict (`evaluate` over the whole " +
      "analyzeable tree), scoped for reporting to the projects this change touches — " +
      "identical to the verdict a full `check` would state.",
    "drift is keyed off manifest presence: an absent go.work or absent paths table is " +
      "null (not judged), never 'no drift'.",
    "dependents are capped at 10 per project with dependentsTotal/hasMore for the rest.",
  ];
  // A path that matched no project's files is distinct from "no scope given":
  // the agent asked to narrow and got nothing, which either way means the whole
  // workspace is the verdict's scope. Say so rather than silently broadening.
  if (paths.length > 0 && affected.length === 0) {
    notes.push(
      `no path matched a project-owned file (given: ${paths.join(", ")}), so the scope fell ` +
        `back to the whole workspace — re-check the path spellings against 'archkeep graph'.`,
    );
  }

  const coverage = {
    complete,
    projects: Object.keys(graph.nodes).length,
    analyzedFiles: wholeTree.analyzed,
    imports: wholeTree.imports.length,
    notAnalyzed,
    blindSpots: failures
      .filter((failure) => !isWholeFileFailure(failure))
      .map(({ sourceFile, line, column, reason }) => ({ file: sourceFile, line, column, reason })),
    // Intent's own coverage notes ride the same seam `check` threads them on
    // (today only an `"optional": true` allowed row whose statement is absent),
    // so the plan's text and JSON reports read the same notes `check` does.
    notes: [...notes, ...(intent === null ? [] : intent.notes)],
  };

  const result = {
    // The plain `context` command's fields, held at the same top-level paths so
    // the plan's envelope is additive — a consumer that already parses `context`
    // reads exactly what it read before, plus the plan's own sections under
    // `result.plan`. No field is removed or moved.
    project: projectContext.project,
    tags: projectContext.tags,
    constraints: projectContext.constraints,
    dependencies: projectContext.dependencies,
    // Additive and optional, the same bargain the plain `context` command's
    // field of the same name states: absent when every matched row's
    // decisionRef resolves (or none carries one).
    ...(unresolvedDecisionRefs.size > 0
      ? {
          unresolvedDecisionRefs: [...unresolvedDecisionRefs].sort((a, b) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        }
      : {}),
    // The planning context's own sections, nested so the plain `context` fields
    // above stay intact — a consumer that already parses `context` reads exactly
    // what it read before, plus the plan.
    plan: {
      // What this payload is, so a consumer reading the `context` command's JSON
      // envelope can distinguish the planning context from the plain context
      // without guessing from field presence.
      variant: "plan",
      // A fingerprint of the boundary policy, so a later run over the same tree
      // can tell whether the rule table changed between runs.
      policyFingerprint: computePolicyFingerprint(config),
      // Current architecture.
      architecture: {
        projects: buildProjects(graph.nodes),
        dependencies: buildDependencies(graph.dependencies),
        targets: affected,
      },
      // Impact (capped).
      impact: collectImpact(projectName, affected, graph),
      // Current violations (scoped reporting, whole-tree verdict).
      violations,
      // Drift.
      drift: {
        goWork: goWorkResult(drift.goWork),
        tsconfigPaths: tsconfigPathsResult(drift.tsconfigPaths),
      },
      // Fitness: the declared fitness functions that govern this workspace.
      // Present only when the policy declares fitness functions (matching
      // the pattern: absent when the workspace chose not to declare any).
      ...(fitness === null ? {} : { fitness }),
      // Waivers: active boundary waivers and permanent suppressions.
      // Always present — when no suppressions are declared, `declared: false`
      // distinguishes "no waivers to show" from "waivers exist but none match".
      waivers,
      // Decisions / ADRs in scope: the resolved decision lineage — which
      // ADRs, rules, or fitness IDs authorise each matched constraint row.
      // Present only when at least one decision ref resolves; absent when
      // no constraint row carries a decisionRef or none resolve.
      ...(decisions.length > 0 ? { decisions } : {}),
      // The canonical Architecture Intent verdict — the same fold `check` and
      // `drift` report. Absent (key omitted) when no intent file is tracked,
      // matching `check`: intent absence is a workspace decision about
      // governance, never a claim of zero findings.
      ...(intent === null
        ? {}
        : {
            intent: {
              verified: true,
              file: INTENT_FILE,
              verdict: intent.verdict,
              rows: intent.rows,
              findings: intent.findings,
              unresolved: intent.unresolved,
              boundaries: intent.boundaries,
              notes: intent.notes,
            },
          }),
      // The deterministic commands an agent runs after making the change.
      verify: [
        `archkeep check --format json`,
        `archkeep impact ${projectName} --format json`,
        `archkeep graph --format json`,
      ],
      provenance: resolveProvenance(root),
    },
  };

  const envelope = jsonEnvelope({
    command: "context",
    context: { root, provider, marker, provenance: resolveProvenance(root) },
    status,
    exitCode,
    coverage,
    result,
  });

  return {
    status,
    exitCode,
    coverage,
    result,
    report: {
      text: formatPlanContextReport({ project: result, coverage, unresolvedDecisionRefs }),
      json: renderJson(envelope),
    },
  };
}

/** The drift section, spelled the way `check` spells it, plus `null` for absent. */
function goWorkResult(goWork) {
  return goWork === null ? null : { checked: true, findings: goWork.findings };
}

/** The drift section, spelled the way `check` spells it, plus `null` for absent. */
function tsconfigPathsResult(tsconfigPaths) {
  return tsconfigPaths === null ? null : { checked: true, findings: tsconfigPaths.findings };
}

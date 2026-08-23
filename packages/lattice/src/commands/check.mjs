/**
 * The `check` command: every import site judged against the boundary rules,
 * folded together with every other finding class one verdict counts.
 *
 * `../../cli.mjs`'s `runCheck` owns argv, the output destination and the
 * process's exit code; this module owns the computation and hands back the
 * report and the counts — `./README.md`'s rule applied to the one command
 * that predates it. `../../cli.mjs` re-exports `check` under its own name, so
 * every importer that already reads it from there keeps working.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import { fileFailure, isWholeFileFailure } from "../analysis/source-util.mjs";
import { tsconfigPathsFacts } from "../analysis/typescript.mjs";
import { suppressionCovers } from "../config.mjs";
import { referenceTime } from "../governance/clock.mjs";
import { suppressionFate } from "../governance/waiver.mjs";
import { resolveCommandContext, unownedGapWithoutRunConfiguration } from "./context.mjs";
import { readAdrContext } from "./adr.mjs";
import { declaredFitnessNames, unresolvedDecisionRefRows } from "../governance/adr-registry.mjs";
import { declaredEdgeViolationsForCheck } from "./edge-constraints.mjs";
import { customRulesForCheck, declaresCustomRules } from "./custom-rules.mjs";
import { driftForCheck } from "./drift.mjs";
import { fitnessForCheck } from "./fitness.mjs";
import { computePolicyFingerprint } from "./graph.mjs";
import { resolvePolicy } from "./policy.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { INTENT_FILE, loadIntent } from "../architecture-intent/model.mjs";
import { compareGoWork, parseGoWorkUse } from "../go-work.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatSarif } from "../report/sarif.mjs";
import { formatReport } from "../report/text.mjs";
import { LATTICE_MODEL_FILE } from "../providers/native/model.mjs";
import { evaluateRun, exemptResolvedFile } from "../rules/index.mjs";
import { orphanedNotDependOnTags, unmatchedConstraintRows } from "../rules/tags.mjs";
import { judgeTsconfigPaths } from "../tsconfig-paths.mjs";
import { verdictFor } from "../verdict.mjs";
import { listTrackedFiles } from "../workspace.mjs";

/**
 * A total order over violations, so a report's byte sequence is an invariant
 * rather than an accident of git's index order.
 *
 * `listTrackedFiles` returns `git ls-files` output verbatim, and the analysis
 * and rule layers preserve exactly that order through `evaluate()` — which
 * makes byte-identity hold today only because git's index happens to sort
 * paths. A filesystem or git version that stopped guaranteeing that order
 * would silently reorder every report while the determinism contract
 * (`docs/reference/json-output.md`) still claimed byte-identity. Sorting here —
 * at the boundary between the engine and its reports — makes `(sourceFile,
 * line, column, messageId)` the one place a reorder could come from, and
 * plain `<` comparison means the ordering never varies with the invoking
 * environment's collation (`../../../../AGENTS.md`, the localeCompare invariant).
 *
 * @param {object[]} violations `Violation` records from `../rules/`.
 * @returns {object[]} A new array, sorted; the input is not mutated.
 */
export function sortViolations(violations) {
  return [...violations].sort((a, b) => {
    if (a.sourceFile !== b.sourceFile) return a.sourceFile < b.sourceFile ? -1 : 1;
    if (a.line !== b.line) return a.line < b.line ? -1 : 1;
    if (a.column !== b.column) return a.column < b.column ? -1 : 1;
    if (a.messageId !== b.messageId) return a.messageId < b.messageId ? -1 : 1;
    return 0;
  });
}
/** Renderers for the two formats whose output is a report, not an envelope. */
const FORMATS = Object.freeze({ text: formatReport, sarif: formatSarif });
/**
 * The per-project file each provider declares an edge in, and the field it
 * spells the declaration with — the two facts a declared-edge finding needs to
 * point somewhere real despite having no import site.
 *
 * One table rather than two lookups, because the file and the field are the
 * same provider's vocabulary and a run that got one from Moon and the other
 * from Nx would render a `moon.yml` blamed for an `implicitDependencies` it
 * has no field for.
 *
 * - **Nx** declares it per-project, in that project's own `project.json`,
 *   under `implicitDependencies`.
 * - **Moon** declares it per-project too, in that project's own `moon.yml`,
 *   under `dependsOn`. Moon calls such a dependency `explicit` — its own
 *   inverse of this package's word — and `../providers/moon.mjs`'s
 *   `edgeTypeFromScope` is where the two vocabularies are mapped onto each
 *   other; `docs/integrations/moon.md`'s "explicit → implicit" row and
 *   `../../e2e/moon.e2e.mjs` both drive the same `moon.yml`.
 * - **native** carries no per-project file of its own: `lattice.json`
 *   validates the row regardless of whether it sits in that file's
 *   `projects.declared` or in a tracked `project.json`
 *   (`../providers/native/discover.mjs`'s union of the two), so
 *   `lattice.json` is the workspace's single source of truth that opted
 *   either one in — the same reasoning `coverage.exempt`'s attribution above
 *   uses. `perProject: false` is what says so.
 */
const DECLARED_EDGE_SITE = Object.freeze({
  nx: { file: "project.json", field: "implicitDependencies", perProject: true },
  moon: { file: "moon.yml", field: "dependsOn", perProject: true },
  native: { file: LATTICE_MODEL_FILE, field: "implicitDependencies", perProject: false },
});

/**
 * Which field name the run's provider calls a declared edge, for the one
 * sentence the report writes about it (`../report/text.mjs`'s
 * `formatDeclaredEdges`).
 *
 * A provider this table does not know falls back to the native row rather
 * than to `undefined`: every provider that exists resolves here, and a name
 * is only ever read as prose, so an unknown one is a wrong noun rather than a
 * missing verdict. The verdict itself — the finding list — is unaffected.
 *
 * @param {string} provider
 * @returns {string}
 */
function declaredEdgeField(provider) {
  return (DECLARED_EDGE_SITE[provider] ?? DECLARED_EDGE_SITE.native).field;
}

/**
 * Where a declared-edge finding's declaration lives, so the finding can point
 * somewhere real despite having no import site.
 *
 * **The path has to be one the reader's checkout actually contains.** A
 * non-Nx provider used to get `lattice.json` unconditionally, which on a Moon
 * workspace names a file that provably cannot be there: a Moon tree carrying
 * `lattice.json` is refused outright, exit 3, before any rule runs
 * (`./context.mjs`'s `refusal(moonMarker, LATTICE_MODEL_FILE)`).
 * That is not only a confusing text line — GitHub's code scanning silently
 * DROPS a SARIF result whose `uri` is not a real repository-relative path,
 * which is exactly the failure `../custom-rules/host.mjs`'s
 * `isWorkspaceRelative` refuses for a wasm rule's own findings, so a
 * declared-edge violation reported through `--format sarif` disappeared with
 * no error anywhere. Moon reaches this function on every hand-written
 * `dependsOn` since #262 inverted the Moon `explicit`/`implicit` mapping (the
 * comment here previously claimed it could not reach it at all), so that path
 * is now the common one rather than a corner.
 *
 * The per-project half is built from the graph node's own `root` — the
 * finding carries a project NAME, and the node is the only place its
 * directory is known — the same derivation the Nx arm has always used.
 *
 * @param {{provider: string, graph: {nodes: object}}} commandContext
 * @param {string} sourceProject
 * @returns {string} A workspace-relative path.
 */
function declaredEdgeManifest({ provider, graph }, sourceProject) {
  const site = DECLARED_EDGE_SITE[provider] ?? DECLARED_EDGE_SITE.native;
  if (!site.perProject) return site.file;
  const root = graph.nodes[sourceProject]?.data?.root;
  // A root of `.` (or `""`, or a trailing slash) is the workspace root
  // itself — Moon spells a root-level project's `source` exactly that way
  // (`../providers/moon.mjs`'s `inferWorkspaceLayout` names the same
  // spelling) — and `./project.json` is a different string from
  // `project.json` to every consumer that compares paths, this file's own
  // SARIF `uri` included.
  const scoped = typeof root === "string" ? root.replace(/\/+$/u, "") : "";
  return scoped === "" || scoped === "." ? site.file : `${scoped}/${site.file}`;
}
/**
 * Runs one `check`: workspace, analysis, rules, report.
 *
 * Returns the report and the counts rather than printing, so the caller owns
 * both the destination and the exit code — and so a test can read the verdict
 * without a subprocess.
 *
 * The workspace/provider/analysis preamble is `./context.mjs`'s
 * `resolveCommandContext` — this function's whole body used to BE that
 * preamble, before a second command existed to need it too. What is still
 * this function's own: loading the boundary policy, the go.work drift check,
 * the tsconfig paths hygiene check, judging the rules, and rendering the
 * report in whichever format was asked for.
 *
 * `readGraph` and `listFiles` are the two seams that reach outside this
 * process — Nx and git — threaded straight through to `resolveCommandContext`.
 * Injectable for the same reason every resolver in this project takes its
 * readers: a test drives the real analysis, the real rules and the real
 * report over a fixture tree, and pins the exact `file:line:column` a
 * developer would act on, without an Nx installation or a git repository.
 *
 * @param {{format: string, config: string|null, paths: string[],
 *   evidenceOut?: string|null}} options
 * @param {{cwd: string, readGraph?: Function, listFiles?: Function}} context
 * @returns {Promise<{report: string, violations: number, declaredEdgeFindings: number,
 *   goWorkDrift: number, tsconfigPathsDead: number, intentFindings: number,
 *   intentUnresolved: number, intentUnresolvedDecisionRefs: number, fitnessFail: number,
 *   fitnessUnknown: number, customRuleFail: number, customRuleUnknown: number,
 *   customRuleEvidence: {rule: string, bytes: Uint8Array}[], customRulesDeclared: boolean,
 *   analyzed: number, unchecked: number, waived?: number}>}
 */
export async function check(options, { cwd, readGraph, listFiles = listTrackedFiles }) {
  const commandContext = resolveCommandContext(
    { cwd, paths: options.paths },
    { readGraph, listFiles },
  );
  const { root, graph, workspace, tracked } = commandContext;
  const { imports, exemptedFiles } = commandContext.analysis;
  const failures = [...commandContext.analysis.failures];
  const analyzed = commandContext.analysis.analyzed;

  // The config's location is a separate fact from the workspace root, which is
  // why `--config` does not move the root: pointed at a consumer's tree, the
  // tool and the law it enforces are in different trees, and the tree being
  // judged is still the consumer's. Loaded before the three workspace-level
  // checks below (go.work drift, dead tsconfig path aliases, and the declared
  // `implicitDependencies` edges), the same order `check` has always used — a
  // malformed `--config` stops the run before any of them runs at all.
  // `resolvePolicy` owns the profile/file/inline priority — see its own doc for the order and
  // why a `profiles` registry, when named, takes `--config`/`boundaryConfig`
  // over as a profile NAME rather than a filename. `check` is the one caller
  // of the eleven that also needs to know WHICH profile/file resolved it —
  // `profile`/`source` — so its report can name the law that governed the run
  // (P1-01): a violating tree under a weak policy and a clean tree under a
  // strict one used to produce byte-identical output, with nothing anywhere in
  // the report saying which law had run. `profile` is `null` on every branch
  // but the profile one — stated, not omitted, the same "no fact, no claim"
  // bargain `goWork`/`tsconfigPaths` keep below for a feature a workspace does
  // not use either. `source` is always workspace-relative, the convention
  // every other file reference in this report already keeps (`sourceFile`,
  // `tsConfig`, intent's `file`).
  const {
    config,
    profile: policyProfile,
    source: policySource,
  } = await resolvePolicy(options, commandContext, cwd);
  // D-10: provenance is resolved once, up front — BEFORE any verdict — and
  // reused in the JSON envelope, so a commitless repository (an unborn HEAD,
  // which makes `git ls-files` report zero files) is a loud exit-3 could-not-
  // look in BOTH report formats instead of a quiet "0 imports in 0 files"
  // claim. `resolveProvenance` throws for that state; `null` here means "git
  // not available or not a repository at all", a legitimate no-origin-claim.
  const provenance = resolveProvenance(root);
  // The policy's own fingerprint, alongside its source — the SHA-256 of the
  // canonicalized policy (`depConstraints`/`options`/`suppressions`) that
  // `graph`/`diff`/`history` already share (`computePolicyFingerprint`,
  // `./graph.mjs`), reused here rather than recomputed by hand so
  // two runs under the identical effective policy always agree, whichever of
  // `resolvePolicy`'s branches produced it. Unlike `graph`'s own optional
  // `result.policy` — absent when no config was given — `check` always loads
  // exactly one policy before it can judge anything, so `policy` is `null`
  // only on the one defensive arm `resolvePolicy` itself documents as
  // unreachable by any current provider.
  const policy = config
    ? {
        profile: policyProfile,
        source: policySource,
        fingerprint: computePolicyFingerprint(config),
      }
    : null;

  // The go.work drift check, keyed off the manifest's presence the way every
  // resolver keys off its language's manifest: no tracked root go.work, no
  // check and no mention. It ignores `options.paths` on purpose — two
  // workspace facts are compared, not files analyzed — and a go.work the
  // parser cannot read becomes a whole-file failure (exit 3) rather than a
  // truncated use list, because a use list cut short at the malformed line
  // would hide every stale entry below it while inventing missing-use
  // findings above it — a verdict about a file that was never read
  // (`../go-work.mjs`).
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
      failures.push(
        fileFailure(
          "go.work",
          `${cause?.message ?? cause} — a go.work this tool cannot read is a coverage hole, ` +
            `not an empty use list, so the drift check reached no verdict`,
        ),
      );
    }
  }

  // The tsconfig paths hygiene check, keyed the same way: no `paths` table in
  // the workspace tsconfig — or no tsconfig at all — means no check and no
  // mention. The table, its base and the failure posture all come from the
  // resolver's own parsed context (`tsconfigPathsFacts`), so the file judged
  // here is provably the file `ts.resolveModuleName` reads, and a tsconfig
  // that failed to load is a whole-file failure (exit 3) here exactly as it is
  // at every TypeScript import site — never an absent table. Only existence is
  // asked of the filesystem, because the judgement is about directories on
  // disk, the same disk the resolver probes (`../tsconfig-paths.mjs` owns the
  // rule and its limits). Like go.work, `options.paths` is ignored on purpose:
  // a workspace fact is judged, not files analyzed.
  let tsconfigPaths = null;
  {
    const facts = tsconfigPathsFacts(workspace);
    if (facts.configFailure !== null) {
      failures.push(
        fileFailure(
          facts.tsConfig,
          `${facts.configFailure} — and the paths hygiene check reached no verdict, because a ` +
            `tsconfig this tool cannot load is a coverage hole, not an empty alias table`,
        ),
      );
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
        failures.push(fileFailure(facts.tsConfig, reason));
      }
    }
  }

  // The architecture-intent check, keyed the same way as go.work and tsconfig:
  // a tracked root `architecture-intent.json` means the workspace declared the
  // architecture it intends, and the observed graph is judged against it. An
  // intent file that fails to parse or validate is a no-verdict (exit 3) on
  // the intent axis rather than "no intent" — a declaration this tool cannot
  // establish must never read as one that was verified. It is NOT folded into
  // `failures`: that bucket means "a source file the analysis could not read",
  // and counting `architecture-intent.json` there would flip
  // `coverage.complete` and list it among `notAnalyzed` source holes, which a
  // reader would misread as a coverage problem with source files (the design
  // contract `docs/reference/architecture-intent.md` states: a malformed
  // intent renders as a distinct line, never as "N files could not be
  // analyzed"). It rides `intentUnresolved` instead, the same no-verdict lane
  // a zero-member boundary takes.
  /** @type {{verdict: "ok"|"findings"|"no-verdict", findings: object[], unresolved: object[], boundaries: object[], notes: object[], unresolvedDecisionRefs?: {kind: string, decisionRef: string}[]}|null} */
  let intent = null;
  // The intent rows that carry a `decisionRef`, for `check`'s own citation
  // pass — empty when no intent is tracked, and populated by the fold below
  // (F01: an intent row citing nothing the registry knows must be surfaced
  // the way `drift`/`provenance` surface it, not left silent).
  let intentDecisionRefRows = [];
  if (tracked.includes(INTENT_FILE)) {
    try {
      // The drift fold runs the same refuse-incomplete-graph guard the `drift`
      // command does: an Nx workspace whose polyglot manifests are invisible to
      // the graph must not have its intent judged against a graph that cannot
      // see them. `driftForCheck` is what `drift` and `check` share.
      const drift = await driftForCheck(commandContext, {
        loadIntentOverride: (root) => loadIntent(root, { tracked }),
      });
      intent = {
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
      // The fold's intent rows carrying a `decisionRef` — the rows `drift`/
      // `provenance` judge loudly, and which `check` must not leave silent
      // (F01). Captured here, outside the `intent` object, so the citation
      // pass below can judge them through the same registry as the boundary
      // rows.
      intentDecisionRefRows = drift.decisionRefRows;
    } catch (cause) {
      const reason =
        `${cause?.message ?? cause} — architecture-intent.json could not be ` +
        `established, so the intent check reached no verdict`;
      intent = {
        verdict: "no-verdict",
        findings: [],
        unresolved: [{ boundary: INTENT_FILE, issue: reason }],
        boundaries: [],
        notes: [],
      };
    }
  }

  // Both faces of one walk: the run's verdict, and the raw superset it was
  // picked from — every candidate up to each site's surviving group, including
  // the verdicts the suppression table removed to get there. `evaluate` alone
  // cannot answer whether a row is dead, because a row that removes everything
  // leaves no trace in the verdict; the raw side of this walk is the trace.
  // The reference instant is fixed once here and threaded into the walk, so
  // the gate's waiver-expiry judgement below and the engine's are the same
  // judgement, not two reads of the clock a boundary instant could split.
  const now = referenceTime();
  const { violations: judged, rawViolations } = evaluateRun(imports, graph, { ...config, now });
  const violations = sortViolations(judged);
  // An ACTIVE waiver keeps the violation it accepts in the findings list,
  // marked `waivedBy` — the run is still non-zero (waiving does not flip
  // exit 1 → 0), and this count is the additive "accepted violations" number
  // the report surfaces. Expired waivers re-assert in full (evidence
  // "expired waiver"), so they are ordinary violations here, never waived.
  const waived = violations.filter((violation) => violation.waivedBy).length;

  // `evaluate()` above judges only import sites, by design (`../rules/README.md`:
  // "analysis records and the loaded config, nothing else"). An `implicit`-typed
  // graph edge — `implicitDependencies` in a `project.json`/`lattice.json` row —
  // has no import site behind it and so never reaches that loop, which used to
  // mean `check` reported nothing about it while `context`/`impact` (walking
  // `graph.dependencies` directly through the same `judgeEdge`) showed it as a
  // tag violation: an empty result that was not actually a clean verdict, the
  // exact defect this project's invariant forbids (`../../../../AGENTS.md`). Reusing
  // `judgeEdge` here — rather than a second implementation — is what guarantees
  // `check` can never disagree with what those commands already display for the
  // identical edge.
  const implicitEdges = Object.values(graph.dependencies ?? {})
    .flat()
    .filter((edge) => edge.type === "implicit").length;
  const declaredEdgeViolations = declaredEdgeViolationsForCheck(graph, config.depConstraints).map(
    (violation) => ({ ...violation, file: declaredEdgeManifest(commandContext, violation.source) }),
  );
  const declaredEdgeFindings = declaredEdgeViolations.length;
  // `null` — not `{checked: true, findings: []}` — when the graph has no
  // `implicit` edges at all: the same "no fact, no claim" bargain go.work and
  // tsconfig-paths state for a workspace that never uses the feature either,
  // so a workspace with no `implicitDependencies` anywhere pays nothing and
  // hears nothing, rather than a near-universal "0 implicit edges" line.
  // `declaration` names the field the RUN's provider spells a declared edge
  // with, so the report's own sentence about it can too — a Moon workspace has
  // no `implicitDependencies` field for the text to blame, and naming one sends
  // a reader looking for a key `moon.yml` does not accept. Report-only: it
  // rides beside the verdict, never into it, and the JSON envelope below still
  // publishes exactly `judged` and `findings`.
  const declaredEdges =
    implicitEdges === 0
      ? null
      : {
          findings: declaredEdgeViolations,
          judged: implicitEdges,
          declaration: declaredEdgeField(commandContext.provider),
        };

  // A `depConstraints` row's `decisionRef` names the ADR (or rule/fitness id)
  // that supposedly authorizes it — but nothing verified that citation before
  // it reached a report: `rowSchemaViolations` (`../governance/row-schema.mjs`)
  // has always had a resolution half gated on an injected `io.resolve`, and
  // `config.mjs` has never supplied one, so `resolveDecisionRef`
  // (`../governance/adr-registry.mjs`) had zero production callers. A rule
  // bound to a nonexistent ADR id fired exactly as designed and the report
  // quoted the citation as if it were confirmed. Checked only when a row
  // actually carries one — the common case (no `docs/adr/` adopted yet) pays
  // no extra read. Report-only: an unresolved citation is a fact about the
  // rule's DOCUMENTATION, not about whether the boundary holds, so it changes
  // no byte of `verdictFor`'s inputs below — the same posture `provenance`
  // already takes for a row with no `origin` (`./provenance-command.mjs`).
  //
  // The intent's rows are judged through the SAME registry, in the SAME pass,
  // so `check` cannot disagree with `drift`/`provenance` about which intent
  // citations resolve. Unlike the boundary rows, an intent row with an
  // unresolved `decisionRef` folds into the no-verdict lane (exit 3) WHEN THE
  // INTENT IS APPLIED — a workspace that declared an intended architecture
  // whose governing decision does not exist cannot claim `ok` on that axis
  // (`drift`/`provenance` already flag the identical row loudly). That is the
  // F01 parity the audit names: `drift` and `provenance` both surface it, and
  // the gate CI runs must not be the one face that stays silent.
  const unresolvedDecisionRefs = new Set();
  const intentUnresolvedDecisionRefRows = [];
  {
    // Intent rows while the intent is actually tracked — the same gate the
    // fold above uses, so a workspace with no intent pays nothing and hears
    // nothing.
    const decisionRefRows = [
      ...config.depConstraints
        .map((row, index) => ({ kind: `depConstraints[${index}]`, row }))
        .filter(({ row }) => typeof row?.decisionRef === "string" && row.decisionRef.trim() !== ""),
      ...intentDecisionRefRows,
    ];
    if (decisionRefRows.length > 0) {
      const adrContext = readAdrContext(root, { tracked });
      // F04: the fitness half resolves against the ids the loaded policy
      // DECLARES (`declaredFitnessNames(config)`), never the ADRs' own
      // `bindings` — a citation cannot resolve itself.
      for (const row of unresolvedDecisionRefRows(
        decisionRefRows,
        adrContext.byId,
        declaredFitnessNames(config),
      )) {
        unresolvedDecisionRefs.add(row.decisionRef);
        if (row.kind.startsWith("depConstraints")) continue;
        intentUnresolvedDecisionRefRows.push({ kind: row.kind, decisionRef: row.decisionRef });
      }
    }
    // The unresolved intent citations ride the intent object so the text
    // report can render them inline (the same UNRESOLVED note the constraint
    // rows get), and so the JSON intent block names WHICH rows cited what.
    if (intent !== null && intentUnresolvedDecisionRefRows.length > 0) {
      intent.unresolvedDecisionRefs = intentUnresolvedDecisionRefRows;
    }
  }

  const goWorkDrift = goWork === null ? 0 : goWork.findings.length;
  const tsconfigPathsDead = tsconfigPaths === null ? 0 : tsconfigPaths.findings.length;
  const intentFindings = intent === null ? 0 : intent.findings.length;
  const intentUnresolved = intent === null ? 0 : intent.unresolved.length;

  // The fitness fold, keyed the same two ways every governance axis is: a
  // policy that declares fitness (the `fitness` export on the boundary
  // config) is judged against the run's own facts — the same graph, the same
  // analysis, the same intent verdict, the same suppressions `check` already
  // holds. Absence is a workspace decision (the key is omitted, never
  // `null`); presence without a number of declared rows is impossible (the
  // validator refuses an empty list). A declared function whose match selects
  // no project is `skipped` — loud, never folded into `pass`; a function the
  // run could not determine is `unknown`, which rides `fitnessUnknown`, the
  // same no-verdict lane a zero-member boundary takes. `scoped` marks the
  // path-scoped case (`check <path>`), where coverage over a matched
  // project's whole file set is not determinable — the registry answers that
  // `not_applicable`, never a partial-number verdict and never `unknown`
  // either (P1-19): `coverage-minimum` cannot be judged by ANY scoped run,
  // which is a fact about the run mode, not evidence of a coverage hole, so it
  // joins `skipped` in NOT riding `fitnessFail`/`fitnessUnknown` below — a
  // scoped run over an otherwise-clean subtree in a workspace that declares
  // `coverage-minimum` no longer exits 3 for a question this run was never in
  // a position to answer.
  let fitness = null;
  if (config.fitness !== undefined) {
    const { decisions, overall } = fitnessForCheck(commandContext, {
      rows: config.fitness,
      intent,
      suppressions: config.suppressions,
      scoped: options.paths.length > 0,
    });
    fitness = { decisions, overall };
  }
  const fitnessFail = fitness === null ? 0 : fitness.overall.verdict === "fail" ? 1 : 0;
  const fitnessUnknown = fitness === null ? 0 : fitness.overall.verdict === "unknown" ? 1 : 0;

  // The custom-rules fold, keyed by presence exactly as the fitness fold above
  // is, and judged after it over the same observed facts — the same graph, the
  // same analysis, the same policy. A workspace that declares no `customRules`
  // reaches nothing here and hears nothing anywhere: no section, no envelope
  // key, no SARIF descriptor, byte-for-byte the report it already got
  // (`../../../../AGENTS.md`, "a change to what is reported on an unchanged
  // workspace is a breaking change").
  //
  // Every load-class failure THROWS out of here rather than becoming a verdict
  // — the declared law could not be read, so the run refuses the way it
  // refuses a malformed boundary config, and `runCheck` below turns that into
  // the same exit 3 (`./custom-rules.mjs` argues the split). The
  // counts below then carry only what a loaded law decided: a `fail` is a
  // finding (exit 1) and an `unknown` is a could-not-determine (exit 3), the
  // identical two lanes fitness rides, per RULE rather than per aggregate
  // because each declared rule is its own law and a reader acts on the one
  // that failed.
  let customRules = null;
  if (declaresCustomRules(config)) {
    customRules = await customRulesForCheck(commandContext, {
      rows: config.customRules,
      policy: config,
      scoped: options.paths.length > 0,
      // Off unless `--evidence-out` asked: the bundle carries every import
      // site in the tree, and a run nobody asked to inspect should not hold
      // one per rule in memory.
      collectEvidence: Boolean(options.evidenceOut),
    });
  }
  const customRuleDecisions = customRules === null ? [] : customRules.decisions;
  const customRuleFail = customRuleDecisions.filter((rule) => rule.verdict === "fail").length;
  const customRuleUnknown = customRuleDecisions.filter((rule) => rule.verdict === "unknown").length;

  // Files the run produced no verdict about, counted here rather than
  // recomputed by the caller: the exit code, the text report and the JSON
  // envelope must all agree about which failures mean "not covered", and one
  // predicate is how they do.
  const unchecked = new Set(
    failures.filter(isWholeFileFailure).map((failure) => failure.sourceFile),
  ).size;

  // A row of the boundary law that covers nothing is a boundary that stopped
  // being enforced, and — unlike a missing `reason`, which only a human can
  // judge — it is machine-detectable. Two tables can be dead, and both are
  // refused here with the same exit and the same sentence shape the stale
  // `coverage.exempt` row has always gotten (`../providers/native/index.mjs`):
  //
  // - a `boundarySuppressions` row covering no candidate violation, measured
  //   against `rawViolations` above (the candidates up to each site's
  //   surviving group, so a row covering a verdict ANOTHER row removed first
  //   still counts as alive). Waiver rows still in force are excluded: their
  //   lifecycle is the `waivers` command's informational surface, which has
  //   always reported a term-bearing row that currently covers nothing as
  //   stale rather than fatal — a fixed violation leaves its waiver idle until
  //   expiry, and that resting state is the feature working, not a defect. An
  //   EXPIRED waiver (`fate === "reassert"`) is the opposite state: its term
  //   has lapsed, it can never come back into force without an edit, and it
  //   sits in the table forever — exactly as dead as a permanent row, refused
  //   here with it, named with its lapse date.
  // - a `depConstraints` row selecting no project as its source
  //   (`unmatchedConstraintRows`), which approves everything on its axis while
  //   reading as enforced. This half applies to law the workspace WROTE — a
  //   filename at its root, an inline policy, a registry it keeps in the tree.
  //   A profile resolved from inside a dependency install (`node_modules`) is
  //   exempt: a shipped policy pack is data adopted wholesale
  //   (`docs/usage/presets.md` — "a pack saves you the blank page"), written
  //   for trees that instantiate its style at their own pace, so holding its
  //   rows to this tree's tag vocabulary would refuse every partial adoption —
  //   the false-positive direction. A rename under an adopted pack is still
  //   loud for the reason that feature already ships: the renamed projects
  //   stop matching any row, and the no-matching-constraint-is-an-error rule
  //   reports them on their first import (`../rules/tags.mjs`'s header).
  //
  // Both verdicts fire only where they are KNOWABLE — a whole-workspace run
  // over a tree this run fully analyzed. A path-scoped run judges part of the
  // tree, and files whose analysis failed contribute no candidates at all;
  // either way a row covering nothing in what this run saw may cover plenty in
  // what it did not (a scoped run over a half-adopted style pack being the
  // everyday case for the constraint half), and refusing there would be the
  // false-positive direction. The language server's per-file path never
  // reaches this function, so it needs no guard of its own. The constraint
  // verdict needs only the graph, which scoping never narrows, but it rides
  // the same gate rather than a second one — one dialect, one condition pair,
  // stated once (`../../../../AGENTS.md`, "Never state a rule twice").
  if (
    config !== null &&
    options.paths.length === 0 &&
    failures.length === 0 &&
    (config.suppressions.length > 0 || config.depConstraints.length > 0)
  ) {
    const deadRows = [];
    config.suppressions.forEach((row, index) => {
      const fate = suppressionFate(row, now);
      if (fate === "waive") return;
      if (rawViolations.some((violation) => suppressionCovers(row, violation))) return;
      const expired = fate === "reassert" ? ` (expired ${row.expiresAt})` : "";
      deadRows.push(
        `boundarySuppressions[${index}]: '${row.path}'${expired} matches no violation this run ` +
          `judged — either the code it accepted is gone, or the path was never right`,
      );
    });
    const authoredLaw =
      policySource === null || !policySource.split(/[\\/]/u).includes("node_modules");
    if (authoredLaw && Object.keys(graph.nodes).length > 0) {
      for (const { row, index } of unmatchedConstraintRows(config.depConstraints, graph)) {
        const selector = Array.isArray(row.allSourceTags)
          ? `allSourceTags (${row.allSourceTags.join(", ")})`
          : `sourceTag '${row.sourceTag}'`;
        deadRows.push(
          `depConstraints[${index}]: ${selector} matches no project in the graph — the row ` +
            `selects no source, and a constraint matching nothing does not error, it approves. ` +
            `Either its tags were renamed out from under it or they were never right`,
        );
      }
      for (const { index, position, tag } of orphanedNotDependOnTags(
        config.depConstraints,
        graph,
      )) {
        deadRows.push(
          `depConstraints[${index}].notDependOnLibsWithTags[${position}]: '${tag}' is carried by ` +
            `no project in the graph — the ban names nothing that can exist, so this axis of the ` +
            `row forbids nothing while reading as enforced. Either the tag was renamed out from ` +
            `under it or it was never right`,
        );
      }
    }
    if (deadRows.length > 0) {
      throw new Error(
        `lattice: ${policySource ?? "the boundary config"} describes a workspace that does not ` +
          `match the tree:\n  ${deadRows.join("\n  ")}`,
      );
    }
  }

  // A `coverage.exempt` row removes a file from `unclaimed` before this run
  // ever sees it — legitimately, for vendored or generated code — but nothing
  // that removal produces was ever named in any report: an exempted file and
  // a genuinely covered one read identically in every surface `check`
  // produces. Stated as a note for the same reason the polyglot coverage gap
  // below is: the exit code and verdict are unchanged (this is what
  // `coverage.exempt` is FOR), but the silent direction — a reader unable to
  // tell that coverage narrowed at all — is closed.
  const exemptionNote =
    exemptedFiles.length > 0
      ? `${exemptedFiles.length} file${exemptedFiles.length === 1 ? "" : "s"} exempted from ` +
        `coverage by ${LATTICE_MODEL_FILE}'s coverage.exempt`
      : null;

  // The other half of the same fact (#218): an import whose record resolved
  // INTO one of those files is judged unconstrained — neither a project edge
  // nor an external import (`../rules/index.mjs`'s `exemptResolvedFile`,
  // the same predicate the rule engine decided the site with, not a second
  // membership test that could drift from it). Without this count, "the run
  // chose not to constrain these imports" and "these imports never existed"
  // would render identically — the silent direction again. Stated only when
  // nonzero, so a workspace with exempt files but no imports of them keeps
  // byte-identical output; and always directly after `exemptionNote`, which
  // is what "those files" below points at.
  const exemptedSet = new Set(exemptedFiles);
  const unconstrainedExemptImports = imports.filter(
    (site) => exemptResolvedFile(site, exemptedSet) !== null,
  ).length;
  const unconstrainedImportNote =
    unconstrainedExemptImports > 0
      ? `${unconstrainedExemptImports} import${unconstrainedExemptImports === 1 ? "" : "s"} ` +
        `resolve${unconstrainedExemptImports === 1 ? "s" : ""} into those files and ` +
        `${unconstrainedExemptImports === 1 ? "is" : "are"} left unconstrained — neither project edges nor external imports`
      : null;

  // Ready-to-ship policy facts have always been sourced from `boundaryConfig`
  // via `../config.mjs`'s `notes`; the intent check's own coverage notes ride
  // the same seam so both surfaces (text and JSON) thread them identically —
  // today only an `"optional": true` allowed row whose statement is absent.
  const notes = [
    ...(config.notes ?? []),
    ...(intent === null ? [] : intent.notes),
    ...(exemptionNote === null ? [] : [exemptionNote]),
    ...(unconstrainedImportNote === null ? [] : [unconstrainedImportNote]),
  ];

  // A polyglot coverage gap: the Nx graph carries no polyglot edges because
  // the plugin is not registered, but polyglot manifests exist under project
  // roots. The checker still judged every import it found — this is not a
  // finding and not a refusal — but `nx affected` and `@nx/enforce-module-boundaries`
  // are blind to Go, Rust and Python dependencies. Surfaced as a
  // degraded-coverage note so the silent direction (exit 0 with no mention) is
  // closed, without changing the exit code or verdict. The condition mirrors
  // `./graph.mjs`'s refusal, which throws for the same state
  // because a descriptive command's output is the graph itself — here the
  // checker's own analysis covers what the graph does not, so a note is the
  // right level. cf. #38
  //
  // The second kind rides the same channel for the same reason: tracked
  // analyzable files no project owns, in the languages `./context.mjs`'s
  // `UNCLAIMED_CHECK_LANGUAGES` deliberately does NOT fail on. Skipping them
  // is the documented, unchanged decision (`../../../../docs/reference/violations.md`,
  // "The order matters" step 2); leaving no trace of the skip anywhere in the
  // report was not — the run printed byte-identical output whether fifty
  // files sat outside every project or none did (#263). Appended AFTER the
  // plugin gap, and contributed only when the list is non-empty, so a
  // workspace with no unowned analyzable file reports exactly the bytes it
  // reported before. Like the gap above it: no exit code, no verdict, and
  // `coverage.complete` untouched — those belong to `unchecked`, and moving
  // this state into them would turn `check` red on trees whose only sin is a
  // root-level tooling script.
  // The law that actually governed THIS run, not the one the workspace
  // declared: `policySource` already carries the `--config` override and the
  // resolved profile, workspace-relative. Subtracting it here rather than
  // inside `resolveCommandContext` is forced — `resolvePolicy` takes the
  // context as an argument, so it cannot run before it. `tsConfig` joins it
  // because it is configuration by the same test, though every spelling of it
  // is `.json` today and so never reaches the list.
  const unownedGap = unownedGapWithoutRunConfiguration(commandContext.unownedGap, [
    policySource,
    commandContext.options.tsConfig,
  ]);

  const coverageGaps = [
    ...(commandContext.provider === "nx" &&
    !commandContext.pluginGap.registered &&
    commandContext.pluginGap.manifests.length > 0
      ? [{ kind: "unregistered-plugin", manifests: commandContext.pluginGap.manifests }]
      : []),
    ...(unownedGap.files.length > 0
      ? [
          {
            kind: "unowned-files",
            // Which project model a reader has to declare the files in — the
            // remediation differs by provider (`project.json` against
            // `moon.yml`), and the faces that render this carry no other way
            // to know which tree they are describing.
            provider: commandContext.provider,
            languages: unownedGap.languages,
            files: unownedGap.files,
          },
        ]
      : []),
  ];

  const report =
    options.format === "json"
      ? renderJson(
          jsonEnvelope({
            command: "check",
            context: {
              root,
              provider: commandContext.provider,
              marker: commandContext.marker,
              // D-10: provenance rides the SAME-envelope shape every other
              // command resolves through the one `resolveProvenance` — a check
              // report is byte-identifiable to the git HEAD it was run on, so
              // a dirty or un-stamped CI run cannot present a claim about a
              // different tree state. Resolved once at the top of `check` for
              // the reason that comment states.
              provenance,
            },
            // `verdictFor` returns `status`, `exitCode`, and the canonical
            // `decision` — the four-state verb of the same counts — so the
            // envelope's `decision.verdict` and its `status` are built from
            // exactly one computation and can never disagree.
            ...verdictFor({
              violations: violations.length,
              declaredEdgeFindings,
              goWorkDrift,
              tsconfigPathsDead,
              intentFindings,
              intentUnresolved,
              intentUnresolvedDecisionRefs: intentUnresolvedDecisionRefRows.length,
              unchecked,
              fitnessFail,
              fitnessUnknown,
              customRuleFail,
              customRuleUnknown,
            }),
            coverage: {
              complete: unchecked === 0,
              projects: Object.keys(graph.nodes).length,
              analyzedFiles: analyzed,
              imports: imports.length,
              notAnalyzed: failures
                .filter(isWholeFileFailure)
                .map(({ sourceFile, reason }) => ({ file: sourceFile, reason })),
              blindSpots: failures
                .filter((failure) => !isWholeFileFailure(failure))
                .map(({ sourceFile, line, column, reason }) => ({
                  file: sourceFile,
                  line,
                  column,
                  reason,
                })),
              notes,
              coverageGaps,
            },
            result: {
              // Named first: which law produced everything below it (P1-01).
              // Always present — `check` cannot judge anything without
              // loading exactly one policy — unlike `graph`'s own `policy`,
              // which is absent when no config was given to a purely
              // descriptive run.
              policy,
              violations,
              // Additive and optional: absent when the tree has no active
              // waivers, so an unchanged tree's JSON is unchanged. Never `!` —
              // the accepted count is a tracked decision, not a new error kind.
              ...(waived > 0 ? { waived } : {}),
              // Additive and optional, the same bargain: absent when every
              // depConstraints row's decisionRef resolves (or none carries
              // one) — an unchanged tree's JSON is unchanged. A row that fired
              // stays in `violations` with its raw `constraint.decisionRef`
              // untouched (byte-identical to today); this list is the
              // separate, resolved fact a consumer cross-checks it against,
              // never a mutation of the row itself.
              ...(unresolvedDecisionRefs.size > 0
                ? {
                    unresolvedDecisionRefs: [...unresolvedDecisionRefs].sort((a, b) =>
                      a < b ? -1 : a > b ? 1 : 0,
                    ),
                  }
                : {}),
              goWork: goWork === null ? null : { checked: true, findings: goWork.findings },
              tsconfigPaths:
                tsconfigPaths === null ? null : { checked: true, findings: tsconfigPaths.findings },
              // `declaredEdges` is `null` under the same "no fact, no claim"
              // bargain as goWork/tsconfigPaths above — computed once, right
              // where `implicitEdges` is counted.
              declaredEdges:
                declaredEdges === null
                  ? null
                  : {
                      checked: true,
                      judged: declaredEdges.judged,
                      findings: declaredEdges.findings,
                    },
              // Intent is a governance DECLARATION, absent when the workspace
              // chose not to make one: the key is omitted, never written as
              // null — the design contract `docs/reference/json-output.md` will
              // state ("never serialized as `null` — absent key, not null
              // value"). goWork/tsconfig leave a named null because those are
              // checks the tool can always run (they just found nothing);
              // intent absence is a workspace decision, not a finding of zero.
              ...(intent === null
                ? {}
                : {
                    intent: {
                      checked: true,
                      file: INTENT_FILE,
                      verdict: intent.verdict,
                      findings: intent.findings,
                      unresolved: intent.unresolved,
                      boundaries: intent.boundaries,
                      // The intent rows whose `decisionRef` does not resolve —
                      // the same citations `result.unresolvedDecisionRefs` lists
                      // values for, named here with their row so the JSON
                      // intent block is self-contained.
                      ...(intent.unresolvedDecisionRefs !== undefined
                        ? { unresolvedDecisionRefs: intent.unresolvedDecisionRefs }
                        : {}),
                    },
                  }),
              // Fitness is a policy DECLARATION too, absent when the workspace
              // chose not to declare functions — the same omitted-key-not-
              // null discipline the intent block above states.
              ...(fitness === null
                ? {}
                : {
                    fitness: {
                      checked: true,
                      verdict: fitness.overall.verdict,
                      functions: fitness.decisions,
                    },
                  }),
              // Custom rules are a policy DECLARATION as well, and take the
              // same omitted-key-not-null discipline: a workspace that
              // declares none has no `customRules` key at all, so its envelope
              // is byte-identical to the one it got before this section
              // existed — the additive-only half of the stability promise
              // `docs/reference/json-output.md` publishes. `rules` (not
              // `functions`) because each entry is a whole declared law rather
              // than a named gate, and it carries the rule's own `findings`,
              // which no fitness decision has.
              ...(customRules === null
                ? {}
                : {
                    customRules: {
                      checked: true,
                      verdict: customRules.overall.verdict,
                      rules: customRules.decisions,
                    },
                  }),
            },
          }),
        )
      : FORMATS[options.format]({
          policy,
          violations,
          failures,
          analyzed,
          imports: imports.length,
          projects: Object.keys(graph.nodes).length,
          goWork,
          tsconfigPaths,
          declaredEdges,
          intent,
          fitness: fitness?.decisions,
          fitnessOverall: fitness?.overall,
          // One object rather than the decisions/overall pair fitness passes:
          // the SARIF face also needs the finding CATALOGUE (its
          // reportingDescriptor set), and splitting three fields across the
          // two formatters would let a face be handed one without the others.
          customRules,
          // Only the ESLint boundaryConfig dialect ever produces one (see
          // `../eslint-config.mjs`'s `extractBoundaryRule`) — which entry it
          // bound when more than one configured the rule, or that the winning
          // entry was files-scoped under the accepted TS/JS shape. Computing it
          // and never showing it would be the silent direction with extra
          // steps, so it rides the same coverage line every other "what was
          // inspected" fact does (`../report/text.mjs`'s `formatReport`).
          notes,
          coverageGaps,
          // `formatReport` (text) reads this to annotate an unresolved
          // decisionRef inline; `formatSarif` files each one as a warning
          // notification. Both faces of one run name the same citations, in
          // the same order — the SARIF face sorts with the comparator this
          // envelope already uses, so a reader comparing them cannot find
          // them disagreeing.
          unresolvedDecisionRefs,
        });

  return {
    report,
    violations: violations.length,
    waived,
    declaredEdgeFindings,
    goWorkDrift,
    tsconfigPathsDead,
    intentFindings,
    intentUnresolved,
    intentUnresolvedDecisionRefs: intentUnresolvedDecisionRefRows.length,
    fitnessFail,
    fitnessUnknown,
    customRuleFail,
    customRuleUnknown,
    // Empty on every run that did not ask for it, and — deliberately — also
    // on a scoped run and on a policy that declares no custom rule. `runCheck`
    // tells those three apart before it writes anything, because a
    // `--evidence-out` that quietly produced no file would be the silent
    // direction wearing a debugging flag's name.
    customRuleEvidence: customRules?.evidence ?? [],
    customRulesDeclared: customRules !== null,
    analyzed,
    unchecked,
  };
}

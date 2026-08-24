/**
 * The custom-rules fold: every rule the workspace's policy declares, loaded
 * from its artifact and judged over the evidence this run already computed.
 *
 * A custom rule is a pure function from evidence to verdict
 * (`../../../../docs/adr/0002-custom-rules-one-contract.md`). Two modules
 * already own the halves of that sentence — `../custom-rules/evidence.mjs`
 * builds the "in" side and `../custom-rules/host.mjs` runs the artifact and
 * holds it to the contract — and neither reads a file, because the commands
 * layer owns files (`./README.md`, and the same split `../rules/README.md`
 * states: "reads records, never files"). This module is the third piece: it
 * turns a declared row into bytes, drives those two, and hands back the same
 * verdict records `check` already folds into its exit machinery for fitness.
 *
 * ## By presence, and once
 *
 * There is no `--custom-rules` flag, for the reason there is no `--fitness`
 * one (`./fitness.mjs`'s header): an opt-in flag makes a forgotten flag
 * byte-identical to "no custom rules checked", which is the silent direction
 * this tool exists to end. A policy that declares `customRules` gets them
 * judged, once per run, over the facts the run already holds.
 *
 * ## The two failure classes are not interchangeable
 *
 * `../custom-rules/host.mjs` separates them and this module routes them:
 *
 * - **LOAD** — the declared law could not be loaded (unreadable artifact,
 *   hash mismatch, bytes that are not wasm, a module that asks for an import,
 *   a missing export, a self-description that will not read). This module
 *   THROWS, which reaches a reader the way a malformed boundary config does:
 *   `../../cli.mjs`'s `runCheck` prints the message and exits 3. Judging a
 *   tree against a law that was never read would be a verdict about nothing —
 *   and reporting the rule as `unknown` instead would let a workspace ship a
 *   permanently unloadable rule and still see a green-ish table row for it.
 *   Every rule is loaded BEFORE any is evaluated, so a run either judges the
 *   whole declared law or refuses it; half a law, half-applied, is a verdict
 *   nobody declared.
 * - **EVALUATE** — the law loaded and this rule could not reach a verdict (a
 *   trap, a timeout, an unreadable verdict, an evidence kind this contract
 *   does not carry). The RULE's verdict becomes `unknown` with the host's own
 *   self-standing reason carried through unedited, and the run's exit follows
 *   the same lane a `unknown` fitness function takes (exit 3).
 *
 * ## A path-scoped run answers `not_applicable`, before anything is read
 *
 * `check <path>` analyzes a subset of the tree, so the `imports` kind is a
 * subset and the evidence bundle would describe a workspace that does not
 * exist. A rule judged over it would answer about a tree nobody has —
 * `not_applicable` is the posture `coverage-minimum` already takes for the
 * identical reason (`../governance/fitness-rules.mjs`'s `coverageMinimum`):
 * loud, reason named, and — unlike `unknown` — not by itself a failed run, so
 * a scoped run over a clean subtree does not exit 3 for a question it was
 * never in a position to ask.
 *
 * The decision is taken BEFORE any artifact is read, which is the one place
 * this module deliberately differs from a full run: a scoped run reads no
 * artifact, hashes nothing, and starts no worker. Loading is not free — it
 * runs `archkeep_describe` inside a worker — and paying for it to reach a
 * verdict already known to be `not_applicable` would be work with no judgment
 * behind it. Nothing is hidden by that: every declared rule still gets its own
 * row, naming itself and why it did not apply, in all three faces.
 *
 * ## Determinism
 *
 * Rules are judged in declaration order (row order is semantic for a policy,
 * the same reason `../canonical.mjs` leaves `depConstraints` order alone), and
 * a rule's own findings are left in the order it emitted them: a rule holds no
 * ambient capability, so its output is a function of the evidence bytes, and
 * re-sorting would destroy an order the rule chose rather than normalize an
 * accident. The evidence itself is byte-deterministic by construction
 * (`../custom-rules/evidence.mjs`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalizeJson } from "../canonical.mjs";
import { containmentViolation } from "../containment.mjs";
import { buildEvidenceBundle, serializeEvidenceBundle } from "../custom-rules/evidence.mjs";
import {
  CUSTOM_RULE_TIMEOUT_MS,
  evaluateCustomRule,
  loadCustomRule,
} from "../custom-rules/host.mjs";
// The overall-verdict precedence — any `fail`, then any `unknown`, then
// all-`not_applicable`, else `pass` — is stated once, by the module that
// already owned it for fitness. A second copy here would be the one that
// drifted (`../../../../AGENTS.md`, "Never state a rule twice").
import { fitnessVerdictFor } from "../governance/fitness-registry.mjs";
import { fitnessVerdict } from "../governance/verdict.mjs";

/**
 * The namespace every custom finding is reported under, in all three faces:
 * `custom/<ruleName>/<findingId>`. Built here, once, and carried on the
 * records this module hands back — so `../report/text.mjs`, `../report/sarif.mjs`
 * and `../../cli.mjs`'s JSON envelope render an id rather than compose one,
 * and three faces cannot come to spell the same finding three ways. Exported
 * for `./delta-classify.mjs`, whose classified entries name the same id.
 *
 * @param {string} ruleName
 * @param {string} findingId
 * @returns {string}
 */
export function namespacedId(ruleName, findingId) {
  return `custom/${ruleName}/${findingId}`;
}

/**
 * Whether a policy declares custom rules at all — the one condition that
 * separates "this workspace declared no rules of its own" from "the rules
 * could not be judged". Exported so `../../cli.mjs` and this module cannot
 * come to disagree about what "declares custom rules" means, the same bargain
 * `./fitness.mjs`'s `declaresFitness` states.
 *
 * @param {{customRules?: unknown}|null|undefined} config The loaded policy.
 * @returns {boolean}
 */
export function declaresCustomRules(config) {
  return config !== null && config !== undefined && config.customRules !== undefined;
}

/**
 * The default artifact reader: a rule's bytes, read from the workspace root.
 *
 * Binary, and therefore not `Workspace.readFile` — that reader decodes UTF-8
 * (`../workspace.mjs`), which would replace every byte a wasm module is made
 * of. It carries the same containment rule that reader does: a path that
 * resolves through a symlink out of the tree hands back bytes the workspace
 * never committed, and running them as the declared law is the whole verdict
 * built on outside input (`../containment.mjs`, the G-10 closure).
 *
 * `null` covers every way the bytes did not arrive — absent, unreadable,
 * escaping the tree — because the caller reports all three the same way: a
 * declared law with no bytes behind it is a run that refuses. The artifact is
 * NOT required to be a tracked file: the `sha256` the row pins is what makes
 * "the law CI ran is the law review saw" checkable (`../config.mjs`), and a
 * tracked-ness requirement would refuse a legitimately generated artifact
 * whose hash a reviewer approved in the policy anyway.
 *
 * @param {string} root Absolute workspace root.
 * @returns {(artifact: string) => Uint8Array|null}
 */
export function readArtifactBytes(root) {
  return (artifact) => {
    const abs = join(root, artifact);
    if (containmentViolation(root, abs) !== null) return null;
    try {
      return readFileSync(abs);
    } catch {
      return null;
    }
  };
}

/**
 * @param {string} name
 * @param {string} reason
 * @returns {never}
 */
function refuseLoad(name, reason) {
  // The `custom rule "<name>": ` prefix is the host's own spelling for a
  // failure (`../custom-rules/host.mjs`'s `failed`), matched here so a
  // caller-side load failure and a host-side one read as one class.
  throw new Error(`archkeep: custom rule "${name}": ${reason}`);
}

/**
 * One rule's verdict record — the same envelope every governance consumer
 * reads (`../governance/verdict.mjs`), plus the two facts a custom rule adds.
 *
 * `reason` is the policy row's own declared reason (why the workspace has this
 * rule at all), which is a different question from a verdict's `message` (what
 * this run decided) and from `notApplicableReason` (why it did not apply). All
 * three can be true at once, so all three are carried rather than collapsed.
 *
 * @param {{name: string, reason: string}} row The declared policy row.
 * @param {{verdict: "pass"|"fail"|"unknown"|"not_applicable", evidence: object,
 *   message: string, findings?: object[], notApplicableReason?: string}} decided
 * @returns {object}
 */
function decisionFor(row, decided) {
  return {
    ...fitnessVerdict({
      verdict: decided.verdict,
      name: row.name,
      evidence: decided.evidence,
      message: decided.message,
      notApplicableReason: decided.notApplicableReason,
    }),
    reason: row.reason,
    findings: decided.findings ?? [],
  };
}

/**
 * A declared rule's row on a path-scoped run.
 *
 * `evidence` names the artifact but NOT its `sha256`: on this path nothing was
 * read and nothing was hashed, and printing the declared digest beside a rule
 * that never ran would present an unverified claim in the slot every other row
 * uses for a verified one.
 *
 * @param {{name: string, artifact: string, reason: string}} row
 * @returns {object}
 */
function scopedDecision(row) {
  return decisionFor(row, {
    verdict: "not_applicable",
    evidence: { artifact: row.artifact, scoped: true },
    notApplicableReason:
      "this run was scoped to specific paths — a custom rule is judged over whole-tree evidence, " +
      "and it needs a full, unscoped run",
    message:
      "does not apply to a path-scoped run — a custom rule sees the whole tree's evidence or " +
      "none of it, so it needs a full `check` with no paths",
  });
}

/**
 * The evidence facts every rule in this run is judged over, assembled once.
 *
 * Only the `rule` block differs between rules (its `params` ride inside the
 * bundle), so everything else is collected here and handed to
 * `buildEvidenceBundle` once per rule. The bundle's own sorting and validation
 * run per call — that is its contract, and reaching around it to sort here
 * would put a second opinion about "what the evidence is" beside the one
 * module that owns the question.
 *
 * Attribution for `imports` comes from `commandContext.owned` — the ownership
 * map `../workspace.mjs` already built — because the workspace layer is the
 * only one allowed to say which project owns a file, and re-deriving it from a
 * root prefix here would be a second answer to a question already answered.
 *
 * @param {object} commandContext From `./context.mjs`'s `resolveCommandContext`.
 * @param {object} policy The loaded boundary policy.
 * @returns {{projects: object[], edges: object[], imports: object[], policy: object}}
 */
function observedFacts(commandContext, policy) {
  const { graph, owned, analysis } = commandContext;
  const projectOfFile = new Map(owned.map(({ file, project }) => [file, project]));
  return {
    // Tags are read off the graph node, which is where a provider puts them —
    // and a node with no `tags` key IS an untagged project, the same reading
    // `../rules/` already gives it (`projectWithoutTagsCannotHaveDependencies`
    // exists precisely because that state is real), never "tags were not read".
    // `root` is passed through verbatim: a graph that carries none refuses in
    // `buildEvidenceBundle` by name rather than being defaulted to a path.
    projects: Object.entries(graph.nodes).map(([key, node]) => ({
      name: node.name ?? key,
      root: node.data?.root,
      tags: Array.isArray(node.data?.tags) ? node.data.tags : [],
    })),
    edges: Object.values(graph.dependencies ?? {}).flat(),
    imports: analysis.imports.map((site) => ({
      site,
      // `undefined` here is not papered over: `buildEvidenceBundle` refuses an
      // unattributed site by name, which is the loud direction for a state
      // that means the ownership map and the analysis disagree.
      sourceProject: projectOfFile.get(site.sourceFile),
    })),
    policy,
  };
}

/**
 * One rule's verdict, from the verdict document it returned.
 *
 * @param {{name: string, artifact: string, sha256: string, reason: string}} row
 * @param {Record<string, any>} verdict The validated verdict document.
 * @returns {object}
 */
function judgedDecision(row, verdict) {
  const findings = verdict.findings.map((finding) => ({
    id: namespacedId(row.name, finding.id),
    message: finding.message,
    // Every position field is stated only when the rule stated it: a finding
    // about a whole workspace has no file, and writing one in would send a
    // reader to a line the rule never claimed (`../report/sarif.mjs` drops the
    // location block for the same reason).
    ...(finding.sourceFile === undefined ? {} : { sourceFile: finding.sourceFile }),
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.column === undefined ? {} : { column: finding.column }),
    ...(finding.project === undefined ? {} : { project: finding.project }),
  }));
  const evidence = { artifact: row.artifact, sha256: row.sha256, findings: findings.length };
  if (verdict.verdict === "fail") {
    return decisionFor(row, {
      verdict: "fail",
      evidence,
      findings,
      message: `reported ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
    });
  }
  if (verdict.verdict === "unknown") {
    return decisionFor(row, {
      verdict: "unknown",
      evidence,
      findings,
      message: `could not judge this workspace — ${verdict.reason}`,
    });
  }
  if (verdict.verdict === "not_applicable") {
    return decisionFor(row, {
      verdict: "not_applicable",
      evidence,
      findings,
      notApplicableReason: verdict.notApplicableReason,
      message: `did not apply to this workspace — ${verdict.notApplicableReason}`,
    });
  }
  return decisionFor(row, {
    verdict: "pass",
    evidence,
    findings,
    message: "judged this workspace and reported no finding",
  });
}

/**
 * Every declared custom rule, loaded and judged against this run's facts.
 *
 * @param {object} commandContext From `./context.mjs`'s `resolveCommandContext`.
 * @param {{rows: object[], policy: object, scoped?: boolean,
 *   readArtifact?: (artifact: string) => Uint8Array|null, collectEvidence?: boolean,
 *   timeoutMs?: number}} run
 *   `rows` is the validated `customRules` list, `policy` the loaded boundary
 *   policy the `policy` evidence kind is read from, `scoped` set when `paths`
 *   narrowed the run. `readArtifact` is the one seam reaching outside this
 *   process, injectable for the reason every reader in this package is; a
 *   smaller `timeoutMs` lets a test drive the budget without waiting out the
 *   real one. `collectEvidence` keeps each rule's serialized bundle for the
 *   caller — what `../../cli.mjs`'s `--evidence-out` writes out, and off by
 *   default because the bundle is the largest document a run builds.
 * @returns {Promise<{decisions: object[], overall: {verdict: string},
 *   catalogue: {ruleId: string, rule: string, findingId: string, message: string}[],
 *   evidence: {rule: string, bytes: Uint8Array}[]}>}
 *   `catalogue` is every finding each loaded rule DECLARES it can report — the
 *   reportingDescriptor set a SARIF result resolves against — so a rule that
 *   fired nothing is still described rather than nameless. It is empty on a
 *   scoped run, where nothing was loaded. `evidence` is empty unless
 *   `collectEvidence` asked for it, and always empty on a scoped run — the
 *   two states are told apart by the caller, which knows which it asked for.
 * @throws {Error} on any load-class failure, naming the rule and the reason.
 */
export async function customRulesForCheck(
  commandContext,
  {
    rows,
    policy,
    scoped = false,
    readArtifact,
    collectEvidence = false,
    timeoutMs = CUSTOM_RULE_TIMEOUT_MS,
  },
) {
  if (scoped) {
    const decisions = rows.map(scopedDecision);
    // No bundle is built on this path and none is returned: a scoped run's
    // evidence would describe a workspace that does not exist, and handing an
    // author bytes their rule was never judged over is worse than handing
    // them none. `../../cli.mjs`'s `--evidence-out` says so out loud rather
    // than writing an empty directory.
    return { decisions, overall: fitnessVerdictFor(decisions), catalogue: [], evidence: [] };
  }

  const read = readArtifact ?? readArtifactBytes(commandContext.root);

  /** @type {{row: object, module: WebAssembly.Module, describe: Record<string, any>}[]} */
  const loaded = [];
  for (const row of rows) {
    const artifactBytes = read(row.artifact);
    if (artifactBytes === null || artifactBytes === undefined) {
      refuseLoad(
        row.name,
        `the artifact "${row.artifact}" could not be read — a path that does not exist, cannot ` +
          `be opened, or resolves through a symlink out of the workspace all reach this run as ` +
          `no bytes at all, and a declared law with no bytes behind it is a run that refuses ` +
          `rather than a rule that quietly judges nothing`,
      );
    }
    const outcome = await loadCustomRule({
      name: row.name,
      artifactBytes,
      declaredSha256: row.sha256,
      timeoutMs,
    });
    if (!outcome.ok) throw new Error(`archkeep: ${outcome.failure.reason}`);
    loaded.push({ row, module: outcome.module, describe: outcome.describe });
  }

  const catalogue = loaded.flatMap(({ row, describe }) =>
    describe.findings.map((entry) => ({
      ruleId: namespacedId(row.name, entry.id),
      rule: row.name,
      findingId: entry.id,
      message: entry.message,
    })),
  );

  const observed = observedFacts(commandContext, policy);
  /** @type {{rule: string, bytes: Uint8Array}[]} */
  const evidence = [];
  const decisions = [];
  for (const { row, module, describe } of loaded) {
    // `row` is handed to the bundle as the declared row itself — read, never
    // written (`../custom-rules/evidence.mjs`'s `buildEvidenceBundle`), which
    // is what keeps an absent `params` absent on the policy object every later
    // reader sees.
    const evidenceBytes = serializeEvidenceBundle(buildEvidenceBundle({ ...observed, rule: row }));
    // Collected only when a caller asked for it. The bundle is the largest
    // document this run builds — every import site in the tree — and keeping
    // one per rule alive for a run nobody asked to inspect would be memory
    // spent on a debugging aid that was never requested.
    if (collectEvidence) evidence.push({ rule: row.name, bytes: evidenceBytes });
    const outcome = await evaluateCustomRule({ module, describe, evidenceBytes, timeoutMs });
    decisions.push(
      outcome.ok
        ? judgedDecision(row, outcome.verdict)
        : decisionFor(row, {
            verdict: "unknown",
            evidence: { artifact: row.artifact, sha256: row.sha256, findings: 0 },
            // The host's own words, unedited: the reason is self-standing by
            // its contract, and a paraphrase here would be a second account of
            // a failure only the host saw.
            message: outcome.failure.reason,
          }),
    );
  }

  return { decisions, overall: fitnessVerdictFor(decisions), catalogue, evidence };
}

/**
 * The base side's evidence facts, rebuilt from a validated snapshot.
 *
 * The mirror of `observedFacts`, over stored evidence: projects and edges come
 * from the snapshot's `graph` section (already the normalized rows
 * `buildProjects`/`buildDependencies` wrote), imports from the stored records
 * attributed through the stored `owned` map. Attribution is NOT re-derived
 * from root prefixes — ownership is the workspace layer's answer and the base
 * workspace no longer exists to ask, which is exactly why the snapshot stores
 * the map (`./delta-snapshot.mjs`, the optional-blocks section). A record the
 * stored map does not claim keeps `sourceProject: undefined`, and
 * `buildEvidenceBundle` refuses it by name — the caller routes that refusal to
 * an `unknown` rule rather than a silently thinner evidence set.
 *
 * @param {{graph: {projects: object[], dependencies: object[]},
 *   records: object[], owned?: {file: string, project: string}[]}} baseline
 *   A validated snapshot (`parseEvidenceSnapshot`).
 * @param {object} policy The CURRENT loaded boundary policy — both sides are
 *   judged under one law, the same bargain the boundary re-judgment strikes.
 * @returns {{projects: object[], edges: object[], imports: object[], policy: object}}
 */
function baselineFacts(baseline, policy) {
  const projectOfFile = new Map((baseline.owned ?? []).map(({ file, project }) => [file, project]));
  return {
    projects: baseline.graph.projects.map((project) => ({
      name: project.name,
      root: project.root,
      tags: Array.isArray(project.tags) ? project.tags : [],
    })),
    edges: baseline.graph.dependencies,
    imports: baseline.records.map((site) => ({
      site,
      sourceProject: projectOfFile.get(site.sourceFile),
    })),
    policy,
  };
}

/**
 * The reason a declared head row cannot be judged on both sides, or `null`
 * when the baseline row pins the identical law.
 *
 * Digest drift and params drift are the same refusal: the artifact bytes and
 * the declared parameters together ARE the rule's law (params ride inside the
 * evidence bundle), and a finding difference under a law that itself moved
 * cannot be attributed to the code — the same reasoning the policy-fingerprint
 * note states for the boundary side, but per rule and fail-closed to
 * `unknown` because unlike the boundary law the OLD custom law cannot be
 * re-applied: only the head artifact exists to run.
 *
 * @param {{name: string, sha256: string, params?: object}} row Head-declared.
 * @param {{sha256: string, params?: object}|undefined} baseRow The stored row.
 * @returns {string|null}
 */
function unjudgeableRowReason(row, baseRow) {
  if (baseRow === undefined) {
    return (
      "no base-side evidence exists for this rule — the baseline does not declare it, so its " +
      "findings cannot be told apart from pre-existing ones; re-capture the baseline with the " +
      "rule declared"
    );
  }
  if (baseRow.sha256 !== row.sha256) {
    return (
      `the rule's artifact digest changed between capture (${baseRow.sha256}) and head ` +
      `(${row.sha256}) — the law itself moved, so a finding difference cannot be attributed ` +
      `to the code; re-capture the baseline under the current artifact`
    );
  }
  if (canonicalizeJson(baseRow.params ?? null) !== canonicalizeJson(row.params ?? null)) {
    return (
      "the rule's declared params changed between capture and head — params ride inside the " +
      "evidence bundle, so this is law drift exactly as a digest change is; re-capture the " +
      "baseline under the current declaration"
    );
  }
  return null;
}

/**
 * Every custom rule the head policy declares, evaluated over BOTH sides of a
 * delta — the current tree's facts and a baseline snapshot's stored ones —
 * under the current declaration.
 *
 * Fail-closed throughout: every path that cannot produce a two-sided judgment
 * lands the rule in `unknownRules` with a reason a reader can act on, never in
 * `judged` with a thinner answer — with ONE exception, deliberately shared
 * with `customRulesForCheck`: a LOAD-class failure (unreadable artifact, hash
 * mismatch, bytes that are not the contract) THROWS, because the head law
 * could not be read at all and `check` on the same tree would refuse the same
 * way; a delta that soft-reported it would let a permanently unloadable rule
 * ride every delta as one more unknown row.
 *
 * The routes into `unknownRules`, each with its reason:
 * - the baseline carries no custom-rule blocks at all (`baselineAbsentReason`
 *   below rides every rule);
 * - the baseline never declared this rule (added since capture);
 * - digest or params drift (`unjudgeableRowReason`);
 * - either side's evidence bundle refuses to build (an unattributable stored
 *   record, a graph row the bundle cannot read);
 * - either side's evaluation fails, or the rule itself answers `unknown`.
 *
 * A rule that answers `not_applicable` on a side contributes an EMPTY finding
 * list for that side plus a note naming the reason — not applicable is a
 * judged answer, not a failure (`../governance/fitness-rules.mjs` draws the
 * same line).
 *
 * Rules the baseline declares that the head no longer does are returned as
 * `removedRules` — nothing is judged for them (the head declares no law to
 * run), and the caller turns the list into a coverage note.
 *
 * @param {object} commandContext From `./context.mjs`'s `resolveCommandContext`.
 * @param {{rows: object[], policy: object, baseline: object,
 *   readArtifact?: (artifact: string) => Uint8Array|null, timeoutMs?: number}} run
 *   `rows` is the head policy's validated `customRules` list, `policy` the
 *   loaded head policy, `baseline` the validated evidence snapshot.
 * @returns {Promise<{judged: {name: string, sha256: string,
 *   baseFindings: object[], headFindings: object[], notes?: string[]}[],
 *   unknownRules: {name: string, reason: string}[], removedRules: string[],
 *   catalogue: {ruleId: string, rule: string, findingId: string, message: string}[]}>}
 *   `judged` findings are each side's verdict-document findings verbatim
 *   (un-namespaced ids — `./delta-classify.mjs` namespaces per entry).
 * @throws {Error} on any load-class failure, naming the rule and the reason.
 */
export async function customRulesForDelta(
  commandContext,
  { rows, policy, baseline, readArtifact, timeoutMs = CUSTOM_RULE_TIMEOUT_MS },
) {
  /** @type {{name: string, reason: string}[]} */
  const unknownRules = [];
  /** @type {object[]} */
  const judgeableRows = [];
  const baseRows =
    baseline.customRules === undefined
      ? null
      : new Map(baseline.customRules.map((row) => [row.name, row]));

  for (const row of rows) {
    if (baseRows === null) {
      unknownRules.push({
        name: row.name,
        reason:
          "the baseline carries no custom-rule evidence — it was captured before custom rules " +
          "were declared, or by a version that did not store them; re-capture the baseline",
      });
      continue;
    }
    const reason = unjudgeableRowReason(row, baseRows.get(row.name));
    if (reason !== null) {
      unknownRules.push({ name: row.name, reason });
      continue;
    }
    judgeableRows.push(row);
  }

  const removedRules =
    baseRows === null
      ? []
      : baseline.customRules
          .filter((baseRow) => !rows.some((row) => row.name === baseRow.name))
          .map((baseRow) => baseRow.name);

  // The load pass, whole-law-or-refuse, exactly as `customRulesForCheck`:
  // every judgeable rule is loaded before any is evaluated.
  const read = readArtifact ?? readArtifactBytes(commandContext.root);
  /** @type {{row: object, module: WebAssembly.Module, describe: Record<string, any>}[]} */
  const loaded = [];
  for (const row of judgeableRows) {
    const artifactBytes = read(row.artifact);
    if (artifactBytes === null || artifactBytes === undefined) {
      refuseLoad(
        row.name,
        `the artifact "${row.artifact}" could not be read — a path that does not exist, cannot ` +
          `be opened, or resolves through a symlink out of the workspace all reach this run as ` +
          `no bytes at all, and a declared law with no bytes behind it is a run that refuses ` +
          `rather than a rule that quietly judges nothing`,
      );
    }
    const outcome = await loadCustomRule({
      name: row.name,
      artifactBytes,
      declaredSha256: row.sha256,
      timeoutMs,
    });
    if (!outcome.ok) throw new Error(`archkeep: ${outcome.failure.reason}`);
    loaded.push({ row, module: outcome.module, describe: outcome.describe });
  }

  const catalogue = loaded.flatMap(({ row, describe }) =>
    describe.findings.map((entry) => ({
      ruleId: namespacedId(row.name, entry.id),
      rule: row.name,
      findingId: entry.id,
      message: entry.message,
    })),
  );

  const sides = [
    { side: "base", observed: baselineFacts(baseline, policy) },
    { side: "head", observed: observedFacts(commandContext, policy) },
  ];

  /** @type {{name: string, sha256: string, baseFindings: object[], headFindings: object[], notes?: string[]}[]} */
  const judged = [];
  for (const { row, module, describe } of loaded) {
    /** @type {Record<string, object[]>} */
    const findingsBySide = {};
    /** @type {string[]} */
    const notes = [];
    /** @type {string|null} */
    let unknownReason = null;
    for (const { side, observed } of sides) {
      let evidenceBytes;
      try {
        evidenceBytes = serializeEvidenceBundle(buildEvidenceBundle({ ...observed, rule: row }));
      } catch (cause) {
        // Fail-closed on BOTH sides, base and head alike: an evidence set the
        // bundle refuses (an unattributable record above all) is a side this
        // rule cannot honestly judge, and the rule says so rather than being
        // judged over the records that survived.
        unknownReason =
          `the ${side}-side evidence could not be assembled: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`;
        break;
      }
      const outcome = await evaluateCustomRule({ module, describe, evidenceBytes, timeoutMs });
      if (!outcome.ok) {
        unknownReason = `on the ${side} side, ${outcome.failure.reason}`;
        break;
      }
      if (outcome.verdict.verdict === "unknown") {
        unknownReason = `the rule could not judge the ${side} side — ${outcome.verdict.reason}`;
        break;
      }
      if (outcome.verdict.verdict === "not_applicable") {
        notes.push(`${side} side: not applicable — ${outcome.verdict.notApplicableReason}`);
        findingsBySide[side] = [];
        continue;
      }
      findingsBySide[side] = outcome.verdict.findings;
    }
    if (unknownReason !== null) {
      unknownRules.push({ name: row.name, reason: unknownReason });
      continue;
    }
    judged.push({
      name: row.name,
      sha256: row.sha256,
      baseFindings: findingsBySide.base,
      headFindings: findingsBySide.head,
      ...(notes.length === 0 ? {} : { notes }),
    });
  }

  return { judged, unknownRules, removedRules, catalogue };
}

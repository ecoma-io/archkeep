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
 * and three faces cannot come to spell the same finding three ways.
 *
 * @param {string} ruleName
 * @param {string} findingId
 * @returns {string}
 */
function namespacedId(ruleName, findingId) {
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

/**
 * The `evolution` command: the architecture's evolution across a bounded,
 * explicit range of Git revisions, read with everything `history` reads it
 * from — the same engine, the same snapshot identity, the same transition
 * classification — with Git answering one question and only one question:
 * which trees to read.
 *
 * `archkeep evolution --base <rev> [--head <rev>]` resolves both revisions in
 * the workspace's own repository, materializes each selected commit into a
 * temporary detached worktree (`git worktree add --detach` — the caller's
 * working tree is never touched), analyzes every materialized tree through
 * `./context.mjs`'s ordinary pipeline, and classifies the transition between
 * each consecutive pair with `./history.mjs`'s `computeEvolution`. Git names
 * WHERE a change is first observed between two analyzed revisions; Archkeep
 * owns every architecture judgment over those revisions. Nothing here parses
 * diffs, blames lines, or infers intent — a commit message carries no
 * evidence this command can verify, so none is reported.
 *
 * ## What Git is asked, and what it is never asked
 *
 * Asked: which commit a revision names (`rev-parse --verify`), whether base
 * precedes head (`merge-base --is-ancestor`), which single-parent commits lie
 * between them oldest-first (`rev-list --reverse --parents`), and where a
 * disposable copy of each tree can live (`worktree add` / `worktree remove`).
 * Never asked: what a change MEANS. Classification is `computeEvolution`'s —
 * architecture, policy, provider, code drift — decided exactly as
 * `history` decides it, from evidence each revision's own analysis produced.
 *
 * ## The MVP's deliberate narrowness, stated rather than hidden
 *
 * - **Linear ranges only.** Every selected commit must have exactly one
 *   parent; a merge commit inside `base..head` refuses the run loudly, because
 *   flattening a merge would attribute a whole branch's architectural changes
 *   to one commit the reader cannot see behind. There is no `--first-parent`
 *   mode yet: a range ending at a merge, or spanning one, fails rather than
 *   pretending merges are modeled.
 * - **Committed state only.** Every analyzed revision is materialized from a
 *   commit object, so the working tree's uncommitted changes belong to no
 *   analyzed revision — by construction, not by neglect. When the working
 *   tree is dirty, `coverage.notes` says so rather than letting a reader
 *   assume the tip analysis saw their desk.
 * - **Bounded selection.** The command analyzes exactly the commits named by
 *   the range — never a whole repository. Cost is O(selected revisions)
 *   worktrees × one full analysis each; a wide range is slow by construction,
 *   and the merge refusal keeps most branched histories from being selected
 *   accidentally wide.
 *
 * ## What refuses, and why that is the quiet-direction answer
 *
 * Every condition below throws (exit 3 through `../../cli.mjs`) instead of
 * degrading into a shorter or emptier record, because each one would
 * otherwise read as "fewer changes happened":
 *
 * - an unresolved revision, a base that is not head's ancestor, a range whose
 *   ends coincide, a merge inside the range — the selection itself is
 *   unusable, and guessing a smaller one would fabricate history;
 * - a revision that is not a readable workspace, or whose analysis leaves
 *   whole-file failures — the same bar `history --capture` holds (`./history.mjs`),
 *   because an under-represented revision would manufacture architecture
 *   changes out of unread files;
 * - a boundary law a revision NAMES but that will not load — an absent law
 *   and a broken one must not report alike (`./policy.mjs`);
 * - a failed worktree add/remove or any git failure.
 *
 * It is descriptive: it never exits 1. Where the architecture changed is a
 * fact about history, not a finding about the tree.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { isWholeFileFailure } from "../analysis/source-util.mjs";
import { loadIntent, INTENT_FILE } from "../architecture-intent/model.mjs";
import { judgeIntent } from "../architecture-intent/judge.mjs";
import { readAdrContext } from "./adr.mjs";
import { referenceTime } from "../governance/clock.mjs";
import { debtChangeDiff, debtFactId, driftFactOf } from "../governance/debt-ledger.mjs";
import { computeAffectedDecisions } from "../governance/decision-lineage.mjs";
import {
  classifyEvolution,
  edgeEvolutionIdentity,
  eventDedupeKey,
  EVENT_DISPOSITIONS,
  eventId,
  EVOLUTION_EVENT_SCHEMA_VERSION,
} from "../governance/evolution-event.mjs";
import { writeEvent } from "../governance/evolution-store.mjs";
import { recordOrigin } from "../governance/provenance-record.mjs";
import { fitnessForCheck } from "./fitness.mjs";
import { runProcess } from "../process.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatEvolutionReport } from "../report/evolution-text.mjs";
import { buildDependencies, buildProjects, computePolicyFingerprint } from "./graph.mjs";
import { computeEvolution, snapshotIdentity } from "./history.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { resolveDescribedPolicy } from "./policy.mjs";
import { resolveCommandContext, describeWorkspaceRoot } from "./context.mjs";

const require = createRequire(import.meta.url);

/** The tool identity stamped into every emitted event's provenance (delta.mjs's pattern). */
const { version: TOOL_VERSION } = require("../../package.json");

/** A full SHA-1 object name, as `git rev-parse` answers it. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The short form used inside error messages — long enough to stay unambiguous
 * in every repository a human will type into, never part of the JSON output
 * (which carries full SHAs).
 *
 * @param {string} sha
 * @returns {string}
 */
function shortSha(sha) {
  return sha.slice(0, 12);
}

/**
 * Resolves one revision to the full SHA of the commit it names.
 *
 * `^{commit}` peels tags and rejects trees and blobs, so `v1.2.0`, `main`,
 * `HEAD~3`, and a raw SHA all land on the same answer: a commit object. An
 * input beginning with `-` is refused before git sees it — git would read it
 * as its own option, and an option spelled by a caller is an injection seam,
 * not a revision.
 *
 * @param {string} root Absolute path inside the repository (the workspace
 *   root; git resolves the repository upward from there).
 * @param {string} rev The revision the caller asked for.
 * @param {"--base"|"--head"} flag Which flag named it, so the error points at
 *   the spelling that was wrong.
 * @param {{run?: Function}} [io] Injectable spawner (`../process.mjs`).
 * @returns {string} Full hex SHA-1 of the named commit.
 * @throws {Error} when the revision does not name a commit reachable in this
 *   repository — including a repository that is not a git repository at all,
 *   and a shallow clone whose cut-off sits below the requested revision.
 */
export function resolveRevision(root, rev, flag, { run = runProcess } = {}) {
  // used by its own test
  if (typeof rev !== "string" || rev.length === 0) {
    throw new Error(`archkeep: ${flag} needs a revision — a commit, branch, tag, or HEAD~n.`);
  }
  if (rev.startsWith("-")) {
    throw new Error(
      `archkeep: ${flag} '${rev}' starts with '-' and would be read by git as an option, ` +
        `not a revision. Give a commit, branch, or tag name.`,
    );
  }
  let out;
  try {
    // Everything after `--end-of-options` is a revision, whatever it starts
    // with — belt to the braces above.
    out = run("git", ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`], root);
  } catch (cause) {
    throw new Error(
      `archkeep: ${flag} '${rev}' does not name a commit reachable in this repository ` +
        `(resolved from '${root}'). Give a branch, tag, or commit SHA that exists — ` +
        `in a shallow clone, one fetched deep enough to reach it.`,
      { cause },
    );
  }
  const sha = out.trim();
  if (!FULL_SHA.test(sha)) {
    throw new Error(
      `archkeep: ${flag} '${rev}' resolved to '${sha}', which is not a commit SHA — ` +
        `refusing rather than analyze something this tool cannot name.`,
    );
  }
  return sha;
}

/**
 * Resolves and validates the selected range: both endpoints as commits, base
 * an ancestor of head, and every commit between them single-parent.
 *
 * The ordering is `git rev-list --reverse`'s — oldest first, parents before
 * children — with `base` prepended as the first ANALYZED revision, so the
 * first transition is base → the commit that follows it. `--parents` is what
 * makes the merge refusal cheap: the same walk that selects the commits
 * already carries each one's parent count, so no second traversal is needed
 * to refuse a merge.
 *
 * @param {string} root Absolute path inside the repository.
 * @param {{base: string, head: string}} range The raw revisions from the CLI.
 * @param {{run?: Function}} [io] Injectable spawner.
 * @returns {{base: string, head: string, commits: string[]}} Resolved full
 *   SHAs, and every analyzed revision oldest-first — `base` first, `head` last.
 * @throws {Error} on an unresolved revision, coincident endpoints, a base off
 *   head's ancestry, or a merge commit inside the range.
 */
export function selectLinearRange(root, { base, head }, { run = runProcess } = {}) {
  // used by its own test
  const baseSha = resolveRevision(root, base, "--base", { run });
  const headSha = resolveRevision(root, head ?? "HEAD", "--head", { run });

  if (baseSha === headSha) {
    throw new Error(
      `archkeep: --base and --head both resolve to ${baseSha} — the range selects nothing to ` +
        `compare. Give a --base earlier in history than --head.`,
    );
  }

  try {
    run("git", ["merge-base", "--is-ancestor", baseSha, headSha], root);
  } catch {
    throw new Error(
      `archkeep: --base ${shortSha(baseSha)} is not an ancestor of --head ${shortSha(headSha)} — ` +
        `'evolution' describes one linear descent, so the base must lie on head's own history. ` +
        `Choose a --base that --head descends from.`,
    );
  }

  const lines = run("git", ["rev-list", "--reverse", "--parents", `${baseSha}..${headSha}`], root)
    .split("\n")
    .filter((line) => line !== "");
  const commits = [baseSha];
  for (const line of lines) {
    const [sha, ...parents] = line.split(" ");
    if (parents.length > 1) {
      throw new Error(
        `archkeep: ${sha} is a merge commit inside the selected range — this view describes ` +
          `linear history only, and flattening a merge would pin a whole branch's ` +
          `architectural changes on one commit. Select a range whose commits each have ` +
          `one parent.`,
      );
    }
    commits.push(sha);
  }
  return { base: baseSha, head: headSha, commits };
}

/**
 * Analyzes ONE materialized revision through the ordinary pipeline — the same
 * `resolveCommandContext`, the same policy ladder, the same builders, the
 * same identity every captured snapshot carries — and returns the record
 * `computeEvolution` reads.
 *
 * Nothing here knows the record came from Git. Given a directory, it answers
 * exactly what `graph` would answer about that directory; the caller owns
 * which directories exist and what they are named.
 *
 * @param {object} input
 * @param {string} input.sha The commit the worktree was materialized from —
 *   carried into error messages and the returned record, never derived here.
 * @param {string} input.dir Absolute path of the temporary worktree.
 * @param {object} input.seams The `readGraph`/`listFiles` seams threaded from
 *   the CLI env, honored for EVERY analyzed tree a run reads — in production
 *   they are undefined and every tree is read for real.
 * @param {{resolveContext?: Function, resolveProvenance?: Function}} [io]
 * @returns {Promise<{sha: string, id: string, provider: string, provenance: object|null,
 *   projects: object[], dependencies: object[], fingerprint: string|null,
 *   coverage: {projects: number, analyzedFiles: number, imports: number},
 *   evidence?: object|null}>}
 * @throws {Error} when the revision is not a readable workspace, when whole-file
 *   analysis failures leave the record under-represented, or when the law the
 *   revision names will not load.
 */
async function analyzeRevision(input, io = {}) {
  const { sha, dir, seams } = input;
  const resolveContext = io.resolveContext ?? ((cwd) => resolveCommandContext({ cwd }, seams));
  const provenanceResolver = io.resolveProvenance ?? resolveProvenance;

  let context;
  try {
    context = await resolveContext(dir);
  } catch (cause) {
    // The raw refusal names the directory it probed — a temporary worktree
    // path that exists only for this run. Wrap it so the error names the
    // REVISION instead: "some revision was skipped" is the silent direction;
    // "revision X could not be read" is an actionable fact.
    throw new Error(
      `archkeep: revision ${shortSha(sha)} could not be read as a workspace — ` +
        `${cause?.message ?? cause}`,
      { cause },
    );
  }
  const notAnalyzed = context.analysis.failures.filter(isWholeFileFailure);
  if (notAnalyzed.length > 0) {
    const sample = notAnalyzed
      .slice(0, 3)
      .map(({ sourceFile }) => sourceFile)
      .join(", ");
    throw new Error(
      `archkeep: revision ${shortSha(sha)} cannot be analyzed completely — ` +
        `${notAnalyzed.length} file${notAnalyzed.length === 1 ? "" : "s"} produced no verdict ` +
        `(${sample}${notAnalyzed.length > 3 ? ", …" : ""}). Its architecture record would ` +
        `under-represent the real graph, and a transition classified against a partial ` +
        `picture would report changes the unread files may explain. Fix the unanalyzed ` +
        `files at that revision, or select a range that excludes it.`,
    );
  }

  const { config } = await resolveDescribedPolicy({ config: null }, context, dir);
  const fingerprint = config ? computePolicyFingerprint(config) : null;
  const projects = buildProjects(context.graph.nodes);
  const dependencies = buildDependencies(context.graph.dependencies);

  // Wave 3 W7 (design §7): the per-revision comparable evidence for the
  // fitness, debt and decision axes — the only comparable evidence those axes
  // have, because each analyzed revision carries its own graph, law and
  // decision registry. Computed ADDITIVELY and FAIL-SOFT: an axis that cannot
  // be judged (an absent intent, an undeclared fitness block, an unjudgeable
  // law) produces `null` with an in-band reason rather than a fabricated
  // verdict, and never changes the existing `evolution` behavior (a revision
  // that lacks an intent today still analyzes; it must keep doing so).
  const evidence = await revisionEvidence(context, config, dir);

  return {
    sha,
    id: snapshotIdentity({
      projects,
      dependencies,
      policy: fingerprint === null ? null : { fingerprint },
    }),
    provider: context.provider,
    provenance: provenanceResolver(dir),
    projects,
    dependencies,
    fingerprint,
    coverage: {
      projects: projects.length,
      analyzedFiles: context.analysis.analyzed,
      imports: context.analysis.imports.length,
    },
    ...(evidence === null ? {} : { evidence }),
  };
}

/**
 * The per-revision comparable evidence for the fitness, debt and decision
 * axes (design §7): the observed architecture facts each revision's FULL
 * analysis carries — the intent verdict over its own graph, the fitness
 * verdicts its own law declares, and the ADR registry its own tree records.
 * The `evolution` command judges every transition against exactly this
 * evidence, never a second opinion: an axis that cannot be compared is `n/a`
 * with a reason, never zero and never folded into a clean "none" (the wave's
 * invariant, `../governance/evolution-event.mjs`).
 *
 * Fail-soft by contract: every destination here is evidence worth disclosing,
 * not a gate. An absent intent, an undeclared fitness block, or an
 * unjudgeable law returns `null` (with the caller's sense of "could not be
 * compared") instead of throwing, so a revision that lacks the evidence still
 * analyses exactly as it always did.
 *
 * @param {object} context The `resolveCommandContext` record for one revision.
 * @param {object|null} config The revision's resolved boundary law.
 * @param {string} dir The revision's materialized worktree.
 * @returns {Promise<object|null>} The evidence record, or `null` when the
 *   revision supplies nothing to compare (no intent, no fitness, no decision
 *   registry) — the axes then read as incomparable with a reason.
 */
async function revisionEvidence(context, config, dir) {
  /** The intent judgement over this revision's own graph, or null. */
  let intentVerdict = null;
  let intentNote = null;
  try {
    if (context.tracked?.includes(INTENT_FILE)) {
      const intent = await loadIntent(dir, { tracked: context.tracked });
      if (intent !== undefined && intent !== null) {
        intentVerdict = judgeIntent(intent, {
          nodes: context.graph.nodes,
          dependencies: context.graph.dependencies,
        });
      }
    }
  } catch (cause) {
    intentVerdict = null;
    intentNote = `architecture intent could not be judged — ${cause?.message ?? cause}`;
  }

  /** The per-constraint fitness verdicts this revision's law declares, or null. */
  let fitness = null;
  let fitnessNote = null;
  if (config?.fitness !== undefined) {
    try {
      const judged = fitnessForCheck(context, {
        rows: config.fitness,
        intent:
          intentVerdict === null
            ? null
            : {
                verdict:
                  intentVerdict.findings.length > 0
                    ? "findings"
                    : intentVerdict.unresolved.length > 0
                      ? "no-verdict"
                      : "ok",
                boundaries: intentVerdict.boundaries,
                findings: intentVerdict.findings,
                unresolved: intentVerdict.unresolved,
                notes: intentVerdict.notes,
              },
        suppressions: config.suppressions ?? [],
        scoped: false,
      });
      fitness = {
        decisions: judged.decisions,
        overall: judged.overall,
      };
    } catch (cause) {
      fitness = null;
      fitnessNote = `fitness could not be judged — ${cause?.message ?? cause}`;
    }
  }
  /** The ADR registry this revision's own tree records, or null when unreadable. */
  let adrContext;
  let adrNote = null;
  try {
    adrContext = readAdrContext(dir, { tracked: context.tracked });
  } catch (cause) {
    // A malformed registry is a disclosure, not a gate: the decision axis
    // reads as "could not be compared" with the reason, and the revision
    // still analyzes exactly as it always did (the existing `evolution`
    // never read ADR, so this catch is strictly additive).
    adrContext = null;
    adrNote = `ADR registry could not be read — ${cause?.message ?? cause}`;
  }

  const hasAny =
    intentVerdict !== null ||
    fitness !== null ||
    (adrContext !== null && adrContext.records.length > 0);
  if (!hasAny) {
    return null;
  }
  return {
    ...(intentVerdict === null
      ? { intent: { verdict: "no-verdict", note: intentNote ?? "no intent compared" } }
      : { intent: intentVerdict }),
    fitness:
      fitness === null
        ? config?.fitness !== undefined
          ? { verdict: "unknown", note: fitnessNote ?? "fitness could not be judged" }
          : { verdict: "not_applicable", note: "no fitness block declared" }
        : {
            verdict: fitness.overall.verdict,
            decisions: fitness.decisions,
            overall: fitness.overall,
          },
    adr:
      adrContext === null
        ? {
            records: [],
            byId: new Map(),
            knownFitness: new Set(),
            note: adrNote ?? "ADR registry could not be read",
          }
        : adrContext,
  };
}

/**
 * The per-revision comparable evidence two adjacent snapshots both carry, as
 * the facts `classifyEvolution` and the 8-question report read.
 *
 * @typedef {object} TransitionEvidence
 * @property {object} from
 * @property {object} to
 */

/**
 * Whether a per-revision `evidence.intent` is a REAL `judgeIntent` result (and
 * so comparable) rather than the `{verdict: "no-verdict", note}` shape used to
 * disclose an intent that could not be judged. `debtChangeDiff` reads
 * `findings`/`gaps` from it, and the refusal shape carries neither — diffing
 * one would fabricate a clean empty-diff, so it is never treated as verdict
 * evidence.
 *
 * @param {object|undefined} intent The `evidence.intent` value.
 * @returns {boolean}
 */
function isRealIntentVerdict(intent) {
  return (
    intent !== undefined &&
    intent !== null &&
    typeof intent === "object" &&
    Array.isArray(intent.findings)
  );
}

/**
 * The observed architecture-change struct `classifyEvolution` and the report
 * read: the graph diff between two snapshots, plus the carrier-change flags the
 * transition already classified. A transition whose graph did not change
 * (`changes === null`) carries an empty structure — a pure policy or provider
 * carrier change is still disclosed by the flags, never by fabricated diff
 * rows.
 *
 * @param {object} transition A `computeEvolution` transition record.
 * @returns {{architectureChanged: boolean, projects: {added: object[], removed: object[], changed: object[]},
 *   edges: {added: object[], removed: object[]}, policyChanged: boolean|null,
 *   policyOneSided: boolean, providerChanged: boolean, provenanceChanged: boolean|null}}
 */
function transitionObserved(transition) {
  const diff = transition.changes ?? {
    addedProjects: [],
    removedProjects: [],
    changedProjects: [],
    addedEdges: [],
    removedEdges: [],
  };
  return {
    architectureChanged: transition.architectureChanged,
    projects: {
      added: diff.addedProjects ?? [],
      removed: diff.removedProjects ?? [],
      changed: diff.changedProjects ?? [],
    },
    edges: { added: diff.addedEdges ?? [], removed: diff.removedEdges ?? [] },
    policyChanged: transition.policyChanged,
    policyOneSided: transition.policyOneSided,
    providerChanged: transition.providerChanged,
    provenanceChanged: transition.provenanceChanged,
  };
}

/**
 * The stable drift-finding id one intent finding owns — the SAME id the debt
 * ledger derives for the same fact (`debtFactId` over `driftFactOf`), so an
 * event's `findings.introduced`/`findings.resolved` link the W5 ledger.
 *
 * @param {object} finding A `judgeIntent` finding (`{source, target, rule, …}`).
 * @returns {string}
 */
function driftFindingId(finding) {
  return debtFactId("drift", driftFactOf(finding));
}

/**
 * The comparable axis answer when a side's intent could not be judged.
 *
 * @param {object|undefined} baseIntent
 * @param {object|undefined} headIntent
 * @returns {string}
 */
function intentIncomparableReason(baseIntent, headIntent) {
  const sideReason = (side, intent) =>
    side === "base"
      ? `base intent unjudgeable${typeof intent?.note === "string" ? ` — ${intent.note}` : ""}`
      : `head intent unjudgeable${typeof intent?.note === "string" ? ` — ${intent.note}` : ""}`;
  if (!isRealIntentVerdict(baseIntent)) return sideReason("base", baseIntent);
  if (!isRealIntentVerdict(headIntent)) return sideReason("head", headIntent);
  return "intent could not be compared";
}

/**
 * Builds the per-transition 8-question comparison — the comparable evidence
 * for one base→head revision pair (design §7/§8). Every question field EXISTS
 * with either real facts or the `{available: false, reason}` marker; an
 * incomparable axis is NEVER folded into a clean empty result (the invariant:
 * "an empty result is a claim, not a shrug").
 *
 * @param {object} from The base snapshot (`snapshots[i]`, with its `evidence`).
 * @param {object} to The head snapshot (`snapshots[i+1]`, with its `evidence`).
 * @param {object} transition The `evolution.transitions[i]` record.
 * @returns {object} The comparison object for the envelope and report.
 */
function buildTransitionComparison(from, to, transition) {
  const observed = transitionObserved(transition);

  const fromEvidence = from.evidence ?? {};
  const toEvidence = to.evidence ?? {};
  const baseIntent = fromEvidence.intent;
  const headIntent = toEvidence.intent;
  const intentComparable = isRealIntentVerdict(baseIntent) && isRealIntentVerdict(headIntent);

  /** @type {{introduced: string[], resolved: string[], unknown: string[], note?: string}|{available: false, reason: string}} */
  let findings;
  if (intentComparable) {
    const baseDrift = new Set((baseIntent.findings ?? []).map(driftFindingId));
    const headDrift = new Set((headIntent.findings ?? []).map(driftFindingId));
    findings = {
      introduced: [...headDrift].filter((id) => !baseDrift.has(id)).sort(),
      resolved: [...baseDrift].filter((id) => !headDrift.has(id)).sort(),
      unknown: [],
    };
  } else {
    findings = { available: false, reason: intentIncomparableReason(baseIntent, headIntent) };
  }

  /** @type {{introduced: string[], resolved: string[]}|{available: false, reason: string}} */
  let debt;
  if (intentComparable) {
    debt = debtChangeDiff(baseIntent, headIntent);
  } else {
    debt = { available: false, reason: intentIncomparableReason(baseIntent, headIntent) };
  }

  // The drift-finding feed for `classifyEvolution` — supplied ONLY when both
  // intents were actually judged, so a could-not-look is never absorbed into a
  // clean class set. Resolved drift findings feed REPAIR through
  // `driftFindingsResolved`; `debtResolved` carries the same closed-debt fact
  // in the aggregate (drift ids plus gap ids), so a gap closure the per-finding
  // diff cannot see still classifies as REPAIR rather than folding into a clean
  // class set. `violations.resolved` stays out: the debt answer already carries
  // the closed-debt fact.
  const driftComparable = intentComparable;
  const headDriftIds = new Set((headIntent?.findings ?? []).map(driftFindingId));
  const baseDriftIds = new Set((baseIntent?.findings ?? []).map(driftFindingId));
  const violationsIntroduced = driftComparable
    ? [...headDriftIds]
        .filter((id) => !baseDriftIds.has(id))
        .sort()
        .map((id) => ({ id, waived: false }))
    : [];
  const driftFindingsResolved = driftComparable
    ? [...baseDriftIds].filter((id) => !headDriftIds.has(id)).sort()
    : [];

  // Declared constraints: the HEAD-side fitness decisions that carry a
  // verdict classifyEvolution can act on (`pass`/`fail` classify; `unknown`
  // discloses a could-not-determine → no-verdict). `not_applicable` rows are
  // skipped here — a declared-but-matching-nothing function is a report row,
  // not a violation and not an unknown, so it must not force a fabricated
  // no-verdict; it rides only the fitness verdictDeltas.
  const headDecisions = Array.isArray(toEvidence.fitness?.decisions)
    ? toEvidence.fitness.decisions
    : [];
  const declaredConstraints = headDecisions
    .filter((d) => d.verdict === "pass" || d.verdict === "fail" || d.verdict === "unknown")
    .map((d) => ({ id: d.name, verdict: d.verdict }));

  // The ADR registry each side records: `{records}` when the side's registry
  // is readable AND non-empty; `null` when the side records no registry or its
  // registry is unreadable (the note is surfaced into the comparison's notes).
  const adrSide = (side) => {
    const evidence = side === "base" ? fromEvidence : toEvidence;
    const adr = evidence.adr;
    if (
      adr === undefined ||
      adr === null ||
      typeof adr.note === "string" ||
      !Array.isArray(adr.records) ||
      adr.records.length === 0
    ) {
      return null;
    }
    return { records: adr.records };
  };
  const adrBase = adrSide("base");
  const adrHead = adrSide("head");

  const directionNotes = [];
  const adrNote = (side) => {
    const adr = (side === "base" ? fromEvidence : toEvidence).adr;
    return typeof adr?.note === "string" ? adr.note : null;
  };
  const baseAdrNote = adrNote("base");
  const headAdrNote = adrNote("head");
  if (baseAdrNote !== null) {
    directionNotes.push(`base decision registry unreadable — ${baseAdrNote}`);
  }
  if (headAdrNote !== null) {
    directionNotes.push(`head decision registry unreadable — ${headAdrNote}`);
  }

  const fitnessComparable =
    Array.isArray(fromEvidence.fitness?.decisions) && Array.isArray(toEvidence.fitness?.decisions);

  /** @type {{verdictDeltas: object[]}|{available: false, reason: string}} */
  let fitness;
  if (fitnessComparable) {
    const names = new Set([
      ...fromEvidence.fitness.decisions.map((d) => d.name),
      ...toEvidence.fitness.decisions.map((d) => d.name),
    ]);
    const verdictDelta = (side, name) => {
      const decisions = (side === "base" ? fromEvidence : toEvidence).fitness.decisions;
      const found = decisions.find((d) => d.name === name);
      if (found !== undefined) return found.verdict;
      return {
        available: false,
        reason: `not declared/judged at ${side}`,
      };
    };
    fitness = {
      verdictDeltas: [...names].sort().map((name) => ({
        id: name,
        base: verdictDelta("base", name),
        head: verdictDelta("head", name),
      })),
    };
  } else {
    const baseFitness = fromEvidence.fitness;
    const headFitness = toEvidence.fitness;
    let reason;
    if (baseFitness?.verdict === "not_applicable") {
      reason = "no fitness block declared at base";
    } else if (headFitness?.verdict === "not_applicable") {
      reason = "no fitness block declared at head";
    } else if (!Array.isArray(baseFitness?.decisions)) {
      reason = `base fitness unjudgeable${typeof baseFitness?.note === "string" ? ` — ${baseFitness.note}` : ""}`;
    } else {
      reason = `head fitness unjudgeable${typeof headFitness?.note === "string" ? ` — ${headFitness.note}` : ""}`;
    }
    fitness = { available: false, reason };
  }

  const coverageAnswer = {
    base: {
      projects: from.coverage?.projects ?? 0,
      analyzedFiles: from.coverage?.analyzedFiles ?? 0,
      imports: from.coverage?.imports ?? 0,
    },
    head: {
      projects: to.coverage?.projects ?? 0,
      analyzedFiles: to.coverage?.analyzedFiles ?? 0,
      imports: to.coverage?.imports ?? 0,
    },
  };

  /* F-EVO-4: when intent exists on only one side (or a side is a refusal
   * object rather than a real verdict), the pair is NOT fully comparable and
   * its disposition must never read `accepted`. `classifyEvolution` only
   * reaches that conclusion through `verdictRelevantUnknown`, so we feed it
   * an unknown entry — unless BOTH sides carry no intent evidence at all
   * (base and head both `no-verdict` refusals), which is the status-quo
   * baseline W8 pins as `DRIFT`/`accepted`. */
  const bothAbsent = !isRealIntentVerdict(baseIntent) && !isRealIntentVerdict(headIntent);
  const classification = classifyEvolution({
    observed,
    codeDrift: transition.codeDrift === true,
    ...(driftComparable
      ? {
          violations: { introduced: violationsIntroduced },
          driftFindingsResolved,
          debtResolved: "resolved" in debt ? debt.resolved : [],
        }
      : {}),
    ...(!driftComparable && !bothAbsent
      ? {
          violations: {
            unknown: [{ id: "intent", reason: intentIncomparableReason(baseIntent, headIntent) }],
          },
        }
      : {}),
    ...(declaredConstraints.length > 0 ? { declaredConstraints } : {}),
    adrBase,
    adrHead,
  });

  // The richer affected-decisions lineage: which ADR each head-side fitness
  // id binds to, resolved against the head registry. `classifyEvolution`
  // owns the DECISION_CHANGE predicate (`classification.affected.decisions`);
  // this reuses the shared resolver for the per-id binding detail.
  let affectedLineage;
  const headAdr = toEvidence.adr;
  const headRegistry =
    headAdr !== undefined &&
    headAdr !== null &&
    typeof headAdr.note !== "string" &&
    headAdr.byId instanceof Map
      ? { records: headAdr.records, byId: headAdr.byId }
      : null;
  if (headRegistry !== null) {
    affectedLineage = computeAffectedDecisions(
      headRegistry,
      headDecisions.map((d) => ({ id: d.name, verdict: d.verdict })),
      [],
    );
  }

  const notes = [...classification.notes, ...transition.notes, ...directionNotes];
  const affected = {
    ...classification.affected,
    ...(affectedLineage !== undefined ? { lineage: affectedLineage.lineage } : {}),
  };

  return {
    observed,
    findings,
    debt,
    fitness,
    coverage: coverageAnswer,
    ...(classification.classifications.length > 0
      ? { classifications: classification.classifications }
      : { classifications: [] }),
    disposition: classification.disposition,
    affected,
    notes: [...new Set(notes)],
  };
}

/**
 * Assembles the transition EvolutionEvent for one revision pair (design §3/§4)
 * — the record `writeEvent` persists when `--event-out` is set. The event's
 * identity (`id`/`dedupeKey`) derives from `{base, head}` alone, so only the
 * full SHA + snapshot id ride in those two fields: a re-run over the same
 * pair is byte-identical and the store proves idempotency. Wall-clock-bound
 * fields (`recordedAt`) are carried but never key the event, mirroring
 * delta.mjs's assembly.
 *
 * @param {object} from The base snapshot.
 * @param {object} to The head snapshot.
 * @param {object} transition The `evolution.transitions[i]` record.
 * @param {object} comparison The comparison object for this pair.
 * @returns {object} The event, minus `dedupeKey`/`id` (the caller sets those
 *   before `writeEvent`).
 */
function buildTransitionEvent(from, to, transition, comparison) {
  const provenance = [];
  if (typeof from.provenance?.commit === "string") {
    provenance.push({ kind: "git-commit", ref: from.provenance.commit });
  }
  if (typeof to.provenance?.commit === "string") {
    provenance.push({ kind: "git-commit", ref: to.provenance.commit });
  }
  return {
    schemaVersion: EVOLUTION_EVENT_SCHEMA_VERSION,
    kind: "transition",
    source: "evolution",
    base: { revision: from.sha, snapshot: from.id },
    head: { revision: to.sha, snapshot: to.id },
    recordedAt: recordOrigin({
      by: "evolution",
      tool: `archkeep:v${TOOL_VERSION}`,
      clock: { now: referenceTime },
    }),
    observed: comparison.observed,
    affected: comparison.affected,
    findings: comparison.findings,
    fitness: comparison.fitness,
    debt: comparison.debt,
    classifications: comparison.classifications,
    disposition: comparison.disposition,
    notes: comparison.notes,
    provenance,
  };
}

/**
 * Aggregates every transition comparison into one `result.summary` (design
 * §8). The disposition is the worst across transitions; classifications and
 * affected identities are unique sorted unions. An axis is unioned across
 * transitions ONLY when every transition is comparable — an incomparable
 * axis at any transition is surfaced as `{available: false, reason}` naming
 * the transition index, never folded into a fabricated clean aggregate.
 *
 * The disposition loop latches the event vocabulary: a comparison whose
 * disposition is unknown or absent THROWS naming it — the `?? 1` it replaced
 * defaulted a stranger to rank 1, accepted's own rank, so a garbled
 * disposition could never be the summary's worst. Production dispositions
 * arrive validated (`classifyEvolution`, `readEvents`), so the throw fires
 * only where archkeep itself is buggy — the same latch `deltaDisposition`
 * holds.
 *
 * @param {object[]} comparisons The per-transition comparison objects.
 * @returns {object} The summary.
 * @throws {Error} On a comparison whose `disposition` is outside
 *   `EVENT_DISPOSITIONS`, naming the value.
 */
export function buildEvolutionSummary(comparisons) {
  const dispositionRank = { accepted: 1, rejected: 2, "no-verdict": 3 };
  let disposition = "accepted";
  for (const comparison of comparisons) {
    if (!EVENT_DISPOSITIONS.includes(comparison.disposition)) {
      throw new Error(
        `the evolution summary folds dispositions by rank, and ${JSON.stringify(
          comparison.disposition,
        )} is not one of [${EVENT_DISPOSITIONS.join(", ")}] — an unknown disposition would ` +
          `default to rank 1, accepted's own rank, and could never be the summary's worst. ` +
          `This is a bug in archkeep, not a fact about the workspace.`,
      );
    }
    if (dispositionRank[comparison.disposition] > dispositionRank[disposition]) {
      disposition = comparison.disposition;
    }
  }

  const unique = (items) => [...new Set(items)].sort();
  const unionAxis = (axis) => {
    // `{available: false}` markers propagate: the summary of an incomparable
    // axis is itself incomparable, never a union that hides the gap.
    const markerIndex = comparisons.findIndex(
      (c) => c[axis] !== undefined && c[axis].available === false,
    );
    if (markerIndex !== -1) {
      return {
        available: false,
        reason: `transition ${markerIndex} not comparable: ${comparisons[markerIndex][axis].reason}`,
      };
    }
    const collect = (field) =>
      unique(comparisons.flatMap((c) => (c[axis] !== undefined ? (c[axis][field] ?? []) : [])));
    if (axis === "fitness") {
      // Fitness aggregates on verdictDeltas: one delta per fitness id across
      // the whole range. The id's summary base/head are the range's first base
      // and last head ONLY when the id carries a real verdict on both sides of
      // EVERY transition that declares it — a transition that never judges the
      // id (or carries an incomparable marker) must surface as a marker naming
      // the first broken transition, never as a fabricated pass→pass.
      const ids = unique(
        comparisons.flatMap((c) => (c.fitness.verdictDeltas ?? []).map((d) => d.id)),
      );
      const verdictDeltas = ids.map((id) => {
        const deltas = comparisons.flatMap((c) =>
          (c.fitness.verdictDeltas ?? [])
            .filter((d) => d.id === id)
            .map((d) => ({ delta: d, index: comparisons.indexOf(c) })),
        );
        // The first transition that declares the id without a real verdict on
        // both sides names the break; an id never declared is its own marker.
        const broken = deltas.find(
          ({ delta }) =>
            delta.base === undefined ||
            delta.base === null ||
            typeof delta.base !== "string" ||
            delta.head === undefined ||
            delta.head === null ||
            typeof delta.head !== "string",
        );
        if (broken !== undefined) {
          return {
            id,
            base: {
              available: false,
              reason: `not declared/judged at transition ${broken.index}`,
            },
            head: {
              available: false,
              reason: `not declared/judged at transition ${broken.index}`,
            },
          };
        }
        if (deltas.length === 0) {
          return {
            id,
            base: { available: false, reason: "never comparable at base" },
            head: { available: false, reason: "never comparable at head" },
          };
        }
        return {
          id,
          base: deltas[0].delta.base,
          head: deltas[deltas.length - 1].delta.head,
        };
      });
      return { verdictDeltas };
    }
    return {
      introduced: collect("introduced"),
      resolved: collect("resolved"),
      ...(axis === "findings" ? { unknown: collect("unknown") } : {}),
    };
  };

  const findings = unionAxis("findings");
  const debt = unionAxis("debt");
  const fitness = unionAxis("fitness");

  const observed = {
    architectureChanged: comparisons.filter((c) => c.observed.architectureChanged === true).length,
    projects: {
      added: unique(comparisons.flatMap((c) => c.observed.projects.added.map((p) => p.name ?? p))),
      removed: unique(
        comparisons.flatMap((c) => c.observed.projects.removed.map((p) => p.name ?? p)),
      ),
      changed: unique(
        comparisons.flatMap((c) => c.observed.projects.changed.map((p) => p.name ?? p)),
      ),
    },
    // The identity string is the ONE spelling `edgeEvolutionIdentity` owns —
    // the same spelling `affected.boundaries` and every stored event carry.
    // An edge without a complete triple has no identity to name, so it is
    // dropped from the union and counted into `unnamedEdges` rather than
    // leaking an object serialization into a field of identity strings.
    edges: {
      added: unique(
        comparisons.flatMap((c) =>
          c.observed.edges.added
            .filter((e) => e.source && e.target && e.type)
            .map((e) => edgeEvolutionIdentity(e)),
        ),
      ),
      removed: unique(
        comparisons.flatMap((c) =>
          c.observed.edges.removed
            .filter((e) => e.source && e.target && e.type)
            .map((e) => edgeEvolutionIdentity(e)),
        ),
      ),
    },
    // F-EVO-3: a transition whose policy change could not be compared reads
    // as a count of how many changed, never a number that hides the axis was
    // unjudgeable at one point — surface it as a marker naming the transition.
    policyChanged: (() => {
      const unjudgeable = comparisons.findIndex((c) => c.observed.policyChanged === null);
      if (unjudgeable !== -1) {
        return {
          available: false,
          reason: `policy could not be compared at transition ${unjudgeable}`,
        };
      }
      return comparisons.filter((c) => c.observed.policyChanged === true).length;
    })(),
    providerChanged: comparisons.filter((c) => c.observed.providerChanged === true).length,
  };

  const affected = {
    projects: unique(comparisons.flatMap((c) => c.affected?.projects ?? [])),
    boundaries: unique(comparisons.flatMap((c) => c.affected?.boundaries ?? [])),
    constraints: unique(comparisons.flatMap((c) => c.affected?.constraints ?? [])),
    decisions: unique(comparisons.flatMap((c) => c.affected?.decisions ?? [])),
  };

  const notes = unique(comparisons.flatMap((c) => c.notes ?? []));
  const unnamedEdges = comparisons.reduce(
    (count, c) =>
      count +
      [...c.observed.edges.added, ...c.observed.edges.removed].filter(
        (e) => !(e.source && e.target && e.type),
      ).length,
    0,
  );
  if (unnamedEdges > 0) {
    // The house shape for "we could not name it": a note naming the gap,
    // never a silent drop dressed as a clean union.
    notes.push(
      `${unnamedEdges} changed edge(s) carry no complete identity and are not named in observed.edges`,
    );
  }
  return {
    transitions: comparisons.length,
    disposition,
    classifications: unique(comparisons.flatMap((c) => c.classifications ?? [])),
    observed,
    affected,
    findings,
    debt,
    fitness,
    notes,
  };
}

/**
 * Removes one worktree: git's own unregister first (so the repository's
 * worktree metadata stays truthful), then the bytes. Both are needed — git's
 * remove alone leaves nothing behind but fails if the directory already went,
 * and deleting the directory alone would strand `.git/worktrees` entries.
 *
 * @param {string} root Repository-scoped directory the git calls run in.
 * @param {string} dir The worktree to release.
 * @param {{run?: Function}} [io]
 */
function releaseWorktree(root, dir, { run = runProcess } = {}) {
  let removeError = null;
  try {
    run("git", ["worktree", "remove", "--force", dir], root);
  } catch (cause) {
    removeError = cause;
  }
  rmSync(dir, { recursive: true, force: true });
  if (removeError !== null) {
    throw new Error(
      `archkeep: releasing the temporary worktree '${dir}' failed — ` +
        `${removeError?.message ?? removeError}`,
      { cause: removeError },
    );
  }
}

/**
 * Runs the `evolution` command.
 *
 * @param {string} root Absolute path to the workspace root the command was
 *   invoked from — the envelope header describes THIS tree, and every git
 *   question is answered in it; the analyzed revisions are materialized
 *   elsewhere.
 * @param {{base: string, head?: string|null, eventOut?: string|null}} range The raw
 *   revisions. `eventOut` an optional directory; when set, one EvolutionEvent is
 *   written per revision pair (idempotent, design §3/§4).
 * @param {{run?: Function, makeTempRoot?: Function, resolveContext?: Function,
 *   resolveProvenance?: Function, readGraph?: Function, listFiles?: Function}} [io]
 *   Injectable seams. `makeTempRoot` defaults to a fresh `mkdtemp` directory
 *   under the OS temp dir; `readGraph`/`listFiles` thread into every analyzed
 *   revision's context the way `../../cli.mjs` threads them into one.
 * @returns {Promise<{status: "ok", result: {base: string, head: string,
 *   revisions: object[], transitions: object[], summary: object}, coverage: object,
 *   report: {text: string, json: string}}>}
 * @throws {Error} on every condition listed in this module's header — an
 *   unusable selection, an unanalyzable revision, a failed worktree, a git
 *   failure — never a shorter record for any of them.
 */
export async function evolutionCommand(root, { base, head = null, eventOut = null }, io = {}) {
  const run = io.run ?? runProcess;
  const identity = describeWorkspaceRoot(root);
  const provenanceResolver = io.resolveProvenance ?? resolveProvenance;

  const selection = selectLinearRange(root, { base, head }, { run });

  const makeTempRoot =
    io.makeTempRoot ?? (() => mkdtempSync(join(tmpdir(), "archkeep-evolution-")));
  const parent = makeTempRoot();
  const seams = {};
  if (io.readGraph !== undefined) seams.readGraph = io.readGraph;
  if (io.listFiles !== undefined) seams.listFiles = io.listFiles;

  const snapshots = [];
  /** Worktrees still standing — emptied as each is released successfully. */
  const standing = [];
  try {
    for (const [index, sha] of selection.commits.entries()) {
      const dir = join(parent, `${index}-${sha.slice(0, 12)}`);
      run("git", ["worktree", "add", "--quiet", "--detach", dir, sha], root);
      standing.push(dir);
      const snapshot = await analyzeRevision({ sha, dir, seams }, io);
      releaseWorktree(root, dir, { run });
      standing.pop();
      snapshots.push(snapshot);
    }
  } finally {
    // A revision whose analysis threw leaves its worktree here; release it
    // WITHOUT letting a cleanup failure mask the original error — the bytes go
    // either way when the parent directory goes, and the original failure is
    // the one that explains the exit. On the success path this list is empty.
    for (const dir of standing) {
      try {
        releaseWorktree(root, dir, { run });
      } catch {
        // The parent-directory removal below still removes the bytes; a stale
        // worktree-admin entry is pruned next line, and masking the error that
        // is already propagating would hide why the run failed.
      }
    }
    rmSync(parent, { recursive: true, force: true });
    try {
      run("git", ["worktree", "prune"], root);
    } catch {
      // Cosmetic-only after the bytes are gone: prune clears leftover admin
      // entries. Failing here must not overwrite a real verdict.
    }
  }

  const evolution = computeEvolution(
    snapshots.map((snapshot) => ({
      // The record's "name" is the full commit SHA: the transition's from/to
      // identity IS the revision, and a full SHA never abbreviates differently
      // as the repository grows.
      name: snapshot.sha,
      path: null,
      envelope: {
        coverage: {
          complete: true,
          projects: snapshot.coverage.projects,
          analyzedFiles: snapshot.coverage.analyzedFiles,
          imports: snapshot.coverage.imports,
        },
        result: {
          projects: snapshot.projects,
          dependencies: snapshot.dependencies,
          ...(snapshot.fingerprint === null
            ? {}
            : { policy: { fingerprint: snapshot.fingerprint } }),
        },
        workspace: { provider: snapshot.provider, provenance: snapshot.provenance },
      },
      id: snapshot.id,
    })),
  );

  // Wave 3 W7 (design §7/§8): per-transition comparable evidence (the
  // 8-question comparison) plus, when `--event-out` is set, one transition
  // EvolutionEvent per revision pair — idempotent, keyed on byte-stable
  // base/head revisions.
  const comparisons = [];
  for (let index = 0; index < evolution.transitions.length; index++) {
    const transition = /** @type {object} */ (evolution.transitions[index]);
    const comparison = buildTransitionComparison(
      snapshots[index],
      snapshots[index + 1],
      transition,
    );
    transition.comparison = comparison;
    comparisons.push(comparison);

    if (eventOut) {
      const event = buildTransitionEvent(
        snapshots[index],
        snapshots[index + 1],
        transition,
        comparison,
      );
      event.dedupeKey = eventDedupeKey(event);
      event.id = eventId(event);
      const write = writeEvent(eventOut, event, { root });
      transition.eventWrite = {
        dir: eventOut,
        id: write.id,
        duplicate: write.duplicate,
      };
    }
  }

  const summary = buildEvolutionSummary(comparisons);

  const headSnapshot = snapshots[snapshots.length - 1];
  const userProvenance = provenanceResolver(root);
  const notes = [
    "each change is attributed to the first analyzed revision where it is observed — a fact " +
      "about where history shows it, not about why it was made",
    "rule-impact cannot be recomputed across revisions — each analyzed revision carries its " +
      "graph and policy fingerprint, not import sites judged under a law. Run 'check' at a " +
      "revision for its boundary verdict.",
  ];
  if (userProvenance?.dirty === true) {
    notes.push(
      "the working tree has uncommitted changes; they belong to no analyzed revision — every " +
        "analyzed revision was materialized from committed state",
    );
  }
  const coverage = {
    complete: true,
    projects: headSnapshot.coverage.projects,
    analyzedFiles: headSnapshot.coverage.analyzedFiles,
    imports: headSnapshot.coverage.imports,
    notAnalyzed: [],
    blindSpots: [],
    notes,
  };

  const result = {
    base: selection.base,
    head: selection.head,
    // Wave 3 W7 (design §7): each revision also carries its comparable
    // evidence — the intent verdict over its own graph, the fitness verdicts
    // its own law judges, and the ADR registry its own tree records — so a
    // trend report can name its basis per revision. Additive: `{commit, id}`
    // are unchanged, and a revision that supplied nothing to compare omits
    // the key entirely (an absent `evidence` reads as incomparable).
    revisions: snapshots.map(({ sha, id, evidence }) => ({
      commit: sha,
      id,
      ...(evidence == null ? {} : { evidence }),
    })),
    transitions: evolution.transitions,
    summary,
  };

  const envelope = jsonEnvelope({
    command: "evolution",
    context: {
      root,
      provider: identity.provider,
      marker: identity.marker,
      provenance: userProvenance,
    },
    status: "ok",
    exitCode: 0,
    coverage,
    result,
  });

  return {
    status: "ok",
    result,
    coverage,
    report: {
      text: formatEvolutionReport({ result, coverage }),
      json: renderJson(envelope),
    },
  };
}

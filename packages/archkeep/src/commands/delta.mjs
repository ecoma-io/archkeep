/**
 * The `delta` command: two evidence sets — a captured baseline and the current
 * tree — re-judged under ONE boundary config and ONE shared reference instant,
 * then classified `introduced` | `resolved` | `unchanged` | `unknown`.
 *
 * Two modes, one module:
 *
 * - **capture** (`captureDelta`) — run at a base checkout, writes the evidence
 *   snapshot `./delta-snapshot.mjs` defines: raw import-site records, the
 *   graph they were collected against, coverage, provenance, and the policy
 *   fingerprint. Evidence, never verdicts — the header of that module owns
 *   the argument.
 * - **compare** (`deltaCommand`) — run at head, loads the baseline and
 *   re-judges BOTH sides through `../rules/index.mjs`'s engine under the
 *   CURRENT config, so a policy edit between capture and now cannot fabricate
 *   an introduced/resolved pair; only the code can move a classification
 *   (`./delta-classify.mjs`).
 *
 * Unlike `diff` — which compares two GRAPH snapshots edge by edge and never
 * exits 1 — `delta` is a gate: a non-waived introduced violation is a finding
 * (exit 1), which is the whole point of carrying re-judgeable evidence rather
 * than a graph. That made `delta` the third verb whose verdict carries
 * exit 1, beside `check` and `fitness`; `./change.mjs` later became the
 * fourth, over a different question — declared intent versus observed delta.
 *
 * Refusals — a delta that could not honestly classify must never read as
 * "no change". Incomplete CURRENT coverage on the compare side returns the
 * structured no-verdict envelope `./coverage-verdict.mjs` builds (#608) —
 * status "no-verdict", exit 3, a `coverage` block naming every file and site
 * the run could not judge — where a parser and `--output` can read it; the
 * rest are throws, exit 3 upstream:
 * - a baseline that cannot be read, parsed, or holds a foreign schemaVersion
 *   (`./delta-snapshot.mjs`'s loader owns those);
 * - a provider mismatch between baseline and this run (`providerMismatch`) —
 *   a THROW here where `diff` settles for a note, because violation IDENTITY
 *   across two different project models is not trustworthy: the same tree
 *   attributed to different projects would classify a rename as an
 *   introduced/resolved pair the code does not contain;
 * - incomplete coverage on the CAPTURE side (`refuseUnjudgeableHead`), where
 *   there is no envelope to withhold — a baseline write has no verdict;
 * - an Nx workspace with polyglot manifests but no plugin registration — the
 *   same silently-under-representing graph `graph`/`diff` refuse.
 *
 * What is deliberately NOT a refusal: a policy-fingerprint mismatch between
 * baseline and current. Both sides are re-judged under the current law — that
 * is the design's point — so the mismatch becomes a loud coverage note
 * instead. Dirty base provenance and a dirty head are notes too: weaker
 * evidence, not unreadable evidence.
 *
 * (wave 3, additive) Each compare run maps its own capture output into the
 * canonical evolution event (`../governance/evolution-event.mjs`, design §1):
 * a `kind: "transition"`, `source: "delta"` record whose classifications come
 * from the ONE predicate home `classifyEvolution` (through
 * `./delta-classify.mjs`'s `classifyDeltaEvolution`), whose observed/findings/
 * fitness facts are mapped — never re-derived — from the structural signal,
 * the policy comparison and the violation classification this run already
 * computed, and whose disposition is a function of the delta's own verb
 * (`deltaDisposition`). The event rides the result envelope as the additive
 * `classifications`/`affected` fields, and `--event-out <dir>` (owned by
 * `../../cli.mjs`) additionally appends the record to the event store
 * (`../governance/evolution-store.mjs`). Absent the flag, no file is written
 * and nothing else about the run changes byte-for-byte.
 *
 * This module computes and returns; `../../cli.mjs`'s `runDelta` owns argv,
 * output destination and the process exit code (`./README.md`).
 */
import { createRequire } from "node:module";

import {
  blindSpotRows,
  isWholeFileFailure,
  unresolvableLiteralCount,
} from "../analysis/source-util.mjs";
import { stripTrailingSlashes } from "../path-util.mjs";
import { referenceTime } from "../governance/clock.mjs";
import {
  assertReproducibleEventIdentity,
  eventDedupeKey,
  eventId,
  EVOLUTION_EVENT_SCHEMA_VERSION,
} from "../governance/evolution-event.mjs";
import { writeEvent } from "../governance/evolution-store.mjs";
import { recordOrigin } from "../governance/provenance-record.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { buildDecision } from "../report/evidence.mjs";
import { formatDeltaReport } from "../report/delta-text.mjs";
import { formatDeltaSarif } from "../report/sarif.mjs";
import { evaluateRun } from "../rules/index.mjs";
import { judgeIntent } from "../architecture-intent/judge.mjs";
import { INTENT_FILE, loadIntent } from "../architecture-intent/model.mjs";
import { debtChangeDiff } from "../governance/debt-ledger.mjs";
import { customRulesForDelta, declaresCustomRules } from "./custom-rules.mjs";
import {
  classifyCustomFindings,
  classifyDelta,
  classifyDeltaEvolution,
  deltaFindings,
  deltaVerdictDeltas,
  edgeEvolutionIdentity,
} from "./delta-classify.mjs";
import {
  buildEvidenceSnapshot,
  providerMismatch,
  readEvidenceSnapshot,
  serializeEvidenceSnapshot,
} from "./delta-snapshot.mjs";
import { computeDiff } from "./diff.mjs";
import { buildDependencies, buildProjects, computePolicyFingerprint } from "./graph.mjs";
import { coverageRefusal, coverageVerdict } from "./coverage-verdict.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { compareSnapshotMetadata } from "./snapshot-meta.mjs";

const require = createRequire(import.meta.url);
/** @type {{name: string, version: string}} */
const { name: TOOL_NAME, version: TOOL_VERSION } = require("../../package.json");

/**
 * Refuses the unregistered-plugin head state no delta side may be built over:
 * on an Nx workspace whose `nx.json` does not register this plugin but whose
 * tracked files include polyglot manifests under project roots.
 *
 * Exported since `change` arrived because that command builds its comparison
 * over the same head state — a graph that under-represents the tree would
 * reconcile a declaration against architecture nobody observed — and a second
 * copy of the refusal is where the two commands would drift into answering
 * "may this head be judged?" differently.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {string} activity Which mode is refusing, for the message.
 * @throws {Error} on the unregistered-plugin graph.
 */
export function refusePluginGapHead(commandContext, activity) {
  const { provider, pluginGap } = commandContext;
  if (provider === "nx" && !pluginGap.registered && pluginGap.manifests.length > 0) {
    throw new Error(
      `archkeep: refusing to ${activity} for an Nx workspace where this plugin is not ` +
        `registered but polyglot manifests exist under project roots ` +
        `(${pluginGap.manifests.join(", ")}). The graph would carry no polyglot edges, so the ` +
        `evidence would silently under-represent the real architecture. Register the plugin in ` +
        `nx.json: "plugins": [{ "plugin": "@ecoma-io/archkeep/nx" }], or remove the polyglot ` +
        `manifests if they are not in use.`,
    );
  }
}

/**
 * Refuses, as a throw, the two head states no delta side may be built over:
 * the unregistered-plugin graph (`refusePluginGapHead`) and incomplete
 * analysis coverage.
 *
 * The coverage half stayed a throw through #602's unification of the
 * graph-family refusal, and it stays one here — but only for the CAPTURE
 * side: `captureDelta` writes a baseline, and a write that cannot be honest
 * has no verdict to withhold, so stderr is the only face it has. The compare
 * side (`deltaCommand`, `changeCommand`) refuses coverage through
 * `./coverage-verdict.mjs`'s structured envelope (#608) instead and calls only
 * `refusePluginGapHead`, so a withheld verdict reaches a parser and
 * `--output` in-band.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {string} activity Which mode is refusing, for the message.
 * @throws {Error} on either condition.
 */
export function refuseUnjudgeableHead(commandContext, activity) {
  // used by its own test
  refusePluginGapHead(commandContext, activity);
  const notAnalyzed = commandContext.analysis.failures.filter(isWholeFileFailure);

  const blindSpotCount = unresolvableLiteralCount(commandContext.analysis.failures);
  if (notAnalyzed.length > 0 || blindSpotCount > 0) {
    throw new Error(
      `archkeep: cannot ${activity} — ` +
        [
          notAnalyzed.length > 0
            ? `${notAnalyzed.length} file${notAnalyzed.length === 1 ? "" : "s"} could not be analyzed`
            : null,
          blindSpotCount > 0
            ? `${blindSpotCount} import site${blindSpotCount === 1 ? "" : "s"} could not be resolved`
            : null,
        ]
          .filter(Boolean)
          .join(", ") +
        `, so the evidence would ` +
        `miss violations living there and a later classification would misread the gap as a ` +
        `code change. Fix the unanalyzed files and re-run.`,
    );
  }
}

/**
 * Captures the current tree as a delta baseline: the evidence snapshot
 * serialized, ready for a future `delta <base.json>` run to consume.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{config: object|null}} io The resolved boundary config — required,
 *   because the snapshot's policy fingerprint is what lets a later run say
 *   loudly that the law moved.
 * @returns {{snapshot: object, text: string}}
 * @throws {Error} on an unjudgeable head (above) or a run with no boundary
 *   law — a baseline with no policy identity could never disclose a law
 *   change, which is the silent direction.
 */
export function captureDelta(commandContext, { config }) {
  refuseUnjudgeableHead(commandContext, "capture a delta baseline");
  if (!config) {
    throw new Error(
      "archkeep: cannot capture a delta baseline without a boundary config — the snapshot " +
        "records the policy fingerprint so a later delta run can say loudly when the law moved, " +
        "and a workspace that resolves no law leaves that claim unmakeable.",
    );
  }
  const { root, provider, graph, analysis } = commandContext;
  const snapshot = buildEvidenceSnapshot({
    // The two optional custom-rule blocks, stored exactly when the capturing
    // policy declares rules — an undeclaring workspace's snapshot stays
    // byte-identical (`./delta-snapshot.mjs`, the optional-blocks section).
    ...(declaresCustomRules(config)
      ? { customRules: config.customRules, owned: commandContext.owned }
      : {}),
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    provenance: resolveProvenance(root),
    provider,
    policyFingerprint: computePolicyFingerprint(config),
    coverage: {
      // `refuseUnjudgeableHead` already threw on any whole-file failure, so
      // the capture-side claim is honestly complete.
      complete: true,
      analyzedFiles: analysis.analyzed,
      notAnalyzed: [],
      blindSpots: blindSpotRows(analysis.failures),
    },
    graph,
    records: analysis.imports,
  });
  return { snapshot, text: serializeEvidenceSnapshot(snapshot) };
}

/**
 * Rebuilds an engine-consumable `ProjectGraph` from a snapshot's stored graph.
 *
 * The snapshot stores what `graph --format json` publishes — a `projects`
 * ARRAY and a flat `dependencies` array — while `../rules/index.mjs`'s
 * `evaluate()` consumes Nx's shape: a `nodes` MAP keyed by name (each with
 * `type` and `data.{root, tags, targets?}`) plus a source-keyed `dependencies`
 * map. The conversion is exact where the snapshot kept the fact:
 *
 * - `name`/`root`/`type`/`tags` map straight back onto `data`;
 * - the three rule-relevant extras the snapshot re-attached (`mfeRemote`,
 *   `entryPoints`, `declaredPackages`) go back onto `data` only when present —
 *   absence stays absence, because `evaluate()` treats an absent field as
 *   "declares none" and inventing an empty value would be a second copy of
 *   that answer (`./delta-snapshot.mjs`);
 * - `targets` was stored as the NAMES alone, so each becomes `{}` in the
 *   rebuilt `data.targets` map. That preserves both reads the engine makes of
 *   it — `Object.keys` in the buildTargets guard, and
 *   `../rules/topology.mjs`'s `hasBuildExecutor`, whose
 *   `targets[t].executor !== ""` is true for `{}` — so a declared target
 *   stays a declared target; the executor STRING itself is the one fact the
 *   snapshot never held;
 * - `workspaceLayout` and `exemptedFiles` ride the graph object exactly as
 *   the provider carried them, because `createContext` reads both off it.
 *
 * Every project name gets a `dependencies` entry — an empty array for a
 * project with no outgoing edge — matching the shape every provider emits.
 *
 * A mis-shaped rebuild here is the silent direction in miniature: a base
 * graph the engine reads as empty yields zero base violations, which
 * classifies every standing violation as freshly introduced (loud but wrong)
 * or — with the sides swapped — masks base violations entirely. The test
 * beside this module holds the non-empty base-side re-judgment.
 *
 * @param {{projects: object[], dependencies: {source: string, target: string,
 *   type: string}[], workspaceLayout?: object, exemptedFiles?: string[]}} storedGraph
 *   A validated snapshot's `graph` section (`parseEvidenceSnapshot`).
 * @returns {object} A graph `evaluate()` consumes.
 * @throws {Error} when an `exemptedFiles` entry is not a string — the engine's
 *   own filter would drop it in silence (the refusal beside the copy below).
 */
export function evidenceGraphToProjectGraph(storedGraph) {
  /** @type {Record<string, object>} */
  const nodes = {};
  /** @type {Record<string, object[]>} */
  const dependencies = {};
  for (const project of storedGraph.projects) {
    /** @type {Record<string, unknown>} */
    const data = { root: project.root, tags: project.tags ?? [] };
    if (Array.isArray(project.targets)) {
      data.targets = Object.fromEntries(project.targets.map((target) => [target, {}]));
    }
    if (project.mfeRemote !== undefined) data.mfeRemote = project.mfeRemote;
    if (Array.isArray(project.entryPoints)) data.entryPoints = project.entryPoints;
    if (Array.isArray(project.declaredPackages)) data.declaredPackages = project.declaredPackages;
    nodes[project.name] = { name: project.name, type: project.type, data };
    dependencies[project.name] = [];
  }
  for (const edge of storedGraph.dependencies) {
    if (!Array.isArray(dependencies[edge.source])) dependencies[edge.source] = [];
    dependencies[edge.source].push({ source: edge.source, target: edge.target, type: edge.type });
  }
  /** @type {Record<string, unknown>} */
  const graph = { nodes, dependencies };
  if (storedGraph.workspaceLayout !== undefined)
    graph.workspaceLayout = storedGraph.workspaceLayout;
  if (Array.isArray(storedGraph.exemptedFiles)) {
    // An entry that is not a string is refused here rather than carried:
    // `../rules/index.mjs`'s `createContext` filters `graph.exemptedFiles`
    // with `typeof file === "string"`, so a corrupted snapshot's entry would
    // ride through this conversion and vanish there — the exemption set the
    // snapshot recorded silently shrinking by one file, the under-count
    // disclosed nowhere.
    const malformed = storedGraph.exemptedFiles
      .map((entry, at) => ({ entry, at }))
      .filter(({ entry }) => typeof entry !== "string");
    if (malformed.length > 0) {
      const { entry, at } = malformed[0];
      throw new Error(
        `archkeep: the snapshot's graph.exemptedFiles[${at}] is ${JSON.stringify(entry)}, ` +
          `not a string — the rule engine drops such entries in silence, which would shrink ` +
          `the exemption set the snapshot recorded; re-capture the baseline or correct the file`,
      );
    }
    graph.exemptedFiles = storedGraph.exemptedFiles;
  }
  return graph;
}

/**
 * A longest-root-prefix attributor for `classifyUnresolvableRecords`: the
 * record's file is matched against project roots, head's first (the current
 * model is the one both sides are judged under), then any baseline root the
 * head does not already claim — so a base-side record living in a directory
 * the head no longer has still attributes to the project that owned it.
 *
 * Exported for `./change.mjs`, which classifies the same two evidence sets
 * through `./delta-classify.mjs` and must attribute unresolvable records the
 * same way a delta does — a second attribution rule beside this one is how
 * the two commands would disagree about which project carried a site.
 *
 * @param {object} headGraph The current run's graph (`nodes` map).
 * @param {object[]} baselineProjects The snapshot's stored project rows.
 * @returns {(record: object) => string|null}
 */
export function sourceProjectAttributor(headGraph, baselineProjects) {
  /** @type {Map<string, string>} root → project name, head winning ties. */
  const byRoot = new Map();
  for (const node of Object.values(headGraph.nodes ?? {})) {
    const root = typeof node?.data?.root === "string" ? node.data.root : null;
    if (root !== null && !byRoot.has(root)) byRoot.set(root, node.name);
  }
  for (const project of baselineProjects) {
    if (typeof project.root === "string" && !byRoot.has(project.root)) {
      byRoot.set(project.root, project.name);
    }
  }
  const entries = [...byRoot.entries()]
    .map(([root, name]) => [stripTrailingSlashes(root), name])
    .sort((a, b) => b[0].length - a[0].length);
  return (record) => {
    const file = record?.sourceFile;
    if (typeof file !== "string") return null;
    for (const [root, name] of entries) {
      if (root === "" || root === "." || file === root || file.startsWith(`${root}/`)) {
        return /** @type {string} */ (name);
      }
    }
    return null;
  };
}

/**
 * The delta event's disposition, mapped from the delta's OWN verb contract —
 * the status `deltaCommand` already folds — so the event's evaluative stance
 * is a function of the run consumers already know, never a second opinion:
 *
 * - `no-verdict` status (any unclassifiable item — violation, unresolvable
 *   record, or custom finding) ⇒ `no-verdict`, never a fabricated
 *   accepted/rejected;
 * - `findings` status ⇒ `rejected`, unconditionally — `findings` means some
 *   introduced gating finding survived the current waiver table, WHATEVER
 *   class it carries. The classifications are deliberately NOT consulted:
 *   a custom-rule-only introduced finding never reaches the VIOLATION
 *   predicate, so a classifications scan would read "accepted" on an exit-1
 *   run — the silent direction;
 * - everything else — a clean comparable capture (`ok`, `[]` classifications),
 *   an `ok` capture with a fact class (REPAIR, CHANGE, DRIFT,
 *   DECISION_CHANGE — each accepted by the vocabulary `classification` earns),
 *   or an `ok` capture holding a WAIVED violation (a waiver is a tracked
 *   acceptance — which is exactly what kept the gate `ok`) ⇒ `accepted`.
 *
 * The two refusals that can never reach this mapping — an unjudgeable head
 * and a provider mismatch — THROW before any event exists, so a delta that
 * could not be computed has no record at all, never a record with a guessed
 * disposition.
 *
 * @param {{status: "ok"|"findings"|"no-verdict"}} input
 * @returns {"accepted"|"rejected"|"no-verdict"}
 */
export function deltaDisposition({ status }) {
  // used by its own test
  if (status === "no-verdict") return "no-verdict";
  if (status === "findings") return "rejected";
  return "accepted";
}

/** First eight hex characters of a fingerprint, for prose that names one. */
const short = (fingerprint) =>
  typeof fingerprint === "string" ? fingerprint.slice(0, 8) : String(fingerprint);

/**
 * Runs the `delta` compare mode: loads the baseline, re-judges both sides
 * under the current law and one shared instant, classifies, and folds the
 * classification into the verdict.
 *
 * The exit fold — the whole point of the command:
 * - any `introduced` violation NOT covered by the current waiver table →
 *   `findings` (exit 1);
 * - else any `unknown` entry, in either the violations or the unresolvable
 *   buckets → `no-verdict` (exit 3): an item the classifier could not place
 *   is a question this run could not answer, never a clean delta;
 * - else `ok` (exit 0). Waived-introduced entries are REPORTED — waiving is
 *   a tracked acceptance, not a fix — but do not fail the gate, which is what
 *   a waiver is for.
 *
 * Custom-rule (wasm) findings join the classification when either side
 * declares them: `./custom-rules.mjs`'s `customRulesForDelta` judges every
 * head-declared rule over both evidence sets, `./delta-classify.mjs`'s
 * `classifyCustomFindings` buckets the findings, and the result rides the
 * envelope as `result.customRules` — a block that is ABSENT (never `null`)
 * when neither side declares any, so an undeclaring workspace's envelope
 * stays byte-identical. An introduced custom finding gates exactly as an
 * introduced violation does, with no waiver lane by construction
 * (suppressions key on a `messageId` custom findings do not have); an
 * unclassifiable one is a no-verdict. This is also why the function is async:
 * the wasm host is.
 * @param {string} baselinePath Absolute path to the evidence snapshot.
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{config: object|null, readBaseline?: (path: string) => object,
 *   now?: string, eventOut?: string|null,
 *   loadIntentOverride?: (root: string, opts?: object) => Promise<object|undefined>,
 *   readArtifact?: (artifact: string) => Uint8Array|null,
 *   timeoutMs?: number}} io The resolved boundary config (required
 *   — both sides are re-judged under it), an injectable baseline reader, the
 *   one shared reference instant (defaults to the shared governance clock),
 *   `eventOut` — the directory an evolution event is appended to when given
 *   (absent or `null` ⇒ no event file, byte-identical behavior),
 *   `loadIntentOverride` — the architecture-intent reader the event's `debt`
 *   sub-ledger judges over this run's base and head graphs (defaults to
 *   `loadIntent`; absent intent ⇒ no ids, an in-band note says so), and the
 *   custom-rule host's two injectable seams, passed through to
 *   `customRulesForDelta`.
 * @returns {Promise<{status: "ok"|"findings"|"no-verdict", delta?: object,
 *   coverage: object,
 *   eventWrite?: {id: string, duplicate: boolean}|null,
 *   report: {text: string, json: string, sarif?: string}}>} `delta` carries
 *   the additive `classifications`/`affected` fields (design §1); `eventWrite`
 *   is `null` unless `eventOut` was given, then the store's answer for the
 *   event that was (or already was) recorded. `status: "no-verdict"` from the
 *   coverage refusal (#608) carries neither `delta` nor `eventWrite` — the
 *   comparison was withheld before any event work, and the envelope's
 *   `coverage` block plus its `decision.reason` are the whole answer; the
 *   report then has no `sarif` face (there are no findings to render).
 * @throws {Error} on every refusal the module header lists, and on a
 *   custom-rule LOAD failure (`./custom-rules.mjs` argues the split).
 *   Incomplete head coverage returns the structured no-verdict envelope
 *   instead of throwing (#608); the unregistered-plugin graph keeps its throw.
 */
export async function deltaCommand(
  baselinePath,
  commandContext,
  {
    config,
    readBaseline = readEvidenceSnapshot,
    now = referenceTime(),
    eventOut = null,
    loadIntentOverride,
    ...customRuleIo
  },
) {
  const { root, provider, marker, graph, analysis, tracked } = commandContext;

  // The plugin-gap refusal stays a throw; the coverage refusal returns the one
  // structured envelope `./coverage-verdict.mjs` builds (#608): a verdict
  // withheld because the run could not read the tree belongs in-band, where a
  // parser and `--output` can read it — the same contract the graph family has
  // run since #602. The capture side keeps the throw (`refuseUnjudgeableHead`
  // above), because a baseline write has no envelope to withhold.
  refusePluginGapHead(commandContext, "compute a delta");
  const completeness = coverageVerdict(commandContext);
  if (!completeness.complete) {
    return coverageRefusal({
      command: "delta",
      commandContext,
      what: "computing a delta",
      decision: true,
    });
  }
  if (!config) {
    throw new Error(
      "archkeep: cannot compute a delta without a boundary config — both sides are re-judged " +
        "under the current law, and a run that resolves no law has nothing to judge either side " +
        "against.",
    );
  }

  const baseline = readBaseline(baselinePath);

  // Provider mismatch is a REFUSAL here, deliberately stricter than `diff`'s
  // note: `diff` describes structural difference, where a provider artefact is
  // a caveat; `delta` asserts violation identity across the two sides, and an
  // identity computed over two different project models is not evidence.
  const mismatch = providerMismatch(baseline.provider, provider);
  if (mismatch !== null) {
    throw new Error(
      `archkeep: refusing to compute a delta — ${mismatch}. Re-capture the baseline under ` +
        `this run's provider.`,
    );
  }

  const baseGraph = evidenceGraphToProjectGraph(baseline.graph);
  const configWithNow = { ...config, now };
  // Both sides RAW (pre-suppression), through the same walk `waivers` reads:
  // suppression must annotate the classification, never shrink either side —
  // a suppressed-then-regressed violation has to stay visible
  // (`./delta-classify.mjs`).
  const baseViolations = evaluateRun(baseline.records, baseGraph, configWithNow).rawViolations;
  const headViolations = evaluateRun(analysis.imports, graph, configWithNow).rawViolations;

  const classification = classifyDelta({
    baseViolations,
    headViolations,
    baseRecords: baseline.records,
    headRecords: analysis.imports,
    suppressions: config.suppressions ?? [],
    now,
    sourceProjectOf: sourceProjectAttributor(graph, baseline.graph.projects),
  });

  const headProvenance = resolveProvenance(root);
  const headFingerprint = computePolicyFingerprint(config);
  const meta = compareSnapshotMetadata({
    baselineProvider: baseline.provider,
    headProvider: provider,
    baselineProvenance: baseline.provenance,
    headProvenance,
    baselineFingerprint: baseline.policyFingerprint,
    headFingerprint,
  });

  const notes = [];
  if (meta.policyChanged === true) {
    notes.push(
      `the boundary law changed since capture (baseline ${short(baseline.policyFingerprint)}…, ` +
        `current ${short(headFingerprint)}…) — classifications reflect the current law applied ` +
        `to both sides, so a violation a policy edit created or retired classifies as unchanged, ` +
        `not as introduced or resolved`,
    );
  }
  if (meta.crossRepo) {
    notes.push(
      `baseline provenance remote (${baseline.provenance.remote}) differs from head provenance ` +
        `remote (${headProvenance?.remote}) — the delta may be across unrelated repositories ` +
        `rather than two revisions of the same one`,
    );
  } else if (meta.provenanceOneSided) {
    const side = baseline.provenance ? "head" : "baseline";
    notes.push(
      `the ${side} carries no provenance — the delta cannot verify it compares two revisions ` +
        `of the same repository`,
    );
  }
  if (meta.dirtyBaseline) {
    notes.push(
      "the baseline was captured from a dirty working tree — its evidence is not a reproducible " +
        "claim about the commit it names",
    );
  }
  if (meta.dirtyHead) {
    notes.push(
      "this run's working tree is dirty — the head side describes uncommitted state, not the " +
        "commit HEAD names",
    );
  }

  // The event's structural signal: what moved between the two graphs the
  // delta already holds, computed through `computeDiff` — the ONE shared
  // structural vocabulary (`./diff.mjs`, shared with `trajectory`) — so a
  // project or edge added/removed/changed is a fact about the evidence, never
  // a second spelling of "changed". The head side is rebuilt by the same
  // `buildProjects`/`buildDependencies` the snapshot stores
  // (`./delta-snapshot.mjs`), which is what makes the two sides comparable.
  const structuralDiff = computeDiff(baseline.graph, {
    projects: buildProjects(graph.nodes),
    dependencies: buildDependencies(graph.dependencies),
  });
  const structural = {
    projects: {
      added: structuralDiff.addedProjects.map((project) => project.name),
      removed: structuralDiff.removedProjects.map((project) => project.name),
      changed: structuralDiff.changedProjects.map((project) => project.name),
    },
    edges: {
      added: structuralDiff.addedEdges.map(edgeEvolutionIdentity),
      removed: structuralDiff.removedEdges.map(edgeEvolutionIdentity),
    },
  };
  const structureChanged =
    structural.projects.added.length +
      structural.projects.removed.length +
      structural.projects.changed.length +
      structural.edges.added.length +
      structural.edges.removed.length >
    0;
  // The delta's `codeDrift` signal (design §2): provenance advanced — both
  // sides carry commits, they differ, and neither side was captured dirty (a
  // dirty tree is weaker evidence, not a claim about the commit it names) —
  // the architecture did not move, and the policy was comparable AND
  // unchanged. `policyChanged === null` (one-sided) never reads as "the
  // same", and a policy change is disclosed, not folded into drift.
  const baseCommit = baseline.provenance?.commit;
  const headCommit = headProvenance?.commit;
  const provenanceAdvanced =
    typeof baseCommit === "string" &&
    typeof headCommit === "string" &&
    baseCommit !== headCommit &&
    baseline.provenance?.dirty !== true &&
    headProvenance?.dirty !== true &&
    meta.crossRepo !== true &&
    meta.provenanceOneSided !== true;
  const codeDrift = provenanceAdvanced && !structureChanged && meta.policyChanged === false;

  // The custom-rule half, present exactly when a side declares rules: judged
  // two-sided where the law is identical, `unknown` with a mandatory reason
  // everywhere else (`./custom-rules.mjs`'s `customRulesForDelta` owns the
  // routes). `null` when NEITHER side declares any — the envelope block and
  // the summary key are then absent, and an undeclaring workspace's envelope
  // stays byte-identical (`../../../../AGENTS.md`, "a change to what is
  // reported on an unchanged workspace is a breaking change").
  /** @type {{judged: object[], skipped: object[], removed: string[],
   *   findings: {introduced: object[], resolved: object[], unchanged: object[],
   *   unknown: object[]}}|null} */
  let custom = null;
  // The head-declared finding catalogue, held for the SARIF face alone: the
  // envelope deliberately does not carry it (the JSON contract predates the
  // SARIF face and must stay byte-identical), while `sarifRules` needs it so
  // an introduced custom finding's `ruleId` resolves to a descriptor.
  /** @type {{ruleId: string, rule: string, findingId: string, message: string}[]} */
  let customCatalogue = [];
  if (declaresCustomRules(config)) {
    const twoSided = await customRulesForDelta(commandContext, {
      rows: config.customRules,
      policy: config,
      baseline,
      ...customRuleIo,
    });
    customCatalogue = twoSided.catalogue;
    custom = {
      judged: twoSided.judged.map(({ name, sha256, notes: ruleNotes }) => ({
        name,
        sha256,
        ...(ruleNotes === undefined ? {} : { notes: ruleNotes }),
      })),
      skipped: twoSided.unknownRules,
      removed: twoSided.removedRules,
      findings: classifyCustomFindings({
        judged: twoSided.judged,
        unknownRules: twoSided.unknownRules,
      }),
    };
  } else if (baseline.customRules !== undefined) {
    // The head declares nothing, so there is no law to judge either side
    // under — every baseline rule is a removal, disclosed rather than judged.
    custom = {
      judged: [],
      skipped: [],
      removed: baseline.customRules.map((row) => row.name),
      findings: { introduced: [], resolved: [], unchanged: [], unknown: [] },
    };
  }
  if (custom !== null) {
    for (const skipped of custom.skipped) {
      notes.push(`custom rule "${skipped.name}" was not classified — ${skipped.reason}`);
    }
    for (const name of custom.removed) {
      notes.push(
        `custom rule "${name}" is declared in the baseline but not by the current policy — ` +
          `nothing was judged for it, so its base-side findings are not classified as resolved`,
      );
    }
    for (const rule of custom.judged) {
      for (const note of rule.notes ?? []) {
        notes.push(`custom rule "${rule.name}": ${note}`);
      }
    }
  }

  // The §1 mapping: the delta's own signals through `classifyEvolution` — one
  // definition (`./delta-classify.mjs`'s `classifyDeltaEvolution` maps, never
  // re-decides a class). The result's additive `classifications`/`affected`
  // ride the envelope, and the same classification feeds the event when
  // `eventOut` is given.
  const deltaPayload = {
    violations: classification.violations,
    unresolvable: classification.unresolvable,
    policyChanged: meta.policyChanged,
    // The one-sided/advanced facts ride the payload (never the event's
    // `observed`, which is the stored record): classifyEvolution needs them
    // as input facts — `policyOneSided` is never derived from `policyChanged
    // === null`, because both-sides-absent is also `null` (F-HIST-1).
    policyOneSided: meta.policyOneSided,
    provenanceChanged: meta.provenanceChanged,
    ...(custom === null ? {} : { customRules: custom }),
  };
  const evolution = classifyDeltaEvolution(deltaPayload, {
    projects: structural.projects,
    // The raw triples, not `structural.edges` (the mapped identity strings):
    // `classifyEvolution` owns the spelling and takes the triples. The
    // envelope's `structural` and the event's `observed` keep the mapped
    // strings this run derived above — one mapping per command, and the
    // classification's `affected.boundaries` comes out under the same
    // spelling because it is mapped inside `classifyEvolution` itself.
    edges: { added: structuralDiff.addedEdges, removed: structuralDiff.removedEdges },
    codeDrift,
  });

  const { violations, unresolvable } = classification;
  const introducedWaived = violations.introduced.filter((entry) => entry.waived === true).length;
  const introducedNotWaived = violations.introduced.length - introducedWaived;
  // Custom findings have no waiver lane (`./delta-classify.mjs`'s
  // `classifyCustomFindings` argues the by-construction absence), so every
  // introduced one gates.
  const customIntroduced = custom === null ? 0 : custom.findings.introduced.length;
  const customUnknown = custom === null ? 0 : custom.findings.unknown.length;
  const unknownCount = violations.unknown.length + unresolvable.unknown.length + customUnknown;

  /** @type {"ok"|"findings"|"no-verdict"} */
  let status;
  /** @type {0|1|3} */
  let exitCode;
  let decision;
  if (introducedNotWaived + customIntroduced > 0) {
    status = "findings";
    exitCode = 1;
    decision = buildDecision({
      status,
      coverageComplete: true,
      findings: introducedNotWaived + customIntroduced,
    });
  } else if (unknownCount > 0) {
    status = "no-verdict";
    exitCode = 3;
    decision = buildDecision({
      status,
      coverageComplete: true,
      findings: 0,
      reason:
        `${unknownCount} delta item${unknownCount === 1 ? "" : "s"} could not be classified — ` +
        (customUnknown > 0
          ? `${customUnknown} of them custom-rule item${customUnknown === 1 ? "" : "s"} — `
          : "") +
        `an item whose identity cannot be stated is never guessed into a bucket`,
    });
  } else {
    status = "ok";
    exitCode = 0;
    decision = buildDecision({ status, coverageComplete: true, findings: 0 });
  }

  const coverage = {
    complete: true,
    projects: Object.keys(graph.nodes).length,
    analyzedFiles: analysis.analyzed,
    imports: analysis.imports.length,
    notAnalyzed: [],
    blindSpots: blindSpotRows(analysis.failures),
    notes,
  };

  const result = {
    baseline: {
      path: baselinePath,
      tool: baseline.tool,
      provider: baseline.provider,
      provenance: baseline.provenance,
      policyFingerprint: baseline.policyFingerprint,
      records: baseline.records.length,
      projects: baseline.graph.projects.length,
    },
    head: {
      provenance: headProvenance,
      policyFingerprint: headFingerprint,
      records: analysis.imports.length,
      projects: Object.keys(graph.nodes).length,
    },
    policyChanged: meta.policyChanged,
    summary: {
      introduced: violations.introduced.length,
      introducedWaived,
      resolved: violations.resolved.length,
      unchanged: violations.unchanged.length,
      unknown: violations.unknown.length,
      unresolvable: {
        introduced: unresolvable.introduced.length,
        resolved: unresolvable.resolved.length,
        unchanged: unresolvable.unchanged.length,
        unknown: unresolvable.unknown.length,
      },
      ...(custom === null
        ? {}
        : {
            customFindings: {
              introduced: custom.findings.introduced.length,
              resolved: custom.findings.resolved.length,
              unchanged: custom.findings.unchanged.length,
              unknown: custom.findings.unknown.length,
            },
          }),
    },
    violations,
    unresolvable,
    classifications: evolution.classifications,
    affected: evolution.affected,
    ...(custom === null ? {} : { customRules: custom }),
  };

  // The evolution event (design §1), built by mapping — never re-deriving —
  // the capture output the run already holds: `observed`/`affected`/
  // `findings`/`fitness` come from the structural signal, the §1 mapping, and
  // the classification above; `classifications` come from the same mapping;
  // the disposition is a function of the delta's own verb through
  // `deltaDisposition`. `recordedAt` carries the SAME injected reference
  // instant the run judged waivers at — one clock, one transition. Written
  // only when `eventOut` is given: absent ⇒ no file, byte-identical behavior.
  /** @type {{id: string, duplicate: boolean}|null} */
  let eventWrite = null;
  if (eventOut !== null && eventOut !== undefined) {
    // F-delta-event-id: an evolution event is only written from a reproducible
    // identity — a committed, clean head and a clean base, by the shared law
    // `assertReproducibleEventIdentity` owns. The wording is frozen there; the
    // messages consumers match on are byte-identical to the inline refusals
    // this call replaces.
    assertReproducibleEventIdentity({
      label: "delta",
      headCommit,
      baseDirty: baseline.provenance?.dirty === true,
      headDirty: headProvenance?.dirty === true,
    });
    // The architecture-debt sub-ledger (design §8): judged by re-running the
    // current intent over this run's base and head graphs — a drift finding
    // present at head but not base is introduced; one gone is resolved. Both
    // ENGINE graphs exist here (the base from the captured snapshot, the head
    // from the live capture), so unlike `change` there is no unproven-base
    // gate; the fail-closed branches are an absent intent and an unjudgeable
    // one, each emitting no ids and an in-band note rather than a fabricated
    // clean ledger.
    /** @type {{introduced: string[], resolved: string[], note?: string}} */
    let debt;
    try {
      const archIntent = await (loadIntentOverride ?? loadIntent)(root, { tracked });
      if (archIntent === undefined || archIntent === null) {
        debt = {
          introduced: [],
          resolved: [],
          note: `no '${INTENT_FILE}' tracked — the delta event carries no architecture debt ids`,
        };
      } else {
        const baseVerdict = judgeIntent(archIntent, baseGraph);
        const headVerdict = judgeIntent(archIntent, graph);
        debt = debtChangeDiff(baseVerdict, headVerdict);
      }
    } catch (error) {
      debt = {
        introduced: [],
        resolved: [],
        note: `architecture intent could not be judged — no debt ids emitted (${error.message})`,
      };
    }
    const event = {
      schemaVersion: EVOLUTION_EVENT_SCHEMA_VERSION,
      kind: "transition",
      source: "delta",
      base: {
        ...(typeof baseCommit === "string" ? { revision: baseCommit } : {}),
        // The evidence ref is the baseline file this run actually compared
        // against — a pointer into the evidence, never a graph.
        evidence: baselinePath,
      },
      head: typeof headCommit === "string" ? { revision: headCommit } : {},
      recordedAt: recordOrigin({
        by: "cli",
        tool: `archkeep:v${TOOL_VERSION}`,
        clock: { now: () => now },
      }),
      observed: {
        architectureChanged: structureChanged,
        projects: structural.projects,
        edges: structural.edges,
        policyChanged: meta.policyChanged,
        // A delta that completed is a delta whose provider matched — the
        // mismatch refusal above throws before any event could exist.
        providerChanged: false,
      },
      affected: evolution.affected,
      findings: deltaFindings(deltaPayload),
      fitness: { verdictDeltas: deltaVerdictDeltas(deltaPayload) },
      debt,
      classifications: evolution.classifications,
      disposition: deltaDisposition({ status }),
      notes: [...notes, ...evolution.notes],
      provenance: [
        ...(typeof baseCommit === "string" ? [{ kind: "git-commit", ref: baseCommit }] : []),
        ...(typeof headCommit === "string" ? [{ kind: "git-commit", ref: headCommit }] : []),
      ],
    };
    event.dedupeKey = eventDedupeKey(event);
    event.id = eventId(event);
    eventWrite = writeEvent(eventOut, event, { root });
  }

  const envelope = jsonEnvelope({
    command: "delta",
    context: { root, provider, marker, provenance: headProvenance },
    status,
    exitCode,
    coverage,
    result,
    decision,
  });

  return {
    status,
    eventWrite,
    delta: result,
    coverage,
    report: {
      text: formatDeltaReport({ delta: result, coverage }),
      json: renderJson(envelope),
      // Eager beside the other two faces: the render is pure and cheap, and a
      // lazy face is one a caller can forget to build — the SARIF is the same
      // verdict, ready whichever face `--format` selects.
      sarif: formatDeltaSarif({ delta: result, coverage, customCatalogue }),
    },
  };
}

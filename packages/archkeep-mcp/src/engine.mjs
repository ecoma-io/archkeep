/**
 * The adapters: one function per MCP tool, each composing the engine's own
 * command functions from `@ecoma-io/archkeep/commands` — in-process, the same
 * functions `cli.mjs` drives, never a spawned CLI and never a second
 * implementation of any decision they make.
 *
 * This module imports nothing from the MCP SDK. What it returns is data;
 * `./server.mjs` is what turns data into a tool result. The split is the one
 * `../../archkeep/lsp.mjs` makes with `src/lsp/`: adapters that hold decisions
 * are testable without a protocol, and the protocol layer holds no decision of
 * its own.
 *
 * ## The result contract, stated once for all eight
 *
 * Every completed call returns the engine's versioned JSON envelope — the same
 * object `archkeep <command> --format json` renders, parsed from the bytes the
 * command itself built (`docs/reference/json-output.md` owns its fields), so an
 * agent learns ONE schema from both faces and the two cannot disagree. A tool
 * may add keys BESIDE the envelope's own (never inside `result`, never
 * replacing one); those additions are named in each adapter below. A call the
 * engine refused does not fabricate an envelope: `archkeep_check` states its
 * could-not-run as a structured `unknown` verdict, and every other tool
 * surfaces the refusal as the tool error it is, message verbatim — the CLI's
 * exit 3 and the MCP error are the same fact wearing two transports.
 *
 * ## The seams, threaded the way the CLI threads them
 *
 * `readGraph` and `listFiles` are injectable on every adapter, the same seams
 * `check`/`resolveCommandContext` already accept, so a test drives the real
 * analysis, rules and reports over a fixture tree with neither Nx nor git
 * present. `workspaceRoot` defaults to the process's working directory, the
 * same default the CLI's `cwd` carries — a server started in a workspace root
 * needs to name nothing.
 *
 * ## No policy override, anywhere
 *
 * None of the adapters accepts a boundary-config override. The CLI's
 * `--config` exists for a human reviewing a law against a tree; a capability
 * face answers for the law IN EFFECT, and an agent that could substitute a
 * weaker law for its own verification would hold a green nobody promised
 * (`skills/arch-check`'s "never substitute one law for another"). Every
 * adapter resolves the workspace's own law through the same ladder the CLI
 * resolves it through.
 */
import { isAbsolute, resolve } from "node:path";

import {
  adrCommand,
  check,
  discoverCommand,
  driftCommand,
  explainCommand,
  graphCommand,
  historyCommand,
  impactCommand,
  planContextCommand,
  reconcileCommand,
  resolveCommandContext,
  resolveDescribedPolicy,
  resolvePolicy,
  UsageError,
  WORKSPACE_MARKERS,
} from "@ecoma-io/archkeep/commands";
import { findWorkspaceRoot, listTrackedFiles } from "@ecoma-io/archkeep";

/**
 * The working directory every adapter resolves a workspace from — an explicit
 * `workspaceRoot` argument wins, else the process's own. Kept as one function
 * so the default has one spelling.
 *
 * An explicit `workspaceRoot` must be ABSOLUTE, and this is the one place that
 * holds it. The schema describes the field as an absolute path, and a relative
 * one would resolve against this process's own start directory — an anchor the
 * caller cannot see and could not have meant, and the one direction that can
 * answer for a VALID BUT WRONG tree in silence (a refusal names the tree it
 * walked from; a wrong-but-real workspace root answers confidently about the
 * wrong workspace). The caller that means "where the server was started"
 * omits the field — that is the documented default.
 *
 * @param {string|undefined} workspaceRoot
 * @returns {string}
 * @throws {UsageError} when an explicit `workspaceRoot` is not an absolute
 *   path — a retypable input mistake, not a workspace fact.
 */
function cwdOf(workspaceRoot) {
  if (workspaceRoot === undefined) return process.cwd();
  if (typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot)) {
    throw new UsageError(
      `archkeep: workspaceRoot must be an absolute path; got ${JSON.stringify(workspaceRoot)} ` +
        `(a relative path would resolve against this server's own start directory — omit ` +
        `workspaceRoot to answer for that, or pass the workspace's absolute path)`,
    );
  }
  return workspaceRoot;
}

/**
 * The injectable I/O seams every adapter threads, defaulted — the same pair
 * the engine's own functions accept, passed through untouched.
 *
 * @param {{readGraph?: Function, listFiles?: Function}} [io]
 * @returns {{readGraph?: Function, listFiles?: Function}}
 */
function ioOf(io = {}) {
  return { readGraph: io.readGraph, listFiles: io.listFiles };
}

/**
 * The parsed envelope out of a command's JSON report — the versioned contract
 * a tool returns, read from the exact bytes the command rendered.
 *
 * @param {{report: {json: string}}} commandResult
 * @returns {object}
 */
export function envelopeOf(commandResult) {
  return JSON.parse(commandResult.report.json);
}

/**
 * `archkeep_context`: the deterministic facts an agent needs before it
 * reasons about, plans, or executes a change — the engine's plan context
 * (`context <project> --plan`), which states current architecture, the
 * applicable policy rows with their authored intent, impact, current
 * violations, drift signals, the architecture-intent verdict, coverage, and
 * the commands that verify the change afterwards. Every field is a fact the
 * tree or the boundary law states; nothing here generates a plan — the agent
 * is the one that decides.
 *
 * Adds no key beside the envelope.
 *
 * @param {{workspaceRoot?: string, project: string, paths?: string[]}} input
 * @param {{readGraph?: Function, listFiles?: Function}} [io]
 * @returns {Promise<object>} The `context --plan` envelope.
 * @throws {UsageError} when the project is not in the graph (an input
 *   mistake), propagated for the tool-error lane.
 * @throws {Error} on the engine's refusals (no workspace root, malformed
 *   law, unregistered-plugin polyglot graph), message verbatim.
 */
export async function contextTool({ workspaceRoot, project, paths = [] }, io = {}) {
  const cwd = cwdOf(workspaceRoot);
  const commandContext = resolveCommandContext({ cwd }, ioOf(io));
  const { config } = await resolvePolicy({ config: null }, commandContext, cwd);
  return envelopeOf(await planContextCommand(project, paths, commandContext, config));
}

/**
 * What a check result's verdict speaks for — the whole workspace (the gate)
 * or the named files only (a fast pre-check). Stated as a typedef because
 * plain object literals in a ternary widen their `kind` to `string`, and
 * this union is the contract an agent branches on.
 *
 * @typedef {{kind: "workspace"}|{kind: "paths", paths: string[]}} CheckScope
 */

/**
 * `archkeep_check`: the authoritative compliance gate, as a three-state
 * verdict.
 *
 * The verdict vocabulary is the envelope's own `decision.verdict` —
 * `pass` (status `ok`), `fail` (status `findings`), `unknown` (status
 * `no-verdict`) — derived by the engine's one `verdictFor`, never
 * re-worded here. The separation this function holds:
 *
 * - a COMPLETED run returns `{runCompleted: true, verdict, scope, envelope}` —
 *   the verdict is whatever the engine decided, including `unknown` for a run
 *   that could not fully look;
 * - a run that could NOT START (no workspace root, a malformed law, a git or
 *   provider failure — everything `check` throws) returns
 *   `{runCompleted: false, verdict: "unknown", scope, reason}` with the
 *   engine's message — an infrastructure failure is never a `fail`, because
 *   `fail` names a finding and no finding was reached;
 * - a `UsageError` (the caller's own input — a path argument that matches no
 *   tracked file) propagates for the tool-error lane: it is a mistake to
 *   retype, not a fact about the workspace.
 *
 * The two catch lanes mirror the CLI's own exit-code taxonomy one for one,
 * and that includes what they do with a programming bug: the engine knows
 * exactly two thrown classes (`src/errors.mjs`) — `UsageError` (CLI exit 2)
 * and everything else (CLI exit 3, "the run could not look") — so a
 * `TypeError` raised inside the engine is an exit-3 refusal on the CLI and a
 * structured `unknown` with its message here, never a third class invented
 * in this layer. This face holds no opinion about errors the engine has not
 * already stated.
 *
 * `paths` narrows the run to specific files, exactly as the CLI's positional
 * arguments do. A scoped run is a fast filter, never the whole-workspace
 * gate, and the `scope` key states which of the two a result is —
 * `{kind: "workspace"}` or `{kind: "paths", paths}` — because a scoped
 * `pass` and an unscoped one are the same three fields otherwise, and only
 * the scope tells an agent that the first says nothing about the files it
 * left out.
 *
 * @param {{workspaceRoot?: string, paths?: string[]}} input
 * @param {{readGraph?: Function, listFiles?: Function}} [io]
 * @returns {Promise<{runCompleted: boolean, verdict: "pass"|"fail"|"unknown",
 *   scope: {kind: "workspace"}|{kind: "paths", paths: string[]},
 *   envelope?: object, reason?: string}>}
 */
export async function checkTool({ workspaceRoot, paths = [] }, io = {}) {
  const cwd = cwdOf(workspaceRoot);
  const scope = /** @type {CheckScope} */ (
    paths.length > 0 ? { kind: "paths", paths } : { kind: "workspace" }
  );
  let result;
  try {
    result = await check(
      { format: "json", config: null, paths, evidenceOut: null },
      { cwd, ...ioOf(io) },
    );
  } catch (error) {
    if (error instanceof UsageError) throw error;
    return {
      runCompleted: false,
      verdict: "unknown",
      scope,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const envelope = JSON.parse(result.report);
  return {
    runCompleted: true,
    verdict: envelope.decision.verdict,
    scope,
    envelope,
  };
}

/**
 * `archkeep_impact`: reverse reachability from the project graph — every
 * project that transitively depends on the named one, direct separated from
 * transitive, each dependent's edge annotated with the constraint rows that
 * govern it and whether the edge violates them (`impact <project>`).
 *
 * Adds no key beside the envelope.
 *
 * @param {{workspaceRoot?: string, project: string}} input
 * @param {{readGraph?: Function, listFiles?: Function}} [io]
 * @returns {Promise<object>} The `impact` envelope.
 * @throws {UsageError} when the project is not in the graph.
 * @throws {Error} on the engine's refusals (incomplete graph coverage among
 *   them), message verbatim.
 */
export async function impactTool({ workspaceRoot, project }, io = {}) {
  const cwd = cwdOf(workspaceRoot);
  const commandContext = resolveCommandContext({ cwd }, ioOf(io));
  const { config } = await resolvePolicy({ config: null }, commandContext, cwd);
  return envelopeOf(impactCommand(project, commandContext, config));
}

/**
 * `archkeep_drift`: the observed architecture compared against the declared
 * intended one (`architecture-intent.json`). A different question from
 * `archkeep_check`: check asks whether the current architecture violates the
 * applicable laws; drift asks whether reality has diverged from the declared
 * intent. An absent intent is a refusal here, exactly as it is on the CLI.
 *
 * The boundary-law load is deferred the way `cli.mjs`'s `runDrift` defers it:
 * the law is the one thing drift reads (a row's `decisionRef` resolves
 * against the fitness ids that law declares), so a load failure travels to
 * the one site that reads it rather than failing a command that never would.
 *
 * Adds no key beside the envelope.
 *
 * @param {{workspaceRoot?: string}} input
 * @param {{readGraph?: Function, listFiles?: Function}} [io]
 * @returns {Promise<object>} The `drift` envelope.
 * @throws {Error} on the engine's refusals (no tracked intent, incomplete
 *   coverage, an intent that cannot be verified), message verbatim.
 */
export async function driftTool({ workspaceRoot }, io = {}) {
  const cwd = cwdOf(workspaceRoot);
  const commandContext = resolveCommandContext({ cwd }, ioOf(io));
  let config = null;
  let configError = null;
  try {
    ({ config } = await resolvePolicy({ config: null }, commandContext, cwd));
  } catch (error) {
    configError = /** @type {Error} */ (error);
  }
  return envelopeOf(await driftCommand(commandContext, { config, configError }));
}

/**
 * `archkeep_explain`: the judgment for one import site, explained — which
 * constraint row matched, which tags applied, whether the site is a violation
 * and why, with `remediation` and `allowed` guaranteed keys read verbatim off
 * the governing row (`explain <file>:<line>:<column>`).
 *
 * The input is the three fields a `check` finding already carries
 * (`sourceFile`, `line`, `column`, 1-based) rather than a `file:line:column`
 * string to be re-parsed — the agent copies them from the finding it is
 * asking about, and the engine's own site parser gets the same three numbers
 * either way.
 *
 * Adds no key beside the envelope.
 *
 * @param {{workspaceRoot?: string, file: string, line: number, column: number}} input
 * @param {{readGraph?: Function, listFiles?: Function}} [io]
 * @returns {Promise<object>} The `explain` envelope.
 * @throws {UsageError} when the site is malformed.
 * @throws {Error} when no import site exists at that position, or on the
 *   engine's refusals, message verbatim.
 */
export async function explainTool({ workspaceRoot, file, line, column }, io = {}) {
  const cwd = cwdOf(workspaceRoot);
  const commandContext = resolveCommandContext({ cwd }, ioOf(io));
  const { config } = await resolvePolicy({ config: null }, commandContext, cwd);
  return envelopeOf(explainCommand(`${file}:${line}:${column}`, commandContext, config));
}

/**
 * `archkeep_graph`: the project graph as a deterministic, serialisable
 * snapshot (`graph`) — projects with their tags and targets, dependencies,
 * workspace layout, and the policy fingerprint when the workspace declares a
 * law. Structural exploration only; `archkeep_context` remains the entry
 * point that assembles architecture facts for a change.
 *
 * The law is loaded the way the CLI's `graph` loads it
 * (`resolveDescribedPolicy`): a workspace that never wrote one is answered,
 * not refused — describing the graph is not judging against the law.
 *
 * Adds no key beside the envelope.
 *
 * @param {{workspaceRoot?: string}} input
 * @param {{readGraph?: Function, listFiles?: Function}} [io]
 * @returns {Promise<object>} The `graph` envelope.
 * @throws {Error} on the engine's refusals (unregistered-plugin polyglot
 *   graph among them), message verbatim.
 */
export async function graphTool({ workspaceRoot }, io = {}) {
  const cwd = cwdOf(workspaceRoot);
  const commandContext = resolveCommandContext({ cwd }, ioOf(io));
  const { config } = await resolveDescribedPolicy({ config: null }, commandContext, cwd);
  return envelopeOf(graphCommand(commandContext, { config }));
}

/**
 * `archkeep_history`: the workspace's architectural history and its recorded
 * decisions — two kinds of evidence behind one tool, because both answer
 * "why is the architecture this way" (`history` and `adr`).
 *
 * - `evidence: "evolution"` — the transitions across a consumer-managed
 *   directory of `graph` snapshots, classified as architecture, policy,
 *   provider, or code drift (`history <dir>`). Read-only: the capture that
 *   writes a snapshot is a workspace action the CLI owns, never a tool call.
 * - `evidence: "decisions"` — the ADR registry at the workspace root, whole
 *   (`adr`): every decision's id and status, the rule/fitness ids each one
 *   binds, and every supersession chain, with unresolvable references named
 *   under `result.unresolved` (which flips the run to `no-verdict`). ADRs
 *   are one kind of architectural evidence here, not a separate tool.
 *
 * There is deliberately no single-record narrowing. The engine's JSON
 * envelope answers at registry granularity — the CLI's `adr <id>` narrows
 * its TEXT rendering, not the envelope — so an argument that promised one
 * record would return the whole registry under a narrower promise, and a
 * caller that wants one record filters `result.statuses`/`result.bindings`
 * by the id it already holds, or reads the ADR file itself (the envelope
 * names the registry directory).
 *
 * Adds no key beside the envelope; the `command` field inside each envelope
 * names which of the two faces answered.
 *
 * @param {{workspaceRoot?: string, evidence: "evolution"|"decisions",
 *   directory?: string}} input
 * @param {{readGraph?: Function, listFiles?: Function}} [io]
 * @returns {Promise<object>} The `history` or `adr` envelope.
 * @throws {Error} when `evidence` is `"evolution"` and `directory` is absent
 *   (an input requirement this adapter states itself, before the engine is
 *   reached), and on the engine's refusals — an empty or unreadable snapshot
 *   directory, an unreadable registry — message verbatim.
 */
export async function historyTool({ workspaceRoot, evidence, directory }, io = {}) {
  // Cross-field input rule, stated here rather than in the schema so the
  // refusal can name both fields: a narrowing argument that belongs to the
  // OTHER evidence kind is a caller mistake, and dropping it silently would
  // answer a narrower question than the one asked without saying so.
  if (evidence === "evolution") {
    if (typeof directory !== "string" || directory === "") {
      throw new UsageError(
        "archkeep: history evidence 'evolution' needs the snapshot directory " +
          "(the one `archkeep history --capture` writes); none was given",
      );
    }
    const cwd = cwdOf(workspaceRoot);
    const commandContext = resolveCommandContext({ cwd }, ioOf(io));
    const dir = isAbsolute(directory) ? resolve(directory) : resolve(cwd, directory);
    return envelopeOf(historyCommand(dir, commandContext, {}));
  }
  if (directory !== undefined) {
    throw new UsageError(
      "archkeep: directory is evolution evidence; evidence 'decisions' does not read it " +
        "(pass evidence 'evolution' to read a snapshot directory)",
    );
  }
  const cwd = cwdOf(workspaceRoot);
  const root = findWorkspaceRoot(cwd, WORKSPACE_MARKERS);
  if (root === null) {
    // The marker names are read off the engine's own list, never restated —
    // a marker added there reaches this refusal without a second copy to edit.
    throw new Error(
      `archkeep: history evidence 'decisions' needs a workspace root — no marker ` +
        `(${WORKSPACE_MARKERS.join(", ")}) found walking up from ${cwd}`,
    );
  }
  const listFiles = io.listFiles ?? listTrackedFiles;
  return envelopeOf(adrCommand(root, {}, { tracked: listFiles(root) }));
}

/**
 * `archkeep_propose`: a NON-AUTHORITATIVE architecture proposal, from the
 * engine's two read-only proposal surfaces:
 *
 * - `mode: "discover"` — the candidate architecture the observations imply
 *   (`discover --propose`): the projects, edges and tags a first
 *   `architecture-intent.json` could declare. For a workspace with no
 *   declared intent.
 * - `mode: "reconcile"` — the ranked candidate edits that would make the
 *   declared intent agree with the observed architecture
 *   (`reconcile --propose`), each candidate carrying the evidence that
 *   supports it. For a workspace whose intent has drifted.
 *
 * Every candidate the engine returns is already marked `proposed: true` and
 * `notAuthoritative`; this adapter states the same contract at the top level
 * — `requiresApproval: true`, `authoritative: false`, `written: false` —
 * beside the envelope. Nothing is written: adopting a proposal is a human
 * decision made in a reviewed pull request, and no tool in this server can
 * modify the intent, the policy, a waiver, or any authoritative file. That is
 * the whole boundary this tool exists to hold.
 *
 * @param {{workspaceRoot?: string, mode: "discover"|"reconcile"}} input
 * @param {{readGraph?: Function, listFiles?: Function}} [io]
 * @returns {Promise<object>} The `discover`/`reconcile` envelope with
 *   `requiresApproval`, `authoritative`, `written`, and `mode` added beside
 *   it.
 * @throws {Error} on the engine's refusals (reconcile without a tracked
 *   intent, incomplete coverage), message verbatim.
 */
export async function proposeTool({ workspaceRoot, mode }, io = {}) {
  const commandContext = resolveCommandContext({ cwd: cwdOf(workspaceRoot) }, ioOf(io));
  const proposal =
    mode === "discover"
      ? envelopeOf(discoverCommand(commandContext, { propose: true }))
      : envelopeOf(await reconcileCommand(commandContext, {}, { propose: true }));
  return {
    ...proposal,
    mode,
    requiresApproval: true,
    authoritative: false,
    written: false,
  };
}

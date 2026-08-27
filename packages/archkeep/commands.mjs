/**
 * The command layer's public face — what an integration imports from this
 * package's `./commands` subpath to run the same commands `cli.mjs` runs,
 * in-process, without spawning the CLI or parsing its text output.
 *
 * It holds no logic on purpose, the same bargain `./nx` (`nx.mjs`) makes: a
 * named entry that is a re-export, so the command layer can grow under
 * `src/commands/` without a second copy of any decision appearing beside it.
 * `cli.mjs` and this file are two faces of one layer — the CLI owns argv,
 * output destinations and exit codes; an importer of this face owns those for
 * itself, and gets back exactly what the command functions return: statuses,
 * payloads and reports, never a printed byte.
 *
 * Who this is for: integrations that compose the CLI's verbs programmatically
 * — `packages/archkeep-mcp`, the agent capability interface, is the first. The
 * engine primitives (discovery and judgment) remain the root entry
 * (`index.mjs`); a caller that wants to JUDGE import records itself composes
 * those, while a caller that wants the CLI's answers — a verdict, an impact
 * set, an explanation — composes these. The two entries never overlap: a
 * function exported here is never also exported there, so no integration can
 * accidentally hold two spellings of one decision.
 *
 * The roster is exactly what the first consumer composes, no more — a
 * function joins it when an integration calls it, never in anticipation of
 * one. What is deliberately absent: the `run*` drivers and argv parsing
 * (`cli.mjs` alone owns what a process's stdout and exit code mean), and the
 * renderers (`src/report/` shapes bytes for humans; an importer reads the
 * envelopes the commands already return).
 *
 * The seams the CLI threads are threaded the same way here: `readGraph` and
 * `listFiles` are injectable on every entry point that reaches outside the
 * process, so a caller drives the real analysis, rules and reports over a
 * fixture tree with neither Nx nor git present.
 */

export { resolveCommandContext, WORKSPACE_MARKERS } from "./src/commands/context.mjs";

export { resolveDescribedPolicy, resolvePolicy } from "./src/commands/policy.mjs";

export { check } from "./src/commands/check.mjs";
export { graphCommand } from "./src/commands/graph.mjs";
export { impactCommand } from "./src/commands/impact.mjs";
export { explainCommand } from "./src/commands/explain.mjs";
export { driftCommand } from "./src/commands/drift.mjs";
export { planContextCommand } from "./src/commands/plan-context-command.mjs";
export { historyCommand } from "./src/commands/history.mjs";
export { adrCommand } from "./src/commands/adr.mjs";
export { discoverCommand } from "./src/commands/discover.mjs";
export { reconcileCommand } from "./src/commands/reconcile.mjs";
export {
  rulesAddCommand,
  rulesInfoCommand,
  rulesListCommand,
  rulesVerifyCommand,
} from "./src/commands/rules.mjs";

export { UsageError } from "./src/errors.mjs";

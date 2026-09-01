/**
 * The MCP server: eight tools, each one adapter from `./engine.mjs` registered
 * on the reference SDK's high-level server.
 *
 * This module holds no architecture decision of its own. What it owns is the
 * tool surface — names, input schemas, descriptions — and the two mappings
 * every result passes through:
 *
 * - a completed adapter call becomes `{content: [JSON text], structuredContent}`
 *   — the same payload twice, because a client that reads `structuredContent`
 *   and one that reads text both get the engine's answer, not two renderings
 *   of it;
 * - an adapter throw becomes a tool error with the message verbatim. The
 *   engine's refusals are deterministic sentences that name their cause; a
 *   tool error is how an agent sees a refusal, and re-wording it here would
 *   be a second opinion about the same fact. `UsageError` — the engine's own
 *   class for "the caller's input is wrong" — gets one sentence of framing
 *   prepended so an agent can tell a retypable mistake from a workspace
 *   refusal without pattern-matching message text.
 *
 * The eight tools are the whole surface. The CLI's other verbs (`diff`,
 * `delta`, `debt`, `health`, `report`, `waivers`, `fitness`, `provenance`,
 * …) are deliberately NOT tools: a capability face answers the questions an
 * agent asks mid-change — context, verdict, impact, drift, explanation,
 * structure, history, proposal — and everything else stays where a human or
 * a pipeline reads it. Growing the surface is a decision, not an
 * aggregation.
 *
 * Two properties every tool carries, stated here because no single
 * registration should be the place a reader learns them:
 *
 * - **Every input schema is strict.** zod's default strips a key the schema
 *   does not name, so a typo (`path` for `paths`) would silently answer the
 *   question WITHOUT the argument the caller believed they had passed — for
 *   `check`, a scoped run widening to the workspace (the safe direction), but
 *   for `context`, a narrowing that leaves no trace at all. `z.strictObject`
 *   turns every unknown key into a validation error that names it, before
 *   the engine is reached.
 * - **Every tool announces `readOnlyHint: true`.** All eight compose the
 *   engine's read and propose surfaces; a host uses the hint to trim
 *   permission prompts, and the authority boundary the propose tool's
 *   description argues is the fact the annotation rests on.
 */
import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { UsageError } from "@ecoma-io/archkeep/commands";

import {
  checkTool,
  contextTool,
  driftTool,
  explainTool,
  graphTool,
  historyTool,
  impactTool,
  proposeTool,
  scenarioTool,
} from "./engine.mjs";

/** The server's own name, as a client sees it in `initialize`. */
export const SERVER_NAME = "archkeep-mcp";

/** The version a client sees in `initialize` — this package's own. */
const require2 = createRequire(import.meta.url);
export const SERVER_VERSION = require2("../package.json").version;

/**
 * The `workspaceRoot` argument every tool accepts, described once — the
 * workspace a call answers for, when it is not the process's own working
 * directory. Absolute by contract and refused when it is not (the adapters
 * hold that, in one place): a relative path would resolve against the
 * server's own start directory, a tree the caller cannot know.
 */
const workspaceRootField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Absolute path of the Archkeep workspace root to answer for (a relative " +
      "path is refused). Omit when the server was started in the workspace " +
      "(the default).",
  );

/**
 * Wraps one adapter result as a successful MCP tool result — the payload as
 * both `structuredContent` and a JSON text block, one answer in two
 * spellings for whichever the client reads.
 *
 * @param {object} payload
 * @returns {{content: {type: "text", text: string}[], structuredContent: object}}
 */
export function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/**
 * Wraps one adapter throw as an MCP tool error — the message verbatim, so the
 * engine's deterministic refusal sentences reach the agent unchanged. A
 * `UsageError` is the caller's own input being wrong, and says so before the
 * engine's sentence.
 *
 * @param {unknown} error
 * @returns {{content: {type: "text", text: string}[], isError: true}}
 */
export function toolError(error) {
  const detail = error instanceof Error ? error.message : String(error);
  const message = error instanceof UsageError ? `Invalid input: ${detail}` : detail;
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Runs one adapter as a tool handler: completed call → `toolResult`, throw →
 * `toolError`. Every handler in `createServer` is this function around one
 * adapter, so the error mapping cannot drift per tool.
 *
 * @param {(input: object, io?: object) => Promise<object>} adapter
 * @param {object} [io] The engine seams threaded to every adapter call.
 * @returns {(input: object) => Promise<object>}
 */
function asHandler(adapter, io) {
  return async (input) => {
    try {
      return toolResult(await adapter(input, io));
    } catch (error) {
      return toolError(error);
    }
  };
}

/**
 * Builds the Archkeep MCP server: eight tools over the engine's command
 * layer, no resources, no prompts. Not connected to any transport — the
 * caller owns how the server is reached (`../mcp.mjs` wires stdio; a test
 * wires an in-memory pair).
 *
 * `io` threads the engine's own injectable seams (`readGraph`, `listFiles`)
 * to every tool call, the same seams `check`/`resolveCommandContext` already
 * accept — it exists so a test can drive the real adapters over a fixture
 * tree with neither Nx nor git present, and an embedder can supply their own.
 * `../mcp.mjs` builds the server without it, which is the real Nx, the real
 * git, the real everything.
 *
 * @param {{readGraph?: Function, listFiles?: Function}} [io]
 * @returns {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer}
 */
export function createServer(io = {}) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "archkeep_context",
    {
      title: "Architecture context for a change",
      description:
        "Deterministic architecture context to read BEFORE planning or making a change to a " +
        "project: the project's tags and the constraint rows that govern it (with the " +
        "workspace's authored descriptions and remediation), the architecture graph the plan " +
        "is made against (all projects and edges; the plan's targets, violations and impact " +
        "are scoped to the change), its dependents (capped, with an overflow note), current " +
        "violations scoped to the change, drift signals (go.work, tsconfig paths), the " +
        "architecture-intent verdict when one is declared, and coverage with the exact files " +
        "that could not be analyzed. Facts only — this never generates a plan; deciding the " +
        "plan is the agent's job. Equivalent to " +
        "`archkeep context <project> --plan --format json`.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        workspaceRoot: workspaceRootField,
        project: z
          .string()
          .min(1)
          .describe(
            "Name of the project being changed (a node of the project graph — " +
              "`archkeep_graph` lists them).",
          ),
        paths: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Workspace-relative paths the change touches, narrowing the reported violations " +
              "and impact to the projects that own them. Omit for the project alone.",
          ),
      }),
    },
    asHandler(contextTool, io),
  );

  server.registerTool(
    "archkeep_check",
    {
      title: "Authoritative architecture compliance verdict",
      description:
        "The authoritative compliance gate: every import judged against the boundary rules " +
        "in effect, folded with declared-edge findings, go.work drift, dead tsconfig path " +
        "aliases, architecture-intent findings, fitness functions and custom rules. Returns " +
        "a three-state verdict — 'pass' (clean over complete coverage), 'fail' (findings: " +
        "the architecture violates an applicable law), 'unknown' (the run could not look: " +
        "incomplete coverage, a law that would not load, a run that could not start). " +
        "'unknown' is never 'pass' and never 'fail' — treat it as red and investigate, not " +
        "as clean and not as findings. Read `scope` beside the verdict: " +
        "scope.kind 'workspace' is the whole-workspace gate; scope.kind 'paths' is a fast " +
        "pre-check of the named files ONLY — a scoped 'pass' says nothing about the files " +
        "outside its scope and never stands in for the gate. Equivalent to " +
        "`archkeep check --format json`. This is the verdict to verify a change with; " +
        "`archkeep_drift` answers a different question.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        workspaceRoot: workspaceRootField,
        paths: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Workspace-relative files to scope the run to (a fast pre-check). A scoped run " +
              "says nothing about files outside its scope — its result carries " +
              "scope.kind 'paths' to say so; an unscoped run is the gate. " +
              "Omit for the whole workspace.",
          ),
      }),
    },
    asHandler(checkTool, io),
  );

  server.registerTool(
    "archkeep_impact",
    {
      title: "Architectural impact of changing a project",
      description:
        "Every project that transitively depends on the named one — the blast radius of a " +
        "change — direct separated from transitive, each dependent's edge annotated with " +
        "the constraint rows that govern it and whether that edge violates them. Per-edge " +
        "coverage is narrower than a full check (tag constraints only); run " +
        "`archkeep_check` for the complete verdict. Equivalent to " +
        "`archkeep impact <project> --format json`.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        workspaceRoot: workspaceRootField,
        project: z.string().min(1).describe("Name of the project whose dependents to list."),
      }),
    },
    asHandler(impactTool, io),
  );

  server.registerTool(
    "archkeep_drift",
    {
      title: "Observed architecture vs declared intent",
      description:
        "Whether the OBSERVED architecture has diverged from the DECLARED intended one " +
        "(the tracked `architecture-intent.json`): every finding names the intent row and " +
        "the observed fact that violates it. A different question from `archkeep_check` — " +
        "check asks whether the current architecture violates the applicable laws; drift " +
        "asks whether reality has moved away from what was declared. Requires a tracked " +
        "intent; a workspace without one is refused (use `archkeep_propose` to draft one). " +
        "Equivalent to `archkeep drift --format json`.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        workspaceRoot: workspaceRootField,
      }),
    },
    asHandler(driftTool, io),
  );

  server.registerTool(
    "archkeep_explain",
    {
      title: "Explain one finding's judgment",
      description:
        "The deterministic judgment for one import site, explained: the import specifier, " +
        "source and target projects with their tags, which constraint rows matched, whether " +
        "the site is a violation or allowed and why — with `remediation` and `allowed` keys " +
        "on every violation entry: the workspace author's declared guidance and the " +
        "governing row's own allow list, verbatim when the row declares either, `null` when " +
        "it declares none. Pass the `file`, `line` and `column` exactly as the " +
        "finding reported them (1-based). Equivalent to " +
        "`archkeep explain <file>:<line>:<column> --format json`.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        workspaceRoot: workspaceRootField,
        file: z
          .string()
          .min(1)
          .describe("Workspace-relative source file of the finding (`sourceFile`)."),
        line: z.number().int().min(1).describe("1-based line of the import site."),
        column: z.number().int().min(1).describe("1-based column of the import site."),
      }),
    },
    asHandler(explainTool, io),
  );

  server.registerTool(
    "archkeep_graph",
    {
      title: "The project graph as a deterministic snapshot",
      description:
        "The whole project graph as a serialisable snapshot: projects with their tags and " +
        "targets, dependencies, workspace layout, and the policy fingerprint when the " +
        "workspace declares a law. For structural exploration — finding a project's name " +
        "for `archkeep_context`/`archkeep_impact`, seeing what exists. For assembling the " +
        "facts a change needs, prefer `archkeep_context`, which adds the constraint rows, " +
        "dependents and scoped violations a plan is made of. Equivalent to " +
        "`archkeep graph --format json`.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        workspaceRoot: workspaceRootField,
      }),
    },
    asHandler(graphTool, io),
  );

  server.registerTool(
    "archkeep_history",
    {
      title: "Architectural history and recorded decisions",
      description:
        'Two kinds of architectural evidence. `evidence: "decisions"` — the ADR registry ' +
        "at the workspace root, at registry granularity: every recorded decision's id and " +
        "status, the rule/fitness ids each one binds, and every supersession chain, with " +
        "references that resolve to no record named under `result.unresolved` (which makes " +
        "the run no-verdict). For one record's prose, read the ADR file the envelope's " +
        "registry directory names. " +
        '`evidence: "evolution"` — the transitions across a directory of graph snapshots ' +
        "(the directory `archkeep history --capture` maintains), each classified as " +
        "architecture, policy, provider or code drift; needs `directory`. Read-only — " +
        "capturing a snapshot is a workspace action the CLI owns.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        workspaceRoot: workspaceRootField,
        evidence: z.enum(["decisions", "evolution"]).describe("Which kind of evidence to return."),
        directory: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The snapshot directory to read, workspace-relative or absolute. Required for " +
              "evolution evidence; refused for decisions evidence.",
          ),
      }),
    },
    asHandler(historyTool, io),
  );

  server.registerTool(
    "archkeep_propose",
    {
      title: "Draft a NON-AUTHORITATIVE architecture proposal",
      description:
        "Drafts a proposal from the engine's read-only proposal surfaces — never a decision. " +
        '`mode: "discover"`: the candidate architecture the current observations imply ' +
        "(projects, edges, tags a first architecture-intent.json could declare) — for a " +
        'workspace with no declared intent. `mode: "reconcile"`: the ranked candidate ' +
        "edits that would make the DECLARED intent agree with observed reality, each with " +
        "its supporting evidence — for a workspace whose intent has drifted. Every result " +
        "carries `requiresApproval: true` and `written: false`: nothing is modified, no " +
        "waiver is created, no authority moves. Adopting a proposal is a human decision " +
        "made in a reviewed pull request; this server exposes no tool that can write the " +
        "intent, the policy, or any authoritative file.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        workspaceRoot: workspaceRootField,
        mode: z
          .enum(["discover", "reconcile"])
          .describe(
            "'discover' proposes an architecture from what is observed; 'reconcile' " +
              "proposes edits that bring the declared intent back in line with it.",
          ),
      }),
    },
    asHandler(proposeTool, io),
  );

  server.registerTool(
    "archkeep_scenario",
    {
      title: "Evaluate a hypothetical dependency change",
      description:
        "Evaluates a 'what-if' scenario of dependency changes without modifying the " +
        "workspace: add, remove, or modify dependencies between projects and see what " +
        "the workspace would look like after those changes, including new or resolved " +
        "violations, compared against the current state. The scenario is a JSON object " +
        "describing one or more changes (see scenario-evaluation.mjs for the schema). " +
        "The evaluation is read-only — every output field carries a `virtual: true` " +
        "marker. Equivalent to `archkeep scenario <project> --scenario-file <file> " +
        "--format json`.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        workspaceRoot: workspaceRootField,
        projectName: z
          .string()
          .min(1)
          .describe(
            "Name of the project to evaluate the scenario against (a node of the " +
              "project graph — `archkeep_graph` lists them).",
          ),
        scenarioJson: z
          .string()
          .min(1)
          .describe(
            "The scenario description as a JSON string. Must be a valid JSON object " +
              "with a `changes` array. Each change describes a hypothetical dependency " +
              "modification (e.g. add, remove, or retarget an edge between projects).",
          ),
      }),
    },
    asHandler(scenarioTool, io),
  );

  return server;
}

# MCP integration

Archkeep's MCP server is the **agent capability interface**: the engine's
commands, exposed to an AI agent as structured tools over the
[Model Context Protocol](https://modelcontextprotocol.io). An agent with MCP
support calls a tool and gets the same versioned JSON envelope the CLI's
`--format json` renders — no shell, no text parsing, no second opinion about
what a verdict means.

It is a client of the engine, not a second one. Every tool calls the same
command functions the CLI drives, in process, through the engine package's
`./commands` subpath — the layer split the whole repository holds:

```
Agent
  ├── Archkeep skills (arch-*)  → workflow / behavioral protocol: WHEN, WHY, HOW
  └── Archkeep MCP              → capability interface: structured access
          │
          ▼
    Archkeep engine             → deterministic authority: the one analysis
          │
          └── CLI               → human and CI interface: text, SARIF, exit codes
```

The skills teach an agent the governance workflow; the MCP server is how an
agent equipped for MCP executes it. The CLI remains the interface for humans
and pipelines, and the fallback for agents without MCP — all three faces read
the same workspace, the same law, and answer with the same verdicts.

## Install and run

```shell
npm install @ecoma-io/archkeep-mcp
```

The package is `@ecoma-io/archkeep-mcp`; its one dependency that matters is
`@ecoma-io/archkeep` itself, version-locked to the server's own version (both
are written by one release), so the tools an agent calls always compose the
engine their version names. The server speaks stdio and answers for the
workspace it is started in.

Client registration — Claude Code, either as a project-level
`.mcp.json` or through `claude mcp add`:

```json
{
  "mcpServers": {
    "archkeep": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ecoma-io/archkeep-mcp"]
    }
  }
}
```

Other hosts take the same shape: run `archkeep-mcp` (the package's `bin`) with
stdio, in the workspace. Every tool also accepts an absolute `workspaceRoot`
argument for callers that cannot start the server in the workspace.

## The eight tools

| tool               | answers                                                   | the CLI verb beside it                      |
| ------------------ | --------------------------------------------------------- | ------------------------------------------- |
| `archkeep_context` | the deterministic facts to read before changing a project | `context <project> --plan`                  |
| `archkeep_check`   | the authoritative verdict — `pass` / `fail` / `unknown`   | `check`                                     |
| `archkeep_impact`  | who transitively depends on this project                  | `impact <project>`                          |
| `archkeep_drift`   | has reality diverged from the declared intent             | `drift`                                     |
| `archkeep_explain` | why one finding's judgment is what it is                  | `explain <file>:<line>:<column>`            |
| `archkeep_graph`   | the project graph, for structural exploration             | `graph`                                     |
| `archkeep_history` | ADR decisions, and evolution across graph snapshots       | `adr`, `history <dir>`                      |
| `archkeep_propose` | a NON-AUTHORITATIVE proposal                              | `discover --propose`, `reconcile --propose` |

Eight, deliberately. The CLI's other verbs (`diff`, `delta`, `debt`, `health`,
`report`, `waivers`, `fitness`, `provenance`) are not tools: a capability face
answers the questions an agent asks mid-change, and everything else stays
where a human or a pipeline reads it. Growing the surface is a decision, not
an aggregation of the command table.

### `archkeep_check` and the three-state verdict

The check tool returns exactly three verdicts, and the separation is the
point:

- **`pass`** — the run looked at everything and found nothing. Status `ok`.
- **`fail`** — findings. The architecture violates an applicable law.
- **`unknown`** — the run could not look: incomplete coverage, a law that
  would not load, a run that could not start. Status `no-verdict`.

`unknown` is never rendered as `fail` and never as `pass`. An infrastructure
failure is not a finding — no finding was reached. A tool result with
`runCompleted: false` means the run never started (the `reason` names why);
`runCompleted: true` with verdict `unknown` means the engine itself answered
no-verdict, and the envelope states exactly which files it could not analyze.
An agent treats `unknown` as red to investigate, not as clean and not as
findings — the same discipline
[exit-codes.md](../reference/exit-codes.md) teaches for exit 3.

### `archkeep_check` versus `archkeep_drift`

Different questions, deliberately two tools. **Check** asks: does the current
architecture violate the applicable laws? **Drift** asks: has the observed
architecture moved away from the declared `architecture-intent.json`? A
workspace can pass its laws while drifting from its declared intent, and
drift requires a declared intent where check does not.

## Results

Every completed call returns the engine's versioned JSON envelope
([json-output.md](../reference/json-output.md) owns its fields) — `schemaVersion`,
`command`, `workspace`, `status`, `coverage`, `result` — as both
`structuredContent` and one JSON text block, so a host reads whichever it
speaks. A refusal is a tool error carrying the engine's message verbatim:
the deterministic sentence that names the cause, the same one the CLI prints
on exit 3. A `UsageError` — the caller's own input being wrong — is framed as
an input mistake so an agent can tell a retypable error from a workspace
refusal.

## The authority boundary

**No tool writes.** The seven read tools are read-only by construction — they
compose the engine's descriptive commands. The eighth holds the line the
whole design turns on:

`archkeep_propose` returns `requiresApproval: true`, `authoritative: false`,
`written: false`, and every candidate the engine produces already carries
`proposed: true` and `notAuthoritative`. It proposes — a candidate
architecture from observations (`mode: "discover"`), or ranked intent edits
with their evidence (`mode: "reconcile"`) — and it cannot do more: the
underlying commands cannot express a write, and nothing in this server
modifies `architecture-intent.json`, the boundary policy, a waiver, or any
authoritative file.

Adopting a proposal is a human decision made in a reviewed pull request. That
is [architecture-authority.md](../doctrine/architecture-authority.md) stated
as a tool surface: an agent that could read `context`, `check` and `explain`
is an informed consumer; an agent that could rewrite the law to make its own
import pass would be an authority, and this server exposes no such tool — no
`adopt`, no `write_intent`, no `modify_policy`, no `waive`. If a workspace
wants the CLI's write paths (`history --capture`, `delta --capture`), those
stay with the humans and pipelines that own them.

No tool accepts a boundary-config override either. The capability face
answers for the law in effect; substituting a weaker law for a verification
is the substitution the skills teach agents never to make
([arch-check](https://github.com/ecoma-io/archkeep/blob/main/skills/arch-check/SKILL.md)).

## Skills, MCP, CLI — who does what

- **Skills** (`arch-*`) are the behavioral protocol: when to establish
  context, how to verify a change, what a verdict means and what to do about
  it. Host-independent, no MCP required.
- **MCP** is the capability interface: structured questions and answers, for
  agents whose host speaks MCP. When MCP is available, an agent executes the
  skills' workflow through the tools; the workflow itself is unchanged.
- **CLI** is the human and CI interface: text, SARIF, exit codes, and every
  verb the MCP surface deliberately does not carry. It is also the fallback
  for agents without MCP — same engine, same verdicts.

An agent should not need both a tool call and a shell for one question. When
MCP is present, prefer the tool; when it is not, the CLI answers the same
question in the same shape.

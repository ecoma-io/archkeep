# @ecoma-io/archkeep-mcp

The Archkeep MCP server: the engine's commands as **structured agent
capabilities**, over stdio. It is not a second implementation of anything —
every tool calls the same command functions the `archkeep` CLI drives, in
process, through the engine package's `./commands` subpath, and returns the
same versioned JSON envelope `--format json` renders.

```
Agent
  ├── Archkeep skills (arch-*)  → workflow / behavioral protocol
  └── Archkeep MCP              → structured capability interface
          │
          ▼
    Archkeep engine             → deterministic authority
          │
          └── CLI               → human / CI interface
```

## Install and run

```shell
npm install @ecoma-io/archkeep-mcp
```

The server answers for the workspace it is started in; start it from the
workspace root (or pass an absolute `workspaceRoot` on any call — a relative
path is refused). One registry-published
package is all a consumer needs — it depends on `@ecoma-io/archkeep` itself,
version-locked to this package's own version.
Configuration, the nine tools, the authority boundary `archkeep_propose`
holds, and how the MCP face relates to the skills and the CLI:
[docs/integrations/mcp.md](https://github.com/ecoma-io/archkeep/blob/main/docs/integrations/mcp.md).

Example client registration (Claude Code):

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

## The nine tools

| tool                | answers                                                     |
| ------------------- | ----------------------------------------------------------- |
| `archkeep_context`  | the deterministic facts to read before changing a project   |
| `archkeep_check`    | the authoritative verdict — `pass` / `fail` / `unknown`     |
| `archkeep_impact`   | who transitively depends on this project                    |
| `archkeep_drift`    | has reality diverged from the declared intent               |
| `archkeep_explain`  | why one finding's judgment is what it is                    |
| `archkeep_graph`    | the project graph, for structural exploration               |
| `archkeep_history`  | ADR decisions, and evolution across graph snapshots         |
| `archkeep_propose`  | a NON-AUTHORITATIVE proposal (`requiresApproval: true`)     |
| `archkeep_scenario` | evaluate a hypothetical change — virtual, not authoritative |

No tool writes. `archkeep_propose` drafts candidates with their evidence and
marks every one `notAuthoritative`; adopting one is a reviewed pull request,
and no tool can modify the intent, the policy, a waiver, or any authoritative
file.

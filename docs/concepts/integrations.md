# Integrations

The core engine — analysis, rules, report — is independent of any particular
workspace tool. Integrations extend it by supplying a project graph and, in some
cases, by carrying the verdict to a different audience. This page is the
conceptual overview of that seam. The specific integrations each have their own
reference:

- [Nx integration](../integrations/nx.md) — the project-graph plugin and its
  `createDependencies` hook
- [Moon integration](../integrations/moon.md) — the Moonrepo workspace provider
  that reads from `moon project-graph`
- [VS Code integration](../integrations/vscode.md) — the editor extension that
  hosts the language server
- [MCP integration](../integrations/mcp.md) — the agent capability server: the
  engine's commands as structured tools over stdio

## The provider seam

The engine does not build its own project graph. It reads one from a provider —
an abstraction that implements the `ProjectModelProvider` interface. Which
provider is active depends on the marker file at the workspace root:

- An `nx.json` root activates the Nx integration's provider, which reads the
  graph that the project-graph computation already produces.
- A `archkeep.json` root activates the native provider, which discovers projects
  from the tracked tree and their manifests, with no external tool installed.
- A `.moon/` directory carrying its `workspace.yml` activates the Moon
  provider, which reads the project
  graph from `moon project-graph --json`.

The provider is chosen once, at the start of a run, and the CLI works over
every one of the three. The language server is the exception: it recognizes
only the Nx and native markers (`nx.json` and `archkeep.json`) — there is no
Moon provider on the server side, so a Moon workspace's graph and options are
not read there. That split is the seam; the CLI knows all three providers, the
editor knows the two that carry a config file to watch.

## What each integration supplies

| integration | supplies                                               | runs when                        |
| ----------- | ------------------------------------------------------ | -------------------------------- |
| Nx          | project graph edges from the `createDependencies` hook | every graph computation          |
| Moon        | project graph from `moon project-graph --json`         | on demand (CLI)                  |
| VS Code     | the language server hosted in an editor                | on an edit, in the editor window |

The Nx integration is the only integration that contributes to the project graph
at computation time. The Moon integration reads the graph after Moon has computed
it. Neither judges — the enforcement verdict comes from the same `evaluate`
function the CLI uses, operating on the same constraint table.

The VS Code extension is a client of the language server, not of the engine
directly. It finds the workspace root, locates the server the workspace
installed, starts it over stdio, and shows whether it is running. It contains no
analysis.

## The option-reading seam

Each surface reads the workspace's options by a different route, and the
differences are load-bearing:

- The Nx hook takes `options` from the project-graph context directly.
- The CLI calls `readPluginOptions` from the workspace root.
- The language server calls it at `initialize` and again on every invalidation,
  because a server watching only the file the old options named would keep
  watching a filename the workspace had stopped using.

An unknown key throws at every one of those three doors. A typo that fell back
to the default would be a full green run against a rule nobody wrote.

## How to add a new integration

A new integration needs to do two things:

1. **Supply a project graph** — either by implementing the `ProjectModelProvider`
   interface (as the native provider does) or by contributing edges through an
   existing hook (as the Nx integration does).
2. **Reach the verdict** — either by calling the CLI, by hosting the language
   server, or by composing the engine's exported primitives directly.

The engine publishes its discovery and judgment through the root export
(`index.mjs`). That is the public surface a new integration composes from. The
Nx-plugin entry (`./nx` subpath) is the one module the Nx integration's
configuration is allowed to name; it is a re-export, not a second API.

## What an integration must not do

- **Hold a copy of the constraint table.** It has one home: the file at the
  consumer's workspace root.
- **Default an option.** A default is a second copy of a value the workspace
  already states, and the two disagree the day one changes.
- **Shell out to a language toolchain.** The moment a provider needs a real
  toolchain, it fails on machines that never touch that language.
- **Assume any workspace's project names, areas, or tag values.** The tool is
  installed into trees it has never seen.

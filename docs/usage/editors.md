# Diagnostics at the edit

The package ships a language server, so a boundary violation is a squiggle under
the import rather than a CI failure an hour later. Same engine, same fifteen
message ids, same boundary table — the only difference from the CLI is when you
find out.

## The one guarantee

**An empty diagnostic list from this server always means "no violation", never
"not checked".**

An editor draws nothing for `[]`, and a developer reads nothing as "checked,
clean". So a file the server could not analyze gets a diagnostic saying exactly
that. There are only two places an empty list is ever published — a completed
analysis that found nothing, and the moment a document closes — and both are
named in the code.

This is why the server is worth running even where you also run the CLI: it is
the surface where silence would be most convincing and least examined.

## Claude Code

One-time install, from this repository's marketplace:

```shell
claude plugin marketplace add ecoma-io/lattice
claude plugin install nx-polyglot-graph@lattice
```

After that, a session editing a `.go`, `.rs`, `.py` or `.vue` file gets boundary
diagnostics in the conversation. Node must be on `PATH`; nothing else is
installed.

**Why those four extensions and not `.ts`:** Claude Code gives **one server per
extension** — the first registered wins and the rest never start — so claiming
`.ts` would silently displace whichever TypeScript server the developer actually
needs, in order to re-answer a question ESLint already answers. `.vue` is claimed
anyway, as a second opinion on the one extension both enforcers cover.

The routed list is every extension the analyzers know except the JS/TS family,
and a test fails on the day that list and the analyzer registry disagree — a
language that arrived in the registry but not in the manifest would be checked by
the CLI and never by an editor, which reads exactly like a clean tree.

## Any other LSP client

The server is a plain stdio LSP executable. Everything a client needs:

|                         |                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| command                 | `node <workspace>/node_modules/@ecoma-io/nx-polyglot-graph/lsp.mjs`                          |
| transport               | stdio                                                                                        |
| `initializationOptions` | `{ "workspaceRoot": "<workspace>" }` — only when the editor's root is not the workspace root |
| watched files           | the boundary config, `**/nx.json`, and `**/project.json`                                     |

The workspace root is taken from `initializationOptions`, then `workspaceFolders`,
then `rootUri`, then `rootPath`, then the working directory — the first that
answers. Supply it explicitly if your editor opens a subdirectory, because the
root decides which boundary config is read and a wrong one reports green against
rules nobody wrote.

**Capabilities are deliberately few.** Only full text synchronisation is
advertised: no hover, no go-to-definition, and **no incremental sync**. A
capability is a promise, and incremental sync stays unadvertised until it can be
proven correct — one mis-applied ranged edit puts every later diagnostic on the
wrong line, confidently.

**File watching.** A client that supports dynamic registration is asked to watch
the three files above. `nx.json` is on that list because it holds the option
naming the boundary config: a server watching only the old filename would keep
publishing verdicts from a config the workspace had stopped using. A client that
cannot register dynamically is told so on stderr — if your diagnostics go stale
after a config edit, that message is why, and reopening the file re-runs the
check.

**Which extensions to route** is your client's decision, not the server's. Most
editors allow several servers per buffer, unlike Claude Code, so the JS/TS
exclusion above does not have to apply — routing `.ts` here alongside your
TypeScript server is a supported thing to do, it just duplicates what
`@nx/enforce-module-boundaries` already tells you.

## VS Code

The client lives in this repository, at
[`packages/lattice-vscode`](../../packages/lattice-vscode/README.md). It requires
VS Code 1.100 or newer, routes the same four extensions, and starts the server
that is installed in the workspace you opened.

**It is not on the marketplace yet** — the publisher account does not exist, so
the release lane's marketplace step skips (loudly) for now. CI does package and
verify the `.vsix` on every change and attaches it to each `lattice-vscode-v*`
release, so today you install that file by hand (**Extensions: Install from
VSIX…**) or run from a development host, and a generic LSP bridge extension
configured from the table above remains a working alternative.

Two things about it are worth knowing before you install it, because both are
refusals rather than omissions:

- **It does not bundle the server.** It resolves
  `@ecoma-io/nx-polyglot-graph` out of the workspace, so the verdict in your
  buffer comes from the version your pipeline runs. A bundled copy pinned to a
  marketplace release could disagree with CI about the same import, and both
  would report confidently.
- **There is no `enable` setting.** A workspace with the checker switched off
  produces the same empty Problems panel as a workspace with no violations, which
  is the silence this project exists to end. What it does have is a language
  status item that says, in as many words, when nothing is being checked — the
  editor's version of the CLI's _could not look_ exit code.

## What it does not do

- **No quick fixes, no code actions.** A boundary violation's fix is a design
  decision — re-tag, restructure, or widen a row — and an editor offering to
  apply one of those would be guessing which.
- **No workspace-wide scan on startup.** Diagnostics are per open document. The
  whole-tree verdict is the CLI's job, and a scoped view is exactly why
  [ci.md](ci.md) says a scoped run is not the gate.
- **No rules of its own.** Every constraint comes from the workspace's `nx.json`
  and boundary config, so the editor and CI cannot disagree about what is
  allowed. A client may have settings — the VS Code one has two — but neither of
  them can change a verdict, only which server answers and how loudly it logs.

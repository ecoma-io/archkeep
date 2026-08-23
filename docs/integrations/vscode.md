# VS Code integration

The VS Code extension puts boundary diagnostics in the buffer, for the languages
ESLint cannot read. Open a `.go`, `.rs`, `.py` or `.vue` file in a workspace
and an import that crosses a boundary your tags forbid is underlined where you
wrote it — judged by the same boundary config your pipeline reads, by the same
engine. Same fifteen message ids, same constraint table; for anything decided at
an import site, the only difference from the CLI is when you find out.

## What the extension provides

| surface              | what it gives you                                                     |
| -------------------- | --------------------------------------------------------------------- |
| Diagnostics at edit  | Boundary violations appear as you type, not an hour later in CI       |
| Language status item | Shows whether the server is running, not running, or has no workspace |
| Log output           | Every path the extension searched, and the server's own output        |

What the server deliberately does not publish are the CLI's three
workspace-level checks — go.work drift, dead tsconfig path aliases, and
declared-edge (`implicitDependencies`) violations — because a finding that
describes the workspace stays out of whichever file happens to be open. The
third is workspace-level for the same reason even though it does name a file:
the manifest that declared the edge is not a source this server analyzes, and
underlining a `project.json` for a dependency someone declared elsewhere would
put the report where its fix is not.
[languages.md](../reference/languages.md) owns the first two and the reasoning;
[checking.md](../usage/checking.md) lists all three beside the rest of what
`check` folds in.

## How it works

The extension is a client and nothing else. All the analysis lives in
`@ecoma-io/lattice`, which ships a language
server; what is here starts that server, tells it where the workspace root is,
and shows you whether it is running.

### The server is the workspace's, not the extension's

This is the one design decision worth knowing before you file a bug against it.
The extension resolves `@ecoma-io/lattice` out of the workspace — not a copy
bundled inside the extension. A bundled server would be pinned to whatever was
published to the marketplace, while your CI runs whatever is in your lockfile.
Two versions of an analyzer, both confident, judging the same import — and the
failure mode is not a crash. It is a buffer that reads clean for a file the
pipeline is about to reject, or the reverse.

If the package is not installed, the extension says so instead of falling back
to a copy of its own.

## Two settings

| setting                | default | what it does                                                            |
| ---------------------- | ------- | ----------------------------------------------------------------------- |
| `lattice.server.path`  | `""`    | Path to an `lsp.mjs`; relative paths resolve against the workspace root |
| `lattice.trace.server` | `off`   | Logs the LSP conversation to the Lattice output channel                 |

`lattice.server.path` overrides the workspace lookup, and exists for people
working on the server itself. A path that does not resolve is reported rather
than ignored: the extension will not quietly run a different server than the one
you named.

## What it refuses

Two things about this extension are refusals rather than omissions, and both are
worth knowing because they are easy to mistake for missing features.

### No enable/disable switch

There is no `lattice.enable` setting. A workspace with the checker switched off
produces a report byte-for-byte identical to a workspace whose code is clean —
which is the silence this project exists to end. If the extension is wrong about
your workspace, that is a bug worth reporting; if it is noisy, the boundary
table is where the decision belongs. Uninstalling is always available and,
unlike a setting, is visible.

What the extension does have is a language status item that says, in as many
words, when nothing is being checked — the editor's version of the CLI's
_no verdict_ exit code.

### No bundled server

Covered above under _The server is the workspace's, not the extension's_. The
short argument: a bundled copy pinned to a marketplace release could disagree
with CI about the same import, and both would report confidently.

## Extension routing

The extension activates for four file extensions, matched by filename pattern
rather than by language id — a `.go` file is routed on a machine with no Go
extension installed:

| extension | language |
| --------- | -------- |
| `.go`     | Go       |
| `.rs`     | Rust     |
| `.py`     | Python   |
| `.vue`    | Vue      |

TypeScript and JavaScript are not on that list. An editor gives one language
server per file extension — the first registered wins — so claiming `.ts`
would silently displace whichever TypeScript server the developer actually
needs, in order to re-answer a question `@nx/enforce-module-boundaries` already
answers through ESLint. `.vue` is claimed anyway, as a second opinion on the
one extension both enforcers cover.

The routed list is held to the engine's own analyzer registry by an integration
test (`packages/lattice/src/lsp/editor-config.integration.test.mjs`), so a
language cannot arrive in the engine and stay invisible in the editor.

## Installation

### VS Code marketplace

Not on the marketplace yet. The missing piece is the publisher account, not the
pipeline. CI packages the `.vsix` on every pull request and verifies an install
would hold what it needs; every release uploads the verified `.vsix` to the
GitHub release.

### From a .vsix

Install the `.vsix` attached to the `lattice-vscode-v*` release on GitHub:

1. Download the `.vsix` file
2. In VS Code: **Extensions: Install from VSIX...**
3. Select the downloaded file

Or run from a development host for local development.

## Claude Code

One-time install, from this repository's marketplace:

```shell
claude plugin marketplace add ecoma-io/lattice
claude plugin install lattice@lattice
```

After that, a session editing a `.go`, `.rs`, `.py` or `.vue` file gets boundary
diagnostics in the conversation. Node must be on `PATH`; nothing else is
installed.

Claude Code gives one server per extension, so the same TypeScript and
JavaScript exclusion applies as for VS Code — claiming `.ts` would displace the
TypeScript server a developer needs.

## Other LSP clients

The server is a plain stdio LSP executable. Any LSP client can connect to it
without going through this extension.

|                         |                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| command                 | `node <workspace>/node_modules/@ecoma-io/lattice/lsp.mjs`                                                                                                                                                                                                                                                                                                                                                        |
| transport               | stdio                                                                                                                                                                                                                                                                                                                                                                                                            |
| `initializationOptions` | `{ "workspaceRoot": "<workspace>" }` — only when the editor's root is not the workspace root                                                                                                                                                                                                                                                                                                                     |
| watched files           | the boundary config, the tsConfig, `**/project.json`, `**/nx.json`, `**/lattice.json`, and the three that WAIVE a verdict rather than produce one -- `**/package.json` (`declaredPackages`, `entryPoints`) and `**/module-federation.config.{js,ts}` (`mfeRemote`). Unwatched, a deleted Module Federation config or a dropped dependency left the running session holding the waiver until the editor restarted |

The workspace root is taken from `initializationOptions`, then
`workspaceFolders`, then `rootUri`, then `rootPath`, then the working directory
— the first that answers. Supply it explicitly if your editor opens a
subdirectory, because the root decides which boundary config is read and a wrong
one reports green against rules nobody wrote.

**Capabilities are deliberately few.** Only full text synchronisation is
advertised: no hover, no go-to-definition, and no incremental sync. A
capability is a promise, and incremental sync stays unadvertised until it can be
proven correct — one mis-applied ranged edit puts every later diagnostic on the
wrong line, confidently.

**File watching.** A client that supports dynamic registration is asked to watch
the five files above. A client that cannot register dynamically is told so on
stderr — if your diagnostics go stale after a config edit, that message is why,
and reopening the file re-runs the check.

**Which extensions to route** is your client's decision, not the server's. Most
editors allow several servers per buffer, unlike Claude Code, so routing `.ts`
alongside your TypeScript server is a supported thing to do — it just
duplicates what `@nx/enforce-module-boundaries` already tells you.

---

- The language server's guarantee and the one rule it exists to hold:
  [this page](.)
- What each analyzer reads, and the shapes it cannot:
  [languages.md](../reference/languages.md)
- The VS Code extension's own reference:
  `packages/lattice-vscode/README.md`

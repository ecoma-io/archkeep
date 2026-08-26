# Archkeep for VS Code

Module-boundary diagnostics in the buffer, for the languages ESLint cannot read.

Open a `.go`, `.rs`, `.py`, `.vue` or `.java` file in an Nx workspace and an import that
crosses a boundary your tags forbid is underlined where you wrote it — judged by
the same `module-boundaries.config.mjs` your pipeline reads, by the same engine.

This extension is a client and nothing else. All the analysis lives in
[`@ecoma-io/archkeep`](../archkeep/README.md), which ships a
language server; what is here starts that server, tells it where the workspace
root is, and shows you whether it is running.

## Requirements

- **VS Code 1.100 or newer.** The extension is ESM, and the Node extension host
  has loaded ESM extensions since that release. On an older version it does not
  load at all.
- **`@ecoma-io/archkeep` installed in the workspace you are editing.**
  Not bundled here — see below.
- **A workspace marker** (`archkeep.json` or `nx.json`) at or above the folder
  you opened.

```bash
pnpm add -D @ecoma-io/archkeep
```

## The server is the workspace's, not the extension's

This is the one design decision worth knowing before you file a bug against it.

A bundled server would be pinned to whatever was published to the marketplace,
while your CI runs whatever is in your lockfile. Two versions of an analyzer,
both confident, judging the same import — and the failure mode is not a crash. It
is a buffer that reads clean for a file the pipeline is about to reject, or the
reverse. So the extension resolves the server out of the workspace, and if it is
not there it says so instead of falling back to a copy of its own.

`archkeep.server.path` overrides the lookup, and exists for people working on the
server itself. A path that does not resolve is reported rather than ignored: this
extension will not quietly run a different server than the one you named.

## What it shows you

The whole interface is one language status item, visible in the status bar's
language popover when a routed file is open:

| what it says               | what it means                                                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Archkeep**               | The server is running against the named workspace root. An empty Problems panel here means no violations                                                                                                         |
| **Archkeep: not checking** | Shown as an error. The workspace is an Nx workspace and the server is not running — it could not be located, failed to start, or stopped after starting. The log says which, and lists every path that was tried |
| **Archkeep: no workspace** | There is no workspace marker (`archkeep.json` or `nx.json`) at or above this folder, so there is nothing here to check                                                                                           |

The middle row is the reason the item exists at all. In a terminal, a run that
could not look exits with a distinct code; in an editor there is nowhere to print
one, and a window where the server never started looks exactly like a window with
nothing to report. This project's whole premise is that those two must never look
alike.

## Settings

| setting                 | default | what it does                                                                                                                                                                                                                                                                            |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `archkeep.server.path`  | `""`    | Path to an `lsp.mjs`; relative paths resolve against the workspace root                                                                                                                                                                                                                 |
| `archkeep.trace.server` | `off`   | Logs the LSP conversation with the server to the Archkeep output channel. The channel's own log-level dropdown (the gear icon in the Output panel) is the master switch: tracing only appears when that dropdown is at **Trace**, and the setting then chooses `messages` or `verbose`. |

**There is no `archkeep.enable`,** and the omission is deliberate. A workspace with
the checker switched off produces a report byte-for-byte identical to a workspace
whose code is clean, which is the silence this project exists to end. If the
extension is wrong about your workspace, that is a bug worth reporting; if it is
noisy, the boundary table is where the decision belongs. Uninstalling is always
available and, unlike a setting, is visible.

## Commands

- **Archkeep: Restart the boundary server** — after installing the server package
  or changing the boundary config
- **Archkeep: Show the log** — every path the extension searched, and the server's
  own output

## Which files it routes

`.go`, `.rs`, `.py`, `.vue`, `.java` — matched by filename pattern rather than by
language id, so a `.go` file is routed on a machine with no Go extension
installed. TypeScript and JavaScript are left to
`@nx/enforce-module-boundaries`, which already reports them through ESLint;
routing them here would double every violation you see.

The list is held to the server package's own editor manifest by
`src/routed-extensions.integration.test.mjs`, so a language cannot arrive in the
engine and stay invisible in the editor.

## Status

Not on the marketplace yet, and the missing piece is the publisher account, not
the pipeline. CI packages the `.vsix` on every pull request and opens it to
prove an install would hold what it needs (`scripts/package-vsix.mjs` and
`scripts/verify-vsix.mjs` at the repository root). The extension is versioned
**with the repository** — one version for the engine and the client, written by
release-please's `extra-files` and held to each other by
`scripts/check-skills.mjs` — because a client that resolves the server out of
the workspace pairs with the engine it is released with, and one version makes
the pairing visible. Every release uploads the verified `.vsix` to the GitHub
release — installable today via **Install from VSIX**. The marketplace publish
step exists in the release lane but skips, loudly, until an `ecoma-io`
publisher account and its `ECOMA_VSCE_PAT` secret exist. `private: true` is there to
make `npm publish` refuse — this is an extension, not a package, and the
marketplace is its only destination.

## Development

Everything under `src/` is a pure function over injected inputs and is tested
without an editor; `extension.mjs` holds the VS Code wiring and nothing else, and
is excluded from coverage for the reason
[docs/development/testing.md](../../docs/development/testing.md) gives for
`cli.mjs` and `lsp.mjs`.

```bash
moon run archkeep-vscode:test
moon run archkeep-vscode:lint
```

Setup, commit format and how a change lands: [CONTRIBUTING.md](../../CONTRIBUTING.md).

## License

[Apache-2.0](../../LICENSE) — © Mai Ngọc Hóa (John Martin) and the Archkeep
contributors.

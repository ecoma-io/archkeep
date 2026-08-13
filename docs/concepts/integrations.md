# Integrations

How the core engine meets the tools a workspace already uses. Integrations are
at the edge on purpose: the engine's verdict is the same regardless of which
integration asked for it, and no integration can change a verdict — only how and
when it reaches the reader.

## The core integration contract

Every integration receives the same thing: the verdict, computed once. The
constraint table is read from the workspace, not from the integration's own
state. A CI step, an editor diagnostic, and a build-system hook all see the same
fifteen violation types, the same constraint rows, and the same coverage counts.

That contract has one direction: the integration is a consumer of the verdict,
never a participant in reaching it. An integration that held a copy of the
constraint table would be a second table, and the two would drift.

## The three surfaces

### The CLI

The verdict as an exit code, which is the only form CI can read. Its four codes
exist so a script can tell "your tree is dirty" from "the checker could not
look", and that distinction is the whole design.

### The language server

The verdict at the edit. It runs in any LSP client. What the server deliberately
does not publish are the CLI's two workspace-level checks — go.work drift and
dead tsconfig path aliases — because a finding that describes the workspace stays
out of whichever file happens to be open.

### The build system integration

The graph, contributed at computation time. On a workspace that uses a build
system, the engine contributes polyglot dependency edges into the project graph,
so that dependency-aware features (affected-project detection, task scheduling)
work for every language, not just the ones the build system already infers.

## What an integration never does

- **Never edits the constraint table.** The table is code in the repository,
  reviewed like code.
- **Never holds a copy.** A bundled analyzer or a cached constraint would
  disagree with the workspace's own, and both would report confidently.
- **Never softens the verdict.** An integration may present it differently —
  SARIF for code scanning, diagnostics for the editor — but it never turns a
  finding into a warning or an exit-3 into a clean run.
- **Never switches a language off.** A report from a workspace that disabled a
  language would be byte-for-byte identical to a report from a workspace whose
  code in that language is clean. That is the silence this engine exists to end.

## Current integrations

| integration | what it provides                                                                         |
| ----------- | ---------------------------------------------------------------------------------------- |
| Nx          | Polyglot edges in the project graph, `affected` integration, workspace layout            |
| VS Code     | Diagnostics at the edit, language status item, resolved from the workspace's own install |

Future integrations — Bazel, Turborepo, other editors — arrive with their own
implementation. A placeholder page naming an integration that does not exist yet
is a promise the codebase cannot keep, and this repository forbids them.

---

- The Nx integration in detail → [../integrations/nx.md](../integrations/nx.md)
- The VS Code integration in detail → [../integrations/vscode.md](../integrations/vscode.md)
- The principles that govern integrations → [../doctrine/principles.md](../doctrine/principles.md)

---
id: 0001-boundary-levels
status: accepted
bindings:
  - type-package
  - type-extension
---

# The engine and its extension enforce their boundary levels

## Status

Accepted — this records a boundary the workspace already enforces, so the
observation the intent / constraint rows name is grounded in the record instead
of floating.

## Context

The workspace ships two products from one tree: the engine (`packages/lattice`)
and its VS Code extension (`packages/lattice-vscode`). The engine ships to npm
and is resolved out of the workspace; the extension ships to a marketplace and
resolves the engine's server out of the workspace. Their dependency direction
is one-way: the extension reaches the engine, and the engine must never reach
into the extension — an engine import of `packages/lattice-vscode` would
resolve nothing on a consumer's disk.

`module-boundaries.config.mjs` enforces this with two `depConstraints` rows:
`type-package` forbids importing anything that is not a `type-package`
(`onlyDependOnLibsWithTags: ["type-package"]`), and `type-extension` forbids an
extension importing anything that is not a `type-package`, so an engine (
`type-package`) row can never reach an extension. Every `decisionRef` naming
this record points at those two bound rule ids.

## Decision

Keep the engine below the extension: the engine's tag axis is
`type-package`, its import surface stays within `type-package`, and the
extension's `type-extension` axis may import only `type-package`. No command
writes or rewrites this record — authoring an ADR is a human decision, and
`lattice adr` reads it only. Changing the boundary this record grounds is a
governance decision, reviewed like code.

## Consequences

- An engine import reaching the extension is a violation under the bound
  `type-package`/`type-extension` rows.
- The extension's required presence is part of the workspace's declared intent
  (`architecture-intent.json`), and the intent rows that carry a `decisionRef`
  naming this record lean on the same boundary.
- A superseding ADR is how this record stops binding its rows — a record whose
  status is `superseded` still binds until a replacement is authored.

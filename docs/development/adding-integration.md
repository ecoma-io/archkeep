# Adding an integration

How a new integration extends the core, and the contract it must hold.

The core engine (`packages/lattice/`) is independent of any build system or
editor. Integrations sit at the edge, consuming the engine's public surface
without leaking their own concerns into it. The direction this follows is in
[../doctrine/north-star.md](../doctrine/north-star.md):

> **Integrations belong at the edge.**

## The contract

An integration may read the engine's output. It may not change the verdict.

That is the same invariant the report layer holds: a formatter that filtered
would be a rule wearing a formatter's name. An integration that suppressed a
diagnostic, or injected a fake one, would make the engine's claim untrustworthy
from outside that integration — and a consumer has no way to tell which one
they are reading.

Three rules that follow:

1. **An integration never ships a second copy of the boundary rules.** The
   constraint table has one home: the file at the workspace root. An
   integration that re-read it, or re-implemented a subset, would disagree the
   day the real table changed.

2. **An integration never shells out on behalf of the engine.** The engine is
   static analysis by design — it reads tracked files only, so the graph
   computes on machines without the language toolchains. An integration that
   added a `go list` or `cargo metadata` call would break that property.

3. **An integration's version is its own, not the engine's.** The VS Code
   extension updates independently of the npm package, because it ships to a
   marketplace on its own cadence. The extension resolves the server from the
   workspace rather than bundling it, so a marketplace-pinned analyzer could
   disagree with the workspace's own — and both would report confidently. The
   resolution is in the extension's hands; the engine's is not.

## The two integrations today

### Nx plugin

`packages/lattice/nx.mjs` is the entry Nx loads. It is a re-export only — no
logic, because Nx loads it on every `nx` invocation and logic here would slow
every graph computation the workspace runs.

The plugin contributes polyglot edges through `createDependencies`, and it
validates its options on every call. An unknown option key throws, because a
typo that quietly fell back to the default would produce a full green run
against a rule nobody wrote.

See [../integrations/nx.md](../integrations/nx.md) for the consumer-facing
guide.

### VS Code extension

`packages/lattice-vscode/` is the client. It finds the workspace root, finds
the server the workspace installed, starts it over stdio, and shows whether it
is running. It contains no analysis.

Two things worth knowing about its structure, both mirroring cuts the engine
makes: `extension.mjs` holds VS Code wiring only, so every decision lives
under `src/` as a pure function that a test drives without an editor; and the
server is resolved from the workspace rather than bundled, which is the version
invariant described above.

See [../integrations/vscode.md](../integrations/vscode.md) for the
consumer-facing guide.

## What a new integration would need

1. **A reason that is not already covered.** The engine already runs from the
   CLI and from a language server. A new integration reaches a new surface — a
   different editor, a different CI platform, a different graph consumer.

2. **A way to consume the engine without coupling to its internals.** The
   engine's public surface is its CLI output, its LSP diagnostics, and the Nx
   plugin hook. An integration that reached into `src/` would break when the
   engine's layers move.

3. **Its own test surface.** The engine's test suite does not cover
   integrations. An integration that fails silently — showing nothing when the
   engine reported a violation — is the same defect class as an empty result.

4. **A page in `docs/integrations/`.** No promise pages — an integration ships
   with its documentation or it does not ship.

## What must not land

- **An integration that changes the verdict.** The engine is the authority; an
  integration is a surface.
- **An integration that bundles the engine.** Version drift between the bundled
  copy and the workspace's own is the defect bundling creates.
- **An integration that depends on a sibling package.** Each integration stands
  alone. The engine depends on nothing outside its declared list; an
  integration should not change that.

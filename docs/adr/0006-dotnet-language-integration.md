---
id: 0006-dotnet-language-integration
status: accepted
---

# C#/.NET enters through the existing seams, behind one shared dotnet core

## Status

Accepted. Written before the first line of its mechanism, in the order
[development/adding-a-language.md](../development/adding-a-language.md)
requires, as [ADR 0005](0005-jvm-language-integration.md) was — that record's
Decision 1 already named this day: "A third frontend (a future C#/.NET) reuses
the same mechanics." This record is the boundary that mechanism lands inside.

## Context

Archkeep reads Java and Kotlin beside TypeScript, Vue, Go, Rust and Python.
.NET is the enterprise monorepo language none of them cover: `.cs` sources are
invisible to the graph, to enforcement, and to editor diagnostics, while every
.NET-native architecture tool (ArchUnitNET, NetArchTest, Roslyn analyzers)
operates inside one compiled solution at test time — a horizon that ends where
a polyglot monorepo begins.

The alternatives were considered and rejected with reasons:

- **Roslyn in the engine** requires an installed .NET SDK on every machine
  that computes a graph — lint-only CI boxes and contributors without .NET
  break — and evaluation loads MSBuild logic from the judged repository into
  this process. It buys symbol-level precision no rule consumes: all fifteen
  violations are decided on `{source, target}` pairs plus tags. Rejected for
  graph computation permanently; an external opt-in sidecar outside the exit
  code contract is the only admissible future shape.
- **MSBuild evaluation** (`dotnet msbuild -getProperty/-getItem`,
  Buildalyzer) executes import logic from the judged tree — property
  functions, inline tasks — turning analysis into arbitrary-code execution of
  its own input. Static inspection covers what boundary edges need: literal
  `<ProjectReference>` paths and written `using` directives.
- **Solution-centric discovery** models `.sln`/`.slnx` membership, which are
  optional, non-exclusive build-orchestration views carrying no boundary law.
  A project referenced by zero solutions is still a governed project.
- **A second dotted-name stack** duplicating the JVM package index, mask,
  and failure funnel would drift exactly the way two copies always drift.

## Decision

1. **One shared dotnet core, thin language frontends.** The C# lexical mask,
   the namespace index, csproj reading, and the manifest failure funnel live
   under `src/analysis/dotnet/`; `csharp.mjs` owns only C#'s extraction forms
   and limits. F# (`open`) and VB.NET (`Imports`) become line items later,
   not projects — they reuse everything under `dotnet/` and add extraction
   forms. The JVM core is mirrored, not imported: the families share the
   _disciplines_ (length-preserving masking, content-derived dotted-name
   index, longest-prefix resolution, fail-loud manifests) because their
   literal grammars genuinely differ, and a parameter table wide enough to
   average them would misread both.
2. **Identity anchor: one `*.csproj` per project root.** csproj filenames are
   arbitrary, so native inference adds a directory rule — a tracked `.csproj`
   under `obj/`/`bin/` never counts, and two `.csproj` files in one directory
   are an ambiguous-model failure naming both, never a guess. Nested csproj
   draw no graph edge from the reader while analysis still attributes their
   sources — the documented modeling limit every manifest family shares.
   Solutions, target frameworks, assemblies, NuGet packages, and source sets
   are not nodes: the model stops at Project ([ADR 0005](0005-jvm-language-integration.md),
   Decision 3, extended verbatim).
3. **Edges keep the two-track split, path-based.** `<ProjectReference>` draws
   a declared edge by resolving the written path (Windows separators
   normalized) to the project whose root contains it; containment escapes and
   placeholders that do not statically resolve become positioned failures.
   `using` sites produce source records independently. Conditions on
   references are taken loudly — including a conditionally-absent reference
   draws a possibly-spurious edge, which is the self-correcting direction;
   excluding risks the silent one. `<PackageReference>` classifies external
   by package id only; versions are read for nothing, so Central Package
   Management changes nothing.
4. **Static inspection only, permanently for graph computation.** No
   `dotnet`, `msbuild`, or Roslyn process is ever spawned by the engine, and
   no restore output (`packages.lock.json`, `project.assets.json`) is read —
   verdicts may not depend on whether someone ran restore before committing.
   Implicit usings are per-project MSBuild data, not language constants: the
   SDK-fixed set classifies external by default (a tracked project declaring
   itself as `System.*` resolves through the namespace index like any other
   name), and per-project `<Using Include>` items ride the csproj reader.
5. **C# namespace semantics, made explicit.** Namespaces are declared in
   source and indexed by content, like JVM packages; unlike Java packages, a
   namespace spanning assemblies is ordinary, so the index supports multiple
   owners per name — but resolution stays single-answer-or-fail: the deepest
   declared prefix with one owner resolves; a genuine tie at the deepest
   prefix is an ambiguity failure naming every claimant, because picking by
   classpath order is compiler behavior this static reader does not model.
6. **The silent directions are named, pinned by tests, and compensated.**
   Attribute type references without a using, fully-qualified names used
   inline, reflection, and `#if`-divergence across target frameworks are
   invisible to directive extraction; each is documented as a limit whose
   compensation is the manifest track and tag law. Generated output under
   `obj/`/`bin/` is excluded even when tracked; committed generated files are
   analyzed like any source, because a generated proxy crossing a boundary is
   precisely a violation someone wants caught.

## Consequences

- Registering `.cs` adds findings to unchanged consumer workspaces — a
  breaking change by this repository's definition, shipped with prominent
  notes like every language before it.
- XML parsing rides the one hardened parser the JVM series introduced:
  `fast-xml-parser` as exact-pinned optional peer, lazy-loaded, entity
  processing off. No second parser, no new dependency.
- On Nx trees, `@nx/dotnet` (GA in Nx 23) contributes the nodes when present;
  archkeep's hook contributes the edges either way. On machines without the
  .NET SDK, `@nx/dotnet`'s MSBuild analyzer can degrade — native discovery is
  the posture that keeps governance alive there, and the integrations docs
  state both truths.
- Moon has no .NET discovery today (moonrepo/moon#2447); a Moon-rooted pure-
  .NET workspace should prefer the native provider until moon grows one.
  Where Moon does report the projects, archkeep's edges merge unchanged.

---
id: 0005-jvm-language-integration
status: accepted
---

# Java and Kotlin enter through the existing seams, behind one shared JVM core

## Status

Accepted. This record was written before the first line of its mechanism, in
the order [development/adding-a-language.md](../development/adding-a-language.md)
requires, so that every later JVM pull request lands inside a boundary that
already exists rather than negotiating one after the code arrives.

## Context

Archkeep reads five languages today, each through the same three doors: an
extension registration, an analyzer written to the frozen analysis contract,
and a graph resolver following the shared `resolve(projects, filesOf, readFile)`
shape. Java and Kotlin are the first languages to arrive as a family: they
share one build-system surface (Maven, Gradle), one package namespace at
project granularity, and one identity problem — neither language requires
directory = package, so neither can borrow Python's layout-derived import
roots unchanged.

The alternatives were considered and rejected with reasons:

- **Two independent stacks** duplicate the correctness-critical machinery
  (package index, ambiguity handling, default-import tables, manifest
  resolvers) and drift.
- **One monolithic "JVM analyzer"** collapses the per-language gates this
  repository binds itself to — limits headers, completeness cells, release
  units — and would force one language's release to wait for the other.
- **JVM-hosted parsers** (JavaParser, JDT, PSI) require a toolchain on every
  machine that computes a graph, which the static-analysis-by-design
  constraint forbids (`docs/reference/languages.md` owns the measurements).

## Decision

1. **One shared core, two thin frontends.** Package-index construction,
   dotted-name resolution, per-language default-import tables, and Maven/
   Gradle manifest readers live under `src/analysis/jvm/`; `java.mjs` and
   `kotlin.mjs` own only their extraction forms and their limits. A third
   frontend (a future C#/.NET) reuses the same mechanics.
2. **Identity anchors follow the manifests.** A Maven project is identified
   by `(groupId, artifactId)` from `<projectRoot>/pom.xml`; a Gradle project
   by its settings-file directory mapping. One manifest per project root
   stays the modeling assumption; a nested second manifest yields no graph
   edge while analysis still attributes the file — the documented limit,
   unchanged for JVM trees.
3. **The model stops at Project.** Packages are index entries, never nodes;
   JPMS modules, source sets, profiles, and dependency versions are not
   modeled. Every rule archkeep evaluates consumes `{source, target}` pairs
   plus tags, and nothing JVM-specific widens that input.
4. **Edges keep the two-track split.** Manifest-declared dependencies draw
   edges under each ecosystem's real semantics (Maven coordinate matching;
   Gradle `project(":x")` and catalog coordinates); source imports produce
   findings independently. A declared-but-unused dependency and an
   undeclared-but-imported one are both findings, exactly as the other
   languages state it.
5. **Static inspection only, permanently for graph computation.** No Maven,
   Gradle, or JDK process is ever spawned by the engine. Boundary edges need
   `(groupId, artifactId)` matching only — never versions — so BOMs,
   `dependencyManagement`, mediation, and profile activation are out of scope
   by construction, not by omission.
6. **The silent directions are named, pinned by tests, and compensated.**
   Multi-line import statements, fully-qualified names used without an
   import, and same-package cross-project references are invisible to
   header-region extraction; each is documented as a limit with its
   compensating backstop (source-level analysis catches what manifest edges
   miss, and vice versa). An unreadable manifest fails loudly rather than
   reading as empty.

## Consequences

- Adding `.java`/`.kt` changes what is reported on unchanged consumer
  workspaces — new violations appear without code changes. That is a breaking
  change by this repository's definition and ships with prominent notes.
- The dispatcher throw is the designed intermediate state within a merge
  series: registration may briefly precede its analyzer, but no released
  version contains a claimed language without one.
- External packages (Maven Central, Gradle plugin portals) stay out of the
  graph, classified through the existing external-node synthesis when a rule
  needs a name.
- A future tree-sitter tier would replace parsing inside the frontends only;
  no contract, rule, provider, or report changes.

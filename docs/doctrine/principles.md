# Principles

The binding principles of Archkeep. Each is stated as an imperative and each
refuses something concrete — a direction the project will not take even when the
alternative is inconvenient. They are not aspirations; they are enforced by code,
by tests, or by the structure of the repository itself. Where a principle has a
mechanism, the file that owns the mechanism is linked.

## 1. Architecture must be executable

Architecture that cannot be checked by a machine is documentation that looks like
enforcement. A workspace whose projects carry `layer:` and `scope:` tags that no
tool reads has boundaries in name only — the tags are decoration until something
refuses an import that crosses them. Archkeep exists because Nx's boundary
enforcement covers TypeScript and JavaScript and covers nothing else, and
"nothing else" on a dashboard is identical to "clean". This principle refuses
architecture that lives only in diagrams and decisions.

## 2. A green result must mean something

An empty diagnostic list must mean "no violation", and nothing else. A checker
that returns green when it could not look is worse than no checker: it replaces a
known gap with an unknown one, wearing a checkmark. The CLI distinguishes exit 3
(could not look) from exit 0 (looked and found nothing); the language server
publishes an empty list from exactly two named places. This principle refuses
every code path that cannot reach a verdict and returns empty instead of saying
so. [architecture-governance.md](architecture-governance.md) owns the contract
and the mechanisms that enforce it.

## 3. Unknown must never masquerade as valid

When an analyzer encounters a shape it cannot read, the worst case must be a
spurious record naming text the file really contains — never a silently dropped
import. Every known parse limit is written in the analyzer's header in the same
commit that introduces the limit, and every test has a case that goes red in the
silent direction. This principle refuses the convenience of silently skipping
what cannot be parsed.

## 4. Enforcement must be deterministic

The same workspace, the same config, the same source tree must produce the same
verdict on every run. An enforcement whose result depends on which toolchains
happen to be installed, or which machine runs it, is an enforcement whose green
proves nothing. Resolvers read tracked files only and never shell out to
`go list`, `cargo metadata` or `uv` — a graph that needs a toolchain installed
fails on the machine that does not have it. This principle refuses convenience
that trades determinism for coverage.

## 5. The core must not depend on a build system

Archkeep reads source files and manifests, not build outputs. It does not invoke
compilers, package managers, or language toolchains to answer a question about
imports, because Nx computes the graph on every invocation and a graph that needs
a build step fails in lint-only CI. The shipped artifact is loadable with no
build step in the way — neither package declares a `build` target because there
is nothing to emit. This principle refuses any dependency that makes the
enforcer's reach narrower than the workspace's.

## 6. Integrations belong at the edge

The boundary rules read records and never learn which language produced them; the
analysis layer reports import sites and never judges them; the report layer
renders and decides nothing. The Nx integration, the CLI, and the language server are
three faces of the same engine, each composed from the same layers. A layer that
reaches across its boundary — an analyzer that filters its own output, a
formatter that decides what counts as a violation — is a rule wearing the wrong
name. This principle refuses entanglement that makes a change in one surface
break the verdict in another.

## 7. Agents are consumers of architecture, not its authority

An agent that can edit code can violate a boundary as easily as a human can, and
faster. The architecture's enforcement must be a fact the agent reads, not a
suggestion it may ignore. The constraint table is code in the workspace, reviewed
like code, and anything that edits it from outside the repository — a dashboard,
a hosted service, an agent prompt — breaks the property that makes it
trustworthy. This principle refuses any path that makes architecture a
conversation rather than a contract. [agentic-development.md](../concepts/agentic-development.md)
shows how the current commands keep the agent on the consumer side of that line,
and [architecture-authority.md](architecture-authority.md) owns the full boundary —
what Archkeep is, what it is not, and the line its neighbours may not cross.

---

The seven principles are not independent. The first demands that architecture be
checked; the second and third demand that the check be honest; the fourth and
fifth demand that it be reproducible; the sixth and seventh demand that it stay
honest as it grows and as its consumers change. A violation of any one weakens
the others, and the order above is the order in which a drift would most likely
appear — the same order [north-star.md](north-star.md) gives for the signals
that the invariant is eroding.

# Principles

The commitments that hold whether the code around them changes or not. Each one
is a decision this project has already paid for, not an aspiration — and a
proposal to remove one is a change of direction rather than a cleanup.

## 1. Architecture must be executable

Architecture today lives in documents that nothing executes and nothing checks.
The code drifts from them silently, and the drift compounds fastest exactly
where review is thinnest. Lattice's answer is to make the architecture itself
machine-readable and its enforcement deterministic, so that "the boundary holds"
is a verdict a pipeline computes rather than a belief a reviewer holds.

## 2. A green result must mean something

An empty diagnostic list must mean "no violation", and nothing else. A checker
that could not look must never be mistaken for one that looked and found nothing
— that single distinction is what makes the tool trustworthy, and every other
principle follows from it.

The two error directions are unequal: a false alarm gets argued about and fixed,
while a missed violation is byte-for-byte identical to a clean workspace and
nobody files anything. Every design decision erring on one side errs toward loud.

## 3. Unknown must never masquerade as valid

A file that could not be analyzed, a specifier that could not be resolved, a
configuration that could not be read — each of these is reported as a declared
gap, not silently dropped. A tool that returns empty on those paths would be
worse than nothing: it would replace a known gap with an unknown one, wearing a
green checkmark.

This is why the CLI has an exit code for _could not look_ that is distinct from
_looked and found nothing_, and why the language server refuses to publish an
empty diagnostic list from anywhere except two named places.

## 4. Enforcement must be deterministic

The same tree and the same model always produce the same answer. No timestamps,
no random identifiers, no order that depends on filesystem enumeration. The JSON
envelope is byte-identical across two runs over an unchanged tree, which is what
makes it diffable in a pull request the same way the SARIF output already is.

Determinism is also why the rules layer is pure: records and config in,
violations out. No filesystem, no git, no network. A rule that reached for a
file would become a second, weaker analyzer.

## 5. The core must not depend on a build system

The engine discovers projects, builds the dependency graph and judges boundaries
from its own model. Nothing invokes a language toolchain to answer a question
about imports — manifests are parsed as data, sources are read as text — because
a graph that needs four toolchains installed is a graph that fails on the
machine that does not have them.

A build system is one provider of the project model, not its foundation. A
workspace that has one gets graph reuse and integration benefits; a repository
that has never heard of it loses nothing.

## 6. Integrations belong at the edge

The core engine holds one constraint table, one set of fifteen violation types,
one analysis pipeline. Every integration — editor, CI platform, build system —
is a consumer of that verdict, never a participant in reaching it. The
constraint table lives in the consumer's workspace, reviewed like the code it
governs, and nothing in this project holds a copy.

A second copy of the constraint is the drift this tool exists to prevent. A
bundled analyzer could disagree with the workspace's own about the same import,
and both would report confidently.

## 7. Agents are consumers of architecture, not its authority

An agent that proposes a change asks "what does this reach?" at a rate no
reviewer can match. An architectural boundary that only exists inside one
language's linter is a boundary the agent will cross without ever seeing a
warning. The rules here are the ones that survived contact with that problem.

But an agent is still a consumer of the verdict, never an author of it. The
constraint table is code in the repository, reviewed like code, and anything
that edits it from outside the repository breaks the property that makes it
trustworthy. An agent may flag drift; it may not silently fix it.

---

- Where these principles are going → [north-star.md](north-star.md)
- What "architecture must be executable" looks like in practice → [../concepts/architecture.md](../concepts/architecture.md)
- The staged path from here to there → [../roadmap.md](../roadmap.md)

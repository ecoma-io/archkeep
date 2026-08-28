# North star

Archkeep is an architecture governance system for human and agentic software
development — a deterministic authority that keeps the intended architecture
aligned with the observed architecture while humans and agents continuously
change the codebase.

Agentic coding increases the rate at which architectural decisions are made.
Humans cannot manually review every architectural decision. Therefore the
architecture must become explicit, machine-readable, continuously checked,
available to agents, and enforceable. That is what this project builds: not a
dependency graph, not an architecture linter, not a plugin — the authority a
repository consults for "does the code that exists agree with the architecture
that was declared".

Where Archkeep is going, what counts as arriving, and what it will not do on the
way. This document owns the direction. It owns no mechanism — where a claim here
has a mechanism behind it, the file that owns the mechanism is linked, and that
file is the one that binds. [architecture-authority.md](architecture-authority.md)
owns the system boundary: which of the surrounding pieces — providers, skills,
agents, CI — are Archkeep, and the line none of them may cross.

The direction is wider than it was when this document was written. Archkeep
started as an Nx plugin closing one instance of the gap — module boundaries for
the languages ESLint cannot parse — and the engine underneath was always bigger
than the integration around it. Today it is a standalone governance system that
works in any repository, with or without Nx or Moon, and
[roadmap.md](roadmap.md) owns that path. What this document says below
remains the engine's direction: the sentence, the finish line per language, the
refusals. Nx appears in it as the concrete example it was written against — one
provider among the integrations, not the foundation.

## The sentence

**Every language in a repository should have the same architectural
enforcement as the TypeScript and JavaScript in it.**

Not similar enforcement. The same: the same fifteen violation types, the same
eight options, the same constraint table, the same message ids — so that
"boundary" means one thing in a workspace rather than one thing per language.

For TypeScript and JavaScript, an Nx workspace already has an enforcer
(`@nx/enforce-module-boundaries`) and a graph that decides what `affected`
rebuilds — but only for those two. A Go service, a Rust crate and a Python
package carry `layer:`, `scope:` and `license:` tags that match no mechanism at
all, and the graph that decides what `nx affected` rebuilds has no edge between
any two of them. Archkeep exists to close that — and, because its model is
provider-independent, to do it in a Moonrepo workspace or a repository with no
workspace tool at all, not only in an Nx one. The target state is closure
across the board — not across three languages that happened to be needed first.

## What arriving looks like

A language is **finished** in Archkeep when all four of these are true. Anything
less is a language that is partly supported, and partial support is worth saying
out loud rather than implying with a checkmark.

|                     | what it means                                                                                                                    | who proves it                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Edges**           | Changing a project marks its dependents affected, from that language's own manifests                                             | `src/graph/`, and the integration test over a real Nx context |
| **Enforcement**     | All fifteen violation types reachable, judged on records the rules layer cannot tell apart by language                           | `src/rules/`, driven from that language's fixtures            |
| **Editor**          | A violation is a diagnostic at the edit, not a CI failure an hour later                                                          | the extension registry and `src/lsp/`                         |
| **Declared limits** | Every shape the parser cannot read is written down, and every one of them errs toward a spurious record rather than a missed one | the analyzer's own header, pinned by tests                    |

Against that bar, the state today:

| language                  |        edges        | enforcement |          editor          | limits declared |
| ------------------------- | :-----------------: | :---------: | :----------------------: | :-------------: |
| Go                        |         ✅          |     ✅      |      LSP · VS Code       |       ✅        |
| Rust                      |         ✅          |     ✅      |      LSP · VS Code       |       ✅        |
| Python                    |         ✅          |     ✅      |      LSP · VS Code       |       ✅        |
| TypeScript and JavaScript |      Nx's own       |     ✅      | deliberately not claimed |       ✅        |
| Vue                       |      Nx's own       |     ✅      |      LSP · VS Code       |       ✅        |
| Java                      | `pom.xml` + imports |     ✅      |      LSP · VS Code       |       ✅        |
| Kotlin                    |  shared with Java   |     ✅      |      LSP · VS Code       |       ✅        |

_LSP_ means any LSP client reaches the diagnostics; Claude Code does, from this
repository's own marketplace. _VS Code_ means `packages/archkeep-vscode`, which
routes the same five extensions and starts the server the workspace has
installed. The cell is not a checkmark because that client is not on the
marketplace yet: it runs from a development host or the `.vsix` CI builds,
verifies and attaches to each of its releases, so a developer who does not
already run an LSP client still has a manual install to perform. What is
missing there is no longer a publisher account — the account exists and the
release lane publishes through it — but the marketplace carries no prerelease
versions, so the listing starts at the stable cut;
[integrations/vscode.md](../integrations/vscode.md) owns that status.

Two cells are refusals rather than gaps, and both are argued where they are
implemented. Nx already infers TypeScript and JavaScript edges, so a second
inference would be a second answer to a question that has one. And an editor
gives one language server per file extension, so claiming `.ts` would displace
the TypeScript server a developer actually needs in order to re-answer a question
ESLint already answers — which is why the server routes every extension the
analyzer registry knows _except_ the TypeScript and JavaScript family, a list
`src/lsp/editor-config.integration.test.mjs` fails on the day it and the
registry disagree.

## How the next language earns its place

Breadth is the goal, and breadth is also the way this project could quietly stop
being trustworthy: seven analyzers that each half-read their language would report
clean far more often than they report correctly, and every one of those clean
reports would look exactly like the enforcement working.

So a language does not arrive because it is popular. It arrives when it can clear
the bar in the table above, and the order is decided by one question — **is there
a real workspace that will run it?** A language added ahead of its first user is
a set of parse limits nobody has ever met, tested against fixtures written by the
same person who wrote the parser.

Three consequences worth stating, because each has already been a temptation:

- **A language ships complete or not at all.** Edges without enforcement is the
  state Nx is already in, and it is the state this project was built to end.
  Shipping it under Archkeep's name would be worse than not shipping it, because
  it comes with the implication that the boundary is now covered.
- **An analyzer that cannot read a common shape says so in its header, in the
  same commit.** Not in an issue, not in a follow-up. The limits sections in
  `go.mjs`, `rust.mjs` and `python.mjs` are the model: each names the shapes it
  misreads, and each argues that the worst case is a record naming text the file
  really contains rather than an import silently dropped.
- **No language gets a switch.** There is no `languages` option and there will
  not be one. A report from a workspace that turned Go off is byte-for-byte
  identical to a report from a workspace whose Go is clean, and a workspace pays
  nothing for a language it does not have — each resolver keys off a manifest
  that is not there. `src/options.mjs` carries the full argument.

## The surfaces

A language is how Archkeep reads a workspace; a surface is how a person reaches
the verdict. The surfaces are deliberately few, and each exists because a
different reader needs the answer at a different moment.

- **The CLI** — the verdict as an exit code, which is the only form CI can read.
  Its four codes exist so a script can tell "your tree is dirty" from "the
  checker could not look", and that distinction is the whole design. `context`
  and `impact` answer the questions an agent asks before editing: what is this
  project allowed to reach, and what depends on it?
  [agentic-development.md](../concepts/agentic-development.md) describes the
  three-question model.
- **The agent surfaces** — the same CLI, consumed machine-readably. Every
  command's `--format json` envelope is a versioned contract an agent can read
  without parsing prose, and the five `arch-*` skills teach an agent when to
  ask and how to act on the answer. An agent is a first-class consumer of the
  surfaces, never an authority over them.
  ([skills/overview.md](../skills/overview.md))
- **The language server** — the verdict at the edit. It runs in any LSP client;
  Claude Code installs it from this repository's own marketplace.
- **The editor extension** — the same server, packaged so a developer installs it
  without knowing what LSP is. `packages/archkeep-vscode` is that surface for VS
  Code; what is left is the marketplace listing, not the client.
- **The Nx integration** — the graph, computed on every `nx` invocation. It is the
  one surface with no user interface at all, and the one everything else depends
  on being cheap. One provider among the integrations, not the foundation.
- **The Moon integration** — the graph, read from `moon project-graph --json`.
  A Moonrepo workspace carries a `.moon/` or `.config/moon/` directory at its
  root; Archkeep reads the same project graph Moon already computed, the same
  one-call contract the Nx provider follows.

What is _not_ on that list, and is not planned: a dashboard, a hosted service, a
rule authoring UI. The constraint table is code in the workspace, reviewed like
code, and anything that edits it from outside the repository breaks the property
that makes it trustworthy.

## The three conditions

There is one measurable finish line already written down, and it is not this
document's to restate: `src/conformance/README.md` § _What this licenses_ states
the three things that have to be true before a workspace can drop
`@nx/enforce-module-boundaries` and run Archkeep alone. All three now have a
mechanism holding them; what remains open is breadth of evidence, not a missing
feature:

1. no false negative the suite has not declared and explained — **met**, and held
   by a test that fails both when a new one appears and when a declared one is
   fixed without the ledger moving;
2. the deliberately-stricter list stays a decision rather than a surprise —
   **met**: both adapters now populate every fail-closed graph field from the
   files upstream reads, with the residue named where that condition is stated;
3. the differential runs against real trees, not only against fixtures —
   **met in mechanism**: `scripts/differential-real-trees.mjs` runs both
   engines over public Nx workspaces pinned at fixed commits, weekly and on
   demand, with the scope and residue stated where that condition is.

The third is the one that matters most at platform scale, and it gets harder with
every language added — which is the honest cost of choosing breadth. A suite of
fixtures proves the rules agree about the situations someone thought to build.
Only a real tree proves they agree about the situations nobody thought of, and
two pinned trees are the start of that proof rather than its end.

## The refusals

These are load-bearing. Each is already enforced somewhere in the code or the
tests; this list exists so that a proposal to remove one is recognised as a
change of direction rather than a cleanup.

**Static reading only.** Nothing invokes `go`, `cargo`, `uv`, `mvn` or `gradle` to answer a
question about imports. Nx computes the graph on _every_ invocation, so a graph
that needs seven language toolchains installed is a graph that fails on the machine that
does not have them — a lint-only CI job, or a contributor who touches none of the
seven languages.

**Edges only — never nodes, never targets.** Projects stay declared by
hand-written `project.json`, and no target is ever inferred. The community
plugins that solve the edge problem also infer targets, and rejecting that is
this tool's reason to exist: what a target does keeps one source of truth.

**TypeScript and JavaScript stay with `@nx/eslint-plugin`.** Archkeep does not
replace a rule that already works.

**One constraint table, in the consumer's workspace.** Nothing in this project
defaults a constraint or an option, because a default is a second copy of a value
the workspace already stated, and the two disagree the day one changes.

**No assumption about any workspace's names.** Not project names, not areas, not
tag values — this repository's own included. It is installed into trees it has
never seen; `module-boundaries.config.mjs` at this root is what turns that from an
intention into something CI can disprove, because its vocabulary shares nothing
with the workspace the tool was extracted from.

**Agents are consumers of the verdict, never its authority.** An agent reasons,
plans and edits code; it does not decide whether the architecture is valid. The
verdict comes from the deterministic core, the commands an agent consumes are
read-only, and nothing an agent can run edits the constraint table to make its
own change pass. [architecture-authority.md](architecture-authority.md) owns the
boundary; this refusal exists so that moving it — giving the agent the capacity
to make an architecture pass by modifying the law — is recognised as a change of
direction rather than a convenience.

## The invariant, and why breadth depends on it

**An empty result is a claim, not a shrug.** `AGENTS.md` owns that sentence and
the reasoning under it; what belongs here is why it is the precondition for
everything above.

Every language added multiplies the ways a run can fail to reach a verdict: a
manifest shape nobody read, a parser that is not installed, a file that cannot be
attributed to a project. In a tool that returns empty on those paths, breadth
makes the tool _less_ trustworthy with each language — more silence, wearing the
same green as correctness. In a tool where every unreachable verdict is loud —
exit 3, a diagnostic saying the file was not analyzed, a failure record beside
the imports — breadth is safe, because coverage is something the run reports
rather than something the reader assumes.

That is the whole reason this project can aim at being a platform rather than
seven analyzers. Not the layering, and not the test count.

## How to tell this is drifting

Four signals, in the order they would probably appear:

1. A language ships with edges and no enforcement, "for now".
2. A report stops saying what it inspected, and only says what it found.
3. A shape an analyzer cannot read is discovered and fixed without its header
   gaining a line.
4. Someone proposes an option that makes a check not run, and the proposal is
   argued on performance.

Each is individually reasonable. Together they are how a tool that exists to end
silent non-enforcement becomes a tool that practises it.

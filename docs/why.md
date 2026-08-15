# Why this exists

The short version: in a polyglot Nx workspace, two of Nx's best features stop
working, and neither of them tells you. That was the gap Lattice was extracted
from. Today Lattice serves any repository — Nx is a first-class integration,
not the foundation.

The rest of this page is the evidence for that, because the claim is easy to make
and the whole project rests on it being true.

## What Nx gives a TypeScript and JavaScript workspace

Nx's project graph is what makes a monorepo tractable. Two things stand on it:

- **`nx affected`** runs only what a change can reach, which is what keeps CI
  from re-running the world on every commit.
- **`@nx/enforce-module-boundaries`** refuses an import that crosses a line the
  architecture drew — expressed as tags on projects (`layer:domain`,
  `scope:billing`, `type:app`) and a table of which tags may reach which.

Both rest on one fact: Nx knowing which project depends on which. For TypeScript
and JavaScript it knows, because it reads the imports.

## What happens when the workspace stops being only TypeScript and JavaScript

Add a Go service, a Rust crate or a Python package, and both features fail — in
the same direction, which is the direction nobody notices.

**`nx affected` under-selects.** A Go library changes; the service importing it
is not marked affected, so its tests never run. CI goes green because nothing
ran, which on a dashboard is byte-for-byte the same as green because everything
passed.

**`@nx/enforce-module-boundaries` never sees the file.** It is an ESLint rule.
ESLint has no parser for `.go`, `.rs` or `.py`, so the architectural rule every
TypeScript or JavaScript library is held to does not exist for the rest of the
workspace. Not weaker — absent.

Neither announces itself. You find out when a change ships broken, or when
someone notices a `go.mod` that has been importing across a boundary for six
months.

## The measurement

That second claim was tested rather than assumed, because "ESLint probably does
not handle Go" is exactly the kind of remembered fact that is right for the wrong
reason and stops being right after an upgrade.

The setup: a Go project in an Nx workspace, tagged on the layer axis, given an
import that violates that axis. What was observed:

- The Nx graph showed the edge — so the dependency was real and visible.
- The project's `lint` target **exited 0**. That target runs `eslint`, and ESLint
  answered, in as many words:

  ```text
  File ignored because no matching configuration was supplied.
  ```

So the boundary was violated, the violation was in the graph, the lint target
passed, and the message explaining why scrolled past inside a green run. A
`layer:`, `scope:` or `license:` tag on that project had no mechanism behind it
at all — it was documentation that looked like enforcement.

**Vue is the exception, and it is worth stating because this project got it wrong
once.** A workspace that configures `vue-eslint-parser` gets real boundary
enforcement in `.vue` files: both engines report the same `messageId` and the
same message on the same violation, differing only in column — the same
difference they have on every `.ts` file. Vue was never a blind spot, an earlier
version of these documents said it was, and the correction is pinned by a
conformance fixture so it cannot drift back.

## Why not just make ESLint read them

Three answers were available. Two of them are worse than they look.

**Write ESLint parsers for Go, Rust and Python.** A parser has to produce an
ESTree-shaped AST, and the boundary rule then walks it looking for JavaScript
import syntax. Everything interesting about a Go import — that it is a module
path resolved against `go.mod` and the module proxy, not a file path — has to be
smuggled through a shape designed for a different language. And the result only
runs where ESLint runs, so `nx affected` still has no edges.

**Use an existing polyglot Nx plugin.** They exist, they solve the edge half, and
they all come with inferred targets: install one and your Go projects acquire a
`build` target the plugin decided on. That is a real product, and it is a
different product. It moves the answer to "what does `build` do here" out of
`project.json` and into a plugin's defaults, which is a trade a workspace should
make deliberately and not as the price of getting its dependency graph right.
Lattice contributes **edges only, and never a node or a target** — that refusal
is its reason to exist.

**Reproduce the rule over records instead of an AST.** Which is this. The
fifteen violation types and the eight options of
`@nx/enforce-module-boundaries`, evaluated over a language-neutral record of
"which import is written where, and what it resolves to". The analyzer per
language answers that question; the rules never learn which language they are
holding.

That third route has one property the other two lack: because the rules are the
upstream rules rather than an approximation, they can be **differentially tested
against real ESLint** on the same workspace, and the places the two disagree can
be enumerated rather than hoped about.
[`src/conformance/`](../packages/lattice/src/conformance/README.md)
is that comparison — 46 fixture workspaces, 116 probes, and a ledger of every
known difference with the reason for each.

## Why silence is the thing this project is organised around

Every design decision downstream follows from one observation about the two ways
a checker can be wrong.

- **Reporting a violation that is not real** is loud. Someone hits it, disagrees,
  files an issue. It self-corrects.
- **Reporting nothing when a violation exists** is silent, and identical to a
  clean workspace. Nobody files anything. The boundary everyone believes is
  enforced has not run for months.

The second is the failure this tool exists to end, so a tool that produces it
would be worse than nothing — it would replace a known gap with an unknown one,
wearing a green checkmark. Hence the invariant that
[`AGENTS.md`](../AGENTS.md) states and everything is judged against: **an empty
result is a claim, not a shrug.** Every code path that cannot reach a verdict
says so instead of returning empty. That is why the CLI has an exit code for
"could not look" that is distinct from "looked and found nothing", why the
language server refuses to publish an empty diagnostic list from anywhere except
two named places, and why the issue tracker has a
[dedicated form for a missed violation](../.github/ISSUE_TEMPLATE/missed_violation.yml)
separate from the ordinary bug form.

[north-star.md](doctrine/north-star.md) is where that stops being a defensive posture and
becomes the thing that makes breadth possible.

## Where it came from

The package was extracted from tooling that had been running in a real polyglot
workspace, rather than written speculatively against imagined ones. That is worth
one sentence and not more, because a claim about provenance proves nothing on its
own.

What does prove something: CI here runs the checker against **this repository's
own source**, under a boundary table whose tag vocabulary (`type:package`,
`scope:nx`) shares nothing with the workspace the tool came from. If any project
name, area or tag value from that workspace had survived in the source, this is
the run that fails — because none of those names are here to be found.

That step is the difference between "works in your workspace too" as a promise
and as something a build can disprove.

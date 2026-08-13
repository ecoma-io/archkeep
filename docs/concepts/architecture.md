# Architecture

One analysis, three faces. The engine reads a polyglot workspace, judges every
import against a constraint table, and delivers the verdict through whichever
surface the reader needs — the CLI, the language server, or an integration
plugin. The analysis is the same each time; only the delivery changes.

## The pipeline

A `check` run is a straight line:

```
find root → read options → load config → read graph + files →
build workspace view → analyze → evaluate → suppress → report → exit
```

Each step is a decision, and every cut between them is load-bearing.

### Find the workspace root

The engine walks up from the working directory for a workspace marker. The
marker decides which provider supplies the project graph for the rest of the
run. A root carrying markers for two providers is a usage error, not a guess.

### Read the options

Two names live in the options and nowhere else — the boundary config file and
the shared TypeScript config — because both are conventions a workspace may
rename. Everything downstream takes the resolved name as an argument. An
unknown key throws, at every entry point, because a typo that fell back to the
default would be a full green run against a rule nobody wrote.

How options reach the engine depends on the surface — see
[integrations.md](integrations.md).

### Load the boundary config

The constraint table is read and validated for shape only. Whether a particular
tag combination is allowed is the workspace's decision, not this tool's. A
malformed row fails here rather than becoming a rule that silently matches
nothing. Every problem is accumulated, not just the first.

The config may be an ES module, a JSON file, or an ESLint flat config — the
three dialects are documented in [policies.md](policies.md).

### Read the graph, and the file list

The graph comes from the selected provider. An integration may read a graph its
host already computed; the native provider builds one from the workspace model
and tracked tree. Neither the CLI nor the language server needs to know which
one it holds.

The file list comes from `git ls-files`. The graph JSON carries no file map, and
a tree walk would need ignore rules that drift from `.gitignore`.

Both the graph and the file list are injectable, which is what lets a test drive
the whole pipeline with no external project tool and no git process.

### Analyze

Each file is dispatched through two tables — extension to language, then
language to analyzer. An unrecognised extension is a no-op (the dispatcher is
pointed at every tracked file, and `README.md` is not an error). A language the
first table claims and the second does not throws, naming it — that is how the
next language stays loud before its analyzer lands.

Each analyzer returns import sites and failures. It never judges, and it never
throws on a malformed file — a failure is a record, because an analyzer that
threw would take down the run for the file it could not read, and one that
returned empty would call it clean.

What each language sees is documented in [projects.md](projects.md).

### Evaluate

The rules layer is pure: records and config in, violations out. No filesystem,
no git, no external tool. That purity is what lets the CLI and the language
server share one verdict, and what lets the differential against ESLint be
driven from fixtures with no workspace at all.

The fifteen violation types and the constraint model they judge against are
documented in [boundaries.md](boundaries.md).

### Suppress and report

Suppressions are applied after every import has been judged. A suppression
removes a verdict, never a failure — a file listed in `boundarySuppressions` is
still fully analyzed, and anything the analyzer could not read in it is still
reported.

The report renders and decides nothing. Two formats, two audiences: `text`
produces the `file:line:column` a terminal turns into a link, and `sarif`
produces what GitHub code scanning accepts.

### Exit

```js
if (violations > 0) return 1;
return unchecked > 0 ? 3 : 0;
```

Exit 0 was the bug. A checker that could not look must never be mistaken for one
that looked and found nothing.

## The three faces

| face             | when it runs                       | what it reads the graph from                   |
| ---------------- | ---------------------------------- | ---------------------------------------------- |
| CLI              | on demand                          | a provider (Nx, Moon, or native)               |
| LSP              | on an edit, in any LSP client      | the native provider's discovery                |
| Nx integration   | on every project-graph computation | the Nx integration's `createDependencies` hook |
| Moon integration | on demand (CLI, language server)   | `moon project-graph --json`                    |

The Nx integration is a lossy view of the analysis — an edge is `{ source, target,
sourceFile, type }`, and everything else is discarded. That is why the graph
layer and the enforcement layer stay separate rather than one growing fields the
other throws away.

The language server shares the same `evaluate` function and the same constraint
table, but builds its own workspace index from tracked `project.json` files.
Its invariant is the CLI's, sharpened: an empty diagnostic list must mean "no
violation", and nothing else.

## Why the cuts are where they are

Four seams, each justified by a specific failure it prevents.

**Analysis never judges.** An analyzer that filtered its own output would have
taken a decision away from the rules layer — and a rule change would then need
an analyzer change in every language.

**Rules never read files.** Purity is what makes one verdict serve three
faces. It is also what makes the differential against ESLint possible.

**The report decides nothing.** Two renderers of one verdict cannot disagree
about what is a violation.

**Options are the only layer that knows what a workspace named its files.**
Everything downstream takes a resolved name as an argument.

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
reported. A row with an `expiresAt` is a **waiver** — it does not remove the
violation at all; it marks it accepted until that instant, and the violation
re-asserts in full once the waiver lapses ([waivers.md](waivers.md)).

The report renders and decides nothing. Two formats, two audiences: `text`
produces the `file:line:column` a terminal turns into a link, and `sarif`
produces what GitHub code scanning accepts.

### Fold the workspace's own declared gates

Between judging and reporting, two policy keys declare laws the engine did not
write and both are folded in over the facts the run already holds: `fitness`
([fitness-functions.md](fitness-functions.md)) and `customRules`
([custom-rules.md](custom-rules.md)), the second being committed WebAssembly
artifacts the engine loads at a pinned digest and runs in a sandbox that grants
no file, clock, network or environment.

Both fold **by presence**, never by flag. An opt-in flag makes a forgotten flag
byte-identical to "no gates checked", which is the silence this whole tool
exists to end; and a policy declaring neither hears nothing at all, so the
report over such a workspace is byte-for-byte what it was before either
capability existed.

### Exit

```js
if (findings > 0) return 1; // a boundary, a workspace declaration, or a declared gate that failed
return couldNotJudge > 0 ? 3 : 0; // a file, an intent, or a declared gate that could not answer
```

Exit 0 was the bug. A checker that could not look must never be mistaken for one
that looked and found nothing — and that holds for a declared gate exactly as
it holds for a file: a rule that trapped, or whose artifact would not load, is
never a rule that found nothing.

## The 24 commands

| command      | what it does                                                                                                       | finds violations |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `check`      | Judges every import site against the boundary law, plus the intent                                                 | yes — exits 1    |
| `graph`      | Prints the project graph as a deterministic snapshot                                                               | no               |
| `diff`       | Compares two graph snapshots, with optional rule-impact analysis                                                   | no               |
| `delta`      | Classifies violations between a captured evidence baseline and head                                                | yes — exits 1    |
| `change`     | Reconciles a declared change intent against the architectural delta                                                | yes — exits 1    |
| `drift`      | Compares the observed architecture against the declared intent                                                     | no               |
| `discover`   | Reports observed facts; `--propose` derives candidate architecture, never written                                  | no               |
| `reconcile`  | Scores the observed side against the declared model; `--propose` derives repair edits                              | no               |
| `waivers`    | Lists term-bound suppressions; a waived violation stays a finding in `check`                                       | no               |
| `fitness`    | Judges the workspace's named quality gates (folded into `check` by presence)                                       | no               |
| `history`    | Describes how the architecture evolved across a directory of snapshots                                             | no               |
| `trajectory` | Aggregates the drift trajectory across snapshots — signals, churn, persistence                                     | no               |
| `evolution`  | Describes how the architecture evolved across a selected range of Git revisions                                    | no               |
| `health`     | Per-metric verdicts; an unmeasured metric is `unknown`/`not_applicable`, never zero                                | no               |
| `report`     | Composes health, waivers, fitness, decisions and provenance under one resolved law                                 | no               |
| `debt`       | Ages waivers, gaps and drift across snapshots — a ledger, not a gate                                               | no               |
| `impact`     | Lists projects that depend on the named one, with constraint context¹                                              | no               |
| `scenario`   | Evaluates a hypothetical change against the current workspace                                                      | no               |
| `explain`    | Explains the judgment for one import site                                                                          | no               |
| `context`    | Shows the architecture constraints that apply to a project¹                                                        | no               |
| `provenance` | Reports the governance row schema and the run's origin                                                             | no               |
| `decisions`  | Walks the full chain behind one recorded decision — decision to bound rows, projects, findings, verification level | no               |
| `adr`        | Lists recorded architecture decisions and what each binds (`docs/adr/`)                                            | no               |
| `rules`      | Lists official rules, shows details, verifies catalog integrity, or adds a rule                                    | no               |

`check` is the only command that exits 1 on boundary findings — with three
companions: `fitness` exits 1 when a declared function fails (a failing fitness
function is a finding, not a print job), `delta` exits 1 when the compared
change introduced a violation no active waiver covers, and `change` exits 1
when the change produced architectural consequences its declaration did not
cover (or skipped ones it did). The other twenty are
descriptive or
proposal-only: they answer questions about the architecture without claiming a
violation. `context` answers the question an agent asks _before_ editing (what
is this project allowed to reach?); `impact` answers the question during
planning (what depends on this?); `scenario` answers the question during
planning too (what if this dependency changed?); `explain` answers the question after a
violation is reported (why did this one fail?). `diff` answers the question
across a single change (what changed, and what boundary implications did the
change carry?), and `delta` answers its violation half as a gate (which
violations did this change introduce or resolve, judged under the current
law — [../usage/delta.md](../usage/delta.md)); `change` answers its
declaration half as a gate too (did the delta match what the change declared?
— [../usage/change.md](../usage/change.md)); `history` answers it across time (how did the architecture
evolve, and which of those changes were architectural, policy, or provider?);
`evolution` answers it across Git revisions (at which analyzed commit was an
architectural change first observable — read from each revision's own tree,
never from commit messages); `drift` answers it in the present tense (does the code that exists agree with the
architecture that was declared?); `reconcile --propose` and
`discover --propose` answer it in the future tense (what would the declared
model need to look like for the two sides to agree?) — as proposals, never
written. `fitness` and `waivers` sit between: their verdicts fold into
`check`'s exit code by presence, and `fitness` exits 1 on its own when a
declared function fails — `waivers` stays descriptive, listing the term-bound
suppressions on the table without claiming a violation.

Two of the descriptive commands fold into `check` by presence: a policy
declaring a `fitness` export counts its per-function verdicts into `check`'s
exit code (`fail` → 1, `unknown` → 3), and a violation an active waiver
accepts stays exit `1`, moved to the "accepted violations" section until its
term lapses. The rest only inform the reader.

¹ Per-edge verdicts in `context` and `impact` cover only `depConstraints`
(3 of 15 violation types). An edge with no violations in these commands may
still violate npm-ban, circular-dependency, lazy-load, or other rules that
require import-site details. Run `check` for the complete verdict.

## The four faces

| face             | when it runs                       | what it reads the graph from                   |
| ---------------- | ---------------------------------- | ---------------------------------------------- |
| CLI              | on demand                          | a provider (Nx, Moon, or native)               |
| LSP              | on an edit, in any LSP client      | the native provider's discovery                |
| Nx integration   | on every project-graph computation | the Nx integration's `createDependencies` hook |
| Moon integration | on demand (CLI)                    | `moon project-graph --json`                    |

The Nx integration is a lossy view of the analysis — an edge is `{ source, target,
sourceFile, type }`, and everything else is discarded. That is why the graph
layer and the enforcement layer stay separate rather than one growing fields the
other throws away.

The language server shares the same `evaluate` function and the same constraint
table, but builds its own workspace index — through the native provider's model
on a `archkeep.json` root, and from tracked `project.json` files on an Nx one.
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

## Related concepts

- [drift.md](drift.md) — what architectural drift means, and which commands
  surface it.
- [agentic-development.md](agentic-development.md) — the three questions an
  agent asks, and the commands that answer them.
- [boundaries.md](boundaries.md) — the constraint model and what "violation"
  means.
- [graph.md](graph.md) — project graph, edge identity, deterministic snapshots.

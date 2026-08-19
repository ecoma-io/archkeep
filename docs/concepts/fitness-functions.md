# Fitness functions

A boundary is a rule about what may import what. A fitness function is a rule
about the workspace itself: the graph stays cycle-free, no layer reaches the
domain, every owned file is analyzed, the suppression count stays below a
threshold. Where a constraint row is judged per import site, a fitness function
is judged once per run, over the same observed facts every other check reads —
the project graph, the workspace analysis, the architecture intent, and the
boundary suppressions.

Fitness functions are named, declared, and machine-checkable. Each is a small
quality gate the workspace holds itself to, and each produces one of four
verdicts on every run: `pass`, `fail`, `unknown` (the run could not determine
it), or `not_applicable` (its `match` selected no project).

## Why they exist

Most of what keeps an architecture honest is already a constraint row: an import
over the line is a violation. But some qualities are not about a single import:

- **Structural** — the dependency graph as a whole drifted into a cycle.
- **Coverage** — a file was added that the analysis never reads, so every
  subsequent verdict silently excludes it.
- **Process** — suppressions accumulated past the number the team decided to
  tolerate.

A checker that only judges imports sees the first as one-directional, never the
second, and never the third. Fitness functions make these qualities declared and
tested-on-every-run instead of reviewed-when-remembered.

## The verdict contract

Every function returns exactly one of four verdicts, and the ordering below is
what `pass` may mean and what it may not:

- **`pass`** — every requirement the condition names was evaluated and held.
  Reachable only when the evidence the condition needed was fully observed.
- **`fail`** — a requirement was evaluated and broken.
- **`unknown`** — the run could not determine the answer. A fitness the run
  cannot determine MUST yield `unknown`, never `pass`. Two classes reach here:
  the condition's own evidence is missing (a `layer-dependency` tag no matched
  project carries; a `coverage-minimum` over zero owned files; `drift-free`
  over no intent), and the function's `match` could not be judged against the
  observed graph.
- **`not_applicable`** — a declared function whose `match` selects zero
  projects, or a `coverage-minimum` row judged from a path-scoped run (it needs
  the whole tree, and no scoped `check <path>` can supply that, however clean
  the scoped path is). Reported loudly — "declared but matches nothing" or
  "needs a full run" — never folded into `pass`, and it names a
  `notApplicableReason` so the reader can tell "did not apply" from "did not
  run".

The silent direction this tool exists to end is the one where an empty result
reads as "checked, clean". A function that cannot be determined is therefore
`unknown`, and a function that matches nothing is `not_applicable`: neither may
read as a function that passed.

## Declaration

Fitness lives in the workspace's ONE executable policy file — a `fitness`
export of `module-boundaries.config.mjs` (or a native workspace's inline
`boundaryConfig` object). A row declares a name, the projects it judges
(`match`, one or more selectors), the condition it holds, and the reason it
exists — a fitness function is a policy decision, and one with no reason written
down is indistinguishable from a policy that quietly stopped applying.

```js
export const fitness = [
  {
    name: "no-layer-violations",
    match: ["*"],
    condition: {
      type: "layer-dependency",
      from: "layer:adapter",
      to: "layer:domain",
      direction: "forbidden",
    },
    reason: "the domain must stay independent of every adapter",
  },
  {
    name: "full-analysis",
    match: ["*"],
    condition: { type: "coverage-minimum", statement: 100 },
    reason: "a file the analysis never reads contributes no verdict",
  },
];
```

The condition types the registry can evaluate are: `cycle-free`,
`layer-dependency`, `tag-conformance`, `coverage-minimum`,
`boundary-suppression-count-within-threshold`, and `drift-free`. Each carries
the fields its semantics need — the schema is in
[policy-schema.md](../reference/policy-schema.md).

The config loader validates the list where it is read: an unknown key, a
duplicate or ill-formed name, an empty `match`, or a condition field of the
wrong type fails the load loudly rather than evaluating a function that could
not mean what it wrote.

## How it is judged

Fitness functions are judged deterministically from the observed snapshot —
the same facts `check` reads. No LLM, no network, no clock: a fitness function
is a verdict a pipeline can reproduce, not a belief a reviewer holds. Rows are
judged in declaration order, edges and evidence are sorted with plain `<`, and
volume evidence serializes through `canonicalizeJson`, so two runs over an
unchanged tree and policy produce byte-identical output.

Coverage has a precise meaning: `coverage-minimum` count FILE coverage over the
analyzable owned files — the same files `analysis` actually reads. A Markdown
file can neither raise nor lower the claim; a file that was owned but not
analyzed counts as uncovered. A path-scoped run (`lattice check <path>`)
analyzes a subset of owned files, so coverage over the whole set is not
determinable from it: `coverage-minimum` answers `not_applicable` there, never
a low-looking number that is really "we only looked at part of the tree" — and,
unlike `unknown`, a `not_applicable` verdict does not by itself fail a `check`
run (see "Two faces, one registry" below). A workspace that declares
`coverage-minimum` still needs an unscoped run to actually judge it; a scoped
run just reports that it could not.

## Two faces, one registry

`lattice fitness` is the descriptive face: it prints each function's verdict as
a table. A function that `fail`s makes it exit 1 — a failing fitness function
is a finding, not a print job — and any function that is `unknown` makes it
exit 3. `check` is the gate face: it folds fitness in by presence — a
workspace whose policy declares fitness gets its per-function verdicts counted
into `check`'s exit-code machinery (1 for any `fail`, 3 for any `unknown`,
never a new exit code). `not_applicable` counts toward neither: a function
that did not apply to this run — nothing matched, or (a path-scoped `check`)
the condition needed the whole tree — is reported, not hidden, but it cannot
fail a run it was never in a position to judge. There is no `--fitness` flag.
An opt-in flag would make a forgotten flag byte-identical to "no fitness
checked" — the silent direction this whole tool exists to end.

## Where this sits in the roadmap

Fitness functions are a 1.x capability: deterministic, computed from the
observed graph, analysis, intent and policy, with no predictive component.
[roadmap.md](../roadmap.md) owns the staged path and lists this alongside the
other 1.x capabilities.

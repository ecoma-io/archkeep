# Architectural drift

Architecture drifts. Not because anyone decides to violate a boundary, but because
the workspace changes faster than the constraints do — and because some forms of
drift are invisible to a checker that only judges imports.

Archkeep surfaces four kinds of drift through three commands. Each is a different
failure mode, and none requires a toolchain installed. Boundary violations and
configuration drift surface through `check`; structural drift and its rule
impact surface through `diff`; architecture-intent drift surfaces both as its
own descriptive command (`drift`) and, by presence, inside `check`.

## What drift means here

Drift is any divergence between what the workspace's architecture declares and what
its files actually do. The boundary checker catches one class — an import that
crosses a line the constraint table drew. But three other classes exist, and none
produces a boundary violation:

- **Structural drift** — the project graph itself has changed: edges appeared or
  disappeared, projects were added or removed. Each change may or may not violate
  a constraint, but the change itself is a fact a team should see.
- **Configuration drift** — the workspace's own infrastructure is inconsistent: a
  `go.work` that does not match its projects' `go.mod` files, or a tsconfig alias
  that points to directories that no longer exist. These are not boundary
  violations, but they are build breakers or silent misresolutions that nothing
  else detects.
- **Architecture-intent drift** — the workspace declares the relationships it
  means to preserve, and the observed graph disagrees: a relationship the intent
  requires is absent, or one the intent forbids has appeared. These are not
  constraint rows either, but a gap between intention and reality.

A checker that only looks at imports misses all of these classes. Archkeep
surfaces the four through `check` and `diff`, because a gap in any one of them
looks like "clean" from inside the others.

## The four drift signals

### 1. Boundary violations — `check`

The primary drift signal: an import that crosses a constraint the architecture
declared. `check` judges every import site against the constraint table and
reports violations with `file:line:column` positions.

This is the class `@nx/enforce-module-boundaries` already covers for TypeScript
and JavaScript, and the class Archkeep extends to Go, Rust, Python and Vue.

### 2. Structural drift — `diff`

`diff` compares two graph snapshots — a baseline and the current workspace — and
reports every project and edge that was added or removed. When a boundary config
is available (the workspace's own or one named by `--config`), it also computes
the **rule impact**: which added edges introduce boundary violations, and which
removed edges resolve them.

Structural drift is descriptive, not a finding. A new edge is not a violation
until the constraint table says it is, and a removed edge is not a fix until it
was violating. `diff` separates the structural change from the rule judgment so a
team can see both halves: what changed, and what that change means
architecturally.

The workflow is the one CI already uses with artifacts:

```shell
git checkout main && archkeep graph --format json --output baseline.json
git checkout my-branch && archkeep diff baseline.json
```

### 3. Configuration drift — `check` (workspace checks)

When the workspace has a tracked `go.work` at its root, `check` compares its
`use` list against every project's `go.mod`: a module in one list and not the
other means a developer's `go build` and CI select different trees. Both
directions are findings.

When the workspace tsconfig declares a `paths` table, `check` judges each alias
for life: an alias mapped only to targets whose directories do not exist resolves
no import — the build breaks on it, or it silently resolves to an installed
package of the same name.

Both checks run on the CLI only — they describe the workspace, not any file being
edited, so the language server does not publish them. Both are read statically;
neither invokes `go` or `tsc`.

### 4. Architecture-intent drift — `drift`, and by presence inside `check`

A drift signal no rule table can see, because it is about the intended
architecture rather than the constraint table. When a workspace commits an
[`architecture-intent.json`](../reference/architecture-intent.md), the observed
architecture is compared against the declared intent: an `allowed` relationship
with no observed edge is drift (`intentAllowedMissing`), a `forbidden`
relationship that appears in the graph is a violation (`intentForbiddenEdge`),
and the intent's `projects`/`dependencies`/`forbiddenTags` sections judge
existence and tag facts by name. Both read the same observed source as the
boundary checker, but they judge the team's stated intent rather than a row of
tables.

`drift` is the descriptive face — it prints the intent, the findings, and the
intent fingerprint, and it never exits 1. `check` is the gate face: when an
intent file is present, `check` folds drift in by presence (exit 1 on findings,
3 on a malformed intent or one whose boundary matched no project). When intent
cannot be established at all — a file that will not parse, a boundary matching
no project, a drift comparison that cannot be verified — both commands withhold
the verdict (exit 3) rather than let an unverifiable declaration read as a
satisfied one.

## A `drift` command, and why it does not replace `check`

The intent then has a descriptive verb of its own — `archkeep drift` prints the
full comparison for a developer reading it at a terminal, while `check` decides
whether the same comparison means the build is red. The two share one analysis
(`packages/archkeep/src/commands/drift.mjs` owns the single verdict both
consume), so a description and a gate can never disagree about the same intent.
There is no `--drift` flag:
an opt-in flag would make a forgotten flag byte-identical to "no drift checked",
which is the silent direction this whole tool exists to end — when an intent
file exists and is tracked, `check` already counts it.

## Where this sits in the roadmap

The four signals above are basic drift detection, and they ship today:
deterministic, computed from graph, policy, snapshot, diff and intent, with no
predictive component. [roadmap.md](../doctrine/roadmap.md) owns the staged
path and lists this alongside the other capabilities that ship today. The
architecture-intelligence capabilities of the roadmap's Change Intelligence
phase — impact
analysis, scenario evaluation, an evidence-grounded advisor — may one day
reason over these deterministic drift signals and explain them, but that is
later maturity on the same roadmap, gated and never a promise; the
deterministic signals are the capability.

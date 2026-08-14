# Architectural drift

Architecture drifts. Not because anyone decides to violate a boundary, but because
the workspace changes faster than the constraints do — and because some forms of
drift are invisible to a checker that only judges imports.

Lattice detects three kinds of drift today. Each is a different failure mode, and
each is found by a different mechanism. None requires a toolchain installed.

## What drift means here

Drift is any divergence between what the workspace's architecture declares and what
its files actually do. The boundary checker catches one class — an import that
crosses a line the constraint table drew. But two other classes exist, and neither
produces a boundary violation:

- **Structural drift** — the project graph itself has changed: edges appeared or
  disappeared, projects were added or removed. Each change may or may not violate
  a constraint, but the change itself is a fact a team should see.
- **Configuration drift** — the workspace's own infrastructure is inconsistent: a
  `go.work` that does not match its projects' `go.mod` files, or a tsconfig alias
  that points to directories that no longer exist. These are not boundary
  violations, but they are build breakers or silent misresolutions that nothing
  else detects.

A checker that only looks at imports misses both classes. Lattice addresses all
three, because a gap in any one of them looks like "clean" from inside the other
two.

## The three drift signals

### 1. Boundary violations — `check`

The primary drift signal: an import that crosses a constraint the architecture
declared. `check` judges every import site against the constraint table and
reports violations with `file:line:column` positions.

This is the class `@nx/enforce-module-boundaries` already covers for TypeScript,
and the class Lattice extends to Go, Rust, Python and Vue.

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
git checkout main && lattice graph --format json --output baseline.json
git checkout my-branch && lattice diff baseline.json
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

## Why drift is a concept and not a command

A `drift` command would suggest a single answer to a single question. Drift is
not one question — it is three, each found by a different mechanism, each with a
different exit code semantics. The `check` command finds violations and
configuration drift; the `diff` command finds structural drift and its rule
impact. The concept ties them together; the commands answer the specific
questions.

## Where this is going

[roadmap.md](../roadmap.md) owns the staged direction. The 2.x capability
"drift and architectural-change intelligence" extends what `diff` and `check`
already report: richer policies, fitness functions, and historical evolution of
the architecture over time. Nothing in 1.x promises that; the three signals
above are what ships today.

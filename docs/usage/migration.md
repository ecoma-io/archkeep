# Migrating an existing repository

Bringing a repository that already has an architecture under Archkeep governance,
without hand-writing the model up front.

This page owns the **order**. Every step below has a page that owns its detail,
and this one links to it rather than restating it — what is here is the
sequence, what each step is allowed to decide, and how a non-zero exit reads at
the point in the path where you hit it.

The problem this order solves: a legacy repository has an architecture, but no
declared one. Writing `architecture-intent.json` from memory before looking is
guessing, and a model that was guessed produces findings nobody trusts. So the
model is derived from what is observed, reviewed by a human, and only then
written — by hand.

## The path

| step                                           | command                            | who decides                              |
| ---------------------------------------------- | ---------------------------------- | ---------------------------------------- |
| [0. Mark the workspace](#0-mark-the-workspace) | —                                  | the operator                             |
| [1. Observe](#1-observe)                       | `archkeep discover`                | the tool reports; nobody decides         |
| [2. Propose](#2-propose)                       | `archkeep discover --propose`      | the tool proposes; nobody decides        |
| [3. Review](#3-review)                         | —                                  | a human, or an agent on a human's behalf |
| [4. Write back](#4-write-back)                 | —                                  | the operator, by hand                    |
| [5. Converge](#5-converge)                     | `archkeep reconcile --propose`     | the operator, each round                 |
| [6. Enforce](#6-enforce)                       | `archkeep drift`, `archkeep check` | CI gates on the verdict                  |

Every command in that table is read-only: none of them writes a byte of the
model, at any step, under any flag. Steps 3 and 4 are where the architecture is
actually decided, and they are the two with no command beside them —
deliberately, because [architecture-authority.md](../doctrine/architecture-authority.md)
owns the line that keeps the deciding on the human side of it.

## 0. Mark the workspace

Nothing runs until the tree has a workspace root. A repository with none gets a
refusal, not an empty answer:

```text
archkeep: no workspace root above <dir> — looked for an nx.json, a archkeep.json, or a
.moon/workspace.yml (or .config/moon/workspace.yml) in every parent, stopping at the top
level of the enclosing git repository: beyond it, a marker such as ~/.moon is user-level
tooling state, not this workspace's root.
```

That is exit 3. Pick the marker the repository already has, or add the native
one: [first-project.md](../getting-started/first-project.md) for a
`archkeep.json` workspace, [nx.md](../integrations/nx.md) for Nx,
[moon.md](../integrations/moon.md) for Moon.

No boundary law is needed yet. Steps 1 and 2 read the graph, not the rules.

## 1. Observe

```shell
archkeep discover
```

`discover` is descriptive: it reports the projects, the edges between them, the
union of observed tags, and — leading the report — the analysis coverage. It
never exits 1, however tangled the architecture it finds, because describing an
architecture is not a finding. The flags, the envelope and the refusals are
[discovery.md](../reference/discovery.md)'s.

**Read the coverage line before anything else.** This is the step a legacy
repository usually fails first, and it fails loudly:

```text
✖ discovery incomplete — 1 file could not be analyzed, so these observations
may under-represent the workspace (2 imports in 3 files across 3 projects)
```

That run exits 3 even though it printed a full-looking report. The observations
under it are real but incomplete, and a model derived from them would be missing
whatever the unread file imports. Two ways to clear it, both of which put the
answer on the record: give the file a project that owns it, or name it in
`archkeep.json`'s `coverage.exempt` with a reason
([configuration.md](../reference/configuration.md)).

Clear coverage first. Everything downstream inherits it.

## 2. Propose

```shell
archkeep discover --propose
archkeep discover --propose --format json --output proposal.json
```

`--propose` adds the candidate architecture the observations imply, under a
banner that is part of the contract:

```text
proposed architecture — NOT authoritative, never written
```

Every line of it is prefixed `[proposed — not authoritative]`, and in the JSON
envelope each candidate carries `proposed: true`, `notAuthoritative: true`, the
`evidence` it was derived from, and a `confidence` of `high`, `medium` or `low`.
The four candidate classes and the derivations behind them are
[discovery.md](../concepts/discovery.md)'s subject.

Two properties of this step matter more than its output:

- **It writes nothing.** No `architecture-intent.json` appears, and the working
  tree is unchanged after the run. There is no flag that applies a proposal.
- **Incomplete coverage is a refusal here, not a warning.** Where plain
  `discover` prints an incomplete report and exits 3, `--propose` declines to
  produce candidates at all:

  ```text
  archkeep: discover --propose has incomplete coverage — 1 file could not be
  analyzed, so every candidate would be ambiguous between "gone" and "never
  seen". Fix the unanalyzed files and re-run.
  ```

  A proposal derived from a tree that was not fully read is a fabrication
  wearing a proposal's name, so the command refuses to make one.

Write the proposal to a file (`--output`) when a human or a reviewer will read
it apart from the terminal. That file is a review artifact, not an input to any
later command.

## 3. Review

No command performs this step, and that is the point.

A proposal is derived from what the code currently does. That includes whatever
the repository does _wrong_ — the dependency someone added under deadline is
observed exactly as faithfully as the one the architecture intended. So a
candidate that says "these two projects belong to different components" may be
describing the architecture, or may be describing the violation you are
migrating away from, and nothing in the output distinguishes them. Only someone
who knows what the repository is _for_ can.

Review the candidates against the intended architecture and keep the ones that
state it. Discard, edit, or invert the rest. An agent may do this work and
present the result, but it presents a diff a human can refuse — it does not
adopt a proposal on its own authority
([architecture-authority.md](../doctrine/architecture-authority.md)).

## 4. Write back

The operator writes two files by hand. Both are reviewed like code, because both
are law.

- **`architecture-intent.json`** — what the architecture _is_: the boundaries,
  and the relationships the team holds sacred. Schema, sections and judgment
  rules: [architecture-intent.md](../reference/architecture-intent.md).
- **The boundary config** — which imports are permitted, tag by tag. Dialects
  and shape: [policies.md](../concepts/policies.md); what to put in it:
  [boundaries.md](../concepts/boundaries.md).

Nothing copies the proposal into either file. The candidate list is evidence for
a decision; the file is the decision.

**Write the boundary config before you run `drift`.** `discover` and
`reconcile` both complete without one, but `drift` resolves the boundary law and
exits 3 when the file its `boundaryConfig` names is absent:

```text
archkeep: cannot load <root>/module-boundaries.config.mjs: Cannot find module …
```

That is a missing law, not drift — and it is easy to misread as a clean
comparison if the exit code is not checked.

## 5. Converge

With a model on disk, the repository and the model can be moved toward each
other. The command that shapes that work:

```shell
archkeep reconcile --propose
```

`reconcile` scores every observed project and edge against the declared model
and, under `--propose`, ends with a ranked candidate list of model edits — each
carrying the scored fact behind it and the same `proposed` /
`notAuthoritative` markers. It exits 0 whether or not it found divergence; the
command, its candidate kinds and its refusals are
[reconcile.md](reconcile.md)'s.

The loop is: run it, pick **one** divergence, decide which side is wrong, change
that side, run it again. The decision each round is the whole exercise:

- the **code** is wrong → fix the code, and the divergence disappears;
- the **model** is wrong → edit `architecture-intent.json` by hand, and record
  why.

**The ranking is not the decision.** A candidate list run against a repository
mid-migration will readily propose relaxing the very row that names the
violation you are migrating away from:

```text
proposal  1 candidate, ranked — proposed, not authoritative, never written
  boundary-change  domain → app  (change boundary row in dependencies.forbidden
  — the observed architecture builds a dependency this boundary row forbids —
  relax the row or change the boundary)
           — apply none of these without review; architecture-intent.json is untouched
```

Taking that suggestion would make the run green by deleting the rule, which is
the one outcome the migration exists to avoid. `reconcile` says "relax the row
**or** change the boundary" because it genuinely cannot tell which is right; the
operator can.

Converged looks like this:

```text
✔ no divergence — the observed architecture matches the intended model (3 projects and 2 edges)
```

## 6. Enforce

Two commands, and only one of them is a gate.

```shell
archkeep drift     # describes the disagreement — exit 0 even when it finds one
archkeep check     # the verdict — exit 1 on findings
```

`drift` names every intent row the observed graph violates and still exits 0:
it is a report, not a gate ([drift.md](drift.md)). `check` folds the same intent
comparison in by presence and does gate on it, alongside the boundary rules
([checking.md](checking.md)):

```text
libs/legacy-adapter/adapter.go:3:8  onlyTagsConstraintViolation
    A project tagged with "layer:domain" can only depend on libs tagged with "layer:domain"

intentForbiddenEdge      legacy-adapter → api — architecture-intent.json forbids
"domain" reaching "app" (boundary domain) to app
```

CI gates on `check` and on nothing else. Wiring it up, and what to do with each
exit code in a pipeline, is [ci.md](ci.md)'s.

## How a non-zero exit reads along this path

The codes mean what [exit-codes.md](../reference/exit-codes.md) says they mean
everywhere. What changes along the migration path is which of them you should
expect, and what to do about it:

| step        | expect | a `3` here means                                                                     |
| ----------- | ------ | ------------------------------------------------------------------------------------ |
| 0. mark     | —      | no workspace root — add the marker                                                   |
| 1. observe  | `0`    | coverage is incomplete — own the file or exempt it, before deriving anything         |
| 2. propose  | `0`    | the same coverage gap, now refusing to propose at all                                |
| 4. write    | —      | `drift` cannot load the boundary law the config names                                |
| 5. converge | `0`    | the model could not be scored — never "no divergence" ([reconcile.md](reconcile.md)) |
| 6. enforce  | `0`    | the gate could not look — never read it as clean ([checking.md](checking.md))        |

A `1` appears at step 6 and nowhere else: `discover`, `drift` and `reconcile`
never exit 1, because describing and proposing are not findings. A `2` anywhere
is a usage error in the invocation itself — a positional argument a command does
not take, or an unknown flag.

## Where profiles fit

A migration can be staged rather than switched on. In an Nx workspace, a
`profiles` registry lets the repository name more than one law and select
between them by name — so one law can be the one in effect while another is
resolved for a single run under `--config`, which is how a proposed law is
reviewed without touching the registered one. The option, the selection rules
and the conditions that fail loudly are [profiles.md](profiles.md)'s —
including the part that matters most during a migration: switching the active
profile to get a green run is editing the law, not passing the gate.

Profiles are an Nx plugin option only. A native or Moon workspace stages a
migration through the boundary config file itself.

## What never happens

- No command writes `architecture-intent.json`, at any step, under any flag.
- No command writes the boundary config.
- A proposal is never an instruction, and `proposed` is never authoritative.
- An incomplete read is never a clean answer — every step above refuses rather
  than describing a tree it could not finish reading.

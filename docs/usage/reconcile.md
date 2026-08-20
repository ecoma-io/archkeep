# `lattice reconcile`

Compare the declared intended model against the observed architecture element by
element — the two-sided mirror of [`lattice drift`](drift.md). Drift asks which
intended rows reality violates; reconcile asks what the model says about every
observed project and edge, and — under `--propose` — what it would take to make
the two agree.

```shell
lattice reconcile
lattice reconcile --format json
lattice reconcile --propose
lattice reconcile --propose --format json --output reconcile.json
```

`reconcile` takes no positional arguments — the observed side is the whole
project graph, and the intended side is the tracked `architecture-intent.json`
at the workspace root. It prints the intent fingerprint, the observed projects
and edges (implicit edges excluded and counted), then the divergence plane by
plane: observed projects the model does not match, observed edges the model
does not match, required-tag and tag-rule divergence, boundary membership
divergence, and intent rows whose statement is not observed.

## Read-only, always

Reconcile **never writes into `architecture-intent.json`**. It describes the
gap between the intended model and the observed architecture, and when asked it
proposes how the model could be edited — but the file on disk is not touched,
and every proposal is marked `proposed` and `notAuthoritative`. There is no flag
that applies an edit. Bringing the model back into agreement with reality (or
reality back into agreement with the model) is a manual, reviewable step done by
the intentional human or agent, and the whole point of the ranking is that the
operator chooses, not the tool.

## `--propose`

Without `--propose`, reconcile reports only what diverges. With it, the report
ends with a **ranked candidate list** of model edits — one line per candidate in
list order (severity, then plane, then name — deterministic), each carrying the
kind of edit and the intent section it would touch:

- **`add`** — observed architecture that the declared model does not admit: a
  project outside the declared project model, or a dependency outside
  `dependencies.allowed`.
- **`removal`** — an intent row nothing in the observed architecture stands
  behind: a required project that is not built, a forbidden project that is, a
  forbidden dependency or tag rule the architecture builds.
- **`tag-change`** — a required project missing a required tag.
- **`boundary-change`** — a boundary row to relax or otherwise change: a
  forbidden relationship the architecture builds, or an allowed one it never does.

Each candidate carries the evidence that supports it (the classification of the
scored element behind it), the intent row an operator would edit, and the
explicit `proposed: true` / `notAuthoritative` markers. The list is a
suggestion anchored in a specific scored fact — never an instruction, and never
an applied change.

The candidate shape and the classification catalogue live in
[reconciliation.md](../reference/reconciliation.md).

## The intended side

`reconcile` requires a tracked `architecture-intent.json`. The schema, the
sections, and the judgment rules live in
[architecture-intent.md](../reference/architecture-intent.md). Every divergence
names an observed element or an intent row, never an extrapolation.

## The observed side

The same project graph the other commands read, from any provider (Nx, Moon, or
a native `lattice.json` workspace). Edges whose target is not a project in the
model are dropped, and `implicit` edges are excluded and counted, so the report
states exactly what was compared. Reconcile reuses the graph the other commands
already build — it does not re-scan the tree.

## Fail-closed

`reconcile` refuses loudly on every path that cannot reach a verdict, all exit-3
class — the same four refusals [`drift`](drift.md#fail-closed) makes (drift adds
a fifth, conditional on an intent row carrying a `decisionRef`; reconcile reads
no boundary law and so makes only these four):

- the intent file cannot be read or parsed;
- the observed side has incomplete coverage (whole files the analyzer could not
  read) — every "absent" score would then be ambiguous between "gone" and
  "never seen";
- an Nx workspace has polyglot manifests but the plugin is not registered;
- a boundary or row side matched no observed project — the intent for that row
  cannot be verified against the graph.

An empty divergence list must mean exactly "the observed architecture matches
the intended model". When the comparison cannot be completed, `reconcile` exits
3 with a loud message rather than print "✔ no divergence".

## Exit codes

| code | meaning                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------- |
| 0    | The comparison completed (whether or not it found divergence, and with or without `--propose`).      |
| 2    | Usage error: positional arguments given, unknown flag.                                               |
| 3    | Coverage incomplete, intent unreadable, or the intent cannot be verified against the observed graph. |

`reconcile` never exits 1 — describing and proposing is not a finding. `check`
exits 1 on intent findings, and it folds drift in by presence; reconcile is the
descriptive conversation around that verdict, never the gate.

## Example

```text
intent    7768377ec47cb96206c55451864d5776ba01a330cc9d4536b559480f1f009e5d — 5 rows
observed  2 projects, 1 edge
⚠ 1 element: intent rows whose statement is not observed
  + packages → apps  (intentForbiddenEdge)
1 divergence (2 projects and 1 edge)
proposal  1 candidate, ranked — proposed, not authoritative, never written
  boundary-change  packages → apps  (change boundary row in boundaries — the observed architecture builds a dependency this boundary row forbids — relax the row or change the boundary)
           — apply none of these without review; architecture-intent.json is untouched
```

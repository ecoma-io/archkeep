# The governance lifecycle

Why the commands exist as a coherent system rather than a list of unrelated
features. Each step below is a real command, documented in
[reference/cli.md](../reference/cli.md); the arrows are the comparisons that
make a claim a verdict instead of an assertion.

```
Intent                        what the architecture should be (declared, human-authored)
   ↓  observed graph
Check                         the gate — does the code that exists agree? (authoritative)
   ↓  findings
Evidence                      explain · impact · provenance · health · debt — why, who, when, how healthy, how old
   ↓  adjudicated
Waiver / fitness              accept for a term · hold the workspace to its own named gates
   ↓
Evolution                     diff across a change · history across snapshots
   ↓
Reconcile / discover          score the disagreement · derive candidate architecture — proposals only
   ↓
Agent                         reads the facts, changes the code, gets verified
```

## Intent → Check

`architecture-intent.json` declares the intended architecture: what the
grouping is, which relationships the team holds sacred, which projects and
dependencies may exist. It is optional — a workspace without one runs exactly
as it did before — and it is a **declaration, not a permission list**: Lattice
judges the observed graph against it and reports, it never decides what the
architecture should be.

`check` is the authoritative gate. When an intent file exists and is tracked,
the same run folds the intent comparison in by presence: a forbidden path
appeared or an allowed relationship is missing is exit 1; an intent that will
not parse, or whose boundary matched no observed project, is exit 3 — an
_unverifiable_ intent must never read as a _satisfied_ one. See
[architecture-intent.md](../reference/architecture-intent.md).

## Check → Evidence

A verdict with no way to be questioned is not governance, it is a wall. The
evidence commands open the verdict:

- **`explain <file:line:column>`** — the full judgment for one import site:
  which constraint row matched, which tags applied, whether it is a violation
  and why.
- **`impact <project>`** — which projects transitively depend on a project,
  with the constraint rows governing each dependent's edge. An empty list is a
  claim, not a shrug.
- **Provenance** — every graph snapshot carries the git origin of the run;
  `history` discloses provenance advancing while nothing architectural changed
  as _code drift_. Evidence is attributable, never anonymous.
- **`adr <id>`** — reads the recorded decision a rule's `decisionRef` names:
  the record's status and rationale are the governance grounding of that rule.
  A reference that resolves to nothing is `unknown` — see
  [adr.md](adr.md).

## Evolution

`diff` compares two graph snapshots and adds rule-impact analysis when a
boundary config is available: which added edges introduce violations, which
removed edges resolve them. `history` describes the architecture's evolution
across a directory of snapshots, classifying each transition by the evidence
the snapshots carry — a changed graph is an architecture change, a changed
`policy.fingerprint` is a policy/intent change, a changed provider is a
provider change, provenance moving alone is code drift. Neither is a finding;
evolution is described, and `check` is where failing happens.
[usage/diff.md](../usage/diff.md) · [usage/history.md](../usage/history.md)

## Drift

Drift is what the lifecycle is there to surface: divergence between what the
workspace declares and what its files do. Four signals: boundary violations and
configuration drift through `check`, structural drift through `diff`,
architecture-intent drift through `drift` (and through `check` by presence).
Every path that cannot complete the comparison withholds the verdict (exit 3)
rather than print "no drift". [concepts/drift.md](../concepts/drift.md)

## Boundaries around the lifecycle

Everything above ships today. Several steps sit **beside** the gate rather than
in it, and with one exception none of them exits 1 on its own — describing or
proposing is not a finding. The exception is `fitness`, whose failing function
is a finding by decision
([fitness-functions.md](../concepts/fitness-functions.md)). Two of these are
the law's own selectors, not observations of it:

- **Named law profiles** — a `profiles` registry in the plugin options turns
  the gate into a selection: every command that reads a boundary law resolves
  `boundaryConfig`/`--config` as a profile _name_ rather than a file path, and
  a profile that cannot be resolved exits 3, wherever it is hit. Only `check`'s
  own report names which profile it enforced; a change report about any other
  command still must name the `--config <NAME>` it ran with
  ([profiles.md](../concepts/profiles.md) is the full model).
- **ADR / decision records** — a rule's `decisionRef` points at a recorded
  decision in `docs/adr/`, read by `lattice adr` (the evidence bullet above).
  The record is committed governance like the rule itself; authoring one is a
  human decision, and a `decisionRef` that resolves to nothing is `unknown`
  unless the record exists to ground it.
- **Waivers** — a boundary violation accepted for a fixed term. It lives in
  `boundarySuppressions` as a row with an `expiresAt`, is listed by
  `lattice waivers`, and stays a finding in `check` (exit 1, under "accepted
  violations") so CI still catches the day the term lapses. A waiver never
  promotes `unknown` → `pass`.
- **Fitness** — named quality gates the workspace holds itself to. Their
  verdicts fold into `check` by presence (`fail` → 1, `unknown` → 3), and
  `lattice fitness` prints the same table standalone.
- **Health / debt** — `lattice health` reports per-metric verdicts (a metric
  whose evidence is unavailable is `unknown`/`not_applicable`, never zero);
  `lattice debt` ages waivers, gaps and drift across snapshots. Both are
  reports, never gates. `lattice report` gathers the health metrics with the
  waiver, fitness and decision surfaces above into one document, every number
  taken from the command that owns it and one boundary law resolved once for
  the whole page, so no two sections can answer from two
  ([usage/report.md](../usage/report.md)).
- **Reconcile / discover** — `lattice reconcile --propose` scores every
  observed project and edge against the declared model and derives the edits
  that would make them agree; `lattice discover --propose` derives candidate
  architecture from what is observed. Both mark their output as proposals
  that are never written — no command rewrites `architecture-intent.json`:
  **proposed is never authoritative.** Intent stays a human, machine-readable
  declaration, reviewed like code.

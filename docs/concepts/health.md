# Architecture health

What "architecture health" means to Lattice, and the invariant that decides
every metric. The `health` command's behavior is documented in
[usage/health.md](../usage/health.md); the reference schema lives in
[reference/cli.md](../reference/cli.md). This page owns the _meaning_.

## The invariant

The repository's one judgment — an empty result is a claim, not a shrug —
applies at the metric level verbatim:

**A metric whose evidence is unavailable is `unknown` or `not_applicable` —
reading it as zero is the error.**

A metric is never reported as a bare number whose absent evidence could be
mistaken for a clean zero. `not_applicable` (nothing to measure) and `unknown`
(could not look) both read as _something was not measured_, and both are
visible in the text report and the JSON envelope.

That is why `health` exists as a descriptive command and never exits 1: a
description of how healthy the architecture is is never itself a finding. Only
`check` exits 1, and `health` never changes the verdict or exit code of any
other command — it is purely additive.

## What is healthy, and what is not

Health is a set of _measured facts with verdicts_, not a score. A workspace
with 40 projects is not "more broken" than one with 4; a waiver a team wrote
into its own boundary config is a _fact on the books_, not a finding. The
verdict vocabulary is the one the governance wave shares:

| verdict          | means                                                                       |
| ---------------- | --------------------------------------------------------------------------- |
| `ok`             | measured over complete evidence, and holding                                |
| `findings`       | measured and broken (violations, deferred debt rows)                        |
| `not_applicable` | nothing to measure (no boundary config, no intent file, no edges)           |
| `unknown`        | evidence could not be fully inspected (unanalyzable files, a partial graph) |

`unknown` is never folded into a zero. A metric that cannot look must not read
as a clean one.

## The metrics

- **Structural** — projects and edges: descriptions, `ok` with the measured
  count when the graph is complete. The edges metric is `unknown` when the Nx
  plugin is not registered for polyglot manifests and so the graph carries no
  Go/Rust/Python edges — a graph that under-represents its edges cannot claim
  a measured edge count.

- **Coverage** — the fraction of _analyzable_ files that were examined
  (analyzed / analyzed+notAnalyzed). Full coverage is `ok`; a fraction under 1
  is `findings` with the ratio behind it; a run that examined nothing is
  `unknown`, never 0/0 read as a clean 1.

- **Boundary** — violations (the rule engine's verdict, minus suppressions)
  and the waiver surface (the count of suppressed violations). A non-zero
  waiver surface is a fact, not a finding — the violations verdict beside it
  already reports what that surface is waiving.

- **Coupling** — edge density (edges per project: a pressure gauge with no
  correct value, only a trend) and cycles (a mutual-reach pair, counted with
  the same reachability the `noCircularDependencies` rule judges against, so
  `health` and `check` cannot disagree about what a cycle is).

- **Debt** — the deferred rows the boundary config's own `notes` record. A
  config with no notes owes no debt; each note is a decision to defer a
  constraint, reported as a finding the maintainer acts on.

- **Intent fitness** — the drift verdict: `ok` when every row and every
  boundary was judged and holds, `findings` when a forbidden path exists or an
  allowed one is missing, `unknown` when a boundary matched no observed
  project. A workspace with no intent file is `not_applicable`: absence of a
  declared intent is a workspace decision, not a gap.

## Determinism

Every metric is a pure function of the run's own records — no clock, no
locale, no environment. Two identical runs produce identical bytes. Nothing is
accumulated across runs: the snapshot directory exists to hold history, and the
trend is read from it rather than re-derived by accumulation.

## Where there is no service

There is no hosted metric surface. The numbers are computed read-only, per run,
and a maintainer acts on the trend across the same `.lattice/history/`
snapshots `history` reads — so there is one history, not two. A snapshot is a
`graph` envelope, so the trend carries the structural metrics and discloses
that rule-impact cannot be re-derived from stored bytes: snapshots carry the
graph and the policy fingerprint, not the constraint table or the import sites.

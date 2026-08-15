# Architecture governance

How Lattice's own development is governed by the same principles it enforces.
Every mechanism below runs in CI or is pinned by a test.

## The invariant

[AGENTS.md](../../AGENTS.md) owns the sentence and the reasoning under it: **an
empty result is a claim, not a shrug.** What belongs here is why the mechanisms
below exist because of that asymmetry rather than in spite of it.

The loud/silent asymmetry makes the two error directions unequal — a false
positive self-corrects, a false negative is indistinguishable from success — and
every mechanism in this document is a guard against the silent direction:

- The CLI keeps four distinct exit codes. The distinction that matters is **3**
  (could not look) against **0** (looked and found nothing) —
  [exit-codes.md](../reference/exit-codes.md).
- The language server publishes an empty diagnostic list from exactly two named
  places — [packages/lattice/CLAUDE.md](../../packages/lattice/CLAUDE.md).
- An analyzer that cannot read a file records the failure rather than dropping it
  — [contract.md](../../packages/lattice/src/analysis/contract.md).

## The boundary config as the single source of truth

[north-star.md](north-star.md) refuses a second copy: "One constraint table, in
the consumer's workspace." What follows is how Lattice's own development
practices that refusal.

A workspace's architecture is declared in one place, and every consumer — the Nx
hook, the CLI, the language server, the ESLint rule in a TypeScript and
JavaScript workspace — reads from that one place.
The conformance differential tests both engines against the same constraint table
on the same fixtures, and the ledger of known differences is maintained because
two enforcers reading one source is only trustworthy while you can name the ways
they disagree.

CI enforces this on itself. The final CI step runs
`packages/lattice/cli.mjs check` against this repository's own
`module-boundaries.config.mjs`, under a tag vocabulary (`type:package`,
`scope:nx`) that nothing in `src/` knows about. A repository shipping an enforcer
it did not run on itself would be answering a consumer's first question with a
promise.

## The contract between enforcers and their consumers

An enforcer answers questions a consumer cannot answer for itself. The contract
is: the enforcer reports what it found and what it inspected, the consumer trusts
the verdict, and both sides hold up their half.

The enforcer's obligations:

- **Verdict on every reachable path.** A code path that cannot reach a verdict
  must say so instead of returning empty. An early `return` on an unreported
  condition, and a loop that accumulates failures nobody checks, both look like
  success to CI.
- **Coverage alongside findings.** The CLI states what it inspected — imports,
  files, projects — beside every verdict, because "no violations" is a claim
  about coverage too. A report that stops saying what it inspected and only says
  what it found has lost the property that makes "no violations" trustworthy.
- **Context before the edit.** The `context` command answers what a project is
  allowed to reach before a developer or an agent writes the first import —
  [context.md](../usage/context.md).
- **Determinism.** Same workspace, same config, same tree, same answer. The
  consumer does not need to know which machine ran the check or which toolchains
  happened to be installed.

The consumer's obligations:

- **Act on exit 3.** CI that treats every non-zero exit code as "fail" collapses
  "could not look" into "found violations", and CI that ignores non-zero
  collapses it into "clean". The four exit codes exist so a script can
  distinguish them.
- **Do not default the enforcer's silence.** A consumer that treats an empty
  result as "not configured yet, assume clean" has turned the enforcer's most
  dangerous failure mode into the default.

## Drift signals

[north-star.md](north-star.md) owns the four signals that the invariant is
eroding, and the argument for why each one matters. [drift.md](../concepts/drift.md)
owns the broader concept: structural change, configuration inconsistency, and the
gap between what the architecture declares and what the files do.

What belongs here is the governance consequence: each of those four signals is
individually reasonable, and together they are how a tool that exists to end
silent non-enforcement becomes a tool that practises it. The mechanisms in this
document — the four exit codes, the two named places for an empty list, the
failure-record contract — are the guards against that erosion.

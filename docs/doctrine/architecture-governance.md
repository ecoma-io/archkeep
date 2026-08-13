# Architecture governance

How Lattice's own development is governed by the same principles it enforces.
Every mechanism below runs in CI or is pinned by a test.

## The invariant

**An empty result is a claim, not a shrug.** That sentence, stated in
[AGENTS.md](../../AGENTS.md), is the measure every code path and every test is
judged against. It makes the two error directions unequal:

- **Loud** — reporting a violation that is not real. Someone sees it, disagrees,
  files an issue. Self-correcting.
- **Silent** — reporting nothing when a violation exists. Byte-for-byte identical
  to a clean workspace. Nobody files anything. The boundary everyone believes is
  enforced has not run for months.

The silent direction is the failure Lattice exists to end, and it is the more
dangerous of the two precisely because it is indistinguishable from success.
Every mechanism in the code exists because of that asymmetry:

- The CLI keeps four distinct exit codes. The distinction that matters is **3**
  (could not look — no workspace, malformed config, tool failure) against **0**
  (looked and found nothing). A checker that could not look must never be
  mistaken for one that looked and found nothing.
- The language server publishes an empty diagnostic list from exactly two named
  places: a completed analysis that found nothing, and `clearDiagnostics` when a
  document closes. A path that adds a third is the defect the design is built
  around.
- An analyzer that cannot read a file records the failure rather than dropping
  it. The worst case of every known parse limit is a spurious record naming text
  the file really contains — never a missed project.

## The boundary config as the single source of truth

One file at the workspace root — named by the `boundaryConfig` option — is the
single home of the constraint table and the eight options of
`@nx/enforce-module-boundaries`. Nothing in this project restates a constraint,
and nothing defaults an option. A default would be a second copy of a value the
workspace already stated, and the two would disagree the day one changed.

This is how Lattice practices what it enforces. A workspace's architecture is
declared in one place, and every consumer — the Nx hook, the CLI, the language
server, the ESLint rule in a TypeScript workspace — reads from that one place.
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

Four signals that the invariant is eroding, in the order they would probably
appear:

1. A language ships with edges and no enforcement, "for now".
2. A report stops saying what it inspected, and only says what it found.
3. A shape an analyzer cannot read is discovered and fixed without its header
   gaining a line.
4. Someone proposes an option that makes a check not run, argued on performance.

Each is individually reasonable. Together they are how a tool that exists to end
silent non-enforcement becomes a tool that practises it.
[north-star.md](north-star.md) owns the full argument.

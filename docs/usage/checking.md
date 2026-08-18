# Checking boundaries

Run the boundary law against the workspace.

```shell
pnpm exec lattice check
```

A clean tree prints what it inspected, not just that it found nothing — and
which law it inspected it against:

```text
policy  module-boundaries.config.mjs — fingerprint 3f9a2b7c1d4e5f608a1b2c3d4e5f6078b1e2d3c4f5a6b7c8d9e0f1a2b3c4d5e6

✔ no boundary violations (264 imports in 78 files across 12 projects)
```

Those counts are the point. "No violations" is a claim about coverage as much
as correctness, and a run that analyzed four files would otherwise look
identical to one that analyzed four hundred. The `policy` line above it is the
same claim applied to the law itself: a clean run under a permissive
`--config` and a clean run under the workspace's real one print the exact same
"no boundary violations" sentence, so the file (or profile) and the
fingerprint of the policy that produced it are named first, every time —
[json-output.md](../reference/json-output.md) documents the same two facts as
`result.policy` in `--format json`, and as a `properties.policy` entry on the
SARIF run.

## What `check` judges

One run combines four verdicts:

1. **Import boundaries** — every import site in every tracked, supported source
   file is matched against the boundary law.
2. **`go.work` drift** — when a tracked `go.work` exists at the root, its `use`
   list is compared against every project's `go.mod`.
3. **Dead tsconfig aliases** — when the workspace tsconfig declares a `paths`
   table, each alias is checked for at least one target directory that exists.
4. **Architecture intent** — when a tracked root
   `architecture-intent.json` exists, its declared boundaries and allowed /
   forbidden relationships are held against the observed graph. The schema and
   the four verdict states live in
   [architecture-intent.md](../reference/architecture-intent.md).

The second and third checks are workspace facts, so paths named on the command
line do not scope them.

## A violation

```text
apps/checkout-api/internal/handler/pay.go:14:2  onlyTagsConstraintViolation
  A project tagged with "scope:checkout" can only depend on libs tagged with scope:checkout, scope:shared
  import      "github.com/acme/billing-core/ledger" (static)  checkout-api → billing-core
  constraint  sourceTag scope:checkout, onlyDependOnLibsWithTags [scope:checkout, scope:shared]
```

Four things, each with a reader in mind: the `file:line:column` your terminal
turns into a link, the `messageId`, what is wrong, and **which row of the config
said so** — because that is the line a fix has to agree with.

The full catalogue of message ids and what resolves each one is in
[violations.md](../reference/violations.md). To inspect one site's full judgment — including
the tags and every matching constraint row — use
[`lattice explain`](explain.md). To see which constraints apply to a project
before editing it, use [`lattice context`](context.md).

## Scoped runs

Name paths after `check` to narrow source analysis:

```shell
lattice check apps/payments libs/ledger/src/lib.rs
```

A path outside the workspace, or one that matches no tracked file at all (a
typo, the wrong working directory, or a file not yet `git add`ed), is a usage
error, not a silent empty selection.

A scoped run is a fast local pre-check and **not the gate**: cycle and lazy-load
rules judge the file graph as a whole, so a scoped run can miss what a
whole-workspace run would find. CI should always run `lattice check` with no
paths.

A fitness function that needs the whole tree (`coverage-minimum` today, see
[fitness-functions.md](../concepts/fitness-functions.md)) cannot be judged from
a scoped run either. It reports `not_applicable` — named as needing a full run,
never silently skipped — and, unlike a real `unknown`, that does not fail the
run by itself. A workspace that declares `coverage-minimum` still needs an
unscoped `check` to actually enforce it.

## Formats

### Text

```shell
lattice check
lattice check --output report.txt
```

The default. `file:line:column` positions are terminal-linkable.

### SARIF

```shell
lattice check --format sarif --output lattice.sarif
```

SARIF 2.1.0 for GitHub code scanning. [ci.md](ci.md) shows the upload step.

### JSON

```shell
lattice check --format json
lattice check --format json --output report.json
```

A deterministic, versioned envelope for scripts. The schema and stability
promise are in [json-output.md](../reference/json-output.md).

## Exit codes

| code | meaning                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------- |
| `0`  | No findings, and every selected file was analyzed                                                               |
| `1`  | Boundary violation, `go.work` drift, dead tsconfig alias, or an architecture-intent finding                     |
| `2`  | Usage error — invalid arguments, unknown flag, a path outside the workspace, or a path matching no tracked file |
| `3`  | No verdict — the run could not look, coverage is incomplete, or intent could not be established                 |

A violation an active waiver accepts is still exit `1`: waiving a boundary
breach for a fixed term is a tracked decision, not a fix, so accepting it
never flips a red build green. The accepted half is reported under its own
"accepted violations" section, and the moment a waiver lapses the violation
re-asserts in full with the evidence `"expired waiver"` — see
[waivers.md](../concepts/waivers.md).

Do not collapse 3 into 0. A checker that could not look must never be mistaken
for one that looked and found nothing. [ci.md](ci.md) owns the full automation
contract.

## Override the policy for one run

```shell
lattice check --config proposed-boundaries.mjs
```

The file is resolved from the workspace root. It changes the boundary law, not
the workspace root or provider. This is useful when reviewing a proposed policy
without replacing the workspace's current one — and the run's own `policy`
line names `proposed-boundaries.mjs`, not the workspace's default file, so a
report generated this way is never mistaken for one the default law produced.

A workspace that names a `profiles` option selects a law by name instead: the
same `--config` then names a profile from the registry, and the run enforces
that profile's effective block for one run
([profiles.md](profiles.md) has the workflow). A one-run override that resolves
a different law than the one in effect is a review of that law, not a
verification of the change — when you report it, name the profile and say it is
not the law in effect.

What `--config` means depends entirely on whether the workspace's plugin
options declare a `profiles` registry: with one, `--config` is a profile NAME;
without one, it is a file path resolved from the workspace root. The two do not
mix, and `check` does not guess — an unknown name in a profile workspace and a
missing file without one both exit 3.

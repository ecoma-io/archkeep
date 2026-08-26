# @ecoma-io/archkeep-rules

The official generic rules catalog for Archkeep — documentation-as-data and an
integrity gate for shipped rule artifacts.

## Status

The catalog holds the first four rules — `tag-cardinality`,
`forbidden-tag-combination`, `max-fan-out`, and `max-fan-in` — with their
committed artifacts, digests, and fixture suites. More rules arrive in subsequent
changes. The package is not yet published to npm.

## What this package is

This package ships two things:

- **`catalog.json`** — the official registry of rule artifacts: name, description,
  contract version, evidence requirements, parameters schema, and the exact
  artifact path with its sha256 digest.
- **The validator** — pure-JS code that validates the catalog schema and verifies
  artifact integrity against actual bytes (`src/validator.mjs`, `src/fs-wrapper.mjs`).

The catalog is documentation-as-data. A consumer reads it to understand what
rules exist and what each one requires. The validator is the integrity gate: it
refuses a catalog whose schema is malformed, whose artifact digests don't match,
or whose artifacts are missing. Copying a sha256 from the catalog into your
`customRules` row is what makes "the law CI ran is the law a reviewer saw" a
checked fact, not a hope.

## Official rules vs workspace custom rules

Two ways to ship a custom rule exist, and they serve different purposes:

- **Workspace custom rules** — authored in your own workspace, built from source,
  and declared in your boundary policy under `customRules`. The artifact lives in
  your tree, and only your workspace uses it. This is how you write a rule that
  encodes your team's architecture decisions.
- **Official rules** — published here, in this package. Each rule's compiled
  artifact lives under `rules/` beside the `catalog.json` entry that names it,
  and a consumer copies the rule's name, artifact, and sha256 from the catalog
  into their own `customRules` row — pointing the row at their own copy of the
  bytes, never at this package at check time. The catalog is the index and the
  integrity check; the rule SDK packages (`packages/archkeep-rule-sdk-*`) are
  how a workspace authors rules of its own, official ones included when
  rebuilding from source.

The catalog is a registry, not a second policy engine. A workspace's boundary
policy declares `customRules`; the engine loads those artifacts and folds their
verdicts into `check`. The catalog never runs on its own — it is data the consumer
reads and copies, not a new authority layer that decides what to enforce.

## Artifact identity

A rule is identified by two things that must both match:

- **Name** — the selector the verdict is namespaced under. Must match the pattern
  `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` (lowercase letters, digits, single-dash separators).
  Example: `forbidden-tag-dependency`.
- **sha256** — the 64-character lowercase hex digest of the artifact's exact bytes.

Name collisions are a validation failure: two catalog entries with the same name
mean a finding cannot be uniquely attributed. The digest is what makes identity
checkable: "the law CI ran" and "the law a reviewer saw" are the same law only
when the digests match.

## Why the exact bytes are pinned

The sha256 digest in the catalog is the claim about the artifact. The validator
reads the catalog, computes the actual sha256 of each artifact file on disk, and
refuses the catalog if they differ. This is the integrity gate inside this package:
it proves shape (the catalog schema is valid) and digest agreement (the hash on
disk matches what the catalog declares).

What the validator does NOT prove is that the artifact is runnable as the catalog
claims — that the bytes load and self-describe with the name, contract, and needs
the entry states. That proof lives in `packages/archkeep/src/conformance/official-rules.integration.test.mjs`,
which loads every catalog artifact through the engine's REAL host at the catalog's
digest and requires the describe document to match the catalog entry. That conformance
suite runs in this repository's CI on every change, driving the actual host so a
rebuilt artifact that stopped answering its recorded verdicts fails the build
rather than a consumer's Tuesday.

A consumer copying a catalog entry into their `customRules` row does not need the
validator at all: their `check` refuses a mismatched artifact at load time, both
by hash and by self-description. The validator's job is to hold the published
catalog honest; the conformance suite's job is to hold the artifact itself honest.
Two different claims, two different gates, two different packages.

## Contract version

Every shipped artifact speaks **contract 1** — the version the custom-rule
interface defines. The catalog's `contract` field is a number (1), not a string.
A rule built against contract 2 would fail to load at all, so the catalog
validates this up front and refuses loudly rather than silently shipping an
unloadable rule.

The contract governs what the artifact exports and what evidence it receives.
A rule declares what it needs (`needs: ["model","graph","imports","policy"]`),
and the engine hands it exactly those kinds, no more and no less. A rule asking
for an unknown kind is refused at load time, and the validator catches this in
the catalog before it ever ships.

## Why this is not a new authority layer

A workspace's boundary policy is the only declaration the engine reads. The
`customRules` rows in that policy name the artifacts to load, and the engine
loads them and folds their verdicts into `check`. Nothing else decides what runs.

The catalog does not change that. It is documentation and an integrity check, not
a policy engine. A consumer copies from the catalog into their `customRules`
row, or they don't. The engine never reads the catalog directly; it reads the
policy the consumer wrote. The official rules are published artifacts, but the
consumer decides which of them (if any) to declare, and the consumer's policy is
the only declaration the engine sees.

## Development

Run the validator against the committed tree:

```bash
node packages/archkeep-rules/src/fs-wrapper.mjs
```

Run the test suites (the node half; the Rust half is `cargo test`):

```bash
node --test packages/archkeep-rules/test/*.test.mjs
```

The catalog is validated on every commit by CI. Adding a rule means adding an
entry to `catalog.json`, committing the artifact beside its `.wasm.sha256`, and
running the validator to prove the digest matches — `./rebuild-rules.sh` is the
command that rebuilds the artifacts (in a container, never on a host machine —
its header says why) and re-records both digest files.

## The rules

Each rule below states its intent, its parameters, the evidence it depends on,
what each of the four verdicts means for it, and what it does **not** claim.
None of them establishes a design pattern or an architecture style: a rule is a
machine-checkable predicate over the evidence the engine already computed, and
the moment it passes says exactly one thing — this predicate held.

### tag-cardinality

**Intent.** Constrain how many distinct tag values a project may carry on one
axis — most often "exactly one", the shape a workspace's convention needs
before any direction rule is writable (a project tagged both `layer:domain`
and `layer:adapter` is invisible to every constraint written against
`sourceTag`).

**Parameters.**

| name    | type   | required | meaning                                                                                                                                                |
| ------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `axis`  | string | yes      | The axis counted — the segment before the first `:` of a tag (`layer:domain` carries the value `domain` on `layer`).                                   |
| `min`   | number | no       | The fewest distinct axis values an in-scope project may carry (integer ≥ 0). At least one of `min`/`max` must be present.                              |
| `max`   | number | no       | The most distinct axis values an in-scope project may carry (integer ≥ `min`).                                                                         |
| `match` | array  | no       | Tags an in-scope project must carry ALL of; absent means every project. An empty array is malformed, not "every project" — absent is how you say that. |

**Evidence.** `model` only. The rule never reads the graph: it judges how a
project is tagged, not what it depends on.

**Verdicts.**

- `fail` — an in-scope project carries fewer than `min` or more than `max`
  distinct values on the axis. One finding per project per bound, naming the
  project, the count, and the bound.
- `pass` — every in-scope project's count is within range.
- `not_applicable` — no project is in scope (no project carries all the
  `match` tags, or the workspace has no projects at all).
- `unknown` — the parameters cannot be read as declared: an unknown key (a
  typo judged with defaults is the quiet direction this refuses), a missing or
  non-string `axis`, a non-integer or negative bound, `min` above `max`, or a
  malformed `match`.

**Limitations.** A tag with no `:` carries no axis value, so a workspace whose
tags are entirely dash-form (this repository's own Moon vocabulary included)
counts zero per project for every axis — which with `min ≥ 1` fails loudly
rather than silently, and with only `max` passes trivially. The rule counts
distinct VALUES: two tags with the same axis value count once, and duplicate
tag entries count once. It says nothing about which value a project should
carry — that is a direction question, and the constraint table already owns it.

**Usage example.**

```jsonc
{
  "name": "tag-cardinality",
  "artifact": "tools/rules/tag-cardinality.wasm",
  "sha256": "<copy from catalog.json — it equals rules/tag-cardinality.wasm.sha256>",
  "params": { "axis": "layer", "min": 1, "max": 1 },
  "reason": "every project states exactly one layer; direction rules are written against it",
}
```

### forbidden-tag-combination

**Intent.** Forbid one declared set of tags from co-existing on the same
project — the shape of "a domain project is not a database runtime", stated
once instead of as one row per consequence.

**Parameters.**

| name   | type  | required | meaning                                                                                                  |
| ------ | ----- | -------- | -------------------------------------------------------------------------------------------------------- |
| `tags` | array | yes      | The combination: every entry a non-empty string, no duplicates. A project carrying ALL of them violates. |

**Evidence.** `model` only — a judgment about how a project is tagged.

**Verdicts.**

- `fail` — a project carries the whole combination. One finding per project,
  naming the project and the combination.
- `pass` — projects carry at most partial combinations.
- `not_applicable` — no project in the workspace carries any of the tags at
  all: the vocabulary the rule speaks about is absent, which is the reference
  rule's own reading of the same state.
- `unknown` — malformed parameters: `tags` not an array, empty, carrying a
  non-string or empty entry, a duplicate entry, or an unknown key beside it.

**Limitations.** The rule is set-membership over exact tag strings — no
patterns, no exclusions, no "unless it also carries X" (declare a second
combination instead, or exempt via `match`-style scoping in a rule of your
own). A single entry in `tags` is legal and means "no project may carry this
tag"; nothing else in the policy vocabulary forbids BEARING a tag, but if that
is what you mean, say it in the `reason` where a reviewer reads it.

**Usage example.**

```jsonc
{
  "name": "forbidden-tag-combination",
  "artifact": "tools/rules/forbidden-tag-combination.wasm",
  "sha256": "<copy from catalog.json — it equals rules/forbidden-tag-combination.wasm.sha256>",
  "params": { "tags": ["layer:domain", "runtime:database"] },
  "reason": "a domain project is not a database runtime; the two roles never share a project",
}
```

### max-fan-out

**Intent.** Constrain how many distinct projects a project may depend on — a
budget on architectural coupling, measured by the number of unique downstream
dependencies.

**Parameters.**

| name    | type   | required | meaning                                                                                                                                                |
| ------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `max`   | number | yes      | The most distinct projects an in-scope project may depend on (integer ≥ 0).                                                                            |
| `match` | array  | no       | Tags an in-scope project must carry ALL of; absent means every project. An empty array is malformed, not "every project" — absent is how you say that. |

**Evidence.** `model` and `graph`. The rule reads the dependency graph and counts
distinct targets per project.

**Verdicts.**

- `fail` — an in-scope project depends on more than `max` distinct projects.
  One finding per project, naming the project, the count, and the budget.
- `pass` — every in-scope project's distinct dependency count is at or under the
  budget.
- `not_applicable` — no project is in scope (no project carries all the `match`
  tags, or the workspace has no projects at all).
- `unknown` — the parameters cannot be read as declared: an unknown key, a
  missing or malformed `max` (negative, fractional, or a string), or the graph
  names a project the model does not declare.

**Limitations.** The budget counts DISTINCT targets regardless of edge type:
static and dynamic edges to the same project count once. Self-edges (source
equals target) are skipped — providers never emit them, but a replayed bundle
might carry one. A budget is user policy — the rule says a number was exceeded,
nothing about whether the architecture is "good" or "bad". This rule judges HOW
MANY dependencies a project has, not WHICH targets it may depend on; `depConstraints`
already judges WHICH targets are allowed edge by edge. Zero dependencies is a valid
budget state. The count is exactly as complete as the graph the run's provider
computed: when the Nx plugin is unregistered but polyglot manifests are present,
`check` reports a degraded-coverage note and keeps exit 0, and the provider graph
then lacks the polyglot edges the boundary rules still see through the engine's
own analysis. A fan-out verdict should be read beside the run's coverage notes —
a run reporting unregistered-plugin coverage has a graph without polyglot edges,
so fan-out counts under-report.

**Usage example.**

```jsonc
{
  "name": "max-fan-out",
  "artifact": "tools/rules/max-fan-out.wasm",
  "sha256": "<copy from catalog.json — it equals rules/max-fan-out.wasm.sha256>",
  "params": { "max": 2, "match": ["scope:shared"] },
  "reason": "a shared project may depend on at most two other projects — anything more is a coupling violation",
}
```

### max-fan-in

**Intent.** Constrain how many distinct projects may depend on a project — a
budget on architectural popularity, measured by the number of unique upstream
dependents.

**Parameters.**

| name    | type   | required | meaning                                                                                                                                                |
| ------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `max`   | number | yes      | The most distinct projects that may depend on an in-scope project (integer ≥ 0).                                                                       |
| `match` | array  | no       | Tags an in-scope project must carry ALL of; absent means every project. An empty array is malformed, not "every project" — absent is how you say that. |

**Evidence.** `model` and `graph`. The rule reads the dependency graph and counts
distinct sources per project.

**Verdicts.**

- `fail` — an in-scope project is depended on by more than `max` distinct
  projects. One finding per project, naming the project, the count, and the budget.
- `pass` — every in-scope project's distinct dependent count is at or under the
  budget.
- `not_applicable` — no project is in scope (no project carries all the `match`
  tags, or the workspace has no projects at all).
- `unknown` — the parameters cannot be read as declared: an unknown key, a
  missing or malformed `max` (negative, fractional, or a string), or the graph
  names a project the model does not declare.

**Limitations.** The budget counts DISTINCT sources regardless of edge type:
static and dynamic edges from the same source count once. Self-edges (source
equals target) are skipped — providers never emit them, but a replayed bundle
might carry one. A budget is user policy — the rule says a number was exceeded,
nothing about whether the architecture is "good" or "bad". This rule judges HOW
MANY projects depend on a project, not WHICH projects may depend on it;
`depConstraints` already judges WHICH sources are allowed edge by edge. Zero
dependents is a valid budget state. **High fan-in does not mean a highly reused
dependency is bad** — the rule expresses an explicit architectural budget the
workspace declared (shared-kernel budget, gravity-well control, platform-module
limits are the use cases), and passing says only "within budget". The count is
exactly as complete as the graph the run's provider computed: when the Nx plugin
is unregistered but polyglot manifests are present, `check` reports a
degraded-coverage note and keeps exit 0, and the provider graph then lacks the
polyglot edges the boundary rules still see through the engine's own analysis.
A fan-in verdict should be read beside the run's coverage notes — a run reporting
unregistered-plugin coverage has a graph without polyglot edges, so fan-in counts
under-report.

**Usage example.**

```jsonc
{
  "name": "max-fan-in",
  "artifact": "tools/rules/max-fan-in.wasm",
  "sha256": "<copy from catalog.json — it equals rules/max-fan-in.wasm.sha256>",
  "params": { "max": 5, "match": ["scope:shared"] },
  "reason": "a shared project may be depended on by at most five other projects — anything more is a gravity-well violation",
}
```

Both rules answer `unknown` — never `pass` — when their parameters cannot be
read as declared, and both hold fixture suites under `fixtures/` whose
recorded verdicts the engine's conformance gate replays through the real host
(`../archkeep/src/conformance/official-rules.integration.test.mjs`), so a
committed artifact that stopped answering its recorded verdicts fails the
build rather than a consumer's Tuesday.

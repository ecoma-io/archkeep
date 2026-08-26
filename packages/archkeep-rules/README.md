# @ecoma-io/archkeep-rules

The official generic rules catalog for Archkeep — documentation-as-data and an
integrity gate for shipped rule artifacts.

## Status

**This package is the foundation only.** The catalog is empty (`rules: []`), and
no rules are shipped yet. This change establishes the schema and validator; rules
arrive in subsequent changes. The package is not yet published to npm.

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
refuses the catalog if they differ. This is the integrity gate: a rule artifact
is committed and published, and any change to those bytes would change the digest.
A catalog that validated a changed digest would ship a lie.

This is why the artifact path in the catalog is package-relative (`rules/<name>.wasm`).
The same catalog entry resolves to the same bytes on every machine, and CI and
reviewers stay in sync because they both verify against the same catalog.json.

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

Run the test suite:

```bash
node --test packages/archkeep-rules/test/*.test.mjs
```

The catalog is validated on every commit by CI. Adding a rule means adding an
entry to `catalog.json`, committing the artifact, and running the validator to
prove the digest matches.

# Architecture intent

`check` judges one thing that no rule table can: the intended architecture
itself. The boundary law
([policy-schema.md](policy-schema.md)) says which projects may import which;
architecture intent says what the grouping _is_ and which relationships the
team holds sacred — and reports when the observed code does not match it.

```json
{
  "version": "1",
  "boundaries": [
    { "name": "packages", "match": ["tag:type-package"] },
    { "name": "extensions", "match": ["tag:type-extension"] }
  ],
  "forbidden": [
    {
      "from": "packages",
      "to": "extensions",
      "reason": "a package must never reach out into an editor extension"
    }
  ]
}
```

The file is `architecture-intent.json`, read from the workspace root. It is
**optional**: a workspace without one runs exactly as it did before, with no
new output and no change to any exit code. When one is present and tracked, it
becomes a fourth verdict inside the same `check` run.

## The two lists, and which direction each rules

- **`forbidden`** — a dependency that must not exist between two groups. A
  forbidden relationship is violated by **any** path, direct or transitive —
  the same closure `@nx/enforce-module-boundaries`'s
  `notDependOnLibsWithTags` already enforces for JavaScript. If `packages`
  may not reach `extensions`, then `packages → broker → extensions` is a
  violation too, reported as `intentForbiddenEdge`. Every forbidden row
  requires a `reason`.
- **`allowed`** — a dependency the team intends to exist, or claims exists.
  Intent is **not** a permission list: an `allowed` row does not forbid
  anything. Instead it asserts an observed fact, and a row with no observed
  edge is **drift** — reported as `intentAllowedMissing`, exit 1 — because
  an architecture statement that says "this is how we connect" while nothing
  connects is exactly the discrepancy intent exists to catch.

An `allowed` row carries `optional: true` when the statement is aspirational
— the dependency _should_ exist but has not been built yet. An unobserved
optional row is demoted to a coverage note, not a finding.

`allowed` and `forbidden` may not state the same `from → to` pair: one
dependency cannot be both explicitly allowed and explicitly forbidden. That is
a load error, not a silent preference.

## Boundaries, and how `match` selects projects

A boundary is a named group of projects sharing an architecture role. Its
`match[]` is a small, exact-match selector grammar — deliberately **not** Nx's
matcher, because intent is a contract and must mean exactly what it says. Nx's
unlabeled patterns fall back to a case-insensitive substring regex, which
would quietly pull `platform-domain` into a boundary that said `domain`, and
which builds a `RegExp` from workspace-supplied text; intent's grammar is
matched by string equality only, so neither the over-approximation nor that
surface exists.

| selector        | matches                                                        |
| --------------- | -------------------------------------------------------------- |
| `name:<name>`   | the project with that exact name (a bare `<name>` is the same) |
| `tag:<tag>`     | every project carrying that tag (in `data.tags`)               |
| `directory:<d>` | every project whose root directory is exactly `<d>`            |
| `*`             | every project                                                  |
| `!<selector>`   | set difference from whatever the rest of `match[]` selected    |

A boundary's members are the union of its positive selectors minus its `!`
selectors. A list that opens with an exclusion, like
`["!tag:type-package"]`, means "everything except…". A boundary with no
selectors, or with selectors that match nothing observed, is an **error in
the direction of loudness** — see below.

## `from` / `to` resolve to boundaries or inline selectors

Each side of an `allowed` or `forbidden` row is either a declared boundary
`name` (which wins, deterministically) or an inline selector. So this is
valid:

```json
{ "forbidden": [{ "from": "tag:type-package", "to": "extensions", "reason": "…" }] }
```

A side that is neither a declared boundary nor a valid selector is a load
error, because a typo like `tagz:` would otherwise silently match nothing at
judge time.

## Governance is a deterministic comparison

The intent file declares the intended architecture; the observed architecture
is the graph Lattice already derives from source. Governance is the comparison
of the two — a pure, deterministic function of `(intent, graph)`. Nothing in
this feature reasons, guesses, or generates a law: intent stays a human,
machine-readable declaration, and Lattice reports, it does not decide what the
architecture should be.

## The four states, and the exit code each maps to

Intent turns `check`'s usual three verdicts into a four-way distinction, all
machine-readable through `--format json`:

| state            | means                                                                            | verdict / exit   |
| ---------------- | -------------------------------------------------------------------------------- | ---------------- |
| compliant        | every `forbidden` rule holds, every `allowed` rule is observed                   | `ok` / 0         |
| violation        | a `forbidden` path exists, or an `allowed` edge is missing                       | `findings` / 1   |
| invalid intent   | the file will not parse or validate — a declaration the tool cannot read         | `no-verdict` / 3 |
| cannot establish | a boundary or row side matched no observed project — nothing to judge it against | `no-verdict` / 3 |

The last two exist for the invariant this tool refuses to let go of: **an
unverifiable intent must never read as a satisfied one.** A boundary whose
selectors match no project is not "clean by default" — it is a claim the tool
cannot check, and it withholds the verdict (exit 3) rather than reporting
success. A malformed intent file is treated exactly like a malformed
`go.work`: a whole-file failure that names the file, never folded into a count
of "files that could not be analyzed".

## Absence and untracked files

- A workspace with **no** `architecture-intent.json` runs byte-identically to
  one before this feature existed. No section, no mention, no exit-code change.
- An **untracked** intent file (not in `git ls-files`) is treated as absent —
  an intentional file is not the reviewed repository state, the same rule
  `check` applies to `go.work`.

## The envelope and the text report

- `--format json`: when the intent file exists and is tracked, `result.intent`
  appears — `{ checked, file, verdict, findings, unresolved, boundaries }`.
  The `intent` key is **absent** (never `null`) when there is no intent file,
  so an intent-less run's envelope is byte-identical to a pre-feature one.
  Each finding carries `{ source, target, rule, boundaryFrom, boundaryTo,
message }`; `unresolved` is the list of boundaries (or row sides) that
  matched no observed project; `boundaries` is the membership that was judged,
  `[{ name, projects }]`.
- The text report prints one line when intent is present and judged:
  `✔ architecture-intent agrees with the observed graph (N boundaries)`, or a
  findings/no-verdict section under the same "never a silent empty" rule.

A `status: "ok"` run can never carry an intent no-verdict: if intent could not
be established, the run's verdict is `no-verdict` (exit 3), never `ok`.

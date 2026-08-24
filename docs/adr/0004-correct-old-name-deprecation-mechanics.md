---
id: 0004-correct-old-name-deprecation-mechanics
status: accepted
---

# ADR 0003's crates.io and Go deprecation mechanics were wrong; here is what actually ran

## Status

Accepted. [ADR 0003](0003-rename-lattice-to-archkeep.md) is immutable once
accepted — the same rule its own §8 states for 0001 and 0002 — so a correction
to what it decided is this new record, not an edit to that one.

## Context

ADR 0003 §3 described a compatibility mechanism for each already-published
Lattice artifact. Two of those four bullets described a mechanism that does
not exist, discovered while writing the deprecation runbook
([development/release.md](../development/release.md)) that ADR 0003 itself
promised:

- **crates.io.** ADR 0003 said the crate's description/homepage is "an
  owner-level edit, independent of publishing." It is not — crates.io reads
  `description`/`homepage` from `Cargo.toml` only at publish time, and a
  published version's metadata is frozen forever. There is no dashboard, no
  API, no mechanism to edit it after the fact.
- **Go.** ADR 0003 said "there is no 'deprecate' mechanism to invoke because
  Go modules have none." Go modules have one: a `// Deprecated:` doc comment
  placed directly before (or after, same line as) the `module` directive in
  `go.mod`, which `go get`, `go list -m -u` (Go 1.17+), and pkg.go.dev all
  read once a tag carrying it becomes the `@latest` version for that module
  path ([go.dev/ref/mod#go-mod-file-module](https://go.dev/ref/mod#go-mod-file-module)).

ADR 0003's PyPI bullet was already correct — no independent deprecation flag,
a final release is the only channel — and is not revisited here.

Both wrong claims trace to the same failure this repository's own doctrine
names: a mechanism stated from memory rather than checked against the
registry's current documentation or an actual run. Corrected here by doing
both — reading each registry's own docs, then executing the corrected
mechanism for real and verifying the result against the live registry.

Separately raised and answered while investigating: whether any of the four
registries can **delete** an already-published old-name artifact outright,
rather than merely deprecate it. Verified directly, in case the question
recurs:

- **npm** — self-service `npm unpublish` after 72 hours requires (among other
  conditions) fewer than 300 downloads in the trailing week. `@ecoma-io/lattice`
  measured 1,769/week and `@ecoma-io/lattice-rule-sdk` 354/week at the time of
  this record — both ineligible. Not that deletion was ever the plan; this
  settles the question without needing to re-derive it later.
- **crates.io** — no deletion mechanism exists at any level, including of an
  entire crate name once claimed. By design: crates.io states its own goal is
  to be "a permanent archive... that does not change over time."
- **PyPI** — the one exception: an owner can delete a whole project or a
  single release through the web UI, self-service, no support ticket. It is
  also permanent and irreversible, and the exact filename (name + version +
  distribution type) can never be reused afterward even if the project is
  recreated.
- **Go module proxy** — `proxy.golang.org` caches every fetched version
  immutably by design, specifically so a build pinned to a version never
  breaks regardless of what happens to the source afterward. No purge
  mechanism exists.

None of this changes ADR 0003 §3's decision to deprecate rather than delete —
if anything it reinforces it: deletion is either impossible (crates.io, Go),
blocked by the registry's own policy (npm, at current download volume), or
technically possible but stranding real installs for no offsetting benefit
(PyPI). Restated here as "Refused alternatives" below rather than left to be
re-litigated.

## Decision

With the corrected mechanics, execute the deprecation ADR 0003 always intended
for crates.io and Go, and re-run the count-limited npm/PyPI checks (unchanged
from ADR 0003) to confirm they still hold:

- **crates.io** — one more `lattice-rule-sdk` release, `0.12.1`, whose only
  change from the last published version (`0.12.0`) is `Cargo.toml`'s
  `description`/`homepage`/`repository` and a moved-notice banner in
  `README.md` (crates.io renders the crate's `readme` as its long
  description). No file under `src/` or `examples/` changes — the already-clean
  `examples/forbidden_tag_dependency.wasm` ships byte-identical, its digest
  verified against its own checked-in `.sha256` before packaging.
- **Go** — tag `packages/lattice-rule-sdk-go/v0.12.1`, whose `go.mod` carries
  the `// Deprecated:` comment above the `module` directive and nothing else
  changed. **Done**: pushed directly (`7425b7a`), confirmed live —
  `proxy.golang.org`'s `@latest` for
  `github.com/ecoma-io/lattice/packages/lattice-rule-sdk-go` resolves to
  `v0.12.1` and serves the `go.mod` with the notice intact.
- **PyPI** — one more `lattice-rule-sdk` release, `0.12.1`, whose only change
  is `pyproject.toml`'s `description`/`[project.urls]` and a moved-notice
  banner in `README.md` (PyPI renders it as the long description via
  `readme = "README.md"`). No file under `src/` changes. Built and
  `twine check`-verified locally; **the sdist and wheel were inspected file by
  file and neither contains `examples/`** — closing, with an actual build
  rather than the inference it was, the "worth confirming against the actual
  published sdist" hedge in
  [issue #288](https://github.com/ecoma-io/archkeep/issues/288)'s severity
  assessment of the pre-rename artifact's secret leak. This final release
  cannot carry that leak forward.
- **npm** — unchanged from ADR 0003: `npm deprecate` against both existing
  packages, pointing at their new names. Still correct, still not yet run —
  manual on purpose, per [development/release.md](../development/release.md).

Both the Rust and Python final releases are built from the pre-rename source
tree exactly as it existed at the commit before #287 renamed the directories
away (`b128c30~1`) — extracted via `git archive`, not hand-retyped — with only
the metadata files touched. Neither commit merges into `main`: the directories
these packages lived in no longer exist there, the same shape the Go tag
already took. Each is a standalone commit reachable only through its
registry publish or release tag.

## Consequences

- **`development/release.md`'s "Deprecating the Lattice names" section is
  rewritten** to state the corrected mechanics and point here instead of
  repeating this record's reasoning.
- **Six more artifacts across three registries, each permanent once
  published** — the last mutation any of `lattice-rule-sdk` (crates.io/PyPI)
  or `.../lattice/packages/lattice-rule-sdk-go` will ever see. No further
  release follows any of them.
- **The version chain gains a throwaway branch, not a new head.** These
  releases carry the version `0.12.1` but never join the single version chain
  release-please owns for the `.` component — they are not part of that
  package anymore, the same way the Go tag was never part of
  `extra-files`.

## Refused alternatives

- **Deleting the already-published old-name artifacts instead of
  deprecating them** — refused again, for the reasons ADR 0003 §3 already
  gave, now confirmed rather than assumed: impossible outright for crates.io
  and the Go module proxy, blocked by npm's own eligibility policy at current
  download volume, and for PyPI — the one registry where it is actually
  possible — permanent and disruptive to real installs for no benefit a
  deprecation notice does not already provide.
- **Editing ADR 0003 in place to fix the two wrong bullets** — refused. An
  accepted record here describes what was decided and why, not what is true
  today; a corrected decision is a new record, per ADR 0003 §8's own
  statement of that rule for 0001 and 0002.

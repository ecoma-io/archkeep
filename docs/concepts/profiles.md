# Named law profiles

A workspace sometimes needs more than one boundary law, and until now it could
only have one: `boundaryConfig` names a single file, and every run — `check`,
`graph`, the editor — judged against that one table. Changing the law meant
rewriting that file. A **named profile** is a second way to hold several laws at
once: a registry of named policy blocks, each inheriting from a `base`, with the
`check` command selecting one by name for a run.

A profile is data, not a new dialect. Each profile's `block` is a policy block
of the exact three keys every boundaryConfig dialect already shares —
`depConstraints`, `moduleBoundaryOptions`, `boundarySuppressions`
([policies.md](policies.md) owns those dialects) — validated by the same
validator. The resolution result runs through the same enforcement path as a
file, so there is exactly ONE way a policy becomes a verdict: a profile is a way
to name and reuse a policy, never a second kind of policy that could disagree
with a file about the same row.

## Why they exist

The single-file model fails when the workspace's boundary law depends on who is
asking:

- **A new team picks up the law incrementally.** A strict profile with all eight
  options at their strongest, a relaxed base profile for a project that is
  migrating in.
- **A temporary re-baseline.** A team lands a large refactor behind a permissive
  profile, then flips back — without rewriting the file, because the strict
  profile is still there.
- **A proposal under review.** A profile candidate is checked with
  `lattice check --config proposed`, reviewed, and deleted or promoted — never
  edit-and-revert on the live file.

Each is a case where the file was the wrong unit of change. A profile registry
makes the law a set of named options a run selects, instead of one document a
run mutates.

## How one is declared

The registry is a JSON file named by the `profiles` plugin option
([configuration](../reference/configuration.md#nxjson-plugin-options)). A
profile has a `name`, an optional `base` (the name of another profile whose
effective block it inherits), and a `block` of the three policy keys:

```json
{
  "version": 1,
  "profiles": [
    {
      "name": "strict",
      "block": {
        "depConstraints": [
          { "sourceTag": "layer:domain", "onlyDependOnLibsWithTags": ["layer:domain"] }
        ],
        "moduleBoundaryOptions": {
          "allow": [],
          "buildTargets": ["build"],
          "enforceBuildableLibDependency": true,
          "allowCircularSelfDependency": false,
          "checkDynamicDependenciesExceptions": [],
          "ignoredCircularDependencies": [],
          "banTransitiveDependencies": true,
          "checkNestedExternalImports": true
        }
      }
    },
    {
      "name": "migration",
      "base": "strict",
      "block": {
        "depConstraints": [
          { "sourceTag": "scope:legacy", "onlyDependOnLibsWithTags": ["scope:shared"] }
        ],
        "moduleBoundaryOptions": { "enforceBuildableLibDependency": false }
      }
    }
  ]
}
```

Two top-level keys are recognized — `profiles` (required) and `version`
(defaults to `1` when absent, must be `1` when present) — plus `$schema`,
which is tolerated for editor validation. Any other key is rejected by name.
Each profile may carry only `name`, `base`, and `block`; the block only the
three policy keys.

A profile with no `base` stands alone. With a `base`, the child inherits its
effective block and merges on top of it:

- **`depConstraints` rows append.** A dependency must satisfy EVERY row whose
  `sourceTag` its source project carries — the composition semantics of
  `@nx/enforce-module-boundaries` — so axes compose rather than replace. A
  child's rows are judged after its base's, in that order.
- **`moduleBoundaryOptions` keys overwrite, key by key.** An option the child
  does not state falls through to the base's value; the eight options are never
  defaulted here any more than they are in a file.
- **`boundarySuppressions` rows append.** A child cannot un-suppress what its
  base suppressed.

A chain may be longer: `c` on `b` on `a`, resolved depth-first, earlier
profiles first, so a chain reads in the order it was written.

## Selecting by name

The `profiles` option names the registry file. When it is present, the value of
`--config` — and, absent that, of `boundaryConfig` — is treated as a profile
NAME selected from that registry, not as a filename:

```json
{
  "plugins": [
    {
      "plugin": "@ecoma-io/lattice/nx",
      "options": {
        "boundaryConfig": "migration",
        "tsConfig": "tsconfig.base.json",
        "profiles": "law-profiles.json"
      }
    }
  ]
}
```

`check` resolves the named profile to its effective block and enforces exactly
as if that block were a file: a profile is a way to name a policy, never a
second kind of policy. Override for one run the same way a file is overridden —
`lattice check --config strict` selects the `strict` profile. A one-run override
that resolves a different law than the one in effect is a review of that law,
not a verification of the change — when you report it, name the profile and say
it is not the law in effect.

## What is loud, and why

A registry that silently compensated for its own defects would repeat the one
failure this tool exists to end. Four conditions refuse loudly instead:

- **Unknown `base`** — `base` names a profile that does not exist. Read as "no
  base", the profile would shed the rows it was meant to inherit: the stack
  stops enforcing its base block, and nothing says so.
- **A cycle** in a base chain — `a` on `b` on `a`. A cycle has no deterministic
  resolution; stopping it loudly is the only correct answer.
- **Unknown selected name** — `--config`/`boundaryConfig` names a profile the
  registry does not have. A policy that selects an unknown profile enforces
  nothing and says nothing.
- **A missing or unparseable registry file** — no command that depends on it can
  reach a verdict, so the run exits 3 rather than answering from a default.

Each of the four is a silent-direction guard (`AGENTS.md`: an empty result is a
claim, not a shrug). The reference page names the exact failure
[profiles](../reference/profiles.md), and the schema reference for the registry
object lives there too.

## How profiles and files relate

A workspace never mixes them per run: `profiles` present means `boundaryConfig`
is a profile name, `profiles` absent means it is a filename — exactly as
before. The two are alternatives at the same field, the same way
`lattice.json`'s inline `boundaryConfig` is an alternative to naming a file.
The language server does not read a profile-selected law yet; it refuses
loudly rather than watching a name as though it were a file, for the same
reason it refuses an inline law — see the reference page's "The `profiles`
plugin option".

Every command that reads a boundary law resolves a profile by name, not only
`check`: `context`, `graph`, `explain`, `impact`, `diff`, `fitness`, `waivers`,
`debt`, `health`, and `history --capture` share `check`'s own config-resolution
step, so a profile-selected workspace reads `--config`/`boundaryConfig` as a
profile NAME everywhere a boundary law is read, never as a file path. The four
loud conditions above apply identically on every one of them — an unknown
name, a bad `base`, a cycle, or an unreadable registry all exit 3 wherever they
are hit, not only under `check`. `graph`'s snapshot carries the resolved
profile's policy fingerprint the same way it already does for a file or an
inline policy, so `history` and `diff` classify a profile edit as a policy
change across two captures the same way they classify one in the other two
dialects.

Only `check`'s own report names which profile it enforced — `result.policy.profile`
in `--format json`, and a `policy` line first in the text and SARIF reports
([json-output.md](../reference/json-output.md)) — so a `check` run can be read
back against itself: the reader no longer has to take a change report's word
for which law produced the verdict. The other ten commands report no such
identity, so anything a change report cites about one of them — "the graph",
"the context" — must still name the `--config <NAME>` it ran with; only
`check`'s reader gets that fact from the report itself.

A profile's `block` carries exactly three keys — `depConstraints`,
`moduleBoundaryOptions`, `boundarySuppressions` — so a profile-selected run
folds no fitness functions and no governance-origin rows it cannot carry: a
`fitness` export exists only on a boundary-config **file** (`policyFrom`
requires the export there). What a profile cannot express is a file-only
capability, stated as such rather than silently shortened.

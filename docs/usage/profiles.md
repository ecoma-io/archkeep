# Enforcing a named profile

Select a law by name instead of by file. First declare the registry — the
concept and the schema are
[profiles.md](../concepts/profiles.md) and
[profiles.md](../reference/profiles.md) — then name it in the plugin options:

```json
{
  "plugins": [
    {
      "plugin": "@ecoma-io/lattice/nx",
      "options": {
        "boundaryConfig": "strict",
        "tsConfig": "tsconfig.base.json",
        "profiles": "law-profiles.json"
      }
    }
  ]
}
```

`boundaryConfig` still names the law in effect — only now it names it by
looking the name up in the registry instead of opening a file. The default
`check` run resolves the `strict` profile and enforces exactly as if its block
were a file.

## Check a different profile for one run

```shell
lattice check --config migration
```

`--config` decides the same way it decides a filename: the value overrides
`boundaryConfig`, and a profile workspace resolves it by name. This is the way
a proposed law is reviewed without touching the registered one. A run that
resolves a different profile than in effect is a review of that profile, not a
verification of the change — when you report it, name the profile and say it is
not the law in effect.

## Every command resolves it, not only `check`

`context`, `graph`, `explain`, `impact`, `diff`, `fitness`, `waivers`, `debt`,
`health`, and `history --capture` all read `boundaryConfig`/`--config` the same
way `check` does: a profile NAME when the workspace names a `profiles`
registry, never a file path. `lattice context <project>` and
`lattice graph --output` work against a profile-selected workspace exactly as
they do against a file-selected one — `graph`'s snapshot carries the resolved
profile's policy fingerprint, so `history` and `diff` see a profile edit as a
policy change the same way they already see a file edit as one. The one
exception is fitness functions: a profile's block carries no `fitness` key
(only a boundaryConfig **file** can declare one), so `fitness` on a
profile-selected workspace reports its own "declares no fitness functions"
rather than judging anything.

## What a profile-selected run reports

The verdict, the exit codes, and the counts are the same ones
[checking.md](checking.md) documents, because the enforcement path is the
same: a profile resolves to a policy block, and the block is judged like any
other. What is distinct is the FIRST thing every format now states: which
profile governed the run. The text and SARIF reports open with a `policy`
line naming it (`policy  profile "migration" from law-profiles.json —
fingerprint …`), and `--format json` carries it as `result.policy.profile`
alongside `result.policy.source` (the registry file) and
`result.policy.fingerprint` — [json-output.md](../reference/json-output.md)
is the schema. A change report can still name the `--config <NAME>` it ran
with by hand, but no longer has to be trusted on it: the report itself now
says which law produced the verdict.

## What fails loudly

A registry the run cannot trust stops the run with exit 3 rather than
answering from a default. The four conditions — unknown `base`, a `base`
cycle, an unknown selected name, a missing or unparseable registry — are named
in [reference/profiles.md](../reference/profiles.md), each with the exact
message. When `profiles` is absent, `check`'s `policy` line/field names
`profile: null` explicitly rather than omitting it: `boundaryConfig` is a
filename, exactly as before, and the report says so rather than staying
silent about the axis.

## The editor

A workspace whose options name a `profiles` registry is refused at editor
startup, loudly, rather than diagnosed from a name read as a file. The language
server only ever reads a policy _file_, and a profile name is a selector — move
the policy into its own `.mjs`/`.json` file and drop the `profiles` option to
use it in an editor. That refusal is one of the editor's named limits in
[troubleshooting.md](troubleshooting.md).

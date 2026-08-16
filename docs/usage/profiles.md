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
a proposed law is reviewed without touching the registered one.

## What a profile-selected run reports

Nothing distinct. The verdict, the exit codes, the report formats, and the
counts are the same ones [checking.md](checking.md) documents, because the
enforcement path is the same: a profile resolves to a policy block, and the
block is judged like any other. The only difference is what the report's stderr
naming shows when the registry is malformed.

## What fails loudly

A registry the run cannot trust stops the run with exit 3 rather than
answering from a default. The four conditions — unknown `base`, a `base`
cycle, an unknown selected name, a missing or unparseable registry — are named
in [reference/profiles.md](../reference/profiles.md), each with the exact
message. If `check` says nothing about a profile, there is no profile involved:
`profiles` absent means `boundaryConfig` is a filename, exactly as before.

## The editor

A workspace whose options name a `profiles` registry is refused at editor
startup, loudly, rather than diagnosed from a name read as a file. The language
server only ever reads a policy _file_, and a profile name is a selector — move
the policy into its own `.mjs`/`.json` file and drop the `profiles` option to
use it in an editor. That refusal is one of the editor's named limits in
[troubleshooting.md](troubleshooting.md).

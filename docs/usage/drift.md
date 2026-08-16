# `lattice drift`

Compare the observed architecture against the declared intended one.

```shell
lattice drift
lattice drift --format json
lattice drift --format json --output drift.json
```

`drift` reads the workspace's project graph — projects, their tags, and the
dependency edges between them, from whichever provider the workspace uses — and
compares it against an intended architecture the workspace declares in an
`architecture-intent.config.mjs` (or whatever the `intentConfig` option names) at
the workspace root. Every finding names the intent row and the observed fact
that violates it.

Drift is **descriptive**: it exits 0 when it completes, even with findings, the
same way `diff` does. The command that turns drift into a failing build is
`check`, which folds drift in by presence — see [Folding into `check`](#folding-into-check)
below.

## The intent file

The intent is a plain-ESM module that default-exports an object. The same three
sections any boundary law has — projects, dependencies, tags:

```js
// architecture-intent.config.mjs
export default {
  projects: {
    // A project that must exist, with the tags it must carry.
    required: [{ name: "core", tags: ["layer:domain"] }],
    // A project that must not exist.
    forbidden: [{ name: "legacy" }],
  },
  dependencies: {
    // When present, an exhaustive whitelist: no other project→project edge may exist.
    allowed: [{ source: "app", target: "core" }],
    // These edges must not exist.
    forbidden: [
      { source: "core", target: "app" },
      { source: "lattice", target: "lattice-vscode" },
    ],
  },
  tags: {
    // A project carrying the first tag must not depend on a project of the second.
    forbid: [{ from: "layer:adapter", to: "layer:domain" }],
  },
};
```

Each section is optional. An empty `{}` intent or an absent file both mean "no
intended architecture" — the difference between them is the file's presence: no
file, no drift check and no mention; a file, the intended architecture is real
and drift is judged against it.

### Shape rules

Every violation of the intent's **shape** is a loud error (exit 3), because a
malformed intent that silently matched nothing would be drift's own silent
direction:

- top-level keys must be exactly `projects`, `dependencies`, `tags` (a section
  may be omitted entirely);
- `projects.required[].name` a non-empty string; `tags` optional, an array of
  non-empty strings;
- `projects.forbidden[].name` a non-empty string;
- `dependencies.allowed[]` / `dependencies.forbidden[]`: `source` and `target`
  non-empty strings;
- `tags.forbid[]`: `from` and `to` non-empty strings, and `to !== from` (a tag
  depending on itself is a no-op an author should not phrase as a rule);
- `dependencies.allowed: []` (an explicit empty array) is rejected. Omitted
  means "no allowlist" (only forbidden rules fire); an explicit empty array is
  ambiguous between that and "exactly nothing may exist". Omit the section
  instead;
- unknown keys anywhere are rejected, naming the path, so a typo'd section
  (`dependencs`) is caught rather than silently ignored.

## The eight drift findings

Every finding carries a stable `messageId` and names the intent row it came
from. Edge identity is `(source, target)` only — a `static` and `dynamic` edge
between the same pair is one fact, deduplicated; `implicit` edges (from
Nx-defined implicit dependencies) are excluded entirely, and the report states
how many it set aside.

| messageId                | the intent says                  | and the tree does                    |
| ------------------------ | -------------------------------- | ------------------------------------ |
| `projectMissing`         | a required project exists        | it does not                          |
| `projectPresent`         | a forbidden project exists       | it does                              |
| `projectTagMissing`      | a project carries a tag          | it carries another                   |
| `dependencyForbidden`    | an edge must not exist           | it does                              |
| `dependencyNotAllowed`   | only these edges may exist       | a different edge exists              |
| `tagDependencyForbidden` | a `from`→`to` tag pair is banned | an edge crosses that pair            |
| `intentUnknownProject`   | an intent row names a project    | the architecture has no such project |
| `intentUnknownTag`       | a tag rule names a tag           | no project carries it                |

The last two are the "malformed intent" requirement made visible: an intent row
naming a project or tag that cannot exist can never be satisfied, and drift says
so — one `intentUnknownProject` per unknown project name, one `intentUnknownTag`
per dead `tags.forbid` row — rather than reporting "no drift" forever.

Absence is not a finding. A project present but not required is not drift; an
edge that is not forbidden, and not named by an `allowed` whitelist when none
exists, is not drift; an `allowed` edge that never appears is not drift
(`allowed` states the permitted set; only `forbidden` rows can actually
violate).

## Example output

```text
intent    a1b2c3d4… — 4 rows
observed  3 projects, 2 edges

⚠ 1 finding: dependencies the intent forbids exist
  core → app
1 drift finding (3 projects and 2 edges)
```

A clean run over the same intent prints `✔ no drift — the observed architecture
matches the intended one (3 projects and 2 edges)`. "No drift" is a claim about
a complete comparison, which is why drift refuses to run over incomplete
coverage (exit 3): every "project missing" would be ambiguous between "gone" and
"never seen".

## Folding into `check`

There is no `--drift` flag. When the workspace has an intent file at the
`intentConfig` name, `check` loads it and counts drift findings into its verdict
the same way it counts go.work drift: exit 1 on findings, exit 3 on a malformed
intent (a whole-file failure). A workspace without an intent file gets no drift
check and no mention of drift — `check` is byte-identical to before the feature.
Folding **by presence** rather than by flag is deliberate: an opt-in flag would
make a forgotten flag byte-identical to "no drift checked", which is the silent
direction.

Because the intent schema ships with the feature, no pre-existing workspace can
carry an intent file that an upgrade would suddenly judge — so presence-keying
breaks nothing it did not create.

This is what to put in CI:

```shell
lattice check
```

No extra step, no extra flag: place an intent file in the workspace and the
existing `check` step fails on drift. See [ci.md](ci.md) for the full pipeline.

## Exit codes

| code | meaning                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------- |
| 0    | The comparison completed (findings included — a description, not a verdict).                    |
| 2    | Usage error: positional arguments, unknown flag.                                                |
| 3    | No drift could be established: malformed or unreadable intent, or incomplete observed coverage. |

`check`, with an intent file present, adds: 1 when drift findings exist, 3 when
the intent cannot be read or validated.

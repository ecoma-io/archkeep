# `lattice provenance`

Describe where this run's facts came from, and which governance rows carry an
origin to attest them.

```shell
lattice provenance
lattice provenance --format json
lattice provenance --format json --output provenance.json
```

`provenance` takes no positional arguments and no `--config` flag — it reads
the workspace's own declared files: the tracked `architecture-intent.json` at
the workspace root, and the boundary config the workspace's options name (or an
inline policy object in `lattice.json`). It reads origins; it never writes
them.

## The report

Two answer surfaces, both deterministic (two runs over an unchanged tree
produce byte-identical output; no wall-clock time ever enters the report):

- **Repository provenance** — the git commit, remote, and dirty state of the
  tree this run judged. When git cannot answer (not a repository, or git not
  installed), the report prints `repo provenance unavailable` rather than
  pretending a commit — the same explicit `null` the JSON envelope already
  carries for `graph`/`diff`/`drift`/`history`.
- **Decision provenance** — every governance row in the declared intent and
  boundary config, in the same order the judge counts them, each marked
  attested or not. A row without an origin is flagged
  `no origin recorded — cannot attest`: a row whose decision nobody recorded is
  indistinguishable from a rule that appeared by editing the file directly.

```text
repo      abc1234 — git@example.com:acme/repo.git
rows      12 governance rows, 9 with an origin, 3 without
unattested (no origin recorded — cannot attest):
  depConstraints[0]
  forbidden[1]
  projects.required[0]
3 of them carry no decision behind the rule
```

When every row carries an origin, the last section is the single line
`✔ every governance row carries an origin — each names who decided on it and
with what tool`. An empty `unattested` list means exactly "every governance row
carries an origin", and nothing else.

## The JSON envelope

`--format json` wraps the same answer in the versioned envelope
([json-output.md](json-output.md)): `result.repo` and `result.established`
carry the git facts, and `result.rows` carries each row `{kind, attested,
origin}` in canonical order with `result.unattested` naming the rows that
cannot be attested and why. The `workspace.provenance` block carries the repo
facts inside the envelope the same way the other commands' envelopes do. Exit
code 0 is unchanged by the answer — provenance is descriptive.

## Exit codes

| code | meaning                                                         |
| ---- | --------------------------------------------------------------- |
| 0    | completed — every declared file was read and every row walked   |
| 2    | usage error — unknown flag, positional argument                 |
| 3    | no verdict — a declared file is malformed and could not be read |

A malformed intent file or boundary configuration throws the same loud refusal
`drift` makes: a row list built from a file it could not read would be a claim
about rows that do not exist. Neither state is ever reported as a quiet success.

## The concept

What an `origin` record is, why `on` is optional, and why provenance never
changes a verdict — [concepts/provenance.md](../concepts/provenance.md). The
shared governance block each row may carry is the row schema
[policy-schema.md](policy-schema.md) and
[architecture-intent.md](architecture-intent.md) document for their own row
tables.

# Report

The `report` command: one architecture governance document — how healthy the
architecture is, and **why**. It composes the surfaces the other commands
already own into a single page a maintainer or a stakeholder reads end to end.

It computes nothing of its own. Every number and every verdict comes from the
same function the owning command calls, so this document cannot disagree with
[health.md](health.md), [waivers](../concepts/waivers.md),
[fitness.md](fitness.md), [adr.md](adr.md) or
[provenance](../reference/provenance.md) about the same tree.

## What it runs

```bash
archkeep report                       # the whole document for this run
archkeep report .archkeep/history      # the same, with trends across snapshots
archkeep report --format json         # the versioned envelope
archkeep report --output GOVERNANCE.txt
```

The optional positional argument names the snapshot directory for trends — the
same directory `history` reads, and the same argument `health` takes.

## Flags

| flag       | argument       | default                  | meaning                                                         |
| ---------- | -------------- | ------------------------ | --------------------------------------------------------------- |
| `--format` | `text`\|`json` | `text`                   | Terminal report or the versioned JSON envelope.                 |
| `--output` | `<file>`       | stdout                   | Write the report to a file instead of stdout.                   |
| `--config` | `<file>`       | (from workspace options) | Read the boundary law from here instead of the configured file. |

**One law governs the whole document.** The policy is resolved once — the same
way `check` resolves it, so `--config` and a `profiles` registry behave
identically — and handed to every section. Two sections of this page can never
cite two different laws.

## What is in it

| section             | what it answers                                                                                                                     | who owns the numbers        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| provenance          | Which tree, which provider, which law, which commit — and which governed rows carry an `origin`                                     | `provenance`                |
| health              | The nine metrics, each with its verdict and the number it was decided over                                                          | `health`                    |
| governance surfaces | The waivers and permanent suppressions on the table, the declared fitness gates, and the recorded decisions each governed row cites | `waivers`, `fitness`, `adr` |
| trends              | The structural metrics across snapshots, when a snapshot directory was given                                                        | `history`                   |
| could not inspect   | Every piece of evidence this run could not establish, by name                                                                       | this command                |

Each governed row that carries a `decisionRef` is linked to the record it
cites, with that record's status; each declared fitness gate names the ADR(s)
that bind it. A citation that resolves to nothing is `unknown` — never a pass.

## The status contract

`report` is descriptive: **it never exits 1.** A live boundary violation and a
failing fitness gate are both printed, by name, over exit 0 — the commands that
own those verdicts own their exit codes
([exit-codes.md](../reference/exit-codes.md)).

What the status means is whether the document could be _established_:

- **exit 0** — every surface reached a verdict.
- **exit 3** — at least one did not, and the closing `could not inspect` block
  names every one with its reason: a metric measured over evidence the run
  could not read, a waiver surface it could not establish, a fitness gate it
  could not determine, an ADR registry it could not parse, or a `decisionRef`
  that resolves to nothing.
- **exit 2** — usage error (more than one positional argument).

Three things are deliberately _not_ held against the document, because each is
a stated fact rather than an uninspected one:

- a `not_applicable` surface — no boundary law, no declared fitness functions,
  no ADR registry. The workspace declared none, and "could not look" would be a
  false claim about a thing that does not exist;
- repo provenance git cannot establish — printed as
  `repo provenance unavailable`, the same no-origin claim `provenance` exits 0
  over;
- a governed row with no `origin` record — a documentation finding
  `provenance` reports over exit 0, reported here the same way.

An unresolved `decisionRef` is the opposite case, and it _is_ exit 3: a
citation naming nothing is a governance claim nobody can check.

This is **stricter than `check`**, on purpose. `check` resolves the citations
on both tables — the intent rows and the `depConstraints` rows — but only the
intent half fails its build; a dangling citation on a constraint row is
rendered without gating. That is a gate's call to make, and a documentation
citation is not a broken boundary. This document is the opposite instrument:
its whole subject is on whose authority each governed row stands, so it holds
both tables to the same standard. The two never disagree about the fact —
both name the same unresolved citation, through the same resolver — only about
whether it should fail your build.

## Reading the report

```text
architecture governance report — every surface reached a verdict

provenance
  root        /workspace
  provider    native (archkeep.json)
  policy      module-boundaries.config.mjs
  commit      1993fa7 (dirty)
  remote      https://example.invalid/tree
  rows        6 governed rows, 3 with no origin recorded
    unattested  depConstraints[0] type-package — no origin recorded, cannot attest

health
✔ report over complete coverage (1048 imports in 289 files across 2 projects)
  ok              projects  2
  ...

governance surfaces
  ok              waivers
    1 waiver (0 expired, 0 covering nothing), 0 permanent suppressions hiding 0 violations
    active    libs/alpha/** until 2027-01-01T00:00:00.000Z — covers 1 violation
      reason: scheduled for removal
  pass            fitness gates
    pass            cycle-free  bound by: 0001-layering
  ok              decisions
    1 record in docs/adr/
      0001-layering  (accepted)  binds cycle-free
    adr       depConstraints[0] * → 0001-layering (accepted)

could not inspect
  nothing — every surface in this report reached a verdict
```

A run that could not establish something leads with it instead:

```text
architecture governance report — NO VERDICT: 2 surfaces could not be inspected
...
could not inspect
  metric:violations: the boundary could not be fully inspected
  decisionRef:forbidden[0] a→b: "0009-missing" does not resolve — no matching ADR, rule, or fitness record
```

## Determinism

Two runs over an unchanged tree, an unchanged law and the same reference
instant produce byte-identical output, in text and in JSON. Rows keep their
declaration order or a plain byte sort; nothing here reads the locale or the
environment.

One fact is judged against the clock, as it is everywhere else in the tool: a
waiver's `active`/`expired` status, which is the same judgment `check` makes
against the deadline the workspace itself wrote. The millisecond countdown
(`remainingMs`) is deliberately **not** carried here — the `waivers` command
reports it, with its own disclosure.

## What it is not

It does not age the debt ledger. The debt surface here is the per-run one — the
boundary law's own deferred rows, as the `debt rows` metric — because the aged
ledger needs a snapshot directory and belongs to [debt.md](debt.md).

It writes nothing. Like every command that is not `check`, it reads.

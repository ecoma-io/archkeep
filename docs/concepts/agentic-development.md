# Agentic development

When an AI agent edits code, it can violate an architectural boundary as easily as
a human can — and faster. The question is not whether agents will cross boundaries,
but whether the architecture answers them before they do.

Lattice's answer is three questions, asked at three moments, each served by a
command that produces machine-readable output a model can consume without parsing
prose.

## The three questions

### Before the edit — "What is this project allowed to reach?"

`context` takes a project name and returns the constraint table as it applies to
that project's tags: which rows match, what each allows and bans, and any
`description` or `remediation` the constraint author wrote. An agent given a task
that touches `billing-core` reads the context first and knows that `scope:billing`
may reach `scope:shared` but not `scope:checkout` — before writing an import
that violates it.

```shell
lattice context billing-core --format json
```

### During planning — "What depends on this?"

`impact` takes a project name and lists every project that transitively depends on
it, separated into direct and transitive. When a boundary config is available,
each dependent is annotated with the constraint rows that govern its edge and
whether that edge violates them. An agent about to change `billing-core` sees that three services
depend on it, one of them across a scope boundary — and knows the change has
architectural weight.

```shell
lattice impact billing-core --format json
```

### After the change — "Why was this flagged?"

`explain` takes a `file:line:column` site and returns the full judgment: which
constraint row matched, which tags applied, whether it is a violation and why.
When a `check` run reports a violation, an agent reads the explanation rather than
guessing at the fix.

```shell
lattice explain libs/billing/main.go:10:5 --format json
```

A fourth question — "what boundary implications does this change carry?" — is
answered by `diff` when a boundary config is available, which computes rule impact
on the structural diff between two graph snapshots.

## Why machine-readable output matters

The `--format json` flag exists on every command because the consumer is not
always a terminal. A model reading structured output does not need to parse
`file:line:column` out of a paragraph, does not need to guess whether a ✔ means
"no violation" or "not checked", and does not need to handle an output format
that changed between versions. The JSON envelope is versioned — every field name
and `schemaVersion` are a public contract from this release on, documented in
[json-output.md](../reference/json-output.md).

A consumer that wants to script against the result — an agent, a CI gate, a
pre-commit hook — reads the structured output. A developer at a terminal reads
the text. Both carry the same verdict; only the rendering differs.

## The agent is a consumer, not an authority

[principles.md](../doctrine/principles.md) states this directly: the constraint
table is code in the workspace, reviewed like code, and anything that edits it
from outside the repository breaks the property that makes it trustworthy. An
agent that can read `context`, `impact` and `explain` is an informed consumer. An
agent that could modify the constraint table to make its own import pass would be
an authority — and that is a boundary the architecture must not grant.

The commands above are read-only. An agent cannot use them to change the rules,
only to understand them. That asymmetry is the design: the architecture tells the
agent what is allowed; the agent does not tell the architecture what to allow.

## What `context` and `impact` do not check

The per-edge verdicts in `context` and `impact` cover only the `depConstraints`
table — tag-based rules such as `onlyDependOnLibsWithTags` and
`notDependOnLibsWithTags`. Twelve other violation types, including npm-ban,
circular-dependency, lazy-load, and relative-import rules, require import-site
details (the `file:line:column` of the import statement) and are not evaluated
by these commands.

An edge with `violations: []` in `context` or `impact` means the edge is allowed
by the constraint table — it does **not** mean the edge is free of all boundary
violations. An agent that needs the complete verdict must run `check`. The JSON
envelopes for `context` and `impact` carry a `coverage.notes` entry stating this
distinction.

## Where this sits in the roadmap

The three questions and the read-only boundary above are the 1.x agent story —
**architecture planning facts for agents**, the deterministic half of
agent-facing governance. [roadmap.md](../doctrine/roadmap.md) owns the staged path and
lists it among the 1.x capabilities alongside the `arch-*` skills and the host
integrations. What 2.x adds — agent-assisted planning help, richer context,
approval gates, post-change verification that does more than re-run `check`, and
anything with a reasoning component — is direction, not a promise. The commands
and the consumer-not-authority line above are what ships today.

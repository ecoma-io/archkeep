# Evidence

A verdict without its evidence is a rumor. This is the model that makes the
governance capabilities speak one language: every judgment Lattice reaches can
be stated as a verdict in one four-state vocabulary, with the evidence each
state is required to carry, so a consumer can compare verdicts across runs,
feeds, and rules — and so a verdict that cannot be backed is never emitted at
all.

## One vocabulary for every judgment

The envelope's `status` has always been a three-way verdict about one run:
`ok`, `findings`, `no-verdict`. The evidence model keeps that trichotomy
intact and names it in a vocabulary an evidencing process can compare:

| `status`       | verdict   | the evidence it requires                      |
| -------------- | --------- | --------------------------------------------- |
| `"ok"`         | `pass`    | complete coverage                             |
| `"findings"`   | `fail`    | at least one finding in `result`              |
| `"no-verdict"` | `unknown` | a `reason` naming what could not be looked at |

A fourth state, `not_applicable`, belongs to the vocabulary but not to engine
behavior today: it is the verdict for a rule that a capability decides does not
apply — Fitness functions and Waivers, which ask "does this rule govern this
tree at all" — and it must always carry `notApplicableReason`, because "did not
apply" and "did not run" are indistinguishable without it.

## The cardinal rule: unknown is never a degraded pass

The invariant everything is judged against is that an empty result means "no
violation", and nothing else. In verdict terms that becomes I5: an analysis
that failed, or a rule that could not determine, must emit `unknown` — **never
`pass`**. `pass` is the loudest claim the vocabulary makes and the hardest to
disprove; every other state exists to refuse it. The enforcers are executable:
`buildDecision` throws on a `pass` with incomplete coverage, a `fail` with no
findings, or an `unknown` with no reason rather than emit a hollow verdict.

## Determinism is the default

Evidence is meant to be diffed across runs, so the envelope it rides is
byte-deterministic over an unchanged tree. Time is the one value that would
break that, so the model resolves the tension by making

`sampleTime` **opt-in only**: a command that measures age or count — waivers,
debt, health — passes a timestamp explicitly, taking it from the shared
reference clock, while a command whose verdict must stay reproducible emits a
decision with no time at all. The clock is injectable, so a test drives the
same code with a fixed time and never asserts from the wall clock.

## What this is not

Evidence does not reason. It does not decide whether a finding _is_ one — the
analysis layer determines that. It decides whether the verdict and its evidence
agree, and refuses loudly when they do not. That is why the implementation
lives at the reporting boundary rather than in the rule engine: it is the
contract a command's counts are held to before they become a public claim.

See [reference/evidence.md](../reference/evidence.md) for the full vocabulary,
the five invariants, and the exact `decision` shape in the envelope.

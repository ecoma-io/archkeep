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

A fourth state, `not_applicable`, does not map onto a run-level `status` —
a run is never wholly inapplicable — but it is real engine behavior at the
level it belongs to, the individual declared gate. It is the verdict for a rule
a capability decides does not govern this tree: fitness functions and waivers,
which ask "does this rule apply at all", and custom rules, which reach it two
ways — a rule answering `not_applicable` itself (no project carries the tag it
constrains), and the engine answering it for every declared rule on a
path-scoped run, because a rule's evidence is the whole tree and a scoped run
read part of it ([custom-rules.md](custom-rules.md)).

It must always carry `notApplicableReason`, because "did not apply" and "did
not run" are indistinguishable without it, and it is **reported rather than
absorbed into a passing count**: a gate nobody is protected by should be
visible. It counts toward neither the findings lane nor the no-verdict one, so
it changes no exit code.

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

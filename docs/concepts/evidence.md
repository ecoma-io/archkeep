# Evidence

A verdict without its evidence is a rumor. This is the model that makes the
governance capabilities speak one language: every judgment Archkeep reaches can
be stated as a verdict in one four-state vocabulary, with the evidence each
state is required to carry, so a consumer can compare verdicts across runs,
feeds, and rules — and so a verdict that cannot be backed is never emitted at
all. The doctrine owns the words themselves:
[architecture-authority.md](../doctrine/architecture-authority.md) declares
verdict and evidence; this page owns the model that carries them.

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

## Terminology authority

These terms are owned here. Every other page that uses them should link to
this section rather than re-explain them. The JSON field names they define
are documented in [reference/json-output.md](../reference/json-output.md);
this section owns the meaning.

| term                        | meaning                                                                                                                                                                         | envelope                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **population**              | The set of tracked files a run reads (`git ls-files`, minus coverage-exempt config).                                                                                            | The only files a verdict speaks about.                                                                                                      |
| **analyzed**                | Files in the population the analyzer produced a verdict for.                                                                                                                    | `coverage.analyzedFiles`.                                                                                                                   |
| **notAnalyzed**             | Files in the population the analyzer never reached a verdict about — unreadable, no analyzer, a config that would not load, a declared project edge that could not be resolved. | `coverage.notAnalyzed`. Non-empty is exactly what makes `coverage.complete` false. Never call ignored files "not analyzed".                 |
| **out of population**       | Files excluded from the population entirely.                                                                                                                                    | Not judged, not counted, not disclosed unless the kind below says so.                                                                       |
| **ignored**                 | Files git's ignore rules name. Out of population, silently — by decision, the same one that keeps `.gitignore` the single authority on what the tool reads.                     | No gap entry, no disclosure.                                                                                                                |
| **untracked** (not ignored) | Project-owned files present in the worktree that git does not track and no ignore rule names.                                                                                   | Disclosed via a `coverageGaps` entry of kind `"untracked-files"`, with advice to `git add`.                                                 |
| **coverageGaps**            | Coverage the run knows it did not provide, each entry carrying a `kind`.                                                                                                        | No kind changes `complete`, `status`, or the exit code — a gap is coverage sitting outside the verdict, not a file the run failed to reach. |

[architecture-authority.md](../doctrine/architecture-authority.md) owns the
intent/reality/evidence/verdict/prediction/proposal/judgment vocabulary;
[adr.md](adr.md) and [waivers.md](waivers.md) own decision and waiver terms.

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

## Four finding families, one verdict lane

The one vocabulary is fed by four families of judgment, and no single module
owns "what a finding _is_". Each family builds its own shape and message
wording, then all four fold into the one verdict lane as count keys into
`verdictFor` (`packages/archkeep/src/verdict.mjs`). There is no Finding
supertype, and deliberately: a canonical Finding object would give the four
surfaces a second way to disagree about a single finding. What binds them
instead is the relationship pin at `violationOf` (`src/rules/index.mjs`) — the
rules lane's canonical `Violation` record — and the documented normalization
seam, `src/commands/check.mjs`'s markdown-pairing fold, where `judgeEdge`'s
verdicts are reshaped into the exact record `violationOf` builds. A Finding
that grows judgment fields, lifecycle state, or surface-specific rendering
stays rejected at review.

The four families:

| family                   | constructor                                     |
| ------------------------ | ----------------------------------------------- |
| the rules lane           | `violationOf` — `src/rules/index.mjs`           |
| graph-edge constraint    | `judgeEdge` — `src/rules/edge-constraints.mjs`  |
| go.work drift            | `compareGoWork` — `src/go-work.mjs`             |
| tsconfig `paths` hygiene | `judgeTsconfigPaths` — `src/tsconfig-paths.mjs` |

Each stays its own family's shape; there is no fold that converts one into
another. That is what makes the "no Finding supertype" claim a load-bearing
fact about the engine, not a naming choice.

## Register R1 — two models of "did we see everything"

`EVALUATION_STATUS` (`src/commands/completeness.mjs`) and the coverage-refusal
contract `coverageVerdict` (`src/commands/coverage-verdict.mjs`) are two
unrelated vocabularies that share the word "complete", and they must not be
conflated. The evaluation statuses grade how completely the _composed
evaluation_ satisfied the gates; the refusal contract decides whether the run
saw enough input to make any claim at all (its `no-verdict` / exit 3 on a
findings-free incomplete run). Neither is derived from the other, and the two
are kept in separate registers on purpose — they answer different questions
that only collide textually.

## What this is not

Evidence does not reason. It does not decide whether a finding _is_ one — the
analysis layer determines that. It decides whether the verdict and its evidence
agree, and refuses loudly when they do not. That is why the implementation
lives at the reporting boundary rather than in the rule engine: it is the
contract a command's counts are held to before they become a public claim.

See [reference/evidence.md](../reference/evidence.md) for the full vocabulary,
the five invariants, and the exact `decision` shape in the envelope.

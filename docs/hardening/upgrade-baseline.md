# Upgrade baseline — 2026-09

The measured state the hardening program started from. Everything the program
later claims about performance, reliability or coverage is judged against these
rows, so each row is tied to the command that produced it — a baseline whose
numbers cannot be re-taken is a diary, not a baseline. The findings the same
audit produced are registered in the companion
[hardening ledger](hardening-ledger.md).

## Baseline identity

| what            | value                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| package version | `0.27.1`                                                                                                                                       |
| commit          | `933f6a96`, the head of `origin/main` at the time                                                                                              |
| branches        | the program's implementation branches were cut from this commit, so a diff between any of them and these rows is the program's whole footprint |

## Toolchain

| tool | measured                                                    |
| ---- | ----------------------------------------------------------- |
| Node | `v24.16.0`                                                  |
| pnpm | `12.3.4`, via Corepack from the root `packageManager` field |
| Moon | `2.5.4`                                                     |

These are the versions the baseline checkout resolved to on the day, not the
floors the repository declares — the floors and why they differ are
[verification](../development/verification.md)'s.

## How the rows were taken

- **One checkout, one pass, all serial.** Every command below ran in the same
  tree, one after another, nothing in parallel — so the wall times are
  comparable row to row, and no row carries another run's cache state.
- **A wrong-checkout capture is not evidence.** An earlier pass of these same
  commands ran in the Loom workspace rather than this repository. Those outputs
  are recorded as invalid and appear nowhere on this page or in the
  [ledger](hardening-ledger.md); the rows below are the only measured record.

## Gate outcomes

| gate                     | command                                  | result                      |
| ------------------------ | ---------------------------------------- | --------------------------- |
| formatting               | `pnpm format:check`                      | pass                        |
| lint, every project      | `pnpm lint`                              | pass                        |
| typecheck, every project | `pnpm typecheck`                         | pass                        |
| project roster           | `pnpm check-packages`                    | pass — every listed project |
| doc links                | `node scripts/check-docs-links.mjs`      | pass                        |
| CLI roster               | `node scripts/check-cli-docs-roster.mjs` | pass                        |

## Engine suite and coverage

One `moon run archkeep:test` run produced both halves: **224 test files,
6016 tests, passing, in 129.16 s**, with coverage

| axis       | measured | floor (`coverage.config.json`) |
| ---------- | -------- | ------------------------------ |
| statements | `95.15%` | 80                             |
| branches   | `87.45%` | 80                             |
| functions  | `97.53%` | 80                             |
| lines      | `95.75%` | 80                             |

The floor column is a floor, not a target — the config says so itself — and it
is printed beside the measurement so a future "still above the floor" claim can
be read against the same page the old measurement lives on.

## E2E

`pnpm e2e` — the packed artifact driven as an installed CLI — which CI splits
into two shards:

| shard | test files | tests | duration   |
| ----- | ---------- | ----- | ---------- |
| 1     | 68         | 620   | `210.63 s` |
| 2     | 68         | 552   | `217.33 s` |

## The boundary law on itself

The packed CLI's `check` over this repository, with the tracked self-check
config `.github/native-selfcheck/archkeep.json`:

- **exit 0 — 628/628 files analyzed, 0 boundary violations**
- and, in the same run's report: 4 unowned TypeScript files, the
  unsupported-language gap, and 93 unresolved external/unsupported imports

The second bullet is on this page deliberately. Those are the checker's
observed-and-not-judged classes: nothing in them is a violation, which is why
the run exits 0, and reading a green run as proof the model is complete is
exactly the silent direction the [ledger](hardening-ledger.md) exists to name.

## History benchmark

`node packages/archkeep/e2e/bench/history-bench.mjs` — medians over 20 reps;
the fixture grows projects and edges per snapshot while the snapshot sequence
stays pinned at 8:

| projects / edges per snapshot | identity/op | history/op   |
| ----------------------------- | ----------- | ------------ |
| 10 / 20                       | `0.120 ms`  | `0.473 ms`   |
| 100 / 300                     | `1.564 ms`  | `5.998 ms`   |
| 500 / 2000                    | `13.385 ms` | `29.717 ms`  |
| 2000 / 10000                  | `45.549 ms` | `162.064 ms` |

The reading that matters is the per-element cost staying flat as the fixture
grows — the signature of a linear, Map-based implementation rather than an
accidental quadratic one. What the rows deliberately do not cover, a widening
snapshot sequence, is registered as the ledger's F5 rather than rounded over.

## CLI check wall time

`time` around the same packed CLI's `check` over this repository:

- wall `6.198 s` — user `7.48 s`, system `0.73 s`

Recorded as printed, not normalized: user time exceeding wall is what a
multi-core parse looks like from outside, and the row's job is to be comparable
to the next row taken the same way.

## Readiness — the 1.0 conditions

`pnpm readiness` read **0 met / 1 not met / 3 unmeasured**:

| condition                                                            | reading    |
| -------------------------------------------------------------------- | ---------- |
| a quiet stretch in what an unchanged workspace is told               | not met    |
| the real-tree differential green, run after run                      | unmeasured |
| a workspace outside this repository running check as a blocking gate | unmeasured |
| releases that land without a hand on them                            | unmeasured |

`unmeasured` is its own state, not a pass wearing a shrug: the report names
what would measure each row, and the reason two of them are structurally in
that state — run history lives in GitHub Actions, an external workspace is
somebody else's tree — is the readiness script's own. The conditions belong to
[the roadmap](../doctrine/roadmap.md); this page only records the reading taken
on the baseline day.

## Re-taking the baseline

The re-take is the same order, all serial:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm check-packages
node scripts/check-docs-links.mjs
node scripts/check-cli-docs-roster.mjs
moon run archkeep:test
pnpm e2e
pnpm readiness
node packages/archkeep/e2e/bench/history-bench.mjs
```

Plus the two measurements that need a packed artifact: the CLI's `check` over
this repository — exit code, analyzed-file count, violations, and the
observed-and-not-judged classes — and its wall time under `time`.

A new baseline is a new dated page in this directory, never an edit of this
one. A baseline whose history can be silently rewritten measures nothing.

Next: [hardening-ledger.md](hardening-ledger.md) — what the audit found
against these rows.

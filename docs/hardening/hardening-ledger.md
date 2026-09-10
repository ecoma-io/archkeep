# Hardening ledger

The findings register of the 2026-09 hardening audit, taken against the
[2026-09 baseline](upgrade-baseline.md) — `0.27.1`, commit `933f6a96`. A row
states what was observed, where, and what was decided about it, and nothing
else. Two dispositions exist: **fix here** (a linked pull request) and
**deferred** (its own issue — the repository's bar refuses a drive-by fix
riding an unrelated change). Anything that was never shown reachable is
recorded as a **probe**, not a finding, and a probe takes no disposition.

Evidence line numbers cite the tree the audit read — the baseline commit — so
they are load-bearing only until the change that moves them lands; the linked
issue or pull request, not the line number, is the part that stays true.

## Findings

| id  | finding                                                                                                                                                                                                                                                      | evidence (at `933f6a96`)                                                                                         | disposition                                    | status                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `recordOrigin` reads the clock twice: the value `clockViolations` validates is not the value emitted as `origin.on`, so a stateful clock can validate one value and ship another                                                                             | `packages/archkeep/src/governance/provenance-record.mjs:155-168`                                                 | fix here                                       | fix on [#883](https://github.com/ecoma-io/archkeep/pull/883) — reported in [#882](https://github.com/ecoma-io/archkeep/issues/882) |
| F2  | a causal chain's `endNode` is emitted as `decision:decision:<id>` against node ids of `decision:<id>` — a dangling reference in the public JSON graph                                                                                                        | `packages/archkeep/src/governance/provenance-graph.mjs`                                                          | fix here                                       | fix on [#883](https://github.com/ecoma-io/archkeep/pull/883) — [#882](https://github.com/ecoma-io/archkeep/issues/882)             |
| F3  | causal-chain BFS overwrites a queued node's first parent when a second supersession path reaches it: a diamond lineage loses a hop from `hops` while `edges` keeps both relations                                                                            | `packages/archkeep/src/governance/provenance-graph.mjs:408-416`                                                  | fix here                                       | fix on [#883](https://github.com/ecoma-io/archkeep/pull/883) — [#882](https://github.com/ecoma-io/archkeep/issues/882)             |
| F4  | `buildProvenanceGraph` accepted a `fileAttribution` parameter its implementation ignored while its JSDoc claimed pass-through — a contract describing an input that has no effect                                                                            | `packages/archkeep/src/governance/provenance-graph.mjs`                                                          | fix here — contract cleanup, parameter removed | fix on [#883](https://github.com/ecoma-io/archkeep/pull/883) — [#882](https://github.com/ecoma-io/archkeep/issues/882)             |
| F5  | history sequence-width widening: the direction the history benchmark does not scale — the bench grows projects and edges per snapshot while the snapshot sequence stays pinned at 8 — flagged as an unproven direction for the `history` command's hot paths | `packages/archkeep/e2e/bench/history-bench.mjs`                                                                  | deferred                                       | issue pending — the repro belongs to that issue, not to this row                                                                   |
| F6  | `historyOutputRefusal` decides with exact `dirname === dir` string equality, so a symlinked alias of the history directory escapes the poisoning guard                                                                                                       | `packages/archkeep/src/commands/history.mjs:798-816`                                                             | deferred                                       | issue pending                                                                                                                      |
| F7  | provenance binding edges are built at O(decisions × bindings × rows), and provenance has no benchmark — the existing bench covers identity and evolution only                                                                                                | `packages/archkeep/src/governance/provenance-graph.mjs:343-351`, `packages/archkeep/e2e/bench/history-bench.mjs` | deferred                                       | issue pending — extends the existing bench rather than adding a harness                                                            |
| F8  | `computeImpact` is less defensive than its sibling traversal — a dead `Object.hasOwn` check and no `?? []` guard on `deps` values — so what a malformed dependency graph does is unknown                                                                     | the `impact` traversal                                                                                           | probe                                          | unverified — no provider path reaching it with malformed input was shown; it becomes a finding the moment one is                   |

Status wording, read strictly: F1–F4's fixes exist on pull request #883, which
was still open when this page was written — this page does not claim "fixed",
because a ledger that records a merge that has not happened is worse than no
ledger. A row's status moves when the thing it points at moves — a merge, a
filed issue, a new measurement — never because the row was reworded.

## Linkage

- [#882](https://github.com/ecoma-io/archkeep/issues/882) owns F1–F4: the
  provenance record and causal-chain graph integrity findings, fix carried by
  one pull request because they share the two modules and one test file.
- [#844](https://github.com/ecoma-io/archkeep/issues/844) is the program
  umbrella for the named silent-failure classes. It decides where a class is
  tracked, never whether a finding exists — each row above carries its own
  disposition regardless of the umbrella.
- Deferred rows follow the umbrella's one-issue-one-pull-request rule; no
  deferred finding is folded into another row's change, and no unrelated
  cleanup rides a finding's fix.

## Not evidence

- **Outputs captured from the wrong checkout are not evidence.** An earlier
  pass of the baseline commands ran in the Loom workspace rather than this
  repository; those outputs are invalid and appear in neither this ledger nor
  [the baseline](upgrade-baseline.md). Every number this program cites comes
  from the baseline page's recorded pass.
- **A probe is not a finding.** F8 stays a probe until a reachability
  demonstration exists; a defensive-coding change made before that
  demonstration would be optimizing by guesswork, which is the one direction
  this program's performance and robustness rows refuse.

## Maintenance

New findings append with the next id. Ids are never reused, renumbered, or
quietly re-scoped — a finding whose description no longer matches its evidence
is a new row, not an edit. When a fix lands, its row gains the merged
reference and keeps its finding text as first written: a register that tidies
its findings after the fact is rewriting what the audit saw.

Next: [upgrade-baseline.md](upgrade-baseline.md) — the measured rows these
findings were read against.

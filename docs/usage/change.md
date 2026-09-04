# Change intent

A change intent is a machine-readable declaration of the material
architectural consequences one specific change expects to produce, and the
`change` command reconciles that declaration against the architectural delta
that actually happened. The question it answers is narrow on purpose:

> Did this change do exactly what it declared, architecturally — nothing
> more, and nothing less?

It is a review-compression tool. Instead of reading every changed file to ask
"what did this do to the architecture?", a reviewer reads one small verdict:
what was declared, what matched, what appeared without a declaration, and
which declared changes never happened.

## What it is

A JSON manifest at any path you like (`change-intent.json` is conventional;
there is no auto-discovery — the `--intent` flag names it):

```json
{
  "version": "1",
  "base": { "commit": "e8a9578d4c0b..." },
  "summary": "Add payments capability",
  "projects": {
    "add": ["payments"],
    "remove": []
  },
  "edges": {
    "add": [{ "from": "api", "to": "payments" }],
    "remove": []
  },
  "constraints": {
    "noNewViolations": true,
    "noNewCycles": true
  }
}
```

- **`base.commit`** pins the architecture the declaration was written
  against — the commit the baseline evidence snapshot was captured at. It is
  required: without a base pin there is nothing to verify the comparison
  against, and a run that cannot verify the pin answers `unproven` rather
  than guessing.
- **`projects` / `edges`** declare the material facts this change expects to
  appear or disappear. Edges match on `(from, to)` alone — whether the graph
  spells the dependency `static` or `dynamic` is the model's business, not
  the author's promise. A pair the graph carries under several types
  reconciles as the one declared dependency; whether that dependency is
  _abused_ (a lazy-load channel opened where only static use was promised) is
  exactly what `noNewViolations`, [`delta`](delta.md) and `check` judge —
  this command decides whether the dependency was declared, not how it is
  used. Absent sections mean "this change declares no such material
  consequence", which is a real expectation the run enforces, not an absence
  of one.
- **`constraints`** are the delta-level properties the change asserts:
  `noNewViolations` (no boundary violation was introduced that the waiver
  table does not already accept) and `noNewCycles` (no project sits on a
  dependency cycle that was acyclic at the base). A constraint not declared
  is not judged; `true` is the only meaningful value.
- **`summary`** is informational. It is never parsed, never matched on, and
  has no effect on any verdict — except through the breadth guard below,
  which reads its PRESENCE: a summary on an intent that declares no rows is
  refused loudly, because prose cannot assert what rows must state.
- **The breadth guard.** An intent that declares NO rows — no `projects`, no
  `edges`, and no `constraints` — while carrying a `summary` is refused
  outright (exit 3, before any reconciliation): its prose asserts a change
  the empty declaration states nothing about, and that pair is the one way
  around the grammar's reject-by-name discipline. Prose cannot assert what
  rows must state. Declare the material consequences in the rows, or drop
  the summary; an intent that declares a constraint (or any project/edge
  row) is not a catch-all, whatever its summary says.

## What it is not

- **Not workspace law.** `architecture-intent.json` declares the
  architecture the team preserves forever; a change intent declares what ONE
  transaction expects to do to it. The two grammars live side by side and
  neither subsumes the other.
- **Not a replacement for `check`.** A change can be policy-compliant but
  undeclared, policy-invalid but intent-matched, both, or neither — see
  [Policy interaction](#policy-interaction).
- **Not an AI plan, a task tracker, or a source diff.** There is no
  inference anywhere in it: the manifest says what it says, the engine
  compares what it compared.

## The workflow

```shell
# 1. At the base: capture the architecture evidence snapshot.
archkeep delta --capture --output .archkeep/change-base.json

# 2. Write the manifest, pinning the commit the snapshot recorded.
#    (.archkeep/change-base.json's provenance.commit IS that commit.)

# 3. Make the change — by hand, or let an agent edit.

# 4. Verify: reconcile the declaration against what actually changed.
archkeep change .archkeep/change-base.json --intent change-intent.json

#    Optionally record the run as a canonical evolution event (audit trail;
#    idempotent — a rerun over the same transition writes nothing new).
archkeep change .archkeep/change-base.json --intent change-intent.json \
  --event-out .archkeep/events
```

## Events and classification

Every `change` result carries the evolution classification in its JSON
envelope: `result.classifications` (which evolution classes the transition
earned — `CHANGE`, `DRIFT`, `VIOLATION`, `REPAIR`, `DECISION_CHANGE`, each a
fact about the delta, never an inference), `result.affected` (the projects,
boundaries, constraints and decisions the transition touched, as identity
strings), and `result.debt` (the change's divergence from its declaration —
the findings it introduced, claimed as resolved only when the run observed a
repair, which a change run never does). The classification is computed from
the reconciliation output itself, never re-derived: [../concepts/evolution.md](../concepts/evolution.md)
owns the predicates' one home.

With `--event-out <dir>`, the same run additionally writes the canonical
reconcile EvolutionEvent (`kind: "reconcile"`, `source: "change"`) to the
append-only, idempotent store at `<dir>` — one file per run,
`<NNNN>-<id8>.json`, `recordedAt` excluded from the identity so a rerun over
the same `{base, head, declarationDigest}` produces the same event id and
writes nothing (`duplicate: true` in the report). The disposition maps the
verdict: matched with every declared constraint passing ⇒ `accepted`;
undeclared or unfulfilled, or a failed declared constraint ⇒ `rejected`;
unproven, or a constraint that could not be determined ⇒ `no-verdict`.
Absent the flag, no file is written and the run is byte-identical to a
pre-wave-3 one. The write refuses loudly (exit 3) when the head is
uncommitted or the tree is dirty — the event-identity precondition
[docs/concepts/evolution.md](../concepts/evolution.md) owns — because a
write from uncommitted evidence would alias distinct evidence states onto
one event id.

Exit codes follow the repository-wide contract: `0` when the reconciliation
is matched and every declared constraint passed, `1` when it found undeclared
material changes, unfulfilled declarations, or a failed constraint, `3` when
it could not prove the base identity or could not judge a declared
constraint. `--format json` wraps the same verdict in the versioned envelope
([../reference/json-output.md](../reference/json-output.md)).

## The four verdicts

| verdict       | meaning                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `matched`     | Every declared fact is observed, nothing material happened beyond it, constraints pass.                           |
| `undeclared`  | At least one observed material change no declaration covers.                                                      |
| `unfulfilled` | Nothing undeclared, but at least one declared change never happened.                                              |
| `unproven`    | The base identity could not be established, so no comparison can be attached to the architectures the author saw. |

Two of these deserve their own paragraphs.

**`undeclared` is a review signal, not a governance failure.** An undeclared
edge may be perfectly legal under the workspace's boundary law — it is
simply something the change did not promise. The verdict asks a human (or
agent) to look and then decide: update the code, or update the declaration,
or accept and document the surprise. That decision is never made
automatically; there is no command that rewrites the manifest from observed
reality, because an auto-updated intent would make the guard trivially
bypassable.

**`unfulfilled` is proven divergence, not a failure to look.** A declared
edge that never appeared means the change did not accomplish its own plan —
perhaps deliberately (the dependency turned out to be unnecessary). The tool
reports it; the decision-maker reconciles it. When unexpected and unfulfilled
items coexist, the verdict reads `undeclared` (the surprise is the reviewer's
first question) and both lists are always present in full — precedence hides
nothing.

What counts as _material_ is exactly what [`diff`](diff.md) has always
reported: projects added, removed, or metadata-changed, and project-to-project
edges added or removed. Renamed variables, moved helpers inside one project,
formatting, comments, and test-only edits produce none of these, so they are
not architecture and this command does not pretend they are.

## Policy interaction

The two axes are independent and both stay visible:

```text
Workspace law:   2 live violations under the current law — informational;
                 archkeep check remains the authoritative verdict
Change intent:   UNDECLARED
```

- Policy-clean but undeclared: legal architecture nobody promised.
- Policy-violating but matched: exactly the promised change — which itself
  introduced a violation (declare `noNewViolations: true` if that should
  gate here too), or the tree was already violating before this change.
- Both at once: both signals render; neither hides the other.
- Neither: matched and clean.

`check` remains the only authority on whether the law holds. The `change`
envelope carries `result.policy.liveViolations` as evidence — computed with
the same engine over the whole tree — and its report says so in as many
words.

## Constraints

Constraints judge BOTH sides under ONE current law — the same arrangement
[`delta`](delta.md) uses, so a policy edit between capture and verify cannot
fabricate a pass or a fail. A failed declared constraint makes the run exit 1
alongside undeclared/unfulfilled findings; a constraint that cannot be
determined (an unclassifiable delta item behind `noNewViolations`) exits 3.
Constraint rows appear in the output only for constraints actually declared.

## For agents

The manifest is written by whoever plans the change — including a coding
agent — and the loop is mechanical:

```text
propose change-intent.json  →  edit code  →  archkeep change …
    ↑                                            |
    └── update the manifest, or fix the code ←───┘
```

Every outcome is structured: `matched`, the `unexpected[]` items, the
`missingExpected[]` items, per-constraint verdicts, and `unproven` with its
reasons. An agent consumes them without parsing prose and decides the next
step itself. Archkeep stays the deterministic observer — it never generates
intent, never edits the manifest, and never reasons about what the change
"meant".

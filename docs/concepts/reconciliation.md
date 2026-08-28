# Reconciliation

Drift tells you that reality disagrees with the declared intent. Reconciliation
tells you the shape of the disagreement — element by element, which side of the
contract each project, edge, tag, boundary, and intent row is on — and, when
asked, what editing the model would take to make the two agree. It is the
inverse comparison to drift, run over the same two sides.

## The same two sides, the other question

Both commands read the tracked [`architecture-intent.json`](../reference/architecture-intent.md)
and the observed project graph. Drift asks: _which intended rows does reality
violate?_ Reconcile asks: _what does the model say about reality?_ That second
question is what makes reconcile useful where drift is not:

- Drift reports the forbidden boundary row that is being built. Reconcile
  scores every observed project and edge against the model, so a project the
  declared model never mentions is a `+` next to its name — visible, rather
  than silent until a rule happens to fire.
- Drift is a list of findings; reconcile is a coverage map of the contract. An
  intent row whose statement is satisfied is scored `match`; one the
  architecture does not build is scored `absent`. The reader sees the whole
  contract scored, not just the broken rows.

## Read-only, and why that is the point

Reconciliation is **read-only by design**. It reports divergence and it
**proposes** repair paths — an add-only, removal, tag-change, or
boundary-change candidate — each marked `proposed: true` and
`notAuthoritative`, and it never applies one. The feature has no write-back
path: `architecture-intent.json` stays byte-identical after every run, which is
a property the integration test asserts. Authority over the model stays with
the intentional human or agent; the tool's job is to make the gap and the
options concrete, not to decide the architecture.

That separation is the same line this tool draws everywhere else: `diff`
describes changes and `check` judges them; `history` records evolution and
never edits a snapshot. A proposal is a suggestion anchored in a scored fact,
and the ranking exists so an operator can choose — the ranked order is
evidence of severity, not a decision the tool made.

## Divergence, never silence

The empty-result invariant applies here with its full force. An empty
divergence list must mean "the observed architecture matches the intended
model", and nothing else. So the command refuses loudly — exit 3 — on every
path that cannot reach a verdict: a tree with whole-file analysis failures
(every `absent` score would be ambiguous between "gone" and "never seen"), an
intent that will not parse, an Nx workspace whose plugin is not registered, or
a boundary/row side that matched no observed project (a score over an
unresolved row would claim a verdict the judge never reached). An `unknown`
score is marked as such whenever it exists — never silently read as a match.

## The scored contract

Reconcile scores five planes:

- **projects** — each observed project against the declared project model:
  required-and-present is `match`, required-but-forbidden or outside the model
  is `unexpected`, and a required project the architecture does not build is
  `absent` on the intent-row plane.
- **edges** — each observed code dependency: forbidden by name or by tag rule
  is `unexpected`, outside an explicit `dependencies.allowed` allowlist is
  `unexpected`, and ungoverned is `match`.
- **tags** — required tags a project does not carry.
- **boundaries** — boundary membership, judged by resolved membership: a
  boundary whose members exist is `match`, one whose selectors match nothing is
  refused earlier.
- **intent rows** — every row of the intent file, in file order, scored
  `match`, `absent`, or `unexpected`, each carrying the `intentRow` index an
  operator would edit.

Deterministic: identical inputs produce byte-identical output. Every element
and candidate is keyed and sorted by plain string comparison — never
`localeCompare`.

## Where this sits in the roadmap

Reconciliation is the deterministic, descriptive half of the governance wave: a
pure function of `(intent, observed)` that names the gap and proposes the
repair options. The proposal list is deliberately not an automated fixer —
auto-applying model edits is where authority would leak out of the intentional
loop. What the intelligence layer adds on top — recommendation beyond ranked
candidates — is later maturity on the same roadmap, not a promise; the
read-only, scored contract is what ships today.

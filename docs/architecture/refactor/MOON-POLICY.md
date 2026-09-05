# Moon provider policy (the Phase 1-C adjudication)

The per-item adjudication of AUTHORITY-MAP
[divergence 1](AUTHORITY-MAP.md#known-divergences-and-pressures) — the five
discovery policies embedded in the Moon provider's `transformMoonGraph`
(`packages/archkeep/src/providers/moon.mjs:606-822`) — recorded 2026-09-05
under [Phase 1-C](MIGRATION-PLAN.md#phase-1-c--provider-policy-adjudication-moon)
of the refactor program ([#725](https://github.com/ecoma-io/archkeep/issues/725)).
This page closes the INV-9 gap column's "policy adjudication" half
([INVARIANTS.md](INVARIANTS.md#inv-9--providers-observe-never-decide)); the
import-direction scan (G-1) that closes the other half is Phase 3's. Nothing
under `packages/` moved to produce it: the deliverable is the decision
record, plus the two ADRs items 4 and 5 required. The provider-seam table
Phase 1-D writes in [BOUNDARIES.md](BOUNDARIES.md#provider-seam) consumes
these verdicts; this page does not write that table.

## The test each item was put to

[CON-10](CONSTITUTION.md#con-10--providers-observe-they-do-not-decide) is the
law: providers acquire and normalize observations; no provider constructs a
verdict or a policy judgment. The test it imposes on each transformation is
one question — **does it decide semantics or reshape representation?**
Deciding semantics is choosing what a finding means, which edges exist _as
boundaries_, or what the law sees; reshaping representation is carrying the
same fact into the spelling the engine reads. Each of the five items below
answers that question against the code as it stands, and lands in exactly one
of the three classes the migration plan names:

- **(a) Contract-backed normalization** — the transformation is _forced_ by a
  contract the engine already owns (a vocabulary's meaning, the governed
  graph's domain): the provider had no alternative that preserves meaning,
  so there is no decision to record beyond the contract sentence itself.
- **(b) Explicit documented provider policy** — the transformation is
  _discretionary_: the engine's contracts would be satisfied by the provider
  doing less, and the choice of bridge it builds instead deserves an
  immutable record. These land as numbered ADRs.
- **(c) Rejected/removed candidate** — the transformation _decides
  semantics_ and must go; the removal itself is later-phase code work.

## Verdicts

| #   | Transformation                     | Site(s) in `moon.mjs`                                                                     | Verdict | Record                                                          |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------- |
| 1   | Edge filtering (root-scoped)       | `edgeTypeFromScope`'s `root` arm; both edge loops' `type === undefined` skip              | (a)     | contract below                                                  |
| 2   | Vocabulary inversion (#262)        | `edgeTypeFromScope`'s `source === "explicit"` arm; the node loop's `implicitDependencies` | (a)     | contract below                                                  |
| 3   | Scope collapse (to `static`, #280) | `edgeTypeFromScope`'s scope arms                                                          | (a)     | contract below                                                  |
| 4   | Tag synthesis (`layer:`/`stack:`)  | `deriveTags`                                                                              | (b)     | [ADR 0009](../../adr/0009-moon-derived-tags-provider-policy.md) |
| 5   | Workspace-layout inference         | `inferWorkspaceLayout`                                                                    | (b)     | [ADR 0010](../../adr/0010-moon-workspace-layout-inference.md)   |

All five are implemented once, in `moon.mjs`, and consumed by both faces —
the CLI's preamble and the language server's index both go through
`moonProvider.readProjectGraph`, so no adjudicated behavior has a second
implementation to diverge (#223).

## 1 — Edge filtering (root-scoped edges): (a), contract-backed

**What it does today.** `edgeTypeFromScope` returns `undefined` for
`scope === "root"`, and both edge-building loops skip such an edge
(`if (type === undefined) continue`). A root-scoped Moon dependency is one
whose depending principal is the workspace root itself. The check runs
before the `source` check, so a _hand-declared_ root dependency is skipped
identically — pinned as "still skips a root-scoped edge even when it is
hand-declared".

**The law it serves.** Reshaping representation. The governed graph's
subject is project-to-project edges — "an edge connects two projects"
([`docs/concepts/graph.md`](../../concepts/graph.md#what-an-edge-is)) — and
`evaluate()` judges edges between project nodes. The workspace root is not a
project: it has no node, no tags, and no constraint row can name it, so a
root-scoped edge is out of the governed domain, not an unjudged member of
it. Excluding it is the provider conforming its output to the domain the
engine declared, the same way it conforms to the `{nodes, dependencies}`
shape.

**The contract sentence** (for 1-D's table and Phase 3's G-1 framing):

> The governed graph is project-to-project edges. A Moon dependency scoped
> `root` names the workspace root itself as the depending principal — not a
> project, no node, unreachable by any constraint row — so it is outside the
> governed domain and is excluded before judgment: never judged, never
> refused. The exclusion is checked before `source`, so it applies to
> hand-declared root dependencies identically. Widening the domain to a root
> principal is a semantic change requiring its own decision.

**Pinned by** `packages/archkeep/src/providers/moon.test.mjs`:
"skips root-scope edges"; "still skips a root-scope edge whose endpoint
names nothing — it judges nothing"; "still skips a root-scoped dependency
naming an absent project — it judges nothing"; "still skips a root-scoped
edge even when it is hand-declared". The skip has no silent-direction
exposure of its own — the twins pin that an out-of-domain edge cannot pull
an anomaly refusal down around it (an endpoint naming nothing under `root`
scope stays a skip, not a refusal).

**Why not (b) or (c).** Not (c): no boundary is decided — the workspace
root is structurally unjudgeable, so nothing was judged. Not (b): no
discretion exists to record — the alternatives are inventing a root node
(semantic expansion, refused by
[ADR 0007](../../adr/0007-no-semantic-model-expansion.md)) or refusing
nearly every Moon workspace for carrying root dependencies Moon itself
emits. The one sentence worth recording is the domain exclusion, and it
belongs to the contract, not to a policy record.

## 2 — Vocabulary inversion, Moon `implicit` ↔ Archkeep `implicit` (#262): (a), contract-backed

**What it does today.** Two sites, one fact. In `edgeTypeFromScope`,
`source === "explicit"` returns edge type `"implicit"`; in the node loop,
`implicitDependencies` is built from exactly the dependencies whose
`source === "explicit"`. Moon's word "explicit" (a human wrote the
dependency in `moon.yml`) carries Archkeep's word "implicit"'s fact (Nx's
`implicitDependencies`: declared by a human, no import behind it); Moon's
word "implicit" (derived from source files) carries the opposite fact and is
typed from its scope. The `edgesByPair` map keys on the `(source, target)`
pair with "implicit wins", so a hand-declared dependency that appears in
both of Moon's own representations collapses to one `implicit` edge, never a
phantom `static` duplicate.

**The law it serves.** Pure adapter translation — the AUTHORITY-MAP's own
definition of the word: an adapter "may reshape representation, never
meaning". Mapping the two vocabularies **by their spelling** — which this
function once did — inverted the meaning (#262, fixed in PR #272, verified
against `@moonrepo/cli` 2.4.6's own shipped schema): every manifest-derived
edge was judged as though a human hand-declared it, and every hand-declared
edge — the only kind with no import site — was skipped, so a workspace with
a forbidden `dependsOn` and no import to hide behind reported clean and
exited 0. The silent direction, reached through a vocabulary collision. The
fix maps by the fact each word names; the meaning of `"implicit"` is the
engine's (it decides which edges `declaredEdgeViolationsForCheck` judges and
which `drift`/`discover` exclude), so the provider had no latitude at all.

**The contract sentence:**

> Moon's `source: "explicit"` (a human wrote the dependency in `moon.yml`;
> no import behind it) and Archkeep's edge type `"implicit"` (Nx's
> `implicitDependencies`: declared by a human, no import site) are one fact
> in two vocabularies. The provider translates by the fact each word names,
> never by its spelling: Moon `explicit` → Archkeep `implicit`; Moon
> `implicit` (Moon derived it from source files) → typed from its scope,
> never `implicit`. The consumers that partition on
> `type === "implicit"` — `declaredEdgeViolationsForCheck`, and the
> `drift`/`discover` exclusions — therefore see exactly the hand-declared
> set.

**Pinned by** the describe "`transformMoonGraph` — Moon \`explicit\` is
Archkeep \`implicit\`" (both `implicitDependencies` directions, both
edge-typing directions, the scope-only `raw.graph.edges` shape, the
both-loops collapse, and item 1's hand-declared root-scope skip, which rides
in the same describe), each asserting the FACT an edge carries rather than
the word Moon used. The consumer-facing statement of the mapping is
[`docs/integrations/moon.md`](../../integrations/moon.md#declared-dependencies-and-moons-source)'s
table; the declared-edge violation contract it feeds is
[`docs/reference/violations.md`](../../reference/violations.md)'s.

**Why not (b) or (c).** Not (c) — the inversion preserves meaning; its
pre-#262 spelling-mapped ancestor was the violation, and it is already gone.
Not (b) — there is no discretionary choice to record: the two vocabularies'
meanings are fixed on both sides of the seam, and the only translation that
preserves meaning is the one implemented. An ADR restating it would record
the absence of a decision.

## 3 — Scope collapse, every scope to `static` (#280): (a), contract-backed

**What it does today.** `edgeTypeFromScope` maps `production`,
`development`, `build`, `peer`, and any unknown scope all to `"static"`,
never `"dynamic"`. Genuine lazy-loading still reaches the graph —
`mergeImportEdges` folds real `import()` sites onto it keyed
`[source, target, type]`, so a dynamic import of a statically declared
dependency survives as its own edge.

**The law it serves.** Reshaping representation, forced by the type
vocabulary's meaning. The edge type "comes from the import's form in the
source file" — `static` "a compile-time dependency", `dynamic` "a run-time-only
dependency (`import()`, `require` of a lazy-loaded library)" — and "a manifest
says a dependency _may_ be used; it never says a boundary _was_ crossed …
analysis records carry the import's form where one exists, which is where the
`static`/`dynamic` split above is read"
([`docs/concepts/graph.md`](../../concepts/graph.md#what-an-edge-is)). A
Moon scope is a manifest fact — _when_ the dependency is needed — and a
manifest fact cannot attest source text. The pre-#280 mapping fed
`development` to `"dynamic"` and manufactured lazy-loading nobody wrote:
every dev-only dependency looked lazy-loaded and
`noImportsOfLazyLoadedLibraries` fired at the declaring project's own test
file. The collapse is not a choice the provider made; it is what the type
vocabulary's meaning leaves a scope-derived edge permission to be. The
production/development distinction is genuinely lost, and the loss is
correct: the type vocabulary has no slot for it, and adding one is semantic
expansion
([ADR 0007](../../adr/0007-no-semantic-model-expansion.md)).

**The contract sentence:**

> An edge's `type` states how the importing code is written — a
> source-text fact only analysis can attest (`static`: a compile-time
> dependency; `dynamic`: `import()` or a lazy `require` at a real import
> site). A Moon scope states when a dependency is needed — a manifest fact.
> No scope can therefore produce `dynamic`: every scope-derived edge is
> `static` (`production`, `development`, `build`, `peer`, unknown alike),
> and a genuine lazy-load reaches the graph only through analysis —
> `mergeImportEdges` folding real `import()` sites, keyed
> `[source, target, type]` so a dynamic edge of a statically declared
> dependency survives as its own record.

**Pinned by** the "edge type from scope" describe — per-scope `static`
mappings including "maps development to static — a scope never manufactures
a source-text fact (#280)" and "maps an unknown edge scope to static, never
silently dropping it" — plus the `mergeImportEdges` describe whose headline
is the surviving twin: "a real dynamic import survives alongside a
development-scoped declared edge". The silent direction here was loud
falsehood (findings that were not real); its twin is the red test that
keeps scope out of the typing decision.

**Why not (b) or (c).** Not (c): collapsing is meaning-preserving given the
type vocabulary; the removed `dynamic` mapping was the violation. Not (b):
as with item 2, the vocabulary decides — the provider implements the only
collapse the contract permits, and the consumer-facing statement already
lives in
[`docs/integrations/moon.md`](../../integrations/moon.md#dependency-scopes)'s
scope table.

## 4 — Tag synthesis (`layer:`/`stack:`): (b), ADR 0009

**What it does today.** `deriveTags` merges a project's declared `tags`
(carried verbatim) with `layer:<value>` synthesized from the Moon `layer`
field and `stack:<value>` from the `stack` field, deduplicated and sorted.

**The law it serves.** Observation, not judgment — it states Moon's own
classification in the tag spelling the constraint table reads, and the law
stays the workspace's. But unlike items 1–3 it is **discretionary**: the
engine's contracts would be satisfied by carrying `layer`/`stack` as inert
node metadata; the provider chose to bridge Moon's structured classification
into the tag vocabulary (colon-form, because Moon's own tag validation
rejects colons and the constraint-table convention uses them). A
discretionary contribution of law-_inputs_ — tags are what constraint rows
match — is exactly the shape that must not survive as an unrecorded code
comment.

**The record**:
[ADR 0009](../../adr/0009-moon-derived-tags-provider-policy.md) — the
synthesis stays as recorded provider policy, bounded by three decisions
(derive only what Moon states; declared tags verbatim, never rewritten;
decide nothing with the result). Its refused alternatives include the
rejected-candidate class (removal would silently vanish every constraint
row matching a derived tag — the forbidden direction, a named minor under
the compatibility contract, with no defect motivating it).

**Pinned by** the "tag derivation" describe (merge, dedupe, omission when a
field is null, absent `config.tags`); the consumer-facing statement is
[`docs/integrations/moon.md`](../../integrations/moon.md#tag-format)'s.

## 5 — Workspace-layout inference: (b), ADR 0010

**What it does today.** `inferWorkspaceLayout` derives `appsDir`/`libsDir`
from the accepted projects' canonical roots crossed with Moon's `layer`
values (`application` roots → `appsDir`, `library` roots → `libsDir`):
common top-level segment per axis, both axes or neither, a root-level
project contributing to neither, and `null` when incomplete so the engine's
own `DEFAULT_WORKSPACE_LAYOUT` applies at the judging site.

**The law it serves.** The furthest of the five from a translation: Moon
states no layout fact, so the provider **derives** one, and the derivation
feeds enforcement-shaping input (`isAbsoluteImportIntoAnotherProject` reads
the layout). It stays on the observation side of CON-10 — it reads only
what Moon's graph states, publishes through the same `workspaceLayout` key
every provider uses, and judges nothing — but the engine's contracts would
be satisfied by always withholding, so the choice to infer is policy, and
policy with enforcement consequences is what ADRs are for.

**The record**:
[ADR 0010](../../adr/0010-moon-workspace-layout-inference.md) — inference
stays, bounded by four decisions (derive only from Moon-stated facts;
complete-or-withheld, mirroring the engine's own partial-declaration
refusal; root projects contribute to neither axis; the provider never
supplies the default). It also names a recorded-not-fixed cost: the `graph`
snapshot's `workspaceLayoutSource` has only `"declared"`/`"default"`, so an
inferred Moon layout is reported through the `"declared"` slot and a
consumer cannot distinguish inferred from declared.

**Pinned by** the "workspaceLayout inference" describe (both-or-neither
twins in each direction, root-project exclusion for both layers, the
no-`.`-as-directory property over every normalizable root spelling, no
projects, deep nesting) plus "reads workspaceLayout from the canonical
root, not Moon's spelling"; the consumer-facing statement is
[`docs/integrations/moon.md`](../../integrations/moon.md#what-this-integration-does-not-do)'s.

## No rejected candidates

None of the five is a (c). The class-level finding this adjudication closes
divergence 1 with: **the Moon provider embeds no judgment** — three of its
five policies are normalizations forced by contracts the engine owns, and
the other two are discretionary observations recorded as immutable policy,
each bounded to stating Moon's own facts and deciding nothing. What made
the five read as "a policy surface" when Phase 0 mapped them together was
not any one verdict-shape inside them; it was that none of the five carried
a record saying which class it was in. That is the gap this page closes.
The residual, stated honestly: two provider-owned discretions remain
(items 4 and 5), and Phase 7's seam collapse consumes them as recorded
policy, never as silent behavior.

## Boundary of this adjudication

The finding named five transformations; this record adjudicates exactly
those five. Two neighbours were named so the boundary would be explicit
rather than discovered later — one since adjudicated by the 2-A record
([PD-13](DECISIONS.md#program-decisions)), one standing as recorded
loudness behavior:

- **`nodeTypeFromLayer`** (Moon `layer` → node type `app`/`e2e`/`lib`) is
  the same translation class as item 4 — a Moon-stated classification
  projected into a coarser engine vocabulary the rules read. The 2-A
  record ([PD-13](DECISIONS.md#program-decisions)) adjudicated it from
  that analogy: recorded policy (b), its unknown-layer `lib` fallback
  (`moon.mjs:352-361`) stated in
  [BOUNDARIES.md](BOUNDARIES.md)'s verdict ledger. It is not a sixth
  verdict.
- **`canonicalMoonRoot` and the anomaly refusals** (the collect-and-throw
  posture and the root-spelling discipline, cited in `moon.mjs` as #365/#367)
  are loudness behavior at the acquisition boundary, already recorded by their
  own fixes and their own tests; they were never part of the divergence-1
  finding.

## What Phase 1-D consumes

Each row below is self-contained — contract sentence or ADR — so the
provider-seam table can cite this page and the two ADRs without re-deriving
anything:

The last two rows joined by the 2-A record
([PD-13](DECISIONS.md#program-decisions)); same self-containment contract.

| Transformation                    | Normalization contract (a) or policy record (b)                                                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root-scoped edge exclusion        | (a) The governed graph is project-to-project edges; a `root`-scoped dependency names the workspace-root principal, outside the domain — excluded before judgment, never judged, never refused; the check precedes `source` |
| Vocabulary inversion              | (a) Moon `source: "explicit"` ≡ Archkeep type `"implicit"` (one fact, two vocabularies); translate by fact, never spelling; `type === "implicit"` consumers see exactly the hand-declared set (#262)                       |
| Scope collapse                    | (a) Edge `type` is a source-text fact only analysis attests; a scope is a manifest fact; every scope → `static`, `dynamic` only via `mergeImportEdges` (#280)                                                              |
| Tag synthesis                     | (b) [ADR 0009](../../adr/0009-moon-derived-tags-provider-policy.md): derive only Moon-stated `layer`/`stack`, colon-form; declared tags verbatim; decides nothing                                                          |
| Workspace-layout inference        | (b) [ADR 0010](../../adr/0010-moon-workspace-layout-inference.md): infer only from Moon-stated roots × layer; complete-or-withheld; root projects contribute nothing; never supplies the default                           |
| `moon:declared` targets synthesis | (b) Targets declared in Moon manifests are synthesized at the provider boundary (`moon.mjs:717-737`); twin parity with `archkeep:declared`; decides nothing beyond Moon's own statements                                   |
| `nodeTypeFromLayer`               | (b) Moon `layer` → node type, the same translation class as item 4; the unknown-layer `lib` fallback is stated, not derived; decides nothing                                                                               |

The suite that pins the original five is
`packages/archkeep/src/providers/moon.test.mjs`; the two 2-A rows record
existing behavior, and whether either needs its own pin is 2-B's
relationship-pin work, not this record's. This unit added no behavior pin
because none was missing — every adjudicated
behavior already has its pin, verified green in this unit's validation run
(see the PR's validation report). The one test this unit touches is not a
behavior pin: the ADR registry's backward-compatibility roster lists every
record the registry scans, and ADRs 0009/0010 join that list — a roster pin
moving with its roster, nothing more. A future pin gap in any of the five is
a defect against this record, not a documentation choice.

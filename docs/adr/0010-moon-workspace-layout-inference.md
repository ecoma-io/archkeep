---
id: 0010-moon-workspace-layout-inference
status: accepted
---

# The Moon provider infers `workspaceLayout` from project roots, complete or withheld — recorded provider policy

## Context

The absolute-import rules read the workspace layout — `appsDir`/`libsDir` —
to decide when a specifier reaches across a project boundary
(`packages/archkeep/src/rules/specifiers.mjs`'s
`isAbsoluteImportIntoAnotherProject`). An Nx workspace declares that layout
in `nx.json`'s `workspaceLayout`, and a partial declaration is refused
loudly rather than half-defaulted, because half a layout silently disables
the rule for the missing axis. A Moon workspace has no channel for the fact
at all: Moon's own configuration carries no `appsDir`/`libsDir` key, Moon has
no plugin-options table the way `nx.json` does, and an `archkeep.json`
beside a Moon marker is refused — one project model per tree. Either the
provider derives a layout from what Moon does state, or every Moon workspace
is judged against the engine default `{libsDir: "libs", appsDir: "apps"}`.

`inferWorkspaceLayout` in `packages/archkeep/src/providers/moon.mjs` derives
one: each accepted project's canonical root, crossed with Moon's own `layer`
classification — `application`-layer roots sharing a top-level directory
give `appsDir`, `library`-layer roots give `libsDir`; a root-level project
contributes to neither; a layout is stated only when both axes infer,
otherwise none is. The architecture refactor's provider audit recorded the
inference among the five policies embedded in `transformMoonGraph` awaiting
adjudication. This record is the adjudication's outcome for this item,
2026-09-05.

## Decision

The inference stays, as **recorded provider policy**, with its discipline
stated as part of the decision:

1. A stated layout is derived **only from facts Moon's own output states** —
   canonical project roots crossed with Moon's `layer` values. No directory
   is invented: each stated value is the observed common top-level segment
   of that layer's project roots, and a layer with no consistent segment
   states nothing.
2. **Complete or withheld.** A layout is stated only when both axes infer;
   a partial one is never emitted. This mirrors, at the observation
   boundary, the completeness law the engine already owns for declarations
   — the measured failure mode of a partial layout is one axis of the
   absolute-import rule silently disabled, the prefix
   `${workspaceLayout.libsDir}/` evaluating as `"undefined/"`.
3. **A root-level project contributes to neither axis.** Its canonical root
   is `""`, which names no directory below the workspace root, and a layout
   of `"."` would make `isAbsoluteImportIntoAnotherProject` test
   `startsWith("./")`: every ordinary relative import in the workspace
   reported as an absolute import into another project.
4. **The provider never supplies the default.** Withholding is its only
   fallback; which default applies when no layout is stated is the rule
   layer's fact (`DEFAULT_WORKSPACE_LAYOUT`, applied at the judging site by
   `graph.workspaceLayout ?? DEFAULT_WORKSPACE_LAYOUT`).

## Rationale

Under the providers-observe law the test is whether a transformation decides
semantics or reshapes representation. This one is the furthest of the five
from a translation: Moon states no layout fact, so the provider _derives_
one, and a derivation that feeds enforcement-shaping inputs is discretion —
the engine's contracts would be satisfied by always withholding. That is
why it is recorded here rather than left as a code comment. It stays on the
observation side of the line because the derivation reads only what Moon's
own graph states, states its result through the same `workspaceLayout` key
every other provider uses, and judges nothing: the absolute-import rule
still decides, over a layout that is now the workspace's observed shape
instead of a default the workspace never matched.

## Refused alternatives

- **Always withhold; judge every Moon tree against the default.**
  Under-observation with an enforcement consequence: a workspace whose
  libraries live under `packages/` would have its `libsDir` read as `libs`,
  and the absolute-import rule would answer about a layout the workspace
  does not have.
- **Refuse the run when no layout can be inferred.** The loud refusal
  posture belongs to a _declared_ partial layout — a workspace that spoke
  and spoke incompletely. Nothing is declared here, so there is nothing
  incomplete to refuse, and most Moon workspaces would exit 3 with no
  defect named.
- **State partial layouts.** The measured silent-disable mechanism above;
  one axis of a rule quietly off is the forbidden direction wearing a
  helpful-looking shape.
- **Count a root-level project's `.` toward a prefix.** `appsDir: "."` is
  the every-relative-import-is-a-violation shape, pinned red in the tests.
- **A new declaration channel for Moon workspaces** (a layout key the
  provider would read). Moon has no options table to carry it and the
  options-by-convention story is owned by
  [`docs/integrations/moon.md`](../integrations/moon.md#configuration);
  adding a config door is a product decision outside this record.

## Consequences

The inference is observable — the absolute-import family behaves
differently on a Moon tree than a withhold-always provider would — so
changes to the heuristic are semantic changes under the compatibility
contract. One cost is recorded rather than fixed: the `graph` snapshot's
`workspaceLayoutSource` vocabulary has two values, `"declared"` and
`"default"`, computed from the key's presence, so an inferred Moon layout
is reported through the `"declared"` slot — a consumer cannot distinguish
_inferred from project roots_ from _named by the workspace_. Widening that
vocabulary would change an output-contract field and is its own
compatibility-classified change if the maintainer ever wants it; this
record only names the fact. The discipline is pinned where it is
implemented — `packages/archkeep/src/providers/moon.test.mjs`'s
workspaceLayout-inference describe (both-or-neither twins in each
direction, root-project exclusion for both layers, the no-`.`-as-directory
property over every normalizable root spelling, no projects, deep nesting)
— and both faces share the one implementation: the language server indexes
through the same `readProjectGraph` the CLI runs, so the editor and `check`
cannot disagree about the layout a Moon tree was judged against.

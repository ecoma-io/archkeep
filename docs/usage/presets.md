# Adopting a shipped policy pack

Archkeep publishes six architecture styles as ready-made law. Each one is a
**policy pack**: a profile registry, shipped inside the package, holding the
rows that make a style enforceable instead of aspirational.

A pack is data and nothing else. It is read by the same loader, validated by the
same validator and enforced by the same path as a registry you wrote yourself —
[profiles.md](../concepts/profiles.md) owns that model, and a pack introduces no
dialect, no option and no second kind of policy beside it. What a pack saves you
is the blank page, not a mechanism.

The six packs:

| pack                         | file                                | the style it encodes                                                          |
| ---------------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| Clean Architecture           | `presets/clean-architecture.json`   | The Dependency Rule: source dependencies point inward, never outward          |
| Hexagonal (ports & adapters) | `presets/hexagonal.json`            | A domain that knows no adapter, and adapters that do not know each other      |
| Traditional layering         | `presets/layered.json`              | Tiers stacked top to bottom, in a strict and a relaxed reading                |
| Layered modular monolith     | `presets/modular-monolith.json`     | Feature modules reached through their published surface, over a shared kernel |
| Vertical slices              | `presets/vertical-slice.json`       | Feature slices that own their whole stack and never couple to each other      |
| DDD bounded contexts         | `presets/ddd-bounded-contexts.json` | Contexts integrating through a published language, never through a model      |

Onion architecture is **not** a pack of its own, deliberately: its rings are
`clean-architecture`'s layers under different names, and shipping a second copy
of one law under a second vocabulary is two files to keep in step against no
check. Rename the four `layer:` values in your own copy.

## The tag vocabulary a pack expects

A pack's rows key on tags, so adopting one means tagging your projects the way
the pack reads. Six axes cover the six packs, all spelled `axis:value` — what a
tag means, and how a constraint row matches one, is
[boundaries.md](../concepts/boundaries.md)'s.

| axis       | meaning                                                                          | used by                            |
| ---------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| `layer:`   | Where the project sits in the architecture.                                      | every pack but `layered`           |
| `tier:`    | The same idea under the name traditional layering uses for it.                   | `layered`                          |
| `share:`   | Whether the project is part of its context's published surface or private to it. | `ddd-bounded-contexts-isolated`    |
| `module:`  | Which module a project belongs to.                                               | `modular-monolith-sealed-modules`  |
| `context:` | Which bounded context a project belongs to.                                      | `ddd-bounded-contexts-partitioned` |
| `feature:` | Which slice a project belongs to.                                                | `vertical-slice`                   |

Every project a pack judges needs a `layer:` (or `tier:`) tag it recognises.
That is not a formality: a project whose tags match no row in the table is
reported, not waved through — so a project you forget to tag fails loudly rather
than escaping the boundary in silence.

### Where a pack CAN name your modules, and where it still cannot

The bottom three axes — `module:`, `context:`, `feature:` — are the ones a pack
reads **relatively**, through a `tag-axis-isolation` fitness function rather
than through more constraint rows.
[fitness-functions.md](../concepts/fitness-functions.md) owns why a constraint
row cannot ask that question and what the condition does instead; what matters
here is the consequence for a pack: a profile keyed on one of those axes names
no module, context or feature of yours. It names the AXIS, and the values stay
yours.

What a pack still cannot ship is anything that depends on how your workspace is
laid out: which of your projects are one module, where a contract lives, which
target your build produces. The section on each pack below says exactly where
that line falls.

## Clean Architecture

Layers, innermost first: `layer:entities`, `layer:use-cases`,
`layer:interface-adapters`, `layer:frameworks`. Each layer may depend on itself
and on every layer inside it, and on nothing outside it.

| profile                        | what it adds                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `clean-architecture`           | The four layer rows.                                                                            |
| `clean-architecture-pure-core` | On top of them: entities and use cases may import no package from outside the workspace at all. |

## Hexagonal

`layer:domain` inside the hexagon, `layer:ports` for the interfaces it states,
`layer:adapters` for what plugs into them, `layer:app` for the composition root
that wires the two together.

The row worth reading twice is the adapter one: an adapter may depend on ports
and on the domain, but **not on another adapter**. Two adapters talking directly
have turned a driven side into a driving one, which is the shape the port
existed to prevent — and it is the case a layer-only reading of "hexagonal"
misses.

| profile                 | what it adds                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `hexagonal`             | The four layer rows, adapter isolation included.                                        |
| `hexagonal-pure-domain` | On top of them: the domain imports no third-party package — every capability is a port. |

## Traditional layering

`tier:presentation`, `tier:application`, `tier:domain`, `tier:infrastructure`,
top to bottom. The pack ships both readings of "layered", because which one a
team means is a decision and the two disagree about a real edge:

- **`layered-strict`** — a tier may reach its own tier and the one immediately
  below it. An edge that points downward but SKIPS a tier is a finding.
- **`layered-relaxed`** — a tier may reach its own and every tier beneath it, at
  any depth. Only an upward edge is a finding.

`presentation → domain` is the edge that separates them: `layered-strict`
reports it, `layered-relaxed` does not.

| profile           | what it encodes                                                                      |
| ----------------- | ------------------------------------------------------------------------------------ |
| `layered-strict`  | Each tier reaches its own and the tier immediately below it. A skipped tier reports. |
| `layered-relaxed` | Each tier reaches its own and everything beneath it. Only upward edges report.       |

Neither profile has a `base`: they are alternatives, not a chain, and selecting
one is choosing which reading your workspace holds itself to.

## Vertical slices

`layer:slice` for a feature slice that owns its whole stack, `layer:host` for
the composition root that assembles them, `layer:shared-kernel` for what every
slice is allowed to share — plus a `feature:` value on each slice saying which
one it is.

The rows say a slice may reach a slice and the kernel, and the host may reach
everything; they cannot say **which** slice, because every slice carries the
same `layer:slice` tag. The `slice-isolation` fitness function in the base
profile is the whole of feature isolation, reading `feature:` relative to the
source. The kernel and the host carry no `feature:` tag, so their edges are not
its subject; a slice that carries none is reported as unjudgeable.

| profile                        | what it adds                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `vertical-slice`               | The three layer rows, plus feature isolation across the `feature:` axis.                            |
| `vertical-slice-sealed-kernel` | On top of them: the shared kernel takes no third-party dependency, for the modular-monolith reason. |

## Layered modular monolith

`layer:app` for the deployable, `layer:module` for a feature module's published
surface, `layer:module-internal` for what the module keeps to itself, and
`layer:shared-kernel` for what every module is allowed to share.

The invariant this pack exists for: the app composes modules through their
published surfaces and cannot see a module's internals, and the kernel depends
on nothing that is not itself kernel.

**The four rows cannot enforce the word "its own", and this is the sharp edge of
the pack.** `layer:module-internal → layer:module-internal` is a row matching
itself, so one module's private implementation reaching ANOTHER module's is
permitted; so is a module's published surface reaching another module's
internals. Both are the thing the rows' own descriptions forbid, and neither is
expressible with tag values alone. `modular-monolith-sealed-modules` is the
profile that closes it: one `tag-axis-isolation` function reading the `module:`
axis relative to the source, which needs every project to carry a `module:` tag
and reports a matched project that carries none rather than waving it through.

| profile                           | what it adds                                                                                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modular-monolith`                | The four layer rows.                                                                                                                                                                                                                                                   |
| `modular-monolith-sealed-kernel`  | On top of them: the shared kernel takes no third-party dependency, so it can never force a version on every module at once.                                                                                                                                            |
| `modular-monolith-sealed-modules` | On top of the four rows: nothing reaches another module's internals, and a published surface may cross into another module only onto its `layer:module` surface. (An internals project cannot take that route — the base row already forbids it reaching any surface.) |

## DDD bounded contexts

`layer:domain` for the model, `layer:application` for the use cases,
`layer:infrastructure` for persistence, messaging and the anti-corruption layer,
and `layer:published-language` for the contracts other contexts are allowed to
couple to.

`ddd-bounded-contexts-isolated` adds the `share:` axis: tag each project
`share:private` or `share:published`, and nothing private becomes reachable from
anything else private. **That row assumes one project per bounded context.**
Where a context spans several projects, its own projects are private to each
other too, and the row reports imports inside a single context — a false
positive its one row cannot avoid, because `share:private → share:private` is
the only shape a tag list can name.

`ddd-bounded-contexts-partitioned` is the same intent without that assumption.
It reads the `context:` axis relative to the source, so a context may span as
many projects as it needs and only an edge that actually leaves its context is a
finding — with a `layer:published-language` contract as the one way across. It
needs no `share:` axis at all: it matches on the three layer tags the base
profile's own rows already key on, so it can never quietly select nothing. It
costs one more tag per project (`context:orders`), and a matched project
carrying none is reported as unjudgeable rather than waved through.

| profile                            | what it adds                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ddd-bounded-contexts`             | The four layer rows.                                                                                                                                                                                |
| `ddd-bounded-contexts-isolated`    | On top of them: no context reaches another's private projects. One project per context.                                                                                                             |
| `ddd-bounded-contexts-partitioned` | On top of them: no `layer:domain`/`application`/`infrastructure` project reaches another CONTEXT, except into its `layer:published-language`. Contexts of any size. Needs a `context:` tag on each. |

## Choosing a pack, and how far it goes

A derived profile inherits its base and adds to it. Because a child's rows
compose with its base's rather than replacing them
([profiles.md](../concepts/profiles.md) owns that precedence), the only
direction a `base` chain travels is **tighter**: a derived profile always
enforces everything its base does, and no `base` can express a loosening.
Relaxing a shipped row means editing your own copy of the file. `layered` is the
one pack whose two profiles are alternatives rather than a chain — neither
derives from the other, because strict and relaxed layering disagree rather than
stack.

What no pack turns on is as much a decision as what it does.
`enforceBuildableLibDependency` and `banTransitiveDependencies` are `false` in
every pack: neither states an architectural style, both depend on facts about
your build and your manifests that a shipped file cannot know, and a pack that
enabled them would report on trees whose only fault was not being the one it was
written against. Turn them on in your own copy, deliberately, and read
[policy-schema.md](../reference/policy-schema.md) for what each judges.

The "pure core", "pure domain" and "sealed kernel" profiles all state
`bannedExternalImports: ["*"]`, which bans Node's own built-in modules as well
as installed packages ([policy-schema.md](../reference/policy-schema.md)). That
is the intent — a pure core reaches the outside world through a port — but it is
the rule most likely to surprise on first run, so select those profiles second,
once the layer rows are green.

The profiles that ship a `tag-axis-isolation` function —
`modular-monolith-sealed-modules`, `ddd-bounded-contexts-partitioned`, and
`vertical-slice` (with `vertical-slice-sealed-kernel` inheriting it) — each need
one extra tag per project, on the axis they partition. Until every matched
project carries one, the function names those projects and `check` exits 3 with
nothing failed: the could-not-look class, not a failure. It names them in the
`fail` case too, appended to the crossings, so a run that has something to
report never quietly stops mentioning what it could not judge. Tag them, or
narrow the profile's `match` in your own copy so the function only claims over
the projects the axis actually describes.

## Using a pack

### Copy it in

The form to reach for, and the only one that lets you extend the pack:

```shell
cp node_modules/@ecoma-io/archkeep/presets/hexagonal.json archkeep-profiles.json
```

Then name your copy in the plugin options, and select a profile from it exactly
as [profiles.md](profiles.md) describes:

```json
{
  "plugins": [
    {
      "plugin": "@ecoma-io/archkeep/nx",
      "options": {
        "boundaryConfig": "hexagonal",
        "tsConfig": "tsconfig.base.json",
        "profiles": "archkeep-profiles.json"
      }
    }
  ]
}
```

Your copy is a registry like any other: add profiles to it, give them the
shipped one as their `base`, and add the per-context rows a pack cannot ship.
The law is now yours, and a Archkeep upgrade cannot change what your CI enforces.

### Point at it where it is installed

`profiles` takes a workspace-relative path, so it can name the file inside
`node_modules` directly:

```json
"options": {
  "boundaryConfig": "hexagonal",
  "profiles": "node_modules/@ecoma-io/archkeep/presets/hexagonal.json"
}
```

Nothing to copy, and no fork to maintain — at the cost that upgrading Archkeep
can change the law your pipeline enforces. Read the release notes before
upgrading, and see the stability note below.

### Workspaces without an `nx.json`

The `profiles` option lives in `nx.json`'s plugin options and only there
([configuration.md](../reference/configuration.md)), so a `archkeep.json`
workspace and a Moon workspace cannot select a profile by name. They can still
use a pack: a profile's `block` is exactly the four keys a `.json` boundary
config carries ([policies.md](../concepts/policies.md)), so copy the `block` of
the profile you want into your own `.json` boundary law and point
`boundaryConfig` at that file. A profile with a `base` has to be flattened by
hand first — merge the chain the way
[profiles.md](../concepts/profiles.md) specifies, base before child — because
nothing resolves it for you once the `block` has left the registry.

## Stability

**A change to a shipped pack's rows is a breaking change**, and is released as
one. A workspace that pointed its `profiles` option at a pack gets the new rows
on upgrade, and a row added to a pack turns a pipeline red on code nobody
touched — which is the definition this repository already applies to any change
in what is reported on an unchanged workspace.

The packs are versioned with the package; there is no separate pack version. A
workspace that copied a pack in is unaffected by any of this, which is the
second reason to prefer that form.

## Adding official rules beside a pack

A pack fills the constraint table through its profile's `depConstraints` rows.
What it cannot express — counts, combinations, conditions a tag list cannot
spell — is where the official generic rules live. A workspace selects a pack
AND declares official rules as its own `customRules` rows beside its own
`fitness` rows. The workspace's boundary config (`archkeep.json` or the file
`boundaryConfig` names) remains the single declaration surface.

Why this works, and why the rule belongs in the workspace: a `customRules` row
names a wasm artifact by workspace-relative path and hash, which does not travel
with a shareable profile. Profile blocks deliberately refuse `customRules` by
name (see `profile-registry.mjs`), so composition happens at the workspace level,
not in the pack. All three layers — preset constraints, official rules, and
fitness functions — merge through the existing policy resolution and reach the
verdict through the same enforcement run.

### Step one: copy the bytes

The official rules live in `@ecoma-io/archkeep-rules/rules/*.wasm`. Copy the
artifact you need into your workspace — the row pins a workspace-relative path
the workspace owns, and a registry update must never silently change what your
CI executes.

```shell
mkdir -p tools/rules
cp node_modules/@ecoma-io/archkeep-rules/rules/tag-cardinality.wasm tools/rules/
```

### Recipe: Vertical Slice + Tag Cardinality

What it enforces: every slice owns exactly one feature context.

```json
{
  "customRules": [
    {
      "name": "tag-cardinality",
      "artifact": "tools/rules/tag-cardinality.wasm",
      "sha256": "<copy from catalog.json — the entry and rules/tag-cardinality.wasm.sha256 agree>",
      "params": {
        "axis": "feature",
        "max": 1
      },
      "reason": "Every slice owns exactly one feature context. A slice carrying multiple feature: tags is either miscategorized or represents a boundary violation the constraint rows cannot see."
    }
  ]
}
```

**Why it belongs beside this pack:** The vertical-slice pack's own isolation rows
assume each project has ONE `feature:` value. A project with `feature:orders
feature:catalog` is ambiguous — which slice does it belong to? The constraint
rows cannot see that problem: both slices carry the same `layer:slice` tag, so
"exactly one feature: value per project" is not expressible as a `depConstraints`
row.

**What remains unproven:** The number `1` is policy, not proof. A different
architecture might allow `max: 2` for transitional slices.

### Recipe: Modular Monolith + Max Fan-In

What it enforces: a shared module may not be depended on by more distinct
projects than a declared budget.

```json
{
  "customRules": [
    {
      "name": "max-fan-in",
      "artifact": "tools/rules/max-fan-in.wasm",
      "sha256": "<copy from catalog.json — the entry and rules/max-fan-in.wasm.sha256 agree>",
      "params": {
        "max": 3
      },
      "reason": "A shared module with too many dependents becomes a de facto central hub, violating the modular-monolith principle that modules integrate through their published surfaces rather than through a shared core."
    }
  ]
}
```

**Why it belongs beside this pack:** The modular-monolith pack's sealed-modules
profile ensures modules don't reach each other's internals, but it does not limit
HOW MANY modules can depend on a shared module. A module with 20 dependents is a
coupling hotspot the pack's rows cannot see.

**What remains unproven:** The number `3` is policy, not proof. The right
threshold depends on your team size and domain complexity.

### What this does not prove

These recipes state the machine-checkable invariants this composition enforces.
They make no claim about "DDD-compliant" or pattern compliance — that language
belongs in architecture decision records, not in tool configuration. What the
tool guarantees is that the stated invariants hold: one feature per slice, or
a fan-in budget, or whatever rule you declared. Whether those invariants are
the right ones for your architecture is a decision for you, not a finding.

## What fails loudly

Nothing about a pack changes the four conditions a profile registry refuses on —
an unknown `base`, a `base` cycle, a name the registry does not carry, and a
registry that cannot be read. [profiles.md](../reference/profiles.md) names each
with its exact message. Two of them are worth knowing in a pack's own terms:

- Selecting a profile a pack does not carry — a name from another pack, or a
  typo — is exit 3, not a fallback to the base profile.
- Pointing `profiles` at a pack path that does not exist, which is what a
  renamed or removed `node_modules` produces, is exit 3 as well: the run could
  not read its law, and that never reads as a clean tree.

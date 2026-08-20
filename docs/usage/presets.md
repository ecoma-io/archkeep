# Adopting a shipped policy pack

Lattice publishes four architecture styles as ready-made law. Each one is a
**policy pack**: a profile registry, shipped inside the package, holding the
constraint rows that make a style enforceable instead of aspirational.

A pack is data and nothing else. It is read by the same loader, validated by the
same validator and enforced by the same path as a registry you wrote yourself —
[profiles.md](../concepts/profiles.md) owns that model, and a pack introduces no
dialect, no option and no second kind of policy beside it. What a pack saves you
is the blank page, not a mechanism.

The four packs:

| pack                         | file                                | the style it encodes                                                          |
| ---------------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| Clean Architecture           | `presets/clean-architecture.json`   | The Dependency Rule: source dependencies point inward, never outward          |
| Hexagonal (ports & adapters) | `presets/hexagonal.json`            | A domain that knows no adapter, and adapters that do not know each other      |
| Layered modular monolith     | `presets/modular-monolith.json`     | Feature modules reached through their published surface, over a shared kernel |
| DDD bounded contexts         | `presets/ddd-bounded-contexts.json` | Contexts integrating through a published language, never through a model      |

## The tag vocabulary a pack expects

A pack's rows key on tags, so adopting one means tagging your projects the way
the pack reads. Two axes cover all four packs, both spelled `axis:value` — what
a tag means, and how a constraint row matches one, is
[boundaries.md](../concepts/boundaries.md)'s.

| axis     | meaning                                                                          | used by                         |
| -------- | -------------------------------------------------------------------------------- | ------------------------------- |
| `layer:` | Where the project sits in the architecture. Every pack keys on this axis.        | all four packs                  |
| `share:` | Whether the project is part of its context's published surface or private to it. | `ddd-bounded-contexts-isolated` |

Every project a pack judges needs a `layer:` tag it recognises. That is not a
formality: a project whose tags match no row in the table is reported, not
waved through — so a project you forget to tag fails loudly rather than
escaping the boundary in silence.

A pack never names one of **your** contexts, modules or features. It cannot: a
constraint row matches tags, and there is no row that says "the same value of
`context:` as the source" — so per-context isolation is one row per context,
written by you, in your own copy. What a pack ships is the part that is true of
every workspace in that style; the section on each pack below says exactly where
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

## Layered modular monolith

`layer:app` for the deployable, `layer:module` for a feature module's published
surface, `layer:module-internal` for what the module keeps to itself, and
`layer:shared-kernel` for what every module is allowed to share.

The invariant this pack exists for: the app composes modules through their
published surfaces and cannot see a module's internals, and the kernel depends
on nothing that is not itself kernel.

| profile                          | what it adds                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `modular-monolith`               | The four layer rows.                                                                                                        |
| `modular-monolith-sealed-kernel` | On top of them: the shared kernel takes no third-party dependency, so it can never force a version on every module at once. |

## DDD bounded contexts

`layer:domain` for the model, `layer:application` for the use cases,
`layer:infrastructure` for persistence, messaging and the anti-corruption layer,
and `layer:published-language` for the contracts other contexts are allowed to
couple to.

`ddd-bounded-contexts-isolated` adds the `share:` axis: tag each project
`share:private` or `share:published`, and nothing private becomes reachable from
anything else private. **That row assumes one project per bounded context.**
Where a context spans several projects, its own projects are private to each
other too, and the row will report imports inside a single context — use the
base profile there and write per-context rows instead.

| profile                         | what it adds                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `ddd-bounded-contexts`          | The four layer rows.                                                                    |
| `ddd-bounded-contexts-isolated` | On top of them: no context reaches another's private projects. One project per context. |

## Choosing a pack, and how far it goes

Each pack's second profile inherits the first and adds rows to it. Because a
child's rows compose with its base's rather than replacing them
([profiles.md](../concepts/profiles.md) owns that precedence), the only
direction a `base` chain travels is **tighter**: the second profile of a pack
always enforces everything the first does, and no `base` can express a
loosening. Relaxing a shipped row means editing your own copy of the file.

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

## Using a pack

### Copy it in

The form to reach for, and the only one that lets you extend the pack:

```shell
cp node_modules/@ecoma-io/lattice/presets/hexagonal.json lattice-profiles.json
```

Then name your copy in the plugin options, and select a profile from it exactly
as [profiles.md](profiles.md) describes:

```json
{
  "plugins": [
    {
      "plugin": "@ecoma-io/lattice/nx",
      "options": {
        "boundaryConfig": "hexagonal",
        "tsConfig": "tsconfig.base.json",
        "profiles": "lattice-profiles.json"
      }
    }
  ]
}
```

Your copy is a registry like any other: add profiles to it, give them the
shipped one as their `base`, and add the per-context rows a pack cannot ship.
The law is now yours, and a Lattice upgrade cannot change what your CI enforces.

### Point at it where it is installed

`profiles` takes a workspace-relative path, so it can name the file inside
`node_modules` directly:

```json
"options": {
  "boundaryConfig": "hexagonal",
  "profiles": "node_modules/@ecoma-io/lattice/presets/hexagonal.json"
}
```

Nothing to copy, and no fork to maintain — at the cost that upgrading Lattice
can change the law your pipeline enforces. Read the release notes before
upgrading, and see the stability note below.

### Workspaces without an `nx.json`

The `profiles` option lives in `nx.json`'s plugin options and only there
([configuration.md](../reference/configuration.md)), so a `lattice.json`
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

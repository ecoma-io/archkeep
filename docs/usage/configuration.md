# Configuration

Every surface Lattice reads, and where each option lives.

Three providers, three config shapes, one engine. The engine reads the same
boundary law and produces the same verdicts either way; configuration decides
which provider runs and what filenames it reads.

## Which provider runs

A marker file at the workspace root decides:

| marker         | provider | project model from                          |
| -------------- | -------- | ------------------------------------------- |
| `nx.json`      | Nx       | Nx's project graph (`nx graph`)             |
| `.moon/`       | Moon     | Moon's project graph (`moon project-graph`) |
| `lattice.json` | native   | `lattice.json` + tracked tree               |

More than one marker present is a hard error (exit 3) — the engine refuses to
guess. Neither present exits 3 too, naming what it looked for.

The rest of this page covers the options each provider accepts. The boundary
law itself — `depConstraints`, `moduleBoundaryOptions`, `boundarySuppressions`
— is the same table regardless of provider; [policy-schema.md](../reference/policy-schema.md) is
its reference.

## Nx provider options

On an `nx.json` workspace, the options live in the plugin registration:

```jsonc
// nx.json
{
  "plugins": [
    {
      "plugin": "@ecoma-io/lattice/nx",
      "options": {
        "boundaryConfig": "module-boundaries.config.mjs",
        "tsConfig": "tsconfig.base.json",
      },
    },
  ],
}
```

| option           | default                        | meaning                                                                                               |
| ---------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `boundaryConfig` | `module-boundaries.config.mjs` | Path (workspace-relative) to the boundary law. Read by the CLI, the language server, and the Nx hook. |
| `tsConfig`       | `tsconfig.base.json`           | Path to the shared TypeScript config for import resolution.                                           |

Both default to the Nx convention. An unknown key **throws** rather than falling
back — a `tsconfigBase` typed for `tsConfig` that quietly used the default
would give you a full green run against a rule nobody wrote.

`--config` on the command line overrides `boundaryConfig` for one run.

## Moon provider options

A Moon workspace carries a `.moon/` directory at the root. Because Moon's
configuration does not provide a plugin-options table the way `nx.json`'s
`plugins[].options` does, the two options fall back to their defaults by
convention — `module-boundaries.config.mjs` and `tsconfig.base.json` at the
root. A Moon workspace must **not** create a `lattice.json` to name them: a
tree carrying both the `.moon/` marker and a root `lattice.json` is refused
loudly as a hard error (exit 3), never read as a config surface. See
[moon.md](../integrations/moon.md) for the integration guide.

| option           | default                        | meaning                                                                                 |
| ---------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| `boundaryConfig` | `module-boundaries.config.mjs` | Path (workspace-relative) to the boundary law. Read by the CLI and the language server. |
| `tsConfig`       | `tsconfig.base.json`           | Path to the shared TypeScript config for import resolution.                             |

Both default to the Moon convention. An unknown key **throws** — the same
guarantee the Nx provider makes.

`boundaryConfig` can also be an **inline object** — see the native provider
section below for the caveat about the inline form.

## Native provider options

On a `lattice.json` workspace, the same two options sit directly on the model
file — there is no `plugins[].options` table to nest them under. The full
`lattice.json` shape is at [configuration.md](../reference/configuration.md).

```jsonc
// lattice.json
{
  "boundaryConfig": "module-boundaries.config.mjs",
  "tsConfig": "tsconfig.base.json",
}
```

`boundaryConfig` can also be an **inline object** — the boundary law directly,
rather than a filename pointing at it. Its keys are the `.json` dialect's four —
`depConstraints`, `moduleBoundaryOptions`, `boundarySuppressions`, `fitness` —
validated by the same check a separate file goes through. The language server does not support the
inline form: it watches and re-reads a _file_, and an object embedded in
`lattice.json` does not change independently of the model.

## CLI flags

| flag       | commands that accept it                                                                                                                                            | meaning                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `--format` | `check`, `graph`, `diff`, `drift`, `discover`, `reconcile`, `waivers`, `fitness`, `history`, `health`, `debt`, `impact`, `explain`, `context`, `provenance`, `adr` | `text` (default), `sarif` (check only), or `json` (versioned envelope)           |
| `--output` | all commands                                                                                                                                                       | Write the report to a file instead of stdout                                     |
| `--config` | `check`, `diff`, `waivers`, `fitness`, `history`, `health`, `debt`, `impact`, `explain`, `context`                                                                 | Read the boundary law from this file instead of the workspace's `boundaryConfig` |

`--format sarif` is only available for `check`; every other command produces
`text` or `json` only. `diff` accepts `--config` because rule-impact analysis
depends on which boundary law is in effect. `history` accepts it because a
captured snapshot records the fingerprint of the law in effect. `waivers`,
`fitness`, `health` and `debt` accept it because the surface they describe is
the one the law in effect carries. `impact` accepts it for constraint context.
`explain` and `context` accept it because the judgment and the matching rows
both depend on which constraint table governs. `graph`, `discover`, `drift`,
`reconcile`, `provenance`, and `adr` take no `--config` because they describe
structure, provenance, or the decision registry — not any boundary law.

## What is not configurable

- **Which languages are checked.** There is no `languages` option. A workspace
  that switched a language off would produce a report byte-for-byte identical
  to one whose code in that language is clean — the silence this tool exists to
  end. A workspace already pays nothing for a language it does not have: every
  resolver keys off a manifest that is not there.
- **Project names or tag values.** Everything comes from the project graph
  and the config the workspace declares.
- **The exit codes.** 0 clean, 1 findings (check only), 2 usage error, 3 no
  verdict. See [ci.md](ci.md) for the full table.

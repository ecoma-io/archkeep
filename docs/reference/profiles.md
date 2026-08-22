# Named law profiles reference

The two files that make profile-selection work, and the exact failure each loud
condition knows about. The concept — why profiles exist, when to use them, the
inheritance semantics — is [profiles.md](../concepts/profiles.md); this page is
the schema and every loud condition.

## The `profiles` plugin option

| option     | type   | default | meaning                                                                                                             |
| ---------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `profiles` | string | absent  | Name of the profile registry file, workspace-relative. When present, `boundaryConfig`/`--config` is a profile NAME. |

When a workspace names a `profiles` option, the check command enforces by
profile name: it loads the registry, resolves the named profile to its
effective block, and runs that through the same `policyFrom` tail every
boundary-config dialect uses — one enforcement path, named. The value of
`--config` overrides `boundaryConfig` for one run the way it overrides a
filename; a one-run override that resolves a different law than the one in
effect is a review of that law, never a verification of the change, and a
report of it names the profile and says it is not the law in effect.

The language server does not read this option yet. A workspace whose
`nx.json` options name a `profiles` registry is refused loudly at `initialize`
rather than watching the profile NAME as though it were a policy file — the
server only ever watches and re-reads a policy _file_, and a name is a selector,
not a path. Move the policy into its own `.mjs`/`.json` file and remove the
`profiles` option to use it from an editor.

## The registry file

The file named by `profiles`, read with `JSON.parse` — never JSONC, never
`import()`. A registry whose entries are data earns the same strict reading as
a `.json` boundary law. The schema version the current reader enforces is `1`.

### Top-level keys

| key        | type   | required | meaning                                                                                                                                                                                                     |
| ---------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profiles` | array  | yes      | The named profiles, in declaration order.                                                                                                                                                                   |
| `version`  | number | no       | Registry schema version. Defaults to `1` when absent; a stated value other than `1` throws. The default is applied at the one place the version is read, so a reader can always tell which schema it holds. |
| `$schema`  | string | no       | Tolerated for editor validation; does nothing.                                                                                                                                                              |

Any other top-level key is rejected by name.

### A profile

| key     | type   | required | meaning                                                                                                      |
| ------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------ |
| `name`  | string | yes      | Letters, digits, `-` or `_` only. Unique across the registry. The value `boundaryConfig`/`--config` selects. |
| `base`  | string | no       | Non-empty. The name of another profile whose effective block this one inherits.                              |
| `block` | object | yes      | The policy block — `depConstraints`, `moduleBoundaryOptions`, `boundarySuppressions`, `fitness`.             |

Only those four keys are recognized on a profile; any other key — the
policy's own `customRules` included, which does not ride a profile — is
rejected by name. A profile with no `block` is rejected — it would otherwise parse as an
empty policy, which `policyFrom` refuses for its own reasons, but the registry
names it as a profile defect so the reader is looking at the right file.

### The `block`

Four of the five keys `findBoundaryConfigViolations` reads from a
boundaryConfig dialect ([policy-schema.md](policy-schema.md) owns the shape of
each; `customRules` is the one a profile refuses). `depConstraints` rows append after the base's; `moduleBoundaryOptions`
keys overwrite the base's key by key; `boundarySuppressions` and `fitness`
rows append.

## Resolution

`boundaryConfig`/`--config` names a profile. Resolution is depth-first through
the `base` chain, earlier profiles first. The resolved block is fed to
`policyFrom`, which validates the block with the same function a file
dialect uses and returns the shared policy shape. A resolved block that is
malformed throws the same "is malformed" message a malformed file would, naming
the profile as the source.

## The four loud conditions

| condition                                 | exit class | what is thrown                                                                    |
| ----------------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| Unknown `base`                            | 3          | no profile with that name exists — never read as "no base"                        |
| Cycle in a `base` chain                   | 3          | a cycle has no deterministic resolution                                           |
| Unknown selected name                     | 3          | no profile with that name exists — a policy that selects nothing enforces nothing |
| Missing/unreadable/JSON-bad registry file | 3          | the registry cannot be read, so no verdict reachable                              |

Each is a silent-direction guard: a registry the reader cannot trust must not
be read as smaller than it is. None of them falls back to a default.

## Exit codes

Profile selection rides `check`'s own machinery. The four conditions above are
exit-3 class (the run could not complete). `check`'s own 0/1 verdicts are
unchanged — a profile is a way to name a policy, so a profile-selected run
reports exactly like a file-selected one.

# Gate attestation

The machine-readable form of one claim: **a workspace outside this repository
runs `archkeep check` as a blocking gate** — the second of
[`docs/doctrine/roadmap.md`](../doctrine/roadmap.md)'s four 1.0 conditions.

An attestation is a small JSON file an external consumer publishes in its own
repository. It carries no verdict authority and proves nothing by existing. It
is a _claim_, structured tightly enough that every named fact can be checked —
by `scripts/verify-gate-attestation.mjs` for shape, by a human reviewer for the
facts no script can see. The same validator ships in the package: a consumer
can validate its own file against the version it installed, through the
[`./gate-attestation` subpath](#verifying-from-an-installed-package), without
cloning this repository.

## The file

```json
{
  "schemaVersion": 1,
  "repository": "acme/tree",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "tool": { "name": "@ecoma-io/archkeep", "version": "0.15.0" },
  "gate": { "command": "npx archkeep check", "blocking": true },
  "proof": { "violationExitCode": 1, "recoveryExitCode": 0 }
}
```

| field                     | rule                                                                                                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`           | Exactly `1`. A different number is a different format and is refused, never guessed at.                                                                                                                                                                              |
| `repository`              | `owner/name` of the consumer repository — outside this one by definition.                                                                                                                                                                                            |
| `commit`                  | The full 40-hex SHA the gate ran at. A short or symbolic ref could name a different commit tomorrow; staleness must be detectable, not deniable.                                                                                                                     |
| `tool.name`               | Exactly `@ecoma-io/archkeep`. This condition speaks about this package and no other.                                                                                                                                                                                 |
| `tool.version`            | Bare semver (`major.minor.patch`) — the version their gate ran, checkable against a registry document.                                                                                                                                                               |
| `gate.command`            | The invocation their CI runs; it must reach the boundary verdict — either by naming the check subcommand (`archkeep check`, `npx archkeep check`) or as a package-manager script alias whose name is this tool's own (`pnpm arch`, `npm run arch`, `pnpm archkeep`). |
| `gate.blocking`           | Exactly `true`. A non-blocking run is a report, not a gate a build answers to.                                                                                                                                                                                       |
| `proof.violationExitCode` | Exactly `1` — [the findings exit code](exit-codes.md). `0` proves the gate never blocks; `3` proves it could not look, not that it judged.                                                                                                                           |
| `proof.recoveryExitCode`  | Exactly `0` — removing the violation restored green. Without the recovery half, a permanently red pipeline would satisfy the condition too.                                                                                                                          |

Unknown fields are refused. An attestation proves exactly the fields above;
anything else would be a claim nobody validates.

## What the verifier decides, and what only a human can

```shell
node scripts/verify-gate-attestation.mjs attestation.json
```

Exit `0` with one summary line per file when every attestation is well-formed;
exit `1` naming every problem otherwise — an attestation is accepted whole or
not at all. The verifier executes nothing from the file and spawns no process:
every byte is untrusted input, validated as data.

What it **cannot** decide, because no file can: whether the commit exists,
whether CI actually ran those two directions, whether the run is still current.
That is why readiness stays a report and acceptance stays a maintainer's — the
verifier's job ends at making the claim precise enough to check against the
consumer's CI history by hand.

### Verifying from an installed package

The same validator is available through the package's `./gate-attestation`
subpath, so a consumer can validate its own attestation against the version it
installed:

```js
import { validateGateAttestation, readGateAttestation } from "@ecoma-io/archkeep/gate-attestation";
```

The entry is a re-export of the same implementation the CLI script drives — one
contract, two faces, no second opinion about what a verdict means.

## How readiness reads it

[`pnpm readiness`](../development/repository.md) ingests attestations through:

```shell
node scripts/check-readiness.mjs --attestations 'acme/tree.json' \
  --registry-json registry.json
```

Each path is read and validated; any refusal stops the report loudly rather
than printing a table that looks like an answer. With a registry document
supplied, an attested version absent from it is refused too — a gate built from
a version nobody can install proves nothing about the package consumers get.
Validated entries turn condition 2 to `met`, naming each
`owner/name@version`; supplying nothing leaves it `unmeasured`, as before.

## What does not count

- **This repository's own fixtures are not adoption.** The packed-tarball
  consumer lanes (`scripts/verify-package.mjs`, the E2E suite) prove the recipe
  — install, config loading, `check`, both exit directions — on trees this
  repository built. They cannot prove what a tree nobody here designed does to
  the tool, which is the entire point of the condition.
- **A bare repository name is not evidence.** "Known to us" is not "runs it as
  a blocking gate"; readiness accepts only validated attestations for exactly
  that reason.
- **A self-run inside this repository is not an external consumer**, even
  attested honestly. The condition names somebody else's tree.

## Producing one honestly

1. Make `archkeep check` block your build
   ([CI integration](../usage/ci.md) has the exit-code contract).
2. Introduce a controlled boundary violation; record your pipeline failing with
   exit `1`.
3. Remove it; record the build going green again.
4. Commit this file at the SHA those runs used, publish it in your repository,
   and tell us where it is.

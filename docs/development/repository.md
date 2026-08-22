# Repository

The workspace that holds Lattice, and how its moving parts relate.

## The six packages

| package                            | what it ships            | where it goes       | has its own AGENTS.md |
| ---------------------------------- | ------------------------ | ------------------- | --------------------- |
| `packages/lattice`                 | the engine               | npm                 | yes                   |
| `packages/lattice-vscode`          | the VS Code client       | VS Code marketplace | no                    |
| `packages/lattice-rule-sdk-rust`   | the Rust custom-rule SDK | crates.io           | no                    |
| `packages/lattice-rule-sdk-ts`     | the AssemblyScript SDK   | npm                 | no                    |
| `packages/lattice-rule-sdk-python` | the Python SDK           | PyPI                | no                    |
| `packages/lattice-rule-sdk-go`     | the Go SDK               | the Go module proxy | no                    |

`lattice` is the engine — the Nx and Moon integrations, the boundary checker,
and the language server behind one analysis. `lattice-vscode` is a client of it
and holds no analysis at all; it ships to a marketplace rather than to npm, and
it deliberately does not bundle the server.

The four `lattice-rule-sdk-*` packages are **bindings, not engines**. Each is
one language's typed way to author a custom rule and build it to the wasm the
engine already runs, so none of them holds analysis either, and none may grow
its own view of what a verdict means: four SDKs that disagreed would be four
laws wearing one contract's name. Every directory carries the language suffix
while the registry name does not, because each registry already names the
language ([ADR 0002](../adr/0002-custom-rules-one-contract.md) records both
decisions). Each README owns its own build story and its measured limits, and
those limits are the reason to read one before choosing an SDK.

Everything else in this repository is the apparatus that keeps them honest.

## Plain ESM, no build — for the two packages that ship JavaScript

`lattice` and `lattice-vscode` ship as `.mjs` with JSDoc. Nx loads a plugin's
entry point directly in the process that runs every `nx` invocation, and Moon's
integration reads the project graph via `moon project-graph --json`, so the
shipped artefact has to be loadable with no build step in the way. That is why
neither declares a `build` target — there is nothing to emit.

JSDoc is type-checked all the same: each package's `typecheck` target runs
`tsc -p tsconfig.json` with `noEmit` and `checkJs`, which reads the JSDoc as the
program and writes nothing.

The rule SDKs are the exception, and a bounded one. Their artefacts are
WebAssembly, so building is the point — but the build is **not** a Moon target
either, and deliberately: a `.wasm` is committed beside its `.sha256`, and each
package ships a `rebuild-example.sh` that reproduces it. Requiring cargo,
TinyGo and a RustPython carrier on every CI leg to re-emit bytes already in the
tree would buy nothing the digest does not already prove — which is exactly
what `rule-sdks.integration.test.mjs` checks, loading every committed artifact
through the engine's real host at the digest its own package records. What the
SDK packages do declare is `lint` and `test` in their own language's tooling,
and `typecheck` wherever that language has a checker in the toolchain this
repository already installs — Python has none, so `check-packages` reports
`lint, test (no typecheck)` for it, which is the truthful line rather than a
gap. Those targets need the toolchains CONTRIBUTING.md lists.

## The gate scripts

`scripts/` holds the gates that make a green build mean something:

- `check-packages.mjs` — asserts every `packages/*` directory is a project Moon
  can see, declaring at least one CI target. CONTRIBUTING.md
  explains why it exists and what it would catch.
- `check-docs-links.mjs` — fails on any doc reference that cannot resolve:
  markdown links in `docs/` whose target file is gone, `#anchors` that name no
  heading, and `docs/…` citations in code comments and strings pointing at a
  file that does not exist. It was written because the documentation IA
  restructure once deleted two files and left twenty-five references — two
  inside shipped error messages — pointing at the old paths, and nothing
  caught it: Prettier formats markdown but does not resolve a link.
- `coverage-real-trees.mjs` — clones real public Go, Rust and Python
  repositories at pinned shas and holds three counts exactly: files read,
  import records produced, failures reported. It answers the question the
  ESLint differential structurally cannot, because those three languages never
  reach the upstream rule and so have no oracle to disagree with. Weekly, not
  required, and a red run is a regression — [testing.md](testing.md) owns why.
- `check-readiness.mjs` — **a report, not a gate.** It prints the four
  conditions [../doctrine/roadmap.md](../doctrine/roadmap.md) says separate 0.x
  from 1.0, each read off something rather than remembered, in three states:
  `met`, `not met`, and `unmeasured` — the last for the conditions whose
  evidence lives outside this tree (a workflow's run history, another
  repository's CI), which it names rather than guessing at. `pnpm readiness`.
  It is not a gate because a gate that fails until 1.0 fails every build for
  months and gets deleted long before it is satisfied; what keeps it honest is
  being run and read.
- `verify-package.mjs` — packs the real tarball, installs it into a throwaway
  workspace, and drives what a consumer actually buys. Also runs against a
  second workspace with no Moon at all, proving the native provider works from a
  real install, and a third with a Moon workspace, proving the Moon provider
  works from a real install.
- `check-skills.mjs` — the skills gate: shape, citations, and the manifest
  version chain [../skills/versioning.md](../skills/versioning.md) owns.
- `differential-real-trees.mjs` — drives both this engine and real ESLint over
  public Nx workspaces, comparing verdicts.

Their `*.test.mjs` companions run under `pnpm test` (`node --test`), a separate
suite from the package targets. The scripts themselves run as their own CI
steps — `verify-package.mjs` in `ci.yml` and again in the release lane,
`differential-real-trees.mjs` from `differential.yml`.

## CI

`.github/workflows/ci.yml` runs Prettier, ESLint, `node --test`,
`check-packages`, `check-skills`, `check-docs-links`, the package targets, the
tool on this tree, and the packed-artifact verification. Its `ci-gate` job
fails on any needed job that is `skipped` or `cancelled`, because `needs` alone
only blocks on `failure`.

`.github/workflows/analysis.yml` runs CodeQL (both `javascript-typescript` and
`actions`), Semgrep, and Gitleaks, aggregated behind an `analysis-gate` job.

**Two required checks, and `analysis-gate` is not one of them.** The branch
ruleset requires `ci-gate` and `Semgrep`, the latter named directly — measured
against the ruleset on 2026-08-22, not assumed. So CodeQL or Gitleaks going red
turns `analysis-gate` red and still lets a merge through: that aggregate is a
signal to read, not a wall. `ci-gate` being a name rather than a job list is
what lets a job added to `ci.yml` later tighten the gate with no repository
setting touched.

## The boundary law

`module-boundaries.config.mjs` at the repository root is this workspace's own
constraint table, with the tag vocabulary `type-package`/`scope-nx`. CI runs
`lattice check` against it — the enforcer runs on itself.

## What owns what

[docs/README.md](../README.md) holds the documentation ownership map.
AGENTS.md holds the rules a diff is rejected for violating.
CONTRIBUTING.md holds the contribution bar and the
commands. SECURITY.md holds the threat model. None of
those are repeated here — see the ownership map for the full table.

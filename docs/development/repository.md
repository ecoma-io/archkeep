# Repository

The workspace that holds Lattice, and how its moving parts relate.

## The two packages

| package                   | what it ships      | where it goes       | has its own CLAUDE.md |
| ------------------------- | ------------------ | ------------------- | --------------------- |
| `packages/lattice`        | the engine         | npm                 | yes                   |
| `packages/lattice-vscode` | the VS Code client | VS Code marketplace | no                    |

`lattice` is the engine — the Nx and Moon integrations, the boundary checker,
and the language server behind one analysis. `lattice-vscode` is a client of it
and holds no analysis at all; it ships to a marketplace rather than to npm, and
it deliberately does not bundle the server.

Everything else in this repository is the apparatus that keeps them honest.

## Plain ESM, no build

Both packages ship as `.mjs` with JSDoc. Nx loads a plugin's entry point
directly in the process that runs every `nx` invocation, and Moon's integration
reads the project graph via `moon project-graph --json`, so the shipped artefact
has to be loadable with no build step in the way. That is why neither package
declares a `build` target — there is nothing to emit.

JSDoc is type-checked all the same: each package's `typecheck` target runs
`tsc -p tsconfig.json` with `noEmit` and `checkJs`, which reads the JSDoc as the
program and writes nothing.

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
- `verify-package.mjs` — packs the real tarball, installs it into a throwaway
  workspace, and drives what a consumer actually buys. Also runs against a
  second workspace with no Moon at all, proving the native provider works from a
  real install, and a third with a Moon workspace, proving the Moon provider
  works from a real install.
- `differential-real-trees.mjs` — drives both this engine and real ESLint over
  public Nx workspaces, comparing verdicts.

These run under `pnpm test` (`node --test`) and are a separate suite from the
package targets.

## CI

`.github/workflows/ci.yml` is a required check (`ci-gate`, alongside
`analysis-gate` from `analysis.yml`). It runs
Prettier, ESLint, `node --test`, `check-packages`, `check-docs-links`, the
package targets, the tool on this tree, and the packed-artifact verification.
It fails on any needed job that is `skipped` or `cancelled`, because `needs`
alone only blocks on `failure`.

`.github/workflows/analysis.yml` runs CodeQL (both `javascript-typescript` and
`actions`), Semgrep, and Gitleaks, aggregated behind an `analysis-gate` job
that is a required check alongside `ci-gate`.

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

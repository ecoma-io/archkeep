# Verification

What CI runs, why it runs it, and what every gate is for. The file that owns
the command list is `CONTRIBUTING.md`; this page owns the model behind it —
the tiers, the boundaries, and the reasoning each gate carries.

## The shape

Moon is the project verification orchestrator. Every `packages/*` directory
plus `scripts/` is a Moon project (`check-packages` fails otherwise), every
project answers the same canonical targets — `lint`, `test`, `typecheck`, and
where meaningful `e2e`, `integration`, `package` — and a pull request runs
`moon ci`, which selects exactly the targets a change can have moved, through
each task's declared `inputs` and the graph.

The three decisions a change meets, in order:

1. **Repository-wide invariants** — Prettier formatting, doc links, doc
   parity, skills shape, artifact hygiene, the boundary law run on itself.
   These run on every event because their subject is the repository, not a
   project; each is a shell step in `ci.yml`, not a Moon task.
2. **Project verification** — the affected Moon graph. A change maps to the
   tasks whose inputs match it; nothing else runs. An empty Moon result is a
   printed claim ("No tasks affected by changed files"), not silence, and the
   invariants around it still ran.
3. **End to end** — the E2E suite, sharded two ways by vitest. Whether it
   runs is Moon's call on a pull request (`moon query projects --affected`:
   the engine project's affected status is the trigger) and unconditional on
   the merge queue and `main`; how it runs is the shard. The two decisions
   are never mixed.

## Task inputs, and why there is no `dependsOn`

Declaring `inputs` replaces Moon's whole-project default, so every declared
list restates `**/*` first. What each additional entry buys: when that file
changes, the task re-runs — in affected selection and in cache hashing, so a
warm cache can never replay a verdict over consumed bytes that changed. The
bootstrap pair (`/package.json`, `/pnpm-lock.yaml`) rides on every Node
tooling task; `/eslint.config.mjs` on every lint that reads it;
`/tsconfig.base.json` on every typecheck; sibling trees on exactly the suites
that consume them (the engine's conformance suite reads every SDK's
committed artifact).

`dependsOn` was measured and rejected: Moon judges declared edges against
the boundary constraint table, so verification-only edges (test fixtures
reading sibling bytes) would read as scope violations, while the same
relationships expressed as inputs judge exactly what actually changed.

## The verification contract, per project

| Project                  | lint                                            | test                                 | typecheck                                                  | more                                                     |
| ------------------------ | ----------------------------------------------- | ------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------- |
| archkeep                 | ESLint (typed rules)                            | Vitest                               | `tsc --noEmit`                                             | `e2e`, `integration` (packed artifact in consumer trees) |
| archkeep-mcp             | ESLint (typed rules)                            | Vitest                               | `tsc --noEmit`                                             | —                                                        |
| archkeep-vscode          | ESLint (typed rules)                            | Vitest                               | `tsc --noEmit`                                             | `package` (vsce pack + install proof)                    |
| archkeep-rules           | cargo fmt + clippy −D warnings + ESLint         | cargo test + node --test             | cargo check (host + wasm32) + tsc                          | —                                                        |
| archkeep-rule-sdk-rust   | cargo fmt + clippy −D warnings                  | cargo test (with ran-nothing guard)  | cargo check (host + wasm32)                                | —                                                        |
| archkeep-rule-sdk-go     | gofmt (empty-output guard) + golangci-lint      | go test −v (with ran-nothing guard)  | go build ./...                                             | —                                                        |
| archkeep-rule-sdk-python | ruff check + ruff format --check + compileall   | unittest discover                    | — (see below)                                              | —                                                        |
| archkeep-rule-sdk-ts     | ESLint (harness only; `assembly/` is not JS)    | node --test (with ran-nothing guard) | asc --noEmit (the AssemblyScript compiler) + tsc (harness) | —                                                        |
| gate-scripts             | ESLint (scripts + the four root-level JS files) | node --test (with ran-nothing guard) | `tsc --noEmit`                                             | —                                                        |

The gaps are statements, not omissions: `archkeep-rule-sdk-python` has no
`typecheck` because Python has no checker in the toolchain this repository
installs, and a target that ran `compileall` under that name would be the
placeholder green `check-packages` exists to catch. `archkeep-rule-sdk-ts`'s
`.ts` sources are AssemblyScript — `asc` is their compiler and type checker,
and ESLint deliberately has no `**/*.ts` block.

## Lint quality tiers

Every lint rule in every language answers to one of three tiers. The tiers
are a review framework, not configuration sections.

- **Tier 1 — correctness.** A violation is a bug the type checker or the
  test suite could miss. Not negotiable, always `error`:
  `no-floating-promises`, `no-misused-promises` (a gate that does not await
  its check reports green over a violation — this repository's whole threat
  model in rule form), `require-atomic-updates`, `eqeqeq`, ruff `F` and `B`,
  clippy with `-D warnings`, `errcheck`.
- **Tier 2 — reliability and maintainability.** Unused declarations, dead
  code, suspicious constructs: `@typescript-eslint/no-unused-vars`,
  ruff `E4`/`E7`/`E9`, govet, staticcheck, unused, ineffassign. Also
  `error`; a new finding blocks.
- **Tier 3 — style.** Only enforced where a formatter does not already own
  the question, and only when agreement is total. Prettier owns formatting
  for everything it reads, `eslint-config-prettier` switches the fighting
  rules off, `ruff format` owns Python, `gofmt` owns Go, `cargo fmt` owns
  Rust. No lint rule argues layout with a formatter.

What lint is deliberately NOT for: business rules that belong to the
boundary law (`module-boundaries.config.mjs` and the engine that enforces
it), type facts that belong to `tsc`/`asc`/`cargo check`, and behavioral
truths that belong to tests. Security scanning is Semgrep, CodeQL and
Gitleaks in `analysis.yml` — not ESLint.

Every suppression is per-file with a written reason
(`module-boundaries.config.mjs`'s `boundarySuppressions`), and there are no
blanket directory ignores outside generated output (`coverage/`, `target/`)
and self-creating test fixtures.

## Runtime floors

Two floors, both real: the published packages declare `engines.node`
`>= 22`, and CI's Node 22 leg holds them to it; the workspace's own
development floor is 24 (root `package.json`, `.node-version`). Go is pinned
by `go.mod`'s `go` line through `setup-go`; Ruff and golangci-lint are
version-pinned installs, not runner-image casts.

## Cache

Moon's input-hash cache is load-bearing locally and harmless-empty in CI:
runners start cold, so affected selection — not the cache — is what keeps a
pull request small. The cache is never allowed to answer a question the
graph got wrong: every consumed-but-external byte is a declared input
precisely so a hash change forces a re-run. Remote caching is deliberately
not configured; the repository is small enough that correctness of the graph
is worth more than seconds the cache would save.

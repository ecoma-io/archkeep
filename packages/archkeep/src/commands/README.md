# `src/commands/` — one module per CLI command

One module per CLI command, holding the computation and nothing about argv,
exit codes or where output goes. `../../cli.mjs` owns those three. A module
here may read the graph, the workspace and the policy; it may not print, and
it may not decide the process's exit code — it returns a status and `cli.mjs`
maps it.

`context.mjs` and `policy.mjs` are the exceptions in kind, not in rule: each is
a preamble the commands share rather than a command. `context.mjs` composes
`../workspace.mjs`, `../providers/` and `../options.mjs`; it does not
reimplement any of them. `policy.mjs` holds the one boundary-policy ladder every
command that reads a law resolves through, so no command grows a second copy of
the resolution order.

## Commands

- **`check`** (`./check.mjs`'s `check`, driven by `../../cli.mjs`'s `runCheck`) —
  judges every import site against the boundary rules and folds in every other
  finding class a verdict counts:
  declared-edge violations, go.work drift, dead tsconfig path aliases, intent
  drift, a failing fitness gate, and a failing custom rule
  (`./custom-rules.mjs`). Exits 1 on any of them, and it is the only
  command holding all four exit codes
  ([which verbs carry exit 1 is settled in `docs/concepts/architecture.md`](../../../../docs/concepts/architecture.md)
  — `fitness` and `delta` are the other two).

- **`graph`** (`./graph.mjs`'s `graphCommand`) — the project graph as a
  deterministic, serialisable snapshot: projects (with `targets` and `tags`) and
  dependencies, each as a flat sorted array. Strips internal fields
  (`mfeRemote`, `entryPoints`, `declaredPackages`). Includes
  `workspaceLayout`/`workspaceLayoutSource`. Refuses an Nx workspace with
  polyglot manifests but no plugin registration. Descriptive: never exits 1.

- **`diff`** (`./diff.mjs`'s `diffCommand`) — two graph snapshots compared edge
  by edge. Takes a baseline file (not a git ref). When a boundary config is
  available (via `--config` or the workspace's declared config), also reports
  which boundary violations the diff introduces and which it resolves — this
  is narrower than `check`: it checks only `depConstraints` (tag-based), not
  npm/circular/lazy-load rules that need import-site details.
  Refuses an incomplete baseline or head.
  Refuses an Nx workspace with polyglot manifests but no plugin registration.
  Descriptive: never exits 1.

- **`delta`** (`./delta.mjs`'s `captureDelta` and `deltaCommand`) — two modes
  behind one verb. `--capture` writes the evidence snapshot
  `./delta-snapshot.mjs` defines — raw import-site records, the graph, coverage,
  provenance, the policy fingerprint; evidence, never verdicts. Compare loads a
  baseline, re-judges BOTH sides through `../rules/index.mjs` under the CURRENT
  config and one shared instant, and classifies each violation
  introduced/resolved/unchanged/unknown (`./delta-classify.mjs`), with
  unresolvable import sites carried as their own category, never counted as
  violations. Refuses an unreadable, malformed, foreign-schema, or
  incomplete-coverage baseline, a provider mismatch (stricter than `diff`'s
  note — violation identity across two project models is not evidence),
  incomplete head coverage, and an Nx workspace with polyglot manifests but no
  plugin registration; a policy-fingerprint change is a loud coverage note, not
  a refusal. A verdict, not a description: a non-waived introduced violation is
  a finding (exit 1 — the third verb beside `check` and `fitness`), an
  unclassifiable item is a no-verdict (exit 3), and a waived-introduced entry
  is reported without gating. Capture stays descriptive: never exits 1.

- **`impact`** (`./impact.mjs`'s `impactCommand`) — reverse reachability from
  the project graph: given a project name, lists every project that transitively
  depends on it. Separates direct from transitive dependents. When a boundary
  config is available, also shows the constraint context for each dependent:
  which constraint rows govern its edge and whether that edge violates them.
  Refuses incomplete coverage (whole-file analysis failures).
  Refuses an Nx workspace with polyglot manifests but no plugin registration.
  Descriptive: never exits 1.

- **`explain`** (`./explain.mjs`'s `explainCommand`) — the judgment for one import
  site, explained. Takes a `file:line:column` site, finds the matching import
  record, and explains: which constraint row matched, which tags applied,
  whether it is a violation and why. Reports an `UNRESOLVABLE` verdict for a
  site-level failure (dynamic import with non-literal argument). Refuses an Nx
  workspace with polyglot manifests but no plugin registration. Descriptive:
  never exits 1.

- **`context`** (`./context-command.mjs`'s `contextCommand`) — the architecture
  constraints that apply to one project. Takes a project name and returns the
  project's tags plus every matching `depConstraints` row, including optional
  descriptions and remediation guidance. The filename deliberately avoids
  colliding with `./context.mjs`, which is the shared command preamble. Refuses
  an Nx workspace with polyglot manifests but no plugin registration.
  Descriptive: never exits 1.

- **`context --plan`** (`./plan-context-command.mjs`'s `planContextCommand`) —
  the `--plan` face of the command above: the deterministic facts an agent needs
  before it reasons about, plans and executes a change, scoped to the target
  project plus optional paths. Current architecture, the applicable policy rows
  with their authored description and remediation plus the policy fingerprint,
  impact (dependents capped, with an explicit overflow note), current
  violations, go.work and tsconfig-path drift, the canonical architecture-intent
  verdict, coverage, and the commands that verify the change afterwards. It
  never generates a plan, decides an implementation strategy, modifies source
  code, or weakens policy — every field is a fact the tree or the boundary law
  states, and a section that cannot state one says so (`null`, `[]`, or an
  explicit `no-verdict`). The rule verdict is computed over the WHOLE
  analyzeable tree and then filtered to the scoped reporting set, because the
  circular-dependency and lazy-load rules need the whole file index; that is
  what makes the verdict correct on every provider. Descriptive: never exits 1.

- **`history`** (`./history.mjs`'s `historyCommand`) — the architecture's
  evolution across a consumer-managed directory of `graph --format json`
  snapshots. Reads every snapshot (the directory is the sole source of truth —
  no index, no database), in filename byte-sort (history) order, and classifies
  each transition by what the snapshots carry: graph diff (architecture),
  `policy.fingerprint` (policy/intent), `workspace.provider` (provider), and
  provenance advance with neither changed (code drift). One-sided or cross-repo
  signals are disclosed as incomparable rather than read as unchanged.
  `--capture` writes `<sequence>-<sha8>.json` (deduplicating when the
  architecture identity already is the last snapshot) and refuses incomplete
  head coverage. Refuses an empty or unreadable directory, and a snapshot that
  parses as an incomplete envelope. Descriptive: never exits 1.

- **`provenance`** (`./provenance-command.mjs`'s `provenanceCommand`) — where
  this run's facts came from and which governance rows carry an origin.
  Two surfaces: repository provenance (the git commit, remote and dirty state
  `./provenance.mjs` exposes to every envelope) and decision provenance (each
  `architecture-intent.json` row and each boundary-config `depConstraints` row,
  and whether it carries an `origin` record — a row without one is flagged
  `no origin recorded — cannot attest`). Reads the workspace's OWN declared
  intent and config, and its own provider via `resolveCommandContext`; never
  changes a verdict and never exits 1. Refuses out of a malformed intent or
  boundary config the way `drift` does — a row list built from a file it could
  not read is a claim about rows that do not exist. Descriptive: never exits 1.

- **`report`** (`./report.mjs`'s `reportCommand`) — one architecture governance
  document: how healthy the architecture is, and why. Composes `healthCommand`,
  `waiversCommand`, `fitnessCommand`, the ADR registry (`readAdrContext` plus
  `resolveDecisionRef`) and `resolveProvenance` — every number through the
  function that owns it, so no section can disagree with the command it came
  from — over ONE boundary law `cli.mjs` resolved for the whole page. Links each
  governed row carrying a `decisionRef` to the record it cites, and each declared
  fitness gate to the ADRs binding it; a citation that resolves to nothing reads
  `unknown`, never a pass. `result.uninspectable` names every surface the run
  could not establish and is what makes the status `no-verdict` (exit 3).
  Descriptive: never exits 1 — a live violation or a failing gate is reported
  over exit 0.

- **`discover`** (`./discover.mjs`'s `discoverCommand`) — the observed
  architecture, and under `--propose` the candidate architecture those
  observations imply. Builds the observed `{projects, edges}` from the same
  model `graph`/`drift` read, reports projects/edges/tags plus the coverage a
  verdict could trust, and optionally drives
  `../../src/governance/discovery-proposal.mjs`'s pure evaluator over it.
  Proposal-only: every candidate carries `proposed: true` and
  `notAuthoritative: true`, and the command never writes
  `architecture-intent.json`. Returns `status: "no-verdict"` (exit 3) over
  incomplete coverage and refuses `--propose` over it; refuses an Nx workspace
  with polyglot manifests but no plugin registration; a zero-project workspace
  is the empty `unknown` proposal, not a refusal. Descriptive: never exits 1.

- **`drift`** (`./drift.mjs`'s `driftCommand`) — the observed architecture
  compared against the declared intended one. The intended side is the one
  canonical contract the workspace declares — `architecture-intent.json` at its
  root, loaded and judged by the same `../architecture-intent/model.mjs` and
  `../architecture-intent/judge.mjs` the `check` command uses, so there is no
  parallel intent grammar and no `intentConfig` option. Reads only the resolved
  `CommandContext` and never a provider, so the same intent produces the same
  verdict under Nx, Moon or native. Refuses an intent that cannot be read or
  parsed, incomplete observed coverage, an Nx workspace with polyglot manifests
  but no plugin registration, and a boundary or row side that matched no
  observed project. Resolving each intent row's `decisionRef` against the ADR
  registry is a separate, NON-VERDICT axis — it never becomes a finding and
  never changes the exit code — and it is the only thing here that reads the
  boundary law, so `cli.mjs` hands that load's failure over as `io.configError`
  rather than throwing it where it happens: rethrown unchanged at the one site
  that reads the policy when a row does carry a citation, and otherwise stated
  as a coverage note rather than dropped. Descriptive: never exits 1.

- **`reconcile`** (`./reconcile.mjs`'s `reconcileCommand`) — the two-sided
  mirror of `drift`: where drift asks which intended rows reality violates,
  reconcile asks, element by element, what the model says about reality and what
  it would take to make the two agree. Read-only by design; `--propose` emits a
  ranked candidate list of model edits — add-only, removal, tag-change,
  boundary-change — each carrying the evidence that supports it and an explicit
  `proposed: true` / `notAuthoritative` marker, and the command never writes back
  into `architecture-intent.json`. Makes the same four refusals `drift` makes,
  and reads no boundary law, so it makes only those four. Those refusals mean an
  `unknown` score can only ever come from a whole-file failure the command
  already refused on — and `../governance/reconcile-score.mjs` marks it anyway,
  so the scoring module can never render a partial read as a claim on its own.
  Descriptive: never exits 1 — divergence is described, never gated.

- **`waivers`** (`./waivers.mjs`'s `waiversCommand`) — the whole
  `boundarySuppressions` surface, read-only: the temporary rows carrying an
  `expiresAt`, with their remaining term, and the permanent ones carrying none,
  with what each currently covers. Evaluates the tree with the suppression table
  REMOVED, so every row's coverage is judged against the full finding set rather
  than against the run the table already cleaned — a row that covers nothing is
  named as stale instead of silently doing nothing. A permanent suppression
  never appears in `check`'s findings at all, which makes this the only surface
  that names one. Refuses whole-file analysis failures, and refuses an Nx
  workspace with polyglot manifests but no plugin registration through
  `./drift.mjs`'s `refuseIncompleteGraph` — the one shared guard for that state —
  because a row measured against a graph that never drew the workspace's
  polyglot edges reads as covering nothing it was never shown. The
  remaining-time column is computed against the injected clock
  (`../governance/clock.mjs`), so a fixed `now` reproduces the report byte for
  byte. Descriptive: never exits 1, and it never modifies the table.

- **`fitness`** (`./fitness.mjs`'s `fitnessCommand`) — every declared fitness
  function judged against the observed workspace, as a verdict table. The
  functions are the policy's own `fitness` export, validated by `../config.mjs`
  and judged through `../governance/fitness-registry.mjs`, which reuses the
  shared member resolution and verdict envelope rather than duplicating a judge,
  against the same observed facts `check` reads. A verdict rather than a
  description: a failing function is a finding (exit 1) and an undetermined one
  is a could-not-determine (exit 3). A function that cannot be determined is
  `unknown`, never `pass`; one whose `match` selects no project is `skipped` —
  loud ("declared but matches nothing"), never folded into `pass` — and a
  `coverage-minimum` row judged from a path-scoped run joins it there, because a
  scoped run structurally cannot answer a whole-tree coverage question.

- **`health`** (`./health.mjs`'s `healthCommand`) — deterministic
  architecture-health metrics and trends for the current workspace: violation
  count, waiver surface, debt rows, coverage ratio, project and edge counts,
  cycle count, edge density and the intent verdict. Every number is re-derived
  from records the run already holds, through the same functions
  `check`/`graph`/`drift` use, so it performs no new scans and cannot disagree
  with those commands about the same tree. Each metric is decided over complete
  evidence or says it could not look — no evidence reads `not_applicable`,
  partial evidence reads `unknown`, and a metric is never reported as a bare
  zero over evidence the run could not inspect. Trends come from the same
  snapshot directory `history` reads, limited to what a `graph` snapshot
  carries. `status` is `"ok"` only when every metric reached a verdict and
  `"no-verdict"` (exit 3) when any is `unknown`. Descriptive: never exits 1, and
  purely additive — it changes no other command's verdict or exit code.

- **`debt`** (`./debt.mjs`'s `debtCommand`) — the architecture-debt ledger: the
  exemptions, gaps and violations a workspace is carrying, each aged across the
  history directory `history` reads. Computes today's facts the same way
  `check`/`drift` do — the boundary config's `boundarySuppressions`, and
  `judgeIntent`'s findings, notes and unresolved — over a config the caller
  resolved exactly as `diff`'s is, so a debt run and a `check` run never
  disagree about the current boundary law. Fewer than two snapshots sets
  `agings: false`, stating that every entry is really age-0 because the record
  cannot establish age, rather than guessing one. Refuses incomplete graph
  coverage, an intent that cannot be verified, and a directory that cannot be
  read or parsed — a missing directory is a no-verdict, never an empty ledger.
  Descriptive: never exits 1 — a report, not a gate.

- **`adr`** (`./adr.mjs`'s `adrCommand`) — the workspace's recorded architecture
  decisions and the rule/fitness ids each makes enforceable, read from
  `docs/adr/NNN-slug.md` at the workspace root
  (`../governance/adr-registry.mjs` owns the format and the index). With no
  argument it dumps the whole registry: every record, its status, its
  supersession chain, and what it binds. Given an id it shows that record, and
  for a `rule:`/`fitness:`-prefixed ref the reverse lookup naming which ADRs
  bind it. Needs no project graph, no Nx and no boundary config — the registry
  is self-contained in the tree, so `resolveCommandContext`'s heavy preamble is
  skipped and `adr` runs on a tree with no Nx at all. Refuses an unreadable
  registry and an unresolvable reference; a binding to a fitness id no
  declaration carries is listed `unknown` — named, never hidden. Descriptive:
  never exits 1.

## Shared modules

- **`snapshot-meta.mjs`** — `compareSnapshotMetadata`, shared by `diff` and
  `history`: the provider, provenance (with cross-repo and one-sided
  detection) and policy-fingerprint comparison between a baseline and a head.

- **`custom-rules.mjs`** — the custom-rules fold `check` runs by presence: each
  row the policy's `customRules` list declares, loaded from its artifact's bytes
  and judged over the evidence the run already computed. It owns the file
  reading the host deliberately does not (`../custom-rules/host.mjs` takes
  bytes, never a path) and the routing of the host's two failure classes: a
  LOAD failure throws, so the run refuses the way it refuses a malformed
  boundary config, and an EVALUATE failure becomes that rule's `unknown`
  verdict with the host's own reason. A path-scoped run answers
  `not_applicable` for every declared rule before reading anything, the posture
  `coverage-minimum` takes for the same reason. Returns the verdict records
  `check` folds into the fitness exit lanes plus the finding catalogue SARIF's
  descriptors are built from; it prints nothing and decides no exit code.

- **`edge-constraints.mjs`** — edge-constraint analysis shared by `diff` and
  `impact`. Judges a single graph edge against the `depConstraints` table,
  producing violations with their constraint rows. Checks only tag-based rules
  (`onlyDependOnLibsWithTags`, `notDependOnLibsWithTags`,
  `projectWithoutTagsCannotHaveDependencies`); npm/circular/lazy-load rules
  need import-site details that graph edges do not carry. A consumer who needs
  the complete verdict should run `check`.

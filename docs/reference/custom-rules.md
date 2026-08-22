# The custom-rule contract

The exact contract between the engine and a rule it did not write: what a
declared artifact must export, what bytes it receives and must return, and
every way the exchange can fail. [concepts/custom-rules.md](../concepts/custom-rules.md)
owns the model and the refusals; [policy-schema.md](policy-schema.md) owns the
`customRules` row a workspace declares; this page owns the wire.

The contract is versioned as a whole: every document below carries
`"contract": 1`, and an engine that cannot speak a rule's contract answers
`unknown` for that rule — never an approximation.

## The artifact

A rule is one **core WebAssembly module** — no WASI, no component model, and
**no imports of any kind**: a module whose import section is non-empty is
refused at load, which is the mechanism behind the no-ambient-capability
decision rather than a review comment about it. The engine executes it with
the `WebAssembly` runtime its own JavaScript engine ships, one fresh instance
per rule per run, discarded after the call — which is why a rule's allocator
may leak freely.

Required exports, checked by name and kind before anything runs:

| export             | kind     | contract                                                             |
| ------------------ | -------- | -------------------------------------------------------------------- |
| `memory`           | memory   | the linear memory every pointer below indexes into                   |
| `lattice_alloc`    | function | `(len: i32) -> i32` — a pointer to `len` writable bytes              |
| `lattice_describe` | function | `() -> i64` — packed pointer/length of the describe JSON             |
| `lattice_evaluate` | function | `(ptr: i32, len: i32) -> i64` — packed pointer/length of the verdict |

The packed `i64` is `(ptr << 32) | len`, both halves unsigned 32-bit values
into `memory`. A range that leaves the memory, or a return value that is not
the packed shape, is a named failure — never a guess.

## `lattice_describe` — the self-description

Called once, at load, before any evidence exists. UTF-8 JSON:

```jsonc
{
  "contract": 1,
  "name": "no-interface-outside-domain", // must equal the declared row's name
  "needs": ["model", "graph"], // subset of the evidence kinds below
  "findings": [
    // the catalogue: at least one entry, unique ids,
    { "id": "misplaced-interface", "message": "an interface is declared outside the domain" },
  ],
}
```

Names and finding ids share one grammar — dash-separated lowercase, the same
pattern the policy loader holds rule names to. A describe whose `name`
disagrees with the declaration, whose catalogue is empty or malformed, or that
carries a key this table does not name, refuses the load by name.

## The evidence bundle — what `lattice_evaluate` receives

Canonically serialized UTF-8 JSON, byte-deterministic over an unchanged tree
(projects and edges sorted), assembled by the engine from the facts the run
already computed. Contract 1 carries exactly four kinds:

| kind      | what it holds                                                                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`   | `projects`: every project as `{name, root, tags}`                                                                                                                            |
| `graph`   | `edges`: the dependency records the graph holds                                                                                                                              |
| `imports` | every import-site record of the analysis contract (`packages/lattice/src/analysis/contract.md`), verbatim, plus `sourceProject` — the attribution the pipeline already holds |
| `policy`  | `depConstraints` and `moduleBoundaryOptions`, as loaded                                                                                                                      |

Beside the kinds, the bundle carries the rule's own instance:
`rule: { name, params }`, with `params` the declared row's object (`{}` when
the row declares none). A rule **declares** the kinds it reads in `needs`;
naming one this engine cannot supply makes the rule's verdict `unknown` with
the kind named. A rule that wants a fact no kind carries is asking for a new
extractor in the engine — it never parses source itself
([concepts/custom-rules.md](../concepts/custom-rules.md) owns that refusal).

## The verdict — what `lattice_evaluate` returns

UTF-8 JSON, validated before it becomes a claim; a violation of any line
below is a **hollow verdict**, and the rule answers `unknown` naming what was
wrong:

```jsonc
{
  "contract": 1,
  "verdict": "pass" | "fail" | "unknown" | "not_applicable",
  "findings": [
    // always present; empty exactly when nothing was found
    {
      "id": "misplaced-interface", // must exist in the describe catalogue
      "message": "libs/ring/adapter.go declares PortReader outside the domain",
      "sourceFile": "libs/ring/adapter.go", // optional; workspace-relative
      "line": 4, // optional, 1-based, only beside sourceFile
      "column": 6, // optional, 1-based, only beside line
      "project": "ring" // optional
    }
  ],
  "reason": "…", // required exactly when verdict is "unknown"
  "notApplicableReason": "…" // required exactly when verdict is "not_applicable"
}
```

The obligations run both directions: `fail` requires at least one finding,
`pass` requires none, and a `pass` carrying a `reason` is a rule that meant
`unknown` and said `pass` — refused. Unknown keys are refused by name at every
level. In every report face a finding's id renders namespaced as
`custom/<ruleName>/<findingId>`; the fifteen boundary violation ids
([violations.md](violations.md)) stay reserved for the boundary rules.

## Execution bounds

Every call into a rule — describe included — runs inside a worker under a
budget. The engine's bounds, each a named failure when exceeded, never a
silent skip:

| bound          | value   | exceeded means                                                                                                                                       |
| -------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| time, per call | 10s     | the rule is `unknown` naming the budget (load-class when describe is the call that spun)                                                             |
| verdict size   | 8 MiB   | an in-bounds but oversized claim, refused naming the cap                                                                                             |
| linear memory  | 256 MiB | checked after instantiation and after the call; growth between those boundaries is a declared limit, and wasm32 caps the ceiling at 4 GiB regardless |

## The failure taxonomy

Two classes, folded into the exit codes `check` already has
([exit-codes.md](exit-codes.md)) — no new code, and no path on which a
declared rule silently does not run:

| class        | reached by                                                                                                                                                                                           | consequence                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **load**     | artifact unreadable · sha256 mismatch · bytes not valid wasm · imports declared · required export missing · describe unreadable, wrong contract, wrong name, malformed catalogue, or over its budget | the law could not be loaded: the run refuses, the 3-class a malformed config takes |
| **evaluate** | trap · time or memory budget exceeded · out-of-bounds range · verdict unparseable · hollow verdict · unsupported evidence kind                                                                       | that rule's verdict is `unknown` with the cause named; any `unknown` keeps exit 3  |

Every rule loads before any rule evaluates: a run judges the whole declared
law or refuses it, because half a law half-applied is a verdict nobody
declared.

## Seeing what a rule saw

A rule that answers `unknown` names its cause, and that is often not enough:
the author still has to reproduce the run. The sandbox that makes a rule
deterministic — no filesystem, no clock, no environment — is also what leaves
them with no way to look at the bundle their rule was handed.

`check --evidence-out <dir>` is the window. It writes one `<rule>.json` per
declared rule into an existing directory, holding the exact document that rule
was judged over, re-indented from the canonical bytes so it reads in a diff.
Feed it straight to the replay harness the SDK ships.

Three properties are worth stating, because each is a decision:

- **It changes no verdict and no exit code.** A debugging flag that moved the
  answer would make every debugged run a different run.
- **It writes the bundle for a rule that failed to judge.** The evidence is
  built before the rule is called, so a trap or an exhausted budget still
  leaves the author their input — which is precisely when they need it.
- **It never writes nothing silently.** A policy declaring no `customRules`
  and a path-scoped run each say so on stderr; a declared law that could not
  be loaded refuses the whole run before any rule is judged, so there is no
  evidence to write and the run's own refusal is the message.

`explain` is not part of this. It answers about an import site and the
constraint row that decided it; it does not re-judge a custom rule, because
the engine has nothing to say about a judgment it did not make. What explains
a custom finding is the rule's own message, the `reason` its declaring row
carries, and the bundle above.

## Scoped runs

`check <path>` analyzes a subset of the tree, and a custom rule's evidence is
the whole tree, so every declared rule answers `not_applicable` there — before
any artifact is read, the same needs-a-full-run posture `coverage-minimum`
takes ([../concepts/fitness-functions.md](../concepts/fitness-functions.md)).
Reported on every face, counted toward neither exit lane.

## Where the verdicts land

Text renders each rule's verdict with its declared reason and its findings as
`file:line:column` lines, then a summary beside the fitness line; the SARIF
log gains one reportingDescriptor per catalogue entry (appended after every
fixed id, so no existing `ruleIndex` moves) with unjudged rules surfacing as
notifications rather than silence; the JSON envelope gains the additive
`result.customRules` section [json-output.md](json-output.md) documents.

## Writing a rule

Three SDKs ship from this repository, each in its own package with the README
that owns its build story and declared limits, and each proven by a committed
reference artifact driven through this very host:

- **Rust** — crate `lattice-rule-sdk`, `packages/lattice-rule-sdk-rust`: a
  typed `lattice_rule!` declaration generates the exports above, a hollow
  verdict is unrepresentable, and a malformed declaration fails at compile
  time. Built with `wasm32-unknown-unknown`.
- **Go** — module `github.com/ecoma-io/lattice/packages/lattice-rule-sdk-go`:
  the same typed surface with `Register` from `init`, zero dependencies
  (`encoding/json` is the stdlib's). Built with TinyGo's freestanding target —
  standard Go's wasm targets import a host and are refused at load, a measured
  fact that package's README carries.
- **TypeScript syntax, AssemblyScript semantics** — npm package
  `@ecoma-io/lattice-rule-sdk`, `packages/lattice-rule-sdk-ts`: TS-syntax
  rules compiled by AssemblyScript to a zero-import module. AssemblyScript is
  not TypeScript's semantics — no `any`, no unions, no `try/catch`, no JS
  stdlib — and that package's README leads with exactly what differs.
- **Python** — PyPI distribution `lattice-rule-sdk`,
  `packages/lattice-rule-sdk-python`: the author writes pure Python, and the
  build tool bakes it into a Rust carrier embedding the RustPython
  interpreter, compiled to the same zero-import module (with fixed hash
  seeding — determinism as a feature). Two declared limits that package's
  README owns: building needs cargo on the author's machine, and RustPython's
  15-bit refcount on wasm32 puts a measured object ceiling on very large
  workspaces — past it the rule answers `unknown` naming the ceiling, never
  a trap.

Any toolchain that can emit a no-import core-wasm module implementing this
page is equally valid: the contract, not the SDK, is the interface.

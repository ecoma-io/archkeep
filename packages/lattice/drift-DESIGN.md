# Deterministic Architecture Drift Detection — Design

Status: implemented. The working spec for the
`feat: add deterministic architecture drift detection` change. The living
consumer-facing reference is `docs/usage/drift.md`, `docs/concepts/drift.md`,
and the intent schema notes in `src/drift/intent.mjs`; this file holds the
design rationale that shipped, including the one decision review changed.

## 1. What drift is

**Architecture drift** = the workspace's _observed_ architecture diverges from
its _declared intended_ architecture, where both sides are **facts computed by
this tool**, not opinions:

- **Observed** is the current project graph: projects, their tags, and the
  dependency edges between them (the same graph `graph`/`diff`/`check` already
  read, from any of the three providers).
- **Intended** is a declarative contract written by the workspace: an
  `architecture-intent.config.mjs` (which projects must/must not exist, which
  edges are permitted or forbidden, which project→tag assignments are
  required). The intent is not derived — it is the workspace's own law,
  authored once.

**The relationship to the existing `intent-manifest.json`** must be stated to
avoid confusion. `src/intent/intent-manifest.json` is _this repository's_
evidence manifest — a record of lattice's own v1.0 contracts and the tests
that prove them. It is metadata about the tool, not a workspace-declarable
architecture. Drift's "intent" is a _consumer-facing input_: per-workspace,
declarative, checked by the engine. They share a word, not a mechanism. The
new contract is a separate concept.

**Drift is a verdict, not a prediction.** The roadmap floats _predictive_
drift under 2.x. Deterministic drift is the 1.x half: it reports _facts about
the current tree vs. a declared contract_. A prediction is allowed to be
wrong; a verdict is not (`AGENTS.md`'s empty-result invariant). No LLM, no
probabilistic reasoning — every finding names the intent row and the observed
fact that violates it.

### What is NOT drift

The task forbids turning subjective opinion into drift and demands an
"inability to establish drift" class. Precisely:

- **A normal source change is not drift.** Changing an implementation file
  that touches no edge and no project/tag is not drift. (It may be a boundary
  violation under `check` — different verdict, different command.)
- **An intentional architecture change is not drift unless it contradicts an
  authored intent row.** If the workspace intends `A may depend on B` and
  someone deletes that row from the intent while making the change, the engine
  cannot call the new state "drift" — the intent no longer says A→B. Deleting
  the row is a _contract change_, reported as such by the engine's
  intent-fingerprint (below), not a violation of a row that no longer exists.
- **A policy violation is not drift.** `check` is the authority on boundary
  violations. Drift's responsibility is the _declared-intent_ contract. A
  drift finding is orthogonal to whether `check` also finds a violation.
- **An inability to establish drift is not drift.** If the observed side is
  incomplete (any file unanalyzed — `notAnalyzed` non-empty), the run
  _fails closed_ (exit 3), exactly like `diff` refusing an incomplete baseline
  or head. No verdict, loudly. An empty drift list must mean "no drift",
  nothing else.

## 2. The intent contract (consumer-facing schema)

`architecture-intent.config.mjs` at the workspace root (name configured via
the existing options seam — see §7). A plain-ESM module that default-exports
an object validated by the engine:

```js
export default {
  projects: {
    required: [
      // A project that must exist, with the tags it must carry.
      { name: "core", tags: ["layer:domain"] },
    ],
    forbidden: [
      // A project that must not exist.
      { name: "legacy" },
    ],
  },
  dependencies: {
    allowed: [
      // Exactly these project→project edges may exist.
      { source: "app", target: "core" },
    ],
    forbidden: [
      // These edges must not exist (the actionable half — no enforcement of
      // "must exist" over the npm/circular/lazy constraints, see §3).
      { source: "core", target: "app" },
      { source: "lattice", target: "lattice-vscode" },
    ],
  },
  tags: {
    // A project carrying this tag must not depend on a project of that tag.
    forbid: [{ from: "layer:adapter", to: "layer:domain" }],
  },
};
```

Validation rules (each violation of the _config shape_ → exit 3, loudly,
naming the row — a malformed intent that silently matched nothing is the
silent direction):

- top-level keys must be exactly `projects`, `dependencies`, `tags` (or the
  section may be omitted entirely);
- `projects.required[].name` non-empty string, `tags` optional string array;
- `projects.forbidden[].name` non-empty string;
- `dependencies.allowed/forbidden[].source|target` non-empty strings;
- `tags.forbid[]` requires both `from` and `to` non-empty strings.

## 3. The finding taxonomy (drift message ids)

Eight deterministic finding kinds. Message id, what it means, and the observed
fact that triggers it:

| id                       | meaning                                                     | trigger (observed vs. intended)                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectMissing`         | a required project is absent                                | every `projects.required[i]` whose `name` is not a graph project                                                                                                           |
| `projectPresent`         | a forbidden project exists                                  | every `projects.forbidden[i]` whose `name` IS a graph project                                                                                                              |
| `projectTagMissing`      | a required project lacks a required tag                     | for each required project present, each required tag not in its observed tags                                                                                              |
| `dependencyForbidden`    | an edge exists that the intent forbids                      | every observed edge matching a `dependencies.forbidden[i]` (source/target only — `type` is deliberately ignored, see §4)                                                   |
| `dependencyNotAllowed`   | an edge exists that the intent does not allow               | every observed edge **not** matching any `dependencies.allowed[i]` **and** not matching a `dependencies.forbidden[i]`, when `dependencies.allowed` is non-empty            |
| `tagDependencyForbidden` | a tag-forbidden dependency exists                           | every observed edge whose source carries `from` and target carries `to` (matching a `tags.forbid[i]`) and that is not already `dependencyForbidden`/`dependencyNotAllowed` |
| `intentUnknownProject`   | an intent row names a project the graph does not know       | every allowed/forbidden edge row, and every `tags.forbid` row, whose source/target names no graph project                                                                  |
| `intentUnknownTag`       | a `tags.forbid` row names a tag no observed project carries | every `tags.forbid[i]` whose `from` or `to` appears on no observed project                                                                                                 |

`intentUnknownTag` is the tag-side twin of `intentUnknownProject`: a rule the
tags can never fire on is an intent that cannot be satisfied, and the engine
must say so rather than report "no drift" forever. It is a finding (the tag
row is demonstrably dead), not a config error (the row parsed fine), and it is
deduplicated per row like `intentUnknownProject` is per project name.

`intentUnknownProject` exists so a typo'd project name fails _loudly_: if the
workspace intends `{source:"app", target:"core"}` but the project is named
`apps`, the intent can never be satisfied, and the engine must say the intent
names an unknown project rather than silently report "no drift". This is the
"malformed intent" requirement made visible. It is a finding (the intent is
demonstrably wrong), not a config error (the config parsed fine).

**Edge identity uses `(source, target)` only, ignoring `type`.** Observed
edges carry `{source,target,type}` and the graph splits a static-vs-dynamic
change into added+removed. For drift, `static` vs `dynamic` is an
implementation detail; the _existence_ of a dependency is the architectural
fact. So drift treats `A → B (static)` and `A → B (dynamic)` as the same edge,
deduplicated, and never as two findings. Determinism: edges and rows are
ordered by plain string comparison, never `localeCompare`.

## 4. Interaction with the intent fingerprint

An "intentional architecture change" must not be misreported as drift. When
the intent file itself changes, the engine computes a **canonical SHA-256
fingerprint** of the parsed intent (same canonicalization as
`computePolicyFingerprint`, key-sorted at every depth), and the drift output
carries `intent = { fingerprint }`. A consumer can compare two runs' intent
fingerprints to know whether the _contract_ changed between them — the `diff`
story, served once, reusing the existing canonicalization.

We do **not** keep a baseline intent file and auto-detect changes to it; that
is `diff`'s job and would be a second mechanism. The fingerprint is
_directional_: it lets a consumer tell "the tree drifted" from "the contract
changed".

## 5. Exit codes and JSON envelope

The JSON envelope's `EXIT_CODE_FOR_STATUS` map is public and fixed:
`{ok:0, findings:1, 'no-verdict':3}`. The CLI doctrine in `packages/lattice/CLAUDE.md`
is: _only `check` exits 1_; a verb that "finds something reports it without
claiming the boundary-violation exit code." Resolving the tension against the
task's requirement that drift findings be actionable and non-silent:

**Drift findings are surfaced two ways:**

1. **A new descriptive `drift` command** (like `diff`): prints the observed
   intent, the findings, and the intent fingerprint. It is descriptive: it
   exits **0** when it completes (even with findings — a description is never a
   finding; only `check` exits 1). It exits **3** when it cannot establish
   drift (malformed intent config, unreadable config, incomplete coverage —
   `notAnalyzed` non-empty, unregistered-plugin refusal on an Nx tree, config
   that failed to load). `drift --format json` emits the same envelope every
   descriptive command does, `status: "ok"`, and the findings under
   `result.drift.findings`. This keeps `drift` honest with the doctrine and
   consistent with `diff`.

2. **Folding into `check` by presence, not by flag.** When the workspace has an
   _intent file at the configured name_, `check` loads it and counts drift
   findings into its verdict, so a CI run fails (exit 1) on drift exactly as it
   fails on go.work drift. The counts are added to the verdict like
   `goWorkDrift`/`tsconfigPathsDead`, drift findings render as a section in the
   text report and as SARIF results under their own rule ids
   (`docs/reference/violations.md`-style), and the JSON envelope carries
   `result.drift = { checked, intent, observed, findings }` (null when no
   intent file exists — same "no manifest, no claim" rule `goWork` follows).

   **There is no `--drift` flag.** Review resolved the provisional decision:
   an opt-in flag would make a forgotten flag byte-identical to "no drift
   checked" — the silent direction the empty-result invariant exists to end. A
   workspace without an intent file pays nothing and hears nothing
   (`check` is byte-identical to before the feature), and since the intent
   schema ships with this feature, no pre-existing workspace can carry an
   intent file that an upgrade would suddenly start judging — so presence
   breaks no workspace while closing the "forgot the flag" hole. A malformed
   intent is a whole-file failure: `check` exits 3 and names the file, exactly
   like a `go.work` this tool cannot read.

   **Provisional decision — validated in review, resolved by it.** The draft
   proposed `--drift` as an opt-in flag; the review attacked (a) whether
   `--drift` was too easy to forget (invented-vs-claimed coverage) and (b)
   whether it should default-on when an intent file exists. Both attacks landed
   the same way: (a) is the exact defect the invariant forbids, and (b) is
   presence-keying. The flag was removed and presence became the trigger.

## 6. Fail-closed requirements

Every path that cannot reach a drift verdict says so, loudly:

- **Malformed intent config** → throw → `drift` exits 3, `check` exits
  3 (whole-file failure), naming the row.
- **Unreadable intent config** → same (3).
- **Incomplete observed coverage** (`notAnalyzed` non-empty) → `drift` exits 3
  / `check` exits 3 (a whole-file failure withholding the verdict). Every
  "project missing" or "edge missing" would be ambiguous between "gone" and
  "never seen".
- **Unregistered Nx plugin + polyglot manifests** → refuse like `graph`/`diff`
  (the head graph would silently under-represent the architecture).
- **Empty finding list** must mean exactly "the observed architecture matches
  the intended one".

## 7. Integration seams

- **New `drift` command row** in `cli.mjs` `COMMANDS`, mirroring `diff`'s row:
  `args: ""`, `formats: DESCRIBABLE_FORMATS`, defaults
  `{ format:"text", output:null }` (no `--config` — the intent always comes
  from the workspace's own `intentConfig`, never from a path, so a `--config`
  flag would be a second filename seam that can contradict the first).
  `DRIFT_FLAG_HELP` holds the shared `format`/`output` pair. `runDrift`
  mirrors `runDiff`: resolve context, load the intent, compute, render,
  get exit 0; throws → exit 3.
- **Intent loading** in a new `src/drift/` layer: `src/drift/intent.mjs`
  (validate + `loadIntent`), `src/drift/drift.mjs` (pure `computeDrift`
  comparing observed graph vs. intent — facts as arguments, no filesystem, so
  unit-tested like `compareGoWork`), `src/drift/drift-text.mjs` (report),
  `src/drift/intent-fingerprint.mjs` (canonical SHA-256, reusing
  `computePolicyFingerprint`'s canonicalize approach — verify whether that
  function is exported/reusable or the canonicalizer needs a shared home).
- **Intent filename option**: a new `intentConfig` key in `src/options.mjs`
  `DEFAULT_OPTIONS` and `resolveOptions` (default
  `architecture-intent.config.mjs`), so Nx/Moon/native announce it via the
  existing seam. This is a breaking-ish surface addition to options (unknown
  option now throws) — but adding a _recognised_ option is not a breaking
  change. Native `lattice.json` gets an `intentConfig` key added to
  `TOP_LEVEL_KEYS` (+ `findNativeModelViolations` validation) mirroring
  `boundaryConfig`/`tsConfig`.
- **The analysis of observed vs. intended stays provider-independent**: drift
  reads only the resolved `CommandContext` (graph + coverage), never a
  provider. Same semantics on Nx / Moon / native.
- **Index exports**: `src/drift/*` exports ride through `index.mjs` (the
  engine entry) the same way `config.mjs`/`rules` do, for the future
  integrations that import the engine. The `nx.mjs` face stays a re-export.

## 8. Dogfooding

The task requires a _meaningful_ drift check for Lattice itself. This repo's
own graph is nearly empty (no static cross-project imports — `lattice-vscode`
resolves the server at runtime), so a meaningful intent asserts the _real_
structure rather than edges that do not exist:

```js
export default {
  projects: {
    required: [
      { name: "lattice", tags: ["type-package", "scope-nx"] },
      { name: "lattice-vscode", tags: ["type-extension", "scope-nx"] },
    ],
  },
  dependencies: {
    forbidden: [
      // The type axis forbids a package depending on an extension.
      { source: "lattice", target: "lattice-vscode" },
    ],
  },
};
```

`forbidden` is the actionable half (no false positives, matches real intent);
`required` pins that the two projects and their type-axis tags exist. Run in
CI's `moon run` step (and `drift --format json` to prove the envelope). This
fails loud if someone adds `lattice → lattice-vscode` or re-tags a package
away from `type-package`.

## 9. Deterministic ordering and stable output

- Findings sorted by (messageId, then the row name / source / target / required
  index as a string) using plain string comparison — never `localeCompare`,
  never `Date.now`, never `Math.random` (`Contract K`'s invariants).
- The text report renders groups the way `diff-text.mjs` does: a section per
  message id, printed only when non-empty, always ending with a count; the
  summary names "no drift" (a claim about a complete comparison) vs. "n drift
  finding(s)".
- JSON output is byte-stable for two runs over an unchanged tree and intent
  (extend `e2e/determinism.e2e.mjs` to cover `drift`).

## 10. Test plan (mapped to the task's scenarios)

Unit (`src/drift/*.test.mjs`):

- no drift (observed satisfies intent exactly) → 0 findings;
- intended change (intent row deleted → fingerprint changes, no false finding
  for the deleted row);
- forbidden dependency present → `dependencyForbidden`;
- new project not in intent → `intentUnknownProject` only if an intent row
  references its name; a present-but-unreferenced project is NOT drift;
- removed required project → `projectMissing`;
- changed boundary (a required project loses a required tag) →
  `projectTagMissing`; a project whose tags changed but still satisfies the
  intent → no finding;
- multiple simultaneous drifts → all reported, deterministically ordered;
- false-positive cases: an edge existing that is `allowed` (present in
  `dependencies.allowed`) is not a finding; no `dependencies.allowed` section
  → only `forbidden`/`tagDependencyForbidden` fire (so apps can write only
  forbidden rules without every unlisted project pair becoming drift);
- incomplete analysis → throws (fail-closed);
- malformed intent config → throws naming the row (each shape rule);
- snapshot/diff interplay: drift against an observed graph is unchanged by
  whether the tree was captured fresh or re-read; drift does not depend on a
  baseline file;
- deterministic ordering + byte-stable JSON;
- exit codes: `drift` 0 on findings, 3 on no-verdict; `check` (with an intent
  file present) 1 on findings, 3 on a malformed intent, 0 clean — and
  byte-identical to pre-feature when no intent file exists.
- provider independence: same intent + graph model shape → same findings for
  nx/moon/native (already covered by the shared `CommandContext`; assert the
  drift layer imports no provider).

E2E (`e2e/drift.e2e.mjs`): a real native consumer (`createNativeConsumer`,
which carries `lattice.json` with `core`/`app`), plus a new fixture wiring an
intent, then:

- no-drift consumer → `drift` exit 0, "no drift";
- forbidden-edge consumer (reuse `CORE_REACHES_APP` → `core→app`) with an
  intent forbidding `core→app` → `drift` reports `dependencyForbidden`
  (exit 0) and `check` (intent present) exits 1;
- malformed intent → exit 3;
- JSON envelope shape (command `drift`, status ok, result.drift);
- language coverage: reuse `createNativeLanguageConsumer` for go / typescript
  / javascript / vue / rust / python where the intent is language-agnostic
  (projects + a forbidden edge), asserting at least one language across the
  drift findings map to real edges.

Dogfood gate: `node packages/lattice/cli.mjs check` on this repo's tree in CI
— the root `architecture-intent.config.mjs` exists, so `check` folds drift in
by presence, and the existing `check` CI step becomes the drift gate with no
yaml change (its native-selfcheck exempt glob already covers the `.mjs` guard
file). `node packages/lattice/cli.mjs drift` proves the descriptive face.

## 11. Explicit non-goals (so review can check they hold)

- No predictive drift (that is 2.x roadmap).
- No LLM, no probabilistic reasoning.
- No separate graph engine — reuses the provider graph.
- `type` of an edge is ignored for drift identity.
- `projects.required[].tags` enforces tag _presence_, never forbids extra
  tags (extra tags are not drift).
- No "must exist" edge enforcement beyond what `dependencies.allowed` names:
  absence of an allowed edge is not a finding (`dependencies.allowed` states
  the permitted set; `forbidden` is what can actually be violated).
- The intent file is not a snapshot and not diffed against another file; the
  fingerprint is directional metadata only.

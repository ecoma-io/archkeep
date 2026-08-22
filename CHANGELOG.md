# Changelog

## [0.11.1](https://github.com/ecoma-io/lattice/compare/v0.11.0...v0.11.1) (2026-08-22)


### Bug Fixes

* **workspace:** register the marketplace the enabled plugin names ([#212](https://github.com/ecoma-io/lattice/issues/212)) ([1c0753f](https://github.com/ecoma-io/lattice/commit/1c0753f85b41de841157177871813b13ddf3bc70))

## [0.11.0](https://github.com/ecoma-io/lattice/compare/v0.10.1...v0.11.0) (2026-08-22)


### ⚠ BREAKING CHANGES

* **lattice:** refuse --evidence-out where nothing would write, and count three workspace checks ([#211](https://github.com/ecoma-io/lattice/issues/211))

### Bug Fixes

* **lattice:** refuse --evidence-out where nothing would write, and count three workspace checks ([#211](https://github.com/ecoma-io/lattice/issues/211)) ([c9e1ac3](https://github.com/ecoma-io/lattice/commit/c9e1ac3d2f221d2a4d8b19b863d5090f55078b5a))
* **workspace:** correct three stale skill claims and teach four shipped surfaces ([#209](https://github.com/ecoma-io/lattice/issues/209)) ([c3578fa](https://github.com/ecoma-io/lattice/commit/c3578fa65b358b6a73b55314b5a0025367f5a6fe))

## [0.10.1](https://github.com/ecoma-io/lattice/compare/v0.10.0...v0.10.1) (2026-08-22)


### Bug Fixes

* **ci:** reach every registry the 0.10.0 release was supposed to ([#208](https://github.com/ecoma-io/lattice/issues/208)) ([b8f657a](https://github.com/ecoma-io/lattice/commit/b8f657a6f544ff7a8ca0731813be13e8fb9edbf5))


### Documentation

* **workspace:** reconcile the documentation with what [#202](https://github.com/ecoma-io/lattice/issues/202) and [#204](https://github.com/ecoma-io/lattice/issues/204) shipped ([#205](https://github.com/ecoma-io/lattice/issues/205)) ([9ad3179](https://github.com/ecoma-io/lattice/commit/9ad31797d2329d37095fa7e5c3338c2161a2931c))

## [0.10.0](https://github.com/ecoma-io/lattice/compare/v0.9.0...v0.10.0) (2026-08-22)


### ⚠ BREAKING CHANGES

* **lattice:** a Rust file with a top-level `use { … }` group now reports one import record per arm, each resolving on its own, instead of one unresolvable record and one failure. A workspace whose CI was green over such a file can go red on a boundary its imports really cross. On ripgrep the change is 29 failures and 439 records becoming 0 failures and 482 records; the coverage lane's pinned counts move with it.
* **lattice:** add tag-axis-isolation, and the corpus that proved it was missing ([#201](https://github.com/ecoma-io/lattice/issues/201))

### Features

* **lattice:** add tag-axis-isolation, and the corpus that proved it was missing ([#201](https://github.com/ecoma-io/lattice/issues/201)) ([9f37cc0](https://github.com/ecoma-io/lattice/commit/9f37cc0e7a05a98bbb62971a68594b9c4e5904a9))
* **lattice:** custom architecture rules under one contract, with four SDKs ([#202](https://github.com/ecoma-io/lattice/issues/202)) ([91a7f08](https://github.com/ecoma-io/lattice/commit/91a7f08a20a7950a30597a52e3382894f627cef0))
* **lattice:** gate the promises 1.0 rests on ([#204](https://github.com/ecoma-io/lattice/issues/204)) ([5b9f7f9](https://github.com/ecoma-io/lattice/commit/5b9f7f9cdd6f8479e9eb142fb31dd4a47690420b))


### Documentation

* **workspace:** point AGENTS.md at rule owners and make package guidance host-neutral ([#199](https://github.com/ecoma-io/lattice/issues/199)) ([233ceb6](https://github.com/ecoma-io/lattice/commit/233ceb69966b4b126dd6faf4f9d0b5534a89ea7b))

## [0.9.0](https://github.com/ecoma-io/lattice/compare/v0.8.0...v0.9.0) (2026-08-21)


### ⚠ BREAKING CHANGES

* **lattice:** `drift` on a workspace that declares an architecture intent, declares no loadable boundary config, and whose intent rows carry no `decisionRef` now completes with exit 0 and a real verdict instead of exiting 3. No workspace that has a boundary config changes verdict, and no workspace whose intent cites anything changes exit code. The direction is a refusal lifting rather than a new finding appearing, so a consumer's CI turns green rather than red — but it is a change to what is reported on an unchanged workspace.
* **lattice:** read a Go import block whose opener follows a `;` ([#195](https://github.com/ecoma-io/lattice/issues/195))
* **lattice:** a workspace containing a `;`-opened Go import block now reports the imports inside it, so a boundary violation that was invisible can turn a previously green run red on unchanged sources.

### Features

* **lattice:** add report, one architecture governance document ([#192](https://github.com/ecoma-io/lattice/issues/192)) ([d9114a0](https://github.com/ecoma-io/lattice/commit/d9114a0963597d099ed2eb30728b31e1379bbac0))
* **lattice:** ship four architecture styles as policy packs ([#191](https://github.com/ecoma-io/lattice/issues/191)) ([cfa4981](https://github.com/ecoma-io/lattice/commit/cfa498182c7231bf2a2ed2c039f5d99c87055b4e))
* **workspace:** add the arch-migrate skill and the migration workflow guide ([#190](https://github.com/ecoma-io/lattice/issues/190)) ([2b8df8a](https://github.com/ecoma-io/lattice/commit/2b8df8af33d6d3fe763d935ce2495325d336abab))


### Bug Fixes

* **lattice:** classify upstream noise and scoped configs instead of failing the differential ([#189](https://github.com/ecoma-io/lattice/issues/189)) ([1993fa7](https://github.com/ecoma-io/lattice/commit/1993fa760c23a1a66536dced8ffeb1a8d4592780))
* **lattice:** lift drift's undocumented refusal and pin the governance surfaces ([#196](https://github.com/ecoma-io/lattice/issues/196)) ([a7486ec](https://github.com/ecoma-io/lattice/commit/a7486ecfb71ca0f9764c9ab6c487324a06240f9b))
* **lattice:** read a Go import block whose opener follows a `;` ([6b80844](https://github.com/ecoma-io/lattice/commit/6b80844b3d383d7854bff44f4610af19f82cb044))
* **lattice:** read a Go import block whose opener follows a `;` ([#195](https://github.com/ecoma-io/lattice/issues/195)) ([6b80844](https://github.com/ecoma-io/lattice/commit/6b80844b3d383d7854bff44f4610af19f82cb044))
* **workspace:** correct stale skill and host-doc claims, cover all providers ([#188](https://github.com/ecoma-io/lattice/issues/188)) ([0e47f6b](https://github.com/ecoma-io/lattice/commit/0e47f6b48b5fdc3908f1c822ad4948728771f61a))


### Documentation

* **docs:** reorganize docs into doctrine/ and slim the README to a landing page ([#186](https://github.com/ecoma-io/lattice/issues/186)) ([630a1ef](https://github.com/ecoma-io/lattice/commit/630a1ef6ac5446cf7347feaefb0570aeb9b4e005))
* **docs:** sync every page the six governance merges made stale ([#197](https://github.com/ecoma-io/lattice/issues/197)) ([151e5fd](https://github.com/ecoma-io/lattice/commit/151e5fdf03747519ca16e0537dd9ebab89c8c0f4))

## [0.8.0](https://github.com/ecoma-io/lattice/compare/v0.7.1...v0.8.0) (2026-08-20)


### ⚠ BREAKING CHANGES

* **lattice:** `check --format sarif` now emits results/notifications for fitness functions (new `fitnessFunctionFailed` rule id); `diff`/`drift` text reports now append `coverage.notes`/`verdict.notes` to their summary line when present; a `history --output` path that resolves into the history directory via `..` is now refused (exit 2) instead of silently accepted; a `check` no-verdict run's `decision.reason` may now name more than one cause; and `check --output`'s stderr summary may now mention fitness counts it previously omitted. Each of these changes reported output on a workspace that already carried the underlying condition — no previously-clean workspace is affected.
* **lattice:** on an unchanged workspace, a Rust file with two or more `use` statements sharing one line, or a same-line attribute whose own content holds a bracketed string, now reports every crossing instead of silently dropping the later one(s) — a consumer's `bannedExternalImports`/boundary check can newly flag an import it missed before. A workspace where a project sits at the Cargo workspace root — spelled either `""` or Nx's own `"."` — now gets graph edges into and out of that project (both directions) that were previously silently absent, which can newly surface `nx affected`/boundary findings for that project. A `.rs` file with a same-line attribute containing many `"` characters and no closing `]` no longer causes catastrophic backtracking in the CLI or language server.
* **lattice:** an unchanged Python workspace can now report imports and manifest edges it previously missed — a multi-line `from x import (...)` group with a `#` comment before its closing paren, `from .import x` / `from ..import y`, a uv array-of-sources dependency, a root project's own declared dependencies, and a `path`-form uv source that names the workspace root. A consumer relying on the prior (silent) output will see new findings on code they did not touch.
* **lattice:** on an unchanged workspace, `reconcile --propose` can now emit `tag-change` candidates for a required project missing a required tag (previously silently omitted, since `buildRankedCandidates` never scanned `scores.tags`). `reconcile` and `drift` can now report a boundary divergence (`intentForbiddenEdge`/`intentAllowedMissing`) that previously silently scored `match` when its `(boundaryFrom, boundaryTo)` pair collided, under naive string concatenation, with another row's pair. `debt`'s JSON and text output no longer serialize `byKind["expired-waiver"]` as `null` for a workspace carrying an expired waiver — it now reports the correct integer count. A consumer's CI or saved baseline for any of these three commands can turn red on a workspace it did not otherwise change.
* **lattice:** name malformed fitness shapes and stop silently dropping ESLint scope ([#177](https://github.com/ecoma-io/lattice/issues/177))
* **lattice:** stop the Moon provider from doubling an implicit edge as static ([#176](https://github.com/ecoma-io/lattice/issues/176))
* **lattice:** on an unchanged Moon workspace, a project dependency that Moon marks implicit (and that also appears in `raw.graph.edges`, the common case) now reports as exactly one `implicit` edge instead of two edges (one `implicit`, one `static`/`dynamic`). `drift`, `discover`, and `check`'s edge-constraint exclusion — everything keying off `edge.type === "implicit"` — now correctly excludes it; previously the phantom `static`/`dynamic` duplicate made it look like a real, code-derived dependency.
* **lattice:** read Go imports and root-module edges the analyzer silently dropped
* **lattice:** the Go dependency graph now reports imports and root-module edges it previously dropped; a consumer's `nx affected`/boundary output may change on unchanged code.
* **lattice:** close three silent-stale gaps in the language server
* **lattice:** an editor session against an unchanged workspace can now report differently in three cases: (1) editing a boundaryConfig whose path has directory components triggers re-diagnosis where it previously did not; (2) a didChange batch mixing a full change with a trailing ranged edit now publishes a loud analysisFailure diagnostic instead of a (possibly wrong) analyzed:true verdict; (3) a workspace root with a filesystem-present but git-untracked lattice.json is now analyzed through the native provider instead of yielding an empty, falsely-clean index.

### Bug Fixes

* **ci:** gate the App token on env, not on secrets, and unbreak the lane ([#172](https://github.com/ecoma-io/lattice/issues/172)) ([e3bf21e](https://github.com/ecoma-io/lattice/commit/e3bf21ef6933ce8a792f66378a72ba76f3777117))
* **lattice:** close five silent check/history/report gaps ([#184](https://github.com/ecoma-io/lattice/issues/184)) ([6cf4a66](https://github.com/ecoma-io/lattice/commit/6cf4a66be874a16942c8c8494525ddc88a4c52c0))
* **lattice:** close five silent false negatives in intent masking and governance reconciliation ([#180](https://github.com/ecoma-io/lattice/issues/180)) ([675ae53](https://github.com/ecoma-io/lattice/commit/675ae53b17307c647e607df099968781e2f9e068))
* **lattice:** close five silent false negatives in the Python resolver ([#182](https://github.com/ecoma-io/lattice/issues/182)) ([25a349b](https://github.com/ecoma-io/lattice/commit/25a349b115b9299e2bde0fa0f20ee9e4941b2957))
* **lattice:** close three silent-stale gaps in the language server ([168b64c](https://github.com/ecoma-io/lattice/commit/168b64ce47bf83dde22458dd2170ea150d0ab444))
* **lattice:** close three silent-stale gaps in the language server ([168b64c](https://github.com/ecoma-io/lattice/commit/168b64ce47bf83dde22458dd2170ea150d0ab444))
* **lattice:** close two silent gaps in the conformance harness ([#185](https://github.com/ecoma-io/lattice/issues/185)) ([113663c](https://github.com/ecoma-io/lattice/commit/113663c1896879834c96731da1ce6d59355c4051))
* **lattice:** count minimatch brace ranges and stop __proto__ vanishing in canonical JSON ([#178](https://github.com/ecoma-io/lattice/issues/178)) ([ddc5ce7](https://github.com/ecoma-io/lattice/commit/ddc5ce78dff1d27cff354fdeaa33879db91e0e06))
* **lattice:** name malformed fitness shapes and stop silently dropping ESLint scope ([16f2f98](https://github.com/ecoma-io/lattice/commit/16f2f98ca457f1e800ba760f04ffd0ffa6de926d))
* **lattice:** name malformed fitness shapes and stop silently dropping ESLint scope ([#177](https://github.com/ecoma-io/lattice/issues/177)) ([16f2f98](https://github.com/ecoma-io/lattice/commit/16f2f98ca457f1e800ba760f04ffd0ffa6de926d))
* **lattice:** read Go imports and root-module edges the analyzer silently dropped ([b76b388](https://github.com/ecoma-io/lattice/commit/b76b3883db6508b847ff8e05ceeeb7c374dd32fd))
* **lattice:** read Go imports and root-module edges the analyzer silently dropped ([b76b388](https://github.com/ecoma-io/lattice/commit/b76b3883db6508b847ff8e05ceeeb7c374dd32fd))
* **lattice:** stop silently dropping same-line and root-project Rust edges ([#183](https://github.com/ecoma-io/lattice/issues/183)) ([30eb3b7](https://github.com/ecoma-io/lattice/commit/30eb3b78ae152cc76e5355b76a65da2f4cb3404f))
* **lattice:** stop the Moon provider from doubling an implicit edge as static ([61b894d](https://github.com/ecoma-io/lattice/commit/61b894d5e315afca674053bc9283ee9d0040652a))
* **lattice:** stop the Moon provider from doubling an implicit edge as static ([#176](https://github.com/ecoma-io/lattice/issues/176)) ([61b894d](https://github.com/ecoma-io/lattice/commit/61b894d5e315afca674053bc9283ee9d0040652a))
* **workspace:** close five silent gaps in the gate scripts' parsing ([#181](https://github.com/ecoma-io/lattice/issues/181)) ([49181ba](https://github.com/ecoma-io/lattice/commit/49181ba2aa2abbc44ee406892fcf67222d90dd1d))
* **workspace:** stop editor gates from self-disabling and mis-reporting ([#179](https://github.com/ecoma-io/lattice/issues/179)) ([08827c0](https://github.com/ecoma-io/lattice/commit/08827c03bff3ab82f569e19f3dbc392034d44878))

## [0.7.1](https://github.com/ecoma-io/lattice/compare/v0.7.0...v0.7.1) (2026-08-19)


### Documentation

* **docs:** name the manual approval every release lane run needs ([#169](https://github.com/ecoma-io/lattice/issues/169)) ([8cfec9f](https://github.com/ecoma-io/lattice/commit/8cfec9f59a6da28468e8379430df431ea0aa0cf8))

## [0.7.0](https://github.com/ecoma-io/lattice/compare/v0.6.3...v0.7.0) (2026-08-19)


### Features

* **lattice:** read an inline lattice.json policy from the language server ([#167](https://github.com/ecoma-io/lattice/issues/167)) ([f2b699e](https://github.com/ecoma-io/lattice/commit/f2b699e07254e5aebc1385999ef7dce3c4b847fe))

## [0.6.3](https://github.com/ecoma-io/lattice/compare/v0.6.2...v0.6.3) (2026-08-19)


### Bug Fixes

* **lattice:** count unresolvable declared-project imports as no-verdict ([#165](https://github.com/ecoma-io/lattice/issues/165)) ([98b7070](https://github.com/ecoma-io/lattice/commit/98b7070915db5a3cc10aeaeb6cb367cd23f5aa96))
* **workspace:** make the differential label reconcile idempotent ([#163](https://github.com/ecoma-io/lattice/issues/163)) ([297f97e](https://github.com/ecoma-io/lattice/commit/297f97e842040235f672bee8a168a10b946ff5af))


### Documentation

* **workspace:** make the Quick start a working, verifiable walk-through ([#164](https://github.com/ecoma-io/lattice/issues/164)) ([8444509](https://github.com/ecoma-io/lattice/commit/84445090a02130d9c6093465753cba9abfdae895))

## [0.6.2](https://github.com/ecoma-io/lattice/compare/v0.6.1...v0.6.2) (2026-08-19)


### Bug Fixes

* **lattice:** stabilize the public API surface for v0.7.0 ([#161](https://github.com/ecoma-io/lattice/issues/161)) ([01f39ff](https://github.com/ecoma-io/lattice/commit/01f39ff4dd0e2115c08aff81fb8795a193f5b3fd))

## [0.6.1](https://github.com/ecoma-io/lattice/compare/v0.6.0...v0.6.1) (2026-08-19)


### Bug Fixes

* **lattice:** derive declared targets in the real-tree native model ([#159](https://github.com/ecoma-io/lattice/issues/159)) ([b8f7ec3](https://github.com/ecoma-io/lattice/commit/b8f7ec366863be7cc1baaec842bf59dd42e646c7))

## [0.6.0](https://github.com/ecoma-io/lattice/compare/v0.5.0...v0.6.0) (2026-08-19)


### ⚠ BREAKING CHANGES

* **lattice:** a workspace dependency inherited under a local alias now resolves its import records to the renamed project, where it previously resolved to an external crate. A consumer whose boundary config forbade that crossing will start seeing it.

### Bug Fixes

* **ci:** fail e2e:smoke on zero tests and sort check violations ([#147](https://github.com/ecoma-io/lattice/issues/147)) ([c9ca5db](https://github.com/ecoma-io/lattice/commit/c9ca5dbb3beed6ccae7afef3cf227794f7c867a0))
* **lattice:** exempt workspace-root edges from the native graph ([#156](https://github.com/ecoma-io/lattice/issues/156)) ([5e751dd](https://github.com/ecoma-io/lattice/commit/5e751dda2bc046e19fd0224ad3a86f2ca3a0a0df))
* **lattice:** lsp verdict parity + durable refusal ([#151](https://github.com/ecoma-io/lattice/issues/151)) ([c4277b6](https://github.com/ecoma-io/lattice/commit/c4277b6466319825b4cf3e447ef27fa196cc01aa))
* **lattice:** make config dialect, buildTargets and $schema refusals loud ([#155](https://github.com/ecoma-io/lattice/issues/155)) ([452eea0](https://github.com/ecoma-io/lattice/commit/452eea07c6b364f9248a5269c94893e78be37242))
* **lattice:** make LSP project-name maps prototype-safe and cap Content-Length ([#146](https://github.com/ecoma-io/lattice/issues/146)) ([8a0a39f](https://github.com/ecoma-io/lattice/commit/8a0a39f156f7c2d998b0229016b0d5dba8584f05))
* **lattice:** read every paren-joined and boundary-adjacent import aloud ([#150](https://github.com/ecoma-io/lattice/issues/150)) ([a0369f3](https://github.com/ecoma-io/lattice/commit/a0369f39e4435b4dd4ff1ac5e75c2b8706502685))
* **lattice:** recursive determinism source guard + deterministic capture envelope ([#154](https://github.com/ecoma-io/lattice/issues/154)) ([c7119fc](https://github.com/ecoma-io/lattice/commit/c7119fc0665922ba313edb2376db3657a3fa78d2))
* **lattice:** resolve and contain every tree-derived read and write path (G-02, G-06, G-07, G-10) ([#157](https://github.com/ecoma-io/lattice/issues/157)) ([1c6669d](https://github.com/ecoma-io/lattice/commit/1c6669d96e739d81b60da5a6024c55155e6ef316))
* **lattice:** surface unresolved decisionRefs and gate verdicts (R6 F01-F07, D-09, D-10, D-12) ([#158](https://github.com/ecoma-io/lattice/issues/158)) ([fcf47de](https://github.com/ecoma-io/lattice/commit/fcf47dec107b3c1d212b6e0ef650d97d3e126d3f))


### Documentation

* correct skill truth to post-[#139](https://github.com/ecoma-io/lattice/issues/139) behavior ([#144](https://github.com/ecoma-io/lattice/issues/144)) ([38e2b3b](https://github.com/ecoma-io/lattice/commit/38e2b3be167584a1e8be257a98010252a2c13eef))

## [0.5.0](https://github.com/ecoma-io/lattice/compare/v0.4.0...v0.5.0) (2026-08-18)


### Features

* add architecture evolution history ([#87](https://github.com/ecoma-io/lattice/issues/87)) ([a552c13](https://github.com/ecoma-io/lattice/commit/a552c13f3835400bff87e2ca83d9dfca7cf6c91c))
* add architecture intent governance ([#88](https://github.com/ecoma-io/lattice/issues/88)) ([037ded6](https://github.com/ecoma-io/lattice/commit/037ded61dc42df35df98024c70b04a075fa8ea09))
* **lattice:** add arch-* agent architecture skills and Claude Code integration ([#73](https://github.com/ecoma-io/lattice/issues/73)) ([32747cf](https://github.com/ecoma-io/lattice/commit/32747cff19dceb9da7fe42fe3e15588d103a1c79))
* **lattice:** add the architecture-debt ledger across snapshots ([001b2e8](https://github.com/ecoma-io/lattice/commit/001b2e8c959145bd7cc3661a57c23f9eca753352))
* **lattice:** adr registry binding — lint markdown decisions (a7) ([#101](https://github.com/ecoma-io/lattice/issues/101)) ([6b0b923](https://github.com/ecoma-io/lattice/commit/6b0b9231a652c207ee50c3ecd6b75e06f6a58fd8))
* **lattice:** agent architecture planning context consuming canonical intent ([#92](https://github.com/ecoma-io/lattice/issues/92)) ([17ca9f6](https://github.com/ecoma-io/lattice/commit/17ca9f6a5170358716ec17924f4cbe6c0e283a7a))
* **lattice:** architecture debt ledger across snapshots (A5) ([#98](https://github.com/ecoma-io/lattice/issues/98)) ([001b2e8](https://github.com/ecoma-io/lattice/commit/001b2e8c959145bd7cc3661a57c23f9eca753352))
* **lattice:** architecture discovery — observed facts + propose-only candidates (A9) ([#100](https://github.com/ecoma-io/lattice/issues/100)) ([4edcae6](https://github.com/ecoma-io/lattice/commit/4edcae65ca3d07fc3d2260f0939d469b45788601))
* **lattice:** architecture evidence format — canonical verdict + decision envelope (E0 trunk) ([#93](https://github.com/ecoma-io/lattice/issues/93)) ([2958f9a](https://github.com/ecoma-io/lattice/commit/2958f9a502b908ff9402a8cc45ec7e37cf5607a3))
* **lattice:** architecture health — per-metric verdicts, never a fabricated zero (A4) ([#97](https://github.com/ecoma-io/lattice/issues/97)) ([b2d5b6b](https://github.com/ecoma-io/lattice/commit/b2d5b6bbb56655bdc595d80e97cc8560425d0e11))
* **lattice:** architecture provenance — governance row schema + attestation command (A3) ([#94](https://github.com/ecoma-io/lattice/issues/94)) ([306ee71](https://github.com/ecoma-io/lattice/commit/306ee71ed62ebf0783c1aa9058a0f31ae8b12522))
* **lattice:** architecture waivers — term-bound suppressions, always listed (A2) ([#96](https://github.com/ecoma-io/lattice/issues/96)) ([5d1e076](https://github.com/ecoma-io/lattice/commit/5d1e0766a79aa6633b1afd6cc131f2d7545e6792))
* **lattice:** fitness functions — named quality gates folded into check (A1) ([#95](https://github.com/ecoma-io/lattice/issues/95)) ([cf30199](https://github.com/ecoma-io/lattice/commit/cf301999cadd84492083e0281e948bfadc7702f7))
* **lattice:** model↔reality reconciliation — ranked, propose-only (A8) ([#99](https://github.com/ecoma-io/lattice/issues/99)) ([eb8b76f](https://github.com/ecoma-io/lattice/commit/eb8b76fc54511154894f95af517aa18a3371b7c4))
* **lattice:** named law profiles — enforce a policy by name (a6) ([#102](https://github.com/ecoma-io/lattice/issues/102)) ([5d17fb5](https://github.com/ecoma-io/lattice/commit/5d17fb50a1c48915fa34e5e0c6d22771a00e1ed9))
* **lattice:** reconcile the declared intent against the observed architecture ([eb8b76f](https://github.com/ecoma-io/lattice/commit/eb8b76fc54511154894f95af517aa18a3371b7c4))
* **lattice:** rework architecture-drift onto the canonical intent (replaces [#89](https://github.com/ecoma-io/lattice/issues/89)) ([#90](https://github.com/ecoma-io/lattice/issues/90)) ([4a155ae](https://github.com/ecoma-io/lattice/commit/4a155ae44054d03015d0817dd89975e86a212680))
* **workspace:** run the same editor gates in opencode and Codex ([#83](https://github.com/ecoma-io/lattice/issues/83)) ([8132f0b](https://github.com/ecoma-io/lattice/commit/8132f0bb3d4c907b6b45afd50b80d33ee2a57194))
* **workspace:** ship the VS Code extension on the repository's single version ([#74](https://github.com/ecoma-io/lattice/issues/74)) ([bb34e82](https://github.com/ecoma-io/lattice/commit/bb34e82849ae1a1c1c52a1bda14e12dc903f80d2))


### Bug Fixes

* **ci:** make the infra-red publish waiver reachable (P1-15) ([#132](https://github.com/ecoma-io/lattice/issues/132)) ([9df0b4a](https://github.com/ecoma-io/lattice/commit/9df0b4a265e87dc0873ceccbaf190a459a380d0e))
* **ci:** sign the release lane's reformat commit ([#143](https://github.com/ecoma-io/lattice/issues/143)) ([3122ae0](https://github.com/ecoma-io/lattice/commit/3122ae0885bf129cbcb4c73672445b889aa7ae68))
* **docs:** make the first-project tutorial's own commands actually work ([#115](https://github.com/ecoma-io/lattice/issues/115)) ([0c530e4](https://github.com/ecoma-io/lattice/commit/0c530e4ecdb2ba93f14dcddd685ef88bbd79fa7c))
* **docs:** teach arch-* skills the suppression exception and check-blocking rule ([#133](https://github.com/ecoma-io/lattice/issues/133)) ([8e56e97](https://github.com/ecoma-io/lattice/commit/8e56e97a7dc89c52f55a1c7fddcf980c4c745c87))
* **lattice:** a Vue script block the SFC parser could not recover fails the file ([#112](https://github.com/ecoma-io/lattice/issues/112)) ([60b0ed0](https://github.com/ecoma-io/lattice/commit/60b0ed056499097cc71f504b14f092675d07a79c))
* **lattice:** add governance/ to the determinism source guard's scan ([#134](https://github.com/ecoma-io/lattice/issues/134)) ([9dc0af4](https://github.com/ecoma-io/lattice/commit/9dc0af4262d5f1719be718855f7652a2662113de))
* **lattice:** cap a glob's brace-group expansion before matching ([#124](https://github.com/ecoma-io/lattice/issues/124)) ([756eab3](https://github.com/ecoma-io/lattice/commit/756eab3039456be98e48172e58a2583335430a6f))
* **lattice:** catch five cross-boundary imports the parsers silently missed ([#138](https://github.com/ecoma-io/lattice/issues/138)) ([f5bb886](https://github.com/ecoma-io/lattice/commit/f5bb886f350e8cbacc82ab5685dfd008b29869ba))
* **lattice:** check judges implicit-typed graph edges, not only import sites ([#111](https://github.com/ecoma-io/lattice/issues/111)) ([2e1e0ad](https://github.com/ecoma-io/lattice/commit/2e1e0ada0df797f957b20bef79d5076b72bdc530))
* **lattice:** check Nx and Moon graphs for unclaimed files too ([#116](https://github.com/ecoma-io/lattice/issues/116)) ([ebaec74](https://github.com/ecoma-io/lattice/commit/ebaec74c2e0dc8c7a8330033b9fd56840993ecd5))
* **lattice:** derive Moon graph edges from imports, not only dependsOn ([#107](https://github.com/ecoma-io/lattice/issues/107)) ([904a94e](https://github.com/ecoma-io/lattice/commit/904a94e95a936793dbc80382737ea68699e4c4f2))
* **lattice:** disclose remainingMs/sampleTime as excluded from waivers/debt determinism ([#135](https://github.com/ecoma-io/lattice/issues/135)) ([df29039](https://github.com/ecoma-io/lattice/commit/df290391120c970c3b126a82b0c2f36e65fe48df))
* **lattice:** exclude implicit edges from architecture-intent judgment ([#126](https://github.com/ecoma-io/lattice/issues/126)) ([847d8d7](https://github.com/ecoma-io/lattice/commit/847d8d745392f4dffc3feca6eb702d8b0a337f88))
* **lattice:** honor Moon's own implicit-dependency marker when typing an edge ([#113](https://github.com/ecoma-io/lattice/issues/113)) ([9677059](https://github.com/ecoma-io/lattice/commit/967705905c566a74aa814880db2e4d933eff2f04))
* **lattice:** make architecture-intent boundary matches order-independent ([#119](https://github.com/ecoma-io/lattice/issues/119)) ([116b0c9](https://github.com/ecoma-io/lattice/commit/116b0c9c570b9f7165d28c038f1142551283756d))
* **lattice:** make Intent's dependencies.forbidden/forbiddenTags transitive ([#127](https://github.com/ecoma-io/lattice/issues/127)) ([ce0cdf7](https://github.com/ecoma-io/lattice/commit/ce0cdf7c08839b4251556d2920bfd99a799003d5))
* **lattice:** make the published README lattice.json example load ([#142](https://github.com/ecoma-io/lattice/issues/142)) ([804e425](https://github.com/ecoma-io/lattice/commit/804e425f73ecff210b6004e2bec7581da9ad0b0d))
* **lattice:** move misplaced report renderers into src/report/ ([#129](https://github.com/ecoma-io/lattice/issues/129)) ([94b5458](https://github.com/ecoma-io/lattice/commit/94b5458f3474b46da886d5468f30c881a6e0ce21))
* **lattice:** name the policy that governed a check run (P1-01) ([#130](https://github.com/ecoma-io/lattice/issues/130)) ([795e7b2](https://github.com/ecoma-io/lattice/commit/795e7b2d702268c6d69101454555c39a97458373))
* **lattice:** refuse --output onto architecture-intent.json or the boundary law ([#131](https://github.com/ecoma-io/lattice/issues/131)) ([e591fe5](https://github.com/ecoma-io/lattice/commit/e591fe592b76ce586b541c3607d50c8bb9588385))
* **lattice:** refuse a scoped path that matches no tracked file ([#120](https://github.com/ecoma-io/lattice/issues/120)) ([c18d091](https://github.com/ecoma-io/lattice/commit/c18d0914e07a75bb45a2ec026e365fbaf41cabeb))
* **lattice:** refuse an ADR frontmatter block with a repeated key ([#125](https://github.com/ecoma-io/lattice/issues/125)) ([d36cf98](https://github.com/ecoma-io/lattice/commit/d36cf985baa9443e5f86d13511c3e43e13cc7916))
* **lattice:** refuse rather than follow a symlink at --output's .tmp path ([#110](https://github.com/ecoma-io/lattice/issues/110)) ([66654e2](https://github.com/ecoma-io/lattice/commit/66654e2b3294306229f542d86ea8377beb23f232))
* **lattice:** report permanent suppressions in the waivers surface ([#123](https://github.com/ecoma-io/lattice/issues/123)) ([f4585cd](https://github.com/ecoma-io/lattice/commit/f4585cd799d1b3b86be58a55e57d692c029d1526))
* **lattice:** report the files coverage.exempt removed from a run ([#109](https://github.com/ecoma-io/lattice/issues/109)) ([9fc7ffc](https://github.com/ecoma-io/lattice/commit/9fc7ffc5e7b8e0fa1665dcc2119933e754daf465))
* **lattice:** resolve a Moon workspace root in adr and --help ([#106](https://github.com/ecoma-io/lattice/issues/106)) ([63f1714](https://github.com/ecoma-io/lattice/commit/63f17147f4089334090b372e574833eb551293cf))
* **lattice:** resolve adr: decisionRef ids and flag other near-misses loudly ([#128](https://github.com/ecoma-io/lattice/issues/128)) ([3ffaf9d](https://github.com/ecoma-io/lattice/commit/3ffaf9d9caea456a1c394ab66aad731867679ac8))
* **lattice:** resolve decisionRef against the ADR registry before reporting it ([#139](https://github.com/ecoma-io/lattice/issues/139)) ([418fa3f](https://github.com/ecoma-io/lattice/commit/418fa3f0c9a76e536d658a35745e3a8cf049f7c9))
* **lattice:** resolve graph's inline boundaryConfig into a policy fingerprint ([#118](https://github.com/ecoma-io/lattice/issues/118)) ([81b95f6](https://github.com/ecoma-io/lattice/commit/81b95f681338ba44c72b6cc26130e458c75ce71e))
* **lattice:** resolve named profiles from every command that reads a boundary law ([#137](https://github.com/ecoma-io/lattice/issues/137)) ([b5b6ddc](https://github.com/ecoma-io/lattice/commit/b5b6ddca62bcfe8d9208484ea9a56eccb8e8c5e0))
* **lattice:** restrict profile names to letters, digits, - and _ ([#122](https://github.com/ecoma-io/lattice/issues/122)) ([5b4fc0c](https://github.com/ecoma-io/lattice/commit/5b4fc0c4a41082fe1bcf4a3fbd64ebd8125990c4))
* **lattice:** restrict the ADR registry to tracked, non-escaping files ([#121](https://github.com/ecoma-io/lattice/issues/121)) ([8bcdf49](https://github.com/ecoma-io/lattice/commit/8bcdf4973f3eac4ac65ac5fdcc946374469fef01))
* **lattice:** stop a corrupt go.work from parsing as zero use entries ([#114](https://github.com/ecoma-io/lattice/issues/114)) ([528468b](https://github.com/ecoma-io/lattice/commit/528468bfb60c8654098a773fcf2a6fd7b3054945))
* **lattice:** stop coverage-minimum from forcing exit 3 on a scoped check ([#136](https://github.com/ecoma-io/lattice/issues/136)) ([8d34872](https://github.com/ecoma-io/lattice/commit/8d34872246f94d98b0be3b543edcd402a64b02b4))
* **lattice:** stop fitness from crashing when no architecture-intent.json is tracked ([#117](https://github.com/ecoma-io/lattice/issues/117)) ([98df319](https://github.com/ecoma-io/lattice/commit/98df319757bdaca643dab8565a6949cff5b8ac3a))
* **workspace:** repair doc references broken by the docs IA restructure ([#76](https://github.com/ecoma-io/lattice/issues/76)) ([deab496](https://github.com/ecoma-io/lattice/commit/deab496b6bb296332901ecb3096d240b8c050fb1))


### Documentation

* align README and agent workflow with architecture governance ([#103](https://github.com/ecoma-io/lattice/issues/103)) ([f37c4a4](https://github.com/ecoma-io/lattice/commit/f37c4a4196c72815d2072e0a7bbc0fbc98f2c4cf))
* complete profile and ADR agent workflow ([#105](https://github.com/ecoma-io/lattice/issues/105)) ([533dffa](https://github.com/ecoma-io/lattice/commit/533dffad590ca1c7afbaee3331141c72ede9f7ed))
* redefine 1.x scope and 2.x architecture intelligence direction ([#85](https://github.com/ecoma-io/lattice/issues/85)) ([d49a570](https://github.com/ecoma-io/lattice/commit/d49a5706d3fb95e3b0993ac826d8f982d6a430a0))
* **workspace:** confine docs/ links to docs/ and gate it in the editor ([#80](https://github.com/ecoma-io/lattice/issues/80)) ([ec64960](https://github.com/ecoma-io/lattice/commit/ec649601dec48a86f15eb0dfc3513791d5e366a3))
* **workspace:** drop the brand assets section from AGENTS.md ([#78](https://github.com/ecoma-io/lattice/issues/78)) ([f0c20f4](https://github.com/ecoma-io/lattice/commit/f0c20f4ec661106a85e0b2036b29e93d69bfa083))
* **workspace:** name the TypeScript and JavaScript family consistently ([#77](https://github.com/ecoma-io/lattice/issues/77)) ([2fdc2f7](https://github.com/ecoma-io/lattice/commit/2fdc2f7c1569ffadc0cf62558b08848a3d324ae8))

## [0.4.0](https://github.com/ecoma-io/lattice/compare/v0.3.0...v0.4.0) (2026-08-14)


### ⚠ BREAKING CHANGES

* **lattice:** JSON envelope workspace now includes provenance field. Tags in graph output are now sorted, which changes the array order for workspaces where tags were not declared alphabetically.

### Features

* **lattice:** harden intent gate, add Contract C/J behavioral proofs ([#72](https://github.com/ecoma-io/lattice/issues/72)) ([7cf3abd](https://github.com/ecoma-io/lattice/commit/7cf3abdb396c0668accb4583a31da34013f03eae))
* **lattice:** harden intent gate, add Contract C/J behavioral proofs ([#72](https://github.com/ecoma-io/lattice/issues/72)) ([7cf3abd](https://github.com/ecoma-io/lattice/commit/7cf3abdb396c0668accb4583a31da34013f03eae))
* **lattice:** harden intent proof, snapshot provenance, and terminology ([#71](https://github.com/ecoma-io/lattice/issues/71)) ([a24220f](https://github.com/ecoma-io/lattice/commit/a24220f3d65b8032314d00705e0d8eb7ec90bd9d))
* **lattice:** v1 intent completeness gate and adversarial fixes ([#69](https://github.com/ecoma-io/lattice/issues/69)) ([8c9526b](https://github.com/ecoma-io/lattice/commit/8c9526b68d6c9ff6e5d7ee4984b40872831dbe97))

## [0.3.0](https://github.com/ecoma-io/lattice/compare/v0.2.0...v0.3.0) (2026-08-14)


### ⚠ BREAKING CHANGES

* **lattice:** JSON output now uses schemaVersion 2 and includes the expanded result contract.

### Features

* **lattice:** harden command evidence and graph diffs ([#67](https://github.com/ecoma-io/lattice/issues/67)) ([9a0219b](https://github.com/ecoma-io/lattice/commit/9a0219b127fda5444dc4d1d1fab972c1b62c7247))

## [0.2.0](https://github.com/ecoma-io/lattice/compare/v0.1.0...v0.2.0) (2026-08-14)


### Features

* **lattice:** context, diff rule-impact, impact constraint-context, adversarial fixes ([#65](https://github.com/ecoma-io/lattice/issues/65)) ([86f19f6](https://github.com/ecoma-io/lattice/commit/86f19f61e1b8959829eaf476877e2a056ab3c66b))

## 0.1.0 (2026-08-14)


### ⚠ BREAKING CHANGES

* **lattice:** tags must use dash separators (type-lib, not type:lib) when using the Moon provider, because Moon tag validation rejects colons. Existing constraint tables in Moon workspaces need to switch from colon to dash format.
* **lattice:** normalise Nx root-project root '.' to '' in createWorkspace ([#56](https://github.com/ecoma-io/lattice/issues/56))
* **lattice:** TypeScript import-type queries now participate in boundary analysis and can produce new findings on unchanged workspaces.
* **lattice:** reported results change on unchanged workspaces, in both directions. A tree declaring a complete non-default workspaceLayout can gain noRelativeOrAbsoluteImportsAcrossLibraries findings that were previously missed; a tree declaring a partial workspaceLayout now exits 3 with no verdict instead of silently running half the rule.
* **workspace:** the npm package name, both bin names, the Nx plugin specifier in nx.json, and the SARIF tool.driver.name all change; existing code-scanning alerts re-key, and consumers must reinstall under the new name and update their nx.json plugins entry.

### Features

* **ci:** prove the native provider against this tree and the real-tree differential ([#37](https://github.com/ecoma-io/lattice/issues/37)) ([9abd440](https://github.com/ecoma-io/lattice/commit/9abd440e285284b01d6528b2761403041bdec347))
* **lattice:** add command foundation and honest JSON envelopes ([#43](https://github.com/ecoma-io/lattice/issues/43)) ([736e20b](https://github.com/ecoma-io/lattice/commit/736e20b0058252f7339017cc262d7de761db19ee))
* **lattice:** add explain command ([#48](https://github.com/ecoma-io/lattice/issues/48)) ([594f7a9](https://github.com/ecoma-io/lattice/commit/594f7a9e32fce358a18db1c3b49b5e488957a150))
* **lattice:** add graph and diff commands ([#45](https://github.com/ecoma-io/lattice/issues/45)) ([02013a1](https://github.com/ecoma-io/lattice/commit/02013a1c5b49c87d9ebb0ec33daf036fcb2f76a3))
* **lattice:** add impact command ([b357a5d](https://github.com/ecoma-io/lattice/commit/b357a5d1384578e1a26f7d5e4b93d5928279f714))
* **lattice:** add layout-bearing conformance case ([#40](https://github.com/ecoma-io/lattice/issues/40)) ([52e0043](https://github.com/ecoma-io/lattice/commit/52e00432b9d2fc91fb0a9d33f94df1c11871dc8a))
* **lattice:** add layout-bearing conformance case ([#58](https://github.com/ecoma-io/lattice/issues/58)) ([52e0043](https://github.com/ecoma-io/lattice/commit/52e00432b9d2fc91fb0a9d33f94df1c11871dc8a))
* **lattice:** add Moon provider, migrate repository from Nx to Moonrepo ([#60](https://github.com/ecoma-io/lattice/issues/60)) ([3a514b2](https://github.com/ecoma-io/lattice/commit/3a514b29fc4edbd64b46826776b83a2617770374))
* **lattice:** add multi-language E2E coverage for all six first-class languages ([#53](https://github.com/ecoma-io/lattice/issues/53)) ([d7f234d](https://github.com/ecoma-io/lattice/commit/d7f234da29fe4e6589589529e1c2d7c60d67b802))
* **lattice:** add multi-language E2E coverage for all six first-class languages ([#54](https://github.com/ecoma-io/lattice/issues/54)) ([d7f234d](https://github.com/ecoma-io/lattice/commit/d7f234da29fe4e6589589529e1c2d7c60d67b802))
* **lattice:** add the command foundation and honest JSON envelopes ([736e20b](https://github.com/ecoma-io/lattice/commit/736e20b0058252f7339017cc262d7de761db19ee))
* **lattice:** add the JSON policy dialect and the inline lattice.json policy ([#34](https://github.com/ecoma-io/lattice/issues/34)) ([b3ca5aa](https://github.com/ecoma-io/lattice/commit/b3ca5aa78dc0d8e66b2fdb8d6dedf560cb163feb))
* **lattice:** add the native lattice.json project-model provider ([#30](https://github.com/ecoma-io/lattice/issues/30)) ([13788d4](https://github.com/ecoma-io/lattice/commit/13788d40cfab5cbaaa918d1d83ae7cb864cd158b))
* **lattice:** add Vitest E2E compatibility suite ([#53](https://github.com/ecoma-io/lattice/issues/53)) ([92aee70](https://github.com/ecoma-io/lattice/commit/92aee706769fa861aebde4ce951c7879a21b3d5d))
* **lattice:** analyze TypeScript import types ([#44](https://github.com/ecoma-io/lattice/issues/44)) ([1b2725b](https://github.com/ecoma-io/lattice/commit/1b2725b0df566c153ee46a22eb34a7dd61757d73))
* **lattice:** honor nx.json workspaceLayout and refuse partial layouts ([#42](https://github.com/ecoma-io/lattice/issues/42)) ([f5023fb](https://github.com/ecoma-io/lattice/commit/f5023fb048753b9842c81e14e686232094993d6d))
* **lattice:** normalise Nx root-project root '.' to '' in createWorkspace ([#56](https://github.com/ecoma-io/lattice/issues/56)) ([cff1e89](https://github.com/ecoma-io/lattice/commit/cff1e89a8f99e346c9b2fb0c8e74657850ec44ed)), closes [#32](https://github.com/ecoma-io/lattice/issues/32)
* **lattice:** read the boundary policy from ESLint flat config ([#36](https://github.com/ecoma-io/lattice/issues/36)) ([8b18bde](https://github.com/ecoma-io/lattice/commit/8b18bdece13cbc7d38e6ca16f1bee64c6c0d5af4))
* **lattice:** surface polyglot coverage gap when Nx plugin is unregistered ([#57](https://github.com/ecoma-io/lattice/issues/57)) ([ab9023f](https://github.com/ecoma-io/lattice/commit/ab9023f4d796f44a6e658e17bd35237f770848db))
* **workspace:** rename the engine to @ecoma-io/lattice and make nx an optional peer ([#25](https://github.com/ecoma-io/lattice/issues/25)) ([7dc30f6](https://github.com/ecoma-io/lattice/commit/7dc30f60911e64def4168f0a2d5c60cbbee10a34))


### Bug Fixes

* **lattice:** bound spawnSync calls in the exit-contract test with a 30s timeout ([#55](https://github.com/ecoma-io/lattice/issues/55)) ([55d5fa7](https://github.com/ecoma-io/lattice/commit/55d5fa7787feeddc90722e8953115a345a935300)), closes [#41](https://github.com/ecoma-io/lattice/issues/41)


### Documentation

* **workspace:** reposition Lattice as independent engine, Nx as first-class integration ([#51](https://github.com/ecoma-io/lattice/issues/51)) ([c79b62f](https://github.com/ecoma-io/lattice/commit/c79b62f3fee17697718ab1c0baa33fb0fa02a0ac))
* **workspace:** restructure documentation IA into eight sections ([#49](https://github.com/ecoma-io/lattice/issues/49)) ([513da7e](https://github.com/ecoma-io/lattice/commit/513da7e8c52b8acd3eaacec3117605ffaeb1717e))

/**
 * The labeled corpus: architecture styles expressed in Go, Rust and Python,
 * each with the verdict a person decided in advance.
 *
 * ## Why this exists beside the differential
 *
 * `./cases.mjs` proves this engine against `@nx/enforce-module-boundaries` —
 * a real second opinion, and the only one available. It is available for
 * JavaScript, TypeScript and Vue and for nothing else: ESLint has no parser
 * for `.go`, `.rs` or `.py`, so on the three languages this tool exists FOR,
 * the differential's every row is structurally incomparable. Upstream's
 * silence there is inability, not agreement, and a false negative in that half
 * is invisible to every mechanism in this directory.
 *
 * This corpus is the mechanism for that half. There is no oracle to ask, so
 * the labels are the oracle: each probe states which rule must fire, on which
 * import, between which two projects — decided from the policy and the import
 * before the tool was run, which is the only order in which a label is
 * evidence rather than a transcription.
 *
 * ## What a case is
 *
 * One workspace per architecture style, in one language (or two, where the
 * point is that a boundary holds whichever language reaches across it). Not a
 * minimal pair: a style — layered, hexagonal, bounded contexts, modular
 * monolith — because the defects this half is exposed to are about a
 * language's own shapes (`use super::`, a src-layout package, an intra-module
 * Go import) meeting a constraint table, and those only appear where the
 * fixture has enough structure to write them.
 *
 * ```js
 * {
 *   id, style, languages, intent,          // what this workspace is, and why
 *   projects: [{name, root, tags, type?, targets?}],
 *   depConstraints: [...],                 // this workspace's boundary law
 *   options: {...},                        // only the option keys it changes
 *   aliases: {...},                        // only where a TypeScript probe needs one
 *   files: {relativePath: text},           // sources and manifests, nothing else
 *   probes: [{file, imports, reports, denyAll, why}],
 * }
 * ```
 *
 * ## What a probe states, and why it takes three numbers rather than one
 *
 * - **`reports`** — the exact findings this file must produce under the
 *   case's own policy, `[]` for a near-miss. Each is `{messageId, specifier,
 *   target}`; the source project is derived from the file's own path, so no
 *   label ever restates it. The whole case's findings are compared against
 *   the union of these, in both directions: a finding no probe claims fails
 *   the run exactly as loudly as a claimed one that did not arrive.
 *
 * - **`imports`** — how many import sites the analyzer must record in this
 *   file, measured by running `check` scoped to this file alone. This is the
 *   number that goes red when an analyzer stops reading a shape: a Go block
 *   import closed early by a `)` in a comment, a Rust `use` behind an
 *   attribute, a Python import indented inside a function. Without it, an
 *   analyzer that silently dropped an import would turn a positive probe into
 *   a "missing finding" (loud) but a near-miss probe into a pass (silent).
 *
 * - **`denyAll`** — how many findings this file produces under the corpus's
 *   forbid-everything policy (`./corpus-fixture.mjs`). This is what makes a
 *   near-miss mean something: silence under the case's own law, reported
 *   under a law that forbids everything, is a verdict about the policy. A
 *   probe silent under BOTH is silent for a reason the corpus states in
 *   `why` — an import that reaches inside its own project, or a form no rule
 *   can reach — and the reader is told which.
 *
 * - **`why`** — one sentence, mandatory, and the only place a near-miss can
 *   explain itself. `../../../../AGENTS.md`'s invariant in one field: an
 *   empty `reports` is a claim, and a claim needs a reason.
 *
 * ## What may not appear here
 *
 * No project name, tag, module path, crate name or package name from any real
 * workspace — this one's included. Every name below is invented and means
 * nothing outside its case: Go module paths under `example.test/`, external
 * Go modules under `vendor.test/`, crates and Python distributions named for
 * the role they play in the fixture. A real path from another tree would read
 * as a fact about this one (`../../../../AGENTS.md`).
 */

/**
 * The message ids no probe here reaches, each with the mechanism Go, Rust and
 * Python do not have.
 *
 * Named rather than left to be noticed. The suite requires these plus the ids
 * the corpus does reach to be exactly `MESSAGE_IDS`, so an id added upstream
 * lands in neither list and fails the run rather than quietly joining the set
 * of things nothing here says anything about — the same arrangement the
 * differential's own "exercises every message id upstream defines" test makes
 * for its half.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const OUT_OF_REACH = Object.freeze({
  noRelativeOrAbsoluteExternals:
    "needs a specifier that IS a filesystem path; `spelling.path` is false for every Go import, " +
    "Rust `use` path, Python dotted module, JVM dotted import and C# using directive " +
    "(`../analysis/contract.md`)",
  noImportsOfLazyLoadedLibraries:
    "needs a dynamic import, a form none of these five languages has — Go's `kind` is always " +
    "static, neither Rust's `use` nor Python's `import` has a lazy counterpart the analyzer " +
    "records as one, and the JVM's and C#'s imports are compile-time directives only",
  nestedBannedExternalImportsViolation:
    "needs a project's import alias to collide with the name of a package reachable transitively " +
    "through the npm graph, which is an npm-shaped coincidence no Go module path, crate name, " +
    "Python distribution, Kotlin package or NuGet package id can produce here",
});

export const ARCHITECTURE_CORPUS = [
  // ------------------------------------------------------------- layered (Go)
  {
    id: "layered-architecture-in-go",
    style: "layered (relaxed)",
    languages: ["go"],
    intent:
      "The RELAXED reading of layering, and the pair to `strict-layering-in-go`: each layer may reach every layer beneath it, so only an outward edge is a finding and a downward edge that skips a layer is not. Dependencies point inward: the domain knows nobody, the use-case layer knows the domain, the adapter layer knows both. The near-misses are the inward imports, which must stay silent, and an external SDK banned out of one layer only. The outward violations both point at `go-transport`, an outer-layer project that imports nothing — an outward edge whose target reaches back would close a cycle, and `noCircularDependencies` is decided before the tag block, so the case would be measuring a different rule than the one it is about.",
    projects: [
      { name: "go-domain", root: "libs/go-domain", tags: ["layer:domain"] },
      { name: "go-usecase", root: "libs/go-usecase", tags: ["layer:usecase"] },
      { name: "go-adapter", root: "libs/go-adapter", tags: ["layer:adapter"] },
      { name: "go-transport", root: "libs/go-transport", tags: ["layer:adapter"] },
    ],
    depConstraints: [
      { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
      { sourceTag: "layer:usecase", onlyDependOnLibsWithTags: ["layer:domain", "layer:usecase"] },
      {
        sourceTag: "layer:adapter",
        onlyDependOnLibsWithTags: ["layer:domain", "layer:usecase", "layer:adapter"],
        bannedExternalImports: ["vendor.test/shell-sdk"],
      },
    ],
    files: {
      "libs/go-domain/go.mod": "module example.test/go-domain\n\ngo 1.24\n",
      "libs/go-domain/entity.go":
        "// Package domain is the layer that must know nobody.\npackage domain\n\nimport (\n\t" +
        '"example.test/go-transport"\n)\n\n// Order reaches outward, which is the violation this file exists for.\nvar Order = transport.Wire\n',
      "libs/go-usecase/go.mod": "module example.test/go-usecase\n\ngo 1.24\n",
      "libs/go-usecase/service.go":
        "package usecase\n\nimport (\n\t" +
        '"example.test/go-domain"\n\t"example.test/go-transport"\n)\n\nvar Service = []any{domain.Order, transport.Wire}\n',
      "libs/go-usecase/sdk.go":
        'package usecase\n\nimport "vendor.test/shell-sdk"\n\nvar Shell = shellsdk.Handle\n',
      "libs/go-adapter/go.mod": "module example.test/go-adapter\n\ngo 1.24\n",
      "libs/go-adapter/repo.go":
        "package adapter\n\nimport (\n\t" +
        '"example.test/go-domain"\n\t"example.test/go-usecase"\n)\n\nvar Row = []any{domain.Order, usecase.Service}\n',
      "libs/go-adapter/store.go":
        'package adapter\n\nimport "example.test/go-adapter/internal/store"\n\nvar Store = store.Handle\n',
      "libs/go-adapter/internal/store/store.go": "package store\n\nvar Handle = 1\n",
      "libs/go-adapter/sdk.go":
        'package adapter\n\nimport "vendor.test/shell-sdk"\n\nvar Shell = shellsdk.Handle\n',
      "libs/go-transport/go.mod": "module example.test/go-transport\n\ngo 1.24\n",
      "libs/go-transport/wire.go":
        "// Package transport imports nothing, so an outward edge into it cannot close a cycle.\npackage transport\n\nvar Wire = 1\n",
    },
    probes: [
      {
        file: "libs/go-domain/entity.go",
        imports: 1,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "example.test/go-transport",
            target: "go-transport",
          },
        ],
        denyAll: 1,
        why: "The innermost layer reaching the outermost one — the violation the whole style exists to prevent.",
      },
      {
        file: "libs/go-usecase/service.go",
        imports: 2,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "example.test/go-transport",
            target: "go-transport",
          },
        ],
        denyAll: 2,
        why: "Two crossings in one file, one allowed and one not: the domain import must stay silent while the adapter import beside it reports.",
      },
      {
        file: "libs/go-usecase/sdk.go",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "The same external module the adapter layer is banned from, imported by a layer no ban row names — a ban is scoped to the tag that carries it.",
      },
      {
        file: "libs/go-adapter/repo.go",
        imports: 2,
        reports: [],
        denyAll: 2,
        why: "Both inward imports are what the layering permits; an engine reporting here would be inverting the axis.",
      },
      {
        file: "libs/go-adapter/store.go",
        imports: 1,
        reports: [],
        denyAll: 0,
        why: "A Go import of the project's own module path resolves back to the project it started in, so the tag block is never reached and the one rule that judges such an import — `noSelfCircularDependencies` — reads it as relative, which is the honest answer for a language with no relative import form. Silent under the deny-all policy too, so its liveness is the import count beside it.",
      },
      {
        file: "libs/go-adapter/sdk.go",
        imports: 1,
        reports: [
          {
            messageId: "bannedExternalImportsViolation",
            specifier: "vendor.test/shell-sdk",
            target: "npm:vendor.test/shell-sdk",
          },
        ],
        denyAll: 1,
        why: "A Go external module is banned out of the layer whose constraint row names it — the enforcement ESLint cannot perform on a .go file at all.",
      },
    ],
  },

  // --------------------------------------------------------- hexagonal (Rust)
  {
    id: "hexagonal-ports-and-adapters-in-rust",
    style: "hexagonal (ports and adapters)",
    languages: ["rust"],
    intent:
      "The core owns the ports and depends on nothing; adapters depend on the core and never on each other. The near-misses are the intra-crate paths Rust writes constantly — `crate::`, `super::` — which a JavaScript-shaped relativeness test once reported as self-circular imports. The core's own outward reach points at `rs-telemetry`, a driven adapter that uses nothing, for the reason the layered Go case states: an outward edge into a crate that reaches back would be judged as a cycle before any tag is read.",
    projects: [
      { name: "rs-core", root: "libs/rs-core", tags: ["hex:core"] },
      { name: "rs-driving", root: "libs/rs-driving", tags: ["hex:driving"] },
      { name: "rs-driven", root: "libs/rs-driven", tags: ["hex:driven"] },
      { name: "rs-telemetry", root: "libs/rs-telemetry", tags: ["hex:driven"] },
    ],
    depConstraints: [
      {
        sourceTag: "hex:core",
        onlyDependOnLibsWithTags: ["hex:core"],
        bannedExternalImports: ["shellcrate"],
      },
      {
        sourceTag: "hex:driving",
        onlyDependOnLibsWithTags: ["hex:core", "hex:driving", "hex:driven"],
      },
      { sourceTag: "hex:driving", notDependOnLibsWithTags: ["hex:driven"] },
      { sourceTag: "hex:driven", onlyDependOnLibsWithTags: ["hex:core", "hex:driven"] },
    ],
    files: {
      "libs/rs-core/Cargo.toml": '[package]\nname = "corpus_core"\nversion = "0.1.0"\n',
      "libs/rs-core/src/lib.rs": "pub mod ports;\npub mod service;\npub mod shell;\n",
      "libs/rs-core/src/ports.rs": "pub struct Port;\n",
      "libs/rs-core/src/service.rs":
        "use super::ports::Port;\nuse corpus_telemetry::Sink;\n\npub fn open(_: &Port, _: &Sink) {}\n",
      "libs/rs-core/src/shell.rs":
        "use shellcrate;\nuse shellcrate::window::Manager;\n\npub fn show(_: &Manager) {\n    let _ = shellcrate::VERSION;\n}\n",
      "libs/rs-driving/Cargo.toml": '[package]\nname = "corpus_driving"\nversion = "0.1.0"\n',
      "libs/rs-driving/src/lib.rs":
        "use corpus_core::ports::Port;\nuse corpus_driven::Pool;\n\npub fn handle(_: &Port, _: &Pool) {}\n",
      "libs/rs-driven/Cargo.toml": '[package]\nname = "corpus_driven"\nversion = "0.1.0"\n',
      "libs/rs-driven/src/lib.rs":
        "use corpus_core::ports::Port;\n\npub struct Pool;\n\npub fn bind(_: &Port) {}\n",
      "libs/rs-telemetry/Cargo.toml": '[package]\nname = "corpus_telemetry"\nversion = "0.1.0"\n',
      "libs/rs-telemetry/src/lib.rs":
        "// This crate uses nothing, so an edge into it cannot close a cycle.\npub struct Sink;\n",
    },
    probes: [
      {
        file: "libs/rs-core/src/service.rs",
        imports: 2,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "corpus_telemetry::Sink",
            target: "rs-telemetry",
          },
        ],
        denyAll: 1,
        why: "The core reaching a driven adapter is the violation; the `super::ports::Port` beside it is ordinary Rust and must stay silent, which is the half a relativeness test written for JavaScript got wrong.",
      },
      {
        file: "libs/rs-core/src/shell.rs",
        imports: 2,
        reports: [
          {
            messageId: "bannedExternalImportsViolation",
            specifier: "shellcrate",
            target: "npm:shellcrate",
          },
        ],
        denyAll: 1,
        why: "Only the bare `use shellcrate;` is reachable by a ban: upstream's own matcher tests the specifier against the package name and a `/`-separated prefix, and `shellcrate::window::Manager` is neither — a declared limit this probe pins rather than hides (`./README.md`).",
      },
      {
        file: "libs/rs-driving/src/lib.rs",
        imports: 2,
        reports: [
          {
            messageId: "notTagsConstraintViolation",
            specifier: "corpus_core::ports::Port",
            target: "rs-core",
          },
          {
            messageId: "notTagsConstraintViolation",
            specifier: "corpus_driven::Pool",
            target: "rs-driven",
          },
        ],
        denyAll: 2,
        why: "Two rows match this project and both are held — the AND of several matching constraints is what makes the forbidding one bind — and the forbidding one is TRANSITIVE: the direct `corpus_driven` import violates it, and so does the `corpus_core` import beside it, because the core reaches `rs-telemetry`, which carries the forbidden tag. A reading of this rule that stopped at the direct target would report one of these two and call the file half-clean.",
      },
      {
        file: "libs/rs-driven/src/lib.rs",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "An adapter depending on the core is the direction the style is for.",
      },
    ],
  },

  // ------------------------------------------------- bounded contexts (Python)
  {
    id: "bounded-contexts-in-python",
    style: "DDD bounded contexts",
    languages: ["python"],
    intent:
      "Each context is sealed except for a shared kernel. The near-misses are a relative import inside a package and an import of the kernel; the positives are a cross-context reach and a package importing itself through its own distribution name.",
    projects: [
      { name: "py-billing", root: "libs/py-billing", tags: ["context:billing"] },
      { name: "py-shipping", root: "libs/py-shipping", tags: ["context:shipping"] },
      { name: "py-kernel", root: "libs/py-kernel", tags: ["context:shared-kernel"] },
    ],
    depConstraints: [
      {
        sourceTag: "context:billing",
        onlyDependOnLibsWithTags: ["context:billing", "context:shared-kernel"],
      },
      {
        sourceTag: "context:shipping",
        onlyDependOnLibsWithTags: ["context:shipping", "context:shared-kernel"],
      },
      { sourceTag: "context:shared-kernel", onlyDependOnLibsWithTags: ["context:shared-kernel"] },
    ],
    files: {
      "libs/py-billing/pyproject.toml": '[project]\nname = "billing"\nversion = "0.1.0"\n',
      "libs/py-billing/src/billing/__init__.py": "",
      "libs/py-billing/src/billing/ledger.py": "LEDGER = []\n",
      "libs/py-billing/src/billing/invoice.py":
        "from kernel.money import Money\nfrom shipping.tracking import Tracker\nfrom .ledger import LEDGER\nimport billing.ledger\n\n" +
        "TOTAL = (Money, Tracker, LEDGER, billing.ledger)\n",
      "libs/py-shipping/pyproject.toml": '[project]\nname = "shipping"\nversion = "0.1.0"\n',
      "libs/py-shipping/src/shipping/__init__.py": "",
      "libs/py-shipping/src/shipping/tracking.py":
        "from kernel.money import Money\n\n\nclass Tracker:\n    unit = Money\n",
      "libs/py-kernel/pyproject.toml": '[project]\nname = "kernel"\nversion = "0.1.0"\n',
      "libs/py-kernel/src/kernel/__init__.py": "",
      "libs/py-kernel/src/kernel/money.py": "import decimal\n\nMoney = decimal.Decimal\n",
    },
    probes: [
      {
        file: "libs/py-billing/src/billing/invoice.py",
        imports: 4,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "shipping.tracking",
            target: "py-shipping",
          },
          {
            messageId: "noSelfCircularDependencies",
            specifier: "billing.ledger",
            target: "py-billing",
          },
        ],
        denyAll: 3,
        why: "Four imports, two of them findings: reaching into another context, and reaching the package's own module through its distribution name instead of the relative form written one line above — which must itself stay silent.",
      },
      {
        file: "libs/py-shipping/src/shipping/tracking.py",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "The shared kernel is the one thing every context may reach.",
      },
      {
        file: "libs/py-kernel/src/kernel/money.py",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "A standard-library import leaves the workspace, so no tag rule applies; the deny-all run's ban is what proves the site was read at all.",
      },
    ],
  },

  // ------------------------------------- modular monolith (Go and TypeScript)
  {
    id: "modular-monolith-across-languages",
    style: "modular monolith",
    languages: ["go", "typescript"],
    intent:
      "Every module is reachable only through its own api project, and the law is one constraint table for a tree whose modules are written in two languages — the same boundary, met by a Go import path and by a TypeScript alias, plus the spelling rule only the TypeScript half can break.",
    projects: [
      {
        name: "mm-orders-api",
        root: "libs/mm-orders-api",
        tags: ["module:orders", "type:api"],
      },
      {
        name: "mm-orders-core",
        root: "libs/mm-orders-core",
        tags: ["module:orders", "type:internal"],
      },
      {
        name: "mm-billing-api",
        root: "libs/mm-billing-api",
        tags: ["module:billing", "type:api"],
      },
      {
        name: "mm-billing-core",
        root: "libs/mm-billing-core",
        tags: ["module:billing", "type:internal"],
      },
      { name: "mm-web", root: "libs/mm-web", tags: ["module:web", "type:internal"] },
    ],
    depConstraints: [
      { sourceTag: "module:orders", onlyDependOnLibsWithTags: ["module:orders", "type:api"] },
      { sourceTag: "module:billing", onlyDependOnLibsWithTags: ["module:billing", "type:api"] },
      { sourceTag: "module:web", onlyDependOnLibsWithTags: ["type:api"] },
    ],
    aliases: {
      "@corpus/orders-api": "libs/mm-orders-api/src/index.ts",
      "@corpus/orders-core": "libs/mm-orders-core/src/index.ts",
    },
    files: {
      "libs/mm-orders-api/go.mod": "module example.test/mm-orders-api\n\ngo 1.24\n",
      "libs/mm-orders-api/api.go": "package api\n\nvar Orders = 1\n",
      "libs/mm-orders-api/src/index.ts": "export const ordersApi = 1;\n",
      "libs/mm-orders-core/go.mod": "module example.test/mm-orders-core\n\ngo 1.24\n",
      "libs/mm-orders-core/core.go":
        "package core\n\nimport (\n\t" +
        '"example.test/mm-orders-api"\n\t"example.test/mm-billing-api"\n\t"example.test/mm-billing-core"\n)\n\n' +
        "var Wiring = []any{api.Orders, api.Billing, core.Billing}\n",
      "libs/mm-orders-core/src/index.ts": "export const ordersCore = 1;\n",
      "libs/mm-billing-api/go.mod": "module example.test/mm-billing-api\n\ngo 1.24\n",
      "libs/mm-billing-api/api.go": "package api\n\nvar Billing = 1\n",
      "libs/mm-billing-api/src/index.ts": "export const billingApi = 1;\n",
      "libs/mm-billing-core/go.mod": "module example.test/mm-billing-core\n\ngo 1.24\n",
      "libs/mm-billing-core/core.go":
        'package core\n\nimport "example.test/mm-billing-api"\n\nvar Billing = api.Billing\n',
      "libs/mm-web/src/app.ts":
        'import { ordersApi } from "@corpus/orders-api";\nimport { ordersCore } from "@corpus/orders-core";\n' +
        'import { billingApi } from "../../mm-billing-api/src/index";\n\n' +
        "export const app = [ordersApi, ordersCore, billingApi];\n",
    },
    probes: [
      {
        file: "libs/mm-orders-core/core.go",
        imports: 3,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "example.test/mm-billing-core",
            target: "mm-billing-core",
          },
        ],
        denyAll: 3,
        why: "One module reaching another module's internals is the violation; the same file's imports of its own module and of the other module's api are what the style permits.",
      },
      {
        file: "libs/mm-billing-core/core.go",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "Inside one module, an internal reaching its own api crosses no boundary the law names.",
      },
      {
        file: "libs/mm-web/src/app.ts",
        imports: 3,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "@corpus/orders-core",
            target: "mm-orders-core",
          },
          {
            messageId: "noRelativeOrAbsoluteImportsAcrossLibraries",
            specifier: "../../mm-billing-api/src/index",
            target: "mm-billing-api",
          },
        ],
        denyAll: 3,
        why: "The same tag law that judged the Go imports above judges this TypeScript file, and the relative crossing shows the axis Go cannot break: the target project is one the web module is allowed to reach, and the spelling is the violation.",
      },
    ],
  },

  // ------------------------------------------------- topology rules (Go tree)
  {
    id: "application-and-test-boundaries-in-go",
    style: "layered (relaxed)",
    languages: ["go"],
    intent:
      "The rules that read the project's shape rather than its tags — an app, an e2e project, a library with no build target — reached from a Go file, where upstream reaches nothing at all.",
    projects: [
      { name: "tp-lib", root: "libs/tp-lib", tags: ["stack:lib"], targets: ["build"] },
      { name: "tp-support", root: "libs/tp-support", tags: ["stack:lib"] },
      { name: "tp-cli", root: "apps/tp-cli", type: "app", tags: ["stack:app"] },
      { name: "tp-cli-e2e", root: "apps/tp-cli-e2e", type: "e2e", tags: ["stack:e2e"] },
    ],
    depConstraints: [
      { sourceTag: "*", onlyDependOnLibsWithTags: ["stack:lib", "stack:app", "stack:e2e"] },
    ],
    options: { enforceBuildableLibDependency: true },
    files: {
      "libs/tp-lib/go.mod": "module example.test/tp-lib\n\ngo 1.24\n",
      "libs/tp-lib/reach.go":
        "package lib\n\nimport (\n\t" +
        '"example.test/tp-cli"\n\t"example.test/tp-cli-e2e"\n\t"example.test/tp-support"\n)\n\n' +
        "var Reach = []any{cli.Run, e2e.Spec, support.Helper}\n",
      "libs/tp-support/go.mod": "module example.test/tp-support\n\ngo 1.24\n",
      "libs/tp-support/support.go": "package support\n\nvar Helper = 1\n",
      "apps/tp-cli/go.mod": "module example.test/tp-cli\n\ngo 1.24\n",
      "apps/tp-cli/app.go":
        'package cli\n\nimport "example.test/tp-support"\n\nvar Run = support.Helper\n',
      "apps/tp-cli-e2e/go.mod": "module example.test/tp-cli-e2e\n\ngo 1.24\n",
      "apps/tp-cli-e2e/spec.go": "package e2e\n\nvar Spec = 1\n",
    },
    probes: [
      {
        file: "libs/tp-lib/reach.go",
        imports: 3,
        reports: [
          {
            messageId: "noImportsOfApps",
            specifier: "example.test/tp-cli",
            target: "tp-cli",
          },
          {
            messageId: "noImportsOfE2e",
            specifier: "example.test/tp-cli-e2e",
            target: "tp-cli-e2e",
          },
          {
            messageId: "noImportOfNonBuildableLibraries",
            specifier: "example.test/tp-support",
            target: "tp-support",
          },
        ],
        denyAll: 3,
        why: "Three shape rules on three imports of one file: an app, an e2e project, and a library declaring no build target, all reached from Go — every tag in this tree permits all three, so a tag-only engine would report nothing here.",
      },
      {
        file: "apps/tp-cli/app.go",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "The buildable-library rule only holds a library source, so an application reaching the same non-buildable library is silent — the near-miss that keeps the rule from reading as 'anything reaching tp-support'.",
      },
    ],
  },

  // ------------------------------- cycles and unconstrained projects (Python)
  {
    id: "cycles-and-unconstrained-projects-in-python",
    style: "modular monolith",
    languages: ["python"],
    intent:
      "Three ways a Python workspace loses its boundary without any tag being wrong: two packages importing each other, a project no constraint row matches, and a row that permits nothing.",
    projects: [
      { name: "cy-alpha", root: "libs/cy-alpha", tags: ["ring:alpha"] },
      { name: "cy-beta", root: "libs/cy-beta", tags: ["ring:beta"] },
      { name: "cy-loose", root: "libs/cy-loose", tags: [] },
      { name: "cy-sealed", root: "libs/cy-sealed", tags: ["ring:sealed"] },
    ],
    depConstraints: [
      { sourceTag: "ring:alpha", onlyDependOnLibsWithTags: ["ring:alpha", "ring:beta"] },
      { sourceTag: "ring:beta", onlyDependOnLibsWithTags: ["ring:alpha", "ring:beta"] },
      { sourceTag: "ring:sealed", onlyDependOnLibsWithTags: [] },
    ],
    files: {
      "libs/cy-alpha/pyproject.toml": '[project]\nname = "alpha"\nversion = "0.1.0"\n',
      "libs/cy-alpha/src/alpha/__init__.py": "",
      "libs/cy-alpha/src/alpha/node.py": "import beta.node\n\nPING = beta.node\n",
      "libs/cy-alpha/src/alpha/util.py": "from .node import PING\n\nUTIL = PING\n",
      "libs/cy-beta/pyproject.toml": '[project]\nname = "beta"\nversion = "0.1.0"\n',
      "libs/cy-beta/src/beta/__init__.py": "",
      "libs/cy-beta/src/beta/node.py": "import alpha.node\n\nPONG = alpha.node\n",
      "libs/cy-loose/pyproject.toml": '[project]\nname = "loose"\nversion = "0.1.0"\n',
      "libs/cy-loose/src/loose/__init__.py": "",
      "libs/cy-loose/src/loose/node.py": "import alpha.node\n\nLOOSE = alpha.node\n",
      "libs/cy-sealed/pyproject.toml": '[project]\nname = "sealed"\nversion = "0.1.0"\n',
      "libs/cy-sealed/src/sealed/__init__.py": "",
      "libs/cy-sealed/src/sealed/node.py": "import alpha.node\n\nSEALED = alpha.node\n",
    },
    probes: [
      {
        file: "libs/cy-alpha/src/alpha/node.py",
        imports: 1,
        reports: [
          { messageId: "noCircularDependencies", specifier: "beta.node", target: "cy-beta" },
        ],
        denyAll: 1,
        why: "Half of a cycle the tags permit outright — both rows allow the pair, and only the graph shows it closes.",
      },
      {
        file: "libs/cy-beta/src/beta/node.py",
        imports: 1,
        reports: [
          { messageId: "noCircularDependencies", specifier: "alpha.node", target: "cy-alpha" },
        ],
        denyAll: 1,
        why: "The other half, reported at its own site: a cycle read from one end only would leave the other file looking clean.",
      },
      {
        file: "libs/cy-alpha/src/alpha/util.py",
        imports: 1,
        reports: [],
        denyAll: 0,
        why: "A relative import inside the package reaches no second project, so nothing can report it — the near-miss that keeps the cycle above from reading as 'alpha reports on everything'.",
      },
      {
        file: "libs/cy-loose/src/loose/node.py",
        imports: 1,
        reports: [
          {
            messageId: "projectWithoutTagsCannotHaveDependencies",
            specifier: "alpha.node",
            target: "cy-alpha",
          },
        ],
        denyAll: 1,
        why: "A project no constraint row matches is an error, not a permission: the inversion that would let every mis-tagged project out of the boundary system silently.",
      },
      {
        file: "libs/cy-sealed/src/sealed/node.py",
        imports: 1,
        reports: [
          {
            messageId: "emptyOnlyTagsConstraintViolation",
            specifier: "alpha.node",
            target: "cy-alpha",
          },
        ],
        denyAll: 1,
        why: "An empty permit list is its own message: a row that names no tag forbids every dependency rather than allowing any.",
      },
    ],
  },

  // ------------------------------------- transitive dependencies (Go tree)
  {
    id: "transitive-dependency-ban-in-go",
    style: "layered (relaxed)",
    languages: ["go"],
    intent:
      "`banTransitiveDependencies` on a tree whose graph carries no package facts: every external import is reported, and the workspace's own project import beside it is not.",
    projects: [
      { name: "tr-client", root: "libs/tr-client", tags: ["stack:lib"] },
      { name: "tr-core", root: "libs/tr-core", tags: ["stack:lib"] },
    ],
    depConstraints: [{ sourceTag: "stack:lib", onlyDependOnLibsWithTags: ["stack:lib"] }],
    options: { banTransitiveDependencies: true },
    files: {
      "libs/tr-client/go.mod": "module example.test/tr-client\n\ngo 1.24\n",
      "libs/tr-client/client.go":
        "package client\n\nimport (\n\t" +
        '"fmt"\n\t"vendor.test/http-sdk"\n\t"example.test/tr-core"\n)\n\n' +
        "var Client = fmt.Sprint(httpsdk.Get, core.Name)\n",
      "libs/tr-client/pool.go":
        'package client\n\nimport "example.test/tr-client/internal/pool"\n\nvar Pool = pool.Handle\n',
      "libs/tr-client/internal/pool/pool.go": "package pool\n\nvar Handle = 1\n",
      "libs/tr-core/go.mod": "module example.test/tr-core\n\ngo 1.24\n",
      "libs/tr-core/core.go": "package core\n\nvar Name = 1\n",
    },
    probes: [
      {
        file: "libs/tr-client/client.go",
        imports: 3,
        reports: [
          { messageId: "noTransitiveDependencies", specifier: "fmt", target: "npm:fmt" },
          {
            messageId: "noTransitiveDependencies",
            specifier: "vendor.test/http-sdk",
            target: "npm:vendor.test/http-sdk",
          },
        ],
        denyAll: 5,
        why: "A native tree states no `declaredPackages`, so with the option on every external import is reported — Go's own standard library included, since the builtin exemption is Node's module list and knows nothing of `fmt`. The workspace project import in the same block is not external and stays silent.",
      },
      {
        file: "libs/tr-client/pool.go",
        imports: 1,
        reports: [],
        denyAll: 0,
        why: "An import of the project's own module path is not a dependency on anything, transitive or otherwise — the near-miss that keeps the option above from reading as 'every import is reported'.",
      },
    ],
  },

  // -------------------------------------------------- strict layering (Go)
  {
    id: "strict-layering-in-go",
    style: "layered (strict)",
    languages: ["go"],
    intent:
      "The pair to `layered-architecture-in-go`, which encodes the RELAXED reading: there each layer may reach every layer beneath it, so only an outward edge is a finding. Here each row names its own tier and the one immediately below it, which is the whole of strict layering — a downward edge that skips a tier is a violation even though it points the way the arrows do. Both readings are the same four rows with a different allow-list, so this case is what proves the difference is expressible at all rather than a matter of taste. `sl-view` is a second presentation-tier project that imports nothing, which is what lets the upward edge into it be judged on the tier axis instead of as a cycle.",
    projects: [
      { name: "sl-presentation", root: "libs/sl-presentation", tags: ["tier:presentation"] },
      { name: "sl-view", root: "libs/sl-view", tags: ["tier:presentation"] },
      { name: "sl-application", root: "libs/sl-application", tags: ["tier:application"] },
      { name: "sl-domain", root: "libs/sl-domain", tags: ["tier:domain"] },
      { name: "sl-infrastructure", root: "libs/sl-infrastructure", tags: ["tier:infrastructure"] },
    ],
    depConstraints: [
      {
        sourceTag: "tier:presentation",
        onlyDependOnLibsWithTags: ["tier:presentation", "tier:application"],
      },
      {
        sourceTag: "tier:application",
        onlyDependOnLibsWithTags: ["tier:application", "tier:domain"],
      },
      {
        sourceTag: "tier:domain",
        onlyDependOnLibsWithTags: ["tier:domain", "tier:infrastructure"],
      },
      { sourceTag: "tier:infrastructure", onlyDependOnLibsWithTags: ["tier:infrastructure"] },
    ],
    files: {
      "libs/sl-presentation/go.mod": "module example.test/sl-presentation\n\ngo 1.24\n",
      "libs/sl-presentation/handler.go":
        'package presentation\n\nimport "example.test/sl-application"\n\nvar Handler = application.Service\n',
      "libs/sl-presentation/skip.go":
        'package presentation\n\nimport "example.test/sl-domain"\n\nvar Skipped = domain.Model\n',
      "libs/sl-view/go.mod": "module example.test/sl-view\n\ngo 1.24\n",
      "libs/sl-view/view.go":
        "// Package view imports nothing, so an edge into it cannot close a cycle.\npackage view\n\nvar Widget = 1\n",
      "libs/sl-application/go.mod": "module example.test/sl-application\n\ngo 1.24\n",
      "libs/sl-application/service.go":
        'package application\n\nimport "example.test/sl-domain"\n\nvar Service = domain.Model\n',
      "libs/sl-application/bypass.go":
        'package application\n\nimport "example.test/sl-infrastructure"\n\nvar Bypass = infrastructure.Conn\n',
      "libs/sl-domain/go.mod": "module example.test/sl-domain\n\ngo 1.24\n",
      "libs/sl-domain/model.go":
        'package domain\n\nimport "example.test/sl-infrastructure"\n\nvar Model = infrastructure.Conn\n',
      "libs/sl-domain/upward.go":
        'package domain\n\nimport "example.test/sl-view"\n\nvar Upward = view.Widget\n',
      "libs/sl-infrastructure/go.mod": "module example.test/sl-infrastructure\n\ngo 1.24\n",
      "libs/sl-infrastructure/db.go": "package infrastructure\n\nvar Conn = 1\n",
    },
    probes: [
      {
        file: "libs/sl-presentation/handler.go",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "The one downward edge strict layering permits at this tier — presentation to the tier immediately below it.",
      },
      {
        file: "libs/sl-presentation/skip.go",
        imports: 1,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "example.test/sl-domain",
            target: "sl-domain",
          },
        ],
        denyAll: 1,
        why: "The finding strict layering exists for and relaxed layering has no way to express: the edge points downward, which every layered reading allows, and skips the tier between, which only this one forbids.",
      },
      {
        file: "libs/sl-application/service.go",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "The same adjacent-tier shape one rung down, so the near-miss is measured on more than the topmost row.",
      },
      {
        file: "libs/sl-application/bypass.go",
        imports: 1,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "example.test/sl-infrastructure",
            target: "sl-infrastructure",
          },
        ],
        denyAll: 1,
        why: "A second skipped tier, reported by a different row than the first — an engine holding only the first row would call this file clean.",
      },
      {
        file: "libs/sl-domain/model.go",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "The bottom rung's own adjacent edge, which the same table that reported two skips must leave alone.",
      },
      {
        file: "libs/sl-domain/upward.go",
        imports: 1,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "example.test/sl-view",
            target: "sl-view",
          },
        ],
        denyAll: 1,
        why: "The forbidden upward dependency, judged on the tier axis rather than as a cycle: `sl-view` imports nothing, so nothing reaches back and `noCircularDependencies` never fires ahead of the tag block.",
      },
    ],
  },

  // ------------------------------------------------------- onion (Python)
  {
    id: "onion-rings-in-python",
    style: "onion",
    languages: ["python"],
    intent:
      "Onion's constraint table is `clean-architecture-dependency-inversion-in-rust`'s under a different vocabulary — four rings where that case has four layers, isomorphic row for row. That is why no onion PACK ships (`../../../../docs/usage/presets.md`): two copies of one law is two files to keep in step against no check. A corpus case is the opposite kind of artefact — it is evidence, not law, and nothing has to keep it in step with anything — so what this one has to earn is a shape no other case measures. It earns it twice. The barrel probe is a ring's own `__init__.py` re-exporting a name from outside the onion, which is an outward dependency written where nobody reads for one and which only Python spells this way. And `on-infra/repo.py` reaches three rings inward from one file, so three edges have to stay silent together rather than one at a time. The ring-SKIP near-miss beside them is deliberately not claimed as new: `layered-architecture-in-go` already carries that shape incidentally (`libs/go-adapter/repo.go` reaches the domain two layers in). What is new is that it is LABELED here, as the explicit counterpart to the edge `strict-layering-in-go` reports — one silence and one finding on the same shape, in two languages, decided by the table and nothing else. The outward edges point at `on-shell`, an outermost-ring project that imports nothing.",
    projects: [
      { name: "on-model", root: "libs/on-model", tags: ["ring:domain-model"] },
      { name: "on-services", root: "libs/on-services", tags: ["ring:domain-services"] },
      { name: "on-app", root: "libs/on-app", tags: ["ring:application-services"] },
      { name: "on-infra", root: "libs/on-infra", tags: ["ring:infrastructure"] },
      { name: "on-shell", root: "libs/on-shell", tags: ["ring:infrastructure"] },
    ],
    depConstraints: [
      { sourceTag: "ring:domain-model", onlyDependOnLibsWithTags: ["ring:domain-model"] },
      {
        sourceTag: "ring:domain-services",
        onlyDependOnLibsWithTags: ["ring:domain-services", "ring:domain-model"],
      },
      {
        sourceTag: "ring:application-services",
        onlyDependOnLibsWithTags: [
          "ring:application-services",
          "ring:domain-services",
          "ring:domain-model",
        ],
      },
      {
        sourceTag: "ring:infrastructure",
        onlyDependOnLibsWithTags: [
          "ring:infrastructure",
          "ring:application-services",
          "ring:domain-services",
          "ring:domain-model",
        ],
      },
    ],
    files: {
      "libs/on-model/pyproject.toml": '[project]\nname = "on_model"\nversion = "0.1.0"\n',
      "libs/on-model/src/on_model/__init__.py":
        "from on_shell.wire import WIRE\n\nSURFACE = WIRE\n",
      "libs/on-model/src/on_model/entity.py": "ENTITY = 1\n",
      "libs/on-model/src/on_model/value.py": "from .entity import ENTITY\n\nVALUE = ENTITY\n",
      "libs/on-services/pyproject.toml": '[project]\nname = "on_services"\nversion = "0.1.0"\n',
      "libs/on-services/src/on_services/__init__.py": "",
      "libs/on-services/src/on_services/policy.py":
        "from on_model.entity import ENTITY\n\nPOLICY = ENTITY\n",
      "libs/on-app/pyproject.toml": '[project]\nname = "on_app"\nversion = "0.1.0"\n',
      "libs/on-app/src/on_app/__init__.py": "",
      "libs/on-app/src/on_app/service.py":
        "from on_model.entity import ENTITY\nfrom on_services.policy import POLICY\n\nSERVICE = (ENTITY, POLICY)\n",
      "libs/on-app/src/on_app/leak.py": "from on_shell.wire import WIRE\n\nLEAK = WIRE\n",
      "libs/on-infra/pyproject.toml": '[project]\nname = "on_infra"\nversion = "0.1.0"\n',
      "libs/on-infra/src/on_infra/__init__.py": "",
      "libs/on-infra/src/on_infra/repo.py":
        "from on_app.service import SERVICE\nfrom on_services.policy import POLICY\nfrom on_model.entity import ENTITY\n\nREPO = (SERVICE, POLICY, ENTITY)\n",
      "libs/on-shell/pyproject.toml": '[project]\nname = "on_shell"\nversion = "0.1.0"\n',
      "libs/on-shell/src/on_shell/__init__.py": "",
      "libs/on-shell/src/on_shell/wire.py":
        "# This distribution imports nothing, so an edge into it cannot close a cycle.\nWIRE = 1\n",
    },
    probes: [
      {
        file: "libs/on-model/src/on_model/__init__.py",
        imports: 1,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "on_shell.wire",
            target: "on-shell",
          },
        ],
        denyAll: 1,
        why: "The innermost ring's own public surface re-exporting a name from the outermost one. A barrel is where an outward dependency hides from review, and the engine reads it as the import it is.",
      },
      {
        file: "libs/on-model/src/on_model/value.py",
        imports: 1,
        reports: [],
        denyAll: 0,
        why: "A relative import inside one distribution never leaves the project, so no tag rule is reached and the deny-all policy has nothing to forbid either; the import count beside it is what proves the site was read.",
      },
      {
        file: "libs/on-services/src/on_services/policy.py",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "One ring inward, the direction every onion edge is allowed to take.",
      },
      {
        file: "libs/on-app/src/on_app/service.py",
        imports: 2,
        reports: [],
        denyAll: 2,
        why: "The edge that separates onion from strict layering: `on_model` is two rings inward, skipping `on-services`, and onion permits any inward depth. `strict-layering-in-go` reports the same shape, which is what makes this silence a verdict about the table rather than about the engine.",
      },
      {
        file: "libs/on-app/src/on_app/leak.py",
        imports: 1,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "on_shell.wire",
            target: "on-shell",
          },
        ],
        denyAll: 1,
        why: "An application service reaching the outermost ring — the dependency rule broken from a middle ring rather than from the centre.",
      },
      {
        file: "libs/on-infra/src/on_infra/repo.py",
        imports: 3,
        reports: [],
        denyAll: 3,
        why: "The outermost ring may reach every ring inside it, at every depth; three silent edges in one file is the widest near-miss the table has.",
      },
    ],
  },

  // ------------------------------ clean architecture, inverted (Rust)
  {
    id: "clean-architecture-dependency-inversion-in-rust",
    style: "clean architecture",
    languages: ["rust"],
    intent:
      "What separates clean architecture from layering is not the direction of the arrows but which arrows are allowed to be inverted, and no case here measured that until this one. `ca-driver` is an outermost-ring crate that implements a trait the use-case ring declares: its source dependency points inward, at the abstraction, while the concrete direction at runtime points outward — the shape an engine that read 'frameworks depend on nothing' as a rule about arrows would report. It must stay silent. Beside it, `ca-entities/src/surface.rs` launders an outward dependency through a `pub use`, which is the only place a Rust crate can hide one, and the interactor reaches outward directly. The outward edges point at `ca-leaf`, a frameworks-ring crate that uses nothing.",
    projects: [
      { name: "ca-entities", root: "libs/ca-entities", tags: ["layer:entities"] },
      { name: "ca-usecases", root: "libs/ca-usecases", tags: ["layer:use-cases"] },
      { name: "ca-adapters", root: "libs/ca-adapters", tags: ["layer:interface-adapters"] },
      { name: "ca-driver", root: "libs/ca-driver", tags: ["layer:frameworks"] },
      { name: "ca-leaf", root: "libs/ca-leaf", tags: ["layer:frameworks"] },
    ],
    depConstraints: [
      { sourceTag: "layer:entities", onlyDependOnLibsWithTags: ["layer:entities"] },
      {
        sourceTag: "layer:use-cases",
        onlyDependOnLibsWithTags: ["layer:use-cases", "layer:entities"],
      },
      {
        sourceTag: "layer:interface-adapters",
        onlyDependOnLibsWithTags: ["layer:interface-adapters", "layer:use-cases", "layer:entities"],
      },
      {
        sourceTag: "layer:frameworks",
        onlyDependOnLibsWithTags: [
          "layer:frameworks",
          "layer:interface-adapters",
          "layer:use-cases",
          "layer:entities",
        ],
      },
    ],
    files: {
      "libs/ca-entities/Cargo.toml": '[package]\nname = "ca_entities"\nversion = "0.1.0"\n',
      "libs/ca-entities/src/lib.rs": "pub mod order;\npub mod surface;\n",
      "libs/ca-entities/src/order.rs": "pub struct Order;\n",
      "libs/ca-entities/src/surface.rs": "pub use ca_leaf::Wire;\n",
      "libs/ca-usecases/Cargo.toml": '[package]\nname = "ca_usecases"\nversion = "0.1.0"\n',
      "libs/ca-usecases/src/lib.rs": "pub mod interactor;\npub mod port;\n",
      "libs/ca-usecases/src/port.rs":
        "use ca_entities::order::Order;\n\npub trait Repository {\n    fn save(&self, order: &Order);\n}\n",
      "libs/ca-usecases/src/interactor.rs":
        "use super::port::Repository;\nuse ca_leaf::Wire;\n\npub fn run(_: &dyn Repository, _: &Wire) {}\n",
      "libs/ca-adapters/Cargo.toml": '[package]\nname = "ca_adapters"\nversion = "0.1.0"\n',
      "libs/ca-adapters/src/lib.rs":
        "use ca_entities::order::Order;\nuse ca_usecases::port::Repository;\n\npub fn present(_: &dyn Repository, _: &Order) {}\n",
      "libs/ca-driver/Cargo.toml": '[package]\nname = "ca_driver"\nversion = "0.1.0"\n',
      "libs/ca-driver/src/lib.rs":
        "use ca_entities::order::Order;\nuse ca_usecases::port::Repository;\n\npub struct SqlRepository;\n\nimpl Repository for SqlRepository {\n    fn save(&self, _: &Order) {}\n}\n",
      "libs/ca-leaf/Cargo.toml": '[package]\nname = "ca_leaf"\nversion = "0.1.0"\n',
      "libs/ca-leaf/src/lib.rs":
        "// This crate uses nothing, so an edge into it cannot close a cycle.\npub struct Wire;\n",
    },
    probes: [
      {
        file: "libs/ca-entities/src/surface.rs",
        imports: 1,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "ca_leaf::Wire",
            target: "ca-leaf",
          },
        ],
        denyAll: 1,
        why: "A `pub use` is a re-export, and a re-export of a framework type from the entity ring's public surface is the dependency rule broken in the one syntax that reads as an export rather than an import.",
      },
      {
        file: "libs/ca-usecases/src/port.rs",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "The use-case ring naming an entity type in the port it declares — the inward edge the whole style is built on.",
      },
      {
        file: "libs/ca-usecases/src/interactor.rs",
        imports: 2,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "ca_leaf::Wire",
            target: "ca-leaf",
          },
        ],
        denyAll: 1,
        why: "One outward reach and one intra-crate `super::` path in the same file: the first reports, the second is ordinary Rust that never leaves the crate and stays silent under both policies.",
      },
      {
        file: "libs/ca-adapters/src/lib.rs",
        imports: 2,
        reports: [],
        denyAll: 2,
        why: "An interface adapter naming both inner rings, which is the layer's whole job.",
      },
      {
        file: "libs/ca-driver/src/lib.rs",
        imports: 2,
        reports: [],
        denyAll: 2,
        why: "The dependency inversion itself: an outermost-ring crate implements a trait the use-case ring declared, so its source dependencies point inward while the runtime direction is outward. An engine that judged the runtime direction, or that read 'the outer ring depends on nothing' off a diagram, reports here — and would be reporting the one edge the style requires.",
      },
    ],
  },

  // ------------------------------------------- vertical slices (Go)
  {
    id: "vertical-slice-features-in-go",
    style: "vertical slice",
    languages: ["go"],
    intent:
      "A feature-partitioned tree rather than a layered one: the axis is `feature:`, every slice owns its whole stack, and the only thing two slices may share is the kernel. Three things are measured that no layered case can reach — a cross-feature edge, the kernel inverting into a feature, and `vs-checkout`, a slice added to the tree with no constraint row of its own. The last is the one that matters for a partitioned style: the table has to be extended once per slice, so the question is what happens when somebody forgets. It reports, because a source project matching no row is upstream's `projectWithoutTagsCannotHaveDependencies` rather than a pass — which is what makes the one-row-per-slice encoding fail closed as the tree grows. `vs-catalog` imports nothing, so the edges into it are judged on the feature axis instead of as cycles.",
    projects: [
      { name: "vs-orders", root: "libs/vs-orders", tags: ["feature:orders"] },
      { name: "vs-catalog", root: "libs/vs-catalog", tags: ["feature:catalog"] },
      { name: "vs-checkout", root: "libs/vs-checkout", tags: ["feature:checkout"] },
      { name: "vs-kernel", root: "libs/vs-kernel", tags: ["layer:shared-kernel"] },
      { name: "vs-host", root: "libs/vs-host", tags: ["layer:host"] },
    ],
    depConstraints: [
      {
        sourceTag: "feature:orders",
        onlyDependOnLibsWithTags: ["feature:orders", "layer:shared-kernel"],
      },
      {
        sourceTag: "feature:catalog",
        onlyDependOnLibsWithTags: ["feature:catalog", "layer:shared-kernel"],
      },
      { sourceTag: "layer:shared-kernel", onlyDependOnLibsWithTags: ["layer:shared-kernel"] },
      {
        sourceTag: "layer:host",
        onlyDependOnLibsWithTags: [
          "layer:host",
          "feature:orders",
          "feature:catalog",
          "layer:shared-kernel",
        ],
      },
    ],
    files: {
      "libs/vs-orders/go.mod": "module example.test/vs-orders\n\ngo 1.24\n",
      "libs/vs-orders/slice.go":
        'package orders\n\nimport "example.test/vs-kernel"\n\nvar Slice = kernel.Clock\n',
      "libs/vs-orders/cross.go":
        'package orders\n\nimport "example.test/vs-catalog"\n\nvar Cross = catalog.Item\n',
      "libs/vs-catalog/go.mod": "module example.test/vs-catalog\n\ngo 1.24\n",
      "libs/vs-catalog/catalog.go":
        "// Package catalog imports nothing, so an edge into it cannot close a cycle.\npackage catalog\n\nvar Item = 1\n",
      "libs/vs-checkout/go.mod": "module example.test/vs-checkout\n\ngo 1.24\n",
      "libs/vs-checkout/checkout.go":
        'package checkout\n\nimport "example.test/vs-kernel"\n\nvar Checkout = kernel.Clock\n',
      "libs/vs-kernel/go.mod": "module example.test/vs-kernel\n\ngo 1.24\n",
      "libs/vs-kernel/kernel.go": "package kernel\n\nvar Clock = 1\n",
      "libs/vs-kernel/inverted.go":
        'package kernel\n\nimport "example.test/vs-catalog"\n\nvar Inverted = catalog.Item\n',
      "libs/vs-host/go.mod": "module example.test/vs-host\n\ngo 1.24\n",
      "libs/vs-host/main.go":
        'package host\n\nimport (\n\t"example.test/vs-catalog"\n\t"example.test/vs-orders"\n)\n\nvar App = []any{catalog.Item, orders.Slice}\n',
    },
    probes: [
      {
        file: "libs/vs-orders/slice.go",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "The kernel is the one thing a slice may reach outside itself.",
      },
      {
        file: "libs/vs-orders/cross.go",
        imports: 1,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "example.test/vs-catalog",
            target: "vs-catalog",
          },
        ],
        denyAll: 1,
        why: "One slice reaching another is the violation the style is defined by; there is no layer axis in this tree for it to be a violation on.",
      },
      {
        file: "libs/vs-kernel/inverted.go",
        imports: 1,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "example.test/vs-catalog",
            target: "vs-catalog",
          },
        ],
        denyAll: 1,
        why: "The kernel reaching into a feature inverts what a shared kernel is: everything may depend on it, so anything it depends on is shared by every slice whether or not that slice asked.",
      },
      {
        file: "libs/vs-checkout/checkout.go",
        imports: 1,
        reports: [
          {
            messageId: "projectWithoutTagsCannotHaveDependencies",
            specifier: "example.test/vs-kernel",
            target: "vs-kernel",
          },
        ],
        denyAll: 1,
        why: "A slice added to the tree whose `feature:` value matches no row in the table. The import it makes is one the other slices are explicitly allowed, so an engine reading 'no rule said no' as a pass would be silent here — and every slice added after this one would inherit that silence.",
      },
      {
        file: "libs/vs-host/main.go",
        imports: 2,
        reports: [],
        denyAll: 2,
        why: "The composition root is the one project allowed to see more than one slice, which is what keeps the cross-feature finding above from being a claim that nothing may.",
      },
    ],
  },

  // ------------------------- service boundaries, combo rows (Python)
  {
    id: "service-boundaries-with-combo-rows-in-python",
    style: "microservice repository",
    languages: ["python"],
    intent:
      "A repository of services, where the boundary is not one axis but two: which service a project belongs to, and whether it is that service's published contract or its private inside. Every other case here keys its rows on a single tag; these key on `allSourceTags`, which binds only when the source carries EVERY tag listed. That is the one tag mechanism no case in this directory measured, and the direction it fails in is silent: read as OR, the row below would match `ms-orders-tooling` — a project on the service axis with no visibility tag at all — and wave its import through, where the AND reading leaves it matching no row and reports. The near-miss beside it is the point of a published contract: one service reaching another's contract is what the style is for, and reaching its inside is not.",
    projects: [
      {
        name: "ms-orders-api",
        root: "libs/ms-orders-api",
        tags: ["service:orders", "visibility:published"],
      },
      {
        name: "ms-orders-core",
        root: "libs/ms-orders-core",
        tags: ["service:orders", "visibility:internal"],
      },
      { name: "ms-orders-tooling", root: "libs/ms-orders-tooling", tags: ["service:orders"] },
      {
        name: "ms-billing-api",
        root: "libs/ms-billing-api",
        tags: ["service:billing", "visibility:published"],
      },
      {
        name: "ms-billing-core",
        root: "libs/ms-billing-core",
        tags: ["service:billing", "visibility:internal"],
      },
      { name: "ms-platform", root: "libs/ms-platform", tags: ["layer:platform"] },
    ],
    depConstraints: [
      {
        allSourceTags: ["service:orders", "visibility:internal"],
        onlyDependOnLibsWithTags: ["service:orders", "visibility:published", "layer:platform"],
      },
      {
        allSourceTags: ["service:billing", "visibility:internal"],
        onlyDependOnLibsWithTags: ["service:billing", "visibility:published", "layer:platform"],
      },
      { sourceTag: "visibility:published", onlyDependOnLibsWithTags: ["layer:platform"] },
      { sourceTag: "layer:platform", onlyDependOnLibsWithTags: ["layer:platform"] },
    ],
    files: {
      "libs/ms-orders-api/pyproject.toml": '[project]\nname = "ms_orders_api"\nversion = "0.1.0"\n',
      "libs/ms-orders-api/src/ms_orders_api/__init__.py": "",
      "libs/ms-orders-api/src/ms_orders_api/contract.py": "ORDER = 1\n",
      "libs/ms-orders-core/pyproject.toml":
        '[project]\nname = "ms_orders_core"\nversion = "0.1.0"\n',
      "libs/ms-orders-core/src/ms_orders_core/__init__.py": "",
      "libs/ms-orders-core/src/ms_orders_core/service.py":
        "from ms_orders_api.contract import ORDER\nfrom ms_billing_api.contract import INVOICE\n" +
        "from ms_billing_core.ledger import LEDGER\nfrom ms_platform.log import LOG\n\n" +
        "SERVICE = (ORDER, INVOICE, LEDGER, LOG)\n",
      "libs/ms-orders-tooling/pyproject.toml":
        '[project]\nname = "ms_orders_tooling"\nversion = "0.1.0"\n',
      "libs/ms-orders-tooling/src/ms_orders_tooling/__init__.py": "",
      "libs/ms-orders-tooling/src/ms_orders_tooling/tool.py":
        "from ms_platform.log import LOG\n\nTOOL = LOG\n",
      "libs/ms-billing-api/pyproject.toml":
        '[project]\nname = "ms_billing_api"\nversion = "0.1.0"\n',
      "libs/ms-billing-api/src/ms_billing_api/__init__.py": "",
      "libs/ms-billing-api/src/ms_billing_api/contract.py": "INVOICE = 1\n",
      "libs/ms-billing-core/pyproject.toml":
        '[project]\nname = "ms_billing_core"\nversion = "0.1.0"\n',
      "libs/ms-billing-core/src/ms_billing_core/__init__.py": "",
      "libs/ms-billing-core/src/ms_billing_core/ledger.py":
        "from ms_platform.log import LOG\n\nLEDGER = LOG\n",
      "libs/ms-platform/pyproject.toml": '[project]\nname = "ms_platform"\nversion = "0.1.0"\n',
      "libs/ms-platform/src/ms_platform/__init__.py": "",
      "libs/ms-platform/src/ms_platform/log.py":
        "# This distribution imports nothing, so an edge into it cannot close a cycle.\nLOG = 1\n",
    },
    probes: [
      {
        file: "libs/ms-orders-core/src/ms_orders_core/service.py",
        imports: 4,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "ms_billing_core.ledger",
            target: "ms-billing-core",
          },
        ],
        denyAll: 4,
        why: "Four edges out of one service's private inside, and exactly one of them is a finding: its own contract, the other service's contract and the platform library are all permitted, and reaching the other service's inside is not. A combo row that matched on either tag rather than both would still allow all four.",
      },
      {
        file: "libs/ms-billing-core/src/ms_billing_core/ledger.py",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "The second combo row, held on a different service, so the near-miss is measured on more than the row the positive above used.",
      },
      {
        file: "libs/ms-orders-tooling/src/ms_orders_tooling/tool.py",
        imports: 1,
        reports: [
          {
            messageId: "projectWithoutTagsCannotHaveDependencies",
            specifier: "ms_platform.log",
            target: "ms-platform",
          },
        ],
        denyAll: 1,
        why: "The discriminator for `allSourceTags`: this project carries `service:orders` and nothing on the visibility axis, so the orders combo row does not bind and no other row matches it either. The import is one every other row in the table permits, so an OR reading of the combo row is silent here and correct only by accident everywhere else.",
      },
    ],
  },

  // ------------------------------------------------------------- layered (Java)
  {
    id: "layered-architecture-in-java",
    style: "layered (relaxed)",
    languages: ["java"],
    intent:
      "The relaxed layering of `layered-architecture-in-go`, restated in Java so the JVM shapes are labeled too: packages resolve through a content-derived index rather than a module path, an untagged project is the importer, and the external ban carries a dotted glob. The transport project imports nothing, for the same cycle-avoidance reason its Go twin does.",
    projects: [
      { name: "j-domain", root: "libs/j-domain", tags: ["layer:domain"] },
      { name: "j-usecase", root: "libs/j-usecase", tags: ["layer:usecase"] },
      { name: "j-adapter", root: "libs/j-adapter", tags: ["layer:adapter"] },
      { name: "j-util", root: "libs/j-util", tags: [] },
    ],
    depConstraints: [
      { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
      { sourceTag: "layer:usecase", onlyDependOnLibsWithTags: ["layer:domain", "layer:usecase"] },
      {
        sourceTag: "layer:adapter",
        onlyDependOnLibsWithTags: ["layer:domain", "layer:usecase", "layer:adapter"],
        bannedExternalImports: ["vendor.test.shellsdk*"],
      },
    ],
    files: {
      "libs/j-domain/src/main/java/test/corpus/jvm/domain/Policy.java":
        "package test.corpus.jvm.domain;\n\nclass Policy {}\n",
      "libs/j-usecase/src/main/java/test/corpus/jvm/usecase/Service.java":
        "package test.corpus.jvm.usecase;\n\nimport test.corpus.jvm.domain.Policy;\nimport test.corpus.jvm.adapter.Repo;\n\nclass Service { Policy p; Repo r; }\n",
      "libs/j-usecase/src/main/java/test/corpus/jvm/usecase/Sdk.java":
        "package test.corpus.jvm.usecase;\n\nimport vendor.test.shellsdk.Shell;\n\nclass Sdk { Shell shell; }\n",
      "libs/j-adapter/src/main/java/test/corpus/jvm/adapter/Repo.java":
        "package test.corpus.jvm.adapter;\n\nimport test.corpus.jvm.domain.Policy;\nimport test.corpus.jvm.adapter.internal.Store;\n\nclass Repo { Policy p; Store store; }\n",
      "libs/j-adapter/src/main/java/test/corpus/jvm/adapter/internal/Store.java":
        "package test.corpus.jvm.adapter.internal;\n\nclass Store {}\n",
      "libs/j-adapter/src/main/java/test/corpus/jvm/adapter/Gateway.java":
        "package test.corpus.jvm.adapter;\n\nimport test.corpus.jvm.adapter.internal.Store;\nimport vendor.test.shellsdk.Shell;\n\nclass Gateway { Store store; Shell shell; }\n",
      "libs/j-util/src/main/java/test/corpus/jvm/util/Clock.java":
        "package test.corpus.jvm.util;\n\nimport test.corpus.jvm.domain.Policy;\n\nclass Clock { Policy p; }\n",
    },
    probes: [
      {
        file: "libs/j-domain/src/main/java/test/corpus/jvm/domain/Policy.java",
        imports: 0,
        reports: [],
        denyAll: 0,
        why: "The innermost layer importing nothing — recorded so the case's zero-finding claim about this file is a measurement, not an omission.",
      },
      {
        file: "libs/j-usecase/src/main/java/test/corpus/jvm/usecase/Service.java",
        imports: 2,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "test.corpus.jvm.adapter.Repo",
            target: "j-adapter",
          },
        ],
        denyAll: 2,
        why: "One crossing the layering permits beside one it forbids, in one import list — the domain import must stay silent while the outward adapter import reports.",
      },
      {
        file: "libs/j-usecase/src/main/java/test/corpus/jvm/usecase/Sdk.java",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "The same external SDK the adapter layer is banned from, imported by a layer no ban row names — a dotted external ban binds the tag that carries it and nothing else.",
      },
      {
        file: "libs/j-adapter/src/main/java/test/corpus/jvm/adapter/Repo.java",
        imports: 2,
        reports: [],
        denyAll: 1,
        why: "Both imports are what the layering permits — reporting either would invert the axis. Under the forbid-everything law exactly one reports: the domain crossing; the other resolves into this very project, which no law can reach.",
      },
      {
        file: "libs/j-adapter/src/main/java/test/corpus/jvm/adapter/Gateway.java",
        imports: 2,
        reports: [
          {
            messageId: "bannedExternalImportsViolation",
            specifier: "vendor.test.shellsdk.Shell",
            target: "npm:vendor.test.shellsdk.Shell",
          },
        ],
        denyAll: 1,
        why: "An own-project import stays silent under both laws while the dotted-glob ban fires on the line below it — the two answers in one file come from different rules, and only one of them can ever report.",
      },
      {
        file: "libs/j-util/src/main/java/test/corpus/jvm/util/Clock.java",
        imports: 1,
        reports: [
          {
            messageId: "projectWithoutTagsCannotHaveDependencies",
            specifier: "test.corpus.jvm.domain.Policy",
            target: "j-domain",
          },
        ],
        denyAll: 1,
        why: "A project no constraint row matches is an error, not a permission — Java's content-derived package index attributes the file first, then the rule judges it like any other language's.",
      },
    ],
  },

  // ------------------------------------------- layered architecture (Maven reactor)
  {
    id: "layered-architecture-in-maven",
    style: "layered (relaxed)",
    languages: ["java"],
    intent:
      "The relaxed layering of `layered-architecture-in-java`, restated over a root-parent Maven reactor: the parent pom sits at the workspace root while the children sit two levels deep, so the default ../pom.xml holds nothing and the parent resolves by coordinates across the tracked poms — the exact shape that refused the whole run before that fallback existed (#372). No child declares a groupId of its own; every identity below the reactor inherits through that root parent, and the manifest edges between children draw through the same inherited coordinates.",
    projects: [
      { name: "reactor", root: "", tags: [] },
      { name: "m-domain", root: "libs/m-domain", tags: ["layer:domain"] },
      { name: "m-usecase", root: "libs/m-usecase", tags: ["layer:usecase"] },
      { name: "m-adapter", root: "libs/m-adapter", tags: ["layer:adapter"] },
      { name: "m-util", root: "libs/m-util", tags: [] },
    ],
    depConstraints: [
      { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
      { sourceTag: "layer:usecase", onlyDependOnLibsWithTags: ["layer:domain", "layer:usecase"] },
      {
        sourceTag: "layer:adapter",
        onlyDependOnLibsWithTags: ["layer:domain", "layer:usecase", "layer:adapter"],
        bannedExternalImports: ["vendor.test.shellsdk*"],
      },
    ],
    files: {
      "pom.xml": [
        "<project>",
        "  <groupId>com.corpus</groupId>",
        "  <artifactId>reactor</artifactId>",
        "  <version>1.0.0</version>",
        "  <packaging>pom</packaging>",
        "  <modules>",
        "    <module>libs/m-domain</module>",
        "    <module>libs/m-usecase</module>",
        "    <module>libs/m-adapter</module>",
        "    <module>libs/m-util</module>",
        "  </modules>",
        "</project>",
      ].join("\n"),
      "libs/m-domain/pom.xml": [
        "<project>",
        "  <parent><groupId>com.corpus</groupId><artifactId>reactor</artifactId></parent>",
        "  <artifactId>m-domain</artifactId>",
        "</project>",
      ].join("\n"),
      "libs/m-usecase/pom.xml": [
        "<project>",
        "  <parent><groupId>com.corpus</groupId><artifactId>reactor</artifactId></parent>",
        "  <artifactId>m-usecase</artifactId>",
        "  <dependencies>",
        "    <dependency><groupId>com.corpus</groupId><artifactId>m-domain</artifactId></dependency>",
        "  </dependencies>",
        "</project>",
      ].join("\n"),
      "libs/m-adapter/pom.xml": [
        "<project>",
        "  <parent><groupId>com.corpus</groupId><artifactId>reactor</artifactId></parent>",
        "  <artifactId>m-adapter</artifactId>",
        "  <dependencies>",
        "    <dependency><groupId>com.corpus</groupId><artifactId>m-domain</artifactId></dependency>",
        "  </dependencies>",
        "</project>",
      ].join("\n"),
      "libs/m-util/pom.xml": [
        "<project>",
        "  <parent><groupId>com.corpus</groupId><artifactId>reactor</artifactId></parent>",
        "  <artifactId>m-util</artifactId>",
        "</project>",
      ].join("\n"),
      "libs/m-domain/src/main/java/test/corpus/maven/domain/Policy.java":
        "package test.corpus.maven.domain;\n\nclass Policy {}\n",
      "libs/m-usecase/src/main/java/test/corpus/maven/usecase/Service.java":
        "package test.corpus.maven.usecase;\n\nimport test.corpus.maven.domain.Policy;\nimport test.corpus.maven.adapter.Repo;\n\nclass Service { Policy p; Repo r; }\n",
      "libs/m-usecase/src/main/java/test/corpus/maven/usecase/Sdk.java":
        "package test.corpus.maven.usecase;\n\nimport vendor.test.shellsdk.Shell;\n\nclass Sdk { Shell shell; }\n",
      "libs/m-adapter/src/main/java/test/corpus/maven/adapter/Repo.java":
        "package test.corpus.maven.adapter;\n\nimport test.corpus.maven.domain.Policy;\nimport test.corpus.maven.adapter.internal.Store;\n\nclass Repo { Policy p; Store store; }\n",
      "libs/m-adapter/src/main/java/test/corpus/maven/adapter/internal/Store.java":
        "package test.corpus.maven.adapter.internal;\n\nclass Store {}\n",
      "libs/m-adapter/src/main/java/test/corpus/maven/adapter/Gateway.java":
        "package test.corpus.maven.adapter;\n\nimport test.corpus.maven.adapter.internal.Store;\nimport vendor.test.shellsdk.Shell;\n\nclass Gateway { Store store; Shell shell; }\n",
      "libs/m-util/src/main/java/test/corpus/maven/util/Clock.java":
        "package test.corpus.maven.util;\n\nimport test.corpus.maven.domain.Policy;\n\nclass Clock { Policy p; }\n",
    },
    probes: [
      {
        file: "libs/m-domain/src/main/java/test/corpus/maven/domain/Policy.java",
        imports: 0,
        reports: [],
        denyAll: 0,
        why: "The innermost layer importing nothing — recorded so the case's zero-finding claim about this file is a measurement, not an omission.",
      },
      {
        file: "libs/m-usecase/src/main/java/test/corpus/maven/usecase/Service.java",
        imports: 2,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "test.corpus.maven.adapter.Repo",
            target: "m-adapter",
          },
        ],
        denyAll: 2,
        why: "One crossing the layering permits beside one it forbids, in one import list — the domain import must stay silent while the outward adapter import reports.",
      },
      {
        file: "libs/m-usecase/src/main/java/test/corpus/maven/usecase/Sdk.java",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "The same external SDK the adapter layer is banned from, imported by a layer no ban row names — a dotted external ban binds the tag that carries it and nothing else.",
      },
      {
        file: "libs/m-adapter/src/main/java/test/corpus/maven/adapter/Repo.java",
        imports: 2,
        reports: [],
        denyAll: 1,
        why: "Both imports point inward (domain and internal store), so the adapter's own tag row permits every edge here — the internal one resolves to its own project and stays invisible even under deny-all.",
      },
      {
        file: "libs/m-adapter/src/main/java/test/corpus/maven/adapter/Gateway.java",
        imports: 2,
        reports: [
          {
            messageId: "bannedExternalImportsViolation",
            specifier: "vendor.test.shellsdk.Shell",
            target: "npm:vendor.test.shellsdk.Shell",
          },
        ],
        denyAll: 1,
        why: "The adapter layer's external ban fires here: the shell SDK is prohibited for layer:adapter, while the internal store import resolves to its own project and stays silent.",
      },
      {
        file: "libs/m-util/src/main/java/test/corpus/maven/util/Clock.java",
        imports: 1,
        reports: [
          {
            messageId: "projectWithoutTagsCannotHaveDependencies",
            specifier: "test.corpus.maven.domain.Policy",
            target: "m-domain",
          },
        ],
        denyAll: 1,
        why: "A project no constraint row matches is an error, not a permission — the reactor parent at the root anchors a project too, but owns no import site, so the untagged row judges only this file's crossing.",
      },
    ],
  },

  // ------------------------------------------------ peer cycles (Java)
  {
    id: "peer-cycles-in-java",
    style: "modular monolith",
    languages: ["java"],
    intent:
      "A two-project cycle whose tag rows permit every pair outright, in Java: only the graph shape shows it closes. The near-miss is the same-package reference spelled as an own-project import, which resolves back to its source and must stay silent under the deny-all law too.",
    projects: [
      { name: "p-alpha", root: "libs/p-alpha", tags: ["ring:alpha"] },
      { name: "p-beta", root: "libs/p-beta", tags: ["ring:beta"] },
    ],
    depConstraints: [
      { sourceTag: "ring:alpha", onlyDependOnLibsWithTags: ["ring:alpha", "ring:beta"] },
      { sourceTag: "ring:beta", onlyDependOnLibsWithTags: ["ring:alpha", "ring:beta"] },
    ],
    files: {
      "libs/p-alpha/src/main/java/test/corpus/peer/alpha/Ping.java":
        "package test.corpus.peer.alpha;\n\nimport test.corpus.peer.beta.Pong;\n\nclass Ping { Pong pong; }\n",
      "libs/p-beta/src/main/java/test/corpus/peer/beta/Pong.java":
        "package test.corpus.peer.beta;\n\nimport test.corpus.peer.alpha.Ping;\n\nclass Pong { Ping ping; }\n",
      "libs/p-alpha/src/main/java/test/corpus/peer/alpha/internal/Keeper.java":
        "package test.corpus.peer.alpha.internal;\n\nclass Keeper {}\n",
      "libs/p-alpha/src/main/java/test/corpus/peer/alpha/Local.java":
        "package test.corpus.peer.alpha;\n\nimport test.corpus.peer.alpha.internal.Keeper;\n\nclass Local { Keeper keeper; }\n",
    },
    probes: [
      {
        file: "libs/p-alpha/src/main/java/test/corpus/peer/alpha/Ping.java",
        imports: 1,
        reports: [
          {
            messageId: "noCircularDependencies",
            specifier: "test.corpus.peer.beta.Pong",
            target: "p-beta",
          },
        ],
        denyAll: 1,
        why: "Half of a cycle the tags permit outright — both rows allow the pair, and only the graph shows it closes.",
      },
      {
        file: "libs/p-beta/src/main/java/test/corpus/peer/beta/Pong.java",
        imports: 1,
        reports: [
          {
            messageId: "noCircularDependencies",
            specifier: "test.corpus.peer.alpha.Ping",
            target: "p-alpha",
          },
        ],
        denyAll: 1,
        why: "The other half, reported at its own site: reading a cycle from one end would leave the other file looking clean.",
      },
      {
        file: "libs/p-alpha/src/main/java/test/corpus/peer/alpha/Local.java",
        imports: 1,
        reports: [],
        denyAll: 0,
        why: "An import resolving into its own project reaches no second project, so nothing can report it — Java has no relative import form, so spelling.relative reads what the import reached, and the deny-all silence is honest.",
      },
    ],
  },

  // ------------------------------------------------ layered architecture (Gradle, Kotlin)
  {
    id: "layered-architecture-in-gradle-kotlin",
    style: "layered (relaxed)",
    languages: ["kotlin"],
    intent:
      "The relaxed layering of `layered-architecture-in-java`, restated with Gradle manifests and Kotlin sources to prove the Gradle reader works alongside the JVM analyzer: settings.gradle defines the reactor, build.gradle files declare project dependencies, and the same layering rules apply with Kotlin sources instead of Java.",
    projects: [
      { name: "g-domain", root: "libs/g-domain", tags: ["layer:domain"] },
      { name: "g-usecase", root: "libs/g-usecase", tags: ["layer:usecase"] },
      { name: "g-adapter", root: "libs/g-adapter", tags: ["layer:adapter"] },
      { name: "g-util", root: "libs/g-util", tags: [] },
    ],
    depConstraints: [
      { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
      { sourceTag: "layer:usecase", onlyDependOnLibsWithTags: ["layer:domain", "layer:usecase"] },
      {
        sourceTag: "layer:adapter",
        onlyDependOnLibsWithTags: ["layer:domain", "layer:usecase", "layer:adapter"],
        bannedExternalImports: ["vendor.test.shellsdk*"],
      },
    ],
    files: {
      // Gradle settings file at the root — no declared project owns it
      "settings.gradle":
        'rootProject.name = "gradle-layers"\ninclude("libs:g-domain", "libs:g-usecase", "libs:g-adapter", "libs:g-util")\n',
      // Domain layer - Gradle build and Kotlin source
      "libs/g-domain/build.gradle": "dependencies { }\n",
      "libs/g-domain/src/main/kotlin/test/corpus/gradle/domain/Policy.kt":
        "package test.corpus.gradle.domain\n\nclass Policy {}\n",
      // Use case layer - Gradle build with violations
      "libs/g-usecase/build.gradle":
        'dependencies {\n  implementation project(":libs:g-domain")\n}\n',
      "libs/g-usecase/src/main/kotlin/test/corpus/gradle/usecase/Service.kt":
        "package test.corpus.gradle.usecase\n\nimport test.corpus.gradle.domain.Policy\nimport test.corpus.gradle.adapter.Repo\n\nclass Service { val p: Policy = Policy(); val r: Repo = Repo() }\n",
      "libs/g-usecase/src/main/kotlin/test/corpus/gradle/usecase/Sdk.kt":
        "package test.corpus.gradle.usecase\n\nimport vendor.test.shellsdk.Shell\n\nclass Sdk { val shell: Shell = Shell() }\n",
      // Adapter layer - Gradle build with violations
      "libs/g-adapter/build.gradle": 'dependencies { implementation project(":libs:g-domain") }\n',
      "libs/g-adapter/src/main/kotlin/test/corpus/gradle/adapter/Repo.kt":
        "package test.corpus.gradle.adapter\n\nimport test.corpus.gradle.domain.Policy\nimport test.corpus.gradle.adapter.internal.Store\n\nclass Repo { val p: Policy = Policy(); val store: Store = Store() }\n",
      "libs/g-adapter/src/main/kotlin/test/corpus/gradle/adapter/internal/Store.kt":
        "package test.corpus.gradle.adapter.internal\n\nclass Store {}\n",
      "libs/g-adapter/src/main/kotlin/test/corpus/gradle/adapter/Gateway.kt":
        "package test.corpus.gradle.adapter\n\nimport test.corpus.gradle.adapter.internal.Store\nimport vendor.test.shellsdk.Shell\n\nclass Gateway { val store: Store = Store(); val shell: Shell = Shell() }\n",
      // Util layer - Gradle build and Kotlin source
      "libs/g-util/build.gradle": "dependencies { }\n",
      "libs/g-util/src/main/kotlin/test/corpus/gradle/util/Clock.kt":
        "package test.corpus.gradle.util\n\nimport test.corpus.gradle.domain.Policy\n\nclass Clock { val p: Policy = Policy() }\n",
    },
    probes: [
      {
        file: "libs/g-domain/src/main/kotlin/test/corpus/gradle/domain/Policy.kt",
        imports: 0,
        reports: [],
        denyAll: 0,
        why: "The innermost layer importing nothing — recorded so the case's zero-finding claim about this file is a measurement, not an omission.",
      },
      {
        file: "libs/g-usecase/src/main/kotlin/test/corpus/gradle/usecase/Service.kt",
        imports: 2,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "test.corpus.gradle.adapter.Repo",
            target: "g-adapter",
          },
        ],
        denyAll: 2,
        why: "One crossing the layering permits beside one it forbids, in one import list — the domain import must stay silent while the outward adapter import reports.",
      },
      {
        file: "libs/g-usecase/src/main/kotlin/test/corpus/gradle/usecase/Sdk.kt",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "The same external SDK the adapter layer is banned from, imported by a layer no ban row names — a dotted external ban binds the tag that carries it and nothing else.",
      },
      {
        file: "libs/g-adapter/src/main/kotlin/test/corpus/gradle/adapter/Repo.kt",
        imports: 2,
        reports: [],
        denyAll: 1,
        why: "Both imports point inward (domain and internal store), so the adapter's own tag row permits every edge here — the domain import is expected; the internal one resolves to its own project and stays invisible even under deny-all.",
      },
      {
        file: "libs/g-adapter/src/main/kotlin/test/corpus/gradle/adapter/Gateway.kt",
        imports: 2,
        reports: [
          {
            messageId: "bannedExternalImportsViolation",
            specifier: "vendor.test.shellsdk.Shell",
            target: "npm:vendor.test.shellsdk.Shell",
          },
        ],
        denyAll: 1,
        why: "The adapter layer's external ban fires here: the shell SDK is prohibited for layer:adapter, while the internal store import resolves to its own project and stays silent.",
      },
      {
        file: "libs/g-util/src/main/kotlin/test/corpus/gradle/util/Clock.kt",
        imports: 1,
        reports: [
          {
            messageId: "projectWithoutTagsCannotHaveDependencies",
            specifier: "test.corpus.gradle.domain.Policy",
            target: "g-domain",
          },
        ],
        denyAll: 1,
        why: "A project no constraint row matches is an error, not a permission — Kotlin's content-derived package index attributes the file first, then the rule judges it like any other language's.",
      },
    ],
  },

  // --------------------------------------- joint namespace (Java + Kotlin)
  {
    id: "joint-namespace-across-java-and-kotlin",
    style: "modular monolith",
    languages: ["java", "kotlin"],
    intent:
      "One Gradle-style module compiles .java and .kt sources into ONE package namespace, so a boundary must hold whichever language reaches across it: the violating import is written in JAVA toward a package only KOTLIN declares, and the permitted near-miss is written in KOTLIN toward a package only JAVA declares. The third probe is an own-project import through the same shared namespace, which resolves back to its source under either language and stays silent under every law.",
    projects: [
      { name: "jx-core", root: "libs/jx-core", tags: ["layer:core"] },
      { name: "jx-app", root: "libs/jx-app", tags: ["layer:app"] },
      { name: "jx-legacy", root: "libs/jx-legacy", tags: ["layer:legacy"] },
    ],
    depConstraints: [
      { sourceTag: "layer:core", onlyDependOnLibsWithTags: ["layer:core"] },
      { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:app", "layer:core"] },
      { sourceTag: "layer:legacy", onlyDependOnLibsWithTags: ["layer:legacy"] },
    ],
    files: {
      // The model lives in jx-core, declared by KOTLIN...
      "libs/jx-core/src/main/kotlin/test/corpus/joint/model/Model.kt":
        "package test.corpus.joint.model\n\nclass Model { val total = 1 }\n",
      // ...and the persistence face of the SAME module by JAVA.
      "libs/jx-core/src/main/java/test/corpus/joint/store/Repo.java":
        "package test.corpus.joint.store;\n\nclass Repo {}\n",
      // Permitted: KOTLIN in app reaching the JAVA-declared store package.
      "libs/jx-app/src/main/kotlin/test/corpus/joint/app/Viewer.kt":
        "package test.corpus.joint.app\n\nimport test.corpus.joint.store.Repo\n\nclass Viewer { val repo = Repo() }\n",
      // Violating: JAVA in legacy reaching the KOTLIN-declared model package.
      "libs/jx-legacy/src/main/java/test/corpus/joint/legacy/Migrator.java":
        "package test.corpus.joint.legacy;\n\nimport test.corpus.joint.model.Model;\n\nclass Migrator { Model model; }\n",
      // Near-miss: own-project import through the shared namespace.
      "libs/jx-core/src/main/kotlin/test/corpus/joint/model/internal/Ids.kt":
        "package test.corpus.joint.model.internal\n\nclass Ids\n",
      "libs/jx-core/src/main/java/test/corpus/joint/model/Batches.java":
        "package test.corpus.joint.model;\n\nimport test.corpus.joint.model.internal.Ids;\n\nclass Batches { Ids ids; }\n",
    },
    probes: [
      {
        file: "libs/jx-legacy/src/main/java/test/corpus/joint/legacy/Migrator.java",
        imports: 1,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "test.corpus.joint.model.Model",
            target: "jx-core",
          },
        ],
        denyAll: 1,
        why: "A JAVA source importing a package only a KOTLIN file declares — the index resolves it, and the rule judges it like any other crossing.",
      },
      {
        file: "libs/jx-app/src/main/kotlin/test/corpus/joint/app/Viewer.kt",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "The permitted mirror image: KOTLIN reaching a package only a JAVA source declares, allowed by the table. Silent here, reported under deny-all — proof the analyzer saw it.",
      },
      {
        file: "libs/jx-core/src/main/java/test/corpus/joint/model/Batches.java",
        imports: 1,
        reports: [],
        denyAll: 0,
        why: "An own-project import through the shared namespace resolves back to its source whichever language wrote it, so nothing can report it under any law.",
      },
    ],
  },

  // ------------------------------------------------------------- layered (Kotlin)
  {
    id: "layered-architecture-in-kotlin",
    style: "layered (relaxed)",
    languages: ["kotlin"],
    intent:
      "The relaxed layering of `layered-architecture-in-java`, restated in Kotlin so the JVM shapes are labeled too: packages resolve through a content-derived index rather than a module path, an untagged project is the importer, and the external ban carries a dotted glob. The transport project imports nothing, for the same cycle-avoidance reason its Java twin does. Kotlin's package resolution is exercised, using single-line imports only (multi-line imports are not read per the analyzer's documented limits).",
    projects: [
      { name: "k-domain", root: "libs/k-domain", tags: ["layer:domain"] },
      { name: "k-usecase", root: "libs/k-usecase", tags: ["layer:usecase"] },
      { name: "k-adapter", root: "libs/k-adapter", tags: ["layer:adapter"] },
      { name: "k-util", root: "libs/k-util", tags: [] },
    ],
    depConstraints: [
      { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
      { sourceTag: "layer:usecase", onlyDependOnLibsWithTags: ["layer:domain", "layer:usecase"] },
      {
        sourceTag: "layer:adapter",
        onlyDependOnLibsWithTags: ["layer:domain", "layer:usecase", "layer:adapter"],
        bannedExternalImports: ["vendor.test.shellsdk*"],
      },
    ],
    files: {
      "libs/k-domain/src/main/kotlin/test/corpus/jvm/domain/Policy.kt":
        "package test.corpus.jvm.domain\n\nclass Policy\n",
      "libs/k-usecase/src/main/kotlin/test/corpus/jvm/usecase/Service.kt":
        "package test.corpus.jvm.usecase\n\nimport test.corpus.jvm.domain.Policy\nimport test.corpus.jvm.adapter.Repo\n\nclass Service(val p: Policy, val r: Repo)\n",
      "libs/k-usecase/src/main/kotlin/test/corpus/jvm/usecase/Sdk.kt":
        "package test.corpus.jvm.usecase\n\nimport vendor.test.shellsdk.Shell\n\nclass Sdk(val shell: Shell)\n",
      "libs/k-adapter/src/main/kotlin/test/corpus/jvm/adapter/Repo.kt":
        "package test.corpus.jvm.adapter\n\nimport test.corpus.jvm.domain.Policy\nimport test.corpus.jvm.adapter.internal.Store\n\nclass Repo(val p: Policy, val store: Store)\n",
      "libs/k-adapter/src/main/kotlin/test/corpus/jvm/adapter/internal/Store.kt":
        "package test.corpus.jvm.adapter.internal\n\nclass Store\n",
      "libs/k-adapter/src/main/kotlin/test/corpus/jvm/adapter/Gateway.kt":
        "package test.corpus.jvm.adapter\n\nimport test.corpus.jvm.adapter.internal.Store\nimport vendor.test.shellsdk.Shell\n\nclass Gateway(val store: Store, val shell: Shell)\n",
      "libs/k-util/src/main/kotlin/test/corpus/jvm/util/Clock.kt":
        "package test.corpus.jvm.util\n\nimport test.corpus.jvm.domain.Policy\n\nclass Clock(val p: Policy)\n",
    },
    probes: [
      {
        file: "libs/k-domain/src/main/kotlin/test/corpus/jvm/domain/Policy.kt",
        imports: 0,
        reports: [],
        denyAll: 0,
        why: "The innermost layer importing nothing — recorded so the case's zero-finding claim about this file is a measurement, not an omission.",
      },
      {
        file: "libs/k-usecase/src/main/kotlin/test/corpus/jvm/usecase/Service.kt",
        imports: 2,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "test.corpus.jvm.adapter.Repo",
            target: "k-adapter",
          },
        ],
        denyAll: 2,
        why: "One crossing the layering permits beside one it forbids, in one import list — the domain import must stay silent while the outward adapter import reports.",
      },
      {
        file: "libs/k-usecase/src/main/kotlin/test/corpus/jvm/usecase/Sdk.kt",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "The same external SDK the adapter layer is banned from, imported by a layer no ban row names — a dotted external ban binds the tag that carries it and nothing else.",
      },
      {
        file: "libs/k-adapter/src/main/kotlin/test/corpus/jvm/adapter/Repo.kt",
        imports: 2,
        reports: [],
        denyAll: 1,
        why: "Both imports are what the layering permits — reporting either would invert the axis. Under the forbid-everything law exactly one reports: the domain crossing; the other resolves into this very project, which no law can reach.",
      },
      {
        file: "libs/k-adapter/src/main/kotlin/test/corpus/jvm/adapter/Gateway.kt",
        imports: 2,
        reports: [
          {
            messageId: "bannedExternalImportsViolation",
            specifier: "vendor.test.shellsdk.Shell",
            target: "npm:vendor.test.shellsdk.Shell",
          },
        ],
        denyAll: 1,
        why: "An own-project import stays silent under both laws while the dotted-glob ban fires on the line below it — the two answers in one file come from different rules, and only one of them can ever report.",
      },
      {
        file: "libs/k-util/src/main/kotlin/test/corpus/jvm/util/Clock.kt",
        imports: 1,
        reports: [
          {
            messageId: "projectWithoutTagsCannotHaveDependencies",
            specifier: "test.corpus.jvm.domain.Policy",
            target: "k-domain",
          },
        ],
        denyAll: 1,
        why: "A project no constraint row matches is an error, not a permission — Kotlin's content-derived package index attributes the file first, then the rule judges it like any other language's.",
      },
    ],
  },

  // ------------------------------------------------ peer cycles (Kotlin)
  {
    id: "peer-cycles-in-kotlin",
    style: "modular monolith",
    languages: ["kotlin"],
    intent:
      "A two-project cycle whose tag rows permit every pair outright, in Kotlin: only the graph shape shows it closes. The near-miss is the same-package reference spelled as an own-project import, which resolves back to its source and must stay silent under the deny-all law too. Kotlin's package resolution is exercised.",
    projects: [
      { name: "kp-alpha", root: "libs/kp-alpha", tags: ["ring:alpha"] },
      { name: "kp-beta", root: "libs/kp-beta", tags: ["ring:beta"] },
    ],
    depConstraints: [
      { sourceTag: "ring:alpha", onlyDependOnLibsWithTags: ["ring:alpha", "ring:beta"] },
      { sourceTag: "ring:beta", onlyDependOnLibsWithTags: ["ring:alpha", "ring:beta"] },
    ],
    files: {
      "libs/kp-alpha/src/main/kotlin/test/corpus/peer/alpha/Ping.kt":
        "package test.corpus.peer.alpha\n\nimport test.corpus.peer.beta.Pong\n\nclass Ping(val pong: Pong)\n",
      "libs/kp-beta/src/main/kotlin/test/corpus/peer/beta/Pong.kt":
        "package test.corpus.peer.beta\n\nimport test.corpus.peer.alpha.Ping\n\nclass Pong(val ping: Ping)\n",
      "libs/kp-alpha/src/main/kotlin/test/corpus/peer/alpha/internal/Keeper.kt":
        "package test.corpus.peer.alpha.internal\n\nclass Keeper\n",
      "libs/kp-alpha/src/main/kotlin/test/corpus/peer/alpha/Local.kt":
        "package test.corpus.peer.alpha\n\nimport test.corpus.peer.alpha.internal.Keeper\n\nclass Local(val keeper: Keeper)\n",
    },
    probes: [
      {
        file: "libs/kp-alpha/src/main/kotlin/test/corpus/peer/alpha/Ping.kt",
        imports: 1,
        reports: [
          {
            messageId: "noCircularDependencies",
            specifier: "test.corpus.peer.beta.Pong",
            target: "kp-beta",
          },
        ],
        denyAll: 1,
        why: "Half of a cycle the tags permit outright — both rows allow the pair, and only the graph shows it closes.",
      },
      {
        file: "libs/kp-beta/src/main/kotlin/test/corpus/peer/beta/Pong.kt",
        imports: 1,
        reports: [
          {
            messageId: "noCircularDependencies",
            specifier: "test.corpus.peer.alpha.Ping",
            target: "kp-alpha",
          },
        ],
        denyAll: 1,
        why: "The other half, reported at its own site: reading a cycle from one end would leave the other file looking clean.",
      },
      {
        file: "libs/kp-alpha/src/main/kotlin/test/corpus/peer/alpha/Local.kt",
        imports: 1,
        reports: [],
        denyAll: 0,
        why: "An import resolving into its own project reaches no second project, so nothing can report it — Kotlin has no relative import form, so spelling.relative reads what the import reached, and the deny-all silence is honest.",
      },
    ],
  },
  // ------------------------------------------------------- layered (C#)
  {
    id: "layered-architecture-in-csharp",
    style: "layered (relaxed)",
    languages: ["csharp"],
    intent:
      "The relaxed layering of `layered-architecture-in-java`, restated in C# so the dotnet shapes are labeled too: file-scoped namespaces resolve through a content-derived index, a `static` and an aliased directive both carry crossings, an untagged project is the importer, and the external ban carries a dotted glob against a NuGet-shaped name.",
    projects: [
      { name: "cs-domain", root: "libs/cs-domain", tags: ["layer:domain"] },
      { name: "cs-usecase", root: "libs/cs-usecase", tags: ["layer:usecase"] },
      { name: "cs-adapter", root: "libs/cs-adapter", tags: ["layer:adapter"] },
      { name: "cs-util", root: "libs/cs-util", tags: [] },
    ],
    depConstraints: [
      { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
      { sourceTag: "layer:usecase", onlyDependOnLibsWithTags: ["layer:domain", "layer:usecase"] },
      {
        sourceTag: "layer:adapter",
        onlyDependOnLibsWithTags: ["layer:domain", "layer:usecase", "layer:adapter"],
        bannedExternalImports: ["Vendor.Test.ShellSdk*"],
      },
    ],
    files: {
      "libs/cs-domain/Policy.cs":
        "namespace Test.Corpus.Domain;\n\npublic sealed class Policy { }\n",
      "libs/cs-usecase/Service.cs":
        "using Test.Corpus.Domain;\nusing Test.Corpus.Adapter;\n\npublic sealed class Service\n{\n    public Service(Policy policy, Repo repo) { }\n}\n",
      "libs/cs-usecase/Sdk.cs":
        "using static Vendor.Test.ShellSdk.Shell.Factory;\n\npublic sealed class Sdk { }\n",
      "libs/cs-adapter/Repo.cs": "namespace Test.Corpus.Adapter;\n\npublic interface Repo { }\n",
      "libs/cs-adapter/Gateway.cs":
        "using static Test.Corpus.Adapter.Repo;\nusing Gateway = Vendor.Test.ShellSdk.Shell;\n\npublic sealed class Gateway<T> { }\n",
      "libs/cs-util/Clock.cs": "using Test.Corpus.Domain.Policy;\n\npublic class Clock { }\n",
    },
    probes: [
      {
        file: "libs/cs-domain/Policy.cs",
        imports: 0,
        reports: [],
        denyAll: 0,
        why: "The innermost layer importing nothing — recorded so the case's zero-finding claim about this file is a measurement, not an omission.",
      },
      {
        file: "libs/cs-usecase/Service.cs",
        imports: 2,
        reports: [
          {
            messageId: "onlyTagsConstraintViolation",
            specifier: "Test.Corpus.Adapter",
            target: "cs-adapter",
          },
        ],
        denyAll: 2,
        why: "One crossing the layering permits beside one it forbids, in one using list — the domain import must stay silent while the outward adapter import reports.",
      },
      {
        file: "libs/cs-usecase/Sdk.cs",
        imports: 1,
        reports: [],
        denyAll: 1,
        why: "The same external SDK the adapter layer is banned from, imported through a static-members directive by a layer no ban row names — a dotted external ban binds the tag that carries it and nothing else.",
      },
      {
        file: "libs/cs-adapter/Gateway.cs",
        imports: 2,
        reports: [
          {
            messageId: "bannedExternalImportsViolation",
            specifier: "Vendor.Test.ShellSdk.Shell",
            target: "npm:Vendor.Test.ShellSdk.Shell",
          },
        ],
        denyAll: 1,
        why: "An own-project static import stays silent under both laws while the aliased NuGet namespace below it fires the dotted-glob ban — the alias's right-hand side is what crosses, so that is what the record names.",
      },
      {
        file: "libs/cs-util/Clock.cs",
        imports: 1,
        reports: [
          {
            messageId: "projectWithoutTagsCannotHaveDependencies",
            specifier: "Test.Corpus.Domain.Policy",
            target: "cs-domain",
          },
        ],
        denyAll: 1,
        why: "A project no constraint row matches is an error, not a permission — C#'s content-derived namespace index attributes the file first, then the rule judges it like any other language's.",
      },
    ],
  },
];

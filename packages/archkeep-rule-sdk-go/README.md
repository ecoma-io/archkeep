# archkeep-rule-sdk (Go)

Write a Archkeep custom architecture rule in Go, compile it to core WebAssembly
with TinyGo, and declare it in your workspace's policy. The engine loads the
artifact, hands it the facts it already observed, and folds the verdict into
`check` beside the built-in boundary rules.

The import path is
`github.com/ecoma-io/archkeep/packages/archkeep-rule-sdk-go`, and it is the whole
name: Go has no registry to publish a short one to, and no manifest field to
write a version into — the version is the tag
`packages/archkeep-rule-sdk-go/v<version>`, which is why nothing in this
directory joins the version chain the Cargo, npm and PyPI manifests are held
to. The reasoning is in
[ADR 0002](../../docs/adr/0002-custom-rules-one-contract.md).

## What a rule is

A pure function from evidence to verdict, and nothing else in either direction.
No filesystem, no network, no clock, no randomness — not by restraint but by
construction: the host grants a rule module no imports at all, so there is no
clock to reach for.

This is the whole artifact. There is no shell, no `//export`, and no build tag
in an author's own file — the SDK carries those, so what is left is the rule:

```go
package main

import (
	"fmt"

	archkeeprule "github.com/ecoma-io/archkeep/packages/archkeep-rule-sdk-go"
)

func evaluate(evidence *archkeeprule.Evidence) archkeeprule.Verdict {
	var params struct {
		Tag string `json:"forbiddenTag"`
	}
	if err := evidence.ReadParams(&params); err != nil || params.Tag == "" {
		return archkeeprule.Unknown("params.forbiddenTag is not a tag, so nothing was judged")
	}

	var findings []archkeeprule.Finding
	for _, edge := range evidence.Graph.Edges {
		target, ok := evidence.Project(edge.Target)
		if !ok {
			return archkeeprule.Unknown(fmt.Sprintf("the graph names %q and the model does not", edge.Target))
		}
		if target.HasTag(params.Tag) {
			findings = append(findings, archkeeprule.
				NewFinding("forbidden-edge", edge.Source+" depends on "+edge.Target).
				InProject(edge.Source))
		}
	}
	return archkeeprule.FromFindings(findings)
}

func init() {
	archkeeprule.Register(archkeeprule.Rule{
		Name:  "no-dependency-on-tag",
		Needs: []archkeeprule.EvidenceKind{archkeeprule.KindModel, archkeeprule.KindGraph},
		Findings: []archkeeprule.CatalogueEntry{
			{ID: "forbidden-edge", Message: "a dependency lands on a forbidden tag"},
		},
		Evaluate: evaluate,
	})
}

// A wasm module has no entry point to run, and Go has no way to spell a
// command without one. It is never called.
func main() {}
```

`examples/forbidden_tag_dependency/rule.go` is the same shape, complete, and it
is the artifact this module ships and tests.

**`Register` is called from `init`, and that is load-bearing rather than
stylistic.** A core wasm module runs no start function the host invokes, so the
SDK's ABI shell starts the Go runtime itself on the first call into any export
— and starting the runtime is exactly what runs every package's `init`. A rule
assigned to a package-level variable instead would be read before it was set.

## The four verdicts, and why `pass` is the narrow one

`pass` is a claim: the rule read the evidence it declared it needs and there was
nothing to report. Everything that is not that claim has its own answer —
`Fail` with findings, `NotApplicable` with a reason, `Unknown` with a reason —
because an empty finding list from a rule that could not look is byte-for-byte
identical to a clean workspace, and nobody files a bug about it.

The API is built so the hollow shapes cannot be written: `Verdict` has no
exported field and no constructor but the four; `Fail` takes a `Findings`,
whose representation is one finding plus the rest, so a failing verdict that
names nothing has no spelling; `Pass` takes nothing; and the two
reason-carrying verdicts take their reason as an argument.

**Three things Go cannot make unrepresentable, and what happens instead.** The
Rust binding gets all three from its type system
([its README](../archkeep-rule-sdk-rust/README.md) says how); this one states
them rather than implying parity:

| what Rust refuses at compile time            | what happens here                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| a malformed declaration (`const` evaluation) | `Register` panics — which for an author is `go test`, and for a consumer a load failure |
| a zero-line position (`NonZeroU32`)          | `Finding.At` panics; on wasm that is a trap the host names                              |
| an empty `Findings` (constructor-only type)  | the zero value is a fail with one **blank** finding, refused by the host naming its id  |

Every one of them is loud. None of them is a `pass`.

## TinyGo is required, and standard Go cannot do this

Not a preference — a measurement. The host refuses any module whose import
section is non-empty ("the contract grants no imports"), and both of standard
Go's wasm targets import a host, because the Go runtime needs one:

| toolchain                       | artifact size | imports | from                     |
| ------------------------------- | ------------: | ------: | ------------------------ |
| `go` 1.24.7, `GOOS=wasip1`      |     1,618,674 |      10 | `wasi_snapshot_preview1` |
| `go` 1.24.7, `GOOS=js`          |     1,604,184 |       8 | `gojs`                   |
| `tinygo` 0.41.0, `wasm-unknown` |       187,058 |       0 | —                        |

Install TinyGo from <https://tinygo.org/getting-started/install/>. It brings its
own LLVM and linker; it does not replace `go`, which it still needs.

Two TinyGo-specific facts the SDK absorbs so an author never meets them:

- **The exports are `//export`, not `//go:wasmexport`.** TinyGo wraps every
  `//go:wasmexport` function in a call to `runtime.wasmExportCheckRun`, which
  traps with _"`//go:wasmexport` function called before runtime
  initialization"_ unless the module's `_initialize` has been called first. The
  contract names four exports and `_initialize` is not one of them, so the host
  never calls it — measured: every `//go:wasmexport` build answers the first
  `archkeep_describe` with `RuntimeError: unreachable`.
- **The shell starts the runtime itself.** `abi_freestanding.go` reaches
  TinyGo's reactor entry point by its linker symbol and runs it once, before
  anything allocates. That is why the three exported functions are one
  statement long, and why `rebuild-example.sh` instantiates the artifact before
  it records a digest: a TinyGo that renamed the symbol fails the link, but a
  TinyGo that changed what it does would build cleanly and trap in a consumer's
  tree.

## Building the artifact

```bash
./rebuild-example.sh
```

For a rule of your own, the same command with your own package:

```bash
tinygo build -o my_rule.wasm -target=wasm-unknown -buildmode=c-shared \
  -gc=leaking -scheduler=none -panic=trap -no-debug -opt=z ./my_rule
```

Every flag is stated even where it is the target's own default, so the artifact
a contributor rebuilds is the artifact CI would have. `rebuild-example.sh`
argues each one beside it; the two that pay for themselves in bytes, measured
on this module's own example:

| build                        |   bytes |
| ---------------------------- | ------: |
| target defaults only         | 838,208 |
| `-panic=trap`                | 833,594 |
| `-no-debug`                  | 193,981 |
| both (the shipped set)       | 187,058 |
| both, but `-gc=conservative` | 240,566 |
| both, but `-opt=2`           | 246,131 |

Size matters here for a reason it usually does not: the artifact is **committed
to the workspace that declares the rule**, reviewed as bytes, and pinned by a
sha256 in the policy row.

The result declares **no imports at all** — which is what makes "a rule holds
no ambient capability" a property of the module rather than a promise about the
host — and exports the four symbols the ABI names, `memory` among them, plus
`_initialize`, four float helpers and a `syscall.seek` stub the toolchain adds
and the host ignores. Check both before shipping it:

```bash
node -e 'const m=new WebAssembly.Module(require("fs").readFileSync(process.argv[1]));
console.log(WebAssembly.Module.imports(m), WebAssembly.Module.exports(m).map(e=>e.name))' \
  examples/forbidden_tag_dependency.wasm
```

## What the standard library gives you here, measured

`encoding/json` works, reflection and struct tags included — which is the whole
reason this SDK needs no dependency at all, where the Rust one needs two. The
limits an author actually meets, each built against `-target=wasm-unknown`:

| package                                                      | what happens                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `encoding/json`, `fmt`, `strings`, `sort`, `strconv`, `sync` | work                                                                    |
| `go func() {}`                                               | **compile error**: "attempted to start a goroutine without a scheduler" |
| `time.Now()`                                                 | compiles; answers the zero instant — a constant, not a clock            |
| `os.ReadFile`                                                | compiles; every call fails — there is no filesystem to reach            |
| `regexp`                                                     | works, and costs about 124 KiB of artifact                              |

The goroutine, clock and filesystem rows are the no-ambient-capability decision
seen from inside:
nothing was removed to produce them, there is simply nothing on the other side
of a module that imports nothing.

The artifact holds 128 KiB of linear memory at instantiation and 256 KiB after
evaluating any of the golden fixtures — against the host's 256 MiB bound.

## Declaring it

```js
export const customRules = [
  {
    name: "forbidden-tag-dependency",
    artifact: "tools/rules/forbidden_tag_dependency.wasm",
    sha256: "<the contents of examples/forbidden_tag_dependency.wasm.sha256>",
    params: { forbiddenTag: "layer-infrastructure", exemptTags: ["layer-adapter"] },
    reason: "infrastructure is reached through the domain's ports, never directly",
  },
];
```

The `name` here and the `Name` in `Register` must be the same string: the host
refuses the pair when they differ, because the declared name is what every
finding is namespaced under.

## The committed artifact, and why a binary is in this tree

`examples/forbidden_tag_dependency.wasm` is committed, and
`examples/forbidden_tag_dependency.wasm.sha256` beside it holds its digest —
the same string a policy row pins. `go test` recomputes the digest over the
committed bytes and fails when the two have drifted, so a rebuilt artifact
cannot land beside the digest of the one before it. Rebuild both together with
`./rebuild-example.sh`, which writes both files or neither.

CI does not run that script: it needs a second toolchain, and the tests check
the bytes in the tree, which is the point — a green run proves the artifact a
reviewer can hash, not one the runner just produced. The digest pins those
bytes; it does not claim a reproducible build, and a different TinyGo will
produce a different artifact and a different digest.

## Driving it through the real host

The tests reach the rule through `archkeeprule.EvaluateJSON`, because a `.wasm`
file cannot be instantiated from a Go test without a runtime this module
refuses to depend on. What that leaves unproven — the ABI shell around the same
code — is proven by driving the committed artifact through the engine's own
host, which is what a consumer's `check` does:

```
describe {"contract":1,"name":"forbidden-tag-dependency","needs":["model","graph"],"findings":[{"id":"dependency-on-forbidden-tag","message":"a project depends on a project carrying the forbidden tag"}]}
edge-into-forbidden-tag.json
  {"contract":1,"verdict":"fail","findings":[{"id":"dependency-on-forbidden-tag","message":"beta depends on gamma, which carries \"layer-infrastructure\"","sourceFile":"packages/beta/src/store.rs","project":"beta"}]}
every-edge-clean.json
  {"contract":1,"verdict":"pass","findings":[]}
no-project-carries-the-tag.json
  {"contract":1,"verdict":"not_applicable","findings":[],"notApplicableReason":"no project in this workspace carries \"layer-infrastructure\", so there is no dependency this rule could forbid"}
params-without-the-tag.json
  {"contract":1,"verdict":"unknown","findings":[],"reason":"params.forbiddenTag is not a non-empty string, so there is no tag to judge dependencies against — the rule read nothing and concluded nothing"}
edge-into-an-undeclared-project.json
  {"contract":1,"verdict":"unknown","findings":[],"reason":"the graph carries an edge into \"epsilon\", which the model does not declare — the two halves of the evidence disagree, and a rule cannot tell whether a project it cannot see carries the tag"}
```

Those are the five verdicts `examples/forbidden_tag_dependency/golden_test.go`
pins, produced by the committed bytes rather than by the Go build — the two
agreeing is what makes the pure-path suite worth running.

## The fixtures

`fixtures/` holds evidence bundles produced by the engine's own bundle assembly
and canonical serializer — not hand-written JSON that looks like one — and they
are committed as data rather than regenerated by a script kept here: a
generator in this package would have to import the engine's modules, which is
the dependency direction the scope axis in
[the workspace's boundary law](../../module-boundaries.config.mjs) exists to
refuse. They are byte-identical to
[the Rust binding's](../archkeep-rule-sdk-rust/README.md) copies, and the
verdicts pinned against them are the same verdicts. What holds the two to that
is no longer a promise:
[`rule-sdks.integration.test.mjs`](../archkeep/src/conformance/rule-sdks.integration.test.mjs)
reads every SDK's copy of every fixture and requires them byte-identical, then
drives all four committed artifacts through the engine's real host and requires
one verdict document from each.

`examples/forbidden_tag_dependency/golden_test.go` pins the verdict each must
produce. Two of the five are there for the silent direction: a rule that cannot
read its parameters, and a graph naming a project the model does not declare.
Both must answer `unknown`; a suite where they answered `pass` would be green
over a rule that had stopped running.

## What this module will not do

It binds the contract and never interprets it. There is no second verdict
vocabulary, no SDK-specific field, and no re-modelling of the policy — a
constraint row arrives as `json.RawMessage` because
[the engine](../archkeep/README.md) owns that schema and a copy here would drift
from it. Whether a finding resolves to a catalogue entry, whether a verdict is
hollow, whether a `needs` entry names a kind the engine can supply: all of that
is the host's refusal to make, and duplicating it here would put this module's
opinion in front of the real one.

One gap it also will not paper over: `abi_freestanding.go` is compiled by
TinyGo and by nothing else. `gofmt` reads it (build constraints are invisible
to a formatter), `go vet` and `go build` do not (they are not) — measured, the
standard toolchain rejects it outright, because a body-less function
declaration reached by `//go:linkname` needs an assembly file that TinyGo does
not want. What covers that file is the build in `rebuild-example.sh`, the
instantiation check that follows it, and the committed artifact the tests hash.

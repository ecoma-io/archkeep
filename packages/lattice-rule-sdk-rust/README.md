# lattice-rule-sdk (Rust)

Write a Lattice custom architecture rule in Rust, compile it to core
WebAssembly, and declare it in your workspace's policy. The engine loads the
artifact, hands it the facts it already observed, and folds the verdict into
`check` beside the built-in boundary rules.

The crate is `lattice-rule-sdk`; the directory carries the `-rust` suffix
because this tree will hold four of these and a registry that already names the
language does not repeat it — the reasoning is in
[ADR 0002](../../docs/adr/0002-custom-rules-one-contract.md).

## What a rule is

A pure function from evidence to verdict, and nothing else in either direction.
No filesystem, no network, no clock, no randomness — not by restraint but by
construction: the host grants a rule module no imports at all, so there is no
clock to reach for.

```rust
use lattice_rule_sdk::serde_json::Value;
use lattice_rule_sdk::{Evidence, Finding, Verdict, lattice_rule};

fn evaluate(evidence: &Evidence) -> Verdict {
    let Some(tag) = evidence.rule.params.get("forbiddenTag").and_then(Value::as_str) else {
        return Verdict::unknown("params.forbiddenTag is not a string, so nothing was judged");
    };

    let findings: Vec<Finding> = evidence
        .graph
        .edges
        .iter()
        .filter(|edge| evidence.project(&edge.target).is_some_and(|p| p.has_tag(tag)))
        .map(|edge| {
            Finding::new("forbidden-edge", format!("{} depends on {}", edge.source, edge.target))
                .in_project(&edge.source)
        })
        .collect();

    Verdict::from_findings(findings)
}

lattice_rule! {
    name: "no-dependency-on-tag",
    needs: [model, graph],
    findings: [("forbidden-edge", "a dependency lands on a forbidden tag")],
    evaluate: evaluate,
}
```

`examples/forbidden_tag_dependency.rs` is the same shape, complete, and it is
the artifact this crate ships and tests.

## The four verdicts, and why `pass` is the narrow one

`pass` is a claim: the rule read the evidence it declared it needs and there was
nothing to report. Everything that is not that claim has its own answer —
`fail` with findings, `not_applicable` with a reason, `unknown` with a reason —
because an empty finding list from a rule that could not look is
byte-for-byte identical to a clean workspace, and nobody files a bug about it.

The API is built so the hollow shapes cannot be written: `Verdict::fail` takes a
`Findings`, which cannot be empty; `Verdict::pass` takes nothing; the two
reason-carrying verdicts take their reason as an argument; and `Finding::at`
takes a file and a 1-based `NonZeroU32` position together.

## Building the artifact

```bash
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown --example forbidden_tag_dependency
```

For a rule of your own, the target is your own crate built as a `cdylib`; the
release profile in `Cargo.toml` (`panic = "abort"`, size options) is the one to
copy, and `panic = "abort"` is required rather than advisory — unwinding across
the ABI's `extern "C"` boundary is undefined behaviour, and a panic that aborts
becomes a trap the host reports by name.

The result declares **no imports at all** — which is what makes "a rule holds no
ambient capability" a property of the module rather than a promise about the
host — and exports the four symbols the ABI names, `memory` among them, plus the
two globals the linker adds and the host ignores. Check both before shipping it:

```bash
node -e 'const m=new WebAssembly.Module(require("fs").readFileSync(process.argv[1]));
console.log(WebAssembly.Module.imports(m), WebAssembly.Module.exports(m).map(e=>e.name))' \
  target/wasm32-unknown-unknown/release/examples/forbidden_tag_dependency.wasm
```

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

The `name` here and the `name` in `lattice_rule!` must be the same string: the
host refuses the pair when they differ, because the declared name is what every
finding is namespaced under.

## The committed artifact, and why a binary is in this tree

`examples/forbidden_tag_dependency.wasm` is committed, and
`examples/forbidden_tag_dependency.wasm.sha256` beside it holds its digest —
the same string a policy row pins. `cargo test` recomputes the digest over the
committed bytes and fails when the two have drifted, so a rebuilt artifact
cannot land beside the digest of the one before it. Rebuild both together:

```bash
./rebuild-example.sh
```

CI does not run that script. The tests check the bytes in the tree, which is the
point — a green run proves the artifact a reviewer can hash, not one the runner
just produced. The digest pins those bytes; it does not claim a reproducible
build, and a different rustc will produce a different artifact and a different
digest, which is why the script writes both files or neither.

## The fixtures

`fixtures/` holds evidence bundles produced by the engine's own bundle assembly
and canonical serializer — not hand-written JSON that looks like one — and they
are committed as data rather than regenerated by a script kept here: a generator
in this package would have to import the engine's modules, which is the
dependency direction the scope axis in
[the workspace's boundary law](../../module-boundaries.config.mjs) exists to
refuse. When the evidence contract grows, the fixtures are regenerated from the
engine side and land in the same change.

`tests/golden.rs` pins the verdict each must produce. They are this crate's half
of the conformance suite that keeps every SDK on one contract, and two of the
five are there for the silent direction: a rule that cannot read its parameters,
and a graph naming a project the model does not declare. Both must answer
`unknown`; a suite where they answered `pass` would be green over a rule that
had stopped running.

## What this crate will not do

It binds the contract and never interprets it. There is no second verdict
vocabulary, no SDK-specific field, and no re-modelling of the policy — a
constraint row arrives as `serde_json::Value` because
[the engine](../lattice/README.md) owns that schema and a copy here would drift
from it. Whether a finding resolves to a catalogue entry, whether a verdict is
hollow, whether a `needs` entry names a kind the engine can supply: all of that
is the host's refusal to make, and duplicating it here would put this crate's
opinion in front of the real one.

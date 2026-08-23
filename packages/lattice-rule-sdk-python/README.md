# lattice-rule-sdk (Python)

Write a Lattice custom architecture rule in Python, compile it to core
WebAssembly, and declare it in your workspace's policy. The engine loads the
artifact, hands it the facts it already observed, and folds the verdict into
`check` beside the built-in boundary rules.

The distribution is `lattice-rule-sdk`; the directory carries the `-python`
suffix because this tree holds four of these and a registry that already
names the language does not repeat it — the reasoning is in
[ADR 0002](../../docs/adr/0002-custom-rules-one-contract.md).

## Read this first: your Python runs inside a carrier

A rule artifact is one core WebAssembly module that **imports nothing**, and no
Python toolchain emits one. Pyodide compiles CPython for the browser and expects
a JavaScript host to be there. componentize-py emits a component-model binary
over WASI. The engine's host speaks neither, and refuses a module whose import
section is non-empty — which is the mechanism behind "a rule holds no ambient
capability" rather than a promise about the host.

So your Python does not become the module. It is **carried** by one: the build
tool generates a Rust crate that embeds a [RustPython](https://rustpython.github.io)
interpreter, your `rule.py`, and this package's `runtime.py`, and compiles the
three of them to wasm. Three consequences, and they are the whole character of
this SDK:

- **Building a rule needs `cargo` and the `wasm32-unknown-unknown` target.**
  Once, on the author's machine. A workspace that RUNS the rule needs neither —
  `check` reads bytes.
- **The Python that exists is the one the measured build provides**, which is
  the language plus 27 built-in modules and none of the pure-Python standard
  library. The exact list is below, including what is missing, because that is
  the half you need before you write rather than after.
- **The artifact is about 6.9 MB.** The Rust SDK's equivalent rule is 112 KB.
  You are committing an interpreter.

If any of those is the wrong trade for your rule, the
[Rust SDK](../lattice-rule-sdk-rust/README.md) writes the same contract with
none of them.

## What a rule is

A pure function from evidence to verdict, and nothing else in either direction.
No filesystem, no network, no clock, no randomness — not by restraint but by
construction.

```python
from lattice_rule_sdk import Finding, from_findings, unknown


def evaluate(evidence):
    tag = evidence.rule.params.get("forbiddenTag")
    if not isinstance(tag, str) or not tag:
        # Not `passed()`. A rule that could not read its own parameters has
        # judged nothing, and saying so is the whole discipline.
        return unknown("params.forbiddenTag is not a string, so nothing was judged")

    findings = []
    for edge in evidence.edges:
        target = evidence.project(edge.target)
        if target is not None and target.has_tag(tag):
            findings.append(
                Finding("forbidden-edge", "%s depends on %s" % (edge.source, edge.target))
                .in_project(edge.source)
            )
    return from_findings(findings)


LATTICE_RULE = {
    "name": "no-dependency-on-tag",
    "needs": ["model", "graph"],
    "findings": [{"id": "forbidden-edge", "message": "a dependency lands on a forbidden tag"}],
}
```

`examples/forbidden_tag_dependency.py` is the same shape, complete, and it is
the artifact this package ships and tests.

`LATTICE_RULE` sits beside the function rather than in a separate manifest, for
the reason the Rust SDK's `lattice_rule!` sits beside its `evaluate`: a finding
id and the code that emits it must not be able to live in two files that
disagree. The build tool reads it by name; the carrier crate validates its
grammar — the name's spelling, duplicate ids, an empty catalogue — at compile
time, so a malformed declaration fails `cargo` rather than a consumer's `check`.

## The four verdicts, and why `passed` is the narrow one

`passed()` is a claim: the rule read the evidence it declared it needs and there
was nothing to report. Everything that is not that claim has its own answer —
`failed(findings)`, `not_applicable(reason)`, `unknown(reason)` — because an
empty finding list from a rule that could not look is byte-for-byte identical to
a clean workspace, and nobody files a bug about it.

The hollow shapes are refused at construction: `failed([])` raises,
`unknown("")` raises, `Finding("", "")` raises, and `Finding.at` takes a file and
a 1-based position together so "a position with no file" has no spelling.
`passed` and `failed` are past participles because `pass` is a Python keyword;
the pair reads as one vocabulary rather than one name bending around the parser.

A rule may only read the kinds its `needs` declares. `evidence.imports` on a
rule that declared `["model", "graph"]` raises `UndeclaredEvidence` — under
CPython in your tests and inside the artifact alike — because the carrier
converts only the declared kinds, and returning the empty list instead would be
a rule scanning nothing and reporting a clean workspace.

## What the interpreter actually provides

Measured on the shipped build — RustPython 0.5.0, `default-features = false`,
`features = ["compiler"]`, no frozen standard library — by compiling a probe
rule with this package's own build tool and running it through the engine's
host. Not inferred from RustPython's documentation.

- **Language**: Python 3.14.0alpha as RustPython implements it. Classes,
  closures, comprehensions, f-strings, `%` and `.format()`, exceptions,
  generators, `__slots__`, decorators, arbitrary-precision integers and the 153
  builtins are all there. `sys.platform` is `"unknown"`; `sys.maxsize` is 2147483647,
  because the target is 32-bit.
- **Importable** (27): `sys`, `builtins`, `_abc`, `_ast`, `_codecs`,
  `_collections`, `_functools`, `_imp`, `_io`, `_operator`, `_sre`, `_stat`,
  `_string`, `_symtable`, `_sysconfig`, `_sysconfigdata`, `_thread`, `_types`,
  `_typing`, `_warnings`, `_weakref`, `atexit`, `errno`, `gc`, `itertools`,
  `marshal`, `time`.
- **NOT importable**, and this is the load-bearing half: `re`, `json`,
  `collections`, `functools`, `typing`, `dataclasses`, `enum`, `abc`, `math`,
  `os`, `io`, `copy`, `string`, `operator`, `warnings`, `traceback`, `datetime`,
  `random`, `decimal`, `pathlib`, `logging`, and the rest of the pure-Python
  standard library. **There is no regular-expression engine.** A rule matching
  paths does it with `str.startswith`, `in`, and `str.split`.
- **Randomness is fixed.** The interpreter's entropy source is a constant
  generator and its hash seed is pinned to 0, so `hash("lattice")` answers
  `-850506456041535210` on every run of every copy of every artifact. A rule is
  a pure function; two runs over an unchanged tree that disagreed would be a
  rule nobody could review.

Adding the frozen standard library was measured and refused: it makes `re`,
`json`, `collections`, `functools`, `typing`, `enum`, `abc`, `copy`, `string`,
`operator`, `textwrap`, `heapq` and `bisect` importable and takes the artifact
from 6.89 MB to 12.99 MB (2.24 MB to 7.01 MB gzipped, which is what git stores,
on every rebuild, forever). The deciding argument was not the bytes: the Rust
binding gives its authors `std` and two serde crates and no regex engine either,
and an SDK that handed one language a capability the other does not have would
stop being a binding of one contract.

### The object ceiling, which is the sharp edge

RustPython keeps an object's strong reference count in the spare bits of one
`usize`, which on a 32-bit target leaves **15 bits: 32,767**. Every live Python
object holds a reference to its own type object, so the number of live dicts,
live strings and live `True`/`False` references are each capped there — and a
workspace's evidence is exactly a large number of live dicts and strings.

The carrier spends a budget of 30,000 objects and answers `unknown` naming the
ceiling before the abort can happen. Measured, for a rule declaring
`["model", "graph"]`:

| the rule can judge | up to  |
| ------------------ | ------ |
| projects           | ~3,700 |
| edges              | ~3,300 |

Only the declared kinds are converted, so a `["model", "graph"]` rule pays
nothing for a workspace's import sites — one with 20,000 of them judges fine.
A rule that declares `imports` spends the same budget on them instead, at about
16 objects per record.

Past the budget the verdict is `unknown` with the workspace's own size named,
never a partial judgment over the records that fit. **A rule that must judge a
workspace larger than this belongs in the Rust SDK**, whose artifact holds no
interpreter and has no such ceiling — the same rule there judges 100,000 import
sites in 463 ms.

## Building the artifact

```bash
rustup target add wasm32-unknown-unknown
python -m lattice_rule_sdk.build rule.py --out rule.wasm
```

It writes `rule.wasm` and `rule.wasm.sha256` beside it — the digest a policy row
pins, bare lowercase hex and nothing else. The first build of a carrier takes
about three minutes; every one after it, with `--keep-crate` pointing somewhere
stable, about forty-five seconds.

The result declares **no imports at all** and exports the four symbols the ABI
names, `memory` among them, plus `__getrandom_v03_custom` (the fixed entropy
backend, exported because a `no_mangle` symbol on wasm is) and the two linker
globals the host ignores. Check both before shipping it:

```bash
node -e 'const m=new WebAssembly.Module(require("fs").readFileSync(process.argv[1]));
console.log(WebAssembly.Module.imports(m), WebAssembly.Module.exports(m).map(e=>e.name))' \
  rule.wasm
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

The `name` here and the `name` in `LATTICE_RULE` must be the same string: the
host refuses the pair when they differ, because the declared name is what every
finding is namespaced under.

## The committed artifact, and why a binary is in this tree

`examples/forbidden_tag_dependency.wasm` is committed, and
`examples/forbidden_tag_dependency.wasm.sha256` beside it holds its digest.
`python3 -m unittest` recomputes the digest over the committed bytes and fails
when the two have drifted, so a rebuilt artifact cannot land beside the digest
of the one before it; the same suite also walks the binary's sections and
refuses one that grew an import section — the host's own no-import refusal,
checked on bytes CPython cannot instantiate (`tests/test_artifact.py`). Rebuild
both together:

```bash
./rebuild-example.sh
```

CI does not run that script. The tests check the bytes in the tree, which is the
point — a green run proves the artifact a reviewer can hash, not one the runner
just produced. The digest pins those bytes; it does not claim a reproducible
build, and a different rustc or a different RustPython will produce a different
artifact and a different digest, which is why the tool writes both files or
neither.

Driven through the engine's own host — `loadCustomRule` and `evaluateCustomRule`
from `../lattice/src/custom-rules/host.mjs` — the committed artifact answers
this, and the five verdicts are the ones
`../lattice-rule-sdk-rust/tests/golden.rs` pins for the Rust reference rule:

```text
artifact bytes: 6919667 sha256: 5f2247cab8d490759f99a0cffafa57aed1c46892a2d3224ea1c5818c4c73ed22
loadCustomRule ms: 120.6
describe: {"contract":1,"name":"forbidden-tag-dependency","needs":["model","graph"],
           "findings":[{"id":"dependency-on-forbidden-tag","message":"a project depends on a project carrying the forbidden tag"}]}

edge-into-forbidden-tag.json       (3517 bytes, 236 ms)  fail            1 finding, beta -> gamma, packages/beta/src/store.rs
every-edge-clean.json              (3370 bytes,  85 ms)  pass            0 findings
no-project-carries-the-tag.json    (2449 bytes,  86 ms)  not_applicable  "no project in this workspace carries …"
params-without-the-tag.json        (3320 bytes,  92 ms)  unknown         "params.forbiddenTag is not a non-empty string …"
edge-into-an-undeclared-project.json (3289 bytes, 85 ms) unknown         "the graph carries an edge into \"epsilon\" …"
```

Against the host's own bounds: 10,000 ms per call and 256 MiB of linear memory.
The artifact instantiates holding 3,407,872 bytes, ends a call holding 5,570,560,
answers `lattice_describe` in 0.8 ms, and three fresh instances over one bundle
produce one byte-identical verdict.

## The fixtures

`fixtures/` holds evidence bundles produced by the engine's own bundle assembly
and canonical serializer — not hand-written JSON that looks like one — and they
are byte-identical copies of `../lattice-rule-sdk-rust/fixtures/`.
`tests/test_artifact.py` compares the two directories and FAILS rather than skips
when the sibling is not there: two SDKs each green against its own idea of the
evidence would leave the thing the suite exists to prove — that one contract
reaches two languages — quietly untested.

`tests/test_golden.py` pins the verdict each fixture must produce, replaying
through `drive`, which is the same entry point the carrier's Rust half calls
inside the artifact. Two of the five are there for the silent direction: a rule
that cannot read its parameters, and a graph naming a project the model does not
declare. Both must answer `unknown`; a suite where they answered `pass` would be
green over a rule that had stopped running.

## What this package will not do

It binds the contract and never interprets it. There is no second verdict
vocabulary, no SDK-specific field, and no re-modelling of the policy — a
constraint row arrives as the plain JSON the engine loaded, because
[the engine](../lattice/README.md) owns that schema and a copy here would drift
from it. Whether a finding resolves to a catalogue entry, whether a verdict is
hollow, whether a `needs` entry names a kind the engine can supply: all of that
is the host's refusal to make, and duplicating it here would put this package's
opinion in front of the real one.

It also declares no dependencies, and the list is meant to stay empty:
`runtime.py` is embedded verbatim into every artifact and executed by an
interpreter with no filesystem, so a dependency could never reach the rule that
imports it. That is why `runtime.py` imports nothing at all, and why
`tests/test_runtime.py` reads it with `ast` and fails if it ever does.

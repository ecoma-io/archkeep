# lattice-rule-sdk (AssemblyScript)

Write a Lattice custom architecture rule in AssemblyScript, compile it to core
WebAssembly, and declare it in your workspace's policy. The engine loads the
artifact, hands it the facts it already observed, and folds the verdict into
`check` beside the built-in boundary rules.

The npm package is `@ecoma-io/lattice-rule-sdk`; the directory carries the `-ts`
suffix because this tree holds four of these and a registry that already
names the language does not repeat it — the reasoning is in
[ADR 0002](../../docs/adr/0002-custom-rules-one-contract.md).

## Read this first: it is AssemblyScript, not TypeScript

The syntax is TypeScript's. The language is not, and no amount of familiar
punctuation changes that. [AssemblyScript](https://www.assemblyscript.org)
compiles a TypeScript-shaped source to WebAssembly ahead of time, with its own
type system, its own standard library and its own garbage collector — there is
no JavaScript engine underneath it at any point.

**What you get.** TypeScript syntax and editor tooling; real static types over
the evidence bundle and the verdict; classes, generics, interfaces, `Map`/`Set`,
string methods, default parameters — all measured against `asc` 0.28.20, all
working. A `.wasm` file at the end — 21 KB for the reference rule.

**What you must not expect.** Each of these was compiled, and the compiler's own
words are quoted:

| you might write             | what `asc` says                                      |
| --------------------------- | ---------------------------------------------------- |
| `x: string \| number`       | `AS100: Not implemented: union types`                |
| `x: any`                    | `TS2304: Cannot find name 'any'`                     |
| `try { … } catch (e) { … }` | `AS100: Not implemented: Exceptions`                 |
| `JSON.parse(text)`          | `TS2304: Cannot find name 'JSON'`                    |
| `const o: { a: i32 } = …`   | `TS1110: Type expected` — no structural object types |
| a closure over a local      | `TS2454: Variable 'n' is used before being assigned` |

There is no Node API, no `fetch`, no `require`, no `Promise`, and no
`node_modules` of JavaScript to reach for — an AssemblyScript library is
AssemblyScript source, compiled into your module. `Math.random()`, `trace()` and
`Date.now()` are refused at compile time by this package's build configuration,
and the section below says why. Numbers are `i32`/`i64`/`f64` rather than one
`number`, and `null` is a real part of a type (`string | null`) whose narrowing
is weaker than TypeScript's: a `const` local narrows after an `== null` check, a
field read does not.

**Why the constraint exists, and why it is not this package's choice.** A custom
rule is one core WebAssembly module that declares **no imports at all** —
`WebAssembly.Module.imports(module).length > 0` is a load refusal, which is the
mechanism behind "a rule holds no ambient capability" rather than a promise
about the host ([the contract](../../docs/reference/custom-rules.md)). A module
with no imports has no clock, no filesystem, no network and no randomness to
reach for, because there is nothing to reach through. TypeScript itself does not
compile to core WebAssembly; AssemblyScript is what gets TypeScript syntax to a
module that meets that bar, and its limits are the price of the guarantee.

If a rule of yours needs something on the "must not expect" list, the answer is
not a bigger SDK: a rule that wants a fact no evidence kind carries is asking for
a new extractor in the engine, which
[the concept page](../../docs/concepts/custom-rules.md) owns as a refusal.

## What a rule is

A pure function from evidence to verdict, and nothing else in either direction.
Here is a complete rule — every line an author writes, nothing elided. It
compiles as it stands, from a directory that has this package installed:

```ts
import {
  CatalogueEntry,
  Evidence,
  EvidenceKind,
  Finding,
  RuleDeclaration,
  Verdict,
  describePacked,
  evaluatePacked,
} from "@ecoma-io/lattice-rule-sdk/assembly";

// The ABI's one export a rule never writes itself: a wasm module exports what
// its entry file exports, and an import cannot put a symbol here.
export { lattice_alloc } from "@ecoma-io/lattice-rule-sdk/assembly";

const RULE = new RuleDeclaration(
  "no-dependency-on-tag",
  [EvidenceKind.Model, EvidenceKind.Graph],
  [new CatalogueEntry("forbidden-edge", "a dependency lands on a forbidden tag")],
);

function evaluate(evidence: Evidence): Verdict {
  const tag = evidence.rule.params.getString("forbiddenTag");
  if (tag == null) {
    // Not `pass`. A rule that could not read its own parameters has not judged
    // anything, and saying so is the whole discipline.
    return Verdict.unknown("params.forbiddenTag is not a string, so nothing was judged");
  }

  const findings: Finding[] = [];
  for (let index = 0; index < evidence.graph.edges.length; index++) {
    const edge = evidence.graph.edges[index];
    const target = evidence.project(edge.target);
    if (target == null) {
      return Verdict.unknown(
        'the graph carries an edge into "' + edge.target + '", which the model does not declare',
      );
    }
    if (!target.hasTag(tag)) continue;
    findings.push(
      new Finding("forbidden-edge", edge.source + " depends on " + edge.target).inProject(
        edge.source,
      ),
    );
  }
  return Verdict.fromFindings(findings);
}

export function lattice_describe(): i64 {
  return describePacked(RULE);
}

export function lattice_evaluate(ptr: i32, len: i32): i64 {
  return evaluatePacked(ptr, len, evaluate);
}
```

The import specifier carries the `/assembly` subpath, and that is measured
rather than stylistic: `asc` 0.28.20 maps a bare package name onto
`~lib/@ecoma-io/lattice-rule-sdk.ts` and fails to find it, with or without
`--path node_modules`.

The last three lines are the ABI, and they are three lines rather than none
because AssemblyScript has no macro system — the Rust SDK generates the same
three exports from `lattice_rule! { … }`, and nothing this package can write
will put a symbol in your module. Forgetting one is not silent: the host refuses
a module missing an ABI export, by name, at load.

[`examples/forbidden-tag-dependency.ts`](examples/forbidden-tag-dependency.ts)
is the same shape, complete, and it is the artifact this package ships and tests.

## The four verdicts, and why `pass` is the narrow one

`pass` is a claim: the rule read the evidence it declared it needs and there was
nothing to report. Everything that is not that claim has its own answer — `fail`
with findings, `not_applicable` with a reason, `unknown` with a reason — because
an empty finding list from a rule that could not look is byte-for-byte identical
to a clean workspace, and nobody files a bug about it.

The API is built so the hollow shapes cannot be written: `Verdict.fail` takes a
`Findings`, whose constructor requires the finding that makes it non-empty;
`Verdict.pass` takes nothing; the two reason-carrying verdicts take their reason
as an argument; and `Finding.at` takes a file and both coordinates together.

Three obligations this type system cannot hold, each refused by the host
instead — named here because a reader has to know where the line is:

- **An empty string.** AssemblyScript has no non-empty-string type, so
  `Verdict.unknown("")` compiles. The host refuses it.
- **A zeroth line.** Rust's `NonZeroU32` has no equivalent here, so
  `Finding.at(file, 0, 0)` compiles. The host refuses it, and
  `ImportRecord.place` is the path that cannot produce one.
- **A finding id your catalogue does not declare.** The host refuses it, because
  SARIF would drop the finding.

The Rust SDK decides its declaration's name grammar, duplicate ids and empty
catalogue at compile time; this one cannot, and does not pretend to. What stands
in its place is [`test/golden.test.mjs`](test/golden.test.mjs), which drives the
committed artifact through the real host — so a declaration this package ships
that the host would refuse is a red test here rather than a load error in your
tree.

## Building the artifact

```bash
./rebuild-example.sh
```

The flags live in [`asconfig.json`](asconfig.json), in one place, because the
`typecheck` target must fail on exactly what the build would fail on. asc parses
that file as strict JSON — a `//` comment fails the run with "Asconfig is not
valid json" — so the argument for each flag is here:

- **`use: ["abort="]`** is THE zero-import flag. AssemblyScript's `abort` —
  reached by `throw`, by a failed `assert`, and by every bounds check — is an
  `env.abort` import by default, and the host refuses a module that declares any
  import at all. With the flag, `abort` compiles to `unreachable`, so the same
  failures become a wasm trap the host names. Measured both ways: without it the
  module declares `env.abort`; with it,
  `WebAssembly.Module.imports(module).length === 0`.
- **`use: ["trace=", "seed=", "Date="]`** are not import removers — they are
  compile-time refusals. `trace()`, `Math.random()` and `Date.now()` each pull an
  `env` import, and these three turn every CALL SITE into `Cannot find name`
  instead. A rule reaching for a debug channel, randomness or the clock fails to
  build, which is earlier than the load refusal it would otherwise get.
- **`runtime: "stub"`** is a bump allocator that never frees, which is exactly
  the lifetime the contract describes: the host builds a fresh instance for every
  call and discards it, so a rule has nothing to free into. Measured on the
  reference rule: stub 21,330 bytes, minimal 22,997, incremental 36,422 — all
  three with zero imports, so the smallest is free.
- **`optimizeLevel: 0, shrinkLevel: 2, converge: true`** is what `-Osize`
  expands to (`asc --showConfig` prints it). 21,330 bytes against 25,486 for
  plain `--optimize`. Size matters here for a reason it usually does not: the
  artifact is committed to the workspace that declares the rule, reviewed as
  bytes, and pinned by a sha256 in the policy row.
- **`noAssert: false`** is stated rather than left implicit. `--noAssert`
  replaces every bounds check with its value, so an out-of-range read would
  return whatever is at that address instead of trapping — a verdict computed
  from memory the rule never wrote, which is the silent direction.

Two flags deliberately absent: `--noUnsafe`, which rejects the `changetype` and
`String.UTF8.decodeUnsafe` the ABI shell is built from (measured: two AS101
errors) even though that code is this package's rather than a rule's; and
`--exportRuntime`, which would export allocator helpers the ABI does not name.

The result declares **no imports at all** and exports exactly the four symbols
the ABI names, `memory` among them — `asc` exports linear memory under that name
unless `--noExportMemory` is passed. Check both before shipping a rule of your
own, because the three `use` flags above cover the three ambient channels
AssemblyScript's own standard library reaches for and nothing stops an
`@external` declaration from adding a fourth:

```bash
node -e 'const m=new WebAssembly.Module(require("fs").readFileSync(process.argv[1]));
console.log(WebAssembly.Module.imports(m), WebAssembly.Module.exports(m).map(e=>e.name))' \
  my-rule.wasm
```

## Declaring it

```js
export const customRules = [
  {
    name: "forbidden-tag-dependency",
    artifact: "tools/rules/forbidden-tag-dependency.wasm",
    sha256: "<the contents of examples/forbidden-tag-dependency.wasm.sha256>",
    params: { forbiddenTag: "layer-infrastructure", exemptTags: ["layer-adapter"] },
    reason: "infrastructure is reached through the domain's ports, never directly",
  },
];
```

The `name` here and the `name` in the `RuleDeclaration` must be the same string:
the host refuses the pair when they differ, because the declared name is what
every finding is namespaced under.

## The committed artifact, and why a binary is in this tree

`examples/forbidden-tag-dependency.wasm` is committed, and
`examples/forbidden-tag-dependency.wasm.sha256` beside it holds its digest —
the same string a policy row pins. `test/artifact.test.mjs` recomputes the digest
over the committed bytes and fails when the two have drifted, so a rebuilt
artifact cannot land beside the digest of the one before it. Rebuild both
together with `./rebuild-example.sh`, which writes both files or neither.

The digest pairs the two committed files; what pairs them with the SOURCE is
[`test/provenance.test.mjs`](test/provenance.test.mjs), which compiles the
example with the pinned `asc` — the devDependency the `typecheck` target
already installs, so no new toolchain anywhere — into a temp directory and
requires the result to be the committed artifact byte for byte. An edit to the
rule without a rebuild goes red there instead of passing every gate, and so
does an `asc` version bump that changes what the same source compiles to.
Nothing it produces is ever written over the committed file: the rebuild is
still made by hand, by the script, digest and all.

CI does not run that script. The tests check the bytes in the tree, which is the
point — a green run proves the artifact a reviewer can hash, not one the runner
just produced. The digest pins those bytes; it does not claim a reproducible
build. Two runs of the same compiler on the same source do produce the same
digest (measured), and a different `asc` version will not — which is exactly
the drift the provenance test turns red.

## The fixtures

`fixtures/` holds evidence bundles produced by the engine's own bundle assembly
and canonical serializer — not hand-written JSON that looks like one — and they
are committed as data rather than regenerated by a script kept here: a generator
in this package would have to import the engine's modules, which is the
dependency direction the scope axis in
[the workspace's boundary law](../../module-boundaries.config.mjs) exists to
refuse. They are byte-identical to
[the Rust SDK's copies](../lattice-rule-sdk-rust/fixtures), and what holds them
that way is no longer a promise:
[`rule-sdks.integration.test.mjs`](../lattice/src/conformance/rule-sdks.integration.test.mjs)
reads every SDK's copy of every fixture and requires them byte-identical, then
drives all four committed artifacts through the engine's real host and requires
one verdict document from each. The copy is still made in the change that lands
each SDK; the gate is what makes an edit to one copy alone go red. When the
evidence contract grows, the fixtures are regenerated from the engine side and
land in the same change.

[`test/golden.test.mjs`](test/golden.test.mjs) pins the verdict each must
produce, and it is the strongest of the three SDK harnesses for one structural
reason: the host is JavaScript, this harness is JavaScript, and the engine sits
in the same tree — so the fixtures are replayed through `loadCustomRule` and
`evaluateCustomRule` themselves rather than through a local stand-in. Every
refusal a consumer's `check` would make is made here first: the digest, the
import section, the missing export, the name that disagrees with the policy row,
the hollow verdict. Three of the cases are there for the silent direction — a
rule that cannot read its parameters, a graph naming a project the model does
not declare, and evidence bytes that are not a bundle at all. All three must
answer `unknown`; a suite where they answered `pass` would be green over a rule
that had stopped running.

## What this package will not do

It binds the contract and never interprets it. There is no second verdict
vocabulary, no SDK-specific field, and no re-modelling of the policy — a
constraint row arrives as a raw `JsonValue` because
[the engine](../lattice/README.md) owns that schema and a copy here would drift
from it. Whether a finding resolves to a catalogue entry, whether a verdict is
hollow, whether a `needs` entry names a kind the engine can supply: all of that
is the host's refusal to make, and duplicating it here would put this package's
opinion in front of the real one.

It also ships no runtime JavaScript. There is no `main`, no `exports` map and
nothing to `import` from Node — what this package publishes is AssemblyScript
source that `asc` compiles into your rule, plus the fixtures and the reference
artifact. The one JavaScript here is the harness under `test/`, which is this
repository's, not yours.

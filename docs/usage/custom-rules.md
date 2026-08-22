# Writing and running a custom rule

The first hour: from an architecture rule nobody can spell in a constraint
table to a `check` that fails on it. [concepts/custom-rules.md](../concepts/custom-rules.md)
owns the model and the refusals, and [reference/custom-rules.md](../reference/custom-rules.md)
owns the exact wire — the exports, the bundle, the verdict, every failure. This
page owns the sequence, and it states no rule the other two already state.

## Before you write code

**Check whether a declared row can already say it.** A fitness function is
language-independent by construction, reviewable as data, deterministic with
nothing left to prove, and it needs no toolchain, no artifact and no hash
([fitness.md](fitness.md), [presets.md](presets.md)). `tag-axis-isolation`
alone covers "no module reaches another module" for a whole partition in one
row. A custom rule is the second tier, for judgments no fixed vocabulary can
hold — your organization's own doctrine, a convention nobody else has.

## 1. Pick the SDK for the language your repository already speaks

Four ship from this repository, on the same version chain as the engine. Each
package's README owns its build story and its measured limits, and those limits
are the reason to read it before choosing:

| language          | package                                                    | built with                        |
| ----------------- | ---------------------------------------------------------- | --------------------------------- |
| Rust              | `lattice-rule-sdk` (crates.io)                             | `wasm32-unknown-unknown`          |
| Go                | `github.com/ecoma-io/lattice/packages/lattice-rule-sdk-go` | TinyGo's freestanding target      |
| TypeScript syntax | `@ecoma-io/lattice-rule-sdk` (npm)                         | AssemblyScript                    |
| Python            | `lattice-rule-sdk` (PyPI)                                  | a RustPython carrier, needs cargo |

The contract, not the SDK, is the interface: any toolchain that emits a
core-wasm module with no imports is equally valid.

## 2. Write the rule

A rule is a pure function from evidence to verdict. It receives the project
model, the graph, the import records and the policy; it returns one of four
verdicts. It cannot read a file, a clock, the network or an environment
variable — not by convention, but because the sandbox grants none of them.

Two habits decide whether the rule is any good, and both are about the
verdicts that are not `pass` and `fail`:

- **Answer `unknown` whenever you could not tell.** Parameters that are not
  there to read, evidence that contradicts itself, a project the graph names
  and the model does not. A rule that answered `pass` in those cases would
  report a clean workspace nobody earned, and nobody would ever file a bug
  about it.
- **Answer `not_applicable` when the rule genuinely does not apply here** — no
  project carries the tag it constrains, say. Reported rather than absorbed
  into a passing count: a rule nobody is protected by should be visible.

Every SDK ships a reference rule implementing exactly one law —
"no project may depend on a project carrying a forbidden tag" — reaching all
four verdicts. Read that file before writing your own; it is short, and it is
the shape.

## 3. Build it, and record its digest

Each SDK's README carries the build command and each package ships a
`rebuild-example.sh` that shows it end to end. What matters afterwards is the
same everywhere: commit the `.wasm`, and record its SHA-256 — that hash is
what makes "the law CI ran is the law review saw" checkable on a file nobody
can read in a diff.

## 4. Declare it in the policy

A rule enters a workspace the way every other law does: a row in the one
policy file ([configuration.md](configuration.md)). Nothing is discovered —
no glob, no convention directory — so a rule that is not declared judges
nothing, and a declared rule whose artifact is missing fails the run rather
than narrowing the law silently.

```js
export const customRules = [
  {
    name: "no-interface-outside-domain",
    artifact: "tools/rules/no_interface_outside_domain.wasm",
    sha256: "…", // the digest from step 3
    params: { domainTag: "layer:domain" },
    reason:
      "interfaces are the domain's ports; declaring one anywhere else inverts the dependency direction",
  },
];
```

`reason` is mandatory, exactly as it is for a suppression and a fitness row: a
rule with no reason is indistinguishable from a rule nobody would defend. The
row takes the same governance block a constraint row does, so it can name the
decision that created it ([adr.md](adr.md)).

The artifact directory needs no `coverage.exempt` row. A `.wasm` is not a
source any analyzer claims, so it never becomes a coverage gap — and an
exemption for it is refused as matching no unclaimed file.

## 5. Run it

```shell
lattice check
```

There is no flag. A policy that declares `customRules` gets them judged on
every unscoped run, because an opt-in flag makes a forgotten flag
byte-identical to "no custom rules checked". A `fail` is a finding like any
other — exit 1, on all three report faces, under the namespaced id
`custom/<rule>/<finding>`, accepted only through the same declared
suppressions and waivers ([checking.md](checking.md), [ci.md](ci.md)).

A **path-scoped** run (`lattice check libs/app`) answers `not_applicable` for
every declared rule: a rule's evidence is the whole tree, and a scoped run
read part of it. Use the whole-workspace run as the gate.

## 6. When it says `unknown`

`unknown` is the rule saying it could not reach a verdict, or the engine
saying the rule could not be run — a trap, an exhausted budget, an unreadable
verdict, an evidence kind this engine does not carry. Either way the run exits
3, and the message names the cause.

The next question is always "what did my rule actually see", and there is a
command for it:

```shell
mkdir -p evidence
lattice check --evidence-out evidence
```

That writes `evidence/<rule>.json` for every declared rule — the exact
document the rule was judged over — including for a rule that trapped, which
is when you need it. Feed it to the replay harness your SDK ships and debug
locally, with no workspace and no engine in the way.

Two things it will not do, both deliberate: it changes no verdict and no exit
code, and it never writes nothing silently — a policy declaring no
`customRules` and a path-scoped run each say so on stderr.

`explain` is not part of this loop. It answers about an import site and the
constraint row that decided it; it does not re-judge a rule the engine did not
write. What explains a custom finding is the rule's own message, the `reason`
its row carries, and the bundle above.

## 7. Living with it

- **An engine upgrade does not invalidate your rule.** The evidence bundle
  grows additively: new kinds and new fields arrive without moving the
  contract number, and a rule compiled before them keeps judging. Only a
  break moves it, and then the artifact is refused at load with both numbers
  named — never approximated. [reference/custom-rules.md](../reference/custom-rules.md)
  owns that policy.
- **Changing your rule changes your verdicts, and that is your change.** The
  law moved, reviewed like code. The engine's compatibility promise covers
  what it feeds a rule, never what the rule concludes.
- **A rule cannot waive anything.** Acceptance stays with the declared
  suppressions and waivers ([waivers.md](../concepts/waivers.md)), and a rule
  that could see them could launder them into its own verdict — which is why
  the bundle carries neither.

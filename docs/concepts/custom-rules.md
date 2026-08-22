# Custom rules

A workspace's own architecture rules, written in the language the repository
already speaks, judged by the same deterministic engine as everything else.
The decision behind the design — one seam, one contract, WebAssembly as the
carrier, and the alternatives that were refused — is recorded in
[adr/0002](../adr/0002-custom-rules-one-contract.md); this page owns the
model a consumer works with,
[reference/custom-rules.md](../reference/custom-rules.md) owns the exact wire
contract, and [usage/custom-rules.md](../usage/custom-rules.md) owns the
sequence — pick an SDK, write it, build it, declare it, run it, debug it.

## One seam: evidence in, verdict out

A custom rule occupies the position the built-in rules and the fitness
registry already hold — after analysis, before report. It receives observed
facts (the project model, the graph, the import records, the policy) and
returns one verdict in the four-state vocabulary every judgment here speaks
([evidence.md](evidence.md)), under the same evidence obligations. It never
reads files, never parses source, never builds a graph, and never touches
another rule's verdict — a rule that wants a language fact the evidence does
not carry is asking for a new evidence kind in the engine's analysis layer,
not a license to parse.

That seam is what keeps this from being a second ESLint: an ESLint rule
receives a file and walks its AST itself, welding the rule to one language's
parser; a Lattice rule receives facts an analyzer already extracted, so one
contract serves every language the analyzers read — and every language they
read later, with no rule changing.

## Two tiers, declarative first

A demand a named fitness condition can meet should be met there
([fitness-functions.md](fitness-functions.md)): a declarative row is
language-independent by construction, reviewable as data, and deterministic
with nothing left to prove. Custom rules are the second tier, for judgments
no fixed vocabulary can hold — an organization's own doctrine, a bespoke
convention, a policy the shipped condition types cannot spell.

## Declared law, never discovered

A custom rule enters through the one policy file, as its fifth top-level
name ([policies.md](policies.md)): a row naming the rule, the committed
`.wasm` artifact it runs, the sha256 that pins the artifact's bytes, its
parameters, and — mandatorily — the reason it exists. Nothing scans for
artifacts: a rule that was not declared judges nothing, and a declared rule
whose artifact is missing fails the run rather than narrowing the law
silently. The rules ride `check` by presence, like fitness — there is no
flag to forget.

## The verdicts, and where they land

Each declared rule answers `pass`, `fail`, `unknown`, or `not_applicable` on
every run. A `fail` is a finding like any other — exit 1, rendered on all
three report faces under the namespaced id `custom/<rule>/<finding>`,
accepted only through the same declared suppressions and waivers. An
`unknown` — the rule's own, or the engine's answer for a rule that trapped,
ran over its budget, or asked for evidence this engine cannot supply — keeps
exit 3, because a rule that could not judge must never read as one that
judged and found nothing. A path-scoped run answers `not_applicable` for
every declared rule: the evidence is the whole tree, and a scoped run cannot
supply it.

## What a custom rule can never do

The sandbox grants a rule the evidence bytes and nothing else — no
filesystem, no network, no clock, no environment; a module that declares any
import at all is refused at load. And the authority line does not move
([../doctrine/architecture-authority.md](../doctrine/architecture-authority.md)):
a custom rule widens what a workspace can judge, never who decides. It
cannot waive, suppress, or amend anything, and agents remain consumers of
its verdicts exactly as they are of the built-ins'.

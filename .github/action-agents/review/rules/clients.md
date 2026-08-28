# Clients and bindings (`packages/` beside `archkeep`)

Everything here is a client of the engine — a VS Code extension, an MCP
server, a rules catalog, four language SDKs — and none of it may grow a
second opinion about what a verdict means:

- **One contract, four spellings.** A change to how a verdict or an evidence
  shape is spelled in one SDK that the others do not mirror is a concern;
  the conformance integration test is the gate that keeps it one, not a
  substitute for noticing.
- **Clients hold no analysis.** Analysis logic appearing under a client
  package is a concern; a client composes the engine's own command layer
  and ships nothing that re-derives a verdict.
- **Bindings build to the wasm the engine already runs.** A binding shipping
  its own runtime, or a second wasm toolchain story beside the one its
  README owns, is a concern.
- **No build step where none is promised.** A package that loads directly —
  no `dist/`, no emit — stays that way; an artefact that needed emitting
  breaks the sentence the package's loading story stands on.
- **Digests verify against actual bytes.** A catalog or manifest entry whose
  recorded digest no longer matches the artifact it names is a concern;
  the integrity gate exists so a green build means something.

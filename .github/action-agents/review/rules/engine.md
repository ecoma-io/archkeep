# Engine (`packages/archkeep/`)

These files ARE the product a consumer pins and runs — the plugin, the
boundary checker, the language server, one analysis behind three faces.
Judge them as shipped code, not as an implementation detail:

- **Types come from JSDoc** and are checked by `tsc --checkJs`. An exported
  function without parameter and return annotations, or an annotation the
  body does not honour, is a nit; an exported type that misdescribes runtime
  behaviour is a concern.
- **The header comment is the contract.** Each module opens with what it is
  and what it refuses to be — the layer split, the per-language parse
  limits, the modelling assumptions. A change that makes the header untrue
  is a concern regardless of test status.
- **A test that only pins the message text is half a test.** Every behaviour
  change needs the case that goes red in the SILENT direction — the
  violation that would now go unreported — not only the loud one.
- **No second opinion about what a verdict means.** The engine is the one
  analysis behind the CLI, the language server and the Nx plugin; a diff
  that lets one face answer differently from the others is a concern.
- **Errors carry their evidence honestly**: operation names, capped
  excerpts, no absolute runner paths, no secrets, causes attached.
- **Fixture names read as invented.** An example project named like a real
  external tree reads as a fact about that tree; invented names that
  announce themselves keep the fixtures honest.

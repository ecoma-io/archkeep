// The Go binding for the custom-rule contract
// (../../docs/adr/0002-custom-rules-one-contract.md).
//
// A Go module carries no version field: its version is the tag, and for a
// module below the repository root that tag is prefixed with the module's own
// directory. The release lane mints `packages/lattice-rule-sdk-go/v<version>`
// beside the bare `v<version>` — which is why nothing here joins
// release-please's `extra-files` or the `../../scripts/check-skills.mjs`
// version chain the way the Cargo, npm and PyPI manifests do. There is no
// number in this file to keep in step.
//
// The module path is the ADR's, spelled out in full because Go's import path
// IS the name; the length is the accepted cost of the monorepo decision.
module github.com/ecoma-io/lattice/packages/lattice-rule-sdk-go

// Measured rather than remembered: tinygo 0.41.0 — the toolchain that builds
// the committed artifact (./rebuild-example.sh) — reports "using go version
// go1.24.7", and the floor cannot be above what the only toolchain that can
// emit the artifact carries.
go 1.24

// No `require` block, and that is the whole dependency story: the evidence
// bundle becomes types and the verdict becomes bytes through `encoding/json`
// from the standard library. The Rust binding declares serde and serde_json
// and argues for keeping the list at two (../lattice-rule-sdk-rust/Cargo.toml);
// here the list is empty, so there is no transitive package that could reach
// for a clock or a socket in a module the host grants no imports at all.

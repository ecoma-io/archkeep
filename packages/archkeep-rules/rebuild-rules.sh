#!/usr/bin/env bash
# Rebuilds the committed rule artifacts and re-records their digests.
#
# RUN THIS IN A CONTAINER, NOT ON YOUR OWN MACHINE — the script does that
# itself; what you must not do is run the cargo command it holds directly on a
# host. `strip = true` in `Cargo.toml`'s release profile removes symbols, not
# the panic paths rustc records for dependencies compiled out of the local
# registry — so a host rebuild leaves `/home/<you>/.cargo/registry/...` inside
# the shipped bytes. The committed artifacts carry none, because they are built
# where those paths do not exist. `../../scripts/check-artifact-hygiene.mjs`
# is what enforces it.
#
# TWO copies, not one whole repository: the rules crate path-depends on
# `../archkeep-rule-sdk-rust`, so the image needs both packages — but copying
# the repository root would drag `node_modules` (gigabytes) into the image for
# a build that never reads it. The two crates are all cargo can see, which is
# also why a stray workspace-level Cargo.toml cannot change what gets built.
#
# THE THREE FILES MOVE TOGETHER OR NOT AT ALL, per rule:
#   rules/<name>.wasm
#   rules/<name>.wasm.sha256
#   the same digest inside catalog.json's entry for the rule
# `tests/artifact.rs` and the catalog validator each hold one of those
# agreements, and `packages/archkeep/src/conformance/official-rules.integration.test.mjs`
# holds the third — a rebuilt `.wasm` landing beside the digest of the one
# before it is exactly the drift those gates exist to refuse. This script
# writes the first two and PRINTS the digest to paste into the third; it does
# not edit catalog.json, because a script editing the catalog is a script a
# reviewer stops reading.
#
# A REBUILD ROTATES EVERY DIGEST, not only the rule that changed: the crate
# builds all examples under one LTO unit, so shared code (a new helper, a new
# rule's module) re-links every artifact whether or not that rule moved. That
# is expected with this layout — the gates are what make it safe rather than
# suspicious: `tests/artifact.rs` and the catalog validator hold the three
# files together, and the conformance suite replays the recorded fixtures
# through the NEW bytes, so a rotated digest that changed an answer fails the
# build instead of shipping. Consumers are untouched: a workspace pins the
# bytes it copied, and this repository's rotation is its own fact.
#
# The build needs the wasm target, which a stock toolchain does not carry
# (`rustup target add wasm32-unknown-unknown` — the container script does this
# itself).
#
# It is deliberately NOT what CI runs. The tests check the COMMITTED bytes, so
# a green build proves the artifact in the tree rather than one the runner just
# made, and a rebuild in CI would be a leg whose only output is a file already
# in git.
set -euo pipefail

cd "$(dirname "$0")"
repo_root="$(cd ../.. && pwd)"

archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT

# The cache volumes carry rustup's wasm32 std and cargo's fetched crates
# between runs, so the second rebuild does not re-download either — the paths
# inside them are the container's own (/usr/local/...), which is exactly the
# property the hygiene gate demands of the bytes they help produce. Two
# volumes, because rustup and cargo keep different trees and one volume
# mounted at both paths would splice them together.
docker run --rm \
  -v "$repo_root":/src:ro \
  -v archkeep-rustup-cache:/usr/local/rustup \
  -v archkeep-cargo-cache:/usr/local/cargo \
  rust:1.96-slim bash -c '
  set -euo pipefail
  mkdir -p /work/packages
  cp -r /src/packages/archkeep-rules /src/packages/archkeep-rule-sdk-rust /work/packages/
  rm -rf /work/packages/archkeep-rules/target /work/packages/archkeep-rule-sdk-rust/target
  cd /work/packages/archkeep-rules
  rustup target add wasm32-unknown-unknown
  cargo build --release --locked --target wasm32-unknown-unknown \
    --example tag_cardinality --example forbidden_tag_combination --example max_fan_out
  tar -C target/wasm32-unknown-unknown/release/examples -cf - \
    tag_cardinality.wasm forbidden_tag_combination.wasm max_fan_out.wasm
' > "$archive"

tar -xOf "$archive" tag_cardinality.wasm > rules/tag-cardinality.wasm
tar -xOf "$archive" forbidden_tag_combination.wasm > rules/forbidden-tag-combination.wasm
tar -xOf "$archive" max_fan_out.wasm > rules/max-fan-out.wasm

# Bare lowercase hex and nothing else: this string is pasted verbatim into a
# `customRules` row's `sha256` field, which is 64 hex characters with no
# filename beside it (`../archkeep/src/config.mjs`).
for name in tag-cardinality forbidden-tag-combination max-fan-out; do
  if command -v sha256sum >/dev/null 2>&1; then
    digest="$(sha256sum "rules/$name.wasm" | cut -d' ' -f1)"
  else
    # macOS ships shasum rather than sha256sum.
    digest="$(shasum -a 256 "rules/$name.wasm" | cut -d' ' -f1)"
  fi
  printf '%s\n' "$digest" >"rules/$name.wasm.sha256"
  printf 'rebuilt rules/%s.wasm (%s bytes), digest %s\n' \
    "$name" "$(wc -c <"rules/$name.wasm" | tr -d ' ')" "$digest"
done

printf '\nNext: paste each digest into the same rule entry in catalog.json.\n'

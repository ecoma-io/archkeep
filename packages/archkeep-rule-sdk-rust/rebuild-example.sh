#!/usr/bin/env bash
# Rebuilds the committed reference artifact and re-records its digest.
#
# The two files move together or not at all: `tests/artifact.rs` fails when they
# disagree, which is what stops a rebuilt `.wasm` from landing beside the digest
# of the one before it. So this script writes both, in that order, and never one
# of them.
#
# The build needs the wasm target, which a stock toolchain does not carry:
#
#   rustup target add wasm32-unknown-unknown
#
# It is deliberately NOT what CI runs. The tests below check the COMMITTED
# bytes, so a green build proves the artifact in the tree rather than one the
# runner just made, and a rebuild in CI would be a leg whose only output is a
# file already in git.
#
# CI does install the target, and that is not this script arriving by the back
# door: `./moon.yml`'s `typecheck` uses it to type-check the
# `#[cfg(target_arch = "wasm32")]` half of `src/abi.rs`, which no host-target
# compilation reads. Reading that source and emitting nothing is a different
# claim from producing bytes, and only the second one is what this paragraph
# refuses.
set -euo pipefail

cd "$(dirname "$0")"

example="forbidden_tag_dependency"

cargo build --release --target wasm32-unknown-unknown --example "$example"
cp "target/wasm32-unknown-unknown/release/examples/$example.wasm" "examples/$example.wasm"

# Bare lowercase hex and nothing else: this string is pasted verbatim into a
# `customRules` row's `sha256` field, which is 64 hex characters with no
# filename beside it (`../archkeep/src/config.mjs`).
if command -v sha256sum >/dev/null 2>&1; then
  digest="$(sha256sum "examples/$example.wasm" | cut -d' ' -f1)"
else
  # macOS ships shasum rather than sha256sum.
  digest="$(shasum -a 256 "examples/$example.wasm" | cut -d' ' -f1)"
fi
printf '%s\n' "$digest" >"examples/$example.wasm.sha256"

printf 'rebuilt examples/%s.wasm (%s bytes), digest %s\n' \
  "$example" "$(wc -c <"examples/$example.wasm" | tr -d ' ')" "$digest"

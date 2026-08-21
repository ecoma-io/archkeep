#!/usr/bin/env bash
# Rebuilds the committed reference artifact and re-records its digest.
#
# The two files move together or not at all: `test/artifact.test.mjs` fails when
# they disagree, which is what stops a rebuilt `.wasm` from landing beside the
# digest of the one before it. So this script writes both, in that order, and
# never one of them.
#
# It is deliberately NOT what CI runs. The tests check the COMMITTED bytes, so a
# green build proves the artifact in the tree rather than one the runner just
# made.
#
# The compiler flags are NOT here. They live in `./asconfig.json`, because the
# `typecheck` target has to fail on exactly what this build would fail on and
# two copies of a flag list agree only until one of them is edited — a
# `--use seed=` present here and absent there would let a rule reaching for
# randomness type-check clean and then refuse to build. `./README.md`'s
# "Building the artifact" section argues each flag; asconfig.json cannot carry
# the argument itself, because asc parses it as strict JSON (measured: a `//`
# comment fails the whole run with "Asconfig is not valid json").
set -euo pipefail

cd "$(dirname "$0")"

example="forbidden-tag-dependency"

node_modules/.bin/asc "examples/$example.ts" \
  --config asconfig.json \
  --outFile "examples/$example.wasm"

# Bare lowercase hex and nothing else: this string is pasted verbatim into a
# `customRules` row's `sha256` field, which is 64 hex characters with no
# filename beside it (`../lattice/src/config.mjs`).
if command -v sha256sum >/dev/null 2>&1; then
  digest="$(sha256sum "examples/$example.wasm" | cut -d' ' -f1)"
else
  # macOS ships shasum rather than sha256sum.
  digest="$(shasum -a 256 "examples/$example.wasm" | cut -d' ' -f1)"
fi
printf '%s\n' "$digest" >"examples/$example.wasm.sha256"

printf 'rebuilt examples/%s.wasm (%s bytes), digest %s\n' \
  "$example" "$(wc -c <"examples/$example.wasm" | tr -d ' ')" "$digest"

#!/usr/bin/env bash
# Rebuilds the committed reference artifact, proves it answers, and re-records
# its digest.
#
# The two files move together or not at all: `go test` fails when they disagree
# (./artifact_test.go), which is what stops a rebuilt `.wasm` from landing
# beside the digest of the one before it. So this script writes both, in that
# order, and never one of them.
#
# The build needs TinyGo, which is not `go`:
#
#   https://tinygo.org/getting-started/install/
#
# Standard Go cannot produce this artifact at all — both of its wasm targets
# import a host, and the contract grants no imports. ./README.md carries the
# measurement.
#
# It is deliberately NOT what CI runs. The tests check the COMMITTED bytes, so a
# green build proves the artifact in the tree rather than one the runner just
# made — and putting a second toolchain on a hosted runner would make every CI
# leg pay for a rebuild whose only output is a file already in git.
set -euo pipefail

cd "$(dirname "$0")"

example="forbidden_tag_dependency"
artifact="examples/$example.wasm"

if ! command -v tinygo >/dev/null 2>&1; then
  echo "tinygo is not on PATH — see https://tinygo.org/getting-started/install/" >&2
  exit 1
fi

# Every flag is stated even where it is the target's own default, so that the
# artifact a contributor rebuilds is the artifact CI would have rather than
# whatever the installed TinyGo currently defaults to. What each one is for:
#
#   -target=wasm-unknown  the freestanding target, and the only one of TinyGo's
#                         wasm targets that imports nothing. `-target=wasm` is
#                         WASI and would be refused at load.
#   -buildmode=c-shared   makes the module a reactor: no _start, and an
#                         _initialize the SDK's ABI shell calls itself
#                         (../abi_freestanding.go). The target already sets this; stated
#                         because the shell's //go:linkname depends on it.
#   -gc=leaking           one instance per call, discarded after it — so a rule
#                         has no lifetime to free memory into. Also the smallest
#                         of the three: 176 KiB against 223 KiB for either
#                         collecting GC, measured on this example.
#   -scheduler=none       a rule is a pure function; there is nothing to
#                         schedule, and the host's budget is what bounds a call.
#   -panic=trap           a panic becomes an `unreachable` instruction, which
#                         the host reports as a named trap. Without it the
#                         panic-printing machinery is linked in and prints to a
#                         target that has no output — it still traps, it just
#                         costs ~11 KiB to say nothing first.
#   -no-debug             drops DWARF. The single largest lever there is: 778
#                         KiB with it, 176 KiB without, and no reader of a
#                         committed wasm rule uses the symbol names.
#   -opt=z                optimise for size, for the reason size matters here at
#                         all: the artifact is committed to the workspace that
#                         declares the rule and reviewed as bytes.
tinygo build \
  -o "$artifact" \
  -target=wasm-unknown \
  -buildmode=c-shared \
  -gc=leaking \
  -scheduler=none \
  -panic=trap \
  -no-debug \
  -opt=z \
  "./examples/$example"

# The artifact is proved before its digest is recorded, which the Rust binding's
# script does not do and this one must (../archkeep-rule-sdk-rust/rebuild-example.sh).
# The reason is one line in ../abi_freestanding.go: this ABI shell reaches TinyGo's
# reactor entry point by its LINKER SYMBOL, because the runtime has no exported
# spelling of it. A TinyGo that renamed the symbol fails the link above, loudly
# — but a TinyGo that changed what it DOES would link, build, and produce an
# artifact that traps on the first call in a consumer's tree. So the module is
# instantiated with an empty imports object, exactly as the host instantiates
# it, and asked to describe itself before anything here writes a digest.
#
# It checks the ABI and nothing above it: no evidence, no verdict, and nothing
# imported from the engine. A build script in this package that imported
# ../archkeep/ would be the dependency direction the scope axis in the
# workspace's boundary law exists to refuse (../../module-boundaries.config.mjs).
node --input-type=module -e '
import { readFileSync } from "node:fs";

const path = process.argv[1];
const module_ = new WebAssembly.Module(readFileSync(path));

const imports = WebAssembly.Module.imports(module_);
if (imports.length > 0) {
  throw new Error(
    `${path} declares ${imports.length} import(s) — the contract grants none: ` +
      imports.map((entry) => `${entry.module}.${entry.name}`).join(", "),
  );
}

const exported = new Map(WebAssembly.Module.exports(module_).map((e) => [e.name, e.kind]));
for (const [name, kind] of [
  ["memory", "memory"],
  ["archkeep_alloc", "function"],
  ["archkeep_describe", "function"],
  ["archkeep_evaluate", "function"],
]) {
  if (exported.get(name) !== kind) {
    throw new Error(`${path} exports no ${kind} named "${name}"`);
  }
}

const instance = new WebAssembly.Instance(module_, {});
const packed = BigInt.asUintN(64, instance.exports.archkeep_describe());
const pointer = Number(packed >> 32n);
const length = Number(packed & 0xffffffffn);
const memory = new Uint8Array(instance.exports.memory.buffer);
if (pointer + length > memory.byteLength || length === 0) {
  throw new Error(`${path}: archkeep_describe returned the range ${pointer}..${pointer + length}`);
}
const described = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
  memory.slice(pointer, pointer + length),
));
console.log(`answers as "${described.name}", needing ${described.needs.join(" and ")}`);
' "$artifact"

# Bare lowercase hex and nothing else: this string is pasted verbatim into a
# `customRules` row's `sha256` field, which is 64 hex characters with no
# filename beside it (../archkeep/src/config.mjs).
if command -v sha256sum >/dev/null 2>&1; then
  digest="$(sha256sum "$artifact" | cut -d' ' -f1)"
else
  # macOS ships shasum rather than sha256sum.
  digest="$(shasum -a 256 "$artifact" | cut -d' ' -f1)"
fi
printf '%s\n' "$digest" >"$artifact.sha256"

printf 'rebuilt %s (%s bytes), digest %s\n' \
  "$artifact" "$(wc -c <"$artifact" | tr -d ' ')" "$digest"

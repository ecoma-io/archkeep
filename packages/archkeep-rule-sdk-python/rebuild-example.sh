#!/usr/bin/env bash
# Rebuilds the committed reference artifact and re-records its digest.
#
# RUN THIS IN A CONTAINER, NOT ON YOUR OWN MACHINE. Measured, not assumed: the
# carrier compiles RustPython from source, and a cargo build script records the
# environment it ran under INTO the artifact — every variable, name and value.
# A rebuild on a developer machine therefore bakes that machine's whole
# environment into a file that is committed and published: absolute paths,
# socket paths, session ids, and any secret that happened to be exported. This
# repository has shipped that twice, once with a live GitHub PAT and once with
# a live agent token, and neither was visible in any diff.
#
#   docker run --rm -v "$PWD/packages":/pkgs:ro rust:1.96-slim bash -c '
#     apt-get update -qq && apt-get install -y -qq python3
#     cp -r /pkgs /work && cd /work/archkeep-rule-sdk-python
#     rustup target add wasm32-unknown-unknown
#     PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m archkeep_rule_sdk.build \
#       examples/forbidden_tag_dependency.py --out /tmp/out.wasm \
#       --sdk-path ../archkeep-rule-sdk-rust --keep-crate /tmp/carrier
#     cat /tmp/out.wasm' > examples/forbidden_tag_dependency.wasm
#
# then re-record the digest with the sha256 line below. What ENFORCES this is
# `../../scripts/check-artifact-hygiene.mjs`, which fails CI on an artifact
# carrying a home directory, a credential shape or a tooling variable — because
# a warning in a header nobody re-reads is not a gate.
#
# The two files move together or not at all: `tests/test_artifact.py` fails when
# they disagree, which is what stops a rebuilt `.wasm` from landing beside the
# digest of the one before it. The build tool writes both, in that order, and
# never one of them.
#
# The build needs the Rust toolchain and the wasm target, which is the whole
# carrier argument in one line — a Python rule becomes a core-wasm module by
# being embedded in one, because no Python toolchain emits a module with an
# empty import section (`README.md`, first section):
#
#   rustup target add wasm32-unknown-unknown
#
# It is deliberately NOT what CI runs. The tests check the COMMITTED bytes, so a
# green build proves the artifact in the tree rather than one the runner just
# made — and a hosted runner would pay four minutes and a rustup target for a
# file already in git.
#
# `--sdk-path` points the generated carrier at this repository's own Rust SDK
# rather than the published crate. Inside this tree that is the correct binding:
# the two SDKs ship on one version chain, and a reference artifact built against
# a crates.io release would be built against a version this working tree may not
# be.
set -euo pipefail

cd "$(dirname "$0")"

rule="forbidden_tag_dependency"

# `--keep-crate` puts the generated crate under `target/`, which the root
# `.gitignore` already covers. Left behind rather than built in a temporary
# directory so cargo's incremental cache survives: the first build of this crate
# takes about three minutes, and every one after it about forty-five seconds.
# `PYTHONDONTWRITEBYTECODE` covers what the tool cannot: `python -m` imports
# the tool's own modules before any of its code runs, so the flag it sets
# internally arrives one import too late for `src/archkeep_rule_sdk/`.
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 -m archkeep_rule_sdk.build \
  "examples/$rule.py" \
  --out "examples/$rule.wasm" \
  --sdk-path ../archkeep-rule-sdk-rust \
  --keep-crate target/carrier

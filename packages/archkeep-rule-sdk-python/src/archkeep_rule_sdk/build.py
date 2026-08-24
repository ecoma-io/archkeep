"""Compile one Python rule into the core-WebAssembly artifact a policy pins.

    python -m archkeep_rule_sdk.build rule.py --out rule.wasm

What it does, in order: reads the rule's declaration out of `rule.py`, writes a
carrier crate into a build directory, runs `cargo build` for
`wasm32-unknown-unknown`, and copies the resulting module out beside a `.sha256`
holding its digest — the exact string a `customRules` row's `sha256` field
takes.

## Why there is a Rust toolchain in a Python SDK's build story

There is no Python toolchain that emits a core-wasm module with an empty import
section. Pyodide targets a JavaScript host; componentize-py emits a
component-model binary over WASI. The engine's host speaks neither and refuses
a module that declares any import at all, so the Python is CARRIED by a Rust
crate that embeds an interpreter — `carrier/lib.rs.template` argues that in
full. `cargo` and the `wasm32-unknown-unknown` target are therefore an
author-side build requirement, once, and nothing a workspace RUNNING the rule
needs: a consumer's `check` reads bytes.

## What this tool deliberately does not check

The rule's declaration — the name's grammar, the finding ids, the catalogue's
shape — is validated by the carrier crate at COMPILE time, by the SDK's
`archkeep_rule!` macro. This file checks only that the pieces are there
(`ARCHKEEP_RULE` exists and states three keys, `evaluate` is callable), because
the grammar already has an owner on the Rust side and a second copy here would
be a third statement of one rule (`../../../../AGENTS.md`). What this file adds
is the FRAME: a cargo failure that came from the declaration is reported as a
declaration failure naming `rule.py`, not as compiler noise.
"""

import argparse
import hashlib
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

#: The build directory's crate name. Fixed rather than derived from the rule
#: name, because a Cargo package name has its own grammar and mapping one onto
#: the other would be a second naming rule for a crate nobody publishes.
CRATE_NAME = "archkeep_rule_carrier"

#: The target the artifact is built for. Not `wasm32-wasip1`: WASI is a set of
#: imports, and the host refuses a module that declares any.
WASM_TARGET = "wasm32-unknown-unknown"

#: `getrandom` has no backend on `wasm32-unknown-unknown` unless one is named.
#: The carrier defines `__getrandom_v03_custom`; this is what makes the crate
#: look for it. Passed through `RUSTFLAGS` because a `cfg` is a compiler flag
#: and cannot be stated in a manifest.
GETRANDOM_BACKEND_FLAG = '--cfg getrandom_backend="custom"'

_CARRIER = Path(__file__).resolve().parent / "carrier"

# Reading a rule's declaration means importing the author's `rule.py`, and an
# import writes a `__pycache__` beside it. A build tool that leaves untracked
# directories in the tree it was pointed at is a build tool whose output nobody
# can `git add -A` safely, so this process writes none.
sys.dont_write_bytecode = True


class BuildError(Exception):
    """A build that could not produce an artifact, with the reason named."""


def read_declaration(rule_path: Path):
    """The rule's `ARCHKEEP_RULE` declaration and its `evaluate`, from its source.

    Loaded by importing the module rather than by parsing it, and the reason is
    that this is the author's own file on the author's own machine: `cargo` is
    about to compile it into a binary either way, so refusing to execute it here
    would buy no safety while costing the only check that catches a rule whose
    module body raises.
    """
    if not rule_path.is_file():
        raise BuildError(f"{rule_path} is not a file")

    spec = importlib.util.spec_from_file_location("archkeep_rule_under_build", rule_path)
    if spec is None or spec.loader is None:
        raise BuildError(f"{rule_path} could not be loaded as a Python module")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    # Broad on purpose: this is the author's own module body, which may raise
    # anything at all, and what a caller needs is the file and the reason.
    except Exception as error:
        raise BuildError(f"{rule_path} raised while loading: {type(error).__name__}: {error}")

    declaration = getattr(module, "ARCHKEEP_RULE", None)
    if not isinstance(declaration, dict):
        raise BuildError(
            f"{rule_path} states no ARCHKEEP_RULE mapping — a rule declares its name, the "
            f"evidence kinds it needs, and its findings catalogue beside the function that "
            f"reads them"
        )
    missing = [key for key in ("name", "needs", "findings") if key not in declaration]
    if missing:
        raise BuildError(
            f"{rule_path}'s ARCHKEEP_RULE states no {', '.join(missing)} — the three keys are "
            f"what the artifact answers archkeep_describe with"
        )
    if not callable(getattr(module, "evaluate", None)):
        raise BuildError(
            f"{rule_path} defines no evaluate(evidence) function — the carrier reads it by name"
        )
    return declaration


def render_carrier(declaration, rule_path: Path, crate_dir: Path, sdk_dependency: str) -> None:
    """Writes the carrier crate for one rule into `crate_dir`."""
    source_dir = crate_dir / "src"
    source_dir.mkdir(parents=True, exist_ok=True)

    manifest = (_CARRIER / "Cargo.toml.template").read_text(encoding="utf-8")
    manifest = manifest.replace("{{CRATE_NAME}}", CRATE_NAME)
    manifest = manifest.replace("{{SDK_DEPENDENCY}}", sdk_dependency)
    (crate_dir / "Cargo.toml").write_text(manifest, encoding="utf-8")

    lib = (_CARRIER / "lib.rs.template").read_text(encoding="utf-8")
    lib = lib.replace("{{RULE_NAME}}", str(declaration["name"]))
    needs = [str(kind) for kind in declaration["needs"]]
    # Twice, in two spellings. `{{NEEDS}}` is the bare-word list the
    # `archkeep_rule!` macro takes; `{{NEEDS_WIRE}}` is the same kinds as Rust
    # string literals, which the carrier hands the Python runtime so both
    # runners agree on what the rule may read. One list, rendered for the two
    # places that need it — never two lists to keep in step.
    lib = lib.replace("{{NEEDS_WIRE}}", ", ".join(_rust_string(kind) for kind in needs))
    lib = lib.replace("{{NEEDS}}", ", ".join(needs))
    lib = lib.replace("{{FINDINGS}}", _findings_literal(declaration["findings"]))
    (source_dir / "lib.rs").write_text(lib, encoding="utf-8")

    # The runtime the artifact runs is the file the author's own tests import,
    # copied rather than re-rendered: a template of it would be a second
    # version of the runtime, and the two would agree only until one was edited.
    shutil.copyfile(Path(__file__).resolve().parent / "runtime.py", source_dir / "archkeep_rule_sdk.py")
    shutil.copyfile(rule_path, source_dir / "rule.py")


def _findings_literal(findings) -> str:
    """The catalogue as the Rust literal list `archkeep_rule!` takes.

    The entries are written as Rust string literals through `json.dumps`-shaped
    escaping done by `repr`-free means: a catalogue message is the author's
    prose and may hold quotes, backslashes or newlines, and a naive f-string
    would produce a crate that does not compile — with the error pointing at
    generated code rather than at the message that caused it.
    """
    entries = []
    for index, entry in enumerate(findings):
        try:
            id, message = entry["id"], entry["message"]
        except (TypeError, KeyError):
            raise BuildError(
                f"ARCHKEEP_RULE['findings'][{index}] is {entry!r}, and a catalogue entry states "
                f"an id and a message"
            )
        entries.append(f"({_rust_string(id)}, {_rust_string(message)})")
    return ", ".join(entries)


def _rust_string(value) -> str:
    """One Python string as a Rust string literal."""
    if not isinstance(value, str):
        raise BuildError(f"{value!r} is not a string, and a catalogue entry holds two of them")
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"'


def run_cargo(crate_dir: Path, offline: bool) -> Path:
    """Builds the carrier and answers the path of the module cargo produced."""
    environment = dict(os.environ)
    flags = environment.get("RUSTFLAGS", "")
    if GETRANDOM_BACKEND_FLAG not in flags:
        environment["RUSTFLAGS"] = f"{flags} {GETRANDOM_BACKEND_FLAG}".strip()

    command = ["cargo", "build", "--release", "--target", WASM_TARGET]
    if offline:
        command.append("--offline")

    try:
        # An argument list, never a built string: every value in play here comes
        # from a path the author passed in, and a directory named `a;rm -rf .`
        # stops being a name and becomes two commands
        # (`../../../../SECURITY.md`).
        completed = subprocess.run(command, cwd=crate_dir, env=environment, check=False)
    except FileNotFoundError:
        raise BuildError(
            "cargo is not on PATH. Building a Python rule needs the Rust toolchain and the "
            f"{WASM_TARGET} target — `rustup target add {WASM_TARGET}` — because there is no "
            "Python toolchain that emits a core-wasm module with no imports. Running a built "
            "rule needs neither."
        )
    if completed.returncode != 0:
        raise BuildError(
            f"cargo build failed (exit {completed.returncode}). When the failure names "
            "ARCHKEEP_RULE, assert_valid or a const evaluation, it is the rule's declaration "
            "that is wrong — the name's grammar, a duplicate finding id, or an empty "
            "catalogue — and the carrier is where that is checked."
        )

    artifact = crate_dir / "target" / WASM_TARGET / "release" / f"{CRATE_NAME}.wasm"
    if not artifact.is_file():
        raise BuildError(
            f"cargo reported success and wrote no {artifact.name} — nothing was produced, and "
            "an absent artifact is never read as a built one"
        )
    return artifact


def build(rule_path: Path, out_path: Path, sdk_dependency: str, keep: Path | None, offline: bool) -> None:
    """The whole build, from a `rule.py` to a `.wasm` and its digest."""
    declaration = read_declaration(rule_path)

    if keep is not None:
        keep.mkdir(parents=True, exist_ok=True)
        _build_in(declaration, rule_path, keep, out_path, sdk_dependency, offline)
        return
    with tempfile.TemporaryDirectory(prefix="archkeep-rule-carrier-") as scratch:
        _build_in(declaration, rule_path, Path(scratch), out_path, sdk_dependency, offline)


def _build_in(declaration, rule_path, crate_dir, out_path, sdk_dependency, offline) -> None:
    render_carrier(declaration, rule_path, crate_dir, sdk_dependency)
    artifact = run_cargo(crate_dir, offline)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(artifact, out_path)
    digest = hashlib.sha256(out_path.read_bytes()).hexdigest()
    # Bare lowercase hex and a newline, nothing else: this string is pasted
    # verbatim into a `customRules` row's `sha256` field, which is 64 hex
    # characters with no filename beside it.
    out_path.with_suffix(out_path.suffix + ".sha256").write_text(digest + "\n", encoding="utf-8")

    print(
        f"built {out_path} ({out_path.stat().st_size} bytes) for rule "
        f"\"{declaration['name']}\", digest {digest}"
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m archkeep_rule_sdk.build",
        description="Compile a Python Archkeep rule into a core-WebAssembly artifact.",
    )
    parser.add_argument("rule", type=Path, help="the rule's Python source")
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="where to write the .wasm; a .wasm.sha256 is written beside it",
    )
    parser.add_argument(
        "--sdk-path",
        type=Path,
        default=None,
        help=(
            "build against a local checkout of the Rust SDK crate instead of the published "
            "one — how this repository builds its own reference artifact"
        ),
    )
    parser.add_argument(
        "--keep-crate",
        type=Path,
        default=None,
        help=(
            "write the generated carrier crate here and leave it behind, so cargo's "
            "incremental cache survives between builds"
        ),
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="pass --offline to cargo, for a build with no registry access",
    )
    arguments = parser.parse_args(argv)

    if arguments.sdk_path is None:
        # The published crate, at this package's own version: the SDKs and the
        # engine share one version chain (`../../../../docs/skills/versioning.md`),
        # so a rule built by this tool is built against the binding that shipped
        # with it.
        sdk_dependency = f'"{_own_version()}"'
    else:
        sdk_dependency = f'{{ path = "{arguments.sdk_path.resolve().as_posix()}" }}'

    try:
        build(
            arguments.rule.resolve(),
            arguments.out.resolve(),
            sdk_dependency,
            arguments.keep_crate.resolve() if arguments.keep_crate else None,
            arguments.offline,
        )
    except BuildError as error:
        print(f"archkeep: {error}", file=sys.stderr)
        return 1
    return 0


def _own_version() -> str:
    """This package's version, read from the metadata that installed it.

    Falls back loudly rather than to a literal: a version guessed here would
    pin a rule's binding to a crate that may not exist, and the failure would
    arrive as an unresolvable dependency with no clue where the number came
    from.
    """
    try:
        from importlib.metadata import version

        return version("archkeep-rule-sdk")
    # Broad on purpose: importlib.metadata raises several unrelated types when
    # a distribution is not installed, and every one of them means the same
    # thing here — the version to build against is not knowable.
    except Exception as error:
        raise BuildError(
            "this package's own version could not be read from its installed metadata "
            f"({type(error).__name__}: {error}), so the crate version to build against is "
            "unknown — pass --sdk-path to build against a checkout instead"
        )


if __name__ == "__main__":
    raise SystemExit(main())

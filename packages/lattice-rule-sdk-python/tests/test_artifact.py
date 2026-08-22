"""The committed artifact, and the two files that must move together.

`../examples/forbidden_tag_dependency.wasm` is checked in, and
`...wasm.sha256` beside it holds its digest — the same string a `customRules`
row pins it by. This file recomputes the digest over the committed bytes and
fails when the two have drifted, so a rebuilt artifact cannot land beside the
digest of the one before it.

What it deliberately does NOT do is instantiate the module. A `.wasm` cannot be
run from CPython without a WebAssembly runtime, and adding one as a dependency
would make every author install a second interpreter to test a rule that is
already an interpreter. The artifact's behaviour is proven instead by driving it
through the engine's own host, recorded verbatim in `../README.md` — the same
split `../../lattice-rule-sdk-rust/tests/artifact.rs` makes for the same reason.
"""

import hashlib
import unittest
from pathlib import Path

_PACKAGE = Path(__file__).resolve().parent.parent

ARTIFACT = _PACKAGE / "examples" / "forbidden_tag_dependency.wasm"
DIGEST_FILE = _PACKAGE / "examples" / "forbidden_tag_dependency.wasm.sha256"
FIXTURES = _PACKAGE / "fixtures"
RUST_FIXTURES = _PACKAGE.parent / "lattice-rule-sdk-rust" / "fixtures"

#: The eight bytes every core WebAssembly module starts with: `\0asm` and
#: version 1. A component-model binary carries a different layer field here, and
#: the host would refuse it — so this is the cheapest place to catch a build
#: that produced the wrong KIND of wasm.
WASM_PREAMBLE = b"\x00asm\x01\x00\x00\x00"


class TheCommittedArtifact(unittest.TestCase):
    def test_is_present_and_is_a_core_wasm_module(self):
        self.assertTrue(ARTIFACT.is_file(), f"{ARTIFACT} is not committed")
        bytes_ = ARTIFACT.read_bytes()
        self.assertGreater(len(bytes_), 0, "the committed artifact is empty")
        self.assertEqual(bytes_[:8], WASM_PREAMBLE)

    def test_hashes_to_the_digest_committed_beside_it(self):
        """The drift test.

        Without it a rebuilt `.wasm` could land beside the digest of the one
        before it, and every workspace pinning that digest would refuse to load
        a rule that is in the tree — or, worse, the tree and the pin would agree
        on a rule nobody built.
        """
        self.assertTrue(DIGEST_FILE.is_file(), f"{DIGEST_FILE} is not committed")
        declared = DIGEST_FILE.read_text(encoding="utf-8").strip()
        self.assertEqual(len(declared), 64, "a sha256 is 64 hex characters and nothing else")
        self.assertEqual(declared, declared.lower(), "a policy row pins lowercase hex")
        self.assertEqual(hashlib.sha256(ARTIFACT.read_bytes()).hexdigest(), declared)


class TheSharedConformanceFixtures(unittest.TestCase):
    """The fixtures here and the Rust SDK's are one suite, not two.

    Two SDKs holding differently-worded bundles would each be green against its
    own idea of the evidence, and the thing the suite exists to prove — that one
    contract reaches two languages — would have quietly stopped being tested.
    """

    def test_are_byte_identical_to_the_rust_sdk_s(self):
        # A failure rather than a skip when the sibling package is not there.
        # A skip would leave this suite green on the day the two halves stopped
        # being comparable, which is the whole failure it exists to catch.
        self.assertTrue(
            RUST_FIXTURES.is_dir(),
            f"{RUST_FIXTURES} is not there, so the two halves of the conformance suite could "
            f"not be compared — this is a failure and never a skip",
        )
        here = sorted(path.name for path in FIXTURES.glob("*.json"))
        there = sorted(path.name for path in RUST_FIXTURES.glob("*.json"))
        self.assertEqual(here, there, "the two SDKs replay different fixture sets")
        self.assertGreater(len(here), 0, "no fixture was compared")
        for name in here:
            self.assertEqual(
                (FIXTURES / name).read_bytes(),
                (RUST_FIXTURES / name).read_bytes(),
                f"{name} differs between the two SDKs",
            )


if __name__ == "__main__":
    unittest.main()

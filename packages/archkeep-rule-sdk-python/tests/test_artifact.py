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
split `../../archkeep-rule-sdk-rust/tests/artifact.rs` makes for the same reason.
"""

import hashlib
import unittest
from pathlib import Path

_PACKAGE = Path(__file__).resolve().parent.parent

ARTIFACT = _PACKAGE / "examples" / "forbidden_tag_dependency.wasm"
DIGEST_FILE = _PACKAGE / "examples" / "forbidden_tag_dependency.wasm.sha256"
FIXTURES = _PACKAGE / "fixtures"
RUST_FIXTURES = _PACKAGE.parent / "archkeep-rule-sdk-rust" / "fixtures"

#: The eight bytes every core WebAssembly module starts with: `\0asm` and
#: version 1. A component-model binary carries a different layer field here, and
#: the host would refuse it — so this is the cheapest place to catch a build
#: that produced the wrong KIND of wasm.
WASM_PREAMBLE = b"\x00asm\x01\x00\x00\x00"


def _uvarint(data: bytes, offset: int):
    """Read one LEB128 unsigned integer at ``offset``.

    Answers ``(value, next_offset)``, or ``None`` when the encoding runs off
    the end of ``data`` — which the caller must treat as a corrupt file rather
    than as "no imports found". The standard library has no LEB128 reader and
    this package takes no dependencies, so the algorithm is here: the same
    choice the Rust SDK makes for SHA-256 in
    ``../../archkeep-rule-sdk-rust/tests/artifact.rs``, and for the same reason.
    """
    value = 0
    shift = 0
    while True:
        if offset >= len(data):
            return None
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7
        if shift >= 64:
            return None


def _refuse_unless_import_free(module: bytes) -> None:
    """Walk a module's sections, raising AssertionError at the contract's refusal.

    Split from the committed artifact's test for the same reason the Rust
    suite's SHA-256 is held against FIPS 180-4's published vectors: the
    committed artifact carries NO import section, so a walk tested only against
    it could drift — an id comparison that stops comparing, a length read that
    miscounts — and stay green forever by not looking.
    ``TheImportSectionWalk`` below is the synthetic modules that make these
    refusals real rather than unreachable branches.

    Sections follow the 8-byte preamble, each a one-byte id then a LEB128
    length then that many bytes. Stopping at the first malformed length keeps a
    corrupt file from being read as one that simply has no imports — the silent
    direction — and the tail check keeps one whose declared lengths run past
    its end from passing either.
    """
    offset = 8
    while offset < len(module):
        section_id = module[offset]
        offset += 1
        read = _uvarint(module, offset)
        if read is None:
            raise AssertionError(
                f"the section at byte {offset} has no readable length, so this module is "
                f"not one this test can clear"
            )
        value, offset = read
        if section_id == 2:
            raise AssertionError(
                "the module declares an import section, and the contract grants no imports "
                "— the host would refuse it at load"
            )
        offset += value
    if offset != len(module):
        raise AssertionError(
            f"the sections do not add up to the module's {len(module)} bytes, ending at {offset}"
        )


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
        self.assertEqual(
            len(declared), 64, "a sha256 is 64 hex characters and nothing else"
        )
        self.assertEqual(declared, declared.lower(), "a policy row pins lowercase hex")
        self.assertEqual(hashlib.sha256(ARTIFACT.read_bytes()).hexdigest(), declared)

    def test_declares_no_import_section(self):
        """The contract's own refusal, checked on the bytes rather than by the host.

        A module that imports anything is refused at load — "a rule holds no
        ambient capability" — but neither of the two tests above would notice an
        artifact that grew an import section: the digest moves WITH the bytes it
        hashes, and the preamble sits in front of whatever follows. CPython
        cannot instantiate the module to let the host speak for itself, so what
        this test can check is the binary — and section id 2 is the import
        section. The Go binding reaches the same refusal with the same walk
        (``../../archkeep-rule-sdk-go/artifact_test.go``), and
        ``../rebuild-example.sh`` drives the real instantiation before it
        records a digest.
        """
        _refuse_unless_import_free(ARTIFACT.read_bytes())


class TheImportSectionWalk(unittest.TestCase):
    """The walk's refusals, proven against modules built here.

    The committed artifact can only ever show the clearing half: it has no
    import section, so a walk whose refusal regressed would keep this suite
    green while every module the host actually refuses sailed through. These
    are the positive cases — a walker is shown FINDING what it exists to find,
    the way the Rust suite's SHA-256 is shown against FIPS 180-4's vectors
    before it is trusted with the artifact.
    """

    @staticmethod
    def _module(*sections):
        return WASM_PREAMBLE + b"".join(sections)

    def test_refuses_a_module_carrying_an_import_section(self):
        # One memory import on behalf of the (empty-named) module "a": count=1,
        # name len=0, kind=2, limits flags/min/max.
        with self.assertRaises(AssertionError) as refused:
            _refuse_unless_import_free(
                self._module(bytes([2, 6, 1, 0, 2, 1, 1, 1])),
            )
        self.assertIn("declares an import section", str(refused.exception))

    def test_refuses_a_length_that_never_terminates(self):
        # A continuation byte with nothing after it: reading it as zero
        # sections would be a clean answer over a corrupt file.
        with self.assertRaises(AssertionError) as refused:
            _refuse_unless_import_free(self._module(bytes([1, 0x80])))
        self.assertIn("no readable length", str(refused.exception))

    def test_refuses_a_payload_truncated_after_its_declared_length(self):
        # Ten of the two hundred bytes the length claims: the framing
        # arithmetic must notice, not wrap around into a clean pass.
        with self.assertRaises(AssertionError) as refused:
            _refuse_unless_import_free(self._module(bytes([1, 0xC8, 0x01]), bytes(10)))
        self.assertIn("do not add up", str(refused.exception))

    def test_clears_a_module_without_an_import_section(self):
        # The positive half: the walk must clear what should clear, including a
        # section whose length needs two LEB128 bytes — a uvarint that stopped
        # after the first byte would misread it as a tiny section, and only a
        # module exercising both bytes can tell.
        clean = bytes([0, 4, 1, ord("a"), ord("b"), ord("c")])  # a custom section
        long = bytes([1, 0xC8, 0x01]) + bytes(
            200
        )  # type section, two-byte LEB128 length
        try:
            _refuse_unless_import_free(self._module(clean, long))
        except AssertionError as assertion:
            self.fail(f"the walk refused a module with no import section: {assertion}")


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

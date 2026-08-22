"""The build path: what it refuses, and what it renders into the carrier crate.

`build.py` turns an author's `rule.py` into a Rust crate and hands that crate
to `cargo`. Everything it does before cargo is arithmetic on text, and until
this file nothing read any of it — 336 lines whose only exercise was a
contributor running `rebuild-example.sh`, which no gate runs (`../moon.yml`
says why the wasm rebuild stays out of CI).

What that left uncovered is not cosmetic. The renderer writes an author's prose
into Rust source, so a message holding a quote decides between a crate that
compiles and one whose error points at generated code the author never wrote;
and a placeholder the renderer does not know about reaches cargo as a syntax
error in a file nobody edited. Both fail LOUDLY in the end — they just fail
somewhere the author cannot read, which is the cost this file buys down.

`run_cargo` and `build` are deliberately absent: they need a Rust toolchain and
the `wasm32-unknown-unknown` target, which is an author-side requirement and
not something a test run here installs. What is covered is every decision taken
before the subprocess.
"""

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

_PACKAGE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_PACKAGE / "src"))

# Imported after the sys.path line above rather than at the top of the file:
# the package is not installed, and the path is what makes it importable.
from lattice_rule_sdk import build as build_module
from lattice_rule_sdk.build import (
    CRATE_NAME,
    BuildError,
    _findings_literal,
    _rust_string,
    read_declaration,
    render_carrier,
)

#: A rule module that declares everything `read_declaration` looks for.
WELL_FORMED = '''
LATTICE_RULE = {
    "name": "no-app-to-ring",
    "needs": ["model", "graph"],
    "findings": [{"id": "reached-ring", "message": "the app layer reached a ring internal"}],
}


def evaluate(evidence):
    return None
'''


def _written(text, directory, name="rule.py"):
    """`text` as a file in `directory`, so a case names its own input."""
    path = Path(directory) / name
    path.write_text(text, encoding="utf-8")
    return path


class RustStringTests(unittest.TestCase):
    """One Python string as a Rust literal — the escape that keeps a crate closed."""

    def test_escapes_every_character_that_would_end_the_literal_early(self):
        # The silent-ish direction for a generated file: a message holding a
        # quote or a backslash produces source that either does not compile or,
        # worse, compiles into something the author did not write. Pinned as
        # the exact literal because that string is what cargo reads.
        self.assertEqual(_rust_string('say "hi"'), '"say \\"hi\\""')
        self.assertEqual(_rust_string("a\\b"), '"a\\\\b"')
        self.assertEqual(_rust_string("one\ntwo"), '"one\\ntwo"')
        self.assertEqual(_rust_string("one\r\ntwo"), '"one\\r\\ntwo"')
        self.assertEqual(_rust_string("col\tumn"), '"col\\tumn"')

    def test_escapes_the_backslash_before_it_escapes_anything_else(self):
        # Order is load-bearing: escaping the quote first would leave the
        # backslash it introduced to be doubled by the backslash pass, and the
        # literal would carry a character the author never typed.
        self.assertEqual(_rust_string('\\"'), '"\\\\\\""')

    def test_refuses_a_value_that_is_not_a_string(self):
        for value in (7, None, ["reached-ring"], {"id": "reached-ring"}):
            with self.assertRaises(BuildError) as raised:
                _rust_string(value)
            self.assertIn("is not a string", str(raised.exception))


class FindingsLiteralTests(unittest.TestCase):
    """The catalogue as the literal list `lattice_rule!` takes."""

    def test_renders_every_entry_as_an_id_and_message_pair(self):
        self.assertEqual(
            _findings_literal(
                [
                    {"id": "reached-ring", "message": "the app layer reached a ring internal"},
                    {"id": "unplaced-reach", "message": 'a reach with a "quote" in it'},
                ]
            ),
            '("reached-ring", "the app layer reached a ring internal"), '
            '("unplaced-reach", "a reach with a \\"quote\\" in it")',
        )

    def test_renders_an_empty_catalogue_as_the_empty_list(self):
        # Not a refusal HERE, and deliberately so: an empty catalogue is
        # refused by the engine's host at load, by name and with the reason
        # ("a rule that can name nothing it might find ... would read as
        # permanently clean"), and a second copy of that rule in this file
        # would be a rule stated twice (`../../../AGENTS.md`).
        self.assertEqual(_findings_literal([]), "")

    def test_refuses_an_entry_that_states_no_id_or_no_message(self):
        for entry in ({"id": "reached-ring"}, {"message": "m"}, None, "reached-ring", 7):
            with self.assertRaises(BuildError) as raised:
                _findings_literal([entry])
            self.assertIn("findings'][0]", str(raised.exception))
            self.assertIn("states an id and a message", str(raised.exception))

    def test_names_the_index_of_the_entry_that_is_wrong(self):
        # A catalogue is a list an author edits, and "one of your findings is
        # malformed" sends them to read all of them.
        with self.assertRaises(BuildError) as raised:
            _findings_literal(
                [{"id": "a", "message": "m"}, {"id": "b", "message": "m"}, {"id": "c"}]
            )
        self.assertIn("findings'][2]", str(raised.exception))


class ReadDeclarationTests(unittest.TestCase):
    """What a rule file must state before a crate is written for it."""

    def test_reads_the_declaration_a_well_formed_rule_states(self):
        with TemporaryDirectory() as directory:
            declaration = read_declaration(_written(WELL_FORMED, directory))
        self.assertEqual(declaration["name"], "no-app-to-ring")
        self.assertEqual(declaration["needs"], ["model", "graph"])

    def test_refuses_a_path_that_is_not_a_file(self):
        with TemporaryDirectory() as directory:
            with self.assertRaises(BuildError) as raised:
                read_declaration(Path(directory) / "absent.py")
            self.assertIn("is not a file", str(raised.exception))

    def test_reports_a_module_that_raises_with_the_file_and_the_reason(self):
        # The check the docstring says importing buys over parsing: a rule
        # whose module body raises is found here, named, rather than at cargo
        # time or — worse — inside the artifact.
        with TemporaryDirectory() as directory:
            path = _written("raise ValueError('the tag table is empty')", directory)
            with self.assertRaises(BuildError) as raised:
                read_declaration(path)
        message = str(raised.exception)
        self.assertIn("raised while loading", message)
        self.assertIn("ValueError", message)
        self.assertIn("the tag table is empty", message)

    def test_refuses_a_module_that_states_no_declaration(self):
        with TemporaryDirectory() as directory:
            path = _written("def evaluate(evidence):\n    return None\n", directory)
            with self.assertRaises(BuildError) as raised:
                read_declaration(path)
        self.assertIn("states no LATTICE_RULE mapping", str(raised.exception))

    def test_refuses_a_declaration_that_is_not_a_mapping(self):
        with TemporaryDirectory() as directory:
            path = _written("LATTICE_RULE = ['no-app-to-ring']\n", directory)
            with self.assertRaises(BuildError) as raised:
                read_declaration(path)
        self.assertIn("states no LATTICE_RULE mapping", str(raised.exception))

    def test_names_every_missing_key_at_once(self):
        # All three, not the first one: an author fixing a declaration one
        # named key per build is three builds where one would do.
        with TemporaryDirectory() as directory:
            path = _written("LATTICE_RULE = {}\n\ndef evaluate(e):\n    return None\n", directory)
            with self.assertRaises(BuildError) as raised:
                read_declaration(path)
        message = str(raised.exception)
        for key in ("name", "needs", "findings"):
            self.assertIn(key, message)

    def test_refuses_a_module_whose_evaluate_is_missing_or_not_callable(self):
        for tail in ("", "evaluate = 7\n"):
            with TemporaryDirectory() as directory:
                source = WELL_FORMED.split("def evaluate")[0] + tail
                path = _written(source, directory)
                with self.assertRaises(BuildError) as raised:
                    read_declaration(path)
            self.assertIn("defines no evaluate(evidence) function", str(raised.exception))


class RenderCarrierTests(unittest.TestCase):
    """The crate written for one rule, before cargo ever sees it."""

    def _render(self, source=WELL_FORMED):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        rule_path = _written(source, root)
        crate_dir = root / "crate"
        declaration = read_declaration(rule_path)
        render_carrier(declaration, rule_path, crate_dir, sdk_dependency='path = "../.."')
        return crate_dir

    def test_leaves_no_placeholder_unrendered_in_either_file(self):
        # The gate that survives a template growing a placeholder this renderer
        # does not know about. Unrendered, `{{WHATEVER}}` reaches cargo as a
        # syntax error in a generated file — a failure the author reads as
        # compiler noise about code they never wrote, which is exactly the
        # frame `build.py`'s own docstring says it exists to provide.
        crate_dir = self._render()
        for name in ("Cargo.toml", "src/lib.rs"):
            text = (crate_dir / name).read_text(encoding="utf-8")
            self.assertNotIn("{{", text, f"{name} still carries an unrendered placeholder")

    def test_writes_the_needs_list_in_both_spellings_from_one_source(self):
        # `{{NEEDS}}` and `{{NEEDS_WIRE}}` are the same kinds twice — bare words
        # for the macro, string literals for the Python runtime — and the two
        # disagreeing is a rule the macro admits and the runtime refuses, on
        # evidence it was handed.
        lib = (self._render() / "src" / "lib.rs").read_text(encoding="utf-8")
        self.assertIn("model, graph", lib)
        self.assertIn('"model", "graph"', lib)

    def test_writes_the_rule_name_and_its_catalogue(self):
        lib = (self._render() / "src" / "lib.rs").read_text(encoding="utf-8")
        self.assertIn("no-app-to-ring", lib)
        self.assertIn('("reached-ring", "the app layer reached a ring internal")', lib)

    def test_names_the_crate_the_manifest_declares(self):
        manifest = (self._render() / "Cargo.toml").read_text(encoding="utf-8")
        self.assertIn(CRATE_NAME, manifest)
        self.assertIn('path = "../.."', manifest)

    def test_copies_the_runtime_the_author_tests_against_rather_than_rendering_one(self):
        # Byte-identical, because a second copy of the runtime would agree with
        # the first only until one of them was edited — and the disagreement
        # would be between what the author's tests import and what the artifact
        # actually runs.
        crate_dir = self._render()
        shipped = (
            Path(build_module.__file__).resolve().parent / "runtime.py"
        ).read_bytes()
        self.assertEqual((crate_dir / "src" / "lattice_rule_sdk.py").read_bytes(), shipped)

    def test_copies_the_rule_itself_under_the_name_the_carrier_imports(self):
        crate_dir = self._render()
        self.assertIn("LATTICE_RULE", (crate_dir / "src" / "rule.py").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

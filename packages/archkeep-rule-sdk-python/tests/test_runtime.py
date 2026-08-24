"""The authoring runtime: what it refuses, and what it turns a failure into.

Every test here is about a shape that must NOT be constructible or a failure
that must NOT read as clean. The happy paths are covered by `test_golden.py`,
which replays the real fixtures; this file is the red direction.
"""

import ast
import sys
import unittest
from pathlib import Path

_PACKAGE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_PACKAGE / "src"))

# Imported after the sys.path line above rather than at the top of the file:
# the package is not installed, and the path is what makes it importable.
import archkeep_rule_sdk
from archkeep_rule_sdk import (
    Evidence,
    Finding,
    RuleError,
    UndeclaredEvidence,
    Verdict,
    drive,
    failed,
    from_findings,
    not_applicable,
    passed,
    runtime,
    unknown,
)

ALL_KINDS = ["model", "graph", "imports", "policy"]


def _imported_by(path):
    """Every module name a Python file imports, anywhere in it."""
    names = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"), str(path))):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            names.add(node.module or ".")
    return sorted(names)

BUNDLE = {
    "contract": 1,
    "rule": {"name": "a-rule", "params": {"tag": "layer-domain"}},
    "model": {"projects": [{"name": "alpha", "root": "packages/alpha", "tags": ["layer-domain"]}]},
    "graph": {"edges": [{"source": "alpha", "target": "beta", "type": "static", "sourceFile": None}]},
    "imports": [
        {
            "sourceProject": "alpha",
            "sourceFile": "packages/alpha/src/main.go",
            "line": 3,
            "column": 5,
            "specifier": "beta/pkg",
            "kind": "static",
            "spelling": {"path": False, "relative": False},
            "resolved": {"target": "beta", "file": None, "external": False, "packageName": None},
        }
    ],
    "policy": {"depConstraints": [{"sourceTag": "a"}], "moduleBoundaryOptions": {"allow": []}},
}


class TheEvidenceView(unittest.TestCase):
    def test_reads_the_bundle_the_wire_contract_spells(self):
        evidence = Evidence(BUNDLE, ALL_KINDS)
        self.assertEqual(evidence.contract, 1)
        self.assertEqual(evidence.rule.name, "a-rule")
        self.assertEqual(evidence.rule.params["tag"], "layer-domain")
        self.assertTrue(evidence.projects[0].has_tag("layer-domain"))
        self.assertFalse(evidence.projects[0].has_tag("layer-"))
        self.assertEqual(evidence.edges[0].source_file, None)
        self.assertEqual(evidence.imports[0].position(), (3, 5))
        self.assertEqual(evidence.imports[0].resolved.target, "beta")
        self.assertEqual(evidence.policy.dep_constraints[0]["sourceTag"], "a")
        self.assertEqual(evidence.project("alpha").root, "packages/alpha")

    def test_answers_none_for_a_project_the_model_does_not_declare(self):
        # `None` rather than a raise: an edge naming an unknown project is a
        # fact a rule must be able to notice and answer `unknown` about.
        self.assertIsNone(Evidence(BUNDLE, ALL_KINDS).project("beta"))

    def test_position_refuses_a_coordinate_that_is_not_1_based(self):
        bundle = dict(BUNDLE)
        bundle["imports"] = [dict(BUNDLE["imports"][0], line=0)]
        self.assertIsNone(Evidence(bundle, ALL_KINDS).imports[0].position())

    def test_refuses_a_kind_the_rule_did_not_declare(self):
        """The silent direction, and the reason `needs` is threaded this far.

        The carrier converts only the declared kinds, so an undeclared one is
        not merely undeclared inside the artifact — it is an empty list. A rule
        reading it would scan nothing and report a clean workspace.
        """
        evidence = Evidence(BUNDLE, ["model"])
        self.assertEqual(len(evidence.projects), 1)
        for attribute in ("edges", "imports", "policy"):
            with self.assertRaises(UndeclaredEvidence) as raised:
                getattr(evidence, attribute)
            self.assertIn(attribute, str(raised.exception))
            self.assertIn("model", str(raised.exception))


class TheVerdictConstructors(unittest.TestCase):
    def test_a_fail_that_names_nothing_cannot_be_constructed(self):
        with self.assertRaises(RuleError):
            failed([])
        with self.assertRaises(RuleError):
            failed(x for x in ())

    def test_a_fail_carrying_something_that_is_not_a_finding_is_refused(self):
        with self.assertRaises(RuleError):
            failed([{"id": "x", "message": "y"}])

    def test_the_two_reason_carrying_verdicts_refuse_an_empty_reason(self):
        for construct in (unknown, not_applicable):
            for reason in ("", None, 7):
                with self.assertRaises(RuleError):
                    construct(reason)

    def test_from_findings_passes_on_empty_and_fails_otherwise(self):
        self.assertEqual(from_findings([]).kind, "pass")
        self.assertEqual(from_findings([Finding("an-id", "a message")]).kind, "fail")

    def test_a_pass_states_its_empty_findings_rather_than_omitting_them(self):
        self.assertEqual(passed().to_wire(), {"verdict": "pass", "findings": []})

    def test_the_wire_verdict_carries_no_contract_of_its_own(self):
        # The carrier's Rust half writes `contract`, so it lives in one place
        # per artifact rather than in this file and in the crate at once.
        for verdict in (passed(), unknown("r"), not_applicable("r")):
            self.assertNotIn("contract", verdict.to_wire())


class TheFinding(unittest.TestCase):
    def test_refuses_an_empty_id_or_message(self):
        with self.assertRaises(RuleError):
            Finding("", "a message")
        with self.assertRaises(RuleError):
            Finding("an-id", "")

    def test_at_refuses_a_position_that_is_not_a_1_based_integer(self):
        for line, column in ((0, 1), (1, 0), (True, 1), (1, "2"), (-1, 1)):
            with self.assertRaises(RuleError):
                Finding("an-id", "a message").at("a/file.go", line, column)

    def test_a_position_cannot_be_written_without_its_file(self):
        # `at` takes the file and the position together, so the shape the host
        # refuses — "a position with no file sends a reader to a line in
        # nothing" — has no spelling here at all.
        finding = Finding("an-id", "a message")
        self.assertNotIn("line", finding.to_wire())
        self.assertEqual(
            Finding("an-id", "a message").at("a/file.go", 4, 6).to_wire(),
            {"id": "an-id", "message": "a message", "sourceFile": "a/file.go", "line": 4, "column": 6},
        )

    def test_carries_only_the_optional_fields_it_was_given(self):
        self.assertEqual(
            Finding("an-id", "a message").in_project("alpha").to_wire(),
            {"id": "an-id", "message": "a message", "project": "alpha"},
        )


class Drive(unittest.TestCase):
    def test_turns_a_rule_s_exception_into_unknown_naming_it(self):
        """Not a `pass`, and not a traceback.

        A rule that raised judged nothing. Answering `pass` would be a clean
        workspace nobody earned; letting the exception out would be loud in the
        test and a trap in the artifact, and the two halves of this package
        would fail in different shapes.
        """

        def evaluate(evidence):
            return evidence.rule.params["absent"]

        verdict = drive(evaluate, BUNDLE, ALL_KINDS)
        self.assertEqual(verdict["verdict"], "unknown")
        self.assertEqual(verdict["findings"], [])
        self.assertIn("KeyError", verdict["reason"])
        self.assertIn("evaluate:", verdict["reason"])

    def test_turns_a_hollow_verdict_into_unknown_rather_than_letting_it_out(self):
        verdict = drive(lambda evidence: failed([]), BUNDLE, ALL_KINDS)
        self.assertEqual(verdict["verdict"], "unknown")
        self.assertIn("names no finding", verdict["reason"])

    def test_refuses_a_rule_that_answers_something_that_is_not_a_verdict(self):
        for answer in (None, {"verdict": "pass"}, "pass", 0):
            verdict = drive(lambda evidence: answer, BUNDLE, ALL_KINDS)
            self.assertEqual(verdict["verdict"], "unknown")
            self.assertIn("returned", verdict["reason"])

    def test_names_the_undeclared_kind_a_rule_reached_for(self):
        verdict = drive(lambda evidence: from_findings(list(evidence.imports)), BUNDLE, ["model"])
        self.assertEqual(verdict["verdict"], "unknown")
        self.assertIn("imports", verdict["reason"])


class TheRuntimeIsTheModuleTheArtifactRuns(unittest.TestCase):
    def test_every_name_the_package_exports_comes_from_runtime(self):
        """`__init__.py` re-exports and never adds.

        Inside the artifact the module registered as `archkeep_rule_sdk` is
        `runtime.py`'s namespace — `__init__.py` is not there. A name defined in
        the package rather than in the runtime would exist in these tests and be
        missing in the wasm, and the difference would surface as an `unknown`
        verdict in a consumer's CI rather than as a red test here.
        """
        for name in archkeep_rule_sdk.__all__:
            self.assertTrue(
                hasattr(runtime, name),
                f"archkeep_rule_sdk exports {name}, which runtime.py does not define",
            )
            self.assertIs(getattr(archkeep_rule_sdk, name), getattr(runtime, name))

    def test_runtime_imports_nothing(self):
        """The constraint the carrier's interpreter enforces, checked here.

        RustPython without the frozen standard library has no `re`, no `json`,
        no `collections` and no `os`. An import in the runtime would load fine
        under CPython and raise inside the artifact — green tests, and every
        rule `unknown` in the field.

        Read with `ast` rather than by scanning lines: prose that begins with
        the word "import" is not an import, and a textual check that thought so
        would be a gate nobody could keep green. Every import is looked for, not
        only module-level ones — a function-body import fails inside the
        artifact just as loudly, and later.
        """
        self.assertEqual(_imported_by(_PACKAGE / "src" / "archkeep_rule_sdk" / "runtime.py"), [])

    def test_the_reference_rule_imports_only_the_sdk(self):
        """What a rule may reach for, checked on the one rule this package ships.

        `archkeep_rule_sdk` resolves inside the artifact because the carrier puts
        it in `sys.modules`. Nothing else does.
        """
        imported = _imported_by(_PACKAGE / "examples" / "forbidden_tag_dependency.py")
        self.assertEqual(imported, ["archkeep_rule_sdk"])

    def test_the_four_kinds_and_four_verdicts_are_the_wire_s(self):
        self.assertEqual(runtime.EVIDENCE_KINDS, ("model", "graph", "imports", "policy"))
        self.assertEqual(runtime.VERDICTS, ("pass", "fail", "unknown", "not_applicable"))
        self.assertEqual(sorted(runtime.EVIDENCE_KINDS), sorted(ALL_KINDS))
        for kind in runtime.VERDICTS:
            self.assertIsInstance(kind, str)
        self.assertEqual(Verdict("pass", []).to_wire()["verdict"], runtime.VERDICTS[0])


if __name__ == "__main__":
    unittest.main()

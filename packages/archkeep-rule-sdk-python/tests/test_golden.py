"""The golden suite: every fixture in `../fixtures/`, replayed against the
reference rule, with the verdict each one must produce.

This is this package's half of the shared conformance suite ADR 0002 names as
the thing that holds every SDK to one contract. The fixtures are byte-identical
copies of `../../archkeep-rule-sdk-rust/fixtures/` — the same files, checked by
`test_artifact.py` — and the verdicts pinned below are the ones
`../../archkeep-rule-sdk-rust/tests/golden.rs` pins for the Rust reference rule.
Two SDKs, one set of bundles, one set of answers.

What this file exercises is `drive`, which is the same entry point the carrier's
Rust half calls inside the artifact. What it does NOT exercise is the artifact:
a `.wasm` cannot be instantiated from CPython without a runtime this package
refuses to depend on. That half is proven by the committed artifact, whose round
trip through the engine's real host is recorded in `../README.md`.
"""

import json
import sys
import unittest
from pathlib import Path

_PACKAGE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_PACKAGE / "src"))
sys.path.insert(0, str(_PACKAGE / "examples"))

# Imported after the sys.path lines above rather than at the top of the file:
# neither the package nor the example is installed, and the paths are what make
# them importable.
from archkeep_rule_sdk import drive

import forbidden_tag_dependency as rule

FIXTURES = _PACKAGE / "fixtures"


def replay(name):
    """The verdict the reference rule answers over one fixture."""
    bundle = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    return drive(rule.evaluate, bundle, rule.ARCHKEEP_RULE["needs"])


class TheDeclaration(unittest.TestCase):
    def test_states_the_document_the_host_reads(self):
        self.assertEqual(
            rule.ARCHKEEP_RULE,
            {
                "name": "forbidden-tag-dependency",
                "needs": ["model", "graph"],
                "findings": [
                    {
                        "id": "dependency-on-forbidden-tag",
                        "message": "a project depends on a project carrying the forbidden tag",
                    }
                ],
            },
        )


class TheGoldenFixtures(unittest.TestCase):
    def test_an_edge_into_the_forbidden_tag_fails_and_names_the_pair(self):
        self.assertEqual(
            replay("edge-into-forbidden-tag.json"),
            {
                "verdict": "fail",
                "findings": [
                    {
                        "id": "dependency-on-forbidden-tag",
                        "message": 'beta depends on gamma, which carries "layer-infrastructure"',
                        "sourceFile": "packages/beta/src/store.rs",
                        "project": "beta",
                    }
                ],
            },
        )

    def test_a_workspace_whose_edges_all_clear_the_tag_passes(self):
        self.assertEqual(
            replay("every-edge-clean.json"),
            {"verdict": "pass", "findings": []},
        )

    def test_a_workspace_where_the_tag_appears_nowhere_is_not_applicable(self):
        self.assertEqual(
            replay("no-project-carries-the-tag.json"),
            {
                "verdict": "not_applicable",
                "findings": [],
                "notApplicableReason": (
                    'no project in this workspace carries "layer-infrastructure", so there is '
                    "no dependency this rule could forbid"
                ),
            },
        )

    # The two cases below are the silent direction, and they are the reason this
    # file is a suite rather than a demo. Both describe a run in which the rule
    # could not reach a judgment; both would be indistinguishable from a clean
    # workspace if they answered `pass`, and a workspace would go on believing a
    # rule was enforcing something that had not run.

    def test_a_row_that_names_no_tag_is_unknown_rather_than_clean(self):
        verdict = replay("params-without-the-tag.json")
        self.assertEqual(
            verdict,
            {
                "verdict": "unknown",
                "findings": [],
                "reason": (
                    "params.forbiddenTag is not a non-empty string, so there is no tag to "
                    "judge dependencies against — the rule read nothing and concluded nothing"
                ),
            },
        )
        # Stated twice on purpose: the assertion above would still hold if
        # `replay` compared nothing, and these would not.
        self.assertNotEqual(verdict["verdict"], "pass")
        self.assertNotEqual(verdict["verdict"], "fail")

    def test_an_edge_naming_a_project_the_model_lacks_is_unknown(self):
        verdict = replay("edge-into-an-undeclared-project.json")
        self.assertEqual(
            verdict,
            {
                "verdict": "unknown",
                "findings": [],
                "reason": (
                    'the graph carries an edge into "epsilon", which the model does not '
                    "declare — the two halves of the evidence disagree, and a rule cannot "
                    "tell whether a project it cannot see carries the tag"
                ),
            },
        )
        self.assertNotEqual(verdict["verdict"], "pass")

    def test_every_finding_the_fixtures_produce_is_in_the_catalogue(self):
        """The host refuses a finding it cannot resolve to a catalogue entry.

        This package deliberately does not repeat that check at runtime, so the
        place a typo'd id would otherwise surface is a consumer's `check`. Here
        it is a red test instead.
        """
        declared = {entry["id"] for entry in rule.ARCHKEEP_RULE["findings"]}
        seen = 0
        for name in sorted(path.name for path in FIXTURES.glob("*.json")):
            for finding in replay(name)["findings"]:
                self.assertIn(
                    finding["id"], declared, f"{name} produced an undeclared id"
                )
                seen += 1
        # Without this the test passes over a suite that produced no finding at
        # all, which is exactly the shape it is meant to catch.
        self.assertGreater(
            seen, 0, "no fixture produced a finding, so nothing was checked"
        )

    def test_the_suite_covers_every_fixture_in_the_directory(self):
        """A fixture nobody replays is a fixture that proves nothing.

        Without this, adding a sixth bundle to `../fixtures/` would leave the
        suite green while the new case went unjudged — the silent direction, one
        directory listing away.
        """
        self.assertEqual(
            sorted(path.name for path in FIXTURES.glob("*.json")),
            [
                "edge-into-an-undeclared-project.json",
                "edge-into-forbidden-tag.json",
                "every-edge-clean.json",
                "no-project-carries-the-tag.json",
                "params-without-the-tag.json",
            ],
        )


if __name__ == "__main__":
    unittest.main()

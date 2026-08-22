// The golden suite: every fixture in ../../fixtures/, replayed against the
// reference rule, with the verdict each one must produce.
//
// This is this module's half of the shared conformance suite the ADR names as
// the thing that holds four SDKs to one contract
// (../../../../docs/adr/0002-custom-rules-one-contract.md, "SDKs are
// bindings"). The fixtures are not hand-written JSON that looks like a bundle:
// they were produced by the engine's own buildEvidenceBundle and canonical
// serializer (../../../lattice/src/custom-rules/evidence.mjs) and then
// formatted for review, so what the rule parses here is what the host writes
// into linear memory there. They are copied byte-identically from
// ../../../lattice-rule-sdk-rust/fixtures/, and the verdicts pinned below are
// the ones that crate's tests/golden.rs pins. What holds the two copies to
// each other is no longer a promise: ../../../lattice/src/conformance/
// rule-sdks.integration.test.mjs reads every SDK's copy of every fixture and
// requires them byte-identical, then drives all four committed artifacts
// through the engine's real host and requires one verdict document from each.
//
// The rule runs through latticerule.EvaluateJSON rather than through the built
// artifact, because a .wasm file cannot be instantiated from a Go test without
// a runtime this module refuses to depend on. What that leaves unproven — that
// the ABI shell around this same code works — is proven instead by the
// committed artifact (../../artifact_test.go), by ../../rebuild-example.sh
// driving it before it records a digest, and by the round trip through the real
// host that ../../README.md records.

package main

import (
	"testing"

	latticerule "github.com/ecoma-io/lattice/packages/lattice-rule-sdk-go"
	"github.com/ecoma-io/lattice/packages/lattice-rule-sdk-go/harness"
)

// fixtures is every golden bundle, named once so the catalogue check below
// cannot silently cover fewer than the suite does.
var fixtures = []string{
	"edge-into-forbidden-tag.json",
	"every-edge-clean.json",
	"no-project-carries-the-tag.json",
	"params-without-the-tag.json",
	"edge-into-an-undeclared-project.json",
}

func TestTheDeclarationIsTheDocumentTheHostReads(t *testing.T) {
	const expected = `{"contract":1,"name":"forbidden-tag-dependency","needs":["model","graph"],` +
		`"findings":[{"id":"dependency-on-forbidden-tag","message":"a project depends on a project ` +
		`carrying the forbidden tag"}]}`
	if answered := latticerule.DescribeJSON(); answered != expected {
		t.Fatalf("the self-description is not the document the host reads\n got: %s\nwant: %s",
			answered, expected)
	}
}

func TestAnEdgeIntoTheForbiddenTagFailsAndNamesThePair(t *testing.T) {
	harness.ExpectVerdict(t, "edge-into-forbidden-tag.json", latticerule.EvaluateJSON, `{
		"contract": 1,
		"verdict": "fail",
		"findings": [{
			"id": "dependency-on-forbidden-tag",
			"message": "beta depends on gamma, which carries \"layer-infrastructure\"",
			"sourceFile": "packages/beta/src/store.rs",
			"project": "beta"
		}]
	}`)
}

// TestTheVerdictBytesAreTheOnesThatCrossTheAbi is the one place the exact BYTES
// are pinned rather than the document.
//
// Everything else in this file compares parsed JSON, because key order is a
// serializer's business and a conformance suite four SDKs must reproduce cannot
// turn on one of them. This test exists anyway: the bytes are what crosses the
// ABI, and a change that reordered or renamed a key would still be a change to
// what the host reads. The string below is also byte-for-byte what the Rust
// binding's own bytes test pins, which is what makes "one contract" checkable
// rather than asserted.
func TestTheVerdictBytesAreTheOnesThatCrossTheAbi(t *testing.T) {
	const expected = `{"contract":1,"verdict":"fail","findings":[{"id":"dependency-on-forbidden-tag",` +
		`"message":"beta depends on gamma, which carries \"layer-infrastructure\"",` +
		`"sourceFile":"packages/beta/src/store.rs","project":"beta"}]}`
	answered := latticerule.EvaluateJSON(harness.ReadFixture(t, "edge-into-forbidden-tag.json"))
	if answered != expected {
		t.Fatalf("the verdict bytes are not the ones that cross the ABI\n got: %s\nwant: %s",
			answered, expected)
	}
}

func TestAWorkspaceWhoseEdgesAllClearTheTagPasses(t *testing.T) {
	harness.ExpectVerdict(t, "every-edge-clean.json", latticerule.EvaluateJSON,
		`{ "contract": 1, "verdict": "pass", "findings": [] }`)
}

func TestAWorkspaceWhereTheTagAppearsNowhereIsNotApplicable(t *testing.T) {
	harness.ExpectVerdict(t, "no-project-carries-the-tag.json", latticerule.EvaluateJSON, `{
		"contract": 1,
		"verdict": "not_applicable",
		"findings": [],
		"notApplicableReason": "no project in this workspace carries \"layer-infrastructure\", so there is no dependency this rule could forbid"
	}`)
}

// The two cases below are the silent direction, and they are the reason this
// file is a suite rather than a demo. Both describe a run in which the rule
// could not reach a judgment; both would be indistinguishable from a clean
// workspace if they answered pass, and a workspace would go on believing a rule
// was enforcing something that had not run.

func TestARowThatNamesNoTagIsUnknownRatherThanClean(t *testing.T) {
	harness.ExpectVerdict(t, "params-without-the-tag.json", latticerule.EvaluateJSON, `{
		"contract": 1,
		"verdict": "unknown",
		"findings": [],
		"reason": "params.forbiddenTag is not a non-empty string, so there is no tag to judge dependencies against — the rule read nothing and concluded nothing"
	}`)

	// Stated twice on purpose: the assertion above would still hold if
	// ExpectVerdict compared nothing, and this one would not.
	verdict := harness.Replay(t, "params-without-the-tag.json", latticerule.EvaluateJSON)
	if verdict["verdict"] == "pass" || verdict["verdict"] == "fail" {
		t.Fatalf("a rule that could not read its parameters answered %v", verdict["verdict"])
	}
}

func TestAnEdgeNamingAProjectTheModelLacksIsUnknown(t *testing.T) {
	harness.ExpectVerdict(t, "edge-into-an-undeclared-project.json", latticerule.EvaluateJSON, `{
		"contract": 1,
		"verdict": "unknown",
		"findings": [],
		"reason": "the graph carries an edge into \"epsilon\", which the model does not declare — the two halves of the evidence disagree, and a rule cannot tell whether a project it cannot see carries the tag"
	}`)
}

// TestEveryFindingTheFixturesProduceIsInTheCatalogue checks every finding the
// suite produces against the rule's own catalogue.
//
// The host refuses a finding it cannot resolve, and this module deliberately
// does not repeat that check at runtime — so the place a typo'd id would
// otherwise surface is a consumer's check. Here it is a red test instead.
func TestEveryFindingTheFixturesProduceIsInTheCatalogue(t *testing.T) {
	declared := map[string]bool{}
	for _, entry := range latticerule.Registered().Findings {
		declared[entry.ID] = true
	}

	seen := 0
	for _, fixture := range fixtures {
		findings, ok := harness.Replay(t, fixture, latticerule.EvaluateJSON)["findings"].([]any)
		if !ok {
			t.Fatalf("%s: every verdict states its findings, and this one did not", fixture)
		}
		for _, finding := range findings {
			id := finding.(map[string]any)["id"]
			if identifier, ok := id.(string); !ok || !declared[identifier] {
				t.Fatalf("%s produced the undeclared id %v", fixture, id)
			}
			seen++
		}
	}

	// Without this the test passes over a suite that produced no finding at all,
	// which is exactly the shape it is meant to catch.
	if seen == 0 {
		t.Fatal("no fixture produced a finding, so nothing was checked")
	}
}

package latticerule

import (
	"strings"
	"testing"
)

// answering registers a rule whose evaluate function answers verdict, and
// returns what EvaluateJSON makes of evidence.
func answering(t *testing.T, verdict func(*Evidence) Verdict, evidence string) string {
	t.Helper()
	declaration := validDeclaration()
	declaration.Evaluate = verdict
	answered := ""
	withRule(t, declaration, func() { answered = EvaluateJSON([]byte(evidence)) })
	return answered
}

// TestABundleThatCannotBeReadBecomesUnknownRatherThanPass is the silent
// direction, and the reason a rule's signature takes an *Evidence rather than
// bytes: the one failure with exactly one correct answer is answered once, in
// [EvaluateJSON], instead of in every rule that ever gets written.
//
// If this ever returns pass, a rule handed corrupt bytes reports a clean
// workspace.
func TestABundleThatCannotBeReadBecomesUnknownRatherThanPass(t *testing.T) {
	answered := answering(t, func(*Evidence) Verdict { return Pass() }, "not json at all")
	if !strings.Contains(answered, `"verdict":"unknown"`) {
		t.Fatalf("corrupt bytes must answer unknown, got %s", answered)
	}
	if !strings.Contains(answered, "could not be read") {
		t.Fatalf("the unknown names its cause, got %s", answered)
	}
	if strings.Contains(answered, `"verdict":"pass"`) {
		t.Fatalf("corrupt bytes must never answer pass, got %s", answered)
	}
}

func TestABundleFromAnotherContractBecomesUnknownNamingTheVersion(t *testing.T) {
	answered := answering(t, func(*Evidence) Verdict { return Pass() }, `{"contract":7}`)
	if !strings.Contains(answered, `"verdict":"unknown"`) {
		t.Fatalf("a contract-7 bundle must answer unknown, got %s", answered)
	}
	if !strings.Contains(answered, "states contract 7") {
		t.Fatalf("the unknown names the version, got %s", answered)
	}
}

func TestAReadableBundleReachesTheRule(t *testing.T) {
	reached := false
	answered := answering(t, func(evidence *Evidence) Verdict {
		reached = true
		if evidence.Rule.Name != "example-rule" {
			t.Fatalf("the rule instance is %q", evidence.Rule.Name)
		}
		return NotApplicable("nothing to judge in an empty workspace")
	}, `{
		"contract": 1,
		"rule": { "name": "example-rule", "params": {} },
		"model": { "projects": [] },
		"graph": { "edges": [] },
		"imports": [],
		"policy": { "depConstraints": [], "moduleBoundaryOptions": {} }
	}`)

	if !reached {
		t.Fatal("a readable bundle must reach the rule")
	}
	if !strings.Contains(answered, `"verdict":"not_applicable"`) {
		t.Fatalf("the rule's own verdict is what crosses back, got %s", answered)
	}
}

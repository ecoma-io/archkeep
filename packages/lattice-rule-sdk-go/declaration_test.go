package latticerule

import (
	"strings"
	"testing"
)

// validDeclaration is a declaration nothing is wrong with, so each test below
// can change exactly one thing about it.
func validDeclaration() Rule {
	return Rule{
		Name:  "no-cross-tag-dependency",
		Needs: []EvidenceKind{KindModel, KindGraph},
		Findings: []CatalogueEntry{
			{ID: "cross-tag-edge", Message: "an edge crosses a forbidden tag"},
		},
		Evaluate: func(*Evidence) Verdict { return Pass() },
	}
}

// withRule registers a rule for the duration of body and puts the registry back
// afterwards.
//
// The registry is package state, which a test in this package may reach
// directly — and has to, because [Register] refuses a second call and a suite
// with more than one declaration in it would otherwise be one test long.
func withRule(t *testing.T, rule Rule, body func()) {
	t.Helper()
	previous := registered
	registered = nil
	defer func() { registered = previous }()
	Register(rule)
	body()
}

// recovered is the panic body raises, or the empty string.
func recovered(body func()) (message string) {
	defer func() {
		if raised := recover(); raised != nil {
			if text, ok := raised.(string); ok {
				message = text
			} else {
				message = "a panic that is not a string"
			}
		}
	}()
	body()
	return ""
}

func TestDescribeJSONStatesTheContractAndTheCatalogue(t *testing.T) {
	withRule(t, validDeclaration(), func() {
		const expected = `{"contract":1,"name":"no-cross-tag-dependency","needs":["model","graph"],` +
			`"findings":[{"id":"cross-tag-edge","message":"an edge crosses a forbidden tag"}]}`
		if answered := DescribeJSON(); answered != expected {
			t.Fatalf("got  %s\nwant %s", answered, expected)
		}
	})
}

// TestARuleThatReadsNothingStatesTheEmptyListRatherThanNull is the silent
// direction on the describe side: encoding/json writes a nil slice as null, and
// a describe stating "needs": null is refused by the host as a rule that cannot
// state what it needs — which is a load failure over a declaration that is
// merely unusual.
func TestARuleThatReadsNothingStatesTheEmptyListRatherThanNull(t *testing.T) {
	declaration := validDeclaration()
	declaration.Needs = nil
	withRule(t, declaration, func() {
		if answered := DescribeJSON(); !strings.Contains(answered, `"needs":[]`) {
			t.Fatalf("a rule declaring no needs must state the empty list, got %s", answered)
		}
	})
}

// TestTheRefusalsRegisterMakes drives every check validate performs, each by
// changing one thing about a declaration that is otherwise sound.
//
// Driven through validate rather than through Register's panic so that a
// failing case names which refusal it expected; that Register actually panics
// on one of them is pinned separately below.
func TestTheRefusalsRegisterMakes(t *testing.T) {
	cases := []struct {
		name     string
		mutate   func(*Rule)
		expected string
	}{
		{"an empty name", func(r *Rule) { r.Name = "" }, "Name is \"\""},
		{"an uppercase name", func(r *Rule) { r.Name = "NoCrossTag" }, "lowercase letters"},
		{"an underscored name", func(r *Rule) { r.Name = "no_cross_tag" }, "lowercase letters"},
		{"a doubly dashed name", func(r *Rule) { r.Name = "no--cross" }, "lowercase letters"},
		{"a trailing dash", func(r *Rule) { r.Name = "no-cross-" }, "lowercase letters"},
		{"a leading dash", func(r *Rule) { r.Name = "-no-cross" }, "lowercase letters"},
		{"no evaluate function", func(r *Rule) { r.Evaluate = nil }, "declares no Evaluate"},
		{
			"an evidence kind contract 1 does not carry",
			func(r *Rule) { r.Needs = []EvidenceKind{KindModel, "sources"} },
			`Needs carries "sources"`,
		},
		{"an empty catalogue", func(r *Rule) { r.Findings = nil }, "declares no entry"},
		{
			"a malformed finding id",
			func(r *Rule) { r.Findings[0].ID = "Cross Tag" },
			"Findings[0].ID",
		},
		{
			"a finding with no message",
			func(r *Rule) { r.Findings[0].Message = "" },
			"has no Message",
		},
		{
			"two findings under one id",
			func(r *Rule) {
				r.Findings = append(r.Findings, CatalogueEntry{ID: "cross-tag-edge", Message: "again"})
			},
			`declares the id "cross-tag-edge" twice`,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			declaration := validDeclaration()
			testCase.mutate(&declaration)
			violation := validate(declaration)
			if violation == "" {
				t.Fatalf("%s was accepted, and the host would have refused the load", testCase.name)
			}
			if !strings.Contains(violation, testCase.expected) {
				t.Fatalf("the refusal does not name %q: %s", testCase.expected, violation)
			}
		})
	}

	if violation := validate(validDeclaration()); violation != "" {
		t.Fatalf("a sound declaration was refused: %s", violation)
	}
}

func TestRegisterPanicsRatherThanCarryingOnWithAMalformedDeclaration(t *testing.T) {
	declaration := validDeclaration()
	declaration.Name = "Not A Rule Name"
	previous := registered
	registered = nil
	defer func() { registered = previous }()

	message := recovered(func() { Register(declaration) })
	if !strings.Contains(message, "latticerule.Register") {
		t.Fatalf("a malformed declaration must panic naming Register, got %q", message)
	}
	if registered != nil {
		t.Fatal("a refused declaration must not become the registered rule")
	}
}

func TestASecondRegisterIsRefusedRatherThanReplacingTheFirst(t *testing.T) {
	withRule(t, validDeclaration(), func() {
		second := validDeclaration()
		second.Name = "some-other-rule"
		message := recovered(func() { Register(second) })
		if !strings.Contains(message, "one artifact is one rule") {
			t.Fatalf("a second Register must be refused, got %q", message)
		}
		if Registered().Name != "no-cross-tag-dependency" {
			t.Fatal("the first declaration must survive a refused second one")
		}
	})
}

// TestAnArtifactThatRegisteredNothingIsLoudRatherThanNameless is the silent
// direction on the registry: every describe document this package could answer
// with instead would name a rule, and naming a rule that does not exist is how
// a workspace ends up believing an artifact enforces something.
func TestAnArtifactThatRegisteredNothingIsLoudRatherThanNameless(t *testing.T) {
	previous := registered
	registered = nil
	defer func() { registered = previous }()

	message := recovered(func() { _ = DescribeJSON() })
	if !strings.Contains(message, "no rule was registered") {
		t.Fatalf("an unregistered artifact must say so, got %q", message)
	}
}

func TestTheNameGrammarRefusesWhatTheHostRefuses(t *testing.T) {
	accepted := []string{"a", "no-interface-outside-domain", "rule2", "a1-b2"}
	refused := []string{"", "-leading", "trailing-", "double--dash", "Upper", "under_score", "with space"}
	for _, value := range accepted {
		if !isLowerDashed(value) {
			t.Errorf("%q is a name the host accepts", value)
		}
	}
	for _, value := range refused {
		if isLowerDashed(value) {
			t.Errorf("%q is a name the host refuses", value)
		}
	}
}

// TestMarshalJSONLeavesHtmlCharactersAlone pins the one place this package
// disagrees with encoding/json's default.
//
// Left on, HTML escaping would write a message naming a Rust generic or a shell
// redirect differently here than the Rust binding writes it over the same
// verdict, and the shared conformance suite would be comparing two SDKs'
// escaping habits rather than one contract.
func TestMarshalJSONLeavesHtmlCharactersAlone(t *testing.T) {
	answered := marshalJSON(struct {
		Message string `json:"message"`
	}{Message: "Vec<T> & Box<U>"})
	const expected = `{"message":"Vec<T> & Box<U>"}`
	if answered != expected {
		t.Fatalf("got  %s\nwant %s", answered, expected)
	}
}

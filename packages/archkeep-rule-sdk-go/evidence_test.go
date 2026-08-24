package archkeeprule

import (
	"errors"
	"strings"
	"testing"
)

// minimal is the smallest bundle that is still a whole one — every kind
// present, because the engine refuses to build a bundle with a kind missing.
const minimal = `{
	"contract": 1,
	"rule": { "name": "example-rule", "params": { "tag": "layer-domain" } },
	"model": { "projects": [{ "name": "alpha", "root": "packages/alpha", "tags": ["layer-domain"] }] },
	"graph": { "edges": [{ "source": "beta", "target": "alpha", "type": "static" }] },
	"imports": [{
		"sourceProject": "beta",
		"sourceFile": "packages/beta/src/lib.rs",
		"line": 3,
		"column": 5,
		"specifier": "alpha::thing",
		"kind": "static",
		"spelling": { "path": false, "relative": false },
		"resolved": { "target": "alpha", "file": null, "external": false, "packageName": null }
	}],
	"policy": { "depConstraints": [], "moduleBoundaryOptions": { "allow": [] } }
}`

func readMinimal(t *testing.T, mutations ...[2]string) *Evidence {
	t.Helper()
	document := minimal
	for _, mutation := range mutations {
		document = strings.Replace(document, mutation[0], mutation[1], 1)
	}
	evidence, err := ReadEvidence([]byte(document))
	if err != nil {
		t.Fatalf("the fixture is a bundle: %v", err)
	}
	return evidence
}

func TestAWholeBundleReadsEveryKind(t *testing.T) {
	evidence := readMinimal(t)

	if evidence.Rule.Name != "example-rule" {
		t.Fatalf("rule.name is %q", evidence.Rule.Name)
	}
	alpha, ok := evidence.Project("alpha")
	if !ok || !alpha.HasTag("layer-domain") {
		t.Fatal("alpha is declared and carries layer-domain")
	}
	if alpha.HasTag("layer-domai") {
		t.Fatal("a tag is compared exactly, never by prefix")
	}
	if _, ok := evidence.Project("beta"); ok {
		t.Fatal("beta is named by an edge and declared by no project")
	}
	if evidence.Graph.Edges[0].Type != "static" {
		t.Fatalf("edge type is %q", evidence.Graph.Edges[0].Type)
	}
	if evidence.Graph.Edges[0].SourceFile != nil {
		t.Fatal("an edge with no sourceFile carries nil, not the empty string")
	}
	if evidence.Imports[0].Kind != ImportStatic {
		t.Fatalf("import kind is %q", evidence.Imports[0].Kind)
	}
	if evidence.Imports[0].SourceProject != "beta" {
		t.Fatalf("attribution is %q", evidence.Imports[0].SourceProject)
	}
	resolved := evidence.Imports[0].Resolved
	if resolved == nil || resolved.Target == nil || *resolved.Target != "alpha" {
		t.Fatal("the import resolves into alpha")
	}
	if resolved.File != nil || resolved.PackageName != nil {
		t.Fatal("a null in the bundle is nil here, never the empty string")
	}
	if len(evidence.Policy.DepConstraints) != 0 {
		t.Fatal("the policy declares no constraint rows")
	}
	if string(evidence.Policy.ModuleBoundaryOptions) == "" {
		t.Fatal("the boundary options arrive as the raw document the engine loaded")
	}
}

func TestPositionsAreOneBasedAndZeroIsRefused(t *testing.T) {
	line, column, ok := readMinimal(t).Imports[0].Position()
	if !ok || line != 3 || column != 5 {
		t.Fatalf("the site is at 3:5, got %d:%d (ok=%v)", line, column, ok)
	}

	zeroed := readMinimal(t, [2]string{`"line": 3`, `"line": 0`})
	if _, _, ok := zeroed.Imports[0].Position(); ok {
		t.Fatal("a zeroth line is not a position, and clamping it would point at nothing")
	}
}

func TestTypedParamsReadTheRow(t *testing.T) {
	var declared struct {
		Tag string `json:"tag"`
	}
	if err := readMinimal(t).ReadParams(&declared); err != nil {
		t.Fatalf("the row declares a tag: %v", err)
	}
	if declared.Tag != "layer-domain" {
		t.Fatalf("params.tag is %q", declared.Tag)
	}
}

func TestAParamsFieldOfTheWrongTypeIsAnErrorRatherThanAnAbsentValue(t *testing.T) {
	evidence := readMinimal(t, [2]string{`"tag": "layer-domain"`, `"tag": 7`})
	var declared struct {
		Tag string `json:"tag"`
	}
	if err := evidence.ReadParams(&declared); err == nil {
		t.Fatal("a number where a tag belongs must not read as an absent tag")
	}
}

// TestABundleCarryingNoParamsIsNamedRatherThanParsedAsEmpty covers the one
// shape json.Unmarshal describes in the parser's words rather than the
// bundle's: the engine always writes {} for a row that declares none.
func TestABundleCarryingNoParamsIsNamedRatherThanParsedAsEmpty(t *testing.T) {
	evidence := readMinimal(t, [2]string{`"params": { "tag": "layer-domain" }`, `"params": null`})
	var declared struct{}
	err := evidence.ReadParams(&declared)
	if err == nil || !strings.Contains(err.Error(), "carries no rule.params") {
		t.Fatalf("an absent params must be named: %v", err)
	}
}

// The four below are the silent direction: none of these may read as a bundle,
// because every one of them would hand a rule facts it could then judge over
// and report clean.

func TestABundleFromAnotherContractIsRefusedByVersion(t *testing.T) {
	_, err := ReadEvidence([]byte(strings.Replace(minimal, `"contract": 1`, `"contract": 2`, 1)))
	var evidenceError *EvidenceError
	if !errors.As(err, &evidenceError) || evidenceError.Stated != 2 {
		t.Fatalf("a contract-2 bundle must be refused by version, got %v", err)
	}
	if !strings.Contains(err.Error(), "is not approximated") {
		t.Fatalf("the refusal names why: %v", err)
	}
}

func TestABundleMissingAKindIsRefused(t *testing.T) {
	// A kind cannot be "missing" in Go the way a missing serde field is: an
	// absent object decodes to the zero value. What the engine can never emit is
	// a kind whose SHAPE is wrong, and that is what a rule must not read past.
	_, err := ReadEvidence([]byte(strings.Replace(minimal, `"model": {`, `"model": [`, 1)))
	if err == nil {
		t.Fatal("a model that is not the model must not read as a bundle")
	}
}

func TestAnImportKindThisContractDoesNotCarryIsRefused(t *testing.T) {
	_, err := ReadEvidence([]byte(strings.Replace(minimal, `"kind": "static"`, `"kind": "ambient"`, 1)))
	if err == nil {
		t.Fatal("an import kind contract 1 does not carry must not read as one that it does")
	}
	if !strings.Contains(err.Error(), "ambient") {
		t.Fatalf("the refusal names the kind: %v", err)
	}
	var evidenceError *EvidenceError
	if !errors.As(err, &evidenceError) || evidenceError.Cause == nil {
		t.Fatalf("a malformed bundle names its cause: %v", err)
	}
}

func TestBytesThatAreNotABundleAreRefusedRatherThanZeroed(t *testing.T) {
	_, err := ReadEvidence([]byte("not json at all"))
	if err == nil || !strings.Contains(err.Error(), "could not be read as contract 1") {
		t.Fatalf("corrupt bytes must be refused by name, got %v", err)
	}
}

// TestAFieldThisContractDoesNotCarryYetIsAccepted is the additive-growth half:
// an engine that adds a field must not turn every already-built rule unknown.
func TestAFieldThisContractDoesNotCarryYetIsAccepted(t *testing.T) {
	grown := strings.Replace(minimal, `"type": "static"`, `"type": "static", "weight": 3`, 1)
	if _, err := ReadEvidence([]byte(grown)); err != nil {
		t.Fatalf("a bundle that gained a field is still a bundle: %v", err)
	}
}

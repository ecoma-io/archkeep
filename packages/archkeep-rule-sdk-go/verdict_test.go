package archkeeprule

import (
	"strings"
	"testing"
)

func TestAPassStatesTheContractAndAnEmptyFindingsList(t *testing.T) {
	const expected = `{"contract":1,"verdict":"pass","findings":[]}`
	if answered := Pass().JSON(); answered != expected {
		t.Fatalf("got  %s\nwant %s", answered, expected)
	}
}

func TestAFailCarriesEveryOptionalKeyTheHostAllows(t *testing.T) {
	verdict := Fail(NewFindings(
		NewFinding("cross-tag-edge", "beta reaches gamma").
			At("packages/beta/src/lib.rs", 1, 5).
			InProject("beta"),
	))
	const expected = `{"contract":1,"verdict":"fail","findings":[{"id":"cross-tag-edge",` +
		`"message":"beta reaches gamma","sourceFile":"packages/beta/src/lib.rs","line":1,` +
		`"column":5,"project":"beta"}]}`
	if answered := verdict.JSON(); answered != expected {
		t.Fatalf("got  %s\nwant %s", answered, expected)
	}
}

func TestAFindingWithNoPositionOmitsThePositionKeys(t *testing.T) {
	verdict := Fail(NewFindings(
		NewFinding("cross-tag-edge", "beta reaches gamma").InFile("packages/beta/Cargo.toml"),
	))
	const expected = `{"contract":1,"verdict":"fail","findings":[{"id":"cross-tag-edge",` +
		`"message":"beta reaches gamma","sourceFile":"packages/beta/Cargo.toml"}]}`
	if answered := verdict.JSON(); answered != expected {
		t.Fatalf("got  %s\nwant %s", answered, expected)
	}
}

func TestUnknownAndNotApplicableEachCarryTheirOwnReasonAndNoOther(t *testing.T) {
	unknown := Unknown("params.forbiddenTag is not a string").JSON()
	const expectedUnknown = `{"contract":1,"verdict":"unknown","findings":[],` +
		`"reason":"params.forbiddenTag is not a string"}`
	if unknown != expectedUnknown {
		t.Fatalf("got  %s\nwant %s", unknown, expectedUnknown)
	}

	notApplicable := NotApplicable("no project carries the tag").JSON()
	const expectedNotApplicable = `{"contract":1,"verdict":"not_applicable","findings":[],` +
		`"notApplicableReason":"no project carries the tag"}`
	if notApplicable != expectedNotApplicable {
		t.Fatalf("got  %s\nwant %s", notApplicable, expectedNotApplicable)
	}
}

// TestEveryVerdictStatesItsFindingsAsAListRatherThanNull is the silent
// direction Go has that Rust does not.
//
// encoding/json writes a nil slice as null, and a verdict stating
// "findings": null is refused by the host as hollow — so a rule that looked and
// found nothing would be reported as a rule that could not answer. The check
// covers all four verdicts, because the nil arrives from a different place in
// each.
func TestEveryVerdictStatesItsFindingsAsAListRatherThanNull(t *testing.T) {
	for _, verdict := range []Verdict{
		Pass(),
		Unknown("could not read the parameters"),
		NotApplicable("the tag appears nowhere"),
		FromFindings(nil),
		FromFindings([]Finding{}),
	} {
		answered := verdict.JSON()
		if strings.Contains(answered, `"findings":null`) {
			t.Fatalf("a verdict states its findings as a list: %s", answered)
		}
		if !strings.Contains(answered, `"findings":[]`) {
			t.Fatalf("a verdict with nothing to report states the empty list: %s", answered)
		}
		if verdict.Findings() == nil {
			t.Fatalf("Findings() answers the empty list rather than nil for %s", answered)
		}
	}
}

// TestFromFindingsPassesOnNothingAndFailsOnSomething pins the collapse, which
// is the one place emptiness legitimately means clean.
func TestFromFindingsPassesOnNothingAndFailsOnSomething(t *testing.T) {
	if kind := FromFindings(nil).Kind(); kind != VerdictPass {
		t.Fatalf("nothing found is a pass, got %s", kind)
	}
	if kind := FromFindings([]Finding{NewFinding("cross-tag-edge", "beta reaches gamma")}).Kind(); kind != VerdictFail {
		t.Fatalf("something found is a fail, got %s", kind)
	}
	if _, ok := FindingsFrom(nil); ok {
		t.Fatal("an empty slice holds no non-empty list")
	}
}

// TestAFailAlwaysNamesAtLeastOneFinding is the type-system half, checked
// anyway.
//
// Fail takes a Findings, whose representation is one finding plus the rest, so
// "failed and named nothing" has no spelling — including for the zero value,
// which Go allows a caller to build and which this pins as a fail with one
// blank finding rather than a fail with none. A blank id is refused by the host
// naming a catalogue it does not appear in; an empty list would have been
// refused as a fail that says nothing, one step closer to silent.
func TestAFailAlwaysNamesAtLeastOneFinding(t *testing.T) {
	var zero Findings
	answered := Fail(zero).JSON()
	if strings.Contains(answered, `"findings":[]`) {
		t.Fatalf("a fail must never state an empty findings list: %s", answered)
	}
	if len(Fail(zero).Findings()) != 1 {
		t.Fatalf("the zero Findings still carries one finding: %s", answered)
	}
}

func TestFindingsKeepTheOrderTheyWereAdded(t *testing.T) {
	findings := NewFindings(
		NewFinding("first-finding", "one"),
		NewFinding("second-finding", "two"),
		NewFinding("third-finding", "three"),
	)
	messages := make([]string, 0, 3)
	for _, finding := range findings.All() {
		messages = append(messages, finding.Message())
	}
	if strings.Join(messages, ",") != "one,two,three" {
		t.Fatalf("findings kept the order %v", messages)
	}
}

// TestAZeroPositionIsRefusedRatherThanReported pins what Go cannot spell.
//
// Rust's NonZeroU32 makes a zeroth line unwritable; here At panics, which on
// wasm is a trap the host names. Reporting line 0 would send every reader of
// that finding to a line no file has.
func TestAZeroPositionIsRefusedRatherThanReported(t *testing.T) {
	for _, position := range [][2]uint32{{0, 1}, {1, 0}, {0, 0}} {
		message := recovered(func() {
			_ = NewFinding("cross-tag-edge", "beta reaches gamma").
				At("packages/beta/src/lib.rs", position[0], position[1])
		})
		if !strings.Contains(message, "positions are 1-based") {
			t.Fatalf("At(%d, %d) must be refused, got %q", position[0], position[1], message)
		}
	}
}

// TestInFileAfterAtDropsThePositionItCannotKeep pins the one order of calls
// that would otherwise leave a line without the file it belongs to.
func TestInFileAfterAtDropsThePositionItCannotKeep(t *testing.T) {
	finding := NewFinding("cross-tag-edge", "beta reaches gamma").
		At("packages/beta/src/lib.rs", 3, 7).
		InFile("packages/beta/Cargo.toml")
	answered := Fail(NewFindings(finding)).JSON()
	if strings.Contains(answered, `"line"`) || strings.Contains(answered, `"column"`) {
		t.Fatalf("a re-placed finding keeps no position from the file it left: %s", answered)
	}
	if !strings.Contains(answered, `"sourceFile":"packages/beta/Cargo.toml"`) {
		t.Fatalf("a re-placed finding names the file it moved to: %s", answered)
	}
}

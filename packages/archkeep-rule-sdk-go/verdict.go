// The verdict, and the shapes of it Go refuses to build.
//
// The host calls a verdict that breaks one of its obligations **hollow** and
// refuses it — a fail naming no finding, a pass carrying one, an unknown with
// no reason, a reason on a verdict that is not unknown
// (../archkeep/src/custom-rules/host.mjs, verdictViolation). Every one of those
// is a rule that returned a shape instead of a judgment, and the refusal is
// what stops it being read as one.
//
// This file's job is to make as many of them as possible impossible to write
// rather than merely refused later:
//
//   - [Verdict] has no exported field and no exported constructor other than
//     the four below, so there is no literal that spells a verdict at all. A
//     Verdict{} does not compile outside this package with any field set, and
//     the zero value carries contract 0, which the host refuses by name.
//   - [Fail] takes [Findings], whose one value-carrying constructor is
//     [NewFindings] and whose representation is one finding plus the rest.
//     "Failed and named nothing" has no spelling.
//   - [Pass] takes nothing, so it cannot carry a finding.
//   - [Unknown] and [NotApplicable] take their reason as an argument rather
//     than a setter, so the reason cannot be forgotten, and neither reason
//     field is reachable from any other constructor.
//
// # What Go cannot make unrepresentable, stated rather than hidden
//
// Three gaps, each with what happens instead:
//
//   - An empty string. An empty message, an empty reason and an empty finding
//     id are all still refused — by the host, by name — and this package does
//     not check them a second time, the same posture the Rust binding takes
//     (../archkeep-rule-sdk-rust/src/verdict.rs).
//   - The zero [Findings]. Go has no way to require a constructor, so
//     `var f Findings; Fail(f)` compiles. It does not produce a fail with no
//     findings — the representation makes that unspellable — it produces a fail
//     with one blank finding, which the host refuses naming an id its
//     catalogue does not declare. Loud, and one step further from silent than
//     an empty list would have been.
//   - A zero position. Rust spells 1-based as NonZeroU32 and gets it from the
//     type system; [Finding.At] panics on a zero instead, which on wasm is a
//     trap the host names. A finding reported at line 0 would send a reader to
//     a line no file has.

package archkeeprule

import "fmt"

// VerdictKind is the four-state vocabulary every judgment in this engine
// speaks.
type VerdictKind string

const (
	// VerdictPass means the rule looked and found nothing.
	VerdictPass VerdictKind = "pass"
	// VerdictFail means the rule found something, and every finding names what.
	VerdictFail VerdictKind = "fail"
	// VerdictUnknown means the rule could not reach a judgment, and says why.
	VerdictUnknown VerdictKind = "unknown"
	// VerdictNotApplicable means the rule does not apply to this run, and says
	// why.
	VerdictNotApplicable VerdictKind = "not_applicable"
)

// Finding is one thing a rule found.
//
// The id must be one this rule's own catalogue declares — the host refuses a
// finding it cannot resolve to a catalogue entry, because SARIF would drop it.
// That check is the host's and is deliberately not repeated here.
//
// Every field is unexported and the JSON is written by [Finding.MarshalJSON],
// which is what keeps a position from being set without a file: the two move
// together through [Finding.At] or not at all.
type Finding struct {
	id         string
	message    string
	sourceFile string
	line       uint32
	column     uint32
	project    string
}

// NewFinding is a finding with no location, naming the catalogue entry it
// belongs to and what it found.
//
// The message is what a reader acts on, so it is the finding's own sentence
// rather than the catalogue's template — the catalogue says what the id MEANS,
// this says what happened here.
func NewFinding(id, message string) Finding {
	return Finding{id: id, message: message}
}

// InFile places the finding in a file, with no position inside it.
//
// The case this exists for is a graph edge: an edge may carry a sourceFile and
// never carries a line, so a rule judging edges can name the file honestly and
// must not invent 1:1 to fill the shape.
func (f Finding) InFile(sourceFile string) Finding {
	f.sourceFile = sourceFile
	f.line = 0
	f.column = 0
	return f
}

// At places the finding at a 1-based position in a file.
//
// File and position move together because the host refuses a position with no
// file — "a position with no file sends a reader to a line in nothing".
//
// It panics on a zero line or column. That is the loud direction and the only
// one Go leaves: a 1-based coordinate is what every position this tool reports
// is (../archkeep/src/analysis/contract.md), silently dropping the position
// would lose what the caller meant to say, and reporting 0 would send a reader
// to a line no file has. [ImportRecord.Position] hands over a pair already
// checked.
func (f Finding) At(sourceFile string, line, column uint32) Finding {
	if line == 0 || column == 0 {
		panic(fmt.Sprintf(
			"archkeeprule: Finding.At(%q, %d, %d): positions are 1-based integers, and a finding at "+
				"line 0 points at nothing", sourceFile, line, column))
	}
	f.sourceFile = sourceFile
	f.line = line
	f.column = column
	return f
}

// InProject attributes the finding to a project.
func (f Finding) InProject(project string) Finding {
	f.project = project
	return f
}

// findingDocument is the wire shape of a finding.
//
// Field order is the wire order, matching what the Rust binding's serde emits
// for the same finding: id, message, sourceFile, line, column, project. The
// optional keys are pointers rather than omitempty strings and integers,
// because omitempty cannot tell an absent value from a zero one — and the two
// mean different things here for every one of them.
//
// This is a plain struct with tags rather than a MarshalJSON method on
// [Finding], and that is deliberate: a MarshalJSON is invoked by whatever
// encoder is running and returns already-encoded bytes, which the outer encoder
// then only compacts — so the HTML escaping [marshalJSON] turns off would be
// turned back on inside every finding. One document, one encoder, one escaping
// decision.
type findingDocument struct {
	ID         string  `json:"id"`
	Message    string  `json:"message"`
	SourceFile *string `json:"sourceFile,omitempty"`
	Line       *uint32 `json:"line,omitempty"`
	Column     *uint32 `json:"column,omitempty"`
	Project    *string `json:"project,omitempty"`
}

// document is the finding as the wire carries it, with every location key it
// does not carry left out.
func (f Finding) document() findingDocument {
	document := findingDocument{ID: f.id, Message: f.message}
	if f.sourceFile != "" {
		document.SourceFile = &f.sourceFile
	}
	if f.line != 0 {
		document.Line = &f.line
		document.Column = &f.column
	}
	if f.project != "" {
		document.Project = &f.project
	}
	return document
}

// ID is the catalogue entry this finding resolves to.
//
// It exists for a test that checks a rule's findings against its own catalogue
// (examples/forbidden_tag_dependency/golden_test.go) — the check the host makes
// at evaluate time, moved to where an author sees it as a red test rather than
// as a consumer's hollow-verdict refusal.
func (f Finding) ID() string { return f.id }

// Message is the finding's own sentence.
func (f Finding) Message() string { return f.message }

// Findings is one or more findings.
//
// A slice that is guaranteed not to be empty, which is the whole point: it is
// the argument type of [Fail], so "this rule failed and named nothing" has no
// spelling. The first finding is a field rather than element zero of a slice
// precisely so the guarantee survives the zero value — see this file's header
// on what Go cannot make unrepresentable.
//
// There is no Len or IsEmpty on purpose — the answer to IsEmpty is always
// false, and a caller asking it is a caller who has forgotten what this type is
// for.
type Findings struct {
	first Finding
	rest  []Finding
}

// NewFindings starts a non-empty list from the finding that makes it non-empty.
func NewFindings(first Finding, rest ...Finding) Findings {
	return Findings{first: first, rest: rest}
}

// FindingsFrom is the non-empty list a slice holds, and whether it held one.
//
// ok=false is the caller's cue that there is nothing to fail over — and
// [FromFindings] is the one-line way to answer it correctly.
func FindingsFrom(findings []Finding) (Findings, bool) {
	if len(findings) == 0 {
		return Findings{}, false
	}
	return Findings{first: findings[0], rest: findings[1:]}, true
}

// All is the findings, in the order they were added.
func (f Findings) All() []Finding {
	all := make([]Finding, 0, 1+len(f.rest))
	all = append(all, f.first)
	return append(all, f.rest...)
}

// Verdict is what a rule answers.
//
// Constructed only through the four constructors below, so the invariants the
// host checks hold by construction rather than by care.
type Verdict struct {
	contract            int
	verdict             VerdictKind
	findings            []Finding
	reason              string
	notApplicableReason string
}

// Pass means the rule looked and found nothing.
//
// This is a CLAIM about the workspace, not a shrug: it says the rule read the
// evidence it declared it needs and there was nothing to report. A rule that
// could not read that evidence answers [Unknown] instead (../../AGENTS.md).
func Pass() Verdict {
	return newVerdict(VerdictPass, nil)
}

// Fail means the rule found something, and the findings say what.
func Fail(findings Findings) Verdict {
	return newVerdict(VerdictFail, findings.All())
}

// Unknown means the rule could not reach a judgment, and reason says why.
//
// This is the verdict for every path that would otherwise return an empty list
// it did not earn: a parameter that is not there, an evidence kind that arrived
// malformed, two halves of the bundle that disagree. Any unknown makes the run
// exit 3 — "could not look" is a distinct outcome from "looked and found
// nothing", and the exit codes keep it that way.
func Unknown(reason string) Verdict {
	answer := newVerdict(VerdictUnknown, nil)
	answer.reason = reason
	return answer
}

// NotApplicable means the rule does not apply to this run, and reason says why.
//
// Not a quieter [Pass]: it is counted and reported separately, because a rule
// that never applies is a rule nobody is being protected by, and that has to be
// visible rather than absorbed into a passing count.
func NotApplicable(reason string) Verdict {
	answer := newVerdict(VerdictNotApplicable, nil)
	answer.notApplicableReason = reason
	return answer
}

// FromFindings is [Pass] when the slice is empty and [Fail] when it is not.
//
// The shape most rules end in, and the one place emptiness legitimately means
// "clean" — because the caller has just finished looking. A rule that reaches
// here without having looked has already gone wrong somewhere above, which is
// what [Unknown] is for.
func FromFindings(findings []Finding) Verdict {
	if nonEmpty, ok := FindingsFrom(findings); ok {
		return Fail(nonEmpty)
	}
	return Pass()
}

// Kind is which of the four this is.
func (v Verdict) Kind() VerdictKind { return v.verdict }

// Findings is what the verdict names, in the order the rule added them.
func (v Verdict) Findings() []Finding { return v.findings }

// verdictDocument is the wire shape of a verdict.
//
// Field order is the wire order, matching what the Rust binding's serde emits:
// contract, verdict, findings, reason, notApplicableReason.
//
// Findings carries no omitempty, and [Verdict.JSON] fills it with a make'd
// slice so that it is never nil. That is the one place encoding/json's
// nil-slice-becomes-null default would be a hollow verdict rather than a
// cosmetic difference: `"findings": null` is refused by the host — "every
// verdict states its findings, and a clean rule states the empty list rather
// than leaving the field out" — so a passing rule would be reported as a rule
// that could not answer. ./verdict_test.go pins the empty list from both
// directions.
type verdictDocument struct {
	Contract            int               `json:"contract"`
	Verdict             VerdictKind       `json:"verdict"`
	Findings            []findingDocument `json:"findings"`
	Reason              string            `json:"reason,omitempty"`
	NotApplicableReason string            `json:"notApplicableReason,omitempty"`
}

// JSON is the verdict as the UTF-8 JSON text the ABI carries back.
func (v Verdict) JSON() string {
	findings := make([]findingDocument, len(v.findings))
	for index, finding := range v.findings {
		findings[index] = finding.document()
	}
	return marshalJSON(verdictDocument{
		Contract:            v.contract,
		Verdict:             v.verdict,
		Findings:            findings,
		Reason:              v.reason,
		NotApplicableReason: v.notApplicableReason,
	})
}

// newVerdict is the one place a Verdict is built.
//
// The nil normalisation is for [Verdict.Findings], so a caller ranging over a
// passing verdict's findings gets the empty list rather than nil; the wire's
// own guarantee is made in [Verdict.JSON] and argued at [verdictDocument].
func newVerdict(kind VerdictKind, findings []Finding) Verdict {
	if findings == nil {
		findings = []Finding{}
	}
	return Verdict{contract: Contract, verdict: kind, findings: findings}
}

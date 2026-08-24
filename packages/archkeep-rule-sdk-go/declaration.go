// What a rule says about itself before it is ever handed evidence, and the one
// place an artifact says which rule it IS.
//
// The host reads the self-description first and refuses the rule outright when
// it is malformed — an empty catalogue, a duplicate finding id, a name that is
// not the one the policy row declared (../archkeep/src/custom-rules/host.mjs,
// describeViolation and catalogueViolation). The Rust binding decides all of
// that in const context, so a rule that could not have loaded fails `cargo
// build` (../archkeep-rule-sdk-rust/src/declaration.rs). Go has no const
// evaluation of a struct literal and no way to run a check at build time
// without a build step this package refuses to have, so the same refusals
// happen in [Register] instead — which runs from an init function, and
// therefore fires on the first `go test` in the author's own package rather
// than in a consumer's CI.

package archkeeprule

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// EvidenceKind is one of the four kinds of observed fact contract 1 carries.
//
// The roster is the engine's (../archkeep/src/custom-rules/evidence.mjs,
// EVIDENCE_KINDS) and these constants are a copy of it — the one copy this
// package makes, because a Needs entry has to be spelled somewhere. A kind
// added to contract 1 arrives here in the same change that adds it there.
//
// A defined string type rather than an enum Go does not have: EvidenceKind("x")
// is spellable, which is why [Register] checks every entry against the four
// below and refuses an unknown one by name. Left unchecked it would reach the
// host as an unsupported kind and make the rule's verdict unknown in a
// consumer's CI, which is the same answer four steps later.
type EvidenceKind string

const (
	// KindModel is the project model: every project, its root, and its tags.
	KindModel EvidenceKind = "model"
	// KindGraph is the dependency graph: every edge between two projects.
	KindGraph EvidenceKind = "graph"
	// KindImports is every import site the analyzers read, with its attribution.
	KindImports EvidenceKind = "imports"
	// KindPolicy is the loaded policy: the constraint rows and the boundary options.
	KindPolicy EvidenceKind = "policy"
)

// evidenceKinds is the roster in the order the schema lists them, which is also
// the order a violation message names them in.
var evidenceKinds = []EvidenceKind{KindModel, KindGraph, KindImports, KindPolicy}

// CatalogueEntry is one entry in a rule's findings catalogue: an id a finding
// can resolve to, and the sentence that describes what it means.
//
// The catalogue is what a SARIF report's reportingDescriptor set is built from,
// which is why the host checks it at LOAD rather than when a finding arrives: a
// rule whose catalogue is malformed produces findings no report can render, and
// that would only be discovered on the run that finally fails.
//
// Both fields are exported, where the Rust binding keeps them private behind a
// constructor. Hiding them would buy nothing here: Go evaluates no struct
// literal at compile time, so [Register] is where a malformed entry is caught
// either way, and a constructor would only add a word to every line an author
// writes.
type CatalogueEntry struct {
	// ID is lowercase words joined by single dashes — the same grammar a rule
	// name follows, because custom/<rule>/<finding> has one alphabet end to end
	// (../archkeep/src/config.mjs, CUSTOM_RULE_NAME_PATTERN).
	ID string `json:"id"`
	// Message is the template a reader sees when nothing more specific is
	// available; a finding carries its own message on top of it.
	Message string `json:"message"`
}

// Rule is everything an artifact declares about itself: the name a policy row
// must match, the evidence it reads, every finding it can report, and the
// function that reports them.
type Rule struct {
	// Name MUST equal the name its policy row declares — the host refuses the
	// pair when they differ, because the declared name is what every finding is
	// namespaced under.
	Name string
	// Needs is the evidence kinds this rule reads.
	Needs []EvidenceKind
	// Findings is every finding this rule can report. At least one, always: a
	// rule that can name nothing it might find would read as permanently clean.
	Findings []CatalogueEntry
	// Evaluate is the rule itself: a pure function from evidence to verdict, and
	// nothing else in either direction.
	Evaluate func(*Evidence) Verdict
}

// registered is the one rule this artifact is.
//
// A package-level variable rather than an argument threaded through the ABI,
// because the ABI shell (./abi_freestanding.go) is written once here and cannot be
// handed anything by an author who writes no shell at all. One artifact is one
// rule by the contract's own shape — archkeep_describe answers with a single
// document — so [Register] refuses a second call rather than keeping a table
// nothing could index into.
var registered *Rule

// Register declares the rule this artifact is. Call it from an init function.
//
// # Why init, and why that ordering is load-bearing
//
// A core wasm module has no main and runs no start function the host invokes:
// the host reads archkeep_describe before anything else exists
// (../archkeep/src/custom-rules/host.mjs, loadCustomRule). The ABI shell
// therefore starts the Go runtime itself on the first call into any export
// (./abi_freestanding.go), and starting the runtime is what runs every package's init
// — including the one that calls this. So a rule registered from init is
// registered before the first byte of the self-description is written, and a
// rule assigned to a package-level variable would be read before it was set.
//
// # What it refuses, and why the refusal is a panic
//
// Four checks, each one the host's own moved to the earliest place Go can
// decide it: the name and every finding id must be lowercase words joined by
// single dashes, the catalogue must not be empty, no two entries may share an
// id, and every Needs entry must name a kind contract 1 carries. Two more the
// host cannot make because they are not on the wire: Evaluate must not be nil,
// and Register must not be called twice.
//
// Each is a panic rather than a returned error, because there is no caller to
// return to — init has no error channel, and a rule that recorded the problem
// and carried on would answer archkeep_describe with a document naming a rule
// that does not exist. Off wasm the panic is what an author reads from `go
// test`; on wasm it is a trap the host names (../archkeep/src/custom-rules/host.mjs,
// outcomeReason's "trap" arm), which is a load failure rather than a rule that
// quietly reports nothing.
func Register(rule Rule) {
	if registered != nil {
		panic(fmt.Sprintf(
			"archkeeprule.Register: this artifact already declares the rule %q — one artifact is "+
				"one rule, because archkeep_describe answers with a single document",
			registered.Name))
	}
	if violation := validate(rule); violation != "" {
		panic("archkeeprule.Register: " + violation)
	}
	registered = &rule
}

// Registered is the rule this artifact declares.
//
// It panics when nothing has registered one. That is the loud direction and the
// only one available: every document archkeep_describe could answer with instead
// would name a rule, and naming a rule that does not exist is how a workspace
// ends up believing an artifact enforces something.
func Registered() Rule {
	if registered == nil {
		panic("archkeeprule.Registered: no rule was registered — call archkeeprule.Register from an " +
			"init function, which is what runs before the host reads archkeep_describe")
	}
	return *registered
}

// validate is what is wrong with a declaration, or the empty string.
//
// Separated from [Register] so ./declaration_test.go can drive every refusal
// without recovering from a panic per case, and so the sentences a reader sees
// are written once.
func validate(rule Rule) string {
	if !isLowerDashed(rule.Name) {
		return fmt.Sprintf(
			"Name is %q, and a rule name is lowercase letters and digits joined by single dashes — "+
				"the same grammar the policy row's own name is held to", rule.Name)
	}
	if rule.Evaluate == nil {
		return fmt.Sprintf(
			"the rule %q declares no Evaluate function — an artifact that cannot judge would trap "+
				"on the first evidence bundle rather than report anything", rule.Name)
	}
	for _, kind := range rule.Needs {
		if !isEvidenceKind(kind) {
			return fmt.Sprintf(
				"Needs carries %q, which contract %d does not carry — this engine supplies %s, and a "+
					"rule naming a kind it cannot be handed reaches the host as an unknown verdict",
				kind, Contract, joinKinds())
		}
	}
	if len(rule.Findings) == 0 {
		return "Findings declares no entry — a rule that can name nothing it might find can never " +
			"report one, and would read as permanently clean"
	}
	seen := make(map[string]bool, len(rule.Findings))
	for index, entry := range rule.Findings {
		if !isLowerDashed(entry.ID) {
			return fmt.Sprintf(
				"Findings[%d].ID is %q, and a finding id is lowercase letters and digits joined by "+
					"single dashes", index, entry.ID)
		}
		if seen[entry.ID] {
			return fmt.Sprintf(
				"Findings declares the id %q twice — two entries under one id make the namespaced id "+
					"ambiguous, and a report would resolve findings to whichever entry it happened to "+
					"read last", entry.ID)
		}
		seen[entry.ID] = true
		if entry.Message == "" {
			return fmt.Sprintf(
				"Findings[%d] (%q) has no Message — a catalogue entry with none renders as a finding "+
					"that says nothing", index, entry.ID)
		}
	}
	return ""
}

// isEvidenceKind reports whether kind is one of the four contract 1 carries.
func isEvidenceKind(kind EvidenceKind) bool {
	for _, known := range evidenceKinds {
		if kind == known {
			return true
		}
	}
	return false
}

// joinKinds is the roster as a message names it.
func joinKinds() string {
	names := make([]string, len(evidenceKinds))
	for index, kind := range evidenceKinds {
		names[index] = string(kind)
	}
	return strings.Join(names, ", ")
}

// isLowerDashed reports whether value is lowercase letters and digits joined by
// single dashes.
//
// A hand-written scan rather than regexp, and the reason is the artifact:
// importing regexp would link its engine into every rule module, where the one
// pattern it would ever compile is this line. Size matters here for a reason it
// usually does not — the artifact is committed to the workspace that declares
// the rule and reviewed as bytes (./README.md).
func isLowerDashed(value string) bool {
	if value == "" {
		return false
	}
	previousDash := true // a leading dash is as illegal as a trailing one
	for index := 0; index < len(value); index++ {
		character := value[index]
		switch {
		case (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9'):
			previousDash = false
		case character == '-':
			if previousDash {
				return false
			}
			previousDash = true
		default:
			return false
		}
	}
	return !previousDash
}

// describe is the document archkeep_describe returns, in the shape the host
// parses.
//
// A private mirror of [Rule] rather than JSON tags on the type itself, for two
// reasons: contract is not a field an author declares, and Evaluate is a
// function, which encoding/json refuses to marshal — a tag-based Rule would
// serialize only by carrying `json:"-"` on the one field that makes it a rule.
//
// Field order is the wire order, because encoding/json writes struct fields in
// declaration order and the Rust binding's serde does the same: contract, name,
// needs, findings produces the identical bytes from both SDKs for the identical
// declaration, which is a property ./declaration_test.go pins.
type describe struct {
	Contract int              `json:"contract"`
	Name     string           `json:"name"`
	Needs    []EvidenceKind   `json:"needs"`
	Findings []CatalogueEntry `json:"findings"`
}

// DescribeJSON is the registered rule's self-description, as UTF-8 JSON text.
//
// It is the pure half of archkeep_describe: target-independent, so a `go test`
// on the host drives the exact code the artifact runs rather than a rehearsal
// of it (./abi_freestanding.go carries the other half).
func DescribeJSON() string {
	rule := Registered()
	needs := rule.Needs
	if needs == nil {
		// The empty list, never null: a rule that reads nothing states that it
		// reads nothing. `null` would reach the host as "declares needs null,
		// not an array of evidence kinds" — a true accusation, but about the
		// serializer rather than the rule.
		needs = []EvidenceKind{}
	}
	return marshalJSON(describe{
		Contract: Contract,
		Name:     rule.Name,
		Needs:    needs,
		Findings: rule.Findings,
	})
}

// marshalJSON is the one serializer this package uses, for documents whose
// every field is a string, a number, a bool or a slice of those.
//
// # Two decisions a plain json.Marshal would take differently
//
// HTML escaping is OFF. json.Marshal escapes the three characters < > & to
// their \u form, which is a defence for JSON pasted into a script tag and has
// no meaning for bytes read back by a JSON parser. Left on, a finding message
// naming a Rust
// generic or a shell redirect would serialize differently here than in the Rust
// binding (../archkeep-rule-sdk-rust/src/verdict.rs) over the same verdict, and
// the shared conformance suite would be comparing two SDKs' escaping habits
// rather than one contract.
//
// A marshalling failure panics rather than returning an error. Nothing this
// package marshals can fail — a describe and a verdict are strings, integers
// and slices, and the one shape encoding/json refuses (a func) is unreachable
// because the mirror structs above and in ./verdict.go carry no such field. A
// panic reaches the host as a trap it names, which is the loud direction; the
// alternative would be inventing a verdict on the way out.
func marshalJSON(document any) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(document); err != nil {
		panic("archkeeprule: a document of strings and integers failed to serialize: " + err.Error())
	}
	// Encoder.Encode appends a newline; the ABI carries a byte range, not a
	// stream, and a trailing newline would be a byte the host copies for nothing.
	return string(bytes.TrimRight(buffer.Bytes(), "\n"))
}

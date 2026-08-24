// Package archkeeprule lets you author a Archkeep custom architecture rule in
// Go, compile it to core WebAssembly with TinyGo, and have the engine load it
// as declared law.
//
// This package is a binding, never a semantics
// (../../docs/adr/0002-custom-rules-one-contract.md, "SDKs are bindings"): it
// owns typed shapes for the evidence bundle and the verdict, the ABI shell
// that carries bytes across the wasm boundary, and — in ./harness — a replay
// of the golden fixtures. Every rule about what a verdict MEANS is decided by
// the engine's host (../archkeep/src/custom-rules/host.mjs) and is deliberately
// not reimplemented here. Two validators would agree only until one of them
// was edited.
//
// # What a rule author writes
//
// The whole artifact, and nothing omitted:
//
//	package main
//
//	import archkeeprule "github.com/ecoma-io/archkeep/packages/archkeep-rule-sdk-go"
//
//	func evaluate(evidence *archkeeprule.Evidence) archkeeprule.Verdict {
//		var params struct {
//			Tag string `json:"tag"`
//		}
//		if err := evidence.ReadParams(&params); err != nil || params.Tag == "" {
//			// Not Pass. A rule that could not read its own parameters has not
//			// judged anything, and saying so is the whole discipline
//			// (../../AGENTS.md: an empty result is a claim, not a shrug).
//			return archkeeprule.Unknown("params.tag is not a string, so nothing was judged")
//		}
//		var findings []archkeeprule.Finding
//		for _, project := range evidence.Model.Projects {
//			if project.HasTag(params.Tag) {
//				findings = append(findings,
//					archkeeprule.NewFinding("tagged-project", "a project carries the tag").
//						InProject(project.Name))
//			}
//		}
//		return archkeeprule.FromFindings(findings)
//	}
//
//	func init() {
//		archkeeprule.Register(archkeeprule.Rule{
//			Name:  "example-rule",
//			Needs: []archkeeprule.EvidenceKind{archkeeprule.KindModel},
//			Findings: []archkeeprule.CatalogueEntry{
//				{ID: "tagged-project", Message: "a project carries the named tag"},
//			},
//			Evaluate: evaluate,
//		})
//	}
//
//	// A wasm module has no main to run, but Go has no way to spell a main
//	// package without one. It is never called.
//	func main() {}
//
// There is no macro because Go has none. What the Rust binding's archkeep_rule!
// generates — the declaration constant and the four ABI exports — is instead a
// Register call from an init function plus three //export directives this
// package already carries (./abi_freestanding.go), so an author writes neither. The
// cost of that trade is stated where it lands, in [Register]: Rust refuses a
// malformed declaration at compile time and Go cannot, so the same four
// refusals happen on the first call into Register — which for the author is
// `go test`, and for a consumer would be a load failure.
//
// examples/forbidden_tag_dependency is the same shape carried through to a
// committed artifact, and README.md beside this file is the build story.
//
// # The three things this package refuses to do
//
//   - It never re-models the policy. Policy.DepConstraints and
//     Policy.ModuleBoundaryOptions arrive as json.RawMessage, because the
//     constraint schema has exactly one owner (../archkeep/src/config.mjs) and a
//     second copy here would be a dialect that drifts.
//   - It never turns an unreadable bundle into a clean verdict. Every path that
//     cannot reach a judgment answers Unknown with the cause named — see
//     [EvaluateJSON].
//   - It never validates what the host validates. Whether a finding's id
//     appears in the catalogue is the host's refusal to make, and duplicating
//     it here would put this package's opinion between an author and the real
//     one.
package archkeeprule

// Contract is the contract version this SDK speaks, on every side of the ABI at
// once.
//
// One number rather than three, for the reason the host states beside its own
// (../archkeep/src/custom-rules/host.mjs): the evidence a rule receives, the
// description it answers with and the verdict it returns version together, so a
// rule built for one is built for all three.
const Contract = 1

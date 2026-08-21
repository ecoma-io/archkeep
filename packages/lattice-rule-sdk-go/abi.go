// The wire, target-independent half: evidence bytes in, verdict text out.
//
// Contract 1's ABI is four exports and one packing rule
// (../lattice/src/custom-rules/host.mjs): memory, lattice_alloc,
// lattice_describe, lattice_evaluate, and an i64 result carrying
// (pointer << 32) | length, both u32. ./abi_freestanding.go writes those exports and is
// compiled only for TinyGo's freestanding wasm target; this file and
// ./declaration.go's DescribeJSON are the pair the exports call, and they
// compile everywhere — which is what lets a plain `go test` on a developer's
// own machine drive the exact code the artifact runs rather than a rehearsal of
// it.

package latticerule

// EvaluateJSON is the registered rule's verdict over one evidence bundle, as
// UTF-8 JSON text.
//
// The bundle is read before the rule sees it, and a bundle that cannot be read
// becomes an unknown verdict naming the cause — never a pass, and never an
// empty finding list standing in for "could not look" (../../AGENTS.md). That
// single branch is why an author's rule signature is
// func(*Evidence) Verdict and not func([]byte) Verdict: the failure that has
// exactly one correct answer is answered here, once, rather than in every rule
// that ever gets written.
func EvaluateJSON(evidence []byte) string {
	rule := Registered()
	bundle, err := ReadEvidence(evidence)
	if err != nil {
		return Unknown(err.Error()).JSON()
	}
	return rule.Evaluate(bundle).JSON()
}

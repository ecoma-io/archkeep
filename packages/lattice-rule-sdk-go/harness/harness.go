// Package harness replays golden evidence fixtures against a rule, locally.
//
// The third thing an SDK owns — bindings, build story, test harness
// (../../../docs/adr/0002-custom-rules-one-contract.md, "SDKs are bindings").
// What holds four SDKs to one contract is a shared conformance suite: evidence
// fixtures with expected verdicts that every SDK's reference rules must
// reproduce. ../fixtures/ is this module's half of that suite, and this package
// is what runs it.
//
// It is a separate package rather than a file in the SDK, and the reason is
// what it does: it reads files and takes a testing.TB. A rule module is loaded
// by a host that grants it no filesystem at all
// (../../lattice/src/custom-rules/host.mjs), so code that could never run
// inside the artifact has no business being reachable from it — and in Go the
// only way to say "not reachable from there" is a package the artifact's import
// graph does not contain. The Rust binding spells the same fact as a
// #[cfg(not(target_arch = "wasm32"))] module
// (../../lattice-rule-sdk-rust/src/harness.rs).
//
// The comparison is between JSON DOCUMENTS, not between strings: key order and
// whitespace are a serializer's business, and pinning them would make a
// conformance suite that four SDKs must reproduce depend on how one of them
// happens to write its output. Everything the contract fixes — which keys are
// present, which are absent, and what each holds — is compared exactly.
package harness

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

// FixturesDir is the golden fixture directory, resolved from this source file
// rather than from the working directory.
//
// `go test ./...` runs each package's tests with that package's own directory
// as the working directory, so a relative path would resolve differently from
// the SDK's tests and from the example's. runtime.Caller answers where this
// file is, which is one place regardless of who is asking. It panics when the
// answer is unavailable — a harness that guessed a path would report a missing
// fixture as a rule that answered something.
func FixturesDir() string {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		panic("harness: the compiler recorded no path for this file, so the fixture directory " +
			"cannot be located — a guessed path would turn a missing fixture into a silent skip")
	}
	return filepath.Join(filepath.Dir(filepath.Dir(thisFile)), "fixtures")
}

// Fixture is the path of one golden fixture by name.
func Fixture(name string) string {
	return filepath.Join(FixturesDir(), name)
}

// ReadFixture is the bytes of one golden fixture, by name.
//
// It fails the test when the fixture cannot be read. A missing fixture is a
// broken suite, not a rule that answered something — and a harness that skipped
// it would report a green run over a file nobody read.
func ReadFixture(t testing.TB, name string) []byte {
	t.Helper()
	path := Fixture(name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the fixture %s could not be read: %v", path, err)
	}
	return data
}

// Replay is the verdict a rule answers over one golden fixture, as a parsed
// document.
//
// evaluate is [github.com/ecoma-io/lattice/packages/lattice-rule-sdk-go.EvaluateJSON]
// — the same function the artifact's lattice_evaluate export calls, so what a
// fixture exercises is the shipped path and not a rehearsal of it.
//
// It fails the test when the rule answers text that is not JSON, which the host
// would refuse as an unparseable verdict — refused here where the author can
// still see why.
func Replay(t testing.TB, name string, evaluate func([]byte) string) map[string]any {
	t.Helper()
	answered := evaluate(ReadFixture(t, name))
	var document map[string]any
	if err := json.Unmarshal([]byte(answered), &document); err != nil {
		t.Fatalf("the rule answered text that is not JSON over %s: %v\n%s", name, err, answered)
	}
	return document
}

// ExpectVerdict asserts a rule's verdict over one golden fixture equals
// expected, which is itself JSON text.
//
// It prints both documents when they differ — the failure a conformance suite
// exists to produce.
func ExpectVerdict(t testing.TB, name string, evaluate func([]byte) string, expected string) {
	t.Helper()
	answered := Replay(t, name, evaluate)
	var want map[string]any
	if err := json.Unmarshal([]byte(expected), &want); err != nil {
		t.Fatalf("the expected verdict is not JSON: %v", err)
	}
	if !reflect.DeepEqual(answered, want) {
		t.Fatalf("the rule's verdict over %s is not the one the suite pins\n got: %#v\nwant: %#v",
			name, answered, want)
	}
}

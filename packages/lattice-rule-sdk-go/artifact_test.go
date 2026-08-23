// The committed artifact and its recorded digest cannot drift apart.
//
// examples/forbidden_tag_dependency.wasm is a binary in a repository that
// reviews text, and …​.wasm.sha256 beside it is the string a customRules row
// pins it by — the mechanism that makes "the law CI ran is the law review saw"
// checkable (../../docs/adr/0002-custom-rules-one-contract.md). Two files that
// must agree and no gate comparing them is a pair that silently stops agreeing
// the first time one of them is rebuilt alone, and the failure surfaces in a
// CONSUMER's tree as a load error naming a hash nobody here can explain.
//
// The Rust binding writes SHA-256 out by hand rather than take a third
// dependency for one test, and holds it honest against FIPS 180-4's published
// vectors (../lattice-rule-sdk-rust/tests/artifact.rs). Nothing like that is
// needed here: crypto/sha256 is the standard library, and this module's
// dependency list is empty either way.

package latticerule

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
)

// artifactPath and digestPath are relative to this package's directory, which
// is where `go test` runs a package's tests from — the module root, for the
// root package.
const (
	artifactPath = "examples/forbidden_tag_dependency.wasm"
	digestPath   = "examples/forbidden_tag_dependency.wasm.sha256"
)

func TestTheCommittedArtifactHashesToTheRecordedDigest(t *testing.T) {
	artifact, err := os.ReadFile(artifactPath)
	if err != nil {
		t.Fatalf("%s could not be read: %v", artifactPath, err)
	}
	recorded, err := os.ReadFile(digestPath)
	if err != nil {
		t.Fatalf("%s could not be read: %v", digestPath, err)
	}

	digest := recorded
	trimmed := strings.TrimSpace(string(digest))
	computed := sha256.Sum256(artifact)
	if hex.EncodeToString(computed[:]) != trimmed {
		t.Fatalf("the committed artifact and its recorded digest have drifted apart — rebuild both "+
			"with ./rebuild-example.sh rather than editing either one\n artifact: %s\n recorded: %s",
			hex.EncodeToString(computed[:]), trimmed)
	}
	if len(trimmed) != 64 {
		t.Fatalf("a sha256 is 64 hex characters, and this is %d", len(trimmed))
	}
	for _, character := range trimmed {
		if !strings.ContainsRune("0123456789abcdef", character) {
			t.Fatalf("the recorded digest must be lowercase hex, which is how a policy row spells "+
				"one: %s", trimmed)
		}
	}
}

// TestTheCommittedArtifactIsAWebAssemblyModule is a four-byte check that
// catches the failures a digest cannot describe: a truncated file, a text
// placeholder, a pointer left by a large-file filter. All three would hash
// consistently and load as nothing.
func TestTheCommittedArtifactIsAWebAssemblyModule(t *testing.T) {
	artifact, err := os.ReadFile(artifactPath)
	if err != nil {
		t.Fatalf("%s could not be read: %v", artifactPath, err)
	}
	if len(artifact) < 8 {
		t.Fatalf("%s is %d bytes, which is not a module", artifactPath, len(artifact))
	}
	magic := [8]byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}
	if [8]byte(artifact[:8]) != magic {
		t.Fatalf("the artifact does not open with the wasm magic and version 1: % x", artifact[:8])
	}
}

// TestTheCommittedArtifactCarriesNoImportSection is the contract's own refusal,
// checked here on the bytes rather than only by the host.
//
// A module that imports anything is refused at load — "the contract grants no
// imports" — and that is the mechanism behind a rule holding no ambient
// capability. Go cannot instantiate the artifact without a wasm runtime this
// module refuses to depend on, so what it can check is the binary: section id 2
// is the import section, and its absence is what the host's check comes down
// to. ./rebuild-example.sh drives the real instantiation before it records a
// digest, and ./README.md records the round trip through the engine's host.
func TestTheCommittedArtifactCarriesNoImportSection(t *testing.T) {
	artifact, err := os.ReadFile(artifactPath)
	if err != nil {
		t.Fatalf("%s could not be read: %v", artifactPath, err)
	}
	if err := checkNoImportSection(artifact); err != nil {
		t.Fatal(err)
	}
}

// checkNoImportSection walks a module's sections and answers why the contract
// would refuse it, or nil when every section clears.
//
// The walk split from the committed file for the same reason the SHA-256 above
// is held against FIPS 180-4's vectors: the committed artifact carries NO import
// section, so a walk tested only against it can drift — an id comparison that
// stops comparing, a length read that miscounts — and stay green forever by not
// looking. The synthetic modules in
// TestTheSectionWalkRefusalsAreProvenAgainstSyntheticModules are what make this
// function's refusals real rather than unreachable branches.
//
// Sections follow the 8-byte preamble, each a one-byte id then a LEB128 length
// then that many bytes. Walking them needs no wasm knowledge beyond that, and
// stopping at the first malformed length keeps a corrupt file from being read
// as one that simply has no imports; the tail check keeps one whose declared
// lengths run past its end from passing either.
func checkNoImportSection(module []byte) error {
	offset := 8
	for offset < len(module) {
		id := module[offset]
		offset++
		size, read := uvarint(module[offset:])
		if read <= 0 {
			return fmt.Errorf("the section at byte %d has no readable length, so this module "+
				"is not one this test can clear", offset)
		}
		if id == 2 {
			return errors.New("the module declares an import section, and the contract grants " +
				"no imports — the host would refuse it at load")
		}
		offset += read + int(size)
	}
	if offset != len(module) {
		return fmt.Errorf("the sections do not add up to the module's %d bytes, ending at %d",
			len(module), offset)
	}
	return nil
}

// sectionWalkPreamble is the eight bytes every core WebAssembly module starts
// with, the start of every synthetic module below.
var sectionWalkPreamble = []byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}

// TestTheSectionWalkRefusalsAreProvenAgainstSyntheticModules drives
// checkNoImportSection over modules built here, because the committed artifact
// can only ever show the clearing half of the walk. A refusal that stopped
// firing — on an id compare that regressed, a uvarint that miscounted — would
// leave that artifact green while every module the host actually refuses
// sailed through, which is the silent direction this suite exists to refuse.
func TestTheSectionWalkRefusalsAreProvenAgainstSyntheticModules(t *testing.T) {
	cases := []struct {
		name    string
		module  []byte
		refusal string
	}{
		{
			name: "an import section is refused",
			// One memory import on behalf of the (empty-named) module "a":
			// count=1, name len=0, kind=2, limits flags/min/max.
			module:  append(append([]byte{}, sectionWalkPreamble...), 2, 6, 1, 0, 2, 1, 1, 1),
			refusal: "declares an import section",
		},
		{
			name: "a length that never terminates is refused, not cleared",
			// A continuation byte with nothing after it: reading it as zero
			// sections would be a clean answer over a corrupt file.
			module:  append(append([]byte{}, sectionWalkPreamble...), 1, 0x80),
			refusal: "no readable length",
		},
		{
			name: "a payload truncated after its declared length is refused",
			// Ten of the two hundred bytes the length claims: the framing
			// arithmetic must notice, not wrap around into a clean pass.
			module: append(append(append([]byte{}, sectionWalkPreamble...), 1, 0xc8, 0x01),
				make([]byte, 10)...),
			refusal: "do not add up",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			err := checkNoImportSection(testCase.module)
			if err == nil {
				t.Fatal("the walk cleared a module it must refuse")
			}
			if !strings.Contains(err.Error(), testCase.refusal) {
				t.Fatalf("refused, but not for the reason under test: %v", err)
			}
		})
	}
}

// TestTheSectionWalkClearsAModuleWithoutAnImportSection is the positive half:
// the walk must clear what should clear, including a section whose length
// needs two LEB128 bytes — a uvarint that stopped after the first byte would
// misread it as a tiny section and either fail the framing or skip wrong, and
// only a module that exercises both bytes can tell.
func TestTheSectionWalkClearsAModuleWithoutAnImportSection(t *testing.T) {
	module := append([]byte{}, sectionWalkPreamble...)
	module = append(module, 0, 4, 1, 'a', 'b', 'c') // a custom section
	long := append([]byte{1, 0xc8, 0x01}, make([]byte, 200)...)
	module = append(module, long...) // type section, 200-byte payload, two LEB128 bytes

	if err := checkNoImportSection(module); err != nil {
		t.Fatalf("the walk refused a module with no import section: %v", err)
	}
}

// uvarint reads one LEB128-encoded unsigned integer, answering its value and
// how many bytes it took. read is 0 when the encoding runs off the end.
//
// encoding/binary's Uvarint is the same algorithm and would do; it is written
// out because the answer this test turns on is "how many bytes", and
// binary.Uvarint returns a negative count for two different failures that both
// have to be treated as one here anyway.
func uvarint(data []byte) (value uint64, read int) {
	var shift uint
	for index, b := range data {
		value |= uint64(b&0x7f) << shift
		if b&0x80 == 0 {
			return value, index + 1
		}
		shift += 7
		if shift >= 64 {
			return 0, 0
		}
	}
	return 0, 0
}

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

	// Sections follow the 8-byte preamble, each a one-byte id then a LEB128
	// length then that many bytes. Walking them needs no wasm knowledge beyond
	// that, and stopping at the first malformed length keeps a corrupt file from
	// being read as one that simply has no imports.
	offset := 8
	for offset < len(artifact) {
		id := artifact[offset]
		offset++
		size, read := uvarint(artifact[offset:])
		if read <= 0 {
			t.Fatalf("the section at byte %d has no readable length, so this file is not a module "+
				"this test can clear", offset)
		}
		if id == 2 {
			t.Fatal("the artifact declares an import section, and the contract grants no imports — " +
				"the host would refuse it at load")
		}
		offset += read + int(size)
	}
	if offset != len(artifact) {
		t.Fatalf("the sections do not add up to the file's %d bytes, ending at %d",
			len(artifact), offset)
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

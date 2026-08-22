// The evidence bundle, typed.
//
// Every field name and every optionality below is read off the engine's own
// assembly (../lattice/src/custom-rules/evidence.mjs) and the frozen record it
// copies through (../lattice/src/analysis/contract.md). The bundle is the wire,
// not the engine's internals: ../lattice/src/config.mjs calls the eight
// boundary settings `options` and the bundle renames them to
// `moduleBoundaryOptions` — the name the workspace itself wrote — so that is
// the name here too.
//
// # Unknown fields are accepted, unknown VALUES are not
//
// encoding/json ignores a field no struct here declares, which is the wanted
// behaviour: the evidence contract "grows additively within a version"
// (../../docs/adr/0002-custom-rules-one-contract.md, Consequences), so a rule
// compiled today must keep reading a bundle that gained a field tomorrow —
// refusing it would make every existing rule unknown on an engine upgrade that
// added nothing they read.
//
// An unknown VALUE is the opposite case, and it is the one place this file
// writes an UnmarshalJSON by hand. ../lattice/src/analysis/contract.md fixes
// the four import kinds, and a fifth one arriving is a contract change a rule
// must be rebuilt for. A plain `type ImportKind string` would accept it
// silently and let a rule judge a record it had misread — the silent direction,
// and the reason [ImportKind.UnmarshalJSON] exists.

package latticerule

import (
	"encoding/json"
	"fmt"
)

// Evidence is everything a rule is handed, and the only thing it is ever
// handed.
type Evidence struct {
	// Contract is the version the bundle states. Always [Contract] by the time a
	// rule sees it — [ReadEvidence] refuses anything else rather than reading a
	// document it was not built against.
	Contract int `json:"contract"`
	// Rule is which rule this bundle was built for, and the parameters its policy
	// row declared.
	Rule RuleInstance `json:"rule"`
	// Model is the project model.
	Model Model `json:"model"`
	// Graph is the dependency graph.
	Graph Graph `json:"graph"`
	// Imports is every import site the analyzers read, each attributed to the
	// project that owns the importing file. In source order, which is part of the
	// analysis contract rather than an accident — the engine deliberately does
	// not sort this array.
	Imports []ImportRecord `json:"imports"`
	// Policy is the loaded policy.
	Policy Policy `json:"policy"`
}

// RuleInstance is the declared rule row, as the bundle carries it.
type RuleInstance struct {
	// Name is the name the policy row declared, which is also the name this
	// artifact's own declaration must state.
	Name string `json:"name"`
	// Params is the row's params, verbatim and unparsed. `{}` when the row
	// declared none — the engine writes that default into the BUNDLE and never
	// back onto the policy, so a rule reading an empty object cannot tell whether
	// the workspace wrote `params: {}` or omitted the field, and must not need
	// to. [Evidence.ReadParams] is how a rule reads it.
	Params json.RawMessage `json:"params"`
}

// Model is the `model` kind: every project the run covers, sorted by name.
type Model struct {
	// Projects are the projects, in name order.
	Projects []Project `json:"projects"`
}

// Project is one project, as the workspace's provider reported it.
type Project struct {
	// Name is the project's name — the identity every edge and every attribution
	// uses.
	Name string `json:"name"`
	// Root is the project's root, workspace-relative.
	Root string `json:"root"`
	// Tags are the project's tags, verbatim. An untagged project carries an empty
	// list; the engine refuses to build a bundle in which "no tags" and "tags
	// were never read" look the same, so an empty list here is a fact.
	Tags []string `json:"tags"`
}

// HasTag reports whether this project carries tag, compared exactly.
//
// Exact rather than prefix- or glob-matched on purpose: a tag vocabulary
// belongs to the workspace, and a rule that matched `layer-` loosely would be
// inventing a grammar the workspace never agreed to.
func (p *Project) HasTag(tag string) bool {
	for _, carried := range p.Tags {
		if carried == tag {
			return true
		}
	}
	return false
}

// Graph is the `graph` kind: every edge between two projects, sorted by source,
// target, type, then source file.
type Graph struct {
	// Edges are the edges, in the order above.
	Edges []Edge `json:"edges"`
}

// Edge is one dependency edge.
type Edge struct {
	// Source is the depending project's name.
	Source string `json:"source"`
	// Target is the depended-on project's name.
	Target string `json:"target"`
	// Type is how the dependency was established — "static", and whatever else
	// the workspace's own provider emits.
	//
	// A string rather than a closed set, because this vocabulary is the graph
	// provider's (Nx's, Moon's, or the native model's) and not something contract
	// 1 fixes. Refusing a workspace whose provider spells a type this package had
	// never heard of would be a rule failing on a fact it did not need.
	Type string `json:"type"`
	// SourceFile is the file the dependency was read from, when the provider
	// carried one. Absent is normal: `nx graph --file=` emits no sourceFile on
	// any edge, which is why this is a pointer and not a string — "" and "the
	// provider carried none" are different facts.
	SourceFile *string `json:"sourceFile"`
}

// ImportKind is how an import was written — the four forms the analysis
// contract fixes.
type ImportKind string

const (
	// ImportStatic is a top-level import/require/use/Go import declaration.
	ImportStatic ImportKind = "static"
	// ImportDynamic is import() and its per-language equivalents.
	ImportDynamic ImportKind = "dynamic"
	// ImportTypeOnly is erased before runtime (import type), so it creates no
	// runtime dependency.
	ImportTypeOnly ImportKind = "type-only"
	// ImportReExport is `export … from` — an import and a re-publish in one
	// statement.
	ImportReExport ImportKind = "re-export"
)

// importKinds is the roster, in the order the contract lists it.
var importKinds = []ImportKind{ImportStatic, ImportDynamic, ImportTypeOnly, ImportReExport}

// UnmarshalJSON refuses an import kind contract 1 does not carry.
//
// Without it, `type ImportKind string` would accept anything an engine emitted
// and hand a rule a record it had misread — which the rule would then judge and
// report clean over. The error this returns becomes an unknown verdict naming
// the field ([EvaluateJSON]), which is the loud direction.
func (k *ImportKind) UnmarshalJSON(data []byte) error {
	var spelled string
	if err := json.Unmarshal(data, &spelled); err != nil {
		return fmt.Errorf("an import kind is a string, and this one is %s", string(data))
	}
	for _, known := range importKinds {
		if spelled == string(known) {
			*k = known
			return nil
		}
	}
	return fmt.Errorf(
		"the import kind %q is not one contract %d carries, and reading it as some other kind "+
			"would let this rule judge a record it had misread", spelled, Contract)
}

// Spelling is how a specifier is spelled, in the language it was written in.
//
// Two independent bits, because the rules ask two independent questions, and
// both are answered by the analyzer that already knows the language rather than
// derived downstream from the text.
type Spelling struct {
	// Path is true when the specifier is a filesystem path, resolvable by path
	// arithmetic against the importing file, and names no package.
	Path bool `json:"path"`
	// Relative is true when the specifier reaches inside its own project without
	// going out through the project's public name.
	Relative bool `json:"relative"`
}

// Resolved is where a specifier points, when the analyzer could say.
type Resolved struct {
	// Target is the project the specifier resolves into, or nil when it resolves
	// outside every project.
	Target *string `json:"target"`
	// File is the workspace-relative file it resolves to, or nil when resolution
	// stops at a package rather than a file.
	File *string `json:"file"`
	// External is true when the specifier resolves outside every project.
	External bool `json:"external"`
	// PackageName is the package's own name when external — @scope/name, not the
	// deep path, which is what a bannedExternalImports glob is matched against.
	PackageName *string `json:"packageName"`
}

// ImportRecord is one import site: one written import, not one resolved
// dependency. A file importing the same project three times yields three of
// these.
type ImportRecord struct {
	// SourceProject is the project owning the importing file. Added by the engine
	// from the workspace's files-per-project map — the only layer allowed to
	// answer which project owns which file — never re-derived from a root prefix.
	SourceProject string `json:"sourceProject"`
	// SourceFile is the importing file, workspace-relative.
	SourceFile string `json:"sourceFile"`
	// Line is the 1-based line of the import site.
	Line uint32 `json:"line"`
	// Column is the 1-based column of the import site.
	Column uint32 `json:"column"`
	// Specifier is the raw specifier, exactly as written. Five of the fifteen
	// upstream boundary violations are decided on this text rather than on the
	// project pair it resolves to, which is why the record keeps it.
	Specifier string `json:"specifier"`
	// Kind is the form the import takes.
	Kind ImportKind `json:"kind"`
	// Spelling is how the specifier is spelled.
	Spelling Spelling `json:"spelling"`
	// Resolved is where it points, or nil when the analyzer could not say. nil is
	// a recorded blind spot, never a dropped record and never a guess.
	Resolved *Resolved `json:"resolved"`
}

// Position is this site's position, ready to hand to [Finding.At], and whether
// there is one.
//
// ok is false when either coordinate is zero, which the engine never emits —
// every position this tool reports is 1-based
// (../lattice/src/analysis/contract.md). Rust spells the same guarantee as an
// Option of two NonZeroU32 and gets it from the type system
// (../lattice-rule-sdk-rust/src/evidence.rs); Go has no non-zero integer, so
// the check is here and [Finding.At] refuses a zero a second time. Returning
// ok=false rather than clamping keeps a malformed bundle from producing a
// finding that points at a line no file has.
func (r *ImportRecord) Position() (line, column uint32, ok bool) {
	if r.Line == 0 || r.Column == 0 {
		return 0, 0, false
	}
	return r.Line, r.Column, true
}

// Policy is the `policy` kind: the two fields contract 1 carries of a loaded
// policy.
//
// Both are raw JSON, and that is a decision rather than laziness. The
// constraint row schema has exactly one owner (../lattice/src/config.mjs, which
// validates it at load), and a second model of it here would be a dialect: it
// would drift the first time a governance key was added, and a rule reading
// through it would be judging a policy the engine had already read differently.
type Policy struct {
	// DepConstraints are the constraint rows, in the order the workspace wrote
	// them — order is semantic for a boundary policy, so the engine deliberately
	// does not sort this array.
	DepConstraints []json.RawMessage `json:"depConstraints"`
	// ModuleBoundaryOptions are the eight @nx/enforce-module-boundaries settings,
	// as the workspace stated them.
	ModuleBoundaryOptions json.RawMessage `json:"moduleBoundaryOptions"`
}

// EvidenceError is why an evidence bundle could not be read.
//
// Both shapes end the same way — an unknown verdict naming the cause
// ([EvaluateJSON]) — but they are separate accusations: one says the bytes are
// not the document, the other says the document is not this contract. Stated as
// one type with a nil Cause rather than two, because a caller separates them by
// reading Cause and Stated, and two types would need two errors.As arms for a
// difference the message already carries.
type EvidenceError struct {
	// Stated is the contract version the bundle stated, when that is the
	// complaint. Zero when it is not.
	Stated int
	// Cause is the decoding failure, when that is the complaint. nil when it is
	// not.
	Cause error
}

// Error names what went wrong, in the sentence the rule's unknown verdict
// carries.
func (e *EvidenceError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf(
			"the evidence bundle could not be read as contract %d (%s)", Contract, e.Cause.Error())
	}
	return fmt.Sprintf(
		"the evidence bundle states contract %d and this rule was built against contract %d — a "+
			"rule built for another contract is not approximated", e.Stated, Contract)
}

// Unwrap is the decoding failure underneath, when there was one.
func (e *EvidenceError) Unwrap() error { return e.Cause }

// ReadEvidence reads a bundle from the bytes the host wrote into linear memory.
//
// Neither failure is recoverable inside a rule, and neither may be read as
// "nothing found".
func ReadEvidence(data []byte) (*Evidence, error) {
	var bundle Evidence
	if err := json.Unmarshal(data, &bundle); err != nil {
		return nil, &EvidenceError{Cause: err}
	}
	if bundle.Contract != Contract {
		return nil, &EvidenceError{Stated: bundle.Contract}
	}
	return &bundle, nil
}

// ReadParams decodes the rule row's params into the author's own type.
//
// The typed read is the idiomatic one in Go and the one
// examples/forbidden_tag_dependency uses: a struct with json tags says which
// parameters a rule takes, and a row that states a number where the rule wants
// a string fails here rather than reading as absent. A rule that wants the raw
// document still has [RuleInstance.Params].
//
// The error it returns is what an author turns into an unknown verdict naming
// what the row should have said. A missing or mistyped parameter must never
// become a pass.
func (e *Evidence) ReadParams(target any) error {
	// The engine always writes an object here, `{}` at the least. Absent and null
	// are both refused rather than decoded: json.Unmarshal reads null into a
	// struct as a no-op that leaves every field at its zero value, which a rule
	// cannot tell from a row that declared those values — the silent direction,
	// and the one place this method has to be louder than encoding/json is.
	if len(e.Rule.Params) == 0 || string(e.Rule.Params) == "null" {
		return fmt.Errorf(
			"the evidence bundle carries no rule.params — the engine writes {} for a row that " +
				"declares none, so an absent one is a bundle this rule cannot read")
	}
	return json.Unmarshal(e.Rule.Params, target)
}

// Project is the project of this name, and whether the model declares one.
//
// ok=false is the case a rule has to answer for rather than skip: an edge
// naming a project the model does not carry means the two halves of the
// evidence disagree, and a rule that silently ignored the edge would be
// reporting a clean workspace it never finished reading.
func (e *Evidence) Project(name string) (*Project, bool) {
	for index := range e.Model.Projects {
		if e.Model.Projects[index].Name == name {
			return &e.Model.Projects[index], true
		}
	}
	return nil, false
}

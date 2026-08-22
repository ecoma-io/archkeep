// The reference rule: no project may depend on a project carrying a forbidden
// tag, unless it carries one of the tags the row exempts.
//
// It exists to be built, committed and RUN — ../forbidden_tag_dependency.wasm
// is the artifact, ../forbidden_tag_dependency.wasm.sha256 is the digest a
// customRules row pins it by, and ./golden_test.go replays the fixtures in
// ../../fixtures/ against it. ../../README.md holds the rebuild command and the
// argument for committing a binary at all.
//
// # What it is a reference OF
//
// Four verdicts, each reachable, because a rule that can only pass and fail has
// no way to say it could not look:
//
//   - fail — an edge lands on a project carrying the forbidden tag, and the
//     depending project is not exempt. Every finding names the pair and, when
//     the graph carried one, the file the edge was read from.
//   - pass — every edge was read and none of them crossed.
//   - not_applicable — no project in the workspace carries the tag at all, so
//     the rule constrains nothing here. Reported rather than absorbed into a
//     passing count: a rule nobody is protected by must be visible.
//   - unknown — the parameters are not there to read, or the graph names a
//     project the model does not declare. Both are cases where the honest
//     answer is that this run reached no verdict; answering pass would be a
//     clean workspace nobody earned.
//
// # The policy row it is declared by
//
//	{
//	  "name": "forbidden-tag-dependency",
//	  "artifact": "tools/rules/forbidden_tag_dependency.wasm",
//	  "sha256": "<the contents of forbidden_tag_dependency.wasm.sha256>",
//	  "params": { "forbiddenTag": "layer-infrastructure", "exemptTags": ["layer-adapter"] },
//	  "reason": "..."
//	}
//
// # It is the same shape an author's own rule is
//
// Everything below is what a rule author writes and nothing else: a params
// struct, an evaluate function, a Register call from init, and an empty main
// that is never called. The four ABI exports are in the SDK
// (../../abi_freestanding.go), so no shell appears here.
package main

import (
	"fmt"

	latticerule "github.com/ecoma-io/lattice/packages/lattice-rule-sdk-go"
)

// params is what a policy row declares for this rule.
//
// A struct with json tags rather than a hand-walk of the raw document, which is
// what the Rust binding's example does (../../../lattice-rule-sdk-rust/examples/forbidden_tag_dependency.rs)
// because that avoids a serde derive in an author's crate. Go's encoding/json
// needs no derive, so the typed read is both shorter and stricter here: a row
// that writes a number where this rule wants a tag fails to decode rather than
// reading as absent.
type params struct {
	// ForbiddenTag is the tag whose incoming dependencies this rule refuses.
	ForbiddenTag string `json:"forbiddenTag"`
	// ExemptTags are tags that excuse a depending project from the rule.
	ExemptTags []string `json:"exemptTags"`
}

func evaluate(evidence *latticerule.Evidence) latticerule.Verdict {
	var declared params
	if err := evidence.ReadParams(&declared); err != nil {
		return latticerule.Unknown(fmt.Sprintf(
			"params could not be read as this rule's parameters (%v), so neither which tag is "+
				"forbidden nor which projects are excused can be established", err))
	}
	if declared.ForbiddenTag == "" {
		return latticerule.Unknown(
			"params.forbiddenTag is not a non-empty string, so there is no tag to judge " +
				"dependencies against — the rule read nothing and concluded nothing")
	}

	carried := false
	for index := range evidence.Model.Projects {
		if evidence.Model.Projects[index].HasTag(declared.ForbiddenTag) {
			carried = true
			break
		}
	}
	if !carried {
		return latticerule.NotApplicable(fmt.Sprintf(
			"no project in this workspace carries %q, so there is no dependency this rule could "+
				"forbid", declared.ForbiddenTag))
	}

	var findings []latticerule.Finding
	for _, edge := range evidence.Graph.Edges {
		target, ok := evidence.Project(edge.Target)
		if !ok {
			return latticerule.Unknown(fmt.Sprintf(
				"the graph carries an edge into %q, which the model does not declare — the two "+
					"halves of the evidence disagree, and a rule cannot tell whether a project it "+
					"cannot see carries the tag", edge.Target))
		}
		if !target.HasTag(declared.ForbiddenTag) {
			continue
		}

		source, ok := evidence.Project(edge.Source)
		if !ok {
			return latticerule.Unknown(fmt.Sprintf(
				"the graph carries an edge out of %q, which the model does not declare — the two "+
					"halves of the evidence disagree, and a rule cannot tell whether a project it "+
					"cannot see is exempt", edge.Source))
		}
		if exempt(source, declared.ExemptTags) {
			continue
		}

		finding := latticerule.NewFinding("dependency-on-forbidden-tag", fmt.Sprintf(
			"%s depends on %s, which carries %q", source.Name, target.Name, declared.ForbiddenTag)).
			InProject(source.Name)
		// The file only when the graph carried one: an edge has no line, and a
		// position invented to fill the shape sends a reader somewhere the
		// dependency is not.
		if edge.SourceFile != nil {
			finding = finding.InFile(*edge.SourceFile)
		}
		findings = append(findings, finding)
	}

	return latticerule.FromFindings(findings)
}

// exempt reports whether project carries any of the tags the row excuses.
func exempt(project *latticerule.Project, tags []string) bool {
	for _, tag := range tags {
		if project.HasTag(tag) {
			return true
		}
	}
	return false
}

func init() {
	latticerule.Register(latticerule.Rule{
		Name:  "forbidden-tag-dependency",
		Needs: []latticerule.EvidenceKind{latticerule.KindModel, latticerule.KindGraph},
		Findings: []latticerule.CatalogueEntry{{
			ID:      "dependency-on-forbidden-tag",
			Message: "a project depends on a project carrying the forbidden tag",
		}},
		Evaluate: evaluate,
	})
}

// main is never called.
//
// A rule module has no entry point — the host calls the four ABI exports and
// nothing else (../../../lattice/src/custom-rules/host.mjs) — but Go has no way
// to spell a buildable command without a main, and TinyGo builds a command.
// The empty body is that requirement and nothing more.
func main() {}

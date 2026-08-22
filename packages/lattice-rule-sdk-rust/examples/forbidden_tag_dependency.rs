//! The reference rule: **no project may depend on a project carrying a
//! forbidden tag**, unless it carries one of the tags the row exempts.
//!
//! It exists to be built, committed and RUN — `forbidden_tag_dependency.wasm`
//! beside this file is the artifact, `forbidden_tag_dependency.wasm.sha256` is
//! the digest a `customRules` row pins it by, and `../tests/golden.rs` replays
//! the fixtures in `../fixtures/` against it. `../README.md` holds the rebuild
//! command and the argument for committing a binary at all.
//!
//! ## What it is a reference OF
//!
//! Four verdicts, each reachable, because a rule that can only pass and fail
//! has no way to say it could not look:
//!
//! - `fail` — an edge lands on a project carrying the forbidden tag, and the
//!   depending project is not exempt. Every finding names the pair and, when
//!   the graph carried one, the file the edge was read from.
//! - `pass` — every edge was read and none of them crossed.
//! - `not_applicable` — no project in the workspace carries the tag at all, so
//!   the rule constrains nothing here. Reported rather than absorbed into a
//!   passing count: a rule nobody is protected by must be visible.
//! - `unknown` — the parameters are not there to read, or the graph names a
//!   project the model does not declare. Both are cases where the honest answer
//!   is that this run reached no verdict; answering `pass` would be a clean
//!   workspace nobody earned.
//!
//! ## The policy row it is declared by
//!
//! ```jsonc
//! {
//!   "name": "forbidden-tag-dependency",
//!   "artifact": "tools/rules/forbidden_tag_dependency.wasm",
//!   "sha256": "<the contents of forbidden_tag_dependency.wasm.sha256>",
//!   "params": { "forbiddenTag": "layer-infrastructure", "exemptTags": ["layer-adapter"] },
//!   "reason": "..."
//! }
//! ```

use lattice_rule_sdk::serde_json::Value;
use lattice_rule_sdk::{Evidence, Finding, Verdict, lattice_rule};

/// The tag whose incoming dependencies this rule refuses.
const FORBIDDEN_TAG: &str = "forbiddenTag";
/// Tags that excuse a depending project from the rule.
const EXEMPT_TAGS: &str = "exemptTags";

fn evaluate(evidence: &Evidence) -> Verdict {
    let Some(forbidden_tag) = evidence
        .rule
        .params
        .get(FORBIDDEN_TAG)
        .and_then(Value::as_str)
        .filter(|tag| !tag.is_empty())
    else {
        return Verdict::unknown(format!(
            "params.{FORBIDDEN_TAG} is not a non-empty string, so there is no tag to judge \
             dependencies against — the rule read nothing and concluded nothing"
        ));
    };

    let exempt_tags = match evidence.rule.params.get(EXEMPT_TAGS) {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(values)) => {
            let mut tags = Vec::with_capacity(values.len());
            for value in values {
                let Some(tag) = value.as_str() else {
                    return Verdict::unknown(format!(
                        "params.{EXEMPT_TAGS} carries an entry that is not a string, so which \
                         projects are excused cannot be established"
                    ));
                };
                tags.push(tag);
            }
            tags
        }
        Some(_) => {
            return Verdict::unknown(format!(
                "params.{EXEMPT_TAGS} is not an array of tags, so which projects are excused \
                 cannot be established"
            ));
        }
    };

    if !evidence
        .model
        .projects
        .iter()
        .any(|project| project.has_tag(forbidden_tag))
    {
        return Verdict::not_applicable(format!(
            "no project in this workspace carries \"{forbidden_tag}\", so there is no dependency \
             this rule could forbid"
        ));
    }

    let mut findings = Vec::new();
    for edge in &evidence.graph.edges {
        let Some(target) = evidence.project(&edge.target) else {
            return Verdict::unknown(format!(
                "the graph carries an edge into \"{}\", which the model does not declare — the \
                 two halves of the evidence disagree, and a rule cannot tell whether a project it \
                 cannot see carries the tag",
                edge.target
            ));
        };
        if !target.has_tag(forbidden_tag) {
            continue;
        }

        let Some(source) = evidence.project(&edge.source) else {
            return Verdict::unknown(format!(
                "the graph carries an edge out of \"{}\", which the model does not declare — the \
                 two halves of the evidence disagree, and a rule cannot tell whether a project it \
                 cannot see is exempt",
                edge.source
            ));
        };
        if exempt_tags.iter().any(|tag| source.has_tag(tag)) {
            continue;
        }

        let finding = Finding::new(
            "dependency-on-forbidden-tag",
            format!(
                "{} depends on {}, which carries \"{forbidden_tag}\"",
                source.name, target.name
            ),
        )
        .in_project(&source.name);
        // The file only when the graph carried one: an edge has no line, and a
        // position invented to fill the shape sends a reader somewhere the
        // dependency is not.
        findings.push(match &edge.source_file {
            Some(source_file) => finding.in_file(source_file),
            None => finding,
        });
    }

    Verdict::from_findings(findings)
}

lattice_rule! {
    name: "forbidden-tag-dependency",
    needs: [model, graph],
    findings: [(
        "dependency-on-forbidden-tag",
        "a project depends on a project carrying the forbidden tag",
    )],
    evaluate: evaluate,
}

//! **Forbidden tag combination**: forbids projects from carrying a set of tags together.
//!
//! Four verdicts, each reachable:
//!
//! - `fail` — a project carries ALL of the forbidden tags. Every finding names
//!   the project and the combination.
//! - `pass` — no project carries the full combination.
//! - `not_applicable` — no project in the workspace carries ANY of the tags,
//!   so the rule constrains nothing here.
//! - `unknown` — parameters are malformed or an unknown key is present.
//!
//! ## The policy row it is declared by
//!
//! ```jsonc
//! {
//!   "name": "forbidden-tag-combination",
//!   "artifact": "tools/rules/forbidden-tag-combination.wasm",
//!   "sha256": "<the contents of rules/forbidden-tag-combination.wasm.sha256>",
//!   "params": {
//!     "tags": ["layer:infrastructure", "type:library"]
//!   },
//!   "reason": "..."
//! }
//! ```

use archkeep_rule_sdk::{Evidence, Finding, Verdict, archkeep_rule};
use archkeep_rules::params::{require_unique_strings, validate_keys};

const TAGS: &str = "tags";

fn evaluate(evidence: &Evidence) -> Verdict {
    if let Err(e) = validate_keys(&evidence.rule.params, &[TAGS]) {
        return Verdict::unknown(e);
    }

    let tags = match require_unique_strings(&evidence.rule.params, TAGS) {
        Ok(t) => t,
        Err(e) => return Verdict::unknown(e),
    };

    // Check whether any project in the workspace carries ANY of the tags
    let any_carries = evidence
        .model
        .projects
        .iter()
        .any(|project| tags.iter().any(|tag| project.has_tag(tag)));

    let listed = tags.join(", ");
    if !any_carries {
        return Verdict::not_applicable(format!(
            "no project in this workspace carries any of [{listed}], so the rule constrains nothing"
        ));
    }

    let mut findings = Vec::new();
    for project in &evidence.model.projects {
        // Check if the project carries ALL of the forbidden tags
        if tags.iter().all(|tag| project.has_tag(tag)) {
            findings.push(
                Finding::new(
                    "forbidden-tag-combination",
                    format!(
                        "{} carries the forbidden combination [{listed}]",
                        project.name
                    ),
                )
                .in_project(&project.name),
            );
        }
    }

    Verdict::from_findings(findings)
}

archkeep_rule! {
    name: "forbidden-tag-combination",
    needs: [model],
    findings: [
        (
            "forbidden-tag-combination",
            "a project carries a forbidden combination of tags"
        ),
    ],
    evaluate: evaluate,
}

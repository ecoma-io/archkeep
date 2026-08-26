//! **Max fan-out**: a project may not depend on more distinct projects than a declared budget.
//!
//! Four verdicts, each reachable:
//!
//! - `fail` — an in-scope project declares more distinct dependencies than the
//!   budget. Every finding names the project, the count, and the budget.
//! - `pass` — every in-scope project is at or under the budget.
//! - `not_applicable` — no project is in scope (no project carries all the
//!   `match` tags, or the workspace has no projects at all).
//! - `unknown` — parameters are malformed, an unknown key is present, or the
//!   graph names a project the model does not declare.
//!
//! ## The policy row it is declared by
//!
//! ```jsonc
//! {
//!   "name": "max-fan-out",
//!   "artifact": "tools/rules/max-fan-out.wasm",
//!   "sha256": "<the contents of rules/max-fan-out.wasm.sha256>",
//!   "params": {
//!     "max": 2,
//!     "match": ["scope:shared"]
//!   },
//!   "reason": "..."
//! }
//! ```

use archkeep_rule_sdk::{Evidence, Finding, Verdict, archkeep_rule};
use archkeep_rules::params::{optional_unique_strings, require_non_negative_number, validate_keys};
use archkeep_rules::topology::fan_out;

const MAX: &str = "max";
const MATCH: &str = "match";

fn evaluate(evidence: &Evidence) -> Verdict {
    if let Err(e) = validate_keys(&evidence.rule.params, &[MAX, MATCH]) {
        return Verdict::unknown(e);
    }

    let max = match require_non_negative_number(&evidence.rule.params, MAX) {
        Ok(m) => m,
        Err(e) => return Verdict::unknown(e),
    };

    let match_tags = match optional_unique_strings(&evidence.rule.params, MATCH) {
        Ok(m) => m.unwrap_or_default(),
        Err(e) => return Verdict::unknown(e),
    };

    // Run the topology evaluator to compute per-project fan-out counts.
    // An Err here means an edge names an undeclared project — model/graph
    // disagreement is `unknown`, never a count computed over half a graph.
    let fan_outs = match fan_out(&evidence.model.projects, &evidence.graph.edges) {
        Ok(counts) => counts,
        Err(e) => return Verdict::unknown(e),
    };

    // Projects in scope: those carrying ALL tags in `match` (or all projects if match is empty)
    let in_scope: Vec<_> = evidence
        .model
        .projects
        .iter()
        .filter(|project| {
            match_tags.is_empty() || match_tags.iter().all(|tag| project.has_tag(tag))
        })
        .collect();

    if in_scope.is_empty() {
        if match_tags.is_empty() {
            // Absent match and an empty workspace — still not_applicable
            return Verdict::not_applicable(
                "no project exists in this workspace, so the rule constrains nothing",
            );
        }
        let listed = match_tags.join(", ");
        return Verdict::not_applicable(format!(
            "no project carries all of the match tags [{listed}], so the rule constrains nothing"
        ));
    }

    let mut findings = Vec::new();
    for project in &in_scope {
        // Find the fan-out count for this project (the evaluator preserves model order)
        let count = fan_outs
            .iter()
            .find(|(p, _, _)| p.name == project.name)
            .map(|(_, count, _)| *count)
            .unwrap_or(0);

        if count > max as usize {
            findings.push(
                Finding::new(
                    "fan-out-budget-exceeded",
                    format!(
                        "{} declares {} distinct dependencies, above the budget of {}",
                        project.name, count, max
                    ),
                )
                .in_project(&project.name),
            );
        }
    }

    Verdict::from_findings(findings)
}

archkeep_rule! {
    name: "max-fan-out",
    needs: [model, graph],
    findings: [
        (
            "fan-out-budget-exceeded",
            "a project depends on more distinct projects than the declared budget"
        ),
    ],
    evaluate: evaluate,
}

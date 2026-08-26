//! **Tag cardinality**: constrains how many distinct axis values a project may carry.
//!
//! Four verdicts, each reachable:
//!
//! - `fail` — a project in scope carries fewer than `min` or more than `max`
//!   distinct axis values. Every finding names the project, the count, and the
//!   bound it violated.
//! - `pass` — all in-scope projects are within range.
//! - `not_applicable` — no project carries all tags in `match` (if present),
//!   so the rule constrains nothing here.
//! - `unknown` — parameters are malformed or an unknown key is present.
//!
//! ## The policy row it is declared by
//!
//! ```jsonc
//! {
//!   "name": "tag-cardinality",
//!   "artifact": "tools/rules/tag-cardinality.wasm",
//!   "sha256": "<the contents of rules/tag-cardinality.wasm.sha256>",
//!   "params": {
//!     "axis": "type",
//!     "min": 1,
//!     "max": 2,
//!     "match": ["layer:application"]
//!   },
//!   "reason": "..."
//! }
//! ```

use archkeep_rule_sdk::{Evidence, Finding, Verdict, archkeep_rule};
use archkeep_rules::axis_value;
use archkeep_rules::params::{
    optional_non_negative_number, optional_unique_strings, require_non_empty_str, validate_keys,
};

const AXIS: &str = "axis";
const MIN: &str = "min";
const MAX: &str = "max";
const MATCH: &str = "match";

fn evaluate(evidence: &Evidence) -> Verdict {
    if let Err(e) = validate_keys(&evidence.rule.params, &[AXIS, MIN, MAX, MATCH]) {
        return Verdict::unknown(e);
    }

    let axis = match require_non_empty_str(&evidence.rule.params, AXIS) {
        Ok(a) => a,
        Err(e) => return Verdict::unknown(e),
    };

    let min = match optional_non_negative_number(&evidence.rule.params, MIN) {
        Ok(m) => m,
        Err(e) => return Verdict::unknown(e),
    };

    let max = match optional_non_negative_number(&evidence.rule.params, MAX) {
        Ok(m) => m,
        Err(e) => return Verdict::unknown(e),
    };

    if min.is_none() && max.is_none() {
        return Verdict::unknown(
            "at least one of params.min or params.max must be present, so there is no \
             range to judge against",
        );
    }

    if let (Some(min_val), Some(max_val)) = (min, max) {
        if min_val > max_val {
            return Verdict::unknown(format!(
                "params.{MIN} ({min_val}) is greater than params.{MAX} ({max_val})"
            ));
        }
    }

    let match_tags = match optional_unique_strings(&evidence.rule.params, MATCH) {
        Ok(m) => m.unwrap_or_default(),
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
        // Count DISTINCT axis values among the project's tags
        let mut seen = std::collections::HashSet::new();
        for tag in &project.tags {
            if let Some(value) = axis_value(tag, &axis) {
                seen.insert(value);
            }
        }
        let count = seen.len();

        if let Some(min_val) = min {
            if count < min_val as usize {
                findings.push(
                    Finding::new(
                        "tag-cardinality-below-minimum",
                        format!(
                            "{} has {count} distinct {axis} value(s), below the minimum {min_val}",
                            project.name
                        ),
                    )
                    .in_project(&project.name),
                );
            }
        }

        if let Some(max_val) = max {
            if count > max_val as usize {
                findings.push(
                    Finding::new(
                        "tag-cardinality-above-maximum",
                        format!(
                            "{} has {count} distinct {axis} value(s), above the maximum {max_val}",
                            project.name
                        ),
                    )
                    .in_project(&project.name),
                );
            }
        }
    }

    Verdict::from_findings(findings)
}

archkeep_rule! {
    name: "tag-cardinality",
    needs: [model],
    findings: [
        (
            "tag-cardinality-below-minimum",
            "a project carries fewer distinct axis values than the minimum"
        ),
        (
            "tag-cardinality-above-maximum",
            "a project carries more distinct axis values than the maximum"
        ),
    ],
    evaluate: evaluate,
}

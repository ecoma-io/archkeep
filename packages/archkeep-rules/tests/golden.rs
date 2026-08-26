//! The golden suite: every fixture in `../fixtures/`, replayed against the
//! rule it belongs to, with the verdict each one must produce.
//!
//! The rules are reached through `#[path]` rather than through the built
//! artifact, because a `.wasm` file cannot be instantiated from a Rust test
//! without a runtime this crate refuses to depend on (the same refusal the
//! SDK's own `tests/golden.rs` records). What that leaves unproven — that the
//! ABI shell around this same code works — is proven instead by
//! `./artifact.rs` on the committed bytes and by
//! `../../archkeep/src/conformance/official-rules.integration.test.mjs`,
//! which drives those bytes through the engine's real host.
//!
//! Every fixture's expected document pins the full verdict JSON, `reason` and
//! `notApplicableReason` included: a reason string that drifted is a reason a
//! consumer can no longer grep for, and an expectation that only checked the
//! verdict word would let exactly that drift through.

#[path = "../examples/forbidden_tag_combination.rs"]
mod forbidden_tag_combination;
#[path = "../examples/max_fan_in.rs"]
mod max_fan_in;
#[path = "../examples/max_fan_out.rs"]
mod max_fan_out;
#[path = "../examples/tag_cardinality.rs"]
mod tag_cardinality;

use archkeep_rule_sdk::harness::expect_verdict;

/// A fixture, by rule and name, resolved from the manifest rather than from
/// the working directory — `cargo test` and `moon run …:test` need not agree
/// about cwd.
macro_rules! fixture {
    ($rule:literal, $name:literal) => {
        concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/", $rule, "/", $name)
    };
}

// --- tag-cardinality -------------------------------------------------------

#[test]
fn the_declaration_is_the_document_the_host_reads() {
    assert_eq!(
        tag_cardinality::archkeep_describe_json(),
        r#"{"contract":1,"name":"tag-cardinality","needs":["model"],"findings":[{"id":"tag-cardinality-below-minimum","message":"a project carries fewer distinct axis values than the minimum"},{"id":"tag-cardinality-above-maximum","message":"a project carries more distinct axis values than the maximum"}]}"#
    );
    assert_eq!(
        forbidden_tag_combination::archkeep_describe_json(),
        r#"{"contract":1,"name":"forbidden-tag-combination","needs":["model"],"findings":[{"id":"forbidden-tag-combination","message":"a project carries a forbidden combination of tags"}]}"#
    );
    assert_eq!(
        max_fan_out::archkeep_describe_json(),
        r#"{"contract":1,"name":"max-fan-out","needs":["model","graph"],"findings":[{"id":"fan-out-budget-exceeded","message":"a project depends on more distinct projects than the declared budget"}]}"#
    );
    assert_eq!(
        max_fan_in::archkeep_describe_json(),
        r#"{"contract":1,"name":"max-fan-in","needs":["model","graph"],"findings":[{"id":"fan-in-budget-exceeded","message":"a project is depended on by more distinct projects than the declared budget"}]}"#
    );
}

#[test]
fn a_project_below_the_minimum_fails_and_names_the_count() {
    expect_verdict(
        fixture!("tag-cardinality", "below-minimum.json"),
        tag_cardinality::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "fail",
            "findings": [{
                "id": "tag-cardinality-below-minimum",
                "message": "delta has 0 distinct type value(s), below the minimum 1",
                "project": "delta"
            }]
        }"#,
    );
}

#[test]
fn a_project_above_the_maximum_fails_and_names_the_count() {
    expect_verdict(
        fixture!("tag-cardinality", "above-maximum.json"),
        tag_cardinality::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "fail",
            "findings": [{
                "id": "tag-cardinality-above-maximum",
                "message": "beta has 2 distinct type value(s), above the maximum 1",
                "project": "beta"
            }]
        }"#,
    );
}

#[test]
fn a_workspace_inside_the_range_passes() {
    expect_verdict(
        fixture!("tag-cardinality", "within-range.json"),
        tag_cardinality::archkeep_evaluate_json,
        r#"{ "contract": 1, "verdict": "pass", "findings": [] }"#,
    );
}

#[test]
fn a_workspace_no_project_of_the_match_scope_covers_is_not_applicable() {
    expect_verdict(
        fixture!("tag-cardinality", "no-matching-projects.json"),
        tag_cardinality::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "not_applicable",
            "findings": [],
            "notApplicableReason": "no project carries all of the match tags [scope:shared], so the rule constrains nothing"
        }"#,
    );
}

#[test]
fn params_without_an_axis_are_unknown_not_a_pass() {
    expect_verdict(
        fixture!("tag-cardinality", "malformed-params.json"),
        tag_cardinality::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "unknown",
            "findings": [],
            "reason": "params.axis is not a non-empty string"
        }"#,
    );
}

#[test]
fn a_typoed_param_key_is_unknown_not_judged_with_defaults() {
    expect_verdict(
        fixture!("tag-cardinality", "unknown-param-key.json"),
        tag_cardinality::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "unknown",
            "findings": [],
            "reason": "unknown key: maximum"
        }"#,
    );
}

#[test]
fn an_empty_match_array_is_malformed_rather_than_every_project() {
    // `match: []` read as "no restriction" would judge projects the author
    // meant to exclude — the quiet direction — so it must be unknown.
    let mut bundle: serde_json::Value = serde_json::from_slice(
        &std::fs::read(fixture!("tag-cardinality", "within-range.json")).expect("a fixture"),
    )
    .expect("a bundle");
    bundle["rule"]["params"]["match"] = serde_json::json!([]);
    let document =
        tag_cardinality::archkeep_evaluate_json(serde_json::to_string(&bundle).unwrap().as_bytes());
    let parsed: serde_json::Value = serde_json::from_str(&document).expect("a verdict document");
    assert_eq!(parsed["verdict"], "unknown");
    assert!(
        parsed["reason"].as_str().unwrap().contains("empty array"),
        "the reason must name the empty array, got: {document}"
    );
}

#[test]
fn a_range_with_min_above_max_is_unknown_not_judged() {
    let mut bundle: serde_json::Value = serde_json::from_slice(
        &std::fs::read(fixture!("tag-cardinality", "within-range.json")).expect("a fixture"),
    )
    .expect("a bundle");
    bundle["rule"]["params"] = serde_json::json!({"axis": "layer", "min": 3, "max": 1});
    let document =
        tag_cardinality::archkeep_evaluate_json(serde_json::to_string(&bundle).unwrap().as_bytes());
    let parsed: serde_json::Value = serde_json::from_str(&document).expect("a verdict document");
    assert_eq!(parsed["verdict"], "unknown");
    assert!(
        parsed["reason"].as_str().unwrap().contains("greater than"),
        "the reason must name the inverted range, got: {document}"
    );
}

#[test]
fn duplicate_axis_values_on_one_project_count_once() {
    // A project tagged layer:domain twice has ONE distinct layer value —
    // cardinality is about values, not tag entries.
    let mut bundle: serde_json::Value = serde_json::from_slice(
        &std::fs::read(fixture!("tag-cardinality", "above-maximum.json")).expect("a fixture"),
    )
    .expect("a bundle");
    bundle["model"]["projects"][1]["tags"] =
        serde_json::json!(["layer:application", "type:library", "type:library"]);
    let document =
        tag_cardinality::archkeep_evaluate_json(serde_json::to_string(&bundle).unwrap().as_bytes());
    let parsed: serde_json::Value = serde_json::from_str(&document).expect("a verdict document");
    assert_eq!(
        parsed["verdict"], "pass",
        "duplicate type:library counts once: {document}"
    );
}

#[test]
fn a_workspace_with_no_projects_at_all_is_not_applicable() {
    let mut bundle: serde_json::Value = serde_json::from_slice(
        &std::fs::read(fixture!("tag-cardinality", "within-range.json")).expect("a fixture"),
    )
    .expect("a bundle");
    bundle["model"]["projects"] = serde_json::json!([]);
    bundle["graph"]["edges"] = serde_json::json!([]);
    bundle["imports"] = serde_json::json!([]);
    let document =
        tag_cardinality::archkeep_evaluate_json(serde_json::to_string(&bundle).unwrap().as_bytes());
    let parsed: serde_json::Value = serde_json::from_str(&document).expect("a verdict document");
    assert_eq!(parsed["verdict"], "not_applicable");
}

#[test]
fn every_project_with_exactly_one_tag_on_min_equals_max_passes() {
    expect_verdict(
        fixture!("tag-cardinality", "exactly-min-and-max.json"),
        tag_cardinality::archkeep_evaluate_json,
        r#"{ "contract": 1, "verdict": "pass", "findings": [] }"#,
    );
}

#[test]
fn zero_scope_values_at_zero_minimum_passes() {
    expect_verdict(
        fixture!("tag-cardinality", "zero-values-at-zero-minimum.json"),
        tag_cardinality::archkeep_evaluate_json,
        r#"{ "contract": 1, "verdict": "pass", "findings": [] }"#,
    );
}

// --- forbidden-tag-combination ---------------------------------------------

#[test]
fn a_project_carrying_the_whole_combination_fails() {
    expect_verdict(
        fixture!(
            "forbidden-tag-combination",
            "project-carries-the-combination.json"
        ),
        forbidden_tag_combination::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "fail",
            "findings": [{
                "id": "forbidden-tag-combination",
                "message": "beta carries the forbidden combination [layer:infrastructure, type:library]",
                "project": "beta"
            }]
        }"#,
    );
}

#[test]
fn partial_carriers_do_not_fail() {
    expect_verdict(
        fixture!("forbidden-tag-combination", "no-project-carries-all.json"),
        forbidden_tag_combination::archkeep_evaluate_json,
        r#"{ "contract": 1, "verdict": "pass", "findings": [] }"#,
    );
}

#[test]
fn a_workspace_where_no_project_carries_any_of_the_tags_is_not_applicable() {
    expect_verdict(
        fixture!("forbidden-tag-combination", "no-project-carries-any.json"),
        forbidden_tag_combination::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "not_applicable",
            "findings": [],
            "notApplicableReason": "no project in this workspace carries any of [scope:shared], so the rule constrains nothing"
        }"#,
    );
}

#[test]
fn params_where_tags_is_not_an_array_are_unknown() {
    expect_verdict(
        fixture!("forbidden-tag-combination", "malformed-params.json"),
        forbidden_tag_combination::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "unknown",
            "findings": [],
            "reason": "params.tags is not an array"
        }"#,
    );
}

#[test]
fn duplicate_tags_in_params_are_unknown_not_silently_deduplicated() {
    expect_verdict(
        fixture!("forbidden-tag-combination", "duplicate-tags-in-params.json"),
        forbidden_tag_combination::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "unknown",
            "findings": [],
            "reason": "params.tags contains duplicate entry: layer:domain"
        }"#,
    );
}

/// The one place the exact BYTES are pinned rather than the document — the
/// bytes are what crosses the ABI, and a serializer change that reordered a
/// key is still a change to what the host reads.
#[test]
fn the_verdict_bytes_are_the_ones_that_cross_the_abi() {
    let bundle =
        std::fs::read(fixture!("tag-cardinality", "below-minimum.json")).expect("a fixture");
    assert_eq!(
        tag_cardinality::archkeep_evaluate_json(&bundle),
        r#"{"contract":1,"verdict":"fail","findings":[{"id":"tag-cardinality-below-minimum","message":"delta has 0 distinct type value(s), below the minimum 1","project":"delta"}]}"#
    );
    let bundle = std::fs::read(fixture!(
        "forbidden-tag-combination",
        "project-carries-the-combination.json"
    ))
    .expect("a fixture");
    assert_eq!(
        forbidden_tag_combination::archkeep_evaluate_json(&bundle),
        r#"{"contract":1,"verdict":"fail","findings":[{"id":"forbidden-tag-combination","message":"beta carries the forbidden combination [layer:infrastructure, type:library]","project":"beta"}]}"#
    );
    let bundle = std::fs::read(fixture!("max-fan-out", "over-the-budget.json")).expect("a fixture");
    assert_eq!(
        max_fan_out::archkeep_evaluate_json(&bundle),
        r#"{"contract":1,"verdict":"fail","findings":[{"id":"fan-out-budget-exceeded","message":"over declares 3 distinct dependencies, above the budget of 2","project":"over"}]}"#
    );
    let bundle = std::fs::read(fixture!("max-fan-in", "over-the-budget.json")).expect("a fixture");
    assert_eq!(
        max_fan_in::archkeep_evaluate_json(&bundle),
        r#"{"contract":1,"verdict":"fail","findings":[{"id":"fan-in-budget-exceeded","message":"popular is depended on by 3 distinct projects, above the budget of 2","project":"popular"}]}"#
    );
}

// --- max-fan-in -----------------------------------------------------------

#[test]
fn a_project_over_the_fan_in_budget_fails() {
    expect_verdict(
        fixture!("max-fan-in", "over-the-budget.json"),
        max_fan_in::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "fail",
            "findings": [{
                "id": "fan-in-budget-exceeded",
                "message": "popular is depended on by 3 distinct projects, above the budget of 2",
                "project": "popular"
            }]
        }"#,
    );
}

#[test]
fn fan_in_all_projects_at_or_under_budget_pass() {
    expect_verdict(
        fixture!("max-fan-in", "exactly-at-the-budget.json"),
        max_fan_in::archkeep_evaluate_json,
        r#"{ "contract": 1, "verdict": "pass", "findings": [] }"#,
    );
}

#[test]
fn fan_in_duplicate_edges_from_same_source_count_once() {
    expect_verdict(
        fixture!("max-fan-in", "duplicate-edges-count-once.json"),
        max_fan_in::archkeep_evaluate_json,
        r#"{ "contract": 1, "verdict": "pass", "findings": [] }"#,
    );
}

#[test]
fn fan_in_no_project_carries_match_tags_is_not_applicable() {
    expect_verdict(
        fixture!("max-fan-in", "no-matching-projects.json"),
        max_fan_in::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "not_applicable",
            "findings": [],
            "notApplicableReason": "no project carries all of the match tags [scope:shared], so the rule constrains nothing"
        }"#,
    );
}

#[test]
fn fan_in_an_edge_from_an_undeclared_project_is_unknown() {
    expect_verdict(
        fixture!("max-fan-in", "edge-into-undeclared-project.json"),
        max_fan_in::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "unknown",
            "findings": [],
            "reason": "the graph carries an edge into \"ghost\", which the model does not declare"
        }"#,
    );
}

#[test]
fn fan_in_missing_max_param_is_unknown() {
    expect_verdict(
        fixture!("max-fan-in", "malformed-params.json"),
        max_fan_in::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "unknown",
            "findings": [],
            "reason": "params.max is required"
        }"#,
    );
}

#[test]
fn fan_in_a_typoed_param_key_is_unknown() {
    expect_verdict(
        fixture!("max-fan-in", "unknown-param-key.json"),
        max_fan_in::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "unknown",
            "findings": [],
            "reason": "unknown key: budget"
        }"#,
    );
}

// --- max-fan-out -----------------------------------------------------------

#[test]
fn a_project_over_the_fan_out_budget_fails() {
    expect_verdict(
        fixture!("max-fan-out", "over-the-budget.json"),
        max_fan_out::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "fail",
            "findings": [{
                "id": "fan-out-budget-exceeded",
                "message": "over declares 3 distinct dependencies, above the budget of 2",
                "project": "over"
            }]
        }"#,
    );
}

#[test]
fn all_projects_at_or_under_budget_pass() {
    expect_verdict(
        fixture!("max-fan-out", "exactly-at-the-budget.json"),
        max_fan_out::archkeep_evaluate_json,
        r#"{ "contract": 1, "verdict": "pass", "findings": [] }"#,
    );
}

#[test]
fn duplicate_edges_to_same_target_count_once() {
    expect_verdict(
        fixture!("max-fan-out", "duplicate-edges-count-once.json"),
        max_fan_out::archkeep_evaluate_json,
        r#"{ "contract": 1, "verdict": "pass", "findings": [] }"#,
    );
}

#[test]
fn no_project_carries_match_tags_is_not_applicable() {
    expect_verdict(
        fixture!("max-fan-out", "no-matching-projects.json"),
        max_fan_out::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "not_applicable",
            "findings": [],
            "notApplicableReason": "no project carries all of the match tags [scope:shared], so the rule constrains nothing"
        }"#,
    );
}

#[test]
fn an_edge_into_an_undeclared_project_is_unknown() {
    expect_verdict(
        fixture!("max-fan-out", "edge-into-undeclared-project.json"),
        max_fan_out::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "unknown",
            "findings": [],
            "reason": "the graph carries an edge into \"ghost\", which the model does not declare"
        }"#,
    );
}

#[test]
fn missing_max_param_is_unknown() {
    expect_verdict(
        fixture!("max-fan-out", "malformed-params.json"),
        max_fan_out::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "unknown",
            "findings": [],
            "reason": "params.max is required"
        }"#,
    );
}

#[test]
fn a_typoed_param_key_is_unknown() {
    expect_verdict(
        fixture!("max-fan-out", "unknown-param-key.json"),
        max_fan_out::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "unknown",
            "findings": [],
            "reason": "unknown key: budget"
        }"#,
    );
}

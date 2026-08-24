//! The golden suite: every fixture in `../fixtures/`, replayed against the
//! reference rule, with the verdict each one must produce.
//!
//! This is this crate's half of the shared conformance suite the ADR names as
//! the thing that holds four SDKs to one contract
//! (`../../../docs/adr/0002-custom-rules-one-contract.md`, "SDKs are
//! bindings"). The fixtures are not hand-written JSON that looks like a bundle:
//! they were produced by the engine's own `buildEvidenceBundle` and canonical
//! serializer (`../../archkeep/src/custom-rules/evidence.mjs`) and then
//! formatted for review, so what the rule parses here is what the host writes
//! into linear memory there.
//!
//! The rule is reached through `#[path]` rather than through the built
//! artifact, because a `.wasm` file cannot be instantiated from a Rust test
//! without a runtime this crate refuses to depend on. What that leaves
//! unproven — that the ABI shell around this same code works — is proven
//! instead by the committed artifact (`./artifact.rs`) and by driving it
//! through the real host, which `../README.md` records.

#[path = "../examples/forbidden_tag_dependency.rs"]
mod rule;

use archkeep_rule_sdk::harness::{expect_verdict, replay};

/// A fixture, by name, resolved from the manifest rather than from the working
/// directory — `cargo test` and `moon run …:test` need not agree about cwd.
macro_rules! fixture {
    ($name:literal) => {
        concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/", $name)
    };
}

#[test]
fn the_declaration_is_the_document_the_host_reads() {
    assert_eq!(
        rule::archkeep_describe_json(),
        r#"{"contract":1,"name":"forbidden-tag-dependency","needs":["model","graph"],"findings":[{"id":"dependency-on-forbidden-tag","message":"a project depends on a project carrying the forbidden tag"}]}"#
    );
}

#[test]
fn an_edge_into_the_forbidden_tag_fails_and_names_the_pair() {
    expect_verdict(
        fixture!("edge-into-forbidden-tag.json"),
        rule::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "fail",
            "findings": [{
                "id": "dependency-on-forbidden-tag",
                "message": "beta depends on gamma, which carries \"layer-infrastructure\"",
                "sourceFile": "packages/beta/src/store.rs",
                "project": "beta"
            }]
        }"#,
    );
}

/// The one place the exact BYTES are pinned rather than the document.
///
/// Everything else in this file compares parsed JSON, because key order is a
/// serializer's business and a conformance suite four SDKs must reproduce
/// cannot turn on one of them. This test exists anyway: the bytes are what
/// crosses the ABI, and a change that reordered or renamed a key would still be
/// a change to what the host reads.
#[test]
fn the_verdict_bytes_are_the_ones_that_cross_the_abi() {
    let bundle = std::fs::read(fixture!("edge-into-forbidden-tag.json")).expect("a fixture");
    assert_eq!(
        rule::archkeep_evaluate_json(&bundle),
        r#"{"contract":1,"verdict":"fail","findings":[{"id":"dependency-on-forbidden-tag","message":"beta depends on gamma, which carries \"layer-infrastructure\"","sourceFile":"packages/beta/src/store.rs","project":"beta"}]}"#
    );
}

#[test]
fn a_workspace_whose_edges_all_clear_the_tag_passes() {
    expect_verdict(
        fixture!("every-edge-clean.json"),
        rule::archkeep_evaluate_json,
        r#"{ "contract": 1, "verdict": "pass", "findings": [] }"#,
    );
}

#[test]
fn a_workspace_where_the_tag_appears_nowhere_is_not_applicable() {
    expect_verdict(
        fixture!("no-project-carries-the-tag.json"),
        rule::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "not_applicable",
            "findings": [],
            "notApplicableReason": "no project in this workspace carries \"layer-infrastructure\", so there is no dependency this rule could forbid"
        }"#,
    );
}

// The two cases below are the silent direction, and they are the reason this
// file is a suite rather than a demo. Both describe a run in which the rule
// could not reach a judgment; both would be indistinguishable from a clean
// workspace if they answered `pass`, and a workspace would go on believing a
// rule was enforcing something that had not run.

#[test]
fn a_row_that_names_no_tag_is_unknown_rather_than_clean() {
    expect_verdict(
        fixture!("params-without-the-tag.json"),
        rule::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "unknown",
            "findings": [],
            "reason": "params.forbiddenTag is not a non-empty string, so there is no tag to judge dependencies against — the rule read nothing and concluded nothing"
        }"#,
    );

    // Stated twice on purpose: the assertion above would still hold if
    // `expect_verdict` compared nothing, and this one would not.
    let verdict = replay(
        fixture!("params-without-the-tag.json"),
        rule::archkeep_evaluate_json,
    );
    assert_ne!(verdict["verdict"], "pass");
    assert_ne!(verdict["verdict"], "fail");
}

#[test]
fn an_edge_naming_a_project_the_model_lacks_is_unknown() {
    expect_verdict(
        fixture!("edge-into-an-undeclared-project.json"),
        rule::archkeep_evaluate_json,
        r#"{
            "contract": 1,
            "verdict": "unknown",
            "findings": [],
            "reason": "the graph carries an edge into \"epsilon\", which the model does not declare — the two halves of the evidence disagree, and a rule cannot tell whether a project it cannot see carries the tag"
        }"#,
    );
}

/// Every finding the suite produces resolves to a catalogue entry.
///
/// The host refuses a finding it cannot resolve, and this crate deliberately
/// does not repeat that check at runtime — so the place a typo'd id would
/// otherwise surface is a consumer's `check`. Here it is a red test instead.
#[test]
fn every_finding_the_fixtures_produce_is_in_the_catalogue() {
    let declared: Vec<&str> = rule::ARCHKEEP_RULE
        .findings
        .iter()
        .map(|entry| entry.id())
        .collect();
    let mut seen = 0;
    for fixture in [
        fixture!("edge-into-forbidden-tag.json"),
        fixture!("every-edge-clean.json"),
        fixture!("no-project-carries-the-tag.json"),
        fixture!("params-without-the-tag.json"),
        fixture!("edge-into-an-undeclared-project.json"),
    ] {
        for finding in replay(fixture, rule::archkeep_evaluate_json)["findings"]
            .as_array()
            .expect("every verdict states its findings")
        {
            let id = finding["id"].as_str().expect("a finding names its id");
            assert!(
                declared.contains(&id),
                "{fixture} produced the undeclared id {id}"
            );
            seen += 1;
        }
    }
    // Without this the test passes over a suite that produced no finding at
    // all, which is exactly the shape it is meant to catch.
    assert!(
        seen > 0,
        "no fixture produced a finding, so nothing was checked"
    );
}

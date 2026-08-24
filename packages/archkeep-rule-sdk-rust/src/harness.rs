//! Replaying golden evidence fixtures against a rule, locally.
//!
//! The third thing an SDK owns — bindings, build story, test harness
//! (`../../../docs/adr/0002-custom-rules-one-contract.md`, "SDKs are
//! bindings"). What holds four SDKs to one contract is a shared conformance
//! suite: evidence fixtures with expected verdicts that every SDK's reference
//! rules must reproduce. `../fixtures/` is this crate's half of that suite, and
//! this module is what runs it.
//!
//! It is compiled only for non-`wasm32` targets. A harness reads files, and a
//! rule module is loaded by a host that grants it no filesystem at all — code
//! that could never run inside the artifact has no business being in it.
//!
//! The comparison is between JSON DOCUMENTS, not between strings: key order and
//! whitespace are a serializer's business, and pinning them would make a
//! conformance suite that four SDKs must reproduce depend on how one of them
//! happens to write its output. Everything the contract fixes — which keys are
//! present, which are absent, and what each holds — is compared exactly.

use std::path::Path;

use serde_json::Value;

/// The bytes of one golden fixture.
///
/// # Panics
///
/// When the fixture cannot be read. A missing fixture is a broken suite, not a
/// rule that answered something — and a harness that skipped it would report a
/// green run over a file nobody read.
#[must_use]
pub fn read_fixture(fixture: impl AsRef<Path>) -> Vec<u8> {
    let fixture = fixture.as_ref();
    std::fs::read(fixture).unwrap_or_else(|error| {
        panic!(
            "the fixture {} could not be read: {error}",
            fixture.display()
        )
    })
}

/// The verdict a rule answers over one golden fixture, as a parsed document.
///
/// `evaluate` is the `archkeep_evaluate_json` the `archkeep_rule!` macro
/// generates — the same function the artifact's `archkeep_evaluate` export
/// calls, so what a fixture exercises is the shipped path and not a rehearsal
/// of it.
///
/// # Panics
///
/// When the fixture cannot be read, or when the rule answers text that is not
/// JSON — which the host would refuse as an unparseable verdict, so the harness
/// refuses it here where the author can still see why.
#[must_use]
pub fn replay(fixture: impl AsRef<Path>, evaluate: fn(&[u8]) -> String) -> Value {
    let fixture = fixture.as_ref();
    let answered = evaluate(&read_fixture(fixture));
    serde_json::from_str(&answered).unwrap_or_else(|error| {
        panic!(
            "the rule answered text that is not JSON over {}: {error}\n{answered}",
            fixture.display()
        )
    })
}

/// Asserts a rule's verdict over one golden fixture equals `expected`.
///
/// # Panics
///
/// When the two documents differ, printing both — the failure a conformance
/// suite exists to produce.
pub fn expect_verdict(fixture: impl AsRef<Path>, evaluate: fn(&[u8]) -> String, expected: &str) {
    let fixture = fixture.as_ref();
    let answered = replay(fixture, evaluate);
    let expected: Value = serde_json::from_str(expected)
        .unwrap_or_else(|error| panic!("the expected verdict is not JSON: {error}"));
    assert_eq!(
        answered,
        expected,
        "the rule's verdict over {} is not the one the suite pins",
        fixture.display()
    );
}

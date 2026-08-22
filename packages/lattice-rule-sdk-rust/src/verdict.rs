//! The verdict, and the shapes of it the type system refuses to build.
//!
//! The host calls a verdict that breaks one of its obligations **hollow** and
//! refuses it — a `fail` naming no finding, a `pass` carrying one, an `unknown`
//! with no reason, a reason on a verdict that is not `unknown`
//! (`../../lattice/src/custom-rules/host.mjs`, `verdictViolation`). Every one
//! of those is a rule that returned a shape instead of a judgment, and the
//! refusal is what stops it being read as one.
//!
//! This module's job is to make as many of them as possible impossible to write
//! rather than merely refused later:
//!
//! - [`Verdict::fail`] takes [`Findings`], which cannot be empty. There is no
//!   way to spell a failing verdict that names nothing.
//! - [`Verdict::pass`] takes nothing, so it cannot carry a finding.
//! - [`Verdict::unknown`] and [`Verdict::not_applicable`] take their reason as
//!   an argument rather than a setter, so the reason cannot be forgotten, and
//!   neither reason field is reachable from any other constructor.
//! - [`Finding::at`] takes a file and a position together, and each coordinate
//!   as a [`NonZeroU32`], so a position with no file and a zeroth line are both
//!   unwritable.
//!
//! What the type system cannot hold is emptiness of a `String`: an empty
//! message or an empty reason is still refused by the host, and this crate does
//! not check it a second time — see the crate docs on not duplicating the
//! host's validation.

use std::num::NonZeroU32;

use serde::Serialize;

use crate::CONTRACT;

/// The four-state vocabulary every judgment in this engine speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerdictKind {
    /// The rule looked and found nothing.
    Pass,
    /// The rule found something, and every finding names what.
    Fail,
    /// The rule could not reach a judgment, and says why.
    Unknown,
    /// The rule does not apply to this run, and says why.
    NotApplicable,
}

/// One thing a rule found.
///
/// `id` must be an id this rule's own catalogue declares — the host refuses a
/// finding it cannot resolve to a catalogue entry, because SARIF would drop it.
/// That check is the host's and is deliberately not repeated here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    id: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<NonZeroU32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    column: Option<NonZeroU32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<String>,
}

impl Finding {
    /// A finding with no location, naming the catalogue entry it belongs to and
    /// what it found.
    ///
    /// The message is what a reader acts on, so it is the finding's own
    /// sentence rather than the catalogue's template — the catalogue says what
    /// the id MEANS, this says what happened here.
    #[must_use]
    pub fn new(id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            message: message.into(),
            source_file: None,
            line: None,
            column: None,
            project: None,
        }
    }

    /// Places the finding in a file, with no position inside it.
    ///
    /// The case this exists for is a graph edge: an edge may carry a
    /// `sourceFile` and never carries a line, so a rule judging edges can name
    /// the file honestly and must not invent `1:1` to fill the shape.
    #[must_use]
    pub fn in_file(mut self, source_file: impl Into<String>) -> Self {
        self.source_file = Some(source_file.into());
        self
    }

    /// Places the finding at a 1-based position in a file.
    ///
    /// File and position move together because the host refuses a position with
    /// no file — "a position with no file sends a reader to a line in nothing" —
    /// and [`NonZeroU32`] is why a zeroth line cannot be written at all.
    /// [`crate::ImportRecord::position`] hands over the pair an import site
    /// already carries.
    #[must_use]
    pub fn at(
        mut self,
        source_file: impl Into<String>,
        line: NonZeroU32,
        column: NonZeroU32,
    ) -> Self {
        self.source_file = Some(source_file.into());
        self.line = Some(line);
        self.column = Some(column);
        self
    }

    /// Attributes the finding to a project.
    #[must_use]
    pub fn in_project(mut self, project: impl Into<String>) -> Self {
        self.project = Some(project.into());
        self
    }
}

/// One or more findings.
///
/// A `Vec<Finding>` that is guaranteed not to be empty, which is the whole
/// point: it is the argument type of [`Verdict::fail`], so "this rule failed
/// and named nothing" has no spelling. There is no `len`/`is_empty` pair on
/// purpose — the answer to `is_empty` is always `false`, and a caller asking it
/// is a caller who has forgotten what this type is for.
#[derive(Debug, Clone)]
pub struct Findings {
    items: Vec<Finding>,
}

impl Findings {
    /// Starts a non-empty list from the finding that makes it non-empty.
    #[must_use]
    pub fn new(first: Finding) -> Self {
        Self { items: vec![first] }
    }

    /// Adds a finding, keeping the list non-empty by construction.
    pub fn push(&mut self, finding: Finding) {
        self.items.push(finding);
    }

    /// Adds a finding, for building a list in one expression.
    #[must_use]
    pub fn with(mut self, finding: Finding) -> Self {
        self.items.push(finding);
        self
    }

    /// The non-empty list a `Vec` holds, or `None` when it holds nothing.
    ///
    /// `None` is the caller's cue that there is nothing to fail over — and
    /// [`Verdict::from_findings`] is the one-line way to answer it correctly.
    #[must_use]
    pub fn from_vec(findings: Vec<Finding>) -> Option<Self> {
        if findings.is_empty() {
            None
        } else {
            Some(Self { items: findings })
        }
    }

    /// The findings, in the order they were added.
    #[must_use]
    pub fn as_slice(&self) -> &[Finding] {
        &self.items
    }
}

/// What a rule answers.
///
/// Constructed only through the four verdict constructors, so the invariants
/// the host checks hold by construction rather than by care.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    contract: u32,
    verdict: VerdictKind,
    /// Never skipped, even when empty: "every verdict states its findings, and
    /// a clean rule states the empty list rather than leaving the field out".
    findings: Vec<Finding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    not_applicable_reason: Option<String>,
}

impl Verdict {
    /// The rule looked and found nothing.
    ///
    /// This is a CLAIM about the workspace, not a shrug: it says the rule read
    /// the evidence it declared it needs and there was nothing to report. A
    /// rule that could not read that evidence answers [`Verdict::unknown`]
    /// instead (`../../../AGENTS.md`).
    #[must_use]
    pub fn pass() -> Self {
        Self::of(VerdictKind::Pass, Vec::new())
    }

    /// The rule found something, and the findings say what.
    #[must_use]
    pub fn fail(findings: Findings) -> Self {
        Self::of(VerdictKind::Fail, findings.items)
    }

    /// The rule could not reach a judgment, and `reason` says why.
    ///
    /// This is the verdict for every path that would otherwise return an empty
    /// list it did not earn: a parameter that is not there, an evidence kind
    /// that arrived malformed, two halves of the bundle that disagree. Any
    /// `unknown` makes the run exit 3 — "could not look" is a distinct outcome
    /// from "looked and found nothing", and the exit codes keep it that way.
    #[must_use]
    pub fn unknown(reason: impl Into<String>) -> Self {
        Self {
            reason: Some(reason.into()),
            ..Self::of(VerdictKind::Unknown, Vec::new())
        }
    }

    /// The rule does not apply to this run, and `reason` says why.
    ///
    /// Not a quieter `pass`: it is counted and reported separately, because a
    /// rule that never applies is a rule nobody is being protected by, and that
    /// has to be visible rather than absorbed into a passing count.
    #[must_use]
    pub fn not_applicable(reason: impl Into<String>) -> Self {
        Self {
            not_applicable_reason: Some(reason.into()),
            ..Self::of(VerdictKind::NotApplicable, Vec::new())
        }
    }

    /// `pass` when the list is empty, `fail` when it is not.
    ///
    /// The shape most rules end in, and the one place emptiness legitimately
    /// means "clean" — because the caller has just finished looking. A rule that
    /// reaches here without having looked has already gone wrong somewhere
    /// above, which is what [`Verdict::unknown`] is for.
    #[must_use]
    pub fn from_findings(findings: Vec<Finding>) -> Self {
        match Findings::from_vec(findings) {
            Some(findings) => Self::fail(findings),
            None => Self::pass(),
        }
    }

    /// Which of the four this is.
    #[must_use]
    pub fn kind(&self) -> VerdictKind {
        self.verdict
    }

    /// The verdict as the UTF-8 JSON text the ABI carries back.
    ///
    /// # Panics
    ///
    /// Never in practice: a verdict holds strings and small integers, which
    /// always serialize. A panic here reaches the host as a trap it names,
    /// which is the loud direction rather than a verdict invented on the way
    /// out.
    #[must_use]
    pub fn to_json(&self) -> String {
        serde_json::to_string(self)
            .expect("a verdict is strings and integers, which always serialize")
    }

    fn of(verdict: VerdictKind, findings: Vec<Finding>) -> Self {
        Self {
            contract: CONTRACT,
            verdict,
            findings,
            reason: None,
            not_applicable_reason: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU32;

    use super::{Finding, Findings, Verdict, VerdictKind};

    fn one() -> NonZeroU32 {
        NonZeroU32::new(1).expect("1 is not zero")
    }

    #[test]
    fn a_pass_states_the_contract_and_an_empty_findings_list() {
        assert_eq!(
            Verdict::pass().to_json(),
            r#"{"contract":1,"verdict":"pass","findings":[]}"#
        );
    }

    #[test]
    fn a_fail_carries_every_optional_key_the_host_allows() {
        let verdict = Verdict::fail(Findings::new(
            Finding::new("cross-tag-edge", "beta reaches gamma")
                .at(
                    "packages/beta/src/lib.rs",
                    one(),
                    NonZeroU32::new(5).expect("5 is not zero"),
                )
                .in_project("beta"),
        ));
        assert_eq!(
            verdict.to_json(),
            r#"{"contract":1,"verdict":"fail","findings":[{"id":"cross-tag-edge","message":"beta reaches gamma","sourceFile":"packages/beta/src/lib.rs","line":1,"column":5,"project":"beta"}]}"#
        );
    }

    #[test]
    fn a_finding_with_no_position_omits_the_position_keys() {
        let verdict = Verdict::fail(Findings::new(
            Finding::new("cross-tag-edge", "beta reaches gamma")
                .in_file("packages/beta/Cargo.toml"),
        ));
        assert_eq!(
            verdict.to_json(),
            r#"{"contract":1,"verdict":"fail","findings":[{"id":"cross-tag-edge","message":"beta reaches gamma","sourceFile":"packages/beta/Cargo.toml"}]}"#
        );
    }

    #[test]
    fn unknown_and_not_applicable_each_carry_their_own_reason_and_no_other() {
        assert_eq!(
            Verdict::unknown("params.forbiddenTag is not a string").to_json(),
            r#"{"contract":1,"verdict":"unknown","findings":[],"reason":"params.forbiddenTag is not a string"}"#
        );
        assert_eq!(
            Verdict::not_applicable("no project carries the tag").to_json(),
            r#"{"contract":1,"verdict":"not_applicable","findings":[],"notApplicableReason":"no project carries the tag"}"#
        );
    }

    // The silent direction: an empty finding list must never serialize as a
    // failing verdict, and a rule that found something must never serialize as
    // a passing one. `Verdict::fail` cannot be called with an empty list at
    // all — that is the type system's half — so what is left to pin is the
    // collapse `from_findings` performs.
    #[test]
    fn from_findings_passes_on_nothing_and_fails_on_something() {
        assert_eq!(Verdict::from_findings(Vec::new()).kind(), VerdictKind::Pass);
        assert_eq!(
            Verdict::from_findings(vec![Finding::new("cross-tag-edge", "beta reaches gamma")])
                .kind(),
            VerdictKind::Fail
        );
        assert!(Findings::from_vec(Vec::new()).is_none());
    }

    #[test]
    fn findings_keep_the_order_they_were_added() {
        let mut findings = Findings::new(Finding::new("first-finding", "one"));
        findings.push(Finding::new("second-finding", "two"));
        let findings = findings.with(Finding::new("third-finding", "three"));
        let messages: Vec<&str> = findings
            .as_slice()
            .iter()
            .map(|finding| finding.message.as_str())
            .collect();
        assert_eq!(messages, ["one", "two", "three"]);
    }
}

//! What a rule says about itself before it is ever handed evidence.
//!
//! The host reads this document first and refuses the rule outright when it is
//! malformed — an empty catalogue, a duplicate finding id, a name that is not
//! the one the policy row declared
//! (`../../archkeep/src/custom-rules/host.mjs`, `describeViolation` and
//! `catalogueViolation`). Everything in that list except the name comparison is
//! decidable from literals the author wrote, so this module decides it in
//! `const` context: a rule that could not have loaded fails `cargo build`
//! instead of failing a consumer's CI with a load error they cannot fix without
//! the author.

use serde::Serialize;

use crate::CONTRACT;

/// One of the four kinds of observed fact contract 1 carries.
///
/// The roster is the engine's (`../../archkeep/src/custom-rules/evidence.mjs`,
/// `EVIDENCE_KINDS`) and this enum is a copy of it — the one copy this crate
/// makes, because a `needs` entry has to be spelled somewhere the compiler can
/// check. A kind added to contract 1 arrives here in the same change that adds
/// it there; a rule naming a kind this enum does not carry is a compile error,
/// which is the earliest of the three places it could be caught (the other two
/// being the host's `unknown` verdict and a reader's confusion).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceKind {
    /// The project model: every project, its root, and its tags.
    Model,
    /// The dependency graph: every edge between two projects.
    Graph,
    /// Every import site the analyzers read, with its attribution.
    Imports,
    /// The loaded policy: the constraint rows and the boundary options.
    Policy,
}

impl EvidenceKind {
    /// The wire spelling, which is what `needs` states and what the host
    /// matches against its own roster.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::Graph => "graph",
            Self::Imports => "imports",
            Self::Policy => "policy",
        }
    }
}

impl Serialize for EvidenceKind {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// One entry in a rule's findings catalogue: an id a finding can resolve to,
/// and the sentence that describes what it means.
///
/// The catalogue is what a SARIF report's `reportingDescriptor` set is built
/// from, which is why the host checks it at LOAD rather than when a finding
/// arrives: a rule whose catalogue is malformed produces findings no report can
/// render, and that would only be discovered on the run that finally fails.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct CatalogueEntry {
    id: &'static str,
    message: &'static str,
}

impl CatalogueEntry {
    /// Declares one catalogue entry.
    ///
    /// `id` is lowercase words joined by single dashes — the same grammar a
    /// rule name follows, because `custom/<rule>/<finding>` has one alphabet
    /// end to end (`../../archkeep/src/config.mjs`, `CUSTOM_RULE_NAME_PATTERN`).
    /// `message` is the template a reader sees when nothing more specific is
    /// available; a finding carries its own message on top of it.
    #[must_use]
    pub const fn new(id: &'static str, message: &'static str) -> Self {
        Self { id, message }
    }

    /// The entry's id.
    #[must_use]
    pub const fn id(&self) -> &'static str {
        self.id
    }

    /// The entry's message template.
    #[must_use]
    pub const fn message(&self) -> &'static str {
        self.message
    }
}

/// Everything `archkeep_describe` answers with.
///
/// Built by the `archkeep_rule!` macro from the author's literals; there is no
/// runtime path that constructs one from data, on purpose — a description
/// assembled at runtime could differ between the call the host reads and the
/// call it evaluates, and the host has no way to notice.
#[derive(Debug, Clone, Copy)]
pub struct RuleDeclaration {
    /// The rule's name, which MUST equal the `name` its policy row declares —
    /// the host refuses the pair when they differ, because the declared name is
    /// what every finding is namespaced under.
    pub name: &'static str,
    /// The evidence kinds this rule reads.
    pub needs: &'static [EvidenceKind],
    /// Every finding this rule can report. At least one, always: a rule that
    /// can name nothing it might find would read as permanently clean.
    pub findings: &'static [CatalogueEntry],
}

impl RuleDeclaration {
    /// Fails compilation when this declaration could not have loaded.
    ///
    /// Four refusals, each one the host's own
    /// (`../../archkeep/src/custom-rules/host.mjs`) moved to the earliest place
    /// it can be decided. The panic messages are literals rather than formatted
    /// text because a `const` panic cannot format — the compiler points at the
    /// macro invocation, which is where the offending literal is.
    ///
    /// # Panics
    ///
    /// In `const` context — that is, at compile time — when the name or a
    /// finding id is not lowercase-dashed, when two findings share an id, or
    /// when the catalogue is empty.
    pub const fn assert_valid(&self) {
        assert!(
            is_lower_dashed(self.name),
            "archkeep_rule!: `name` must be lowercase letters and digits joined by single dashes, \
             the same grammar the policy row's `name` is held to"
        );
        assert!(
            !self.findings.is_empty(),
            "archkeep_rule!: `findings` must declare at least one entry — a rule that can name \
             nothing it might find can never report one, and would read as permanently clean"
        );

        let mut index = 0;
        while index < self.findings.len() {
            assert!(
                is_lower_dashed(self.findings[index].id),
                "archkeep_rule!: every finding id must be lowercase letters and digits joined by \
                 single dashes"
            );
            assert!(
                !self.findings[index].message.is_empty(),
                "archkeep_rule!: every finding needs a message — a catalogue entry with none \
                 renders as a finding that says nothing"
            );
            let mut other = 0;
            while other < index {
                assert!(
                    !str_eq(self.findings[index].id, self.findings[other].id),
                    "archkeep_rule!: two findings share one id — a report would resolve findings \
                     to whichever entry it happened to read last"
                );
                other += 1;
            }
            index += 1;
        }
    }
}

/// The document `archkeep_describe` returns, in the shape the host parses.
///
/// A private mirror of [`RuleDeclaration`] rather than `Serialize` on the type
/// itself: `contract` is not a field an author declares, and a public struct
/// carrying it would invite one to set it.
#[derive(Serialize)]
struct Describe<'a> {
    contract: u32,
    name: &'a str,
    needs: &'a [EvidenceKind],
    findings: &'a [CatalogueEntry],
}

impl RuleDeclaration {
    /// This declaration as the UTF-8 JSON text `archkeep_describe` answers with.
    ///
    /// # Panics
    ///
    /// Never in practice: every field is a `&'static str` or a number, and
    /// `serde_json` fails only on values this document cannot hold. A panic
    /// here reaches the host as a trap it names, which is the loud direction.
    #[must_use]
    pub fn to_json(&self) -> String {
        serde_json::to_string(&Describe {
            contract: CONTRACT,
            name: self.name,
            needs: self.needs,
            findings: self.findings,
        })
        .expect("a rule declaration is plain strings and numbers, which always serialize")
    }
}

/// Whether `value` is lowercase letters and digits joined by single dashes.
///
/// A hand-written scan rather than a regex, because this runs in `const`
/// context where no crate can: the point is to fail the BUILD, and a check that
/// needed a runtime would have to wait for one.
const fn is_lower_dashed(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut index = 0;
    let mut previous_dash = true; // a leading dash is as illegal as a trailing one
    while index < bytes.len() {
        let byte = bytes[index];
        let alphanumeric = byte.is_ascii_lowercase() || byte.is_ascii_digit();
        if alphanumeric {
            previous_dash = false;
        } else if byte == b'-' {
            if previous_dash {
                return false;
            }
            previous_dash = true;
        } else {
            return false;
        }
        index += 1;
    }
    !previous_dash
}

/// Byte equality for two `&str`, in `const` context.
const fn str_eq(left: &str, right: &str) -> bool {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    if left.len() != right.len() {
        return false;
    }
    let mut index = 0;
    while index < left.len() {
        if left[index] != right[index] {
            return false;
        }
        index += 1;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::{CatalogueEntry, EvidenceKind, RuleDeclaration, is_lower_dashed, str_eq};

    const DECLARATION: RuleDeclaration = RuleDeclaration {
        name: "no-cross-tag-dependency",
        needs: &[EvidenceKind::Model, EvidenceKind::Graph],
        findings: &[CatalogueEntry::new(
            "cross-tag-edge",
            "an edge crosses a forbidden tag",
        )],
    };

    #[test]
    fn describe_json_states_the_contract_and_the_catalogue() {
        assert_eq!(
            DECLARATION.to_json(),
            r#"{"contract":1,"name":"no-cross-tag-dependency","needs":["model","graph"],"findings":[{"id":"cross-tag-edge","message":"an edge crosses a forbidden tag"}]}"#
        );
    }

    #[test]
    fn a_valid_declaration_passes_the_compile_time_check() {
        const _: () = DECLARATION.assert_valid();
    }

    // The three refusals below cannot be written as `#[should_panic]` tests:
    // `assert_valid` fails at COMPILE time, so a declaration that violates one
    // of them does not produce a failing test, it produces a crate that does
    // not build. What is testable is the predicate underneath, and these are
    // the cases each refusal turns on — including the empty and
    // single-character ones, where an off-by-one in the scan would silently
    // accept a name the host then rejects at load.
    #[test]
    fn the_name_grammar_refuses_what_the_host_refuses() {
        assert!(is_lower_dashed("a"));
        assert!(is_lower_dashed("no-interface-outside-domain"));
        assert!(is_lower_dashed("rule2"));
        assert!(!is_lower_dashed(""));
        assert!(!is_lower_dashed("-leading"));
        assert!(!is_lower_dashed("trailing-"));
        assert!(!is_lower_dashed("double--dash"));
        assert!(!is_lower_dashed("Upper"));
        assert!(!is_lower_dashed("under_score"));
        assert!(!is_lower_dashed("with space"));
    }

    #[test]
    fn the_duplicate_check_compares_content_rather_than_length() {
        assert!(str_eq("same", "same"));
        assert!(!str_eq("same", "sane"));
        assert!(!str_eq("same", "same-longer"));
    }
}

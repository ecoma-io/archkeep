//! Author a Lattice custom rule in Rust, compile it to core WebAssembly, and
//! have the engine load it as declared law.
//!
//! This crate is a **binding, never a semantics**
//! (`../../../docs/adr/0002-custom-rules-one-contract.md`, "SDKs are
//! bindings"): it owns typed shapes for the evidence bundle and the verdict,
//! the ABI shell that carries bytes across the wasm boundary, and a harness
//! that replays golden fixtures. Every rule about what a verdict MEANS — which
//! findings are legal, when a `reason` is required, which finding ids resolve —
//! is decided by the engine's host (`../../lattice/src/custom-rules/host.mjs`)
//! and is deliberately not reimplemented here. Two validators would agree only
//! until one of them was edited.
//!
//! # What a rule author writes
//!
//! ```no_run
//! use lattice_rule_sdk::{Evidence, Finding, Verdict, lattice_rule};
//!
//! fn evaluate(evidence: &Evidence) -> Verdict {
//!     let Some(tag) = evidence.rule.params.get("tag").and_then(|v| v.as_str()) else {
//!         // Not `pass`. A rule that could not read its own parameters has not
//!         // judged anything, and saying so is the whole discipline
//!         // (`../../../AGENTS.md`: an empty result is a claim, not a shrug).
//!         return Verdict::unknown("params.tag is not a string, so nothing was judged");
//!     };
//!     let findings: Vec<Finding> = evidence
//!         .model
//!         .projects
//!         .iter()
//!         .filter(|project| project.has_tag(tag))
//!         .map(|project| Finding::new("tagged-project", "a project carries the tag")
//!             .in_project(&project.name))
//!         .collect();
//!     Verdict::from_findings(findings)
//! }
//!
//! lattice_rule! {
//!     name: "example-rule",
//!     needs: [model],
//!     findings: [("tagged-project", "a project carries the named tag")],
//!     evaluate: evaluate,
//! }
//! ```
//!
//! `examples/forbidden_tag_dependency.rs` is the same shape carried through to
//! a committed artifact, and `README.md` beside this file is the build story.
//!
//! # The three things this crate refuses to do
//!
//! - **It never re-models the policy.** `policy.depConstraints` and
//!   `policy.moduleBoundaryOptions` arrive as [`serde_json::Value`], because the
//!   constraint schema has exactly one owner (`../../lattice/src/config.mjs`)
//!   and a second copy here would be a dialect that drifts.
//! - **It never turns an unreadable bundle into a clean verdict.** Every path
//!   that cannot reach a judgment answers `unknown` with the cause named — see
//!   [`abi::evaluate_json`].
//! - **It never validates what the host validates.** Whether a finding's id
//!   appears in the catalogue is the host's refusal to make, and duplicating it
//!   here would put the SDK's opinion between an author and the real one.

pub mod abi;
pub mod declaration;
pub mod evidence;
#[cfg(not(target_arch = "wasm32"))]
pub mod harness;
pub mod verdict;

pub use declaration::{CatalogueEntry, EvidenceKind, RuleDeclaration};
pub use evidence::{
    Edge, Evidence, EvidenceError, Graph, ImportKind, ImportRecord, Model, Policy, Project,
    Resolved, RuleInstance, Spelling,
};
pub use verdict::{Finding, Findings, Verdict, VerdictKind};

/// serde_json, re-exported.
///
/// A rule reads its own `params` — which arrive as [`serde_json::Value`],
/// because a policy row's parameters are the workspace's shape and not
/// something this crate may model — so every rule needs this crate whether or
/// not it names it. Re-exporting it means an author's manifest declares one
/// dependency rather than two that have to agree on a version.
pub use serde_json;

/// The contract version this SDK speaks, on every side of the ABI at once.
///
/// One number rather than three, for the reason the host states beside its own
/// (`../../lattice/src/custom-rules/host.mjs`): the evidence a rule receives,
/// the description it answers with and the verdict it returns version
/// together, so a rule built for one is built for all three.
pub const CONTRACT: u32 = 1;

/// Declares the rule this artifact IS, and writes the ABI the host drives it
/// through.
///
/// # Why a macro rather than a `register(…)` call
///
/// A registration function would need somewhere to be called from, and a core
/// wasm module has no `main` and runs no start function the host invokes — the
/// host reads `lattice_describe` before anything else exists
/// (`../../lattice/src/custom-rules/host.mjs`, `loadCustomRule`). So the
/// declaration has to be a `const` the exports can read directly, and the
/// shortest way to get an author from four literals to four `extern "C"`
/// symbols is to generate them. The macro is also where the declaration can be
/// checked at COMPILE time: a malformed rule name, a duplicate finding id or an
/// empty catalogue fails `cargo build` instead of failing a consumer's `check`
/// with a load error (see [`RuleDeclaration::assert_valid`]).
///
/// # What it generates
///
/// - `LATTICE_RULE` — the [`RuleDeclaration`] const, so tests and the harness
///   can read the same catalogue the wasm answers with.
/// - `lattice_describe_json()` and `lattice_evaluate_json(&[u8])` — the pure,
///   target-independent halves. They are what a native `cargo test` drives, so
///   the code under test is the code the artifact runs rather than a rehearsal
///   of it.
/// - `lattice_alloc`, `lattice_describe`, `lattice_evaluate` — three of the
///   four ABI exports, **only when compiling to `wasm32`**. The ABI spells a
///   pointer as an `i32`, which is a fact about `wasm32` and a truncation
///   anywhere else; generating those functions for a 64-bit host target would
///   be emitting code that is wrong on the only target it could run on. The
///   pure pair above is what a native build has instead, and the committed
///   artifact plus its round trip through the real host is what proves the wasm
///   half (`../README.md`).
///
/// The fourth export, `memory`, is not written by anything here: rustc's
/// `wasm32-unknown-unknown` cdylib linkage exports the module's linear memory
/// under that name already — measured on the committed artifact, whose export
/// list is `memory`, the three functions above, and the two linker globals
/// `__data_end` and `__heap_base`, which the host neither reads nor minds.
///
/// # Shape
///
/// ```ignore
/// lattice_rule! {
///     name: "no-cross-tag-dependency",          // the name the policy row declares
///     needs: [model, graph],                    // model · graph · imports · policy
///     findings: [("finding-id", "message")],    // the catalogue, at least one entry
///     evaluate: my_rule_function,               // fn(&Evidence) -> Verdict
/// }
/// ```
///
/// `needs` takes the four evidence kinds as bare words; an unknown one is a
/// compile error naming no matching rule, which is the earliest place it can be
/// caught — the host's own answer to an unsupported kind is an `unknown`
/// verdict at check time, in the consumer's CI
/// (`../../lattice/src/custom-rules/host.mjs`, `needsViolation`).
#[macro_export]
macro_rules! lattice_rule {
    (@kind model) => {
        $crate::EvidenceKind::Model
    };
    (@kind graph) => {
        $crate::EvidenceKind::Graph
    };
    (@kind imports) => {
        $crate::EvidenceKind::Imports
    };
    (@kind policy) => {
        $crate::EvidenceKind::Policy
    };
    (
        name: $name:literal,
        needs: [ $( $kind:ident ),* $(,)? ],
        findings: [ $( ($id:literal, $message:literal $(,)?) ),* $(,)? ],
        evaluate: $evaluate:path $(,)?
    ) => {
        /// This artifact's declaration — the exact document `lattice_describe`
        /// answers with, readable from a test without going through wasm.
        pub const LATTICE_RULE: $crate::RuleDeclaration = $crate::RuleDeclaration {
            name: $name,
            needs: &[ $( $crate::lattice_rule!(@kind $kind) ),* ],
            findings: &[ $( $crate::CatalogueEntry::new($id, $message) ),* ],
        };

        // The compile-time half of the contract. A const item is evaluated
        // whether or not anything reads it, so this fires during `cargo build`
        // rather than on first use.
        const _: () = LATTICE_RULE.assert_valid();

        /// The self-description, as UTF-8 JSON text.
        pub fn lattice_describe_json() -> ::std::string::String {
            $crate::abi::describe_json(&LATTICE_RULE)
        }

        /// This rule's verdict over one evidence bundle, as UTF-8 JSON text.
        pub fn lattice_evaluate_json(evidence: &[u8]) -> ::std::string::String {
            $crate::abi::evaluate_json(evidence, $evaluate)
        }

        /// Reserves `len` writable bytes for the host to copy the evidence
        /// bundle into, and LEAKS them — see `abi::alloc` for why leaking is
        /// the contract rather than a bug.
        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn lattice_alloc(len: i32) -> i32 {
            $crate::abi::alloc(len)
        }

        /// The packed pointer/length of this rule's self-description.
        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn lattice_describe() -> i64 {
            $crate::abi::pack(lattice_describe_json().into_bytes())
        }

        /// The packed pointer/length of this rule's verdict over the evidence
        /// bundle the host wrote at `ptr..ptr + len`.
        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn lattice_evaluate(ptr: i32, len: i32) -> i64 {
            // SAFETY: the host writes exactly `len` bytes at the pointer
            // `lattice_alloc` answered with, and calls this once for that
            // range. `evidence_slice` re-checks the range against the module's
            // own memory before reading a byte of it.
            let evidence = unsafe { $crate::abi::evidence_slice(ptr, len) };
            $crate::abi::pack(lattice_evaluate_json(evidence).into_bytes())
        }
    };
}

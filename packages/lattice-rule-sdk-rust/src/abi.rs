//! The wire: how evidence bytes get in and verdict bytes get out.
//!
//! Contract 1's ABI is four exports and one packing rule
//! (`../../lattice/src/custom-rules/host.mjs`): `memory`, `lattice_alloc`,
//! `lattice_describe`, `lattice_evaluate`, and an `i64` result carrying
//! `(pointer << 32) | length`, both `u32`. The `lattice_rule!` macro writes the
//! three functions — `memory` comes from the wasm target's own cdylib linkage —
//! and this module is what they call.
//!
//! ## Everything allocated here is LEAKED, and that is the contract
//!
//! The host builds a fresh `WebAssembly.Instance` for every call and discards
//! it when the call returns — "one instance per call, never reused", so that no
//! call's leftover heap can reach the next call's judgment. A rule therefore
//! has no lifetime beyond the call it is in: memory freed after the return
//! would be freed into an instance nobody will ever look at again, and memory
//! freed BEFORE the return would be the verdict bytes the host has not read
//! yet. So allocation is one-way here, on purpose. It is not a leak in the
//! sense that matters — the instance's entire linear memory is released with
//! the instance.
//!
//! ## The wasm-only half
//!
//! [`alloc`], [`pack`] and [`evidence_slice`] exist only when compiling to
//! `wasm32`. The ABI spells a pointer as an `i32`, and that is a fact about
//! `wasm32`: on a 64-bit host target the same code would truncate every pointer
//! it touched. The pure pair — [`describe_json`] and [`evaluate_json`] — is
//! target-independent, which is what lets a native `cargo test` drive the exact
//! code the artifact runs.

use crate::declaration::RuleDeclaration;
use crate::evidence::Evidence;
use crate::verdict::Verdict;

/// A rule's self-description, as UTF-8 JSON text.
#[must_use]
pub fn describe_json(declaration: &RuleDeclaration) -> String {
    declaration.to_json()
}

/// One rule's verdict over one evidence bundle, as UTF-8 JSON text.
///
/// The bundle is read before the rule sees it, and a bundle that cannot be read
/// becomes an `unknown` verdict naming the cause — never a `pass`, and never an
/// empty finding list standing in for "could not look"
/// (`../../../AGENTS.md`). That single branch is why an author's rule signature
/// is `fn(&Evidence) -> Verdict` and not `fn(&[u8]) -> Verdict`: the failure
/// that has exactly one correct answer is answered here, once, rather than in
/// every rule that ever gets written.
#[must_use]
pub fn evaluate_json<F>(evidence: &[u8], rule: F) -> String
where
    F: FnOnce(&Evidence) -> Verdict,
{
    match Evidence::from_slice(evidence) {
        Ok(evidence) => rule(&evidence).to_json(),
        Err(error) => Verdict::unknown(error.to_string()).to_json(),
    }
}

/// Reserves `len` zeroed, writable bytes and leaks them, answering with the
/// pointer the host writes the evidence bundle at.
///
/// # Panics
///
/// When the host asks for a negative length, or when the allocation lands above
/// 2 GiB and so cannot be spelled as the `i32` the ABI fixes. Both are traps the
/// host names (`../../lattice/src/custom-rules/host.mjs`, the `trap` arm) —
/// the loud direction, rather than a pointer the host would write through into
/// nothing.
#[cfg(target_arch = "wasm32")]
#[must_use]
pub fn alloc(len: i32) -> i32 {
    let size = usize::try_from(len).expect("lattice_alloc: the host asks a non-negative length");
    let buffer = Box::leak(vec![0_u8; size].into_boxed_slice());
    let pointer = buffer.as_mut_ptr() as usize;
    i32::try_from(pointer).expect("lattice_alloc: a pointer past 2 GiB does not fit the ABI's i32")
}

/// Leaks `bytes` and packs their pointer and length into the `i64` the ABI
/// returns: `(pointer << 32) | length`.
///
/// # Panics
///
/// When the bytes are longer than `u32::MAX` or land above 4 GiB — neither is
/// reachable inside a `wasm32` module, which is why they are asserted rather
/// than encoded: a silent truncation here would hand the host a range pointing
/// at the wrong bytes, which it would read and parse as a verdict.
#[cfg(target_arch = "wasm32")]
#[must_use]
pub fn pack(bytes: Vec<u8>) -> i64 {
    let length = u32::try_from(bytes.len()).expect("a verdict longer than u32::MAX is not a range");
    let leaked = Box::leak(bytes.into_boxed_slice());
    let pointer =
        u32::try_from(leaked.as_ptr() as usize).expect("a pointer past 4 GiB is not a wasm32 one");
    ((u64::from(pointer) << 32) | u64::from(length)) as i64
}

/// The evidence bytes the host wrote at `ptr..ptr + len`.
///
/// # Safety
///
/// The caller must pass exactly the pointer a preceding [`alloc`] answered with
/// and the length the host wrote there — which is what the `lattice_evaluate`
/// export the macro generates does, and it is the only caller the ABI has. The
/// range is checked against the module's own linear memory before a byte of it
/// is read, so a caller that got it wrong traps here rather than reading
/// whatever happens to be at that address.
///
/// # Panics
///
/// When the range is negative or reaches past the module's linear memory.
#[cfg(target_arch = "wasm32")]
#[must_use]
pub unsafe fn evidence_slice<'a>(ptr: i32, len: i32) -> &'a [u8] {
    let pointer =
        usize::try_from(ptr).expect("lattice_evaluate: a negative pointer is not a range");
    let length = usize::try_from(len).expect("lattice_evaluate: a negative length is not a range");
    let memory_bytes = core::arch::wasm32::memory_size(0) * 65_536;
    assert!(
        pointer.saturating_add(length) <= memory_bytes,
        "lattice_evaluate: the evidence range reaches past this module's own linear memory"
    );
    // SAFETY: the range is inside this module's linear memory, and the host
    // holds the instance for the duration of the call, so the bytes cannot move
    // or be freed while the returned slice is alive.
    unsafe { core::slice::from_raw_parts(pointer as *const u8, length) }
}

#[cfg(test)]
mod tests {
    use super::evaluate_json;
    use crate::verdict::{Verdict, VerdictKind};

    #[test]
    fn a_bundle_that_cannot_be_read_becomes_unknown_rather_than_pass() {
        // The silent direction. If this ever returns `pass`, a rule handed
        // corrupt bytes reports a clean workspace.
        let verdict = evaluate_json(b"not json at all", |_| Verdict::pass());
        assert!(verdict.contains(r#""verdict":"unknown""#), "got {verdict}");
        assert!(verdict.contains("could not be read"), "got {verdict}");
        assert!(!verdict.contains(r#""verdict":"pass""#), "got {verdict}");
    }

    #[test]
    fn a_bundle_from_another_contract_becomes_unknown_naming_the_version() {
        let verdict = evaluate_json(br#"{"contract":7}"#, |_| Verdict::pass());
        assert!(verdict.contains(r#""verdict":"unknown""#), "got {verdict}");
    }

    #[test]
    fn a_readable_bundle_reaches_the_rule() {
        let bundle = br#"{
            "contract": 1,
            "rule": { "name": "example-rule", "params": {} },
            "model": { "projects": [] },
            "graph": { "edges": [] },
            "imports": [],
            "policy": { "depConstraints": [], "moduleBoundaryOptions": {} }
        }"#;
        let verdict = evaluate_json(bundle, |evidence| {
            assert_eq!(evidence.rule.name, "example-rule");
            Verdict::not_applicable("nothing to judge in an empty workspace")
        });
        assert!(
            verdict.contains(r#""verdict":"not_applicable""#),
            "got {verdict}"
        );
        assert_eq!(
            Verdict::not_applicable("x").kind(),
            VerdictKind::NotApplicable
        );
    }
}

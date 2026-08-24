// The wire: how evidence bytes get in and verdict bytes get out.
//
// Contract 1's ABI is four exports and one packing rule
// (`../../archkeep/src/custom-rules/host.mjs`): `memory`, `archkeep_alloc`,
// `archkeep_describe`, `archkeep_evaluate`, and an `i64` result carrying
// `(pointer << 32) | length`, both `u32`.
//
// Three of the four live here. The fourth, `memory`, is exported by the
// compiler itself — measured: `asc` exports linear memory under that name
// unless `--noExportMemory` is passed, and `../rebuild-example.sh` does not
// pass it.
//
// ## An author still writes three export lines, and why there is no macro
//
// The Rust SDK generates its exports from `archkeep_rule! { … }`
// (`../../archkeep-rule-sdk-rust/src/lib.rs`). AssemblyScript has no macro
// system, and a wasm module's exports are decided by what its ENTRY file
// exports — so nothing this package can write will put a symbol in an author's
// module. What it can do is make each of the three one line long, which is what
// `describePacked` and `evaluatePacked` below are for, and let `archkeep_alloc`
// be re-exported verbatim (`export { archkeep_alloc } from "…/assembly";` in the
// entry file compiles to the export — measured against asc 0.28.20).
//
// The trade is stated rather than hidden: an author who forgets one of the
// three ships a module the host refuses at load, naming the missing export.
// That is the loud direction, and it is the same failure the Rust macro
// prevents at compile time.
//
// ## Everything allocated here is LEAKED, and that is the contract
//
// The host builds a fresh `WebAssembly.Instance` for every call and discards it
// when the call returns — "one instance per call, never reused", so that no
// call's leftover heap can reach the next call's judgment. A rule therefore has
// no lifetime beyond the call it is in: memory freed after the return would be
// freed into an instance nobody will ever look at again, and memory freed
// BEFORE the return would be the verdict bytes the host has not read yet.
//
// That is why `../rebuild-example.sh` builds with `--runtime stub`: the stub
// runtime is a bump allocator that never frees, which is exactly the lifetime
// the contract describes. Measured against the two alternatives on the same
// source — stub 15,781 bytes, minimal 17,247, incremental 23,624, all three
// with zero imports — so the choice costs nothing and buys the smallest
// artifact a reviewer has to hash.

import { Evidence } from "./evidence";
import { RuleDeclaration } from "./declaration";
import { Verdict } from "./verdict";

/**
 * Reserves `len` writable bytes for the host to copy the evidence bundle into.
 *
 * Re-exported by a rule's entry file as `archkeep_alloc`, which is the ABI name.
 * The pointer is the raw one the stub runtime's bump allocator answers with —
 * unmanaged, so nothing here can collect it while the host is writing into it.
 *
 * A length the allocator cannot satisfy traps, which the host reports by name
 * (`../../archkeep/src/custom-rules/host.mjs`, the `trap` arm) — the loud
 * direction, rather than a pointer the host would write through into nothing.
 */
export function archkeep_alloc(len: i32): i32 {
  return <i32>heap.alloc(<usize>len);
}

/**
 * Leaks `text` as UTF-8 bytes and packs their pointer and length into the `i64`
 * the ABI returns: `(pointer << 32) | length`.
 *
 * The pointer is taken from the encoded `ArrayBuffer`, whose payload begins at
 * the object's own address in AssemblyScript, and the length is its
 * `byteLength` — the encoded BYTE count, never the string's UTF-16 length,
 * which would under-state the range for every non-ASCII character in a project
 * name or a reason.
 */
export function pack(text: string): i64 {
  const bytes = String.UTF8.encode(text);
  return ((<i64>changetype<usize>(bytes)) << 32) | (<i64>bytes.byteLength);
}

/**
 * The packed pointer/length of a rule's self-description.
 *
 * One line inside an author's `archkeep_describe`.
 */
export function describePacked(declaration: RuleDeclaration): i64 {
  return pack(declaration.toJson());
}

/**
 * The packed pointer/length of a rule's verdict over the evidence bundle the
 * host wrote at `ptr..ptr + len`.
 *
 * The bundle is read before the rule sees it, and a bundle that cannot be read
 * becomes an `unknown` verdict naming the cause — never a `pass`, and never an
 * empty finding list standing in for "could not look" (`../../../AGENTS.md`).
 * That single branch is why an author's rule signature is
 * `(evidence: Evidence) => Verdict` and not `(bytes: Uint8Array) => Verdict`:
 * the failure that has exactly one correct answer is answered here, once,
 * rather than in every rule that ever gets written.
 *
 * `String.UTF8.decodeUnsafe` is the decode, and "unsafe" names the bounds
 * check it does not do: the range is the one the host wrote, at the pointer
 * `archkeep_alloc` answered with, and the host has already refused a range
 * outside its own memory before calling. Bytes that are not valid UTF-8 decode
 * to replacement characters rather than failing, which then fails the JSON read
 * and becomes an `unknown` naming the bundle — one step further along than the
 * Rust SDK reports the same corruption, and still never a `pass`.
 */
export function evaluatePacked(ptr: i32, len: i32, rule: (evidence: Evidence) => Verdict): i64 {
  const text = String.UTF8.decodeUnsafe(<usize>ptr, <usize>len);
  const reading = Evidence.read(text);
  const evidence = reading.evidence;
  if (evidence == null) return pack(Verdict.unknown(reading.error).toJson());
  return pack(rule(evidence).toJson());
}

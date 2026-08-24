// The AssemblyScript rule-authoring SDK — everything a rule imports, in one
// place.
//
// **This is AssemblyScript, not TypeScript.** The syntax is TypeScript's; the
// language is not. There are no closures over arbitrary state, no `any`, no
// union types, no `Promise`, no Node API, no `JSON` global, and no JavaScript
// standard library — `../README.md`'s first section is the full statement, and
// it is the first thing to read before writing a rule against this file.
//
// This package is a **binding, never a semantics**
// (`../../../docs/adr/0002-custom-rules-one-contract.md`, "SDKs are
// bindings"): it owns typed shapes for the evidence bundle and the verdict, the
// ABI shell that carries bytes across the wasm boundary, and the golden
// fixtures a rule is replayed against. Every rule about what a verdict MEANS —
// which findings are legal, when a `reason` is required, which finding ids
// resolve — is decided by the engine's host
// (`../../archkeep/src/custom-rules/host.mjs`) and is deliberately not
// reimplemented here. Two validators would agree only until one of them was
// edited.
//
// # What a rule author writes
//
// ```ts
// import {
//   CatalogueEntry, Evidence, EvidenceKind, Finding, RuleDeclaration, Verdict,
//   describePacked, evaluatePacked,
// } from "@ecoma-io/archkeep-rule-sdk/assembly";
//
// export { archkeep_alloc } from "@ecoma-io/archkeep-rule-sdk/assembly";
//
// const RULE = new RuleDeclaration(
//   "example-rule",
//   [EvidenceKind.Model],
//   [new CatalogueEntry("tagged-project", "a project carries the named tag")],
// );
//
// function evaluate(evidence: Evidence): Verdict {
//   const tag = evidence.rule.params.getString("tag");
//   if (tag == null) {
//     // Not `pass`. A rule that could not read its own parameters has not
//     // judged anything, and saying so is the whole discipline
//     // (`../../../AGENTS.md`: an empty result is a claim, not a shrug).
//     return Verdict.unknown("params.tag is not a string, so nothing was judged");
//   }
//   const findings: Finding[] = [];
//   for (let i = 0; i < evidence.model.projects.length; i++) {
//     const project = evidence.model.projects[i];
//     if (project.hasTag(tag)) {
//       findings.push(
//         new Finding("tagged-project", "a project carries the tag").inProject(project.name),
//       );
//     }
//   }
//   return Verdict.fromFindings(findings);
// }
//
// export function archkeep_describe(): i64 {
//   return describePacked(RULE);
// }
// export function archkeep_evaluate(ptr: i32, len: i32): i64 {
//   return evaluatePacked(ptr, len, evaluate);
// }
// ```
//
// The import specifier carries the `/assembly` subpath, and that is measured
// rather than stylistic: `asc` 0.28.20 maps a bare package name onto
// `~lib/<name>.ts` and fails to find it, with or without `--path node_modules`.
// `../examples/forbidden-tag-dependency.ts` is the same shape carried through to
// a committed artifact.
//
// # The three things this package refuses to do
//
// - **It never re-models the policy.** `policy.depConstraints` and
//   `policy.moduleBoundaryOptions` arrive as raw `JsonValue`, because the
//   constraint schema has exactly one owner (`../../archkeep/src/config.mjs`) and
//   a second copy here would be a dialect that drifts.
// - **It never turns an unreadable bundle into a clean verdict.** Every path
//   that cannot reach a judgment answers `unknown` with the cause named — see
//   `./abi.ts`.
// - **It never validates what the host validates.** Whether a finding's id
//   appears in the catalogue is the host's refusal to make, and duplicating it
//   here would put this package's opinion between an author and the real one.

// The surface is deliberately the whole of what a rule needs and nothing more.
// `quoteJsonString` and `JsonReader` are absent because a rule never sees text:
// the bundle arrives parsed and the verdict leaves serialized, both through
// `./abi.ts`. An author who cannot reach them cannot build a second serializer
// that disagrees with this one about what a verdict looks like.
export { archkeep_alloc, pack, describePacked, evaluatePacked } from "./abi";
export { CONTRACT, CatalogueEntry, EvidenceKind, RuleDeclaration } from "./declaration";
export {
  Edge,
  Evidence,
  EvidenceResult,
  Graph,
  ImportKind,
  ImportRecord,
  Model,
  Policy,
  Project,
  Resolved,
  RuleInstance,
  Spelling,
} from "./evidence";
export { JsonKind, JsonValue } from "./json";
export { Finding, Findings, Verdict, VerdictKind } from "./verdict";

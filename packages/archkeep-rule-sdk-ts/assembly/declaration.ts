// What a rule says about itself before it is ever handed evidence.
//
// The host reads this document first and refuses the rule outright when it is
// malformed — an empty catalogue, a duplicate finding id, a name that is not
// the one the policy row declared
// (`../../archkeep/src/custom-rules/host.mjs`, `describeViolation` and
// `catalogueViolation`).
//
// ## Where the Rust SDK checks at compile time, this one cannot
//
// `../../archkeep-rule-sdk-rust/src/declaration.rs` decides the name grammar,
// the duplicate ids and the empty catalogue in `const` context, so a rule that
// could not have loaded fails `cargo build`. AssemblyScript has no `const`
// evaluation of that kind and no macro to hang it on, so the same four
// refusals are the HOST's here, reached at load in a consumer's `check`.
//
// That gap is not left to a consumer to discover. `../test/golden.test.mjs`
// drives the committed artifact through the real host, so a declaration this
// package ships that the host would refuse is a red test in this repository —
// the same failure, moved from `cargo build` to `moon run …:test`. What an
// AUTHOR gets is the host's refusal, by name, on their first `check`; the
// README says so rather than implying a compile-time guarantee that is not
// there.

import { quoteJsonString } from "./json";

/** The contract version this SDK speaks, on every side of the ABI at once. */
export const CONTRACT: i32 = 1;

/**
 * One of the four kinds of observed fact contract 1 carries.
 *
 * The roster is the engine's (`../../archkeep/src/custom-rules/evidence.mjs`,
 * `EVIDENCE_KINDS`) and this enum is a copy of it — the one copy this package
 * makes, because a `needs` entry has to be spelled somewhere the compiler can
 * check. A kind added to contract 1 arrives here in the same change that adds
 * it there.
 */
export const enum EvidenceKind {
  /** The project model: every project, its root, and its tags. */
  Model = 0,
  /** The dependency graph: every edge between two projects. */
  Graph = 1,
  /** Every import site the analyzers read, with its attribution. */
  Imports = 2,
  /** The loaded policy: the constraint rows and the boundary options. */
  Policy = 3,
}

/**
 * The wire spelling of one kind — what `needs` states and what the host matches
 * against its own roster.
 *
 * An `EvidenceKind` outside the four is spelled as itself rather than defaulted
 * to one of them: the host answers an unknown kind with an `unknown` verdict
 * naming it, and a default here would hand it a kind the author never wrote.
 */
export function evidenceKindName(kind: EvidenceKind): string {
  if (kind == EvidenceKind.Model) return "model";
  if (kind == EvidenceKind.Graph) return "graph";
  if (kind == EvidenceKind.Imports) return "imports";
  if (kind == EvidenceKind.Policy) return "policy";
  return "evidence-kind-" + (<i32>kind).toString();
}

/**
 * One entry in a rule's findings catalogue: an id a finding can resolve to, and
 * the sentence that describes what it means.
 *
 * The catalogue is what a SARIF report's `reportingDescriptor` set is built
 * from, which is why the host checks it at LOAD rather than when a finding
 * arrives: a rule whose catalogue is malformed produces findings no report can
 * render.
 */
export class CatalogueEntry {
  /** The id, lowercase words joined by single dashes. */
  id: string;
  /** What the id means — the template a reader sees beside a finding. */
  message: string;

  constructor(id: string, message: string) {
    this.id = id;
    this.message = message;
  }
}

/**
 * Everything `archkeep_describe` answers with.
 *
 * Built by a rule from its own literals and read twice — once to serialize the
 * description, once by `../test/golden.test.mjs` to check that every finding a
 * fixture produces resolves to an entry here. A rule's declaration is a `const`
 * for that reason: a description assembled from data could differ between the
 * call the host reads and the call it evaluates, and the host has no way to
 * notice.
 */
export class RuleDeclaration {
  /** The name, which MUST equal the `name` the policy row declares. */
  name: string;
  /** The evidence kinds this rule reads. */
  needs: EvidenceKind[];
  /** Every finding this rule can report. At least one, always. */
  findings: CatalogueEntry[];

  constructor(name: string, needs: EvidenceKind[], findings: CatalogueEntry[]) {
    this.name = name;
    this.needs = needs;
    this.findings = findings;
  }

  /**
   * This declaration as the UTF-8 JSON text `archkeep_describe` answers with.
   *
   * Key order is `contract`, `name`, `needs`, `findings` — the order the
   * contract documents them in (`../../../docs/reference/custom-rules.md`). The
   * host parses rather than compares, so the order is a courtesy to a reader
   * diffing two SDKs' output, not something it turns on.
   */
  toJson(): string {
    let out = '{"contract":' + CONTRACT.toString() + ',"name":' + quoteJsonString(this.name);
    out += ',"needs":[';
    for (let index = 0; index < this.needs.length; index++) {
      if (index > 0) out += ",";
      out += quoteJsonString(evidenceKindName(this.needs[index]));
    }
    out += '],"findings":[';
    for (let index = 0; index < this.findings.length; index++) {
      if (index > 0) out += ",";
      const entry = this.findings[index];
      out += '{"id":' + quoteJsonString(entry.id);
      out += ',"message":' + quoteJsonString(entry.message) + "}";
    }
    return out + "]}";
  }
}

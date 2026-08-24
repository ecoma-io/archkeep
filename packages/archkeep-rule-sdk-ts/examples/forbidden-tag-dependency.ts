// The reference rule: **no project may depend on a project carrying a
// forbidden tag**, unless it carries one of the tags the row exempts.
//
// It exists to be built, committed and RUN — `forbidden-tag-dependency.wasm`
// beside this file is the artifact, `forbidden-tag-dependency.wasm.sha256` is
// the digest a `customRules` row pins it by, and `../test/golden.test.mjs`
// replays the fixtures in `../fixtures/` against it THROUGH THE REAL HOST.
// `../README.md` holds the rebuild command and the argument for committing a
// binary at all.
//
// It is the same rule the Rust SDK ships
// (`../../archkeep-rule-sdk-rust/examples/forbidden_tag_dependency.rs`), reason
// strings included, because the two are halves of one conformance suite: the
// fixtures in `../fixtures/` are byte-identical to that package's, and a verdict
// that differed by a word would mean the two SDKs had drifted into two
// contracts.
//
// ## What it is a reference OF
//
// Four verdicts, each reachable, because a rule that can only pass and fail has
// no way to say it could not look:
//
// - `fail` — an edge lands on a project carrying the forbidden tag, and the
//   depending project is not exempt. Every finding names the pair and, when the
//   graph carried one, the file the edge was read from.
// - `pass` — every edge was read and none of them crossed.
// - `not_applicable` — no project in the workspace carries the tag at all, so
//   the rule constrains nothing here. Reported rather than absorbed into a
//   passing count: a rule nobody is protected by must be visible.
// - `unknown` — the parameters are not there to read, or the graph names a
//   project the model does not declare. Both are cases where the honest answer
//   is that this run reached no verdict; answering `pass` would be a clean
//   workspace nobody earned.
//
// ## The policy row it is declared by
//
// ```jsonc
// {
//   "name": "forbidden-tag-dependency",
//   "artifact": "tools/rules/forbidden-tag-dependency.wasm",
//   "sha256": "<the contents of forbidden-tag-dependency.wasm.sha256>",
//   "params": { "forbiddenTag": "layer-infrastructure", "exemptTags": ["layer-adapter"] },
//   "reason": "..."
// }
// ```

import {
  CatalogueEntry,
  Evidence,
  EvidenceKind,
  Finding,
  JsonKind,
  RuleDeclaration,
  Verdict,
  describePacked,
  evaluatePacked,
} from "../assembly/index";

// `archkeep_alloc` is the ABI's one export a rule never writes itself. A wasm
// module exports what its ENTRY file exports, so it is re-exported here rather
// than inherited — the import above cannot put a symbol in this module.
export { archkeep_alloc } from "../assembly/index";

/** The tag whose incoming dependencies this rule refuses. */
const FORBIDDEN_TAG: string = "forbiddenTag";
/** Tags that excuse a depending project from the rule. */
const EXEMPT_TAGS: string = "exemptTags";

/** What this artifact IS: the document `archkeep_describe` answers with. */
const RULE = new RuleDeclaration(
  "forbidden-tag-dependency",
  [EvidenceKind.Model, EvidenceKind.Graph],
  [
    new CatalogueEntry(
      "dependency-on-forbidden-tag",
      "a project depends on a project carrying the forbidden tag",
    ),
  ],
);

function evaluate(evidence: Evidence): Verdict {
  const forbiddenTag = evidence.rule.params.getString(FORBIDDEN_TAG);
  if (forbiddenTag == null || forbiddenTag.length == 0) {
    return Verdict.unknown(
      "params." +
        FORBIDDEN_TAG +
        " is not a non-empty string, so there is no tag to judge dependencies against — the rule " +
        "read nothing and concluded nothing",
    );
  }

  const exemptTags: string[] = [];
  const declaredExempt = evidence.rule.params.get(EXEMPT_TAGS);
  if (declaredExempt != null && !declaredExempt.isNull) {
    if (declaredExempt.kind != JsonKind.Array) {
      return Verdict.unknown(
        "params." +
          EXEMPT_TAGS +
          " is not an array of tags, so which projects are excused cannot be established",
      );
    }
    for (let index = 0; index < declaredExempt.items.length; index++) {
      const entry = declaredExempt.items[index];
      if (!entry.isString) {
        return Verdict.unknown(
          "params." +
            EXEMPT_TAGS +
            " carries an entry that is not a string, so which projects are excused cannot be " +
            "established",
        );
      }
      exemptTags.push(entry.str);
    }
  }

  let anyProjectCarriesTheTag = false;
  for (let index = 0; index < evidence.model.projects.length; index++) {
    if (evidence.model.projects[index].hasTag(forbiddenTag)) {
      anyProjectCarriesTheTag = true;
      break;
    }
  }
  if (!anyProjectCarriesTheTag) {
    return Verdict.notApplicable(
      'no project in this workspace carries "' +
        forbiddenTag +
        '", so there is no dependency this rule could forbid',
    );
  }

  const findings: Finding[] = [];
  for (let index = 0; index < evidence.graph.edges.length; index++) {
    const edge = evidence.graph.edges[index];
    const target = evidence.project(edge.target);
    if (target == null) {
      return Verdict.unknown(
        'the graph carries an edge into "' +
          edge.target +
          '", which the model does not declare — the two halves of the evidence disagree, and a ' +
          "rule cannot tell whether a project it cannot see carries the tag",
      );
    }
    if (!target.hasTag(forbiddenTag)) continue;

    const source = evidence.project(edge.source);
    if (source == null) {
      return Verdict.unknown(
        'the graph carries an edge out of "' +
          edge.source +
          '", which the model does not declare — the two halves of the evidence disagree, and a ' +
          "rule cannot tell whether a project it cannot see is exempt",
      );
    }
    let exempt = false;
    for (let tag = 0; tag < exemptTags.length; tag++) {
      if (source.hasTag(exemptTags[tag])) {
        exempt = true;
        break;
      }
    }
    if (exempt) continue;

    const finding = new Finding(
      "dependency-on-forbidden-tag",
      source.name + " depends on " + target.name + ', which carries "' + forbiddenTag + '"',
    ).inProject(source.name);
    // The file only when the graph carried one: an edge has no line, and a
    // position invented to fill the shape sends a reader somewhere the
    // dependency is not.
    const sourceFile = edge.sourceFile;
    findings.push(sourceFile == null ? finding : finding.inFile(sourceFile));
  }

  return Verdict.fromFindings(findings);
}

export function archkeep_describe(): i64 {
  return describePacked(RULE);
}

export function archkeep_evaluate(ptr: i32, len: i32): i64 {
  return evaluatePacked(ptr, len, evaluate);
}

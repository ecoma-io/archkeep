"""The reference rule: **no project may depend on a project carrying a
forbidden tag**, unless it carries one of the tags the row exempts.

It is the Python spelling of `../../archkeep-rule-sdk-rust/examples/forbidden_tag_dependency.rs`,
verdict for verdict: both are replayed against the same five evidence bundles
and both must answer the same thing, which is what makes the fixtures a
conformance suite between two SDKs rather than two unrelated test sets.

It exists to be built, committed and RUN — `forbidden_tag_dependency.wasm`
beside this file is the artifact, `forbidden_tag_dependency.wasm.sha256` is the
digest a `customRules` row pins it by, and `../tests/test_golden.py` replays the
fixtures in `../fixtures/` against the function below. `../README.md` holds the
rebuild command and the argument for committing a binary at all.

## What it is a reference OF

Four verdicts, each reachable, because a rule that can only pass and fail has no
way to say it could not look:

- `failed` — an edge lands on a project carrying the forbidden tag, and the
  depending project is not exempt. Every finding names the pair and, when the
  graph carried one, the file the edge was read from.
- `passed` — every edge was read and none of them crossed.
- `not_applicable` — no project in the workspace carries the tag at all, so the
  rule constrains nothing here. Reported rather than absorbed into a passing
  count: a rule nobody is protected by must be visible.
- `unknown` — the parameters are not there to read, or the graph names a project
  the model does not declare. Both are cases where the honest answer is that
  this run reached no verdict; answering `passed` would be a clean workspace
  nobody earned.

## The policy row it is declared by

```jsonc
{
  "name": "forbidden-tag-dependency",
  "artifact": "tools/rules/forbidden_tag_dependency.wasm",
  "sha256": "<the contents of forbidden_tag_dependency.wasm.sha256>",
  "params": { "forbiddenTag": "layer-infrastructure", "exemptTags": ["layer-adapter"] },
  "reason": "..."
}
```
"""

from archkeep_rule_sdk import Finding, from_findings, not_applicable, unknown

#: The tag whose incoming dependencies this rule refuses.
FORBIDDEN_TAG = "forbiddenTag"
#: Tags that excuse a depending project from the rule.
EXEMPT_TAGS = "exemptTags"


def evaluate(evidence):
    forbidden_tag = evidence.rule.params.get(FORBIDDEN_TAG)
    if not isinstance(forbidden_tag, str) or not forbidden_tag:
        return unknown(
            "params.%s is not a non-empty string, so there is no tag to judge dependencies "
            "against — the rule read nothing and concluded nothing" % FORBIDDEN_TAG
        )

    declared_exempt = evidence.rule.params.get(EXEMPT_TAGS)
    if declared_exempt is None:
        exempt_tags = []
    elif isinstance(declared_exempt, list):
        exempt_tags = []
        for entry in declared_exempt:
            if not isinstance(entry, str):
                return unknown(
                    "params.%s carries an entry that is not a string, so which projects are "
                    "excused cannot be established" % EXEMPT_TAGS
                )
            exempt_tags.append(entry)
    else:
        return unknown(
            "params.%s is not an array of tags, so which projects are excused cannot be "
            "established" % EXEMPT_TAGS
        )

    if not any(project.has_tag(forbidden_tag) for project in evidence.projects):
        return not_applicable(
            'no project in this workspace carries "%s", so there is no dependency this rule '
            "could forbid" % forbidden_tag
        )

    findings = []
    for edge in evidence.edges:
        target = evidence.project(edge.target)
        if target is None:
            return unknown(
                'the graph carries an edge into "%s", which the model does not declare — '
                "the two halves of the evidence disagree, and a rule cannot tell whether a "
                "project it cannot see carries the tag" % edge.target
            )
        if not target.has_tag(forbidden_tag):
            continue

        source = evidence.project(edge.source)
        if source is None:
            return unknown(
                'the graph carries an edge out of "%s", which the model does not declare — '
                "the two halves of the evidence disagree, and a rule cannot tell whether a "
                "project it cannot see is exempt" % edge.source
            )
        if any(source.has_tag(tag) for tag in exempt_tags):
            continue

        finding = Finding(
            "dependency-on-forbidden-tag",
            '%s depends on %s, which carries "%s"'
            % (source.name, target.name, forbidden_tag),
        ).in_project(source.name)
        # The file only when the graph carried one: an edge has no line, and a
        # position invented to fill the shape sends a reader somewhere the
        # dependency is not.
        if edge.source_file is not None:
            finding = finding.in_file(edge.source_file)
        findings.append(finding)

    return from_findings(findings)


#: The declaration the carrier turns into `archkeep_describe`'s answer.
#:
#: It sits beside the function it describes, the way the Rust binding's
#: `archkeep_rule!` does, so a finding id and the code that emits it can never be
#: in two files that disagree. The build tool reads it by name; the carrier
#: crate validates its grammar at compile time.
ARCHKEEP_RULE = {
    "name": "forbidden-tag-dependency",
    "needs": ["model", "graph"],
    "findings": [
        {
            "id": "dependency-on-forbidden-tag",
            "message": "a project depends on a project carrying the forbidden tag",
        }
    ],
}

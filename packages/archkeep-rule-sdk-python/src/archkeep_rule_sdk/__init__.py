"""Author a Archkeep custom architecture rule in Python.

`import archkeep_rule_sdk` reaches the same names in both places a rule ever
runs: here, under the author's own CPython, and inside the rule's `.wasm`
carrier, where the build tool registers `runtime.py`'s namespace under this
name in an embedded interpreter that has no filesystem to import from.

Which is why this file re-exports rather than adds: every public name is
`runtime`'s, so the module an author imports is the module the artifact runs.
A helper defined HERE would exist in the tests and be missing in the artifact,
and the difference would surface as an `unknown` verdict in a consumer's CI
rather than as a red test — the silent direction, one import away
(`../../../../AGENTS.md`).
"""

from .runtime import (
    EVIDENCE_KINDS,
    VERDICTS,
    Edge,
    Evidence,
    Finding,
    ImportRecord,
    Policy,
    Project,
    Resolved,
    RuleError,
    RuleInstance,
    Spelling,
    UndeclaredEvidence,
    Verdict,
    drive,
    failed,
    from_findings,
    not_applicable,
    passed,
    unknown,
)

__all__ = [
    "EVIDENCE_KINDS",
    "VERDICTS",
    "Edge",
    "Evidence",
    "Finding",
    "ImportRecord",
    "Policy",
    "Project",
    "Resolved",
    "RuleError",
    "RuleInstance",
    "Spelling",
    "UndeclaredEvidence",
    "Verdict",
    "drive",
    "failed",
    "from_findings",
    "not_applicable",
    "passed",
    "unknown",
]

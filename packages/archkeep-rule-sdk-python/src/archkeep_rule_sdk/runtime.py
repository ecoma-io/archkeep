"""The authoring runtime: evidence access, verdict construction, and the one
entry point both runners call.

This module is the load-bearing file of the package, and the constraint that
shapes every line of it is that it runs in TWO interpreters:

- the author's own CPython, where `tests/test_golden.py` replays the golden
  fixtures against a rule;
- an embedded RustPython compiled into the rule's `.wasm` carrier, where the
  engine's host actually judges a workspace
  (`../../../archkeep/src/custom-rules/host.mjs`).

So it **imports nothing**. Not as a style preference: the carrier's interpreter
is built without the frozen Python standard library, and `import re`,
`import json`, `import collections` and `import os` all raise there — measured,
and the set that does exist is listed in `../../README.md`. A module-level
import here would load fine under CPython, fail inside the artifact, and the
difference would only surface as an `unknown` verdict in a consumer's CI. The
same rule binds an author's `rule.py`, which is why the README says it first.

`drive` is the single entry point. The carrier calls it, and so does the golden
suite — the two runners differ in which interpreter executes this file, and in
nothing else. A second entry point would be the place where the tested path and
the shipped path drifted apart.
"""

# The four evidence kinds contract 1 carries, in the order the wire contract
# lists them (`../../../../docs/reference/custom-rules.md`). A rule declares the
# subset it reads in `ARCHKEEP_RULE["needs"]`; an entry outside this tuple makes
# the rule's verdict `unknown` at load, named by the engine rather than guessed
# at here.
EVIDENCE_KINDS = ("model", "graph", "imports", "policy")

# The four-state vocabulary, spelled as the wire spells it.
VERDICTS = ("pass", "fail", "unknown", "not_applicable")

_MISSING = object()


class RuleError(Exception):
    """A rule that cannot be driven at all.

    Raised for the shapes a verdict must never be able to take — a `fail` with
    no findings, a `reason` that is empty — so that the hollow verdict the host
    would refuse cannot be constructed in the first place. It is not what a rule
    raises to report a workspace problem: that is `unknown`.
    """


class UndeclaredEvidence(RuleError):
    """A rule reading an evidence kind its own `needs` does not declare.

    The engine hands a rule what it asked for, and the carrier converts only
    that — so a kind left out of `needs` is not merely undeclared, it is not
    there. Raising is the whole point: returning the empty collection instead
    would be a rule judging a workspace over evidence it never received, and
    finding nothing.
    """


# ---------------------------------------------------------------------------
# Evidence
# ---------------------------------------------------------------------------


class Project:
    """One project, as the workspace's provider reported it."""

    __slots__ = ("name", "root", "tags")

    def __init__(self, raw):
        self.name = raw["name"]
        self.root = raw["root"]
        self.tags = raw["tags"]

    def has_tag(self, tag) -> bool:
        """Whether this project carries `tag`, compared exactly.

        Exact rather than prefix- or glob-matched, mirroring the Rust binding:
        a tag vocabulary belongs to the workspace, and a rule that matched
        `layer-` loosely would be inventing a grammar the workspace never
        agreed to.
        """
        return tag in self.tags


class Edge:
    """One dependency edge.

    `type` is whatever string the workspace's graph provider emitted, not a
    fixed vocabulary — contract 1 does not fix one, and a rule that refused an
    unfamiliar spelling would be failing on a fact it did not need.
    """

    __slots__ = ("source", "target", "type", "source_file")

    def __init__(self, raw):
        self.source = raw["source"]
        self.target = raw["target"]
        self.type = raw["type"]
        # Absent is normal rather than exceptional: `nx graph --file=` emits no
        # `sourceFile` on any edge.
        self.source_file = raw.get("sourceFile")


class Spelling:
    """How a specifier is written, in the language it was written in."""

    __slots__ = ("path", "relative")

    def __init__(self, raw):
        self.path = raw["path"]
        self.relative = raw["relative"]


class Resolved:
    """Where a specifier points, when the analyzer could say."""

    __slots__ = ("target", "file", "external", "package_name")

    def __init__(self, raw):
        self.target = raw["target"]
        self.file = raw["file"]
        self.external = raw["external"]
        self.package_name = raw["packageName"]


class ImportRecord:
    """One import site: one written import, not one resolved dependency.

    A file importing the same project three times yields three of these.
    `resolved` is `None` when the analyzer could not say where the specifier
    points — a recorded blind spot, never a dropped record and never a guess.
    """

    __slots__ = (
        "source_project",
        "source_file",
        "line",
        "column",
        "specifier",
        "kind",
        "spelling",
        "resolved",
    )

    def __init__(self, raw):
        self.source_project = raw["sourceProject"]
        self.source_file = raw["sourceFile"]
        self.line = raw["line"]
        self.column = raw["column"]
        self.specifier = raw["specifier"]
        self.kind = raw["kind"]
        self.spelling = Spelling(raw["spelling"])
        resolved = raw["resolved"]
        self.resolved = None if resolved is None else Resolved(resolved)

    def position(self):
        """This site's `(line, column)`, or `None` when either is not 1-based.

        `None` rather than a clamp, for the reason the host states: every
        position this tool reports is 1-based, and a finding pointing at line 0
        sends a reader to a line no file has.
        """
        if isinstance(self.line, int) and isinstance(self.column, int):
            if self.line >= 1 and self.column >= 1:
                return (self.line, self.column)
        return None


class Policy:
    """The two fields of a loaded policy contract 1 carries.

    Both arrive as the plain JSON the engine loaded, deliberately un-modelled:
    the constraint-row schema has exactly one owner
    (`../../../archkeep/src/config.mjs`), and a second model of it here would be
    a dialect that drifts from the one the engine actually enforces.
    """

    __slots__ = ("dep_constraints", "module_boundary_options")

    def __init__(self, raw):
        self.dep_constraints = raw["depConstraints"]
        self.module_boundary_options = raw["moduleBoundaryOptions"]


class RuleInstance:
    """The declared policy row, as the bundle carries it."""

    __slots__ = ("name", "params")

    def __init__(self, raw):
        self.name = raw["name"]
        # `{}` when the row declared none. The engine writes that default into
        # the BUNDLE and never back onto the policy, so a rule reading an empty
        # mapping cannot tell whether the workspace wrote `params: {}` or left
        # the field out — and must not need to.
        self.params = raw["params"]


class Evidence:
    """Everything a rule is handed, and the only thing it is ever handed.

    Each collection is materialized on first access rather than in the
    constructor, and each one first checks that the rule DECLARED the kind it
    comes from. Both halves matter: laziness keeps a `[model, graph]` rule from
    paying for a workspace's every import site, and the declaration check is
    what stops the same rule from silently reading an empty list where the
    carrier converted nothing.
    """

    __slots__ = (
        "contract",
        "rule",
        "needs",
        "_raw",
        "_projects",
        "_edges",
        "_imports",
        "_policy",
        "_index",
    )

    def __init__(self, raw, needs):
        self.contract = raw["contract"]
        # `rule` is not an evidence kind — the bundle carries it beside them —
        # so it is always readable, whatever the rule declared.
        self.rule = RuleInstance(raw["rule"])
        self.needs = tuple(needs)
        self._raw = raw
        self._projects = _MISSING
        self._edges = _MISSING
        self._imports = _MISSING
        self._policy = _MISSING
        self._index = _MISSING

    def _declared(self, kind, attribute):
        if kind not in self.needs:
            raise UndeclaredEvidence(
                'this rule reads evidence.%s, and its needs are (%s) — add "%s" to '
                "ARCHKEEP_RULE['needs'] so the engine hands it over. A rule is given the kinds "
                "it declares and nothing else, so reading one it did not declare would be "
                "judging a workspace over evidence that never arrived"
                % (attribute, ", ".join(self.needs) or "none", kind)
            )

    @property
    def projects(self):
        """Every project the run covers, in name order. Needs `model`."""
        if self._projects is _MISSING:
            self._declared("model", "projects")
            self._projects = [
                Project(entry) for entry in self._raw["model"]["projects"]
            ]
        return self._projects

    @property
    def edges(self):
        """Every dependency edge, in source/target/type/file order. Needs `graph`."""
        if self._edges is _MISSING:
            self._declared("graph", "edges")
            self._edges = [Edge(entry) for entry in self._raw["graph"]["edges"]]
        return self._edges

    @property
    def imports(self):
        """Every import site the analyzers read, in source order. Needs `imports`.

        Source order is part of the analysis contract rather than an accident —
        the engine deliberately does not sort this list.
        """
        if self._imports is _MISSING:
            self._declared("imports", "imports")
            self._imports = [ImportRecord(entry) for entry in self._raw["imports"]]
        return self._imports

    @property
    def policy(self):
        """The loaded policy, as the engine read it. Needs `policy`."""
        if self._policy is _MISSING:
            self._declared("policy", "policy")
            self._policy = Policy(self._raw["policy"])
        return self._policy

    def project(self, name):
        """The project called `name`, or `None` when the model does not declare it.

        `None` is a fact worth acting on rather than a lookup miss to shrug at:
        an edge naming a project the model lacks means the two halves of the
        evidence disagree, and the honest answer to that is `unknown`.
        """
        if self._index is _MISSING:
            self._index = {project.name: project for project in self.projects}
        return self._index.get(name)


# ---------------------------------------------------------------------------
# Verdicts
# ---------------------------------------------------------------------------


def _require_text(value, what):
    if not isinstance(value, str) or not value:
        raise RuleError("%s is %r, and it has to be a non-empty string" % (what, value))
    return value


class Finding:
    """One thing a rule found, and where.

    The position setters are the reason this is a class rather than a mapping:
    `at` takes a file and a 1-based position TOGETHER, so "a position with no
    file" — which the host refuses — cannot be written.
    """

    __slots__ = ("id", "message", "source_file", "line", "column", "project")

    def __init__(self, id, message):
        # `id` must appear in this rule's own catalogue. That check is the
        # HOST's to make and is deliberately not repeated here: two validators
        # agree only until one of them is edited, and the one that decides a
        # consumer's build is the one in the engine.
        self.id = _require_text(id, "a finding's id")
        self.message = _require_text(message, "a finding's message")
        self.source_file = None
        self.line = None
        self.column = None
        self.project = None

    def in_file(self, source_file) -> "Finding":
        """Attributes the finding to a workspace-relative file."""
        self.source_file = _require_text(source_file, "a finding's sourceFile")
        return self

    def at(self, source_file, line, column) -> "Finding":
        """Attributes the finding to a 1-based position in a file."""
        self.in_file(source_file)
        for axis, value in (("line", line), ("column", column)):
            if not isinstance(value, int) or isinstance(value, bool) or value < 1:
                raise RuleError(
                    "a finding's %s is %r, and positions are 1-based integers"
                    % (axis, value)
                )
        self.line = line
        self.column = column
        return self

    def in_project(self, project) -> "Finding":
        """Attributes the finding to a project."""
        self.project = _require_text(project, "a finding's project")
        return self

    def to_wire(self) -> dict:
        """This finding as the mapping the ABI carries back."""
        wire = {"id": self.id, "message": self.message}
        if self.source_file is not None:
            wire["sourceFile"] = self.source_file
        if self.line is not None:
            wire["line"] = self.line
            wire["column"] = self.column
        if self.project is not None:
            wire["project"] = self.project
        return wire


class Verdict:
    """What a rule says about one workspace.

    Written through the four module-level functions below, which is what a rule
    should read like — but the obligations are enforced HERE rather than there,
    so a verdict built any other way carries them too. The Rust binding gets the
    same guarantee from its types: `Verdict::fail` takes a list that cannot be
    empty, `Verdict::pass` takes nothing. Python has no such type, so the
    constructor is where "hollow is unrepresentable" has to live.

    The obligations run in BOTH directions, which is the half that is easy to
    miss: a `reason` on a passing verdict is a rule that meant `unknown` and
    said `pass`, and that is precisely the mistake the four-state vocabulary
    exists to refuse.
    """

    __slots__ = ("kind", "findings", "reason", "not_applicable_reason")

    def __init__(self, kind, findings=(), reason=None, not_applicable_reason=None):
        if kind not in VERDICTS:
            raise RuleError(
                "%r is not a verdict — the vocabulary is %s"
                % (kind, ", ".join(VERDICTS))
            )
        findings = list(findings)
        for index, finding in enumerate(findings):
            if not isinstance(finding, Finding):
                raise RuleError(
                    "findings[%d] is %r, and a verdict's findings are Finding objects"
                    % (index, finding)
                )
        if kind == "fail" and not findings:
            raise RuleError(
                "a failing verdict that names no finding says nothing about what failed — "
                "use passed() when there is nothing to report, or unknown(reason) when the "
                "rule could not look"
            )
        if kind != "fail" and findings:
            raise RuleError(
                '"%s" carries %d finding(s), and only "fail" names findings — a rule that '
                "found something failed" % (kind, len(findings))
            )
        for field, value, requires in (
            ("reason", reason, "unknown"),
            ("notApplicableReason", not_applicable_reason, "not_applicable"),
        ):
            if kind == requires and not (isinstance(value, str) and value):
                raise RuleError(
                    '"%s" is a claim about what could not be established, and its %s is %r — '
                    "a reader has to be told which" % (requires, field, value)
                )
            if kind != requires and value is not None:
                raise RuleError(
                    '"%s" carries a %s, which only "%s" carries — a rule that meant "%s" and '
                    'said "%s" would be read as having decided'
                    % (kind, field, requires, requires, kind)
                )
        self.kind = kind
        self.findings = findings
        self.reason = reason
        self.not_applicable_reason = not_applicable_reason

    def to_wire(self) -> dict:
        """This verdict as the mapping the ABI carries back.

        `contract` is absent on purpose: the carrier's Rust half writes it, so
        the contract version lives in exactly one place per artifact rather than
        in this file and in the crate at once.
        """
        wire = {"verdict": self.kind, "findings": [f.to_wire() for f in self.findings]}
        if self.reason is not None:
            wire["reason"] = self.reason
        if self.not_applicable_reason is not None:
            wire["notApplicableReason"] = self.not_applicable_reason
        return wire


def passed() -> Verdict:
    """The rule looked and found nothing.

    A CLAIM about the workspace, not a shrug: it says the rule read the evidence
    it declared it needs and there was nothing to report. A rule that could not
    read that evidence answers `unknown` instead
    (`../../../../AGENTS.md`: an empty result is a claim, not a shrug).

    Spelled `passed` rather than `pass` because `pass` is a Python keyword;
    `failed` follows it so the pair reads as one vocabulary.
    """
    return Verdict("pass")


def failed(findings) -> Verdict:
    """The rule found something, and the findings say what.

    An empty list is refused at construction: `fail` with nothing named is what
    the host calls a hollow verdict, and a rule that could reach it would report
    a failure nobody can act on.
    """
    return Verdict("fail", findings)


def unknown(reason) -> Verdict:
    """The rule could not reach a judgment, and `reason` says why.

    The verdict for every path that would otherwise return an empty list it did
    not earn: a parameter that is not there, an evidence kind that arrived
    malformed, two halves of the bundle that disagree. Any `unknown` makes the
    run exit 3 — "could not look" is a distinct outcome from "looked and found
    nothing", and the exit codes keep it that way.
    """
    return Verdict("unknown", reason=reason)


def not_applicable(reason) -> Verdict:
    """The rule does not apply to this run, and `reason` says why.

    Not a quieter `passed`: it is counted and reported separately, because a
    rule nobody is being protected by has to be visible rather than absorbed
    into a passing count.
    """
    return Verdict("not_applicable", not_applicable_reason=reason)


def from_findings(findings) -> Verdict:
    """`passed()` when the list is empty, `failed(...)` when it is not.

    The shape most rules end in, and the one place emptiness legitimately means
    "clean" — because the caller has just finished looking.
    """
    findings = list(findings)
    return failed(findings) if findings else passed()


# ---------------------------------------------------------------------------
# The entry point both runners call
# ---------------------------------------------------------------------------


def _where(exception) -> str:
    """The call chain an exception came from, as `function:line` steps.

    Walked by hand off `__traceback__` because the `traceback` module is not
    importable inside the carrier — measured, and one of the reasons the README
    lists what is. Without this an author's TypeError would reach them as a
    reason naming no line at all.
    """
    steps = []
    frame = getattr(exception, "__traceback__", None)
    while frame is not None:
        code = frame.tb_frame.f_code
        steps.append("%s:%d" % (code.co_name, frame.tb_lineno))
        frame = frame.tb_next
    return " -> ".join(steps) if steps else "an unrecorded frame"


def drive(evaluate, bundle, needs) -> dict:
    """Runs one rule over one evidence bundle and returns the wire verdict.

    The one entry point, called by the carrier's Rust half inside the artifact
    and by `tests/test_golden.py` under the author's own CPython. Everything
    that happens between "here is a parsed bundle" and "here is a verdict
    mapping" happens here, once, so the path a test exercises is the path the
    artifact runs.

    `needs` is the rule's own declared evidence kinds, and it is a required
    argument rather than a default for one reason: the carrier converts only
    the declared kinds, so a runner that did not pass them would let a rule
    read a kind under CPython that is not there inside the artifact. The test
    would be green and the consumer's `check` would answer `unknown` — the two
    halves of this package disagreeing about what a rule is allowed to see.

    Every failure becomes `unknown` with the cause named, and that includes an
    exception the rule did not expect. Letting it propagate would be loud too,
    but it would be loud DIFFERENTLY in the two runners — a traceback in the
    test, a trap in the artifact — and a golden suite whose two halves fail in
    different shapes cannot pin the shape of a failure at all.
    """
    try:
        verdict = evaluate(Evidence(bundle, needs))
    except UndeclaredEvidence as error:
        return unknown("%s (at %s)" % (error, _where(error))).to_wire()
    except RuleError as error:
        return unknown(
            "the rule built a verdict the contract has no place for: %s (at %s)"
            % (error, _where(error))
        ).to_wire()
    # Broad on purpose: a rule may raise anything, and the docstring above
    # argues why every one of those becomes an `unknown` rather than escaping.
    except Exception as error:
        return unknown(
            "the rule raised %s: %s (at %s)"
            % (type(error).__name__, error, _where(error))
        ).to_wire()

    if not isinstance(verdict, Verdict):
        return unknown(
            "the rule's evaluate returned %r, and a rule returns a Verdict — passed(), "
            "failed(findings), unknown(reason) or not_applicable(reason)" % (verdict,)
        ).to_wire()
    return verdict.to_wire()

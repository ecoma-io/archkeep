// The verdict, and the shapes of it the type system refuses to build.
//
// The host calls a verdict that breaks one of its obligations **hollow** and
// refuses it — a `fail` naming no finding, a `pass` carrying one, an `unknown`
// with no reason, a reason on a verdict that is not `unknown`
// (`../../lattice/src/custom-rules/host.mjs`, `verdictViolation`). Every one of
// those is a rule that returned a shape instead of a judgment.
//
// This module makes as many of them as AssemblyScript allows impossible to
// write rather than merely refused later:
//
// - `Verdict.fail` takes `Findings`, whose constructor requires the finding
//   that makes it non-empty. A failing verdict that names nothing has no
//   spelling.
// - `Verdict.pass` takes nothing, so it cannot carry a finding.
// - `Verdict.unknown` and `Verdict.notApplicable` take their reason as an
//   argument rather than a setter, and neither reason field is reachable from
//   any other constructor.
// - `Finding.at` takes a file and both coordinates together, so a position with
//   no file cannot be written.
//
// ## What this type system cannot hold, and who refuses it instead
//
// Three things, named because a reader has to know where the line is:
//
// - **An empty string.** AssemblyScript has no non-empty-string type, so
//   `Finding.new("", "")` and `Verdict.unknown("")` compile. The host refuses
//   both by name, and this package does not check them a second time — two
//   validators agree only until one is edited.
// - **A zeroth line.** Rust's `NonZeroU32` has no AssemblyScript equivalent, so
//   `Finding.at(file, 0, 0)` compiles here where it does not there. The host
//   refuses it ("positions are 1-based integers"), and `ImportRecord.position`
//   (`./evidence.ts`) is the path that cannot produce one — it answers
//   `null` for a zero rather than clamping.
// - **A finding id the catalogue does not declare.** The host refuses it, for
//   the SARIF reason its own comment gives. `../test/golden.test.mjs` is where
//   this package catches its own instance of that, before a consumer does.

import { CONTRACT } from "./declaration";
import { quoteJsonString } from "./json";

/** The four-state vocabulary every judgment in this engine speaks. */
export const enum VerdictKind {
  /** The rule looked and found nothing. */
  Pass = 0,
  /** The rule found something, and every finding names what. */
  Fail = 1,
  /** The rule could not reach a judgment, and says why. */
  Unknown = 2,
  /** The rule does not apply to this run, and says why. */
  NotApplicable = 3,
}

/** The wire spelling of one verdict. */
function verdictKindName(kind: VerdictKind): string {
  if (kind == VerdictKind.Pass) return "pass";
  if (kind == VerdictKind.Fail) return "fail";
  if (kind == VerdictKind.Unknown) return "unknown";
  return "not_applicable";
}

/** A position no import site carries, and the value an absent one is held as. */
const NO_POSITION: i32 = 0;

/**
 * One thing a rule found.
 *
 * `id` must be an id this rule's own catalogue declares — the host refuses a
 * finding it cannot resolve, because SARIF would drop it. That check is the
 * host's and is deliberately not repeated here.
 *
 * The optional halves are held as `string | null` and as `0` for an absent
 * position, and both are omitted from the serialized form rather than written
 * as `null`: the contract's optional keys are absent-or-present, and a `null`
 * where the host expects a string is a hollow verdict.
 */
export class Finding {
  private id: string;
  private message: string;
  private sourceFile: string | null = null;
  private line: i32 = NO_POSITION;
  private column: i32 = NO_POSITION;
  private project: string | null = null;

  /**
   * A finding with no location, naming the catalogue entry it belongs to and
   * what it found.
   *
   * The message is what a reader acts on, so it is the finding's own sentence
   * rather than the catalogue's template — the catalogue says what the id
   * MEANS, this says what happened here.
   */
  constructor(id: string, message: string) {
    this.id = id;
    this.message = message;
  }

  /**
   * Places the finding in a file, with no position inside it.
   *
   * The case this exists for is a graph edge: an edge may carry a `sourceFile`
   * and never carries a line, so a rule judging edges can name the file
   * honestly and must not invent `1:1` to fill the shape.
   */
  inFile(sourceFile: string): Finding {
    this.sourceFile = sourceFile;
    return this;
  }

  /**
   * Places the finding at a 1-based position in a file.
   *
   * File and position move together because the host refuses a position with no
   * file — "a position with no file sends a reader to a line in nothing".
   * `ImportRecord.position` (`./evidence.ts`) hands over the pair an import site
   * already carries, and answers `null` rather than a zero when it has none.
   */
  at(sourceFile: string, line: i32, column: i32): Finding {
    this.sourceFile = sourceFile;
    this.line = line;
    this.column = column;
    return this;
  }

  /** Attributes the finding to a project. */
  inProject(project: string): Finding {
    this.project = project;
    return this;
  }

  /**
   * This finding as the JSON object a verdict carries.
   *
   * Key order is the contract's: `id`, `message`, `sourceFile`, `line`,
   * `column`, `project`.
   */
  toJson(): string {
    let out = '{"id":' + quoteJsonString(this.id);
    out += ',"message":' + quoteJsonString(this.message);
    const sourceFile = this.sourceFile;
    if (sourceFile != null) out += ',"sourceFile":' + quoteJsonString(sourceFile);
    if (this.line != NO_POSITION) out += ',"line":' + this.line.toString();
    if (this.column != NO_POSITION) out += ',"column":' + this.column.toString();
    const project = this.project;
    if (project != null) out += ',"project":' + quoteJsonString(project);
    return out + "}";
  }
}

/**
 * One or more findings.
 *
 * A list that cannot be empty, which is the whole point: it is the argument
 * type of `Verdict.fail`, so "this rule failed and named nothing" has no
 * spelling. There is no `length` or `isEmpty` on purpose — the answer to
 * `isEmpty` is always false, and a caller asking it has forgotten what this
 * type is for.
 */
export class Findings {
  /** The findings, in the order they were added. Never empty. */
  items: Finding[];

  /** Starts a non-empty list from the finding that makes it non-empty. */
  constructor(first: Finding) {
    this.items = [first];
  }

  /** Adds a finding, keeping the list non-empty by construction. */
  with(finding: Finding): Findings {
    this.items.push(finding);
    return this;
  }

  /**
   * The non-empty list an array holds, or `null` when it holds nothing.
   *
   * `null` is the caller's cue that there is nothing to fail over — and
   * `Verdict.fromFindings` is the one-line way to answer it correctly.
   */
  static fromArray(findings: Finding[]): Findings | null {
    if (findings.length == 0) return null;
    const list = new Findings(findings[0]);
    for (let index = 1; index < findings.length; index++) list.items.push(findings[index]);
    return list;
  }
}

/**
 * What a rule answers.
 *
 * Constructed only through the four verdict constructors, so the invariants the
 * host checks hold by construction rather than by care.
 */
export class Verdict {
  private kind: VerdictKind;
  private findings: Finding[];
  private reason: string | null;
  private notApplicableReason: string | null;

  private constructor(
    kind: VerdictKind,
    findings: Finding[],
    reason: string | null,
    notApplicableReason: string | null,
  ) {
    this.kind = kind;
    this.findings = findings;
    this.reason = reason;
    this.notApplicableReason = notApplicableReason;
  }

  /**
   * The rule looked and found nothing.
   *
   * This is a CLAIM about the workspace, not a shrug: it says the rule read the
   * evidence it declared it needs and there was nothing to report. A rule that
   * could not read that evidence answers `Verdict.unknown` instead
   * (`../../../AGENTS.md`).
   */
  static pass(): Verdict {
    return new Verdict(VerdictKind.Pass, [], null, null);
  }

  /** The rule found something, and the findings say what. */
  static fail(findings: Findings): Verdict {
    return new Verdict(VerdictKind.Fail, findings.items, null, null);
  }

  /**
   * The rule could not reach a judgment, and `reason` says why.
   *
   * This is the verdict for every path that would otherwise return an empty
   * list it did not earn: a parameter that is not there, an evidence kind that
   * arrived malformed, two halves of the bundle that disagree. Any `unknown`
   * makes the run exit 3 — "could not look" is a distinct outcome from "looked
   * and found nothing", and the exit codes keep it that way.
   */
  static unknown(reason: string): Verdict {
    return new Verdict(VerdictKind.Unknown, [], reason, null);
  }

  /**
   * The rule does not apply to this run, and `reason` says why.
   *
   * Not a quieter `pass`: it is counted and reported separately, because a rule
   * that never applies is a rule nobody is being protected by, and that has to
   * be visible rather than absorbed into a passing count.
   */
  static notApplicable(reason: string): Verdict {
    return new Verdict(VerdictKind.NotApplicable, [], null, reason);
  }

  /**
   * `pass` when the list is empty, `fail` when it is not.
   *
   * The shape most rules end in, and the one place emptiness legitimately means
   * "clean" — because the caller has just finished looking. A rule that reaches
   * here without having looked has already gone wrong somewhere above, which is
   * what `Verdict.unknown` is for.
   */
  static fromFindings(findings: Finding[]): Verdict {
    const list = Findings.fromArray(findings);
    if (list == null) return Verdict.pass();
    return Verdict.fail(list);
  }

  /** Which of the four this is. */
  verdictKind(): VerdictKind {
    return this.kind;
  }

  /**
   * The verdict as the UTF-8 JSON text the ABI carries back.
   *
   * `findings` is written even when empty — "every verdict states its findings,
   * and a clean rule states the empty list rather than leaving the field out".
   */
  toJson(): string {
    let out = '{"contract":' + CONTRACT.toString();
    out += ',"verdict":' + quoteJsonString(verdictKindName(this.kind));
    out += ',"findings":[';
    for (let index = 0; index < this.findings.length; index++) {
      if (index > 0) out += ",";
      out += this.findings[index].toJson();
    }
    out += "]";
    const reason = this.reason;
    if (reason != null) out += ',"reason":' + quoteJsonString(reason);
    const notApplicableReason = this.notApplicableReason;
    if (notApplicableReason != null) {
      out += ',"notApplicableReason":' + quoteJsonString(notApplicableReason);
    }
    return out + "}";
  }
}

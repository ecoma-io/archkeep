/**
 * The versioned JSON envelope every command's `--format json` wraps its
 * result in — one wrapper, six commands, so a consumer writes one parser
 * rather than one per command. `../../../../docs/reference/json-output.md` is the
 * published contract this module builds; this file is where the contract's
 * three consistency rules are enforced in code rather than left to a
 * docs page a later command author might not read.
 *
 * **This module knows no command's payload.** `jsonEnvelope` takes `result` as
 * an opaque object and writes it through unchanged — `../../cli.mjs`'s `check`
 * builds its own `result.violations`/`result.goWork`/`result.tsconfigPaths`,
 * and a later command builds its own. Payload shape lives with the command
 * that produces it, which is what keeps this file untouched by every command
 * after the first (`../commands/README.md` states the same split one layer
 * down).
 *
 * The three assertions below are the empty-result invariant
 * (`../../../../AGENTS.md`) in executable form, not merely documented: a caller
 * that got one of them wrong would otherwise ship a JSON file claiming a clean
 * run over a tree this tool never finished reading, and nothing downstream
 * would ever see the mistake. They throw rather than degrade on purpose — a
 * mismatch here is a bug in the command that built the envelope, not a fact
 * about the workspace being judged, so it gets a programming error rather than
 * a diagnostic.
 *
 * The optional `decision` field rides the same posture. It carries the
 * canonical 4-state verdict (`../governance/verdict.mjs`) that every
 * governance capability emits and consumes, and its `verdict` must agree
 * with the envelope's `status` the same way `status` and `exitCode` must:
 * `"ok"` implies `"pass"`, `"findings"` implies `"fail"`, `"no-verdict"`
 * implies `"unknown"`. A decision that contradicts its status would make one
 * of them a lie — the exact class of disagreement this module refuses to
 * ship. The same refusal covers the invariant the uncertain verdict carries:
 * an `"unknown"` decision must name the reason no verdict was reached, so a
 * hand-built decision cannot slip a reason-less "no verdict" past the last
 * boundary it crosses. The field is OPTIONAL (absent on every envelope that
 * does not opt in), which is what keeps SCHEMA_VERSION at 2: additive,
 * byte-compatible with every consumer that reads the envelope today.
 */
import { verdictForStatus } from "../governance/verdict.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** @type {{name: string, version: string}} */
const { name: TOOL_NAME, version: TOOL_VERSION } = require("../../package.json");

/**
 * The schema version this build writes. An integer, per
 * `docs/reference/json-output.md`'s stability promise: it only moves for a
 * breaking change to the envelope, and a consumer that reads a
 * `schemaVersion` it does not recognise should refuse to parse the rest of
 * the envelope rather than guess — an unrecognised version is a caller
 * reading a contract from the future, not a workspace fact. Nothing in this
 * package reads its own envelope back, so that refusal is advice to the
 * consumer, not a mechanism enforced here.
 */
export const SCHEMA_VERSION = 2;

/** The one `status`↔`exitCode` mapping every command's envelope must agree with. */
const EXIT_CODE_FOR_STATUS = Object.freeze({ ok: 0, findings: 1, "no-verdict": 3 });

/**
 * Builds the envelope, asserting the three invariants that keep it from ever
 * claiming more than a run actually established.
 *
 * @param {{command: string, context: {root: string, provider: "nx"|"native"|"moon", marker: string,
 *   provenance?: {commit: string, remote: string|null, dirty: boolean}|null},
 *   status: "ok"|"findings"|"no-verdict", exitCode: 0|1|3,
 *   coverage: {complete: boolean, projects: number, analyzedFiles: number, imports: number,
 *     notAnalyzed: object[], blindSpots: object[], notes: string[], coverageGaps?: object[]},
 *   result: object,
 *   decision?: {verdict: string, reason?: string, notApplicableReason?: string,
 *     sampleTime?: string}}} run
 * @returns {object} The envelope `docs/reference/json-output.md` documents.
 * @throws {Error} when `status` claims `"ok"` over incomplete coverage, when
 *   `status` and `exitCode` disagree, when `coverage.complete` disagrees
 *   with whether `coverage.notAnalyzed` is empty, or when the optional
 *   `decision.verdict` contradicts the envelope's `status`.
 */
export function jsonEnvelope({ command, context, status, exitCode, coverage, result, decision }) {
  if (status === "ok" && coverage.complete !== true) {
    throw new Error(
      `lattice: refusing to build a JSON envelope claiming status "ok" over incomplete coverage ` +
        `(coverage.complete: false) — a caller cannot report a clean run over a tree it could not ` +
        `fully read. This is a bug in the command that built this envelope, not a fact about the ` +
        `workspace being judged.`,
    );
  }
  if (EXIT_CODE_FOR_STATUS[status] !== exitCode) {
    throw new Error(
      `lattice: refusing to build a JSON envelope where status "${status}" and exitCode ${exitCode} ` +
        `disagree — status "${status}" must carry exitCode ${EXIT_CODE_FOR_STATUS[status]}. A ` +
        `consumer reading a file written by --output has only these two fields to trust; letting ` +
        `them disagree would make one of them a lie.`,
    );
  }
  if (coverage.complete !== (coverage.notAnalyzed.length === 0)) {
    throw new Error(
      `lattice: refusing to build a JSON envelope where coverage.complete (${coverage.complete}) ` +
        `disagrees with coverage.notAnalyzed (${coverage.notAnalyzed.length} entr${coverage.notAnalyzed.length === 1 ? "y" : "ies"}) ` +
        `— the two must always agree, or a reader checking only one of them could mistake a partial ` +
        `run for a complete one.`,
    );
  }
  // A bare `null` decision is the same programming error as a hand-built
  // decision that contradicts its status: refuse it with the named message
  // rather than crash on `decision.verdict` with a raw TypeError.
  if (decision !== undefined && (decision === null || typeof decision !== "object")) {
    throw new Error(
      `lattice: refusing to build a JSON envelope where decision is ${decision === null ? "null" : `a ${typeof decision}`} ` +
        `rather than an object — a decision must carry a verdict that agrees with its status. ` +
        `This is a bug in the command that built the envelope.`,
    );
  }
  if (decision != null) {
    const implied = verdictForStatus(status);
    if (decision.verdict !== implied) {
      throw new Error(
        `lattice: refusing to build a JSON envelope where decision.verdict "${decision.verdict}" ` +
          `contradicts status "${status}" — status implies ${implied}, and a ` +
          `decision that disagrees with its own status would make one of the two a lie. ` +
          `This is a bug in the command that built the envelope.`,
      );
    }
    // I3, enforced again at this boundary — `src/governance/evidence.mjs`
    // already guarantees it for the engine path, but a hand-built decision
    // would otherwise ship an "unknown" without the reason I3 requires and
    // only this boundary would ever see the mistake. I2 (findings on "fail")
    // gets no latch here for the same reason I4 gets none: the other
    // invariants already pin every route a "fail" can take — `verdictForStatus`
    // only returns "fail" for a "findings" status, and this module knows no
    // command's payload, so counting findings would mean reaching into
    // `result`. A hand-built "fail" with no findings is still a loud lie
    // (status "findings", exitCode 1, verdict "fail"), never the silent
    // direction.
    if (decision.verdict === "unknown" && decision.reason === undefined) {
      throw new Error(
        `lattice: refusing to build a JSON envelope where an "unknown" decision has no reason — ` +
          `I3: an unknown verdict must say why no verdict was reached, or it reads as a shrug. ` +
          `This is a bug in the command that built the envelope.`,
      );
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    command,
    workspace: {
      root: context.root,
      provider: context.provider,
      marker: context.marker,
      provenance: context.provenance ?? null,
    },
    status,
    exitCode,
    coverage,
    result,
    ...(decision == null ? {} : { decision }),
  };
}

/**
 * The envelope as bytes: two-space indent and a trailing newline, so a file
 * written by `--output` reads the same as every other file this tool writes
 * and diffs cleanly in a pull request.
 *
 * @param {object} envelope From `jsonEnvelope`.
 * @returns {string}
 */
export function renderJson(envelope) {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

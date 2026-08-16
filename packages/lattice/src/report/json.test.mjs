import { describe, expect, it } from "vitest";

import { jsonEnvelope, renderJson, SCHEMA_VERSION } from "./json.mjs";

/** @type {{root: string, provider: "nx"|"native"|"moon", marker: string, provenance: null}} */
const context = { root: "/w", provider: "nx", marker: "nx.json", provenance: null };

const cleanCoverage = () => ({
  complete: true,
  projects: 1,
  analyzedFiles: 3,
  imports: 5,
  notAnalyzed: [],
  blindSpots: [],
  notes: [],
  coverageGaps: [],
});

describe("jsonEnvelope", () => {
  it("builds the envelope a clean run produces", () => {
    const envelope = jsonEnvelope({
      command: "check",
      context,
      status: "ok",
      exitCode: 0,
      coverage: cleanCoverage(),
      result: { violations: [] },
    });
    expect(envelope).toEqual({
      schemaVersion: SCHEMA_VERSION,
      tool: { name: "@ecoma-io/lattice", version: expect.any(String) },
      command: "check",
      workspace: { root: "/w", provider: "nx", marker: "nx.json", provenance: null },
      status: "ok",
      exitCode: 0,
      coverage: cleanCoverage(),
      result: { violations: [] },
    });
  });

  it("throws rather than write status ok over incomplete coverage", () => {
    // The load-bearing case. A caller that got this wrong would ship a JSON
    // file claiming a clean run over a tree this tool never finished reading
    // — the silent direction the empty-result invariant (AGENTS.md) refuses.
    // A weaker test that only checked the message text, and not that it
    // throws before returning anything, would still pass a caller that
    // logged the message and returned the envelope anyway.
    expect(() =>
      jsonEnvelope({
        command: "check",
        context,
        status: "ok",
        exitCode: 0,
        coverage: { ...cleanCoverage(), complete: false, notAnalyzed: [{ file: "a.go" }] },
        result: {},
      }),
    ).toThrow(/status "ok".*incomplete coverage/s);
  });

  it("throws when status and exitCode disagree", () => {
    expect(() =>
      jsonEnvelope({
        command: "check",
        context,
        status: "findings",
        exitCode: 0,
        coverage: cleanCoverage(),
        result: {},
      }),
    ).toThrow(/status "findings" and exitCode 0 disagree/);

    expect(() =>
      jsonEnvelope({
        command: "check",
        context,
        status: "no-verdict",
        exitCode: 1,
        coverage: { ...cleanCoverage(), complete: false, notAnalyzed: [{ file: "a.go" }] },
        result: {},
      }),
    ).toThrow(/status "no-verdict" and exitCode 1 disagree/);
  });

  it("throws when coverage.complete disagrees with coverage.notAnalyzed", () => {
    // Both directions of the disagreement, since either alone would let a
    // reader checking only one of the two fields mistake a partial run for a
    // complete one.
    expect(() =>
      jsonEnvelope({
        command: "check",
        context,
        status: "findings",
        exitCode: 1,
        coverage: { ...cleanCoverage(), complete: true, notAnalyzed: [{ file: "a.go" }] },
        result: {},
      }),
    ).toThrow(/coverage\.complete \(true\) disagrees with coverage\.notAnalyzed \(1 entry\)/);

    expect(() =>
      jsonEnvelope({
        command: "check",
        context,
        status: "no-verdict",
        exitCode: 3,
        coverage: { ...cleanCoverage(), complete: false, notAnalyzed: [] },
        result: {},
      }),
    ).toThrow(/coverage\.complete \(false\) disagrees with coverage\.notAnalyzed \(0 entries\)/);
  });

  it("accepts status findings and no-verdict with their required exit codes", () => {
    expect(() =>
      jsonEnvelope({
        command: "check",
        context,
        status: "findings",
        exitCode: 1,
        coverage: cleanCoverage(),
        result: {},
      }),
    ).not.toThrow();
    expect(() =>
      jsonEnvelope({
        command: "check",
        context,
        status: "no-verdict",
        exitCode: 3,
        coverage: { ...cleanCoverage(), complete: false, notAnalyzed: [{ file: "a.go" }] },
        result: {},
      }),
    ).not.toThrow();
  });

  it("carries coverageGaps through the envelope when polyglot manifests exist without the plugin", () => {
    const coverage = {
      ...cleanCoverage(),
      coverageGaps: [{ kind: "unregistered-plugin", manifests: ["libs/a/go.mod"] }],
    };
    const envelope = jsonEnvelope({
      command: "check",
      context,
      status: "ok",
      exitCode: 0,
      coverage,
      result: {},
    });
    expect(envelope.coverage.coverageGaps).toEqual([
      { kind: "unregistered-plugin", manifests: ["libs/a/go.mod"] },
    ]);
  });

  it("writes an optional decision through when present, and omits it when absent", () => {
    // The additive contract: `decision` is a field a command opts into, and
    // its absence keeps an envelope byte-compatible with one predating it.
    const withDecision = jsonEnvelope({
      command: "check",
      context,
      status: "findings",
      exitCode: 1,
      coverage: cleanCoverage(),
      result: { violations: [{}] },
      decision: { verdict: "fail" },
    });
    expect(withDecision.decision).toEqual({ verdict: "fail" });

    const withoutDecision = jsonEnvelope({
      command: "check",
      context,
      status: "findings",
      exitCode: 1,
      coverage: cleanCoverage(),
      result: { violations: [{}] },
    });
    expect(Object.hasOwn(withoutDecision, "decision")).toBe(false);
  });

  it("throws when decision.verdict contradicts the envelope's status — the two must never lie", () => {
    // The silent direction: a decision that disagrees with its own status
    // would let a reader trust whichever field it read first.
    expect(() =>
      jsonEnvelope({
        command: "check",
        context,
        status: "findings",
        exitCode: 1,
        coverage: cleanCoverage(),
        result: { violations: [{}] },
        decision: { verdict: "pass" },
      }),
    ).toThrow(/decision\.verdict "pass" contradicts status "findings"/);

    expect(() =>
      jsonEnvelope({
        command: "check",
        context,
        status: "ok",
        exitCode: 0,
        coverage: cleanCoverage(),
        result: {},
        decision: { verdict: "not_applicable", notApplicableReason: "why" },
      }),
    ).toThrow(/decision\.verdict "not_applicable" contradicts status "ok"/);

    // The third status, pinned for the same reason as the other two: an
    // "unknown" decision on a findings envelope would read as could-not-look
    // while the envelope's status names a certain violation — one of the two
    // is a lie.
    expect(() =>
      jsonEnvelope({
        command: "check",
        context,
        status: "findings",
        exitCode: 1,
        coverage: cleanCoverage(),
        result: { violations: [{}] },
        decision: { verdict: "unknown", reason: "coverage was incomplete" },
      }),
    ).toThrow(/decision\.verdict "unknown" contradicts status "findings"/);
  });

  it("refuses a decision that is null or not an object, with the named message rather than a raw TypeError", () => {
    // Minor from R1: `decision: null` used to pass the `!== undefined` guard
    // and crash on `.verdict` — loud, but a confusing programming error
    // instead of the "refusing to build a JSON envelope" message the other
    // guards give.
    expect(() =>
      jsonEnvelope({
        command: "check",
        context,
        status: "ok",
        exitCode: 0,
        coverage: cleanCoverage(),
        result: {},
        decision: null,
      }),
    ).toThrow(/decision is null .*rather than an object/);

    expect(() =>
      jsonEnvelope({
        command: "check",
        context,
        status: "ok",
        exitCode: 0,
        coverage: cleanCoverage(),
        result: {},
        // A cast: the test deliberately feeds a non-object decision (the
        // guard rejects it), which the envelope's JSDoc does not admit.
        decision: /** @type {any} */ ("pass"),
      }),
    ).toThrow(/decision is a string .*rather than an object/);
  });

  it("refuses an unknown decision without a reason", () => {
    // R1 latch: jsonEnvelope is the last boundary a hand-built decision
    // crosses, so the invariant I3 (reason on unknown) from
    // governance/evidence.mjs is enforced here too — the current engine
    // path never reaches this (buildDecision always supplies a reason), but
    // a future command building a decision by hand must not be able to ship
    // a reason-less "no verdict" past this boundary.
    expect(() =>
      jsonEnvelope({
        command: "check",
        context,
        status: "no-verdict",
        exitCode: 3,
        coverage: cleanCoverage(),
        result: {},
        decision: { verdict: "unknown" },
      }),
    ).toThrow(/an "unknown" decision has no reason/);
  });
});

describe("renderJson", () => {
  it("renders two-space indent with a trailing newline, so a written file diffs cleanly", () => {
    const envelope = jsonEnvelope({
      command: "check",
      context,
      status: "ok",
      exitCode: 0,
      coverage: cleanCoverage(),
      result: { violations: [] },
    });
    const rendered = renderJson(envelope);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered).not.toMatch(/\n\n$/);
    expect(JSON.parse(rendered)).toEqual(envelope);
    // Two-space indent, checked directly rather than only round-tripped
    // through JSON.parse — a round-trip alone would pass any indent width.
    expect(rendered.split("\n")[1]).toBe(`  "schemaVersion": ${SCHEMA_VERSION},`);
  });

  it("is stable across two calls over the same envelope", () => {
    const envelope = jsonEnvelope({
      command: "check",
      context,
      status: "ok",
      exitCode: 0,
      coverage: cleanCoverage(),
      result: { violations: [] },
    });
    expect(renderJson(envelope)).toBe(renderJson(envelope));
  });
});

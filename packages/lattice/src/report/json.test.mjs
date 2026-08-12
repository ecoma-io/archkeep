import { describe, expect, it } from "vitest";

import { jsonEnvelope, renderJson, SCHEMA_VERSION } from "./json.mjs";

/** @type {{root: string, provider: "nx"|"native", marker: string}} */
const context = { root: "/w", provider: "nx", marker: "nx.json" };

const cleanCoverage = () => ({
  complete: true,
  projects: 1,
  analyzedFiles: 3,
  imports: 5,
  notAnalyzed: [],
  blindSpots: [],
  notes: [],
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
      workspace: { root: "/w", provider: "nx", marker: "nx.json" },
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

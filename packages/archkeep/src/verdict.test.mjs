import { describe, expect, it } from "vitest";

import { EXIT, verdictFor } from "./verdict.mjs";

/**
 * The `check` fold's input latch (INV-4's gap, Phase 1-A): `verdictFor`'s
 * counts arrive as an untyped object, so a misspelled or missing count key
 * used to destructure to `undefined` — and `undefined > 0` is `false` in
 * every lane, so the missing count read as zero and a failing run could
 * pass. Every case here plants that defect class and requires the loud
 * refusal instead: no-verdict, exit 3, the malformed key named. Each has a
 * control beside it proving the counts are readable when spelled right, so
 * "everything refuses" cannot pass this file either.
 */

/** Full-coverage clean counts — every required key present and zero. */
function cleanCounts() {
  return {
    violations: 0,
    declaredEdgeFindings: 0,
    goWorkDrift: 0,
    tsconfigPathsDead: 0,
    intentFindings: 0,
    intentUnresolved: 0,
    unchecked: 0,
    analyzed: 12,
    blindSpots: 0,
  };
}

describe("verdictFor input latch", () => {
  it("keeps the findings lane for correctly spelled counts (control)", () => {
    const verdict = verdictFor({ ...cleanCounts(), violations: 3 });
    expect(verdict.status).toBe("findings");
    expect(verdict.exitCode).toBe(EXIT.violations);
  });

  it("keeps the ok lane for clean counts (control)", () => {
    const verdict = verdictFor(cleanCounts());
    expect(verdict.status).toBe("ok");
    expect(verdict.exitCode).toBe(EXIT.ok);
  });

  it("refuses a misspelled finding count instead of reading it as zero", () => {
    // The planted defect: `violation`, not `violations`. Under the fold's
    // pre-latch shape the misspelled key fell out of the destructure and
    // this run — three boundary violations — read ok/exit 0.
    const verdict = verdictFor(/** @type {any} */ ({ ...cleanCounts(), violation: 3 }));
    expect(verdict.status).toBe("no-verdict");
    expect(verdict.exitCode).toBe(EXIT.error);
    expect(verdict.reasons.join(" ")).toContain('"violation"');
  });

  it("refuses a misspelled optional count instead of reading it as zero", () => {
    // Same class on an optional key: a failing fitness function whose count
    // key is misspelled used to vanish — `fitnessFail` defaulted to 0.
    const verdict = verdictFor(/** @type {any} */ ({ ...cleanCounts(), fitnessFails: 2 }));
    expect(verdict.status).toBe("no-verdict");
    expect(verdict.exitCode).toBe(EXIT.error);
    expect(verdict.reasons.join(" ")).toContain('"fitnessFails"');
  });

  it("refuses a missing coverage count instead of reading it as zero", () => {
    // `unchecked` absent: the fold's no-verdict lane tests `unchecked > 0`,
    // so a missing key read "fully covered" while the decision's
    // `coverageComplete` said otherwise — the exit code said ok.
    const { unchecked, ...withoutUnchecked } = cleanCounts();
    expect(unchecked).toBe(0);
    const verdict = verdictFor(/** @type {any} */ (withoutUnchecked));
    expect(verdict.status).toBe("no-verdict");
    expect(verdict.exitCode).toBe(EXIT.error);
    expect(verdict.reasons.join(" ")).toContain('"unchecked"');
  });

  it("refuses a missing analyzed count instead of skipping the nothing-analyzed lane", () => {
    // `analyzed` absent: the lane tests `analyzed === 0`, and `undefined`
    // does not equal 0 — a run that analyzed nothing read ok.
    const { analyzed, ...withoutAnalyzed } = cleanCounts();
    expect(analyzed).toBe(12);
    const verdict = verdictFor(/** @type {any} */ (withoutAnalyzed));
    expect(verdict.status).toBe("no-verdict");
    expect(verdict.exitCode).toBe(EXIT.error);
    expect(verdict.reasons.join(" ")).toContain('"analyzed"');
  });

  it("refuses a non-integer count instead of folding it", () => {
    // A string count survives `> 0` by coercion while corrupting the
    // findings sum; the latch names the key and the value's type.
    const verdict = verdictFor(/** @type {any} */ ({ ...cleanCounts(), violations: "3" }));
    expect(verdict.status).toBe("no-verdict");
    expect(verdict.exitCode).toBe(EXIT.error);
    expect(verdict.reasons.join(" ")).toContain('"violations"');
  });

  it("refuses counts that are not an object at all", () => {
    const verdict = verdictFor(null);
    expect(verdict.status).toBe("no-verdict");
    expect(verdict.exitCode).toBe(EXIT.error);
  });

  it("carries the refusal on the decision the envelope renders", () => {
    const verdict = verdictFor(/** @type {any} */ ({ ...cleanCounts(), violation: 3 }));
    // `buildDecision` speaks the 4-state verb: no-verdict is "unknown",
    // with the malformed key named in the reason a reader acts on.
    expect(verdict.decision.verdict).toBe("unknown");
    expect(verdict.decision.reason).toContain('"violation"');
  });
});

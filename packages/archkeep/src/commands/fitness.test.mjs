import { describe, expect, it } from "vitest";

import { fitnessFold } from "./fitness.mjs";

/**
 * The `fitness` exit fold's input latch (INV-4's gap, Phase 1-A): the fold
 * hand-rolled its status/exit literal over `overall.verdict`, and a verdict
 * outside the four states matched neither the fail nor the unknown arm — it
 * fell to `ok`, a clean exit over a run the fold could not read.
 * `fitnessVerdictFor` already latches the rows it folds, so the stranger
 * reaching THIS fold means the handshake between the two broke; the fold
 * refuses it in-band rather than fabricating the loudest clean state. Every
 * case here plants that defect class and requires the refusal; the controls
 * beside them prove the four real verdicts still map unchanged.
 */

/** One judged row, for the `decisions` list the table renders downstream. */
const ROW = { id: "fitness:no-cycles", verdict: "pass" };

describe("fitnessFold input latch", () => {
  it("keeps the findings lane for a failed run (control)", () => {
    const fold = fitnessFold({ verdict: "fail", decisions: [ROW] });
    expect(fold.status).toBe("findings");
    expect(fold.exitCode).toBe(1);
  });

  it("keeps the no-verdict lane for an undetermined run (control)", () => {
    const fold = fitnessFold({ verdict: "unknown", decisions: [ROW] });
    expect(fold.status).toBe("no-verdict");
    expect(fold.exitCode).toBe(3);
  });

  it("keeps the ok lane for a passing run (control)", () => {
    const fold = fitnessFold({ verdict: "pass", decisions: [ROW] });
    expect(fold.status).toBe("ok");
    expect(fold.exitCode).toBe(0);
  });

  it("keeps the ok lane for an all-not-applicable run (control)", () => {
    const fold = fitnessFold({ verdict: "not_applicable", decisions: [] });
    expect(fold.status).toBe("ok");
    expect(fold.exitCode).toBe(0);
  });

  it("refuses a misspelled overall verdict instead of reading it as ok", () => {
    // The planted defect: `fial`, not `fail`. Pre-latch the stranger matched
    // neither the fail nor the unknown arm and fell to the ok arm — a
    // failing fitness run exiting 0 with no error anywhere.
    const fold = fitnessFold({ verdict: "fial", decisions: [ROW] });
    expect(fold.status).toBe("no-verdict");
    expect(fold.exitCode).toBe(3);
    expect(fold.refused).toContain('"overall.verdict"');
    expect(fold.refused).toContain("fial");
  });

  it("refuses a missing overall verdict instead of reading it as ok", () => {
    const fold = fitnessFold(/** @type {any} */ ({ decisions: [ROW] }));
    expect(fold.status).toBe("no-verdict");
    expect(fold.exitCode).toBe(3);
    expect(fold.refused).toContain('"overall.verdict"');
  });

  it("refuses an overall that is not an object instead of crashing on it", () => {
    const fold = fitnessFold(undefined);
    expect(fold.status).toBe("no-verdict");
    expect(fold.exitCode).toBe(3);
    expect(fold.refused).toContain('"overall.verdict"');
  });

  it("refuses a decisions list that is not an array instead of rendering it empty", () => {
    // The verdict table the command reports is built from `decisions`
    // downstream of the fold; a non-array there rendered as an empty table —
    // a judged run presenting zero functions.
    const fold = fitnessFold({ verdict: "pass", decisions: null });
    expect(fold.status).toBe("no-verdict");
    expect(fold.exitCode).toBe(3);
    expect(fold.refused).toContain('"overall.decisions"');
  });
});

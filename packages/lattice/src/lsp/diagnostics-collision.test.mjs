/**
 * The load-time guard in `./diagnostics.mjs`: `ANALYSIS_FAILURE_CODE` must
 * never collide with an upstream message id, because a reader could not then
 * tell "a rule found something" from "no rule could look".
 *
 * The guard is asserted by mocking `../rules/messages.mjs` to contain the
 * failure code, then importing the module and expecting the throw. The real
 * `MESSAGE_IDS` does not contain it, so only a mock can drive the guard —
 * which is exactly what this file is for.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../rules/messages.mjs", () => ({ MESSAGE_IDS: ["analysisFailure"] }));

describe("the analysis-failure code guard", () => {
  it("refuses to load when the failure code is now an upstream message id", async () => {
    vi.resetModules();
    await expect(import("./diagnostics.mjs")).rejects.toThrow(
      /'analysisFailure' is now an upstream messageId/,
    );
  });
});

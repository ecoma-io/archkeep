import { describe, expect, it } from "vitest";

import { describeStatus } from "./status.mjs";

describe("describeStatus", () => {
  it("names the workspace it is checking", () => {
    const status = describeStatus({ state: "start", root: "/repo", serverPath: "/repo/lsp.mjs" });

    expect(status.severity).toBe("information");
    expect(status.detail).toContain("/repo");
  });

  it("renders a blocked workspace as an error", () => {
    // The one assertion in this file that is really about the project's
    // invariant rather than about a label: the state where nothing looked has to
    // be visually distinct from the state where nothing was found, and "warning"
    // is not distinct enough for a tool whose whole claim is that silence means
    // clean.
    const status = describeStatus({
      state: "blocked",
      root: "/repo",
      reason: "@ecoma-io/lattice is not installed in /repo",
      searched: [],
    });

    expect(status.severity).toBe("error");
    expect(status.detail).toBe("@ecoma-io/lattice is not installed in /repo");
  });

  it("renders a folder that is not a workspace as information", () => {
    const status = describeStatus({
      state: "idle",
      reason: "No workspace marker above /elsewhere.",
    });

    expect(status.severity).toBe("information");
  });

  it("gives every state a distinguishable label", () => {
    const labels = [
      describeStatus({ state: "start", root: "/repo", serverPath: "/x" }),
      describeStatus({ state: "idle", reason: "x" }),
      describeStatus({ state: "blocked", root: "/repo", reason: "x", searched: [] }),
    ].map((status) => status.text);

    expect(new Set(labels).size).toBe(labels.length);
  });

  it("throws on a state it does not know instead of describing it neutrally", () => {
    // A fourth state that fell through to "information" would be a new way for
    // this extension to look fine while doing nothing.
    // The whole point is input outside `SessionPlan`, so the cast is the test.
    expect(() => describeStatus(/** @type {any} */ ({ state: "degraded" }))).toThrow(/degraded/);
  });
});

import { describe, expect, it } from "vitest";

import { describeStatus, renderStatusItem } from "./status.mjs";

// Stand-ins for `LanguageStatusSeverity`'s members, which this package's tests
// reach only as values — the real enum's numbers are the runtime's business,
// and these are them (Information = 0, Warning = 1, Error = 2).
const SEVERITY = { information: 0, warning: 1, error: 2 };

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
      reason: "@ecoma-io/archkeep is not installed in /repo",
      searched: [],
    });

    expect(status.severity).toBe("error");
    expect(status.detail).toBe("@ecoma-io/archkeep is not installed in /repo");
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

describe("renderStatusItem", () => {
  it("lands a blocked workspace on the editor's error severity", () => {
    // The invariant's last hop. `describeStatus` answering "error" as a string
    // and the editor showing an error are connected by this lookup alone, so
    // this is where "blocked must render as error" is pinned end to end — a
    // table that mapped blocked to warning would pass every other test in
    // this file.
    const rendered = renderStatusItem(
      describeStatus({ state: "blocked", root: "/repo", reason: "no server", searched: [] }),
      SEVERITY,
    );

    expect(rendered.severity).toBe(SEVERITY.error);
    expect(rendered.text).toBe("Archkeep: not checking");
    expect(rendered.detail).toBe("no server");
  });

  it("carries the healthy states across at information", () => {
    const start = renderStatusItem(
      describeStatus({ state: "start", root: "/repo", serverPath: "/repo/lsp.mjs" }),
      SEVERITY,
    );
    const idle = renderStatusItem(
      describeStatus({ state: "idle", reason: "not a workspace" }),
      SEVERITY,
    );

    expect(start.severity).toBe(SEVERITY.information);
    expect(idle.severity).toBe(SEVERITY.information);
  });

  it("throws on a severity no editor value is mapped for", () => {
    // `undefined` assigned onto the item would let the editor pick its own
    // default — a fourth severity falling into silence instead of an error.
    expect(() =>
      renderStatusItem(
        /** @type {any} */ ({ text: "x", detail: "x", severity: "degraded" }),
        SEVERITY,
      ),
    ).toThrow(/degraded/);
  });
});

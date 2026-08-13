import { describe, expect, it, vi } from "vitest";

import { planSession } from "./session.mjs";

/** @type {import("./server-module.mjs").ServerLocation} */
const FOUND = {
  path: "/repo/node_modules/@ecoma-io/lattice/lsp.mjs",
  source: "workspace",
  searched: [],
};

describe("planSession", () => {
  it("starts the server against the workspace root, not the open folder", () => {
    // The root is what the plan carries forward into `initializationOptions`,
    // and it is the reason the walk happens at all: hand the server `apps/api`
    // and it analyzes a workspace that has no projects in it.
    const plan = planSession({
      folderPath: "/repo/apps/api",
      findRoot: () => "/repo",
      locateServer: () => FOUND,
    });

    expect(plan).toStrictEqual({
      state: "start",
      root: "/repo",
      serverPath: FOUND.path,
    });
  });

  it("goes idle without looking for a server when there is no workspace", () => {
    const locateServer = vi.fn();

    const plan = planSession({
      folderPath: "/somewhere/else",
      findRoot: () => null,
      locateServer,
    });

    expect(plan.state).toBe("idle");
    expect(plan.reason).toContain("/somewhere/else");
    expect(locateServer).not.toHaveBeenCalled();
  });

  it("blocks, loudly, when the workspace is ours and the server is missing", () => {
    // The distinction this function exists to preserve. Both this and the case
    // above produce an empty Problems panel; only one of them is a workspace
    // whose boundaries are going unchecked, and it must not render as idle.
    const plan = planSession({
      folderPath: "/repo",
      findRoot: () => "/repo",
      locateServer: () => ({
        path: null,
        source: null,
        searched: ["/repo/node_modules/@ecoma-io/lattice/lsp.mjs"],
        reason: "not installed",
      }),
    });

    expect(plan).toStrictEqual({
      state: "blocked",
      root: "/repo",
      reason: "not installed",
      searched: ["/repo/node_modules/@ecoma-io/lattice/lsp.mjs"],
    });
  });

  it("passes the configured path through to the locator", () => {
    const locateServer = vi.fn(() => FOUND);

    planSession({
      folderPath: "/repo",
      configuredServerPath: "tools/lsp.mjs",
      findRoot: () => "/repo",
      locateServer,
    });

    expect(locateServer).toHaveBeenCalledWith({
      nxRoot: "/repo",
      configuredPath: "tools/lsp.mjs",
    });
  });

  it("still names a reason when the locator supplies none", () => {
    const plan = planSession({
      folderPath: "/repo",
      findRoot: () => "/repo",
      locateServer: () => ({ path: null, source: null, searched: [] }),
    });

    expect(plan.state).toBe("blocked");
    expect(plan.reason).toContain("/repo");
  });
});

import { describe, expect, it } from "vitest";

import { findNxRoot, WORKSPACE_MARKERS } from "./workspace-root.mjs";

/** An `exists` over a described set of paths, so no test touches a disk. */
function tree(...paths) {
  const present = new Set(paths);
  return (path) => present.has(path);
}

describe("findNxRoot", () => {
  it("finds nx.json in the folder itself", () => {
    expect(findNxRoot("/repo", tree(`/repo/${WORKSPACE_MARKERS[0]}`))).toBe("/repo");
  });

  it("finds lattice.json in the folder itself", () => {
    expect(findNxRoot("/repo", tree(`/repo/${WORKSPACE_MARKERS[1]}`))).toBe("/repo");
  });

  it("finds it above a folder opened deep inside the workspace", () => {
    // The case this function exists for: someone opens `apps/api`, not the
    // repository root. The server never walks upward, so if the client does not
    // do it here the whole folder is analyzed against no workspace at all.
    expect(findNxRoot("/repo/apps/api/src", tree(`/repo/${WORKSPACE_MARKERS[0]}`))).toBe("/repo");
  });

  it("stops at the nearest root when workspaces are nested", () => {
    expect(
      findNxRoot(
        "/repo/vendor/plugin/src",
        tree(`/repo/${WORKSPACE_MARKERS[0]}`, `/repo/vendor/plugin/${WORKSPACE_MARKERS[0]}`),
      ),
    ).toBe("/repo/vendor/plugin");
  });

  it("returns null when there is no workspace marker anywhere above", () => {
    // The silent-direction case. A walk that returned the filesystem root on a
    // miss would hand the server `/` and have it analyze the whole disk.
    expect(findNxRoot("/somewhere/else", tree())).toBeNull();
  });

  it("terminates at the filesystem root instead of looping on it", () => {
    let checks = 0;
    const counted = (path) => {
      checks += 1;
      return tree()(path);
    };

    expect(findNxRoot("/", counted)).toBeNull();
    // Two markers checked at the root, then done — no loop.
    expect(checks).toBe(WORKSPACE_MARKERS.length);
  });

  it("normalises the starting directory before walking", () => {
    expect(findNxRoot("/repo/apps/../apps/api", tree(`/repo/apps/${WORKSPACE_MARKERS[0]}`))).toBe(
      "/repo/apps",
    );
  });

  it("prefers nx.json when both markers exist at the same level", () => {
    // Both markers present: both are valid workspace roots, and the walk
    // returns the first one it finds. nx.json is listed first in
    // WORKSPACE_MARKERS, so it wins at the same level — consistent with the
    // CLI, which also checks nx.json first.
    expect(
      findNxRoot("/repo", tree(`/repo/${WORKSPACE_MARKERS[0]}`, `/repo/${WORKSPACE_MARKERS[1]}`)),
    ).toBe("/repo");
  });
});

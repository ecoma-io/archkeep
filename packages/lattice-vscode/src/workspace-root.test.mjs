import { describe, expect, it } from "vitest";

import { findNxRoot, NX_CONFIG_FILE } from "./workspace-root.mjs";

/** An `exists` over a described set of paths, so no test touches a disk. */
function tree(...paths) {
  const present = new Set(paths);
  return (path) => present.has(path);
}

describe("findNxRoot", () => {
  it("finds nx.json in the folder itself", () => {
    expect(findNxRoot("/repo", tree(`/repo/${NX_CONFIG_FILE}`))).toBe("/repo");
  });

  it("finds it above a folder opened deep inside the workspace", () => {
    // The case this function exists for: someone opens `apps/api`, not the
    // repository root. The server never walks upward, so if the client does not
    // do it here the whole folder is analyzed against no workspace at all.
    expect(findNxRoot("/repo/apps/api/src", tree(`/repo/${NX_CONFIG_FILE}`))).toBe("/repo");
  });

  it("stops at the nearest root when workspaces are nested", () => {
    expect(
      findNxRoot(
        "/repo/vendor/plugin/src",
        tree(`/repo/${NX_CONFIG_FILE}`, `/repo/vendor/plugin/${NX_CONFIG_FILE}`),
      ),
    ).toBe("/repo/vendor/plugin");
  });

  it("returns null when there is no nx.json anywhere above", () => {
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
    expect(checks).toBe(1);
  });

  it("normalises the starting directory before walking", () => {
    expect(findNxRoot("/repo/apps/../apps/api", tree(`/repo/apps/${NX_CONFIG_FILE}`))).toBe(
      "/repo/apps",
    );
  });
});

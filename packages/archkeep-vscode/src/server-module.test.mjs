import { describe, expect, it } from "vitest";

import { locateServer, SERVER_ENTRY, SERVER_PACKAGE } from "./server-module.mjs";

const INSTALLED_ENTRY = `/repo/node_modules/${SERVER_PACKAGE}/${SERVER_ENTRY}`;
const INSTALLED_MANIFEST = `/repo/node_modules/${SERVER_PACKAGE}/package.json`;

/** An `exists` over a described set of paths. */
function tree(...paths) {
  const present = new Set(paths);
  return (path) => present.has(path);
}

/** A resolver that answers for one workspace root and nothing else. */
function resolvesIn(root, manifest) {
  return (from) => (from === root ? manifest : null);
}

describe("locateServer", () => {
  it("uses the package Node resolves from the workspace root", () => {
    const located = locateServer({
      nxRoot: "/repo",
      exists: tree(INSTALLED_ENTRY),
      resolvePackageJson: resolvesIn("/repo", INSTALLED_MANIFEST),
    });

    expect(located).toMatchObject({ path: INSTALLED_ENTRY, source: "workspace" });
  });

  it("falls back to the literal node_modules path when resolution answers nothing", () => {
    // pnpm's store, a hoisted install, or an extension host whose own module
    // graph cannot see the workspace all land here. It is a fallback and not the
    // first attempt, because it is wrong often enough to not deserve priority.
    const located = locateServer({
      nxRoot: "/repo",
      exists: tree(INSTALLED_ENTRY),
      resolvePackageJson: () => null,
    });

    expect(located).toMatchObject({ path: INSTALLED_ENTRY, source: "workspace" });
  });

  it("reports where it looked when the package is not installed", () => {
    // The state the whole module exists to make loud: nothing is checking. The
    // assertions are on the paths rather than on the wording, so a reworded
    // sentence stays green and a search that stopped trying somewhere does not.
    const located = locateServer({
      nxRoot: "/repo",
      exists: tree(),
      resolvePackageJson: () => null,
    });

    expect(located.path).toBeNull();
    expect(located.searched).toStrictEqual([INSTALLED_ENTRY]);
    expect(located.reason).toContain(SERVER_PACKAGE);
    expect(located.reason).toContain("/repo");
  });

  it("prefers a configured absolute path over the installed package", () => {
    const located = locateServer({
      nxRoot: "/repo",
      configuredPath: "/opt/archkeep/lsp.mjs",
      exists: tree("/opt/archkeep/lsp.mjs", INSTALLED_ENTRY),
      resolvePackageJson: resolvesIn("/repo", INSTALLED_MANIFEST),
    });

    expect(located).toMatchObject({ path: "/opt/archkeep/lsp.mjs", source: "setting" });
  });

  it("resolves a configured relative path against the workspace root", () => {
    const located = locateServer({
      nxRoot: "/repo",
      configuredPath: "tools/lsp.mjs",
      exists: tree("/repo/tools/lsp.mjs"),
      resolvePackageJson: () => null,
    });

    expect(located).toMatchObject({ path: "/repo/tools/lsp.mjs", source: "setting" });
  });

  it("refuses to fall back when a configured path points at nothing", () => {
    // Silently running a different server than the one someone named is how a
    // wrong answer gets trusted, so this stays blocked even though the package
    // is installed and would have worked.
    const located = locateServer({
      nxRoot: "/repo",
      configuredPath: "tools/lsp.mjs",
      exists: tree(INSTALLED_ENTRY),
      resolvePackageJson: resolvesIn("/repo", INSTALLED_MANIFEST),
    });

    expect(located.path).toBeNull();
    expect(located.searched).toStrictEqual(["/repo/tools/lsp.mjs"]);
    expect(located.reason).toContain("archkeep.server.path");
  });

  it("treats a blank setting as unset", () => {
    const located = locateServer({
      nxRoot: "/repo",
      configuredPath: "   ",
      exists: tree(INSTALLED_ENTRY),
      resolvePackageJson: resolvesIn("/repo", INSTALLED_MANIFEST),
    });

    expect(located).toMatchObject({ path: INSTALLED_ENTRY, source: "workspace" });
  });

  it("does not search the same path twice", () => {
    const located = locateServer({
      nxRoot: "/repo",
      exists: tree(),
      resolvePackageJson: resolvesIn("/repo", INSTALLED_MANIFEST),
    });

    expect(located.searched).toStrictEqual([INSTALLED_ENTRY]);
  });
});

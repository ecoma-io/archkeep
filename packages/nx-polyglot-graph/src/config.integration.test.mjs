import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_OPTIONS } from "./options.mjs";

import { loadBoundaryConfig } from "./config.mjs";

/**
 * Drives the loader against this workspace's real root, which is the whole point
 * of the module: the table it reads is the same one every other reader of the
 * boundary law reads, so this is the tripwire for the two drifting apart. A
 * constraint row that gains a misspelt field would pass an editor's eye and fail
 * only later, as a rule that silently matches nothing — this fails first, here,
 * naming the row.
 *
 * The root is reached by walking up from this file rather than by asking the
 * loader to find it, because finding it is the one thing the loader is forbidden
 * to do: it takes the tree it judges as an argument (`./config.mjs` says why),
 * so a test that wants this tree has to name it. Two levels up from `src/` is
 * the package, one more is the workspace root.
 */
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("loadBoundaryConfig over this workspace", () => {
  it("loads the boundary table every reader of the law reads, and finds it well-formed", async () => {
    const { depConstraints, options } = await loadBoundaryConfig(
      workspaceRoot,
      DEFAULT_OPTIONS.boundaryConfig,
    );

    expect(depConstraints.length).toBeGreaterThan(0);
    // Every row names a source, or it constrains nothing while reading as a rule.
    for (const row of depConstraints) {
      expect(typeof row.sourceTag === "string" || Array.isArray(row.allSourceTags)).toBe(true);
    }
    // All eight options stated, none guessed — the reason the file exports them
    // at all is that an implicit option is one only ESLint knows the value of.
    expect(Object.keys(options).sort()).toEqual([
      "allow",
      "allowCircularSelfDependency",
      "banTransitiveDependencies",
      "buildTargets",
      "checkDynamicDependenciesExceptions",
      "checkNestedExternalImports",
      "enforceBuildableLibDependency",
      "ignoredCircularDependencies",
    ]);
  });

  it("gives every exemption this workspace has taken a reason a reader can weigh", async () => {
    // The suppression list is where a violation someone accepted goes, and the
    // failure mode is not a crash — it is an entry nobody can judge later,
    // sitting in the file that decides what the boundary means. The list is
    // empty in this tree today, so what this pins is the bar the FIRST entry
    // will be held to: `loadBoundaryConfig` already rejects a reason-less entry,
    // and this adds that a real entry has to say something rather than merely
    // say a string.
    const { suppressions } = await loadBoundaryConfig(
      workspaceRoot,
      DEFAULT_OPTIONS.boundaryConfig,
    );
    expect(Array.isArray(suppressions)).toBe(true);
    for (const entry of suppressions) {
      expect(entry.path, JSON.stringify(entry)).toBeTruthy();
      expect(
        entry.reason.trim().split(/\s+/u).length,
        `${entry.path} explains itself`,
      ).toBeGreaterThan(3);
    }
  });

  it("resolves the config against the tree it is judging, not against its own location", async () => {
    // This is the property that makes the tool usable at all. Installed from a
    // registry, its own directory sits inside the consumer's `node_modules`
    // while the config it must read is at the consumer's root. A loader that
    // walked up from `import.meta.url` would read whatever config happened to
    // sit above its install location — the wrong tree's rules — and report green
    // on rules nobody there wrote.
    const elsewhere = mkdtempSync(join(tmpdir(), "polyglot-boundaries-"));
    afterAll(() => rmSync(elsewhere, { recursive: true, force: true }));

    await expect(loadBoundaryConfig(elsewhere, DEFAULT_OPTIONS.boundaryConfig)).rejects.toThrow(
      new RegExp(`cannot load ${elsewhere}/${DEFAULT_OPTIONS.boundaryConfig}`),
    );
  });

  it("reads the filename its caller resolved rather than one it decided for itself", async () => {
    // The filename is a per-workspace option now, so the loader takes it. A
    // workspace that renamed its law, read by a loader that kept a constant,
    // would produce "cannot load module-boundaries.config.mjs" — a message that
    // reads like a missing config when the truth is a misconfigured tool.
    // Pointing it at a name this tree does not use is what proves the argument
    // is the thing being used.
    await expect(loadBoundaryConfig(workspaceRoot, "boundaries.not-here.mjs")).rejects.toThrow(
      /cannot load .*boundaries\.not-here\.mjs/u,
    );
  });
});

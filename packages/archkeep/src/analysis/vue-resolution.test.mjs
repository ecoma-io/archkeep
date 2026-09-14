/**
 * Where the Vue analyzer's SFC parser comes from: the analyzed workspace's own
 * install first, archkeep's second, and a named refusal when neither has it
 * (the refusal's exact message is pinned in `vue-missing-parser.test.mjs`).
 *
 * Two halves. The workspace-first half needs a real filesystem to prove the
 * winner is the WORKSPACE's copy and not archkeep's: a fixture tree with a
 * `node_modules/vue/compiler-sfc` stub whose behaviour archkeep's installed
 * Vue cannot produce. The fallback half is driven through the seam
 * (`resolveSfcParser`'s second argument), which replaces each hop's requirer
 * with an in-memory fake, so a fake root like `/w` never touches the disk.
 *
 * The TypeScript analyzer is a project-internal collaborator (AGENTS.md test
 * taxonomy) and is mocked; the stub parsers keep their script blocks null, so
 * it is never called here.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeVue, resolveSfcParser } from "./vue.mjs";

vi.mock("./typescript.mjs", () => ({
  analyzeTypeScript: vi.fn(() => ({ imports: [], failures: [] })),
}));

const SFC = "<template><div /></template>\n";

/** Roots created by `fixtureWithParser`, removed after each test. */
const fixtureRoots = [];
afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A real workspace whose `node_modules/vue/compiler-sfc` is a stub whose
 * `parse` throws `marker` — a behaviour archkeep's installed Vue does not
 * have, so an analysis failing with `marker` proves the WORKSPACE copy won.
 */
function fixtureWithParser(marker) {
  const root = mkdtempSync(join(tmpdir(), "archkeep-vue-resolution-"));
  fixtureRoots.push(root);
  const vueDir = join(root, "node_modules", "vue");
  mkdirSync(vueDir, { recursive: true });
  writeFileSync(
    join(vueDir, "compiler-sfc.js"),
    `module.exports = { parse: () => { throw new Error(${JSON.stringify(marker)}); } };\n`,
  );
  return root;
}

/** A seam requirer factory that serves `module` for any base and specifier. */
const serves = (module) => () => () => module;

const CLEAN_PARSER = {
  parse: () => ({ descriptor: { script: null, scriptSetup: null }, errors: [] }),
};

describe("resolveSfcParser — which install wins", () => {
  it("uses the analyzed workspace's own install when the workspace has one", () => {
    const root = fixtureWithParser("the workspace's vue");
    const { parse, error } = resolveSfcParser(root);
    expect(error).toBeNull();
    expect(() => parse("<template/>", {})).toThrow("the workspace's vue");
  });

  it("falls back to archkeep's install when the workspace has none", () => {
    const { parse, error } = resolveSfcParser("/w", {
      createRequireForWorkspace: () => {
        throw new Error("no workspace install");
      },
      localRequire: () => CLEAN_PARSER,
    });
    expect(error).toBeNull();
    expect(parse("<template/>", {})).toEqual({
      descriptor: { script: null, scriptSetup: null },
      errors: [],
    });
  });

  it("keeps the workspace's copy when archkeep's own install is missing", () => {
    const { parse, error } = resolveSfcParser("/w", {
      createRequireForWorkspace: serves(CLEAN_PARSER),
      localRequire: () => {
        throw new Error("archkeep did not install vue");
      },
    });
    expect(error).toBeNull();
    expect(parse).toBe(CLEAN_PARSER.parse);
  });
});

describe("analyzeVue — resolution is per workspace object", () => {
  it("parses with each workspace's own copy, remembered per workspace", () => {
    const workspaceA = { root: fixtureWithParser("from workspace A") };
    const workspaceB = { root: fixtureWithParser("from workspace B") };

    const first = analyzeVue({ sourceFile: "a.vue", text: SFC, workspace: workspaceA });
    expect(first.failures[0].reason).toBe("Vue analysis failed: from workspace A");

    // The same workspace object is remembered — still A's copy, no re-resolve.
    const again = analyzeVue({ sourceFile: "a.vue", text: SFC, workspace: workspaceA });
    expect(again.failures[0].reason).toBe("Vue analysis failed: from workspace A");

    // A different workspace object resolves ITS OWN root — the cache is keyed
    // on workspace identity, never process-global (the old singleton would
    // hand B A's parser here).
    const other = analyzeVue({ sourceFile: "a.vue", text: SFC, workspace: workspaceB });
    expect(other.failures[0].reason).toBe("Vue analysis failed: from workspace B");
  });
});

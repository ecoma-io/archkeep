/**
 * Where the Vue analyzer's SFC parser comes from: the analyzed workspace's own
 * install first, archkeep's second, and a named refusal when neither has it
 * (the refusal's exact message is pinned in `vue-missing-parser.test.mjs`) —
 * or when the workspace's own copy exists but fails to load, a broken
 * install never silently swapped for archkeep's Vue.
 *
 * Two halves. The workspace-first half needs a real filesystem to prove the
 * winner is the WORKSPACE's copy and not archkeep's: a fixture tree with a
 * `node_modules/vue/compiler-sfc` stub whose behaviour archkeep's installed
 * Vue cannot produce. The fallback half is driven through the seam
 * (`resolveSfcParser`'s second argument), which replaces each hop's requirer
 * with an in-memory fake, so a fake root like `/w` never touches the disk.
 * Between the halves sits the broken-copy one: an install that exists but
 * throws while loading is a loud refusal naming the copy's own error — the
 * silent swap this resolution exists to prevent — proven against a real
 * fixture with a marker on archkeep's hop.
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
 * The workspace stub's parse-throw message. A module-level constant on
 * purpose: the stub is executable JS written into the fixture workspace,
 * and CodeQL's `js/bad-code-sanitization` flags parameter-driven code
 * construction here. A constant carries no taint; the assertion below
 * reads the same constant, so the two cannot drift.
 */
const WORKSPACE_MARKER = "the workspace's vue";

/**
 * A real workspace whose `node_modules/vue/compiler-sfc` is a stub whose
 * `parse` throws `WORKSPACE_MARKER` — a behaviour the archkeep-side Vue
 * does not have, so an analysis failing with that message proves the
 * WORKSPACE copy won.
 */
function fixtureWithParser() {
  const root = mkdtempSync(join(tmpdir(), "archkeep-vue-resolution-"));
  fixtureRoots.push(root);
  const vueDir = join(root, "node_modules", "vue");
  mkdirSync(vueDir, { recursive: true });
  writeFileSync(
    join(vueDir, "compiler-sfc.js"),
    `module.exports = { parse: () => { throw new Error(${JSON.stringify(WORKSPACE_MARKER)}); } };\n`,
  );
  return root;
}
/**
 * A real workspace whose `node_modules/vue/compiler-sfc` EXISTS but throws
 * while loading — a broken install, not an absent one (the shape a corrupt
 * package or a permission problem produces: no `parse` ever exists).
 */
function fixtureWithBrokenCompilerSfc() {
  const root = mkdtempSync(join(tmpdir(), "archkeep-vue-broken-"));
  fixtureRoots.push(root);
  const vueDir = join(root, "node_modules", "vue");
  mkdirSync(vueDir, { recursive: true });
  writeFileSync(
    join(vueDir, "compiler-sfc.js"),
    "// The workspace's own copy exists but cannot load.\n" +
      "throw new Error('the workspace copy is broken');\n",
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
    const root = fixtureWithParser();
    const { parse, error } = resolveSfcParser(root);
    expect(error).toBeNull();
    expect(() => parse("<template/>", {})).toThrow(WORKSPACE_MARKER);
  });

  it("falls back to archkeep's install when the workspace has none", () => {
    const { parse, error } = resolveSfcParser("/w", {
      createRequireForWorkspace: () => {
        // A real require miss carries the module-absent code; so must this
        // fake, or the hop reads as a broken copy and refuses loudly.
        throw Object.assign(new Error("no workspace install"), { code: "MODULE_NOT_FOUND" });
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
describe("resolveSfcParser — a broken workspace copy is a loud refusal, never a silent swap", () => {
  it("refuses naming the workspace copy's load error, without touching archkeep's parser", () => {
    const root = fixtureWithBrokenCompilerSfc();
    // A marker on the archkeep side: a bare-catch fallback (the old
    // behaviour) would swallow the workspace copy's load error, reach this
    // throw, and refuse with 'is not installed … archkeep's fallback parser
    // was used' — failing every assertion below. The workspace copy's own
    // error must surface instead.
    const { failures } = analyzeVue(
      { sourceFile: "a.vue", text: SFC, workspace: { root } },
      {
        localRequire: () => {
          throw new Error("archkeep's fallback parser was used");
        },
      },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toContain("the workspace copy is broken");
    expect(failures[0].reason).not.toContain("archkeep's fallback parser was used");
    expect(failures[0].reason).not.toContain("is not installed");
  });

  it("falls back only for module-absent errors, refusing coded load failures loudly", () => {
    const { parse, error } = resolveSfcParser("/w", {
      createRequireForWorkspace: () => () => {
        throw Object.assign(new Error("no workspace install"), { code: "MODULE_NOT_FOUND" });
      },
      localRequire: () => CLEAN_PARSER,
    });
    expect(error).toBeNull();
    expect(parse("<template/>", {})).toEqual({
      descriptor: { script: null, scriptSetup: null },
      errors: [],
    });

    // A coded but NOT module-absent failure (here the ESM-only shape
    // `require()` of an ES module produces) must refuse, never fall back.
    const esmOnly = Object.assign(
      new Error(
        "require() of ES Module packages/archkeep/node_modules/vue/compiler-sfc not supported",
      ),
      { code: "ERR_REQUIRE_ESM" },
    );
    const refused = resolveSfcParser("/w", {
      createRequireForWorkspace: () => () => {
        throw esmOnly;
      },
      localRequire: () => CLEAN_PARSER,
    });
    expect(refused.parse).toBeNull();
    expect(refused.error).toContain("the workspace's 'vue/compiler-sfc' copy failed to load");
    expect(refused.error).toContain("require() of ES Module");
  });
});

describe("analyzeVue — resolution is per workspace object", () => {
  it("resolves each workspace's own copy: parse-throwing vs broken-load, remembered per workspace", () => {
    // A's own copy parses (and throws WORKSPACE_MARKER on use); B's own copy
    // exists but cannot load. Two different failure modes, so the assertion
    // names which workspace's copy acted — without ever generating code
    // from a runtime value.
    const workspaceA = { root: fixtureWithParser() };
    const workspaceB = { root: fixtureWithBrokenCompilerSfc() };

    const first = analyzeVue({ sourceFile: "a.vue", text: SFC, workspace: workspaceA });
    expect(first.failures[0].reason).toBe(`Vue analysis failed: ${WORKSPACE_MARKER}`);

    // The same workspace object is remembered — still A's copy, no re-resolve.
    const again = analyzeVue({ sourceFile: "a.vue", text: SFC, workspace: workspaceA });
    expect(again.failures[0].reason).toBe(`Vue analysis failed: ${WORKSPACE_MARKER}`);

    // A different workspace object resolves ITS OWN root — the cache is keyed
    // on workspace identity, never process-global (a global singleton would
    // hand B A's parse-throwing copy here; B's broken-load message names it
    // instead).
    const other = analyzeVue({ sourceFile: "a.vue", text: SFC, workspace: workspaceB });
    expect(other.failures[0].reason).toContain("the workspace copy is broken");
    expect(other.failures[0].reason).not.toContain(WORKSPACE_MARKER);
  });
});

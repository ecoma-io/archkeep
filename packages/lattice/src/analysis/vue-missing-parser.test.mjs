/**
 * `analyzeVue` with the SFC parser unreachable or misbehaving.
 *
 * The parser is loaded lazily through `createRequire` (`./vue.mjs`'s header),
 * so in a tree with `vue` installed — this one — the "parser cannot be
 * reached" state can only be built by mocking `node:module`. The same mock
 * supplies a stand-in parser for the one error shape the real one cannot
 * produce: a parse error carrying no `message` at all.
 *
 * The contract pinned: a `.vue` file that cannot be parsed is a failure
 * record naming exactly what is absent, never an empty diagnostic list. An
 * editor draws nothing for `[]`, and a developer reads that as "checked,
 * clean".
 */
import { describe, expect, it, vi } from "vitest";

const { mode } = vi.hoisted(() => ({ mode: { value: "missing-message" } }));

vi.mock("node:module", () => ({
  createRequire: () => (_specifier) => {
    if (mode.value === "missing-message") {
      throw new Error("Cannot find module 'vue/compiler-sfc'");
    }
    if (mode.value === "missing-string") {
      throw "no vue here";
    }
    return {
      parse: (_text, _options) => ({
        descriptor: { script: null, scriptSetup: null },
        errors: [
          // The shape compiler-sfc never produces: a message-less error with a
          // position. The failure record must still be built from its loc.
          { code: "PARSE_ERROR", loc: { start: { line: 3, column: 2 } } },
        ],
      }),
    };
  },
}));

const load = async () => (await import("./vue.mjs")).analyzeVue;

const SFC = "<template><div /></template>\n<script>\nimport a from 'x';\n</scr" + "ipt>\n";

describe("analyzeVue with the SFC parser unreachable", () => {
  it("turns a missing parser into a failure naming it, not an empty verdict", async () => {
    mode.value = "missing-message";
    vi.resetModules();
    const analyzeVue = await load();
    const { imports, failures } = analyzeVue({ sourceFile: "a.vue", text: SFC, workspace: {} });
    expect(imports).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatch(/'vue\/compiler-sfc' is not installed/);
    expect(failures[0].reason).toMatch(/Cannot find module/);
  });

  it("still names the parser when the load failure is not an Error at all", async () => {
    // A thrown string carries no `message`; the `String(cause)` fallback must
    // land in the raise rather than in a silent empty result.
    mode.value = "missing-string";
    vi.resetModules();
    const analyzeVue = await load();
    const { failures } = analyzeVue({ sourceFile: "a.vue", text: SFC, workspace: {} });
    expect(failures[0].reason).toMatch(/'vue\/compiler-sfc' is not installed/);
    expect(failures[0].reason).toMatch(/no vue here/);
  });
});

describe("analyzeVue with a message-less parse error", () => {
  it("builds the failure from the error's loc, whatever the error itself lacks", async () => {
    mode.value = "message-less";
    vi.resetModules();
    const analyzeVue = await load();
    const { failures } = analyzeVue({ sourceFile: "a.vue", text: SFC, workspace: {} });
    expect(failures).toEqual([
      {
        sourceFile: "a.vue",
        line: 3,
        column: 2,
        reason: "Vue SFC parse error: [object Object]",
      },
    ]);
  });
});

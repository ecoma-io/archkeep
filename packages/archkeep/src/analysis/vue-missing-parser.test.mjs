/**
 * `analyzeVue` with the SFC parser unreachable or misbehaving.
 *
 * The parser is resolved per workspace (`./vue.mjs`, "Which Vue answers"): the
 * analyzed workspace's own install first, archkeep's second. In a tree with
 * `vue` installed — this one — "cannot be reached" is built through the
 * resolution seam (`analyzeVue`'s second argument, passed to
 * `resolveSfcParser`): each hop's requirer is replaced by an in-memory fake,
 * and the same fake serves the one parse-error shape the real parser cannot
 * produce — an error carrying no `message` at all. No node:module mock, no
 * module reload.
 *
 * The contract pinned: a `.vue` file that cannot be parsed is a failure
 * record naming exactly what is absent, never an empty diagnostic list. An
 * editor draws nothing for `[]`, and a developer reads that as "checked,
 * clean".
 */
import { describe, expect, it } from "vitest";

import { analyzeVue } from "./vue.mjs";

const SFC = "<template><div /></template>\n<script>\nimport a from 'x';\n</scr" + "ipt>\n";

/** A seam whose workspace hop and archkeep hop both refuse with `cause`. */
const missingParser = (cause) => ({
  createRequireForWorkspace: () => () => {
    // A real require miss carries the module-absent code; the fake must too,
    // so the hop classifies as absence and the both-absent refusal below is
    // the one `archkeepFallback` produces — not the broken-copy refusal.
    const absent = cause instanceof Error ? new Error(cause.message) : new Error(String(cause));
    throw Object.assign(absent, { code: "MODULE_NOT_FOUND" });
  },
  localRequire: () => {
    throw cause;
  },
});

describe("analyzeVue with the SFC parser unreachable", () => {
  it("turns a missing parser into a failure naming it, not an empty verdict", () => {
    const { imports, failures } = analyzeVue(
      { sourceFile: "a.vue", text: SFC, workspace: { root: "/w" } },
      missingParser(new Error("Cannot find module 'vue/compiler-sfc'")),
    );
    expect(imports).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatch(/'vue\/compiler-sfc' is not installed/);
    expect(failures[0].reason).toMatch(/Cannot find module/);
  });

  it("still names the parser when the load failure is not an Error at all", () => {
    // A thrown string carries no `message`; the `String(cause)` fallback must
    // land in the raise rather than in a silent empty result.
    const { failures } = analyzeVue(
      { sourceFile: "a.vue", text: SFC, workspace: { root: "/w" } },
      missingParser("no vue here"),
    );
    expect(failures[0].reason).toMatch(/'vue\/compiler-sfc' is not installed/);
    expect(failures[0].reason).toMatch(/no vue here/);
  });
});

describe("analyzeVue with a message-less parse error", () => {
  it("builds the failure from the error's loc, whatever the error itself lacks", () => {
    const parser = {
      parse: () => ({
        descriptor: { script: null, scriptSetup: null },
        errors: [
          // The shape compiler-sfc never produces: a message-less error with a
          // position. The failure record must still be built from its loc.
          { code: "PARSE_ERROR", loc: { start: { line: 3, column: 2 } } },
        ],
      }),
    };
    const { failures } = analyzeVue(
      { sourceFile: "a.vue", text: SFC, workspace: { root: "/w" } },
      { createRequireForWorkspace: () => () => parser, localRequire: () => parser },
    );
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

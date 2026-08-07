import { beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeVue } from "./vue.mjs";

// The TypeScript analyzer is a project-internal collaborator, so this unit
// tier mocks it (CLAUDE.md test taxonomy). Mocking is also what makes the
// central assertion possible at all: the thing that must be right is the TEXT
// the Vue analyzer hands over, and only a stand-in can see it.
vi.mock("./typescript.mjs", () => ({
  analyzeTypeScript: vi.fn(() => ({ imports: [], failures: [] })),
}));
const { analyzeTypeScript } = await import("./typescript.mjs");

const workspace = { root: "/w", projects: [], filesOf: () => [], readFile: () => null };
const analyze = (text) => analyzeVue({ sourceFile: "libs/ui/src/Comp.vue", text, workspace });

/** What the analyzer handed to TypeScript on call `index`. */
const handedOver = (index = 0) => analyzeTypeScript.mock.calls[index][0];

beforeEach(() => {
  analyzeTypeScript.mockClear();
});

const SFC = [
  "<template>", // 1
  "  <div>hello</div>", // 2
  "</template>", // 3
  "", // 4
  '<script lang="ts">', // 5
  'import { defineComponent } from "vue";', // 6
  "export default defineComponent({});", // 7
  "</scr" + "ipt>", // 8
  "", // 9
  '<script setup lang="ts">', // 10
  'import type { Task } from "@acme/domain";', // 11
  "</scr" + "ipt>", // 12
  "",
].join("\n");

describe("analyzeVue — position mapping", () => {
  it("hands TypeScript a text where the script sits at its true .vue offsets", () => {
    // THE invariant of this analyzer. A diagnostic that names the wrong line
    // sends a reader to code that is not the problem, and does it silently —
    // worse than no diagnostic at all. Rather than trust arithmetic, the file
    // is blanked outside the block, so every line and column TypeScript
    // reports is already a `.vue` position.
    analyze(SFC);
    const [first, second] = analyzeTypeScript.mock.calls.map((call) => call[0].text);

    for (const [text, line] of [
      [first, 'import { defineComponent } from "vue";'],
      [second, 'import type { Task } from "@acme/domain";'],
    ]) {
      const at = SFC.indexOf(line);
      expect(text.indexOf(line)).toBe(at);
      expect(text).toHaveLength(SFC.length);
      // Same line structure, so a line number computed in either text agrees.
      expect(text.split("\n")).toHaveLength(SFC.split("\n").length);
    }
  });

  it("blanks the other script block, so one block's code is never read twice", () => {
    analyze(SFC);
    const [first, second] = analyzeTypeScript.mock.calls.map((call) => call[0].text);
    expect(first).not.toContain("@acme/domain");
    expect(second).not.toContain("defineComponent");
    // And nothing outside a script survives to be parsed as TypeScript.
    expect(first).not.toContain("<template>");
    expect(first).not.toContain("hello");
  });

  it("reports the .vue file as the source, not a synthetic script filename", () => {
    analyze(SFC);
    expect(handedOver().sourceFile).toBe("libs/ui/src/Comp.vue");
  });
});

describe("analyzeVue — which script, and in which dialect", () => {
  it("analyzes both blocks when a component has <script> and <script setup>", () => {
    analyze(SFC);
    expect(analyzeTypeScript).toHaveBeenCalledTimes(2);
  });

  it("passes the block's lang, because a .vue extension cannot say which dialect it is", () => {
    analyze(SFC);
    expect(analyzeTypeScript.mock.calls.map((call) => call[0].lang)).toEqual(["ts", "ts"]);
  });

  it("treats a script with no lang as JavaScript, which is Vue's own default", () => {
    analyze("<script>\nimport a from 'x';\n</scr" + "ipt>\n");
    expect(handedOver().lang).toBe("js");
  });

  it("reads a template-only component as importing nothing, which is not an error", () => {
    expect(analyze("<template><div /></template>\n")).toEqual({ imports: [], failures: [] });
    expect(analyzeTypeScript).not.toHaveBeenCalled();
  });
});

describe("analyzeVue — a malformed SFC must not blank a run", () => {
  it("reports the SFC parse error and still analyzes the script it recovered", () => {
    const { failures } = analyze(
      "<template><div></template>\n<script>\nimport a from 'x';\n</scr" + "ipt>\n",
    );
    expect(failures.some((failure) => /Vue SFC parse error/.test(failure.reason))).toBe(true);
    expect(failures.every((failure) => failure.line === null || failure.line >= 1)).toBe(true);
    expect(analyzeTypeScript).toHaveBeenCalled();
  });

  it("returns an envelope rather than throwing when the text is not an SFC at all", () => {
    const result = analyze("  not markup at all");
    expect(Array.isArray(result.imports)).toBe(true);
    expect(Array.isArray(result.failures)).toBe(true);
  });

  it("records a failure rather than propagating one thrown by the analyzer it delegates to", () => {
    // One `.vue` file must not blank a whole run, and a collaborator throwing
    // is the same kind of event as a malformed file — data, not an exception.
    analyzeTypeScript.mockImplementationOnce(() => {
      throw new Error("compiler exploded");
    });
    const { imports, failures } = analyze(SFC);
    expect(imports).toEqual([]);
    expect(failures).toEqual([
      {
        sourceFile: "libs/ui/src/Comp.vue",
        line: null,
        column: null,
        reason: "Vue analysis failed: compiler exploded",
      },
    ]);
  });
});

describe("analyzeVue — order", () => {
  it("returns records in source order even though the blocks are analyzed one after another", () => {
    // `<script setup>` is analyzed second but can be written first; the
    // contract promises source order over the file, not per block.
    analyzeTypeScript
      .mockReturnValueOnce({ imports: [{ line: 9, column: 1 }], failures: [] })
      .mockReturnValueOnce({ imports: [{ line: 2, column: 5 }], failures: [] });
    const { imports } = analyze(SFC);
    expect(imports.map((record) => record.line)).toEqual([2, 9]);
  });
});

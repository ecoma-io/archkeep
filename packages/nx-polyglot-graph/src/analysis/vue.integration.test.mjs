/**
 * The Vue analyzer driven against the REAL TypeScript analyzer.
 *
 * Integration tier because the interaction is the behaviour being pinned: a
 * `.vue` diagnostic is correct only if the SFC parser, the blanking, and
 * TypeScript's own position reporting all agree about where a line is. The
 * unit test beside this one pins the text handed over; only this one proves
 * the number a reader finally sees.
 */
import { describe, expect, it } from "vitest";

import { analyzeVue } from "./vue.mjs";

const FILES = {
  "tsconfig.base.json": JSON.stringify({
    compilerOptions: {
      module: "ESNext",
      moduleResolution: "Bundler",
      baseUrl: ".",
      paths: { "@acme/domain": ["libs/domain/src/index.ts"] },
    },
  }),
  "libs/domain/src/index.ts": "export type Task = { id: string };",
  "libs/ui/src/Button.vue": "<template><button /></template>",
};

const workspace = {
  root: "/w",
  projects: [
    { name: "domain", root: "libs/domain" },
    { name: "ui", root: "libs/ui" },
  ],
  filesOf: (name) => Object.keys(FILES).filter((file) => file.startsWith(`libs/${name}/`)),
  readFile: (path) => FILES[path] ?? null,
};

/**
 * A component whose script blocks sit deliberately far down the file, so an
 * analyzer that forgot to offset positions reports line 1 or 2 and is caught.
 */
const SFC = [
  "<template>", // 1
  "  <section>", // 2
  "    <p>a</p>", // 3
  "    <p>b</p>", // 4
  "  </section>", // 5
  "</template>", // 6
  "", // 7
  '<script lang="ts">', // 8
  'import Button from "./Button.vue";', // 9
  "export default { components: { Button } };", // 10
  "</scr" + "ipt>", // 11
  "", // 12
  '<script setup lang="ts">', // 13
  'import type { Task } from "@acme/domain";', // 14
  "const task: Task | null = null;", // 15
  "</scr" + "ipt>", // 16
  "",
].join("\n");

/** Where `needle` really is in the SFC, computed from the text itself. */
function positionOf(needle) {
  const offset = SFC.indexOf(needle);
  const before = SFC.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - (before.lastIndexOf("\n") + 1) + 1 };
}

describe("analyzeVue over the real TypeScript analyzer", () => {
  const result = analyzeVue({ sourceFile: "libs/ui/src/Comp.vue", text: SFC, workspace });

  it("reports no failures for a well-formed component", () => {
    expect(result.failures).toEqual([]);
  });

  it("points at the line and column the import really occupies in the .vue file", () => {
    // Expected positions are derived from the fixture text, not written as
    // literals: a test that hard-codes `line: 9` still passes if the fixture
    // shifts and the analyzer's offset breaks with it.
    expect(result.imports.map((record) => ({ line: record.line, column: record.column }))).toEqual([
      positionOf('"./Button.vue"'),
      positionOf('"@acme/domain"'),
    ]);
  });

  it("resolves through the .vue file's own directory, not the workspace root", () => {
    // The containing file handed to TypeScript is the `.vue` path itself, so a
    // relative specifier resolves against `libs/ui/src/` — get that wrong and
    // every relative import in every component silently fails to resolve.
    expect(result.imports[0].resolved).toEqual({
      target: "ui",
      file: "libs/ui/src/Button.vue",
      external: false,
      packageName: null,
    });
  });

  it("carries the kind across the block boundary, so an erased import stays erased", () => {
    expect(result.imports.map((record) => record.kind)).toEqual(["static", "type-only"]);
    expect(result.imports[1].resolved.target).toBe("domain");
  });
});

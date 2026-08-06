import { describe, expect, it } from "vitest";

import { analyzeFile, analyzerFor, LANGUAGE_BY_EXTENSION, languageOf } from "./analyze.mjs";

const request = (sourceFile) => ({ sourceFile, text: "", workspace: {} });

describe("languageOf", () => {
  it("claims an extension only through the registry, so one map decides every dispatch", () => {
    for (const [extension, language] of Object.entries(LANGUAGE_BY_EXTENSION)) {
      expect(languageOf(`shared/libs/thing/src/file${extension}`)).toBe(language);
    }
  });

  it("reads the last extension of a dotted filename, not the first", () => {
    expect(languageOf("vitest.config.mjs")).toBe("typescript");
    expect(languageOf("shared/tools/thing/foo.test.mjs")).toBe("typescript");
  });

  it("claims nothing for a file no analyzer can read", () => {
    expect(languageOf("shared/tools/thing/README.md")).toBeNull();
    expect(languageOf("shared/tools/thing/project.json")).toBeNull();
    expect(languageOf("Makefile")).toBeNull();
  });

  it("treats a dotfile as having no extension rather than as its own extension", () => {
    expect(languageOf(".gitignore")).toBeNull();
    expect(languageOf("shared/libs/thing/.npmrc")).toBeNull();
  });

  it("gives a Vue SFC its own language, not TypeScript's", () => {
    // A `.vue` file's imports live inside `<script>` blocks that have to be
    // located first, and the block's `lang` decides the dialect. Routing it
    // straight to the TypeScript analyzer would parse the template as code.
    expect(languageOf("libs/ui/src/Comp.vue")).toBe("vue");
  });
});

describe("analyzerFor", () => {
  it("has an analyzer for every language the extension registry claims", () => {
    // The two tables must agree, or a file routes to nothing. This is the
    // check that fails the moment an extension is registered ahead of its
    // analyzer, instead of the failure surfacing on a user's tree.
    for (const language of new Set(Object.values(LANGUAGE_BY_EXTENSION))) {
      expect(typeof analyzerFor(language)).toBe("function");
    }
  });

  it("throws for a language with no analyzer, rather than reporting it as importing nothing", () => {
    // The one legitimate throw in this layer. A malformed file is data and
    // becomes a failure record; a missing implementation is not an input
    // problem, and an empty result for it reads exactly like a clean file.
    expect(() => analyzerFor("cobol")).toThrow(/no cobol import analyzer is implemented yet/);
  });
});

describe("analyzeFile", () => {
  // The distinction this pins is the one that decides whether a run is
  // trustworthy: a file nothing can read has no imports to find, while a file
  // whose language IS in scope and reports nothing would be indistinguishable
  // from a clean file. The first is a no-op; the second must be impossible.
  it("returns an empty result for a file no analyzer claims", () => {
    expect(analyzeFile(request("shared/tools/thing/README.md"))).toEqual({
      imports: [],
      failures: [],
    });
  });

  it("returns an empty result for a file with no extension at all", () => {
    expect(analyzeFile(request("Makefile"))).toEqual({ imports: [], failures: [] });
  });

  describe("routes each extension to the analyzer that can read its syntax", () => {
    const workspace = {
      root: "/w",
      projects: [{ name: "thing", root: "libs/thing" }],
      filesOf: () => [],
      readFile: () => null,
    };
    const analyze = (sourceFile, text) => analyzeFile({ sourceFile, text, workspace });

    // Each case is written so only the right analyzer can produce it: another
    // one handed the same text answers differently or not at all.
    it.each([
      {
        name: "Go, whose block import another parser reads as a dynamic import",
        sourceFile: "libs/thing/main.go",
        text: 'package main\n\nimport (\n\t"example.com/x/y"\n)\n',
        expected: { specifier: "example.com/x/y", kind: "static" },
      },
      {
        name: "Rust, whose `pub use` is a re-export no other syntax spells",
        sourceFile: "libs/thing/src/lib.rs",
        text: "pub use other_crate::Thing;\n",
        expected: { specifier: "other_crate::Thing", kind: "re-export" },
      },
      {
        name: "Python, whose dotted module name is a syntax error elsewhere",
        sourceFile: "libs/thing/src/thing/mod.py",
        text: "import alpha.service\n",
        expected: { specifier: "alpha.service", kind: "static" },
      },
      {
        name: "TypeScript, whose erased re-export only its own parser can see",
        sourceFile: "libs/thing/src/index.ts",
        text: 'export type { A } from "@acme/ui";\n',
        expected: { specifier: "@acme/ui", kind: "type-only" },
      },
    ])("$name", ({ sourceFile, text, expected }) => {
      expect(analyze(sourceFile, text).imports[0]).toMatchObject(expected);
    });

    it("Vue, whose import is found only after the SFC's script block is located", () => {
      const text =
        "<template>\n  <div />\n</template>\n\n<script setup>\nimport a from 'x';\n</scr" +
        "ipt>\n";
      const { imports } = analyze("libs/thing/src/Comp.vue", text);
      // Line 6 is only reachable by parsing the SFC and mapping back; a parser
      // pointed at the raw file would not find an import statement at all.
      expect(imports[0]).toMatchObject({ specifier: "x", line: 6 });
    });
  });
});

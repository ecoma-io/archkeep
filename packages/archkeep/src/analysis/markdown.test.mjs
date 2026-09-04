import { describe, expect, it } from "vitest";

import { foldMarkdownTrack, markdownIncludedFiles } from "./markdown.mjs";

/**
 * The document track's unit tests: selection (`markdownIncludedFiles`), the
 * fold (`foldMarkdownTrack`), and the loudness contract the whole package is
 * judged against — a marker the tree cannot resolve is a WHOLE-FILE failure,
 * never a clean verdict, because "nothing" and "could not" must not be
 * byte-for-byte identical.
 */

/** Two projects, one owning a document, one owning a TypeScript export. */
const owned = [
  { file: "pages/ui.md", project: "docs" },
  { file: "packages/ui/src/button.ts", project: "ui" },
  { file: "packages/ui/src/index.ts", project: "ui" },
  { file: "packages/web/src/reexport.ts", project: "web" },
];

const files = {
  "pages/ui.md": "# UI\n\n<!-- @api Button -->\n",
  "packages/ui/src/button.ts": "export const Button = 1;\n",
  "packages/ui/src/index.ts": 'export { Button } from "./button.js";\n',
  "packages/web/src/reexport.ts": 'export { Button } from "@scope/ui";\n',
};

const markdown = () => ({
  include: ["pages/**/*.md"],
  markers: [{ pattern: "^<!-- @api (\\S+) -->$", edge: "resolvedExportOwner" }],
});

const fold = (overrides = {}) =>
  foldMarkdownTrack({
    tracked: Object.keys(files),
    owned,
    readFile: (file) => files[file] ?? null,
    workspace: { root: "/ws" },
    markdown: markdown(),
    ...overrides,
  });

describe("markdownIncludedFiles", () => {
  it("selects only tracked markdown files matching an include glob, in tracked order", () => {
    expect(
      markdownIncludedFiles({
        include: ["pages/**/*.md"],
        tracked: ["README.md", "pages/ui.md", "pages/deep/guide.md", "pages/ui.mdx", "notes.txt"],
      }),
    ).toEqual(["pages/ui.md", "pages/deep/guide.md"]);
  });

  it("selects nothing for a glob whose every match is some other kind of file", () => {
    expect(
      markdownIncludedFiles({
        include: ["packages/**/*.go"],
        tracked: ["packages/a.ts", "packages/b.go"],
      }),
    ).toEqual([]);
  });
});

describe("foldMarkdownTrack — the fold", () => {
  it("resolves a marker against the project that DECLARES the symbol, not one that re-exports it", () => {
    // `Button` is declared in `packages/ui/src/button.ts` (project `ui`) and
    // re-exported by `packages/web/src/reexport.ts` (project `web`). Declared
    // beats re-exported: the umbrella barrel must not become an alternative
    // home for the symbol.
    const track = fold();
    expect(track.failures).toEqual([]);
    expect(track.edges).toEqual([{ source: "docs", target: "ui", type: "resolvedExportOwner" }]);
    expect(track.resolved).toBe(1);
    expect(track.judged).toBe(1);
  });

  it("carries the marker position and name on the claim the caller judges", () => {
    const track = fold();
    expect(track.claims).toEqual([
      {
        source: "docs",
        target: "ui",
        type: "resolvedExportOwner",
        file: "pages/ui.md",
        line: 3,
        column: 1,
        name: "Button",
      },
    ]);
  });

  it("resolves through the re-export tier when no project declares the name", () => {
    // `ui` re-exports the name from a barrel whose target is not scanned as
    // declaring it, so only the re-export tier holds `Button`.
    const track = fold({
      readFile: (file) =>
        ({
          ...files,
          "pages/ui.md": "<!-- @api Button -->\n",
          "packages/ui/src/button.ts": "const Button = 1;\n",
          "packages/ui/src/index.ts": 'export { Button } from "./button.js";\n',
          "packages/web/src/reexport.ts": "",
        })[file] ?? null,
    });
    expect(track.failures).toEqual([]);
    expect(track.edges).toEqual([{ source: "docs", target: "ui", type: "resolvedExportOwner" }]);
  });

  it("folds two markers naming the same pair to ONE edge, at project grain", () => {
    const track = fold({
      readFile: (file) =>
        ({
          ...files,
          "pages/ui.md": "<!-- @api Button -->\n<!-- @api Button -->\n",
        })[file] ?? null,
    });
    expect(track.judged).toBe(2);
    expect(track.resolved).toBe(2);
    expect(track.edges).toEqual([{ source: "docs", target: "ui", type: "resolvedExportOwner" }]);
    expect(track.claims).toHaveLength(2);
  });

  it("counts a self-pairing as judged without drawing an edge — no project depends on itself", () => {
    const track = fold({
      readFile: (file) =>
        ({
          ...files,
          "pages/ui.md": "<!-- @api Button -->\n",
          "packages/ui/src/index.ts": 'export { Button } from "./button.js";\n',
          "packages/ui/src/button.ts": "export const Button = 1;\n",
          "packages/web/src/reexport.ts": "",
        })[file] ?? null,
      owned: owned.map((row) =>
        row.file === "pages/ui.md" ? { file: row.file, project: "ui" } : row,
      ),
    });
    expect(track.edges).toEqual([]);
    expect(track.selfPaired).toBe(1);
    expect(track.judged).toBe(1);
    expect(track.failures).toEqual([]);
  });

  it("reports the per-pattern and per-row counts the caller's dead-law gate reads", () => {
    const track = fold({
      markdown: {
        include: ["pages/**/*.md", "nowhere/**/*.md"],
        markers: [
          { pattern: "^<!-- @api (\\S+) -->$", edge: "resolvedExportOwner" },
          { pattern: "^@see (\\S+)$", edge: "resolvedExportOwner" },
        ],
      },
    });
    expect(track.includeCounts).toEqual([1, 0]);
    expect(track.rowMatches).toEqual([1, 0]);
  });

  it("is deterministic across runs — same tree, same bytes", () => {
    expect(JSON.stringify(fold())).toBe(JSON.stringify(fold()));
  });
});

describe("foldMarkdownTrack — the loud directions", () => {
  it("fails the whole file when a marker names a symbol no project exports", () => {
    const track = fold({
      readFile: (file) => ({ ...files, "pages/ui.md": "<!-- @api Buttn -->\n" })[file] ?? null,
    });
    expect(track.edges).toEqual([]);
    expect(track.resolved).toBe(0);
    expect(track.failures).toEqual([
      {
        sourceFile: "pages/ui.md",
        line: null,
        column: null,
        reason: expect.stringMatching(/line 1: the marker names 'Buttn', which no tracked project/),
      },
    ]);
  });

  it("fails the whole file when more than one project exports the name, naming the candidates sorted", () => {
    const track = fold({
      readFile: (file) =>
        ({
          ...files,
          // Both tiers would resolve `Button`; two DECLARED owners is the
          // ambiguity that matters, and the names must arrive in a stable
          // order regardless of file order.
          "packages/ui/src/button.ts": "export const Button = 1;\n",
          "packages/web/src/reexport.ts": "export const Button = 2;\n",
          "pages/ui.md": "<!-- @api Button -->\n",
        })[file] ?? null,
      tracked: ["packages/web/src/reexport.ts", "packages/ui/src/button.ts", "pages/ui.md"],
    });
    expect(track.edges).toEqual([]);
    expect(track.failures).toHaveLength(1);
    expect(track.failures[0].sourceFile).toBe("pages/ui.md");
    expect(track.failures[0].reason).toMatch(/'ui', 'web'/);
  });

  it("fails the whole file when a marker captures an empty name", () => {
    const track = fold({
      readFile: (file) => ({ ...files, "pages/ui.md": "<!-- @api  -->\n" })[file] ?? null,
      markdown: {
        include: ["pages/**/*.md"],
        markers: [{ pattern: "^<!-- @api (\\S*) -->$", edge: "resolvedExportOwner" }],
      },
    });
    expect(track.judged).toBe(0);
    expect(track.failures).toEqual([
      {
        sourceFile: "pages/ui.md",
        line: null,
        column: null,
        reason: expect.stringMatching(
          /line 1: the marker matches markdown\.markers\[0\] but captures an empty name/,
        ),
      },
    ]);
  });

  it("fails the whole file when the document is owned by no project — the edge has no source", () => {
    const track = fold({
      owned: owned.filter((row) => row.file !== "pages/ui.md"),
    });
    expect(track.failures).toEqual([
      {
        sourceFile: "pages/ui.md",
        line: null,
        column: null,
        reason: expect.stringMatching(/the document is owned by no project/),
      },
    ]);
    expect(track.edges).toEqual([]);
  });

  it("fails the whole file when an included document cannot be read", () => {
    const track = fold({ readFile: () => null });
    expect(track.failures).toEqual([
      {
        sourceFile: "pages/ui.md",
        line: null,
        column: null,
        reason: expect.stringMatching(/cannot be read — the markdown track matched it/),
      },
    ]);
    expect(track.judged).toBe(0);
  });

  it("degrades a row whose pattern cannot compile to a row that matches nothing — counted, not thrown", () => {
    // Load-time validation refuses an uncompilable pattern; a hand-built
    // config reaching the fold anyway must LOSE the row loudly (a zero
    // `rowMatches` count the caller's gate refuses) rather than crash the run.
    const track = fold({
      markdown: {
        include: ["pages/**/*.md"],
        markers: [{ pattern: "(unclosed", edge: "resolvedExportOwner" }],
      },
    });
    expect(track.judged).toBe(0);
    expect(track.rowMatches).toEqual([0]);
  });
});

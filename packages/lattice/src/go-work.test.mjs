import { describe, expect, it } from "vitest";

import { compareGoWork, GO_WORK_MESSAGE_IDS, parseGoWorkUse } from "./go-work.mjs";

/**
 * The position a finding cites is computed from the fixture rather than
 * written as a literal, so editing the fixture moves both sides and editing
 * the parser moves only one (`src/lsp/diagnostics.test.mjs` sets the
 * pattern).
 */
const positionOf = (text, needle) => {
  const lines = text.split("\n");
  const line = lines.findIndex((candidate) => candidate.includes(needle)) + 1;
  if (line === 0) throw new Error(`fixture does not contain ${needle}`);
  return { line, column: lines[line - 1].indexOf(needle) + 1 };
};

describe("parsing use directives", () => {
  it("reads the Go reference's own use example, verbatim", () => {
    // The example under the go.work `use` directive in the Go modules
    // reference, copied unchanged: single-line with a trailing comment, then a
    // block with a `../` path. The grammar this parser claims to read is that
    // document's, so its own example is the fixture that claim is held to.
    const text =
      "use ./mymod  // example.com/mymod\n\nuse (\n    ../othermod\n    ./subdir/thirdmod\n)\n";
    expect(parseGoWorkUse(text).map((use) => use.path)).toEqual([
      "./mymod",
      "../othermod",
      "./subdir/thirdmod",
    ]);
  });

  it("reads the single-line form, with and without the ./ spelling", () => {
    const text = "go 1.24\n\nuse ./tools/gen\nuse libs/domain\n";
    expect(parseGoWorkUse(text).map((use) => use.path)).toEqual(["./tools/gen", "libs/domain"]);
  });

  it("reads the block form, one path per line, at the position each was written", () => {
    const text = "go 1.24\n\nuse (\n\t./libs/domain\n\t./libs/adapter\n)\n";
    const uses = parseGoWorkUse(text);
    expect(uses.map((use) => use.path)).toEqual(["./libs/domain", "./libs/adapter"]);
    expect(uses[1]).toMatchObject(positionOf(text, "./libs/adapter"));
  });

  it("reads an absolute path and the bare dot as paths like any other", () => {
    const uses = parseGoWorkUse("use .\nuse /opt/checkout/mod\n");
    expect(uses.map((use) => use.path)).toEqual([".", "/opt/checkout/mod"]);
  });

  it("ignores comments, including a ')' inside one — which must not close the block early", () => {
    // The same defect class `maskGoComments` exists for in `analysis/go.mjs`:
    // a ')' in a trailing note closing `use (` early would silently drop every
    // entry below it, and a dropped entry reads as a project the developer
    // removed from the workspace.
    const text = [
      "// the workspace's own modules",
      "use (",
      "\t./libs/domain // the layer everything points at (stable)",
      "\t// ./libs/retired stays out until the port lands (see #4)",
      "\t./libs/adapter",
      ")",
      "use ./tools/gen // example.com/tools/gen",
      "",
    ].join("\n");
    expect(parseGoWorkUse(text).map((use) => use.path)).toEqual([
      "./libs/domain",
      "./libs/adapter",
      "./tools/gen",
    ]);
  });

  it("unquotes an interpreted string, replacing each escape by the character after the backslash", () => {
    const uses = parseGoWorkUse('use "./my mod/\\"quoted\\""\n');
    expect(uses[0].path).toBe('./my mod/"quoted"');
  });

  it("reads a raw string without applying escapes", () => {
    expect(parseGoWorkUse("use `./raw\\dir`\n")[0].path).toBe("./raw\\dir");
  });

  it("skips the directives it does not read, block bodies included", () => {
    // A replace block's lines look enough like paths that reading them as use
    // entries would report drift about text that is not a use list.
    const text = [
      "go 1.24",
      "toolchain go1.24.1",
      "godebug default=go1.24",
      "replace (",
      "\texample.com/old => ./libs/new",
      ")",
      "use ./libs/domain",
      "",
    ].join("\n");
    expect(parseGoWorkUse(text).map((use) => use.path)).toEqual(["./libs/domain"]);
  });

  it("returns no entries for a go.work with no use directives, which is a parse, not a failure", () => {
    expect(parseGoWorkUse("go 1.24\n")).toEqual([]);
  });

  it.each([
    ["an empty file", ""],
    ["a file with only blank lines", "\n\n\n"],
    ["a file with only comments", "// nothing to see here\n// just a comment\n"],
  ])(
    "also returns no entries for %s, matching `go work edit`'s own tolerance (verified go1.24.7)",
    (_shape, text) => {
      expect(parseGoWorkUse(text)).toEqual([]);
    },
  );
});

describe("refusing a go.work it cannot read", () => {
  // The silent direction, pinned per shape: a parser that answered any of
  // these with a short (or empty) use list would turn a file it misread into
  // "no drift" — the exact false green the check exists to remove. Each case
  // must throw, never return.
  /** @type {[string, string, RegExp][]} */
  const malformed = [
    ["an unclosed use block", "use (\n\t./libs/domain\n", /'use \(' block is never closed/],
    ["a use with no path", "use\n", /'use' needs a directory path/],
    ["two paths on one use line", "use ./a ./b\n", /exactly one directory path/],
    ["tokens after the opening paren", "use ( ./libs/domain\n", /exactly one directory path/],
    ["two paths on one block line", "use (\n\t./a ./b\n)\n", /exactly one directory path/],
    ["an unterminated quoted string", 'use "./half\n', /go\.work:1: unterminated quoted string/],
    ["an unterminated raw string", "use `./half\n", /unterminated raw string/],
    ["a stray closing paren", ")\n", /unexpected '\)' outside any block/],
    ["text after a block's closing paren", "use (\n) ./late\n", /after the '\)'/],
    // Audit finding P1-03: a go.work fetched through a redirect that actually
    // served an HTML error page tokenizes cleanly — no unterminated block or
    // string — so every line used to fall through the "future directive"
    // skip and the file read as zero `use` entries. `go work edit` itself
    // (go1.24.7) refuses every one of these lines as `"unknown directive"`;
    // this parser must refuse the whole file the same way, not read it as a
    // go.work with nothing declared.
    [
      "an HTML error page in place of go.work",
      "<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head>\n<body>404 Not Found</body></html>\n",
      /go\.work:1: unknown directive: <!DOCTYPE/,
    ],
    // The general mechanism behind the HTML case above: any keyword outside
    // go.work's own five (`go`, `toolchain`, `use`, `replace`, `godebug`) is
    // refused, single-line or as a block header, so a corrupt or truncated
    // file with plausible-looking-but-wrong directives fails loudly too, not
    // only literal markup.
    ["a keyword go.work does not define", "banana 1.24\n", /unknown directive: banana/],
    [
      "a block opened under a keyword go.work does not define",
      "banana (\n\t./libs/domain\n)\n",
      /unknown block type: banana/,
    ],
  ];

  it.each(malformed)("throws on %s, naming the line", (_shape, text, message) => {
    expect(() => parseGoWorkUse(text)).toThrow(message);
    expect(() => parseGoWorkUse(text)).toThrow(/go\.work:\d+/);
  });
});

/**
 * A two-project workspace the comparisons below perturb one fact at a time.
 * `beta` nests a second go.mod the graph deliberately does not model — the
 * `src-tauri`-style case the project `CLAUDE.md` documents.
 */
const facts = () => ({
  workspaceRoot: "/repo/acme",
  projects: [
    { name: "alpha", root: "libs/alpha" },
    { name: "beta", root: "libs/beta" },
  ],
  files: [
    "nx.json",
    "go.work",
    "libs/alpha/go.mod",
    "libs/alpha/alpha.go",
    "libs/beta/go.mod",
    "libs/beta/inner/go.mod",
    "tools/loose/go.mod",
  ],
});

const uses = (...paths) => paths.map((path, index) => ({ path, line: index + 2, column: 2 }));

describe("comparing the use list against the graph", () => {
  it("finds nothing when the two lists agree, and states how many modules that claim covers", () => {
    const { findings, moduleProjects } = compareGoWork({
      uses: uses("./libs/alpha", "./libs/beta"),
      ...facts(),
    });
    expect(findings).toEqual([]);
    expect(moduleProjects).toBe(2);
  });

  it("normalizes the spellings go.work allows before comparing, so none of them reads as drift", () => {
    const spellings = [
      ["libs/alpha", "./libs/beta"], // no ./ prefix
      ["./libs/alpha/", "./libs/./beta"], // trailing slash, inner dot
      ["/repo/acme/libs/alpha", "./libs/beta"], // absolute, under the root
    ];
    for (const pair of spellings) {
      expect(compareGoWork({ uses: uses(...pair), ...facts() }).findings).toEqual([]);
    }
  });

  it("treats a workspace-root module as '.', the spelling Nx writes as the root '.'", () => {
    const { findings } = compareGoWork({
      uses: uses("."),
      workspaceRoot: "/repo/acme",
      projects: [{ name: "acme", root: "." }],
      files: ["nx.json", "go.work", "go.mod"],
    });
    expect(findings).toEqual([]);
  });

  it("names the workspace root in words when the root module itself is the one missing", () => {
    const { findings } = compareGoWork({
      uses: [],
      workspaceRoot: "/repo/acme",
      projects: [{ name: "acme", root: "." }],
      files: ["nx.json", "go.work", "go.mod"],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("the workspace root");
    expect(findings[0].message).toContain('"use ."');
  });

  it("reports a go.mod project missing from the use list — the silent half nothing else notices", () => {
    // Direction A. A comparison that returned [] here is the defect this whole
    // check exists to end: the developer's build skips a module CI judges, and
    // both sides look clean on their own.
    const { findings } = compareGoWork({ uses: uses("./libs/alpha"), ...facts() });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      messageId: "goWorkMissingUse",
      file: "go.work",
      line: null,
      column: null,
      project: "beta",
      directory: "libs/beta",
    });
    expect(findings[0].message).toContain("use ./libs/beta");
  });

  it("reports a use entry with no tracked go.mod behind it, at the position that wrote it", () => {
    // Direction B, stale flavour: go itself fails on this entry on every
    // developer machine, and CI — which never reads go.work — stays green.
    const { findings } = compareGoWork({
      uses: uses("./libs/alpha", "./libs/beta", "./libs/gone"),
      ...facts(),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      messageId: "goWorkStaleUse",
      line: 4,
      column: 2,
      directory: "libs/gone",
    });
    expect(findings[0].message).toContain("./libs/gone");
  });

  it("reports a use entry naming a module nested inside a project, which the graph does not model", () => {
    // Direction B, one-module-per-project-root flavour: the module builds on
    // developer machines while the graph draws no edge for it. The finding
    // names the owning project, because "split it out" is the fix.
    const { findings } = compareGoWork({
      uses: uses("./libs/alpha", "./libs/beta", "./libs/beta/inner"),
      ...facts(),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      messageId: "goWorkUnmodeledUse",
      directory: "libs/beta/inner",
      project: "beta",
    });
  });

  it("reports a use entry whose go.mod belongs to no project at all", () => {
    const { findings } = compareGoWork({
      uses: uses("./libs/alpha", "./libs/beta", "./tools/loose"),
      ...facts(),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      messageId: "goWorkUnmodeledUse",
      directory: "tools/loose",
      project: null,
    });
  });

  it("reports a use entry that leaves the workspace, relative or absolute", () => {
    const { findings } = compareGoWork({
      uses: uses("./libs/alpha", "./libs/beta", "../sibling-checkout/mod", "/somewhere/else"),
      ...facts(),
    });
    expect(findings.map((finding) => finding.messageId)).toEqual([
      "goWorkOutsideUse",
      "goWorkOutsideUse",
    ]);
    expect(findings[0].message).toContain("../sibling-checkout/mod");
  });

  it("reports both directions of the same drift in one run, never one masking the other", () => {
    const { findings } = compareGoWork({
      uses: uses("./libs/gone"),
      ...facts(),
    });
    expect(findings.map((finding) => finding.messageId).sort()).toEqual([
      "goWorkMissingUse",
      "goWorkMissingUse",
      "goWorkStaleUse",
    ]);
  });

  it("does not demand a nested go.mod in the use list, matching the graph's own model", () => {
    // `libs/beta/inner/go.mod` is tracked but is no project root, so its
    // absence from go.work is not drift: the graph does not model it either,
    // and demanding it here would claim coverage the graph does not have.
    const { findings, moduleProjects } = compareGoWork({
      uses: uses("./libs/alpha", "./libs/beta"),
      ...facts(),
    });
    expect(findings).toEqual([]);
    expect(moduleProjects).toBe(2);
  });

  it("ignores a project without a tracked go.mod — it is outside both lists", () => {
    const withTsProject = facts();
    withTsProject.projects.push({ name: "site", root: "apps/site" });
    withTsProject.files.push("apps/site/project.json");
    const { findings, moduleProjects } = compareGoWork({
      uses: uses("./libs/alpha", "./libs/beta"),
      ...withTsProject,
    });
    expect(findings).toEqual([]);
    expect(moduleProjects).toBe(2);
  });
});

describe("the message table", () => {
  it("has an id for every finding kind the comparison can produce, and no orphans", () => {
    // `report/sarif.mjs` derives its rule catalogue from this list; an id the
    // comparison emits but the table lacks would be a nameless finding in a
    // code-scanning upload.
    expect([...GO_WORK_MESSAGE_IDS].sort()).toEqual([
      "goWorkMissingUse",
      "goWorkOutsideUse",
      "goWorkStaleUse",
      "goWorkUnmodeledUse",
    ]);
  });
});

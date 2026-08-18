import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import {
  analyzeGo,
  maskGoComments,
  parseGoImports,
  parseGoImportSites,
  parseGoModulePath,
  resolveGoDependencies,
  resolveGoModule,
} from "./go.mjs";

const modulePath = fc
  .array(fc.constantFrom(..."abcdefgh"), { minLength: 1, maxLength: 6 })
  .map((chars) => `example.com/${chars.join("")}`);
// The lines a .go file is made of, as this parser sees them: declarations it
// must read, quoted strings it must not, and the block punctuation that
// decides which is which.
const goLine = fc.oneof(
  fc.constantFrom(
    "package main",
    "import (",
    ")",
    "",
    "\tfmt.Println()",
    'var s = "example.com/not-an-import"',
    '// import "example.com/commented"',
  ),
  modulePath.map((path) => `import "${path}"`),
  modulePath.map((path) => `\t_ "${path}"`),
  modulePath.map((path) => `\talias "${path}"`),
);
// What a Go comment is allowed to say, restricted to the characters that can
// make a scanner change its mind: `)` closes an import block, quotes and the
// backtick open literals, and `/` and `*` open and close comments. A newline
// is excluded because it would end the comment and stop being one.
const commentBody = fc
  .array(fc.constantFrom(...'()"`/*\\ :.abc'), { maxLength: 24 })
  .map((chars) => chars.join(""));

describe("parseGoModulePath", () => {
  it("reads the module path and ignores directives around it", () => {
    expect(
      parseGoModulePath('module example.com/acme/tool\n\ngo 1.24\nrequire (\n\tx "v1"\n)'),
    ).toBe("example.com/acme/tool");
  });

  it("returns null when no module directive exists", () => {
    expect(parseGoModulePath("go 1.24\n")).toBeNull();
  });
});

describe("maskGoComments", () => {
  // Length and line breaks are the contract, not a nicety: the import-site
  // record is read as `file:line:column`, so an offset taken from the mask has
  // to name the same byte in the source a reader will open.
  const preservesShape = (source) => {
    const masked = maskGoComments(source);
    expect(masked).toHaveLength(source.length);
    expect([...masked].map((c, i) => (c === "\n" ? i : -1))).toEqual(
      [...source].map((c, i) => (c === "\n" ? i : -1)),
    );
    return masked;
  };

  /** The same text with every character of `comment` replaced by a space. */
  const blanked = (code, comment) => `${code}${" ".repeat(comment.length)}`;

  it("blanks a line comment and leaves the code beside it untouched", () => {
    const code = '\t_ "github.com/lib/pq" ';
    const comment = "// register the driver (postgres)";
    expect(preservesShape(`${code}${comment}\n`)).toBe(`${blanked(code, comment)}\n`);
  });

  it("blanks a block comment across every line it spans", () => {
    const hidden = '\t"example.com/hidden"';
    expect(preservesShape(`/*\n${hidden}\n*/\n"kept"\n`)).toBe(
      `  \n${blanked("", hidden)}\n  \n"kept"\n`,
    );
  });

  it("closes a block comment at the first terminator, because Go comments do not nest", () => {
    // `/* a /* b */ c` is one comment ending at the first `*/`; `c` is code.
    const comment = "/* a /* b */";
    expect(preservesShape(`${comment} c`)).toBe(`${blanked("", comment)} c`);
  });

  it("runs an unterminated comment of either form to the end of the file", () => {
    expect(preservesShape("code // trailing")).toBe(blanked("code ", "// trailing"));
    expect(preservesShape("code /* never closed")).toBe(blanked("code ", "/* never closed"));
  });

  it("reads no comment inside a string or rune literal", () => {
    // The whole reason the mask is a scan and not a regex: these characters
    // are text, and a mask that blanked from here would delete real code.
    for (const source of [
      'var s = "// not a comment"',
      'var s = "/* not a comment"',
      "var s = `// not a comment */`",
      "var slash = '/'",
    ]) {
      expect(preservesShape(source)).toBe(source);
    }
  });

  it("keeps a raw string whole even when it spans lines and holds a terminator", () => {
    const source = "var s = `line one */\nline two // still text`\nx\n";
    expect(preservesShape(source)).toBe(source);
  });

  it("ends an escaped literal where Go ends it, not at the escaped quote", () => {
    // `'\''` is a rune holding a quote; a scanner that stopped at the middle
    // `'` would treat the rest of the line as a literal and hide a comment in
    // it. Same for `"\""` and for a trailing `\` at a line break, which leaves
    // an interpreted string unterminated rather than continuing it.
    expect(preservesShape("x := '\\'' // note\n")).toBe(`${blanked("x := '\\'' ", "// note")}\n`);
    expect(preservesShape('x := "a\\"b" // note\n')).toBe(
      `${blanked('x := "a\\"b" ', "// note")}\n`,
    );
    expect(preservesShape('x := "a\\\n// note\n')).toBe(`x := "a\\\n${blanked("", "// note")}\n`);
  });

  it("leaves a lone slash alone, so division survives the scan", () => {
    expect(preservesShape("x := a / b")).toBe("x := a / b");
  });

  it("returns an unterminated raw string as itself rather than losing the rest of the file", () => {
    expect(preservesShape("var s = `open")).toBe("var s = `open");
  });
});

describe("parseGoImports", () => {
  it("reads single-form imports, with and without alias forms", () => {
    const src = [
      'import "fmt"',
      'import alias "example.com/a"',
      'import _ "example.com/b"',
      'import . "example.com/c"',
    ].join("\n");
    expect(parseGoImports(src).sort()).toEqual([
      "example.com/a",
      "example.com/b",
      "example.com/c",
      "fmt",
    ]);
  });

  it("reads every path in a block import", () => {
    const src =
      'package x\n\nimport (\n\t"fmt"\n\tzz "example.com/y/sub"\n\t_ "example.com/z"\n)\n';
    expect(parseGoImports(src).sort()).toEqual(["example.com/y/sub", "example.com/z", "fmt"]);
  });

  it("does not read a quoted string outside an import declaration", () => {
    expect(parseGoImports('package x\nvar s = "example.com/not-an-import"')).toEqual([]);
  });

  // The three shapes below are ordinary Go: `gofmt -l` prints nothing for any
  // of them, `go vet` is clean, they compile. A parser that could not see a
  // comment ended the block at the `)` inside one and returned only the
  // imports above it. That is a FALSE NEGATIVE, and it is the worst thing this
  // tool can do: the Nx edge vanishes so `nx affected` stops rebuilding
  // dependents, and the boundary check reports a clean file with a live
  // violation in it, with no failure record to mark the blind spot.
  it("reads every import below a comment that contains a closing paren", () => {
    const src = [
      "package main",
      "",
      "import (",
      '\t"fmt"',
      "\t// TODO(alice): drop this once the port lands",
      '\t"example.com/secrets/store"',
      ")",
    ].join("\n");
    expect(parseGoImports(src)).toEqual(["fmt", "example.com/secrets/store"]);
  });

  it("reads every import below a blank import whose mandatory note contains a paren", () => {
    const src = [
      "package main",
      "",
      "import (",
      '\t_ "github.com/lib/pq" // register the driver (postgres)',
      "",
      '\t"example.com/secrets/store"',
      ")",
    ].join("\n");
    expect(parseGoImports(src)).toEqual(["github.com/lib/pq", "example.com/secrets/store"]);
  });

  it("reads every import below a doc comment that closes a paren above the block", () => {
    const src = [
      "package main",
      "",
      "// Package main wires things up (and closes a paren doing it).",
      "",
      "import (",
      '\t"example.com/secrets/store"',
      ")",
    ].join("\n");
    expect(parseGoImports(src)).toEqual(["example.com/secrets/store"]);
  });

  // The same mask, in the other direction. A commented-out import is not an
  // import: counting it is a graph edge to a project this file does not depend
  // on, which makes `nx affected` rebuild and re-review work that cannot have
  // changed, and makes the boundary check report a crossing nobody wrote.
  it("does not read an import written inside a block comment", () => {
    const src = 'package main\n\nimport (\n\t/*\n\t\t"example.com/old/store"\n\t*/\n\t"fmt"\n)\n';
    expect(parseGoImports(src)).toEqual(["fmt"]);
  });

  it("does not read a single-form import that was commented out", () => {
    expect(parseGoImports('package x\n\n// import "example.com/old"\nimport "fmt"\n')).toEqual([
      "fmt",
    ]);
  });

  // The one case below pins what this parser still gets WRONG, so the
  // header's remaining limit is checkable rather than a claim. It errs toward
  // naming text the file really contains, never toward a missed import — the
  // direction that matters, because a spurious edge is visible to whoever
  // reads the report and a missing one is visible to nobody.
  it("reads an import-looking line inside a raw string — the limit gofmt does not remove", () => {
    // The only limit a formatted tree still meets. The mask leaves string
    // literals alone on purpose: an import path IS a string literal, so a mask
    // that ate them would have nothing left to read.
    const src =
      'package main\n\nimport "fmt"\n\nvar src = `\nimport "example.com/quoted-only"\n`\n';
    expect(parseGoImports(src)).toEqual(["fmt", "example.com/quoted-only"]);
  });

  it("reads both of two imports sharing a line via an explicit `;`, in either form", () => {
    // Legal Go that gofmt splits onto its own lines, so a formatted tree never
    // contains it — but an explicit `;` is the same statement separator gofmt
    // inserts automatically at a newline, and reads the same import either way.
    expect(parseGoImports('package main\n\nimport "fmt"; import "os"\n').sort()).toEqual([
      "fmt",
      "os",
    ]);
    expect(parseGoImports('package main\n\nimport ("fmt"; "os")\n').sort()).toEqual(["fmt", "os"]);
  });

  it("reads an import path spelled as a raw string the same as a quoted one", () => {
    // Also legal Go, also rewritten by gofmt — to the interpreted form. An
    // import path is a string literal, and Go accepts either literal form.
    expect(parseGoImports("package main\n\nimport `fmt`\n")).toEqual(["fmt"]);
    expect(parseGoImports("package main\n\nimport (\n\t`fmt`\n)\n")).toEqual(["fmt"]);
  });

  // Two regexes stand in for a Go parser, over sources this plugin never gets
  // to choose. The invariant that keeps that honest is that every path it
  // reports is quoted somewhere in the file it read: an import the file does
  // not contain is an edge to a project it does not depend on, which makes
  // `nx affected` rebuild and re-review work that cannot have changed.
  test.prop([fc.array(goLine, { maxLength: 24 })])(
    "never reports an import path the source does not quote",
    (lines) => {
      const source = lines.join("\n");
      for (const imported of parseGoImports(source)) {
        expect(source).toContain(`"${imported}"`);
      }
    },
  );

  test.prop([fc.array(goLine, { maxLength: 12 }), modulePath, fc.array(goLine, { maxLength: 12 })])(
    "reads a single-form import wherever in the file it appears",
    (before, imported, after) => {
      const source = [...before, `import "${imported}"`, ...after].join("\n");
      expect(parseGoImports(source)).toContain(imported);
    },
  );

  // A comment is the one thing a Go author may write anywhere without changing
  // what the file imports. Stating it as a property rather than a list of
  // comment texts is what keeps the next unlucky character — a backtick in a
  // struct-tag example, a URL with a paren in it — from being a new blind spot
  // nobody thought to add a case for.
  test.prop([commentBody])(
    "reads every import in a block whatever a comment between them says",
    (body) => {
      const source = `package main\n\nimport (\n\t"fmt"\n\t// ${body}\n\t"example.com/beta/pkg"\n)\n`;
      expect(parseGoImports(source)).toEqual(["fmt", "example.com/beta/pkg"]);
    },
  );

  test.prop([commentBody])(
    "reads every import in a block whatever the note on the one above it says",
    (body) => {
      const source = `package main\n\nimport (\n\t_ "github.com/lib/pq" // ${body}\n\n\t"example.com/beta/pkg"\n)\n`;
      expect(parseGoImports(source)).toEqual(["github.com/lib/pq", "example.com/beta/pkg"]);
    },
  );
});

describe("resolveGoModule", () => {
  it("returns null when no module claims the import path", () => {
    expect(
      resolveGoModule("example.com/elsewhere/pkg", [
        { modulePath: "example.com/root", project: "parent" },
      ]),
    ).toBeNull();
  });

  it("wins the longest module path, not the first listed", () => {
    // WSX-D02: the one function both layers read an import with. A
    // first-match answer naming the parent attributes every nested-module
    // import to the project it does not reach.
    expect(
      resolveGoModule("example.com/root/sub/pkg", [
        { modulePath: "example.com/root", project: "parent" },
        { modulePath: "example.com/root/sub", project: "nested" },
      ]),
    ).toEqual({ matched: "example.com/root/sub", project: "nested" });
  });

  it("requires the module-path boundary — a prefix without a slash is not a match", () => {
    expect(
      resolveGoModule("example.com/rootish/x", [
        { modulePath: "example.com/root", project: "parent" },
      ]),
    ).toBeNull();
  });

  it("keeps a null-project own-module candidate as a longest match", () => {
    // `analyzeGo` passes the file's own modules with `project: null`, so an
    // own-module import must resolve there rather than to no module at all.
    expect(
      resolveGoModule("example.com/root/store", [
        { modulePath: "example.com/root", project: null },
        { modulePath: "example.com/root/store", project: "store" },
      ]),
    ).toEqual({ matched: "example.com/root/store", project: "store" });
  });
});

describe("resolveGoDependencies", () => {
  const projects = [
    { name: "alpha", root: "acme/libs/alpha" },
    { name: "beta", root: "acme/libs/beta" },
    { name: "web", root: "acme/libs/web" }, // not a Go project
  ];
  const files = {
    alpha: ["acme/libs/alpha/go.mod", "acme/libs/alpha/main.go"],
    beta: ["acme/libs/beta/go.mod", "acme/libs/beta/lib.go", "acme/libs/beta/lib_test.go"],
    web: ["acme/libs/web/project.json"],
  };
  const contents = {
    "acme/libs/alpha/go.mod": "module example.com/acme/alpha\n\ngo 1.24\n",
    "acme/libs/alpha/main.go":
      'package main\n\nimport (\n\t"fmt"\n\t"example.com/acme/beta/pkg"\n)\n',
    "acme/libs/beta/go.mod": "module example.com/acme/beta\n\ngo 1.24\n",
    "acme/libs/beta/lib.go": 'package beta\n\nimport "fmt"\n',
    "acme/libs/beta/lib_test.go": 'package beta\n\nimport "testing"\n',
  };
  const filesOf = (name) => files[name] ?? [];
  const readFile = (path) => contents[path] ?? null;

  it("draws an edge for an import under a sibling module path, attributed to the importing file", () => {
    expect(resolveGoDependencies(projects, filesOf, readFile)).toEqual([
      {
        source: "alpha",
        target: "beta",
        sourceFile: "acme/libs/alpha/main.go",
        type: "static",
      },
    ]);
  });

  it("draws one edge to the NESTED module, never a spurious one to its parent (WSX-D02)", () => {
    // The silent direction is a wrong graph, not an empty one: before the fix,
    // `resolveGoDependencies` matched the first (parent) module path and pushed
    // a `third → parent` edge, so `nx affected` rebuilt parent and its whole
    // subtree for a change that only touched nested — while `analyzeGo`, which
    // already won the longest module path, resolved the same import to nested.
    // Both layers now read the same `resolveGoModule`.
    const nestedProjects = [
      { name: "parent", root: "acme/libs/parent" },
      { name: "nested", root: "acme/libs/parent/nested" },
      { name: "third", root: "acme/libs/third" },
    ];
    const nestedContents = {
      "acme/libs/parent/go.mod": "module example.com/acme/parent\n",
      "acme/libs/parent/nested/go.mod": "module example.com/acme/parent/nested\n",
      "acme/libs/third/go.mod": "module example.com/acme/third\n",
      "acme/libs/third/main.go": 'package main\n\nimport "example.com/acme/parent/nested/store"\n',
    };
    const nestedFiles = {
      parent: ["acme/libs/parent/go.mod"],
      nested: ["acme/libs/parent/nested/go.mod"],
      third: ["acme/libs/third/go.mod", "acme/libs/third/main.go"],
    };
    expect(
      resolveGoDependencies(
        nestedProjects,
        (name) => nestedFiles[name] ?? [],
        (path) => nestedContents[path] ?? null,
      ),
    ).toEqual([
      { source: "third", target: "nested", sourceFile: "acme/libs/third/main.go", type: "static" },
    ]);
  });

  it("draws nothing when the only imports are stdlib or the project's own module", () => {
    const selfImport = {
      ...contents,
      "acme/libs/alpha/main.go": 'package main\n\nimport "example.com/acme/alpha/internal"\n',
    };
    expect(resolveGoDependencies(projects, filesOf, (p) => selfImport[p] ?? null)).toEqual([]);
  });

  it("draws the edge even when a comment above the import closes a paren", () => {
    // The graph half of the same defect. Losing the import loses the Nx edge,
    // so `nx affected` stops rebuilding beta's dependents — a stale artifact
    // shipped by a green pipeline, which no reviewer is looking for.
    const commented = {
      ...contents,
      "acme/libs/alpha/main.go":
        'package main\n\nimport (\n\t"fmt"\n\t// TODO(alice): drop this once the port lands\n\t"example.com/acme/beta/pkg"\n)\n',
    };
    expect(resolveGoDependencies(projects, filesOf, (p) => commented[p] ?? null)).toEqual([
      { source: "alpha", target: "beta", sourceFile: "acme/libs/alpha/main.go", type: "static" },
    ]);
  });

  it("draws no edge for an import that only appears inside a block comment", () => {
    const commentedOut = {
      ...contents,
      "acme/libs/alpha/main.go":
        'package main\n\nimport (\n\t/*\n\t\t"example.com/acme/beta/pkg"\n\t*/\n\t"fmt"\n)\n',
    };
    expect(resolveGoDependencies(projects, filesOf, (p) => commentedOut[p] ?? null)).toEqual([]);
  });

  it("requires the module-path boundary — a prefix without a slash is not a match", () => {
    const lookalike = {
      ...contents,
      "acme/libs/alpha/main.go": 'package main\n\nimport "example.com/acme/betafake"\n',
    };
    expect(resolveGoDependencies(projects, filesOf, (p) => lookalike[p] ?? null)).toEqual([]);
  });

  it("skips a project whose go.mod is listed but cannot be read, or names no module", () => {
    // Two silent-direction guards. A go.mod that is listed but gone (deleted
    // between the listing and the read) must not be parsed as the empty
    // string — the empty string IS a module path for nothing, and the project
    // could then match every import spelled `""`. And a go.mod that parsed
    // but declares no module should not invent one. Neither may become an
    // edge, and neither may throw.
    const expanded = [
      ...projects,
      { name: "gamma", root: "acme/libs/gamma" },
      { name: "delta", root: "acme/libs/delta" },
    ];
    const filesExpanded = {
      ...files,
      gamma: ["acme/libs/gamma/go.mod", "acme/libs/gamma/tool.go"],
      delta: ["acme/libs/delta/go.mod", "acme/libs/delta/cmd.go"],
    };
    const filesOfExpanded = (name) => filesExpanded[name] ?? [];
    const contentsExpanded = {
      ...contents,
      // gamma's manifest is listed but cannot be produced; delta's can be and
      // declares no module — a `go.work`-owning root with no module of its own.
      "acme/libs/delta/go.mod": "go 1.24\n",
    };
    const readFileExpanded = (p) => contentsExpanded[p] ?? null;
    expect(resolveGoDependencies(expanded, filesOfExpanded, readFileExpanded)).toEqual([
      { source: "alpha", target: "beta", sourceFile: "acme/libs/alpha/main.go", type: "static" },
    ]);
  });

  it("skips a listed .go file whose contents cannot be read, instead of parsing an empty string", () => {
    const unreadable = {
      ...contents,
      "acme/libs/alpha/main.go": null, // readFile's contract: null means unreadable
    };
    expect(resolveGoDependencies(projects, filesOf, (p) => unreadable[p] ?? null)).toEqual([]);
  });
});

describe("parseGoImportSites", () => {
  const source = [
    "package main", // 1
    "", // 2
    "import (", // 3
    '\t"fmt"', // 4
    '\t_ "example.com/acme/beta/pkg"', // 5
    ")", // 6
    "", // 7
    'import "example.com/acme/gamma"', // 8
  ].join("\n");

  it("keeps one entry per written import, with the offset of its quoted path", () => {
    expect(
      parseGoImportSites(source).map((site) => [site.specifier, source.slice(site.offset)[0]]),
    ).toEqual([
      ["fmt", '"'],
      ["example.com/acme/beta/pkg", '"'],
      ["example.com/acme/gamma", '"'],
    ]);
  });

  it("returns sites in source order, not block-form after single-form", () => {
    // The single-form import is written last but sits after the block; a
    // parser that appended one regex's matches to the other's would report a
    // record order that contradicts `contract.md`'s source-order promise.
    const offsets = parseGoImportSites(source).map((site) => site.offset);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });

  it("offsets index the source a reader will open, not the comment-masked copy", () => {
    // The mask blanks comments in place rather than deleting them, so every
    // offset stays a byte of the original file. A mask that shortened the text
    // would move every import below the first comment, and the record — read
    // as `file:line:column` in the terminal and in the editor — would point at
    // the wrong line while looking perfectly plausible.
    const commented = [
      "package main", // 1
      "", // 2
      "import (", // 3
      '\t"fmt"', // 4
      "\t// TODO(alice): drop this once the port lands", // 5
      '\t"example.com/acme/beta/pkg"', // 6
      ")", // 7
    ].join("\n");
    expect(
      parseGoImportSites(commented).map((site) => [
        site.specifier,
        commented.slice(site.offset, site.offset + site.specifier.length + 2),
      ]),
    ).toEqual([
      ["fmt", '"fmt"'],
      ["example.com/acme/beta/pkg", '"example.com/acme/beta/pkg"'],
    ]);
  });

  it("is the single parse both layers read — `parseGoImports` is its deduped view", () => {
    const doubled = 'package x\n\nimport "fmt"\nimport "fmt"\n';
    expect(parseGoImportSites(doubled)).toHaveLength(2);
    expect(parseGoImports(doubled)).toEqual(["fmt"]);
  });
});

describe("analyzeGo", () => {
  const workspace = {
    root: "/w",
    projects: [
      { name: "alpha", root: "acme/libs/alpha" },
      { name: "beta", root: "acme/libs/beta" },
      { name: "beta-nested", root: "acme/libs/beta/nested" },
    ],
    filesOf: (name) =>
      ({
        alpha: ["acme/libs/alpha/go.mod", "acme/libs/alpha/main.go"],
        beta: ["acme/libs/beta/go.mod"],
        "beta-nested": ["acme/libs/beta/nested/go.mod"],
      })[name] ?? [],
    readFile: (path) =>
      ({
        "acme/libs/alpha/go.mod": "module example.com/acme/alpha\n",
        "acme/libs/beta/go.mod": "module example.com/acme/beta\n",
        "acme/libs/beta/nested/go.mod": "module example.com/acme/beta/nested\n",
      })[path] ?? null,
  };
  const analyze = (text, sourceFile = "acme/libs/alpha/main.go") =>
    analyzeGo({ sourceFile, text, workspace });

  it("names the project, the line, the column and the raw path an import crosses to", () => {
    // The whole reason this layer exists: an Nx edge says only that alpha
    // depends on beta. This is the record a reader can act on.
    const text = 'package main\n\nimport (\n\t"fmt"\n\t"example.com/acme/beta/store"\n)\n';
    const { imports, failures } = analyze(text);
    expect(failures).toEqual([]);
    expect(imports[1]).toEqual({
      sourceFile: "acme/libs/alpha/main.go",
      line: 5,
      column: 2,
      specifier: "example.com/acme/beta/store",
      kind: "static",
      spelling: { path: false, relative: false },
      resolved: { target: "beta", file: null, external: false, packageName: null },
    });
  });

  it("crosses a boundary written after a `;` on the same line as another import", () => {
    // The silent-miss direction: before the fix, the second import on a
    // semicolon-joined line vanished with no record and no failure, so a real
    // cross-project dependency reported clean.
    const text = 'package main\n\nimport "fmt"; import "example.com/acme/beta/store"\n';
    const { imports, failures } = analyze(text);
    expect(failures).toEqual([]);
    expect(imports).toHaveLength(2);
    expect(imports[1].specifier).toBe("example.com/acme/beta/store");
    expect(imports[1].resolved.target).toBe("beta");
  });

  it("crosses a boundary written as a raw-string import path", () => {
    // The other silent-miss direction: before the fix, an import path spelled
    // with backticks produced zero records for the whole file.
    const text = "package main\n\nimport `example.com/acme/beta/store`\n";
    const { imports, failures } = analyze(text);
    expect(failures).toEqual([]);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe("example.com/acme/beta/store");
    expect(imports[0].resolved.target).toBe("beta");
  });

  it("calls no Go import a path, its own module included", () => {
    // The language's answer rather than a default: Go rejects `import "./x"`
    // in modules mode, so an import path is never resolved against the file's
    // own directory. Nothing a `.go` file can write makes this bit true.
    const text = 'package main\n\nimport (\n\t"fmt"\n\t"example.com/acme/alpha/store"\n)\n';
    expect(analyze(text).imports.map((record) => record.spelling.path)).toEqual([false, false]);
  });

  it("calls an import of the file's own module relative, because Go offers no other spelling", () => {
    // `spelling.relative` is the counter-evidence `noSelfCircularDependencies`
    // reads: it asks whether a file left its project through the project's
    // public alias and came back in. A Go package reaching a sibling package
    // of its OWN module cannot be that. Go forbids import cycles at compile
    // time, and it has no relative import form — the full module-qualified
    // path is the only thing the language lets you write. Answering `false`
    // here reported every such import as a violation and demanded a form that
    // does not exist, which is why `true` is the correct reading and not a
    // weakening: the rule keeps every case it could ever have caught, and
    // loses only ones it could never have been right about.
    const text = 'package main\n\nimport "example.com/acme/alpha/store"\n';
    const { imports } = analyze(text);
    expect(imports[0].resolved.target).toBe("alpha");
    expect(imports[0].spelling).toEqual({ path: false, relative: true });
  });

  it("calls an import that leaves the project NOT relative, so the self-import rule keeps its teeth", () => {
    // The near miss for the case above. Without it, `relative: true` could be
    // read as "Go is exempt from the self-import rule" and the test above
    // would still pass while the bit said nothing.
    const text = 'package main\n\nimport (\n\t"fmt"\n\t"example.com/acme/beta/store"\n)\n';
    expect(analyze(text).imports.map((record) => record.spelling.relative)).toEqual([false, false]);
  });

  it("reports the real line of an import a comment used to hide", () => {
    const text = [
      "package main", // 1
      "", // 2
      "import (", // 3
      '\t"fmt"', // 4
      "\t// TODO(alice): drop this once the port lands", // 5
      '\t"example.com/acme/beta/store"', // 6
      ")", // 7
    ].join("\n");
    const { imports, failures } = analyze(text);
    expect(failures).toEqual([]);
    expect(imports.map((record) => [record.line, record.column, record.specifier])).toEqual([
      [4, 2, "fmt"],
      [6, 2, "example.com/acme/beta/store"],
    ]);
    expect(imports[1].resolved.target).toBe("beta");
  });

  it("resolves to the innermost module when one module path nests inside another", () => {
    // `example.com/acme/beta/nested` lives under `example.com/acme/beta`. A
    // first-match answer names the parent project and the nested project's
    // every dependency disappears into it.
    const { imports } = analyze('package main\n\nimport "example.com/acme/beta/nested/x"\n');
    expect(imports[0].resolved.target).toBe("beta-nested");
  });

  it("emits an import of the file's own module rather than dropping it", () => {
    // `contract.md` keeps intra-project imports: a rule about a project
    // reaching itself through its public path cannot be written without them.
    const { imports } = analyze('package main\n\nimport "example.com/acme/alpha/internal"\n');
    expect(imports[0].resolved).toEqual({
      target: "alpha",
      file: null,
      external: false,
      packageName: null,
    });
  });

  it("marks a stdlib or proxy import external and carries its whole path as the package", () => {
    // Where a module path ends inside `github.com/aws/aws-sdk-go-v2/service/s3`
    // is knowable only to the module proxy, so the full path stands in and a
    // `bannedExternalImports` glob matches it the same way.
    const { imports } = analyze(
      'package main\n\nimport (\n\t"net/http"\n\t"github.com/aws/aws-sdk-go-v2/service/s3"\n)\n',
    );
    expect(imports.map((record) => record.resolved)).toEqual([
      { target: null, file: null, external: true, packageName: "net/http" },
      {
        target: null,
        file: null,
        external: true,
        packageName: "github.com/aws/aws-sdk-go-v2/service/s3",
      },
    ]);
  });

  it("finds a module nested below the project root, which the edge resolver does not model", () => {
    // A crate or module in a subdirectory still belongs to the project whose
    // directory contains it. Analysis attributes a file, so it can see one.
    const nested = {
      ...workspace,
      projects: [{ name: "app", root: "apps/thing" }],
      filesOf: () => ["apps/thing/go/go.mod", "apps/thing/go/main.go"],
      readFile: (path) => (path === "apps/thing/go/go.mod" ? "module example.com/thing\n" : null),
    };
    const { imports } = analyzeGo({
      sourceFile: "apps/thing/go/main.go",
      text: 'package main\n\nimport "example.com/thing/sub"\n',
      workspace: nested,
    });
    expect(imports[0].resolved.target).toBe("app");
  });

  it("wins the longest of the file's own modules, the rule that owns nested projects", () => {
    // One project covering two module paths (a nested go.work layout): an
    // import under the long path must be attributed to the long module, not
    // to the short one that contains it. The modules are walked in listed
    // order, so this pins the length comparison itself — a first-match answer
    // would land every `alpha/sub` import on `alpha`.
    const multi = {
      ...workspace,
      filesOf: () => [
        "acme/libs/alpha/sub/go.mod",
        "acme/libs/alpha/go.mod",
        "acme/libs/alpha/main.go",
      ],
      readFile: (path) =>
        ({
          "acme/libs/alpha/sub/go.mod": "module example.com/acme/alpha/sub\n",
          "acme/libs/alpha/go.mod": "module example.com/acme/alpha\n",
        })[path] ?? null,
    };
    const { imports } = analyzeGo({
      sourceFile: "acme/libs/alpha/main.go",
      text: 'package main\n\nimport "example.com/acme/alpha/sub/pkg"\n',
      workspace: multi,
    });
    expect(imports[0].resolved.target).toBe("alpha");
    expect(imports[0].spelling.relative).toBe(true);
  });

  it("analyzes a file no project owns with no own-module match to claim", () => {
    // `owner` is null here, and the module map is all that remains: a loose
    // `.go` file still resolves its imports against the workspace's modules,
    // and can never be "its own project's" import, for the trivial reason it
    // has none.
    const { imports } = analyze(
      'package main\n\nimport "example.com/acme/alpha/store"\n',
      "loose/tool.go",
    );
    expect(imports[0].resolved.target).toBe("alpha");
    expect(imports[0].spelling).toEqual({ path: false, relative: false });
  });

  it("returns an envelope rather than throwing when the workspace misbehaves", () => {
    const hostile = {
      ...workspace,
      filesOf: () => {
        throw new Error("graph unavailable");
      },
    };
    const result = analyzeGo({ sourceFile: "a/b.go", text: 'import "fmt"', workspace: hostile });
    expect(result.imports).toEqual([]);
    expect(result.failures[0].reason).toMatch(/graph unavailable/);
  });

  it("keeps returning an envelope when the workspace throws something that is not an Error", () => {
    // A thrown string carries no `message`; the fallback must still land in a
    // failure record rather than a crash — a file with no verdict must never
    // look like a file with nothing to say.
    const hostile = {
      ...workspace,
      filesOf: () => {
        throw "graph unavailable";
      },
    };
    const result = analyzeGo({ sourceFile: "a/b.go", text: 'import "fmt"', workspace: hostile });
    expect(result.failures[0].reason).toBe("Go analysis failed: graph unavailable");
  });
});

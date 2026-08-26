import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import { maskJavaComments, maskKotlinComments } from "./mask.mjs";

/**
 * The mask's shape contract, shared with `go.test.mjs`'s `preservesShape`:
 * same length, every line break in place. Positions are read off the mask,
 * so a mask that shifted either would report imports on lines nobody wrote.
 */
const preservesShape = (mask, source) => {
  const masked = mask(source);
  expect(masked).toHaveLength(source.length);
  expect([...masked].map((c, i) => (c === "\n" ? i : -1))).toEqual(
    [...source].map((c, i) => (c === "\n" ? i : -1)),
  );
  return masked;
};

/** The same text with every character of `hidden` replaced by a space. */
const blanked = (kept, hidden) => `${kept}${" ".repeat(hidden.length)}`;

describe("maskJavaComments", () => {
  it("blanks a line comment and keeps the code beside it", () => {
    const code = "import java.util.List; ";
    const comment = "// TODO: narrow this import";
    expect(preservesShape(maskJavaComments, `${code}${comment}\n`)).toBe(
      `${blanked(code, comment)}\n`,
    );
  });

  it("blanks a block comment across every line it spans", () => {
    // Literals blank too, so `"kept"` becomes six spaces before its semicolon.
    expect(preservesShape(maskJavaComments, `/*\nimport java.util.Hidden;\n*/\n"kept";\n`)).toBe(
      "  \n                        \n  \n      ;\n",
    );
  });

  it("does NOT treat block comments as nesting — the first */ closes one", () => {
    // javadoc quoting a code snippet is ordinary Java. A nesting scan would
    // keep masking past the first terminator and swallow every real import
    // below: the silent direction, byte-for-byte identical to a clean file.
    const source = [
      "/** Example:",
      " <pre>{@code /* inner */}</pre> */",
      "import java.util.List;",
      "class T {}",
    ].join("\n");
    const masked = preservesShape(maskJavaComments, source);
    expect(masked).toContain("import java.util.List;");
  });

  it("blanks a string literal holding an import-looking line", () => {
    const source = 'String s = "package x.y;\\nimport x.y.Z;";\nimport real.pkg.A;\n';
    const masked = preservesShape(maskJavaComments, source);
    expect(masked).toContain("import real.pkg.A;");
    expect(masked).not.toContain("import x.y.Z;");
    expect(masked).not.toContain("package x.y;");
  });

  it("blanks a char literal that could open or close a comment", () => {
    const source = "char c = '\"';\nchar d = '/';\nimport p.Q;\n";
    const masked = preservesShape(maskJavaComments, source);
    expect(masked).toContain("import p.Q;");
  });

  it("blanks a text block quoting package and import declarations", () => {
    const source = [
      'String sql = """',
      "    package fake.pkg;",
      "    import fake.other.Tool;",
      '    """;',
      "import real.pkg.A;",
    ].join("\n");
    const masked = preservesShape(maskJavaComments, source);
    expect(masked).not.toContain("fake.pkg");
    expect(masked).toContain("import real.pkg.A;");
  });

  it("honors escaped quotes inside string literals", () => {
    const source = 'String s = "quote \\" then /* not a comment"; import after.p;\n';
    const masked = preservesShape(maskJavaComments, source);
    expect(masked).toContain("import after.p;");
    expect(masked).not.toContain("not a comment");
  });

  it("reads the six-quote empty text block as one closed literal", () => {
    // `""""""` is Java's empty text block: three quotes open, three close.
    // Reading it as two ordinary strings would leave stray quotes behind and
    // mis-scan whatever follows; reading it unopened would leak its span.
    const source = 'String s = """""";\nimport after.p;\n';
    const masked = preservesShape(maskJavaComments, source);
    expect(masked).toContain("import after.p;");
  });

  it("survives an unterminated literal without throwing", () => {
    const masked = preservesShape(maskJavaComments, 'String s = "open\nimport p.Q;\n');
    // The unterminated string swallows to end-of-line only; the import below
    // survives because Java strings cannot span lines unescaped.
    expect(masked).toContain("import p.Q;");
  });
});

describe("maskKotlinComments", () => {
  it("blanks nested block comments by their depth", () => {
    // Kotlin's spec makes block comments nest. The inner opener must raise
    // the depth so the FIRST closer does not reopen code that is still
    // comment prose.
    const source = ["/* outer", " /* inner */ still comment */", "val x = 1", "import p.Q"].join(
      "\n",
    );
    const masked = preservesShape(maskKotlinComments, source);
    expect(masked).not.toContain("still comment");
    expect(masked).toContain("val x = 1");
    expect(masked).toContain("import p.Q");
  });

  it("blanks a raw string with no escape processing", () => {
    // In a raw string a backslash escapes nothing, so \""" must NOT be read
    // as an escaped quote pair plus a stray quote — the literal runs until
    // three consecutive quotes, whatever precedes them.
    const source = ['val s = """', 'path \\"quoted\\"', '"""', "import p.Q"].join("\n");
    const masked = preservesShape(maskKotlinComments, source);
    expect(masked).toContain("import p.Q");
  });

  it("keeps a raw string containing import-like lines invisible to matching", () => {
    const source = [
      'val doc = """',
      "package fake.pkg",
      "import fake.other.Tool",
      '"""',
      "import real.pkg.A",
    ].join("\n");
    const masked = preservesShape(maskKotlinComments, source);
    expect(masked).not.toContain("fake.pkg");
    expect(masked).toContain("import real.pkg.A");
  });

  it("escapes still work inside ordinary Kotlin strings", () => {
    const source = 'val s = "quote \\" here /* no comment"\nimport p.Q\n';
    const masked = preservesShape(maskKotlinComments, source);
    expect(masked).toContain("import p.Q");
    expect(masked).not.toContain("no comment");
  });
});

// The lines a JVM file is made of, as the scanner sees them: declarations it
// must read, and every construct that must hide one. Import-looking text
// appears ONLY inside literals and comments — so a correct mask leaves no
// line-start `import` visible anywhere, which is exactly what the property
// below demands. A scanner that let any literal or comment body through
// fails it; a scanner that ate real code cannot (the generator writes none).
const hiddenImportLine = fc.constantFrom(
  "import hidden.pkg.Ghost;",
  "\timport hidden.pkg.Ghost;",
  "package hidden.pkg;",
  "import a.b.*",
);
const hidingConstruct = fc.oneof(
  hiddenImportLine.map((line) => `/* ${line} */`),
  hiddenImportLine.map((line) => `/* ${line}`),
  hiddenImportLine.map((line) => `// ${line}`),
  hiddenImportLine.map((line) => `"${line.replaceAll('"', '\\"')}"`),
  hiddenImportLine.map((line) => `"""${line}"""`),
);
const visibleCode = fc.constantFrom("class T {}", "val x = 1", "", "  fun f() {}", "void g() {}");

describePropMask(maskJavaComments, "maskJavaComments", hidingConstruct, visibleCode);
describePropMask(maskKotlinComments, "maskKotlinComments", hidingConstruct, visibleCode);

function describePropMask(mask, name, hiding, code) {
  describe(`${name} properties`, () => {
    test.prop([fc.array(fc.oneof(hiding, code), { maxLength: 24 })])(
      "preserves length and line breaks over arbitrary token soup",
      (lines) => {
        preservesShape(mask, lines.join("\n"));
      },
    );

    test.prop([fc.array(fc.oneof(hiding, code), { maxLength: 24 })])(
      "hides every import-looking line written inside a literal or comment",
      (lines) => {
        const masked = mask(lines.join("\n"));
        for (const line of masked.split("\n")) {
          expect(line.trim().startsWith("import")).toBe(false);
          expect(line.trim().startsWith("package")).toBe(false);
        }
      },
    );
  });
}

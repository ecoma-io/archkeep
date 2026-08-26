import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import { maskCSharpComments } from "./mask.mjs";

/**
 * The mask's shape contract, shared with `../jvm/mask.test.mjs`'s
 * `preservesShape`: same length, every line break in place. Positions are
 * read off the mask, so a mask that shifted either would report directives on
 * lines nobody wrote.
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

describe("maskCSharpComments", () => {
  it("blanks a line comment and keeps the code beside it", () => {
    const code = "using Acme.Domain; ";
    const comment = "// TODO: narrow this import";
    expect(preservesShape(maskCSharpComments, `${code}${comment}\n`)).toBe(
      `${blanked(code, comment)}\n`,
    );
  });

  it("blanks a block comment across every line it spans", () => {
    // Literals blank too, so `"kept"` becomes six spaces before its semicolon.
    expect(preservesShape(maskCSharpComments, `/*\nusing Acme.Hidden;\n*/\n"kept";\n`)).toBe(
      "  \n                  \n  \n      ;\n",
    );
  });

  it("does NOT treat block comments as nesting — the first */ closes one", () => {
    // XML-doc comments quoting a snippet are ordinary C#. A nesting scan
    // would keep masking past the first terminator and swallow every real
    // directive below: the silent direction, byte-for-byte identical to a
    // clean file.
    const source = [
      "/// <example><c>/* inner */</c></example>",
      "using Acme.Domain;",
      "class T {}",
    ].join("\n");
    const masked = preservesShape(maskCSharpComments, source);
    expect(masked).toContain("using Acme.Domain;");
  });

  it("blanks a string literal holding a directive-looking line", () => {
    const source = 'string s = "namespace x.y;\\nusing x.y.Z;";\nusing Real.Namespace;\n';
    const masked = preservesShape(maskCSharpComments, source);
    expect(masked).toContain("using Real.Namespace;");
    expect(masked).not.toContain("using x.y.Z;");
    expect(masked).not.toContain("namespace x.y;");
  });

  it("blanks a verbatim string spanning lines, honoring doubled quotes", () => {
    const source = [
      'var sql = @"select ""using fake.ns""',
      'from t";',
      "using Real.Namespace;",
    ].join("\n");
    const masked = preservesShape(maskCSharpComments, source);
    expect(masked).toContain("using Real.Namespace;");
    expect(masked).not.toContain("fake.ns");
  });

  it("blanks an interpolated string whose holes hold quoted strings", () => {
    // The hole's quotes pair off as ordinary delimiters; no fragment inside
    // can spell a directive. The directive BELOW must survive — the naive
    // pairing may not overshoot its true terminator on valid input.
    const source = ['var m = $"{d["k"]}-{f(a["x"], b["y"])}";', "", "using Real.Namespace;"].join(
      "\n",
    );
    const masked = preservesShape(maskCSharpComments, source);
    expect(masked).toContain("using Real.Namespace;");
  });

  it("blanks a verbatim interpolated string in either $-spelling", () => {
    for (const opener of ["$@", "@$"]) {
      const source = [`var v = ${opener}"line ""q"" using fake.ns";`, "using Real.Namespace;"].join(
        "\n",
      );
      const masked = preservesShape(maskCSharpComments, source);
      expect(masked).toContain("using Real.Namespace;");
      expect(masked).not.toContain("fake.ns");
    }
  });

  it("blanks raw strings with backslashes left alone", () => {
    const source = ['var p = """c:\\dir\\"quoted\\", end""" ;', "using Real.Namespace;"].join("\n");
    const masked = preservesShape(maskCSharpComments, source);
    expect(masked).toContain("using Real.Namespace;");
    expect(masked).not.toContain("quoted");
  });

  it("blanks a wider raw string whose content holds a narrower quote run", () => {
    // Four quotes open because the content contains a three-quote run; only
    // a run of four or more ends the literal.
    const source = ['var s = """"a """ b"""";', "using Real.Namespace;"].join("\n");
    const masked = preservesShape(maskCSharpComments, source);
    expect(masked).toContain("using Real.Namespace;");
    expect(masked).not.toContain("b");
  });

  it("blanks an interpolated raw string opened by $$ before the quote run", () => {
    const source = ['var j = $$"""', "{ using fake.ns }", '""" ;', "using Real.Namespace;"].join(
      "\n",
    );
    const masked = preservesShape(maskCSharpComments, source);
    expect(masked).toContain("using Real.Namespace;");
    expect(masked).not.toContain("fake.ns");
  });

  it("blanks a char literal that could open or close a comment or string", () => {
    const source = "char c = '\"';\nchar d = '/';\nchar e = '\\'';\nusing Real.Namespace;\n";
    const masked = preservesShape(maskCSharpComments, source);
    expect(masked).toContain("using Real.Namespace;");
  });

  it("reads an empty ordinary string as one closed literal", () => {
    const source = 'string s = "";\nusing Real.Namespace;\n';
    const masked = preservesShape(maskCSharpComments, source);
    expect(masked).toContain("using Real.Namespace;");
  });

  it("survives an unterminated ordinary string without swallowing past its line", () => {
    const masked = preservesShape(maskCSharpComments, 'string s = "open\nusing Real.Namespace;\n');
    // The unterminated string swallows to end-of-line only; the directive
    // below survives because ordinary C# strings cannot span lines unescaped.
    expect(masked).toContain("using Real.Namespace;");
  });
});

// The lines a C# file is made of, as the scanner sees them: declarations it
// must read, and every construct that must hide one. Directive-looking text
// appears ONLY inside literals and comments — so a correct mask leaves no
// line-start `using`/`namespace` visible anywhere, which is exactly what the
// property below demands. A scanner that let any literal or comment body
// through fails it; a scanner that ate real code cannot (the generator writes
// none).
const hiddenDirectiveLine = fc.constantFrom(
  "using hidden.ns.Ghost;",
  "\tusing hidden.ns.Ghost;",
  "global using hidden.ns;",
  "namespace hidden.ns;",
);
const hidingConstruct = fc.oneof(
  hiddenDirectiveLine.map((line) => `/* ${line} */`),
  hiddenDirectiveLine.map((line) => `/* ${line}`),
  hiddenDirectiveLine.map((line) => `// ${line}`),
  hiddenDirectiveLine.map((line) => `"${line.replaceAll('"', '\\"')}"`),
  hiddenDirectiveLine.map((line) => `@"${line.replaceAll('"', '""')}"`),
  hiddenDirectiveLine.map((line) => `$"${line.replaceAll('"', '\\"')}"`),
  hiddenDirectiveLine.map((line) => `"""${line}"""`),
  hiddenDirectiveLine.map((line) => `'${line.replaceAll("'", "\\'")}'`),
);
const visibleCode = fc.constantFrom(
  "class T {}",
  "int x = 1;",
  "",
  "  void G() {}",
  "record R(int A);",
);

describePropMask(maskCSharpComments, "maskCSharpComments", hidingConstruct, visibleCode);

function describePropMask(mask, name, hiding, code) {
  describe(`${name} properties`, () => {
    test.prop([fc.array(fc.oneof(hiding, code), { maxLength: 24 })])(
      "preserves length and line breaks over arbitrary token soup",
      (lines) => {
        preservesShape(mask, lines.join("\n"));
      },
    );

    test.prop([fc.array(fc.oneof(hiding, code), { maxLength: 24 })])(
      "hides every directive-looking line written inside a literal or comment",
      (lines) => {
        const masked = mask(lines.join("\n"));
        for (const line of masked.split("\n")) {
          const trimmed = line.trim();
          expect(trimmed.startsWith("using")).toBe(false);
          expect(trimmed.startsWith("namespace")).toBe(false);
        }
      },
    );

    test.prop([fc.array(fc.oneof(hiding, code), { maxLength: 24 })])(
      "is idempotent — masking twice equals masking once",
      (lines) => {
        const source = lines.join("\n");
        expect(mask(mask(source))).toBe(mask(source));
      },
    );
  });
}

import { describe, expect, it } from "vitest";

import {
  analysisFailedDiagnostic,
  ANALYSIS_FAILURE_CODE,
  DIAGNOSTIC_SOURCE,
  documentLines,
  failureDiagnostic,
  incompleteIndexDiagnostic,
  rangeAt,
  violationDiagnostic,
} from "./diagnostics.mjs";

/**
 * Where a substring sits in a text, in BOTH coordinate systems.
 *
 * Derived from the text rather than written as literals, so the expectations
 * below cannot quietly agree with a wrong implementation: change the fixture
 * and both sides move together, change the conversion and only one does.
 */
function locate(text, needle) {
  const offset = text.indexOf(needle);
  if (offset === -1) throw new Error(`fixture does not contain ${needle}`);
  const before = text.slice(0, offset);
  const zeroBasedLine = before.split("\n").length - 1;
  const zeroBasedCharacter = offset - (before.lastIndexOf("\n") + 1);
  return {
    zeroBased: { line: zeroBasedLine, character: zeroBasedCharacter },
    // What an analyzer records: `../analysis/contract.md` fixes both axes as
    // 1-based, because a `file:line:column` terminal report wants them that way.
    oneBased: { line: zeroBasedLine + 1, column: zeroBasedCharacter + 1 },
  };
}

describe("the 1-based analysis record to 0-based LSP position conversion", () => {
  const source = ["package main", "", "import (", '\t"example.test/other/pkg"', ")", ""].join("\n");
  const specifier = "example.test/other/pkg";
  const at = locate(source, `"${specifier}"`);

  it("subtracts one from both axes, so a diagnostic lands on the import it is about", () => {
    // The whole reason this function exists. A missing subtraction on either
    // axis still produces a diagnostic — one line or one column away — and
    // every developer who follows it edits the wrong place.
    const range = rangeAt({ ...at.oneBased, specifier }, documentLines(source));

    expect(range.start).toEqual(at.zeroBased);
    expect(
      source.split("\n")[range.start.line].slice(range.start.character, range.start.character + 1),
    ).toBe('"');
  });

  it("covers the quotes when the analyzer pointed at a quoted literal", () => {
    // TypeScript and Go report the position of the OPENING QUOTE, so a range
    // measured as the specifier's own length would stop one character short and
    // leave the closing quote outside the squiggle.
    const range = rangeAt({ ...at.oneBased, specifier }, documentLines(source));

    expect(range.end.character - range.start.character).toBe(specifier.length + 2);
    expect(
      source.split("\n")[range.start.line].slice(range.start.character, range.end.character),
    ).toBe(`"${specifier}"`);
  });

  it("covers the specifier alone when the analyzer pointed at an unquoted path", () => {
    // Rust and Python report the first character of the path itself. A blanket
    // "+2 for quotes" would then swallow the two characters after it.
    const rust = "use other_crate::thing;\n";
    const use = locate(rust, "other_crate::thing");
    const range = rangeAt(
      { ...use.oneBased, specifier: "other_crate::thing" },
      documentLines(rust),
    );

    expect(rust.slice(range.start.character, range.end.character)).toBe("other_crate::thing");
  });

  it("keeps columns stable across CRLF, because the carriage return ends the line before", () => {
    // `../analysis/source-util.mjs` fixes this: a CRLF file reports the same
    // columns as an LF one. Splitting the document on `\r\n` here would shift
    // nothing visibly on line one and everything on line two.
    const crlf = 'package main\r\n\r\nimport "example.test/other"\r\n';
    const found = locate(crlf.replaceAll("\r", ""), '"example.test/other"');
    const range = rangeAt(
      { ...found.oneBased, specifier: "example.test/other" },
      documentLines(crlf),
    );

    expect(range.start).toEqual(found.zeroBased);
    expect(
      crlf.split("\n")[range.start.line].slice(range.start.character, range.end.character),
    ).toBe('"example.test/other"');
  });

  it("clamps a range that outruns its line instead of emitting one out of spec", () => {
    // Rust collapses a `use` path wrapped across lines into one specifier, so a
    // record can legitimately be longer than the line it starts on. Clients
    // differ on whether they clip such a diagnostic or DROP it, and a dropped
    // diagnostic is silence — the one thing this server may never produce.
    const short = "use a::b;\n";
    const range = rangeAt(
      { line: 1, column: 5, specifier: "a::{ b, c, d }" },
      documentLines(short),
    );

    expect(range.end.character).toBe(short.split("\n")[0].length);
    expect(range.end.character).toBeGreaterThanOrEqual(range.start.character);
  });

  it("clamps a line past the end of the document onto the last line that exists", () => {
    const range = rangeAt({ line: 99, column: 1, specifier: "x" }, documentLines("only\n"));

    expect(range.start.line).toBeLessThanOrEqual(documentLines("only\n").length - 1);
  });

  it("gives a whole-file failure the first line rather than an invisible caret", () => {
    // `contract.md` fixes `line`/`column` as explicit nulls for a failure about
    // the file as a whole. A zero-width range at the origin renders as nothing
    // in most editors, and an invisible "this file was not checked" is exactly
    // the silence this module exists to prevent.
    const text = "package main\n\nfunc main() {}\n";
    const range = rangeAt({ line: null, column: null }, documentLines(text));

    expect(range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: "package main".length },
    });
  });

  it("still lands on the first line when the document has no lines at all", () => {
    // `documentLines` always yields at least one element, but the function
    // must not depend on that being true of its caller.
    const range = rangeAt({ line: null, column: null }, []);
    expect(range).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
  });

  it("clamps a position against an empty line array, not just a short one", () => {
    const range = rangeAt({ line: 5, column: 20, specifier: "x" }, []);
    expect(range.start.line).toBe(0);
    expect(range.start.character).toBe(0);
    expect(range.end.character).toBe(0);
  });

  it("reads a missing column as the start of the line", () => {
    // The record's column is 1-based; a record that carries none must not
    // shift the diagnostic by one.
    const range = rangeAt({ line: 2, column: null, specifier: "x" }, documentLines("one\ntwo\n"));
    expect(range.start.character).toBe(0);
  });
});

describe("diagnostics a reader has to be able to tell apart", () => {
  const lines = documentLines('import "example.test/other"\n');

  it("carries the upstream messageId as the code, so a verdict can be compared with ESLint's", () => {
    const diagnostic = violationDiagnostic(
      {
        line: 1,
        column: 8,
        specifier: "example.test/other",
        messageId: "onlyTagsConstraintViolation",
        message:
          'A project tagged with "zone:inner" can only depend on libs tagged with zone:inner',
      },
      lines,
    );

    expect(diagnostic.code).toBe("onlyTagsConstraintViolation");
    expect(diagnostic.source).toBe(DIAGNOSTIC_SOURCE);
    expect(diagnostic.severity).toBe(1);
    expect(diagnostic.message).toContain("can only depend on libs tagged with");
  });

  it("marks a failure with a code that is not a rule id, so 'we looked' and 'we could not' differ", () => {
    // A shared code would collapse "a rule found something" into "no rule could
    // look", and the second is the one that must never be mistaken for clean.
    const diagnostic = failureDiagnostic(
      { line: 1, column: 8, reason: "TypeScript cannot resolve 'x'" },
      lines,
    );

    expect(diagnostic.code).toBe(ANALYSIS_FAILURE_CODE);
    expect(diagnostic.code).not.toBe("onlyTagsConstraintViolation");
    expect(diagnostic.severity).toBe(2);
    expect(diagnostic.message).toContain("not fully checked");
    expect(diagnostic.message).toContain("TypeScript cannot resolve 'x'");
  });

  it("says in words that a file with no verdict is not a clean file", () => {
    // The severity alone does not tell a developer that the verdict is missing
    // rather than empty, and this is the diagnostic that stands in for silence.
    const diagnostic = analysisFailedDiagnostic("the boundary config would not load", lines);

    expect(diagnostic.severity).toBe(1);
    expect(diagnostic.code).toBe(ANALYSIS_FAILURE_CODE);
    expect(diagnostic.message).toContain("could not be checked");
    expect(diagnostic.message).toContain("NOT a clean result");
  });

  it("names every file behind an incomplete graph, so the reader knows what to open", () => {
    // The report is only actionable if it says which file broke. A message
    // that said "the index is incomplete" and stopped would leave a developer
    // with a warning on a file that is not the problem and no way to find the
    // one that is.
    const diagnostic = incompleteIndexDiagnostic(
      ["libs/outer/project.json is not valid JSON: InvalidSymbol in JSON at 1:3"],
      lines,
    );

    expect(diagnostic.code).toBe(ANALYSIS_FAILURE_CODE);
    // A warning, not an error: a rule pass DID run over this document and what
    // it found is in the same list. What is qualified is the tree it ran over.
    expect(diagnostic.severity).toBe(2);
    expect(diagnostic.message).toContain("INCOMPLETE");
    expect(diagnostic.message).toContain("libs/outer/project.json");
  });

  it("folds many gaps into one diagnostic and counts the ones it does not name", () => {
    // One marker per broken file would scale the noise with the breakage: a
    // developer who mistyped one `project.json` would meet a wall of identical
    // warnings on a file that has nothing to do with it, and learn to dismiss
    // the whole class.
    const gaps = Array.from(
      { length: 9 },
      (_, index) => `libs/p${index}/project.json is unreadable`,
    );

    const diagnostic = incompleteIndexDiagnostic(gaps, lines);

    expect(diagnostic.message).toContain("libs/p0/project.json");
    expect(diagnostic.message).toContain("libs/p4/project.json");
    expect(diagnostic.message).not.toContain("libs/p5/project.json");
    expect(diagnostic.message).toContain("and 4 more");
  });
});

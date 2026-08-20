/**
 * `maskNonCode`'s one contract is same-length, index-preserving masking
 * (this file's own header). Both regressions here are silent-direction: the
 * masked string used to come out SHORTER, or a masked-as-plain-division
 * regex used to eat real code, and either one moves a later `match.index`
 * off the byte it should name — which is how a determinism-guard exemption
 * silently migrates onto a line it was never meant to cover.
 */
import { describe, expect, it } from "vitest";

import { maskNonCode } from "./mask-non-code.mjs";

describe("maskNonCode — same-length contract", () => {
  it("a single-line comment does not shorten the masked result by its trailing newline", () => {
    // "// c\nx" is 6 bytes: "// c" (4) + "\n" (1) + "x" (1). The pre-fix code
    // consumed the `\n` while advancing `i` past it but never appended a
    // character for it, so the masked string came out 5 bytes — one short.
    const src = "// c\nx";
    expect(src).toHaveLength(6);
    expect(maskNonCode(src)).toHaveLength(6);
  });

  it("preserves length for a comment with no trailing newline (EOF)", () => {
    const src = "// c";
    expect(maskNonCode(src)).toHaveLength(src.length);
  });

  it("preserves length across a mix of comments, strings, and code", () => {
    const src = ["// header", "const a = 'x'; // trailing", "function f() { return a; }", ""].join(
      "\n",
    );
    expect(maskNonCode(src)).toHaveLength(src.length);
  });

  it("keeps the masked line after a `//` comment aligned with the real line — the determinism-guard scenario", () => {
    // Mirrors `determinism-source-guard.test.mjs`'s Contract K scan exactly:
    // a consumer maps `match.index` (found in the MASKED string) back to a
    // line number by slicing the ORIGINAL source
    // (`content.slice(0, match.index).split("\n").length`). The old,
    // length-losing mask dropped exactly one byte (the comment's trailing
    // `\n`) per `//` comment; that one byte only crosses a LINE boundary in
    // the slice when the real read sits at column 0 of the line right after
    // the comment — `Date.now()` starts the instant the comment's newline
    // would have, so subtracting the one dropped byte lands the slice
    // exactly ON that newline instead of past it, undercounting it. A read
    // placed further into its line (e.g. behind `stamp(`) does NOT reproduce
    // this: the one-byte drift stays short of the previous newline and the
    // line number comes out right even on the buggy masker, which is why an
    // earlier version of this fixture passed on unfixed code too — the
    // regression needs the drift to straddle the boundary, not just exist.
    const content = "// allow-listed decoy line\nDate.now();\n";
    const allowlist = new Map([["file.mjs", [1]]]); // only line 1 is exempt
    const masked = maskNonCode(content);
    const match = /Date\s*\.\s*now\s*\(/.exec(masked);
    expect(match).not.toBeNull();
    const line = content.slice(0, match.index).split("\n").length;
    expect(line).toBe(2);
    expect(allowlist.get("file.mjs")).not.toContain(line);
  });
});

describe("maskNonCode — regex literal recognition tolerates surrounding whitespace", () => {
  it("masks a normally-spaced regex literal instead of falling through to division", () => {
    // `= /re/` (spaces on both sides of the slashes) used to fail the
    // leading-operator heuristic entirely, since it tested only the ONE
    // character immediately before the `/` — a space, not `=`.
    const src = "const re = /re/;\n";
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    // The pattern text is masked away; only the code skeleton remains.
    expect(masked).not.toContain("re/");
  });

  it("does not let a quote inside a spaced regex literal swallow real code that follows", () => {
    // The exact regression: `/don't/` (spaced) misread as division opens the
    // single-quote string branch on the apostrophe inside "don't", which then
    // consumes through the NEXT quote it finds (the one opening 'x'), and the
    // stray trailing quote after that swallows everything to end of file —
    // hiding the raw Date.now() read below it from every guard that scans
    // the mask.
    const src = "const re = /don't/;\nconst t = 'x';\nstamp(Date.now());\n";
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    expect(masked).toContain("Date.now");
    expect(masked).toContain("stamp(");
  });

  it("still treats a division after an identifier as division, not a regex", () => {
    const src = "const q = a / b;\n";
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    expect(masked).toContain("a / b");
  });
});

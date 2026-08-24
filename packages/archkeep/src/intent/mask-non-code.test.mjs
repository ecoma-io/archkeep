/**
 * `maskNonCode`'s one contract is same-length, index-preserving masking
 * (that file's own header). Every regression pinned here is silent-direction:
 * the masked string used to come out SHORTER or LONGER than its source, or a
 * regex literal read as division used to eat real code, and either one moves a
 * later `match.index` off the byte it should name — which is how a
 * determinism-guard exemption silently migrates onto a line it was never meant
 * to cover, or how a whole file's tail stops being scanned at all.
 *
 * The positive-control suite is the one this file was missing. Contract K's two
 * guards in `intent.test.mjs` both pass by finding NOTHING in the masked text,
 * so nothing in the repository distinguished "the tree is clean" from "the
 * mask blanked the tree". It did: a regex literal holding an apostrophe
 * (`src/workspace.mjs:203`) was read as division, its apostrophe opened the
 * string branch, and 83.5% of that module's non-space characters were blanked
 * from there to end of file. Injecting each forbidden read into a copy of every
 * production module and requiring the guard to name it is what makes "found
 * nothing" a claim instead of a shrug.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { maskNonCode } from "./mask-non-code.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..");

/**
 * Every production (non-`.test.mjs`, non-`.integ.mjs`) `.mjs` file under
 * `src/`, relative to it.
 *
 * A third copy of `intent.test.mjs`'s `productionMjsFiles` walk, and
 * deliberately so: that helper is module-private to a test file which exports
 * nothing, and the set this suite covers has to be the same set the guard
 * scans — a mask proven sound over a smaller set proves nothing about the
 * files left out. `determinism-source-guard.test.mjs` holds the same mirror
 * for the same reason. An empty answer throws rather than passing vacuously.
 *
 * @returns {string[]}
 */
function productionModules() {
  const files = readdirSync(SRC, { recursive: true })
    .filter(
      (f) =>
        typeof f === "string" &&
        f.endsWith(".mjs") &&
        !f.endsWith(".test.mjs") &&
        !f.endsWith(".integ.mjs"),
    )
    .map((f) => String(f));
  if (files.length === 0) {
    throw new Error("mask-non-code: found no production .mjs files under src/ — nothing scanned");
  }
  return files;
}

/**
 * The forbidden reads Contract K scans the MASKED text for, each paired with a
 * quote-free snippet that spells it.
 *
 * The three wall-clock patterns and the `localeCompare` probe are copies of
 * `intent.test.mjs`'s, which is why the first test below reads that file and
 * requires every `source` here to still appear in it: a copy nothing checks is
 * a copy that agrees with the original only until someone edits one of them.
 */
const FORBIDDEN = [
  { snippet: "Date.now();", pattern: /Date\s*\.\s*now\s*\(/ },
  { snippet: "Math.random();", pattern: /Math\s*\.\s*random\s*\(/ },
  { snippet: "new Date();", pattern: /new\s+Date\s*\(\s*\)/ },
  { snippet: "x.localeCompare(y);", pattern: /\blocaleCompare\s*\(/ },
];

/**
 * The 1-based lines of `source` at which `pattern` matches the MASKED text —
 * the exact arithmetic Contract K's guard uses to name a violation's site.
 *
 * @param {string} source
 * @param {RegExp} pattern
 * @returns {number[]}
 */
function maskedHitLines(source, pattern) {
  return hitLinesIn(source, maskNonCode(source))[pattern.source];
}

/**
 * Every forbidden pattern's hit lines, read off a mask computed ONCE.
 *
 * The positive controls below scan the whole shipped tree twice over; masking
 * each module once per pattern instead of once per module is four times the
 * work for the same answer, and the difference is the suite's runtime.
 *
 * @param {string} source The text `masked` was produced from.
 * @param {string} masked
 * @returns {Record<string, number[]>} Keyed by each pattern's `source`.
 */
function hitLinesIn(source, masked) {
  /** @type {Record<string, number[]>} */
  const byPattern = {};
  for (const { pattern } of FORBIDDEN) {
    byPattern[pattern.source] = [...masked.matchAll(RegExp(pattern.source, "g"))].map(
      (match) => source.slice(0, match.index).split("\n").length,
    );
  }
  return byPattern;
}

/**
 * The keywords `mask-non-code.mjs` treats as expression openers — a `/` after
 * one of them is a regex — read off that module's own source rather than
 * copied here.
 *
 * Every one of them is also a legal PROPERTY name, which is the whole of the
 * defect the suite below pins, so the set has to be the module's own: a
 * keyword added there tomorrow is covered here today, and a copy would agree
 * with it only until someone edited one of them. An empty read throws rather
 * than letting a table-driven suite assert nothing.
 *
 * @returns {string[]}
 */
function expressionKeywords() {
  const source = readFileSync(join(__dirname, "mask-non-code.mjs"), "utf-8");
  const declaration = "const EXPRESSION_KEYWORDS = new Set([";
  const start = source.indexOf(declaration);
  const end = source.indexOf("]);", start);
  if (start === -1 || end === -1) {
    throw new Error(
      "mask-non-code: EXPRESSION_KEYWORDS is not declared where this suite reads it — the " +
        "dotted-property cases below would cover nothing",
    );
  }
  const words = [...source.slice(start + declaration.length, end).matchAll(/"([A-Za-z]+)"/g)].map(
    (match) => match[1],
  );
  if (words.length === 0) {
    throw new Error("mask-non-code: read an EMPTY EXPRESSION_KEYWORDS — nothing would be asserted");
  }
  return words;
}

/**
 * One line spelling every forbidden read at once, with no quote in it.
 *
 * The four patterns are disjoint — none matches any part of another's
 * spelling — so injecting them together asks exactly what injecting them one
 * at a time would, for a quarter of the masking.
 */
const ALL_FORBIDDEN_LINE = FORBIDDEN.map(({ snippet }) => snippet).join(" ");

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

  it("preserves length for a literal holding a non-BMP character", () => {
    // A surrogate pair is two code UNITS and one code POINT. A blanking pass
    // written with `for…of` walks code points and emits one space for the
    // pair, which is one byte short — and one byte short is every later
    // `match.index` naming the wrong site.
    const src = 'const flag = "\u{1F6A9}";\n';
    expect(maskNonCode(src)).toHaveLength(src.length);
  });

  it("preserves length for an unterminated regex-position slash at EOF", () => {
    // `end = j + 1` past a scan that ran off the end produced a masked string
    // ONE byte longer than its source — measured on `src/workspace.mjs`, whose
    // 28260-byte source masked to 28261.
    const src = "const re = /abc";
    expect(maskNonCode(src)).toHaveLength(src.length);
  });

  it("preserves length for every production module under src/ — the whole shipped tree", () => {
    // The assertion that goes red on the unfixed masker: `workspace.mjs` was
    // 28260 bytes of source and 28261 of mask. A guard reading `match.index`
    // out of a result that is not the source's length is reading offsets that
    // belong to no file.
    const mismatches = [];
    for (const file of productionModules()) {
      const source = readFileSync(join(SRC, file), "utf-8");
      const masked = maskNonCode(source);
      if (masked.length !== source.length) {
        mismatches.push(`src/${file}: source=${source.length} masked=${masked.length}`);
      }
    }
    expect(mismatches).toEqual([]);
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

  it("keeps the masked result's line structure identical to the source's", () => {
    // Newlines survive blanking, so line N of the mask is line N of the file.
    // Without it a multi-line comment or template collapses into one masked
    // line and every line-indexed reader of the result is off by the number of
    // newlines it swallowed.
    const src = "/* a\n b\n c */\nconst t = `x\ny`;\nDate.now();\n";
    const masked = maskNonCode(src);
    expect(masked.split("\n")).toHaveLength(src.split("\n").length);
    expect(masked.split("\n")[5]).toBe("Date.now();");
  });
});

describe("maskNonCode — regex literal versus division", () => {
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

  it("masks a regex literal that opens right after `return` — the shape that blanked workspace.mjs", () => {
    // `src/workspace.mjs:203` verbatim. The previous heuristic read the last
    // non-space CHARACTER, which is the `n` of `return`, and called the slash
    // division. The regex then went unmasked, its first `'` opened a string
    // that had no newline stop, and everything after it in the file was
    // blanked — so the `Date.now()` below scanned clean.
    const src = [
      "function exposesRemotes(config) {",
      "  return /('|\")?exposes('|\")?:/.test(config);",
      "}",
      "const t = Date.now();",
      "",
    ].join("\n");
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    // The regex's own text is gone and the code around it is not — computed
    // from the fixture line rather than written out, so editing the fixture
    // moves both sides.
    const sourceLine = src.split("\n")[1];
    const patternText = sourceLine.slice(sourceLine.indexOf("/"), sourceLine.lastIndexOf("/") + 1);
    expect(masked.split("\n")[1]).toBe(
      sourceLine.replace(patternText, " ".repeat(patternText.length)),
    );
    expect(maskedHitLines(src, /Date\s*\.\s*now\s*\(/)).toEqual([4]);
  });

  it("reads a `/` after a closing paren as division, not a regex", () => {
    const src = "const q = size(a) / size(b);\nconst t = Date.now();\n";
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    expect(masked).toContain("size(a) / size(b)");
    expect(maskedHitLines(src, /Date\s*\.\s*now\s*\(/)).toEqual([2]);
  });

  it("still treats a division after an identifier as division, not a regex", () => {
    const src = "const q = a / b;\n";
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    expect(masked).toContain("a / b");
  });

  it("reads a `/` after `]`, a number and `++` as division", () => {
    const src = "const q = xs[0] / 2 / 3;\nlet n = 0;\nconst r = n++ / 4;\n";
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    expect(masked).toContain("xs[0] / 2 / 3");
    expect(masked).toContain("n++ / 4");
  });

  it("masks a character class holding an unescaped `/` without ending the literal there", () => {
    // `/[/]/` closes at its FOURTH character, not its second. Ending early
    // leaves the trailing `/` in operator position, which starts a second
    // regex scan that runs over whatever follows.
    const src = "const sep = /[/]+/g;\nconst t = Date.now();\n";
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    expect(masked).toContain("const sep = ");
    expect(masked).not.toContain("[/]");
    expect(maskedHitLines(src, /Date\s*\.\s*now\s*\(/)).toEqual([2]);
  });

  it("does not read `this`, `true` or `null` as keywords that open a regex", () => {
    // They have identifier shape but they are VALUES, so the slash after one
    // divides. Reading it as a regex would blank to the closing `/` — or, with
    // no second slash on the line, decline and leave the line visible.
    const src = "const a = this / 2;\nconst b = true / 2;\nconst c = null / 2;\n";
    const masked = maskNonCode(src);
    expect(masked).toContain("this / 2");
    expect(masked).toContain("true / 2");
    expect(masked).toContain("null / 2");
  });

  it("declines to mask when a would-be regex does not close on its own line", () => {
    // The bound that caps every misread at one line. `a } / 2` puts the slash
    // in operator position (`}` cannot be told from a block's brace without a
    // parser), and with no second `/` on the line the scan refuses rather than
    // blanking to the next slash anywhere in the file.
    const src = "const q = { a: 1 } / 2;\nconst t = Date.now();\n";
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    expect(masked).toContain("} / 2");
    expect(maskedHitLines(src, /Date\s*\.\s*now\s*\(/)).toEqual([2]);
  });

  it("keeps a regex inside a template interpolation from ending the interpolation early", () => {
    const src = 'const s = `${ v.replace(/\'/g, "") } done`;\nconst t = Date.now();\n';
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    expect(masked).not.toContain("done");
    expect(maskedHitLines(src, /Date\s*\.\s*now\s*\(/)).toEqual([2]);
  });

  it("keeps an object literal's braces inside an interpolation from ending it early", () => {
    // `${ {a: 1} }` and `${ xs.map(({ x }) => x) }`: the destructuring and
    // object braces open a level of their own, so the `}` that closes them is
    // not the one that closes the interpolation. Ending early leaves the rest
    // of the template scanned as CODE, which is the noisy direction, and can
    // end the literal at a backtick that closes something else.
    const src =
      'const s = `${ {a: 1} } ${ xs.map(({ x }) => `[${x}]`).join(", ") }`;\nDate.now();\n';
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    // The whole template — both interpolations included — is one blanked run
    // between the assignment and its semicolon. Ending an interpolation early
    // leaves part of it standing here as code.
    const sourceLine = src.split("\n")[0];
    const literal = sourceLine.slice(sourceLine.indexOf("`"), sourceLine.lastIndexOf("`") + 1);
    expect(masked.split("\n")[0]).toBe(sourceLine.replace(literal, " ".repeat(literal.length)));
    expect(maskedHitLines(src, /Date\s*\.\s*now\s*\(/)).toEqual([2]);
  });
});

describe("maskNonCode — positive control: the guard finds an injected read in EVERY production module", () => {
  it("Contract K's patterns are still spelled the way this suite copies them", () => {
    // The copy above is only worth having while it agrees with the guard it
    // stands in for. Reading the guard's own source is what keeps it honest.
    const guard = readFileSync(join(__dirname, "intent.test.mjs"), "utf-8");
    for (const { pattern } of FORBIDDEN) {
      expect(guard).toContain(pattern.source);
    }
  });

  it("names a read injected at the TOP of each module", () => {
    // The control's control: the parent failure was a mask that blanked
    // everything AFTER a trigger line, so a hit at line 1 was still found on
    // the broken masker. This half proves the harness itself detects, and the
    // half below proves the detection reaches the end of the file.
    const missed = [];
    for (const file of productionModules()) {
      const source = readFileSync(join(SRC, file), "utf-8");
      const baseline = hitLinesIn(source, maskNonCode(source));
      const injected = `${ALL_FORBIDDEN_LINE}\n${source}`;
      const found = hitLinesIn(injected, maskNonCode(injected));
      for (const { snippet, pattern } of FORBIDDEN) {
        const want = [1, ...baseline[pattern.source].map((line) => line + 1)];
        const got = found[pattern.source];
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          missed.push(
            `src/${file} [${snippet}]: hits ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
          );
        }
      }
    }
    expect(missed).toEqual([]);
  });

  it("names a read injected at the END of each module — the half the broken masker failed", () => {
    // Measured on the unfixed masker: injecting `Date.now()`, `Math.random()`,
    // `new Date()` and `localeCompare(` after `workspace.mjs:203` produced
    // ZERO hits, in a file the guard reported clean. The expectation is the
    // baseline hits (`governance/clock.mjs` carries one allow-listed
    // wall-clock read of its own) plus exactly one more, at the injected line.
    const missed = [];
    for (const file of productionModules()) {
      const raw = readFileSync(join(SRC, file), "utf-8");
      const source = raw.endsWith("\n") ? raw : `${raw}\n`;
      const injectedLine = source.split("\n").length;
      const baseline = hitLinesIn(source, maskNonCode(source));
      const injected = `${source}${ALL_FORBIDDEN_LINE}\n`;
      const found = hitLinesIn(injected, maskNonCode(injected));
      for (const { snippet, pattern } of FORBIDDEN) {
        const want = [...baseline[pattern.source], injectedLine];
        const got = found[pattern.source];
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          missed.push(
            `src/${file} [${snippet}]: hits ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
          );
        }
      }
    }
    expect(missed).toEqual([]);
  });
});

describe("maskNonCode — a keyword is only a keyword in keyword position", () => {
  it("reads every expression keyword as a PROPERTY after `.`, so the `/` after it divides", () => {
    // The measured defect, at the shape it was measured on:
    //   in  `const q = mod.default / 2 + Date.now() / 3;`
    //   out `const q = mod.default                    3;`
    // `default` after a `.` is a property name, but the classifier tested the
    // word against the keyword set without looking at what preceded it, put
    // the `/` in operator position, and masked the wall-clock read away as a
    // regex. Every keyword in that set is a legal property name, so this runs
    // the whole set rather than the three spellings that turned up.
    const blanked = [];
    for (const keyword of expressionKeywords()) {
      for (const access of [`mod.${keyword}`, `mod?.${keyword}`, `mod\n  .${keyword}`]) {
        const src = `const q = ${access} / 2 + Date.now() / 3;\n`;
        const masked = maskNonCode(src);
        if (masked !== src) blanked.push(`${JSON.stringify(access)} → ${JSON.stringify(masked)}`);
      }
    }
    expect(blanked).toEqual([]);
  });

  it("still opens a regex after the same keyword in KEYWORD position", () => {
    // The other direction, and the half that keeps the fix from being "stop
    // treating keywords as keywords": `return /re/` must still mask, or a
    // pattern spelling `Date.now()` starts tripping the guard it documents.
    const unmasked = [];
    for (const keyword of expressionKeywords()) {
      const src = `${keyword} /Date.now()/;\n`;
      const masked = maskNonCode(src);
      if (masked.includes("/Date.now()/") || !masked.startsWith(keyword)) {
        unmasked.push(`${keyword} → ${JSON.stringify(masked)}`);
      }
    }
    expect(unmasked).toEqual([]);
  });

  it("keeps the wall-clock read visible in the measured `mod.default` line", () => {
    const src = "const q = mod.default / 2 + Date.now() / 3;\n";
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    expect(masked).toBe(src);
    expect(maskedHitLines(src, /Date\s*\.\s*now\s*\(/)).toEqual([1]);
  });

  it("keeps `Array.of`, `obj.in` and `a?.default` from opening a regex", () => {
    // The three spellings the defect was reported at, kept as their own case
    // so the report and the suite name the same shapes.
    for (const src of [
      "const q = Array.of / 2 + Date.now() / 3;\n",
      "const q = obj.in / 2 + Date.now() / 3;\n",
      "const q = a?.default / 2 + Date.now() / 3;\n",
    ]) {
      const masked = maskNonCode(src);
      expect(masked).toBe(src);
      expect(maskedHitLines(src, /Date\s*\.\s*now\s*\(/)).toEqual([1]);
    }
  });

  it("reads a private name as one token, so `this.#default / 2` divides", () => {
    // A private name is `#` + any IdentifierName, keywords included, and the
    // `#` is not part of the `.` that precedes it.
    const src = "const q = this.#default / 2 + Date.now() / 3;\n";
    expect(maskNonCode(src)).toBe(src);
    expect(maskedHitLines(src, /Date\s*\.\s*now\s*\(/)).toEqual([1]);
  });
});

describe("maskNonCode — a `)` is classified by the `(` it closes", () => {
  it("masks a regex that opens the statement after a control structure's head", () => {
    // `if (x) /re/.test(y)` is a regex: no statement may begin with a
    // division. Reading the `)` as an operand left it unmasked, which is how a
    // backtick inside a pattern reached code position and opened the template
    // scan that blanked the rest of the file.
    for (const head of ["if (x)", "while (x)", "for (const x of xs)", "if (f(a))"]) {
      const src = `${head} /re/.test(y);\nconst t = Date.now();\n`;
      const masked = maskNonCode(src);
      expect(masked).toHaveLength(src.length);
      expect(masked.split("\n")[0]).toBe(`${head}     .test(y);`);
      expect(maskedHitLines(src, /Date\s*\.\s*now\s*\(/)).toEqual([2]);
    }
  });

  it("still divides after a call's `)`, including a call on a keyword-named method", () => {
    // The conservative half: only a paren opened directly after one of the six
    // control heads IN KEYWORD POSITION closes into statement position, so
    // `a.if(x)` — a property named `if` — still ends a value.
    for (const src of ["const q = size(a) / size(b);\n", "const q = a.if(x) / 2;\n"]) {
      expect(maskNonCode(src)).toBe(src);
    }
  });
});

describe("maskNonCode — a scan that cannot close declines instead of masking", () => {
  it("leaves an unterminated template literal entirely unmasked", () => {
    // A template legally spans newlines, so it has no bound short of end of
    // input — and the unfixed scan returned `src.length` there, which the
    // caller masked to. Everything after an unbalanced backtick was blanked,
    // and a blanked tail is byte-for-byte a clean tail. Declining is the same
    // answer `scanQuoted` and `scanRegex` already give at their newline.
    const src = "const t = `abc\nconst u = Date.now();\n";
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    expect(masked).toBe(src);
    expect(maskedHitLines(src, /Date\s*\.\s*now\s*\(/)).toEqual([2]);
  });

  it("keeps the statement after a regex holding a backtick visible — the measured EOF blank", () => {
    // Measured on the unfixed lexer:
    //   in  "if (x) /`/.test(y)\nconst t = Date.now();"
    //   out "if (x) /          \n                     "
    // Two independent fixes have to hold for this line: the `)` is a control
    // head's, so the regex is masked and the backtick never reaches code
    // position at all — and had it reached one, the template scan would now
    // decline rather than run to end of input.
    const src = "if (x) /`/.test(y)\nconst t = Date.now();\n";
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    expect(masked.split("\n")[0]).toBe("if (x)    .test(y)");
    expect(masked.split("\n")[1]).toBe("const t = Date.now();");
    expect(maskedHitLines(src, /Date\s*\.\s*now\s*\(/)).toEqual([2]);
  });

  it("propagates the refusal out of a nested unterminated template", () => {
    // The nested arm read `scanTemplate(...) + 1` as an index, so a `-1` from
    // an inner template that never closes would have become 0 and restarted
    // the scan from the top of the file. An inner template with no close means
    // there is no backtick left for the outer one either.
    const src = "const s = `${ ` }`;\nconst t = Date.now();\n";
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    expect(maskedHitLines(src, /Date\s*\.\s*now\s*\(/)).toEqual([2]);
  });

  it("still masks a template that legally spans newlines", () => {
    // The refusal above must not turn into "templates stop at the newline":
    // a template really does cross lines, and leaving its text unmasked would
    // report every `Date.now()` a code-generating template writes.
    const src = "const t = `a\nDate.now()\nb`;\nDate.now();\n";
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    expect(masked.split("\n")).toHaveLength(src.split("\n").length);
    expect(masked.split("\n")[1]).toBe(" ".repeat("Date.now()".length));
    expect(maskedHitLines(src, /Date\s*\.\s*now\s*\(/)).toEqual([4]);
  });

  it("leaves a block comment that never closes unmasked", () => {
    // The fourth scanner, and the same rule: a block comment legally spans
    // newlines, so end of input is its only bound and reaching it means this
    // was not a comment. Masking to end of input there is the same silent
    // blank as the template case.
    const src = "/* not closed\nconst t = Date.now();\n";
    const masked = maskNonCode(src);
    expect(masked).toHaveLength(src.length);
    expect(maskedHitLines(src, /Date\s*\.\s*now\s*\(/)).toEqual([2]);
  });
});

/**
 * Line shapes that are CODE at column 0 in a production module of this tree —
 * the independent oracle the differential below needs, since a mask has no
 * other way to be told that what it blanked was real.
 *
 * Deliberately syntactic and deliberately narrow: whatever else a line
 * starting `export ` at column 0 might be, in a Prettier-formatted ESM module
 * it is a statement, and a mask that blanks its leading keyword has lost sync.
 * The one shape that can fool it is source code embedded in a template literal
 * (`custom-rules/host.mjs`'s worker body), which the differential handles by
 * naming the construct that claims the line rather than by listing files.
 */
const STATEMENT_LINE = /^(?:export|import|function|class|const|let|async) /;

describe("maskNonCode — differential: the mask blanks nothing the source declares as code", () => {
  it("leaves every top-level statement line of every production module standing", () => {
    // The regression class both blockers belong to: a mask that blanks REAL
    // code reports nothing to every guard that scans it, and reporting nothing
    // is byte-for-byte a clean tree. Run against the masker this file replaced
    // — `git show HEAD:…/mask-non-code.mjs` — this goes red on 1362 of the
    // 1367 lines it checks; against the current one it is silent, which is the
    // only reason "found nothing" above is worth reading.
    const swallowed = [];
    const uncovered = [];
    for (const file of productionModules()) {
      const source = readFileSync(join(SRC, file), "utf-8");
      const masked = maskNonCode(source);
      const lines = source.split("\n");
      const maskedLines = masked.split("\n");
      let checked = 0;
      let lineStart = 0;
      for (let k = 0; k < lines.length; k++) {
        const start = lineStart;
        lineStart += lines[k].length + 1;
        if (!STATEMENT_LINE.test(lines[k])) continue;
        // Everything before a line's first quote, backtick or slash is code
        // whenever the line is code at all: nothing on that line has opened a
        // literal or a comment yet, so only a region opened EARLIER can blank
        // it — which is exactly the failure being looked for.
        const opens = lines[k].search(/['"`/]/);
        const prefix = opens === -1 ? lines[k] : lines[k].slice(0, opens);
        if (maskedLines[k]?.slice(0, prefix.length) === prefix) {
          checked++;
          continue;
        }
        // Blanked — so name the construct that claims it, by walking back to
        // the last character the mask left standing. A template literal
        // legally spans lines and this tree embeds source in some, so a line a
        // template claims is exempt. That exemption is also this test's limit,
        // stated rather than hidden: it cannot see a template that ran away,
        // because a runaway template claims its victims the same way a real one
        // does. The end-of-file injection control above is what covers that
        // direction — a template masking to end of input hides the read
        // injected after it.
        let end = start - 1;
        while (end >= 0 && (masked[end] === " " || masked[end] === "\n")) end--;
        if (
          source
            .slice(end + 1, start)
            .trimStart()
            .startsWith("`")
        )
          continue;
        swallowed.push(`src/${file}:${k + 1}: ${JSON.stringify(prefix.slice(0, 60))} blanked`);
      }
      if (checked === 0) uncovered.push(`src/${file}`);
    }
    expect(swallowed).toEqual([]);
    // A file contributing no checked line proves nothing about itself, and the
    // oracle above is the whole of this test's reach — so an empty answer is a
    // failure here rather than a pass.
    expect(uncovered).toEqual([]);
  });

  it("names a read injected into the MIDDLE of every production module", () => {
    // The top and end injections above bound the file; this one lands inside
    // it, where a masked region that opened early and closed late — the shape
    // a stray quote or backtick produces — swallows a statement without
    // touching either end. The injection point is a statement line the check
    // above already proved the mask leaves standing, so a legitimately masked
    // line is never asked to show an injected read.
    const missed = [];
    for (const file of productionModules()) {
      const raw = readFileSync(join(SRC, file), "utf-8");
      const source = raw.endsWith("\n") ? raw : `${raw}\n`;
      const lines = source.split("\n");
      const masked = maskNonCode(source).split("\n");
      const points = lines
        .map((line, k) => k)
        .filter(
          (k) => STATEMENT_LINE.test(lines[k]) && masked[k]?.startsWith(lines[k].slice(0, 6)),
        );
      if (points.length === 0) {
        missed.push(`src/${file}: no statement line to inject at`);
        continue;
      }
      const at = points[Math.floor(points.length / 2)];
      const injectedLine = at + 1;
      const baseline = hitLinesIn(source, maskNonCode(source));
      const injected = [...lines.slice(0, at), ALL_FORBIDDEN_LINE, ...lines.slice(at)].join("\n");
      const found = hitLinesIn(injected, maskNonCode(injected));
      for (const { snippet, pattern } of FORBIDDEN) {
        const want = [
          ...baseline[pattern.source].filter((line) => line < injectedLine),
          injectedLine,
          ...baseline[pattern.source]
            .filter((line) => line >= injectedLine)
            .map((line) => line + 1),
        ];
        const got = found[pattern.source];
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          missed.push(
            `src/${file}:${injectedLine} [${snippet}]: hits ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
          );
        }
      }
    }
    expect(missed).toEqual([]);
  });
});

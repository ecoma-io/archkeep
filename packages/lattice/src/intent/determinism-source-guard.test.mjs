/**
 * P1-08 regression, upgraded by R7 (E-F01): Contract K's
 * "no Date.now or Math.random in production" guard must be a RECURSIVE scan
 * over the shipped `src/` tree, and must catch every wall-clock spelling the
 * codebase forbids.
 *
 * The pre-R7 guard only ever looked inside the directories named in its own
 * `dirs` list (`["commands","rules","analysis","report","providers","lsp",
 * "governance"]`) with the two literal regexes /Date\.now\(\)/ and
 * /Math\.random\(\)/. That had two silent blind spots:
 *
 *  - **top-level modules never scanned**: `productionMjsFiles` took a `dir`
 *    and glued it onto `src/`, so `src/options.mjs`-style modules (10 of
 *    them) were structurally invisible to the scan, and a raw clock call
 *    landing in one read "clean" against the contract;
 *  - **alternative spellings passed**: the guard matched only the exact
 *    spellings `Date.now()` and `Math.random()`. `Date.now ( )` and
 *    `new Date().toISOString()` — the spelling a live `adr-registry.mjs`
 *    once used — both sailed through.
 *
 * This file proves the R7 shape two ways, deliberately kept separate:
 *
 *  - Behavioral, against an isolated fixture tree (never the real `src/`,
 *    whose current contents are someone else's fix to change): the guard's
 *    scan algorithm, reproduced here exactly, reports clean when handed the
 *    pre-R7 per-directory shape even though the fixture's TOP-LEVEL module
 *    has a live `Date.now()` — the "proven" illusion the finding names —
 *    and catches that same violation, plus a `new Date().toISOString()` in
 *    a subdirectory module, once scanned recursively.
 *  - Source-evidence, tying those fixtures to the real gate: the actual
 *    `intent.test.mjs` guard must be recursive (`productionMjsFiles()` takes
 *    no directory), must match the empty-paren `new Date()` shape, and its
 *    allow-list must name exactly the injectable clock seam.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Reproduces Contract K's source-guard scan exactly, in its R7 shape: every
 * production (non-`.test.mjs`, non-`.integ.mjs`) `.mjs` file under
 * `root/src`, walked recursively with no directory list, comments/strings/
 * regex-literals masked index-preservingly, and each forbidden wall-clock
 * pattern matched with a line-number allow-list.
 *
 * @param {string} root Fixture root (a directory containing `src/`).
 * @returns {string[]} One entry per offending site, as `"<path-from-src>:<line>"`.
 */
function scanForRawClock(root) {
  const violations = [];
  const srcRoot = join(root, "src");
  const files = readdirSync(srcRoot, { recursive: true }).filter(
    (f) =>
      typeof f === "string" &&
      f.endsWith(".mjs") &&
      !f.endsWith(".test.mjs") &&
      !f.endsWith(".integ.mjs"),
  );
  for (const file of files) {
    const content = readFileSync(join(srcRoot, String(file)), "utf-8");
    const code = maskNonCode(content);
    for (const pattern of WALL_CLOCK_PATTERNS) {
      for (const match of code.matchAll(RegExp(pattern.source, "g"))) {
        const line = content.slice(0, match.index).split("\n").length;
        const allow = WALL_CLOCK_ALLOWLIST.get(String(file)) ?? [];
        if (allow.includes(line)) continue;
        violations.push(`${String(file)}:${line}`);
      }
    }
  }
  return violations.sort();
}

/** The three forbidden wall-clock shapes, identical to `intent.test.mjs`. */
const WALL_CLOCK_PATTERNS = [
  /Date\s*\.\s*now\s*\(/,
  /Math\s*\.\s*random\s*\(/,
  /new\s+Date\s*\(\s*\)/,
];

/** The one deliberate site, identical to `intent.test.mjs`. */
const WALL_CLOCK_ALLOWLIST = new Map([["governance/clock.mjs", [27]]]);

/**
 * Minimal index-preserving masker matching `maskNonCode` in
 * `intent.test.mjs`: comments/strings/regex-literals become spaces so a
 * `matchAll` index names the byte offset in the original file.
 */
function maskNonCode(src) {
  let result = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      result += " ".repeat((end === -1 ? src.length : end) - i);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const to = end === -1 ? src.length : end + 2;
      result += " ".repeat(to - i);
      i = to;
      continue;
    }
    if (src[i] === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== "'") {
        if (src[j] === "\\") j++;
        j++;
      }
      result += " ".repeat(Math.min(j + 1, src.length) - i);
      i = j + 1;
      continue;
    }
    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") j++;
        j++;
      }
      result += " ".repeat(Math.min(j + 1, src.length) - i);
      i = j + 1;
      continue;
    }
    if (src[i] === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < src.length) {
        if (src[j] === "\\") {
          j++;
          j++;
          continue;
        }
        if (src[j] === "$" && src[j + 1] === "{") depth++;
        else if (src[j] === "}") depth--;
        else if (src[j] === "`" && depth === 0) break;
        j++;
      }
      result += " ".repeat(Math.min(j + 1, src.length) - i);
      i = j + 1;
      continue;
    }
    if (src[i] === "/" && i > 0 && /[=([{}!|&?:;,~^<>+\-*/%\n]/.test(src[i - 1])) {
      let j = i + 1;
      while (j < src.length && src[j] !== "/") {
        if (src[j] === "\\") {
          j++;
          j++;
          continue;
        }
        if (src[j] === "[") {
          j++;
          while (j < src.length && src[j] !== "]") {
            if (src[j] === "\\") j++;
            j++;
          }
        }
        j++;
      }
      let end = j + 1;
      while (end < src.length && /[gimsuy]/.test(src[end])) end++;
      result += " ".repeat(end - i);
      i = end;
      continue;
    }
    result += src[i];
    i++;
  }
  return result;
}

describe("Determinism source guard — recursive scan (R7 / E-F01 regression)", () => {
  const root = mkdtempSync(join(tmpdir(), "lattice-determinism-guard-r7-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // A fixture that carries the two violations the old guard could not see:
  // a raw `Date.now()` in a TOP-LEVEL module (invisible to the per-directory
  // walk), and a `new Date().toISOString()` in a sub-directory module (the
  // alternative spelling the two-literal regex matched nothing of).
  mkdirSync(join(root, "src", "governance"), { recursive: true });
  writeFileSync(
    join(root, "src", "direct.mjs"),
    "export function stamp() { return Date.now(); }\n",
  );
  writeFileSync(
    join(root, "src", "governance", "stamp-user.mjs"),
    "export function stamp() { return new Date().toISOString(); }\n",
  );
  // The deliberate seam the guard must exempt, at the same line the real
  // clock.mjs uses.
  writeFileSync(
    join(root, "src", "governance", "clock.mjs"),
    "/** clock */\n".repeat(26) +
      "export function referenceTime() {\n  return new Date().toISOString();\n}\n",
  );
  // A pure-argument `new Date(x)` must NOT trip — the pattern is the
  // empty-paren, wall-clock shape.
  writeFileSync(
    join(root, "src", "governance", "sample.mjs"),
    "export function sample(t) { return new Date(t).toISOString(); }\n",
  );

  it("the recursive scan catches the top-level Date.now() — the site the pre-R7 dir-walk could not reach", () => {
    expect(scanForRawClock(root)).toContain("direct.mjs:1");
  });

  it("the recursive scan catches the new Date().toISOString() in a sub-directory module — the alternative spelling the two-literal regex missed", () => {
    expect(scanForRawClock(root)).toContain("governance/stamp-user.mjs:1");
  });

  it("the recursive scan exempts the exact allow-listed clock seam", () => {
    expect(scanForRawClock(root)).not.toContain("governance/clock.mjs:27");
  });

  it("the recursive scan does not flag a pure-argument new Date(x)", () => {
    expect(scanForRawClock(root)).not.toContain("governance/sample.mjs");
  });

  it("the REAL gate in intent.test.mjs is recursive: productionMjsFiles() takes no directory", () => {
    const content = readFileSync(join(__dirname, "intent.test.mjs"), "utf-8");
    expect(content).toMatch(/function productionMjsFiles\(\)/);
    expect(content).toMatch(/readdirSync\(dirPath, \{ recursive: true \}\)/);
    // The old per-directory list is gone — a new module cannot escape the
    // scan by sitting in a directory nobody curated.
    expect(content).not.toMatch(/const dirs = \["commands"/);
  });

  it("the REAL gate matches the empty-paren new Date() shape AND its allow-list names only the injectable clock seam", () => {
    const content = readFileSync(join(__dirname, "intent.test.mjs"), "utf-8");
    expect(content).toContain("/new\\s+Date\\s*\\(\\s*\\)/");
    expect(content).toMatch(/WALL_CLOCK_ALLOWLIST = new Map\(\[\["governance\/clock\.mjs"/);
  });

  it("the REAL allow-listed line still IS the wall-clock read it exempts", () => {
    // The allow-list pins `clock.mjs:27`. If an edit above that line moves the
    // raw `new Date()` away, the exemption silently drifts to a line that is
    // not a wall-clock read — which would leave the seam unguarded. This
    // assertion ties the allow-listed line to the actual source: it must
    // contain the argumentless `new Date()` it exempts.
    const clock = readFileSync(join(__dirname, "..", "governance", "clock.mjs"), "utf-8").split(
      "\n",
    );
    expect(clock[26]).toMatch(/new\s+Date\s*\(\s*\)/);
  });
});

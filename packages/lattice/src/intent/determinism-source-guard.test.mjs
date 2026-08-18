/**
 * P1-08 regression: Contract K's "no Date.now or Math.random in production
 * source files" guard (`intent.test.mjs`) only ever looks inside the
 * directories named in its own `dirs` list. Before this fix that list was
 * `["commands", "rules", "analysis", "report", "providers", "lsp"]` —
 * `governance/` was not among them, even though it is exactly where a raw,
 * uninjected clock call would defeat the contract: `governance/clock.mjs` is
 * the shared reference-time clock every governance capability that emits a
 * timestamp or an age (waivers, debt, health) is supposed to go through
 * (that file's own header states the rule), so a call site that reaches for
 * `Date.now()` directly instead is precisely the counterexample this guard
 * exists to catch — and, scoped to six directories, could not.
 *
 * This is proved two ways, deliberately kept separate:
 *
 *  - Behavioral, against an isolated fixture tree (never the real
 *    `src/governance/`, whose current contents are someone else's fix to
 *    change): the guard's own scan algorithm, reproduced here exactly,
 *    reports a clean result when handed the pre-fix six-directory list even
 *    though the fixture's `governance/` has a live violation — the "proven"
 *    illusion the finding names — and catches the same violation once
 *    `governance` is included.
 *  - Source-evidence, tying that illusion to the real gate: the actual
 *    `dirs` array inside `intent.test.mjs` is parsed from its source and
 *    must contain `"governance"`. This is the assertion that goes red before
 *    the fix and green after.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Reproduces Contract K's source-guard scan exactly: every production
 * (non-`.test.mjs`) `.mjs` file under `root/src/<dir>`, for each `dir` in
 * `dirs`, tested for a raw `Date.now()`/`Math.random()` call. A directory
 * that does not exist under the fixture is skipped, the same tolerance
 * `productionMjsFiles` in `intent.test.mjs` gives a real workspace that has
 * no files under one of the scanned directories.
 *
 * @param {string} root Fixture root (a directory containing `src/`).
 * @param {string[]} dirs Directory names to scan, relative to `root/src`.
 * @returns {string[]} One entry per offending file, as `"<dir>/<file>"`.
 */
function scanForRawClock(root, dirs) {
  const violations = [];
  for (const dir of dirs) {
    const dirPath = join(root, "src", dir);
    let files;
    try {
      files = readdirSync(dirPath, { recursive: true }).filter(
        (f) => typeof f === "string" && f.endsWith(".mjs") && !f.endsWith(".test.mjs"),
      );
    } catch {
      continue;
    }
    for (const file of files) {
      const content = readFileSync(join(dirPath, String(file)), "utf-8");
      if (/Date\.now\(\)/.test(content) || /Math\.random\(\)/.test(content)) {
        violations.push(`${dir}/${String(file)}`);
      }
    }
  }
  return violations;
}

describe("Determinism source guard — governance/ blind spot (P1-08 regression)", () => {
  const root = mkdtempSync(join(tmpdir(), "lattice-determinism-guard-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, "src", "commands"), { recursive: true });
  mkdirSync(join(root, "src", "governance"), { recursive: true });
  writeFileSync(
    join(root, "src", "commands", "clean.mjs"),
    "export function clean() { return 1; }\n",
  );
  // The planted violation: a raw, uninjected wall-clock read — the exact
  // shape `governance/clock.mjs`'s injectable `referenceTime()` exists to
  // replace (see that file's header) — sitting where the pre-fix guard
  // never looked.
  writeFileSync(
    join(root, "src", "governance", "clock-user.mjs"),
    "export function stamp() { return Date.now(); }\n",
  );

  it("misses a live governance/ violation when governance is absent from the scanned directories — the pre-fix shape", () => {
    const violations = scanForRawClock(root, ["commands"]);
    // Silent direction: the fixture's governance/ directory has a real
    // Date.now() call, and the scan reports a clean result anyway — the
    // exact shape that let Contract K read "proven" regardless of what
    // governance/ actually contained.
    expect(violations).toEqual([]);
  });

  it("catches the same governance/ violation once governance is included in the scanned directories", () => {
    const violations = scanForRawClock(root, ["commands", "governance"]);
    expect(violations).toEqual(["governance/clock-user.mjs"]);
  });

  it("the real source guard's directory list includes governance (ties the fixture proof to the actual gate)", () => {
    const content = readFileSync(join(__dirname, "intent.test.mjs"), "utf-8");
    const anchorIndex = content.indexOf(
      'it("no Date.now or Math.random in production source files"',
    );
    expect(anchorIndex, "Contract K's source-guard test moved or was renamed").toBeGreaterThan(-1);
    const match = content.slice(anchorIndex).match(/const dirs = (\[[^\]]*\]);/);
    expect(match, "could not find the source guard's `dirs` array").not.toBeNull();
    const dirs = JSON.parse(/** @type {RegExpMatchArray} */ (match)[1].replace(/'/g, '"'));
    expect(dirs).toContain("governance");
  });
});

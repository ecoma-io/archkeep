/**
 * The verdict layer's structural contract, as source scans instead of
 * assumptions — the two facts issue #650 turned into code:
 *
 * 1. **The status→exit-code contract is written once.** `EXIT` (`../verdict.mjs`)
 *    is the one place the numbers live, `EXIT_FOR_STATUS` the one status-keyed
 *    view of it, derived so the two spellings cannot drift. Before the fold,
 *    `src/report/json.mjs` held a second, privately-kept table
 *    (`EXIT_CODE_FOR_STATUS`) encoding the same mapping in literal numbers —
 *    a second copy that agreed with the first only until someone edited one
 *    of them, which is exactly the drift a single source of truth exists to
 *    refuse. The scan below fails on ANY object literal keyed by the three
 *    envelope statuses whose values are numeric literals, under any name,
 *    anywhere in the shipped surface — the derived table survives because its
 *    values are `EXIT` members, not literals.
 *
 * 2. **The verdict core does not import the presentation layer.** `buildDecision`
 *    lived in `src/report/evidence.mjs`, so `src/verdict.mjs` — the module
 *    that words every format's verdict — imported `report/` to reach it. The
 *    builder now lives in `../governance/verdict.mjs` beside the vocabulary
 *    it enforces, and the scan below fails if a verdict module imports
 *    `report/` again. Citations in comments and JSDoc do not count: they are
 *    prose about a module, not an edge to it, which is why every match is
 *    validated against `../intent/mask-non-code.mjs`'s position-preserving
 *    mask — the same guard `module-graph.test.mjs` argues for its own scan.
 *
 * Both guards prove their own teeth before they prove the tree: each runs its
 * detector over synthetic input with a known answer first, so a detector that
 * silently stopped detecting — the guard's own silent direction — cannot sit
 * green under a clean tree.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { maskNonCode } from "../intent/mask-non-code.mjs";
import { EXIT, EXIT_FOR_STATUS } from "../verdict.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The three statuses an envelope can hold — the keys a second table would spell. */
const STATUS_KEYS = ["ok", "findings", "no-verdict"];

/**
 * One `key: value` property, keys quoted or bare, value captured in group 4.
 *
 * @type {RegExp}
 */
const PROPERTY = /^\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$]*))\s*:\s*(.*?)\s*$/;

/** Any integer literal — the shape a second hand-kept table spells its codes in. */
const NUMERIC_LITERAL = /^-?\d+$/;

/**
 * Whether `keys` hold exactly the three envelope statuses, order-free.
 *
 * @param {string[]} keys
 * @returns {boolean}
 */
const isStatusKeySet = (keys) =>
  keys.length === STATUS_KEYS.length && STATUS_KEYS.every((key) => keys.includes(key));

/**
 * The object literals of one module's source whose keys are exactly the three
 * envelope statuses and whose values are all numeric literals — the shape of
 * an independently-kept status→exit-code table. Comments, strings and
 * template literals are excluded through the same mask discipline
 * `module-graph.test.mjs` documents; a table spelled across lines or with
 * quoted keys is still found, because neither spelling hides the mapping.
 *
 * @param {string} raw Module source text.
 * @returns {string[]} The matched literal texts, in source order.
 */
export function numericStatusExitCodeTables(raw) {
  const masked = maskNonCode(raw);
  const tables = [];
  for (const match of raw.matchAll(/\{[^{}]*\}/g)) {
    // Inside a masked region the character is a space — a table spelled in
    // prose is a citation, not a second copy of the contract.
    if (masked[match.index] !== raw[match.index]) continue;
    const properties = match[0]
      .slice(1, -1)
      .split(",")
      .filter((part) => part.trim() !== "");
    const keys = [];
    const values = [];
    let shaped = properties.length > 0;
    for (const property of properties) {
      const parsed = property.match(PROPERTY);
      if (parsed === null) {
        shaped = false;
        break;
      }
      keys.push(parsed[1] ?? parsed[2] ?? parsed[3]);
      values.push(parsed[4]);
    }
    if (!shaped || !isStatusKeySet(keys)) continue;
    if (!values.every((value) => NUMERIC_LITERAL.test(value))) continue;
    tables.push(match[0]);
  }
  return tables;
}

/**
 * The `report/…` specifiers one module statically imports — the presentation
 * edge a verdict module must never own. Only real import statements count;
 * the same mask discipline keeps a JSDoc citation of `report/evidence.mjs`
 * from reading as an edge.
 *
 * @param {string} raw Module source text.
 * @returns {string[]}
 */
export function reportImports(raw) {
  const masked = maskNonCode(raw);
  const found = [];
  for (const match of raw.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
    if (masked[match.index] !== raw[match.index]) continue;
    const specifier = match[1];
    if (/(^|\/)report\//.test(specifier)) found.push(specifier);
  }
  return found;
}

/** @returns {string[]} Every non-test `.mjs` under `src/`, package-root-relative. */
function srcModules() {
  return readdirSync(join(PACKAGE_ROOT, "src"), { recursive: true })
    .map((entry) => `src/${String(entry).replaceAll("\\", "/")}`)
    .filter((key) => key.endsWith(".mjs") && !key.endsWith(".test.mjs"));
}

describe("the exit-code table scan — the detector", () => {
  it("finds the second table exactly as json.mjs used to keep it", () => {
    const raw = [
      'import { createRequire } from "node:module";',
      "",
      "/** The one `status`↔`exitCode` mapping. */",
      'const EXIT_CODE_FOR_STATUS = Object.freeze({ ok: 0, findings: 1, "no-verdict": 3 });',
      "",
      "export const done = 1;",
    ].join("\n");
    expect(numericStatusExitCodeTables(raw)).toHaveLength(1);
  });

  it("finds a table spelled across lines and under any name", () => {
    const raw = [
      "const statusLadder = {",
      "  ok: 0,",
      '  "findings": 1,',
      "  'no-verdict': 3,",
      "};",
    ].join("\n");
    expect(numericStatusExitCodeTables(raw)).toHaveLength(1);
  });

  it("ignores the verdict vocabulary — string values are not exit codes", () => {
    const raw = 'export const VERDICT_FOR_STATUS = { ok: "pass", findings: "fail" };';
    expect(numericStatusExitCodeTables(raw)).toHaveLength(0);
  });

  it("ignores a partial table — all three statuses or it is not the contract", () => {
    const raw = "export const httpish = { ok: 200, findings: 500 };";
    expect(numericStatusExitCodeTables(raw)).toHaveLength(0);
  });

  it("ignores the derived table — EXIT members are the one spelling, not literals", () => {
    const raw = [
      "export const EXIT = Object.freeze({ ok: 0, violations: 1, usage: 2, error: 3 });",
      "",
      "export const EXIT_FOR_STATUS = Object.freeze({",
      "  ok: EXIT.ok,",
      "  findings: EXIT.violations,",
      '  "no-verdict": EXIT.error,',
      "});",
    ].join("\n");
    expect(numericStatusExitCodeTables(raw)).toHaveLength(0);
  });

  it("ignores a table spelled inside a comment or a string", () => {
    const raw = [
      '// const documented = { ok: 0, findings: 1, "no-verdict": 3 };',
      "const quoted = `export const t = { ok: 0, findings: 1, 'no-verdict': 3 };`;",
      "export const done = 1;",
    ].join("\n");
    expect(numericStatusExitCodeTables(raw)).toHaveLength(0);
  });
});

describe("the import-direction scan — the detector", () => {
  it("reads the presentation edge the verdict core used to own", () => {
    const raw = [
      'import { buildDecision } from "./report/evidence.mjs";',
      'import { EXIT } from "./verdict.mjs";',
      "export const done = 1;",
    ].join("\n");
    expect(reportImports(raw)).toEqual(["./report/evidence.mjs"]);
  });

  it("does not count a citation in prose — a comment is not an edge", () => {
    const raw = [
      "// `../report/evidence.mjs` re-exports the builder.",
      "/**",
      " * @see The builder lives in `../report/evidence.mjs`.",
      " */",
      'import { buildDecision } from "../governance/verdict.mjs";',
      "export const done = 1;",
    ].join("\n");
    expect(reportImports(raw)).toEqual([]);
  });
});

describe("the verdict layer, as shipped", () => {
  it("keeps exactly one status→exit-code table — the derived one, in src/verdict.mjs", () => {
    const offenders = [];
    for (const key of srcModules()) {
      const raw = readFileSync(join(PACKAGE_ROOT, key), "utf8");
      for (const table of numericStatusExitCodeTables(raw)) {
        offenders.push(`${key}: ${table.replaceAll("\n", " ")}`);
      }
    }
    // A second table under a new name would pass every behavior test that
    // reads only the first one — the scan is what goes red instead.
    expect(offenders).toEqual([]);
  });

  it("derives EXIT_FOR_STATUS from EXIT, and never maps a status to the usage code", () => {
    expect(EXIT_FOR_STATUS).toEqual({
      ok: EXIT.ok,
      findings: EXIT.violations,
      "no-verdict": EXIT.error,
    });
    // `usage` is the shell's answer to a malformed invocation; no envelope
    // carries a status for it, so no status may map to it either.
    expect(Object.values(EXIT_FOR_STATUS)).not.toContain(EXIT.usage);
  });

  it("imports no report/ module from either verdict module", () => {
    for (const key of ["src/verdict.mjs", "src/governance/verdict.mjs"]) {
      const raw = readFileSync(join(PACKAGE_ROOT, key), "utf8");
      expect(reportImports(raw), `${key} imports report/`).toEqual([]);
    }
  });
});

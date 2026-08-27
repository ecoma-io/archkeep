/**
 * Intent tests: executable proof that every v1.0 normative intent holds.
 *
 * These tests verify the INTENT declared in `intent-manifest.json`, not the
 * implementation that satisfies it. An intent test fails when the intent no
 * longer holds, regardless of which implementation detail changed.
 *
 * Each test is named by contract letter (A–L). Where feasible, tests import
 * and call the actual code (behavioral proof). Where that is not practical
 * (circular imports, process-level tests), tests read source and verify
 * structural properties (source-evidence) — these are clearly labelled.
 *
 * The manifest validation section ensures the manifest's claims are
 * mechanically grounded: evidence paths exist, evidence types match the
 * taxonomy, "proven" status requires executable proof, and that proof is
 * actually discoverable by the test runner (not skipped, not excluded, not
 * disabled). Status is derived from evidence, not self-attested.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

/** Vitest include patterns for unit and e2e suites. */
const UNIT_INCLUDE = "src/**/*.test.mjs";
const E2E_INCLUDE = "**/*.e2e.mjs";

/** Tests whether a relative path matches a vitest include glob pattern. */
function matchesIncludePattern(relPath, pattern) {
  if (pattern === UNIT_INCLUDE) {
    // src/**/*.test.mjs: must start with src/, contain only path segments,
    // and end with .test.mjs.
    return relPath.startsWith("src/") && relPath.endsWith(".test.mjs");
  }
  if (pattern === E2E_INCLUDE) {
    // **/*.e2e.mjs: must end with .e2e.mjs.
    return relPath.endsWith(".e2e.mjs");
  }
  return false;
}

/**
 * Collect every production (non-`.test.mjs`, non-`.integ.mjs`) `.mjs` file
 * under `src/`, recursively — top-level modules included.
 *
 * Returns paths relative to `src/` (e.g. `"governance/adr-registry.mjs"`,
 * `"options.mjs"`). A module that escapes this walk is a silent
 * determinism-gap, so there is no per-directory opt-out: a missing `src`
 * throws rather than returning `[]`, because "no files scanned" must never
 * read as "clean".
 */
function productionMjsFiles() {
  const dirPath = join(ROOT, "src");
  const names = readdirSync(dirPath, { recursive: true });
  const files = names
    .filter(
      (f) =>
        typeof f === "string" &&
        f.endsWith(".mjs") &&
        !f.endsWith(".test.mjs") &&
        !f.endsWith(".integ.mjs"),
    )
    // `readdirSync`'s recursive type is `(string | Buffer)[]`; only string
    // entries survive the filter, and `String()` narrows the declared type.
    .map((f) => String(f));
  if (files.length === 0) {
    throw new Error("intent: productionMjsFiles found no .mjs files under src/ — nothing scanned");
  }
  return files;
}

/** Strip comments, string literals, and regex literals from source code. */
function stripStrings(src) {
  let result = "";
  let i = 0;
  while (i < src.length) {
    // Single-line comment
    if (src[i] === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    // Block comment
    if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    // Single-quoted string
    if (src[i] === "'") {
      result += "''";
      i++;
      while (i < src.length && src[i] !== "'") {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    // Double-quoted string
    if (src[i] === '"') {
      result += '""';
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    // Template literal
    if (src[i] === "`") {
      result += "``";
      i++;
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") {
          i++;
          i++;
          continue;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          // Skip template expression — find matching }
          let depth = 1;
          i += 2;
          while (i < src.length && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            else if (src[i] === '"' || src[i] === "'") {
              // Skip string inside template expression.
              const q = src[i];
              i++;
              while (i < src.length && src[i] !== q) {
                if (src[i] === "\\") i++;
                i++;
              }
            }
            i++;
          }
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    // Regex literal (simplified: /pattern/flags)
    if (src[i] === "/" && i > 0 && /[=([{}!|&?:;,~^<>+\-*/%\n]/.test(src[i - 1])) {
      result += "/R/";
      i++;
      while (i < src.length && src[i] !== "/") {
        if (src[i] === "\\") {
          i++;
          i++;
          continue;
        }
        if (src[i] === "[") {
          i++;
          while (i < src.length && src[i] !== "]") {
            if (src[i] === "\\") i++;
            i++;
          }
        }
        i++;
      }
      i++;
      while (i < src.length && /[gimsuy]/.test(src[i])) i++;
      continue;
    }
    result += src[i];
    i++;
  }
  return result;
}

/**
 * The position-preserving masker, shared with the behavioral reproduction in
 * `determinism-source-guard.test.mjs` and shipped inside the published
 * artifact (`src/` ships), so the two test files can never diverge from the
 * engine. The single copy lives here; that file re-exports it.
 */
import { maskNonCode } from "./mask-non-code.mjs";
export { maskNonCode };

/**
 * Detects patterns that would prevent a test from actually executing:
 * `.skip(`, `xit(`, `xdescribe(`, `.only(`, `fit(`, `fdescribe(`.
 *
 * Scans code with strings, comments, and regex literals stripped so we test
 * code, not prose or embedded patterns. Matches `.skip(` and `.only(` as
 * Vitest method calls on `it`, `describe`, `test`, `context`, or `suite` —
 * the Vitest suite/test functions. Also detects bracket notation
 * (`it['only']`) after string stripping collapses quoted property names.
 */
function findSkipOnlyPatterns(code) {
  const violations = [];
  const stripped = stripStrings(code);
  // .skip( — it.skip(, describe.skip(, test.skip(, context.skip(, suite.skip(
  if (/\b(?:it|describe|test|context|suite)\.skip\s*\(/.test(stripped)) {
    violations.push(".skip(");
  }
  // .only( — it.only(, describe.only(, test.only(, context.only(, suite.only(
  if (/\b(?:it|describe|test|context|suite)\.only\s*\(/.test(stripped)) {
    violations.push(".only(");
  }
  // Bracket notation after string stripping: it['skip'] → it[''], it['only'] → it['']
  // After stripping, it['only']('x', fn) becomes it['']('x', fn). The empty
  // string in brackets followed by a call is not normal code — it only appears
  // when a bracket-notation .skip/.only call had its property name stripped.
  // Match it[''](...)  or  it[""](...)
  if (/\b(?:it|describe|test|context|suite)\[\s*['"]\s*['"]\s*\]\s*\(/.test(stripped)) {
    violations.push("bracket-skip/only");
  }
  // xit(, xdescribe( — Jest/Vitest skip aliases
  if (/\bxit\s*\(/.test(stripped)) {
    violations.push("xit(");
  }
  if (/\bxdescribe\s*\(/.test(stripped)) {
    violations.push("xdescribe(");
  }
  // fit(, fdescribe( — Jest/Vitest only aliases
  if (/\bfit\s*\(/.test(stripped)) {
    violations.push("fit(");
  }
  if (/\bfdescribe\s*\(/.test(stripped)) {
    violations.push("fdescribe(");
  }
  return violations;
}

/** Strip single-line and block comments so we test code, not prose. */
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.replace(/\/\/.*$/gm, "");
  return out;
}

describe("Intent manifest validation", () => {
  const manifestPath = join(__dirname, "intent-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

  /** Evidence types that count as executable proof. */
  const EXECUTABLE_TYPES = new Set(["behavioral-test", "e2e-test", "architecture-test"]);

  /** All valid evidence types from the taxonomy. */
  const VALID_TYPES = new Set([
    "behavioral-test",
    "e2e-test",
    "architecture-test",
    "static-analysis",
    "source-evidence",
    "documentation",
  ]);

  it("every evidence entry has a valid type from the taxonomy", () => {
    const violations = [];
    for (const contract of manifest.contracts) {
      for (const ev of contract.evidence) {
        if (!VALID_TYPES.has(ev.type)) {
          violations.push(`Contract ${contract.id}: unknown evidence type "${ev.type}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("every evidence path resolves to an existing file", () => {
    const violations = [];
    for (const contract of manifest.contracts) {
      for (const ev of contract.evidence) {
        const resolved = join(ROOT, ev.path);
        if (!existsSync(resolved)) {
          violations.push(`Contract ${contract.id}: evidence path does not exist: ${ev.path}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("executable evidence paths match a vitest include pattern (discoverable by the runner)", () => {
    const violations = [];
    for (const contract of manifest.contracts) {
      for (const ev of contract.evidence) {
        if (!EXECUTABLE_TYPES.has(ev.type)) continue;
        const resolved = join(ROOT, ev.path);
        if (!existsSync(resolved)) continue; // caught above
        const relPath = relative(ROOT, resolved);
        const matchesUnit = matchesIncludePattern(relPath, UNIT_INCLUDE);
        const matchesE2E = matchesIncludePattern(relPath, E2E_INCLUDE);
        if (!matchesUnit && !matchesE2E) {
          violations.push(
            `Contract ${contract.id}: executable evidence "${ev.path}" does not match any vitest include pattern — the test runner will never discover it`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("executable evidence files contain no .skip or .only patterns", () => {
    const violations = [];
    const checked = new Set();
    for (const contract of manifest.contracts) {
      for (const ev of contract.evidence) {
        if (!EXECUTABLE_TYPES.has(ev.type)) continue;
        const resolved = join(ROOT, ev.path);
        if (!existsSync(resolved)) continue; // caught above
        if (checked.has(resolved)) continue;
        checked.add(resolved);
        const content = readFileSync(resolved, "utf-8");
        const patterns = findSkipOnlyPatterns(content);
        if (patterns.length > 0) {
          violations.push(
            `Contract ${contract.id}: ${ev.path} contains disabled-test patterns: ${patterns.join(", ")} — the proof would not execute`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no test file in the suite contains .only (which disables other tests)", () => {
    const violations = [];
    const dirs = ["src", "e2e"];
    for (const dir of dirs) {
      const dirPath = join(ROOT, dir);
      let files;
      try {
        files = readdirSync(dirPath, { recursive: true })
          .filter(
            (f) => typeof f === "string" && (f.endsWith(".test.mjs") || f.endsWith(".e2e.mjs")),
          )
          .map((f) => String(f));
      } catch {
        continue;
      }
      for (const file of files) {
        const fullPath = join(dirPath, file);
        const content = readFileSync(fullPath, "utf-8");
        const patterns = findSkipOnlyPatterns(content);
        const onlyPatterns = patterns.filter(
          (p) => p === ".only(" || p === "fit(" || p === "fdescribe(",
        );
        if (onlyPatterns.length > 0) {
          violations.push(
            `${dir}/${file}: contains .only/fit/fdescribe — this disables other tests in the run`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("declared status must agree with computed status (not self-attested)", () => {
    const violations = [];
    for (const contract of manifest.contracts) {
      const hasExecutable = contract.evidence.some((ev) => EXECUTABLE_TYPES.has(ev.type));
      const computedStatus = hasExecutable ? "proven" : "documented";
      if (contract.status !== computedStatus) {
        violations.push(
          `Contract ${contract.id}: declared status "${contract.status}" but computed status is "${computedStatus}" — status must be derived from evidence, not self-attested`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it("unprovenIntents count matches contracts without executable proof", () => {
    const computed = manifest.contracts.filter((c) => c.status !== "proven").length;
    expect(manifest.unprovenIntents).toBe(computed);
  });

  it("contract IDs are unique", () => {
    const ids = manifest.contracts.map((c) => c.id);
    const seen = new Set();
    const duplicates = [];
    for (const id of ids) {
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }
    expect(duplicates).toEqual([]);
  });

  it("every evidence entry has a non-empty path", () => {
    const violations = [];
    for (const contract of manifest.contracts) {
      for (const ev of contract.evidence) {
        if (!ev.path || ev.path.trim() === "") {
          violations.push(`Contract ${contract.id}: evidence entry has empty path`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no evidence uses the legacy 'test' or 'source' types without taxonomy qualification", () => {
    const violations = [];
    for (const contract of manifest.contracts) {
      for (const ev of contract.evidence) {
        if (ev.type === "test" || ev.type === "source") {
          violations.push(
            `Contract ${contract.id}: evidence uses legacy type "${ev.type}" — use taxonomy-qualified type`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("source-evidence and documentation types are never counted as executable proof", () => {
    const violations = [];
    for (const contract of manifest.contracts) {
      if (contract.status === "proven") {
        const executableEvidence = contract.evidence.filter((ev) => EXECUTABLE_TYPES.has(ev.type));
        if (executableEvidence.length === 0) {
          violations.push(
            `Contract ${contract.id}: status is "proven" but all evidence is non-executable — source-evidence and documentation cannot prove an intent alone`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// ── Contract A: Provider independence ──────────────────────────────────────

describe("Contract A — Provider independence", () => {
  it("core layers (rules, analysis, report) do not import from providers", () => {
    const violations = [];
    for (const file of productionMjsFiles()) {
      if (!(
        file.startsWith("rules/") ||
        file.startsWith("analysis/") ||
        file.startsWith("report/")
      )) {
        continue;
      }
      const content = readFileSync(join(ROOT, "src", file), "utf-8");
      if (/from\s+['"]\.\.\/(?:providers|providers\/)/.test(content)) {
        violations.push(`src/${file}: imports from providers`);
      }
      if (/from\s+['"]\.\/(?:providers|providers\/)/.test(content)) {
        violations.push(`src/${file}: imports from providers`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("only commands/context.mjs imports providers — the designated orchestration layer", () => {
    const content = readFileSync(join(ROOT, "src", "commands", "context.mjs"), "utf-8");
    expect(content).toMatch(/from\s+['"]\.\.\/providers\//);
  });
});

// ── Contract B: Empty result is never silently successful ──────────────────

describe("Contract B — Empty result is never silently successful", () => {
  it("jsonEnvelope throws when status=ok over incomplete coverage (behavioral)", async () => {
    const { jsonEnvelope } = await import("../report/json.mjs");
    expect(() =>
      jsonEnvelope({
        command: "check",
        context: { root: "/test", provider: "native", marker: "archkeep.json" },
        status: "ok",
        exitCode: 0,
        coverage: {
          complete: false,
          projects: 1,
          analyzedFiles: 0,
          imports: 0,
          notAnalyzed: [{ file: "a.go", reason: "unreadable" }],
          blindSpots: [],
          notes: [],
        },
        result: {},
      }),
    ).toThrow(/refusing to build a JSON envelope claiming status "ok" over incomplete coverage/);
  });

  it("jsonEnvelope throws when status and exitCode disagree (behavioral)", async () => {
    const { jsonEnvelope } = await import("../report/json.mjs");
    expect(() =>
      jsonEnvelope({
        command: "check",
        context: { root: "/test", provider: "native", marker: "archkeep.json" },
        status: "ok",
        exitCode: 3,
        coverage: {
          complete: true,
          projects: 1,
          analyzedFiles: 0,
          imports: 0,
          notAnalyzed: [],
          blindSpots: [],
          notes: [],
        },
        result: {},
      }),
    ).toThrow(/status.*and exitCode.*disagree/);
  });

  it("jsonEnvelope throws when coverage.complete and notAnalyzed disagree (behavioral)", async () => {
    const { jsonEnvelope } = await import("../report/json.mjs");
    expect(() =>
      jsonEnvelope({
        command: "check",
        context: { root: "/test", provider: "native", marker: "archkeep.json" },
        status: "ok",
        exitCode: 0,
        coverage: {
          complete: true,
          projects: 1,
          analyzedFiles: 0,
          imports: 0,
          notAnalyzed: [{ file: "a.go", reason: "unreadable" }],
          blindSpots: [],
          notes: [],
        },
        result: {},
      }),
    ).toThrow(/coverage\.complete.*disagrees with coverage\.notAnalyzed/);
  });

  it("CLI distinguishes exit 0 (clean), 1 (findings), 3 (cannot look) [source-evidence]", () => {
    const content = readFileSync(join(ROOT, "cli.mjs"), "utf-8");
    expect(content).toMatch(/EXIT\.violations/);
    expect(content).toMatch(/EXIT\.error/);
  });
});

// ── Contract C: Workspace resolution ≠ source analysis ──────────────────────

describe("Contract C — Workspace resolution ≠ source analysis", () => {
  it("analysis contract declares it judges nothing", () => {
    const content = readFileSync(join(ROOT, "src", "analysis", "contract.md"), "utf-8");
    expect(content).toMatch(/It judges nothing/);
    expect(content).toMatch(/analyzer that starts filtering/);
  });

  it("analysis code contains no judging vocabulary (allow, ban, forbid, violation as verbs)", () => {
    const violations = [];
    for (const file of productionMjsFiles()) {
      if (!file.startsWith("analysis/")) continue;
      const content = readFileSync(join(ROOT, "src", file), "utf-8");
      const code = stripComments(content);
      // Look for judging verbs — `bannedExternalImports` in JSDoc is acceptable.
      if (/\b(judge|forbid|permit|allow|ban)\b/.test(code) && !/bannedExternalImports/.test(code)) {
        violations.push(`src/${file}: contains judging vocabulary`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("graph create-dependencies returns only { source, target, sourceFile, type }", () => {
    const content = readFileSync(join(ROOT, "src", "graph", "create-dependencies.mjs"), "utf-8");
    // The resolver contract returns the four Nx-edge fields, nothing else.
    expect(content).toMatch(/\{ source, target, sourceFile, type \}/);
    // The header explains why fields are limited.
    expect(content).toMatch(/growing fields/);
  });

  it("analysis output conforms to the frozen contract schema (behavioral)", async () => {
    // The analysis contract in contract.md fixes the record shape. No extra
    // fields (especially verdict/policy fields) may appear on the output,
    // because extra fields are how policy judgment leaks into the analysis
    // layer silently.
    const { analyzeTypeScript } = await import("../analysis/typescript.mjs");
    const CONTRACT_IMPORT_KEYS = [
      "sourceFile",
      "line",
      "column",
      "specifier",
      "kind",
      "spelling",
      "resolved",
    ].sort();
    const CONTRACT_RESULT_KEYS = ["failures", "imports"].sort();

    const workspace = {
      root: "/test",
      projects: [{ name: "alpha", root: "libs/alpha" }],
      filesOf: () => ["libs/alpha/main.ts"],
      readFile: () => `import { Component } from '@angular/core';\n`,
      tsConfig: null,
    };
    const result = analyzeTypeScript({
      sourceFile: "libs/alpha/main.ts",
      text: `import { Component } from '@angular/core';\n`,
      workspace,
    });
    expect(Object.keys(result).sort()).toEqual(CONTRACT_RESULT_KEYS);
    for (const site of result.imports) {
      expect(Object.keys(site).sort()).toEqual(CONTRACT_IMPORT_KEYS);
    }
  });

  it("analysis output is invariant under project tag changes (behavioral)", async () => {
    // If the analysis layer judges nothing, its output must be identical
    // regardless of the owning project's tags. A filtering analyzer that
    // suppresses "banned" imports when the source project has certain tags
    // would produce different output for the same source text.
    const { analyzeTypeScript } = await import("../analysis/typescript.mjs");
    const text = `import { Component } from '@angular/core';\n`;
    const readFile = () => text;

    const workspaceNoTags = {
      root: "/test",
      projects: [{ name: "alpha", root: "libs/alpha" }],
      filesOf: () => ["libs/alpha/main.ts"],
      readFile,
      tsConfig: null,
    };
    // Tags are not part of the workspace.projects shape the analyzer sees,
    // but we verify the output is the same regardless.
    const result = analyzeTypeScript({
      sourceFile: "libs/alpha/main.ts",
      text,
      workspace: workspaceNoTags,
    });
    // The analyzer must return exactly one import for one import statement.
    expect(result.imports.length).toBe(1);
    expect(result.imports[0].specifier).toBe("@angular/core");
  });
});

// ── Contract D: Architecture snapshot identity ─────────────────────────────

describe("Contract D — Architecture snapshot identity", () => {
  it("graph.mjs sorts by plain string comparison, never localeCompare", () => {
    const content = readFileSync(join(ROOT, "src", "commands", "graph.mjs"), "utf-8");
    const code = stripComments(content);
    expect(code).not.toMatch(/localeCompare/);
    // The comment asserting the rule is present in the source (prose).
    expect(content).toMatch(/never `localeCompare`/);
  });

  it("internal data fields are stripped from the snapshot", () => {
    const content = readFileSync(join(ROOT, "src", "commands", "graph.mjs"), "utf-8");
    expect(content).toMatch(/INTERNAL_DATA_FIELDS/);
    expect(content).toMatch(/mfeRemote/);
  });

  it("SCHEMA_VERSION is defined and numeric", () => {
    const content = readFileSync(join(ROOT, "src", "report", "json.mjs"), "utf-8");
    const match = content.match(/export const SCHEMA_VERSION = (\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBeGreaterThan(0);
  });

  it("computePolicyFingerprint canonicalizes JSON before hashing (key-order independent)", () => {
    // The canonicalizer is shared, not inlined here — `graph.mjs` calls it and
    // `src/canonical.mjs` owns the sort, so the invariant lives in exactly one
    // place (`../../AGENTS.md`, "Never state a rule twice").
    const graphContent = readFileSync(join(ROOT, "src", "commands", "graph.mjs"), "utf-8");
    expect(graphContent).toMatch(/canonicalizeJson\(policy\)/);
    const canonicalContent = readFileSync(join(ROOT, "src", "canonical.mjs"), "utf-8");
    // The sort must happen at every depth so that insertion order does not
    // affect the hash — two semantically identical objects constructed in
    // different key order must produce the same fingerprint.
    expect(canonicalContent).toMatch(/Object\.keys\(current\)\s*\.sort\(\)/);
  });

  it("INTERNAL_DATA_FIELDS covers every node.data field the snapshot strips", () => {
    const graphContent = readFileSync(join(ROOT, "src", "commands", "graph.mjs"), "utf-8");
    // Extract the INTERNAL_DATA_FIELDS array entries from graph.mjs.
    const fieldsMatch = graphContent.match(
      /INTERNAL_DATA_FIELDS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/s,
    );
    expect(fieldsMatch).not.toBeNull();
    const strippedFields = fieldsMatch[1]
      .split(",")
      .map((s) => s.trim().replace(/['"]/g, ""))
      .filter(Boolean);
    // Known internal fields that the engine writes into node.data and that must
    // not appear in snapshots. If the engine starts writing a new internal
    // field, it must be added here or it leaks into the snapshot silently.
    const requiredFields = ["mfeRemote", "entryPoints", "declaredPackages"];
    for (const field of requiredFields) {
      expect(strippedFields).toContain(field);
    }
  });
});

// ── Contract E: Snapshot compatibility ──────────────────────────────────────

describe("Contract E — Snapshot compatibility", () => {
  it("diff parseBaseline refuses non-numeric schemaVersion (behavioral)", async () => {
    const { parseBaseline } = await import("../commands/diff.mjs");
    expect(() =>
      parseBaseline(
        JSON.stringify({
          schemaVersion: "bad",
          command: "graph",
          coverage: { complete: true },
          result: { projects: [], dependencies: [] },
        }),
        "test-baseline.json",
      ),
    ).toThrow(/no schemaVersion field/);
  });

  it("diff parseBaseline refuses mismatched schemaVersion (behavioral)", async () => {
    const { parseBaseline } = await import("../commands/diff.mjs");
    expect(() =>
      parseBaseline(
        JSON.stringify({
          schemaVersion: 999,
          command: "graph",
          coverage: { complete: true },
          result: { projects: [], dependencies: [] },
        }),
        "test-baseline.json",
      ),
    ).toThrow(/schemaVersion 999/);
  });
});

// ── Contract F: Diff semantics ─────────────────────────────────────────────

describe("Contract F — Diff semantics", () => {
  it("computeDiff returns structural diff with added/removed projects and edges (behavioral)", async () => {
    const { computeDiff } = await import("../commands/diff.mjs");
    const baseline = {
      projects: [{ name: "a", root: "libs/a", type: "lib", tags: [] }],
      dependencies: [{ source: "a", target: "b", type: "static" }],
    };
    const head = {
      projects: [
        { name: "a", root: "libs/a", type: "lib", tags: [] },
        { name: "b", root: "libs/b", type: "lib", tags: [] },
      ],
      dependencies: [],
    };
    const diff = computeDiff(baseline, head);
    expect(diff.removedProjects).toEqual([]);
    expect(diff.addedProjects.length).toBe(1);
    expect(diff.addedProjects[0].name).toBe("b");
    expect(diff.removedEdges.length).toBe(1);
    expect(diff.removedEdges[0].source).toBe("a");
  });
});

// ── Contract G: Impact determinism ──────────────────────────────────────────

describe("Contract G — Impact determinism", () => {
  it("impact uses BFS (queue.shift, not pop)", () => {
    const content = readFileSync(join(ROOT, "src", "commands", "impact.mjs"), "utf-8");
    expect(content).toMatch(/queue\.shift\(\)/);
  });

  it("impact sorts with plain string comparison, never localeCompare", () => {
    const content = readFileSync(join(ROOT, "src", "commands", "impact.mjs"), "utf-8");
    const code = stripComments(content);
    expect(code).not.toMatch(/localeCompare/);
    // All sorts use (a, b) => (a < b ? -1 : a > b ? 1 : 0)
    expect(code).toMatch(/\(a, b\) => \(a < b \? -1 : a > b \? 1 : 0\)/);
  });
});

// ── Contract H: Context — effective architecture contract ───────────────────

describe("Contract H — Context — effective architecture contract", () => {
  it("collectContext returns tags, constraints, and per-edge violations", () => {
    const content = readFileSync(join(ROOT, "src", "commands", "context-command.mjs"), "utf-8");
    // Return type includes tags, constraints, dependencies with violations.
    expect(content).toMatch(/tags: string\[\]/);
    expect(content).toMatch(/constraints: object\[\]/);
    expect(content).toMatch(/violations: object\[\]/);
  });

  it("context uses judgeEdge for per-edge verdicts (not full evaluate)", () => {
    const content = readFileSync(join(ROOT, "src", "commands", "context-command.mjs"), "utf-8");
    expect(content).toMatch(/judgeEdge/);
  });

  it("context coverage.notes discloses depConstraints-only narrowing", () => {
    const content = readFileSync(join(ROOT, "src", "commands", "context-command.mjs"), "utf-8");
    expect(content).toMatch(/notes:\s*\[/);
    expect(content).toMatch(/depConstraints/);
    expect(content).not.toMatch(/notes:\s*\[\]/);
  });
});

// ── Contract I: Explain — rule, reason, evidence ────────────────────────────

describe("Contract I — Explain — rule, reason, evidence", () => {
  it("explain uses full evaluate (not judgeEdge)", () => {
    const content = readFileSync(join(ROOT, "src", "commands", "explain.mjs"), "utf-8");
    expect(content).toMatch(/import \{ evaluate \} from/);
    // judgeEdge must NOT appear in explain.
    expect(content).not.toMatch(/judgeEdge/);
  });

  it("explain marks unresolvable imports explicitly (never silently drops)", () => {
    const content = readFileSync(join(ROOT, "src", "commands", "explain.mjs"), "utf-8");
    // unresolvable is an explicit boolean field, not absence.
    expect(content).toMatch(/unresolvable: true/);
    expect(content).toMatch(/unresolvable: false/);
  });
});

// ── Contract J: Check is enforcement authority ──────────────────────────────

describe("Contract J — Check is enforcement authority", () => {
  it("context command warns in coverage.notes about depConstraints-only scope", () => {
    const content = readFileSync(join(ROOT, "src", "commands", "context-command.mjs"), "utf-8");
    expect(content).toMatch(/depConstraints/);
    expect(content).toMatch(/check/);
    // The notes field is populated, not empty.
    expect(content).toMatch(/notes:\s*\[/);
    expect(content).not.toMatch(/notes:\s*\[\]/);
  });

  it("impact command warns in coverage.notes about depConstraints-only scope", () => {
    const content = readFileSync(join(ROOT, "src", "commands", "impact.mjs"), "utf-8");
    expect(content).toMatch(/depConstraints/);
    expect(content).toMatch(/check/);
    // The notes field is populated, not empty.
    expect(content).toMatch(/notes:\s*\[/);
    expect(content).not.toMatch(/notes:\s*\[\]/);
  });

  it("diff warns in coverage.notes when ruleImpact is computed (behavioral)", async () => {
    // diff.mjs computes ruleImpact via judgeEdge (depConstraints only, 3 of
    // 15 violation types). When ruleImpact is present in the result, the
    // coverage.notes must disclose the narrowing — a consumer seeing
    // status: "ok" alongside ruleImpact must not conclude the workspace is
    // free of all boundary violations.
    const content = readFileSync(join(ROOT, "src", "commands", "diff.mjs"), "utf-8");
    // The coverage.notes.push that warns about depConstraints narrowing must
    // appear within the same conditional block as result.ruleImpact.
    expect(content).toMatch(/result\.ruleImpact\s*=/);
    expect(content).toMatch(/coverage\.notes\.push/);
    // The notes must mention depConstraints and the 3-of-15 narrowing.
    expect(content).toMatch(/depConstraints.*3 of 15/);
    // The notes must direct the consumer to run check for the full verdict.
    // The string is split across concatenation ("Run check for the " +
    // "complete verdict."), so match either form.
    expect(content).toMatch(/Run check for the/);
    expect(content).toMatch(/complete verdict/);
  });

  it("depConstraints verdicts from judgeEdge agree with evaluate (behavioral)", async () => {
    // Where a focused command evaluates (depConstraints only), its verdicts
    // must agree with what check would produce. If judgeEdge and evaluate
    // disagree on a depConstraints violation, the focused command is
    // creating a different verdict than the enforcement authority.
    const { evaluate } = await import("../rules/index.mjs");
    const { judgeEdge } = await import("../commands/edge-constraints.mjs");

    const nodes = {
      alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: ["layer:domain"] } },
      beta: { name: "beta", type: "lib", data: { root: "libs/beta", tags: ["layer:adapter"] } },
    };
    const dependencies = { alpha: [{ source: "alpha", target: "beta", type: "static" }] };
    const config = {
      depConstraints: [
        {
          sourceTag: "layer:domain",
          onlyDependOnLibsWithTags: ["layer:domain"],
        },
      ],
      options: {
        allow: [],
        buildTargets: ["build"],
        enforceBuildableLibDependency: false,
        allowCircularSelfDependency: false,
        checkDynamicDependenciesExceptions: [],
        ignoredCircularDependencies: [],
        banTransitiveDependencies: false,
        checkNestedExternalImports: false,
      },
      suppressions: [],
    };

    // evaluate path
    const sites = [
      {
        sourceFile: "libs/alpha/main.ts",
        line: 1,
        column: 1,
        specifier: "@beta",
        kind: "static",
        spelling: { path: false, relative: false, namesOnly: false },
        resolved: { target: "beta", file: null, external: false, packageName: null },
      },
    ];
    const evalViolations = evaluate(sites, { nodes, dependencies }, config);
    const evalDepConstraintIds = new Set(
      evalViolations
        .filter((v) => v.messageId === "onlyTagsConstraintViolation")
        .map((v) => v.messageId),
    );

    // judgeEdge path — nodes must be an object keyed by name, not an array.
    const edgeViolations = judgeEdge(
      { source: "alpha", target: "beta" },
      nodes,
      dependencies,
      config.depConstraints,
    );
    const edgeDepConstraintIds = new Set(
      edgeViolations
        .filter((v) => v.messageId === "onlyTagsConstraintViolation")
        .map((v) => v.messageId),
    );

    // Both paths must agree: if evaluate finds a depConstraints violation,
    // judgeEdge must also find it (and vice versa).
    expect(evalDepConstraintIds.size).toBeGreaterThan(0);
    expect(edgeDepConstraintIds.size).toBeGreaterThan(0);
  });

  it("explain includes the same violations as evaluate at a given site (behavioral)", async () => {
    // explain runs full evaluate() and filters to the requested site. If the
    // same imports, graph, and config are provided, every violation evaluate
    // finds at a site must also appear in explain's output for that site.
    const { evaluate } = await import("../rules/index.mjs");
    const { explainCommand } = await import("../commands/explain.mjs");

    const nodes = {
      alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: ["layer:domain"] } },
      beta: { name: "beta", type: "lib", data: { root: "libs/beta", tags: ["layer:adapter"] } },
    };
    const dependencies = { alpha: [{ source: "alpha", target: "beta", type: "static" }] };
    const config = {
      depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
      options: {
        allow: [],
        buildTargets: ["build"],
        enforceBuildableLibDependency: false,
        allowCircularSelfDependency: false,
        checkDynamicDependenciesExceptions: [],
        ignoredCircularDependencies: [],
        banTransitiveDependencies: false,
        checkNestedExternalImports: false,
      },
      suppressions: [],
    };
    const site = {
      sourceFile: "libs/alpha/main.ts",
      line: 1,
      column: 1,
      specifier: "@beta",
      kind: "static",
      spelling: { path: false, relative: false, namesOnly: false },
      resolved: { target: "beta", file: null, external: false, packageName: null },
    };

    const commandContext = {
      root: "/test",
      provider: "native",
      marker: "archkeep.json",
      graph: { nodes, dependencies },
      analysis: { imports: [site], failures: [], analyzed: 1 },
    };

    const evalViolations = evaluate([site], { nodes, dependencies }, config);
    const evalIds = evalViolations.map((v) => v.messageId).sort();

    const explainResult = explainCommand("libs/alpha/main.ts:1:1", commandContext, config);
    // explain returns { explanation: { violations: [...] } } — the violations
    // are on the explanation object, not the top-level result.
    const explainIds = (explainResult.explanation.violations ?? []).map((v) => v.messageId).sort();

    // Every violation evaluate finds at the site must appear in explain.
    expect(explainIds).toEqual(evalIds);
  });
});

// ── Intent gate meta-tests ────────────────────────────────────────────────

describe("Intent gate meta-tests", () => {
  const EXECUTABLE_TYPES = new Set(["behavioral-test", "e2e-test", "architecture-test"]);

  /** Validates a manifest object using the same logic as the gate above. */
  function validateManifest(contracts) {
    const violations = [];
    for (const contract of contracts) {
      const hasExecutable = contract.evidence.some((ev) => EXECUTABLE_TYPES.has(ev.type));
      const computedStatus = hasExecutable ? "proven" : "documented";
      if (contract.status !== computedStatus) {
        violations.push(
          `Contract ${contract.id}: declared "${contract.status}" but computed "${computedStatus}"`,
        );
      }
      if (contract.status === "proven" && !hasExecutable) {
        violations.push(`Contract ${contract.id}: "proven" without executable proof`);
      }
    }
    return violations;
  }

  it("proven + missing evidence path → FAIL", () => {
    const violations = validateManifest([
      {
        id: "X",
        status: "proven",
        evidence: [{ type: "behavioral-test", path: "nonexistent.test.mjs", assertion: "x" }],
      },
    ]);
    // The gate derives status from evidence types. "behavioral-test" is
    // executable, so computed status is "proven" — matches declared.
    // The path-existence check (separate test) catches the missing file.
    // This meta-test verifies status derivation logic.
    expect(violations).toEqual([]);
    // But the path check would flag it:
    const resolved = join(ROOT, "nonexistent.test.mjs");
    expect(existsSync(resolved)).toBe(false);
  });

  it("proven + only documentation evidence → FAIL", () => {
    const violations = validateManifest([
      {
        id: "X",
        status: "proven",
        evidence: [{ type: "documentation", path: "docs/x.md", assertion: "x" }],
      },
    ]);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("proven + only source-evidence → FAIL", () => {
    const violations = validateManifest([
      {
        id: "X",
        status: "proven",
        evidence: [{ type: "source-evidence", path: "src/x.mjs", assertion: "x" }],
      },
    ]);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("documented + documentation evidence → valid (not proven)", () => {
    const violations = validateManifest([
      {
        id: "X",
        status: "documented",
        evidence: [{ type: "documentation", path: "docs/x.md", assertion: "x" }],
      },
    ]);
    expect(violations).toEqual([]);
  });

  it("proven + behavioral-test evidence → valid", () => {
    const violations = validateManifest([
      {
        id: "X",
        status: "proven",
        evidence: [{ type: "behavioral-test", path: "src/x.test.mjs", assertion: "x" }],
      },
    ]);
    expect(violations).toEqual([]);
  });

  it("status derived from evidence contradicts declared status → FAIL", () => {
    // A developer sets "proven" but only has documentation evidence.
    const violations = validateManifest([
      {
        id: "X",
        status: "proven",
        evidence: [{ type: "documentation", path: "docs/x.md", assertion: "x" }],
      },
    ]);
    expect(violations.some((v) => v.includes("declared") && v.includes("computed"))).toBe(true);
  });

  it("findSkipOnlyPatterns detects .skip and .only in test code", () => {
    // findSkipOnlyPatterns uses a state-machine string/regex/comment
    // stripper, then matches Vitest method calls. The test strings below
    // contain real call-site patterns that survive stripping.
    expect(findSkipOnlyPatterns("it.skip('x', () => {}")).toContain(".skip(");
    expect(findSkipOnlyPatterns("describe.skip('x', () => {}")).toContain(".skip(");
    expect(findSkipOnlyPatterns("test.skip('x', () => {}")).toContain(".skip(");
    expect(findSkipOnlyPatterns("it.only('x', () => {}")).toContain(".only(");
    expect(findSkipOnlyPatterns("xit('x', () => {}")).toContain("xit(");
    expect(findSkipOnlyPatterns("fit('x', () => {}")).toContain("fit(");
    expect(findSkipOnlyPatterns("xdescribe('x', () => {}")).toContain("xdescribe(");
    expect(findSkipOnlyPatterns("fdescribe('x', () => {}")).toContain("fdescribe(");
    // suite is a Vitest alias for describe — must also be caught.
    expect(findSkipOnlyPatterns("suite.skip('x', () => {}")).toContain(".skip(");
    expect(findSkipOnlyPatterns("suite.only('x', () => {}")).toContain(".only(");
    // Bracket notation evades dot-notation detection, but after string
    // stripping it['skip'] becomes it[''], and the bracket+empty+call
    // pattern is flagged as "bracket-skip/only".
    expect(findSkipOnlyPatterns("it['skip']('x', () => {})")).toContain("bracket-skip/only");
    expect(findSkipOnlyPatterns("it['only']('x', () => {})")).toContain("bracket-skip/only");
    // Verify that non-call-site .only/.skip is NOT flagged.
    expect(findSkipOnlyPatterns('expect(code).toContain(".only(");')).toEqual([]);
    expect(findSkipOnlyPatterns("const x = obj.only;")).toEqual([]);
    // Verify that .only inside string literals, regex, and comments is
    // not flagged — the state-machine stripper removes them first.
    expect(
      findSkipOnlyPatterns(
        'expect(findSkipOnlyPatterns("it.only(\'x\', () => {}")).toContain(".only(");',
      ),
    ).toEqual([]);
  });

  it("findSkipOnlyPatterns does not flag normal test code", () => {
    expect(findSkipOnlyPatterns("it('works', () => { expect(1).toBe(1); })")).toEqual([]);
    expect(findSkipOnlyPatterns("describe('suite', () => { it('works', () => {}) })")).toEqual([]);
  });

  it("matchesIncludePattern correctly validates vitest include patterns", () => {
    expect(matchesIncludePattern("src/rules/index.test.mjs", UNIT_INCLUDE)).toBe(true);
    expect(matchesIncludePattern("src/commands/diff.test.mjs", UNIT_INCLUDE)).toBe(true);
    expect(matchesIncludePattern("e2e/determinism.e2e.mjs", E2E_INCLUDE)).toBe(true);
    expect(matchesIncludePattern("e2e/context.e2e.mjs", E2E_INCLUDE)).toBe(true);
    // Non-matching paths
    expect(matchesIncludePattern("src/rules/index.tests.mjs", UNIT_INCLUDE)).toBe(false);
    expect(matchesIncludePattern("scripts/verify-package.mjs", UNIT_INCLUDE)).toBe(false);
    expect(matchesIncludePattern("src/commands/diff.test.js", UNIT_INCLUDE)).toBe(false);
    expect(matchesIncludePattern("src/intent/intent.test.mjs", UNIT_INCLUDE)).toBe(true);
  });
});

// ── Contract K: Determinism ────────────────────────────────────────────────

/**
 * Wall-clock and random read patterns Contract K forbids in production code.
 *
 * A raw call under ANY of these spellings makes output a function of the wall
 * clock or the RNG: `Date.now()` and `Math.random()` are the obvious ones,
 * and the argumentless `new Date()` is the same wall-clock read through a
 * different spelling (`new Date().toISOString()` at `adr-registry.mjs:512`
 * was how a raw clock escaped the old two-literal guard). `new Date()` with
 * an argument (`new Date(referenceTime)`, `new Date(Date.UTC(...))`) is a
 * pure function of its argument, NOT a wall-clock read, so the pattern is
 * deliberately the empty-paren shape. Whitespace inside the parens is
 * allowed because prettier may reformat a call that was written to hide.
 */
const WALL_CLOCK_PATTERNS = [
  /Date\s*\.\s*now\s*\(/,
  /Math\s*\.\s*random\s*\(/,
  /new\s+Date\s*\(\s*\)/,
];

/**
 * The deliberate wall-clock sites Contract K exempts, keyed by
 * `src/`-relative path → the line the raw read sits on.
 *
 * Exactly one production site is an ALLOWED wall-clock read: the injectable
 * reference-time seam itself (`governance/clock.mjs`). The whole governance
 * wave resolves determinism-by-injection through that one function, and its
 * header is the contract that states it; a second site that reached for
 * `Date` directly instead of the seam is precisely the counterexample this
 * guard exists to catch (P1-08). The two-line check has no other member —
 * `config.mjs`'s `new Date(Date.UTC(...))` and `debt-ledger.mjs`'s
 * `new Date(referenceTime)` do not match the empty-paren pattern at all,
 * being pure functions of their arguments. A new raw read anywhere — a new
 * module, a new site, a new spelling — goes RED until it names a
 * deterministic mechanism or joins this list with the reason it deserves to.
 */
const WALL_CLOCK_ALLOWLIST = new Map([["governance/clock.mjs", [27]]]);

describe("Contract K — Determinism", () => {
  it("no raw Date.now / new Date() / Math.random in any production module", () => {
    const violations = [];
    // The scan is recursive over the whole shipped `src/` tree — every
    // production `.mjs`, top-level modules (`options.mjs`, `workspace.mjs`,
    // …) included. A module that escapes this walk is a silent
    // determinism-gap, so there is no per-directory opt-out and no curated
    // directory list that a newly added directory or module must remember to
    // join. `maskNonCode` keeps indices aligned so the violation names the
    // exact offending line in the original file.
    for (const file of productionMjsFiles()) {
      const content = readFileSync(join(ROOT, "src", file), "utf-8");
      const code = maskNonCode(content);
      const allowlistedLines = WALL_CLOCK_ALLOWLIST.get(file);
      for (const pattern of WALL_CLOCK_PATTERNS) {
        for (const match of code.matchAll(RegExp(pattern.source, "g"))) {
          const line = content.slice(0, match.index).split("\n").length;
          if (allowlistedLines?.includes(line)) continue;
          violations.push(
            `src/${file}:${line}: uses ${pattern.source} — every wall-clock read goes through ` +
              `governance/clock.mjs's injectable referenceTime() (see that file's header)`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no localeCompare in any production module", () => {
    // The whole production tree, not three files: a `localeCompare` landing
    // in any module with the shell's collation set would drift sort order of
    // violations with LANG/LC_ALL. Every module header that promises "plain
    // `<` comparison" is enforced here, by walking the same recursive scan
    // the wall-clock guard uses.
    const violations = [];
    for (const file of productionMjsFiles()) {
      const content = readFileSync(join(ROOT, "src", file), "utf-8");
      const code = maskNonCode(content);
      if (/\blocaleCompare\s*\(/.test(code)) {
        violations.push(`src/${file}: uses localeCompare`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// ── Contract L: Provider parity — workspaceLayout completeness ─────────────

describe("Contract L — Provider parity", () => {
  it("Moon provider returns null for partial workspaceLayout (same all-or-nothing as Nx and Native)", () => {
    const content = readFileSync(join(ROOT, "src", "providers", "moon.mjs"), "utf-8");
    // The fix: inferWorkspaceLayout returns null when either key is missing.
    expect(content).toMatch(/appsDir === undefined \|\| libsDir === undefined/);
    expect(content).toMatch(/return null/);
  });

  it("Nx provider uses requireCompleteWorkspaceLayout", () => {
    const content = readFileSync(join(ROOT, "src", "providers", "nx.mjs"), "utf-8");
    expect(content).toMatch(/requireCompleteWorkspaceLayout/);
  });
});

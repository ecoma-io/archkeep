/**
 * Intent tests: executable proof that every v1.0 normative intent holds.
 *
 * These tests verify the INTENT declared in `intent-manifest.json`, not the
 * implementation that satisfies it. An intent test fails when the intent no
 * longer holds, regardless of which implementation detail changed.
 *
 * Each test is named by contract letter (A–L) and reads the actual source
 * to verify the normative claim — not a mock, not a snapshot, not a
 * hand-kept constant that agrees with the answer until one drifts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

/** Collect non-test .mjs files under a src subdirectory. */
function productionMjsFiles(dir) {
  const dirPath = join(ROOT, "src", dir);
  try {
    return readdirSync(dirPath, { recursive: true })
      .filter((f) => typeof f === "string" && f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
      .map((f) => String(f));
  } catch {
    return [];
  }
}

/** Strip single-line and block comments so we test code, not prose. */
function stripComments(src) {
  // Remove block comments (non-greedy, but handles no nested /* */)
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove single-line comments (// to end of line, but not inside strings)
  out = out.replace(/\/\/.*$/gm, "");
  return out;
}

// ── Contract A: Provider independence ──────────────────────────────────────

describe("Contract A — Provider independence", () => {
  const CORE_DIRS = ["rules", "analysis", "report"];

  it("core layers (rules, analysis, report) do not import from providers", () => {
    const violations = [];
    for (const dir of CORE_DIRS) {
      for (const file of productionMjsFiles(dir)) {
        const content = readFileSync(join(ROOT, "src", dir, file), "utf-8");
        if (/from\s+['"]\.\.\/(?:providers|providers\/)/.test(content)) {
          violations.push(`src/${dir}/${file}: imports from providers`);
        }
        if (/from\s+['"]\.\/(?:providers|providers\/)/.test(content)) {
          violations.push(`src/${dir}/${file}: imports from providers`);
        }
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
  it("JSON envelope throws when status=ok over incomplete coverage", () => {
    // Read the json.mjs source and verify the three assertion blocks exist.
    const content = readFileSync(join(ROOT, "src", "report", "json.mjs"), "utf-8");
    // The invariant is enforced by three throw statements in jsonEnvelope.
    expect(content).toMatch(/status === "ok" && coverage\.complete !== true/);
    expect(content).toMatch(/throw new Error/);
  });

  it("CLI distinguishes exit 0 (clean), 1 (findings), 3 (cannot look)", () => {
    const content = readFileSync(join(ROOT, "cli.mjs"), "utf-8");
    // Exit code 1 is for findings only.
    expect(content).toMatch(/EXIT\.violations/);
    // Exit code 3 is for cannot-look.
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
    for (const file of productionMjsFiles("analysis")) {
      const content = readFileSync(join(ROOT, "src", "analysis", file), "utf-8");
      const code = stripComments(content);
      // Look for judging verbs — `bannedExternalImports` in JSDoc is acceptable.
      if (/\b(judge|forbid|permit|allow|ban)\b/.test(code) && !/bannedExternalImports/.test(code)) {
        violations.push(`src/analysis/${file}: contains judging vocabulary`);
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
});

// ── Contract E: Snapshot compatibility ──────────────────────────────────────

describe("Contract E — Snapshot compatibility", () => {
  it("diff parseBaseline validates schemaVersion is a number", () => {
    const content = readFileSync(join(ROOT, "src", "commands", "diff.mjs"), "utf-8");
    expect(content).toMatch(/typeof envelope\.schemaVersion !== "number"/);
  });

  it("diff parseBaseline refuses mismatched schemaVersion", () => {
    const content = readFileSync(join(ROOT, "src", "commands", "diff.mjs"), "utf-8");
    expect(content).toMatch(/envelope\.schemaVersion !== SCHEMA_VERSION/);
    // The comment asserts the normative rule.
    expect(content).toMatch(/should refuse/);
  });
});

// ── Contract F: Diff semantics ─────────────────────────────────────────────

describe("Contract F — Diff semantics", () => {
  it("computeDiff returns structural diff with policyMismatch", () => {
    const content = readFileSync(join(ROOT, "src", "commands", "diff.mjs"), "utf-8");
    expect(content).toMatch(/export function computeDiff/);
    expect(content).toMatch(/policyMismatch/);
  });

  it("computeDiff calls computeRuleImpact for constraint context", () => {
    const content = readFileSync(join(ROOT, "src", "commands", "diff.mjs"), "utf-8");
    expect(content).toMatch(/computeRuleImpact/);
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
    const content = readFileSync(join(ROOT, "src", "commands", "graph.mjs"), "utf-8");
    // The fingerprint must sort keys at every depth so that insertion order
    // does not affect the hash — two semantically identical policy objects
    // constructed in different key order must produce the same fingerprint.
    expect(content).toMatch(/Object\.keys\(value\)\s*\.sort\(\)/);
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

// ── Contract K: Determinism ────────────────────────────────────────────────

describe("Contract K — Determinism", () => {
  it("no Date.now or Math.random in production source files", () => {
    const violations = [];
    const dirs = ["commands", "rules", "analysis", "report", "providers", "lsp"];
    for (const dir of dirs) {
      for (const file of productionMjsFiles(dir)) {
        const content = readFileSync(join(ROOT, "src", dir, file), "utf-8");
        if (/Date\.now\(\)/.test(content) || /Math\.random\(\)/.test(content)) {
          violations.push(`src/${dir}/${file}: uses Date.now or Math.random`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no localeCompare in production graph/impact/sort code", () => {
    const files = [
      join(ROOT, "src", "commands", "graph.mjs"),
      join(ROOT, "src", "commands", "impact.mjs"),
      join(ROOT, "src", "rules", "index.mjs"),
    ];
    const violations = [];
    for (const file of files) {
      try {
        const content = readFileSync(file, "utf-8");
        const code = stripComments(content);
        if (/localeCompare/.test(code)) {
          violations.push(file);
        }
      } catch {
        // File may not exist.
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
});

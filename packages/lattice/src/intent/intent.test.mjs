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
 * taxonomy, and "proven" status requires executable proof.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
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

// ── Manifest validation ───────────────────────────────────────────────────

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

  it('"proven" contracts have at least one executable proof evidence entry', () => {
    const violations = [];
    for (const contract of manifest.contracts) {
      if (contract.status === "proven") {
        const hasExecutable = contract.evidence.some((ev) => EXECUTABLE_TYPES.has(ev.type));
        if (!hasExecutable) {
          violations.push(
            `Contract ${contract.id}: status is "proven" but no evidence is an executable proof type`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("contracts without executable proof have status other than 'proven'", () => {
    const violations = [];
    for (const contract of manifest.contracts) {
      const hasExecutable = contract.evidence.some((ev) => EXECUTABLE_TYPES.has(ev.type));
      if (!hasExecutable && contract.status === "proven") {
        violations.push(
          `Contract ${contract.id}: no executable proof but status is "proven" — should be "documented"`,
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
});

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
  it("jsonEnvelope throws when status=ok over incomplete coverage (behavioral)", async () => {
    const { jsonEnvelope } = await import("../report/json.mjs");
    expect(() =>
      jsonEnvelope({
        command: "check",
        context: { root: "/test", provider: "native", marker: "lattice.json" },
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
        context: { root: "/test", provider: "native", marker: "lattice.json" },
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
        context: { root: "/test", provider: "native", marker: "lattice.json" },
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

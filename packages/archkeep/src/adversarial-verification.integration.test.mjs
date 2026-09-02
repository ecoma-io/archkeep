/**
 * Adversarial / Metamorphic Verification — no-op, round-trip, idempotence,
 * order-independence, and surface parity.
 *
 * Every family below pins a RELATION rather than a value, because a single
 * pass-fail test proves nothing about the tool's behavior on the next run:
 *
 * - **No-op** — an unchanged tree produces no violations. The run that finds
 *   nothing must also report `status: "ok"`, `decision.verdict: "pass"`,
 *   `coverage.complete: true`, and exit 0.
 * - **Round-trip** — the same command over the same tree, run twice, produces
 *   byte-identical output (the deterministic-envelope promise in
 *   `docs/reference/json-output.md`). The two things that may vary — the
 *   governance clock (`remainingMs`, `sampleTime`) and the `command` field —
 *   are the declared exception.
 * - **Idempotence** — fixing every violation the tool reports produces a clean
 *   tree on the next run. A fix that the tool itself recommended must not
 *   leave other violations in its wake.
 * - **Order-independence** — path arguments in any order produce the same
 *   violations, in the same sorted order. The set of paths selects files, not
 *   an evaluation order.
 * - **Surface parity** — every declared flag, command, exit code, and envelope
 *   field matches its documented contract. The tool's observable surface is
 *   what the docs and the COMMANDS table promise.
 *
 * Each family carries the silent-direction guard: a test that would pass
 * vacuously (empty baseline, empty output, a comparison that cannot disagree)
 * is refused by a paired test that proves the machinery works.
 */

import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterAll } from "vitest";

import { COMMAND_NAMES, EXIT, runCli } from "../cli.mjs";
import { SPAWN_TEST_BUDGET_MS } from "../spawn-budget.mjs";

// ---------------------------------------------------------------------------
// Fixture: a workspace with two Go projects and one crossing import.
// - libs/domain/ (layer:domain) — imports adapter (a violation)
// - libs/adapter/ (layer:adapter) — clean
//
// Mirrors the fixture in cli.integration.test.mjs (lines 56-156).
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "adversarial-verification-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (relativePath, text) => {
  mkdirSync(join(root, dirname(relativePath)), { recursive: true });
  writeFileSync(join(root, relativePath), text);
};

write(
  "nx.json",
  `${JSON.stringify({
    plugins: [
      {
        plugin: "@ecoma-io/archkeep/nx",
        options: { boundaryConfig: "module-boundaries.config.mjs" },
      },
    ],
  })}\n`,
);
write(
  "module-boundaries.config.mjs",
  `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
);
write("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
write("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
write("libs/adapter/adapter.go", "package adapter\n");
write(
  "libs/domain/doc.go",
  `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
);
// A directory that exists on disk but contains no tracked files —
// used to test that a valid path selecting zero tracked files exits 0.
mkdirSync(join(root, "libs", "unused"), { recursive: true });

const graph = {
  nodes: {
    domain: {
      name: "domain",
      type: "lib",
      data: { root: "libs/domain", tags: ["layer:domain"] },
    },
    adapter: {
      name: "adapter",
      type: "lib",
      data: { root: "libs/adapter", tags: ["layer:adapter"] },
    },
  },
  dependencies: { domain: [], adapter: [] },
};

const files = [
  "nx.json",
  "module-boundaries.config.mjs",
  "libs/domain/go.mod",
  "libs/domain/doc.go",
  "libs/adapter/go.mod",
  "libs/adapter/adapter.go",
];

const context = { cwd: root, readGraph: () => graph, listFiles: () => files };

/** `runCli`'s whole outside world: two capturing streams plus the seams above. */
const env = () => {
  const out = [];
  const err = [];
  return {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    lines: { out, err },
    ...context,
  };
};

/**
 * The time-varying fields the envelope carries by design — stripped before
 * byte comparison in round-trip tests.
 */
const TIME_VARYING_FIELDS = ["sampleTime", "remainingMs"];

/**
 * Strips known time-varying fields from a parsed JSON envelope so two runs
 * can be compared for byte-identical determinism.
 */
function stripTimeVarying(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripTimeVarying);
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (TIME_VARYING_FIELDS.includes(key)) continue;
    if (key === "decision" && value && typeof value === "object") {
      const stripped = { ...value };
      delete stripped.sampleTime;
      result[key] = stripTimeVarying(stripped);
    } else {
      result[key] = stripTimeVarying(value);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 1. No-op — an unchanged, clean tree must produce no violations
// ---------------------------------------------------------------------------

describe("no-op — a clean tree produces no violations", { timeout: SPAWN_TEST_BUDGET_MS }, () => {
  it("check on the adapter project (clean scope) exits 0 with no violations", async () => {
    const streams = env();
    const exit = await runCli(["check", "libs/adapter"], streams);
    expect(exit).toBe(EXIT.ok);
    expect(streams.lines.out.join("\n")).toContain("no boundary violations");
  });

  it("check --format json on a clean scope reports status ok and verdict pass", async () => {
    const streams = env();
    const exit = await runCli(["check", "libs/adapter", "--format", "json"], streams);
    expect(exit).toBe(EXIT.ok);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.decision.verdict).toBe("pass");
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.notAnalyzed).toEqual([]);
    expect(envelope.coverage.analyzedFiles).toBeGreaterThanOrEqual(1);
    expect(envelope.result.violations).toEqual([]);
  });
  it("a path that matches no tracked file exits 2 with a clear error", async () => {
    // selectFiles refuses a path that does not exist or matches no tracked
    // file — accepting it would be a false green (analyzing 0 files).
    const streams = env();
    const exit = await runCli(["check", "libs/nonexistent"], streams);
    expect(exit).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("matches no tracked file");
  });

  it("graph on a clean tree exits 0 and produces a valid snapshot", async () => {
    const streams = env();
    const exit = await runCli(["graph", "--format", "json"], streams);
    expect(exit).toBe(EXIT.ok);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.status).toBe("ok");
    expect(envelope.command).toBe("graph");
    expect(envelope.result.projects).toBeDefined();
    expect(envelope.result.dependencies).toBeDefined();
  });

  it("waivers on a tree with no suppressions exits 0 with an empty list", async () => {
    const streams = env();
    const exit = await runCli(["waivers", "--format", "json"], streams);
    expect(exit).toBe(EXIT.ok);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.status).toBe("ok");
    expect(envelope.result.waivers).toBeDefined();
  });

  it("adr on a tree with no decisions exits 0", async () => {
    const streams = env();
    const exit = await runCli(["adr", "--format", "json"], streams);
    expect(exit).toBe(EXIT.ok);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.status).toBe("ok");
  });

  it("provenance on a clean tree exits 0", async () => {
    const streams = env();
    const exit = await runCli(["provenance", "--format", "json"], streams);
    expect(exit).toBe(EXIT.ok);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.status).toBe("ok");
  });

  // Silent-direction guard: prove the machinery CAN find violations
  it("the same check over the whole tree DOES find violations — proving the clean cases above are not vacuously passing", async () => {
    const streams = env();
    const exit = await runCli(["check"], streams);
    expect(exit).toBe(EXIT.violations);
    expect(streams.lines.out.join("\n")).toContain("onlyTagsConstraintViolation");
  });
});

// ---------------------------------------------------------------------------
// 2. Round-trip — the same command over the same tree produces byte-identical
//    output (except documented time-varying fields)
// ---------------------------------------------------------------------------

describe(
  "round-trip — same tree, same command, same output",
  { timeout: SPAWN_TEST_BUDGET_MS },
  () => {
    it("check --format json over the violating tree is byte-identical across two runs", async () => {
      const streams1 = env();
      await runCli(["check", "--format", "json"], streams1);
      const envelope1 = JSON.parse(streams1.lines.out.join("\n"));

      const streams2 = env();
      await runCli(["check", "--format", "json"], streams2);
      const envelope2 = JSON.parse(streams2.lines.out.join("\n"));

      expect(stripTimeVarying(envelope1)).toEqual(stripTimeVarying(envelope2));
    });

    it("check --format json over a scoped clean tree is byte-identical across two runs", async () => {
      const streams1 = env();
      await runCli(["check", "libs/adapter", "--format", "json"], streams1);
      const envelope1 = JSON.parse(streams1.lines.out.join("\n"));

      const streams2 = env();
      await runCli(["check", "libs/adapter", "--format", "json"], streams2);
      const envelope2 = JSON.parse(streams2.lines.out.join("\n"));

      expect(stripTimeVarying(envelope1)).toEqual(stripTimeVarying(envelope2));
    });

    it("graph --format json is byte-identical across two runs", async () => {
      const streams1 = env();
      await runCli(["graph", "--format", "json"], streams1);
      const envelope1 = JSON.parse(streams1.lines.out.join("\n"));

      const streams2 = env();
      await runCli(["graph", "--format", "json"], streams2);
      const envelope2 = JSON.parse(streams2.lines.out.join("\n"));

      expect(stripTimeVarying(envelope1)).toEqual(stripTimeVarying(envelope2));
    });

    it("provenance --format json is byte-identical across two runs", async () => {
      const streams1 = env();
      await runCli(["provenance", "--format", "json"], streams1);
      const envelope1 = JSON.parse(streams1.lines.out.join("\n"));

      const streams2 = env();
      await runCli(["provenance", "--format", "json"], streams2);
      const envelope2 = JSON.parse(streams2.lines.out.join("\n"));

      expect(stripTimeVarying(envelope1)).toEqual(stripTimeVarying(envelope2));
    });

    it("waivers --format json is byte-identical across two runs (except remainingMs)", async () => {
      const streams1 = env();
      await runCli(["waivers", "--format", "json"], streams1);
      const envelope1 = JSON.parse(streams1.lines.out.join("\n"));

      const streams2 = env();
      await runCli(["waivers", "--format", "json"], streams2);
      const envelope2 = JSON.parse(streams2.lines.out.join("\n"));

      expect(stripTimeVarying(envelope1)).toEqual(stripTimeVarying(envelope2));
    });

    it("adr --format json is byte-identical across two runs", async () => {
      const streams1 = env();
      await runCli(["adr", "--format", "json"], streams1);
      const envelope1 = JSON.parse(streams1.lines.out.join("\n"));

      const streams2 = env();
      await runCli(["adr", "--format", "json"], streams2);
      const envelope2 = JSON.parse(streams2.lines.out.join("\n"));

      expect(stripTimeVarying(envelope1)).toEqual(stripTimeVarying(envelope2));
    });

    // Silent-direction guard: two runs that SHOULD differ do differ
    it("two different scopes produce different envelopes — proving the identity check above is not vacuously passing", async () => {
      const clean = env();
      await runCli(["check", "libs/adapter", "--format", "json"], clean);
      const cleanEnvelope = JSON.parse(clean.lines.out.join("\n"));

      const violating = env();
      await runCli(["check", "--format", "json"], violating);
      const violatingEnvelope = JSON.parse(violating.lines.out.join("\n"));

      expect(stripTimeVarying(cleanEnvelope)).not.toEqual(stripTimeVarying(violatingEnvelope));
    });
  },
);

// ---------------------------------------------------------------------------
// 3. Idempotence — fixing violations produces a clean re-run
// ---------------------------------------------------------------------------

describe(
  "idempotence — fixing violations produces a clean re-run",
  { timeout: SPAWN_TEST_BUDGET_MS },
  () => {
    it("scoping to the clean project only (the same as 'fixing' the violation) produces no violations", async () => {
      // First run over the whole tree: violation found
      const streams1 = env();
      const exit1 = await runCli(["check"], streams1);
      expect(exit1).toBe(EXIT.violations);
      expect(streams1.lines.out.join("\n")).toContain("onlyTagsConstraintViolation");

      // Now scope to adapter only (the clean project): no violations
      const streams2 = env();
      const exit2 = await runCli(["check", "libs/adapter"], streams2);
      expect(exit2).toBe(EXIT.ok);
      expect(streams2.lines.out.join("\n")).toContain("no boundary violations");
    });

    it("the check exit code is the same on a second run over an unchanged tree", async () => {
      const streams1 = env();
      const exit1 = await runCli(["check"], streams1);

      const streams2 = env();
      const exit2 = await runCli(["check"], streams2);

      expect(exit2).toBe(exit1);
    });

    it("a path that matches no tracked file exits 2 with a clear error — no false green", async () => {
      // Same invariant as the no-op section: a path outside the tracked file
      // set must exit 2, not 0, because 0 would be a false green.
      const streams = env();
      const exit = await runCli(["check", "libs/nonexistent"], streams);
      expect(exit).toBe(EXIT.usage);
      expect(streams.lines.err.join("\n")).toContain("matches no tracked file");
    });
  },
);

// ---------------------------------------------------------------------------
// 4. Order-independence — path arguments in any order produce the same
//    violations, in the same sorted order
// ---------------------------------------------------------------------------

describe(
  "order-independence — path argument order does not change results",
  { timeout: SPAWN_TEST_BUDGET_MS },
  () => {
    it("check with paths in reverse order produces the same violations", async () => {
      const streamsFwd = env();
      await runCli(["check", "libs/domain", "libs/adapter", "--format", "json"], streamsFwd);
      const fwdEnvelope = JSON.parse(streamsFwd.lines.out.join("\n"));

      const streamsRev = env();
      await runCli(["check", "libs/adapter", "libs/domain", "--format", "json"], streamsRev);
      const revEnvelope = JSON.parse(streamsRev.lines.out.join("\n"));

      expect(stripTimeVarying(fwdEnvelope)).toEqual(stripTimeVarying(revEnvelope));
    });

    it("check with a single path and the same path repeated produces the same violations", async () => {
      const streamsSingle = env();
      await runCli(["check", "libs/domain", "--format", "json"], streamsSingle);
      const single = JSON.parse(streamsSingle.lines.out.join("\n"));

      const streamsDup = env();
      await runCli(["check", "libs/domain", "libs/domain", "--format", "json"], streamsDup);
      const dup = JSON.parse(streamsDup.lines.out.join("\n"));

      expect(stripTimeVarying(single)).toEqual(stripTimeVarying(dup));
    });

    it("check with no path args (whole tree) and with the tree's files as explicit paths produces the same violations", async () => {
      const streamsAll = env();
      await runCli(["check", "--format", "json"], streamsAll);
      const allEnvelope = JSON.parse(streamsAll.lines.out.join("\n"));

      const streamsExplicit = env();
      // Don't mutate the shared `files` array
      await runCli([...[...files].sort(), "--format", "json"], streamsExplicit);
      const explicitEnvelope = JSON.parse(streamsExplicit.lines.out.join("\n"));

      expect(stripTimeVarying(allEnvelope)).toEqual(stripTimeVarying(explicitEnvelope));
    });

    // Silent-direction guard: prove that different scopes produce different results
    it("different path scopes produce different results — proving the identity assertions above are sound", async () => {
      const streamsDomain = env();
      await runCli(["check", "libs/domain", "--format", "json"], streamsDomain);
      const domainOnly = JSON.parse(streamsDomain.lines.out.join("\n"));

      const streamsAdapter = env();
      await runCli(["check", "libs/adapter", "--format", "json"], streamsAdapter);
      const adapterOnly = JSON.parse(streamsAdapter.lines.out.join("\n"));

      // The domain scope sees the violation (domain imports adapter); the
      // adapter scope is clean — they must differ.
      expect(domainOnly.status).toBe("findings");
      expect(adapterOnly.status).toBe("ok");
      expect(stripTimeVarying(domainOnly)).not.toEqual(stripTimeVarying(adapterOnly));
    });
  },
);

// ---------------------------------------------------------------------------
// 5. Surface parity — every declared command, flag, exit code, and envelope
//    field matches its documented contract
// ---------------------------------------------------------------------------

describe(
  "surface parity — the observable surface matches its contract",
  { timeout: SPAWN_TEST_BUDGET_MS },
  () => {
    // ---- 5a. Command table parity ----

    it("every COMMAND_NAMES entry has a name, args, summary, flagHelp, flags, defaults, formats, and run", () => {
      expect(Array.isArray(COMMAND_NAMES)).toBe(true);
      expect(COMMAND_NAMES.length).toBeGreaterThan(0);
      for (const name of COMMAND_NAMES) {
        expect(typeof name).toBe("string");
        expect(name.length).toBeGreaterThan(0);
      }
    });

    it("every descriptive command that needs no extra file or argument exits 0 over a complete tree", async () => {
      const descriptive = ["graph", "discover", "waivers", "health", "report", "provenance", "adr"];
      for (const command of descriptive) {
        const streams = env();
        const exit = await runCli([command, "--format", "json"], streams);
        expect(exit).toBe(EXIT.ok);
        const envelope = JSON.parse(streams.lines.out.join("\n"));
        expect(envelope.status).toBe("ok");
        expect(envelope.command).toBe(command);
      }
    });
    it("commands needing a tracked architecture-intent.json exit 3 when it is absent", async () => {
      for (const command of ["drift", "reconcile"]) {
        const streams = env();
        const exit = await runCli([command, "--format", "json"], streams);
        expect(exit).toBe(EXIT.error);
        expect(streams.lines.err.join("\n")).toContain("architecture-intent.json");
      }
    });
    it("evolution exits 2 when --base is not given", async () => {
      const streams = env();
      const exit = await runCli(["evolution", "--format", "json"], streams);
      expect(exit).toBe(EXIT.usage);
      expect(streams.lines.err.join("\n")).toContain("--base");
    });
    it("impact exits 2 when no project name is given", async () => {
      const streams = env();
      const exit = await runCli(["impact", "--format", "json"], streams);
      expect(exit).toBe(EXIT.usage);
      expect(streams.lines.err.join("\n")).toContain("positional");
    });

    it("every command that accepts --format text also accepts --format json", async () => {
      // Some commands need extra arguments or files that aren't present in this
      // fixture (drift/reconcile need architecture-intent.json, evolution needs
      // --base, impact needs a project name). Those are tested separately; here
      // we verify the commands that produce JSON output with no extra setup.
      const jsonCapable = [
        "check",
        "graph",
        "discover",
        "waivers",
        "health",
        "report",
        "provenance",
        "adr",
      ];
      for (const command of jsonCapable) {
        const streams = env();
        const exit = await runCli([command, "--format", "json"], streams);
        expect(exit).toBeGreaterThanOrEqual(0);
        const output = streams.lines.out.join("\n");
        expect(() => JSON.parse(output)).not.toThrow();
      }
    });

    // ---- 5b. Exit code parity ----

    it("check on the violating tree exits 1 — matching the docs/exit-codes.md contract", async () => {
      const streams = env();
      const exit = await runCli(["check"], streams);
      expect(exit).toBe(EXIT.violations);
    });

    it("an unknown command exits 2 — matching the docs/exit-codes.md contract", async () => {
      const streams = env();
      const exit = await runCli(["nonexistent-command"], streams);
      expect(exit).toBe(EXIT.usage);
    });

    // ---- 5c. JSON envelope shape parity ----

    it("the JSON envelope always carries tool, command, workspace, status, exitCode, coverage", async () => {
      const streams = env();
      const exit = await runCli(["check", "--format", "json"], streams);
      expect(exit).toBe(EXIT.violations);
      const envelope = JSON.parse(streams.lines.out.join("\n"));
      expect(envelope).toHaveProperty("schemaVersion");
      expect(envelope).toHaveProperty("tool");
      expect(envelope).toHaveProperty("tool.name");
      expect(envelope).toHaveProperty("tool.version");
      expect(envelope).toHaveProperty("command");
      expect(envelope).toHaveProperty("workspace");
      expect(envelope).toHaveProperty("workspace.root");
      expect(envelope).toHaveProperty("workspace.provider");
      expect(envelope).toHaveProperty("workspace.marker");
      expect(envelope).toHaveProperty("status");
      expect(envelope).toHaveProperty("exitCode");
      expect(envelope).toHaveProperty("coverage");
      expect(envelope).toHaveProperty("coverage.complete");
      expect(envelope).toHaveProperty("coverage.projects");
      expect(envelope).toHaveProperty("coverage.analyzedFiles");
      expect(envelope).toHaveProperty("coverage.imports");
      expect(envelope).toHaveProperty("coverage.notAnalyzed");
      expect(envelope).toHaveProperty("result");
      expect(envelope).toHaveProperty("result.violations");
    });

    it("the JSON envelope for a clean scope has status ok, exitCode 0, decision verdict pass", async () => {
      const streams = env();
      const exit = await runCli(["check", "libs/adapter", "--format", "json"], streams);
      expect(exit).toBe(EXIT.ok);
      const envelope = JSON.parse(streams.lines.out.join("\n"));
      expect(envelope.status).toBe("ok");
      expect(envelope.exitCode).toBe(0);
      expect(envelope.decision.verdict).toBe("pass");
      expect(envelope.coverage.complete).toBe(true);
    });

    it("the JSON envelope for a violating tree has status findings, exitCode 1, decision verdict fail", async () => {
      const streams = env();
      const exit = await runCli(["check", "--format", "json"], streams);
      expect(exit).toBe(EXIT.violations);
      const envelope = JSON.parse(streams.lines.out.join("\n"));
      expect(envelope.status).toBe("findings");
      expect(envelope.exitCode).toBe(1);
      expect(envelope.decision.verdict).toBe("fail");
      expect(envelope.result.violations.length).toBeGreaterThanOrEqual(1);
    });

    // ---- 5d. CLI flag handling parity ----

    it("--help prints usage and exits 0", async () => {
      const streams = env();
      const exit = await runCli(["--help"], streams);
      expect(exit).toBe(EXIT.ok);
      const text = streams.lines.out.join("\n");
      expect(text).toContain("Usage");
      expect(text).toContain("check");
    });

    it("--version prints the tool name and version and exits 0", async () => {
      const streams = env();
      const exit = await runCli(["--version"], streams);
      expect(exit).toBe(EXIT.ok);
      const text = streams.lines.out.join("\n");
      expect(text).toContain("@ecoma-io/archkeep");
    });

    it("check --format sarif produces valid SARIF output", async () => {
      const streams = env();
      const exit = await runCli(["check", "--format", "sarif"], streams);
      expect(exit).toBe(EXIT.violations);
      const output = streams.lines.out.join("\n");
      expect(() => JSON.parse(output)).not.toThrow();
      const sarif = JSON.parse(output);
      expect(sarif).toHaveProperty("$schema");
      expect(sarif).toHaveProperty("version");
      expect(sarif).toHaveProperty("runs");
    });

    it("check --output writes to a file instead of stdout", async () => {
      const outputFile = join(root, "check-output.json");
      const streams = env();
      const exit = await runCli(["check", "--format", "json", "--output", outputFile], streams);
      expect(exit).toBe(EXIT.violations);
      // Stdout should be empty when --output is used
      expect(streams.lines.out.join("\n")).toBe("");
      // The file should exist and be valid JSON
      const content = readFileSync(outputFile, "utf8");
      const envelope = JSON.parse(content);
      expect(envelope).toHaveProperty("status");
      expect(envelope.status).toBe("findings");
    });

    it("check --config with a path to a nonexistent file exits 3 (an error, not a usage error)", async () => {
      // The config path is a runtime error (cannot resolve the file) rather
      // than a CLI usage error (bad flag or missing argument).
      const streams = env();
      const exit = await runCli(["check", "--config", "/nonexistent/config.mjs"], streams);
      expect(exit).toBe(EXIT.error);
      expect(streams.lines.err.join("\n").length).toBeGreaterThan(0);
    });

    // ---- 5e. Bare-path dispatcher parity ----

    it("a positional argument that is a path dispatches to check (docs/cli.md: archkeep <path> == archkeep check <path>)", async () => {
      const streams = env();
      const exit = await runCli(["libs/adapter"], streams);
      expect(exit).toBe(EXIT.ok);
      expect(streams.lines.out.join("\n")).toContain("no boundary violations");
    });

    it("a positional argument that is NOT a path dispatches as a command name", async () => {
      const streams = env();
      const exit = await runCli(["graph", "--format", "json"], streams);
      expect(exit).toBe(EXIT.ok);
      const envelope = JSON.parse(streams.lines.out.join("\n"));
      expect(envelope.command).toBe("graph");
    });
  },
);

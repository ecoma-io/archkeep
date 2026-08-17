import { describe, expect, it, vi } from "vitest";

import { computeWaivers, waiversCommand } from "./waivers.mjs";

// `resolveProvenance` reaches the FS; the report row it fills is "where this
// run came from", not a waiver fact, so it is pinned to a constant as the
// drift tests do for theirs. `jsonEnvelope` is exercised for real elsewhere;
// here the test's subject is the command's verdict, not the envelope's shape.
vi.mock("./provenance.mjs", () => ({ resolveProvenance: vi.fn(() => "mock-provenance") }));

const NOW = "2026-08-16T10:00:00.000Z";

const violation = (sourceFile, messageId = "noRelativeOrAbsoluteImportsAcrossLibraries") => ({
  sourceFile,
  messageId,
});

/** The eight options `findBoundaryConfigViolations` requires stated. */
const options = (overrides = {}) => ({
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
  ...overrides,
});

/** A boundary law shaped like `policyFrom` returns — validatable by evaluate. */
const policy = (suppressions = [], depConstraints = [], optionOverrides = {}) => ({
  depConstraints,
  options: options(optionOverrides),
  suppressions,
});

/** A CommandContext shaped like `resolveCommandContext` produces. */
function commandContext(overrides = {}) {
  return {
    root: "/workspace",
    provider: "native",
    marker: "lattice.json",
    graph: {
      nodes: {
        alpha: { name: "alpha", data: { root: "area/alpha", tags: ["zone:x"] } },
        beta: { name: "beta", data: { root: "area/beta", tags: ["zone:y"] } },
      },
      dependencies: {},
    },
    analysis: {
      analyzed: 2,
      imports: [],
      failures: [],
    },
    ...overrides,
  };
}

const waiver = (overrides = {}) => ({
  path: "area/app/some.config.ts",
  reason: "the loader resolves no alias here",
  expiresAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

describe("computeWaivers", () => {
  it("keeps only rows carrying expiresAt — the distinguishing field", () => {
    const { waivers } = computeWaivers(
      [{ path: "a.js", reason: "a permanent suppression, not a waiver" }, waiver()],
      [],
      NOW,
    );
    expect(waivers.map((w) => w.path)).toEqual(["area/app/some.config.ts"]);
  });

  it("counts what each waiver currently covers, against the raw violations", () => {
    const rows = [waiver({ path: "area/app/*.ts" }), waiver({ path: "libs/other/*.go" })];
    const { waivers, covered, stale } = computeWaivers(
      rows,
      [
        violation("area/app/some.config.ts"),
        violation("area/app/other.config.ts"),
        violation("libs/beta/main.go"), // not under libs/other
      ],
      NOW,
    );
    expect(waivers[0].covered).toBe(2);
    expect(waivers[1].covered).toBe(0);
    expect(covered).toBe(1);
    expect(stale).toBe(1);
  });

  it("decides status against the injected clock — expired and active both reported", () => {
    const { expired, waivers } = computeWaivers(
      [waiver({ expiresAt: "2026-08-01T00:00:00.000Z" }), waiver()],
      [],
      NOW,
    );
    expect(waivers[0].status).toBe("expired");
    expect(waivers[0].remainingMs).toBeLessThan(0);
    expect(waivers[1].status).toBe("active");
    expect(expired).toBe(1);
  });

  it("sorts deterministically by path then expiresAt", () => {
    const { waivers } = computeWaivers(
      [
        waiver({ path: "z/z.ts" }),
        waiver({ path: "a/a.ts", expiresAt: "2026-10-01T00:00:00.000Z" }),
        waiver({ path: "a/a.ts", expiresAt: "2026-09-01T00:00:00.000Z" }),
      ],
      [],
      NOW,
    );
    expect(waivers.map((w) => w.path + "@" + w.expiresAt)).toEqual([
      "a/a.ts@2026-09-01T00:00:00.000Z",
      "a/a.ts@2026-10-01T00:00:00.000Z",
      "z/z.ts@2026-09-01T00:00:00.000Z",
    ]);
  });

  it("sorts with plain string comparison — never localeCompare, which depends on ICU data", () => {
    // Path casing keeps the plain-comparison answer separable from a
    // locale-collated one: under `en-US`, `"AB"` sorts before `"ab"` only
    // because the collator folds case, while plain byte order puts uppercase
    // (`A` = 0x41) before lowercase (`a` = 0x61) regardless of locale.
    const { waivers } = computeWaivers(
      [waiver({ path: "ab/main.ts" }), waiver({ path: "AB/main.ts" })],
      [],
      NOW,
    );
    expect(waivers.map((w) => w.path)).toEqual(["AB/main.ts", "ab/main.ts"]);
  });
});

describe("waiversCommand", () => {
  it("lists the run's waivers with the real engine's coverage, against a clean verdict", async () => {
    const result = await waiversCommand(commandContext(), policy([waiver()]), { now: NOW });
    expect(result.status).toBe("ok");
    expect(result.waivers.waivers).toHaveLength(1);
    expect(result.waivers.waivers[0].status).toBe("active");
    // The command evaluates with the table removed, so a waiver that names a
    // file the tree never visits is covered by nothing — read as dead weight.
    expect(result.waivers.waivers[0].covered).toBe(0);
    expect(result.report.text).toContain("1 waiver on the table");
    expect(result.report.json).toContain('"command": "waivers"');
  });

  it("counts a waiver over a real finding as covered, judging against the injected clock", async () => {
    const result = await waiversCommand(
      commandContext({
        analysis: {
          analyzed: 2,
          imports: [
            {
              sourceFile: "area/alpha/src/index.ts",
              specifier: "../../beta/src/thing",
              line: 3,
              column: 1,
              kind: "static",
              spelling: { path: true, relative: true },
              resolved: {
                target: "beta",
                file: "area/beta/src/thing.ts",
                external: false,
                packageName: null,
              },
            },
          ],
          failures: [],
        },
      }),
      policy([
        waiver({
          path: "area/alpha/src/index.ts",
          expiresAt: "2026-09-01T00:00:00.000Z",
        }),
      ]),
      { now: NOW },
    );
    expect(result.waivers.waivers[0].covered).toBe(1);
    expect(result.waivers.waivers[0].status).toBe("active");
    expect(result.report.text).toContain("1 current violation");
  });

  it("refuses a tree it could not fully read — incomplete coverage must not read as a stale surface", async () => {
    // A whole-file failure (line: null) means the analyzer never judged the
    // file, so a waiver naming it would read as "covers nothing" about a
    // finding the run never looked at — the silent direction. The command
    // throws, which `cli.mjs`'s `runWaivers` surfaces as exit 3.
    await expect(
      waiversCommand(
        commandContext({
          analysis: {
            analyzed: 1,
            imports: [],
            failures: [
              { sourceFile: "area/alpha/src/index.ts", line: null, reason: "could not parse" },
            ],
          },
        }),
        policy([waiver()]),
        { now: NOW },
      ),
    ).rejects.toThrow(/incomplete coverage/);
  });

  it("names an expired waiver against the injected clock, and a run of only waivers is still not clean", async () => {
    const result = await waiversCommand(
      commandContext({
        analysis: {
          analyzed: 2,
          imports: [
            {
              sourceFile: "area/alpha/src/index.ts",
              specifier: "../../beta/src/thing",
              line: 3,
              column: 1,
              kind: "static",
              spelling: { path: true, relative: true },
              resolved: {
                target: "beta",
                file: "area/beta/src/thing.ts",
                external: false,
                packageName: null,
              },
            },
          ],
          failures: [],
        },
      }),
      policy([
        waiver({
          path: "area/alpha/src/index.ts",
          expiresAt: "2026-08-01T00:00:00.000Z",
        }),
      ]),
      { now: NOW },
    );
    expect(result.waivers.expired).toBe(1);
    expect(result.waivers.waivers[0].covered).toBe(1);
    // The command is descriptive — it exits 0 when it completes, never 1 —
    // but its text must not read like a clean tree: the expired waiver covers
    // a violation that now re-asserts.
    expect(result.report.text).toContain("expired");
  });
});

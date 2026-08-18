import { describe, expect, it, vi } from "vitest";

import { computeWaivers, formatWaiversReport, waiversCommand } from "./waivers.mjs";

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

  // P1-07: a row with no `expiresAt` is a PERMANENT suppression, and it used
  // to be dropped on the floor here — filtered out by `isWaiver` and never
  // reported by anything downstream. These cases pin the other half of the
  // return shape: `suppressions` (the permanent rows, enriched like a waiver
  // minus the term) and `suppressed` (the distinct violations they hide).
  it("puts a row with no expiresAt in `suppressions`, never in `waivers`, with its own coverage", () => {
    const permanent = { path: "libs/vendored/**", reason: "vendored, checked upstream" };
    const { waivers, suppressions } = computeWaivers(
      [permanent, waiver()],
      [violation("libs/vendored/thing.go")],
      NOW,
    );
    expect(waivers).toHaveLength(1);
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0].path).toBe("libs/vendored/**");
    expect(suppressions[0].covered).toBe(1);
    // A permanent row carries no term — `computeWaivers` must not invent one.
    expect(suppressions[0]).not.toHaveProperty("status");
    expect(suppressions[0]).not.toHaveProperty("remainingMs");
  });

  it("counts `suppressed` as DISTINCT violations, not a sum over overlapping rows", () => {
    // Two permanent rows both matching the same violation must not double it
    // — `suppressed` answers "how many violations are hidden", and a
    // violation hidden by two rows at once is still one hidden violation.
    const wide = { path: "libs/**", reason: "workspace-wide, decided long ago" };
    const narrow = { path: "libs/legacy/**", reason: "legacy module frozen" };
    const { suppressions, suppressed } = computeWaivers(
      [wide, narrow],
      [violation("libs/legacy/main.go"), violation("libs/other/main.go")],
      NOW,
    );
    expect(suppressions.find((s) => s.path === "libs/**").covered).toBe(2);
    expect(suppressions.find((s) => s.path === "libs/legacy/**").covered).toBe(1);
    // Two rows, three per-row covered violations summed, but only 2 distinct
    // violations actually exist in the raw set.
    expect(suppressed).toBe(2);
  });

  it("a wildcard permanent suppression covers every violation in the raw set", () => {
    // The audit's own reproduction: `path: "**"` over a real violation.
    const wildcard = { path: "**", reason: "accepted workspace-wide, no expiry" };
    const { waivers, suppressions, suppressed } = computeWaivers(
      [wildcard],
      [violation("libs/domain/doc.go"), violation("libs/other/main.go")],
      NOW,
    );
    expect(waivers).toHaveLength(0);
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0].covered).toBe(2);
    expect(suppressed).toBe(2);
  });
});

describe("formatWaiversReport", () => {
  it("says no waivers when the surface is empty, naming what that means", () => {
    expect(formatWaiversReport(computeWaivers([], [], NOW))).toMatch(
      /no waivers — every boundary is enforced/,
    );
  });

  it("renders the term, the coverage, and the reason for each waiver", () => {
    const result = computeWaivers(
      [waiver({ origin: "ticket-1234" })],
      [violation("area/app/some.config.ts")],
      NOW,
    );
    const text = formatWaiversReport(result);
    expect(text).toContain("currently covers a violation");
    expect(text).toContain("1 current violation");
    expect(text).toContain("reason: the loader resolves no alias here");
    expect(text).toContain("expires: 2026-09-01T00:00:00.000Z");
    expect(text).toContain("origin: ticket-1234");
  });

  it("flags a waiver that covers nothing as stale, loudly", () => {
    const result = computeWaivers([waiver()], [], NOW);
    const text = formatWaiversReport(result);
    expect(text).toContain("covers nothing right now");
    expect(text).toContain("consider removing it");
  });

  // P1-07: the regression this file exists to guard. Before the fix,
  // `computeWaivers` dropped every row with no `expiresAt` before this
  // function ever saw it, so a workspace whose ENTIRE `boundarySuppressions`
  // table was permanent rows produced `waivers: []` and this function
  // returned the same "every boundary is enforced" text as a workspace with
  // no suppressions at all — a positive claim about a proposition never
  // measured. Reverting only the `waivers.mjs` source change (keeping this
  // test) is the red half of red/green: `suppressions` would come back `[]`
  // too, `formatWaiversReport` would hit the old unconditional early return,
  // and this whole test would fail on the `not.toMatch` line below.
  it("does not claim every boundary is enforced when a permanent suppression is hiding one", () => {
    const wildcard = { path: "**", reason: "accepted workspace-wide, no expiry" };
    const result = computeWaivers(
      [wildcard],
      [violation("libs/domain/doc.go", "onlyTagsConstraintViolation")],
      NOW,
    );
    expect(result.waivers).toHaveLength(0);
    const text = formatWaiversReport(result);
    expect(text).not.toMatch(/every boundary is enforced/);
    expect(text).toContain("no waivers — nothing is being accepted temporarily");
    expect(text).toContain("1 permanent suppression on the table");
    expect(text).toContain("currently hiding 1 violation");
    expect(text).toContain("- **: permanently hides 1 current violation");
    expect(text).toContain("reason: accepted workspace-wide, no expiry");
  });

  it("names a permanent suppression that currently covers nothing, the same way a stale waiver is named", () => {
    const dormant = { path: "libs/retired/**", reason: "kept for the day this path returns" };
    const result = computeWaivers([dormant], [], NOW);
    const text = formatWaiversReport(result);
    expect(text).toContain("- libs/retired/**: covers nothing right now");
  });

  it("renders both a waiver section and a permanent-suppression section together", () => {
    const result = computeWaivers(
      [waiver(), { path: "libs/legacy/**", reason: "legacy module frozen" }],
      [violation("area/app/some.config.ts"), violation("libs/legacy/main.go")],
      NOW,
    );
    const text = formatWaiversReport(result);
    expect(text).toContain("1 waiver on the table");
    expect(text).toContain("1 permanent suppression on the table");
    // Neither section's claim leaks into the other's summary line.
    expect(text).not.toMatch(/every boundary is enforced/);
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

  // P1-07, end to end through the command: a single `path: "**"` PERMANENT
  // suppression (no `expiresAt`) over a workspace carrying one real
  // violation and nothing else. Before the fix, `result.waivers.waivers` was
  // `[]` (correct — there are no waivers) and nothing else in the payload or
  // the text ever named the suppression, so the report read identically to a
  // workspace with an empty `boundarySuppressions` table: "no waivers —
  // every boundary is enforced". Reverting only the `waivers.mjs` source
  // change and re-running this test fails it on the `not.toMatch` assertion
  // and on `suppressed`/`suppressions` being absent — the silent direction
  // this test exists to close.
  it("names a path: '**' permanent suppression and the violation it hides, never claiming full enforcement", async () => {
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
      policy([{ path: "**", reason: "accepted workspace-wide, no expiry" }]),
      { now: NOW },
    );

    expect(result.status).toBe("ok");
    expect(result.waivers.waivers).toHaveLength(0);
    expect(result.waivers.suppressions).toHaveLength(1);
    expect(result.waivers.suppressions[0].covered).toBe(1);
    expect(result.waivers.suppressed).toBe(1);

    expect(result.report.text).not.toMatch(/every boundary is enforced/);
    expect(result.report.text).toContain("1 permanent suppression on the table");
    expect(result.report.text).toContain("currently hiding 1 violation");

    const envelope = JSON.parse(result.report.json);
    expect(envelope.result.suppressions).toHaveLength(1);
    expect(envelope.result.suppressed).toBe(1);
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

describe("waiversCommand — determinism", () => {
  // One hour after NOW; the default waiver's 2026-09-01 term keeps `status`
  // "active" at both instants, isolating the wall-clock variance to
  // `remainingMs` alone — the exact field P1-05 found leaking into every
  // run's bytes.
  const LATER = "2026-08-16T11:00:00.000Z";

  /** Every field of a waivers envelope except the one documented as time-relative. */
  function stripTimeRelativeFields(envelope) {
    return {
      ...envelope,
      result: {
        ...envelope.result,
        waivers: envelope.result.waivers.map(({ remainingMs: _remainingMs, ...rest }) => rest),
      },
    };
  }

  it("silent-direction guard: two runs of an unchanged tree at different reference times must not diverge anywhere but the documented field", async () => {
    const a = await waiversCommand(commandContext(), policy([waiver()]), { now: NOW });
    const b = await waiversCommand(commandContext(), policy([waiver()]), { now: LATER });
    const envelopeA = JSON.parse(a.report.json);
    const envelopeB = JSON.parse(b.report.json);

    // The isolated field genuinely moves with the clock — a frozen value here
    // would silently defeat the "time remaining right now" it exists to
    // report, the opposite failure from the one this test's title guards.
    expect(envelopeA.result.waivers[0].remainingMs).not.toBe(
      envelopeB.result.waivers[0].remainingMs,
    );
    expect(envelopeA.result.waivers[0].status).toBe("active");
    expect(envelopeB.result.waivers[0].status).toBe("active");

    // Before this fix, nothing marked `remainingMs` as the sanctioned
    // exception, so a naive full-envelope diff/hash across two real runs
    // reported drift on every single run — "five runs, five distinct
    // hashes" — indistinguishable from an actual change to the workspace.
    // Stripping only the one documented field must leave the two envelopes
    // byte-identical; any other field moving here would be the silent
    // regression this test exists to catch.
    expect(JSON.stringify(stripTimeRelativeFields(envelopeA))).toBe(
      JSON.stringify(stripTimeRelativeFields(envelopeB)),
    );
  });

  it("discloses the excluded field in-band, in coverage.notes, on every run — not only in prose docs", async () => {
    const result = await waiversCommand(commandContext(), policy([waiver()]), { now: NOW });
    const envelope = JSON.parse(result.report.json);
    expect(envelope.coverage.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("remainingMs is the wall clock")]),
    );
  });
});

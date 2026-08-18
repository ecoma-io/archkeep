/**
 * The config-spelling differential: the same boundary law, expressed in every
 * accepted spelling `./config.mjs` and `cli.mjs` recognise, must load to the
 * SAME `{depConstraints, options, suppressions}` policy and judge the SAME
 * tree to the SAME verdict — and any place the spellings genuinely cannot
 * agree (an ESLint flat config has no `boundarySuppressions` counterpart at
 * all) must be a documented, structural refusal rather than a value that
 * quietly comes out smaller.
 *
 * This is `./providers/native/differential.integration.test.mjs`'s sibling
 * along a different axis. That file proves two PROVIDERS (Nx, native) agree
 * on one config; this file proves the CONFIG ITSELF is spelling-invariant —
 * the path it is read from, the filename it is given, which workspace-root
 * marker is present, which of four dialects holds it, and which options a
 * dialect states outright versus leaves to a default. `../../../AGENTS.md`'s
 * invariant, applied to config loading rather than to a rule verdict: a
 * dialect that quietly loaded a SMALLER policy than the one written — one
 * fewer constraint row, one option silently defaulted instead of read — would
 * be indistinguishable, in every report this tool prints, from a workspace
 * that never had that constraint at all. Every axis below therefore carries
 * both a positive case (every spelling agrees) and a red twin (a deliberately
 * divergent pair the differential MUST catch) — a positive case alone would
 * only prove the tool can pass, never that it can fail.
 *
 * Five axes:
 *
 * - **A1 — path source.** The same `.mjs` law, read from its default location
 *   and through `--config` pointing at a relocated copy of the identical
 *   bytes, must agree; `--config` pointing at a DIFFERENTLY-written law must
 *   disagree, proving the flag genuinely overrides rather than being quietly
 *   ignored in favour of the default.
 * - **A2 — filename.** A non-default filename, declared through `nx.json`'s
 *   `boundaryConfig` option, must load identically to the same text under the
 *   default name; a `boundaryConfig` that names a file which is not actually
 *   there must throw — never silently fall back to the conventional name.
 * - **A3 — marker.** The identical law and the identical two-project tree,
 *   judged once through the `nx.json` marker and once through the
 *   `lattice.json` marker, must reach the identical verdict; a root carrying
 *   BOTH markers at once must refuse to run rather than silently pick one.
 * - **A4 — dialect.** The same law spelled as an `.mjs` module, a `.json`
 *   file, an ESLint flat config, and an inline `lattice.json` object must
 *   load to the same policy and judge the same tree identically; a `.json`
 *   spelling missing one constraint row must be caught, naming the row.
 * - **A5 — the law's home.** An ESLint entry that leaves an option unstated
 *   must equal the module dialect stating that option at its real, live-read
 *   `@nx/eslint-plugin` default — never a value copied into this file, which
 *   would drift the day upstream changed a default — and a suppression the
 *   `.mjs` dialect declares has no ESLint counterpart at all: `./config.mjs`'s
 *   header names that gap on purpose, and this axis is where that documented
 *   asymmetry is pinned against a real load rather than left as prose. This
 *   axis reads the live default off both sides, so it does NOT catch upstream
 *   changing what that default actually IS — a real change would move both
 *   sides together, silently. That coverage is `./rules/upstream.integration.test.mjs`'s,
 *   which pins the default VALUES against a literal precisely so a change there
 *   is loud; this axis only ever proves "unstated equals live-read", never
 *   "live-read equals what it used to be".
 *
 * Tier 2's shared two-project tree only ever exercises `depConstraints[0]`
 * (`layer:domain` → `onlyDependOnLibsWithTags: ["layer:domain"]`) — the one
 * violation it carries is `domain` reaching into `adapter`, which that row
 * alone is enough to flag. `depConstraints[1]` (the `layer:adapter` row) never
 * fires in any Tier 2 assertion below; only A4's red twin and A1's own
 * hand-typed permissive fixture ever touch it.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { check } from "../cli.mjs";
import { loadBoundaryConfig, loadBoundaryConfigFile, policyFrom } from "./config.mjs";
import {
  SIMPLE_BOUNDARY_CONFIG,
  SIMPLE_GO_FILES,
  buildSimpleNativeTree,
  buildSimpleNxTree,
  writeAll,
  writeIn,
} from "./providers/native/differential.fixtures.mjs";

// `@nx/eslint-plugin` resolves by walking a file's own ancestor directories
// (`./eslint-config.mjs`'s `resolveEslintPluginDefaults` header), so an ESLint
// dialect fixture has to live under an ancestor of this package's own
// `node_modules` — the OS tmpdir is not one. Mirrors
// `cli.integration.test.mjs`'s `packageRoot`.
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// The one law every dialect below states, in its own dialect's own words
// ---------------------------------------------------------------------------

/**
 * Every `@nx/enforce-module-boundaries` option this package's own installed
 * `@nx/eslint-plugin` defaults to, read LIVE off the plugin itself — never
 * copied into this file, which is exactly the drift `./eslint-config.mjs`'s
 * `resolveEslintPluginDefaults` (the function this reproduces the logic of,
 * over the package's own `node_modules` rather than by importing that
 * module-private function) exists to avoid. Reading these live rather than
 * hardcoding them is what lets A5's "an ESLint option left unstated equals
 * the module dialect stating it explicitly" case prove a real equivalence —
 * against upstream's actual default — rather than a coincidence pinned
 * against a value typed twice.
 *
 * @returns {Record<string, unknown>}
 */
function installedModuleBoundaryDefaults() {
  const plugin = require("@nx/eslint-plugin");
  const { depConstraints: _pluginDepConstraintsDefault, ...defaults } =
    plugin.rules["enforce-module-boundaries"].defaultOptions[0];
  return defaults;
}

// `SIMPLE_BOUNDARY_CONFIG` (imported above) is `.mjs` source TEXT, not an
// object — `buildLaw` below needs the same `depConstraints` table as data, to
// reshape into every other dialect's syntax. Hand-typing that table a second
// time here would be exactly the drift `../../../AGENTS.md`'s "never state a
// rule twice" rule exists to catch: the two copies would agree only until one
// of them changed. A `data:` URL `import()` evaluates the real source text as
// a real ES module — no filesystem write, no second parser — so the table
// used below is the SAME table `buildSimpleNxTree`/`buildSimpleNativeTree`
// write into A3's fixture trees, derived rather than duplicated.
const { depConstraints: SIMPLE_DEP_CONSTRAINTS } = await import(
  `data:text/javascript,${encodeURIComponent(SIMPLE_BOUNDARY_CONFIG)}`
);

/**
 * The same law `SIMPLE_BOUNDARY_CONFIG` (imported above) states as `.mjs`
 * source text, as a plain object every dialect's serializer below can
 * reshape into its own syntax — kept in agreement with that text on purpose,
 * so this file's own dialect spellings and the shared provider-differential
 * fixtures (`buildSimpleNxTree`/`buildSimpleNativeTree`, reached through A3)
 * judge the identical two-project tree to the identical verdict. Every
 * `moduleBoundaryOptions` value here sits at the plugin's real, live-read
 * default — A5(a) depends on that being true, so an axis that needs a
 * spelling to state an option AWAY from the default (A4) builds its own law
 * with `buildA4Law` below rather than mutating this one.
 *
 * @returns {{depConstraints: object[], moduleBoundaryOptions: Record<string, unknown>}}
 */
function buildLaw() {
  return {
    depConstraints: SIMPLE_DEP_CONSTRAINTS,
    moduleBoundaryOptions: installedModuleBoundaryDefaults(),
  };
}

/**
 * A4's own law, distinct from `buildLaw()` on purpose: it states
 * `buildTargets` AWAY from the plugin's live default (`["build"]` becomes
 * `["build", "e2e-build"]`). Without that, A4's four-dialect comparison would
 * pass identically whether or not each dialect's loader actually READ its
 * stated options — every dialect merges an unstated option onto the SAME live
 * default, so a loader that silently ignored what was written and fell back
 * to that default would still agree with the other three. Verified: flipping
 * `./eslint-config.mjs`'s `loadEslintBoundaryConfig` merge order so a stated
 * option loses to the default leaves every A4 assertion green when this
 * function returns live defaults, and red once it states one away from them.
 *
 * @returns {{depConstraints: object[], moduleBoundaryOptions: Record<string, unknown>}}
 */
function buildA4Law() {
  return {
    depConstraints: SIMPLE_DEP_CONSTRAINTS,
    moduleBoundaryOptions: {
      ...installedModuleBoundaryDefaults(),
      buildTargets: ["build", "e2e-build"],
    },
  };
}

/** @param {{depConstraints: object[], moduleBoundaryOptions: object}} law */
function moduleText(law) {
  return `export const depConstraints = ${JSON.stringify(law.depConstraints, null, 2)};
export const moduleBoundaryOptions = ${JSON.stringify(law.moduleBoundaryOptions, null, 2)};
`;
}

/** @param {{depConstraints: object[], moduleBoundaryOptions: object}} law */
function jsonText(law) {
  return JSON.stringify(
    { depConstraints: law.depConstraints, moduleBoundaryOptions: law.moduleBoundaryOptions },
    null,
    2,
  );
}

/** An unscoped ESLint flat-config entry stating every option explicitly. */
function eslintText(law) {
  return `export default [
  {
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        ${JSON.stringify({ depConstraints: law.depConstraints, ...law.moduleBoundaryOptions })},
      ],
    },
  },
];
`;
}

/**
 * The same entry, stating ONLY `depConstraints` — the one key
 * `./eslint-config.mjs`'s `parseRuleValue` requires — and leaving every
 * other option to `resolveEslintPluginDefaults`. A5's sub-case (a) fixture.
 */
function eslintTextDepConstraintsOnly(law) {
  return `export default [
  {
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        { depConstraints: ${JSON.stringify(law.depConstraints)} },
      ],
    },
  },
];
`;
}

// ---------------------------------------------------------------------------
// The comparator: expectAllEquivalent
// ---------------------------------------------------------------------------

/**
 * The first place two values disagree, walked depth-first with sorted object
 * keys so the walk order cannot itself hide or invent a difference.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} path
 * @returns {{path: string, a: unknown, b: unknown}|null}
 */
function firstDifference(a, b, path = "(root)") {
  if (a === b) return null;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return { path, a, b };
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index++) {
      const found = firstDifference(a[index], b[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      const found = firstDifference(a[key], b[key], path === "(root)" ? key : `${path}.${key}`);
      if (found) return found;
    }
    return null;
  }
  return { path, a, b };
}

/** Strips the ESLint-only `notes` field — dialect metadata about which entry bound, never part of the law two spellings are claimed to agree on. */
function normalizePolicy(policy) {
  const { notes: _notes, ...rest } = policy;
  return rest;
}

/**
 * Every accepted spelling of the same boundary law must load to the
 * identical `{depConstraints, options, suppressions}` — the claim this whole
 * file exists to hold, and `../../../AGENTS.md`'s invariant applied to config
 * loading: two spellings that quietly disagreed would mean the SAME
 * workspace enforces two different laws depending only on which file the
 * config happened to be named, with nothing in either report to say so.
 *
 * `expectedCount` is required, not inferred from `members.length` — a caller
 * states the group size it actually built, so a group that silently shrank
 * (a member accidentally dropped from the array literal below it) fails HERE
 * rather than passing because the fewer remaining members still agree with
 * each other. Fewer than two is refused outright: a group of one, or zero,
 * asserts nothing and would pass trivially forever, including silently after
 * a second spelling's loader was deleted.
 *
 * @param {{spelling: string, policy: {depConstraints: object[], options: object, suppressions: object[], notes?: string[]}}[]} members
 * @param {number} expectedCount The group size this call site is claiming to
 *   compare — must be at least 2, and must equal `members.length`.
 * @throws {Error} when `expectedCount` is below two, when `members.length`
 *   does not equal `expectedCount`, or when any two members disagree —
 *   naming both spellings and the first differing JSON path.
 */
function expectAllEquivalent(members, expectedCount) {
  if (typeof expectedCount !== "number" || expectedCount < 2) {
    throw new Error(
      `expectAllEquivalent: expectedCount must be at least two — an equivalence claim needs at ` +
        `least two members to compare; a group of one passes trivially forever. Got ${expectedCount}.`,
    );
  }
  if (members.length !== expectedCount) {
    throw new Error(
      `expectAllEquivalent: expected ${expectedCount} spelling(s) but received ${members.length} ` +
        "— a group that silently shrank would otherwise pass as long as the SURVIVING members still " +
        `agreed. Spellings received: ${members.map((member) => member.spelling).join(", ") || "(none)"}.`,
    );
  }
  const [first, ...rest] = members;
  const firstPolicy = normalizePolicy(first.policy);
  for (const other of rest) {
    const diff = firstDifference(firstPolicy, normalizePolicy(other.policy));
    if (diff) {
      throw new Error(
        `config-spelling differential: "${first.spelling}" and "${other.spelling}" disagree at ` +
          `${diff.path}: ${JSON.stringify(diff.a)} vs ${JSON.stringify(diff.b)}`,
      );
    }
  }
}

/**
 * `expectAllEquivalent`'s sibling for Tier 2: full, byte-equal `check()`
 * reports rather than one hand-picked violation line. A `toContain` on a
 * single line would miss any other way two spellings' reports diverge — a
 * stray `notes` entry, a different coverage count — so this compares the
 * WHOLE rendered report, and if a dialect legitimately differs, the fix is to
 * assert that exact difference by name at the call site, never to weaken this
 * back into a substring check.
 *
 * @param {{spelling: string, report: string}[]} members
 * @param {number} expectedCount Same contract as `expectAllEquivalent`'s.
 * @throws {Error} when `expectedCount` is below two, when `members.length`
 *   does not equal `expectedCount`, or when any two reports differ byte-for-byte.
 */
function expectReportsEqual(members, expectedCount) {
  if (typeof expectedCount !== "number" || expectedCount < 2) {
    throw new Error(
      `expectReportsEqual: expectedCount must be at least two — an equivalence claim needs at ` +
        `least two members to compare. Got ${expectedCount}.`,
    );
  }
  if (members.length !== expectedCount) {
    throw new Error(
      `expectReportsEqual: expected ${expectedCount} spelling(s) but received ${members.length} ` +
        `— a group that silently shrank would otherwise pass. Spellings received: ` +
        `${members.map((member) => member.spelling).join(", ") || "(none)"}.`,
    );
  }
  const [first, ...rest] = members;
  for (const other of rest) {
    if (other.report !== first.report) {
      throw new Error(
        `config-spelling differential: "${first.spelling}" and "${other.spelling}" produced ` +
          `different reports.\n--- ${first.spelling} ---\n${first.report}\n--- ${other.spelling} ---\n${other.report}`,
      );
    }
  }
}

/**
 * Splits off the policy-identity line `formatPolicy` now prints first
 * (`../report/text.mjs`, P1-01) — the one line every axis below is now
 * EXPECTED to diverge on, because a different spelling is, by construction, a
 * different file, dialect, or route, and that is exactly the fact the line
 * exists to name. Every other axis in this file proves the LAW is
 * spelling-invariant, not the file path that carried it, so the policy line
 * is split off and asserted on its own terms here rather than folded into
 * `expectReportsEqual`, which stays a strict byte comparison by design (its
 * own doc comment above: "if a dialect legitimately differs, the fix is to
 * assert that exact difference by name at the call site, never to weaken this
 * back into a substring check") — the same pattern A3's own `exemptionNote`
 * stripping below already uses for its one expected, provider-specific
 * divergence.
 *
 * @param {string} report A `check({format: "text"})` report.
 * @returns {{source: string, fingerprint: string, rest: string}} `source` and
 *   `fingerprint` are the policy line's own two facts, parsed rather than
 *   regex-matched loosely, so a report that did NOT open with a well-formed
 *   policy line throws here instead of silently comparing past it. `rest` is
 *   everything after the line and its separating blank line — what the axis
 *   itself still claims is spelling-invariant.
 */
function splitPolicyLine(report) {
  const [firstLine, ...rest] = report.split("\n\n");
  const match = firstLine.match(/^policy {2}(.+) — fingerprint ([0-9a-f]{64})$/);
  if (!match) {
    throw new Error(
      `splitPolicyLine: report did not open with a well-formed policy line: ${JSON.stringify(firstLine)}`,
    );
  }
  return { source: match[1], fingerprint: match[2], rest: rest.join("\n\n") };
}

describe("expectAllEquivalent — the comparator, proved before it is trusted", () => {
  it("throws when expectedCount itself is below two: an equivalence claim needs at least two spellings", () => {
    expect(() => expectAllEquivalent([], 0)).toThrow(/at least two/);
    const policy = { depConstraints: [], options: {}, suppressions: [] };
    expect(() => expectAllEquivalent([{ spelling: "solo", policy }], 1)).toThrow(/at least two/);
  });

  it("throws when the group's actual size does not match the declared expectedCount — the shrinking-group defect this parameter exists to catch", () => {
    const policy = { depConstraints: [], options: {}, suppressions: [] };
    const members = [
      { spelling: "a", policy },
      { spelling: "b", policy },
      { spelling: "c", policy },
    ];
    // All three members agree with each other — the failure this proves is
    // that agreement among the SURVIVORS is not enough once one spelling has
    // silently dropped out of the array literal a real axis builds.
    expect(() => expectAllEquivalent(members, 4)).toThrow(/expected 4.*received 3/s);
  });

  it("passes over two structurally identical policies, given their true count", () => {
    const policy = { depConstraints: buildLaw().depConstraints, options: {}, suppressions: [] };
    expect(() =>
      expectAllEquivalent(
        [
          { spelling: "a", policy: { ...policy } },
          { spelling: "b", policy: JSON.parse(JSON.stringify(policy)) },
        ],
        2,
      ),
    ).not.toThrow();
  });

  it("throws and names both spellings and the first differing path, over two different policies", () => {
    const base = {
      depConstraints: [],
      options: { enforceBuildableLibDependency: false },
      suppressions: [],
    };
    const mutated = { ...base, options: { enforceBuildableLibDependency: true } };
    expect(() =>
      expectAllEquivalent(
        [
          { spelling: "spelling-a", policy: base },
          { spelling: "spelling-b", policy: mutated },
        ],
        2,
      ),
    ).toThrow(/spelling-a.*spelling-b.*options\.enforceBuildableLibDependency/s);
  });

  it("ignores the notes field — ESLint dialect metadata about which entry bound, not part of the law", () => {
    const policy = { depConstraints: [], options: {}, suppressions: [] };
    expect(() =>
      expectAllEquivalent(
        [
          { spelling: "a", policy: { ...policy, notes: ["entry 3 of 4 bound"] } },
          { spelling: "b", policy: { ...policy } },
        ],
        2,
      ),
    ).not.toThrow();
  });
});

describe("a spelling that fails to load is a failure, not a silent drop to a smaller group", () => {
  it("propagates the loader's rejection rather than continuing with fewer members", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-spelling-load-failure-"));
    try {
      const write = writeIn(root);
      write("module-boundaries.config.mjs", moduleText(buildLaw()));
      // Built the way every axis below builds its own `members` array — one
      // `Promise` per spelling, awaited together. A loader that rejects (a
      // typo'd second path, here) must reject the WHOLE construction, not
      // silently shrink `members` to the spellings that happened to load —
      // the shape `expectAllEquivalent`'s own doc comment warns a caller
      // against, this time on the caller's side of the seam rather than the
      // comparator's.
      const loaders = [
        loadBoundaryConfig(root, "module-boundaries.config.mjs"),
        loadBoundaryConfigFile(join(root, "does-not-exist.mjs")),
      ];
      await expect(Promise.all(loaders)).rejects.toThrow(/cannot load/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// A1 — path source: default location vs an explicit --config
// ---------------------------------------------------------------------------

describe("A1 — path source: the default location and --config pointing at a relocated copy", () => {
  const root = mkdtempSync(join(tmpdir(), "config-spelling-a1-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const write = writeIn(root);
  const law = buildLaw();
  write("nx.json", JSON.stringify({ plugins: [{ plugin: "@ecoma-io/lattice/nx", options: {} }] }));
  write("module-boundaries.config.mjs", moduleText(law));
  // A byte-identical copy at a second path — the "relocated copy" --config
  // points at, so the same TEXT is read through two different routes.
  write("elsewhere/law.mjs", moduleText(law));
  // A deliberately divergent copy: adapter may reach domain too, which
  // erases this fixture's one violation. If --config were silently ignored
  // in favour of the default, a run pointed at this file would still report
  // the default's violation — the silent-ignore this red twin exists to
  // catch.
  write(
    "elsewhere/permissive.mjs",
    moduleText({
      depConstraints: [
        {
          sourceTag: "layer:domain",
          onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"],
        },
        {
          sourceTag: "layer:adapter",
          onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"],
        },
      ],
      moduleBoundaryOptions: law.moduleBoundaryOptions,
    }),
  );
  writeAll(write, SIMPLE_GO_FILES);
  const files = [
    "nx.json",
    "module-boundaries.config.mjs",
    "elsewhere/law.mjs",
    "elsewhere/permissive.mjs",
    ...Object.keys(SIMPLE_GO_FILES),
  ];
  const context = { cwd: root, readGraph: () => twoProjectGraph(), listFiles: () => files };

  it("Tier 1 — the default path and the relocated copy load to the identical policy", async () => {
    // Member 0 goes through `loadBoundaryConfig(root, path)` — the exact
    // route `cli.mjs`'s default (no `--config`) branch takes, by way of
    // `readPluginOptions` — rather than `loadBoundaryConfigFile` a second
    // time. Both members routing through the same file-path loader would
    // never exercise the nx.json-options route at all, so a break there
    // (`loadBoundaryConfig` silently dropping a constraint row Nx's own
    // options plumbing was supposed to carry) would pass this test forever.
    const members = await Promise.all([
      (async () => ({
        spelling: "default location",
        policy: await loadBoundaryConfig(root, "module-boundaries.config.mjs"),
      }))(),
      (async () => ({
        spelling: "--config, relocated copy",
        policy: await loadBoundaryConfigFile(join(root, "elsewhere/law.mjs")),
      }))(),
    ]);
    expectAllEquivalent(members, 2);
  });

  it("Tier 2 — both routes judge the same tree to the same verdict", async () => {
    const viaDefault = await check({ format: "text", config: null, paths: [] }, context);
    const viaConfigFlag = await check(
      { format: "text", config: join(root, "elsewhere/law.mjs"), paths: [] },
      context,
    );
    expect(viaDefault.violations).toBe(1);
    expect(viaConfigFlag.violations).toBe(1);
    // The one axis-specific divergence the policy line is SUPPOSED to carry:
    // the two routes read the identical bytes from two different paths, so
    // the fingerprint must agree while the named source must not.
    const defaultPolicy = splitPolicyLine(viaDefault.report);
    const configFlagPolicy = splitPolicyLine(viaConfigFlag.report);
    expect(defaultPolicy.fingerprint).toBe(configFlagPolicy.fingerprint);
    expect(defaultPolicy.source).toBe("module-boundaries.config.mjs");
    expect(configFlagPolicy.source).toBe("elsewhere/law.mjs");
    expectReportsEqual(
      [
        { spelling: "default location", report: defaultPolicy.rest },
        { spelling: "--config, relocated copy", report: configFlagPolicy.rest },
      ],
      2,
    );
  });

  it("red twin — --config genuinely overrides the default rather than being silently ignored", async () => {
    const viaDefault = await check({ format: "text", config: null, paths: [] }, context);
    const viaDivergentFlag = await check(
      { format: "text", config: join(root, "elsewhere/permissive.mjs"), paths: [] },
      context,
    );
    expect(viaDefault.violations).toBe(1);
    // A --config that were silently ignored would still report 1 here — this
    // is the assertion that catches that silent-ignore direction.
    expect(viaDivergentFlag.violations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A2 — filename: a non-default name declared through nx.json's boundaryConfig
// ---------------------------------------------------------------------------

describe("A2 — filename: a non-default boundaryConfig name changes nothing about the law", () => {
  const defaultRoot = mkdtempSync(join(tmpdir(), "config-spelling-a2-default-"));
  const customRoot = mkdtempSync(join(tmpdir(), "config-spelling-a2-custom-"));
  afterAll(() => {
    rmSync(defaultRoot, { recursive: true, force: true });
    rmSync(customRoot, { recursive: true, force: true });
  });

  const law = buildLaw();

  const writeDefault = writeIn(defaultRoot);
  writeDefault(
    "nx.json",
    JSON.stringify({ plugins: [{ plugin: "@ecoma-io/lattice/nx", options: {} }] }),
  );
  writeDefault("module-boundaries.config.mjs", moduleText(law));
  writeAll(writeDefault, SIMPLE_GO_FILES);
  const defaultFiles = ["nx.json", "module-boundaries.config.mjs", ...Object.keys(SIMPLE_GO_FILES)];

  const writeCustom = writeIn(customRoot);
  writeCustom(
    "nx.json",
    JSON.stringify({
      plugins: [{ plugin: "@ecoma-io/lattice/nx", options: { boundaryConfig: "law/custom.mjs" } }],
    }),
  );
  writeCustom("law/custom.mjs", moduleText(law));
  writeAll(writeCustom, SIMPLE_GO_FILES);
  const customFiles = ["nx.json", "law/custom.mjs", ...Object.keys(SIMPLE_GO_FILES)];

  it("Tier 1 — the default filename and the declared custom filename load to the identical policy", async () => {
    const members = await Promise.all(
      [{ spelling: "default filename" }, { spelling: "declared custom filename" }].map(
        async ({ spelling }, index) => ({
          spelling,
          policy:
            index === 0
              ? await loadBoundaryConfig(defaultRoot, "module-boundaries.config.mjs")
              : await loadBoundaryConfig(customRoot, "law/custom.mjs"),
        }),
      ),
    );
    expectAllEquivalent(members, 2);
  });

  it("Tier 2 — both roots judge the same tree to the same verdict", async () => {
    const viaDefault = await check(
      { format: "text", config: null, paths: [] },
      { cwd: defaultRoot, readGraph: () => twoProjectGraph(), listFiles: () => defaultFiles },
    );
    const viaCustom = await check(
      { format: "text", config: null, paths: [] },
      { cwd: customRoot, readGraph: () => twoProjectGraph(), listFiles: () => customFiles },
    );
    expect(viaDefault.violations).toBe(1);
    expect(viaCustom.violations).toBe(1);
    // Same bargain as A1: identical bytes, two different declared filenames —
    // the fingerprint must agree while the named source must not.
    const defaultPolicy = splitPolicyLine(viaDefault.report);
    const customPolicy = splitPolicyLine(viaCustom.report);
    expect(defaultPolicy.fingerprint).toBe(customPolicy.fingerprint);
    expect(defaultPolicy.source).toBe("module-boundaries.config.mjs");
    expect(customPolicy.source).toBe("law/custom.mjs");
    expectReportsEqual(
      [
        { spelling: "default filename", report: defaultPolicy.rest },
        { spelling: "declared custom filename", report: customPolicy.rest },
      ],
      2,
    );
  });

  it("red twin — a declared filename that does not exist throws instead of silently falling back to the default name", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-spelling-a2-mistyped-"));
    try {
      const write = writeIn(root);
      write(
        "nx.json",
        JSON.stringify({
          plugins: [
            { plugin: "@ecoma-io/lattice/nx", options: { boundaryConfig: "law/custom.mjs" } },
          ],
        }),
      );
      // The conventional name IS present and well-formed — a silent fallback
      // to it would report a clean(ish) tree instead of the "cannot load"
      // this declared, misspelled filename must produce.
      write("module-boundaries.config.mjs", moduleText(law));
      writeAll(write, SIMPLE_GO_FILES);
      const files = ["nx.json", "module-boundaries.config.mjs", ...Object.keys(SIMPLE_GO_FILES)];
      await expect(
        check(
          { format: "text", config: null, paths: [] },
          { cwd: root, readGraph: () => twoProjectGraph(), listFiles: () => files },
        ),
      ).rejects.toThrow(/cannot load/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// A3 — marker: nx.json vs lattice.json
// ---------------------------------------------------------------------------

describe("A3 — marker: the nx.json route and the lattice.json route judge the same tree identically", () => {
  // Under `packageRoot` with the `.oracle-*`-style prefix
  // `differential.integration.test.mjs` already uses (see that file's header
  // and this package's `.gitignore`), rather than the system tmpdir: reused
  // straight from `buildSimpleNxTree`/`buildSimpleNativeTree` below, so this
  // axis's two trees are the SAME builders A2/A3 of the provider
  // differential exercise, not a hand-typed second copy of their shape.
  const nxRoot = mkdtempSync(join(packageRoot, ".oracle-config-spelling-a3-nx-"));
  const nativeRoot = mkdtempSync(join(packageRoot, ".oracle-config-spelling-a3-native-"));
  afterAll(() => {
    rmSync(nxRoot, { recursive: true, force: true });
    rmSync(nativeRoot, { recursive: true, force: true });
  });

  const nxFiles = buildSimpleNxTree(nxRoot);
  const nativeFiles = buildSimpleNativeTree(nativeRoot);

  it("both markers report the identical single violation", async () => {
    const viaNx = await check(
      { format: "text", config: null, paths: [] },
      { cwd: nxRoot, readGraph: () => twoProjectGraph(), listFiles: () => nxFiles },
    );
    // No `readGraph` in the native context — the native path must never
    // reach the Nx seam at all; `cli.integration.test.mjs`'s own native
    // fixture carries the identical omission for the identical reason.
    const viaNative = await check(
      { format: "text", config: null, paths: [] },
      { cwd: nativeRoot, listFiles: () => nativeFiles },
    );
    expect(viaNx.violations).toBe(1);
    expect(viaNative.violations).toBe(1);
    // One expected, provider-specific difference: `buildSimpleNativeTree`
    // exempts its own boundary-config file from coverage (the native model's
    // "every analyzable file must be owned" rule has no Nx equivalent), and
    // `../commands/context.mjs`'s `check` now names that exemption on the
    // summary line. Stripped here, loudly — `toContain` first, so a change to
    // the note's wording fails this test instead of silently widening what
    // "identical" means for every other line.
    const exemptionNote = "; 1 file exempted from coverage by lattice.json's coverage.exempt";
    expect(viaNative.report).toContain(exemptionNote);
    const nativeReportWithoutExemptionNote = viaNative.report.replace(exemptionNote, "");
    expectReportsEqual(
      [
        { spelling: "nx.json marker", report: viaNx.report },
        {
          spelling: "lattice.json marker (exemption note stripped)",
          report: nativeReportWithoutExemptionNote,
        },
      ],
      2,
    );
  });

  it("red twin — a root carrying both markers refuses to run rather than silently picking one", async () => {
    const root = mkdtempSync(join(tmpdir(), "config-spelling-a3-both-markers-"));
    try {
      const write = writeIn(root);
      write(
        "nx.json",
        JSON.stringify({ plugins: [{ plugin: "@ecoma-io/lattice/nx", options: {} }] }),
      );
      write("lattice.json", JSON.stringify({ projects: { declared: [] } }));
      write("module-boundaries.config.mjs", SIMPLE_BOUNDARY_CONFIG);
      await expect(
        check(
          { format: "text", config: null, paths: [] },
          { cwd: root, readGraph: () => twoProjectGraph(), listFiles: () => [] },
        ),
      ).rejects.toThrow(/declares both nx\.json and lattice\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** The literal Nx graph `SIMPLE_GO_FILES`/`SIMPLE_BOUNDARY_CONFIG` imply, injected straight into `check()`'s `readGraph` seam so no fixture in this file has to spawn a real `nx graph` — the "spawn-free comparison through the loaders" this differential is built to be. */
function twoProjectGraph() {
  return {
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
}

// ---------------------------------------------------------------------------
// A4 — dialect: .mjs, .json, ESLint flat config, inline lattice.json object
// ---------------------------------------------------------------------------

describe("A4 — dialect: the same law as .mjs, .json, an ESLint flat config, and an inline lattice.json object", () => {
  const moduleRoot = mkdtempSync(join(tmpdir(), "config-spelling-a4-module-"));
  const jsonRoot = mkdtempSync(join(tmpdir(), "config-spelling-a4-json-"));
  const eslintRoot = mkdtempSync(join(packageRoot, ".config-spelling-a4-eslint-"));
  const inlineRoot = mkdtempSync(join(tmpdir(), "config-spelling-a4-inline-"));
  afterAll(() => {
    rmSync(moduleRoot, { recursive: true, force: true });
    rmSync(jsonRoot, { recursive: true, force: true });
    rmSync(eslintRoot, { recursive: true, force: true });
    rmSync(inlineRoot, { recursive: true, force: true });
  });

  // A4's own law (`buildA4Law`, distinct from `buildLaw`) states
  // `buildTargets` away from the plugin's live default — see that
  // function's own doc comment for why a shared-default law would let a
  // dialect that ignores what it was told pass this axis anyway.
  const law = buildA4Law();

  const writeModule = writeIn(moduleRoot);
  writeModule(
    "nx.json",
    JSON.stringify({ plugins: [{ plugin: "@ecoma-io/lattice/nx", options: {} }] }),
  );
  writeModule("module-boundaries.config.mjs", moduleText(law));
  writeAll(writeModule, SIMPLE_GO_FILES);
  const moduleFiles = ["nx.json", "module-boundaries.config.mjs", ...Object.keys(SIMPLE_GO_FILES)];

  const writeJson = writeIn(jsonRoot);
  writeJson(
    "nx.json",
    JSON.stringify({
      plugins: [{ plugin: "@ecoma-io/lattice/nx", options: { boundaryConfig: "policy.json" } }],
    }),
  );
  writeJson("policy.json", jsonText(law));
  writeAll(writeJson, SIMPLE_GO_FILES);
  const jsonFiles = ["nx.json", "policy.json", ...Object.keys(SIMPLE_GO_FILES)];

  const writeEslint = writeIn(eslintRoot);
  writeEslint(
    "nx.json",
    JSON.stringify({
      plugins: [
        { plugin: "@ecoma-io/lattice/nx", options: { boundaryConfig: "eslint.config.mjs" } },
      ],
    }),
  );
  writeEslint("eslint.config.mjs", eslintText(law));
  writeAll(writeEslint, SIMPLE_GO_FILES);
  const eslintFiles = ["nx.json", "eslint.config.mjs", ...Object.keys(SIMPLE_GO_FILES)];

  const writeInline = writeIn(inlineRoot);
  writeInline(
    "lattice.json",
    JSON.stringify({
      projects: {
        declared: [
          { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
          { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
        ],
      },
      boundaryConfig: {
        depConstraints: law.depConstraints,
        moduleBoundaryOptions: law.moduleBoundaryOptions,
      },
    }),
  );
  writeAll(writeInline, SIMPLE_GO_FILES);
  const inlineFiles = ["lattice.json", ...Object.keys(SIMPLE_GO_FILES)];

  it("Tier 1 — all four dialects load to the identical policy", async () => {
    const members = await Promise.all(
      [
        {
          spelling: "module (.mjs)",
          loader: loadBoundaryConfig(moduleRoot, "module-boundaries.config.mjs"),
        },
        { spelling: "json (.json)", loader: loadBoundaryConfig(jsonRoot, "policy.json") },
        {
          spelling: "eslint (flat config)",
          loader: loadBoundaryConfigFile(join(eslintRoot, "eslint.config.mjs")),
        },
        {
          spelling: "inline (lattice.json)",
          loader: Promise.resolve(
            policyFrom(
              {
                depConstraints: law.depConstraints,
                moduleBoundaryOptions: law.moduleBoundaryOptions,
              },
              "inline lattice.json boundaryConfig",
            ),
          ),
        },
      ].map(async ({ spelling, loader }) => ({ spelling, policy: await loader })),
    );
    expectAllEquivalent(members, 4);
  });

  it("Tier 2 — all four dialects judge the same tree to the identical verdict", async () => {
    const results = await Promise.all([
      check(
        { format: "text", config: null, paths: [] },
        { cwd: moduleRoot, readGraph: () => twoProjectGraph(), listFiles: () => moduleFiles },
      ),
      check(
        { format: "text", config: null, paths: [] },
        { cwd: jsonRoot, readGraph: () => twoProjectGraph(), listFiles: () => jsonFiles },
      ),
      check(
        { format: "text", config: null, paths: [] },
        { cwd: eslintRoot, readGraph: () => twoProjectGraph(), listFiles: () => eslintFiles },
      ),
      check(
        { format: "text", config: null, paths: [] },
        { cwd: inlineRoot, listFiles: () => inlineFiles },
      ),
    ]);
    for (const result of results) {
      expect(result.violations).toBe(1);
    }
    const [moduleResult, jsonResult, eslintResult, inlineResult] = results;
    // Four dialects, four different sources by construction — a `.mjs`
    // filename, a `.json` filename, an ESLint flat config's filename, and
    // (the inline object has no file of its own) `lattice.json` itself — so
    // the fingerprint is the one fact across all four that must still agree,
    // proving the SAME effective policy even more precisely than Tier 1's
    // parsed-object comparison: the exact bytes this run actually hashed.
    const modulePolicy = splitPolicyLine(moduleResult.report);
    const jsonPolicy = splitPolicyLine(jsonResult.report);
    const eslintPolicy = splitPolicyLine(eslintResult.report);
    const inlinePolicy = splitPolicyLine(inlineResult.report);
    expect(modulePolicy.source).toBe("module-boundaries.config.mjs");
    expect(jsonPolicy.source).toBe("policy.json");
    expect(eslintPolicy.source).toBe("eslint.config.mjs");
    expect(inlinePolicy.source).toBe("lattice.json");
    const fingerprints = new Set([
      modulePolicy.fingerprint,
      jsonPolicy.fingerprint,
      eslintPolicy.fingerprint,
      inlinePolicy.fingerprint,
    ]);
    expect(fingerprints.size).toBe(1);
    expectReportsEqual(
      [
        { spelling: "module (.mjs)", report: modulePolicy.rest },
        { spelling: "json (.json)", report: jsonPolicy.rest },
        { spelling: "eslint (flat config)", report: eslintPolicy.rest },
        { spelling: "inline (lattice.json)", report: inlinePolicy.rest },
      ],
      4,
    );
  });

  it("red twin — a .json spelling missing one constraint row is caught, naming the row", async () => {
    const shrunkRoot = mkdtempSync(join(tmpdir(), "config-spelling-a4-shrunk-"));
    try {
      const write = writeIn(shrunkRoot);
      // The adapter row dropped entirely — a dialect that "loads" but is
      // smaller than what was written, the exact silent shape this whole
      // differential exists to catch.
      write(
        "policy.json",
        JSON.stringify({
          depConstraints: [law.depConstraints[0]],
          moduleBoundaryOptions: law.moduleBoundaryOptions,
        }),
      );
      const members = await Promise.all(
        [
          {
            spelling: "module (.mjs), full law",
            loader: loadBoundaryConfig(moduleRoot, "module-boundaries.config.mjs"),
          },
          {
            spelling: "json, adapter row dropped",
            loader: loadBoundaryConfig(shrunkRoot, "policy.json"),
          },
        ].map(async ({ spelling, loader }) => ({ spelling, policy: await loader })),
      );
      expect(() => expectAllEquivalent(members, 2)).toThrow(
        /module \(\.mjs\), full law.*json, adapter row dropped.*depConstraints\[1\]/s,
      );
    } finally {
      rmSync(shrunkRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// A5 — the law's home: unstated ESLint options, and the suppression gap
// ---------------------------------------------------------------------------

describe("A5 — the law's home", () => {
  const moduleRoot = mkdtempSync(join(tmpdir(), "config-spelling-a5-module-"));
  const eslintRoot = mkdtempSync(join(packageRoot, ".config-spelling-a5-eslint-"));
  afterAll(() => {
    rmSync(moduleRoot, { recursive: true, force: true });
    rmSync(eslintRoot, { recursive: true, force: true });
  });

  const law = buildLaw();

  writeIn(moduleRoot)("module-boundaries.config.mjs", moduleText(law));
  writeIn(eslintRoot)("eslint.config.mjs", eslintTextDepConstraintsOnly(law));

  it("(a) an ESLint option left unstated equals the module dialect stating it at the real, live-read plugin default", async () => {
    const members = await Promise.all(
      [
        {
          spelling: "module (.mjs), every option stated",
          loader: loadBoundaryConfig(moduleRoot, "module-boundaries.config.mjs"),
        },
        {
          spelling: "eslint, only depConstraints stated",
          loader: loadBoundaryConfigFile(join(eslintRoot, "eslint.config.mjs")),
        },
      ].map(async ({ spelling, loader }) => ({ spelling, policy: await loader })),
    );
    expectAllEquivalent(members, 2);
  });

  it("(a) red twin — the module dialect stating an option AWAY from the live default disagrees with the ESLint dialect leaving it unstated", async () => {
    const skewedRoot = mkdtempSync(join(tmpdir(), "config-spelling-a5-skewed-"));
    try {
      const skewedLaw = {
        ...law,
        moduleBoundaryOptions: {
          ...law.moduleBoundaryOptions,
          enforceBuildableLibDependency: !law.moduleBoundaryOptions.enforceBuildableLibDependency,
        },
      };
      writeIn(skewedRoot)("module-boundaries.config.mjs", moduleText(skewedLaw));
      const members = await Promise.all(
        [
          {
            spelling: "module (.mjs), option skewed off the live default",
            loader: loadBoundaryConfig(skewedRoot, "module-boundaries.config.mjs"),
          },
          {
            spelling: "eslint, option left unstated (real default)",
            loader: loadBoundaryConfigFile(join(eslintRoot, "eslint.config.mjs")),
          },
        ].map(async ({ spelling, loader }) => ({ spelling, policy: await loader })),
      );
      expect(() => expectAllEquivalent(members, 2)).toThrow(
        /options\.enforceBuildableLibDependency/,
      );
    } finally {
      rmSync(skewedRoot, { recursive: true, force: true });
    }
  });

  it("(b) a suppression the .mjs dialect declares has no ESLint counterpart — a documented, structural gap the comparator does not paper over", async () => {
    const suppressingRoot = mkdtempSync(join(tmpdir(), "config-spelling-a5-suppressing-"));
    try {
      const write = writeIn(suppressingRoot);
      const suppressingLaw = `export const depConstraints = ${JSON.stringify(law.depConstraints)};
export const moduleBoundaryOptions = ${JSON.stringify(law.moduleBoundaryOptions)};
export const boundarySuppressions = [
  { path: "libs/domain/**", reason: "tracked in a follow-up, accepted for now" },
];
`;
      write("module-boundaries.config.mjs", suppressingLaw);
      const mjsPolicy = await loadBoundaryConfig(suppressingRoot, "module-boundaries.config.mjs");
      const eslintPolicy = await loadBoundaryConfigFile(join(eslintRoot, "eslint.config.mjs"));

      // The gap this sub-case exists to pin: the .mjs dialect's suppression
      // really loaded (non-empty)...
      expect(mjsPolicy.suppressions).toEqual([
        { path: "libs/domain/**", reason: "tracked in a follow-up, accepted for now" },
      ]);
      // ...while the ESLint dialect always reports none — ESLint has its own
      // `eslint-disable` convention with no equivalent this reader can read
      // back (`./config.mjs`'s header, "Three dialects, one validator, one
      // dispatch"), never a value this loader silently drops.
      expect(eslintPolicy.suppressions).toEqual([]);

      // And the comparator does not quietly equate the two despite that —
      // if it did, a real dropped suppression elsewhere would read as
      // agreement too. `expectAllEquivalent` strips only `notes`; it has no
      // special case for `suppressions`, so this MUST throw.
      expect(() =>
        expectAllEquivalent(
          [
            { spelling: "module (.mjs), with a suppression", policy: mjsPolicy },
            { spelling: "eslint (no suppression counterpart)", policy: eslintPolicy },
          ],
          2,
        ),
      ).toThrow(/suppressions/);
    } finally {
      rmSync(suppressingRoot, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from "vitest";

import { judgeTsconfigPaths, TSCONFIG_PATHS_MESSAGE_IDS } from "./tsconfig-paths.mjs";

/**
 * A judgement over an in-memory tree: `existing` lists the workspace-relative
 * directories that exist (`""` is the root, always present the way a real
 * workspace root is), and everything else does not. Facts as arguments, so no
 * filesystem — the same bargain `compareGoWork`'s tests strike.
 */
const judge = (paths, existing, overrides = {}) =>
  judgeTsconfigPaths({
    paths,
    base: "/repo/acme",
    workspaceRoot: "/repo/acme",
    tsConfig: "tsconfig.base.json",
    directoryExists: (dir) => new Set(["", ...existing]).has(dir),
    ...overrides,
  });

describe("judging the alias table", () => {
  it("reports an alias whose every target's directory is gone — the silent half nothing else notices", () => {
    // The silent direction. A judgement that returned [] here would leave the
    // one state this check exists to end invisible: every import of the alias
    // either breaks the build or silently resolves to node_modules, and no
    // other layer ever reads the table to say so.
    const { findings, aliases } = judge({ "@acme/lib": ["libs/lib/src/index.ts"] }, ["libs"]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      messageId: "tsconfigDeadPathAlias",
      file: "tsconfig.base.json",
      line: null,
      column: null,
      alias: "@acme/lib",
      targets: ["libs/lib/src/index.ts"],
    });
    expect(findings[0].message).toContain('"@acme/lib"');
    expect(findings[0].message).toContain("libs/lib/src/");
    expect(aliases).toBe(1);
  });

  it("stays quiet while any one target's directory survives — one live target keeps the alias", () => {
    const { findings, aliases } = judge(
      { "@acme/lib": ["libs/gone/src/index.ts", "libs/lib/src/index.ts"] },
      ["libs", "libs/lib", "libs/lib/src"],
    );
    expect(findings).toEqual([]);
    expect(aliases).toBe(1);
  });

  it("does not report a missing file whose directory still exists — that verdict would need the second resolver", () => {
    // The stated limit, pinned: with `libs/lib/src/` present, TypeScript still
    // probes `index.tsx`, `index.d.ts`, `index.js` and more for this target
    // (module header), so "the exact file is gone" does not prove death.
    const { findings } = judge({ "@acme/lib": ["libs/lib/src/index.ts"] }, [
      "libs",
      "libs/lib",
      "libs/lib/src",
    ]);
    expect(findings).toEqual([]);
  });

  it("judges a wildcard alias by its target's static prefix directory", () => {
    // Dead when the directory before the `*` is gone — every substituted
    // candidate lives under it — and alive the moment it exists, whatever is
    // or is not inside: what a matching specifier substitutes cannot be known
    // without resolving specifiers.
    const table = { "@acme/*": ["libs/*/src/index.ts"] };
    expect(judge(table, []).findings).toHaveLength(1);
    expect(judge(table, ["libs"]).findings).toEqual([]);
  });

  it("reads a prefix ending in '/' as that directory itself, not its parent", () => {
    // `generated/models/*` must probe `generated/models`, not `generated`: a
    // judgement off by one level would call the alias alive because the parent
    // survives, which is the silent direction.
    const table = { "@acme/models/*": ["generated/models/*"] };
    expect(judge(table, ["generated"]).findings).toHaveLength(1);
    expect(judge(table, ["generated", "generated/models"]).findings).toEqual([]);
  });

  it("resolves targets against the base the resolver uses, not against the root by fiat", () => {
    // With `baseUrl` set, `ts.resolveModuleName` joins targets to it
    // (measured, module header); judging the same target against the config's
    // directory instead would probe the wrong tree in both directions.
    const table = { "@acme/lib": ["lib/index.ts"] };
    const withBase = (existing) => judge(table, existing, { base: "/repo/acme/src" });
    expect(withBase(["src", "src/lib"]).findings).toEqual([]);
    expect(withBase(["lib"]).findings).toHaveLength(1);
  });

  it("reports an alias with an empty target list — mapped to nothing is dead, not absent", () => {
    const { findings, aliases } = judge({ "@acme/lib": [] }, ["libs"]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ alias: "@acme/lib", targets: [] });
    expect(findings[0].message).toContain("empty target list");
    expect(aliases).toBe(1);
  });

  it("judges a bare-root target ('*' or a file at the root) against the root itself", () => {
    const { findings, aliases } = judge({ "@acme/*": ["*"], shim: ["shim.d.ts"] }, []);
    // "" — the workspace root — always exists here, so both stay alive.
    expect(findings).toEqual([]);
    expect(aliases).toBe(2);
  });

  it("substitutes only the first star of a multi-star TARGET, so the prefix before it still decides", () => {
    // Measured (module header): TypeScript replaces the first `*` and leaves
    // later stars literal, so every candidate stays under `libs/`.
    const table = { "@acme/*": ["libs/*/src/*.ts"] };
    expect(judge(table, ["libs"]).findings).toEqual([]);
    expect(judge(table, []).findings).toHaveLength(1);
  });
});

describe("what the judgement refuses to judge", () => {
  it("counts a multi-star PATTERN as unjudged, dead targets or not — TypeScript ignores the alias entirely", () => {
    // Measured (module header): zero candidate probes even for a specifier
    // shaped to match, so calling it dead would report an alias TypeScript
    // never consults, and calling it alive would claim coverage nothing has.
    const { findings, aliases, unjudged } = judge({ "@acme/*/*": ["libs/gone/index.ts"] }, []);
    expect(findings).toEqual([]);
    expect(aliases).toBe(0);
    expect(unjudged).toBe(1);
  });

  it("counts an alias with a target outside the workspace as unjudged, never dead", () => {
    const outside = {
      "@acme/sibling": ["../sibling-checkout/src/index.ts"],
      "@acme/abs": ["/opt/elsewhere/lib.ts"],
    };
    const { findings, aliases, unjudged } = judge(outside, []);
    expect(findings).toEqual([]);
    expect(aliases).toBe(0);
    expect(unjudged).toBe(2);
  });

  it("keeps a dead verdict blocked by ONE outside target even when the inside targets are gone", () => {
    // The outside target may well hit a file; claiming death anyway would be a
    // guessed record, which the ground rule forbids.
    const { findings, unjudged } = judge(
      { "@acme/lib": ["libs/gone/index.ts", "../elsewhere/index.ts"] },
      [],
    );
    expect(findings).toEqual([]);
    expect(unjudged).toBe(1);
  });

  it("still judges the well-formed aliases beside ones it refuses, neither masking the other", () => {
    const { findings, aliases, unjudged, malformed } = judge(
      {
        "@acme/dead": ["libs/gone/index.ts"],
        "@acme/*/*": ["libs/thing/index.ts"],
        "@acme/broken": "libs/lib/index.ts",
      },
      ["libs"],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].alias).toBe("@acme/dead");
    expect(aliases).toBe(1);
    expect(unjudged).toBe(1);
    expect(malformed).toHaveLength(1);
  });
});

describe("refusing a paths table it cannot read", () => {
  // The silent direction, pinned per shape: TypeScript's config parse accepts
  // both of these without a diagnostic (module header), so a judgement that
  // skipped them quietly would read a broken table as a clean one. They must
  // come back in `malformed` for the caller to refuse loudly — and produce no
  // finding, because a guessed verdict is the other half of the same defect.
  /** @type {[string, Record<string, unknown>][]} */
  const shapes = [
    ["a value that is not an array", { "@acme/lib": "libs/lib/src/index.ts" }],
    ["a target list with a non-string entry", { "@acme/lib": [42] }],
  ];

  it.each(shapes)("returns %s as malformed, naming the alias, with no verdict", (_shape, paths) => {
    const { findings, aliases, malformed } = judge(paths, ["libs", "libs/lib", "libs/lib/src"]);
    expect(findings).toEqual([]);
    expect(aliases).toBe(0);
    expect(malformed).toHaveLength(1);
    expect(malformed[0].alias).toBe("@acme/lib");
    expect(malformed[0].reason).toContain("tsconfig.base.json");
    expect(malformed[0].reason).toContain('"@acme/lib"');
    expect(malformed[0].reason).toContain("no verdict");
  });
});

describe("the message table", () => {
  it("has an id for every finding kind the judgement can produce, and no orphans", () => {
    // `report/sarif.mjs` derives its rule catalogue from this list; an id the
    // judgement emits but the table lacks would be a nameless finding in a
    // code-scanning upload.
    expect([...TSCONFIG_PATHS_MESSAGE_IDS]).toEqual(["tsconfigDeadPathAlias"]);
  });
});

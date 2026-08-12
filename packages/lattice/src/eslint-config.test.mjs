// Unit tests for the pure half of the ESLint flat-config dialect:
// `extractBoundaryRule`, driven entirely over in-memory flat-config arrays, no
// filesystem and no real `@nx/eslint-plugin` involved. `eslint-config.integration.test.mjs`
// covers `loadEslintBoundaryConfig`, which needs both of those for real.
//
// The cases below are picked from the SILENT-direction failure each guards
// against — `AGENTS.md`'s invariant is that a code path unable to reach a
// verdict must say so loudly rather than approve everything, so every case
// here is a shape that, unhandled, would have this reader hand back an empty
// or wrong constraint table instead of refusing.
import { describe, expect, it } from "vitest";

import { extractBoundaryRule } from "./eslint-config.mjs";

const entryOf = (value, files) =>
  files === undefined
    ? { rules: { "@nx/enforce-module-boundaries": value } }
    : { rules: { "@nx/enforce-module-boundaries": value }, files };

describe("extractBoundaryRule", () => {
  it("takes the LAST unscoped configuring entry, as ESLint binds it", () => {
    const first = { rules: { "@nx/enforce-module-boundaries": ["error", { allow: ["^a$"] }] } };
    const last = {
      rules: {
        "@nx/enforce-module-boundaries": [
          "error",
          { depConstraints: [{ sourceTag: "x", onlyDependOnLibsWithTags: ["y"] }] },
        ],
      },
    };
    const { depConstraints, options } = extractBoundaryRule([first, {}, last]);
    expect(depConstraints).toHaveLength(1);
    expect(options).toEqual({});
  });

  it("refuses a config whose default export is not a flat-config array", () => {
    expect(() => extractBoundaryRule(/** @type {any} */ ({ rules: {} }))).toThrow(
      /not a flat-config array/,
    );
    expect(() => extractBoundaryRule(undefined)).toThrow(/not a flat-config array/);
    expect(() => extractBoundaryRule(async () => [])).toThrow(/not a flat-config array/);
  });

  it("refuses a config with no @nx/enforce-module-boundaries entry at all — absent is not empty", () => {
    // The silent-direction case: an absent rule must not read as "an empty,
    // fully-permissive table" — that is indistinguishable from a workspace
    // that intentionally enforces nothing.
    expect(() => extractBoundaryRule([{ rules: {} }])).toThrow(/no @nx\/enforce-module-boundaries/);
    expect(() => extractBoundaryRule([{}])).toThrow(/no @nx\/enforce-module-boundaries/);
  });

  it("refuses a rule switched off, rather than reading it as an empty table", () => {
    expect(() => extractBoundaryRule([entryOf("off")])).toThrow(/switched off/);
    expect(() => extractBoundaryRule([entryOf(0)])).toThrow(/switched off/);
    expect(() => extractBoundaryRule([entryOf(["off", { depConstraints: [] }])])).toThrow(
      /switched off/,
    );
  });

  it("loads an off-then-on pair using the ON entry's table, not the earlier off severity (B3)", () => {
    // `parseRuleValue` must be called exactly once, on the entry that BINDS —
    // never mapped over every matching entry. An earlier off entry never
    // configured anything ESLint would actually run with, and must not be
    // able to refuse a run over a later entry that is itself perfectly valid.
    const off = entryOf("off");
    const on = entryOf(["error", { depConstraints: [{ sourceTag: "x" }] }]);
    const { depConstraints } = extractBoundaryRule([off, on]);
    expect(depConstraints).toEqual([{ sourceTag: "x" }]);
  });

  it("refuses a severity string this reader does not recognise, rather than treating it as on", () => {
    expect(() => extractBoundaryRule([entryOf("critical")])).toThrow(/severity/);
    expect(() => extractBoundaryRule([entryOf(3)])).toThrow(/severity/);
  });

  it("refuses options that are not an object", () => {
    expect(() => extractBoundaryRule([entryOf(["error", ["not", "an", "object"]])])).toThrow(
      /options must be an object/,
    );
  });

  it("refuses a non-plain-object flat-config element BY INDEX rather than skipping it (B2)", () => {
    // Flat config permits composing configs by nesting arrays, flattened by
    // ESLint's own loader before any rule runs. A nested array carrying the
    // REAL configuring entry must throw, not silently skip past it and bind
    // an earlier, already-matched entry as if the real one did not exist —
    // that would be the confident-wrong answer this whole reader exists to
    // avoid.
    const stale = entryOf(["error", { depConstraints: [{ sourceTag: "stale" }] }]);
    const nested = [entryOf(["error", { depConstraints: [{ sourceTag: "real" }] }])];
    expect(() => extractBoundaryRule([stale, nested])).toThrow(/flatConfig\[1\] is an array/);
  });

  it("refuses a function flat-config element by index (B2)", () => {
    expect(() => extractBoundaryRule([() => ({})])).toThrow(/flatConfig\[0\] is a function/);
  });

  it("refuses a flat-config element carrying an 'extends' key (B2)", () => {
    const withExtends = { extends: ["some-preset"], rules: {} };
    expect(() => extractBoundaryRule([withExtends])).toThrow(
      /flatConfig\[0\] carries an 'extends' key/,
    );
  });

  it("refuses an 'extends'-carrying element even when a later plain element also configures the rule (B2)", () => {
    // The refusal fires while walking the array, before the winning entry is
    // even chosen — an extends-carrying element earlier in the array must not
    // be silently skipped past to reach a later entry that does parse cleanly.
    const withExtends = { extends: ["some-preset"], rules: {} };
    const real = entryOf(["error", { depConstraints: [] }]);
    expect(() => extractBoundaryRule([withExtends, real])).toThrow(/carries an 'extends' key/);
  });

  it("refuses a bare severity with no options at all — no depConstraints key stated (S1)", () => {
    // A bare severity has no options object, so it has no `depConstraints` key
    // either — reading that as "an empty, fully-permissive table" is exactly
    // the silent-direction confusion the SPEC calls out: a rule that is on but
    // never said what it enforces must not report a clean tree.
    expect(() => extractBoundaryRule([entryOf("error")])).toThrow(/no depConstraints key stated/);
  });

  it("refuses an entry that is on, with an options object, but no depConstraints key — message distinct from 'switched off'", () => {
    expect(() => extractBoundaryRule([entryOf(["error", { allow: ["^a$"] }])])).toThrow(
      /no depConstraints key stated/,
    );
    // The two refusals must not read as the same problem: one is a rule that
    // never ran, the other is a rule that ran but never said what it enforces.
    expect(() => extractBoundaryRule([entryOf(["error", { allow: ["^a$"] }])])).not.toThrow(
      /switched off/,
    );
  });

  it("refuses an entry scoped under files — a per-glob law this reader cannot express", () => {
    const scoped = entryOf(["error", { depConstraints: [] }], ["apps/**"]);
    expect(() => extractBoundaryRule([scoped])).toThrow(/files/);
  });

  it("still refuses the files-scoped entry even when it is the LAST entry, not just when it is the only one", () => {
    const unscoped = entryOf(["error", { depConstraints: [] }]);
    const scoped = entryOf(["error", { depConstraints: [] }], ["apps/**"]);
    expect(() => extractBoundaryRule([unscoped, scoped])).toThrow(/files/);
  });

  it("still refuses a files scope with a directory component even when every glob also carries a bare extension (B1)", () => {
    // `apps/**/*.ts` states BOTH a directory and an extension — the directory
    // component is what makes this a per-directory law, and the presence of
    // an extension does not soften that; only a scope with NO directory
    // component at all is read as language-only (see the next test).
    const scoped = entryOf(["error", { depConstraints: [] }], ["apps/**/*.ts"]);
    expect(() => extractBoundaryRule([scoped])).toThrow(/files/);
  });

  it("accepts the canonical `nx g @nx/eslint` files scope — every glob a bare source-extension pattern (B1)", () => {
    // The exact shape `nx g @nx/eslint` emits and both pinned real trees
    // `scripts/differential-real-trees.mjs` drives carry: no directory
    // component anywhere, so it states which languages ESLint parses, not
    // which part of the tree the law covers — accepted tree-wide, with a note
    // recording the binding rather than a silent guess.
    const scoped = entryOf(
      ["error", { depConstraints: [{ sourceTag: "x", onlyDependOnLibsWithTags: ["y"] }] }],
      ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
    );
    const { depConstraints, note } = extractBoundaryRule([scoped]);
    expect(depConstraints).toHaveLength(1);
    expect(note).toMatch(/scopes @nx\/enforce-module-boundaries under files/);
  });

  it("does NOT refuse two differing unscoped entries — it binds the last and says so", () => {
    const first = entryOf(["error", { allow: ["^a$"] }]);
    const last = entryOf([
      "error",
      { depConstraints: [{ sourceTag: "x", allSourceTags: undefined }] },
    ]);
    const result = extractBoundaryRule([first, last]);
    expect(result.note).toMatch(/last of 2 entries setting the rule/);
  });

  it("adds no note when a single entry configures the rule", () => {
    const { note } = extractBoundaryRule([entryOf(["error", { depConstraints: [] }])]);
    expect(note).toBeUndefined();
  });

  it("adds no note when multiple entries configure the rule identically", () => {
    const value = ["error", { depConstraints: [] }];
    const { note } = extractBoundaryRule([entryOf(value), entryOf(value)]);
    expect(note).toBeUndefined();
  });
});

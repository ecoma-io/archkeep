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

const entryWithIgnores = (value, ignores) => ({
  rules: { "@nx/enforce-module-boundaries": value },
  ignores,
});

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

  it("falls back to the most recent earlier entry's options when the winning entry states only a severity (B4)", () => {
    // ESLint's own flat-config merge (measured against eslint 10.8.0's
    // FlatConfigArray, `Linter.getConfig`): a later entry that states only a
    // severity does NOT clear the options an earlier entry stated for the
    // same rule — it retains them and merges only the severity forward.
    // Before the fix, extractBoundaryRule parsed ONLY `matches[matches.length
    // - 1]`, so `[["error", {depConstraints: T}], "warn"]` wrongly threw "no
    // depConstraints key stated" for a config ESLint is actively enforcing
    // under table T — the silent-direction failure: a real, running
    // constraint table refused as if it were absent.
    const table = [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:util"] }];
    const withOptions = entryOf(["error", { depConstraints: table }]);
    const severityOnly = entryOf("warn");
    const { depConstraints, note } = extractBoundaryRule([withOptions, severityOnly]);
    expect(depConstraints).toEqual(table);
    expect(note).toMatch(/states only a severity/);
  });

  it("still refuses a severity-only winning entry when no earlier entry ever stated options (B4)", () => {
    // The fallback must not manufacture a table out of nothing — with no
    // earlier options-bearing entry to fall back to, this is still the S1
    // refusal.
    expect(() => extractBoundaryRule([entryOf("warn")])).toThrow(/no depConstraints key stated/);
  });

  it("does not fall back when the winning entry states its own options — its table wins outright (B4)", () => {
    const first = entryOf(["error", { depConstraints: [{ sourceTag: "first" }] }]);
    const last = entryOf(["warn", { depConstraints: [{ sourceTag: "last" }] }]);
    const { depConstraints, note } = extractBoundaryRule([first, last]);
    expect(depConstraints).toEqual([{ sourceTag: "last" }]);
    expect(note).not.toMatch(/states only a severity/);
  });

  it("refuses an entry carrying a non-empty ignores instead of silently binding tree-wide with it dropped (B5)", () => {
    // Unlike `files`, `ignores` names a set of paths by construction — there
    // is no bare-extension shape of it that states languages rather than
    // territory. Before the fix, `item.ignores` was never read: this entry
    // bound tree-wide with `note: undefined`, the exclusion silently gone.
    const scoped = entryWithIgnores(["error", { depConstraints: [] }], ["apps/legacy/**"]);
    expect(() => extractBoundaryRule([scoped])).toThrow(/ignores/);
  });

  it("refuses an ignores-scoped entry even when its files is the accepted bare-extension shape (B5)", () => {
    const scoped = {
      rules: { "@nx/enforce-module-boundaries": ["error", { depConstraints: [] }] },
      files: ["**/*.ts"],
      ignores: ["apps/legacy/**"],
    };
    expect(() => extractBoundaryRule([scoped])).toThrow(/ignores/);
  });

  it("does not refuse an entry whose ignores is an empty array — no exclusion actually stated", () => {
    const entry = entryWithIgnores(["error", { depConstraints: [] }], []);
    expect(() => extractBoundaryRule([entry])).not.toThrow();
  });

  it("binds an ignores-scoped entry tree-wide under the explicit opt-in, and says so in the note", () => {
    // The one caller shape the opt-in exists for: a differential handing this
    // table identically to every engine it compares. This is ng-doc's real
    // entry shape at the sha `scripts/differential-real-trees.mjs` pins —
    // bare-extension files plus a non-empty ignores — which the default
    // rightly refuses for an enforcer.
    const scoped = {
      rules: {
        "@nx/enforce-module-boundaries": [
          "error",
          { depConstraints: [{ sourceTag: "x", onlyDependOnLibsWithTags: ["y"] }] },
        ],
      },
      files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
      ignores: ["**/__mocks__/**"],
    };
    const { depConstraints, note } = extractBoundaryRule([scoped], {
      pathScoped: "bind-tree-wide",
    });
    expect(depConstraints).toEqual([{ sourceTag: "x", onlyDependOnLibsWithTags: ["y"] }]);
    // The note is the load-bearing half: a scope dropped with no record is the
    // silent drop the default refusal exists to prevent, so the opt-in without
    // a note would be that same bug wearing an option's name.
    expect(note).toMatch(/ignores: \["\*\*\/__mocks__\/\*\*"\]/);
    expect(note).toMatch(/bound tree-wide/);
  });

  it("binds a directory-files-scoped entry tree-wide under the opt-in, note naming the files glob", () => {
    const scoped = entryOf(["error", { depConstraints: [] }], ["apps/legacy/**/*.ts"]);
    const { note } = extractBoundaryRule([scoped], { pathScoped: "bind-tree-wide" });
    expect(note).toMatch(/files: \["apps\/legacy\/\*\*\/\*\.ts"\]/);
    expect(note).toMatch(/bound tree-wide/);
  });

  it("still applies last-wins under the opt-in — the mode widens the pool, not the binding rule", () => {
    const scoped = entryWithIgnores(
      ["error", { depConstraints: [{ sourceTag: "scoped" }] }],
      ["**/__mocks__/**"],
    );
    const unscopedLast = entryOf(["error", { depConstraints: [{ sourceTag: "last" }] }]);
    const { depConstraints, note } = extractBoundaryRule([scoped, unscopedLast], {
      pathScoped: "bind-tree-wide",
    });
    expect(depConstraints).toEqual([{ sourceTag: "last" }]);
    // The winning entry is unscoped, so no scope was dropped and no
    // scope-drop sentence may claim one was.
    expect(note ?? "").not.toMatch(/bound tree-wide/);
  });

  it("refuses a pathScoped mode it does not define, rather than reading it as the default", () => {
    const entry = entryOf(["error", { depConstraints: [] }]);
    expect(() =>
      extractBoundaryRule([entry], { pathScoped: /** @type {any} */ ("bind-scoped") }),
    ).toThrow(/pathScoped/);
  });
});

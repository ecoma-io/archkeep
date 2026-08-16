import { describe, expect, it } from "vitest";

import { findIntentViolations, loadIntent } from "./model.mjs";
import { judgeIntent } from "./judge.mjs";

/**
 * A seeded, dependency-free property sweep over `findIntentViolations` — no
 * fast-check, no new devDependency. Two properties are load-bearing and each
 * needs a sweep, because a unit test pins one chosen input and an engine that
 * throws on the 500th unforeseen one stays green until that one arrives for
 * real:
 *
 *   - **Total and never throws.** The validator takes values straight from
 *     `JSON.parse` — input shaped by whoever committed the file — so it must
 *     return an array of messages for *any* value and never throw: a throw is
 *     a crash that a caller reads as an empty report, which is the silent
 *     direction.
 *   - **Deterministic.** Same input, same verdict — byte-identical, twice. A
 *     validator that is nondeterministic makes the whole governance verdict
 *     nondeterministic, and a check that disagrees with itself cannot be
 *     believed by CI.
 *
 * A third, smaller sweep drives the same files through `loadIntent` +
 * `judgeIntent` and asserts that chain only ever produces a verdict (three
 * possible values, no throw).
 */

/** Mulberry32 — tiny, reproducible, no dependency. `seed` keeps the run stable across machines. */
const makeRandom = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = (random, list) => list[Math.floor(random() * list.length)];

/** Selectors that pass `isValidSelector`. Bare names double as row sides. */
const validSelectors = [
  "name:core",
  "tag:type-package",
  "tag:type-extension",
  "directory:packages/core",
  "*",
  "core",
  "ui",
  "site",
];

/** Selectors that fail `isValidSelector` — the mutation half of the sweep. */
const invalidSelectors = ["tagz:type-package", "scop:core", "name:", "tag:", "!", "name:a b"];

const jsonable = (value) => JSON.parse(JSON.stringify(value));

/**
 * A structurally valid intent file: unique `b0..bN` boundaries, rows whose
 * sides are bare project names (valid selectors, so never an undeclared
 * reference and never the forbidden self-ban), a `reason` on forbidden rows,
 * and at most one list per file so rule 7 never fires by construction.
 */
const validFile = (random) => {
  const boundaries = [];
  const count = 1 + Math.floor(random() * 3);
  for (let i = 0; i < count; i++) {
    boundaries.push({ name: `b${i}`, match: [pick(random, validSelectors)] });
  }
  const file = { version: "1", boundaries };
  const mode = Math.floor(random() * 3); // 0 allowed · 1 forbidden · 2 neither
  if (mode === 0) {
    // Both sides are bare project names — valid selectors, no self-ban, and
    // the optional flag flips so the note branch is swept too.
    file.allowed = [{ from: "core", to: "ui", ...(random() < 0.5 ? { optional: true } : {}) }];
  } else if (mode === 1) {
    file.forbidden = [
      // `to: "site"` is a bare name; `site` is a valid selector, so the row
      // passes rule 5/6, distinct from `from` so no self-ban triggers.
      { from: "core", to: "site", reason: "the property sweep's own ban" },
    ];
  }
  return file;
};

/**
 * A value shaped like the file a hostile or careless commit could produce:
 * either a JSON primitive, or a valid file with one rule violation injected.
 */
const mutation = (random) => {
  if (random() < 0.4) {
    return pick(random, [undefined, null, 3.14, "not an object", [], true]);
  }
  const base = validFile(random);
  const mut = Math.floor(random() * 9);
  if (mut === 0) base.stray = "key";
  if (mut === 1) base.version = "unexpected";
  if (mut === 2) base.boundaries = [];
  if (mut === 3) base.boundaries.push({ name: "b0", match: [pick(random, invalidSelectors)] });
  if (mut === 4) base.boundaries[0].match = [];
  if (mut === 5) {
    base.forbidden = [{ from: "core", to: "site" }]; // no reason
  }
  if (mut === 6) base.forbidden = [{ from: "tagz:x", to: "site", reason: "x" }];
  if (mut === 7) base.allowed = [{ from: "core", to: "site", optional: "yes" }];
  if (mut === 8) base.allowed = [];
  return jsonable(base);
};

describe("the validator is total", () => {
  it("returns an array of messages for 500 mutated or garbage inputs, never throws", () => {
    const random = makeRandom(20260816);
    for (let i = 0; i < 500; i++) {
      const violations = findIntentViolations(mutation(random));
      expect(Array.isArray(violations), `iteration ${i}`).toBe(true);
      expect(
        violations.every((m) => typeof m === "string"),
        `iteration ${i}`,
      ).toBe(true);
    }
  });
});

describe("the validator is deterministic", () => {
  it("returns byte-identical verdicts across two calls for 500 mutated inputs", () => {
    const random = makeRandom(424242);
    for (let i = 0; i < 500; i++) {
      const value = mutation(random);
      expect(JSON.stringify(findIntentViolations(value)), `iteration ${i}`).toBe(
        JSON.stringify(findIntentViolations(value)),
      );
    }
  });
});

describe("a structurally valid file loads, judges, and never throws", () => {
  it("passes validation, parses through loadIntent, and reaches a verdict for 300 sweeps", async () => {
    const random = makeRandom(7);
    const nodes = {
      core: { data: { tags: ["type-package"] } },
      ui: { data: { tags: ["type-package"] } },
      site: { data: { tags: ["type-extension"] } },
    };
    for (let i = 0; i < 300; i++) {
      const file = validFile(random);
      expect(findIntentViolations(file), `iteration ${i}`).toEqual([]);
      const model = await loadIntent("/ws", {
        read: async () => JSON.stringify(file),
      });
      expect(model, `iteration ${i}`).toBeTruthy();
      const verdict = judgeIntent(model, { nodes, dependencies: {} });
      expect(
        ["-ok", "-findings", "-no-verdict"].includes(`-${verdict.verdict}`),
        `iteration ${i}`,
      ).toBe(true);
      expect(JSON.stringify(judgeIntent(model, { nodes, dependencies: {} }))).toBe(
        JSON.stringify(verdict),
      );
    }
  });
});

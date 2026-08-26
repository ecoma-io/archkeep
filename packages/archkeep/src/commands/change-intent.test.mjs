import { describe, expect, it } from "vitest";

import { findChangeIntentReferenceViolations, parseChangeIntent } from "./change-intent.mjs";

/**
 * What the change-intent grammar guarantees: a manifest is strict JSON whose
 * every section is validated by name (never ignored), duplicates are load
 * errors rather than order-dependent meaning, absent sections normalize to
 * EMPTY expectations — a real expectation the reconciliation enforces, never
 * an absence of one — and a reference that cannot exist in any descendant of
 * the captured baseline is refused at load time instead of sitting in
 * `missingExpected` forever.
 */

const BASE = { commit: "a".repeat(40) };

/** A minimal well-formed manifest with everything absent. */
function minimal(overrides = {}) {
  return {
    version: "1",
    base: BASE,
    ...overrides,
  };
}

describe("parseChangeIntent", () => {
  it("accepts a minimal manifest and normalizes absent sections to empty expectations", () => {
    const intent = parseChangeIntent(JSON.stringify(minimal()), "m.json");
    expect(intent).toEqual({
      version: "1",
      base: { commit: BASE.commit },
      projects: { add: [], remove: [] },
      edges: { add: [], remove: [] },
      constraints: {},
    });
  });

  it("keeps summary and declared sections verbatim when present", () => {
    const intent = parseChangeIntent(
      JSON.stringify(
        minimal({
          summary: "add payments",
          projects: { add: ["payments"], remove: [] },
          edges: { add: [{ from: "api", to: "payments" }], remove: [] },
          constraints: { noNewViolations: true },
        }),
      ),
      "m.json",
    );
    expect(intent.summary).toBe("add payments");
    expect(intent.projects.add).toEqual(["payments"]);
    expect(intent.edges.add).toEqual([{ from: "api", to: "payments" }]);
    expect(intent.constraints).toEqual({ noNewViolations: true });
  });

  it("is not lenient about JSON syntax — a comment or trailing comma refuses", () => {
    for (const text of [`{ /* hi */ "version": "1" }`, `{"version":"1",}`]) {
      expect(() => parseChangeIntent(text, "m.json")).toThrow(/not valid JSON/);
    }
  });

  it("rejects a non-object top level by name", () => {
    expect(() => parseChangeIntent("[]", "m.json")).toThrow(/top level: must be an object/);
  });

  it("rejects an unknown top-level key by name, so a typo declares nothing silently", () => {
    const error = (() => {
      try {
        parseChangeIntent(JSON.stringify(minimal({ dependecies: {} })), "m.json");
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(error.message).toMatch(/unknown key "dependecies"/);
  });

  it("rejects any version but the one this engine understands", () => {
    for (const version of ["2", 1, undefined, null]) {
      expect(() => parseChangeIntent(JSON.stringify(minimal({ version })), "m.json")).toThrow(
        /version: must be exactly "1"/,
      );
    }
  });

  it("rejects a manifest without the base pin — without it nothing is verifiable", () => {
    for (const base of [undefined, {}, { commit: "" }, { commit: 42 }, { repo: "x" }]) {
      expect(() => parseChangeIntent(JSON.stringify(minimal({ base })), "m.json")).toThrow(
        /base\.commit|base: /,
      );
    }
  });

  it("rejects unknown keys inside base", () => {
    expect(() =>
      parseChangeIntent(JSON.stringify(minimal({ base: { ...BASE, tree: "x" } })), "m.json"),
    ).toThrow(/base\.tree: unknown key/);
  });

  it("rejects duplicate declarations in one list — the contract is a set, not a sequence", () => {
    expect(() =>
      parseChangeIntent(
        JSON.stringify(minimal({ projects: { add: ["a", "b", "a"], remove: [] } })),
        "m.json",
      ),
    ).toThrow(/duplicates projects\.add\[0\] \(a\)/);
    expect(() =>
      parseChangeIntent(
        JSON.stringify(
          minimal({
            edges: {
              add: [
                { from: "a", to: "b" },
                { from: "b", to: "c" },
                { from: "a", to: "b" },
              ],
              remove: [],
            },
          }),
        ),
        "m.json",
      ),
    ).toThrow(/duplicates edges\.add\[0\]/);
  });

  it("rejects the same fact declared in add and remove — a contradiction, not a delta", () => {
    expect(() =>
      parseChangeIntent(
        JSON.stringify(minimal({ projects: { add: ["a"], remove: ["a"] } })),
        "m.json",
      ),
    ).toThrow(/cannot be both expected to appear and expected to disappear/);
    expect(() =>
      parseChangeIntent(
        JSON.stringify(
          minimal({ edges: { add: [{ from: "a", to: "b" }], remove: [{ from: "a", to: "b" }] } }),
        ),
        "m.json",
      ),
    ).toThrow(/cannot be both expected to appear and expected to disappear/);
  });

  it("rejects a self-edge the graph could never observe", () => {
    expect(() =>
      parseChangeIntent(
        JSON.stringify(minimal({ edges: { add: [{ from: "a", to: "a" }], remove: [] } })),
        "m.json",
      ),
    ).toThrow(/self-edges/);
  });

  it("rejects a constraint written false — omitting the key is how a constraint is not asserted", () => {
    expect(() =>
      parseChangeIntent(JSON.stringify(minimal({ constraints: { noNewCycles: false } })), "m.json"),
    ).toThrow(/must be exactly true.*omitting the key/s);
  });

  it("rejects an empty summary — informational text is still text", () => {
    expect(() => parseChangeIntent(JSON.stringify(minimal({ summary: "" })), "m.json")).toThrow(
      /summary: must be a non-empty string/,
    );
  });
});

describe("findChangeIntentReferenceViolations", () => {
  const baseline = new Set(["api", "db"]);

  it("accepts references that land on the baseline or on declared additions", () => {
    const intent = parseChangeIntent(
      JSON.stringify(
        minimal({
          projects: { add: ["payments"], remove: [] },
          edges: {
            add: [
              { from: "api", to: "payments" },
              { from: "payments", to: "db" },
            ],
            remove: [{ from: "api", to: "db" }],
          },
        }),
      ),
      "m.json",
    );
    expect(findChangeIntentReferenceViolations(intent, baseline)).toEqual([]);
  });

  it("refuses an added project that already exists at the base", () => {
    const intent = parseChangeIntent(
      JSON.stringify(minimal({ projects: { add: ["api"], remove: [] } })),
      "m.json",
    );
    const violations = findChangeIntentReferenceViolations(intent, baseline);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/projects\.add: "api" already exists/);
  });

  it("refuses a removed project that does not exist at the base", () => {
    const intent = parseChangeIntent(
      JSON.stringify(minimal({ projects: { add: [], remove: ["ghost"] } })),
      "m.json",
    );
    expect(findChangeIntentReferenceViolations(intent, baseline)[0]).toMatch(
      /projects\.remove: "ghost" does not exist/,
    );
  });

  it("refuses an added edge naming a project that exists nowhere", () => {
    const intent = parseChangeIntent(
      JSON.stringify(
        minimal({
          projects: { add: [], remove: [] },
          edges: { add: [{ from: "api", to: "ghost" }], remove: [] },
        }),
      ),
      "m.json",
    );
    expect(findChangeIntentReferenceViolations(intent, baseline)[0]).toMatch(
      /names "ghost", which is neither in the baseline graph nor declared in projects\.add/,
    );
  });

  it("refuses an added edge attached to a project declared to disappear", () => {
    const intent = parseChangeIntent(
      JSON.stringify(
        minimal({
          projects: { add: [], remove: ["db"] },
          edges: { add: [{ from: "api", to: "db" }], remove: [] },
        }),
      ),
      "m.json",
    );
    expect(findChangeIntentReferenceViolations(intent, baseline)[0]).toMatch(
      /names "db" in projects\.remove/,
    );
  });

  it("refuses a removed edge of a project that had no base existence — including a declared addition", () => {
    const ghost = parseChangeIntent(
      JSON.stringify(
        minimal({
          projects: { add: [], remove: [] },
          edges: { add: [], remove: [{ from: "api", to: "ghost" }] },
        }),
      ),
      "m.json",
    );
    expect(findChangeIntentReferenceViolations(ghost, baseline)[0]).toMatch(
      /edges\.remove: api -> ghost names "ghost", which is not in the baseline graph/,
    );

    const added = parseChangeIntent(
      JSON.stringify(
        minimal({
          projects: { add: ["fresh"], remove: [] },
          edges: { add: [], remove: [{ from: "fresh", to: "api" }] },
        }),
      ),
      "m.json",
    );
    expect(findChangeIntentReferenceViolations(added, baseline)[0]).toMatch(
      /which is not in the baseline graph.*declared in projects\.add/s,
    );
  });
});

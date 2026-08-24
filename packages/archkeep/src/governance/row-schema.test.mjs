import { describe, expect, it } from "vitest";

import {
  GOVERNANCE_ROW_KEYS,
  governanceBlockViolations,
  rowSchemaViolations,
} from "./row-schema.mjs";
import { recordOrigin } from "./provenance-record.mjs";

const clock = () => ({ now: () => "2026-08-16T00:00:00.000Z" });

const RESOLVE_ALL = () => true;
const RESOLVE_NONE = () => false;

describe("rowSchemaViolations — the governance block is additive", () => {
  it("accepts a legacy row with no governance block at all", () => {
    expect(
      rowSchemaViolations({ sourceTag: "x", onlyDependOnLibsWithTags: ["y"] }, "depConstraints[0]"),
    ).toEqual([]);
    expect(rowSchemaViolations({ from: "a", to: "b" }, "allowed[0]")).toEqual([]);
  });

  it("accepts a full block: origin, rationale, decisionRef, fitnessBindings", () => {
    const row = {
      from: "packages",
      to: "extensions",
      origin: { by: "jane", tool: "archkeep:v1" },
      rationale: "the client must not reach into the engine",
      decisionRef: "adr:0012",
      fitnessBindings: ["fitness:hotspot"],
    };
    expect(rowSchemaViolations(row, "forbidden[0]")).toEqual([]);
  });

  it("accepts an origin carrying a committed `on` without a clock — a static file fact", () => {
    const row = { origin: { by: "jane", tool: "archkeep:v1", on: "2026-08-16" } };
    expect(rowSchemaViolations(row, "allowed[0]")).toEqual([]);
  });

  it("rejects an invalid origin loudly, prefixed with the row path", () => {
    const row = { origin: { tool: "archkeep:v1" } };
    const messages = rowSchemaViolations(row, "forbidden[2]");
    expect(messages.some((m) => m.includes("forbidden[2].origin.by"))).toBe(true);
  });

  it("rejects a crafted __proto__ origin key as unknown rather than polluting", () => {
    const crafted = JSON.parse('{"origin":{"by":"jane","tool":"l","__proto__":{"x":1}}}');
    const messages = rowSchemaViolations(crafted, "allowed[0]");
    expect(messages.some((m) => m.includes("origin.__proto__") && m.includes("unknown key"))).toBe(
      true,
    );
    // JSON.parse yields an own "__proto__" key; a literal `{"__proto__": …}`
    // in an object would SET the prototype silently — the unknown-key rejection
    // must be read-time and never allow the pollution to survive validation.
    expect({}.x).toBeUndefined();
    expect({}.x).toBeUndefined();
  });
});

describe("rowSchemaViolations — the three string-shaped keys", () => {
  it("rejects an empty rationale", () => {
    expect(rowSchemaViolations({ rationale: "" }, "forbidden[0]")[0]).toContain(
      "forbidden[0].rationale",
    );
  });

  it("rejects a non-string rationale", () => {
    expect(rowSchemaViolations({ rationale: 42 }, "forbidden[0]")[0]).toContain(
      "forbidden[0].rationale",
    );
  });

  it("rejects an empty decisionRef", () => {
    expect(rowSchemaViolations({ decisionRef: "" }, "allowed[0]")[0]).toContain(
      "allowed[0].decisionRef",
    );
  });

  it("rejects a non-array fitnessBindings", () => {
    expect(rowSchemaViolations({ fitnessBindings: "fitness:hotspot" }, "allowed[0]")[0]).toContain(
      "allowed[0].fitnessBindings",
    );
  });

  it("rejects an empty fitnessBindings list — present but empty binds nothing", () => {
    expect(rowSchemaViolations({ fitnessBindings: [] }, "allowed[0]")[0]).toContain(
      "allowed[0].fitnessBindings",
    );
  });

  it("rejects an empty entry inside fitnessBindings by its index", () => {
    expect(
      rowSchemaViolations({ fitnessBindings: ["fitness:hotspot", " "] }, "allowed[0]")[0],
    ).toContain("allowed[0].fitnessBindings[1]");
  });

  it("names GOVERNANCE_ROW_KEYS once", () => {
    expect(GOVERNANCE_ROW_KEYS).toEqual(["origin", "rationale", "decisionRef", "fitnessBindings"]);
  });
});

describe("rowSchemaViolations — resolution is the registry's half, injected", () => {
  it("rejects a decisionRef that cannot resolve, loudly — the silent direction", () => {
    const messages = rowSchemaViolations({ decisionRef: "adr:9999" }, "forbidden[0]", {
      resolve: RESOLVE_NONE,
    });
    expect(messages.some((m) => m.includes('"adr:9999" does not resolve'))).toBe(true);
  });

  it("rejects a fitnessBinding that cannot resolve", () => {
    const messages = rowSchemaViolations({ fitnessBindings: ["fitness:missing"] }, "allowed[0]", {
      resolve: RESOLVE_NONE,
    });
    expect(messages.some((m) => m.includes('"fitness:missing" does not resolve'))).toBe(true);
  });

  it("passes when every reference resolves", () => {
    expect(
      rowSchemaViolations(
        { decisionRef: "adr:0012", fitnessBindings: ["fitness:hotspot"] },
        "forbidden[0]",
        { resolve: RESOLVE_ALL },
      ),
    ).toEqual([]);
  });

  it("does not resolve when no registry is injected — shape alone runs", () => {
    expect(rowSchemaViolations({ decisionRef: "adr:9999" }, "forbidden[0]")).toEqual([]);
  });
});

describe("governanceBlockViolations — the key-specific validators", () => {
  it("is the shared validator: rationale/decisionRef/fitnessBindings, no origin", () => {
    // origin is provenance-record's; this validator covers the string keys only.
    expect(governanceBlockViolations({ rationale: 1 }, "x")).toEqual([
      expect.stringContaining("x.rationale"),
    ]);
    expect(governanceBlockViolations({}, "x")).toEqual([]);
  });
});

describe("integration — recordOrigin output lands in a row and reads back byte-identical", () => {
  it("produces and reads back a row with on, deterministically with the same clock", () => {
    const row = {
      from: "packages",
      to: "extensions",
      origin: recordOrigin({ by: "jane", tool: "archkeep:v1", clock: clock() }),
    };
    // Read-side validation needs no clock: the committed on is a static fact.
    expect(rowSchemaViolations(row, "forbidden[0]")).toEqual([]);
    const again = {
      ...row,
      origin: recordOrigin({ by: "jane", tool: "archkeep:v1", clock: clock() }),
    };
    expect(JSON.stringify(again)).toBe(JSON.stringify(row));
  });
});

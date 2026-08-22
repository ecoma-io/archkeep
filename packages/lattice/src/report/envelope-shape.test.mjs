import { describe, it, expect } from "vitest";

import { envelopeFieldPaths, compareFieldPaths } from "./envelope-shape.mjs";

describe("envelopeFieldPaths", () => {
  it("records every node, containers included, with its own type", () => {
    expect(envelopeFieldPaths({ tool: { name: "x", version: "1" }, exitCode: 0 })).toEqual([
      "exitCode: number",
      "tool: object",
      "tool.name: string",
      "tool.version: string",
    ]);
  });

  it("keeps null apart from object, which is the branch a consumer writes", () => {
    // `result.goWork` is null on a tree with no go.work and an object on a
    // tree with one. A roster that called both "object" would go green
    // through exactly the change that breaks the consumer's `=== null` test.
    expect(envelopeFieldPaths({ goWork: null })).toEqual(["goWork: null"]);
    expect(envelopeFieldPaths({ goWork: {} })).toEqual(["goWork: object"]);
  });

  it("collapses array elements onto one [] prefix, so the roster does not track counts", () => {
    const one = envelopeFieldPaths({ violations: [{ messageId: "a" }] });
    const three = envelopeFieldPaths({
      violations: [{ messageId: "a" }, { messageId: "b" }, { messageId: "c" }],
    });
    expect(one).toEqual([
      "violations: array",
      "violations[]: object",
      "violations[].messageId: string",
    ]);
    expect(three).toEqual(one);
  });

  it("records both types when a field is present on one row and absent on another", () => {
    // An optional field inside an array is the one place a single envelope
    // can hold two answers for one path. Recording both is how "optional" is
    // written down rather than decided by whichever row came first.
    expect(envelopeFieldPaths({ rows: [{ file: "a.go", line: 4 }, { file: "b.go" }] })).toEqual([
      "rows: array",
      "rows[]: object",
      "rows[].file: string",
      "rows[].line: number",
    ]);
  });

  it("descends through nested arrays", () => {
    expect(envelopeFieldPaths({ a: [[{ b: true }]] })).toEqual([
      "a: array",
      "a[]: array",
      "a[][]: object",
      "a[][].b: boolean",
    ]);
  });

  it("records an empty container as itself, with nothing under it", () => {
    expect(envelopeFieldPaths({ notAnalyzed: [], result: {} })).toEqual([
      "notAnalyzed: array",
      "result: object",
    ]);
  });

  it("gives the root no entry of its own", () => {
    expect(envelopeFieldPaths({})).toEqual([]);
  });

  it("refuses a value no JSON document can carry, naming the type", () => {
    expect(() => envelopeFieldPaths({ when: undefined })).toThrow(/undefined/u);
    expect(() => envelopeFieldPaths({ run: () => {} })).toThrow(/function/u);
  });

  it("refuses anything that is not the object jsonEnvelope returns", () => {
    expect(() => envelopeFieldPaths(null)).toThrow(/null/u);
    expect(() => envelopeFieldPaths([])).toThrow(/array/u);
    expect(() => envelopeFieldPaths("{}")).toThrow(/string/u);
  });
});

describe("compareFieldPaths", () => {
  it("is silent when the run and the snapshot agree", () => {
    expect(compareFieldPaths(["a: string"], ["a: string"])).toEqual({ added: [], removed: [] });
  });

  it("names a renamed field in both directions at once", () => {
    // A rename is the failure the promise forbids and the one a leaf-only
    // roster is worst at reading: it must surface as the old path gone AND
    // the new path arrived, never as a wash.
    expect(
      compareFieldPaths(["coverage.analyzedFiles: number"], ["coverage.filesRead: number"]),
    ).toEqual({
      added: ["coverage.filesRead: number"],
      removed: ["coverage.analyzedFiles: number"],
    });
  });

  it("names a retyped field as removed, not as merely added", () => {
    // `exitCode` going from a number to a string keeps the path and breaks
    // every consumer. It must land in `removed`, which is the failing lane —
    // an entry that only showed up as `added` would read as an allowed,
    // additive change.
    expect(compareFieldPaths(["exitCode: number"], ["exitCode: string"])).toEqual({
      added: ["exitCode: string"],
      removed: ["exitCode: number"],
    });
  });

  it("names a dropped field even when the run added others", () => {
    expect(compareFieldPaths(["a: string", "b: string"], ["a: string", "c: string"])).toEqual({
      added: ["c: string"],
      removed: ["b: string"],
    });
  });
});

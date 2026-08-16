import { describe, expect, it } from "vitest";

import { computeIntentFingerprint } from "./intent-fingerprint.mjs";

const intent = (overrides = {}) => ({
  requiredProjects: [],
  forbiddenProjects: [],
  allowedDependencies: [],
  forbiddenDependencies: [],
  forbiddenTags: [],
  ...overrides,
});

describe("computeIntentFingerprint", () => {
  it("is stable across repeated runs over the same intent", () => {
    expect(computeIntentFingerprint(intent())).toBe(computeIntentFingerprint(intent()));
  });

  it("moves when an intent row is deleted — the intentional-change signal", () => {
    const full = intent({ forbiddenProjects: [{ name: "legacy" }] });
    const without = intent({ forbiddenProjects: [] });
    expect(computeIntentFingerprint(full)).not.toBe(computeIntentFingerprint(without));
  });

  it("is independent of object key order (canonical), so re-typed intent maps to the same fingerprint", () => {
    // Two objects with identical content but keys written in different order.
    const a = {
      forbiddenTags: [],
      forbiddenDependencies: [],
      allowedDependencies: [],
      forbiddenProjects: [],
      requiredProjects: [],
    };
    const b = {
      requiredProjects: [],
      forbiddenProjects: [],
      allowedDependencies: [],
      forbiddenDependencies: [],
      forbiddenTags: [],
    };
    expect(computeIntentFingerprint(a)).toBe(computeIntentFingerprint(b));
  });

  it("moves when an array element order changes — row order is semantic", () => {
    const a = intent({ requiredProjects: [{ name: "x" }, { name: "y" }] });
    const b = intent({ requiredProjects: [{ name: "y" }, { name: "x" }] });
    expect(computeIntentFingerprint(a)).not.toBe(computeIntentFingerprint(b));
  });

  it("produces a hex SHA-256 of fixed length", () => {
    const digest = computeIntentFingerprint(intent());
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

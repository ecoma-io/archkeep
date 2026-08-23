/**
 * The intent fingerprint's own contract: which fields move it, which do not,
 * and what a stored value can be re-keyed by.
 *
 * Three consumers report this hash as the identity of the declared contract
 * (`../commands/drift.mjs` twice, `../commands/reconcile.mjs` once) — a
 * pipeline diffing two runs branches on it, so its field selection and its
 * stability are verdict surfaces, not implementation details. Until this file
 * existed they were asserted nowhere: a change to the selection, to the
 * canonicalization, or to the hash itself would have re-keyed every stored
 * intent row while every suite stayed green. The shipped policy packs get
 * exactly this treatment already — values AND field coverage
 * (`../governance/preset-fingerprints.integration.test.mjs`) — and policy
 * fingerprint identity is pinned beside `snapshotIdentity`
 * (`../commands/history.test.mjs`, "includes the policy fingerprint").
 *
 * There is deliberately no algorithm-version marker on the hash: the pinned
 * digest below IS the version marker, the same way a pack's pinned value is
 * in the preset suite. A deliberate change to how intent is hashed updates
 * the literal in the same commit; an accidental one has nowhere to hide.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalizeJson } from "../canonical.mjs";
import { computeIntentFingerprint } from "./intent-fingerprint.mjs";
import { INTENT_FILE, loadIntent } from "./model.mjs";

/**
 * A fully-filled normalized model — every field `normalizeIntent` (`./model.mjs`)
 * sets, so the field-selection sweep below covers the whole input domain the
 * consumers ever hash.
 */
const MODEL = {
  version: "1",
  boundaries: [
    { name: "packages", match: ["tag:type-package"] },
    { name: "apps", match: ["tag:type-application"] },
  ],
  allowed: [{ from: "apps", to: "packages" }],
  forbidden: [{ from: "packages", to: "apps", reason: "the engine must not reach out" }],
  projects: {
    required: [{ name: "core", tags: ["type-package"] }],
    forbidden: [{ name: "legacy" }],
  },
  dependencies: {
    allowed: [{ source: "core", target: "util" }],
    forbidden: [{ source: "util", target: "core" }],
  },
  forbiddenTags: ["deprecated"],
};

/** The pinned identity of `MODEL` — generated from the real function, then frozen. */
const PINNED = "3d1d1c83320f209252cbabe47d970cabe743ab64356a225fc37f4ec06d4ac96b";

/** The failure every mismatch below renders. */
const CHANGED =
  "the intent fingerprint moved — every stored intent row is re-keyed; make the change deliberate and update the pin";

/**
 * A copy of `value` with every object's keys inserted in reverse order, arrays
 * untouched. JSON.stringify emits keys in insertion order, so two objects that
 * differ only in key order serialize differently BEFORE canonicalization —
 * which is exactly what the stability test below must see through.
 *
 * @param {*} value
 * @returns {*}
 */
function reverseKeyOrder(value) {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value !== null && typeof value === "object") {
    const reversed = {};
    for (const key of Object.keys(value).reverse()) {
      reversed[key] = reverseKeyOrder(value[key]);
    }
    return reversed;
  }
  return value;
}

describe("computeIntentFingerprint", () => {
  it("resolves the fixture model to its pinned digest", () => {
    // The preset-fingerprints pattern: the value itself is the tripwire. Any
    // change to the selection, the canonicalization or the hash lands here
    // first, as a red test naming what the move costs.
    expect(computeIntentFingerprint(MODEL), CHANGED).toBe(PINNED);
  });

  it("is sha256 over the shared canonical JSON — the construction, not just a value", () => {
    // The pinned digest above says WHEN the hash moved; this says WHAT it is
    // computed over. Without it, a change that kept MODEL's digest stable by
    // coincidence of a compensating edit would leave the hash's construction
    // unclaimed — the same serialization `computePolicyFingerprint` uses
    // (`../canonical.mjs`), so the two faces of governance cannot drift apart
    // silently.
    const expected = createHash("sha256").update(canonicalizeJson(MODEL)).digest("hex");
    expect(computeIntentFingerprint(MODEL)).toBe(expected);
  });

  it.each([
    ["version", { ...MODEL, version: "2" }],
    [
      "boundaries",
      { ...MODEL, boundaries: [...MODEL.boundaries, { name: "tools", match: ["name:tools"] }] },
    ],
    ["allowed", { ...MODEL, allowed: [...MODEL.allowed, { from: "core", to: "util" }] }],
    ["forbidden", { ...MODEL, forbidden: [...MODEL.forbidden, { from: "core", to: "legacy" }] }],
    [
      "projects.required",
      {
        ...MODEL,
        projects: {
          ...MODEL.projects,
          required: [...MODEL.projects.required, { name: "util", tags: [] }],
        },
      },
    ],
    [
      "projects.forbidden",
      { ...MODEL, projects: { ...MODEL.projects, forbidden: [{ name: "sandbox" }] } },
    ],
    [
      "dependencies.allowed",
      {
        ...MODEL,
        dependencies: {
          ...MODEL.dependencies,
          allowed: [{ source: "core", target: "site" }],
        },
      },
    ],
    [
      "dependencies.forbidden",
      {
        ...MODEL,
        dependencies: {
          ...MODEL.dependencies,
          forbidden: [],
        },
      },
    ],
    ["forbiddenTags", { ...MODEL, forbiddenTags: [] }],
  ])("%s participates — mutating it moves the fingerprint", (_field, mutated) => {
    // Field coverage, asserted in the direction that could go silent: if the
    // hash ever narrows to a subset of the model, the dropped fields' rows
    // here go red, because their mutations stop moving anything. A consumer
    // re-keying stored rows over a field nobody knew was excluded is exactly
    // the accident this refuses.
    expect(computeIntentFingerprint(mutated)).not.toBe(computeIntentFingerprint(MODEL));
  });

  it("reaches nested rows — editing one reason inside one row moves it", () => {
    // Depth matters: the selection is the whole normalized model, not its top
    // level. A hash of top-level references only would miss every edit inside
    // a row while the structure stood still.
    const mutated = {
      ...MODEL,
      forbidden: [{ ...MODEL.forbidden[0], reason: "the engine must reach out" }],
    };
    expect(computeIntentFingerprint(mutated)).not.toBe(computeIntentFingerprint(MODEL));
  });

  it("is stable across object key order — the canonicalization sorts, so formatting cannot re-key", () => {
    // Two serializations of the SAME model must hash identically, or a
    // formatter (or a hand edit) that reordered keys would rotate every
    // stored fingerprint without the contract moving at all.
    expect(computeIntentFingerprint(reverseKeyOrder(MODEL))).toBe(computeIntentFingerprint(MODEL));
  });

  it("moves when array element order moves — order is semantic, never sorted away", () => {
    // The deliberate counterpart to the stability above: `../canonical.mjs`
    // sorts object keys at every depth and NEVER array elements, because row
    // order is part of what was declared. Re-ordering rows must be visible to
    // a pipeline diffing two runs.
    const reordered = {
      ...MODEL,
      boundaries: [MODEL.boundaries[1], MODEL.boundaries[0]],
    };
    expect(computeIntentFingerprint(reordered)).not.toBe(computeIntentFingerprint(MODEL));
  });
});

describe("computeIntentFingerprint through the real loader", () => {
  /**
   * Raw intent-file texts. Same declared contract, spelled differently —
   * `RAW_B` reorders every object's keys and reformats whitespace, which is
   * what a human edit or a formatter does to a tracked JSON file without
   * changing what it declares.
   */
  const RAW_A = `${JSON.stringify(
    {
      version: "1",
      boundaries: [
        { name: "packages", match: ["tag:type-package"] },
        { name: "apps", match: ["tag:type-application"] },
      ],
    },
    null,
    2,
  )}\n`;
  const RAW_B = JSON.stringify({
    boundaries: [
      { match: ["tag:type-package"], name: "packages" },
      { match: ["tag:type-application"], name: "apps" },
    ],
    version: "1",
  });

  /** `loadIntent`'s injected reader: serves one text for the fixture path. */
  const readFrom = (text) => async () => text;

  it("loads to the same fingerprint regardless of key order or whitespace", async () => {
    // Cross-run stability at the seam consumers actually call: two loads of
    // the same contract, differently spelled, must agree — otherwise a
    // whitespace-only commit would re-key the world.
    const root = "/lattice-intent-fingerprint-fixture";
    const first = await loadIntent(root, { read: readFrom(RAW_A), tracked: [INTENT_FILE] });
    const second = await loadIntent(root, { read: readFrom(RAW_B), tracked: [INTENT_FILE] });
    expect(computeIntentFingerprint(first)).toBe(computeIntentFingerprint(second));
  });

  it("keys a re-ordered boundary list differently through the same loader", async () => {
    // Re-key detection, end to end: the array-order rule survives loading,
    // so a diff of two runs' fingerprints sees a re-arranged contract even
    // when every row still parses and matches.
    const reorderedText = JSON.stringify({
      version: "1",
      boundaries: [JSON.parse(RAW_A).boundaries[1], JSON.parse(RAW_A).boundaries[0]],
    });
    const root = "/lattice-intent-fingerprint-rekey-fixture";
    const base = await loadIntent(root, { read: readFrom(RAW_A), tracked: [INTENT_FILE] });
    const moved = await loadIntent(root, { read: readFrom(reorderedText), tracked: [INTENT_FILE] });
    expect(computeIntentFingerprint(moved)).not.toBe(computeIntentFingerprint(base));
  });

  it("refuses an unknown top-level key rather than hashing past it", async () => {
    // The selection boundary is enforced where the file is loaded: a key
    // outside the model is a validation violation (`./model.mjs`), so no
    // spelling of an intent can add an unhashed field that quietly rides
    // along — it either joins the hash through normalization or refuses the
    // run loudly. Hashing past it would let a file mean more than its
    // fingerprint says.
    const withExtraKey = JSON.stringify({
      ...JSON.parse(RAW_A),
      notes: "nobody agreed to hash this",
    });
    const root = "/lattice-intent-fingerprint-unknown-key-fixture";
    await expect(
      loadIntent(root, { read: readFrom(withExtraKey), tracked: [INTENT_FILE] }),
    ).rejects.toThrow(/unknown key "notes"/u);
  });
});

/**
 * The revision round-trip: an architecture-intent revision — an edit to the
 * tracked file, re-validated and re-keyed — is reproducible from its bytes,
 * and a revision that fails validation is refused whole.
 *
 * Two directions, each the honest side of an invariant the evidence chain
 * depends on:
 *
 * - **Reproducible.** A stored intent row is keyed by
 *   `computeIntentFingerprint`'s digest over the normalized model
 *   (`./intent-fingerprint.mjs`). The same committed bytes must therefore
 *   load to the same model — deep-equal, byte-identical once canonicalized —
 *   on every read, or a re-key would rotate values that never moved. The
 *   field-level coverage of the digest is `./intent-fingerprint.test.mjs`'s
 *   job; this file pins the read path that feeds it.
 * - **Refused whole.** A revision the grammar cannot validate — a `version`
 *   the loader does not know, a key no row may carry — must stop the load at
 *   the one throw that names every violation (`./model.mjs`'s loader
 *   contract). A loader that half-accepted — normalizing what it understood
 *   and dropping what it did not — would hand the judge a contract assembled
 *   from a subset of the author's bytes, reading as the declared law while
 *   meaning less (`../../../../AGENTS.md`: an empty result is a claim).
 *
 * Every refusal here is red-first: delete the check it pins and `loadIntent`
 * resolves a model instead of throwing, so the `rejects` assertion fails
 * rather than the message text going stale.
 */
import { describe, expect, it } from "vitest";

import { canonicalizeJson } from "../canonical.mjs";
import { computeIntentFingerprint } from "./intent-fingerprint.mjs";
import { INTENT_FILE, loadIntent } from "./model.mjs";

/**
 * A first revision: one boundary pair, one forbidden row with its required
 * reason. Invented names throughout, per the fixture rule in
 * `../../../../AGENTS.md`.
 */
const REVISION_ONE = `${JSON.stringify(
  {
    version: "1",
    boundaries: [
      { name: "packages", match: ["tag:type-package"] },
      { name: "apps", match: ["tag:type-application"] },
    ],
    forbidden: [{ from: "apps", to: "packages", reason: "the app must not reach the engine" }],
  },
  null,
  2,
)}\n`;

/** The second revision: the same law plus one more forbidden row. */
const REVISION_TWO = `${JSON.stringify({
  ...JSON.parse(REVISION_ONE),
  forbidden: [
    ...JSON.parse(REVISION_ONE).forbidden,
    { from: "packages", to: "apps", reason: "the engine must not reach the app" },
  ],
})}\n`;

/** The same revision as `REVISION_ONE`, spelled with reordered keys — a formatter's edit. Array order is semantic and stays untouched; only object key order moves. */
const REVISION_ONE_REORDERED = JSON.stringify({
  forbidden: [{ reason: "the app must not reach the engine", to: "packages", from: "apps" }],
  boundaries: [
    { match: ["tag:type-package"], name: "packages" },
    { match: ["tag:type-application"], name: "apps" },
  ],
  version: "1",
});

/** `loadIntent`'s injected reader: serves one text for the fixture path. */
const readFrom = (text) => async () => text;

describe("the revision round-trip", () => {
  it("loads the same bytes to the same model, the same fingerprint, and the same canonical bytes", async () => {
    // The stored revision is reproducible from its input: two reads of one
    // committed file must hand back deep-equal models — otherwise a re-key
    // would rotate every stored row over bytes that never moved.
    const root = "/archkeep-revision-roundtrip-fixture";
    const first = await loadIntent(root, { read: readFrom(REVISION_ONE), tracked: [INTENT_FILE] });
    const second = await loadIntent(root, { read: readFrom(REVISION_ONE), tracked: [INTENT_FILE] });
    expect(second).toEqual(first);
    expect(computeIntentFingerprint(second)).toBe(computeIntentFingerprint(first));
    // The canonical serialization is what a stored key hashes and what a
    // consumer diffs — byte-identical, not merely deep-equal.
    expect(canonicalizeJson(second)).toBe(canonicalizeJson(first));
  });

  it("is invariant under a formatter's edit: reordered keys re-load to the same model", async () => {
    // A whitespace-or-key-order-only commit is not a revision. The model the
    // judge consumes — and therefore the key every stored row carries — must
    // be identical before and after it.
    const root = "/archkeep-revision-reorder-fixture";
    const authored = await loadIntent(root, {
      read: readFrom(REVISION_ONE),
      tracked: [INTENT_FILE],
    });
    const formatted = await loadIntent(root, {
      read: readFrom(REVISION_ONE_REORDERED),
      tracked: [INTENT_FILE],
    });
    expect(formatted).toEqual(authored);
    expect(computeIntentFingerprint(formatted)).toBe(computeIntentFingerprint(authored));
  });

  it("re-validates and re-keys an edit: the new revision moves the key, the stored one stays put", async () => {
    // The round-trip's forward direction: an intentional edit re-validates
    // (the loader accepts it whole) and the fingerprint moves, while the
    // first revision's key — recomputed, not cached — is unchanged. A consumer
    // diffing the two keys sees exactly the rows that moved.
    const root = "/archkeep-revision-edit-fixture";
    const one = await loadIntent(root, { read: readFrom(REVISION_ONE), tracked: [INTENT_FILE] });
    const two = await loadIntent(root, { read: readFrom(REVISION_TWO), tracked: [INTENT_FILE] });
    expect(computeIntentFingerprint(two)).not.toBe(computeIntentFingerprint(one));
    const oneReloaded = await loadIntent(root, {
      read: readFrom(REVISION_ONE),
      tracked: [INTENT_FILE],
    });
    expect(computeIntentFingerprint(oneReloaded)).toBe(computeIntentFingerprint(one));
  });
});

describe("a revision that fails validation is refused whole", () => {
  it("refuses a version bump the grammar does not know — through the loader, not only the validator", async () => {
    // `findIntentViolations`' own suite pins the message; this pins the load:
    // a file edited to `version: "2"` must throw, so no command ever judges
    // against a contract written for a grammar this engine does not speak.
    const root = "/archkeep-revision-bump-fixture";
    const bumped = `${JSON.stringify({ ...JSON.parse(REVISION_ONE), version: "2" })}\n`;
    await expect(
      loadIntent(root, { read: readFrom(bumped), tracked: [INTENT_FILE] }),
    ).rejects.toThrow(/version: must be exactly "1"/u);
  });

  it("accepts the same body once the version is the one the grammar knows — the refusal is the version's", async () => {
    // The silent-direction inverse: the gate fires on the version, not on the
    // body. If this resolved to nothing, the refusal above would be proven by
    // a file the loader rejects for reasons it never states.
    const root = "/archkeep-revision-bump-inverse-fixture";
    const loaded = await loadIntent(root, {
      read: readFrom(REVISION_ONE),
      tracked: [INTENT_FILE],
    });
    expect(loaded.version).toBe("1");
    expect(loaded.forbidden).toHaveLength(1);
  });

  it("refuses a malformed edit naming the key — no normalized model escapes the throw", async () => {
    // The reject-by-name rule, at the seam a revision actually arrives
    // through: an edit adding a key no row may carry must stop the load and
    // name the key, so the half-understood contract never reaches the judge.
    const root = "/archkeep-revision-malformed-fixture";
    const withStrayKey = `${JSON.stringify({
      ...JSON.parse(REVISION_ONE),
      notes: "nobody agreed to judge this",
    })}\n`;
    await expect(
      loadIntent(root, { read: readFrom(withStrayKey), tracked: [INTENT_FILE] }),
    ).rejects.toThrow(/unknown key "notes"/u);
  });

  it("refuses an edit that strips a forbidden row's reason, naming the row", async () => {
    // A row that half-survives its own edit is the worst half-state: the ban
    // would read as declared while its explanation was gone. The loader
    // refuses the file, and the message carries the row's path so the edit
    // that broke it is findable.
    const root = "/archkeep-revision-reasonless-fixture";
    const [, rowWithoutReason] = JSON.parse(REVISION_TWO).forbidden;
    const broken = `${JSON.stringify({
      ...JSON.parse(REVISION_ONE),
      forbidden: [
        ...JSON.parse(REVISION_ONE).forbidden,
        { from: rowWithoutReason.from, to: rowWithoutReason.to },
      ],
    })}\n`;
    await expect(
      loadIntent(root, { read: readFrom(broken), tracked: [INTENT_FILE] }),
    ).rejects.toThrow(/forbidden\[1\]\.reason: is required/u);
  });
});

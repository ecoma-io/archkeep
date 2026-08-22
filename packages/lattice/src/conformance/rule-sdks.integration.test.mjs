// The cross-SDK conformance gate: four reference artifacts, one host, one law.
//
// `./rule-sdks.mjs`'s header carries the argument for why this exists and what
// was unheld before it. This file is the measurement: every SDK's committed
// `.wasm` is loaded through the engine's real host, driven over the same five
// evidence bundles, and required to answer with the same verdict document —
// not the same verdict WORD, the same document, findings and reasons included.
//
// Three failures it exists to catch, none of which any suite in the tree could
// see before:
//
//  1. **One SDK's fixture copy edited alone.** Five documents exist four times
//     over. The parity case reads all twenty files and requires the four
//     copies of each to be byte-identical, so a fixture regenerated in one
//     package and not the others fails here rather than in whichever consumer
//     later notices two SDKs disagreeing about the same workspace.
//  2. **An SDK whose artifact and whose source have drifted apart.** Three of
//     the four SDK suites replay their reference rule as native code, because
//     neither a Go test nor a Rust one can instantiate wasm without a runtime
//     those packages refuse to depend on. That leaves the artifact — the thing
//     a consumer's `check` actually runs — proven only by its digest. Here it
//     is proven by its verdicts.
//  3. **Four suites drifting into four laws.** Each SDK pins its own expected
//     verdicts. Four green suites can hold four different answers, and nothing
//     compared them. This file compares them.
//
// A rebuild is deliberately NOT part of this: the artifacts are committed and
// pinned by digest, and rebuilding them needs three toolchains (TinyGo's
// freestanding target, AssemblyScript, a RustPython carrier) that no CI leg
// here installs. What is under test is the bytes in the tree, which is also
// what a consumer installs.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";

import { canonicalizeJson } from "../canonical.mjs";
import { evaluateCustomRule, loadCustomRule } from "../custom-rules/host.mjs";
import {
  EXPECTED_VERDICTS,
  REFERENCE_RULE_NAME,
  RULE_SDKS,
  disagreements,
  fixtureNames,
} from "./rule-sdks.mjs";

/** A generous per-call budget: the Python carrier is a 6.9 MiB module. */
const TIMEOUT_MS = 30_000;

/** @type {Array<{name: string, loaded: any}>} */
const loaded = [];

const resolve = (relative) => fileURLToPath(new URL(relative, import.meta.url));

beforeAll(async () => {
  for (const sdk of RULE_SDKS) {
    const artifact = resolve(sdk.artifact);
    const bytes = new Uint8Array(readFileSync(artifact));
    // The digest is read from the file the SDK records it in, not recomputed
    // here: that is the string a `customRules` row pins the artifact by, so
    // handing THAT to the host proves the recorded digest is one the host
    // would accept — a recomputed hash would prove only that sha256 is a
    // function.
    const declaredSha256 = readFileSync(`${artifact}.sha256`, "utf8").trim();
    loaded.push({
      name: sdk.name,
      loaded: await loadCustomRule({
        name: REFERENCE_RULE_NAME,
        artifactBytes: bytes,
        declaredSha256,
        timeoutMs: TIMEOUT_MS,
      }),
    });
  }
}, 120_000);

/**
 * One fixture's bytes as each SDK carries them.
 *
 * @param {string} fixture
 * @returns {Array<{name: string, value: string}>}
 */
function copiesOf(fixture) {
  return RULE_SDKS.map((sdk) => ({
    name: `${sdk.name}'s ${fixture}.json`,
    value: readFileSync(resolve(`${sdk.fixtures}/${fixture}.json`), "utf8"),
  }));
}

describe("the four rule SDKs, against one contract", () => {
  it("carries the same fixture catalogue in every SDK, and judges all of it", () => {
    // Completeness in both directions. A fixture added to a directory but not
    // to the expectations table would otherwise be a document no SDK is held
    // to; a fixture named in the table but missing from a directory would make
    // the parity read throw somewhere less legible than here.
    const expected = fixtureNames().sort();
    for (const sdk of RULE_SDKS) {
      const present = readdirSync(resolve(sdk.fixtures))
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => entry.slice(0, -".json".length))
        .sort();
      expect({ sdk: sdk.name, fixtures: present }).toEqual({ sdk: sdk.name, fixtures: expected });
    }
  });

  it("keeps the four copies of every fixture byte-identical", () => {
    for (const fixture of fixtureNames()) {
      expect({ fixture, differences: disagreements(copiesOf(fixture)) }).toEqual({
        fixture,
        differences: [],
      });
    }
  });

  it("loads every reference artifact through the real host, at its recorded digest", () => {
    for (const entry of loaded) {
      // `failure` is how the host reports a refusal; naming the SDK beside it
      // is what turns "a rule failed to load" into "the Python artifact failed
      // to load, and here is why".
      expect({ sdk: entry.name, failure: entry.loaded.failure ?? null }).toEqual({
        sdk: entry.name,
        failure: null,
      });
    }
  });

  it("answers one self-description from every SDK", () => {
    // The describe document is the rule's own account of what it is: its name,
    // the evidence kinds it declares, and the finding catalogue every verdict
    // resolves against. Four SDKs answering four different documents would be
    // four rules wearing one name — and the catalogue half decides how a
    // finding renders in SARIF, so a drift there reaches a consumer's
    // annotations rather than staying inside the suite.
    const documents = loaded.map((entry) => ({
      name: entry.name,
      value: canonicalizeJson(entry.loaded.describe),
    }));
    expect(disagreements(documents)).toEqual([]);
    expect(loaded[0].loaded.describe.name).toBe(REFERENCE_RULE_NAME);
  });

  it("answers one verdict document per fixture, and it is the recorded one", async () => {
    for (const [fixture, expectedVerdict] of Object.entries(EXPECTED_VERDICTS)) {
      const evidenceBytes = new TextEncoder().encode(
        readFileSync(resolve(`${RULE_SDKS[0].fixtures}/${fixture}.json`), "utf8"),
      );
      /** @type {Array<{name: string, value: string}>} */
      const answers = [];
      for (const entry of loaded) {
        const answered = await evaluateCustomRule({
          module: entry.loaded.module,
          describe: entry.loaded.describe,
          evidenceBytes,
          timeoutMs: TIMEOUT_MS,
        });
        expect({ sdk: entry.name, fixture, failure: answered.failure ?? null }).toEqual({
          sdk: entry.name,
          fixture,
          failure: null,
        });
        answers.push({ name: entry.name, value: canonicalizeJson(answered.verdict) });
        // The recorded expectation, checked per SDK rather than once on the
        // agreed answer: four SDKs agreeing on the WRONG verdict is exactly
        // the state an agreement-only check would certify.
        expect({ sdk: entry.name, fixture, verdict: answered.verdict.verdict }).toEqual({
          sdk: entry.name,
          fixture,
          verdict: expectedVerdict,
        });
      }
      expect({ fixture, differences: disagreements(answers) }).toEqual({
        fixture,
        differences: [],
      });
    }
  }, 120_000);
});

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

  it("answers byte-identically when the same evidence is evaluated twice", async () => {
    // The repeatability loop the verdict test above cannot show: it compares
    // four SDKs' answers to each other, so an eval that leaked state between
    // calls (a memoized finding list, a counter that advanced per instance)
    // would still see all four sides drift together and pass. Each SDK
    // therefore answers every fixture a second time — a fresh instance over
    // the same evidence bytes — and the two canonical documents must be
    // byte-identical. The recorded expectation is re-asserted on the repeat
    // so the loop cannot go quiet over two answers that agree on the wrong
    // verdict.
    for (const [fixture, expectedVerdict] of Object.entries(EXPECTED_VERDICTS)) {
      const evidenceBytes = new TextEncoder().encode(
        readFileSync(resolve(`${RULE_SDKS[0].fixtures}/${fixture}.json`), "utf8"),
      );
      for (const entry of loaded) {
        /** @type {string[]} */
        const runs = [];
        for (let run = 0; run < 2; run += 1) {
          const answered = await evaluateCustomRule({
            module: entry.loaded.module,
            describe: entry.loaded.describe,
            evidenceBytes,
            timeoutMs: TIMEOUT_MS,
          });
          expect({
            sdk: entry.name,
            fixture,
            run,
            failure: answered.failure ?? null,
          }).toEqual({ sdk: entry.name, fixture, run, failure: null });
          expect({ sdk: entry.name, fixture, run, verdict: answered.verdict.verdict }).toEqual({
            sdk: entry.name,
            fixture,
            run,
            verdict: expectedVerdict,
          });
          runs.push(canonicalizeJson(answered.verdict));
        }
        expect({ sdk: entry.name, fixture, secondRun: runs[1] }).toEqual({
          sdk: entry.name,
          fixture,
          secondRun: runs[0],
        });
      }
    }
  }, 120_000);

  it("answers the same over a bundle that grew fields no rule declared", async () => {
    // The additive-growth promise, measured rather than asserted in prose.
    // `../../../../docs/adr/0002-custom-rules-one-contract.md` says the
    // evidence contract "grows additively within a version", and every SDK's
    // binding says in its own words that it accepts members it does not read —
    // Rust carries no `deny_unknown_fields`, the AssemblyScript parser refuses
    // no member, Go's `json.Unmarshal` and Python's dicts ignore extras by
    // construction. Four claims, in four languages, none of them checked.
    //
    // They matter on the day the first language-namespaced kind lands: if any
    // SDK refused the bundle it did not recognise, every rule already written
    // would turn `unknown` on an engine upgrade that added nothing they read —
    // a whole workspace's law going quiet because the engine learned a new
    // fact. So the bundle here gains a kind that does not exist and a member
    // inside one that does, and the verdict must not move by a byte.
    const fixture = "edge-into-forbidden-tag";
    const bundle = JSON.parse(
      readFileSync(resolve(`${RULE_SDKS[0].fixtures}/${fixture}.json`), "utf8"),
    );
    const grown = {
      ...bundle,
      "go.decls": [{ project: "ring", file: "libs/ring/port.go", kind: "interface", line: 4 }],
      model: {
        ...bundle.model,
        projects: bundle.model.projects.map((project) => ({ ...project, language: "go" })),
      },
    };

    const encoder = new TextEncoder();
    for (const entry of loaded) {
      const before = await evaluateCustomRule({
        module: entry.loaded.module,
        describe: entry.loaded.describe,
        evidenceBytes: encoder.encode(JSON.stringify(bundle)),
        timeoutMs: TIMEOUT_MS,
      });
      const after = await evaluateCustomRule({
        module: entry.loaded.module,
        describe: entry.loaded.describe,
        evidenceBytes: encoder.encode(JSON.stringify(grown)),
        timeoutMs: TIMEOUT_MS,
      });
      expect({ sdk: entry.name, failure: after.failure ?? null }).toEqual({
        sdk: entry.name,
        failure: null,
      });
      expect({ sdk: entry.name, verdict: canonicalizeJson(after.verdict) }).toEqual({
        sdk: entry.name,
        verdict: canonicalizeJson(before.verdict),
      });
    }
  }, 120_000);
});

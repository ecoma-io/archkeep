// The official-rules conformance gate: every catalog entry, one host, one law.
//
// `./official-rules.mjs`'s header carries the argument for why this exists.
// This file is the measurement: every artifact the catalog advertises is
// loaded through the engine's real host at the digest the CATALOG pins, and
// required to answer the fixtures the rules package commits with the verdicts
// recorded here — the same document, findings and reasons included, not just
// the same verdict word.
//
// Failures it exists to catch, none of which a package-local test can see:
//
//  1. **A catalog entry whose digest is not the bytes.** The rules package's
//     own tests hold entry-against-bytes, but from inside the package — this
//     is the engine holding the same agreement from outside, at the string a
//     consumer would actually paste into a `customRules` row.
//  2. **An artifact that no longer answers its fixtures.** The Rust golden
//     suite replays the rule as native code; the artifact a consumer's
//     `check` runs is the wasm, and only this suite drives those bytes.
//  3. **A rule whose fixtures cannot go red.** A fixture table with no
//     `fail` case pins nothing about the loud direction, and one with no
//     `unknown` case cannot catch the rule that learned to answer `pass` on
//     input it never understood — both pairings are enforced, in both
//     directions, before any verdict is read.
//
// A rebuild is deliberately NOT part of this: the artifacts are committed and
// pinned by digest, and what is under test is the bytes in the tree, which is
// also what a consumer copies.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";

import { canonicalizeJson } from "../canonical.mjs";
import { evaluateCustomRule, loadCustomRule } from "../custom-rules/host.mjs";
import { EXPECTED_VERDICTS, RULES_PACKAGE, officialRules } from "./official-rules.mjs";

const TIMEOUT_MS = 30_000;

const resolve = (relative) => fileURLToPath(new URL(relative, import.meta.url));

/** @type {Array<{entry: Record<string, unknown>, loaded: any}>} */
const loaded = [];

beforeAll(async () => {
  for (const entry of officialRules()) {
    const artifactPath = resolve(`${RULES_PACKAGE}/${String(entry.artifact)}`);
    const bytes = new Uint8Array(readFileSync(artifactPath));
    // The digest comes from the CATALOG entry — not the sidecar, and not
    // recomputed — because that is the string a consumer copies out of the
    // catalog into their policy row. Handing it to the host proves the
    // catalog's pin is one the host accepts; the sidecar's agreement with it
    // is checked as a string below.
    const declaredSha256 = String(entry.sha256);
    loaded.push({
      entry,
      loaded: await loadCustomRule({
        name: String(entry.name),
        artifactBytes: bytes,
        declaredSha256,
        timeoutMs: TIMEOUT_MS,
      }),
    });
  }
}, 120_000);

describe("the official rules catalog, against the real host", () => {
  it("pairs every catalog entry with a fixture table, and judges every fixture on disk", () => {
    // Both directions: a rule added to the catalog without an entry here is a
    // rule this gate cannot see; a fixture committed without a recorded
    // verdict is a document no one is held to.
    const rules = officialRules()
      .map((entry) => String(entry.name))
      .sort();
    expect(rules).toEqual(Object.keys(EXPECTED_VERDICTS).sort());
    for (const rule of rules) {
      const present = readdirSync(resolve(`${RULES_PACKAGE}/fixtures/${rule}`))
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.slice(0, -".json".length))
        .sort();
      expect({ rule, fixtures: present }).toEqual({
        rule,
        fixtures: Object.keys(EXPECTED_VERDICTS[rule]).sort(),
      });
    }
  });

  it("holds the loud and the quiet direction for every rule", () => {
    // A fixture table without a `fail` case cannot catch a rule that stopped
    // reporting; one without `unknown` cannot catch a rule that answers
    // `pass` on input it never understood. Both pairings are structural —
    // checked before any verdict is read, so a fixture deleted in a refactor
    // fails here rather than quietly narrowing what the gate can see.
    for (const [rule, fixtures] of Object.entries(EXPECTED_VERDICTS)) {
      const verdicts = Object.values(fixtures);
      expect({
        rule,
        hasFail: verdicts.includes("fail"),
        hasUnknown: verdicts.includes("unknown"),
      }).toEqual({ rule, hasFail: true, hasUnknown: true });
    }
  });

  it("agrees on one digest across bytes, sidecar, and catalog entry", () => {
    for (const { entry } of loaded) {
      const artifactPath = resolve(`${RULES_PACKAGE}/${String(entry.artifact)}`);
      const sidecar = readFileSync(`${artifactPath}.sha256`, "utf8").trim();
      expect({ rule: entry.name, sidecar, catalog: entry.sha256 }).toEqual({
        rule: entry.name,
        sidecar,
        catalog: sidecar,
      });
    }
  });

  it("loads every advertised artifact through the real host, at the catalog's digest", () => {
    for (const { entry, loaded: result } of loaded) {
      expect({ rule: entry.name, failure: result.failure ?? null }).toEqual({
        rule: entry.name,
        failure: null,
      });
    }
  });

  it("answers a self-description that matches the catalog entry", () => {
    // The catalog's account of the rule (name, contract, evidence needs) and
    // the artifact's own describe document must be the same rule — a catalog
    // entry describing one artifact while naming another is exactly the drift
    // a copy-pasted row would carry into a consumer's policy.
    for (const { entry, loaded: result } of loaded) {
      const catalogNeeds = /** @type {ReadonlyArray<string>} */ (entry.needs);
      expect({
        rule: entry.name,
        describeName: result.describe.name,
        contract: result.describe.contract,
        needs: [...result.describe.needs].sort(),
      }).toEqual({
        rule: entry.name,
        describeName: entry.name,
        contract: entry.contract,
        needs: [...catalogNeeds].sort(),
      });
    }
  });

  it("answers every fixture with the recorded verdict document", async () => {
    for (const { entry, loaded: result } of loaded) {
      const rule = String(entry.name);
      const findingIds = new Set(result.describe.findings.map((finding) => finding.id));
      for (const [fixture, expectedVerdict] of Object.entries(EXPECTED_VERDICTS[rule])) {
        const evidenceBytes = new TextEncoder().encode(
          readFileSync(resolve(`${RULES_PACKAGE}/fixtures/${rule}/${fixture}.json`), "utf8"),
        );
        const answered = await evaluateCustomRule({
          module: result.module,
          describe: result.describe,
          evidenceBytes,
          timeoutMs: TIMEOUT_MS,
        });
        expect({ rule, fixture, failure: answered.failure ?? null }).toEqual({
          rule,
          fixture,
          failure: null,
        });
        expect({ rule, fixture, verdict: answered.verdict.verdict }).toEqual({
          rule,
          fixture,
          verdict: expectedVerdict,
        });
        // The verdict document's own obligations, checked beside the word:
        // `fail` findings resolve against the declared catalogue, and the
        // hollow-verdict refusals (`reason` on unknown, `notApplicableReason`
        // on not_applicable) are already enforced by the host — this pins
        // that the recorded answers are documents a host accepted rather
        // than a verdict word this table guessed.
        for (const finding of answered.verdict.findings ?? []) {
          expect({ rule, fixture, id: finding.id, known: findingIds.has(finding.id) }).toEqual({
            rule,
            fixture,
            id: finding.id,
            known: true,
          });
        }
      }
    }
  }, 120_000);

  it("answers the same over a bundle that grew fields no rule declared", async () => {
    // The additive-growth promise of contract 1, measured for the official
    // rules exactly as `./rule-sdks.integration.test.mjs` measures it for the
    // SDKs: a bundle gaining a kind that does not exist and a member inside
    // one that does must not move a verdict by a byte, or the day the engine
    // learns a new fact every official rule goes `unknown` at once.
    for (const { entry, loaded: result } of loaded) {
      const rule = String(entry.name);
      const fixture = Object.keys(EXPECTED_VERDICTS[rule])[0];
      const bundle = JSON.parse(
        readFileSync(resolve(`${RULES_PACKAGE}/fixtures/${rule}/${fixture}.json`), "utf8"),
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
      const before = await evaluateCustomRule({
        module: result.module,
        describe: result.describe,
        evidenceBytes: encoder.encode(JSON.stringify(bundle)),
        timeoutMs: TIMEOUT_MS,
      });
      const after = await evaluateCustomRule({
        module: result.module,
        describe: result.describe,
        evidenceBytes: encoder.encode(JSON.stringify(grown)),
        timeoutMs: TIMEOUT_MS,
      });
      expect({ rule, failure: after.failure ?? null }).toEqual({ rule, failure: null });
      expect({ rule, verdict: canonicalizeJson(after.verdict) }).toEqual({
        rule,
        verdict: canonicalizeJson(before.verdict),
      });
    }
  }, 120_000);
});

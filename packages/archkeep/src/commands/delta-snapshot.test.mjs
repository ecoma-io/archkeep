import { describe, expect, it } from "vitest";

import {
  EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
  buildEvidenceSnapshot,
  parseEvidenceSnapshot,
  providerMismatch,
  readEvidenceSnapshot,
  serializeEvidenceSnapshot,
} from "./delta-snapshot.mjs";

/**
 * What the evidence snapshot guarantees: a baseline that stores re-judgeable
 * EVIDENCE, written deterministically, and a loader that refuses every
 * baseline it cannot honestly classify against rather than consuming it in
 * silence. The silent direction each refusal case guards is a loader that
 * accepts the malformed file and lets a later delta run classify against
 * nothing — so every refusal test asserts the THROW, not just the message
 * text, and the one deliberate non-refusal (dirty provenance) asserts the
 * fact is exposed rather than dropped.
 */

// ---------------------------------------------------------------------------
// Fixtures — invented names throughout, per the fixture rule in
// ../../../../AGENTS.md ("A comment may only cite a document…").
// ---------------------------------------------------------------------------

function nodes() {
  return {
    "acme-alpha": {
      name: "acme-alpha",
      type: "lib",
      data: { root: "libs/alpha", tags: ["scope-invented"] },
    },
    "acme-beta": {
      name: "acme-beta",
      type: "lib",
      data: { root: "libs/beta", tags: [] },
    },
  };
}

function record(overrides = {}) {
  return {
    sourceFile: "libs/alpha/src/main.go",
    line: 3,
    column: 1,
    specifier: "example.invalid/acme/beta",
    kind: "static",
    spelling: { path: false, relative: false },
    resolved: { target: "acme-beta", file: null, external: false, packageName: null },
    ...overrides,
  };
}

function validInput(overrides = {}) {
  return {
    tool: { name: "archkeep", version: "0.0.0-test" },
    provenance: { commit: "0123abc", remote: null, dirty: false },
    provider: "nx",
    policyFingerprint: "fp-invented-1",
    coverage: { complete: true, analyzedFiles: 2, notAnalyzed: [], blindSpots: [] },
    graph: {
      nodes: nodes(),
      dependencies: { "acme-alpha": [{ target: "acme-beta", type: "static" }] },
    },
    records: [record()],
    ...overrides,
  };
}

/** A parsed-shape snapshot to mutate per refusal case. */
function validParsed() {
  return JSON.parse(serializeEvidenceSnapshot(buildEvidenceSnapshot(validInput())));
}

// ---------------------------------------------------------------------------
// buildEvidenceSnapshot
// ---------------------------------------------------------------------------

describe("buildEvidenceSnapshot", () => {
  it("builds a snapshot carrying evidence, not verdicts", () => {
    const snapshot = buildEvidenceSnapshot(validInput());
    expect(snapshot.schemaVersion).toBe(EVIDENCE_SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.provider).toBe("nx");
    expect(snapshot.policyFingerprint).toBe("fp-invented-1");
    // The records travel verbatim — including their `resolved` payloads —
    // because they are what a delta run re-judges under the current law.
    expect(snapshot.records).toEqual([record()]);
    expect(snapshot.graph.projects.map((p) => p.name)).toEqual(["acme-alpha", "acme-beta"]);
    expect(snapshot.graph.dependencies).toEqual([
      { source: "acme-alpha", target: "acme-beta", type: "static" },
    ]);
  });

  it("re-attaches the three rule-relevant node fields only when declared", () => {
    const input = validInput();
    input.graph.nodes["acme-alpha"].data.mfeRemote = true;
    input.graph.nodes["acme-alpha"].data.entryPoints = ["libs/alpha/testing", "libs/alpha/core"];
    input.graph.nodes["acme-alpha"].data.declaredPackages = ["zeta", "eta"];
    const snapshot = buildEvidenceSnapshot(input);
    const [alpha, beta] = snapshot.graph.projects;
    expect(alpha.mfeRemote).toBe(true);
    expect(alpha.entryPoints).toEqual(["libs/alpha/core", "libs/alpha/testing"]);
    expect(alpha.declaredPackages).toEqual(["eta", "zeta"]);
    // Absence stays absence: an invented empty value would be a second copy of
    // "declares none here" that `evaluate()` already reads off the absent key.
    expect("mfeRemote" in beta).toBe(false);
    expect("entryPoints" in beta).toBe(false);
    expect("declaredPackages" in beta).toBe(false);
  });

  it("carries workspaceLayout and sorted exemptedFiles when the graph has them", () => {
    const input = validInput();
    input.graph.workspaceLayout = { appsDir: "products", libsDir: "modules" };
    input.graph.exemptedFiles = ["libs/beta/gen.go", "libs/alpha/gen.go"];
    const snapshot = buildEvidenceSnapshot(input);
    expect(snapshot.graph.workspaceLayout).toEqual({ appsDir: "products", libsDir: "modules" });
    expect(snapshot.graph.exemptedFiles).toEqual(["libs/alpha/gen.go", "libs/beta/gen.go"]);
  });

  it("carries a null provenance as an explicit no-origin claim", () => {
    const snapshot = buildEvidenceSnapshot(validInput({ provenance: null }));
    expect(snapshot.provenance).toBeNull();
  });

  it("throws without a tool name", () => {
    expect(() => buildEvidenceSnapshot(validInput({ tool: { version: "1.0.0" } }))).toThrow(
      /tool name/,
    );
  });

  it("throws without a tool version", () => {
    expect(() => buildEvidenceSnapshot(validInput({ tool: { name: "archkeep" } }))).toThrow(
      /tool version/,
    );
  });

  it("throws without a provider name", () => {
    expect(() => buildEvidenceSnapshot(validInput({ provider: "" }))).toThrow(/provider name/);
  });

  it("throws without a policy fingerprint", () => {
    expect(() => buildEvidenceSnapshot(validInput({ policyFingerprint: undefined }))).toThrow(
      /policy fingerprint/,
    );
  });

  it("throws on a malformed coverage summary, naming the field", () => {
    const input = validInput({
      coverage: { complete: "yes", analyzedFiles: 2, notAnalyzed: [], blindSpots: [] },
    });
    expect(() => buildEvidenceSnapshot(input)).toThrow(/coverage\.complete/);
  });

  it("throws on a graph without a nodes map", () => {
    expect(() => buildEvidenceSnapshot(validInput({ graph: { dependencies: {} } }))).toThrow(
      /`nodes` map/,
    );
  });

  it("throws on a graph whose dependencies is not a map", () => {
    const input = validInput({ graph: { nodes: nodes(), dependencies: [] } });
    expect(() => buildEvidenceSnapshot(input)).toThrow(/`dependencies` map/);
  });

  it("throws when records is not an array", () => {
    expect(() => buildEvidenceSnapshot(validInput({ records: null }))).toThrow(
      /records as an array/,
    );
  });

  it("throws on a non-object record, naming its index", () => {
    expect(() => buildEvidenceSnapshot(validInput({ records: [record(), null] }))).toThrow(
      /record 1 is null/,
    );
  });
});

// ---------------------------------------------------------------------------
// The optional custom-rule pair (customRules + owned)
// ---------------------------------------------------------------------------

const CUSTOM_ROW = {
  name: "no-invented-reach",
  artifact: "tools/rules/no-invented-reach.wasm",
  sha256: "a".repeat(64),
  reason: "declared for the fixture",
  params: { limit: 3 },
};
const OWNED = [
  { file: "libs/beta/src/beta.go", project: "acme-beta" },
  { file: "libs/alpha/src/main.go", project: "acme-alpha" },
];

describe("the optional custom-rule blocks", () => {
  it("round-trips the pair, storing only the four judged fields and a file-sorted owned map", () => {
    const snapshot = buildEvidenceSnapshot(validInput({ customRules: [CUSTOM_ROW], owned: OWNED }));
    // `reason` explains the row to a human and changes no judgment — storing
    // it would be a fifth field a compare run never reads.
    expect(snapshot.customRules).toEqual([
      {
        name: "no-invented-reach",
        artifact: "tools/rules/no-invented-reach.wasm",
        sha256: "a".repeat(64),
        params: { limit: 3 },
      },
    ]);
    expect(snapshot.owned).toEqual([
      { file: "libs/alpha/src/main.go", project: "acme-alpha" },
      { file: "libs/beta/src/beta.go", project: "acme-beta" },
    ]);
    const text = serializeEvidenceSnapshot(snapshot);
    expect(parseEvidenceSnapshot(text, "/custom.json")).toEqual(snapshot);
  });

  it("keeps an absent params absent — the row's own declaration, never a defaulted copy", () => {
    const { params: _params, ...bare } = CUSTOM_ROW;
    const snapshot = buildEvidenceSnapshot(validInput({ customRules: [bare], owned: OWNED }));
    expect("params" in snapshot.customRules[0]).toBe(false);
  });

  it("stays byte-identical to the pre-block format when no custom rules are declared", () => {
    // The silent-direction compatibility claim: an undeclaring workspace's
    // snapshot must carry NO new key at all, so captures before and after
    // this feature diff clean.
    const snapshot = buildEvidenceSnapshot(validInput());
    expect("customRules" in snapshot).toBe(false);
    expect("owned" in snapshot).toBe(false);
  });

  it("refuses customRules without an owned map — the base side could attribute nothing", () => {
    expect(() => buildEvidenceSnapshot(validInput({ customRules: [CUSTOM_ROW] }))).toThrow(
      /owned: must be an array/,
    );
  });

  it("refuses an owned map without customRules — half the pair is not a snapshot", () => {
    expect(() => buildEvidenceSnapshot(validInput({ owned: OWNED }))).toThrow(
      /`owned` map but no `customRules` rows/,
    );
  });

  it("refuses malformed rows in either block, naming index and field", () => {
    const input = validInput({
      customRules: [{ name: "x", artifact: "", sha256: 7 }],
      owned: [{ file: "libs/alpha/src/main.go" }],
    });
    let thrown;
    try {
      buildEvidenceSnapshot(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain("customRules[0].artifact");
    expect(thrown.message).toContain("customRules[0].sha256");
    expect(thrown.message).toContain("owned[0].project");
  });
});

// ---------------------------------------------------------------------------
// serializeEvidenceSnapshot — determinism
// ---------------------------------------------------------------------------

describe("serializeEvidenceSnapshot", () => {
  it("round-trips through parse to a deep-equal snapshot", () => {
    const snapshot = buildEvidenceSnapshot(validInput());
    const text = serializeEvidenceSnapshot(snapshot);
    expect(parseEvidenceSnapshot(text, "/base.json")).toEqual(snapshot);
  });

  it("is byte-deterministic: two builds over one tree serialize identically", () => {
    // Same facts, hostile ordering: nodes and dependency keys inserted in the
    // opposite order, unsorted entryPoints and exemptedFiles. If any array
    // relied on insertion order the two texts would differ — and a plain
    // `diff` of two baselines would report noise as change.
    const a = validInput();
    a.graph.nodes["acme-alpha"].data.entryPoints = ["libs/alpha/b", "libs/alpha/a"];
    a.graph.exemptedFiles = ["libs/beta/gen.go", "libs/alpha/gen.go"];
    const b = validInput();
    b.graph.nodes = { "acme-beta": nodes()["acme-beta"], "acme-alpha": nodes()["acme-alpha"] };
    b.graph.nodes["acme-alpha"].data.entryPoints = ["libs/alpha/a", "libs/alpha/b"];
    b.graph.exemptedFiles = ["libs/alpha/gen.go", "libs/beta/gen.go"];
    expect(serializeEvidenceSnapshot(buildEvidenceSnapshot(a))).toBe(
      serializeEvidenceSnapshot(buildEvidenceSnapshot(b)),
    );
  });

  it("terminates the text with a newline", () => {
    expect(serializeEvidenceSnapshot(buildEvidenceSnapshot(validInput()))).toMatch(/\n$/);
  });
});

// ---------------------------------------------------------------------------
// parseEvidenceSnapshot — every refusal, each loud
// ---------------------------------------------------------------------------

describe("parseEvidenceSnapshot", () => {
  it("refuses malformed JSON, naming the path", () => {
    expect(() => parseEvidenceSnapshot("not json", "/bad.json")).toThrow(
      /\/bad\.json.*not valid JSON/,
    );
  });

  it("refuses a top-level value that is not an object", () => {
    expect(() => parseEvidenceSnapshot("null", "/null.json")).toThrow(/must be a JSON object/);
    expect(() => parseEvidenceSnapshot("[]", "/array.json")).toThrow(/must be a JSON object/);
    expect(() => parseEvidenceSnapshot("42", "/number.json")).toThrow(/must be a JSON object/);
  });

  it("refuses a schemaVersion of the wrong type", () => {
    const parsed = validParsed();
    parsed.schemaVersion = "1";
    expect(() => parseEvidenceSnapshot(JSON.stringify(parsed), "/v.json")).toThrow(
      /schemaVersion: must be the integer 1, got string/,
    );
  });

  it("refuses a FUTURE schemaVersion, telling the reader to upgrade", () => {
    const parsed = validParsed();
    parsed.schemaVersion = EVIDENCE_SNAPSHOT_SCHEMA_VERSION + 1;
    // A reader that half-understood a newer format would classify over
    // evidence it misread — acceptance here is the silent failure.
    expect(() => parseEvidenceSnapshot(JSON.stringify(parsed), "/future.json")).toThrow(
      /newer version of Archkeep; upgrade/,
    );
  });

  it("refuses an unknown PAST schemaVersion without claiming it is newer", () => {
    const parsed = validParsed();
    parsed.schemaVersion = 0;
    expect(() => parseEvidenceSnapshot(JSON.stringify(parsed), "/past.json")).toThrow(
      /No release of Archkeep ever wrote that version/,
    );
  });

  it("collects every missing section into one refusal, each named", () => {
    const parsed = validParsed();
    delete parsed.tool;
    delete parsed.provider;
    delete parsed.policyFingerprint;
    delete parsed.coverage;
    delete parsed.graph;
    delete parsed.records;
    let thrown;
    try {
      parseEvidenceSnapshot(JSON.stringify(parsed), "/hollow.json");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    for (const section of [
      "tool:",
      "provider:",
      "policyFingerprint:",
      "coverage:",
      "graph:",
      "records:",
    ]) {
      expect(thrown.message).toContain(section);
    }
  });

  it("refuses a provenance that is neither object nor null", () => {
    const parsed = validParsed();
    parsed.provenance = "0123abc";
    expect(() => parseEvidenceSnapshot(JSON.stringify(parsed), "/prov.json")).toThrow(
      /provenance: must be an object/,
    );
  });

  it("refuses a provenance object without a commit string", () => {
    const parsed = validParsed();
    parsed.provenance = { remote: null, dirty: false };
    expect(() => parseEvidenceSnapshot(JSON.stringify(parsed), "/prov.json")).toThrow(
      /provenance\.commit/,
    );
  });

  it("refuses an incomplete baseline, naming how many files went unanalyzed", () => {
    const parsed = validParsed();
    parsed.coverage = {
      complete: false,
      analyzedFiles: 1,
      notAnalyzed: [
        { file: "libs/alpha/x.go", reason: "unreadable" },
        { file: "libs/beta/y.go", reason: "unreadable" },
      ],
      blindSpots: [],
    };
    // The silent direction: consumed as a base, a violation living in an
    // unanalyzed file would read as newly introduced at head.
    expect(() => parseEvidenceSnapshot(JSON.stringify(parsed), "/partial.json")).toThrow(
      /coverage is not complete — 2 file\(s\) could not be analyzed/,
    );
  });

  it("does NOT refuse dirty provenance — it exposes the fact for a loud note", () => {
    const parsed = validParsed();
    parsed.provenance = { commit: "0123abc", remote: null, dirty: true };
    const snapshot = parseEvidenceSnapshot(JSON.stringify(parsed), "/dirty.json");
    // Weaker evidence, not unreadable evidence: the parse succeeds AND the
    // dirty flag survives, so the renderer can say so instead of nothing.
    expect(snapshot.provenance.dirty).toBe(true);
  });

  it("refuses malformed graph entries, naming each index and field", () => {
    const parsed = validParsed();
    parsed.graph.projects[0] = { name: "", root: 7 };
    parsed.graph.dependencies[0] = { source: "acme-alpha", type: "static" };
    let thrown;
    try {
      parseEvidenceSnapshot(JSON.stringify(parsed), "/graph.json");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain("graph.projects[0].name");
    expect(thrown.message).toContain("graph.projects[0].root");
    expect(thrown.message).toContain("graph.dependencies[0].target");
  });

  it("parses an OLD baseline with neither custom block — absence is legal, never a refusal", () => {
    // A pre-block capture must stay consumable: downstream classifies every
    // custom finding unknown with a re-capture reason, rather than this
    // loader refusing evidence that is merely older than the feature.
    const parsed = validParsed();
    expect("customRules" in parsed).toBe(false);
    const snapshot = parseEvidenceSnapshot(JSON.stringify(parsed), "/old.json");
    expect(snapshot.customRules).toBeUndefined();
    expect(snapshot.owned).toBeUndefined();
  });

  it("refuses a stored customRules block whose rows or owned map are malformed", () => {
    // The silent direction: a compare run consuming a half-readable block
    // would attribute base records against a map that is not one, and judge a
    // law whose pinned digest was never a string.
    const parsed = validParsed();
    parsed.customRules = [{ name: "no-invented-reach", artifact: "a.wasm" }];
    parsed.owned = [{ file: "libs/alpha/src/main.go", project: "" }];
    let thrown;
    try {
      parseEvidenceSnapshot(JSON.stringify(parsed), "/half.json");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain("customRules[0].sha256");
    expect(thrown.message).toContain("owned[0].project");
  });

  it("refuses customRules stored without the owned map beside it", () => {
    const parsed = validParsed();
    parsed.customRules = [
      { name: "no-invented-reach", artifact: "a.wasm", sha256: "b".repeat(64) },
    ];
    expect(() => parseEvidenceSnapshot(JSON.stringify(parsed), "/no-owned.json")).toThrow(
      /owned: must be an array/,
    );
  });

  it("refuses an owned map stored without customRules", () => {
    const parsed = validParsed();
    parsed.owned = [{ file: "libs/alpha/src/main.go", project: "acme-alpha" }];
    expect(() => parseEvidenceSnapshot(JSON.stringify(parsed), "/half-pair.json")).toThrow(
      /owned: present without customRules/,
    );
  });

  it("refuses records missing sourceFile or specifier, naming the index", () => {
    const parsed = validParsed();
    parsed.records = [record(), { line: 1, column: 1, kind: "static", resolved: null }];
    let thrown;
    try {
      parseEvidenceSnapshot(JSON.stringify(parsed), "/records.json");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain("records[1].sourceFile");
    expect(thrown.message).toContain("records[1].specifier");
  });
});

// ---------------------------------------------------------------------------
// readEvidenceSnapshot — the one filesystem seam, driven without a filesystem
// ---------------------------------------------------------------------------

describe("readEvidenceSnapshot", () => {
  it("reads through the injected read function and returns the parsed snapshot", () => {
    const snapshot = buildEvidenceSnapshot(validInput());
    const text = serializeEvidenceSnapshot(snapshot);
    const asked = [];
    const result = readEvidenceSnapshot("/base.json", {
      read: (path) => {
        asked.push(path);
        return text;
      },
    });
    expect(asked).toEqual(["/base.json"]);
    expect(result).toEqual(snapshot);
  });

  it("names the path and the cause when the read itself fails", () => {
    const read = () => {
      throw new Error("ENOENT: no such file");
    };
    expect(() => readEvidenceSnapshot("/absent.json", { read })).toThrow(
      /cannot read the evidence snapshot '\/absent\.json': ENOENT/,
    );
  });

  it("propagates parse refusals for text the read returned", () => {
    expect(() => readEvidenceSnapshot("/bad.json", { read: () => "not json" })).toThrow(
      /not valid JSON/,
    );
  });
});

// ---------------------------------------------------------------------------
// providerMismatch
// ---------------------------------------------------------------------------

describe("providerMismatch", () => {
  it("returns null when the providers agree", () => {
    expect(providerMismatch("nx", "nx")).toBeNull();
  });

  it("returns a reason naming BOTH providers on a mismatch", () => {
    const reason = providerMismatch("nx", "moon");
    expect(reason).toMatch(/'nx'/);
    expect(reason).toMatch(/'moon'/);
    expect(reason).toMatch(/provider artefacts/);
  });
});

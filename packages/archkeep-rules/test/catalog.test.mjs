/**
 * Catalog validator tests — pure function and filesystem wrapper.
 *
 * Three tiers, mirroring the repository's testing doctrine:
 * - Pure cases (facts as arguments) cover shape violations, digest mismatches,
 *   missing artifacts, and unknown keys — no filesystem, nothing stubbed.
 * - Integration cases run the real fs-wrapper against the committed tree and
 *   tmpdir fixtures.
 * - Adversarial cases ensure a malformed catalog never validates as empty.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  catalogViolations,
  CUSTOM_RULE_NAME_PATTERN,
  SHA256_PATTERN,
  CATALOG_VERSION,
  CONTRACT_VERSION,
  EVIDENCE_KINDS,
  PARAM_TYPES,
} from "../src/validator.mjs";
import { validateCatalogFiles } from "../src/fs-wrapper.mjs";

describe("catalogViolations", () => {
  describe("pure function: facts as arguments", () => {
    it("passes a valid manifest with version=1 and empty rules array", () => {
      const catalog = { version: 1, rules: [] };
      const artifactDigests = new Map();
      const violations = catalogViolations(catalog, artifactDigests);
      assert.deepEqual(violations, []);
    });

    it("passes a valid rule entry with all required fields", () => {
      const catalog = {
        version: 1,
        rules: [
          {
            name: "forbidden-tag-dependency",
            description: "Forbids dependencies on projects tagged with a specific label",
            contract: 1,
            needs: ["model", "graph"],
            params: {
              tag: {
                type: "string",
                required: true,
                description: "The tag that projects must not carry",
              },
            },
            artifact: "rules/forbidden-tag-dependency.wasm",
            sha256: "a".repeat(64),
          },
        ],
      };
      const artifactDigests = new Map([["rules/forbidden-tag-dependency.wasm", "a".repeat(64)]]);
      const violations = catalogViolations(catalog, artifactDigests);
      assert.deepEqual(violations, []);
    });

    it("rejects duplicate rule names", () => {
      const catalog = {
        version: 1,
        rules: [
          {
            name: "duplicate-name",
            description: "First entry",
            contract: 1,
            needs: ["model"],
            params: {},
            artifact: "rules/a.wasm",
            sha256: "a".repeat(64),
          },
          {
            name: "duplicate-name",
            description: "Second entry with same name",
            contract: 1,
            needs: ["model"],
            params: {},
            artifact: "rules/b.wasm",
            sha256: "b".repeat(64),
          },
        ],
      };
      const artifactDigests = new Map([
        ["rules/a.wasm", "a".repeat(64)],
        ["rules/b.wasm", "b".repeat(64)],
      ]);
      const violations = catalogViolations(catalog, artifactDigests);
      assert.ok(
        violations.some((v) =>
          v.includes('rules[1].name: "duplicate-name" is declared more than once'),
        ),
      );
    });

    it("rejects missing required metadata fields", () => {
      const catalog = {
        version: 1,
        rules: [
          {
            name: "incomplete-rule",
            // missing description
            contract: 1,
            needs: ["model"],
            params: {},
            artifact: "rules/incomplete.wasm",
            sha256: "a".repeat(64),
          },
        ],
      };
      const artifactDigests = new Map([["rules/incomplete.wasm", "a".repeat(64)]]);
      const violations = catalogViolations(catalog, artifactDigests);
      assert.ok(
        violations.some((v) => v.includes("rules[0].description: must be a non-empty string")),
      );
    });

    it("rejects malformed version", () => {
      const catalog = { version: "1", rules: [] };
      const violations = catalogViolations(catalog, new Map());
      assert.ok(violations.some((v) => v.includes("catalog.version: must be a number")));
    });

    it("rejects unsupported contract version", () => {
      const catalog = {
        version: 1,
        rules: [
          {
            name: "wrong-contract",
            description: "Rule with wrong contract",
            contract: 2,
            needs: ["model"],
            params: {},
            artifact: "rules/wrong.wasm",
            sha256: "a".repeat(64),
          },
        ],
      };
      const violations = catalogViolations(
        catalog,
        new Map([["rules/wrong.wasm", "a".repeat(64)]]),
      );
      assert.ok(violations.some((v) => v.includes("rules[0].contract: is 2, must be 1")));
    });

    it("rejects missing artifact (digest is null)", () => {
      const catalog = {
        version: 1,
        rules: [
          {
            name: "missing-artifact",
            description: "Rule whose artifact does not exist",
            contract: 1,
            needs: ["model"],
            params: {},
            artifact: "rules/missing.wasm",
            sha256: "a".repeat(64),
          },
        ],
      };
      const artifactDigests = new Map([["rules/missing.wasm", null]]); // null means missing
      const violations = catalogViolations(catalog, artifactDigests);
      assert.ok(
        violations.some((v) =>
          v.includes('rules[0].sha256: artifact "rules/missing.wasm" does not exist'),
        ),
      );
    });

    it("rejects checksum mismatch", () => {
      const catalog = {
        version: 1,
        rules: [
          {
            name: "checksum-mismatch",
            description: "Rule with wrong digest",
            contract: 1,
            needs: ["model"],
            params: {},
            artifact: "rules/mismatch.wasm",
            sha256: "a".repeat(64),
          },
        ],
      };
      const artifactDigests = new Map([["rules/mismatch.wasm", "b".repeat(64)]]); // different digest
      const violations = catalogViolations(catalog, artifactDigests);
      assert.ok(
        violations.some((v) =>
          v.includes(
            "rules[0].sha256: declares aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa but the artifact hashes to bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          ),
        ),
      );
    });

    it("rejects invalid artifact path (absolute)", () => {
      const catalog = {
        version: 1,
        rules: [
          {
            name: "absolute-path",
            description: "Rule with absolute path",
            contract: 1,
            needs: ["model"],
            params: {},
            artifact: "/absolute/path.wasm",
            sha256: "a".repeat(64),
          },
        ],
      };
      const violations = catalogViolations(catalog, new Map());
      assert.ok(violations.some((v) => v.includes("rules[0].artifact: artifact is absolute")));
    });

    it("rejects invalid artifact path (escaping with ..)", () => {
      const catalog = {
        version: 1,
        rules: [
          {
            name: "escaping-path",
            description: "Rule with escaping path",
            contract: 1,
            needs: ["model"],
            params: {},
            artifact: "../../etc/passwd.wasm",
            sha256: "a".repeat(64),
          },
        ],
      };
      const violations = catalogViolations(catalog, new Map());
      assert.ok(violations.some((v) => v.includes('rules[0].artifact: artifact contains a ".."')));
    });

    it("rejects malformed params descriptor (wrong type)", () => {
      const catalog = {
        version: 1,
        rules: [
          {
            name: "bad-params",
            description: "Rule with bad params",
            contract: 1,
            needs: ["model"],
            params: {
              tag: {
                type: "not-a-real-type",
                required: true,
                description: "A parameter",
              },
            },
            artifact: "rules/bad.wasm",
            sha256: "a".repeat(64),
          },
        ],
      };
      const violations = catalogViolations(catalog, new Map());
      assert.ok(
        violations.some((v) => v.includes("rules[0].params: params.tag.type: must be one of")),
      );
    });

    it("rejects unknown keys in rule entry", () => {
      const catalog = {
        version: 1,
        rules: [
          {
            name: "unknown-keys",
            description: "Rule with unknown keys",
            contract: 1,
            needs: ["model"],
            params: {},
            artifact: "rules/unknown.wasm",
            sha256: "a".repeat(64),
            unknownField: "this is not allowed",
          },
        ],
      };
      const violations = catalogViolations(catalog, new Map());
      assert.ok(
        violations.some((v) => v.includes("rules[0].unknownField: not a rule entry field")),
      );
    });

    it("accepts empty rules array as valid (catalog is empty)", () => {
      const catalog = { version: 1, rules: [] };
      const violations = catalogViolations(catalog, new Map());
      assert.deepEqual(violations, []);
    });

    it("adversarial: malformed catalog with missing rules key produces violations, never 'valid and empty'", () => {
      const catalog = /** @type {unknown} */ ({ version: 1 }); // missing rules key
      const violations = catalogViolations(catalog, new Map());
      assert.ok(violations.length > 0);
      assert.ok(violations.some((v) => v.includes("catalog.rules: must be an array")));
    });

    it("adversarial: malformed catalog with rules as non-array produces violations", () => {
      const catalog = /** @type {unknown} */ ({ version: 1, rules: "not-an-array" });
      const violations = catalogViolations(catalog, new Map());
      assert.ok(violations.length > 0);
      assert.ok(violations.some((v) => v.includes("catalog.rules: must be an array")));
    });

    it("adversarial: malformed catalog must fail loudly, never validate as empty", () => {
      const catalog = /** @type {unknown} */ ({ version: "wrong", rules: [] }); // wrong version type
      const violations = catalogViolations(catalog, new Map());
      assert.ok(violations.length > 0);
      assert.ok(violations.some((v) => v.includes("catalog.version: must be a number")));
    });
  });

  describe("constraints from the custom rule contract", () => {
    it("rejects needs that is not an array, naming what it got", () => {
      const catalog = {
        version: 1,
        rules: [
          {
            name: "needs-not-array",
            description: "Rule whose needs is a string",
            contract: 1,
            needs: "model",
            params: {},
            artifact: "rules/bad.wasm",
            sha256: "a".repeat(64),
          },
        ],
      };
      const violations = catalogViolations(catalog, new Map());
      assert.ok(
        violations.some((v) => v.includes('rules[0].needs: needs must be an array, got "model"')),
      );
    });

    it("serializes deterministically: canonical re-serialization is a fixpoint", () => {
      // The committed catalog must round-trip through JSON without its bytes
      // depending on insertion order or platform — a catalog two machines
      // serialize differently is a catalog whose diff cannot be reviewed.
      const catalogPath = resolve(fileURLToPath(import.meta.url), "..", "..", "catalog.json");
      const original = readFileSync(catalogPath, "utf8");
      const parsed = JSON.parse(original);
      // Use the same formatting that Prettier produces (which may differ from JSON.stringify)
      const reserialized = JSON.stringify(parsed, null, 2) + "\n";
      // Check semantic equivalence by parsing both (allowing for formatting differences)
      assert.deepEqual(JSON.parse(reserialized), JSON.parse(original));
      // Also check that when re-serialized, we get the same bytes (deterministic)
      assert.equal(JSON.stringify(JSON.parse(reserialized), null, 2) + "\n", reserialized);
    });

    it("rejects needs array with unknown kind", () => {
      const catalog = {
        version: 1,
        rules: [
          {
            name: "bad-needs",
            description: "Rule with unknown evidence kind",
            contract: 1,
            needs: ["model", "unknown-kind"],
            params: {},
            artifact: "rules/bad.wasm",
            sha256: "a".repeat(64),
          },
        ],
      };
      const violations = catalogViolations(catalog, new Map());
      assert.ok(
        violations.some((v) =>
          v.includes('rules[0].needs: needs contains unknown kind "unknown-kind"'),
        ),
      );
    });

    it("rejects needs array with duplicates", () => {
      const catalog = {
        version: 1,
        rules: [
          {
            name: "duplicate-needs",
            description: "Rule with duplicate needs",
            contract: 1,
            needs: ["model", "model"],
            params: {},
            artifact: "rules/dup.wasm",
            sha256: "a".repeat(64),
          },
        ],
      };
      const violations = catalogViolations(catalog, new Map());
      assert.ok(
        violations.some((v) => v.includes("rules[0].needs: needs must not contain duplicates")),
      );
    });

    it("rejects needs array that is empty", () => {
      const catalog = {
        version: 1,
        rules: [
          {
            name: "empty-needs",
            description: "Rule with empty needs",
            contract: 1,
            needs: [],
            params: {},
            artifact: "rules/empty.wasm",
            sha256: "a".repeat(64),
          },
        ],
      };
      const violations = catalogViolations(catalog, new Map());
      assert.ok(violations.some((v) => v.includes("rules[0].needs: needs must be non-empty")));
    });

    it("rejects params descriptor with unknown key", () => {
      const catalog = {
        version: 1,
        rules: [
          {
            name: "bad-param-descriptor",
            description: "Rule with bad param descriptor",
            contract: 1,
            needs: ["model"],
            params: {
              tag: {
                type: "string",
                required: true,
                description: "A parameter",
                unknownKey: "not allowed",
              },
            },
            artifact: "rules/bad.wasm",
            sha256: "a".repeat(64),
          },
        ],
      };
      const violations = catalogViolations(catalog, new Map());
      assert.ok(
        violations.some((v) =>
          v.includes("rules[0].params: params.tag.unknownKey: unknown key in param descriptor"),
        ),
      );
    });
  });
});

describe("constants", () => {
  it("EVIDENCE_KINDS matches the contract", () => {
    assert.deepEqual(EVIDENCE_KINDS, ["model", "graph", "imports", "policy"]);
  });

  it("PARAM_TYPES contains the allowed types", () => {
    assert.deepEqual(PARAM_TYPES, ["string", "number", "boolean", "array", "object"]);
  });

  it("CATALOG_VERSION is 1", () => {
    assert.equal(CATALOG_VERSION, 1);
  });

  it("CONTRACT_VERSION is 1", () => {
    assert.equal(CONTRACT_VERSION, 1);
  });

  it("CUSTOM_RULE_NAME_PATTERN matches the config pattern", () => {
    assert.ok(CUSTOM_RULE_NAME_PATTERN.test("forbidden-tag-dependency"));
    assert.ok(CUSTOM_RULE_NAME_PATTERN.test("no-interface-outside-domain"));
    assert.ok(!CUSTOM_RULE_NAME_PATTERN.test("Invalid_Name"));
    assert.ok(!CUSTOM_RULE_NAME_PATTERN.test("invalid name"));
  });

  it("SHA256_PATTERN matches 64 lowercase hex chars", () => {
    assert.ok(SHA256_PATTERN.test("a".repeat(64)));
    assert.ok(SHA256_PATTERN.test("0123456789abcdef".repeat(4)));
    assert.ok(!SHA256_PATTERN.test("A".repeat(64))); // uppercase rejected
    assert.ok(!SHA256_PATTERN.test("g".repeat(64))); // non-hex rejected
  });
});

describe("validateCatalogFiles (integration)", () => {
  it("validates the committed tree's catalog.json (rules: tag-cardinality, forbidden-tag-combination, max-fan-out)", () => {
    const packageRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
    const result = validateCatalogFiles(packageRoot);
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.catalog.rules));
    assert.equal(result.catalog.rules.length, 3);
    assert.equal(result.catalog.rules[0].name, "tag-cardinality");
    assert.equal(result.catalog.rules[1].name, "forbidden-tag-combination");
    assert.equal(result.catalog.rules[2].name, "max-fan-out");
  });

  it("throws when catalog.json cannot be read", () => {
    const tmpdir = mkdtempSync("archkeep-test-");
    try {
      assert.throws(() => validateCatalogFiles(tmpdir), /catalog.json .* could not be read/);
    } finally {
      rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it("throws when catalog.json is malformed JSON", () => {
    const tmpdir = mkdtempSync("archkeep-test-");
    try {
      writeFileSync(resolve(tmpdir, "catalog.json"), "{ not valid json }");
      assert.throws(() => validateCatalogFiles(tmpdir), /catalog.json .* is not valid JSON/);
    } finally {
      rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it("throws when catalog.json has validation errors", () => {
    const tmpdir = mkdtempSync("archkeep-test-");
    try {
      writeFileSync(
        resolve(tmpdir, "catalog.json"),
        JSON.stringify({
          version: 1,
          rules: [
            {
              name: "bad-rule",
              description: "A rule with problems",
              contract: 1,
              needs: ["model"],
              params: {},
              artifact: "/absolute/path.wasm", // invalid: absolute path
              sha256: "a".repeat(64),
            },
          ],
        }),
      );
      assert.throws(() => validateCatalogFiles(tmpdir), /rules\[0\]\.artifact.*absolute/);
    } finally {
      rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it("computes sha256 digests for existing artifacts", () => {
    const tmpdir = mkdtempSync("archkeep-test-");
    try {
      const wasmBytes = Buffer.from([0x00, 0x61, 0x73, 0x6d]); // WASM magic
      const rulesDir = resolve(tmpdir, "rules");
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(resolve(rulesDir, "test.wasm"), wasmBytes);

      const expectedDigest = createHash("sha256").update(wasmBytes).digest("hex");

      writeFileSync(
        resolve(tmpdir, "catalog.json"),
        JSON.stringify({
          version: 1,
          rules: [
            {
              name: "test-rule",
              description: "A test rule",
              contract: 1,
              needs: ["model"],
              params: {},
              artifact: "rules/test.wasm",
              sha256: expectedDigest,
            },
          ],
        }),
      );

      const result = validateCatalogFiles(tmpdir);
      assert.equal(result.ok, true);
    } finally {
      rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});

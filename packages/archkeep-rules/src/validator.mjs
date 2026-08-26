/**
 * Pure catalog validator — facts as arguments, loud failures only.
 *
 * This module validates the official rules catalog's JSON schema and verifies
 * artifact integrity against actual bytes. It is pure: every fact it needs arrives
 * as an argument, so its tests need no filesystem and no mocking library.
 *
 * The catalog is documentation-as-data and an integrity gate for shipped rule
 * artifacts. Consumers copy the sha256 FROM the catalog into their customRules
 * row, so a catalog that validates malformed or mismatched digests would ship
 * a lie. The validator refuses loudly: shape violations, digest mismatches,
 * missing artifacts, and unknown keys are all named as violations.
 *
 * ## Why the validator takes artifactDigests
 *
 * The catalog's sha256 field is a claim about the artifact's bytes. Both live in
 * this package — the entry under `rules/` beside the `catalog.json` that names
 * it — and integrity means the declared digest matches the bytes on disk, which
 * only a function that sees both can judge. The pure function takes the digest
 * map as an argument so a test can supply fixtures without a filesystem, and the
 * fs wrapper computes real digests via node:crypto before calling in.
 */

/**
 * The four evidence kinds the custom-rule contract defines.
 * A rule's `needs` array must be a non-empty subset of these, with no duplicates.
 */
export const EVIDENCE_KINDS = Object.freeze(["model", "graph", "imports", "policy"]);

/**
 * Rule name pattern, matching the customRules row constraint in
 * packages/archkeep/src/config.mjs — lowercase letters, digits, single-dash
 * separators, non-empty.
 */
export const CUSTOM_RULE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * SHA256 digest pattern — 64 lowercase hex characters, matching
 * CUSTOM_RULE_SHA256_PATTERN in packages/archkeep/src/config.mjs.
 */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Catalog schema version — this catalog speaks version 1.
 */
export const CATALOG_VERSION = 1;

/**
 * Custom-rule contract version — every shipped artifact speaks contract 1,
 * matching EVIDENCE_CONTRACT in packages/archkeep/src/custom-rules/evidence.mjs.
 */
export const CONTRACT_VERSION = 1;

/**
 * Param descriptor type names — the allowed values for a param's `type` field.
 */
export const PARAM_TYPES = Object.freeze(["string", "number", "boolean", "array", "object"]);

/**
 * The keys a catalog rule entry may carry.
 */
const RULE_ENTRY_KEYS = [
  "name",
  "description",
  "contract",
  "needs",
  "params",
  "artifact",
  "sha256",
];

/**
 * Whether `value` is a plain JSON object — null-prototype or Object.prototype only.
 * Arrays, Maps, Sets, RegExp, Date, and class instances return false.
 */
function isPlainObject(value) {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Whether a `needs` array is valid — non-empty, subset of EVIDENCE_KINDS, no
 * duplicates, all strings.
 */
function validNeedsArray(needs) {
  if (!Array.isArray(needs)) return `needs must be an array, got ${describe(needs)}`;
  if (needs.length === 0) return "needs must be non-empty";
  if (new Set(needs).size !== needs.length) return "needs must not contain duplicates";
  for (const kind of needs) {
    if (typeof kind !== "string") return `needs contains non-string: ${describe(kind)}`;
    if (!EVIDENCE_KINDS.includes(kind)) {
      return `needs contains unknown kind "${kind}" — must be one of ${EVIDENCE_KINDS.join(", ")}`;
    }
  }
  return "ok";
}

/**
 * Whether a `params` descriptor is valid — object mapping param name to a
 * descriptor with type/required/description, no unknown keys.
 */
function validParamsDescriptor(params) {
  if (!isPlainObject(params)) return `params must be an object, got ${describe(params)}`;

  for (const [paramName, descriptor] of Object.entries(params)) {
    if (!isPlainObject(descriptor)) {
      return `params.${paramName}: descriptor must be an object, got ${describe(descriptor)}`;
    }

    const { type, required, description } = descriptor;

    if (typeof type !== "string" || !PARAM_TYPES.includes(type)) {
      return `params.${paramName}.type: must be one of ${PARAM_TYPES.join(", ")}, got ${describe(type)}`;
    }

    if (typeof required !== "boolean") {
      return `params.${paramName}.required: must be boolean, got ${describe(required)}`;
    }

    if (typeof description !== "string" || description.trim() === "") {
      return `params.${paramName}.description: must be a non-empty string`;
    }

    // Reject unknown keys in the descriptor
    const allowedDescriptorKeys = new Set(["type", "required", "description"]);
    for (const key of Object.keys(descriptor)) {
      if (!allowedDescriptorKeys.has(key)) {
        return `params.${paramName}.${key}: unknown key in param descriptor`;
      }
    }
  }

  return "ok";
}

/**
 * Describes a value for error messages — the same pattern
 * packages/archkeep/src/custom-rules/host.mjs uses (describeValue).
 */
function describe(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  if (isPlainObject(value)) return "an object";
  const type =
    typeof value === "object" && value.constructor?.name ? value.constructor.name : typeof value;
  return `a ${type}`;
}

/**
 * Validates one rule entry's artifact path — package-relative, no escaping,
 * must end .wasm. Backslash is never legitimate: the catalog uses forward
 * slashes only, and on Windows a backslash is both a path separator and an
 * escape vector (drive letters, UNC paths, or `rules\..\..\x.wasm` bypassing
 * the `..` segment check).
 */
function artifactPathProblem(artifact) {
  if (typeof artifact !== "string" || artifact === "") {
    return `artifact must be a non-empty string, got ${describe(artifact)}`;
  }
  if (!artifact.endsWith(".wasm")) {
    return `artifact must end with .wasm, got "${artifact}"`;
  }
  if (artifact.startsWith("/")) {
    return `artifact is absolute (starts with /) — must be package-relative like "rules/<name>.wasm"`;
  }
  if (artifact.includes("\\")) {
    return `artifact contains a backslash — catalog paths use forward slashes only and must be package-relative (on Windows a backslash is also an escape vector: drive letters, UNC paths, or disguised parent-directory escapes)`;
  }
  // Segment check, not a substring one: a filename like `tag..cardinality.wasm`
  // contains ".." without escaping anything, while `rules/../../x.wasm` is an
  // escape carried entirely by its segments.
  if (artifact.split("/").includes("..")) {
    return `artifact contains a ".." segment — must not escape the package directory`;
  }
  return null;
}

/**
 * Validates one catalog rule entry.
 *
 * @param {unknown} entry - the rule entry to validate
 * @param {number} index - the entry's index in the rules array
 * @param {Map<string, string | null>} artifactDigests - map artifact path → sha256 hex or null if missing
 * @param {Set<string>} seenNames - names already claimed (for duplicate detection)
 * @returns {string[]} - violations naming the field and problem (empty = valid)
 */
function ruleEntryViolations(entry, index, artifactDigests, seenNames) {
  const at = `rules[${index}]`;
  if (!isPlainObject(entry)) {
    return [`${at}: must be an object, got ${describe(entry)}`];
  }

  const violations = [];
  const record = /** @type {Record<string, unknown>} */ (entry);

  // name: required, matches pattern, unique
  if (typeof record.name !== "string" || !CUSTOM_RULE_NAME_PATTERN.test(record.name)) {
    violations.push(
      `${at}.name: must be a non-empty name of lowercase letters and digits joined by single "-" separators (like "no-interface-outside-domain"), got ${describe(record.name)}`,
    );
  } else if (seenNames.has(record.name)) {
    violations.push(
      `${at}.name: "${record.name}" is declared more than once — every rule name must be unique`,
    );
  } else {
    seenNames.add(record.name);
  }

  // description: required, non-empty string
  if (typeof record.description !== "string" || record.description.trim() === "") {
    violations.push(
      `${at}.description: must be a non-empty string — a rule without explanation is indistinguishable from one nobody would defend`,
    );
  }

  // contract: required, number 1
  if (typeof record.contract !== "number") {
    violations.push(`${at}.contract: must be a number, got ${describe(record.contract)}`);
  } else if (record.contract !== CONTRACT_VERSION) {
    violations.push(
      `${at}.contract: is ${record.contract}, must be ${CONTRACT_VERSION} — a rule built against another contract would fail at load`,
    );
  }

  // needs: required, non-empty array, subset of EVIDENCE_KINDS, no duplicates
  if (!("needs" in record)) {
    violations.push(`${at}.needs: is required`);
  } else {
    const needsProblem = validNeedsArray(record.needs);
    if (needsProblem !== "ok") {
      violations.push(`${at}.needs: ${needsProblem}`);
    }
  }

  // params: required, object with param descriptors
  if (!("params" in record)) {
    violations.push(`${at}.params: is required`);
  } else {
    const paramsProblem = validParamsDescriptor(record.params);
    if (paramsProblem !== "ok") {
      violations.push(`${at}.params: ${paramsProblem}`);
    }
  }

  // artifact: required, package-relative .wasm path, no escaping
  if (typeof record.artifact !== "string" || record.artifact === "") {
    violations.push(
      `${at}.artifact: must be a non-empty package-relative path to the .wasm artifact, got ${describe(record.artifact)}`,
    );
  } else {
    const artifactProblem = artifactPathProblem(record.artifact);
    if (artifactProblem) {
      violations.push(`${at}.artifact: ${artifactProblem}`);
    }
  }

  // sha256: required, 64 lowercase hex chars, must match actual bytes
  if (typeof record.sha256 !== "string" || !SHA256_PATTERN.test(record.sha256)) {
    violations.push(
      `${at}.sha256: must be 64 lowercase hex characters — the hash of the artifact's bytes, got ${describe(record.sha256)}`,
    );
  } else if (typeof record.artifact === "string") {
    const actualDigest = artifactDigests.get(record.artifact);
    if (actualDigest === null) {
      violations.push(
        `${at}.sha256: artifact "${record.artifact}" does not exist — cannot verify digest`,
      );
    } else if (actualDigest !== record.sha256) {
      violations.push(
        `${at}.sha256: declares ${record.sha256} but the artifact hashes to ${actualDigest} — the digest in the catalog must match the bytes on disk`,
      );
    }
  }

  // Reject unknown keys
  for (const key of Object.keys(record)) {
    if (!RULE_ENTRY_KEYS.includes(key)) {
      violations.push(
        `${at}.${key}: not a rule entry field — expected one of ${RULE_ENTRY_KEYS.join(", ")}`,
      );
    }
  }

  return violations;
}

/**
 * Validates a catalog's envelope and all rule entries.
 *
 * @param {unknown} catalog - the parsed catalog.json
 * @param {Map<string, string | null>} artifactDigests - map artifact path → sha256 hex or null if missing
 * @returns {string[]} - violation strings naming the field and problem (empty = valid)
 */
export function catalogViolations(catalog, artifactDigests) {
  const violations = [];

  // Envelope validation: version must be number 1, rules must be array
  if (!isPlainObject(catalog)) {
    return ["catalog: must be an object, got " + describe(catalog)];
  }

  const record = /** @type {Record<string, unknown>} */ (catalog);

  if (typeof record.version !== "number") {
    violations.push(`catalog.version: must be a number, got ${describe(record.version)}`);
  } else if (record.version !== CATALOG_VERSION) {
    violations.push(`catalog.version: is ${record.version}, must be ${CATALOG_VERSION}`);
  }

  if (!Array.isArray(record.rules)) {
    violations.push(`catalog.rules: must be an array, got ${describe(record.rules)}`);
    return violations; // Can't continue without rules being an array
  }

  // Validate each rule entry, tracking seen names for duplicate detection
  const seenNames = new Set();
  for (let i = 0; i < record.rules.length; i++) {
    violations.push(...ruleEntryViolations(record.rules[i], i, artifactDigests, seenNames));
  }

  return violations;
}

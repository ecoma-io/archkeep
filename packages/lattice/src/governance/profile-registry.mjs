/**
 * Named boundary-law profiles: rule blocks a workspace can give a name to,
 * stack on a base, and then select by name instead of by file.
 *
 * A profile is data, not a new dialect. Each profile body is a policy block of
 * the exact three keys every boundaryConfig dialect already shares —
 * `depConstraints`, `moduleBoundaryOptions`, `boundarySuppressions`
 * (`../../config.mjs`'s `findBoundaryConfigViolations`, documented in
 * `../../../../docs/concepts/policies.md`) — validated by that same validator,
 * so a profile cannot state a constraint the file dialects cannot. The
 * resolution result is fed through `../../config.mjs`'s `policyFrom` tail, so
 * there is exactly ONE enforcement path: a profile is a way to name and reuse a
 * policy, never a second kind of policy that could disagree with a file about
 * the same row.
 *
 * The profile list itself is JSON, named by the `profiles` plugin option
 * (`../../options.mjs`). A profile has a `name`, an optional `base` (the name
 * of another profile whose effective block it inherits), and a `block` of the
 * three keys. Precedence is deterministic and documented in
 * `../../../../docs/concepts/profiles.md`: a child profile's `depConstraints`
 * rows are appended AFTER its base's rows (the composition semantics of
 * `@nx/enforce-module-boundaries`, where a dependency must satisfy EVERY row
 * whose `sourceTag` its source project carries, so axes compose rather than
 * replace); its `moduleBoundaryOptions` keys overwrite the base's key by key;
 * its `boundarySuppressions` rows are appended after the base's. `base` may
 * chain by name — `b` on `a`, `c` on `b` — resolved depth-first, earlier
 * profiles first, so a chain reads in the order it was written.
 *
 * ## What is loud, and why
 *
 * A profile registry that silently compensated for its own defects would
 * repeat the one failure this tool exists to end. Three conditions are thrown,
 * all by name:
 *
 * - A profile whose reference is **unknown** — `base` names a profile that
 *   does not exist. Read as "no base", the profile would shed the rows it was
 *   meant to inherit: the stack stops enforcing its base block, and nothing
 *   says so.
 * - A **cycle** in a base chain — `a` on `b` on `a`. A cycle has no
 *   deterministic resolution; stopping it loudly is the only correct answer.
 * - A profile with **no name**, or no `block` — the first states a rule nobody
 *   can refer to, the second parses as an empty policy (which `policyFrom`
 *   would refuse for its own reasons, but the registry names it as a profile
 *   defect so the reader is looking at the right file).
 *
 * Missing `name` is an exit-3 class (`../../../cli.mjs`, `EXIT.error`): the
 * registry cannot be read, so no command that depends on it can reach a
 * verdict.
 *
 * ## Loading
 *
 * `loadProfileRegistry` reads the file named by the `profiles` option. It does
 * not `import()` the way a `.mjs` boundary config does: a registry whose
 * entries are data earns the same strict reading as a `.json` boundary law —
 * plain `JSON.parse`, never JSONC (`../../config.mjs`'s header argues that
 * dialect). The injectable `readFile` seam is the same one
 * `../../options.mjs`'s readers take, and everything except the read itself is
 * pure.
 */
import { readFileSync } from "node:fs";

import { policyFrom } from "../config.mjs";

/**
 * The top-level keys a profiles file may carry. `version` is checked when
 * present; `profiles` is the list. `$schema` is tolerated for editor
 * validation, the same carve-out the `.json` boundary dialect makes.
 */
const REGISTRY_KEYS = ["profiles", "version", "$schema"];

/** A version a reader that predates it must refuse, per `docs/reference/profiles.md`. */
export const PROFILE_REGISTRY_SCHEMA_VERSION = 1;

/** The three keys a profile's `block` may carry, exactly those `policyFrom` reads. */
const BLOCK_KEYS = ["depConstraints", "moduleBoundaryOptions", "boundarySuppressions"];

/**
 * A profile `name`, matched exactly by `resolveProfile` and typed by an
 * operator at `--config`/`boundaryConfig`. Restricted to the same safe set
 * `../architecture-intent/model.mjs`'s boundary names and
 * `./fitness-registry.mjs`'s fitness names already use, and for the identical
 * reason: a name is a selector, not a label, so two names that a human reads
 * as identical must not be able to exist as two different values. Unicode
 * (a zero-width character, a homoglyph from another script, two normalisation
 * forms of the same visible glyph) can make two byte-distinct strings render
 * identically — the duplicate check below compares the raw string, which
 * would accept both as "unique" and then resolve whichever one an operator's
 * literal `--config` argument happened to byte-match, silently enforcing the
 * OTHER one's block. Refusing every character outside this set closes that
 * off at the source: two names that display the same are now always the same
 * string, so the existing duplicate check is sufficient again.
 */
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/u;

/** @type {(value: unknown) => value is Record<string, unknown>} */
const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function describe(value) {
  if (Array.isArray(value)) return `an array (${JSON.stringify(value)})`;
  if (value === null) return "null";
  return `${typeof value} (${JSON.stringify(value) ?? String(value)})`;
}

/** A profile's declared block, kept ONLY for this command's own data. */
export function listNames(registry) {
  return registry.profiles.map((profile) => profile.name);
}

/**
 * Everything wrong with a registry, as messages; empty when it is well-formed.
 * Pure, so a test drives it without a file on disk.
 *
 * Every condition is a silent-direction guard: a registry the reader cannot
 * trust must not be read as smaller than it is.
 *
 * @param {unknown} raw The parsed JSON value.
 * @returns {string[]}
 */
export function profileRegistryViolations(raw) {
  if (!isPlainObject(raw)) {
    return [`profiles: expected a JSON object, got ${describe(raw)}`];
  }
  const violations = [];
  for (const key of Object.keys(raw)) {
    if (!REGISTRY_KEYS.includes(key)) {
      violations.push(
        `${key}: not a recognised profiles-file key — expected one of ${REGISTRY_KEYS.join(", ")}`,
      );
    }
  }
  if (raw.version !== undefined && raw.version !== PROFILE_REGISTRY_SCHEMA_VERSION) {
    violations.push(
      `version: expected ${PROFILE_REGISTRY_SCHEMA_VERSION}, got ${describe(raw.version)} — ` +
        `a registry this reader does not understand must refuse rather than guess`,
    );
  }
  if (!Array.isArray(raw.profiles)) {
    violations.push(`profiles: must be an array of profiles, got ${describe(raw.profiles)}`);
    return violations;
  }
  const names = new Set();
  raw.profiles.forEach((profile, index) => {
    const at = `profiles[${index}]`;
    if (!isPlainObject(profile)) {
      violations.push(`${at}: must be an object, got ${describe(profile)}`);
      return;
    }
    const extra = Object.keys(profile).filter((key) => !["name", "base", "block"].includes(key));
    for (const key of extra) {
      violations.push(
        `${at}.${key}: not a profile field — a profile may carry only name, base, block`,
      );
    }
    if (typeof profile.name !== "string" || !NAME_PATTERN.test(profile.name)) {
      violations.push(
        `${at}.name: must be a non-empty string of letters, digits, "-" or "_", got ${describe(profile.name)}`,
      );
    } else if (names.has(profile.name)) {
      violations.push(
        `${at}.name: "${profile.name}" is declared more than once — every profile name must be unique`,
      );
    } else {
      names.add(profile.name);
    }
    if (profile.base !== undefined && profile.base !== null) {
      if (typeof profile.base !== "string" || profile.base.trim() === "") {
        violations.push(
          `${at}.base: must be a non-empty string naming another profile, got ${describe(profile.base)}`,
        );
      }
    }
    if (!isPlainObject(profile.block)) {
      violations.push(`${at}.block: must be a policy block object, got ${describe(profile.block)}`);
      return;
    }
    const blockExtra = Object.keys(profile.block).filter((key) => !BLOCK_KEYS.includes(key));
    for (const key of blockExtra) {
      violations.push(
        `${at}.block.${key}: not a policy block field — expected one of ${BLOCK_KEYS.join(", ")}`,
      );
    }
  });
  return violations;
}

/**
 * Everything wrong with a profile's reference graph — unknown `base` and
 * `base` cycles. Separated from `profileRegistryViolations` so a test can pin
 * each loud condition by name.
 *
 * @param {object[]} profiles Validated profile objects.
 * @returns {string[]}
 */
export function profileReferenceViolations(profiles) {
  const violations = [];
  const byName = new Map(profiles.map((profile) => [profile.name, profile]));
  for (const profile of profiles) {
    if (profile.base === undefined || profile.base === null) continue;
    const stack = new Set([profile.name]);
    let current = /** @type {string} */ (profile.base);
    while (current !== undefined && current !== null) {
      if (stack.has(current)) {
        violations.push(
          `profiles: "${profile.name}"'s base chain contains a cycle through "${current}" — ` +
            `a cycle has no deterministic resolution`,
        );
        break;
      }
      const next = byName.get(current);
      if (next === undefined) {
        violations.push(
          `profiles: "${profile.name}" names base "${current}" but no profile with that name exists — ` +
            `read as "no base", the stack would shed the rows it was meant to inherit`,
        );
        break;
      }
      stack.add(current);
      current =
        next.base === null || next.base === undefined
          ? undefined
          : /** @type {string} */ (next.base);
    }
  }
  return violations;
}

/**
 * The effective policy block for a profile, its base chain resolved depth-first
 * with the documented precedence: rows append, option keys overwrite.
 *
 * @param {object[]} profiles The registry's full profile list.
 * @param {string} name The profile to resolve.
 * @param {Set<string>} [seen] Inheritance stack (used internally by recursion).
 * @returns {{depConstraints: object[], moduleBoundaryOptions: object, boundarySuppressions: object[]}}
 * @throws {Error} when `name` does not exist or its base chain cycles — never
 *   silently resolved as "no profile".
 */
export function resolveProfile(profiles, name, seen = new Set()) {
  const profile = profiles.find((candidate) => candidate.name === name);
  if (profile === undefined) {
    throw new Error(
      `lattice: profile "${name}" does not exist — a policy that selects an unknown profile ` +
        `enforces nothing and says nothing`,
    );
  }
  if (seen.has(name)) {
    throw new Error(
      `lattice: profile "${name}"'s base chain contains a cycle through "${name}" — ` +
        `a cycle has no deterministic resolution`,
    );
  }
  seen.add(name);
  const base =
    profile.base === undefined || profile.base === null
      ? null
      : resolveProfile(profiles, /** @type {string} */ (profile.base), seen);
  const block = profile.block;
  const options =
    base === null
      ? { ...block.moduleBoundaryOptions }
      : { ...base.moduleBoundaryOptions, ...block.moduleBoundaryOptions };
  return {
    depConstraints: [...(base?.depConstraints ?? []), ...(block.depConstraints ?? [])],
    moduleBoundaryOptions: options,
    boundarySuppressions: [
      ...(base?.boundarySuppressions ?? []),
      ...(block.boundarySuppressions ?? []),
    ],
  };
}

/**
 * Loads the profiles registry named by the `profiles` plugin option, validates
 * it by name, and throws loudly on any defect.
 *
 * @param {string} path Absolute path of the profiles file.
 * @param {{readFile?: (path: string) => string|null}} [io] Injectable read,
 *   the same seam `../../options.mjs`'s readers take; answers `null` when the
 *   file is not there.
 * @returns {{profiles: object[]}}
 * @throws {Error} on a missing/unreadable/unparseable file, or on any
 *   profile-registry or reference-graph defect.
 */
export function loadProfileRegistry(
  path,
  {
    readFile = (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
  } = {},
) {
  const text = readFile(path);
  if (text === null) {
    throw new Error(`lattice: cannot read profiles file ${path}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`lattice: cannot parse profiles file ${path}: ${cause?.message ?? cause}`, {
      cause,
    });
  }
  const violations = [
    ...profileRegistryViolations(parsed),
    ...(parsed && Array.isArray(parsed.profiles)
      ? profileReferenceViolations(parsed.profiles)
      : []),
  ];
  if (violations.length > 0) {
    throw new Error(`lattice: ${path} is malformed:\n  ${violations.join("\n  ")}`);
  }
  /** @type {{profiles: object[]}} */ (parsed);
  return parsed;
}

/**
 * The full profile path `cli.mjs`'s `check` takes when a workspace selects a
 * profile by name: load the registry, resolve the named profile to its
 * effective block, and run that through the SAME `policyFrom` tail every
 * boundary-config dialect uses — one enforcement path, named.
 *
 * @param {string} registryPath Absolute path of the profiles file.
 * @param {string} profileName The profile to resolve.
 * @param {string} sourceLabel What failed, named in the thrown message.
 * @param {{readFile?: (path: string) => string|null}} [io]
 * @returns {{depConstraints: object[], options: object, suppressions: object[], fitness?: object[]}}
 * @throws {Error} when the registry or the named profile is defective.
 */
export function profilePolicy(registryPath, profileName, sourceLabel, io = {}) {
  const registry = loadProfileRegistry(registryPath, io);
  const effective = resolveProfile(registry.profiles, profileName);
  return policyFrom(effective, `${sourceLabel} (profile "${profileName}")`);
}

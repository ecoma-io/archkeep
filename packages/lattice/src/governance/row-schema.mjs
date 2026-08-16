/**
 * The shared governance row schema — the ONE row extension every governance
 * capability in this wave reads from, and the single set of validators that
 * row owners invoke. Contract 2 of the master plan.
 *
 * A "row" is one rule/fitness statement in a governance declaration: a
 * `depConstraints` entry in the boundary law, a row in `architecture-intent.json`
 * (`allowed`/`forbidden`/`projects`/`dependencies`/`forbiddenTags`), a fitness
 * rule, an ADR decision. Every row may optionally carry the governance block:
 *
 * ```json
 * {
 *   "origin": { "by": "jane@example.com", "tool": "lattice:v1" },
 *   "rationale": "why this row exists",
 *   "decisionRef": "adr:0012",
 *   "fitnessBindings": ["fitness:hotspot"]
 * }
 * ```
 *
 * ## The additivity rule — old rows stay valid, byte-identical
 *
 * Every key below is optional. A row written before governance existed does
 * not carry the block, and it must parse to exactly the same object it parsed
 * to before this module existed — the block is a delta a row owner accepts,
 * never a reshape. That is the byte-identity half of the invariant; the
 * owners (`../config.mjs`, `../architecture-intent/model.mjs`) call the
 * validators and pass the row through untouched.
 *
 * ## One validator set, no duplicates across the wave
 *
 * Every governance capability's row gains the same four keys from this one
 * module, so there is one shape check per key for the whole wave. A row owner
 * that hand-rolled its own `origin` check would be a second copy that drifts
 * the first time provenance-record.mjs changes. `rowSchemaViolations` is the
 * entry; the four key-specific validators live here and nowhere else.
 *
 * ## The `decisionRef` and `fitnessBindings` resolution contract
 *
 * `decisionRef` names the ADR (or rule/fitness id) that decides the row;
 * `fitnessBindings` names the fitness rules that measure it. Shape is
 * validated here; RESOLUTION is the capability that owns the registry
 * (the ADR capability's registry, the fitness catalogue), injected rather
 * than imported so this module stays the small contract and nothing here
 * hard-codes which governance objects exist. A reference that cannot resolve
 * is a load error, loud — a rule that reads as bound while nothing binds it
 * is the silent direction (`AGENTS.md`).
 *
 * ## Determinism
 *
 * `origin.on` — the only timestamp a row may carry — is produced by
 * `../governance/provenance-record.mjs`'s `recordOrigin`, which refuses to run
 * without `../governance/clock.mjs`. Read-side validation here checks an
 * `on` already committed as a static fact, never invents one: a row that
 * omits `on` stays byte-identical across every run, and a row that records it
 * records a fact about committed bytes, not about the wall clock of whatever
 * machine happened to read the file.
 */

import { originViolations } from "./provenance-record.mjs";

/** The shape of any `origin.on` producer. Re-exported for a row owner's own docs. */
export { clockViolations as clockValidation } from "./clock.mjs";

/** The four governance keys a row may carry, in the order reports list them. */
export const GOVERNANCE_ROW_KEYS = Object.freeze([
  "origin",
  "rationale",
  "decisionRef",
  "fitnessBindings",
]);

/**
 * @typedef {import("./provenance-record.mjs").OriginRecord} OriginRecord
 */

/**
 * @typedef {object} GovernanceRowBlock
 * @property {OriginRecord} [origin] Who decided the row, with which tool and —
 *   when the clock was passed — when.
 * @property {string} [rationale] Free-text "why", for a human or an agent
 *   reading the row. No format enforced.
 * @property {string} [decisionRef] Id of the decision that makes the row
 *   enforceable — an ADR id (`adr:0012` / `0012-slug`), a rule id
 *   (`rule:no-direct-dep`), or a fitness id (`fitness:hotspot`).
 * @property {string[]} [fitnessBindings] Fitness ids this row is bound to.
 */

/** @type {(value: unknown) => value is Record<string, unknown>} */
const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A value's type, for an error message that shows what was actually there. */
function describe(value) {
  if (Array.isArray(value)) return `an array (${JSON.stringify(value)})`;
  if (value === null) return "null";
  return `${typeof value} (${JSON.stringify(value) ?? String(value)})`;
}

/**
 * Everything wrong with a row's `rationale`, `decisionRef`, or
 * `fitnessBindings` — the three string-shaped governance keys. `origin` has
 * its own validator (`./provenance-record.mjs`); this one covers the rest so
 * a row owner asks exactly one function.
 *
 * @param {unknown} raw The raw row object.
 * @param {string} at Dotted path of the row, e.g. `forbidden[3]`, for messages.
 * @returns {string[]}
 */
export function governanceBlockViolations(raw, at) {
  if (!isPlainObject(raw)) return [];
  const violations = [];

  if ("rationale" in raw) {
    if (typeof raw.rationale !== "string" || raw.rationale.trim() === "") {
      violations.push(
        `${at}.rationale: must be a non-empty string when present, got ${describe(raw.rationale)} — ` +
          `a reason that cannot be read is a reason nobody can rely on`,
      );
    }
  }

  if ("decisionRef" in raw) {
    if (typeof raw.decisionRef !== "string" || raw.decisionRef.trim() === "") {
      violations.push(
        `${at}.decisionRef: must be a non-empty string naming a decision (an ADR id like "adr:0012", ` +
          `or a rule/fitness id like "rule:keep-a" / "fitness:hotspot"), got ${describe(raw.decisionRef)}`,
      );
    }
  }

  if ("fitnessBindings" in raw) {
    const bindings = raw.fitnessBindings;
    if (!Array.isArray(bindings)) {
      violations.push(
        `${at}.fitnessBindings: must be an array of non-empty strings, got ${describe(bindings)}`,
      );
    } else if (bindings.length === 0) {
      violations.push(
        `${at}.fitnessBindings: must not be empty — a list present but empty reads as binding while ` +
          `binding nothing`,
      );
    } else {
      bindings.forEach((binding, index) => {
        if (typeof binding !== "string" || binding.trim() === "") {
          violations.push(
            `${at}.fitnessBindings[${index}]: must be a non-empty string, got ${describe(binding)}`,
          );
        }
      });
    }
  }

  return violations;
}

/**
 * The full governance-block validation for one row: `origin` shape (via the
 * provenance record), then the three string-shaped keys. Resolution of a
 * `decisionRef` / `fitnessBindings` id is the registry capability's, injected
 * as `io.resolve` when a caller has one.
 *
 * @param {unknown} raw The raw row object.
 * @param {string} at Dotted path of the row, for messages, e.g. `forbidden[3]`.
 * @param {{resolve?: (key: "decisionRef"|"fitnessBindings", id: string) => boolean,
 *   kindLabel?: string}} [io] `resolve` answers "does this id name something
 *   known?"; `kindLabel` names what `resolve` knows about, for the error
 *   message.
 * @returns {string[]} Empty when the row's governance block is valid.
 */
export function rowSchemaViolations(raw, at, io = {}) {
  if (!isPlainObject(raw)) return [];

  const violations = [];

  if ("origin" in raw) {
    violations.push(...originViolations(raw.origin).map((m) => `${at}.${m}`));
  }
  violations.push(...governanceBlockViolations(raw, at));

  // Resolution half — a reference that cannot resolve is a load error, loud.
  if (io.resolve) {
    if (typeof raw.decisionRef === "string" && raw.decisionRef.trim() !== "") {
      if (!io.resolve("decisionRef", raw.decisionRef)) {
        violations.push(
          `${at}.decisionRef: "${raw.decisionRef}" does not resolve — it names no ${io.kindLabel ?? "declared decision"} ` +
            `(no ADR with that id, and no rule or fitness id with that name). A rule that cannot be ` +
            `bound is the silent direction; fix the reference or record the decision it names.`,
        );
      }
    }
    if (Array.isArray(raw.fitnessBindings)) {
      raw.fitnessBindings.forEach((binding, index) => {
        if (
          typeof binding === "string" &&
          binding.trim() !== "" &&
          !io.resolve("fitnessBindings", binding)
        ) {
          violations.push(
            `${at}.fitnessBindings[${index}]: "${binding}" does not resolve — it names no ${io.kindLabel ?? "declared fitness"} ` +
              `with that id. A rule that cannot be measured is the silent direction; fix the binding or record the fitness rule it names.`,
          );
        }
      });
    }
  }

  return violations;
}

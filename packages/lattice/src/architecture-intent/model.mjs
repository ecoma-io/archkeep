/**
 * Architecture Intent — grammar, validation, and loading.
 *
 * `architecture-intent.json` at a workspace root declares the architecture the
 * team intends to preserve — which groups of projects share a role (boundaries)
 * and, per boundary pair, which dependencies are allowed and which are
 * forbidden. The observed architecture stays the graph Lattice derives from
 * source; governance is a deterministic comparison (`./judge.mjs`). NO LLM/AI
 * anywhere in the core.
 *
 * This module mirrors `../../config.mjs`'s and
 * `../../providers/native/model.mjs`'s split: a pure `(raw) -> string[]`
 * validator and a thin loader that reads, parses, validates and throws — one
 * Error naming every violation at once.
 *
 * Three non-obvious contracts, each the honest side of the empty-result
 * invariant (`../../../../AGENTS.md` — an empty list must mean "no violation",
 * and nothing else):
 *
 *   - **It is strict JSON, never JSONC.** This is this tool's own file that Nx
 *     never opens, so the leniency argument `native/model.mjs`'s header makes
 *     for `lattice.json` does not apply; a comment or trailing comma is a load
 *     error (exit 3), loud. The human need for prose is served by `reason`, not
 *     comments.
 *   - **An unknown key or selector label is rejected by name** — never folded
 *     into a general "ignore unknown" rule. A `tagz:x` typo for `tag:x`
 *     surfaces red, because a selector nobody understands is how a boundary
 *     silently matches nothing.
 *   - **Validation is nodes-free.** Whether a boundary selects zero projects is
 *     a semantic question that needs the observed graph, so it belongs to the
 *     judge (`./judge.mjs`) as a *no-verdict*, not here. A workspace that has
 *     not scaffolded a project yet must still load and be told its boundary is
 *     empty — loudly — rather than fail to load at all.
 */

import { readFile as readFileFromDisk } from "node:fs/promises";

import { isValidSelector, splitSelector } from "./selectors.mjs";

/** The base name of the root file this module reads. */
export const INTENT_FILE = "architecture-intent.json";

/** The one supported `version`. A different value is a load error. */
export const INTENT_VERSION = "1";

/** The only keys a valid intent file may carry at the top level. */
export const TOP_LEVEL_KEYS = Object.freeze(["version", "boundaries", "allowed", "forbidden"]);

/** The keys a boundary entry may carry. */
const BOUNDARY_KEYS = Object.freeze(["name", "match"]);

/** The keys an allowed/forbidden row may carry. */
const ROW_KEYS = Object.freeze(["from", "to", "reason", "optional"]);

/** A boundary `name`, matched exactly by the loaders — names can never contain `:`, so a name can never collide with a `name:`-prefixed selector. */
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/u;

/** A value's type, for an error message that shows what was actually there. */
function describe(value) {
  if (Array.isArray(value)) return `an array (${JSON.stringify(value)})`;
  if (value === null) return "null";
  return `${typeof value} (${JSON.stringify(value) ?? String(value)})`;
}

/** @type {(value: unknown) => value is Record<string, unknown>} */
const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `key` on `obj` that is not one of `allowed` — for the reject-by-name rule. */
function unknownKeys(obj, allowed) {
  return Object.keys(obj).filter((key) => !allowed.includes(key));
}

/**
 * A `from`/`to` side is either a declared boundary name (which wins,
 * deterministically) or an inline selector — so it must be one of those two,
 * never an arbitrary string. A side that is neither is a typo that would
 * silently match nothing at judge time; it is a load error instead.
 */
function rowSideValid(side, names) {
  return typeof side === "string" && side.length > 0 && (names.has(side) || isValidSelector(side));
}

/**
 * Whether a selector can match at most one project on every graph — true for
 * `name:x` and a bare `x` (both exact project-name matches), false for
 * `tag:`, `directory:` and `*`. Used to tell a single-project self-ban from a
 * same-tag ban that legitimately has cross-pairs.
 * @param {string} selector
 * @returns {boolean}
 */
function isSingleProjectSelector(selector) {
  if (!isValidSelector(selector)) return false;
  const { label, value } = splitSelector(selector);
  return value !== "*" && label !== "tag" && label !== "directory";
}

/**
 * The declared boundary names in a validated file, in order — what `from`/`to`
 * resolve against.
 */
export function boundaryNames(intent) {
  return (intent.boundaries ?? []).map((b) => b.name);
}

/**
 * Everything wrong with a raw intent file, as messages; empty when it is
 * well-formed. Pure and nodes-free — membership is the judge's question.
 *
 * @param {unknown} raw The parsed JSON value.
 * @returns {string[]}
 */
export function findIntentViolations(raw) {
  const violations = [];

  if (!isPlainObject(raw)) {
    return [`top level: must be an object, got ${describe(raw)}`];
  }
  const unknownTop = unknownKeys(raw, TOP_LEVEL_KEYS);
  for (const key of unknownTop) {
    violations.push(
      `unknown key "${key}" — architecture-intent.json may carry only ${TOP_LEVEL_KEYS.join(", ")}`,
    );
  }

  if (raw.version !== INTENT_VERSION) {
    violations.push(`version: must be exactly "${INTENT_VERSION}", got ${describe(raw.version)}`);
  }

  const boundaries = raw.boundaries;
  if (boundaries === undefined) {
    violations.push("boundaries: is required");
  } else if (!Array.isArray(boundaries)) {
    violations.push(`boundaries: must be an array, got ${describe(boundaries)}`);
  } else if (boundaries.length === 0) {
    violations.push(
      "boundaries: must not be empty — a file that reads as protection while matching nothing is the silent direction",
    );
  } else {
    const names = new Set();
    boundaries.forEach((boundary, index) => {
      const at = `boundaries[${index}]`;
      if (!isPlainObject(boundary)) {
        violations.push(`${at}: must be an object, got ${describe(boundary)}`);
        return;
      }
      for (const key of unknownKeys(boundary, BOUNDARY_KEYS)) {
        violations.push(
          `${at}.${key}: unknown key — a boundary may carry only ${BOUNDARY_KEYS.join(", ")}`,
        );
      }
      if (typeof boundary.name !== "string" || !NAME_PATTERN.test(boundary.name)) {
        violations.push(
          `${at}.name: must be a non-empty string of letters, digits, "-" or "_" (no ":"), got ${describe(boundary.name)}`,
        );
      } else {
        if (names.has(boundary.name)) {
          violations.push(
            `${at}.name: "${boundary.name}" is declared more than once — every boundary name must be unique`,
          );
        }
        names.add(boundary.name);
      }
      const match = boundary.match;
      if (!Array.isArray(match)) {
        violations.push(`${at}.match: must be an array of selectors, got ${describe(match)}`);
      } else if (match.length === 0) {
        violations.push(
          `${at}.match: must not be empty — a boundary with no selectors matches nothing`,
        );
      } else {
        match.forEach((selector, selIndex) => {
          if (!isValidSelector(selector)) {
            const st = splitSelector(selector);
            const why =
              st.label !== null && !["name", "tag", "directory"].includes(st.label)
                ? `"${st.label}:" is not a selector label (name:, tag:, directory:, "*" or a bare project name)`
                : `selectors may be "name:x", "tag:x", "directory:x", "*" or a bare project name, optionally "!"-prefixed, with no glob or regular expression`;
            violations.push(
              `${at}.match[${selIndex}]: invalid selector ${JSON.stringify(selector)} — ${why}`,
            );
          }
        });
      }
    });
  }

  for (const listName of ["allowed", "forbidden"]) {
    const list = raw[listName];
    if (list === undefined) {
      continue;
    }
    if (!Array.isArray(list)) {
      violations.push(`${listName}: must be an array, got ${describe(list)}`);
      continue;
    }
    if (list.length === 0) {
      violations.push(
        `${listName}: must not be empty — a list present but empty reads as policy while deciding nothing`,
      );
      continue;
    }
    // The declared boundary names a side may reference, collected after the
    // boundary block above so a row naming a boundary never precedes it.
    const names = new Set(
      (Array.isArray(boundaries) ? boundaries : [])
        .filter(isPlainObject)
        .map((b) => (typeof b.name === "string" ? b.name : "")),
    );
    list.forEach((row, index) => {
      const at = `${listName}[${index}]`;
      if (!isPlainObject(row)) {
        violations.push(`${at}: must be an object, got ${describe(row)}`);
        return;
      }
      for (const key of unknownKeys(row, ROW_KEYS)) {
        violations.push(`${at}.${key}: unknown key — a row may carry only ${ROW_KEYS.join(", ")}`);
      }
      if (!rowSideValid(row.from, names)) {
        violations.push(
          `${at}.from: must reference a declared boundary (${names.size > 0 ? [...names].join(", ") : "none declared"}) or a valid selector, got ${describe(row.from)}`,
        );
      }
      if (!rowSideValid(row.to, names)) {
        violations.push(
          `${at}.to: must reference a declared boundary (${names.size > 0 ? [...names].join(", ") : "none declared"}) or a valid selector, got ${describe(row.to)}`,
        );
      }
      if (listName === "forbidden") {
        if (typeof row.reason !== "string" || row.reason.length === 0) {
          violations.push(
            `${at}.reason: is required on a forbidden row — a ban no one can explain is how a ban is deleted`,
          );
        }
        if (row.optional !== undefined && typeof row.optional !== "boolean") {
          violations.push(`${at}.optional: must be a boolean, got ${describe(row.optional)}`);
        }
        if (row.optional === true) {
          violations.push(
            `${at}.optional: is not allowed on a forbidden row — a conditional ban is a different concept; state it as two rows`,
          );
        }
        // A self-ban that can never fire: both sides resolve to ONE same
        // project, so the row forbids nothing and reading it as "clean — the
        // ban holds" would be the silent direction. The load-provable
        // spellings are rejected here, nodes-free; the ones only the graph can
        // prove (two different selectors landing on one project) are the
        // judge's call (`../judge.mjs` renders them a no-verdict, never
        // clean). Two spellings prove a single project with no graph in hand:
        //   - both sides name the same declared boundary;
        //   - both sides name the same `name:`/bare selector, which resolves
        //     to that one project by exact match (`../selectors.mjs`).
        // A same `tag:` or `*` is NOT this case: the set can hold many
        // projects, the row has real cross-pairs ("no tag:X may reach another
        // tag:X"), and it judges normally — a ban is still a ban.
        if (
          typeof row.from === "string" &&
          typeof row.to === "string" &&
          row.from === row.to &&
          (names.has(row.from) || isSingleProjectSelector(row.from))
        ) {
          const which = names.has(row.from)
            ? `name the same declared boundary "${row.from}"`
            : `name the same selector "${row.from}", which selects a single project`;
          violations.push(
            `${at}: from and to ${which} — a self-ban on one boundary is a cycle; say it as a depConstraints row instead`,
          );
        }
      } else {
        // The allowed side. Self-reference is fine here — a boundary may
        // legitimately reach itself — so there is no self-ban check, but the
        // optional/reason TYPE checks still apply.
        if (row.reason !== undefined && typeof row.reason !== "string") {
          violations.push(
            `${at}.reason: must be a string when present, got ${describe(row.reason)}`,
          );
        }
        if (row.optional !== undefined && typeof row.optional !== "boolean") {
          violations.push(`${at}.optional: must be a boolean, got ${describe(row.optional)}`);
        }
      }
    });
  }

  // Rule 7: allowed ⊕ forbidden overlap. A from/to pair in both lists is
  // ambiguous — the same dependency cannot be both explicitly allowed and
  // explicitly forbidden. State the allowed pair minus the forbidden one as
  // two rows instead.
  /**
   * The from→to pairs one list states, in its own order.
   * @param {unknown} list
   * @returns {string[]}
   */
  const statedPairs = (list) =>
    (Array.isArray(list) ? list : [])
      .filter(isPlainObject)
      .filter((row) => typeof row.from === "string" && typeof row.to === "string")
      .map((row) => `${row.from}→${row.to}`);
  const allowedPairs = statedPairs(raw.allowed);
  const forbiddenPairs = statedPairs(raw.forbidden);
  for (const pair of forbiddenPairs) {
    if (allowedPairs.includes(pair)) {
      violations.push(
        `allowed and forbidden both state "${pair}" — the same pair must be stated once; forbid the exceptions and allow the rest as two rows`,
      );
    }
  }

  return violations;
}

/**
 * The intent file as a validated, ready-to-judge model. `loadIntent` throws ONE
 * Error naming every violation when the file is malformed — the caller turns
 * that into a whole-file failure (exit 3), the same posture `../../cli.mjs`
 * takes for a `go.work` it cannot read (`../../go-work.mjs`).
 *
 * @param {object} intent The validated intent object.
 * @returns {object} The normalized model: `{version, boundaries: {name, match, members?}[], allowed, forbidden}`.
 */
export function normalizeIntent(intent) {
  return {
    version: intent.version,
    boundaries: intent.boundaries.map((b) => ({ name: b.name, match: [...b.match] })),
    allowed: intent.allowed ?? [],
    forbidden: intent.forbidden ?? [],
  };
}

/**
 * Read, parse and validate `architecture-intent.json` at `root`.
 *
 * @param {string} root Absolute workspace root.
 * @param {{read?: (path: string, encoding: "utf8") => Promise<string>, tracked?: string[]}} [io]
 *   Injectable read, defaulting to `node:fs/promises`' `readFile` — the only
 *   code in this function that reaches outside the process; `tracked` is the
 *   `git ls-files` list, and when provided and the file is not in it, the
 *   loader treats the file as absent (an untracked intent file is not the
 *   reviewed repository state, the same edge `../../go-work.mjs` documents).
 * @returns {Promise<object>} The normalized, validated model, or `undefined` when the file is absent.
 * @throws {Error} naming every validation violation at once.
 */
export async function loadIntent(root, { read = readFileFromDisk, tracked } = {}) {
  const path = `${root}/${INTENT_FILE}`;
  if (tracked !== undefined && !tracked.includes(INTENT_FILE)) {
    return undefined;
  }
  let text;
  try {
    text = await read(path, "utf8");
  } catch (cause) {
    if (cause?.code === "ENOENT") return undefined;
    throw new Error(`${INTENT_FILE}: could not be read: ${cause?.message ?? cause}`, { cause });
  }
  let raw;
  try {
    // Strict JSON only — see the header.
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${INTENT_FILE}: is not valid strict JSON: ${cause?.message ?? cause}`, {
      cause,
    });
  }
  const violations = findIntentViolations(raw);
  if (violations.length > 0) {
    throw new Error(`${INTENT_FILE}: ${violations.join("; ")}`);
  }
  return normalizeIntent(raw);
}

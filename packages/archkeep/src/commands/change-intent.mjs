/**
 * The change-intent contract — grammar, validation, and loading.
 *
 * A change intent is a PER-CHANGE declaration of the material architectural
 * consequences its author expects one specific edit to produce: which projects
 * appear or disappear, which project-to-project dependencies appear or
 * disappear, and which delta-level constraints the change must hold. It is
 * written beside the work, verified by the `change` command against the actual
 * architectural delta (`./change.mjs`), and then belongs to the pull request
 * as the reviewable answer to "what did this change do to the architecture?".
 *
 * This file mirrors `../architecture-intent/model.mjs`'s split — a pure
 * `(raw) -> string[]` validator, a thin loader that reads, parses, validates
 * and throws one Error naming every violation at once — and deliberately does
 * NOT extend that module: architecture-intent.json is the workspace's
 * long-lived law, judged by `drift`/`check`; a change intent names one
 * transaction's expected consequences and expires with its pull request. One
 * grammar per concept, so neither can grow the other's semantics by accident.
 *
 * Four contracts, each the honest side of the empty-result invariant
 * (`../../../../AGENTS.md` — an empty list must mean "nothing unexpected",
 * and nothing else):
 *
 *   - **It is strict JSON, never JSONC**, for the same reason
 *     `../architecture-intent/model.mjs` refuses comments: this is a
 *     machine-written declaration a verification run consumes, and a comment
 *     is a load error, not leniency.
 *   - **An unknown key is rejected by name**, never ignored — a typo'd
 *     section would silently declare nothing, and a run over a declaration
 *     that said nothing must not read as "the change declared nothing
 *     material".
 *   - **A duplicate declaration is a load error**, not last-one-wins: the
 *     contract is a SET of expected facts, and two rows under one fact would
 *     make the reconciliation depend on array order.
 *   - **Shape is nodes-free.** Whether a declared project reference can exist
 *     is a question about the captured baseline, so it belongs to the
 *     command (`./change.mjs`'s reference check), not here. A manifest must
 *     load and be told its references are wrong — loudly — rather than fail
 *     to parse at all.
 */

import { readFile as readFileFromDisk } from "node:fs/promises";

import { describe, isPlainObject } from "../values.mjs";

/** The only `version` this module accepts. A different value is a load error. */
const CHANGE_INTENT_VERSION = "1";

/** The only keys a valid change-intent file may carry at the top level. */
const CHANGE_INTENT_TOP_LEVEL_KEYS = Object.freeze([
  "version",
  "base",
  "summary",
  "projects",
  "edges",
  "constraints",
]);

/** The keys the `base` section may carry. */
const CHANGE_INTENT_BASE_KEYS = Object.freeze(["commit"]);

/** The sub-keys the `projects` section may carry. */
const CHANGE_INTENT_PROJECT_SECTION_KEYS = Object.freeze(["add", "remove"]);
/** The sub-keys the `edges` section may carry. */
const CHANGE_INTENT_EDGE_SECTION_KEYS = Object.freeze(["add", "remove"]);
/** The keys an edge row may carry. */
const CHANGE_INTENT_EDGE_ROW_KEYS = Object.freeze(["from", "to"]);
/** The keys the `constraints` section may carry. */
const CHANGE_INTENT_CONSTRAINT_KEYS = Object.freeze(["noNewViolations", "noNewCycles"]);

/**
 * The constraints the reconciliation judges, in the fixed order their verdict
 * rows are emitted — the order itself is part of the deterministic output
 * contract (`docs/reference/json-output.md`), so a manifest that declares them
 * in either order gets the same row order.
 */
export const CONSTRAINT_ORDER = Object.freeze(["noNewViolations", "noNewCycles"]);

/**
 * The manifest key a constraint row answers to, keyed by the row name the
 * report and JSON use. One copy, so a renamed key cannot desynchronize the
 * loader's accepted set from the judge's row names.
 */
export const CONSTRAINT_ROW_NAMES = Object.freeze({
  noNewViolations: "no-new-violations",
  noNewCycles: "no-new-cycles",
});

/**
 * The one spelling of a declared edge row's identity: the NUL-separated
 * `(from, to)` project pair. Two sites must read one edge declaration as one
 * fact — this module's duplicate rejection (the dedup key
 * `sectionListViolations` carries rows by) and `./change.mjs`'s
 * reconciliation (which matches a declared row against the observed graph's
 * `{source, target}`) — so the string is built here and imported, never
 * spelled twice. Two private spellings were the live defect this helper
 * closes (#613): they produced the same bytes until a shape moved, which is
 * byte-for-byte the silent direction — the reconciliation would stop
 * recognizing declarations it was handed while every command-local test
 * stayed green.
 *
 * The observed edge's `type` is deliberately not part of the pair: whether
 * the graph emits a dependency as `static` or `dynamic` is the model's
 * spelling, not the author's promise (`./change.mjs`, `reconcileMaterialDelta`).
 *
 * @param {{from: string, to: string}} row A validated edge row.
 * @returns {string}
 */
export function edgePairKey({ from, to }) {
  return `${from}\u0000${to}`;
}

/** `key` on `obj` that is not one of `allowed` — the reject-by-name rule. */
function unknownKeys(obj, allowed) {
  return Object.keys(obj).filter((key) => !allowed.includes(key));
}

/** Non-empty-string guard with its message fragment. */
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Everything wrong with the `projects`/`edges` sections' shared list shape —
 * present-or-absent wholesale, an array when present, strings (for projects)
 * or `{from, to}` rows (for edges) inside, no duplicates within a list, no
 * member of `add` also in `remove`. Written once for both sections because a
 * second copy of the duplicate rule is how the two sections drift into
 * answering "is this a set?" differently.
 *
 * @param {unknown} section The raw section value.
 * @param {{name: string, keys: readonly string[], row: (row: unknown, at: string) => string[],
 *   identity: (row: unknown) => string|null}} spec
 *   `name` is the dotted path prefix, `keys` the allowed sub-keys, `row` the
 *   per-element validator, `identity` the element's dedup key (or `null` when
 *   the element is malformed and already reported).
 * @returns {string[]}
 */
function sectionListViolations(section, spec) {
  const problems = [];
  if (section === undefined) return problems;
  if (!isPlainObject(section)) {
    problems.push(`${spec.name}: must be an object when present, got ${describe(section)}`);
    return problems;
  }
  for (const key of unknownKeys(section, spec.keys)) {
    problems.push(
      `${spec.name}.${key}: unknown key — ${spec.name} may carry only ${spec.keys.join(", ")}`,
    );
  }
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const kind of spec.keys) {
    const list = section[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      problems.push(`${spec.name}.${kind}: must be an array when present, got ${describe(list)}`);
      continue;
    }
    list.forEach((entry, index) => {
      const at = `${spec.name}.${kind}[${index}]`;
      const rowProblems = spec.row(entry, at);
      if (rowProblems.length > 0) {
        problems.push(...rowProblems);
        return;
      }
      const id = /** @type {string} */ (spec.identity(entry));
      const first = seen.get(id);
      if (first !== undefined) {
        problems.push(
          `${at}: duplicates ${spec.name}.${kind}[${first}] (${id}) — the contract is a set ` +
            `of expected facts, and a repeated declaration would make reconciliation depend ` +
            `on array order`,
        );
      } else {
        seen.set(id, index);
      }
    });
  }
  // An `add` and a `remove` naming the same fact cancel to nothing while
  // reading as a declaration — refuse the pair rather than reconcile a
  // contradiction.
  if (Array.isArray(section.add) && Array.isArray(section.remove)) {
    const removeIds = new Set(section.remove.map(spec.identity));
    section.add.forEach((entry, index) => {
      const id = spec.identity(entry);
      if (id !== null && removeIds.has(id)) {
        problems.push(
          `${spec.name}.add[${index}]: "${id}" is also declared in ${spec.name}.remove — ` +
            `a fact cannot be both expected to appear and expected to disappear`,
        );
      }
    });
  }
  return problems;
}

/**
 * Everything wrong with a raw change-intent file, as messages; empty when it
 * is well-formed. Pure — no baseline, no graph, no clock: whether a declared
 * reference CAN exist is `findChangeIntentReferenceViolations`' question,
 * below.
 *
 * @param {unknown} raw The parsed JSON value.
 * @returns {string[]}
 */
function findChangeIntentViolations(raw) {
  const violations = [];
  if (!isPlainObject(raw)) {
    return [`top level: must be an object, got ${describe(raw)}`];
  }
  for (const key of unknownKeys(raw, CHANGE_INTENT_TOP_LEVEL_KEYS)) {
    violations.push(
      `unknown key "${key}" — a change intent may carry only ` +
        `${CHANGE_INTENT_TOP_LEVEL_KEYS.join(", ")}`,
    );
  }

  if (raw.version !== CHANGE_INTENT_VERSION) {
    violations.push(
      `version: must be exactly "${CHANGE_INTENT_VERSION}", got ${describe(raw.version)}`,
    );
  }

  // The base pin is the whole proof that reconciliation compares the same two
  // architectures the author saw: without a commit there is nothing to verify
  // the baseline against, and the run must answer unproven rather than guess
  // (`./change.mjs`). So the section itself is required, not optional.
  if (!isPlainObject(raw.base)) {
    violations.push(`base: is required and must be an object, got ${describe(raw.base)}`);
  } else {
    for (const key of unknownKeys(raw.base, CHANGE_INTENT_BASE_KEYS)) {
      violations.push(
        `base.${key}: unknown key — base may carry only ${CHANGE_INTENT_BASE_KEYS.join(", ")}`,
      );
    }
    if (!nonEmptyString(raw.base.commit)) {
      violations.push(
        "base.commit: is required and must be a non-empty string — the git commit the " +
          "baseline snapshot was captured at (`archkeep delta --capture` records it in the " +
          "snapshot's provenance)",
      );
    }
  }

  if (raw.summary !== undefined && !nonEmptyString(raw.summary)) {
    violations.push(
      `summary: must be a non-empty string when present, got ${describe(raw.summary)} — it is ` +
        "informational only and is never read by the reconciliation",
    );
  }

  violations.push(
    ...sectionListViolations(raw.projects, {
      name: "projects",
      keys: CHANGE_INTENT_PROJECT_SECTION_KEYS,
      row: (entry, at) =>
        nonEmptyString(entry)
          ? []
          : [`${at}: must be a non-empty project name, got ${describe(entry)}`],
      identity: (entry) => (typeof entry === "string" ? entry : ""),
    }),
  );

  violations.push(
    ...sectionListViolations(raw.edges, {
      name: "edges",
      keys: CHANGE_INTENT_EDGE_SECTION_KEYS,
      row: (entry, at) => {
        if (!isPlainObject(entry)) {
          return [`${at}: must be an object with "from" and "to", got ${describe(entry)}`];
        }
        const problems = [];
        for (const key of unknownKeys(entry, CHANGE_INTENT_EDGE_ROW_KEYS)) {
          problems.push(
            `${at}.${key}: unknown key — an edge row may carry only ` +
              `${CHANGE_INTENT_EDGE_ROW_KEYS.join(", ")}`,
          );
        }
        for (const side of ["from", "to"]) {
          if (!nonEmptyString(entry[side])) {
            problems.push(
              `${at}.${side}: must be a non-empty project name, got ${describe(entry[side])}`,
            );
          }
        }
        if (nonEmptyString(entry.from) && entry.from === entry.to) {
          problems.push(
            `${at}: "from" and "to" are both "${entry.from}" — the project graph strips ` +
              `self-edges, so a self-dependency can never be observed and the declaration ` +
              `could never match`,
          );
        }
        return problems;
      },
      identity: (entry) =>
        isPlainObject(entry) && nonEmptyString(entry.from) && nonEmptyString(entry.to)
          ? edgePairKey(/** @type {{from: string, to: string}} */ (entry))
          : "",
    }),
  );

  if (raw.constraints !== undefined) {
    if (!isPlainObject(raw.constraints)) {
      violations.push(
        `constraints: must be an object when present, got ${describe(raw.constraints)}`,
      );
    } else {
      for (const key of unknownKeys(raw.constraints, CHANGE_INTENT_CONSTRAINT_KEYS)) {
        violations.push(
          `constraints.${key}: unknown key — constraints may carry only ` +
            `${CHANGE_INTENT_CONSTRAINT_KEYS.join(", ")}`,
        );
      }
      for (const key of CHANGE_INTENT_CONSTRAINT_KEYS) {
        const value = raw.constraints[key];
        if (value === undefined) continue;
        if (value !== true) {
          violations.push(
            `constraints.${key}: must be exactly true when present, got ${describe(value)} — ` +
              "a constraint this run should not judge is declared by omitting the key, not by " +
              "writing false",
          );
        }
      }
    }
  }

  return violations;
}
/**
 * The breadth guard (wave 3, design §5): everything wrong with a NORMALIZED
 * intent whose declaration is empty while its own prose asserts a change.
 *
 * An intent with zero declared rows — no project rows, no edge rows, no
 * declared constraints — declares that NOTHING material will change. Its
 * `summary`, if present, is the author's own statement of what the change
 * does; when the rows are empty that statement is a claim nothing in the
 * declaration can be verified against, and the reconciliation would read
 * `matched` over an unchanged tree while the author's prose says the tree
 * moved. Prose cannot assert what rows must state: this is the one bypass
 * around the grammar's reject-by-name discipline, and it is refused loudly
 * (`parseChangeIntent` throws, exit 3 upstream) instead of reconciling.
 *
 * The rule is deliberately stricter than "empty projects/edges": it also
 * requires the constraints section empty. A declared constraint IS a row —
 * `noNewViolations: true` states a verifiable promise, and an intent that
 * declares one is not a catch-all no matter what its summary says.
 *
 * @param {object} intent A `parseChangeIntent` result — the normalized shape,
 *   with absent raw sections already normalized to empty arrays.
 * @returns {string[]} Messages; empty when the intent is not a catch-all.
 */
function findChangeIntentBreadthViolations(intent) {
  const declaredRows =
    intent.projects.add.length +
    intent.projects.remove.length +
    intent.edges.add.length +
    intent.edges.remove.length +
    Object.keys(intent.constraints).length;
  if (declaredRows > 0 || intent.summary === undefined) return [];
  return [
    "summary: the intent declares no rows (no projects, no edges, no constraints) while its " +
      "summary asserts a material change — prose cannot assert what rows must state; declare " +
      "the material consequences in the rows, or drop the summary",
  ];
}

/**
 * Parses and validates change-intent text into the normalized shape the
 * `change` command reconciles against. Pure: text in, validated contract out.
 *
 * Absent sections normalize to empty expectations — a manifest with no
 * `projects` section expects no project to appear or disappear, which is a
 * REAL expectation the reconciliation enforces, never an absence of one.
 *
 * @param {string} text The file contents.
 * @param {string} path The path the text came from, for error messages.
 * @returns {{
 *   version: string,
 *   base: {commit: string},
 *   summary?: string,
 *   projects: {add: string[], remove: string[]},
 *   edges: {add: {from: string, to: string}[], remove: {from: string, to: string}[]},
 *   constraints: {noNewViolations?: true, noNewCycles?: true},
 * }}
 * @throws {Error} naming every violation at once — these become exit-3-class
 *   input errors upstream, and a run that consumed a malformed declaration
 *   silently would reconcile against an expectation nobody wrote.
 */
export function parseChangeIntent(text, path) {
  // used by its own test
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `archkeep: the change intent '${path}' is not valid JSON: ${cause?.message ?? cause}`,
      { cause },
    );
  }
  // Shape validation first, then the breadth guard over the NORMALIZED
  // intent — the guard's subject is the intent as the command will consume
  // it, with absent sections already normalized to empty expectations. Both
  // name every violation at once in the one throw below, so a malformed
  // catch-all is reported whole rather than piecemeal.
  const violations = findChangeIntentViolations(parsed);
  const intent = {
    version: parsed.version,
    // Defensive access: an invalid `base` is caught by the shape violations
    // below and thrown before this object is ever returned, so a missing
    // section must not crash the normalization itself.
    base: { commit: parsed.base?.commit },
    ...(parsed.summary === undefined ? {} : { summary: parsed.summary }),
    projects: {
      add: parsed.projects?.add ?? [],
      remove: parsed.projects?.remove ?? [],
    },
    edges: {
      add: (parsed.edges?.add ?? []).map(({ from, to }) => ({ from, to })),
      remove: (parsed.edges?.remove ?? []).map(({ from, to }) => ({ from, to })),
    },
    constraints: { ...(parsed.constraints ?? {}) },
  };
  violations.push(...findChangeIntentBreadthViolations(intent));
  if (violations.length > 0) {
    throw new Error(
      `archkeep: the change intent '${path}' is not a usable contract:\n  ` +
        violations.join("\n  "),
    );
  }
  return intent;
}

/**
 * Reads the change-intent file from a path — the module's one filesystem seam,
 * injectable so tests and embedders drive validation without disk.
 *
 * @param {string} path Absolute path to the manifest.
 * @param {{read?: (path: string) => Promise<string>}} [io]
 * @returns {Promise<object>} Whatever `parseChangeIntent` returns.
 * @throws {Error} when the file cannot be read, and whatever
 *   `parseChangeIntent` throws.
 */
export async function readChangeIntent(path, io = {}) {
  const read = io.read ?? ((p) => readFileFromDisk(p, "utf8"));
  let text;
  try {
    text = await read(path);
  } catch (cause) {
    throw new Error(
      `archkeep: cannot read the change intent '${path}': ${cause?.message ?? cause}`,
      { cause },
    );
  }
  return parseChangeIntent(text, path);
}

/**
 * Everything wrong with a loaded manifest's REFERENCES — whether each declared
 * fact could exist in a tree descended from the captured baseline. Pure: the
 * baseline's project-name set arrives as an argument.
 *
 * These are load errors too (the command throws on the first list), because a
 * declaration that references a project that exists nowhere would sit in
 * `missingExpected` forever, reading as "the change forgot something" when
 * the truth is "the declaration cannot be satisfied by ANY tree".
 *
 * @param {object} intent A `parseChangeIntent` result.
 * @param {Set<string>} baselineProjects Every project name in the captured
 *   baseline's graph.
 * @returns {string[]} One entry per problem, empty when every reference lands.
 */
export function findChangeIntentReferenceViolations(intent, baselineProjects) {
  const violations = [];
  const known = new Set([...baselineProjects, ...intent.projects.add]);
  for (const name of intent.projects.add) {
    if (baselineProjects.has(name)) {
      violations.push(
        `projects.add: "${name}" already exists at the captured base — a project the base ` +
          `graph already has cannot be declared as appearing`,
      );
    }
  }
  for (const name of intent.projects.remove) {
    if (!baselineProjects.has(name)) {
      violations.push(
        `projects.remove: "${name}" does not exist at the captured base — there is no such ` +
          `project to expect gone`,
      );
    }
  }
  for (const [kind, list] of [
    ["add", intent.edges.add],
    ["remove", intent.edges.remove],
  ]) {
    for (const { from, to } of list) {
      for (const side of ["from", "to"]) {
        const name = side === "from" ? from : to;
        if (kind === "add") {
          if (intent.projects.remove.includes(name)) {
            violations.push(
              `edges.${kind}: ${from} -> ${to} names "${name}" in projects.remove — an edge ` +
                `cannot appear attached to a project declared to disappear`,
            );
          } else if (!known.has(name)) {
            violations.push(
              `edges.${kind}: ${from} -> ${to} names "${name}", which is neither in the ` +
                `baseline graph nor declared in projects.add — the reference can never match ` +
                `anything`,
            );
          }
        } else if (!baselineProjects.has(name)) {
          violations.push(
            `edges.${kind}: ${from} -> ${to} names "${name}", which is not in the baseline ` +
              `graph — an edge of a project the base does not have cannot be expected to ` +
              `disappear${intent.projects.add.includes(name) ? " (it is declared in projects.add, so it had no base edges)" : ""}`,
          );
        }
      }
    }
  }
  return violations;
}

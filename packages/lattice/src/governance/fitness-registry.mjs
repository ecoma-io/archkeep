/**
 * Fitness Functions — parse, validate, and evaluate the workspace's declared
 * fitness functions against the observed architecture snapshot.
 *
 * A fitness function is a named, machine-checkable quality gate: "the graph
 * stays cycle-free", "no `layer:adapter` may reach `layer:domain`", "at least
 * 90% of statements are analyzed". It is declared in the workspace's ONE
 * executable policy file — `module-boundaries.config.mjs`'s `fitness` export
 * (or a native workspace's inline `boundaryConfig` object) — and evaluated
 * deterministically against the same observed facts every other check reads:
 * the project graph, the workspace analysis, the architecture intent, and the
 * boundary policy itself. NO LLM, no network, no clock: a fitness function is
 * a verdict a pipeline can reproduce, not a belief a reviewer holds.
 *
 * This module mirrors `../config.mjs`'s and `../architecture-intent/model.mjs`'s
 * split: a pure `(raw) -> string[]` validator (shared by the config loader, so
 * a malformed row fails where it is read) and a pure judge over an assembled
 * snapshot. The judge is the schema-driven evaluation base
 * `../architecture-intent/judge.mjs` provides — this module reuses
 * `resolveMembers` for `match` resolution and hands each condition the facts
 * it needs; it does NOT duplicate a judge.
 *
 * ## The invariant, per function
 *
 * The empty-result invariant (AGENTS.md) decides every branch. A function's
 * verdict is one of E0's four (`../governance/verdict.mjs`):
 *
 *   - `pass` — every requirement was evaluated and held. Only reachable when
 *     the evidence the condition needs was fully observed.
 *   - `fail` — a requirement was evaluated and broken.
 *   - `unknown` — the run could not determine the answer. A fitness it cannot
 *     determine MUST yield `unknown`, never `pass`. Two classes reach here:
 *     the condition's own evidence is missing (a `layer-dependency` tag no
 *     matched project carries; a `coverage-minimum` over zero owned
 *     statements; `drift-free` over no intent), and the function's `match`
 *     itself could not be judged against the observed graph.
 *   - `not_applicable` — a declared function whose `match` selects zero
 *     projects, so it could not be judged. Reported loudly — "declared but
 *     matches nothing" — never folded into `pass`. Invariant I4
 *     (`../governance/verdict.mjs`) requires it to name a
 *     `notApplicableReason`.
 *
 * ## Determinism
 *
 * Everything is sorted with plain `<` comparison, never `localeCompare`, and
 * evidence is serialized through `canonicalizeJson` for any fingerprint or
 * test that needs byte-identical output. Running the same snapshot through
 * the registry twice produces identical evidence.
 */
import { isValidSelector, resolveMembers } from "../architecture-intent/selectors.mjs";
import { languageOf } from "../analysis/registry.mjs";
import { canonicalizeJson } from "../canonical.mjs";
import { GOVERNANCE_ROW_KEYS, rowSchemaViolations } from "./row-schema.mjs";
import { fitnessVerdict, isVerdict } from "./verdict.mjs";
import {
  coverageMinimum,
  cycleFree,
  driftFree,
  layerDependency,
  suppressionThreshold,
  tagConformance,
} from "./fitness-rules.mjs";

/** The one `fitness` list key in the boundary config. */
export const FITNESS_KEY = "fitness";

/** The condition types the registry can evaluate. */
export const CONDITION_TYPES = Object.freeze([
  "cycle-free",
  "layer-dependency",
  "tag-conformance",
  "coverage-minimum",
  "boundary-suppression-count-within-threshold",
  "drift-free",
]);

/** The keys a fitness row may carry — the governance block rides additively. */
const ROW_KEYS = Object.freeze(["name", "match", "condition", "reason"]);

/** A fitness `name`, matched exactly — names can never contain `:`, so a name can never collide with a selector label. */
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/u;

/** The one `direction` a `layer-dependency` row may carry. */
const LAYER_DIRECTIONS = Object.freeze(["forbidden", "required"]);
/** The one `toDependents` a `tag-conformance` row may carry. */
const TAG_DEPENDENT_DIRECTIONS = Object.freeze(["only", "never"]);

/** @type {(value: unknown) => value is Record<string, unknown>} */
const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A value's type, for an error message that shows what was actually there. */
function describe(value) {
  if (Array.isArray(value)) return `an array (${JSON.stringify(value)})`;
  if (value === null) return "null";
  return `${typeof value} (${JSON.stringify(value) ?? String(value)})`;
}

function unknownKeys(obj, allowed) {
  return Object.keys(obj).filter((key) => !allowed.includes(key));
}

/**
 * Everything wrong with a `fitness` list, as messages; empty when it is
 * well-formed. Pure and nodes-free — membership is the judge's question.
 *
 * @param {unknown} list The parsed `fitness` value.
 * @returns {string[]}
 */
export function findFitnessViolations(list, io = {}) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    return [`fitness: must be an array of fitness rows, got ${describe(list)}`];
  }
  if (list.length === 0) {
    return [
      "fitness: must not be empty — a list present but empty reads as policy while deciding nothing",
    ];
  }

  const violations = [];
  const names = new Set();
  list.forEach((row, index) => {
    const at = `fitness[${index}]`;
    if (!isPlainObject(row)) {
      violations.push(`${at}: must be an object, got ${describe(row)}`);
      return;
    }
    for (const key of unknownKeys(row, [...ROW_KEYS, ...GOVERNANCE_ROW_KEYS])) {
      violations.push(
        `${at}.${key}: unknown key — a fitness row may carry only ` +
          `${ROW_KEYS.join(", ")}, plus the governance block keys ` +
          `${GOVERNANCE_ROW_KEYS.join(", ")}`,
      );
    }
    // The shared governance block (Contract 2): a fitness row is a policy
    // decision like any other row, so the same `origin`/`rationale`/
    // `decisionRef`/`fitnessBindings` shape — and, when a caller has a
    // registry, the same resolution half — applies. Additive: a legacy row
    // without the block stays valid byte-identical.
    violations.push(...rowSchemaViolations(row, at, io));
    if (typeof row.name !== "string" || !NAME_PATTERN.test(row.name)) {
      violations.push(
        `${at}.name: must be a non-empty string of letters, digits, "-" or "_" (no ":"), got ${describe(row.name)}`,
      );
    } else {
      if (names.has(row.name)) {
        violations.push(
          `${at}.name: "${row.name}" is declared more than once — every fitness name must be unique`,
        );
      }
      names.add(row.name);
    }
    const match = row.match;
    if (!Array.isArray(match) || match.length === 0) {
      violations.push(
        `${at}.match: must be a non-empty array of project selectors, got ${describe(match)}`,
      );
    } else {
      match.forEach((selector, selIndex) => {
        if (!isValidSelector(selector)) {
          violations.push(
            `${at}.match[${selIndex}]: must be a valid project selector ` +
              `(name:x, tag:x, directory:x, "*", or "!"-prefixed), got ${describe(selector)}`,
          );
        }
      });
    }
    if (typeof row.reason !== "string" || row.reason.trim() === "") {
      violations.push(
        `${at}.reason: must be a non-empty string — a fitness function is a policy decision, and one with no reason written down is indistinguishable from a policy that quietly stopped applying`,
      );
    }
    violations.push(...conditionViolations(row.condition, at));
  });
  return violations;
}

/** One condition's problems, prefixed with its row's index. */
function conditionViolations(condition, at) {
  if (!isPlainObject(condition)) {
    return [`${at}.condition: must be an object, got ${describe(condition)}`];
  }
  const violations = [];
  const keys = Object.keys(condition);
  const type = condition.type;
  if (typeof type !== "string" || !CONDITION_TYPES.includes(type)) {
    violations.push(
      `${at}.condition.type: must be one of ${CONDITION_TYPES.join(", ")}, got ${describe(type)}`,
    );
    return violations;
  }
  const allowed = {
    "cycle-free": ["type"],
    "drift-free": ["type"],
    "layer-dependency": ["type", "from", "to", "direction"],
    "tag-conformance": ["type", "from", "to", "toDependents"],
    "coverage-minimum": ["type", "statement"],
    "boundary-suppression-count-within-threshold": ["type", "max"],
  };
  for (const key of keys) {
    if (!allowed[type].includes(key)) {
      violations.push(
        `${at}.condition.${key}: not a field of condition type "${type}" — expected ${allowed[type].join(", ")}`,
      );
    }
  }
  if (type === "layer-dependency" || type === "tag-conformance") {
    for (const side of ["from", "to"]) {
      if (typeof condition[side] !== "string" || condition[side].trim() === "") {
        violations.push(
          `${at}.condition.${side}: must be a non-empty tag value, got ${describe(condition[side])}`,
        );
      }
    }
  }
  if (
    type === "layer-dependency" &&
    (typeof condition.direction !== "string" || !LAYER_DIRECTIONS.includes(condition.direction))
  ) {
    violations.push(
      `${at}.condition.direction: must be one of ${LAYER_DIRECTIONS.join(", ")}, got ${describe(condition.direction)}`,
    );
  }
  if (
    type === "tag-conformance" &&
    (typeof condition.toDependents !== "string" ||
      !TAG_DEPENDENT_DIRECTIONS.includes(condition.toDependents))
  ) {
    violations.push(
      `${at}.condition.toDependents: must be one of ${TAG_DEPENDENT_DIRECTIONS.join(", ")}, got ${describe(condition.toDependents)}`,
    );
  }
  if (
    type === "coverage-minimum" &&
    (typeof condition.statement !== "number" ||
      Number.isNaN(condition.statement) ||
      condition.statement < 0 ||
      condition.statement > 100)
  ) {
    violations.push(
      `${at}.condition.statement: must be a percentage between 0 and 100, got ${describe(condition.statement)}`,
    );
  }
  if (
    type === "boundary-suppression-count-within-threshold" &&
    (typeof condition.max !== "number" || !Number.isInteger(condition.max) || condition.max < 0)
  ) {
    violations.push(
      `${at}.condition.max: must be a non-negative integer, got ${describe(condition.max)}`,
    );
  }
  return violations;
}

/**
 * The per-function decision, evaluated against the assembled snapshot.
 *
 * @param {object} row A validated fitness row.
 * @param {{nodes: object, dependencies?: object}} graph
 * @param {{coverage?: Record<string, {owned?: number, analyzed?: number}>,
 *   analyzed?: number, owned?: number, scoped?: boolean}} analysis Never fully
 *   absent — the registry always passes a snapshot's assembled analysis — but
 *   only `coverage-minimum` reads it, so the fields ride optional for callers
 *   that do not carry a coverage fact (a `rules`-unit test driving another
 *   condition).
 * @param {object|null} intent The intent judge's verdict, or `null` when no
 *   intent is declared.
 * @param {object[]} suppressions The accepted boundary suppressions in effect.
 * @returns {object} A verdict record from `fitnessVerdict`.
 */
export function judgeFitnessRow(row, graph, analysis, intent, suppressions) {
  const names = resolveMembers(row.match, graph.nodes);
  if (names.length === 0) {
    return fitnessVerdict({
      verdict: "not_applicable",
      name: row.name,
      evidence: { projects: 0 },
      notApplicableReason: `match [${row.match.join(", ")}] selects no observed project`,
      message: `"${row.name}" is declared but matches nothing — no observed project, so it could not be judged`,
      rows: [],
    });
  }

  const { type, ...params } = row.condition;
  // The rule's own verdict names the RULE (`layer-dependency:from→to`); the
  // declared function's name is what every consumer — the report's verdict
  // table, the JSON envelope, `check`'s exit-code lane — must read, so the
  // registry stamps it over the rule's internal name. The rule's name stays
  // in `evidence.condition` for the reader who wants the exact condition.
  let decision;
  switch (type) {
    case "cycle-free":
      decision = cycleFree(graph.nodes, graph.dependencies, names);
      break;
    case "layer-dependency":
      decision = layerDependency(graph.nodes, graph.dependencies, names, params);
      break;
    case "tag-conformance":
      decision = tagConformance(graph.nodes, graph.dependencies, names, params);
      break;
    case "coverage-minimum":
      decision = coverageMinimum(analysis, names, {
        statement: params.statement,
        scoped: analysis.scoped ?? false,
      });
      break;
    case "boundary-suppression-count-within-threshold":
      decision = suppressionThreshold({ max: params.max }, suppressions);
      break;
    case "drift-free":
      decision = driftFree(intent);
      break;
    default:
      throw new Error(
        `lattice: fitness function "${row.name}" names an unevaluable condition type ${JSON.stringify(type)}`,
      );
  }
  return { ...decision, name: row.name };
}

/**
 * Assemble the fitness snapshot the registry judges against, from the facts
 * `check` and the `fitness` command already hold.
 *
 * Coverage is FILE coverage, not import-site coverage: each owned ANALYZABLE
 * tracked file contributes to its owning project's `owned` bucket, each file
 * the analysis actually analyzed to `analyzed`. "Analyzable" is exactly the
 * files `analyzeWorkspace` reads — the extension→language map filters out
 * Markdown, JSON and images before any analyzer runs (`languageOf`) — and
 * "analyzed" is the same list whose length `check` states beside its verdict
 * (`commandContext.analysis.analyzedFiles`), so a `coverage-minimum` over a
 * project is a claim about the SAME files the rest of the run inspected. A
 * file that is owned but not analyzed (a whole-file failure, or a path-scoped
 * run cutting the analysis short) counts as covered by nothing, never dropped
 * from the denominator — the silent direction.
 *
 * A path-scoped run (`lattice check <path>`) analyzes a subset of owned files,
 * so coverage over those projects' whole file sets is not determinable from it;
 * the snapshot marks that with `scoped`, and `coverage-minimum` answers
 * `not_applicable` there (`./fitness-rules.mjs`), never a
 * low-looking number that is really "we only looked at part of the tree" —
 * and, unlike `unknown`, `not_applicable` does not by itself fail `check`
 * (P1-19: it used to answer `unknown`, which folded into `check`'s exit code
 * the same as a real coverage hole, so a scoped run exited 3 in ANY
 * `coverage-minimum`-declaring workspace regardless of what the scoped path
 * held).
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{analysis?: object, intent?: object|null, suppressions?: object[],
 *   scoped?: boolean}} [extra] `analysis`/`intent`/`suppressions` override the
 *   command's own facts (the `fitness` command re-reads intent and suppresses
 *   the whole-tree analysis); `scoped` is set by `check` when `paths` scoped
 *   the run.
 * @returns {{graph: object, analysis: {coverage: object, analyzed: number,
 *   owned: number, scoped: boolean}, intent: object|null, suppressions: object[]}}
 */
export function fitnessSnapshot(commandContext, extra = {}) {
  const graph = {
    nodes: commandContext.graph.nodes,
    dependencies: commandContext.graph.dependencies,
  };
  const analyzedFiles = extra.analysis?.analyzedFiles ?? commandContext.analysis.analyzedFiles;
  const ownedFiles = extra.analysis?.ownedFiles ?? commandContext.owned;
  const coverage = {};
  const analyzedSet = new Set(analyzedFiles ?? []);
  for (const { file, project } of ownedFiles ?? []) {
    // The denominator is the analyzable owned files only — the same files
    // `analyzeWorkspace` reads (`languageOf` filters the rest out before any
    // analyzer runs), so a Markdown or JSON file can neither raise the claim
    // nor lower it.
    if (languageOf(file) === null) continue;
    if (coverage[project] === undefined) coverage[project] = { owned: 0, analyzed: 0 };
    coverage[project].owned += 1;
    if (analyzedSet.has(file)) coverage[project].analyzed += 1;
  }
  return {
    graph,
    analysis: {
      coverage,
      owned: Object.values(coverage).reduce((sum, c) => sum + c.owned, 0),
      analyzed: Object.values(coverage).reduce((sum, c) => sum + c.analyzed, 0),
      // `scoped` rides IN the analysis object because `judgeFitnessRow` reads
      // `analysis.scoped` — a path-scoped run analyzed a subset, so coverage is
      // not determinable from it. A top-level `scoped` never reached the rules.
      scoped: extra.scoped ?? false,
    },
    intent: extra.intent ?? null,
    suppressions: extra.suppressions ?? [],
  };
}

/**
 * Judge every declared fitness function against a snapshot, deterministically.
 *
 * Rows are judged in declaration order (row order is semantic, same as a
 * boundary policy's `depConstraints`), each returning its own verdict record.
 *
 * @param {object[]} rows Validated fitness rows.
 * @param {object} snapshot From `fitnessSnapshot`.
 * @returns {object[]} The per-function verdict records.
 */
export function evaluateFitness(rows, snapshot) {
  return rows.map((row) =>
    judgeFitnessRow(row, snapshot.graph, snapshot.analysis, snapshot.intent, snapshot.suppressions),
  );
}

/**
 * The overall verdict the `check` fold and the `fitness` command share: any
 * `fail` wins, then any `unknown`, then `pass` — and `not_applicable` alone
 * never turns a run red, because a declared-but-matching-nothing function is a
 * loud report row, not a broken requirement.
 *
 * @param {object[]} decisions From `evaluateFitness`.
 * @returns {{verdict: "pass"|"fail"|"unknown"|"not_applicable", decisions: object[]}}
 */
export function fitnessVerdictFor(decisions) {
  if (decisions.some((d) => d.verdict === "fail")) return { verdict: "fail", decisions };
  if (decisions.some((d) => d.verdict === "unknown")) return { verdict: "unknown", decisions };
  if (decisions.length === 0 || decisions.every((d) => d.verdict === "not_applicable")) {
    return { verdict: "not_applicable", decisions };
  }
  return { verdict: "pass", decisions };
}

/** Re-exported so `fitnessVerdict` and `isVerdict` live one import away. */
export { canonicalizeJson, fitnessVerdict, isVerdict };

/**
 * Shared completeness model used by both impact-statement and scenario-evaluation.
 *
 * Both the impact statement (`./impact-statement.mjs`) and scenario evaluation
 * (`./scenario-evaluation.mjs`) compose deterministic evaluations into a single
 * statement about what a change touches. This module provides the shared
 * completeness vocabulary so two callers cannot drift.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Evaluation status constants
// ---------------------------------------------------------------------------

/** @type {Readonly<{EVALUATED: string, PARTIAL: string, NOT_EVALUATED: string, UNSUPPORTED: string, REFUSED: string}>} */
export const EVALUATION_STATUS = Object.freeze({
  EVALUATED: "evaluated",
  PARTIAL: "partial",
  NOT_EVALUATED: "not_evaluated",
  UNSUPPORTED: "unsupported",
  REFUSED: "refused",
});
export const EVALUATED = EVALUATION_STATUS.EVALUATED;
export const PARTIAL = EVALUATION_STATUS.PARTIAL;
export const NOT_EVALUATED = EVALUATION_STATUS.NOT_EVALUATED;
export const UNSUPPORTED = EVALUATION_STATUS.UNSUPPORTED;
export const REFUSED = EVALUATION_STATUS.REFUSED;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Priority order for overall status computation (worst first).
 * @type {string[]}
 */
const STATUS_ORDER = [
  EVALUATION_STATUS.REFUSED,
  EVALUATION_STATUS.UNSUPPORTED,
  EVALUATION_STATUS.NOT_EVALUATED,
  EVALUATION_STATUS.PARTIAL,
  EVALUATION_STATUS.EVALUATED,
];

/**
 * Returns the worst (highest-priority) status among the given statuses.
 *
 * @param {...string} statuses One or more EVALUATION_STATUS values.
 * @returns {string} The worst status.
 */
function worstStatus(...statuses) {
  for (const candidate of STATUS_ORDER) {
    if (statuses.includes(candidate)) return candidate;
  }
  return EVALUATION_STATUS.NOT_EVALUATED;
}

/**
 * Creates a domain object from a status and optional note.
 *
 * @param {string} status One of EVALUATION_STATUS values.
 * @param {string} [note] Optional explanatory note.
 * @returns {{status: string, evaluated: boolean, partial: boolean, notEvaluated: boolean, unsupported: boolean, refused: boolean, note: string}}
 */
export function createDomain(status, note = "") {
  return {
    status,
    evaluated: status === EVALUATION_STATUS.EVALUATED || status === EVALUATION_STATUS.PARTIAL,
    partial: status === EVALUATION_STATUS.PARTIAL,
    notEvaluated: status === EVALUATION_STATUS.NOT_EVALUATED,
    unsupported: status === EVALUATION_STATUS.UNSUPPORTED,
    refused: status === EVALUATION_STATUS.REFUSED,
    note,
  };
}

// ---------------------------------------------------------------------------
// Domain-level evaluation status
// ---------------------------------------------------------------------------

/**
 * Determines the evaluation status from a set of boolean flags.
 *
 * Priority order: refused > unsupported > notEvaluated > evaluated+partial.
 * When no flag is set, defaults to NOT_EVALUATED.
 *
 * @param {object} [flags]
 * @param {boolean} [flags.evaluated] Whether evaluation was performed.
 * @param {boolean} [flags.partial] Whether evaluation was partial.
 * @param {boolean} [flags.notEvaluated] Whether evaluation was not performed.
 * @param {boolean} [flags.unsupported] Whether the domain is unsupported.
 * @param {boolean} [flags.refused] Whether evaluation was refused.
 * @returns {string} One of EVALUATION_STATUS values.
 */
export function evaluationStatus({ evaluated, partial, notEvaluated, unsupported, refused } = {}) {
  if (refused) return EVALUATION_STATUS.REFUSED;
  if (unsupported) return EVALUATION_STATUS.UNSUPPORTED;
  if (notEvaluated) return EVALUATION_STATUS.NOT_EVALUATED;
  if (evaluated) {
    return partial ? EVALUATION_STATUS.PARTIAL : EVALUATION_STATUS.EVALUATED;
  }
  return EVALUATION_STATUS.NOT_EVALUATED;
}

// ---------------------------------------------------------------------------
// Canonical completeness
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DomainStatus
 * @property {string} status One of EVALUATION_STATUS values.
 * @property {boolean} evaluated Whether evaluation was performed.
 * @property {boolean} partial Whether evaluation was partial.
 * @property {boolean} notEvaluated Whether evaluation was not performed.
 * @property {boolean} unsupported Whether the domain is unsupported.
 * @property {boolean} refused Whether evaluation was refused.
 * @property {string} note Explanatory note about the status.
 */

/**
 * @typedef {object} CompletenessResult
 * @property {object} domains Domain-level statuses, keyed by domain name.
 * @property {DomainStatus} domains.structural
 * @property {DomainStatus} domains.constraint
 * @property {DomainStatus} domains.boundary
 * @property {DomainStatus} domains.decision
 * @property {DomainStatus} domains.governance
 * @property {boolean} overallComplete True only when ALL applicable domains are EVALUATED.
 * @property {string} overallStatus One of EVALUATION_STATUS values.
 */

/**
 * Builds canonical completeness from the five domain statuses.
 *
 * @param {object} [input]
 * @param {DomainStatus} [input.structural] The structural domain status.
 * @param {DomainStatus} [input.constraint] The constraint domain status.
 * @param {DomainStatus} [input.boundary] The boundary domain status.
 * @param {DomainStatus} [input.decision] The decision domain status.
 * @param {DomainStatus} [input.governance] The governance domain status.
 * @returns {CompletenessResult}
 */
export function buildCompleteness({ structural, constraint, boundary, decision, governance } = {}) {
  const domains = {
    structural: structural ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED),
    constraint: constraint ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED),
    boundary: boundary ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED),
    decision: decision ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED),
    governance: governance ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED),
  };

  const statuses = Object.values(domains).map((d) => d.status);
  const overallComplete = statuses.every((s) => s === EVALUATION_STATUS.EVALUATED);
  const overallStatus = worstStatus(...statuses);

  return { domains, overallComplete, overallStatus };
}

// ---------------------------------------------------------------------------
// Governance completeness
// ---------------------------------------------------------------------------

/**
 * @typedef {object} GovernanceCompletenessResult
 * @property {DomainStatus} domain The governance domain status.
 * @property {string} findingsStatus EVALUATION_STATUS for findings.
 * @property {string} debtStatus EVALUATION_STATUS for debt.
 * @property {number} findingsCount Number of findings.
 * @property {number} debtCount Number of debt entries.
 */

/**
 * Builds governance completeness from findings and debt statuses.
 *
 * @param {object} [input]
 * @param {string} [input.findingsStatus] EVALUATION_STATUS for findings.
 * @param {string} [input.debtStatus] EVALUATION_STATUS for debt.
 * @param {number} [input.findingsCount] Number of findings.
 * @param {number} [input.debtCount] Number of debt entries.
 * @returns {GovernanceCompletenessResult}
 */
export function buildGovernanceCompleteness({
  findingsStatus = EVALUATION_STATUS.NOT_EVALUATED,
  debtStatus = EVALUATION_STATUS.NOT_EVALUATED,
  findingsCount = 0,
  debtCount = 0,
} = {}) {
  const status = worstStatus(findingsStatus, debtStatus);

  let note = "";
  if (status !== EVALUATION_STATUS.EVALUATED) {
    const parts = [];
    if (findingsStatus !== EVALUATION_STATUS.EVALUATED) {
      parts.push(`findings: ${findingsStatus}`);
    }
    if (debtStatus !== EVALUATION_STATUS.EVALUATED) {
      parts.push(`debt: ${debtStatus}`);
    }
    note = `Governance incomplete — ${parts.join(", ")}`;
  }

  return {
    domain: createDomain(status, note),
    findingsStatus,
    debtStatus,
    findingsCount,
    debtCount,
  };
}

// ---------------------------------------------------------------------------
// Scenario completeness
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ScenarioCompletenessResult
 * @property {object} domains Domain-level statuses (standard 5 domains).
 * @property {boolean} overallComplete True only when ALL domains are EVALUATED,
 *   including scenario-specific domains.
 * @property {string} overallStatus One of EVALUATION_STATUS values.
 * @property {object} scenarioDomains Scenario-specific domain statuses.
 * @property {DomainStatus} scenarioDomains.changes Whether all changes were applied.
 * @property {DomainStatus} scenarioDomains.base Whether the base revision was attributed.
 */

/**
 * Builds scenario completeness, extending canonical completeness with
 * scenario-specific domains (changes and base attribution).
 *
 * In a scenario context, the standard domains (structural, constraint, boundary,
 * decision) are always EVALUATED because the full evaluation runs. The
 * scenario-specific domains capture whether changes were fully applied and
 * whether the base revision was attributed.
 *
 * @param {object} [input]
 * @param {boolean} [input.changesComplete] Whether all scenario changes were applied.
 * @param {boolean} [input.baseAttributed] Whether the base revision was attributed.
 * @param {GovernanceCompletenessResult} [input.governance] Governance completeness
 *   from buildGovernanceCompleteness.
 * @returns {ScenarioCompletenessResult}
 */
export function buildScenarioCompleteness({
  changesComplete = true,
  baseAttributed = true,
  governance,
} = {}) {
  const changesDomain = changesComplete
    ? createDomain(EVALUATION_STATUS.EVALUATED)
    : createDomain(EVALUATION_STATUS.PARTIAL, "Some changes could not be applied");

  const baseDomain = baseAttributed
    ? createDomain(EVALUATION_STATUS.EVALUATED)
    : createDomain(EVALUATION_STATUS.NOT_EVALUATED, "Base revision could not be attributed");

  const governanceDomain =
    governance?.domain ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED, "Governance not evaluated");

  // Standard domains are always EVALUATED in scenario context
  const structuralDomain = createDomain(EVALUATION_STATUS.EVALUATED);
  const constraintDomain = createDomain(EVALUATION_STATUS.EVALUATED);
  const boundaryDomain = createDomain(EVALUATION_STATUS.EVALUATED);
  const decisionDomain = createDomain(EVALUATION_STATUS.EVALUATED);

  const baseResult = buildCompleteness({
    structural: structuralDomain,
    constraint: constraintDomain,
    boundary: boundaryDomain,
    decision: decisionDomain,
    governance: governanceDomain,
  });

  // Recompute overall with scenario domains included
  const allStatuses = [
    ...Object.values(baseResult.domains).map((d) => d.status),
    changesDomain.status,
    baseDomain.status,
  ];
  const overallComplete = allStatuses.every((s) => s === EVALUATION_STATUS.EVALUATED);
  const overallStatus = worstStatus(...allStatuses);

  return {
    domains: baseResult.domains,
    overallComplete,
    overallStatus,
    scenarioDomains: {
      changes: changesDomain,
      base: baseDomain,
    },
  };
}

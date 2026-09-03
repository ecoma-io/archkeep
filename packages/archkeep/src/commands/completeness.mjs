/**
 * Shared completeness model used by both impact-statement and scenario-evaluation.
 *
 * Both the impact statement (`./impact-statement.mjs`) and scenario evaluation
 * (`./scenario-evaluation.mjs`) compose deterministic evaluations into a single
 * statement about what a change touches. This module provides the shared
 * completeness vocabulary so two callers cannot drift.
 *
 * ## Evidence-Complete contract
 *
 * An evaluation is Evidence-Complete only when ALL required gates pass:
 *
 * - domainCoverage === 1
 * - claimEvidenceCoverage === 1
 * - causalCoverage === 1
 * - provenanceCoverage === 1
 * - mutationCoverage === 1
 * - surfaceParity === 1
 * - hiddenGapCount === 0
 * - falseCompleteCount === 0
 * - baseIdentityValid === true
 * - deterministic === true
 *
 * `overallComplete` implies ALL gates pass. Any failed gate MUST prevent
 * `overallComplete = true`.
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
// Evaluation contract types — which gates are required per evaluation type
// ---------------------------------------------------------------------------

/**
 * The evaluation contract types that determine which Evidence-Complete gates
 * are required for `overallComplete`.
 *
 * - `canonical`: Standard architecture evaluation (no mutations, no scenario).
 *   Gates NOT required: mutationCoverage, surfaceParity, baseIdentityValid.
 * - `scenario`: Hypothetical scenario evaluation. ALL gates required.
 *
 * @type {Readonly<{CANONICAL: string, SCENARIO: string}>}
 */
export const EVALUATION_CONTRACT_TYPES = Object.freeze({
  CANONICAL: "canonical",
  SCENARIO: "scenario",
});

/**
 * Which Evidence-Complete gates are required for each contract type.
 * A gate not listed here is still tracked and reported but does NOT block
 * `overallComplete` — it is explicitly not applicable for that evaluation type.
 *
 * @type {Readonly<Object<string, ReadonlySet<string>>>}
 */
export const REQUIRED_GATES_FOR_CONTRACT = Object.freeze({
  [EVALUATION_CONTRACT_TYPES.CANONICAL]: Object.freeze(
    new Set([
      "domainCoverage",
      "claimEvidenceCoverage",
      "causalCoverage",
      "provenanceCoverage",
      "hiddenGapCount",
      "falseCompleteCount",
      "deterministic",
    ]),
  ),
  [EVALUATION_CONTRACT_TYPES.SCENARIO]: Object.freeze(
    new Set([
      "domainCoverage",
      "claimEvidenceCoverage",
      "causalCoverage",
      "provenanceCoverage",
      "mutationCoverage",
      "surfaceParity",
      "hiddenGapCount",
      "falseCompleteCount",
      "baseIdentityValid",
      "deterministic",
    ]),
  ),
});

/**
 * Returns true when the given gate key is required for the given contract type.
 *
 * @param {string} gateKey The gate key (e.g. "domainCoverage").
 * @param {string} [contractType] The evaluation contract type.
 *   Defaults to SCENARIO (most restrictive).
 * @returns {boolean}
 */
export function isGateRequired(gateKey, contractType = EVALUATION_CONTRACT_TYPES.SCENARIO) {
  const required = REQUIRED_GATES_FOR_CONTRACT[contractType];
  return required ? required.has(gateKey) : true;
}
// ---------------------------------------------------------------------------
// Evidence-Complete gate names — the canonical roster
// ---------------------------------------------------------------------------

/**
 * The canonical roster of required gates for Evidence-Complete.
 * Each gate has a key, a human-readable label, and a type.
 * @type {Readonly<{key: string, label: string, type: string}[]>}
 */
export const EVIDENCE_COMPLETE_GATES = Object.freeze([
  { key: "domainCoverage", label: "Domain coverage", type: "ratio" },
  { key: "claimEvidenceCoverage", label: "Claim evidence coverage", type: "ratio" },
  { key: "causalCoverage", label: "Causal coverage", type: "ratio" },
  { key: "provenanceCoverage", label: "Provenance coverage", type: "ratio" },
  { key: "mutationCoverage", label: "Mutation coverage", type: "ratio" },
  { key: "surfaceParity", label: "Surface parity", type: "ratio" },
  { key: "hiddenGapCount", label: "Hidden gap count", type: "count" },
  { key: "falseCompleteCount", label: "False-complete count", type: "count" },
  { key: "baseIdentityValid", label: "Base identity valid", type: "boolean" },
  { key: "deterministic", label: "Deterministic", type: "boolean" },
]);

/**
 * @typedef {object} EvidenceCompleteContract
 * @property {string} contractType The evaluation contract type (canonical | scenario).
 * @property {number} domainCoverage Ratio of evaluated required domains to required domains (0-1).
 * @property {number} claimEvidenceCoverage Ratio of claims with valid evidence to material claims (0-1).
 * @property {number} causalCoverage Ratio of consequences with complete causal chain to material consequences (0-1).
 * @property {number} provenanceCoverage Ratio of authoritative inputs with verified provenance to total authoritative inputs (0-1).
 * @property {number} mutationCoverage Ratio of mutations with explicit outcome and evidence to requested mutations (0-1).
 * @property {number} surfaceParity Ratio of surfaces with equivalent semantic output to total surfaces (0-1).
 * @property {number} hiddenGapCount Number of required domains/inputs/claims/consequences/mutations not actually evaluated or evidenced but not explicitly reported.
 * @property {number} falseCompleteCount Number of times overallComplete was true while required gates failed.
 * @property {boolean} baseIdentityValid Whether the base identity was verified (not merely attributed).
 * @property {boolean} deterministic Whether repeated evaluations produce semantically equivalent results.
 * @property {string} overallStatus Overall Evidence-Complete status: "complete" | "incomplete" | "not_evaluated".
 * @property {boolean} overallComplete True only when ALL required gates pass.
 * @property {object} gates Individual gate statuses, keyed by gate name.
 * @property {object} gates.domainCoverage Gate status with {value, pass, required}.
 * @property {object} gates.claimEvidenceCoverage Gate status with {value, pass, required}.
 * @property {object} gates.causalCoverage Gate status with {value, pass, required}.
 * @property {object} gates.provenanceCoverage Gate status with {value, pass, required}.
 * @property {object} gates.mutationCoverage Gate status with {value, pass, required}.
 * @property {object} gates.surfaceParity Gate status with {value, pass, required}.
 * @property {object} gates.hiddenGapCount Gate status with {value, pass, required}.
 * @property {object} gates.falseCompleteCount Gate status with {value, pass, required}.
 * @property {object} gates.baseIdentityValid Gate status with {value, pass, required}.
 * @property {object} gates.deterministic Gate status with {value, pass, required}.
 */

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
// Required domains — the declared evaluation contract
// ---------------------------------------------------------------------------

/**
 * The authoritative set of required evaluation domains.
 * Derived from repository doctrine: structural, constraints, boundaries,
 * decisions, findings, debt, governance, evidence.
 * @type {Readonly<string[]>}
 */
export const REQUIRED_DOMAINS = Object.freeze([
  "structural",
  "constraint",
  "boundary",
  "decision",
  "findings",
  "debt",
  "governance",
  "evidence",
]);

/**
 * Returns true when the domain status counts as evaluated for coverage purposes.
 * PARTIAL does NOT count as evaluated — only EVALUATED does.
 *
 * @param {string} status EVALUATION_STATUS value
 * @returns {boolean}
 */
export function isDomainEvaluated(status) {
  return status === EVALUATION_STATUS.EVALUATED;
}

/**
 * Computes domain coverage from the required domains and their statuses.
 *
 * domainCoverage = evaluatedRequiredDomains / requiredDomains
 *
 * @param {Object<string, string>} domainStatuses Map of domain name to EVALUATION_STATUS value.
 * @param {readonly string[]} [requiredDomains] The required domain names (defaults to REQUIRED_DOMAINS).
 * @returns {{coverage: number, evaluatedCount: number, requiredCount: number, failedDomains: string[]}}
 */
export function computeDomainCoverage(domainStatuses, requiredDomains = REQUIRED_DOMAINS) {
  const failedDomains = [];
  let evaluatedCount = 0;

  for (const domain of requiredDomains) {
    const status = domainStatuses[domain];
    if (status && isDomainEvaluated(status)) {
      evaluatedCount++;
    } else {
      failedDomains.push(domain);
    }
  }

  const requiredCount = requiredDomains.length;
  const coverage = requiredCount > 0 ? evaluatedCount / requiredCount : 1;

  return { coverage, evaluatedCount, requiredCount, failedDomains };
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
 * @property {DomainStatus} domains.findings
 * @property {DomainStatus} domains.debt
 * @property {DomainStatus} domains.governance
 * @property {DomainStatus} domains.evidence
 * @property {boolean} overallComplete True only when ALL applicable domains are EVALUATED
 *   AND the Evidence-Complete contract is satisfied.
 * @property {string} overallStatus One of EVALUATION_STATUS values.
 * @property {EvidenceCompleteContract} [evidenceComplete] The Evidence-Complete contract,
 *   present when computed.
 * @property {number} [hiddenGapCount] Number of domains NOT_EVALUATED without a note.
 * @property {number} [falseCompleteCount] Number of false-complete detections.

/**
 * Builds canonical completeness from domain statuses.
 * Now includes 8 domains (structural, constraint, boundary, decision,
 * findings, debt, governance, evidence).
 *
 * @param {object} [input]
 * @param {DomainStatus} [input.structural] The structural domain status.
 * @param {DomainStatus} [input.constraint] The constraint domain status.
 * @param {DomainStatus} [input.boundary] The boundary domain status.
 * @param {DomainStatus} [input.decision] The decision domain status.
 * @param {DomainStatus} [input.findings] The findings domain status.
 * @param {DomainStatus} [input.debt] The debt domain status.
 * @param {DomainStatus} [input.governance] The governance domain status.
 * @param {DomainStatus} [input.evidence] The evidence domain status.
 * @param {EvidenceCompleteContract} [input.evidenceComplete] Optional Evidence-Complete contract.
 * @returns {CompletenessResult}
 */
export function buildCompleteness({
  structural,
  constraint,
  boundary,
  decision,
  findings,
  debt,
  governance,
  evidence,
  evidenceComplete,
} = {}) {
  const domains = {
    structural: structural ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED),
    constraint: constraint ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED),
    boundary: boundary ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED),
    decision: decision ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED),
    findings: findings ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED),
    debt: debt ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED),
    governance: governance ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED),
    evidence: evidence ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED),
  };

  const statuses = Object.values(domains).map((d) => d.status);
  const domainOverallComplete = statuses.every((s) => s === EVALUATION_STATUS.EVALUATED);

  // If an Evidence-Complete contract is provided, enforce it as a gate.
  // When no contract is provided, overallComplete MUST be false — the
  // evaluation has not proven its evidence gates.
  let ecComplete = false;
  let falseCompleteCount = 0;
  if (evidenceComplete) {
    ecComplete = evidenceComplete.overallComplete;
    falseCompleteCount = evidenceComplete.falseCompleteCount;
    // Detect false complete: domain claims complete but Evidence-Complete fails
    if (domainOverallComplete && !ecComplete) {
      falseCompleteCount++;
    }
  }

  // Detect hidden gaps: a domain is NOT_EVALUATED but no note explains why
  let hiddenGapCount = 0;
  for (const [, domain] of Object.entries(domains)) {
    if (domain.status === EVALUATION_STATUS.NOT_EVALUATED && !domain.note) {
      hiddenGapCount++;
    }
  }

  const overallComplete = domainOverallComplete && ecComplete;
  const overallStatus = worstStatus(...statuses, ecComplete ? EVALUATED : NOT_EVALUATED);

  return {
    domains,
    overallComplete,
    overallStatus,
    ...(evidenceComplete ? { evidenceComplete: { ...evidenceComplete, falseCompleteCount } } : {}),
    ...(hiddenGapCount > 0 ? { hiddenGapCount } : {}),
    ...(falseCompleteCount > 0 ? { falseCompleteCount } : {}),
  };
}

// ---------------------------------------------------------------------------
// Evidence-Complete gate
// ---------------------------------------------------------------------------

/**
 * Builds an Evidence-Complete contract from the individual gate values.
 *
 * Only gates required for the given `contractType` are considered for
 * `overallComplete`. Gates not required are still tracked and reported
 * but do NOT block completeness.
 *
 * @param {object} gates
 * @param {number} [gates.domainCoverage] Ratio (0-1).
 * @param {number} [gates.claimEvidenceCoverage] Ratio (0-1).
 * @param {number} [gates.causalCoverage] Ratio (0-1).
 * @param {number} [gates.provenanceCoverage] Ratio (0-1).
 * @param {number} [gates.mutationCoverage] Ratio (0-1).
 * @param {number} [gates.surfaceParity] Ratio (0-1).
 * @param {number} [gates.hiddenGapCount] Count (0 = pass).
 * @param {number} [gates.falseCompleteCount] Count (0 = pass).
 * @param {boolean} [gates.baseIdentityValid] Boolean (true = pass).
 * @param {boolean} [gates.deterministic] Boolean (true = pass).
 * @param {string} [gates.contractType] Evaluation contract type for gate
 *   requirements (defaults to SCENARIO, the most restrictive).
 * @returns {EvidenceCompleteContract}
 */
export function buildEvidenceComplete({
  domainCoverage = 0,
  claimEvidenceCoverage = 0,
  causalCoverage = 0,
  provenanceCoverage = 0,
  mutationCoverage = 0,
  surfaceParity = 0,
  hiddenGapCount = -1,
  falseCompleteCount = -1,
  baseIdentityValid = false,
  deterministic = false,
  contractType = EVALUATION_CONTRACT_TYPES.SCENARIO,
} = {}) {
  const rawGates = {
    domainCoverage: { value: domainCoverage, pass: domainCoverage === 1 },
    claimEvidenceCoverage: { value: claimEvidenceCoverage, pass: claimEvidenceCoverage === 1 },
    causalCoverage: { value: causalCoverage, pass: causalCoverage === 1 },
    provenanceCoverage: { value: provenanceCoverage, pass: provenanceCoverage === 1 },
    mutationCoverage: { value: mutationCoverage, pass: mutationCoverage === 1 },
    surfaceParity: { value: surfaceParity, pass: surfaceParity === 1 },
    hiddenGapCount: { value: hiddenGapCount, pass: hiddenGapCount === 0 },
    falseCompleteCount: { value: falseCompleteCount, pass: falseCompleteCount === 0 },
    baseIdentityValid: { value: baseIdentityValid, pass: baseIdentityValid === true },
    deterministic: { value: deterministic, pass: deterministic === true },
  };

  // Only required gates block overallComplete
  const allRequiredPass = Object.keys(rawGates)
    .filter((key) => isGateRequired(key, contractType))
    .every((key) => rawGates[key].pass);

  // Annotate each gate with whether it is required for this contract type
  /** @type {EvidenceCompleteContract['gates']} */
  const gates = {};
  for (const [key, gate] of Object.entries(rawGates)) {
    gates[key] = {
      ...gate,
      required: isGateRequired(key, contractType),
    };
  }

  return {
    contractType,
    domainCoverage,
    claimEvidenceCoverage,
    causalCoverage,
    provenanceCoverage,
    mutationCoverage,
    surfaceParity,
    hiddenGapCount,
    falseCompleteCount,
    baseIdentityValid,
    deterministic,
    overallStatus: allRequiredPass ? "complete" : "incomplete",
    overallComplete: allRequiredPass,
    gates,
  };
}

/**
 * Asserts that the Evidence-Complete contract is satisfied.
 * Throws with a detailed message listing every failing gate.
 *
 * @param {EvidenceCompleteContract} ec The Evidence-Complete contract to verify.
 * @returns {void}
 * @throws {Error} When any gate fails.
 */
export function assertEvidenceComplete(ec) {
  if (ec.overallComplete) return;

  const contractType = ec.contractType || EVALUATION_CONTRACT_TYPES.SCENARIO;
  const failures = [];
  for (const gate of EVIDENCE_COMPLETE_GATES) {
    const g = ec.gates[gate.key];
    // Skip non-required gates for this contract type
    if (g.required === false) continue;
    if (!g.pass) {
      failures.push(`${gate.label}: ${JSON.stringify(g.value)} (expected pass)`);
    }
  }

  if (failures.length === 0) return;

  throw new Error(
    `Evidence-Complete contract not satisfied.\n` +
      `  Contract type: ${contractType}\n` +
      `  Overall: ${ec.overallStatus}\n` +
      `  Failed gates:\n    ${failures.join("\n    ")}`,
  );
}

// ---------------------------------------------------------------------------
// Governance completeness
// ---------------------------------------------------------------------------

/**
 * @typedef {object} GovernanceCompletenessResult
 * @property {DomainStatus} domain The governance domain status.
 * @property {DomainStatus} findings The findings domain status.
 * @property {DomainStatus} debt The debt domain status.
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
  const findingsDomain = createDomain(findingsStatus);
  const debtDomain = createDomain(debtStatus);

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
    findings: findingsDomain,
    debt: debtDomain,
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
 * @property {DomainStatus} scenarioDomains.base Whether the base revision identity was verified.
 * @property {DomainStatus} scenarioDomains.mutationCoverage Mutation coverage status.
 * @property {EvidenceCompleteContract} [evidenceComplete] The Evidence-Complete contract.
 */

/**
 * Builds scenario completeness, extending canonical completeness with
 * scenario-specific domains (changes, base identity, mutation coverage).
 *
 * In a scenario context, standard domains (structural, constraint, boundary,
 * decision) pass through from the evaluation — they are NOT automatically
 * EVALUATED. The scenario-specific domains capture whether changes were
 * fully applied, whether the base revision identity was verified, and
 * whether mutation coverage was complete.
 *
 * @param {object} [input]
 * @param {boolean} [input.changesComplete] Whether all scenario changes were applied.
 * @param {boolean} [input.baseIdentityVerified] Whether the base revision identity was verified.
 * @param {boolean} [input.mutationCoverageComplete] Whether all mutations have explicit outcomes.
 * @param {GovernanceCompletenessResult} [input.governance] Governance completeness
 *   from buildGovernanceCompleteness.
 * @param {EvidenceCompleteContract} [input.evidenceComplete] Optional Evidence-Complete contract.
 * @param {object} [input.domains] Existing domain statuses to pass through.
 * @returns {ScenarioCompletenessResult}
 */
export function buildScenarioCompleteness({
  changesComplete = true,
  baseIdentityVerified = true,
  mutationCoverageComplete = true,
  governance,
  evidenceComplete,
  domains: existingDomains,
} = {}) {
  const changesDomain = changesComplete
    ? createDomain(EVALUATION_STATUS.EVALUATED)
    : createDomain(EVALUATION_STATUS.PARTIAL, "Some changes could not be applied");

  const baseDomain = baseIdentityVerified
    ? createDomain(EVALUATION_STATUS.EVALUATED)
    : createDomain(EVALUATION_STATUS.NOT_EVALUATED, "Base revision identity could not be verified");

  const mutationDomain = mutationCoverageComplete
    ? createDomain(EVALUATION_STATUS.EVALUATED)
    : createDomain(EVALUATION_STATUS.PARTIAL, "Not all mutations have explicit outcomes");

  const governanceDomain =
    governance?.domain ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED, "Governance not evaluated");

  // Use existing domains if provided, otherwise create defaults
  const structuralDomain =
    existingDomains?.structural ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED);
  const constraintDomain =
    existingDomains?.constraint ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED);
  const boundaryDomain = existingDomains?.boundary ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED);
  const decisionDomain = existingDomains?.decision ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED);
  const findingsDomain = existingDomains?.findings ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED);
  const debtDomain = existingDomains?.debt ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED);
  const evidenceDomain = existingDomains?.evidence ?? createDomain(EVALUATION_STATUS.NOT_EVALUATED);

  const baseResult = buildCompleteness({
    structural: structuralDomain,
    constraint: constraintDomain,
    boundary: boundaryDomain,
    decision: decisionDomain,
    findings: findingsDomain,
    debt: debtDomain,
    governance: governanceDomain,
    evidence: evidenceDomain,
    evidenceComplete,
  });

  // Recompute overall: base domains + EC gate + scenario domains.
  // baseResult.overallComplete already includes the evidenceComplete gate,
  // so reusing it prevents the silent-complete defect.
  const overallComplete =
    baseResult.overallComplete &&
    changesDomain.status === EVALUATION_STATUS.EVALUATED &&
    baseDomain.status === EVALUATION_STATUS.EVALUATED &&
    mutationDomain.status === EVALUATION_STATUS.EVALUATED;
  const allStatuses = [
    ...Object.values(baseResult.domains).map((d) => d.status),
    changesDomain.status,
    baseDomain.status,
    mutationDomain.status,
  ];
  // Include EC gate status in overall status: when evidenceComplete is
  // provided and fails, overall status must reflect that.
  const ecStatus = evidenceComplete
    ? evidenceComplete.overallComplete
      ? EVALUATION_STATUS.EVALUATED
      : EVALUATION_STATUS.NOT_EVALUATED
    : EVALUATION_STATUS.NOT_EVALUATED;
  const overallStatus = worstStatus(...allStatuses, ecStatus);

  return {
    domains: baseResult.domains,
    overallComplete,
    overallStatus,
    scenarioDomains: {
      changes: changesDomain,
      base: baseDomain,
      mutationCoverage: mutationDomain,
    },
    ...(baseResult.evidenceComplete ? { evidenceComplete: baseResult.evidenceComplete } : {}),
    ...(baseResult.hiddenGapCount !== undefined
      ? { hiddenGapCount: baseResult.hiddenGapCount }
      : {}),
    ...(baseResult.falseCompleteCount !== undefined
      ? { falseCompleteCount: baseResult.falseCompleteCount }
      : {}),
  };
}

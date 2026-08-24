/**
 * The delta classifier: given the violations two evidence sets produced when
 * judged under ONE boundary config and ONE shared reference instant, classify
 * each violation `introduced` | `resolved` | `unchanged` | `unknown`.
 *
 * The classifier is pure: it takes violation arrays and record arrays, never
 * files, and no clock beyond the `now` it is handed. Judging happens OUTSIDE —
 * a delta run re-judges both sides' stored evidence through
 * `../rules/index.mjs`'s engine under the current law, then hands this module
 * the two RAW (pre-suppression) violation arrays. Because both sides were
 * judged under one law and one clock, a policy edit or a waiver expiring
 * between base capture and head cannot fabricate an introduced/resolved pair;
 * only the architecture can move a classification.
 *
 * ## Identity is architectural, never textual
 *
 * A violation's identity is `(messageId, sourceProject, targetProject,
 * constraint)` — which rule fired, from which project, against which target,
 * under which declared constraint. Where no project target exists (an external
 * or unresolvable specifier), the raw specifier stands in as the target: five
 * of the fifteen message ids are decided on the specifier itself
 * (`../analysis/contract.md`), so for those the specifier IS the
 * architectural fact, not a spelling detail. `file:line:column` sites are
 * attached evidence on every classified entry and are never part of identity:
 * renaming a file, moving code within one, or adding a second occurrence in
 * another file changes counts and sites, not what the violation IS.
 *
 * Occurrences are counted per side (a multiset, so duplicate sites in one file
 * count twice). Classification per identity:
 *
 * - absent at base, present at head → `introduced`;
 * - present at base, absent at head → `resolved`;
 * - equal counts → `unchanged`;
 * - head count GREATER than base → `introduced` with a `reason` naming the
 *   growth — growth is more of a violation that already existed, and the loud
 *   direction wins;
 * - head count smaller but still above zero → `unchanged` with an
 *   `occurrencesReduced` note. The violation STILL EXISTS; calling that
 *   "resolved" would let a partial fix read as a clean boundary.
 * - any violation whose identity cannot be stated at all → `unknown`, with a
 *   `reason`. An unidentifiable violation is never guessed into a bucket.
 *
 * ## Renames are not guessed
 *
 * There is deliberately NO rename matching — not of files, not of projects.
 * Renaming a project makes its every violation read as one loud
 * introduced-at-new-name + resolved-at-old-name pair, and a human decides
 * whether that pair is a move. Guessing would silently merge two identities
 * the evidence cannot prove are one, and a wrong guess is invisible in the
 * output by construction — the exact silent direction this tool refuses
 * (`../../../../AGENTS.md`: an empty result is a claim, not a shrug).
 *
 * ## Waiver annotation, not waiver filtering
 *
 * Suppressions NEVER remove an item here — classification compares raw
 * violations precisely so a suppressed-then-regressed violation stays visible.
 * Instead every entry is annotated with whether the CURRENT suppressions table
 * covers it, reusing `../config.mjs`'s `suppressionCovers` and
 * `../governance/waiver.mjs`'s `suppressionFate` at the ONE shared `now` —
 * never a reimplementation. An entry whose every live site is covered by a
 * legacy suppression row or an ACTIVE waiver reads `waived: true`; a site
 * covered only by an EXPIRED waiver reads `waived: false`, because an expired
 * waiver covers nothing (`../governance/waiver.mjs`).
 */
import { canonicalizeJson } from "../canonical.mjs";
import { suppressionCovers } from "../config.mjs";
import { referenceTime } from "../governance/clock.mjs";
import { suppressionFate } from "../governance/waiver.mjs";
import { namespacedId } from "./custom-rules.mjs";

/**
 * Computes a violation's architectural identity.
 *
 * @param {object} violation One raw violation — see the `Violation` typedef in
 *   `../rules/index.mjs`.
 * @returns {{ok: true, key: string, identity: {messageId: string,
 *   sourceProject: string|null, target: string, targetIsSpecifier: boolean,
 *   constraint: object|null}}|{ok: false, reason: string}}
 */
export function violationIdentity(violation) {
  if (violation === null || typeof violation !== "object" || Array.isArray(violation)) {
    return { ok: false, reason: `violation is ${describe(violation)}, not an object` };
  }
  const { messageId, sourceProject, targetProject, specifier, constraint } = violation;
  if (typeof messageId !== "string" || messageId === "") {
    return {
      ok: false,
      reason: `violation carries no usable messageId — got ${describe(messageId)}`,
    };
  }
  const hasTarget = typeof targetProject === "string" && targetProject !== "";
  const hasSpecifier = typeof specifier === "string" && specifier !== "";
  if (!hasTarget && !hasSpecifier) {
    return {
      ok: false,
      reason:
        "violation names neither a target project nor a specifier — there is nothing " +
        "architectural to identify it by",
    };
  }
  // The constraint row that fired is part of identity: the same edge may be
  // condemned by different rows, and "which law condemns it" is part of WHAT
  // the violation is. Both sides were judged under ONE config, so identical
  // constraints serialize identically — the canonical form makes the comparison
  // structural rather than referential.
  let constraintCanonical;
  try {
    constraintCanonical = canonicalizeJson(constraint ?? null);
  } catch {
    return {
      ok: false,
      reason: "the constraint row could not be canonicalized — it is not plain data",
    };
  }
  const target = hasTarget
    ? /** @type {string} */ (targetProject)
    : /** @type {string} */ (specifier);
  return {
    ok: true,
    key: JSON.stringify([messageId, sourceProject ?? null, target, constraintCanonical]),
    identity: {
      messageId,
      sourceProject: typeof sourceProject === "string" ? sourceProject : null,
      target,
      targetIsSpecifier: !hasTarget,
      constraint: constraint ?? null,
    },
  };
}

/**
 * Classifies the RAW violations of two runs judged under one config and one
 * shared `now`.
 *
 * @param {object} input
 * @param {object[]} input.base Raw violations from the base side's re-judgment.
 * @param {object[]} input.head Raw violations from the head side's re-judgment.
 * @param {object[]} [input.suppressions] The CURRENT `boundarySuppressions`
 *   table, used only to annotate `waived` — never to filter.
 * @param {string} [input.now] The ONE shared reference instant (ISO-8601) the
 *   waiver clock reads; defaults to the shared governance clock.
 * @returns {{introduced: object[], resolved: object[], unchanged: object[],
 *   unknown: object[]}} Each known-classification entry carries its identity
 *   fields (`messageId`, `sourceProject`, `target`, `targetIsSpecifier`,
 *   `constraint`), both sides' counts and attached sites, an optional
 *   `reason`/`note`, and the `waived` annotation. Unknown entries carry the
 *   original violation plus the `reason` its identity could not be stated.
 */
export function classifyViolations({ base, head, suppressions = [], now = referenceTime() }) {
  const baseIdentified = base.map(identityOf);
  const headIdentified = head.map(identityOf);

  const introduced = [];
  const resolved = [];
  const unchanged = [];
  const unknown = [];
  for (const identified of baseIdentified.concat(headIdentified)) {
    // `ok === false` rather than `!ok`: this package typechecks without
    // strictNullChecks (`tsconfig.json`), where truthiness does not
    // discriminate a literal-boolean union — the equality test does.
    if (identified.ok === false) {
      unknown.push({
        classification: "unknown",
        reason: identified.reason,
        violation: identified.violation,
      });
    }
  }

  const baseGroups = groupBy(baseIdentified);
  const headGroups = groupBy(headIdentified);
  const keys = [...new Set([...baseGroups.keys(), ...headGroups.keys()])].sort(cmpString);
  for (const key of keys) {
    const baseGroup = baseGroups.get(key);
    const headGroup = headGroups.get(key);
    const baseCount = baseGroup ? baseGroup.sites.length : 0;
    const headCount = headGroup ? headGroup.sites.length : 0;
    const identity = (baseGroup ?? headGroup).identity;

    /** @type {Record<string, unknown>} */
    const entry = {
      classification: "",
      messageId: identity.messageId,
      sourceProject: identity.sourceProject,
      target: identity.target,
      targetIsSpecifier: identity.targetIsSpecifier,
      constraint: identity.constraint,
      baseCount,
      headCount,
      baseSites: baseGroup ? baseGroup.sites : [],
      headSites: headGroup ? headGroup.sites : [],
    };

    Object.assign(entry, occurrenceClassification(baseCount, headCount, "the violation"));

    // A resolved item has no head occurrence left; its waive status is judged
    // against the LAST places the violation existed (its base sites) — what
    // "would the current law cover this if it came back" can honestly ask.
    // Everything else is judged against its live head sites.
    const liveSites = headCount > 0 ? entry.headSites : entry.baseSites;
    Object.assign(entry, waiveAnnotation(liveSites, identity.messageId, suppressions, now));

    bucketFor(entry.classification, { introduced, resolved, unchanged }).push(entry);
  }

  return { introduced, resolved, unchanged, unknown };
}

/**
 * Classifies UNRESOLVABLE import-site records — records whose analysis could
 * not say where the specifier points (`resolved: null`,
 * `../analysis/contract.md`) — as their OWN delta category.
 *
 * These records are carried through, never dropped and never counted as
 * violations: no rule reached a verdict about them, so folding them into
 * either side's violation counts would fabricate findings. Their identity is
 * necessarily narrower than a violation's — there is no resolved target — so
 * it keys on the specifier (the architectural handle upstream itself uses for
 * unresolved specifiers), the import kind (static vs dynamic is a real
 * distinction), and — when the caller supplies `sourceProjectOf` — the project
 * the record's file belongs to. Without attribution the same specifier in two
 * different projects merges into one identity; supply `sourceProjectOf` where
 * the workspace is known.
 *
 * No suppression annotation here BY CONSTRUCTION: the suppression vocabulary
 * names a path glob and a violation id (`../config.mjs`), and an unresolvable
 * record has no verdict for any table row to cover.
 *
 * @param {object} input
 * @param {object[]} input.base Base-side import-site records.
 * @param {object[]} input.head Head-side import-site records.
 * @param {(record: object) => string|null} [input.sourceProjectOf] Pure
 *   resolver attributing a record to its project name; omitted means every
 *   record is unattributed (`null`) and identity rests on specifier+kind.
 * @returns {{introduced: object[], resolved: object[], unchanged: object[],
 *   unknown: object[]}}
 */
export function classifyUnresolvableRecords({ base, head, sourceProjectOf }) {
  const attribute = sourceProjectOf ?? (() => null);
  const baseIdentified = base
    .filter(isUnresolvable)
    .map((record) => recordIdentity(record, attribute));
  const headIdentified = head
    .filter(isUnresolvable)
    .map((record) => recordIdentity(record, attribute));

  const introduced = [];
  const resolved = [];
  const unchanged = [];
  const unknown = [];
  for (const identified of baseIdentified.concat(headIdentified)) {
    // The same non-strict narrowing constraint as `classifyViolations`' loop.
    if (identified.ok === false) {
      unknown.push({
        classification: "unknown",
        reason: identified.reason,
        record: identified.record,
      });
    }
  }

  const baseGroups = groupBy(baseIdentified);
  const headGroups = groupBy(headIdentified);
  const keys = [...new Set([...baseGroups.keys(), ...headGroups.keys()])].sort(cmpString);
  for (const key of keys) {
    const baseGroup = baseGroups.get(key);
    const headGroup = headGroups.get(key);
    const baseCount = baseGroup ? baseGroup.sites.length : 0;
    const headCount = headGroup ? headGroup.sites.length : 0;
    const identity = (baseGroup ?? headGroup).identity;

    /** @type {Record<string, unknown>} */
    const entry = {
      classification: "",
      specifier: identity.specifier,
      kind: identity.kind,
      sourceProject: identity.sourceProject,
      baseCount,
      headCount,
      baseSites: baseGroup ? baseGroup.sites : [],
      headSites: headGroup ? headGroup.sites : [],
    };

    Object.assign(entry, occurrenceClassification(baseCount, headCount, "the site"));

    bucketFor(entry.classification, { introduced, resolved, unchanged }).push(entry);
  }

  return { introduced, resolved, unchanged, unknown };
}

/**
 * Computes a custom finding's identity, or the reason it has none.
 *
 * The key is `["custom", ruleName, findingId, project ?? null]`: which rule,
 * which of its declared findings, against which project — the architectural
 * facts a rule states about a finding. `sourceFile`/`line`/`column` are
 * attached evidence exactly as a violation's sites are, never identity, and a
 * finding that names no project keys on `null` rather than being dropped. A
 * finding with no usable id has nothing to identify it by and is never
 * guessed into a bucket — the same refusal `violationIdentity` makes for a
 * violation with no messageId.
 *
 * @param {string} ruleName The judged rule's declared name.
 * @param {unknown} finding One finding from a rule's verdict document.
 * @returns {{ok: true, key: string, identity: object, site: object}
 *   |{ok: false, reason: string, finding: unknown}}
 */
function customFindingIdentity(ruleName, finding) {
  if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
    return {
      ok: false,
      reason: `custom rule "${ruleName}" reported a finding that is ${describe(finding)}, not an object`,
      finding,
    };
  }
  const { id, project } = /** @type {Record<string, unknown>} */ (finding);
  if (typeof id !== "string" || id === "") {
    return {
      ok: false,
      reason:
        `custom rule "${ruleName}" reported a finding with no usable id — got ${describe(id)}, ` +
        `and a finding that cannot be named cannot be matched across the two sides`,
      finding,
    };
  }
  const projectName = typeof project === "string" && project !== "" ? project : null;
  const record = /** @type {Record<string, unknown>} */ (finding);
  return {
    ok: true,
    key: JSON.stringify(["custom", ruleName, id, projectName]),
    identity: {
      rule: ruleName,
      findingId: id,
      ruleId: namespacedId(ruleName, id),
      project: projectName,
      message: record.message,
    },
    site: { file: record.sourceFile, line: record.line, column: record.column },
  };
}

/**
 * Classifies the custom-rule findings of a two-sided judgment
 * (`./custom-rules.mjs`'s `customRulesForDelta`).
 *
 * Same identity discipline, same occurrence ladder, same fail-closed unknowns
 * as the two classifiers above — with one deliberate absence: there is NO
 * `waived` annotation. Suppressions key on a `messageId`
 * (`../config.mjs`'s `suppressionCovers`), and a custom finding has none — its
 * id lives in the `custom/<rule>/<finding>` namespace no suppression row can
 * name — so by construction every introduced custom finding gates. Every rule
 * in `unknownRules` becomes one `unknown` entry carrying the rule's reason:
 * a rule that could not be judged is a question this delta could not answer,
 * never a silently thinner report.
 *
 * @param {object} input
 * @param {{name: string, baseFindings: object[], headFindings: object[]}[]}
 *   input.judged Rules evaluated on both sides.
 * @param {{name: string, reason: string}[]} [input.unknownRules] Rules that
 *   could not be judged, each with its mandatory reason.
 * @returns {{introduced: object[], resolved: object[], unchanged: object[],
 *   unknown: object[]}} Classified entries carry `rule`, `findingId`,
 *   `ruleId`, `project`, `message`, both sides' counts and sites, and the
 *   ladder's optional `reason`/`note`. Unknown entries are
 *   `{classification, rule, reason}` plus the offending `finding` where one
 *   exists.
 */
export function classifyCustomFindings({ judged, unknownRules = [] }) {
  const introduced = [];
  const resolved = [];
  const unchanged = [];
  const unknown = [];

  for (const rule of unknownRules) {
    unknown.push({ classification: "unknown", rule: rule.name, reason: rule.reason });
  }

  for (const rule of judged) {
    const baseIdentified = rule.baseFindings.map((finding) =>
      customFindingIdentity(rule.name, finding),
    );
    const headIdentified = rule.headFindings.map((finding) =>
      customFindingIdentity(rule.name, finding),
    );
    for (const identified of baseIdentified.concat(headIdentified)) {
      // The same non-strict narrowing constraint as `classifyViolations`' loop.
      if (identified.ok === false) {
        unknown.push({
          classification: "unknown",
          rule: rule.name,
          reason: identified.reason,
          finding: identified.finding,
        });
      }
    }

    const baseGroups = groupBy(baseIdentified);
    const headGroups = groupBy(headIdentified);
    const keys = [...new Set([...baseGroups.keys(), ...headGroups.keys()])].sort(cmpString);
    for (const key of keys) {
      const baseGroup = baseGroups.get(key);
      const headGroup = headGroups.get(key);
      const baseCount = baseGroup ? baseGroup.sites.length : 0;
      const headCount = headGroup ? headGroup.sites.length : 0;
      const identity = (baseGroup ?? headGroup).identity;

      /** @type {Record<string, unknown>} */
      const entry = {
        classification: "",
        rule: identity.rule,
        findingId: identity.findingId,
        ruleId: identity.ruleId,
        project: identity.project,
        message: identity.message,
        baseCount,
        headCount,
        baseSites: baseGroup ? baseGroup.sites : [],
        headSites: headGroup ? headGroup.sites : [],
      };
      Object.assign(entry, occurrenceClassification(baseCount, headCount, "the finding"));
      bucketFor(entry.classification, { introduced, resolved, unchanged }).push(entry);
    }
  }

  return { introduced, resolved, unchanged, unknown };
}

/**
 * Runs both classifications over one pair of evidence sets: the raw violations
 * and the unresolvable-site records, each into its own category.
 *
 * @param {object} input As `classifyViolations` plus
 *   `classifyUnresolvableRecords`.
 * @param {object[]} input.baseViolations Raw base-side violations.
 * @param {object[]} input.headViolations Raw head-side violations.
 * @param {object[]} input.baseRecords Base-side import-site records.
 * @param {object[]} input.headRecords Head-side import-site records.
 * @param {object[]} [input.suppressions] The current suppressions table.
 * @param {string} [input.now] The ONE shared reference instant.
 * @param {(record: object) => string|null} [input.sourceProjectOf]
 * @returns {{violations: {introduced: object[], resolved: object[],
 *   unchanged: object[], unknown: object[]},
 *   unresolvable: {introduced: object[], resolved: object[],
 *   unchanged: object[], unknown: object[]}}}
 */
export function classifyDelta(input) {
  const {
    baseViolations,
    headViolations,
    baseRecords,
    headRecords,
    suppressions,
    now,
    sourceProjectOf,
  } = input;
  return {
    violations: classifyViolations({
      base: baseViolations,
      head: headViolations,
      ...(suppressions === undefined ? {} : { suppressions }),
      ...(now === undefined ? {} : { now }),
    }),
    unresolvable: classifyUnresolvableRecords({
      base: baseRecords,
      head: headRecords,
      ...(sourceProjectOf === undefined ? {} : { sourceProjectOf }),
    }),
  };
}

/** Identity-or-reason wrapper applied to every raw violation. */
function identityOf(violation) {
  const result = violationIdentity(violation);
  if (result.ok) {
    return {
      ...result,
      site: {
        file: violation.sourceFile,
        line: violation.line,
        column: violation.column,
        specifier: violation.specifier,
        kind: violation.kind,
      },
    };
  }
  return { ...result, violation };
}

/** Identity-or-reason wrapper applied to every unresolvable record. */
function recordIdentity(record, attribute) {
  const { specifier, kind } = record;
  if (typeof specifier !== "string" || specifier === "") {
    return {
      ok: false,
      reason: `unresolvable record carries no usable specifier — got ${describe(specifier)}`,
      record,
    };
  }
  let attributed;
  try {
    attributed = attribute(record);
  } catch (cause) {
    return {
      ok: false,
      reason: `attributing the record to its project threw: ${cause?.message ?? cause}`,
      record,
    };
  }
  const normalizedKind = typeof kind === "string" ? kind : "";
  const sourceProject = typeof attributed === "string" ? attributed : null;
  return {
    ok: true,
    key: JSON.stringify(["unresolvable", sourceProject, normalizedKind, specifier]),
    identity: { specifier, kind: normalizedKind, sourceProject },
    site: {
      file: record.sourceFile,
      line: record.line,
      column: record.column,
      specifier,
      kind: normalizedKind,
    },
  };
}

/** A record that did not resolve — including one whose shape broke — is carried. */
function isUnresolvable(record) {
  return (
    record !== null &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    (record.resolved === null ||
      record.resolved === undefined ||
      typeof record.resolved !== "object")
  );
}

/**
 * The occurrence-count ladder every classifier above shares — one statement of
 * the header's per-identity rules, so the three cannot drift on the one
 * decision most likely to be re-litigated (a shrink is NEVER a resolution).
 *
 * @param {number} baseCount
 * @param {number} headCount
 * @param {string} subject What still exists on a shrink, for the note — "the
 *   violation", "the site", "the finding".
 * @returns {{classification: "introduced"|"resolved"|"unchanged",
 *   reason?: string, note?: string}}
 */
function occurrenceClassification(baseCount, headCount, subject) {
  if (baseCount === 0) return { classification: "introduced", reason: "absent at base" };
  if (headCount === 0) return { classification: "resolved" };
  if (headCount > baseCount) {
    return {
      classification: "introduced",
      reason: `occurrence growth: ${baseCount} at base, ${headCount} at head`,
    };
  }
  if (headCount < baseCount) {
    // Still present at head — a shrink is NEVER a resolution.
    return {
      classification: "unchanged",
      note:
        `occurrencesReduced: ${baseCount} at base, ${headCount} at head — ${subject} still ` +
        `exists`,
    };
  }
  return { classification: "unchanged" };
}

/**
 * Folds identified items into groups keyed by identity: occurrences become a
 * multiset of sites, so duplicate import sites in one file count twice.
 */
function groupBy(identifiedItems) {
  /** @type {Map<string, {identity: object, sites: object[]}>} */
  const groups = new Map();
  for (const item of identifiedItems) {
    if (!item.ok) continue;
    const existing = groups.get(item.key);
    if (existing) existing.sites.push(item.site);
    else groups.set(item.key, { identity: item.identity, sites: [item.site] });
  }
  for (const group of groups.values()) {
    group.sites.sort(compareSites);
  }
  return groups;
}

function compareSites(a, b) {
  if ((a.file ?? "") !== (b.file ?? "")) return cmpString(a.file ?? "", b.file ?? "");
  if ((a.line ?? 0) !== (b.line ?? 0)) return (a.line ?? 0) - (b.line ?? 0);
  if ((a.column ?? 0) !== (b.column ?? 0)) return (a.column ?? 0) - (b.column ?? 0);
  if ((a.specifier ?? "") !== (b.specifier ?? "")) {
    return cmpString(a.specifier ?? "", b.specifier ?? "");
  }
  return cmpString(a.kind ?? "", b.kind ?? "");
}

/**
 * Whether the current suppressions table covers EVERY live site at `now` —
 * reusing `suppressionCovers`/`suppressionFate` rather than reimplementing
 * either. First-covering-row semantics match the engine's own annotation walk:
 * the first row covering a site decides that site's fate, and an EXPIRED
 * waiver (fate `reassert`) covers nothing.
 */
function waiveAnnotation(sites, messageId, suppressions, now) {
  if (suppressions.length === 0 || sites.length === 0) return { waived: false };
  let waivedBy = null;
  for (const site of sites) {
    const covering = suppressions.find((row) =>
      suppressionCovers(row, { sourceFile: site.file, messageId }),
    );
    if (!covering) return { waived: false };
    if (suppressionFate(covering, now) === "reassert") return { waived: false };
    if (waivedBy === null) waivedBy = covering;
  }
  return { waived: true, waivedBy };
}

/** Picks the destination array for a finished classification. */
function bucketFor(classification, buckets) {
  if (classification === "introduced") return buckets.introduced;
  if (classification === "resolved") return buckets.resolved;
  if (classification === "unchanged") return buckets.unchanged;
  throw new Error(
    `archkeep: classifier produced the classification '${classification}', which is none of ` +
      `introduced | resolved | unchanged — refusing to place it silently`,
  );
}

/** Plain lexicographic comparison — never localeCompare (byte-determinism). */
function cmpString(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Describes a value for error messages without dumping it. */
function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

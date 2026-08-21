/**
 * The evidence bundle — the only thing a custom rule ever receives, and the
 * exact bytes it receives it as.
 *
 * A custom rule is a pure function from evidence to verdict
 * (`../../../../docs/adr/0002-custom-rules-one-contract.md`). This module owns
 * the "in" half: it collects the facts the engine already observed into one
 * versioned document and hands the caller its canonical UTF-8 serialization.
 * Nothing here reads a file, asks a provider, or judges anything — the caller
 * supplies observed facts, the same posture `../rules/README.md` states for
 * the built-in rules ("reads records, never files").
 *
 * ## A missing kind throws; it never serializes as empty
 *
 * Every one of the four kinds is required, and a caller that omits one — or
 * supplies something that is not the shape the kind promises — gets a thrown
 * error naming it. The tempting alternative is to write `imports: []` and move
 * on, and that is the silent direction the repository is built against
 * (`../../../../AGENTS.md`, "An empty result is a claim, not a shrug"): a rule
 * handed an empty import list cannot tell "this workspace writes no imports"
 * from "the pipeline never collected any", so it answers `pass` for a reason
 * nobody earned. A throw is a bug in the caller that composed the bundle, not
 * a fact about the workspace, which is why it is an exception rather than a
 * violation list — the same posture `../report/evidence.mjs`'s `buildDecision`
 * takes when a verdict and its counts disagree.
 *
 * ## Byte-determinism, and the two orders that are NOT normalized here
 *
 * The bundle is serialized by `../canonical.mjs` — the one canonicalizer this
 * package owns, so a fingerprint and a rule's input can never disagree about
 * what a document is. It sorts object keys at every depth and deliberately
 * leaves array order alone, so this module sorts the two arrays whose incoming
 * order is an accident of who produced them: projects (a provider's discovery
 * order) and edges (a graph read). Both are sorted with plain `<`.
 *
 * Two arrays are deliberately left in the caller's order:
 *
 * - **`imports`** — source order is part of the analysis contract
 *   (`../analysis/contract.md`: "every import site, in source order"), so
 *   re-sorting would destroy a fact rather than normalize a nuisance. It is
 *   still deterministic upstream: the file list comes from `git ls-files` and
 *   each analyzer walks a file top to bottom.
 * - **`policy.depConstraints`** — row order is semantic for a boundary policy
 *   (`../canonical.mjs`'s header argues exactly this for fingerprints), and a
 *   rule reading the policy has to see the order the workspace wrote.
 *
 * ## What the bundle carries of a policy, and the one rename
 *
 * `../config.mjs` returns a loaded policy as `{ depConstraints, options, … }`
 * — `options` is that module's name for the eight
 * `@nx/enforce-module-boundaries` settings. The bundle spells it
 * `moduleBoundaryOptions`, which is what the workspace itself wrote in its
 * policy file and therefore the name a rule author is reading. The rename
 * happens here, once, and the two keys the contract pins are the only two the
 * bundle carries: `suppressions` and `fitness` ride on the same loaded object
 * and are ignored, because acceptance is not a rule's business
 * (`../governance/waiver.mjs` owns it) and a rule that could see waivers could
 * launder them into its own verdict.
 */

import { canonicalizeJson } from "../canonical.mjs";

/** The evidence contract version this engine speaks and every bundle states. */
export const EVIDENCE_CONTRACT = 1;

/**
 * The four evidence kinds contract 1 carries, in the order the schema lists
 * them. This is the roster `needs` is checked against (`./host.mjs`), so it
 * lives here — beside the code that produces the kinds — rather than being
 * restated by the host that consumes it.
 */
export const EVIDENCE_KINDS = Object.freeze(["model", "graph", "imports", "policy"]);

/** @type {(value: unknown) => value is Record<string, any>} */
const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** @type {(value: unknown) => boolean} */
const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

/** A value's type, for an error that shows what was actually there. */
function describeValue(value) {
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  // A BigInt is the one value `JSON.stringify` THROWS on rather than skipping,
  // and this runs only on a refusal path — a formatter that threw would
  // replace the named reason with a TypeError about something else entirely.
  if (typeof value === "bigint") return `bigint ${value}`;
  return `${typeof value} (${JSON.stringify(value) ?? String(value)})`;
}

/**
 * @param {string} detail
 * @returns {never}
 */
function refuse(detail) {
  throw new Error(`lattice: refusing to build an evidence bundle — ${detail}`);
}

/**
 * @typedef {object} EvidenceRule
 * @property {string} name The declared rule name, as the policy row spells it.
 * @property {Record<string, any>} [params] The declared parameters, if any.
 */

/**
 * @typedef {object} EvidenceBundle
 * @property {number} contract Always `EVIDENCE_CONTRACT`.
 * @property {{name: string, params: Record<string, any>}} rule
 * @property {{projects: Array<{name: string, root: string, tags: string[]}>}} model
 * @property {{edges: Array<Record<string, any>>}} graph
 * @property {Array<Record<string, any>>} imports
 * @property {{depConstraints: object[], moduleBoundaryOptions: Record<string, any>}} policy
 */

/**
 * Builds the evidence bundle one rule instance is judged over.
 *
 * `rule` is the declared `customRules` row and is **read, never written**: a
 * row that declares no `params` gets `{}` in the bundle and keeps its own
 * absent field, because the bundle is a view and the policy is the law — a
 * defaulted `params` written back onto the row would make the loaded policy
 * disagree with the file the workspace committed, and every later reader of
 * that row (a report, a fingerprint, a second bundle) would carry the
 * engine's guess as if the workspace had written it.
 *
 * `imports` is a list of `{ site, sourceProject }` pairs rather than bare
 * records: attribution is the workspace layer's answer (`../workspace.mjs` is
 * the only layer allowed to say which files a project owns), so the caller
 * hands it over and this module never re-derives it from a root prefix. Each
 * site is copied through verbatim — every key the analysis contract fixes,
 * untouched — with `sourceProject` added.
 *
 * @param {{
 *   rule: EvidenceRule,
 *   projects: Array<{name: string, root: string, tags: string[]}>,
 *   edges: Array<Record<string, any>>,
 *   imports: Array<{site: Record<string, any>, sourceProject: string}>,
 *   policy: {depConstraints: object[], options: Record<string, any>}
 * }} observed Every one of the five is required.
 * @returns {EvidenceBundle}
 * @throws {Error} when a kind is absent or malformed — never an empty stand-in.
 */
export function buildEvidenceBundle(observed) {
  if (!isPlainObject(observed)) {
    refuse(`the observed facts must be an object, got ${describeValue(observed)}`);
  }
  const { rule, projects, edges, imports, policy } = observed;

  return {
    contract: EVIDENCE_CONTRACT,
    rule: bundleRule(rule),
    model: { projects: bundleProjects(projects) },
    graph: { edges: bundleEdges(edges) },
    imports: bundleImports(imports),
    policy: bundlePolicy(policy),
  };
}

/**
 * The `rule` block: the declared name and the declared parameters, with `{}`
 * standing in for an absent `params` HERE and nowhere else.
 *
 * @param {unknown} rule
 * @returns {{name: string, params: Record<string, any>}}
 */
function bundleRule(rule) {
  if (!isPlainObject(rule)) refuse(`rule: must be the declared row, got ${describeValue(rule)}`);
  if (!isNonEmptyString(rule.name)) {
    refuse(`rule.name: must be the declared rule name, got ${describeValue(rule.name)}`);
  }
  if (rule.params !== undefined && !isPlainObject(rule.params)) {
    refuse(`rule.params: must be a plain object when declared, got ${describeValue(rule.params)}`);
  }
  return { name: rule.name, params: rule.params === undefined ? {} : rule.params };
}

/**
 * The `model` kind's projects, sorted by name.
 *
 * @param {unknown} projects
 * @returns {Array<{name: string, root: string, tags: string[]}>}
 */
function bundleProjects(projects) {
  if (!Array.isArray(projects)) {
    refuse(
      `model: projects must be an array — "no projects" and "the model was never read" must not ` +
        `serialize the same way, got ${describeValue(projects)}`,
    );
  }
  const rows = projects.map((project, index) => {
    if (!isPlainObject(project)) {
      refuse(`model: projects[${index}] must be an object, got ${describeValue(project)}`);
    }
    if (!isNonEmptyString(project.name)) {
      refuse(
        `model: projects[${index}].name must be a non-empty string, got ${describeValue(project.name)}`,
      );
    }
    if (typeof project.root !== "string") {
      refuse(`model: projects[${index}].root must be a string, got ${describeValue(project.root)}`);
    }
    if (!Array.isArray(project.tags) || project.tags.some((tag) => typeof tag !== "string")) {
      refuse(
        `model: projects[${index}].tags must be an array of strings — an untagged project declares ` +
          `[], and a project whose tags were never read must not look identical to it, got ` +
          `${describeValue(project.tags)}`,
      );
    }
    return { name: project.name, root: project.root, tags: [...project.tags] };
  });
  return rows.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * The keys an edge is ordered by, most significant first. `sourceFile` is on
 * the list because a graph adapter that carries one produces several edges
 * between the same pair, and an order that stopped at `type` would leave those
 * in whatever order the adapter emitted them.
 */
const EDGE_SORT_KEYS = Object.freeze(["source", "target", "type", "sourceFile"]);

/**
 * The `graph` kind's edges, sorted by source, target, type, then sourceFile.
 *
 * @param {unknown} edges
 * @returns {Array<Record<string, any>>}
 */
function bundleEdges(edges) {
  if (!Array.isArray(edges)) {
    refuse(
      `graph: edges must be an array — "no dependencies" and "the graph was never read" must not ` +
        `serialize the same way, got ${describeValue(edges)}`,
    );
  }
  const rows = edges.map((edge, index) => {
    if (!isPlainObject(edge)) {
      refuse(`graph: edges[${index}] must be an object, got ${describeValue(edge)}`);
    }
    for (const key of ["source", "target", "type"]) {
      if (!isNonEmptyString(edge[key])) {
        refuse(
          `graph: edges[${index}].${key} must be a non-empty string, got ${describeValue(edge[key])}`,
        );
      }
    }
    if (edge.sourceFile !== undefined && typeof edge.sourceFile !== "string") {
      refuse(
        `graph: edges[${index}].sourceFile must be a string when present, got ${describeValue(edge.sourceFile)}`,
      );
    }
    return edge.sourceFile === undefined
      ? { source: edge.source, target: edge.target, type: edge.type }
      : {
          source: edge.source,
          target: edge.target,
          type: edge.type,
          sourceFile: edge.sourceFile,
        };
  });
  return rows.sort((left, right) => {
    for (const key of EDGE_SORT_KEYS) {
      // `?? ""` covers the absent `sourceFile` only: plain `<` against
      // `undefined` is false in both directions, which would silently make the
      // comparator claim two different edges are equal.
      const leftValue = left[key] ?? "";
      const rightValue = right[key] ?? "";
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
    }
    return 0;
  });
}

/**
 * The `imports` kind: every analysis record verbatim, plus its attribution.
 *
 * @param {unknown} imports
 * @returns {Array<Record<string, any>>}
 */
function bundleImports(imports) {
  if (!Array.isArray(imports)) {
    refuse(
      `imports: must be an array of { site, sourceProject } — "this tree writes no imports" and ` +
        `"nothing was analyzed" must not serialize the same way, got ${describeValue(imports)}`,
    );
  }
  return imports.map((entry, index) => {
    if (!isPlainObject(entry)) {
      refuse(`imports[${index}]: must be { site, sourceProject }, got ${describeValue(entry)}`);
    }
    if (!isPlainObject(entry.site)) {
      refuse(
        `imports[${index}].site: must be an analysis record (../analysis/contract.md), got ` +
          `${describeValue(entry.site)}`,
      );
    }
    if (!isNonEmptyString(entry.sourceProject)) {
      refuse(
        `imports[${index}].sourceProject: must name the project the importing file belongs to, got ` +
          `${describeValue(entry.sourceProject)} — an unattributed import site is a site no rule ` +
          `can place, and dropping it would be the silent direction`,
      );
    }
    // Attribution last: the caller's answer wins over anything a record
    // already carried under that name, so there is one source of it.
    return { ...entry.site, sourceProject: entry.sourceProject };
  });
}

/**
 * The `policy` kind: the two fields the contract pins, from the loaded policy.
 *
 * @param {unknown} policy
 * @returns {{depConstraints: object[], moduleBoundaryOptions: Record<string, any>}}
 */
function bundlePolicy(policy) {
  if (!isPlainObject(policy)) {
    refuse(
      `policy: must be the loaded policy object (../config.mjs), got ${describeValue(policy)}`,
    );
  }
  if (!Array.isArray(policy.depConstraints)) {
    refuse(
      `policy.depConstraints: must be an array — a policy that declares no constraint rows ` +
        `declares [], got ${describeValue(policy.depConstraints)}`,
    );
  }
  if (!isPlainObject(policy.options)) {
    refuse(
      `policy.options: must be the loaded module-boundary options object — ../config.mjs names ` +
        `them "options" and requires every one of the eight to be stated, got ` +
        `${describeValue(policy.options)}`,
    );
  }
  return {
    depConstraints: [...policy.depConstraints],
    moduleBoundaryOptions: { ...policy.options },
  };
}

/**
 * The bundle's canonical UTF-8 bytes — what the host writes into a rule's
 * linear memory, and the only form a rule ever sees.
 *
 * Bytes rather than a string because that is what crosses the ABI, and
 * producing them here means the length the host allocates and the length it
 * writes are the same number by construction: a caller that measured a
 * string's `.length` instead would under-allocate for every non-ASCII
 * character in a project name or a reason.
 *
 * @param {EvidenceBundle} bundle
 * @returns {Uint8Array}
 */
export function serializeEvidenceBundle(bundle) {
  return new TextEncoder().encode(canonicalizeJson(bundle));
}

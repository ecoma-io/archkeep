/**
 * Ranked candidate model edits for `reconcile --propose` — the pure proposal
 * half.
 *
 * `reconcile-score.mjs` decides the divergence states. This module converts
 * each divergent element into a candidate edit of the canonical intent —
 * READ-ONLY: the candidate is a description of a change an intentional human
 * or agent might apply, never an application. Every candidate carries the
 * evidence that supports it (the scored element it repairs) and, through its
 * `proposed: true` / `notAuthoritative` marker, states plainly that the intent
 * file has not been touched.
 *
 * ## The edit vocabulary
 *
 * A candidate is one of four kinds:
 *
 * - `add` — the observed architecture carries an element the declared model
 *   does not admit: a project outside the declared existence model, a
 *   dependency outside the `dependencies.allowed` allowlist. The edit admits
 *   the observed element into the model.
 * - `removal` — the model states an element the observed architecture no
 *   longer builds: a required project that does not exist, a forbidden project
 *   that does, a forbidden dependency or tag rule the architecture builds. The
 *   edit drops the stale statement.
 * - `tag-change` — a required project lacks a required tag. The edit updates
 *   the project's required tags to what reality actually carries.
 * - `boundary-change` — a boundary `allowed`/`forbidden` row does not match
 *   the dependencies reality builds: the observed architecture builds a
 *   dependency a forbidden row bans, or never builds one an allowed row
 *   permits. The edit changes the boundary row.
 *
 * `match` and `unknown` states never produce a candidate: a `match` has
 * nothing to repair, and an `unknown` has no verdict to propose from.
 *
 * ## One candidate per divergence, never two
 *
 * Divergence appears on two sides — the observed element (a forbidden edge, a
 * missing required row's absence) and the intent row that states it. Both must
 * never propose the same edit. So the two sides feed disjoint classification
 * sets: observed elements propose `add` (`intentUnknownProject`,
 * `dependencyNotAllowed` — the two divergences with no row of their own to
 * edit), and intent rows propose the edit that changes the row
 * (`removal`, `tag-change`, `boundary-change`). The witness edge of a
 * forbidden boundary row is scored but never proposes — its row proposes for
 * it.
 *
 * ## Rank, determinism
 *
 * Candidates are ranked by the scored element's severity (all `unexpected` at
 * 4 before all `absent` at 3), then by a deterministic total order — plane,
 * then name — so two runs over an unchanged tree and intent produce the same
 * ranked list, byte for byte. Plain string comparison everywhere, never
 * `localeCompare`.
 */

/**
 * A candidate model edit.
 *
 * @typedef {object} CandidateEdit
 * @property {string} kind `"add"` | `"removal"` | `"tag-change"` | `"boundary-change"`.
 * @property {string} plane The scored element's plane.
 * @property {string} name The scored element's name.
 * @property {string} state The scored element's state (`"absent"` or `"unexpected"`).
 * @property {number} severity
 * @property {string} evidence The classification that supports the proposal.
 * @property {object|null} intentRow The scored element's `intentRow`, when the
 *   element came from the intent's own rows.
 * @property {object} edit A description of the concrete edit:
 *   `{action, section, key, value?, reason}`.
 * @property {boolean} proposed Always `true` — the candidate is a proposal,
 *   never an applied edit.
 * @property {boolean} notAuthoritative Always `true` — the intent file has not
 *   been modified.
 */

/** Observed-element divergences with no intent row of their own — `add`. */
const OBSERVED_ELEMENT_KIND = {
  intentUnknownProject: "add",
  dependencyNotAllowed: "add",
};

/** Intent-row divergences — the candidate edits the row itself. */
const INTENT_ROW_KIND = {
  projectMissing: "removal",
  projectPresent: "removal",
  dependencyForbidden: "removal",
  tagDependencyForbidden: "removal",
  projectTagMissing: "tag-change",
  intentForbiddenEdge: "boundary-change",
  intentAllowedMissing: "boundary-change",
};

/**
 * The concrete edit a candidate describes — the section, the row identity,
 * and the action an operator would take by hand.
 *
 * @param {import("./reconcile-score.mjs").ScoredElement} element
 * @returns {{action: string, section: string, key: string, value?: object, reason: string}}
 */
function editFor(element) {
  const section = element.intentRow ? sectionForRow(element) : sectionForPlane(element.plane);
  const base = { section, key: element.name };

  switch (element.classification) {
    case "intentUnknownProject":
      return {
        ...base,
        action: "add",
        reason:
          "the observed architecture carries a project the declared model does not admit — add it to the model",
      };
    case "dependencyNotAllowed":
      return {
        ...base,
        action: "add",
        reason:
          "the observed architecture builds a dependency outside dependencies.allowed — add it to the allowlist",
      };
    case "projectMissing":
      return {
        ...base,
        action: "remove",
        reason:
          "the intent requires this project, but the observed architecture does not build it — remove the required row, or build the project",
      };
    case "projectPresent":
      return {
        ...base,
        action: "remove",
        reason:
          "the intent forbids this project, but the observed architecture carries it — remove the forbidden row, or remove the project",
      };
    case "dependencyForbidden":
      return {
        ...base,
        action: "remove",
        reason:
          "the intent forbids this dependency, but the observed architecture builds it — remove the forbidden row",
      };
    case "tagDependencyForbidden":
      return {
        ...base,
        action: "remove",
        reason:
          "the intent forbids this tag dependency, but the observed architecture builds it — remove the tag rule",
      };
    case "projectTagMissing":
      return {
        ...base,
        action: "update required tags",
        reason:
          "a required project lacks a required tag — align the required tags with the project's actual tags",
      };
    case "intentForbiddenEdge": {
      const [from, to] = element.name.split(" → ");
      return {
        ...base,
        action: "change boundary row",
        value: { from, to },
        reason:
          "the observed architecture builds a dependency this boundary row forbids — relax the row or change the boundary",
      };
    }
    case "intentAllowedMissing": {
      const [from, to] = element.name.split(" → ");
      return {
        ...base,
        action: "change boundary row",
        value: { from, to },
        reason:
          "the intent allows a dependency the architecture never builds — build it, or change the boundary row",
      };
    }
    default:
      // Every real classification is handled above; a classification that
      // reaches the edit builder without an edit mapping is a programming
      // error, and inventing one here would propose an edit nothing in the
      // scoring model stands behind.
      throw new Error(`reconcile: classification ${element.classification} has no candidate edit`);
  }
}

/**
 * The intent section a row's edit would touch — derived from the row's `kind`,
 * so the proposal names where the operator edits.
 *
 * @param {import("./reconcile-score.mjs").ScoredElement} element
 * @returns {string}
 */
function sectionForRow(element) {
  switch (element.intentRow.kind) {
    case "required":
      return "projects.required";
    case "forbidden":
      return element.plane === "project" ? "projects.forbidden" : "dependencies.forbidden";
    case "tag-forbidden":
      return "forbiddenTags";
    case "allowed":
      return "dependencies.allowed";
    default:
      return element.plane;
  }
}

/**
 * The section an observed (row-less) element's edit would touch.
 *
 * @param {string} plane
 * @returns {string}
 */
function sectionForPlane(plane) {
  switch (plane) {
    case "project":
      return "projects";
    case "edge":
      return "dependencies";
    case "tag":
      return "forbiddenTags";
    case "boundary":
      return "boundaries";
    default:
      return plane;
  }
}

/**
 * Builds one candidate from a scored element, using the kind table that side
 * (observed element or intent row) owns.
 *
 * @param {import("./reconcile-score.mjs").ScoredElement} element
 * @param {Record<string, string>} kindByClassification
 * @returns {CandidateEdit|null} `null` when the state has nothing to propose.
 */
function candidateFromElement(element, kindByClassification) {
  if (element.state === "match" || element.state === "unknown") return null;
  const kind = kindByClassification[element.classification];
  if (kind === undefined) return null;

  return {
    kind,
    plane: element.plane,
    name: element.name,
    state: element.state,
    severity: element.severity,
    evidence: element.classification,
    intentRow: element.intentRow,
    edit: editFor(element),
    proposed: true,
    notAuthoritative: true,
  };
}

/**
 * Builds the ranked candidate list from scored divergence.
 *
 * Two disjoint sources, so a divergence is never proposed twice: observed
 * elements with no intent row of their own (`intentUnknownProject`,
 * `dependencyNotAllowed`, read from `scores.projects`/`scores.edges`) propose
 * `add`, and intent rows propose the edit that changes the row itself
 * (`removal`, `tag-change`, `boundary-change`, read from `scores.tags` — the
 * per-required-tag elements `scoreProject` emits — and `scores.intentRows`).
 * Candidates are ranked by severity (higher first — every `unexpected` before
 * every `absent`), then by plane, then name — byte-identical across runs over
 * an unchanged tree and intent.
 *
 * @param {object} scores From `reconcileScores`.
 * @returns {CandidateEdit[]}
 */
export function buildRankedCandidates(scores) {
  const candidates = [];

  for (const element of scores.projects) {
    const candidate = candidateFromElement(element, OBSERVED_ELEMENT_KIND);
    if (candidate !== null) candidates.push(candidate);
  }
  for (const element of scores.edges) {
    const candidate = candidateFromElement(element, OBSERVED_ELEMENT_KIND);
    if (candidate !== null) candidates.push(candidate);
  }
  // `scores.tags` carries `projectTagMissing` elements (a required project's
  // missing required tag) — an intent-row-owned divergence like `removal` and
  // `boundary-change`, so it reads the same INTENT_ROW_KIND table. Omitting
  // this loop left `projectTagMissing → "tag-change"` dead: `--propose` could
  // never surface the one candidate kind that repairs a missing required tag.
  for (const element of scores.tags) {
    const candidate = candidateFromElement(element, INTENT_ROW_KIND);
    if (candidate !== null) candidates.push(candidate);
  }
  for (const element of scores.intentRows) {
    const candidate = candidateFromElement(element, INTENT_ROW_KIND);
    if (candidate !== null) candidates.push(candidate);
  }

  candidates.sort(
    (a, b) =>
      b.severity - a.severity ||
      (a.plane < b.plane ? -1 : a.plane > b.plane ? 1 : 0) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return candidates;
}

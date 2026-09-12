// The protocol requirements: the forcing points of the agent-workflow
// protocol (docs/doctrine/agent-workflow-protocol.md), each pinned to the
// exact skill text that states it.
//
// Why this table exists: the agent-suite's transcript-marker scenarios used
// to author their own compliant review transcripts and grep them — the score
// was decided by the fixture, not by any artifact an agent consumes, and the
// whole suite stayed 10/10 green with the skill layer deleted (#935). The fix
// is not a second opinion about what the skills should say; it is one table,
// consumed twice:
//
//   - scripts/check-skills.mjs fails when an anchor stops matching the
//     shipped SKILL.md (the gate a pull request hits);
//   - agent-suite/protocol-gate.mjs runs the same table against the same
//     files inside every scenario (the suite a scenario edit hits).
//
// Editing the skill prose is expected and safe: anchors match the load-bearing
// phrases, not whole sentences. Deleting or weakening the claim is the red
// direction. A new forcing point gets a row here and a scenario binding —
// never a reworded copy inside a fixture.
export const PROTOCOL_REQUIREMENTS = [
  {
    id: "CLASSIFY-TRIVIAL-FLOOR",
    class: "G",
    skill: "arch-context",
    state: "CLASSIFY",
    summary: "a change that is not an architecture change is trivial — check once, stop",
    anchors: [/not an architecture change is trivial/u, /run `check` once and stop there/u],
  },
  {
    id: "CLASSIFY-NO-VERDICT-STOP",
    class: "E",
    skill: "arch-context",
    state: "CLASSIFY",
    summary: "an exit-3 context is a STOP; nothing downstream may claim clean",
    anchors: [/Exit 3 is a STOP, not a warning/u, /nothing downstream may claim clean/u],
  },
  {
    id: "CLASSIFY-FOREIGN-VERDICT",
    class: null,
    skill: "arch-context",
    state: "CLASSIFY",
    summary: "a verdict produced under another repo's law routes to that repo",
    anchors: [/routes to the repo whose law produced it/u, /never overridden locally/u],
  },
  {
    id: "BASELINE-BEFORE-DECLARE",
    class: null,
    skill: "arch-change",
    state: "BASELINE",
    summary: "the baseline is captured, on a clean committed tree, before declaring",
    anchors: [
      /Capture the baseline before declaring or editing/u,
      /Capture on a clean, committed tree/u,
    ],
  },
  {
    id: "BASELINE-CANONICAL-PATH",
    class: null,
    skill: "arch-change",
    state: "BASELINE",
    summary: "the evidence snapshot lives at .archkeep/base.json — the one name the review quotes",
    anchors: [/delta --capture --output \.archkeep\/base\.json/u],
  },
  {
    id: "DECLARE-BEFORE-IMPLEMENT",
    class: "A",
    skill: "arch-change",
    state: "DECLARE",
    summary: "a workflow-bearing change declares against the baseline before editing",
    anchors: [/declare against the/u, /--intent <manifest>/u, /before editing/u],
  },
  {
    id: "RECONCILE-AFTER-IMPLEMENT",
    class: "A",
    skill: "arch-change",
    state: "RECONCILE",
    summary: "the change is reconciled against the baseline after implementing",
    anchors: [/Reconcile after implementing/u],
  },
  {
    id: "RECONCILE-REDECLARE-LOOP",
    class: "B",
    skill: "arch-change",
    state: "RECONCILE",
    summary: "changedSinceBase routes back to DECLARE — a law-edit green is not a reconciliation",
    anchors: [/changedSinceBase[^.\n]{0,60}routes? back to DECLARE/u],
  },
  {
    id: "CHANGE-EVENT-EVIDENCE",
    class: "A",
    skill: "arch-change",
    state: "RECONCILE",
    summary: "the reconcile run writes its per-run event file as the audit trail",
    anchors: [/--event-out/u, /audit trail/u],
  },
  {
    id: "VERIFY-COVERAGE-GAPS-STOP",
    class: "D",
    skill: "arch-check",
    state: "VERIFY",
    summary: "green over a non-empty coverageGaps row is not a clean claim — stage or stop",
    anchors: [/A non-empty gap row is NOT a clean claim/u, /stage the files or stop/u],
  },
  {
    id: "VERIFY-WAIVERS-MANDATORY",
    class: "C",
    skill: "arch-check",
    state: "VERIFY",
    summary: "VERIFY runs the waivers command on every green check",
    anchors: [/waivers` command on every green check/u, /— mandatory:/u],
  },
  {
    id: "VERIFY-EXIT3-NEVER-CLEAN",
    class: "E",
    skill: "arch-check",
    state: "VERIFY",
    summary: "exit 3 is never clean; unknown/incomplete never silently becomes pass",
    anchors: [/Exit 3 is never/u, /never silently becomes PASS/u],
  },
  {
    id: "REVIEW-INCOMPLETE-REFUSAL",
    class: "F",
    skill: "arch-review",
    state: "REVIEW",
    summary: "no baseline on record is the review's INCOMPLETE refusal, never a verdict",
    anchors: [/report INCOMPLETE, naming the missing artifacts/u],
  },
  {
    id: "REVIEW-COMPLETION-BAR",
    class: "A",
    skill: "arch-review",
    state: "COMPLETE",
    summary: "COMPLETE requires quoting baseline identity, change verdict, and event path",
    anchors: [
      /COMPLETE requires quoting the baseline identity/u,
      /reconciliation\.verdict/u,
      /event artifact path/u,
    ],
  },
  {
    id: "REVIEW-QUOTES-SUPPRESSION-DELTA",
    class: "C",
    skill: "arch-review",
    state: "COMPLETE",
    summary: "a suppression delta the waivers step found is quoted at COMPLETE",
    anchors: [/suppression delta/u],
  },
  {
    id: "REVIEW-BLOCKING-RULE",
    class: "D",
    skill: "arch-review",
    state: "REVIEW",
    summary: "exit 1, exit 3, and a non-empty coverageGaps row all block approval",
    anchors: [/Exit 1 or exit 3 blocks/u, /coverageGaps` row is non-empty/u],
  },
  {
    id: "REVIEW-SCOPED-DISCLOSURE",
    class: null,
    skill: "arch-review",
    state: "REVIEW",
    summary: "a scoped run is disclosed as scoped; disclosure alone does not earn approval",
    anchors: [/disclosed as scoped/u, /does not earn approval/u],
  },
  {
    id: "REVIEW-FOREIGN-VERDICT-ROUTING",
    class: null,
    skill: "arch-review",
    state: "REVIEW",
    summary: "a foreign-law verdict routes to its owning repo, never overridden here",
    anchors: [/routes to the owning repo, never overridden locally/u],
  },
  {
    id: "MIGRATE-LAW-EDIT-DECLARED",
    class: "B",
    skill: "arch-migrate",
    state: "DECLARE",
    summary: "a law edit is itself a change under the workflow — baseline, declare, reconcile",
    anchors: [/A law edit is itself a change under the workflow/u],
  },
  {
    id: "MIGRATE-COVERAGE-FIRST",
    class: "E",
    skill: "arch-migrate",
    state: "CLASSIFY",
    summary: "clearing the coverage read is the one migration step that may not be skipped",
    anchors: [/only step that may not be skipped/u],
  },
];

/** Collapse the markdown line wrapping a skill file is formatted with, so an
 * anchor can span a wrapped line. Both consumers must match against the same
 * flattened text — an anchor that matches only in one of them is a gate and a
 * suite disagreeing about what the skill says. */
export function flattenSkillText(text) {
  return text.replace(/\s+/gu, " ");
}

/** True when every anchor of this one requirement is stated in its skill's
 * text. A missing skill file is an unmet requirement, not a skip. */
export function requirementMet(req, skillTexts) {
  const text = skillTexts[req.skill];
  if (typeof text !== "string") return false;
  const flat = flattenSkillText(text);
  return req.anchors.every((anchor) => anchor.test(flat));
}

/** The requirements whose anchors no skill text satisfies — empty means every
 * forcing point is stated where it belongs, in the skill prose itself. */
export function unmetRequirements(skillTexts) {
  return PROTOCOL_REQUIREMENTS.filter((req) => !requirementMet(req, skillTexts));
}

/** Every requirement anchored to one skill, keyed by that skill's name. */
export function requirementsForSkill(skill) {
  return PROTOCOL_REQUIREMENTS.filter((req) => req.skill === skill);
}

/** The requirement ids a scenario binds, resolved to their rows. Unknown ids throw — a typo in a
 * scenario's binding must be a loud harness error, not a silently weakened gate. */
export function requirementsByIds(ids) {
  const byId = new Map(PROTOCOL_REQUIREMENTS.map((req) => [req.id, req]));
  return ids.map((id) => {
    const req = byId.get(id);
    if (!req) {
      throw new Error(
        `unknown protocol requirement id "${id}" — pick one of: ${[...byId.keys()].join(", ")}`,
      );
    }
    return req;
  });
}

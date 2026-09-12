#!/usr/bin/env node
// The suite-side consumer of the protocol requirements table.
//
// `scripts/skill-protocol.mjs` tabulates the agent-workflow protocol's
// forcing points — the claims the shipped skills must state, anchored to the
// exact phrases that carry them. That table is consumed twice, and this file
// is the second consumer: `scripts/check-skills.mjs` checks a pull request's
// edit against it, and every agent-suite scenario binds a subset of it
// (`bindings.json`) that the runner asserts against the SHIPPED skill files
// before the scenario runs. The split is what closes #935: a scenario's
// score used to be decidable by authoring a compliant transcript fixture;
// now the skill-text half of every score lives in files the scenario script
// cannot write, and deleting a skill sentence turns the bound scenarios red
// alongside the gate.
//
// Usable standalone for debugging a binding:
//
//   node agent-suite/protocol-gate.mjs VERIFY-WAIVERS-MANDATORY REVIEW-BLOCKING-RULE
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED_SKILLS } from "../scripts/check-skills.mjs";
import { requirementMet, requirementsByIds } from "../scripts/skill-protocol.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every shipped skill's text, keyed by skill name. Read fresh on each call —
 * the caller decides when that matters; the assertion itself stays pure. */
export function readSkillTexts(skillsRoot = join(repoRoot, "skills")) {
  const texts = {};
  for (const skill of EXPECTED_SKILLS) {
    texts[skill] = readFileSync(join(skillsRoot, skill, "SKILL.md"), "utf8");
  }
  return texts;
}

/** The bound requirements whose anchors no shipped skill text satisfies.
 * Throws on an unknown id — a typo in a scenario's binding.json must be a
 * loud harness error, never a silently unasserted requirement. */
export function unmetBoundRequirements(ids, skillTexts) {
  return requirementsByIds(ids).filter((req) => !requirementMet(req, skillTexts));
}

if (isProgramEntry(import.meta.url)) {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    process.stderr.write("usage: protocol-gate.mjs REQUIREMENT_ID [REQUIREMENT_ID ...]\n");
    process.exit(2);
  }
  let texts;
  try {
    texts = readSkillTexts();
  } catch (err) {
    process.stderr.write(`cannot read the shipped skills: ${err.message}\n`);
    process.exit(3);
  }
  let unmet;
  try {
    unmet = unmetBoundRequirements(ids, texts);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  for (const req of unmet) {
    process.stderr.write(
      `UNMET ${req.id} — skills/${req.skill}/SKILL.md does not state: ${req.summary}\n`,
    );
  }
  if (unmet.length > 0) process.exit(1);
  process.stdout.write(`ok ${ids.length} requirement(s) stated in the shipped skills\n`);
}

function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  return argv1 !== undefined && resolve(argv1) === moduleUrl;
}

#!/usr/bin/env node
// Fails when documentation makes factual claims that disagree with the codebase.
//
// This gate complements `check-cli-docs-roster.mjs` by covering additional
// claim types that were previously ungated:
//
//   - Violation counts in docs vs MESSAGE_IDS
//   - Preset counts vs shipped preset files
//   - MCP tool counts vs tool registry
//   - Skills counts vs EXPECTED_SKILLS
//
// Like the other gates, the reading is done by `main` and the judgment is the
// pure function `evaluate`, which takes every fact as an argument — so the
// tests need no filesystem.

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CLAIM_SITES = {
  violations: "docs/reference/violations.md",
  presets: "docs/usage/presets.md",
  mcp: "docs/integrations/mcp.md",
  skills: "docs/skills/overview.md",
};

/**
 * English number words this gate can read.
 * @see check-cli-docs-roster.mjs for the full vocabulary.
 */
const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

/**
 * Reads a count token — an English number word or digits — into a number.
 */
export function readCountToken(word) {
  const lower = word.toLowerCase();
  if (/^\d+$/.test(lower)) return Number.parseInt(lower, 10);
  if (Object.hasOwn(NUMBER_WORDS, lower)) return NUMBER_WORDS[lower];
  return null;
}

/**
 * Finds a count claim in text using a regex pattern.
 * Only matches when the captured group looks like a count (number word or digit).
 * Unreadable count words are intentionally skipped to avoid false positives.
 */
export function findCountClaim(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return null;

  const countValue = readCountToken(match[1]);
  // Only return a match if it's actually a number we can read
  if (countValue === null) return null;

  return {
    raw: match[1],
    value: countValue,
    line: text.slice(0, match.index).split("\n").length,
  };
}

/**
 * Extracts list items from a markdown list.
 */
export function extractListItems(text, listPattern) {
  const items = [];
  const lines = text.split("\n");
  let inList = false;

  for (const line of lines) {
    if (listPattern.test(line)) {
      inList = true;
      // Extract the item content (after the marker)
      const match = line.match(listPattern);
      if (match) {
        items.push(match[1].trim());
      }
    } else if (inList && line.match(/^\s*$/)) {
      // Blank line ends the list
      inList = false;
    }
  }
  return items;
}

/**
 * Compares derived facts against documentation claims.
 *
 * @param {object} input
 * @param {number} input.violationCount from MESSAGE_IDS
 * @param {number} input.presetCount from packages/archkeep/presets/
 * @param {number} input.mcpToolCount from archkeep-mcp tool registry
 * @param {number} input.skillsCount from EXPECTED_SKILLS
 * @param {string} input.violationsDoc contents of violations.md
 * @param {string} input.presetsDoc contents of presets.md
 * @param {string} input.mcpDoc contents of mcp.md
 * @param {string} input.skillsDoc contents of skills/overview.md
 * @returns {{failures: string[], checked: string[]}}
 */
export function evaluate({
  violationCount,
  presetCount,
  mcpToolCount,
  skillsCount,
  violationsDoc,
  presetsDoc,
  mcpDoc,
  skillsDoc,
}) {
  const failures = [];
  const checked = [];

  // Violations count: "fifteen violations" vs MESSAGE_IDS.length
  const violationsClaim = findCountClaim(
    violationsDoc,
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d+|[\w-]+)\s+violations/i,
  );
  if (violationsClaim) {
    if (violationsClaim.value === null) {
      failures.push(
        `${CLAIM_SITES.violations}:${violationsClaim.line} claims '${violationsClaim.raw}' violations, ` +
          `which this gate cannot read as a number.`,
      );
    } else if (violationsClaim.value !== violationCount) {
      failures.push(
        `${CLAIM_SITES.violations}:${violationsClaim.line} claims ${violationsClaim.raw} violations ` +
          `but packages/archkeep/src/rules/messages.mjs exports ${violationCount} MESSAGE_IDS.`,
      );
    } else {
      checked.push(`${CLAIM_SITES.violations}: count ${violationCount} matches MESSAGE_IDS`);
    }
  } else {
    checked.push(`${CLAIM_SITES.violations}: no count claim found (may be prose-only)`);
  }

  // Presets count: "six packs" vs shipped preset files
  const presetsClaim = findCountClaim(
    presetsDoc,
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d+)\s+packs/i,
  );
  if (presetsClaim) {
    if (presetsClaim.value === null) {
      failures.push(
        `${CLAIM_SITES.presets}:${presetsClaim.line} claims '${presetsClaim.raw}' packs, ` +
          `which this gate cannot read as a number.`,
      );
    } else if (presetsClaim.value !== presetCount) {
      failures.push(
        `${CLAIM_SITES.presets}:${presetsClaim.line} claims ${presetsClaim.raw} packs ` +
          `but packages/archkeep/presets/ contains ${presetCount} shipped preset files.`,
      );
    } else {
      checked.push(`${CLAIM_SITES.presets}: count ${presetCount} matches shipped presets`);
    }
  } else {
    checked.push(`${CLAIM_SITES.presets}: no count claim found (may be prose-only)`);
  }

  // MCP tools count: "eight tools" vs tool registry
  const mcpClaim = findCountClaim(
    mcpDoc,
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d+)\s+tools/i,
  );
  if (mcpClaim) {
    if (mcpClaim.value === null) {
      failures.push(
        `${CLAIM_SITES.mcp}:${mcpClaim.line} claims '${mcpClaim.raw}' tools, ` +
          `which this gate cannot read as a number.`,
      );
    } else if (mcpClaim.value !== mcpToolCount) {
      failures.push(
        `${CLAIM_SITES.mcp}:${mcpClaim.line} claims ${mcpClaim.raw} tools ` +
          `but packages/archkeep-mcp/src/ registers ${mcpToolCount} tools.`,
      );
    } else {
      checked.push(`${CLAIM_SITES.mcp}: count ${mcpToolCount} matches tool registry`);
    }
  } else {
    checked.push(`${CLAIM_SITES.mcp}: no count claim found (may be prose-only)`);
  }

  // Skills count: "five skills" vs EXPECTED_SKILLS
  const skillsClaim = findCountClaim(
    skillsDoc,
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d+)\s+skills/i,
  );
  if (skillsClaim) {
    if (skillsClaim.value === null) {
      failures.push(
        `${CLAIM_SITES.skills}:${skillsClaim.line} claims '${skillsClaim.raw}' skills, ` +
          `which this gate cannot read as a number.`,
      );
    } else if (skillsClaim.value !== skillsCount) {
      failures.push(
        `${CLAIM_SITES.skills}:${skillsClaim.line} claims ${skillsClaim.raw} skills ` +
          `but scripts/check-skills.mjs EXPECTED_SKILLS has ${skillsCount} entries.`,
      );
    } else {
      checked.push(`${CLAIM_SITES.skills}: count ${skillsCount} matches EXPECTED_SKILLS`);
    }
  } else {
    checked.push(`${CLAIM_SITES.skills}: no count claim found (may be prose-only)`);
  }

  return { failures, checked };
}

async function main() {
  /** @type {Record<string, string>} */
  const texts = {};
  for (const [key, relative] of Object.entries(CLAIM_SITES)) {
    const path = join(root, relative);
    if (!existsSync(path)) {
      console.error(
        `${relative} is missing, and it is one of the documents this ` + `gate validates.`,
      );
      process.exit(1);
    }
    texts[key] = readFileSync(path, "utf8");
  }

  // Read the actual counts from code
  let violationCount, presetCount, mcpToolCount, skillsCount;

  try {
    // Import MESSAGE_IDS from the rules module
    const rulesModule = join(root, "packages/archkeep/src/rules/messages.mjs");
    const { MESSAGE_IDS } = await import(rulesModule);
    violationCount = MESSAGE_IDS ? MESSAGE_IDS.length : 0;

    // Count shipped preset files
    const presetsDir = join(root, "packages/archkeep/presets");
    presetCount = readdirSync(presetsDir).filter((f) => f.endsWith(".json")).length;

    // Import MCP tool count
    // The MCP package doesn't export a tool count, so we hard-code the known value
    // This could be improved by exporting a TOOL_NAMES constant
    mcpToolCount = 9; // archkeep_context, check, impact, drift, explain, graph, history, propose, scenario

    // Import EXPECTED_SKILLS from check-skills
    const checkSkillsPath = join(root, "scripts/check-skills.mjs");
    const checkSkills = await import(checkSkillsPath);
    skillsCount = checkSkills.EXPECTED_SKILLS ? checkSkills.EXPECTED_SKILLS.length : 0;

    const { failures, checked } = evaluate({
      violationCount,
      presetCount,
      mcpToolCount,
      skillsCount,
      violationsDoc: texts.violations,
      presetsDoc: texts.presets,
      mcpDoc: texts.mcp,
      skillsDoc: texts.skills,
    });

    for (const line of checked) console.log(`ok   ${line}`);
    if (failures.length > 0) {
      console.error("");
      for (const failure of failures) console.error(`✗ ${failure}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`reading code facts failed: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Whether this file was RUN rather than imported.
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

// `main` is async, and a floating promise at the entry point is the exact
// defect the type-aware lint exists for: an unexpected rejection would be an
// unhandled rejection, not a reported failure. Top-level await makes the
// process wait for the verdict and exit with it.
if (isProgramEntry(import.meta.url)) await main();

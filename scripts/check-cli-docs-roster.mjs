#!/usr/bin/env node
// Fails when the documents that claim a command count or list the command
// roster disagree with `COMMAND_NAMES`, the roster `packages/archkeep/cli.mjs`
// itself exports.
//
// WHY this script exists (issue #238). Four places tell a reader how many
// commands the CLI has, and two of them list every verb:
//
//   - `README.md`            — "<N> commands with versioned, byte-stable JSON"
//   - `packages/archkeep/README.md` — "the rest of the <N>-command surface"
//   - `docs/concepts/architecture.md` — a "The <N> commands" heading AND a
//     full table of every verb
//   - `docs/reference/cli.md` — the authoritative Commands table
//
// None of them is generated, so each is a second copy of a fact whose home is
// the CLI itself. A command added to or removed from `cli.mjs` leaves all four
// saying the old thing, and no gate noticed — the silent direction this
// repository judges everything against: byte-for-byte identical to a clean
// docs tree, and nobody ever files it.
//
// The roster is DERIVED, never restated here: `main` imports `COMMAND_NAMES`
// from `packages/archkeep/cli.mjs`, the same export
// `src/report/envelope-shape.integration.test.mjs` builds on. A hard-coded
// list of seventeen verbs in this file would be exactly the bug
// `check-packages.mjs` was written to end — a second copy agreeing with the
// first only until someone edits one of them.
//
// What IS written here is the location of each claim — the sentence shape and
// the table each document carries. Those are addresses, not facts: if a
// document rewords its claim, this gate fails loudly asking for the pair to be
// updated together, which is the contract a prose pin can offer. An empty
// result from this gate therefore means "every claim site was found and agrees
// with `COMMAND_NAMES`", and nothing else.
//
// Like the other gates in this directory, the reading is done by `main` and
// the judgment is the pure function `evaluate`, which takes every fact as an
// argument — so the tests need no filesystem. The live enforcement point is
// the integration case in `check-cli-docs-roster.test.mjs`, which runs under
// `pnpm test` in CI against the real files.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CLAIM_SITES = {
  rootReadme: "README.md",
  packageReadme: "packages/archkeep/README.md",
  cliReference: "docs/reference/cli.md",
  architectureConcept: "docs/concepts/architecture.md",
};

/**
 * English number words this gate can read, up to the range a command surface
 * plausibly claims. This is vocabulary, not a fact of this repository — the
 * count itself always comes from `COMMAND_NAMES`. A claim written as a word
 * outside this table fails loudly rather than being skipped.
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
 *
 * @param {string} word the captured claim token, e.g. "seventeen" or "18"
 * @returns {number | null} the value, or null when it cannot be read
 */
export function readCountToken(word) {
  const lower = word.toLowerCase();
  if (/^\d+$/.test(lower)) return Number.parseInt(lower, 10);
  if (Object.hasOwn(NUMBER_WORDS, lower)) return NUMBER_WORDS[lower];
  return null;
}

/**
 * Finds the "<N> commands ..." count claim in a document.
 *
 * @param {string} text the document's contents
 * @param {RegExp} pattern a regex whose FIRST group captures the count token
 * @returns {{raw: string, value: number | null, line: number} | null}
 */
export function findCountClaim(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return null;
  return {
    raw: match[1],
    value: readCountToken(match[1]),
    line: text.slice(0, match.index).split("\n").length,
  };
}

/** The count-claim sentence shapes, one per claiming document. */
export const COUNT_PATTERNS = {
  rootReadme: /([A-Za-z]+|\d+)\s+commands\s+with\s+versioned/,
  packageReadme: /([A-Za-z]+|\d+)-command\s+surface/,
  architectureConcept: /^##\s+The\s+([A-Za-z]+|\d+)\s+commands?\s*$/m,
};

/**
 * Extracts the command verbs from a reference table: markdown table rows whose
 * first cell is a bare lowercase backticked word (`| `check`      | … |`).
 * Flag tables cannot false-positive — their first cells start with `--` — and
 * the exit-code table's cells are digits, so the row shape alone identifies a
 * command row.
 *
 * When `sectionHeading` is given, only the section under the FIRST heading
 * matching it is read; elsewhere the whole document is read.
 *
 * @param {string} text the document's contents
 * @param {RegExp} [sectionHeading] heading regex scoping the table search
 * @returns {string[]} verbs in document order
 */
export function extractTableCommands(text, sectionHeading) {
  let body = text;
  if (sectionHeading) {
    const match = sectionHeading.exec(text);
    if (!match) return [];
    const rest = text.slice(match.index);
    const nextHeading = /\n#{1,6}\s/.exec(rest.slice(1));
    body = nextHeading ? rest.slice(0, nextHeading.index + 1) : rest;
  }
  const verbs = [];
  const row = /^\|\s*`([a-z][a-z0-9]*)`\s*\|/;
  for (const line of body.split("\n")) {
    const match = row.exec(line);
    if (match) verbs.push(match[1]);
  }
  return verbs;
}

/**
 * Compares the derived roster against every claim site. Every fact arrives as
 * an argument; nothing here reads a file.
 *
 * @param {object} input
 * @param {string[]} input.commandNames the roster, from `COMMAND_NAMES`
 * @param {string} input.rootReadme contents of `README.md`
 * @param {string} input.packageReadme contents of `packages/archkeep/README.md`
 * @param {string} input.cliReference contents of `docs/reference/cli.md`
 * @param {string} input.architectureConcept contents of `docs/concepts/architecture.md`
 * @returns {{failures: string[], checked: string[]}} failures name both sides
 *   of every disagreement; `checked` states what was verified, so a green run
 *   is a coverage claim rather than silence
 */
export function evaluate({
  commandNames,
  rootReadme,
  packageReadme,
  cliReference,
  architectureConcept,
}) {
  const failures = [];
  const checked = [];

  const countSites = [
    { label: `${CLAIM_SITES.rootReadme}`, text: rootReadme, pattern: COUNT_PATTERNS.rootReadme },
    {
      label: `${CLAIM_SITES.packageReadme}`,
      text: packageReadme,
      pattern: COUNT_PATTERNS.packageReadme,
    },
    {
      label: `${CLAIM_SITES.architectureConcept} (heading)`,
      text: architectureConcept,
      pattern: COUNT_PATTERNS.architectureConcept,
    },
  ];
  for (const site of countSites) {
    const claim = findCountClaim(site.text, site.pattern);
    if (!claim) {
      failures.push(
        `${site.label}: no command-count claim found where this pin expects one. ` +
          `Either the sentence moved or was reworded — update the document and ` +
          `this gate's pattern together, because a count claim nothing compares ` +
          `against is the drift this gate exists to catch.`,
      );
      continue;
    }
    if (claim.value === null) {
      failures.push(
        `${site.label}:${claim.line} claims '${claim.raw}', which this gate cannot ` +
          `read as a number. Write the count as digits or a spelled number from ` +
          `one to twenty.`,
      );
      continue;
    }
    if (claim.value !== commandNames.length) {
      failures.push(
        `${site.label}:${claim.line} claims ${claim.raw} commands (${claim.value}), ` +
          `but packages/archkeep/cli.mjs exports ${commandNames.length} ` +
          `(COMMAND_NAMES). One of the two just changed — find out which, then ` +
          `fix it there.`,
      );
      continue;
    }
    checked.push(`${site.label}: count ${commandNames.length} matches COMMAND_NAMES`);
  }

  const rosterSites = [
    {
      label: `${CLAIM_SITES.cliReference} (Commands table)`,
      verbs: extractTableCommands(cliReference, /^##\s+Commands\s*$/m),
    },
    {
      label: `${CLAIM_SITES.architectureConcept} (command table)`,
      verbs: extractTableCommands(architectureConcept, /^##\s+The\s+[A-Za-z0-9]+\s+commands?\s*$/m),
    },
  ];
  for (const site of rosterSites) {
    if (site.verbs.length === 0) {
      failures.push(
        `${site.label}: no command rows found where this pin expects the roster ` +
          `table. Either the table moved or was reshaped — update the document ` +
          `and this gate together.`,
      );
      continue;
    }
    const docSet = new Set(site.verbs);
    const codeSet = new Set(commandNames);
    const missingFromDoc = commandNames.filter((name) => !docSet.has(name));
    const notInCode = site.verbs.filter((verb) => !codeSet.has(verb));
    if (missingFromDoc.length > 0 || notInCode.length > 0) {
      const parts = [];
      if (missingFromDoc.length > 0) {
        parts.push(`cli.mjs exports verbs the table is missing: ${missingFromDoc.join(", ")}`);
      }
      if (notInCode.length > 0) {
        parts.push(`the table lists verbs cli.mjs does not export: ${notInCode.join(", ")}`);
      }
      failures.push(`${site.label}: ${parts.join("; ")}.`);
      continue;
    }
    checked.push(`${site.label}: all ${commandNames.length} verbs match COMMAND_NAMES`);
  }

  return { failures, checked };
}

function main() {
  /** @type {Record<string, string>} */
  const texts = {};
  for (const [key, relative] of Object.entries(CLAIM_SITES)) {
    const path = join(root, relative);
    if (!existsSync(path)) {
      console.error(
        `${relative} is missing, and it is one of the documents this ` +
          `pin holds to the CLI's own roster.`,
      );
      process.exit(1);
    }
    texts[key] = readFileSync(path, "utf8");
  }

  import("../packages/archkeep/cli.mjs")
    .then(({ COMMAND_NAMES }) => {
      if (!Array.isArray(COMMAND_NAMES) || COMMAND_NAMES.length === 0) {
        console.error(
          "packages/archkeep/cli.mjs exported no COMMAND_NAMES roster, so there is " +
            "nothing to compare the documents against. Either the export moved or " +
            "was renamed — restore it rather than listing the commands here, " +
            "because a second copy is the drift this gate exists to catch.",
        );
        process.exit(1);
      }
      const { failures, checked } = evaluate({
        commandNames: COMMAND_NAMES,
        rootReadme: texts.rootReadme,
        packageReadme: texts.packageReadme,
        cliReference: texts.cliReference,
        architectureConcept: texts.architectureConcept,
      });
      for (const line of checked) console.log(`ok   ${line}`);
      if (failures.length > 0) {
        console.error("");
        for (const failure of failures) console.error(`✗ ${failure}`);
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error(`importing packages/archkeep/cli.mjs failed: ${error.message}`);
      process.exit(1);
    });
}

/**
 * Whether this file was RUN rather than imported, compared on real paths —
 * duplicated beside each gate script (see `check-packages.mjs`) because the
 * obvious URL spelling goes false behind a symlinked checkout, and a gate
 * that silently skips its own main is the green-nothing this directory
 * refuses to produce.
 *
 * @param {string | URL} moduleUrl
 * @param {string} [argv1]
 * @returns {boolean}
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

if (isProgramEntry(import.meta.url)) main();

#!/usr/bin/env node
// Fails when `docs/getting-started/installation.md`'s prerequisites table
// disagrees with what `packages/lattice/package.json` actually declares.
//
// WHY this script exists (issue #239). The table restates, in prose a new user
// reads before installing:
//
//   - Node        ← `engines.node`
//   - TypeScript  ← `peerDependencies.typescript`, required
//   - Vue         ← `peerDependencies.vue` + `peerDependenciesMeta.vue.optional`
//   - the Nx paragraph ← `peerDependenciesMeta.nx.optional`
//
// and nothing compared the two. A version bump on the manifest side — exactly
// the kind of edit Renovate opens every week — left the document stating wrong
// install requirements to every new user, and no gate turned red, because a
// prose claim about a range is invisible to a link checker.
//
// The ranges are DERIVED from the parsed manifest, never restated here: this
// file holds no version numbers. What it holds is the address of each claim —
// which table row or sentence carries it — so a reworded document fails loudly
// and asks for the pair to be updated together. An empty result therefore
// means "every stated requirement agrees with the manifest", and nothing else.
//
// Like the other gates in this directory, judgment is the pure function
// `evaluate`, taking the parsed manifest and the document text as arguments;
// only `main` touches the filesystem. The live enforcement point is the
// integration case in `check-installation-prereqs.test.mjs`, running under
// `pnpm test` in CI.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DOC_PATH = "docs/getting-started/installation.md";
export const MANIFEST_PATH = "packages/lattice/package.json";

/** The prerequisite rows the table must carry; absence is a failure, not a skip. */
export const REQUIRED_ROWS = ["Node", "TypeScript", "Vue"];

/**
 * The sentence installation.md uses to state that Nx is an optional peer. Its
 * presence is pinned against `peerDependenciesMeta.nx.optional` in both
 * directions: a manifest that makes nx required while the sentence stands —
 * or the reverse — fails.
 */
export const NX_OPTIONAL_SENTENCE = /Nx is a peer dependency, but an optional one/;

/**
 * Splits a semver-range-shaped string into normalized comparator clauses:
 * a manifest range like ">=5 <7" becomes the two clauses [">=5", "<7"].
 * Whitespace inside a clause (">= 5") is removed on both sides before
 * comparison, because the document spells ranges for humans and the manifest
 * spells them for npm.
 *
 * @param {string} range a range string from either side
 * @returns {string[]} clauses, e.g. [">=5", "<7"]; empty when none match
 */
export function rangeClauses(range) {
  const clauses = [];
  // Dots belong to multi-part versions only (`3.1`), never trailing prose
  // punctuation — "< 7. Required even…" must read as "<7", not "<7.".
  const re = /(>=|<=|>|<|=|\^|~)\s*\d+(?:\.\d+)*(?:\.[xX*])?/g;
  let match;
  while ((match = re.exec(range))) {
    clauses.push(match[0].replace(/\s+/g, ""));
  }
  return clauses;
}

/**
 * Extracts the prerequisites table as name → cell text, scoped to the
 * `## Prerequisites` section so prose elsewhere cannot satisfy a row.
 *
 * @param {string} docText contents of installation.md
 * @returns {Map<string, string>} row name → everything after its first cell
 */
export function parsePrereqRows(docText) {
  const sectionStart = /^##\s+Prerequisites\s*$/m.exec(docText);
  if (!sectionStart) return new Map();
  const rest = docText.slice(sectionStart.index);
  const nextHeading = /\n#{1,6}\s/.exec(rest.slice(1));
  const body = nextHeading ? rest.slice(0, nextHeading.index + 1) : rest;

  const rows = new Map();
  for (const line of body.split("\n")) {
    const match = /^\|\s*([^|\s][^|]*?)\s*\|(.+?)\|?\s*$/.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    // The alignment row (`| ---------- | ... |`) is not a prerequisite.
    if (/^-+$/.test(name)) continue;
    rows.set(name, match[2].trim());
  }
  return rows;
}

const sameClauses = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * Compares the document's claims against the parsed manifest. Nothing here
 * reads a file; both sides arrive as arguments.
 *
 * @param {object} input
 * @param {object} input.manifest parsed `packages/lattice/package.json`
 * @param {string} input.installationDoc contents of installation.md
 * @returns {{failures: string[], checked: string[]}}
 */
export function evaluate({ manifest, installationDoc }) {
  const failures = [];
  const checked = [];
  const rows = parsePrereqRows(installationDoc);

  for (const name of REQUIRED_ROWS) {
    if (!rows.has(name)) {
      failures.push(
        `${DOC_PATH}: the prerequisites table has no ${name} row where this pin ` +
          `expects one. Either the row was dropped or renamed — update the ` +
          `document and this gate together.`,
      );
    }
  }
  if (rows.size === 0) {
    failures.push(`${DOC_PATH}: no Prerequisites table found at all.`);
    return { failures, checked };
  }

  const peerDeps = manifest.peerDependencies ?? {};
  const meta = manifest.peerDependenciesMeta ?? {};

  // Node — engines.node
  const enginesNode = manifest.engines?.node;
  if (typeof enginesNode !== "string" || enginesNode.length === 0) {
    failures.push(
      `${MANIFEST_PATH}: engines.node is missing or not a string, so the pin has ` +
        `no manifest side to compare the Node prerequisite against.`,
    );
  } else if (rows.has("Node")) {
    const docClauses = rangeClauses(rows.get("Node"));
    const manifestClauses = rangeClauses(enginesNode);
    if (!sameClauses(docClauses, manifestClauses)) {
      failures.push(
        `${DOC_PATH}'s prerequisites table says Node '${rows.get("Node")}', but ` +
          `${MANIFEST_PATH} declares engines.node '${enginesNode}'. One of the two ` +
          `just changed — find out which, then fix it there.`,
      );
    } else {
      checked.push(`Node ${enginesNode}: document matches engines.node`);
    }
  }

  // TypeScript — peerDependencies.typescript, required
  const tsRange = peerDeps.typescript;
  if (rows.has("TypeScript")) {
    const cell = rows.get("TypeScript");
    if (typeof tsRange !== "string" || tsRange.length === 0) {
      failures.push(
        `${MANIFEST_PATH}: peerDependencies.typescript is missing, so the pin has ` +
          `no manifest side to compare the TypeScript prerequisite against.`,
      );
    } else if (!sameClauses(rangeClauses(cell), rangeClauses(tsRange))) {
      failures.push(
        `${DOC_PATH}'s prerequisites table says TypeScript '${cell}', but ` +
          `${MANIFEST_PATH} declares peerDependencies.typescript '${tsRange}'. One ` +
          `of the two just changed.`,
      );
    } else {
      checked.push(`TypeScript ${tsRange}: document matches peerDependencies`);
    }
    const docRequired = /required/i.test(cell);
    const manifestOptional = meta.typescript?.optional === true;
    if (docRequired === manifestOptional) {
      failures.push(
        `${DOC_PATH}'s TypeScript row ${docRequired ? "says 'Required'" : "does not say 'Required'"} ` +
          `while ${MANIFEST_PATH} declares typescript ` +
          `${manifestOptional ? "optional" : "without an optional marker"} — the two ` +
          `disagree about whether a workspace without TypeScript may install.`,
      );
    } else {
      checked.push(`TypeScript requiredness: document and peerDependenciesMeta agree`);
    }
  }

  // Vue — peerDependencies.vue + optionality
  if (rows.has("Vue")) {
    const cell = rows.get("Vue");
    const vueRange = peerDeps.vue;
    const manifestOptional = meta.vue?.optional === true;
    const docOptional = /optional/i.test(cell);
    if (manifestOptional && !docOptional) {
      failures.push(
        `${DOC_PATH}'s Vue row ('${cell}') does not say optional, but ` +
          `${MANIFEST_PATH} marks vue optional — a workspace without .vue files ` +
          `would read a hard requirement here that the manifest does not impose.`,
      );
    } else if (!manifestOptional && docOptional) {
      failures.push(
        `${DOC_PATH}'s Vue row says optional, but ${MANIFEST_PATH} no longer marks ` +
          `vue optional (peerDependenciesMeta) — the document offers a skip the ` +
          `manifest now refuses.`,
      );
    } else {
      checked.push(`Vue optionality (${manifestOptional}): document matches peerDependenciesMeta`);
    }
    if (typeof vueRange === "string" && vueRange.length > 0) {
      if (!sameClauses(rangeClauses(cell), rangeClauses(vueRange))) {
        failures.push(
          `${DOC_PATH}'s prerequisites table says Vue '${cell}', but ` +
            `${MANIFEST_PATH} declares peerDependencies.vue '${vueRange}'. One of ` +
            `the two just changed.`,
        );
      } else {
        checked.push(`Vue ${vueRange}: document matches peerDependencies`);
      }
    } else {
      failures.push(
        `${MANIFEST_PATH}: peerDependencies.vue is missing, yet the prerequisites ` +
          `table still states a Vue requirement ('${cell}') with nothing behind it.`,
      );
    }
  }

  // Nx — the optional-peer sentence vs peerDependenciesMeta.nx.optional
  const docSaysOptionalPeer = NX_OPTIONAL_SENTENCE.test(installationDoc);
  const manifestNxOptional = Object.hasOwn(peerDeps, "nx") && meta.nx?.optional === true;
  if (docSaysOptionalPeer !== manifestNxOptional) {
    failures.push(
      `${DOC_PATH} ${docSaysOptionalPeer ? "states" : "no longer states"} that Nx is ` +
        `an optional peer dependency, while ${MANIFEST_PATH} ` +
        `${manifestNxOptional ? "declares nx optional (peerDependenciesMeta)" : "does not declare nx as an optional peer"} — ` +
        `update whichever side just moved.`,
    );
  } else {
    checked.push(`Nx optional peer: document sentence matches peerDependenciesMeta`);
  }

  return { failures, checked };
}

function main() {
  const docPath = join(root, DOC_PATH);
  const manifestPath = join(root, MANIFEST_PATH);
  for (const path of [docPath, manifestPath]) {
    if (!existsSync(path)) {
      console.error(`${path} is missing, and it is one side of the parity this pin enforces.`);
      process.exit(1);
    }
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error(`${MANIFEST_PATH} does not parse as JSON: ${error.message}`);
    process.exit(1);
  }

  const { failures, checked } = evaluate({
    manifest,
    installationDoc: readFileSync(docPath, "utf8"),
  });
  for (const line of checked) console.log(`ok   ${line}`);
  if (failures.length > 0) {
    console.error("");
    for (const failure of failures) console.error(`✗ ${failure}`);
    process.exit(1);
  }
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

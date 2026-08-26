/**
 * Every number `README.md` states about this catalogue, held to the catalogue.
 *
 * The ledger beside this file is the document a reader consults before trusting
 * `src/rules/`, and its numbers are the part that rots first: they are written
 * by hand, they change whenever a case is added, and nothing about a stale one
 * looks wrong. One of them survived three edits of the header it was derived
 * from and ended up matching no reading of the catalogue at all.
 *
 * So the numbers are derived here and compared, rather than remembered. A count
 * that stops matching fails this test instead of misleading someone, which is
 * the arrangement that keeps a value honest when it cannot live in exactly one
 * place: the prose keeps its number, and a gate keeps the prose honest.
 *
 * `statedNumber` throws when the sentence it reads has moved, rather than
 * finding nothing and passing. A guard that silently stops guarding is worse
 * than no guard, because the README then looks checked.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { languageOf } from "../analysis/registry.mjs";
import { MESSAGE_IDS } from "../rules/messages.mjs";
import { CONFORMANCE_CASES } from "./cases.mjs";
import { ARCHITECTURE_CORPUS } from "./corpus.mjs";
import { isUpstreamReadable } from "./engines.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const README = readFileSync(join(HERE, "README.md"), "utf8");

/**
 * The numbers one sentence states, in source order.
 *
 * @param {RegExp} pattern Global, must match exactly once, capturing each number.
 * @param {string} sentence What it reads, for the failure message.
 * @returns {number[]}
 */
function statedNumbers(pattern, sentence) {
  const matches = [...README.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `README.md states ${sentence} in ${matches.length} places this guard can read, not one. ` +
        `Move the pattern with the sentence — a pattern that matches nothing checks nothing, ` +
        `and the number goes back to drifting unwatched.`,
    );
  }
  return matches[0].slice(1).map(Number);
}

/** Every probe in the catalogue, across every case. */
const probes = CONFORMANCE_CASES.flatMap((spec) => spec.probes);

/**
 * Says which sentence is wrong and what the catalogue holds instead, so the
 * failure alone is enough to correct the README without re-deriving anything.
 */
const correction = (what) => `README.md's "${what}" no longer matches the catalogue; write`;

describe("the numbers README.md states about this catalogue", () => {
  it("counts the cases, probes and projects the catalogue actually holds", () => {
    const [cases, probeCount, projects] = statedNumbers(
      /\*\*(\d+) fixture workspaces, (\d+) probes, (\d+) projects\.\*\*/gu,
      "the size of the catalogue",
    );

    expect(cases, correction("N fixture workspaces")).toBe(CONFORMANCE_CASES.length);
    expect(probeCount, correction("N probes")).toBe(probes.length);
    expect(projects, correction("N projects")).toBe(
      CONFORMANCE_CASES.flatMap((spec) => /** @type {readonly any[]} */ (spec.projects)).length,
    );
  });

  it("counts the probes where ESLint must report nothing", () => {
    // The near-miss half is what stops the suite proving only that two engines
    // can both stay silent, so its size is a claim about the suite's worth.
    const [nearMisses, ofTotal] = statedNumbers(
      /(\d+) of the (\d+) probes\s+are near-misses/gu,
      "how many probes are near-misses",
    );

    expect(ofTotal, correction("of the N probes")).toBe(probes.length);
    expect(nearMisses, correction("N of the … probes are near-misses")).toBe(
      probes.filter((probe) => (probe.upstream ?? []).length === 0).length,
    );
  });

  it("counts the fixture workspaces ESLint can read, where agreement is measurable at all", () => {
    // A case whose every probe is Go, Rust or Python measures this engine
    // against an ESLint that never parsed the file, so it says nothing about
    // agreement. `isUpstreamReadable` is the differential's own predicate
    // rather than a second copy of the extension list.
    const [readableCases] = statedNumbers(
      /the (\d+) fixture workspaces ESLint can\s+read/gu,
      "how many fixture workspaces ESLint can read",
    );

    expect(readableCases, correction("the N fixture workspaces ESLint can read")).toBe(
      CONFORMANCE_CASES.filter((spec) =>
        spec.probes.some((probe) => isUpstreamReadable(probe.file)),
      ).length,
    );
  });

  it("keeps the defect ledger's size a derived fact rather than a remembered one", () => {
    // The ledger is what the catalogue DECLARES as weaker, which is a fact
    // about `cases.mjs` and needs no ESLint run to read. The differential holds
    // those declarations to what the two engines actually do, so a number
    // agreeing with the declarations agrees with reality too.
    //
    // Printed rather than asserted against the prose: this file states the
    // ledger's shape in words, and a reader who wants the count can take it
    // from here or from the run. What must never happen is the count moving
    // without anyone noticing, which the differential's own ledger test covers.
    const ledgered = probes.filter(
      (probe) => "divergence" in probe && probe.divergence?.direction === "weaker",
    );
    const readable = ledgered.filter((probe) => isUpstreamReadable(probe.file));

    // Every declared false negative must sit on a file ESLint can parse.
    // Declaring one on a `.go`, `.rs` or `.py` probe would be declaring a
    // divergence from an engine that never looked.
    expect(
      ledgered.length - readable.length,
      "false negatives declared on files ESLint cannot parse",
    ).toBe(0);
  });

  it("gives the differential table one row per violation type this engine reports", () => {
    // A message id added upstream and left out of the transcription leaves the
    // table looking complete. The run's own table is driven off the installed
    // rule; this holds the copy in the README to the same set of ids without
    // needing ESLint, so it fails in seconds rather than in two minutes.
    const rows = [
      ...README.matchAll(
        /^\| `(\w+)` +\| +\d+ \| +\d+ \| +\d+ \| +\d+ \| (?=[^|]*[A-Za-z(])[^|]+\|$/gmu,
      ),
    ].map((match) => match[1]);

    // Zero rows means the pattern stopped matching the table, not that the
    // table emptied — a column added to the run's output and transcribed here
    // does exactly that. Say so, because "expected 0 to be 15" reads as a
    // missing table and sends the reader to the wrong file.
    expect(
      rows.length,
      "rows in the differential table (zero means this pattern no longer matches its shape)",
    ).toBe(MESSAGE_IDS.length);
    expect([...rows].sort()).toEqual([...MESSAGE_IDS].sort());
  });
});

/** Every probe in the labeled corpus, across every case. */
const corpusProbes = ARCHITECTURE_CORPUS.flatMap((spec) => spec.probes);

describe("the numbers README.md states about the labeled corpus", () => {
  // The corpus half of this file, and it is the half whose numbers cost the
  // least to state and the most to be wrong about: nothing outside this
  // directory measures Go, Rust or Python conformance, so a reader deciding
  // whether to trust that half has only these figures and the run behind them.
  it("counts the cases, probes and projects the corpus actually holds", () => {
    const [cases, probeCount, projects] = statedNumbers(
      /\*\*(\d+) fixture workspaces, (\d+) probes, (\d+) projects\*\*, carrying/gu,
      "the size of the labeled corpus",
    );

    expect(cases, correction("N fixture workspaces … carrying")).toBe(ARCHITECTURE_CORPUS.length);
    expect(probeCount, correction("N probes … carrying")).toBe(corpusProbes.length);
    expect(projects, correction("N projects, carrying")).toBe(
      ARCHITECTURE_CORPUS.flatMap((spec) => /** @type {readonly any[]} */ (spec.projects)).length,
    );
  });

  it("counts the labeled findings and the probes that must produce none", () => {
    // The near-miss half is the load-bearing one here for the same reason it
    // is next door: a corpus of positives proves an engine can be loud.
    const [findings, nearMisses] = statedNumbers(
      /carrying (\d+) labeled findings\s+and (\d+) near-miss probes/gu,
      "how many findings and near-misses the corpus carries",
    );

    expect(findings, correction("N labeled findings")).toBe(
      corpusProbes.flatMap((probe) => /** @type {readonly any[]} */ (probe.reports)).length,
    );
    expect(nearMisses, correction("N near-miss probes")).toBe(
      corpusProbes.filter((probe) => probe.reports.length === 0).length,
    );
  });

  it("holds every cell of the rule-by-language table to the catalogue", () => {
    // Unlike the differential table above, every cell here is derivable
    // without running anything: a corpus label says which rule fires on which
    // file, and the file's extension says which language it is. So the whole
    // table is checked rather than only its row set — a cell that drifts is a
    // claim about coverage that nothing else in this repository would catch.
    const LANGUAGES = ["go", "rust", "python", "typescript", "java"];
    const derived = new Map();
    // A probe in a language this table has no column for would otherwise be
    // counted into `row[-1]` — a property, not a cell — and the finding would
    // vanish from a table that still added up. Collected and asserted instead,
    // because "the table has no column for that" is a fact about the README
    // that has to be fixed there rather than dropped here.
    const uncolumned = [];
    for (const spec of ARCHITECTURE_CORPUS) {
      for (const probe of spec.probes) {
        const language = languageOf(probe.file);
        const column = LANGUAGES.indexOf(language);
        for (const report of probe.reports) {
          if (column === -1) {
            uncolumned.push(`${spec.id}: ${probe.file} reports in ${language}`);
            continue;
          }
          const row = derived.get(report.messageId) ?? LANGUAGES.map(() => 0);
          row[column] += 1;
          derived.set(report.messageId, row);
        }
      }
    }
    expect(uncolumned, "findings in a language the stated table has no column for").toEqual([]);

    const stated = new Map(
      [
        ...README.matchAll(/^\| `(\w+)` +\| +(\d+) \| +(\d+) \| +(\d+) \| +(\d+) \| +(\d+) \|$/gmu),
      ].map((match) => [match[1], match.slice(2).map(Number)]),
    );

    // Zero rows means the pattern stopped matching the table rather than the
    // table emptying — the same failure mode the differential table's own
    // guard names, and the same wording, because the reader is sent to the
    // wrong file by "expected 0 to be 12" either way.
    expect(
      stated.size,
      "rows in the rule-by-language table (zero means this pattern no longer matches its shape)",
    ).toBe(derived.size);
    for (const [messageId, counts] of derived) {
      expect(stated.get(messageId), correction(`the ${messageId} row`)).toEqual(counts);
    }
  });

  it("states how many message ids the corpus reaches, and over how many languages", () => {
    const [reached, ofTotal, languageCount] = statedNumbers(
      /\*\*(\d+) of the (\d+) message ids, over (\d+) languages\.\*\*/gu,
      "how much of the rule set the corpus reaches",
    );
    const ids = new Set(
      corpusProbes.flatMap((probe) =>
        /** @type {readonly any[]} */ (probe.reports).map((report) => report.messageId),
      ),
    );
    const languages = new Set(
      corpusProbes
        .filter((probe) => probe.reports.length > 0)
        .map((probe) => languageOf(probe.file)),
    );

    expect(reached, correction("N of the … message ids")).toBe(ids.size);
    expect(ofTotal, correction("of the N message ids")).toBe(MESSAGE_IDS.length);
    expect(languageCount, correction("over N languages")).toBe(languages.size);
  });
});

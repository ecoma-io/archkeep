// Tests for check-cli-docs-roster.mjs.
//
// `evaluate`, `findCountClaim`, `readCountToken` and `extractTableCommands`
// take every fact as an argument, so these run with no filesystem and no
// mocking framework. The final cases are the live enforcement point: they
// read the repository's real documents and the real `COMMAND_NAMES` export,
// which is what makes this pin hold during CI's `pnpm test` rather than only
// against this file's fixtures.
//
// Every drift direction named in the module header has a case that goes red on
// a fixture — count drift, roster drift in both directions, and each way a
// claim site can disappear. A test that only pinned today's green output would
// pass identically on the day the pin stopped being enforced.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  COUNT_PATTERNS,
  CLAIM_SITES,
  evaluate,
  extractTableCommands,
  readCountToken,
} from "./check-cli-docs-roster.mjs";

const ROSTER = ["check", "graph", "diff", "adr"];

const commandTable = (verbs) =>
  [
    "| command | summary |",
    "| --- | --- |",
    ...verbs.map((v) => `| \`${v}\`      | does things |`),
  ].join("\n");

/**
 * Builds a full argument set for `evaluate`, every claim site green by
 * default; tests override one site at a time to go red.
 *
 * @param {{root?: string, pkg?: string, cliVerbs?: string[], archVerbs?: string[]}} [overrides]
 * @returns {{commandNames: string[], rootReadme: string, packageReadme: string,
 *   cliReference: string, architectureConcept: string}}
 */
function docs({
  root = "four commands with versioned JSON",
  pkg = "the four-command surface",
  cliVerbs,
  archVerbs,
} = {}) {
  return {
    commandNames: ROSTER,
    rootReadme: root,
    packageReadme: pkg,
    cliReference: `# CLI\n\n## Commands\n\n${commandTable(cliVerbs ?? ROSTER)}\n`,
    architectureConcept: `## The four commands\n\n${commandTable(archVerbs ?? ROSTER)}\n`,
  };
}

test("reads spelled and digit counts alike", () => {
  assert.equal(readCountToken("seventeen"), 17);
  assert.equal(readCountToken("18"), 18);
});

test("an unreadable count word is reported, never skipped", () => {
  assert.equal(readCountToken("umpteen"), null);
  const { failures } = evaluate(docs({ root: "umpteen commands with versioned JSON" }));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /cannot read as a number/);
  assert.match(failures[0], /umpteen/);
});

test("a count claim that disappears fails loudly instead of passing silently", () => {
  // If README rewords or drops its sentence, zero claims found must be a
  // failure — an empty result here would mean "all sites agree", which would
  // be false.
  const { failures } = evaluate(docs({ root: "deterministic evidence for scripts" }));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no command-count claim found/);
});

test("count drift fails naming BOTH numbers", () => {
  const { failures } = evaluate(docs({ root: "sixteen commands with versioned JSON" }));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /README\.md/);
  assert.match(failures[0], /sixteen/);
  assert.match(failures[0], /16/);
  assert.match(failures[0], /4/); // COMMAND_NAMES.length in this fixture
});

test("each claiming document is judged, not just the first", () => {
  const { failures } = evaluate(docs({ pkg: "the fifteen-command surface" }));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /packages\/lattice\/README\.md/);
  assert.match(failures[0], /15/);
});

test("roster drift names the verbs missing from the document", () => {
  const { failures } = evaluate(docs({ cliVerbs: ROSTER.slice(0, -1) }));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /docs\/reference\/cli\.md/);
  assert.match(failures[0], /missing: adr/);
});

test("roster drift names the verbs the document has that the code does not", () => {
  const { failures } = evaluate(docs({ archVerbs: [...ROSTER, "frobnicate"] }));
  const rosterFailures = failures.filter((f) => f.includes("architecture.md"));
  assert.equal(rosterFailures.length, 1);
  assert.match(rosterFailures[0], /does not export: frobnicate/);
});

test("flag tables and exit-code tables are not misread as command rows", () => {
  const text = [
    "## Commands",
    "",
    "| command | s |",
    "| `check` | x |",
    "",
    "## Flags",
    "",
    "| flag | meaning |",
    "| `--format` | text or json |",
    "",
    "## Exit codes",
    "",
    "| code | meaning |",
    "| 3    | no verdict |",
  ].join("\n");
  assert.deepEqual(extractTableCommands(text), ["check"]);
});

test("extraction scopes to one heading when given one", () => {
  // The architecture page carries other tables elsewhere; without scoping, a
  // future table with a lowercase first cell would silently join the roster.
  const text = [
    "## The four commands",
    "",
    commandTable(ROSTER),
    "",
    "## Something else",
    "",
    "| `stray` | x |",
  ].join("\n");
  assert.deepEqual(extractTableCommands(text, /^##\s+The\s+four\s+commands\s*$/m), ROSTER);
});

test("a reference table that vanishes fails instead of comparing nothing", () => {
  const { failures } = evaluate(docs({ cliVerbs: [] }));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /docs\/reference\/cli\.md/);
  assert.match(failures[0], /no command rows found/);
});

test("a green fixture checks every site it claims to", () => {
  const { failures, checked } = evaluate(docs());
  assert.deepEqual(failures, []);
  // Three count sites + two roster sites — if a future edit adds a site to
  // `evaluate` without teaching it to report coverage, this line goes red.
  assert.equal(checked.length, 5);
});

test("the real documents agree with COMMAND_NAMES", async () => {
  const rootUrl = new URL("..", import.meta.url);
  const read = (relative) => readFileSync(new URL(relative, rootUrl), "utf8");
  /** @type {Record<string, string>} */
  const texts = Object.fromEntries(
    Object.entries(CLAIM_SITES).map(([key, relative]) => [key, read(relative)]),
  );
  const { COMMAND_NAMES } = await import("../packages/lattice/cli.mjs");
  // The silent-direction guard for this file: an empty roster or unreadable
  // documents must fail here rather than let a vacuous comparison pass.
  assert.ok(COMMAND_NAMES.length > 0);
  const { failures } = evaluate({
    commandNames: [...COMMAND_NAMES],
    rootReadme: texts.rootReadme,
    packageReadme: texts.packageReadme,
    cliReference: texts.cliReference,
    architectureConcept: texts.architectureConcept,
  });
  assert.deepEqual(failures, []);
});

test("the real claim sentences still match the patterns this gate reads", () => {
  // Pins the PATTERNS, not just today's values: a reworded claim sentence with
  // a still-correct number would otherwise go unnoticed until the next count
  // drift — months after the address went stale.
  for (const [key, pattern] of Object.entries(COUNT_PATTERNS)) {
    const text = readFileSync(new URL(`../${CLAIM_SITES[key]}`, import.meta.url), "utf8");
    assert.ok(pattern.test(text), `${CLAIM_SITES[key]} no longer matches its count pattern`);
  }
});

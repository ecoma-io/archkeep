// Tests for check-installation-prereqs.mjs.
//
// Both sides of every comparison arrive as arguments — a parsed manifest
// object and document text — so these run with no filesystem and no mocking.
// The final case reads the real pair and is the live enforcement point under
// CI's `pnpm test`.
//
// Each drift direction has a red fixture: range drift on either side,
// optionality flipping in either direction, and each way a claim can vanish
// from the table. A pin whose tests only asserted today's green would keep
// passing while it compared nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DOC_PATH,
  MANIFEST_PATH,
  NX_OPTIONAL_SENTENCE,
  evaluate,
  parsePrereqRows,
  rangeClauses,
} from "./check-installation-prereqs.mjs";

const MANIFEST = {
  engines: { node: ">=22" },
  peerDependencies: { typescript: ">=5 <7", vue: ">=3", nx: ">=21" },
  peerDependenciesMeta: { vue: { optional: true }, nx: { optional: true } },
};

const DOC = [
  "## Prerequisites",
  "",
  "|            |          |",
  "| ---------- | -------- |",
  "| Node       | >= 22    |",
  "| TypeScript | >= 5 and < 7. Required even in a workspace with none",
  "| Vue        | optional, >= 3 -- needed only for .vue files |",
  "",
  "Nx is a peer dependency, but an optional one -- the engine runs without it.",
].join("\n");

test("ranges split into normalized comparator clauses", () => {
  assert.deepEqual(rangeClauses(">=5 <7"), [">=5", "<7"]);
  assert.deepEqual(rangeClauses(">= 22"), [">=22"]);
  assert.deepEqual(rangeClauses("optional, >= 3"), [">=3"]);
  // A comparator followed by prose punctuation must not swallow the dot:
  // this exact shape is what installation.md's TypeScript row carries.
  assert.deepEqual(rangeClauses(">= 5 and < 7. Required even in a workspace with none"), [
    ">=5",
    "<7",
  ]);
  assert.deepEqual(rangeClauses("no clauses here"), []);
});

test("the prerequisites table parses by row name", () => {
  const rows = parsePrereqRows(DOC);
  assert.equal(rows.get("Node"), ">= 22");
  assert.match(rows.get("TypeScript") ?? "", /Required/);
  assert.match(rows.get("Vue") ?? "", /optional/);
});

test("a dropped or renamed prerequisite row fails instead of skipping", () => {
  const withoutVue = DOC.replace(/\n\| Vue .*/, "");
  const { failures } = evaluate({ manifest: MANIFEST, installationDoc: withoutVue });
  assert.ok(failures.some((f) => f.includes("no Vue row")));
});

test("a manifest range bump with no doc edit fails naming BOTH values", () => {
  const bumped = {
    ...MANIFEST,
    peerDependencies: { ...MANIFEST.peerDependencies, typescript: ">=5 <8" },
  };
  const { failures } = evaluate({ manifest: bumped, installationDoc: DOC });
  const ts = failures.filter((f) => f.includes("TypeScript"));
  assert.equal(ts.length, 1);
  assert.match(ts[0], />= 5 and < 7/);
  assert.match(ts[0], />=5 <8/);
});

test("the same failure fires when the DOCUMENT moves and the manifest stands", () => {
  // The silent direction does not care which side drifted; both must be named.
  const driftedDoc = DOC.replace("< 7", "< 6");
  const { failures } = evaluate({ manifest: MANIFEST, installationDoc: driftedDoc });
  const ts = failures.filter((f) => f.includes("TypeScript") && f.includes("declares"));
  assert.equal(ts.length, 1);
  assert.match(ts[0], />=5 <7/);
});

test("engines.node drift fails against the Node row", () => {
  const bumped = { ...MANIFEST, engines: { node: ">=24" } };
  const { failures } = evaluate({ manifest: bumped, installationDoc: DOC });
  assert.ok(failures.some((f) => f.includes("Node") && f.includes(">=24")));
});

test("optionality flipping on Vue fails in BOTH directions", () => {
  // Manifest still optional, document stops saying so — a hard requirement
  // invented in prose.
  const docMandatory = DOC.replace("| Vue        | optional,", "| Vue        | required,");
  const docFailures = evaluate({ manifest: MANIFEST, installationDoc: docMandatory }).failures;
  assert.ok(docFailures.some((f) => f.includes("Vue") && f.includes("does not say optional")));

  // Manifest drops the optional marker, document still offers the skip.
  const noVueMeta = {
    ...MANIFEST,
    peerDependenciesMeta: { typescript: { optional: true }, nx: { optional: true } },
  };
  const manifestFailures = evaluate({ manifest: noVueMeta, installationDoc: DOC }).failures;
  assert.ok(manifestFailures.some((f) => f.includes("Vue") && f.includes("no longer marks")));
});

test("TypeScript requiredness is pinned, not just its range", () => {
  const nowOptional = {
    ...MANIFEST,
    peerDependenciesMeta: { ...MANIFEST.peerDependenciesMeta, typescript: { optional: true } },
  };
  const { failures } = evaluate({ manifest: nowOptional, installationDoc: DOC });
  assert.ok(failures.some((f) => f.includes("TypeScript") && f.includes("disagree")));
});

test("the Nx sentence tracks peerDependenciesMeta.nx.optional in both directions", () => {
  const nxRequired = {
    ...MANIFEST,
    peerDependenciesMeta: { vue: { optional: true } },
  };
  const { failures } = evaluate({ manifest: nxRequired, installationDoc: DOC });
  assert.ok(failures.some((f) => f.includes("Nx") && f.includes("does not declare")));

  const withoutSentence = DOC.split("\n")
    .filter((l) => !NX_OPTIONAL_SENTENCE.test(l))
    .join("\n");
  const reverse = evaluate({ manifest: MANIFEST, installationDoc: withoutSentence }).failures;
  assert.ok(reverse.some((f) => f.includes("Nx") && f.includes("no longer states")));
});

test("a missing Prerequisites section is a loud failure, not an empty pass", () => {
  const { failures } = evaluate({
    manifest: MANIFEST,
    installationDoc: "# Installation\n\nJust install it.",
  });
  assert.ok(failures.some((f) => f.includes("no Prerequisites table")));
  assert.ok(failures.length >= 4); // section + all three rows
});

test("the real document agrees with the real manifest", () => {
  const rootUrl = new URL("..", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL(MANIFEST_PATH, rootUrl), "utf8"));
  const doc = readFileSync(new URL(DOC_PATH, rootUrl), "utf8");
  // The silent-direction guard: an unreadable side must throw here rather
  // than let a vacuous comparison pass.
  assert.ok(Object.keys(manifest.peerDependencies ?? {}).length > 0);
  const { failures } = evaluate({ manifest, installationDoc: doc });
  assert.deepEqual(failures, []);
});

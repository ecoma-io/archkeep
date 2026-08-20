// Unit tests for the pure helpers the real-tree differential's child process
// exports: `classifyUpstreamNote` and `partitionUpstreamMessages`. Everything
// else in `differential-real-trees-child.mjs` needs a real cloned tree, the
// tree's own nx, and a real ESLint run — this is the part that does not.
//
// The case to read first is the SILENT-direction one: a parse-failed file
// classified as noise would drop out of every map a reader checks, and "zero
// verdicts" on a file nobody parsed reads exactly like "checked, clean". Every
// message shape asserted here was measured against this repository's own
// pinned eslint, driven through the same `ESLint` API the child uses —
// `classifyUpstreamNote`'s doc comment carries the measurement.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyUpstreamNote,
  partitionUpstreamMessages,
} from "./differential-real-trees-child.mjs";

test("a fatal parse error is unreadable — classified as noise it would masquerade as clean", () => {
  // The silent direction: the boundary rule never ran on a file ESLint could
  // not parse, so "no boundary message" there is not a verdict. This is the
  // exact message shape code-pushup's two parser fixtures produce at the
  // pinned sha.
  const message = {
    ruleId: null,
    fatal: true,
    message: "Parsing error: Property assignment expected.",
  };
  assert.equal(classifyUpstreamNote(message), "unreadable");
});

test("a directive naming a rule outside the override config is noise — the rule still ran", () => {
  // Measured: a probe file carrying this directive still had its configured
  // rule fire on it, so the message impairs nothing this differential
  // compares. Classifying it unreadable failed a whole release-lane run over
  // 93 such files (release run 32378064880, 2026-08-20).
  const message = {
    ruleId: "functional/no-let",
    fatal: false,
    message: "Definition for rule 'functional/no-let' was not found.",
  };
  assert.equal(classifyUpstreamNote(message), "noise");
});

test("an unused eslint-disable directive is noise — the directive reporter, not a read failure", () => {
  const message = {
    ruleId: null,
    fatal: false,
    message: "Unused eslint-disable directive (no problems were reported from 'max-lines').",
  };
  assert.equal(classifyUpstreamNote(message), "noise");
});

test("an unrecognised ruleId-less message is unreadable — fail-closed, never guessed harmless", () => {
  // ESLint's file-ignored warning is the known member of this class: a file
  // it covers was never linted at all, which no noise classification may
  // absorb. Any shape this function has not measured lands here too.
  const message = {
    ruleId: null,
    fatal: false,
    message: 'File ignored because of a matching ignore pattern. Use "--no-ignore" to disable.',
  };
  assert.equal(classifyUpstreamNote(message), "unreadable");
});

test("an unrecognised message that carries a ruleId is unreadable — fail-closed there too", () => {
  // A real rule message here would mean the override config ran a rule this
  // differential never configured — not a shape to wave through as noise.
  const message = { ruleId: "some/rule", fatal: false, message: "something unforeseen" };
  assert.equal(classifyUpstreamNote(message), "unreadable");
});

test("a Definition-not-found message WITHOUT a ruleId is unreadable — the measured shape carries one", () => {
  // The noise classification is two measured (ruleId, text) pairs, not a text
  // match alone; half a match is an unmeasured shape and stays fail-closed.
  const message = {
    ruleId: null,
    fatal: false,
    message: "Definition for rule 'functional/no-let' was not found.",
  };
  assert.equal(classifyUpstreamNote(message), "unreadable");
});

test("partition splits one tree's results three ways, keyed by workspace-relative file", () => {
  const treeRoot = "/tmp/tree";
  const results = [
    {
      filePath: "/tmp/tree/libs/a/src/index.ts",
      messages: [
        { ruleId: "@nx/enforce-module-boundaries", fatal: false, message: "not allowed" },
        {
          ruleId: "functional/no-let",
          fatal: false,
          message: "Definition for rule 'functional/no-let' was not found.",
        },
      ],
    },
    {
      filePath: "/tmp/tree/libs/broken/src/index.ts",
      messages: [{ ruleId: null, fatal: true, message: "Parsing error: bad" }],
    },
    { filePath: "/tmp/tree/libs/clean/src/index.ts", messages: [] },
  ];

  const { upstreamByFile, noiseByFile, unreadableByFile } = partitionUpstreamMessages(
    results,
    treeRoot,
  );

  assert.deepEqual([...upstreamByFile.keys()], ["libs/a/src/index.ts"]);
  assert.equal(upstreamByFile.get("libs/a/src/index.ts")?.[0].message, "not allowed");
  assert.deepEqual(noiseByFile.get("libs/a/src/index.ts"), [
    "functional/no-let: Definition for rule 'functional/no-let' was not found.",
  ]);
  assert.deepEqual(
    [...unreadableByFile],
    [["libs/broken/src/index.ts", ["eslint: Parsing error: bad"]]],
  );
});

test("a parse-failed file lands in unreadable even when noise sits beside it on other files", () => {
  // The regression that broke release run 32378064880 in the OTHER direction:
  // the old guard threw on the noise files and the whole tree went dark.
  // Partitioned, the noise files stay comparable and only the parse failure
  // is a could-not-look record.
  const results = [
    {
      filePath: "/t/a.ts",
      messages: [{ ruleId: null, fatal: false, message: "Unused eslint-disable directive (x)." }],
    },
    {
      filePath: "/t/b.ts",
      messages: [{ ruleId: null, fatal: true, message: "Parsing error: bad" }],
    },
  ];
  const { upstreamByFile, noiseByFile, unreadableByFile } = partitionUpstreamMessages(
    results,
    "/t",
  );
  assert.equal(upstreamByFile.size, 0);
  assert.deepEqual([...noiseByFile.keys()], ["a.ts"]);
  assert.deepEqual([...unreadableByFile.keys()], ["b.ts"]);
});

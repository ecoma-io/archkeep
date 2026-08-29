import { test } from "node:test";
import assert from "node:assert/strict";

import { TREES, evaluate } from "./coverage-real-trees.mjs";

/** A one-tree table, so a case states only what it is about. */
const table = (expected) => [{ name: "tree", expected }];
const pinned = { sources: 10, records: 40, unreadable: 2 };
const measured = (overrides = {}) => [{ name: "tree", ...pinned, ...overrides }];

test("a measurement matching every pin is silent", () => {
  assert.deepEqual(evaluate(table(pinned), measured()), []);
});

test("fewer records than pinned is named as the silent direction", () => {
  // The failure this lane exists for: an analyzer that stopped reading a
  // syntax reports fewer records and nothing else changes.
  const breaches = evaluate(table(pinned), measured({ records: 31 }));
  assert.equal(breaches.length, 1);
  assert.match(breaches[0], /records is 31, pinned at 40/u);
  assert.match(breaches[0], /silent direction/u);
});

test("more records than pinned is a breach too, worded as the other side", () => {
  // Growth is not automatically good. At a pinned sha the tree cannot move, so
  // more records is the harness changing without anyone measuring it.
  const breaches = evaluate(table(pinned), measured({ records: 44 }));
  assert.equal(breaches.length, 1);
  assert.match(breaches[0], /nobody measured it/u);
});

test("a failure count that fell is a breach, not an improvement", () => {
  // A failure that stopped being reported is a file that now looks read. That
  // is the same silence the whole repository is built against, wearing the
  // costume of a fixed bug.
  const breaches = evaluate(table(pinned), measured({ unreadable: 0 }));
  assert.equal(breaches.length, 1);
  assert.match(breaches[0], /unreadable is 0, pinned at 2/u);
});

test("a file count that moved is a breach even when the record count did not", () => {
  const breaches = evaluate(table(pinned), measured({ sources: 9 }));
  assert.equal(breaches.length, 1);
  assert.match(breaches[0], /sources is 9/u);
});

test("every breached key is reported, not only the first", () => {
  const breaches = evaluate(table(pinned), measured({ sources: 1, records: 1, unreadable: 1 }));
  assert.equal(breaches.length, 3);
});

test("a tree with no measurement at all is a breach naming that", () => {
  // The difference between "measured and matched" and "never looked" is the
  // whole point; an absent measurement must never fall through as agreement.
  const breaches = evaluate(table(pinned), []);
  assert.equal(breaches.length, 1);
  assert.match(breaches[0], /no measurement at all/u);
});

test("a table pinning no sources is refused rather than passed", () => {
  // A tree pinned at zero would agree with a run that read nothing — the
  // placeholder green this repository's gates exist to catch.
  assert.throws(
    () => evaluate(table({ sources: 0, records: 0, unreadable: 0 }), measured({ sources: 0 })),
    /measures nothing/u,
  );
});

test("the shipped table covers the languages the ESLint differential cannot", () => {
  // The lane's reason to exist, held to the table: if a language dropped out
  // of it, the gap would be silent — the remaining trees would still pass.
  // Kotlin rides the okhttp tree's extensions rather than its own entry: the
  // JVM package index reads both, so one tree exercises the pair.
  assert.deepEqual([...new Set(TREES.map((tree) => tree.language))].sort(), [
    "csharp",
    "go",
    "java",
    "python",
    "rust",
  ]);
});

test("every shipped tree pins a sha, a license and a non-empty expectation", () => {
  for (const tree of TREES) {
    assert.match(tree.sha, /^[0-9a-f]{40}$/u, `${tree.name} does not pin a full sha`);
    assert.ok(tree.license.length > 0, `${tree.name} names no license`);
    assert.ok(tree.expected.sources > 0, `${tree.name} pins no sources`);
    assert.ok(tree.expected.records > 0, `${tree.name} pins no records`);
  }
});

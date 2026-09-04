import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSummary,
  parseArgs,
  TREES,
  classifyFailures,
  evaluate,
} from "./coverage-real-trees.mjs";

/** A one-tree table, so a case states only what it is about. */
const table = (expected) => [{ name: "tree", expected }];
const pinned = { sources: 10, records: 40, unreadable: 2, disclosedExternal: 3 };
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
  const breaches = evaluate(
    table(pinned),
    measured({ sources: 1, records: 1, unreadable: 1, disclosedExternal: 1 }),
  );
  assert.equal(breaches.length, 4);
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
    () =>
      evaluate(
        table({ sources: 0, records: 0, unreadable: 0, disclosedExternal: 0 }),
        measured({ sources: 0 }),
      ),
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
    assert.equal(
      typeof tree.expected.disclosedExternal,
      "number",
      `${tree.name} pins no disclosed-external column`,
    );
  }
});

// The envelope's classification half — the mapping the coverage job's
// reconcile step decides from (#691: the lane red four times and filed
// nothing, because it wrote no envelope at all). The silent direction here is
// a class that understates the run: an infra message classified as ok, or a
// breach classified as infra, would let a red run touch — or fail to open —
// the trail's issue for the wrong reason.
test("a clean run's envelope reads ok and carries no breach", () => {
  assert.deepEqual(buildSummary(0, []), { exitCode: 0, exitClass: "ok", breaches: [] });
});

test("breaches classify findings and are carried verbatim, never re-formatted", () => {
  const breach =
    "gin: records is 500, pinned at 518 — the analyzer reads less of this tree than it did";
  const summary = buildSummary(1, [breach]);
  assert.equal(summary.exitClass, "findings");
  assert.equal(summary.exitCode, 1);
  assert.deepEqual(summary.breaches, [breach]);
  assert.equal("infrastructure" in summary, false);
});

test("an infrastructure message classifies infra even with an empty breach list", () => {
  const summary = buildSummary(3, [], "git fetch exited 128");
  assert.equal(summary.exitClass, "infra");
  assert.equal(summary.exitCode, 3);
  assert.deepEqual(summary.breaches, []);
  assert.equal(summary.infrastructure, "git fetch exited 128");
});

test("the exit code and the class never disagree about which run was red", () => {
  // The reconcile step reads the class; a human reads the code. One mapping,
  // both facts from the same call.
  assert.equal(buildSummary(0, []).exitClass, "ok");
  assert.equal(buildSummary(1, ["x"]).exitClass, "findings");
  assert.equal(buildSummary(3, [], "x").exitClass, "infra");
});

test("parseArgs accepts --summary-out alone and refuses anything else loudly", () => {
  assert.deepEqual(parseArgs([]), { summaryOut: undefined });
  assert.deepEqual(parseArgs(["--summary-out", "/tmp/envelope.json"]), {
    summaryOut: "/tmp/envelope.json",
  });
  assert.throws(
    () => parseArgs(["--exit-class-of", "/tmp/envelope.json"]),
    /unrecognised argument/u,
  );
  assert.throws(() => parseArgs(["--summary-out"]), /needs a file path/u);
});

test("an external disclosure is counted disclosed, never unreadable", () => {
  // #618's rows ride `coverage.blindSpots` and withhold no verdict — the
  // analyzer read the file and judged it; what it names lives outside every
  // declared project. An inline `failures.length` counts the disclosure
  // anyway, which is what made every tree red the day #618 landed (#690):
  // a tree whose whole import surface is third-party measured 100% unreadable.
  const counts = classifyFailures([
    {
      sourceFile: "binding/route.go",
      line: 7,
      column: 9,
      reason: "Go cannot resolve 'github.com/stretchr/testify/assert' from 'binding/route.go'",
      external: true,
    },
  ]);
  assert.deepEqual(counts, { unreadable: 0, disclosedExternal: 1 });
});

test("a mixed failure set puts every failure in its own column", () => {
  // One row of each withholding class beside two disclosures. The whole-file
  // refusal, the workspace-surface site and the dynamic declared limit all
  // mean the analyzer could not fully read the file — `unreadable` is theirs.
  // Only the `external: true` class is a disclosure, and it gets its own
  // column rather than being swallowed or folded into either neighbour.
  const counts = classifyFailures([
    {
      sourceFile: "src/lib.rs",
      line: null,
      column: null,
      reason: "a `use` statement never reaches its `;` — the file is truncated or malformed",
    },
    {
      sourceFile: "pkg/specifier.py",
      line: 4,
      column: 1,
      reason:
        "relative import '..' climbs past the top-level package of 'pkg/specifier.py', " +
        "which leaves the project's import root — Python rejects it the same way",
    },
    {
      sourceFile: "loader.py",
      line: 12,
      column: 3,
      reason:
        "dynamic import of 'name' has a non-literal argument, so its target is not knowable statically",
      dynamic: true,
    },
    {
      sourceFile: "internal/route.go",
      line: 9,
      column: 8,
      reason: "Go cannot resolve 'github.com/stretchr/testify/assert' from 'internal/route.go'",
      external: true,
    },
    {
      sourceFile: "client.kt",
      line: 20,
      column: 5,
      reason: "Java cannot resolve 'okio.ByteString' from 'client.kt'",
      external: true,
    },
  ]);
  assert.deepEqual(counts, { unreadable: 3, disclosedExternal: 2 });
});

test("no failures counts nothing in either column", () => {
  assert.deepEqual(classifyFailures([]), { unreadable: 0, disclosedExternal: 0 });
});

test("disclosedExternal pins exactly like the other keys", () => {
  // The disclosure column is a measurement, not a footnote. A disclosure that
  // vanished is a read that went quiet (the silent direction — the analyzer
  // stopped reporting what it saw); one that appeared is an event nobody
  // measured. Exact in both directions, like every pinned count here.
  const fewer = evaluate(table(pinned), measured({ disclosedExternal: 1 }));
  assert.equal(fewer.length, 1);
  assert.match(fewer[0], /disclosedExternal is 1, pinned at 3/u);
  assert.match(fewer[0], /silent direction/u);
  const more = evaluate(table(pinned), measured({ disclosedExternal: 9 }));
  assert.equal(more.length, 1);
  assert.match(more[0], /nobody measured it/u);
});

test("a measurement without the disclosure column is a breach naming it", () => {
  // A measureTree that forgot to report the column must not pass by
  // comparing nothing — the placeholder-green shape again.
  const breaches = evaluate(table(pinned), [
    /** @type {*} */ ({
      name: "tree",
      sources: pinned.sources,
      records: pinned.records,
      unreadable: pinned.unreadable,
    }),
  ]);
  assert.equal(breaches.length, 1);
  assert.match(breaches[0], /disclosedExternal is undefined, pinned at 3/u);
});

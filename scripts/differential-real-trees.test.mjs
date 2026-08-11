// Unit tests for the PURE halves of the real-tree differential — the verdict
// classification, the ledger matching, and the empty-verdict claim. The parts
// that touch the network (clone, install, the tree's own `nx graph`) are
// deliberately absent: they run in `.github/workflows/differential.yml`, and a
// stubbed clone here would pin the stub.
//
// The cases to read first are the SILENT-direction ones: an unexplained
// difference that a broken classifier would drop, and two engines both
// reporting zero on a tree measured to contain violations — the two shapes in
// which this harness itself could fail while printing agreement.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXIT,
  LEDGER,
  TREES,
  classifyDifferences,
  emptyVerdictBreaches,
  extractBoundaryRule,
  overallExit,
  treeVerdict,
} from "./differential-real-trees.mjs";

const difference = (overrides = {}) => ({
  direction: "stricter",
  messageId: "onlyTagsConstraintViolation",
  site: "packages/cli/src/index.ts:3:1",
  ...overrides,
});

const entry = (overrides = {}) => ({
  tree: "code-pushup",
  direction: "stricter",
  messageId: "onlyTagsConstraintViolation",
  sitePattern: "^packages/cli/",
  reason: "test entry",
  ...overrides,
});

test("an unexplained difference is returned as unexplained, never dropped", () => {
  const { explained, unexplained, stale } = classifyDifferences("code-pushup", [difference()], []);
  assert.equal(explained.length, 0);
  assert.equal(stale.length, 0);
  // The silent failure this harness must not have: a difference that matches
  // no ledger entry vanishing from the classification, so the run stays green
  // on a real divergence between the engines.
  assert.equal(unexplained.length, 1);
  assert.equal(unexplained[0].messageId, "onlyTagsConstraintViolation");
});

test("a ledger entry explains exactly the difference it describes", () => {
  const { explained, unexplained, stale } = classifyDifferences(
    "code-pushup",
    [difference()],
    [entry()],
  );
  assert.equal(unexplained.length, 0);
  assert.equal(stale.length, 0);
  assert.equal(explained.length, 1);
  assert.equal(explained[0].entry.reason, "test entry");
});

test("an entry for another tree, direction, id or site explains nothing", () => {
  for (const miss of [
    entry({ tree: "ng-doc" }),
    entry({ direction: "weaker" }),
    entry({ messageId: "bannedExternalImportsViolation" }),
    entry({ sitePattern: "^libs/" }),
  ]) {
    const { explained, unexplained } = classifyDifferences("code-pushup", [difference()], [miss]);
    assert.equal(explained.length, 0);
    assert.equal(unexplained.length, 1, `entry ${JSON.stringify(miss)} must not explain`);
  }
});

test("a ledger entry that no longer fires is stale — held from both sides", () => {
  const { stale } = classifyDifferences("code-pushup", [], [entry()]);
  assert.equal(stale.length, 1);
  // But an entry for a DIFFERENT tree is that tree's business, not this run's.
  const other = classifyDifferences("ng-doc", [], [entry()]);
  assert.equal(other.stale.length, 0);
});

test("two engines both silent on a tree with known violations is a breach, not agreement", () => {
  const tree = { name: "code-pushup", sha: "abc", expectViolations: true };
  const breaches = emptyVerdictBreaches(tree, { upstream: 0, tool: 0 });
  // The exact shape in which the whole harness could rot: empty vs empty
  // compares as zero differences, so without this claim the run would print
  // perfect agreement over two engines that both stopped looking.
  assert.equal(breaches.length, 2);
  assert.match(breaches[0], /upstream reported ZERO/u);
  assert.match(breaches[1], /tool reported ZERO/u);
});

test("one silent engine is one breach; verdicts on both sides are none", () => {
  const tree = { name: "ng-doc", sha: "abc", expectViolations: true };
  assert.equal(emptyVerdictBreaches(tree, { upstream: 8, tool: 0 }).length, 1);
  assert.equal(emptyVerdictBreaches(tree, { upstream: 8, tool: 8 }).length, 0);
});

test("a tree not measured to contain violations makes no empty-verdict claim", () => {
  const tree = { name: "hypothetical", sha: "abc", expectViolations: false };
  assert.equal(emptyVerdictBreaches(tree, { upstream: 0, tool: 0 }).length, 0);
});

test("extractBoundaryRule takes the LAST configuring entry, as ESLint binds it", () => {
  const first = { rules: { "@nx/enforce-module-boundaries": ["error", { allow: ["^a$"] }] } };
  const last = {
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        { depConstraints: [{ sourceTag: "x", onlyDependOnLibsWithTags: ["y"] }] },
      ],
    },
  };
  const { depConstraints, options } = extractBoundaryRule([first, {}, last]);
  assert.equal(depConstraints.length, 1);
  assert.deepEqual(options, {});
});

test("extractBoundaryRule refuses a config without the rule, and one with it off", () => {
  assert.throws(() => extractBoundaryRule([{ rules: {} }]), /no @nx\/enforce-module-boundaries/u);
  assert.throws(() => extractBoundaryRule({ rules: {} }), /not a flat-config array/u);
  assert.throws(
    () => extractBoundaryRule([{ rules: { "@nx/enforce-module-boundaries": "off" } }]),
    /switched off or without options/u,
  );
});

test("treeVerdict and overallExit keep infrastructure distinct from findings", () => {
  const clean = { unexplained: [], stale: [], breaches: [] };
  assert.equal(treeVerdict(clean), "ok");
  assert.equal(treeVerdict({ ...clean, unexplained: [difference()] }), "findings");
  assert.equal(treeVerdict({ ...clean, stale: [entry()] }), "findings");
  assert.equal(treeVerdict({ ...clean, breaches: ["x"] }), "findings");
  assert.equal(treeVerdict({ ...clean, infrastructure: "clone failed" }), "infrastructure");

  assert.equal(overallExit(["ok", "ok"]), EXIT.ok);
  assert.equal(overallExit(["ok", "findings"]), EXIT.findings);
  // A run that could not look at one tree must not present its findings as the
  // whole story — the CLI's exit-3-over-exit-1 distinction, kept here.
  assert.equal(overallExit(["findings", "infrastructure"]), EXIT.error);
});

test("the trees table stays pinned, licensed, and non-trivial", () => {
  assert.ok(TREES.length > 1, "more than one real tree, per the conformance README's condition");
  for (const tree of TREES) {
    assert.match(tree.sha, /^[0-9a-f]{40}$/u, `${tree.name} must pin a full commit sha`);
    assert.ok(
      ["MIT", "Apache-2.0"].includes(tree.license),
      `${tree.name} must note a permissive license`,
    );
    assert.ok(Array.isArray(tree.install) && tree.install.length > 0);
    assert.ok(
      tree.install.every((word) => typeof word === "string"),
      `${tree.name}'s install command must be an argument array, never a shell string`,
    );
  }
});

test("every ledger entry names a pinned tree and a real direction", () => {
  const names = new Set(TREES.map((tree) => tree.name));
  for (const item of LEDGER) {
    assert.ok(names.has(item.tree), `ledger entry for unknown tree '${item.tree}'`);
    assert.ok(["stricter", "weaker"].includes(item.direction));
    assert.ok(item.reason.length > 0, "an unexplained explanation is not one");
    new RegExp(item.sitePattern, "u");
  }
});

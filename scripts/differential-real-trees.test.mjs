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
  DIRECTIONS,
  EXIT,
  LEDGER,
  TREES,
  buildSummary,
  classifyDifferences,
  deriveNativeModel,
  emptyVerdictBreaches,
  extractBoundaryRule,
  nativeProjectCountBreach,
  nodeFieldDifferences,
  overallExit,
  parseArgs,
  reportNativeLeg,
  scopeLedgerToDirections,
  treeVerdict,
  upstreamUnreadableBreaches,
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

test("an unpinned unreadable file is a breach — absorbed, it would read as agreement", () => {
  // The silent direction this gate exists for: a file upstream could not
  // parse produces no boundary message, so nothing downstream would ever
  // mention it — "zero verdicts" there is not "checked, clean".
  const tree = { name: "code-pushup", sha: "abc", expectedUpstreamUnreadable: 0 };
  const breaches = upstreamUnreadableBreaches(tree, [
    { file: "libs/broken/src/index.ts", notes: ["eslint: Parsing error: bad"] },
  ]);
  assert.equal(breaches.length, 1);
  assert.match(breaches[0], /could not read 1 file/u);
  assert.match(breaches[0], /libs\/broken\/src\/index\.ts/u);
});

test("an unreadable list matching the pin exactly is not a breach", () => {
  const tree = { name: "code-pushup", sha: "abc", expectedUpstreamUnreadable: 2 };
  const unreadable = [
    { file: "a.ts", notes: ["eslint: Parsing error: x"] },
    { file: "b.ts", notes: ["eslint: Parsing error: y"] },
  ];
  assert.deepEqual(upstreamUnreadableBreaches(tree, unreadable), []);
});

test("fewer unreadable files than pinned is a breach from the other side — a stale pin", () => {
  // The same both-directions posture the ledger takes: a pin claiming a
  // could-not-look the run no longer measures is a documented gap that
  // quietly stopped being real.
  const tree = { name: "code-pushup", sha: "abc", expectedUpstreamUnreadable: 2 };
  const breaches = upstreamUnreadableBreaches(tree, [{ file: "a.ts", notes: ["eslint: x"] }]);
  assert.equal(breaches.length, 1);
  assert.match(breaches[0], /fewer than the 2 pinned/u);
});

test("a tree with no expectedUpstreamUnreadable field pins zero, not 'unchecked'", () => {
  const tree = { name: "hypothetical", sha: "abc" };
  assert.deepEqual(upstreamUnreadableBreaches(tree, []), []);
  assert.equal(upstreamUnreadableBreaches(tree, [{ file: "a.ts", notes: ["x"] }]).length, 1);
});

test("a child report with no upstreamUnreadable list at all is a breach, never zero", () => {
  // The same refusal `reportNativeLeg` makes for a missing `native` field: a
  // malformed report must not read as a clean one.
  const tree = { name: "code-pushup", sha: "abc", expectedUpstreamUnreadable: 0 };
  const breaches = upstreamUnreadableBreaches(tree, undefined);
  assert.equal(breaches.length, 1);
  assert.match(breaches[0], /carries no upstreamUnreadable list/u);
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
  // A non-array is the very input under test, so it is cast past the signature.
  assert.throws(
    () => extractBoundaryRule(/** @type {any} */ ({ rules: {} })),
    /not a flat-config array/u,
  );
  assert.throws(
    () => extractBoundaryRule([{ rules: { "@nx/enforce-module-boundaries": "off" } }]),
    /switched off/u,
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
  // Derived from `DIRECTIONS` rather than typed out a second time here — the
  // whole reason that constant exists (its own doc comment tells the story):
  // this test's own copy was one of the three that used to drift silently.
  const realDirections = [...DIRECTIONS.upstream, ...DIRECTIONS.native];
  for (const item of LEDGER) {
    assert.ok(names.has(item.tree), `ledger entry for unknown tree '${item.tree}'`);
    assert.ok(realDirections.includes(item.direction), `unknown direction '${item.direction}'`);
    assert.ok(item.reason.length > 0, "an unexplained explanation is not one");
    new RegExp(item.sitePattern, "u");
  }
});

test("the trees table pins a native-project floor for every tree", () => {
  for (const tree of TREES) {
    assert.ok(
      Number.isInteger(tree.expectedNativeProjects) && tree.expectedNativeProjects > 0,
      `${tree.name} must pin a positive expectedNativeProjects, the same "measured fact about ` +
        'the pinned commit" treatment expectViolations gets',
    );
  }
});

// --- The summary envelope (`--summary-out`) --------------------------------

test("buildSummary classes a run by its tree verdicts — clean, infra, and findings each once", () => {
  const ok = buildSummary(EXIT.ok, [{ name: "a", verdict: "ok", lines: [] }]);
  assert.equal(ok.exitCode, EXIT.ok);
  assert.equal(ok.exitClass, "ok");
  const infra = buildSummary(EXIT.error, [
    { name: "a", verdict: "infrastructure", lines: [], infrastructure: "clone failed" },
  ]);
  assert.equal(infra.exitClass, "infra");
  assert.equal(infra.trees[0].infrastructure, "clone failed");
  const findings = buildSummary(EXIT.findings, [
    {
      name: "a",
      verdict: "findings",
      lines: ["UNEXPLAINED stricter onlyTagsConstraintViolation @ x:1:1"],
    },
  ]);
  assert.equal(findings.exitClass, "findings");
});

test("buildSummary: findings OUTRANKS infra — the silent-direction case for both consumers", () => {
  // One tree could not be looked at while another carries a real divergence.
  // The exit code keeps the CLI contract (infra outranks findings — a run that
  // could not look must not read as one that looked the whole way), but the
  // consumer class must say findings: the divergence must file an issue and
  // block a release even though a sibling tree failed to look. An envelope
  // reading "infra, nothing to do" here would drop the finding silently.
  /** @type {{name: string, verdict: "ok"|"findings"|"infrastructure", lines: string[], infrastructure?: string}[]} */
  const trees = [
    { name: "a", verdict: "infrastructure", lines: [], infrastructure: "clone failed" },
    {
      name: "b",
      verdict: "findings",
      lines: ["UNEXPLAINED stricter onlyTagsConstraintViolation @ x:1:1"],
    },
  ];
  const summary = buildSummary(EXIT.error, trees);
  assert.equal(summary.exitCode, EXIT.error);
  assert.equal(summary.exitClass, "findings");
});

test("buildSummary carries the exact console lines, so the issue body is never a second copy", () => {
  const line = "EMPTY-VERDICT BREACH: code-pushup: tool reported ZERO verdicts on a tree";
  const summary = buildSummary(EXIT.findings, [
    { name: "code-pushup", verdict: "findings", lines: [line] },
  ]);
  assert.equal(summary.trees[0].lines[0], line);
});

test("parseArgs accepts exactly one of the two file modes", () => {
  assert.deepEqual(parseArgs([]), { summaryOut: undefined, exitClassOf: undefined });
  assert.deepEqual(parseArgs(["--summary-out", "/tmp/s.json"]), {
    summaryOut: "/tmp/s.json",
    exitClassOf: undefined,
  });
  assert.deepEqual(parseArgs(["--exit-class-of", "/tmp/s.json"]), {
    summaryOut: undefined,
    exitClassOf: "/tmp/s.json",
  });
  assert.throws(() => parseArgs(["--bogus"]), /unrecognised argument/u);
  assert.throws(() => parseArgs(["--summary-out"]), /needs a file path/u);
  assert.throws(
    () => parseArgs(["--summary-out", "a", "--exit-class-of", "b"]),
    /mutually exclusive/u,
  );
});

// --- The native leg's own pure functions ---------------------------------
//
// The cases to read first are the SILENT-direction ones, same discipline as
// the rest of this file: a derivation that produced zero projects, a breach
// that a stray ledger entry could silence, and a stale row using the native
// leg's own direction vocabulary rather than the upstream one — proving the
// SAME classifier handles both, not a parallel mechanism nobody tests.

const nxNode = (name, overrides = {}) => ({
  name,
  data: { root: `packages/${name}`, projectType: "library", tags: [`scope:${name}`], ...overrides },
});

test("deriveNativeModel is not trivially empty over a real-shaped graph", () => {
  const graph = {
    nodes: {
      core: nxNode("core"),
      cli: nxNode("cli", { projectType: "application" }),
      "cli-e2e": nxNode("cli-e2e", { projectType: "application" }),
    },
  };
  const model = deriveNativeModel(graph);
  // The silent failure this derivation must not have: a graph with real nodes
  // producing an empty or partial declared list, which would make every
  // later node/edge/verdict comparison in the native leg vacuously agree.
  assert.equal(model.projects.declared.length, 3);
  const byName = new Map(model.projects.declared.map((p) => [p.name, p]));
  assert.equal(byName.get("core").type, "lib", "no projectType stated as 'library' maps to lib");
  assert.equal(byName.get("cli").type, "app", "application, no -e2e suffix, maps to app");
  assert.equal(byName.get("cli-e2e").type, "e2e", "the -e2e suffix rule, reproduced from Nx");
  assert.deepEqual(byName.get("core").tags, ["scope:core"]);
  // No projects.infer, no projectRules — the declared list must be exhaustive
  // on its own, per docs/reference/configuration.md's "omitting this key means the
  // declared list is exhaustive."
  assert.equal("infer" in model.projects, false);
  assert.equal("projectRules" in model, false);
});

test("deriveNativeModel on an empty graph produces an empty declared list — the exact shape the floor below exists to catch", () => {
  const model = deriveNativeModel({ nodes: {} });
  assert.deepEqual(model.projects.declared, []);
});

test("nativeProjectCountBreach fires below the pinned floor, never at or above it", () => {
  const tree = { name: "code-pushup", sha: "abc", expectedNativeProjects: 5 };
  assert.equal(nativeProjectCountBreach(tree, 4).length, 1);
  assert.match(nativeProjectCountBreach(tree, 4)[0], /only 4 project/u);
  assert.equal(nativeProjectCountBreach(tree, 5).length, 0);
  assert.equal(nativeProjectCountBreach(tree, 6).length, 0);
  // Silent-direction check: a derivation that produced ZERO projects on a
  // tree known to have real ones must breach, not read as "nothing to
  // report."
  assert.equal(nativeProjectCountBreach(tree, 0).length, 1);
});

test("a breach cannot be ledgered — for the native leg specifically", () => {
  const tree = { name: "ng-doc", sha: "abc", expectViolations: true, expectedNativeProjects: 1 };
  // A ledger row that would "explain away" a native-extra/native-missing
  // difference has no bearing on the empty-verdict claim: `emptyVerdictBreaches`
  // and `nativeProjectCountBreach` take no ledger argument at all, so a row
  // naming this tree cannot silence either. Asserted here for the native
  // engine key specifically, not the upstream one the existing tests already
  // cover.
  assert.equal(emptyVerdictBreaches(tree, { native: 0, tool: 8 }).length, 1);
  assert.match(emptyVerdictBreaches(tree, { native: 0, tool: 8 })[0], /native reported ZERO/u);
  assert.equal(nativeProjectCountBreach(tree, 0).length, 1);
});

test("a stale native-leg ledger row fails — the same classifier, not a second one", () => {
  const nativeEntry = {
    tree: "code-pushup",
    direction: "native-extra",
    messageId: "node",
    sitePattern: "^some-removed-project$",
    reason: "test entry using the native leg's own direction vocabulary",
  };
  const { stale, explained } = classifyDifferences("code-pushup", [], [nativeEntry]);
  assert.equal(stale.length, 1);
  assert.equal(explained.length, 0);

  const matchingDifference = {
    direction: "native-extra",
    messageId: "node",
    site: "some-removed-project",
  };
  const fired = classifyDifferences("code-pushup", [matchingDifference], [nativeEntry]);
  assert.equal(fired.stale.length, 0);
  assert.equal(fired.explained.length, 1);
});

test("deriveNativeModel renormalises Nx's root-project root '.' to lattice.json's '' — root: '.' is otherwise rejected by name", () => {
  const graph = {
    nodes: {
      workspace: nxNode("workspace", { root: ".", projectType: "library" }),
      utils: nxNode("utils"),
    },
  };
  const model = deriveNativeModel(graph);
  const byName = new Map(model.projects.declared.map((p) => [p.name, p]));
  // The silent failure this normalisation guards: an unrenormalised "."
  // reaches `nativeProvider.discover`, which loads through `model.mjs`'s
  // `declaredProjectViolations` — that rejects root: "." BY NAME (only ""
  // names the workspace root in `lattice.json`'s own dialect), turning what
  // should be a real fidelity measurement into an infrastructure failure that
  // reads as "could not look," not "found nothing." Measured against a real
  // tree carrying exactly this shape (code-pushup's own root-level project,
  // this file's `deriveNativeModel` doc comment).
  assert.equal(byName.get("workspace").root, "");
  // A non-"." root is untouched — this is a normalisation of the one
  // spelling the two dialects disagree on, not a blanket rewrite.
  assert.equal(byName.get("utils").root, "packages/utils");
});

test("deriveNativeModel derives the target-NAME list — the field whose absence red the native leg on real trees", () => {
  const graph = {
    nodes: {
      core: nxNode("core", { targets: { build: { executor: "nx:run-commands" }, lint: {} } }),
      cli: nxNode("cli", { projectType: "application" }),
    },
  };
  const model = deriveNativeModel(graph);
  const byName = new Map(model.projects.declared.map((p) => [p.name, p]));
  // `lattice.json`'s declared row carries target NAMES only, never an executor
  // or options — the shape `model.mjs`'s `declaredProjectViolations` validates
  // and `graph.mjs`'s `buildNativeGraph` synthesises `{executor:
  // "lattice:declared"}` for (`../packages/lattice/src/providers/native/graph.mjs`'s
  // `data.targets` doc). Deriving the object's keys, not the object, is what
  // keeps the derived model a valid `lattice.json` for the tree.
  assert.deepEqual(byName.get("core").targets, ["build", "lint"]);
  // A node whose data carries no targets derives an empty list — the field is
  // present on every row (spec §5's declared row), never dropped.
  assert.deepEqual(byName.get("cli").targets, []);
  // The shape that actually red the real-tree differential on origin/main
  // before this field existed: code-pushup runs `enforceBuildableLibDependency:
  // true` with the upstream default `buildTargets: ['build']`, and a derived
  // model carrying no targets made the native graph declare no `build`
  // anywhere — `evaluate`'s buildTargets gate (rules/index.mjs's createContext)
  // then refused the run loudly as a silent no-op, turning a fidelity
  // measurement into a "could not look" infrastructure failure. A faithful
  // derivation of the real graph restores parity: the graph's `build` entry
  // reaches `lattice.json` as the name `build`, and `buildNativeGraph`'s
  // synthesised `{executor: "lattice:declared"}` reads buildable exactly where
  // the real graph's non-empty executor does — which is what the first
  // assertion above pins.
});

test("scopeLedgerToDirections keeps a ledger entry's staleness scoped to its own leg — silent-direction proof of a real bug this file shipped and fixed", () => {
  // One ledger holding a row for each leg, the exact shape `LEDGER` carries
  // for real: an upstream-vs-tool row and a native-leg row for the same tree.
  const ledger = [
    entry({ direction: "stricter", sitePattern: "^packages/cli/" }),
    entry({ direction: "native-missing", messageId: "edge", sitePattern: "^workspace->utils$" }),
  ];
  // Only the native difference fired this run — the shape a real native leg
  // produces when the upstream-vs-tool comparison agrees perfectly.
  const nativeDifference = {
    direction: "native-missing",
    messageId: "edge",
    site: "workspace->utils",
  };

  // SILENT-direction proof: classifying with the FULL, unscoped ledger against
  // ONLY the native difference reports the unrelated "stricter" entry stale —
  // wrong, and exactly the defect a real run against code-pushup surfaced
  // (2026-08-12): the same entry printed both `explained` on the native side
  // and `STALE` on the upstream-vs-tool side in one run, because each side
  // classified against the SAME full `LEDGER` rather than its own directions.
  const unscoped = classifyDifferences("code-pushup", [nativeDifference], ledger);
  assert.equal(unscoped.stale.length, 1, "the bug this test pins: an unrelated entry reads stale");
  assert.equal(unscoped.stale[0].direction, "stricter");

  // The fix: scope the ledger to the calling leg's own directions first.
  // Once scoped, the "stricter" row is not a candidate at all — not fired,
  // not stale, invisible to this call, exactly as an entry belonging to a
  // leg that did not run this classification should be.
  const nativeScoped = scopeLedgerToDirections(ledger, ["native-extra", "native-missing"]);
  const scoped = classifyDifferences("code-pushup", [nativeDifference], nativeScoped);
  assert.equal(scoped.stale.length, 0);
  assert.equal(scoped.explained.length, 1);

  // And the mirror: scoping to the upstream-vs-tool directions excludes the
  // native row from candidacy entirely — it is not a mismatched, stale entry
  // on this side, it simply is not IN the list this side classifies against.
  const upstreamScoped = scopeLedgerToDirections(ledger, ["stricter", "weaker"]);
  assert.equal(upstreamScoped.length, 1, "the native-missing row must not survive this scope");
  const matchingUpstreamDifference = {
    direction: "stricter",
    messageId: "onlyTagsConstraintViolation",
    site: "packages/cli/src/index.ts:3:1",
  };
  const upstreamResult = classifyDifferences(
    "code-pushup",
    [matchingUpstreamDifference],
    upstreamScoped,
  );
  assert.equal(upstreamResult.stale.length, 0);
  assert.equal(upstreamResult.explained.length, 1);
});

// --- Silent-direction proofs added for the M4c adversarial-review findings ---

test("reportNativeLeg on a report with no native field is an infrastructure verdict, never a silent skip", () => {
  // A real `TREES` entry, not a partial literal — `reportNativeLeg` takes the
  // full pinned-tree shape, and this only needs its `name` to appear in the
  // infrastructure message.
  const tree = TREES.find((t) => t.name === "code-pushup");
  assert.ok(tree, "code-pushup must stay in TREES for this test to mean anything");
  // The exact shape a malformed or crashed-before-writing child report takes:
  // no `native` key at all — not `native: undefined` written out, simply
  // absent, the same as `JSON.parse` on a report a child process never
  // finished. Before this fix `reportNativeLeg` answered
  // `{unexplained: [], stale: [], breaches: []}` here — a clean-looking leg —
  // justified by a doc-comment sentence naming a test caller that did not
  // exist. A missing `native` field must read as "the native leg did not
  // run," not as "the native leg ran and found nothing."
  const outcome = reportNativeLeg(tree, undefined, 8);
  assert.equal(treeVerdict(outcome), "infrastructure");
  assert.match(outcome.infrastructure, /no "native" field/u);
  assert.deepEqual(outcome.unexplained, []);
  assert.deepEqual(outcome.stale, []);
  assert.deepEqual(outcome.breaches, []);
});

test("classifyDifferences refuses a native-missing ledger row whose messageId is a real rule id", () => {
  // Verified against a real run: a row carrying
  // `messageId: "noRelativeOrAbsoluteImportsAcrossLibraries"` explained away a
  // genuinely silenced verdict difference — a ledger row silencing a MISSED
  // boundary violation, exactly what `AGENTS.md`'s invariant refuses. The
  // refusal is a throw, not a filtered-out row, because a row that merely
  // never matches is indistinguishable from one that was never written.
  const badEntry = entry({
    direction: "native-missing",
    messageId: "noRelativeOrAbsoluteImportsAcrossLibraries",
  });
  assert.throws(
    () => classifyDifferences("code-pushup", [], [badEntry]),
    /may only cover a missing "node" or "edge"/u,
  );
});

test("classifyDifferences accepts a native-missing row whose messageId is literally node or edge", () => {
  for (const messageId of ["node", "edge"]) {
    const okEntry = entry({ direction: "native-missing", messageId, sitePattern: "^x$" });
    assert.doesNotThrow(() => classifyDifferences("code-pushup", [], [okEntry]));
  }
});

test("scopeLedgerToDirections refuses a ledger row with an unrecognised direction, rather than silently dropping it", () => {
  // The silent shape this refusal replaces: before `DIRECTIONS` existed, an
  // unscoped or typo'd direction matched no leg's `scopeLedgerToDirections`
  // call, so the row never fired, never went stale, and was never reported —
  // dead on arrival with nothing to say so.
  const typoEntry = entry({ direction: "stricster" });
  assert.throws(
    () => scopeLedgerToDirections([typoEntry], DIRECTIONS.upstream),
    /unrecognised direction/u,
  );
});

test("nodeFieldDifferences reports each diverging field once, and nothing for an identical pair", () => {
  const nx = { root: "packages/core", type: "lib", tags: ["scope:core", "type:lib"] };
  assert.deepEqual(nodeFieldDifferences("core", nx, { ...nx }), []);
  assert.deepEqual(nodeFieldDifferences("core", nx, { ...nx, root: "libs/core" }), [
    { direction: "native-extra", messageId: "node", site: "core#root" },
  ]);
  assert.deepEqual(nodeFieldDifferences("core", nx, { ...nx, type: "app" }), [
    { direction: "native-extra", messageId: "node", site: "core#type" },
  ]);
  // Silent-direction proof: a native leg that reproduced every field WRONG
  // must report all three, not stop at the first — otherwise a real
  // regression in `root` would silence a real regression in `type` reported
  // alongside it.
  assert.deepEqual(
    nodeFieldDifferences("core", nx, { root: "libs/core", type: "app", tags: ["scope:other"] }),
    [
      { direction: "native-extra", messageId: "node", site: "core#root" },
      { direction: "native-extra", messageId: "node", site: "core#type" },
      { direction: "native-extra", messageId: "node", site: "core#tags" },
    ],
  );
});

test("nodeFieldDifferences compares tags as a set, not an order — array order is not a real divergence", () => {
  const nx = { root: "packages/core", type: "lib", tags: ["a", "b"] };
  assert.deepEqual(nodeFieldDifferences("core", nx, { ...nx, tags: ["b", "a"] }), []);
  assert.deepEqual(nodeFieldDifferences("core", nx, { ...nx, tags: ["a", "b", "c"] }), [
    { direction: "native-extra", messageId: "node", site: "core#tags" },
  ]);
});

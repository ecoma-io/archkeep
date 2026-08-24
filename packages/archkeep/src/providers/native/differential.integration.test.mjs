/**
 * Oracle 1: the same workspace, modelled twice — once as an Nx tree
 * (`nx.json`, `project.json`, a REAL `nx graph` spawn) and once as a native
 * tree (`archkeep.json`, no `nx.json`, no Nx CLI reachable) — must agree.
 *
 * Every other test of `../nx.mjs` and `./index.mjs` proves each provider
 * correct against its own fixtures; none puts them side by side. That is
 * this file's one job: build a physical shape twice, feed the SAME rule
 * engine both providers' output, and assert the node set, the dependency
 * set, and the verdict list come out identical. A provider that silently
 * disagreed with the other on a tag, a root spelling, or an edge would be a
 * native workspace whose `check` result depends on which project model it
 * happened to run under — exactly the drift `../../../../../AGENTS.md`'s
 * invariant exists to rule out.
 *
 * The shared machinery — the six fixture-tree builders, `diffGraphs`,
 * `LEDGER`, `classifyDifferences`, `emptyVerdictBreaches`/
 * `perMessageBreaches`, and `pairProblems`/`assertPairAgrees` — lives in
 * `./differential.fixtures.mjs`, a plain module with no `vitest` import, so a
 * config-spelling differential (a future test covering this package's
 * `boundaryConfig`/`tsConfig` option spelling) can import it without running
 * this file's own 19 cases and 3 `nx graph` spawns as a side effect of the
 * import. This file is the vitest glue alone: `describe`/`it`/`expect`, the
 * three fixture pairs, and the red-direction tests that prove the shared
 * machinery's own guards actually guard.
 *
 * **Three fixture pairs, three `nx graph` spawns — not more, and each spawn
 * runs with `NX_DAEMON=false`.** The spawn is the cost driver (a subprocess
 * Node start, a plugin load, a graph write to a tmp file); disabling the
 * daemon avoids a background process binding to one of this file's throwaway
 * roots and outliving the `afterAll` cleanup that deletes it. This file's own
 * budget is three spawns and under two minutes, asserted below by an
 * injectable spawn counter and the suite's own measured wall time:
 *
 * 1. `simple` — one crossing import, one boundary rule. Kept minimal on
 *    purpose: it is the pair a failure here is diagnosable from without
 *    reading a diff row.
 * 2. `composite` — packs six project-identity/topology axes into one tree
 *    (name precedence, project type, the root project, tag union across all
 *    three tag sources, implicit dependencies via both a literal name and a
 *    declared-row spelling, and a project nested inside another project's own
 *    directory). Diagnosability is paid back by `diffGraphs`: every assertion
 *    below is a per-node/per-edge/per-verdict row naming the subject and the
 *    field that differs, never a single `deepEqual` over two 200-line graphs.
 * 3. `layout` — `workspaceLayout` alone, because it is workspace-global and
 *    folding it into `composite` would change every other axis's expected
 *    node/edge shape at once.
 *
 * If a future axis needs its own tree, it earns that the way `layout` did —
 * by being workspace-global, not by convenience. Otherwise it goes into
 * `composite`.
 *
 * `../nx.mjs`'s `readProjectGraph` spawns the real `nx` CLI resolved from
 * THIS repository's own `node_modules` (its own header explains why: `nx` is
 * a peer dependency resolved from the caller, never bundled). For that
 * resolution to succeed with no `pnpm install` run inside the fixture, every
 * fixture directory is created UNDER `packages/archkeep/` itself — not the
 * system tmpdir every other integration test uses — so Node's own directory
 * walk-up finds this package's already-installed `node_modules/nx`. Verified
 * empirically before writing this file: the identical fixture shape spawned
 * against a bare system-tmpdir fails with `NX Could not find Nx modules`,
 * and succeeds once nested here with no other change.
 *
 * Every Nx fixture's `nx.json` registers `@ecoma-io/archkeep/nx` — this
 * package's own plugin — by its real package name, the same spelling a
 * consumer's `nx.json` would carry: `nx graph` cannot draw a Go import edge on
 * its own (`../../../../../AGENTS.md`'s "what this repository is" — Nx reads
 * TypeScript and JavaScript and stays quiet on everything else), so without a
 * plugin computing that edge the Nx side of this comparison would trivially
 * show zero dependencies and the test would prove nothing. This is the plugin
 * under test, so registering it here is the same self-check
 * `node packages/archkeep/cli.mjs check` already runs over this repository's
 * OWN boundaries, aimed at a throwaway tree instead. Resolving that name needs
 * no `node_modules/@ecoma-io` entry: the same nesting that puts
 * `node_modules/nx` in reach also puts `packages/archkeep/package.json`
 * (`name: "@ecoma-io/archkeep"`, an `exports` map naming `./nx`) in the walk-up
 * from every fixture file, and Node resolves a package importing its own name
 * against that package's own `exports` — self-referencing, built in since
 * Node 12.16 — with no symlink of any kind involved.
 *
 * A native-vs-Nx disagreement surfaced by one of these axes is either a real
 * difference (native reports something Nx does not — loud, self-correcting,
 * ledgerable in `./differential.fixtures.mjs`'s `LEDGER`) or a breach (Nx
 * reports something native does not, either in aggregate or on one
 * `messageId` — silent, never ledgerable, always fails the run, and refused
 * structurally: `classifyDifferences` throws before a ledger row ever gets a
 * chance to explain one away). That asymmetry is `AGENTS.md`'s invariant
 * applied to two providers instead of one rule path.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  assertNoAnalysisFailures,
  assertPairAgrees,
  buildCompositeNativeTree,
  buildCompositeNxTree,
  buildLayoutNativeTree,
  buildLayoutNxTree,
  buildSimpleNativeTree,
  buildSimpleNxTree,
  classifyDifferences,
  dependencyShape,
  diffGraphs,
  emptyVerdictBreaches,
  LEDGER,
  nodeShape,
  PAIR_LABELS,
  pairProblems,
  perMessageBreaches,
  runBothProviders,
  runNxGraphSpawn,
  unknownLabelRows,
  writeIn,
} from "./differential.fixtures.mjs";

// `packages/archkeep/`, three levels above this file (`native/` → `providers/`
// → `src/` → the package root) — see the header for why every Nx fixture
// must live under here rather than the system tmpdir.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ---------------------------------------------------------------------------
// The three fixture pairs
// ---------------------------------------------------------------------------

describe("the Nx and native providers agree over one physical workspace", () => {
  const roots = [];
  /** @param {string} prefix */
  function mkRoot(prefix) {
    const root = mkdtempSync(join(packageRoot, prefix));
    roots.push(root);
    return root;
  }
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  // Every `nx graph` spawn in this suite goes through this counting wrapper
  // rather than the bare `runNxGraphSpawn` default, so the "three spawns
  // total" claim in the header is asserted, not just stated — see the
  // `expect(nxSpawnCount)` at the bottom of this describe block.
  let nxSpawnCount = 0;
  const countingIo = {
    run: (file, args, cwd) => {
      nxSpawnCount += 1;
      return runNxGraphSpawn(file, args, cwd);
    },
  };

  const suiteStartedAt = Date.now();

  // Spawning the real Nx CLI is slow relative to every other test here (a
  // subprocess Node start, a plugin load, a graph write to a tmp file) — this
  // test's own timeout is generous rather than the vitest default, so a
  // loaded CI runner does not flake a passing graph into a timeout.
  it("simple: resolves the same node set, dependency set, and verdict from a real nx graph and from archkeep.json", async () => {
    const nxRoot = mkRoot(".oracle-simple-nx-");
    const nativeRoot = mkRoot(".oracle-simple-native-");
    const nxFiles = buildSimpleNxTree(nxRoot);
    const nativeFiles = buildSimpleNativeTree(nativeRoot);

    const result = await runBothProviders({
      nxRoot,
      nxFiles,
      nativeRoot,
      nativeFiles,
      io: countingIo,
    });

    expect(result.nx.violations).toHaveLength(1);
    expect(result.native.violationStrings).toEqual(result.nx.violationStrings);
    assertPairAgrees("simple", result);
  }, 30_000);

  it("composite: axes 1-6 (name precedence, project type, root project, tag union, implicit deps, nested projects) agree", async () => {
    const nxRoot = mkRoot(".oracle-composite-nx-");
    const nativeRoot = mkRoot(".oracle-composite-native-");
    const nxFiles = buildCompositeNxTree(nxRoot);
    const nativeFiles = buildCompositeNativeTree(nativeRoot);

    const result = await runBothProviders({
      nxRoot,
      nxFiles,
      nativeRoot,
      nativeFiles,
      io: countingIo,
    });

    // Named per-axis, so a future regression fails on the axis it broke
    // rather than on "toEqual" alone.
    expect(Object.keys(result.nx.nodes).sort()).toEqual(Object.keys(result.native.nodes).sort());
    expect(result.nx.nodes["declared-only"]).toEqual(result.native.nodes["declared-only"]); // axis 1: declared row
    expect(result.nx.nodes["pkg-named-project"]).toEqual(result.native.nodes["pkg-named-project"]); // axis 1 + 4
    expect(result.nx.nodes["basenamed"]).toEqual(result.native.nodes["basenamed"]); // axis 1: basename fallback
    expect(result.nx.nodes["workspace-root"]).toEqual(result.native.nodes["workspace-root"]); // axis 3
    expect(result.nx.nodes["e2eish-e2e"]).toEqual(result.native.nodes["e2eish-e2e"]); // axis 2
    expect(result.nx.nodes["e2eish-e2e"].type).toBe("e2e");
    expect(result.nx.nodes["nested-child"]).toEqual(result.native.nodes["nested-child"]); // axis 6
    expect(result.nx.dependencies).toEqual(result.native.dependencies); // axis 5 (implicit, both a literal-name and a tag-pattern entry) rides in here

    // Axis 4: `parent` draws tags from all three sources (a declared row, a
    // `projectRules` row, and its own `project.json`) — assert the UNION,
    // not merely that the two engines agree with each other (they could both
    // agree on a partial set and this axis would still be unexercised).
    expect(result.native.nodes["parent"].tags).toEqual(
      ["layer:parent", "union:declared", "union:projectRules"].sort(),
    );
    expect(result.nx.nodes["parent"]).toEqual(result.native.nodes["parent"]);

    expect(result.nx.violations).toHaveLength(1);
    expect(result.native.violationStrings).toEqual(result.nx.violationStrings);
    assertPairAgrees("composite", result);
  }, 30_000);

  it("layout: nx.json's workspaceLayout reaches the rule engine the same way archkeep.json's does, and the two providers agree", async () => {
    // Before issue #31 was fixed, this pair was the one place the two
    // providers were EXPECTED to disagree: `../nx.mjs`'s `readProjectGraph`
    // dropped `nx.json`'s `workspaceLayout` entirely, so the Nx side always
    // fell back to the default `appsDir`/`libsDir` regardless of what the
    // tree declared, while the native side read `archkeep.json`'s identical
    // field and used it. That divergence is what the retired `LEDGER` row
    // (see `./differential.fixtures.mjs`'s header comment above `LEDGER`)
    // used to explain. Fixed, this pair needs no special-casing at all — it
    // asserts through `assertPairAgrees` exactly like `simple` and
    // `composite` above.
    const nxRoot = mkRoot(".oracle-layout-nx-");
    const nativeRoot = mkRoot(".oracle-layout-native-");
    const nxFiles = buildLayoutNxTree(nxRoot);
    const nativeFiles = buildLayoutNativeTree(nativeRoot);

    const result = await runBothProviders({
      nxRoot,
      nxFiles,
      nativeRoot,
      nativeFiles,
      io: countingIo,
    });

    expect(result.nx.nodes).toEqual(result.native.nodes);
    expect(result.nx.dependencies).toEqual(result.native.dependencies);

    // Both engines find the `thing`→`blocked` layer-tag violation (the
    // control, unrelated to `workspaceLayout`) AND the `workspaceLayout`-
    // triggered crossing import — two violations each, identically, which is
    // what proves the fix rather than merely a fixture that happens to match.
    expect(result.nx.violations).toHaveLength(2);
    expect(result.native.violations).toHaveLength(2);
    expect(result.native.violationStrings).toEqual(result.nx.violationStrings);
    expect(
      result.nx.violationStrings.some((s) =>
        s.startsWith("noRelativeOrAbsoluteImportsAcrossLibraries "),
      ),
    ).toBe(true);

    assertPairAgrees("layout", result);
  }, 30_000);

  it("ran exactly three nx graph spawns, and finished within this file's own budget", () => {
    expect(nxSpawnCount).toBe(3);
    expect(Date.now() - suiteStartedAt).toBeLessThan(120_000);
  });

  it("every LEDGER row's subject is scoped to a pair this file actually runs", () => {
    // The positive half of S1's own guard: with the real `LEDGER`, nothing is
    // orphaned. `unknownLabelRows`'s red-direction case (below, in the
    // "ledger's stale-row rule" describe block) constructs the typo'd
    // opposite and requires it to be caught.
    expect(unknownLabelRows(LEDGER, PAIR_LABELS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Red-direction tests — each one proves a guard actually guards, by
// constructing the exact silent failure it exists to catch and requiring the
// harness to go red on it (`AGENTS.md`'s invariant, applied to this file's
// own machinery rather than to the tool under test).
// ---------------------------------------------------------------------------

describe("diffGraphs is not vacuous", () => {
  const base = {
    nodes: { a: { root: "libs/a", type: "lib", tags: ["layer:a"] } },
    dependencies: ["a b static"],
    violations: [
      {
        messageId: "noRelativeOrAbsoluteImportsAcrossLibraries",
        sourceFile: "a/x.go",
        line: 1,
        column: 1,
      },
    ],
  };

  it("reports nothing when both sides are identical", () => {
    expect(diffGraphs(base, structuredClone(base))).toEqual([]);
  });

  it("catches a node missing entirely on the native side", () => {
    const mutated = structuredClone(base);
    delete mutated.nodes.a;
    const rows = diffGraphs(base, mutated);
    expect(rows).toContainEqual({
      kind: "node",
      subject: "a",
      field: "presence",
      nx: "present",
      native: "absent",
    });
  });

  it("catches a tag divergence on a node both sides have", () => {
    const mutated = structuredClone(base);
    mutated.nodes.a.tags = ["layer:different"];
    const rows = diffGraphs(base, mutated);
    expect(rows).toContainEqual({
      kind: "node",
      subject: "a",
      field: "tags",
      nx: JSON.stringify(["layer:a"]),
      native: JSON.stringify(["layer:different"]),
    });
  });

  it("catches a dependency edge present on only one side", () => {
    const mutated = structuredClone(base);
    mutated.dependencies = [];
    const rows = diffGraphs(base, mutated);
    expect(rows).toContainEqual({
      kind: "dependency",
      subject: "a b static",
      field: "presence",
      nx: "present",
      native: "absent",
    });
  });

  it("catches a duplicate dependency edge on only one side, not just its presence", () => {
    // Both sides have the SAME edge string at least once — a `new Set`-based
    // comparison would call this identical. It is not: nx counted the edge
    // twice (two import sites resolving to the same triple) and native
    // counted it once, which is a real disagreement about how many import
    // sites produced that edge.
    const nx = { ...base, dependencies: ["a b static", "a b static"] };
    const native = { ...base, dependencies: ["a b static"] };
    const rows = diffGraphs(nx, native);
    expect(rows).toContainEqual({
      kind: "dependency",
      subject: "a b static",
      field: "count",
      nx: 2,
      native: 1,
    });
  });

  it("catches a verdict count divergence", () => {
    const mutated = structuredClone(base);
    mutated.violations = [];
    const rows = diffGraphs(base, mutated);
    expect(rows).toContainEqual({
      kind: "verdict",
      subject: "noRelativeOrAbsoluteImportsAcrossLibraries",
      field: "count",
      nx: 1,
      native: 0,
    });
  });

  it("catches a verdict LOCATION divergence when the counts already match", () => {
    // Same messageId, same count on both sides, but pointing at different
    // files — a count-only comparison would call this identical, and it is
    // exactly the shape "two engines agree on how many, disagree on where"
    // that a developer cannot act on as if it were agreement.
    const nx = {
      ...base,
      violations: [
        {
          messageId: "noRelativeOrAbsoluteImportsAcrossLibraries",
          sourceFile: "a/x.go",
          line: 1,
          column: 1,
        },
      ],
    };
    const native = {
      ...base,
      violations: [
        {
          messageId: "noRelativeOrAbsoluteImportsAcrossLibraries",
          sourceFile: "a/y.go",
          line: 9,
          column: 3,
        },
      ],
    };
    const rows = diffGraphs(nx, native);
    expect(rows).toContainEqual({
      kind: "verdict",
      subject: "noRelativeOrAbsoluteImportsAcrossLibraries",
      field: "location",
      nx: "a/x.go:1:1",
      native: "a/y.go:9:3",
    });
  });
});

describe("node-set equality is asserted in both directions", () => {
  it("a native side missing a project entirely fails, not merely differs on a field", () => {
    const nx = {
      a: { root: "libs/a", type: "lib", tags: [] },
      b: { root: "libs/b", type: "lib", tags: [] },
    };
    const native = { a: { root: "libs/a", type: "lib", tags: [] } };
    const nxNames = new Set(Object.keys(nx));
    const nativeNames = new Set(Object.keys(native));
    const onlyOnNx = [...nxNames].filter((n) => !nativeNames.has(n));
    const onlyOnNative = [...nativeNames].filter((n) => !nxNames.has(n));
    expect(onlyOnNx, "native is missing a project nx has").toEqual(["b"]);
    expect(onlyOnNative, "nx is missing a project native has").toEqual([]);
  });

  it("a project present only on the native side is caught too", () => {
    const rows = diffGraphs(
      { nodes: {}, dependencies: [], violations: [] },
      {
        nodes: { extra: { root: "libs/extra", type: "lib", tags: [] } },
        dependencies: [],
        violations: [],
      },
    );
    expect(rows).toContainEqual({
      kind: "node",
      subject: "extra",
      field: "presence",
      nx: "absent",
      native: "present",
    });
  });
});

describe("empty verdicts on both sides is a failure, not a pass", () => {
  it("zero violations on the Nx side is a breach when the pair was built to have one", () => {
    expect(emptyVerdictBreaches("pair", { nx: 0, native: 1 })).toHaveLength(1);
  });

  it("zero violations on the native side is a breach too — the same direction the invariant forbids", () => {
    expect(emptyVerdictBreaches("pair", { nx: 1, native: 0 })).toHaveLength(1);
  });

  it("zero on BOTH sides is still a breach — agreement on nothing proves nothing", () => {
    const breaches = emptyVerdictBreaches("pair", { nx: 0, native: 0 });
    expect(breaches).toHaveLength(2);
  });

  it("at least one violation on both sides is not a breach", () => {
    expect(emptyVerdictBreaches("pair", { nx: 1, native: 1 })).toEqual([]);
  });
});

describe("native under-reporting on one messageId is a breach even when neither total is zero", () => {
  it("nx finding MORE of one messageId than native is a breach, at any nonzero count", () => {
    const nx = [{ messageId: "x" }, { messageId: "x" }, { messageId: "x" }];
    const native = [{ messageId: "x" }];
    expect(perMessageBreaches("pair", nx, native)).toHaveLength(1);
  });

  it("nx and native agreeing on every messageId's count is not a breach", () => {
    const nx = [{ messageId: "x" }, { messageId: "y" }];
    const native = [{ messageId: "x" }, { messageId: "y" }];
    expect(perMessageBreaches("pair", nx, native)).toEqual([]);
  });

  it("native reporting MORE of one messageId than nx is not a breach — that direction is loud, not silent", () => {
    const nx = [{ messageId: "x" }];
    const native = [{ messageId: "x" }, { messageId: "x" }];
    expect(perMessageBreaches("pair", nx, native)).toEqual([]);
  });
});

describe("the ledger's stale-row rule", () => {
  it("a row that matches nothing fails the run", () => {
    const ledger = Object.freeze([
      Object.freeze({
        subject: "nowhere:nothing",
        field: "count",
        direction: "native-only",
        reason: "a row that will never fire, on purpose, for this test",
        issue: "https://github.com/ecoma-io/archkeep/issues/31",
      }),
    ]);
    const { stale, unexplained } = classifyDifferences([], ledger);
    expect(stale).toHaveLength(1);
    expect(unexplained).toEqual([]);
  });

  it("a row with an empty reason fails the run before any matching happens", () => {
    const ledger = Object.freeze([
      Object.freeze({
        subject: "x:y",
        field: "count",
        direction: "native-only",
        reason: "",
        issue: "https://github.com/ecoma-io/archkeep/issues/31",
      }),
    ]);
    expect(() => classifyDifferences([], ledger)).toThrow(/empty reason/);
  });

  it("a row with no linked issue fails the run before any matching happens", () => {
    const ledger = Object.freeze([
      Object.freeze({
        subject: "x:y",
        field: "count",
        direction: "native-only",
        reason: "a real reason",
        issue: "",
      }),
    ]);
    expect(() => classifyDifferences([], ledger)).toThrow(/no linked issue/);
  });

  it("a row with an invalid direction fails the run before any matching happens", () => {
    // `direction` is deliberately wrong here — `"nx-only"` is not a member of
    // `LEDGER_DIRECTIONS` — so the cast below is the point of the test, not a
    // workaround: a real `LedgerRow` can never hold this value, only a
    // malformed one reaching `classifyDifferences` at runtime can.
    const ledger = /** @type {readonly import("./differential.fixtures.mjs").LedgerRow[]} */ (
      /** @type {unknown} */ (
        Object.freeze([
          Object.freeze({
            subject: "x:y",
            field: "count",
            direction: "nx-only",
            reason: "a real reason",
            issue: "https://github.com/ecoma-io/archkeep/issues/31",
          }),
        ])
      )
    );
    expect(() => classifyDifferences([], ledger)).toThrow(/invalid direction/);
  });

  it("a row that DOES match is not stale", () => {
    const ledger = Object.freeze([
      Object.freeze({
        subject: "x:y",
        field: "count",
        direction: "native-only",
        reason: "a real reason",
        issue: "https://github.com/ecoma-io/archkeep/issues/31",
      }),
    ]);
    const { stale, explained, unexplained } = classifyDifferences(
      [{ kind: "verdict", subject: "x:y", field: "count", nx: 0, native: 1 }],
      ledger,
    );
    expect(stale).toEqual([]);
    expect(unexplained).toEqual([]);
    expect(explained).toHaveLength(1);
  });

  it("a mislabeled row (a typo'd pair prefix) is invisible to that pair's own stale check — unknownLabelRows is what catches it", () => {
    // S1's own red-direction case: `layuot:` is a typo of `layout:`. Every
    // real pair's `pairProblems` only filters `stale` down to rows whose
    // subject starts with ITS OWN label, so a row prefixed `layuot:` is
    // filtered out of `layout`'s own stale check (it does not start with
    // "layout:") and filtered out of every other pair's check too (it does
    // not start with theirs either) — invisible everywhere, which is exactly
    // what `unknownLabelRows` must therefore catch.
    const ledger = Object.freeze([
      Object.freeze({
        subject: "layuot:someRule",
        field: "count",
        direction: "native-only",
        reason: "a mislabeled row, on purpose, for this test",
        issue: "https://github.com/ecoma-io/archkeep/issues/31",
      }),
    ]);
    expect(unknownLabelRows(ledger, PAIR_LABELS)).toHaveLength(1);
  });

  it("a correctly labeled row is not flagged by unknownLabelRows", () => {
    const ledger = Object.freeze([
      Object.freeze({
        subject: "layout:someRule",
        field: "count",
        direction: "native-only",
        reason: "a correctly labeled row",
        issue: "https://github.com/ecoma-io/archkeep/issues/31",
      }),
    ]);
    expect(unknownLabelRows(ledger, PAIR_LABELS)).toEqual([]);
  });
});

describe("a ledger row may never cover an Nx-finds-more breach, in either direction of check", () => {
  it("classifyDifferences THROWS on a verdict-count row where nx > native, even with a matching ledger row", () => {
    // The GENERAL shape, not just the literal-zero one: nx found 2, native
    // found 1 — neither count is zero, so this is not `emptyVerdictBreaches`'
    // own case, and it is exactly the shape a naive "does a ledger row match
    // this subject/field" check would have let through before B1/B2. Red
    // without the fix: with the pre-fix `classifyDifferences`, this matching
    // ledger row would have classified the difference as `explained` and the
    // run would have stayed green.
    const differences = [
      { kind: "verdict", subject: "pair:someRule", field: "count", nx: 2, native: 1 },
    ];
    const ledgerThatWouldMatchIfConsulted = Object.freeze([
      Object.freeze({
        subject: "pair:someRule",
        field: "count",
        direction: "native-only",
        reason: "an attempt to explain away nx finding more than native — must not work",
        issue: "https://github.com/ecoma-io/archkeep/issues/31",
      }),
    ]);
    expect(() => classifyDifferences(differences, ledgerThatWouldMatchIfConsulted)).toThrow(
      /never explain away|refuses to explain/,
    );
  });

  it("emptyVerdictBreaches never consults a ledger — its own signature has nowhere to pass one in", () => {
    const breaches = emptyVerdictBreaches("pair", { nx: 1, native: 0 });
    expect(breaches).toHaveLength(1);
  });

  it("pairProblems catches an Nx-finds-more split across two messageIds, even though each side's TOTAL agrees", () => {
    // nx {x:2, y:0}, native {x:1, y:1} — both total 2, so a check that only
    // looked at each side's aggregate violation count (as `emptyVerdictBreaches`
    // deliberately does, and as decision (c)'s literal-zero case alone would)
    // would see nothing wrong. But native under-reports `x` by one relative to
    // nx, which is the breach: `diffGraphs`'s per-messageId comparison (S5)
    // produces a `count` row for `x` (nx 2, native 1), and `classifyDifferences`
    // (B1/B2) throws on it before `pairProblems` can return a problem list —
    // proving the two fixes compose into exactly the per-messageId coverage
    // decision (c) asked for, without a third, separate mechanism.
    const violation = (messageId, sourceFile) => ({
      sourceFile,
      line: 1,
      column: 1,
      specifier: "irrelevant",
      kind: "static",
      messageId,
      message: "irrelevant",
      sourceProject: null,
      targetProject: null,
      constraint: null,
      data: {},
    });
    const nx = {
      nodes: {},
      dependencies: [],
      violations: [violation("x", "a"), violation("x", "b")],
      violationStrings: [],
    };
    const native = {
      nodes: {},
      dependencies: [],
      violations: [violation("x", "a"), violation("y", "c")],
      violationStrings: [],
    };
    expect(() => pairProblems("pair", { nx, native }, [])).toThrow(
      /never explain away|refuses to explain/,
    );
  });
});

describe("a ledger row only excuses a difference running its own declared direction", () => {
  it("does NOT explain an nx-only difference sharing a native-only row's subject and field", () => {
    // Red without the fix: matching on `subject`/`field` alone (with no
    // direction check) would find this row and call the difference
    // "explained" — a native-provider REGRESSION (native missing a project nx
    // has) wearing the same subject/field as a ledgered native-only row, which
    // is exactly the silent shape `../../../../../AGENTS.md`'s invariant
    // forbids: a real disagreement reading as a documented, accepted one.
    const ledger = Object.freeze([
      Object.freeze({
        subject: "pair:someProject",
        field: "presence",
        direction: "native-only",
        reason: "a native-only row, on purpose, for this test",
        issue: "https://github.com/ecoma-io/archkeep/issues/31",
      }),
    ]);
    const differences = [
      {
        kind: "node",
        subject: "pair:someProject",
        field: "presence",
        nx: "present",
        native: "absent",
      },
    ];
    const { explained, unexplained } = classifyDifferences(differences, ledger);
    expect(explained).toEqual([]);
    expect(unexplained).toHaveLength(1);
  });

  it("still explains the matching subject/field when the difference's direction is the row's own", () => {
    // The positive control for the test above: the identical subject/field,
    // but the native-only shape the row actually declares, still fires.
    const ledger = Object.freeze([
      Object.freeze({
        subject: "pair:someProject",
        field: "presence",
        direction: "native-only",
        reason: "a native-only row, on purpose, for this test",
        issue: "https://github.com/ecoma-io/archkeep/issues/31",
      }),
    ]);
    const differences = [
      {
        kind: "node",
        subject: "pair:someProject",
        field: "presence",
        nx: "absent",
        native: "present",
      },
    ];
    const { explained, unexplained } = classifyDifferences(differences, ledger);
    expect(explained).toHaveLength(1);
    expect(unexplained).toEqual([]);
  });
});

describe("runBothProviders refuses to compare two partial scans", () => {
  it("throws, naming the file, when the nx-side analysis reported a read/parse failure", () => {
    // Red without the fix: `runBothProviders` used to build both graphs
    // straight off `analyze()`'s `imports`, never looking at `failures` — a
    // source file that failed to read yields a shorter import list on that
    // side alone, and a shorter list can still equal the other side's list,
    // which is an incomplete scan reading as provider agreement.
    expect(() =>
      assertNoAnalysisFailures(
        [{ sourceFile: "libs/domain/broken.go", reason: "could not be read" }],
        [],
      ),
    ).toThrow(/libs\/domain\/broken\.go/);
  });

  it("throws when the native-side analysis reported the failure instead — either side is enough", () => {
    expect(() =>
      assertNoAnalysisFailures(
        [],
        [{ sourceFile: "libs/adapter/broken.go", reason: "could not be read" }],
      ),
    ).toThrow(/libs\/adapter\/broken\.go/);
  });

  it("does not throw when both analyses are clean", () => {
    expect(() => assertNoAnalysisFailures([], [])).not.toThrow();
  });

  it("proves the guard is wired into runBothProviders itself, not just correct in isolation", async () => {
    // The three cases above call `assertNoAnalysisFailures` directly — they
    // pin the function's own behaviour but would stay green even if the call
    // site inside `runBothProviders` were ever deleted (reintroducing the
    // exact bug this describe block is named for). This one drives
    // `runBothProviders` end to end, over a native project that DECLARES a
    // file it never writes to disk, so `readFileFrom` (this module) answers
    // `null` for it and `analyzeWorkspace` (`../../workspace.mjs`) records a
    // "could not be read" failure the way a real unreadable source file
    // would. No real `nx graph` spawn: `io.run` below writes the graph file
    // straight to the `--file=` path `readProjectGraph` (`../nx.mjs`) passed
    // it, so this test adds nothing to the suite's spawn budget.
    const nxRoot = mkdtempSync(join(packageRoot, ".oracle-partial-scan-nx-"));
    const nativeRoot = mkdtempSync(join(packageRoot, ".oracle-partial-scan-native-"));
    try {
      writeIn(nativeRoot)(
        "archkeep.json",
        JSON.stringify({
          projects: { declared: [{ root: "libs/a", name: "a", tags: [] }] },
        }),
      );
      /** @type {typeof runNxGraphSpawn} */
      const fakeNxRun = (_file, args) => {
        const target = args.find((a) => a.startsWith("--file=")).slice("--file=".length);
        writeFileSync(target, JSON.stringify({ graph: { nodes: {}, dependencies: {} } }));
        return "";
      };

      await expect(
        runBothProviders({
          nxRoot,
          nxFiles: [],
          nativeRoot,
          // Declared but never written — the unreadable file the guard
          // exists to catch.
          nativeFiles: ["archkeep.json", "libs/a/broken.go"],
          io: { run: fakeNxRun },
        }),
      ).rejects.toThrow(/libs\/a\/broken\.go/);
    } finally {
      rmSync(nxRoot, { recursive: true, force: true });
      rmSync(nativeRoot, { recursive: true, force: true });
    }
  });
});

describe("node tag comparison does not collapse two distinct tag lists into one string", () => {
  it("tag lists differing only in comma placement are still reported as a difference", () => {
    // Red without the fix: `["a,b"].sort().join(",")` and
    // `["a", "b"].sort().join(",")` both produce the string `"a,b"`, so a
    // comma-joined comparison would call these two distinct tag lists equal
    // and `diffGraphs` would report nothing — a real disagreement reading as
    // agreement.
    const nx = {
      nodes: { a: { root: "libs/a", type: "lib", tags: ["a,b"] } },
      dependencies: [],
      violations: [],
    };
    const native = {
      nodes: { a: { root: "libs/a", type: "lib", tags: ["a", "b"] } },
      dependencies: [],
      violations: [],
    };
    const rows = diffGraphs(nx, native);
    expect(rows).toContainEqual({
      kind: "node",
      subject: "a",
      field: "tags",
      nx: JSON.stringify(["a,b"]),
      native: JSON.stringify(["a", "b"]),
    });
  });
});

describe("dependencyShape does not collapse two distinct edges into one string", () => {
  it("edges differing only in where a space falls between source and target are still reported as a difference", () => {
    // Red without the fix: `` `${source} ${target} ${type}` `` joins
    // `{source: "a b", target: "c"}` and `{source: "a", target: "b c"}` to
    // the identical string `"a b c static"` — two distinct edges collapsing
    // onto one, which `diffGraphs` (fed the collapsed strings) would then see
    // as perfect agreement between engines that actually disagree.
    const nxDeps = dependencyShape({
      g: [{ source: "a b", target: "c", type: "static" }],
    });
    const nativeDeps = dependencyShape({
      g: [{ source: "a", target: "b c", type: "static" }],
    });
    expect(nxDeps).not.toEqual(nativeDeps);

    const rows = diffGraphs(
      { nodes: {}, dependencies: nxDeps, violations: [] },
      { nodes: {}, dependencies: nativeDeps, violations: [] },
    );
    expect(rows).toContainEqual({
      kind: "dependency",
      subject: JSON.stringify(["a b", "c", "static"]),
      field: "presence",
      nx: "present",
      native: "absent",
    });
    expect(rows).toContainEqual({
      kind: "dependency",
      subject: JSON.stringify(["a", "b c", "static"]),
      field: "presence",
      nx: "absent",
      native: "present",
    });
  });
});

describe("the differential machinery's defensive edges", () => {
  it("reads a node with no tags key as untagged", () => {
    expect(nodeShape({ a: { type: "lib", data: { root: "libs/a" } } })).toEqual({
      a: { root: "libs/a", type: "lib", tags: [] },
    });
  });

  it("restores a pre-set NX_DAEMON after the spawn", () => {
    const original = process.env.NX_DAEMON;
    process.env.NX_DAEMON = "true";
    runNxGraphSpawn(process.execPath, ["-e", "1"], "/");
    // runNxGraphSpawn's own finally restored the value it found on entry.
    expect(process.env.NX_DAEMON).toBe("true");
    if (original === undefined) delete process.env.NX_DAEMON;
    else process.env.NX_DAEMON = original;
  });

  it("reports an edge the native side has and nx does not, the mirror of the other direction", () => {
    const rows = diffGraphs(
      { nodes: {}, dependencies: [], violations: [] },
      { nodes: {}, dependencies: ["a b static"], violations: [] },
    );
    expect(rows).toContainEqual({
      kind: "dependency",
      subject: "a b static",
      field: "presence",
      nx: "absent",
      native: "present",
    });
  });

  it("classifies a count difference in each direction, and none when the counts tie", () => {
    const ledger = [];
    const difference = (nx, native) => ({
      kind: "dependency",
      subject: "pair:a b static",
      field: "count",
      nx,
      native,
    });
    expect(classifyDifferences([difference(1, 2)], ledger).unexplained).toHaveLength(1);
    expect(classifyDifferences([difference(2, 1)], ledger).unexplained).toHaveLength(1);
    expect(classifyDifferences([difference(1, 1)], ledger).unexplained).toHaveLength(1);
  });

  it("flags a native side that never reported a messageId nx reported at all", () => {
    const breaches = perMessageBreaches("pair", [{ messageId: "x" }, { messageId: "x" }], []);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toContain("native reported only 0");
  });

  it("throws on an unclaimed native file before the comparison ever runs", async () => {
    // A tracked file no project owns is a discovery failure this fixture
    // never expects — comparing the sides anyway would compare graphs that
    // were read through a hole.
    const nxRoot = mkdtempSync(join(packageRoot, ".oracle-unclaimed-nx-"));
    const nativeRoot = mkdtempSync(join(packageRoot, ".oracle-unclaimed-native-"));
    try {
      writeIn(nativeRoot)(
        "archkeep.json",
        JSON.stringify({
          projects: { declared: [{ root: "libs/a", name: "a", tags: [] }] },
        }),
      );
      writeIn(nativeRoot)("libs/a/main.go", "package a\n");
      writeIn(nativeRoot)("loose.py", "import os\n");
      /** @type {typeof runNxGraphSpawn} */
      const fakeNxRun = (_file, args) => {
        const target = args.find((a) => a.startsWith("--file=")).slice("--file=".length);
        writeFileSync(target, JSON.stringify({ graph: { nodes: {}, dependencies: {} } }));
        return "";
      };

      await expect(
        runBothProviders({
          nxRoot,
          nxFiles: [],
          nativeRoot,
          nativeFiles: ["archkeep.json", "libs/a/main.go", "loose.py"],
          io: { run: fakeNxRun },
        }),
      ).rejects.toThrow(/unclaimed-file failures/);
    } finally {
      rmSync(nxRoot, { recursive: true, force: true });
      rmSync(nativeRoot, { recursive: true, force: true });
    }
  });

  it("pairProblems names an unexplained difference and a stale ledger row together", () => {
    const result = {
      nx: { nodes: {}, dependencies: [], violations: [], violationStrings: [] },
      native: {
        nodes: { extra: { root: "libs/extra", type: "lib", tags: [] } },
        dependencies: [],
        violations: [],
        violationStrings: [],
      },
    };
    const ledger = Object.freeze([
      Object.freeze({
        subject: "pair:something",
        field: "count",
        direction: "native-only",
        reason: "a row that matches nothing, on purpose",
        issue: "https://github.com/ecoma-io/archkeep/issues/31",
      }),
    ]);
    const problems = pairProblems("pair", result, ledger);
    expect(problems.some((p) => /unexplained differences/.test(p))).toBe(true);
    expect(problems.some((p) => /stale ledger rows/.test(p))).toBe(true);
  });

  it("assertPairAgrees throws on a disagreement, which is what lets a caller assert with it", () => {
    const result = {
      nx: { nodes: {}, dependencies: [], violations: [], violationStrings: [] },
      native: {
        nodes: { extra: { root: "libs/extra", type: "lib", tags: [] } },
        dependencies: [],
        violations: [],
        violationStrings: [],
      },
    };
    expect(() => assertPairAgrees("pair", result)).toThrow(/provider differential disagreement/);
  });
});

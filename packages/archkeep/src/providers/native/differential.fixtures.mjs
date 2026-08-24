/**
 * The shared machinery behind Oracle 1 (`differential.integration.test.mjs`):
 * the six fixture-tree builders, the two-provider run, the diagnosable
 * `diffGraphs` comparison, the ledger, and the breach checks that enforce
 * `../../../../../AGENTS.md`'s invariant — "an empty result is a claim, not a
 * shrug" — applied to two project-model providers instead of one rule path.
 *
 * This module carries **no vitest import and no `describe`/`it`/`expect`
 * call** — it is loadable and runnable with `node -e "import(...)"` alone,
 * spawning nothing at import time. That is a deliberate seam, not
 * incidental: `differential.integration.test.mjs` imports this module to run
 * its own suite, and a config-spelling differential (a future test covering
 * this package's `boundaryConfig`/`tsConfig` option spelling) is meant to
 * reuse the same Nx-marker and `archkeep.json`-marker fixture-tree builders
 * rather than writing a third copy of either — reusing a file that also
 * calls `describe()` at module scope would run this file's own 19 cases and
 * 3 `nx graph` spawns as a side effect of importing it, and would throw
 * outright in a plain Node process with no vitest runner around it.
 *
 * See `./README.md`'s "What proves this provider against a tree it was not
 * tested on" for the axis list and the fixture-pair budget this module's
 * builders exist to hold to.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeProjectRoot } from "../../rules/specifiers.mjs";
import { evaluate } from "../../rules/index.mjs";
import { loadBoundaryConfig } from "../../config.mjs";
import { analyzeWorkspace, createWorkspace, selectFiles } from "../../workspace.mjs";
import { runProcess } from "../../process.mjs";
import { readProjectGraph } from "../nx.mjs";
import { nativeProvider } from "./index.mjs";

// ---------------------------------------------------------------------------
// Tree-writing helpers
// ---------------------------------------------------------------------------

/**
 * @param {(path: string, text: string) => void} write
 * @param {Record<string, string>} files `{relativePath: text}`.
 */
export function writeAll(write, files) {
  for (const [path, text] of Object.entries(files)) write(path, text);
}

/** @param {string} root */
export function writeIn(root) {
  return (relativePath, text) => {
    mkdirSync(join(root, relativePath, ".."), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  };
}

/** @param {string} root */
export function readFileFrom(root) {
  return (path) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return null;
    }
  };
}

/** Builds `{workspace, imports}` from an already-resolved graph and file list. */
function analyze(root, graph, files, tsConfig) {
  const { workspace, owned } = createWorkspace({ root, graph, files, tsConfig });
  const selected = selectFiles(
    owned.map(({ file }) => file),
    [],
    { root, cwd: root },
  );
  return { workspace, ...analyzeWorkspace(workspace, selected) };
}

/** `{name → {root, type, tags}}`, comparable whichever provider produced it. */
export const nodeShape = (nodes) =>
  Object.fromEntries(
    Object.entries(nodes).map(([name, node]) => [
      name,
      {
        root: normalizeProjectRoot(node.data.root),
        type: node.type,
        tags: [...(node.data.tags ?? [])].sort(),
      },
    ]),
  );

/** `[JSON.stringify([source, target, type]), ...]`, sorted so build order
 * cannot matter. Kept as a MULTISET (repeats survive), not deduplicated —
 * `diffGraphs` below relies on that: a duplicate edge on one side and not the
 * other is a real disagreement, and collapsing repeats here would erase it
 * before `diffGraphs` ever saw it.
 *
 * Canonicalised with `JSON.stringify` rather than a space-joined
 * `` `${source} ${target} ${type}` `` — a project name or file path
 * containing a space would let two distinct edges collapse onto the same
 * string (`source: "a b", target: "c"` and `source: "a", target: "b c"` both
 * join to `"a b c static"`), which is exactly the silent shape
 * `../../../../../AGENTS.md`'s invariant forbids: two real disagreements
 * reading as one agreement. The provider this differential compares already
 * dedups its own edges with a `JSON.stringify` key for the identical reason
 * (`./graph.mjs`'s `buildDependencies`), so this keeps the differential's own
 * canonicalisation consistent with the code under test rather than a weaker
 * copy of it. */
export const dependencyShape = (dependencies) =>
  Object.values(dependencies)
    .flat()
    .map(({ source, target, type }) => JSON.stringify([source, target, type]))
    .sort();

/** `["messageId sourceFile:line:column", ...]`, sorted the same way. */
export const verdictShape = (violations) =>
  violations.map((v) => `${v.messageId} ${v.sourceFile}:${v.line}:${v.column}`).sort();

/**
 * `runProcess` with `NX_DAEMON=false` layered onto the environment for the
 * one spawn it wraps — measured: without it, the first `nx graph` against one
 * of this file's throwaway roots starts a background daemon that binds to
 * that root's absolute path, and a later fixture pair's own spawn (or a
 * second run of this suite) can hit a daemon still alive for a directory
 * `afterAll` already deleted, rather than starting clean. Restores whatever
 * `NX_DAEMON` was set to beforehand (or unsets it) once the spawn returns, so
 * this file's own choice does not leak into anything spawned after it in the
 * same process.
 *
 * @type {typeof runProcess}
 */
export function runNxGraphSpawn(file, args, cwd) {
  const previous = process.env.NX_DAEMON;
  process.env.NX_DAEMON = "false";
  try {
    return runProcess(file, args, cwd);
  } finally {
    if (previous === undefined) delete process.env.NX_DAEMON;
    else process.env.NX_DAEMON = previous;
  }
}

/**
 * Refuses to let `runBothProviders` build either provider's graph on top of a
 * partial scan. `analyzeWorkspace` (`../../workspace.mjs`) records a failure
 * rather than throwing when a file cannot be read or parsed — one bad file
 * must not blank a whole analysis run — but that leaves the CALLER
 * responsible for noticing one happened: a file either `readFile` cannot
 * read yields a shorter import list on that side alone, and two shorter
 * lists can still compare equal to each other by coincidence, which reads as
 * "the providers agree" when what actually happened is "neither provider
 * finished looking" — the exact silent shape `../../../../../AGENTS.md`'s
 * invariant forbids, applied to this harness's own inputs rather than to the
 * tool it drives. Called after both analyses and before either graph is
 * built, so a fixture never gets far enough to diff two incomplete scans.
 *
 * @param {{sourceFile: string, reason: string}[]} nxFailures
 * @param {{sourceFile: string, reason: string}[]} nativeFailures
 * @throws {Error} naming every failing file, when either list is non-empty.
 */
export function assertNoAnalysisFailures(nxFailures, nativeFailures) {
  const named = [
    ...nxFailures.map((f) => `nx:${f.sourceFile} (${f.reason})`),
    ...nativeFailures.map((f) => `native:${f.sourceFile} (${f.reason})`),
  ];
  if (named.length > 0) {
    throw new Error(
      `runBothProviders refuses to compare two partial scans: ${named.length} file(s) failed to ` +
        `read or parse before either provider's graph was built — ${named.join(", ")}`,
    );
  }
}

/**
 * Runs both providers over one already-written pair of trees and returns
 * everything a fixture's own assertions need: each side's graph (already put
 * through `nodeShape`/`dependencyShape`), each side's raw violations (for
 * `verdictShape` and for a count), and the loaded configs (for a fixture
 * that wants to re-run `evaluate` itself, as the red-direction tests below
 * do).
 *
 * @param {{
 *   nxRoot: string, nxFiles: string[],
 *   nativeRoot: string, nativeFiles: string[],
 *   boundaryConfig?: string,
 *   io?: {run?: typeof runProcess, resolveNx?: () => string},
 * }} args `io.run` defaults to `runNxGraphSpawn` above, not the bare
 *   `runProcess` `../nx.mjs` itself defaults to — a caller that wants to
 *   count spawns (or otherwise observe them) wraps THIS default, so it
 *   inherits the `NX_DAEMON` handling rather than choosing between the two.
 */
export async function runBothProviders({
  nxRoot,
  nxFiles,
  nativeRoot,
  nativeFiles,
  boundaryConfig = "module-boundaries.config.mjs",
  io = {},
}) {
  const nxGraph = readProjectGraph(nxRoot, { run: runNxGraphSpawn, ...io });
  const nxAnalysis = analyze(nxRoot, nxGraph, nxFiles, undefined);

  const readFile = readFileFrom(nativeRoot);
  const discovered = nativeProvider.discover({ root: nativeRoot, files: nativeFiles, readFile });
  if (discovered.failures.length > 0) {
    throw new Error(
      `native discovery reported unclaimed-file failures the fixture did not expect: ` +
        JSON.stringify(discovered.failures),
    );
  }
  const preGraph = {
    nodes: Object.fromEntries(
      discovered.projects.map((project) => [
        project.name,
        { name: project.name, data: { root: project.root } },
      ]),
    ),
  };
  const nativeAnalysis = analyze(nativeRoot, preGraph, nativeFiles, discovered.model.tsConfig);
  assertNoAnalysisFailures(nxAnalysis.failures, nativeAnalysis.failures);
  const nativeGraph = nativeProvider.buildGraph({
    discovered,
    importSites: nativeAnalysis.imports,
  });

  const nxConfig = await loadBoundaryConfig(nxRoot, boundaryConfig);
  const nativeConfig = await loadBoundaryConfig(nativeRoot, boundaryConfig);
  const nxViolations = evaluate(nxAnalysis.imports, nxGraph, nxConfig);
  const nativeViolations = evaluate(nativeAnalysis.imports, nativeGraph, nativeConfig);

  return {
    nx: {
      nodes: nodeShape(nxGraph.nodes),
      dependencies: dependencyShape(nxGraph.dependencies),
      violations: nxViolations,
      violationStrings: verdictShape(nxViolations),
    },
    native: {
      nodes: nodeShape(nativeGraph.nodes),
      dependencies: dependencyShape(nativeGraph.dependencies),
      violations: nativeViolations,
      violationStrings: verdictShape(nativeViolations),
    },
  };
}

// ---------------------------------------------------------------------------
// diffGraphs — a per-field diagnosable comparison
// ---------------------------------------------------------------------------

/**
 * One row per disagreement between the two engines: `{kind, subject, field,
 * nx, native}`. `kind` is `"node"`, `"dependency"` or `"verdict"`; `subject`
 * is the project name, the `"source target type"` string, or (for verdicts,
 * which vary in exact `line:column` per fixture edit) the `messageId` alone;
 * `field` is which part of that subject disagreed.
 *
 * Deliberately not a single `expect(a).toEqual(b)` over two whole graphs —
 * that prints two 200-line objects and names neither the project nor the
 * field that differs.
 *
 * Two canonicalisations that must NOT throw away a real disagreement:
 *
 * - **Dependency edges compare as a MULTISET, not a `Set`.** A duplicate edge
 *   on one side (two import sites resolving to the same `source target type`
 *   triple) and a single copy on the other is a real difference — one side's
 *   analyzer over- or under-counting the same edge — and `new Set(...)`
 *   merging both down to one element each would make it invisible.
 * - **Verdicts compare both the per-`messageId` COUNT and, when the counts
 *   already match, the sorted list of `sourceFile:line:column` locations.**
 *   Two engines that agree "3 violations of rule X" while pointing at three
 *   different places have not actually agreed on anything a developer could
 *   act on — `../../../../../AGENTS.md`'s invariant is about the verdict
 *   reaching the right place, not just the right count.
 *
 * @param {{nodes: Record<string, {root: string, type: string, tags: string[]}>,
 *   dependencies: string[],
 *   violations: {messageId: string, sourceFile?: string, line?: number, column?: number}[]}} nxSide
 * @param {{nodes: Record<string, {root: string, type: string, tags: string[]}>,
 *   dependencies: string[],
 *   violations: {messageId: string, sourceFile?: string, line?: number, column?: number}[]}} nativeSide
 * @returns {{kind: string, subject: string, field: string, nx: unknown, native: unknown}[]}
 */
export function diffGraphs(nxSide, nativeSide) {
  const rows = [];

  const nxNames = new Set(Object.keys(nxSide.nodes));
  const nativeNames = new Set(Object.keys(nativeSide.nodes));
  for (const name of nxNames) {
    if (!nativeNames.has(name)) {
      rows.push({
        kind: "node",
        subject: name,
        field: "presence",
        nx: "present",
        native: "absent",
      });
    }
  }
  for (const name of nativeNames) {
    if (!nxNames.has(name)) {
      rows.push({
        kind: "node",
        subject: name,
        field: "presence",
        nx: "absent",
        native: "present",
      });
    }
  }
  for (const name of nxNames) {
    if (!nativeNames.has(name)) continue;
    const nxNode = nxSide.nodes[name];
    const nativeNode = nativeSide.nodes[name];
    for (const field of ["root", "type"]) {
      if (nxNode[field] !== nativeNode[field]) {
        rows.push({
          kind: "node",
          subject: name,
          field,
          nx: nxNode[field],
          native: nativeNode[field],
        });
      }
    }
    // `JSON.stringify` of the sorted array, not a comma-joined string — a tag
    // containing a comma (nothing in `./model.mjs`'s tag validation forbids
    // one) would let two distinct tag lists collapse onto the same string:
    // `["a,b"]` and `["a", "b"]` both join to `"a,b"`, and the second list's
    // real difference from the first would vanish before this function ever
    // returned a row for it.
    const nxTags = JSON.stringify([...nxNode.tags].sort());
    const nativeTags = JSON.stringify([...nativeNode.tags].sort());
    if (nxTags !== nativeTags) {
      rows.push({ kind: "node", subject: name, field: "tags", nx: nxTags, native: nativeTags });
    }
  }

  /** @param {string[]} edges @returns {Map<string, number>} */
  const countByEdge = (edges) => {
    const counts = new Map();
    for (const edge of edges) counts.set(edge, (counts.get(edge) ?? 0) + 1);
    return counts;
  };
  const nxEdgeCounts = countByEdge(nxSide.dependencies);
  const nativeEdgeCounts = countByEdge(nativeSide.dependencies);
  for (const edge of new Set([...nxEdgeCounts.keys(), ...nativeEdgeCounts.keys()])) {
    const nxCount = nxEdgeCounts.get(edge) ?? 0;
    const nativeCount = nativeEdgeCounts.get(edge) ?? 0;
    if (nxCount === 0) {
      rows.push({
        kind: "dependency",
        subject: edge,
        field: "presence",
        nx: "absent",
        native: "present",
      });
    } else if (nativeCount === 0) {
      rows.push({
        kind: "dependency",
        subject: edge,
        field: "presence",
        nx: "present",
        native: "absent",
      });
    } else if (nxCount !== nativeCount) {
      rows.push({
        kind: "dependency",
        subject: edge,
        field: "count",
        nx: nxCount,
        native: nativeCount,
      });
    }
  }

  /** @param {{messageId: string, sourceFile?: string, line?: number, column?: number}[]} violations
   * @returns {Map<string, string[]>} messageId → sorted `sourceFile:line:column` strings. */
  const locationsByMessage = (violations) => {
    /** @type {Map<string, string[]>} */
    const byMessage = new Map();
    for (const v of violations) {
      const location = `${v.sourceFile}:${v.line}:${v.column}`;
      const list = byMessage.get(v.messageId) ?? [];
      list.push(location);
      byMessage.set(v.messageId, list);
    }
    for (const list of byMessage.values()) list.sort();
    return byMessage;
  };
  const nxLocations = locationsByMessage(nxSide.violations);
  const nativeLocations = locationsByMessage(nativeSide.violations);
  for (const messageId of new Set([...nxLocations.keys(), ...nativeLocations.keys()])) {
    const nxList = nxLocations.get(messageId) ?? [];
    const nativeList = nativeLocations.get(messageId) ?? [];
    if (nxList.length !== nativeList.length) {
      rows.push({
        kind: "verdict",
        subject: messageId,
        field: "count",
        nx: nxList.length,
        native: nativeList.length,
      });
    } else if (nxList.join("|") !== nativeList.join("|")) {
      rows.push({
        kind: "verdict",
        subject: messageId,
        field: "location",
        nx: nxList.join(","),
        native: nativeList.join(","),
      });
    }
  }

  return rows;
}

/** Prefixes every row's `subject` with `${label}:` so ledger rows (and stale-row
 * detection) are scoped to one fixture pair and cannot silently absorb a
 * disagreement in another. */
export function namespaced(rows, label) {
  return rows.map((row) => ({ ...row, subject: `${label}:${row.subject}` }));
}

// ---------------------------------------------------------------------------
// The ledger — a decision that was made, never a difference that was hidden
// ---------------------------------------------------------------------------

/**
 * The only direction a `LedgerRow` may ever excuse — see `LEDGER_DIRECTIONS`
 * below for why the enum has exactly one member today and how a second one
 * would be added.
 * @typedef {"native-only"} LedgerDirection
 */

/**
 * @typedef {{subject: string, field: string, reason: string, issue: string,
 *   direction: LedgerDirection}} LedgerRow
 * A row mirrors `scripts/differential-real-trees.mjs`'s `LEDGER` shape with
 * two additions: `issue`, because every ledgered difference must carry a
 * linked, trackable follow-up and not only a reason — a difference that is
 * merely explained in prose can be re-explained forever, while one with an
 * issue number has to eventually close — and `direction`, an explicit,
 * enumerated claim about which side reported more. `direction` is not
 * decorative: `classifyDifferences` below both validates it against
 * `LEDGER_DIRECTIONS` and, independently of any ledger content, refuses to
 * let a matching `subject`/`field` pair explain away a verdict-count row
 * where Nx reports MORE than native — the one direction no row, however it
 * spells its `reason`, may ever cover.
 */

/**
 * Every value `LedgerRow.direction` may take. One member today —
 * `"native-only"`, the loud, self-correcting direction
 * (`../../../../../AGENTS.md`'s invariant) — because a ledger row only ever
 * exists to explain native reporting something Nx does not; the enum is
 * still written as a list, not a literal type alias inlined into the
 * `LedgerRow` typedef alone, so a second legitimate direction (should one
 * ever exist) is one entry added here plus a matching rule in
 * `classifyDifferences`, not a search for every place `"native-only"` was
 * spelled as a bare string.
 */
export const LEDGER_DIRECTIONS = Object.freeze(/** @type {const} */ (["native-only"]));

/**
 * Every entry here is a **difference native reports and Nx does not** — the
 * loud, self-correcting direction (`../../../../../AGENTS.md`'s invariant). An
 * entry in the other direction is refused structurally: `classifyDifferences`
 * throws on any verdict-count row where Nx's count exceeds native's, before
 * it ever looks at whether a row here matches — no `reason`, however it is
 * worded, can turn that row into an explained one.
 *
 * Empty today: the one row this ledger ever carried (`layout:
 * noRelativeOrAbsoluteImportsAcrossLibraries`, native-only, issue #31) retired
 * when `../nx.mjs`'s `readProjectGraph` started merging `nx.json`'s
 * `workspaceLayout` back onto the graph it returns — see that function's own
 * header, and `readWorkspaceLayout`/`requireCompleteWorkspaceLayout` in
 * `../../options.mjs`. The `layout` fixture pair below is unchanged and now
 * agrees on both engines instead of differing by one, which is what closes
 * issue #31: the divergence this row explained no longer exists to explain.
 *
 * @type {readonly LedgerRow[]}
 */
export const LEDGER = Object.freeze([]);

/**
 * Every fixture-pair label this file actually runs a comparison over — the
 * one list every `LEDGER` row's `subject` prefix must belong to, and the one
 * list every `assertPairAgrees`/`pairProblems` call site draws its `label`
 * argument from, so the two can never drift into naming different pairs.
 */
export const PAIR_LABELS = Object.freeze(["simple", "composite", "layout"]);

/**
 * The direction a `diffGraphs` row itself claims, in `LedgerRow.direction`'s
 * own vocabulary plus its one unledgerable opposite: `"native-only"` when
 * native reports something nx does not (a `presence` row with nx absent, or a
 * `count` row where native's number is the larger one), `"nx-only"` for the
 * mirror shape — the direction `LEDGER_DIRECTIONS` has no member for, because
 * a `LedgerRow` may only ever excuse native reporting more — and `null` for
 * every other field (`root`, `type`, `tags`, a verdict's `location`): those
 * are two-sided value mismatches, not one side reporting more than the other,
 * so they carry no direction a ledger row could ever share.
 *
 * @param {{field: string, nx?: unknown, native?: unknown}} difference
 * @returns {"native-only" | "nx-only" | null}
 */
function differenceDirection(difference) {
  if (difference.field === "presence") {
    if (difference.nx === "absent" && difference.native === "present") return "native-only";
    if (difference.nx === "present" && difference.native === "absent") return "nx-only";
    return null;
  }
  if (
    difference.field === "count" &&
    typeof difference.nx === "number" &&
    typeof difference.native === "number"
  ) {
    if (difference.native > difference.nx) return "native-only";
    if (difference.nx > difference.native) return "nx-only";
  }
  return null;
}

/**
 * Splits `diffGraphs` rows into explained (a `ledger` row covers it),
 * unexplained (nothing does — a finding), and stale ledger rows (they cover
 * nothing that fired — also a finding, from the other side). Mirrors
 * `scripts/differential-real-trees.mjs`'s `classifyDifferences`; the
 * per-fixture `namespaced` prefix above is this function's substitute for
 * that oracle's `treeName` filter.
 *
 * Before any matching happens, every ledger row is checked for the same
 * three things a decision here always needs: a non-empty `reason`, a
 * non-empty `issue`, and a `direction` drawn from `LEDGER_DIRECTIONS` — a row
 * whose `direction` is missing or misspelled is as unusable as one with no
 * `reason` at all, so it fails the same way, before matching.
 *
 * Then, independently of `ledger`'s contents: any `difference` of
 * `kind: "verdict"`, `field: "count"` where `nx > native` is refused outright
 * — `classifyDifferences` THROWS rather than returning it as "explained" or
 * even "unexplained". Nx finding a violation native does not is the one
 * silent shape `../../../../../AGENTS.md`'s invariant exists to rule out, and a
 * `LedgerRow` matching that difference's `subject`/`field` used to be enough
 * to explain it away regardless of what the row's `reason` said — this is
 * the fix: no reason, however worded, gets a vote on that direction.
 *
 * A row's `subject`/`field` matching a difference is not enough on its own,
 * either: `LEDGER` rows only ever declare `direction: "native-only"`, and
 * matching by `subject`/`field` alone would let such a row explain away a
 * difference running the opposite way — native missing something nx has,
 * which is a native-provider regression, not the loud/self-correcting
 * shape the ledger exists to record. `differenceDirection` above answers
 * which way a given row actually runs; a row only fires when that answer
 * equals `row.direction`, so a matching `subject`/`field` whose direction
 * disagrees lands in `unexplained` instead.
 *
 * @param {{kind?: string, subject: string, field: string, nx?: unknown, native?: unknown}[]} differences
 * @param {readonly LedgerRow[]} ledger
 * @returns {{explained: object[], unexplained: object[], stale: LedgerRow[]}}
 * @throws {Error} on a malformed ledger row, or a `nx > native` verdict-count
 *   difference no ledger row may ever cover.
 */
export function classifyDifferences(differences, ledger) {
  for (const row of ledger) {
    if (!row.reason?.trim()) {
      throw new Error(`ledger row for "${row.subject}"/"${row.field}" has an empty reason`);
    }
    if (!row.issue?.trim()) {
      throw new Error(
        `ledger row for "${row.subject}"/"${row.field}" has no linked issue — every ledgered ` +
          `difference must carry a linked, trackable follow-up, not only a reason`,
      );
    }
    if (!LEDGER_DIRECTIONS.includes(row.direction)) {
      throw new Error(
        `ledger row for "${row.subject}"/"${row.field}" has an invalid direction ` +
          `${JSON.stringify(row.direction)} — must be one of ${LEDGER_DIRECTIONS.join(", ")}`,
      );
    }
  }
  const fired = new Set();
  const explained = [];
  const unexplained = [];
  for (const difference of differences) {
    if (
      difference.kind === "verdict" &&
      difference.field === "count" &&
      typeof difference.nx === "number" &&
      typeof difference.native === "number" &&
      difference.nx > difference.native
    ) {
      throw new Error(
        `classifyDifferences refuses to explain "${difference.subject}": nx reported ` +
          `${difference.nx} and native reported only ${difference.native} — native ` +
          `under-reporting relative to Nx is never ledgerable, at any count ` +
          `(../../../../../AGENTS.md's invariant); this is an empty-verdict-shaped breach, not a ` +
          `difference any ledger row — matching or not — may explain away.`,
      );
    }
    const row = ledger.find(
      (r) =>
        r.subject === difference.subject &&
        r.field === difference.field &&
        r.direction === differenceDirection(difference),
    );
    if (row) {
      fired.add(row);
      explained.push({ difference, row });
    } else {
      unexplained.push(difference);
    }
  }
  return { explained, unexplained, stale: ledger.filter((row) => !fired.has(row)) };
}

/**
 * The aggregate half of the empty-verdict claim (`../../../../../AGENTS.md`'s
 * invariant), applied to one fixture pair's TOTAL violation count per engine.
 * On a pair the fixture designed to contain a violation, an engine answering
 * zero has not found a clean tree — it has stopped looking. Deliberately
 * takes no `ledger` argument: this direction is never ledgerable (see
 * `classifyDifferences` above for the same refusal enforced structurally),
 * and the surest way to keep it that way is a function with nowhere to pass
 * one in.
 *
 * This only ever catches a TOTAL of zero on one side; `perMessageBreaches`
 * below is the finer-grained sibling that catches native under-reporting
 * relative to Nx on any one `messageId` even when neither total is literally
 * zero.
 *
 * @param {string} label
 * @param {{nx: number, native: number}} counts
 * @returns {string[]}
 */
export function emptyVerdictBreaches(label, counts) {
  const breaches = [];
  for (const [engine, count] of Object.entries(counts)) {
    if (count === 0) {
      breaches.push(
        `${label}: ${engine} reported ZERO violations on a fixture built to contain one — ` +
          "that is a silent engine, not a clean tree.",
      );
    }
  }
  return breaches;
}

/**
 * The per-`messageId` sibling `emptyVerdictBreaches`'s own doc comment
 * promises: native reporting FEWER of one `messageId` than Nx is a breach
 * even when neither side's TOTAL is zero — `{nx: 9, native: 1}` on one rule
 * is exactly as silent, for that rule, as `{nx: 1, native: 0}` is for the
 * whole pair, because whichever finding native dropped is still gone.
 * Deliberately takes no `ledger`, for the same reason `emptyVerdictBreaches`
 * does not.
 *
 * @param {string} label
 * @param {{messageId: string}[]} nxViolations
 * @param {{messageId: string}[]} nativeViolations
 * @returns {string[]}
 */
export function perMessageBreaches(label, nxViolations, nativeViolations) {
  /** @param {{messageId: string}[]} violations @returns {Map<string, number>} */
  const countBy = (violations) => {
    const counts = new Map();
    for (const v of violations) counts.set(v.messageId, (counts.get(v.messageId) ?? 0) + 1);
    return counts;
  };
  const nxCounts = countBy(nxViolations);
  const nativeCounts = countBy(nativeViolations);
  const breaches = [];
  for (const [messageId, nxCount] of nxCounts) {
    const nativeCount = nativeCounts.get(messageId) ?? 0;
    if (nativeCount < nxCount) {
      breaches.push(
        `${label}: nx reported ${nxCount} × "${messageId}" and native reported only ` +
          `${nativeCount} — native under-reporting relative to Nx on one messageId is a breach ` +
          `even though neither engine's total is zero.`,
      );
    }
  }
  return breaches;
}

/**
 * Every problem a fixture pair's own run surfaces, as human-readable
 * strings, empty when the pair fully agrees: an aggregate empty-verdict
 * breach, a per-`messageId` breach, an unexplained `diffGraphs` difference,
 * or a ledger row scoped to this `label` that never fired. Pure — it returns
 * problems rather than asserting them — so `assertPairAgrees` below is a
 * thin, vitest-free wrapper and a test that wants the raw list (rather than a
 * thrown `Error`) can call this directly.
 *
 * @param {string} label
 * @param {Awaited<ReturnType<typeof runBothProviders>>} result
 * @param {readonly LedgerRow[]} [ledger]
 * @returns {string[]}
 */
export function pairProblems(label, result, ledger = LEDGER) {
  const problems = [
    ...emptyVerdictBreaches(label, {
      nx: result.nx.violations.length,
      native: result.native.violations.length,
    }),
    ...perMessageBreaches(label, result.nx.violations, result.native.violations),
  ];

  const rows = namespaced(diffGraphs(result.nx, result.native), label);
  const { unexplained, stale } = classifyDifferences(rows, ledger);
  if (unexplained.length > 0) {
    problems.push(`${label}: unexplained differences:\n${JSON.stringify(unexplained, null, 2)}`);
  }
  const staleForLabel = stale.filter((row) => row.subject.startsWith(`${label}:`));
  if (staleForLabel.length > 0) {
    problems.push(`${label}: stale ledger rows:\n${JSON.stringify(staleForLabel, null, 2)}`);
  }
  return problems;
}

/**
 * Runs a fixture pair's providers, diffs the two graphs, classifies the
 * differences against `LEDGER`, and throws (naming every problem at once)
 * unless the pair fully agrees: no breach (aggregate or per-`messageId`,
 * regardless of ledger), no unexplained difference, no stale ledger row
 * scoped to this pair. One call per fixture pair in
 * `differential.integration.test.mjs`.
 *
 * A thin wrapper over `pairProblems` — throwing rather than returning is what
 * lets a caller write `assertPairAgrees("simple", result)` as one statement
 * inside an `it()` and get vitest's own failure reporting for free, without
 * this module importing `expect` (or anything else from `vitest`) to do it.
 *
 * @param {string} label
 * @param {Awaited<ReturnType<typeof runBothProviders>>} result
 * @param {readonly LedgerRow[]} [ledger]
 */
export function assertPairAgrees(label, result, ledger = LEDGER) {
  const problems = pairProblems(label, result, ledger);
  if (problems.length > 0) {
    throw new Error(`${label}: provider differential disagreement:\n  ${problems.join("\n  ")}`);
  }
}

/**
 * Rows whose `subject`'s label prefix (the text before the first `:`, which
 * `namespaced` above always inserts) names no pair in `knownLabels`. A row
 * like this is invisible to the stale-row check every real pair runs —
 * `pairProblems`/`assertPairAgrees` only ever look at
 * `stale.filter((row) => row.subject.startsWith(`${label}:`))` for the one
 * `label` that pair ran under, so a row whose prefix matches NO real label is
 * filtered out by every pair's own check and reported stale by none of
 * them — a waiver that both explains nothing (nothing it could match ever
 * fires) and is caught by nothing (its "no-op" stays invisible forever). The
 * exact silent hole `../../../../../AGENTS.md`'s invariant forbids, applied to
 * this file's own bookkeeping rather than to the tool under test.
 *
 * @param {readonly LedgerRow[]} ledger
 * @param {readonly string[]} knownLabels
 * @returns {LedgerRow[]}
 */
export function unknownLabelRows(ledger, knownLabels) {
  return ledger.filter((row) => !knownLabels.includes(row.subject.split(":")[0]));
}

// ---------------------------------------------------------------------------
// Fixture-tree builders
// ---------------------------------------------------------------------------

// Exported (not just module-private) so `../../config-spelling.integration.test.mjs`
// — the config-spelling differential — can build its own dialect spellings
// (`.mjs`, `.json`, an ESLint flat config, an inline `archkeep.json` object)
// of this EXACT law and prove they agree, rather than writing a byte-for-byte
// second copy of the same table: this module's own header already commits to
// staying importable and spawn-free at import time for exactly that reuse,
// and a second copy here is the drift `../../../../../AGENTS.md`'s "never
// state a rule twice" rule exists to catch.
export const SIMPLE_BOUNDARY_CONFIG = `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;

// One physical shape, written byte-identical into both trees below: two Go
// modules, tagged opposite the layer axis, with one import that crosses it
// the wrong way (`domain` reaching into `adapter`). Exported for the same
// reuse reason as `SIMPLE_BOUNDARY_CONFIG` above.
export const SIMPLE_GO_FILES = {
  "libs/domain/go.mod": "module example.com/domain\n\ngo 1.24\n",
  "libs/adapter/go.mod": "module example.com/adapter\n\ngo 1.24\n",
  "libs/adapter/adapter.go": 'package adapter\n\nvar Name = "adapter"\n',
  "libs/domain/doc.go": `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
};

/**
 * Writes the Nx half of the `simple` pair: `nx.json` registering `../nx.mjs`
 * as a local plugin, `project.json` per project, the boundary config, and
 * the two Go modules. Returns the list of files written, for the analysis
 * pipeline's `files` argument.
 *
 * @param {string} root An existing, empty directory.
 * @param {{boundaryConfig?: string}} [options]
 * @returns {string[]}
 */
export function buildSimpleNxTree(root, { boundaryConfig = "module-boundaries.config.mjs" } = {}) {
  const write = writeIn(root);
  write(
    "nx.json",
    JSON.stringify({
      plugins: [{ plugin: "@ecoma-io/archkeep/nx", options: { boundaryConfig } }],
    }),
  );
  write(boundaryConfig, SIMPLE_BOUNDARY_CONFIG);
  write("libs/domain/project.json", JSON.stringify({ name: "domain", tags: ["layer:domain"] }));
  write("libs/adapter/project.json", JSON.stringify({ name: "adapter", tags: ["layer:adapter"] }));
  writeAll(write, SIMPLE_GO_FILES);
  return [
    "nx.json",
    boundaryConfig,
    "libs/domain/project.json",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/project.json",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
  ];
}

/**
 * Writes the native half of the `simple` pair: `archkeep.json` declaring the
 * identical two projects by name and tag, no `nx.json`, no `project.json`,
 * no `nx` reachable from here at all.
 *
 * @param {string} root An existing, empty directory.
 * @param {{boundaryConfig?: string}} [options]
 * @returns {string[]}
 */
export function buildSimpleNativeTree(
  root,
  { boundaryConfig = "module-boundaries.config.mjs" } = {},
) {
  const write = writeIn(root);
  write(
    "archkeep.json",
    JSON.stringify({
      projects: {
        declared: [
          { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
          { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
        ],
      },
      coverage: {
        exempt: [
          {
            path: boundaryConfig,
            reason: "workspace tooling config at the root, not itself a project",
          },
        ],
      },
    }),
  );
  write(boundaryConfig, SIMPLE_BOUNDARY_CONFIG);
  writeAll(write, SIMPLE_GO_FILES);
  return [
    "archkeep.json",
    boundaryConfig,
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
  ];
}

// --- composite: axes 1-6 in one tree -----------------------------------
//
// | project           | axis(es) it carries                                         |
// | ------------------ | ------------------------------------------------------------ |
// | `declared-only`    | 1 — name from a native `declared` row, no manifest at all; 5 — a LITERAL implicit-dependency entry spelled on the declared row itself, not via project.json |
// | `pkg-named-project`| 1 — name from `package.json`; 4 — a tag Nx synthesises (`npm:private`), matched on the native side by a `projectRules` row (see `./README.md`'s "Declared limits") |
// | `basenamed`        | 1 — name falls all the way to `basename(root)`                |
// | `workspace-root`   | 3 — a project declared at `root: ""`                           |
// | `e2eish-e2e`       | 2 — `-e2e` suffix + `projectType: "application"` → type `"e2e"`; 5 — a `tag:`-pattern implicit dependency |
// | `parent`           | 4 — tags from ALL THREE sources at once (declared row, `projectRules`, `project.json`) on the SAME project, the union axis 4 actually needs exercised; 5 — a literal-name implicit dependency; 6 — the outer half of a nested pair |
// | `nested-child`     | 6 — nested inside `parent`'s own directory; also the source of the one real (and only) crossing import this fixture's boundary rule flags |
//
// Nx's own built-in js/package-json plugin merges into ANY directory holding
// a `package.json` — measured empirically before writing this fixture:
// unless an accompanying `project.json` states `"projectType": "library"`
// explicitly, that directory is typed `"application"` and gets an automatic
// `"npm:public"`/`"npm:private"` tag, regardless of npm/pnpm workspace glob
// coverage. `pkg-named-project`'s `project.json` states `"projectType":
// "library"` for exactly this reason. Its native-side `projectRules` row
// states the matching `npm:private` tag explicitly rather than inferring it
// from `package.json` — a deliberate design refusal, not a gap: see
// `./README.md`'s "Declared limits", item 6.
const COMPOSITE_BOUNDARY_CONFIG = `export const depConstraints = [
  { sourceTag: "layer:parent", onlyDependOnLibsWithTags: ["layer:parent", "layer:child"] },
  { sourceTag: "layer:child", onlyDependOnLibsWithTags: ["layer:child"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;

// `nested-child` imports `parent` — a real Go import, and the one edge this
// fixture's boundary rule flags: `layer:child` may only depend on
// `layer:child`, so `nested-child` reaching into `parent` (`layer:parent`)
// is the fixture's single, deliberate violation. Nothing else here carries a
// real import, so both engines are expected to report exactly one verdict.
const COMPOSITE_GO_FILES = {
  "libs/parent/go.mod": "module example.com/parent\n\ngo 1.24\n",
  "libs/parent/parent.go": 'package parent\n\nvar Name = "parent"\n',
  "libs/parent/nested-child/go.mod": "module example.com/nestedchild\n\ngo 1.24\n",
  "libs/parent/nested-child/doc.go": `// Package nestedchild sits inside parent's own directory — axis 6.
package nestedchild

import (
	"example.com/parent"
)

var _ = parent.Name
`,
};

/**
 * @param {string} root An existing, empty directory.
 * @param {{boundaryConfig?: string}} [options]
 * @returns {string[]}
 */
export function buildCompositeNxTree(
  root,
  { boundaryConfig = "module-boundaries.config.mjs" } = {},
) {
  const write = writeIn(root);
  write(
    "nx.json",
    JSON.stringify({
      plugins: [{ plugin: "@ecoma-io/archkeep/nx", options: { boundaryConfig } }],
    }),
  );
  write(boundaryConfig, COMPOSITE_BOUNDARY_CONFIG);

  write(
    "libs/declared-only/project.json",
    JSON.stringify({ name: "declared-only", implicitDependencies: ["parent"] }),
  );
  write("libs/declared-only/README.md", "# declared-only\n");

  write("libs/pkgnamed/project.json", JSON.stringify({ projectType: "library" }));
  write("libs/pkgnamed/package.json", JSON.stringify({ name: "pkg-named-project", private: true }));

  write("libs/basenamed/project.json", "{}");

  write("project.json", JSON.stringify({ name: "workspace-root", tags: ["scope:root"] }));

  write(
    "libs/e2eish-e2e/project.json",
    JSON.stringify({
      name: "e2eish-e2e",
      projectType: "application",
      implicitDependencies: ["tag:layer:child"],
    }),
  );

  // Axis 4's union, mirrored: native draws `parent`'s tags from THREE
  // sources (a `projects.declared` row, a `projectRules` row, and this
  // `project.json`); Nx has no such three-way split, so its `project.json`
  // states the union outright — the same final tag SET, spelled the one way
  // Nx understands.
  write(
    "libs/parent/project.json",
    JSON.stringify({
      name: "parent",
      tags: ["layer:parent", "union:declared", "union:projectRules"],
      implicitDependencies: ["nested-child"],
    }),
  );
  write(
    "libs/parent/nested-child/project.json",
    JSON.stringify({ name: "nested-child", tags: ["layer:child"] }),
  );

  writeAll(write, COMPOSITE_GO_FILES);

  return [
    "nx.json",
    boundaryConfig,
    "libs/declared-only/project.json",
    "libs/declared-only/README.md",
    "libs/pkgnamed/project.json",
    "libs/pkgnamed/package.json",
    "libs/basenamed/project.json",
    "project.json",
    "libs/e2eish-e2e/project.json",
    "libs/parent/project.json",
    "libs/parent/go.mod",
    "libs/parent/parent.go",
    "libs/parent/nested-child/project.json",
    "libs/parent/nested-child/go.mod",
    "libs/parent/nested-child/doc.go",
  ];
}

/**
 * @param {string} root An existing, empty directory.
 * @param {{boundaryConfig?: string}} [options]
 * @returns {string[]}
 */
export function buildCompositeNativeTree(
  root,
  { boundaryConfig = "module-boundaries.config.mjs" } = {},
) {
  const write = writeIn(root);
  write(
    "archkeep.json",
    JSON.stringify({
      projects: {
        declared: [
          {
            root: "libs/declared-only",
            name: "declared-only",
            tags: [],
            // Axis 5, driven through the DECLARED-ROW spelling rather than
            // (as `parent`'s below is) through an inferred `project.json` —
            // `declared-only` has no manifest at all, so this is the only
            // route this fixture has for a literal implicit-dependency entry
            // that never touches `project.json`'s own `implicitDependencies`
            // key.
            implicitDependencies: ["parent"],
          },
          // `parent` is declared here TOO, even though it also has a
          // `project.json` picked up by `infer` below — discovery allows a
          // root to be both; this is what gives it a declared-row tag
          // ALONGSIDE its `project.json` tag and its `projectRules` tag, the
          // three-source union axis 4 exists to prove. No `name` on this row:
          // name precedence still needs to resolve through `project.json`
          // (axis 1's own `declared?.name ?? manifest?.name ?? …` ladder,
          // `./discover.mjs`), which this row leaves untouched by omitting
          // the key rather than repeating "parent" a second way.
          { root: "libs/parent", tags: ["union:declared"] },
        ],
        // Every other project here (`pkgnamed`, `basenamed`, `workspace-root`,
        // `e2eish-e2e`, `parent`, `nested-child`) has to be reached by
        // inference from its own `project.json`/`package.json`, the same way
        // an Nx tree finds them with no `archkeep.json` at all — an absent
        // `projects.infer` key means "the declared list is exhaustive, no
        // inference" (`./model.mjs`'s own comment on the key), and this
        // fixture needs the opposite of that. `{}` takes every default:
        // `DEFAULT_MANIFEST_NAMES`, `include: ["**"]`, `exclude: []`.
        infer: {},
      },
      projectRules: [
        { match: "libs/pkgnamed", tags: ["npm:private"] },
        { match: "libs/parent", tags: ["union:projectRules"] },
      ],
      // No `coverage.exempt` needed here, unlike `simple`: `infer` above
      // finds `project.json` at the tree root and turns it into the
      // `workspace-root` project (axis 3), so `boundaryConfig` at the root is
      // claimed by that project rather than left unclaimed.
    }),
  );
  write(boundaryConfig, COMPOSITE_BOUNDARY_CONFIG);

  write("libs/declared-only/README.md", "# declared-only\n");

  write("libs/pkgnamed/project.json", JSON.stringify({ projectType: "library" }));
  write("libs/pkgnamed/package.json", JSON.stringify({ name: "pkg-named-project", private: true }));

  write("libs/basenamed/project.json", "{}");

  write("project.json", JSON.stringify({ name: "workspace-root", tags: ["scope:root"] }));

  write(
    "libs/e2eish-e2e/project.json",
    JSON.stringify({
      name: "e2eish-e2e",
      projectType: "application",
      implicitDependencies: ["tag:layer:child"],
    }),
  );

  write(
    "libs/parent/project.json",
    JSON.stringify({
      name: "parent",
      tags: ["layer:parent"],
      implicitDependencies: ["nested-child"],
    }),
  );
  write(
    "libs/parent/nested-child/project.json",
    JSON.stringify({ name: "nested-child", tags: ["layer:child"] }),
  );

  writeAll(write, COMPOSITE_GO_FILES);

  return [
    "archkeep.json",
    boundaryConfig,
    "libs/declared-only/README.md",
    "libs/pkgnamed/project.json",
    "libs/pkgnamed/package.json",
    "libs/basenamed/project.json",
    "project.json",
    "libs/e2eish-e2e/project.json",
    "libs/parent/project.json",
    "libs/parent/go.mod",
    "libs/parent/parent.go",
    "libs/parent/nested-child/project.json",
    "libs/parent/nested-child/go.mod",
    "libs/parent/nested-child/doc.go",
  ];
}

// --- layout: axis 7 alone -------------------------------------------------
//
// `workspaceLayout` is workspace-global (`../../rules/index.mjs`'s
// `DEFAULT_WORKSPACE_LAYOUT` fallback applies to the whole graph, not one
// project), so it earns its own tree rather than folding into `composite`.
//
// Two projects, `thing` (`layer:thing`) and `blocked` (`layer:blocked`), with
// `thing`'s source carrying TWO import statements:
//
// 1. A real, resolvable Go import of `blocked` — this is a plain layer-tag
//    violation, unrelated to `workspaceLayout`, and BOTH engines must find it
//    identically. It is the pair's control: without it, a fixture where Nx
//    legitimately reports zero violations would itself be the empty-verdict
//    breach `emptyVerdictBreaches` exists to catch (`../../../../../AGENTS.md`'s
//    invariant — a run must never look clean because it stopped looking, and
//    that applies to this file's own fixtures as much as to the tool).
// 2. The literal specifier `"packages/elsewhere"` — text
//    `../../rules/specifiers.mjs`'s `isAbsoluteImportIntoAnotherProject`
//    flags unconditionally when `workspaceLayout.libsDir` is `"packages"`,
//    regardless of whether `elsewhere` resolves to a real project.
//    `archkeep.json` states that `libsDir`; `nx.json` states the identical
//    `workspaceLayout` key.
//
// The two engines now AGREE on import 2, which is the point of this fixture
// existing: `../nx.mjs`'s `readProjectGraph` merges `nx.json`'s own
// `workspaceLayout` back onto the graph it returns (that function's own
// header — issue #31), so the Nx side sees the identical non-default
// `libsDir` the native side always read from `archkeep.json` directly, and
// both flag `"packages/"` as a triggering prefix. Before that fix landed, the
// two disagreed by exactly one violation here — the `LEDGER` row (now
// retired) that used to explain it, and the reason a dedicated `it` for this
// pair exists in `differential.integration.test.mjs` at all rather than a
// generic loop entry: it is the one fixture pair built to prove
// `workspaceLayout` specifically, and it now asserts plain agreement through
// `assertPairAgrees` like every other pair.
const LAYOUT_BOUNDARY_CONFIG = `export const depConstraints = [
  { sourceTag: "layer:thing", onlyDependOnLibsWithTags: ["layer:thing"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;

const LAYOUT_GO_FILES = {
  "packages/thing/go.mod": "module example.com/thing\n\ngo 1.24\n",
  "packages/thing/thing.go": `package thing

import (
	"example.com/blocked"
	"packages/elsewhere"
)

var _ = blocked.Name
var _ = elsewhere.Name
`,
  "packages/blocked/go.mod": "module example.com/blocked\n\ngo 1.24\n",
  "packages/blocked/blocked.go": 'package blocked\n\nvar Name = "blocked"\n',
};

/**
 * @param {string} root An existing, empty directory.
 * @param {{boundaryConfig?: string}} [options]
 * @returns {string[]}
 */
export function buildLayoutNxTree(root, { boundaryConfig = "module-boundaries.config.mjs" } = {}) {
  const write = writeIn(root);
  write(
    "nx.json",
    JSON.stringify({
      plugins: [{ plugin: "@ecoma-io/archkeep/nx", options: { boundaryConfig } }],
      workspaceLayout: { libsDir: "packages", appsDir: "apps" },
    }),
  );
  write(boundaryConfig, LAYOUT_BOUNDARY_CONFIG);
  write("packages/thing/project.json", JSON.stringify({ name: "thing", tags: ["layer:thing"] }));
  write(
    "packages/blocked/project.json",
    JSON.stringify({ name: "blocked", tags: ["layer:blocked"] }),
  );
  writeAll(write, LAYOUT_GO_FILES);
  return [
    "nx.json",
    boundaryConfig,
    "packages/thing/project.json",
    "packages/thing/go.mod",
    "packages/thing/thing.go",
    "packages/blocked/project.json",
    "packages/blocked/go.mod",
    "packages/blocked/blocked.go",
  ];
}

/**
 * @param {string} root An existing, empty directory.
 * @param {{boundaryConfig?: string}} [options]
 * @returns {string[]}
 */
export function buildLayoutNativeTree(
  root,
  { boundaryConfig = "module-boundaries.config.mjs" } = {},
) {
  const write = writeIn(root);
  write(
    "archkeep.json",
    JSON.stringify({
      projects: {
        declared: [
          { root: "packages/thing", name: "thing", tags: ["layer:thing"] },
          { root: "packages/blocked", name: "blocked", tags: ["layer:blocked"] },
        ],
      },
      workspaceLayout: { libsDir: "packages", appsDir: "apps" },
      coverage: {
        exempt: [
          {
            path: boundaryConfig,
            reason: "workspace tooling config at the root, not itself a project",
          },
        ],
      },
    }),
  );
  write(boundaryConfig, LAYOUT_BOUNDARY_CONFIG);
  writeAll(write, LAYOUT_GO_FILES);
  return [
    "archkeep.json",
    boundaryConfig,
    "packages/thing/go.mod",
    "packages/thing/thing.go",
    "packages/blocked/go.mod",
    "packages/blocked/blocked.go",
  ];
}

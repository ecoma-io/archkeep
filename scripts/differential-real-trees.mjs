#!/usr/bin/env node
// Runs the conformance differential — this repository's boundary engine against
// the real `@nx/enforce-module-boundaries` — over REAL public Nx workspaces,
// pinned at fixed commits. The fixture suite in
// `packages/lattice/src/conformance/` proves the two engines agree
// about the situations someone thought to build; this script is the third
// condition its README names: agreement measured on trees nobody here built,
// under constraint tables and tag vocabularies this repository had no hand in.
//
// What one tree run does, in order, each step loud on failure:
//
//   1. shallow-clones the repository at its PINNED commit (`git fetch --depth 1
//      <url> <sha>`), and verifies `git rev-parse HEAD` answers that exact sha;
//   2. installs its dependencies with the tree's own lockfile (per-tree command
//      in the table below, with the measured reason where `npm ci` refuses);
//   3. computes the project graph with the TREE'S OWN nx (`node_modules/.bin/nx
//      graph --file=`), so the nodes and tags are what that workspace's Nx
//      actually reports, not a reconstruction;
//   4. spawns one child process per tree (`differential-real-trees-child.mjs` —
//      its header says why a process boundary is required) which runs BOTH
//      engines over every tracked file and compares verdicts per file, THEN a
//      third leg: a `lattice.json` mechanically derived from the same graph
//      (`deriveNativeModel` below), run through the native provider, and
//      compared node-set/edge-set/verdict-set against the Nx-graph-based run
//      — the provider's fidelity on a tree nobody built for it;
//   5. classifies every difference — upstream-vs-tool and native-vs-tool alike
//      — against the ledger below, and checks the empty-verdict claim for
//      trees measured to contain violations.
//
// Exit codes mirror `packages/lattice/cli.mjs`: 0 clean, 1 findings
// (an unexplained difference, a stale ledger entry, or an empty verdict set
// where violations are known to exist), 2 usage, 3 infrastructure (clone,
// install, graph or child failure — a run that could not look must never read
// as a run that looked and found agreement).
//
// Nothing is cached between runs, deliberately. A fresh clone at a pinned sha
// costs seconds and cannot be stale; the installs cost a few minutes weekly.
// A cached tree or node_modules that silently survived a lockfile change would
// make the run test yesterday's inputs while printing today's shas — the exact
// false comfort a differential exists to refuse.
//
// This script runs from `.github/workflows/differential.yml` (scheduled +
// manual, NOT part of ci-gate — that file's header carries the argument), and
// locally as `node scripts/differential-real-trees.mjs`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import { environmentForTree } from "../packages/lattice/src/workspace.mjs";
import { nodeTypeOf } from "../packages/lattice/src/providers/native/discover.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Same meanings as the CLI's exit contract (`packages/lattice/cli.mjs`). */
export const EXIT = Object.freeze({ ok: 0, findings: 1, usage: 2, error: 3 });

/**
 * Every `direction` value a `LEDGER` row may carry, split by which leg's
 * `scopeLedgerToDirections` call is allowed to see it — the ONE place that
 * vocabulary is spelled out. Before this constant existed the same four
 * strings were typed three times over: `reportTree`'s own
 * `scopeLedgerToDirections` call, `reportNativeLeg`'s, and this file's test
 * suite's `realDirections`. A typo in any one of those three copies (or a
 * fourth direction someone adds without updating the other two) would not
 * fail loudly — `scopeLedgerToDirections` just filters a mis-spelled row out
 * of every leg's scope, so it never fires and never goes stale, the exact
 * silent shape `scopeLedgerToDirections`'s own doc comment already names for
 * the SCOPING half of this bug. `upstream` and `native` derive `reportTree`'s
 * and `reportNativeLeg`'s calls; their union is what
 * `scopeLedgerToDirections` itself validates every row against below, so an
 * unknown direction is refused at the one place both legs pass through
 * rather than merely never matching.
 */
export const DIRECTIONS = Object.freeze({
  upstream: Object.freeze(["stricter", "weaker"]),
  native: Object.freeze(["native-extra", "native-missing"]),
});

/**
 * The real workspaces the differential runs against. Every entry is a public
 * repository under MIT or Apache-2.0, pinned to one commit, with a non-trivial
 * `depConstraints` table of its own — a tree whose only constraint row is
 * `*` → `*` would let both engines agree by having nothing to decide.
 *
 * How these two were found, and what was rejected, measured 2026-08-11 via
 * GitHub code search (`gh search code`) for `depConstraints` and for the
 * plugins that would mark a polyglot tree (`@naxodev/gonx`, `@monodon/rust`,
 * `@nxlv/python`, `@nx/vue` in `nx.json`):
 *
 * - nrwl/nx-examples — no license file, so its code cannot be pulled into a
 *   differential run here;
 * - nuclia/frontend, OpenAPITools/openapi-generator-cli — constraint table is
 *   the trivial `*` → `*`;
 * - nrwl/nx-console — a real table, but its graph needs a JDK (gradle plugin)
 *   plus `@nx/enterprise-cloud`, and most projects are `package.json`-based;
 *   rejected as unrunnable without a toolchain this harness must not require;
 * - codyslexia/nexa (Go), KBVE/kbve (Rust) — the only polyglot candidates that
 *   configure `depConstraints` at all; both tables are `*` → `*` and neither
 *   repository declares an OSI license. So: no qualifying real Go, Rust or
 *   Python Nx tree exists as of 2026-08-11, and no Vue one either
 *   (PWNDAO/pwn-sdks has a table but is GPL-3.0). The real-tree differential
 *   covers TypeScript and JavaScript for now, which is also the whole surface
 *   upstream can read — `.go`, `.rs` and `.py` files never reach the upstream
 *   rule, so a polyglot tree would widen this comparison by nothing until one
 *   with a real constraint table exists.
 *
 * `expectViolations` records a MEASURED fact about the pinned commit, not a
 * hope: linting every tracked file surfaces violations both trees' own
 * narrower lint setups do not run over (code-pushup's e2e mock fixtures cross
 * its `type:e2e` constraints — 25 verdicts; ng-doc's per-project
 * `eslint.config.mjs` files import the root config relatively across project
 * boundaries — 8 verdicts). A tree measured to contain violations where either
 * engine answers zero is a broken engine, not a clean tree.
 *
 * `expectedNativeProjects` is the same kind of measured fact, for the native
 * leg (§3 below): the number of nodes `nx graph --file=` reports for the
 * pinned commit — a floor `deriveNativeModel`'s output is checked against so a
 * derivation that silently produced an empty or near-empty model cannot pass
 * by comparing nothing against nothing.
 */
export const TREES = Object.freeze([
  {
    name: "code-pushup",
    url: "https://github.com/code-pushup/cli.git",
    sha: "ba41f9297e70d2f5ffdcd61f0138e5f150415859",
    license: "MIT",
    configFile: "eslint.config.js",
    // `npm ci` refuses this tree outright — its committed package-lock.json is
    // internally inconsistent (misses nice-napi@1.0.2 and node-addon-api@3.2.1,
    // measured at the pinned sha). `npm install` keeps every present entry at
    // its locked version and resolves only those two optional gaps.
    install: ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"],
    expectViolations: true,
    // Measured 2026-08-12 by running this leg against the pinned commit:
    // `deriveNativeModel` produces 35 declared projects from `nx graph
    // --file=`'s 35 nodes at this sha — comfortably above a floor that only
    // needs to catch a derivation that stopped looking.
    expectedNativeProjects: 35,
  },
  {
    name: "ng-doc",
    url: "https://github.com/ng-doc/ng-doc.git",
    sha: "b595004d8925b5c93ae56f82a6439cd10e5de0cb",
    license: "MIT",
    configFile: "eslint.config.mjs",
    install: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    expectViolations: true,
    // Measured 2026-08-12, same method: 8 nodes at this sha. The prior
    // placeholder of 10 was a guess made before this leg had ever run for
    // real, and it OVER-stated the floor — it would have fired a
    // `nativeProjectCountBreach` on every clean run of the correct 8, which
    // is exactly the "stopped looking" failure this floor exists to name
    // and would have named it falsely.
    expectedNativeProjects: 8,
  },
]);

/**
 * Explained differences between the two engines on the trees above — the same
 * held-from-both-sides shape as the fixture suite's deliberately-stricter
 * table. An entry explains a difference (`tree`, `direction`, `messageId`, and
 * a `sitePattern` regular expression the difference's `file:line:column` site
 * must match) and carries the reason a human accepted it. A difference no
 * entry explains fails the run; an entry no difference fires is stale and
 * fails the run too, because a ledger that outlives its difference is a
 * documented divergence that quietly stopped being checked.
 *
 * Empty for the upstream-vs-tool comparison (`"stricter"`/`"weaker"`) as of
 * the pinned shas: both engines report identical verdict sets on both trees
 * (25 + 8 verdicts, zero differences, measured 2026-08-11). NOT empty for the
 * native leg — see the `"native-missing"` entries below, added the first time
 * that leg ran against a real tree (2026-08-12). A populated native-leg
 * ledger on a first run is the expected outcome, not a regression: the value
 * this table adds is that each divergence is written down with an
 * investigated reason instead of left as "unknown".
 *
 * The native leg (§3, `deriveNativeModel` below) reuses this SAME table and
 * classifier rather than a parallel mechanism, with its own pair of
 * `direction` values so a native-leg entry can never be mistaken for — or
 * accidentally explain — an unrelated upstream-vs-tool difference that
 * happens to share a `messageId`/`sitePattern`: `"native-extra"` (the native
 * provider reports something the Nx-graph-based run does not — an extra
 * node, an extra edge, or an extra rule verdict) and `"native-missing"` (the
 * reverse: something the Nx-graph-based run has that the native provider's
 * derived model does not reproduce). For a node or edge difference,
 * `messageId` is the literal string `"node"` or `"edge"` and `sitePattern`
 * matches the node name or the `source->target` edge key rather than a
 * `file:line:column` site.
 */
export const LEDGER = Object.freeze([
  // { tree: "…", direction: "stricter"|"weaker"|"native-extra"|"native-missing",
  //   messageId: "…", sitePattern: "^…", reason: "…" }

  // A field-level divergence, surfaced by `nodeFieldDifferences` (above) the
  // first time it ran against a real tree: `workspace`'s root `project.json`
  // (root '.') declares no `projectType` at all — verified by reading it at
  // this pinned sha — yet the real Nx graph gives that node `type: "app"`.
  // Nx reaches that answer through the filesystem fallback `getProjectType`
  // applies when `projectType` is absent (probing `tsconfig.lib.json` /
  // `tsconfig.app.json` / a `package.json` entry point). `nodeTypeOf`
  // (../packages/lattice/src/providers/native/discover.mjs) documents, at the
  // point it is defined, that it deliberately does NOT reproduce that
  // fallback — an unstated `projectType` lands on `"lib"` there on purpose,
  // argued as the safe direction because `lib` is the only type with no
  // blanket import ban. This row is that already-documented, deliberate
  // scope limit showing up as a real divergence rather than a new defect: no
  // issue to track, because the gap is named and argued where the code that
  // has it is defined, not discovered here for the first time.
  {
    tree: "code-pushup",
    direction: "native-extra",
    messageId: "node",
    sitePattern: "^workspace#type$",
    reason:
      "workspace/project.json declares no projectType; the real Nx graph resolves this node's " +
      "type to 'app' through getProjectType's filesystem fallback (probing tsconfig.lib.json / " +
      "tsconfig.app.json / a package.json entry point), which nodeTypeOf " +
      "(../packages/lattice/src/providers/native/discover.mjs) documents it deliberately does not " +
      "reproduce — an absent projectType lands on 'lib' there on purpose, the safe direction since " +
      "lib carries no blanket import ban. A pre-existing, argued design limit, not a defect this " +
      "leg discovered; no issue filed.",
  },
]);

/**
 * Reads the `@nx/enforce-module-boundaries` entry off a tree's own flat ESLint
 * config, exactly as ESLint would bind it: the LAST unscoped entry that
 * configures the rule wins. Moved to `packages/lattice/src/eslint-config.mjs`
 * — the shipped `boundaryConfig` dialect that reads an ESLint flat config
 * parses the identical shape, and a second copy of that parser here would be
 * exactly the drift `AGENTS.md`'s "never state a rule twice" rule exists to
 * catch. Re-exported so this script and its child
 * (`differential-real-trees-child.mjs`) need no import changes.
 */
export { extractBoundaryRule } from "../packages/lattice/src/eslint-config.mjs";

/**
 * Narrows `LEDGER` to the rows one leg's `classifyDifferences` call is
 * allowed to see, by `direction`.
 *
 * `LEDGER` carries rows for two unrelated comparisons — upstream-vs-tool
 * (`"stricter"`/`"weaker"`) and the native leg (`"native-extra"`/
 * `"native-missing"`) — sharing one table by design (this file's `LEDGER` doc
 * comment). `classifyDifferences` marks a ledger entry stale whenever it
 * never fires against the `differences` array it was handed, and a
 * `"native-missing"` row can never fire against an upstream-vs-tool
 * `differences` array (that array only ever contains `"stricter"`/`"weaker"`
 * items) — so passing the FULL `LEDGER` to both call sites reported every
 * native-leg entry stale on the upstream-vs-tool side even while it correctly
 * explained a difference on the native side. Measured 2026-08-12: the run
 * that added this file's first native-leg ledger rows hit exactly that,
 * reporting them both `explained` (native side) and `STALE` (upstream-vs-tool
 * side) in the same run. Each caller scopes to its own two directions before
 * classifying, so an entry belonging to the other leg is invisible to this
 * call's staleness check rather than silently always-stale.
 *
 * Every row is also checked here against the FULL known direction set
 * (`DIRECTIONS`, both legs) before narrowing — not just the `directions` this
 * particular call was scoped to — because both legs call this function over
 * the same `LEDGER` every run, so a row whose `direction` is misspelled or
 * belongs to neither leg would otherwise be silently dropped by every call
 * that scopes it: never a candidate, never fired, never reported stale. That
 * is a ledger entry that stopped being checked at all, not one row failing
 * to explain — this throws instead.
 *
 * @param {readonly object[]} ledger
 * @param {readonly string[]} directions
 * @returns {object[]}
 * @throws {Error} on a row whose `direction` is not in `DIRECTIONS.upstream`
 *   or `DIRECTIONS.native`.
 */
export function scopeLedgerToDirections(ledger, directions) {
  const known = new Set([...DIRECTIONS.upstream, ...DIRECTIONS.native]);
  for (const entry of ledger) {
    if (!known.has(entry.direction)) {
      throw new Error(
        `differential-real-trees: ledger row for ${entry.tree} (${entry.sitePattern}) has an ` +
          `unrecognised direction ${JSON.stringify(entry.direction)} — must be one of ` +
          `${[...known].join(", ")}. An unscoped direction would match no leg's ` +
          `scopeLedgerToDirections call and silently never fire, never go stale, never be reported.`,
      );
    }
  }
  const allowed = new Set(directions);
  return ledger.filter((entry) => allowed.has(entry.direction));
}

/**
 * Splits a tree's differences into explained (a ledger entry covers it),
 * unexplained (nothing does — a finding), and stale ledger entries (they cover
 * nothing that fired — also a finding, from the other side).
 *
 * A `"native-missing"` row is refused unless its `messageId` is the literal
 * string `"node"` or `"edge"` — never a real rule `messageId`. `"native-missing"`
 * on a rule-verdict difference means the Nx-graph-based run reported a
 * boundary violation the native provider did not reproduce: exactly a missed
 * violation, and a ledger row is a human saying "this difference is fine" —
 * verified against a real run: a row carrying
 * `messageId: "noRelativeOrAbsoluteImportsAcrossLibraries"` explained away a
 * genuinely silenced verdict difference this way. `AGENTS.md`'s invariant
 * ("an empty result is a claim, not a shrug") does not admit an exception for
 * "a human agreed the empty result was fine" on a rule verdict specifically,
 * so this refuses the row rather than trusting its `reason`. A `"node"`/`"edge"`
 * `messageId` stays ledgerable — those are structural (a project or an edge
 * the native model does not reproduce), not a rule going silent on real
 * input.
 *
 * @param {string} treeName
 * @param {{direction: string, messageId: string, site: string}[]} differences
 * @param {readonly object[]} ledger
 * @returns {{explained: object[], unexplained: object[], stale: object[]}}
 * @throws {Error} on a `"native-missing"` row whose `messageId` is not `"node"`
 *   or `"edge"`.
 */
export function classifyDifferences(treeName, differences, ledger) {
  const entries = ledger.filter((entry) => entry.tree === treeName);
  for (const entry of entries) {
    if (
      entry.direction === "native-missing" &&
      entry.messageId !== "node" &&
      entry.messageId !== "edge"
    ) {
      throw new Error(
        `differential-real-trees: ledger row for ${entry.tree} (${entry.sitePattern}) explains a ` +
          `"native-missing" difference with messageId ${JSON.stringify(entry.messageId)} — a ` +
          `native-missing row may only cover a missing "node" or "edge", never a missing rule ` +
          `verdict, because that would let a ledger row silence a real missed boundary violation ` +
          `(../AGENTS.md's invariant: an empty result is a claim, not a shrug).`,
      );
    }
  }
  const fired = new Set();
  const explained = [];
  const unexplained = [];
  for (const difference of differences) {
    const entry = entries.find(
      (candidate) =>
        candidate.direction === difference.direction &&
        candidate.messageId === difference.messageId &&
        new RegExp(candidate.sitePattern, "u").test(difference.site),
    );
    if (entry) {
      fired.add(entry);
      explained.push({ difference, entry });
    } else {
      unexplained.push(difference);
    }
  }
  return { explained, unexplained, stale: entries.filter((entry) => !fired.has(entry)) };
}

/**
 * The empty-verdict claim, checked. On a tree measured to contain violations,
 * an engine answering zero has not found a clean tree — it has stopped
 * looking, and two engines both answering zero would otherwise count as
 * perfect agreement. Each breach names the engine that went silent.
 *
 * The engine set is not fixed at two: the native leg (§3 below) calls this
 * with `{native, tool}` — `reportNativeLeg`'s own doc comment calls it "the
 * empty-verdict claim extended to a third engine" — so the type here is any
 * named set of counts, keyed by whatever a caller calls its engines, rather
 * than a shape that would need a THIRD sibling type the day a fourth engine
 * exists.
 *
 * @param {{name: string, sha: string, expectViolations: boolean}} tree
 * @param {Record<string, number>} verdictCounts
 * @returns {string[]}
 */
export function emptyVerdictBreaches(tree, verdictCounts) {
  if (!tree.expectViolations) return [];
  const breaches = [];
  for (const [engine, count] of Object.entries(verdictCounts)) {
    if (count === 0) {
      breaches.push(
        `${tree.name}: ${engine} reported ZERO verdicts on a tree measured to contain ` +
          `violations at ${tree.sha} — that is a silent engine, not a clean tree.`,
      );
    }
  }
  return breaches;
}

/**
 * Derives a `lattice.json`-equivalent native project model from the SAME
 * `nx graph --file=` output the existing leg already fetched — mechanically,
 * one `projects.declared` row per Nx node, never hand-authored, so what gets
 * measured is the native provider's discovery-plus-graph pipeline rather than
 * this script's own knowledge of the tree.
 *
 * `type` is read through `nodeTypeOf` — the native provider's own `-e2e`
 * suffix rule, applied to `data.projectType` — rather than the Nx graph
 * node's own already-computed top-level `type`, so every field in the derived
 * model traces to a field `lattice.json` itself would carry
 * (`../docs/reference/configuration.md`). No `projects.infer`, no `projectRules`: the
 * declared list is exhaustive — "Omitting this key entirely means the
 * declared list is exhaustive" (same document) — the one shape whose meaning
 * is unambiguous, so nothing is left for an inference rule to backfill or
 * disagree about.
 *
 * `root` is renormalised, not passed through: Nx spells the workspace-root
 * project's root `"."`, and `lattice.json`'s own dialect rejects exactly that
 * spelling by name — `''` names the workspace root there
 * (`../packages/lattice/src/providers/native/model.mjs`'s
 * `declaredProjectViolations`, and `../docs/reference/configuration.md`).
 * Found by running this leg against a real tree rather than by reading:
 * `code-pushup` at its pinned commit carries a root-level project, and the
 * first real run turned that into a native-leg infrastructure failure — the
 * derivation is meant to measure the provider's fidelity, not fail on a
 * spelling difference between two config dialects that both mean "the
 * workspace root".
 *
 * @param {{nodes: Record<string, {name: string, data: {root: string, projectType?: string, tags?: string[], implicitDependencies?: string[]}}>}} graph
 * @returns {{projects: {declared: object[]}}}
 */
export function deriveNativeModel(graph) {
  const declared = Object.values(graph.nodes).map((node) => ({
    root: node.data.root === "." ? "" : node.data.root,
    name: node.name,
    type: nodeTypeOf(node.name, node.data.projectType),
    tags: node.data.tags ?? [],
    implicitDependencies: node.data.implicitDependencies ?? [],
  }));
  return { projects: { declared } };
}

/**
 * Field-level divergence between two graph nodes the name-only comparison in
 * `differential-real-trees-child.mjs` already knows exist on BOTH sides. That
 * comparison only sees a node present on one side and not the other; a name
 * present on both can still carry a `root`, `type` or `tags` the native leg
 * reproduced wrong, invisible to a set-of-names diff. Exported here — rather
 * than left inline in the child script — so it is unit-testable without the
 * real tree and child process the rest of the native leg needs
 * (`differential-real-trees-child.mjs`'s own header explains why that file
 * cannot be imported for a network-free test: its top-level code runs
 * immediately on import and asserts a real `NX_WORKSPACE_ROOT_PATH`).
 *
 * Tags are compared sorted: `deriveNativeModel` and the native provider have
 * no contract to agree on array order, so an order-only difference is not a
 * real divergence and must not report as one.
 *
 * `messageId` stays the literal `"node"` — the same literal
 * `classifyDifferences` already requires of every `"native-missing"` row —
 * and `direction` is always `"native-extra"`: the node is not missing on
 * either side, so a value mismatch is native's OWN divergent value, the same
 * "this leg produced something the other side does not have" meaning
 * `native-extra` already carries for node/edge SET membership, extended here
 * to field VALUE equality on a member both sides agree exists.
 *
 * @param {string} name
 * @param {{root: string, type: string, tags?: string[]}} nxFields
 * @param {{root: string, type: string, tags?: string[]}} nativeFields
 * @returns {{direction: string, messageId: string, site: string}[]}
 */
export function nodeFieldDifferences(name, nxFields, nativeFields) {
  const sortedTags = (tags) => JSON.stringify([...(tags ?? [])].sort());
  const differences = [];
  if (nxFields.root !== nativeFields.root) {
    differences.push({ direction: "native-extra", messageId: "node", site: `${name}#root` });
  }
  if (nxFields.type !== nativeFields.type) {
    differences.push({ direction: "native-extra", messageId: "node", site: `${name}#type` });
  }
  if (sortedTags(nxFields.tags) !== sortedTags(nativeFields.tags)) {
    differences.push({ direction: "native-extra", messageId: "node", site: `${name}#tags` });
  }
  return differences;
}

/**
 * The derived-model floor, checked independently of the ledger: a derivation
 * that silently produced an empty or near-empty model would make every node,
 * edge and verdict comparison in the native leg vacuously agree — the same
 * failure shape `emptyVerdictBreaches` guards on the verdict side, applied
 * here to the model itself, before any comparison runs. Never ledgerable, for
 * the same reason an empty-verdict breach is not: a ledger entry silences a
 * DIFFERENCE with a stated reason, not a run that stopped looking.
 *
 * @param {{name: string, sha: string, expectedNativeProjects: number}} tree
 * @param {number} derivedProjectCount
 * @returns {string[]}
 */
export function nativeProjectCountBreach(tree, derivedProjectCount) {
  if (derivedProjectCount >= tree.expectedNativeProjects) return [];
  return [
    `${tree.name}: the derived lattice.json declared only ${derivedProjectCount} project(s) at ` +
      `${tree.sha}, fewer than the ${tree.expectedNativeProjects} measured for this pinned ` +
      `commit — that is a derivation that stopped looking, not a smaller tree.`,
  ];
}

/**
 * One tree's outcome, reduced to the three states the exit code can express.
 *
 * @param {{infrastructure?: string, unexplained: object[], stale: object[],
 *   breaches: string[]}} outcome
 * @returns {"infrastructure"|"findings"|"ok"}
 */
export function treeVerdict({ infrastructure, unexplained, stale, breaches }) {
  if (infrastructure) return "infrastructure";
  if (unexplained.length > 0 || stale.length > 0 || breaches.length > 0) return "findings";
  return "ok";
}

/**
 * The whole run's exit code. Infrastructure outranks findings: when any tree
 * could not be looked at, the run's verdict is incomplete and must not read as
 * "looked everywhere, found these findings".
 *
 * @param {("infrastructure"|"findings"|"ok")[]} verdicts
 * @returns {number}
 */
export function overallExit(verdicts) {
  if (verdicts.includes("infrastructure")) return EXIT.error;
  if (verdicts.includes("findings")) return EXIT.findings;
  return EXIT.ok;
}

/** An infrastructure-class failure: the run could not look, distinct from a finding. */
class InfrastructureError extends Error {}

/**
 * Runs a child process from an ARGUMENT ARRAY (`AGENTS.md`'s child-process
 * rule; nothing here is interpolated into a shell) with output passed through,
 * and throws the infrastructure class on any non-zero exit.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {string} cwd
 * @param {Record<string, string|undefined>} [extraEnv]
 */
function run(file, args, cwd, extraEnv = {}) {
  const result = spawnSync(file, args, {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...environmentForTree(process.env), ...extraEnv },
  });
  if (result.error) {
    throw new InfrastructureError(`${file} ${args.join(" ")}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new InfrastructureError(`${file} ${args.join(" ")} exited ${result.status}`);
  }
}

/** Like `run`, but captures stdout for a value the caller checks. */
function capture(file, args, cwd) {
  const result = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    env: environmentForTree(process.env),
  });
  if (result.error || result.status !== 0) {
    throw new InfrastructureError(
      `${file} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/**
 * Clones, installs and measures one tree; returns the child's report plus the
 * clone directory (kept on failure so the evidence is inspectable).
 *
 * @param {(typeof TREES)[number]} tree
 * @param {string} workdir Empty directory this run owns.
 * @returns {object} The child process's JSON report.
 */
function measureTree(tree, workdir) {
  const treeRoot = join(workdir, "tree");
  const graphPath = join(workdir, "graph.json");
  const resultPath = join(workdir, "result.json");

  console.log(`\n=== ${tree.name} — ${tree.url} @ ${tree.sha} (${tree.license}) ===`);
  run("git", ["init", "--quiet", treeRoot], workdir);
  run("git", ["fetch", "--quiet", "--depth", "1", tree.url, tree.sha], treeRoot);
  run("git", ["checkout", "--quiet", "--detach", tree.sha], treeRoot);
  const head = capture("git", ["rev-parse", "HEAD"], treeRoot);
  if (head !== tree.sha) {
    throw new InfrastructureError(`${tree.name}: cloned HEAD is ${head}, pinned sha ${tree.sha}`);
  }
  console.log(`cloned at ${head}`);

  console.log(`installing: ${tree.install.join(" ")}`);
  run(tree.install[0], tree.install.slice(1), treeRoot);

  const nxBin = join(treeRoot, "node_modules", ".bin", "nx");
  if (!existsSync(nxBin)) {
    throw new InfrastructureError(`${tree.name}: install produced no node_modules/.bin/nx`);
  }
  // The tree's own nx computes the graph. `--file=` writes OUTSIDE the clone so
  // the graph JSON can never appear in the tree's own file listing.
  run(process.execPath, [nxBin, "graph", `--file=${graphPath}`], treeRoot, {
    NX_DAEMON: "false",
  });
  if (!existsSync(graphPath)) {
    throw new InfrastructureError(`${tree.name}: nx graph exited 0 but wrote no ${graphPath}`);
  }

  run(
    process.execPath,
    [
      join(repoRoot, "scripts", "differential-real-trees-child.mjs"),
      treeRoot,
      tree.configFile,
      graphPath,
      resultPath,
    ],
    treeRoot,
    { NX_WORKSPACE_ROOT_PATH: treeRoot, NX_DAEMON: "false" },
  );
  if (!existsSync(resultPath)) {
    throw new InfrastructureError(`${tree.name}: the engine child exited 0 but wrote no report`);
  }
  return JSON.parse(readFileSync(resultPath, "utf8"));
}

/**
 * The native leg's own report section: node-set, edge-set and verdict
 * comparisons against the Nx-graph-based run, classified through the SAME
 * `classifyDifferences`/`LEDGER` mechanism the upstream-vs-tool leg uses
 * (`"native-extra"`/`"native-missing"` directions), plus the derived-model
 * floor and the empty-verdict claim extended to a third engine.
 *
 * @param {(typeof TREES)[number]} tree
 * @param {object|undefined} native The child's `native` report. Every real
 *   child process writes this field — either the report or
 *   `{infrastructureError}` (`scripts/differential-real-trees-child.mjs`'s
 *   own try/catch around the native leg). An `undefined` value reaching here
 *   is therefore itself an infrastructure defect — the child's report is
 *   malformed — and is reported as one below rather than read as "this tree
 *   has no native leg" and skipped.
 * @param {number} toolVerdictCount So the empty-verdict claim can compare all
 *   three engines at once rather than the native leg alone.
 * @returns {{infrastructure?: string, unexplained: object[], stale: object[], breaches: string[]}}
 */
export function reportNativeLeg(tree, native, toolVerdictCount) {
  if (!native) {
    const infrastructure =
      `${tree.name}: the child process report carries no "native" field — the native leg did ` +
      `not run, or wrote a malformed report. Treated as could-not-look, never as a clean leg.`;
    console.error(`NATIVE LEG INFRASTRUCTURE FAILURE for ${tree.name}: ${infrastructure}`);
    return { infrastructure, unexplained: [], stale: [], breaches: [] };
  }
  if (native.infrastructureError) {
    console.error(
      `NATIVE LEG INFRASTRUCTURE FAILURE for ${tree.name}: ${native.infrastructureError}`,
    );
    return { infrastructure: native.infrastructureError, unexplained: [], stale: [], breaches: [] };
  }

  const { counts, differences, derivedProjectCount, discoveryFailureCount } = native;
  // `discoveryFailureCount` is informational, not gated: it is
  // `nativeProvider.discover`'s combined manifest-read failures and unclaimed
  // (uncovered) files (`packages/lattice/src/providers/native/index.mjs`'s
  // `discover`), and `deriveNativeModel` above never emits a `coverage.exempt`
  // list for the derived model — every file the tree's own real
  // `lattice.json` would have exempted is, here, simply unclaimed. Nothing
  // bounds this number for that reason; it is printed for a reader's
  // context, never compared against a floor or ceiling the way
  // `derivedProjectCount` and the verdict counts are.
  console.log(
    `native: derived ${derivedProjectCount} project(s) (floor ${tree.expectedNativeProjects}), ` +
      `${discoveryFailureCount} unclaimed/failed file(s) (informational, uncapped — see comment), ` +
      `${counts.nodes} nodes, ${counts.edges} edges, ${counts.verdicts} verdicts`,
  );

  // Scoped to this leg's own directions before classifying —
  // `scopeLedgerToDirections`'s own doc explains why an unscoped `LEDGER`
  // would mark every upstream-vs-tool entry stale here.
  const { explained, unexplained, stale } = classifyDifferences(
    tree.name,
    differences,
    scopeLedgerToDirections(LEDGER, DIRECTIONS.native),
  );
  const breaches = [
    ...nativeProjectCountBreach(tree, derivedProjectCount),
    ...emptyVerdictBreaches(tree, { native: counts.verdicts, tool: toolVerdictCount }),
  ];
  for (const { difference, entry } of explained) {
    console.log(
      `native explained ${difference.direction} ${difference.messageId} @ ${difference.site}`,
    );
    console.log(`  ledger: ${entry.reason}`);
  }
  for (const difference of unexplained) {
    console.log(
      `NATIVE UNEXPLAINED ${difference.direction} ${difference.messageId} @ ${difference.site}`,
    );
  }
  for (const entry of stale) {
    console.log(
      `STALE native ledger entry: ${entry.direction} ${entry.messageId} ${entry.sitePattern} no ` +
        `longer fires — remove it or say what changed.`,
    );
  }
  for (const breach of breaches) console.log(`NATIVE BREACH: ${breach}`);
  return { unexplained, stale, breaches };
}

/** Prints one tree's report and returns its outcome for the exit decision. */
function reportTree(tree, result) {
  const { counts, versions, differences, agreements } = result;
  console.log(
    `files: ${counts.tracked} tracked, ${counts.owned} owned by projects, ` +
      `${counts.analyzed} analyzed by this engine, ${counts.upstreamReadable} linted by upstream`,
  );
  console.log(
    `engines: @nx/eslint-plugin ${versions.plugin}, eslint ${versions.eslint}, ` +
      `node ${versions.node} (all pinned by this repository's lockfile)`,
  );
  console.log(
    `verdicts: upstream ${counts.upstreamVerdicts}, this engine ${counts.toolVerdicts}, ` +
      `agreeing ${agreements}`,
  );
  if (counts.analysisFailures > 0) {
    console.log(
      `analysis failures (this engine's could-not-look records, not verdicts): ` +
        `${counts.analysisFailures} — e.g. ${result.analysisFailureSample.join("; ")}`,
    );
  }
  // Every upstream verdict, so a reader can see WHAT agreed rather than only
  // how much; any verdict the engines disagree on reappears in the difference
  // lines below.
  for (const verdict of result.upstreamVerdicts) {
    console.log(`  upstream verdict ${verdict.messageId} @ ${verdict.site}`);
  }

  // Scoped to this leg's own directions before classifying, the mirror of
  // `reportNativeLeg`'s scoping below — `scopeLedgerToDirections`'s own doc
  // explains why an unscoped `LEDGER` would mark every native-leg entry stale
  // here.
  const { explained, unexplained, stale } = classifyDifferences(
    tree.name,
    differences,
    scopeLedgerToDirections(LEDGER, DIRECTIONS.upstream),
  );
  const breaches = emptyVerdictBreaches(tree, {
    upstream: counts.upstreamVerdicts,
    tool: counts.toolVerdicts,
  });
  for (const { difference, entry } of explained) {
    console.log(`explained ${difference.direction} ${difference.messageId} @ ${difference.site}`);
    console.log(`  ledger: ${entry.reason}`);
  }
  for (const difference of unexplained) {
    console.log(`UNEXPLAINED ${difference.direction} ${difference.messageId} @ ${difference.site}`);
    if (difference.detail) console.log(`  ${difference.detail}`);
  }
  for (const entry of stale) {
    console.log(
      `STALE ledger entry: ${entry.direction} ${entry.messageId} ${entry.sitePattern} no ` +
        `longer fires — remove it or say what changed.`,
    );
  }
  for (const breach of breaches) console.log(`EMPTY-VERDICT BREACH: ${breach}`);

  // The native leg is reported and classified through the same mechanism
  // above, then merged: `treeVerdict` only needs to know whether ANY
  // dimension of this tree's run failed to look or found a finding, and the
  // console lines already say which leg each one came from.
  const nativeOutcome = reportNativeLeg(tree, result.native, counts.toolVerdicts);
  return {
    infrastructure: nativeOutcome.infrastructure,
    unexplained: [...unexplained, ...nativeOutcome.unexplained],
    stale: [...stale, ...nativeOutcome.stale],
    breaches: [...breaches, ...nativeOutcome.breaches],
  };
}

function main() {
  if (process.argv.length > 2) {
    console.error("usage: node scripts/differential-real-trees.mjs (no arguments)");
    process.exit(EXIT.usage);
  }

  /** @type {("infrastructure"|"findings"|"ok")[]} */
  const verdicts = [];
  for (const tree of TREES) {
    const workdir = mkdtempSync(join(tmpdir(), `lattice-differential-${tree.name}-`));
    let outcome;
    try {
      const result = measureTree(tree, workdir);
      outcome = { infrastructure: undefined, ...reportTree(tree, result) };
      rmSync(workdir, { recursive: true, force: true });
    } catch (error) {
      // Any throw here means the run could not LOOK — clone, install, graph or
      // child failure — which must stay distinct from a difference between
      // engines. The clone is kept for inspection.
      outcome = {
        infrastructure: String(error?.message ?? error),
        unexplained: [],
        stale: [],
        breaches: [],
      };
      console.error(`INFRASTRUCTURE FAILURE for ${tree.name}: ${outcome.infrastructure}`);
      console.error(`clone kept at ${workdir}`);
    }
    verdicts.push(treeVerdict(outcome));
    console.log(`${tree.name}: ${verdicts.at(-1)}`);
  }

  const exit = overallExit(verdicts);
  console.log(
    `\ndifferential over ${TREES.length} real trees: ` +
      (exit === EXIT.ok
        ? "both engines agree everywhere the ledger does not already explain"
        : exit === EXIT.findings
          ? "FINDINGS — see UNEXPLAINED / STALE / EMPTY-VERDICT lines above"
          : "INCOMPLETE — at least one tree could not be measured"),
  );
  process.exit(exit);
}

/**
 * Run-vs-import guard, compared on real paths for the reason
 * `scripts/check-packages.mjs` documents on its own copy: through a symlinked
 * checkout the naive comparison is false and `main()` silently never runs.
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) main();

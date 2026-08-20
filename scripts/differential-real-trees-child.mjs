#!/usr/bin/env node
// The per-tree half of `scripts/differential-real-trees.mjs`: runs BOTH
// boundary engines over one cloned workspace and writes a JSON report. Spawned
// once per tree, never called twice in one process, because `@nx/devkit`
// freezes its `workspaceRoot` at first load from `NX_WORKSPACE_ROOT_PATH` —
// the same one-root-per-process constraint
// `packages/lattice/src/conformance/fixture.mjs` documents for the
// fixture suite. The parent sets that variable and the working directory
// before this file's imports run; both are asserted below rather than trusted,
// because a wrong root here would lint one tree against another tree's graph
// and report the mismatches as engine differences.
//
// The working directory must be the tree root for a second reason, measured:
// real flat configs read files by relative path (code-pushup's
// `eslint.config.js` reads `.node-version` at import time), so importing the
// tree's config from anywhere else throws ENOENT.
//
// Both engines get the SAME inputs — the graph the tree's own nx computed, the
// tree's own constraint table and options, the tracked file list — which is
// the fixture suite's methodology (`src/conformance/README.md`): the subject
// is rule-engine agreement on identical inputs, not graph construction.
//
// The run-vs-import guard at the bottom (`isProgramEntry`) exists so
// `classifyUpstreamNote` and `partitionUpstreamMessages` below can be
// unit-tested by importing this module — every line above that guard used to
// execute unconditionally at import time, including the `process.exit(2)` a
// missing CLI argument triggers, which would kill the test process rather
// than let it assert on the exported functions.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  analyzeWorkspace,
  annotateMFERemotes,
  annotatePackageFacts,
  createWorkspace,
  listTrackedFiles,
} from "../packages/lattice/src/workspace.mjs";
import { evaluate } from "../packages/lattice/src/rules/index.mjs";
import { compareFile } from "../packages/lattice/src/conformance/differential.mjs";
import {
  createUpstreamRunner,
  isUpstreamReadable,
} from "../packages/lattice/src/conformance/engines.mjs";
import { nativeProvider } from "../packages/lattice/src/providers/native/index.mjs";
import {
  deriveNativeModel,
  extractBoundaryRule,
  nodeFieldDifferences,
} from "./differential-real-trees.mjs";

/**
 * What one non-boundary ESLint message means for the file that carries it:
 * `"noise"` — upstream read the file and ran the boundary rule on it, the
 * message is a by-product of linting a real tree under this differential's
 * stripped override config — or `"unreadable"` — upstream could not read the
 * file, so its silence about boundaries there is not a verdict.
 *
 * The split matters because the two directions are not symmetric: counting a
 * noise-only file as unreadable fails a run over messages that impaired
 * nothing (a real tree's sources are full of `eslint-disable` directives
 * naming plugins this override config deliberately does not load), while
 * counting an unreadable file as clean is the silent masquerade — "zero
 * verdicts" on a file nobody parsed reads exactly like "checked, clean".
 *
 * Exactly two shapes are noise, both measured against this repository's own
 * pinned eslint (run through the same `ESLint` API this differential uses; a
 * probe file carrying both shapes plus a configured rule still had that rule
 * fire on it, which is the fact the classification rests on):
 *
 * - `Definition for rule '…' was not found.` — an inline directive names a
 *   rule from a plugin the override config never loaded. `ruleId` is the
 *   missing rule's name, `fatal` is false, and every configured rule still
 *   runs on the file.
 * - `Unused eslint-disable directive …` — the directive reporter, `ruleId`
 *   null, `fatal` false, same measurement.
 *
 * Everything else is `"unreadable"`, fail-closed: a parse error carries
 * `fatal: true` (measured, same probe), and a message shape this function has
 * never seen must surface as a could-not-look to be classified by a human —
 * never absorbed as noise on the guess that it was probably harmless.
 *
 * @param {{ruleId?: string|null, fatal?: boolean, message: string}} message
 * @returns {"noise"|"unreadable"}
 */
export function classifyUpstreamNote(message) {
  if (message.fatal) return "unreadable";
  const hasRuleId = message.ruleId !== null && message.ruleId !== undefined;
  if (hasRuleId && /^Definition for rule '.+' was not found\.$/u.test(message.message)) {
    return "noise";
  }
  if (!hasRuleId && message.message.startsWith("Unused eslint-disable directive")) {
    return "noise";
  }
  return "unreadable";
}

/**
 * Splits upstream's lint results three ways, per workspace-relative file:
 * boundary-rule messages (the comparable verdicts), noise notes, and
 * unreadable notes (`classifyUpstreamNote` is the decider and carries the
 * argument). Pure — results in, three maps out — so the split is testable
 * without a cloned tree or a real ESLint run.
 *
 * A file in `unreadableByFile` must reach the report as a could-not-look
 * record: it never enters `upstreamByFile` (no boundary message can exist on
 * a file the rule never ran over), so without that record the comparison loop
 * would never mention it and its silence would read as agreement — the
 * masquerade this split exists to prevent. `main` below writes the whole list
 * into the child's report, and `reportTree` in
 * `differential-real-trees.mjs` holds its size to the tree's own pinned,
 * measured expectation from both directions.
 *
 * @param {{filePath: string, messages: {ruleId?: string|null, fatal?: boolean, message: string}[]}[]} lintResults
 * @param {string} treeRoot Absolute tree root `filePath`s are made relative to.
 * @returns {{upstreamByFile: Map<string, object[]>, noiseByFile: Map<string, string[]>,
 *   unreadableByFile: Map<string, string[]>}}
 */
export function partitionUpstreamMessages(lintResults, treeRoot) {
  const upstreamByFile = new Map();
  const noiseByFile = new Map();
  const unreadableByFile = new Map();
  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  for (const result of lintResults) {
    const relative = result.filePath.slice(treeRoot.length + 1);
    for (const message of result.messages) {
      if (message.ruleId === "@nx/enforce-module-boundaries") {
        push(upstreamByFile, relative, message);
      } else {
        const target = classifyUpstreamNote(message) === "noise" ? noiseByFile : unreadableByFile;
        push(target, relative, `${message.ruleId ?? "eslint"}: ${message.message}`);
      }
    }
  }
  return { upstreamByFile, noiseByFile, unreadableByFile };
}

async function main() {
  const [treeRoot, configFile, graphPath, resultPath] = process.argv.slice(2);
  if (!treeRoot || !configFile || !graphPath || !resultPath) {
    console.error(
      "usage: differential-real-trees-child.mjs <treeRoot> <configFile> <graphJson> <resultJson>",
    );
    process.exit(2);
  }
  if (process.env.NX_WORKSPACE_ROOT_PATH !== treeRoot) {
    throw new Error(
      `NX_WORKSPACE_ROOT_PATH is ${JSON.stringify(process.env.NX_WORKSPACE_ROOT_PATH)}, not the ` +
        `tree root ${treeRoot} — nx would answer for the wrong workspace.`,
    );
  }
  if (resolve(process.cwd()) !== resolve(treeRoot)) {
    throw new Error(
      `cwd is ${process.cwd()}, not the tree root — the tree's ESLint config reads files by ` +
        "relative path and would resolve them against the wrong directory.",
    );
  }

  // The tree's own law: constraint table and options off its own flat config,
  // last matching entry winning exactly as ESLint binds it.
  // `pathScoped: "bind-tree-wide"` is the one opt-in `extractBoundaryRule`
  // defines, and this differential is the caller shape its doc admits: the
  // extracted table is handed identically to both engines below, so a
  // path-scoped entry's dropped scope is symmetric across them — and the
  // `note` the drop always produces is written into the report rather than
  // discarded, so the run that dropped a scope says so.
  const flatConfig = (await import(pathToFileURL(join(treeRoot, configFile)).href)).default;
  const {
    depConstraints,
    options: treeOptions,
    note: boundaryNote,
  } = extractBoundaryRule(flatConfig, { pathScoped: "bind-tree-wide" });

  // The graph the tree's own nx computed. `nx graph --file=` emits no
  // `externalNodes` (measured against nx 23; `src/analysis/contract.md` records
  // the same for edges), so both engines run with an empty external map — the
  // upstream rule then skips npm-package imports, and the npm-side rules are
  // exercised by the fixture suite instead, where the graph carries them.
  const graph = JSON.parse(readFileSync(graphPath, "utf8")).graph;
  graph.externalNodes ??= {};
  const readTree = (path) => {
    try {
      return readFileSync(join(treeRoot, path), "utf8");
    } catch {
      return null;
    }
  };
  // The fail-closed graph fields both faces of the tool normally fill before
  // judging (`src/workspace.mjs`): without them the stricter rows would fire on
  // every project and drown the comparison in self-inflicted differences.
  annotateMFERemotes(graph.nodes, readTree);
  annotatePackageFacts(graph.nodes, readTree);

  const files = listTrackedFiles(treeRoot);
  const { workspace, filesByProject, owned } = createWorkspace({ root: treeRoot, graph, files });
  const ownedFiles = owned.map((entry) => entry.file);

  // This engine.
  const upstream = await createUpstreamRunner(treeRoot);
  const { depConstraints: _pluginDefaults, ...optionDefaults } = upstream.defaultOptions;
  const options = { ...optionDefaults, ...treeOptions };
  const analysis = analyzeWorkspace(workspace, ownedFiles);
  const toolViolations = evaluate(analysis.imports, graph, {
    depConstraints,
    options,
    suppressions: [],
  });

  // Upstream, over the same files it can read. `projectFileMap` is rebuilt from
  // the same ownership index this engine used, with each project's dependency
  // list taken from the graph — the shape upstream's circular-chain messages
  // read.
  const projectFileMap = {};
  for (const [name, list] of filesByProject) {
    const deps = (graph.dependencies[name] ?? []).map((dep) => [dep.target, dep.type ?? "static"]);
    projectFileMap[name] = list.map((file) => ({ file, deps }));
  }
  const readable = ownedFiles.filter(isUpstreamReadable);
  const lintResults = await upstream.lint(
    { graph, projectFileMap, depConstraints, options },
    readable,
  );

  // Three-way split of everything upstream said: comparable boundary
  // verdicts, harmless directive noise, and could-not-read records —
  // `classifyUpstreamNote`'s own doc carries the measured argument for the
  // split. An unreadable file is DATA here, never a thrown run: the report
  // lists every one, and `reportTree` in `differential-real-trees.mjs` holds
  // the list to the tree's pinned, measured expectation from both directions,
  // so a file upstream failed to read still cannot masquerade as a file
  // upstream read and found clean.
  const { upstreamByFile, noiseByFile, unreadableByFile } = partitionUpstreamMessages(
    lintResults,
    treeRoot,
  );
  let noiseNoteCount = 0;
  for (const notes of noiseByFile.values()) noiseNoteCount += notes.length;

  // Per-file comparison, over every file either engine reported on.
  const toolByFile = new Map();
  for (const violation of toolViolations) {
    if (!toolByFile.has(violation.sourceFile)) toolByFile.set(violation.sourceFile, []);
    toolByFile.get(violation.sourceFile).push(violation);
  }

  let agreements = 0;
  const differences = [];
  const upstreamVerdicts = [];
  for (const file of new Set([...upstreamByFile.keys(), ...toolByFile.keys()])) {
    const upstreamSide = {
      // A file upstream could not read is not readable, whatever its
      // extension says: a `stricter` row on it must carry
      // `upstreamReadable: false`, the same marking the fixture suite gives a
      // language ESLint has no parser for, not a claim that upstream looked
      // and disagreed.
      readable: isUpstreamReadable(file) && !unreadableByFile.has(file),
      messages: upstreamByFile.get(file) ?? [],
      notes: [],
    };
    for (const message of upstreamSide.messages) {
      upstreamVerdicts.push({
        messageId: message.messageId,
        site: `${file}:${message.line}:${message.column}`,
      });
    }
    const comparison = compareFile(file, upstreamSide, toolByFile.get(file) ?? []);
    agreements += comparison.agree.length;
    // `compareFile`'s rows already carry the `file:line:column` site the ledger
    // patterns match on; only the direction is added here.
    for (const row of comparison.stricter) differences.push({ direction: "stricter", ...row });
    for (const row of comparison.weaker) differences.push({ direction: "weaker", ...row });
  }

  // The native leg: does the native provider's edge construction — which
  // DERIVES `dependencies` from import sites rather than receiving them —
  // reproduce Nx's own edges, given a project model equivalent to what Nx
  // already computed for this SAME tree? The model is derived mechanically
  // (`deriveNativeModel`, in `./differential-real-trees.mjs`) from the graph
  // JSON already on disk, never hand-authored, so this measures the provider's
  // discovery-plus-graph pipeline on source nobody here wrote, which is the one
  // thing the fixture suite under `packages/lattice/src/providers/native/`
  // cannot answer — its fixtures were built by someone who knew the answer.
  //
  // Isolated in its own try/catch: a defect in the derived model or the
  // provider must not crash the upstream-vs-tool comparison above, which is
  // unrelated infrastructure. `native.infrastructureError` is promoted to a
  // tree-level infrastructure verdict by `reportNativeLeg` in
  // `./differential-real-trees.mjs`, so it is still loud rather than swallowed.
  let native;
  try {
    const derivedModel = deriveNativeModel(graph);
    // `nativeProvider.discover` reads `lattice.json` through the injected
    // `readFile` — intercepted here rather than written to disk, so the derived
    // model never becomes a tracked file the tree's own tooling could trip on.
    const nativeReadFile = (path) =>
      path === "lattice.json" ? `${JSON.stringify(derivedModel, null, 2)}\n` : readTree(path);
    const discovered = nativeProvider.discover({ root: treeRoot, files, readFile: nativeReadFile });
    const nativeGraph = nativeProvider.buildGraph({ discovered, importSites: analysis.imports });
    // The same fail-closed annotations the Nx-graph-based run gets above —
    // without them every project would look MFE-remote-free and package-less,
    // drowning the comparison in self-inflicted differences rather than real
    // provider ones.
    annotateMFERemotes(nativeGraph.nodes, readTree);
    annotatePackageFacts(nativeGraph.nodes, readTree);
    const nativeViolations = evaluate(analysis.imports, nativeGraph, {
      depConstraints,
      options,
      suppressions: [],
    });

    const nxNodeNames = new Set(Object.keys(graph.nodes));
    const nativeNodeNames = new Set(Object.keys(nativeGraph.nodes));
    const edgeKey = (source, target) => `${source}->${target}`;
    const nxEdges = new Set();
    for (const [source, deps] of Object.entries(graph.dependencies ?? {})) {
      for (const dep of deps) nxEdges.add(edgeKey(source, dep.target));
    }
    const nativeEdges = new Set();
    for (const [source, deps] of Object.entries(nativeGraph.dependencies ?? {})) {
      for (const dep of deps) nativeEdges.add(edgeKey(source, dep.target));
    }
    const asVerdict = (violation) => ({
      messageId: violation.messageId,
      site: `${violation.sourceFile}:${violation.line}:${violation.column}`,
    });
    const toolVerdictList = toolViolations.map(asVerdict);
    const nativeVerdictList = nativeViolations.map(asVerdict);
    const verdictKey = (v) => `${v.messageId}@${v.site}`;
    const toolVerdictKeys = new Set(toolVerdictList.map(verdictKey));
    const nativeVerdictKeys = new Set(nativeVerdictList.map(verdictKey));

    // The name-only diff above only sees a node that exists on one side and not
    // the other; a name present on BOTH sides can still carry a `root`, `type`
    // or `tags` the native leg reproduced wrong — invisible to a set-of-names
    // comparison. `nodeFieldDifferences` (`./differential-real-trees.mjs`) does
    // the actual comparison, pure and unit-tested there; this loop only feeds
    // it each shared project name's fields, renormalising the Nx side's root
    // the same way `deriveNativeModel` already does — Nx spells the
    // workspace-root project's root `"."`, and reporting that translation back
    // as a provider defect would be reporting a config-dialect difference the
    // provider had no hand in.
    const fieldDifferences = [];
    for (const name of nxNodeNames) {
      if (!nativeNodeNames.has(name)) continue; // covered by the native-missing node row above
      const nxNode = graph.nodes[name];
      const nativeNode = nativeGraph.nodes[name];
      const nxRoot = nxNode.data.root === "." ? "" : nxNode.data.root;
      fieldDifferences.push(
        ...nodeFieldDifferences(
          name,
          { root: nxRoot, type: nxNode.type, tags: nxNode.data.tags },
          { root: nativeNode.data.root, type: nativeNode.type, tags: nativeNode.data.tags },
        ),
      );
    }

    // One combined list, in the exact `{direction, messageId, site}` shape
    // `classifyDifferences` already consumes — a node/edge difference's
    // `messageId` is the literal string `"node"`/`"edge"` and its `site` is the
    // node name or the `source->target` edge key rather than a
    // `file:line:column` position. Named `nativeDifferences` rather than
    // `differences` — the outer scope already binds that name to the
    // upstream-vs-tool list above, and shadowing it here read as though this
    // list replaced that one rather than being a second, unrelated list.
    const nativeDifferences = [
      ...[...nativeNodeNames]
        .filter((name) => !nxNodeNames.has(name))
        .map((site) => ({ direction: "native-extra", messageId: "node", site })),
      ...[...nxNodeNames]
        .filter((name) => !nativeNodeNames.has(name))
        .map((site) => ({ direction: "native-missing", messageId: "node", site })),
      ...[...nativeEdges]
        .filter((edge) => !nxEdges.has(edge))
        .map((site) => ({ direction: "native-extra", messageId: "edge", site })),
      ...[...nxEdges]
        .filter((edge) => !nativeEdges.has(edge))
        .map((site) => ({ direction: "native-missing", messageId: "edge", site })),
      ...fieldDifferences,
      ...nativeVerdictList
        .filter((v) => !toolVerdictKeys.has(verdictKey(v)))
        .map((v) => ({ direction: "native-extra", messageId: v.messageId, site: v.site })),
      ...toolVerdictList
        .filter((v) => !nativeVerdictKeys.has(verdictKey(v)))
        .map((v) => ({ direction: "native-missing", messageId: v.messageId, site: v.site })),
    ];

    native = {
      derivedProjectCount: derivedModel.projects.declared.length,
      discoveryFailureCount: discovered.failures.length,
      counts: {
        nodes: nativeNodeNames.size,
        edges: nativeEdges.size,
        verdicts: nativeViolations.length,
      },
      differences: nativeDifferences,
    };
  } catch (error) {
    native = { infrastructureError: String(error?.message ?? error) };
  }

  const pluginManifest = createRequire(import.meta.url)("@nx/eslint-plugin/package.json");
  const eslintManifest = createRequire(import.meta.url)("eslint/package.json");
  let upstreamVerdictTotal = 0;
  for (const list of upstreamByFile.values()) upstreamVerdictTotal += list.length;

  writeFileSync(
    resultPath,
    `${JSON.stringify(
      {
        counts: {
          tracked: files.length,
          owned: ownedFiles.length,
          analyzed: analysis.analyzed,
          importSites: analysis.imports.length,
          analysisFailures: analysis.failures.length,
          upstreamReadable: readable.length,
          upstreamNoiseNotes: noiseNoteCount,
          upstreamUnreadable: unreadableByFile.size,
          upstreamVerdicts: upstreamVerdictTotal,
          toolVerdicts: toolViolations.length,
        },
        versions: {
          plugin: pluginManifest.version,
          eslint: eslintManifest.version,
          node: process.version,
        },
        // The tree's own deliberately-broken files (parser fixtures, mock
        // configs importing built output) land here as could-not-look records —
        // the loud path, never verdicts. A sample keeps the report readable.
        analysisFailureSample: analysis.failures
          .slice(0, 3)
          .map((failure) => `${failure.sourceFile}:${failure.line} ${failure.reason}`),
        // Upstream's own could-not-look records, the FULL list rather than a
        // sample: `reportTree` prints every one and holds the count to the
        // tree's pinned `expectedUpstreamUnreadable`, and a gate cannot hold a
        // sample to a pin.
        upstreamUnreadable: [...unreadableByFile].map(([file, notes]) => ({ file, notes })),
        // The scope-drop record `extractBoundaryRule` produced, if any —
        // `reportTree` prints it, so the drop this run made is in the run's
        // own log rather than only in this file's comments.
        boundaryNote: boundaryNote ?? null,
        upstreamVerdicts,
        toolVerdicts: toolViolations.map((violation) => ({
          messageId: violation.messageId,
          site: `${violation.sourceFile}:${violation.line}:${violation.column}`,
        })),
        agreements,
        differences,
        native,
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Run-vs-import guard, compared on real paths for the reason
 * `scripts/differential-real-trees.mjs`'s own copy documents: through a
 * symlinked checkout the naive comparison is false and `main()` silently
 * never runs. Duplicated rather than imported — the same duplication already
 * stands across `scripts/check-packages.mjs`, `scripts/check-skills.mjs`,
 * `scripts/check-docs-links.mjs`, `scripts/reconcile-differential-issue.mjs`,
 * `scripts/smoke-e2e.mjs` and `scripts/verify-vsix.mjs`.
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

if (isProgramEntry(import.meta.url)) await main();

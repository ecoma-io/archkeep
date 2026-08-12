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

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
const flatConfig = (await import(pathToFileURL(join(treeRoot, configFile)).href)).default;
const { depConstraints, options: treeOptions } = extractBoundaryRule(flatConfig);

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

const upstreamByFile = new Map();
let noteCount = 0;
for (const result of lintResults) {
  const relative = result.filePath.slice(treeRoot.length + 1);
  for (const message of result.messages) {
    if (message.ruleId === "@nx/enforce-module-boundaries") {
      if (!upstreamByFile.has(relative)) upstreamByFile.set(relative, []);
      upstreamByFile.get(relative).push(message);
    } else {
      // Everything else — parse errors, directives naming rules outside this
      // override config — is counted so a tree upstream failed to read cannot
      // masquerade as a tree upstream read and found clean.
      noteCount += 1;
    }
  }
}

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
    readable: isUpstreamReadable(file),
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
        upstreamNotes: noteCount,
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

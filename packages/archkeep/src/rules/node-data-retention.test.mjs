/**
 * Node-data retention across the evidence-snapshot layer — [architecture-test].
 *
 * Every rule in this directory judges on fields it reads off graph nodes
 * (`node.data.*` — `root`, `tags`, `targets`, `mfeRemote`, `entryPoints`,
 * `declaredPackages`, and the external nodes' `packageName`). The `delta`
 * command re-judges a captured BASELINE through the same engine
 * (`../commands/delta.mjs` re-judges both sides via
 * `../rules/index.mjs`'s `evaluateRun`), and the baseline graph is a REBUILT
 * one: the evidence snapshot (`../commands/delta-snapshot.mjs`) is a
 * field-trimming layer — it stores a reduced shape, and
 * `evidenceGraphToProjectGraph` reconstructs each node's `data` from it.
 *
 * A field the rules read but the snapshot layer does not retain is silently
 * absent on the baseline side of a delta run: the base is judged on missing
 * data, a violation that should exist is not produced, and the delta reads
 * clean. That is the cross-surface desync class #844's register names ("an
 * architecture test enumerating both sides would turn a silent desync into a
 * red gate") and the exact silent direction `../../../../AGENTS.md`'s
 * invariant is written against.
 *
 * The two sides are enumerated against each other, so neither can drift
 * unseen:
 *
 *  - the READ side: every `.data.<field>` access in `src/rules/*.mjs`,
 *    extracted from `maskNonCode`-masked source (comments and literals cannot
 *    inject a field);
 *  - the RETAINED side: what survives capture → serialize → parse → rebuild,
 *    measured by punching every extracted field — as a marker — through the
 *    REAL snapshot modules (`buildEvidenceSnapshot` →
 *    `serializeEvidenceSnapshot` → `parseEvidenceSnapshot` →
 *    `evidenceGraphToProjectGraph`).
 *
 * The red direction: a rule starts reading `node.data.<new>` (or a snapshot
 * edit stops retaining a field the rules read) → the extracted set gains a
 * member the round trip drops → this test fails. The behavioral checks pin
 * fields to verdicts through the REBUILT graph, so retention is proven on the
 * judging path, not just on the key list: a banned external import must still
 * fire (tags + declaredPackages + packageName), an MFE remote must still be
 * exempt from `noImportsOfApps` (mfeRemote), and a declared build target must
 * still satisfy `hasBuildExecutor` (targets under the snapshot's name-only
 * storage).
 *
 * External nodes are the one deliberate deviation: the snapshot stores no
 * `externalNodes` at all, and the engine's `externalNodeFor`
 * (`./index.mjs`) synthesises one carrying `data.packageName` at judge time.
 * The test therefore pins the read side of that contract — rules consult
 * external-node data ONLY for `packageName` — and proves the read works
 * end-to-end through the rebuilt graph.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { maskNonCode } from "../intent/mask-non-code.mjs";
import {
  buildEvidenceSnapshot,
  parseEvidenceSnapshot,
  serializeEvidenceSnapshot,
} from "../commands/delta-snapshot.mjs";
import { evidenceGraphToProjectGraph } from "../commands/delta.mjs";
import { evaluateRun } from "./index.mjs";
import { hasBuildExecutor } from "./topology.mjs";

const RULES_DIR = dirname(fileURLToPath(import.meta.url));

/** The production rule modules under scrutiny — never the tests themselves. */
const RULE_FILES = readdirSync(RULES_DIR)
  .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
  .sort();

/** `node.data?.tags`, `externalNodes[...].data.packageName`, … — the field after `.data`. */
const NODE_DATA_ACCESS = /\.data(?:\?\.|\.)([A-Za-z_$][\w$]*)/gu;

/** `const { packageName } = externalProject.data;` — destructures read too. */
const DESTRUCTURED_NODE_DATA_ACCESS =
  /\{\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*[A-Za-z_$][\w$]*\.data\b/gu;

/** Accesses through a node explicitly named external. */
const EXTERNAL_NODE_DATA_ACCESS =
  /(?:externalNode|externalProject)s?\.data(?:\?\.|\.)([A-Za-z_$][\w$]*)|externalNodes\[[^\]]*\]\.data(?:\?\.|\.)([A-Za-z_$][\w$]*)/gu;

/**
 * The `.data.<field>` names every rule module reads, and the subset read off
 * external nodes. Extracted from masked source so comments and literals
 * cannot contribute a field.
 */
function extractedRuleDataFields() {
  /** @type {Set<string>} */
  const fields = new Set();
  /** @type {Set<string>} */
  const externalFields = new Set();
  for (const file of RULE_FILES) {
    const code = maskNonCode(readFileSync(join(RULES_DIR, file), "utf-8"));
    for (const m of code.matchAll(NODE_DATA_ACCESS)) fields.add(m[1]);
    for (const m of code.matchAll(DESTRUCTURED_NODE_DATA_ACCESS)) fields.add(m[1]);
    for (const m of code.matchAll(EXTERNAL_NODE_DATA_ACCESS)) externalFields.add(m[1] ?? m[2]);
  }
  return { fields, externalFields };
}

/**
 * A marker value for one field, shaped so the snapshot layer accepts it:
 * structural fields keep their real shapes, a field the layer has never heard
 * of gets a string marker — and if the round trip drops it, the retention
 * assertion below goes red.
 */
function markerValue(field, name) {
  switch (field) {
    case "root":
      return `libs/${name}`;
    case "tags":
      return ["zone:alpha"];
    case "targets":
      return { build: { executor: "archkeep:declared" } };
    case "entryPoints":
      return ["src/index.ts"];
    case "declaredPackages":
      return ["vendor"];
    case "mfeRemote":
      return true;
    case "packageName":
      return "vendor";
    default:
      return `marker:${field}`;
  }
}

/** One project node carrying every extracted field as its marker shape. */
function markerNode(name, fields, type) {
  const data = {};
  for (const field of fields) data[field] = markerValue(field, name);
  return { name, type, data };
}

/**
 * The full evidence-snapshot round trip the `delta` compare mode performs on
 * its baseline: capture → serialize → parse → rebuild. Returns the graph
 * `evaluateRun` would judge the baseline side on.
 */
function roundTrippedGraph(fields) {
  const snapshot = buildEvidenceSnapshot({
    tool: { name: "archkeep", version: "0.0.0-architecture-test" },
    provider: "native",
    provenance: null,
    policyFingerprint: "fp-architecture-test",
    coverage: { complete: true, analyzedFiles: 1, notAnalyzed: [], blindSpots: [] },
    graph: {
      nodes: {
        alpha: markerNode("alpha", fields, "lib"),
        app1: markerNode("app1", fields, "app"),
      },
      dependencies: {},
    },
    records: [],
  });
  const text = serializeEvidenceSnapshot(snapshot);
  const parsed = parseEvidenceSnapshot(text, "/architecture-test.json");
  return evidenceGraphToProjectGraph(parsed.graph);
}

/** All eight options at the values `@nx/enforce-module-boundaries` defaults to. */
const options = (overrides = {}) => ({
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
  ...overrides,
});

const config = (depConstraints, optionOverrides = {}) => ({
  depConstraints,
  options: options(optionOverrides),
});

/** A record importing `@fixture/app1`, resolved to project `app1`. */
const record = (overrides = {}) => {
  const specifier = overrides.specifier ?? "@fixture/app1";
  return {
    sourceFile: "libs/alpha/src/index.ts",
    line: 3,
    column: 1,
    kind: "static",
    spelling: { path: false, relative: false, namesOnly: false },
    resolved: { target: "app1", file: "apps/app1/src/main.ts", external: false, packageName: null },
    ...overrides,
    specifier,
  };
};

/** A record importing an external package, resolved outside every project. */
const externalRecord = (packageName) =>
  record({
    specifier: packageName,
    resolved: { target: null, file: null, external: true, packageName },
  });

describe("rule node-data fields survive the evidence-snapshot round trip [architecture-test]", () => {
  const { fields, externalFields } = extractedRuleDataFields();
  const roundTripped = roundTrippedGraph(fields);

  it("extracts the data fields the rules really read — a broken scan cannot pass silently", () => {
    // Empty result would make every retention assertion below vacuous. The
    // known roster pins the scanner to the real accesses.
    expect(fields.size).toBeGreaterThan(0);
    expect([...fields]).toEqual(
      expect.arrayContaining([
        "root",
        "tags",
        "targets",
        "mfeRemote",
        "entryPoints",
        "declaredPackages",
        "packageName",
      ]),
    );
  });

  it("retains every rule-read node-data field through capture → serialize → parse → rebuild", () => {
    const rebuiltData = roundTripped.nodes.alpha.data;
    const projectFields = [...fields].filter((f) => f !== "packageName");
    // The silent direction this suite exists to pin: a field a rule reads but
    // the snapshot layer drops as absent on the baseline side of a delta run.
    expect(Object.keys(rebuiltData)).toEqual(expect.arrayContaining(projectFields));
  });

  it("consults external-node data only for packageName — the one field the engine synthesises", () => {
    // External nodes are NOT stored in the snapshot; the engine's
    // `externalNodeFor` synthesises one carrying `data.packageName` at judge
    // time. A rule reading any OTHER external field would be reading data no
    // baseline side of a delta run can ever produce.
    expect([...externalFields]).toEqual(["packageName"]);
  });

  it("a banned external import still fires on the rebuilt graph — no false clean (tags + declaredPackages + packageName)", () => {
    const violations = evaluateRun(
      [externalRecord("vendor")],
      roundTripped,
      config([{ sourceTag: "zone:alpha", bannedExternalImports: ["vendor"] }], {
        banTransitiveDependencies: true,
      }),
    ).rawViolations;
    // Exactly the ban: `tags` retained (the row matches alpha), `packageName`
    // served (the vendor package resolves), `declaredPackages` retained
    // (vendor is a declared direct dependency, so noTransitiveDependencies
    // must not fire on top).
    expect(violations.map((v) => v.messageId)).toEqual(["bannedExternalImportsViolation"]);
    expect(violations[0].targetProject).toBe("npm:vendor");
  });

  it("an MFE remote stays exempt from noImportsOfApps on the rebuilt graph (mfeRemote)", () => {
    const violations = evaluateRun([record()], roundTripped, config([])).rawViolations;
    // app1 carries `mfeRemote: true`; if the snapshot layer dropped the
    // field, `appIsMFERemote` would read false and noImportsOfApps would fire
    // over a workspace whose exemption survived capture.
    expect(violations.map((v) => v.messageId)).toEqual([]);
  });

  it("a declared build target still satisfies hasBuildExecutor on the rebuilt graph (targets)", () => {
    // The snapshot stores target NAMES only; the rebuild turns each into {}
    // (`../commands/delta.mjs`). `hasBuildExecutor` reads
    // `targets[t].executor !== ""` — true for {} — so the declared "build"
    // target must still count. A dropped `targets` field flips this false.
    expect(
      hasBuildExecutor({ name: "alpha", type: "lib", data: roundTripped.nodes.alpha.data }, [
        "build",
      ]),
    ).toBe(true);
  });
});

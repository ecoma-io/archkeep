/**
 * The evidence snapshot: what a future `delta <base.json>` run consumes as its
 * baseline.
 *
 * The snapshot stores EVIDENCE, not verdicts. A baseline that stored "which
 * violations existed at base" would be judged under the law and the clock of
 * the moment it was captured, so a policy edit or a waiver expiring between
 * base and head would fabricate classifications: a violation introduced by a
 * policy tightening would read as "introduced by the code", and one whose
 * waiver lapsed would read as "resolved" when it is live again. So the
 * snapshot carries the raw import-site records (`../analysis/contract.md`),
 * the graph they were collected against, and the coverage facts that say how
 * complete the look was — everything `../rules/index.mjs`'s
 * `evaluate(sites, graph, config)` needs to re-judge the base under the CURRENT
 * config at delta time. Both sides are then judged under ONE law and ONE
 * shared reference instant, and only the code can move a classification.
 *
 * The format has its own `schemaVersion`, independent of the report envelope's:
 * this file is read back by `parseEvidenceSnapshot` alone, never by the report
 * renderers, and the two formats will evolve on different clocks.
 *
 * ## The two OPTIONAL blocks, and why the version stays 1
 *
 * `customRules` (the declared rows: name, artifact, sha256, params) and
 * `owned` (the workspace's file→project ownership map) are stored only when
 * the capturing policy declares `customRules` — a workspace that declares
 * none produces byte-identical snapshots before and after this addition, and
 * a reader of version 1 that predates the blocks ignores keys it never asks
 * for. Both are evidence in the same sense the records are: the rows are what
 * lets a compare run say whether the custom LAW moved between capture and
 * head (digest or params drift), and `owned` is what lets the base-side
 * evidence bundle attribute each stored record — ownership is the workspace
 * layer's answer (`../workspace.mjs`) and cannot be re-derived from a graph
 * that may have changed since. A baseline WITHOUT the blocks is still legal
 * (an old capture, or one whose policy declared no rules); downstream every
 * custom finding then classifies `unknown` with a re-capture reason rather
 * than the blocks' absence reading as "no custom rules existed at base".
 *
 * ## Purity seam
 *
 * Everything decidable is pure: `buildEvidenceSnapshot` takes already-resolved
 * records as arguments, `serializeEvidenceSnapshot` takes the snapshot object,
 * and `parseEvidenceSnapshot` takes text. Only `readEvidenceSnapshot` touches
 * the filesystem, and its read function is injectable — the same separation
 * `./history.mjs` draws between `readSnapshots` and `computeEvolution`
 * (`../../../../AGENTS.md`: gate logic takes its facts as arguments).
 */
import { readFileSync } from "node:fs";

import { canonicalJsonReplacer } from "../canonical.mjs";
import { isPlainObject } from "../values.mjs";
import { buildDependencies, buildProjects } from "./graph.mjs";

/** The only snapshot schemaVersion this module writes and reads. */
export const EVIDENCE_SNAPSHOT_SCHEMA_VERSION = 1; // used by its own test

/**
 * Builds the snapshot object from already-captured evidence.
 *
 * Every argument is a fact the caller already resolved — provenance from
 * `./provenance.mjs`'s `resolveProvenance`, the fingerprint from
 * `./graph.mjs`'s `computePolicyFingerprint`, the graph in Nx's shape, and the
 * analysis envelope's `imports` array. Nothing here reads a file, spawns a
 * process, or consults a clock, so a test drives capture without mocks.
 *
 * The graph is normalized through `buildProjects`/`buildDependencies` — the
 * exact functions the `graph` command serializes with — so a snapshot's graph
 * section cannot drift from what `graph --format json` publishes for the same
 * tree. Three rule-relevant fields `buildProjects` strips for the public graph
 * contract are re-attached here when the node declares them
 * (`mfeRemote`, `entryPoints`, `declaredPackages`): `evaluate()` reads each,
 * and a re-judge against a project row missing one would fabricate or silence
 * verdicts — `declaredPackages` absent reads as "depends directly on nothing",
 * which turns transitive-dependency violations on and off by omission. This
 * snapshot exists to be re-judged from; it stores what judging reads.
 *
 * @param {object} input
 * @param {{name: string, version: string}} input.tool The tool that captured
 *   the snapshot, named so a reader can tell which engine produced the bytes.
 * @param {{commit: string, remote: string|null, dirty: boolean}|null}
 *   input.provenance From `resolveProvenance`; `null` is carried as an explicit
 *   "no origin claim" rather than dropped.
 * @param {string} input.provider The project-model provider that built the
 *   graph ("nx", "native", "moon").
 * @param {string} input.policyFingerprint From `computePolicyFingerprint`.
 * @param {{complete: boolean, analyzedFiles: number, notAnalyzed: object[],
 *   blindSpots: object[]}} input.coverage The coverage summary, partitioned
 *   exactly as `./graph.mjs` partitions analysis failures.
 * @param {{nodes: object, dependencies: object, workspaceLayout?: object,
 *   exemptedFiles?: string[]}} input.graph The project graph in Nx's shape.
 * @param {object[]} input.records The raw import-site records — the analysis
 *   envelope's `imports` array verbatim (`../analysis/contract.md`), including
 *   the `resolved: null` rows.
 * @param {{name: string, artifact: string, sha256: string,
 *   params?: Record<string, any>}[]} [input.customRules] The declared
 *   custom-rule rows, when the capturing policy declares any — see the header's
 *   optional-blocks section. Omitted means "the capturing policy declared no
 *   custom rules", and the snapshot carries no key at all.
 * @param {{file: string, project: string}[]} [input.owned] The ownership map,
 *   required exactly when `customRules` is given: the base-side evidence
 *   bundle cannot attribute a record without it. Stored sorted by file.
 * @returns {object} The snapshot, ready for `serializeEvidenceSnapshot`.
 * @throws {Error} naming the first piece of required structure that is missing
 *   or malformed — a snapshot built over half-specified evidence would fail
 *   later anyway, and farther from the cause.
 */
export function buildEvidenceSnapshot({
  tool,
  provenance,
  provider,
  policyFingerprint,
  coverage,
  graph,
  records,
  customRules,
  owned,
}) {
  if (!tool || typeof tool.name !== "string" || tool.name === "") {
    throw new Error(
      "archkeep: cannot build an evidence snapshot without a tool name — the snapshot must " +
        "name the engine that captured it",
    );
  }
  if (typeof tool.version !== "string" || tool.version === "") {
    throw new Error(
      "archkeep: cannot build an evidence snapshot without a tool version — a reader could not " +
        "tell which engine revision produced the bytes",
    );
  }
  if (typeof provider !== "string" || provider === "") {
    throw new Error(
      "archkeep: cannot build an evidence snapshot without a provider name — a delta run could " +
        "not tell whether the baseline was read by the same project model it runs under",
    );
  }
  if (typeof policyFingerprint !== "string" || policyFingerprint === "") {
    throw new Error(
      "archkeep: cannot build an evidence snapshot without a policy fingerprint — a delta run " +
        "could not tell whether the boundary law changed between base and head",
    );
  }
  const coverageProblems = describeCoverageProblems(coverage);
  if (coverageProblems.length > 0) {
    throw new Error(
      "archkeep: cannot build an evidence snapshot — the coverage summary is malformed:\n  " +
        coverageProblems.join("\n  "),
    );
  }
  if (!graph || typeof graph !== "object" || typeof graph.nodes !== "object" || !graph.nodes) {
    throw new Error(
      "archkeep: cannot build an evidence snapshot without a project graph with a `nodes` map",
    );
  }
  if (
    typeof graph.dependencies !== "object" ||
    graph.dependencies === null ||
    Array.isArray(graph.dependencies)
  ) {
    throw new Error(
      "archkeep: cannot build an evidence snapshot without the graph's `dependencies` map",
    );
  }
  if (!Array.isArray(records)) {
    throw new Error(
      "archkeep: cannot build an evidence snapshot without the raw analysis records as an array — " +
        "the records are what a delta run re-judges, and without them a baseline is a verdict " +
        "that cannot be re-checked under changed law",
    );
  }
  for (const [index, record] of records.entries()) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(
        `archkeep: analysis record ${index} is ${describe(record)}, not an import-site object — ` +
          "every record must carry the shape src/analysis/contract.md fixes",
      );
    }
  }

  if (customRules !== undefined) {
    const customProblems = describeCustomRuleBlockProblems(customRules, owned);
    if (customProblems.length > 0) {
      throw new Error(
        "archkeep: cannot build an evidence snapshot — the custom-rule evidence is malformed:\n  " +
          customProblems.join("\n  "),
      );
    }
  } else if (owned !== undefined) {
    throw new Error(
      "archkeep: cannot build an evidence snapshot with an `owned` map but no `customRules` " +
        "rows — the map exists to attribute the base side of a custom-rule re-judgment, and " +
        "storing it alone would claim custom-rule evidence the snapshot does not hold",
    );
  }

  const projects = buildProjects(graph.nodes).map((project) => {
    // Re-attach the three rule-relevant fields `buildProjects` strips for the
    // public graph contract. Each is attached only when the node DECLARES it —
    // an absent field stays absent, because `evaluate()` treats absence as
    // "this workspace declares none here", and inventing an empty value would
    // be a second copy of that answer.
    const data = graph.nodes[project.name]?.data ?? {};
    /** @type {Record<string, unknown>} */
    const extras = {};
    if (data.mfeRemote !== undefined) extras.mfeRemote = data.mfeRemote;
    if (Array.isArray(data.entryPoints)) {
      extras.entryPoints = data.entryPoints.slice().sort(cmpString);
    }
    if (Array.isArray(data.declaredPackages)) {
      extras.declaredPackages = data.declaredPackages.slice().sort(cmpString);
    }
    return { ...project, ...extras };
  });

  /** @type {Record<string, unknown>} */
  const storedGraph = { projects, dependencies: buildDependencies(graph.dependencies) };
  if (
    graph.workspaceLayout !== undefined &&
    graph.workspaceLayout !== null &&
    typeof graph.workspaceLayout === "object"
  ) {
    storedGraph.workspaceLayout = graph.workspaceLayout;
  }
  if (Array.isArray(graph.exemptedFiles)) {
    storedGraph.exemptedFiles = graph.exemptedFiles.slice().sort(cmpString);
  }

  /** @type {Record<string, unknown>} */
  const snapshot = {
    schemaVersion: EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
    tool: { name: tool.name, version: tool.version },
    provider,
    provenance,
    policyFingerprint,
    coverage: {
      complete: coverage.complete,
      analyzedFiles: coverage.analyzedFiles,
      notAnalyzed: coverage.notAnalyzed,
      blindSpots: coverage.blindSpots,
    },
    graph: storedGraph,
    records,
  };
  if (customRules !== undefined) {
    // The declared rows, each reduced to the four fields a compare run reads:
    // identity (name), the pinned law (artifact + sha256), and the parameters
    // that ride inside the evidence bundle — params drift is law drift, the
    // same as digest drift. `reason` and the governance block stay out: they
    // explain the row to a human and change no judgment.
    snapshot.customRules = customRules.map((row) => ({
      name: row.name,
      artifact: row.artifact,
      sha256: row.sha256,
      ...(row.params === undefined ? {} : { params: row.params }),
    }));
    // Sorted by file for byte-determinism; `createWorkspace` derives the map
    // from a Set walk whose order is an accident of the file listing.
    snapshot.owned = /** @type {{file: string, project: string}[]} */ (owned)
      .map(({ file, project }) => ({ file, project }))
      .sort((a, b) => cmpString(a.file, b.file));
  }
  return snapshot;
}

/**
 * Renders the snapshot as deterministic JSON text.
 *
 * Deterministic by mechanism, not by constructor discipline: the text is
 * produced through `../canonical.mjs`'s `canonicalJsonReplacer`, which sorts
 * plain-object keys at every depth — the same canonicalizer the graph-snapshot
 * family's `snapshotIdentity` hashes with. That is load-bearing because two of
 * the stored inputs (`records`, `graph.workspaceLayout`) arrive verbatim from
 * upstream code that owns their nested key order; sorting at serialize time is
 * what makes the bytes a function of what the snapshot MEANS. Array element
 * order is the only order the format keeps, and `buildEvidenceSnapshot` sorts
 * every array whose source does not guarantee it. Two captures over one
 * unchanged tree produce byte-identical files, which is what makes a plain
 * `diff` of two baselines meaningful.
 *
 * @param {object} snapshot From `buildEvidenceSnapshot`.
 * @returns {string} The JSON text, newline-terminated.
 */
export function serializeEvidenceSnapshot(snapshot) {
  return `${JSON.stringify(snapshot, canonicalJsonReplacer, 2)}\n`;
}

/**
 * Reads snapshot text from a path — the module's one filesystem seam, kept
 * thin and injectable so tests and embedders drive validation without disk.
 *
 * @param {string} path Absolute path to the snapshot file.
 * @param {{read?: (path: string) => string}} [io] Injectable read; defaults to
 *   a UTF-8 `readFileSync`.
 * @returns {object} Whatever `parseEvidenceSnapshot` returns for the text.
 * @throws {Error} when the file cannot be read, naming the path and the cause,
 *   and whatever `parseEvidenceSnapshot` throws.
 */
export function readEvidenceSnapshot(path, io = {}) {
  const read = io.read ?? ((p) => readFileSync(p, "utf8"));
  let text;
  try {
    text = read(path);
  } catch (cause) {
    throw new Error(
      `archkeep: cannot read the evidence snapshot '${path}': ${cause?.message ?? cause}`,
      { cause },
    );
  }
  return parseEvidenceSnapshot(text, path);
}

/**
 * Parses and validates snapshot text.
 *
 * Pure: text in, validated snapshot out. Every refusal names what is wrong —
 * these become exit-3 ("could not complete") upstream, and a delta run that
 * consumed a malformed baseline silently would classify against nothing while
 * reporting a verdict.
 *
 * Refusals, each loud:
 * - unreadable/malformed JSON — named with the path and the parse error;
 * - a `schemaVersion` that is not the integer this format uses — a FUTURE
 *   version refuses too: a reader that half-understood a newer format would
 *   classify over evidence it misread;
 * - any missing or malformed required section, all named together;
 * - a baseline whose coverage is not complete. An incomplete base did not look
 *   everywhere, so a head-only violation could exist unseen at base — classing
 *   it "introduced" would fabricate a change the code may not contain. The
 *   refusal names how many files went unanalyzed.
 *
 * What is deliberately NOT a refusal: dirty base provenance. A baseline from
 * an uncommitted tree is weaker evidence, not unreadable evidence — the parsed
 * snapshot exposes `provenance.dirty` so the renderer can say so loudly, and
 * classification itself proceeds.
 *
 * @param {string} text The file contents.
 * @param {string} path The path the text came from, for error messages.
 * @returns {object} The validated snapshot.
 * @throws {Error} on every condition above.
 */
export function parseEvidenceSnapshot(text, path) {
  // used by its own test
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `archkeep: the evidence snapshot '${path}' is not valid JSON: ${cause?.message ?? cause}`,
      { cause },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `archkeep: the evidence snapshot '${path}' must be a JSON object, got ${describe(parsed)}`,
    );
  }

  const problems = [];
  if (!Number.isInteger(parsed.schemaVersion)) {
    problems.push(
      `schemaVersion: must be the integer ${EVIDENCE_SNAPSHOT_SCHEMA_VERSION}, got ` +
        `${describe(parsed.schemaVersion)}`,
    );
  } else if (parsed.schemaVersion !== EVIDENCE_SNAPSHOT_SCHEMA_VERSION) {
    // Version 1 is the first version this format ever had, so a larger integer
    // is a future format and a smaller one was never written by any release —
    // the two refusals name different ways out.
    const disposition =
      parsed.schemaVersion > EVIDENCE_SNAPSHOT_SCHEMA_VERSION
        ? "The file was written by a newer version of Archkeep; upgrade to read it."
        : "No release of Archkeep ever wrote that version; re-capture the baseline.";
    throw new Error(
      `archkeep: the evidence snapshot '${path}' has schemaVersion ` +
        `${parsed.schemaVersion}, which this tool does not understand — it understands ` +
        `${EVIDENCE_SNAPSHOT_SCHEMA_VERSION}. ${disposition}`,
    );
  }

  if (!isPlainObject(parsed.tool)) {
    problems.push("tool: must be an object naming the capturing engine");
  } else {
    if (typeof parsed.tool.name !== "string" || parsed.tool.name === "") {
      problems.push("tool.name: must be a non-empty string");
    }
    if (typeof parsed.tool.version !== "string" || parsed.tool.version === "") {
      problems.push("tool.version: must be a non-empty string");
    }
  }

  if (typeof parsed.provider !== "string" || parsed.provider === "") {
    problems.push("provider: must be a non-empty string naming the project-model provider");
  }

  if (parsed.provenance !== null && !isPlainObject(parsed.provenance)) {
    problems.push("provenance: must be an object ({commit, remote, dirty}) or null");
  } else if (isPlainObject(parsed.provenance) && typeof parsed.provenance.commit !== "string") {
    problems.push("provenance.commit: must be a string when provenance is present");
  }

  if (typeof parsed.policyFingerprint !== "string" || parsed.policyFingerprint === "") {
    problems.push(
      "policyFingerprint: must be a non-empty string — without it a delta run cannot tell " +
        "whether the boundary law moved between base and head",
    );
  }

  if (!isPlainObject(parsed.coverage)) {
    problems.push(
      "coverage: must be an object with the capture's coverage summary — a reader could not " +
        "tell how complete the look behind the records was",
    );
  } else {
    // Each shape problem already carries its own `coverage.`-prefixed name;
    // the completeness reason is named first because it decides usability on
    // its own.
    const incomplete = incompleteBaselineCoverageReason(parsed.coverage);
    if (incomplete) problems.push(incomplete);
    problems.push(...describeCoverageProblems(parsed.coverage));
  }

  if (!isPlainObject(parsed.graph)) {
    problems.push("graph: must be an object carrying projects and dependencies");
  } else {
    if (!Array.isArray(parsed.graph.projects)) {
      problems.push("graph.projects: must be an array of project entries");
    } else {
      parsed.graph.projects.forEach((project, index) => {
        if (!isPlainObject(project)) {
          problems.push(`graph.projects[${index}]: must be an object`);
          return;
        }
        if (typeof project.name !== "string" || project.name === "") {
          problems.push(`graph.projects[${index}].name: must be a non-empty string`);
        }
        if (typeof project.root !== "string") {
          problems.push(`graph.projects[${index}].root: must be a string`);
        }
      });
    }
    if (!Array.isArray(parsed.graph.dependencies)) {
      problems.push("graph.dependencies: must be an array of edges");
    } else {
      parsed.graph.dependencies.forEach((edge, index) => {
        if (!isPlainObject(edge)) {
          problems.push(`graph.dependencies[${index}]: must be an object`);
          return;
        }
        for (const field of ["source", "target", "type"]) {
          if (typeof edge[field] !== "string") {
            problems.push(`graph.dependencies[${index}].${field}: must be a string`);
          }
        }
      });
    }
  }

  if (!Array.isArray(parsed.records)) {
    problems.push(
      "records: must be an array of raw import-site records — without them the baseline holds " +
        "nothing a delta run can re-judge under the current law",
    );
  } else {
    parsed.records.forEach((record, index) => {
      if (!isPlainObject(record)) {
        problems.push(`records[${index}]: must be an object per ../analysis/contract.md`);
        return;
      }
      if (typeof record.sourceFile !== "string" || record.sourceFile === "") {
        problems.push(`records[${index}].sourceFile: must be a non-empty string`);
      }
      if (typeof record.specifier !== "string" || record.specifier === "") {
        problems.push(`records[${index}].specifier: must be a non-empty string`);
      }
    });
  }

  // The optional custom-rule pair: absence is a legal old-or-undeclared
  // baseline, presence must be sound — a half-readable block consumed
  // silently would attribute base records against a map that is not one.
  if (parsed.customRules !== undefined) {
    problems.push(...describeCustomRuleBlockProblems(parsed.customRules, parsed.owned));
  } else if (parsed.owned !== undefined) {
    problems.push(
      "owned: present without customRules — the map only exists as custom-rule evidence, and " +
        "half the pair is a snapshot no release ever wrote",
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `archkeep: the evidence snapshot '${path}' is not a usable baseline:\n  ` +
        problems.join("\n  "),
    );
  }
  return parsed;
}

/**
 * Whether the baseline's provider mismatches the current run's, as a reason
 * string — `null` when they agree.
 *
 * Exported rather than folded into `parseEvidenceSnapshot` because the loader
 * sees only the baseline: it cannot know what provider the current run uses.
 * The check takes two records and decides, so the caller wires it where both
 * sides are in hand.
 *
 * A mismatch means the two graphs were built by different project models, so
 * structural differences may be provider artefacts rather than real changes —
 * the same reasoning `./snapshot-meta.mjs` applies between graph snapshots.
 *
 * @param {string} baselineProvider What the snapshot recorded.
 * @param {string} currentProvider What the current run resolved.
 * @returns {string|null} The reason they conflict, or `null`.
 */
export function providerMismatch(baselineProvider, currentProvider) {
  if (baselineProvider === currentProvider) return null;
  return (
    `the baseline was captured under the '${baselineProvider}' provider but this run is using ` +
    `'${currentProvider}' — the two project models may attribute the same tree to different ` +
    `projects, so structural differences may be provider artefacts rather than real changes`
  );
}

/** Describes a value for error messages without dumping it. */
function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/** Plain lexicographic comparison — never localeCompare (byte-determinism). */
function cmpString(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Coverage-shape problems, collected rather than thrown, so capture-time
 * construction and load-time parsing share ONE statement of what coverage is —
 * capture throws on the first, the parser folds every problem into its single
 * refusal. Written once so the two cannot disagree about what coverage is.
 *
 * @param {object} coverage
 * @returns {string[]} One entry per problem, empty when the shape is sound.
 */
function describeCoverageProblems(coverage) {
  const problems = [];
  if (!isPlainObject(coverage)) {
    return [
      "coverage: must be an object with the capture's coverage summary — a reader could not " +
        "tell how complete the look behind the records was",
    ];
  }
  if (typeof coverage.complete !== "boolean") {
    problems.push(
      "coverage.complete: must be a boolean — reading an unstated completeness as either " +
        "answer would claim something the capture never said",
    );
  }
  if (typeof coverage.analyzedFiles !== "number" || !Number.isFinite(coverage.analyzedFiles)) {
    problems.push("coverage.analyzedFiles: must be a finite number");
  }
  if (!Array.isArray(coverage.notAnalyzed) || !Array.isArray(coverage.blindSpots)) {
    problems.push(
      "coverage.notAnalyzed and coverage.blindSpots: both must be arrays — both are always " +
        "arrays in the analysis envelope, and a consumer iterates them without checking",
    );
  }
  return problems;
}

/**
 * Everything wrong with the optional custom-rule evidence pair, as messages —
 * shared by capture-time construction and load-time parsing for the same
 * reason `describeCoverageProblems` is: one statement of what the blocks are.
 *
 * Called only when `customRules` is PRESENT: absence is legal (an old
 * baseline, or a policy that declares none) and is judged by the caller. When
 * the rows are present the `owned` map must be too — a base-side re-judgment
 * without attribution would hand every rule evidence it must refuse, and the
 * time to say so is when the snapshot is built or read, not per rule at
 * compare time.
 *
 * @param {unknown} customRules The stored (or to-be-stored) rule rows.
 * @param {unknown} owned The stored (or to-be-stored) ownership map.
 * @returns {string[]} One entry per problem, empty when both are sound.
 */
function describeCustomRuleBlockProblems(customRules, owned) {
  const problems = [];
  if (!Array.isArray(customRules)) {
    problems.push(
      `customRules: must be an array of declared rule rows when present, got ` +
        `${describe(customRules)}`,
    );
  } else {
    /** @type {Map<string, number>} */
    const firstIndexOfName = new Map();
    customRules.forEach((row, index) => {
      if (!isPlainObject(row)) {
        problems.push(`customRules[${index}]: must be an object, got ${describe(row)}`);
        return;
      }
      for (const field of ["name", "artifact", "sha256"]) {
        if (typeof row[field] !== "string" || row[field] === "") {
          problems.push(`customRules[${index}].${field}: must be a non-empty string`);
        }
      }
      // A duplicate name is a loud refusal, not a last-one-wins: the compare
      // side keys stored rows by name (`./custom-rules.mjs`'s
      // `customRulesForDelta` builds a Map over them), so a second row under
      // one name would silently shadow the first — and which law the delta
      // then matched against would be an accident of row order.
      if (typeof row.name === "string" && row.name !== "") {
        const first = firstIndexOfName.get(row.name);
        if (first !== undefined) {
          problems.push(
            `customRules[${index}].name: duplicates customRules[${first}].name ("${row.name}") — ` +
              `rule names are the identity a delta matches base rows by, and two rows under one ` +
              `name would silently shadow each other`,
          );
        } else {
          firstIndexOfName.set(row.name, index);
        }
      }
      if (row.params !== undefined && !isPlainObject(row.params)) {
        problems.push(`customRules[${index}].params: must be a plain object when present`);
      }
    });
  }
  if (!Array.isArray(owned)) {
    problems.push(
      `owned: must be an array of {file, project} rows whenever customRules is stored — the ` +
        `base side of a custom-rule re-judgment cannot attribute a record without it, got ` +
        `${describe(owned)}`,
    );
  } else {
    owned.forEach((row, index) => {
      if (!isPlainObject(row)) {
        problems.push(`owned[${index}]: must be an object, got ${describe(row)}`);
        return;
      }
      for (const field of ["file", "project"]) {
        if (typeof row[field] !== "string" || row[field] === "") {
          problems.push(`owned[${index}].${field}: must be a non-empty string`);
        }
      }
    });
  }
  return problems;
}

/**
 * The reason a coverage summary cannot serve as a delta BASELINE, or `null`.
 *
 * Load-side only, deliberately: capture may honestly record an incomplete look
 * (the evidence includes WHICH files went unanalyzed), but consuming one as a
 * comparison base would fabricate classifications — a violation living in a
 * file the base never looked at reads as newly introduced at head even if it
 * predates the run. The refusal names how many files went unanalyzed.
 *
 * @param {object} coverage
 * @returns {string|null}
 */
function incompleteBaselineCoverageReason(coverage) {
  if (
    coverage &&
    typeof coverage === "object" &&
    !Array.isArray(coverage) &&
    coverage.complete === false &&
    Array.isArray(coverage.notAnalyzed)
  ) {
    return (
      `coverage.complete: the baseline's coverage is not complete — ` +
      `${coverage.notAnalyzed.length} file(s) could not be analyzed at capture time, so a ` +
      `violation living there would be misread as newly introduced at head`
    );
  }
  return null;
}

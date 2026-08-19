/**
 * The `provenance` command: where this run's facts came from, whether the
 * governance rows it judges carry an origin to attest them, and whether a
 * `decisionRef` any of them cite actually resolves to a recorded decision.
 *
 * Provenance is descriptive, exactly like `graph`/`diff`/`drift`: it never
 * changes a verdict, so it never exits 1. It answers three questions:
 *
 * 1. **Repository provenance** — the git commit, remote, and dirty state of the
 *    tree this run judged, through the shared `resolveProvenance`
 *    (`./provenance.mjs`). This is the answer the JSON envelope already carries
 *    for `graph`/`diff`/`drift`/`history`; this command makes it a first-class
 *    report instead of a line inside someone else's envelope.
 * 2. **Decision provenance** — for every governance row in the workspace's
 *    declared intent (`architecture-intent.json`) and boundary config
 *    (`module-boundaries.config.mjs`, the `depConstraints` table), whether the
 *    row carries an `origin` block (the `by`/`tool`/`on?` record
 *    `../governance/provenance-record.mjs` owns). A row without an origin is
 *    flagged — `no origin recorded — cannot attest` — because a row whose
 *    decision nobody recorded is indistinguishable from a rule that appeared
 *    by editing the file directly. The report never pretends such a row is
 *    attested.
 * 3. **Decision resolution** — the same row walk, checked against the
 *    workspace's ADR registry (`../governance/adr-registry.mjs`) through
 *    `readAdrContext` (`./adr.mjs`). `origin` says a decision was recorded;
 *    `decisionRef` says WHICH one, and until this axis existed nothing ever
 *    verified the citation was real — `resolveDecisionRef` had no production
 *    caller, and a row bound to a nonexistent ADR id read as legitimately
 *    documented everywhere it was rendered. A row with no `decisionRef` is
 *    not a finding here; a row whose `decisionRef` names nothing the registry
 *    knows is.
 *
 * ## Determinism
 *
 * Every artifact this command reads is a static file — the intent, the config,
 * the ADR registry, git state. Two runs over an unchanged tree produce
 * byte-identical output, and no wall-clock time ever enters the report
 * (`../../../../AGENTS.md`).
 *
 * ## Fail-closed
 *
 * Every path that cannot reach an answer says so, in the imperative case:
 *
 * - git is not available or the tree is not a repository → `provenance: null`
 *   in the JSON envelope (the same explicit-null `graph`/`diff` carry), and the
 *   text report prints `repo provenance unavailable` rather than pretending a
 *   commit; the intent/config row arms still answer, because they read
 *   files, not git;
 * - the intent file, boundary config, or ADR registry is malformed → throw →
 *   exit 3, exactly the same loud refusal `drift` makes (`./drift.mjs`): a
 *   row list — or a resolution verdict — built from a file that could not be
 *   read would be a claim about rows, or citations, that do not exist.
 *
 * An empty `unattested` list must mean exactly "every governance row carries
 * an origin", an empty `unresolvedDecisionRefs` list must mean exactly "every
 * decisionRef citation resolves", and neither means the other.
 */
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatProvenanceReport } from "../report/provenance-text.mjs";
import { loadIntent } from "../architecture-intent/model.mjs";
import { loadBoundaryConfig } from "../config.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { readAdrContext } from "./adr.mjs";
import { declaredFitnessNames, unresolvedDecisionRefRows } from "../governance/adr-registry.mjs";

/**
 * Whether a row declares a governance origin (`origin.by`/`origin.tool`).
 * Absence is the finding — a row without an origin cannot be attested.
 *
 * @param {object} row
 * @returns {boolean}
 */
export function hasOrigin(row) {
  return (
    row !== null &&
    typeof row === "object" &&
    !Array.isArray(row) &&
    "origin" in row &&
    row.origin !== null &&
    typeof row.origin === "object" &&
    !Array.isArray(row.origin) &&
    "by" in row.origin &&
    "tool" in row.origin &&
    typeof row.origin.by === "string" &&
    row.origin.by.length > 0 &&
    typeof row.origin.tool === "string" &&
    row.origin.tool.length > 0
  );
}

/**
 * Describes one row so a human can find it. `kind` already carries the index
 * and section; this appends the row's identity (the pair a rule reads) when
 * the row has one.
 *
 * @param {string} kind e.g. `allowed[3]` or `depConstraints[0]`.
 * @param {object} row
 * @returns {string} e.g. `allowed[3] packages→extensions`
 */
export function rowLabel(kind, row) {
  const identity =
    typeof row.source === "string" && typeof row.target === "string"
      ? `${row.source}→${row.target}`
      : typeof row.from === "string" && typeof row.to === "string"
        ? `${row.from}→${row.to}`
        : typeof row.name === "string"
          ? row.name
          : typeof row.sourceTag === "string"
            ? row.sourceTag
            : "";
  return `${kind}${identity ? ` ${identity}` : ""}`;
}

/**
 * Walks every governance row in the normalized intent model — the same rows
 * `drift`'s judge counts, so a row list built here always matches the rows a
 * verdict is a claim about. The intent model's rows carry the origin block
 * additively (`../architecture-intent/model.mjs`), so a legacy row simply has
 * no `origin` key.
 *
 * @param {object} intent The normalized intent model.
 * @returns {{kind: string, row: object}[]}
 */
export function intentRows(intent) {
  const list = [];
  const sections = [
    ["allowed", intent.allowed ?? []],
    ["forbidden", intent.forbidden ?? []],
    ["projects.required", intent.projects?.required ?? []],
    ["projects.forbidden", intent.projects?.forbidden ?? []],
    ["dependencies.allowed", intent.dependencies?.allowed ?? []],
    ["dependencies.forbidden", intent.dependencies?.forbidden ?? []],
    ["forbiddenTags", intent.forbiddenTags ?? []],
  ];
  for (const [key, rows] of sections) {
    for (const [index, row] of rows.entries()) {
      list.push({ kind: `${key}[${index}]`, row });
    }
  }
  return list;
}

/**
 * Walks the boundary config's constraint rows — the `depConstraints` table,
 * the same rows `check`/`diff`/`impact` judge through
 * `../config.mjs`'s `findBoundaryConfigViolations`.
 *
 * @param {object} config The loaded boundary config module.
 * @returns {{kind: string, row: object}[]}
 */
export function configRows(config) {
  const rows = config?.depConstraints ?? [];
  return rows.map((row, index) => ({ kind: `depConstraints[${index}]`, row }));
}

/**
 * The provenance verdict: three answer surfaces, each fail-closed.
 *
 * `repo` is the git provenance, `established` whether git could answer,
 * `rows`/`unattested` the per-row decision provenance, and
 * `unresolvedDecisionRefs` every row whose `decisionRef` cites no ADR, rule,
 * or fitness record this workspace's registry knows. All three are findings
 * about *documentation*, not about the architecture — this command never
 * changes what `check` or `drift` decide, and it exits 0 when it completes.
 *
 * @param {{root: string, tracked: string[], provider: string, marker: string,
 *   options: {boundaryConfig: string|object, inline?: boolean}}} commandContext
 *   From `resolveCommandContext`.
 * @param {{loadIntentOverride?: (root: string, io: object) => Promise<object>,
 *   loadConfigOverride?: (root: string, boundaryConfig: string) => Promise<object>,
 *   loadAdrRegistryOverride?: typeof import("../governance/adr-registry.mjs").loadAdrRegistry}} [io]
 *   `loadAdrRegistryOverride` is forwarded to `readAdrContext` (`./adr.mjs`)
 *   unchanged.
 * @returns {Promise<{status: "ok", repo: {commit: string|null, remote: string|null,
 *   dirty: boolean|null, established: boolean},
 *   rows: {kind: string, attested: boolean, origin: object|null}[],
 *   unattested: {kind: string, label: string, note: string}[],
 *   unresolvedDecisionRefs: {kind: string, label: string, decisionRef: string, note: string}[],
 *   report: {text: string, json: string}}>}
 * @throws {Error} on a malformed intent, boundary config, or ADR registry —
 *   exit 3, the loud refusal every command that reads them makes.
 */
export async function provenanceCommand(commandContext, io = {}) {
  const { root, tracked, options } = commandContext;

  const repo = resolveProvenance(root);
  const rowList = [];
  const unattested = [];

  const intent = await (io.loadIntentOverride ?? loadIntent)(root, { tracked });
  const introws = intent === undefined ? [] : intentRows(intent);
  for (const { kind, row } of introws) {
    const attested = hasOrigin(row);
    rowList.push({ kind, attested, origin: attested ? row.origin : null });
    if (!attested) {
      unattested.push({
        kind,
        label: rowLabel(kind, row),
        note: "no origin recorded — cannot attest",
      });
    }
  }

  // The boundary law is either a filename (the string form `loadBoundaryConfig`
  // reads) or an inline policy object living directly in `lattice.json`
  // (`../providers/native/model.mjs`, `normalizeNativeModel`'s
  // `inlineBoundaryConfig`). Both are walked — a policy whose rows the report
  // never inspected would claim "every row attests" over an unread table,
  // which is the silent direction this command exists to end.
  const boundaryConfig = options.boundaryConfig;
  const walked = [];
  let loadedConfig = null;
  if (typeof boundaryConfig === "string") {
    const config = await (io.loadConfigOverride ?? loadBoundaryConfig)(root, boundaryConfig);
    loadedConfig = config;
    walked.push(...configRows(config));
  } else if (
    boundaryConfig !== null &&
    typeof boundaryConfig === "object" &&
    !Array.isArray(boundaryConfig)
  ) {
    loadedConfig = boundaryConfig;
    walked.push(...configRows(boundaryConfig));
  }
  for (const { kind, row } of walked) {
    const attested = hasOrigin(row);
    rowList.push({ kind, attested, origin: attested ? row.origin : null });
    if (!attested) {
      unattested.push({
        kind,
        label: rowLabel(kind, row),
        note: "no origin recorded — cannot attest",
      });
    }
  }

  // Resolution — `row-schema.mjs`'s `decisionRef` half, gated on an
  // `io.resolve` neither `config.mjs` nor `architecture-intent/model.mjs`
  // ever supplied. Walked over the same two row lists the attestation loops
  // above already visited, against the workspace's own ADR registry.
  const governanceRows = [...introws, ...walked];
  const adrContext = readAdrContext(root, {
    tracked,
    loadAdrRegistryOverride: io.loadAdrRegistryOverride,
  });
  // F04: the fitness half of a decisionRef resolves against the ids the
  // loaded policy DECLARES (`declaredFitnessNames`), never against the ADRs'
  // own `bindings` — a citation cannot resolve itself. `loadedConfig` is the
  // policy object walked above; `null` only when no boundary law was declared,
  // and then no fitness-shaped ref can resolve, which is correct.
  const unresolvedDecisionRefs = unresolvedDecisionRefRows(
    governanceRows,
    adrContext.byId,
    declaredFitnessNames(loadedConfig),
  ).map(({ kind, row, decisionRef }) => ({
    kind,
    label: rowLabel(kind, row),
    decisionRef,
    note: `"${decisionRef}" does not resolve — no matching ADR, rule, or fitness record`,
  }));

  const establishment = repo !== null;
  const repoResult = establishment ? repo : { commit: null, remote: null, dirty: null };
  const rowsTotal = rowList.length;

  // "No fact, no claim": the resolution section is rendered only when at
  // least one row actually cites a decisionRef — a workspace that never uses
  // the field pays nothing and hears nothing, the same bargain every optional
  // axis in this tool states.
  const decisionRefRows = governanceRows.filter(
    ({ row }) => typeof row?.decisionRef === "string" && row.decisionRef.trim() !== "",
  );
  const reportText = formatProvenanceReport({
    establishment,
    repo,
    rowsTotal,
    unattested,
    decisionRefTotal: decisionRefRows.length,
    unresolvedDecisionRefs,
  });

  const context = {
    root,
    provider: /** @type {"nx"|"moon"|"native"} */ (commandContext.provider),
    marker: commandContext.marker,
    provenance: establishment ? repo : null,
  };
  const envelope = jsonEnvelope({
    command: "provenance",
    context,
    status: "ok",
    exitCode: 0,
    coverage: {
      complete: true,
      projects: 0,
      analyzedFiles: 0,
      imports: 0,
      notAnalyzed: [],
      blindSpots: [],
      notes: [],
    },
    // The three answer surfaces; `result.rows` preserves the canonical row
    // order. `unresolvedDecisionRefs` is unconditional, like `unattested` —
    // an empty array is itself the claim "every citation resolves", never an
    // omitted key that would leave a reader unable to tell "checked, clean"
    // from "never checked" (`../../../../AGENTS.md`).
    result: {
      repo: repoResult,
      established: establishment,
      rows: rowList.map(({ kind, attested, origin }) => ({
        kind,
        attested,
        origin: origin ?? null,
      })),
      unattested: unattested.map(({ kind, label, note }) => ({ kind, label, note })),
      unresolvedDecisionRefs,
    },
  });

  return {
    status: "ok",
    repo: { ...repoResult, established: establishment },
    // The three answer surfaces, also available readably (not only inside the
    // envelope) so `cli.mjs` can drive the text report from the same facts.
    rows: rowList.map(({ kind, attested, origin }) => ({
      kind,
      attested,
      origin: origin ?? null,
    })),
    unattested: unattested.map(({ kind, label, note }) => ({ kind, label, note })),
    unresolvedDecisionRefs,
    report: {
      text: reportText,
      json: renderJson(envelope),
    },
  };
}

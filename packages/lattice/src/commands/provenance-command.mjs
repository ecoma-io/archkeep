/**
 * The `provenance` command: where this run's facts came from, and whether the
 * governance rows it judges carry an origin to attest them.
 *
 * Provenance is descriptive, exactly like `graph`/`diff`/`drift`: it never
 * changes a verdict, so it never exits 1. It answers two questions:
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
 *
 * ## Determinism
 *
 * Every artifact this command reads is a static file — the intent, the config,
 * git state. Two runs over an unchanged tree produce byte-identical output,
 * and no wall-clock time ever enters the report (`../../../../AGENTS.md`).
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
 * - the intent file or boundary config is malformed → throw → exit 3, exactly
 *   the same loud refusal `drift` makes (`./drift.mjs`): a row list built from
 *   a file it could not read would be a claim about rows that do not exist.
 *
 * An empty `unattested` list must mean exactly "every governance row carries
 * an origin", and nothing else.
 */
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { loadIntent } from "../architecture-intent/model.mjs";
import { loadBoundaryConfig } from "../config.mjs";
import { resolveProvenance } from "./provenance.mjs";

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
 * The provenance verdict: two answer surfaces, each fail-closed.
 *
 * `repo` is the git provenance, `established` whether git could answer, and
 * `rows`/`unattested` the per-row decision provenance. Unattested rows are
 * findings about *documentation*, not about the architecture — this command
 * never changes what `check` or `drift` decide, and it exits 0 when it
 * completes.
 *
 * @param {{root: string, tracked: string[], provider: string, marker: string,
 *   options: {boundaryConfig: string|object, inline?: boolean}}} commandContext
 *   From `resolveCommandContext`.
 * @param {{loadIntentOverride?: (root: string, io: object) => Promise<object>,
 *   loadConfigOverride?: (root: string, boundaryConfig: string) => Promise<object>}} [io]
 * @returns {Promise<{status: "ok", repo: {commit: string|null, remote: string|null,
 *   dirty: boolean|null, established: boolean},
 *   rows: {kind: string, attested: boolean, origin: object|null}[],
 *   unattested: {kind: string, label: string, note: string}[],
 *   report: {text: string, json: string}}>}
 * @throws {Error} on a malformed intent or boundary config — exit 3, the loud
 *   refusal every command that reads them makes.
 */
export async function provenanceCommand(commandContext, io = {}) {
  const { root, tracked, options } = commandContext;

  const repo = resolveProvenance(root);
  const rowList = [];
  const unattested = [];

  const intent = await (io.loadIntentOverride ?? loadIntent)(root, { tracked });
  if (intent !== undefined) {
    for (const { kind, row } of intentRows(intent)) {
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
  }

  // The boundary law is either a filename (the string form `loadBoundaryConfig`
  // reads) or an inline policy object living directly in `lattice.json`
  // (`../providers/native/model.mjs`, `normalizeNativeModel`'s
  // `inlineBoundaryConfig`). Both are walked — a policy whose rows the report
  // never inspected would claim "every row attests" over an unread table,
  // which is the silent direction this command exists to end.
  const boundaryConfig = options.boundaryConfig;
  const walked = [];
  if (typeof boundaryConfig === "string") {
    const config = await (io.loadConfigOverride ?? loadBoundaryConfig)(root, boundaryConfig);
    walked.push(...configRows(config));
  } else if (
    boundaryConfig !== null &&
    typeof boundaryConfig === "object" &&
    !Array.isArray(boundaryConfig)
  ) {
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

  const establishment = repo !== null;
  const repoResult = establishment ? repo : { commit: null, remote: null, dirty: null };
  const rowsTotal = rowList.length;
  const attestedCount = rowsTotal - unattested.length;

  // Determinism: every report line derives from static facts in the canonical
  // row order (intent, then config); no wall-clock time, no localeCompare.
  const text = [];
  text.push(
    establishment
      ? `repo      ${repo.commit}${repo.dirty ? " (dirty)" : ""}` +
          (repo.remote ? ` — ${repo.remote}` : "")
      : "repo      provenance unavailable — not a git repository or git not installed",
  );
  text.push(
    `rows      ${rowsTotal} governance row${rowsTotal === 1 ? "" : "s"}, ` +
      `${attestedCount} with an origin, ${unattested.length} without`,
  );
  if (unattested.length > 0) {
    text.push("unattested (no origin recorded — cannot attest):");
    for (const row of unattested) {
      text.push(`  ${row.kind}`);
    }
    text.push(`${unattested.length} of them carry no decision behind the rule`);
  } else {
    text.push(
      `✔ every governance row carries an origin — each names who decided ` +
        `on it and with what tool`,
    );
  }
  const reportText = text.join("\n");

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
    // The two answer surfaces; `result.rows` preserves the canonical row order.
    result: {
      repo: repoResult,
      established: establishment,
      rows: rowList.map(({ kind, attested, origin }) => ({
        kind,
        attested,
        origin: origin ?? null,
      })),
      unattested: unattested.map(({ kind, label, note }) => ({ kind, label, note })),
    },
  });

  return {
    status: "ok",
    repo: { ...repoResult, established: establishment },
    // The two answer surfaces, also available readably (not only inside the
    // envelope) so `cli.mjs` can drive the text report from the same facts.
    rows: rowList.map(({ kind, attested, origin }) => ({
      kind,
      attested,
      origin: origin ?? null,
    })),
    unattested: unattested.map(({ kind, label, note }) => ({ kind, label, note })),
    report: {
      text: reportText,
      json: renderJson(envelope),
    },
  };
}

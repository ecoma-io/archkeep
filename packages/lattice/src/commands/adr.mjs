/**
 * The `adr` command: the workspace's recorded architecture decisions, and the
 * rules/fitnesses each makes enforceable.
 *
 * `adr` reads the ADR registry — `docs/adr/NNN-slug.md` files at the workspace
 * root (`../../governance/adr-registry.mjs` owns the format and the index).
 * With no arguments it dumps the whole registry: every record, its status, its
 * supersession chain, and which rule/fitness ids it binds. Given an id it shows
 * that one record and — the reverse lookup — which ADRs bind each of its
 * bindings.
 *
 * It is descriptive, exactly like `graph`/`drift`/`history`: it never exits 1,
 * because a description of what is recorded is never a finding. Only `check`
 * exits 1. What it DOES refuse, loudly (exit 3, never clean):
 *
 * - an unreadable registry — a `docs/adr/` that exists but holds a malformed
 *   record, a duplicate id, or a file that will not parse. "Could not read the
 *   registry" must never read as "no ADRs";
 * - an unresolvable `decisionRef` — a binding, a supersedes target, or a row's
 *   decisionRef that names nothing. The invariant (`../../../../AGENTS.md`):
 *   a binding that does not resolve is `unknown`, never `pass`.
 *
 * It does not need a project graph, Nx, or a boundary config: the registry is
 * self-contained in the tree. `resolveCommandContext`'s heavy preamble is
 * skipped, so `adr` runs on a tree with no Nx at all — the same posture
 * `history` has when given no `--capture`.
 *
 * ## What it cannot assert
 *
 * It reports what the registry records; it does not verify that a bound
 * rule/fitness exists anywhere else in the workspace (that is the decisionRef
 * validator's question at load time). A binding to a fitness id that no
 * declaration carries is listed as `unknown` — named, never hidden.
 */
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import {
  formatAdrDump,
  formatAdrMissing,
  formatAdrRecord,
  formatAdrReverse,
} from "../report/adr-text.mjs";
import { ADR_DIR, ADR_ID_PATTERN } from "../governance/adr-registry.mjs";
import { adrsBinding, boundFitnessIds, loadAdrRegistry } from "../governance/adr-registry.mjs";

/**
 * The result of reading one registry: the records, the index, and the known
 * rule/fitness id set derived from the records' own bindings.
 *
 * @typedef {object} AdrContext
 * @property {object[]} records
 * @property {Map<string, object>} byId
 * @property {Set<string>} knownFitness The ids every record's `bindings`
 *   mention — the names `resolveDecisionRef` answers as `fitness`.
 */

/**
 * Reads the registry at `root` and derives the known-fitness set. Throws on an
 * unreadable registry — the caller (cli.mjs) maps that to exit 3.
 *
 * @param {string} root
 * @param {{loadAdrRegistryOverride?: typeof loadAdrRegistry}} [io]
 * @returns {AdrContext}
 */
export function readAdrContext(root, io = {}) {
  const registry = (io.loadAdrRegistryOverride ?? loadAdrRegistry)(root);
  return {
    records: registry.records,
    byId: registry.byId,
    knownFitness: boundFitnessIds(registry.records),
  };
}

/**
 * The verdict for one `adr` run: the payload for both renderers, the status,
 * and the coverage that decides exit 0 against 3.
 *
 * @param {string} root
 * @param {{id?: string}} options
 * @param {{loadAdrRegistryOverride?: typeof loadAdrRegistry}} [io]
 * @returns {{status: "ok"|"no-verdict", result: object, coverage: object,
 *   report: {text: string, json: string}}}
 * @throws {Error} on an unreadable registry (exit-3 class).
 */
export function adrCommand(root, options, io = {}) {
  const ctx = readAdrContext(root, io);

  const { records, byId, knownFitness } = ctx;

  // An id the caller asked about that the registry does not know is a named
  // unknown, not a clean result — the invariant. Two cases, told apart by the
  // id's shape: an id matching the ADR pattern (`NNN-slug`) names a record that
  // is missing — unresolved, exit 3; a rule/fitness id (`rule:x`,
  // `fitness:x`) is a reverse lookup, and an unenforced one is a fact about
  // the registry, ok.
  const requestedId = options.id;
  let unresolved = [];
  if (requestedId !== undefined && ADR_ID_PATTERN.test(requestedId) && !byId.has(requestedId)) {
    unresolved = [{ ref: requestedId, why: `${requestedId} is not an ADR in ${ADR_DIR}` }];
  }

  const result = {
    adrs: records.map((record) => record.id),
    registry: {
      dir: ADR_DIR,
      count: records.length,
    },
    statuses: records.map((record) => ({ id: record.id, status: record.status })),
    bindings: records.flatMap((record) =>
      record.bindings.map((binding) => ({ adr: record.id, binding })),
    ),
    supersedes: records.flatMap((record) =>
      record.supersedes.map((ref) => ({ adr: record.id, supersedes: ref })),
    ),
    unresolved,
    knownFitness: [...knownFitness].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };

  const text =
    requestedId === undefined
      ? formatAdrDump({ records, knownFitness })
      : byId.has(requestedId)
        ? formatAdrRecord(byId.get(requestedId))
        : ADR_ID_PATTERN.test(requestedId)
          ? formatAdrMissing({ adrId: requestedId })
          : formatAdrReverse({ fitnessId: requestedId, adrIds: adrsBinding(records, requestedId) });

  const coverage = {
    complete: unresolved.length === 0,
    // `adr` reads no source files and no graph — the units it counted are the
    // records it read. `complete` is what decides the exit code.
    projects: 0,
    analyzedFiles: records.length,
    imports: 0,
    notAnalyzed: unresolved.map(({ ref, why }) => ({ file: `${ADR_DIR}/${ref}.md`, reason: why })),
    blindSpots: [],
    notes: [],
  };

  const status = unresolved.length === 0 ? "ok" : "no-verdict";
  const exitCode = status === "ok" ? 0 : 3;

  const envelope = jsonEnvelope({
    command: "adr",
    context: {
      root,
      provider: "native",
      marker: ADR_DIR,
      provenance: null,
    },
    status,
    exitCode,
    coverage,
    result,
  });

  return {
    status,
    result,
    coverage,
    report: {
      text: `${text}\n`,
      json: renderJson(envelope),
    },
  };
}

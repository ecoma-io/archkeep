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
 * - a reference into the registry's OWN name space that names nothing: the id
 *   a caller asked about, and any record's `supersedes` target. Both resolve
 *   against the index, so a supersession chain is never rendered as fact
 *   unless its far end is a record. The invariant (`../../../../AGENTS.md`):
 *   a reference that does not resolve is `unknown`, never `pass`. A
 *   `bindings` entry is deliberately NOT on this list — it names an id in the
 *   rule/fitness name space, which this command holds no authority over;
 *   "What it cannot assert" below owns that limit and how a binding is
 *   surfaced instead.
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
 * validator's question at load time). It CANNOT, and the reason is worth
 * stating because it is easy to write a check that only looks like one: this
 * command loads no boundary config, so the only id set in reach is
 * `knownFitness`, and `boundFitnessIds` derives that from the records' own
 * `bindings`. Testing a binding against it is self-resolution — vacuous for a
 * bare id, and for a `rule:`/`fitness:`-prefixed one an artifact of
 * `resolveDecisionRef` stripping the prefix off one side only, which would
 * refuse `rule:no-such-rule` and the equally valid `rule:no-direct-dep`
 * alike. So no binding is refused here, and — the honest consequence — the
 * `(unknown)` marker `../report/adr-text.mjs` renders cannot fire on any run
 * driven from THIS command: every binding is in the set by construction. The
 * marker is real and both text faces apply it identically (one `bindingsLine`
 * serves the dump and the single-record report, so they cannot disagree about
 * which bindings carry it); what is missing is an id set that did not come
 * from the bindings, which only a caller holding the workspace's declared
 * rule/fitness ids can supply. Until one does, a binding is surfaced and
 * never adjudicated: carried verbatim in the text and in the envelope's
 * `bindings` beside `knownFitness`, at exit 0. Naming a limit is not a
 * verdict; leaving it unnamed would be the silent direction
 * (`../../../../AGENTS.md`).
 * ## What it can say about fitness
 *
 * Wave 2's fitness derivation (`../governance/decision-fitness.mjs`) folds a
 * decision's bound constraints and their verdicts into one per-decision
 * level. It is NOT wired into this command's own read: `adr` stays the
 * registry-only surface it was. The caller may hand verdicts in through
 * `io.fitnessVerdicts` (the same `{name, verdict}` shape `fitness` produces)
 * and every record then renders its level — `verified` only when a bound
 * constraint passes. Without verdicts the derivation still runs, and its
 * honest answer is echoed: a decision with authority but nothing verifiable
 * is `unverifiable` — never healthy — while a status without authority is
 * `not_applicable`. An empty verdict set is not silence; it is the registry
 * alone asserting nothing. Levels never change the exit code: `adr` remains
 * 0/2/3, a description of what is recorded, not a gate.
 */
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import {
  formatAdrDump,
  formatAdrMissing,
  formatAdrRecord,
  formatAdrReverse,
} from "../report/adr-text.mjs";
import { ADR_DIR, stripAdrPrefix } from "../governance/adr-registry.mjs";
import { adrsBinding, boundFitnessIds, loadAdrRegistry } from "../governance/adr-registry.mjs";
import { computeDecisionFitness } from "../governance/decision-fitness.mjs";
import { stripRuleFitnessPrefix } from "../governance/adr-registry.mjs";

/**
 * The other half of the id name space the positional argument answers
 * (`docs/usage/adr.md` and `docs/reference/adr.md`, "The id name space"): a
 * `rule:`/`fitness:`-prefixed ref names a rule or fitness id, and the reverse
 * lookup for one no ADR binds is a legitimate, ok fact — most fitness ids
 * are never bound by any ADR, and that is not the same thing as being
 * unresolved. Every other spelling is read as an attempted ADR reference —
 * bare `NNN-slug`, the `adr:`-prefixed spelling `../governance/row-schema.mjs`'s
 * own decisionRef docs recommend, or any other near-miss (wrong case, a
 * truncation, a path-traversal shape) — so a miss there reports unresolved
 * instead of silently falling into this pattern's empty-but-clean case.
 */
const FITNESS_REF_PATTERN = /^(?:rule|fitness):/u;

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
 * @param {{loadAdrRegistryOverride?: typeof loadAdrRegistry, tracked?: string[],
 *   lstatSync?: (path: string) => {isSymbolicLink: () => boolean},
 *   realpathSync?: (path: string) => string}} [io] `tracked`, `lstatSync` and
 *   `realpathSync` are forwarded to `loadAdrRegistry` unchanged — see its own
 *   header for what they guard against.
 * @returns {AdrContext}
 */
export function readAdrContext(root, io = {}) {
  const registry = (io.loadAdrRegistryOverride ?? loadAdrRegistry)(root, {
    tracked: io.tracked,
    lstatSync: io.lstatSync,
    realpathSync: io.realpathSync,
  });
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
 * @param {{loadAdrRegistryOverride?: typeof loadAdrRegistry, tracked?: string[],
 *   lstatSync?: (path: string) => {isSymbolicLink: () => boolean},
 *   realpathSync?: (path: string) => string, fitnessVerdicts?:
 *   Array<{name: string, verdict: string}>}} [io] `tracked`, `lstatSync` and
 *   `realpathSync` are forwarded to `readAdrContext` unchanged; `fitnessVerdicts`
 *   feeds the per-decision fitness derivation ("What it can say about fitness"
 *   in the module header owns what an absent array means).
 * @returns {{status: "ok"|"no-verdict", result: object, coverage: object,
 *   report: {text: string, json: string}}}
 * @throws {Error} on an unreadable registry (exit-3 class).
 */
export function adrCommand(root, options, io = {}) {
  const ctx = readAdrContext(root, io);

  const { records, byId, knownFitness } = ctx;

  // Per-decision fitness: the wave-2 derivation, fed a lookup built from
  // whatever verdicts the caller can supply (`io.fitnessVerdicts`, the same
  // `{name, verdict}` shape the `fitness` command emits). A binding's prefix
  // (`rule:`/`fitness:`) is stripped before the lookup — a verdict names a
  // declared fitness id, and `fitness:hotspot` and `hotspot` are the same id.
  // An empty verdict set is a legitimate input: every authority decision then
  // derives `unverifiable`, which is the registry alone asserting nothing —
  // the module header's "What it can say about fitness" owns the wording.
  const verdictByName = new Map((io.fitnessVerdicts ?? []).map((v) => [v.name, v]));
  const fitnessLookup = (bindingId) => verdictByName.get(stripRuleFitnessPrefix(bindingId));
  const fitnessById = new Map(
    computeDecisionFitness(records, null, fitnessLookup).map((entry) => [entry.id, entry]),
  );
  const fitness = [...fitnessById.values()];

  // An id the caller asked about that the registry does not know is a named
  // unknown, not a clean result — the invariant. Two cases, told apart by the
  // id's shape: a `rule:x`/`fitness:x` ref (`FITNESS_REF_PATTERN`, above) is a
  // reverse lookup, and an unenforced one is a fact about the registry, ok.
  // Everything else is read as an attempted ADR reference — bare `NNN-slug`,
  // or `adr:`-prefixed (`stripAdrPrefix` strips it before the lookup below,
  // the same normalisation `resolveDecisionRef` applies) — and one that does
  // not resolve is unresolved, exit 3. Classifying by "is this fitness-shaped"
  // rather than "does this match the ADR pattern" is what catches a near-miss
  // ADR spelling — that `adr:` prefix, a case mismatch, a truncation, a
  // path-traversal shape, or anything else that is neither a real record nor
  // a fitness/rule reference: every one of those used to fall through to the
  // reverse-lookup branch below and read as a clean, unenforced-but-known
  // fact instead of a reference the registry could not resolve at all.
  const requestedId = options.id;
  const isFitnessRef = requestedId !== undefined && FITNESS_REF_PATTERN.test(requestedId);
  const resolvedAdrId = requestedId === undefined ? undefined : stripAdrPrefix(requestedId);
  const unresolved = [];
  if (requestedId !== undefined && !isFitnessRef && !byId.has(resolvedAdrId)) {
    unresolved.push({ ref: requestedId, why: `${requestedId} is not an ADR in ${ADR_DIR}` });
  }

  // Every record's `supersedes` target, resolved against the registry index.
  // `validateRecord` (`../governance/adr-registry.mjs`) checks the SHAPE of a
  // supersedes entry — that it looks like an ADR id — and nothing more, so a
  // `supersedes: ["0000-does-not-exist"]` loaded clean and was rendered below
  // as a supersession chain, in `result.supersedes` and in the record's own
  // text block, under `status: "ok"` and `coverage.complete: true`. A chain
  // whose far end is not a record is a claim about a decision this workspace
  // never recorded — precisely the "unresolvable decisionRef — a binding, a
  // supersedes target, or a row's decisionRef that names nothing" this
  // module's header promises to refuse, and printing it as fact is the silent
  // direction the invariant (`../../../../AGENTS.md`) forbids. `stripAdrPrefix`
  // is applied for the same reason the requested-id lookup above applies it:
  // the `adr:`-prefixed spelling this tool's own docs recommend must not be
  // the one spelling that fails to resolve against a record that exists.
  for (const record of records) {
    for (const ref of record.supersedes) {
      if (byId.has(stripAdrPrefix(ref))) continue;
      unresolved.push({
        ref,
        why: `${record.id} supersedes ${ref}, which is not an ADR in ${ADR_DIR}`,
      });
    }
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
    // The derived reverse link — the records whose `supersedes` names this
    // one — so a machine reader of the envelope sees the same lineage the
    // text face shows.
    supersededBy: records.flatMap((record) =>
      record.supersededBy.map((id) => ({ adr: record.id, supersededBy: id })),
    ),
    fitness,
    unresolved,
    knownFitness: [...knownFitness].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };

  const text =
    requestedId === undefined
      ? formatAdrDump({ records, knownFitness, fitnessById })
      : byId.has(resolvedAdrId)
        ? formatAdrRecord(byId.get(resolvedAdrId), knownFitness, fitnessById)
        : isFitnessRef
          ? formatAdrReverse({ fitnessId: requestedId, adrIds: adrsBinding(records, requestedId) })
          : formatAdrMissing({ adrId: requestedId });

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

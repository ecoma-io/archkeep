/**
 * The `trajectory` command: which deterministic signals moved across a
 * snapshot history, aggregated over every observation the directory holds.
 *
 * `history <dir>` answers "what happened at each transition" — one record per
 * consecutive pair, each classified by the signals it carries. `trajectory
 * <dir>` reads the same directory through the same reader and the same
 * transition classifier (`./history.mjs`'s `readSnapshots` and
 * `classifyTransition`) and answers the question an event list cannot:
 * **over the whole series, which signals fired how often, what did the graph
 * gain and lose in total, and what persisted through every observation.**
 *
 * ## What a trend means here — and what it does not
 *
 * A trend is a count or a set that changed over an ORDERED sequence of
 * observations. It is never a judgment: nothing here scores the architecture,
 * weights a signal, or decides whether more edges or fewer violations is
 * "better". Every number is either read off stored bytes or derived from them
 * by a stated rule; a human or an agent decides what the facts mean. Doctrine
 * owns that split (`../../../../docs/doctrine/architecture-authority.md`):
 * this command produces evidence, never a verdict — it is descriptive, and it
 * never exits 1.
 *
 * ## The observation basis
 *
 * One observation is ONE stored `graph --format json` snapshot — a capture
 * point. Snapshot capture deduplicates unchanged architectures, so the number
 * of observations is the number of recorded states, NOT a count of commits,
 * days, or captures attempted (`../../../../docs/usage/history.md`). The
 * result names its basis explicitly (`observations.basis`), and no field
 * converts observations into any unit of time.
 *
 * ## Stable identity, proven not guessed
 *
 * Persistence claims are only as honest as the identity beneath them. Both
 * identities here are ones `diff` already defines and uses (`./diff.mjs`): a
 * project IS its `name`, an edge IS its `(source, target, type)` triple
 * (`edgeIdentityKey`). Nothing weaker — no array index, no display order, no
 * line number — participates in any cross-observation claim.
 *
 * Findings have NO stable identity in stored snapshots, because a snapshot
 * carries no findings at all — only the graph and the policy fingerprint
 * (the disclosure `./history.mjs` states). So this command reports NO
 * violation-level trajectory: no introduced/resolved/persisting counts for
 * boundary violations can be reconstructed from stored evidence, and
 * inventing one would fabricate persistence for facts the snapshots never
 * held. `delta` classifies real violations between two live points;
 * `debt` ages today's ledger facts across snapshots. Neither job is repeated
 * here under a second definition of time.
 *
 * ## Unknown evidence never becomes zero
 *
 * The empty-result invariant (`../../../../AGENTS.md`) applied to an
 * aggregate: a value this history cannot establish reads `null` beside an
 * explicit reason, never as a clean zero. Three cases, all loud:
 *
 * - **No transitions derivable** — a directory with ONE snapshot yields no
 *   consecutive pair, so `available` is `false`, `unavailableReason` is
 *   `"insufficient_history"`, and every derived number is `null`. Reporting
 *   delta 0 there would claim stability over a history that cannot show
 *   movement.
 * - **Incomparable metadata** — a fingerprint or a provenance on one side of
 *   a pair only. `snapshot-meta.mjs` refuses to call that "the same", and so
 *   does this aggregation: such a transition counts under
 *   `signals.incomparable` (and its specific disclosure), and — stricter than
 *   `history`'s per-transition label, which keeps the note beside the record —
 *   it does NOT count as `unchanged`. An aggregate has no notes line to carry
 *   the disclosure, so the exclusion is the disclosure.
 * - **An unreadable or malformed snapshot** stops the whole run (exit 3,
 *   through `readSnapshots`), never silently drops out of the aggregate —
 *   a missing observation must not read as a quiet one.
 *
 * An empty directory is refused outright, exactly like `history` and `debt`
 * refuse it: zero observations is no record at all, not a clean trajectory.
 *
 * ## Determinism and complexity
 *
 * Pure function of the snapshot bytes: plain `<` string comparison everywhere,
 * fixed key insertion order, no clock, no locale. Complexity is linear in the
 * input — O(N) classification passes over N snapshots, each O(P + E) in the
 * projects and edges those two snapshots hold, plus one linear persistence
 * sweep over every project and edge ever seen. There is no pairwise
 * O(N²) comparison and no re-analysis of source files: everything is read
 * from stored envelopes.
 *
 * What it needs from its caller is a workspace root context (for the
 * envelope's workspace header and the directory-containment check — the
 * trajectory itself never touches the live graph) and the directory path.
 * It does not print, and it does not decide the process's exit code —
 * `../../cli.mjs` owns those (`./README.md`).
 */
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatTrajectoryReport } from "../report/trajectory-text.mjs";
import { edgeIdentityKey } from "./diff.mjs";
import { classifyTransition, readSnapshots } from "./history.mjs";
import { resolveProvenance } from "./provenance.mjs";

/**
 * What one observation is. Stated as a value rather than left implicit, so a
 * consumer reading `observations: 12` knows exactly what was counted — and
 * what was not (commits, days, capture attempts).
 */
const OBSERVATION_BASIS = "graph_snapshots";

/**
 * The reason `available` is `false` for a one-snapshot history. A named
 * constant in the envelope, so a consumer branches on a documented value
 * rather than on prose.
 */
export const INSUFFICIENT_HISTORY = "insufficient_history";

/**
 * The derived-number block for one structural axis (projects keyed by name,
 * edges keyed by `edgeIdentityKey`). Fields ending in `Events` count
 * transition EVENTS — cumulative add/remove occurrences, which can exceed the
 * endpoint movement when an entity churns (add → remove → add is two added
 * events, one removed, and equal first/current sets). The endpoint fields
 * compare FIRST and LAST observation sets only:
 *
 * - `introduced` — present in the last observation, absent from the first.
 * - `resolved` — present in the first observation, absent from the last.
 * - `persistent` — present in EVERY observation, first through last.
 * - `delta` — `current − first`.
 *
 * Every derived field is `null` when the history holds fewer than two
 * observations — unavailable is never folded into a zero.
 *
 * @typedef {object} TrajectoryAxis
 * @property {number} first Projects/edges in the first observation.
 * @property {number} current Projects/edges in the last observation.
 * @property {number|null} delta
 * @property {number|null} addedEvents
 * @property {number|null} removedEvents
 * @property {number|null} changedEvents Projects only: metadata churn
 *   (tags/type/root changes per `computeDiff`). Edges carry no changed-event
 *   count — a type flip IS a removal plus an addition under the triple
 *   identity (`./diff.mjs`).
 * @property {number|null} introduced
 * @property {number|null} resolved
 * @property {number|null} persistent
 */

/**
 * Aggregates the deterministic trajectory over an ordered snapshot set.
 * Pure: same bytes in, same object out. All keys are always present — shape
 * never depends on history content (E-F05); unavailable values are `null`
 * with `available`/`unavailableReason` saying why.
 *
 * @param {{name: string, path: string, envelope: object, id: string}[]} files
 *   From `readSnapshots(dir)`, in history order.
 * @returns {{observations: {count: number, basis: string,
 *   first: string|null, last: string|null, withProvenance: number,
 *   dirtyProvenance: number}, available: boolean, unavailableReason: string|null,
 *   transitions: {count: number, architecture: number, policy: number,
 *     provider: number, codeDrift: number, incomparable: number, unchanged: number},
 *   disclosures: {policyOneSided: number, provenanceOneSided: number, crossRepo: number},
 *   projects: TrajectoryAxis, edges: TrajectoryAxis}}
 */
export function computeTrajectory(files) {
  const n = files.length;
  const available = n >= 2;

  // Per-observation facts, straight off the envelopes — no pairing needed.
  let withProvenance = 0;
  let dirtyProvenance = 0;
  for (const file of files) {
    const provenance = file.envelope.workspace.provenance ?? null;
    if (provenance !== null) withProvenance += 1;
    if (provenance?.dirty === true) dirtyProvenance += 1;
  }

  /** @type {{count: number, architecture: number, policy: number, provider: number,
        codeDrift: number, incomparable: number, unchanged: number}} */
  const transitions = {
    count: 0,
    architecture: 0,
    policy: 0,
    provider: 0,
    codeDrift: 0,
    incomparable: 0,
    unchanged: 0,
  };
  const disclosures = { policyOneSided: 0, provenanceOneSided: 0, crossRepo: 0 };

  // Cumulative transition events, accumulated while classifying. Kept as
  // scalars rather than deferred to a second pass — one walk over the pairs.
  let addedProjectEvents = 0;
  let removedProjectEvents = 0;
  let changedProjectEvents = 0;
  let addedEdgeEvents = 0;
  let removedEdgeEvents = 0;

  // Persistence sets: entity key → number of observations containing it.
  // Built once per axis in the same walk that reads each snapshot's members,
  // so cost stays linear in the total snapshot content.
  /** @type {Map<string, number>} */
  const projectPresence = new Map();
  /** @type {Map<string, number>} */
  const edgePresence = new Map();

  let firstProjects = null;
  let lastProjects = null;
  let firstEdges = null;
  let lastEdges = null;

  for (let i = 0; i < n; i++) {
    const file = files[i];
    const projectKeys = new Set(file.envelope.result.projects.map((p) => p.name));
    // Project identity is the name — the same key `computeDiff` indexes by
    // (`./diff.mjs`). Edge identity is the `(source, target, type)` triple,
    // shared through `edgeIdentityKey` so both commands answer "same edge?"
    // from one definition.
    const edgeKeys = new Set(file.envelope.result.dependencies.map(edgeIdentityKey));

    for (const key of projectKeys) projectPresence.set(key, (projectPresence.get(key) ?? 0) + 1);
    for (const key of edgeKeys) edgePresence.set(key, (edgePresence.get(key) ?? 0) + 1);

    if (i === 0) {
      firstProjects = projectKeys;
      firstEdges = edgeKeys;
    }
    if (i === n - 1) {
      lastProjects = projectKeys;
      lastEdges = edgeKeys;
    }

    if (i + 1 < n) {
      const { record, meta } = classifyTransition(file, files[i + 1]);
      transitions.count += 1;
      if (record.architectureChanged) transitions.architecture += 1;
      if (record.policyChanged === true) transitions.policy += 1;
      if (record.providerChanged) transitions.provider += 1;
      if (record.codeDrift) transitions.codeDrift += 1;

      // The asymmetric-evidence cases, counted from `meta` itself — never
      // parsed back out of the record's prose notes.
      if (meta.policyOneSided) disclosures.policyOneSided += 1;
      if (meta.provenanceOneSided) disclosures.provenanceOneSided += 1;
      if (meta.crossRepo) disclosures.crossRepo += 1;
      const incomparable = meta.policyOneSided || meta.provenanceOneSided;
      if (incomparable) transitions.incomparable += 1;

      // `unchanged` is deliberately STRICTER than the label `history`'s text
      // renderer prints for the same transition: an aggregate has no
      // per-transition note to disclose "one side carried no fingerprint",
      // so a pair whose metadata could not be compared cannot land in the
      // bucket whose plain meaning is "checked, nothing moved".
      if (
        !record.architectureChanged &&
        !record.providerChanged &&
        record.policyChanged !== true &&
        !record.codeDrift &&
        !incomparable
      ) {
        transitions.unchanged += 1;
      }

      if (record.changes) {
        addedProjectEvents += record.changes.addedProjects.length;
        removedProjectEvents += record.changes.removedProjects.length;
        changedProjectEvents += record.changes.changedProjects.length;
        addedEdgeEvents += record.changes.addedEdges.length;
        removedEdgeEvents += record.changes.removedEdges.length;
      }
    }
  }

  /**
   * Counts entities of `presence` that appeared in ALL `n` observations.
   * Only meaningful when `n >= 2`; the caller nulls it otherwise.
   *
   * @param {Map<string, number>} presence
   * @returns {number}
   */
  const persistentCount = (presence) => {
    let count = 0;
    for (const seen of presence.values()) if (seen === n) count += 1;
    return count;
  };

  /**
   * The endpoint-set movement between the first and last observation.
   *
   * @param {Set<string>|null} first
   * @param {Set<string>|null} current
   * @returns {{introduced: number, resolved: number}}
   */
  const endpointMovement = (first, current) => {
    let introduced = 0;
    for (const key of current) if (!first.has(key)) introduced += 1;
    let resolved = 0;
    for (const key of first) if (!current.has(key)) resolved += 1;
    return { introduced, resolved };
  };

  const projectMovement =
    available && firstProjects !== null && lastProjects !== null
      ? endpointMovement(firstProjects, lastProjects)
      : null;
  const edgeMovement =
    available && firstEdges !== null && lastEdges !== null
      ? endpointMovement(firstEdges, lastEdges)
      : null;

  /** @type {TrajectoryAxis} */
  const projects = {
    first: firstProjects === null ? 0 : firstProjects.size,
    current: lastProjects === null ? 0 : lastProjects.size,
    delta: available ? lastProjects.size - firstProjects.size : null,
    addedEvents: available ? addedProjectEvents : null,
    removedEvents: available ? removedProjectEvents : null,
    changedEvents: available ? changedProjectEvents : null,
    introduced: available ? projectMovement.introduced : null,
    resolved: available ? projectMovement.resolved : null,
    persistent: available ? persistentCount(projectPresence) : null,
  };
  /** @type {TrajectoryAxis} */
  const edges = {
    first: firstEdges === null ? 0 : firstEdges.size,
    current: lastEdges === null ? 0 : lastEdges.size,
    delta: available ? lastEdges.size - firstEdges.size : null,
    addedEvents: available ? addedEdgeEvents : null,
    removedEvents: available ? removedEdgeEvents : null,
    // No `changedEvents` on this axis: under the triple identity an edge
    // type flip is already a removal plus an addition (`./diff.mjs`).
    changedEvents: null,
    introduced: available ? edgeMovement.introduced : null,
    resolved: available ? edgeMovement.resolved : null,
    persistent: available ? persistentCount(edgePresence) : null,
  };

  return {
    observations: {
      count: n,
      basis: OBSERVATION_BASIS,
      first: n > 0 ? files[0].name : null,
      last: n > 0 ? files[n - 1].name : null,
      withProvenance,
      dirtyProvenance,
    },
    available,
    unavailableReason: available ? null : INSUFFICIENT_HISTORY,
    transitions,
    disclosures,
    projects,
    edges,
  };
}

/**
 * Runs the `trajectory` command: reads the snapshot directory, aggregates the
 * deterministic trajectory, and builds the report.
 *
 * Unlike `debt`, no boundary law is loaded: the fingerprints being compared
 * travel INSIDE the snapshots, so the law a run judges is the law each
 * observation was captured under — there is no `--config` override because
 * there is no current-law input to override with.
 *
 * @param {string} dir Absolute path to the history directory.
 * @param {object} commandContext From `resolveCommandContext` — used for the
 *   envelope's workspace header and `readSnapshots`' containment check. The
 *   trajectory itself never touches the live graph.
 * @param {{io?: {readSnapshots?: Function, resolveProvenance?: Function}}} [options]
 *   Injectable IO so a test drives the aggregation without the filesystem or
 *   git, mirroring `./history.mjs`'s seam.
 * @returns {{status: "ok", trajectory: object, coverage: object,
 *   report: {text: string, json: string}}}
 * @throws {Error} when the directory contains no snapshots or a snapshot
 *   cannot be read or validated (exit-3 class, via `readSnapshots` and the
 *   same refusal `history`/`debt` make).
 */
export function trajectoryCommand(dir, commandContext, options = {}) {
  const { root, provider, marker } = commandContext;
  const io = options.io ?? {};

  const read = (io.readSnapshots ?? readSnapshots)(dir, root);

  if (read.files.length === 0) {
    // An empty directory is not a clean trajectory — it is no record at all.
    // Zero observations would read as "nothing ever changed", a claim about a
    // history that does not exist. Same refusal, word for word in spirit, as
    // `./history.mjs` and `./debt.mjs` make.
    throw new Error(
      `archkeep: the history directory '${dir}' contains no snapshots — there is no history to ` +
        `aggregate. Capture one first with 'archkeep history <dir> --capture' (or point the ` +
        `command at the directory where you keep graph snapshots).`,
    );
  }

  const result = computeTrajectory(read.files);
  const full = { dir, ...result };

  const lastSnapshot = read.files[read.files.length - 1].envelope;
  const coverage = {
    complete: true,
    projects: lastSnapshot.result.projects.length,
    analyzedFiles: lastSnapshot.coverage.analyzedFiles,
    imports: lastSnapshot.coverage.imports,
    notAnalyzed: [],
    blindSpots: [],
    notes: [
      `counts are snapshot-relative: ${result.observations.count} observation${
        result.observations.count === 1 ? "" : "s"
      } are stored graph snapshots — capture points, not commits, days, or captures attempted`,
      "rule-impact cannot be recomputed from stored snapshots — snapshots carry the graph and " +
        "the policy fingerprint, not the constraint table or import sites, so no violation-level " +
        "trajectory is reported. Run `delta` between two live points, or `check` at any commit.",
    ],
  };

  const envelope = jsonEnvelope({
    command: "trajectory",
    context: {
      root,
      provider,
      marker,
      // The same field every other envelope carries — THIS run's git origin,
      // not the head snapshot's (`workspace.provenance` means one thing across
      // the whole envelope surface; `docs/reference/json-output.md`).
      provenance: (io.resolveProvenance ?? resolveProvenance)(root),
    },
    status: "ok",
    exitCode: 0,
    coverage,
    result: full,
  });

  return {
    status: "ok",
    trajectory: full,
    coverage,
    report: {
      text: formatTrajectoryReport({ trajectory: full, coverage }),
      json: renderJson(envelope),
    },
  };
}

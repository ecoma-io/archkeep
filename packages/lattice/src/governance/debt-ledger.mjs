/**
 * The architecture-debt ledger: the exemptions, gaps and violations a workspace
 * is carrying, each with how long it has been carried and how much of the tree
 * it touches. Pure and deterministic: given the current run's candid facts
 * (suppressions, intent notes, drift findings, unresolved intent) and the
 * history directory's snapshots, it returns one ledger. No I/O here — the
 * caller reads the snapshot directory (`../commands/history.mjs`'s
 * `readSnapshots`) and passes the files through.
 *
 * ## What is tracked, and what "age" means
 *
 * Architecture debt is an aging record, not a finance metaphor: no interest,
 * no compounding — age, count and severity only. A ledger is rebuildable at any
 * moment: it derives from the same files `check`/`drift`/`graph` already read
 * (the boundary config's `boundarySuppressions`, `judgeIntent`'s findings and
 * notes, and the history directory), so there is no private store to go stale.
 *
 * Four entry kinds cover the candidate facts:
 *
 * - **waiver** — a `boundarySuppressions` row: a violation the workspace
 *   decided to accept, with the mandatory reason it accepted it
 *   (`../config.mjs`). The debt is the accepted violation itself.
 * - **aspirational-gap** — an `"optional": true` `allowed` intent row whose
 *   statement is not yet observed: a stated dependency that is not being built.
 *   It is not drift (it changes no verdict) but it IS debt.
 * - **drift** — a drift finding: the observed architecture contradicts the
 *   declared intent (`../architecture-intent/judge.mjs`).
 * - **unresolved** — an intent boundary or row we could not verify (matched no
 *   observed project). Its severity is unknowable, so it reads `unknown` —
 *   never a clean ledger.
 *
 * ## Why age is per-project
 *
 * Snapshots carry the project graph and the policy fingerprint — not the
 * ledger facts themselves (there is no constraint table or suppression set in
 * a `graph` envelope, exactly the disclosure `../commands/history.mjs` makes
 * about rule-impact). So an entry is aged by the *owning project*: how many
 * consecutive snapshots the project the debt lives in has been part of the
 * architecture. Age is measured in snapshots, not days. A debt living in a
 * project first observed in the B-th snapshot (0-based) and head=the last of
 * n carries `age = n - B` — a project present in every snapshot has age n, one
 * we only see now has age 1. When the directory holds fewer than two
 * snapshots, `agings: false` is set and every age is 0 — a ledger built from
 * one observation says "observed, not yet aged", exactly like a history with a
 * single snapshot (`../commands/history.mjs`).
 *
 * The owning project of a waiver is the head-snapshot project whose root the
 * suppression path falls under (taking the longest matching root for
 * determinism when several nest); of a drift finding it is the finding's
 * `source` project. An aspirational gap and an unresolved intent name no
 * project, so they carry age 0.
 *
 * `referenceTime` is the ledger's clock; the shared governance clock's current
 * instant when the caller is the CLI (see `computeDebtLedger`).
 *
 * ## Severity
 *
 * One axis, three values, decidable from the facts an entry carries without a
 * second opinion:
 *
 * - **high** — a drift finding in a project that also carries an accepted
 *   waiver (the accepted violation is failing today — the ledger must never
 *   hide that), and any unresolved intent (a boundary that matched nothing
 *   means the whole comparison cannot be trusted).
 * - **medium** — any other drift finding.
 * - **low** — a waiver or an aspirational gap: both are accepted, living
 *   states, not contradictions — debt to retire, not findings to fix.
 *
 * ## The empty-result invariant
 *
 * A ledger entry MUST be readable: an unresolved intent reads `unknown`
 * (never a shrug), and when the directory cannot establish age the ledger says
 * `agings: false` rather than guessing ages. An empty entry list must mean
 * exactly "no exemptions, gaps or findings" — `computeDebtLedger` returns the
 * aggregate beside every list. A malformed snapshot directory throws in
 * `readSnapshots` (the caller's job) and surfaces as exit 3 from the command,
 * never as an empty ledger.
 */

import { referenceTime as clockReferenceTime } from "./clock.mjs";
import { EXPIRED_WAIVER_EVIDENCE, suppressionFate } from "./waiver.mjs";

/**
 * The head snapshot's projects as name → root, used to place a suppression path
 * under its owning project. Empty when there are no snapshots.
 *
 * @param {object[]} files From `readSnapshots(dir)`.
 * @returns {Map<string, string>}
 */
function headProjects(files) {
  const head = files[files.length - 1];
  const byName = new Map();
  for (const project of head?.envelope?.result?.projects ?? []) {
    if (typeof project?.name === "string" && typeof project?.root === "string") {
      byName.set(project.name, project.root);
    }
  }
  return byName;
}

/**
 * The owning project of a suppression path: the head-snapshot project whose
 * root is a path prefix of the (glob) path, choosing the longest root when
 * several nest. A glob like `packages/**` is placed by the literal prefix
 * before the wildcard; when no project's root is a prefix, the waiver maps to
 * no project and ages 0 honestly rather than guessing one.
 *
 * @param {string} path The suppression's `path`.
 * @param {Map<string, string>} byName Head project name → root.
 * @returns {string|null} The owning project name, or `null`.
 */
function owningProjectForPath(path, byName) {
  let best = null;
  let bestRoot = "";
  for (const [name, root] of byName) {
    if (root.length > bestRoot.length && (path === root || path.startsWith(root + "/"))) {
      best = name;
      bestRoot = root;
    }
  }
  return best;
}

/**
 * The complete ledger over one ordered snapshot set. Deterministic: the same
 * files, the same current facts and the same `referenceTime` produce the same
 * ledger. All lists sort by plain `<` comparison, never `localeCompare`.
 *
 * The caller is the CLI; tests may leave `referenceTime` out and receive one
 * of their own, from the shared clock (`./clock.mjs`) — not a promise two
 * test runs could share. (The ledger's own determinism is about a fixed
 * clock.)
 *
 * @param {{suppressions?: object[], intentNotes?: string[], findings?: object[],
 *   unresolved?: object[]}} current The current run's candid facts: the loaded
 *   boundary config's `suppressions`, `judgeIntent`'s `notes` (aspirational
 *   gaps), `findings` (drift), and `unresolved`.
 * @param {{files: {name: string, envelope: object, id: string}[]}} snapshots
 *   From `readSnapshots(dir)`, in history order.
 * @param {{referenceTime?: number|string}} [opts]
 * @returns {{entries: {source: string, kind: string, severity: string,
 *   age: number, count: number, remediationHint: string}[],
 *   total: number, byKind: object, bySeverity: object, agings: boolean,
 *   sampleTime: string}}
 */
export function computeDebtLedger(current, snapshots, opts = {}) {
  const referenceTime = opts.referenceTime ?? clockReferenceTime();
  const sampleTime = new Date(referenceTime).toISOString();

  const files = snapshots.files ?? [];
  const n = files.length;
  const agings = n >= 2;

  // Per-project first-seen index, in history order. A project observed for the
  // whole history has firstSeen 0 and age n; one only in the head has age 1.
  const firstSeen = new Map();
  for (let i = 0; i < n; i++) {
    for (const project of files[i].envelope?.result?.projects ?? []) {
      if (project?.name && !firstSeen.has(project.name)) firstSeen.set(project.name, i);
    }
  }
  const ageOf = (name) => {
    if (!agings) return 0;
    const first = firstSeen.get(name);
    return first === undefined ? 0 : n - first;
  };

  const byName = headProjects(files);

  /** @type {{source: string, kind: string, severity: string, age: number, count: number, remediationHint: string}[]} */
  const entries = [];

  for (const suppression of current.suppressions ?? []) {
    const project = owningProjectForPath(suppression.path, byName);
    // F06: a waiver that lapsed re-asserts — the ledger must name it, never
    // book it as a low "still suppressed" row while the gate re-asserts the
    // same row. The shared fate function (`./waiver.mjs`) is the ONE
    // authority, so `debt` and `check` cannot disagree about expiry. A legacy
    // suppression (no `expiresAt`) is `suppress`: still low and permanent.
    const fate = suppressionFate(suppression, sampleTime);
    const expired = fate === "reassert";
    entries.push({
      source: suppression.path,
      kind: expired ? "expired-waiver" : "waiver",
      severity: expired ? "medium" : "low",
      age: project ? ageOf(project) : 0,
      count: 1,
      remediationHint: expired
        ? `the waiver at '${suppression.path}' expired — the boundary it accepted is live again (${EXPIRED_WAIVER_EVIDENCE}); renew it or retire it`
        : `the accepted violation at '${suppression.path}' is still suppressed — ` +
          (project ? `owning project '${project}'` : "retire it or confirm the reason"),
    });
  }
  for (const note of current.intentNotes ?? []) {
    entries.push({
      source: note,
      kind: "aspirational-gap",
      severity: "low",
      age: 0,
      count: 1,
      remediationHint:
        "an optional allowed row is not yet built — either build it or remove the row",
    });
  }

  // Which projects hold an accepted waiver — so a drift finding in the same
  // project is a waiver-return-to-FAIL, and it is never hidden behind the
  // suppression (`../../../../AGENTS.md`). The waiver stays listed; the drift
  // finding is the current fact and ranks high, loudly.
  /** @type {Set<string>} */
  const waiverProjects = new Set();
  for (const suppression of current.suppressions ?? []) {
    const project = owningProjectForPath(suppression.path, byName);
    if (project) waiverProjects.add(project);
  }

  for (const finding of current.findings ?? []) {
    const project = typeof finding.source === "string" ? finding.source : null;
    const waiverFailed = project !== null && waiverProjects.has(project);
    entries.push({
      source: finding.source ?? finding.message,
      kind: "drift",
      severity: waiverFailed ? "high" : "medium",
      age: project ? ageOf(project) : 0,
      count: 1,
      remediationHint: waiverFailed
        ? `this drift finding is in a project with an accepted waiver — the accepted violation is failing again, resolve it or remove the waiver`
        : "a dependency the intent forbids (or allows but is not built) — resolve the contradiction",
    });
  }
  for (const unresolved of current.unresolved ?? []) {
    entries.push({
      source: unresolved.boundary,
      kind: "unresolved",
      severity: "unknown",
      age: 0,
      count: 1,
      remediationHint:
        "an intent boundary matched no observed project — the intent cannot be verified",
    });
  }

  entries.sort((a, b) =>
    a.kind !== b.kind
      ? a.kind < b.kind
        ? -1
        : 1
      : a.source < b.source
        ? -1
        : a.source > b.source
          ? 1
          : 0,
  );

  const byKind = { waiver: 0, "aspirational-gap": 0, drift: 0, unresolved: 0 };
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const entry of entries) {
    byKind[entry.kind] += 1;
    if (entry.severity !== "unknown") bySeverity[entry.severity] += 1;
  }

  return { entries, total: entries.length, byKind, bySeverity, agings, sampleTime };
}

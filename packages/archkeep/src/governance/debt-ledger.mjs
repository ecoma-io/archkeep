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

import { createHash } from "node:crypto";

import { canonicalizeJson } from "../canonical.mjs";

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
 * The stable identity of a debt entry: `sha256` of its canonical `{kind,
 * source}` — the same mechanism `eventId` uses for evolution events (one
 * pattern, one canonicalizer), never the wall clock, a sequence or a random.
 * The same fact must always hash to the same id; any caller that emits these
 * ids into an evolution event's `debt.introduced`/`debt.resolved` MUST use
 * this exact identity, or the event-linked lifecycle will never match the
 * ledger.
 *
 * `expired-waiver` maps back to `waiver`: it is the SAME accepted violation,
 * and its id must not change when its `expiresAt` passes — a fact's identity
 * cannot depend on a transient state.
 *
 * @param {string} kind The entry's `kind`.
 * @param {string} source The entry's `source` (its keying field).
 * @returns {string} The stable hex id.
 */
export function entryId(kind, source) {
  const semanticKind = kind === "expired-waiver" ? "waiver" : kind;
  return createHash("sha256")
    .update(canonicalizeJson({ kind: semanticKind, source }))
    .digest("hex");
}

/**
 * The stable identity of a structured debt fact: `entryId` over the fact's
 * canonical JSON. Where `entryId(kind, source)` keys on a single string (a
 * waiver path, an unresolved boundary), `debtFactId` keys on the full semantic
 * fact so two distinct facts can never collide on one id.
 *
 * This is the ONE identity the event-linked lifecycle links against: a
 * producer (`change`, `delta`) that emits `debt.introduced`/`debt.resolved`
 * MUST call this exact function with the same structured fact the ledger
 * derives its entry from, or the ids will never match (the broken lifecycle
 * F-DEB-1 exists to close). The fact excludes prose — a reworded message must
 * not re-key a fact (F-DEB-5 drift, F-DEB-8 aspirational gap).
 *
 * @param {string} kind The entry's `kind`.
 * @param {object} fact The structured semantic fact, e.g. a drift finding
 *   `{source, target, rule}` or an aspirational gap `{from, to}`.
 * @returns {string} The stable hex id.
 */
export function debtFactId(kind, fact) {
  return entryId(kind, canonicalizeJson(fact));
}

/**
 * The structured drift fact a judge finding keys on: `{source, target, rule}`
 * over exactly the fields that were judged. Presence findings (projectMissing,
 * projectPresent, projectTagMissing) carry no `target`; the fact spans only
 * the present fields — shared by the ledger's drift entry and every producer
 * that emits `debt.introduced`/`debt.resolved`, so they can never disagree
 * about which id a finding owns.
 *
 * @param {{source?: string, target?: string, rule?: string}} finding A judge
 *   finding (`judgeIntent`'s `{source, target, rule, …}`).
 * @returns {{source: string, target?: string, rule?: string}} The drift fact.
 */
export function driftFactOf(finding) {
  return {
    source: finding.source,
    ...(finding.target === undefined ? {} : { target: finding.target }),
    ...(finding.rule === undefined ? {} : { rule: finding.rule }),
  };
}

/**
 * The debt a base→head transition opened and closed, expressed as ledger ids
 * (design §8: `debt.introduced` names debt created, `debt.resolved` names debt
 * resolved). Two `judgeIntent` verdicts — one over the base graph, one over
 * the head graph, both judged under ONE current intent — diff on the STABLE
 * ids: a finding present at base but gone at head is resolved; present at head
 * but not base is introduced; a fact that never moved is neither. Identity
 * never depends on prose (F-DEB-5 drift, F-DEB-8 aspirational gap), so the
 * ids emitted here are byte-identical to what `computeDebtLedger` derives for
 * the same fact — the ONE home that makes the event-linked lifecycle fire.
 *
 * Aspirational gaps count as debt too: an optional row not built at base but
 * built at head is resolved debt; one that stops being built is introduced.
 *
 * @param {object} baseVerdict A `judgeIntent` result over the base graph.
 * @param {object} headVerdict A `judgeIntent` result over the head graph.
 * @returns {{introduced: string[], resolved: string[]}} Stable debt ids.
 */
export function debtChangeDiff(baseVerdict, headVerdict) {
  const driftOf = (v) => (v.findings ?? []).map((f) => debtFactId("drift", driftFactOf(f)));
  const gapOf = (v) =>
    (v.gaps ?? []).map((g) => debtFactId("aspirational-gap", { from: g.from, to: g.to }));
  const baseIds = new Set([...driftOf(baseVerdict), ...gapOf(baseVerdict)]);
  const headIds = new Set([...driftOf(headVerdict), ...gapOf(headVerdict)]);
  const introduced = [...headIds].filter((id) => !baseIds.has(id)).sort();
  const resolved = [...baseIds].filter((id) => !headIds.has(id)).sort();
  return { introduced, resolved };
}
/**
 * Reduces an `opts.events` value to a loaded event array, or `null` when no
 * event store is linked. Accepts an already-loaded array or a
 * `{ getEvents(dir) }`-shaped reader (design §4). `null` means "not linked":
 * no `introducedBy`/`resolvedBy` is ever guessed.
 *
 * @param {{events?: object[]|{getEvents?: (dir?: string) => object[]},
 *   eventsDir?: string}} opts
 * @returns {object[]|null}
 */
function loadEvents(opts) {
  if (!opts.events) return null;
  if (Array.isArray(opts.events)) return opts.events;
  if (typeof opts.events.getEvents === "function")
    return opts.events.getEvents(opts.eventsDir) ?? [];
  return null;
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
 * @param {{suppressions?: object[], intentNotes?: string[], gaps?: {from: string,
 *   to: string, note?: string}[], findings?: object[],
 *   unresolved?: object[]}} current The current run's candid facts: the loaded
 *   boundary config's `suppressions`, `judgeIntent`'s aspirational-gap facts
 *   (`gaps`, structured `{from, to}` — the identity source) with `intentNotes`
 *   as their prose display (deprecated dance when `gaps` is absent),
 *   `findings` (drift), and `unresolved`.
 * @param {{files: {name: string, envelope: object, id: string}[]}} snapshots
 *   From `readSnapshots(dir)`, in history order.
 * @param {{referenceTime?: number|string, events?: object[]|{getEvents?: (dir?: string) => object[]},
 *   eventsDir?: string}} [opts] `events` links an event store (design §4): an
 *   already-loaded array of evolution events, or a `{ getEvents(dir) }`-shaped
 *   reader. Absent ⇒ no `introducedBy`/`resolvedBy` is ever set and a
 *   `lifecycle.note` states the refs are unavailable — refs are never guessed.
 * @returns {{entries: {source: string, kind: string, severity: string,
 *   age: number, count: number, remediationHint: string, id: string,
 *   status: "active", introducedBy?: string}[],
 *   resolved: {id: string, status: "resolved", resolvedBy: string,
 *   kind: string, severity: string, age: number, count: number,
 *   remediationHint: string}[],
 *   total: number, byKind: object, bySeverity: object, agings: boolean,
 *   sampleTime: string,
 *   lifecycle: {linked: boolean, note: string|null}}}
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

  /** @type {{source: string, kind: string, severity: string, age: number, count: number, remediationHint: string, id: string, status: "active", introducedBy?: string}[]} */
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
    const kind = expired ? "expired-waiver" : "waiver";
    entries.push({
      source: suppression.path,
      kind,
      severity: expired ? "medium" : "low",
      age: project ? ageOf(project) : 0,
      count: 1,
      id: entryId(kind, suppression.path),
      status: "active",
      remediationHint: expired
        ? `the waiver at '${suppression.path}' expired — the boundary it accepted is live again (${EXPIRED_WAIVER_EVIDENCE}); renew it or retire it`
        : `the accepted violation at '${suppression.path}' is still suppressed — ` +
          (project ? `owning project '${project}'` : "retire it or confirm the reason"),
    });
  }
  // Aspirational-gap entries: an `optional: true` `allowed` row not yet built.
  // Identity comes from the STRUCTURED `{from, to}` (F-DEB-8) — never from the
  // prose note, which re-keys every gap when the wording changes. `gaps` is
  // the structured source when a caller threads it (the producer emits the
  // same `{from, to}` ids the ledger derives here); the prose `intentNotes`
  // fallback keys on the note itself only for callers that pass notes with no
  // structured gaps — a deprecated shape, retained so the identity home stays
  // single (the `debtFactId` here is the one the producers must match).
  const gaps = current.gaps ?? [];
  if (gaps.length > 0) {
    for (const gap of gaps) {
      entries.push({
        source: gap.note ?? `${gap.from} → ${gap.to}`,
        kind: "aspirational-gap",
        severity: "low",
        age: 0,
        count: 1,
        id: debtFactId("aspirational-gap", { from: gap.from, to: gap.to }),
        status: "active",
        remediationHint:
          "an optional allowed row is not yet built — either build it or remove the row",
      });
    }
  } else {
    for (const note of current.intentNotes ?? []) {
      entries.push({
        source: note,
        kind: "aspirational-gap",
        severity: "low",
        age: 0,
        count: 1,
        id: entryId("aspirational-gap", note),
        status: "active",
        remediationHint:
          "an optional allowed row is not yet built — either build it or remove the row",
      });
    }
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
    // The stable fact keys on the full semantic tuple (source, target, rule)
    // — never on `finding.source` alone, which collides every distinct
    // same-source finding onto one id (F-DEB-5), and never on the prose
    // `finding.message`, which re-keys a fact when the wording changes.
    // `driftFactOf` is the ONE builder both the ledger and the producers use,
    // so an introduced id can never disagree with the ledger's active id.
    entries.push({
      source: finding.source ?? finding.message,
      kind: "drift",
      severity: waiverFailed ? "high" : "medium",
      age: project ? ageOf(project) : 0,
      count: 1,
      id: debtFactId("drift", driftFactOf(finding)),
      status: "active",
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
      id: entryId("unresolved", unresolved.boundary),
      status: "active",
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

  // `expired-waiver` is a real `kind` an entry above can carry (a lapsed
  // waiver, F06) — seeding every kind an entry can hold is what keeps
  // `byKind[entry.kind] += 1` from landing on `undefined + 1` (`NaN`, which
  // serializes as JSON `null`) for that one kind, and what keeps
  // `sum(Object.values(byKind)) === total` true for every entry set.
  const byKind = {
    waiver: 0,
    "expired-waiver": 0,
    "aspirational-gap": 0,
    drift: 0,
    unresolved: 0,
  };
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const entry of entries) {
    byKind[entry.kind] += 1;
    if (entry.severity !== "unknown") bySeverity[entry.severity] += 1;
  }

  // The lifecycle surface (design §6): every active entry carries a stable id
  // and `status: "active"`. When an event store is linked, REPAIR events name
  // the debt they closed (`debt.resolved`) and introduction events name what
  // they opened (`debt.introduced`); the closure is only accepted when the
  // candidate fact is NOT still active at head (an id that came back is not
  // resolved). Without a linked store, `resolved` stays empty and no ref is
  // ever fabricated — the note states the refs are unavailable instead.
  const events = loadEvents(opts);
  const activeIds = new Set(entries.map((entry) => entry.id));
  /** @type {{id: string, status: "resolved", resolvedBy: string, kind: string, severity: string, age: number, count: number, remediationHint: string}[]} */
  const resolved = [];
  const lifecycle = { linked: events !== null, note: null };

  if (events === null) {
    lifecycle.note = "no event store linked — lifecycle refs unavailable";
  } else {
    /** @type {Map<string, string>} id → the first event that introduced it. */
    const introducedByForId = new Map();
    /** @type {Set<string>} debt ids already placed on the resolved list. */
    const resolvedSeen = new Set();
    for (const event of events) {
      // The store validates that every event carries a string id, but the
      // reader shape is loosely typed — coerce so the ref string is always a
      // real string, never a fabricated one.
      const eventId = typeof event?.id === "string" ? event.id : "";
      for (const debtId of event?.debt?.introduced ?? []) {
        if (typeof debtId === "string" && !introducedByForId.has(debtId)) {
          introducedByForId.set(debtId, eventId);
        }
      }
      const repairs = Array.isArray(event?.classifications)
        ? event.classifications.includes("REPAIR")
        : false;
      if (!repairs) continue;
      for (const debtId of event?.debt?.resolved ?? []) {
        // Closure is only real when the candidate fact is gone at head; a
        // debt id still active is not resolved (closed then re-opened).
        if (typeof debtId !== "string" || activeIds.has(debtId) || resolvedSeen.has(debtId))
          continue;
        resolvedSeen.add(debtId);
        resolved.push({
          id: debtId,
          status: "resolved",
          resolvedBy: eventId,
          kind: "debt",
          severity: "unknown",
          age: 0,
          count: 1,
          remediationHint: `closed by evolution event '${eventId}' — the underlying violation is no longer a current finding`,
        });
      }
    }
    for (const entry of entries) {
      const introducedBy = introducedByForId.get(entry.id);
      if (introducedBy !== undefined) entry.introducedBy = introducedBy;
    }
  }
  resolved.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    entries,
    resolved,
    total: entries.length,
    byKind,
    bySeverity,
    agings,
    sampleTime,
    lifecycle,
  };
}

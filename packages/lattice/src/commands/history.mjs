/**
 * The `history` command: the architecture's evolution across time, read from
 * a consumer-managed directory of graph snapshots.
 *
 * `history <dir>` reads every `graph --format json` envelope in a directory
 * (the directory is the sole source of truth — no index file, no database)
 * and produces one evolution record: the snapshots in history order and the
 * transitions between consecutive ones, each transition classified by the
 * verifiable signals it carries.
 *
 * `--capture` appends a snapshot of the current workspace first — writing
 * `<seq>-<sha8>.json` (a zero-padded monotonic sequence and the snapshot's
 * architecture identity, so filename byte-sort IS history order) — then
 * produces the record that includes it. Capture deduplicates: when the
 * current architecture identity matches the last snapshot, no new file is
 * written and no empty transition is manufactured. The capture answer — was
 * this a new snapshot (`duplicate: false`) or a dedup against the last one
 * (`duplicate: true`)? — is an always-present field, so the envelope's shape
 * is not a function of prior directory state (E-F05).
 *
 * The snapshots are full graph envelopes, not deltas. Each is
 * content-addressable (its identity derives from its own bytes) and
 * self-validating (`parseBaseline` refuses a malformed or incomplete one),
 * so a corrupted or truncated file stops the record loudly instead of
 * degrading it.
 *
 * It is descriptive: it never exits 1. A description of how the architecture
 * evolved is never a finding (only `check` ever exits 1). An empty directory
 * or an unreadable snapshot is a no-verdict run (exit 3), never a record of
 * nothing.
 *
 * ## Why a directory, not an index
 *
 * An index file would be a second copy of facts the snapshot files already
 * hold, and two copies drift — the same reason `scripts/check-packages.mjs`
 * derives its target list from `ci.yml` rather than holding a copy
 * (`../../../../AGENTS.md`). The directory is ordered by filename byte-sort;
 * a snapshot is replaced or deleted by moving its file; a `history` that
 * cannot make sense of the directory says so instead of guessing.
 *
 * ## What a transition can and cannot assert
 *
 * A transition between two complete snapshots is classified by signals the
 * snapshots actually carry, never by inference:
 *
 * - **architecture** — the graph diff (`computeDiff`). Added/removed/changed
 *   projects and edges are a change to the architecture itself.
 * - **policy / intent** — the `policy.fingerprint` carried in each snapshot,
 *   compared by `./snapshot-meta.mjs`. In 1.x the boundary law a workspace
 *   declares IS its stated architectural intent; the fingerprint is that law
 *   content-addressed. A fingerprint change is one signal with two names:
 *   the policy changed, and the intent it encodes changed. There is no
 *   separate, unverifiable "intent" field (a snapshot carries no record of a
 *   team's reasons), so this command never invents one.
 * - **provider-configuration** — the `workspace.provider` header. A native →
 *   nx migration is a change to how the architecture is read, and structural
 *   differences on either side of it are provider-artefacts, not
 *   architecture.
 * - **code drift** — provenance (git commit) advancing while the architecture
 *   and policy are unchanged is a disclosure, not a change classification:
 *   the code moved without the architecture moving, which is exactly the
 *   state an "architecture evolution" lens must name rather than bury.
 * - **coverage / intent caveats** — everything a snapshot does not carry is
 *   disclosed, never asserted: rule-impact cannot be recomputed from stored
 *   snapshots (there is no constraint table in them), so each record names
 *   that limit.
 *
 * What it needs from its caller is a `CommandContext` for the head (used
 * only for `--capture`), the directory path, and an IO seam. It does not
 * print, and it does not decide the process's exit code — `../../cli.mjs`
 * owns those (`./README.md`).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { isWholeFileFailure } from "../analysis/source-util.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatHistoryReport } from "../report/history-text.mjs";
import { computeDiff, parseBaseline } from "./diff.mjs";
import { buildDependencies, buildProjects } from "./graph.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { compareSnapshotMetadata } from "./snapshot-meta.mjs";

/**
 * A graph envelope's architecture identity: the part that determines whether
 * the architecture itself changed, independent of which machine, which
 * workspace root, or which provider revision read it.
 *
 * The identity is a SHA-256 of the canonicalized JSON of the fields
 * `computeDiff` actually compares — projects and dependencies — plus the
 * policy fingerprint when the snapshot carries one. The policy fingerprint is
 * included because a policy is architectural intent: `--capture` must write a
 * new snapshot when the law changes even if the graph did not move.
 *
 * The project serialization deliberately drops every field beyond the graph
 * diff's four (`name`, `root`, `type`, `tags`), so "identity moved" always
 * coincides with "the diff sees an architectural change" — and a build-target
 * change (which `buildProjects` emits but `computeDiff` deliberately ignores)
 * neither moves the identity nor manufacturers an empty transition. The same
 * lossiness is what keeps future graph fields from fabricating a false
 * architecture change. The workspace header (`root`, `provider`, `marker`,
 * `provenance`) is excluded — the root is a local path that varies by machine,
 * and provider/provenance are facts about the reading, not the architecture.
 * Provider and provenance changes surface through the transition
 * classification instead.
 *
 * @param {{projects: object[], dependencies: object[], policy?: {fingerprint: string}|null}} snapshot
 * @returns {string} A hex-encoded SHA-256.
 */
export function snapshotIdentity({ projects, dependencies, policy }) {
  const identityProjects = projects.map(({ name, root, type, tags }) => ({
    name,
    root,
    type,
    tags,
  }));
  const canonical = JSON.stringify(
    { projects: identityProjects, dependencies, policy: policy?.fingerprint ?? null },
    (_, value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, value[key]]),
          )
        : value,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Reads and validates every snapshot in the history directory.
 *
 * The directory is the sole source of truth, so this refuses loudly on any
 * condition that would make the record dishonest: an unreadable snapshot, a
 * file that is not a complete graph envelope, or a directory that does not
 * exist. It deliberately ignores `.tmp` files — an interrupted `--capture`
 * leaves one behind, and that must never count as a snapshot. Two snapshots
 * may share an architecture identity at non-adjacent positions (an A → B → A
 * evolution is real history); only capture dedups, against the last file.
 *
 * @param {string} dir Absolute path to the history directory.
 * @returns {{files: {name: string, path: string, envelope: object, id: string}[]}}
 * @throws {Error} when the directory cannot be read, or on the first
 *   unreadable or malformed snapshot.
 */
export function readSnapshots(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (cause) {
    throw new Error(
      `lattice: cannot read the history directory '${dir}': ${cause?.message ?? cause}`,
      { cause },
    );
  }
  names = names.filter((name) => name.endsWith(".json") && !name.endsWith(".json.tmp"));
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const files = [];
  for (const name of names) {
    const path = join(dir, name);
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (cause) {
      throw new Error(
        `lattice: cannot read the history snapshot '${path}': ${cause?.message ?? cause}`,
        { cause },
      );
    }
    const parsed = parseBaseline(text, path);
    files.push({
      name,
      path,
      envelope: {
        coverage: parsed.coverage,
        result: {
          projects: parsed.projects,
          dependencies: parsed.dependencies,
          policy: parsed.policy ?? undefined,
        },
        workspace: { provider: parsed.provider, provenance: parsed.provenance },
      },
      id: snapshotIdentity({
        projects: parsed.projects,
        dependencies: parsed.dependencies,
        policy: parsed.policy,
      }),
    });
  }
  return { files };
}

/**
 * The short filename suffix for a snapshot identity.
 *
 * @param {string} id Full hex SHA-256 from `snapshotIdentity`.
 * @returns {string} First 8 hex characters.
 */
export function shortId(id) {
  return id.slice(0, 8);
}

/**
 * The zero-padded sequence number for `--capture`, taken from the highest
 * existing snapshot filename. `0001` for a fresh directory.
 *
 * The width widens from a four-digit minimum rather than overflowing: a
 * `10000` that padded to four digits would byte-sort *before* `9999-…` and
 * silently rewind history order, and the sequence regex would stop seeing the
 * 5-digit name so repeated captures would clobber the same file. Fresh
 * directories start at `0001`; each subsequent capture pads to at least the
 * width the next number needs, so the sequence always advances and no two
 * captures ever target the same file.
 *
 * @param {{files: {name: string}[]}} read From `readSnapshots`.
 * @returns {string} Zero-padded sequence, at least four digits.
 */
export function nextSequence(read) {
  let max = 0;
  for (const file of read.files) {
    const match = /^(\d+)-/.exec(file.name);
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  const width = Math.max(4, String(max + 1).length);
  return String(max + 1).padStart(width, "0");
}

/**
 * Computes the evolution record from a list of snapshots: history order,
 * each snapshot's identity, and the classified transition from each to the
 * next.
 *
 * A transition's `architectureChanged` is the graph diff alone — a pure
 * policy change (same graph, different fingerprint) is classified as a policy
 * change, not as an architecture change. A provenance advance on a transition
 * where neither the architecture nor the policy changed is disclosed as code
 * drift: the code moved without the architecture moving, which an
 * "architecture evolution" lens must name rather than bury.
 *
 * @param {{name: string, path: string, envelope: object, id: string}[]} files
 * @returns {{snapshots: {name: string, id: string}[],
 *   transitions: {from: string, to: string, architectureChanged: boolean,
 *     changes: object|null, policyChanged: boolean|null, providerChanged: boolean,
 *     codeDrift: boolean, notes: string[]}[]}}
 */
export function computeEvolution(files) {
  const snapshots = files.map((file) => ({ name: file.name, id: file.id }));
  const transitions = [];

  for (let i = 0; i + 1 < files.length; i++) {
    const from = files[i];
    const to = files[i + 1];
    const meta = compareSnapshotMetadata({
      baselineProvider: from.envelope.workspace.provider,
      headProvider: to.envelope.workspace.provider,
      baselineProvenance: from.envelope.workspace.provenance,
      headProvenance: to.envelope.workspace.provenance,
      baselineFingerprint: from.envelope.result.policy?.fingerprint ?? null,
      headFingerprint: to.envelope.result.policy?.fingerprint ?? null,
    });

    const notes = [];
    if (meta.policyChanged === true) {
      // A policy change is disclosed the way `diff` discloses it — a fact
      // about how the transition must be interpreted, not a structural
      // change and not a refusal.
      notes.push(
        "policy (the declared architectural intent) changed between these snapshots — " +
          "the boundary law differs even though the graph may not",
      );
    }
    if (meta.providerChanged) {
      notes.push(
        `provider changed (${from.envelope.workspace.provider} → ${to.envelope.workspace.provider}) — ` +
          "structural differences may be provider-artefacts rather than real architectural changes",
      );
    }
    if (meta.crossRepo) {
      notes.push("provenance remotes differ — these snapshots may be from unrelated repositories");
    }
    // The one-sided cases are the silent direction: a fingerprint or
    // provenance on one snapshot and not the other cannot be asserted "the
    // same", so it is disclosed rather than read as unchanged.
    if (meta.policyOneSided) {
      notes.push(
        "policy (the declared architectural intent) could not be compared — one snapshot " +
          "records the boundary law and the other does not",
      );
    }
    if (meta.provenanceOneSided) {
      notes.push(
        "repository provenance could not be compared — one snapshot records its origin and the other does not",
      );
    }
    // A snapshot taken from a dirty tree is not a reproducible claim about the
    // commit it names, so the transition says which side came from one rather
    // than reading it as a claim about committed history.
    if (meta.dirtyBaseline) {
      const commit = from.envelope.workspace.provenance?.commit;
      notes.push(
        "the baseline snapshot was captured from an uncommitted (dirty) tree — its architecture " +
          `is a claim about uncommitted state${typeof commit === "string" ? `, not about commit '${commit}'` : ""}`,
      );
    }
    if (meta.dirtyHead) {
      const commit = to.envelope.workspace.provenance?.commit;
      notes.push(
        "the head snapshot was captured from an uncommitted (dirty) tree — its architecture " +
          `is a claim about uncommitted state${typeof commit === "string" ? `, not about commit '${commit}'` : ""}`,
      );
    }

    const diff = computeDiff(
      {
        projects: from.envelope.result.projects,
        dependencies: from.envelope.result.dependencies,
      },
      {
        projects: to.envelope.result.projects,
        dependencies: to.envelope.result.dependencies,
      },
    );
    const architectureChanged =
      diff.addedProjects.length > 0 ||
      diff.removedProjects.length > 0 ||
      diff.changedProjects.length > 0 ||
      diff.addedEdges.length > 0 ||
      diff.removedEdges.length > 0;

    // Code drift is a disclosure, so it is only asserted when every signal
    // that could refute it is verifiable and unchanged: the architecture did
    // not move, the policy was actually compared and did not change, and
    // provenance advanced. A `null` policyChanged (one-sided, or neither
    // snapshot carries a fingerprint) is "could not be compared", not "the
    // same" — asserting code drift on an unverifiable policy would report a
    // clean transition where the tool cannot look.
    const codeDrift =
      !architectureChanged && meta.policyChanged === false && meta.provenanceChanged === true;

    transitions.push({
      from: from.name,
      to: to.name,
      architectureChanged,
      // A provider change is rendered with an empty diff (no graph change on
      // top of a carrier change), a policy-only transition with null — so a
      // consumer can tell "the carrier changed" from "only the record's
      // interpretation changed".
      changes: architectureChanged || meta.providerChanged ? diff : null,
      policyChanged: meta.policyChanged,
      providerChanged: meta.providerChanged,
      codeDrift,
      notes,
    });
  }

  return { snapshots, transitions };
}

/**
 * Runs the `history` command.
 *
 * `--capture` writes a snapshot of the current workspace before reading the
 * directory, deduplicating on the architecture identity. When the capture's
 * identity matches the last snapshot, no file is written — the record is a
 * claim over the snapshots that exist, and manufacturing a new file for an
 * unchanged architecture would make history lie about the space between
 * snapshots.
 *
 * @param {string} dir Absolute path to the history directory.
 * @param {object} commandContext From `resolveCommandContext` — used only for
 *   `--capture`.
 * @param {{capture?: boolean, policyFingerprint?: string|null, io?: {readSnapshots?: Function,
 *   writeFile?: Function, resolveProvenance?: Function}}} [options] `policyFingerprint`
 *   is the boundary law's fingerprint when one is available, so a captured
 *   snapshot records the policy it was taken under. Injectable IO lets a test
 *   drive capture without the filesystem; `writeFile` receives the absolute
 *   target path and the rendered JSON string.
 * @returns {{status: "ok"|"no-verdict", evolution: object, coverage: object,
 *   report: {text: string, json: string}}}
 * @throws {Error} when the directory contains no snapshots, when a snapshot
 *   cannot be read or validated, or when the head graph has incomplete
 *   coverage under `--capture`.
 */
export function historyCommand(
  dir,
  commandContext,
  { capture = false, policyFingerprint = null, io = {} } = {},
) {
  const readSnapshotsFromDisk = io.readSnapshots ?? readSnapshots;
  // Default write is atomic: write the full snapshot to `<name>.json.tmp`,
  // then rename over the final name. `readSnapshots` filters `.json.tmp` out,
  // so an interrupted capture leaves a partial file the record will never read.
  // `{flag: "wx"}` refuses rather than follows a symlink already sitting at
  // the `.tmp` path — `../../cli.mjs`'s `writeOutputReport` docstring owns the
  // full mechanism and the threat it closes; `--capture`'s snapshot name is
  // predictable from the observed graph, which is exactly what makes a
  // planted `.tmp` symlink here practical rather than theoretical.
  const writeSnapshotFile =
    io.writeFile ??
    ((path, text) => {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, text, { flag: "wx" });
      renameSync(tmp, path);
    });
  const provenanceResolver = io.resolveProvenance ?? resolveProvenance;

  let read;
  let captured = null;
  if (capture) {
    const notAnalyzed = commandContext.analysis.failures
      .filter(isWholeFileFailure)
      .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));
    if (notAnalyzed.length > 0) {
      throw new Error(
        `lattice: the head graph has incomplete coverage — ${notAnalyzed.length} file` +
          `${notAnalyzed.length === 1 ? "" : "s"} could not be analyzed, so a captured snapshot ` +
          `would under-represent the real architecture. Fix the unanalyzed files and re-run.`,
      );
    }

    read = readSnapshotsFromDisk(dir);

    const head = {
      projects: buildProjects(commandContext.graph.nodes),
      dependencies: buildDependencies(commandContext.graph.dependencies),
    };
    const headPolicy = policyFingerprint ? { fingerprint: policyFingerprint } : null;
    const id = snapshotIdentity({ ...head, policy: headPolicy });

    const last = read.files[read.files.length - 1];
    if (last && last.id === id && last.envelope.workspace.provider === commandContext.provider) {
      // Same architecture identity AND the same provider as the last snapshot —
      // writing a new file would manufacture a transition that does not exist.
      // A changed provider is not deduplicated: a pure provider migration
      // (nx → moon with an identical graph and policy) changes how the
      // architecture is read, so it must surface as a transition rather than be
      // swallowed by the identity match.
      //
      // `duplicate` is an ALWAYS-PRESENT boolean sibling, never an
      // only-when-true appended key: the capture envelope's shape must not be
      // a function of history-directory state (E-F05). Two captures over an
      // unchanged tree differ in exactly this one readable field, never in
      // which keys exist — a consumer diffing run#1 vs run#2 can see it is
      // the "was this a new snapshot" answer, not a structural change.
      captured = { name: last.name, id, duplicate: true };
    } else {
      const sequence = nextSequence(read);
      const name = `${sequence}-${shortId(id)}.json`;
      const path = join(dir, name);
      const provenance = provenanceResolver(commandContext.root);
      const envelope = jsonEnvelope({
        command: "graph",
        context: {
          root: commandContext.root,
          provider: commandContext.provider,
          marker: commandContext.marker,
          provenance,
        },
        status: "ok",
        exitCode: 0,
        coverage: {
          complete: true,
          projects: head.projects.length,
          analyzedFiles: commandContext.analysis.analyzed,
          imports: commandContext.analysis.imports.length,
          notAnalyzed: [],
          blindSpots: commandContext.analysis.failures
            .filter((f) => !isWholeFileFailure(f))
            .map(({ sourceFile, line, column, reason }) => ({
              file: sourceFile,
              line,
              column,
              reason,
            })),
          notes: [],
        },
        result: { ...head, policy: headPolicy ?? undefined },
      });
      writeSnapshotFile(path, renderJson(envelope));
      captured = { name, id, duplicate: false };
      read.files.push(envelopeToSnapshot(envelope, path, id));
    }
  } else {
    read = readSnapshotsFromDisk(dir);
  }

  if (read.files.length === 0) {
    // An empty directory is not an empty history — it is no record at all.
    // "0 snapshots" would read as a claim about a history that never existed.
    throw new Error(
      `lattice: the history directory '${dir}' contains no snapshots — there is no history ` +
        `to describe. Capture one first with 'lattice history <dir> --capture' (or point the ` +
        `command at the directory where you keep graph snapshots).`,
    );
  }

  const evolution = computeEvolution(read.files);

  const lastSnapshot = read.files[read.files.length - 1].envelope;
  const coverage = {
    complete: true,
    projects: lastSnapshot.result.projects.length,
    analyzedFiles: lastSnapshot.coverage.analyzedFiles,
    imports: lastSnapshot.coverage.imports,
    notAnalyzed: [],
    blindSpots: [],
    notes: [
      "rule-impact cannot be recomputed from stored snapshots — snapshots carry the graph and " +
        "the policy fingerprint, not the constraint table or import sites. Run `check` at any " +
        "commit for the boundary verdict; run `diff` for one transition's rule-impact.",
    ],
  };

  const context = {
    root: commandContext.root,
    provider: commandContext.provider,
    marker: commandContext.marker,
    provenance: provenanceResolver(commandContext.root),
  };
  const result = {
    dir,
    captured,
    snapshots: evolution.snapshots,
    transitions: evolution.transitions,
  };

  const envelope = jsonEnvelope({
    command: "history",
    context,
    status: "ok",
    exitCode: 0,
    coverage,
    result,
  });

  return {
    status: "ok",
    evolution: result,
    coverage,
    report: {
      text: formatHistoryReport({ evolution: result, coverage }),
      json: renderJson(envelope),
    },
  };
}

/**
 * Rebuilds the shape `readSnapshots` produces from an envelope this command
 * just wrote, so a capture need not round-trip through the filesystem. Kept
 * private: `readSnapshots` is the only reader a caller sees.
 *
 * @param {object} envelope The envelope `jsonEnvelope` built for the capture.
 * @param {string} path The absolute path it was written to.
 * @param {string} id The identity already computed for this snapshot — passed
 *   through rather than recomputed, so a capture hashes the architecture once
 *   and the record and the filename share that one hash.
 * @returns {{name: string, path: string, envelope: object, id: string}}
 */
function envelopeToSnapshot(envelope, path, id) {
  return {
    name: basename(path),
    path,
    envelope: {
      coverage: envelope.coverage,
      result: envelope.result,
      workspace: {
        provider: envelope.workspace.provider,
        provenance: envelope.workspace.provenance,
      },
    },
    id,
  };
}

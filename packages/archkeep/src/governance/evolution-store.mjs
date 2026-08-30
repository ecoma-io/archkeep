/**
 * The append-only evolution event store (design §3): one event per file,
 * `<NNNN>-<id8>.json`, written atomically and idempotently. `docs/concepts/evolution.md`
 * states the store semantics; this module implements them.
 *
 * Four properties, each with a mechanism:
 *
 * - **Append-only.** There is no update and no delete in this module, by
 *   construction — the only write path creates a new file. State change is a
 *   new event; rewriting history is impossible.
 * - **Idempotent.** `writeEvent` scans the directory for an existing event
 *   with the same `dedupeKey` BEFORE writing. The key is the canonical
 *   `{base, head, declarationDigest}` tuple `evolution-event.mjs` defines — the
 *   same tuple the id hashes — so a rerun over the same transition finds the
 *   earlier event and returns `{duplicate: true}` writing nothing, the
 *   always-present `duplicate` sibling `commands/history.mjs`'s capture uses so
 *   the envelope shape never depends on directory state. A file that cannot be
 *   parsed during the scan throws: a corrupt store must never silently
 *   manufacture a duplicate of the record it could not read.
 * - **Atomic.** The write goes to `<path>.json.tmp` opened with `{flag: "wx"}`
 *   (refusing rather than following a symlink already sitting there), then
 *   `rename` over the final name — the same mechanism as history's
 *   `writeSnapshotFile` (`../commands/history.mjs`). Reads filter `.json.tmp`
 *   out, so an interrupted write leaves a partial file the store will never
 *   read. The final-name rule from containment still applies: the `.tmp` name
 *   is not walked by the containment probe, and `wx` is what refuses a planted
 *   symlink at it.
 * - **Contained.** A write is checked against the workspace root the same way
 *   `--output` is (`../containment.mjs`): `io.root` is REQUIRED, and a path
 *   whose intermediate components are workspace-controlled symlinks is refused
 *   loudly rather than silently landing outside the tree. A directory the
 *   caller names outside the root string is the caller's explicit choice and
 *   proceeds, exactly like `--output /tmp`.
 *
 * Sequence numbers are zero-based (`0000`, `0001`, …) and widen from a
 * four-digit minimum rather than overflowing — the same mechanism as history's
 * `nextSequence` (`../commands/history.mjs`), offset by one because a capture
 * sequence is an ordinal while an event log is an index. `shortId` is history's
 * `shortId` (first 8 hex chars of the id).
 */

import {
  mkdirSync as defaultMkdir,
  readdirSync as defaultReaddir,
  readFileSync as defaultReadFile,
  renameSync as defaultRename,
  writeFileSync as defaultWriteFile,
  lstatSync as defaultLstat,
  realpathSync as defaultRealpath,
} from "node:fs";
import { join, resolve } from "node:path";

import { containmentViolation } from "../containment.mjs";
import {
  eventDedupeKey,
  eventId,
  EVOLUTION_EVENT_SCHEMA_VERSION,
  EVENT_CLASSIFICATIONS,
  EVENT_DISPOSITIONS,
} from "./evolution-event.mjs";

/**
 * The zero-padded sequence number for the next event, taken from the highest
 * existing event filename: `0000` for a fresh directory. An event log is
 * zero-based — the first event is index 0 — unlike history's capture
 * ordinals, which start at `0001`. The width widens from a four-digit minimum
 * rather than overflowing, for the same reason history's `nextSequence`
 * documents: a `10000` padded to four digits would byte-sort before `9999-…`
 * and silently rewind the log, and the sequence regex would stop seeing the
 * 5-digit name so repeated writes would clobber one file.
 *
 * @param {string[]} names Event filenames from the directory read.
 * @returns {string} Zero-padded sequence, at least four digits.
 */
function nextSequence(names) {
  // `max` starts at -1 so a fresh directory sequences from 0000.
  let max = -1;
  for (const name of names) {
    const match = /^(\d+)-/.exec(name);
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  const width = Math.max(4, String(max + 1).length);
  return String(max + 1).padStart(width, "0");
}
/**
 * The short filename suffix for an event id — history's `shortId` (`../commands/history.mjs`):
 * first 8 hex characters.
 *
 * @param {string} id Full hex SHA-256 from `eventId`.
 * @returns {string} First 8 hex characters.
 */
function shortId(id) {
  return id.slice(0, 8);
}

/**
 * Refuses an event whose identity does not match its content. `id` and
 * `dedupeKey` are derived, never free-form: a record whose fields disagree
 * with the canonical tuple would dedupe against the wrong key on rerun and
 * silently manufacture duplicates — the failure shape this store exists to
 * rule out.
 *
 * @param {object} event The event to write.
 * @throws {Error} naming the mismatch.
 */
function validateEventForWrite(event) {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new Error("archkeep: writeEvent requires an EvolutionEvent object");
  }
  const expectedId = eventId(event);
  const expectedKey = eventDedupeKey(event);
  if (typeof event.id !== "string") {
    throw new Error("archkeep: refusing to write the evolution event: the record carries no 'id'");
  }
  if (event.id !== expectedId) {
    throw new Error(
      "archkeep: refusing to write the evolution event: its 'id' does not match the canonical " +
        "tuple {base, head, declarationDigest}",
    );
  }
  if (typeof event.dedupeKey !== "string") {
    throw new Error(
      "archkeep: refusing to write the evolution event: the record carries no 'dedupeKey'",
    );
  }
  if (event.dedupeKey !== expectedKey) {
    throw new Error(
      "archkeep: refusing to write the evolution event: its 'dedupeKey' does not match the canonical " +
        "tuple {base, head, declarationDigest}",
    );
  }
}

/**
 * The three validations every stored event must pass: the schema version, the
 * classification subset, and the disposition. Any other shape is a malformed
 * store — thrown, never read as an event.
 *
 * @param {object} parsed The parsed record.
 * @param {string} path The file it came from, for the error message.
 * @throws {Error} naming the file and the violated check.
 */
function validateEventRecord(parsed, path) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `archkeep: malformed evolution event '${path}': the record is not a JSON object`,
    );
  }
  if (parsed.schemaVersion !== EVOLUTION_EVENT_SCHEMA_VERSION) {
    throw new Error(
      `archkeep: malformed evolution event '${path}': schemaVersion ${JSON.stringify(
        parsed.schemaVersion,
      )} is not ${EVOLUTION_EVENT_SCHEMA_VERSION}`,
    );
  }
  if (
    !Array.isArray(parsed.classifications) ||
    parsed.classifications.some((entry) => !EVENT_CLASSIFICATIONS.includes(entry))
  ) {
    throw new Error(
      `archkeep: malformed evolution event '${path}': classifications must be a subset of ` +
        `[${EVENT_CLASSIFICATIONS.join(", ")}]`,
    );
  }
  if (!EVENT_DISPOSITIONS.includes(parsed.disposition)) {
    throw new Error(
      `archkeep: malformed evolution event '${path}': disposition ${JSON.stringify(
        parsed.disposition,
      )} is not one of [${EVENT_DISPOSITIONS.join(", ")}]`,
    );
  }
}

/**
 * Appends one event to the store at `dir`.
 *
 * Idempotency first: the directory is scanned for an event whose `dedupeKey`
 * matches BEFORE anything is written; a match returns `{id, duplicate: true}`
 * and writes nothing. Then the event is written atomically
 * (`<path>.json.tmp` + rename, `{flag: "wx"}`) under a containment check
 * against `io.root`. A missing directory is an empty store: it is created
 * before the scan, so the first event in a fresh store lands at `0000`.
 *
 * The event's `id`/`dedupeKey` must match the canonical tuple (see
 * `validateEventForWrite`) — a caller cannot persist a record whose identity
 * lies about its content.
 *
 * @param {string} dir Absolute or relative path to the event store directory.
 * @param {object} event The EvolutionEvent to append.
 * @param {{root?: string, readdirSync?: (path: string) => string[],
 *   readFileSync?: (path: string, encoding: "utf8") => string,
 *   writeFileSync?: (path: string, text: string, options: object) => void,
 *   renameSync?: (from: string, to: string) => void,
 *   mkdirSync?: (path: string, options: {recursive: boolean}) => void,
 *   lstatSync?: (path: string) => {isSymbolicLink: () => boolean},
 *   realpathSync?: (path: string) => string}} [io]
 *   Injectable filesystem seams, defaulting to the sync `node:fs` calls this
 *   module uses; `root` is the workspace root the containment check is made
 *   against and is REQUIRED for a write.
 * @returns {{id: string, duplicate: boolean}} The event id, and whether this
 *   call wrote nothing because the event already existed.
 * @throws {Error} on a mismatched event identity, an unreadable or malformed
 *   store, a containment violation, or a `wx` refusal.
 */
export function writeEvent(dir, event, io = {}) {
  validateEventForWrite(event);

  const readDir = io.readdirSync ?? defaultReaddir;
  const readFile = io.readFileSync ?? defaultReadFile;
  const writeFile = io.writeFileSync ?? defaultWriteFile;
  const rename = io.renameSync ?? defaultRename;
  const makeDir = io.mkdirSync ?? defaultMkdir;
  const lstat = io.lstatSync ?? defaultLstat;
  const realpath = io.realpathSync ?? defaultRealpath;

  // Resolved once: the identical string feeds the containment check and the
  // actual write (`../containment.mjs`, "One contract binds the WRITE call
  // sites"). `resolve` also collapses any `..`, which containment refuses raw.
  const dirAbs = resolve(dir);

  let names;
  try {
    names = readDir(dirAbs);
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      // An absent optional store is an empty store: the caller's first event.
      makeDir(dirAbs, { recursive: true });
      names = readDir(dirAbs);
    } else {
      throw new Error(
        `archkeep: cannot read the event store '${dirAbs}': ${cause?.message ?? cause}`,
        { cause },
      );
    }
  }

  const eventNames = names.filter((name) => name.endsWith(".json") && !name.endsWith(".json.tmp"));
  eventNames.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // The dedupe scan. A file that cannot be parsed, or that parses to a record
  // without a string dedupeKey, throws: a store this module cannot read must
  // not be silently appended to — the unreadable file may BE the duplicate.
  for (const name of eventNames) {
    const existingPath = join(dirAbs, name);
    let text;
    try {
      text = readFile(existingPath, "utf8");
    } catch (cause) {
      throw new Error(
        `archkeep: cannot read the evolution event '${existingPath}': ${cause?.message ?? cause}`,
        { cause },
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new Error(
        `archkeep: malformed evolution event '${existingPath}': ${cause?.message ?? cause}`,
        { cause },
      );
    }
    if (typeof parsed?.dedupeKey !== "string") {
      throw new Error(
        `archkeep: malformed evolution event '${existingPath}': the record carries no string 'dedupeKey'`,
      );
    }
    if (parsed.dedupeKey === event.dedupeKey) {
      return { id: event.id, duplicate: true };
    }
  }

  const sequence = nextSequence(eventNames);
  const name = `${sequence}-${shortId(event.id)}.json`;
  const path = join(dirAbs, name);

  if (io.root === undefined) {
    throw new Error(
      "archkeep: writing an evolution event requires io.root — the workspace root — so the " +
        "write can be proven to stay inside the workspace",
    );
  }
  const violation = containmentViolation(io.root, path, {
    forWrite: true,
    lstatSync: lstat,
    realpathSync: realpath,
  });
  if (violation !== null) {
    throw new Error(`archkeep: refusing to write the evolution event '${path}': ${violation}`);
  }

  const tmp = `${path}.tmp`;
  writeFile(tmp, `${JSON.stringify(event, null, 2)}\n`, { flag: "wx" });
  rename(tmp, path);

  return { id: event.id, duplicate: false };
}

/**
 * Reads and validates every event in the store at `dir`, in filename order
 * (the append order). A malformed file — JSON that does not parse, a
 * non-object record, a wrong `schemaVersion`, a classification outside the
 * vocabulary, a disposition outside the vocabulary — THROWS; the command layer
 * maps that to exit 3, and "could not read the store" never reads as "no
 * events recorded" (the invariant: an empty result is a claim, not a shrug).
 * A missing directory is `[]` — an absent OPTIONAL store is not an error, and
 * the caller states "no events recorded" itself when that matters.
 *
 * `.json.tmp` files are filtered out: an interrupted write leaves one behind,
 * and it must never count as an event.
 *
 * @param {string} dir Path to the event store directory.
 * @param {{readdirSync?: (path: string) => string[],
 *   readFileSync?: (path: string, encoding: "utf8") => string}} [io]
 * @returns {object[]} The validated events, in append order.
 * @throws {Error} on the first unreadable or malformed event file.
 */
export function readEvents(dir, io = {}) {
  const readDir = io.readdirSync ?? defaultReaddir;
  const readFile = io.readFileSync ?? defaultReadFile;

  const dirAbs = resolve(dir);

  let names;
  try {
    names = readDir(dirAbs);
  } catch (cause) {
    if (cause?.code === "ENOENT") return [];
    throw new Error(
      `archkeep: cannot read the event store '${dirAbs}': ${cause?.message ?? cause}`,
      { cause },
    );
  }

  const eventNames = names.filter((name) => name.endsWith(".json") && !name.endsWith(".json.tmp"));
  eventNames.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const events = [];
  for (const name of eventNames) {
    const path = join(dirAbs, name);
    let text;
    try {
      text = readFile(path, "utf8");
    } catch (cause) {
      throw new Error(
        `archkeep: cannot read the evolution event '${path}': ${cause?.message ?? cause}`,
        { cause },
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new Error(`archkeep: malformed evolution event '${path}': ${cause?.message ?? cause}`, {
        cause,
      });
    }
    validateEventRecord(parsed, path);
    events.push(parsed);
  }
  return events;
}

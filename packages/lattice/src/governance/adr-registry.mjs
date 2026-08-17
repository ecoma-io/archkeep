/**
 * The ADR registry: `docs/adr/NNN-slug.md` files, parsed into one index an
 * enforcer can resolve `decisionRef` against.
 *
 * An ADR (architecture decision record) is a Markdown file in the workspace's
 * `docs/adr/` directory named `<NNN>-<slug>.md` — `NNN` a zero-padded number
 * of at least three digits, `<slug>` a short dash-separated name. Each file
 * declares, in frontmatter (the `---`-delimited block at the top, kept
 * deliberately minimal), the fields an enforcer needs to make the record
 * *enforceable*:
 *
 * - `id` — the record's own identity. Optional; when present it MUST equal the
 *   filename's id. The filesystem is the source of truth, so a file whose
 *   frontmatter id disagrees with its name is a loud error, never a drift the
 *   registry guesses at.
 * - `status` — `proposed` (default), `accepted`, or `superseded`.
 * - `supersedes` — optional list of ADR ids this record replaces, giving the
 *   supersession chain.
 * - `bindings` — optional list of rule/fitness ids this ADR makes enforceable:
 *   the objects its decision binds. An ADR with no `bindings` is recorded but
 *   not yet enforceable; the moment a rule/fitness carries `decisionRef`
 *   naming it, the two sides of the binding exist.
 *
 * Frontmatter is a strict, minimal dialect — `key: value` lines, and list
 * fields as `- item` continuation lines. It is never full YAML and never JSON
 * (the same decision the intent model makes for `architecture-intent.json`: no
 * parser leniency for this tool's own files).
 *
 * The invariant (`../../../../AGENTS.md`): an empty result must mean "no
 * violation", and nothing else. For the registry that means four things:
 *
 * - **The registry is deterministic.** Files are read in byte-sorted filename
 *   order and every emitted list is sorted, so two runs over an unchanged
 *   `docs/adr/` produce byte-identical output.
 * - **An unreadable registry is a loud failure, never an empty one.** A
 *   `docs/adr/` directory that exists but holds a file that will not parse, a
 *   duplicate id, a status outside the three, an unknown frontmatter key, or
 *   a `supersedes`/`bindings` entry that is not what the field requires —
 *   any of those throws, so a caller can never mistake "could not read the
 *   registry" for "no ADRs".
 * - **A `decisionRef` that does not resolve is `unknown`, never `pass`.** The
 *   registry's `resolveDecisionRef` answers the two-name space — an ADR id
 *   (matching a file) or a rule/fitness id the workspace declares. Anything
 *   else is unknown, and the caller reports unknown (never clean).
 * - **The registry trusts only git-tracked, in-workspace bytes.** A
 *   `docs/adr/` directory entry the tracked tree does not know about — a
 *   gitignored scratch file with an ADR-shaped name — is excluded exactly as
 *   if it were never there: no record, no id claimed, no error. So is a
 *   directory entry whose NAME is tracked but whose current bytes are not: a
 *   symlink (committed as one, or swapped in locally after the tracked-name
 *   check ran) whose target resolves outside the workspace root. Either way
 *   `resolveDecisionRef` answers `unknown` for the id, never `adr` — the same
 *   answer a name nobody ever wrote gets, so a planted file cannot make a
 *   `decisionRef` resolve against bytes this workspace never reviewed, with
 *   manual lookup the only thing that would otherwise have caught it.
 *   `../architecture-intent/model.mjs`'s `loadIntent` makes the identical call
 *   for `architecture-intent.json` (see its own header), and its `tracked`
 *   parameter is this module's `io.tracked` by another name. `docs/reference/adr.md`
 *   and `docs/usage/adr.md` already describe the registry as reading "the
 *   tracked `docs/adr/`" — this is what makes that sentence true.
 *
 * ## Remote lookup is opt-in and must never change local resolution
 *
 * A workspace may consult a remote catalog of decisions (an HTTP endpoint)
 * that knows ADRs the local `docs/adr/` does not. Local knowledge always wins:
 * a `decisionRef` the local registry already resolves stays resolved, and only
 * an id the local tree does not know may be asked of the remote. A remote
 * failure resolves nothing and throws nothing — an opt-in convenience must
 * never make an enforceable rule unenforceable. `referenceTime()` stamps a
 * fetch so a remote answer carries the moment it was taken.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/** The directory, relative to a workspace root, where ADR files live. */
export const ADR_DIR = "docs/adr";

/** The three statuses a record may carry. Any other value is a load error. */
export const ADR_STATUSES = Object.freeze(["proposed", "accepted", "superseded"]);

/**
 * Matches a valid ADR filename. The number is at least three digits so the
 * format outgrows 999 records without breaking; the slug is dash-separated
 * lowercase words.
 */
export const ADR_FILE_PATTERN = /^(\d{3,})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u;

/** An ADR id — `NNN-slug` — must match the filename it lives in. */
export const ADR_ID_PATTERN = /^\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** The frontmatter keys a record file may carry. */
const FRONTMATTER_KEYS = Object.freeze(["id", "status", "supersedes", "bindings"]);

/** A value's type, for an error message that shows what was actually there. */
function describe(value) {
  if (Array.isArray(value)) return `an array (${JSON.stringify(value)})`;
  if (value === null) return "null";
  return `${typeof value} (${JSON.stringify(value) ?? String(value)})`;
}

/** The `---`-delimited frontmatter block's text, or null when the file has none. */
function frontmatterBlock(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    throw new Error("frontmatter opened by '---' must close with a second '---' line");
  }
  return text.slice(3, end);
}

/** Strip a trailing `#` comment from a frontmatter value. */
function stripInlineComment(value) {
  const hash = value.indexOf(" #");
  return hash === -1 ? value : value.slice(0, hash).trim();
}

/**
 * Parse the frontmatter block into a field map. The dialect is strict:
 * `key: value` for scalars, `key:` followed by `- item` lines for lists, `#`
 * for comments. Anything else is a loud parse error — a frontmatter line an
 * enforcer cannot trust must never be silently dropped. That includes a key
 * repeated within the same block: an unconditional `fields[key] = …` write
 * would let the second occurrence silently discard the first — a scalar's
 * earlier value, or, worse, an entire earlier `bindings`/`supersedes` list,
 * since a second `key:` line resets `fields[key]` to a fresh empty array that
 * the following `- item` lines then fill from nothing. So a repeated key
 * throws instead of overwriting.
 *
 * @param {string} text The block between the two `---` delimiters.
 * @param {string} at The record's id, for the message.
 * @returns {Record<string, string|string[]|undefined>}
 * @throws {Error} on a line that is not part of the dialect, including a key
 *   that already appears earlier in the same block.
 */
export function parseFrontmatterFields(text, at) {
  /** @type {Record<string, string|string[]|undefined>} */
  const fields = {};
  let currentList = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const item = /^-\s+(.*)$/u.exec(trimmed);
    if (item) {
      if (currentList === null) {
        throw new Error(`${at}: list item "${trimmed}" appears before any "key:" line`);
      }
      /** @type {string[]} */ (fields[currentList]).push(stripInlineComment(item[1]));
      continue;
    }

    const key = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(trimmed);
    if (key) {
      if (Object.hasOwn(fields, key[1])) {
        throw new Error(
          `${at}: duplicate frontmatter key "${key[1]}" — the first occurrence would be silently overwritten`,
        );
      }
      const raw = key[2].trim();
      if (raw === "") {
        fields[key[1]] = [];
        currentList = key[1];
      } else {
        fields[key[1]] = stripInlineComment(raw);
        currentList = null;
      }
      continue;
    }

    throw new Error(`${at}: cannot parse frontmatter line "${trimmed}"`);
  }
  return fields;
}

/**
 * The list a field holds: already an array (a `key:` list), or a
 * comma-separated inline list written `key: a, b`. Both spellings stay legal.
 *
 * @param {string|string[]|undefined} value
 * @returns {string[]}
 */
function toList(value) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((entry) => entry.trim());
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * One parsed record, every field validated. A record an enforcer cannot trust
 * must never be read as an absent one (the invariant), so every malformed
 * field throws here rather than degrading the record.
 *
 * @param {{id: string, frontmatter: string|null}} parsed The filename-derived
 *   id and the frontmatter block (null when the file has none).
 * @returns {{id: string, status: string, supersedes: string[], bindings: string[]}}
 * @throws {Error} naming every violation at once.
 */
export function validateRecord({ id, frontmatter }) {
  const fields = frontmatter === null ? {} : parseFrontmatterFields(frontmatter, id);
  const violations = [];

  for (const key of Object.keys(fields)) {
    if (!FRONTMATTER_KEYS.includes(key)) {
      violations.push(
        `${id}: unknown frontmatter key "${key}" — a record may carry only ${FRONTMATTER_KEYS.join(", ")}`,
      );
    }
  }

  if (fields.id !== undefined && fields.id !== id) {
    violations.push(
      `${id}: frontmatter id "${fields.id}" disagrees with the filename's "${id}" — the ` +
        `registry keys on filenames, so rename the file or fix the id`,
    );
  }

  if (
    fields.status !== undefined &&
    !ADR_STATUSES.includes(/** @type {string} */ (fields.status))
  ) {
    violations.push(`${id}: status "${fields.status}" is not one of ${ADR_STATUSES.join(", ")}`);
  }

  for (const ref of toList(fields.supersedes)) {
    if (!ADR_ID_PATTERN.test(ref)) {
      violations.push(`${id}: supersedes entry ${describe(ref)} is not an ADR id`);
    }
  }

  for (const ref of toList(fields.bindings)) {
    if (ref === "") {
      violations.push(`${id}: bindings has an empty entry — a binding must name a rule/fitness id`);
    }
  }

  if (violations.length > 0) {
    throw new Error(`lattice: malformed ADR registry:\n  ${violations.join("\n  ")}`);
  }

  return {
    id,
    status: typeof fields.status === "string" ? fields.status : "proposed",
    supersedes: toList(fields.supersedes),
    bindings: toList(fields.bindings),
  };
}

/**
 * Whether `path` — a directory entry `loadAdrRegistry` already knows exists —
 * is a symlink whose target resolves outside `root`. Not a symlink: `false`,
 * the common case. A DANGLING symlink is not this function's concern either
 * (`false`): the read that follows fails on it with `ENOENT`, which the
 * existing "cannot read" branch already turns into a loud error, unchanged.
 * What this catches is the symlink that resolves just fine — silently handing
 * back bytes this workspace never committed, the read-side twin of the
 * write-side guard `../../cli.mjs`'s `writeOutputReport` documents.
 *
 * @param {string} root Absolute, already-canonical workspace root — resolving
 *   symlinks out of it is the caller's job (`findWorkspaceRoot` and this
 *   project's own fixtures both hand down a root with no symlink component of
 *   its own), so this function only resolves the candidate file.
 * @param {string} path Absolute path of the candidate file.
 * @param {{lstatSync: (path: string) => {isSymbolicLink: () => boolean}, realpathSync: (path: string) => string}} io
 * @returns {boolean}
 */
function escapesWorkspace(root, path, io) {
  let stat;
  try {
    stat = io.lstatSync(path);
  } catch {
    return false;
  }
  if (!stat.isSymbolicLink()) return false;
  let real;
  try {
    real = io.realpathSync(path);
  } catch {
    return false;
  }
  const rel = relative(root, real);
  return rel.startsWith("..") || isAbsolute(rel);
}

/**
 * Read and index every ADR file under `root/docs/adr/`. Deterministic:
 * filenames are byte-sorted, and every list in the returned records is already
 * in the order the source file stated (kept stable — the registry never
 * reorders what a record declares).
 *
 * An absent `docs/adr/` is an empty registry — a workspace that has not
 * adopted ADRs yet is not a failure, and has nothing to resolve. A directory
 * that exists but holds an unreadable file, a malformed record, or a duplicate
 * id throws; the caller maps that to exit 3, never to an empty list.
 *
 * @param {string} root Absolute workspace root.
 * @param {{readdirSync?: (path: string) => string[], readFileSync?: (path: string, encoding: "utf8") => string,
 *   lstatSync?: (path: string) => {isSymbolicLink: () => boolean}, realpathSync?: (path: string) => string,
 *   tracked?: string[]}} [io]
 *   Injectable filesystem seams, defaulting to the sync `node:fs` calls this
 *   module uses so the CLI stays event-loop-simple. Tests inject an in-memory
 *   tree. `tracked` is the `git ls-files` list (`../workspace.mjs`'s
 *   `listTrackedFiles`); when provided, a directory entry whose `docs/adr/<name>`
 *   path is not in it is excluded before it is ever validated — see this
 *   module's header for why, and `../architecture-intent/model.mjs`'s
 *   `loadIntent` for the identical `tracked` contract this one mirrors.
 * @returns {{records: object[], byId: Map<string, object>}}
 * @throws {Error} on an unreadable registry.
 */
export function loadAdrRegistry(root, io = {}) {
  const readDir = io.readdirSync ?? readdirSync;
  const readFile = io.readFileSync ?? readFileSync;
  const lstat = io.lstatSync ?? lstatSync;
  const realpath = io.realpathSync ?? realpathSync;
  const dir = join(root, ADR_DIR);

  /** @type {string[]} */
  let names;
  try {
    names = readDir(dir).filter((name) => name.endsWith(".md"));
  } catch (cause) {
    if (cause?.code === "ENOENT") return { records: [], byId: new Map() };
    throw new Error(`lattice: cannot read ${ADR_DIR}: ${cause?.message ?? cause}`, { cause });
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  if (io.tracked !== undefined) {
    const tracked = new Set(io.tracked);
    names = names.filter((name) => tracked.has(`${ADR_DIR}/${name}`));
  }

  const records = [];
  const byId = new Map();
  for (const name of names) {
    const match = ADR_FILE_PATTERN.exec(name);
    if (!match) {
      throw new Error(
        `lattice: ${ADR_DIR}/${name} is not a valid ADR filename — an ADR file must be ` +
          `named NNN-slug.md (zero-padded number of at least three digits, then a dash-separated slug)`,
      );
    }
    const id = `${match[1]}-${match[2]}`;
    if (byId.has(id)) {
      throw new Error(`lattice: ${ADR_DIR} holds more than one file for id "${id}"`);
    }
    const filePath = join(dir, name);
    // A tracked NAME says nothing about what currently sits on disk at that
    // path: a symlink committed at mode 120000, or one swapped in locally
    // after the `tracked` filter above ran, still passes it by name alone.
    // Excluded exactly like an untracked file — this module's header explains
    // why silence here is the honest answer rather than a thrown error.
    if (escapesWorkspace(root, filePath, { lstatSync: lstat, realpathSync: realpath })) {
      continue;
    }
    let text;
    try {
      text = readFile(filePath, "utf8");
    } catch (cause) {
      throw new Error(`lattice: cannot read ${ADR_DIR}/${name}: ${cause?.message ?? cause}`, {
        cause,
      });
    }
    const record = validateRecord({ id, frontmatter: frontmatterBlock(text) });
    byId.set(id, record);
    records.push(record);
  }

  return { records, byId };
}

/**
 * The set of every rule/fitness id the workspace's ADRs bind — the ids that
 * appear in any record's `bindings`. A `decisionRef` naming one of these names
 * a rule/fitness the ADR registry makes enforceable; `adrsBinding` answers
 * which record(s) bind it.
 *
 * @param {object[]} records
 * @returns {Set<string>}
 */
export function boundFitnessIds(records) {
  const ids = new Set();
  for (const record of records) {
    for (const binding of record.bindings) ids.add(binding);
  }
  return ids;
}

/**
 * The ADR records that bind a given rule/fitness id — the reverse lookup a
 * binding-aware surface uses to show where a rule becomes enforceable.
 *
 * @param {object[]} records
 * @param {string} fitnessId
 * @returns {string[]} ADR ids, in registry order.
 */
export function adrsBinding(records, fitnessId) {
  return records.filter((record) => record.bindings.includes(fitnessId)).map((record) => record.id);
}

/**
 * The two-name-space resolution a `decisionRef` answers. Local knowledge
 * always wins: an ADR id (matching a file in the registry) or a rule/fitness
 * id the workspace declares in `knownFitness`. Anything else is unknown.
 *
 * @param {Map<string, object>} byId The local registry index.
 * @param {Set<string>} knownFitness Rule/fitness ids the workspace declares.
 * @param {string} ref The decisionRef value.
 * @returns {"adr"|"fitness"|"unknown"}
 */
export function resolveDecisionRef(byId, knownFitness, ref) {
  if (byId.has(ref)) return "adr";
  if (knownFitness.has(ref)) return "fitness";
  return "unknown";
}

/**
 * `resolveDecisionRef`, applied across a list of governance rows in one pass
 * — the bulk form a report walks once per run rather than re-deriving the
 * same two-name-space check per row owner. `check`'s violations, `context`'s
 * matched constraints, and `drift`'s/`provenance`'s intent and config rows
 * all share this one function, so a `decisionRef` is judged identically
 * everywhere it is rendered. A row with no `decisionRef` — or an empty one,
 * a shape `../governance/row-schema.mjs` already refuses at load time — is
 * skipped: this answers "which CITATIONS are unverifiable", not "which rows
 * are incomplete" (a different question `provenance`'s `hasOrigin` answers).
 *
 * @param {{kind: string, row: object}[]} rows Each row paired with the label
 *   its owner uses to identify it (`depConstraints[0]`, `forbidden[2]`, …).
 * @param {Map<string, object>} byId The local ADR registry index.
 * @param {Set<string>} knownFitness Rule/fitness ids the workspace declares.
 * @returns {{kind: string, row: object, decisionRef: string}[]} Empty when
 *   every citation resolves — a list, not a bare boolean, so a caller can
 *   name which row is unverifiable rather than only that one is
 *   (`../../../../AGENTS.md`: an empty result must mean "no violation").
 */
export function unresolvedDecisionRefRows(rows, byId, knownFitness) {
  const unresolved = [];
  for (const { kind, row } of rows) {
    const ref = row?.decisionRef;
    if (typeof ref !== "string" || ref.trim() === "") continue;
    if (resolveDecisionRef(byId, knownFitness, ref) === "unknown") {
      unresolved.push({ kind, row, decisionRef: ref });
    }
  }
  return unresolved;
}

/**
 * Resolves a reference against the local registry plus an OPT-IN remote
 * catalog. The remote answer applies only when the local answer was unknown,
 * and a remote failure resolves nothing rather than throwing: an opt-in
 * convenience must never make an enforceable rule unenforceable.
 *
 * @param {Map<string, object>} byId
 * @param {Set<string>} knownFitness
 * @param {string} ref
 * @param {{remoteResolve?: (ref: string, referenceTime: string) => boolean, refTime?: () => string}} [io]
 * @returns {{kind: "adr"|"fitness"|"unknown", referenceTime: string|null}}
 *   `referenceTime` stamps the fetch and is non-null only when a remote answer
 *   was taken; a local answer needs no stamp.
 */
export function resolveWithRemote(byId, knownFitness, ref, io = {}) {
  const local = resolveDecisionRef(byId, knownFitness, ref);
  if (local !== "unknown") return { kind: local, referenceTime: null };
  let remote = false;
  let referenceTime = null;
  if (io.remoteResolve) {
    referenceTime = (io.refTime ?? referenceTimeNow)();
    try {
      remote = io.remoteResolve(ref, referenceTime) === true;
    } catch {
      remote = false;
    }
  }
  return { kind: remote ? "fitness" : "unknown", referenceTime: remote ? referenceTime : null };
}

/**
 * The current time as an ISO-8601 UTC string — the stamp a remote fetch
 * records. Injectable via `refTime` in `resolveWithRemote`; the default is
 * `new Date().toISOString()`.
 *
 * @returns {string}
 */
export function referenceTimeNow() {
  return new Date().toISOString();
}

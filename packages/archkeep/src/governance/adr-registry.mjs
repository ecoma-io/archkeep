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
 * - `status` — the lifecycle state: `proposed` (default), `accepted`,
 *   `active`, `superseded`, or `retired`. Only `accepted` and `active` carry
 *   authority (`hasAuthority`); `active` is the accepted decision currently in
 *   force, `superseded` was replaced by a later decision, `retired` was
 *   withdrawn without a replacement.
 * - `supersedes` — optional list of ADR ids this record replaces, giving the
 *   supersession chain. The reverse link — `supersededBy` — is derived on
 *   every record at load: the records whose `supersedes` names this one.
 * - `created` / `updated` — optional STRING values from the committed bytes,
 *   the decision's own timeline. Never generated from the wall clock.
 * - `bindings` — optional list of rule/fitness ids this ADR makes enforceable:
 *   the objects its decision binds. An ADR with no `bindings` is recorded but
 *   not yet enforceable; the moment a rule/fitness carries `decisionRef`
 *   naming it, the two sides of the binding exist.
 *
 * The record's markdown body may surface the decision's prose as optional
 * fields when the `## ` heading is present — `context`, `decision`,
 * `rationale`, `alternatives` (also spelled `## Refused alternatives`, the
 * spelling this repository's own records use), `consequences`, `assumptions`.
 * Body prose is free markdown and never throws; only frontmatter is strict.
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
 *   duplicate id, a status outside the five, an unknown frontmatter key, or
 *   a `supersedes`/`bindings` entry that is not what the field requires —
 *   any of those throws, so a caller can never mistake "could not read the
 *   registry" for "no ADRs". So does a supersession graph that cannot be
 *   true (`validateLineage`): a `supersedes` target that is not a record, a
 *   record that supersedes itself, a cycle, a `superseded` record with no
 *   successor, a successor without authority, or an authoritative record
 *   (`active`/`accepted`) superseded by another.
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

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { containmentViolation } from "../containment.mjs";

/** The directory, relative to a workspace root, where ADR files live. */
export const ADR_DIR = "docs/adr";

/** The five lifecycle statuses a record may carry. Any other value is a load error. */
export const ADR_STATUSES = Object.freeze([
  "proposed",
  "accepted",
  "active",
  "superseded",
  "retired",
]);

/**
 * Whether a status carries decision authority. Only `active` — the accepted
 * decision currently in force — and `accepted` — a decision made and
 * recorded — have it. `proposed` (a draft), `superseded` (replaced, authority
 * transferred) and `retired` (withdrawn without a replacement) do not.
 *
 * @param {string} status
 * @returns {boolean}
 */
export function hasAuthority(status) {
  return status === "active" || status === "accepted";
}

/**
 * Matches a valid ADR filename. The number is at least three digits so the
 * format outgrows 999 records without breaking; the slug is dash-separated
 * lowercase words.
 */
export const ADR_FILE_PATTERN = /^(\d{3,})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u;

/** An ADR id — `NNN-slug` — must match the filename it lives in. */
export const ADR_ID_PATTERN = /^\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** The frontmatter keys a record file may carry. */
const FRONTMATTER_KEYS = Object.freeze([
  "id",
  "status",
  "supersedes",
  "bindings",
  "created",
  "updated",
]);

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
/** The markdown body after the frontmatter block, or the whole text when the file has none. */
function bodyBlock(text) {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text; // frontmatterBlock throws this case first
  return text.slice(end + 4).replace(/^\r?\n/, "");
}

/**
 * The prose fields the body may surface, keyed by the exact `## ` heading
 * that carries them. `## Refused alternatives` — the spelling this
 * repository's own records use (`docs/adr/0003-…`, `docs/adr/0004-…`) — maps
 * to the same field as the `## Alternatives` spelling the ADR template names.
 * The body's `## Status` heading is deliberately absent: status is a
 * frontmatter field, and the body's retelling is not the model's.
 */
const PROSE_FIELDS = Object.freeze({
  Context: "context",
  Decision: "decision",
  Rationale: "rationale",
  Alternatives: "alternatives",
  "Refused alternatives": "alternatives",
  Consequences: "consequences",
  Assumptions: "assumptions",
});

/**
 * The optional prose fields parsed out of a record's body. Each `## ` heading
 * in `PROSE_FIELDS` opens its field; the field's content is everything from
 * the line after the heading to the line before the next `## ` heading
 * (sub-headings like `###` stay inside their field). An absent heading is an
 * absent field, and a body that is only prose never throws — frontmatter is
 * the one strict dialect. A `## ` heading outside the field list closes the
 * open field without opening one; a heading repeated within one body keeps
 * the last occurrence, the one deterministic choice a non-throwing parser
 * can make.
 *
 * @param {string} body The markdown body after the frontmatter block.
 * @returns {Record<string, string>} Only the fields whose headings were present.
 */
function parseProseFields(body) {
  /** @type {Record<string, string>} */
  const fields = {};
  let current = null;
  /** @type {string[]} */
  let buffer = [];
  const flush = () => {
    if (current !== null) fields[current] = buffer.join("\n").trim();
  };
  for (const line of body.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/u.exec(line);
    if (heading !== null) {
      flush();
      current = PROSE_FIELDS[heading[1]] ?? null;
      buffer = [];
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  flush();
  return fields;
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
 * field throws here rather than degrading the record. The record's body is
 * the exception by design: prose is free markdown and never throws — only
 * frontmatter is strict.
 *
 * @param {{id: string, frontmatter: string|null, body?: string}} parsed The
 *   filename-derived id and the frontmatter block (null when the file has
 *   none); the markdown body defaults to the empty string.
 * @returns {{id: string, status: string, created?: string, updated?: string,
 *   supersedes: string[], bindings: string[], context?: string, decision?: string,
 *   rationale?: string, alternatives?: string, consequences?: string, assumptions?: string}}
 * @throws {Error} naming every violation at once.
 */
export function validateRecord({ id, frontmatter, body = "" }) {
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

  for (const key of ["created", "updated"]) {
    const value = fields[key];
    if (value !== undefined && typeof value !== "string") {
      violations.push(
        `${id}: ${key} must be a single string value — the decision's own timeline from the ` +
          `committed bytes, never generated — got ${describe(value)}`,
      );
    }
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
    throw new Error(`archkeep: malformed ADR registry:\n  ${violations.join("\n  ")}`);
  }

  return {
    id,
    status: typeof fields.status === "string" ? fields.status : "proposed",
    ...(typeof fields.created === "string" ? { created: fields.created } : {}),
    ...(typeof fields.updated === "string" ? { updated: fields.updated } : {}),
    supersedes: toList(fields.supersedes),
    bindings: toList(fields.bindings),
    ...parseProseFields(body),
  };
}

/**
 * Validates the supersession graph across every record and derives each
 * record's `supersededBy` — the reverse of `supersedes`, the ids of the
 * records whose `supersedes` names this one. A chain that cannot be true is
 * itself an unreadable registry (the invariant), thrown as one message naming
 * every violation, never returned as partial fact:
 *
 * 1. every `supersedes` target must be a record;
 * 2. a record may not supersede itself;
 * 3. the graph may not contain a cycle — no record may transitively replace
 *    itself;
 * 4. a `superseded` record must have at least one successor (`retired` is its
 *    own reason and needs none) — a `superseded` status with no successor is
 *    dangling;
 * 5. a successor — the record declaring `supersedes` — must itself carry
 *    authority, so `proposed` and `superseded` records may not replace
 *    another;
 * 6. the contradiction rule: an authoritative record (`active`/`accepted`)
 *    may not be superseded by another — authority and supersession are
 *    mutually exclusive states.
 *
 * Deterministic: checks run in the records' registry (byte-sorted filename)
 * order, and every derived `supersededBy` list is in the order the
 * superseding records loaded.
 *
 * @param {object[]} records The validated records, in registry order.
 * @returns {object[]} The same records, each carrying its derived
 *   `supersededBy` string array.
 * @throws {Error} naming every lineage violation at once.
 */
export function validateLineage(records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  /** @type {Map<string, string[]>} */
  const supersededBy = new Map(records.map((record) => [record.id, []]));
  const violations = [];

  for (const record of records) {
    for (const ref of record.supersedes) {
      if (!byId.has(ref)) {
        violations.push(`${record.id} supersedes ${ref}, which is not an ADR in ${ADR_DIR}`);
        continue;
      }
      if (ref === record.id) {
        violations.push(`${record.id} supersedes itself — a record cannot replace itself`);
        continue;
      }
      if (record.status === "proposed" || record.status === "superseded") {
        violations.push(
          `${record.id} is ${record.status} and supersedes ${ref} — only a record with ` +
            `authority (active or accepted) may be a successor`,
        );
      }
      supersededBy.get(ref).push(record.id);
    }
  }

  // Cycles: a stack-based DFS over the declared graph. A node seen again on
  // the current stack is a cycle, named from the first repeated node so the
  // reported chain is the cycle itself, not a prefix of it.
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      violations.push(`supersedes cycle: ${[...stack.slice(stack.indexOf(id)), id].join(" -> ")}`);
      return;
    }
    visiting.add(id);
    stack.push(id);
    const record = byId.get(id);
    if (record !== undefined) {
      for (const ref of record.supersedes) visit(ref);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const record of records) visit(record.id);

  for (const record of records) {
    const successors = supersededBy.get(record.id);
    if (record.status === "superseded" && successors.length === 0) {
      violations.push(
        `${record.id} is superseded but nothing supersedes it — a superseded record needs at ` +
          `least one successor (retire it instead if it was withdrawn without a replacement)`,
      );
    }
    if ((record.status === "active" || record.status === "accepted") && successors.length > 0) {
      violations.push(
        `${record.id} is ${record.status} but superseded by [${successors.join(", ")}] — a ` +
          `record with authority may not be superseded by another`,
      );
    }
  }

  for (const record of records) {
    record.supersededBy = supersededBy.get(record.id);
  }

  if (violations.length > 0) {
    throw new Error(`archkeep: malformed ADR registry:\n  ${violations.join("\n  ")}`);
  }

  return records;
}

/**
 * Read and index every ADR file under `root/docs/adr/`. Deterministic:
 * filenames are byte-sorted, and every list in the returned records is already
 * in the order the source file stated (kept stable — the registry never
 * reorders what a record declares).
 *
 * An absent `docs/adr/` is an empty registry — a workspace that has not
 * adopted ADRs yet is not a failure, and has nothing to resolve. A directory
 * that exists but holds an unreadable file, a malformed record, a duplicate
 * id, or a supersession graph that cannot be true (see `validateLineage`)
 * throws; the caller maps that to exit 3, never to an empty list.
 *
 * @param {string} root Absolute workspace root.
 * @param {{existsSync?: (path: string) => boolean, readdirSync?: (path: string) => string[],
 *   readFileSync?: (path: string, encoding: "utf8") => string,
 *   lstatSync?: (path: string) => {isSymbolicLink: () => boolean}, realpathSync?: (path: string) => string,
 *   tracked?: string[]}} [io]
 *   Injectable filesystem seams, defaulting to `defaultAdrIo` (the sync
 *   `node:fs` calls this module uses) so the CLI stays event-loop-simple.
 *   Tests inject an in-memory tree.
 *   `existsSync` gates the containment probe below: an in-memory root does not
 *   exist on disk, and probing a nonexistent path's ancestry would walk up to
 *   a real parent and misread it as an escape.
 *   `tracked` is the `git ls-files` list (`../workspace.mjs`'s
 *   `listTrackedFiles`); when provided, a directory entry whose `docs/adr/<name>`
 *   path is not in it is excluded before it is ever validated — see this
 *   module's header for why, and `../architecture-intent/model.mjs`'s
 *   `loadIntent` for the identical `tracked` contract this one mirrors. The
 *   `lstatSync`/`realpathSync` seams feed
 *   `../containment.mjs`'s `containmentViolation`, which resolves the deepest
 *   existing ancestor through every intermediate component — so a symlinked
 *   `docs/adr/` directory is excluded the same way an escaping entry file is.
 * @returns {{records: object[], byId: Map<string, object>}}
 * @throws {Error} on an unreadable registry.
 */
export function loadAdrRegistry(root, io = {}) {
  const dirExists = io.existsSync ?? defaultAdrIo.existsSync;
  const readDir = io.readdirSync ?? defaultAdrIo.readdirSync;
  const readFile = io.readFileSync ?? defaultAdrIo.readFileSync;
  const lstat = io.lstatSync ?? defaultAdrIo.lstatSync;
  const realpath = io.realpathSync ?? defaultAdrIo.realpathSync;
  const dir = join(root, ADR_DIR);

  /** @type {string[]} */
  let names;
  try {
    // Every entry, unfiltered: the ONLY filename verdict this loader makes is
    // the `ADR_FILE_PATTERN` refusal below. An `.endsWith(".md")` pre-filter
    // here used to drop `0002-cased.MD` and `0003-thing.markdown` before that
    // throw could see them — an ADR-shaped record the author wrote, silently
    // absent from the index, so `resolveDecisionRef` answered `unknown` for an
    // id sitting in the tree and the reverse lookup answered "no ADR in
    // docs/adr/ binds rule:X — it is not enforced by any recorded decision"
    // about a binding the registry had simply refused to look at. Two
    // filters deciding the same question is how one of them goes quiet
    // (`../../../../AGENTS.md`). `README.md` reaches that same throw, by the
    // same rule, and always did: this directory is the registry, so a file in
    // it that is not a record is a thing to say out loud, not to drop. The
    // `io.tracked` filter below is a different question — whether the bytes
    // are the reviewed repository state — and stays the one exclusion that is
    // deliberately silent, for the reason this module's header states.
    names = readDir(dir);
  } catch (cause) {
    if (cause?.code === "ENOENT") return { records: [], byId: new Map() };
    throw new Error(`archkeep: cannot read ${ADR_DIR}: ${cause?.message ?? cause}`, { cause });
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
        `archkeep: ${ADR_DIR}/${name} is not a valid ADR filename — an ADR file must be ` +
          `named NNN-slug.md (zero-padded number of at least three digits, then a dash-separated slug)`,
      );
    }
    const id = `${match[1]}-${match[2]}`;
    if (byId.has(id)) {
      throw new Error(`archkeep: ${ADR_DIR} holds more than one file for id "${id}"`);
    }
    const filePath = join(dir, name);
    // A tracked NAME says nothing about what currently sits on disk at that
    // path: a symlink committed at mode 120000, one swapped in locally after
    // the `tracked` filter above ran, or — the intermediate case — a
    // symlinked `docs/adr/` itself, whose entries all pass the `tracked` filter
    // as strings while `readdir` hands back the target's bytes. `../containment.mjs`'s
    // `containmentViolation` walks the realpath of the deepest existing
    // ancestor through every intermediate component, so it catches all three;
    // the local `escapesWorkspace` it replaced only lstat'd the final file and
    // let the intermediate case through, the same escape the write guard in
    // `../../cli.mjs`'s `writeOutputReport` refuses (G-10). Excluded exactly
    // like an untracked file — this module's header explains why silence here
    // is the honest answer rather than a thrown error.
    if (
      // The real-fs guard `../architecture-intent/model.mjs`'s `loadIntent`
      // uses for the identical reason: an injected in-memory reader a test
      // drives is keyed by a fixture path that does not exist on disk, and
      // probing a nonexistent root's ancestry would walk up to a real parent
      // directory and misread it as an escape. Real roots only.
      dirExists(root) &&
      containmentViolation(root, filePath, { lstatSync: lstat, realpathSync: realpath }) !== null
    ) {
      continue;
    }
    let text;
    try {
      text = readFile(filePath, "utf8");
    } catch (cause) {
      throw new Error(`archkeep: cannot read ${ADR_DIR}/${name}: ${cause?.message ?? cause}`, {
        cause,
      });
    }
    const record = validateRecord({
      id,
      frontmatter: frontmatterBlock(text),
      body: bodyBlock(text),
    });
    byId.set(id, record);
    records.push(record);
  }

  validateLineage(records);

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
 * Strips the `adr:` prefix this tool's own governance-row docs recommend as
 * an alternate ADR-id spelling (`../governance/row-schema.mjs`'s
 * `decisionRef` field docs and its "does not resolve" error text both show
 * `"adr:0012"` beside the bare `0012-slug` form as an equally valid ADR id).
 * The registry never keys a record on that spelling — `validateRecord`
 * derives every `byId` key from the filename alone, and a frontmatter `id`
 * carrying the prefix would already fail the "must equal the filename" check
 * — so a lookup that does not strip it first can never match, no matter how
 * real the record is: the one spelling this tool itself suggests would be the
 * one spelling that silently fails to resolve. Any other ref — including one
 * that merely differs in case, like `ADR:` — is returned unchanged: only the
 * exact documented spelling is an alias, never a fuzzy match that would hide
 * a genuine typo behind a "resolved" answer.
 *
 * @param {string} ref
 * @returns {string}
 */
export function stripAdrPrefix(ref) {
  return ref.startsWith("adr:") ? ref.slice(4) : ref;
}

/**
 * The two-name-space resolution a `decisionRef` answers. Local knowledge
 * always wins: an ADR id (matching a file in the registry, written bare or
 * with the `adr:` prefix `stripAdrPrefix` strips) or a rule/fitness id the
 * workspace declares in `knownFitness`. Anything else is unknown.
 *
 * The fitness half strips the documented `rule:`/`fitness:` prefixes
 * (`../governance/row-schema.mjs`'s own decisionRef docs show both spellings)
 * before the membership test: `knownFitness` holds the DECLARED names —
 * a policy's `fitness` export names (`"hotspot"`), never prefixed strings —
 * and a citation is the two spellings a row author can write. A ref that is
 * neither an ADR id nor a declared name — including one that merely prefixes
 * an undeclared name — is unknown, never a fuzzy match that would hide a
 * typo behind a "resolved" answer (the same near-miss rule `stripAdrPrefix`
 * documents for the ADR half).
 *
 * @param {Map<string, object>} byId The local registry index.
 * @param {Set<string>} knownFitness Rule/fitness ids the workspace declares.
 * @param {string} ref The decisionRef value.
 * @returns {"adr"|"fitness"|"unknown"}
 */
export function resolveDecisionRef(byId, knownFitness, ref) {
  if (byId.has(stripAdrPrefix(ref))) return "adr";
  if (knownFitness.has(stripRuleFitnessPrefix(ref))) return "fitness";
  return "unknown";
}

/**
 * Strips the `rule:`/`fitness:` prefix a governance-row `decisionRef` may
 * carry (`../governance/row-schema.mjs` documents both spellings beside the
 * bare name). Only the exact documented lowercase spellings are aliases —
 * a differently-cased `RULE:x` is a near-miss like any other, never a fuzzy
 * match — and a name already bare passes through unchanged.
 *
 * @param {string} ref
 * @returns {string}
 */
export function stripRuleFitnessPrefix(ref) {
  return ref.startsWith("rule:") || ref.startsWith("fitness:")
    ? ref.slice(ref.indexOf(":") + 1)
    : ref;
}

/**
 * The rule/fitness ids a policy DECLARES — the `fitness` export's `name`
 * fields on the loaded boundary config (F04: a `decisionRef` claiming a
 * fitness rule must be judged against the ids the executed policy actually
 * declares, never against the ADRs' own `bindings` lists, which let a
 * citation resolve itself). Absent when the policy declares none — and then
 * no `fitness:`-shaped ref can ever resolve, which is the correct answer: a
 * rule that cannot be measured is no more bound than one that does not exist.
 *
 * A `fitness` export that is not an array, or that holds a row that is not a
 * plain object, is malformed — `findFitnessViolations`
 * (`./fitness-registry.mjs`) is what reports that, by name. This function
 * runs BEFORE that validation (`findBoundaryConfigViolations` builds its
 * default `io.resolve` from this, ahead of the `findFitnessViolations` call),
 * so it must never throw on a shape the validator has not yet had a chance to
 * name: a `.map` on a non-array, or a `.name` read off a non-object row,
 * would surface as a raw, unprefixed `TypeError` instead of the contracted
 * `archkeep: <path> is malformed: fitness: …` message — loud, but naming
 * nothing, which is its own silent-direction failure (`../../../../AGENTS.md`).
 * Defensive here does not mean silent: an unusable `fitness` still yields no
 * declared names, so a row citing one resolves to "unknown" exactly as it
 * would once `findFitnessViolations` reports the malformed shape and the run
 * exits non-zero.
 *
 * @param {unknown} config The loaded boundary config, or `null`/`undefined`
 *   when a caller has none, or any other shape a not-yet-validated `fitness`
 *   export may carry.
 * @returns {Set<string>}
 */
export function declaredFitnessNames(config) {
  const fitness = /** @type {{fitness?: unknown}} */ (config)?.fitness;
  if (!Array.isArray(fitness)) return new Set();
  const names = [];
  for (const row of fitness) {
    if (row !== null && typeof row === "object" && typeof row.name === "string") {
      names.push(row.name);
    }
  }
  return new Set(names);
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
 * The default io: the sync `node:fs` calls `loadAdrRegistry` makes. This is
 * the only place in this module the filesystem is named directly — every
 * function reads through an injected `io` whose missing seams fall back here,
 * so a test drives an in-memory tree without mocking the fs module and the
 * module body never touches the disk on its own.
 */
const defaultAdrIo = Object.freeze({
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
});

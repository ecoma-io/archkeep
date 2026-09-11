#!/usr/bin/env node
// Fails when a commit in the release lane's own range cannot be parsed by the
// release lane's own parser.
//
// The invariant this gate exists for: an exit 0 must mean "release-please saw
// every commit in the range and parsed every one it needed to", not "nothing
// crashed". release-please's `parseConventionalCommits` (src/commit.ts) catches
// the parser's throw for an unparseable message and reports it only through
// `logger.debug` — the commit silently never reaches the changelog and the
// release stays green. The trigger is a message line where a word is
// immediately followed by parentheses that nest — a body line like
// `physicalDestination(dirname(outputAbs))` reads as a conventional-commit
// scope, and the lexer throws on the second `(` where it demanded `)` — which
// `@conventional-commits/parser` 0.4.1 cannot tokenize. That parser has had no
// release since 2021-01-07 and the upstream issue
// (googleapis/release-please#2878) is open, so no version of the action fixes
// it; the defect is escaped at the boundary this gate owns instead.
//
// Detection runs the lane's actual parse — release-please's public
// `parseConventionalCommits` at the version the lane bundles, installed as a
// root devDependency — over the lane's actual range: from the most recent
// version whose tag resolves (candidates start at the tag named by
// `.release-please-manifest.json`, then walk the manifest's own history) to
// HEAD. On a release pull request and on a release-merge push the manifest's
// working-tree version is the NEXT release, whose tag exists only after the
// action runs, so the walk lands on the last released version — the
// boundary release-please itself reads. The manifest is the source of the
// candidates, never `git describe`: the parked `v1.0.1-rc.1` is an ancestor
// of main and describe would name it. The parser drops EVERY message it
// cannot read, and most of those drops are its designed exclusion: a message
// the lane's splitter never hands the parser — no conventional header, no
// nested conventional paragraph, no BEGIN_NESTED_COMMIT block — is dropped
// and legitimately never reaches a changelog. The defect is narrower, so
// the gate is narrower: it flags only a commit that could have produced a
// changelog entry and is dropped anyway or debug-named anyway — an entry the
// release could have carried and lost. No release algorithm is
// reimplemented and no CHANGELOG is consulted.
//
// `scripts/release-integrity.lock.json` records the parser identity the lane
// runs (action pin, bundled release-please, resolved parser). Every run —
// with or without `--verify-action` — holds the workflow's pin, the installed
// devDependencies, and the lock to each other, so the gate's parse and the
// lane's parse cannot drift apart silently; `--verify-action` additionally
// fetches the pinned action's package.json and fails when its release-please
// range no longer admits the locked version.
//
// Exit codes: 0 = verified clean (or release-less: the `ok` line states the
// commit count, including zero, explicitly); 1 = findings; 2 = cannot decide
// (missing tag, git or network failure, malformed lock, missing devDependency).
// A gate that cannot decide must never look like a gate that passed.
//
// `main()` and the other filesystem/git/network functions are deliberately
// untested — a test that stubbed git's or release-please's answer would only
// pin the stub. Everything below them is pure and tested in
// check-release-integrity.test.mjs, which drives the real installed parser.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseConventionalCommits } from "release-please/build/src/commit.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const RELEASE_YML = join(ROOT, ".github", "workflows", "release.yml");
const LOCK_JSON = join(SCRIPT_DIR, "release-integrity.lock.json");
const MANIFEST_NAME = ".release-please-manifest.json";
const MANIFEST_JSON = join(ROOT, MANIFEST_NAME);

/** The parse call the release lane itself makes. */
const LANES_PARSE = /** @type {typeof parseConventionalCommits} */ (parseConventionalCommits);

/**
 * The pull-request metadata the parser's Commit shape carries, unused here.
 *
 * @typedef {import("release-please/build/src/pull-request.js").PullRequest} PullRequest
 */

/**
 * A commit as release-please's `parseConventionalCommits` consumes it. The
 * two required fields are the only ones the parse reads; the rest stay
 * optional exactly as the parser's own Commit declares them.
 *
 * @typedef {object} LaneCommit
 * @property {string} sha
 * @property {string} message full raw commit message (subject + body)
 * @property {string[]} [files]
 * @property {PullRequest} [pullRequest]
 */
/**
 * @typedef {object} Violation
 * @property {string} id stable machine-readable identifier
 * @property {string} message human-readable description of the drift
 */
/**
 * One commit the lane's parser cannot give a changelog entry to.
 *
 * @typedef {object} ParseFailure
 * @property {string} sha full commit sha
 * @property {string} subject first line of the commit message
 * @property {string} reason the parser's own report, or the no-debug-line case named
 * @property {"dropped" | "partial"} kind dropped: absent from the output; partial: present but debug-named
 */

/**
 * Judges one clause (no `||`) of a semver dependency range against an exact
 * version. Supports the spellings the action's package.json has used —
 * exact, caret, tilde, `>=` — and nothing more: an unrecognised clause is
 * null, and every caller treats null as a violation. Writing a full semver
 * implementation here would be a second opinion about what a range means;
 * the gate needs only enough to detect that the action's range and the lock
 * disagree, and honest uncertainty about anything else.
 *
 * @param {string} clause
 * @param {[number, number, number]} version
 * @returns {boolean | null}
 */
function judgeClause(clause, version) {
  const m = /^(\^|~|>=)?\s*(\d+)\.(\d+)\.(\d+)$/.exec(clause);
  if (!m) return null;
  const op = m[1] ?? "";
  const candidate = [Number(m[2]), Number(m[3]), Number(m[4])];
  const ge = (a, b) =>
    a[0] > b[0] ||
    (a[0] === b[0] && a[1] > b[1]) ||
    (a[0] === b[0] && a[1] === b[1] && a[2] >= b[2]);
  if (op === "^") {
    if (candidate[0] !== version[0]) return false;
    return ge(version, candidate);
  }
  if (op === "~") {
    if (candidate[0] !== version[0] || candidate[1] !== version[1]) return false;
    return ge(version, candidate);
  }
  if (op === ">=") return ge(version, candidate);
  return candidate[0] === version[0] && candidate[1] === version[1] && candidate[2] === version[2];
}

/**
 * Whether a release-please dependency range admits a version. A `||`
 * disjunction admits when any clause admits; null when any clause cannot be
 * judged and none admits.
 *
 * @param {string} range a semver range as written in a package.json dependency
 * @param {string} version an exact `X.Y.Z`
 * @returns {boolean | null} null when the range cannot be judged
 */
export function rangeAdmits(range, version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  const parsed = /** @type {[number, number, number]} */ ([
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ]);
  let sawNull = false;
  for (const part of range.split("||")) {
    const verdict = judgeClause(part.trim(), parsed);
    if (verdict === true) return true;
    if (verdict === null) sawNull = true;
  }
  return sawNull ? null : false;
}

/**
 * Reads and shape-checks the lock record. A file that is not valid JSON
 * throws (the caller reports exit 2); a file that parses but does not carry
 * the expected shape returns violations instead — the record exists, what it
 * says cannot be trusted.
 *
 * @param {string} lockText contents of scripts/release-integrity.lock.json
 * @returns {{lock: Record<string, unknown>, violations: Violation[]}}
 */
export function readLock(lockText) {
  const violations = [];
  const lock = JSON.parse(lockText);
  for (const key of ["action", "releasePlease", "parser"]) {
    if (!(key in lock)) violations.push({ id: "lock-shape", message: `lock is missing "${key}"` });
  }
  const action = /** @type {Record<string, unknown>} */ (lock.action ?? {});
  for (const key of ["repo", "sha", "version"]) {
    if (typeof action[key] !== "string") {
      violations.push({ id: "lock-shape", message: `lock.action is missing or mistyped "${key}"` });
    }
  }
  for (const key of ["releasePlease", "parser"]) {
    if (typeof lock[key] !== "string") {
      violations.push({
        id: "lock-shape",
        message: `lock.${key} is missing or not a version string`,
      });
    }
  }
  return { lock, violations };
}

/**
 * Extracts the lane's action pin from release.yml's text. Pure: the test feeds
 * workflow text, the caller reads the file.
 *
 * @param {string} releaseYmlText contents of .github/workflows/release.yml
 * @returns {{repo: string, sha: string, version: string} | null} null when no
 *   SHA-pinned `googleapis/release-please-action@` line exists
 */
export function parseActionPin(releaseYmlText) {
  const match =
    /uses:\s*googleapis\/release-please-action@([0-9a-f]{40})(?:\s*#\s*(v[\d][\w.]*))?/.exec(
      releaseYmlText,
    );
  if (!match) return null;
  return { repo: "googleapis/release-please-action", sha: match[1], version: match[2] ?? "" };
}

/**
 * Holds the pinned action's own package.json to the lock: its release-please
 * range must still admit the version the lock records, or the action's
 * bundled parser has moved away from the parser this gate runs and the lock
 * was not re-recorded.
 *
 * @param {object} args
 * @param {string} args.actionPackageText the pinned action's package.json,
 *   fetched at its recorded sha
 * @param {Record<string, unknown>} args.lock the lock record
 * @returns {Violation[]}
 */
export function remoteActionAdmits({ actionPackageText, lock }) {
  let pkg;
  try {
    pkg = JSON.parse(actionPackageText);
  } catch {
    return [
      {
        id: "action-package-unreadable",
        message: "the pinned action's package.json is not valid JSON",
      },
    ];
  }
  const range = /** @type {Record<string, Record<string, string>>} */ (pkg)?.dependencies?.[
    "release-please"
  ];
  if (typeof range !== "string") {
    return [
      {
        id: "action-dependency-missing",
        message: 'the pinned action\'s package.json declares no "release-please" dependency',
      },
    ];
  }
  const admits = rangeAdmits(range, /** @type {string} */ (lock.releasePlease));
  if (admits === null) {
    return [
      {
        id: "action-range-unjudgable",
        message: `cannot decide whether the action's release-please range "${range}" admits ${String(lock.releasePlease)} — the lock must be re-measured by hand`,
      },
    ];
  }
  if (!admits) {
    return [
      {
        id: "action-range-drifted",
        message: `the pinned action's release-please range "${range}" no longer admits the locked ${String(lock.releasePlease)} — the action now bundles a different parser; re-measure and re-record the lock`,
      },
    ];
  }
  return [];
}

/**
 * Holds the workflow's pin, the installed packages and the lock to each
 * other. Any disagreement is a violation: the gate would otherwise run one
 * parser while the lane runs another, and the gate's verdict would say
 * nothing about the lane.
 *
 * @param {object} args
 * @param {Record<string, unknown>} args.lock the lock record
 * @param {string} args.releaseYmlText contents of .github/workflows/release.yml
 * @param {string} args.installedReleasePlease version of the installed release-please
 * @param {string} args.installedParser version of the installed @conventional-commits/parser
 * @returns {Violation[]}
 */
export function verifyVersionLock({
  lock,
  releaseYmlText,
  installedReleasePlease,
  installedParser,
}) {
  const violations = [];
  const pin = parseActionPin(releaseYmlText);
  if (!pin) {
    violations.push({
      id: "action-pin-missing",
      message:
        "release.yml pins no googleapis/release-please-action@<full-sha> — the lock records an action the lane no longer names",
    });
    return violations;
  }
  const action = /** @type {Record<string, string>} */ (lock.action ?? {});
  if (typeof action.sha === "string" && pin.sha !== action.sha) {
    violations.push({
      id: "action-sha-drifted",
      message: `release.yml pins ${pin.sha.slice(0, 12)} but the lock records ${action.sha.slice(0, 12)} — the action moved without the lock being re-recorded`,
    });
  }
  if (typeof action.version === "string" && pin.version !== action.version) {
    violations.push({
      id: "action-version-drifted",
      message: `release.yml's pin comment says ${pin.version || "(none)"} but the lock records ${action.version}`,
    });
  }
  if (typeof lock.releasePlease === "string" && installedReleasePlease !== lock.releasePlease) {
    violations.push({
      id: "release-please-drifted",
      message: `installed release-please is ${installedReleasePlease} but the lock records ${lock.releasePlease} — the gate would not run the lane's parser`,
    });
  }
  if (typeof lock.parser === "string" && installedParser !== lock.parser) {
    violations.push({
      id: "parser-drifted",
      message: `installed @conventional-commits/parser is ${installedParser} but the lock records ${lock.parser} — the gate would not run the lane's parser`,
    });
  }
  return violations;
}

/**
 * Whether a commit's own first line declares a conventional header — mirroring
 * the grammar the guarded parser accepts, including a colon with no
 * whitespace before the text (`fix(x):ship it` parses; only the spacing
 * conventions differ). Deliberately type-agnostic: the release lane decides
 * which types it ignores, and this gate must agree with the lane about
 * everything except drops.
 *
 * @param {string} message full raw commit message
 * @returns {boolean}
 */
export function isConventionalSubject(message) {
  return /^\S+(?:\([^()]*\))?!?:\s*\S/.test(message.split("\n")[0]);
}

/**
 * Whether the lane's splitter would hand the parser any message from this
 * commit. release-please's `splitMessages` works on every commit, whatever
 * its first line: it splits blank-line-separated conventional paragraphs out
 * of any message — a merge commit's subject in front of a carried
 * `feat:` paragraph is the shape to defend against — and extracts
 * `BEGIN_NESTED_COMMIT` blocks for separate parsing. The gate scrutinizes
 * exactly the commits that could have produced a changelog entry; every
 * other message is the parser's designed exclusion, and flagging it would
 * fail every lane that ever carried a squash-merge or a hand commit.
 *
 * @param {string} message full raw commit message
 * @returns {boolean}
 */
export function yieldsLaneEntry(message) {
  if (isConventionalSubject(message)) return true;
  // The splitter's own regex, verbatim: a blank line, then one of its ten
  // types with an optional scope and the `": "` its lookahead demands.
  if (
    /\r?\n\r?\n(?=(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\(.*?\))?: )/.test(
      message,
    )
  ) {
    return true;
  }
  return message.includes("BEGIN_NESTED_COMMIT");
}

/**
 * How many entry-shaped sub-messages the lane's splitter hands the parser for
 * this commit. Mirrors `splitMessages` (release-please `src/commit.ts`)
 * exactly — BEGIN/END_NESTED_COMMIT blocks are extracted for separate
 * parsing, and the remainder splits at blank lines before one of its ten
 * conventional headers — then counts the pieces carrying a conventional
 * header. Pure.
 *
 * @param {string} message full raw commit message
 * @returns {number}
 */
export function laneEntryCount(message) {
  const parts = message.split("BEGIN_NESTED_COMMIT");
  const messages = [parts.shift() ?? ""];
  for (const part of parts) {
    const [nested, ...rest] = part.split("END_NESTED_COMMIT");
    messages.push(nested);
    messages[0] = messages[0] + rest.join("END_NESTED_COMMIT");
  }
  return messages
    .flatMap((piece) =>
      piece.split(
        /\r?\n\r?\n(?=(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\(.*?\))?: )/,
      ),
    )
    .filter((piece) => isConventionalSubject(piece.trim())).length;
}

/**
 * Finds every commit the lane's parse drops, wholly or partially. Pure: takes
 * the commits and the parse function as arguments.
 *
 * @param {object} args
 * @param {LaneCommit[]} args.commits commits in the lane's range, in git order
 * @param {typeof LANES_PARSE} args.parse release-please's
 *   `parseConventionalCommits`
 * @returns {{failures: ParseFailure[], parsedCount: number}}
 */
export function detectParseFailures({ commits, parse }) {
  /** @type {string[]} */
  const debugLines = [];
  const logger = /** @type {Parameters<typeof parse>[1]} */ ({
    trace: () => {},
    debug: (...parts) => debugLines.push(parts.map(String).join(" ")),
    info: () => {},
    warn: () => {},
    error: () => {},
  });
  const parsed = parse(commits, logger);
  const parsedShas = new Set(parsed.map((c) => c.sha));
  /** @type {Map<string, string[]>} */
  const debugBySha = new Map();
  // release-please emits two debug lines per failed parse, adjacent in its
  // own log: the `commit could not be parsed` line that names the sha, then
  // the `error message` line that carries the parser's report. The second
  // belongs to the same sha as the first.
  let currentSha = null;
  for (const line of debugLines) {
    const m = /commit could not be parsed: ([0-9a-f]{7,40})\b/.exec(line);
    if (m) {
      currentSha = m[1];
    } else if (!/^error message:/.test(line)) {
      continue;
    }
    if (!currentSha) continue;
    const hits = debugBySha.get(currentSha) ?? [];
    hits.push(line);
    debugBySha.set(currentSha, hits);
  }
  /** @type {ParseFailure[]} */
  const failures = [];
  const producedBySha = new Map();
  for (const entry of parsed) {
    producedBySha.set(entry.sha, (producedBySha.get(entry.sha) ?? 0) + 1);
  }
  for (const commit of commits) {
    if (!yieldsLaneEntry(commit.message)) continue;
    // Exact key first, then prefix: a release-please that ever prints a
    // shortened sha would key debug lines where the exact lookup misses,
    // and partial-drop detection would silently stop working.
    const named =
      debugBySha.get(commit.sha) ??
      [...debugBySha].flatMap(([key, hits]) => (commit.sha.startsWith(key) ? hits : []));
    // Partial judgment by count, not by debug text: the debug line names the
    // outer commit's subject, so it cannot tell a designed exclusion (a
    // merge-commit subject the splitter still tries) from a lost entry. The
    // count can: a commit that carried N entry-shaped sub-messages must
    // produce N output entries, or one of them never reached the changelog.
    if (!parsedShas.has(commit.sha)) {
      failures.push({
        sha: commit.sha,
        subject: commit.message.split("\n")[0],
        reason:
          named.length > 0
            ? named.join(" | ")
            : "missing from the parse output with no debug line naming it — the drop happened without release-please even reporting it",
        kind: "dropped",
      });
      continue;
    }
    const produced = producedBySha.get(commit.sha) ?? 0;
    const carried = laneEntryCount(commit.message);
    if (carried > produced) {
      failures.push({
        sha: commit.sha,
        subject: commit.message.split("\n")[0],
        reason:
          named.length > 0
            ? named.join(" | ")
            : `${carried - produced} entry-shaped message(s) in this commit never reached the parse output and no debug line names it`,
        kind: "partial",
      });
    }
  }
  return { failures, parsedCount: parsed.length };
}

/**
 * Renders the report: one entry per finding plus, on findings, the
 * remediation; a single `ok` line when clean, stating the commit count even
 * when it is zero — a release-less push is a claim, not silence. Pure.
 *
 * @param {object} args
 * @param {string} args.range the git range the verdict covers
 * @param {LaneCommit[]} args.commits commits in the range
 * @param {ParseFailure[]} args.failures
 * @param {Record<string, unknown>} args.lock the lock record
 * @returns {string[]}
 */
export function renderReport({ range, commits, failures, lock }) {
  const lines = [];
  if (failures.length === 0) {
    lines.push(
      `ok   ${range} — ${commits.length} commit(s) since the release manifest's tag, every one parses under the lane's own release-please ${String(lock.releasePlease)} (@conventional-commits/parser ${String(lock.parser)})`,
    );
    return lines;
  }
  for (const f of failures) {
    lines.push(`FAIL ${f.sha.slice(0, 12)} [${f.kind}] ${f.subject}`);
    lines.push(`     ${f.reason}`);
  }
  lines.push("");
  lines.push(
    `${failures.length} of ${commits.length} commit(s) in ${range} cannot be parsed by release-please ${String(lock.releasePlease)}.`,
  );
  lines.push(
    "release-please would silently omit them from the changelog and cut the release anyway (upstream: googleapis/release-please#2878, parser 0.4.1 unreleased since 2021).",
  );
  lines.push(
    "The release must not run until every listed commit parses. Options, in order of preference:",
  );
  lines.push(
    "  1. Reword the commit body so no word sits immediately before parentheses that nest — the",
  );
  lines.push(
    "     message is data the parser reads, and `word(word(word))` is exactly what it cannot tokenize.",
  );
  lines.push("     A single non-nesting parenthetical parses fine; splitting the line also works.");
  lines.push(
    "  2. A merged commit cannot be reworded safely — if one is listed and already on the default branch,",
  );
  lines.push(
    "     the maintainers must re-measure and re-record scripts/release-integrity.lock.json against a",
  );
  lines.push(
    "     release-please whose parser accepts it, and land that re-record before any release.",
  );
  return lines;
}

/** Version of an installed package, or null when it is not resolvable. */
function installedVersion(name) {
  try {
    const require = createRequire(import.meta.url);
    return /** @type {{version: string}} */ (require(`${name}/package.json`)).version;
  } catch {
    return null;
  }
}

/**
 * The first candidate whose tag resolves, newest first, as the lane's range.
 * Pure: the candidates and the resolution test are arguments, which is why
 * the release-pull-request shape — a working-tree version whose tag cannot
 * exist yet — is testable without git.
 *
 * @param {object} args
 * @param {string[]} args.versions candidate versions, newest first
 * @param {(version: string) => boolean} args.tagResolves does v<version> resolve here
 * @returns {string | null}
 */
export function pickRange({ versions, tagResolves }) {
  for (const version of versions) {
    if (tagResolves(version)) return `v${version}..HEAD`;
  }
  return null;
}

/**
 * Candidate versions for the range, newest first: the working tree's
 * manifest, then the manifest as it stood at each older commit that touched
 * it. Reading only those commits keeps the walk bounded — the file changes
 * once per release — and every candidate a version the lane has or will
 * release. A broken historical manifest contributes nothing.
 *
 * @returns {string[]}
 */
function manifestVersions() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_JSON, "utf8"));
  } catch (error) {
    console.error(
      `FAIL cannot read ${MANIFEST_JSON} — the manifest is the range's source of truth: ${errorMessage(error)}`,
    );
    return [];
  }
  const versions = [];
  const collect = (/** @type {unknown} */ parsed) => {
    const version = /** @type {Record<string, string>} */ (parsed)["."];
    if (typeof version === "string" && !versions.includes(version)) versions.push(version);
  };
  collect(manifest);
  let shas = [];
  try {
    shas = execFileSync("git", ["log", "--format=%H", "--", MANIFEST_JSON], {
      encoding: "utf8",
      cwd: ROOT,
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    // No readable history — the working tree's version is the only candidate.
  }
  for (const sha of shas.slice(0, 10)) {
    try {
      collect(
        JSON.parse(
          execFileSync("git", ["show", `${sha}:${MANIFEST_NAME}`], { encoding: "utf8", cwd: ROOT }),
        ),
      );
    } catch {
      // An unreadable historical manifest contributes nothing; keep walking.
    }
  }
  return versions;
}

/**
 * The lane's range: the most recent version whose tag resolves, to HEAD.
 * Candidate order is the working tree's manifest first, then its history.
 * The walk exists because the working tree's version is the NEXT release on
 * a release pull request and on a release-merge push — its tag exists only
 * after the action runs post-merge — so the boundary release-please itself
 * reads is the last released version, found one manifest generation back.
 * Returns null when no candidate resolves — the caller reports exit 2,
 * because a gate that scanned nothing would pass everything.
 *
 * @returns {string | null}
 */
function resolveRange() {
  const versions = manifestVersions();
  if (versions.length === 0) {
    console.error(`FAIL ${MANIFEST_NAME} yields no "." version — the range cannot be derived`);
    return null;
  }
  const tagResolves = (/** @type {string} */ version) => {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `v${version}^{commit}`], {
        encoding: "utf8",
        cwd: ROOT,
      });
      return true;
    } catch {
      // rev-parse --verify --quiet exits non-zero instead of printing; the
      // tag is unreachable in this checkout.
      return false;
    }
  };
  const range = pickRange({ versions, tagResolves });
  if (!range) {
    console.error(
      `FAIL no version's tag resolves in this checkout (tried ${versions.map((v) => `v${v}`).join(", ")}) — fetch full history before judging the range`,
    );
  }
  return range;
}

/** Commits in the range, in the shape release-please's parser reads. */
function readCommits(range) {
  const raw = execFileSync("git", ["log", "--format=%H%x1f%B%x1e", range], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: ROOT,
  });
  return raw
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const sep = chunk.indexOf("\x1f");
      return /** @type {LaneCommit} */ ({
        sha: chunk.slice(0, sep),
        message: chunk.slice(sep + 1),
      });
    });
}

/** A catch clause's message, without pretending the throw was known. */
function errorMessage(error) {
  return /** @type {Error} */ (error).message;
}

/**
 * Runs the gate and returns the exit code: 0 (as undefined) clean, 1
 * findings, 2 cannot decide. process.exitCode is written exactly once, in
 * the entry guard after this resolves — an async function writing it around
 * awaits is the shape require-atomic-updates exists to flag, and one write
 * at the edge cannot race.
 *
 * @returns {Promise<1 | 2 | undefined>}
 */
async function main() {
  const verifyActionOnly = process.argv.includes("--verify-action");
  // Lock first: every mode runs the lane's parser, so the identity of that
  // parser is the first thing to hold.
  let lockText;
  try {
    lockText = readFileSync(LOCK_JSON, "utf8");
  } catch (error) {
    console.error(
      `FAIL cannot read ${LOCK_JSON} — the gate cannot know which parser the lane runs`,
    );
    console.error(`     ${errorMessage(error)}`);
    return 2;
  }
  let lockResult;
  try {
    lockResult = readLock(lockText);
  } catch (error) {
    console.error(
      `FAIL ${LOCK_JSON} is not valid JSON — the gate cannot know which parser the lane runs`,
    );
    console.error(`     ${errorMessage(error)}`);
    return 2;
  }
  const installedReleasePlease = installedVersion("release-please");
  const installedParser = installedVersion("@conventional-commits/parser");
  if (!installedReleasePlease || !installedParser) {
    console.error(
      "FAIL release-please / @conventional-commits/parser not resolvable from scripts/ — the gate cannot run the lane's own parser",
    );
    return 2;
  }
  let releaseYmlText;
  try {
    releaseYmlText = readFileSync(RELEASE_YML, "utf8");
  } catch {
    console.error(`FAIL cannot read ${RELEASE_YML} — the lock cannot be held to the lane`);
    return 2;
  }
  const violations = [
    ...lockResult.violations,
    ...verifyVersionLock({
      lock: lockResult.lock,
      releaseYmlText,
      installedReleasePlease,
      installedParser,
    }),
  ];

  // Findings accumulate across both halves before the verdict: a parse
  // failure and a lock violation name different repairs, and both belong in
  // the report.
  let parseFailed = false;
  if (verifyActionOnly) {
    // Fetch the pinned action's package.json at the recorded sha and hold its
    // release-please range to the lock. Any fetch or HTTP failure is exit 2 —
    // cannot decide — never a pass.
    const action = /** @type {{repo: string, sha: string}} */ (lockResult.lock.action ?? {});
    let actionPackageText;
    try {
      const response = await fetch(
        `https://raw.githubusercontent.com/${action.repo}/${action.sha}/package.json`,
      );
      if (!response.ok) {
        console.error(`FAIL fetching the pinned action's package.json: HTTP ${response.status}`);
        return 2;
      }
      actionPackageText = await response.text();
    } catch (error) {
      console.error(`FAIL fetching the pinned action's package.json: ${errorMessage(error)}`);
      return 2;
    }
    violations.push(...remoteActionAdmits({ actionPackageText, lock: lockResult.lock }));
  } else {
    const range = resolveRange();
    if (!range) return 2;
    let commits;
    try {
      commits = readCommits(range);
    } catch (error) {
      console.error(`FAIL git log over ${range}: ${errorMessage(error)}`);
      return 2;
    }
    const { failures } = detectParseFailures({ commits, parse: LANES_PARSE });
    const sink = failures.length === 0 ? console.log : console.error;
    for (const line of renderReport({ range, commits, failures, lock: lockResult.lock }))
      sink(line);
    parseFailed = failures.length > 0;
  }

  if (violations.length > 0) {
    for (const v of violations) console.error(`FAIL [${v.id}] ${v.message}`);
    console.error(
      "\nThe release-integrity lock and the lane disagree — until they agree again, the gate's parse is not the lane's parse.",
    );
    return 1;
  }
  return parseFailed ? 1 : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await main();
  if (code) process.exitCode = code;
}

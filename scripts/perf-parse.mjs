// Pure parsing functions for CI performance data extraction.
//
// WHY this file exists: the CI/CD optimization program needs machine-readable
// timing data from every CI run — moon task durations, E2E per-file durations,
// and job-level step timings from the GitHub API. These parsers extract that
// data into structured form; the I/O that reads logs and API responses lives
// in `build-perf-record.mjs`. A pure function can be tested without a
// filesystem and without a mocking library — the same principle
// `check-packages.mjs` uses (AGENTS.md, "The gate scripts take their facts as
// arguments").

// ---------------------------------------------------------------------------
// ANSI escape stripping
//
// GitHub Actions log files carry ANSI SGR sequences around the tokens a
// parser needs (vitest colors the checkmark, moon colors the task name).
// Matching raw bytes fails on the interleaved escapes; strip them once, at
// the line level, before any other pattern sees the line.
// ---------------------------------------------------------------------------

/**
 * Strips ANSI SGR (color/style) escape sequences from a line.
 *
 * @param {string} line raw log line
 * @returns {string} the line with all escape sequences removed
 */
export function stripAnsi(line) {
  // eslint-disable-next-line no-control-regex -- intentional: SGR sequences contain \x1b
  return line.replaceAll(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// Moon task completions
//
// A completed moon task prints, after ANSI stripping, as:
//
//   ▮▮▮▮ archkeep:lint (33s 433ms, e708a2a4)
//
// with a progress bar of U+25AE glyphs, the `project:task` id, a human
// duration, and the 8-hex task hash. A cached task prints `cached` in place
// of the duration. Lines that do not match — headers, warnings, the
// `Run started` banner — are not task completions and are skipped.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} MoonTask
 * @property {string} task "project:task" id
 * @property {number} durationSec fractional seconds; 0 when cached
 * @property {boolean} cached whether the task reported `cached`
 * @property {string} hash the task's 8-hex content hash
 */

const MOON_TASK_RE = /(?:^|\s)([a-z][\w-]*:[a-z][\w-]*) \(([^()]*), ([0-9a-f]{8})\)\s*$/;
const MOON_CACHED_RE = /\bcached\b/;

/**
 * Parses moon task completion lines from a CI log.
 *
 * @param {string} logText full log text, one or many lines
 * @returns {MoonTask[]} completions in log order; empty when none matched
 */
export function parseMoonTasks(logText) {
  const tasks = [];
  for (const rawLine of logText.split("\n")) {
    const line = stripAnsi(rawLine).trimEnd();
    const m = line.match(MOON_TASK_RE);
    if (!m) continue;
    const durationRaw = m[2];
    const cached = MOON_CACHED_RE.test(durationRaw);
    tasks.push({
      task: m[1],
      durationSec: cached ? 0 : parseMoonDuration(durationRaw),
      cached,
      hash: m[3],
    });
  }
  return tasks;
}

/**
 * Parses a moon human duration string into seconds.
 *
 * Accepted shapes (moon always prints at least one unit):
 *   "1m 4s 306ms" → 64.306
 *   "3s 100ms"    → 3.1
 *   "42s"         → 42
 *   "500ms"       → 0.5
 *
 * The minutes match requires a following boundary so the `m` of "ms" is
 * never read as minutes — "39ms" is 0.039 s, not 39 minutes.
 *
 * @param {string} raw duration text from a moon task line
 * @returns {number} seconds (fractional)
 */
export function parseMoonDuration(raw) {
  let total = 0;
  const minutes = raw.match(/(\d+)m(?=\s|$)/);
  if (minutes) total += Number.parseInt(minutes[1], 10) * 60;
  const seconds = raw.match(/(\d+(?:\.\d+)?)s(?!\w)/);
  if (seconds) total += Number.parseFloat(seconds[1]);
  const ms = raw.match(/(\d+)ms\b/);
  if (ms) total += Number.parseInt(ms[1], 10) / 1000;
  return total;
}

/**
 * Parses vitest per-file result lines from a CI log.
 *
 * A completed file prints, after ANSI stripping, as:
 *
 *   ✓ packages/archkeep/e2e/parity.e2e.mjs (5 tests) 56012ms
 *
 * The slow-files summary section repeats files as `❯ name (N tests | 1
 * failed) Dms` — the `|` clause makes it not match, so a file listed twice is
 * not counted twice.
 *
 * @param {string} logText full log text, one or many lines
 * @returns {E2EFile[]} completions in log order; empty when none matched
 */
export function parseVitestFiles(logText) {
  const files = [];
  for (const rawLine of logText.split("\n")) {
    const line = stripAnsi(rawLine).trimEnd();
    const m = line.match(VITEST_FILE_RE);
    if (!m) continue;
    files.push({
      file: m[1].trim(),
      tests: Number.parseInt(m[2], 10),
      durationMs: Number.parseInt(m[3], 10),
    });
  }
  return files;
}

/**
 * @typedef {object} E2EFile
 * @property {string} file path as printed by vitest
 * @property {number} tests test count inside the file
 * @property {number} durationMs wall-clock of the file's tests
 */

const VITEST_FILE_RE = /^\s*(?:✓|×|✗|❯|↓)?\s*(.+\.mjs) \((\d+) tests?\) (\d+)ms$/;

/**
 * Sums a parsed E2E file list into total test time, for shard-level
 * comparison.
 *
 * @param {E2EFile[]} files parsed files
 * @returns {number} total duration across files, in ms
 */
export function sumFileMs(files) {
  return files.reduce((total, f) => total + f.durationMs, 0);
}

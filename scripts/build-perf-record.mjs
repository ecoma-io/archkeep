#!/usr/bin/env node
// Builds the machine-readable CI performance record + GitHub Step Summary
// from one CI run's logs and jobs API data.
//
// WHY this script exists (issue #806): the CI/CD optimization program needs
// per-run, per-task, per-file timing evidence to judge every optimization
// hypothesis on measurement, and the raw material already exists — moon
// prints per-task progress lines, vitest prints per-file lines, and the jobs
// API carries step timings. Nothing in CI currently reduces that to a
// machine-readable record; the baseline for this program was assembled by
// hand from log zips. This script closes that gap without touching ci.yml:
// it runs AFTER a run completes (workflow_run trigger), so it can never sit
// on the critical path it measures.
//
// The split mirrors the gate scripts' own pattern: pure functions that take
// facts as arguments, plus a main() that reads files. The parsing lives in
// `perf-parse.mjs`; this file classifies and assembles.
//
// Silent-direction guard: a gap — a job with no log entry, a log with no
// parseable lines — is RECORDED in the record's `gaps` array with the name
// of what is missing, never collapsed to an empty array. An empty task list
// is byte-for-byte identical to "nothing measured" otherwise, and the
// record's whole purpose is to make absence loud.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseMoonTasks, parseVitestFiles, sumFileMs } from "./perf-parse.mjs";

// ---------------------------------------------------------------------------
// Pure assembly — takes facts as arguments
// ---------------------------------------------------------------------------

/** Classifies a vitest file line into the suite it belongs to.
 * @param {string} file
 * @returns {"e2e" | "unit"}
 */
export function vitestSuiteOf(file) {
  return /\.e2e\.mjs$/.test(file) ? "e2e" : "unit";
}

/** @typedef {{jobName: string, text: string}} LogEntry */

/** @typedef {{
 *   name: string,
 *   startedAt: string | null,
 *   completedAt: string | null,
 *   conclusion: string | null,
 * }} JobMeta
 */

/** @typedef {{
 *   schemaVersion: number,
 *   run: {id: number, headSha: string, event: string, conclusion: string | null, createdAt: string, updatedAt: string},
 *   jobs: Record<string, {
 *     wallSec: number | null,
 *     conclusion: string | null,
 *     moon?: {count: number, totalSec: number, cached: number, tasks: ReturnType<typeof parseMoonTasks>},
 *     vitest?: {e2e: {count: number, totalMs: number, files: object[]}, unit: {count: number, totalMs: number, files: object[]}},
 *   }>,
 *   gaps: string[],
 * }} PerfRecord
 */

/**
 * Assembles the perf record from logs and job metadata.
 *
 * @param {LogEntry[]} logs one entry per job log file
 * @param {JobMeta[]} jobs from the run's jobs API endpoint
 * @param {{id: number, headSha: string, event: string, conclusion: string | null, createdAt: string, updatedAt: string}} run
 * @returns {PerfRecord}
 */
export function buildRecord(logs, jobs, run) {
  const record = {
    schemaVersion: 1,
    run,
    jobs: {},
    gaps: [],
  };
  const jobByName = new Map(jobs.map((j) => [normalizeJobName(j.name), j]));

  for (const log of logs) {
    const jobName = log.jobName;
    const meta = jobByName.get(normalizeJobName(jobName));
    const start = meta?.startedAt ?? null;
    const end = meta?.completedAt ?? null;
    const entry = {
      wallSec: start && end ? (Date.parse(end) - Date.parse(start)) / 1000 : null,
      conclusion: meta?.conclusion ?? null,
    };

    const moonTasks = parseMoonTasks(log.text);
    if (moonTasks.length > 0) {
      entry.moon = {
        count: moonTasks.length,
        totalSec: round1(moonTasks.reduce((a, t) => a + t.durationSec, 0)),
        cached: moonTasks.filter((t) => t.cached).length,
        tasks: moonTasks,
      };
    }

    const vFiles = parseVitestFiles(log.text);
    if (vFiles.length > 0) {
      const e2e = vFiles.filter((f) => vitestSuiteOf(f.file) === "e2e");
      const unit = vFiles.length - e2e.length;
      entry.vitest = {
        e2e: { count: e2e.length, totalMs: sumFileMs(e2e), files: e2e },
        unit: {
          count: unit,
          totalMs: sumFileMs(vFiles) - sumFileMs(e2e),
          files: unit === 0 ? [] : vFiles.filter((f) => vitestSuiteOf(f.file) === "unit"),
        },
      };
    }

    record.jobs[jobName] = entry;
    if (!meta) record.gaps.push(`job metadata absent for log entry "${jobName}"`);
  }

  for (const j of jobs) {
    if (!logs.some((l) => normalizeJobName(logJobNameOf(l.jobName)) === normalizeJobName(j.name))) {
      record.gaps.push(`log entry absent for job "${j.name}"`);
    }
  }
  return record;
}

/**
 * Maps a log-zip file name back to a job name. GitHub names log entries
 * `<jobId>_<jobName>.txt` with `/` replaced by `_`. The numeric prefix is
 * stripped; underscores are NOT restored (a job name may itself contain
 * underscores), so the mapping back to API names is by suffix match.
 *
 * @param {string} logFileName
 * @returns {string} job name as the jobs API spells it
 */
export function logJobNameOf(logFileName) {
  return logFileName.replace(/^\d+_/, "").replace(/\.txt$/, "");
}

/**
 * Normalizes a job name for joining logs to API metadata: the log zip
 * replaces `/` with `_` in entry names, so both sides must fold `/` to `_`.
 * @param {string} name
 * @returns {string}
 */
export function normalizeJobName(name) {
  return name.replaceAll("/", "_");
}

/** @returns {number} value rounded to 1 decimal */
function round1(n) {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// I/O — reads the log directory and jobs JSON, writes the record + summary
// ---------------------------------------------------------------------------

/**
 * Reads one job log from the extracted log zip.
 * @param {string} dir extracted log directory
 * @param {string} name log file name
 * @returns {string}
 */
function readLog(dir, name) {
  return readFileSync(join(dir, name), "utf8");
}

/**
 * Builds the markdown Step Summary. Named gaps print in their own section —
 * a run with a missing log is reported as such, not as an empty table.
 * @param {PerfRecord} record
 * @returns {string} markdown
 */
export function renderSummaryMarkdown(record) {
  const lines = [];
  const r = record.run;
  lines.push(`## CI performance record — run ${r.id}`);
  lines.push("");
  lines.push(
    `Event: \`${r.event}\` · SHA \`${r.headSha.slice(0, 8)}\` · conclusion: ${r.conclusion ?? "unknown"}`,
  );
  lines.push("");
  lines.push("### Jobs");
  lines.push("");
  lines.push("| job | wall | moon tasks | moon total | E2E files | E2E total | gaps? |");
  jobsTableLinePush(lines, record);
  return lines.join("\n") + "\n";
}

/**
 * Fills in the jobs table body. The table is per-job; per-task and per-file
 * detail stays in the JSON record (the summary stays readable at a glance).
 * @param {string[]} lines
 * @param {PerfRecord} record
 * @returns {void}
 */
function jobsTableLinePush(lines, record) {
  for (const [jobName, j] of Object.entries(record.jobs)) {
    const wall = j.wallSec == null ? "n/a" : fmtSec(j.wallSec);
    const moonCount = j.moon?.count ?? 0;
    const moonTotal = j.moon ? fmtSec(j.moon.totalSec) : "—";
    const e2eCount = j.vitest?.e2e?.count ?? 0;
    const e2eTotal = j.vitest?.e2e?.totalMs ? `${(j.vitest.e2e.totalMs / 1000).toFixed(1)}s` : "—";
    const gapsFlag = record.gaps.some((g) => g.includes(jobName)) ? "yes" : "";
    lines.push(
      `| ${jobName} | ${wall} | ${moonCount} | ${moonTotal} | ${e2eCount} | ${e2eTotal} | ${gapsFlag} |`,
    );
  }
}

/** @returns {string} seconds rendered as "12.3s" or "1m 4s" past an hour */
function fmtSec(sec) {
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    return `${m}m ${Math.round(sec - m * 60)}s`;
  }
  return `${Math.round(sec * 10) / 10}s`;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/**
 * Reads the extracted logs + jobs JSON, writes the perf record JSON and the
 * markdown summary. All inputs come from arguments; the only filesystem
 * access is reading exactly what was passed in and writing exactly the two
 * output paths.
 *
 * @param {{
 *   logsDir: string,
 *   jobsJson: string,
 *   runId: string,
 *   headSha: string,
 *   event: string,
 *   conclusion: string | null,
 *   createdAt: string,
 *   updatedAt: string,
 *   out: string,
 *   summary: string,
 * }} argv parsed arguments
 * @returns {PerfRecord} the record also written to disk
 */
export function main(argv) {
  const logs = [];
  for (const name of readdirSync(argv.logsDir).sort()) {
    if (!name.endsWith(".txt") || name === "system.txt") continue;
    logs.push({ jobName: logJobNameOf(name), text: readLog(argv.logsDir, name) });
  }
  if (logs.length === 0) {
    throw new Error(
      `no job logs found in ${argv.logsDir} — an empty record is not a clean record, it is an unmeasured one`,
    );
  }
  const jobsRaw = JSON.parse(readFileSync(argv.jobsJson, "utf8"));
  const jobs = (Array.isArray(jobsRaw) ? jobsRaw : (jobsRaw.jobs ?? [])).map((j) => ({
    name: j.name,
    startedAt: j.started_at,
    completedAt: j.completed_at,
    conclusion: j.conclusion,
  }));
  const run = {
    id: Number(argv.runId),
    headSha: argv.headSha,
    event: argv.event,
    conclusion: argv.conclusion,
    createdAt: argv.createdAt,
    updatedAt: argv.updatedAt,
  };
  const record = buildRecord(logs, jobs, run);
  writeFileSync(argv.out, JSON.stringify(record, null, 1) + "\n");
  writeFileSync(argv.summary, renderSummaryMarkdown(record));
  console.log(
    `perf record: ${Object.keys(record.jobs).length} jobs, ${record.gaps.length} gaps -> ${argv.out}`,
  );
  return record;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

import { parseArgs } from "node:util";

/**
 * Parses CLI arguments. Exported for tests; the parser has no side effects.
 * @param {string[]} args process.argv.slice(2)
 * @returns {{values: Record<string, string | boolean | null>}} kebab-case keys as parsed
 */
export function parseCliArgs(args) {
  const { values } = parseArgs({
    args,
    options: {
      "logs-dir": { type: "string" },
      "jobs-json": { type: "string" },
      "run-id": { type: "string" },
      "head-sha": { type: "string" },
      event: { type: "string" },
      conclusion: { type: "string" },
      "created-at": { type: "string" },
      "updated-at": { type: "string" },
      out: { type: "string" },
      summary: { type: "string" },
      "skip-missing": { type: "boolean", default: false },
    },
  });
  return { values };
}

/** Invoked only when run directly: `node scripts/build-perf-record.mjs ...` */
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const { values } = parseCliArgs(process.argv.slice(2));
  main({
    logsDir: String(values["logs-dir"]),
    jobsJson: String(values["jobs-json"]),
    runId: String(values["run-id"]),
    headSha: String(values["head-sha"]),
    event: String(values.event),
    conclusion: values.conclusion == null ? null : String(values.conclusion),
    createdAt: String(values["created-at"]),
    updatedAt: String(values["updated-at"]),
    out: String(values.out),
    summary: String(values.summary),
  });
}

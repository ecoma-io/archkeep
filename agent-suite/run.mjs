#!/usr/bin/env node
// Runs the agent-workflow evaluation suite: every scenarios/*/run.sh, in
// name order, each in a clean environment with ARCHKEEP_CLI pointing at the
// engine CLI. Report mode prints the score table and exits 0 (a `fail`
// score is a finding about the workflow, not a harness error); gate mode
// exits nonzero unless every scenario scored pass.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const suiteRoot = dirname(fileURLToPath(import.meta.url));
const scenariosRoot = join(suiteRoot, "scenarios");
const cli = resolve(suiteRoot, "..", "packages", "archkeep", "cli.mjs");
const gate = process.argv.includes("--gate");

const slugs = readdirSync(scenariosRoot)
  .filter((name) => !name.startsWith("."))
  .sort();

/** @type {{ slug: string, score: string, broken: boolean, observed: string[], note: string }[]} */
const rows = [];

for (const slug of slugs) {
  const dir = join(scenariosRoot, slug);
  const run = spawnSync("bash", ["run.sh"], {
    cwd: dir,
    env: { ...process.env, ARCHKEEP_CLI: cli },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = `${run.stdout ?? ""}`;
  const err = `${run.stderr ?? ""}`;
  const scoreMatch = out.match(/^SCORE (pass|fail)\s*$/m);
  const broken = run.status === null || run.status === 2 || scoreMatch === null;
  rows.push({
    slug,
    score: broken ? "BROKEN" : scoreMatch[1],
    broken,
    observed: out
      .split("\n")
      .filter((line) => line.startsWith("OBSERVED "))
      .map((line) => line.replace(/^OBSERVED /, "").trim()),
    note: err
      .split("\n")
      .filter((line) => line.startsWith("note: "))
      .join("\n"),
  });
}

const width = Math.max(...rows.map((row) => row.slug.length), 8);
for (const row of rows) {
  const mark = row.score === "pass" ? "ok  " : row.score === "fail" ? "MISS" : "BAD ";
  process.stdout.write(`${mark} ${row.slug.padEnd(width)} ${row.observed.join(" | ")}\n`);
  if (row.note !== "") process.stdout.write(`     ${row.note.split("\n").join("\n     ")}\n`);
}

const passes = rows.filter((row) => row.score === "pass").length;
const fails = rows.filter((row) => row.score === "fail").length;
const broken = rows.filter((row) => row.broken);
process.stdout.write(
  `\n${passes} pass, ${fails} fail, ${broken.length} broken of ${rows.length} scenarios\n`,
);
if (broken.length > 0) {
  process.stderr.write(
    `broken scenarios (exit 2 or no SCORE line): ${broken.map((row) => row.slug).join(", ")}\n`,
  );
}
if (gate && (fails > 0 || broken.length > 0)) process.exit(1);

#!/usr/bin/env node
// Runs the agent-workflow evaluation suite: every scenarios/*/run.sh, in
// name order, each in a clean environment with ARCHKEEP_CLI pointing at the
// engine CLI. Report mode prints the score table and exits 0 (a `fail`
// score is a finding about the workflow, not a harness error); gate mode
// exits nonzero unless every scenario scored pass.
//
// Every scenario also binds a set of protocol forcing points
// (`bindings.json`, ids from `scripts/skill-protocol.mjs`), which the runner
// asserts against the shipped skill files before the scenario's own script
// runs. The binding is what makes a scenario's skill-text half measurable:
// the scenario stages a workspace and reads the engine's verdicts, while the
// claim "the skill mandates this step" is checked against
// `skills/<skill>/SKILL.md` — files the scenario cannot author (#935: the
// suite used to pass 10/10 with the skill layer deleted, because its
// transcript fixtures decided their own scores). An unmet binding scores
// `fail` with the requirement id in the note — that red is the mutation
// signal the suite exists to emit.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSkillTexts, unmetBoundRequirements } from "./protocol-gate.mjs";

const suiteRoot = dirname(fileURLToPath(import.meta.url));
const scenariosRoot = join(suiteRoot, "scenarios");
const cli = resolve(suiteRoot, "..", "packages", "archkeep", "cli.mjs");
const gate = process.argv.includes("--gate");

const slugs = readdirSync(scenariosRoot)
  .filter((name) => !name.startsWith("."))
  .sort();

const skillTexts = readSkillTexts();

/** @type {{ slug: string, score: string, broken: boolean, observed: string[], note: string }[]} */
const rows = [];

for (const slug of slugs) {
  const dir = join(scenariosRoot, slug);

  // The scenario's binding, read before its script runs. A missing, empty,
  // or non-array binding, or an id the table does not know, is a BROKEN
  // scenario — a suite that let a scenario bind nothing would be the
  // fixture-self-authorship failure again in a cheaper disguise.
  let bindings = null;
  let bindingError = null;
  try {
    bindings = JSON.parse(readFileSync(join(dir, "bindings.json"), "utf8"));
    if (!Array.isArray(bindings) || bindings.length === 0) {
      bindingError = "bindings.json must be a non-empty array of requirement ids";
    }
  } catch (err) {
    bindingError =
      err instanceof SyntaxError
        ? "bindings.json is not valid JSON"
        : "bindings.json is missing — every scenario binds the protocol forcing points it exercises";
  }

  let unmet = [];
  if (bindingError === null) {
    try {
      unmet = unmetBoundRequirements(bindings, skillTexts);
    } catch (err) {
      bindingError = /** @type {Error} */ (err).message;
    }
  }

  const run = spawnSync("bash", ["run.sh"], {
    cwd: dir,
    env: { ...process.env, ARCHKEEP_CLI: cli },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = `${run.stdout ?? ""}`;
  const err = `${run.stderr ?? ""}`;
  const scoreMatch = out.match(/^SCORE (pass|fail)\s*$/m);
  const scriptBroken = run.status === null || run.status === 2 || scoreMatch === null;
  const broken = scriptBroken || bindingError !== null;
  const score = broken
    ? "BROKEN"
    : scoreMatch[1] === "pass" && unmet.length === 0
      ? "pass"
      : "fail";
  const observed = [
    `protocol=${
      bindingError !== null
        ? "error"
        : unmet.length === 0
          ? `ok:${bindings.join(",")}`
          : `unmet:${unmet.map((r) => r.id).join(",")}`
    }`,
  ];
  for (const line of out.split("\n")) {
    if (line.startsWith("OBSERVED ")) observed.push(line.replace(/^OBSERVED /, "").trim());
  }
  let note = "";
  if (bindingError !== null) note += `note: ${bindingError}\n`;
  if (unmet.length > 0) {
    note +=
      `note: the shipped skill text no longer states ` +
      `${unmet.map((r) => r.id).join(", ")} — the forcing point this scenario binds ` +
      `was deleted or reworded past its anchors\n`;
  }
  for (const line of err.split("\n")) {
    if (line.startsWith("note: ")) note += `${line}\n`;
  }
  rows.push({ slug, score, broken, observed, note });
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

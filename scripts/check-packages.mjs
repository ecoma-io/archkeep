#!/usr/bin/env node
// Asserts that every directory under `packages/` is a project the workspace tool
// can actually see, and that each one declares at least one of the targets CI runs.
//
// WHY this script exists. Three states produce an identical green run and an
// identical exit code 0 whether the workspace tool is Nx or Moon:
//
//   1. There is no project at all — the tool prints "no projects" or "no tasks
//      were run" and exits 0.
//   2. A project exists but declares none of those targets — it is skipped in
//      silence. No warning, no mention, exit 0.
//   3. A directory exists with sources but no manifest — it is invisible to the
//      tool's project list, so nothing is skipped, because as far as the tool is
//      concerned nothing is there.
//
// `packages/` is empty at this commit, so state 1 is the truth today. What makes
// that a problem is not today: it is that the gate stays green on the day
// someone adds the first package in shape 2 or 3. A check that cannot tell
// "nothing exists yet" from "something exists and fell out of the graph" is not
// reporting a verdict, it is reporting silence — and silence reads as success.
//
// So this script turns each of the three into a distinct, stated outcome: 3
// fails, 2 fails, and 1 prints that the directory is empty *on purpose*. The
// empty state becomes something the repository declares rather than something a
// reader infers from a command that found nothing to do.
//
// The list of targets is READ OUT OF `.github/workflows/ci.yml` — out of the
// `moon run …` or `nx run-many -t …` line itself — never written here a second
// time. CI is where "green" is defined; a copy of that list in this file would
// be a second definition, and the two would agree only until someone edited one
// of them. That is the failure this script is meant to catch, so it must not
// contain an instance of it.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PACKAGES_DIR = "packages";
export const CI_WORKFLOW = ".github/workflows/ci.yml";

/**
 * The targets CI runs, taken from every `moon run …:<target>` and
 * `moon ci …:<target>` invocation in the workflow (the `...` prefix means
 * "all projects"). Both spellings name the same roster — that is the drift
 * this derivation pins — so every invocation found contributes its targets.
 *
 * Three things a legal edit to `ci.yml` can do, each handled explicitly so
 * none of them silently narrows the list this script enforces:
 *   - a shell line continuation (a trailing `\`) splits one invocation across
 *     physical lines — those lines are joined into one logical line first;
 *   - the run step can be split into more than one `moon run …` invocation —
 *     every one found contributes its targets, not just the first;
 *   - a comment can mention "moon run" in prose — whole-line comments (a
 *     line whose first non-whitespace character is `#`) are dropped before
 *     any of the above, so they can never seed or pollute the list.
 *
 * Within one invocation, stripping the `...:` prefix and stopping at the
 * first token that is not a project-scoped target (once a target has been
 * seen) still applies, so a trailing flag like `--parallel` does not become a
 * target.
 *
 * @param {string} workflowText contents of `.github/workflows/ci.yml`
 * @returns {string[]} target names, deduplicated, in the order first seen
 */
export function parseCiTargets(workflowText) {
  const logicalLines = [];
  let pending = null;
  for (const rawLine of workflowText.split("\n")) {
    if (/^\s*#/.test(rawLine)) continue; // whole-line comment — never a source of targets
    const line = pending !== null ? `${pending} ${rawLine.trim()}` : rawLine;
    if (/\\\s*$/.test(line)) {
      // Shell line continuation: strip the trailing backslash and carry the
      // rest forward to be joined with the next physical line.
      pending = line.replace(/\\\s*$/, "").trimEnd();
      continue;
    }
    pending = null;
    logicalLines.push(line);
  }

  const targets = [];
  const seen = new Set();
  for (const line of logicalLines) {
    // Moon: `moon run ...:lint ...:test ...:typecheck` or `moon ci :lint :test` —
    // the same roster under two commands, both read.
    const moonMatch = /moon\s+(?:run|ci)\s+(.*)$/.exec(line);
    if (!moonMatch) continue;
    // Tracked per line, not globally: a second `moon run` invocation must be
    // free to skip its OWN leading flags even though earlier lines already
    // pushed targets — the stop-at-a-flag rule is local to one invocation.
    const targetsOnThisLine = [];
    for (const word of moonMatch[1].trim().split(/[\s,]+/)) {
      // Skip flags (e.g. --force) that appear before this line's target list.
      // Once a target has been seen ON THIS LINE, any flag breaks the loop —
      // that is the stop condition for a trailing flag like --parallel.
      if (word.startsWith("--") && targetsOnThisLine.length === 0) continue;
      // Strip the all-projects prefix Moon spells two ways — `...:target` (the
      // form the `moon run` line uses) and `:target` (the form the `moon ci`
      // line uses). Project-qualified targets (`archkeep:e2e`) are skipped
      // first: they are not part of the every-project roster this gate holds
      // projects to, and Moon itself fails a run that names a target no
      // project declares.
      if (/^[a-z][a-z0-9-]*:/i.test(word)) continue;
      const target = word.replace(/^(?:\.{3})?:/, "");
      if (!/^[a-z][a-z0-9:-]*$/i.test(target)) break;
      targetsOnThisLine.push(target);
    }
    for (const target of targetsOnThisLine) {
      if (!seen.has(target)) {
        seen.add(target);
        targets.push(target);
      }
    }
  }
  return targets;
}

/**
 * Compares the directories on disk against the projects the workspace tool
 * reports, and against the targets CI runs.
 *
 * Kept free of IO so it can be tested without a workspace: every fact it needs
 * arrives as an argument. `projects` maps a project name to the root it
 * declares and the target names it declares.
 *
 * `extraRequiredRoots` holds project roots the graph must declare that no
 * `packages/` directory scan can discover — `scripts/`, whose project holds
 * the gate scripts. A root listed here that no project claims fails exactly
 * like an invisible package: the same silent-green shape, one directory
 * outside the glob that would otherwise catch it.
 *
 * @param {object} input
 * @param {string[]} input.packageDirs directory names directly under `packages/`
 * @param {{name: string, root: string, targets: string[]}[]} input.projects what the workspace tool reports
 * @param {string[]} input.ciTargets targets the CI workflow runs
 * @param {string[]} [input.extraRequiredRoots] project roots required beyond `packages/*`
 * @returns {{lines: string[], failures: string[]}}
 */
export function evaluate({ packageDirs, projects, ciTargets, extraRequiredRoots = [] }) {
  const lines = [];
  const failures = [];

  const byRoot = new Map(projects.map((p) => [p.root, p]));

  /**
   * Judges one expected root — visible in the graph, declaring a CI target,
   * or failing with the reason it would have run zero times in silence.
   *
   * @param {string} expectedRoot workspace-relative root a project must own
   * @param {string} kind what the root holds, for the failure wording
   */
  function judge(expectedRoot, kind) {
    const project = byRoot.get(expectedRoot);

    if (!project) {
      failures.push(
        `${expectedRoot} is not a project the workspace tool can see. It has no ` +
          `manifest (no \`moon.yml\`, \`package.json\`, or \`project.json\`), so the ` +
          `project list does not include it and every target runs over it zero times — ` +
          `while still exiting 0. Add a manifest.`,
      );
      lines.push(`FAIL ${expectedRoot} — invisible to the graph`);
      return;
    }

    const declared = ciTargets.filter((t) => project.targets.includes(t));
    const missing = ciTargets.filter((t) => !project.targets.includes(t));

    if (declared.length === 0) {
      failures.push(
        `${project.name} (${expectedRoot}) declares none of the targets CI runs ` +
          `(${ciTargets.join(", ")}). The workspace tool skips a project with no ` +
          `matching target in silence, so nothing checks this ${kind} and the run ` +
          `still exits 0.`,
      );
      lines.push(`FAIL ${project.name} — declares no CI target`);
      return;
    }

    // Not every package legitimately has every target — a buildless package has
    // nothing to build, and inventing an empty `build` to satisfy a gate is the
    // placeholder-shaped green this script exists to prevent. So a partial set
    // is reported rather than failed: the log says which checks reach this
    // package, and a reviewer decides whether the gap is the intended one.
    const note = missing.length > 0 ? ` (no ${missing.join(", ")})` : "";
    lines.push(`ok   ${project.name} — ${declared.join(", ")}${note}`);
  }

  if (packageDirs.length === 0) {
    lines.push(`0 packages — declared empty`);
    lines.push(
      `${PACKAGES_DIR}/ holds no package yet, so a green CI run runs nothing. That ` +
        `is stated here rather than left to be inferred from a command that found ` +
        `no work.`,
    );
  }

  for (const dir of packageDirs) {
    judge(`${PACKAGES_DIR}/${dir}`, "package");
  }

  for (const requiredRoot of extraRequiredRoots) {
    judge(requiredRoot, "project");
  }

  return { lines, failures };
}

/** Directory names directly under `packages/`, or `[]` when it does not exist. */
function readPackageDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Asks Moon what projects exist, through its own CLI — the point of the check is
 * what the graph contains, which only Moon can answer. Reading the manifests here
 * instead would re-implement project discovery and agree with Moon right up until
 * it did not.
 */
function readMoonProjects() {
  // Moon is installed as a dev dependency; `node_modules/.bin/moon` is the pnpm
  // shim that resolves to the platform-specific binary. Adding that directory to
  // PATH makes `moon` findable by `spawnSync` without depending on a global
  // install — the same convention `npx` uses.
  const binDir = join(root, "node_modules", ".bin");
  const pathEnv = process.env.PATH ?? "";
  const pathWithBin = pathEnv.includes(binDir) ? pathEnv : `${binDir}:${pathEnv}`;

  const result = spawnSync("moon", ["projects", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: pathWithBin },
  });

  if (result.status !== 0) {
    console.error(result.stdout ?? "");
    console.error(result.stderr ?? "");
    console.error("`moon projects --json` failed, so the project list could not be read.");
    process.exit(1);
  }

  const projects = JSON.parse(result.stdout);
  return projects.map((p) => ({
    name: p.id,
    root: p.source,
    targets: Object.keys(p.config?.tasks ?? {}),
  }));
}

function main() {
  const workflowPath = join(root, CI_WORKFLOW);
  if (!existsSync(workflowPath)) {
    console.error(
      `${CI_WORKFLOW} is missing, and it is where the list of targets this check ` +
        `enforces comes from. Without it there is nothing to check against.`,
    );
    process.exit(1);
  }

  const ciTargets = parseCiTargets(readFileSync(workflowPath, "utf8"));
  if (ciTargets.length === 0) {
    console.error(
      `No \`moon run …\`/\`moon ci …\` invocation was found in ` +
        `${CI_WORKFLOW}. Either CI stopped running the workspace's targets, or the ` +
        `line moved — both mean this check no longer knows what green is supposed ` +
        `to mean.`,
    );
    process.exit(1);
  }

  const packageDirs = readPackageDirs(join(root, PACKAGES_DIR));
  const projects = readMoonProjects();
  const { lines, failures } = evaluate({
    packageDirs,
    projects,
    ciTargets,
    // `scripts/` holds the gate scripts — outside the packages glob the scan
    // above reads, so its project is required by name rather than discovered.
    extraRequiredRoots: ["scripts"],
  });

  for (const line of lines) console.log(line);

  if (failures.length > 0) {
    console.error("");
    for (const failure of failures) console.error(`✗ ${failure}`);
    process.exit(1);
  }
}

/**
 * Whether this file was RUN rather than imported, compared on real paths.
 *
 * The obvious spelling — `process.argv[1] === fileURLToPath(import.meta.url)` —
 * is false whenever the invoking path contains a symlink anywhere in it: Node
 * resolves symlinks before recording a module's URL, and records `argv[1]`
 * exactly as the caller spelled it. Measured: a checkout reached through a
 * symlinked parent directory makes the two differ, `main()` never runs, and the
 * gate exits 0 having checked nothing — the silent green this script exists to
 * refuse, arriving by way of its own entry guard.
 *
 * Not imported from `packages/archkeep/src/entry-point.mjs`, which
 * holds the same function for the same reason: that package's conformance suite
 * requires it to be self-contained and reachable only from its own tree, and a
 * repo-root script importing into it would make this file part of what the
 * package ships. Two callers, one small function, and a boundary between them
 * that is the point rather than an accident — so it is stated twice, each with
 * the reason, rather than shared across a line neither side should cross.
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) main();

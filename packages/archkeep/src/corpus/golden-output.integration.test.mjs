/**
 * Golden-output byte-identity gate (Phase 4, GAP-A + GAP-B).
 *
 * Every read-only CLI verb is run over a determinism-sweep fixture tree and its
 * stdout compared byte-for-byte against the committed golden file.  The
 * fixture is the "determinism sweep" with a passing fitness function, two
 * commits (so `evolution --base HEAD~1` works), and a minimal scenario file
 * (so `scenario` works).
 *
 * Regenerate with:
 *
 *   ARCHKEEP_UPDATE_GOLDENS=1 npx vitest run src/corpus/golden-output.integration.test.mjs
 *
 * Then review every golden diff before committing.
 *
 * ## Non-byte-identity verbs
 *
 * Most verbs gate at byte-identity (GAP-A level 3). One verb has an exception:
 *
 * | Verb   | Gate level     | Reason                                           |
 * |--------|----------------|--------------------------------------------------|
 * | `debt` | Level 1+2 only | `sampleTime` is wall-clock (see debt.mjs:197-200); JSON normalizes the field before comparison; text checks exit+non-empty |
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EXIT } from "../verdict.mjs";
import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../../spawn-budget.mjs";
import { COMMAND_NAMES } from "../../cli.mjs";
import { determinismSweepFiles, sweepIntents } from "../../e2e/fixtures/determinism-sweep.mjs";

vi.setConfig({ testTimeout: SPAWN_TEST_BUDGET_MS });

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CLI = fileURLToPath(new URL("../../cli.mjs", import.meta.url));
const GOLDEN_DIR = fileURLToPath(new URL("./goldens", import.meta.url));
const UPDATING = process.env.ARCHKEEP_UPDATE_GOLDENS === "1";

// ---------------------------------------------------------------------------
// Deterministic git environment
// ---------------------------------------------------------------------------

const GIT_IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const GIT_DATE_ENV = {
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

// ---------------------------------------------------------------------------
// Corpus plan
// ---------------------------------------------------------------------------

/**
 * Every golden verb with its argv template and output formats.
 * The template's `{format}` placeholder is replaced at test time.
 * A `setup` hook is called before the verb is run.
 */
const VERB_PLAN = [
  // Plain verbs — one positional: the verb name
  { name: "check", argv: ["check", "--format", "{format}"], formats: ["text", "sarif", "json"] },
  { name: "graph", argv: ["graph", "--format", "{format}"], formats: ["text", "json"] },
  { name: "discover", argv: ["discover", "--format", "{format}"], formats: ["text", "json"] },
  { name: "drift", argv: ["drift", "--format", "{format}"], formats: ["text", "json"] },
  { name: "reconcile", argv: ["reconcile", "--format", "{format}"], formats: ["text", "json"] },
  { name: "waivers", argv: ["waivers", "--format", "{format}"], formats: ["text", "json"] },
  { name: "fitness", argv: ["fitness", "--format", "{format}"], formats: ["text", "json"] },
  { name: "health", argv: ["health", "--format", "{format}"], formats: ["text", "json"] },
  { name: "report", argv: ["report", "--format", "{format}"], formats: ["text", "json"] },
  { name: "impact", argv: ["impact", "core", "--format", "{format}"], formats: ["text", "json"] },
  { name: "context", argv: ["context", "core", "--format", "{format}"], formats: ["text", "json"] },
  { name: "provenance", argv: ["provenance", "--format", "{format}"], formats: ["text", "json"] },
  { name: "adr", argv: ["adr", "--format", "{format}"], formats: ["text", "json"] },
  {
    name: "decisions",
    argv: ["decisions", "0001-layers", "--format", "{format}"],
    formats: ["text", "json"],
  },

  {
    name: "explain",
    argv: ["explain", "libs/api/api.go:3:8", "--format", "{format}"],
    formats: ["text", "json"],
  },
  {
    name: "diff",
    argv: ["diff", "{diffBaseline}", "--format", "{format}"],
    formats: ["text", "json"],
  },
  {
    name: "delta",
    argv: ["delta", "{deltaBaseline}", "--format", "{format}"],
    formats: ["text", "sarif", "json"],
  },
  {
    name: "change",
    argv: ["change", "{deltaBaseline}", "--intent", "{changeIntent}", "--format", "{format}"],
    formats: ["text", "json"],
  },
  {
    name: "history",
    argv: ["history", "{historyDir}", "--format", "{format}"],
    formats: ["text", "json"],
  },
  {
    name: "trajectory",
    argv: ["trajectory", "{historyDir}", "--format", "{format}"],
    formats: ["text", "json"],
  },

  // Verbs needing a second commit and --base
  {
    name: "evolution",
    argv: ["evolution", "--base", "HEAD~1", "--format", "{format}"],
    formats: ["text", "json"],
  },

  // Verbs needing a scenario file
  {
    name: "scenario",
    argv: ["scenario", "core", "--scenario-file", "{scenarioFile}", "--format", "{format}"],
    formats: ["text", "json"],
  },

  // Verbs with known exit-code contracts (exit 3)
  {
    name: "rules verify",
    argv: ["rules", "verify", "--format", "{format}"],
    formats: ["text", "json"],
  },

  // Non-byte-identity verb: sampleTime is wall-clock per debt.mjs:197-200
  {
    name: "debt",
    argv: ["debt", "{historyDir}", "--format", "{format}"],
    formats: ["text", "json"],
    comparator: "debt",
  },
];

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

/**
 * Default: byte-identity (GAP-A level 3). Both stdout buffers compared
 * verbatim via vitest's toEqual.
 */
function byteIdentityComparator(stdout, golden) {
  expect(stdout).toEqual(golden);
}

/**
 * Debt comparator: level 1+2 contract check (GAP-A level-3 triaged).
 *
 * JSON format — parse both, verify structural contract, then normalise
 * `result.sampleTime` to 0 before comparing the remaining fields.
 *
 * Text format — verify exit 0 + non-empty output.  The golden is retained for
 * evidence but the gate does not enforce byte-identity on text.
 */
function debtComparator(stdout, golden, format) {
  if (format === "json") {
    const actual = JSON.parse(stdout.toString());
    const expected = JSON.parse(golden.toString());

    // Structural contract: envelope shape
    const envelopeKeys = [
      "schemaVersion",
      "tool",
      "command",
      "workspace",
      "status",
      "exitCode",
      "coverage",
      "result",
    ];
    for (const key of envelopeKeys) {
      expect(actual).toHaveProperty(key);
    }

    // Command identity
    expect(actual.schemaVersion).toBe(2);
    expect(actual.command).toBe("debt");
    expect(actual.status).toBe("ok");
    expect(actual.exitCode).toBe(0);

    // Tool contract
    expect(actual.tool).toHaveProperty("name");
    expect(actual.tool).toHaveProperty("version");

    // Workspace contract
    expect(actual.workspace).toHaveProperty("root");
    expect(actual.workspace).toHaveProperty("provider");
    expect(actual.workspace).toHaveProperty("marker");
    expect(actual.workspace).toHaveProperty("provenance");

    // Coverage contract
    expect(actual.coverage.complete).toBe(true);
    expect(actual.coverage.projects).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(actual.coverage.notes)).toBe(true);

    // Result structural contract
    const resultKeys = [
      "dir",
      "snapshots",
      "agings",
      "sampleTime",
      "entries",
      "resolved",
      "total",
      "byKind",
      "bySeverity",
      "lifecycle",
    ];
    for (const key of resultKeys) {
      expect(actual.result).toHaveProperty(key);
    }
    expect(typeof actual.result.sampleTime).toBe("string");
    expect(typeof actual.result.agings).toBe("boolean");
    expect(Array.isArray(actual.result.entries)).toBe(true);
    expect(typeof actual.result.total).toBe("number");
    expect(typeof actual.result.byKind).toBe("object");
    expect(typeof actual.result.bySeverity).toBe("object");

    // Normalise sampleTime in both to isolate the non-deterministic field
    actual.result.sampleTime = "0";
    expected.result.sampleTime = "0";

    // Deep structural comparison (vitest's toEqual ignores key ordering)
    expect(actual).toEqual(expected);
    return;
  }

  // Text format: exit code + non-empty (level-1 gate only)
  expect(stdout.length).toBeGreaterThan(0);
}

/** Select the comparator for a verb plan entry. */
function comparatorFor(verb) {
  if (verb.comparator === "debt") return debtComparator;
  return byteIdentityComparator;
}

/**
 * Expected exit code per verb.  Most exit 0; `decisions` and `rules verify`
 * exit 3 (no-verdict — `decisions` has an unresolvable ADR constraint,
 * `rules verify` has no installed catalog).
 */
function expectedExit(verb) {
  if (verb === "decisions" || verb === "rules verify") return EXIT.error; // 3
  return EXIT.ok; // 0
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let root;
let historyDir;
let deltaBaseline;
let changeIntent;
let diffBaseline;
let scenarioFile;

function makeFixture() {
  // Use a deterministic path so the workspace root in CLI output is identical
  // across runs.  Clean any previous fixture first.
  const FIXTURE_ROOT = join(tmpdir(), "archkeep-golden-fixture");
  if (existsSync(FIXTURE_ROOT)) rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  root = FIXTURE_ROOT;
  mkdirSync(root, { recursive: true });

  // Materialise the determinism-sweep fixture
  const files = determinismSweepFiles(
    "archkeep",
    { typescript: "^5.9.0" },
    "pnpm@10.15.1",
    sweepIntents.CLEAN_INTENT,
    { withFitness: "passing" },
  );
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  // Git init with deterministic dates
  const gitEnv = { ...process.env, ...GIT_DATE_ENV };
  const git = (args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitEnv, timeout: SPAWN_BUDGET_MS });
  git(["init", "-q", "-b", "main"]);
  git(GIT_IDENTITY.concat(["add", "-A"]));
  git(GIT_IDENTITY.concat(["add", "-A"]));
  git(GIT_IDENTITY.concat(["commit", "-q", "-m", "fixture"]));

  // Second commit so evolution --base HEAD~1 works
  // Touching archkeep.json changes only its mtime; the commit hash remains
  // deterministic because the tree hash of archkeep.json hasn't changed.  We
  // add a newline that git add sees.
  writeFileSync(
    join(root, "archkeep.json"),
    readFileSync(join(root, "archkeep.json"), "utf8") + "\n",
  );
  git(GIT_IDENTITY.concat(["add", "-A"]));
  git(GIT_IDENTITY.concat(["commit", "-q", "-m", "second"]));

  // Scenario file
  scenarioFile = join(root, "scenario.json");
  writeFileSync(
    scenarioFile,
    JSON.stringify({
      changes: [
        { type: "dependency_added", source: "core", target: "libs/app", edgeType: "static" },
      ],
    }),
  );

  // Auxiliary artifacts: graph baseline, delta capture, history capture
  historyDir = join(root, ".archkeep-history");
  mkdirSync(historyDir, { recursive: true });
  deltaBaseline = join(root, ".archkeep-delta.json");
  changeIntent = join(root, ".archkeep-change.json");
  diffBaseline = join(root, ".archkeep-graph.json");

  const spawnRoot = (args) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: "buffer",
      timeout: SPAWN_BUDGET_MS,
      killSignal: "SIGKILL",
    });

  // History capture
  spawnRoot(["history", historyDir, "--capture"]);
  // Delta capture
  spawnRoot(["delta", "--capture", "--output", deltaBaseline]);
  // Graph baseline for diff
  const graphResult = spawnRoot(["graph", "--format", "json"]);
  writeFileSync(diffBaseline, graphResult.stdout);
  // Change intent manifest (derived from delta capture)
  const deltaContent = JSON.parse(readFileSync(deltaBaseline, "utf8"));
  writeFileSync(
    changeIntent,
    JSON.stringify({
      version: "1",
      base: { commit: deltaContent.provenance.commit },
      projects: { add: [], remove: [] },
      edges: { add: [], remove: [] },
      constraints: {},
    }) + "\n",
  );
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Resolve argv placeholders against the fixture state.
 */
function resolve(argv) {
  return argv.map((part) =>
    part
      .replace("{historyDir}", historyDir)
      .replace("{deltaBaseline}", deltaBaseline)
      .replace("{changeIntent}", changeIntent)
      .replace("{diffBaseline}", diffBaseline)
      .replace("{scenarioFile}", scenarioFile),
  );
}

/** Spawn the CLI and return { status, stdout, stderr }. */
function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: "buffer",
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  makeFixture();
}, SPAWN_TEST_BUDGET_MS);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

for (const verb of VERB_PLAN) {
  describe(`${verb.name} — golden output`, () => {
    for (const fmt of verb.formats) {
      const goldenFile = join(GOLDEN_DIR, `${verb.name}.${fmt}`);

      it(`produces byte-identical ${fmt} output`, () => {
        const argv = resolve(verb.argv.map((p) => p.replace("{format}", fmt)));
        const result = run(argv);

        if (UPDATING) {
          mkdirSync(GOLDEN_DIR, { recursive: true });
          writeFileSync(goldenFile, result.stdout);
          return; // skip assertion when updating
        }

        // Load the golden
        let golden;
        try {
          golden = readFileSync(goldenFile);
        } catch {
          throw new Error(
            `Golden file missing: ${goldenFile}\n` +
              `Regenerate with: ARCHKEEP_UPDATE_GOLDENS=1 npx vitest run src/corpus/golden-output.integration.test.mjs`,
          );
        }

        expect(result.status).toBe(expectedExit(verb.name));
        comparatorFor(verb)(result.stdout, golden, fmt);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// The --help lane — byte-identity for the usage surface (Phase 6, WI-6)
// ---------------------------------------------------------------------------
// `archkeep --help` and `<verb> --help` both print the one usage template to
// stdout and exit 0 — the template interpolates no workspace facts, so its
// bytes are pinned verbatim. A bare invocation prints the same template plus
// the `archkeep: no command given.` line to STDERR and exits 2 — the
// usage-error lane the migration plan promises to leave untouched, pinned the
// same way so a template edit cannot land without a matching golden.

const HELP_GOLDEN = join(GOLDEN_DIR, "help.text");
const USAGE_ERROR_GOLDEN = join(GOLDEN_DIR, "usage-error.text");

describe("the --help lane — byte-identical usage output", () => {
  it("archkeep --help produces byte-identical stdout and exits 0", () => {
    const result = run(["--help"]);

    if (UPDATING) {
      writeFileSync(HELP_GOLDEN, result.stdout);
      return;
    }

    let golden;
    try {
      golden = readFileSync(HELP_GOLDEN);
    } catch {
      throw new Error(
        `Golden file missing: ${HELP_GOLDEN}\n` +
          `Regenerate with: ARCHKEEP_UPDATE_GOLDENS=1 npx vitest run src/corpus/golden-output.integration.test.mjs`,
      );
    }

    expect(result.status).toBe(0);
    byteIdentityComparator(result.stdout, golden);
  });

  for (const verb of COMMAND_NAMES) {
    it(`${verb} --help prints the same usage bytes and exits 0`, () => {
      const result = run([verb, "--help"]);

      if (UPDATING) {
        return; // the entry row above owns the golden
      }

      expect(result.status).toBe(0);
      byteIdentityComparator(result.stdout, readFileSync(HELP_GOLDEN));
    });
  }

  it("a bare invocation prints the usage error to stderr and exits 2", () => {
    const result = run([]);

    if (UPDATING) {
      writeFileSync(USAGE_ERROR_GOLDEN, result.stderr);
      return;
    }

    let golden;
    try {
      golden = readFileSync(USAGE_ERROR_GOLDEN);
    } catch {
      throw new Error(
        `Golden file missing: ${USAGE_ERROR_GOLDEN}\n` +
          `Regenerate with: ARCHKEEP_UPDATE_GOLDENS=1 npx vitest run src/corpus/golden-output.integration.test.mjs`,
      );
    }

    expect(result.status).toBe(2);
    expect(result.stdout.length).toBe(0);
    byteIdentityComparator(result.stderr, golden);
  });
});

// ---------------------------------------------------------------------------
// GAP-B — byte-identity across repeated cold starts
// ---------------------------------------------------------------------------
// Every verb (except debt, which has non-deterministic sampleTime) is run 4
// times.  All 4 stdouts must be byte-identical — proving that the output is
// deterministic across invocations.

describe("GAP-B — byte-identity across 4 cold starts", () => {
  for (const verb of VERB_PLAN) {
    if (verb.comparator === "debt") continue; // sampleTime non-deterministic

    for (const fmt of verb.formats) {
      it(`${verb.name} ${fmt} — all 4 runs produce identical output`, () => {
        const argv = resolve(verb.argv.map((p) => p.replace("{format}", fmt)));
        const results = Array.from({ length: 4 }, () => run(argv));

        // All must exit correctly
        for (const r of results) {
          expect(r.status).toBe(expectedExit(verb.name));
        }

        // All 4 stdouts must be byte-identical
        for (let i = 1; i < results.length; i++) {
          expect(results[i].stdout).toEqual(results[0].stdout);
        }
      });
    }
  }
});

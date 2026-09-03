// The `scenario` CLI wrapper (`cli.mjs`'s `runScenario`): the lane between
// parsed argv and the evaluation. The evaluation itself is
// `scenario-evaluation.mjs`'s own suite; the exit matrix pins the verb's exit
// contract; what nothing pinned is the wrapper's report plumbing — that the
// `--format json` envelope is the command's own envelope, that the default
// format is the text report, that `--output` moves the report off stdout and
// onto the named file, and that every refusal (unreadable file, malformed
// JSON, empty change list) is loud at the exit the wrapper promises — a
// broken scenario file must never look like an answer.
//
// Real-tree fixture, the same arrangement
// `./cross-command-state.integration.test.mjs` argues for: the wrapper
// resolves the workspace, the provider, and provenance for real, and no seam
// can prove that plumbing.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EXIT, runCli } from "../../cli.mjs";
import { environmentForTree } from "../workspace.mjs";
import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../../spawn-budget.mjs";

vi.setConfig({ testTimeout: SPAWN_TEST_BUDGET_MS });

/**
 * Runs git in `cwd` through the same environment guard production uses, with
 * the single-spawn budget on every child (the same arrangement
 * `./cross-command-state.integration.test.mjs` states in full).
 */
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    env: environmentForTree(),
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
  });

/** Identity flags keeping every fixture commit independent of the machine. */
const GIT_IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

const ONE_ROW = '  { sourceTag: "layer:a", onlyDependOnLibsWithTags: ["layer:b"] },';
/** The eight options a valid boundary law must carry, per `policyFrom`. */
const OPTIONS = `export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;
const law = (rows) => `export const depConstraints = [\n${rows}\n];\n${OPTIONS}`;

const MODEL = () =>
  JSON.stringify(
    {
      projects: {
        declared: [
          { root: "libs/alpha", name: "alpha", tags: ["layer:a"] },
          { root: "libs/beta", name: "beta", tags: ["layer:b"] },
        ],
      },
      coverage: {
        exempt: [{ path: "module-boundaries.config.mjs", reason: "the workspace's own law" }],
      },
    },
    null,
    2,
  );

const ALPHA = `package alpha

func Name() string { return "alpha" }
`;
const BETA = `package beta

func Suffix() string { return "-beta" }
`;

/** The one scenario every ok lane drives: an edge that does not exist yet. */
const SCENARIO_JSON = `${JSON.stringify({
  changes: [{ type: "dependency_added", source: "beta", target: "alpha", edgeType: "static" }],
})}\n`;

let root;

/** Drives the CLI in-process over the fixture, capturing streams. */
const arch = async (argv) => {
  const out = [];
  const err = [];
  const exitCode = await runCli(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: root,
  });
  return { exitCode, out: out.join("\n"), err: err.join("\n") };
};

/** `arch` + JSON parse of the envelope on stdout. */
const archJson = async (argv) => {
  const run = await arch(argv);
  return { ...run, envelope: JSON.parse(run.out) };
};

/** The argv naming the fixture's scenario file under `root`. */
const scenarioArgv = (...extra) => [
  "scenario",
  "beta",
  "--scenario-file",
  join(root, "scenario.json"),
  ...extra,
];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "archkeep-scenario-cli-"));
  git(root, "init", "-q", "-b", "main");

  const write = (relativePath, text) => {
    mkdirSync(join(root, relativePath, ".."), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  };
  write("archkeep.json", `${MODEL()}\n`);
  write("module-boundaries.config.mjs", law(ONE_ROW));
  write("libs/alpha/go.mod", "module example.com/alpha\n\ngo 1.22\n");
  write("libs/alpha/alpha.go", ALPHA);
  write("libs/beta/go.mod", "module example.com/beta\n\ngo 1.22\n");
  write("libs/beta/beta.go", BETA);
  write("scenario.json", SCENARIO_JSON);
  git(root, ...GIT_IDENTITY, "add", "-A");
  git(root, ...GIT_IDENTITY, "commit", "-q", "-m", "introduce the two-project architecture");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("the scenario CLI wrapper", () => {
  it("--format json prints the command's own envelope, exit 0", async () => {
    const run = await archJson(scenarioArgv("--format", "json"));
    expect(run.exitCode).toBe(EXIT.ok);
    // The wrapper does not re-shape the command's result: the envelope is
    // what `scenarioCommand` built, virtual and not authoritative.
    expect(run.envelope.command).toBe("scenario");
    expect(run.envelope.result.project).toBe("beta");
    expect(run.envelope.result.virtual).toBe(true);
    expect(run.envelope.result.notAuthoritative).toBe(true);
    expect(run.envelope.result.current).not.toBeFalsy();
    expect(run.envelope.result.scenario).not.toBeFalsy();
    expect(run.envelope.result.governanceImpact).not.toBeFalsy();
  });

  it("the default format is the text report, not the envelope", async () => {
    const run = await arch(scenarioArgv());
    expect(run.exitCode).toBe(EXIT.ok);
    expect(run.out).toContain('Scenario evaluation for "beta"');
  });

  it("--output moves the report to the file and leaves stdout empty", async () => {
    const outPath = join(root, "..", "scenario-cli-out.json");
    try {
      const run = await arch(scenarioArgv("--format", "json", "--output", outPath));
      expect(run.exitCode).toBe(EXIT.ok);
      expect(run.out).toBe("");
      expect(run.err).toContain("complete →");
      const envelope = JSON.parse(readFileSync(outPath, "utf8"));
      expect(envelope.result.project).toBe("beta");
    } finally {
      rmSync(outPath, { force: true });
    }
  });

  it("an unreadable scenario file exits 2 and says so", async () => {
    const run = await arch([
      "scenario",
      "beta",
      "--scenario-file",
      join(root, "no-such-scenario.json"),
    ]);
    expect(run.exitCode).toBe(EXIT.usage);
    expect(run.err).toContain("cannot read scenario file");
  });

  it("a malformed scenario file is a loud 3, never a fabricated answer", async () => {
    const broken = join(root, "scenario-broken.json");
    writeFileSync(broken, "{ not json", "utf8");
    try {
      const run = await arch(["scenario", "beta", "--scenario-file", broken]);
      expect(run.exitCode).toBe(EXIT.error);
      expect(run.err).toContain("invalid JSON");
    } finally {
      rmSync(broken, { force: true });
    }
  });

  it("an empty change list is a loud 3, never a zero-change answer", async () => {
    const empty = join(root, "scenario-empty.json");
    writeFileSync(empty, `${JSON.stringify({ changes: [] })}\n`, "utf8");
    try {
      const run = await arch(["scenario", "beta", "--scenario-file", empty]);
      expect(run.exitCode).toBe(EXIT.error);
      expect(run.err).toContain("at least one change");
    } finally {
      rmSync(empty, { force: true });
    }
  });
});

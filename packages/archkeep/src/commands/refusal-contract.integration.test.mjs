import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { parseChangeIntent } from "./change-intent.mjs";
import { parseEvidenceSnapshot, serializeEvidenceSnapshot } from "./delta-snapshot.mjs";
import { captureDelta, refuseUnjudgeableHead } from "./delta.mjs";
import { changeCommand } from "./change.mjs";
import { debtCommand } from "./debt.mjs";
import { deltaCommand } from "./delta.mjs";
import { diffCommand } from "./diff.mjs";
import { driftCommand } from "./drift.mjs";
import { fitnessCommand } from "./fitness.mjs";
import { impactCommand } from "./impact.mjs";
import { reconcileCommand } from "./reconcile.mjs";
import { scenarioCommand } from "./scenario.mjs";
import { waiversCommand } from "./waivers.mjs";
import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../../spawn-budget.mjs";
import { UsageError } from "../errors.mjs";

// One refusal contract for incomplete analysis coverage (#608).
//
// #602 gave the graph family (`check`/`graph`/`discover`/`explain`/`context`)
// the structured refusal: `status: "no-verdict"`, exit 3, a `coverage` block
// naming what it could not read. The commands here refused the SAME condition
// by throwing — a stderr sentence, an empty stdout, no envelope, nothing under
// `--output`. Same refusal class, two machine contracts.
//
// What every refusal test below pins, for every command that used to throw:
//
// - the command RETURNS — it does not throw — with `status: "no-verdict"`;
// - the envelope (parsed from the command's own `report.json` bytes, so the
//   real `jsonEnvelope` invariants hold) carries `exitCode: 3`,
//   `coverage.complete: false`, and the failing rows with their values:
//   whole-file failures in `coverage.notAnalyzed`, unresolved sites in
//   `coverage.blindSpots`;
// - the text face carries a coverage line, so a terminal reader is told the
//   same thing the envelope tells a parser;
// - several commands are also driven over the SAME graph with a clean
//   analysis and must still return `status: "ok"` — the silent direction in
//   reverse: a contract that made everything `no-verdict` would pass every
//   assertion above except this one.
//
// The plugin-gap refusal and the capture-mode refusals stay throws; the split
// is pinned in the `delta` describe below and in each command's own suite.

vi.mock("./provenance.mjs", () => ({ resolveProvenance: vi.fn(() => null) }));

/** The two analysis-failure classes the refusal exists for. */
const WHOLE_FILE = { sourceFile: "libs/widget/src/lib.rs", reason: "unreadable file", line: null };
const UNRESOLVED_SITE = {
  sourceFile: "libs/widget/src/loader.js",
  reason: 'import "./ghost.mjs" names no project this workspace declares',
  line: 3,
  column: 20,
};
const SITE_ROW = {
  file: UNRESOLVED_SITE.sourceFile,
  line: UNRESOLVED_SITE.line,
  column: UNRESOLVED_SITE.column,
  reason: UNRESOLVED_SITE.reason,
};

/** A CommandContext shaped like `resolveCommandContext` produces. */
function commandContext(overrides = {}) {
  return {
    root: mkdtempSync(join(tmpdir(), "archkeep-refusal-contract-")),
    provider: "native",
    marker: "archkeep.json",
    tracked: ["archkeep.json"],
    graph: {
      nodes: {
        widget: {
          name: "widget",
          type: "lib",
          data: { root: "libs/widget", tags: ["layer:domain"] },
        },
        other: { name: "other", type: "lib", data: { root: "libs/other", tags: ["layer:domain"] } },
      },
      dependencies: {
        widget: [{ source: "widget", target: "other", type: "static" }],
        other: [],
      },
    },
    analysis: {
      analyzed: 2,
      analyzedFiles: [],
      exemptedFiles: [],
      imports: [{ sourceFile: "libs/widget/src/lib.rs", specifier: "other", line: 1, column: 1 }],
      failures: [],
    },
    owned: [],
    pluginGap: { registered: true, manifests: [] },
    options: {},
    unownedGap: { files: [] },
    unclaimedGap: { files: [] },
    ...overrides,
  };
}

/** The context whose analysis could not fully read the tree. */
const incompleteContext = (overrides = {}) =>
  commandContext({
    analysis: {
      analyzed: 2,
      analyzedFiles: [],
      exemptedFiles: [],
      imports: [],
      failures: [{ ...WHOLE_FILE }, { ...UNRESOLVED_SITE }],
    },
    ...overrides,
  });

/** The minimal law object the commands that take a config accept. */
const LAW = {
  depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
  options: {
    allow: [],
    buildTargets: ["build"],
    enforceBuildableLibDependency: false,
    allowCircularSelfDependency: false,
    checkDynamicDependenciesExceptions: [],
    ignoredCircularDependencies: [],
    banTransitiveDependencies: false,
    checkNestedExternalImports: false,
  },
  suppressions: [],
};

const INTENT = { version: "1", boundaries: [], allowed: [], forbidden: [], forbiddenTags: [] };
const withIntent = (io = {}) => ({ ...io, loadIntentOverride: async () => INTENT });

/** Parses the envelope out of a command result, through the bytes it built. */
const envelopeOf = (result) => JSON.parse(result.report.json);

/**
 * The assertions every refusal shares, once, so no command gets a weaker
 * copy: status, exit code, completeness, both failure rows BY VALUE, and the
 * text face telling the terminal reader what the envelope tells the parser.
 */
function expectRefusal(result, label) {
  expect(result.status, label).toBe("no-verdict");
  const envelope = envelopeOf(result);
  expect(envelope.status, label).toBe("no-verdict");
  expect(envelope.exitCode, label).toBe(3);
  expect(envelope.coverage.complete, label).toBe(false);
  expect(envelope.coverage.notAnalyzed, label).toContainEqual({
    file: WHOLE_FILE.sourceFile,
    reason: WHOLE_FILE.reason,
  });
  expect(envelope.coverage.blindSpots, label).toContainEqual(SITE_ROW);
  expect(result.report.text, label).toContain("coverage incomplete");
  return envelope;
}

describe("drift", () => {
  it("returns the no-verdict envelope instead of throwing over incomplete coverage", async () => {
    expectRefusal(await driftCommand(incompleteContext(), withIntent()), "drift");
  });

  it("still reports ok over the same graph when the analysis is clean", async () => {
    const result = await driftCommand(commandContext(), withIntent());
    expect(result.status).toBe("ok");
    expect(envelopeOf(result).exitCode).toBe(0);
  });
});

describe("reconcile", () => {
  it("returns the no-verdict envelope instead of throwing over incomplete coverage", async () => {
    expectRefusal(await reconcileCommand(incompleteContext(), withIntent()), "reconcile");
  });

  it("still reports ok over the same graph when the analysis is clean", async () => {
    expect((await reconcileCommand(commandContext(), withIntent())).status).toBe("ok");
  });
});

describe("waivers", () => {
  it("returns the no-verdict envelope instead of throwing over incomplete coverage", async () => {
    expectRefusal(await waiversCommand(incompleteContext(), LAW), "waivers");
  });

  it("still reports ok over the same graph when the analysis is clean", async () => {
    expect((await waiversCommand(commandContext(), LAW)).status).toBe("ok");
  });
});

describe("impact", () => {
  it("returns the no-verdict envelope instead of throwing over incomplete coverage", () => {
    expectRefusal(impactCommand("widget", incompleteContext(), LAW), "impact");
  });

  it("still reports ok over the same graph when the analysis is clean", () => {
    expect(impactCommand("widget", commandContext(), LAW).status).toBe("ok");
  });
});

describe("scenario", () => {
  const scenarioJson = JSON.stringify({ changes: [] });

  it("returns the no-verdict envelope instead of throwing over incomplete coverage", () => {
    expectRefusal(scenarioCommand("widget", scenarioJson, incompleteContext(), LAW), "scenario");
  });

  it("still reports ok over the same graph when the analysis is clean", () => {
    expect(scenarioCommand("widget", scenarioJson, commandContext(), LAW).status).toBe("ok");
  });

  it("its text face carries a coverage line (#609)", () => {
    const result = scenarioCommand("widget", scenarioJson, commandContext(), LAW);
    expect(result.report.text).toMatch(/coverage/i);
  });
});

describe("fitness", () => {
  const law = { ...LAW, fitness: [{ name: "always-applies", condition: { type: "always" } }] };

  it("returns the no-verdict envelope instead of throwing over incomplete coverage", async () => {
    expectRefusal(await fitnessCommand(incompleteContext(), { config: law }), "fitness");
  });
});

describe("debt", () => {
  it("returns the no-verdict envelope instead of throwing over incomplete coverage", async () => {
    // The coverage refusal precedes the snapshot-directory read, so the
    // refusal is observable without a history directory at all.
    expectRefusal(await debtCommand("/no-such-history", incompleteContext(), {}), "debt");
  });
});

describe("diff", () => {
  const baseline = {
    projects: [{ name: "other", root: "libs/other", tags: ["layer:domain"] }],
    dependencies: [],
    coverage: { complete: true, notAnalyzed: [], blindSpots: [] },
    policy: null,
    provider: "native",
    provenance: { commit: "a".repeat(40), remote: null, dirty: false },
    toolVersion: "0.0.0-test",
  };
  const readBaseline = () => baseline;

  it("returns the no-verdict envelope instead of throwing when the head is incomplete", () => {
    expectRefusal(diffCommand("/baseline.json", incompleteContext(), { readBaseline }), "diff");
  });

  it("names the baseline's provenance commit beside the diff (#609)", () => {
    const result = diffCommand("/baseline.json", commandContext(), { readBaseline });
    expect(result.status).toBe("ok");
    expect(result.diff.baseline.provenance).toEqual({
      commit: "a".repeat(40),
      remote: null,
      dirty: false,
    });
  });
});

describe("delta", () => {
  it("refuseUnjudgeableHead keeps refusing exactly the plugin gap", () => {
    const gap = commandContext({
      provider: "nx",
      pluginGap: { registered: false, manifests: ["libs/widget/go.mod"] },
    });
    expect(() => refuseUnjudgeableHead(gap, "compute a delta")).toThrow(/plugin is not/);
    expect(() => refuseUnjudgeableHead(commandContext(), "compute a delta")).not.toThrow();
  });
});

describe("change and delta compare over a real captured baseline", () => {
  let root;

  // An identity that does not read the machine's, and no signing — the same
  // arrangement `change.test.mjs` uses for its load-bearing base commit.
  const git = (...args) => {
    const run = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: SPAWN_BUDGET_MS,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
    if (run.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed (status ${run.status}): ` +
          `${run.stderr ?? ""}${run.stdout ?? ""}`,
      );
    }
    return run.stdout;
  };

  const commit = () => {
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "step");
    return git("rev-parse", "HEAD").trim();
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "archkeep-refusal-change-"));
    git("init", "-q", "-b", "main");
    writeFileSync(join(root, "README.md"), "fixture\n");
    commit();
  }, SPAWN_TEST_BUDGET_MS);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** The base snapshot, captured through the command's own capture path. */
  function baselineOf() {
    const base = commandContext({
      root,
      graph: {
        nodes: {
          widget: commandContext().graph.nodes.widget,
        },
        dependencies: { widget: [] },
      },
    });
    const { snapshot } = captureDelta(base, { config: LAW });
    return parseEvidenceSnapshot(serializeEvidenceSnapshot(snapshot), "/baseline.json");
  }

  /** The manifest pinning the fixture's actual base commit. */
  function manifest(commitSha) {
    return parseChangeIntent(
      JSON.stringify({
        version: "1",
        base: { commit: commitSha },
        projects: { add: ["other"], remove: [] },
        edges: { add: [{ from: "widget", to: "other" }], remove: [] },
        constraints: {},
      }),
      "intent.json",
    );
  }

  it("change returns the no-verdict envelope instead of throwing when the head is incomplete", async () => {
    const head = commit();
    const result = await changeCommand(
      "/baseline.json",
      "intent.json",
      incompleteContext({ root }),
      {
        config: LAW,
        readBaseline: () => baselineOf(),
        readIntent: async () => manifest(head),
      },
    );
    expectRefusal(result, "change");
  });

  it("change maps real blind-spot rows instead of an empty list (#609)", async () => {
    const head = commit();
    const dynamicOnly = commandContext({
      root,
      analysis: {
        analyzed: 2,
        analyzedFiles: [],
        exemptedFiles: [],
        imports: [],
        failures: [{ ...UNRESOLVED_SITE, dynamic: true }],
      },
    });
    const result = await changeCommand("/baseline.json", "intent.json", dynamicOnly, {
      config: LAW,
      readBaseline: () => baselineOf(),
      readIntent: async () => manifest(head),
    });
    expect(result.coverage.blindSpots).toEqual([{ ...SITE_ROW, dynamic: true }]);
  });

  it("delta compare returns the no-verdict envelope instead of throwing when the head is incomplete", async () => {
    const result = await deltaCommand("/baseline.json", incompleteContext({ root }), {
      config: LAW,
      readBaseline: () => baselineOf(),
      now: 0,
    });
    expectRefusal(result, "delta");
  });
});

describe("usage errors are not refusals", () => {
  it("a project missing from the graph stays a UsageError", () => {
    expect(() => impactCommand("nope", commandContext(), LAW)).toThrow(UsageError);
  });
});

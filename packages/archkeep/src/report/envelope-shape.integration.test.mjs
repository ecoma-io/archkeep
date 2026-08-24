// The JSON envelope's field roster, held for every command the CLI declares.
//
// `../../../../docs/reference/json-output.md` promises that every field name
// in the envelope, and `schemaVersion` itself, are a public contract: nothing
// is renamed, nothing changes type, and a new capability arrives as a new
// field rather than as a change to an existing one. Until this file existed
// that promise had no gate — `./json.mjs` refuses a `status`/`exitCode`/
// `coverage`/`decision` combination that contradicts itself, and nothing at
// all noticed a field being renamed or dropped. A promise a consumer builds
// on and nothing measures is exactly the shape of claim `../../AGENTS.md`
// treats as the dangerous direction.
//
// So: every command runs over one fixture tree, its envelope is reduced to a
// sorted `path: type` roster (`./envelope-shape.mjs`), and the roster is
// compared against `./envelope-shape.json` in both directions. A field that
// left the envelope fails; a field that arrived fails too, until someone
// regenerates the snapshot — which is how "additive" stays a claim a human
// made rather than a diff nobody read.
//
//   ARCHKEEP_UPDATE_ENVELOPE_SHAPE=1 npx vitest run src/report/envelope-shape.integration.test.mjs
//
// then read the diff: every removed row is a broken promise, and every added
// row is a new field that `docs/reference/json-output.md` has to describe in
// the same change.
//
// ## Why the command list is imported rather than written here
//
// `COMMAND_NAMES` comes from `../../cli.mjs`, where the command table lives.
// A hand-kept list here would agree with that table until the next command
// lands, and then the new command's envelope would be the one shape nothing
// held — the same argument `scripts/check-packages.mjs` makes for parsing
// `ci.yml` instead of carrying a copy of its targets.
//
// ## Why in-process rather than through the packed artifact
//
// `runCli` takes its whole outside world as an argument — two streams, a
// working directory, and the Nx and git seams — so eighteen commands cost
// eighteen function calls instead of eighteen installs
// (`../cli.integration.test.mjs` establishes the harness). What this cannot
// see is the bin shim, and nothing here needs to: the shape under contract is
// built by `./json.mjs`, which the E2E suite already proves is what reaches a
// consumer's stdout byte for byte.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { COMMAND_NAMES, runCli } from "../../cli.mjs";
import { compareFieldPaths, envelopeFieldPaths } from "./envelope-shape.mjs";
import { ADR_DIR } from "../governance/adr-registry.mjs";
import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../../spawn-budget.mjs";

const SNAPSHOT = fileURLToPath(new URL("./envelope-shape.json", import.meta.url));
const UPDATING = process.env.ARCHKEEP_UPDATE_ENVELOPE_SHAPE === "1";

/** The law: two constraint rows, a live waiver, and one declared fitness function. */
const BOUNDARY_CONFIG = `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:adapter", "layer:domain"] },
];

export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

export const boundarySuppressions = [
  {
    path: "libs/legacy/**",
    reason: "the legacy adapter is being retired",
    expiresAt: "EXPIRES_AT",
  },
];

export const fitness = [
  {
    name: "cycle-free",
    match: ["*"],
    condition: { type: "cycle-free" },
    reason: "a cycle makes every layer statement unfalsifiable",
  },
];
`;

/** The declared architecture, matching the observed graph. */
const INTENT = {
  version: "1",
  boundaries: [
    { name: "domain", match: ["name:domain"] },
    { name: "adapter", match: ["name:adapter"] },
  ],
  allowed: [{ from: "adapter", to: "domain" }],
  forbidden: [{ from: "domain", to: "adapter", reason: "the domain declares no adapters" }],
};

/** A recorded decision, so `adr` reads a registry rather than an empty directory. */
const ADR = `---
id: 0001-layers
status: accepted
bindings:
  - intentForbiddenEdge
---
# Layers

The domain never reaches an adapter.
`;

/**
 * The graph the run judges — injected rather than computed, because what is
 * under contract here is the envelope's shape and not Nx's ability to draw a
 * Go edge (`../graph/` and the E2E suite own that).
 */
const graph = {
  nodes: {
    domain: { name: "domain", type: "lib", data: { root: "libs/domain", tags: ["layer:domain"] } },
    adapter: {
      name: "adapter",
      type: "lib",
      data: { root: "libs/adapter", tags: ["layer:adapter"] },
    },
  },
  dependencies: { domain: [], adapter: [] },
};

const files = [
  "nx.json",
  "module-boundaries.config.mjs",
  "architecture-intent.json",
  `${ADR_DIR}/0001-layers.md`,
  "libs/domain/go.mod",
  "libs/domain/doc.go",
  "libs/adapter/go.mod",
  "libs/adapter/adapter.go",
];

let root;
let historyDir;
let baseline;
let deltaBaseline;

/** A git command in the fixture, with an identity that does not read the machine's. */
const git = (...args) =>
  spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    // One spawned child gets the shared single-spawn budget; without any
    // bound, a wedged spawn blocks this thread indefinitely — a state no
    // vitest timeout can interrupt. `../../spawn-budget.mjs` owns the pair. cf. #41
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      HOME: process.env.HOME,
    },
  }).status;

// The fixture build spawns git three times and runs two full commands; the
// hook-timeout argument (vitest's separate 10 s hook default) is the derived
// spawn-test ceiling, not a fresh literal — `../../spawn-budget.mjs` owns it.
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "archkeep-envelope-shape-"));
  historyDir = mkdtempSync(join(tmpdir(), "archkeep-envelope-shape-history-"));
  const write = (relativePath, text) => {
    mkdirSync(join(root, relativePath, ".."), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  };

  write(
    "nx.json",
    `${JSON.stringify(
      {
        plugins: [
          {
            plugin: "@ecoma-io/archkeep/nx",
            options: {
              boundaryConfig: "module-boundaries.config.mjs",
              tsConfig: "tsconfig.base.json",
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  write(
    "module-boundaries.config.mjs",
    // A year out rather than a fixed date: a fixed expiry would silently turn
    // the live waiver into an expired one and stop exercising the rows this
    // roster is here to hold.
    BOUNDARY_CONFIG.replace(
      "EXPIRES_AT",
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    ),
  );
  write("architecture-intent.json", `${JSON.stringify(INTENT, null, 2)}\n`);
  write(`${ADR_DIR}/0001-layers.md`, ADR);
  write("libs/domain/go.mod", "module example.com/domain\n\ngo 1.22\n");
  // The one crossing import: the domain reaching an adapter, so `check` has a
  // violation to render and every violation-shaped field appears in the
  // roster. A clean tree would record `result.violations: array` and nothing
  // under it — a roster with no rows for the fields the tool exists to emit.
  write(
    "libs/domain/doc.go",
    'package domain\n\nimport (\n\t"example.com/adapter"\n)\n\nvar _ = adapter.Name\n',
  );
  write("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.22\n");
  write("libs/adapter/adapter.go", 'package adapter\n\nconst Name = "adapter"\n');

  expect(git("init", "-q", "-b", "main")).toBe(0);
  expect(git("add", "-A")).toBe(0);
  expect(git("commit", "-q", "-m", "fixture")).toBe(0);

  // `diff` needs a baseline and `history`/`debt` need a captured snapshot;
  // both are produced by the commands that own them rather than hand-written,
  // so the roster is measured against files this tool really writes.
  const snapshot = await envelopeFor(["graph", "--format", "json"]);
  baseline = join(historyDir, "baseline.json");
  writeFileSync(baseline, `${JSON.stringify(snapshot.envelope, null, 2)}\n`);
  const captured = await run(["history", historyDir, "--capture"]);
  expect(captured.exitCode).toBe(0);

  // `delta` needs an evidence baseline of its own — a different format from
  // `diff`'s graph envelope (`../commands/delta-snapshot.mjs`) — captured by
  // the command that owns it, so the roster measures a file this tool really
  // writes. Captured to stdout and written here, the same arrangement the
  // graph baseline above uses. NOT into `historyDir`: `history` reads every
  // file there as one of its own graph snapshots, and an evidence snapshot
  // is a different format it rightly refuses.
  const deltaCapture = await run(["delta", "--capture"]);
  expect(deltaCapture.exitCode).toBe(0);
  deltaBaseline = join(root, "delta-baseline.json");
  writeFileSync(deltaBaseline, `${deltaCapture.out}\n`);
}, SPAWN_TEST_BUDGET_MS);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (historyDir) rmSync(historyDir, { recursive: true, force: true });
});

/**
 * Runs one command in-process, capturing both streams.
 *
 * @param {string[]} argv
 * @returns {Promise<{exitCode: number, out: string, err: string}>}
 */
async function run(argv) {
  const out = [];
  const err = [];
  const exitCode = await runCli(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: root,
    readGraph: () => graph,
    listFiles: () => files,
  });
  return { exitCode, out: out.join("\n"), err: err.join("\n") };
}

/**
 * The envelope one command produced, refusing anything that is not one.
 *
 * A command that wrote no parseable JSON is a fixture problem rather than a
 * roster finding, and it has to say so with the stderr it printed — a roster
 * silently missing a command would leave that command's shape unheld, which
 * is the failure this whole file exists to prevent.
 *
 * @param {string[]} argv
 * @returns {Promise<{exitCode: number, envelope: object}>}
 */
async function envelopeFor(argv) {
  const result = await run(argv);
  let envelope;
  try {
    envelope = JSON.parse(result.out);
  } catch {
    throw new Error(
      `archkeep: '${argv.join(" ")}' wrote no JSON envelope (exit ${result.exitCode}). ` +
        `stdout: ${result.out.slice(0, 400)} stderr: ${result.err.slice(0, 400)}`,
    );
  }
  return { exitCode: result.exitCode, envelope };
}

/**
 * The argv each command is driven by. Every command in `COMMAND_NAMES` needs
 * a row, and the test below fails when one is missing — a command whose
 * envelope nothing measures is exactly what this file refuses to allow.
 *
 * @returns {Record<string, string[]>}
 */
function argvForEveryCommand() {
  return {
    check: ["check", "--format", "json"],
    graph: ["graph", "--format", "json"],
    diff: ["diff", baseline, "--format", "json"],
    delta: ["delta", deltaBaseline, "--format", "json"],
    discover: ["discover", "--format", "json"],
    drift: ["drift", "--format", "json"],
    reconcile: ["reconcile", "--format", "json"],
    waivers: ["waivers", "--format", "json"],
    fitness: ["fitness", "--format", "json"],
    history: ["history", historyDir, "--format", "json"],
    health: ["health", historyDir, "--format", "json"],
    report: ["report", historyDir, "--format", "json"],
    debt: ["debt", historyDir, "--format", "json"],
    impact: ["impact", "domain", "--format", "json"],
    explain: ["explain", "libs/domain/doc.go:4:2", "--format", "json"],
    context: ["context", "domain", "--format", "json"],
    provenance: ["provenance", "--format", "json"],
    adr: ["adr", "--format", "json"],
  };
}

describe("the JSON envelope's field roster", () => {
  it("covers every command the CLI declares", () => {
    // The completeness half. Without it a command added later simply would
    // not be measured, and the roster would keep passing by holding less.
    expect(Object.keys(argvForEveryCommand()).sort()).toEqual([...COMMAND_NAMES].sort());
  });

  it("holds every command's shape against the recorded snapshot", async () => {
    const recorded = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
    /** @type {Record<string, string[]>} */
    const observed = {};
    for (const [command, argv] of Object.entries(argvForEveryCommand())) {
      const { envelope } = await envelopeFor(argv);
      observed[command] = envelopeFieldPaths(envelope);
    }

    if (UPDATING) {
      writeFileSync(SNAPSHOT, `${JSON.stringify(observed, null, 2)}\n`);
    }

    const snapshot = UPDATING ? observed : recorded;
    expect(Object.keys(snapshot).sort()).toEqual(Object.keys(observed).sort());
    for (const [command, paths] of Object.entries(observed)) {
      const { added, removed } = compareFieldPaths(snapshot[command] ?? [], paths);
      // Asserted as one object per command so a failure names the command and
      // both directions at once: `removed` is the broken promise, `added` is
      // the field `docs/reference/json-output.md` now has to describe.
      expect({ command, added, removed }).toEqual({ command, added: [], removed: [] });
    }
  });

  it("pins schemaVersion, so a bump is a decision rather than a drift", async () => {
    // The version is the one field a consumer branches on before reading
    // anything else, and the promise says it moves only for a break. A test
    // that merely read it back from the envelope would pin nothing.
    for (const argv of Object.values(argvForEveryCommand())) {
      const { envelope } = await envelopeFor(argv);
      expect({ argv: argv[0], schemaVersion: envelope.schemaVersion }).toEqual({
        argv: argv[0],
        schemaVersion: 2,
      });
    }
  });
});

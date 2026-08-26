// Integration: `trajectory` driven through the real CLI surface over REAL
// snapshot bytes on disk.
//
// The unit suite (`./trajectory.test.mjs`) pins every aggregate semantic over
// injected history objects; what it cannot see is the path a consumer's
// fingers touch — `parseBaseline` validating files this command did not write,
// `readSnapshots` ordering a real directory, the exit codes the CLI maps the
// refusals to, and byte-identical stdout across two runs of an unchanged
// directory. Those are pinned here, over a tmpdir whose snapshots are
// hand-written graph envelopes — the same contract `--capture` writes and
// `parseBaseline` refuses to bend.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "../../cli.mjs";
import { SCHEMA_VERSION } from "../report/json.mjs";

let root;
let histDir;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "archkeep-trajectory-"));
  histDir = join(root, ".archkeep", "history");
  mkdirSync(histDir, { recursive: true });
  // A minimal Nx-workspace marker: `resolveCommandContext` needs a root marker,
  // and the injected graph/file seams below stand in for everything else.
  writeFileSync(
    join(root, "nx.json"),
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
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/**
 * One valid graph snapshot as bytes — the shape `parseBaseline` accepts:
 * schemaVersion 2, `command: "graph"`, complete coverage, project and edge
 * records carrying every required string field.
 *
 * @param {{name: string, root?: string}[]} projects
 * @param {{source: string, target: string, type?: string}[]} dependencies
 * @param {string} [policy] The policy fingerprint, when the observation
 *   recorded one.
 */
function snapshotBytes(projects, dependencies, policy) {
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: "@ecoma-io/archkeep", version: "0.0.0-test" },
    command: "graph",
    workspace: {
      root,
      provider: "native",
      marker: "archkeep.json",
      provenance: null,
    },
    status: "ok",
    exitCode: 0,
    coverage: {
      complete: true,
      projects: projects.length,
      analyzedFiles: projects.length,
      imports: dependencies.length,
      notAnalyzed: [],
      blindSpots: [],
      notes: [],
    },
    result: {
      projects: projects.map((p) => ({
        name: p.name,
        root: p.root ?? `libs/${p.name}`,
        type: "lib",
        tags: [],
      })),
      dependencies: dependencies.map((d) => ({ ...d, type: d.type ?? "static" })),
      ...(policy !== undefined ? { policy: { fingerprint: policy } } : {}),
    },
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/**
 * Writes one snapshot under the `<seq>-<sha8-ish>.json` naming convention the
 * capture side uses, so filename byte-sort is history order here too.
 *
 * @param {number} seq
 * @param {Parameters<snapshotBytes>} args
 */
function writeSnapshot(seq, ...args) {
  writeFileSync(join(histDir, `${String(seq).padStart(4, "0")}-test.json`), snapshotBytes(...args));
}

/** Runs one CLI invocation against the fixture workspace. */
async function run(argv) {
  const out = [];
  const err = [];
  const exitCode = await runCli(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: root,
    readGraph: () => ({ nodes: {}, dependencies: {} }),
    listFiles: () => ["nx.json"],
  });
  return { exitCode, out: out.join("\n"), err: err.join("\n") };
}

describe("trajectory over real snapshot bytes", () => {
  it("aggregates a three-observation history end to end, at exit 0", async () => {
    writeSnapshot(1, [{ name: "a" }], [{ source: "a", target: "b" }]);
    writeSnapshot(2, [{ name: "a" }, { name: "b" }], [{ source: "a", target: "b" }]);
    writeSnapshot(
      3,
      [{ name: "a" }, { name: "b" }],
      [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
      ],
    );

    const { exitCode, out, err } = await run(["trajectory", histDir, "--format", "json"]);
    expect(err).toBe("");
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(out);
    expect(envelope.command).toBe("trajectory");
    expect(envelope.schemaVersion).toBe(SCHEMA_VERSION);
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.result.dir).toBe(histDir);
    expect(envelope.result.observations.count).toBe(3);
    expect(envelope.result.available).toBe(true);
    expect(envelope.result.transitions).toEqual({
      count: 2,
      architecture: 2,
      policy: 0,
      provider: 0,
      codeDrift: 0,
      incomparable: 0,
      unchanged: 0,
    });
    // a→b was written into every observation and survived both transitions:
    // exactly one persistent edge. b→a arrived late: one added event, never
    // persistent, and the endpoint sets make it the one introduced edge.
    expect(envelope.result.edges).toEqual({
      first: 1,
      current: 2,
      delta: 1,
      addedEvents: 1,
      removedEvents: 0,
      changedEvents: null,
      introduced: 1,
      resolved: 0,
      persistent: 1,
    });
    expect(envelope.result.projects).toEqual({
      first: 1,
      current: 2,
      delta: 1,
      addedEvents: 1,
      removedEvents: 0,
      changedEvents: 0,
      introduced: 1,
      resolved: 0,
      persistent: 1,
    });
  });

  it("prints the same terminal facts in text format", async () => {
    const { exitCode, out } = await run(["trajectory", histDir]);
    expect(exitCode).toBe(0);
    expect(out).toContain(`trajectory  ${histDir}`);
    expect(out).toContain("3 observations (graph_snapshots), 2 transitions");
    expect(out).toContain(
      "signals  architecture 2 · policy 0 · provider 0 · code drift 0 · incomparable 0 · unchanged 0",
    );
  });

  it("is byte-identical across two runs of the unchanged directory", async () => {
    const first = await run(["trajectory", histDir, "--format", "json"]);
    const second = await run(["trajectory", histDir, "--format", "json"]);
    expect(first.out).toBe(second.out);
  });

  it("refuses an empty history directory at exit 3, naming the directory", async () => {
    const empty = join(root, ".archkeep", "empty");
    mkdirSync(empty);
    const { exitCode, out, err } = await run(["trajectory", empty]);
    expect(exitCode).toBe(3);
    expect(out).toBe("");
    expect(err).toContain("contains no snapshots");
    expect(err).toContain(empty);
  });

  it("answers a single-snapshot directory with insufficient_history, at exit 0", async () => {
    const single = join(root, ".archkeep", "single");
    mkdirSync(single);
    writeFileSync(join(single, "0001-one.json"), snapshotBytes([{ name: "a" }], []));
    const { exitCode, out } = await run(["trajectory", single, "--format", "json"]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(out);
    expect(envelope.result.available).toBe(false);
    expect(envelope.result.unavailableReason).toBe("insufficient_history");
    expect(envelope.result.transitions.count).toBe(0);
    expect(envelope.result.projects.delta).toBe(null);
    expect(envelope.result.edges.introduced).toBe(null);
  });

  it("stops loudly on a malformed snapshot instead of aggregating around it", async () => {
    const broken = join(root, ".archkeep", "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "0001-ok.json"), snapshotBytes([{ name: "a" }], []));
    writeFileSync(join(broken, "0002-bad.json"), "{not json");
    const { exitCode, err } = await run(["trajectory", broken]);
    expect(exitCode).toBe(3);
    expect(err).toContain("not valid JSON");
  });

  it("treats the wrong positional count and a report written into the history dir as usage errors", async () => {
    const none = await run(["trajectory"]);
    expect(none.exitCode).toBe(2);

    const poisoned = await run(["trajectory", histDir, "--output", join(histDir, "report.json")]);
    expect(poisoned.exitCode).toBe(2);
    expect(poisoned.err).toContain("inside the history directory");
  });
});

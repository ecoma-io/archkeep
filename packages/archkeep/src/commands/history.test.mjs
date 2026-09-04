import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { canonicalizeJson } from "../canonical.mjs";
import {
  computeEvolution,
  historyCommand,
  nextSequence,
  readSnapshots,
  shortId,
  snapshotIdentity,
} from "./history.mjs";
import { compareSnapshotMetadata } from "./snapshot-meta.mjs";
import { SCHEMA_VERSION } from "../report/json.mjs";

// `readSnapshots` reads through node:fs, so its filesystem path is driven
// with a mocked fs — the `.tmp`-filter, byte-sort order, and identity
// computation are pinned without touching disk. `historyCommand`'s own
// capture path uses injected IO seams (same pattern as `diff`'s
// `readBaseline` seam), so it needs no fs at all.
vi.mock("node:fs", () => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  // The default capture writer runs `containmentViolation`
  // (`../containment.mjs`) before staging the `.tmp`, which lstat-walks the
  // history path's ancestors. In a mocked-fs test no path exists, so the walk
  // must ENOENT up to `/` (no realpath) and containment returns null — the
  // write proceeds, which is exactly the default-writer behavior this test
  // pins. The mock must both EXPORT both names (or the import inside
  // `containment.mjs` throws) and THROW, not return `undefined`, or the
  // walk reads a nonexistent path as existing.
  lstatSync: () => {
    throw new Error("ENOENT");
  },
  realpathSync: () => {
    throw new Error("ENOENT");
  },
}));

/** The real overloads would pin these to `Dirent[]`/`PathOrFileDescriptor`;
 * the mocks are loose vitest `Mock`s so a test controls the return freely. */
/** @type {ReturnType<typeof vi.fn>} */
const readdirSync = vi.mocked((await import("node:fs")).readdirSync);
/** @type {ReturnType<typeof vi.fn>} */
const readFileSync = vi.mocked((await import("node:fs")).readFileSync);
/** @type {ReturnType<typeof vi.fn>} */
const writeFileSync = vi.mocked((await import("node:fs")).writeFileSync);
/** @type {ReturnType<typeof vi.fn>} */
const renameSync = vi.mocked((await import("node:fs")).renameSync);

/**
 * A complete graph envelope, malformed nowhere. The default project carries
 * `type`, because a real `graph` snapshot always emits it — a captured head
 * built by `buildProjects` would otherwise never byte-match a stored one.
 *
 * @param {object} [opts]
 * @param {Array<{name: string, root: string, type?: string, tags: string[]}>} [opts.projects]
 * @param {Array<{source: string, target: string, type: string}>} [opts.dependencies]
 * @param {string|null} [opts.provider]
 * @param {string|null} [opts.commit]
 * @param {string} [opts.policy]
 * @param {boolean} [opts.coverage]
 */
function envelope({
  projects = [{ name: "a", root: "libs/a", type: "lib", tags: [] }],
  dependencies = [],
  provider = "native",
  commit = "abc",
  policy,
  coverage = true,
} = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    command: "graph",
    workspace: {
      root: "/ws",
      provider,
      marker: "archkeep.json",
      provenance: commit ? { commit, remote: "https://example.test/repo.git", dirty: false } : null,
    },
    status: "ok",
    exitCode: 0,
    coverage: {
      complete: coverage,
      projects: projects.length,
      analyzedFiles: 2,
      imports: 1,
      notAnalyzed: coverage ? [] : [{ file: "x.go", reason: "parse" }],
      blindSpots: [],
      notes: [],
    },
    result: { projects, dependencies, ...(policy ? { policy: { fingerprint: policy } } : {}) },
  };
}

/**
 * Builds the in-memory "readSnapshots" the command's tests need. Rewrites the
 * envelope to the shape `readSnapshots` actually produces (a parsed graph
 * snapshot carries `projects`/`dependencies`/`coverage`/`provider`/
 * `provenance`/`policy`), so the command logic and the shared
 * `computeEvolution` agree.
 */
function snapshotsFrom(files) {
  const entries = Object.entries(files).map(([name, envelope]) => {
    const result = {
      projects: envelope.result.projects,
      dependencies: envelope.result.dependencies,
      ...(envelope.result.policy ? { policy: envelope.result.policy } : {}),
    };
    return [
      name,
      {
        name,
        path: `/ws/hist/${name}`,
        envelope: {
          coverage: envelope.coverage,
          result,
          workspace: {
            provider: envelope.workspace.provider,
            provenance: envelope.workspace.provenance,
          },
        },
        id: snapshotIdentity(result),
      },
    ];
  });
  return Object.fromEntries(entries);
}

const readSnapshotsFromMap = (map) => () => ({ files: Object.values(map) });

describe("snapshotIdentity", () => {
  it("is stable for identical snapshots and different for a changed edge set", () => {
    const base = { projects: [{ name: "a", root: "libs/a", tags: [] }], dependencies: [] };
    const id1 = snapshotIdentity(base);
    const id2 = snapshotIdentity({
      projects: [{ name: "a", root: "libs/a", tags: [] }],
      dependencies: [],
    });
    const id3 = snapshotIdentity({
      projects: [{ name: "a", root: "libs/a", tags: [] }],
      dependencies: [{ source: "a", target: "b", type: "static" }],
    });
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
  });

  it("is independent of object key insertion order", () => {
    const a = snapshotIdentity({
      projects: [{ name: "a", root: "libs/a", tags: ["x", "y"] }],
      dependencies: [{ source: "a", target: "b", type: "static" }],
    });
    const b = snapshotIdentity({
      dependencies: [{ target: "b", source: "a", type: "static" }],
      // Same object VALUES, same array order — only key insertion differs.
      projects: [{ tags: ["x", "y"], root: "libs/a", name: "a" }],
    });
    expect(a).toBe(b);
  });

  it("treats a different tag array order as a different snapshot", () => {
    const a = snapshotIdentity({
      projects: [{ name: "a", root: "libs/a", tags: ["x", "y"] }],
      dependencies: [],
    });
    const b = snapshotIdentity({
      projects: [{ name: "a", root: "libs/a", tags: ["y", "x"] }],
      dependencies: [],
    });
    expect(a).not.toBe(b);
  });

  it("ignores fields computeDiff does not compare, so identity and diff agree", () => {
    // `buildProjects` emits `targets` (build targets) and a future provider
    // may emit more model fields, but the graph diff only detects tags/type/
    // root. A build-target change must neither move the identity (writing a
    // snapshot that classifies as "unchanged" would be a manufactured
    // transition) nor a future unknown field fabricate an architecture change.
    expect(
      snapshotIdentity({
        projects: [{ name: "a", root: "libs/a", tags: [], targets: ["build"] }],
        dependencies: [],
      }),
    ).toBe(
      snapshotIdentity({ projects: [{ name: "a", root: "libs/a", tags: [] }], dependencies: [] }),
    );
    expect(
      snapshotIdentity({
        projects: [{ name: "a", root: "libs/a", tags: [], someFutureField: 1 }],
        dependencies: [],
      }),
    ).toBe(
      snapshotIdentity({ projects: [{ name: "a", root: "libs/a", tags: [] }], dependencies: [] }),
    );
  });

  it("includes the policy fingerprint so a policy change is an identity change", () => {
    const base = { projects: [{ name: "a", root: "libs/a", tags: [] }], dependencies: [] };
    expect(snapshotIdentity({ ...base, policy: { fingerprint: "p1" } })).not.toBe(
      snapshotIdentity({ ...base, policy: { fingerprint: "p2" } }),
    );
    // A policy the snapshot does not carry and a null policy are the same —
    // "no policy recorded" is a single state, not one indistinguishable from
    // an absent one.
    expect(snapshotIdentity({ ...base, policy: null })).toBe(snapshotIdentity(base));
  });

  it("digests the same bytes the retired inline canonicalizer produced (#613)", () => {
    // `snapshotIdentity` used to inline its own key-sorting `JSON.stringify`
    // beside `../canonical.mjs` — the last private serialization spelling in
    // the package. The DIGEST is the contract: an unchanged workspace must
    // re-derive the same snapshot ids after the consolidation, so the retired
    // spelling lives here as the reference and every shape a real snapshot
    // carries must come out identical through both. A shape where the two
    // diverge is a semantic change to what `history` reports, not a refactor
    // — the assertion is built to go red on that day, not to bless the new
    // bytes.
    const legacyCanonicalize = (value) =>
      JSON.stringify(value, (_, current) =>
        current !== null && typeof current === "object" && !Array.isArray(current)
          ? Object.fromEntries(
              Object.keys(current)
                .sort()
                .map((key) => [key, current[key]]),
            )
          : current,
      );
    const mapProjects = (projects) =>
      projects.map(({ name, root, type, tags }) => ({ name, root, type, tags }));
    /**
     * The retired function, verbatim: projection, canonical string, SHA-256.
     * @param {{projects: SnapshotShape["projects"], dependencies: any[], policy?: {fingerprint: string} | null}} _
     * @returns {string}
     */
    const legacySnapshotIdentity = ({ projects, dependencies, policy }) =>
      createHash("sha256")
        .update(
          legacyCanonicalize({
            projects: mapProjects(projects),
            dependencies,
            policy: policy?.fingerprint ?? null,
          }),
        )
        .digest("hex");

    const project = { name: "alpha", root: "libs/alpha", type: "lib", tags: ["layer:a"] };

    /**
     * A representative snapshot shape: what a real `delta --capture` stores —
     * projected projects, edge records, and the optional policy fingerprint.
     * @typedef {object} SnapshotShape
     * @property {{name: string, root: string, type?: string, tags?: string[]}[]} projects
     * @property {any[]} dependencies
     * @property {{fingerprint: string} | null} [policy]
     */

    /** @type {Array<[string, SnapshotShape]>} */
    const shapes = [
      ["the empty graph", { projects: [], dependencies: [] }],
      ["one project with tags, no edges", { projects: [project], dependencies: [] }],
      [
        "key insertion order reversed on every object",
        {
          dependencies: [{ type: "static", target: "beta", source: "alpha" }],
          projects: [{ tags: ["layer:a"], type: "lib", root: "libs/alpha", name: "alpha" }],
        },
      ],
      [
        "several projects and edge records, as a real graph carries them",
        {
          projects: [project, { name: "beta", root: "libs/beta", type: "lib", tags: [] }],
          dependencies: [
            { source: "alpha", target: "beta", type: "static" },
            { source: "alpha", target: "beta", type: "dynamic" },
          ],
        },
      ],
      [
        "empty projects, empty dependencies, explicit null policy",
        { projects: [], dependencies: [], policy: null },
      ],
      [
        "a policy fingerprint present",
        { projects: [project], dependencies: [], policy: { fingerprint: "fp-1" } },
      ],
      ["a null policy", { projects: [project], dependencies: [], policy: null }],
      ["a policy absent", { projects: [project], dependencies: [] }],
      [
        "a stored edge record with an own '__proto__' key",
        {
          projects: [project],
          dependencies: [
            JSON.parse('{"source":"alpha","target":"beta","type":"static","__proto__":{"x":1}}'),
          ],
        },
      ],
    ];

    for (const [shapeName, shape] of shapes) {
      const value = {
        projects: mapProjects(shape.projects),
        dependencies: shape.dependencies,
        policy: shape.policy?.fingerprint ?? null,
      };
      // The serializers agree byte-for-byte on the canonical STRING …
      expect(canonicalizeJson(value), shapeName).toBe(legacyCanonicalize(value));
      // … and the composed digest equals the digest the retired spelling
      // produced — the identity an unchanged workspace already recorded.
      expect(snapshotIdentity(shape), shapeName).toBe(legacySnapshotIdentity(shape));
    }
  });
});

describe("shortId", () => {
  it("returns the first eight hex characters", () => {
    expect(shortId("abcdef1234567890")).toBe("abcdef12");
  });
});

describe("readSnapshots", () => {
  it("returns the snapshots in filename byte-sort order", () => {
    readdirSync.mockReturnValue(["0002-b.json", "0001-a.json"]);
    const filesByName = {
      "0001-a.json": JSON.stringify(
        envelope({ projects: [{ name: "a", root: "libs/a", tags: [] }] }),
      ),
      "0002-b.json": JSON.stringify(
        envelope({ projects: [{ name: "b", root: "libs/b", tags: [] }] }),
      ),
    };
    readFileSync.mockImplementation((p) => filesByName[p.split("/").pop()]);

    const { files } = readSnapshots("/ws/hist");
    expect(files.map((f) => f.name)).toEqual(["0001-a.json", "0002-b.json"]);
  });

  it("computes each snapshot's identity", () => {
    readdirSync.mockReturnValue(["0001-a.json"]);
    readFileSync.mockReturnValue(JSON.stringify(envelope()));
    const { files } = readSnapshots("/ws/hist");
    expect(files[0].id).toBe(
      snapshotIdentity({
        projects: [{ name: "a", root: "libs/a", type: "lib", tags: [] }],
        dependencies: [],
      }),
    );
  });

  it("ignores .tmp files left by an interrupted capture", () => {
    readdirSync.mockReturnValue(["0001-a.json.tmp", "0001-a.json"]);
    readFileSync.mockReturnValue(JSON.stringify(envelope()));
    const { files } = readSnapshots("/ws/hist");
    expect(files.map((f) => f.name)).toEqual(["0001-a.json"]);
  });

  it("throws a readable error when the directory cannot be read", () => {
    readdirSync.mockImplementation(() => {
      throw new Error("ENOENT: no such directory");
    });
    expect(() => readSnapshots("/ws/missing")).toThrow(/cannot read the history directory/);
  });

  it("throws when a snapshot file cannot be read", () => {
    readdirSync.mockReturnValue(["0001-a.json"]);
    readFileSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    expect(() => readSnapshots("/ws/hist")).toThrow(/cannot read the history snapshot/);
  });

  it("throws when a snapshot is malformed or incomplete", () => {
    readdirSync.mockReturnValue(["0001-a.json"]);
    readFileSync.mockReturnValue(JSON.stringify(envelope({ coverage: false })));
    expect(() => readSnapshots("/ws/hist")).toThrow(/incomplete coverage/);
  });
});

describe("nextSequence", () => {
  it("returns 0001 for a fresh directory", () => {
    expect(nextSequence({ files: [] })).toBe("0001");
  });

  it("returns one past the highest existing sequence", () => {
    const read = snapshotsFrom({
      "0001-a.json": envelope(),
      "0007-b.json": envelope(),
    });
    expect(nextSequence({ files: Object.values(read) })).toBe("0008");
  });

  it("widens the width past nine-thousand nine-hundred and ninety-nine so byte-sort never rewinds history order", () => {
    // A sequence fixed forever at four digits would byte-sort "10000-…"
    // before "9999-…" and rewind the record. The width must grow with the
    // sequence so the next name stays after the last real snapshot.
    const read = snapshotsFrom({ "9999-a.json": envelope() });
    expect(nextSequence({ files: Object.values(read) })).toBe("10000");
  });

  it("keeps the four-digit minimum for a small history", () => {
    const read = snapshotsFrom({ "0001-a.json": envelope() });
    expect(nextSequence({ files: Object.values(read) })).toBe("0002");
  });
});

describe("computeEvolution", () => {
  const filesFor = (specs) =>
    Object.entries(specs).map(([name, envelope]) => {
      const result = {
        projects: envelope.result.projects,
        dependencies: envelope.result.dependencies,
        ...(envelope.result.policy ? { policy: envelope.result.policy } : {}),
      };
      return {
        name,
        path: `/ws/hist/${name}`,
        envelope: {
          coverage: envelope.coverage,
          result,
          workspace: {
            provider: envelope.workspace.provider,
            provenance: envelope.workspace.provenance,
          },
        },
        id: snapshotIdentity(result),
      };
    });

  it("reports an architecture change for a changed edge set", () => {
    const files = filesFor({
      "0001-a.json": envelope({ dependencies: [] }),
      "0002-b.json": envelope({
        dependencies: [{ source: "a", target: "b", type: "static" }],
        projects: [
          { name: "a", root: "libs/a", tags: [] },
          { name: "b", root: "libs/b", tags: [] },
        ],
      }),
    });
    const { transitions } = computeEvolution(files);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].architectureChanged).toBe(true);
    expect(transitions[0].changes.addedEdges).toEqual([
      { source: "a", target: "b", type: "static" },
    ]);
  });

  it("reports a policy change independently of a graph change", () => {
    const files = filesFor({
      "0001-a.json": envelope({ policy: "p1" }),
      "0002-b.json": envelope({ policy: "p2" }),
    });
    const { transitions } = computeEvolution(files);
    expect(transitions[0].architectureChanged).toBe(false);
    expect(transitions[0].policyChanged).toBe(true);
    expect(transitions[0].changes).toBeNull();
    expect(transitions[0].notes[0]).toMatch(/policy \(the declared architectural intent\) changed/);
  });

  it("discloses code drift when provenance advances but architecture and policy do not", () => {
    const files = filesFor({
      "0001-a.json": envelope({ commit: "aaa", policy: "p1" }),
      "0002-b.json": envelope({ commit: "bbb", policy: "p1" }),
    });
    const { transitions } = computeEvolution(files);
    expect(transitions[0].architectureChanged).toBe(false);
    expect(transitions[0].policyChanged).toBe(false);
    expect(transitions[0].codeDrift).toBe(true);
  });

  it("does not report code drift when provenance is missing on both sides", () => {
    const files = filesFor({
      "0001-a.json": envelope({ commit: null, policy: "p1" }),
      "0002-b.json": envelope({ commit: null, policy: "p1" }),
    });
    const { transitions } = computeEvolution(files);
    expect(transitions[0].codeDrift).toBe(false);
  });

  it("does not assert code drift when the policy cannot be compared", () => {
    // A one-sided (or absent) policy is "could not be compared", not "the
    // same" — asserting code drift on an unverifiable policy would report a
    // clean transition where the tool cannot look.
    const files = filesFor({
      "0001-a.json": envelope({ commit: "aaa", policy: "p1" }),
      "0002-b.json": envelope({ commit: "bbb" }),
    });
    const { transitions } = computeEvolution(files);
    expect(transitions[0].policyChanged).toBeNull();
    expect(transitions[0].codeDrift).toBe(false);
  });

  it("discloses a snapshot captured from a dirty tree", () => {
    const files = [
      {
        name: "0001-a.json",
        path: "/ws/hist/0001-a.json",
        envelope: {
          coverage: {},
          result: { projects: [], dependencies: [] },
          workspace: {
            provider: "native",
            provenance: { commit: "aaa", remote: "r", dirty: true },
          },
        },
        id: "x",
      },
      {
        name: "0002-b.json",
        path: "/ws/hist/0002-b.json",
        envelope: {
          coverage: {},
          result: { projects: [], dependencies: [] },
          workspace: {
            provider: "native",
            provenance: { commit: "bbb", remote: "r", dirty: false },
          },
        },
        id: "y",
      },
    ];
    const { transitions } = computeEvolution(files);
    expect(transitions[0].notes.some((n) => /uncommitted \(dirty\) tree/.test(n))).toBe(true);
  });

  it("reports a provider change with a disclosure note", () => {
    const files = filesFor({
      "0001-a.json": envelope({ provider: "native" }),
      "0002-b.json": envelope({ provider: "nx", commit: "bbb", dependencies: [] }),
    });
    const { transitions } = computeEvolution(files);
    expect(transitions[0].providerChanged).toBe(true);
    expect(transitions[0].notes.some((n) => /provider changed/.test(n))).toBe(true);
  });

  it("renders a provider change with an empty diff, not null", () => {
    const files = filesFor({
      "0001-a.json": envelope({ provider: "native", commit: "aaa", dependencies: [] }),
      "0002-b.json": envelope({ provider: "nx", commit: "bbb", dependencies: [] }),
    });
    const { transitions } = computeEvolution(files);
    expect(transitions[0].architectureChanged).toBe(false);
    expect(transitions[0].providerChanged).toBe(true);
    // Empty-change object: the carrier changed, nothing on top of it.
    expect(transitions[0].changes).toEqual({
      addedProjects: [],
      removedProjects: [],
      changedProjects: [],
      addedEdges: [],
      removedEdges: [],
    });
  });

  it("discloses a one-sided policy as incomparable rather than unchanged", () => {
    const files = filesFor({
      "0001-a.json": envelope({ policy: "p1" }),
      "0002-b.json": envelope(),
    });
    const { transitions } = computeEvolution(files);
    expect(transitions[0].policyChanged).toBeNull();
    expect(transitions[0].notes.some((n) => /could not be compared/.test(n))).toBe(true);
  });

  it("discloses a one-sided provenance as incomparable rather than unchanged", () => {
    const files = filesFor({
      "0001-a.json": envelope({ commit: "aaa" }),
      "0002-b.json": envelope({ commit: null }),
    });
    const { transitions } = computeEvolution(files);
    expect(transitions[0].codeDrift).toBe(false);
    expect(transitions[0].notes.some((n) => /provenance could not be compared/.test(n))).toBe(true);
  });

  it("records an A → B → A evolution as two real transitions", () => {
    const files = filesFor({
      "0001-a.json": envelope({ dependencies: [] }),
      "0002-b.json": envelope({
        dependencies: [{ source: "a", target: "b", type: "static" }],
        projects: [
          { name: "a", root: "libs/a", tags: [] },
          { name: "b", root: "libs/b", tags: [] },
        ],
      }),
      "0003-a.json": envelope({ dependencies: [] }),
    });
    const { transitions } = computeEvolution(files);
    expect(transitions).toHaveLength(2);
    expect(transitions[0].architectureChanged).toBe(true);
    expect(transitions[1].architectureChanged).toBe(true);
  });

  it("outputs an empty transition list for a single snapshot", () => {
    const files = filesFor({ "0001-a.json": envelope() });
    const { snapshots, transitions } = computeEvolution(files);
    expect(snapshots).toHaveLength(1);
    expect(transitions).toHaveLength(0);
  });
});

const baseContext = (graph) => ({
  root: "/ws",
  provider: "native",
  marker: "archkeep.json",
  analysis: { failures: [], analyzed: 2, imports: 1 },
  graph: graph ?? {
    nodes: { a: { name: "a", type: "lib", data: { root: "libs/a", tags: [] } } },
    dependencies: {},
  },
  pluginGap: { registered: true, manifests: [] },
});

describe("historyCommand", () => {
  it("describes an existing directory without capturing", () => {
    const read = snapshotsFrom({ "0001-a.json": envelope() });
    const result = historyCommand("/ws/hist", baseContext(), {
      io: { readSnapshots: readSnapshotsFromMap(read) },
    });
    expect(result.status).toBe("ok");
    expect(result.evolution.snapshots).toHaveLength(1);
    expect(result.evolution.captured).toBeNull();
    expect(result.evolution.transitions).toEqual([]);
  });

  it("writes a new snapshot on capture when the architecture changed", () => {
    const read = snapshotsFrom({
      "0001-a.json": envelope({ dependencies: [], commit: "aaa" }),
    });
    const writes = [];
    const result = historyCommand(
      "/ws/hist",
      baseContext({
        nodes: {
          a: { name: "a", type: "lib", data: { root: "libs/a", tags: [] } },
          b: { name: "b", type: "lib", data: { root: "libs/b", tags: [] } },
        },
        dependencies: {
          a: [{ source: "a", target: "b", type: "static" }],
        },
      }),
      {
        capture: true,
        policyFingerprint: null,
        io: {
          readSnapshots: readSnapshotsFromMap(read),
          writeFile: (path, text) => writes.push({ path, text }),
        },
      },
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toMatch(/0002-[0-9a-f]{8}\.json$/);
    // The captured envelope is a valid graph envelope.
    const written = JSON.parse(writes[0].text);
    expect(written.command).toBe("graph");
    expect(written.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.evolution.captured.name).toMatch(/^0002-/);
    expect(result.evolution.transitions).toHaveLength(1);
  });

  it("deduplicates capture when the architecture identity already is the last", () => {
    const read = snapshotsFrom({ "0001-a.json": envelope() });
    const writes = [];
    const result = historyCommand("/ws/hist", baseContext(), {
      capture: true,
      io: {
        readSnapshots: readSnapshotsFromMap(read),
        writeFile: (path, text) => writes.push({ path, text }),
      },
    });
    expect(writes).toHaveLength(0);
    expect(result.evolution.captured.duplicate).toBe(true);
    expect(result.evolution.snapshots).toHaveLength(1);
  });

  it("records a capture even when the identity matches but the provider changed", () => {
    // A pure provider migration (identical graph and policy) changes how the
    // architecture is read; swallowing it via the identity match would erase a
    // change the transition taxonomy exists to surface.
    const read = snapshotsFrom({ "0001-a.json": envelope({ provider: "nx" }) });
    const writes = [];
    const result = historyCommand("/ws/hist", baseContext(), {
      capture: true,
      io: {
        readSnapshots: readSnapshotsFromMap(read),
        writeFile: (path, text) => writes.push({ path, text }),
      },
    });
    expect(writes).toHaveLength(1);
    expect(result.evolution.captured.duplicate).toBeFalsy();
    expect(result.evolution.captured.name).toMatch(/^0002-/);
    expect(result.evolution.transitions[0].providerChanged).toBe(true);
  });

  it("writes an atomic snapshot through the default writer", () => {
    // Without an injected `io.writeFile`, the default writer must stage to
    // `<name>.json.tmp` and rename over the final name — so an interrupted
    // write leaves a file `readSnapshots` filters, never a snapshot the record
    // would read as half a capture.
    writeFileSync.mockClear();
    renameSync.mockClear();
    const read = snapshotsFrom({ "0001-a.json": envelope({ dependencies: [], commit: "aaa" }) });
    const result = historyCommand(
      "/ws/hist",
      baseContext({
        nodes: {
          a: { name: "a", type: "lib", data: { root: "libs/a", tags: [] } },
          b: { name: "b", type: "lib", data: { root: "libs/b", tags: [] } },
        },
        dependencies: {
          a: [{ source: "a", target: "b", type: "static" }],
        },
      }),
      {
        capture: true,
        io: { readSnapshots: readSnapshotsFromMap(read) },
      },
    );
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    expect(renameSync).toHaveBeenCalledTimes(1);
    const tmpPath = writeFileSync.mock.calls[0][0];
    const finalPath = renameSync.mock.calls[0][1];
    expect(tmpPath.endsWith(".json.tmp")).toBe(true);
    expect(finalPath.endsWith(".json")).toBe(true);
    expect(tmpPath.replace(/\.tmp$/, "")).toBe(finalPath);
    expect(result.evolution.captured.duplicate).toBeFalsy();
  });

  it("throws on an empty directory", () => {
    expect(() =>
      historyCommand("/ws/hist", baseContext(), { io: { readSnapshots: () => ({ files: [] }) } }),
    ).toThrow(/contains no snapshots/);
  });

  it("throws when the head graph is incomplete under capture", () => {
    const read = snapshotsFrom({ "0001-a.json": envelope() });
    const ctx = baseContext();
    // A whole-file failure is one with line === null (`isWholeFileFailure`).
    ctx.analysis.failures = [
      { sourceFile: "x.go", line: null, column: null, reason: "parse error" },
    ];
    expect(() =>
      historyCommand("/ws/hist", ctx, {
        capture: true,
        io: { readSnapshots: readSnapshotsFromMap(read) },
      }),
    ).toThrow(/incomplete coverage/);
  });
});

describe("compareSnapshotMetadata", () => {
  const p = (c, r = "https://example.test/repo.git") => ({ commit: c, remote: r, dirty: false });

  it("reports changed provenance when commits differ", () => {
    expect(
      compareSnapshotMetadata({
        baselineProvider: "native",
        headProvider: "native",
        baselineProvenance: p("aaa"),
        headProvenance: p("bbb"),
        baselineFingerprint: null,
        headFingerprint: null,
      }).provenanceChanged,
    ).toBe(true);
  });

  it("reports a cross-repository diff when remotes differ", () => {
    expect(
      compareSnapshotMetadata({
        baselineProvider: "native",
        headProvider: "native",
        baselineProvenance: p("aaa"),
        headProvenance: { commit: "bbb", remote: "https://other.test/repo.git", dirty: false },
        baselineFingerprint: null,
        headFingerprint: null,
      }).crossRepo,
    ).toBe(true);
  });

  it("reports an unverifiable provenance when one side is missing", () => {
    expect(
      compareSnapshotMetadata({
        baselineProvider: "native",
        headProvider: "native",
        baselineProvenance: p("aaa"),
        headProvenance: null,
        baselineFingerprint: null,
        headFingerprint: null,
      }).provenanceOneSided,
    ).toBe(true);
  });

  it("reports a policy change and its mismatch payload", () => {
    const m = compareSnapshotMetadata({
      baselineProvider: "native",
      headProvider: "native",
      baselineProvenance: p("aaa"),
      headProvenance: p("aaa"),
      baselineFingerprint: "p1",
      headFingerprint: "p2",
    });
    expect(m.policyChanged).toBe(true);
    expect(m.policyMismatch).toEqual({
      baseline: { fingerprint: "p1" },
      head: { fingerprint: "p2" },
    });
  });

  it("leaves policyChanged null (unverifiable) when fingerprints are one-sided", () => {
    const m = compareSnapshotMetadata({
      baselineProvider: "native",
      headProvider: "native",
      baselineProvenance: null,
      headProvenance: null,
      baselineFingerprint: "p1",
      headFingerprint: null,
    });
    expect(m.policyChanged).toBeNull();
    expect(m.policyOneSided).toBe(true);
  });

  it("reports provider change only when the baseline names a provider", () => {
    expect(
      compareSnapshotMetadata({
        baselineProvider: "native",
        headProvider: "nx",
        baselineProvenance: null,
        headProvenance: null,
        baselineFingerprint: null,
        headFingerprint: null,
      }).providerChanged,
    ).toBe(true);
    // A baseline with no provider cannot be asserted different.
    expect(
      compareSnapshotMetadata({
        baselineProvider: null,
        headProvider: "nx",
        baselineProvenance: null,
        headProvenance: null,
        baselineFingerprint: null,
        headFingerprint: null,
      }).providerChanged,
    ).toBe(false);
  });

  it("reports each dirty side directly, and clean sides as no dirtiness", () => {
    // `dirtyBaseline`/`dirtyHead` are what `diff`, `delta` and `change` turn
    // into their disclosure notes — pinned here at the unit so a consumer
    // reading them from the shared comparator cannot be silently dropped by
    // one command while the others keep the note.
    const dirty = (c) => ({ commit: c, remote: "https://example.test/repo.git", dirty: true });
    const clean = (c) => ({ commit: c, remote: "https://example.test/repo.git", dirty: false });

    expect(
      compareSnapshotMetadata({
        baselineProvider: "native",
        headProvider: "native",
        baselineProvenance: dirty("aaa"),
        headProvenance: clean("aaa"),
        baselineFingerprint: null,
        headFingerprint: null,
      }),
    ).toMatchObject({ dirtyBaseline: true, dirtyHead: false });

    expect(
      compareSnapshotMetadata({
        baselineProvider: "native",
        headProvider: "native",
        baselineProvenance: clean("aaa"),
        headProvenance: dirty("bbb"),
        baselineFingerprint: null,
        headFingerprint: null,
      }),
    ).toMatchObject({ dirtyBaseline: false, dirtyHead: true });

    expect(
      compareSnapshotMetadata({
        baselineProvider: "native",
        headProvider: "native",
        baselineProvenance: clean("aaa"),
        headProvenance: clean("aaa"),
        baselineFingerprint: null,
        headFingerprint: null,
      }),
    ).toMatchObject({ dirtyBaseline: false, dirtyHead: false });
  });
});

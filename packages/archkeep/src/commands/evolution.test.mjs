// Unit tests for the `evolution` command, driven entirely through injected
// seams — a fake spawner answers git, a fake context factory answers analysis,
// and no byte touches a filesystem or a repository.
//
// What is under contract here is ORCHESTRATION and REFUSAL: revision selection,
// ordering, worktree lifecycle, the incomplete-coverage refusal, and the rule
// that every failure is loud rather than a shorter record. The ANALYSIS half —
// real analyzers over real trees, real worktrees materialized by real git — is
// `./evolution.cli.integration.test.mjs`, because a stubbed analyzer would pin
// the orchestration while proving nothing about any actual revision.

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildEvolutionSummary,
  evolutionCommand,
  resolveRevision,
  selectLinearRange,
} from "./evolution.mjs";

const SHA = (digit) => String(digit).repeat(40);
const BASE = SHA(1);
const MID = SHA(2);
const TIP = SHA(3);
const MERGE = SHA(4);
const OTHER = SHA(5);

/** A boundary law whose fingerprint differs from every other LAW_* here. */
const law = (buildTargets) => ({
  depConstraints: [],
  moduleBoundaryOptions: {
    allow: [],
    buildTargets,
    enforceBuildableLibDependency: false,
    allowCircularSelfDependency: false,
    checkDynamicDependenciesExceptions: [],
    ignoredCircularDependencies: [],
    banTransitiveDependencies: false,
    checkNestedExternalImports: false,
  },
});

/**
 * A project graph in the shape `resolveCommandContext` returns:
 * `{ nodes, dependencies }`, with two projects and optionally an edge between
 * them.
 */
function graph({ edge = false } = {}) {
  const dependencies = { alpha: [], beta: [] };
  if (edge) {
    dependencies.alpha.push({ source: "alpha", target: "beta", type: "static" });
  }
  return {
    nodes: {
      alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: ["a"] } },
      beta: { name: "beta", type: "lib", data: { root: "libs/beta", tags: ["b"] } },
    },
    dependencies,
  };
}

/**
 * A CommandContext stand-in carrying just what this command reads: the graph,
 * the analysis counters, zero whole-file failures, and options resolving to NO
 * law unless one is given as an inline object (`policyFrom`'s fourth dialect).
 */
function contextAt(dir, { edge = false, law: inlineLaw = null, brokenFiles = 0 } = {}) {
  const g = graph({ edge });
  return {
    root: dir,
    provider: "native",
    marker: "archkeep.json",
    graph: g,
    workspace: {},
    tracked: [],
    analysis: {
      imports: [{ sourceFile: "libs/alpha/a.go" }],
      analyzed: 2,
      analyzedFiles: ["libs/alpha/a.go", "libs/beta/b.go"],
      failures: Array.from({ length: brokenFiles }, (_, i) => ({
        sourceFile: `libs/alpha/broken${i}.go`,
        reason: "unreadable",
        // `isWholeFileFailure` reads a null line as the whole-file shape.
        line: null,
        column: null,
      })),
      exemptedFiles: [],
    },
    options:
      inlineLaw === null
        ? { boundaryConfig: null, tsConfig: "tsconfig.base.json", boundaryConfigDeclared: false }
        : {
            boundaryConfig: inlineLaw,
            tsConfig: "tsconfig.base.json",
            boundaryConfigDeclared: true,
          },
    pluginGap: { registered: true, manifests: [] },
    unownedGap: { files: [], languages: [] },
    unclaimedGap: { files: [] },
    owned: [],
  };
}

/**
 * A spawner answering only the five git questions this command asks, recording
 * every call so tests can assert the worktree lifecycle. Anything else throws —
 * a test driving an unexpected git call has a bug in its own fixture.
 */
function fakeRun({ revs, revList }) {
  const calls = [];
  /** Worktree directories this fake has materialized but seen no remove for. */
  const standing = new Set();
  const run = (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "rev-parse") {
      const rev = args[3].replace(/\^\{commit\}$/u, "");
      const sha = revs[rev];
      if (!sha) throw new Error(`git: bad revision '${rev}'`);
      return `${sha}\n`;
    }
    if (args[0] === "merge-base") return "";
    if (args[0] === "rev-list") {
      if (!Array.isArray(revList)) throw new Error("git: merge commits are not configured here");
      return revList.join("\n");
    }
    if (args[0] === "worktree" && args[1] === "add") {
      // ["worktree","add","--quiet","--detach",<dir>,<sha>] — the directory,
      // not the flag two slots earlier.
      standing.add(args[4]);
      return "";
    }
    if (args[0] === "worktree") {
      if (args[1] === "remove") standing.delete(args[3]);
      return "";
    }
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
  return { run, calls, standing };
}

/** Contexts keyed by the worktree directory that will hold each revision. */
function contextsByDirectory(perSha) {
  const resolveContext = vi.fn(async (dir) => {
    for (const [sha12, spec] of Object.entries(perSha)) {
      if (dir.includes(`-${sha12}`)) return contextAt(dir, spec);
    }
    throw new Error(`fixture gap: no context scripted for '${dir}'`);
  });
  return { resolveContext };
}

const provenanceFor = (commit) => ({ commit, remote: null, dirty: false });
const injectedProvenance = vi.fn((dir) => {
  const sha12 = /-([0-9a-f]{12})$/u.exec(dir)?.[1];
  // The user's own root carries no sha suffix; answer a fixed origin for it.
  return provenanceFor(sha12 ? `${sha12}${"f".repeat(28)}` : SHA(9));
});
const tempRoot = join(tmpdir(), "archkeep-evolution-unit-");

/** Drives one run end to end over a base→mid→tip range. */
async function happyRun() {
  const { run, calls, standing } = fakeRun({
    revs: { main: BASE, HEAD: TIP },
    revList: [`${MID} ${BASE}`, `${TIP} ${MID}`],
  });
  const { resolveContext } = contextsByDirectory({
    // base: two projects; mid: the edge arrives; tip: identical to mid. Every
    // revision declares the SAME law, so the drift classification on the last
    // transition rests on a policy that was actually compared and unchanged.
    [BASE.slice(0, 12)]: { edge: false, law: law(["build"]) },
    [MID.slice(0, 12)]: { edge: true, law: law(["build"]) },
    [TIP.slice(0, 12)]: { edge: true, law: law(["build"]) },
  });
  const result = await evolutionCommand(
    "/ws",
    { base: "main" },
    { run, makeTempRoot: () => tempRoot, resolveContext, resolveProvenance: injectedProvenance },
  );
  return { result, calls, standing };
}

describe("the selected range", () => {
  it("orders revisions oldest-first with base first and head last", async () => {
    const { result } = await happyRun();
    expect(result.result.revisions.map((r) => r.commit)).toEqual([BASE, MID, TIP]);
  });

  it("attributes the architecture change to the revision where the edge appears", async () => {
    const { result } = await happyRun();
    const [first, second] = result.result.transitions;
    expect(first.from).toBe(BASE);
    expect(first.to).toBe(MID);
    expect(first.architectureChanged).toBe(true);
    expect(first.changes.addedEdges).toEqual([{ source: "alpha", target: "beta", type: "static" }]);
    // Same graph on both sides of the last transition, but the commit moved:
    // code drift, classified exactly as `history` classifies it.
    expect(second.architectureChanged).toBe(false);
    expect(second.codeDrift).toBe(true);
    expect(second.changes).toBeNull();
  });

  it("keeps a revert visible as added-then-removed instead of collapsing to final state", async () => {
    const { run } = fakeRun({
      revs: { main: BASE, HEAD: OTHER },
      revList: [`${MID} ${BASE}`, `${OTHER} ${MID}`],
    });
    const { resolveContext } = contextsByDirectory({
      [BASE.slice(0, 12)]: { edge: false, law: law(["build"]) },
      [MID.slice(0, 12)]: { edge: true, law: law(["build"]) },
      [OTHER.slice(0, 12)]: { edge: false, law: law(["build"]) },
    });
    const { result } = await evolutionCommand(
      "/ws",
      { base: "main" },
      { run, makeTempRoot: () => tempRoot, resolveContext, resolveProvenance: injectedProvenance },
    );
    expect(result.transitions.map((t) => t.architectureChanged)).toEqual([true, true]);
    expect(result.transitions[0].changes.addedEdges.length).toBe(1);
    expect(result.transitions[1].changes.removedEdges.length).toBe(1);
  });

  it("classifies a policy-only change without calling it architectural", async () => {
    const { run } = fakeRun({
      revs: { main: BASE, HEAD: MID },
      revList: [`${MID} ${BASE}`],
    });
    const { resolveContext } = contextsByDirectory({
      [BASE.slice(0, 12)]: { edge: true, law: law(["build"]) },
      [MID.slice(0, 12)]: { edge: true, law: law(["compile"]) },
    });
    const { result } = await evolutionCommand(
      "/ws",
      { base: "main" },
      { run, makeTempRoot: () => tempRoot, resolveContext, resolveProvenance: injectedProvenance },
    );
    const [transition] = result.transitions;
    expect(transition.architectureChanged).toBe(false);
    expect(transition.policyChanged).toBe(true);
    expect(transition.codeDrift).toBe(false);
    expect(transition.notes.join("\n")).toContain("policy");
  });

  it("discloses an unverifiable policy instead of reading it as unchanged", async () => {
    // Neither revision declares a law: policyChanged must be null — never
    // folded into false, which would let the drift classification fire on a
    // policy nobody compared. The two revisions' provenance differs, so the
    // pair is provenance-advancing: the disclosure note names it rather than
    // reading the unverifiable policy as an unchanged one (F-HIST-1).
    const { run } = fakeRun({
      revs: { main: BASE, HEAD: MID },
      revList: [`${MID} ${BASE}`],
    });
    const { resolveContext } = contextsByDirectory({
      [BASE.slice(0, 12)]: { edge: true },
      [MID.slice(0, 12)]: { edge: true },
    });
    const { result } = await evolutionCommand(
      "/ws",
      { base: "main" },
      { run, makeTempRoot: () => tempRoot, resolveContext, resolveProvenance: injectedProvenance },
    );
    const [transition] = result.transitions;
    expect(transition.policyChanged).toBeNull();
    expect(transition.codeDrift).toBe(false);
    // The transition must disclose the PROVENANCE-ADVANCING both-absent case
    // specifically — never the one-sided note, which asserts a false fact about
    // which side lacks a law (F-HIST-1).
    expect(transition.notes.join("\n")).toContain(
      "neither snapshot records the boundary law while the provenance advanced, so code drift cannot be asserted",
    );
    expect(transition.notes.join("\n")).not.toContain("one snapshot records the boundary law");
  });
});

describe("refusals that would otherwise read as a shorter history", () => {
  it("refuses a merge commit inside the range, naming it", async () => {
    const { run } = fakeRun({
      revs: { main: BASE, HEAD: MERGE },
      revList: [`${MERGE} ${BASE} ${OTHER}`],
    });
    await expect(
      evolutionCommand("/ws", { base: "main" }, { run, makeTempRoot: () => tempRoot }),
    ).rejects.toThrow(new RegExp(`${MERGE.slice(0, 8)}.*merge commit`, "u"));
  });

  it("refuses coincident endpoints", async () => {
    const { run } = fakeRun({ revs: { main: BASE, HEAD: BASE }, revList: [] });
    await expect(
      evolutionCommand("/ws", { base: "main" }, { run, makeTempRoot: () => tempRoot }),
    ).rejects.toThrow(/selects nothing/u);
  });

  it("refuses a base off head's ancestry", async () => {
    const { run } = fakeRun({ revs: { main: BASE, HEAD: TIP }, revList: [] });
    const failing = (file, args) => {
      if (args[0] === "merge-base") throw new Error("git: not an ancestor");
      return run(file, args);
    };
    await expect(
      evolutionCommand("/ws", { base: "main" }, { run: failing, makeTempRoot: () => tempRoot }),
    ).rejects.toThrow(/not an ancestor/u);
  });

  it("refuses an unresolved revision, naming the flag that asked for it", () => {
    const { run } = fakeRun({ revs: {}, revList: [] });
    expect(() => selectLinearRange("/ws", { base: "nope", head: null }, { run })).toThrow(
      /--base 'nope'/u,
    );
  });

  it("refuses a revision spelled like an option before git ever sees it", () => {
    const { calls } = fakeRun({ revs: {}, revList: [] });
    expect(() => resolveRevision("/ws", "--upload-pack=evil", "--base")).toThrow(
      /would be read by git as an option/u,
    );
    expect(calls).toEqual([]);
  });

  it("refuses a revision whose analysis leaves whole files unread, naming it", async () => {
    const { run, calls, standing } = fakeRun({
      revs: { main: BASE, HEAD: TIP },
      revList: [`${MID} ${BASE}`, `${TIP} ${MID}`],
    });
    const { resolveContext } = contextsByDirectory({
      [BASE.slice(0, 12)]: { edge: false },
      [MID.slice(0, 12)]: { brokenFiles: 2 },
      [TIP.slice(0, 12)]: { edge: true },
    });
    await expect(
      evolutionCommand(
        "/ws",
        { base: "main" },
        {
          run,
          makeTempRoot: () => tempRoot,
          resolveContext,
          resolveProvenance: injectedProvenance,
        },
      ),
    ).rejects.toThrow(new RegExp(`${MID.slice(0, 12)}.*2 files produced no verdict`, "u"));
    // The quiet direction, closed from both ends: the failed revision's
    // worktree was still released, and nothing was reported as changed.
    expect(calls.some((c) => c.includes("remove") && c.join(" ").includes(MID.slice(0, 12)))).toBe(
      true,
    );
    expect(standing.has(`${tempRoot}/1-${MID.slice(0, 12)}`)).toBe(false);
  });

  it("propagates a revision that cannot be read as a workspace at all", async () => {
    const { run } = fakeRun({
      revs: { main: BASE, HEAD: TIP },
      revList: [`${MID} ${BASE}`, `${TIP} ${MID}`],
    });
    const resolveContext = vi.fn(async (dir) => {
      if (dir.includes(`-${MID.slice(0, 12)}`)) {
        throw new Error("archkeep: no workspace root above this directory");
      }
      return contextAt(dir, {});
    });
    await expect(
      evolutionCommand(
        "/ws",
        { base: "main" },
        {
          run,
          makeTempRoot: () => tempRoot,
          resolveContext,
          resolveProvenance: injectedProvenance,
        },
      ),
    ).rejects.toThrow(/no workspace root/u);
  });

  it("fails loudly when a temporary worktree cannot be created", async () => {
    const { run } = fakeRun({ revs: { main: BASE, HEAD: TIP }, revList: [] });
    const failingAdd = (file, args) => {
      if (args[0] === "worktree" && args[1] === "add") throw new Error("git: worktree add failed");
      return run(file, args);
    };
    await expect(
      evolutionCommand("/ws", { base: "main" }, { run: failingAdd, makeTempRoot: () => tempRoot }),
    ).rejects.toThrow(/worktree add failed/u);
  });

  it("fails loudly when a worktree cannot be released after a successful analysis", async () => {
    const { run } = fakeRun({
      revs: { main: BASE, HEAD: MID },
      revList: [`${MID} ${BASE}`],
    });
    const failingRemove = (file, args) => {
      if (args[0] === "worktree" && args[1] === "remove") throw new Error("git: remove failed");
      return run(file, args);
    };
    const { resolveContext } = contextsByDirectory({
      [BASE.slice(0, 12)]: { edge: false },
      [MID.slice(0, 12)]: { edge: true },
    });
    await expect(
      evolutionCommand(
        "/ws",
        { base: "main" },
        {
          run: failingRemove,
          makeTempRoot: () => tempRoot,
          resolveContext,
          resolveProvenance: injectedProvenance,
        },
      ),
    ).rejects.toThrow(/releasing the temporary worktree/u);
  });
});

describe("the worktree lifecycle and the envelope", () => {
  it("materializes one detached worktree per revision and leaves none standing", async () => {
    const { calls, standing } = await happyRun();
    const adds = calls.filter((c) => c.includes("add"));
    expect(adds.map((c) => c[c.length - 1])).toEqual([BASE, MID, TIP]);
    for (const add of adds) {
      expect(add).toContain("--detach");
    }
    expect(standing.size).toBe(0);
  });

  it("answers with an ok descriptive envelope whose command is evolution", async () => {
    const { result } = await happyRun();
    expect(result.status).toBe("ok");
    const envelope = JSON.parse(result.report.json);
    expect(envelope.command).toBe("evolution");
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.notes.join("\n")).toContain("first analyzed revision");
    expect(envelope.workspace.provenance.dirty).toBe(false);
  });

  it("renders a text report whose counts match the record", async () => {
    const { result } = await happyRun();
    const text = result.report.text;
    expect(text).toContain("evolution");
    expect(text).toContain("3 revisions, 2 transitions");
    expect(text).toMatch(/1 transition recorded an architectural change/u);
  });

  it("discloses a dirty working tree without letting it touch any analyzed revision", async () => {
    const { run } = fakeRun({
      revs: { main: BASE, HEAD: MID },
      revList: [`${MID} ${BASE}`],
    });
    const { resolveContext } = contextsByDirectory({
      [BASE.slice(0, 12)]: { edge: false },
      [MID.slice(0, 12)]: { edge: true },
    });
    const dirtyUserTree = vi.fn((dir) =>
      dir === "/ws" ? { commit: SHA(9), remote: null, dirty: true } : provenanceFor(SHA(9)),
    );
    const outcome = await evolutionCommand(
      "/ws",
      { base: "main" },
      { run, makeTempRoot: () => tempRoot, resolveContext, resolveProvenance: dirtyUserTree },
    );
    const envelope = JSON.parse(outcome.report.json);
    expect(envelope.workspace.provenance.dirty).toBe(true);
    expect(envelope.coverage.notes.join("\n")).toContain("uncommitted changes");
    // The transition record itself is untouched by the desk state: the same
    // facts a clean tree would produce, attributed to the same revisions, and
    // no transition carries a dirty-tree disclosure — that flag belongs to the
    // user's tree alone, never to a materialized revision.
    expect(outcome.result.transitions.map((t) => t.architectureChanged)).toEqual([true]);
    expect(outcome.result.transitions.flatMap((t) => t.notes).join("\n")).not.toContain(
      "uncommitted",
    );
  });

  it("is deterministic: two runs over the same inputs produce identical records", async () => {
    const first = await happyRun();
    const second = await happyRun();
    expect(first.result.result).toEqual(second.result.result);
  });
});

describe("the summary's disposition latch (#739)", () => {
  // A minimal comparison carrying only what the fold reads: the disposition
  // loop runs before the axis unions, and every axis those touch is present
  // and empty, so the assertions see the latch and nothing else.
  const comparison = (disposition) => ({
    disposition,
    observed: {
      architectureChanged: false,
      projects: { added: [], removed: [], changed: [] },
      edges: { added: [], removed: [] },
      policyChanged: false,
      providerChanged: false,
    },
    findings: { introduced: [], resolved: [], unknown: [] },
    debt: { introduced: [], resolved: [] },
    fitness: { verdictDeltas: [] },
  });

  it("keeps the worst disposition across transitions — the valid path is untouched", () => {
    expect(
      buildEvolutionSummary([comparison("accepted"), comparison("rejected")]).disposition,
    ).toBe("rejected");
    expect(buildEvolutionSummary([comparison("accepted")]).disposition).toBe("accepted");
    expect(buildEvolutionSummary([comparison("no-verdict")]).disposition).toBe("no-verdict");
  });

  it("throws on a garbled disposition instead of folding it to accepted's rank", () => {
    // The old `?? 1` fold read any unknown disposition as rank 1 — accepted's
    // own rank — so a typo could silently drop the summary's worst transition.
    expect(() => buildEvolutionSummary([comparison("accepetd")])).toThrow(
      '"accepetd" is not one of',
    );
  });

  it("throws on an absent disposition", () => {
    expect(() => buildEvolutionSummary([{}])).toThrow("undefined is not one of");
  });
});

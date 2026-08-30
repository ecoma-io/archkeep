// Unit tests for the W7 per-revision/per-transition evidence of the `evolution`
// command (design §7/§8): the per-revision comparable evidence (intent verdict,
// fitness verdicts, ADR registry state), the 8-question comparison each
// revision pair carries, the `result.summary`, and the transition EvolutionEvent
// each pair emits through `--event-out`.
//
// The orchestration seams are the ones `./evolution.test.mjs` drives — a fake
// spawner answering git, an injected context factory and provenance resolver —
// but the EVIDENCE half, the one this file owns, reads REAL bytes:
// `loadIntent` and `readAdrContext` run against actual `architecture-intent.json`
// / `docs/adr/NNN-slug.md` files seeded at the fake worktree directories the
// run materializes, and the event store is a real directory under the OS temp
// root read back through the shipped `readEvents`/`writeEvent`.
//
// The silent direction is the invariant under test, asserted both ways: an
// incomparable axis must be `{available: false, reason}` — never zero, never
// folded into a clean "none" — a rerun over the same pair must duplicate
// nothing, and a report that dropped a question field fails here. Every test
// below is red in the direction the invariant forbids.

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { evolutionCommand } from "./evolution.mjs";
import { INTENT_FILE } from "../architecture-intent/model.mjs";
import { eventDedupeKey, eventId } from "../governance/evolution-event.mjs";
import { readEvents } from "../governance/evolution-store.mjs";

const SHA = (digit) => String(digit).repeat(40);
const BASE = SHA(1);
const MID = SHA(2);
const TIP = SHA(3);

/** The declared intent every revision carries: alpha must never reach beta. */
const INTENT = {
  version: "1",
  boundaries: [
    { name: "alpha", match: ["name:alpha"] },
    { name: "beta", match: ["name:beta"] },
  ],
  forbidden: [{ from: "alpha", to: "beta", reason: "alpha must never depend on beta" }],
};

/** The ADR both sides of every comparable pair record, binding the fitness id. */
const ADR_FILE = "docs/adr/0010-record.md";
const ADR_TEXT = [
  "---",
  "id: 0010-record",
  "status: accepted",
  "bindings:",
  "  - no-cycles",
  "---",
  "# 0010-record",
  "",
  "## Decision",
  "Adopt the no-cycles fitness function as the recorded decision.",
].join("\n");

/** Both evidence carriers tracked by default, so intent + ADR are judged. */
const TRACKED = [INTENT_FILE, ADR_FILE];

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

/** The same law plus one declared fitness function every revision judges. */
const fitnessLaw = (buildTargets) => ({
  ...law(buildTargets),
  fitness: [
    { name: "no-cycles", match: ["*"], condition: { type: "cycle-free" }, reason: "no cycles" },
  ],
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
 * the analysis counters, zero whole-file failures, options resolving to NO law
 * unless one is given as an inline object (`policyFrom`'s fourth dialect), and
 * the tracked-file list that decides whether the intent and ADR evidence are
 * compared for this revision.
 */
function contextAt(
  dir,
  { edge = false, law: inlineLaw = null, tracked = TRACKED, brokenFiles = 0 } = {},
) {
  const g = graph({ edge });
  return {
    root: dir,
    provider: "native",
    marker: "archkeep.json",
    graph: g,
    workspace: {},
    tracked,
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
 * A spawner answering only the five git questions this command asks. Anything
 * else throws — a test driving an unexpected git call has a bug in its own
 * fixture.
 */
function fakeRun({ revs, revList }) {
  const run = (file, args) => {
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
      return "";
    }
    if (args[0] === "worktree" && args[1] === "remove") return "";
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
  return { run };
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

/**
 * Drives one evolution run end to end over `ordered` revisions, seeding REAL
 * intent/ADR bytes at the worktree directories the run will materialize, and
 * returning the result. The runner deletes its temp root on exit, so each
 * call owns a fresh one.
 */
async function runEvolution({ perSha, ordered, eventOut = null, intentBySha = {} }) {
  const tempRoot = mkdtempSync(join(tmpdir(), "archkeep-evolution-report-"));
  // Worktree directories follow evolution.mjs's own naming: `${parent}/${index}-${sha12}`.
  for (const [index, sha] of ordered.entries()) {
    const dir = join(tempRoot, `${index}-${sha.slice(0, 12)}`);
    mkdirSync(join(dir, "docs/adr"), { recursive: true });
    writeFileSync(
      join(dir, INTENT_FILE),
      `${JSON.stringify(intentBySha[sha.slice(0, 12)] ?? INTENT, null, 2)}\n`,
    );
    writeFileSync(join(dir, ADR_FILE), ADR_TEXT);
  }
  const { run } = fakeRun({
    revs: { main: ordered[0], HEAD: ordered[ordered.length - 1] },
    revList: ordered.slice(1).map((to, index) => `${to} ${ordered[index]}`),
  });
  const { resolveContext } = contextsByDirectory(perSha);
  const outcome = await evolutionCommand(
    "/ws",
    { base: "main", eventOut },
    { run, makeTempRoot: () => tempRoot, resolveContext, resolveProvenance: injectedProvenance },
  );
  return { result: outcome.result };
}

/**
 * The three-revision fixture the happy path shares: base is clean, mid
 * introduces the forbidden alpha→beta edge, tip is identical to mid — so the
 * first pair is a code-and-violation change and the second a code drift.
 */
const happyPerSha = {
  [BASE.slice(0, 12)]: { edge: false, law: fitnessLaw(["build"]) },
  [MID.slice(0, 12)]: { edge: true, law: fitnessLaw(["build"]) },
  [TIP.slice(0, 12)]: { edge: true, law: fitnessLaw(["build"]) },
};
const happyRange = [BASE, MID, TIP];

describe("the per-revision comparable evidence", () => {
  it("records the intent verdict, fitness verdicts, and ADR registry state of each revision", async () => {
    const { result } = await runEvolution({ perSha: happyPerSha, ordered: happyRange });
    const [base, mid, tip] = result.revisions;
    // The intent verdict is over EACH revision's own graph: clean at base,
    // the forbidden edge in findings once the edge exists.
    expect(base.evidence.intent.verdict).toBe("ok");
    expect(mid.evidence.intent.verdict).toBe("findings");
    expect(tip.evidence.intent.verdict).toBe("findings");
    expect(base.evidence.intent.findings).toEqual([]);
    expect(mid.evidence.intent.findings).toHaveLength(1);
    // The declared fitness function is judged on every revision.
    for (const revision of result.revisions) {
      expect(revision.evidence.fitness.verdict).toBe("pass");
      expect(revision.evidence.fitness.decisions).toEqual([
        expect.objectContaining({ name: "no-cycles", verdict: "pass" }),
      ]);
    }
    // The registry state each revision records, bindings intact.
    for (const revision of result.revisions) {
      expect(revision.evidence.adr.records[0].id).toBe("0010-record");
      expect(revision.evidence.adr.records[0].status).toBe("accepted");
      expect(revision.evidence.adr.records[0].bindings).toEqual(["no-cycles"]);
      expect(revision.evidence.adr.byId).toBeInstanceOf(Map);
      expect([...revision.evidence.adr.knownFitness]).toContain("no-cycles");
    }
  });

  it("discloses an untracked intent as a refusal shape, never a verdict", async () => {
    const { result } = await runEvolution({
      perSha: {
        // Base tracks no intent file, so its intent axis is a refusal.
        [BASE.slice(0, 12)]: { edge: false, law: fitnessLaw(["build"]), tracked: [ADR_FILE] },
        [MID.slice(0, 12)]: { edge: true, law: fitnessLaw(["build"]), tracked: TRACKED },
      },
      ordered: [BASE, MID],
    });
    // Refusal shape: {verdict: "no-verdict", note} — no findings array, so no
    // downstream diff can fabricate a clean comparison from it.
    expect(result.revisions[0].evidence.intent).toEqual({
      verdict: "no-verdict",
      note: "no intent compared",
    });
    // The tracked revision judges normally — the two shapes are distinct.
    expect(result.revisions[1].evidence.intent.verdict).toBe("findings");
  });

  it("omits evidence entirely on a revision with nothing to compare", async () => {
    const { result } = await runEvolution({
      perSha: {
        // No tracked carrier (no intent, no ADR) and no declared fitness: the
        // revision has nothing comparable, so the key is ABSENT — never a
        // fabricated empty record, never `null` leaking into the JSON.
        [BASE.slice(0, 12)]: { edge: false, law: law(["build"]), tracked: [] },
        [MID.slice(0, 12)]: { edge: false, law: law(["build"]), tracked: [] },
      },
      ordered: [BASE, MID],
    });
    for (const revision of result.revisions) {
      expect("evidence" in revision).toBe(false);
    }
  });
});

describe("the per-transition 8-question comparison evidence", () => {
  const COMPARISON_FIELDS = [
    "observed",
    "findings",
    "debt",
    "fitness",
    "coverage",
    "classifications",
    "disposition",
    "affected",
    "notes",
  ];
  const OBSERVED_FIELDS = [
    "architectureChanged",
    "projects",
    "edges",
    "policyChanged",
    "policyOneSided",
    "providerChanged",
    "provenanceChanged",
  ];

  it("carries every question field on every transition and on the summary", async () => {
    const { result } = await runEvolution({ perSha: happyPerSha, ordered: happyRange });
    for (const transition of result.transitions) {
      expect(Object.keys(transition.comparison).sort()).toEqual([...COMPARISON_FIELDS].sort());
      expect(Object.keys(transition.comparison.observed).sort()).toEqual(
        [...OBSERVED_FIELDS].sort(),
      );
      expect(transition.comparison.observed.projects).toEqual({
        added: [],
        removed: [],
        changed: [],
      });
      expect(transition.comparison.coverage.base.projects).toBe(2);
      expect(transition.comparison.coverage.head.projects).toBe(2);
    }
    expect(Object.keys(result.summary).sort()).toEqual(
      [
        "transitions",
        "disposition",
        "classifications",
        "observed",
        "affected",
        "findings",
        "debt",
        "fitness",
        "notes",
      ].sort(),
    );
  });

  it("reports introduced findings and debt as real stable diff ids on a comparable pair", async () => {
    const { result } = await runEvolution({ perSha: happyPerSha, ordered: happyRange });
    const [first, second] = result.transitions;
    // The edge arrives at mid: exactly one drift finding introduced.
    expect(first.comparison.findings.introduced).toHaveLength(1);
    expect(first.comparison.findings.introduced[0]).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.comparison.findings.resolved).toEqual([]);
    expect(first.comparison.findings.unknown).toEqual([]);
    // The debt diff is the SAME stable ledger id as the finding diff — the
    // two axes must never disagree about which fact moved.
    expect(first.comparison.debt.introduced).toEqual(first.comparison.findings.introduced);
    // Nothing moved between mid and tip (same graph, same intent): empty
    // diffs on a comparable axis — the axis stays comparable, never zeroed.
    expect(second.comparison.findings).toEqual({ introduced: [], resolved: [], unknown: [] });
    expect(second.comparison.debt).toEqual({ introduced: [], resolved: [] });
  });

  it("classifies the introduced violation and the later code drift without inventing a decision change", async () => {
    const { result } = await runEvolution({ perSha: happyPerSha, ordered: happyRange });
    const [first, second] = result.transitions;
    expect(first.comparison.disposition).toBe("rejected");
    expect(first.comparison.classifications).toEqual(["CHANGE", "VIOLATION"]);
    // The registry did not move (same ADR on both sides): never DECISION_CHANGE.
    expect(first.comparison.classifications).not.toContain("DECISION_CHANGE");
    // The affected-decisions lineage resolves the enforced fitness id to the
    // recorded decision that binds it.
    expect(first.comparison.affected.lineage).toEqual([
      { id: "no-cycles", adrs: ["0010-record"], resolution: "none" },
    ]);
    // Unchanged graph, advancing commits: DRIFT, disclosed, accepted.
    expect(second.comparison.disposition).toBe("accepted");
    expect(second.comparison.classifications).toEqual(["DRIFT"]);
  });

  it("marks an unjudgeable intent axis n/a with a reason — never zero, never clean", async () => {
    const { result } = await runEvolution({
      perSha: {
        // Base tracks no intent file: the intent axis is a refusal, and the
        // comparison must say so instead of reporting a clean diff.
        [BASE.slice(0, 12)]: { edge: false, law: fitnessLaw(["build"]), tracked: [ADR_FILE] },
        [MID.slice(0, 12)]: { edge: true, law: fitnessLaw(["build"]), tracked: TRACKED },
      },
      ordered: [BASE, MID],
    });
    const [transition] = result.transitions;
    const marker = { available: false, reason: "base intent unjudgeable — no intent compared" };
    expect(transition.comparison.findings).toEqual(marker);
    expect(transition.comparison.debt).toEqual(marker);
    // The other axes stay comparable — an incomparable intent is granular to
    // the intent axes, never a global refusal.
    expect(transition.comparison.fitness).toEqual({
      verdictDeltas: [{ id: "no-cycles", base: "pass", head: "pass" }],
    });
    expect(transition.comparison.classifications).not.toContain("REPAIR");
    expect(transition.comparison.classifications).not.toContain("VIOLATION");
    // The summary propagates the marker and names the transition.
    expect(result.summary.findings.available).toBe(false);
    expect(result.summary.findings.reason).toContain("transition 0");
    expect(result.summary.debt.available).toBe(false);
  });

  it("marks a one-sided fitness axis n/a naming the side that declared nothing", async () => {
    const { result } = await runEvolution({
      perSha: {
        // Base declares no fitness block: not_applicable, not a verdict.
        [BASE.slice(0, 12)]: { edge: false, law: law(["build"]) },
        [MID.slice(0, 12)]: { edge: true, law: fitnessLaw(["build"]) },
      },
      ordered: [BASE, MID],
    });
    const [transition] = result.transitions;
    expect(transition.comparison.fitness).toEqual({
      available: false,
      reason: "no fitness block declared at base",
    });
    expect(result.summary.fitness.available).toBe(false);
    expect(result.summary.fitness.reason).toContain("transition 0");
  });

  it("summarizes the range with the worst disposition and unique unions", async () => {
    const { result } = await runEvolution({ perSha: happyPerSha, ordered: happyRange });
    const { summary } = result;
    expect(summary.transitions).toBe(2);
    // Worst of rejected + accepted — never the last transition's disposition.
    expect(summary.disposition).toBe("rejected");
    expect(summary.classifications).toEqual(["CHANGE", "DRIFT", "VIOLATION"]);
    expect(summary.observed.architectureChanged).toBe(1);
    expect(summary.observed.projects.added).toEqual([]);
    expect(summary.observed.edges.added).toEqual(["alpha→beta:static"]);
    expect(summary.observed.policyChanged).toBe(0);
    expect(summary.findings.introduced).toHaveLength(1);
    expect(summary.debt.introduced).toEqual(summary.findings.introduced);
    expect(summary.fitness.verdictDeltas).toEqual([
      { id: "no-cycles", base: "pass", head: "pass" },
    ]);
    expect(summary.affected.constraints).toContain("no-cycles");
    expect(summary.affected.decisions).toEqual([]);
    expect(summary.notes).toEqual(expect.any(Array));
  });

  it("carries no numeric health score in the comparisons, summary, or events", async () => {
    const eventOut = mkdtempSync(join(tmpdir(), "archkeep-evolution-events-"));
    const { result } = await runEvolution({ perSha: happyPerSha, ordered: happyRange, eventOut });
    const payloads = [
      ...result.transitions.map((t) => t.comparison),
      result.summary,
      ...readEvents(eventOut),
    ];
    const scoreKeys = (value, path = "") => {
      if (typeof value !== "object" || value === null) return [];
      return Object.entries(value).flatMap(([key, child]) => [
        ...(key.toLowerCase().includes("score") || key.toLowerCase().includes("health")
          ? [path + key]
          : []),
        ...scoreKeys(child, `${path}${key}.`),
      ]);
    };
    expect(payloads.flatMap((payload) => scoreKeys(payload))).toEqual([]);
  });
});

describe("the transition EvolutionEvent store (--event-out)", () => {
  it("writes one idempotent event per pair, and a rerun duplicates nothing", async () => {
    const eventOut = mkdtempSync(join(tmpdir(), "archkeep-evolution-events-"));
    const eventFiles = () =>
      readdirSync(eventOut)
        .filter((name) => name.endsWith(".json"))
        .sort();

    const { result } = await runEvolution({ perSha: happyPerSha, ordered: happyRange, eventOut });
    expect(result.transitions).toHaveLength(2);
    for (const transition of result.transitions) {
      expect(transition.eventWrite.dir).toBe(eventOut);
      expect(transition.eventWrite.duplicate).toBe(false);
      expect(transition.eventWrite.id).toMatch(/^[0-9a-f]{64}$/u);
    }
    const ids = result.transitions.map((t) => t.eventWrite.id);
    expect(eventFiles()).toHaveLength(2);

    // The store validates on read; what came back is the written record.
    const stored = readEvents(eventOut);
    expect(stored).toHaveLength(2);
    expect(stored.map((event) => event.id)).toEqual(ids);
    expect(stored[0].kind).toBe("transition");
    expect(stored[0].source).toBe("evolution");
    expect(stored[0].base.revision).toBe(BASE);
    expect(stored[0].head.revision).toBe(MID);
    expect(stored[0].base.snapshot).toBe(result.revisions[0].id);
    expect(stored[0].classifications).toEqual(result.transitions[0].comparison.classifications);
    expect(stored[0].disposition).toBe(result.transitions[0].comparison.disposition);
    expect(stored[0].provenance).toEqual([
      { kind: "git-commit", ref: `${BASE.slice(0, 12)}${"f".repeat(28)}` },
      { kind: "git-commit", ref: `${MID.slice(0, 12)}${"f".repeat(28)}` },
    ]);

    // The stored id/dedupeKey rematerialise from the canonical tuple — write
    // and read agree, so a re-run over the same pair cannot fork the record.
    // (`id` is the sha256 of `dedupeKey`, never equal to it.)
    for (const event of stored) {
      expect(event.id).toBe(eventId(event));
      expect(event.dedupeKey).toBe(eventDedupeKey(event));
      expect(event.id).toMatch(/^[0-9a-f]{64}$/u);
    }

    // A second run over the same pair writes nothing: same ids, same files.
    const rerun = await runEvolution({ perSha: happyPerSha, ordered: happyRange, eventOut });
    expect(rerun.result.transitions.map((t) => t.eventWrite.duplicate)).toEqual([true, true]);
    expect(rerun.result.transitions.map((t) => t.eventWrite.id)).toEqual(ids);
    expect(eventFiles()).toHaveLength(2);
  });
});

describe("F-EVO silent-direction regressions (issue #519)", () => {
  /** A fitness law declaring one id, for constructing per-revision gaps. */
  const fitnessLawId = (name) => ({
    ...law(["build"]),
    fitness: [
      { name, match: ["*"], condition: { type: "cycle-free" }, reason: `no cycles (${name})` },
    ],
  });

  it("F-EVO-4: one-sided unjudgeable intent reads no-verdict, never accepted", async () => {
    const { result } = await runEvolution({
      perSha: {
        // Base tracks no intent file (refusal), head carries a real intent — a
        // one-sided pair whose disposition must not read `accepted`.
        [BASE.slice(0, 12)]: { edge: false, law: fitnessLaw(["build"]), tracked: [ADR_FILE] },
        [MID.slice(0, 12)]: { edge: true, law: fitnessLaw(["build"]), tracked: TRACKED },
      },
      ordered: [BASE, MID],
    });
    const [transition] = result.transitions;
    // The axis is disclosed as unjudgeable, and the pair admits it cannot
    // reach a verdict — no fabricated accepted, no "fully comparable" note.
    expect(transition.comparison.findings.available).toBe(false);
    expect(transition.comparison.disposition).toBe("no-verdict");
    expect(transition.comparison.notes).not.toContain(
      "a fully comparable, unchanged pair — no classification applies",
    );
  });

  it("F-EVO-4: both sides absent intent keeps the status-quo accepted", async () => {
    // The W8-pinned baseline: neither side carries intent evidence, so nothing
    // is asserted on the intent axes and the pair stays accepted (DRIFT).
    const { result } = await runEvolution({
      perSha: {
        [BASE.slice(0, 12)]: { edge: false, law: fitnessLaw(["build"]), tracked: [ADR_FILE] },
        [MID.slice(0, 12)]: { edge: false, law: fitnessLaw(["build"]), tracked: [ADR_FILE] },
      },
      ordered: [BASE, MID],
    });
    const [transition] = result.transitions;
    expect(transition.comparison.findings.available).toBe(false);
    expect(transition.comparison.disposition).toBe("accepted");
  });

  it("F-EVO-1: a fitness id absent from one transition is marked, never pass→pass", async () => {
    const { result } = await runEvolution({
      perSha: {
        // no-cycles declared at base and tip, a different id at mid — so the
        // id is real at both ends but a marker in the middle transition.
        [BASE.slice(0, 12)]: { edge: false, law: fitnessLawId("no-cycles") },
        [MID.slice(0, 12)]: { edge: false, law: fitnessLawId("other-rules") },
        [TIP.slice(0, 12)]: { edge: false, law: fitnessLawId("no-cycles") },
      },
      ordered: [BASE, MID, TIP],
    });
    const summary = result.summary;
    const noCycles = summary.fitness.verdictDeltas.find((d) => d.id === "no-cycles");
    // The summary must surface the gap, not stitch first-base/last-head into a
    // fabricated pass→pass.
    expect(noCycles.base.available).toBe(false);
    expect(noCycles.head.available).toBe(false);
    expect(noCycles.base.reason).toContain("transition 0");
  });

  it("F-EVO-2: a gap closure classifies as REPAIR via debtResolved", async () => {
    // Base declares an optional allowed alpha→beta row with no edge built — an
    // aspirational gap. Head drops the row entirely, so the gap closes, which
    // only the aggregate debt answer (`debtResolved`) can see as a repair.
    const baseWithGap = {
      version: "1",
      boundaries: INTENT.boundaries,
      allowed: [
        {
          from: "alpha",
          to: "beta",
          optional: true,
          reason: "alpha may one day reach beta",
        },
      ],
    };
    const headNoGap = {
      version: "1",
      boundaries: INTENT.boundaries,
    };
    const { result } = await runEvolution({
      perSha: {
        [BASE.slice(0, 12)]: { edge: false, law: fitnessLaw(["build"]) },
        [MID.slice(0, 12)]: { edge: false, law: fitnessLaw(["build"]) },
      },
      ordered: [BASE, MID],
      intentBySha: {
        [BASE.slice(0, 12)]: baseWithGap,
        [MID.slice(0, 12)]: headNoGap,
      },
    });
    const [transition] = result.transitions;
    expect(transition.comparison.debt.resolved.length).toBeGreaterThan(0);
    expect(transition.comparison.classifications).toContain("REPAIR");
  });
});

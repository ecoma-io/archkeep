/**
 * Wave 3 W8 — evolution-lifecycle conformance fixtures, driven over REAL Git
 * commits through the merged `archkeep evolution` command (with `--event-out`).
 *
 * Design §11 enumerates 13 lifecycle cases and 2 invariants. Each case below
 * builds a fresh throwaway native Go workspace, commits a controlled two- or
 * three-revision timeline through real `git`, and asserts the concrete
 * observable from the JSON envelope: the classification set, the disposition,
 * the exit code, the event store files, the debt/findings id accounting, and
 * the policy-change disclosure.
 *
 * The kernel under test is the MERGED implementation — it is ground truth. If
 * an assertion disagrees with the kernel, the fixture is wrong, never the
 * kernel; nowhere does this suite paper over a case the kernel cannot satisfy.
 *
 * Fixture scaffolding lives ONLY in `./fixtures/evolution-lifecycle/` (per the
 * W8 task boundary); nothing here invents a second convention.
 */

import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import * as fx from "./fixtures/evolution-lifecycle/workspace.mjs";

vi.setConfig({ testTimeout: fx.SPAWN_TEST_BUDGET_MS });

/** Every throwaway workspace this suite opens, disposed in `afterAll`. */
const workspaces = [];

/** A fresh native Go workspace, tracked for cleanup. */
function workspace() {
  const ws = fx.createWorkspace();
  workspaces.push(ws.root);
  return ws;
}

/** A valid `boundaries` declaration: one boundary per project, by name. */
const BOUNDARIES = [
  { name: "alpha", match: ["name:alpha"] },
  { name: "beta", match: ["name:beta"] },
];

/** An intent that forbids alpha→beta through the drift `dependencies` section. */
const FORBIDDEN_ALPHA_BETA = (extra = {}) => ({
  version: "1",
  boundaries: BOUNDARIES,
  dependencies: { forbidden: [{ source: "alpha", target: "beta" }] },
  ...extra,
});

/**
 * An intent whose `dependencies.allowed` is an exhaustive allowlist that does
 * NOT permit alpha→beta: beta→alpha is the only declared edge, so reaching
 * alpha→beta is an undeclared dependency (the design §5 "undeclared change").
 */
const UNDECLARED_ALLOWLIST = {
  version: "1",
  boundaries: BOUNDARIES,
  dependencies: { allowed: [{ source: "beta", target: "alpha" }] },
};

/** A `layer-dependency` fitness row: layer a must never reach layer b. */
const fitnessForbidsAtoB = JSON.stringify([
  {
    name: "alpha-must-not-reach-beta",
    match: ["*"],
    condition: { type: "layer-dependency", from: "layer:a", to: "layer:b", direction: "forbidden" },
    reason: "alpha must never reach beta",
  },
]);

/** Writes the two source files: beta first, then alpha (clean or reaching). */
function seedSources(root, alpha) {
  fx.writeIn(root, "libs/beta/beta.go", fx.BETA);
  fx.writeIn(root, "libs/alpha/alpha.go", alpha);
}

/**
 * The base ingredients of almost every case: a permissive law, the beta source,
 * and the chosen alpha source, committed as the range's first revision.
 *
 * @param {{root: string}} ws The workspace under test.
 * @param {{alpha?: string, law?: {rows?: string, fitness?: string}}} [options]
 *   `law` rows (and optional `fitness`) when the base must declare policy.
 */
function commitBase(ws, { alpha = fx.ALPHA_CLEAN, law } = {}) {
  if (law) fx.writeLaw(ws.root, law);
  seedSources(ws.root, alpha);
  return fx.commit(ws.root, "base revision");
}

/**
 * A three-revision timeline that introduces a forbidden alpha→beta edge and
 * then removes it. Returns `{c1, c2, c3, root}`. Shared by the debt-introduction
 * (case 8), debt-resolution (case 9), revert (case 10) and monotonicity
 * invariant cases — each caller owns a fresh workspace, so the timelines never
 * collide.
 */
function violateThenRepair() {
  const ws = workspace();
  const root = ws.root;
  fx.writeLaw(root, { rows: fx.ALLOW_A_TO_B });
  fx.writeIntent(root, FORBIDDEN_ALPHA_BETA());
  const c1 = commitBase(ws, { alpha: fx.ALPHA_CLEAN });
  fx.writeIn(root, "libs/alpha/alpha.go", fx.ALPHA_REACHING);
  const c2 = fx.commit(root, "introduce the forbidden crossing");
  fx.writeIn(root, "libs/alpha/alpha.go", fx.ALPHA_CLEAN);
  const c3 = fx.commit(root, "remove the crossing");
  return { root, c1, c2, c3 };
}

/** An absolute event-store directory inside the workspace (cleaned up by `dispose`). */
const eventDir = (root) => join(root, ".events");
/**
 * Events are keyed by their id (a sha) and `readEvents` sorts by filename, so
 * file order is NOT transition order. Reorder them by their base revision
 * against the known timeline (`[c1, c2, c3]`), so `ordered[0]` is the first
 * transition's event and `ordered[1]` the second.
 */
function timelineOrder(events, timeline) {
  return timeline.map((base) => events.find((e) => e.provenance[0].ref === base)).filter(Boolean);
}

afterAll(() => {
  for (const root of workspaces) fx.dispose(root);
});

/**
 * A classification set must read exactly as asserted — an empty result is a
 * claim (`["DRIFT"]` means "only code drift"), so membership is never enough.
 */
function expectExactly(run, expected, { disposition }) {
  const envelope = fx.parseEnvelope(run);
  const comparison = envelope.result.transitions[0].comparison;
  expect(comparison.classifications.sort()).toEqual([...expected].sort());
  expect(comparison.disposition).toBe(disposition);
  return envelope;
}

describe("evolution lifecycle — congruence", () => {
  it("case 1 — a code-motion-only range is an honest clean baseline: DRIFT, accepted, nothing fabricated", async () => {
    const ws = workspace();
    const root = ws.root;
    fx.writeLaw(root, { rows: fx.ALLOW_A_TO_B });
    const c1 = commitBase(ws, { alpha: fx.ALPHA_CLEAN });
    fx.writeIn(
      root,
      "libs/alpha/alpha.go",
      'package alpha\n\nfunc Name() string { return "alpha-v2" }\n',
    );
    const c2 = fx.commit(root, "change a returned value");
    const run = await fx.runEvolution(root, fx.evolutionArgs(c1, { head: c2 }));
    const envelope = expectExactly(run, ["DRIFT"], { disposition: "accepted" });
    // No intent was declared anywhere: the findings/debt axes must say so
    // honestly instead of reporting a fabricated clean list.
    expect(envelope.result.transitions[0].comparison.findings.available).toBe(false);
    expect(envelope.result.transitions[0].comparison.debt.available).toBe(false);
  });

  it("case 2 — an allowed architecture change is CHANGE and accepted", async () => {
    const ws = workspace();
    const root = ws.root;
    fx.writeLaw(root, { rows: fx.ALLOW_A_TO_B });
    const c1 = commitBase(ws, { alpha: fx.ALPHA_CLEAN });
    fx.writeIn(root, "libs/alpha/alpha.go", fx.ALPHA_REACHING);
    const c2 = fx.commit(root, "alpha reaches beta (permitted)");
    const run = await fx.runEvolution(root, fx.evolutionArgs(c1, { head: c2 }));
    const envelope = expectExactly(run, ["CHANGE"], { disposition: "accepted" });
    const observed = envelope.result.transitions[0].comparison.observed;
    expect(observed.architectureChanged).toBe(true);
    expect(observed.edges.added).toEqual([{ source: "alpha", target: "beta", type: "static" }]);
  });

  it("case 3 — an undeclared change (edge outside the exhaustive allowlist) is VIOLATION and rejected", async () => {
    const ws = workspace();
    const root = ws.root;
    fx.writeLaw(root, { rows: fx.ALLOW_A_TO_B });
    fx.writeIntent(root, UNDECLARED_ALLOWLIST);
    const c1 = commitBase(ws, { alpha: fx.ALPHA_CLEAN });
    fx.writeIn(root, "libs/alpha/alpha.go", fx.ALPHA_REACHING);
    const c2 = fx.commit(root, "alpha reaches beta (undeclared)");
    const run = await fx.runEvolution(root, fx.evolutionArgs(c1, { head: c2 }));
    const envelope = expectExactly(run, ["CHANGE", "VIOLATION"], { disposition: "rejected" });
    const comparison = envelope.result.transitions[0].comparison;
    // The undeclared dependency is a real introduced finding — not silent.
    expect(comparison.findings.introduced.length).toBeGreaterThan(0);
  });

  it("case 4 — a declared-but-unfulfilled layer constraint is VIOLATION and rejected by the failing declared constraint", async () => {
    const ws = workspace();
    const root = ws.root;
    // The fitness law is present at BOTH revisions; base satisfies it, head's
    // new alpha→beta edge fails the declared layer-dependency constraint.
    fx.writeLaw(root, { rows: fx.ALLOW_A_TO_B, fitness: fitnessForbidsAtoB });
    const c1 = commitBase(ws, { alpha: fx.ALPHA_CLEAN });
    fx.writeIn(root, "libs/alpha/alpha.go", fx.ALPHA_REACHING);
    const c2 = fx.commit(root, "alpha reaches beta (violates the declared constraint)");
    const run = await fx.runEvolution(root, fx.evolutionArgs(c1, { head: c2 }));
    const envelope = expectExactly(run, ["CHANGE", "VIOLATION"], { disposition: "rejected" });
    const comparison = envelope.result.transitions[0].comparison;
    const failed = comparison.fitness.verdictDeltas.filter(
      (delta) => delta.id === "alpha-must-not-reach-beta" && delta.head === "fail",
    );
    expect(failed.length).toBe(1);
    expect(comparison.affected.constraints).toContain("alpha-must-not-reach-beta");
  });

  it("case 5 — an introduced violation (explicitly forbidden edge) is VIOLATION and rejected, never silently clean", async () => {
    const ws = workspace();
    const root = ws.root;
    fx.writeLaw(root, { rows: fx.ALLOW_A_TO_B });
    fx.writeIntent(root, FORBIDDEN_ALPHA_BETA());
    const c1 = commitBase(ws, { alpha: fx.ALPHA_CLEAN });
    fx.writeIn(root, "libs/alpha/alpha.go", fx.ALPHA_REACHING);
    const c2 = fx.commit(root, "alpha reaches beta (forbidden)");
    const run = await fx.runEvolution(root, fx.evolutionArgs(c1, { head: c2 }));
    const envelope = expectExactly(run, ["CHANGE", "VIOLATION"], { disposition: "rejected" });
    const comparison = envelope.result.transitions[0].comparison;
    expect(comparison.findings.introduced.length).toBeGreaterThan(0);
    // The introduced drift finding links the W5 debt ledger: same id.
    expect(comparison.debt.introduced).toEqual(comparison.findings.introduced);
  });
});

describe("evolution lifecycle — lifecycle events", () => {
  it("case 6 — removing the crossing is REPAIR, with the finding resolved and the edge removed", async () => {
    const { root, c1, c3 } = violateThenRepair();
    const eventOut = eventDir(root);
    const run = await fx.runEvolution(root, fx.evolutionArgs(c1, { head: c3, eventOut }));
    const envelope = fx.parseEnvelope(run);
    const events = fx.readEvents(eventOut);
    expect(events.length).toBe(2);
    expect(envelope.result.transitions[1].comparison.classifications).toContain("REPAIR");
    expect(envelope.result.transitions[1].comparison.findings.resolved.length).toBeGreaterThan(0);
    expect(envelope.result.transitions[1].comparison.observed.edges.removed).toEqual([
      { source: "alpha", target: "beta", type: "static" },
    ]);
    expect(envelope.result.transitions[1].comparison.disposition).toBe("accepted");
  });
  it("case 7 — a decision supersession is DECISION_CHANGE, never DRIFT, with the moved decisions named", async () => {
    const ws = workspace();
    const root = ws.root;
    fx.writeLaw(root, { rows: fx.ALLOW_A_TO_B });
    seedSources(root, fx.ALPHA_CLEAN);
    fx.writeAdr(root, "0001-boundary.md", { id: "0001-boundary", status: "accepted" });
    const c1 = fx.commit(root, "base: the acceptance decision recorded");
    // Same law and graph; the decision record is superseded and a new one
    // supersedes it. Only the lineage (and a no-effect line) moved.
    fx.writeAdr(root, "0001-boundary.md", { id: "0001-boundary", status: "superseded" });
    fx.writeAdr(root, "0002-revised.md", {
      id: "0002-revised",
      status: "accepted",
      supersedes: ["0001-boundary"],
    });
    fx.writeIn(
      root,
      "libs/alpha/alpha.go",
      'package alpha\n\nfunc Name() string { return "alpha-v3" }\n',
    );
    const c2 = fx.commit(root, "head: supersede the acceptance decision");
    const run = await fx.runEvolution(root, fx.evolutionArgs(c1, { head: c2 }));
    const envelope = expectExactly(run, ["DECISION_CHANGE"], { disposition: "accepted" });
    // The lineage that moved is named, never hidden behind the DRIFT signal
    // the guard suppresses.
    expect(envelope.result.transitions[0].comparison.affected.decisions).toContain("0001-boundary");
    expect(envelope.result.transitions[0].comparison.classifications).not.toContain("DRIFT");
  });

  it("case 8 — introducing the forbidden edge creates debt: VIOLATION and debt.introduced non-empty", async () => {
    const { root, c1, c2, c3 } = violateThenRepair();
    const eventOut = eventDir(root);
    const run = await fx.runEvolution(root, fx.evolutionArgs(c1, { head: c3, eventOut }));
    const env = fx.parseEnvelope(run);
    const events = timelineOrder(fx.readEvents(eventOut), [c1, c2, c3]);
    // events[0] = C1→C2: the introducing transition.
    expect(env.result.transitions[0].comparison.classifications).toContain("VIOLATION");
    expect(events[0].debt.introduced.length).toBeGreaterThan(0);
    expect(events[0].debt.resolved).toEqual([]);
  });

  it("case 9 — removing the edge resolves debt: the resolving event closes exactly the id introduced", async () => {
    const { root, c1, c2, c3 } = violateThenRepair();
    const eventOut = eventDir(root);
    await fx.runEvolution(root, fx.evolutionArgs(c1, { head: c3, eventOut }));
    const events = timelineOrder(fx.readEvents(eventOut), [c1, c2, c3]);
    // events[1] = C2→C3: the resolving transition.
    expect(events[1].classifications).toContain("REPAIR");
    expect(events[1].debt.resolved.length).toBeGreaterThan(0);
    // Monotonic accounting: resolved set equals the earlier introduced set.
    expect(events[1].debt.resolved).toEqual(events[0].debt.introduced);
    expect(events[1].debt.introduced).toEqual([]);
  });

  it("case 10 — a revert range keeps both transitions with distinct provenance refs and intact edge accounting", async () => {
    const { root, c1, c2, c3 } = violateThenRepair();
    const eventOut = eventDir(root);
    await fx.runEvolution(root, fx.evolutionArgs(c1, { head: c3, eventOut }));
    const events = timelineOrder(fx.readEvents(eventOut), [c1, c2, c3]);
    const refs = (event) => event.provenance.map((ref) => ref.ref);
    // Two retained events, neither overwriting the other.
    expect(events.length).toBe(2);
    expect(new Set(refs(events[0])).size).toBe(2);
    expect(refs(events[1])).not.toEqual(refs(events[0]));
    expect(refs(events[0])).toEqual([c1, c2]);
    expect(refs(events[1])).toEqual([c2, c3]);
    // The revert transition records the removed edge and closes the debt.
    expect(events[1].observed.edges.removed).toEqual([
      { source: "alpha", target: "beta", type: "static" },
    ]);
    expect(events[1].debt.resolved).toEqual(events[0].debt.introduced);
    expect(events[1].debt.introduced).toEqual([]);
  });

  it("case 11 — one commit carrying several disjoint changes is ONE transition with all classifications", async () => {
    const ws = workspace();
    const root = ws.root;
    // A third declared layer so the allowed and forbidden facts are disjoint
    // and both are readable: replace the two-project model with a three-project
    // one (alpha → beta forbidden by intent, alpha → gamma permitted by law).
    fx.writeIn(
      root,
      "archkeep.json",
      `${JSON.stringify(
        {
          projects: {
            declared: [
              { root: "libs/alpha", name: "alpha", tags: ["layer:a"] },
              { root: "libs/beta", name: "beta", tags: ["layer:b"] },
              { root: "libs/gamma", name: "gamma", tags: ["layer:c"] },
            ],
          },
          coverage: {
            exempt: [{ path: "module-boundaries.config.mjs", reason: "the workspace's own law" }],
          },
        },
        null,
        2,
      )}\n`,
    );
    fx.writeIn(root, "libs/gamma/go.mod", "module example.com/gamma\n\ngo 1.22\n");
    fx.writeIn(
      root,
      "libs/gamma/gamma.go",
      'package gamma\n\nfunc Suffix() string { return "-gamma" }\n',
    );
    fx.writeLaw(root, {
      rows: `  { sourceTag: "layer:a", onlyDependOnLibsWithTags: ["layer:b", "layer:c"] },`,
    });
    fx.writeIntent(root, FORBIDDEN_ALPHA_BETA());
    fx.writeIn(root, "libs/beta/beta.go", fx.BETA);
    fx.writeIn(root, "libs/alpha/alpha.go", fx.ALPHA_CLEAN);
    const c1 = fx.commit(root, "base: three layers, no edges");
    // One commit reaches BOTH the allowed gamma and the forbidden beta.
    const reachBoth = [
      "package alpha",
      "",
      "import (",
      '\t"example.com/beta"',
      '\t"example.com/gamma"',
      ")",
      "",
      'func Name() string { return "alpha" + beta.Suffix() + gamma.Suffix() }',
    ].join("\n");
    fx.writeIn(root, "libs/alpha/alpha.go", reachBoth);
    const c2 = fx.commit(root, "alpha reaches gamma and beta in one commit");
    const run = await fx.runEvolution(root, fx.evolutionArgs(c1, { head: c2 }));
    const envelope = fx.parseEnvelope(run);
    expect(envelope.result.transitions.length).toBe(1);
    const classification = envelope.result.transitions[0].comparison.classifications;
    // Both the permitted edge (CHANGE) and the forbidden one (VIOLATION) are
    // reported on the single transition — none folded away.
    expect(classification).toContain("CHANGE");
    expect(classification).toContain("VIOLATION");
    expect(envelope.result.transitions[0].comparison.disposition).toBe("rejected");
  });

  it("case 12 — a partial/unverifiable revision fails loudly (exit 3) instead of reporting a shortened history", async () => {
    const ws = workspace();
    const root = ws.root;
    fx.writeLaw(root, { rows: fx.ALLOW_A_TO_B });
    const c1 = commitBase(ws, { alpha: fx.ALPHA_CLEAN });
    // A whole-file Go parse failure: an unterminated import, EOF at line 3.
    fx.writeIn(root, "libs/alpha/alpha.go", 'package alpha\n\nimport "example.com/beta');
    const c2 = fx.commit(root, "a broken revision");
    void c2;
    fx.writeIn(root, "libs/alpha/alpha.go", fx.ALPHA_CLEAN);
    const c3 = fx.commit(root, "recovered revision");
    const eventOut = eventDir(root);
    const run = await fx.runEvolution(root, fx.evolutionArgs(c1, { head: c3, eventOut }));
    // The run refuses the under-represented history rather than claiming clean.
    expect(run.exitCode).toBe(fx.EXIT.error);
    expect(run.out).toBe("");
    expect(run.err).toMatch(/cannot be analyzed completely/u);
  });

  it("case 13 — a base/head policy mismatch is disclosed and judged under the current (head) law", async () => {
    const ws = workspace();
    const root = ws.root;
    // Base law permits alpha→beta; head law adds a fitness row forbidding it.
    fx.writeLaw(root, { rows: fx.ALLOW_A_TO_B });
    fx.writeIn(root, "libs/beta/beta.go", fx.BETA);
    fx.writeIn(root, "libs/alpha/alpha.go", fx.ALPHA_REACHING);
    const c1 = fx.commit(root, "base: alpha reaches beta under a permissive law");
    fx.writeLaw(root, { rows: fx.ALLOW_A_TO_B, fitness: fitnessForbidsAtoB });
    const c2 = fx.commit(root, "head: declare the constraint that forbids the existing edge");
    const run = await fx.runEvolution(root, fx.evolutionArgs(c1, { head: c2 }));
    const envelope = fx.parseEnvelope(run);
    const comparison = envelope.result.transitions[0].comparison;
    // The policy moved between the two revisions, and it is disclosed.
    expect(comparison.observed.policyChanged).toBe(true);
    expect(comparison.notes.join("\n")).toContain(
      "policy (the declared architectural intent) changed between these snapshots",
    );
    // The existing edge is judged under the CURRENT (head) law: rejected, not
    // silently clean under the permissive base law.
    expect(comparison.disposition).toBe("rejected");
    expect(comparison.classifications).toContain("VIOLATION");
  });
});

describe("evolution lifecycle — invariants", () => {
  it("invariant — identical base/head into the same event dir is idempotent: one file, same id, duplicate flag", async () => {
    const ws = workspace();
    const root = ws.root;
    fx.writeLaw(root, { rows: fx.ALLOW_A_TO_B });
    const c1 = commitBase(ws, { alpha: fx.ALPHA_CLEAN });
    fx.writeIn(root, "libs/alpha/alpha.go", fx.ALPHA_REACHING);
    const c2 = fx.commit(root, "alpha reaches beta (permitted)");
    const eventOut = eventDir(root);
    const first = fx.parseEnvelope(
      await fx.runEvolution(root, fx.evolutionArgs(c1, { head: c2, eventOut })),
    );
    const second = fx.parseEnvelope(
      await fx.runEvolution(root, fx.evolutionArgs(c1, { head: c2, eventOut })),
    );
    const firstWrite = first.result.transitions[0].eventWrite;
    const secondWrite = second.result.transitions[0].eventWrite;
    expect(firstWrite.duplicate).toBe(false);
    expect(secondWrite.duplicate).toBe(true);
    expect(secondWrite.id).toBe(firstWrite.id);
    expect(secondWrite.id).toMatch(/^[0-9a-f]{64}$/u);
    // The same single event file persists across both runs — never duplicated —
    // and it is the one whose id both runs reported.
    const stored = fx.readEvents(eventOut);
    expect(stored.length).toBe(1);
    expect(stored[0].id).toBe(firstWrite.id);
  });

  it("invariant — a repair range is monotonic: both events retained, active debt strictly decreases", async () => {
    const { root, c1, c2, c3 } = violateThenRepair();
    const eventOut = eventDir(root);
    await fx.runEvolution(root, fx.evolutionArgs(c1, { head: c3, eventOut }));
    const events = timelineOrder(fx.readEvents(eventOut), [c1, c2, c3]);
    // Both transitions survive in the store — history is never deleted.
    expect(events.length).toBe(2);
    expect(fx.eventFiles(eventOut).length).toBe(2);
    // The debt introduced by C1→C2 is fully closed by C2→C3; nothing lingers.
    expect(events[0].debt.introduced.length).toBeGreaterThan(0);
    expect(events[1].debt.resolved).toEqual(events[0].debt.introduced);
    expect(events[1].debt.introduced).toEqual([]);
  });
});

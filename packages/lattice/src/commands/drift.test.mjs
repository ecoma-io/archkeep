import { describe, expect, it, vi } from "vitest";

import { loadIntent } from "../architecture-intent/model.mjs";
import { buildObserved, driftCommand, driftForCheck, refuseIncompleteGraph } from "./drift.mjs";

// The intent is loaded through an overridable seam, so the command paths below
// drive the real judge over an in-memory canonical intent — exactly as
// `diff.test.mjs` drives its baseline reader. Nothing here touches disk or
// mounts a provider.
vi.mock("./provenance.mjs", () => ({ resolveProvenance: vi.fn(() => "mock-provenance") }));
vi.mock("../report/json.mjs", () => ({
  jsonEnvelope: (input) => input,
  renderJson: (input) => JSON.stringify(input),
}));

/** A CommandContext shaped like `resolveCommandContext` produces. */
function commandContext(overrides = {}) {
  return {
    root: "/workspace",
    provider: "native",
    marker: "lattice.json",
    tracked: ["lattice.json", "architecture-intent.json"],
    graph: {
      nodes: {
        core: { name: "core", data: { root: "libs/core", tags: ["type-package"] } },
        app: { name: "app", data: { root: "apps/app", tags: ["type-application"] } },
      },
      dependencies: {
        core: [{ source: "core", target: "app", type: "static" }],
      },
    },
    analysis: {
      analyzed: 3,
      imports: [{ sourceFile: "libs/core/main.go", specifier: "app", line: 1, column: 1 }],
      failures: [],
    },
    pluginGap: { registered: true, manifests: [] },
    ...overrides,
  };
}

/** A normalized canonical intent model, minimally filled. */
const intent = (overrides = {}) => ({
  version: "1",
  boundaries: [],
  allowed: [],
  forbidden: [],
  projects: undefined,
  dependencies: undefined,
  forbiddenTags: [],
  ...overrides,
});

/** `io.loadIntentOverride` returning a ready intent. */
const ioWithIntent = (model) => ({ loadIntentOverride: async () => model });

describe("drift's observed model", () => {
  it("drops edges whose target is not a project in the model (external packages)", () => {
    const { projects, edges, implicitEdges } = buildObserved(
      commandContext({
        graph: {
          nodes: {
            app: { name: "app", data: { root: "apps/app", tags: [] } },
            lib: { name: "lib", data: { root: "libs/lib", tags: [] } },
          },
          dependencies: {
            app: [
              { source: "app", target: "lib", type: "static" },
              { source: "app", target: "npm:lodash", type: "static" },
            ],
          },
        },
      }),
    );
    expect(projects.map((p) => p.name)).toEqual(["app", "lib"]);
    // The npm: external edge never enters drift's model — an external package
    // is not a project an intent row can name.
    expect(edges).toEqual([{ source: "app", target: "lib", type: "static" }]);
    expect(implicitEdges).toBe(0);
  });

  it("drops an edge whose source is not a project in the model", () => {
    const { edges } = buildObserved(
      commandContext({
        graph: {
          nodes: {
            lib: { name: "lib", data: { root: "libs/lib", tags: [] } },
          },
          dependencies: {
            orphan: [{ source: "orphan", target: "lib", type: "static" }],
            lib: [{ source: "lib", target: "orphan", type: "static" }],
          },
        },
      }),
    );
    expect(edges).toEqual([]);
  });

  it("counts implicit edges separately and excludes them from the observed set", () => {
    const { edges, implicitEdges } = buildObserved(
      commandContext({
        graph: {
          nodes: {
            a: { name: "a", data: { root: "apps/a", tags: [] } },
            b: { name: "b", data: { root: "libs/b", tags: [] } },
          },
          dependencies: {
            a: [{ source: "a", target: "b", type: "implicit" }],
          },
        },
      }),
    );
    expect(edges).toEqual([]);
    expect(implicitEdges).toBe(1);
  });
});

describe("refuseIncompleteGraph", () => {
  it("does not refuse a native workspace with manifests", () => {
    expect(() =>
      refuseIncompleteGraph(
        commandContext({
          provider: "native",
          pluginGap: { registered: false, manifests: ["libs/core/go.mod"] },
        }),
      ),
    ).not.toThrow();
  });

  it("does not refuse an Nx workspace that is complete without the plugin", () => {
    expect(() =>
      refuseIncompleteGraph(
        commandContext({
          provider: "nx",
          marker: "nx.json",
          pluginGap: { registered: false, manifests: [] },
        }),
      ),
    ).not.toThrow();
  });

  it("refuses an Nx workspace with polyglot manifests and the plugin unregistered", () => {
    expect(() =>
      refuseIncompleteGraph(
        commandContext({
          provider: "nx",
          marker: "nx.json",
          pluginGap: { registered: false, manifests: ["libs/core/go.mod"] },
        }),
      ),
    ).toThrow(/refusing to judge drift/);
  });
});

describe("driftCommand", () => {
  it("reports no drift when the intent matches, and names the comparison facts", async () => {
    const result = await driftCommand(
      commandContext({
        graph: {
          nodes: {
            core: { name: "core", data: { root: "libs/core", tags: ["type-package"] } },
          },
          dependencies: {},
        },
      }),
      ioWithIntent(
        intent({
          boundaries: [{ name: "packages", match: ["tag:type-package"] }],
          projects: { required: [{ name: "core", tags: ["type-package"] }] },
        }),
      ),
    );
    expect(result.status).toBe("ok");
    expect(result.drift.intent.file).toBe("architecture-intent.json");
    expect(result.drift.findings).toEqual([]);
    expect(result.report.text).toContain("✔ no drift");
  });

  it("reports drift findings for a forbidden dependency and presence rules", async () => {
    const result = await driftCommand(
      commandContext(),
      ioWithIntent(
        intent({
          boundaries: [
            { name: "packages", match: ["tag:type-package"] },
            { name: "apps", match: ["tag:type-application"] },
          ],
          forbidden: [{ from: "packages", to: "apps", reason: "the engine must not reach out" }],
          projects: { required: [{ name: "ghost", tags: [] }], forbidden: [{ name: "core" }] },
        }),
      ),
    );
    expect(result.status).toBe("ok");
    const rules = result.drift.findings.map((f) => f.rule).sort();
    expect(rules).toContain("intentForbiddenEdge");
    expect(rules).toContain("projectMissing");
    expect(rules).toContain("projectPresent");
    expect(result.report.text).toContain("3 drift findings");
  });

  it("never reports a finding derived from the edge the report's own header calls excluded (P1-11)", async () => {
    // `core`'s only edge to `app` is `implicit` — a build-ordering
    // declaration, not a real import — and the forbidden row below spans
    // exactly that pair. Before the fix, `buildObserved`'s count correctly
    // excluded the edge while `judgeIntent` still judged it from the raw
    // graph, so the report's "N implicit edges excluded" line and a finding
    // derived from that very edge appeared on adjacent lines, contradicting
    // each other. The whole tree carries zero non-implicit edges, so a clean
    // verdict here is the only claim that agrees with what the report states
    // it looked at.
    const result = await driftCommand(
      commandContext({
        graph: {
          nodes: {
            core: { name: "core", data: { root: "libs/core", tags: ["type-package"] } },
            app: { name: "app", data: { root: "apps/app", tags: ["type-application"] } },
          },
          dependencies: {
            core: [{ source: "core", target: "app", type: "implicit" }],
          },
        },
      }),
      ioWithIntent(
        intent({
          boundaries: [
            { name: "packages", match: ["tag:type-package"] },
            { name: "apps", match: ["tag:type-application"] },
          ],
          forbidden: [{ from: "packages", to: "apps", reason: "the engine must not reach out" }],
        }),
      ),
    );
    expect(result.drift.observed.edges).toBe(0);
    expect(result.drift.observed.implicitEdges).toBe(1);
    expect(result.drift.findings).toEqual([]);
    expect(result.report.text).toContain("(1 implicit edge excluded)");
    expect(result.report.text).toContain("✔ no drift");
    expect(result.report.text).not.toContain("intentForbiddenEdge");
    expect(result.report.text).not.toContain("finding");
  });

  it("does not let an allowed row be satisfied by a build-ordering declaration alone (P1-11)", async () => {
    // The only edge from `app` to `core` is `implicit`. An `allowed` row
    // declares an architecture statement the team intends to BUILD — a
    // dependency declared only for build ordering is not that, so the row
    // must still report `intentAllowedMissing` rather than reading as held.
    const result = await driftCommand(
      commandContext({
        graph: {
          nodes: {
            core: { name: "core", data: { root: "libs/core", tags: ["type-package"] } },
            app: { name: "app", data: { root: "apps/app", tags: ["type-application"] } },
          },
          dependencies: {
            app: [{ source: "app", target: "core", type: "implicit" }],
          },
        },
      }),
      ioWithIntent(
        intent({
          boundaries: [
            { name: "packages", match: ["tag:type-package"] },
            { name: "apps", match: ["tag:type-application"] },
          ],
          allowed: [{ from: "apps", to: "packages" }],
        }),
      ),
    );
    expect(result.drift.observed.edges).toBe(0);
    expect(result.drift.observed.implicitEdges).toBe(1);
    expect(result.drift.findings).toHaveLength(1);
    expect(result.drift.findings[0].rule).toBe("intentAllowedMissing");
    expect(result.report.text).toContain(
      "1 finding: dependencies the intended architecture allows are not being built",
    );
  });

  it("shows an optional-and-unbuilt allowed row's coverage note in the text report (bug B)", async () => {
    // `judgeIntent` pushes this onto `verdict.notes` — a documentation fact,
    // never a drift finding. Before this fix, `driftCommand`'s own call to
    // `formatDriftReport` never forwarded `notes`, so the warning reached
    // `coverage.notes` in the JSON envelope (and `check`'s equivalent text
    // face, via `driftForCheck`) but never this command's own `report.text` —
    // a silent gap between the two faces of the identical fact.
    const result = await driftCommand(
      commandContext({
        graph: {
          nodes: {
            core: { name: "core", data: { root: "libs/core", tags: ["type-package"] } },
            app: { name: "app", data: { root: "apps/app", tags: ["type-application"] } },
          },
          dependencies: {},
        },
      }),
      ioWithIntent(
        intent({
          boundaries: [
            { name: "packages", match: ["tag:type-package"] },
            { name: "apps", match: ["tag:type-application"] },
          ],
          allowed: [{ from: "apps", to: "packages", optional: true }],
        }),
      ),
    );
    expect(result.drift.findings).toEqual([]);
    const note =
      'optional allowed intent "apps" → "packages" is not yet observed — aspirational, not drift';
    expect(result.coverage.notes).toEqual([note]);
    expect(result.report.text).toContain(note);
    expect(result.report.text).toContain("✔ no drift");
  });

  it("refuses over incomplete coverage — every 'project missing' would be ambiguous", async () => {
    await expect(
      driftCommand(
        commandContext({
          analysis: {
            analyzed: 3,
            imports: [],
            failures: [
              {
                sourceFile: "libs/core/main.go",
                reason: "not a whole-file failure",
                line: 1,
                column: 1,
              },
              {
                sourceFile: "libs/app/app.go",
                reason: "unreadable file",
                line: null,
              },
            ],
          },
        }),
        ioWithIntent(intent()),
      ),
    ).rejects.toThrow(/drift has incomplete coverage/);
  });

  it("refuses when no tracked intent file is present — drift is about a declared intent", async () => {
    // The load override returning undefined plays the real `loadIntent`'s
    // answer when `architecture-intent.json` is not tracked: the loader
    // treats an untracked file as absent, and a workspace with no declared
    // intent cannot be judged for drift.
    await expect(
      driftCommand(commandContext(), { loadIntentOverride: async () => undefined }),
    ).rejects.toThrow(/drift requires a tracked architecture-intent\.json/);
  });

  it("never wires the ADR registry when no row carries a decisionRef", async () => {
    const readAdrContextOverride = vi.fn();
    const result = await driftCommand(commandContext(), {
      ...ioWithIntent(
        intent({
          boundaries: [{ name: "packages", match: ["tag:type-package"] }],
        }),
      ),
      readAdrContextOverride,
    });
    expect(result.report.text).not.toContain("decisionRef");
    expect(readAdrContextOverride).not.toHaveBeenCalled();
  });

  // P1-02: `resolveDecisionRef` (`../governance/adr-registry.mjs`) had zero
  // production call sites — a row's `decisionRef` passed through every
  // report unverified. This is the silent-direction repro the finding names:
  // a nonexistent ADR id must be named, not silently treated as legitimate.
  describe("decisionRef resolution — a documentation fact, never a drift finding (P1-02)", () => {
    it("names an intent row whose decisionRef resolves to no known ADR, rule, or fitness record", async () => {
      const result = await driftCommand(commandContext(), {
        ...ioWithIntent(
          intent({
            boundaries: [{ name: "packages", match: ["tag:type-package"] }],
            projects: {
              required: [
                { name: "core", tags: ["type-package"], decisionRef: "9999-does-not-exist" },
              ],
            },
          }),
        ),
        readAdrContextOverride: () => ({ records: [], byId: new Map(), knownFitness: new Set() }),
      });
      // Not a finding: the row is satisfied (core exists), so drift itself
      // stays clean — the unresolved citation is a SEPARATE fact.
      expect(result.drift.findings).toEqual([]);
      expect(result.status).toBe("ok");
      expect(result.drift.unresolvedDecisionRefs).toEqual([
        { kind: "projects.required[0]", decisionRef: "9999-does-not-exist" },
      ]);
      expect(result.report.text).toContain('projects.required[0] — "9999-does-not-exist"');
      expect(result.report.text).toContain(
        "does not resolve to a known ADR, rule, or fitness record",
      );
    });

    // The deferred boundary-policy failure, pinned in BOTH directions. Measured
    // before the fix: a native workspace with a valid `architecture-intent.json`
    // and no `module-boundaries.config.mjs` exited 3 from `drift` while
    // `reconcile` and `discover` over the identical tree exited 0 — a fifth
    // refusal on top of the four `docs/usage/drift.md` documents, fired by a law
    // whose only reader is the non-verdict decisionRef axis below.
    describe("the boundary-policy load failure is deferred to the axis that reads it", () => {
      it("reaches a drift verdict when no row cites anything, even though the policy would not load", async () => {
        const configError = new Error("lattice: cannot load module-boundaries.config.mjs");
        const result = await driftCommand(commandContext(), {
          ...ioWithIntent(
            intent({ boundaries: [{ name: "packages", match: ["tag:type-package"] }] }),
          ),
          config: null,
          configError,
        });
        // The law was never opened, so its absence decides nothing here.
        expect(result.status).toBe("ok");
        expect(result.drift.findings).toEqual([]);
        // But it is not swallowed either: a run that noticed the failure and
        // said nothing would be the posture this tool refuses. Both faces, so
        // a reader of the terminal report learns what a reader of the envelope
        // does.
        expect(result.coverage.notes.join(" ")).toContain(
          "boundary law could not be loaded (lattice: cannot load module-boundaries.config.mjs)",
        );
        expect(result.report.text).toContain("boundary law could not be loaded");
      });

      it("still refuses loudly when a row DOES cite something — an unread law must not resolve citations", async () => {
        // The silent-direction repro for the deferral: swallowing the error
        // would hand `declaredFitnessNames` an empty set, and a citation naming
        // a fitness id the law really declares would be reported unresolved on
        // the strength of a law nobody read.
        const configError = new Error("lattice: cannot load module-boundaries.config.mjs");
        const readAdrContextOverride = vi.fn();
        await expect(
          driftCommand(commandContext(), {
            ...ioWithIntent(
              intent({
                boundaries: [{ name: "packages", match: ["tag:type-package"] }],
                projects: {
                  required: [{ name: "core", tags: ["type-package"], decisionRef: "F-01" }],
                },
              }),
            ),
            config: null,
            configError,
            readAdrContextOverride,
          }),
        ).rejects.toThrow(/cannot load module-boundaries\.config\.mjs/);
        // Thrown BEFORE the registry read, so no half-resolved citation set can
        // reach a report.
        expect(readAdrContextOverride).not.toHaveBeenCalled();
      });
    });

    it("states a positive line, never silence, when every citation resolves", async () => {
      // Silence here would be indistinguishable from a workspace that never
      // uses decisionRef at all — the same "no fact, no claim" split
      // `formatGoWork` makes for its own axis.
      const result = await driftCommand(commandContext(), {
        ...ioWithIntent(
          intent({
            boundaries: [{ name: "packages", match: ["tag:type-package"] }],
            projects: {
              required: [{ name: "core", tags: ["type-package"], decisionRef: "0001-real" }],
            },
          }),
        ),
        readAdrContextOverride: () => ({
          records: [],
          byId: new Map([["0001-real", {}]]),
          knownFitness: new Set(),
        }),
      });
      expect(result.drift.unresolvedDecisionRefs).toBeUndefined();
      expect(result.report.text).toContain(
        "✔ every decisionRef citation (1) resolves to a known ADR, rule, or fitness record",
      );
    });
  });

  it("refuses when a boundary or row side matched no observed project — 'cannot verify' must not read as 'no drift'", async () => {
    // The empty-result invariant's drift face: a boundary whose selectors
    // match no observed project is a no-verdict in `check` (exit 3). The
    // descriptive command must refuse loudly too — "✔ no drift" over an
    // unmatched boundary would claim a clean comparison the run never made.
    await expect(
      driftCommand(
        commandContext({
          graph: {
            nodes: {
              core: { name: "core", data: { root: "libs/core", tags: ["type-package"] } },
            },
            dependencies: {},
          },
        }),
        ioWithIntent(
          intent({
            boundaries: [
              { name: "packages", match: ["tag:type-package"] },
              { name: "apps", match: ["tag:type-app"] }, // matches no project
            ],
          }),
        ),
      ),
    ).rejects.toThrow(/boundary\/row apps: matches no observed project/);
  });
});

describe("driftForCheck — the check fold", () => {
  it("judges the workspace's declared intent against the observed graph", async () => {
    const verdict = await driftForCheck(
      commandContext(),
      ioWithIntent(
        intent({
          boundaries: [
            { name: "packages", match: ["tag:type-package"] },
            { name: "apps", match: ["tag:type-application"] },
          ],
          forbidden: [{ from: "packages", to: "apps", reason: "the engine must not reach out" }],
        }),
      ),
    );
    expect(verdict.intent.file).toBe("architecture-intent.json");
    expect(verdict.observed.projects).toBe(2);
    expect(verdict.observed.edges).toBe(1);
    expect(verdict.findings.some((f) => f.rule === "intentForbiddenEdge")).toBe(true);
  });

  it("carries the judged boundaries and unused-resolved list for the report layer", async () => {
    const verdict = await driftForCheck(
      commandContext(),
      ioWithIntent(
        intent({
          boundaries: [{ name: "packages", match: ["tag:type-package"] }],
        }),
      ),
    );
    expect(verdict.boundaries).toEqual([{ name: "packages", projects: ["core"] }]);
    expect(verdict.unresolved).toEqual([]);
    expect(verdict.notes).toEqual([]);
  });

  it("resolves a quiet, empty result when no architecture-intent.json is tracked, rather than judging an absent intent", async () => {
    // P1-14 regression: `judgeIntent` assumes a normalized model and
    // dereferences `intent.boundaries` unconditionally — calling it with
    // `undefined` (what `loadIntent` returns for "file not tracked") threw a
    // raw `TypeError: Cannot read properties of undefined (reading
    // 'boundaries')`. `driftForCheck` must recognize the absence itself,
    // before ever reaching `judgeIntent`, and return a quiet result instead —
    // `intent: undefined` on the return is the signal that lets
    // `../commands/fitness.mjs`'s `fitnessCommand` call this UNCONDITIONALLY
    // (it must still reach the `refuseIncompleteGraph` guard above whether or
    // not intent is declared) without crashing on a workspace that
    // legitimately has no intent file — the supported configuration where
    // fitness lives in the policy file alone.
    const verdict = await driftForCheck(commandContext({ tracked: ["lattice.json"] }), {
      loadIntentOverride: async () => undefined,
    });
    expect(verdict.intent).toBeUndefined();
    expect(verdict.findings).toEqual([]);
    expect(verdict.unresolved).toEqual([]);
    expect(verdict.boundaries).toEqual([]);
    expect(verdict.notes).toEqual([]);
    // The observed side is still computed — absence of an intent says nothing
    // about whether the graph itself was read.
    expect(verdict.observed.projects).toBe(2);
  });

  // The other side of that same quiet result, and the reason it must stay
  // narrow. The real `loadIntent` is driven here (only its `read` seam is
  // injected) over a tree where `architecture-intent.json` IS tracked and its
  // bytes are not there — a dangling symlink, a sparse checkout, an
  // uninitialised submodule. Folded into "absent", this returns the same
  // quiet result as the case above, which `../../cli.mjs` renders as
  // `intent: {checked: true, verdict: "ok", findings: []}` — a verified claim
  // about a file nobody read. It must reach no verdict instead.
  it("refuses a tracked architecture-intent.json whose bytes are absent, rather than folding it to the quiet result", async () => {
    const enoent = Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    await expect(
      driftForCheck(commandContext(), {
        loadIntentOverride: (root) =>
          loadIntent(root, {
            tracked: ["lattice.json", "architecture-intent.json"],
            read: async () => {
              throw enoent;
            },
          }),
      }),
    ).rejects.toThrow(/is tracked but could not be read/);
  });
});

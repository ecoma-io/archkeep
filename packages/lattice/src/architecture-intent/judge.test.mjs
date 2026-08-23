import { describe, expect, it } from "vitest";

import { INTENT_MESSAGE_IDS, judgeIntent } from "./judge.mjs";

/**
 * A project graph in the provider-neutral shape every command receives. Only
 * `nodes` and `dependencies` matter to the judge; each node carries its tags
 * under `data`, the same shape the selector engine reads.
 *
 * @param {Record<string, {data?: {root?: string, tags?: string[]}}>} nodes
 * @param {Record<string, Array<{target: string, type?: string}>>} [dependencies]
 */
const graph = (nodes, dependencies = {}) => ({ nodes, dependencies });

const intent = (overrides = {}) => ({
  version: "1",
  boundaries: [{ name: "packages", match: ["tag:type-package"] }],
  allowed: [],
  forbidden: [],
  ...overrides,
});

/** @param {string[]} tags @returns {{data: {tags: string[]}}} */
const node = (tags) => ({ data: { tags } });
const pkgs = { core: node(["type-package"]), ui: node(["type-package"]) };
const exts = { site: node(["type-extension"]) };

describe("judgeIntent — forbidden on populated sides", () => {
  const declared = intent({
    boundaries: [
      { name: "packages", match: ["tag:type-package"] },
      { name: "extensions", match: ["tag:type-extension"] },
    ],
    forbidden: [{ from: "packages", to: "extensions", reason: "the engine must not reach out" }],
  });

  it("reports a forbidden DIRECT edge as an intentForbiddenEdge finding", () => {
    const result = judgeIntent(
      declared,
      graph({ ...pkgs, site: exts.site }, { core: [{ target: "site" }] }),
    );
    expect(result.verdict).toBe("findings");
    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings;
    expect(finding.rule).toBe("intentForbiddenEdge");
    expect(finding.source).toBe("core");
    expect(finding.target).toBe("site");
    expect(finding.boundaryFrom).toBe("packages");
    expect(finding.boundaryTo).toBe("extensions");
  });

  it("reports a forbidden relationship that holds only TRANSITIVELY — A→C→B — with the witness path", () => {
    // engine (packages) → util (extensions) is forbidden; the observed graph
    // has no direct edge, only engine → broker → util.
    const nodes = {
      engine: node(["type-package"]),
      broker: node(["type-package"]),
      util: node(["type-extension"]),
    };
    const result = judgeIntent(
      declared,
      graph(nodes, { engine: [{ target: "broker" }], broker: [{ target: "util" }] }),
    );
    expect(result.verdict).toBe("findings");
    const [finding] = result.findings;
    expect(finding.rule).toBe("intentForbiddenEdge");
    expect(finding.source).toBe("broker");
    expect(finding.target).toBe("util");
    expect(finding.message).toContain("→");
  });

  it("is clean when both sides are populated and no path connects them", () => {
    const result = judgeIntent(
      declared,
      graph({ ...pkgs, site: exts.site }, { core: [{ target: "ui" }] }),
    );
    expect(result.verdict).toBe("ok");
    expect(result.findings).toEqual([]);
  });
});

describe("judgeIntent — allowed", () => {
  const both = intent({
    boundaries: [
      { name: "packages", match: ["tag:type-package"] },
      { name: "extensions", match: ["tag:type-extension"] },
    ],
    allowed: [{ from: "extensions", to: "packages" }],
  });

  it("is clean when the allowed edge is observed", () => {
    const result = judgeIntent(
      both,
      graph({ ...pkgs, site: exts.site }, { site: [{ target: "core" }] }),
    );
    expect(result.verdict).toBe("ok");
    expect(result.findings).toEqual([]);
  });

  it("reports an allowed row with no observed edge as intentAllowedMissing", () => {
    const result = judgeIntent(both, graph({ ...pkgs, site: exts.site }, {}));
    expect(result.verdict).toBe("findings");
    const [finding] = result.findings;
    expect(finding.rule).toBe("intentAllowedMissing");
    expect(finding.source).toBe("site");
    expect(finding.target).toBe("core");
  });

  it("demotes an optional allowed row's absence to a coverage note, not a finding", () => {
    const withOptional = intent({
      boundaries: both.boundaries,
      allowed: [{ from: "extensions", to: "packages", optional: true }],
    });
    const result = judgeIntent(withOptional, graph({ ...pkgs, site: exts.site }, {}));
    expect(result.verdict).toBe("ok");
    expect(result.findings).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("optional");
  });

  it("holds vacuously when from and to resolve to the same single member — nothing to miss", () => {
    const oneProject = intent({
      boundaries: [{ name: "app", match: ["name:site"] }],
      allowed: [{ from: "app", to: "app" }],
    });
    const result = judgeIntent(oneProject, graph({ site: exts.site }, {}));
    expect(result.verdict).toBe("ok");
    expect(result.findings).toEqual([]);
  });
});

describe("judgeIntent — implicit edges are excluded, matching drift's own exclusion (P1-11)", () => {
  // `../../src/commands/drift.mjs`'s `buildObserved` drops `implicit`-typed
  // edges (a build-ordering declaration, not a dependency derived from code)
  // and reports how many it excluded. Before this fix, `judgeIntent` read
  // `graph.dependencies` directly and never applied that same exclusion, so a
  // drift report could claim "N implicit edges excluded" on one line and show
  // a finding derived from exactly one of them on the next — and, in the
  // other direction, an `allowed` row could read as satisfied from nothing
  // but a build-ordering declaration, with no real dependency ever observed.
  // These cases pin both directions at the judge itself, the root cause both
  // symptoms share.
  const declared = intent({
    boundaries: [
      { name: "packages", match: ["tag:type-package"] },
      { name: "extensions", match: ["tag:type-extension"] },
    ],
    forbidden: [{ from: "packages", to: "extensions", reason: "the engine must not reach out" }],
  });

  it("does not report a forbidden row violated only by a direct implicit edge", () => {
    const result = judgeIntent(
      declared,
      graph({ ...pkgs, site: exts.site }, { core: [{ target: "site", type: "implicit" }] }),
    );
    expect(result.verdict).toBe("ok");
    expect(result.findings).toEqual([]);
  });

  it("does not treat a transitive path through an implicit hop as closing a forbidden path", () => {
    // engine (packages) → util (extensions) is forbidden. The only path is
    // engine → broker (real) → util (implicit) — the SAME shape the
    // "violated only TRANSITIVELY" test above pins for a real edge, but the
    // last hop here is a declaration, not code, so no path should be found.
    const nodes = {
      engine: node(["type-package"]),
      broker: node(["type-package"]),
      util: node(["type-extension"]),
    };
    const result = judgeIntent(
      declared,
      graph(nodes, {
        engine: [{ target: "broker", type: "static" }],
        broker: [{ target: "util", type: "implicit" }],
      }),
    );
    expect(result.verdict).toBe("ok");
    expect(result.findings).toEqual([]);
  });

  it("reports intentAllowedMissing when the only observed edge is implicit — an allowed row is not satisfied by a build-ordering declaration", () => {
    const both = intent({
      boundaries: [
        { name: "packages", match: ["tag:type-package"] },
        { name: "extensions", match: ["tag:type-extension"] },
      ],
      allowed: [{ from: "extensions", to: "packages" }],
    });
    const result = judgeIntent(
      both,
      graph({ ...pkgs, site: exts.site }, { site: [{ target: "core", type: "implicit" }] }),
    );
    expect(result.verdict).toBe("findings");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].rule).toBe("intentAllowedMissing");
    expect(result.findings[0].source).toBe("site");
    expect(result.findings[0].target).toBe("core");
  });

  it("does not report dependencyForbidden for an edge that is only declared, never imported", () => {
    const result = judgeIntent(
      intent({ dependencies: { forbidden: [{ source: "core", target: "site" }] } }),
      graph({ ...pkgs, site: exts.site }, { core: [{ target: "site", type: "implicit" }] }),
    );
    expect(result.verdict).toBe("ok");
    expect(result.findings).toEqual([]);
  });

  it("does not report dependencyNotAllowed for an observed-only-implicit edge outside the allowlist", () => {
    const result = judgeIntent(
      intent({ dependencies: { allowed: [{ source: "core", target: "ui" }] } }),
      graph({ ...pkgs, site: exts.site }, { core: [{ target: "site", type: "implicit" }] }),
    );
    expect(result.verdict).toBe("ok");
    expect(result.findings).toEqual([]);
  });

  it("does not report tagDependencyForbidden for an implicit-only edge crossing the forbidden tag pair", () => {
    const result = judgeIntent(
      intent({ forbiddenTags: [{ from: "type-package", to: "type-extension" }] }),
      graph({ ...pkgs, site: exts.site }, { core: [{ target: "site", type: "implicit" }] }),
    );
    expect(result.verdict).toBe("ok");
    expect(result.findings).toEqual([]);
  });
});

describe("judgeIntent — zero-member boundaries", () => {
  it("renders a no-verdict, not a clean verdict, when a boundary matches no project", () => {
    const result = judgeIntent(
      intent({ boundaries: [{ name: "apps", match: ["tag:type-app"] }] }),
      graph(pkgs),
    );
    expect(result.verdict).toBe("no-verdict");
    expect(result.findings).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].boundary).toBe("apps");
  });

  it("renders a no-verdict when a ROW side resolves to no project", () => {
    const result = judgeIntent(
      intent({
        boundaries: [{ name: "packages", match: ["tag:type-package"] }],
        forbidden: [{ from: "packages", to: "tag:type-app", reason: "x" }],
      }),
      graph(pkgs),
    );
    expect(result.verdict).toBe("no-verdict");
    expect(result.unresolved).toHaveLength(1);
  });

  it("renders a no-verdict on a forbidden row that resolves both sides to ONE project — a self-ban that can never fire", () => {
    // The load-provable spellings (`name:x` vs `name:x`) are rejected at
    // load; this is the case only the graph can prove: a `packages` boundary
    // with a single member, forbidden from reaching a single-project selector
    // that IS that member. Holding it would read as "banned and clean" for a
    // ban that can never fire, so the judge must say no-verdict, never ok.
    const lone = intent({
      boundaries: [{ name: "packages", match: ["tag:type-package"] }],
      forbidden: [{ from: "packages", to: "name:core", reason: "x" }],
    });
    const result = judgeIntent(lone, graph({ core: node(["type-package"]) }));
    expect(result.verdict).toBe("no-verdict");
    expect(result.findings).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].issue).toContain("self-ban");
  });

  it("still judges a same multi-member set — a ban that CAN fire", () => {
    // `*` → `*` and `packages` → `tag:type-package` have distinct members on
    // both sides, so an actual cross-pair can satisfy them. That is not a
    // self-ban; the judge must be able to report it (loud), never no-verdict.
    const bothTags = intent({
      boundaries: [{ name: "packages", match: ["tag:type-package"] }],
      forbidden: [
        { from: "tag:type-package", to: "tag:type-package", reason: "no two libs may talk" },
      ],
    });
    const result = judgeIntent(
      bothTags,
      graph(
        { core: node(["type-package"]), ui: node(["type-package"]) },
        { ui: [{ target: "core" }] },
      ),
    );
    expect(result.verdict).toBe("findings");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].rule).toBe("intentForbiddenEdge");
  });
});

describe("judgeIntent — from/to resolution", () => {
  it("a declared boundary name wins over a same-named project", () => {
    // A boundary named `core` (matching `tag:type-package`) coexists with a
    // project literally named `core`. `from: "core"` must resolve to the
    // boundary's members `[core, ui]`, not to the single project `core` — so
    // the observed `ui → site` edge satisfies the `allowed` row. Bare-name
    // resolution would read `from: ["core"]` and report intentAllowedMissing.
    const result = judgeIntent(
      intent({
        boundaries: [{ name: "core", match: ["tag:type-package"] }],
        allowed: [{ from: "core", to: "name:site" }],
      }),
      graph({ ...pkgs, site: exts.site }, { ui: [{ target: "site" }] }),
    );
    expect(result.verdict).toBe("ok");
  });

  it("resolves an inline selector side against the graph", () => {
    const result = judgeIntent(
      intent({ forbidden: [{ from: "tag:type-package", to: "name:site", reason: "x" }] }),
      graph({ ...pkgs, site: exts.site }),
    );
    expect(result.verdict).toBe("ok");
  });
});

describe("judgeIntent — determinism and provider independence", () => {
  it("is byte-identical across two runs on the same inputs", () => {
    const g = graph({ ...pkgs, site: exts.site }, { site: [{ target: "ui" }] });
    const rows = {
      boundaries: [
        { name: "packages", match: ["tag:type-package"] },
        { name: "extensions", match: ["tag:type-extension"] },
      ],
      allowed: [{ from: "extensions", to: "packages" }],
      forbidden: [{ from: "packages", to: "extensions", reason: "x" }],
    };
    const declaration = intent(rows);
    expect(JSON.stringify(judgeIntent(declaration, g))).toBe(
      JSON.stringify(judgeIntent(declaration, g)),
    );
  });

  it("judges an Nx-shaped graph the same as a native-shaped one, because both feed the same shape", () => {
    // Nx graphs carry nodes with `root` and dependencies keyed by project name —
    // the same `{nodes, dependencies}` this judge consumes.
    const nxLike = {
      nodes: {
        core: { root: "packages/core", data: { root: "packages/core", tags: ["type-package"] } },
        ui: { root: "packages/ui", data: { root: "packages/ui", tags: ["type-package"] } },
      },
      dependencies: {
        core: [{ source: "core", target: "ui", type: "static" }],
      },
    };
    const result = judgeIntent(
      intent({ boundaries: [{ name: "packages", match: ["tag:type-package"] }] }),
      nxLike,
    );
    expect(result.verdict).toBe("ok");
  });
});

describe("INTENT_MESSAGE_IDS", () => {
  it("names every concept one judge can emit, each a distinct verdict", () => {
    expect(INTENT_MESSAGE_IDS).toEqual([
      "intentForbiddenEdge",
      "intentAllowedMissing",
      "projectMissing",
      "projectPresent",
      "projectTagMissing",
      "dependencyForbidden",
      "dependencyNotAllowed",
      "tagDependencyForbidden",
      "intentUnknownProject",
      "intentUnknownTag",
    ]);
  });
});

describe("judgeIntent — projects (drift presence)", () => {
  it("reports a required project that does not exist as projectMissing", () => {
    const result = judgeIntent(intent({ projects: { required: [{ name: "ghost" }] } }), graph({}));
    expect(result.verdict).toBe("findings");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].rule).toBe("projectMissing");
    expect(result.findings[0].source).toBeNull();
  });

  it("reports a required project that exists but lacks a required tag as projectTagMissing", () => {
    const result = judgeIntent(
      intent({ projects: { required: [{ name: "core", tags: ["type-package", "scope-x"] }] } }),
      graph({ core: node(["type-package"]) }),
    );
    expect(result.verdict).toBe("findings");
    expect(result.findings.map((f) => f.rule)).toEqual(["projectTagMissing"]);
    expect(result.findings[0].message).toContain("scope-x");
  });

  it("is clean when the required project exists and carries its required tags", () => {
    const result = judgeIntent(
      intent({
        projects: { required: [{ name: "core", tags: ["type-package"] }] },
      }),
      graph({ core: node(["type-package"]) }),
    );
    expect(result.verdict).toBe("ok");
    expect(result.findings).toEqual([]);
  });

  it("reports a forbidden project that is present as projectPresent", () => {
    const result = judgeIntent(
      intent({ projects: { forbidden: [{ name: "ui" }] } }),
      graph({ core: node(["type-package"]), ui: node(["type-package"]) }),
    );
    expect(result.verdict).toBe("findings");
    expect(result.findings[0].rule).toBe("projectPresent");
  });

  it("is clean when a forbidden project is absent", () => {
    const result = judgeIntent(
      intent({ projects: { forbidden: [{ name: "legacy" }] } }),
      graph({ core: node(["type-package"]) }),
    );
    expect(result.verdict).toBe("ok");
    expect(result.findings).toEqual([]);
  });
});

describe("judgeIntent — dependencies (drift edges)", () => {
  it("reports an explicitly forbidden dependency as dependencyForbidden", () => {
    const result = judgeIntent(
      intent({ dependencies: { forbidden: [{ source: "core", target: "site" }] } }),
      graph({ ...pkgs, site: exts.site }, { core: [{ target: "site" }] }),
    );
    expect(result.verdict).toBe("findings");
    expect(result.findings[0].rule).toBe("dependencyForbidden");
    expect(result.findings[0].source).toBe("core");
    expect(result.findings[0].target).toBe("site");
  });

  it("reports a dependencies.forbidden pair connected only TRANSITIVELY — core→ui→site, no direct edge", () => {
    // P1-09: the forbidden row names core/site by exact project name; the
    // observed graph carries no DIRECT core→site edge, only core→ui→site. A
    // direct-edge-only check (this rule's pre-fix behavior) would read this
    // as clean — byte-identical to a workspace with no such path at all — the
    // silent direction `../../../../AGENTS.md` is about. `forbidden` (the
    // boundary-row shape, above) already catches this transitively; this rule
    // must not disagree with it about the same underlying claim.
    const result = judgeIntent(
      intent({ dependencies: { forbidden: [{ source: "core", target: "site" }] } }),
      graph({ ...pkgs, site: exts.site }, { core: [{ target: "ui" }], ui: [{ target: "site" }] }),
    );
    expect(result.verdict).toBe("findings");
    expect(result.findings.map((f) => f.rule)).toEqual(["dependencyForbidden"]);
    expect(result.findings[0].source).toBe("core");
    expect(result.findings[0].target).toBe("site");
    expect(result.findings[0].message).toContain("→");
  });

  it("reports an edge outside the exhaustive allowlist as dependencyNotAllowed", () => {
    // `site` is a real observed project (an extension) but is not on the
    // allowlist, so the observed edge core→site must be drift. A target with
    // no node in the graph is filtered from the observed side the same way
    // `directEdges` filters external edges — it is never judged.
    const result = judgeIntent(
      intent({ dependencies: { allowed: [{ source: "core", target: "ui" }] } }),
      graph({ ...pkgs, site: exts.site }, { core: [{ target: "site" }] }),
    );
    expect(result.verdict).toBe("findings");
    expect(result.findings.map((f) => f.rule)).toEqual(["dependencyNotAllowed"]);
  });

  it("is clean when every observed edge is inside the allowlist", () => {
    const result = judgeIntent(
      intent({ dependencies: { allowed: [{ source: "core", target: "ui" }] } }),
      graph({ ...pkgs }, { core: [{ target: "ui" }] }),
    );
    expect(result.verdict).toBe("ok");
  });

  it("does not enable allowlist closure when allowed is omitted", () => {
    const result = judgeIntent(
      intent({ dependencies: { forbidden: [{ source: "core", target: "site" }] } }),
      graph({ ...pkgs, site: exts.site }, { core: [{ target: "ui" }] }),
    );
    expect(result.verdict).toBe("ok");
    expect(result.findings).toEqual([]);
  });

  it("reports an intent row naming an unknown project as intentUnknownProject", () => {
    const result = judgeIntent(
      intent({ dependencies: { forbidden: [{ source: "core", target: "ghost" }] } }),
      graph({ ...pkgs }),
    );
    expect(result.verdict).toBe("findings");
    expect(result.findings.some((f) => f.rule === "intentUnknownProject")).toBe(true);
  });

  it("reports an edge crossing a forbidden tag pair as tagDependencyForbidden", () => {
    const forbiddenTags = intent({
      forbiddenTags: [{ from: "type-package", to: "type-extension" }],
    });
    const result = judgeIntent(
      forbiddenTags,
      graph({ ...pkgs, site: exts.site }, { core: [{ target: "site" }] }),
    );
    expect(result.verdict).toBe("findings");
    expect(result.findings.some((f) => f.rule === "tagDependencyForbidden")).toBe(true);
  });

  it("reports a forbiddenTags pair connected only TRANSITIVELY — no direct edge between the tagged projects", () => {
    // P1-09: `core` (type-package) reaches `site` (type-extension) only
    // through `adapter`, an untagged intermediate project — no type-package
    // project has a DIRECT edge to a type-extension one. A direct-edge-only
    // check (this rule's pre-fix behavior) would read this as clean, the
    // same silent miss as the dependencies.forbidden case above.
    const nodes = {
      core: node(["type-package"]),
      adapter: node([]),
      site: node(["type-extension"]),
    };
    const result = judgeIntent(
      intent({ forbiddenTags: [{ from: "type-package", to: "type-extension" }] }),
      graph(nodes, { core: [{ target: "adapter" }], adapter: [{ target: "site" }] }),
    );
    expect(result.verdict).toBe("findings");
    expect(result.findings.map((f) => f.rule)).toEqual(["tagDependencyForbidden"]);
    expect(result.findings[0].source).toBe("core");
    expect(result.findings[0].target).toBe("site");
  });

  it("reports a tag rule no project carries as intentUnknownTag", () => {
    const result = judgeIntent(
      intent({ forbiddenTags: [{ from: "backend", to: "frontend" }] }),
      graph({ ...pkgs }),
    );
    expect(result.verdict).toBe("findings");
    expect(result.findings.some((f) => f.rule === "intentUnknownTag")).toBe(true);
  });

  it("emits a fail-closed no-verdict when a boundary matches no project", () => {
    const result = judgeIntent(
      intent({ boundaries: [{ name: "empty", match: ["tag:none"] }] }),
      graph({}),
    );
    expect(result.verdict).toBe("no-verdict");
    expect(result.findings).toEqual([]);
  });

  it("emits the same no-verdict when a boundary matches only a prototype member name", () => {
    // The composite defect, from the surface a consumer sees. `./selectors.mjs`
    // answered `nodes["constructor"]` from `Object.prototype`, so this boundary
    // resolved to one phantom member, the zero-member branch above never ran,
    // `unresolved` stayed empty and the verdict came back `ok` — `check` exits
    // 0 on that, where a boundary naming nothing observable owes 3. All five
    // prototype members behaved this way; a name the prototype does not carry
    // (`tag:none` above, `ghost` here) was correctly loud the whole time.
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const result = judgeIntent(
        intent({ boundaries: [{ name: "ghost", match: [name] }] }),
        graph(pkgs),
      );
      expect(result.verdict, name).toBe("no-verdict");
      expect(result.boundaries[0].projects, name).toEqual([]);
      expect(result.unresolved, name).toHaveLength(1);
    }
    const control = judgeIntent(
      intent({ boundaries: [{ name: "ghost", match: ["ghost"] }] }),
      graph(pkgs),
    );
    expect(control.verdict).toBe("no-verdict");
  });

  it("judges the edges leaving a project literally named __proto__ instead of dropping them", () => {
    // `codeDependencies` keyed its filtered edge map on a plain `{}`, and the
    // native provider's own dependency map is null-prototype — so a project
    // named `__proto__` arrived as a real entry and the write
    // `filtered["__proto__"] = […]` repointed the filtered map's PROTOTYPE
    // instead of adding a key. Every edge leaving that project then vanished
    // from `directEdges`, `observedEdgePairs` and `buildReachability` at once,
    // and this exact fixture returned verdict "ok" with zero findings for a
    // forbidden row the graph plainly violates: byte-identical to a clean
    // workspace, which is the silent direction the invariant refuses. Both maps
    // must be null-prototype for the name to survive `Object.entries` at all.
    const nodes = Object.create(null);
    nodes.__proto__ = node(["type-package"]);
    nodes.site = node(["type-extension"]);
    const dependencies = Object.create(null);
    dependencies.__proto__ = [{ source: "__proto__", target: "site", type: "static" }];

    const result = judgeIntent(
      intent({
        boundaries: [
          { name: "packages", match: ["tag:type-package"] },
          { name: "extensions", match: ["tag:type-extension"] },
        ],
        forbidden: [
          { from: "packages", to: "extensions", reason: "the engine must not reach out" },
        ],
      }),
      { nodes, dependencies },
    );

    expect(result.verdict).toBe("findings");
    expect(result.findings.map((f) => [f.rule, f.source, f.target])).toEqual([
      ["intentForbiddenEdge", "__proto__", "site"],
    ]);
  });

  it("does not count an edge pointing at a prototype member name as an observed dependency", () => {
    // `nodes[target] !== undefined` answered `constructor` from
    // `Object.prototype`, so an edge whose target is not a project at all was
    // counted as observed — and the `dependencies.allowed` drift section then
    // reported `dependencyNotAllowed` for `a → constructor`, a finding naming a
    // project the workspace does not contain. Wrong in the loud direction here;
    // the same read backs the `allowed` rows, where a phantom edge reads as an
    // intent statement satisfied.
    const nodes = { a: node([]), b: node([]) };
    const result = judgeIntent(
      intent({
        boundaries: [],
        dependencies: { allowed: [{ source: "a", target: "b" }] },
      }),
      graph(nodes, { a: [{ target: "constructor" }, { target: "b" }] }),
    );
    expect(result.findings.map((f) => f.rule)).toEqual([]);
    expect(result.verdict).toBe("ok");
  });

  it("still counts an edge into a project genuinely named like a prototype member", () => {
    // The over-rejection half: an own-property test must keep a real project
    // called `constructor` as a real edge endpoint, or the drift sections stop
    // seeing every dependency that lands on it.
    const nodes = { a: node([]), b: node([]), constructor: node([]) };
    const result = judgeIntent(
      intent({
        boundaries: [],
        dependencies: { allowed: [{ source: "a", target: "b" }] },
      }),
      graph(nodes, { a: [{ target: "constructor" }, { target: "b" }] }),
    );
    expect(result.findings.map((f) => [f.rule, f.source, f.target])).toEqual([
      ["dependencyNotAllowed", "a", "constructor"],
    ]);
  });
});

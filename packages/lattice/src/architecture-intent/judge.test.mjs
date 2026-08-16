import { describe, expect, it } from "vitest";

import { INTENT_MESSAGE_IDS, judgeIntent } from "./judge.mjs";

/**
 * A project graph in the provider-neutral shape every command receives. Only
 * `nodes` and `dependencies` matter to the judge; each node carries its tags
 * under `data`, the same shape the selector engine reads.
 *
 * @param {Record<string, {data?: {root?: string, tags?: string[]}}>} nodes
 * @param {Record<string, Array<{target: string}>>} [dependencies]
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
  it("names exactly the two ruling concepts, each a distinct verdict", () => {
    expect(INTENT_MESSAGE_IDS).toEqual(["intentForbiddenEdge", "intentAllowedMissing"]);
  });
});

// The adapters, driven over real fixture trees the way the engine's own
// integration suite drives `check`: small workspaces on disk, the real
// analyzers, the real rule engine, the real reports — with only Nx and git
// injected, because neither has anything to say about whether an import is
// allowed. Every assertion reads fields the engine computed (a finding's own
// `sourceFile`/`line`/`column` feed the `explain` call, not literals), so a
// fixture edit moves both sides together.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { UsageError } from "@ecoma-io/archkeep/commands";

import {
  checkTool,
  contextTool,
  driftTool,
  explainTool,
  graphTool,
  historyTool,
  impactTool,
  proposeTool,
  scenarioTool,
} from "./engine.mjs";

/** Every fixture root, removed once at the end — each test names its own. */
const created = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/**
 * A fixture workspace on disk. `nx.json` registers the plugin (so the
 * polyglot-manifest gap cannot fire), the law is the layer constraint table
 * below, and the graph/files seams are injectable per call.
 */
function workspace({ violating = true, intent = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "archkeep-mcp-"));
  created.push(root);
  const writeAt = (relativePath, text) => {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  };

  writeAt(
    "nx.json",
    `${JSON.stringify({
      plugins: [
        {
          plugin: "@ecoma-io/archkeep/nx",
          options: { boundaryConfig: "module-boundaries.config.mjs" },
        },
      ],
    })}\n`,
  );
  writeAt(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  {
    sourceTag: "type-package",
    onlyDependOnLibsWithTags: ["type-package"],
    description: "a package may depend on a package, and on nothing else",
    remediation: "move the import behind a package boundary the table allows",
  },
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
`,
  );
  writeAt("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeAt("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeAt("libs/adapter/adapter.go", "package adapter\n");
  writeAt("libs/app/go.mod", "module example.com/app\n\ngo 1.24\n");
  writeAt("libs/app/app.go", "package app\n");
  writeAt(
    "libs/domain/doc.go",
    violating
      ? `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`
      : `// Package domain is the layer everything else points at.
package domain
`,
  );
  if (intent !== null) {
    writeAt("architecture-intent.json", `${JSON.stringify(intent, null, 2)}\n`);
  }

  // The graph: `app` depends on both libraries; when the fixture violates,
  // `domain`'s import of `adapter` is also a real graph edge, so the drift and
  // impact faces see the same relationship the analyzer found.
  const graph = {
    nodes: {
      domain: {
        name: "domain",
        type: "lib",
        data: { root: "libs/domain", tags: ["type-package"] },
      },
      adapter: {
        name: "adapter",
        type: "lib",
        data: { root: "libs/adapter", tags: ["type-extension"] },
      },
      app: { name: "app", type: "lib", data: { root: "libs/app", tags: ["type-application"] } },
    },
    dependencies: {
      app: [
        { source: "app", target: "domain", type: "static" },
        { source: "app", target: "adapter", type: "static" },
      ],
    },
  };
  if (violating) {
    graph.dependencies.domain = [{ source: "domain", target: "adapter", type: "static" }];
  }
  const files = [
    "nx.json",
    "module-boundaries.config.mjs",
    ...(intent !== null ? ["architecture-intent.json"] : []),
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
    "libs/app/go.mod",
    "libs/app/app.go",
  ];
  const io = { readGraph: () => graph, listFiles: () => files };
  return { root, graph, io, writeAt, read: (p) => readFileSync(join(root, p), "utf8") };
}

/** The declared intent used by the drift/propose fixtures. */
const INTENT = {
  version: "1",
  boundaries: [
    { name: "packages", match: ["tag:type-package"] },
    { name: "extensions", match: ["tag:type-extension"] },
  ],
  dependencies: {
    forbidden: [{ source: "domain", target: "adapter" }],
  },
};

describe("archkeep_check — the three-state verdict", () => {
  it("returns fail with the finding, from a violating tree", async () => {
    const w = workspace();
    const result = await checkTool({ workspaceRoot: w.root }, w.io);
    expect(result.runCompleted).toBe(true);
    expect(result.verdict).toBe("fail");
    expect(result.envelope.status).toBe("findings");
    expect(result.envelope.decision.verdict).toBe("fail");
    const violation = result.envelope.result.violations[0];
    expect(violation.sourceFile).toBe("libs/domain/doc.go");
    expect(violation.messageId).toBe("onlyTagsConstraintViolation");
    expect(result.envelope.coverage.complete).toBe(true);
  });

  it("returns pass from a clean tree", async () => {
    const w = workspace({ violating: false });
    const result = await checkTool({ workspaceRoot: w.root }, w.io);
    expect(result.runCompleted).toBe(true);
    expect(result.verdict).toBe("pass");
    expect(result.envelope.status).toBe("ok");
    expect(result.envelope.result.violations).toEqual([]);
  });

  it("returns unknown — never fail — when the run could not start", async () => {
    // A directory with no workspace marker above it: `check` throws before any
    // verdict exists, and the tool must answer 'unknown', because 'fail' names
    // a finding and no finding was reached.
    const nowhere = mkdtempSync(join(tmpdir(), "archkeep-mcp-nowhere-"));
    created.push(nowhere);
    const result = await checkTool({ workspaceRoot: nowhere }, { listFiles: () => [] });
    expect(result.runCompleted).toBe(false);
    expect(result.verdict).toBe("unknown");
    expect(result.reason).toContain("no workspace root");
    expect(result.envelope).toBeUndefined();
  });

  it("returns unknown when the engine reached no verdict over the tree", async () => {
    // An analyzable file the run could not read: coverage is incomplete, the
    // engine answers 'no-verdict', and the tool reports the engine's own
    // verdict rather than flattening it.
    const w = workspace({ violating: false });
    const withGhost = {
      ...w.io,
      listFiles: () => [...w.io.listFiles(), "libs/domain/ghost.go"],
    };
    const result = await checkTool({ workspaceRoot: w.root }, withGhost);
    expect(result.runCompleted).toBe(true);
    expect(result.verdict).toBe("unknown");
    expect(result.envelope.status).toBe("no-verdict");
    expect(result.envelope.coverage.complete).toBe(false);
  });

  it("propagates a UsageError for a bad path argument, not a verdict", async () => {
    const w = workspace();
    await expect(
      checkTool({ workspaceRoot: w.root, paths: ["no/such/file.go"] }, w.io),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("carries the run's scope beside the verdict — a scoped pass is never the gate", async () => {
    // The one confusion this field exists to prevent: on a tree the
    // whole-workspace gate FAILS, a run scoped to the clean file passes, and
    // without `scope` the two results are the same three fields. An agent
    // that read only `verdict: "pass"` would believe the workspace compliant.
    const w = workspace({ violating: true });
    const scoped = await checkTool(
      { workspaceRoot: w.root, paths: ["libs/adapter/adapter.go"] },
      w.io,
    );
    const unscoped = await checkTool({ workspaceRoot: w.root }, w.io);
    expect(scoped.runCompleted).toBe(true);
    expect(scoped.verdict).toBe("pass");
    expect(scoped.scope).toEqual({
      kind: "paths",
      paths: ["libs/adapter/adapter.go"],
    });
    expect(unscoped.verdict).toBe("fail");
    expect(unscoped.scope).toEqual({ kind: "workspace" });
  });

  it("states the scope on a run that could not start too", async () => {
    const nowhere = mkdtempSync(join(tmpdir(), "archkeep-mcp-nowhere-scope-"));
    created.push(nowhere);
    const result = await checkTool(
      { workspaceRoot: nowhere, paths: ["libs/x/a.go"] },
      { listFiles: () => [] },
    );
    expect(result.runCompleted).toBe(false);
    expect(result.scope).toEqual({ kind: "paths", paths: ["libs/x/a.go"] });
  });

  it("answers an engine bug as a structured unknown with its message, like the CLI's exit 3", async () => {
    // The taxonomy is the engine's own, mirrored one for one: a non-Usage
    // throw is exit 3 on the CLI whatever raised it — a provider failure or a
    // TypeError — and the structured `unknown` here is that same class, not a
    // third one invented in this layer. The message rides verbatim so nothing
    // is lost; the mapping is pinned so a future "improvement" that silently
    // swallowed it or reshaped the verdict cannot land unremarked.
    const w = workspace({ violating: false });
    const bugIo = {
      ...w.io,
      readGraph: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'nodes')");
      },
    };
    const bug = await checkTool({ workspaceRoot: w.root }, bugIo);
    expect(bug.runCompleted).toBe(false);
    expect(bug.verdict).toBe("unknown");
    expect(bug.reason).toBe("Cannot read properties of undefined (reading 'nodes')");
    expect(bug.envelope).toBeUndefined();
  });

  it("stringifies a non-Error throw rather than losing it", async () => {
    const w = workspace({ violating: false });
    const stringIo = {
      ...w.io,
      readGraph: () => {
        throw "a bare string failure";
      },
    };
    const result = await checkTool({ workspaceRoot: w.root }, stringIo);
    expect(result).toMatchObject({
      runCompleted: false,
      verdict: "unknown",
      reason: "a bare string failure",
    });
  });

  it("refuses a workspaceRoot that is not an absolute path", async () => {
    // The schema calls the field an absolute path; the adapter holds it, so
    // the contract reaches programmatic callers too. A relative path would
    // resolve against the server's own start directory — an anchor the caller
    // cannot know, and the one direction that can answer for a valid but
    // WRONG tree in silence.
    const w = workspace();
    for (const bad of ["libs", ".", "", null]) {
      await expect(checkTool({ workspaceRoot: bad }, w.io)).rejects.toThrow(
        /workspaceRoot must be an absolute path/,
      );
    }
  });
});

describe("archkeep_context", () => {
  it("returns the plan context: constraints, architecture, impact, coverage", async () => {
    const w = workspace();
    const envelope = await contextTool({ workspaceRoot: w.root, project: "domain" }, w.io);
    expect(envelope.command).toBe("context");
    expect(envelope.result.project).toBe("domain");
    expect(envelope.result.plan.variant).toBe("plan");
    // The law's own words ride verbatim — the workspace's authored intent,
    // never text this layer composed.
    expect(envelope.result.constraints[0].description).toBe(
      "a package may depend on a package, and on nothing else",
    );
    expect(envelope.result.plan.architecture.targets).toEqual([]);
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.status).toBe("ok");
  });

  it("rejects a project that is not in the graph, as a UsageError", async () => {
    const w = workspace();
    await expect(
      contextTool({ workspaceRoot: w.root, project: "nope" }, w.io),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe("archkeep_impact", () => {
  it("lists direct dependents with their constraint context", async () => {
    const w = workspace();
    const envelope = await impactTool({ workspaceRoot: w.root, project: "domain" }, w.io);
    expect(envelope.command).toBe("impact");
    expect(envelope.result.dependents).toEqual(["app"]);
    expect(envelope.result.direct).toEqual(["app"]);
    expect(envelope.result.transitive).toEqual([]);
    expect(envelope.status).toBe("ok");
  });

  it("rejects an unknown project as a UsageError", async () => {
    const w = workspace();
    await expect(
      impactTool({ workspaceRoot: w.root, project: "nope" }, w.io),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe("archkeep_drift", () => {
  it("names the intent row the observed edge violates", async () => {
    const w = workspace({ violating: true, intent: INTENT });
    const envelope = await driftTool({ workspaceRoot: w.root }, w.io);
    expect(envelope.command).toBe("drift");
    expect(envelope.status).toBe("ok");
    expect(envelope.result.findings.length).toBeGreaterThan(0);
    expect(envelope.result.findings[0]).toMatchObject({
      source: "domain",
      target: "adapter",
    });
  });

  it("refuses a workspace with no declared intent, message verbatim", async () => {
    const w = workspace({ violating: false });
    await expect(driftTool({ workspaceRoot: w.root }, w.io)).rejects.toThrow(
      /drift requires a tracked architecture-intent\.json/,
    );
  });
});

describe("archkeep_explain", () => {
  it("explains the judgment for the site the check finding named", async () => {
    const w = workspace();
    const checkResult = await checkTool({ workspaceRoot: w.root }, w.io);
    const violation = checkResult.envelope.result.violations[0];
    const envelope = await explainTool(
      {
        workspaceRoot: w.root,
        file: violation.sourceFile,
        line: violation.line,
        column: violation.column,
      },
      w.io,
    );
    expect(envelope.command).toBe("explain");
    expect(envelope.result.verdict).toBe("violation");
    expect(envelope.result.import.targetProject).toBe("adapter");
    expect(envelope.result.sourceTags).toEqual(["type-package"]);
    // The two guaranteed keys (the engine's own explain contract): remediation
    // verbatim off the governing row, and the row's own allowed list.
    expect(envelope.result.violations[0].remediation).toBe(
      "move the import behind a package boundary the table allows",
    );
    expect(envelope.result.violations[0].allowed).toEqual(["type-package"]);
  });

  it("refuses a position that holds no import site", async () => {
    const w = workspace();
    await expect(
      explainTool(
        { workspaceRoot: w.root, file: "libs/adapter/adapter.go", line: 1, column: 1 },
        w.io,
      ),
    ).rejects.toThrow(/no import site at/);
  });
});

describe("archkeep_graph", () => {
  it("returns the deterministic snapshot with policy identity", async () => {
    const w = workspace();
    const envelope = await graphTool({ workspaceRoot: w.root }, w.io);
    expect(envelope.command).toBe("graph");
    expect(envelope.result.projects.map((project) => project.name)).toEqual([
      "adapter",
      "app",
      "domain",
    ]);
    expect(typeof envelope.result.policy.fingerprint).toBe("string");
  });

  it("answers a workspace that declared no law, like the CLI's graph", async () => {
    // The law's filename is the un-overridden DEFAULT (nx.json names the
    // plugin with no options, so `boundaryConfigDeclared` is false) and the
    // file is absent: the descriptive arm answers with no policy field rather
    // than refusing — the exact decision `resolveDescribedPolicy` owns,
    // reached through this adapter rather than re-derived beside it.
    const w = workspace({ violating: false });
    writeFileSync(
      join(w.root, "nx.json"),
      `${JSON.stringify({ plugins: [{ plugin: "@ecoma-io/archkeep/nx" }] })}\n`,
    );
    rmSync(join(w.root, "module-boundaries.config.mjs"));
    const files = w.io.listFiles().filter((file) => file !== "module-boundaries.config.mjs");
    const envelope = await graphTool(
      { workspaceRoot: w.root },
      { ...w.io, listFiles: () => files },
    );
    expect(envelope.status).toBe("ok");
    expect("policy" in envelope.result).toBe(false);
  });
});

describe("archkeep_history", () => {
  it("reads ADR decisions from the registry", async () => {
    const w = workspace();
    w.writeAt(
      "docs/adr/0001-one-boundary.md",
      `---
id: 0001-one-boundary
status: accepted
---

# One boundary law

A decision this workspace recorded.
`,
    );
    const io = {
      ...w.io,
      listFiles: () => [...w.io.listFiles(), "docs/adr/0001-one-boundary.md"],
    };
    const envelope = await historyTool({ workspaceRoot: w.root, evidence: "decisions" }, io);
    expect(envelope.command).toBe("adr");
    expect(envelope.result.adrs).toEqual(["0001-one-boundary"]);
    expect(envelope.result.statuses).toEqual([{ id: "0001-one-boundary", status: "accepted" }]);
    expect(envelope.result.unresolved).toEqual([]);
  });

  it("answers an empty registry as an empty registry, not an error", async () => {
    const w = workspace({ violating: false });
    const envelope = await historyTool({ workspaceRoot: w.root, evidence: "decisions" }, w.io);
    expect(envelope.command).toBe("adr");
    expect(envelope.result.adrs).toEqual([]);
    expect(envelope.result.registry.count).toBe(0);
    expect(envelope.status).toBe("ok");
  });

  it("states the input requirement itself when evolution has no directory", async () => {
    const w = workspace({ violating: false });
    await expect(
      historyTool({ workspaceRoot: w.root, evidence: "evolution" }, w.io),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("refuses a narrowing argument that belongs to the other evidence kind", async () => {
    // An argument silently dropped would answer a narrower question than the
    // one asked, without saying so.
    const w = workspace({ violating: false });
    await expect(
      historyTool({ workspaceRoot: w.root, evidence: "decisions", directory: "history" }, w.io),
    ).rejects.toThrow(/directory is evolution evidence/);
  });

  it("reads the transitions across graph snapshots", async () => {
    const w = workspace({ violating: false });
    // Two real `graph` snapshots, taken through this package's own graph tool
    // over two graph states — the exact bytes `archkeep history --capture`
    // writes, not a hand-typed shape.
    const before = await graphTool({ workspaceRoot: w.root }, w.io);
    const after = await graphTool(
      { workspaceRoot: w.root },
      {
        ...w.io,
        readGraph: () => ({
          ...w.graph,
          dependencies: {
            ...w.graph.dependencies,
            domain: [{ source: "domain", target: "adapter", type: "static" }],
          },
        }),
      },
    );
    w.writeAt("history/0001-a.json", `${JSON.stringify(before)}\n`);
    w.writeAt("history/0002-b.json", `${JSON.stringify(after)}\n`);
    const envelope = await historyTool(
      {
        workspaceRoot: w.root,
        evidence: "evolution",
        directory: "history",
      },
      {
        ...w.io,
        listFiles: () => [...w.io.listFiles(), "history/0001-a.json", "history/0002-b.json"],
      },
    );
    expect(envelope.command).toBe("history");
    expect(envelope.result.transitions).toHaveLength(1);
    expect(envelope.result.transitions[0].architectureChanged).toBe(true);
  });
});

describe("archkeep_propose", () => {
  /**
   * A recursive snapshot of a fixture tree — every file, nested and hidden
   * included, keyed by path with its content hashed — because the authority
   * claim `written: false` makes is about the whole tree, not the root
   * directory's own entries. A proposal that planted `.archkeep/state.json`
   * or rewrote an ADR two levels down would pass a flat `readdirSync`
   * comparison unnoticed; this is the comparison that would not.
   *
   * @param {string} root
   * @returns {Map<string, string>}
   */
  function treeSnapshot(root) {
    const files = new Map();
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          files.set(
            relative(root, full),
            createHash("sha256").update(readFileSync(full)).digest("hex"),
          );
        } else {
          files.set(relative(root, full), `other:${entry.name}`);
        }
      }
    };
    walk(root);
    return files;
  }

  /**
   * The snapshot difference, asserted loudly in both directions: a file
   * created, deleted, or modified anywhere under the root is a failure naming
   * it, never a count.
   *
   * @param {Map<string, string>} before
   * @param {Map<string, string>} after
   */
  function expectTreeUnchanged(before, after) {
    const created = [...after.keys()].filter((path) => !before.has(path));
    const deleted = [...before.keys()].filter((path) => !after.has(path));
    const modified = [...before.keys()].filter(
      (path) => after.has(path) && before.get(path) !== after.get(path),
    );
    expect(
      `created=${JSON.stringify(created)} deleted=${JSON.stringify(deleted)} ` +
        `modified=${JSON.stringify(modified)}`,
    ).toBe("created=[] deleted=[] modified=[]");
  }

  it("proposes from observations, non-authoritative, writing nothing", async () => {
    const w = workspace({ violating: false });
    // Seed the tree with the shapes a stray write would hide in — a hidden
    // directory, a nested ADR — so the snapshot below walks more than the
    // root's own entries and the assertion has something to be wrong about.
    w.writeAt(".archkeep/seed", "already here");
    w.writeAt("docs/adr/0001-existing.md", "---\nid: 0001\nstatus: accepted\n---\n\n# One\n");
    const io = {
      ...w.io,
      listFiles: () => [...w.io.listFiles(), ".archkeep/seed", "docs/adr/0001-existing.md"],
    };
    const before = treeSnapshot(w.root);
    const result = await proposeTool({ workspaceRoot: w.root, mode: "discover" }, io);
    expect(result.mode).toBe("discover");
    expect(result.requiresApproval).toBe(true);
    expect(result.authoritative).toBe(false);
    expect(result.written).toBe(false);
    expect(result.command).toBe("discover");
    expect(result.result.proposal.notAuthoritative).toBe(true);
    expect(
      result.result.proposal.components.total + result.result.proposal.boundaryAssertions.total,
    ).toBeGreaterThan(0);
    // The whole point: no file appeared, anywhere in the tree. A proposal
    // that wrote the intent it proposes would be authority wearing a
    // suggestion's name.
    expectTreeUnchanged(before, treeSnapshot(w.root));
    expect(() => w.read("architecture-intent.json")).toThrow();
  });

  it("proposes ranked intent edits with their evidence, changing no byte", async () => {
    const w = workspace({ violating: true, intent: INTENT });
    const before = treeSnapshot(w.root);
    const result = await proposeTool({ workspaceRoot: w.root, mode: "reconcile" }, w.io);
    expect(result.mode).toBe("reconcile");
    expect(result.requiresApproval).toBe(true);
    expect(result.command).toBe("reconcile");
    expect(result.result.proposed).toBe(true);
    expect(result.result.notAuthoritative).toBe(true);
    expect(Array.isArray(result.result.candidates)).toBe(true);
    expectTreeUnchanged(before, treeSnapshot(w.root));
  });

  it("refuses reconcile on a workspace with no declared intent", async () => {
    const w = workspace({ violating: false });
    await expect(proposeTool({ workspaceRoot: w.root, mode: "reconcile" }, w.io)).rejects.toThrow(
      /reconcile requires a tracked architecture-intent\.json/,
    );
  });
});

describe("archkeep_scenario", () => {
  it("evaluates a virtual change over the seam graph, never authoritative", async () => {
    const w = workspace({ violating: false });
    // `adapter` does not depend on `domain` yet; the scenario adds that edge
    // virtually, so `domain`'s dependent set grows by exactly one.
    const scenarioJson = `${JSON.stringify({
      changes: [
        { type: "dependency_added", source: "adapter", target: "domain", edgeType: "static" },
      ],
    })}\n`;
    const result = await scenarioTool(
      { workspaceRoot: w.root, projectName: "domain", scenarioJson },
      w.io,
    );
    expect(result.command).toBe("scenario");
    // The tool face adds nothing and flattens nothing: the envelope is the
    // engine's own, virtual and not authoritative.
    expect(result.result.virtual).toBe(true);
    expect(result.result.notAuthoritative).toBe(true);
    // The evaluation really applied the change: the current dependent set is
    // exactly `app`, and the scenario's adds `adapter` — the delta names it.
    expect(result.result.current.impact.direct).toEqual(["app"]);
    expect(result.result.scenario.impact.direct).toContain("adapter");
    expect(result.result.delta.dependentsAdded).toContain("adapter");
  });

  it("answers the incomplete-coverage refusal as the no-verdict envelope (#608)", async () => {
    // The coverage gate is the scenario's loud direction: an agent must never
    // get a what-if answer over a graph that under-represents the tree. The
    // refusal arrives AS the envelope — status "no-verdict", exitCode 3, the
    // unread file named in `coverage.notAnalyzed` — the same structured shape
    // the graph family has answered since #602, not a tool error carrying
    // only a sentence.
    const w = workspace({ violating: false });
    const withGhost = {
      ...w.io,
      listFiles: () => [...w.io.listFiles(), "libs/domain/ghost.go"],
    };
    const result = await scenarioTool(
      {
        workspaceRoot: w.root,
        projectName: "domain",
        scenarioJson: `${JSON.stringify({
          changes: [{ type: "dependency_added", source: "domain", target: "app" }],
        })}\n`,
      },
      withGhost,
    );
    expect(result.command).toBe("scenario");
    expect(result.status).toBe("no-verdict");
    expect(result.exitCode).toBe(3);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.notAnalyzed).toContainEqual(
      expect.objectContaining({ file: "libs/domain/ghost.go" }),
    );
    expect(result.result).toBeUndefined();
  });

  it("propagates the parse refusal for a malformed scenario, never an answer", async () => {
    const w = workspace({ violating: false });
    await expect(
      scenarioTool(
        { workspaceRoot: w.root, projectName: "domain", scenarioJson: "{ not json" },
        w.io,
      ),
    ).rejects.toThrow(/invalid JSON/);
  });
});

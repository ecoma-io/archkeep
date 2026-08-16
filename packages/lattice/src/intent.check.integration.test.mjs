import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { check, EXIT } from "../cli.mjs";

/**
 * Architecture-intent through the real `check` command — real loader, real
 * judge, real reports — with only the seams `resolveCommandContext` already
 * injects (the graph and the tracked-file list). The intent file is written to
 * a tmpdir but is NOT listed in `listFiles` unless a case says so, because a
 * tracked file that does not exist would be a different kind of failure: the
 * loader treats an untracked intent file as absent, exactly as it does a
 * go.work or a tsconfig.
 *
 * `depConstraints` is empty, so the boundary policy decides nothing and every
 * verdict here is the intent axis alone.
 */

const write = (root, relativePath, text) => {
  mkdirSync(join(root, relativePath, ".."), { recursive: true });
  writeFileSync(join(root, relativePath), text);
};

const workspace = (overrides = {}) => {
  const root = mkdtempSync(join(tmpdir(), "intent-check-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  write(
    root,
    "module-boundaries.config.mjs",
    "export const depConstraints = [];\n" +
      "export const moduleBoundaryOptions = {\n" +
      "  allow: [],\n" +
      "  buildTargets: ['build'],\n" +
      "  enforceBuildableLibDependency: false,\n" +
      "  allowCircularSelfDependency: false,\n" +
      "  checkDynamicDependenciesExceptions: [],\n" +
      "  ignoredCircularDependencies: [],\n" +
      "  banTransitiveDependencies: false,\n" +
      "  checkNestedExternalImports: false,\n" +
      "};\n",
  );
  write(
    root,
    "nx.json",
    `${JSON.stringify({ plugins: [{ plugin: "@ecoma-io/lattice/nx", options: { boundaryConfig: "module-boundaries.config.mjs" } }] })}\n`,
  );
  write(root, "libs/core/go.mod", "module example.com/core\n\ngo 1.24\n");
  write(root, "libs/core/core.go", "package core\n");
  write(root, "libs/site/go.mod", "module example.com/site\n\ngo 1.24\n");
  write(root, "libs/site/site.go", "package site\n");
  for (const [path, text] of Object.entries(overrides.extra ?? {})) write(root, path, text);

  const graph = {
    nodes: {
      core: { name: "core", type: "lib", data: { root: "libs/core", tags: ["type-package"] } },
      site: { name: "site", type: "lib", data: { root: "libs/site", tags: ["type-extension"] } },
    },
    dependencies: {},
  };
  for (const [from, to] of overrides.edges ?? []) {
    graph.dependencies[from] = [...(graph.dependencies[from] ?? []), { source: from, target: to }];
  }
  const files = [
    "nx.json",
    "module-boundaries.config.mjs",
    "libs/core/go.mod",
    "libs/core/core.go",
    "libs/site/go.mod",
    "libs/site/site.go",
    ...(overrides.tracked ?? []),
  ];
  return {
    root,
    context: { cwd: root, readGraph: () => graph, listFiles: () => files },
    write: (path, text) => write(root, path, text),
    files,
    graph,
  };
};

const INTENT = {
  version: "1",
  boundaries: [
    { name: "packages", match: ["tag:type-package"] },
    { name: "extensions", match: ["tag:type-extension"] },
  ],
};

describe("architecture intent through check — the absent-declaration pact", () => {
  it("leaves the intent key absent from the JSON envelope when the tree has no intent file", async () => {
    const w = workspace();
    const { report } = await check({ format: "json", config: null, paths: [] }, w.context);
    const envelope = JSON.parse(report);
    expect("intent" in envelope.result).toBe(false);
    expect(envelope.result.intent).toBeUndefined();
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
  });

  it("leaves the text report untouched — no section, no mention — when there is no intent file", async () => {
    const w = workspace();
    const { report } = await check({ format: "text", config: null, paths: [] }, w.context);
    expect(report).toBe("✔ no boundary violations (0 imports in 2 files across 2 projects)");
  });

  it("treats an untracked intent file as absent — an intentional file is not reviewed state", async () => {
    const w = workspace();
    w.write("architecture-intent.json", JSON.stringify(INTENT));
    const { report } = await check({ format: "json", config: null, paths: [] }, w.context);
    const envelope = JSON.parse(report);
    expect("intent" in envelope.result).toBe(false);
    expect(envelope.status).toBe("ok");
  });

  it("folds the zero-member boundary no-verdict into the run's verdict and exit code", async () => {
    // The empty-result invariant, through the whole pipeline: a boundary whose
    // selectors match no observed project must be a no-verdict (exit 3), never
    // an ok. This is the safety net that makes a bad dogfood file red rather
    // than silently skipped.
    const w = workspace({
      tracked: ["architecture-intent.json"],
      extra: {
        "architecture-intent.json": JSON.stringify({
          ...INTENT,
          boundaries: [...INTENT.boundaries, { name: "apps", match: ["tag:type-app"] }],
        }),
      },
    });
    const { report, intentFindings, intentUnresolved } = await check(
      { format: "text", config: null, paths: [] },
      w.context,
    );
    expect(intentFindings).toBe(0);
    expect(intentUnresolved).toBe(1);
    expect(report).toContain("architecture-intent.json reached no verdict");
    const { report: json } = await check({ format: "json", config: null, paths: [] }, w.context);
    const envelope = JSON.parse(json);
    expect(envelope.result.intent.verdict).toBe("no-verdict");
    expect(envelope.exitCode).toBe(EXIT.error);
    expect(envelope.status).toBe("no-verdict");
  });

  it("reports a forbidden edge as a finding — exit 1, intent key present, envelope carries it", async () => {
    const w = workspace({
      tracked: ["architecture-intent.json"],
      extra: {
        "architecture-intent.json": JSON.stringify({
          ...INTENT,
          forbidden: [
            { from: "packages", to: "extensions", reason: "the engine must not reach out" },
          ],
        }),
      },
      edges: [["core", "site"]],
    });
    const { report, intentFindings } = await check(
      { format: "text", config: null, paths: [] },
      w.context,
    );
    expect(intentFindings).toBe(1);
    expect(report).toContain("intentForbiddenEdge");
    const { report: json } = await check({ format: "json", config: null, paths: [] }, w.context);
    const envelope = JSON.parse(json);
    expect(envelope.result.intent).toMatchObject({
      checked: true,
      file: "architecture-intent.json",
      verdict: "findings",
    });
    expect(envelope.result.intent.findings).toHaveLength(1);
    expect(envelope.status).toBe("findings");
    expect(envelope.exitCode).toBe(EXIT.violations);
  });

  it("treats a named-but-unobserved allowed row as drift — exit 1, intentAllowedMissing", async () => {
    const w = workspace({
      tracked: ["architecture-intent.json"],
      extra: {
        "architecture-intent.json": JSON.stringify({
          ...INTENT,
          allowed: [{ from: "packages", to: "extensions" }],
        }),
      },
    });
    const { report, intentFindings } = await check(
      { format: "text", config: null, paths: [] },
      w.context,
    );
    expect(intentFindings).toBe(1);
    expect(report).toContain("intentAllowedMissing");
    expect(report).toContain("✖ architecture-intent findings");
    const { report: json } = await check({ format: "json", config: null, paths: [] }, w.context);
    const envelope = JSON.parse(json);
    expect(envelope.result.intent.verdict).toBe("findings");
    expect(envelope.result.intent.findings[0].rule).toBe("intentAllowedMissing");
    expect(envelope.exitCode).toBe(EXIT.violations);
  });

  it("treats an optional allowed row's absence as a coverage note — exit 0, no finding", async () => {
    const w = workspace({
      tracked: ["architecture-intent.json"],
      extra: {
        "architecture-intent.json": JSON.stringify({
          ...INTENT,
          allowed: [{ from: "packages", to: "extensions", optional: true }],
        }),
      },
    });
    const { report, intentFindings } = await check(
      { format: "text", config: null, paths: [] },
      w.context,
    );
    expect(intentFindings).toBe(0);
    expect(report).toContain("optional allowed intent");
    const { report: json } = await check({ format: "json", config: null, paths: [] }, w.context);
    const envelope = JSON.parse(json);
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(EXIT.ok);
    expect(envelope.result.intent.verdict).toBe("ok");
    expect(envelope.coverage.notes).toHaveLength(1);
  });

  it("renders a malformed intent file as a distinct intent no-verdict — exit 3, never folded into source coverage", async () => {
    // The empty-result invariant has a second flank: a declaration this tool
    // cannot establish must not read as clean, AND it must not read as a
    // source-coverage hole. `coverage.complete` keeps its analysis-read
    // meaning — the malformed intent file is not a file the analyzers failed
    // to read, so it must not flip `notAnalyzed`, and the text report must
    // name it as an intent verdict, never as "N files could not be analyzed".
    const w = workspace({
      tracked: ["architecture-intent.json"],
      extra: { "architecture-intent.json": '{ "version": "9"' }, // invalid strict JSON
    });
    const { report, unchecked, intentUnresolved } = await check(
      { format: "text", config: null, paths: [] },
      w.context,
    );
    expect(unchecked).toBe(0);
    expect(intentUnresolved).toBe(1);
    expect(report).toContain("architecture-intent.json");
    expect(report).toContain("is not valid strict JSON");
    expect(report).toContain("could not be established");
    expect(report).not.toMatch(/could not be analyzed at all/);
    expect(report).toContain("reached no verdict");
    const { report: json } = await check({ format: "json", config: null, paths: [] }, w.context);
    const envelope = JSON.parse(json);
    expect(envelope.status).toBe("no-verdict");
    expect(envelope.exitCode).toBe(EXIT.error);
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.notAnalyzed).toEqual([]);
    expect(envelope.result.intent.verdict).toBe("no-verdict");
    expect(envelope.result.intent.unresolved).toHaveLength(1);
  });
});

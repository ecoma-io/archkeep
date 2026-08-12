import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { check, EXIT, parseCheckArgs, runCli } from "../cli.mjs";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));

/** Runs the real executable, the way a shell, a hook, or CI would. */
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

/**
 * A workspace with two Go projects on opposite sides of the layer axis, and one
 * import that crosses it the wrong way. Small, real files on disk: the analyzer
 * reads them, the rule engine judges them, the report renders them — only Nx
 * and git are injected, because neither has anything to say about whether an
 * import is allowed.
 */
const root = mkdtempSync(join(tmpdir(), "polyglot-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (relativePath, text) => {
  mkdirSync(join(root, relativePath, ".."), { recursive: true });
  writeFileSync(join(root, relativePath), text);
};

write("nx.json", "{}\n");
write(
  "module-boundaries.config.mjs",
  `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
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
write("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
write("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
write("libs/adapter/adapter.go", "package adapter\n");
// The measured hole, reproduced: a domain package importing an adapter. ESLint
// answers "File ignored because no matching configuration was supplied" for a
// `.go` file, so its project's lint target exits 0 over exactly this.
write(
  "libs/domain/doc.go",
  `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
);

const graph = {
  nodes: {
    domain: {
      name: "domain",
      type: "lib",
      data: { root: "libs/domain", tags: ["layer:domain"] },
    },
    adapter: {
      name: "adapter",
      type: "lib",
      data: { root: "libs/adapter", tags: ["layer:adapter"] },
    },
  },
  dependencies: { domain: [], adapter: [] },
};

const files = [
  "nx.json",
  "module-boundaries.config.mjs",
  "libs/domain/go.mod",
  "libs/domain/doc.go",
  "libs/adapter/go.mod",
  "libs/adapter/adapter.go",
];

const context = { cwd: root, readGraph: () => graph, listFiles: () => files };

/** `runCli`'s whole outside world: two capturing streams plus the seams above. */
const env = () => {
  const out = [];
  const err = [];
  return {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    lines: { out, err },
    ...context,
  };
};

describe("checking a real tree", () => {
  it("reports a layer-crossing Go import at the line and column that wrote it", async () => {
    // The one assertion the whole tool exists for. A developer fixes this from
    // the line alone, so the line has to carry the position, the rule, the
    // message, and the constraint row that decided it.
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      context,
    );

    expect(violations).toBe(1);
    expect(report).toContain("libs/domain/doc.go:5:2  onlyTagsConstraintViolation");
    expect(report).toContain(
      'A project tagged with "layer:domain" can only depend on libs tagged with "layer:domain"',
    );
    expect(report).toContain('import      "example.com/adapter" (static)  domain → adapter');
    expect(report).toContain(
      "constraint  sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain]",
    );
  });

  it("states what it inspected alongside the count, so the verdict is a claim about coverage too", async () => {
    const { report } = await check({ format: "text", config: null, paths: [] }, context);
    expect(report).toMatch(/1 import in 2 files across 2 projects/);
  });

  it("says nothing about go.work in a workspace that has none — no manifest, no check, no claim", async () => {
    const { report, goWorkDrift } = await check(
      { format: "text", config: null, paths: [] },
      context,
    );
    expect(goWorkDrift).toBe(0);
    expect(report).not.toContain("go.work");
  });

  it("says nothing about path aliases in a workspace with no tsconfig — no table, no check, no claim", async () => {
    // The paths hygiene check's silent case, on the main fixture precisely
    // because it never writes a tsconfig: a workspace without the table must
    // pay nothing and hear nothing.
    const { report, tsconfigPathsDead } = await check(
      { format: "text", config: null, paths: [] },
      context,
    );
    expect(tsconfigPathsDead).toBe(0);
    expect(report).not.toContain("tsconfig");
  });

  it("renders the same verdict as SARIF, located at the same position", async () => {
    const { report } = await check({ format: "sarif", config: null, paths: [] }, context);
    const [result] = JSON.parse(report).runs[0].results;
    expect(result.ruleId).toBe("onlyTagsConstraintViolation");
    expect(result.locations[0].physicalLocation).toEqual({
      artifactLocation: { uri: "libs/domain/doc.go" },
      region: { startLine: 5, startColumn: 2 },
    });
  });

  it("reads the boundary law from --config, whose location is not the tree being judged", async () => {
    // The law's location and the tree being judged are two facts. Pointing at a
    // table that permits the import must clear it without moving which
    // workspace is analyzed.
    const permissive = join(root, "permissive.config.mjs");
    writeFileSync(
      permissive,
      readFileSync(join(root, "module-boundaries.config.mjs"), "utf8").replace(
        '{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }',
        '{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] }',
      ),
    );
    const { report, violations, analyzed } = await check(
      { format: "text", config: permissive, paths: [] },
      context,
    );
    expect(violations).toBe(0);
    expect(analyzed).toBe(2);
    expect(report).toContain("✔ no boundary violations");
  });

  it("scopes to the paths it is given, and finds nothing in the clean half", async () => {
    const { report, violations } = await check(
      { format: "text", config: null, paths: ["libs/adapter"] },
      context,
    );
    expect(violations).toBe(0);
    expect(report).toContain("in 1 file across 2 projects");
  });
});

describe("honouring Module Federation remotes in the app-import ban", () => {
  // `nx graph --file=` carries no Module Federation fact (see
  // `annotateMFERemotes` in `./workspace.mjs`), so the CLI computes it from the
  // config files on disk the way upstream does. Two apps, near-identical: one
  // exposes a remote, the other only hosts. Upstream flags only the second, so
  // this run must too — in both directions, because the exemption over-firing
  // (waiving the host) is the silent one nobody would ever report.
  const mfeRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-mfe-"));
  afterAll(() => rmSync(mfeRoot, { recursive: true, force: true }));

  const writeMfe = (relativePath, text) => {
    mkdirSync(join(mfeRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(mfeRoot, relativePath), text);
  };

  const CONSUMER_GO = [
    "package consumer",
    "",
    "import (",
    '\t"example.com/widgets"',
    '\t"example.com/portal"',
    ")",
    "",
    "var _ = widgets.Name",
    "var _ = portal.Name",
    "",
  ].join("\n");

  writeMfe("nx.json", "{}\n");
  writeMfe(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "zone:site", onlyDependOnLibsWithTags: ["zone:site"] },
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
  writeMfe("libs/consumer/go.mod", "module example.com/consumer\n\ngo 1.24\n");
  writeMfe("libs/consumer/consumer.go", CONSUMER_GO);
  writeMfe("apps/widgets/go.mod", "module example.com/widgets\n\ngo 1.24\n");
  writeMfe("apps/widgets/widgets.go", "package widgets\n");
  writeMfe(
    "apps/widgets/module-federation.config.js",
    "module.exports = { exposes: { './Widget': './src/widget' } };\n",
  );
  writeMfe("apps/portal/go.mod", "module example.com/portal\n\ngo 1.24\n");
  writeMfe("apps/portal/portal.go", "package portal\n");
  // The near-identical config: it names remotes and exposes nothing.
  writeMfe(
    "apps/portal/module-federation.config.js",
    "module.exports = { remotes: ['widgets'] };\n",
  );

  const mfeContext = {
    cwd: mfeRoot,
    readGraph: () => ({
      nodes: {
        consumer: {
          name: "consumer",
          type: "lib",
          data: { root: "libs/consumer", tags: ["zone:site"] },
        },
        widgets: {
          name: "widgets",
          type: "app",
          data: { root: "apps/widgets", tags: ["zone:site"] },
        },
        portal: { name: "portal", type: "app", data: { root: "apps/portal", tags: ["zone:site"] } },
      },
      dependencies: { consumer: [], widgets: [], portal: [] },
    }),
    listFiles: () => [
      "nx.json",
      "module-boundaries.config.mjs",
      "libs/consumer/go.mod",
      "libs/consumer/consumer.go",
      "apps/widgets/go.mod",
      "apps/widgets/widgets.go",
      "apps/widgets/module-federation.config.js",
      "apps/portal/go.mod",
      "apps/portal/portal.go",
      "apps/portal/module-federation.config.js",
    ],
  };

  // The position a reader acts on, computed from the fixture rather than
  // written as a literal, so editing the fixture moves both sides.
  const lines = CONSUMER_GO.split("\n");
  const portalLine = lines.findIndex((line) => line.includes("example.com/portal")) + 1;
  const portalColumn = lines[portalLine - 1].indexOf('"') + 1;

  it("flags the import of the app that exposes nothing, exactly as upstream would", async () => {
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      mfeContext,
    );

    expect(violations).toBe(1);
    expect(report).toContain(`libs/consumer/consumer.go:${portalLine}:${portalColumn}`);
    expect(report).toContain("noImportsOfApps");
  });

  it("does not flag the import of the remote, which upstream exempts", async () => {
    // The false positive this change removes: before the adapters populated
    // `mfeRemote`, this exact import was reported as `noImportsOfApps`.
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      mfeContext,
    );

    expect(violations).toBe(1);
    expect(report).not.toContain("example.com/widgets");
  });
});

describe("the go.work drift check", () => {
  // Its own fixture, because go.work drift is exactly the state the main
  // fixture must not carry: a clean two-module workspace whose go.work is
  // edited per case. Only Nx and git are injected — the parser reads the real
  // file and the real comparison judges it, so what is pinned here is the
  // whole path a consumer's `check` takes.
  const workRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-gowork-"));
  afterAll(() => rmSync(workRoot, { recursive: true, force: true }));

  const writeWork = (relativePath, text) => {
    mkdirSync(join(workRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(workRoot, relativePath), text);
  };

  writeWork("nx.json", "{}\n");
  writeWork(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
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
  writeWork("libs/store/go.mod", "module example.com/store\n\ngo 1.24\n");
  writeWork("libs/store/store.go", "package store\n");
  writeWork("libs/pricing/go.mod", "module example.com/pricing\n\ngo 1.24\n");
  writeWork("libs/pricing/pricing.go", "package pricing\n");

  const workContext = {
    cwd: workRoot,
    readGraph: () => ({
      nodes: {
        store: { name: "store", type: "lib", data: { root: "libs/store", tags: ["layer:domain"] } },
        pricing: {
          name: "pricing",
          type: "lib",
          data: { root: "libs/pricing", tags: ["layer:domain"] },
        },
      },
      dependencies: { store: [], pricing: [] },
    }),
    listFiles: () => [
      "nx.json",
      "module-boundaries.config.mjs",
      "go.work",
      "libs/store/go.mod",
      "libs/store/store.go",
      "libs/pricing/go.mod",
      "libs/pricing/pricing.go",
    ],
  };

  const workEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      ...workContext,
    };
  };

  it("exits 1 on a project missing from the use list, with zero boundary violations to blame", async () => {
    // The breaking half of this change, deliberately: a workspace whose
    // imports are all legal and whose go.work has quietly fallen behind was
    // exit 0 before this check existed, and that green was the drift being
    // invisible.
    writeWork("go.work", "go 1.24\n\nuse ./libs/store\n");
    const streams = workEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("✔ no boundary violations");
    expect(report).toContain("go.work  goWorkMissingUse");
    expect(report).toContain('"pricing"');
    expect(report).toContain("✖ go.work drifts from the project graph: 1 finding");
  });

  it("exits 1 on a stale use entry, locating it at the line and column that wrote it", async () => {
    const goWork = "go 1.24\n\nuse (\n\t./libs/store\n\t./libs/pricing\n\t./libs/checkout\n)\n";
    writeWork("go.work", goWork);
    // Position computed from the fixture, so editing it moves both sides.
    const lines = goWork.split("\n");
    const line = lines.findIndex((candidate) => candidate.includes("./libs/checkout")) + 1;
    const column = lines[line - 1].indexOf("./libs/checkout") + 1;
    const streams = workEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    expect(streams.lines.out.join("\n")).toContain(`go.work:${line}:${column}  goWorkStaleUse`);
  });

  it("exits 0 when the use list and the graph agree, and claims that agreement out loud", async () => {
    writeWork("go.work", "go 1.24\n\nuse (\n\t./libs/store\n\t./libs/pricing\n)\n");
    const streams = workEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.ok);
    expect(streams.lines.out.join("\n")).toContain(
      "✔ go.work agrees with the project graph (2 Go module projects)",
    );
  });

  it("exits 3 on a go.work it cannot parse — a malformed file must never read as 'no drift'", async () => {
    // The silent direction, end to end: an unclosed block truncates the use
    // list, and a parser that shrugged would hand the comparison an empty one,
    // reporting every module as missing at best and nothing at worst. The run
    // refuses a verdict instead.
    writeWork("go.work", "go 1.24\n\nuse (\n\t./libs/store\n");
    const streams = workEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("could not be analyzed at all");
    expect(report).toContain("go.work:3: 'use (' block is never closed");
    expect(report).not.toContain("goWorkMissingUse");
  });

  it("carries drift into the SARIF report as results, so a code-scanning consumer sees the red", async () => {
    writeWork("go.work", "go 1.24\n\nuse ./libs/store\n");
    const { report, violations, goWorkDrift } = await check(
      { format: "sarif", config: null, paths: [] },
      workContext,
    );
    expect(violations).toBe(0);
    expect(goWorkDrift).toBe(1);
    const run = JSON.parse(report).runs[0];
    const [result] = run.results;
    expect(result.ruleId).toBe("goWorkMissingUse");
    expect(run.tool.driver.rules[result.ruleIndex].id).toBe("goWorkMissingUse");
    expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe("go.work");
  });

  it("counts drift findings on the stderr summary of an --output run, beside the violations", async () => {
    writeWork("go.work", "go 1.24\n\nuse ./libs/store\n");
    const target = join(workRoot, "drift.sarif");
    const streams = workEnv();
    expect(await runCli(["check", "--format", "sarif", "--output", target], streams)).toBe(
      EXIT.violations,
    );
    expect(streams.lines.err.join("\n")).toContain("1 go.work drift finding");
  });
});

describe("the tsconfig paths hygiene check", () => {
  // Its own fixture, because a dead alias is exactly the state the main
  // fixture must not carry: a clean one-module Go workspace whose
  // tsconfig.base.json is rewritten per case. No TypeScript source at all,
  // deliberately — the table is a workspace fact, so the check must fire (and
  // refuse) even where no analyzed file ever imports through it. Only Nx and
  // git are injected: the real parse reads the real file and the real
  // judgement probes the real directories, so what is pinned here is the whole
  // path a consumer's `check` takes.
  const aliasRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-tspaths-"));
  afterAll(() => rmSync(aliasRoot, { recursive: true, force: true }));

  const writeAlias = (relativePath, text) => {
    mkdirSync(join(aliasRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(aliasRoot, relativePath), text);
  };

  writeAlias("nx.json", "{}\n");
  writeAlias(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
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
  writeAlias("libs/store/go.mod", "module example.com/store\n\ngo 1.24\n");
  writeAlias("libs/store/store.go", "package store\n");

  const aliasContext = {
    cwd: aliasRoot,
    readGraph: () => ({
      nodes: {
        store: { name: "store", type: "lib", data: { root: "libs/store", tags: ["layer:domain"] } },
      },
      dependencies: { store: [] },
    }),
    listFiles: () => [
      "nx.json",
      "module-boundaries.config.mjs",
      "tsconfig.base.json",
      "libs/store/go.mod",
      "libs/store/store.go",
    ],
  };

  const aliasEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      ...aliasContext,
    };
  };

  const tsconfig = (compilerOptions) => JSON.stringify({ compilerOptions }, null, 2);

  it("exits 1 on an alias whose every target's directory is gone, with zero boundary violations to blame", async () => {
    // The breaking half of this change, deliberately: a workspace whose
    // imports are all legal and whose alias table has quietly rotted was exit
    // 0 before this check existed, and that green was the dead alias being
    // invisible.
    writeAlias(
      "tsconfig.base.json",
      tsconfig({ paths: { "@shop/catalog": ["libs/catalog/src/index.ts"] } }),
    );
    const streams = aliasEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("✔ no boundary violations");
    expect(report).toContain("tsconfig.base.json  tsconfigDeadPathAlias");
    expect(report).toContain('"@shop/catalog"');
    expect(report).toContain("libs/catalog/src/");
    expect(report).toContain("✖ dead tsconfig path aliases: 1 finding");
  });

  it("exits 0 while a target's prefix directory exists, and claims the coverage out loud", async () => {
    // `libs/store` is on disk, so the wildcard alias is alive by the stated
    // rule whatever a specifier substitutes — and the clean line must say how
    // many aliases that claim covers.
    writeAlias("tsconfig.base.json", tsconfig({ paths: { "@shop/store/*": ["libs/store/*"] } }));
    const streams = aliasEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.ok);
    expect(streams.lines.out.join("\n")).toContain(
      "✔ no dead tsconfig path aliases (1 alias judged in tsconfig.base.json)",
    );
  });

  it("says nothing when the tsconfig declares no paths — a table that does not exist makes no claim", async () => {
    writeAlias("tsconfig.base.json", tsconfig({ module: "nodenext" }));
    const streams = aliasEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.ok);
    expect(streams.lines.out.join("\n")).not.toContain("tsconfig");
  });

  it("exits 3 on a tsconfig it cannot load — a broken table must never read as 'no aliases'", async () => {
    // The silent direction, end to end, in a workspace with no TypeScript
    // source: nothing else ever loads this tsconfig, so a check that shrugged
    // here would leave the file broken and the run green. The run refuses a
    // verdict instead — which is also the one behaviour change a pure-Go
    // workspace can see from this check.
    writeAlias("tsconfig.base.json", "{ this is not JSON");
    const streams = aliasEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("could not be analyzed at all");
    expect(report).toContain("tsconfig.base.json");
    expect(report).toContain("not valid JSON");
    expect(report).not.toContain("tsconfigDeadPathAlias");
    expect(report).not.toContain("✔ no dead tsconfig path aliases");
  });

  it("exits 3 on a paths value that is not an array of strings, naming the alias it refused", async () => {
    // TypeScript's own parse accepts this shape without a diagnostic
    // (src/tsconfig-paths.mjs header), so reading it as an absent alias would
    // be the same silent direction with a subtler cause.
    writeAlias(
      "tsconfig.base.json",
      tsconfig({ paths: { "@shop/catalog": "libs/catalog/src/index.ts" } }),
    );
    const streams = aliasEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("could not be analyzed at all");
    expect(report).toContain('"@shop/catalog"');
    expect(report).toContain("no verdict");
  });

  it("carries a dead alias into the SARIF report as a result, so a code-scanning consumer sees the red", async () => {
    writeAlias(
      "tsconfig.base.json",
      tsconfig({ paths: { "@shop/catalog": ["libs/catalog/src/index.ts"] } }),
    );
    const { report, violations, tsconfigPathsDead } = await check(
      { format: "sarif", config: null, paths: [] },
      aliasContext,
    );
    expect(violations).toBe(0);
    expect(tsconfigPathsDead).toBe(1);
    const run = JSON.parse(report).runs[0];
    const [result] = run.results;
    expect(result.ruleId).toBe("tsconfigDeadPathAlias");
    expect(run.tool.driver.rules[result.ruleIndex].id).toBe("tsconfigDeadPathAlias");
    expect(result.locations[0].physicalLocation).toEqual({
      artifactLocation: { uri: "tsconfig.base.json" },
    });
    expect(result.properties).toEqual({
      alias: "@shop/catalog",
      targets: ["libs/catalog/src/index.ts"],
    });
  });

  it("counts dead aliases on the stderr summary of an --output run, beside the violations", async () => {
    writeAlias(
      "tsconfig.base.json",
      tsconfig({ paths: { "@shop/catalog": ["libs/catalog/src/index.ts"] } }),
    );
    const target = join(aliasRoot, "dead-alias.sarif");
    const streams = aliasEnv();
    expect(await runCli(["check", "--format", "sarif", "--output", target], streams)).toBe(
      EXIT.violations,
    );
    expect(streams.lines.err.join("\n")).toContain("1 dead tsconfig path alias");
  });
});

describe("honouring the two package.json facts the graph cannot carry", () => {
  // `nx graph --file=` carries neither `entryPoints` nor `declaredPackages`
  // (see `annotatePackageFacts` in `./workspace.mjs`), so the CLI computes both
  // from the manifests on disk the way upstream does per lint run. One
  // TypeScript project, real files, real `ts.resolveModuleName`; only Nx and
  // git are injected — and the injected graph node deliberately carries
  // NEITHER field, because computing them is exactly what is under test.
  const pkgRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-pkg-"));
  afterAll(() => rmSync(pkgRoot, { recursive: true, force: true }));

  const writePkg = (relativePath, text) => {
    mkdirSync(join(pkgRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(pkgRoot, relativePath), text);
  };

  writePkg("nx.json", "{}\n");
  writePkg(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "zone:kit", onlyDependOnLibsWithTags: ["zone:kit"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: true,
  checkNestedExternalImports: false,
};
`,
  );
  writePkg(
    "tsconfig.base.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: {
          "@fixture/gadgets": ["libs/gadgets/src/index.ts"],
          "@fixture/gadgets/models": ["libs/gadgets/src/models.ts"],
        },
      },
    }),
  );
  // The two manifests upstream unions: the workspace root's declares one
  // package, the project's own declares another — and the project's also
  // declares the secondary entry point.
  writePkg(
    "package.json",
    JSON.stringify({ name: "fixture", dependencies: { "direct-dep": "^1.0.0" } }),
  );
  writePkg(
    "libs/gadgets/package.json",
    JSON.stringify({
      name: "@fixture/gadgets",
      dependencies: { "local-dep": "^1.0.0" },
      exports: { ".": "./src/index.ts", "./models": "./src/models.ts" },
    }),
  );
  // All three packages are INSTALLED — an unresolvable specifier is reported
  // as transitive regardless of declaration (upstream the same), which would
  // let an always-empty `declaredPackages` pass the flagged case for the wrong
  // reason.
  for (const name of ["direct-dep", "local-dep", "transitive-dep"]) {
    writePkg(
      `node_modules/${name}/package.json`,
      JSON.stringify({
        name,
        version: "1.0.0",
        types: "./index.d.ts",
        exports: { ".": "./index.d.ts", "./*": "./*.d.ts" },
      }),
    );
    writePkg(`node_modules/${name}/index.d.ts`, "export declare const name: string;\n");
  }

  const INDEX_TS = [
    'import { name as direct } from "direct-dep";',
    'import { name as local } from "local-dep";',
    'import { name as transitive } from "transitive-dep";',
    "",
    "export const gadgets = [direct, local, transitive];",
    "",
  ].join("\n");
  writePkg("libs/gadgets/src/index.ts", INDEX_TS);
  writePkg("libs/gadgets/src/models.ts", 'export const models = "models";\n');
  // A file in the SECONDARY entry point's subtree importing it by alias —
  // upstream's `belongsToDifferentEntryPoint` exemption…
  writePkg(
    "libs/gadgets/src/deep/feature.ts",
    'import { models } from "@fixture/gadgets/models";\n\nexport const feature = models;\n',
  );
  // …and the near-identical import of the MAIN entry, which stays a cycle
  // through the barrel.
  const BARREL_TS =
    'import { gadgets } from "@fixture/gadgets";\n\nexport const viaBarrel = gadgets;\n';
  writePkg("libs/gadgets/src/barrel-user.ts", BARREL_TS);

  const pkgContext = {
    cwd: pkgRoot,
    readGraph: () => ({
      nodes: {
        gadgets: {
          name: "gadgets",
          type: "lib",
          data: { root: "libs/gadgets", tags: ["zone:kit"] },
        },
      },
      dependencies: { gadgets: [] },
    }),
    listFiles: () => [
      "nx.json",
      "module-boundaries.config.mjs",
      "tsconfig.base.json",
      "package.json",
      "libs/gadgets/package.json",
      "libs/gadgets/src/index.ts",
      "libs/gadgets/src/models.ts",
      "libs/gadgets/src/deep/feature.ts",
      "libs/gadgets/src/barrel-user.ts",
    ],
  };

  // Positions computed from the fixture, not written as literals: the offset
  // the analyzer records is the specifier literal's opening quote.
  const indexLines = INDEX_TS.split("\n");
  const transitiveLine = indexLines.findIndex((line) => line.includes("transitive-dep")) + 1;
  const transitiveColumn = indexLines[transitiveLine - 1].indexOf('"') + 1;
  const barrelColumn = BARREL_TS.split("\n")[0].indexOf('"') + 1;

  it("flags only the UNDECLARED package as transitive, from the union of both manifests", async () => {
    // Both directions at once: `transitive-dep` missing would mean
    // `declaredPackages` over-populated (a silently waived report upstream
    // makes); `direct-dep` or `local-dep` appearing would mean the root or the
    // project manifest was not read (the pre-change false alarm).
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      pkgContext,
    );

    expect(report).toContain(`libs/gadgets/src/index.ts:${transitiveLine}:${transitiveColumn}`);
    expect(report).toContain("noTransitiveDependencies");
    expect(report).not.toContain("direct-dep");
    expect(report).not.toContain("local-dep");
    expect(violations).toBe(2);
  });

  it("exempts the secondary-entry-point self-import and still flags the barrel one", async () => {
    // `feature.ts` importing `@fixture/gadgets/models` is upstream's
    // `belongsToDifferentEntryPoint` escape hatch — the pre-change false alarm
    // this field removes. `barrel-user.ts` importing the main entry is the
    // cycle that must survive it: losing that report would be `entryPoints`
    // over-firing, the silent direction.
    const { report } = await check({ format: "text", config: null, paths: [] }, pkgContext);

    expect(report).not.toContain("feature.ts");
    expect(report).toContain(`libs/gadgets/src/barrel-user.ts:1:${barrelColumn}`);
    expect(report).toContain("noSelfCircularDependencies");
  });
});

describe("checking a native lattice.json tree — no nx.json, no nx installed", () => {
  // A second, independent tmpdir: `root`'s fixture carries `nx.json` and an
  // injected `readGraph`, and the whole point of this block is a tree where
  // neither exists. `nativeProvider` is reached through `check()`'s own
  // `hasNative` branch — nothing here injects a provider, the way the graph
  // fixture above injects `readGraph` — so this is the wiring itself under
  // test, not a stand-in for it.
  const nativeRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-"));
  afterAll(() => rmSync(nativeRoot, { recursive: true, force: true }));

  const writeNative = (relativePath, text) => {
    mkdirSync(join(nativeRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(nativeRoot, relativePath), text);
  };

  writeNative(
    "lattice.json",
    JSON.stringify({
      projects: {
        declared: [
          { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
          { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
        ],
      },
      // `module-boundaries.config.mjs` sits at the workspace root, which no
      // declared project owns, and `.mjs` is an analyzable extension
      // (`LANGUAGE_BY_EXTENSION` in `../analysis/analyze.mjs`) — so without
      // this waiver the boundary law's own config file would be the
      // fixture's unclaimed file, which is real and not a fixture mistake:
      // any native workspace whose root carries tooling config alongside
      // `lattice.json` needs exactly this waiver or a root-level project.
      coverage: {
        exempt: [
          {
            path: "module-boundaries.config.mjs",
            reason: "workspace tooling config at the root, not itself a project",
          },
        ],
      },
    }),
  );
  writeNative(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
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
  writeNative("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeNative("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeNative("libs/adapter/adapter.go", "package adapter\n");
  writeNative("libs/adapter/README.md", "# adapter\n");
  // Same crossing as the Nx fixture above, so the two blocks prove the same
  // rule fires whichever provider supplied the graph.
  writeNative(
    "libs/domain/doc.go",
    `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
  );

  const nativeFiles = [
    "lattice.json",
    "module-boundaries.config.mjs",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
    "libs/adapter/README.md",
  ];

  /**
   * `readGraph` is deliberately absent from this context — the native branch
   * of `check()` must never call it. If a future change wired the two
   * branches together carelessly and the native path started calling the Nx
   * `readGraph` seam, this undefined function would throw the moment it was
   * reached, rather than the test silently reusing the Nx fixture's graph and
   * passing for the wrong reason.
   */
  const nativeContext = { cwd: nativeRoot, listFiles: () => nativeFiles };
  const nativeEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      ...nativeContext,
    };
  };

  it("finds the same layer-crossing Go import with no nx.json and no Nx graph", async () => {
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      nativeContext,
    );
    expect(violations).toBe(1);
    expect(report).toContain("libs/domain/doc.go:5:2  onlyTagsConstraintViolation");
  });

  it("says nothing about README.md, since it is not an analyzable file — the coverage near-miss that keeps the check usable", async () => {
    const { report, violations, unchecked } = await check(
      { format: "text", config: null, paths: [] },
      nativeContext,
    );
    expect(violations).toBe(1);
    expect(unchecked).toBe(0);
    expect(report).not.toContain("README.md");
  });

  it("exits 3 over a file no declared project owns, naming it — the unclaimed-file coverage hole", async () => {
    // The silent-direction failure this guards: an orphaned analyzable file
    // must not be dropped the way `createWorkspace` drops a file with no
    // owning project on the Nx path — it has to surface as a whole-file
    // failure and flip the exit code, exactly like an unreadable file does.
    // Scoped to `libs/adapter` so the domain→adapter crossing (a finding, not
    // a coverage hole) is not selected for analysis and does not conflate
    // exit 1 with exit 3 — the two are asserted apart in "the exit contract"
    // below, over the Nx fixture; this block only needs to prove the native
    // path reaches the same coverage-hole verdict at all.
    const streams = {
      ...nativeEnv(),
      listFiles: () => [...nativeFiles, "libs/orphan/orphan.py"],
    };
    writeNative("libs/orphan/orphan.py", "import os\n");
    expect(await runCli(["check", "libs/adapter"], streams)).toBe(EXIT.error);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("libs/orphan/orphan.py");
    expect(out).toContain("not owned by any project");
  });

  it("refuses a root carrying both nx.json and lattice.json, naming the tree rather than guessing", async () => {
    const bothRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-both-"));
    try {
      writeFileSync(join(bothRoot, "nx.json"), "{}\n");
      writeFileSync(join(bothRoot, "lattice.json"), "{}\n");
      const streams = {
        ...nativeEnv(),
        cwd: bothRoot,
        listFiles: () => ["nx.json", "lattice.json"],
      };
      expect(await runCli(["check"], streams)).toBe(EXIT.error);
      expect(streams.lines.err.join("\n")).toContain("declares both nx.json and lattice.json");
    } finally {
      rmSync(bothRoot, { recursive: true, force: true });
    }
  });
});

describe("scoping a native check must not narrow the graph it is judged against", () => {
  // The silent-direction bug this guards: on the native path `graph.dependencies`
  // is DERIVED from analyzed import sites (`./src/providers/native/graph.mjs`),
  // unlike the Nx path where `nx graph` supplies the whole workspace's
  // dependencies independent of `--paths`. Analyzing only the requested scope
  // BEFORE building the graph would drop the far side of a cycle from
  // `dependencies` entirely, and `lattice check libs/a` on this fixture would
  // exit 0 over a real a → b → a cycle — silence indistinguishable from a
  // workspace with no cycle at all.
  const cycleRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-cycle-"));
  afterAll(() => rmSync(cycleRoot, { recursive: true, force: true }));

  const writeCycle = (relativePath, text) => {
    mkdirSync(join(cycleRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(cycleRoot, relativePath), text);
  };

  writeCycle(
    "lattice.json",
    JSON.stringify({
      projects: {
        declared: [
          { root: "libs/a", name: "a", tags: ["layer:x"] },
          { root: "libs/b", name: "b", tags: ["layer:x"] },
        ],
      },
      coverage: {
        exempt: [
          {
            path: "module-boundaries.config.mjs",
            reason: "workspace tooling config at the root, not itself a project",
          },
        ],
      },
    }),
  );
  writeCycle(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:x", onlyDependOnLibsWithTags: ["layer:x"] },
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
  writeCycle("libs/a/go.mod", "module example.com/a\n\ngo 1.24\n");
  writeCycle(
    "libs/a/doc.go",
    `// Package a is one half of a cycle that only closes through b.
package a

import (
	"example.com/b"
)

var _ = b.Name
`,
  );
  writeCycle("libs/b/go.mod", "module example.com/b\n\ngo 1.24\n");
  writeCycle(
    "libs/b/doc.go",
    `// Package b closes the cycle back to a.
package b

import (
	"example.com/a"
)

var _ = a.Name
`,
  );

  const cycleFiles = [
    "lattice.json",
    "module-boundaries.config.mjs",
    "libs/a/go.mod",
    "libs/a/doc.go",
    "libs/b/go.mod",
    "libs/b/doc.go",
  ];

  const cycleContext = { cwd: cycleRoot, listFiles: () => cycleFiles };

  it("finds the a -> b -> a cycle over the whole tree", async () => {
    // Control case, unscoped: proves the fixture really is a cycle before the
    // scoped case below is trusted to say anything about scoping.
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      cycleContext,
    );
    expect(violations).toBe(2);
    expect(report).toContain("noCircularDependencies");
  });

  it("still reports the cycle when scoped to just one side of it", async () => {
    const { report, violations } = await check(
      { format: "text", config: null, paths: ["libs/a"] },
      cycleContext,
    );
    expect(violations).toBe(1);
    expect(report).toContain("libs/a/doc.go");
    expect(report).toContain("noCircularDependencies");
    // The other side of the cycle is out of scope, so it is not itself
    // reported — proving this is the real filter-after-analyze behaviour and
    // not an accidental widening that reports everything regardless of scope.
    expect(report).not.toContain("libs/b/doc.go");
  });
});

describe("a declared workspaceLayout must reach the rule engine, not just validate and vanish", () => {
  // The silent-direction bug: `lattice.json`'s `workspaceLayout` used to be
  // validated by `./src/providers/native/model.mjs` and then dropped —
  // `buildNativeGraph` never attached it to the graph object `evaluate()`
  // reads, so every native check ran against the Nx DEFAULT layout
  // (`libs`/`apps`) regardless of what a workspace actually declared. A
  // workspace using a custom `libsDir` would see an absolute import into one
  // of its own libraries reported as an unremarkable external import instead
  // of the boundary-crossing spelling it is.
  const layoutRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-layout-"));
  afterAll(() => rmSync(layoutRoot, { recursive: true, force: true }));

  const writeLayout = (relativePath, text) => {
    mkdirSync(join(layoutRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(layoutRoot, relativePath), text);
  };

  const modelWith = (workspaceLayout) =>
    JSON.stringify({
      projects: {
        declared: [
          { root: "packages/a", name: "a" },
          { root: "packages/b", name: "b" },
        ],
      },
      ...(workspaceLayout ? { workspaceLayout } : {}),
      coverage: {
        exempt: [
          {
            path: "module-boundaries.config.mjs",
            reason: "workspace tooling config at the root, not itself a project",
          },
        ],
      },
    });

  writeLayout(
    "module-boundaries.config.mjs",
    `export const depConstraints = [];
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
  writeLayout("packages/a/go.mod", "module example.com/a\n\ngo 1.24\n");
  // The specifier's literal text is what the absolute-import check reads
  // (`../rules/index.mjs`'s `imp = site.specifier`) — a custom `libsDir` of
  // `packages` makes `packages/b` an absolute path into another project's
  // library the same way a default-layout workspace reads `libs/b`.
  writeLayout(
    "packages/a/doc.go",
    `// Package a reaches b by an absolute-looking specifier.
package a

import (
	"packages/b"
)

var _ = b.Name
`,
  );
  writeLayout("packages/b/go.mod", "module example.com/b\n\ngo 1.24\n");

  const layoutFiles = [
    "module-boundaries.config.mjs",
    "packages/a/go.mod",
    "packages/a/doc.go",
    "packages/b/go.mod",
  ];

  it("with a custom libsDir declared, catches the absolute import into another library", async () => {
    writeLayout("lattice.json", modelWith({ appsDir: "applications", libsDir: "packages" }));
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      { cwd: layoutRoot, listFiles: () => [...layoutFiles, "lattice.json"] },
    );
    expect(violations).toBe(1);
    expect(report).toContain("noRelativeOrAbsoluteImportsAcrossLibraries");
  });

  it("without workspaceLayout declared, the default libs/apps layout misses it — the exact gap the declared layout must close", async () => {
    writeLayout("lattice.json", modelWith(undefined));
    const { violations } = await check(
      { format: "text", config: null, paths: [] },
      { cwd: layoutRoot, listFiles: () => [...layoutFiles, "lattice.json"] },
    );
    expect(violations).toBe(0);
  });
});

describe("the exit contract", () => {
  it("exits 1 when the tree violates a boundary — the code a hook and CI block on", async () => {
    const streams = env();
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    expect(streams.lines.out.join("\n")).toContain("libs/domain/doc.go:5:2");
  });

  it("separates a mistyped command from a failing check by exit code", () => {
    const unknown = run(["frobnicate"]);
    expect(unknown.status).toBe(EXIT.usage);
    expect(unknown.stderr).toContain("unknown command 'frobnicate'");

    const bare = run([]);
    expect(bare.status).toBe(EXIT.usage);
    expect(bare.stderr).toContain("no command given");
  });

  it("rejects a mistyped option instead of reading it as a path that selects nothing", () => {
    // `--fromat sarif` read as two paths would select no files and report a
    // clean tree: a green run that inspected nothing.
    const result = run(["check", "--fromat", "sarif"]);
    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toContain("unknown option '--fromat'");
  });

  it("distinguishes a run that could not complete from a tree that is clean", async () => {
    // Exit 3, never 0 and never 1: a checker that could not look must not be
    // mistaken for one that looked and found nothing.
    const streams = env();
    streams.cwd = mkdtempSync(join(tmpdir(), "polyglot-not-a-workspace-"));
    afterAll(() => rmSync(streams.cwd, { recursive: true, force: true }));
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    expect(streams.lines.err.join("\n")).toContain("no workspace root above");
  });

  // S9: the message used to name only `nx.json`, which pointed a native-only
  // reader (`lattice.json`, no Nx anywhere) at the wrong marker to create —
  // and creating an `nx.json` next to an existing `lattice.json` does not fix
  // the "no root found" case at all, it trades it for the dual-marker refusal
  // above. The silent-direction risk this pins: a message naming only one
  // marker reads as correct advice right up until a native-only reader acts
  // on it, so the fix has to be provable by what the string actually
  // contains, not by matching against a single word in it.
  it("names both root markers in the not-a-workspace message, not just nx.json", async () => {
    const streams = env();
    streams.cwd = mkdtempSync(join(tmpdir(), "polyglot-not-a-workspace-both-markers-"));
    afterAll(() => rmSync(streams.cwd, { recursive: true, force: true }));
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    const message = streams.lines.err.join("\n");
    expect(message).toContain("nx.json");
    expect(message).toContain("lattice.json");
  });

  it("calls a path outside the tree a usage error, since retyping it is the fix", async () => {
    const streams = env();
    expect(await runCli(["check", "/somewhere/else"], streams)).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("outside the workspace");
  });

  it("refuses to exit 0 over a file it could not analyze, because 0 is read as 'checked, and fine'", async () => {
    // The same principle as the case above, applied to a run that DID start.
    // The clean half of the tree, plus one file the analyzer never got a
    // verdict about: the summary counts it, so exit 0 would report coverage
    // this run does not have. Exit 3 — no verdict — not 1, which would claim
    // a boundary was crossed.
    const streams = {
      ...env(),
      listFiles: () => [...files, "libs/adapter/absent.go"],
    };
    expect(await runCli(["check", "libs/adapter"], streams)).toBe(EXIT.error);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("✔ no boundary violations");
    expect(report).toContain("1 file could not be analyzed at all");
    expect(report).toContain("libs/adapter/absent.go  could not be read");
  });

  it("still exits 1 when the tree is dirty AND a file could not be analyzed, since that verdict is certain", async () => {
    // Precedence matters to a caller that branches: a violation is a finding
    // it can act on, and the unanalyzed file is listed in the same report
    // either way. Only a run with no findings may be downgraded to "no
    // verdict".
    const streams = { ...env(), listFiles: () => [...files, "libs/domain/absent.go"] };
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    expect(streams.lines.out.join("\n")).toContain("could not be analyzed at all");
  });
});

describe("the option surface", () => {
  it("accepts a flag's value attached or separate, the two forms a shell produces", () => {
    expect(parseCheckArgs(["--format=sarif", "libs"])).toEqual({
      format: "sarif",
      output: null,
      config: null,
      paths: ["libs"],
    });
    expect(parseCheckArgs(["--format", "sarif"]).format).toBe("sarif");
  });

  it("names the formats it has when given one it does not", () => {
    expect(() => parseCheckArgs(["--format", "junit"])).toThrow(/expected one of text, sarif/);
  });

  it("writes the report to --output and still says on stderr what the run found", async () => {
    // The file is what CI uploads; the log line is what a human reading a red
    // job sees, and without it the job would say nothing about why it failed.
    const target = join(root, "boundaries.sarif");
    const streams = env();
    expect(await runCli(["check", "--format", "sarif", "--output", target], streams)).toBe(
      EXIT.violations,
    );
    expect(JSON.parse(readFileSync(target, "utf8")).version).toBe("2.1.0");
    expect(streams.lines.err.join("\n")).toContain("1 violation over 2 analyzed files");
  });
});

describe("the usage message", () => {
  it("prints the surface, the config it reads, and the exit codes a caller branches on", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(EXIT.ok);
    expect(result.stdout).toContain("lattice check");
    expect(result.stdout).toContain("module-boundaries.config.mjs");
    expect(result.stdout).toContain("--format text|sarif");
    expect(result.stdout).toContain("1 findings (violations, go.work drift, dead path aliases)");
  });
});

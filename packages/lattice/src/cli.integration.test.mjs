import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { check, EXIT, parseCheckArgs, runCli } from "../cli.mjs";
import { readProjectGraph } from "./providers/nx.mjs";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
// This package's own directory — the one ancestor whose `node_modules` a
// `mkdtemp` fixture can walk up to and actually reach a real, hoisted
// `@nx/eslint-plugin` install. Only used by the ESLint boundaryConfig dialect
// fixture below; every other fixture in this file needs no such plugin.
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

/** Runs the real executable, the way a shell, a hook, or CI would. */
const run = (args) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    // A bounded timeout prevents resource contention under full-suite parallel
    // load from hanging the test: the CLI help/error exits this process exits in
    // well under a second, so 30 s is generous — and without it, a slow spawn
    // blocks the thread indefinitely, which vitest's per-test timeout cannot
    // interrupt (the event loop is stuck inside the syscall). cf. #41
    timeout: 30_000,
    killSignal: "SIGKILL",
  });

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

write(
  "nx.json",
  `${JSON.stringify({
    plugins: [
      {
        plugin: "@ecoma-io/lattice/nx",
        options: { boundaryConfig: "module-boundaries.config.mjs" },
      },
    ],
  })}\n`,
);
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

  it("renders the same verdict in the JSON envelope, with goWork and tsconfigPaths named null", async () => {
    // The silent-direction pair for a workspace with neither manifest: `check`
    // must say so by naming absence explicitly (`null`), never by omitting
    // the field or defaulting it to an empty "checked" object a reader could
    // mistake for "checked, and clean". The checked-and-clean half of each
    // pair lives beside its own manifest's dedicated fixture, further down
    // this file.
    const { report, violations } = await check(
      { format: "json", config: null, paths: [] },
      context,
    );
    const envelope = JSON.parse(report);
    expect(violations).toBe(1);
    expect(envelope.status).toBe("findings");
    expect(envelope.exitCode).toBe(1);
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.imports).toBeGreaterThan(0);
    // The canonical verdict of the same counts: findings is `fail`, and the
    // decision agrees with the status by construction.
    expect(envelope.decision).toEqual({ verdict: "fail" });
    expect(envelope.result.violations).toHaveLength(1);
    expect(envelope.result.violations[0]).toMatchObject({
      sourceFile: "libs/domain/doc.go",
      line: 5,
      column: 2,
      messageId: "onlyTagsConstraintViolation",
    });
    expect(envelope.result.goWork).toBeNull();
    expect(envelope.result.tsconfigPaths).toBeNull();
  });

  it("renders the exact byte sequence for the violating fixture — a golden pin against silent format drift", async () => {
    // Every other assertion in this describe block checks a substring; this
    // one checks the whole thing, so a change that reorders a line or drops a
    // space between two of them — invisible to `toContain` — still goes red.
    const { report } = await check({ format: "text", config: null, paths: [] }, context);
    expect(report).toBe(
      [
        "libs/domain/doc.go:5:2  onlyTagsConstraintViolation",
        '    A project tagged with "layer:domain" can only depend on libs tagged with "layer:domain"',
        '  import      "example.com/adapter" (static)  domain → adapter',
        "  constraint  sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain]",
        "",
        "✖ 1 boundary violation in 1 file (1 import in 2 files across 2 projects)",
      ].join("\n"),
    );
  });

  it("agrees on the same verdict across text, sarif and json — one computation, three renderings", async () => {
    const formats = ["text", "sarif", "json"];
    const results = await Promise.all(
      formats.map((format) => check({ format, config: null, paths: [] }, context)),
    );
    for (const result of results) {
      expect(result.violations).toBe(1);
      expect(result.goWorkDrift).toBe(0);
      expect(result.tsconfigPathsDead).toBe(0);
      expect(result.unchecked).toBe(0);
    }
    const streamsPerFormat = formats.map(() => env());
    const exitCodes = await Promise.all(
      formats.map((format, index) =>
        runCli(["check", "--format", format], streamsPerFormat[index]),
      ),
    );
    expect(exitCodes).toEqual([EXIT.violations, EXIT.violations, EXIT.violations]);
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

  it("renders a clean JSON envelope, still counting the now-permitted import", async () => {
    // The other half of the pair above: `status: "ok"` requires more than
    // zero violations — it requires the coverage that earned it. A clean
    // envelope over zero analyzed imports would be indistinguishable from one
    // that skipped analysis entirely.
    const permissive = join(root, "permissive.config.mjs");
    writeFileSync(
      permissive,
      readFileSync(join(root, "module-boundaries.config.mjs"), "utf8").replace(
        '{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }',
        '{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] }',
      ),
    );
    const { report } = await check({ format: "json", config: permissive, paths: [] }, context);
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.imports).toBeGreaterThan(0);
    expect(envelope.result.violations).toEqual([]);
    // A fully-read, clean tree carries the `pass` decision — complete
    // coverage plus zero findings, the only counts that earn it.
    expect(envelope.decision).toEqual({ verdict: "pass" });
  });

  it("pins every field of the violation object in the JSON envelope", async () => {
    // Five fields — `constraint`, `specifier`, `kind`, `sourceProject`,
    // `targetProject` — could silently disappear from the JSON output and no
    // existing test would notice. The text golden test catches format drift in
    // text; this test catches structural drift in JSON.
    const { report } = await check({ format: "json", config: null, paths: [] }, context);
    const envelope = JSON.parse(report);
    expect(envelope.result.violations).toHaveLength(1);
    expect(envelope.result.violations[0]).toEqual({
      sourceFile: "libs/domain/doc.go",
      line: 5,
      column: 2,
      specifier: "example.com/adapter",
      kind: "static",
      messageId: "onlyTagsConstraintViolation",
      message: expect.any(String),
      sourceProject: "domain",
      targetProject: "adapter",
      constraint: { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
      data: expect.any(Object),
    });
  });

  it("pins the SARIF property-bag fields that carry project and import metadata", async () => {
    // SARIF carries `specifier`, `importKind`, `sourceProject`, and
    // `targetProject` in the `properties` bag — none of the existing SARIF
    // tests pin these values against the fixture. A formatter change that
    // dropped them would be invisible.
    const { report } = await check({ format: "sarif", config: null, paths: [] }, context);
    const result = JSON.parse(report).runs[0].results[0];
    expect(result.properties.specifier).toBe("example.com/adapter");
    expect(result.properties.importKind).toBe("static");
    expect(result.properties.sourceProject).toBe("domain");
    expect(result.properties.targetProject).toBe("adapter");
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

  it("carries the clean agreement into the JSON envelope as goWork.checked with no findings", async () => {
    // The checked-and-clean half of the null/checked pair: a workspace WITH a
    // go.work that agrees with the graph must say `checked: true, findings:
    // []` — never `null`, which is reserved for "no go.work at all"
    // (`checking a real tree` above pins that half).
    writeWork("go.work", "go 1.24\n\nuse (\n\t./libs/store\n\t./libs/pricing\n)\n");
    const { report, goWorkDrift } = await check(
      { format: "json", config: null, paths: [] },
      workContext,
    );
    expect(goWorkDrift).toBe(0);
    const envelope = JSON.parse(report);
    expect(envelope.result.goWork).toEqual({ checked: true, findings: [] });
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

  it("exits 3 on a go.work that is not a go.work file at all, not a clean agreement — audit P1-03", async () => {
    // The exact shape the audit reported: a go.work fetched through a
    // redirect that actually served an HTML error page tokenizes with no
    // unterminated block or string, so before the keyword validation this
    // fix adds, every line fell through the "future directive" skip and the
    // file read as zero `use` entries — exit 0, "go.work agrees with the
    // project graph", an affirmative claim about a file that was never
    // really read (the finding's own evidence). It must refuse a verdict
    // instead, the same as the unclosed-block case above.
    writeWork(
      "go.work",
      "<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head>\n<body>404 Not Found</body></html>\n",
    );
    const streams = workEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("could not be analyzed at all");
    expect(report).toContain("go.work:1: unknown directive: <!DOCTYPE");
    expect(report).not.toContain("goWorkMissingUse");
    expect(report).not.toContain("agrees with the project graph");
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

describe("the go.work drift check in a workspace with no Go projects at all", () => {
  // Audit finding P1-03's exact evidence, reproduced end to end rather than
  // only at the parser: a workspace whose graph carries zero go.mod projects
  // has nothing on either side of `compareGoWork` to disagree about, so
  // before the keyword validation this fix adds, an unparseable go.work here
  // — HTML from a redirect, say — parsed to zero `use` entries and compared
  // clean against zero module projects: exit 0, "✔ go.work agrees with the
  // project graph", `checked: true` in the JSON envelope. An affirmative
  // claim about a file the run never actually read. This fixture has no
  // go.mod anywhere, on purpose, so that false agreement is the ONLY way
  // this go.work could have read as clean.
  const noGoRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-gowork-notgowork-"));
  afterAll(() => rmSync(noGoRoot, { recursive: true, force: true }));

  const writeNoGo = (relativePath, text) => {
    mkdirSync(join(noGoRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(noGoRoot, relativePath), text);
  };

  writeNoGo("nx.json", "{}\n");
  writeNoGo(
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
  writeNoGo(
    "go.work",
    "<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head>\n<body>404 Not Found</body></html>\n",
  );

  const noGoContext = {
    cwd: noGoRoot,
    readGraph: () => ({ nodes: {}, dependencies: {} }),
    listFiles: () => ["nx.json", "module-boundaries.config.mjs", "go.work"],
  };

  const noGoEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      ...noGoContext,
    };
  };

  it("exits 3 instead of the false 'agrees with the project graph' the finding reported", async () => {
    const streams = noGoEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("could not be analyzed at all");
    expect(report).toContain("go.work:1: unknown directive: <!DOCTYPE");
    expect(report).not.toContain("agrees with the project graph");
  });

  it("counts the refusal as an uncovered file in the JSON envelope, never a silent checked: true", async () => {
    // `goWork` itself reads `null` either way — the same value a workspace
    // with no go.work at all would carry — so `unchecked` is the field that
    // must disambiguate "nothing to check" from "could not check this".
    const { goWorkDrift, unchecked } = await check(
      { format: "json", config: null, paths: [] },
      noGoContext,
    );
    expect(goWorkDrift).toBe(0);
    expect(unchecked).toBeGreaterThan(0);
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

  it("carries the alive alias into the JSON envelope as tsconfigPaths.checked with no findings", async () => {
    // The checked-and-clean half of the null/checked pair: a workspace with a
    // `paths` table whose every alias resolves must say `checked: true,
    // findings: []` — never `null`, which is reserved for "no `paths` table
    // at all" (`checking a real tree` above pins that half).
    writeAlias("tsconfig.base.json", tsconfig({ paths: { "@shop/store/*": ["libs/store/*"] } }));
    const { report, tsconfigPathsDead } = await check(
      { format: "json", config: null, paths: [] },
      aliasContext,
    );
    expect(tsconfigPathsDead).toBe(0);
    const envelope = JSON.parse(report);
    expect(envelope.result.tsconfigPaths).toEqual({ checked: true, findings: [] });
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
  // A tracked intent: without it, `drift` refuses ("drift is about a declared
  // intent"). Boundaries-only, with no allowed/forbidden rows — the two
  // boundaries each match one observed project, so the comparison is clean
  // without stating an opinion that would contradict the boundary law below
  // (which forbids domain→adapter). The `--output` path is what this block
  // pins.
  writeNative(
    "architecture-intent.json",
    JSON.stringify(
      {
        version: "1",
        boundaries: [
          { name: "domain", match: ["name:domain"] },
          { name: "adapter", match: ["name:adapter"] },
        ],
      },
      null,
      2,
    ),
  );
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
    "architecture-intent.json",
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

  it("writes a drift report to --output atomically, and names the fact on stderr", async () => {
    // The `--output` branch of `runDrift`: write to `<target>.tmp`, rename over
    // the target, print the comparison fact on stderr. Neither a `<target>.tmp`
    // left behind nor a missing/truncated target may survive the run, because
    // a report that half-appeared is the silent direction.
    const target = join(nativeRoot, "drift.json");
    const streams = nativeEnv();
    expect(await runCli(["drift", "--format", "json", "--output", target], streams)).toBe(EXIT.ok);
    expect(existsSync(`${target}.tmp`)).toBe(false);
    expect(streams.lines.err.join("\n")).toContain("1 edges → ");
    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written.command).toBe("drift");
    expect(written.result.intent.file).toBe("architecture-intent.json");
    expect(written.result.findings).toHaveLength(0);
    expect(written.coverage.complete).toBe(true);
  });

  it("--output refuses rather than writes through a symlink planted at <target>.tmp", async () => {
    // Every value in `--output` and every value in a report body — a project
    // name, an import specifier — comes from the tree being judged and is
    // attacker-supplied the moment a pull request adds one. Before
    // `writeOutputReport`'s `{flag: "wx"}` guard, a tracked symlink at
    // `<target>.tmp` made the write follow it and overwrite whatever the
    // symlink named, with attacker-chosen bytes, while reporting success.
    const outside = mkdtempSync(join(tmpdir(), "polyglot-cli-output-outside-"));
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "must not be touched\n");
    const target = join(nativeRoot, "planted.json");
    symlinkSync(secret, `${target}.tmp`);
    try {
      const streams = nativeEnv();
      expect(await runCli(["graph", "--format", "json", "--output", target], streams)).toBe(
        EXIT.error,
      );
      expect(streams.lines.err.join("\n")).toContain("could not write --output");
      // The symlink is left exactly as it was — refusing means never opening
      // the write, so there is nothing this run created to clean up.
      expect(lstatSync(`${target}.tmp`).isSymbolicLink()).toBe(true);
      expect(readFileSync(secret, "utf8")).toBe("must not be touched\n");
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(`${target}.tmp`, { force: true });
    }
  });

  it("--output refuses rather than silently truncating a pre-existing <target>.tmp", async () => {
    // The same guard's other half: a stray `.tmp` from a crashed prior run —
    // or any file that happens to collide with the name — used to be
    // silently overwritten and then renamed away. It must survive instead,
    // and the run must say so rather than reporting success over it.
    const target = join(nativeRoot, "collides.json");
    writeFileSync(`${target}.tmp`, "pre-existing data, not this run's to destroy\n");
    try {
      const streams = nativeEnv();
      expect(await runCli(["graph", "--format", "json", "--output", target], streams)).toBe(
        EXIT.error,
      );
      expect(readFileSync(`${target}.tmp`, "utf8")).toBe(
        "pre-existing data, not this run's to destroy\n",
      );
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(`${target}.tmp`, { force: true });
    }
  });

  it("--output refuses rather than silently overwriting the tracked architecture-intent.json", async () => {
    // `{flag: "wx"}` above protects the `.tmp` intermediate; it says nothing
    // about the FINAL name, and `renameSync` replaces whatever already sits
    // there unconditionally. Before `governanceOutputTargets`, `lattice check
    // --output architecture-intent.json` — a copy-pasted flag, a typo'd
    // path, or a CI script a pull request edited — silently replaced the
    // tracked intent this fixture declares above with a check report, exit 0
    // (P1-24's own example command). The write must never even attempt a
    // `.tmp` file at this target: refused before either name is touched.
    const target = join(nativeRoot, "architecture-intent.json");
    const before = readFileSync(target, "utf8");
    const streams = nativeEnv();
    expect(await runCli(["check", "--format", "json", "--output", target], streams)).toBe(
      EXIT.error,
    );
    expect(streams.lines.err.join("\n")).toContain("resolves to 'architecture-intent.json'");
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("--output refuses rather than silently overwriting the tracked lattice.json", async () => {
    const target = join(nativeRoot, "lattice.json");
    const before = readFileSync(target, "utf8");
    const streams = nativeEnv();
    expect(await runCli(["graph", "--format", "json", "--output", target], streams)).toBe(
      EXIT.error,
    );
    expect(streams.lines.err.join("\n")).toContain("resolves to 'lattice.json'");
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("--output refuses rather than silently overwriting the workspace's boundary-law file", async () => {
    // The un-overridden default name (`DEFAULT_OPTIONS.boundaryConfig`) —
    // this fixture never renames it via `--config`. Silently overwriting it
    // would also corrupt the very `module-boundaries.config.mjs` every other
    // `--config` test in this file `import()`s, which is exactly why THOSE
    // tests are careful to write a separate filename instead (see the next
    // test's own comment).
    const target = join(nativeRoot, "module-boundaries.config.mjs");
    const before = readFileSync(target, "utf8");
    const streams = nativeEnv();
    expect(await runCli(["graph", "--format", "json", "--output", target], streams)).toBe(
      EXIT.error,
    );
    expect(streams.lines.err.join("\n")).toContain("resolves to 'module-boundaries.config.mjs'");
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("--output still overwrites an ordinary, previously-written report — the documented CI reuse", async () => {
    // The governance guard above is deliberately narrow. `docs/usage/ci.md`'s
    // own recipe reruns `--output boundaries.json` on every push, relying on
    // the previous run's file being silently replaced — this is the
    // negative-space proof the new guard did not widen into refusing every
    // pre-existing target, only the fixed governance names.
    const target = join(nativeRoot, "reused-report.json");
    const first = nativeEnv();
    expect(await runCli(["graph", "--format", "json", "--output", target], first)).toBe(EXIT.ok);
    expect(existsSync(target)).toBe(true);
    const second = nativeEnv();
    expect(await runCli(["graph", "--format", "json", "--output", target], second)).toBe(EXIT.ok);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("folds a declared fitness function into the check verdict — a coverage-minimum over owned files", async () => {
    // A SEPARATE config filename, never `module-boundaries.config.mjs`: that
    // file was already `import()`ed during the describe-block setup, and ES
    // module import caching means a rewritten copy is not what the next
    // `loadBoundaryConfig` call reads. A fresh filename is imported clean.
    // The native fixture owns exactly two analyzable files (both `.go`), and
    // the analysis analyzed both, so a 100%-coverage minimum passes.
    writeNative(
      "fitness-full.config.mjs",
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
export const fitness = [
  {
    name: "full-coverage",
    match: ["*"],
    condition: { type: "coverage-minimum", statement: 100 },
    reason: "every owned file must be analyzed",
  },
];
`,
    );
    const { report, violations, unchecked } = await check(
      { format: "text", config: "fitness-full.config.mjs", paths: [] },
      nativeContext,
    );
    // Both files are analyzed; the layer crossing (domain→adapter) is still
    // a real boundary finding, and the fitness verdict is independent of it.
    expect(violations).toBe(1);
    expect(unchecked).toBe(0);
    expect(report).toContain("✔ full-coverage");
    expect(report).toContain("2/2 files analyzed (100%)");
  });

  it("exits 3 when a declared fitness function cannot be determined — never a pass", async () => {
    writeNative(
      "fitness-unknown.config.mjs",
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
export const fitness = [
  {
    name: "no-domain-yet",
    match: ["*"],
    condition: { type: "layer-dependency", from: "layer:service", to: "layer:domain", direction: "required" },
    reason: "a service layer will need the domain",
  },
];
`,
    );
    // Scoped to `libs/adapter` so the fixture's real domain→adapter crossing
    // (a findings-axis red, which would win the verdict) is not selected for
    // analysis — this test pins the no-verdict lane alone. The `--config`
    // flag loads the fresh config by path.
    const streams = nativeEnv();
    expect(
      await runCli(["check", "--config", "fitness-unknown.config.mjs", "libs/adapter"], streams),
    ).toBe(EXIT.error);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("⚠ no-domain-yet");
    expect(out).toContain("no matched project carries tag");
  });

  it("exits 3 when a path-scoped run hides whole-file coverage — the scoped flag must reach coverage-minimum as unknown, never pass", async () => {
    // P0-1 regression: `fitnessSnapshot` used to put `scoped` on the snapshot's
    // top level, where `judgeFitnessRow` never read it — so `check libs/adapter`
    // over a `coverage-minimum` fitness claimed `pass` over the one file it
    // actually analyzed, the silent direction. The flag now rides inside
    // `analysis`, and the run must exit 3 naming scope instead of claiming full
    // coverage.
    writeNative(
      "fitness-scoped.config.mjs",
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
export const fitness = [
  {
    name: "scoped-coverage",
    match: ["*"],
    condition: { type: "coverage-minimum", statement: 100 },
    reason: "scoping must never read as full coverage",
  },
];
`,
    );
    const streams = nativeEnv();
    // `libs/adapter` scopes the run to one project's files; the other project's
    // files were not analyzed, so whole-tree coverage is not determinable. The
    // domain→adapter crossing is excluded the same way the no-verdict test
    // excludes it, so exit 3 here is the scope verdict, not a boundary finding.
    expect(
      await runCli(["check", "--config", "fitness-scoped.config.mjs", "libs/adapter"], streams),
    ).toBe(EXIT.error);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("⚠ scoped-coverage");
    expect(out).toContain("was scoped to specific paths");
  });

  it("judges drift-free against the verdict-shaped intent, not the raw file — a clean intent passes, never fail", async () => {
    // P0-2 regression: the `fitness` command used to hand `loadIntent`'s raw
    // normalized model (no `verdict`/`findings`/`unresolved`) to the
    // `drift-free` rule, whose final branch read `verdict === undefined` as
    // `fail` — so a clean intent reported `✖ drift-free` over "0 findings".
    // The command now reuses `driftForCheck`'s verdict-shaped intent, the same
    // one `check`'s fold builds. The native fixture tracks an
    // `architecture-intent.json` whose boundaries match the observed projects,
    // so the comparison is clean and the function must PASS.
    writeNative(
      "fitness-drift.config.mjs",
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
export const fitness = [
  {
    name: "intent-clean",
    match: ["*"],
    condition: { type: "drift-free" },
    reason: "this workspace declares an intent and must not drift from it",
  },
];
`,
    );
    const streams = nativeEnv();
    expect(await runCli(["fitness", "--config", "fitness-drift.config.mjs"], streams)).toBe(
      EXIT.ok,
    );
    const out = streams.lines.out.join("\n");
    expect(out).toContain("✔ intent-clean");
    expect(out).toContain("matches the observed graph");
  });

  it("exits 3 when the graph cannot see the workspace — the fitness command must not fold an incomplete-graph refusal into a verdict", async () => {
    // R2-Major regression: `fitnessCommand` used to wrap `driftForCheck` in a
    // catch-all that converted its fail-closed throw (an Nx workspace whose
    // `nx.json` does not register this plugin but whose tracked files include
    // polyglot manifests) into a `no-verdict` intent with exit 0. Every other
    // read-only command (`drift`, `graph`, `impact`, `explain`) exits 3 for
    // this same condition — a graph that cannot see the workspace must never
    // be judged as if it did. The command now lets the throw propagate, so the
    // run exits 3 naming the refusal.
    const root = mkdtempSync(join(tmpdir(), "fitness-cli-unregistered-"));
    try {
      const writeUnreg = (relativePath, text) => {
        mkdirSync(join(root, relativePath, ".."), { recursive: true });
        writeFileSync(join(root, relativePath), text);
      };
      writeUnreg("nx.json", JSON.stringify({})); // No plugins entry.
      writeUnreg(
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
export const fitness = [
  {
    name: "intent-clean",
    match: ["*"],
    condition: { type: "drift-free" },
    reason: "must not be judged over a graph that cannot see the workspace",
  },
];
`,
      );
      writeUnreg("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
      writeUnreg("libs/domain/doc.go", "package domain\n");
      const graph = {
        nodes: {
          domain: {
            name: "domain",
            type: "lib",
            data: { root: "libs/domain", tags: [] },
          },
        },
        dependencies: { domain: [] },
      };
      const files = [
        "nx.json",
        "module-boundaries.config.mjs",
        "libs/domain/go.mod",
        "libs/domain/doc.go",
      ];
      const streams = {
        out: (t) => streams.lines.out.push(t),
        err: (t) => streams.lines.err.push(t),
        lines: { out: [], err: [] },
        cwd: root,
        readGraph: () => graph,
        listFiles: () => files,
      };
      expect(await runCli(["fitness"], streams)).toBe(EXIT.error);
      const report = streams.lines.out.join("\n") + streams.lines.err.join("\n");
      expect(report).toContain("refusing to judge drift");
      expect(report).toContain("go.mod");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not crash when fitness is declared with no architecture-intent.json anywhere — the supported configuration where fitness lives in the policy file alone", async () => {
    // P1-14 regression: `fitnessCommand` called `driftForCheck` unconditionally
    // and built its own verdict-shaped `intent` straight from the result, so a
    // workspace that legitimately has no architecture-intent.json (fully
    // supported — fitness needs no intent file to run) reached
    // `judgeIntent(undefined, ...)` inside `driftForCheck`, which dereferenced
    // `intent.boundaries` on `undefined` and threw a raw, unhandled
    // `TypeError: Cannot read properties of undefined (reading 'boundaries')`
    // straight out to the operator instead of a verdict or a named refusal.
    // A self-contained fixture — never the shared `nativeRoot`/`nativeContext`
    // above, which always tracks an architecture-intent.json for the drift
    // tests — is the only way to exercise "fitness declared, no intent file at
    // all". One row needs no intent (`coverage-minimum`) and must still
    // evaluate normally; one row DOES need intent (`drift-free`) and must read
    // `unknown` — "cannot judge" — never a crash and never a false `pass`.
    const root = mkdtempSync(join(tmpdir(), "fitness-no-intent-"));
    try {
      const writeFixture = (relativePath, text) => {
        mkdirSync(join(root, relativePath, ".."), { recursive: true });
        writeFileSync(join(root, relativePath), text);
      };
      writeFixture(
        "lattice.json",
        JSON.stringify({
          projects: {
            declared: [{ root: "libs/domain", name: "domain", tags: ["layer:domain"] }],
          },
          // `module-boundaries.config.mjs` sits at the workspace root, which no
          // declared project owns — the same waiver the shared native fixture
          // above needs and explains.
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
      writeFixture(
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
export const fitness = [
  {
    name: "full-coverage",
    match: ["*"],
    condition: { type: "coverage-minimum", statement: 100 },
    reason: "every owned file must be analyzed",
  },
  {
    name: "intent-clean",
    match: ["*"],
    condition: { type: "drift-free" },
    reason: "must read unknown, never crash and never pass, with no intent file declared",
  },
];
`,
      );
      writeFixture("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
      writeFixture("libs/domain/doc.go", "package domain\n");
      // No architecture-intent.json anywhere in the fixture or its tracked-file
      // list — the exact condition the audit named.
      const files = [
        "lattice.json",
        "module-boundaries.config.mjs",
        "libs/domain/go.mod",
        "libs/domain/doc.go",
      ];
      const streams = {
        out: (t) => streams.lines.out.push(t),
        err: (t) => streams.lines.err.push(t),
        lines: { out: [], err: [] },
        cwd: root,
        listFiles: () => files,
      };
      expect(await runCli(["fitness"], streams)).toBe(EXIT.ok);
      const report = streams.lines.out.join("\n") + streams.lines.err.join("\n");
      expect(report).not.toContain("Cannot read properties of undefined");
      expect(report).not.toContain("TypeError");
      expect(report).toContain("✔ full-coverage");
      expect(report).toContain("⚠ intent-clean");
      expect(report).toContain("cannot judge drift-free — no architecture-intent.json is declared");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe("coverage.exempt is disclosed, not only enforced", () => {
  // `judgeCoverage` (`./providers/native/coverage.mjs`) always computed which
  // files a `coverage.exempt` row removed from `unclaimed` — the list existed
  // three layers deep and stopped there: `discover()` dropped it before
  // `check()` ever saw it, so an exempted file and a genuinely covered one
  // were byte-for-byte indistinguishable in the text report and in
  // `--format json`. A workspace could exempt an unbounded number of files,
  // forever, and nothing would ever say so. This block proves the count now
  // reaches both surfaces, without changing the exit code `coverage.exempt`
  // is meant to produce — the fixture below is otherwise clean, so exit 0 is
  // correct both before and after; what changes is whether the run says why
  // one of its two tracked files was never analyzed.
  const exemptRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-exempt-"));
  afterAll(() => rmSync(exemptRoot, { recursive: true, force: true }));

  const writeExempt = (relativePath, text) => {
    mkdirSync(join(exemptRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(exemptRoot, relativePath), text);
  };

  writeExempt(
    "lattice.json",
    JSON.stringify({
      projects: { declared: [{ root: "libs/kept", name: "kept", tags: [] }] },
      // The boundary law's own config file sits at the workspace root, which
      // no declared project owns — exempted here too, or it would be a
      // second, unrelated unclaimed file this fixture never meant to test.
      coverage: {
        exempt: [
          { path: "module-boundaries.config.mjs", reason: "workspace tooling, not a project" },
          { path: "libs/vendored/**", reason: "vendored third-party, checked upstream" },
        ],
      },
    }),
  );
  writeExempt(
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
  writeExempt("libs/kept/go.mod", "module example.com/kept\n\ngo 1.24\n");
  writeExempt("libs/kept/kept.go", "package kept\n");
  // Owned by no declared project, and would fail the run (exit 3, "not owned
  // by any project") without the exempt row above — this is the file the
  // exemption is legitimately for, not a fixture mistake.
  writeExempt("libs/vendored/vendored.go", "package vendored\n");

  const exemptContext = {
    cwd: exemptRoot,
    listFiles: () => [
      "lattice.json",
      "module-boundaries.config.mjs",
      "libs/kept/go.mod",
      "libs/kept/kept.go",
      "libs/vendored/vendored.go",
    ],
  };

  it("names the exempted count on the summary line", async () => {
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      exemptContext,
    );
    expect(violations).toBe(0);
    expect(report).toContain("2 files exempted from coverage by lattice.json's coverage.exempt");
  });

  it("carries the same note in the JSON envelope's coverage.notes", async () => {
    const { report } = await check({ format: "json", config: null, paths: [] }, exemptContext);
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("ok");
    expect(envelope.coverage.notes).toContain(
      "2 files exempted from coverage by lattice.json's coverage.exempt",
    );
  });
});

describe("the unclaimed-file coverage hole, on the Nx and Moon providers too", () => {
  // P1-12: the native fixture above ("exits 3 over a file no declared project
  // owns, naming it") already proves native's own posture; this block proves
  // the Nx and Moon branches now reach the identical verdict over the
  // identical shape of tree, where they used to exit 0 with `coverage.complete:
  // true` — a tracked, analyzable file no declared project's root covers was
  // simply never selected for analysis, never counted, and never mentioned.
  // Each fixture is a small, self-contained tmpdir with one project and one
  // file sitting outside it — scoped to the declared project's own directory,
  // the same scoped-run rigor the native fixture's regression test applies,
  // so the orphan elsewhere in the tree cannot be hidden by naming a path
  // that excludes it.
  const permissiveBoundaryConfig = `export const depConstraints = [];
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
`;

  it("exits 3 over a tracked Go file outside every declared Nx project, naming it — same posture as native", async () => {
    const nxRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-nx-unclaimed-"));
    try {
      const writeNx = (relativePath, text) => {
        mkdirSync(join(nxRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(nxRoot, relativePath), text);
      };
      writeNx("nx.json", "{}\n");
      writeNx("module-boundaries.config.mjs", permissiveBoundaryConfig);
      writeNx("libs/a/a.go", "package a\n");
      writeNx("libs/orphan/orphan.go", "package orphan\n");
      const graph = {
        nodes: { a: { name: "a", type: "lib", data: { root: "libs/a", tags: [] } } },
        dependencies: { a: [] },
      };
      const streams = {
        out: (t) => streams.lines.out.push(t),
        err: (t) => streams.lines.err.push(t),
        lines: { out: [], err: [] },
        cwd: nxRoot,
        readGraph: () => graph,
        listFiles: () => [
          "nx.json",
          "module-boundaries.config.mjs",
          "libs/a/a.go",
          "libs/orphan/orphan.go",
        ],
      };
      expect(await runCli(["check", "libs/a"], streams)).toBe(EXIT.error);
      const out = streams.lines.out.join("\n");
      expect(out).toContain("libs/orphan/orphan.go");
      expect(out).toContain("not owned by any project");
    } finally {
      rmSync(nxRoot, { recursive: true, force: true });
    }
  });

  it("exits 3 over a tracked Go file outside every declared Moon project, naming it — same posture as native", async () => {
    const moonRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-moon-unclaimed-"));
    try {
      const writeMoon = (relativePath, text) => {
        mkdirSync(join(moonRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(moonRoot, relativePath), text);
      };
      writeMoon(".moon/workspace.yml", "projects:\n  a: libs/a\n");
      writeMoon("module-boundaries.config.mjs", permissiveBoundaryConfig);
      writeMoon("libs/a/a.go", "package a\n");
      writeMoon("libs/orphan/orphan.go", "package orphan\n");
      const graph = {
        nodes: { a: { name: "a", type: "lib", data: { root: "libs/a", tags: [] } } },
        dependencies: { a: [] },
      };
      const streams = {
        out: (t) => streams.lines.out.push(t),
        err: (t) => streams.lines.err.push(t),
        lines: { out: [], err: [] },
        cwd: moonRoot,
        readGraph: () => graph,
        listFiles: () => [
          ".moon/workspace.yml",
          "module-boundaries.config.mjs",
          "libs/a/a.go",
          "libs/orphan/orphan.go",
        ],
      };
      expect(await runCli(["check", "libs/a"], streams)).toBe(EXIT.error);
      const out = streams.lines.out.join("\n");
      expect(out).toContain("libs/orphan/orphan.go");
      expect(out).toContain("not owned by any project");
    } finally {
      rmSync(moonRoot, { recursive: true, force: true });
    }
  });

  it("reports coverage.complete: false and status no-verdict in the JSON envelope over the Nx orphan, never status ok", async () => {
    // The JSON twin of the exit-code assertion above: a caller branching on
    // `coverage.complete` or `status` alone must see the same refusal a
    // caller branching on the exit code sees — this is the exact asymmetry
    // the finding names ("exit 3 under native and exit 0 with complete: true
    // under Nx and Moon").
    const nxRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-nx-unclaimed-json-"));
    try {
      const writeNx = (relativePath, text) => {
        mkdirSync(join(nxRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(nxRoot, relativePath), text);
      };
      writeNx("nx.json", "{}\n");
      writeNx("module-boundaries.config.mjs", permissiveBoundaryConfig);
      writeNx("libs/a/a.go", "package a\n");
      writeNx("libs/orphan/orphan.go", "package orphan\n");
      const graph = {
        nodes: { a: { name: "a", type: "lib", data: { root: "libs/a", tags: [] } } },
        dependencies: { a: [] },
      };
      const { report } = await check(
        { format: "json", config: null, paths: [] },
        {
          cwd: nxRoot,
          readGraph: () => graph,
          listFiles: () => [
            "nx.json",
            "module-boundaries.config.mjs",
            "libs/a/a.go",
            "libs/orphan/orphan.go",
          ],
        },
      );
      const envelope = JSON.parse(report);
      expect(envelope.status).toBe("no-verdict");
      expect(envelope.exitCode).toBe(3);
      expect(envelope.coverage.complete).toBe(false);
      expect(envelope.coverage.notAnalyzed).toEqual([
        {
          file: "libs/orphan/orphan.go",
          reason: expect.stringContaining("not owned by any project"),
        },
      ]);
      expect(envelope.decision.verdict).toBe("unknown");
    } finally {
      rmSync(nxRoot, { recursive: true, force: true });
    }
  });
});

describe("check judges a declared edge with no import site behind it", () => {
  // `evaluate()` iterates only import sites (`src/rules/README.md`: "analysis
  // records and the loaded config, nothing else"), so an `implicitDependencies`
  // edge — declared, never written as an import — reached no rule at all
  // before this fix: `check` reported a clean tree while `context`/`impact`
  // (walking `graph.dependencies` directly) already showed the same edge as a
  // tag violation. `domain` here declares `implicitDependencies: ["adapter"]`
  // and carries NO Go import of `adapter` anywhere — the fixture's only edge
  // is the declared one — so a violation only appears if `check` judges
  // declared edges at all.
  const declaredRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-declared-edge-"));
  afterAll(() => rmSync(declaredRoot, { recursive: true, force: true }));

  const writeDeclared = (relativePath, text) => {
    mkdirSync(join(declaredRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(declaredRoot, relativePath), text);
  };

  writeDeclared(
    "lattice.json",
    JSON.stringify({
      projects: {
        declared: [
          {
            root: "libs/domain",
            name: "domain",
            tags: ["layer:domain"],
            implicitDependencies: ["adapter"],
          },
          { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
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
  writeDeclared(
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
  writeDeclared("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  // No import of adapter anywhere — the only edge this fixture has is the
  // `implicitDependencies` row above.
  writeDeclared("libs/domain/doc.go", "package domain\n");
  writeDeclared("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeDeclared("libs/adapter/adapter.go", "package adapter\n");

  const declaredContext = {
    cwd: declaredRoot,
    listFiles: () => [
      "lattice.json",
      "module-boundaries.config.mjs",
      "libs/domain/go.mod",
      "libs/domain/doc.go",
      "libs/adapter/go.mod",
      "libs/adapter/adapter.go",
    ],
  };

  it("fails the run and names the declared edge, with no import-site violations", async () => {
    const { report, violations, declaredEdgeFindings } = await check(
      { format: "text", config: null, paths: [] },
      declaredContext,
    );
    // The silent-direction proof: evaluate()'s own import-site path finds
    // nothing (there is no import), yet the run still fails.
    expect(violations).toBe(0);
    expect(declaredEdgeFindings).toBe(1);
    expect(report).toContain("onlyTagsConstraintViolation");
    expect(report).toContain("domain → adapter");
    expect(report).toContain("declared-edge violations: 1 finding");
  });

  it("carries the finding in the JSON envelope's result.declaredEdges, exit 1", async () => {
    const { report } = await check({ format: "json", config: null, paths: [] }, declaredContext);
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("findings");
    expect(envelope.exitCode).toBe(EXIT.violations);
    expect(envelope.result.violations).toEqual([]);
    expect(envelope.result.declaredEdges.judged).toBe(1);
    expect(envelope.result.declaredEdges.findings).toHaveLength(1);
    expect(envelope.result.declaredEdges.findings[0]).toMatchObject({
      messageId: "onlyTagsConstraintViolation",
      source: "domain",
      target: "adapter",
      file: "lattice.json",
    });
  });

  it("runCli exits 1 through the same real dispatch a CI pipeline uses", async () => {
    const out = [];
    const err = [];
    const env = { out: (t) => out.push(t), err: (t) => err.push(t), ...declaredContext };
    const exitCode = await runCli(["check"], env);
    expect(exitCode).toBe(EXIT.violations);
    expect(out.join("\n")).toContain("onlyTagsConstraintViolation");
  });
});

describe("the waivers surface, end to end", () => {
  // A third native tmpdir whose boundary law carries a `boundarySuppressions`
  // waiver row over the same layer-crossing import, so the whole pipeline is
  // exercised: the config validator accepts the extended row, `check` reports
  // the waived count, and `waivers` lists the surface with its term.
  const waiversRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-waivers-"));
  afterAll(() => rmSync(waiversRoot, { recursive: true, force: true }));

  const writeWaivers = (relativePath, text) => {
    mkdirSync(join(waiversRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(waiversRoot, relativePath), text);
  };

  writeWaivers(
    "lattice.json",
    JSON.stringify({
      projects: {
        declared: [
          { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
          { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
        ],
      },
      // The root config file is workspace tooling, not a project — an
      // unclaimed file becomes a whole-file failure, and a command that
      // refuses incomplete coverage (waivers now among them) would otherwise
      // read this tree as "could not look". Same reason every native fixture
      // that asserts a completed verdict names its config here. The `--config`
      // test's `alt-boundaries.mjs` is NOT exempted: it is written mid-run and
      // never listed in the tracked files, so coverage never sees it — and an
      // exemption naming a file that exists in no unclaimed set is itself a
      // config error.
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
  writeWaivers(
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
export const boundarySuppressions = [
  {
    path: "libs/domain/doc.go",
    reason: "the adapter seam lands next release",
    expiresAt: "2999-01-01T00:00:00.000Z",
    origin: "ticket-42",
  },
];
`,
  );
  writeWaivers("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeWaivers(
    "libs/domain/doc.go",
    `package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
  );
  writeWaivers("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeWaivers("libs/adapter/adapter.go", "package adapter\n");

  const waiversFiles = [
    "lattice.json",
    "module-boundaries.config.mjs",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
  ];

  const waiversContext = { cwd: waiversRoot, listFiles: () => waiversFiles };
  const waiversEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      ...waiversContext,
    };
  };

  it("waivers exits 0, lists the active waiver with its term and the violation it covers", async () => {
    const streams = waiversEnv();
    expect(await runCli(["waivers"], streams)).toBe(EXIT.ok);
    const text = streams.lines.out.join("\n");
    expect(text).toContain("1 waiver on the table");
    expect(text).toContain("libs/domain/doc.go");
    expect(text).toContain("1 current violation");
    expect(text).toContain("2999-01-01T00:00:00.000Z");
    expect(text).toContain("origin: ticket-42");
    expect(text).toContain("reason: the adapter seam lands next release");
  });

  it("waivers --format json writes the envelope with the term facts", async () => {
    const streams = waiversEnv();
    expect(await runCli(["waivers", "--format", "json"], streams)).toBe(EXIT.ok);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.command).toBe("waivers");
    expect(envelope.status).toBe("ok");
    expect(envelope.result.waivers).toHaveLength(1);
    expect(envelope.result.waivers[0].status).toBe("active");
    expect(envelope.result.waivers[0].expiresAt).toBe("2999-01-01T00:00:00.000Z");
  });

  it("waivers --config reads the law from the named file, resolving against cwd", async () => {
    // The waiver surface rides the boundary law, so `--config` must pick a
    // different law for one run exactly as it does for `check` — a flag the
    // same run's `check` would honour, kept in the loop by a flag test.
    writeWaivers(
      "alt-boundaries.mjs",
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
export const boundarySuppressions = [
  {
    path: "libs/domain/doc.go",
    reason: "a different row under a different law",
    expiresAt: "2999-02-02T00:00:00.000Z",
    origin: "ticket-43",
  },
];
`,
    );
    const streams = waiversEnv();
    expect(await runCli(["waivers", "--config", "alt-boundaries.mjs"], streams)).toBe(EXIT.ok);
    const text = streams.lines.out.join("\n");
    expect(text).toContain("a different row under a different law");
    expect(text).toContain("2999-02-02T00:00:00.000Z");
    expect(text).toContain("origin: ticket-43");
  });

  it("check still exits 1 over a waived violation — accepting must not flip 1→0", async () => {
    const streams = waiversEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    // The stdout report names the accepted violation and its term rather than
    // pretending the tree is clean.
    expect(streams.lines.out.join("\n")).toContain("accepted violations: 1 boundary violation");
    expect(streams.lines.out.join("\n")).toContain("accepted until 2999-01-01T00:00:00.000Z");
  });

  it("an expired waiver re-asserts the violation in check text/SARIF/JSON and surfaces expired in waivers", async () => {
    // The silent direction for a term: an expiry the calendar cannot hold is
    // rejected at config load (config.test.mjs), and a term that HAS lapsed
    // must not stay a waiver. Run the SAME tree under a boundary law whose row
    // term is already in the past (a distinct filename, so the module cache
    // loads the flip fresh — rewriting the existing file would re-import the
    // cached 2999 law) and require the violation to be live again everywhere a
    // developer could look, never silently re-accepted.
    writeWaivers(
      "past-boundaries.mjs",
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
export const boundarySuppressions = [
  {
    path: "libs/domain/doc.go",
    reason: "the adapter seam lands next release",
    expiresAt: "2020-01-01T00:00:00.000Z",
    origin: "ticket-42",
  },
];
`,
    );

    // `check` — the violation is a plain finding again, with the re-assert
    // evidence visible in the line a developer jumps to, and a non-zero exit.
    const checkStreams = waiversEnv();
    expect(await runCli(["check", "--config", "past-boundaries.mjs"], checkStreams)).toBe(
      EXIT.violations,
    );
    const checkText = checkStreams.lines.out.join("\n");
    expect(checkText).toContain("evidence   expired waiver");
    expect(checkText).not.toContain("accepted until");

    // SARIF — the same re-assert rides the same byte stream a SARIF uploader
    // reads, so an upload never silences an expired term.
    const sarifStreams = waiversEnv();
    expect(
      await runCli(["check", "--format", "sarif", "--config", "past-boundaries.mjs"], sarifStreams),
    ).toBe(EXIT.violations);
    const sarif = JSON.parse(sarifStreams.lines.out.join("\n"));
    const results = sarif.runs[0].results;
    expect(results).toHaveLength(1);
    expect(results[0].properties.evidence).toBe("expired waiver");

    // JSON — the envelope's failure carries the evidence too, the same object
    // the `--format json` consumers parse.
    const jsonStreams = waiversEnv();
    expect(
      await runCli(["check", "--format", "json", "--config", "past-boundaries.mjs"], jsonStreams),
    ).toBe(EXIT.violations);
    const envelope = JSON.parse(jsonStreams.lines.out.join("\n"));
    expect(envelope.result.violations).toHaveLength(1);
    expect(envelope.result.violations[0].evidence).toBe("expired waiver");
    expect(envelope.result.waived).toBeUndefined();

    // `waivers` — the same row is now reported as expired, not active: a term
    // that lapsed is surfaced loudly on the surface that used to accept it.
    const wvStreams = waiversEnv();
    expect(await runCli(["waivers", "--config", "past-boundaries.mjs"], wvStreams)).toBe(EXIT.ok);
    const wvText = wvStreams.lines.out.join("\n");
    expect(wvText).toContain("1 expired, 0 cover nothing right now");
    expect(wvText).toMatch(/expired \d+ms ago/);
  });

  it("waivers refuses a tree it could not fully read — exit 3, never a stale-looking surface", async () => {
    // The silent direction named in the coverage-refusal: a file the analyzer
    // never judged contributes no finding, so a waiver naming it would read as
    // "covers nothing" about a finding the run never looked at. `check` treats
    // the same tree as no-verdict (3); the waiver surface must do the same
    // rather than complete with "1 waiver on the table".
    const streams = {
      ...waiversEnv(),
      listFiles: () => [...waiversFiles, "libs/domain/absent.go"],
    };
    expect(await runCli(["waivers"], streams)).toBe(EXIT.error);
    expect(streams.lines.err.join("\n")).toContain("incomplete coverage");
  });
});

describe("context --plan, the agent architecture planning context, end to end", () => {
  // A native tree with the same two-project layer-crossing shape as the block
  // above PLUS a second, two-direction change, so the plan's whole-tree verdict
  // and scoped reporting can both be observed. `--plan` runs the real whole-tree
  // `analyzeWorkspace` + `evaluate` — nothing is injected, so the plan's
  // "violations are the full-workspace verdict" claim is the wiring under test.
  const planRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-plan-"));
  afterAll(() => rmSync(planRoot, { recursive: true, force: true }));

  const writePlan = (relativePath, text) => {
    mkdirSync(join(planRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(planRoot, relativePath), text);
  };

  writePlan(
    "lattice.json",
    JSON.stringify({
      projects: {
        declared: [
          { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
          { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
          { root: "libs/util", name: "util", tags: ["layer:util"] },
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
  writePlan(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter", "layer:util"] },
  { sourceTag: "layer:util", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
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
  writePlan("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writePlan("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writePlan("libs/util/go.mod", "module example.com/util\n\ngo 1.24\n");
  writePlan("libs/adapter/adapter.go", "package adapter\n");
  writePlan("libs/util/util.go", "package util\n");
  // The crossing: domain imports adapter (forbidden — domain may only reach
  // domain). A change scoped to libs/adapter should NOT surface it for
  // reporting, even though the whole-tree verdict computes it.
  writePlan(
    "libs/domain/doc.go",
    `// Package domain.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
  );
  // A legitimate adapter → util edge, so the plan shows a real dependency edge
  // and a real impact list.
  writePlan(
    "libs/adapter/handler.go",
    `package adapter

import (
	"example.com/util"
)

var _ = util.Name
`,
  );

  const planFiles = [
    "lattice.json",
    "module-boundaries.config.mjs",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
    "libs/adapter/handler.go",
    "libs/util/go.mod",
    "libs/util/util.go",
  ];

  const planContext = { cwd: planRoot, listFiles: () => planFiles };
  const planEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      ...planContext,
    };
  };

  it("reports a complete plan (exit 0) with the violation in scope when the target project is the violator", async () => {
    // A change to `domain` is in scope of the domain→adapter crossing, so the
    // plan must surface that violation — the whole-tree verdict, scoped for
    // reporting, agrees with what a full `check` would say.
    const streams = planEnv();
    expect(await runCli(["context", "domain", "--plan"], streams)).toBe(EXIT.ok);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("planning context complete");
    expect(out).toContain("Project  domain");
    expect(out).toContain("Violations (1 in scope of this change)");
    expect(out).toContain("libs/domain/doc.go");
  });

  it("scopes reporting away from a violation outside the change's projects", async () => {
    // A change to `util` scoped to libs/util touches a project with no
    // violating imports, so the plan shows 0 in-scope violations even though
    // the whole-tree verdict computed the domain crossing — the whole-graph
    // claim, narrowed only for reporting.
    const streams = planEnv();
    expect(await runCli(["context", "util", "--plan", "libs/util"], streams)).toBe(EXIT.ok);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("Project  util");
    expect(out).toContain("Violations (0 in scope of this change)");
    expect(out).not.toContain("libs/domain/doc.go");
  });

  it("shows impact: who depends on the target project", async () => {
    // adapter depends on util directly, and domain depends on adapter (even
    // though that edge is a violation) — so util's dependents are both direct
    // and transitive.
    const streams = planEnv();
    expect(await runCli(["context", "util", "--plan"], streams)).toBe(EXIT.ok);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("2 projects depend on it");
    expect(out).toContain("direct 1, transitive 1");
    expect(out).toContain("adapter");
  });

  it("scopes the change by trailing path: a path into libs/adapter limits the affected projects", async () => {
    // With a scope path pointing at libs/adapter, the affected-projects list
    // narrows to adapter, and the domain crossing (outside that scope) is not
    // reported.
    const streams = planEnv();
    expect(await runCli(["context", "util", "--plan", "libs/adapter"], streams)).toBe(EXIT.ok);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("affected projects  adapter");
    expect(out).not.toContain("libs/domain/doc.go");
  });

  it("is deterministic: two runs over the unchanged tree produce identical bytes", async () => {
    const first = planEnv();
    const second = planEnv();
    expect(await runCli(["context", "domain", "--plan", "--format", "json"], first)).toBe(EXIT.ok);
    expect(await runCli(["context", "domain", "--plan", "--format", "json"], second)).toBe(EXIT.ok);
    expect(first.lines.out.join("")).toBe(second.lines.out.join(""));
  });

  it("carries the plan under result.plan in the JSON envelope, with a variant marker", async () => {
    const streams = planEnv();
    expect(await runCli(["context", "domain", "--plan", "--format", "json"], streams)).toBe(
      EXIT.ok,
    );
    const envelope = JSON.parse(streams.lines.out.join(""));
    expect(envelope.command).toBe("context");
    expect(envelope.result.plan.variant).toBe("plan");
    // The plain context fields stay at top level (additive envelope).
    expect(envelope.result.project).toBe("domain");
    expect(envelope.result.tags).toEqual(["layer:domain"]);
    expect(envelope.result.constraints).toHaveLength(1);
    expect(envelope.result.dependencies).toBeDefined();
    // Planning sections present.
    expect(envelope.result.plan.architecture.projects.length).toBe(3);
    expect(envelope.result.plan.impact).toHaveLength(1);
    expect(envelope.result.plan.verify.length).toBeGreaterThanOrEqual(1);
    expect(envelope.result.plan.drift.goWork).toBeNull();
    expect(envelope.result.plan.drift.tsconfigPaths).toBeNull();
    expect(envelope.result.plan.policyFingerprint).toBeDefined();
  });

  it("reports the plan's drift and architecture in the text output", async () => {
    const streams = planEnv();
    expect(await runCli(["context", "domain", "--plan"], streams)).toBe(EXIT.ok);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("Drift");
    expect(out).toContain("go.work        not judged (no manifest to read)");
    expect(out).toContain("tsconfig paths not judged (no manifest to read)");
    expect(out).toContain("projects           3");
    expect(out).toContain("dependencies       ");
  });

  it("keeps the plain context path unchanged: --plan is strictly additive", async () => {
    // The plain `context` command must keep producing its own document even
    // though --plan now exists alongside it — the plan feature adds a new
    // renderer without corrupting the shared preamble that existed before.
    const plain = planEnv();
    expect(await runCli(["context", "domain"], plain)).toBe(EXIT.ok);
    const plainOut = plain.lines.out.join("");
    expect(plainOut).toContain("✔ context complete");
    expect(plainOut).toContain("Project  domain");
    expect(plainOut).toContain("Constraints (1 row matches):");
    // The plan renderer is a *different* document with its own header and its
    // own worded constraints section — not the plain document with sections
    // appended. Both live, neither replaces the other.
    const plans = planEnv();
    expect(await runCli(["context", "domain", "--plan"], plans)).toBe(EXIT.ok);
    const planOut = plans.lines.out.join("");
    expect(planOut).toContain("✔ planning context complete");
    expect(planOut).toContain("Project  domain");
  });

  it("folds the canonical architecture-intent verdict into result.plan when a tracked intent exists", async () => {
    // The phase-4 pact: context --plan must consume the SAME canonical intent
    // the drift/check commands share, not a parallel model. A tracked intent
    // that forbids the observed domain → adapter edge must surface as
    // plan.intent.verdict = "findings" with the file named — the empty-result
    // invariant applied to the planning document.
    writePlan(
      "architecture-intent.json",
      JSON.stringify({
        version: "1",
        boundaries: [
          { name: "domains", match: ["tag:layer:domain"] },
          { name: "adapters", match: ["tag:layer:adapter"] },
        ],
        forbidden: [
          {
            from: "domains",
            to: "adapters",
            reason: "adapter layers must stay below domain layers",
          },
        ],
      }),
    );
    const tracked = [...planFiles, "architecture-intent.json"];
    const streams = planEnv();
    streams.listFiles = () => tracked;
    expect(await runCli(["context", "domain", "--plan", "--format", "json"], streams)).toBe(
      EXIT.ok,
    );
    const envelope = JSON.parse(streams.lines.out.join(""));
    expect(envelope.result.plan.intent.verified).toBe(true);
    expect(envelope.result.plan.intent.file).toBe("architecture-intent.json");
    expect(envelope.result.plan.intent.verdict).toBe("findings");
    const edge = envelope.result.plan.intent.findings.find(
      (f) => f.source === "domain" && f.target === "adapter",
    );
    expect(edge).toBeDefined();
    // The text report states the verdict, so a reader of the terminal sees the
    // same contract as the JSON consumer.
    const text = planEnv();
    text.listFiles = () => tracked;
    expect(await runCli(["context", "domain", "--plan"], text)).toBe(EXIT.ok);
    expect(text.lines.out.join("")).toContain("Intent (verified)");
    expect(text.lines.out.join("")).toContain("1 finding");
  });
});

describe("the .json boundaryConfig dialect, end to end through the native provider", () => {
  // A third, independent tmpdir: same two-project layer-crossing shape as the
  // native `lattice.json` block above, but `boundaryConfig` names a `.json`
  // file instead of `.mjs` — unlike `.mjs`, `.json` is not an analyzable
  // extension (`LANGUAGE_BY_EXTENSION` in `../src/analysis/registry.mjs`), so
  // this fixture needs no coverage waiver for its own policy file.
  const jsonRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-json-"));
  afterAll(() => rmSync(jsonRoot, { recursive: true, force: true }));

  const writeJson = (relativePath, text) => {
    mkdirSync(join(jsonRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(jsonRoot, relativePath), text);
  };

  const wellFormedPolicy = () => ({
    depConstraints: [
      { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
      { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
    ],
    moduleBoundaryOptions: {
      allow: [],
      buildTargets: ["build"],
      enforceBuildableLibDependency: false,
      allowCircularSelfDependency: false,
      checkDynamicDependenciesExceptions: [],
      ignoredCircularDependencies: [],
      banTransitiveDependencies: false,
      checkNestedExternalImports: false,
    },
  });

  writeJson(
    "lattice.json",
    JSON.stringify({
      boundaryConfig: "policy.json",
      projects: {
        declared: [
          { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
          { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
        ],
      },
    }),
  );
  writeJson("policy.json", JSON.stringify(wellFormedPolicy()));
  writeJson("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeJson("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeJson("libs/adapter/adapter.go", "package adapter\n");
  // Same crossing as the `.mjs`-dialect native fixture above, so the two
  // blocks prove the same rule fires whichever dialect wrote the policy.
  writeJson(
    "libs/domain/doc.go",
    `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
  );

  const jsonFiles = [
    "lattice.json",
    "policy.json",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
  ];
  const jsonContext = { cwd: jsonRoot, listFiles: () => jsonFiles };
  const jsonEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      ...jsonContext,
    };
  };

  it("finds the same layer-crossing Go import through a .json policy file as the .mjs dialect finds", async () => {
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      jsonContext,
    );
    expect(violations).toBe(1);
    expect(report).toContain("libs/domain/doc.go:5:2  onlyTagsConstraintViolation");
  });

  // The red-direction case: an empty constraint table is well-formed, and the
  // report must still state what it inspected — a missing coverage line here
  // would be indistinguishable from a run that silently checked nothing.
  it("still states what it inspected when the .json policy's constraint table is empty", async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-json-empty-"));
    try {
      const writeEmpty = (relativePath, text) => {
        mkdirSync(join(emptyRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(emptyRoot, relativePath), text);
      };
      writeEmpty(
        "lattice.json",
        JSON.stringify({
          boundaryConfig: "policy.json",
          projects: { declared: [{ root: "libs/only", name: "only", tags: [] }] },
        }),
      );
      writeEmpty("policy.json", JSON.stringify({ ...wellFormedPolicy(), depConstraints: [] }));
      writeEmpty("libs/only/go.mod", "module example.com/only\n\ngo 1.24\n");
      writeEmpty("libs/only/doc.go", "package only\n");
      const streams = {
        ...jsonEnv(),
        cwd: emptyRoot,
        listFiles: () => ["lattice.json", "policy.json", "libs/only/go.mod", "libs/only/doc.go"],
      };
      expect(await runCli(["check"], streams)).toBe(EXIT.ok);
      expect(streams.lines.out.join("\n")).toContain(
        "✔ no boundary violations (0 imports in 1 file across 1 project)",
      );
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("reads a --config pointed at a .json file, relative to cwd", async () => {
    const streams = jsonEnv();
    expect(await runCli(["check", "--config", "policy.json"], streams)).toBe(EXIT.violations);
    expect(streams.lines.out.join("\n")).toContain(
      "libs/domain/doc.go:5:2  onlyTagsConstraintViolation",
    );
  });

  it("reads a --config pointed at a .json file by absolute path", async () => {
    const streams = jsonEnv();
    expect(await runCli(["check", "--config", join(jsonRoot, "policy.json")], streams)).toBe(
      EXIT.violations,
    );
    expect(streams.lines.out.join("\n")).toContain(
      "libs/domain/doc.go:5:2  onlyTagsConstraintViolation",
    );
  });

  it("exits 3 and names the key when a --config .json file carries an unrecognised top-level key", async () => {
    const badRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-json-bad-key-"));
    try {
      const writeBad = (relativePath, text) => {
        mkdirSync(join(badRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(badRoot, relativePath), text);
      };
      writeBad(
        "lattice.json",
        JSON.stringify({ projects: { declared: [{ root: "libs/only", name: "only", tags: [] }] } }),
      );
      writeBad("bad.json", JSON.stringify({ ...wellFormedPolicy(), depConstraint: [] }));
      writeBad("libs/only/go.mod", "module example.com/only\n\ngo 1.24\n");
      const streams = {
        ...jsonEnv(),
        cwd: badRoot,
        listFiles: () => ["lattice.json", "bad.json", "libs/only/go.mod"],
      };
      expect(await runCli(["check", "--config", "bad.json"], streams)).toBe(EXIT.error);
      expect(streams.lines.err.join("\n")).toContain(
        "depConstraint: not a recognised top-level key",
      );
    } finally {
      rmSync(badRoot, { recursive: true, force: true });
    }
  });
});

describe("an Nx-tree workspace with a .json boundaryConfig, driven through the CLI", () => {
  // Everything above named ".json boundaryConfig" so far runs it through
  // `nativeProvider` — a workspace with no `nx.json` at all. `readPluginOptions`
  // (`../src/options.mjs`) is the OTHER route to a `boundaryConfig` filename,
  // reached only from a real `nx.json` on disk (`check()`'s non-native branch
  // reads it directly, never injected), so this fixture needs a real one —
  // `env()`/`context` above inject `readGraph` instead of an `nx` binary, but
  // `nx.json` itself still has to exist for `readPluginOptions` to find the
  // plugin's `options.boundaryConfig` entry at all. This is the case
  // `boundary-config.mjs`'s extension dispatch (the LSP face) and
  // `loadBoundaryConfigFile`'s (the CLI/Nx face) both exist to reach, and
  // until this test existed neither an Nx tree's `.json` verdict nor its
  // report text was pinned anywhere — only the native path's was.
  const nxJsonRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-nx-json-"));
  afterAll(() => rmSync(nxJsonRoot, { recursive: true, force: true }));

  const writeNxJson = (relativePath, text) => {
    mkdirSync(join(nxJsonRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(nxJsonRoot, relativePath), text);
  };

  writeNxJson(
    "nx.json",
    JSON.stringify({
      plugins: [{ plugin: "@ecoma-io/lattice/nx", options: { boundaryConfig: "policy.json" } }],
    }),
  );
  writeNxJson(
    "policy.json",
    JSON.stringify({
      depConstraints: [
        { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
        {
          sourceTag: "layer:adapter",
          onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"],
        },
      ],
      moduleBoundaryOptions: {
        allow: [],
        buildTargets: ["build"],
        enforceBuildableLibDependency: false,
        allowCircularSelfDependency: false,
        checkDynamicDependenciesExceptions: [],
        ignoredCircularDependencies: [],
        banTransitiveDependencies: false,
        checkNestedExternalImports: false,
      },
    }),
  );
  writeNxJson("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeNxJson("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeNxJson("libs/adapter/adapter.go", "package adapter\n");
  // Same crossing as the top fixture's `.mjs` config, so the two prove the
  // same rule fires whichever dialect the workspace's `nx.json` names.
  writeNxJson(
    "libs/domain/doc.go",
    `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
  );

  const nxJsonGraph = {
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
  const nxJsonFiles = [
    "nx.json",
    "policy.json",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
  ];
  const nxJsonContext = {
    cwd: nxJsonRoot,
    readGraph: () => nxJsonGraph,
    listFiles: () => nxJsonFiles,
  };

  it("pins the verdict, not just the exit code: same violation, same position, same message as the .mjs dialect", async () => {
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      nxJsonContext,
    );
    expect(violations).toBe(1);
    expect(report).toContain("libs/domain/doc.go:5:2  onlyTagsConstraintViolation");
    expect(report).toContain(
      'A project tagged with "layer:domain" can only depend on libs tagged with "layer:domain"',
    );
    expect(report).toContain('import      "example.com/adapter" (static)  domain → adapter');
  });
});

describe("boundaryConfig as an inline policy object in lattice.json, end to end", () => {
  const wellFormedPolicy = () => ({
    depConstraints: [
      { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
      { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
    ],
    moduleBoundaryOptions: {
      allow: [],
      buildTargets: ["build"],
      enforceBuildableLibDependency: false,
      allowCircularSelfDependency: false,
      checkDynamicDependenciesExceptions: [],
      ignoredCircularDependencies: [],
      banTransitiveDependencies: false,
      checkNestedExternalImports: false,
    },
  });

  /** Builds a fresh tmpdir workspace carrying the given inline `boundaryConfig` value. */
  const buildInlineWorkspace = (boundaryConfig) => {
    const inlineRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-inline-"));
    const writeInline = (relativePath, text) => {
      mkdirSync(join(inlineRoot, relativePath, ".."), { recursive: true });
      writeFileSync(join(inlineRoot, relativePath), text);
    };
    writeInline(
      "lattice.json",
      JSON.stringify({
        boundaryConfig,
        projects: {
          declared: [
            { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
            { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
          ],
        },
      }),
    );
    writeInline("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
    writeInline("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
    writeInline("libs/adapter/adapter.go", "package adapter\n");
    writeInline(
      "libs/domain/doc.go",
      `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
    );
    const files = [
      "lattice.json",
      "libs/domain/go.mod",
      "libs/domain/doc.go",
      "libs/adapter/go.mod",
      "libs/adapter/adapter.go",
    ];
    const out = [];
    const err = [];
    return {
      root: inlineRoot,
      streams: {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        lines: { out, err },
        cwd: inlineRoot,
        listFiles: () => files,
      },
    };
  };

  it("finds a real violation from a policy inlined in lattice.json, with no separate config file at all", async () => {
    const { root: inlineRoot, streams } = buildInlineWorkspace(wellFormedPolicy());
    try {
      expect(await runCli(["check"], streams)).toBe(EXIT.violations);
      expect(streams.lines.out.join("\n")).toContain(
        "libs/domain/doc.go:5:2  onlyTagsConstraintViolation",
      );
    } finally {
      rmSync(inlineRoot, { recursive: true, force: true });
    }
  });

  it("exits 3 and names the offending row when an inline policy's constraint table is malformed", async () => {
    const policy = {
      ...wellFormedPolicy(),
      depConstraints: [{ onlyDependOnLibsWithTags: ["layer:domain"] }],
    };
    const { root: inlineRoot, streams } = buildInlineWorkspace(policy);
    try {
      expect(await runCli(["check"], streams)).toBe(EXIT.error);
      expect(streams.lines.err.join("\n")).toContain("boundaryConfig.depConstraints[0]");
    } finally {
      rmSync(inlineRoot, { recursive: true, force: true });
    }
  });

  it("exits 3 with the exact message when boundaryConfig is neither a string nor an object", async () => {
    const { root: inlineRoot, streams } = buildInlineWorkspace(42);
    try {
      expect(await runCli(["check"], streams)).toBe(EXIT.error);
      expect(streams.lines.err.join("\n")).toContain(
        "boundaryConfig: must be a string (a filename) or an object (an inline policy), got number (42)",
      );
    } finally {
      rmSync(inlineRoot, { recursive: true, force: true });
    }
  });
});

describe("an inline boundaryConfig's policy fingerprint survives graph into history (P1-25)", () => {
  // `runGraph`'s own copy of the file/inline config-resolution ladder stopped
  // at the file-string arm: a native workspace's INLINE `boundaryConfig` fell
  // through to `null`, so `graph --output` never wrote a `result.policy`
  // fingerprint for one — unlike every other command's copy of this ladder
  // (`diff`, `history --capture`, `check`, ...), which all carry the third
  // "inline object" arm alongside the "file string" one. Two such fingerprint-less
  // snapshots, captured on either side of a real inline-policy edit, carried
  // the same "no policy" identity, so `history` classified the transition
  // "unchanged" and reported "no architectural change recorded" — silently,
  // exactly as if the law had never moved. The same edit made to a
  // FILE-named `boundaryConfig` was already reported correctly, because that
  // copy of the ladder was never missing the arm.
  const policyWith = (banTransitiveDependencies) => ({
    depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
    moduleBoundaryOptions: {
      allow: [],
      buildTargets: ["build"],
      enforceBuildableLibDependency: false,
      allowCircularSelfDependency: false,
      checkDynamicDependenciesExceptions: [],
      ignoredCircularDependencies: [],
      banTransitiveDependencies,
      checkNestedExternalImports: false,
    },
  });

  const trackedFiles = [
    "lattice.json",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
  ];

  /** Builds a fresh tmpdir native workspace carrying the given inline policy. */
  const buildRoot = (boundaryConfig) => {
    const root = mkdtempSync(join(tmpdir(), "polyglot-cli-inline-policy-history-"));
    const write = (relativePath, text) => {
      mkdirSync(join(root, relativePath, ".."), { recursive: true });
      writeFileSync(join(root, relativePath), text);
    };
    write(
      "lattice.json",
      JSON.stringify({
        boundaryConfig,
        projects: {
          declared: [
            { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
            { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
          ],
        },
      }),
    );
    write("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
    write("libs/domain/doc.go", "package domain\n");
    write("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
    write("libs/adapter/adapter.go", "package adapter\n");
    return root;
  };

  /** A fresh stream pair per call, so one call's captured output never bleeds into another's assertions. */
  const streamsFor = (root) => {
    const out = [];
    const err = [];
    return {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      cwd: root,
      listFiles: () => trackedFiles,
    };
  };

  it("graph --output carries a policy.fingerprint for an inline boundaryConfig, the same as a file-named one", async () => {
    const root = buildRoot(policyWith(false));
    const histDir = mkdtempSync(join(tmpdir(), "polyglot-cli-inline-policy-history-dir-"));
    try {
      const snapshotPath = join(histDir, "0001-baseline.json");
      expect(
        await runCli(["graph", "--format", "json", "--output", snapshotPath], streamsFor(root)),
      ).toBe(EXIT.ok);
      const envelope = JSON.parse(readFileSync(snapshotPath, "utf8"));
      expect(envelope.result.policy).toBeDefined();
      expect(typeof envelope.result.policy.fingerprint).toBe("string");
      expect(envelope.result.policy.fingerprint.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(histDir, { recursive: true, force: true });
    }
  });

  it("history reports a policy change across two inline-boundaryConfig graph snapshots, instead of silently claiming none", async () => {
    const root = buildRoot(policyWith(false));
    const histDir = mkdtempSync(join(tmpdir(), "polyglot-cli-inline-policy-history-dir-"));
    try {
      expect(
        await runCli(
          ["graph", "--format", "json", "--output", join(histDir, "0001-baseline.json")],
          streamsFor(root),
        ),
      ).toBe(EXIT.ok);

      // A real architectural-law edit: the graph (projects, edges) does not
      // move, only the policy — `banTransitiveDependencies` flips from false
      // to true. No project or edge is added, removed, or retagged.
      writeFileSync(
        join(root, "lattice.json"),
        JSON.stringify({
          boundaryConfig: policyWith(true),
          projects: {
            declared: [
              { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
              { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
            ],
          },
        }),
      );

      expect(
        await runCli(
          ["graph", "--format", "json", "--output", join(histDir, "0002-head.json")],
          streamsFor(root),
        ),
      ).toBe(EXIT.ok);

      // The JSON record: the structured signal a consumer's tooling reads.
      const jsonStreams = streamsFor(root);
      expect(await runCli(["history", histDir, "--format", "json"], jsonStreams)).toBe(EXIT.ok);
      const record = JSON.parse(jsonStreams.lines.out.join("\n"));
      const [transition] = record.result.transitions;
      // The silent-direction assertion: before the fix this is `null` — both
      // snapshots carry no fingerprint at all, so the comparison could not be
      // made, which is indistinguishable from a workspace that never captured
      // a policy in the first place.
      expect(transition.policyChanged).toBe(true);
      expect(transition.architectureChanged).toBe(false);

      // The terminal report: the exact human-facing claim the audit measured.
      // Before the fix this reads "✔ no architectural change recorded across
      // the snapshots" with no policy signal at all — byte-for-byte what an
      // unedited workspace would print.
      const textStreams = streamsFor(root);
      expect(await runCli(["history", histDir], textStreams)).toBe(EXIT.ok);
      const report = textStreams.lines.out.join("\n");
      expect(report).toContain(
        "policy (the declared architectural intent) changed between these snapshots",
      );
      expect(report).toContain(
        "✔ no architectural change recorded across the snapshots (only policy, provider, or drift signals)",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(histDir, { recursive: true, force: true });
    }
  });
});

describe("a profile is resolved by every command that reads a boundary law, not just check (P1-26, P1-17)", () => {
  // `check`'s own copy of the file/inline/profile config-resolution ladder
  // has always recognised a `profiles` plugin option: `hasProfiles` routes
  // `--config`/`boundaryConfig` through the registry as a profile NAME
  // instead of a filename. Every other command's copy did not — it fell
  // straight to `loadBoundaryConfig(root, "<profile-name>")`, which builds a
  // path like `<root>/strict`, finds no `.mjs`/`.js`/`.json` extension, and
  // refuses with "names an unsupported boundaryConfig extension '(none)'" —
  // a message that blames a typo nobody made, because the real problem is
  // that command never learned profiles exist. `graph` and `diff` failing
  // this way is the same root cause as a separate finding (P1-17): a
  // profile workspace could not produce a graph snapshot with a policy
  // fingerprint, and `diff` could not compare one against a later run.
  //
  // Now that all 11 copies call the one `resolvePolicy` in `cli.mjs`, this
  // block drives ten of the previously-broken ones — every one this repo's
  // own `docs/concepts/profiles.md` used to name as "cannot see the
  // profile-resolved law" — over a single shared, read-only fixture, plus a
  // dedicated one for the fingerprint-change scenario below (mutated
  // mid-test, so it stays out of the shared fixture the way P1-25's own
  // `buildRoot` pattern keeps a mutation from bleeding into other cases).
  const profRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-profiles-"));
  afterAll(() => rmSync(profRoot, { recursive: true, force: true }));

  const writeProf = (relativePath, text) => {
    mkdirSync(join(profRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(profRoot, relativePath), text);
  };

  writeProf(
    "nx.json",
    JSON.stringify({
      plugins: [
        {
          plugin: "@ecoma-io/lattice/nx",
          options: { boundaryConfig: "strict", profiles: "law-profiles.json" },
        },
      ],
    }),
  );
  writeProf(
    "law-profiles.json",
    JSON.stringify({
      version: 1,
      profiles: [
        {
          name: "strict",
          block: {
            depConstraints: [
              { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
            ],
            moduleBoundaryOptions: {
              allow: [],
              buildTargets: ["build"],
              enforceBuildableLibDependency: false,
              allowCircularSelfDependency: false,
              checkDynamicDependenciesExceptions: [],
              ignoredCircularDependencies: [],
              banTransitiveDependencies: false,
              checkNestedExternalImports: false,
            },
            // Gives `waivers` a real row to list, proving the profile's
            // `boundarySuppressions` — not only its `depConstraints` — reach
            // the command through the shared resolver.
            boundarySuppressions: [
              {
                path: "libs/domain/doc.go",
                reason: "the adapter seam lands next release",
                expiresAt: "2999-01-01T00:00:00.000Z",
                origin: "ticket-91",
              },
            ],
          },
        },
      ],
    }),
  );
  writeProf("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeProf(
    "libs/domain/doc.go",
    `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`,
  );
  writeProf("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeProf("libs/adapter/adapter.go", "package adapter\n");

  const profGraph = {
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
    dependencies: {
      domain: [
        { source: "domain", target: "adapter", sourceFile: "libs/domain/doc.go", type: "static" },
      ],
      adapter: [],
    },
  };
  const profFiles = [
    "nx.json",
    "law-profiles.json",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
  ];
  const profEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      cwd: profRoot,
      readGraph: () => profGraph,
      listFiles: () => profFiles,
    };
  };

  // The exact wrong-reason message every one of the ten sites used to fail
  // with — its absence is the direct assertion that this call site now
  // recognises `profiles` at all, independent of whatever its own legitimate
  // verdict turns out to be.
  const WRONG_REASON = "unsupported boundaryConfig extension";

  it("check already resolved the named profile before this fix, and still does through the shared resolver", async () => {
    const streams = profEnv();
    expect(await runCli(["check"], streams)).toBe(EXIT.violations);
    expect(streams.lines.out.join("\n")).toContain(
      "accepted violations: 1 boundary violation waived",
    );
  });

  it("graph resolves the profile and carries a policy fingerprint (P1-17)", async () => {
    const streams = profEnv();
    expect(await runCli(["graph", "--format", "json"], streams)).toBe(EXIT.ok);
    expect(streams.lines.err.join("\n")).not.toContain(WRONG_REASON);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.result.policy).toBeDefined();
    expect(typeof envelope.result.policy.fingerprint).toBe("string");
    expect(envelope.result.policy.fingerprint.length).toBeGreaterThan(0);
  });

  it("waivers resolves the profile's boundarySuppressions, not only check's own copy of the ladder", async () => {
    const streams = profEnv();
    expect(await runCli(["waivers"], streams)).toBe(EXIT.ok);
    const text = streams.lines.out.join("\n");
    expect(text).not.toContain(WRONG_REASON);
    expect(text).toContain("1 waiver on the table");
    expect(text).toContain("origin: ticket-91");
  });

  it("fitness reaches its OWN no-fitness-declared refusal, not the config-loading one — proof the block was actually read", async () => {
    // A profile's `block` cannot carry a `fitness` key at all
    // (`docs/concepts/profiles.md`, "A profile's block carries exactly three
    // keys"), so the CORRECT failure for this fixture is fitness's own
    // "declares no fitness functions" — a real, named limit. Reaching THAT
    // message rather than the ladder's is itself proof the profile's block
    // was resolved and inspected, not just that the command stopped crashing.
    const streams = profEnv();
    expect(await runCli(["fitness"], streams)).toBe(EXIT.error);
    const errText = streams.lines.err.join("\n");
    expect(errText).not.toContain(WRONG_REASON);
    expect(errText).toContain("requires a policy that declares fitness functions");
  });

  it("impact resolves the profile and reports the real dependent", async () => {
    const streams = profEnv();
    expect(await runCli(["impact", "adapter"], streams)).toBe(EXIT.ok);
    const text = streams.lines.out.join("\n");
    expect(text).not.toContain(WRONG_REASON);
    expect(text).toContain("1 project depends on adapter");
  });

  it("explain judges the site against the profile's own depConstraints row", async () => {
    const streams = profEnv();
    expect(await runCli(["explain", "libs/domain/doc.go:5:2", "--format", "json"], streams)).toBe(
      EXIT.ok,
    );
    expect(streams.lines.err.join("\n")).not.toContain(WRONG_REASON);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.result.violations).toHaveLength(1);
    expect(envelope.result.violations[0].messageId).toBe("onlyTagsConstraintViolation");
  });

  it("context lists the constraint row the profile declared for domain", async () => {
    const streams = profEnv();
    expect(await runCli(["context", "domain", "--format", "json"], streams)).toBe(EXIT.ok);
    expect(streams.lines.err.join("\n")).not.toContain(WRONG_REASON);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.result.constraints).toContainEqual(
      expect.objectContaining({ sourceTag: "layer:domain" }),
    );
  });

  it("history --capture carries a policy fingerprint under a profile-selected workspace", async () => {
    const histDir = mkdtempSync(join(tmpdir(), "polyglot-cli-profiles-hist-"));
    try {
      const streams = profEnv();
      expect(await runCli(["history", histDir, "--capture"], streams)).toBe(EXIT.ok);
      expect(streams.lines.err.join("\n")).not.toContain(WRONG_REASON);
      const [snapshot] = readdirSync(histDir).filter(
        (name) => name.endsWith(".json") && !name.endsWith(".json.tmp"),
      );
      const envelope = JSON.parse(readFileSync(join(histDir, snapshot), "utf8"));
      expect(envelope.result.policy).toBeDefined();
      expect(typeof envelope.result.policy.fingerprint).toBe("string");
    } finally {
      rmSync(histDir, { recursive: true, force: true });
    }
  });

  it("debt resolves the profile and reaches its own missing-intent refusal, not the ladder's", async () => {
    const debtDir = mkdtempSync(join(tmpdir(), "polyglot-cli-profiles-debt-"));
    try {
      const streams = profEnv();
      expect(await runCli(["debt", debtDir], streams)).toBe(EXIT.error);
      const errText = streams.lines.err.join("\n");
      expect(errText).not.toContain(WRONG_REASON);
      expect(errText).toContain("requires a tracked architecture-intent.json");
    } finally {
      rmSync(debtDir, { recursive: true, force: true });
    }
  });

  it("health resolves the profile and reports a full verdict", async () => {
    const streams = profEnv();
    expect(await runCli(["health"], streams)).toBe(EXIT.ok);
    const text = streams.lines.out.join("\n");
    expect(text).not.toContain(WRONG_REASON);
    expect(text).toContain("health over complete coverage");
  });

  it("diff detects a real policy change under an unchanged profile NAME (P1-17)", async () => {
    // Its own tmpdir workspace, mutated mid-test — kept separate from the
    // read-only fixture above for the same reason P1-25's `buildRoot` factory
    // is: a mutation here must never be able to affect another case.
    const policyWith = (banTransitiveDependencies) => ({
      version: 1,
      profiles: [
        {
          name: "strict",
          block: {
            depConstraints: [
              { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
            ],
            moduleBoundaryOptions: {
              allow: [],
              buildTargets: ["build"],
              enforceBuildableLibDependency: false,
              allowCircularSelfDependency: false,
              checkDynamicDependenciesExceptions: [],
              ignoredCircularDependencies: [],
              banTransitiveDependencies,
              checkNestedExternalImports: false,
            },
          },
        },
      ],
    });

    const diffRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-profiles-diff-"));
    const histDir = mkdtempSync(join(tmpdir(), "polyglot-cli-profiles-diff-hist-"));
    const registryPath = join(diffRoot, "law-profiles.json");
    const write = (relativePath, text) => {
      mkdirSync(join(diffRoot, relativePath, ".."), { recursive: true });
      writeFileSync(join(diffRoot, relativePath), text);
    };
    try {
      write(
        "nx.json",
        JSON.stringify({
          plugins: [
            {
              plugin: "@ecoma-io/lattice/nx",
              options: { boundaryConfig: "strict", profiles: "law-profiles.json" },
            },
          ],
        }),
      );
      writeFileSync(registryPath, JSON.stringify(policyWith(false)));
      write("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
      write("libs/domain/doc.go", "package domain\n");
      write("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
      write("libs/adapter/adapter.go", "package adapter\n");

      const diffGraph = {
        nodes: {
          domain: { name: "domain", type: "lib", data: { root: "libs/domain", tags: [] } },
          adapter: { name: "adapter", type: "lib", data: { root: "libs/adapter", tags: [] } },
        },
        dependencies: { domain: [], adapter: [] },
      };
      const diffFiles = [
        "nx.json",
        "law-profiles.json",
        "libs/domain/go.mod",
        "libs/domain/doc.go",
        "libs/adapter/go.mod",
        "libs/adapter/adapter.go",
      ];
      const diffEnv = () => {
        const out = [];
        const err = [];
        return {
          out: (text) => out.push(text),
          err: (text) => err.push(text),
          lines: { out, err },
          cwd: diffRoot,
          readGraph: () => diffGraph,
          listFiles: () => diffFiles,
        };
      };

      const baselineFile = join(histDir, "0001-baseline.json");
      const graphStreams = diffEnv();
      expect(
        await runCli(["graph", "--format", "json", "--output", baselineFile], graphStreams),
      ).toBe(EXIT.ok);

      // A real architectural-law edit under the SAME profile NAME — no
      // project or edge moves, only the policy `banTransitiveDependencies`
      // flips, the identical technique P1-25's own regression test used for
      // an inline `boundaryConfig`.
      writeFileSync(registryPath, JSON.stringify(policyWith(true)));

      const diffStreams = diffEnv();
      expect(await runCli(["diff", baselineFile, "--format", "json"], diffStreams)).toBe(EXIT.ok);
      expect(diffStreams.lines.err.join("\n")).not.toContain(WRONG_REASON);
      const envelope = JSON.parse(diffStreams.lines.out.join("\n"));
      expect(envelope.result.policyMismatch).toBeDefined();
      expect(envelope.result.policyMismatch.baseline.fingerprint).not.toBe(
        envelope.result.policyMismatch.head.fingerprint,
      );

      const textStreams = diffEnv();
      expect(await runCli(["diff", baselineFile], textStreams)).toBe(EXIT.ok);
      expect(textStreams.lines.out.join("\n")).toContain(
        "policy changed between baseline and head",
      );
    } finally {
      rmSync(diffRoot, { recursive: true, force: true });
      rmSync(histDir, { recursive: true, force: true });
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

describe("a path scoped to an untracked file must not read as clean (P1-04)", () => {
  // The audit's exact reproduction: this tool's whole file universe is
  // `git ls-files` (`../workspace.mjs`'s header), so a file that exists on
  // disk but was never `git add`ed is invisible to it. `selectFiles` used to
  // fall through silently to an empty selection, and a scoped `check` over a
  // path that matched nothing analyzed 0 files and reported a clean tree —
  // byte-for-byte indistinguishable from a workspace with no violation at
  // all. Same fixture shape as the cycle-scoping describe block above, reused
  // here because a circular-dependency finding is exactly the violation class
  // the audit's own reproduction hit, and it is what proves this is the SAME
  // bytes on disk, not a different, cleaner file.
  const untrackedRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-untracked-"));
  afterAll(() => rmSync(untrackedRoot, { recursive: true, force: true }));

  const writeUntracked = (relativePath, text) => {
    mkdirSync(join(untrackedRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(untrackedRoot, relativePath), text);
  };

  writeUntracked(
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
  writeUntracked(
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
  writeUntracked("libs/a/go.mod", "module example.com/a\n\ngo 1.24\n");
  // Written to disk exactly like every other fixture file below — the bug is
  // that `listFiles` (standing in for `git ls-files`) can omit it below while
  // it still exists here, the same as a file that was never `git add`ed.
  writeUntracked(
    "libs/a/doc.go",
    `// Package a is one half of a cycle that only closes through b.
package a

import (
	"example.com/b"
)

var _ = b.Name
`,
  );
  writeUntracked("libs/b/go.mod", "module example.com/b\n\ngo 1.24\n");
  writeUntracked(
    "libs/b/doc.go",
    `// Package b closes the cycle back to a.
package b

import (
	"example.com/a"
)

var _ = a.Name
`,
  );

  const trackedFiles = [
    "lattice.json",
    "module-boundaries.config.mjs",
    "libs/a/go.mod",
    "libs/a/doc.go",
    "libs/b/go.mod",
    "libs/b/doc.go",
  ];
  // `libs/a/doc.go` — the file carrying the cycle-closing import — is on disk
  // (written above) but absent here: the exact shape `git ls-files` answers
  // for a file that exists but has never been `git add`ed.
  const untrackedFileList = trackedFiles.filter((file) => file !== "libs/a/doc.go");

  it("exits usage rather than clean when the scoped path matches no tracked file", async () => {
    const streams = { ...env(), cwd: untrackedRoot, listFiles: () => untrackedFileList };
    expect(await runCli(["check", "libs/a/doc.go"], streams)).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("matches no tracked file");
    // Not the silent old behaviour: no clean report was ever printed for a
    // run that never actually inspected the file.
    expect(streams.lines.out.join("\n")).not.toContain("no boundary violations");
  });

  it("finds the real circular-dependency violation once the exact same bytes are tracked", async () => {
    // The audit's contrast, reproduced: identical file content at the same
    // path — the only difference from the case above is whether `listFiles`
    // (standing in for `git ls-files`) names it.
    const streams = { ...env(), cwd: untrackedRoot, listFiles: () => trackedFiles };
    expect(await runCli(["check", "libs/a/doc.go"], streams)).toBe(EXIT.violations);
    expect(streams.lines.out.join("\n")).toContain("noCircularDependencies");
  });

  it("exits usage on a scoped path that does not exist at all, the typo case", async () => {
    const streams = { ...env(), cwd: untrackedRoot, listFiles: () => trackedFiles };
    expect(await runCli(["check", "libs/nonexistent"], streams)).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("matches no tracked file");
  });

  it("still selects cleanly when scoped to a real, tracked, merely unowned path", async () => {
    // `module-boundaries.config.mjs` is tracked but owned by no project (no
    // declared project's root covers it) — a legitimate, genuinely empty
    // slice, and must not be refused the way the untracked case above is.
    const streams = { ...env(), cwd: untrackedRoot, listFiles: () => trackedFiles };
    expect(await runCli(["check", "module-boundaries.config.mjs"], streams)).toBe(EXIT.ok);
    expect(streams.lines.out.join("\n")).toContain("no boundary violations");
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

describe("an Nx-tree workspaceLayout must reach the rule engine the same way lattice.json's does", () => {
  // The Nx-side counterpart to the native block above: `nx.json`'s
  // `workspaceLayout` used to be read nowhere in this package —
  // `readProjectGraph` (`./providers/nx.mjs`) merged nothing from disk onto
  // the graph `evaluate()` reads, so a workspace with a custom `libsDir`
  // still had its boundary rules judged against the Nx DEFAULT layout
  // (`libs`/`apps`). `check()`'s `readGraph` context seam is injected with the
  // real `readProjectGraph`, faking only the `nx graph` subprocess spawn
  // (`run`), so the real `nx.json` merge logic in `./providers/nx.mjs` runs
  // against a real file on disk — the same thing `findWorkspaceRoot` and
  // `readPluginOptions` inside `check()` do unconditionally and cannot be
  // injected around.
  const nxLayoutRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-nx-layout-"));
  afterAll(() => rmSync(nxLayoutRoot, { recursive: true, force: true }));

  const writeNxLayout = (relativePath, text) => {
    mkdirSync(join(nxLayoutRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(nxLayoutRoot, relativePath), text);
  };

  writeNxLayout(
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
  writeNxLayout("packages/a/go.mod", "module example.com/a\n\ngo 1.24\n");
  writeNxLayout(
    "packages/a/doc.go",
    `// Package a reaches b by an absolute-looking specifier.
package a

import (
	"packages/b"
)

var _ = b.Name
`,
  );
  writeNxLayout("packages/b/go.mod", "module example.com/b\n\ngo 1.24\n");

  const nxLayoutFiles = [
    "nx.json",
    "module-boundaries.config.mjs",
    "packages/a/go.mod",
    "packages/a/doc.go",
    "packages/b/go.mod",
  ];

  // Stands in for the `nx graph` subprocess spawn only — the graph shape a
  // real `nx graph --file=` write produces for this tree, with no
  // `workspaceLayout` key of its own, so the only source of that fact is the
  // real `readProjectGraph` merge this test exists to exercise.
  const fakeNxGraphRun = (_file, args) => {
    const fileArg = args.find((arg) => arg.startsWith("--file="));
    const target = fileArg.slice("--file=".length);
    writeFileSync(
      target,
      JSON.stringify({
        graph: {
          nodes: {
            a: { name: "a", type: "lib", data: { root: "packages/a" } },
            b: { name: "b", type: "lib", data: { root: "packages/b" } },
          },
          dependencies: {},
        },
      }),
    );
    return "";
  };

  it("with a custom libsDir declared in nx.json, catches the absolute import into another library", async () => {
    writeNxLayout(
      "nx.json",
      JSON.stringify({ workspaceLayout: { appsDir: "applications", libsDir: "packages" } }),
    );
    const { report, violations } = await check(
      { format: "text", config: null, paths: [] },
      {
        cwd: nxLayoutRoot,
        readGraph: (root) => readProjectGraph(root, { run: fakeNxGraphRun }),
        listFiles: () => nxLayoutFiles,
      },
    );
    expect(violations).toBe(1);
    expect(report).toContain("noRelativeOrAbsoluteImportsAcrossLibraries");
  });

  it("without workspaceLayout declared, the default libs/apps layout misses it — the exact gap the declared layout must close", async () => {
    writeNxLayout("nx.json", JSON.stringify({}));
    const { violations } = await check(
      { format: "text", config: null, paths: [] },
      {
        cwd: nxLayoutRoot,
        readGraph: (root) => readProjectGraph(root, { run: fakeNxGraphRun }),
        listFiles: () => nxLayoutFiles,
      },
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

  it("refuses a command name inherited from Object.prototype the same way it refuses any other unknown command", () => {
    // `COMMANDS[commandName]` with no own-property guard would answer
    // `toString`/`__proto__`/`constructor` from `Object.prototype` instead of
    // `undefined`, pass the `!command` check, and crash on `command.run` —
    // a TypeError and exit 1, not the usage error every other unregistered
    // command word gets. Exit code has to be checked as IS 2, not merely
    // "not 0", or a regression back to the TypeError's exit 1 would slip
    // through a looser assertion.
    const toStringResult = run(["toString"]);
    expect(toStringResult.status).toBe(EXIT.usage);
    expect(toStringResult.stderr).toContain("unknown command 'toString'");

    const protoResult = run(["__proto__"]);
    expect(protoResult.status).toBe(EXIT.usage);
    expect(protoResult.stderr).toContain("unknown command '__proto__'");
  });

  it("rejects a mistyped option instead of reading it as a path that selects nothing", () => {
    // `--fromat sarif` read as two paths would select no files and report a
    // clean tree: a green run that inspected nothing.
    const result = run(["check", "--fromat", "sarif"]);
    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toContain("unknown option '--fromat'");
  });

  it("registers debt as a descriptive command with its own usage error", () => {
    // A mistyped `debt` (no trailing 't') already falls into the unknown-
    // command bucket above; this pins that `debt` itself is registered and
    // its positional-argument contract is what a missing `<dir>` trips, NOT
    // "unknown command". Regression direction: an unregistered command would
    // report the usage error for the wrong reason.
    const result = run(["debt"]);
    expect(result.status).toBe(EXIT.usage);
    expect(result.stderr).toContain("debt takes exactly one positional argument");

    const mixed = run(["debt", "a", "b"]);
    expect(mixed.status).toBe(EXIT.usage);
    expect(mixed.stderr).toContain("debt takes exactly one positional argument");
    expect(mixed.stderr).toContain("got 2");
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

  it("reports status no-verdict in the JSON envelope over the same unreadable file, never status ok", async () => {
    // The JSON twin of the case above: a caller branching on `status` alone
    // must see the same refusal a caller branching on the exit code sees —
    // `jsonEnvelope` (`src/report/json.mjs`) would throw before shipping
    // `status: "ok"` here, but this pins the whole path end to end rather
    // than only the throw.
    const streams = {
      ...env(),
      listFiles: () => [...files, "libs/adapter/absent.go"],
    };
    const exitCode = await runCli(["check", "libs/adapter", "--format", "json"], streams);
    expect(exitCode).toBe(EXIT.error);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.status).toBe("no-verdict");
    expect(envelope.exitCode).toBe(3);
    expect(envelope.coverage.complete).toBe(false);
    expect(envelope.coverage.notAnalyzed).toEqual([
      { file: "libs/adapter/absent.go", reason: expect.stringContaining("could not be read") },
    ]);
    // The canonical four-state verdict of the same run: a tree that could not
    // be fully read emits `unknown` — never the `pass` that would read as
    // "checked, and fine" — with the reason naming which half could not look.
    expect(envelope.decision.verdict).toBe("unknown");
    expect(envelope.decision.reason).toContain("could not be analyzed");
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

describe("surfacing an ESLint boundaryConfig dialect's note on the coverage line (S2)", () => {
  // A `mkdtemp` directory INSIDE this package, not under the OS tmpdir — the
  // same reason `eslint-config.integration.test.mjs`'s `fixtureRoot()` picks
  // its location: `@nx/eslint-plugin` resolves by walking a file's own
  // ancestor directories, and only an ancestor of this package's own
  // `node_modules` reaches this workspace's real, hoisted install.
  const eslintRoot = mkdtempSync(join(packageRoot, ".cli-eslint-config-fixture-"));
  afterAll(() => rmSync(eslintRoot, { recursive: true, force: true }));

  const writeEslint = (relativePath, text) => {
    mkdirSync(join(eslintRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(eslintRoot, relativePath), text);
  };

  writeEslint("nx.json", "{}\n");
  // The canonical `nx g @nx/eslint` shape (B1): every glob a bare
  // source-extension pattern, no directory component — accepted tree-wide,
  // with a note this test exists to see rendered.
  writeEslint(
    "eslint.config.mjs",
    `export default [
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        { depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }] },
      ],
    },
  },
];
`,
  );
  writeEslint("libs/store/go.mod", "module example.com/store\n\ngo 1.24\n");
  writeEslint("libs/store/store.go", "package store\n");

  const eslintContext = {
    cwd: eslintRoot,
    readGraph: () => ({
      nodes: {
        store: { name: "store", type: "lib", data: { root: "libs/store", tags: ["layer:domain"] } },
      },
      dependencies: { store: [] },
    }),
    listFiles: () => ["nx.json", "eslint.config.mjs", "libs/store/go.mod", "libs/store/store.go"],
  };

  it("renders the note on the report's coverage line, next to what was inspected", async () => {
    const { report, violations } = await check(
      { format: "text", config: join(eslintRoot, "eslint.config.mjs"), paths: [] },
      eslintContext,
    );
    expect(violations).toBe(0);
    // The claim of no violations must sit beside the coverage sentence, and
    // the coverage sentence must carry the note — a note computed and never
    // shown would be the silent direction with extra steps.
    expect(report).toContain("✔ no boundary violations");
    expect(report).toContain("scopes @nx/enforce-module-boundaries under files");
    expect(report).toContain("applied the table tree-wide");
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

  it("writes --format json's envelope to --output silently, and still says on stderr what the run found", async () => {
    const target = join(root, "boundaries.json");
    const streams = env();
    expect(await runCli(["check", "--format", "json", "--output", target], streams)).toBe(
      EXIT.violations,
    );
    // "Silently" means stdout carries nothing — the envelope went to the
    // file, and printing it a second time would be a second, competing
    // rendering of the same run.
    expect(streams.lines.out).toEqual([]);
    const envelope = JSON.parse(readFileSync(target, "utf8"));
    expect(envelope.status).toBe("findings");
    expect(envelope.exitCode).toBe(1);
    expect(streams.lines.err.join("\n")).toContain("1 violation over 2 analyzed files");
  });

  it("exits 3 when --output cannot be written, naming the path — a report that never lands must not read as success", async () => {
    // The report exists in memory but no consumer will ever see it, which is
    // exactly a silent success if this returned 0 or 1 instead — named as a
    // no-verdict run, the same as every other "could not complete" condition.
    const target = join(root, "does-not-exist", "boundaries.json");
    const streams = env();
    expect(await runCli(["check", "--output", target], streams)).toBe(EXIT.error);
    expect(streams.lines.out).toEqual([]);
    expect(streams.lines.err.join("\n")).toContain(`could not write --output '${target}'`);
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

describe("the bare-path dispatcher", () => {
  // `lattice <path>` with no command word at all has to keep working the way
  // it always did, now that a command word is a real option `runCli` has to
  // resolve first. Its own describe block because the two directions —an
  // existing path, and a word that is neither a command nor a path — are the
  // whole point of the ordering `runCli`'s header argues.
  it("runs check when the first argument is an existing path, with no command word at all", async () => {
    const withCommand = env();
    const bare = env();
    expect(await runCli(["check", "libs/adapter"], withCommand)).toBe(EXIT.ok);
    expect(await runCli(["libs/adapter"], bare)).toBe(EXIT.ok);
    // Not just "both exit 0" — the same report, because the bare form is
    // required to be indistinguishable from typing `check` explicitly.
    expect(bare.lines.out).toEqual(withCommand.lines.out);
  });

  it("exits 2 on a first argument that is neither a registered command nor an existing path", async () => {
    const streams = env();
    expect(await runCli(["notacommand"], streams)).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("unknown command 'notacommand'");
    // The distinct failure mode this is not: read as a path, it would select
    // no files and report a clean tree rather than refuse to run at all.
    expect(streams.lines.err.join("\n")).not.toContain("outside the workspace");
  });

  it("exits 2 on an empty-string first argument, rather than reading it as the workspace root", async () => {
    // `join(cwd, "")` is `cwd` itself, which always exists — without the
    // `maybeCommand !== ""` guard, `lattice ""` reads as a path and runs a
    // whole-workspace check instead of the unknown-command refusal every
    // other non-command, non-path word gets.
    const streams = env();
    expect(await runCli([""], streams)).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("unknown command ''");
    expect(streams.lines.err.join("\n")).not.toContain("outside the workspace");
  });
});

describe("a Rust brace-group use, one blind spot the JSON envelope must carry too", () => {
  // Its own fixture: none of the Go-only fixtures above exercise a second
  // language, and the blind-spot half of `coverage` — a file that WAS
  // analyzed, with one site whose target is not statically knowable — needs a
  // real case to render rather than an empty array to trivially pass.
  const rustRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-rust-blind-"));
  afterAll(() => rmSync(rustRoot, { recursive: true, force: true }));

  const writeRust = (relativePath, text) => {
    mkdirSync(join(rustRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(rustRoot, relativePath), text);
  };

  writeRust("nx.json", "{}\n");
  writeRust(
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
  writeRust("libs/widget/Cargo.toml", '[package]\nname = "widget"\nversion = "0.1.0"\n');
  // A `use` opening with a brace group names no crate to resolve
  // (`../src/analysis/rust.mjs`'s `parseRustUseSites`) — the file is
  // analyzed, this one site is not, and that is a blind spot rather than a
  // whole-file failure: `coverage.complete` must stay true over it.
  writeRust("libs/widget/src/lib.rs", "use {a::b, c::d};\n");

  const rustContext = {
    cwd: rustRoot,
    readGraph: () => ({
      nodes: {
        widget: {
          name: "widget",
          type: "lib",
          data: { root: "libs/widget", tags: ["layer:domain"] },
        },
      },
      dependencies: { widget: [] },
    }),
    listFiles: () => [
      "nx.json",
      "module-boundaries.config.mjs",
      "libs/widget/Cargo.toml",
      "libs/widget/src/lib.rs",
    ],
  };

  it("names the brace-group site in coverage.blindSpots, and leaves coverage.complete true", async () => {
    const { report, violations, unchecked } = await check(
      { format: "json", config: null, paths: [] },
      rustContext,
    );
    expect(violations).toBe(0);
    expect(unchecked).toBe(0);
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("ok");
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.notAnalyzed).toEqual([]);
    expect(envelope.coverage.blindSpots).toEqual([
      {
        file: "libs/widget/src/lib.rs",
        line: 1,
        column: 5,
        reason: "'use {a::b, c::d}' opens with a brace group, so it names no crate to resolve",
      },
    ]);
  });
});

describe("`graph` on the Nx fixture", () => {
  it("exits 0 and names every fixture project in text output", async () => {
    const streams = env();
    expect(await runCli(["graph"], streams)).toBe(EXIT.ok);
    const report = streams.lines.out.join("\n");
    expect(report).toContain("domain");
    expect(report).toContain("adapter");
  });

  it("produces a valid JSON envelope with command graph, complete coverage, sorted projects", async () => {
    const streams = env();
    expect(await runCli(["graph", "--format", "json"], streams)).toBe(EXIT.ok);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.command).toBe("graph");
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.result.projects.map((p) => p.name)).toEqual(
      envelope.result.projects
        .map((p) => p.name)
        .slice()
        .sort(),
    );
  });

  it("never exits 1, even on the violating fixture where check does", async () => {
    // Silent direction: a graph that exits 1 over a boundary violation makes
    // the exit code ambiguous between "the graph is broken" and "the tree is
    // dirty" — the exact confusion check's distinct exit codes exist to avoid.
    const streams = env();
    const code = await runCli(["graph"], streams);
    expect(code).not.toBe(EXIT.violations);
    expect(code).toBe(EXIT.ok);
  });

  it("produces byte-identical JSON across two consecutive runs", async () => {
    const first = env();
    const second = env();
    await runCli(["graph", "--format", "json"], first);
    await runCli(["graph", "--format", "json"], second);
    expect(first.lines.out.join("\n")).toBe(second.lines.out.join("\n"));
  });
});

describe("`graph` on a native fixture with no nx resolvable", () => {
  const nativeGraphRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-native-graph-"));
  afterAll(() => rmSync(nativeGraphRoot, { recursive: true, force: true }));

  const writeNativeGraph = (relativePath, text) => {
    mkdirSync(join(nativeGraphRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(nativeGraphRoot, relativePath), text);
  };

  writeNativeGraph(
    "lattice.json",
    JSON.stringify({
      boundaryConfig: "module-boundaries.config.mjs",
      projects: {
        declared: [
          { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
          { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
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
  writeNativeGraph(
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
  writeNativeGraph("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeNativeGraph("libs/domain/doc.go", "package domain\n");
  writeNativeGraph("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeNativeGraph("libs/adapter/adapter.go", "package adapter\n");

  const nativeGraphFiles = [
    "lattice.json",
    "module-boundaries.config.mjs",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
  ];

  const nativeGraphEnv = () => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      cwd: nativeGraphRoot,
      listFiles: () => nativeGraphFiles,
    };
  };

  it("exits 0 with the same payload shape as the Nx path", async () => {
    const streams = nativeGraphEnv();
    expect(await runCli(["graph", "--format", "json"], streams)).toBe(EXIT.ok);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(envelope.command).toBe("graph");
    expect(envelope.workspace.provider).toBe("native");
    expect(envelope.coverage.complete).toBe(true);
    expect(Array.isArray(envelope.result.projects)).toBe(true);
    expect(envelope.result.projects.length).toBeGreaterThan(0);
    expect(Array.isArray(envelope.result.dependencies)).toBe(true);
  });
});

describe("`check` names the polyglot coverage gap when the plugin is unregistered but manifests exist", () => {
  // The silent direction for #38: an Nx workspace with polyglot manifests but
  // the plugin unregistered exits 0 and says nothing about the missing edges —
  // a consumer's `nx affected` and `@nx/enforce-module-boundaries` silently
  // under-cover Go/Rust/Python. The degraded-coverage note closes that gap
  // without changing the exit code, because `check`'s own analysis still
  // covers what the Nx graph does not.
  const gapRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-coverage-gap-"));
  afterAll(() => rmSync(gapRoot, { recursive: true, force: true }));

  const writeGap = (relativePath, text) => {
    mkdirSync(join(gapRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(gapRoot, relativePath), text);
  };

  // nx.json with NO plugins entry — the plugin is not registered.
  writeGap("nx.json", JSON.stringify({}));
  writeGap(
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
  writeGap("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeGap("libs/domain/doc.go", "package domain\n");

  const gapGraph = {
    nodes: {
      domain: {
        name: "domain",
        type: "lib",
        data: { root: "libs/domain", tags: [] },
      },
    },
    dependencies: { domain: [] },
  };
  const gapFiles = [
    "nx.json",
    "module-boundaries.config.mjs",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
  ];

  it("mentions the coverage gap and the go.mod in the text report", async () => {
    const { report } = await check(
      { format: "text", config: null, paths: [] },
      { cwd: gapRoot, readGraph: () => gapGraph, listFiles: () => gapFiles },
    );
    expect(report).toContain("nx.json does not register this plugin");
    expect(report).toContain("libs/domain/go.mod");
    expect(report).toContain("nx affected");
  });

  it("still exits 0 — the coverage gap is informational, not a finding", async () => {
    const { violations } = await check(
      { format: "text", config: null, paths: [] },
      { cwd: gapRoot, readGraph: () => gapGraph, listFiles: () => gapFiles },
    );
    expect(violations).toBe(0);
  });

  it("carries the coverage gap in the JSON envelope's coverage object", async () => {
    const { report } = await check(
      { format: "json", config: null, paths: [] },
      { cwd: gapRoot, readGraph: () => gapGraph, listFiles: () => gapFiles },
    );
    const envelope = JSON.parse(report);
    expect(envelope.coverage.coverageGaps).toHaveLength(1);
    expect(envelope.coverage.coverageGaps[0].kind).toBe("unregistered-plugin");
    expect(envelope.coverage.coverageGaps[0].manifests).toContain("libs/domain/go.mod");
  });

  it("does not mention the coverage gap when the plugin is registered", async () => {
    // The complement: registering the plugin removes the gap. Use the main
    // fixture (which registers the plugin) to confirm the absence.
    const { report } = await check({ format: "text", config: null, paths: [] }, context);
    expect(report).not.toContain("coverage gap");
    expect(report).not.toContain("does not register this plugin");
  });
});

describe("`graph` refuses when the plugin is unregistered but polyglot manifests exist", () => {
  // Silent direction: a graph printed with no Go edges and exit 0 — the exact
  // failure AGENTS.md's opening paragraph describes.
  const unregisteredRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-unregistered-"));
  afterAll(() => rmSync(unregisteredRoot, { recursive: true, force: true }));

  const writeUnreg = (relativePath, text) => {
    mkdirSync(join(unregisteredRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(unregisteredRoot, relativePath), text);
  };

  writeUnreg(
    "nx.json",
    JSON.stringify({}), // No plugins entry — the plugin is not registered.
  );
  writeUnreg(
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
  writeUnreg("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeUnreg("libs/domain/doc.go", "package domain\n");

  const unregGraph = {
    nodes: {
      domain: {
        name: "domain",
        type: "lib",
        data: { root: "libs/domain", tags: [] },
      },
    },
    dependencies: { domain: [] },
  };
  const unregFiles = [
    "nx.json",
    "module-boundaries.config.mjs",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
  ];

  it("exits 3 and names the go.mod and the plugins entry", async () => {
    const out = [];
    const err = [];
    const streams = {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      cwd: unregisteredRoot,
      readGraph: () => unregGraph,
      listFiles: () => unregFiles,
    };
    expect(await runCli(["graph"], streams)).toBe(EXIT.error);
    const report = out.join("\n") + err.join("\n");
    expect(report).toContain("go.mod");
    expect(report).toContain("plugins");
  });

  it("exits 0 when the same fixture registers the plugin", async () => {
    // The complement: registering the plugin removes the refusal.
    writeUnreg(
      "nx.json",
      JSON.stringify({
        plugins: [
          {
            plugin: "@ecoma-io/lattice/nx",
            options: { boundaryConfig: "module-boundaries.config.mjs" },
          },
        ],
      }),
    );
    const out = [];
    const err = [];
    const streams = {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      cwd: unregisteredRoot,
      readGraph: () => unregGraph,
      listFiles: () => unregFiles,
    };
    expect(await runCli(["graph"], streams)).toBe(EXIT.ok);
  });

  it("check proceeds when the Nx plugin is unregistered and polyglot manifests exist", async () => {
    // `pluginGap` on CommandContext is computed but NOT consulted by `check`'s
    // refusal logic — only `graph` refuses. This test pins that: if `check`
    // were accidentally wired to refuse the same way `graph` does, it would
    // exit 3 instead of 0 or 1, and this test would catch the regression.
    // Restore the unregistered nx.json in case the test above overwrote it.
    writeUnreg("nx.json", JSON.stringify({}));
    const out = [];
    const err = [];
    const streams = {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      cwd: unregisteredRoot,
      readGraph: () => unregGraph,
      listFiles: () => unregFiles,
    };
    // Exit 0 (clean) or 1 (violations), NOT 3 (refusal).
    const exitCode = await runCli(["check"], streams);
    expect(exitCode).not.toBe(EXIT.error);
  });

  it("check notes no coverage gap for an unregistered plugin", async () => {
    // `pluginGap` is a documented product decision: the gap is known and
    // tracked separately. `check`'s JSON envelope does not carry a
    // polyglot-coverage-gap note in `coverage.notes`, because the gap lives
    // in `graph`'s refusal, not in `check`'s verdict. If wiring lands, this
    // test fails and gets updated.
    writeUnreg("nx.json", JSON.stringify({}));
    const out = [];
    const err = [];
    const streams = {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      cwd: unregisteredRoot,
      readGraph: () => unregGraph,
      listFiles: () => unregFiles,
    };
    await runCli(["check", "--format", "json"], streams);
    const envelope = JSON.parse(out.join("\n"));
    const gapNotes = (envelope.coverage.notes ?? []).filter((n) =>
      /polyglot|plugin.*gap|unregistered/i.test(n),
    );
    expect(gapNotes).toEqual([]);
  });
});

describe("`diff` round trip against the Nx fixture", () => {
  it("graph --output then diff on the unchanged tree exits 0 and reports no changes", async () => {
    const baselineFile = join(root, "round-trip-baseline.json");
    const graphStreams = env();
    expect(
      await runCli(["graph", "--format", "json", "--output", baselineFile], graphStreams),
    ).toBe(EXIT.ok);
    const diffStreams = env();
    expect(await runCli(["diff", baselineFile], diffStreams)).toBe(EXIT.ok);
    expect(diffStreams.lines.out.join("\n")).toContain("no changes");
    // Clean up.
    try {
      rmSync(baselineFile, { force: true });
    } catch {
      // Already gone.
    }
  });

  it("adding a project between runs shows the added project in diff", async () => {
    // Capture baseline from the current fixture.
    const baselineFile = join(root, "added-project-baseline.json");
    const graphStreams = env();
    expect(
      await runCli(["graph", "--format", "json", "--output", baselineFile], graphStreams),
    ).toBe(EXIT.ok);

    // Add a third project to the fixture.
    const addedRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-added-"));
    afterAll(() => rmSync(addedRoot, { recursive: true, force: true }));
    const writeAdded = (relativePath, text) => {
      mkdirSync(join(addedRoot, relativePath, ".."), { recursive: true });
      writeFileSync(join(addedRoot, relativePath), text);
    };
    writeAdded(
      "nx.json",
      `${JSON.stringify({
        plugins: [
          {
            plugin: "@ecoma-io/lattice/nx",
            options: { boundaryConfig: "module-boundaries.config.mjs" },
          },
        ],
      })}\n`,
    );
    writeAdded(
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
    writeAdded("libs/a/go.mod", "module example.com/a\n\ngo 1.24\n");
    writeAdded("libs/a/a.go", "package a\n");
    writeAdded("libs/b/go.mod", "module example.com/b\n\ngo 1.24\n");
    writeAdded("libs/b/b.go", "package b\n");
    // The new project.
    writeAdded("libs/c/go.mod", "module example.com/c\n\ngo 1.24\n");
    writeAdded("libs/c/c.go", "package c\n");

    const addedGraph = {
      nodes: {
        a: { name: "a", type: "lib", data: { root: "libs/a", tags: [] } },
        b: { name: "b", type: "lib", data: { root: "libs/b", tags: [] } },
        c: { name: "c", type: "lib", data: { root: "libs/c", tags: [] } },
      },
      dependencies: { a: [], b: [], c: [] },
    };
    const addedFiles = [
      "nx.json",
      "module-boundaries.config.mjs",
      "libs/a/go.mod",
      "libs/a/a.go",
      "libs/b/go.mod",
      "libs/b/b.go",
      "libs/c/go.mod",
      "libs/c/c.go",
    ];
    const out = [];
    const err = [];
    const diffStreams = {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      lines: { out, err },
      cwd: addedRoot,
      readGraph: () => addedGraph,
      listFiles: () => addedFiles,
    };
    const diffResult = await runCli(["diff", baselineFile, "--format", "json"], diffStreams);
    expect(diffResult).toBe(EXIT.ok);
    const envelope = JSON.parse(out.join("\n"));
    expect(envelope.result.addedProjects.map((p) => p.name)).toContain("c");
    // Clean up.
    try {
      rmSync(baselineFile, { force: true });
    } catch {
      // Already gone.
    }
  });
});

describe("`diff` argument and baseline validation", () => {
  it("exits 2 with no argument — diff requires exactly one baseline file", async () => {
    const streams = env();
    expect(await runCli(["diff"], streams)).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("exactly one positional argument");
  });

  it("exits 3 on a nonexistent baseline file, naming the path", async () => {
    const streams = env();
    expect(await runCli(["diff", "/nonexistent/path/baseline.json"], streams)).toBe(EXIT.error);
    const errText = streams.lines.err.join("\n");
    // The error comes from either the file-read failure or parseBaseline.
    expect(errText).toContain("/nonexistent/path/baseline.json");
  });

  it("exits 3 on a check --format json envelope, saying it is a check report", async () => {
    // A check report envelope has command "check", not "graph" — diff must
    // refuse it rather than silently misreading its shape.
    const checkEnvelopeFile = join(root, "check-envelope.json");
    writeFileSync(
      checkEnvelopeFile,
      JSON.stringify({
        schemaVersion: 2,
        command: "check",
        status: "ok",
        exitCode: 0,
        coverage: {
          complete: true,
          projects: 2,
          analyzedFiles: 2,
          imports: 1,
          notAnalyzed: [],
          blindSpots: [],
          notes: [],
        },
        result: { violations: [], goWork: null, tsconfigPaths: null },
      }),
    );
    const streams = env();
    expect(await runCli(["diff", checkEnvelopeFile], streams)).toBe(EXIT.error);
    const errText = streams.lines.err.join("\n");
    expect(errText).toContain("check");
    // Clean up.
    try {
      rmSync(checkEnvelopeFile, { force: true });
    } catch {
      // Already gone.
    }
  });
});

describe("`history` capture and describe against the Nx fixture", () => {
  // `runCli` drives the real command wiring in-process (parseArgs with the
  // boolean `--capture`, the history run function, envelope render), over the
  // injected graph — the half the spawned-subprocess E2E cannot cover because
  // cli.mjs is excluded from in-process coverage. The history directory lives
  // outside the workspace tree so the captured snapshot is not itself tracked.
  const histDir = mkdtempSync(join(tmpdir(), "polyglot-cli-hist-"));
  afterAll(() => rmSync(histDir, { recursive: true, force: true }));

  it("captures the workspace graph and describes it as JSON", async () => {
    const streams = env();
    expect(await runCli(["history", histDir, "--capture"], streams)).toBe(EXIT.ok);

    const files = readdirSync(histDir);
    const snapshots = files
      .filter((name) => name.endsWith(".json") && !name.endsWith(".json.tmp"))
      .sort();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatch(/^0001-[0-9a-f]{8}\.json$/);

    const envelope = JSON.parse(readFileSync(join(histDir, snapshots[0]), "utf8"));
    expect(envelope.command).toBe("graph");
    expect(envelope.status).toBe("ok");
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.result.projects.map((p) => p.name).sort()).toEqual(["adapter", "domain"]);

    // The record, as JSON, carries the one snapshot and no transitions.
    const describeStreams = env();
    expect(await runCli(["history", histDir, "--format", "json"], describeStreams)).toBe(EXIT.ok);
    const record = JSON.parse(describeStreams.lines.out.join("\n"));
    expect(record.command).toBe("history");
    expect(record.status).toBe("ok");
    expect(record.result.snapshots).toHaveLength(1);
    expect(record.result.transitions).toEqual([]);
  });

  it("deduplicates a capture when the architecture did not change", async () => {
    const streams = env();
    expect(await runCli(["history", histDir, "--capture"], streams)).toBe(EXIT.ok);
    const files = readdirSync(histDir).filter(
      (name) => name.endsWith(".json") && !name.endsWith(".json.tmp"),
    );
    expect(files).toHaveLength(1);
    expect(streams.lines.out.join("\n")).toContain("already the last snapshot");
  });

  it("refuses to write the report back into the history directory it reads", async () => {
    // The self-footgun guard: --output inside the history dir would be read
    // back as a (refused) snapshot on the next run, so it must be a usage
    // error rather than a silent poison.
    const streams = env();
    expect(
      await runCli(
        ["history", histDir, "--format", "json", "--output", join(histDir, "report.json")],
        streams,
      ),
    ).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain("inside the history directory");
    expect(existsSync(join(histDir, "report.json"))).toBe(false);
  });

  it("ignores a .json.tmp left by an interrupted capture", async () => {
    // Atomic capture writes `<name>.json.tmp` then renames; an interrupted
    // write leaves the tmp behind, and that must never count as a snapshot.
    const streams = env();
    const leaveTmp = mkdtempSync(join(tmpdir(), "polyglot-cli-hist-tmp-"));
    try {
      writeFileSync(join(leaveTmp, "0001-deadbeef.json.tmp"), "partial garbage");
      expect(await runCli(["history", leaveTmp, "--capture"], streams)).toBe(EXIT.ok);
      const names = readdirSync(leaveTmp).sort();
      // The stray tmp remains (it is not deleted), and the capture wrote one
      // real snapshot that is not the tmp itself.
      expect(names).toContain("0001-deadbeef.json.tmp");
      const snapshots = names.filter((n) => n.endsWith(".json") && !n.endsWith(".json.tmp"));
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatch(/^0001-[0-9a-f]{8}\.json$/);
    } finally {
      rmSync(leaveTmp, { recursive: true, force: true });
    }
  });

  it("exits 3 on a history directory with no snapshots", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "polyglot-cli-hist-empty-"));
    try {
      const streams = env();
      expect(await runCli(["history", emptyDir], streams)).toBe(EXIT.error);
      expect(streams.lines.err.join("\n")).toContain("contains no snapshots");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("adr resolves a workspace root by every marker a root may carry", () => {
  // The command had no end-to-end test at all, and the gap hid a real defect:
  // `resolveWorkspaceRootForUsage` kept its own copy of the marker list naming
  // `nx.json` and `lattice.json` only, so `adr` answered "needs a workspace
  // root — no nx.json, lattice.json, or .moon marker found" on every Moon tree
  // — naming `.moon` in the very sentence that proved it had not looked for it.
  // This repository is a Moon workspace whose every architecture-intent row
  // carries `decisionRef: "0001-boundary-levels"`, so the one command that can
  // resolve that reference could never run on the tree it governs.
  //
  // Each marker gets its own case rather than one case for the fixed one: a
  // list that lost an entry is exactly the regression, and a test covering
  // only the entry that broke last time would not see the next one go.
  // `loadAdrRegistry` reads this directory by a constant, so the fixture has to
  // use the same name. Held as a variable so no source line here spells a
  // `docs/adr/<id>.md` path whole — see the note at the writeFileSync below.
  const ADR_FIXTURE_DIR = "docs/adr";

  const markers = [
    ["nx.json", "nx.json", "{}\n"],
    ["lattice.json", "lattice.json", '{"projects":[]}\n'],
    [".moon", ".moon/workspace.yml", "projects: []\n"],
    [".config/moon", ".config/moon/workspace.yml", "projects: []\n"],
  ];

  for (const [label, markerPath, markerBody] of markers) {
    it(`reads the registry in a workspace rooted by ${label}`, () => {
      const adrRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-adr-"));
      try {
        mkdirSync(join(adrRoot, dirname(markerPath)), { recursive: true });
        writeFileSync(join(adrRoot, markerPath), markerBody);
        // The record's name is joined on rather than written as one literal:
        // spelled whole, `docs/adr/<id>.md` reads to `check-docs-links` as this
        // file citing a decision record in THIS repository, and the gate fails
        // on a path that resolves nowhere. The fixture's tree is not this tree.
        mkdirSync(join(adrRoot, ADR_FIXTURE_DIR), { recursive: true });
        writeFileSync(
          join(adrRoot, ADR_FIXTURE_DIR, "0001-layering.md"),
          "---\nstatus: accepted\n---\n\n# Layering\n",
        );
        // The registry reads only git-tracked files (P1-21) — `git ls-files`
        // has to see this fixture's own record, or the fix under test would
        // exclude it exactly like the untracked scratch file it is not.
        spawnSync("git", ["init", "--quiet"], { cwd: adrRoot, encoding: "utf8" });
        spawnSync("git", ["add", "-A"], { cwd: adrRoot, encoding: "utf8" });

        const result = spawnSync(process.execPath, [CLI, "adr"], {
          cwd: adrRoot,
          encoding: "utf8",
          timeout: 30_000,
          killSignal: "SIGKILL",
        });

        // The silent direction here is exit 3 with an empty registry read as
        // "nothing recorded": both this assertion and the next have to hold,
        // because a run that could not find the root and a run that found a
        // root with no ADRs both print no record.
        expect(result.status, `${label}: ${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("0001-layering");
      } finally {
        rmSync(adrRoot, { recursive: true, force: true });
      }
    });
  }
});

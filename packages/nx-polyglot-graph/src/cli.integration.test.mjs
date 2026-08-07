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
    expect(streams.lines.err.join("\n")).toContain("no Nx workspace above");
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
    expect(result.stdout).toContain("nx-polyglot-graph check");
    expect(result.stdout).toContain("module-boundaries.config.mjs");
    expect(result.stdout).toContain("--format text|sarif");
    expect(result.stdout).toContain("1 violations found");
  });
});

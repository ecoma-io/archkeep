import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { EXIT, runCli } from "../cli.mjs";

/**
 * The dogfood fixture: a real Go workspace whose intended architecture forbids
 * the import reality builds. `reconcile` must score the divergence, and
 * `reconcile --propose` must emit the ranked candidate list and leave
 * `architecture-intent.json` byte-identical — the read-only promise, measured.
 *
 * The graph and file list come from the same injected seams
 * `cli.integration.test.mjs` uses: the real analyzers read the real Go files,
 * the real judge scores the real intent, and only the Nx/spawn side is a
 * seam — neither has anything to say about whether an import is allowed.
 */
const root = mkdtempSync(join(tmpdir(), "reconcile-fixture-"));
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
  `export const depConstraints = [];\nexport const moduleBoundaryOptions = {\n  allow: [],\n  buildTargets: ["build"],\n  enforceBuildableLibDependency: false,\n  allowCircularSelfDependency: false,\n  checkDynamicDependenciesExceptions: [],\n  ignoredCircularDependencies: [],\n  banTransitiveDependencies: false,\n  checkNestedExternalImports: false,\n};\n`,
);

// The intended architecture: core (the engine) must never reach app (the
// consumer). Reality: core/app.go imports the app package.
write("libs/core/go.mod", "module example.com/core\n\ngo 1.24\n");
write("libs/core/core.go", "package core\n");
write(
  "libs/core/app.go",
  `package core

import "example.com/app"

var _ = app.Name
`,
);
write("apps/app/go.mod", "module example.com/app\n\ngo 1.24\n");
write("apps/app/app.go", 'package app\n\nconst Name = "core"\n');

const intentJson = `${JSON.stringify(
  {
    version: "1",
    boundaries: [
      { name: "packages", match: ["tag:type-package"] },
      { name: "apps", match: ["tag:type-application"] },
    ],
    forbidden: [{ from: "packages", to: "apps", reason: "the engine must not reach out" }],
    projects: {
      required: [{ name: "core", tags: ["type-package"] }],
      forbidden: [{ name: "app" }],
    },
  },
  null,
  2,
)}\n`;
write("architecture-intent.json", intentJson);

const intentBytes = readFileSync(join(root, "architecture-intent.json"), "utf8");

const graph = {
  nodes: {
    core: {
      name: "core",
      type: "lib",
      data: { root: "libs/core", tags: ["type-package"] },
    },
    app: {
      name: "app",
      type: "app",
      data: { root: "apps/app", tags: ["type-application"] },
    },
  },
  dependencies: {
    core: [{ source: "core", target: "app", type: "static" }],
  },
};

const files = [
  "nx.json",
  "module-boundaries.config.mjs",
  "architecture-intent.json",
  "libs/core/go.mod",
  "libs/core/core.go",
  "libs/core/app.go",
  "apps/app/go.mod",
  "apps/app/app.go",
];

const context = { cwd: root, readGraph: () => graph, listFiles: () => files };

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

describe("reconcile over a real divergent tree", () => {
  it("scores the divergence and reports a number of elements", async () => {
    const e = env();
    const exit = await runCli(["reconcile"], e);
    expect(exit).toBe(EXIT.ok);
    const text = e.lines.out.join("\n");
    expect(text).toContain("intent");
    expect(text).toContain("observed");
    expect(text).toContain("divergence");
  });

  it("--propose emits a ranked candidate list and leaves the intent file byte-identical", async () => {
    const e = env();
    const exit = await runCli(["reconcile", "--propose"], e);
    expect(exit).toBe(EXIT.ok);
    const text = e.lines.out.join("\n");
    expect(text).toContain("proposal");
    expect(readFileSync(join(root, "architecture-intent.json"), "utf8")).toBe(intentBytes);
  });

  it("the JSON envelope agrees with the text verdict and the intent file stays byte-identical", async () => {
    const before = readFileSync(join(root, "architecture-intent.json"), "utf8");
    const e = env();
    const exit = await runCli(["reconcile", "--propose", "--format", "json"], e);
    expect(exit).toBe(EXIT.ok);
    const envelope = JSON.parse(e.lines.out.join("\n"));
    expect(envelope.command).toBe("reconcile");
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.result.proposed).toBe(true);
    expect(envelope.result.notAuthoritative).toBe(true);
    expect(readFileSync(join(root, "architecture-intent.json"), "utf8")).toBe(before);
  });
});

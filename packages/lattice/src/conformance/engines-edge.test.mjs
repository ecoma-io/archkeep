/**
 * The two engines' edge paths: a fixture file that does not parse, and a
 * materialized file that cannot be read back.
 *
 * The integration suite's fixtures all parse and all exist on disk, which is
 * exactly why the differential means something — but it also means two of
 * `run`'s guards never fire there. Both are the same failure turned into
 * data: a broken fixture must record a note, never masquerade as a clean
 * verdict, and a listed file that cannot be read must be skipped loudly, not
 * crash the run.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runEngine } from "./engines.mjs";

describe("the engines over a minimal tree", () => {
  let root;

  beforeAll(() => {
    // Point nx at the fixture BEFORE anything loads it (`fixture.mjs`'s
    // `createFixtureRoot` owns the ordering; this file only owns the one
    // directory it needs).
    root = mkdtempSync(join(realpathSync(tmpdir()), "lattice-engines-"));
    process.env.NX_WORKSPACE_ROOT_PATH = root;
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("records a broken fixture's parse error as a note, never as a clean verdict", async () => {
    // A fixture source ESLint cannot parse still produces an ESLint result —
    // its messages are the parser's, not the boundary rule's. The runner must
    // record them as notes: a verdict-less file is not a clean file, and a
    // fixture that stopped parsing would otherwise read as agreement.
    mkdirSync(join(root, "broken"), { recursive: true });
    writeFileSync(join(root, "broken", "broken.ts"), "import { from 'x';\n", "utf8");

    const { createUpstreamRunner } = await import("./engines.mjs");
    const upstream = await createUpstreamRunner(root);
    const byFile = await upstream.run({
      spec: { id: "broken", probes: [{ file: "broken.ts" }] },
      graph: { nodes: {}, externalNodes: {}, dependencies: {} },
      projectFileMap: {},
      options: {},
      depConstraints: [],
      projects: [],
      files: ["broken/broken.ts"],
    });

    const entry = byFile.get("broken/broken.ts");
    expect(entry.readable).toBe(true);
    expect(entry.messages).toEqual([]);
    expect(entry.notes.length).toBeGreaterThan(0);
    expect(entry.notes[0]).toMatch(/Parsing error/);
  });

  it("skips a listed source that cannot be read back, instead of crashing the run", () => {
    // A file the materialised tree names but that is not on disk (deleted
    // between listing and read) is data, not an exception: the engine keeps
    // the envelope shape and judges the files it could read.
    mkdirSync(join(root, "case", "app"), { recursive: true });
    writeFileSync(
      join(root, "case", "app", "main.ts"),
      "import { x } from './lib';\nexport const x = 1;\n",
      "utf8",
    );
    const materialized = {
      projects: [{ name: "app", root: "case/app" }],
      files: ["case/app/main.ts", "case/app/gone.ts"],
      graph: {
        nodes: {
          app: {
            name: "app",
            type: "lib",
            data: { root: "case/app", tags: ["layer:util"] },
          },
        },
        externalNodes: {},
        dependencies: { app: [] },
      },
      depConstraints: [],
      // `evaluate` refuses a boundary config with any option unstated, so the
      // materialised shape carries every one, exactly as `materialize()` does
      // by spreading the installed rule's defaults.
      options: {
        allow: [],
        buildTargets: ["build"],
        enforceBuildableLibDependency: false,
        allowCircularSelfDependency: false,
        checkDynamicDependenciesExceptions: [],
        ignoredCircularDependencies: [],
        banTransitiveDependencies: false,
        checkNestedExternalImports: false,
      },
      suppressions: [],
    };
    const result = runEngine(root, materialized);
    expect(Array.isArray(result.violations)).toBe(true);
    expect(Array.isArray(result.failures)).toBe(true);
  });
});

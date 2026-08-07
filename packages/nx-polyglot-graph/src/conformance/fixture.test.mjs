/**
 * The materialiser's refusals.
 *
 * Every guard here protects against the same class of failure: a catalogue that
 * quietly means something other than what it says. Two cases sharing an alias
 * point one case's import into the other's tree; two installing the same
 * package name with different contents make whichever runs second wrong; a
 * duplicated case id drops a case with no trace. All three would leave the
 * differential green and meaningless, which is exactly the outcome the suite
 * exists to rule out — so they throw rather than resolve.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { assertNxRootIsFixture, materialize, removeFixtureRoot } from "./fixture.mjs";

const root = mkdtempSync(join(realpathSync(tmpdir()), "polyglot-fixture-guard-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The plugin's option defaults, as `materialize` takes them. */
const OPTION_DEFAULTS = { depConstraints: [], allow: [], banTransitiveDependencies: false };

const minimalCase = (id, overrides = {}) => ({
  id,
  intent: "guard",
  projects: [
    { name: `${id}-lib`, root: "libs/only", files: { "src/index.ts": "export const a = 1;\n" } },
  ],
  probes: [{ file: "libs/only/src/index.ts", upstream: [] }],
  ...overrides,
});

describe("materialising a case catalogue", () => {
  it("refuses two cases that claim the same import alias", () => {
    const cases = [
      minimalCase("first", { aliases: { "@shared/alias": "libs/only/src/index.ts" } }),
      minimalCase("second", { aliases: { "@shared/alias": "libs/only/src/index.ts" } }),
    ];
    expect(() => materialize(root, cases, OPTION_DEFAULTS)).toThrow(/both\s+declare the alias/u);
  });

  it("refuses two cases that install one package name with different contents", () => {
    const cases = [
      minimalCase("earlier", {
        externals: [
          { name: "@clash/pkg", files: { "index.d.ts": "export declare const a: 1;\n" } },
        ],
      }),
      minimalCase("later", {
        externals: [
          { name: "@clash/pkg", files: { "index.d.ts": "export declare const b: 2;\n" } },
        ],
      }),
    ];
    expect(() => materialize(root, cases, OPTION_DEFAULTS)).toThrow(/different contents/u);
  });

  it("refuses a duplicated case id, which would drop a case with no trace", () => {
    expect(() =>
      materialize(root, [minimalCase("twin"), minimalCase("twin")], OPTION_DEFAULTS),
    ).toThrow(/duplicate case id/u);
  });

  it("namespaces every project root, alias and file under its own case", () => {
    const materialized = materialize(
      root,
      [
        minimalCase("namespaced", {
          aliases: { "@namespaced/only": "libs/only/src/index.ts" },
          externals: [
            { name: "@namespaced/pkg", files: { "index.d.ts": "export declare const a: 1;\n" } },
          ],
          rootDependencies: ["@namespaced/pkg"],
        }),
      ],
      OPTION_DEFAULTS,
    );
    const entry = materialized.get("namespaced");
    expect(entry.graph.nodes["namespaced-lib"].data.root).toBe("namespaced/libs/only");
    expect(entry.files).toEqual(["namespaced/libs/only/src/index.ts"]);

    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.base.json"), "utf8"));
    expect(tsconfig.compilerOptions.paths["@namespaced/only"]).toEqual([
      "namespaced/libs/only/src/index.ts",
    ]);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(manifest.dependencies["@namespaced/pkg"]).toBe("1.0.0");
  });

  it("leaves an optional node field absent when the case leaves it absent", () => {
    // The fail-closed cases are entirely about a field NOT being there, so a
    // materialiser that helpfully defaulted one would turn them into no-ops.
    const materialized = materialize(
      root,
      [
        minimalCase("sparse"),
        minimalCase("furnished", {
          projects: [
            {
              name: "furnished-lib",
              root: "libs/only",
              mfeRemote: true,
              declaredPackages: ["@x/y"],
              entryPoints: [{ path: "libs/only/sub", file: "libs/only/src/sub.ts" }],
              files: { "src/index.ts": "export const a = 1;\n" },
            },
          ],
        }),
      ],
      OPTION_DEFAULTS,
    );
    const sparse = materialized.get("sparse").graph.nodes["sparse-lib"].data;
    expect(sparse).not.toHaveProperty("mfeRemote");
    expect(sparse).not.toHaveProperty("declaredPackages");
    expect(sparse).not.toHaveProperty("entryPoints");

    const furnished = materialized.get("furnished").graph.nodes["furnished-lib"].data;
    expect(furnished.mfeRemote).toBe(true);
    expect(furnished.entryPoints).toEqual([
      { path: "furnished/libs/only/sub", file: "furnished/libs/only/src/sub.ts" },
    ]);
  });

  it("gives every project a file-map entry, including one that owns no file", () => {
    // Upstream indexes the map unguarded when it lists the files that lazy-load
    // a library, so a missing project throws instead of printing less.
    const materialized = materialize(
      root,
      [
        minimalCase("mapped", {
          projects: [
            {
              name: "mapped-lib",
              root: "libs/only",
              files: { "src/index.ts": "export const a = 1;\n" },
            },
            { name: "mapped-empty", root: "libs/empty" },
          ],
          edges: [{ source: "mapped-lib", target: "mapped-empty", type: "dynamic" }],
        }),
      ],
      OPTION_DEFAULTS,
    );
    const map = materialized.get("mapped").projectFileMap;
    expect(Object.keys(map).sort()).toEqual(["mapped-empty", "mapped-lib"]);
    expect(map["mapped-lib"][0].deps).toEqual([["mapped-empty", "dynamic"]]);
    expect(map["mapped-empty"]).toEqual([]);
  });
});

describe("the guard on which workspace root nx resolved", () => {
  it("accepts the fixture root", () => {
    expect(() => assertNxRootIsFixture("/tmp/fixture", "/tmp/fixture")).not.toThrow();
  });

  it("refuses any other root, because upstream would then be reading the wrong tree", () => {
    expect(() => assertNxRootIsFixture("/tmp/fixture", "/repo")).toThrow(/not the fixture root/u);
  });
});

describe("removing a fixture root", () => {
  it("is safe to call on a root that is already gone", () => {
    const throwaway = mkdtempSync(join(realpathSync(tmpdir()), "polyglot-fixture-gone-"));
    removeFixtureRoot(throwaway);
    expect(() => removeFixtureRoot(throwaway)).not.toThrow();
  });
});

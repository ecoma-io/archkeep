// E2E scenarios for declared fitness functions, through the installed CLI.
//
// The suite already proves `fitness` exits 3 on a policy that declares none
// (`sweep.e2e.mjs`). What no E2E scenario covered is the state a pipeline
// actually steers on: a declared function that FAILS. A fitness failure is a
// finding, not a print job — `check` folds it into exit 1 the same way a
// boundary violation is folded — and that fold had never been exercised
// against a real `pnpm pack` tarball in a tree this repository did not build.
//
// The workspace is feature-sliced on purpose. Its constraint rows permit the
// edge the architecture forbids, because both slices carry the same
// `layer:slice` tag and "the same feature as the source" is not a value a tag
// list can name (`fixtures/vertical-slice-consumer.mjs`). So `check` here
// reports ZERO boundary violations and still exits 1 — which is the whole
// point: the two halves of a policy are judged independently and both reach
// the exit code.
//
// The journey runs in order on one workspace: clean → violation → fix →
// clean again. That ordering is the assertion. A suite that only proved the
// red would pass identically against an engine that reported on everything,
// and one that only proved the green would pass against an engine that
// reported nothing.
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { packArtifact } from "./helpers/artifact.mjs";
import { createNativeLanguageConsumer, commitFiles } from "./helpers/consumer.mjs";
import { lattice } from "./helpers/run.mjs";
import {
  ordersManifest,
  ordersSource,
  sliceModel,
  verticalSliceFiles,
} from "./fixtures/vertical-slice-consumer.mjs";

let artifact;
let consumer;

beforeAll(() => {
  artifact = packArtifact();
  consumer = createNativeLanguageConsumer(artifact, verticalSliceFiles);
});

afterAll(() => {
  consumer?.cleanup();
  artifact?.cleanup();
});

/** The tree with `orders` reaching into `catalog`, or with that edge removed. */
function setSliceCoupling(reachesCatalog) {
  commitFiles(
    consumer.root,
    {
      "libs/orders/go.mod": ordersManifest({ reachesCatalog }),
      "libs/orders/orders.go": ordersSource({ reachesCatalog }),
    },
    reachesCatalog ? "orders reaches into catalog" : "orders stops reaching into catalog",
  );
}

describe("a declared fitness function, end to end", () => {
  it("exits 0 on the clean tree and names the function that passed", () => {
    const result = lattice(consumer.root, ["fitness"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("slice-isolation");
    // A pass is a claim about what was judged, so the count has to be there:
    // a function that matched nothing is `not_applicable`, never this line.
    expect(result.stdout).toMatch(/2 matched projects/u);
  });

  it("folds the clean fitness verdict into check's exit code", () => {
    const result = lattice(consumer.root, ["check"]);
    expect(result.exitCode).toBe(0);
  });

  it("fails once a slice couples to another, naming both partitions", () => {
    setSliceCoupling(true);
    const result = lattice(consumer.root, ["fitness"]);
    expect(result.exitCode).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("slice-isolation");
    expect(output).toContain("orders (orders) → catalog (catalog)");
  });

  it("makes check exit 1 on a tree with no boundary violation at all", () => {
    // The assertion this whole file exists for. The constraint rows permit
    // `orders → catalog` — both are `layer:slice` — so a reader who only had
    // the violation count would see a clean workspace.
    const result = lattice(consumer.root, ["check"]);
    expect(result.exitCode).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("no boundary violations");
    expect(output).toContain("slice-isolation");
  });

  it("carries the failure into the JSON envelope with the edge that caused it", () => {
    const result = lattice(consumer.root, ["fitness", "--format", "json"]);
    expect(result.exitCode).toBe(1);
    expect(result.json, result.stdout).not.toBeNull();
    expect(result.json.status).toBe("findings");
    expect(result.json.result.verdict).toBe("fail");
    const decision = result.json.result.functions.find((row) => row.name === "slice-isolation");
    expect(decision.verdict).toBe("fail");
    expect(decision.rows).toEqual([
      {
        source: "orders",
        target: "catalog",
        sourceValues: ["orders"],
        targetValues: ["catalog"],
      },
    ]);
  });

  it("goes green again once the coupling is removed", () => {
    // Violation → fix → pass, on the same workspace. Without this the red
    // above could be a function that reports on every tree.
    setSliceCoupling(false);
    expect(lattice(consumer.root, ["fitness"]).exitCode).toBe(0);
    expect(lattice(consumer.root, ["check"]).exitCode).toBe(0);
  });

  it("refuses — never passes — when a matched project sits in no partition", () => {
    // The silent-failure guard. `catalog` keeps its `layer:slice` tag, so it
    // is still matched, but loses the `feature:` value that places it. The
    // function cannot judge its edges, and "cannot judge" must never render
    // as the exit 0 the same tree got one assertion above.
    commitFiles(
      consumer.root,
      { "lattice.json": sliceModel({ catalogTags: ["layer:slice"] }) },
      "catalog loses its feature tag",
    );
    try {
      const result = lattice(consumer.root, ["fitness"]);
      expect(result.exitCode).toBe(3);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("catalog");
      // And `check` inherits the same could-not-look class rather than the 0
      // it would have printed from the boundary rules alone.
      expect(lattice(consumer.root, ["check"]).exitCode).toBe(3);
    } finally {
      commitFiles(consumer.root, { "lattice.json": sliceModel() }, "catalog regains its tag");
    }
  });
});

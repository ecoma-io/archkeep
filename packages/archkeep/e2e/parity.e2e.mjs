// E2E scenarios for native/Nx semantic parity.
//
// Both providers describe the same two-project architecture (core and app,
// Go, layer:core/layer:app). The parity tests assert that the observable
// semantics agree: project names, edge source/target/type, violation rule
// IDs and file paths, and JSON envelope structure.
//
// Does NOT compare provider-specific metadata or absolute workspace root
// paths — those are expected to differ.
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import {
  createNxConsumer,
  createNativeConsumer,
  createNativeLanguageConsumer,
  createNxLanguageConsumer,
  createMoonConsumer,
  commitFiles,
  applyFiles,
  fixtureFiles,
} from "./helpers/consumer.mjs";
import { archkeep } from "./helpers/run.mjs";
import { CORE_REACHES_APP } from "./fixtures/violations.mjs";
import {
  canonicalNativeFiles,
  mutations as nativeMutations,
} from "./fixtures/canonical/native.mjs";
import { canonicalNxFiles, mutations as nxMutations } from "./fixtures/canonical/nx.mjs";
import { canonicalMoonFiles, mutations as moonMutations } from "./fixtures/canonical/moon.mjs";
import { CANONICAL_MUTATIONS } from "./fixtures/canonical/mutations.mjs";
import {
  assertCanonicalGraph,
  assertDelta,
  CANONICAL,
  canonicalPair,
  canonicalTags,
} from "./helpers/canonical.mjs";
import { gatedDescribe } from "./helpers/moon-gate.mjs";

let artifact;
let nxConsumer;
let nativeConsumer;

beforeAll(() => {
  artifact = packArtifact();
  nxConsumer = createNxConsumer(artifact);
  nativeConsumer = createNativeConsumer(artifact);
});

afterAll(() => {
  nxConsumer?.cleanup();
  nativeConsumer?.cleanup();
  artifact?.cleanup();
});

describe("parity", () => {
  it("graph JSON agrees on project names", () => {
    const nativeResult = archkeep(nativeConsumer.root, ["graph", "--format", "json"]);
    const nxResult = archkeep(nxConsumer.root, ["graph", "--format", "json"]);

    expect(nativeResult.exitCode).toBe(0);
    expect(nxResult.exitCode).toBe(0);

    const nativeNames = nativeResult.json.result.projects.map((p) => p.name).sort();
    const nxNames = nxResult.json.result.projects.map((p) => p.name).sort();
    expect(nativeNames).toEqual(nxNames);
  });

  it("graph JSON agrees on dependency edges (source, target, type)", () => {
    const nativeResult = archkeep(nativeConsumer.root, ["graph", "--format", "json"]);
    const nxResult = archkeep(nxConsumer.root, ["graph", "--format", "json"]);

    const nativeEdges = nativeResult.json.result.dependencies
      .map((e) => `${e.source}->${e.target}:${e.type}`)
      .sort();
    const nxEdges = nxResult.json.result.dependencies
      .map((e) => `${e.source}->${e.target}:${e.type}`)
      .sort();
    expect(nativeEdges).toEqual(nxEdges);
  });

  it("check agrees on violation rule ID and file when violating", () => {
    const nxViolator = createNxConsumer(artifact);
    const nativeViolator = createNativeConsumer(artifact);
    try {
      commitFiles(nativeViolator.root, CORE_REACHES_APP, "core reaches up into app");
      commitFiles(nxViolator.root, CORE_REACHES_APP, "core reaches up into app");

      const nativeResult = archkeep(nativeViolator.root, ["check", "--format", "json"]);
      const nxResult = archkeep(nxViolator.root, ["check", "--format", "json"]);

      expect(nativeResult.exitCode).toBe(1);
      expect(nxResult.exitCode).toBe(1);

      // Same violation rule IDs.
      const nativeIds = nativeResult.json.result.violations.map((v) => v.messageId).sort();
      const nxIds = nxResult.json.result.violations.map((v) => v.messageId).sort();
      expect(nativeIds).toEqual(nxIds);

      // Same violation file paths (relative paths, not absolute).
      const nativeFiles = nativeResult.json.result.violations.map((v) => v.sourceFile).sort();
      const nxFiles = nxResult.json.result.violations.map((v) => v.sourceFile).sort();
      expect(nativeFiles).toEqual(nxFiles);
    } finally {
      nativeViolator.cleanup();
      nxViolator.cleanup();
    }
  });

  it("check JSON envelope agrees on command, schemaVersion, status, exitCode", () => {
    const nativeResult = archkeep(nativeConsumer.root, ["check", "--format", "json"]);
    const nxResult = archkeep(nxConsumer.root, ["check", "--format", "json"]);

    expect(nativeResult.json.command).toEqual(nxResult.json.command);
    expect(nativeResult.json.schemaVersion).toEqual(nxResult.json.schemaVersion);
    expect(nativeResult.json.status).toEqual(nxResult.json.status);
    expect(nativeResult.json.exitCode).toEqual(nxResult.json.exitCode);
  });
});

/**
 * One provider's observable answer for one mutation: the exact delta as a
 * comparable signature (registry-checked by the caller through `assertDelta`),
 * applies the provider's transform, asserts the diff delta, captures the
 * check verdict.
 *
 * `recordsPerPair` is the provider's edge-record multiplicity — how many
 * graph records one canonical pair moves as. The providers dedupe edges on
 * `(source, target, type)` (`src/governance/fitness-rules.mjs`), so a pair
 * that reaches the graph through two channels (Moon: a TypeScript import as
 * `static` and a `dependsOn` as `implicit`) legitimately moves twice. The
 * strict per-record count is asserted here, against the registry; the
 * cross-provider comparison below compares DEDUPLICATED pair signatures, so
 * native (one channel) and moon (two) can agree on the same architecture.
 *
 * @param {number} [recordsPerPair] Records per canonical edge pair
 *   (default 1 — the single-channel providers).
 * @returns {{delta: string, exit: number, stderr: string}}
 */
const paritySide = (consumer, baseline, clean, providerMutations, row, recordsPerPair = 1) => {
  const mutated = providerMutations[row.name](clean);
  applyFiles(consumer.root, clean, mutated, `parity mutation: ${row.name}`);
  try {
    const diff = archkeep(consumer.root, ["diff", baseline, "--format", "json"]);
    expect(diff.exitCode, `diff exit for ${row.name}\nstderr: ${diff.stderr}`).toBe(0);
    assertDelta(diff.json.result, row.delta, { recordsPerPair });
    const check = archkeep(consumer.root, ["check", "--format", "json"]);
    return {
      delta: JSON.stringify({
        addedProjects: (diff.json.result.addedProjects ?? []).map((p) => p.name ?? p).sort(),
        removedProjects: (diff.json.result.removedProjects ?? []).map((p) => p.name ?? p).sort(),
        changedProjects: (diff.json.result.changedProjects ?? []).map((p) => p.name ?? p).sort(),
        addedEdges: [
          ...new Set(
            diff.json.result.addedEdges.map((edge) =>
              typeof edge === "string" ? edge : canonicalPair(edge),
            ),
          ),
        ].sort(),
        removedEdges: [
          ...new Set(
            diff.json.result.removedEdges.map((edge) =>
              typeof edge === "string" ? edge : canonicalPair(edge),
            ),
          ),
        ].sort(),
      }),
      exit: check.exitCode,
      stderr: check.stderr,
    };
  } finally {
    applyFiles(consumer.root, mutated, clean, `parity revert: ${row.name}`);
  }
};

/**
 * Same canonical graph on both sides: per-project sorted tags, and the edge
 * pairs the oracle states. `recordsPerPair` is the other provider's
 * edge-record multiplicity (see `paritySide`): with the default 1 the other
 * graph must equal the oracle exactly; above 1, one canonical pair arrives
 * as several records, so the unique pairs are judged against the oracle and
 * every pair's record count is asserted separately.
 *
 * @param {number} [recordsPerPair] Records per canonical edge pair in the
 *   other provider's graph (default 1).
 */
const graphAgrees = (nativeResult, otherResult, otherLabel, recordsPerPair = 1) => {
  expect(otherResult.json.schemaVersion).toBe(nativeResult.json.schemaVersion);
  expect(otherResult.json.coverage?.complete, `${otherLabel} coverage complete`).toBe(true);
  assertCanonicalGraph(nativeResult.json.result);
  const otherEdges = otherResult.json.result.dependencies ?? [];
  if (recordsPerPair === 1) {
    assertCanonicalGraph(otherResult.json.result);
  } else {
    const uniquePairs = [
      ...new Map(otherEdges.map((edge) => [canonicalPair(edge), edge])).values(),
    ];
    assertCanonicalGraph({ ...otherResult.json.result, dependencies: uniquePairs });
    const counts = otherEdges.reduce((acc, edge) => {
      acc.set(canonicalPair(edge), (acc.get(canonicalPair(edge)) ?? 0) + 1);
      return acc;
    }, new Map());
    for (const pair of CANONICAL.edges.map((edge) => canonicalPair(edge))) {
      expect(counts.get(pair), `${otherLabel} record count for ${pair}`).toBe(recordsPerPair);
    }
  }
  const canonicalTagOf = (project) => canonicalTags(project)[0];
  const tagsOf = (result) =>
    JSON.stringify(
      result.projects.map((project) => [project.name, [...(project.tags ?? [])].sort()]).sort(),
    );
  const expand = (pairs) =>
    pairs.flatMap((pair) => Array.from({ length: recordsPerPair }, () => pair)).sort();
  if (recordsPerPair === 1) {
    expect(tagsOf(otherResult.json.result), `${otherLabel} tags match native`).toBe(
      tagsOf(nativeResult.json.result),
    );
  } else {
    // A multi-channel provider may also layer its own inferred tags on top
    // of the canonical ones (Moon tags every project `layer:unknown` and
    // `stack:unknown` no matter what `moon.yml` declares). The contract that
    // survives the provider: each project carries its canonical tag, and the
    // inherited extras are uniform — the same inference for every project,
    // not per-project noise. The exact extras are pinned in the Moon suite,
    // against the pinned CLI version.
    for (const project of otherResult.json.result.projects) {
      expect(project.tags ?? [], `${otherLabel} canonical tag on ${project.name}`).toContain(
        canonicalTagOf(project.name),
      );
    }
    const inheritedOf = (project) =>
      (project.tags ?? []).filter((tag) => tag !== canonicalTagOf(project.name)).sort();
    expect(
      new Set(
        otherResult.json.result.projects.map((project) => JSON.stringify(inheritedOf(project))),
      ).size,
      `${otherLabel} inherited tags are uniform across projects`,
    ).toBe(1);
  }
  expect(
    otherEdges.map((edge) => `${edge.source}->${edge.target}`).sort(),
    `${otherLabel} edges match native`,
  ).toEqual(
    expand(
      (nativeResult.json.result.dependencies ?? []).map((edge) => `${edge.source}->${edge.target}`),
    ),
  );
};

describe("canonical parity: native and nx", () => {
  let native;
  let nx;
  let nativeClean;
  let nxClean;
  let nativeBaseline;
  let nxBaseline;

  beforeAll(() => {
    native = createNativeLanguageConsumer(artifact, canonicalNativeFiles);
    nx = createNxLanguageConsumer(artifact, canonicalNxFiles);
    nativeClean = fixtureFiles(artifact, canonicalNativeFiles);
    nxClean = fixtureFiles(artifact, canonicalNxFiles);
    nativeBaseline = join(native.root, "baseline-parity.json");
    nxBaseline = join(nx.root, "baseline-parity.json");
    archkeep(native.root, ["graph", "--format", "json", "--output", nativeBaseline]);
    archkeep(nx.root, ["graph", "--format", "json", "--output", nxBaseline]);
  });

  afterAll(() => {
    native?.cleanup();
    nx?.cleanup();
  });

  it("draws the same canonical graph, tags included", () => {
    const nativeGraph = archkeep(native.root, ["graph", "--format", "json"]);
    const nxGraph = archkeep(nx.root, ["graph", "--format", "json"]);
    expect(nativeGraph.exitCode).toBe(0);
    expect(nxGraph.exitCode).toBe(0);
    graphAgrees(nativeGraph, nxGraph, "nx");
  });

  for (const row of CANONICAL_MUTATIONS) {
    it(`mutation ${row.name}: nx matches native on delta and verdict`, () => {
      const nativeSide = paritySide(native, nativeBaseline, nativeClean, nativeMutations, row);
      const nxSide = paritySide(nx, nxBaseline, nxClean, nxMutations, row);

      expect(nxSide.delta, `same delta as native for ${row.name}`).toBe(nativeSide.delta);
      expect(nxSide.exit, `same verdict as native for ${row.name}`).toBe(nativeSide.exit);

      const expectedExit = row.refusal ? 3 : row.violation ? 1 : 0;
      expect(nativeSide.exit, `native verdict per the registry for ${row.name}`).toBe(expectedExit);
      if (row.refusal) {
        expect(nativeSide.stderr, `native refusal names it for ${row.name}`).toContain(row.refusal);
        expect(nxSide.stderr, `nx refusal names it for ${row.name}`).toContain(row.refusal);
      }
    });
  }
});

gatedDescribe("canonical parity: moon", () => {
  let native;
  let moon;
  let nativeClean;
  let moonClean;
  let nativeBaseline;
  let moonBaseline;

  beforeAll(() => {
    native = createNativeLanguageConsumer(artifact, canonicalNativeFiles);
    moon = createMoonConsumer(artifact, canonicalMoonFiles);
    nativeClean = fixtureFiles(artifact, canonicalNativeFiles);
    moonClean = fixtureFiles(artifact, canonicalMoonFiles);
    nativeBaseline = join(native.root, "baseline-parity.json");
    moonBaseline = join(moon.root, "baseline-parity.json");
    archkeep(native.root, ["graph", "--format", "json", "--output", nativeBaseline]);
    archkeep(moon.root, ["graph", "--format", "json", "--output", moonBaseline]);
  });

  afterAll(() => {
    native?.cleanup();
    moon?.cleanup();
  });

  it("draws the same canonical graph as native, tags included", () => {
    const nativeGraph = archkeep(native.root, ["graph", "--format", "json"]);
    const moonGraph = archkeep(moon.root, ["graph", "--format", "json"]);
    expect(nativeGraph.exitCode).toBe(0);
    expect(moonGraph.exitCode).toBe(0);
    graphAgrees(nativeGraph, moonGraph, "moon", 2);

    // Pin the channels, not only the count: the Moon provider maps its own
    // graph's `explicit` (a hand-written `dependsOn`) onto archkeep's
    // `implicit`, and the TypeScript analyzer supplies the `static` record —
    // so every canonical pair must arrive exactly once per channel. Losing
    // one channel to a provider regression must fail here as a missing
    // record, not as an anonymous count drop.
    const records = moonGraph.json.result.dependencies
      .map((edge) => `${canonicalPair(edge)} ${edge.type}`)
      .sort();
    expect(records).toEqual([
      "api->application implicit",
      "api->application static",
      "application->core implicit",
      "application->core static",
      "application->infrastructure implicit",
      "application->infrastructure static",
    ]);

    // Moon's own inference, pinned against the pinned `@moonrepo/cli`:
    // every project inherits `layer:unknown` and `stack:unknown` beside its
    // declared tags. A Moon upgrade that changes the inference fails HERE,
    // loudly, rather than quietly loosening the uniformity rule in
    // `graphAgrees`.
    for (const project of moonGraph.json.result.projects) {
      const inherited = (project.tags ?? []).filter((tag) => !tag.startsWith("layer/")).sort();
      expect(inherited, `moon inferred tags on ${project.name}`).toEqual([
        "layer:unknown",
        "stack:unknown",
      ]);
    }
  });

  for (const row of CANONICAL_MUTATIONS) {
    it(`mutation ${row.name}: moon matches native on delta and verdict`, () => {
      const nativeSide = paritySide(native, nativeBaseline, nativeClean, nativeMutations, row);
      const moonSide = paritySide(moon, moonBaseline, moonClean, moonMutations, row, 2);

      expect(moonSide.delta, `same delta as native for ${row.name}`).toBe(nativeSide.delta);
      expect(moonSide.exit, `same verdict as native for ${row.name}`).toBe(nativeSide.exit);

      const expectedExit = row.refusal ? 3 : row.violation ? 1 : 0;
      expect(nativeSide.exit, `native verdict per the registry for ${row.name}`).toBe(expectedExit);
      if (row.refusal) {
        expect(nativeSide.stderr, `native refusal names it for ${row.name}`).toContain(row.refusal);
        expect(moonSide.stderr, `moon refusal names it for ${row.name}`).toContain(row.refusal);
      }
    });
  }
});

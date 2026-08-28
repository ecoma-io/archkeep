// The canonical architecture under the native provider: one hand-authored
// four-project Go workspace, one baseline, and the full mutation registry
// (`fixtures/canonical/mutations.mjs`) applied to a live consumer.
//
// The registry holds the expectations; this file only wires them to the
// provider. Each mutation is applied, diffed against the pre-taken baseline,
// checked against the boundary law, and then reverted — and the final test
// re-asserts the clean canonical graph, so an imperfect revert cannot hide
// behind any single mutation's assertions.
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import { createNativeLanguageConsumer, fixtureFiles, applyFiles } from "./helpers/consumer.mjs";
import { archkeep } from "./helpers/run.mjs";
import { canonicalNativeFiles, mutations } from "./fixtures/canonical/native.mjs";
import { CANONICAL_MUTATIONS } from "./fixtures/canonical/mutations.mjs";
import { assertCanonicalGraph, assertDelta } from "./helpers/canonical.mjs";

let artifact;
let consumer;
let clean;
let baselineFile;

beforeAll(() => {
  artifact = packArtifact();
  consumer = createNativeLanguageConsumer(artifact, canonicalNativeFiles);
  clean = fixtureFiles(artifact, canonicalNativeFiles);
  baselineFile = join(consumer.root, "baseline-canonical.json");
});

afterAll(() => {
  consumer?.cleanup();
  artifact?.cleanup();
});

describe("canonical graph (native)", () => {
  it("discovers exactly the canonical graph and nothing else", () => {
    const result = archkeep(consumer.root, ["graph", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json.schemaVersion).toBe(2);
    expect(result.json.coverage.complete).toBe(true);
    // Missing, unexpected, renamed, reversed, and duplicated pairs all fail
    // loudly inside the oracle.
    assertCanonicalGraph(result.json.result);
  });

  it("a clean canonical tree passes the boundary law", () => {
    const result = archkeep(consumer.root, ["check", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json.result.violations ?? []).toEqual([]);
  });

  it("diffs against its own baseline to an empty delta", () => {
    const baseline = archkeep(consumer.root, [
      "graph",
      "--format",
      "json",
      "--output",
      baselineFile,
    ]);
    expect(baseline.exitCode).toBe(0);
    const result = archkeep(consumer.root, ["diff", baselineFile, "--format", "json"]);
    expect(result.exitCode).toBe(0);
    assertDelta(result.json.result, {});
  });

  for (const row of CANONICAL_MUTATIONS) {
    it(`mutation ${row.name}: exact delta and law verdict per the registry`, () => {
      const mutated = mutations[row.name](clean);
      applyFiles(consumer.root, clean, mutated, `mutation: ${row.name}`);
      try {
        const diff = archkeep(consumer.root, ["diff", baselineFile, "--format", "json"]);
        expect(diff.exitCode).toBe(0);
        assertDelta(diff.json.result, row.delta);

        const check = archkeep(consumer.root, ["check", "--format", "json"]);
        if (row.refusal) {
          expect(check.exitCode, `check refuses ${row.name}`).toBe(3);
          expect(check.stderr, `refusal message for ${row.name}`).toContain(row.refusal);
        } else {
          expect(check.exitCode, `check exit for ${row.name}`).toBe(row.violation ? 1 : 0);
          if (row.violation) {
            const violations = check.json.result.violations ?? [];
            expect(violations.length, `violations reported for ${row.name}`).toBeGreaterThan(0);
            expect(
              violations.some((violation) => violation.sourceProject === row.violatingSource),
              `offending source project ${row.violatingSource} named for ${row.name}`,
            ).toBe(true);
          }
        }
      } finally {
        applyFiles(consumer.root, mutated, clean, `revert: ${row.name}`);
      }
    });
  }

  it("survives the whole loop: the reverted tree is the canonical graph again", () => {
    const graph = archkeep(consumer.root, ["graph", "--format", "json"]);
    expect(graph.exitCode).toBe(0);
    assertCanonicalGraph(graph.json.result);
    const check = archkeep(consumer.root, ["check", "--format", "json"]);
    expect(check.exitCode).toBe(0);
    expect(check.json.result.violations ?? []).toEqual([]);
  });
});

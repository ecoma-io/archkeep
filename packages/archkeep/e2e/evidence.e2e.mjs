// E2E scenarios for edge-evidence conflicts between the two witness tracks.
//
// ADR 0006 Decision 3 gives every .NET edge two independent witnesses: the
// manifest track (`<ProjectReference>`) and the source track (a written
// `using`). Neither cross-validates the other, and the graph dedupes their
// agreement to ONE record by `(source, target, type)`. The conflict cases
// here ask what a reader of the graph can conclude when the two tracks stop
// agreeing about a pair the baseline graph carried:
//
//   - one witness withdrawn  → the edge survives, and `diff` must see NO
//     change. Either witness alone holds the edge; a phantom add or removal
//     here would be the multiplicity bug (two records for one pair) wearing
//     a different hat.
//   - both witnesses withdrawn → exactly ONE removed edge, proving the
//     empty deltas above are the dedupe contract holding, not the tool
//     going blind.
//
// Before declared edges reached every face's graph, the second case reported
// a phantom removal — the edge existed only through its import witness, so
// deleting the import deleted the edge (exit-still-0, but a delta that lied
// about the workspace: the pom still said the projects depended on each
// other). The case pins the ADR-mandated answer.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";

import { packArtifact } from "./helpers/artifact.mjs";
import { createNativeLanguageConsumer, commitFiles } from "./helpers/consumer.mjs";
import { archkeep } from "./helpers/run.mjs";
import { dotnetLanguageFiles } from "./fixtures/languages/dotnet.mjs";

const PROJECT_SHELL =
  '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework>';

/** The dual-track csproj with its ProjectReference withdrawn. */
const APPLICATION_CSPROJ_NO_REFERENCE = `${PROJECT_SHELL}</PropertyGroup></Project>\n`;

/** App.cs with its `using Example.Domain` withdrawn. */
const APP_CS_NO_USING = "namespace Example.Application;\n\nclass App {}\n";

let artifact;

beforeAll(() => {
  artifact = packArtifact();
});

afterAll(() => {
  artifact?.cleanup();
});

/**
 * Graphs the clean dual-track tree into a baseline file, applies a witness
 * mutation, and returns the diff envelope. `diff` is descriptive — it never
 * exits 1 — so every assertion here is about the delta's CONTENT.
 *
 * @param {{ root: string, cleanup: () => void }} consumer The language consumer.
 * @param {Record<string, string>} mutation The witness withdrawal to commit.
 * @returns {{ exitCode: number, stdout: string, stderr: string, json: object|null }} The diff envelope.
 */
function diffAfterWitnessChange(consumer, mutation) {
  const baselineFile = join(consumer.root, "baseline-witness.json");
  archkeep(consumer.root, ["graph", "--format", "json", "--output", baselineFile]);
  commitFiles(consumer.root, mutation, "withdraw one witness of application→domain");
  return archkeep(consumer.root, ["diff", baselineFile, "--format", "json"]);
}

describe("edge evidence conflicts", () => {
  it("keeps the graph stable when the manifest witness is withdrawn and the using remains", () => {
    const consumer = createNativeLanguageConsumer(artifact, dotnetLanguageFiles);
    try {
      const result = diffAfterWitnessChange(consumer, {
        "libs/application/Application.csproj": APPLICATION_CSPROJ_NO_REFERENCE,
      });
      expect(result.exitCode).toBe(0);
      expect(result.json.result.addedProjects).toEqual([]);
      expect(result.json.result.removedProjects).toEqual([]);
      expect(result.json.result.addedEdges).toEqual([]);
      expect(result.json.result.removedEdges).toEqual([]);
    } finally {
      consumer.cleanup();
    }
  });

  it("keeps the graph stable when the using is withdrawn and the ProjectReference remains", () => {
    const consumer = createNativeLanguageConsumer(artifact, dotnetLanguageFiles);
    try {
      const result = diffAfterWitnessChange(consumer, {
        "libs/application/App.cs": APP_CS_NO_USING,
      });
      expect(result.exitCode).toBe(0);
      expect(result.json.result.addedProjects).toEqual([]);
      expect(result.json.result.removedProjects).toEqual([]);
      expect(result.json.result.addedEdges).toEqual([]);
      expect(result.json.result.removedEdges).toEqual([]);
    } finally {
      consumer.cleanup();
    }
  });

  it("removes exactly one edge when both witnesses are withdrawn", () => {
    const consumer = createNativeLanguageConsumer(artifact, dotnetLanguageFiles);
    try {
      const result = diffAfterWitnessChange(consumer, {
        "libs/application/Application.csproj": APPLICATION_CSPROJ_NO_REFERENCE,
        "libs/application/App.cs": APP_CS_NO_USING,
      });
      expect(result.exitCode).toBe(0);
      expect(result.json.result.addedEdges).toEqual([]);
      expect(result.json.result.removedProjects).toEqual([]);
      expect(result.json.result.removedEdges).toEqual([
        { source: "application", target: "domain", type: "static" },
      ]);
    } finally {
      consumer.cleanup();
    }
  });

  it("carries each dual-track pair as one record on the graph face", () => {
    // The unit suite pins `mergeDeclaredEdges`'s dedupe in-process; this pins
    // the installed CLI's flattened envelope, the shape every consumer
    // actually reads.
    const consumer = createNativeLanguageConsumer(artifact, dotnetLanguageFiles);
    try {
      const graph = archkeep(consumer.root, ["graph", "--format", "json"]);
      expect(graph.exitCode).toBe(0);
      const pair = graph.json.result.dependencies.filter(
        (e) => e.source === "application" && e.target === "domain",
      );
      expect(pair).toEqual([{ source: "application", target: "domain", type: "static" }]);
    } finally {
      consumer.cleanup();
    }
  });
});

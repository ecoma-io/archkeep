// Workspace-level metamorphic e2e: graph-invariant source mutations.
//
// The unit tier (`src/analysis/metamorphic.test.mjs`) proves per-language
// analyzers are invariant to comments and renames at the record level. This
// suite proves the whole installed pipeline — git walk, masking, index,
// resolution, graph, diff — is invariant to source edits that carry no
// boundary meaning: a graph delta from any of these is a false positive by
// construction, the loud direction this suite pins.
//
// Every mutation also asserts it actually changed the committed bytes. A
// metamorphic suite whose mutation silently applied nothing would assert
// invariance over an unchanged tree — green forever, testing nothing — so
// the mutation's own application is checked before the graph is asked.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import { createNativeLanguageConsumer, commitFiles } from "./helpers/consumer.mjs";
import { archkeep } from "./helpers/run.mjs";
import { typescriptLanguageFiles } from "./fixtures/languages/typescript.mjs";
import { javaLanguageFiles } from "./fixtures/languages/java.mjs";
import { dotnetLanguageFiles } from "./fixtures/languages/dotnet.mjs";

let artifact;

beforeAll(() => {
  artifact = packArtifact();
});

afterAll(() => {
  artifact?.cleanup();
});

/**
 * Runs one metamorphic case: baseline graph, commit the mutation, diff
 * against the baseline, and demand an empty delta. Also asserts the mutated
 * files really changed on disk, so an empty delta can only mean the graph
 * was invariant — never that the mutation never landed.
 *
 * @param {string} language The fixture language name.
 * @param {(packageName: string, peers: Record<string, string>, packageManager: string) => Record<string, string>} fixtureFn
 * @param {Record<string, string>} mutation The graph-invariant edit to commit.
 */
function expectGraphInvariant(language, fixtureFn, mutation) {
  const consumer = createNativeLanguageConsumer(artifact, fixtureFn);
  try {
    for (const [path, next] of Object.entries(mutation)) {
      expect(readFileSync(join(consumer.root, path), "utf8"), `${path} baseline bytes`).not.toBe(
        next,
      );
    }
    const baselineFile = join(consumer.root, "baseline-metamorphic.json");
    archkeep(consumer.root, ["graph", "--format", "json", "--output", baselineFile]);
    commitFiles(consumer.root, mutation, `metamorphic: ${language} graph-invariant edit`);

    const result = archkeep(consumer.root, ["diff", baselineFile, "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json.result.addedProjects).toEqual([]);
    expect(result.json.result.removedProjects).toEqual([]);
    expect(result.json.result.addedEdges).toEqual([]);
    expect(result.json.result.removedEdges).toEqual([]);
  } finally {
    consumer.cleanup();
  }
}

describe("workspace-level metamorphic invariance", () => {
  it("typescript: comments, blank lines, and import order move nothing", () => {
    expectGraphInvariant("typescript", typescriptLanguageFiles, {
      // A doc comment and extra blank lines around an existing import.
      "libs/application/src/index.ts":
        "/** Application entry — the comment below is decoration. */\n\n\n" +
        'import { name } from "@example/domain";\n\n\n' +
        "export const app = name;\n",
      // The two imports swap: `import type` first, value import second.
      "libs/api/src/index.ts":
        'import type { name } from "@example/domain";\n' +
        'import { app } from "@example/application";\n\n' +
        "export const api = app;\n",
    });
  });

  it("java: comments and a dead class move nothing", () => {
    expectGraphInvariant("java", javaLanguageFiles, {
      "libs/application/src/main/java/com/example/application/App.java":
        "package com.example.application;\n\n" +
        "/* Decorative comment: imports are masked, not stripped, so a\n" +
        "   comment that MENTIONED an import would still be inert. */\n\n" +
        "import com.example.domain.Name;\n\n" +
        "class App { Name name; }\n\n" +
        "class DeadWeight { }\n",
    });
  });

  it("csharp: comments, blank lines, and a dead class move nothing", () => {
    expectGraphInvariant("csharp", dotnetLanguageFiles, {
      "libs/application/App.cs":
        "using Example.Domain;\n\n" +
        "// A comment naming Example.Domain is still only a comment.\n\n" +
        "namespace Example.Application;\n\n" +
        "class App { Name name; }\n\n" +
        "class DeadWeight { }\n",
    });
  });
});

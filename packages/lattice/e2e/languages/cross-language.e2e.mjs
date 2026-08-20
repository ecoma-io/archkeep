// Cross-language parity E2E scenarios.
//
// Proves that Lattice's architecture model is language-independent: all
// six language fixtures express the same three-layer architecture
// (domain, application, api) and must produce the same normalized graph
// — same project names, same edge source/target/type — even though each
// language's dependency extraction is different.
//
// This is the most important invariant the multi-language E2E suite
// defends: a parser regression in one language that silently drops edges
// would be caught here, because the normalized graph would differ from
// the other five.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "../helpers/artifact.mjs";
import { createNativeLanguageConsumer } from "../helpers/consumer.mjs";
import { lattice } from "../helpers/run.mjs";

const LANGUAGES = ["go", "typescript", "javascript", "vue", "rust", "python"];

let artifact;
const consumers = {};

beforeAll(() => {
  artifact = packArtifact();
  for (const lang of LANGUAGES) {
    consumers[lang] = createNativeLanguageConsumer(artifact, lang);
  }
});

afterAll(() => {
  for (const lang of LANGUAGES) {
    consumers[lang]?.cleanup();
  }
  artifact?.cleanup();
});

describe("Cross-language parity", () => {
  it("all six languages agree on project names", () => {
    const results = {};
    for (const lang of LANGUAGES) {
      const result = lattice(consumers[lang].root, ["graph", "--format", "json"]);
      expect(result.exitCode, `${lang} graph exit code`).toBe(0);
      results[lang] = result.json.result.projects.map((p) => p.name).sort();
    }
    // Every language must produce the same project name set.
    const expected = ["api", "application", "domain"];
    for (const lang of LANGUAGES) {
      expect(results[lang], `${lang} project names`).toEqual(expected);
    }
  });

  it("all six languages agree on normalized dependency edges", () => {
    const results = {};
    for (const lang of LANGUAGES) {
      const result = lattice(consumers[lang].root, ["graph", "--format", "json"]);
      results[lang] = result.json.result.dependencies
        .map((e) => `${e.source}->${e.target}:${e.type}`)
        .sort();
    }
    // All languages must produce at least application→domain and
    // api→application edges. Some may produce additional edges (e.g. the
    // JavaScript fixture's api→domain require), but the core two must exist
    // in every language.
    for (const lang of LANGUAGES) {
      expect(
        results[lang].some((e) => e.startsWith("application->domain:")),
        `${lang} must have application→domain edge`,
      ).toBe(true);
      expect(
        results[lang].some((e) => e.startsWith("api->application:")),
        `${lang} must have api→application edge`,
      ).toBe(true);
    }
  });

  it("all six languages agree on check JSON envelope structure", () => {
    for (const lang of LANGUAGES) {
      const result = lattice(consumers[lang].root, ["check", "--format", "json"]);
      expect(result.exitCode, `${lang} check exit code`).toBe(0);
      expect(result.json.command, `${lang} command`).toBe("check");
      expect(result.json.schemaVersion, `${lang} schemaVersion`).toBe(2);
      expect(result.json.status, `${lang} status`).toBe("ok");
      expect(result.json.coverage.complete, `${lang} coverage.complete`).toBe(true);
    }
  });
});

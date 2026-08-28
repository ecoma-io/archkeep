// The unreadable-source contract, pinned end to end for every language
// fixture that has no bespoke pin of its own.
//
// A file git tracks but the disk cannot answer — a dangling symlink, a failed
// checkout — must fail the whole run loudly. The funnel is language-independent
// (`analyzeWorkspace` records a whole-file failure for every `readFile` that
// answers null, and the provider graph refuses on it), but each language
// fixture drives a different read subsystem on the way — Go's module map, the
// JVM package index, the dotnet namespace index, the TypeScript resolver host —
// so the pin iterates every fixture instead of trusting one language's green
// to speak for the rest. Measured exit matrix, identical for every language
// here: `check` 3 · `graph` 3 · `diff` 3, with `coverage.notAnalyzed` naming
// exactly the broken file.
//
// `dotnet.e2e.mjs` and `jvm-mixed.e2e.mjs` keep their own bespoke pins: they
// assert more than this contract (the index/analyzer funnel reporting the file
// exactly once). Their fixtures are deliberately absent from the roster below,
// not forgotten.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { packArtifact } from "../helpers/artifact.mjs";
import {
  createNativeLanguageConsumer,
  fixtureFiles,
  LANGUAGE_FIXTURES,
} from "../helpers/consumer.mjs";
import { archkeep } from "../helpers/run.mjs";

let artifact;
beforeAll(() => {
  artifact = packArtifact();
});

afterAll(() => {
  artifact?.cleanup();
});

// Language → the extension of that fixture's source the pin breaks. The
// gradle fixture's sources are Kotlin, so its declared edges ride on `.kt`
// files — breaking one also proves the manifest track's tree refuses with
// them. Picked as the fixture map's FIRST match so a fixture that moves its
// sources keeps the pin green; a fixture that someday holds no source of its
// own language fails loudly below instead of skipping.
const ROSTER = {
  go: ".go",
  typescript: ".ts",
  // The JavaScript fixture's sources are `.mjs`/`.cjs` — the ESM/CJS
  // spellings of the one TypeScript-analyzer language the registry maps
  // both extensions to.
  javascript: ".mjs",
  vue: ".vue",
  rust: ".rs",
  python: ".py",
  java: ".java",
  kotlin: ".kt",
  gradle: ".kt",
};

describe.each(Object.entries(ROSTER))("unreadable source — %s fixture", (language, extension) => {
  it(`refuses check, graph, and diff when a tracked ${language} source is unreadable`, () => {
    const broken = createNativeLanguageConsumer(artifact, language);
    try {
      // Picked under `libs/` — every fixture keeps its sources there, while
      // the boundary config at the root can share the extension (`index.mjs`
      // sources beside `module-boundaries.config.mjs`) and breaking the LAW
      // is a config-load refusal, a different door than the funnel this pin
      // exists for.
      const relative = Object.keys(fixtureFiles(artifact, LANGUAGE_FIXTURES[language])).find(
        (path) => path.startsWith("libs/") && path.endsWith(extension),
      );
      expect(
        relative,
        `the ${language} fixture holds no ${extension} source — nothing to break`,
      ).toBeDefined();

      const baseline = join(broken.root, "baseline.json");
      const clean = archkeep(broken.root, ["graph", "--format", "json", "--output", baseline]);
      expect(clean.exitCode).toBe(0);

      // A dangling symlink is tracked by git but unreadable on disk — the
      // same silent direction the dotnet and JVM-mixed suites pin for their
      // indexes, now proven for this fixture's read path too.
      rmSync(join(broken.root, relative));
      symlinkSync("definitely-missing", join(broken.root, relative));

      const checked = archkeep(broken.root, ["check", "--format", "json"]);
      expect(checked.exitCode).toBe(3);
      expect(checked.json.coverage.complete).toBe(false);
      expect(checked.json.coverage.notAnalyzed.map((row) => row.file)).toEqual([relative]);

      const graph = archkeep(broken.root, ["graph", "--format", "json"]);
      expect(graph.exitCode, "graph refuses an unreadable source").toBe(3);

      const refused = archkeep(broken.root, ["diff", baseline, "--format", "json"]);
      expect(refused.exitCode, "diff refuses an unreadable head source").toBe(3);
      expect(refused.stderr).toContain("could not be analyzed");
    } finally {
      broken.cleanup();
    }
  });
});

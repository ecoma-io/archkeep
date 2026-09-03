// E2E scenarios for the .NET/C# language fixture.
//
// Proves the two-track edge principle of ADR 0006 through the real
// installed CLI: a `<ProjectReference>` (manifest track) and a written
// `using` (source track) witness the same boundary edge and the graph
// carries it once; a declared-only reference draws its edge with no source
// behind it; a solution file and a csproj rename move nothing. Plus the
// could-not-complete contract for an unreadable `.cs` — one row per file,
// not one per subsystem that noticed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { rmSync, symlinkSync } from "node:fs";

import { packArtifact } from "../helpers/artifact.mjs";
import {
  createNativeLanguageConsumer,
  commitFiles,
  applyFiles,
  fixtureFiles,
} from "../helpers/consumer.mjs";
import { archkeep } from "../helpers/run.mjs";
import { assertDelta } from "../helpers/canonical.mjs";
import { DOTNET_VIOLATION, DOTNET_DECLARED_CYCLE } from "../fixtures/languages/violations.mjs";
import {
  dotnetLanguageFiles,
  SLN_EDIT_MUTATION,
  withRenamedApplicationCsproj,
} from "../fixtures/languages/dotnet.mjs";

let artifact;
let consumer;
let baseFiles;

beforeAll(() => {
  artifact = packArtifact();
  consumer = createNativeLanguageConsumer(artifact, "dotnet");
  baseFiles = fixtureFiles(artifact, dotnetLanguageFiles);
});

afterAll(() => {
  consumer?.cleanup();
  artifact?.cleanup();
});

describe(".NET language E2E", () => {
  it("carries a dual-track edge once and a declared-only edge without any using", () => {
    const result = archkeep(consumer.root, ["graph", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();

    const names = result.json.result.projects.map((p) => p.name).sort();
    expect(names).toEqual(["api", "application", "domain"]);

    const edges = result.json.result.dependencies;
    // Two records, not three: application→domain is witnessed by both
    // tracks (a written `using` in App.cs and a ProjectReference in
    // Application.csproj) and dedupes to ONE static record, while
    // api→application exists through the manifest track alone — no written
    // `using` anywhere in Api.cs.
    expect(edges.map((e) => `${e.source}->${e.target}`).sort()).toEqual([
      "api->application",
      "application->domain",
    ]);
    expect(edges.every((e) => e.type === "static")).toBe(true);
  });

  it("passes check on the clean dual-track tree", () => {
    const result = archkeep(consumer.root, ["check"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/[1-9]\d* import/);
    expect(result.stdout).toMatch(/[1-9]\d* file/);
    expect(result.stdout).toMatch(/[1-9]\d* project/);
  });

  it("fails a using that reaches up a layer", () => {
    const violator = createNativeLanguageConsumer(artifact, "dotnet");
    try {
      commitFiles(violator.root, DOTNET_VIOLATION, "domain reaches up through a C# using");
      const result = archkeep(violator.root, ["check"]);
      expect(result.exitCode).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("onlyTagsConstraintViolation");
      expect(output).toMatch(/Reach\.cs:\d+:\d+/);
    } finally {
      violator.cleanup();
    }
  });

  it("moves nothing when a solution file is added", () => {
    // ADR 0006 rejected solution-centric discovery: a `.sln` is a build-
    // orchestration view carrying no boundary law, so listing all three
    // projects in one must not add a project, an edge, or a coverage
    // question. The exact empty delta states that twice over.
    const baseline = join(consumer.root, "baseline-sln.json");
    const before = archkeep(consumer.root, ["graph", "--format", "json", "--output", baseline]);
    expect(before.exitCode).toBe(0);

    commitFiles(consumer.root, SLN_EDIT_MUTATION, "add the solution file");
    try {
      const diff = archkeep(consumer.root, ["diff", baseline, "--format", "json"]);
      expect(diff.exitCode).toBe(0);
      assertDelta(diff.json.result, {});
    } finally {
      rmSync(join(consumer.root, "Ecoma.sln"), { force: true });
      commitFiles(consumer.root, {}, "remove the solution file");
    }
  });

  it("moves nothing when a csproj is renamed", () => {
    // The identity anchor is the project ROOT — "csproj filenames are
    // arbitrary" (ADR 0006, Decision 2). Renaming Application.csproj and
    // updating the reference that lands on it must leave the graph
    // byte-identical: an empty delta, not a project churn.
    const baseline = join(consumer.root, "baseline-rename.json");
    const before = archkeep(consumer.root, ["graph", "--format", "json", "--output", baseline]);
    expect(before.exitCode).toBe(0);

    applyFiles(
      consumer.root,
      baseFiles,
      withRenamedApplicationCsproj(baseFiles),
      "rename Application.csproj",
    );
    try {
      const diff = archkeep(consumer.root, ["diff", baseline, "--format", "json"]);
      expect(diff.exitCode).toBe(0);
      assertDelta(diff.json.result, {});
    } finally {
      applyFiles(
        consumer.root,
        withRenamedApplicationCsproj(baseFiles),
        baseFiles,
        "revert rename",
      );
    }
  });

  it("refuses check, graph, and diff when a tracked C# source is unreadable", () => {
    // The dotnet twin of the funnel dedupe: an unreadable `.cs` is heard by
    // BOTH the namespace index and the analyzer's own read, and the report
    // must name the file ONCE — not once per subsystem that noticed.
    const broken = createNativeLanguageConsumer(artifact, "dotnet");
    try {
      const baseline = join(broken.root, "baseline.json");
      const clean = archkeep(broken.root, ["graph", "--format", "json", "--output", baseline]);
      expect(clean.exitCode).toBe(0);

      // A dangling symlink is tracked by git but unreadable on disk — the
      // same silent direction the JVM suite pins for its own index.
      const name = join(broken.root, "libs", "domain", "Name.cs");
      rmSync(name);
      symlinkSync("definitely-missing.cs", name);

      const checked = archkeep(broken.root, ["check", "--format", "json"]);
      expect(checked.exitCode).toBe(3);
      expect(checked.json.coverage.complete).toBe(false);
      expect(checked.json.coverage.notAnalyzed.map((row) => row.file)).toEqual([
        "libs/domain/Name.cs",
      ]);

      const graph = archkeep(broken.root, ["graph", "--format", "json"]);
      expect(graph.exitCode, "graph refuses an unreadable C# source").toBe(3);

      const refused = archkeep(broken.root, ["diff", baseline, "--format", "json"]);
      expect(refused.exitCode, "diff refuses an unreadable head source").toBe(3);
      // #608 moved the refusal in-band — the envelope on stdout names the
      // unreadable file; a stdout run keeps stderr silent.
      expect(refused.json.status).toBe("no-verdict");
      expect(refused.json.coverage.notAnalyzed.map((row) => row.file)).toEqual([
        "libs/domain/Name.cs",
      ]);
      expect(refused.json.coverage.notAnalyzed[0].reason).toContain("could not be read");
      expect(refused.json.result).toBeUndefined();
    } finally {
      broken.cleanup();
    }
  });

  it("refuses a cycle that closes through a declared edge alone", () => {
    // The silent-direction killer for the manifest track: an upward
    // ProjectReference in Domain.csproj closes domain→application→domain
    // with NO `using` written anywhere, so the import track sees two
    // unrelated trees and no tag rule has a position to blame. The cycle
    // lives in `graph.dependencies` — where the declared edges are folded
    // on every face — so `noCircularDependencies` must fire; an exit 0 here
    // would be the clean answer on a workspace whose check must refuse.
    const cyclic = createNativeLanguageConsumer(artifact, "dotnet");
    try {
      commitFiles(cyclic.root, DOTNET_DECLARED_CYCLE, "domain references up a layer");
      const result = archkeep(cyclic.root, ["check"]);
      expect(result.exitCode).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("noCircularDependencies");
      expect(output).not.toContain("onlyTagsConstraintViolation");
    } finally {
      cyclic.cleanup();
    }
  });
});

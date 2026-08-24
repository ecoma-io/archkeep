// E2E scenarios for Architecture Intent, driven through the installed CLI.
//
// The unit and integration suites already pin the judge and the `check`
// wiring in-process. What they cannot prove is the one sentence the user of
// the packaged tool actually relies on: a workspace that commits an
// `architecture-intent.json` and then a dependency the intent forbids turns a
// previously-green run red — through the real `pnpm pack` tarball, installed
// into a tree this repository never built. That is the consumer's first hour,
// so this drives it end to end.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import { createNativeLanguageConsumer, commitFiles } from "./helpers/consumer.mjs";
import { archkeep } from "./helpers/run.mjs";
import { intentConsumerFiles } from "./fixtures/intent-consumer.mjs";

let artifact;
let clean;
let violator;

/**
 * A native consumer built from the intent fixture, whose `architecture-intent.json`
 * is committed BEFORE install — so `git ls-files` sees it, exactly as it must
 * in a real workspace.
 */
const makeIntentConsumer = () => createNativeLanguageConsumer(artifact, intentConsumerFiles);

// `core` reaches `app` through a Go import — the observed graph carries the
// forbidden edge, so intent must turn the run red.
const CORE_REACHES_APP = {
  "libs/core/go.mod":
    "module example.test/core\n\ngo 1.22\n\nrequire example.test/app v0.0.0\n\n" +
    "replace example.test/app => ../app\n",
  "libs/core/violate.go": 'package core\n\nimport "example.test/app"\n\nvar _ = app.Thing\n',
  "libs/app/app.go": 'package app\n\nconst Thing = "app"\n',
};

beforeAll(() => {
  artifact = packArtifact();
  clean = makeIntentConsumer();
  violator = makeIntentConsumer();
});

afterAll(() => {
  clean?.cleanup();
  violator?.cleanup();
  artifact?.cleanup();
});

describe("architecture intent through the installed CLI", () => {
  it("exits 0 on a native tree whose intent agrees with the observed graph", () => {
    const result = archkeep(clean.root, ["check", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.status).toBe("ok");
    expect(result.json.result.intent).toMatchObject({
      checked: true,
      file: "architecture-intent.json",
      verdict: "ok",
      findings: [],
      unresolved: [],
    });
  });

  it("names the governing boundaries in the envelope — the intent that was judged", () => {
    const result = archkeep(clean.root, ["check", "--format", "json"]);
    const boundaries = result.json.result.intent.boundaries;
    expect(boundaries).toEqual([
      { name: "core", projects: ["core"] },
      { name: "app", projects: ["app"] },
    ]);
  });

  it("turns a previously-clean run red when a forbidden edge appears in the graph", () => {
    commitFiles(violator.root, CORE_REACHES_APP, "core reaches up into app");
    const result = archkeep(violator.root, ["check", "--format", "json"]);
    expect(result.exitCode).toBe(1);
    expect(result.json.status).toBe("findings");
    expect(result.json.result.intent.verdict).toBe("findings");
    const forbidden = result.json.result.intent.findings.filter(
      (f) => f.rule === "intentForbiddenEdge",
    );
    expect(forbidden.length).toBeGreaterThan(0);
    expect(forbidden[0]).toMatchObject({
      source: "core",
      target: "app",
      boundaryFrom: "core",
      boundaryTo: "app",
    });
  });

  it("reports the intent verdict in the text report too, naming the violation", () => {
    const result = archkeep(violator.root, ["check"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("intentForbiddenEdge");
    expect(result.stdout).toContain("architecture-intent");
  });
});

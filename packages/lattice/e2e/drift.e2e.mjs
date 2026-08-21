// E2E scenarios for the `drift` command and `check`'s drift fold, through the
// installed CLI.
//
// `drift` is descriptive — it never exits 1, exactly like `graph`/`diff`. It
// compares the observed project graph (three Go projects, `app → api → core`)
// against a canonical `architecture-intent.json` at the consumer root — the one
// contract an installed Lattice reads (`src/architecture-intent/model.mjs`);
// there is no parallel intent grammar. `check` folds drift in by presence: when
// a workspace has an intent file at the canonical name, `check` counts drift
// findings into its verdict (exit 1 on findings, 3 on a malformed intent).
// These scenarios prove that contract through the real packed artifact over a
// real consumer tree that this repository never built.
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { packArtifact } from "./helpers/artifact.mjs";
import { createNativeLanguageConsumer } from "./helpers/consumer.mjs";
import { lattice } from "./helpers/run.mjs";
import { driftConsumerFiles } from "./fixtures/drift-consumer.mjs";

/** A native consumer whose canonical intent is committed before install. */
const makeDriftConsumer = (artifact, intent) =>
  createNativeLanguageConsumer(artifact, (packageName, peers, packageManager) =>
    driftConsumerFiles(packageName, peers, packageManager, intent),
  );

/** The native monorepo: three Go projects, chain `app → api → core`. */
const MATCHING_INTENT = {
  version: "1",
  boundaries: [
    { name: "core", match: ["name:core"] },
    { name: "api", match: ["name:api"] },
    { name: "app", match: ["name:app"] },
  ],
  // The one relationship that really holds: `app` reaches `api` reaches `core`.
  allowed: [
    { from: "app", to: "api" },
    { from: "api", to: "core" },
  ],
  // The reverse never happens in the monorepo fixture.
  forbidden: [{ from: "core", to: "app", reason: "core must never reach the top" }],
};

/** An intent whose forbidden dependency `app → api` the observed graph has. */
const FORBIDDEN_EDGE_INTENT = {
  version: "1",
  boundaries: [
    { name: "core", match: ["name:core"] },
    { name: "api", match: ["name:api"] },
    { name: "app", match: ["name:app"] },
  ],
  dependencies: {
    forbidden: [{ source: "app", target: "api" }],
  },
};

/** An intent requiring a project the monorepo does not have. */
const MISSING_PROJECT_INTENT = {
  version: "1",
  boundaries: [{ name: "core", match: ["name:core"] }],
  projects: {
    required: [{ name: "never-exists", tags: [] }],
  },
};

/** Strict JSON but no `version` and no `boundaries` — a load error. */
const MALFORMED_INTENT = { dependencies: { allowed: [] } };

let artifact;
let matching;
let forbidden;
let missing;
let malformed;

beforeAll(() => {
  artifact = packArtifact();
  matching = makeDriftConsumer(artifact, MATCHING_INTENT);
  forbidden = makeDriftConsumer(artifact, FORBIDDEN_EDGE_INTENT);
  missing = makeDriftConsumer(artifact, MISSING_PROJECT_INTENT);
  malformed = makeDriftConsumer(artifact, MALFORMED_INTENT);
});

afterAll(() => {
  matching?.cleanup();
  forbidden?.cleanup();
  missing?.cleanup();
  malformed?.cleanup();
  artifact?.cleanup();
});

describe("drift", () => {
  it("exits 0 on a matching tree and states the intent fingerprint and row count", () => {
    const result = lattice(matching.root, ["drift"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/intent\s+[0-9a-f]{64}/);
    expect(result.stdout).toMatch(/[1-9]\d* rows?/);
    expect(result.stdout).toContain(
      "✔ no drift — the observed architecture matches the intended one",
    );
  });

  it("reports a forbidden edge as dependencyForbidden, naming the pair", () => {
    const result = lattice(forbidden.root, ["drift"]);
    expect(result.exitCode).toBe(0); // descriptive — never 1
    expect(result.stdout).toContain("dependencies the intent forbids exist");
    expect(result.stdout).toContain("app → api");
  });

  it("produces a valid JSON envelope with drift findings", () => {
    const result = lattice(forbidden.root, ["drift", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("drift");
    expect(result.json.status).toBe("ok");
    expect(result.json.result.intent.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const forbiddenFindings = result.json.result.findings.filter(
      (f) => f.rule === "dependencyForbidden",
    );
    expect(forbiddenFindings.length).toBe(1);
    expect(forbiddenFindings[0]).toMatchObject({ source: "app", target: "api" });
  });

  it("reports a missing required project as projectMissing, and check exits 1 on it", () => {
    const driftResult = lattice(missing.root, ["drift"]);
    expect(driftResult.exitCode).toBe(0);
    expect(driftResult.stdout).toContain("projects the intent requires are missing");
    expect(driftResult.stdout).toContain("never-exists");

    // The same finding makes `check` fail — drift folds into the verdict by
    // presence, and a drift finding is a finding.
    const checkResult = lattice(missing.root, ["check"]);
    expect(checkResult.exitCode).toBe(1);
    const output = `${checkResult.stdout}${checkResult.stderr}`;
    expect(output).toContain("projectMissing");
  });

  it("exits 3 on a malformed intent, and check does too", () => {
    const driftResult = lattice(malformed.root, ["drift"]);
    expect(driftResult.exitCode).toBe(3);
    expect(driftResult.stderr).toMatch(/intent/);

    const checkResult = lattice(malformed.root, ["check"]);
    expect(checkResult.exitCode).toBe(3);
  });
});

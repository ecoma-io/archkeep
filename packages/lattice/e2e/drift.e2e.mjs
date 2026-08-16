// E2E scenarios for the `drift` command and `check`'s drift fold.
//
// `drift` is descriptive — it never exits 1, exactly like `graph`/`diff`.
// `check` folds drift in by presence: when a workspace has an intent file at
// the `intentConfig` name, `check` counts drift findings into its verdict
// (exit 1 on findings, 3 on a malformed intent). These scenarios prove that
// contract through the real installed CLI over real consumer trees.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import {
  createDriftConsumer,
  createNativeConsumer,
  createNativeLanguageConsumer,
  commitFiles,
} from "./helpers/consumer.mjs";
import { lattice } from "./helpers/run.mjs";

/** Writes the intent module into a consumer and commits it — plus a coverage
 * waiver for it, because the language fixtures' `lattice.json` was built
 * before the intent existed and only the native provider's `coverage.exempt`
 * list is how a root `.mjs` config avoids counting as an unclaimed file.
 * Same reasoning as `src/drift/../e2e/fixtures/drift-consumer.mjs`. */
const declareIntent = (consumer, intent) => {
  writeFileSync(
    join(consumer, "architecture-intent.config.mjs"),
    `export default ${JSON.stringify(intent, null, 2)}\n`,
    "utf8",
  );
  const latticePath = join(consumer, "lattice.json");
  const latticeJson = JSON.parse(readFileSync(latticePath, "utf8"));
  latticeJson.coverage ??= {};
  latticeJson.coverage.exempt ??= [];
  if (!latticeJson.coverage.exempt.some((e) => e.path === "architecture-intent.config.mjs")) {
    latticeJson.coverage.exempt.push({
      path: "architecture-intent.config.mjs",
      reason: "workspace tooling config at the root, not itself a project",
    });
  }
  writeFileSync(latticePath, `${JSON.stringify(latticeJson, null, 2)}\n`, "utf8");
  commitFiles(consumer, {}, "declare the intent");
};

// The monorepo's observed edges: `app → api` and `api → core`.
const MATCHING_INTENT = {
  projects: {
    required: [
      { name: "core", tags: ["layer:core"] },
      { name: "api", tags: ["layer:api"] },
      { name: "app", tags: ["layer:app"] },
    ],
  },
  dependencies: {
    forbidden: [{ source: "core", target: "app" }],
  },
};

const FORBIDDEN_EDGE_INTENT = {
  projects: {
    required: [{ name: "core", tags: ["layer:core"] }],
  },
  dependencies: {
    forbidden: [{ source: "app", target: "api" }],
  },
};

const MISSING_PROJECT_INTENT = {
  projects: {
    required: [
      { name: "core", tags: ["layer:core"] },
      { name: "never-exists", tags: [] },
    ],
  },
};

const MALFORMED_INTENT = { dependencies: { allowed: [] } };

let artifact;

beforeAll(() => {
  artifact = packArtifact();
});

afterAll(() => {
  artifact?.cleanup();
});

describe("drift (smoke)", () => {
  it("exits 0 on a matching tree and states the intent fingerprint and row count", () => {
    const consumer = createDriftConsumer(artifact, MATCHING_INTENT);
    try {
      const result = lattice(consumer.root, ["drift"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/intent\s+[0-9a-f]{64}/);
      expect(result.stdout).toMatch(/[1-9]\d* row/);
      expect(result.stdout).toContain(
        "✔ no drift — the observed architecture matches the intended one",
      );
    } finally {
      consumer.cleanup();
    }
  });
});

describe("drift (full)", () => {
  it("reports a forbidden edge as dependencyForbidden, naming the row", () => {
    const consumer = createDriftConsumer(artifact, FORBIDDEN_EDGE_INTENT);
    try {
      const result = lattice(consumer.root, ["drift"]);
      expect(result.exitCode).toBe(0); // descriptive — never 1
      // The descriptive `drift` command renders findings under the human
      // heading and the row — the machine `messageId` (`dependencyForbidden`)
      // is what `check` and the JSON envelope label them.
      expect(result.stdout).toContain("dependencies the intent forbids exist");
      expect(result.stdout).toContain("app → api");
    } finally {
      consumer.cleanup();
    }
  });

  it("produces a valid JSON envelope with drift findings", () => {
    const consumer = createDriftConsumer(artifact, FORBIDDEN_EDGE_INTENT);
    try {
      const result = lattice(consumer.root, ["drift", "--format", "json"]);
      expect(result.exitCode).toBe(0);
      expect(result.json).not.toBeNull();
      expect(result.json.command).toBe("drift");
      expect(result.json.status).toBe("ok");
      expect(result.json.result.intent.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      const forbidden = result.json.result.findings.filter(
        (f) => f.messageId === "dependencyForbidden",
      );
      expect(forbidden.length).toBe(1);
      expect(forbidden[0]).toMatchObject({ source: "app", target: "api" });
    } finally {
      consumer.cleanup();
    }
  });

  it("reports a missing required project as projectMissing, and check exits 1 on it", () => {
    const consumer = createDriftConsumer(artifact, MISSING_PROJECT_INTENT);
    try {
      const driftResult = lattice(consumer.root, ["drift"]);
      expect(driftResult.exitCode).toBe(0);
      expect(driftResult.stdout).toContain("projects the intent requires are missing");
      expect(driftResult.stdout).toContain("never-exists");

      // The same finding makes `check` fail — drift folds into the verdict by
      // presence, and a drift finding is a finding.
      const checkResult = lattice(consumer.root, ["check"]);
      expect(checkResult.exitCode).toBe(1);
      const output = `${checkResult.stdout}${checkResult.stderr}`;
      expect(output).toContain("projectMissing");
    } finally {
      consumer.cleanup();
    }
  });

  it("exits 3 on a malformed intent, and check does too", () => {
    const consumer = createDriftConsumer(artifact, MALFORMED_INTENT);
    try {
      const driftResult = lattice(consumer.root, ["drift"]);
      expect(driftResult.exitCode).toBe(3);
      expect(driftResult.stderr).toMatch(/intent/);

      const checkResult = lattice(consumer.root, ["check"]);
      expect(checkResult.exitCode).toBe(3);
    } finally {
      consumer.cleanup();
    }
  });

  it("leaves check unchanged — and drift silent — when no intent file exists", () => {
    // A workspace without an intended architecture pays nothing and hears
    // nothing: no `--drift` flag, no mention, byte-identical `check`.
    const consumer = createNativeConsumer(artifact);
    try {
      const result = lattice(consumer.root, ["check"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("drift");
      expect(result.stdout).not.toMatch(/intent\s+[0-9a-f]/);
    } finally {
      consumer.cleanup();
    }
  });
});

describe("drift across the language fixtures", () => {
  // Every language fixture draws the same edges: `application → domain` and
  // `api → application`. A matching intent must stay silent, and a forbidden
  // edge must surface as drift — proving provider-independent verdicts per
  // language through the real CLI.
  const LANGUAGES = ["go", "typescript", "javascript", "vue", "rust", "python"];
  const MATCHING = {
    projects: {
      required: [
        { name: "domain", tags: ["layer:domain"] },
        { name: "application", tags: ["layer:application"] },
        { name: "api", tags: ["layer:api"] },
      ],
    },
  };
  const FORBIDDEN = {
    projects: { required: [{ name: "domain", tags: ["layer:domain"] }] },
    dependencies: { forbidden: [{ source: "application", target: "domain" }] },
  };

  for (const language of LANGUAGES) {
    it(`is silent on a matching ${language} tree and reports a forbidden edge`, () => {
      const matching = createNativeLanguageConsumer(artifact, language);
      try {
        declareIntent(matching.root, MATCHING);
        const clean = lattice(matching.root, ["drift"]);
        expect(clean.exitCode).toBe(0);
        expect(clean.stdout).toContain("✔ no drift");
      } finally {
        matching.cleanup();
      }

      const violating = createNativeLanguageConsumer(artifact, language);
      try {
        declareIntent(violating.root, FORBIDDEN);
        const dirty = lattice(violating.root, ["drift"]);
        expect(dirty.exitCode).toBe(0);
        expect(dirty.stdout).toContain("dependencies the intent forbids exist");
        expect(dirty.stdout).toContain("application → domain");
      } finally {
        violating.cleanup();
      }
    });
  }
});

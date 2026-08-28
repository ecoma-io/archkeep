import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  rulesAddCommand,
  rulesInfoCommand,
  rulesListCommand,
  rulesVerifyCommand,
} from "./rules.mjs";

let tempCatalogDir;
let catalogPath;
let realRulesDir;

beforeAll(() => {
  // Use the actual catalog and artifacts from the rules package for realistic testing
  const rulesPackageRoot = fileURLToPath(new URL("../../../archkeep-rules", import.meta.url));

  tempCatalogDir = mkdtempSync(join(tmpdir(), "archkeep-rules-test-"));
  catalogPath = join(tempCatalogDir, "catalog.json");

  // Copy the real catalog.json
  const realCatalogPath = join(rulesPackageRoot, "catalog.json");
  writeFileSync(catalogPath, readFileSync(realCatalogPath));

  // Copy the rules directory with artifacts
  realRulesDir = join(rulesPackageRoot, "rules");
  const testRulesDir = join(tempCatalogDir, "rules");
  mkdirSync(testRulesDir, { recursive: true });

  // Copy all .wasm files from the real rules directory
  const wasmFiles = require("node:fs")
    .readdirSync(realRulesDir)
    .filter((f) => f.endsWith(".wasm"));
  for (const wasmFile of wasmFiles) {
    writeFileSync(join(testRulesDir, wasmFile), readFileSync(join(realRulesDir, wasmFile)));
  }
});

afterAll(() => {
  // Clean up the temporary directory
  if (tempCatalogDir) {
    rmSync(tempCatalogDir, { recursive: true, force: true });
  }
});

describe("rulesListCommand", () => {
  it("renders JSON when format is json", async () => {
    const result = await rulesListCommand({ catalog: catalogPath }, { cwd: tempCatalogDir });

    expect(result.status).toBe("ok");
    const json = JSON.parse(result.report.json);
    expect(json.command).toBe("rules list");
  });
});

describe("rulesInfoCommand", () => {
  it("renders JSON when format is json", async () => {
    const result = await rulesInfoCommand(
      { catalog: catalogPath },
      { cwd: tempCatalogDir, ruleName: "tag-cardinality" },
    );

    expect(result.status).toBe("ok");
    const json = JSON.parse(result.report.json);
    expect(json.command).toBe("rules info");
  });
});

describe("rulesVerifyCommand", () => {
  it("refuses explicit --catalog pointing at missing file with catalog-not-found message", async () => {
    const missingPath = join(tempCatalogDir, "nonexistent-catalog.json");

    await expect(
      rulesVerifyCommand({ catalog: missingPath }, { cwd: tempCatalogDir }),
    ).rejects.toThrow(`catalog not found at ${missingPath}`);
  });

  it("reports rule by name and observable failure when wasm has corrupted byte vs recorded sha256", async () => {
    const corruptedCatalogDir = mkdtempSync(join(tmpdir(), "archkeep-corrupted-"));
    const corruptedCatalogPath = join(corruptedCatalogDir, "catalog.json");

    // Copy catalog and rules
    writeFileSync(corruptedCatalogPath, readFileSync(catalogPath));
    const corruptedRulesDir = join(corruptedCatalogDir, "rules");
    mkdirSync(corruptedRulesDir, { recursive: true });

    // Copy and corrupt one wasm file
    const wasmFiles = require("node:fs")
      .readdirSync(join(tempCatalogDir, "rules"))
      .filter((f) => f.endsWith(".wasm"));
    const firstWasm = wasmFiles[0];
    const originalWasm = readFileSync(join(tempCatalogDir, "rules", firstWasm));
    const corruptedWasm = Buffer.from(originalWasm);
    corruptedWasm[0] = corruptedWasm[0] ^ 0xff; // Flip one byte

    for (const wasmFile of wasmFiles) {
      if (wasmFile === firstWasm) {
        writeFileSync(join(corruptedRulesDir, wasmFile), corruptedWasm);
      } else {
        writeFileSync(
          join(corruptedRulesDir, wasmFile),
          readFileSync(join(tempCatalogDir, "rules", wasmFile)),
        );
      }
    }

    const result = await rulesVerifyCommand(
      { catalog: corruptedCatalogPath },
      { cwd: corruptedCatalogDir },
    );

    // A digest mismatch is a completed verification with a negative result —
    // the `findings` status and exit 1, the same class as a boundary
    // violation. It must never read as `no-verdict` (exit 3), the class for a
    // run that could not look: "this artifact was tampered with" and "the
    // catalog could not be read" are different facts for every script that
    // branches on the exit code.
    expect(result.status).toBe("findings");
    expect(JSON.parse(result.report.json).exitCode).toBe(1);
    expect(result.report.text).toContain("FAILED");

    // Find which rule has the corrupted wasm
    const catalog = JSON.parse(readFileSync(corruptedCatalogPath, "utf8"));
    const corruptedRule = catalog.rules.find((r) => r.artifact.endsWith(firstWasm));

    expect(result.report.text).toContain(corruptedRule.name);
    expect(result.report.text).toContain("Digest mismatch");

    // Clean up
    rmSync(corruptedCatalogDir, { recursive: true, force: true });
  });

  it("reports artifact-not-found failure when catalog names missing artifact", async () => {
    const missingArtifactDir = mkdtempSync(join(tmpdir(), "archkeep-missing-artifact-"));
    const missingArtifactCatalogPath = join(missingArtifactDir, "catalog.json");

    // Create catalog with a rule pointing to a non-existent artifact
    const catalogContent = {
      version: 1,
      rules: [
        {
          name: "missing-artifact-rule",
          description: "A rule whose artifact is missing",
          contract: 1,
          needs: ["model"],
          params: {},
          artifact: "rules/missing.wasm",
          sha256: "abc123",
        },
      ],
    };
    writeFileSync(missingArtifactCatalogPath, JSON.stringify(catalogContent));

    const result = await rulesVerifyCommand(
      { catalog: missingArtifactCatalogPath },
      { cwd: missingArtifactDir },
    );

    // A named artifact that is not there is a negative answer the run reached
    // by looking — the catalog read fine, the entry claims bytes that do not
    // exist. That is a `findings` run (exit 1), not a `no-verdict` one (exit
    // 3): the catalog itself being unreadable is the could-not-look case.
    expect(result.status).toBe("findings");
    expect(JSON.parse(result.report.json).exitCode).toBe(1);
    expect(result.report.text).toContain("FAILED");
    expect(result.report.text).toContain("missing-artifact-rule");
    expect(result.report.text).toContain("Artifact not found: rules/missing.wasm");

    // Clean up
    rmSync(missingArtifactDir, { recursive: true, force: true });
  });

  it("passes clean with valid tmpdir catalog", async () => {
    const result = await rulesVerifyCommand({ catalog: catalogPath }, { cwd: tempCatalogDir });

    expect(result.status).toBe("ok");
    expect(JSON.parse(result.report.json).exitCode).toBe(0);
    expect(result.report.text).toContain("OK");
    expect(result.report.text).not.toContain("FAILED");
  });

  it("refuses a catalog artifact that escapes the catalog directory, naming the entry", async () => {
    const base = mkdtempSync(join(tmpdir(), "archkeep-escape-read-"));
    const catalogDir = join(base, "vendored", "catalog");
    mkdirSync(catalogDir, { recursive: true });

    // The outside file EXISTS and the catalog carries its real digest — a run
    // that followed the escape would have no digest complaint. The refusal has
    // to be the escape itself, so this proves the bytes were never read, not
    // merely that they failed some later check.
    const outsideBytes = Buffer.from("bytes the catalog must not reach");
    writeFileSync(join(base, "outside-secrets.wasm"), outsideBytes);
    const outsideDigest = createHash("sha256").update(outsideBytes).digest("hex");

    const catalog = {
      version: 1,
      rules: [
        {
          name: "escape-artist",
          description: "rule whose artifact field escapes the catalog directory",
          contract: 1,
          needs: [],
          params: {},
          artifact: "../../outside-secrets.wasm",
          sha256: outsideDigest,
        },
      ],
    };
    writeFileSync(join(catalogDir, "catalog.json"), JSON.stringify(catalog));

    const result = await rulesVerifyCommand(
      { catalog: join(catalogDir, "catalog.json") },
      { cwd: base },
    );

    expect(result.status).toBe("findings");
    expect(JSON.parse(result.report.json).exitCode).toBe(1);
    expect(result.report.text).toContain("escape-artist");
    expect(result.report.text).toContain("outside");

    rmSync(base, { recursive: true, force: true });
  });

  it("renders JSON when format is json", async () => {
    const result = await rulesVerifyCommand({ catalog: catalogPath }, { cwd: tempCatalogDir });

    expect(result.status).toBe("ok");
    const json = JSON.parse(result.report.json);
    expect(json.command).toBe("rules verify");
  });
});

describe("rulesAddCommand", () => {
  it("prints customRules row with real sha256 and copies wasm without modifying config file", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "archkeep-workspace-"));
    const workspaceCatalogPath = join(workspaceDir, "catalog.json");
    const boundaryConfigPath = join(workspaceDir, "module-boundaries.config.mjs");
    const localRulesDir = join(workspaceDir, "rules");

    // Copy catalog and rules
    writeFileSync(workspaceCatalogPath, readFileSync(catalogPath));
    mkdirSync(localRulesDir, { recursive: true });
    const wasmFiles = require("node:fs")
      .readdirSync(join(tempCatalogDir, "rules"))
      .filter((f) => f.endsWith(".wasm"));
    for (const wasmFile of wasmFiles) {
      writeFileSync(
        join(localRulesDir, wasmFile),
        readFileSync(join(tempCatalogDir, "rules", wasmFile)),
      );
    }

    // Create a minimal JSON boundary config
    const initialConfig = `export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: [],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

export const depConstraints = [];
`;
    writeFileSync(boundaryConfigPath, initialConfig);

    const beforeConfig = readFileSync(boundaryConfigPath, "utf8");

    const result = await rulesAddCommand(
      { catalog: workspaceCatalogPath, to: localRulesDir },
      { cwd: workspaceDir, ruleName: "tag-cardinality" },
    );

    expect(result.status).toBe("ok");

    const afterConfig = readFileSync(boundaryConfigPath, "utf8");

    // The config file should NOT be modified - the command only prints the row
    expect(afterConfig).toBe(beforeConfig);

    // But the printed text should contain the sha256 and fill-in reason marker
    const catalog = JSON.parse(readFileSync(workspaceCatalogPath, "utf8"));
    const tagCardinalityRule = catalog.rules.find((r) => r.name === "tag-cardinality");

    expect(result.report.text).toContain(tagCardinalityRule.sha256);
    expect(result.report.text).toContain("<fill this in>");

    // Verify the wasm file exists in localRulesDir
    expect(require("node:fs").existsSync(join(localRulesDir, "tag-cardinality.wasm"))).toBe(true);

    // Clean up
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("prints row with sha256 and fill-in reason marker for .mjs config and does not modify file", async () => {
    const mjsWorkspaceDir = mkdtempSync(join(tmpdir(), "archkeep-mjs-workspace-"));
    const mjsCatalogPath = join(mjsWorkspaceDir, "catalog.json");
    const mjsConfigPath = join(mjsWorkspaceDir, "module-boundaries.config.mjs");
    const localRulesDir = join(mjsWorkspaceDir, "rules");

    // Copy catalog and rules
    writeFileSync(mjsCatalogPath, readFileSync(catalogPath));
    mkdirSync(localRulesDir, { recursive: true });
    const wasmFiles = require("node:fs")
      .readdirSync(join(tempCatalogDir, "rules"))
      .filter((f) => f.endsWith(".wasm"));
    for (const wasmFile of wasmFiles) {
      writeFileSync(
        join(localRulesDir, wasmFile),
        readFileSync(join(tempCatalogDir, "rules", wasmFile)),
      );
    }

    // Create a minimal .mjs boundary config (same format - the distinction is in the dialect detection)
    const mjsConfig = `export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: [],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

export const depConstraints = [];
`;
    writeFileSync(mjsConfigPath, mjsConfig);

    const beforeConfig = readFileSync(mjsConfigPath, "utf8");

    const result = await rulesAddCommand(
      { catalog: mjsCatalogPath, to: localRulesDir },
      { cwd: mjsWorkspaceDir, ruleName: "tag-cardinality" },
    );

    expect(result.status).toBe("ok");

    const afterConfig = readFileSync(mjsConfigPath, "utf8");

    // For .mjs config, the file should NOT be modified
    expect(afterConfig).toBe(beforeConfig);

    // But the printed text should contain the sha256 and reason marker
    const catalog = JSON.parse(readFileSync(mjsCatalogPath, "utf8"));
    const tagCardinalityRule = catalog.rules.find((r) => r.name === "tag-cardinality");

    expect(result.report.text).toContain(tagCardinalityRule.sha256);
    expect(result.report.text).toContain("<fill this in>");

    // Clean up
    rmSync(mjsWorkspaceDir, { recursive: true, force: true });
  });

  it("renders JSON when format is json", async () => {
    const targetDir = join(tempCatalogDir, "rules");
    mkdirSync(targetDir, { recursive: true });

    const result = await rulesAddCommand(
      { catalog: catalogPath, to: targetDir },
      { cwd: tempCatalogDir, ruleName: "tag-cardinality" },
    );

    expect(result.status).toBe("ok");
    const json = JSON.parse(result.report.json);
    expect(json.command).toBe("rules add");
  });

  // A catalog a consumer downloaded, vendored, or had modified under it is
  // data, so neither of the two paths `add` derives from it may escape the
  // directory that anchors it: the `artifact` field (read side, resolved under
  // the catalog's directory) and the rule name (write side, resolved under
  // `--to`). Each test below has an in-tree sibling that must keep working, so
  // the guard cannot pass only by refusing everything.
  describe("containment", () => {
    /** Builds a catalog whose two rules' artifacts are real in-tree bytes. */
    function writeContainedCatalog(catalogDir) {
      const rulesDir = join(catalogDir, "rules");
      mkdirSync(rulesDir, { recursive: true });

      const inTreeBytes = Buffer.from("in-tree rule bytes");
      const escapeBytes = Buffer.from("escaping rule bytes");
      writeFileSync(join(rulesDir, "in-tree-rule.wasm"), inTreeBytes);
      writeFileSync(join(rulesDir, "escape-artist.wasm"), escapeBytes);

      const ruleShape = (name, artifact, bytes) => ({
        name,
        description: "catalog-derived name and artifact under containment",
        contract: 1,
        needs: [],
        params: {},
        artifact,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });

      const catalogPath = join(catalogDir, "catalog.json");
      writeFileSync(
        catalogPath,
        JSON.stringify({
          version: 1,
          rules: [
            ruleShape("in-tree-rule", "rules/in-tree-rule.wasm", inTreeBytes),
            // A catalog entry whose NAME escapes — the half the write side
            // resolves under `--to`.
            ruleShape("../escape-artist", "rules/escape-artist.wasm", escapeBytes),
          ],
        }),
      );
      return catalogPath;
    }

    it("refuses a rule whose artifact escapes the catalog directory and copies nothing", async () => {
      const base = mkdtempSync(join(tmpdir(), "archkeep-escape-add-read-"));
      const catalogDir = join(base, "vendored", "catalog");
      mkdirSync(catalogDir, { recursive: true });

      // The outside file exists with the digest the catalog records, so the
      // refusal must be the escape itself — the bytes were never read.
      const outsideBytes = Buffer.from("bytes the catalog must not reach");
      writeFileSync(join(base, "outside-secrets.wasm"), outsideBytes);
      const outsideDigest = createHash("sha256").update(outsideBytes).digest("hex");
      writeFileSync(
        join(catalogDir, "catalog.json"),
        JSON.stringify({
          version: 1,
          rules: [
            {
              name: "escape-artist",
              description: "rule whose artifact field escapes the catalog directory",
              contract: 1,
              needs: [],
              params: {},
              artifact: "../../outside-secrets.wasm",
              sha256: outsideDigest,
            },
          ],
        }),
      );

      const outputDir = join(base, "tools", "rules");
      const result = await rulesAddCommand(
        { catalog: join(catalogDir, "catalog.json"), to: outputDir },
        { cwd: base, ruleName: "escape-artist" },
      );

      expect(result.status).toBe("no-verdict");
      expect(JSON.parse(result.report.json).exitCode).toBe(3);
      expect(result.report.text).toContain("escape-artist");
      expect(result.report.text).toContain("outside");
      expect(existsSync(join(outputDir, "escape-artist.wasm"))).toBe(false);

      rmSync(base, { recursive: true, force: true });
    });

    it("refuses a rule whose name escapes the output directory and writes nothing outside it", async () => {
      const base = mkdtempSync(join(tmpdir(), "archkeep-escape-add-write-"));
      const catalogPath = writeContainedCatalog(join(base, "vendored", "catalog"));
      const outputDir = join(base, "tools", "rules");

      const result = await rulesAddCommand(
        { catalog: catalogPath, to: outputDir },
        { cwd: base, ruleName: "../escape-artist" },
      );

      expect(result.status).toBe("no-verdict");
      expect(JSON.parse(result.report.json).exitCode).toBe(3);
      expect(result.report.text).toContain("../escape-artist");
      expect(result.report.text).toContain("outside");
      // The write did not land where the unguarded resolve would have put it.
      expect(existsSync(join(base, "escape-artist.wasm"))).toBe(false);
      expect(existsSync(join(outputDir, "escape-artist.wasm"))).toBe(false);

      rmSync(base, { recursive: true, force: true });
    });

    it("accepts an in-tree rule name and artifact from the same catalog", async () => {
      const base = mkdtempSync(join(tmpdir(), "archkeep-contained-ok-"));
      const catalogPath = writeContainedCatalog(join(base, "vendored", "catalog"));
      const outputDir = join(base, "tools", "rules");

      const result = await rulesAddCommand(
        { catalog: catalogPath, to: outputDir },
        { cwd: base, ruleName: "in-tree-rule" },
      );

      expect(result.status).toBe("ok");
      expect(existsSync(join(outputDir, "in-tree-rule.wasm"))).toBe(true);

      rmSync(base, { recursive: true, force: true });
    });
  });
});

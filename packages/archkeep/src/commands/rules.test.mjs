import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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

    expect(result.status).toBe("no-verdict");
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

    expect(result.status).toBe("no-verdict");
    expect(result.report.text).toContain("FAILED");
    expect(result.report.text).toContain("missing-artifact-rule");
    expect(result.report.text).toContain("Artifact not found: rules/missing.wasm");

    // Clean up
    rmSync(missingArtifactDir, { recursive: true, force: true });
  });

  it("passes clean with valid tmpdir catalog", async () => {
    const result = await rulesVerifyCommand({ catalog: catalogPath }, { cwd: tempCatalogDir });

    expect(result.status).toBe("ok");
    expect(result.report.text).toContain("OK");
    expect(result.report.text).not.toContain("FAILED");
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
});

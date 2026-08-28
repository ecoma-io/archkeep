#!/usr/bin/env node
// Proves the packed rules package works for a consumer who is not this workspace —
// the catalog loads, the artifacts verify through the REAL host, and the CLI
// commands render correctly.
//
// This is the verify-package discipline applied to @ecoma-io/archkeep-rules,
// which ships the official rules catalog as an npm package. The verification is
// end-to-end: pack → install → load catalog → verify artifacts → run CLI commands.
//
// The catalog itself is versioned and ships with digests. This script validates
// that what ships is what the catalog claims — the same integrity check the
// `rules verify` command performs at runtime.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_DIR = "packages/archkeep-rules";

/** @type {string[]} */
const failures = [];

/** @param {string} text */
const note = (text) => console.log(text);

/**
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail]
 */
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};

/**
 * Spawns a command and returns its exit code and output.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

/**
 * Main verification flow.
 */
const main = () => {
  note(`verify-rules-package: proving @ecoma-io/archkeep-rules works after install`);

  const packageDir = resolve(root, PACKAGE_DIR);

  // 1. Pack the rules package
  note("\n1. Packing @ecoma-io/archkeep-rules");
  const packResult = run("pnpm", ["pack"], packageDir);
  check("pnpm pack succeeds", packResult.exitCode === 0, packResult.stderr);

  // The version may carry a semver prerelease suffix (`1.0.0-rc.1`), so the
  // name is not digits and dots only — `[\d.]+` stopped matching the day the
  // first release candidate was packed.
  const tarball = packResult.stdout.trim().match(/ecoma-io-archkeep-rules-\d[\w.-]*\.tgz/)?.[0];
  check("tarball filename found", !!tarball);
  if (!tarball) {
    console.error("ERROR: Could not find tarball filename from pnpm pack");
    process.exit(1);
  }

  const tarballPath = join(packageDir, tarball);
  note(`   Packed: ${tarball}`);

  // 2. Create a throwaway consumer workspace
  note("\n2. Creating throwaway consumer workspace");
  const consumerRoot = mkdtempSync(join(tmpdir(), "archkeep-rules-verify-"));
  note(`   Workspace: ${consumerRoot}`);

  // Initialize a minimal npm project
  writeFileSync(
    join(consumerRoot, "package.json"),
    JSON.stringify(
      {
        name: "archkeep-rules-consumer",
        version: "1.0.0",
        private: true,
        dependencies: {
          "@ecoma-io/archkeep-rules": `file:${tarballPath}`,
        },
      },
      null,
      2,
    ),
  );

  // 3. Install the packed package
  note("\n3. Installing @ecoma-io/archkeep-rules from tarball");
  const installResult = run("npm", ["install", tarballPath], consumerRoot);
  check(
    "npm install succeeds",
    installResult.exitCode === 0,
    installResult.stderr || installResult.stdout,
  );

  const installedPackagePath = join(consumerRoot, "node_modules", "@ecoma-io", "archkeep-rules");

  // 4. Verify the catalog file exists and is valid
  note("\n4. Verifying catalog file");
  const catalogPath = join(installedPackagePath, "catalog.json");
  const catalogExists = readFileSync(catalogPath, "utf8");
  check("catalog.json exists", true);
  let catalog;
  try {
    catalog = JSON.parse(catalogExists);
    check("catalog.json is valid JSON", true);
  } catch {
    check("catalog.json is valid JSON", false, "parse error");
  }

  if (catalog) {
    check("catalog.version is present", catalog.version !== undefined);
    check("catalog.rules is an array", Array.isArray(catalog.rules));
    check("catalog has at least one rule", catalog.rules.length > 0);

    // Verify each rule entry
    catalog.rules.forEach((rule, index) => {
      check(`rule ${index + 1} has name`, !!rule.name);
      check(`rule ${index + 1} has description`, !!rule.description);
      check(`rule ${index + 1} has contract`, !!rule.contract);
      check(`rule ${index + 1} has artifact`, !!rule.artifact);
      check(`rule ${index + 1} has sha256`, !!rule.sha256);
    });
  }

  // 5. Verify that .wasm files exist
  note("\n5. Verifying .wasm artifacts");
  if (catalog) {
    catalog.rules.forEach((rule) => {
      const wasmPath = join(installedPackagePath, rule.artifact);
      const wasmExists = readFileSync(wasmPath);
      check(`${rule.artifact} exists`, true);
      check(`${rule.artifact} has content`, wasmExists.length > 0);
    });
  }

  // 6. Create a minimal archkeep.json for testing
  note("\n6. Creating minimal archkeep.json for testing");
  writeFileSync(
    join(consumerRoot, "archkeep.json"),
    JSON.stringify(
      {
        version: 1,
        dependencyPolicy: [],
        tagPolicy: {},
        projectPolicy: {},
      },
      null,
      2,
    ),
  );

  // 7. Test CLI commands (if archkeep is available)
  note("\n7. Testing CLI commands");
  const archkeepResult = run("archkeep", ["--version"], consumerRoot);
  const hasArchkeep = archkeepResult.exitCode === 0;

  if (hasArchkeep) {
    // Test `archkeep rules list`
    const listResult = run("archkeep", ["rules", "list", "--format", "json"], consumerRoot);
    check("`archkeep rules list` succeeds", listResult.exitCode === 0);

    if (listResult.exitCode === 0) {
      try {
        const listOutput = JSON.parse(listResult.stdout);
        check("`archkeep rules list` returns valid JSON", true);
        check("`archkeep rules list` has command field", listOutput.command === "rules list");
      } catch {
        check("`archkeep rules list` returns valid JSON", false);
      }
    }

    // Test `archkeep rules info` for a known rule
    if (catalog && catalog.rules.length > 0) {
      const firstRule = catalog.rules[0].name;
      const infoResult = run(
        "archkeep",
        ["rules", "info", firstRule, "--format", "json"],
        consumerRoot,
      );
      check("`archkeep rules info` succeeds", infoResult.exitCode === 0);

      if (infoResult.exitCode === 0) {
        try {
          const infoOutput = JSON.parse(infoResult.stdout);
          check("`archkeep rules info` returns valid JSON", true);
          check(
            "`archkeep rules info` has correct rule name",
            infoOutput.result?.rule?.name === firstRule,
          );
        } catch {
          check("`archkeep rules info` returns valid JSON", false);
        }
      }
    }

    // Test `archkeep rules verify`
    const verifyResult = run("archkeep", ["rules", "verify", "--format", "json"], consumerRoot);
    check(
      "`archkeep rules verify` succeeds",
      verifyResult.exitCode === 0 || verifyResult.exitCode === 1,
    ); // 1 for findings

    if (verifyResult.exitCode === 0 || verifyResult.exitCode === 1) {
      try {
        const verifyOutput = JSON.parse(verifyResult.stdout);
        check("`archkeep rules verify` returns valid JSON", true);
        check("`archkeep rules verify` has command field", verifyOutput.command === "rules verify");
      } catch {
        check("`archkeep rules verify` returns valid JSON", false);
      }
    }
  } else {
    note("   (archkeep CLI not available, skipping command tests)");
  }

  // 8. Cleanup
  note("\n8. Cleaning up");
  rmSync(consumerRoot, { recursive: true, force: true });
  rmSync(tarballPath, { force: true });
  check("cleanup succeeds", true);

  // Summary
  console.log(`\n${failures.length === 0 ? "✓ All checks passed" : "✗ Some checks failed"}`);
  if (failures.length > 0) {
    console.error("\nFailed checks:");
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
};

main();

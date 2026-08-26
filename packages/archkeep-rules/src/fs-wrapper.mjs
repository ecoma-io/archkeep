/**
 * Filesystem wrapper for catalog validation — the only impure layer.
 *
 * This module is the thin fs adapter that bridges the pure validator to the real
 * filesystem. It reads catalog.json, walks the rules array to compute sha256
 * digests for each artifact with node:crypto, and calls the pure function with
 * those facts.
 *
 * The wrapper THROWS on catalog read/parse failures — a malformed catalog file
 * must never validate as anything, and throwing is the loud failure mode that
 * guarantees this.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogViolations } from "./validator.mjs";

/**
 * Reads catalog.json from a package root and validates it against the actual
 * artifact bytes in that tree.
 *
 * @param {string} packageRoot - the package directory (absolute path)
 * @throws {Error} if catalog.json cannot be read or parsed, or if validation fails
 * @returns {{ok: true, catalog: object}} if valid
 */
export function validateCatalogFiles(packageRoot) {
  const catalogPath = resolve(packageRoot, "catalog.json");

  // Read catalog.json — throw if missing or unreadable
  let catalogText;
  try {
    catalogText = readFileSync(catalogPath, "utf8");
  } catch (/** @type {unknown} */ error) {
    throw new Error(
      `catalog.json at ${catalogPath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  // Parse catalog.json — throw if malformed
  let catalog;
  try {
    catalog = JSON.parse(catalogText);
  } catch (/** @type {unknown} */ error) {
    throw new Error(
      `catalog.json at ${catalogPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  // Build artifact digest map: for each rule's artifact field, compute the
  // sha256 of the actual bytes on disk (or null if the file is missing)
  const artifactDigests = new Map();

  if (Array.isArray(catalog.rules)) {
    for (const rule of catalog.rules) {
      if (rule && typeof rule.artifact === "string") {
        const artifactPath = resolve(packageRoot, rule.artifact);
        let digest = null;

        try {
          const bytes = readFileSync(artifactPath);
          digest = createHash("sha256").update(bytes).digest("hex");
        } catch {
          // File missing or unreadable — digest stays null, the validator will
          // report this as a violation
        }

        artifactDigests.set(rule.artifact, digest);
      }
    }
  }

  // Validate with the pure function
  const violations = catalogViolations(catalog, artifactDigests);

  if (violations.length > 0) {
    const message = [
      `catalog.json at ${catalogPath} has ${violations.length} violation(s):`,
      ...violations,
    ].join("\n  ");
    throw new Error(message);
  }

  return { ok: true, catalog };
}

/**
 * When this file is run directly, validate the catalog in the parent directory.
 * This is the entry point for `node src/fs-wrapper.mjs` during development.
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (path) => {
    try {
      return resolve(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === resolve(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) {
  const root = resolve(fileURLToPath(import.meta.url), "..", "..");
  try {
    validateCatalogFiles(root);
    console.log(`ok   catalog.json — valid and all artifacts match their digests`);
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exit(1);
  }
}

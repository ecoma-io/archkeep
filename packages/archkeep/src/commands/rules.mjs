/**
 * The `rules` command: CLI face for the official rules catalog.
 *
 * This command provides four verbs for working with the official rules catalog
 * (`@ecoma-io/archkeep-rules`): list, info, verify, and add. It reads the catalog
 * from the filesystem (never by import) and validates artifact integrity through
 * the engine's real host.
 *
 * ## Posture
 *
 * All four verbs are descriptive except `verify`, which can exit 1 on a failed
 * verification (digest mismatch or host refusal) and exit 3 on a missing or
 * corrupt catalog. `add` exits 0 on success, 3 on any failure. `list` and `info`
 * are purely descriptive and always exit 0.
 *
 * Exit 1 is a finding — a verification that ran, looked at the bytes, and came
 * back negative. Exit 3 is the run that could not look. The two must never
 * share a code: a script branching on the exit code has to tell "the shipped
 * rule artifact was modified" from "the catalog could not be read", and the
 * first of those is the one the integrity gate exists to catch.
 *
 * Catalog-derived paths are contained to the directory that anchors them, on
 * the mechanism `../containment.mjs` already enforces for report output and
 * history captures: an `artifact` field (verify, add) resolves under the
 * catalog's own directory, an `add` target under the directory `--to` names,
 * and an entry that escapes either fails the run loudly with the entry named.
 * The catalog is data a consumer may have downloaded, vendored, or had
 * modified under it — data does not get to name a path outside its tree.
 *
 * The catalog is read from the filesystem at a user-resolvable path, never by
 * import or package dependency. This keeps the engine independent of the rules
 * package — the boundary law has no row allowing scope-nx → scope-sdk.
 *
 * ## Catalog resolution
 *
 * 1. Explicit `--catalog <path>` — resolved from cwd, must exist and be valid JSON
 * 2. Default: `node_modules/@ecoma-io/archkeep-rules/catalog.json` (workspace root relative)
 * 3. Moon/native workspaces with no node_modules → loud exit 3 with message
 *
 * `check` never reads the catalog (that claim stays true). Only the `rules` verb
 * reads it, at the user's explicit request.
 *
 * ## `rules add` dialect split
 *
 * v1 WRITES the row for:
 * - JSON dialect (`module-boundaries.config.mjs`)
 * - Inline `archkeep.json` policy (atomic write, only touching `customRules` key)
 *
 * v1 PRINTS a ready-to-paste row for:
 * - `.mjs`/`.js` module dialect (real sha256, `reason: "<fill>"` placeholder)
 * - ESLint flat-config dialect (which carries no `customRules` — the printout says so)
 *
 * Never auto-downloads anything. Never programmatically edits JavaScript modules.
 */

import { isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";

import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { loadCustomRule } from "../custom-rules/host.mjs";
import { EXIT } from "../verdict.mjs";
import { containmentViolation, pathEscapes } from "../containment.mjs";

/** Default catalog path when `--catalog` is not provided. */
const DEFAULT_CATALOG_PATH = "node_modules/@ecoma-io/archkeep-rules/catalog.json";

/** Default output directory for `rules add` when `--to` is not provided. */
const DEFAULT_RULES_DIR = "tools/rules";

/**
 * Reads and parses the catalog from a given path.
 *
 * @param {string} catalogPath The catalog file path.
 * @param {string} cwd Current working directory for relative paths.
 * @returns {{catalog: object, path: string}} The parsed catalog and its resolved path.
 * @throws {Error} if the catalog cannot be read or parsed.
 */
function loadCatalog(catalogPath, cwd) {
  const resolvedPath = isAbsolute(catalogPath) ? catalogPath : resolve(cwd, catalogPath);

  if (!existsSync(resolvedPath)) {
    throw new Error(
      `catalog not found at ${catalogPath} — install @ecoma-io/archkeep-rules or use --catalog to point to a catalog.json file`,
    );
  }

  try {
    const text = readFileSync(resolvedPath, "utf8");
    const catalog = JSON.parse(text);

    // Basic catalog validation
    if (!catalog || typeof catalog !== "object") {
      throw new Error("catalog is not an object");
    }
    if (!Array.isArray(catalog.rules)) {
      throw new Error("catalog.rules is not an array");
    }
    if (typeof catalog.version !== "number") {
      throw new Error("catalog.version is not a number");
    }

    return { catalog, path: resolvedPath };
  } catch (cause) {
    if (cause?.message?.startsWith("catalog")) {
      throw cause;
    }
    throw new Error(`catalog at ${catalogPath} is not valid JSON: ${cause?.message ?? cause}`, {
      cause,
    });
  }
}

/**
 * Resolves the catalog path from options or default.
 *
 * @param {{catalog?: string}} options The parsed command options.
 * @param {string} _cwd Current working directory.
 * @returns {string} The resolved catalog path.
 */
function resolveCatalogPath(options, _cwd) {
  return options.catalog ?? DEFAULT_CATALOG_PATH;
}

/**
 * The reason a catalog-derived path may not be read or written, or `null` when
 * it is contained.
 *
 * Two legs, the pattern `../containment.mjs` already enforces for report
 * output and history captures: a path whose resolved form escapes the anchor
 * directory is refused with the escape named, and a path that stays inside
 * lexically still goes through `containmentViolation`, so a symlink in the
 * tree cannot walk a read out of the directory or land a write somewhere
 * other than the path named. The caller resolves first and hands the SAME
 * resolved string here that it reads or writes — `containment.mjs`'s own
 * header owns why the `..`-across-a-symlink corner demands that.
 *
 * @param {string} anchorDir The absolute directory the entry resolves under.
 * @param {string} candidatePath The resolved absolute candidate — the same
 *   string the read or write will act on.
 * @param {{forWrite?: boolean}} [options] Writes carry the write policy.
 * @returns {string|null} The refusal reason, or `null` when contained.
 */
function entryPathViolation(anchorDir, candidatePath, { forWrite = false } = {}) {
  if (pathEscapes(anchorDir, candidatePath)) {
    return (
      `'${candidatePath}' resolves outside '${anchorDir}' — a catalog entry must not name a ` +
      `path outside the directory it is resolved from`
    );
  }
  // `containmentViolation` probes realpaths, which needs existing components.
  // A read anchor always exists — the catalog was read out of it. A write
  // anchor that does not exist yet is a directory this run's `mkdir` creates a
  // moment later, so there is nothing planted to walk, and where the caller
  // pointed `--to` is the caller's explicit choice, not the escape this
  // refuses.
  if (!existsSync(anchorDir)) return null;
  return containmentViolation(anchorDir, candidatePath, { forWrite });
}

/**
 * Formats a rule for text output.
 *
 * @param {object} rule A catalog rule entry.
 * @returns {string} Formatted text representation.
 */
function formatRule(rule) {
  const params = Object.entries(rule.params || {})
    .map(([key, param]) => {
      const required = param.required ? "required" : "optional";
      return `      ${key} (${param.type}, ${required})`;
    })
    .join("\n");

  return [
    `    ${rule.name}`,
    `    ${rule.description || "(no description)"}`,
    `    Contract: ${rule.contract}`,
    `    Evidence: ${(rule.needs || []).join(", ") || "(none)"}`,
    `    Artifact: ${rule.artifact}`,
    `    SHA256: ${rule.sha256}`,
    `    Parameters:`,
    params || "      (none)",
  ].join("\n");
}

/**
 * Lists all rules in the catalog.
 *
 * @param {{catalog?: string}} options The parsed command options.
 * @param {{cwd: string}} runContext The command context.
 * @returns {Promise<{status: "ok", catalog: object, report: {text: string, json: string}}>}
 */
export async function rulesListCommand(options, { cwd }) {
  const catalogPath = resolveCatalogPath(options, cwd);
  const { catalog } = loadCatalog(catalogPath, cwd);

  const context = {
    root: cwd,
    provider: /** @type {"native"} */ ("native"),
    marker: "catalog.json",
    provenance: resolveProvenance(cwd),
  };

  const lines = catalog.rules.map((rule) => formatRule(rule));
  const text =
    `Official rules catalog (${catalog.rules.length} rule${catalog.rules.length === 1 ? "" : "s"})\n` +
    `Source: ${catalogPath}\n\n` +
    lines.join("\n\n");

  const coverage = {
    complete: true,
    projects: 0,
    analyzedFiles: 1,
    imports: 0,
    notAnalyzed: [],
    blindSpots: [],
    notes: [],
  };

  return {
    status: "ok",
    catalog,
    report: {
      text,
      json: renderJson(
        jsonEnvelope({
          command: "rules list",
          context,
          status: "ok",
          exitCode: 0,
          coverage,
          result: { catalog: catalogPath, rules: catalog.rules },
        }),
      ),
    },
  };
}

/**
 * Shows detailed information about one rule.
 *
 * @param {{catalog?: string}} options The parsed command options.
 * @param {{cwd: string, ruleName: string}} runContext The command context.
 * @returns {Promise<{status: "ok"|"no-verdict", catalog: object, rule: object|null, report: {text: string, json: string}}>}
 */
export async function rulesInfoCommand(options, { cwd, ruleName }) {
  const catalogPath = resolveCatalogPath(options, cwd);
  const { catalog } = loadCatalog(catalogPath, cwd);

  const rule = catalog.rules.find((r) => r.name === ruleName);

  const context = {
    root: cwd,
    provider: /** @type {"native"} */ ("native"),
    marker: "catalog.json",
    provenance: resolveProvenance(cwd),
  };

  if (!rule) {
    const text =
      `Rule "${ruleName}" not found in catalog at ${catalogPath}\n` +
      `Available rules: ${catalog.rules.map((r) => r.name).join(", ")}`;

    const coverage = {
      complete: false,
      projects: 0,
      analyzedFiles: 0,
      imports: 0,
      notAnalyzed: [{ file: catalogPath, reason: "requested rule not found" }],
      blindSpots: [],
      notes: [],
    };

    return {
      status: "no-verdict",
      catalog,
      rule: null,
      report: {
        text,
        json: renderJson(
          jsonEnvelope({
            command: "rules info",
            context,
            status: "no-verdict",
            exitCode: 3,
            coverage,
            result: { catalog: catalogPath, availableRules: catalog.rules.map((r) => r.name) },
          }),
        ),
      },
    };
  }

  const text = formatRule(rule);

  const coverage = {
    complete: true,
    projects: 0,
    analyzedFiles: 1,
    imports: 0,
    notAnalyzed: [],
    blindSpots: [],
    notes: [],
  };

  return {
    status: "ok",
    catalog,
    rule,
    report: {
      text,
      json: renderJson(
        jsonEnvelope({
          command: "rules info",
          context,
          status: "ok",
          exitCode: 0,
          coverage,
          result: { catalog: catalogPath, rule },
        }),
      ),
    },
  };
}

/**
 * Verifies catalog integrity and artifacts through the REAL host.
 *
 * This loads each catalog artifact through `loadCustomRule` to verify:
 * - The artifact path stays inside the catalog's own directory
 * - The artifact file exists
 * - The digest matches the catalog entry
 * - The artifact loads and describes itself correctly
 * - The artifact speaks the declared contract
 *
 * @param {{catalog?: string}} options The parsed command options.
 * @param {{cwd: string}} runContext The command context.
 * @returns {Promise<{status: "ok"|"findings"|"no-verdict", catalog: object, report: {text: string, json: string}}>}
 */
export async function rulesVerifyCommand(options, { cwd }) {
  const catalogPath = resolveCatalogPath(options, cwd);
  const { catalog, path: resolvedCatalogPath } = loadCatalog(catalogPath, cwd);

  const context = {
    root: cwd,
    provider: /** @type {"native"} */ ("native"),
    marker: "catalog.json",
    provenance: resolveProvenance(cwd),
  };

  // Resolve artifact paths relative to the catalog's directory
  const catalogDir = resolve(resolvedCatalogPath, "..");

  const findings = [];
  const passed = [];
  const unknown = [];

  for (const rule of catalog.rules) {
    const artifactPath = resolve(catalogDir, rule.artifact);

    // Contained before anything is read: the artifact field is catalog data,
    // and a `../…` (or a symlink walked out of the tree) must fail this run
    // with the entry named, never be read.
    const pathRefusal = entryPathViolation(catalogDir, artifactPath);
    if (pathRefusal !== null) {
      findings.push({
        rule: rule.name,
        severity: "fail",
        message: `Artifact '${rule.artifact}' refused: ${pathRefusal}`,
      });
      continue;
    }

    if (!existsSync(artifactPath)) {
      findings.push({
        rule: rule.name,
        severity: "fail",
        message: `Artifact not found: ${rule.artifact}`,
      });
      continue;
    }

    try {
      const artifactBytes = readFileSync(artifactPath);

      // Verify digest
      const computedSha256 = createHash("sha256").update(artifactBytes).digest("hex");
      if (computedSha256 !== rule.sha256) {
        findings.push({
          rule: rule.name,
          severity: "fail",
          message: `Digest mismatch: catalog says ${rule.sha256}, file is ${computedSha256}`,
        });
        continue;
      }

      // Verify through host
      const loaded = await loadCustomRule({
        name: rule.name,
        artifactBytes,
        declaredSha256: rule.sha256,
      });

      if (!loaded.ok) {
        findings.push({
          rule: rule.name,
          severity: "fail",
          message: loaded.failure.reason,
        });
        continue;
      }

      // Verify contract version matches
      if (loaded.describe.contract !== rule.contract) {
        findings.push({
          rule: rule.name,
          severity: "fail",
          message: `Contract mismatch: catalog says ${rule.contract}, artifact says ${loaded.describe.contract}`,
        });
        continue;
      }

      passed.push({ rule: rule.name, message: "OK" });
    } catch (error) {
      findings.push({
        rule: rule.name,
        severity: "fail",
        message: `Verification failed: ${error.message}`,
      });
    }
  }

  // Three states, the posture the header promises. `findings` — the check ran
  // and produced negative results (digest mismatch, host refusal, an escaping
  // artifact) — is the exit-1 class. `no-verdict` stays the exit-3 class: the
  // run could not look. Collapsing the two makes "this artifact was tampered
  // with" indistinguishable from "the catalog could not be read" for every
  // script that branches on the exit code.
  const status =
    findings.length > 0 ? "findings" : passed.length === catalog.rules.length ? "ok" : "no-verdict";

  const exitCode = status === "ok" ? EXIT.ok : status === "findings" ? EXIT.violations : EXIT.error;

  const coverage = {
    complete: findings.length === 0 && passed.length === catalog.rules.length,
    projects: 0,
    analyzedFiles: catalog.rules.length,
    imports: 0,
    notAnalyzed: findings.map((f) => ({ file: f.rule, reason: f.message })),
    blindSpots: [],
    notes: [],
  };

  const text =
    `Catalog verification: ${findings.length === 0 ? "OK" : "FAILED"}\n` +
    `Source: ${catalogPath}\n` +
    `${catalog.rules.length} rule${catalog.rules.length === 1 ? "" : "s"} checked\n\n` +
    (findings.length > 0
      ? `Failures (${findings.length}):\n${findings.map((f) => `  [${f.severity}] ${f.rule}: ${f.message}`).join("\n")}\n\n`
      : "") +
    (passed.length > 0
      ? `Passed (${passed.length}):\n${passed.map((p) => `  [OK] ${p.rule}`).join("\n")}\n\n`
      : "") +
    (unknown.length > 0
      ? `Unknown (${unknown.length}):\n${unknown.map((u) => `  [?] ${u.rule}: ${u.message}`).join("\n")}\n\n`
      : "");

  return {
    status,
    catalog,
    report: {
      text,
      json: renderJson(
        jsonEnvelope({
          command: "rules verify",
          context,
          status,
          exitCode,
          coverage,
          result: {
            catalog: catalogPath,
            totalRules: catalog.rules.length,
            passed: passed.length,
            findingsCount: findings.length,
            findings,
          },
        }),
      ),
    },
  };
}

/**
 * Adds a rule from the catalog to the workspace.
 *
 * This copies the exact wasm bytes to a local directory and either:
 * - WRITES the customRules row for JSON dialect and inline archkeep.json
 * - PRINTS a ready-to-paste row for .mjs/.js module dialect and ESLint flat-config
 *
 * @param {{catalog?: string, to?: string}} options The parsed command options.
 * @param {{cwd: string, ruleName: string}} runContext The command context.
 * @returns {Promise<{status: "ok"|"no-verdict", catalog: object, report: {text: string, json: string}}>}
 */
export async function rulesAddCommand(options, { cwd, ruleName }) {
  const catalogPath = resolveCatalogPath(options, cwd);
  const { catalog, path: resolvedCatalogPath } = loadCatalog(catalogPath, cwd);

  const context = {
    root: cwd,
    provider: /** @type {"native"} */ ("native"),
    marker: "catalog.json",
    provenance: resolveProvenance(cwd),
  };

  const rule = catalog.rules.find((r) => r.name === ruleName);

  if (!rule) {
    const text =
      `Rule "${ruleName}" not found in catalog at ${catalogPath}\n` +
      `Available rules: ${catalog.rules.map((r) => r.name).join(", ")}`;

    const coverage = {
      complete: false,
      projects: 0,
      analyzedFiles: 0,
      imports: 0,
      notAnalyzed: [{ file: catalogPath, reason: "requested rule not found" }],
      blindSpots: [],
      notes: [],
    };

    return {
      status: "no-verdict",
      catalog,
      report: {
        text,
        json: renderJson(
          jsonEnvelope({
            command: "rules add",
            context,
            status: "no-verdict",
            exitCode: 3,
            coverage,
            result: { catalog: catalogPath, availableRules: catalog.rules.map((r) => r.name) },
          }),
        ),
      },
    };
  }

  // Resolve artifact path — from the path `loadCatalog` actually read, not a
  // second resolution that would anchor a relative `--catalog` on the process
  // cwd instead of this run's workspace.
  const catalogDir = resolve(resolvedCatalogPath, "..");
  const sourceArtifactPath = resolve(catalogDir, rule.artifact);

  // Contained before anything is read — same boundary as `verify`, same
  // reason: the artifact field is catalog data.
  const pathRefusal = entryPathViolation(catalogDir, sourceArtifactPath);
  if (pathRefusal !== null) {
    const coverage = {
      complete: false,
      projects: 0,
      analyzedFiles: 0,
      imports: 0,
      notAnalyzed: [{ file: sourceArtifactPath, reason: pathRefusal }],
      blindSpots: [],
      notes: [],
    };

    return {
      status: "no-verdict",
      catalog,
      report: {
        text: `Rule '${rule.name}' refused: artifact '${rule.artifact}' — ${pathRefusal}\n`,
        json: renderJson(
          jsonEnvelope({
            command: "rules add",
            context,
            status: "no-verdict",
            exitCode: 3,
            coverage,
            result: { catalog: catalogPath, rule: rule.name },
          }),
        ),
      },
    };
  }

  if (!existsSync(sourceArtifactPath)) {
    const coverage = {
      complete: false,
      projects: 0,
      analyzedFiles: 0,
      imports: 0,
      notAnalyzed: [{ file: sourceArtifactPath, reason: "artifact not found" }],
      blindSpots: [],
      notes: [],
    };

    return {
      status: "no-verdict",
      catalog,
      report: {
        text: `Artifact not found: ${rule.artifact}\n`,
        json: renderJson(
          jsonEnvelope({
            command: "rules add",
            context,
            status: "no-verdict",
            exitCode: 3,
            coverage,
            result: { catalog: catalogPath, rule: rule.name },
          }),
        ),
      },
    };
  }

  // Verify digest before copying
  const artifactBytes = readFileSync(sourceArtifactPath);
  const computedSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  if (computedSha256 !== rule.sha256) {
    const coverage = {
      complete: false,
      projects: 0,
      analyzedFiles: 1,
      imports: 0,
      notAnalyzed: [{ file: sourceArtifactPath, reason: "digest mismatch" }],
      blindSpots: [],
      notes: [],
    };

    return {
      status: "no-verdict",
      catalog,
      report: {
        text: `Digest mismatch: catalog says ${rule.sha256}, file is ${computedSha256}\n`,
        json: renderJson(
          jsonEnvelope({
            command: "rules add",
            context,
            status: "no-verdict",
            exitCode: 3,
            coverage,
            result: { catalog: catalogPath, rule: rule.name },
          }),
        ),
      },
    };
  }

  // Determine output directory
  const outputDir = options.to ? resolve(cwd, options.to) : resolve(cwd, DEFAULT_RULES_DIR);

  // The final name is catalog-derived — `ruleName` matched a catalog entry —
  // so it is contained to the directory `--to` names, the write-side guard the
  // report writer runs (`../../cli.mjs`). The target is resolved ONCE here and
  // the identical string feeds the check and the write below. The lexical half
  // runs before the directory is created, so a refused run creates nothing;
  // when `--to` does not exist yet there is nothing planted for the symlink
  // probe to walk, and `entryPathViolation` says so by returning `null`.
  const targetArtifactPath = resolve(outputDir, `${ruleName}.wasm`);
  const writeRefusal = entryPathViolation(outputDir, targetArtifactPath, { forWrite: true });
  if (writeRefusal !== null) {
    const coverage = {
      complete: false,
      projects: 0,
      analyzedFiles: 1,
      imports: 0,
      notAnalyzed: [{ file: targetArtifactPath, reason: writeRefusal }],
      blindSpots: [],
      notes: [],
    };

    return {
      status: "no-verdict",
      catalog,
      report: {
        text: `Rule '${ruleName}' refused: ${writeRefusal}\n`,
        json: renderJson(
          jsonEnvelope({
            command: "rules add",
            context,
            status: "no-verdict",
            exitCode: 3,
            coverage,
            result: { catalog: catalogPath, rule: rule.name },
          }),
        ),
      },
    };
  }

  // Create directory if needed
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Copy artifact bytes
  writeFileSync(targetArtifactPath, artifactBytes);

  // Generate the customRules row
  const customRulesRow = {
    name: rule.name,
    artifact: `${ruleName}.wasm`,
    sha256: rule.sha256,
    params: rule.params || {},
    reason: "<fill this in>",
  };

  const rowJson = JSON.stringify(customRulesRow, null, 2);

  const text =
    `Rule "${rule.name}" added to workspace\n` +
    `Artifact copied to: ${targetArtifactPath}\n\n` +
    `Add this row to your boundary config under customRules:\n` +
    `${rowJson}\n\n` +
    `For .mjs/.js module configs, paste this row and set a real reason.\n` +
    `For ESLint flat configs, the flat config dialect does not support customRules — ` +
    `add a module-boundaries.config.mjs to your workspace instead.\n`;

  const coverage = {
    complete: true,
    projects: 0,
    analyzedFiles: 2,
    imports: 0,
    notAnalyzed: [],
    blindSpots: [],
    notes: [],
  };

  return {
    status: "ok",
    catalog,
    report: {
      text,
      json: renderJson(
        jsonEnvelope({
          command: "rules add",
          context,
          status: "ok",
          exitCode: 0,
          coverage,
          result: {
            catalog: catalogPath,
            rule: rule.name,
            artifactPath: targetArtifactPath,
            customRulesRow,
          },
        }),
      ),
    },
  };
}

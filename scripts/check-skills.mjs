#!/usr/bin/env node
// Validates the arch-* agent skills: structure, frontmatter, versions, and
// that the canonical skills have not drifted from the host integrations.
//
// WHY this script exists. A skill whose frontmatter is malformed, whose version
// does not match the package, or whose name disagrees with its directory is not
// a skill an agent can reliably discover or invoke. And a skill that carries
// host-specific frontmatter fields (Claude Code's `context`, `model`, `effort`)
// has violated the host-independence contract the skills layer depends on.
//
// The facts this script judges are READ FROM THE FILESYSTEM by `readSkillFacts`;
// the evaluation itself is the pure function `evaluate`, which takes those facts
// as arguments and returns verdicts. That split is the same one
// `check-packages.mjs` uses, for the same reason: a pure function can be tested
// without a filesystem and without a mocking library.
//
// The version it checks against comes from `packages/lattice/package.json` —
// the single source of truth for the Lattice release version. All skill
// metadata.version fields, the plugin manifest version, and the marketplace
// entry version must match it.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SKILLS_DIR = "skills";
export const EXPECTED_SKILLS = ["arch-context", "arch-change", "arch-check", "arch-review"];
export const PACKAGE_JSON = "packages/lattice/package.json";

// Host-specific frontmatter fields that must NOT appear in canonical skills.
// These are Claude Code extensions to the Agent Skills spec.
export const HOST_SPECIFIC_FIELDS = ["context", "model", "effort", "agent", "paths"];

/**
 * Parses YAML frontmatter from a SKILL.md file. Returns the parsed key-value
 * pairs as a flat object, or null if frontmatter cannot be found or parsed.
 *
 * This is a minimal parser — it handles the subset of YAML used in SKILL.md
 * frontmatter (simple key-value pairs, no nested structures beyond `metadata`).
 *
 * @param {string} text full contents of a SKILL.md file
 * @returns {Record<string, any>|null}
 */
export function parseSkillFrontmatter(text) {
  const start = text.indexOf("---");
  if (start === -1) return null;
  const afterFirst = start + 3;
  const end = text.indexOf("---", afterFirst);
  if (end === -1) return null;

  const yaml = text.slice(afterFirst, end).trim();
  const result = /** @type {Record<string, any>} */ ({});

  let currentObj = /** @type {Record<string, any>|null} */ (null);

  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    // Indented line under a parent key (e.g. metadata.version: "0.4.0")
    const indentMatch = /^(\s+)([\w-]+):\s*(.*)$/.exec(line);
    if (indentMatch && currentObj !== null) {
      const [, , key, value] = indentMatch;
      const trimmedValue = value.trim();
      if (trimmedValue === "") {
        // Nested object start (not expected in our skills but handled)
        currentObj[key] = {};
        continue;
      }
      currentObj[key] = unquote(trimmedValue);
      continue;
    }

    // Top-level key: value
    const topMatch = /^([\w-]+):\s*(.*)$/.exec(line);
    if (topMatch) {
      const [, key, value] = topMatch;
      const trimmedValue = value.trim();
      if (trimmedValue === "") {
        // Next-level object starts (e.g. "metadata:")
        currentObj = {};
        result[key] = currentObj;
      } else {
        currentObj = null;
        result[key] = unquote(trimmedValue);
      }
      continue;
    }

    // If we reach here, the line didn't match any known pattern.
    // Reset context to avoid misattributing.
    currentObj = null;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Removes surrounding quotes from a YAML value string.
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Judges the skill facts and returns verdict lines and failures.
 *
 * @param {object} input
 * @param {string[]} input.skillDirs directory names under skills/
 * @param {string} input.packageVersion version from packages/lattice/package.json
 * @param {string} input.pluginVersion version from plugin.json
 * @param {string} input.marketplaceVersion version from marketplace.json entry
 * @param {{dir: string, name: string|null, description: string|null, metadataVersion: string|null, compatibility: string|null, hostFields: string[]}[]} input.skills
 *   parsed frontmatter for each skill
 * @returns {{lines: string[], failures: string[]}}
 */
export function evaluate({ skillDirs, packageVersion, pluginVersion, marketplaceVersion, skills }) {
  const lines = [];
  const failures = [];

  // 1. Every expected skill directory must exist
  for (const expected of EXPECTED_SKILLS) {
    if (!skillDirs.includes(expected)) {
      failures.push(
        `Expected skill directory ${SKILLS_DIR}/${expected} does not exist. ` +
          `The arch-* skills are the agent-facing architecture protocol and must all be present.`,
      );
      lines.push(`FAIL ${expected} — missing`);
    }
  }

  // 2. No unexpected skill directories (warn, not fail)
  for (const dir of skillDirs) {
    if (!EXPECTED_SKILLS.includes(dir)) {
      lines.push(`note ${dir} — not in expected set`);
    }
  }

  // 3. Each skill must have valid frontmatter
  for (const skill of skills) {
    if (skill.name === null) {
      failures.push(
        `${SKILLS_DIR}/${skill.dir}/SKILL.md has no \`name\` field in frontmatter. ` +
          `The Agent Skills specification requires it.`,
      );
      lines.push(`FAIL ${skill.dir} — missing name`);
      continue;
    }

    if (skill.description === null) {
      failures.push(
        `${SKILLS_DIR}/${skill.dir}/SKILL.md has no \`description\` field in frontmatter. ` +
          `The Agent Skills specification requires it.`,
      );
      lines.push(`FAIL ${skill.dir} — missing description`);
    }

    // 4. name must match parent directory
    if (skill.name !== skill.dir) {
      failures.push(
        `${SKILLS_DIR}/${skill.dir}/SKILL.md has name "${skill.name}" but must match ` +
          `its directory name "${skill.dir}". The Agent Skills spec requires this.`,
      );
      lines.push(`FAIL ${skill.dir} — name mismatch`);
    }

    // 5. metadata.version must exist
    if (skill.metadataVersion === null) {
      failures.push(
        `${SKILLS_DIR}/${skill.dir}/SKILL.md has no \`metadata.version\`. ` +
          `All skills must carry the Lattice package version so consumers can detect drift.`,
      );
      lines.push(`FAIL ${skill.dir} — missing version`);
    } else if (skill.metadataVersion !== packageVersion) {
      failures.push(
        `${SKILLS_DIR}/${skill.dir}/SKILL.md version is "${skill.metadataVersion}" ` +
          `but the package version is "${packageVersion}". All skill versions must match ` +
          `the Lattice package version.`,
      );
      lines.push(`FAIL ${skill.dir} — version mismatch`);
    }

    // 6. No host-specific frontmatter fields
    if (skill.hostFields.length > 0) {
      failures.push(
        `${SKILLS_DIR}/${skill.dir}/SKILL.md has host-specific frontmatter fields: ` +
          `${skill.hostFields.join(", ")}. Canonical skills must be host-independent. ` +
          `Host-specific configuration belongs in the plugin, not in the skill.`,
      );
      lines.push(`FAIL ${skill.dir} — host-specific fields`);
    }

    // 7. compatibility field should mention lattice
    if (skill.compatibility !== null && !skill.compatibility.toLowerCase().includes("lattice")) {
      lines.push(`note ${skill.dir} — compatibility does not mention lattice`);
    }

    // 8. OK line if no failures for this skill
    if (!failures.some((f) => f.includes(`${skill.dir}`))) {
      const ver = skill.metadataVersion ?? "?";
      lines.push(`ok   ${skill.dir} — v${ver}`);
    }
  }

  // 9. Plugin version must match package version
  if (pluginVersion !== packageVersion) {
    failures.push(
      `plugin.json version is "${pluginVersion}" but package version is ` +
        `"${packageVersion}". The plugin manifest must be synchronized with the package.`,
    );
    lines.push(`FAIL plugin.json — version mismatch`);
  }

  // 10. Marketplace entry version must match package version
  if (marketplaceVersion !== packageVersion) {
    failures.push(
      `marketplace.json version is "${marketplaceVersion}" but package version is ` +
        `"${packageVersion}". The marketplace entry must be synchronized with the package.`,
    );
    lines.push(`FAIL marketplace.json — version mismatch`);
  }

  return { lines, failures };
}

/**
 * Reads the filesystem and returns the facts `evaluate` needs.
 * This is the only function that touches the outside world.
 *
 * @returns {{skillDirs: string[], packageVersion: string, pluginVersion: string, marketplaceVersion: string, skills: object[]}}
 */
export function readSkillFacts() {
  const pkgPath = join(root, PACKAGE_JSON);
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : { version: "?" };
  const packageVersion = pkg.version;

  const manifestPath = join(root, "packages/lattice/.claude-plugin/plugin.json");
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : { version: "?" };
  const pluginVersion = manifest.version;

  const cataloguePath = join(root, ".claude-plugin/marketplace.json");
  const catalogue = existsSync(cataloguePath)
    ? JSON.parse(readFileSync(cataloguePath, "utf8"))
    : { plugins: [{ version: "?" }] };
  const marketplaceVersion = catalogue.plugins[0]?.version ?? "?";

  const skillsDir = join(root, SKILLS_DIR);
  const skillDirs = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];

  const skills = skillDirs.map((dir) => {
    const skillPath = join(skillsDir, dir, "SKILL.md");
    if (!existsSync(skillPath)) {
      return {
        dir,
        name: null,
        description: null,
        metadataVersion: null,
        compatibility: null,
        hostFields: [],
      };
    }
    const text = readFileSync(skillPath, "utf8");
    const fm = parseSkillFrontmatter(text);

    const metadata = fm?.metadata && typeof fm.metadata === "object" ? fm.metadata : {};
    const hostFields = Object.keys(fm ?? {}).filter((k) => HOST_SPECIFIC_FIELDS.includes(k));

    return {
      dir,
      name: fm?.name ?? null,
      description: fm?.description ?? null,
      metadataVersion: metadata.version ?? null,
      compatibility: fm?.compatibility ?? null,
      hostFields,
    };
  });

  return { skillDirs, packageVersion, pluginVersion, marketplaceVersion, skills };
}

function main() {
  const facts = readSkillFacts();
  const { lines, failures } = evaluate(facts);

  for (const line of lines) console.log(line);

  if (failures.length > 0) {
    console.error("");
    for (const failure of failures) console.error(`✗ ${failure}`);
    process.exit(1);
  }
}

/**
 * Whether this file was RUN rather than imported, compared on real paths.
 * See `check-packages.mjs` for the reason this exists and why it is not shared.
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) main();

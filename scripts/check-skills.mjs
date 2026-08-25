#!/usr/bin/env node
// Validates the arch-* agent skills: structure, frontmatter, and that the
// canonical skills have not drifted from the host integrations.
//
// WHY this script exists. A skill whose frontmatter is malformed, or whose name
// disagrees with its directory, is not a skill an agent can reliably discover
// or invoke. And a skill that carries host-specific frontmatter fields (Claude
// Code's `context`, `model`, `effort`) has violated the host-independence
// contract the skills layer depends on.
//
// The facts this script judges are READ FROM THE FILESYSTEM by `readSkillFacts`;
// the evaluation itself is the pure function `evaluate`, which takes those facts
// as arguments and returns verdicts. That split is the same one
// `check-packages.mjs` uses, for the same reason: a pure function can be tested
// without a filesystem and without a mocking library.
//
// The version it checks against comes from `packages/archkeep/package.json` —
// the baseline docs/skills/versioning.md calls the source of truth. The Claude
// Code plugin manifest version, the marketplace entry version, the Codex
// plugin manifest version, and the VS Code extension's package.json version
// must all match it — and so must the repository ROOT `package.json`, which
// is what release-please's "." component actually bumps directly; the other
// nine (this baseline included) are copies of it via `extra-files` — the
// Rust SDK's Cargo.toml and the TS SDK's package.json joined the chain with
// their packages, per the ADR 0002 decision that every SDK versions with the
// engine it pairs with, and the MCP package joined it because it composes the
// engine's command layer directly. Checking
// every copy against a baseline that was never itself checked against the
// thing it copies from is the gap this script closes: a drift there would
// have read as "everything agrees" right up to the file nothing compared.
// Skills themselves carry no version by decision — a consumer's installed
// skills pair with the engine they ship beside, so the version that matters
// is the plugin's, not a per-skill one (docs/skills/versioning.md).

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SKILLS_DIR = "skills";
export const EXPECTED_SKILLS = [
  "arch-context",
  "arch-change",
  "arch-check",
  "arch-review",
  "arch-migrate",
];
export const PACKAGE_JSON = "packages/archkeep/package.json";
export const ROOT_PACKAGE_JSON = "package.json";
export const CLAUDE_PLUGIN_MANIFEST = ".claude-plugin/plugin.json";
export const MARKETPLACE_CATALOGUE = ".claude-plugin/marketplace.json";
export const MARKETPLACE_PLUGIN_NAME = "archkeep";
export const CODEX_PLUGIN_MANIFEST = ".codex-plugin/plugin.json";
export const AGENTS_SKILLS_DIR = ".agents/skills";
export const VSCODE_PACKAGE_JSON = "packages/archkeep-vscode/package.json";
export const RUST_SDK_CARGO_TOML = "packages/archkeep-rule-sdk-rust/Cargo.toml";
export const RUST_SDK_CARGO_LOCK = "packages/archkeep-rule-sdk-rust/Cargo.lock";
export const RUST_SDK_CRATE_NAME = "archkeep-rule-sdk";
export const TS_SDK_PACKAGE_JSON = "packages/archkeep-rule-sdk-ts/package.json";
export const MCP_PACKAGE_JSON = "packages/archkeep-mcp/package.json";
export const PYTHON_SDK_PYPROJECT = "packages/archkeep-rule-sdk-python/pyproject.toml";

// Every version-bearing path the chain compares — the ten files
// docs/skills/versioning.md enumerates, aggregated from the constants above
// rather than restated. release-please's `extra-files` list must name no file
// outside it: a manifest bumped on every release but verified by no chain
// check is drift nobody sees. check-skills.test.mjs is the cross-check that
// holds the two rosters together; extend this list in the same commit that
// adds a chain link.
export const VERSION_CHAIN_PATHS = [
  ROOT_PACKAGE_JSON,
  PACKAGE_JSON,
  MCP_PACKAGE_JSON,
  CLAUDE_PLUGIN_MANIFEST,
  MARKETPLACE_CATALOGUE,
  CODEX_PLUGIN_MANIFEST,
  VSCODE_PACKAGE_JSON,
  RUST_SDK_CARGO_TOML,
  TS_SDK_PACKAGE_JSON,
  PYTHON_SDK_PYPROJECT,
];

// Host-specific frontmatter fields that must NOT appear in canonical skills.
// These are Claude Code extensions to the Agent Skills spec.
export const HOST_SPECIFIC_FIELDS = ["context", "model", "effort", "agent", "paths"];

// The one prefix under which a skill's link is a link into THIS repository.
// Everything a skill cites about Archkeep is reached through it, and check 17
// resolves the path that follows against the tracked tree.
export const REPO_BLOB_PREFIX = "https://github.com/ecoma-io/archkeep/blob/main/";

/**
 * The destination of every `[text](target)` markdown link in a SKILL.md, with
 * the 1-based line it sits on.
 *
 * Deliberately NOT a call into `check-docs-links.mjs`'s `parseMarkdownLinks`:
 * that one drops external targets before it returns, because a link out of the
 * tree is nothing it can resolve. External targets are exactly what check 17
 * has to inspect, so the two functions want opposite halves of the same scan
 * and neither can be expressed as the other. The malformed link SHAPES that
 * gate refuses (a split-across-lines destination, a spaced one) stay its job:
 * `skills/` is not on its ignore list, so both gates read the canonical tree
 * and only the copy under `.agents/skills/` is judged here alone.
 *
 * Scanned line-wise on the raw text, fences included — the same tolerated
 * over-check `parseMarkdownLinks` documents for link resolution. A fenced
 * EXAMPLE of a repo-relative link would fail this gate; being loud about a
 * link that is not really there is the recoverable direction, and no skill
 * carries one.
 *
 * @param {string} text full contents of a SKILL.md file
 * @returns {{line: number, target: string}[]}
 */
export function skillLinkTargets(text) {
  const found = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const re = /\]\(\s*<?([^)>\s]*)/g;
    let match;
    while ((match = re.exec(lines[i]))) {
      found.push({ line: i + 1, target: match[1] });
    }
  }
  return found;
}

/**
 * Parses YAML frontmatter from a SKILL.md file. Returns the parsed key-value
 * pairs as a flat object, or null if frontmatter cannot be found or parsed.
 *
 * This is a minimal parser — it handles the subset of YAML used in SKILL.md
 * frontmatter (simple key-value pairs, no nested structures beyond `metadata`).
 *
 * Both delimiters are matched LINE-WISE, and the opening one must be the
 * file's very first line — what docs/skills/authoring.md already requires. A
 * raw `indexOf("---")` would instead accept a thematic break in the body as
 * the opening delimiter, reading a name out of prose the host never parses,
 * and would end the block at the first `---` ANYWHERE — including inside a
 * value, silently truncating that value and dropping every field after it. A
 * null return is the named refusal: `readSkillFacts` turns it into missing
 * `name`/`description`, which `evaluate` fails on loudly.
 *
 * @param {string} text full contents of a SKILL.md file
 * @returns {Record<string, any>|null}
 */
export function parseSkillFrontmatter(text) {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trimEnd() !== "---") return null;
  const closeIndex = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
  if (closeIndex === -1) return null;

  const yaml = lines.slice(1, closeIndex).join("\n").trim();
  const result = /** @type {Record<string, any>} */ ({});

  let currentObj = /** @type {Record<string, any>|null} */ (null);

  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    // Indented line under a parent key (e.g. any nested key)
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
 * Every host-specific field found anywhere in parsed frontmatter — top level
 * or nested — as dotted paths (`metadata.model`). The parser builds a
 * sub-object for any key whose value is empty, so an indented field lands
 * one level down; a top-level-only filter misses it, and a host-specific
 * field that hides there passes as host-independent. Nested paths are the
 * loud form: `metadata.model` names both the hiding place and the field.
 *
 * @param {Record<string, any>} frontmatter parsed frontmatter, `{}` when none
 * @returns {string[]} dotted paths of every host-specific field found
 */
export function findHostSpecificFields(frontmatter) {
  const found = [];
  const walk = (/** @type {Record<string, any>} */ obj, /** @type {string} */ prefix) => {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (HOST_SPECIFIC_FIELDS.includes(key)) found.push(path);
      if (value !== null && typeof value === "object") walk(value, path);
    }
  };
  walk(frontmatter, "");
  return found;
}

/**
 * The named section's `version` from a TOML manifest — Cargo's `[package]`,
 * pyproject's `[project]` — or "?" when the shape is not there to read: the
 * same fallback every JSON reader above uses, so an absent or unreadable
 * manifest fails the version comparison loudly instead of being skipped.
 *
 * A minimal parser in `parseSkillFrontmatter`'s spirit: only the shape those
 * tools themselves write. Scoped to the named section deliberately — a bare
 * `version = "…"` match would also hit a pinned dependency's version under
 * `[dependencies]`, and reading the wrong section's number as the manifest's
 * own is the silent direction for a version gate.
 *
 * @param {string} text full contents of the TOML file
 * @param {string} section the section header the version lives under
 * @returns {string} the section's version, or "?" when it cannot be read
 */
export function tomlSectionVersion(text, section) {
  const lines = text.split("\n");
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[/.test(trimmed)) {
      inSection = trimmed === section;
      continue;
    }
    if (!inSection) continue;
    const match = /^version\s*=\s*"([^"]+)"/.exec(trimmed);
    if (match) return match[1];
  }
  return "?";
}

/**
 * The version Cargo.lock records for one package, or "?" when the lock does
 * not name it.
 *
 * A separate parser from `tomlSectionVersion` rather than a call into it,
 * because Cargo.lock is not a section keyed by name: it is a repeated
 * `[[package]]` array whose every entry carries the same header, so matching
 * on the header alone returns the FIRST entry's version — which in an
 * alphabetically sorted lock is a dependency's, not the crate's own. Reading
 * a dependency's number as the crate's is the silent direction here, the same
 * one `tomlSectionVersion`'s own scoping guards against.
 *
 * The lock is on the chain for a reason the manifests are not: release-please
 * writes `Cargo.toml` via `extra-files` and NOTHING writes the lock, so the
 * bump lands in one file and not the other. `cargo test --locked` and
 * `cargo publish --locked` — the two commands the release lane runs before it
 * uploads — refuse to proceed when the lock disagrees with the manifest, so
 * that drift is a release that cannot publish. This gate moves the failure
 * back to the release pull request, where the fix is a commit, from the
 * publish job, where the tag is already immutable.
 *
 * @param {string} text full contents of Cargo.lock
 * @param {string} name the package whose recorded version to read
 * @returns {string} that package's version, or "?" when the lock does not name it
 */
export function cargoLockPackageVersion(text, name) {
  let inPackage = false;
  let matched = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (/^\[/.test(trimmed)) {
      inPackage = trimmed === "[[package]]";
      matched = false;
      continue;
    }
    if (!inPackage) continue;
    const nameMatch = /^name\s*=\s*"([^"]+)"/.exec(trimmed);
    if (nameMatch) {
      matched = nameMatch[1] === name;
      continue;
    }
    const versionMatch = /^version\s*=\s*"([^"]+)"/.exec(trimmed);
    if (versionMatch && matched) return versionMatch[1];
  }
  return "?";
}

/**
 * The version of a marketplace catalogue's matching plugin entry, selected by
 * name/identity rather than array position. `.claude-plugin/marketplace.json`
 * is a catalogue and `plugins` is a list this repository controls today, but
 * nothing stops it growing a second entry — a decoy plugin prepended ahead of
 * `archkeep` would leave the real entry unchecked by a positional read while
 * still returning a plausible-looking version string.
 *
 * @param {{plugins?: {name?: string, version?: string}[]}} catalogue parsed marketplace.json
 * @param {string} pluginName the plugin identity to select (`MARKETPLACE_PLUGIN_NAME`)
 * @returns {string} the matching entry's version, or "?" when no entry matches
 */
export function selectMarketplaceVersion(catalogue, pluginName) {
  const entry = (catalogue.plugins ?? []).find((plugin) => plugin?.name === pluginName);
  return entry?.version ?? "?";
}

/**
 * Judges the skill facts and returns verdict lines and failures.
 *
 * @param {object} input
 * @param {string[]} input.skillDirs directory names under skills/
 * @param {string} input.packageVersion version from packages/archkeep/package.json
 * @param {string} input.rootVersion version from the repository root package.json — the
 *   release-please "." component release-please writes directly; the other four files
 *   (including packages/archkeep/package.json) are copies of it via `extra-files`
 * @param {string} input.pluginVersion version from the Claude Code plugin manifest
 * @param {string} input.marketplaceVersion version from the marketplace.json entry
 * @param {string} input.codexPluginVersion version from the Codex plugin manifest
 * @param {string} input.vscodeVersion version from packages/archkeep-vscode/package.json
 * @param {string} input.cargoVersion version from the Rust SDK's Cargo.toml `[package]` section
 * @param {string} input.cargoLockVersion version Cargo.lock records for the Rust SDK crate
 * @param {string} input.tsSdkVersion version from the TS SDK's package.json
 * @param {string} input.mcpVersion version from the MCP package's package.json — the
 *   agent capability interface, published to npm and versioned with the engine it
 *   composes through `./commands`
 * @param {string} input.pySdkVersion version from the Python SDK's pyproject.toml `[project]` section
 * @param {{dir: string, name: string|null, description: string|null, compatibility: string|null, hostFields: string[], text?: string}[]} input.skills
 *   parsed frontmatter plus the full SKILL.md text for each skill
 * @param {Record<string, string>|null} [input.agentsSkillsFiles] every file under
 *   `.agents/skills`, relative path to content, or null when the directory cannot be
 *   read. Optional in the type only because the runtime default is null — an unpassed
 *   fact FAILS check 16, it does not skip it
 * @param {Record<string, string>|null} [input.skillsFiles] the same map for `skills/`,
 *   the canonical tree the copy must equal byte for byte, with the same loud default
 * @param {string[]|null} [input.trackedFiles] every path `git ls-files` reports, the set a
 *   skill's repo link may name. null when it could not be read — which FAILS every repo
 *   link rather than passing it, since an unverifiable link is the silent direction
 * @param {string} [input.authoring] text of docs/skills/authoring.md
 * @param {string} [input.overview] text of docs/skills/overview.md
 * @returns {{lines: string[], failures: string[]}}
 */
export function evaluate({
  skillDirs,
  packageVersion,
  rootVersion,
  pluginVersion,
  marketplaceVersion,
  codexPluginVersion,
  vscodeVersion,
  cargoVersion,
  cargoLockVersion,
  tsSdkVersion,
  mcpVersion,
  pySdkVersion,
  skills,
  agentsSkillsFiles = null,
  skillsFiles = null,
  trackedFiles = null,
  authoring = "",
  overview = "",
}) {
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

    // 5. No host-specific frontmatter fields
    if (skill.hostFields.length > 0) {
      failures.push(
        `${SKILLS_DIR}/${skill.dir}/SKILL.md has host-specific frontmatter fields: ` +
          `${skill.hostFields.join(", ")}. Canonical skills must be host-independent. ` +
          `Host-specific configuration belongs in the plugin, not in the skill.`,
      );
      lines.push(`FAIL ${skill.dir} — host-specific fields`);
    }

    // 6. compatibility field should mention archkeep
    if (skill.compatibility !== null && !skill.compatibility.toLowerCase().includes("archkeep")) {
      lines.push(`note ${skill.dir} — compatibility does not mention archkeep`);
    }

    // 7. OK line if no failures for this skill
    if (!failures.some((f) => f.includes(`${skill.dir}`))) {
      lines.push(`ok   ${skill.dir}`);
    }
  }

  // 7b. The skills' mechanism claims must describe the current commands, and
  // the authoring docs must not require a per-skill version. These are the
  // doc-truth corrections the audit closed (WS1-F01/F02/F03/F10): a skill
  // that teaches a stale behavior misdirects an agent the same way a silent
  // gate does — the agent trusts a mechanism the code no longer performs.
  const skillText = new Map(skills.map((s) => [s.dir, s.text]));
  // Stale-mechanism claims, each a regex so a REWORDED reversion is still
  // caught — a stale sentence sits identical to an absent one, so the gate
  // matches the claim's shape, not one exact string. Each pattern must be
  // checked against the CURRENT corrected text AND the natural phrasings a
  // maintainer would write to document the corrected behavior (a "does not
  // resolve", "must not declare" or "must not contain" clause describes the
  // correct state and must stay green) before extending.
  const stalePhrases = [
    {
      // WS1-F01: an `adr:`-prefixed id falling into the reverse lookup and
      // reading as a clean, unenforced exit-0 sentence.
      re: /reverse-lookup (?:arm|branch)/u,
      skills: ["arch-change"],
      why: "an `adr:`-prefixed id never falls to the reverse lookup — it resolves like the bare slug, and an unknown one is exit 3",
    },
    {
      re: /not[- ]enforced[^\n]{0,60}exit 0/u,
      skills: ["arch-change"],
      why: "an ADR id the registry does not know is exit 3, never a clean 'not enforced' sentence",
    },
    {
      // WS1-F01 additive: an `adr:`-prefixed id "treated as" the reverse
      // lookup and reported with a clean sentence — the arm/branch wording
      // above is not the only shape a reversion can choose.
      re: /adr:[^\n]{0,50}(?:falls? (?:to|into)|treated as)[^\n]{0,50}(?:clean|exit 0)/iu,
      skills: ["arch-change"],
      why: "an `adr:`-prefixed id never falls to the reverse lookup — an unknown one is exit 3, never a clean sentence",
    },
    {
      // WS1-F02: `check` does not resolve a decisionRef. The subject is bound
      // to an explicit name (check/the command) rather than a pronoun — "it
      // does not resolve" is ambiguous between the stale claim and the
      // corrected "an unresolved decisionRef does not resolve to a verdict",
      // so a pronoun arm would false-positive on the natural phrasing. The
      // window excludes sentence AND clause boundaries (`.` and `;`) so an
      // intervening clause ("check names an unresolved citation; it does not
      // resolve to a verdict") stays green, while a comma-adjacent "the check
      // does NOT resolve them" still matches.
      re: /(?:check|the command)\b[^.;\n]{0,40}(?:does\s+not|doesn't|never|won't|is\s+not\s+able\s+to)\s+resolve\w*\b/iu,
      skills: ["arch-check"],
      why: "`check` resolves each row's decisionRef against the ADR registry — report-only on a `depConstraints` row, exit 3 on an applied intent row",
    },
    {
      // WS1-F03: `waivers` names/lists only the term-bound rows.
      re: /(?:names|lists)\s+only\s+the\s+(?:term-bound|temporary)\b/u,
      skills: ["arch-check", "arch-review"],
      why: "`archkeep waivers` names every boundarySuppressions row, permanent suppressions included",
    },
    {
      // WS1-F03 additive: "shows/reports/displays only the waivers".
      re: /(?:shows|reports|displays)\s+only\s+(?:the\s+)?waivers\b[^\n]{0,60}(?:not\s+the|never|absent)/iu,
      skills: ["arch-check", "arch-review"],
      why: "`archkeep waivers` names every boundarySuppressions row, permanent suppressions included",
    },
    {
      // WS1-F10: authoring requires a per-skill version. The negative
      // lookahead keeps the corrected "must not declare metadata.version"
      // green; the `requires` arm catches the reworded claim.
      re: /must\b(?:(?!not\b|never\b|n't\b)[^\n]){0,80}(?:metadata\.version|declare a version)|requires?\b[^\n]{0,40}metadata\.version/iu,
      skills: [],
      why: "the arch-* skills carry no version by decision",
      text: authoring,
      name: "docs/skills/authoring.md",
    },
    {
      // WS1-F10: overview lists `metadata` in the standard frontmatter. The
      // `metadata` must sit INSIDE the same parenthesised list as
      // name/description/compatibility — a sentence that merely names the
      // field to forbid it ("must not contain `metadata`, `context`") stays
      // green.
      re: /\([\s\S]{0,200}?name[\s\S]{0,200}?description[\s\S]{0,200}?metadata[\s\S]{0,200}?compatibility[\s\S]{0,200}?\)/iu,
      skills: [],
      why: "the arch-* skills carry no version by decision",
      text: overview,
      name: "docs/skills/overview.md",
    },
  ];
  for (const { re, skills: owners, why, text, name } of stalePhrases) {
    const haystack = text ?? owners.map((dir) => skillText.get(dir) ?? "").join("\n");
    const owner = name ?? owners.join("/");
    if (re.test(haystack)) {
      failures.push(
        `A skill still teaches a stale mechanism (${owner}): ${why}. ` +
          `Post-#139 the \`adr:\`-prefixed spelling resolves like the bare slug, ` +
          `\`check\` resolves decisionRefs (report-only on a constraint row, exit 3 ` +
          `on an applied intent row), \`archkeep waivers\` names ` +
          `permanent suppressions, and skills carry no version by decision. ` +
          `Correct the skill, not this gate.`,
      );
      lines.push(`FAIL stale-mechanism claim: ${owner}`);
    }
  }

  const change = skillText.get("arch-change") ?? "";
  const checkText = skillText.get("arch-check") ?? "";
  const review = skillText.get("arch-review") ?? "";
  const migrate = skillText.get("arch-migrate") ?? "";
  // arch-migrate is the one skill whose subject is a repository with no
  // declared model, which makes it the one place an agent is most likely to
  // write `architecture-intent.json` and call the job done. The separation it
  // has to teach — Archkeep derives, a human adopts — is the whole reason the
  // `--propose` surfaces refuse to write. A reversion here is silent in the
  // worst direction: the skill would still read as a competent migration
  // protocol while having dropped the sentence that keeps the authority on the
  // human's side, so the gate requires the claim rather than trusting it.
  if (skillText.has("arch-migrate") && !/A proposal is never a decision/u.test(migrate)) {
    failures.push(
      `skills/arch-migrate/SKILL.md must teach that a proposal is never a ` +
        `decision: \`discover --propose\` and \`reconcile --propose\` derive ` +
        `candidates marked proposed/notAuthoritative, and no command writes ` +
        `architecture-intent.json. Without that claim the skill reads as ` +
        `permission to adopt a derived model silently.`,
    );
    lines.push(`FAIL arch-migrate — proposal-is-not-a-decision claim not stated`);
  }
  if (skillText.has("arch-change") && !/both resolve to\s+the same record/u.test(change)) {
    failures.push(
      `skills/arch-change/SKILL.md must teach that the \`adr:\`-prefixed spelling ` +
        `resolves to the same record as the bare slug (audit WS1-F01).`,
    );
    lines.push(`FAIL arch-change — adr: spelling behavior not stated`);
  }
  if (skillText.has("arch-check") && !/resolves each row's `decisionRef`/u.test(checkText)) {
    failures.push(
      `skills/arch-check/SKILL.md must teach that \`check\` resolves each row's ` +
        `decisionRef against the ADR registry (report-only) (audit WS1-F02).`,
    );
    lines.push(`FAIL arch-check — check decisionRef resolution not stated`);
  }
  // The intent half of the same lane, required rather than trusted. The
  // report-only sentence above is true of a `depConstraints` row and false of
  // an applied intent row, where an unresolvable citation withholds the
  // verdict (`../packages/archkeep/cli.mjs`, the `intentUnresolvedDecisionRefRows`
  // fold, pinned over a tree carrying no boundary violation at all). A skill
  // stating only the report-only half reads as a complete account of the
  // mechanism while leaving an agent to call a no-verdict run clean — the
  // silent direction, and the direction this exact claim already drifted once.
  // The claim is matched loosely — either spelling of unresolved, any wording
  // up to the exit code — so a rephrasing that keeps the claim stays green
  // while a deletion goes red. What it does bind is the phrase naming the
  // intent citation, which is the fact a reader must not have to infer.
  if (
    skillText.has("arch-check") &&
    !/(?:unresolvable|unresolved) intent citation[^.\n]{0,80}exit 3/u.test(checkText)
  ) {
    failures.push(
      `skills/arch-check/SKILL.md must teach that an unresolvable intent ` +
        `citation is a no-verdict run (exit 3): a \`depConstraints\` row's ` +
        `decisionRef resolves report-only, but an applied intent row citing an ` +
        `ADR the registry does not know withholds the verdict — a skill ` +
        `teaching only the report-only half leaves an agent reading exit 3 as ` +
        `clean.`,
    );
    lines.push(`FAIL arch-check — intent decisionRef exit-3 lane not stated`);
  }
  if (
    (skillText.has("arch-check") &&
      !/names every\s+`boundarySuppressions`\s+row/u.test(checkText)) ||
    (skillText.has("arch-review") && !/names every row/u.test(review))
  ) {
    failures.push(
      `the skills must teach that \`archkeep waivers\` names every ` +
        `boundarySuppressions row, permanent suppressions included (audit WS1-F03).`,
    );
    lines.push(`FAIL waivers — permanent suppressions claim not stated`);
  }
  if (authoring.includes("metadata:\n  version")) {
    failures.push(
      `docs/skills/authoring.md must not require a \`metadata.version\`: the ` +
        `arch-* skills carry no version by decision, and the gate enforces only ` +
        `the five-file chain (audit WS1-F10).`,
    );
    lines.push(`FAIL authoring.md — per-skill version required`);
  }
  // The overview `metadata` prohibition lives in the stalePhrases entry above
  // (paren-anchored to the standard-frontmatter list), so a corrected "must
  // not contain `metadata`" phrasing stays green while a listing that includes
  // it still fails.

  // 7c. Root package.json version — the "." release-please component that
  // release-please writes directly — must match packages/archkeep/package.json.
  // Every other check below compares a file against `packageVersion` as the
  // baseline, but that baseline was never itself checked against the file
  // release-please actually bumps: a drift there would leave every other
  // check reading "in sync" against a baseline that had already fallen
  // behind, which is silent in exactly the shape this gate exists to refuse.
  if (rootVersion !== packageVersion) {
    failures.push(
      `package.json (root) version is "${rootVersion}" but packages/archkeep/package.json ` +
        `version is "${packageVersion}". release-please bumps the root "." component ` +
        `directly and copies it into packages/archkeep/package.json via extra-files — if ` +
        `the two disagree the version chain has drifted at its source.`,
    );
    lines.push(`FAIL package.json (root) — version mismatch`);
  }

  // 8. Plugin version must match package version
  if (pluginVersion !== packageVersion) {
    failures.push(
      `plugin.json version is "${pluginVersion}" but package version is ` +
        `"${packageVersion}". The plugin manifest must be synchronized with the package.`,
    );
    lines.push(`FAIL plugin.json — version mismatch`);
  }

  // 9. Marketplace entry version must match package version
  if (marketplaceVersion !== packageVersion) {
    failures.push(
      `marketplace.json version is "${marketplaceVersion}" but package version is ` +
        `"${packageVersion}". The marketplace entry must be synchronized with the package.`,
    );
    lines.push(`FAIL marketplace.json — version mismatch`);
  }

  // 10. Codex plugin manifest version must match package version
  if (codexPluginVersion !== packageVersion) {
    failures.push(
      `codex-plugin/plugin.json version is "${codexPluginVersion}" but package version is ` +
        `"${packageVersion}". The Codex plugin manifest must be synchronized with the package.`,
    );
    lines.push(`FAIL codex-plugin/plugin.json — version mismatch`);
  }

  // 11. VS Code extension version must match package version
  if (vscodeVersion !== packageVersion) {
    failures.push(
      `packages/archkeep-vscode/package.json version is "${vscodeVersion}" but package version is ` +
        `"${packageVersion}". The extension is released with the engine it pairs with, ` +
        `so its version must be synchronized with the package.`,
    );
    lines.push(`FAIL archkeep-vscode/package.json — version mismatch`);
  }

  // 12. Rust SDK crate version must match package version. ADR 0002 puts
  // every SDK on the one version chain, so a rule author's "SDK 0.x speaks
  // engine 0.x" is a fact rather than a matrix; this is the gate that holds
  // it, the same way it holds the extension's pairing above.
  if (cargoVersion !== packageVersion) {
    failures.push(
      `packages/archkeep-rule-sdk-rust/Cargo.toml version is "${cargoVersion}" but package ` +
        `version is "${packageVersion}". The Rust SDK versions with the engine it pairs ` +
        `with (docs/adr/0002-custom-rules-one-contract.md), and release-please writes it ` +
        `via extra-files — if the two disagree the chain has drifted.`,
    );
    lines.push(`FAIL archkeep-rule-sdk-rust/Cargo.toml — version mismatch`);
  }

  // 13. TS SDK package version must match package version — the same chain
  // decision as check 12, for the npm-published SDK.
  if (tsSdkVersion !== packageVersion) {
    failures.push(
      `packages/archkeep-rule-sdk-ts/package.json version is "${tsSdkVersion}" but package ` +
        `version is "${packageVersion}". The TS SDK versions with the engine it pairs ` +
        `with (docs/adr/0002-custom-rules-one-contract.md), and release-please writes it ` +
        `via extra-files — if the two disagree the chain has drifted.`,
    );
    lines.push(`FAIL archkeep-rule-sdk-ts/package.json — version mismatch`);
  }

  // 13b. The MCP package's version must match package version. The MCP
  // server composes the engine's own command layer in-process through the
  // `./commands` subpath, so "the MCP face for engine 0.x" has to be a fact
  // rather than a hope — the same one-version pairing the extension and the
  // SDKs ride, held the same way: release-please writes it via extra-files,
  // this check refuses the drift.
  if (mcpVersion !== packageVersion) {
    failures.push(
      `packages/archkeep-mcp/package.json version is "${mcpVersion}" but package version is ` +
        `"${packageVersion}". The MCP server composes the engine's command layer directly, ` +
        `so the two must ship as one version — release-please writes it via extra-files, and ` +
        `if the two disagree the chain has drifted.`,
    );
    lines.push(`FAIL archkeep-mcp/package.json — version mismatch`);
  }

  // 14. Python SDK version must match package version — the same chain
  // decision as checks 12 and 13, for the PyPI-published SDK.
  if (pySdkVersion !== packageVersion) {
    failures.push(
      `packages/archkeep-rule-sdk-python/pyproject.toml version is "${pySdkVersion}" but ` +
        `package version is "${packageVersion}". The Python SDK versions with the engine ` +
        `it pairs with (docs/adr/0002-custom-rules-one-contract.md), and release-please ` +
        `writes it via extra-files — if the two disagree the chain has drifted.`,
    );
    lines.push(`FAIL archkeep-rule-sdk-python/pyproject.toml — version mismatch`);
  }

  // 15. Cargo.lock must record the version Cargo.toml declares. This is the
  // one chain link release-please does NOT write: `extra-files` bumps the
  // manifest and nothing bumps the lock, so the two disagree from the moment
  // a release pull request opens. The release lane's crates.io job then runs
  // `cargo test --locked` and `cargo publish --locked`, both of which refuse
  // a lock that disagrees with its manifest — measured on the 0.10.0 release,
  // which tagged, published to npm, and left crates.io with no 0.10.0 at all.
  // A tag cannot be un-cut, so the failure belongs here, on the pull request,
  // where the fix is still a commit. `cargoLockPackageVersion` says why the
  // lock needs its own parser.
  if (cargoLockVersion !== cargoVersion) {
    failures.push(
      `packages/archkeep-rule-sdk-rust/Cargo.lock records "${cargoLockVersion}" for the ` +
        `${RUST_SDK_CRATE_NAME} crate but Cargo.toml declares "${cargoVersion}". ` +
        `release-please writes the manifest via extra-files and writes no lockfile, so ` +
        `this pair drifts on every version bump — and \`cargo publish --locked\`, which ` +
        `the release lane runs before it uploads, refuses to publish through the drift.`,
    );
    lines.push(`FAIL archkeep-rule-sdk-rust/Cargo.lock — version mismatch`);
  }

  // 16. `.agents/skills` must equal `skills/` byte for byte, every file. It is
  // the checked-in COPY that gives Codex (and every other agent reading the
  // Agent Skills shared project directory) the arch-* skills with no per-user
  // install — the only repo-scoped route Codex has, since its plugin
  // registration and enablement are per user in ~/.codex/config.toml
  // (docs/skills/installation.md). A copy rather than a symlink deliberately:
  // git on Windows without symlink support checks a symlink out as a plain
  // text file, which is a session that silently lost every skill. A copy
  // checks out as files everywhere, and this gate is what keeps it from
  // drifting — the same arrangement the version chain uses for the files
  // release-please copies (docs/skills/versioning.md). The defaults are null
  // rather than empty maps so a caller that forgets to read either tree
  // fails here instead of skipping the check.
  if (agentsSkillsFiles === null || skillsFiles === null) {
    failures.push(
      `${AGENTS_SKILLS_DIR} or ${SKILLS_DIR}/ could not be read. The copy under ` +
        `${AGENTS_SKILLS_DIR} is what hands every Codex session the arch-* skills with ` +
        `no per-user install; unreadable, those sessions start without the skills and ` +
        `say nothing.`,
    );
    lines.push(`FAIL ${AGENTS_SKILLS_DIR} — unreadable`);
  } else {
    const drift = [];
    for (const path of Object.keys(skillsFiles)) {
      if (!(path in agentsSkillsFiles)) drift.push(`missing ${AGENTS_SKILLS_DIR}/${path}`);
      else if (agentsSkillsFiles[path] !== skillsFiles[path])
        drift.push(`differs ${AGENTS_SKILLS_DIR}/${path}`);
    }
    for (const path of Object.keys(agentsSkillsFiles)) {
      if (!(path in skillsFiles)) drift.push(`extra ${AGENTS_SKILLS_DIR}/${path}`);
    }
    if (Object.keys(skillsFiles).length === 0) drift.push(`${SKILLS_DIR}/ read as empty`);

    if (drift.length > 0) {
      failures.push(
        `${AGENTS_SKILLS_DIR} has drifted from ${SKILLS_DIR}/: ${drift.join("; ")}. ` +
          `It is the copy that hands every Codex session the arch-* skills with no ` +
          `per-user install, and an edit that lands in one tree only reaches some ` +
          `agents and not others, silently. Re-copy with: rm -rf ${AGENTS_SKILLS_DIR} ` +
          `&& mkdir ${AGENTS_SKILLS_DIR} && cp -r ${SKILLS_DIR}/* ${AGENTS_SKILLS_DIR}/`,
      );
      lines.push(`FAIL ${AGENTS_SKILLS_DIR} — drifted from ${SKILLS_DIR}/`);
    } else {
      lines.push(
        `ok   ${AGENTS_SKILLS_DIR} == ${SKILLS_DIR} (${Object.keys(skillsFiles).length} files)`,
      );
    }
  }

  // 17. Every markdown link in a SKILL.md must be an absolute `https://` URL,
  // and one into this repository must name a path the tracked tree actually
  // has. A skill is a host-independent protocol MEANT to be vendored — copied
  // into a consumer's own skills directory, installed by `npx skills add`,
  // read from `.agents/skills/` one directory deeper than the canonical tree.
  // A repo-relative target survives every one of those moves as valid markdown
  // and resolves against a stranger's tree: it does not 404, it lands on some
  // other file or on nothing, and a link that points at the wrong page reads as
  // authoritative while being wrong. That is worse than a broken one, and no
  // gate saw it — `check-docs-links.mjs` resolves such a target from
  // `skills/<name>/`, where it is correct, and so passes it.
  //
  // The existence half is what keeps the absolute form honest. Going absolute
  // normally trades vendoring-correctness for rename detection: a doc renamed
  // on main leaves a dead URL in a shipped skill, and nothing in the tree
  // disagrees with it. Resolving the path after the blob prefix buys that back
  // — the rename turns this gate red on the pull request that performs it.
  const tracked = trackedFiles === null ? null : new Set(trackedFiles);
  for (const skill of skills) {
    for (const { line, target } of skillLinkTargets(skill.text ?? "")) {
      // An in-file `#anchor` is exempt, and the exemption is the rule stated
      // accurately rather than a hole in it. What this check refuses is a
      // target that RESOLVES SOMEWHERE ELSE once the skill is vendored; an
      // anchor into the skill's own body travels with it and cannot. Writing
      // such a link as an absolute URL would be the worse spelling — it would
      // send a reader out of the file they are already in, to GitHub, to reach
      // a heading two lines down. `check-docs-links.mjs` scans `skills/` and
      // already refuses an anchor naming no heading in its own file, so this
      // arm gives up no coverage either.
      if (target.startsWith("#")) continue;
      if (!target.startsWith("https://")) {
        failures.push(
          `${SKILLS_DIR}/${skill.dir}/SKILL.md:${line} links to "${target}", which is not an ` +
            `absolute https:// URL. The skills are vendored into trees this repository does ` +
            `not control, where a repo-relative target still renders as a link and resolves ` +
            `against whatever happens to sit there. Write it as ${REPO_BLOB_PREFIX}<path>.`,
        );
        lines.push(`FAIL ${skill.dir} — non-absolute link at line ${line}: ${target}`);
        continue;
      }
      if (!target.startsWith(REPO_BLOB_PREFIX)) continue;
      const path = target.slice(REPO_BLOB_PREFIX.length).split("#")[0].split("?")[0];
      if (tracked === null) {
        failures.push(
          `${SKILLS_DIR}/${skill.dir}/SKILL.md:${line} links to "${target}", but the tracked ` +
            `file list could not be read, so the path it names was never resolved. An ` +
            `unverified link into this repository is the shape this check exists to refuse.`,
        );
        lines.push(`FAIL ${skill.dir} — link unverifiable at line ${line}: ${target}`);
        continue;
      }
      if (!tracked.has(path)) {
        failures.push(
          `${SKILLS_DIR}/${skill.dir}/SKILL.md:${line} links to "${target}", but "${path}" is ` +
            `not a tracked file. An absolute URL cannot be caught by a rename the way a ` +
            `relative one is, so it is resolved here instead — fix the link, or restore the ` +
            `page it names.`,
        );
        lines.push(`FAIL ${skill.dir} — link target missing at line ${line}: ${path}`);
      }
    }
  }

  return { lines, failures };
}

/**
 * Reads the filesystem and returns the facts `evaluate` needs.
 * This is the only function that touches the outside world.
 *
 * @returns {{skillDirs: string[], packageVersion: string, rootVersion: string, pluginVersion: string, marketplaceVersion: string, codexPluginVersion: string, vscodeVersion: string, cargoVersion: string, cargoLockVersion: string, tsSdkVersion: string, mcpVersion: string, pySdkVersion: string, skills: object[], agentsSkillsFiles: Record<string, string>|null, skillsFiles: Record<string, string>|null, trackedFiles: string[]|null, authoring: string, overview: string}}
 */
export function readSkillFacts() {
  const pkgPath = join(root, PACKAGE_JSON);
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : { version: "?" };
  const packageVersion = pkg.version;

  const rootPkgPath = join(root, ROOT_PACKAGE_JSON);
  const rootPkg = existsSync(rootPkgPath)
    ? JSON.parse(readFileSync(rootPkgPath, "utf8"))
    : { version: "?" };
  const rootVersion = rootPkg.version;

  const manifestPath = join(root, CLAUDE_PLUGIN_MANIFEST);
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : { version: "?" };
  const pluginVersion = manifest.version;

  const cataloguePath = join(root, MARKETPLACE_CATALOGUE);
  const catalogue = existsSync(cataloguePath)
    ? JSON.parse(readFileSync(cataloguePath, "utf8"))
    : { plugins: [] };
  const marketplaceVersion = selectMarketplaceVersion(catalogue, MARKETPLACE_PLUGIN_NAME);

  const codexPath = join(root, CODEX_PLUGIN_MANIFEST);
  const codex = existsSync(codexPath)
    ? JSON.parse(readFileSync(codexPath, "utf8"))
    : { version: "?" };
  const codexPluginVersion = codex.version;

  const vscodePath = join(root, VSCODE_PACKAGE_JSON);
  const vscode = existsSync(vscodePath)
    ? JSON.parse(readFileSync(vscodePath, "utf8"))
    : { version: "?" };
  const vscodeVersion = vscode.version;

  const cargoPath = join(root, RUST_SDK_CARGO_TOML);
  const cargoVersion = existsSync(cargoPath)
    ? tomlSectionVersion(readFileSync(cargoPath, "utf8"), "[package]")
    : "?";

  const cargoLockPath = join(root, RUST_SDK_CARGO_LOCK);
  const cargoLockVersion = existsSync(cargoLockPath)
    ? cargoLockPackageVersion(readFileSync(cargoLockPath, "utf8"), RUST_SDK_CRATE_NAME)
    : "?";

  const tsSdkPath = join(root, TS_SDK_PACKAGE_JSON);
  const tsSdk = existsSync(tsSdkPath)
    ? JSON.parse(readFileSync(tsSdkPath, "utf8"))
    : { version: "?" };
  const tsSdkVersion = tsSdk.version;

  const mcpPath = join(root, MCP_PACKAGE_JSON);
  const mcp = existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, "utf8")) : { version: "?" };
  const mcpVersion = mcp.version;

  const pyprojectPath = join(root, PYTHON_SDK_PYPROJECT);
  const pySdkVersion = existsSync(pyprojectPath)
    ? tomlSectionVersion(readFileSync(pyprojectPath, "utf8"), "[project]")
    : "?";

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
        compatibility: null,
        hostFields: [],
      };
    }
    const text = readFileSync(skillPath, "utf8");
    const fm = parseSkillFrontmatter(text);

    const hostFields = findHostSpecificFields(fm ?? {});

    return {
      dir,
      name: fm?.name ?? null,
      description: fm?.description ?? null,
      compatibility: fm?.compatibility ?? null,
      hostFields,
      text,
    };
  });

  // Every file under a directory, relative path to content — recursive, so a
  // helper file a skill grows later is compared too, not just SKILL.md. null
  // (not an empty map) when the directory cannot be read, which `evaluate`
  // fails loudly rather than skipping.
  const readTree = (/** @type {string} */ dir) => {
    try {
      /** @type {Record<string, string>} */
      const files = {};
      const walk = (/** @type {string} */ rel) => {
        for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
          const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) walk(relPath);
          else files[relPath] = readFileSync(join(dir, relPath), "utf8");
        }
      };
      walk("");
      return files;
    } catch {
      return null;
    }
  };
  const agentsSkillsFiles = readTree(join(root, AGENTS_SKILLS_DIR));
  const skillsFiles = readTree(skillsDir);

  // The tracked paths check 17 resolves a skill's repo links against. `git
  // ls-files` is where "tracked" is defined, the same source `check-docs-links.mjs`
  // reads it from. A failed call yields null, not an empty list: null fails every
  // repo link loudly, while an empty list would too but by claiming the tree has
  // no files at all — the argument is worth stating once, so the failure names
  // the unreadable list rather than thirteen missing pages.
  const ls = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  const trackedFiles = ls.status === 0 ? ls.stdout.split("\n").filter((path) => path !== "") : null;

  const readDoc = (relPath) =>
    existsSync(join(root, relPath)) ? readFileSync(join(root, relPath), "utf8") : "";

  return {
    skillDirs,
    packageVersion,
    rootVersion,
    pluginVersion,
    marketplaceVersion,
    codexPluginVersion,
    vscodeVersion,
    cargoVersion,
    cargoLockVersion,
    tsSdkVersion,
    mcpVersion,
    pySdkVersion,
    skills,
    agentsSkillsFiles,
    skillsFiles,
    trackedFiles,
    authoring: readDoc("docs/skills/authoring.md"),
    overview: readDoc("docs/skills/overview.md"),
  };
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

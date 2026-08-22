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
// The version it checks against comes from `packages/lattice/package.json` —
// the baseline docs/skills/versioning.md calls the source of truth. The Claude
// Code plugin manifest version, the marketplace entry version, the Codex
// plugin manifest version, and the VS Code extension's package.json version
// must all match it — and so must the repository ROOT `package.json`, which
// is what release-please's "." component actually bumps directly; the other
// seven (this baseline included) are copies of it via `extra-files` — the
// Rust SDK's Cargo.toml and the TS SDK's package.json joined the chain with
// their packages, per the ADR 0002 decision that every SDK versions with the
// engine it pairs with. Checking
// every copy against a baseline that was never itself checked against the
// thing it copies from is the gap this script closes: a drift there would
// have read as "everything agrees" right up to the file nothing compared.
// Skills themselves carry no version by decision — a consumer's installed
// skills pair with the engine they ship beside, so the version that matters
// is the plugin's, not a per-skill one (docs/skills/versioning.md).

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
export const PACKAGE_JSON = "packages/lattice/package.json";
export const ROOT_PACKAGE_JSON = "package.json";
export const CLAUDE_PLUGIN_MANIFEST = ".claude-plugin/plugin.json";
export const MARKETPLACE_CATALOGUE = ".claude-plugin/marketplace.json";
export const MARKETPLACE_PLUGIN_NAME = "lattice";
export const CODEX_PLUGIN_MANIFEST = ".codex-plugin/plugin.json";
export const VSCODE_PACKAGE_JSON = "packages/lattice-vscode/package.json";
export const RUST_SDK_CARGO_TOML = "packages/lattice-rule-sdk-rust/Cargo.toml";
export const TS_SDK_PACKAGE_JSON = "packages/lattice-rule-sdk-ts/package.json";
export const PYTHON_SDK_PYPROJECT = "packages/lattice-rule-sdk-python/pyproject.toml";

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
 * The version of a marketplace catalogue's matching plugin entry, selected by
 * name/identity rather than array position. `.claude-plugin/marketplace.json`
 * is a catalogue and `plugins` is a list this repository controls today, but
 * nothing stops it growing a second entry — a decoy plugin prepended ahead of
 * `lattice` would leave the real entry unchecked by a positional read while
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
 * @param {string} input.packageVersion version from packages/lattice/package.json
 * @param {string} input.rootVersion version from the repository root package.json — the
 *   release-please "." component release-please writes directly; the other four files
 *   (including packages/lattice/package.json) are copies of it via `extra-files`
 * @param {string} input.pluginVersion version from the Claude Code plugin manifest
 * @param {string} input.marketplaceVersion version from the marketplace.json entry
 * @param {string} input.codexPluginVersion version from the Codex plugin manifest
 * @param {string} input.vscodeVersion version from packages/lattice-vscode/package.json
 * @param {string} input.cargoVersion version from the Rust SDK's Cargo.toml `[package]` section
 * @param {string} input.tsSdkVersion version from the TS SDK's package.json
 * @param {string} input.pySdkVersion version from the Python SDK's pyproject.toml `[project]` section
 * @param {{dir: string, name: string|null, description: string|null, compatibility: string|null, hostFields: string[], text?: string}[]} input.skills
 *   parsed frontmatter plus the full SKILL.md text for each skill
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
  tsSdkVersion,
  pySdkVersion,
  skills,
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

    // 6. compatibility field should mention lattice
    if (skill.compatibility !== null && !skill.compatibility.toLowerCase().includes("lattice")) {
      lines.push(`note ${skill.dir} — compatibility does not mention lattice`);
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
      why: "`check` resolves each row's decisionRef against the ADR registry (report-only)",
    },
    {
      // WS1-F03: `waivers` names/lists only the term-bound rows.
      re: /(?:names|lists)\s+only\s+the\s+(?:term-bound|temporary)\b/u,
      skills: ["arch-check", "arch-review"],
      why: "`lattice waivers` names every boundarySuppressions row, permanent suppressions included",
    },
    {
      // WS1-F03 additive: "shows/reports/displays only the waivers".
      re: /(?:shows|reports|displays)\s+only\s+(?:the\s+)?waivers\b[^\n]{0,60}(?:not\s+the|never|absent)/iu,
      skills: ["arch-check", "arch-review"],
      why: "`lattice waivers` names every boundarySuppressions row, permanent suppressions included",
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
          `\`check\` resolves decisionRefs report-only, \`lattice waivers\` names ` +
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
  // has to teach — Lattice derives, a human adopts — is the whole reason the
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
  if (
    (skillText.has("arch-check") &&
      !/names every\s+`boundarySuppressions`\s+row/u.test(checkText)) ||
    (skillText.has("arch-review") && !/names every row/u.test(review))
  ) {
    failures.push(
      `the skills must teach that \`lattice waivers\` names every ` +
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
  // release-please writes directly — must match packages/lattice/package.json.
  // Every other check below compares a file against `packageVersion` as the
  // baseline, but that baseline was never itself checked against the file
  // release-please actually bumps: a drift there would leave every other
  // check reading "in sync" against a baseline that had already fallen
  // behind, which is silent in exactly the shape this gate exists to refuse.
  if (rootVersion !== packageVersion) {
    failures.push(
      `package.json (root) version is "${rootVersion}" but packages/lattice/package.json ` +
        `version is "${packageVersion}". release-please bumps the root "." component ` +
        `directly and copies it into packages/lattice/package.json via extra-files — if ` +
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
      `packages/lattice-vscode/package.json version is "${vscodeVersion}" but package version is ` +
        `"${packageVersion}". The extension is released with the engine it pairs with, ` +
        `so its version must be synchronized with the package.`,
    );
    lines.push(`FAIL lattice-vscode/package.json — version mismatch`);
  }

  // 12. Rust SDK crate version must match package version. ADR 0002 puts
  // every SDK on the one version chain, so a rule author's "SDK 0.x speaks
  // engine 0.x" is a fact rather than a matrix; this is the gate that holds
  // it, the same way it holds the extension's pairing above.
  if (cargoVersion !== packageVersion) {
    failures.push(
      `packages/lattice-rule-sdk-rust/Cargo.toml version is "${cargoVersion}" but package ` +
        `version is "${packageVersion}". The Rust SDK versions with the engine it pairs ` +
        `with (docs/adr/0002-custom-rules-one-contract.md), and release-please writes it ` +
        `via extra-files — if the two disagree the chain has drifted.`,
    );
    lines.push(`FAIL lattice-rule-sdk-rust/Cargo.toml — version mismatch`);
  }

  // 13. TS SDK package version must match package version — the same chain
  // decision as check 12, for the npm-published SDK.
  if (tsSdkVersion !== packageVersion) {
    failures.push(
      `packages/lattice-rule-sdk-ts/package.json version is "${tsSdkVersion}" but package ` +
        `version is "${packageVersion}". The TS SDK versions with the engine it pairs ` +
        `with (docs/adr/0002-custom-rules-one-contract.md), and release-please writes it ` +
        `via extra-files — if the two disagree the chain has drifted.`,
    );
    lines.push(`FAIL lattice-rule-sdk-ts/package.json — version mismatch`);
  }

  // 14. Python SDK version must match package version — the same chain
  // decision as checks 12 and 13, for the PyPI-published SDK.
  if (pySdkVersion !== packageVersion) {
    failures.push(
      `packages/lattice-rule-sdk-python/pyproject.toml version is "${pySdkVersion}" but ` +
        `package version is "${packageVersion}". The Python SDK versions with the engine ` +
        `it pairs with (docs/adr/0002-custom-rules-one-contract.md), and release-please ` +
        `writes it via extra-files — if the two disagree the chain has drifted.`,
    );
    lines.push(`FAIL lattice-rule-sdk-python/pyproject.toml — version mismatch`);
  }

  return { lines, failures };
}

/**
 * Reads the filesystem and returns the facts `evaluate` needs.
 * This is the only function that touches the outside world.
 *
 * @returns {{skillDirs: string[], packageVersion: string, rootVersion: string, pluginVersion: string, marketplaceVersion: string, codexPluginVersion: string, vscodeVersion: string, cargoVersion: string, tsSdkVersion: string, pySdkVersion: string, skills: object[], authoring: string, overview: string}}
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

  const tsSdkPath = join(root, TS_SDK_PACKAGE_JSON);
  const tsSdk = existsSync(tsSdkPath)
    ? JSON.parse(readFileSync(tsSdkPath, "utf8"))
    : { version: "?" };
  const tsSdkVersion = tsSdk.version;

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

    const hostFields = Object.keys(fm ?? {}).filter((k) => HOST_SPECIFIC_FIELDS.includes(k));

    return {
      dir,
      name: fm?.name ?? null,
      description: fm?.description ?? null,
      compatibility: fm?.compatibility ?? null,
      hostFields,
      text,
    };
  });

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
    tsSdkVersion,
    pySdkVersion,
    skills,
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

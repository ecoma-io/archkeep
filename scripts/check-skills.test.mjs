import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  tomlSectionVersion,
  evaluate,
  EXPECTED_SKILLS,
  parseSkillFrontmatter,
  selectMarketplaceVersion,
} from "./check-skills.mjs";

describe("selectMarketplaceVersion", () => {
  it("picks the entry by name, not array position", () => {
    // A positional read (`catalogue.plugins[0]`) is correct only as long as
    // `lattice` happens to be first — a second plugin prepended to the
    // catalogue would leave the real entry unchecked while a positional read
    // silently validates the decoy's version instead.
    const catalogue = {
      plugins: [
        { name: "decoy", version: "9.9.9" },
        { name: "lattice", version: "0.7.1" },
      ],
    };
    assert.equal(selectMarketplaceVersion(catalogue, "lattice"), "0.7.1");
  });

  it("returns '?' when no entry matches the plugin name", () => {
    const catalogue = { plugins: [{ name: "decoy", version: "9.9.9" }] };
    assert.equal(selectMarketplaceVersion(catalogue, "lattice"), "?");
  });

  it("returns '?' when the catalogue has no plugins list", () => {
    assert.equal(selectMarketplaceVersion({}, "lattice"), "?");
  });
});

describe("tomlSectionVersion", () => {
  it("reads the [package] section's version", () => {
    const toml = '[package]\nname = "lattice-rule-sdk"\nversion = "0.9.0"\nedition = "2024"\n';
    assert.equal(tomlSectionVersion(toml, "[package]"), "0.9.0");
  });

  it("never reads a dependency's pinned version as the crate's own", () => {
    // The silent direction for this parser: a bare `version = "…"` match
    // would hit the first pin under [dependencies] when [package] carries
    // none, and the chain gate would then compare the wrong number and
    // read "in sync" off a serde pin.
    const toml = '[dependencies]\nserde = { version = "1.0.219" }\nversion = "9.9.9"\n';
    assert.equal(tomlSectionVersion(toml, "[package]"), "?");
  });

  it("reads pyproject's [project] section the same way", () => {
    const toml =
      '[project]\nname = "lattice-rule-sdk"\nversion = "0.9.0"\n[tool.x]\nversion = "9.9.9"\n';
    assert.equal(tomlSectionVersion(toml, "[project]"), "0.9.0");
  });

  it("returns '?' when [package] carries no version line", () => {
    assert.equal(tomlSectionVersion('[package]\nname = "x"\n[dependencies]\n', "[package]"), "?");
  });
});

describe("parseSkillFrontmatter", () => {
  it("parses valid frontmatter with all fields", () => {
    const text = `---
name: arch-context
description: Understand architecture boundaries
compatibility: Requires lattice CLI
---
Body text here`;

    const fm = parseSkillFrontmatter(text);
    assert.ok(fm);
    assert.equal(fm.name, "arch-context");
    assert.equal(fm.description, "Understand architecture boundaries");
    assert.equal(fm.compatibility, "Requires lattice CLI");
  });

  it("parses frontmatter with single-quoted values", () => {
    const text = `---
name: 'arch-check'
description: 'Validate after changes'
---
Body`;

    const fm = parseSkillFrontmatter(text);
    assert.ok(fm);
    assert.equal(fm.name, "arch-check");
    assert.equal(fm.description, "Validate after changes");
  });

  it("returns null when no frontmatter delimiters found", () => {
    assert.equal(parseSkillFrontmatter("no frontmatter here"), null);
  });

  it("returns null when only one delimiter found", () => {
    assert.equal(parseSkillFrontmatter("---\nname: foo"), null);
  });

  it("skips comment lines in frontmatter", () => {
    const text = `---
# this is a comment
name: arch-review
description: Review a change
---
Body`;

    const fm = parseSkillFrontmatter(text);
    assert.ok(fm);
    assert.equal(fm.name, "arch-review");
    assert.equal(fm.description, "Review a change");
  });
});

describe("evaluate", () => {
  const goodSkill = (dir, name) => ({
    dir,
    name,
    description: `Skill ${name}`,
    compatibility: "Requires @ecoma-io/lattice CLI",
    hostFields: [],
    text: "",
  });

  // The corrected mechanism sentences the doc-truth gate requires (audit
  // WS1-F01/F02/F03). `allGood` carries them so the baseline fixtures
  // exercise the require-half of the gate, and each regression test below
  // reverts one to prove the fail-half is loud.
  const correctedText = (dir) => {
    const byDir = {
      "arch-change":
        "The `decisionRef` literal names a record by its bare `NNN-slug` id — and " +
        "`adr:NNN-slug` is that same record written with the `adr:` prefix, the " +
        "alternate spelling the registry normalises before lookup: both resolve to " +
        "the same record.",
      "arch-check":
        "`check` resolves each row's `decisionRef` against the ADR registry " +
        "(report-only — the resolution changes no byte of the verdict) and names an " +
        "unresolved one inline and under `result.unresolvedDecisionRefs`. " +
        "`lattice waivers` names every `boundarySuppressions` row — a waiver with " +
        "its term, a permanent suppression with what it is hiding.",
      "arch-review":
        "`lattice waivers` names every row — a waiver with its term, a permanent " +
        "suppression with what it is hiding.",
      "arch-migrate":
        "A proposal is never a decision. `discover --propose` and " +
        "`reconcile --propose` derive candidates marked proposed / " +
        "notAuthoritative, and no command writes architecture-intent.json.",
    };
    return byDir[dir] ?? "";
  };

  const allGood = () =>
    EXPECTED_SKILLS.map((s) => ({ ...goodSkill(s, s), text: correctedText(s) }));

  const baseFacts = {
    skillDirs: [...EXPECTED_SKILLS],
    packageVersion: "0.4.0",
    rootVersion: "0.4.0",
    pluginVersion: "0.4.0",
    marketplaceVersion: "0.4.0",
    codexPluginVersion: "0.4.0",
    vscodeVersion: "0.4.0",
    cargoVersion: "0.4.0",
    tsSdkVersion: "0.4.0",
    pySdkVersion: "0.4.0",
  };

  it("passes when all skills are present, named correctly, and versions match", () => {
    const result = evaluate({
      ...baseFacts,
      skills: allGood(),
    });
    assert.equal(result.failures.length, 0);
    assert.ok(result.lines.some((l) => l.startsWith("ok")));
  });

  it("fails when an expected skill directory is missing", () => {
    const result = evaluate({
      ...baseFacts,
      skillDirs: ["arch-context"],
      skills: [goodSkill("arch-context", "arch-context")],
    });
    assert.ok(result.failures.length > 0);
    assert.ok(
      result.failures.some((f) => f.includes("arch-check") && f.includes("does not exist")),
    );
  });

  it("fails when skill name does not match directory name", () => {
    const skills = allGood();
    skills[0] = goodSkill("arch-context", "wrong-name");
    const result = evaluate({
      ...baseFacts,
      skills,
    });
    assert.ok(result.failures.some((f) => f.includes("must match its directory name")));
  });

  it("fails when skill has no name", () => {
    const skills = allGood();
    skills[0] = {
      dir: "arch-context",
      name: null,
      description: "x",
      compatibility: "lattice",
      hostFields: [],
      text: correctedText("arch-context"),
    };
    const result = evaluate({
      ...baseFacts,
      skills,
    });
    assert.ok(result.failures.some((f) => f.includes("no `name`")));
  });

  it("fails when skill has no description", () => {
    const skills = allGood();
    skills[0] = {
      dir: "arch-context",
      name: "arch-context",
      description: null,
      compatibility: "lattice",
      hostFields: [],
      text: correctedText("arch-context"),
    };
    const result = evaluate({
      ...baseFacts,
      skills,
    });
    assert.ok(result.failures.some((f) => f.includes("no `description`")));
  });

  it("fails when skill has host-specific frontmatter fields", () => {
    const skills = allGood();
    skills[0] = { ...goodSkill("arch-context", "arch-context"), hostFields: ["context", "model"] };
    const result = evaluate({
      ...baseFacts,
      skills,
    });
    assert.ok(result.failures.some((f) => f.includes("host-specific")));
  });

  it("fails when the root package.json version disagrees with packages/lattice/package.json", () => {
    // release-please bumps the root "." component directly; every other
    // check compares a file against `packageVersion` as the baseline, but
    // without this check that baseline itself was never verified against the
    // thing release-please actually writes — a drift here read as "every
    // file agrees" while the source had already moved.
    const result = evaluate({
      ...baseFacts,
      rootVersion: "1.0.1",
      skills: allGood(),
    });
    assert.ok(
      result.failures.some((f) => f.includes("package.json (root)") && f.includes("1.0.1")),
    );
  });

  it("fails when plugin version does not match package version", () => {
    const result = evaluate({
      ...baseFacts,
      pluginVersion: "1.0.1",
      skills: allGood(),
    });
    assert.ok(result.failures.some((f) => f.includes("plugin.json") && f.includes("1.0.1")));
  });

  it("fails when marketplace version does not match package version", () => {
    const result = evaluate({
      ...baseFacts,
      marketplaceVersion: "1.0.1",
      skills: allGood(),
    });
    assert.ok(result.failures.some((f) => f.includes("marketplace.json") && f.includes("1.0.1")));
  });

  it("fails when codex plugin version does not match package version", () => {
    const result = evaluate({
      ...baseFacts,
      codexPluginVersion: "1.0.1",
      skills: allGood(),
    });
    assert.ok(result.failures.some((f) => f.includes("codex") && f.includes("1.0.1")));
  });

  it("fails when vscode package version does not match package version", () => {
    const result = evaluate({
      ...baseFacts,
      vscodeVersion: "1.0.1",
      skills: allGood(),
    });
    assert.ok(result.failures.some((f) => f.includes("lattice-vscode") && f.includes("1.0.1")));
  });

  it("fails when the Rust SDK crate version does not match package version", () => {
    const result = evaluate({
      ...baseFacts,
      cargoVersion: "1.0.1",
      skills: allGood(),
    });
    assert.ok(
      result.failures.some((f) => f.includes("lattice-rule-sdk-rust") && f.includes("1.0.1")),
    );
  });

  it("fails when the Python SDK version does not match package version", () => {
    const result = evaluate({
      ...baseFacts,
      pySdkVersion: "1.0.1",
      skills: allGood(),
    });
    assert.ok(
      result.failures.some((f) => f.includes("lattice-rule-sdk-python") && f.includes("1.0.1")),
    );
  });

  it("fails when the TS SDK package version does not match package version", () => {
    const result = evaluate({
      ...baseFacts,
      tsSdkVersion: "1.0.1",
      skills: allGood(),
    });
    assert.ok(
      result.failures.some((f) => f.includes("lattice-rule-sdk-ts") && f.includes("1.0.1")),
    );
  });

  // The doc-truth corrections (audit WS1-F01/F02/F03/F10). These pin the
  // SILENT direction: a stale mechanism claim in a skill sits identical to an
  // absent one, so the gate fails when the corrected text is ever reverted.
  it("passes when the skills teach the post-#139 mechanisms", () => {
    const result = evaluate({
      ...baseFacts,
      skills: allGood(),
      authoring: "Every SKILL.md must begin with name, description, compatibility.",
      overview: "The standard frontmatter (name, description, compatibility)",
    });
    assert.equal(result.failures.length, 0);
  });

  it("fails when a skill still teaches the stale adr:-prefix behavior", () => {
    const skills = allGood().map((s) => ({
      ...s,
      text:
        s.dir === "arch-change"
          ? "anything else falls to the reverse-lookup arm and reads as a false not enforced exit 0"
          : correctedText(s.dir),
    }));
    const result = evaluate({ ...baseFacts, skills });
    assert.ok(result.failures.some((f) => f.includes("stale mechanism")));
  });

  it("fails when arch-check still says check does not resolve a decisionRef", () => {
    const skills = allGood().map((s) => ({
      ...s,
      text:
        s.dir === "arch-check"
          ? "check validates a decisionRef's shape but does not resolve it, so an ADR id"
          : correctedText(s.dir),
    }));
    const result = evaluate({ ...baseFacts, skills });
    assert.ok(result.failures.some((f) => f.includes("stale mechanism")));
  });

  // Reworded stale claims — each keeps the corrected positive sentence AND
  // contradicts it. The gate must fail: a stale sentence that reads clean
  // sits identical to an absent one.
  it("fails on a reworded stale adr:-prefix claim that keeps the positive sentence", () => {
    const skills = allGood().map((s) => ({
      ...s,
      text:
        s.dir === "arch-change"
          ? correctedText(s.dir) +
            " Although an adr:0001-unknown id reads as a clean not-enforced exit 0 through the reverse-lookup branch."
          : correctedText(s.dir),
    }));
    const result = evaluate({ ...baseFacts, skills });
    assert.ok(result.failures.some((f) => f.includes("stale mechanism")));
  });

  it("fails on a reworded check-does-not-resolve claim that keeps the positive sentence", () => {
    const skills = allGood().map((s) => ({
      ...s,
      text:
        s.dir === "arch-check"
          ? correctedText(s.dir) +
            " although really the check does NOT resolve them, it only checks the shape."
          : correctedText(s.dir),
    }));
    const result = evaluate({ ...baseFacts, skills });
    assert.ok(result.failures.some((f) => f.includes("stale mechanism")));
  });

  it("fails on a reworded waivers-lists-only claim that keeps the positive sentence", () => {
    const skills = allGood().map((s) => ({
      ...s,
      text:
        s.dir === "arch-check"
          ? correctedText(s.dir) + " but it lists only the temporary ones with a term."
          : correctedText(s.dir),
    }));
    const result = evaluate({ ...baseFacts, skills });
    assert.ok(result.failures.some((f) => f.includes("stale mechanism")));
  });

  // Reworded slips the first stale-phrase pass let through (B1-B5). Each keeps
  // the corrected positive sentence and adds a stale claim in a new shape; the
  // gate must fail — a stale sentence that reads clean sits identical to an
  // absent one.
  it("fails when arch-change says an adr: id is treated as a reverse lookup with a clean sentence", () => {
    const skills = allGood().map((s) => ({
      ...s,
      text:
        s.dir === "arch-change"
          ? correctedText(s.dir) +
            " An adr:0001-unknown id is treated as a reverse lookup with a clean sentence."
          : correctedText(s.dir),
    }));
    const result = evaluate({ ...baseFacts, skills });
    assert.ok(result.failures.some((f) => f.includes("stale mechanism")));
  });

  it("fails when arch-check says check never resolves a decisionRef", () => {
    const skills = allGood().map((s) => ({
      ...s,
      text:
        s.dir === "arch-check"
          ? correctedText(s.dir) + " check never resolves a decisionRef at all."
          : correctedText(s.dir),
    }));
    const result = evaluate({ ...baseFacts, skills });
    assert.ok(result.failures.some((f) => f.includes("stale mechanism")));
  });

  it("fails when arch-check says waivers shows only the waivers, not the permanent suppressions", () => {
    const skills = allGood().map((s) => ({
      ...s,
      text:
        s.dir === "arch-check"
          ? correctedText(s.dir) +
            " waivers shows only the waivers, not the permanent suppressions."
          : correctedText(s.dir),
    }));
    const result = evaluate({ ...baseFacts, skills });
    assert.ok(result.failures.some((f) => f.includes("stale mechanism")));
  });

  it("fails when authoring.md says every SKILL.md requires a metadata.version", () => {
    const result = evaluate({
      ...baseFacts,
      skills: allGood(),
      authoring: "Every SKILL.md requires a metadata.version",
    });
    assert.ok(result.failures.some((f) => f.includes("stale mechanism")));
  });

  it("fails when overview.md lists metadata and compatibility in the standard frontmatter", () => {
    const result = evaluate({
      ...baseFacts,
      skills: allGood(),
      overview: "standard frontmatter (name, description, metadata and compatibility)",
    });
    assert.ok(result.failures.some((f) => f.includes("stale mechanism")));
  });

  // The no-false-positive half: the natural phrasings a maintainer writes to
  // document the CORRECTED behavior must stay green.
  it("allows the natural corrected phrasings (a decisionRef that does not resolve; must not declare metadata.version)", () => {
    const skills = allGood().map((s) => ({
      ...s,
      text:
        s.dir === "arch-check"
          ? correctedText(s.dir) +
            " A decisionRef that does not resolve is named inline as UNRESOLVED."
          : correctedText(s.dir),
    }));
    const result = evaluate({
      ...baseFacts,
      skills,
      authoring: "A skill must not declare metadata.version.",
      overview: "A skill must not contain `metadata`, `context` fields.",
    });
    assert.equal(result.failures.length, 0);
  });

  it("allows the pronoun-based corrected phrasing (check names an unresolved citation; it does not resolve to a verdict)", () => {
    const skills = allGood().map((s) => ({
      ...s,
      text:
        s.dir === "arch-check"
          ? correctedText(s.dir) +
            " check names an unresolved citation; it does not resolve to a verdict."
          : correctedText(s.dir),
    }));
    const result = evaluate({ ...baseFacts, skills });
    assert.equal(result.failures.length, 0);
  });

  it("fails when a skill still says waivers lists only the term-bound rows", () => {
    const skills = allGood().map((s) => ({
      ...s,
      text:
        s.dir === "arch-review"
          ? "lattice waivers lists only the term-bound rows (a permanent suppression is absent)"
          : correctedText(s.dir),
    }));
    const result = evaluate({ ...baseFacts, skills });
    assert.ok(result.failures.some((f) => f.includes("stale mechanism")));
  });

  it("fails when a skill omits the corrected mechanism sentence", () => {
    const skills = allGood().map((s) =>
      s.dir === "arch-change" ? { ...s, text: "no decisionRef behavior mentioned at all" } : s,
    );
    const result = evaluate({ ...baseFacts, skills });
    assert.ok(result.failures.some((f) => f.includes("WS1-F01")));
  });

  // arch-migrate's silent direction: a migration skill that has dropped the
  // proposal-is-not-a-decision claim still reads as a complete protocol, which
  // is exactly why an absent claim has to be as loud as a wrong one.
  it("fails when arch-migrate omits the proposal-is-not-a-decision claim", () => {
    const skills = allGood().map((s) =>
      s.dir === "arch-migrate"
        ? {
            ...s,
            text:
              "Run discover --propose, then write architecture-intent.json from " +
              "the candidates and re-run check until it is green.",
          }
        : s,
    );
    const result = evaluate({ ...baseFacts, skills });
    assert.ok(
      result.failures.some((f) => f.includes("arch-migrate") && f.includes("never a decision")),
    );
  });

  it("passes when arch-migrate states the proposal-is-not-a-decision claim", () => {
    const result = evaluate({ ...baseFacts, skills: allGood() });
    assert.ok(!result.failures.some((f) => f.includes("arch-migrate")));
  });

  it("fails when authoring.md requires a metadata.version", () => {
    const result = evaluate({
      ...baseFacts,
      skills: allGood(),
      authoring: 'metadata:\n  version: "0.4.0"',
    });
    assert.ok(
      result.failures.some((f) => f.includes("authoring.md") && f.includes("metadata.version")),
    );
  });

  it("fails when overview.md lists metadata in the standard frontmatter", () => {
    const result = evaluate({
      ...baseFacts,
      skills: allGood(),
      overview: "standard frontmatter (`name`, `description`, `metadata`, `compatibility`)",
    });
    assert.ok(
      result.failures.some((f) => f.includes("overview.md") && f.includes("stale mechanism")),
    );
  });
});

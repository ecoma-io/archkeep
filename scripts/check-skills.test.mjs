import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluate, EXPECTED_SKILLS, parseSkillFrontmatter } from "./check-skills.mjs";

describe("parseSkillFrontmatter", () => {
  it("parses valid frontmatter with all fields", () => {
    const text = `---
name: arch-context
description: Understand architecture boundaries
metadata:
  version: "0.4.0"
compatibility: Requires lattice CLI
---
Body text here`;

    const fm = parseSkillFrontmatter(text);
    assert.ok(fm);
    assert.equal(fm.name, "arch-context");
    assert.equal(fm.description, "Understand architecture boundaries");
    assert.equal(fm.metadata.version, "0.4.0");
    assert.equal(fm.compatibility, "Requires lattice CLI");
  });

  it("parses frontmatter with single-quoted values", () => {
    const text = `---
name: 'arch-check'
description: 'Validate after changes'
metadata:
  version: '0.4.0'
---
Body`;

    const fm = parseSkillFrontmatter(text);
    assert.ok(fm);
    assert.equal(fm.name, "arch-check");
    assert.equal(fm.metadata.version, "0.4.0");
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
  const goodSkill = (dir, name, version = "0.4.0") => ({
    dir,
    name,
    description: `Skill ${name}`,
    metadataVersion: version,
    compatibility: "Requires @ecoma-io/lattice CLI",
    hostFields: [],
  });

  const allGood = () => EXPECTED_SKILLS.map((s) => goodSkill(s, s));

  it("passes when all skills are present, named correctly, and versions match", () => {
    const result = evaluate({
      skillDirs: [...EXPECTED_SKILLS],
      packageVersion: "0.4.0",
      pluginVersion: "0.4.0",
      marketplaceVersion: "0.4.0",
      skills: allGood(),
    });
    assert.equal(result.failures.length, 0);
    assert.ok(result.lines.some((l) => l.startsWith("ok")));
  });

  it("fails when an expected skill directory is missing", () => {
    const result = evaluate({
      skillDirs: ["arch-context"],
      packageVersion: "0.4.0",
      pluginVersion: "0.4.0",
      marketplaceVersion: "0.4.0",
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
      skillDirs: [...EXPECTED_SKILLS],
      packageVersion: "0.4.0",
      pluginVersion: "0.4.0",
      marketplaceVersion: "0.4.0",
      skills,
    });
    assert.ok(result.failures.some((f) => f.includes("must match its directory name")));
  });

  it("fails when skill version does not match package version", () => {
    const skills = allGood();
    skills[0] = goodSkill("arch-context", "arch-context", "0.3.0");
    const result = evaluate({
      skillDirs: [...EXPECTED_SKILLS],
      packageVersion: "0.4.0",
      pluginVersion: "0.4.0",
      marketplaceVersion: "0.4.0",
      skills,
    });
    assert.ok(result.failures.some((f) => f.includes("0.3.0") && f.includes("0.4.0")));
  });

  it("fails when skill has no name", () => {
    const skills = allGood();
    skills[0] = {
      dir: "arch-context",
      name: null,
      description: "x",
      metadataVersion: "0.4.0",
      compatibility: "lattice",
      hostFields: [],
    };
    const result = evaluate({
      skillDirs: [...EXPECTED_SKILLS],
      packageVersion: "0.4.0",
      pluginVersion: "0.4.0",
      marketplaceVersion: "0.4.0",
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
      metadataVersion: "0.4.0",
      compatibility: "lattice",
      hostFields: [],
    };
    const result = evaluate({
      skillDirs: [...EXPECTED_SKILLS],
      packageVersion: "0.4.0",
      pluginVersion: "0.4.0",
      marketplaceVersion: "0.4.0",
      skills,
    });
    assert.ok(result.failures.some((f) => f.includes("no `description`")));
  });

  it("fails when skill has no metadata.version", () => {
    const skills = allGood();
    skills[0] = {
      dir: "arch-context",
      name: "arch-context",
      description: "d",
      metadataVersion: null,
      compatibility: "lattice",
      hostFields: [],
    };
    const result = evaluate({
      skillDirs: [...EXPECTED_SKILLS],
      packageVersion: "0.4.0",
      pluginVersion: "0.4.0",
      marketplaceVersion: "0.4.0",
      skills,
    });
    assert.ok(result.failures.some((f) => f.includes("no `metadata.version`")));
  });

  it("fails when skill has host-specific frontmatter fields", () => {
    const skills = allGood();
    skills[0] = { ...goodSkill("arch-context", "arch-context"), hostFields: ["context", "model"] };
    const result = evaluate({
      skillDirs: [...EXPECTED_SKILLS],
      packageVersion: "0.4.0",
      pluginVersion: "0.4.0",
      marketplaceVersion: "0.4.0",
      skills,
    });
    assert.ok(result.failures.some((f) => f.includes("host-specific")));
  });

  it("fails when plugin version does not match package version", () => {
    const result = evaluate({
      skillDirs: [...EXPECTED_SKILLS],
      packageVersion: "0.4.0",
      pluginVersion: "1.0.1",
      marketplaceVersion: "0.4.0",
      skills: allGood(),
    });
    assert.ok(result.failures.some((f) => f.includes("plugin.json") && f.includes("1.0.1")));
  });

  it("fails when marketplace version does not match package version", () => {
    const result = evaluate({
      skillDirs: [...EXPECTED_SKILLS],
      packageVersion: "0.4.0",
      pluginVersion: "0.4.0",
      marketplaceVersion: "1.0.1",
      skills: allGood(),
    });
    assert.ok(result.failures.some((f) => f.includes("marketplace.json") && f.includes("1.0.1")));
  });
});

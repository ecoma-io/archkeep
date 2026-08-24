import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  cargoLockPackageVersion,
  tomlSectionVersion,
  evaluate,
  EXPECTED_SKILLS,
  findHostSpecificFields,
  parseSkillFrontmatter,
  selectMarketplaceVersion,
  skillLinkTargets,
  REPO_BLOB_PREFIX,
  VERSION_CHAIN_PATHS,
} from "./check-skills.mjs";

describe("selectMarketplaceVersion", () => {
  it("picks the entry by name, not array position", () => {
    // A positional read (`catalogue.plugins[0]`) is correct only as long as
    // `archkeep` happens to be first — a second plugin prepended to the
    // catalogue would leave the real entry unchecked while a positional read
    // silently validates the decoy's version instead.
    const catalogue = {
      plugins: [
        { name: "decoy", version: "9.9.9" },
        { name: "archkeep", version: "0.7.1" },
      ],
    };
    assert.equal(selectMarketplaceVersion(catalogue, "archkeep"), "0.7.1");
  });

  it("returns '?' when no entry matches the plugin name", () => {
    const catalogue = { plugins: [{ name: "decoy", version: "9.9.9" }] };
    assert.equal(selectMarketplaceVersion(catalogue, "archkeep"), "?");
  });

  it("returns '?' when the catalogue has no plugins list", () => {
    assert.equal(selectMarketplaceVersion({}, "archkeep"), "?");
  });
});

describe("cargoLockPackageVersion", () => {
  it("reads the named package's version out of the [[package]] array", () => {
    const lock =
      '[[package]]\nname = "serde"\nversion = "1.0.229"\n\n' +
      '[[package]]\nname = "archkeep-rule-sdk"\nversion = "0.10.0"\n';
    assert.equal(cargoLockPackageVersion(lock, "archkeep-rule-sdk"), "0.10.0");
  });

  it("never reads another package's version as the named one's", () => {
    // The silent direction, and the reason this is not a call into
    // tomlSectionVersion: every entry in a lock carries the SAME
    // `[[package]]` header, so a header-only match returns whichever entry
    // came first — a dependency's number, reported as the crate's, reading
    // as "in sync" while the lock has not been bumped at all.
    const lock =
      '[[package]]\nname = "itoa"\nversion = "1.0.18"\n\n' +
      '[[package]]\nname = "memchr"\nversion = "2.8.3"\n';
    assert.equal(cargoLockPackageVersion(lock, "archkeep-rule-sdk"), "?");
  });

  it("returns '?' when the named entry carries no version line", () => {
    const lock = '[[package]]\nname = "archkeep-rule-sdk"\ndependencies = [\n "serde",\n]\n';
    assert.equal(cargoLockPackageVersion(lock, "archkeep-rule-sdk"), "?");
  });
});

describe("tomlSectionVersion", () => {
  it("reads the [package] section's version", () => {
    const toml = '[package]\nname = "archkeep-rule-sdk"\nversion = "0.9.0"\nedition = "2024"\n';
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
      '[project]\nname = "archkeep-rule-sdk"\nversion = "0.9.0"\n[tool.x]\nversion = "9.9.9"\n';
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
compatibility: Requires archkeep CLI
---
Body text here`;

    const fm = parseSkillFrontmatter(text);
    assert.ok(fm);
    assert.equal(fm.name, "arch-context");
    assert.equal(fm.description, "Understand architecture boundaries");
    assert.equal(fm.compatibility, "Requires archkeep CLI");
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

  it("refuses frontmatter that does not start at position 0", () => {
    // The silent direction for the position branch: a thematic break in the
    // body is a valid opening delimiter to a raw indexOf, so prose like this
    // parses as frontmatter and a name read out of the body reads as a
    // valid, checked skill — while the host, which requires frontmatter on
    // the first line (docs/skills/authoring.md), discovers nothing. The
    // refusal is null, which `evaluate` reports as missing name/description.
    const text = "Intro prose about boundaries\n\n---\nname: arch-x\n---\nBody";
    assert.equal(parseSkillFrontmatter(text), null);
  });

  it("reads the full value when it contains --- and keeps every later field", () => {
    // The silent direction for the closing-delimiter branch: an indexOf
    // search ends the block at the first `---` ANYWHERE, so this value was
    // truncated to "Covers x" and `compatibility`, sitting after it, was
    // dropped from the parse entirely.
    const text = [
      "---",
      "name: arch-x",
      "description: Covers x --- y transitions",
      "compatibility: Requires archkeep CLI",
      "---",
      "Body",
    ].join("\n");

    const fm = parseSkillFrontmatter(text);
    assert.ok(fm);
    assert.equal(fm.description, "Covers x --- y transitions");
    assert.equal(fm.compatibility, "Requires archkeep CLI");
  });

  it("parses double-quoted values with the same unquote rule as single quotes", () => {
    const text = `---
name: "arch-check"
description: "Validate after changes"
---
Body`;

    const fm = parseSkillFrontmatter(text);
    assert.ok(fm);
    assert.equal(fm.name, "arch-check");
    assert.equal(fm.description, "Validate after changes");
  });

  it("parses indented keys into their nested object rather than dropping or flattening them", () => {
    // Pins the nested-object branch itself: an empty value opens a
    // sub-object and indented keys land inside it, one level down — the
    // shape `findHostSpecificFields` has to walk.
    const text = `---
name: arch-x
description: x
compatibility: Requires archkeep CLI
metadata:
  version: 0.4.0
---
Body`;

    const fm = parseSkillFrontmatter(text);
    assert.ok(fm);
    assert.deepEqual(fm.metadata, { version: "0.4.0" });
  });
});

describe("findHostSpecificFields", () => {
  it("names host-specific top-level fields", () => {
    assert.deepEqual(findHostSpecificFields({ name: "x", context: "fast" }), ["context"]);
  });

  it("reaches host-specific keys nested under metadata:, where the old filter saw nothing", () => {
    // The smuggle route: the parser files an indented key inside the
    // sub-object its parent opened, so a top-level-only key filter reported
    // this frontmatter as host-independent while `model` sat one level down.
    assert.deepEqual(findHostSpecificFields({ metadata: { model: "opus" } }), ["metadata.model"]);
  });

  it("reaches host-specific keys at any depth under any parent key", () => {
    assert.deepEqual(findHostSpecificFields({ notes: { inner: { effort: "high" } } }), [
      "notes.inner.effort",
    ]);
  });

  it("collects every occurrence, nested and top-level alike", () => {
    assert.deepEqual(findHostSpecificFields({ paths: "a", metadata: { agent: "x", keep: "y" } }), [
      "paths",
      "metadata.agent",
    ]);
  });

  it("returns empty only when no host-specific field exists anywhere", () => {
    assert.deepEqual(
      findHostSpecificFields({
        name: "arch-x",
        description: "x",
        compatibility: "Requires archkeep CLI",
        metadata: { note: "not host-specific" },
      }),
      [],
    );
  });
});

describe("skillLinkTargets", () => {
  it("names every link destination with the line it sits on", () => {
    const text = "intro\n\nsee [a](https://x/a.md) and [b](../../docs/b.md)\n";
    assert.deepEqual(skillLinkTargets(text), [
      { line: 3, target: "https://x/a.md" },
      { line: 3, target: "../../docs/b.md" },
    ]);
  });

  it("unwraps an angle-bracketed destination and drops a trailing title", () => {
    assert.deepEqual(skillLinkTargets('[a](<https://x/a.md>) [b](https://x/b.md "t")'), [
      { line: 1, target: "https://x/a.md" },
      { line: 1, target: "https://x/b.md" },
    ]);
  });

  it("finds nothing in prose that only looks bracketed", () => {
    // The over-report direction: `[0] (the first)` is not a link attempt, and
    // reporting it as a non-absolute target would fail a skill for its prose.
    assert.deepEqual(skillLinkTargets("step [0] (the first) is a no-op"), []);
  });

  it("returns empty for text carrying no link at all", () => {
    // The silent direction lives here: if the extractor returned nothing for
    // text that DOES carry a link, check 17 would pass every skill by finding
    // nothing to judge. The case above is what makes this one meaningful.
    assert.deepEqual(skillLinkTargets("no links here"), []);
  });
});

describe("evaluate", () => {
  const goodSkill = (dir, name) => ({
    dir,
    name,
    description: `Skill ${name}`,
    compatibility: "Requires @ecoma-io/archkeep CLI",
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
        "(report-only on a `depConstraints` row) and names an " +
        "unresolved one inline and under `result.unresolvedDecisionRefs`. " +
        "On an intent row it is the fail-closed lane instead: an unresolvable " +
        "intent citation is a no-verdict run (exit 3) even beside a clean " +
        "boundary table. " +
        "`archkeep waivers` names every `boundarySuppressions` row — a waiver with " +
        "its term, a permanent suppression with what it is hiding.",
      "arch-review":
        "`archkeep waivers` names every row — a waiver with its term, a permanent " +
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
    cargoLockVersion: "0.4.0",
    tsSdkVersion: "0.4.0",
    pySdkVersion: "0.4.0",
    agentsSkillsFiles: { "arch-context/SKILL.md": "canonical" },
    skillsFiles: { "arch-context/SKILL.md": "canonical" },
    trackedFiles: ["docs/concepts/adr.md", "skills/arch-check/SKILL.md"],
  };

  // One skill carrying one link, everything else already correct — the shape
  // every check-17 case below varies by its target alone.
  const withLink = (target) => {
    const skills = allGood();
    const i = skills.findIndex((s) => s.dir === "arch-check");
    skills[i] = { ...skills[i], text: `${skills[i].text}\n\nSee [the page](${target}).` };
    return skills;
  };
  const linkFailures = (result) =>
    result.failures.filter((f) => f.includes("SKILL.md:") && f.includes("links to"));

  it("passes when all skills are present, named correctly, and versions match", () => {
    const result = evaluate({
      ...baseFacts,
      skills: allGood(),
    });
    assert.equal(result.failures.length, 0);
    assert.ok(result.lines.some((l) => l.startsWith("ok")));
  });

  it("fails when a copied skill file differs from the canonical one", () => {
    // The silent direction: both trees exist, both list, and Codex sessions run
    // an edit that never landed — or miss one that did — with no error anywhere.
    const result = evaluate({
      ...baseFacts,
      skills: allGood(),
      agentsSkillsFiles: { "arch-context/SKILL.md": "stale copy" },
    });
    assert.ok(result.failures.some((f) => f.includes("differs .agents/skills")));
  });

  it("fails when the copy is missing a canonical file, and when it carries an extra one", () => {
    const missing = evaluate({
      ...baseFacts,
      skills: allGood(),
      agentsSkillsFiles: {},
    });
    assert.ok(missing.failures.some((f) => f.includes("missing .agents/skills")));

    const extra = evaluate({
      ...baseFacts,
      skills: allGood(),
      agentsSkillsFiles: {
        "arch-context/SKILL.md": "canonical",
        "stray.md": "x",
      },
    });
    assert.ok(extra.failures.some((f) => f.includes("extra .agents/skills")));
  });

  it("fails when .agents/skills cannot be read at all, reported as null", () => {
    const result = evaluate({
      ...baseFacts,
      skills: allGood(),
      agentsSkillsFiles: null,
    });
    assert.ok(result.failures.some((f) => f.includes(".agents/skills")));
  });

  it("fails when the fact was never read at all — an unpassed fact is a failure, not a skip", () => {
    const facts = { ...baseFacts, skills: allGood() };
    delete facts.agentsSkillsFiles;
    delete facts.skillsFiles;
    const result = evaluate(facts);
    assert.ok(result.failures.some((f) => f.includes(".agents/skills")));
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

  it("reports an unexpected directory as a named note and stays green when both trees agree", () => {
    // Deliberately non-fatal, pinned here so the note can neither regress
    // into silence nor tighten into a failure unannounced. The single-tree
    // half of an unexpected directory already fails the byte-parity check
    // (16); what remains is a skill added to BOTH trees without updating
    // EXPECTED_SKILLS and docs/skills/overview.md — the drift the root
    // AGENTS.md warns about, reported as one line nobody asserted. It stays
    // a note because adding a skill is a deliberate act completed by the
    // roster update, and failing every intermediate commit of that work is
    // noise; but the note must name the directory, or the class is silent.
    const files = {
      "arch-context/SKILL.md": "canonical",
      "new-skill/SKILL.md": "canonical",
    };
    const result = evaluate({
      ...baseFacts,
      skillDirs: [...EXPECTED_SKILLS, "new-skill"],
      skills: [...allGood(), goodSkill("new-skill", "new-skill")],
      agentsSkillsFiles: files,
      skillsFiles: files,
    });
    assert.equal(result.failures.length, 0);
    assert.ok(
      result.lines.some((l) => l === "note new-skill — not in expected set"),
      "an unexpected directory must be reported by name even though the run exits 0",
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
      compatibility: "archkeep",
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
      compatibility: "archkeep",
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

  it("fails when the root package.json version disagrees with packages/archkeep/package.json", () => {
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
    assert.ok(result.failures.some((f) => f.includes("archkeep-vscode") && f.includes("1.0.1")));
  });

  it("fails when the Rust SDK crate version does not match package version", () => {
    const result = evaluate({
      ...baseFacts,
      cargoVersion: "1.0.1",
      skills: allGood(),
    });
    assert.ok(
      result.failures.some((f) => f.includes("archkeep-rule-sdk-rust") && f.includes("1.0.1")),
    );
  });

  it("fails when the Python SDK version does not match package version", () => {
    const result = evaluate({
      ...baseFacts,
      pySdkVersion: "1.0.1",
      skills: allGood(),
    });
    assert.ok(
      result.failures.some((f) => f.includes("archkeep-rule-sdk-python") && f.includes("1.0.1")),
    );
  });

  it("fails when Cargo.lock has not been bumped with Cargo.toml", () => {
    // The 0.10.0 release, replayed: release-please bumped the manifest via
    // extra-files, nothing bumped the lock, and the crates.io job died on
    // `cargo test --locked` after the tag was already cut. Red here is red
    // while the fix is still a commit.
    const result = evaluate({
      ...baseFacts,
      cargoLockVersion: "0.3.0",
      skills: allGood(),
    });
    assert.ok(
      result.failures.some((f) => f.includes("Cargo.lock") && f.includes("0.3.0")),
      "a lock left behind by the bump must fail the chain",
    );
  });

  it("fails when the TS SDK package version does not match package version", () => {
    const result = evaluate({
      ...baseFacts,
      tsSdkVersion: "1.0.1",
      skills: allGood(),
    });
    assert.ok(
      result.failures.some((f) => f.includes("archkeep-rule-sdk-ts") && f.includes("1.0.1")),
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

  it("fails when arch-check teaches only the report-only half of the decisionRef lane", () => {
    const skills = allGood().map((s) => ({
      ...s,
      text:
        s.dir === "arch-check"
          ? "`check` resolves each row's `decisionRef` against the ADR registry " +
            "(report-only — the resolution changes no byte of the verdict). " +
            "`archkeep waivers` names every `boundarySuppressions` row."
          : correctedText(s.dir),
    }));
    const result = evaluate({ ...baseFacts, skills });
    assert.ok(result.failures.some((f) => f.includes("unresolvable intent")));
  });

  it("fails when a skill still says waivers lists only the term-bound rows", () => {
    const skills = allGood().map((s) => ({
      ...s,
      text:
        s.dir === "arch-review"
          ? "archkeep waivers lists only the term-bound rows (a permanent suppression is absent)"
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

  it("fails when a host-specific field smuggled in under a nested block reaches evaluate", () => {
    // The end-to-end half of the smuggle fix: readSkillFacts now hands
    // dotted paths to evaluate, so the failure names both the hiding place
    // and the field instead of reporting the skill as host-independent.
    const skills = allGood();
    skills[0] = { ...goodSkill("arch-context", "arch-context"), hostFields: ["metadata.model"] };
    const result = evaluate({ ...baseFacts, skills });
    assert.ok(
      result.failures.some((f) => f.includes("host-specific") && f.includes("metadata.model")),
    );
  });

  it("fails when an extra-files entry sits outside the version chain", () => {
    // Issue #241's silent direction: release-please-config.json grows an
    // eleventh version-bearing file and every release bumps it while no
    // chain check ever reads it — byte-identical to a healthy run. Both
    // rosters are derived here from their own source files (the gate script's
    // path constants, this repository's release configuration), so neither
    // side can grow alone; there is no restated copy of either list.
    const config = JSON.parse(
      readFileSync(new URL("../release-please-config.json", import.meta.url), "utf8"),
    );
    /** @type {{path?: string}[]} */
    const extraFiles = config.packages["."]["extra-files"];
    const outside = extraFiles.map((f) => f.path).filter((p) => !VERSION_CHAIN_PATHS.includes(p));
    assert.deepEqual(
      outside,
      [],
      `release-please bumps ${outside.join(", ")} on every release, but no version-chain check ` +
        `verifies it. Put the file on the chain (VERSION_CHAIN_PATHS in check-skills.mjs, ` +
        `docs/skills/versioning.md) or take it off extra-files.`,
    );
  });

  it("fails on a repo-relative link, the shape a vendored skill resolves elsewhere", () => {
    // The direction the bug was, and the silent one: `../../docs/…` resolves
    // correctly from `skills/<name>/`, so check-docs-links passes it — and in
    // a consumer's tree the same target lands on some other file or nothing
    // while still rendering as a link. The failure must name file, line and
    // target, because "a link is wrong somewhere" is not actionable.
    const result = evaluate({ ...baseFacts, skills: withLink("../../docs/concepts/adr.md") });
    assert.equal(linkFailures(result).length, 1);
    assert.ok(
      linkFailures(result)[0].includes("skills/arch-check/SKILL.md:") &&
        linkFailures(result)[0].includes("../../docs/concepts/adr.md") &&
        linkFailures(result)[0].includes("not an absolute https:// URL"),
    );
  });

  it("fails on the other two repo-relative spellings, `./` and a bare docs/ path", () => {
    for (const target of ["./reference.md", "docs/concepts/adr.md"]) {
      const result = evaluate({ ...baseFacts, skills: withLink(target) });
      assert.equal(linkFailures(result).length, 1, `${target} was not reported`);
    }
  });

  it("passes an absolute https:// link that points outside this repository", () => {
    // The over-report direction: a skill legitimately cites the Agent Skills
    // standard and other external pages, and a gate that failed those would be
    // reworded away rather than obeyed.
    const result = evaluate({ ...baseFacts, skills: withLink("https://agentskills.dev/spec") });
    assert.deepEqual(linkFailures(result), []);
  });

  it("passes an in-file #anchor, which travels with the skill wherever it is vendored", () => {
    // The rule is vendoring-safety, not absoluteness for its own sake. An
    // anchor into the skill's own body cannot resolve somewhere else once the
    // file moves, so refusing it would push an author to write an absolute URL
    // that sends a reader out to GitHub to reach a heading two lines down —
    // the worse spelling, produced by a gate obeyed rather than understood.
    const result = evaluate({ ...baseFacts, skills: withLink("#when-to-use-this") });
    assert.deepEqual(linkFailures(result), []);
  });

  it("still fails a relative target that merely CONTAINS a #, rather than starting with one", () => {
    // The red twin for the exemption above: `#` is a prefix test, not a
    // substring one. A `../../elsewhere/page.md#status` is repo-relative first and
    // anchored second, and an exemption keyed on "has a fragment" would let
    // exactly the reported defect back through wearing a fragment.
    const result = evaluate({ ...baseFacts, skills: withLink("../../elsewhere/page.md#status") });
    assert.equal(linkFailures(result).length, 1);
  });

  it("fails a repo link whose path is not in the tracked tree", () => {
    // What going absolute costs: a doc renamed on main leaves a URL nothing in
    // the tree disagrees with. Resolving the path after the blob prefix buys
    // the rename detection back.
    const result = evaluate({ ...baseFacts, skills: withLink(`${REPO_BLOB_PREFIX}docs/gone.md`) });
    assert.equal(linkFailures(result).length, 1);
    assert.ok(linkFailures(result)[0].includes("docs/gone.md"));
  });

  it("passes a repo link whose path is in the tracked tree, fragment and all", () => {
    const plain = evaluate({
      ...baseFacts,
      skills: withLink(`${REPO_BLOB_PREFIX}docs/concepts/adr.md`),
    });
    assert.deepEqual(linkFailures(plain), []);

    const fragment = evaluate({
      ...baseFacts,
      skills: withLink(`${REPO_BLOB_PREFIX}docs/concepts/adr.md#registry`),
    });
    assert.deepEqual(linkFailures(fragment), []);
  });

  it("fails a repo link when the tracked list could not be read, rather than skipping it", () => {
    // An unverifiable link is the silent direction: with no tracked list the
    // path after the blob prefix is never resolved, and a run that judged
    // nothing would be byte-identical to a run that found nothing wrong.
    const result = evaluate({
      ...baseFacts,
      skills: withLink(`${REPO_BLOB_PREFIX}docs/concepts/adr.md`),
      trackedFiles: null,
    });
    assert.equal(linkFailures(result).length, 1);
    assert.ok(linkFailures(result)[0].includes("could not be read"));
  });

  it("holds every extra-files entry against a non-empty chain roster", () => {
    // If VERSION_CHAIN_PATHS itself were emptied or renamed away, the test
    // above would pass vacuously — every path would be "outside" only if the
    // array existed to be filtered. A roster that stopped naming files must
    // fail loudly rather than agree with everything.
    assert.ok(VERSION_CHAIN_PATHS.length >= 9);
  });
});

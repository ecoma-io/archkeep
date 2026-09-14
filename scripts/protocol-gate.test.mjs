// The suite-side consumer of the protocol requirements table, pinned the same
// way `check-skills.test.mjs` pins the gate side.
//
// `scripts/skill-protocol.mjs` is the single forcing-point table, consumed
// twice: `scripts/check-skills.mjs` gates a pull request's edit to the shipped
// skills, and `agent-suite/protocol-gate.mjs` asserts the same anchors inside
// every agent-suite scenario. `check-skills.test.mjs` already pins the gate
// half; these tests pin the suite half (#935):
//
//   - a clean skill-text map satisfies every bound requirement,
//   - dropping ONE anchor phrase flips exactly that requirement to unmet —
//     the score the bound scenario reports goes red naming the id,
//   - an unknown binding id is a loud harness error, never a silent skip,
//   - a missing skills root throws: the runner aborts on unreadable skill
//     text instead of continuing with zero knowledge of the protocol,
//   - the standalone debug CLI actually evaluates. It used to compare
//     `process.argv[1]` against the module's `file://` URL — always false —
//     and silently exit 0 no matter what the skill texts said (#944). Clean
//     texts exit 0, a weakened text exits 1 naming the id, an unknown id
//     exits 2.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readSkillTexts, unmetBoundRequirements } from "../agent-suite/protocol-gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const gateCli = resolve(here, "..", "agent-suite", "protocol-gate.mjs");
const shippedSkills = resolve(here, "..", "skills");

/** The forcing points these tests bind — one per skill, so a dropped phrase
 * cannot be accidentally satisfied by another skill's text. */
const BOUND_IDS = [
  "RECONCILE-AFTER-IMPLEMENT", // arch-change
  "VERIFY-WAIVERS-MANDATORY", // arch-check
  "REVIEW-INCOMPLETE-REFUSAL", // arch-review
];

/** Hand-written skill texts in the same fixture style `check-skills.test.mjs`
 * uses: prose parallel to the load-bearing phrases, never a re-pinned copy of
 * the production table. Each sentence states the anchors of exactly one bound
 * requirement. */
function cleanTexts() {
  return {
    "arch-change": "Reconcile after implementing.",
    "arch-check":
      "VERIFY runs the `waivers` command on every green check — mandatory: it names what the green " +
      "run hid.",
    "arch-review": "With artifacts missing, report INCOMPLETE, naming the missing artifacts.",
  };
}

describe("unmetBoundRequirements (#935)", () => {
  it("returns [] when every bound requirement's anchors are stated (a)", () => {
    assert.deepEqual(unmetBoundRequirements(BOUND_IDS, cleanTexts()), []);
  });

  it("returns exactly the requirement whose anchor phrase a skill text dropped (b)", () => {
    const texts = cleanTexts();
    texts["arch-change"] = texts["arch-change"].replace("Reconcile after implementing", "");
    const unmet = unmetBoundRequirements(BOUND_IDS, texts);
    assert.deepEqual(
      unmet.map((req) => req.id),
      ["RECONCILE-AFTER-IMPLEMENT"],
    );
  });

  it("throws on an unknown requirement id — a typo must be a loud harness error (c)", () => {
    assert.throws(
      () => unmetBoundRequirements(["NO-SUCH-FORCING-POINT"], cleanTexts()),
      /unknown protocol requirement id "NO-SUCH-FORCING-POINT"/u,
    );
  });
});

describe("readSkillTexts (#935)", () => {
  it("throws on a missing skills root — the runner aborts, never zero texts (d)", () => {
    const root = join(tmpdir(), `protocol-gate-no-root-${process.pid}-${Date.now()}`);
    assert.throws(
      () => readSkillTexts(root),
      (err) => err.code === "ENOENT",
    );
  });
});

describe("standalone CLI (#944)", () => {
  const scratchRoots = [];
  after(() => {
    for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
  });

  /** A temp copy of the real skills tree; tests weaken the copy, never the
   * shipped files. */
  function scratchSkills() {
    const dir = mkdtempSync(join(tmpdir(), "protocol-gate-cli-"));
    scratchRoots.push(dir);
    cpSync(shippedSkills, join(dir, "skills"), { recursive: true });
    return join(dir, "skills");
  }

  const runCli = (skillsRoot, ...ids) =>
    spawnSync(process.execPath, [gateCli, skillsRoot, ...ids], { encoding: "utf8" });

  it("exits 0 with an ok line on clean skill texts (e)", () => {
    const run = runCli(scratchSkills(), ...BOUND_IDS);
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /^ok 3 requirement\(s\)/u);
  });

  it("exits 1 naming the unmet requirement when an anchor phrase is dropped (f)", () => {
    const skillsRoot = scratchSkills();
    const skillPath = join(skillsRoot, "arch-change", "SKILL.md");
    writeFileSync(
      skillPath,
      readFileSync(skillPath, "utf8").replace("Reconcile after implementing", ""),
    );
    const run = runCli(skillsRoot, "RECONCILE-AFTER-IMPLEMENT");
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.match(`${run.stdout}${run.stderr}`, /UNMET RECONCILE-AFTER-IMPLEMENT/u);
  });

  it("exits 2 with a loud error on an unknown requirement id (g)", () => {
    const run = runCli(scratchSkills(), "NO-SUCH-FORCING-POINT");
    assert.equal(run.status, 2, `${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /unknown protocol requirement id "NO-SUCH-FORCING-POINT"/u);
  });
});

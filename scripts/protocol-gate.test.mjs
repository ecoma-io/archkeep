// The suite-side consumer of the protocol requirements table, pinned the same
// way `check-skills.test.mjs` pins the gate side.
//
// `scripts/skill-protocol.mjs` is the single forcing-point table, consumed
// twice: `scripts/check-skills.mjs` gates a pull request's edit to the shipped
// skills, and `agent-suite/protocol-gate.mjs` asserts the same anchors inside
// every agent-suite scenario. `check-skills.test.mjs` already pins the gate
// half; these tests pin the suite half (#935):
//
//   - clean skill texts exit 0, stating every bound requirement,
//   - dropping ONE anchor phrase exits 1 naming exactly the unmet
//     requirement id — the score the bound scenario reports goes red,
//   - an unknown binding id exits 2 with a loud error, never a silent skip,
//   - an unreadable skill text exits 3 naming ENOENT: the runner aborts
//     instead of continuing with zero knowledge of the protocol,
//   - the standalone debug CLI actually evaluates. It used to compare
//     `process.argv[1]` against the module's `file://` URL — always false —
//     and silently exit 0 no matter what the skill texts said (#944).
//
// Every test drives the spawned CLI — exit code plus the exact
// stderr/stdout fragment. The gate's surface is argv, never an import:
// `agent-suite/` is intentionally unowned, so the module-boundary law
// forbids a relative import into it, and these tests exercise the module
// only through its own process.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

  it("exits 3 naming ENOENT when a skill text is unreadable (h)", () => {
    const dir = mkdtempSync(join(tmpdir(), "protocol-gate-cli-"));
    scratchRoots.push(dir);
    // An existing root whose skill is present but unreadable (no SKILL.md):
    // the CLI's isDirectory() disambiguation accepts the root, then the
    // missing text aborts the run with ENOENT.
    const skillsRoot = join(dir, "skills");
    mkdirSync(join(skillsRoot, "arch-change"), { recursive: true });
    const run = runCli(skillsRoot, "RECONCILE-AFTER-IMPLEMENT");
    assert.equal(run.status, 3, `${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /cannot read the skill texts: .*ENOENT/u);
  });
});

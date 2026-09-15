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
//   - the table's anchor strength is pinned mechanically by ANCHOR_ROSTER:
//     weakening or dropping an anchor in `scripts/skill-protocol.mjs` is a
//     protocol change this file reports loudly — never a silent edit,
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
import { PROTOCOL_REQUIREMENTS } from "./skill-protocol.mjs";

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

/** The protocol table's anchor strength, pinned. Every row id in
 * `scripts/skill-protocol.mjs` is transcribed here as the exact regex
 * literals it ships — source and flags — in "/…/u" form. Golden on purpose:
 * reading the table at test time would make the pin a tautology, so the
 * table can drift and this roster stays. A weakened or dropped anchor fails
 * the assertions below with the exact phrase that must be stated. */
export const ANCHOR_ROSTER = {
  "CLASSIFY-TRIVIAL-FLOOR": [
    "/not an architecture change is trivial/u",
    "/run `check` once and stop there/u",
  ],
  "CLASSIFY-NO-VERDICT-STOP": [
    "/Exit 3 is a STOP, not a warning/u",
    "/nothing downstream may claim clean/u",
  ],
  "CLASSIFY-FOREIGN-VERDICT": [
    "/routes to the repo whose law produced it/u",
    "/never overridden locally/u",
  ],
  "BASELINE-BEFORE-DECLARE": [
    "/Capture the baseline before declaring or editing/u",
    "/Capture on a clean, committed tree/u",
  ],
  "BASELINE-CANONICAL-PATH": ["/delta --capture --output \\.archkeep\\/base\\.json/u"],
  "DECLARE-BEFORE-IMPLEMENT": [
    "/declare against the/u",
    "/--intent <manifest>/u",
    "/before editing/u",
  ],
  "RECONCILE-AFTER-IMPLEMENT": ["/Reconcile after implementing/u"],
  "RECONCILE-REDECLARE-LOOP": ["/changedSinceBase[^.\\n]{0,60}routes? back to DECLARE/u"],
  "CHANGE-EVENT-EVIDENCE": ["/--event-out/u", "/audit trail/u"],
  "VERIFY-COVERAGE-GAPS-STOP": [
    "/A non-empty gap row is NOT a clean claim/u",
    "/stage the files or stop/u",
  ],
  "VERIFY-WAIVERS-MANDATORY": ["/waivers` command on every green check/u", "/— mandatory:/u"],
  "VERIFY-EXIT3-NEVER-CLEAN": ["/Exit 3 is never/u", "/never silently becomes PASS/u"],
  "REVIEW-INCOMPLETE-REFUSAL": ["/report INCOMPLETE, naming the missing artifacts/u"],
  "REVIEW-COMPLETION-BAR": [
    "/COMPLETE requires quoting the baseline identity/u",
    "/reconciliation\\.verdict/u",
    "/event artifact path/u",
  ],
  "REVIEW-QUOTES-SUPPRESSION-DELTA": ["/suppression delta/u"],
  "REVIEW-BLOCKING-RULE": ["/Exit 1 or exit 3 blocks/u", "/coverageGaps` row is non-empty/u"],
  "REVIEW-SCOPED-DISCLOSURE": ["/disclosed as scoped/u", "/does not earn approval/u"],
  "REVIEW-FOREIGN-VERDICT-ROUTING": ["/routes to the owning repo, never overridden locally/u"],
  "MIGRATE-LAW-EDIT-DECLARED": ["/A law edit is itself a change under the workflow/u"],
  "MIGRATE-COVERAGE-FIRST": ["/only step that may not be skipped/u"],
};

/** Decode one roster string into { source, flags }. Only the hard-coded
 * roster is read here — never the table — so the pin stays independent of
 * what it pins: a "/…/u" form carries its flags after the trailing "/", a
 * bare string has none. */
function rosterAnchor(entry) {
  const literal = /^\/([\s\S]*)\/([dgimsuvy]*)$/u.exec(entry);
  return literal ? { source: literal[1], flags: literal[2] } : { source: entry, flags: "" };
}

describe("protocol table roster (#946)", () => {
  it("has a table row for every roster id", () => {
    const tableIds = new Set(PROTOCOL_REQUIREMENTS.map((row) => row.id));
    for (const id of Object.keys(ANCHOR_ROSTER)) {
      assert.ok(tableIds.has(id), `roster id ${id} has no row in PROTOCOL_REQUIREMENTS`);
    }
  });

  it("pins every anchor's source and flags exactly", () => {
    for (const id of Object.keys(ANCHOR_ROSTER)) {
      const row = PROTOCOL_REQUIREMENTS.find((r) => r.id === id);
      assert.ok(row, `roster id ${id} has no row in PROTOCOL_REQUIREMENTS`);
      const expected = ANCHOR_ROSTER[id].map(rosterAnchor);
      assert.equal(
        row.anchors.length,
        expected.length,
        `${id}: roster pins ${expected.length} anchor(s) (${ANCHOR_ROSTER[id].join(", ")}), table has ${row.anchors.length}`,
      );
      expected.forEach(({ source, flags }, i) => {
        assert.equal(
          row.anchors[i].source,
          source,
          `${id} anchor ${i}: table states "${row.anchors[i].source}", roster pins "${source}"`,
        );
        assert.equal(
          row.anchors[i].flags,
          flags,
          `${id} anchor ${i}: table flags "${row.anchors[i].flags}", roster pins "${flags}"`,
        );
      });
    }
  });

  it("covers every table row id — a new row without a roster entry fails", () => {
    for (const row of PROTOCOL_REQUIREMENTS) {
      assert.ok(
        Object.hasOwn(ANCHOR_ROSTER, row.id),
        `table row ${row.id} has no entry in ANCHOR_ROSTER`,
      );
    }
  });
});

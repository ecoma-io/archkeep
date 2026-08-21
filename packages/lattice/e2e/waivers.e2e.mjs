// E2E scenarios for the suppression table, through the installed CLI.
//
// The sweep suite already proves `waivers --format json` is deterministic on a
// clean tree carrying a live waiver. What no scenario covered is what the
// table DOES to a real violation, and that is where the silent failure lives:
// a row that keeps covering a boundary breach after its term lapsed is a
// boundary everybody believes is enforced and nobody has run in months.
//
// Three states of one row, over one violating tree
// (`fixtures/waiver-law.mjs`):
//
//   permanent  → the violation is removed; only `waivers` still names it
//   active     → the violation is KEPT and still exits 1; accepting a breach
//                for a fixed term is a tracked decision, not a fix
//   expired    → the violation is kept and the row covers nothing
//
// The active and expired variants differ only by which side of the wall clock
// `expiresAt` falls on. That is the one fact a unit test supplies for itself
// and a spawned binary cannot, which is what makes these E2E rather than unit.
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { packArtifact } from "./helpers/artifact.mjs";
import { createNativeMonorepoConsumer, commitFiles } from "./helpers/consumer.mjs";
import { lattice } from "./helpers/run.mjs";
import { CORE_REACHES_APP } from "./fixtures/violations.mjs";
import { ACTIVE_WAIVER, EXPIRED_WAIVER, PERMANENT_SUPPRESSION } from "./fixtures/waiver-law.mjs";

let artifact;
let consumer;

beforeAll(() => {
  artifact = packArtifact();
  consumer = createNativeMonorepoConsumer(artifact);
  commitFiles(consumer.root, CORE_REACHES_APP, "core reaches up into app");
});

afterAll(() => {
  consumer?.cleanup();
  artifact?.cleanup();
});

/** Swaps the workspace's law for one of the three variants and commits it. */
function useLaw(law, message) {
  commitFiles(consumer.root, { "module-boundaries.config.mjs": law }, message);
}

describe("the suppression table, end to end", () => {
  it("fails the run with no suppression at all — the baseline every case below moves from", () => {
    const result = lattice(consumer.root, ["check"]);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("onlyTagsConstraintViolation");
  });

  it("removes the violation under a permanent suppression, and says so where it can", () => {
    useLaw(PERMANENT_SUPPRESSION, "accept core-to-app permanently");
    const check = lattice(consumer.root, ["check"]);
    expect(check.exitCode).toBe(0);

    // Exit 0 with a row on the table is the one place this tool's own
    // invariant needs a second surface: `check` is now silent about a
    // violation that exists, so `waivers` has to be the thing that is not.
    const waivers = lattice(consumer.root, ["waivers", "--format", "json"]);
    expect(waivers.exitCode).toBe(0);
    expect(waivers.json.result.suppressions).toHaveLength(1);
    expect(waivers.json.result.suppressions[0].covered).toBe(1);
    expect(waivers.json.result.suppressed).toBe(1);
    expect(waivers.json.result.waivers).toEqual([]);
    // And the text face must not claim the boundary is enforced.
    const text = lattice(consumer.root, ["waivers"]);
    expect(text.stdout).not.toContain("every boundary is enforced");
  });

  it("keeps the violation under a LIVE waiver — accepting a breach is not fixing it", () => {
    useLaw(ACTIVE_WAIVER, "accept core-to-app for a term");
    const check = lattice(consumer.root, ["check", "--format", "json"]);
    // The distinction from the permanent row above: still exit 1.
    expect(check.exitCode).toBe(1);
    expect(check.json.result.violations).toHaveLength(1);
    expect(check.json.result.violations[0].waivedBy.reason).toContain("untangled");

    const waivers = lattice(consumer.root, ["waivers", "--format", "json"]);
    expect(waivers.json.result.waivers).toHaveLength(1);
    expect(waivers.json.result.waivers[0].status).toBe("active");
    expect(waivers.json.result.waivers[0].covered).toBe(1);
    expect(waivers.json.result.expired).toBe(0);
    expect(waivers.json.result.waivers[0].remainingMs).toBeGreaterThan(0);
  });

  it("covers nothing once the term has lapsed, on the real clock", () => {
    // The assertion this file exists for. Nothing about the tree or the row
    // changes but which side of `Date.now()` the term falls on, and a run that
    // kept honouring it would be enforcing a boundary nobody had run since the
    // waiver was written.
    useLaw(EXPIRED_WAIVER, "let the term lapse");
    const check = lattice(consumer.root, ["check", "--format", "json"]);
    expect(check.exitCode).toBe(1);
    expect(check.json.result.violations).toHaveLength(1);
    // Kept, and NOT marked accepted: a lapsed row covers nothing.
    expect(check.json.result.violations[0].waivedBy).toBeUndefined();

    // The reader-facing signal that this finding used to be accepted and is
    // not any more — without it the violation is indistinguishable from one
    // nobody ever waived.
    expect(check.json.result.violations[0].evidence).toBe("expired waiver");

    const waivers = lattice(consumer.root, ["waivers", "--format", "json"]);
    const row = waivers.json.result.waivers[0];
    expect(row.status).toBe("expired");
    expect(waivers.json.result.expired).toBe(1);
    expect(row.remainingMs).toBeLessThan(0);
    // `covered` counts what the row is ABOUT, not what it currently accepts,
    // and the difference is load-bearing: a lapsed row still matching a live
    // violation is "renew it or fix the import", while `covered: 0` is "this
    // row is about nothing at all". Collapsing the two would lose the first
    // diagnostic, which is why `stale` is a separate count and stays 0 here.
    expect(row.covered).toBe(1);
    expect(waivers.json.result.stale).toBe(0);
  });

  it("goes green again when the import is removed rather than accepted", () => {
    // Violation → fix → pass, with the lapsed row still on the table: the
    // clean verdict has to come from the tree, not from the suppression.
    commitFiles(
      consumer.root,
      {
        "libs/core/go.mod": "module example.test/core\n\ngo 1.22\n",
        "libs/core/violate.go": "package core\n\nconst Fixed = true\n",
      },
      "core stops reaching up into app",
    );
    const check = lattice(consumer.root, ["check"]);
    expect(check.exitCode).toBe(0);
    // The row is now dead weight, and `waivers` is where that is visible.
    const waivers = lattice(consumer.root, ["waivers", "--format", "json"]);
    expect(waivers.json.result.stale).toBe(1);
  });
});

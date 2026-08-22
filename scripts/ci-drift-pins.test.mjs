// Drift pins over the workflow files CI itself runs — the tests that keep a
// fact CI depends on from being stated twice and checked in neither.
//
// The pattern is the one `check-packages.mjs` states for its target list:
// derive from the file that defines green, never restate. Each test below
// READS `.github/workflows/*.yml` and asserts a relationship inside it; none
// holds its own copy of a roster, an expression, or a pin list beyond the two
// gate job ids, which are not derived because they are the contract itself —
// the required check names a branch ruleset points at (AGENTS.md, "What scans
// this repository").
//
// Every pin here exists because its failure mode is SILENT: a publish job
// edited out of step with its siblings still reports Success on the checks UI,
// an unpinned action substitutes without a byte of this tree changing, and a
// job added outside `ci-gate.needs` widens what green means with nothing red.
// Enforcement before these tests: comments only — plus, for SHA pinning, the
// Semgrep rules in `.github/semgrep/workflows.yaml`, whose aggregate gate
// (`analysis-gate`) is deliberately NOT required. These tests run in `pnpm
// test`, under the check that IS required.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseActionRefs, parseContainerImages, parseJobs } from "./ci-workflow-facts.mjs";

const WORKFLOWS_DIR = new URL("../.github/workflows/", import.meta.url);

/**
 * Reads a tracked workflow file. A missing or renamed file throws here rather
 * than degrading to an empty pass — a pin that cannot read what it pins must
 * fail, not succeed.
 *
 * @param {string} name file name under `.github/workflows/`
 * @returns {string}
 */
function readWorkflow(name) {
  return readFileSync(new URL(name, WORKFLOWS_DIR), "utf8");
}

test("#245 — every ci.yml job answers to ci-gate, and ci-gate names only real jobs", () => {
  const jobs = parseJobs(readWorkflow("ci.yml"));
  const gate = jobs.find((job) => job.id === "ci-gate");
  assert.ok(gate, "ci.yml has no ci-gate job — the required check name has nothing behind it");

  const ids = jobs.map((job) => job.id);
  const outsideGate = ids.filter((id) => id !== "ci-gate" && !gate.needs.includes(id));
  assert.deepEqual(
    outsideGate,
    [],
    `these jobs run on every pull request but are absent from ci-gate.needs, so a green ` +
      `gate no longer means they passed: ${outsideGate.join(", ")}. Add each to needs — ` +
      `"forgetting to add it" was the one way to widen what green means, and this pin is ` +
      `what makes it loud instead of review-dependent.`,
  );

  const stray = gate.needs.filter((need) => !ids.includes(need));
  assert.deepEqual(
    stray,
    [],
    `ci-gate.needs names jobs that do not exist in ci.yml: ${stray.join(", ")}. A typo there ` +
      `blocks on a check nobody runs while the real jobs go ungated.`,
  );
});

test("#245 — every analysis.yml job answers to analysis-gate, same both-direction rule", () => {
  const jobs = parseJobs(readWorkflow("analysis.yml"));
  const gate = jobs.find((job) => job.id === "analysis-gate");
  assert.ok(gate, "analysis.yml has no analysis-gate job");

  const ids = jobs.map((job) => job.id);
  const outsideGate = ids.filter((id) => id !== "analysis-gate" && !gate.needs.includes(id));
  assert.deepEqual(
    outsideGate,
    [],
    `these analysis jobs are absent from analysis-gate.needs: ${outsideGate.join(", ")}`,
  );
  const stray = gate.needs.filter((need) => !ids.includes(need));
  assert.deepEqual(
    stray,
    [],
    `analysis-gate.needs names jobs that do not exist: ${stray.join(", ")}`,
  );
});

test("#230 — release.yml's conformance-gated publish jobs share one byte-identical if:", () => {
  // A publish job is identified structurally, not by name: it is any job that
  // needs verify-conformance, the differential gate whose header owns the
  // contract. Renaming or adding destinations keeps the pin working; editing
  // one expression divergently turns it red.
  const gated = parseJobs(readWorkflow("release.yml")).filter((job) =>
    job.needs.includes("verify-conformance"),
  );

  assert.ok(
    gated.length >= 2,
    `expected the conformance-gated publish jobs, found ${gated.length}. If release.yml's ` +
      `layout changed so its job-level if: lines are no longer read, this pin has gone ` +
      `blind — fix the reader, do not lower the bar.`,
  );
  for (const job of gated) {
    assert.ok(
      job.gateIf !== null && job.gateIf.length > 0,
      `publish job ${job.id} needs verify-conformance but declares no job-level if:, so it ` +
        `runs or skips by GitHub's implicit success() alone`,
    );
  }

  const [first, ...rest] = gated;
  for (const job of rest) {
    assert.equal(
      job.gateIf,
      first.gateIf,
      `${job.id}'s gate expression differs from ${first.id}'s. A divergence between publish ` +
        `jobs is a release that ships to one destination and not another, with every job ` +
        `reporting Success either way.`,
    );
  }
});

// Exemptions from #234's pinning requirements. Empty today, and kept as data
// so an exemption must carry its reason beside it — a bare allowlist entry
// would be exactly the unchecked exception this test exists to prevent.
const PINNED_REF_EXEMPTIONS = /** @type {{workflow: string, ref: string, reason: string}[]} */ ([]);

test("#234 — every action reference in every workflow is pinned to a full commit SHA", () => {
  const files = ["ci.yml", "release.yml", "analysis.yml", "differential.yml"];
  let seen = 0;
  for (const file of files) {
    for (const { ref, line } of parseActionRefs(readWorkflow(file))) {
      // A `docker://` step pulls an image, not an action repo — judged by the
      // digest rule below rather than by a SHA of a commit that does not exist.
      if (ref.startsWith("docker://")) continue;
      const exempt = PINNED_REF_EXEMPTIONS.find((e) => e.workflow === file && e.ref === ref);
      if (exempt) continue;
      seen += 1;
      assert.match(
        ref,
        /@[0-9a-fA-F]{40}$/,
        `${file}:${line} — \`${ref}\` is not pinned to a full commit SHA. SECURITY.md promises ` +
          `actions are pinned; a tag or branch is a pointer upstream can repoint. Pin to the ` +
          `SHA, keeping the \`# vX.Y.Z\` comment for humans. If an exemption is truly needed, ` +
          `add it to PINNED_REF_EXEMPTIONS in this file, with the reason.`,
      );
    }
  }
  assert.ok(
    seen >= 10,
    `only ${seen} action references were checked across ${files.join(", ")} — far fewer than ` +
      `these workflows hold. Either a workflow stopped using actions or the reader broke; ` +
      `both mean this pin went quiet and must be fixed before it can pass.`,
  );
});

test("#234 — every container image carries a sha256 digest", () => {
  let seen = 0;
  for (const file of ["ci.yml", "release.yml", "analysis.yml", "differential.yml"]) {
    for (const { image, line } of parseContainerImages(readWorkflow(file))) {
      seen += 1;
      assert.match(
        image,
        /@sha256:[0-9a-fA-F]{64}$/,
        `${file}:${line} — \`${image}\` does not resolve through a sha256 digest. A floating tag ` +
          `is content upstream can replace under the same name; SECURITY.md promises images are ` +
          `digest-pinned.`,
      );
    }
  }
  assert.ok(
    seen >= 1,
    "no container image found in any workflow — if the Semgrep container moved somewhere this " +
      "reader cannot see, the digest pin went quiet.",
  );
});

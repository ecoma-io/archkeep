/**
 * The golden suite: every fixture in `../fixtures/`, replayed against the
 * committed artifact **through the engine's real host**, with the verdict each
 * one must produce.
 *
 * This is this package's half of the shared conformance suite the ADR names as
 * the thing that holds four SDKs to one contract
 * (`../../../docs/adr/0002-custom-rules-one-contract.md`, "SDKs are bindings").
 * The fixtures are not hand-written JSON that looks like a bundle: they were
 * produced by the engine's own `buildEvidenceBundle` and canonical serializer
 * (`../../lattice/src/custom-rules/evidence.mjs`) and then formatted for review,
 * and they are byte-identical to the Rust SDK's copies
 * (`../../lattice-rule-sdk-rust/fixtures/`) — the same five documents, so a
 * verdict that differed between the two SDKs would be two contracts wearing one
 * name. What holds them identical is no longer a promise:
 * `../../lattice/src/conformance/rule-sdks.integration.test.mjs` reads every
 * SDK's copy of every fixture and requires them byte-identical, then drives all
 * four committed artifacts through the engine's real host and requires one
 * verdict document from each. The copy is still made by hand in the change that
 * lands each SDK; the gate is what makes an edit to one copy alone go red.
 *
 * ## Why this suite reaches for the host and the Rust one does not
 *
 * The Rust suite calls the pure `lattice_evaluate_json` directly, because a
 * `.wasm` file cannot be instantiated from a Rust test without a runtime that
 * crate refuses to depend on. This package has no such gap: the host is
 * JavaScript, this suite is JavaScript, and the engine sits in the same tree.
 * So what runs below is the SHIPPED path end to end — `loadCustomRule` compiles
 * the committed bytes, checks the digest the policy row would pin, refuses any
 * import, reads the self-description, and `evaluateCustomRule` writes the bundle
 * into linear memory and validates the verdict that comes back. Every refusal a
 * consumer's `check` would make is made here first.
 *
 * The import below is the only place this package reaches into the engine, and
 * it is a test-time reach: nothing under `../assembly/` knows the engine exists,
 * which is the direction the workspace's boundary law fixes
 * (`../../../module-boundaries.config.mjs`, the `scope-sdk` row).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { evaluateCustomRule, loadCustomRule } from "../../lattice/src/custom-rules/host.mjs";

/** @param {string} relative @returns {string} */
const packagePath = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));

/** The name the reference rule's policy row declares, and its describe must state. */
const RULE_NAME = "forbidden-tag-dependency";

const ARTIFACT_BYTES = readFileSync(packagePath("examples/forbidden-tag-dependency.wasm"));
const DECLARED_SHA256 = readFileSync(
  packagePath("examples/forbidden-tag-dependency.wasm.sha256"),
  "utf8",
).trim();

/**
 * The loaded rule, or a failure the caller must not read past.
 *
 * Loading is done per test rather than once for the file: `loadCustomRule` runs
 * `lattice_describe` in a worker, and a shared promise would make one test's
 * timeout another test's mystery.
 *
 * @returns {Promise<{module: WebAssembly.Module, describe: Record<string, any>}>}
 */
async function load() {
  const loaded = await loadCustomRule({
    name: RULE_NAME,
    artifactBytes: ARTIFACT_BYTES,
    declaredSha256: DECLARED_SHA256,
  });
  assert.ok(loaded.ok, `the committed artifact did not load: ${loaded.failure?.reason}`);
  return { module: loaded.module, describe: loaded.describe };
}

/**
 * The verdict the committed rule answers with over one fixture, as the host
 * validated it.
 *
 * @param {string} fixture A file under `../fixtures/`.
 * @returns {Promise<Record<string, any>>}
 */
async function replay(fixture) {
  const { module, describe } = await load();
  const outcome = await evaluateCustomRule({
    module,
    describe,
    evidenceBytes: new Uint8Array(readFileSync(packagePath(`fixtures/${fixture}`))),
  });
  assert.ok(outcome.ok, `${fixture} produced no verdict: ${outcome.failure?.reason}`);
  return outcome.verdict;
}

test("the declaration is the document the host reads", async () => {
  const { describe } = await load();
  assert.deepEqual(describe, {
    contract: 1,
    name: RULE_NAME,
    needs: ["model", "graph"],
    findings: [
      {
        id: "dependency-on-forbidden-tag",
        message: "a project depends on a project carrying the forbidden tag",
      },
    ],
  });
});

test("an edge into the forbidden tag fails and names the pair", async () => {
  assert.deepEqual(await replay("edge-into-forbidden-tag.json"), {
    contract: 1,
    verdict: "fail",
    findings: [
      {
        id: "dependency-on-forbidden-tag",
        message: 'beta depends on gamma, which carries "layer-infrastructure"',
        sourceFile: "packages/beta/src/store.rs",
        project: "beta",
      },
    ],
  });
});

test("a workspace whose edges all clear the tag passes", async () => {
  assert.deepEqual(await replay("every-edge-clean.json"), {
    contract: 1,
    verdict: "pass",
    findings: [],
  });
});

test("a workspace where the tag appears nowhere is not applicable", async () => {
  assert.deepEqual(await replay("no-project-carries-the-tag.json"), {
    contract: 1,
    verdict: "not_applicable",
    findings: [],
    notApplicableReason:
      'no project in this workspace carries "layer-infrastructure", so there is no dependency ' +
      "this rule could forbid",
  });
});

// The three cases below are the silent direction, and they are the reason this
// file is a suite rather than a demo. Each describes a run in which the rule
// could not reach a judgment; each would be indistinguishable from a clean
// workspace if it answered `pass`, and a workspace would go on believing a rule
// was enforcing something that had not run.

test("a row that names no tag is unknown rather than clean", async () => {
  const verdict = await replay("params-without-the-tag.json");
  assert.deepEqual(verdict, {
    contract: 1,
    verdict: "unknown",
    findings: [],
    reason:
      "params.forbiddenTag is not a non-empty string, so there is no tag to judge dependencies " +
      "against — the rule read nothing and concluded nothing",
  });

  // Stated twice on purpose: the assertion above would still hold if `replay`
  // compared nothing, and these would not.
  assert.notEqual(verdict.verdict, "pass");
  assert.notEqual(verdict.verdict, "fail");
});

test("an edge naming a project the model lacks is unknown", async () => {
  const verdict = await replay("edge-into-an-undeclared-project.json");
  assert.deepEqual(verdict, {
    contract: 1,
    verdict: "unknown",
    findings: [],
    reason:
      'the graph carries an edge into "epsilon", which the model does not declare — the two ' +
      "halves of the evidence disagree, and a rule cannot tell whether a project it cannot see " +
      "carries the tag",
  });
  assert.notEqual(verdict.verdict, "pass");
});

test("evidence bytes that are not a bundle become unknown through the real host", async () => {
  // The host builds every real bundle, so this case cannot arrive from it —
  // which is exactly why it is driven here by hand. What it proves is that the
  // path from unreadable bytes to a verdict the host ACCEPTS is a named
  // `unknown`: a rule that trapped instead would still be loud, but the reader
  // would be told the module broke rather than what was wrong with the bundle.
  const { module, describe } = await load();
  const outcome = await evaluateCustomRule({
    module,
    describe,
    evidenceBytes: new TextEncoder().encode("not json at all"),
  });
  assert.ok(outcome.ok, `the host refused the verdict outright: ${outcome.failure?.reason}`);
  assert.equal(outcome.verdict.verdict, "unknown");
  assert.match(outcome.verdict.reason, /evidence bundle/);
  assert.deepEqual(outcome.verdict.findings, []);
});

test("every finding the fixtures produce is in the catalogue", async () => {
  // The host refuses a finding it cannot resolve to a catalogue entry, and this
  // package deliberately does not repeat that check inside the rule — so the
  // place a typo'd id would otherwise surface is a consumer's `check`. Here it
  // is a red test instead.
  const { describe } = await load();
  const declared = describe.findings.map((entry) => entry.id);
  let seen = 0;
  for (const fixture of [
    "edge-into-forbidden-tag.json",
    "every-edge-clean.json",
    "no-project-carries-the-tag.json",
    "params-without-the-tag.json",
    "edge-into-an-undeclared-project.json",
  ]) {
    for (const finding of (await replay(fixture)).findings) {
      assert.ok(
        declared.includes(finding.id),
        `${fixture} produced the undeclared id ${finding.id}`,
      );
      seen += 1;
    }
  }
  // Without this the test passes over a suite that produced no finding at all,
  // which is exactly the shape it is meant to catch.
  assert.ok(seen > 0, "no fixture produced a finding, so nothing was checked");
});

test("the host refuses the artifact when the digest or the name disagrees", async () => {
  // Two load-class refusals, driven for the same reason the suite exists: the
  // pair of files this package commits is only meaningful if something checks
  // that the host actually reads them. A digest nobody verifies and a declared
  // name nobody compares would both fail silently in a consumer's tree.
  const wrongDigest = await loadCustomRule({
    name: RULE_NAME,
    artifactBytes: ARTIFACT_BYTES,
    declaredSha256: "0".repeat(64),
  });
  assert.equal(wrongDigest.ok, false);
  assert.match(wrongDigest.failure.reason, /hashes to/);
  assert.equal(wrongDigest.failure.class, "load");

  const wrongName = await loadCustomRule({
    name: "some-other-rule",
    artifactBytes: ARTIFACT_BYTES,
    declaredSha256: DECLARED_SHA256,
  });
  assert.equal(wrongName.ok, false);
  assert.match(wrongName.failure.reason, /calls itself/);
  assert.equal(wrongName.failure.class, "load");
});

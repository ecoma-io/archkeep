/**
 * The four rule-authoring SDKs, as facts a conformance suite can be driven
 * from — and the verdict every one of them must reproduce.
 *
 * `../../../../docs/adr/0002-custom-rules-one-contract.md` names the mechanism
 * that keeps four SDKs one contract: **a gate, not discipline** — "a shared
 * conformance suite — evidence fixtures with expected verdicts that every
 * SDK's reference rules must reproduce". Until this module existed that gate
 * was still future tense, and the sentence saying so was in the tree:
 * `../../../lattice-rule-sdk-go/examples/forbidden_tag_dependency/golden_test.go`
 * calls its fixtures "what the cross-SDK conformance gate WILL hold to each
 * other". Four things were true in the meantime:
 *
 * - the five fixture files exist as four byte-identical copies, one per SDK,
 *   and nothing went red when one of them was edited alone;
 * - each SDK pinned its own expected verdicts, so four lists could drift into
 *   four different laws while every suite stayed green;
 * - three of the four replayed their reference rule as NATIVE code — a Go test
 *   cannot instantiate wasm without a runtime that module refuses to depend
 *   on, and the Rust crate refuses the same dependency — so what was proven
 *   was the rule's logic rather than the artifact a consumer's `check` runs;
 * - and nothing anywhere put the four artifacts side by side, which is the
 *   one comparison "byte-identical verdicts across all four" is a claim about.
 *
 * `./rule-sdks.integration.test.mjs` is that comparison. It reaches for the
 * real host (`../custom-rules/host.mjs`) rather than any SDK's harness,
 * because the host is what a consumer's `check` runs and an SDK proving
 * itself with its own harness proves the harness.
 *
 * ## Why this lives in `src/conformance/`
 *
 * Same reason the ESLint differential does: this directory is where a verdict
 * is put beside another verdict, and it is excluded from the published
 * package (`../../package.json`'s `files`), so a suite that reads four
 * sibling packages' artifacts costs a consumer nothing. It reads those files;
 * it imports nothing from them, so the row in
 * `../../../../module-boundaries.config.mjs` that keeps the SDKs and the
 * engine from depending on each other is untouched.
 */

/**
 * Where each SDK's reference artifact and its fixture copies live, relative to
 * this file. Paths rather than imports, deliberately: reading a sibling
 * package's committed bytes is what this suite does, and importing its code
 * would make the engine depend on an SDK.
 *
 * The `origin` flag marks the copy every other fixture directory is a copy OF
 * — Rust, because it was the first SDK to land and the Go, TypeScript and
 * Python packages each say in their own suites that their fixtures came from
 * it. It decides nothing at runtime; it tells whoever regenerates a fixture
 * which file to regenerate first, and the parity assertion then requires the
 * other three to follow in the same change.
 */
export const RULE_SDKS = Object.freeze([
  Object.freeze({
    name: "rust",
    origin: true,
    artifact: "../../../lattice-rule-sdk-rust/examples/forbidden_tag_dependency.wasm",
    fixtures: "../../../lattice-rule-sdk-rust/fixtures",
  }),
  Object.freeze({
    name: "go",
    origin: false,
    artifact: "../../../lattice-rule-sdk-go/examples/forbidden_tag_dependency.wasm",
    fixtures: "../../../lattice-rule-sdk-go/fixtures",
  }),
  Object.freeze({
    name: "typescript",
    origin: false,
    artifact: "../../../lattice-rule-sdk-ts/examples/forbidden-tag-dependency.wasm",
    fixtures: "../../../lattice-rule-sdk-ts/fixtures",
  }),
  Object.freeze({
    name: "python",
    origin: false,
    artifact: "../../../lattice-rule-sdk-python/examples/forbidden_tag_dependency.wasm",
    fixtures: "../../../lattice-rule-sdk-python/fixtures",
  }),
]);

/** The rule every SDK's reference artifact implements, by its declared name. */
export const REFERENCE_RULE_NAME = "forbidden-tag-dependency";

/**
 * Every fixture, with the verdict the reference rule must answer it with.
 *
 * All four verdicts of the vocabulary appear, and that is the point rather
 * than a coincidence: a suite where every case passes or fails cannot tell a
 * rule that judged from one that could not, and `unknown` is the verdict the
 * whole failure taxonomy converges on
 * (`../../../../docs/reference/custom-rules.md`). The two `unknown` cases come
 * from opposite directions — evidence that contradicts itself (an edge naming
 * a project the model does not declare) and parameters that are not there to
 * read — so an SDK that collapsed either one into `pass` has a case that goes
 * red rather than a green suite with a quieter law.
 *
 * @type {Readonly<Record<string, "pass"|"fail"|"unknown"|"not_applicable">>}
 */
export const EXPECTED_VERDICTS = Object.freeze({
  "edge-into-an-undeclared-project": "unknown",
  "edge-into-forbidden-tag": "fail",
  "every-edge-clean": "pass",
  "no-project-carries-the-tag": "not_applicable",
  "params-without-the-tag": "unknown",
});

/**
 * The fixture names, in the order the expectations declare them.
 *
 * @returns {string[]}
 */
export function fixtureNames() {
  return Object.keys(EXPECTED_VERDICTS);
}

/**
 * The disagreements between a set of documents that must all be identical.
 *
 * Takes records rather than reading anything, so its own test needs no
 * filesystem — the split `../../../../AGENTS.md` states for the gate scripts,
 * for the same reason. The first entry is the reference; every later one is
 * compared against it, and the answer names both sides so a failure says which
 * copy moved rather than only that two of them differ.
 *
 * @param {Array<{name: string, value: string}>} documents Two or more.
 * @returns {string[]} One sentence per disagreement; empty when all agree.
 */
export function disagreements(documents) {
  if (!Array.isArray(documents) || documents.length < 2) {
    throw new Error(
      `lattice: disagreements needs at least two documents to compare, got ` +
        `${Array.isArray(documents) ? documents.length : typeof documents} — a parity check over ` +
        `one document is a check that can never fail.`,
    );
  }
  const [reference, ...rest] = documents;
  return rest
    .filter((document) => document.value !== reference.value)
    .map(
      (document) =>
        `${document.name} disagrees with ${reference.name}: they must be byte-identical copies of one document`,
    );
}

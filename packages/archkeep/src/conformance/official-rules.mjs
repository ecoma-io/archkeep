/**
 * The official generic rules, as facts a conformance suite can be driven
 * from — and the verdict every shipped artifact must reproduce.
 *
 * `../../../archkeep-rules/` is the package that ships the official rule
 * artifacts: each entry of its `catalog.json` names a committed `.wasm` under
 * its `rules/`, pinned by the sha256 in the same entry. Nothing in the engine
 * reads that catalog — a consumer's own `customRules` row remains the only
 * declaration `check` loads (`../../../archkeep-rules/README.md` states the
 * boundary, and `../../../../docs/reference/policy-schema.md` holds the row).
 * What this module feeds is the gate that keeps the catalog honest anyway:
 * every artifact it advertises must load through the REAL host at the digest
 * the catalog pins, and must answer its recorded fixtures with the recorded
 * verdicts.
 *
 * ## Why this lives in `src/conformance/`
 *
 * The same reason `./rule-sdks.mjs` does: this directory is where one verdict
 * is put beside another, excluded from the published package
 * (`../../package.json`'s `files`), so a suite that reads a sibling package's
 * committed bytes costs a consumer nothing. It reads those files and imports
 * nothing from them, so the row in `../../../../module-boundaries.config.mjs`
 * that keeps the rules package and the engine apart is untouched — and the
 * rules package cannot reach the host by import either, which is why the
 * host-side proof lives HERE rather than there.
 *
 * ## The three files that must agree, and who holds each agreement
 *
 * For every rule, three artefacts carry the same digest: the `.wasm` bytes,
 * the `.wasm.sha256` sidecar a consumer pastes into a policy row, and the
 * `sha256` field of the catalog entry. The rules package's own
 * `tests/artifact.rs` holds bytes-against-sidecar; its catalog validator holds
 * entry-against-bytes; this suite holds the cross-check a package-local test
 * cannot make — the sidecar and the entry must be the same STRING, and the
 * host must accept the artifact at that string (which is also the byte check,
 * made by the loader rather than re-hashed here: a recomputed hash would
 * prove only that sha256 is a function).
 */

import { readFileSync } from "node:fs";

/**
 * Where the official rules package lives, relative to this file. A path
 * rather than an import, deliberately — reading a sibling package's
 * committed bytes is what this suite does, and importing its code would make
 * the engine depend on it.
 */
export const RULES_PACKAGE = "../../../archkeep-rules";

/**
 * Every fixture, grouped by rule, with the verdict that rule's artifact must
 * answer it with.
 *
 * All four verdicts appear for each rule, and that is the point rather than a
 * coincidence: a rule whose fixtures only pass and fail cannot be caught
 * going quiet — `unknown` is what a rule answers when it could not judge, and
 * a fixture expecting it is the one that goes red if the rule starts
 * answering `pass` on input it never understood. The `malformed-params` and
 * `unknown-param-key` cases are the two halves of that guard: parameters that
 * are not there to read, and a key the rule never declared — a rule that
 * silently judged with defaults on either would pass this table's `pass`
 * fixtures while enforcing something nobody wrote.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, "pass"|"fail"|"unknown"|"not_applicable">>>>}
 */
export const EXPECTED_VERDICTS = Object.freeze({
  "tag-cardinality": Object.freeze({
    "below-minimum": "fail",
    "above-maximum": "fail",
    "within-range": "pass",
    "no-matching-projects": "not_applicable",
    "malformed-params": "unknown",
    "unknown-param-key": "unknown",
  }),
  "forbidden-tag-combination": Object.freeze({
    "project-carries-the-combination": "fail",
    "no-project-carries-all": "pass",
    "no-project-carries-any": "not_applicable",
    "malformed-params": "unknown",
    "duplicate-tags-in-params": "unknown",
  }),
  "max-fan-out": Object.freeze({
    "over-the-budget": "fail",
    "exactly-at-the-budget": "pass",
    "duplicate-edges-count-once": "pass",
    "no-matching-projects": "not_applicable",
    "edge-into-undeclared-project": "unknown",
    "malformed-params": "unknown",
    "unknown-param-key": "unknown",
  }),
  "max-fan-in": Object.freeze({
    "over-the-budget": "fail",
    "exactly-at-the-budget": "pass",
    "duplicate-edges-count-once": "pass",
    "no-matching-projects": "not_applicable",
    "edge-into-undeclared-project": "unknown",
    "malformed-params": "unknown",
    "unknown-param-key": "unknown",
  }),
});

/**
 * The catalog entries the suite judges, read from the committed catalog
 * rather than restated here — a rule added to the catalog without fixtures
 * below is a rule this gate cannot see, so the suite fails on it instead
 * (the integration test enforces the pairing in both directions).
 *
 * @returns {Array<Record<string, unknown>>}
 */
export function officialRules() {
  return readCatalog().rules;
}

/**
 * The parsed catalog, refusing loudly on anything unparsable — a malformed
 * catalog validating as "no rules" would be this gate going quiet exactly
 * where it exists to be loud.
 *
 * @returns {{version: number, rules: Array<Record<string, unknown>>}}
 */
function readCatalog() {
  const path = new URL(`${RULES_PACKAGE}/catalog.json`, import.meta.url);
  const catalog = JSON.parse(readFileSync(path, "utf8"));
  if (typeof catalog !== "object" || catalog === null || !Array.isArray(catalog.rules)) {
    throw new Error(`archkeep: ${path} is not a catalog — a "rules" array is required`);
  }
  return catalog;
}

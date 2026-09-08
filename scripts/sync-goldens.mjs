// Writes the engine's version into every golden-output corpus file that embeds
// it — the one link in the release version chain release-please cannot write
// for itself, in the same class as `sync-cargo-lock.mjs` but for the committed
// CLI byte-identity references.
//
// `src/report/json.mjs` reads `packages/archkeep/package.json` at runtime and
// emits `tool: { name, version }` in every `--format json` envelope. The golden
// corpus (`src/corpus/goldens/*.json`) is the committed byte-identity reference
// for those envelopes, so every one of them carries the engine's own version in
// its `tool.version` slot. release-please bumps the manifest via `extra-files`
// and has no mechanism to re-emit the goldens, so the number in `tool.version`
// goes stale from the moment a release pull request opens. The byte-identity
// gate (`golden-output.integration.test.mjs`) then fails on every version bump:
// it runs the real CLI, which reads the bumped manifest, and compares the
// output byte-for-byte against goldens still pinned at the old number. Measured
// on the 0.26.0 release pull request (#728): `Verify (core)` failed on the one
// assertion `tool.version` expected `0.25.0` (committed golden bytes) but the
// CLI emitted `0.26.0`.
//
// The rewrite is textual and scopes to the version slot only. Three shapes:
// every verb's JSON envelope carries `"version": "<ver>"` in its top-level
// `tool` block; the three diff-family verbs (`diff`, `delta`, `change`) echo
// the engine version a second time into the baseline they read back, as a
// nested `tool.version` and a flat `toolVersion`; those two must move with the
// same bump. Everything else that one might mistake for a version is
// deliberately NOT touched: the `"version": "2.1.0"` in the `.sarif` goldens
// is the SARIF specification version and the text goldens' "SARIF 2.1.0" is a
// static help string — neither is the engine's number, and rewriting either
// would corrupt the reference.
//
// A golden whose version slot records the manifest's number is already in step;
// a golden that records SOME other string in its slot is a loud failure
// (`process.exit(1)`) rather than a silent rewrite — a golden's version slot
// should never hold a stale editor's guess, and a drift there is exactly the
// silence the release lane refuses. `check-skills.mjs` (check 18) is the gate
// that fails when this has not been run, so the repair cannot silently stop
// being applied — the same pact `check 15` holds with `sync-cargo-lock.mjs`.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GOLDEN_CORPUS_DIR, PACKAGE_JSON, goldenToolVersion } from "./check-skills.mjs";

/**
 * The `.json` golden files — the ones that embed the engine's version in their
 * `tool.version` slot (and `diff`/`delta`/`change` echo it a second time). The
 * `.sarif` goldens' `version` is the SARIF spec's 2.1.0 and the `.text` goldens
 * are static help, so neither carries the engine's number and neither belongs
 * here. Listed explicitly so the release lane's repair push (`REFORMAT_FILES`
 * in `push-reformatted-files.mjs`) carries exactly these back to the branch —
 * a verb added to the corpus lands here in the same change that adds its
 * golden, and check 18 (`check-skills.mjs`) plus the golden gate hold the
 * version of every one of them.
 */
export const GOLDEN_JSON_FILES = [
  `${GOLDEN_CORPUS_DIR}/adr.json`,
  `${GOLDEN_CORPUS_DIR}/change.json`,
  `${GOLDEN_CORPUS_DIR}/check.json`,
  `${GOLDEN_CORPUS_DIR}/context.json`,
  `${GOLDEN_CORPUS_DIR}/debt.json`,
  `${GOLDEN_CORPUS_DIR}/decisions.json`,
  `${GOLDEN_CORPUS_DIR}/delta.json`,
  `${GOLDEN_CORPUS_DIR}/diff.json`,
  `${GOLDEN_CORPUS_DIR}/discover.json`,
  `${GOLDEN_CORPUS_DIR}/drift.json`,
  `${GOLDEN_CORPUS_DIR}/evolution.json`,
  `${GOLDEN_CORPUS_DIR}/explain.json`,
  `${GOLDEN_CORPUS_DIR}/fitness.json`,
  `${GOLDEN_CORPUS_DIR}/graph.json`,
  `${GOLDEN_CORPUS_DIR}/health.json`,
  `${GOLDEN_CORPUS_DIR}/history.json`,
  `${GOLDEN_CORPUS_DIR}/impact.json`,
  `${GOLDEN_CORPUS_DIR}/provenance.json`,
  `${GOLDEN_CORPUS_DIR}/reconcile.json`,
  `${GOLDEN_CORPUS_DIR}/report.json`,
  `${GOLDEN_CORPUS_DIR}/rules verify.json`,
  `${GOLDEN_CORPUS_DIR}/scenario.json`,
  `${GOLDEN_CORPUS_DIR}/trajectory.json`,
  `${GOLDEN_CORPUS_DIR}/waivers.json`,
];

/**
 * Replaces every occurrence of the recorded version with the manifest version,
 * returning the text and whether it changed. Scoped by construction: the old
 * string is the exact number the file already embeds in its slots, so a SARIF
 * `2.1.0` or a fixture literal — strings the chain never wrote — is never
 * matched.
 *
 * @param {string} text golden file contents
 * @param {string} oldVersion the recorded number to replace
 * @param {string} newVersion the version to record
 * @returns {{text: string, changed: boolean}}
 */
export function replaceVersion(text, oldVersion, newVersion) {
  if (!text.includes(oldVersion)) return { text, changed: false };
  return { text: text.split(oldVersion).join(newVersion), changed: true };
}

/**
 * Synchronises one golden file's embedded engine version with `packageVersion`.
 *
 * On a release branch the manifest is BUMPED and the goldens are stale, so a
 * golden whose slot records the OLD version is the ordinary repair case — a
 * rewrite, not a refusal. Only a slot that records neither the manifest's
 * number nor anything the diff-path can explain is refused.
 *
 * The return carries `result` (the new text, or `null` for a file with no
 * slot) and a separate `refused` flag, so a caller reads both fields without
 * needing to discriminate a union: `refused` is true only when the file's slot
 * holds a value the sync cannot explain.
 *
 * @param {string} text contents of one golden file
 * @param {string} packageVersion the version `packages/archkeep/package.json` declares
 * @returns {{result: {text: string, changed: boolean}|null, refused: boolean}}
 */
export function syncGoldenVersion(text, packageVersion) {
  const recorded = goldenToolVersion(text);
  if (recorded === null) {
    // A `.json` golden is an envelope and MUST carry the slot. A missing slot
    // on a JSON envelope is the silent direction (a golden that stopped
    // embedding the version), so it is refused rather than skipped.
    if (text.trimStart().startsWith("{")) return { result: null, refused: true };
    return { result: null, refused: false };
  }
  if (recorded === packageVersion) {
    return { result: { text, changed: false }, refused: false };
  }
  // The golden embeds a different number than the manifest declares — the
  // normal release-branch state. `replaceVersion` needs the exact recorded
  // string, so it runs against `recorded`, not a guessed new number.
  return {
    result: replaceVersion(text, recorded, packageVersion),
    refused: false,
  };
}

/**
 * Reads the manifest and every golden, writes the corrected goldens. The only
 * function here that touches the outside world — `syncGoldenVersion` decides.
 */
export function main() {
  const args = process.argv.slice(2);
  const root =
    args.indexOf("--root") === -1
      ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
      : args[args.indexOf("--root") + 1];

  const pkgPath = join(root, PACKAGE_JSON);
  const packageVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  if (typeof packageVersion !== "string" || !packageVersion) {
    console.error(
      `${PACKAGE_JSON} has no readable version, so there is no number to write ` +
        `into the goldens. Refusing to guess.`,
    );
    process.exit(1);
  }

  let syncedAny = false;
  let anyRefused = false;

  for (const relative of GOLDEN_JSON_FILES) {
    // `rules verify.json` is the one entry whose basename is not its filename.
    const path = join(root, relative);
    const text = readFileSync(path, "utf8");
    const outcome = syncGoldenVersion(text, packageVersion);
    // `refused` carries a boolean and `result` carries an object — two
    // different keys, so the `if` must leave the alternative unaccessed.
    if (outcome.refused) {
      anyRefused = true;
      console.error(
        `${relative} records a version other than ` +
          `"${packageVersion}" in its tool.version slot — drift the sync cannot ` +
          `explain. Regenerate the corpus or fix the slot; refusing to guess.`,
      );
      continue;
    }
    const rewritten = outcome.result;
    if (rewritten !== null && rewritten.changed) {
      writeFileSync(path, rewritten.text);
      syncedAny = true;
      const before = goldenToolVersion(text);
      console.log(`${relative}: tool.version "${before}" → "${packageVersion}"`);
    }
  }

  if (syncedAny) {
    console.log("golden corpus version slot synced to " + packageVersion);
  } else if (!anyRefused) {
    console.log("golden corpus already in step: nothing to write");
  }
  process.exit(anyRefused ? 1 : 0);
}

/**
 * Whether this file was RUN rather than imported, compared on real paths.
 * When it is a run, `--root` can name a checkout other than the one this file
 * ships in (the release lane passes `${{ github.workspace }}` explicitly), so
 * the guard cannot assume `process.argv[1]` matches the module URL. Matches the
 * class of the guard in `check-packages.mjs` and `push-reformatted-files.mjs` —
 * and it is NOT shared, for the reason `check-packages.mjs` documents on its own
 * copy: two dozen copies of the same five lines are the price of never drifting.
 * See `sync-cargo-lock.mjs` for the sibling this file is modelled on.
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) main();

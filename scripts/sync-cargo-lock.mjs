// Writes the Rust SDK's Cargo.lock version to whatever its Cargo.toml
// declares — the one link in the release version chain release-please cannot
// write for itself.
//
// release-please bumps `packages/archkeep-rule-sdk-rust/Cargo.toml` through the
// TOML updater in `../release-please-config.json`'s `extra-files`. It has no
// lockfile updater, and cargo's own answer — re-resolving the lock — reaches
// for the crates.io index, which is a network call on a branch that has none
// of its own reason to make one. So the bump lands in the manifest and the
// lock keeps the number before it, which is a lock that disagrees with its
// manifest: `cargo test --locked` and `cargo publish --locked`, the two
// commands `../.github/workflows/release.yml` runs before it uploads, both
// refuse to proceed through exactly that. Measured on the 0.10.0 release, not
// reasoned: the tag was cut, npm published, and crates.io received nothing.
//
// The rewrite is textual and touches exactly one line, because one line is all
// that changed. The crate is the lock's own path package: its entry carries no
// `source` and no `checksum`, so there is no resolution to redo and nothing a
// re-resolve would decide that this does not.
//
// This script is the fix; `check-skills.mjs` (check 15) is the gate that fails
// when it has not been run. Both are needed and neither substitutes for the
// other — the gate cannot repair a release branch, and a fix nothing checks is
// a fix that silently stops being applied.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARCHKEEP_RULES_CARGO_LOCK,
  RUST_SDK_CARGO_LOCK,
  RUST_SDK_CARGO_TOML,
  RUST_SDK_CRATE_NAME,
  tomlSectionVersion,
} from "./check-skills.mjs";

/**
 * Cargo.lock with one package's recorded version set to `version`.
 *
 * Takes text and returns text, so the decision is testable without a
 * filesystem — `main` below is the only part that touches one.
 *
 * Throws rather than reporting "nothing to do" when the lock does not name the
 * package: a lock with no entry for the crate and a lock already in step are
 * the same return value and opposite facts, and the second is the one that
 * would let a release branch through unbumped.
 *
 * @param {string} text full contents of Cargo.lock
 * @param {string} name the `[[package]]` entry to rewrite
 * @param {string} version the version to record
 * @returns {{text: string, changed: boolean}} the new text, and whether it differs
 */
export function syncCargoLockVersion(text, name, version) {
  const lines = text.split("\n");
  let inPackage = false;
  let matched = false;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (/^\[/.test(trimmed)) {
      inPackage = trimmed === "[[package]]";
      matched = false;
      continue;
    }
    if (!inPackage) continue;
    const nameMatch = /^name\s*=\s*"([^"]+)"/.exec(trimmed);
    if (nameMatch) {
      matched = nameMatch[1] === name;
      continue;
    }
    if (!matched || !/^version\s*=\s*"[^"]+"/.test(trimmed)) continue;
    const replacement = `version = "${version}"`;
    if (lines[i] === replacement) return { text, changed: false };
    lines[i] = replacement;
    return { text: lines.join("\n"), changed: true };
  }
  throw new Error(
    `Cargo.lock carries no [[package]] entry named "${name}" with a version line, so ` +
      `there is nothing to hold in step with Cargo.toml. Either the crate was renamed ` +
      `and this script still names the old one, or the lock is not the Rust SDK's.`,
  );
}

/**
 * Reads the manifest and the lock, writes the lock. The only function here
 * that touches the outside world.
 */
export function main() {
  const args = process.argv.slice(2);
  const root =
    args.indexOf("--root") === -1
      ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
      : args[args.indexOf("--root") + 1];

  const manifestPath = join(root, RUST_SDK_CARGO_TOML);
  const version = tomlSectionVersion(readFileSync(manifestPath, "utf8"), "[package]");
  if (version === "?") {
    console.error(
      `${RUST_SDK_CARGO_TOML} has no readable [package] version, so there is no number ` +
        `to write into the lock. Refusing to guess.`,
    );
    process.exit(1);
  }

  // Sync the Rust SDK's own lockfile.
  const sdkLockPath = join(root, RUST_SDK_CARGO_LOCK);
  const { text: sdkLockText, changed: sdkLockChanged } = syncCargoLockVersion(
    readFileSync(sdkLockPath, "utf8"),
    RUST_SDK_CRATE_NAME,
    version,
  );
  if (sdkLockChanged) {
    writeFileSync(sdkLockPath, sdkLockText);
    console.log(`${RUST_SDK_CARGO_LOCK} now records ${version}, matching ${RUST_SDK_CARGO_TOML}`);
  } else {
    console.log(`${RUST_SDK_CARGO_LOCK} already records ${version}; nothing to write`);
  }

  // Sync the rules catalog's lockfile, which has a path dependency on the SDK.
  // When the SDK bumps, the lock that records it as a dependency must bump too,
  // or `cargo check --locked` fails with the exact error measured in PR #344.
  const rulesLockPath = join(root, ARCHKEEP_RULES_CARGO_LOCK);
  const { text: rulesLockText, changed: rulesLockChanged } = syncCargoLockVersion(
    readFileSync(rulesLockPath, "utf8"),
    RUST_SDK_CRATE_NAME,
    version,
  );
  if (rulesLockChanged) {
    writeFileSync(rulesLockPath, rulesLockText);
    console.log(
      `${ARCHKEEP_RULES_CARGO_LOCK} now records ${version} for ${RUST_SDK_CRATE_NAME}, ` +
        `matching the SDK it path-depends on`,
    );
  } else {
    console.log(
      `${ARCHKEEP_RULES_CARGO_LOCK} already records ${version} for ${RUST_SDK_CRATE_NAME}; ` +
        `nothing to write`,
    );
  }

  if (!sdkLockChanged && !rulesLockChanged) {
    process.exit(0);
  }
}

/**
 * Whether this file was RUN rather than imported, compared on real paths.
 * See `check-packages.mjs` for the reason this exists and why it is not shared.
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

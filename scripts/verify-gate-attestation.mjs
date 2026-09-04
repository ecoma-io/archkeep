#!/usr/bin/env node
/**
 * The CLI face of the gate-attestation verifier — one summary line per file,
 * then a non-zero exit on any refusal.
 *
 * Every decision lives in `packages/archkeep/src/verify-gate-attestation.mjs`,
 * which is also the module the package's `./gate-attestation` subpath
 * re-exports. This file is argv, output destinations and the exit code — the
 * same split `cli.mjs` has from the engine: a consumer who installed the
 * package validates through the subpath and owns its own process, and the
 * repository's own lanes drive this script. Two faces, one implementation.
 */
import { readGateAttestation } from "../packages/archkeep/src/verify-gate-attestation.mjs";

/** The report: one line per attestation, then a non-zero exit on any refusal. */
function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    throw new Error(
      "archkeep: usage — node scripts/verify-gate-attestation.mjs <attestation.json> [...]",
    );
  }
  let refused = false;
  for (const path of paths) {
    try {
      const attestation = readGateAttestation(path);
      console.log(
        `ok   ${attestation.repository}@${attestation.version} at ${attestation.commit.slice(0, 12)} via '${attestation.command}'`,
      );
    } catch (cause) {
      refused = true;
      console.error(cause?.message ?? cause);
    }
  }
  if (refused) process.exit(1);
}

// Run only when invoked as a program, so importing this module for its pure
// halves does not validate anything as a side effect.
if (process.argv[1] && process.argv[1].endsWith("verify-gate-attestation.mjs")) main();

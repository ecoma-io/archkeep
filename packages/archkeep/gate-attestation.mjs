/**
 * The gate-attestation verifier's public face — what a consumer imports from
 * this package's `./gate-attestation` subpath to validate an attestation with
 * the version it actually installed.
 *
 * It holds no logic on purpose, the same bargain `./commands` (`commands.mjs`)
 * and `./nx` (`nx.mjs`) make: a named entry that is a re-export, so the
 * verifier can grow under `src/` without a second copy of any decision
 * appearing beside it.
 *
 * ```js
 * import { validateGateAttestation, readGateAttestation }
 *   from "@ecoma-io/archkeep/gate-attestation";
 * ```
 */
export {
  ATTESTED_PACKAGE,
  GATE_ATTESTATION_SCHEMA_VERSION,
  readGateAttestation,
  reachesCheckVerdict,
  validateGateAttestation,
  verifiedAdopters,
} from "./src/verify-gate-attestation.mjs";

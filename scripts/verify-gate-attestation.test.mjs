import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ATTESTED_PACKAGE,
  GATE_ATTESTATION_SCHEMA_VERSION,
  validateGateAttestation,
  verifiedAdopters,
} from "../packages/archkeep/src/verify-gate-attestation.mjs";
import { validateGateAttestation as validateGateAttestationFromEntry } from "../packages/archkeep/gate-attestation.mjs";

/**
 * The valid record every mutation below is cut from. Written as an object
 * literal rather than a fixture file: the validator takes parsed data, so the
 * tests need no filesystem — and every refusal case is one field away from
 * this shape, which is the point of pinning it here first.
 */
const VALID = {
  schemaVersion: GATE_ATTESTATION_SCHEMA_VERSION,
  repository: "acme/tree",
  commit: "a".repeat(40),
  tool: { name: ATTESTED_PACKAGE, version: "0.15.0" },
  gate: { command: "npx archkeep check", blocking: true },
  proof: { violationExitCode: 1, recoveryExitCode: 0 },
};

const validated = () => validateGateAttestation(structuredClone(VALID));

/** Runs the validator, returning the thrown message instead of the record. */
const refused = (record) => {
  try {
    validateGateAttestation(record);
  } catch (cause) {
    return String(cause?.message ?? cause);
  }
  return null;
};

test("accepts the documented example and returns the normalized record", () => {
  assert.deepEqual(validated(), {
    repository: "acme/tree",
    commit: "a".repeat(40),
    version: "0.15.0",
    command: "npx archkeep check",
  });
});

test("refuses a non-object attestation — null, array, primitive", () => {
  for (const shape of [null, [], "attestation", 1]) {
    const message = refused(shape);
    assert.match(message ?? "", /must be a single JSON object/u, `${typeof shape}`);
    // A shape this fundamental gets its own sentence, not the field list.
    assert.doesNotMatch(message ?? "", /schemaVersion/u);
  }
});

test("collects every problem in one refusal, not only the first", () => {
  const broken = { ...VALID, schemaVersion: 99, commit: "abc" };
  const message = refused({ ...broken, proof: { violationExitCode: 0, recoveryExitCode: 1 } });
  assert.match(message ?? "", /"schemaVersion"/u);
  assert.match(message ?? "", /"commit"/u);
  assert.match(message ?? "", /violationExitCode/u);
  assert.match(message ?? "", /recoveryExitCode/u);
});

test("refuses a schemaVersion it does not know, in both directions", () => {
  for (const version of [undefined, 0, 2, "1", null]) {
    assert.match(refused({ ...VALID, schemaVersion: version }) ?? "", /"schemaVersion"/u);
  }
});

test("refuses a repository that cannot name an outside workspace", () => {
  for (const repository of [undefined, "", "just-a-name", "owner/", "/repo", "own er/repo"]) {
    assert.match(
      refused({ ...VALID, repository }) ?? "",
      /"repository" must be 'owner\/name'/u,
      JSON.stringify(repository),
    );
  }
});

test("refuses anything but a full 40-hex commit", () => {
  for (const commit of [
    undefined,
    "",
    "abc123",
    "HEAD",
    `${"a".repeat(39)}`,
    `${"A".repeat(40)}`,
  ]) {
    assert.match(refused({ ...VALID, commit }) ?? "", /full 40-hex SHA/u, JSON.stringify(commit));
  }
});

test("refuses a tool block naming any other package or a non-semver version", () => {
  assert.match(
    refused({ ...VALID, tool: { name: "left-pad", version: "1.0.0" } }) ?? "",
    /tool\.name/u,
  );
  for (const version of [undefined, "^0.15.0", "latest", "v0.15.0", "0.15"]) {
    assert.match(
      refused({ ...VALID, tool: { name: ATTESTED_PACKAGE, version } }) ?? "",
      /"tool\.version" must be a bare semver/u,
      JSON.stringify(version),
    );
  }
});

test("refuses gate.blocking false, missing, or spelled as a string", () => {
  for (const blocking of [undefined, false, "true", null]) {
    assert.match(
      refused({ ...VALID, gate: { command: "archkeep check", blocking } }) ?? "",
      /"gate\.blocking" must be true/u,
      JSON.stringify(blocking),
    );
  }
});

test("refuses a gate command that never reaches the boundary verdict", () => {
  for (const command of [undefined, "", "npx archkeep graph", "npm test"]) {
    assert.match(
      refused({ ...VALID, gate: { command, blocking: true } }) ?? "",
      /"gate\.command" must name the check invocation/u,
      JSON.stringify(command),
    );
  }
});

test("accepts an npm-script alias whose CI invocation reaches the check verdict", () => {
  // The real consumer's literal CI step: ecoma-io/action-agents runs
  // `"arch": "archkeep check"` from `package.json`, CI runs `pnpm arch`.
  for (const command of [
    "pnpm arch",
    "npm run arch",
    "yarn arch",
    "pnpm archkeep",
    "pnpm archkeep:check",
  ]) {
    const attestation = validateGateAttestation({
      ...VALID,
      gate: { command, blocking: true },
    });
    assert.equal(attestation.command, command, JSON.stringify(command));
  }
});

test("refuses a clearly-unrelated package-manager script alias", () => {
  // Narrowness direction: a gate that accepts every script name is the
  // failure mode. `test` and `build` are lifecycle names, not archkeep
  // aliases — and an alias whose name is not plausibly archkeep's does not
  // verifiably reach the boundary verdict.
  for (const command of ["npm run test", "pnpm build", "yarn lint", "pnpm format"]) {
    assert.match(
      refused({ ...VALID, gate: { command, blocking: true } }) ?? "",
      /"gate\.command" must name the check invocation/u,
      JSON.stringify(command),
    );
  }
});

test("refuses an arch-prefixed name that is not the tool's own alias", () => {
  // `archive` shares the prefix but is not an archkeep alias — the match is
  // the whole word `arch` or a name that begins `archkeep`, not any prefix.
  for (const command of ["pnpm archive", "npm run archive"]) {
    assert.match(
      refused({ ...VALID, gate: { command, blocking: true } }) ?? "",
      /"gate\.command" must name the check invocation/u,
      JSON.stringify(command),
    );
  }
});

test("demands exit 1 for the red direction — green-only proves nothing", () => {
  for (const violationExitCode of [undefined, 0, 2, 3, "1"]) {
    assert.match(
      refused({ ...VALID, proof: { violationExitCode, recoveryExitCode: 0 } }) ?? "",
      /"proof\.violationExitCode" must be 1/u,
      JSON.stringify(violationExitCode),
    );
  }
});

test("demands exit 0 for recovery — a permanently red pipeline satisfies nothing", () => {
  for (const recoveryExitCode of [undefined, 1, 3, "0"]) {
    assert.match(
      refused({ ...VALID, proof: { violationExitCode: 1, recoveryExitCode } }) ?? "",
      /"proof\.recoveryExitCode" must be 0/u,
      JSON.stringify(recoveryExitCode),
    );
  }
});

test("refuses unknown fields — claims nobody validates do not ride along", () => {
  const message = refused({
    ...VALID,
    adoptersNote: "trust us",
    signature: "deadbeef",
  });
  assert.match(message ?? "", /unknown field\(s\) "adoptersNote", "signature"/u);
});

test("verifiedAdopters reduces records to owner/name@version entries", () => {
  const first = validated();
  const second = validateGateAttestation({
    ...VALID,
    repository: "other/monorepo",
    tool: { name: ATTESTED_PACKAGE, version: "0.14.0" },
  });
  assert.deepEqual(verifiedAdopters([first, second], null), [
    "acme/tree@0.15.0",
    "other/monorepo@0.14.0",
  ]);
});

test("verifiedAdopters refuses an attested version the registry never published", () => {
  const attestation = validated();
  assert.throws(() => verifiedAdopters([attestation], ["0.14.0"]), /has never\s+published/u);
  // The same registry document holding the version passes.
  assert.deepEqual(verifiedAdopters([attestation], ["0.14.0", "0.15.0"]), ["acme/tree@0.15.0"]);
});

test("verifiedAdopters collapses repeated verification of the same adopter", () => {
  // The recovery chain produces two artifacts for one repository (red and
  // green halves of the same proof). Re-running readiness over both must not
  // print the same `owner/name@version` entry twice.
  const first = validated();
  const sameAgain = validateGateAttestation({
    ...VALID,
    commit: "b".repeat(40),
  });
  assert.deepEqual(verifiedAdopters([first, sameAgain], null), ["acme/tree@0.15.0"]);
  // A genuinely different repository still appears beside it.
  const other = validateGateAttestation({
    ...VALID,
    repository: "other/monorepo",
  });
  assert.deepEqual(verifiedAdopters([first, sameAgain, other], null), [
    "acme/tree@0.15.0",
    "other/monorepo@0.15.0",
  ]);
});

test("the package ships the verifier through a documented subpath export", () => {
  // A consumer installs this package and must be able to validate its own
  // attestation with the version it installed — not copy source out of this
  // repository. The manifest's `exports` map names the subpath and the
  // `files` array carries the entry file, and the re-export resolves.
  const manifest = JSON.parse(
    readFileSync(new URL("../packages/archkeep/package.json", import.meta.url), "utf8"),
  );
  assert.ok(
    manifest.exports["./gate-attestation"],
    'the "./gate-attestation" subpath must be exported',
  );
  assert.ok(
    manifest.files.includes("gate-attestation.mjs"),
    "the entry file must ship in the published tree",
  );
  // The re-export is the same functions the tests above exercised — one
  // implementation, two faces, no second opinion about what a verdict means.
  assert.equal(validateGateAttestationFromEntry, validateGateAttestation);
});

/**
 * The external blocking-gate attestation — the machine-readable form of
 * `../../docs/doctrine/roadmap.md`'s second 1.0 condition: a workspace OUTSIDE
 * this repository running `archkeep check` as a blocking gate.
 *
 * An attestation is a small JSON file an external consumer publishes. It
 * carries no verdict authority and proves nothing by existing: it is a claim,
 * structured tightly enough that a reviewer can check every named fact, and
 * this module is what checks the structure so the reviewer never has to.
 * `scripts/check-readiness.mjs` ingests validated attestations through
 * `--attestations`; `scripts/verify-gate-attestation.mjs` is the CLI face of
 * this module; the `./gate-attestation` package subpath is the installed face
 * a consumer reaches from its own tree, so an attestation can be validated
 * against the version that consumer actually installed rather than a clone of
 * this repository.
 *
 * ## What the validator decides, and what it refuses to decide
 *
 * It validates shape and internal consistency only. Three of those decisions
 * carry the whole design, each argued at its field below:
 *
 * - **A green-only run proves nothing** — the `proof` block demands both
 *   directions, because "we run Archkeep" without a demonstrated failure and
 *   recovery is indistinguishable from a command that exits 0 on everything.
 * - **The red direction must be exit 1** — archkeep's own documented contract
 *   (`docs/reference/exit-codes.md`): findings are 1, a run that could not
 *   complete is 3, and a gate failing on 3 is a broken install, not a boundary
 *   verdict. Demanding exactly 1 keeps "it crashed" from counting as "it
 *   blocked".
 * - **Unknown fields refuse** — an attestation proves exactly the fields
 *   below; a schema that silently accepts extra keys grows spellings nobody
 *   validates.
 *
 * What NO validator here can decide: whether the named commit exists, whether
 * CI actually ran, whether the run URLs are real. Those facts live outside any
 * file's reach, which is why readiness stays a report and the acceptance is a
 * human's — the module's job ends at making the claim precise enough to check.
 *
 * Security posture: this module executes nothing from the attestation, spawns
 * no child process, and treats every byte as untrusted data (`SECURITY.md`).
 * A malformed file is a refusal naming every problem found, never a partial
 * pass — an attestation with one bad field and nine good ones proves nothing,
 * so reporting the ten good ones beside it would be the silent direction.
 */
import { readFileSync } from "node:fs";

/** Bumped when a field's meaning changes, never reused. */
export const GATE_ATTESTATION_SCHEMA_VERSION = 1;

/** The only package whose adoption this condition speaks about. */
export const ATTESTED_PACKAGE = "@ecoma-io/archkeep";

/**
 * One external consumer's blocking-gate claim.
 *
 * @typedef {object} GateAttestation
 * @property {1} schemaVersion This format's version; a different number is a
 *   different format and is refused rather than guessed at.
 * @property {string} repository The consumer, `owner/name`.
 * @property {string} commit The full 40-hex SHA of the consumer commit the
 *   gate ran at — the binding that makes the evidence stale-detectable.
 * @property {{name: string, version: string}} tool Exactly
 *   `@ecoma-io/archkeep`, and the semver the gate ran.
 * @property {{command: string, blocking: true}} gate The command their CI
 *   runs, and the claim that it blocks — `false` here is a report, not a gate.
 * @property {{violationExitCode: 1, recoveryExitCode: 0}} proof Both
 *   directions demonstrated: a controlled violation failed the build with the
 *   findings exit code, and removing it restored green.
 */

/**
 * Whether the attested `gate.command` names an invocation that verifiably
 * reaches the boundary verdict through one of this package's documented entry
 * points.
 *
 * Two spellings count, and nothing else:
 *
 * 1. **The command names the check subcommand.** `/\bcheck\b/` matches
 *    `archkeep check`, `npx archkeep check`, `pnpm archkeep check`, and any
 *    npm-script alias whose own name carries `check` as a word
 *    (`archkeep:check`, `check-boundaries`) — every one of these is the check
 *    invocation on its face.
 * 2. **The command is a package-manager script alias whose name is this
 *    tool's own.** A consumer whose CI step is `pnpm arch` (an npm script
 *    defined as `archkeep check`) writes exactly what its CI runs. The alias
 *    name must be the whole word `arch` or begin `archkeep` — the spellings
 *    this package's own name produces — and must arrive through the
 *    package-manager script form (`pnpm`, `npm run`, `yarn`). `npm test`,
 *    `pnpm build` and `pnpm archive` are refused: a rule that accepted every
 *    script name would be a gate that verifies nothing.
 *
 * What no string test can decide: whether the alias actually resolves to
 * `archkeep check`. The attestation's `proof` block — exit 1 on a controlled
 * violation, exit 0 after recovery — is what demonstrates the gate works; the
 * command test exists to keep the field from naming something that could not
 * be that gate at all.
 *
 * @param {string} command The attested `gate.command`.
 * @returns {boolean}
 */
export function reachesCheckVerdict(command) {
  return (
    /\bcheck\b/u.test(command) ||
    /^(?:pnpm\s|npm\s+run\s|yarn\s+)(?:arch\b|archkeep)/u.test(command)
  );
}

/**
 * Validates one parsed attestation, returning the normalized record readiness
 * ingests. Throws naming EVERY problem, because an attestation is accepted
 * whole or not at all.
 *
 * @param {unknown} record The parsed JSON document.
 * @returns {{repository: string, commit: string, version: string, command: string}}
 * @throws {Error} On the first round-trip where anything is wrong — with
 *   every wrong thing named.
 */
export function validateGateAttestation(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(
      "archkeep: a gate attestation must be a single JSON object — got " +
        `${record === null ? "null" : Array.isArray(record) ? "an array" : typeof record}`,
    );
  }

  /** @type {string[]} */
  const problems = [];
  const r = /** @type {Record<string, unknown>} */ (record);

  if (r.schemaVersion !== GATE_ATTESTATION_SCHEMA_VERSION) {
    problems.push(
      `"schemaVersion" must be ${GATE_ATTESTATION_SCHEMA_VERSION}; got ` +
        `${JSON.stringify(r.schemaVersion) ?? "undefined"} — a different number is a ` +
        `different format, and reading one as the other would invent meanings`,
    );
  }

  if (
    typeof r.repository !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]*\/[A-Za-z0-9._-]+$/u.test(r.repository)
  ) {
    problems.push(
      `"repository" must be 'owner/name'; got ${JSON.stringify(r.repository) ?? "undefined"} — ` +
        `the condition is about a workspace OUTSIDE this repository, and a name this ` +
        `shape cannot hold cannot name one`,
    );
  }

  if (typeof r.commit !== "string" || !/^[0-9a-f]{40}$/u.test(r.commit)) {
    problems.push(
      `"commit" must be the full 40-hex SHA the gate ran at; got ` +
        `${JSON.stringify(r.commit) ?? "undefined"} — a short or symbolic ref could name ` +
        `a different commit tomorrow, which is how stale evidence goes unnoticed`,
    );
  }

  const tool = r.tool;
  if (tool === null || typeof tool !== "object" || Array.isArray(tool)) {
    problems.push(`"tool" must be an object; got ${tool === null ? "null" : typeof tool}`);
  } else {
    const t = /** @type {Record<string, unknown>} */ (tool);
    if (t.name !== ATTESTED_PACKAGE) {
      problems.push(
        `"tool.name" must be '${ATTESTED_PACKAGE}'; got ${JSON.stringify(t.name) ?? "undefined"} — ` +
          `this condition speaks about this package and no other`,
      );
    }
    if (typeof t.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(t.version)) {
      problems.push(
        `"tool.version" must be a bare semver (major.minor.patch); got ` +
          `${JSON.stringify(t.version) ?? "undefined"} — ranges and tags would make the ` +
          `claim unverifiable against a registry document`,
      );
    }
  }

  const gate = r.gate;
  if (gate === null || typeof gate !== "object" || Array.isArray(gate)) {
    problems.push(`"gate" must be an object; got ${gate === null ? "null" : typeof gate}`);
  } else {
    const g = /** @type {Record<string, unknown>} */ (gate);
    if (g.blocking !== true) {
      problems.push(
        `"gate.blocking" must be true; got ${JSON.stringify(g.blocking) ?? "undefined"} — ` +
          `a non-blocking run is a report about architecture, not a gate a build answers to`,
      );
    }
    if (
      typeof g.command !== "string" ||
      !reachesCheckVerdict(g.command) ||
      g.command.trim() === ""
    ) {
      problems.push(
        `"gate.command" must name the check invocation their CI runs; got ` +
          `${JSON.stringify(g.command) ?? "undefined"} — the command must reach the boundary ` +
          `verdict: either it names the check subcommand, or it is a package-manager script ` +
          `alias whose name is this tool's own (pnpm arch, npm run arch, pnpm archkeep…)`,
      );
    }
  }

  const proof = r.proof;
  if (proof === null || typeof proof !== "object" || Array.isArray(proof)) {
    problems.push(`"proof" must be an object; got ${proof === null ? "null" : typeof proof}`);
  } else {
    const p = /** @type {Record<string, unknown>} */ (proof);
    if (p.violationExitCode !== 1) {
      problems.push(
        `"proof.violationExitCode" must be 1 — archkeep's documented findings exit; got ` +
          `${JSON.stringify(p.violationExitCode) ?? "undefined"}. 0 would prove the gate ` +
          `never blocks, and 3 proves it could not look, not that it judged`,
      );
    }
    if (p.recoveryExitCode !== 0) {
      problems.push(
        `"proof.recoveryExitCode" must be 0 — removing the violation restored green; got ` +
          `${JSON.stringify(p.recoveryExitCode) ?? "undefined"}. Without the recovery half, ` +
          `a permanently red pipeline would satisfy this condition too`,
      );
    }
  }

  const known = new Set(["schemaVersion", "repository", "commit", "tool", "gate", "proof"]);
  const unknownKeys = Object.keys(r).filter((key) => !known.has(key));
  if (unknownKeys.length > 0) {
    problems.push(
      `unknown field(s) ${unknownKeys.map((k) => JSON.stringify(k)).join(", ")} — an ` +
        `attestation proves exactly the fields this format defines; extra keys would be ` +
        `claims nobody validates`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`archkeep: the gate attestation is not valid:\n - ${problems.join("\n - ")}`);
  }

  const t = /** @type {{name: string, version: string}} */ (r.tool);
  const g = /** @type {{command: string}} */ (r.gate);
  return {
    repository: /** @type {string} */ (r.repository),
    commit: /** @type {string} */ (r.commit),
    version: t.version,
    command: g.command,
  };
}

/**
 * Reduces validated attestations to what `scripts/check-readiness.mjs`'s
 * `evaluate` reads as `externalAdopters`. When a registry document was
 * supplied, the attested version must be one it published — an attestation
 * about a version nobody can install describes a gate that cannot exist yet.
 *
 * The same adopter arriving twice (a recovery chain's red and green halves,
 * or a re-run over the same file) collapses to one entry: readiness prints
 * one row per repository, not one per attestation file.
 *
 * @param {{repository: string, commit: string, version: string, command: string}[]} attestations
 *   Already-validated records, in file order.
 * @param {string[] | null} publishedVersions From `versionsFromRegistry`, or
 *   `null` when no registry document was supplied.
 * @returns {string[]} Distinct `owner/name@version` entries, first-seen order,
 *   ready for `adoptionRow`.
 * @throws {Error} When a registry document was supplied and an attested
 *   version is absent from it.
 */
export function verifiedAdopters(attestations, publishedVersions) {
  if (publishedVersions !== null) {
    for (const attestation of attestations) {
      if (!publishedVersions.includes(attestation.version)) {
        throw new Error(
          `archkeep: ${attestation.repository}'s attestation names ${ATTESTED_PACKAGE} ` +
            `${attestation.version}, which the supplied registry document has never ` +
            `published — a gate built from a version nobody can install proves nothing ` +
            `about the package consumers get`,
        );
      }
    }
  }
  /** @type {string[]} */
  const entries = [];
  const seen = new Set();
  for (const { repository, version } of attestations) {
    const entry = `${repository}@${version}`;
    if (!seen.has(entry)) {
      seen.add(entry);
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * Reads and validates one attestation file, naming the path in every error.
 *
 * @param {string} path
 * @returns {{repository: string, commit: string, version: string, command: string}}
 * @throws {Error}
 */
export function readGateAttestation(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(
      `archkeep: cannot read the gate attestation at '${path}': ${cause?.message ?? cause}`,
      { cause },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `archkeep: the gate attestation at '${path}' is not valid JSON: ${cause?.message ?? cause}`,
      { cause },
    );
  }
  try {
    return validateGateAttestation(parsed);
  } catch (cause) {
    throw new Error(`archkeep: ${path}\n${cause?.message ?? cause}`, { cause });
  }
}

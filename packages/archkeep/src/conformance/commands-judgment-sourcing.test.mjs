/**
 * The engine's canonical evaluators are the ONE home of the judgment the
 * exit-1 verdict commands run; a command that re-derived any of it on its own
 * would be a second opinion about what a violation means — the drift the
 * `governance-direction.test.mjs` invariant names, and the one direction the
 * audit's judgment-sourcing rows register as always-open. This gate pins the
 * canonical home of each evaluator and asserts the commands whose verdict
 * carries exit 1 source from it.
 *
 * What "judgment" means here is measured, not asserted: the canonical
 * evaluators below (`evaluateRun`, `judgeEdge`, `verdictFor`,
 * `classifyEvolution`, the fitness and suppression answers). Every command
 * whose verdict carries exit 1 (`cli.mjs` holds four exit codes; `check`,
 * `fitness`, `delta` and `change` hold the finding exits — `rules verify`
 * holds the same code for catalog-integrity, a separate judge this gate does
 * not pin) composes that judgment from `../rules/`, `../governance/` and
 * `../verdict.mjs` — measured on the four today: each imports at least one
 * canonical home, and none re-implements any of them.
 *
 * Two command-local verdict families are deliberately OUT of this gate's
 * bracket, because each is single-sited judgment that no other command
 * re-derives:
 *
 *  - `delta-classify.mjs` owns the introduced/resolved/unchanged
 *    classification (`classifyViolations` → `occurrenceClassification`).
 *    The gate lets it stand because its predicates are the canonical homes —
 *    it delegates `classifyEvolution` and `suppressionFate` — and it is not a
 *    CLI-visible command (`delta.mjs`/`change.mjs` invoke it), so no second
 *    face can drift from it.
 *  - `change.mjs` owns the reconciliation verdict axis
 *    (`reconciliationVerdict` → `reconcileDisposition`) — a change-specific
 *    "matched/undeclared/unfulfilled/unproven" judgment consumed only by
 *    `change.mjs` itself (`change.mjs:516`). Single-sited, so the "repo" that
 *    re-implements it is empty; it is documented as the one place the "command
 *    judgment comes from one home" reading is coarser than the tree.
 *
 * The roster is a hand-maintained list, deliberately closed: it must be
 * touched when the exit-code contract changes. `check` and `delta` stay pinned
 * because their judgment is the boundary-and-waiver pair; a new exit-1 verb
 * that re-implements a canonical name instead of importing it fails the teeth
 * test, and one that sources no canonical home fails the roster test.
 *
 * Mechanics mirror `governance-direction.test.mjs`: walk every non-test
 * `.mjs` under `src/commands/`, resolve static relative edges through the
 * shared `layer-edges.mjs` extractor (which masks comments and strings before
 * resolving, and `reImplements` masks the same way), prove the teeth before
 * the clean verdict, and assert a minimum module count so a broken walk
 * cannot pass.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { maskNonCode } from "../intent/mask-non-code.mjs";
import { staticRelativeSpecifiers } from "./layer-edges.mjs";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every non-test `.mjs` under `relativeDirs`.
 *
 * @param {...string} relativeDirs Package-relative source directories.
 * @returns {string[]} Package-relative posix paths.
 */
function srcModules(...relativeDirs) {
  const found = [];
  const walk = (relativeDir) => {
    const absolute = join(SRC_ROOT, relativeDir);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(posix.join(relativeDir, entry.name));
        continue;
      }
      if (entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs")) {
        found.push(posix.join(relativeDir, entry.name));
      }
    }
  };
  for (const relativeDir of relativeDirs) walk(relativeDir);
  return found.sort();
}

/**
 * The resolved relative edges one module's source carries.
 *
 * @param {string} relativePath Package-relative path of the importing module.
 * @param {string} raw Module source text.
 * @returns {{specifier: string, resolved: string}[]}
 */
function edgesOf(relativePath, raw) {
  return staticRelativeSpecifiers(raw).map((specifier) => ({
    specifier,
    resolved: posix.normalize(posix.join(posix.dirname(relativePath), specifier)),
  }));
}

/**
 * The edges one shipped module carries, read from the tree.
 *
 * @param {string} relativePath Package-relative path of the module.
 * @returns {{specifier: string, resolved: string}[]}
 */
function fileEdges(relativePath) {
  return edgesOf(relativePath, readFileSync(join(SRC_ROOT, relativePath), "utf-8"));
}

/**
 * The canonical judgment homes. A command must source its verdict from ONE of
 * these; a name re-implemented at module scope in a command is the anti-pattern
 * this gate exists to catch.
 *
 * @type {Record<string, string>} exported name → canonical home module.
 */
const CANONICAL = Object.freeze({
  evaluateRun: "rules/index.mjs",
  evaluateWithSuppressions: "rules/index.mjs",
  judgeEdge: "rules/edge-constraints.mjs",
  buildReachability: "rules/reachability.mjs",
  verdictFor: "verdict.mjs",
  classifyEvolution: "governance/evolution-event.mjs",
  fitnessVerdict: "governance/verdict.mjs",
  fitnessVerdictFor: "governance/fitness-registry.mjs",
  suppressionFate: "governance/waiver.mjs",
});

/**
 * The commands whose verdict carries exit 1 — the ones whose judgment must
 * source from the canonical homes. Aligned with the authoritative roster in
 * `cli.mjs`'s exit-code contract ("`check`, `fitness`, `delta` and `change`
 * are the verbs whose verdicts carry this code, plus `rules verify` — the
 * artifact-integrity fold `<docs/reference/exit-codes.md>` owns").
 *
 * `rules verify` (`commands/rules.mjs`) is deliberately absent: its judge is
 * catalog integrity, not a boundary evaluator — it verifies shipped rule
 * artifact digests, and the canonical homes this gate pins (`rules/`,
 * `governance/`, `verdict.mjs`) hold no rule and would wrongly constrain it.
 * `delta-classify` is likewise absent: it is a shared classification helper
 * `delta` and `change` invoke, not an exit-1 verb of its own.
 *
 * @type {readonly string[]}
 */
const VERDICT_COMMANDS = Object.freeze([
  "commands/check.mjs",
  "commands/delta.mjs",
  "commands/change.mjs",
  "commands/fitness.mjs",
]);

/**
 * Whether a command's module text statically defines one of the canonical
 * judgment names at module scope (the re-implementation anti-pattern), rather
 * than importing it.
 *
 * @param {string} raw Module source text.
 * @returns {string[]} The canonical names it re-implements.
 */
function reImplements(raw) {
  const names = [];
  // Codes only: comments and strings name judgment in prose, and a mention
  // that was never code would be a false positive — the same masking
  // discipline the shared extractor `layer-edges.mjs` applies before it
  // resolves edges, so a comment naming `const verdictFor =` can never turn
  // this scan red.
  const code = maskNonCode(raw);
  for (const name of Object.keys(CANONICAL)) {
    if (new RegExp(`\\bfunction\\s+${name}\\b`, "u").test(code)) {
      names.push(name);
    } else if (new RegExp(`\\bconst\\s+${name}\\s*=`, "u").test(code)) {
      names.push(name);
    }
  }
  return names;
}

describe("commands judgment sourcing — verdict judgment comes from ONE home", () => {
  const modules = srcModules("commands");

  it("catches a planted re-implementation — teeth before the clean verdict", () => {
    const raw =
      "function evaluateRun(importSites, graph, config) { return []; }\nexport const x = 1;\n";
    expect(reImplements(raw)).toEqual(["evaluateRun"]);
  });

  it("catches a planted verdictFor re-implementation as a const", () => {
    const raw = "export const verdictFor = (counts) => ({ status: 'ok' });\n";
    expect(reImplements(raw)).toEqual(["verdictFor"]);
  });

  it("ignores a comment or string that merely names a canonical — prose never re-implements", () => {
    // The silent direction this scan refused: a comment/string that mentions
    // `const verdictFor =` or `function evaluateRun` in prose is not a
    // re-implementation. It would be a false positive (a cleaned-up comment
    // turns CI red with zero code change) and, masked, must pass.
    const raw =
      "// const verdictFor = (counts) => ({ status: ok });\n" +
      "const doc = `function evaluateRun(importSites, graph, config) { return []; }`;\n" +
      "export const x = 1;\n";
    expect(reImplements(raw)).toEqual([]);
  });

  it("lets a command that imports canonical pass — importing is not re-implementing", () => {
    const raw =
      'import { evaluateRun } from "../rules/index.mjs";\n' +
      'import { verdictFor } from "../verdict.mjs";\n' +
      "export const x = 1;\n";
    expect(reImplements(raw)).toEqual([]);
  });

  it("scans the command modules — a walk that found nothing would prove nothing", () => {
    expect(modules.length).toBeGreaterThan(25);
    expect(modules).toContain("commands/check.mjs");
    expect(modules).toContain("commands/delta.mjs");
  });

  it("reads real edges — the clean verdict must be about a live scan", () => {
    const edgeCount = modules.reduce((count, from) => count + fileEdges(from).length, 0);
    expect(edgeCount).toBeGreaterThan(0);
  });

  it("the roster is its own documented identity — a verb lost here reds loudly", () => {
    // The silent-direction trap Regression caught: `VERDICT_COMMANDS` is a
    // closed list, so a future edit that DROPS a verb (say, the boundary
    // evaluator is moved out and the scan quietly narrows) would leave every
    // other test green. Pin the exact identity — the four exit-1 verbs, plus
    // the deliberate absences — so the roster's shape is part of the contract,
    // not a side effect of which commands happen to import a canonical today.
    expect(VERDICT_COMMANDS).toEqual([
      "commands/check.mjs",
      "commands/delta.mjs",
      "commands/change.mjs",
      "commands/fitness.mjs",
    ]);
  });

  it("the deliberately un-scanned helpers are named, so they are decisions not oversights", () => {
    // `rules verify` (`commands/rules.mjs`) and `delta-classify.mjs` are the
    // two command-layer files whose exit-1 judgment lives outside this gate's
    // canonical bracket — catalog integrity and the shared classification
    // helper respectively. Pinning them as PRESENT-but-absent names the
    // decision instead of letting an accidental drop read as a fix.
    expect(modules).toContain("commands/rules.mjs");
    expect(modules).toContain("commands/delta-classify.mjs");
    expect(VERDICT_COMMANDS).not.toContain("commands/rules.mjs");
    expect(VERDICT_COMMANDS).not.toContain("commands/delta-classify.mjs");
  });

  it("no exit-1 verdict command re-implements a canonical judgment name", () => {
    const offenders = VERDICT_COMMANDS.filter((from) => {
      const raw = readFileSync(join(SRC_ROOT, from), "utf-8");
      return reImplements(raw).length > 0;
    });
    expect(
      offenders.map(
        (from) =>
          `${from} re-implements a canonical judgment rather than importing it — the exit-1 ` +
          `verdict must source from ONE home (rules/, governance/, verdict.mjs), never a second ` +
          `opinion inside a command`,
      ),
    ).toEqual([]);
  });

  it("every exit-1 verdict command sources a canonical judgment home", () => {
    const missing = VERDICT_COMMANDS.filter((from) => {
      const edges = fileEdges(from);
      return !edges.some(({ resolved }) =>
        Object.values(CANONICAL).some((home) => resolved === home || resolved === `../${home}`),
      );
    });
    expect(missing.map((from) => `${from} sources no canonical judgment home at all`)).toEqual([]);
  });
});

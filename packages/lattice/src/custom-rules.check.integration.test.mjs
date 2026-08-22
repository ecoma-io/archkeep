import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { COMMAND_NAMES, EXIT, check, runCli } from "../cli.mjs";
import { INTENT_MESSAGE_IDS } from "./architecture-intent/judge.mjs";
import { readArtifactBytes } from "./commands/custom-rules.mjs";
import { computePolicyFingerprint } from "./commands/graph.mjs";
import { loadBoundaryConfigFile } from "./config.mjs";
import { buildRuleModule } from "./custom-rules/wasm-fixture.mjs";
import { GO_WORK_MESSAGE_IDS } from "./go-work.mjs";
import { FITNESS_FAILED_RULE_ID } from "./report/sarif.mjs";
import { MESSAGE_IDS } from "./rules/messages.mjs";
import { TSCONFIG_PATHS_MESSAGE_IDS } from "./tsconfig-paths.mjs";

/**
 * Custom rules through the real `check` command — the real policy loader, the
 * real evidence bundle, the real core-wasm host, and all three report faces —
 * with only the two seams `resolveCommandContext` already injects (the project
 * graph and the tracked-file list). The rule artifacts are REAL `.wasm` files
 * written into the fixture tree and hashed there, so the `sha256` a row pins is
 * the digest of the bytes the run actually reads: nothing here stubs the host,
 * the hash check, or the ABI.
 *
 * `depConstraints` is empty in every fixture, so no boundary rule decides
 * anything and each exit code below is the custom-rules axis alone.
 */

const RULE = "no-app-to-ring";
const FINDING = "reached-ring";
const UNPLACED = "unplaced-reach";
const REASON = "the ring's internals stay inside the ring";

const roots = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const write = (root, relativePath, text) => {
  mkdirSync(join(root, relativePath, ".."), { recursive: true });
  writeFileSync(join(root, relativePath), text);
};

const describeJson = () =>
  JSON.stringify({
    contract: 1,
    name: RULE,
    needs: ["model", "graph", "imports", "policy"],
    findings: [
      { id: FINDING, message: "the app layer reached a ring internal" },
      { id: UNPLACED, message: "a reach this rule could not place in a file" },
    ],
  });

const verdictJson = (overrides = {}) =>
  JSON.stringify({ contract: 1, verdict: "pass", findings: [], ...overrides });

/**
 * A fixture workspace: two real Go projects, one import between them, and
 * whatever `customRules` the case declares.
 *
 * `rule` is a `buildRuleModule` option bag; passing `null` writes NO artifact
 * at all, which is the "the declared law is missing" case. `declare: false`
 * writes a policy with no `customRules` export — the unchanged-workspace
 * control every additive change owes.
 *
 * @param {{rule?: object|null, declare?: boolean, sha256?: string}} [options]
 */
function workspace({ rule = {}, declare = true, sha256: pinned } = {}) {
  const root = mkdtempSync(join(tmpdir(), "custom-rules-check-"));
  roots.push(root);

  const artifact = `tools/rules/${RULE}.wasm`;
  let sha256 = pinned ?? "0".repeat(64);
  if (rule !== null) {
    const bytes = buildRuleModule({
      describeJson: describeJson(),
      verdictJson: verdictJson(),
      ...rule,
    });
    mkdirSync(join(root, "tools", "rules"), { recursive: true });
    writeFileSync(join(root, artifact), bytes);
    sha256 = pinned ?? createHash("sha256").update(bytes).digest("hex");
  }

  write(
    root,
    "module-boundaries.config.mjs",
    "export const depConstraints = [];\n" +
      "export const moduleBoundaryOptions = {\n" +
      "  allow: [],\n" +
      "  buildTargets: ['build'],\n" +
      "  enforceBuildableLibDependency: false,\n" +
      "  allowCircularSelfDependency: false,\n" +
      "  checkDynamicDependenciesExceptions: [],\n" +
      "  ignoredCircularDependencies: [],\n" +
      "  banTransitiveDependencies: false,\n" +
      "  checkNestedExternalImports: false,\n" +
      "};\n" +
      (declare
        ? "export const customRules = [\n" +
          `  { name: ${JSON.stringify(RULE)}, artifact: ${JSON.stringify(artifact)}, ` +
          `sha256: ${JSON.stringify(sha256)}, reason: ${JSON.stringify(REASON)} },\n` +
          "];\n"
        : ""),
  );
  write(
    root,
    "nx.json",
    `${JSON.stringify({
      plugins: [
        {
          plugin: "@ecoma-io/lattice/nx",
          options: { boundaryConfig: "module-boundaries.config.mjs" },
        },
      ],
    })}\n`,
  );
  write(root, "libs/app/go.mod", "module example.test/app\n\ngo 1.24\n");
  write(
    root,
    "libs/app/main.go",
    `// Package app is the layer the rule watches.
package app

import (
\t"example.test/ring"
)

var _ = ring.Name
`,
  );
  write(root, "libs/ring/go.mod", "module example.test/ring\n\ngo 1.24\n");
  write(root, "libs/ring/ring.go", 'package ring\n\nvar Name = "ring"\n');

  const graph = {
    nodes: {
      app: { name: "app", type: "lib", data: { root: "libs/app", tags: ["layer-app"] } },
      ring: { name: "ring", type: "lib", data: { root: "libs/ring", tags: ["layer-ring"] } },
    },
    dependencies: {
      app: [{ source: "app", target: "ring", type: "static" }],
      ring: [],
    },
  };
  const files = [
    "nx.json",
    "module-boundaries.config.mjs",
    "libs/app/go.mod",
    "libs/app/main.go",
    "libs/ring/go.mod",
    "libs/ring/ring.go",
    ...(rule === null ? [] : [artifact]),
  ];
  return {
    root,
    artifact,
    context: { cwd: root, readGraph: () => graph, listFiles: () => files },
    env: () => {
      const lines = { out: [], err: [] };
      return {
        out: (text) => lines.out.push(text),
        err: (text) => lines.err.push(text),
        lines,
        cwd: root,
        readGraph: () => graph,
        listFiles: () => files,
      };
    },
  };
}

/** A `fail` verdict naming one positioned finding and one with no place at all. */
const FAILING_VERDICT = verdictJson({
  verdict: "fail",
  findings: [
    {
      id: FINDING,
      message: "libs/app/main.go imports example.test/ring, which is ring-internal",
      sourceFile: "libs/app/main.go",
      line: 5,
      column: 2,
      project: "app",
    },
    { id: UNPLACED, message: "one more reach, with no file this rule could place it in" },
  ],
});

describe("a custom rule that passes", () => {
  it("leaves the exit code where a clean tree already had it, and says the rule ran", async () => {
    const w = workspace();
    const result = await check({ format: "text", config: null, paths: [] }, w.context);
    expect(result.customRuleFail).toBe(0);
    expect(result.customRuleUnknown).toBe(0);
    expect(await runCli(["check"], w.env())).toBe(EXIT.ok);
    expect(result.report).toContain(`✔ ${RULE}  judged this workspace and reported no finding`);
    expect(result.report).toContain(`reason      ${REASON}`);
    // The claim a reader needs: which of the four each declared rule reached.
    expect(result.report).toContain(
      "✔ custom rules: 1 passed, 0 failed, 0 unknown, 0 not applicable",
    );
  });

  it("names the rule, its verified digest and its verdict in the JSON envelope", async () => {
    const w = workspace();
    const { report } = await check({ format: "json", config: null, paths: [] }, w.context);
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.result.customRules).toEqual({
      checked: true,
      verdict: "pass",
      rules: [
        {
          verdict: "pass",
          name: RULE,
          evidence: {
            artifact: w.artifact,
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            findings: 0,
          },
          message: "judged this workspace and reported no finding",
          reason: REASON,
          findings: [],
        },
      ],
    });
  });
});

describe("a custom rule that fails", () => {
  it("fails the run and renders each finding at the position the rule stated", async () => {
    const w = workspace({ rule: { verdictJson: FAILING_VERDICT } });
    const { report, customRuleFail } = await check(
      { format: "text", config: null, paths: [] },
      w.context,
    );
    expect(customRuleFail).toBe(1);
    expect(await runCli(["check"], w.env())).toBe(EXIT.violations);
    expect(report).toContain(`✖ ${RULE}  reported 2 findings`);
    expect(report).toContain(`libs/app/main.go:5:2  custom/${RULE}/${FINDING}`);
    // A finding the rule could not place renders under its id alone — never a
    // fabricated line 1 pointing a reader at code the rule never named.
    expect(report).toContain(`\n  custom/${RULE}/${UNPLACED}\n`);
    expect(report).toContain("✖ custom rules: 0 passed, 1 failed, 0 unknown, 0 not applicable");
  });

  it("gives every finding a SARIF result that resolves to its own descriptor", async () => {
    const w = workspace({ rule: { verdictJson: FAILING_VERDICT } });
    const { report } = await check({ format: "sarif", config: null, paths: [] }, w.context);
    const { rules } = JSON.parse(report).runs[0].tool.driver;
    const results = JSON.parse(report).runs[0].results;

    // One descriptor per CATALOGUE entry, appended after every fixed id so no
    // existing `ruleIndex` moves.
    expect(rules.slice(-2).map((rule) => rule.id)).toEqual([
      `custom/${RULE}/${FINDING}`,
      `custom/${RULE}/${UNPLACED}`,
    ]);
    expect(rules.at(-2).properties).toEqual({ customRule: RULE, findingId: FINDING });

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(rules[result.ruleIndex].id).toBe(result.ruleId);
      expect(result.level).toBe("error");
      expect(result.message.text.length).toBeGreaterThan(0);
    }
    expect(results[0].locations).toEqual([
      {
        physicalLocation: {
          artifactLocation: { uri: "libs/app/main.go" },
          region: { startLine: 5, startColumn: 2 },
        },
      },
    ]);
    // No sourceFile, no location block at all — an absent location is honest,
    // a made-up one is not.
    expect(results[1].locations).toBeUndefined();
  });

  it("carries the same two findings in the JSON envelope, namespaced identically", async () => {
    const w = workspace({ rule: { verdictJson: FAILING_VERDICT } });
    const { report } = await check({ format: "json", config: null, paths: [] }, w.context);
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("findings");
    expect(envelope.exitCode).toBe(1);
    expect(envelope.decision).toEqual({ verdict: "fail" });
    expect(envelope.result.customRules.verdict).toBe("fail");
    expect(envelope.result.customRules.rules[0].findings).toEqual([
      {
        id: `custom/${RULE}/${FINDING}`,
        message: "libs/app/main.go imports example.test/ring, which is ring-internal",
        sourceFile: "libs/app/main.go",
        line: 5,
        column: 2,
        project: "app",
      },
      {
        id: `custom/${RULE}/${UNPLACED}`,
        message: "one more reach, with no file this rule could place it in",
      },
    ]);
    // The boundary axis is untouched: a custom rule adds a finding class, it
    // does not re-label one.
    expect(envelope.result.violations).toEqual([]);
  });
});

describe("a custom rule that could not judge", () => {
  it("exits 3 with the cause named, never a pass by omission", async () => {
    const w = workspace({ rule: { evaluateBehavior: "trap" } });
    const { report, customRuleUnknown, customRuleFail } = await check(
      { format: "text", config: null, paths: [] },
      w.context,
    );
    expect(customRuleUnknown).toBe(1);
    expect(customRuleFail).toBe(0);
    expect(await runCli(["check"], w.env())).toBe(EXIT.error);
    expect(report).toContain(`⚠ ${RULE}  custom rule "${RULE}": lattice_evaluate trapped`);
    expect(report).toContain("⚠ custom rules: 0 passed, 0 failed, 1 unknown, 0 not applicable");
  });

  it("names the could-not-look condition in the envelope's decision reason", async () => {
    const w = workspace({ rule: { evaluateBehavior: "trap" } });
    const { report } = await check({ format: "json", config: null, paths: [] }, w.context);
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("no-verdict");
    expect(envelope.exitCode).toBe(3);
    expect(envelope.decision.verdict).toBe("unknown");
    expect(envelope.decision.reason).toContain("1 custom rule could not be judged");
    expect(envelope.result.customRules.verdict).toBe("unknown");
    expect(envelope.result.customRules.rules[0].message).toContain("lattice_evaluate trapped");
  });

  it("reports an undetermined rule as SARIF trouble rather than as a finding", async () => {
    const w = workspace({ rule: { evaluateBehavior: "trap" } });
    const { report } = await check({ format: "sarif", config: null, paths: [] }, w.context);
    const run = JSON.parse(report).runs[0];
    expect(run.results).toEqual([]);
    expect(run.invocations[0].toolExecutionNotifications).toEqual([
      {
        level: "warning",
        message: {
          text: expect.stringContaining(`Custom rule "${RULE}" could not be judged:`),
        },
      },
    ]);
    // The descriptors are still there: the rule loaded, so what it can report
    // is known even though this run reached no verdict.
    expect(run.tool.driver.rules.at(-1).id).toBe(`custom/${RULE}/${UNPLACED}`);
  });
});

describe("a declared law that could not be loaded refuses the run", () => {
  it("never exits 0 when the declared artifact is missing", async () => {
    // The silent direction, end to end: a workspace declaring a rule whose
    // artifact is gone would otherwise judge the tree without it and report a
    // clean run — byte-identical to a workspace whose rule really passed.
    const w = workspace({ rule: null });
    const env = w.env();
    const exitCode = await runCli(["check"], env);
    expect(exitCode).toBe(EXIT.error);
    expect(exitCode).not.toBe(EXIT.ok);
    expect(env.lines.out).toEqual([]);
    expect(env.lines.err.join("\n")).toContain(
      `lattice: custom rule "${RULE}": the artifact "${w.artifact}" could not be read`,
    );
  });

  it("refuses a hash mismatch by name, the way a malformed config is refused", async () => {
    const w = workspace({ sha256: "a".repeat(64) });
    const env = w.env();
    expect(await runCli(["check"], env)).toBe(EXIT.error);
    expect(env.lines.err.join("\n")).toMatch(
      new RegExp(
        `lattice: custom rule "${RULE}": the artifact hashes to [0-9a-f]{64}, and the policy pinned`,
        "u",
      ),
    );
  });

  it("refuses a module that asks for an import, so no ambient capability is granted", async () => {
    const w = workspace({ rule: { withImport: true } });
    const env = w.env();
    expect(await runCli(["check"], env)).toBe(EXIT.error);
    expect(env.lines.err.join("\n")).toContain("the contract grants no imports");
  });
});

describe("readArtifactBytes, the reader an unscoped run uses when nothing is injected", () => {
  // Every other custom-rule test hands `customRulesForCheck` a `readArtifact`
  // of its own, so the reader `check` actually runs was the one statement in
  // `./commands/custom-rules.mjs` that no test executed — and the statement it
  // was is the containment check. That check is the ONLY thing standing
  // between a declared law and bytes the workspace never committed:
  // `./config.mjs`'s `artifactPathProblem` reads the declared STRING, and a
  // symlink is not spelled in a string (`./containment.mjs`, the read-side
  // escape). Deleting the line leaves every other case in this file green.

  /** A directory outside any workspace, holding bytes a policy might pin. */
  function outside(bytes) {
    const dir = mkdtempSync(join(tmpdir(), "custom-rules-outside-"));
    roots.push(dir);
    const path = join(dir, "planted.wasm");
    writeFileSync(path, bytes);
    return path;
  }

  it("hands back exactly the bytes at a path inside the workspace", () => {
    const w = workspace();
    const read = readArtifactBytes(w.root);
    expect(Uint8Array.from(read(w.artifact))).toEqual(
      Uint8Array.from(readFileSync(join(w.root, w.artifact))),
    );
  });

  it("answers null for an artifact that is not there, rather than throwing", () => {
    // `null` is the whole vocabulary this reader has for "no bytes": the
    // caller turns all three ways of not arriving into one refusal, and a
    // throw here would escape as something no failure class owns.
    const w = workspace({ rule: null });
    expect(readArtifactBytes(w.root)(w.artifact)).toBeNull();
  });

  it("answers null for a symlink whose target is outside the workspace", () => {
    // The bytes at the other end are a REAL module that hashes to exactly what
    // the row pins, so nothing downstream would have refused them: the digest
    // check passes, the module compiles, the ABI is satisfied. The only reason
    // this is not the law is where the bytes live, and this is the only line
    // that asks.
    const w = workspace();
    const planted = outside(readFileSync(join(w.root, w.artifact)));
    unlinkSync(join(w.root, w.artifact));
    symlinkSync(planted, join(w.root, w.artifact));

    expect(readArtifactBytes(w.root)(w.artifact)).toBeNull();
  });

  it("refuses the whole run over such a symlink, naming the rule", async () => {
    // The same escape through the real command, because a reader that answers
    // `null` and a run that refuses are two claims, and only the second one is
    // what a consumer sees. Exit 3 and not a word on stdout: a law that
    // resolves outside the tree is refused the way a malformed config is,
    // never judged and reported clean.
    const w = workspace();
    const planted = outside(readFileSync(join(w.root, w.artifact)));
    unlinkSync(join(w.root, w.artifact));
    symlinkSync(planted, join(w.root, w.artifact));

    const env = w.env();
    const exitCode = await runCli(["check"], env);
    expect(exitCode).toBe(EXIT.error);
    expect(exitCode).not.toBe(EXIT.ok);
    expect(env.lines.out).toEqual([]);
    expect(env.lines.err.join("\n")).toContain(
      `lattice: custom rule "${RULE}": the artifact "${w.artifact}" could not be read`,
    );
  });
});

describe("a path-scoped run", () => {
  it("answers not_applicable for every declared rule and leaves the exit code alone", async () => {
    const w = workspace({ rule: { verdictJson: FAILING_VERDICT } });
    const { report, customRuleFail, customRuleUnknown } = await check(
      { format: "text", config: null, paths: ["libs/app"] },
      w.context,
    );
    // A rule that would have FAILED on a full run: the scoped run must neither
    // fail on its partial evidence nor quietly drop the rule.
    expect(customRuleFail).toBe(0);
    expect(customRuleUnknown).toBe(0);
    expect(await runCli(["check", "libs/app"], w.env())).toBe(EXIT.ok);
    expect(report).toContain(`◌ ${RULE}  does not apply to a path-scoped run`);
    expect(report).toContain("◌ custom rules: 0 passed, 0 failed, 0 unknown, 1 not applicable");
  });

  it("says so in SARIF too, so a scoped upload is not mistaken for an unruled workspace", async () => {
    const w = workspace({ rule: { verdictJson: FAILING_VERDICT } });
    const { report } = await check(
      { format: "sarif", config: null, paths: ["libs/app"] },
      w.context,
    );
    const run = JSON.parse(report).runs[0];
    expect(run.results).toEqual([]);
    expect(run.invocations[0].toolExecutionNotifications[0].message.text).toContain(
      `Custom rule "${RULE}" did not apply to this run:`,
    );
  });

  it("states the same not_applicable in the JSON envelope, with its reason", async () => {
    const w = workspace({ rule: { verdictJson: FAILING_VERDICT } });
    const { report } = await check(
      { format: "json", config: null, paths: ["libs/app"] },
      w.context,
    );
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("ok");
    expect(envelope.result.customRules.verdict).toBe("not_applicable");
    expect(envelope.result.customRules.rules[0].notApplicableReason).toContain(
      "needs a full, unscoped run",
    );
  });
});

describe("a workspace that declares no custom rules", () => {
  it("gets the byte-for-byte report it got before this section existed", async () => {
    const w = workspace({ rule: null, declare: false });
    const { report } = await check({ format: "text", config: null, paths: [] }, w.context);
    const fingerprint = computePolicyFingerprint(
      await loadBoundaryConfigFile(join(w.root, "module-boundaries.config.mjs")),
    );
    expect(report).toBe(
      `policy  module-boundaries.config.mjs — fingerprint ${fingerprint}\n\n` +
        "✔ no boundary violations (1 import in 2 files across 2 projects)",
    );
  });

  it("leaves the customRules key absent from the envelope, never written as null", async () => {
    const w = workspace({ rule: null, declare: false });
    const { report } = await check({ format: "json", config: null, paths: [] }, w.context);
    const envelope = JSON.parse(report);
    expect("customRules" in envelope.result).toBe(false);
    expect(envelope.status).toBe("ok");
  });

  it("leaves the SARIF rule catalogue exactly as long as it was", async () => {
    const w = workspace({ rule: null, declare: false });
    const { report } = await check({ format: "sarif", config: null, paths: [] }, w.context);
    const ids = JSON.parse(report).runs[0].tool.driver.rules.map((rule) => rule.id);
    expect(ids).toEqual([
      ...MESSAGE_IDS,
      ...GO_WORK_MESSAGE_IDS,
      ...TSCONFIG_PATHS_MESSAGE_IDS,
      ...INTENT_MESSAGE_IDS,
      FITNESS_FAILED_RULE_ID,
    ]);
  });
});

describe("--evidence-out, the sandbox's window", () => {
  // The sandbox that makes a custom rule deterministic is what makes one hard
  // to debug: a rule that answers `unknown` cannot show its author what it
  // read. These cases pin the answer — the exact document, on disk, for every
  // declared rule, including the rules that failed to reach a verdict.

  /** A directory to write bundles into, cleaned up with the fixture roots. */
  const evidenceDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "custom-rules-evidence-"));
    roots.push(dir);
    return dir;
  };

  it("writes the exact document the rule was judged over, one file per rule", async () => {
    const fixture = workspace();
    const dir = evidenceDir();
    const env = fixture.env();

    expect(await runCli(["check", "--evidence-out", dir], env)).toBe(EXIT.ok);

    const bundle = JSON.parse(readFileSync(join(dir, `${RULE}.json`), "utf8"));
    expect(bundle.contract).toBe(1);
    expect(bundle.rule).toEqual({ name: RULE, params: {} });
    // All four kinds, each carrying the run's real facts — a window that
    // showed a rule's name and nothing else would not let an author replay
    // anything.
    expect(Object.keys(bundle).sort()).toEqual([
      "contract",
      "graph",
      "imports",
      "model",
      "policy",
      "rule",
    ]);
    expect(bundle.model.projects.map((project) => project.name)).toEqual(["app", "ring"]);
    expect(bundle.graph.edges).toEqual([{ source: "app", target: "ring", type: "static" }]);
    expect(bundle.imports).toHaveLength(1);
    expect(bundle.imports[0].sourceProject).toBe("app");
    expect(bundle.policy.depConstraints).toEqual([]);
  });

  it("writes the bundle for a rule that could NOT judge, which is when it is needed", async () => {
    // The whole point. A rule that traps leaves its author with a reason and
    // no way to reproduce the run; the evidence is built before evaluation,
    // so it survives the trap and reaches the directory anyway.
    const fixture = workspace({ rule: { evaluateBehavior: "trap" } });
    const dir = evidenceDir();
    const env = fixture.env();

    expect(await runCli(["check", "--evidence-out", dir], env)).toBe(EXIT.error);
    expect(JSON.parse(readFileSync(join(dir, `${RULE}.json`), "utf8")).contract).toBe(1);
    expect(env.lines.err.join("\n")).toContain("1 evidence bundle");
  });

  it("leaves the verdict alone — a debugging flag never moves an exit code", async () => {
    const fixture = workspace({ rule: { verdictJson: FAILING_VERDICT } });
    const dir = evidenceDir();

    expect(await runCli(["check", "--evidence-out", dir], fixture.env())).toBe(EXIT.violations);
    expect(await runCli(["check"], fixture.env())).toBe(EXIT.violations);
  });

  it("says so out loud when a workspace declares no custom rule", async () => {
    // An empty directory is byte-identical to "your rules' evidence is fine",
    // which is the silent direction wearing a debugging flag's name.
    const fixture = workspace({ declare: false });
    const dir = evidenceDir();
    const env = fixture.env();

    expect(await runCli(["check", "--evidence-out", dir], env)).toBe(EXIT.ok);
    expect(readdirSync(dir)).toEqual([]);
    expect(env.lines.err.join("\n")).toContain("declares no customRules");
  });

  it("says so out loud on a path-scoped run, naming why there is no bundle", async () => {
    const fixture = workspace();
    const dir = evidenceDir();
    const env = fixture.env();

    expect(await runCli(["check", "libs/app", "--evidence-out", dir], env)).toBe(EXIT.ok);
    expect(readdirSync(dir)).toEqual([]);
    expect(env.lines.err.join("\n")).toContain("path-scoped run");
  });

  it("refuses a directory that does not exist, naming the flag the user typed", async () => {
    // The message must not blame `--output`: a refusal that names a flag the
    // user never typed sends them to the wrong argument.
    const fixture = workspace();
    const env = fixture.env();

    expect(await runCli(["check", "--evidence-out", join(fixture.root, "nope")], env)).toBe(
      EXIT.error,
    );
    const stderr = env.lines.err.join("\n");
    expect(stderr).toContain("--evidence-out");
    expect(stderr).not.toContain("--output");
  });

  it("is `check`'s alone — every other command rejects it as an unknown option", async () => {
    // A flag a command accepts and then ignores is the silent direction in
    // argv: the author asks for the evidence, the run exits 0, and the empty
    // directory reads as "your evidence is fine". Six commands carried a
    // copy-pasted declaration of this flag with no `evidenceOut` in their
    // defaults and no code reading it — `docs/usage/configuration.md` said it
    // was `check`'s alone the whole time.
    //
    // Exhaustive over `COMMAND_NAMES` rather than over a list written here,
    // for the reason `scripts/check-packages.mjs` parses `ci.yml`: a command
    // added later with the block pasted in again fails this on the day it
    // lands. A custom rule is judged nowhere but `check`, so `check` is the
    // one row that may accept it.
    const fixture = workspace();
    const dir = evidenceDir();

    for (const command of COMMAND_NAMES) {
      if (command === "check") continue;
      const env = fixture.env();
      const exit = await runCli([command, "--evidence-out", dir], env);
      const stderr = env.lines.err.join("\n");
      expect(
        { command, exit, named: stderr.includes("unknown option '--evidence-out'") },
        `${command} must refuse --evidence-out`,
      ).toEqual({ command, exit: EXIT.usage, named: true });
    }

    // The other half of the claim, so a change that deleted the flag outright
    // could not pass this test by making every command refuse it.
    const accepted = fixture.env();
    expect(await runCli(["check", "--evidence-out", dir], accepted)).toBe(EXIT.ok);
    expect(accepted.lines.err.join("\n")).not.toContain("unknown option");
  });

  it("writes nothing when the declared law could not be loaded at all", async () => {
    // A load failure refuses the run before any rule is judged, so there is
    // no evidence any rule was handed — writing one anyway would describe a
    // judgment that never happened.
    const fixture = workspace({ sha256: "9".repeat(64) });
    const dir = evidenceDir();
    const env = fixture.env();

    expect(await runCli(["check", "--evidence-out", dir], env)).toBe(EXIT.error);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("a run that declares a custom rule stays deterministic", () => {
  it("produces byte-identical JSON over two runs of an unchanged tree", async () => {
    // Determinism is a property of the whole chain, and the custom-rules fold
    // is the one link whose code this repository did not write. A rule that
    // iterated a hash map, or a host that serialized its evidence differently
    // on a second pass, would make the envelope a moving target for every
    // consumer diffing two runs — the property `docs/reference/json-output.md`
    // promises and the E2E sweep proves for every other command. It is asked
    // here rather than there because the fixture needs a real `.wasm`, and the
    // sweep's consumers are built from text files.
    const fixture = workspace({ rule: { verdictJson: FAILING_VERDICT } });

    const first = fixture.env();
    const second = fixture.env();
    expect(await runCli(["check", "--format", "json"], first)).toBe(EXIT.violations);
    expect(await runCli(["check", "--format", "json"], second)).toBe(EXIT.violations);

    expect(first.lines.out.join("\n")).toBe(second.lines.out.join("\n"));
    // And the custom-rule section is really in there — an identical pair of
    // envelopes that both forgot the rule would pass a bare equality check.
    expect(JSON.parse(first.lines.out.join("\n")).result.customRules.rules).toHaveLength(1);
  });
});

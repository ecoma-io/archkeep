import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { INTENT_MESSAGE_IDS, INTENT_MESSAGES } from "../architecture-intent/judge.mjs";
import { buildEvidenceBundle, serializeEvidenceBundle } from "../custom-rules/evidence.mjs";
import { evaluateCustomRule, loadCustomRule } from "../custom-rules/host.mjs";
import { buildRuleModule } from "../custom-rules/wasm-fixture.mjs";
import { GO_WORK_MESSAGE_IDS, GO_WORK_MESSAGES } from "../go-work.mjs";
import { MESSAGE_IDS, renderMessage } from "../rules/messages.mjs";
import { TSCONFIG_PATHS_MESSAGE_IDS, TSCONFIG_PATHS_MESSAGES } from "../tsconfig-paths.mjs";

import { FITNESS_FAILED_RULE_ID, buildSarifLog } from "./sarif.mjs";

/**
 * The real message table, the real constraint renderer, and every `messageId`
 * the engine can produce — driven together, because the failure this guards
 * against is not a wrong string. It is a file GitHub's `upload-sarif` rejects:
 * the job stays green, no annotation ever appears, and nothing says why.
 *
 * So the assertions below are GitHub's documented requirements for a code
 * scanning upload, restated as checks rather than trusted:
 * `version`, `tool.driver.name`, a `ruleId` that resolves in the catalogue, a
 * non-empty `message.text`, and a physical location whose `uri` is repository
 * relative with a 1-based `startLine`. The full 2.1.0 schema is a superset of
 * these; what is pinned here is the subset a rejected upload turns on.
 */

/** One violation per `messageId`, rendered through the real message table. */
const everyViolation = () =>
  MESSAGE_IDS.map((messageId, index) => ({
    sourceFile: `acme/libs/engine-domain/file-${index}.go`,
    line: index + 1,
    column: index + 2,
    specifier: "@acme/engine-adapters",
    kind: "static",
    messageId,
    message: renderMessage(messageId, { sourceTag: "layer:domain", tags: "layer:util", imp: "x" }),
    sourceProject: "engine-domain",
    targetProject: "engine-adapters",
    constraint: { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:util"] },
    data: {},
  }));

/**
 * One drift finding per go.work `messageId` — the missing-use one positionless
 * (`line: null`), the shape `compareGoWork` really emits for an entry that
 * does not exist, so the region-handling below is exercised on both branches.
 */
const everyDriftFinding = () =>
  GO_WORK_MESSAGE_IDS.map((messageId, index) => ({
    messageId,
    file: "go.work",
    line: messageId === "goWorkMissingUse" ? null : index + 1,
    column: messageId === "goWorkMissingUse" ? null : 2,
    directory: "acme/libs/engine-domain",
    project: messageId === "goWorkMissingUse" ? "engine-domain" : null,
    message: GO_WORK_MESSAGES[messageId],
  }));

/**
 * One dead-alias finding per paths hygiene `messageId` — positionless
 * (`line: null`), the only shape `judgeTsconfigPaths` emits, so the
 * artifact-only location branch is the one exercised.
 */
const everyDeadAliasFinding = () =>
  TSCONFIG_PATHS_MESSAGE_IDS.map((messageId) => ({
    messageId,
    file: "tsconfig.base.json",
    line: null,
    column: null,
    alias: "@acme/engine-domain",
    targets: ["acme/libs/engine-domain/src/index.ts"],
    message: TSCONFIG_PATHS_MESSAGES[messageId],
  }));

/**
 * One architecture-intent finding per intent `messageId` — positionless, the
 * only shape `judgeIntent` emits, so the artifact-only location branch is the
 * one exercised.
 */
const everyIntentFinding = () =>
  INTENT_MESSAGE_IDS.map((messageId) => ({
    rule: messageId,
    source: "acme/libs/engine-domain",
    target: "acme/libs/engine-adapters",
    boundaryFrom: "domain",
    boundaryTo: "adapters",
    message: INTENT_MESSAGES[messageId],
  }));

/**
 * One `fail` and one `unknown` fitness decision — the two verdicts
 * `buildSarifLog` renders at all (`pass`/`not_applicable` produce nothing,
 * same as a clean boundary). Unlike the message-id-driven kinds above, a
 * fitness function's `name` is workspace-declared rather than drawn from a
 * fixed catalogue, so there is no `*_MESSAGE_IDS` table to enumerate here.
 */
const everyFitnessDecision = () => [
  {
    name: "domain-may-not-reach-adapter",
    verdict: "fail",
    message: '1 edge carries "layer:domain" → "layer:adapter" — forbidden',
  },
  {
    name: "full-coverage",
    verdict: "unknown",
    message: "coverage-minimum cannot be judged for a scoped run",
  },
];

/**
 * A workspace-declared custom rule's catalogue and the decisions over it — a
 * `fail` whose two findings exercise both location branches, and one
 * `not_applicable`, which is the verdict every rule reaches on a path-scoped
 * run. Like a fitness function's name, a custom rule's ids are declared by the
 * workspace rather than drawn from a fixed table, so there is no `*_MESSAGE_IDS`
 * to enumerate — the catalogue IS the table, and it is what the descriptors
 * below are built from.
 */
const CUSTOM_CATALOGUE = [
  {
    ruleId: "custom/no-app-to-ring/reached-ring",
    rule: "no-app-to-ring",
    findingId: "reached-ring",
    message: "the app layer reached a ring internal",
  },
  {
    ruleId: "custom/no-app-to-ring/unplaced-reach",
    rule: "no-app-to-ring",
    findingId: "unplaced-reach",
    message: "a reach this rule could not place in a file",
  },
];

const everyCustomRuleDecision = () => [
  {
    verdict: "fail",
    name: "no-app-to-ring",
    evidence: { artifact: "tools/rules/no-app-to-ring.wasm", findings: 2 },
    message: "reported 2 findings",
    reason: "the ring's internals stay inside the ring",
    findings: [
      {
        id: "custom/no-app-to-ring/reached-ring",
        message: "acme/libs/engine-domain reaches the ring",
        sourceFile: "acme/libs/engine-domain/file-0.go",
        line: 3,
        column: 4,
        project: "engine-domain",
      },
      {
        id: "custom/no-app-to-ring/unplaced-reach",
        message: "one more reach, with no file this rule could place it in",
      },
    ],
  },
  {
    verdict: "not_applicable",
    name: "ring-tags-declared",
    evidence: { artifact: "tools/rules/ring-tags-declared.wasm", scoped: true },
    message: "does not apply to a path-scoped run",
    notApplicableReason: "this run was scoped to specific paths",
    reason: "every ring project declares its axis",
    findings: [],
  },
];

const log = buildSarifLog({
  violations: everyViolation(),
  failures: [
    { sourceFile: "acme/apps/site/app/app.vue", line: 2, column: 40, reason: "cannot resolve" },
    { sourceFile: "a/b.rs", line: null, column: null, reason: "could not be read" },
  ],
  goWork: { findings: everyDriftFinding(), moduleProjects: 2 },
  tsconfigPaths: { findings: everyDeadAliasFinding(), aliases: 3, unjudged: 0 },
  intent: { findings: everyIntentFinding() },
  fitness: everyFitnessDecision(),
  customRules: { catalogue: CUSTOM_CATALOGUE, decisions: everyCustomRuleDecision() },
  policy: { profile: null, source: "module-boundaries.config.mjs", fingerprint: "deadbeef" },
});

/**
 * An absolute path, a `file:` URI, or a `..` escape are the three shapes GitHub
 * cannot map onto a file in the checkout — the result is then dropped silently,
 * which is worse than a red upload. Stated once and asked of both fixtures
 * below: the hand-written log above, and the host-driven one at the end of this
 * file, where the path a rule actually named is what is being judged.
 *
 * @param {string} uri
 */
const expectRepositoryRelative = (uri) => {
  expect(uri.startsWith("/")).toBe(false);
  expect(uri).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
  expect(uri.split("/")).not.toContain("..");
};

describe("the SARIF log against what GitHub requires of an upload", () => {
  it("declares version 2.1.0 and a named driver, the two fields an upload is rejected without", () => {
    expect(log.version).toBe("2.1.0");
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0].tool.driver.name).toBe("lattice");
  });

  it("gives every rule the engine can report a descriptor with an id, so no finding is nameless", () => {
    const ids = log.runs[0].tool.driver.rules.map((rule) => rule.id);
    expect(ids).toEqual([
      ...MESSAGE_IDS,
      ...GO_WORK_MESSAGE_IDS,
      ...TSCONFIG_PATHS_MESSAGE_IDS,
      ...INTENT_MESSAGE_IDS,
      FITNESS_FAILED_RULE_ID,
      ...CUSTOM_CATALOGUE.map((entry) => entry.ruleId),
    ]);
    expect(ids.every((id) => typeof id === "string" && id !== "")).toBe(true);
  });

  it("appends a custom rule's descriptors after every fixed id, so no ruleIndex moves", () => {
    // The fixed ids' indices are computed as offsets from their tables'
    // lengths (`sarifResult` and friends). A workspace-declared descriptor
    // inserted anywhere but the end would renumber ids already shipped, and
    // every uploaded result would resolve to the wrong rule.
    const { rules } = log.runs[0].tool.driver;
    const fixed =
      MESSAGE_IDS.length +
      GO_WORK_MESSAGE_IDS.length +
      TSCONFIG_PATHS_MESSAGE_IDS.length +
      INTENT_MESSAGE_IDS.length +
      1;
    expect(rules[MESSAGE_IDS.indexOf(MESSAGE_IDS[0])].id).toBe(MESSAGE_IDS[0]);
    expect(rules[fixed - 1].id).toBe(FITNESS_FAILED_RULE_ID);
    expect(rules.slice(fixed).map((rule) => rule.id)).toEqual(
      CUSTOM_CATALOGUE.map((entry) => entry.ruleId),
    );
    // Every catalogue entry is described whether or not it fired: a rule named
    // only on the run that reported it is nameless on the next.
    expect(rules[fixed].properties).toEqual({
      customRule: "no-app-to-ring",
      findingId: "reached-ring",
    });
    expect(rules.at(-1).fullDescription.text).toBe(CUSTOM_CATALOGUE[1].message);
  });

  it("resolves every result's ruleId and ruleIndex against that catalogue", () => {
    const { rules } = log.runs[0].tool.driver;
    for (const result of log.runs[0].results) {
      expect(rules[result.ruleIndex]).toBeDefined();
      expect(rules[result.ruleIndex].id).toBe(result.ruleId);
    }
  });

  it("carries a non-empty message and one of SARIF's own levels on every result", () => {
    for (const result of log.runs[0].results) {
      expect(result.message.text.length).toBeGreaterThan(0);
      expect(["none", "note", "warning", "error"]).toContain(result.level);
    }
  });

  it("locates every result at a repository-relative path with a 1-based line and column", () => {
    for (const result of log.runs[0].results) {
      if (result.locations === undefined) {
        // The one result kind that carries NO location block: a custom rule's
        // finding that named no `sourceFile`. A rule may judge the workspace
        // as a whole, and SARIF has no way to say "somewhere in this
        // repository" — an omitted location is honest, a fabricated path is
        // an annotation on code the finding is not about.
        expect(result.ruleId).toBe("custom/no-app-to-ring/unplaced-reach");
        continue;
      }
      const { artifactLocation, region } = result.locations[0].physicalLocation;
      expectRepositoryRelative(artifactLocation.uri);
      if (
        result.ruleId === "goWorkMissingUse" ||
        result.ruleId === "tsconfigDeadPathAlias" ||
        INTENT_MESSAGE_IDS.includes(result.ruleId) ||
        result.ruleId === FITNESS_FAILED_RULE_ID
      ) {
        // The results about a thing that does not exist — a use entry never
        // written, an alias with no position in the parsed options, an
        // architecture-intent finding or a fitness verdict that judges the
        // graph rather than a source site: no region, rather than a
        // fabricated line 1 marking text the finding is not about.
        expect(region).toBeUndefined();
        continue;
      }
      expect(region.startLine).toBeGreaterThanOrEqual(1);
      expect(region.startColumn).toBeGreaterThanOrEqual(1);
    }
  });

  it("reports one result per violation, drift finding, dead alias, intent finding, failing fitness function and custom-rule finding", () => {
    expect(log.runs[0].results).toHaveLength(
      MESSAGE_IDS.length +
        GO_WORK_MESSAGE_IDS.length +
        TSCONFIG_PATHS_MESSAGE_IDS.length +
        INTENT_MESSAGE_IDS.length +
        1 + // the one `fail`-verdict fitness decision in `everyFitnessDecision()`
        2, // the two findings the one `fail`-verdict custom rule reported
    );
    // The two analysis failures, the one `unknown`-verdict fitness decision,
    // and the one `not_applicable` custom rule — a function the run could not
    // determine and a rule that did not apply are both trouble the tool hit
    // rather than verdicts it reached, the lane an unparseable file rides.
    // The `not_applicable` one is why this lane matters here: with no
    // notification, a scoped run over a workspace declaring custom rules would
    // upload a log byte-identical to one from a workspace that declares none.
    expect(log.runs[0].invocations[0].toolExecutionNotifications).toHaveLength(4);
    expect(
      log.runs[0].invocations[0].toolExecutionNotifications.map(
        (notification) => notification.message.text,
      ),
    ).toContain(
      'Custom rule "ring-tags-declared" did not apply to this run: does not apply to a path-scoped run',
    );
  });

  it("survives a JSON round trip unchanged, which is the only form GitHub ever sees", () => {
    expect(JSON.parse(JSON.stringify(log))).toEqual(log);
  });
});

/**
 * The custom-rule half of the same question, driven end to end rather than
 * from a fixture.
 *
 * Everything above judges a hand-written log, which can only ever confirm that
 * paths already spelled workspace-relative stay that way. A custom rule is the
 * one producer of a SARIF `uri` this engine did not write: it is wasm the
 * workspace declared, and it names its own `sourceFile`. So this block hands a
 * REAL rule a path, lets the REAL host judge it, and renders whatever survived
 * with the REAL `buildSarifLog` — the only arrangement in which an off-workspace
 * path can actually reach the formatter and be caught doing it.
 *
 * The mapping from verdict to decision mirrors `../commands/custom-rules.mjs`,
 * which is the module that does it in a run: an accepted verdict becomes a
 * `fail` decision whose findings carry the namespaced id, and a refused one
 * becomes an `unknown` decision carrying the host's own words.
 */
const CUSTOM_RULE = "no-app-to-ring";
const CUSTOM_FINDING = "reached-ring";
const CUSTOM_RULE_ID = `custom/${CUSTOM_RULE}/${CUSTOM_FINDING}`;
const CUSTOM_MESSAGE = "the app layer reached a ring internal";

const CUSTOM_DESCRIBE = {
  contract: 1,
  name: CUSTOM_RULE,
  needs: ["model", "graph", "imports", "policy"],
  findings: [{ id: CUSTOM_FINDING, message: CUSTOM_MESSAGE }],
};

/** The bytes a real run would hand a rule. */
const CUSTOM_EVIDENCE = serializeEvidenceBundle(
  buildEvidenceBundle({
    rule: { name: CUSTOM_RULE },
    projects: [{ name: "app", root: "libs/app", tags: ["layer-app"] }],
    edges: [{ source: "app", target: "ring", type: "static" }],
    imports: [
      {
        site: {
          sourceFile: "libs/app/main.go",
          line: 7,
          column: 2,
          specifier: "example.test/ring/internal",
          kind: "static",
          spelling: { path: false, relative: false },
          resolved: { target: "ring", file: "libs/ring/x.go", external: false, packageName: null },
        },
        sourceProject: "app",
      },
    ],
    policy: { depConstraints: [], options: {} },
  }),
);

const HOST_DRIVEN_CATALOGUE = [
  { ruleId: CUSTOM_RULE_ID, rule: CUSTOM_RULE, findingId: CUSTOM_FINDING, message: CUSTOM_MESSAGE },
];

/**
 * One rule, reporting one finding, judged and then rendered.
 *
 * @param {{sourceFile?: string, line?: number, column?: number}} finding The
 *   position half of the finding the rule returns; the id and message are the
 *   catalogue's.
 * @returns {Promise<{outcome: object, log: object}>}
 */
async function judgeAndRender(finding) {
  const artifactBytes = buildRuleModule({
    describeJson: JSON.stringify(CUSTOM_DESCRIBE),
    verdictJson: JSON.stringify({
      contract: 1,
      verdict: "fail",
      findings: [{ id: CUSTOM_FINDING, message: CUSTOM_MESSAGE, ...finding }],
    }),
  });
  const loaded = await loadCustomRule({
    name: CUSTOM_RULE,
    artifactBytes,
    declaredSha256: createHash("sha256").update(artifactBytes).digest("hex"),
  });
  expect(loaded.failure?.reason ?? null).toBe(null);
  const outcome = await evaluateCustomRule({
    module: loaded.module,
    describe: loaded.describe,
    evidenceBytes: CUSTOM_EVIDENCE,
  });
  const decision = outcome.ok
    ? {
        name: CUSTOM_RULE,
        verdict: "fail",
        message: "reported 1 finding",
        findings: outcome.verdict.findings.map((reported) => ({
          ...reported,
          id: `custom/${CUSTOM_RULE}/${reported.id}`,
        })),
      }
    : { name: CUSTOM_RULE, verdict: "unknown", message: outcome.failure.reason, findings: [] };
  return {
    outcome,
    log: buildSarifLog({
      violations: [],
      failures: [],
      customRules: { catalogue: HOST_DRIVEN_CATALOGUE, decisions: [decision] },
    }),
  };
}

/**
 * Every `uri` the log locates a result at. A result GitHub cannot resolve is
 * dropped without a word, so "which paths did we claim" is the list a silent
 * upload turns on.
 *
 * @param {object} log
 * @returns {string[]}
 */
const locatedUris = (log) =>
  log.runs[0].results.flatMap((result) =>
    (result.locations ?? []).map((location) => location.physicalLocation.artifactLocation.uri),
  );

describe("a custom rule's own path, from the rule's verdict to the uploaded log", () => {
  it("renders a workspace-relative finding as a result GitHub can resolve", async () => {
    // The load-bearing half (`../../../../AGENTS.md`): a refusal that swallowed
    // every path would satisfy the two cases below by reporting nothing at all,
    // which is the failure direction this repository rates worst.
    const { outcome, log } = await judgeAndRender({
      sourceFile: "libs/app/main.go",
      line: 7,
      column: 2,
    });
    expect(outcome.ok).toBe(true);

    const { rules } = log.runs[0].tool.driver;
    expect(log.runs[0].results).toHaveLength(1);
    const [result] = log.runs[0].results;
    // Every field a GitHub rejection turns on, on the one result that exists.
    expect(rules[result.ruleIndex].id).toBe(result.ruleId);
    expect(result.ruleId).toBe(CUSTOM_RULE_ID);
    expect(result.message.text.length).toBeGreaterThan(0);
    const { artifactLocation, region } = result.locations[0].physicalLocation;
    expectRepositoryRelative(artifactLocation.uri);
    expect(artifactLocation.uri).toBe("libs/app/main.go");
    expect(region.startLine).toBeGreaterThanOrEqual(1);
    expect(region.startColumn).toBeGreaterThanOrEqual(1);
    // A judged rule is not trouble the tool hit, so nothing rides that lane.
    expect(log.runs[0].invocations[0].toolExecutionNotifications).toHaveLength(0);
  });

  for (const [what, sourceFile] of [
    ["absolute", "/etc/passwd"],
    ["climbing out of the workspace", "../../outside.go"],
  ]) {
    it(`refuses a finding whose sourceFile is ${what}, and uploads no result for it`, async () => {
      // Without the host's refusal this produces a perfectly well-formed SARIF
      // result carrying that exact uri: the build fails on the finding, GitHub
      // drops the result without a word because it maps onto no file in the
      // checkout, and the developer sees no annotation at all. That is the
      // silent direction, and it is what these assertions go red on.
      const { outcome, log } = await judgeAndRender({ sourceFile, line: 7, column: 2 });
      expect(outcome.ok).toBe(false);
      expect(outcome.verdict).toBeUndefined();
      // Both facts a reader needs: which rule, and which path.
      expect(outcome.failure.reason).toContain(`custom rule "${CUSTOM_RULE}"`);
      expect(outcome.failure.reason).toContain(JSON.stringify(sourceFile));

      // The list this file exists to keep honest: every `uri` the log locates a
      // result at. Before the host refused, it held the very path the rule
      // named — one well-formed result pointing at a file no checkout has.
      expect(locatedUris(log)).toEqual([]);
      // Silence is not the answer either: the run could not judge the rule, and
      // the log says so in SARIF's own slot for it, naming the path.
      const [notification] = log.runs[0].invocations[0].toolExecutionNotifications;
      expect(notification.level).toBe("warning");
      expect(notification.message.text).toContain(`Custom rule "${CUSTOM_RULE}"`);
      expect(notification.message.text).toContain(sourceFile);
    });
  }
});

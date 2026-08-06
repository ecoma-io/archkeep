/**
 * The differential: `@nx/enforce-module-boundaries` and this engine, over the
 * same trees, the same graphs and the same options — and every place their
 * answers differ, with its direction.
 *
 * This is the test that decides whether the rest of `src/rules/` may ever be
 * trusted to replace ESLint's rule. Nothing else in this repository puts the
 * two verdicts side by side, so without it "I believe it is equivalent" has no
 * evidence behind it in either direction.
 *
 * An integration test by its filename and by its nature: it reaches out of the
 * project into `node_modules` for the real plugin, writes a real workspace to
 * disk, and runs ESLint end to end. `README.md` beside this file is the ledger
 * it produces.
 *
 * The fixture root is created at MODULE scope, before any import that could
 * load nx — `@nx/devkit` resolves its workspace root once per process and never
 * again, and a root resolved before this ran would point upstream at this
 * repository while it judged fixture paths.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MESSAGE_IDS } from "../rules/messages.mjs";
import { CONFORMANCE_CASES } from "./cases.mjs";
import {
  compareCase,
  measuredScope,
  renderDivergences,
  renderTable,
  renderTextDifferences,
  spellingDisagreements,
  spellingGroups,
  summarize,
  verdictOf,
} from "./differential.mjs";
import {
  assertNxRootIsFixture,
  createFixtureRoot,
  materialize,
  removeFixtureRoot,
} from "./fixture.mjs";

const root = createFixtureRoot();

/** Filled by `beforeAll`; every test reads the one run rather than re-running it. */
const outcome = {
  rows: [],
  breaches: [],
  summary: [],
  upstreamMessageIds: [],
  failures: new Map(),
};

beforeAll(async () => {
  const { createUpstreamRunner, runEngine } = await import("./engines.mjs");
  const upstream = await createUpstreamRunner(root);
  assertNxRootIsFixture(root, upstream.workspaceRoot);

  outcome.upstreamMessageIds = upstream.upstreamMessageIds;
  const materialized = materialize(root, CONFORMANCE_CASES, upstream.defaultOptions);

  for (const entry of materialized.values()) {
    const upstreamByFile = await upstream.run(entry);
    const { violations, failures } = runEngine(root, entry);
    outcome.failures.set(entry.spec.id, failures);
    const comparison = compareCase(entry, upstreamByFile, violations);
    outcome.rows.push(...comparison.rows);
    outcome.breaches.push(...comparison.breaches);
  }
  outcome.summary = summarize(outcome.rows, outcome.upstreamMessageIds, MESSAGE_IDS);
}, 300_000);

afterAll(() => removeFixtureRoot(root));

describe("this engine against @nx/enforce-module-boundaries", () => {
  it("reports every violation ESLint reports, at the same site", () => {
    const undeclared = outcome.rows
      .filter((row) => row.divergence?.direction !== "weaker")
      .flatMap((row) =>
        row.weaker.map((hit) => `${row.file}: ESLint reports ${hit.messageId} at ${hit.site}`),
      );
    // The one direction that is never a decision. A boundary checker that says
    // clean where ESLint says otherwise is worse than the state it replaces:
    // today ESLint is right about JS/TS and silent elsewhere, and silence you
    // know about beats a green light you cannot trust. The exclusion above is
    // not an exemption — every excluded site is a defect the catalogue records
    // by name, listed in README.md and pinned by the test below.
    expect(undeclared, "false negatives — this engine is weaker than ESLint here").toEqual([]);
  });

  it("carries exactly the false negatives its own ledger records", () => {
    const observed = outcome.rows
      .flatMap((row) => row.weaker.map((hit) => `${hit.messageId} at ${row.file}`))
      .sort();
    const ledgered = outcome.rows
      .filter((row) => row.divergence?.direction === "weaker")
      .flatMap((row) => (row.probeUpstream ?? []).map((id) => `${id} at ${row.file}`))
      .sort();
    expect(observed).toEqual(ledgered);
  });

  it("behaves exactly as every case declares, so no agreement is vacuous", () => {
    // Two engines that both stay silent "agree" and prove nothing. Each probe
    // states what ESLint must report; this is what catches a fixture that
    // stopped triggering its rule, which would otherwise read as success.
    expect(outcome.breaches).toEqual([]);
  });

  it("implements every message id upstream defines", () => {
    const unimplemented = outcome.upstreamMessageIds.filter((id) => !MESSAGE_IDS.includes(id));
    expect(unimplemented, "message ids upstream defines and this engine cannot produce").toEqual(
      [],
    );
  });

  it("exercises every message id upstream defines", () => {
    // A message no fixture reaches is a message this suite says nothing about,
    // and a table with a blank row reads as a table with a green one.
    const untouched = outcome.summary.filter((row) => !row.exercised).map((row) => row.messageId);
    expect(untouched, "violation types no fixture triggers").toEqual([]);
  });

  it("states a reason for every place it is stricter than ESLint", () => {
    const undeclared = outcome.rows.flatMap((row) =>
      row.stricter
        .filter((hit) => hit.upstreamReadable && !row.divergence)
        .map((hit) => `${row.file}: ${hit.messageId} at ${hit.site}`),
    );
    // Being stricter is a decision, and a decision with no reason attached is
    // indistinguishable from a bug that happens to point the safe way.
    expect(undeclared, "violations reported without a declared divergence").toEqual([]);
  });

  it("analyzes every fixture source without a resolution failure the case did not declare", () => {
    // An analyzer that could not read a file reports no imports for it, which
    // reaches the rules layer looking exactly like a clean file. Any failure
    // here would make some part of the comparison above vacuous, so each case
    // names the specifiers it deliberately leaves unresolvable and every other
    // failure is a finding.
    const unexpected = [];
    for (const spec of CONFORMANCE_CASES) {
      const declared = spec.unresolvable ?? [];
      for (const failure of outcome.failures.get(spec.id) ?? []) {
        if (declared.some((specifier) => failure.reason.includes(`'${specifier}'`))) continue;
        unexpected.push(`${spec.id}: ${failure.reason}`);
      }
    }
    expect(unexpected).toEqual([]);
  });

  it("gives one import the same verdict however it is written", () => {
    // The axis that needs no ESLint. Where upstream has no parser the only
    // other assertion is the `tool: [...]` someone wrote by hand, which agrees
    // with the engine's answer by construction — including when that answer is
    // wrong on a shape nobody thought to write. Spellings of one import cannot
    // agree with each other by construction: a form the analyzer drops, or a
    // package placed where the resolver does not look, disagrees with its own
    // siblings and takes the run red with it.
    expect(
      spellingDisagreements(outcome.rows),
      "one import, judged differently depending on how it is spelled",
    ).toEqual([]);
    // A mechanism with no members is a mechanism that cannot fail.
    expect(spellingGroups(outcome.rows).size).toBeGreaterThan(0);
  });

  it("states in data which half of the catalogue ESLint could read at all", () => {
    // `weaker` is only ever populated from a file upstream can parse, so a zero
    // in that column is a measurement for `.ts`/`.vue` and an arithmetic
    // certainty for `.go`/`.rs`/`.py`. The two are indistinguishable in the
    // number; they are not in this object, which is why the run emits it.
    const scope = measuredScope(outcome.rows);
    console.info(`\nmeasured scope\n--------------\n${JSON.stringify(scope, null, 2)}\n`);
    expect(scope.probes).toBe(scope.comparable + scope.incomparable);
    expect(scope.incomparableExtensions).toEqual([".go", ".py", ".rs"]);
    expect(scope.comparable).toBeGreaterThan(0);

    const weakerOnUnreadable = outcome.rows
      .filter((row) => !row.upstreamReadable)
      .flatMap((row) => row.weaker);
    expect(weakerOnUnreadable, "a weaker row upstream could not have produced").toEqual([]);

    for (const row of outcome.summary) {
      expect(
        row.weaker,
        `${row.messageId} reports more weaker rows than comparable ones`,
      ).toBeLessThanOrEqual(row.comparable);
    }
  });

  it("renders one differential row per violation type, each with a direction", () => {
    // The deliverable itself: the table a reader consults before trusting this
    // engine, and beneath it every disagreement by name. Printed rather than
    // only asserted, because a count that exists only inside an assertion
    // cannot be read by anyone deciding — but vitest's default reporter
    // swallows a passing test's console output, so it reaches that reader only
    // under `--reporter=verbose` (measured on 4.1.10; `README.md` beside this
    // file names the command).
    console.info(`\n${renderTable(outcome.summary)}\n`);
    console.info(`divergences\n-----------\n${renderDivergences(outcome.rows)}\n`);
    console.info(`same verdict, different message text\n${renderTextDifferences(outcome.rows)}\n`);
    for (const row of outcome.summary) {
      expect(verdictOf(row), `${row.messageId} is not exercised or not implemented`).not.toMatch(
        /UNIMPLEMENTED|NOT EXERCISED/u,
      );
    }
    expect(outcome.summary).toHaveLength(15);
  });
});

describe("what ESLint can and cannot read", () => {
  it("refuses a Go source file for want of any matching configuration", async () => {
    // The measured half of "ESLint reads only JavaScript and TypeScript" — the
    // claim the whole tool rests on, taken from ESLint's own mouth rather than
    // from the project's README.
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: [{ files: ["**/*.ts"], rules: {} }],
    });
    const [result] = await eslint.lintFiles([
      `${root}/layer-constraint-violation-in-go/libs/go-consumer/main.go`,
    ]);
    expect(result.messages.map((message) => message.message)).toEqual([
      "File ignored because no matching configuration was supplied.",
    ]);
  });
});

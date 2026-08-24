/**
 * The labeled corpus, run: every case materialised as a native workspace and
 * put through `check`, with its labels held to the answer.
 *
 * This is the half of conformance that has no upstream to ask. The
 * differential beside it can only speak where ESLint has a parser, which is
 * JavaScript, TypeScript and Vue; on Go, Rust and Python it measures this
 * engine against silence, and silence cannot disagree. So here the labels ARE
 * the second opinion, and the suite's whole job is to stop them becoming a
 * transcription of whatever the tool happened to print.
 *
 * Four independent things have to hold for a case to pass, and each fails in
 * a different direction:
 *
 * 1. **The findings match, both ways.** A labeled finding that did not arrive
 *    is the silent direction — the engine stopped enforcing something the
 *    corpus says it enforces. A finding no label claims is the loud one. Both
 *    fail; neither is waivable.
 * 2. **Each probe's import sites were counted.** Scoped to one file, the run
 *    states how many imports it read there. An analyzer that stopped seeing a
 *    shape turns a near-miss into a pass in every other assertion; this is
 *    the one that catches it.
 * 3. **Every probe reports under a policy that forbids everything.** A
 *    near-miss asserting silence is only worth something if the same site is
 *    visible to the engine at all. `denyAll` measures that, and a probe that
 *    is silent under both policies has to say in `why` which unreachable
 *    shape it is.
 * 4. **The run looked at the whole tree.** `coverage.complete`, no
 *    unanalyzed file, no blind spot — because "no violations" is a claim
 *    about coverage too, and a case whose fixture stopped being read would
 *    otherwise pass every comparison above with an empty answer on both
 *    sides.
 *
 * The fixtures exist only while the suite runs: each case is materialised
 * into its own `mkdtemp` root and removed afterwards, so nothing here is ever
 * a tracked file this repository's own lint, format or typecheck can reach
 * (`./corpus-fixture.mjs`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { languageOf } from "../analysis/registry.mjs";
import { MESSAGE_IDS } from "../rules/messages.mjs";
import { ARCHITECTURE_CORPUS, OUT_OF_REACH } from "./corpus.mjs";
import {
  DENY_ALL_CONFIG_FILE,
  DENY_ALL_TAG,
  assertDenyAllTagIsUnclaimed,
  materializeCase,
  removeCaseRoot,
} from "./corpus-fixture.mjs";
import {
  compareFindings,
  countsByFile,
  expectedFindings,
  findingKey,
  positionProblems,
  projectOwning,
  readFrom,
  runCorpusCheck,
} from "./corpus-engine.mjs";

/** Every probe in the corpus, carrying the case it came from. */
const probes = ARCHITECTURE_CORPUS.flatMap((spec) => spec.probes.map((probe) => ({ spec, probe })));

describe("the corpus's own shape", () => {
  it("gives every case a unique id and every project a unique name inside it", () => {
    const ids = ARCHITECTURE_CORPUS.map((spec) => spec.id);
    expect(new Set(ids).size, "duplicate case ids").toBe(ids.length);
    for (const spec of ARCHITECTURE_CORPUS) {
      const names = spec.projects.map((project) => project.name);
      expect(new Set(names).size, `${spec.id}: duplicate project names`).toBe(names.length);
    }
  });

  it("probes files the case actually writes", () => {
    const missing = probes
      .filter(({ spec, probe }) => !(probe.file in spec.files))
      .map(({ spec, probe }) => `${spec.id}: ${probe.file}`);
    // A probe naming a file no case writes would assert about a file that
    // does not exist — and `imports: 0`, `reports: []` would then pass.
    expect(missing, "probes naming a file their case does not write").toEqual([]);
  });

  it("makes every probe say why, and every label state a real message id", () => {
    const silent = probes
      .filter(({ probe }) => typeof probe.why !== "string" || probe.why.trim() === "")
      .map(({ spec, probe }) => `${spec.id}: ${probe.file}`);
    expect(silent, "probes with no stated reason").toEqual([]);

    const unknown = probes.flatMap(({ spec, probe }) =>
      probe.reports
        .filter((report) => !MESSAGE_IDS.includes(report.messageId))
        .map((report) => `${spec.id}: ${probe.file} claims '${report.messageId}'`),
    );
    expect(unknown, "labels naming a message id this engine cannot produce").toEqual([]);
  });

  it("keeps its own three numbers consistent with each other", () => {
    // Cheap, and it catches the label typo the runs cannot: a file cannot
    // report more findings than it has imports, and a policy that forbids
    // everything cannot report fewer than the case's own policy does.
    const wrong = [];
    for (const { spec, probe } of probes) {
      if (probe.reports.length > probe.imports) {
        wrong.push(`${spec.id}: ${probe.file} claims more findings than import sites`);
      }
      if (probe.denyAll < probe.reports.length) {
        wrong.push(`${spec.id}: ${probe.file} claims fewer deny-all findings than its own policy`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("never declares the tag the deny-all policy relies on being unclaimed", () => {
    expect(() => assertDenyAllTagIsUnclaimed(ARCHITECTURE_CORPUS)).not.toThrow();
    // The half that makes the line above worth reading: a guard nothing has
    // ever seen refuse is a guard that may have stopped guarding.
    expect(() =>
      assertDenyAllTagIsUnclaimed([
        {
          id: "a-case-that-claims-the-tag",
          projects: [{ name: "claimant", root: "libs/claimant", tags: [DENY_ALL_TAG] }],
          probes: [],
        },
      ]),
    ).toThrow(/claimant/u);
  });

  it("refuses a case that would overwrite the workspace scaffolding", () => {
    const shadowing = {
      id: "a-case-that-writes-its-own-model",
      projects: [],
      depConstraints: [],
      probes: [],
      files: { "archkeep.json": "{}\n" },
    };
    expect(() => materializeCase(shadowing)).toThrow(/archkeep\.json/u);
  });

  it("carries a positive and a near-miss in every case", () => {
    // A case of positives alone cannot tell an engine that reproduces the
    // semantics from one that reports on everything; a case of near-misses
    // alone cannot tell enforcement from silence.
    const lopsided = ARCHITECTURE_CORPUS.filter(
      (spec) =>
        !spec.probes.some((probe) => probe.reports.length > 0) ||
        !spec.probes.some((probe) => probe.reports.length === 0),
    ).map((spec) => spec.id);
    expect(lopsided, "cases carrying only positives or only near-misses").toEqual([]);
  });

  it("accounts for every message id — reached, or declared out of reach with a reason", () => {
    const reached = new Set(
      probes.flatMap(({ probe }) => probe.reports.map((report) => report.messageId)),
    );
    const declared = Object.keys(OUT_OF_REACH);

    // Disjoint first: an id in both lists would let a probe cover a rule the
    // corpus also claims it cannot reach, and the union below would still add
    // up.
    expect(
      declared.filter((id) => reached.has(id)),
      "ids declared out of reach that a probe reaches",
    ).toEqual([]);
    expect([...reached, ...declared].sort()).toEqual([...MESSAGE_IDS].sort());

    const unexplained = declared.filter(
      (id) => typeof OUT_OF_REACH[id] !== "string" || OUT_OF_REACH[id].trim() === "",
    );
    expect(unexplained, "ids declared out of reach with no reason given").toEqual([]);
  });

  it("covers each of the three languages ESLint cannot read with at least one positive", () => {
    const positives = new Set(
      probes
        .filter(({ probe }) => probe.reports.length > 0)
        .map(({ probe }) => languageOf(probe.file)),
    );
    for (const language of ["go", "rust", "python"]) {
      expect(positives.has(language), `no positive probe in ${language}`).toBe(true);
    }
  });
});

describe("the comparison this suite is built on", () => {
  // The harness's own red directions, checked without running the tool: a
  // comparator that cannot report a missing finding would make every case
  // below pass on an engine that reports nothing at all.
  const expected = ["a at f on 'x' (p -> q)", "b at g on 'y' (p -> r)"];

  it("names a labeled finding the engine did not produce", () => {
    expect(compareFindings(expected, [expected[1]])).toEqual({
      missing: [expected[0]],
      unexpected: [],
    });
  });

  it("names a finding no label claims", () => {
    expect(compareFindings([expected[0]], expected)).toEqual({
      missing: [],
      unexpected: [expected[1]],
    });
  });

  it("counts repeats rather than collapsing them", () => {
    // Two identical findings at one site and one label for them is a
    // disagreement; a set comparison would call it agreement.
    expect(compareFindings([expected[0]], [expected[0], expected[0]])).toEqual({
      missing: [],
      unexpected: [expected[0]],
    });
  });

  it("catches a diagnostic pointing at the wrong place", () => {
    const text = 'package a\n\nimport (\n\t"example.test/b"\n)\n';
    const violation = {
      sourceFile: "a.go",
      line: 4,
      column: 2,
      specifier: "example.test/b",
      messageId: "onlyTagsConstraintViolation",
    };
    expect(positionProblems([violation], () => text)).toEqual([]);
    expect(positionProblems([{ ...violation, line: 3 }], () => text)).toHaveLength(1);
    expect(positionProblems([{ ...violation, column: 4 }], () => text)).toHaveLength(1);
    expect(positionProblems([{ ...violation, line: 99 }], () => text)).toHaveLength(1);
  });

  it("attributes a file to the project whose root is the longest match", () => {
    const spec = {
      projects: [
        { name: "outer", root: "libs/outer" },
        { name: "inner", root: "libs/outer/nested" },
      ],
    };
    expect(projectOwning(spec, "libs/outer/src/a.go")).toBe("outer");
    expect(projectOwning(spec, "libs/outer/nested/b.go")).toBe("inner");
    expect(projectOwning(spec, "elsewhere/c.go")).toBe(null);
  });
});

for (const spec of ARCHITECTURE_CORPUS) {
  describe(`${spec.id} (${spec.style})`, () => {
    /** @type {{root: string, files: string[]}} */
    let fixture;
    /** @type {Awaited<ReturnType<typeof runCorpusCheck>>} */
    let run;
    /** @type {Awaited<ReturnType<typeof runCorpusCheck>>} */
    let denyAll;
    /** @type {Map<string, Awaited<ReturnType<typeof runCorpusCheck>>>} */
    const scoped = new Map();

    beforeAll(async () => {
      fixture = materializeCase(spec);
      run = await runCorpusCheck({ root: fixture.root, files: fixture.files });
      denyAll = await runCorpusCheck({
        root: fixture.root,
        files: fixture.files,
        config: DENY_ALL_CONFIG_FILE,
      });
      for (const probe of spec.probes) {
        scoped.set(
          probe.file,
          await runCorpusCheck({
            root: fixture.root,
            files: fixture.files,
            paths: [probe.file],
          }),
        );
      }
    }, 120_000);

    afterAll(() => {
      if (fixture) removeCaseRoot(fixture.root);
    });

    it("reads the whole tree and says so", () => {
      // Everything below compares two answers; this is what stops both of
      // them being empty for the same reason.
      expect(run.coverage.complete, "the run could not analyze the whole fixture").toBe(true);
      expect(run.coverage.notAnalyzed).toEqual([]);
      expect(run.coverage.blindSpots).toEqual([]);
      expect(run.coverage.projects, "projects discovered from archkeep.json").toBe(
        spec.projects.length,
      );
      expect(run.coverage.imports, "import sites read across the whole fixture").toBe(
        spec.probes.reduce((total, probe) => total + probe.imports, 0),
      );
    });

    it("reports exactly the findings its probes claim, and nothing else", () => {
      const actual = run.violations.map(findingKey);
      const { missing, unexpected } = compareFindings(expectedFindings(spec), actual);
      // The silent direction, named separately so a failure says which of the
      // two it is without anyone reading the diff.
      expect(missing, "labeled violations this engine did not report").toEqual([]);
      expect(unexpected, "violations reported that no probe claims").toEqual([]);
    });

    it("points every finding at the import it is about", () => {
      expect(positionProblems(run.violations, readFrom(fixture.root))).toEqual([]);
    });

    it("carries the verdict its findings imply", () => {
      const anyFinding = spec.probes.some((probe) => probe.reports.length > 0);
      expect(run.status).toBe(anyFinding ? "findings" : "clean");
      expect(run.exitCode).toBe(anyFinding ? 1 : 0);
    });

    it("records the import sites each probe states", () => {
      const wrong = [];
      for (const probe of spec.probes) {
        const only = scoped.get(probe.file);
        if (only.coverage.analyzedFiles !== 1) {
          wrong.push(`${probe.file}: scoped run analyzed ${only.coverage.analyzedFiles} files`);
        }
        if (only.coverage.imports !== probe.imports) {
          wrong.push(
            `${probe.file}: ${only.coverage.imports} import sites read, ${probe.imports} labeled`,
          );
        }
      }
      // A probe whose imports stopped being read reports nothing, which every
      // near-miss assertion would accept.
      expect(wrong, "probes whose import sites were not read as labeled").toEqual([]);
    });

    it("sees every probe under a policy that forbids everything", () => {
      const counts = countsByFile(denyAll.violations);
      const wrong = [];
      for (const probe of spec.probes) {
        const seen = counts.get(probe.file) ?? 0;
        if (seen !== probe.denyAll) {
          wrong.push(`${probe.file}: ${seen} findings under deny-all, ${probe.denyAll} labeled`);
        }
      }
      // This is what makes a near-miss an assertion: the site reports when
      // the policy forbids it, so its silence under the case's own policy is
      // a verdict about the policy rather than about the engine's eyesight.
      expect(wrong, "probes whose visibility to the engine is not what the corpus states").toEqual(
        [],
      );
    });
  });
}

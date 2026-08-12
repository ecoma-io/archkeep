/**
 * The comparison itself, pinned in isolation.
 *
 * Every claim the suite makes passes through `compareFile`, so a bug here would
 * not fail — it would agree. The cases below are the ones that decide the
 * suite's meaning: what counts as the same site when the two engines report
 * different ranges, and what happens when they name the same rule at different
 * places.
 */
import { describe, expect, it } from "vitest";

import {
  compareFile,
  measuredScope,
  renderDivergences,
  renderTable,
  renderTextDifferences,
  spellingDisagreements,
  spellingGroups,
  summarize,
  verdictOf,
} from "./differential.mjs";

/** An ESLint message covering `import { a } from "@x/y";` on one line. */
const statement = (messageId, line = 1) => ({
  messageId,
  message: "upstream text",
  line,
  column: 1,
  endLine: line,
  endColumn: 27,
});

/** A violation from this engine, which points at the specifier inside that statement. */
const specifier = (messageId, line = 1, column = 22) => ({
  messageId,
  message: "upstream text",
  line,
  column,
});

const readable = (messages) => ({ readable: true, messages, notes: [] });

describe("pairing two verdicts for one file", () => {
  it("treats a violation inside the reported statement as the same site", () => {
    const result = compareFile("a.ts", readable([statement("noImportsOfApps")]), [
      specifier("noImportsOfApps"),
    ]);
    expect(result.agree).toEqual([
      { messageId: "noImportsOfApps", site: "a.ts:1:22", sameText: true },
    ]);
    expect(result.stricter).toEqual([]);
    expect(result.weaker).toEqual([]);
  });

  it("counts a violation at the statement's own start, and one just before its end", () => {
    const result = compareFile(
      "a.ts",
      readable([statement("noImportsOfApps"), statement("noImportsOfE2e", 2)]),
      [specifier("noImportsOfApps", 1, 1), specifier("noImportsOfE2e", 2, 26)],
    );
    expect(result.agree).toHaveLength(2);
    expect(result.weaker).toEqual([]);
  });

  it("does not pair a violation that falls outside the reported range", () => {
    // Same rule, different statement. Absorbing that into an agreement would
    // hide a diagnostic pointing at the wrong line, which is worse than none.
    const result = compareFile("a.ts", readable([statement("noImportsOfApps")]), [
      specifier("noImportsOfApps", 1, 27),
    ]);
    expect(result.agree).toEqual([]);
    expect(result.stricter).toHaveLength(1);
    expect(result.weaker).toHaveLength(1);
  });

  it("does not pair across message ids, however well the positions line up", () => {
    const result = compareFile("a.ts", readable([statement("noImportsOfApps")]), [
      specifier("noImportsOfE2e"),
    ]);
    expect(result.weaker[0].messageId).toBe("noImportsOfApps");
    expect(result.stricter[0].messageId).toBe("noImportsOfE2e");
  });

  it("calls an unmatched violation of this engine stricter, and an unmatched ESLint one weaker", () => {
    expect(compareFile("a.ts", readable([]), [specifier("noImportsOfApps")]).stricter).toHaveLength(
      1,
    );
    expect(compareFile("a.ts", readable([statement("noImportsOfApps")]), []).weaker).toHaveLength(
      1,
    );
  });

  it("records a pair whose rendered text differs, without making it a disagreement", () => {
    const result = compareFile("a.ts", readable([statement("noCircularDependencies")]), [
      { ...specifier("noCircularDependencies"), message: "different chain" },
    ]);
    expect(result.agree[0].sameText).toBe(false);
    expect(result.weaker).toEqual([]);
  });

  it("survives a message that carries no end position", () => {
    const message = { messageId: "noImportsOfApps", message: "t", line: 3, column: 5 };
    expect(
      compareFile("a.ts", readable([message]), [specifier("noImportsOfApps", 3, 5)]).agree,
    ).toHaveLength(1);
  });

  it("marks a violation on a file ESLint could not parse as reported without a readable counterpart", () => {
    const result = compareFile("a.rs", { readable: false, messages: [], notes: [] }, [
      specifier("bannedExternalImportsViolation"),
    ]);
    expect(result.stricter[0].upstreamReadable).toBe(false);
  });
});

describe("summarising a run", () => {
  const rows = [
    {
      caseId: "one",
      file: "one/a.ts",
      divergence: null,
      upstreamReadable: true,
      agree: [{ messageId: "noImportsOfApps", site: "one/a.ts:1:1", sameText: true }],
      stricter: [],
      weaker: [],
    },
    {
      caseId: "two",
      file: "two/a.rs",
      divergence: null,
      upstreamReadable: false,
      agree: [],
      stricter: [{ messageId: "noImportsOfE2e", site: "two/a.rs:1:1", upstreamReadable: false }],
      weaker: [],
    },
    {
      caseId: "three",
      file: "three/a.ts",
      divergence: { direction: "weaker", reason: "recorded defect" },
      upstreamReadable: true,
      agree: [],
      stricter: [],
      weaker: [{ messageId: "noCircularDependencies", site: "three/a.ts:1:1" }],
    },
  ];
  const summary = summarize(
    rows,
    [
      "noImportsOfApps",
      "noImportsOfE2e",
      "noCircularDependencies",
      "noImportsOfLazyLoadedLibraries",
    ],
    ["noImportsOfApps", "noImportsOfE2e", "noCircularDependencies"],
  );

  it("gives every message id upstream defines a row, implemented here or not", () => {
    expect(summary.map((row) => row.messageId)).toHaveLength(4);
    expect(verdictOf(summary[3])).toBe("UNIMPLEMENTED");
  });

  it("names a message no fixture reached rather than leaving its row blank", () => {
    const untouched = summarize(
      rows,
      ["noSelfCircularDependencies"],
      ["noSelfCircularDependencies"],
    );
    expect(verdictOf(untouched[0])).toBe("NOT EXERCISED");
  });

  it("calls a weaker row a defect and a stricter-only row a decision", () => {
    expect(verdictOf(summary[2])).toBe("WEAKER — DEFECT");
    expect(verdictOf(summary[1])).toBe("stricter only");
    expect(verdictOf(summary[0])).toBe("agree");
  });

  it("attributes a stricter row on an unparseable file to the language, not to a decision", () => {
    expect(summary[1].notes).toEqual(["upstream cannot parse the language"]);
  });

  it("counts how many of a row's hits upstream could have contradicted", () => {
    // A zero in the `weaker` column means one thing beside a non-zero
    // `comparable` and another beside a zero one: measured against ESLint, or
    // arithmetic. The row that came off a `.rs` file scores zero, and it is
    // the row whose "no false negative" says nothing about this engine.
    expect(summary.map((row) => [row.messageId, row.weaker, row.comparable])).toEqual([
      ["noImportsOfApps", 0, 1],
      ["noImportsOfE2e", 0, 0],
      ["noCircularDependencies", 1, 1],
      ["noImportsOfLazyLoadedLibraries", 0, 0],
    ]);
  });

  it("renders a table whose columns line up and a divergence list that names its reasons", () => {
    const table = renderTable(summary);
    expect(table.split("\n")).toHaveLength(summary.length + 2);
    expect(table).toMatch(/messageId\s+agree\s+stricter\s+weaker\s+comparable\s+verdict/u);

    const divergences = renderDivergences(rows);
    expect(divergences).toContain("recorded defect");
    expect(divergences).toContain("ESLint has no parser for this language");
    expect(renderTextDifferences(rows)).toBe("");
  });

  it("says UNDECLARED for a divergence with no reason attached", () => {
    const undeclared = renderDivergences([{ ...rows[2], divergence: null }]);
    expect(undeclared).toContain("UNDECLARED");
  });
});

describe("one import written several ways", () => {
  /** A probe row as `compareCase` emits one, reduced to what the axis reads. */
  const probe = (file, spelling, tool, upstream = []) => ({
    caseId: "case",
    file,
    spelling,
    upstreamReadable: false,
    reported: { upstream, tool },
    agree: [],
    stricter: [],
    weaker: [],
  });

  it("says nothing about probes that declare no spelling", () => {
    expect(spellingDisagreements([probe("a.rs", null, ["x"]), probe("b.rs", null, [])])).toEqual(
      [],
    );
    expect(spellingGroups([probe("a.rs", null, [])]).size).toBe(0);
  });

  it("passes a group whose spellings all reached the same verdict", () => {
    expect(
      spellingDisagreements([
        probe("plain.rs", "one crossing", ["onlyTagsConstraintViolation"]),
        probe("braced.rs", "one crossing", ["onlyTagsConstraintViolation"]),
      ]),
    ).toEqual([]);
  });

  it("fails a group where one spelling was judged and another was not", () => {
    // The shape of every finding this axis exists for: one form enforced, an
    // equivalent form silently clean, and no ESLint verdict on either side to
    // notice the difference.
    const lines = spellingDisagreements([
      probe("plain.py", "one crossing", ["onlyTagsConstraintViolation"]),
      probe("relocated.py", "one crossing", []),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("case / one crossing");
    expect(lines[0]).toContain("relocated.py");
  });

  it("fails a group that has lost its siblings, which would otherwise pass forever", () => {
    const [line] = spellingDisagreements([probe("plain.rs", "one crossing", ["x"])]);
    expect(line).toContain("needs at least two spellings");
  });

  it("compares upstream's verdict too, so the axis survives a language ESLint can read", () => {
    expect(
      spellingDisagreements([
        probe("a.ts", "one crossing", ["noImportsOfApps"], ["noImportsOfApps"]),
        probe("b.ts", "one crossing", ["noImportsOfApps"], []),
      ]),
    ).toHaveLength(1);
  });
});

describe("the scope the differential actually measured", () => {
  it("splits the probes by whether upstream could read them at all", () => {
    // The figure and its scope, emitted together. `weaker` cannot be non-zero
    // on a file upstream never parsed, so a reader needs both numbers before
    // "zero false negatives" means anything.
    const scope = measuredScope([
      { caseId: "a", file: "a/x.ts", upstreamReadable: true, spelling: null, weaker: [] },
      { caseId: "a", file: "a/y.vue", upstreamReadable: true, spelling: null, weaker: [] },
      { caseId: "b", file: "b/z.py", upstreamReadable: false, spelling: "one", weaker: [] },
      { caseId: "b", file: "b/w.rs", upstreamReadable: false, spelling: "one", weaker: [] },
    ]);
    expect(scope).toEqual({
      probes: 4,
      comparable: 2,
      incomparable: 2,
      comparableExtensions: [".ts", ".vue"],
      incomparableExtensions: [".py", ".rs"],
      spellingGroups: 1,
    });
  });
});

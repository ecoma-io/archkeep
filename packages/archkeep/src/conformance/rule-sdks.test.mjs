import { describe, it, expect } from "vitest";

import { EXPECTED_VERDICTS, RULE_SDKS, disagreements, fixtureNames } from "./rule-sdks.mjs";

describe("disagreements", () => {
  it("is silent when every document is identical", () => {
    expect(
      disagreements([
        { name: "rust", value: "{}" },
        { name: "go", value: "{}" },
        { name: "python", value: "{}" },
      ]),
    ).toEqual([]);
  });

  it("names both sides, so a failure says which copy moved", () => {
    // "two of them differ" sends a reader to diff four files. Naming the
    // reference and the one that left it sends them to one.
    expect(
      disagreements([
        { name: "rust", value: "{}" },
        { name: "go", value: "{ }" },
      ]),
    ).toEqual(["go disagrees with rust: they must be byte-identical copies of one document"]);
  });

  it("reports every disagreeing document, not only the first", () => {
    // A loop that returned on the first difference would report one drifted
    // SDK and hide the second, so the next run — after that one was fixed —
    // would be the first to mention it.
    expect(
      disagreements([
        { name: "rust", value: "a" },
        { name: "go", value: "b" },
        { name: "typescript", value: "a" },
        { name: "python", value: "c" },
      ]),
    ).toHaveLength(2);
  });

  it("refuses a comparison that cannot fail", () => {
    // One document compared against nothing is a green check that measures
    // nothing — the placeholder-green shape this repository is built against.
    expect(() => disagreements([{ name: "rust", value: "a" }])).toThrow(/at least two/u);
    expect(() => disagreements([])).toThrow(/at least two/u);
    expect(() => disagreements(/** @type {any} */ (null))).toThrow(/at least two/u);
  });
});

describe("the SDK roster", () => {
  it("names exactly one origin copy, so a regeneration has a starting file", () => {
    expect(RULE_SDKS.filter((sdk) => sdk.origin).map((sdk) => sdk.name)).toEqual(["rust"]);
  });

  it("holds four SDKs, which is what 'byte-identical across all four' is about", () => {
    expect(RULE_SDKS).toHaveLength(4);
  });

  it("expects all four verdicts of the vocabulary somewhere in the corpus", () => {
    // A corpus that only ever expects pass and fail cannot tell a rule that
    // judged from one that could not look — the distinction the whole
    // four-state vocabulary exists for.
    expect([...new Set(Object.values(EXPECTED_VERDICTS))].sort()).toEqual([
      "fail",
      "not_applicable",
      "pass",
      "unknown",
    ]);
  });

  it("derives the fixture names from the expectations, so none can go unjudged", () => {
    expect(fixtureNames()).toEqual(Object.keys(EXPECTED_VERDICTS));
  });
});

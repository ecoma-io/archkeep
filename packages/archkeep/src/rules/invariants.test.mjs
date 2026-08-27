import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import { evaluate, evaluateWithSuppressions } from "./index.mjs";

/**
 * The invariant tier beside `index.test.mjs`'s examples: not "this input
 * produces this verdict" but "these two inputs MUST produce the same verdict,
 * because the difference between them is not an architecture fact".
 *
 * The relation pinned here is **input-order and repetition invariance**: the
 * sites a run hands the engine are a record of what a tree contains, and a
 * tree does not change because its import sites were discovered in a different
 * order or the same line was read twice. So permuting (or repeating) the site
 * array may change the ORDER of the output — that order is documented, see the
 * last describe below — but never its content: the same multiset of verdicts,
 * byte for byte.
 *
 * This is the metamorphic half of the determinism contract. The describe in
 * `index.test.mjs` proves two IDENTICAL calls agree; that passes even if the
 * engine folded input order into the verdict itself, which is exactly the
 * defect a report-layer sort cannot repair (a canonical sort of an
 * order-dependent verdict still hides which sites got judged). Only an
 * equivalent-input relation catches it.
 *
 * Every family carries its negative control: the assertions must go red when
 * the engine stops finding violations at all (the permutation claim would
 * otherwise pass vacuously over three empty results), so the fixture's
 * loudness is asserted beside the invariance.
 */

/** How the JavaScript family spells a specifier (`typescript.mjs`'s answer). */
const jsSpelling = (specifier) => {
  const relative = [".", ".."].includes(specifier) || /^\.\.?\//u.test(specifier);
  return { path: relative || specifier.startsWith("/"), relative, namesOnly: false };
};

const project = (name, { type = "lib", root = `area/${name}`, tags = [] } = {}) => ({
  name,
  type,
  data: { root, tags },
});

const graphOf = (projects) => ({
  nodes: Object.fromEntries(projects.map((p) => [p.name, p])),
  dependencies: {},
});

const site = (overrides = {}) => {
  const specifier = overrides.specifier ?? "../beta/src/one";
  return {
    sourceFile: "area/alpha/src/one.ts",
    line: 3,
    column: 1,
    kind: "static",
    spelling: jsSpelling(specifier),
    resolved: {
      target: "beta",
      file: "area/beta/src/one.ts",
      external: false,
      packageName: null,
    },
    ...overrides,
    specifier,
  };
};

/**
 * A relative crossing from `alpha` into `beta`, each instance on its own file
 * and line so the records are distinguishable by identity rather than by array
 * position.
 */
const crossing = (file, line, specifier) =>
  site({
    sourceFile: file,
    line,
    specifier,
    resolved: {
      target: "beta",
      file: "area/beta/src/thing.ts",
      external: false,
      packageName: null,
    },
  });

/** An import inside its own project — no rule fires; it rides along anyway. */
const intraProject = () =>
  site({
    sourceFile: "area/alpha/src/two.ts",
    line: 8,
    specifier: "./sibling",
    resolved: {
      target: "alpha",
      file: "area/alpha/src/sibling.ts",
      external: false,
      packageName: null,
    },
  });

const options = () => ({
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
});

const config = () => ({
  depConstraints: [{ sourceTag: "*", onlyDependOnLibsWithTags: ["*"] }],
  options: options(),
});

const graph = graphOf([
  project("alpha", { tags: ["zone:x"] }),
  project("beta", { tags: ["zone:y"] }),
]);

const crossings = [
  crossing("area/alpha/src/one.ts", 3, "../../beta/src/one"),
  crossing("area/alpha/src/deep/two.ts", 12, "../../../beta/src/two"),
  crossing("area/alpha/src/three.ts", 7, "../../beta/src/three"),
];

/**
 * Order-blind comparison: the same violations in any sequence. Sorting the
 * serialized rows makes this a multiset comparison without restating the
 * report layer's canonical key here — the canonical ORDER itself is
 * `../../commands/check.mjs`'s `sortViolations`, pinned at the CLI level in
 * `../cli.integration.test.mjs`.
 */
const sortedRows = (violations) => violations.map((v) => JSON.stringify(v)).sort();

describe("input-order invariance — the sites are a set of facts about one tree", () => {
  test.prop([fc.shuffledSubarray(crossings, { minLength: crossings.length })])(
    "permuting the site array permutes nothing but the output order",
    (permuted) => {
      const baseline = evaluate(crossings, graph, config());
      const fromPermuted = evaluate(permuted, graph, config());

      // The comparator must be looking at real verdicts: three crossings
      // judged, none dropped. An engine that went quiet would satisfy every
      // equality below over three empty arrays.
      expect(baseline).toHaveLength(crossings.length);
      expect(baseline.every((v) => typeof v.messageId === "string" && v.messageId !== "")).toBe(
        true,
      );

      expect(sortedRows(fromPermuted)).toEqual(sortedRows(baseline));
    },
  );

  it("a clean site rides along unchanged by the permutation around it", () => {
    const withClean = [...crossings, intraProject()];
    const result = evaluate(withClean, graph, config());
    // Exactly the three crossings, no verdict invented for the intra-project
    // import — and no permutation of the input can change that count.
    expect(result).toHaveLength(crossings.length);
    expect(sortedRows(evaluate([intraProject(), ...crossings], graph, config()))).toEqual(
      sortedRows(result),
    );
  });

  it("negative control: a genuinely new crossing changes the set the relation compares", () => {
    const baseline = evaluate(crossings, graph, config());
    const grown = evaluate(
      [...crossings, crossing("area/alpha/src/four.ts", 21, "../../beta/src/four")],
      graph,
      config(),
    );
    expect(grown).toHaveLength(baseline.length + 1);
    expect(sortedRows(grown)).not.toEqual(sortedRows(baseline));
  });
});

describe("duplicate normalization — written copies are judged records, never deduplicated away", () => {
  // The analysis contract fixes this above the engine: "A file importing the
  // same project three times yields three records." The engine inherits it —
  // occurrences carry the delta classifier's counts, so collapsing duplicates
  // here would corrupt every downstream multiset silently.
  const one = crossing("area/alpha/src/one.ts", 3, "../../beta/src/one");

  it("three identical site records produce three identical violations", () => {
    const single = evaluate([one], graph, config());
    expect(single).toHaveLength(1);
    const repeated = evaluate([one, one, one], graph, config());
    expect(repeated.map((v) => JSON.stringify(v))).toEqual([
      JSON.stringify(single[0]),
      JSON.stringify(single[0]),
      JSON.stringify(single[0]),
    ]);
  });

  it("zero copies produce zero violations — and the empty result is still a claim", () => {
    expect(evaluate([], graph, config())).toEqual([]);
    // The claim has content only while the engine can still see the site:
    expect(evaluate([one], graph, config())).toHaveLength(1);
  });
});

describe("the order that IS semantic — documented, therefore pinned", () => {
  // `evaluateWithSuppressions` documents its output as "in the order the sites
  // were given, nothing removed": site order survives this layer on purpose,
  // because a suppression behaves like a fix and reveals the next check at the
  // SAME site — a reordering here would scramble which verdict a reader sees
  // first. Input-order invariance at the report layer is bought downstream by
  // `sortViolations`, not by pretending this layer has no order.
  it("reports one violation per site in the order the sites were given", () => {
    const ordered = evaluateWithSuppressions(crossings, graph, config());
    expect(ordered.map((v) => v.specifier)).toEqual(crossings.map((s) => s.specifier));
    expect(ordered.map((v) => v.sourceFile)).toEqual(crossings.map((s) => s.sourceFile));
  });

  it("reordering the INPUT reorders the OUTPUT one-to-one — visible, never silent", () => {
    const reversed = evaluateWithSuppressions([...crossings].reverse(), graph, config());
    expect(reversed.map((v) => v.specifier)).toEqual(
      [...crossings].reverse().map((s) => s.specifier),
    );
  });
});

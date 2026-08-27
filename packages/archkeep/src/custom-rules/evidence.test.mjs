import { describe, expect, it } from "vitest";

import {
  EVIDENCE_CONTRACT,
  EVIDENCE_KINDS,
  buildEvidenceBundle,
  serializeEvidenceBundle,
} from "./evidence.mjs";

/** One import site in the shape `../analysis/contract.md` fixes. */
const site = {
  sourceFile: "libs/app/main.go",
  line: 7,
  column: 2,
  specifier: "example.test/ring",
  kind: "static",
  spelling: { path: false, relative: false, namesOnly: true },
  resolved: { target: "ring", file: "libs/ring/ring.go", external: false, packageName: null },
};

/** The five observed facts a bundle is built from, all well-formed. */
function observed(overrides = {}) {
  return {
    rule: { name: "no-app-to-ring", reason: "the app layer owns no ring internals" },
    projects: [
      { name: "ring", root: "libs/ring", tags: ["layer-domain"] },
      { name: "app", root: "libs/app", tags: ["layer-app"] },
    ],
    edges: [{ source: "app", target: "ring", type: "static" }],
    imports: [{ site, sourceProject: "app" }],
    policy: {
      depConstraints: [{ sourceTag: "layer-app", onlyDependOnLibsWithTags: ["layer-domain"] }],
      options: { allow: [], banTransitiveDependencies: false },
      suppressions: [],
      fitness: [],
    },
    ...overrides,
  };
}

const decode = (bytes) => new TextDecoder().decode(bytes);

describe("buildEvidenceBundle", () => {
  it("states the contract and all four evidence kinds", () => {
    const bundle = buildEvidenceBundle(observed());
    expect(bundle.contract).toBe(EVIDENCE_CONTRACT);
    // The bundle carries a key per kind, and the roster is the one the host
    // checks a rule's `needs` against — a kind here that is not on the roster
    // (or the reverse) would let a rule declare a need nothing supplies.
    expect(
      Object.keys(bundle)
        .filter((key) => EVIDENCE_KINDS.includes(key))
        .sort(),
    ).toEqual([...EVIDENCE_KINDS].sort());
  });

  it("defaults params in the bundle and leaves the declared row untouched", () => {
    const row = { name: "no-app-to-ring", reason: "why" };
    const bundle = buildEvidenceBundle(observed({ rule: row }));
    expect(bundle.rule).toEqual({ name: "no-app-to-ring", params: {} });
    // The law is the file the workspace committed; the bundle is a view of it.
    expect(Object.hasOwn(row, "params")).toBe(false);
    expect(row).toEqual({ name: "no-app-to-ring", reason: "why" });
  });

  it("carries declared params through and drops everything else on the row", () => {
    const bundle = buildEvidenceBundle(
      observed({ rule: { name: "r", params: { domainTag: "layer-domain" }, reason: "why" } }),
    );
    expect(bundle.rule).toEqual({ name: "r", params: { domainTag: "layer-domain" } });
  });

  it("sorts projects by name without reordering the caller's array", () => {
    const facts = observed();
    const original = [...facts.projects];
    const bundle = buildEvidenceBundle(facts);
    expect(bundle.model.projects.map((project) => project.name)).toEqual(["app", "ring"]);
    expect(facts.projects).toEqual(original);
  });

  it("sorts edges by source, then target, then type, then sourceFile", () => {
    const bundle = buildEvidenceBundle(
      observed({
        edges: [
          { source: "app", target: "ring", type: "static", sourceFile: "libs/app/z.go" },
          { source: "app", target: "ring", type: "static", sourceFile: "libs/app/a.go" },
          { source: "app", target: "ring", type: "dynamic" },
          { source: "app", target: "core", type: "static" },
          { source: "a-first", target: "ring", type: "static" },
        ],
      }),
    );
    expect(
      bundle.graph.edges.map(
        (edge) => `${edge.source}|${edge.target}|${edge.type}|${edge.sourceFile ?? ""}`,
      ),
    ).toEqual([
      "a-first|ring|static|",
      "app|core|static|",
      "app|ring|dynamic|",
      "app|ring|static|libs/app/a.go",
      "app|ring|static|libs/app/z.go",
    ]);
  });

  it("keeps both of two projects a provider named the same", () => {
    // A duplicate name is a provider's bug, and the bundle reporting one
    // project where two were discovered would hide it inside the evidence.
    const bundle = buildEvidenceBundle(
      observed({
        projects: [
          { name: "app", root: "libs/app", tags: [] },
          { name: "app", root: "apps/app", tags: [] },
        ],
      }),
    );
    expect(bundle.model.projects.map((project) => project.root)).toEqual(["libs/app", "apps/app"]);
  });

  it("keeps both of two edges a provider emitted twice", () => {
    // Two rows equal on all four sort keys. Dropping one would be a graph the
    // rule reads as thinner than the one the provider actually reported.
    const twice = { source: "app", target: "ring", type: "static" };
    const bundle = buildEvidenceBundle(observed({ edges: [twice, { ...twice }] }));
    expect(bundle.graph.edges).toEqual([twice, twice]);
  });

  it("keeps an edge's sourceFile off the row when the adapter supplied none", () => {
    const bundle = buildEvidenceBundle(observed());
    expect(Object.hasOwn(bundle.graph.edges[0], "sourceFile")).toBe(false);
  });

  it("passes each import record through verbatim and adds its attribution", () => {
    const bundle = buildEvidenceBundle(observed());
    expect(bundle.imports).toEqual([{ ...site, sourceProject: "app" }]);
    // Verbatim means every key the analysis contract fixes survives, including
    // the ones a graph edge throws away: five of the fifteen boundary rules
    // are decided on `specifier` and `spelling` alone.
    expect(bundle.imports[0].specifier).toBe(site.specifier);
    expect(bundle.imports[0].spelling).toEqual(site.spelling);
  });

  it("keeps imports in the caller's order, which is source order", () => {
    const second = { ...site, line: 2, specifier: "example.test/other" };
    const bundle = buildEvidenceBundle(
      observed({
        imports: [
          { site: { ...site, line: 9 }, sourceProject: "app" },
          { site: second, sourceProject: "app" },
        ],
      }),
    );
    expect(bundle.imports.map((entry) => entry.line)).toEqual([9, 2]);
  });

  it("renames the loaded options to the name the policy file spells", () => {
    const bundle = buildEvidenceBundle(observed());
    expect(bundle.policy.moduleBoundaryOptions).toEqual({
      allow: [],
      banTransitiveDependencies: false,
    });
    expect(bundle.policy.depConstraints).toHaveLength(1);
    // Acceptance is not a rule's business, so what a run waived never reaches
    // one — a rule that could see waivers could launder them into a verdict.
    expect(Object.keys(bundle.policy).sort()).toEqual(["depConstraints", "moduleBoundaryOptions"]);
  });
});

describe("serializeEvidenceBundle", () => {
  it("produces the same bytes for the same facts", () => {
    const first = serializeEvidenceBundle(buildEvidenceBundle(observed()));
    const second = serializeEvidenceBundle(buildEvidenceBundle(observed()));
    expect(first).toEqual(second);
  });

  it("produces the same bytes when a provider hands the same facts in another order", () => {
    const forward = observed();
    const shuffled = observed({
      projects: [...observed().projects].reverse(),
      edges: [
        { source: "app", target: "ring", type: "static" },
        { source: "a-first", target: "ring", type: "static" },
      ],
    });
    shuffled.edges.reverse();
    forward.edges = [
      { source: "a-first", target: "ring", type: "static" },
      { source: "app", target: "ring", type: "static" },
    ];
    expect(decode(serializeEvidenceBundle(buildEvidenceBundle(forward)))).toEqual(
      decode(serializeEvidenceBundle(buildEvidenceBundle(shuffled))),
    );
  });

  it("sorts object keys at every depth, because it is the canonicalizer this package owns", () => {
    const text = decode(serializeEvidenceBundle(buildEvidenceBundle(observed())));
    expect(text.indexOf('"contract"')).toBeLessThan(text.indexOf('"graph"'));
    expect(text.indexOf('"graph"')).toBeLessThan(text.indexOf('"imports"'));
    expect(text.indexOf('"model"')).toBeLessThan(text.indexOf('"policy"'));
    // A nested object is sorted too, which a JSON.stringify of the built
    // object would not do — the two differ only here, so this is the assertion
    // that would go red if the serializer were swapped for a plain stringify.
    const record = JSON.parse(text).imports[0];
    expect(Object.keys(record)).toEqual([...Object.keys(record)].sort());
  });

  it("measures the length in bytes, not in characters", () => {
    // A project name outside the BMP is two UTF-16 code units and four bytes.
    const bundle = buildEvidenceBundle(
      observed({ projects: [{ name: "app-\u{1F600}", root: "libs/app", tags: [] }] }),
    );
    const bytes = serializeEvidenceBundle(bundle);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(decode(bytes).length);
  });
});

describe("what buildEvidenceBundle refuses, by name", () => {
  // Every case here is the silent direction: each of these inputs has an
  // obvious "just carry on" reading — an empty array, a defaulted object —
  // and every one of those readings produces a bundle a rule cannot tell from
  // a workspace that genuinely holds nothing.
  const cases = [
    ["the facts are not an object", () => buildEvidenceBundle(null), "must be an object"],
    ["rule is missing", () => buildEvidenceBundle(observed({ rule: undefined })), "rule:"],
    [
      "rule.name is empty",
      () => buildEvidenceBundle(observed({ rule: { name: " " } })),
      "rule.name",
    ],
    [
      "rule.params is not an object",
      () => buildEvidenceBundle(observed({ rule: { name: "r", params: [] } })),
      "rule.params",
    ],
    [
      "rule.name is a value JSON cannot even render",
      () => buildEvidenceBundle(observed({ rule: { name: 1n } })),
      "bigint 1",
    ],
    [
      "rule.name is a value JSON renders as nothing at all",
      // `JSON.stringify` answers `undefined` for a function rather than
      // throwing, so the refusal would read "rule.name: ... got function
      // undefined" without the fallback to `String`.
      () => buildEvidenceBundle(observed({ rule: { name: () => "no-app-to-ring" } })),
      "function () =>",
    ],
    [
      "the model was never read",
      () => buildEvidenceBundle(observed({ projects: undefined })),
      "the model was never read",
    ],
    [
      "a project is not an object",
      () => buildEvidenceBundle(observed({ projects: [null] })),
      "projects[0] must be an object",
    ],
    [
      "a project has no name",
      () => buildEvidenceBundle(observed({ projects: [{ root: "libs/app", tags: [] }] })),
      "projects[0].name",
    ],
    [
      "a project has no root",
      () => buildEvidenceBundle(observed({ projects: [{ name: "app", tags: [] }] })),
      "projects[0].root",
    ],
    [
      "a project's tags were never read",
      () => buildEvidenceBundle(observed({ projects: [{ name: "app", root: "libs/app" }] })),
      "projects[0].tags",
    ],
    [
      "a project's tags are not strings",
      () =>
        buildEvidenceBundle(observed({ projects: [{ name: "app", root: "libs/app", tags: [7] }] })),
      "projects[0].tags",
    ],
    [
      "the graph was never read",
      () => buildEvidenceBundle(observed({ edges: null })),
      "the graph was never read",
    ],
    [
      "an edge is not an object",
      () => buildEvidenceBundle(observed({ edges: ["app->ring"] })),
      "edges[0] must be an object",
    ],
    [
      "an edge has no target",
      () => buildEvidenceBundle(observed({ edges: [{ source: "app", type: "static" }] })),
      "edges[0].target",
    ],
    [
      "an edge's sourceFile is not a string",
      () =>
        buildEvidenceBundle(
          observed({ edges: [{ source: "app", target: "ring", type: "static", sourceFile: 3 }] }),
        ),
      "edges[0].sourceFile",
    ],
    [
      "nothing was analyzed",
      () => buildEvidenceBundle(observed({ imports: undefined })),
      "nothing was analyzed",
    ],
    [
      "an import entry is not a pair",
      () => buildEvidenceBundle(observed({ imports: [site] })),
      "imports[0].site",
    ],
    [
      "an import entry is not an object at all",
      () => buildEvidenceBundle(observed({ imports: [null] })),
      "imports[0]: must be { site, sourceProject }",
    ],
    [
      "an import site is unattributed",
      () => buildEvidenceBundle(observed({ imports: [{ site, sourceProject: "" }] })),
      "imports[0].sourceProject",
    ],
    ["the policy is missing", () => buildEvidenceBundle(observed({ policy: null })), "policy:"],
    [
      "the policy's constraint rows were never read",
      () => buildEvidenceBundle(observed({ policy: { options: {} } })),
      "policy.depConstraints",
    ],
    [
      "the policy's options were never read",
      () => buildEvidenceBundle(observed({ policy: { depConstraints: [] } })),
      "policy.options",
    ],
  ];

  for (const [what, run, expected] of cases) {
    it(`refuses when ${what}`, () => {
      expect(run).toThrow(/refusing to build an evidence bundle/u);
      expect(run).toThrow(expected);
    });
  }

  it("never lets an absent kind reach a rule as an empty one", () => {
    // The load-bearing half of every case above, stated once: a workspace that
    // genuinely holds no imports serializes `"imports":[]`, so if an ABSENT
    // `imports` also serialized that way the rule could not tell "clean" from
    // "never looked" — and would answer pass for the second.
    const empty = buildEvidenceBundle(observed({ imports: [] }));
    expect(decode(serializeEvidenceBundle(empty))).toContain('"imports":[]');
    expect(() => buildEvidenceBundle(observed({ imports: undefined }))).toThrow();
  });
});

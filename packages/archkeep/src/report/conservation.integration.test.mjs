/**
 * Conservation: the number of violations entering the report path equals the
 * number of findings leaving it, on every face the run renders.
 *
 * A report is a transport, not a filter. Between the rule engine's verdict and
 * what a consumer reads sit three transforms — `sortViolations`' reorder, the
 * JSON envelope's embedding, and the text/SARIF renderings — and nothing else
 * in the tree counts them against each other. A transform that dropped a
 * finding (or duplicated one) would leave every suite green: each face would
 * still be well-formed, and the drop would be byte-for-byte identical to a
 * cleaner tree. So the count is measured here end to end over a fixture whose
 * violation count is known by construction — three violating import sites and
 * one legal import that must ride along without becoming a finding — and the
 * JSON, SARIF and text faces are held to the same number.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterAll } from "vitest";

import { EXIT, runCli } from "../../cli.mjs";
import { sortViolations } from "../commands/check.mjs";

// ---------------------------------------------------------------------------
// Fixture: a workspace whose verdict count is known by construction.
//
// - libs/domain (layer:domain) — three files importing adapter (three
//   violating sites) plus one self-import that is legal and must not become a
//   finding (the over-count half of conservation).
// - libs/adapter (layer:adapter) — clean.
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "report-conservation-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (relativePath, text) => {
  mkdirSync(join(root, dirname(relativePath)), { recursive: true });
  writeFileSync(join(root, relativePath), text);
};

write(
  "nx.json",
  `${JSON.stringify({
    plugins: [
      {
        plugin: "@ecoma-io/archkeep/nx",
        options: { boundaryConfig: "module-boundaries.config.mjs" },
      },
    ],
  })}\n`,
);
write(
  "module-boundaries.config.mjs",
  `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`,
);
write("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
write("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
write("libs/adapter/adapter.go", "package adapter\n");
// The violating import sits on line 4 of every domain file; the legal
// self-import on doc.go sits on line 5 — both positions are load-bearing in
// the assertions below.
write(
  "libs/domain/doc.go",
  [
    "package domain",
    "",
    "import (",
    '\t"example.com/adapter"',
    '\t"example.com/domain"',
    ")",
    "",
    "var _ = adapter.Name",
    "var _ = domain.Name",
    "",
  ].join("\n"),
);
write(
  "libs/domain/util.go",
  [
    "package domain",
    "",
    "import (",
    '\t"example.com/adapter"',
    ")",
    "",
    "var _ = adapter.Name",
    "",
  ].join("\n"),
);
write(
  "libs/domain/extra.go",
  [
    "package domain",
    "",
    "import (",
    '\t"example.com/adapter"',
    ")",
    "",
    "var _ = adapter.Name",
    "",
  ].join("\n"),
);

const graph = {
  nodes: {
    domain: {
      name: "domain",
      type: "lib",
      data: { root: "libs/domain", tags: ["layer:domain"] },
    },
    adapter: {
      name: "adapter",
      type: "lib",
      data: { root: "libs/adapter", tags: ["layer:adapter"] },
    },
  },
  dependencies: { domain: [], adapter: [] },
};

const files = [
  "nx.json",
  "module-boundaries.config.mjs",
  "libs/domain/go.mod",
  "libs/domain/doc.go",
  "libs/domain/util.go",
  "libs/domain/extra.go",
  "libs/adapter/go.mod",
  "libs/adapter/adapter.go",
];

const env = () => {
  const out = [];
  const err = [];
  return {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    lines: { out, err },
    cwd: root,
    readGraph: () => graph,
    listFiles: () => files,
  };
};

/** The three violating sites the fixture encodes, as `file:line` identities. */
const VIOLATING_SITES = ["libs/domain/doc.go:4", "libs/domain/extra.go:4", "libs/domain/util.go:4"];
/** The legal import the fixture also carries, which no face may report. */
const LEGAL_SITE = "libs/domain/doc.go:5";

describe("conservation — violations in equal findings out, on every face", () => {
  it("the JSON envelope carries exactly the violations the engine judged", async () => {
    const streams = env();
    const exit = await runCli(["check", "--format", "json"], streams);
    expect(exit).toBe(EXIT.violations);
    const envelope = JSON.parse(streams.lines.out.join("\n"));

    // The verdict itself: three in, three out — and the run's status and exit
    // agree that the findings arrived.
    expect(envelope.status).toBe("findings");
    expect(envelope.decision.verdict).toBe("fail");
    expect(envelope.result.violations).toHaveLength(VIOLATING_SITES.length);

    // Multiset identity, not just a count: the same three sites, none
    // swapped, none renamed.
    const reported = envelope.result.violations.map(
      (violation) => `${violation.sourceFile}:${violation.line}`,
    );
    expect([...reported].sort()).toEqual(VIOLATING_SITES);
    for (const violation of envelope.result.violations) {
      expect(violation.messageId).toBe("onlyTagsConstraintViolation");
    }

    // The over-count half: the legal self-import rode along through the
    // engine without becoming a finding.
    expect(reported).not.toContain(LEGAL_SITE);

    // The counts a consumer cross-checks agree with the findings array, and
    // the conservation claim is made over a run that looked at everything.
    expect(envelope.coverage.imports).toBe(VIOLATING_SITES.length + 1);
    expect(envelope.coverage.complete).toBe(true);
  });

  it("the JSON findings are the sorted multiset sortViolations produces", async () => {
    // Conservation includes order: the report boundary's one sort is the only
    // reorder a consumer may observe, and it must neither lose nor invent an
    // element along the way.
    const streams = env();
    await runCli(["check", "--format", "json"], streams);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    const reported = envelope.result.violations.map(
      (violation) =>
        `${violation.sourceFile}:${violation.line}:${violation.column}:${violation.messageId}`,
    );
    expect(reported).toEqual([...reported].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("the SARIF face files exactly the same findings", async () => {
    const streams = env();
    const exit = await runCli(["check", "--format", "sarif"], streams);
    expect(exit).toBe(EXIT.violations);
    const sarif = JSON.parse(streams.lines.out.join("\n"));
    const results = sarif.runs[0].results;
    expect(results).toHaveLength(VIOLATING_SITES.length);
    const sites = results.map((result) => {
      const artifact = result.locations[0].physicalLocation.artifactLocation.uri;
      const line = result.locations[0].physicalLocation.region.startLine;
      return `${artifact}:${line}`;
    });
    expect([...sites].sort()).toEqual(VIOLATING_SITES);
  });

  it("the text face counts the same findings it renders", async () => {
    const streams = env();
    const exit = await runCli(["check"], streams);
    expect(exit).toBe(EXIT.violations);
    const text = streams.lines.out.join("\n");
    // Three rendered entries, and a summary whose number is the same three.
    for (const site of VIOLATING_SITES) {
      expect(text).toContain(site.replace(/:(\d+)$/, ":$1:"));
    }
    expect(text).toContain(
      `✖ ${VIOLATING_SITES.length} boundary violations in ${VIOLATING_SITES.length} files`,
    );
  });
});

describe("conservation of the report boundary's sort itself", () => {
  it("sortViolations preserves its input multiset exactly", () => {
    const unsorted = [
      { sourceFile: "libs/c/c.go", line: 2, column: 1, messageId: "b" },
      { sourceFile: "libs/a/a.go", line: 9, column: 1, messageId: "z" },
      { sourceFile: "libs/a/a.go", line: 1, column: 1, messageId: "z" },
      { sourceFile: "libs/b/b.go", line: 1, column: 7, messageId: "a" },
    ];
    const frozen = JSON.parse(JSON.stringify(unsorted));
    const sorted = sortViolations(unsorted);
    // Same length, same elements, input untouched.
    expect(sorted).toHaveLength(unsorted.length);
    const byJson = (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
    expect([...sorted].sort(byJson)).toEqual([...frozen].sort(byJson));
    expect(unsorted).toEqual(frozen);
    // And the output is in the documented total order.
    const keys = sorted.map((v) => `${v.sourceFile}:${v.line}:${v.column}:${v.messageId}`);
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { check } from "../../cli.mjs";

// The loud-coverage contract (#599, #595, #601): a run that could not look
// must never be mistaken for one that looked and found nothing.
//
// Three states a run can land in, and the verdict each earns:
//
// - scoped to files no project owns, or over files no analyzer claims →
//   nothing was judged → status "no-verdict", exit 3, `coverage.complete`
//   false (#599).
// - analyzed files, but an import site could not be resolved → that site was
//   never judged → also the no-verdict lane (#595). The site stays named in
//   `coverage.blindSpots`; what changes is that the run stops claiming
//   `pass` over it.
// - analyzed files, and a project-owned file carries an extension no analyzer
//   claims → the analyzable surface was judged; the unclaimed file is
//   DISCLOSED, not failed (#601): a `coverageGaps` row names it, `complete`
//   stays true over the judged surface.
//
// Every assertion below pins the direction that can silently pass: each of
// these fixtures produced a green `pass` / `complete: true` envelope on the
// code this contract replaced.

const CONFIG = `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
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
`;

function makeRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `archkeep-coverage-loud-${name}-`));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (relativePath, text) => {
    mkdirSync(join(root, relativePath, ".."), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  };
  return { root, write };
}

function contextFor(root, files, nodes) {
  return {
    cwd: root,
    readGraph: () => ({
      nodes,
      dependencies: Object.fromEntries(Object.keys(nodes).map((name) => [name, []])),
    }),
    listFiles: () => files,
  };
}

function widgetNode() {
  return {
    widget: {
      name: "widget",
      type: "lib",
      data: { root: "libs/widget", tags: ["layer:domain"] },
    },
  };
}

describe("#599 — a run that judged nothing reports no verdict", () => {
  const { root, write } = makeRoot("scoped-zero");
  write("nx.json", "{}\n");
  write("module-boundaries.config.mjs", CONFIG);
  write("libs/widget/Cargo.toml", '[package]\nname = "widget"\nversion = "0.1.0"\n');
  write("libs/widget/src/lib.rs", "use other::thing;\n");
  // Tracked, matches the scope, owned by no project — the exact selection the
  // no-tracked-file refusal is one step too late for.
  write("docs/guide.md", "# guide\n");

  it("a scope selecting zero project-owned files is the no-verdict lane, not pass", async () => {
    const { report } = await check(
      { format: "json", config: null, paths: ["docs/"] },
      contextFor(
        root,
        ["nx.json", "module-boundaries.config.mjs", "docs/guide.md", "libs/widget/src/lib.rs"],
        widgetNode(),
      ),
    );
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("no-verdict");
    expect(envelope.exitCode).toBe(3);
    expect(envelope.decision.verdict).toBe("unknown");
    expect(envelope.decision.reason).toBe(
      "no file in scope could be analyzed — coverage incomplete",
    );
    expect(envelope.coverage.complete).toBe(false);
    expect(envelope.coverage.analyzedFiles).toBe(0);
  });

  const only = makeRoot("zero-analyzable");
  only.write("nx.json", "{}\n");
  only.write("module-boundaries.config.mjs", CONFIG);
  only.write("libs/widget/src/lib.rb", 'require "other/thing"\n');

  it("a whole-tree run whose only owned file no analyzer claims is the no-verdict lane too", async () => {
    const { report } = await check(
      { format: "json", config: null, paths: [] },
      contextFor(
        only.root,
        ["nx.json", "module-boundaries.config.mjs", "libs/widget/src/lib.rb"],
        widgetNode(),
      ),
    );
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("no-verdict");
    expect(envelope.exitCode).toBe(3);
    expect(envelope.coverage.complete).toBe(false);
    expect(envelope.coverage.analyzedFiles).toBe(0);
    // And the reason is named where a reader looks: the gap row names the
    // file and the language fact behind the zero.
    expect(envelope.coverage.coverageGaps).toContainEqual({
      kind: "unsupported-language",
      files: ["libs/widget/src/lib.rb"],
    });
  });
});

describe("#601 — an unclaimed extension is disclosed, not failed", () => {
  const mixed = makeRoot("mixed-language");
  mixed.write("nx.json", "{}\n");
  mixed.write("module-boundaries.config.mjs", CONFIG);
  mixed.write("libs/widget/Cargo.toml", '[package]\nname = "widget"\nversion = "0.1.0"\n');
  mixed.write("libs/widget/src/lib.rs", "use other::thing;\n");
  mixed.write("libs/widget/src/util.rb", 'require "other/helper"\n');

  it("the judged surface stays ok/complete while the skipped file is named in coverageGaps", async () => {
    const { report } = await check(
      { format: "json", config: null, paths: [] },
      contextFor(
        mixed.root,
        [
          "nx.json",
          "module-boundaries.config.mjs",
          "libs/widget/src/lib.rs",
          "libs/widget/src/util.rb",
        ],
        widgetNode(),
      ),
    );
    const envelope = JSON.parse(report);
    // The analyzable surface was judged and is clean — disclosure, not
    // failure. This half is what keeps the row from becoming an exit flip.
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.analyzedFiles).toBe(1);
    expect(envelope.coverage.coverageGaps).toContainEqual({
      kind: "unsupported-language",
      files: ["libs/widget/src/util.rb"],
    });
  });
});

describe("#595 — an unresolvable site moves the run to the no-verdict lane", () => {
  const rustRoot = mkdtempSync(join(tmpdir(), "archkeep-coverage-loud-blind-"));
  afterAll(() => rmSync(rustRoot, { recursive: true, force: true }));
  const writeRust = (relativePath, text) => {
    mkdirSync(join(rustRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(rustRoot, relativePath), text);
  };

  writeRust("nx.json", "{}\n");
  writeRust("module-boundaries.config.mjs", CONFIG);
  writeRust("libs/widget/Cargo.toml", '[package]\nname = "widget"\nversion = "0.1.0"\n');
  // A `use` whose braces do not balance names no crate to resolve — the file
  // is analyzed, this one site is not.
  writeRust("libs/widget/src/lib.rs", "use {a::b, c::d\n;\n");

  it("a blind spot is a verdict the run cannot reach, with the site still named", async () => {
    const { report } = await check(
      { format: "json", config: null, paths: [] },
      contextFor(
        rustRoot,
        ["nx.json", "module-boundaries.config.mjs", "libs/widget/src/lib.rs"],
        widgetNode(),
      ),
    );
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("no-verdict");
    expect(envelope.exitCode).toBe(3);
    expect(envelope.decision.verdict).toBe("unknown");
    expect(envelope.decision.reason).toBe(
      "1 import site could not be resolved — coverage incomplete",
    );
    expect(envelope.coverage.complete).toBe(false);
    // The disclosure half did not move: the site is named exactly as before.
    expect(envelope.coverage.blindSpots).toHaveLength(1);
  });
});

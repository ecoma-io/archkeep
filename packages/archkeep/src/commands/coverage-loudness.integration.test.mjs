import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { check, runCli } from "../../cli.mjs";

// The loud-coverage contract (#599, #595, #601): a run that could not look
// must never be mistaken for one that looked and found nothing.
//
// Three states a run can land in, and the verdict each earns:
//
// - scoped to files no project owns, or over files no analyzer claims →
//   nothing was judged → status "no-verdict", exit 3, `coverage.complete`
//   false (#599).
// - analyzed files, but an import site the workspace's own surface references
//   could not be resolved → that site was never judged → also the no-verdict
//   lane (#595). The site stays named in `coverage.blindSpots`; what changes
//   is that the run stops claiming `pass` over it. An unresolvable
//   bare-package specifier names the EXTERNAL dependency universe instead —
//   resolvability there depends on an installed dependency tree a workspace
//   legitimately may not have — so it is disclosed (`external: true`) without
//   withholding; and a non-literal `import()` argument is the language
//   declaring the target computed at runtime — `dynamic: true`, likewise
//   disclosed without withholding.
// - analyzed files, and a project-owned file carries an extension no analyzer
//   claims → the analyzable surface was judged; the unclaimed file is
//   DISCLOSED, not failed (#601): a `coverageGaps` row names it, `complete`
//   stays true over the judged surface.
//
// Every assertion below pins the direction that can silently pass: each of
// these fixtures produced a green `pass` / `complete: true` envelope on the
// code this contract replaced.
//
// The zero-analyzable tree is also driven through `graph` (#612): the same
// judged-nothing run reached the graph face and came out `ok` / `complete:
// true` / exit 0 there after `check` had stopped reporting it — the contract
// is per-command, and a face that did not take the axis stays green in CI
// while the workspace it ran on judged nothing.

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

// #612 — the same judged-nothing tree through `graph`. The face that missed
// the axis: `graph` derives its verdict through the shared constructor now,
// so the zero-analysis run lands in the no-verdict lane here exactly as it
// does in `check` above — and a run that DID judge a real file stays `ok`,
// which is the over-refusal half that keeps the axis from flipping every
// empty-imports tree red.
describe("#612 — the zero-analyzable tree through graph", () => {
  const zero = makeRoot("graph-zero-analyzable");
  zero.write("nx.json", "{}\n");
  zero.write("module-boundaries.config.mjs", CONFIG);
  zero.write("libs/widget/src/lib.rb", 'require "other/thing"\n');

  /** `graph` over a fixture tree: exit code, stdout, stderr, parsed envelope on the json runs. */
  const runGraph = async (root, files, nodes, args = ["graph", "--format", "json"]) => {
    const out = [];
    const err = [];
    const exit = await runCli(args, {
      ...contextFor(root, files, nodes),
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    const stdout = out.join("\n");
    const jsonRun = args.includes("--format") && args[args.indexOf("--format") + 1] === "json";
    return {
      exit,
      err: err.join("\n"),
      stdout,
      envelope: jsonRun && stdout !== "" ? JSON.parse(stdout) : null,
    };
  };

  const files = ["nx.json", "module-boundaries.config.mjs", "libs/widget/src/lib.rb"];

  it("a whole-tree run that judged nothing is no-verdict / exit 3, not a complete snapshot", async () => {
    const { exit, envelope } = await runGraph(zero.root, files, widgetNode());
    expect(envelope).not.toBeNull();
    expect(exit).toBe(3);
    expect(envelope.status).toBe("no-verdict");
    expect(envelope.exitCode).toBe(3);
    expect(envelope.coverage.complete).toBe(false);
    expect(envelope.coverage.analyzedFiles).toBe(0);
    // Nothing failed and no site went unresolved — the zero is the whole
    // reason the verdict is withheld, so the refusal cannot point at rows
    // that do not exist.
    expect(envelope.coverage.notAnalyzed).toEqual([]);
    expect(envelope.coverage.blindSpots).toEqual([]);
  });

  it("the text face names the zero-analysis clause, not a zero count of failures", async () => {
    const { exit, stdout } = await runGraph(zero.root, files, widgetNode(), ["graph"]);
    expect(exit).toBe(3);
    expect(stdout).toContain("graph snapshot incomplete");
    expect(stdout).toContain("no file in scope could be analyzed — coverage incomplete");
  });

  const clean = makeRoot("graph-clean-analyzed");
  clean.write("nx.json", "{}\n");
  clean.write("module-boundaries.config.mjs", CONFIG);
  clean.write("libs/widget/src/util.js", "export const util = () => 1;\n");

  it("a graph over a tree that judged a real file stays ok and exit 0", async () => {
    // The anti-over-refusal direction: one analyzed file satisfies the axis,
    // so a real tree with no findings keeps the answer it always gave. This
    // half is what makes the #612 flip a zero-analysis rule and not a
    // zero-imports rule.
    const { exit, envelope } = await runGraph(
      clean.root,
      ["nx.json", "module-boundaries.config.mjs", "libs/widget/src/util.js"],
      widgetNode(),
    );
    expect(envelope).not.toBeNull();
    expect(exit).toBe(0);
    expect(envelope.status).toBe("ok");
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.analyzedFiles).toBe(1);
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

describe("#595, narrowed — a dynamic import site is disclosed but withholds nothing", () => {
  const dyn = makeRoot("dynamic-only");
  dyn.write("nx.json", "{}\n");
  dyn.write("module-boundaries.config.mjs", CONFIG);
  dyn.write("libs/widget/Cargo.toml", '[package]\nname = "widget"\nversion = "0.1.0"\n');
  dyn.write("libs/widget/src/lib.rs", "use other::thing;\n");
  // A TS config-loader shape: the module path is computed, so no static
  // answer exists for this one site. This tree exited 3 under the
  // unqualified blind-spot flip this test replaced — which made this
  // repository's own boundary gate permanently red, because every config
  // loader contains such a site. The narrowing: the site is still named in
  // `coverage.blindSpots` (with the `dynamic` marker), the report still
  // prints it, and the verdict stays over the statically judgeable surface.
  dyn.write("libs/widget/src/loader.js", "export const load = (name) => import(name);\n");

  it("a dynamic-only blind-spot tree is ok and complete, with the site still named", async () => {
    const { report } = await check(
      { format: "json", config: null, paths: [] },
      contextFor(
        dyn.root,
        [
          "nx.json",
          "module-boundaries.config.mjs",
          "libs/widget/src/lib.rs",
          "libs/widget/src/loader.js",
        ],
        widgetNode(),
      ),
    );
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.decision.verdict).toBe("pass");
    expect(envelope.coverage.complete).toBe(true);
    // Two disclosed classes ride together: the fixture's Rust bare `use` is
    // external (#603) and the loader is dynamic — neither withholds.
    expect(envelope.coverage.blindSpots).toHaveLength(2);
    expect(
      envelope.coverage.blindSpots.find((row) => row.file === "libs/widget/src/loader.js"),
    ).toMatchObject({
      file: "libs/widget/src/loader.js",
      dynamic: true,
    });
    expect(
      envelope.coverage.blindSpots.find((row) => row.file === "libs/widget/src/lib.rs"),
    ).toMatchObject({
      file: "libs/widget/src/lib.rs",
      external: true,
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

describe("#595, external class — a bare package import withholds nothing", () => {
  const ext = makeRoot("external-bare");
  ext.write("nx.json", "{}\n");
  ext.write("module-boundaries.config.mjs", CONFIG);
  ext.write("libs/widget/Cargo.toml", '[package]\nname = "widget"\nversion = "0.1.0"\n');
  ext.write("libs/widget/src/lib.rs", "use other::thing;\n");
  // A bare specifier no installed dependency tree answers. The same tree
  // exited 3 under the narrowed-to-literal flip this class line replaced:
  // the native self-check's `git archive` copy carries no `node_modules` by
  // design, so every bare import in this repository failed there at once and
  // the required gate went permanently exit 3. The class line: a specifier
  // that names no project the workspace declares asks the dependency
  // universe, not the governed graph — `external: true`, disclosed, and the
  // verdict stands over the statically judgeable surface.
  ext.write(
    "libs/widget/src/dep.js",
    'import x from "archkeep-fixture-uninstalled-package";\nexport const use = () => x;\n',
  );

  it("an external-only blind-spot tree is ok and complete, with the site still named", async () => {
    const { report } = await check(
      { format: "json", config: null, paths: [] },
      contextFor(
        ext.root,
        [
          "nx.json",
          "module-boundaries.config.mjs",
          "libs/widget/src/lib.rs",
          "libs/widget/src/dep.js",
        ],
        widgetNode(),
      ),
    );
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.decision.verdict).toBe("pass");
    expect(envelope.coverage.complete).toBe(true);
    // Two sites disclose here: the Rust fixture's bare `use` this file has
    // always carried, and the TypeScript import — the class is per-analyzer,
    // not a TypeScript privilege (#603).
    expect(envelope.coverage.blindSpots).toHaveLength(2);
    const rust = envelope.coverage.blindSpots.find((row) => row.file === "libs/widget/src/lib.rs");
    expect(rust).toMatchObject({ external: true });
    expect(rust.dynamic).toBeUndefined();
    expect(
      envelope.coverage.blindSpots.filter((row) => row.file === "libs/widget/src/dep.js"),
    ).toEqual([expect.objectContaining({ file: "libs/widget/src/dep.js", external: true })]);
    expect(
      envelope.coverage.blindSpots.find((row) => row.file === "libs/widget/src/dep.js").dynamic,
    ).toBeUndefined();
  });
});

describe("#595, TypeScript face — a # subpath or broken relative path withholds", () => {
  const sub = makeRoot("subpath-relative");
  sub.write("nx.json", "{}\n");
  sub.write("module-boundaries.config.mjs", CONFIG);
  sub.write("libs/widget/Cargo.toml", '[package]\nname = "widget"\nversion = "0.1.0"\n');
  sub.write("libs/widget/src/lib.rs", "use other::thing;\n");
  // #595's own reported shape: `#canary-review/index.mjs` names a declared
  // project through the subpath convention, but `packageNameOf` keeps the
  // `#`, so the whole-file lane's name test cannot catch it — it lands as a
  // positioned row, and the positioned literal that references the
  // workspace's own surface is the class that withholds. A broken relative
  // path names a workspace file that cannot be proven to exist — the same
  // lane. Neither row carries a marker.
  sub.write("libs/widget/src/subpath.js", 'import { x } from "#widget/index.mjs";\n');
  sub.write("libs/widget/src/relative.js", 'import { y } from "./ghost.mjs";\n');

  it("workspace-referencing literal failures are the no-verdict lane, rows unmarked", async () => {
    const { report } = await check(
      { format: "json", config: null, paths: [] },
      contextFor(
        sub.root,
        [
          "nx.json",
          "module-boundaries.config.mjs",
          "libs/widget/src/lib.rs",
          "libs/widget/src/subpath.js",
          "libs/widget/src/relative.js",
        ],
        widgetNode(),
      ),
    );
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("no-verdict");
    expect(envelope.exitCode).toBe(3);
    expect(envelope.decision.verdict).toBe("unknown");
    expect(envelope.coverage.complete).toBe(false);
    // Three rows now: the fixture's Rust bare `use` is external (#603) and
    // does not withhold, so the withholding count — and this no-verdict lane —
    // is the two TypeScript workspace-referencing sites alone.
    expect(envelope.coverage.blindSpots).toHaveLength(3);
    for (const file of ["libs/widget/src/subpath.js", "libs/widget/src/relative.js"]) {
      const row = envelope.coverage.blindSpots.find((entry) => entry.file === file);
      expect(row).toBeTruthy();
      expect(row.external).toBeUndefined();
      expect(row.dynamic).toBeUndefined();
    }
    expect(
      envelope.coverage.blindSpots.find((entry) => entry.file === "libs/widget/src/lib.rs"),
    ).toMatchObject({
      file: "libs/widget/src/lib.rs",
      external: true,
    });
  });
});

// #603 — the external class is per-analyzer, not a TypeScript privilege. Every
// analyzer resolves a bare external coordinate (Go module path outside the
// workspace module, Rust crate name outside the workspace crates, Python
// third-party top-level import, JVM/C# dotted name no tracked package or
// namespace claims) to no declared project, and each must DISCLOSE that site —
// a positioned `external: true` row, verdict-neutral — the way the TypeScript
// analyzer already does. On `main` these trees report an empty `blindSpots`
// array: byte-for-byte the answer of a workspace with nothing to disclose.
//
// Each fixture carries both directions in one run:
//
// - disclosure: the bare external coordinate names the dependency universe, so
//   the verdict stands and the site is still named — exactly one row, marked
//   `external`, never `dynamic`.
// - the loud direction: the second source imports the DECLARED project by its
//   own importable name. Its resolution is asserted from absence — if that
//   specifier ever read as external, there would be a second row; if it ever
//   failed to resolve, the run would leave `ok`/`complete` for the no-verdict
//   lane. A workspace-edge question never answers "external".
const EXTERNAL_PARITY_CASES = [
  {
    language: "Go",
    manifest: ["libs/widget/go.mod", "module example.com/widget\n\ngo 1.21\n"],
    external: ["libs/widget/ext.go", 'package main\n\nimport _ "github.com/uninstalled/lib"\n'],
    declared: [
      "libs/widget/app.go",
      'package main\n\nimport "example.com/widget/inner"\n\nvar _ = inner.Thing\n',
    ],
  },
  {
    language: "Rust",
    manifest: ["libs/widget/Cargo.toml", '[package]\nname = "widget"\nversion = "0.1.0"\n'],
    external: ["libs/widget/src/ext.rs", "use serde::Serialize;\n"],
    declared: ["libs/widget/src/app.rs", "use widget::run;\n"],
  },
  {
    language: "Python",
    // The declared-project importer lives in a SECOND project: an absolute
    // import of one's own project root package is `noSelfCircularDependencies`
    // (the barrel-cycle rule), not a resolution question, and this fixture
    // pins resolution, not that rule. Both projects share the layer tag, so
    // the consumer→widget edge the declared import produces is allowed.
    manifest: ["libs/widget/pyproject.toml", '[project]\nname = "widget"\nversion = "0.1.0"\n'],
    extra: [
      ["libs/widget/src/widget/__init__.py", "\n"],
      ["libs/consumer/pyproject.toml", '[project]\nname = "consumer"\nversion = "0.1.0"\n'],
    ],
    external: ["libs/widget/src/widget/ext.py", "import requests\n"],
    declared: ["libs/consumer/main.py", "import widget\n"],
    nodes: {
      widget: {
        name: "widget",
        type: "lib",
        data: { root: "libs/widget", tags: ["layer:domain"] },
      },
      consumer: {
        name: "consumer",
        type: "lib",
        data: { root: "libs/consumer", tags: ["layer:domain"] },
      },
    },
    analyzedFiles: 3,
  },
  {
    language: "Java",
    manifest: [],
    external: [
      "libs/widget/src/main/java/com/example/widget/Ext.java",
      "package com.example.widget;\n\nimport org.junit.jupiter.api.Test;\n\nclass Ext {}\n",
    ],
    declared: [
      "libs/widget/src/main/java/com/example/widget/App.java",
      "package com.example.widget;\n\nimport com.example.widget.Ext;\n\nclass App {}\n",
    ],
  },
  {
    language: "Kotlin",
    manifest: [],
    external: [
      "libs/widget/src/main/kotlin/com/example/widget/Ext.kt",
      "package com.example.widget\n\nimport org.junit.jupiter.api.Test\n\nclass Ext\n",
    ],
    declared: [
      "libs/widget/src/main/kotlin/com/example/widget/App.kt",
      "package com.example.widget\n\nimport com.example.widget.Ext\n\nclass App\n",
    ],
  },
  {
    language: "C#",
    manifest: [],
    external: [
      "libs/widget/Ext.cs",
      "using NUnit.Framework;\n\nnamespace Widget;\n\nclass Ext {}\n",
    ],
    declared: ["libs/widget/App.cs", "using Widget;\n\nnamespace Widget;\n\nclass App {}\n"],
  },
];

describe("#603 — every analyzer discloses a bare external coordinate", () => {
  for (const parity of EXTERNAL_PARITY_CASES) {
    const slug = parity.language.toLowerCase().replace(/[^a-z]/g, "");
    it(`${parity.language} — the external coordinate is disclosed; the declared-project import beside it is no row at all`, async () => {
      const tree = makeRoot(`external-parity-${slug}`);
      tree.write("nx.json", "{}\n");
      tree.write("module-boundaries.config.mjs", CONFIG);
      if (parity.manifest.length > 0) {
        tree.write(parity.manifest[0], parity.manifest[1]);
      }
      for (const [path, text] of parity.extra ?? []) {
        tree.write(path, text);
      }
      tree.write(parity.external[0], parity.external[1]);
      tree.write(parity.declared[0], parity.declared[1]);
      const files = [
        "nx.json",
        "module-boundaries.config.mjs",
        ...(parity.manifest.length > 0 ? [parity.manifest[0]] : []),
        ...(parity.extra ?? []).map(([path]) => path),
        parity.external[0],
        parity.declared[0],
      ];
      const { report } = await check(
        { format: "json", config: null, paths: [] },
        contextFor(tree.root, files, parity.nodes ?? widgetNode()),
      );
      const envelope = JSON.parse(report);
      expect(envelope.status).toBe("ok");
      expect(envelope.exitCode).toBe(0);
      expect(envelope.decision.verdict).toBe("pass");
      expect(envelope.coverage.complete).toBe(true);
      expect(envelope.coverage.analyzedFiles).toBe(parity.analyzedFiles ?? 2);
      // Exactly one row — the external coordinate's. The declared project's
      // own import contributed nothing: not a second external row, not a
      // withheld site.
      expect(envelope.coverage.blindSpots).toHaveLength(1);
      expect(envelope.coverage.blindSpots[0]).toMatchObject({
        file: parity.external[0],
        external: true,
      });
      expect(envelope.coverage.blindSpots[0].dynamic).toBeUndefined();
    });
  }

  it("Python — a relative import off the top-level package still withholds while the bare coordinate beside it is disclosed", async () => {
    const tree = makeRoot("external-parity-python-split");
    tree.write("nx.json", "{}\n");
    tree.write("module-boundaries.config.mjs", CONFIG);
    tree.write("libs/widget/pyproject.toml", '[project]\nname = "widget"\nversion = "0.1.0"\n');
    // A top-level module (no package directory above it): `from ..` climbs
    // past the top-level package and names a workspace surface the analyzer
    // cannot prove — that row withholds, no marker. `import requests` names
    // the dependency universe — that row is external. One run, and the two
    // classes part ways: the run must NOT collapse to either all-withheld or
    // all-disclosed.
    tree.write("libs/widget/main.py", "from .. import outside\n\nimport requests\n");
    const { report } = await check(
      { format: "json", config: null, paths: [] },
      contextFor(
        tree.root,
        [
          "nx.json",
          "module-boundaries.config.mjs",
          "libs/widget/pyproject.toml",
          "libs/widget/main.py",
        ],
        widgetNode(),
      ),
    );
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("no-verdict");
    expect(envelope.exitCode).toBe(3);
    expect(envelope.decision.verdict).toBe("unknown");
    expect(envelope.coverage.complete).toBe(false);
    expect(envelope.coverage.blindSpots).toHaveLength(2);
    const withheld = envelope.coverage.blindSpots.find((row) => row.reason.includes("climbs past"));
    expect(withheld).toMatchObject({ file: "libs/widget/main.py" });
    expect(withheld.external).toBeUndefined();
    expect(withheld.dynamic).toBeUndefined();
    const disclosed = envelope.coverage.blindSpots.find((row) => row.external === true);
    expect(disclosed).toMatchObject({ file: "libs/widget/main.py" });
    expect(disclosed.dynamic).toBeUndefined();
  });
});

describe("#623 — Python's non-literal dynamic imports carry dynamic: true instead of withholding", () => {
  const dyn = makeRoot("python-dynamic-623");
  dyn.write("nx.json", "{}\n");
  dyn.write("module-boundaries.config.mjs", CONFIG);
  dyn.write("libs/widget/pyproject.toml", '[project]\nname = "widget"\nversion = "0.1.0"\n');
  dyn.write("libs/widget/src/widget/__init__.py", "\n");
  // A Python dynamic import with a variable argument — the language declaring
  // the target computed at runtime. Without `dynamic: true` on the failure row,
  // the envelope law treats this as a withholding site: exit 3, no-verdict.
  // With the marker, it is disclosed verdict-neutral: ok, exit 0, complete.
  dyn.write("libs/widget/src/widget/ext.py", "importlib.import_module(name)\n");

  it("(a) silent direction — a Python dynamic import site is disclosed with dynamic: true, not withheld", async () => {
    const { report } = await check(
      { format: "json", config: null, paths: [] },
      contextFor(
        dyn.root,
        [
          "nx.json",
          "module-boundaries.config.mjs",
          "libs/widget/pyproject.toml",
          "libs/widget/src/widget/__init__.py",
          "libs/widget/src/widget/ext.py",
        ],
        widgetNode(),
      ),
    );
    const envelope = JSON.parse(report);
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.decision.verdict).toBe("pass");
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.blindSpots).toHaveLength(1);
    expect(envelope.coverage.blindSpots[0]).toMatchObject({
      file: "libs/widget/src/widget/ext.py",
      dynamic: true,
    });
    expect(envelope.coverage.blindSpots[0].external).toBeUndefined();
  });

  it("(b) loudness preserved — Python withholding classes still withhold, no marker", async () => {
    // A file with two imports: a relative import past the top-level package
    // (withholds) and an `__import__` with a variable argument (should be
    // dynamic). The withholding one must carry neither marker.
    const loud = makeRoot("python-dynamic-loud-623");
    loud.write("nx.json", "{}\n");
    loud.write("module-boundaries.config.mjs", CONFIG);
    loud.write("libs/widget/pyproject.toml", '[project]\nname = "widget"\nversion = "0.1.0"\n');
    loud.write("libs/widget/main.py", "from .. import outside\n\n__import__(plugin_name)\n");
    const { report } = await check(
      { format: "json", config: null, paths: [] },
      contextFor(
        loud.root,
        [
          "nx.json",
          "module-boundaries.config.mjs",
          "libs/widget/pyproject.toml",
          "libs/widget/main.py",
        ],
        widgetNode(),
      ),
    );
    const envelope = JSON.parse(report);
    // Two rows: the relative-past-top withholds → exit 3; the dynamic
    // does not withhold, but the withholding count is still >0.
    expect(envelope.status).toBe("no-verdict");
    expect(envelope.exitCode).toBe(3);
    expect(envelope.decision.verdict).toBe("unknown");
    expect(envelope.coverage.complete).toBe(false);
    expect(envelope.coverage.blindSpots).toHaveLength(2);
    const withheld = envelope.coverage.blindSpots.find((row) => row.reason.includes("climbs past"));
    expect(withheld).toBeTruthy();
    expect(withheld.dynamic).toBeUndefined();
    expect(withheld.external).toBeUndefined();
    const dynamic = envelope.coverage.blindSpots.find((row) => row.dynamic === true);
    expect(dynamic).toBeTruthy();
    expect(dynamic.external).toBeUndefined();
  });
});

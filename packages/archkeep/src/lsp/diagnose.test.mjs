import { beforeEach, describe, expect, it, vi } from "vitest";

import { diagnoseDocument } from "./diagnose.mjs";

// Both collaborators are mocked, and not only because the unit tier requires
// it: what has to be pinned here is what happens when they FAIL, and a real
// analyzer cannot be made to throw on demand without feeding it a file whose
// failure mode is itself a moving target.
vi.mock("../analysis/analyze.mjs", () => ({ analyzeFile: vi.fn() }));
vi.mock("../rules/index.mjs", async (importOriginal) => {
  const mod = /** @type {any} */ (await importOriginal());
  return {
    ...mod,
    evaluate: vi.fn((...args) => mod.evaluate(...args)),
    // Re-exposed for the one test that drives the REAL engine — the evidence
    // composition cannot be pinned against a stubbed verdict, because a stub's
    // message text is whatever the test wrote into it.
    __realEvaluate: mod.evaluate,
  };
});
vi.mock("../commands/edge-constraints.mjs", async (importOriginal) => {
  const mod = /** @type {any} */ (await importOriginal());
  return {
    declaredEdgeViolationsForCheck: vi.fn((...args) => mod.declaredEdgeViolationsForCheck(...args)),
    __realDeclaredEdgeViolationsForCheck: mod.declaredEdgeViolationsForCheck,
  };
});

// The modules are mocked (so their call counts can be asserted); the real
// implementations are `importOriginal`ed and re-exposed for the tests that
// want both a spy AND the true verdict. TypeScript cannot see the extra
// synthetic keys on the mocked modules, so the casts are explicit.
const edgeConstraints = /** @type {any} */ (await import("../commands/edge-constraints.mjs"));
const rulesEngine = /** @type {any} */ (await import("../rules/index.mjs"));
const analyzeFile = vi.mocked((await import("../analysis/analyze.mjs")).analyzeFile);
const evaluate = vi.mocked((await import("../rules/index.mjs")).evaluate);
const declaredEdgeViolationsForCheck = vi.mocked(edgeConstraints.declaredEdgeViolationsForCheck);
const realDeclaredEdgeViolationsForCheck = edgeConstraints.__realDeclaredEdgeViolationsForCheck;
const realEvaluate = /** @type {typeof import("../rules/index.mjs").evaluate} */ (
  rulesEngine.__realEvaluate
);

/** All eight options at the values `@nx/enforce-module-boundaries` defaults to — the shape the real engine reads unguarded (`../rules/index.test.mjs` states the same table). */
const engineOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

const SOURCE_FILE = "libs/inner/main.go";
const TEXT = 'package inner\n\nimport "example.test/outer"\n';
const REQUEST = {
  sourceFile: SOURCE_FILE,
  text: TEXT,
  index: { workspace: {}, graph: { nodes: {} } },
  config: { depConstraints: [], options: {} },
};

// A clean tree is the default each case starts from, so every failure below is
// visibly the one thing that case introduced.
beforeEach(() => {
  vi.resetAllMocks();
  analyzeFile.mockReturnValue({ imports: [], failures: [] });
  evaluate.mockReturnValue([]);
});

describe("an empty diagnostic list means no violation, and nothing else", () => {
  it("reports analyzed only when the analyzer AND the rule engine both returned", () => {
    // This is the flag the publisher keys on. It is `true` on exactly one path,
    // so a caller can refuse to publish an empty list any other way.
    expect(diagnoseDocument(REQUEST)).toEqual({ analyzed: true, diagnostics: [] });
  });

  it("publishes the throw when a language has no analyzer, never a clean file", () => {
    // `analyzeFile` throws for a language its extension table claims and no
    // analyzer implements — the scaffold staying loud (`../analysis/analyze.mjs`).
    // Swallowing it would paint every file of that language green.
    analyzeFile.mockImplementation(() => {
      throw new Error("no elvish import analyzer is implemented yet");
    });

    const { analyzed, diagnostics } = diagnoseDocument(REQUEST);

    expect(analyzed).toBe(false);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("no elvish import analyzer is implemented yet");
    expect(diagnostics[0].message).toContain("NOT a clean result");
  });

  it("still names the throw when the no-analyzer failure is not an Error", () => {
    // A thrown string carries no `message`; the fallback must land in the
    // diagnostic all the same, or a language with no analyzer would publish
    // an empty list and read as clean.
    analyzeFile.mockImplementation(() => {
      throw "no elvish import analyzer is implemented yet";
    });

    const { analyzed, diagnostics } = diagnoseDocument(REQUEST);

    expect(analyzed).toBe(false);
    expect(diagnostics[0].message).toContain("no elvish import analyzer is implemented yet");
  });

  it("publishes the throw when the rule engine refuses the input it was handed", () => {
    // `evaluate` throws when the graph and the records describe different trees.
    // Every verdict after that point would be guesswork, so there is no partial
    // answer to fall back to — and no answer must not look like a clean one.
    analyzeFile.mockReturnValue({
      imports: [/** @type {any} */ ({ sourceFile: SOURCE_FILE })],
      failures: [],
    });
    evaluate.mockImplementation(() => {
      throw new Error("the graph and the analysis records describe different trees");
    });

    const { analyzed, diagnostics } = diagnoseDocument(REQUEST);

    expect(analyzed).toBe(false);
    expect(diagnostics.at(-1).message).toContain("describe different trees");
  });

  it("shows what could not be read even when every rule that did run passed", () => {
    // A parse failure is data, not an exception (`../analysis/contract.md`), so
    // the analyzer returns imports AND failures. Publishing only the violations
    // would report a file as clean when part of it was never judged.
    analyzeFile.mockReturnValue({
      imports: [],
      failures: [
        { sourceFile: SOURCE_FILE, line: 3, column: 8, reason: "parse error: '}' expected." },
      ],
    });
    evaluate.mockReturnValue([]);

    const { analyzed, diagnostics } = diagnoseDocument(REQUEST);

    // `analyzed` is still true — the pipeline completed — but the list is NOT
    // empty, which is what a reader actually sees.
    expect(analyzed).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("'}' expected.");
    expect(diagnostics[0].severity).toBe(2);
  });

  it("refuses to call a document analyzed while the index is missing part of the tree", () => {
    // The failure the two existing guards structurally cannot see. Nothing
    // threw: the analyzer returned, the rule engine returned, and every
    // function on the path answered normally — over a graph that is missing a
    // project. `analyzed: true` here would publish `[]` over the violation
    // that missing project would have caused, which is the one outcome this
    // module exists to prevent.
    const { analyzed, diagnostics } = diagnoseDocument({
      ...REQUEST,
      index: {
        ...REQUEST.index,
        skippedProjects: [{ file: "libs/outer/project.json", reason: "is not valid JSON: x" }],
      },
    });

    expect(analyzed).toBe(false);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("libs/outer/project.json");
    expect(diagnostics[0].message).toContain("INCOMPLETE");
  });

  it("puts what the tree was missing ahead of the verdict computed against it", () => {
    // Order is the argument: the qualification has to be read before the thing
    // it qualifies, or a reader takes the violation list for the whole answer.
    analyzeFile.mockReturnValue({ imports: [], failures: [] });
    evaluate.mockReturnValue([
      /** @type {any} */ ({
        sourceFile: SOURCE_FILE,
        line: 3,
        column: 8,
        specifier: "example.test/outer",
        messageId: "onlyTagsConstraintViolation",
        message: "A project tagged with x can only depend on libs tagged with y",
      }),
    ]);

    const { analyzed, diagnostics } = diagnoseDocument({
      ...REQUEST,
      index: {
        ...REQUEST.index,
        fileFailures: [{ sourceFile: "libs/inner/generated.go", reason: "could not be read" }],
      },
    });

    expect(analyzed).toBe(false);
    expect(diagnostics.map((d) => d.code)).toEqual([
      "analysisFailure",
      "onlyTagsConstraintViolation",
    ]);
    expect(diagnostics[0].message).toContain("libs/inner/generated.go");
  });

  it("keeps the report about the tree even on a path that reached no verdict at all", () => {
    // Two different things went wrong and each has a different fix. Dropping
    // the first because the second is louder would send the developer to the
    // analyzer and leave the unreadable `project.json` for them to find later.
    analyzeFile.mockImplementation(() => {
      throw new Error("no elvish import analyzer is implemented yet");
    });

    const { analyzed, diagnostics } = diagnoseDocument({
      ...REQUEST,
      index: {
        ...REQUEST.index,
        skippedProjects: [{ file: "libs/outer/project.json", reason: "could not be read" }],
      },
    });

    expect(analyzed).toBe(false);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].message).toContain("libs/outer/project.json");
    expect(diagnostics[1].message).toContain("no elvish import analyzer");
  });

  // S12: a `archkeep.json` root whose model could not be built
  // (`./workspace-index.mjs`'s `buildNativeWorkspaceIndex`) must not read the
  // same as a tree read whole. Before `nativeModelFailure` existed, this exact
  // index shape — real analysis, real rules, everything returning normally —
  // was `analyzed: true` with an empty diagnostics list: the silent-clean case
  // this whole mechanism exists to close.
  it("refuses to call a document analyzed when the index carries a nativeModelFailure", () => {
    analyzeFile.mockReturnValue({ imports: [], failures: [] });
    evaluate.mockReturnValue([]);

    const { analyzed, diagnostics } = diagnoseDocument({
      ...REQUEST,
      index: {
        ...REQUEST.index,
        nativeMarker: true,
        nativeModelFailure: "archkeep.json: projects: this workspace describes zero projects",
      },
    });

    expect(analyzed).toBe(false);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("archkeep.json");
    expect(diagnostics[0].message).toContain("INCOMPLETE");
  });

  // The other half of the same fix: `nativeMarker` alone — a archkeep.json root
  // whose model built without error — must NOT be treated as a gap. That was
  // the bug this mechanism replaced: every native workspace read as
  // permanently incomplete, whether or not `discover()` ever actually failed.
  it("calls a document analyzed on a archkeep.json root when the model built without error", () => {
    analyzeFile.mockReturnValue({ imports: [], failures: [] });
    evaluate.mockReturnValue([]);

    const { analyzed, diagnostics } = diagnoseDocument({
      ...REQUEST,
      index: { ...REQUEST.index, nativeMarker: true, nativeModelFailure: null },
    });

    expect(analyzed).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  it("refuses a verdict naming a file the engine was never handed", () => {
    // The engine is handed the whole tree's retained sites plus this
    // document's buffer records, and it judges every site it is given — so a
    // violation about another handed file is expected output, filtered below.
    // One naming a file that was NOT handed over is different: no site could
    // have produced it, so engine and caller are discussing different trees,
    // and the verdict for the open file is not trustworthy. Here nothing was
    // handed at all (no retained sites, no buffer imports), so any foreign
    // name trips the guard.
    analyzeFile.mockReturnValue({ imports: [], failures: [] });
    evaluate.mockReturnValue([
      /** @type {any} */ ({
        sourceFile: "libs/other/main.go",
        line: 1,
        column: 1,
        specifier: "x",
        messageId: "noImportsOfApps",
        message: "Imports of apps are forbidden",
      }),
    ]);

    const { analyzed, diagnostics } = diagnoseDocument(REQUEST);

    expect(analyzed).toBe(false);
    expect(diagnostics.at(-1).message).toContain("cannot be trusted");
  });
});

describe("the evidence the engine renders comes from the sites it was handed", () => {
  // The composition this describe pins (#280/#281 follow-up): the rule engine
  // derives its evidence index from exactly the records it is handed, so
  // `diagnoseDocument` hands it the whole tree's retained disk sites minus this
  // document's stale copy, plus the live buffer's fresh records. With only the
  // open document's records — the old composition — the file lists of
  // `noImportsOfLazyLoadedLibraries` came out empty in the editor whenever the
  // backing dynamic import lived in another file, while `lattice check`
  // printed them.
  const OPEN_FILE = "area/host/src/index.ts";
  const LAZY_FILE = "area/host/src/routes.ts";
  const BUFFER_TEXT = [
    "export const host = init();",
    "",
    'import { thing } from "@fixture/beta";',
    "",
  ].join("\n");
  /** Where `BUFFER_TEXT` writes the import, as the analysis contract counts. */
  const bufferLine = BUFFER_TEXT.slice(0, BUFFER_TEXT.indexOf('"@fixture/beta"')).split(
    "\n",
  ).length;
  const bufferColumn = BUFFER_TEXT.split("\n")[bufferLine - 1].indexOf('"') + 1;

  /**
   * A record in the analysis contract's shape (`../analysis/analyze.mjs`'s
   * `ImportSite`), spelled the way the TypeScript analyzer spells this family:
   * non-path, non-relative. Annotated so the literal's `kind` stays a `kind`.
   *
   * @param {Partial<import("../analysis/analyze.mjs").ImportSite>} overrides
   * @returns {import("../analysis/analyze.mjs").ImportSite}
   */
  const site = (overrides = {}) => ({
    sourceFile: OPEN_FILE,
    line: bufferLine,
    column: bufferColumn,
    specifier: "@fixture/beta",
    spelling: { path: false, relative: false },
    kind: "static",
    resolved: {
      target: "beta",
      file: "area/beta/src/index.ts",
      external: false,
      packageName: null,
    },
    ...overrides,
  });
  /** Two libraries; the graph already carries the DYNAMIC edge `routes.ts` produces on disk. */
  const index = {
    workspace: {},
    graph: {
      nodes: {
        host: { name: "host", type: "lib", data: { root: "area/host", tags: ["zone:host"] } },
        beta: { name: "beta", type: "lib", data: { root: "area/beta", tags: ["zone:beta"] } },
      },
      dependencies: { host: [{ source: "host", target: "beta", type: "dynamic" }] },
    },
    importSites: [
      // The stale disk copy of the OPEN document: the same static import, at
      // the line it used to sit on before the developer edited the buffer. If
      // it were handed over beside the buffer's fresh records, the verdict
      // would render twice — once at the stale line — so it must be excluded.
      site({ line: 9 }),
      // Another file of the SAME project lazily loads beta on disk. This is
      // what makes beta lazy-loaded at all — and exactly the record the old
      // composition threw away with the rest of the tree.
      site({ sourceFile: LAZY_FILE, kind: "dynamic", line: 4 }),
    ],
  };
  const config = {
    depConstraints: [{ sourceTag: "*", onlyDependOnLibsWithTags: ["*"] }],
    options: engineOptions,
  };

  beforeEach(() => {
    evaluate.mockImplementation(realEvaluate);
    declaredEdgeViolationsForCheck.mockReturnValue([]);
  });

  it("names the other file's backing import in the open document's lazy-load verdict", () => {
    analyzeFile.mockReturnValue({ imports: [site()], failures: [] });

    const { analyzed, diagnostics } = diagnoseDocument({
      sourceFile: OPEN_FILE,
      text: BUFFER_TEXT,
      index,
      config,
    });

    expect(analyzed).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("noImportsOfLazyLoadedLibraries");
    // The evidence names the file the dynamic import lives in — computed from
    // the fixture, never a literal — where the one-file evidence index used to
    // render the no-evidence fallback sentence instead.
    expect(diagnostics[0].message).toContain(`- ${LAZY_FILE}`);
    expect(diagnostics[0].message).not.toContain("no analyzed import()");
    // Rendered from the LIVE BUFFER's position, not the stale disk copy's
    // line 9 — proving which of the two records was replaced before evaluation.
    expect(diagnostics[0].range.start.line).toBe(bufferLine - 1);
    // And exactly once: the stale copy did not ride along as a second verdict.
    expect(diagnostics.filter((d) => d.code === "noImportsOfLazyLoadedLibraries")).toHaveLength(1);
  });

  it("hands the engine the retained sites plus the buffer's, minus the stale disk copy", () => {
    analyzeFile.mockReturnValue({ imports: [site()], failures: [] });

    diagnoseDocument({ sourceFile: OPEN_FILE, text: BUFFER_TEXT, index, config });

    const handed = /** @type {any[][]} */ (evaluate.mock.calls.at(-1))[0];
    expect(handed.map((s) => `${s.sourceFile}:${s.kind}:${s.line}`)).toEqual([
      // The other file's retained disk site...
      `${LAZY_FILE}:dynamic:4`,
      // ...and the buffer's fresh record for the open document — the line-9
      // stale copy is gone.
      `${OPEN_FILE}:static:${bufferLine}`,
    ]);
  });

  it("filters a violation about another handed file into that file's own diagnosis", () => {
    // The engine now judges every site it receives, so its output covers other
    // files too. Those verdicts belong to those files' documents; they must be
    // dropped here without failing THIS one — the opposite direction of the
    // guard below.
    analyzeFile.mockReturnValue({ imports: [], failures: [] });
    evaluate.mockReturnValue([
      /** @type {any} */ ({
        sourceFile: OPEN_FILE,
        line: bufferLine,
        column: bufferColumn,
        specifier: "@fixture/beta",
        messageId: "noImportsOfLazyLoadedLibraries",
        message: `Static imports of lazy-loaded libraries are forbidden.\n\nLibrary "beta" is lazy-loaded in these files:\n- ${LAZY_FILE}`,
      }),
      /** @type {any} */ ({
        sourceFile: LAZY_FILE,
        line: 4,
        column: 1,
        specifier: "@fixture/beta",
        messageId: "noImportsOfApps",
        message: "Imports of apps are forbidden",
      }),
    ]);

    const { analyzed, diagnostics } = diagnoseDocument({
      sourceFile: OPEN_FILE,
      text: BUFFER_TEXT,
      index,
      config: { depConstraints: [], options: {} },
    });

    expect(analyzed).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain(LAZY_FILE);
  });

  it("refuses a verdict naming a file absent from the sites the engine was handed", () => {
    // The guard's spirit, kept under the new composition: a violation whose
    // file is neither the open document nor any file whose records were passed
    // cannot have come from this run. A fake index with one retained site is
    // enough to draw the boundary precisely — the named file is neither of the
    // two files this run actually covered.
    analyzeFile.mockReturnValue({
      imports: [{ ...site(), sourceFile: "area/host/src/other.ts" }],
      failures: [],
    });
    evaluate.mockReturnValue([
      /** @type {any} */ ({
        sourceFile: "libs/nowhere/main.go",
        line: 1,
        column: 1,
        specifier: "x",
        messageId: "noImportsOfApps",
        message: "Imports of apps are forbidden",
      }),
    ]);

    const { analyzed, diagnostics } = diagnoseDocument({
      sourceFile: OPEN_FILE,
      text: BUFFER_TEXT,
      index: { ...index, importSites: [site({ sourceFile: "area/other/first.ts", line: 2 })] },
      config: { depConstraints: [], options: {} },
    });

    expect(analyzed).toBe(false);
    expect(diagnostics.at(-1).message).toContain("cannot be trusted");
  });
});

describe("a declared implicit edge the rule engine structurally cannot reach", () => {
  const implicitRequest = {
    sourceFile: SOURCE_FILE,
    text: TEXT,
    index: {
      workspace: {
        projects: [
          { name: "inner", root: "libs/inner" },
          { name: "outer", root: "libs/outer" },
        ],
      },
      graph: {
        nodes: {
          inner: { name: "inner", data: { root: "libs/inner", tags: ["zone:inner"] } },
          outer: { name: "outer", data: { root: "libs/outer", tags: ["zone:outer"] } },
        },
        dependencies: { inner: [{ source: "inner", target: "outer", type: "implicit" }] },
      },
    },
    config: {
      depConstraints: [
        {
          sourceTag: "zone:inner",
          onlyDependOnLibsWithTags: ["zone:inner"],
        },
      ],
      options: {},
    },
  };

  it("reports a declared implicit dependency that crosses the tag boundary", () => {
    // The edge `evaluate()` structurally cannot see: an `implicitDependencies`
    // entry has no import site behind it, so it never reaches the rule engine
    // over this document's import sites — and `cli.mjs`'s `check` still exits 1
    // on it. Before the fold, this request returned `analyzed: true` with no
    // diagnostics: the editor painted clean exactly the tree `check` flagged.
    const { analyzed, diagnostics } = diagnoseDocument(implicitRequest);

    expect(analyzed).toBe(true);
    const violation = diagnostics.find((d) => d.code === "onlyTagsConstraintViolation");
    expect(violation).toBeDefined();
    expect(violation.message).toContain("can only depend on");
    // The whole-file range: a declared edge names a project, not an import, so
    // the finding is this document standing in for its project.
    expect(violation.range.start).toEqual({ line: 0, character: 0 });
  });

  it("reports only the declared edges whose source project owns this document", () => {
    // Two projects declare implicit edges; only the one owned by the open
    // document's project may be reported for it. A declared edge names a
    // project, and a file inside another project is not the stand-in for this
    // one.
    const twoWay = {
      ...implicitRequest,
      index: {
        ...implicitRequest.index,
        graph: {
          ...implicitRequest.index.graph,
          dependencies: {
            inner: [{ source: "inner", target: "outer", type: "implicit" }],
            outer: [{ source: "outer", target: "inner", type: "implicit" }],
          },
        },
      },
    };

    const { diagnostics } = diagnoseDocument(twoWay);

    const violations = diagnostics.filter((d) => d.code === "onlyTagsConstraintViolation");
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("can only depend on");
  });

  it("stays silent for a declared edge that satisfies the constraint table", () => {
    // The silent direction of the SAME path: an implicit edge within the tag
    // set is not a violation, and the fold must not invent one for it.
    const withinTags = {
      ...implicitRequest,
      index: {
        ...implicitRequest.index,
        workspace: {
          projects: [
            { name: "inner", root: "libs/inner" },
            { name: "aux", root: "libs/aux" },
          ],
        },
        graph: {
          nodes: {
            inner: { name: "inner", data: { root: "libs/inner", tags: ["zone:inner"] } },
            aux: { name: "aux", data: { root: "libs/aux", tags: ["zone:inner"] } },
          },
          dependencies: { inner: [{ source: "inner", target: "aux", type: "implicit" }] },
        },
      },
    };

    const { analyzed, diagnostics } = diagnoseDocument(withinTags);

    expect(analyzed).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  it("stays silent for a workspace that declares no constraint table at all", () => {
    // `declaredEdgeViolationsForCheck` has the same early exit the rule engine
    // does for an empty `depConstraints`: a workspace declaring no constraint
    // table has opted out of dep-constraint enforcement entirely, and an empty
    // constraint table must not flag every implicit edge in it.
    const noConstraints = {
      ...implicitRequest,
      config: { depConstraints: [], options: {} },
    };

    const { analyzed, diagnostics } = diagnoseDocument(noConstraints);

    expect(analyzed).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  it("computes the declared-edge verdict once per index, not once per keystroke", () => {
    // `declaredEdgeViolationsForCheck` is an O(V+E) walk (reachability rebuild
    // plus every dependency list) that would otherwise run on every `didChange`
    // of every open document. The index is revision-keyed, so a WeakMap on
    // index identity makes the walk cost exactly once per rebuilt index. Two
    // diagnoses over the SAME index must hit the spy once; a fresh index
    // recomputes.
    declaredEdgeViolationsForCheck.mockImplementation(realDeclaredEdgeViolationsForCheck);
    const request = {
      ...implicitRequest,
      index: { ...implicitRequest.index, graph: { ...implicitRequest.index.graph } },
    };
    const other = { ...request, index: { ...request.index } };

    const first = diagnoseDocument(request);
    const second = diagnoseDocument(request);
    const third = diagnoseDocument(other);

    expect(declaredEdgeViolationsForCheck).toHaveBeenCalledTimes(2);
    expect(second.diagnostics).toEqual(first.diagnostics);
    expect(third.diagnostics).toEqual(first.diagnostics);
  });
});

describe("a verdict that did reach a conclusion", () => {
  it("renders one diagnostic per violation, positioned at the import it is about", () => {
    const specifier = "example.test/outer";
    const offset = TEXT.indexOf(`"${specifier}"`);
    const linesBefore = TEXT.slice(0, offset).split("\n");
    analyzeFile.mockReturnValue({ imports: [], failures: [] });
    evaluate.mockReturnValue([
      /** @type {any} */ ({
        sourceFile: SOURCE_FILE,
        line: linesBefore.length,
        column: linesBefore.at(-1).length + 1,
        specifier,
        messageId: "onlyTagsConstraintViolation",
        message:
          'A project tagged with "zone:inner" can only depend on libs tagged with zone:inner',
      }),
    ]);

    const { analyzed, diagnostics } = diagnoseDocument(REQUEST);

    expect(analyzed).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("onlyTagsConstraintViolation");
    expect(diagnostics[0].severity).toBe(1);
    expect(
      TEXT.split("\n")[diagnostics[0].range.start.line].slice(
        diagnostics[0].range.start.character,
        diagnostics[0].range.end.character,
      ),
    ).toBe(`"${specifier}"`);
  });

  it("ignores a policy's customRules — a per-run workspace judgment is not a per-file diagnostic", () => {
    // The posture fitness already takes here: the loader accepts the fifth
    // top-level law (`./boundary-config.mjs` carries it through), and this
    // document-level pipeline judges none of it. Pinned as an equality against
    // the same run without the key, because the failure it guards is not a
    // throw — it is this function quietly growing an opinion about a rule it
    // was never handed the evidence to judge.
    const withCustomRules = {
      ...REQUEST,
      config: {
        ...REQUEST.config,
        customRules: [
          {
            name: "no-interface-outside-domain",
            artifact: "tools/rules/x.wasm",
            sha256: "f".repeat(64),
            reason: "interfaces are the domain's ports",
          },
        ],
      },
    };

    expect(diagnoseDocument(withCustomRules)).toEqual(diagnoseDocument(REQUEST));
    expect(diagnoseDocument(withCustomRules)).toEqual({ analyzed: true, diagnostics: [] });
  });
});

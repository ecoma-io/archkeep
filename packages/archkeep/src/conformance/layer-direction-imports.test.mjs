/**
 * The layer directions the architecture declares and, until the scans in
 * this file, only promised — the audit registered the unscanned ones as
 * gaps G-1, G-5 and G-2 (`BOUNDARIES.md` "Declared but unscanned"; full
 * definitions in `VALIDATION-MATRIX.md`'s "Architectural test gaps";
 * umbrella #725):
 *
 *  - **G-1** — core (`src/rules/`, `src/analysis/`, `src/report/`) never
 *    imports `src/providers/`. Intent A claims providers observe and never
 *    decide; `boundary.test.mjs` is package-level, so a relative
 *    `../providers/…` import passed it. The claim is now a gate.
 *  - **G-5** — `src/report/` imports no rule/config law: nothing from
 *    `src/rules/`, and not `src/config.mjs`. A report that reached either
 *    would be a rule wearing a renderer's name. The tree carries exactly
 *    one recorded edge against this ban — see the roster below for why it
 *    is recorded rather than waved through, and why a second one fails.
 *  - **G-2** — `src/commands/` never imports `src/lsp/`. The #649 gate in
 *    `layer-direction.test.mjs` holds `lsp → commands`; this holds the
 *    reverse, so the CLI face and the editor face cannot grow into each
 *    other from either side.
 *
 * The mechanics are the #649 gate's, verbatim, through the shared
 * extractor `layer-edges.mjs` — and so is the scope discipline:
 *
 *  - **Files** are every non-test `.mjs` under the importing-side
 *    directories, walked rather than listed — a directory list is the copy
 *    that goes stale when the next module lands. Test files are outside
 *    the invariant: a test may drive any layer directly, and several
 *    legitimately do.
 *  - **Edges** are static `import … from` / `export … from` statements
 *    whose RELATIVE specifier resolves into the banned target, resolved
 *    against the importing file's directory — any spelling that lands in
 *    the banned layer from any depth is caught all the same. A dynamic
 *    `import()` is outside the invariant, the same line
 *    `layer-direction.test.mjs` and `module-graph.test.mjs` hold: a cycle
 *    or reach-through a lazily-resolved module is a different finding with
 *    a different fix. Bare specifiers are outside the package and owned by
 *    `boundary.test.mjs`'s allow-list.
 *  - **Comments and strings do not produce edges** — every extractor match
 *    is validated against `maskNonCode`, so the prose these layers
 *    legitimately carry cannot become an edge nobody can remove.
 *
 * Each gate proves its teeth before it proves the tree: a synthetic
 * violation planted in mock source must be caught, and a legal direction
 * must pass, before the real tree is asserted. And because an empty result
 * here is a claim, not a shrug, every real-tree scan first shows its
 * roster is live — a floor no broken walk can satisfy, named modules the
 * audit knew about, and at least one real edge extracted — so a clean
 * verdict is about a scan that read the tree, not one that matched
 * nothing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { staticRelativeSpecifiers } from "./layer-edges.mjs";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Walks `relativeDirs` for the non-test modules the invariant covers.
 *
 * @param {...string} relativeDirs Package-relative source directories.
 * @returns {string[]} Package-relative posix paths.
 */
function srcModules(...relativeDirs) {
  const found = [];
  const walk = (relativeDir) => {
    const absolute = join(SRC_ROOT, relativeDir);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(posix.join(relativeDir, entry.name));
        continue;
      }
      if (entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs")) {
        found.push(posix.join(relativeDir, entry.name));
      }
    }
  };
  for (const relativeDir of relativeDirs) walk(relativeDir);
  return found.sort();
}

/**
 * The resolved relative edges one module's source carries. The teeth tests
 * plant mock source at a mock importer path; the real-tree scans read the
 * file off the tree.
 *
 * @param {string} relativePath Package-relative path of the importing module.
 * @param {string} raw Module source text.
 * @returns {{specifier: string, resolved: string}[]}
 */
function edgesOf(relativePath, raw) {
  return staticRelativeSpecifiers(raw).map((specifier) => ({
    specifier,
    resolved: posix.normalize(posix.join(posix.dirname(relativePath), specifier)),
  }));
}

/**
 * The edges one shipped module carries, read from the tree.
 *
 * @param {string} relativePath Package-relative path of the module.
 * @returns {{specifier: string, resolved: string}[]}
 */
function fileEdges(relativePath) {
  return edgesOf(relativePath, readFileSync(join(SRC_ROOT, relativePath), "utf-8"));
}

/**
 * The banned edges `modules` carry, named well enough to fail on.
 *
 * @param {string[]} modules Package-relative paths of the scanned modules.
 * @param {(resolved: string) => boolean} banned The declared direction's target test.
 * @returns {{from: string, specifier: string, resolved: string}[]}
 */
function forbiddenEdges(modules, banned) {
  return modules.flatMap((from) =>
    fileEdges(from)
      .filter(({ resolved }) => banned(resolved))
      .map((edge) => ({ ...edge, from })),
  );
}

/**
 * Whether a resolved package-relative path sits inside `dir` — the dir
 * itself (`../rules` from `src/` resolves to `rules`) or anything under it.
 *
 * @param {string} dir Package-relative directory name.
 * @returns {(resolved: string) => boolean}
 */
const intoDir = (dir) => (resolved) => resolved === dir || resolved.startsWith(`${dir}/`);

/**
 * G-5's target: the rules layer and the config law beside it — the two
 * places a decision could be smuggled into a renderer from.
 *
 * @type {(resolved: string) => boolean}
 */
const intoRuleOrConfigLaw = (resolved) => intoDir("rules")(resolved) || resolved === "config.mjs";

describe("layer direction imports — G-1: core never imports providers", () => {
  const modules = srcModules("rules", "analysis", "report");

  it("catches a planted core → providers import — teeth before the clean verdict", () => {
    const raw = 'import { readProjectGraph } from "../providers/nx.mjs";\nexport const x = 1;\n';
    const hits = edgesOf("rules/index.mjs", raw).filter(({ resolved }) =>
      intoDir("providers")(resolved),
    );
    expect(hits).toEqual([{ specifier: "../providers/nx.mjs", resolved: "providers/nx.mjs" }]);
  });

  it("lets a core → core import through — the ban names a direction, not an import", () => {
    const raw = 'import { evaluate } from "../rules/index.mjs";\nexport const x = 1;\n';
    const hits = edgesOf("analysis/analyze.mjs", raw).filter(({ resolved }) =>
      intoDir("providers")(resolved),
    );
    expect(hits).toEqual([]);
  });

  it("scans the core's modules — a walk that found nothing would prove nothing", () => {
    // Far below the real module count means the walk broke, not that the
    // core got small; the named modules are the ones the audit's G-1 row
    // speaks of.
    expect(modules.length).toBeGreaterThan(40);
    expect(modules).toContain("rules/index.mjs");
    expect(modules).toContain("analysis/typescript.mjs");
    expect(modules).toContain("report/text.mjs");
  });

  it("reads real edges — the clean verdict must be about a live scan", () => {
    const edgeCount = modules.reduce((count, from) => count + fileEdges(from).length, 0);
    expect(edgeCount).toBeGreaterThan(0);
  });

  it("no module under src/rules, src/analysis or src/report imports anything under src/providers/ (G-1)", () => {
    const edges = forbiddenEdges(modules, intoDir("providers"));
    expect(
      edges.map(
        ({ from, specifier, resolved }) =>
          `${from} imports ${specifier} (resolves to ${resolved}) — G-1: core (rules, analysis, ` +
          `report) must not import src/providers: providers observe and never decide, and the ` +
          `layers that judge sit above the layer that acquires (BOUNDARIES.md, umbrella #725)`,
      ),
    ).toEqual([]);
  });
});

describe("layer direction imports — G-5: report renders, decides nothing", () => {
  const modules = srcModules("report");

  it("catches a planted report → rules import — teeth before the clean verdict", () => {
    const raw = 'import { evaluate } from "../rules/index.mjs";\nexport const text = "";\n';
    const hits = edgesOf("report/text.mjs", raw).filter(({ resolved }) =>
      intoRuleOrConfigLaw(resolved),
    );
    expect(hits).toEqual([{ specifier: "../rules/index.mjs", resolved: "rules/index.mjs" }]);
  });

  it("catches a planted report → config import — the config law is banned beside the rules law", () => {
    const raw = 'import { loadBoundaryConfig } from "../config.mjs";\nexport const text = "";\n';
    const hits = edgesOf("report/json.mjs", raw).filter(({ resolved }) =>
      intoRuleOrConfigLaw(resolved),
    );
    expect(hits).toEqual([{ specifier: "../config.mjs", resolved: "config.mjs" }]);
  });

  it("lets report → report through — rendering beside a sibling renderer is not a decision", () => {
    const raw = 'import { shapeOf } from "./envelope-shape.mjs";\nexport const text = "";\n';
    const hits = edgesOf("report/text.mjs", raw).filter(({ resolved }) =>
      intoRuleOrConfigLaw(resolved),
    );
    expect(hits).toEqual([]);
  });

  it("scans the report modules — a walk that found nothing would prove nothing", () => {
    expect(modules.length).toBeGreaterThan(15);
    expect(modules).toContain("report/text.mjs");
    expect(modules).toContain("report/json.mjs");
    expect(modules).toContain("report/sarif.mjs");
  });

  it("reads real edges — the clean verdict must be about a live scan", () => {
    const edgeCount = modules.reduce((count, from) => count + fileEdges(from).length, 0);
    expect(edgeCount).toBeGreaterThan(0);
  });

  /**
   * The one report → rules edge the tree carries, recorded rather than
   * excused. `src/rules/messages.mjs` is the one home of the violation
   * message tables — the ids are the upstream-parity contract — and its own
   * header declares that `../report/sarif.mjs` derives its SARIF rule
   * descriptors from those tables, so a finding kind added there cannot be
   * nameless in a code-scanning upload. What crosses this edge is the
   * message vocabulary, data crossing, not rule LAW: the renderer reads
   * templates to name kinds it already holds; it filters, scores and
   * decides nothing. It stays on the roster — not waved through — because
   * the edge bends the declared layering all the same, and whether it is
   * kept (with this reason) or broken (the tables re-homed out of
   * `rules/`) is the pressure-point decision the Phase 3 DAG record owes
   * `BOUNDARIES.md`'s "Measured pressure points". Until that decision
   * lands, the roster keeps the gate honest in both directions: a SECOND
   * forbidden edge fails the scan naming itself, and this edge silently
   * vanishing fails the roster — a declaration that outlived the tree is
   * the same drift as a violation, only quieter.
   *
   * @type {readonly {from: string, specifier: string, resolved: string}[]}
   */
  const RECORDED_EDGES = Object.freeze([
    Object.freeze({
      from: "report/sarif.mjs",
      specifier: "../rules/messages.mjs",
      resolved: "rules/messages.mjs",
    }),
  ]);

  it("carries exactly the recorded report → rules/config edges and not one more (G-5)", () => {
    const edges = forbiddenEdges(modules, intoRuleOrConfigLaw);
    const unrecorded = edges.filter(
      ({ from, specifier, resolved }) =>
        !RECORDED_EDGES.some(
          (edge) =>
            edge.from === from && edge.specifier === specifier && edge.resolved === resolved,
        ),
    );
    expect(
      unrecorded.map(
        ({ from, specifier, resolved }) =>
          `${from} imports ${specifier} (resolves to ${resolved}) — G-5: report renders and ` +
          `decides nothing; rule/config law lives in src/rules and src/config.mjs, and a ` +
          `renderer that imports it decides (BOUNDARIES.md, umbrella #725). A new edge ` +
          `against the ban needs a recorded decision, not a quiet pass`,
      ),
    ).toEqual([]);
    // The roster is a measurement, not a memory: the recorded edge going
    // quiet fails here, so the declaration cannot outlive the tree.
    expect(edges).toEqual([...RECORDED_EDGES]);
  });
});

describe("layer direction imports — G-2: commands never imports lsp", () => {
  const modules = srcModules("commands");

  it("catches a planted commands → lsp import — teeth before the clean verdict", () => {
    const raw =
      'import { publishDiagnostics } from "../lsp/diagnostics.mjs";\nexport const x = 1;\n';
    const hits = edgesOf("commands/check.mjs", raw).filter(({ resolved }) =>
      intoDir("lsp")(resolved),
    );
    expect(hits).toEqual([
      { specifier: "../lsp/diagnostics.mjs", resolved: "lsp/diagnostics.mjs" },
    ]);
  });

  it("lets commands → rules through — the declared order runs commands → rules → report → lsp", () => {
    const raw = 'import { evaluate } from "../rules/index.mjs";\nexport const x = 1;\n';
    const hits = edgesOf("commands/check.mjs", raw).filter(({ resolved }) =>
      intoDir("lsp")(resolved),
    );
    expect(hits).toEqual([]);
  });

  it("scans the command modules — a walk that found nothing would prove nothing", () => {
    expect(modules.length).toBeGreaterThan(25);
    expect(modules).toContain("commands/check.mjs");
  });

  it("reads real edges — the clean verdict must be about a live scan", () => {
    const edgeCount = modules.reduce((count, from) => count + fileEdges(from).length, 0);
    expect(edgeCount).toBeGreaterThan(0);
  });

  it("no module under src/commands imports anything under src/lsp/ (G-2)", () => {
    const edges = forbiddenEdges(modules, intoDir("lsp"));
    expect(
      edges.map(
        ({ from, specifier, resolved }) =>
          `${from} imports ${specifier} (resolves to ${resolved}) — G-2: the #649 gate holds ` +
          `lsp -> commands and this holds commands -> lsp, so the CLI face and the editor ` +
          `face cannot reach into each other from either side (BOUNDARIES.md, umbrella #725)`,
      ),
    ).toEqual([]);
  });
});

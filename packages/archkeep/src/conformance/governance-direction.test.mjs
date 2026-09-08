/**
 * The direction `src/governance/` may face — read by the core it serves, and
 * holding its own one-direction seam against the surface and the acquisition
 * layers. The documents do not draw this seam: `BOUNDARIES.md` ("The
 * intra-src DAG") states the ordered surface chain
 * `commands/ → analysis/ → rules/ → report/` and records the law-facing
 * consumer duty only as `core → governance/` — `config.mjs` and
 * `rules/index.mjs` read the clock, waiver fate and expired-waiver evidence,
 * the registry names. No document declares `governance → X` as a ban; this
 * gate is the one-direction static-import scan that absence left blind, and
 * it asserts the seam ARCHITECTURALLY — the direction the docs' own
 * `core → governance` reading duty and provider-never-decides both imply —
 * rather than citing a written row that does not exist.
 *
 * Governance is a horizontal semantic layer. It observes and it decides; it
 * never acquires and never renders. Held as a one-direction scan over the
 * shipped tree, the same mechanics as `layer-direction-imports.test.mjs`:
 *
 *  - `src/governance/` never imports the surface it is consumed by —
 *    `src/commands/`, and the renderers in `src/report/`. A governance
 *    module that reached a command would have folded the CLI's own preamble
 *    into the semantic layer; one that reached a renderer would be a
 *    governance module that prints. Both are the same category of drift this
 *    suite exists to name.
 *  - `src/governance/` never imports the acquisition layers — `src/providers/`
 *    (the only graph builders), `src/graph/`, `src/workspace.mjs`,
 *    `src/options.mjs` (the only filename-knowing layer), `src/nx-json.mjs`.
 *    Governance receives facts; seeding itself from a second acquisition
 *    authority is the same overreach `BOUNDARIES.md` draws around providers
 *    (a provider never decides) held on the governance clock-face: the
 *    semantic layer that scores decisions must not also hold a graph builder,
 *    because then a governance verdict can be produced from an acquisition
 *    that never crossed the real review path.
 *  - It MAY read the law it scores — `src/rules/`, `src/analysis/`,
 *    `src/config.mjs` — the five edges (`metrics`, `fitness-rules`,
 *    `fitness-registry`, `reconcile-score`, `profile-registry`) are the tree
 *    today and are the floor this scan proves it read; and the shared bottom
 *    (`values`, `canonical`, `containment`, `errors`).
 *  - It MAY further read `src/architecture-intent/selectors.mjs` — a pure
 *    exact-match selector engine (intentionally not `../rules/match.mjs`, no
 *    RegExp is built from selectors), shared semantic vocabulary rather than
 *    a surface reader. Three governance modules reach it today
 *    (`fitness-registry`, `fitness-rules`, `reconcile-score`). The reverse
 *    edge `architecture-intent/model.mjs → governance/row-schema.mjs` is the
 *    same seam from the other side: intent loads and validates its rows with
 *    governance's schema, so the two layers share shape without either
 *    reaching a surface or an acquisition authority. This gate bans neither
 *    direction: both are law-adjacent, and banning them would break the live,
 *    legitimate reads above.
 *
 * The mechanics are the G-1/G-5/G-2 gates' (`layer-direction-imports.test.mjs`),
 * through the shared extractor `layer-edges.mjs`:
 *
 *  - Files are every non-test `.mjs` under `src/governance/`, walked rather
 *    than listed. Test files are outside the invariant — a test drives any
 *    layer directly.
 *  - Edges are static relative import/export-from specifiers, resolved
 *    against the importing module's directory; anything that lands in a
 *    banned layer fails. A dynamic `import()` is out of scope, the same line
 *    the other direction scans hold.
 *  - Comments and strings produce no edges — every match survives a
 *    `maskNonCode` gate.
 *
 * And each gate proves its teeth before it proves the tree: a synthetic
 * banned edge planted in mock source is caught, a legal direction passes,
 * the floor asserts a module count too large for a broken walk to satisfy,
 * and every real-tree scan shows its roster is live before the clean verdict
 * is claimed.
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
 * The resolved relative edges one module's source carries.
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
 * Whether a resolved path is inside `dir` — the dir itself or under it.
 *
 * @param {string} dir Package-relative source directory.
 * @returns {(resolved: string) => boolean}
 */
const intoDir = (dir) => (resolved) => resolved === dir || resolved.startsWith(`${dir}/`);

/**
 * The targets governance may not face: the surface it is consumed by and the
 * acquisition layers that feed the surface, never the semantic layer itself.
 * `config.mjs` is deliberately ABSENT — it is the law governance reads, the
 * same law `rules/` reads; `workspace.mjs`, `options.mjs` and `nx-json.mjs`
 * are the filename/acquire faces and sit beside the provider/graph/world that
 * must not enter governance.
 *
 * @type {(resolved: string) => boolean}
 */
const intoBannedTarget = (resolved) =>
  resolved === "workspace.mjs" ||
  resolved === "options.mjs" ||
  resolved === "nx-json.mjs" ||
  ["commands", "providers", "graph", "workspace", "options", "lsp", "report", "nx-json"].some(
    (dir) => intoDir(dir)(resolved),
  );

describe("governance layer direction — one semantic layer, its allowed reads and its forbiddens", () => {
  const modules = srcModules("governance");

  it("catches a planted governance → commands import — teeth before the clean verdict", () => {
    const raw = 'import { check } from "../commands/check.mjs";\nexport const x = 1;\n';
    const hits = edgesOf("governance/metrics.mjs", raw).filter(({ resolved }) =>
      intoBannedTarget(resolved),
    );
    expect(hits).toEqual([{ specifier: "../commands/check.mjs", resolved: "commands/check.mjs" }]);
  });

  it("catches a planted governance → providers import — acquisition must not enter governance", () => {
    const raw = 'import { readProjectGraph } from "../providers/nx.mjs";\nexport const x = 1;\n';
    const hits = edgesOf("governance/reconcile-score.mjs", raw).filter(({ resolved }) =>
      intoBannedTarget(resolved),
    );
    expect(hits).toEqual([{ specifier: "../providers/nx.mjs", resolved: "providers/nx.mjs" }]);
  });

  it("lets governance → rules through — reading the law is the direction this layer exists for", () => {
    const raw =
      'import { buildReachability } from "../rules/reachability.mjs";\nexport const x = 1;\n';
    const hits = edgesOf("governance/fitness-rules.mjs", raw).filter(({ resolved }) =>
      intoBannedTarget(resolved),
    );
    expect(hits).toEqual([]);
  });

  it("scans the governance modules — a walk that found nothing would prove nothing", () => {
    // Far below the real count means the walk broke; the named modules are
    // the ones the audit's governance rows speak of.
    expect(modules.length).toBeGreaterThan(15);
    expect(modules).toContain("governance/verdict.mjs");
    expect(modules).toContain("governance/metrics.mjs");
    expect(modules).toContain("governance/adr-registry.mjs");
  });

  it("reads real edges — the clean verdict must be about a live scan", () => {
    const edgeCount = modules.reduce((count, from) => count + fileEdges(from).length, 0);
    expect(edgeCount).toBeGreaterThan(0);
  });

  it("the law it reads is actually read — the floor the scan must keep proving", () => {
    // The direction permits governance → rules/analysis/config. The five
    // modules that reach that law today are the concrete roster a clean
    // verdict must contain, so a walk that silently stopped matching them
    // cannot still pass.
    const lawReaders = modules.filter((from) =>
      fileEdges(from).some(
        ({ resolved }) =>
          intoDir("rules")(resolved) || intoDir("analysis")(resolved) || resolved === "config.mjs",
      ),
    );
    expect(lawReaders.length).toBeGreaterThanOrEqual(5);
    expect(lawReaders).toEqual(
      expect.arrayContaining([
        "governance/metrics.mjs",
        "governance/fitness-rules.mjs",
        "governance/fitness-registry.mjs",
        "governance/reconcile-score.mjs",
        "governance/profile-registry.mjs",
      ]),
    );
  });

  it("no module under src/governance imports the surface or acquisition layers", () => {
    const edges = forbiddenEdges(modules, intoBannedTarget);
    expect(
      edges.map(
        ({ from, specifier, resolved }) =>
          `${from} imports ${specifier} (resolves to ${resolved}) — governance is a semantic ` +
          `layer that reads law and is read by the surface; it must not import the surface ` +
          `(commands/, report/) it is consumed by, nor the acquisition layers (providers/, ` +
          `graph/, workspace.mjs, options.mjs, nx-json.mjs) that feed that surface ` +
          `(BOUNDARIES.md "The intra-src DAG")`,
      ),
    ).toEqual([]);
  });
});

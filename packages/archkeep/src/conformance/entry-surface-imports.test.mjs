/**
 * Entry-surface imports — G-4: `cli.mjs`/`lsp.mjs` are faces, not judges.
 * This file makes the claim a gate, because a roster read once is a claim
 * that goes stale with the next edit.
 *
 * What the gate actually holds is NOT the row's literal title — the matrix
 * itself records that `cli.mjs` is not wiring-only (it owns the process
 * surface: argv parsing, help rendering, output writes, run drivers), so a
 * literal wiring-only scan would flag the executable's sanctioned duties.
 * The scannable claim underneath it: the two entry files compose the
 * package through `src/commands/**` (the CLI face) and `src/lsp/**` (the
 * editor face) plus their own process helpers, and never reach past the
 * command layer into the layers that decide or acquire — `src/rules/`,
 * `src/analysis/`, `src/report/`, `src/providers/`. A finding that lands
 * in an entry file is a rule evaluation, a graph walk, a rendering or an
 * import acquisition the command layer was supposed to own.
 *
 * The mechanics are `layer-direction-imports.test.mjs`'s, verbatim, through
 * the shared extractor `layer-edges.mjs` — and so is the scope discipline:
 *
 *  - **Files** are the two shipped entry files, named. They are not walked
 *    because they are not a layer — they are the package's two `bin`-facing
 *    modules, and a third entry file is a `package.json` decision a rename
 *    would surface.
 *  - **Edges** are static `import … from` / `export … from` statements
 *    whose RELATIVE specifier resolves into a banned target, resolved
 *    against the importing file's directory. A dynamic `import()` is
 *    outside the invariant, the same as every other layer gate here.
 *  - **Comments and strings do not produce edges** — every extractor match
 *    is validated against `maskNonCode`.
 *
 * Each gate proves its teeth before it proves the tree: a synthetic
 * violation planted in mock source must be caught, and a legal import must
 * pass, before the real tree is asserted. And because an empty result here
 * is a claim, not a shrug, the real-tree scan first shows its roster is
 * live — both entry files read, a real edge extracted, and at least one
 * edge that resolves into the command layer the faces are supposed to
 * compose through.
 */
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { staticRelativeSpecifiers } from "./layer-edges.mjs";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The shipped entry files — the package's two faces. Named, not walked:
 * this pair is the invariant's whole subject, and `package.json`'s `bin`
 * owns their existence.
 *
 * @type {string[]} Package-relative posix paths.
 */
const ENTRY_FILES = ["cli.mjs", "lsp.mjs"];

/**
 * The resolved relative edges one entry file's source carries.
 *
 * @param {string} relativePath Package-relative path of the entry file.
 * @param {string} raw File source text.
 * @returns {{specifier: string, resolved: string}[]}
 */
function edgesOf(relativePath, raw) {
  return staticRelativeSpecifiers(raw).map((specifier) => ({
    specifier,
    resolved: posix.normalize(posix.join(posix.dirname(relativePath), specifier)),
  }));
}

/**
 * The edges one shipped entry file carries, read from the tree.
 *
 * @param {string} relativePath Package-relative path of the entry file.
 * @returns {{specifier: string, resolved: string}[]} The file's edges.
 */
function fileEdges(relativePath) {
  return edgesOf(relativePath, readFileSync(join(PKG_ROOT, relativePath), "utf-8"));
}

/**
 * Whether a resolved package-relative path sits inside `dir` — the dir
 * itself or anything under it.
 *
 * @param {string} dir Package-relative directory name.
 * @returns {(resolved: string) => boolean} The target test.
 */
const intoDir = (dir) => (resolved) => resolved === dir || resolved.startsWith(`${dir}/`);

/**
 * G-4's target: the layers that decide (`rules`), acquire (`analysis`,
 * `providers`) or render (`report`) — everything an entry file must reach
 * only THROUGH the command layer.
 *
 * @type {(resolved: string) => boolean} The banned-direction test.
 */
const intoJudgingOrAcquiringLayer = (resolved) =>
  intoDir("src/rules")(resolved) ||
  intoDir("src/analysis")(resolved) ||
  intoDir("src/report")(resolved) ||
  intoDir("src/providers")(resolved);

describe("entry surface imports — G-4: cli.mjs and lsp.mjs compose, never judge", () => {
  it("catches a planted cli.mjs → rules import — teeth before the clean verdict", () => {
    const raw = 'import { evaluate } from "./src/rules/index.mjs";\nexport const x = 1;\n';
    const hits = edgesOf("cli.mjs", raw).filter(({ resolved }) =>
      intoJudgingOrAcquiringLayer(resolved),
    );
    expect(hits).toEqual([{ specifier: "./src/rules/index.mjs", resolved: "src/rules/index.mjs" }]);
  });

  it("catches a planted lsp.mjs → providers import — the editor face is held to the same law", () => {
    const raw = 'import { readProjectGraph } from "./src/providers/nx.mjs";\nexport const x = 1;\n';
    const hits = edgesOf("lsp.mjs", raw).filter(({ resolved }) =>
      intoJudgingOrAcquiringLayer(resolved),
    );
    expect(hits).toEqual([
      { specifier: "./src/providers/nx.mjs", resolved: "src/providers/nx.mjs" },
    ]);
  });

  it("lets a face → command-layer import through — the ban names a direction, not an import", () => {
    const raw =
      'import { check } from "./src/commands/check-capability.mjs";\n' +
      'import { createServer } from "./src/lsp/server.mjs";\nexport const x = 1;\n';
    const hits = edgesOf("cli.mjs", raw).filter(({ resolved }) =>
      intoJudgingOrAcquiringLayer(resolved),
    );
    expect(hits).toEqual([]);
  });

  it("scans the shipped entry files — a roster that found nothing would prove nothing", () => {
    // Both files must exist and be readable off the tree; a rename that
    // drops one must break this scan loudly, not silently narrow it.
    for (const entry of ENTRY_FILES) {
      expect(() => fileEdges(entry)).not.toThrow();
    }
  });

  it("reads real edges — the clean verdict must be about a live scan", () => {
    // cli.mjs composes the whole verb roster (far more than a handful of
    // imports) and lsp.mjs wires the server face; a count this low would
    // mean the extractor matched nothing.
    const edgeCount = ENTRY_FILES.reduce((count, from) => count + fileEdges(from).length, 0);
    expect(edgeCount).toBeGreaterThan(15);
  });

  it("cli.mjs composes through the command layer — the scan reads the composition it guards", () => {
    const commandEdges = fileEdges("cli.mjs").filter(({ resolved }) =>
      intoDir("src/commands")(resolved),
    );
    expect(commandEdges.length).toBeGreaterThan(0);
  });

  it("neither entry file imports anything under src/rules, src/analysis, src/report or src/providers (G-4)", () => {
    const edges = ENTRY_FILES.flatMap((from) =>
      fileEdges(from)
        .filter(({ resolved }) => intoJudgingOrAcquiringLayer(resolved))
        .map((edge) => ({ ...edge, from })),
    );
    expect(
      edges.map(
        ({ from, specifier, resolved }) =>
          `${from} imports ${specifier} (resolves to ${resolved}) — G-4: an entry file composes ` +
          `the package through src/commands (CLI face) and src/lsp (editor face) and must not ` +
          `reach into the layers that judge, acquire or render; a finding here is a duty the ` +
          `command layer was supposed to own`,
      ),
    ).toEqual([]);
  });
});

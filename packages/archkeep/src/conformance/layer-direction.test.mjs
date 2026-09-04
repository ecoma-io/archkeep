/**
 * The language server must not reach up into the command layer — and this file
 * is the gate that says so instead of assuming the imports stayed away.
 *
 * Until #649 two modules under `src/lsp/` imported from `src/commands/`:
 * `diagnose.mjs` reached `declaredEdgeViolationsForCheck` and
 * `workspace-index.mjs` reached `requireSingleProjectModel`, both of which
 * lived inside the application layer the declared layer order
 * (`… → commands → rules → report → lsp → conformance`, the root `AGENTS.md`)
 * puts ABOVE `lsp/`. The facilities are shared by both faces, so they moved
 * down — `src/rules/edge-constraints.mjs` and `src/providers/model-gate.mjs` —
 * and the upward edge became impossible. This gate keeps it impossible: a
 * future edit that re-imports a command module from the server gets a red test
 * naming the edge, not a green suite over a layer list nothing enforced.
 *
 * Scope, and why each boundary sits where it sits:
 *
 *  - **Files** are every non-test `.mjs` under `src/lsp/`, walked rather than
 *    listed — a directory list is the copy that goes stale when the next
 *    server module lands. Test files are outside the invariant: a test may
 *    drive the command layer directly, and several legitimately do.
 *  - **Edges** are static `import … from` / `export … from` statements whose
 *    RELATIVE specifier resolves into `src/commands/`. The check resolves the
 *    specifier against the importing file's directory rather than matching the
 *    literal text `../commands/`, so a spelling that lands in the command
 *    layer from any depth is caught all the same. A dynamic `import()` is
 *    outside the invariant the issue names, the same line
 *    `module-graph.test.mjs` holds: a cycle through a lazily-resolved module
 *    is a different finding with a different fix, and no such import exists
 *    under `src/lsp/` today. Bare specifiers are outside the package and
 *    owned by `./boundary.test.mjs`'s allow-list.
 *  - **Comments and strings do not produce edges.** `src/lsp/`'s prose cites
 *    `../commands/context.mjs` by name in several JSDoc blocks — citations of
 *    where the CLI composes what the server consumes, which are true and must
 *    stay — so a scanner that counted them would report an edge nobody can
 *    remove and teach the team to ignore the gate. Every match is validated
 *    against `../intent/mask-non-code.mjs`'s position-preserving mask, the
 *    same arrangement the module-graph guard uses, for the same reason: the
 *    masker's comment/string classification is already pinned by its own
 *    tests.
 *
 * The guard proves its own teeth before it proves the tree: the first tests
 * run the extractor over synthetic input with a known answer, so a scanner
 * that silently stopped matching (the guard's own silent direction) cannot sit
 * green under a clean tree.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { maskNonCode } from "../intent/mask-non-code.mjs";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Static import/export-from spellings, one regex per shape, specifier in
 * group 1. Line-unanchored on purpose: an import statement spans lines in
 * this tree, and a line-anchored scanner would drop that edge in the silent
 * direction.
 *
 * @type {RegExp[]}
 */
const STATIC_IMPORT_PATTERNS = [
  /\bimport\s*\{[^}]*\}\s*from\s*["']([^"']+)["']/g,
  /\bimport\s*\*\s*as\s+[\w$]+\s*from\s*["']([^"']+)["']/g,
  /\bimport\s+[\w$]+\s*(?:,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+\}))?\s*from\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bexport\s*\{[^}]*\}\s*from\s*["']([^"']+)["']/g,
  /\bexport\s*\*\s*from\s*["']([^"']+)["']/g,
];

/**
 * The relative specifiers one module statically imports, comments, strings,
 * template literals and regex literals excluded: a match survives only where
 * `maskNonCode` still shows the source character at the match's own offset.
 *
 * @param {string} raw Module source text.
 * @returns {string[]} Relative specifiers, in source order.
 */
export function staticRelativeSpecifiers(raw) {
  const masked = maskNonCode(raw);
  const found = [];
  for (const pattern of STATIC_IMPORT_PATTERNS) {
    for (const match of raw.matchAll(pattern)) {
      if (masked[match.index] !== raw[match.index]) continue;
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      found.push(specifier);
    }
  }
  return found;
}

/**
 * Walks `src/lsp/` for the non-test modules the invariant covers.
 *
 * @returns {string[]} Package-relative posix paths.
 */
function lspModules() {
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
  walk("lsp");
  return found.sort();
}

/**
 * The upward edges one scanned module carries into `src/commands/`.
 *
 * @param {string} relativePath Package-relative path of the module.
 * @returns {{specifier: string, resolved: string}[]}
 */
function commandLayerEdges(relativePath) {
  const raw = readFileSync(join(SRC_ROOT, relativePath), "utf-8");
  const edges = [];
  for (const specifier of staticRelativeSpecifiers(raw)) {
    const resolved = posix.normalize(posix.join(posix.dirname(relativePath), specifier));
    if (resolved === "commands" || resolved.startsWith("commands/")) {
      edges.push({ specifier, resolved });
    }
  }
  return edges;
}

describe("layer direction guard — the extractor", () => {
  it("reads an import that reaches into src/commands/", () => {
    const raw = 'import { check } from "../commands/check.mjs";\nexport const x = 1;\n';
    expect(staticRelativeSpecifiers(raw)).toEqual(["../commands/check.mjs"]);
  });

  it("reads a multi-line import — the shape a line-anchored scan drops", () => {
    const raw = [
      "import {",
      "  declaredEdgeViolationsForCheck,",
      '} from "../commands/edge-constraints.mjs";',
      "export const y = 2;",
    ].join("\n");
    expect(staticRelativeSpecifiers(raw)).toEqual(["../commands/edge-constraints.mjs"]);
  });

  it("reads the export-from spelling — a re-export is an edge too", () => {
    const raw = 'export { resolveCommandContext } from "../commands/context.mjs";\n';
    expect(staticRelativeSpecifiers(raw)).toEqual(["../commands/context.mjs"]);
  });

  it("does not count a JSDoc citation of a command module — the prose src/lsp really carries", () => {
    const raw = [
      "/**",
      " * The same provider object `../commands/context.mjs` hands `check`, so",
      " * the editor's graph and the CLI's come from one dispatch.",
      " */",
      'import { readProjectGraph } from "../providers/nx.mjs";',
      "export const z = 3;",
    ].join("\n");
    expect(staticRelativeSpecifiers(raw)).toEqual(["../providers/nx.mjs"]);
  });

  it("does not count a specifier spelled inside a string or a comment", () => {
    const raw = [
      "const quoted = \"import { x } from '../commands/check.mjs';\";",
      '// import { y } from "../commands/graph.mjs";',
      "/* import { w } from '../commands/diff.mjs'; */",
      "export const done = 1;",
    ].join("\n");
    expect(staticRelativeSpecifiers(raw)).toEqual([]);
  });

  it("does not count a dynamic import() — the laziness mechanism, not a static edge", () => {
    const raw = ['const load = () => import("../commands/check.mjs");', "export { load };"].join(
      "\n",
    );
    expect(staticRelativeSpecifiers(raw)).toEqual([]);
  });
});

describe("layer direction guard — the shipped server", () => {
  const modules = lspModules();

  it("scans the server's modules", () => {
    // A guard that accidentally walked nothing reports any tree clean, so the
    // roster itself is load-bearing: the server modules the issue named must
    // be in the scan, and the directory must not have shrunk below a floor —
    // far below the real module count means the walk broke, not that src/lsp
    // got small.
    expect(modules.length).toBeGreaterThan(5);
    expect(modules).toContain("lsp/diagnose.mjs");
    expect(modules).toContain("lsp/workspace-index.mjs");
    expect(modules).toContain("lsp/server.mjs");
  });

  it("no module under src/lsp/ imports anything under src/commands/ (#649)", () => {
    const edges = modules.flatMap((relativePath) =>
      commandLayerEdges(relativePath).map((edge) => ({ ...edge, from: relativePath })),
    );
    expect(
      edges.map(
        ({ from, specifier, resolved }) =>
          `${from} imports ${specifier} (resolves to ${resolved}) — src/lsp must not ` +
          `reach up into src/commands: the declared layer order runs commands -> rules ` +
          `-> report -> lsp, and shared facilities belong below both faces (#649)`,
      ),
    ).toEqual([]);
  });
});

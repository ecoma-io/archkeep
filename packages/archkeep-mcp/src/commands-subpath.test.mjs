/**
 * The seam this package exists behind, made checkable: the engine package is
 * imported only through its `./commands` subpath — never through the root
 * entry, and never through any other subpath of it.
 *
 * The root entry is the engine's discovery-and-judgment surface, what
 * `cli.mjs` and `src/lsp/` compose; this package is a client of the command
 * layer the way the VS Code one is a client of the language server. A
 * primitive reached past the command layer is a primitive this package would
 * then compose with decisions of its own, beside the layer that already owns
 * them — a second implementation assembling itself one import at a time.
 * Nothing held that line: `./engine.mjs` imported `findWorkspaceRoot` and
 * `listTrackedFiles` from the root entry for its history `decisions` branch,
 * the one past-seam import in the package, until the composition moved into
 * the command layer (`adrForWorkspace`) in the same change that added this
 * gate. The scan is what keeps it moved.
 *
 * The walk covers the package's own modules — `index.mjs`, `mcp.mjs`,
 * `src/`, the vitest config — minus the test files, which hold this gate's
 * planted cases and must not be judged as the source they police (the same
 * scope discipline as the engine's dependency gate,
 * `../../archkeep/src/conformance/boundary.test.mjs`, whose statement
 * patterns these are, copied rather than imported: importing them would be
 * the past-seam import this gate refuses). The patterns are statement-
 * anchored and unmasked, so a comment written in the shape of an import is
 * read as one — describe imports in prose, the way the comments here do.
 * They are line-unanchored on purpose: `./engine.mjs`'s command-layer block
 * spans many lines, and a line-anchored scanner would drop it in the silent
 * direction.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as engineCommands from "@ecoma-io/archkeep/commands";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The one door to the engine this package may open. */
const COMMANDS_SUBPATH = "@ecoma-io/archkeep/commands";

/** Directories a walk never descends into: installed packages and build output. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "coverage", "dist"]);

/** Every non-test `.mjs` file the package owns, package-relative. */
function shippedSources(directory = PKG_ROOT) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      found.push(...shippedSources(absolute));
      continue;
    }
    if (entry.endsWith(".mjs") && !entry.endsWith(".test.mjs")) {
      found.push(relative(PKG_ROOT, absolute));
    }
  }
  return found;
}

/**
 * The statement shapes whose argument is a module specifier — the engine
 * package's dependency gate's patterns (see the header for why they are
 * copied, not imported).
 *
 * @type {RegExp[]}
 */
const SPECIFIER_PATTERNS = [
  /(?:^|\n)\s*import\s[^;\n]*?from\s*["']([^"']+)["']/gu,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/gu,
  /(?:^|\n)\s*export\s[^;\n"']*?from\s*["']([^"']+)["']/gu,
  /(?:^|\n)\s*\}\s*from\s*["']([^"']+)["']/gu,
  /\bimport\(\s*["']([^"']+)["']\s*\)/gu,
];

/**
 * Every engine-package specifier `file` statically names.
 *
 * @param {string} file Package-relative path of the module to read.
 * @returns {string[]} Engine-package specifiers, in source order.
 */
function engineImports(file) {
  const raw = readFileSync(join(PKG_ROOT, file), "utf8");
  return SPECIFIER_PATTERNS.flatMap((pattern) =>
    [...raw.matchAll(pattern)].map((match) => match[1]),
  ).filter((specifier) => specifier.startsWith("@ecoma-io/archkeep"));
}

/** The engine-package imports of `raw` that are not the `./commands` subpath. */
const pastSubpath = (raw) =>
  SPECIFIER_PATTERNS.flatMap((pattern) => [...raw.matchAll(pattern)].map((match) => match[1]))
    .filter((specifier) => specifier.startsWith("@ecoma-io/archkeep"))
    .filter((specifier) => specifier !== COMMANDS_SUBPATH);

describe("the engine is reached only through the ./commands subpath", () => {
  const sources = shippedSources();

  it("reads the modules it is meant to be checking", () => {
    // A walk that silently returned nothing would make every check below pass.
    expect(sources).toContain("index.mjs");
    expect(sources).toContain("mcp.mjs");
    expect(sources).toContain(join("src", "engine.mjs"));
    expect(sources).toContain(join("src", "server.mjs"));
  });

  it("extracts real engine imports — a clean verdict must be about a live scan", () => {
    // Every adapter composes the command layer, so a count of zero would mean
    // the extractor matched nothing and the verdict below is vacuous.
    // `./engine.mjs`'s command-layer block is the multi-line shape: this
    // assertion is what proves that shape is read.
    const found = sources.flatMap(engineImports);
    expect(found.filter((specifier) => specifier === COMMANDS_SUBPATH).length).toBeGreaterThan(0);
  });

  it.each([
    [
      "a named root-entry import",
      'import { findWorkspaceRoot } from "@ecoma-io/archkeep";\nexport const x = 1;\n',
      "@ecoma-io/archkeep",
    ],
    [
      "a multi-line root-entry import",
      'import {\n  findWorkspaceRoot,\n  listTrackedFiles,\n} from "@ecoma-io/archkeep";\nexport const x = 1;\n',
      "@ecoma-io/archkeep",
    ],
    [
      "a default root-entry import",
      'import archkeep from "@ecoma-io/archkeep";\nexport const x = 1;\n',
      "@ecoma-io/archkeep",
    ],
    [
      "a side-effect root-entry import",
      'import "@ecoma-io/archkeep";\nexport const x = 1;\n',
      "@ecoma-io/archkeep",
    ],
    [
      "a root-entry re-export",
      'export { findWorkspaceRoot } from "@ecoma-io/archkeep";\nexport const x = 1;\n',
      "@ecoma-io/archkeep",
    ],
    [
      "a dynamic root-entry import",
      'const m = await import("@ecoma-io/archkeep");\nexport const x = 1;\n',
      "@ecoma-io/archkeep",
    ],
    [
      "an engine subpath that is not ./commands",
      'import { createDependencies } from "@ecoma-io/archkeep/nx";\nexport const x = 1;\n',
      "@ecoma-io/archkeep/nx",
    ],
  ])("catches %s — teeth before the clean verdict", (_shape, raw, expected) => {
    // Planted in a string, judged by the same matcher the real tree goes
    // through: each import shape this package could grow must fail HERE,
    // named, before a real one ever lands in `src/`.
    expect(pastSubpath(raw)).toEqual([expected]);
  });

  it("lets the ./commands subpath through — the ban names a door, not a dependency", () => {
    const raw =
      'import { adrForWorkspace, UsageError } from "@ecoma-io/archkeep/commands";\n' +
      "export const x = 1;\n";
    expect(pastSubpath(raw)).toEqual([]);
  });

  it("no shipped module imports the engine past the ./commands subpath", () => {
    const offenders = sources.flatMap((file) =>
      engineImports(file)
        .filter((specifier) => specifier !== COMMANDS_SUBPATH)
        .map(
          (specifier) =>
            `${file} imports '${specifier}' — this package composes the engine only through ` +
            `'${COMMANDS_SUBPATH}'; the root entry is the engine's own discovery-and-judgment ` +
            `surface, and a primitive reached past the command layer is a second implementation ` +
            `assembling itself beside it (this file's header owns the argument)`,
        ),
    );
    expect(offenders).toEqual([]);
  });

  it("holds the composition the adapters run on the subpath it is imported from", () => {
    // The preamble this gate pins moved into `adrForWorkspace`; if that
    // export disappears while an adapter still imports it, the package fails
    // to load — but deleted together with its last import, the preamble
    // quietly re-inlines. Requiring it ON the subpath is the tripwire: the
    // driver must stay reachable through the one door this package may open.
    expect(typeof engineCommands.adrForWorkspace).toBe("function");
  });
});

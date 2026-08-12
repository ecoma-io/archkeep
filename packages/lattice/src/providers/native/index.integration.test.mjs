/**
 * Pin: importing this provider's entry module must not load the TypeScript
 * compiler.
 *
 * `./index.mjs`'s own header already claims this — "This module imports
 * NOTHING from `../../workspace.mjs` … a workspace with no `.ts` file in it,
 * or no `nx` installed, must still be able to discover its `lattice.json`
 * projects without paying for a compiler it will never call" — but the claim
 * was false until `./coverage.mjs` stopped importing `languageOf` from
 * `../../analysis/analyze.mjs`. That module eagerly imports every language
 * analyzer, including `analyzeTypeScript`, which does `import ts from
 * "typescript"` at module scope (`../../analysis/typescript.mjs`), so the old
 * chain was `./index.mjs` → `./coverage.mjs` → `../../analysis/analyze.mjs` →
 * `../../analysis/typescript.mjs` → `typescript`. `./coverage.mjs` now reads
 * `languageOf` from `../../analysis/registry.mjs` instead — a compiler-free
 * module holding only the extension→language table — and `../../analysis/analyze.mjs`
 * re-exports the same two names so every other import site keeps working.
 *
 * A native workspace with no TypeScript file and no `typescript` install at
 * all (only `nx` is optional per `package.json`'s `peerDependenciesMeta`, so
 * this is a load-cost claim rather than a hard-failure one: `typescript` is
 * a regular dependency of this package today, and stays resolvable) should
 * still pay nothing to discover its Go/Rust/Python projects. Run as a real
 * subprocess rather than in-process, because Vitest's own module registry for
 * a test file is not a reliable stand-in for "what this module alone pulls
 * in" — a sibling import earlier in the same file, or in Vitest's own
 * machinery, could load `typescript` for a reason that has nothing to do with
 * `./index.mjs`, and an in-process check could not tell the two apart. A
 * fresh `node` process importing only this module is the only check that
 * isolates the claim.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const INDEX_ENTRY = fileURLToPath(new URL("./index.mjs", import.meta.url));

describe("the native provider's entry module, imported in isolation", () => {
  it("does not load the typescript compiler", () => {
    const script = `
      import("node:module").then(async ({ createRequire }) => {
        const require = createRequire(import.meta.url);
        await import(${JSON.stringify(INDEX_ENTRY)});
        const loaded = Object.keys(require.cache ?? {}).filter((id) => id.includes("typescript"));
        process.stdout.write(JSON.stringify(loaded));
      });
    `;
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });
    const loaded = JSON.parse(result);
    expect(loaded).toEqual([]);
  });

  it("positive control: analysis/analyze.mjs (every analyzer, eagerly) DOES load it", () => {
    // Proves `require.cache` is a real signal in this harness rather than one
    // that always reads empty — without this, the test above would pass for
    // the wrong reason (a broken check, not a fixed import graph).
    const analyzeEntry = fileURLToPath(new URL("../../analysis/analyze.mjs", import.meta.url));
    const script = `
      import("node:module").then(async ({ createRequire }) => {
        const require = createRequire(import.meta.url);
        await import(${JSON.stringify(analyzeEntry)});
        const loaded = Object.keys(require.cache ?? {}).filter((id) => id.includes("typescript"));
        process.stdout.write(JSON.stringify(loaded));
      });
    `;
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });
    const loaded = JSON.parse(result);
    expect(loaded.length).toBeGreaterThan(0);
  });
});

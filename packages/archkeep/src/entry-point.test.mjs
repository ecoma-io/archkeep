/**
 * The entry-point predicate, held to the two spellings of one file.
 *
 * The bug this guards against had no failing test because every existing one
 * drove the source tree directly or went through a generated bin shim, and both
 * hand Node the resolved path. The spelling that broke — a symlink into an
 * installed package — appears only in a consumer's `node_modules`, so it is
 * built here on purpose rather than waited for.
 */
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isProgramEntry } from "./entry-point.mjs";

let root;
let real;
let link;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "archkeep-entry-")));
  real = join(root, "real.mjs");
  link = join(root, "link.mjs");
  writeFileSync(real, "export const x = 1;\n", "utf8");
  symlinkSync(real, link);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("deciding whether a module was run or imported", () => {
  it("says yes when the invoked path is the module itself", () => {
    expect(isProgramEntry(pathToFileURL(real).href, real)).toBe(true);
  });

  it("says yes when the invoked path reaches the module through a symlink", () => {
    // The whole reason this module exists. Node records the module URL as the
    // resolved path, so a URL comparison answers false here — and an executable
    // that answers false does nothing at all, silently, at exit 0.
    expect(isProgramEntry(pathToFileURL(real).href, link)).toBe(true);
  });

  it("says no when the invoked path is a different file", () => {
    expect(isProgramEntry(pathToFileURL(real).href, join(root, "other.mjs"))).toBe(false);
  });

  it("says no when Node was given no path to run", () => {
    // `node -e` and the REPL: nothing was invoked, so nothing is the entry.
    // Passing `undefined` explicitly would NOT reach this — it triggers the
    // default parameter, which fills in this process's own argv[1]. The argv
    // must actually be short, the way it is in a `-e` process.
    const saved = process.argv;
    Object.defineProperty(process, "argv", {
      value: [saved[0]],
      configurable: true,
      writable: true,
    });
    try {
      expect(isProgramEntry(pathToFileURL(real).href)).toBe(false);
    } finally {
      Object.defineProperty(process, "argv", {
        value: saved,
        configurable: true,
        writable: true,
      });
    }
  });

  it("compares a path it cannot resolve rather than throwing", () => {
    // A dangling link, or a file deleted between spawn and this call. Comparing
    // verbatim gets one answer wrong; throwing crashes the program with a stack
    // trace naming a file the caller never asked about.
    const dangling = join(root, "dangling.mjs");
    symlinkSync(join(root, "nowhere.mjs"), dangling);
    expect(isProgramEntry(pathToFileURL(dangling).href, dangling)).toBe(true);
    expect(isProgramEntry(pathToFileURL(real).href, dangling)).toBe(false);
  });
});

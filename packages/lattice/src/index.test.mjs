/**
 * The engine entry's one loud export: `createDependencies` throwing when
 * `index.mjs` is reached as if it were the Nx plugin face.
 *
 * Red in the silent direction: delete the guard (or let `index.mjs` go back
 * to re-exporting nothing under that name) and this test is the one that
 * fails — `nx graph` itself stays exit 0 either way (measured against nx
 * 23.1.1 in a throwaway fixture workspace: the bare-package-name
 * misregistration this guards against loads with no warning and computes
 * zero polyglot edges), so nothing short of calling the export directly can
 * tell the silent case from the loud one.
 */
import { describe, expect, it } from "vitest";

import { createDependencies } from "../index.mjs";

describe("the engine entry's guard against a bare plugin registration", () => {
  it("throws, naming the /nx subpath a consumer should register instead", () => {
    expect(() => createDependencies()).toThrow(/@ecoma-io\/lattice\/nx/);
  });
});

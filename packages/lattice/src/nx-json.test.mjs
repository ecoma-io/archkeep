/**
 * `parseNxJson`'s failure contract, driven with the Nx parser unreachable.
 *
 * The module memoises the parser load (`nxParserLoad`), so the "parser could
 * not be reached" state is built once and remembered. That state cannot be
 * produced honestly in a tree where `nx` IS installed — and `nx` is a
 * dependency of this repository — so `node:module` is mocked here to make
 * `createRequire` fail, which is the exact failure a workspace with no Nx
 * produces for real. `vi.resetModules` between the two cases gives each a
 * fresh memoised state; the mock itself is a `vi.hoisted` control that can
 * throw either a message-carrying error or a bare one.
 *
 * The contract pinned: the reader raises, naming the parser that could not be
 * reached, on every text `JSON.parse` rejects — it never falls back to
 * reporting the `JSON.parse` failure alone, which would quietly restore the
 * blind spot this module exists to end (`./nx-json.mjs`'s header).
 */
import { describe, expect, it, vi } from "vitest";

const { failWith } = vi.hoisted(() => ({ failWith: { value: "message" } }));

vi.mock("node:module", () => ({
  createRequire: () => () => {
    // A thrown string, not an Error: `cause?.message` on it is `undefined`,
    // which is the one shape that reaches the `String(cause)` fallback — a
    // bare `new Error()` carries `message: ""`, which `??` keeps.
    if (failWith.value === "no-message") throw "boom";
    throw new Error("Cannot find module 'nx/src/utils/json.js'");
  },
}));

describe("parseNxJson with the Nx parser unreachable", () => {
  it("raises on JSONC text, naming the parser that could not be reached", async () => {
    failWith.value = "message";
    vi.resetModules();
    const { parseNxJson } = await import("./nx-json.mjs");
    // JSON.parse rejects on the trailing comma; the JSONC fallback exists to
    // rescue exactly this text. With the parser unreachable, the raise must
    // say WHY it could not be rescued, not merely that the text is not JSON.
    expect(() => parseNxJson('{"name": "a",\n}')).toThrow(
      /could not be tried, because 'nx\/src\/utils\/json\.js' is not resolvable from here: Cannot find module/,
    );
  });

  it("still raises when the load failure is not an Error at all", async () => {
    // A thrown string — `cause?.message` is `undefined` on it, and the
    // `String(cause)` fallback must still land in the raise rather than in a
    // silent `JSON.parse` rethrow.
    failWith.value = "no-message";
    vi.resetModules();
    const { parseNxJson } = await import("./nx-json.mjs");
    expect(() => parseNxJson('{"name": "a",\n}')).toThrow(/not resolvable from here: boom/);
  });

  it("leaves plain JSON alone: the JSON.parse first pass never reaches the parser", async () => {
    // Plain JSON must load with no parser module touched at all — this tree
    // only pays for the JSONC path on a file that needs it.
    failWith.value = "message";
    vi.resetModules();
    const { parseNxJson } = await import("./nx-json.mjs");
    expect(parseNxJson('{"name": "a"}')).toEqual({ name: "a" });
  });
});

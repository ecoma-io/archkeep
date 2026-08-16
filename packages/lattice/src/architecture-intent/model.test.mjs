import { describe, expect, it } from "vitest";

import {
  INTENT_FILE,
  INTENT_VERSION,
  boundaryNames,
  findIntentViolations,
  loadIntent,
  normalizeIntent,
  TOP_LEVEL_KEYS,
} from "./model.mjs";

const VALID = {
  version: "1",
  boundaries: [
    { name: "packages", match: ["tag:type-package"] },
    { name: "extensions", match: ["tag:type-extension"] },
  ],
  allowed: [{ from: "packages", to: "packages" }],
  forbidden: [
    { from: "extensions", to: "packages", reason: "the client must not reach into the engine" },
  ],
};

const violations = (file) => findIntentViolations(file);
const mentions = (messages, text) => messages.some((message) => message.includes(text));

describe("findIntentViolations — well-formed files", () => {
  it("accepts a file running every rule together", () => {
    expect(violations(VALID)).toEqual([]);
  });

  it("accepts a file with no allowed/forbidden lists at all", () => {
    expect(violations({ version: "1", boundaries: [{ name: "p", match: ["tag:x"] }] })).toEqual([]);
  });
});

describe("findIntentViolations — the top level", () => {
  it("rejects a non-object", () => {
    expect(violations([])).toEqual(["top level: must be an object, got an array ([])"]);
  });

  it("rejects an unknown top-level key by name", () => {
    expect(violations({ ...VALID, stray: true })).toEqual([
      'unknown key "stray" — architecture-intent.json may carry only version, boundaries, allowed, forbidden',
    ]);
  });

  it("rejects an unsupported version", () => {
    expect(mentions(violations({ ...VALID, version: "2" }), 'version: must be exactly "1"')).toBe(
      true,
    );
  });

  it("requires boundaries", () => {
    expect(mentions(violations({ version: "1" }), "boundaries: is required")).toBe(true);
  });

  it("rejects an empty boundaries array — protection that matches nothing", () => {
    expect(
      mentions(violations({ version: "1", boundaries: [] }), "boundaries: must not be empty"),
    ).toBe(true);
  });
});

describe("findIntentViolations — boundary entries", () => {
  it("rejects an unknown boundary key by name", () => {
    expect(
      mentions(
        violations({ ...VALID, boundaries: [{ name: "p", match: ["tag:x"], tagz: "x" }] }),
        "tagz: unknown key",
      ),
    ).toBe(true);
  });

  it("rejects an invalid boundary name", () => {
    expect(
      mentions(
        violations({ ...VALID, boundaries: [{ name: "with:colon", match: ["tag:x"] }] }),
        "name: must be a non-empty string of letters",
      ),
    ).toBe(true);
  });

  it("rejects duplicate boundary names", () => {
    expect(
      mentions(
        violations({
          ...VALID,
          boundaries: [
            { name: "p", match: ["tag:x"] },
            { name: "p", match: ["tag:y"] },
          ],
        }),
        '"p" is declared more than once',
      ),
    ).toBe(true);
  });

  it("rejects an empty match list", () => {
    expect(
      mentions(
        violations({ ...VALID, boundaries: [{ name: "p", match: [] }] }),
        "match: must not be empty",
      ),
    ).toBe(true);
  });

  it("rejects a malformed selector in a match list by name", () => {
    expect(
      mentions(
        violations({ ...VALID, boundaries: [{ name: "p", match: ["tagz:x"] }] }),
        'invalid selector "tagz:x"',
      ),
    ).toBe(true);
  });
});

describe("findIntentViolations — allowed/forbidden rows", () => {
  it("rejects an empty list — a list present but empty decides nothing", () => {
    expect(mentions(violations({ ...VALID, allowed: [] }), "allowed: must not be empty")).toBe(
      true,
    );
    expect(mentions(violations({ ...VALID, forbidden: [] }), "forbidden: must not be empty")).toBe(
      true,
    );
  });

  it("rejects an unknown row key by name", () => {
    expect(
      mentions(
        violations({ ...VALID, forbidden: [{ from: "a", to: "b", reason: "x", weight: 2 }] }),
        ".weight: unknown key",
      ),
    ).toBe(true);
  });

  it("rejects a from/to that is neither a declared boundary nor a valid selector", () => {
    expect(
      mentions(
        violations({ ...VALID, forbidden: [{ from: "scop:core", to: "packages", reason: "x" }] }),
        "forbidden[0].from: must reference a declared boundary",
      ),
    ).toBe(true);
  });

  it("accepts a from/to that is an inline selector", () => {
    expect(
      violations({ ...VALID, forbidden: [{ from: "name:billing", to: "packages", reason: "x" }] }),
    ).toEqual([]);
    expect(violations({ ...VALID, allowed: [{ from: "billing", to: "packages" }] })).toEqual([]);
  });

  it("requires a reason on a forbidden row", () => {
    expect(
      mentions(
        violations({ ...VALID, forbidden: [{ from: "a", to: "b" }] }),
        "reason: is required on a forbidden row",
      ),
    ).toBe(true);
  });

  it("rejects optional on a forbidden row", () => {
    expect(
      mentions(
        violations({ ...VALID, forbidden: [{ from: "a", to: "b", reason: "x", optional: true }] }),
        "optional: is not allowed on a forbidden row",
      ),
    ).toBe(true);
  });

  it("rejects a non-boolean optional on an allowed row", () => {
    expect(
      mentions(
        violations({ ...VALID, allowed: [{ from: "a", to: "b", optional: "yes" }] }),
        ".optional: must be a boolean",
      ),
    ).toBe(true);
  });

  it("rejects a forbidden self-ban on one declared boundary", () => {
    expect(
      mentions(
        violations({
          ...VALID,
          forbidden: [{ from: "packages", to: "packages", reason: "cycle" }],
        }),
        'from and to name the same declared boundary "packages"',
      ),
    ).toBe(true);
  });

  it("rejects a forbidden self-ban spelled with a same single-project selector", () => {
    expect(
      mentions(
        violations({
          ...VALID,
          forbidden: [{ from: "name:billing", to: "name:billing", reason: "cycle" }],
        }),
        "selects a single project",
      ),
    ).toBe(true);
  });

  it("allows an allowed self-reference — a boundary may reach itself", () => {
    expect(violations({ ...VALID, allowed: [{ from: "packages", to: "packages" }] })).toEqual([]);
  });

  it("rejects an allowed⊕forbidden pair overlap", () => {
    expect(
      mentions(
        violations({
          ...VALID,
          allowed: [{ from: "a", to: "b" }],
          forbidden: [{ from: "a", to: "b", reason: "x" }],
        }),
        'allowed and forbidden both state "a→b"',
      ),
    ).toBe(true);
  });
});

describe("loadIntent — reading and parsing", () => {
  /** @type {(contents: string) => (path: string, encoding: "utf8") => Promise<string>} */
  const read = (contents) => async (_path, _encoding) => contents;

  it("returns undefined when the file is absent (ENOENT)", async () => {
    const err = Object.assign(new Error("no such file"), { code: "ENOENT" });
    await expect(
      loadIntent("/ws", {
        read: async () => {
          throw err;
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when tracked is provided and the file is not in it", async () => {
    // `read` would never be called — the file is not tracked — but it must
    // still be a valid reader for the type contract.
    await expect(
      loadIntent("/ws", { read: read("irrelevant"), tracked: ["package.json"] }),
    ).resolves.toBeUndefined();
  });

  it("ignores tracked when it is not provided", async () => {
    const intent = { version: "1", boundaries: [{ name: "p", match: ["tag:x"] }] };
    await expect(loadIntent("/ws", { read: async () => JSON.stringify(intent) })).resolves.toEqual(
      normalizeIntent(intent),
    );
  });

  it("rejects a file that is not strict JSON", async () => {
    // A comment is JSONC, not JSON — this tool's own file is strict JSON.
    await expect(
      loadIntent("/ws", { read: async () => '{ "version": "1" // c\n}' }),
    ).rejects.toThrow(/is not valid strict JSON/);
  });

  it("throws one Error naming every violation at once", async () => {
    const bad = JSON.stringify({ version: "9", boundaries: [], stray: true });
    await expect(loadIntent("/ws", { read: async () => bad })).rejects.toThrow(
      /architecture-intent\.json: /,
    );
  });

  it("surfaces a read error other than ENOENT", async () => {
    await expect(
      loadIntent("/ws", {
        read: async () => {
          throw new Error("permission denied");
        },
      }),
    ).rejects.toThrow(/could not be read/);
  });
});

describe("boundaryNames and normalizeIntent", () => {
  it("returns the declared boundary names in order", () => {
    expect(boundaryNames(normalizeIntent(VALID))).toEqual(["packages", "extensions"]);
  });

  it("normalizes into the model shape the judge consumes", () => {
    const model = normalizeIntent(VALID);
    expect(model.version).toBe(INTENT_VERSION);
    expect(model.boundaries[0]).toEqual({ name: "packages", match: ["tag:type-package"] });
    expect(model.allowed).toHaveLength(1);
    expect(model.forbidden).toHaveLength(1);
  });

  it("defaults absent allowed/forbidden to empty lists", () => {
    const model = normalizeIntent({ version: "1", boundaries: [{ name: "p", match: ["tag:x"] }] });
    expect(model.allowed).toEqual([]);
    expect(model.forbidden).toEqual([]);
  });
});

describe("the file's identity", () => {
  it("names the root file and the one supported version", () => {
    expect(INTENT_FILE).toBe("architecture-intent.json");
    expect(INTENT_VERSION).toBe("1");
    expect(TOP_LEVEL_KEYS).toEqual(["version", "boundaries", "allowed", "forbidden"]);
  });
});

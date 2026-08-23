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
      'unknown key "stray" — architecture-intent.json may carry only version, boundaries, allowed, forbidden, projects, dependencies, forbiddenTags',
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

describe("findIntentViolations — the governance block (Contract 2), per row type", () => {
  const governanceRow = (row) => ({ ...row, ...governanceBlock() });
  const governanceBlock = (overrides = {}) => ({
    origin: { by: "jane@example.com", tool: "lattice:v1" },
    rationale: "decided in the March governance review",
    decisionRef: "adr:0012",
    ...overrides,
  });

  it("accepts a full governance block on every row type", () => {
    const file = {
      version: "1",
      boundaries: [
        { name: "packages", match: ["tag:type-package"] },
        { name: "extensions", match: ["tag:type-extension"] },
      ],
      allowed: [governanceRow({ from: "packages", to: "packages" })],
      forbidden: [governanceRow({ from: "packages", to: "extensions", reason: "x" })],
      projects: {
        required: [governanceRow({ name: "lattice", tags: ["type-package"] })],
        forbidden: [governanceRow({ name: "stray" })],
      },
      dependencies: {
        allowed: [governanceRow({ source: "a", target: "b" })],
        forbidden: [governanceRow({ source: "a", target: "b" })],
      },
      forbiddenTags: [governanceRow({ from: "ui", to: "domain" })],
    };
    expect(violations(file)).toEqual([]);
  });

  it("keeps every legacy row valid without the block — byte-identical parse", () => {
    expect(violations(VALID)).toEqual([]);
  });

  it("rejects an invalid origin on an allowed row, naming the row", () => {
    const messages = violations({
      ...VALID,
      allowed: [{ from: "packages", to: "packages", origin: { tool: "l" } }],
    });
    expect(mentions(messages, "allowed[0].origin.by")).toBe(true);
  });

  it("accepts a committed `on` on an intent row — a static file fact needs no clock to read", () => {
    const messages = violations({
      ...VALID,
      allowed: [
        { from: "packages", to: "packages", origin: { by: "jane", tool: "l", on: "2026-08-16" } },
      ],
    });
    expect(messages).toEqual([]);
  });

  it("rejects an empty rationale and an empty fitnessBindings list on a project row", () => {
    const messages = violations({
      ...VALID,
      projects: {
        required: [{ name: "lattice", rationale: "", fitnessBindings: [] }],
      },
    });
    expect(mentions(messages, "rationale: must be a non-empty string")).toBe(true);
    expect(mentions(messages, "fitnessBindings: must not be empty")).toBe(true);
  });

  it("rejects an unresolvable decisionRef when a registry is injected — but never here", () => {
    // The intent loader validates shape only; RESOLUTION is injected by the
    // capability that owns the registry. A shape-valid reference passes.
    expect(
      violations({
        ...VALID,
        forbidden: [{ from: "packages", to: "extensions", reason: "x", decisionRef: "adr:0012" }],
      }),
    ).toEqual([]);
  });

  it("does not reject the governance keys as unknown — every row-type allow-list grew", () => {
    // Before Contract 2 a row carrying `origin` was rejected by name.
    expect(
      violations({
        ...VALID,
        forbiddenTags: [{ from: "ui", to: "domain", origin: { by: "j", tool: "l" } }],
      }),
    ).toEqual([]);
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

  // The silent direction, and the only one of this loader's three failure
  // modes on an identical tree that was quiet. `../../cli.mjs` establishes the
  // file is TRACKED before it calls here; a dangling symlink, a sparse
  // checkout or an uninitialised submodule then makes the read ENOENT, which
  // was mapped to `undefined` — "the workspace declared no intent".
  // `../commands/drift.mjs`'s `driftForCheck` returns empty findings for that,
  // and `../../cli.mjs` folds empty findings to `intent: {checked: true,
  // verdict: "ok", findings: []}` — `checked: true` about a file nobody read.
  // The two neighbours are both loud: an ESCAPING symlink throws at the
  // containment check, and EACCES throws just above.
  it("refuses a tracked path whose bytes are absent, rather than reading it as no intent at all", async () => {
    const enoent = Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    const run = loadIntent("/ws", {
      tracked: [INTENT_FILE],
      read: async () => {
        throw enoent;
      },
    });
    // Resolving AT ALL is the defect — `undefined` is what every caller reads
    // as "absent", so the wording below is the second half, not the first.
    await expect(run).rejects.toThrow(/is tracked but could not be read/);
  });

  it("still reads ENOENT as absent when the caller supplied no tracked list", async () => {
    // The other direction: with no `tracked` the loader knows nothing about
    // whether the workspace declared the file, so a missing path stays the
    // documented absent answer. The refusal above must not swallow this.
    const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
    await expect(
      loadIntent("/ws", {
        read: async () => {
          throw enoent;
        },
      }),
    ).resolves.toBeUndefined();
  });
});

// F5/F6: three sections whose own comments in `./model.mjs` claimed these
// refusals and did not make them. Each case below loads clean against the
// unfixed loader, which means `drift` and `check` both report a clean verdict
// over a file that decides nothing — the silent direction.
describe("findIntentViolations — sections that read as policy while deciding nothing", () => {
  const withSection = (section) => ({ ...VALID, ...section });

  it.each([
    ["projects: {}", { projects: {} }, "projects: must state required or forbidden"],
    [
      "projects.required: []",
      { projects: { required: [] } },
      "projects.required: must not be empty",
    ],
    [
      "projects.forbidden: []",
      { projects: { forbidden: [] } },
      "projects.forbidden: must not be empty",
    ],
    ["dependencies: {}", { dependencies: {} }, "dependencies: must state allowed or forbidden"],
  ])("rejects %s", (_label, section, expected) => {
    const messages = violations(withSection(section));
    // The load-bearing half: SOME violation is reported. An empty list here is
    // a file that reads as existence/dependency policy and enforces nothing —
    // deleting the last row from `projects.required` leaves exactly this.
    expect(messages).not.toEqual([]);
    expect(mentions(messages, expected)).toBe(true);
  });

  it("rejects projects.required: [] and projects.forbidden: [] together, naming both", () => {
    const messages = violations(withSection({ projects: { required: [], forbidden: [] } }));
    expect(mentions(messages, "projects.required: must not be empty")).toBe(true);
    expect(mentions(messages, "projects.forbidden: must not be empty")).toBe(true);
  });

  it("still accepts a section that states one non-empty list", () => {
    // The refusals above must fire on emptiness, not on a section that names
    // only one of its two lists — the shape this repository's own
    // `architecture-intent.json` carries.
    expect(violations(withSection({ projects: { required: [{ name: "core" }] } }))).toEqual([]);
    expect(
      violations(withSection({ dependencies: { forbidden: [{ source: "a", target: "b" }] } })),
    ).toEqual([]);
  });

  // F6: `../architecture-intent/judge.mjs` skips a self-pair (`source !==
  // target` guards the reachability walk, because every project reaches
  // itself), so the row was COUNTED as an intent row — `drift` prints it in
  // its "N rows" claim — and then decided nothing. The same concept is
  // refused twice already in `./model.mjs`: the boundary self-ban, whose
  // comment says "reading it as holding would be the silent direction", and
  // `forbiddenTags`' `from === to`. This spelling got neither.
  it("rejects a dependencies.forbidden row banning a project from itself", () => {
    const messages = violations(
      withSection({ dependencies: { forbidden: [{ source: "app", target: "app" }] } }),
    );
    expect(messages).not.toEqual([]);
    expect(mentions(messages, "dependencies.forbidden[0]: source and target must differ")).toBe(
      true,
    );
  });

  it("keeps a dependencies.allowed self-pair legal", () => {
    // Deliberately not the same rule: a dependency allow-list is exhaustive,
    // so a self-pair in it states which edges are permitted rather than
    // banning nothing.
    expect(
      violations(withSection({ dependencies: { allowed: [{ source: "app", target: "app" }] } })),
    ).toEqual([]);
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
    expect(TOP_LEVEL_KEYS).toEqual([
      "version",
      "boundaries",
      "allowed",
      "forbidden",
      "projects",
      "dependencies",
      "forbiddenTags",
    ]);
  });
});

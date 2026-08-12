/**
 * The config reader against a real file that really changes.
 *
 * Integration rather than unit, and the tier is the point: the behaviour being
 * pinned IS the ESM module cache, which only exists in a process that outlives
 * the edit. A mocked `import()` would agree with any implementation.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readBoundaryConfig } from "./boundary-config.mjs";

/**
 * The filename these tests write and read, and it is deliberately NOT the
 * default. The reader takes the name from its caller now, and a fixture that
 * used the convention would pass just as well against a reader that had gone
 * back to a constant — the whole option would be untested while looking covered.
 */
const CONFIG_FILE = "boundaries.fixture.mjs";

/** The `.json` dialect's sibling of {@link CONFIG_FILE}, for the parity test below. */
const CONFIG_FILE_JSON = "boundaries.fixture.json";

const MODULE_BOUNDARY_OPTIONS = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

const config = (tag) => `
export const depConstraints = [
  { sourceTag: ${JSON.stringify(tag)}, onlyDependOnLibsWithTags: ["zone:inner"] },
];
export const moduleBoundaryOptions = ${JSON.stringify(MODULE_BOUNDARY_OPTIONS)};
`;

/** The `.json` dialect's equivalent of {@link config} — same data, JSON syntax. */
const jsonConfig = (tag) =>
  JSON.stringify({
    depConstraints: [{ sourceTag: tag, onlyDependOnLibsWithTags: ["zone:inner"] }],
    moduleBoundaryOptions: MODULE_BOUNDARY_OPTIONS,
  });

let root;
const write = (text) => writeFileSync(join(root, CONFIG_FILE), text, "utf8");
const writeJson = (text) => writeFileSync(join(root, CONFIG_FILE_JSON), text, "utf8");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lattice-config-"));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("reading a boundary config that outlives the process reading it", () => {
  it("re-reads the file at a new revision, which is why a config change can re-diagnose", () => {
    // Without the revision, `import()` hands back the module it memoised when
    // the editor opened, and the server re-diagnoses every open file against a
    // constraint table that no longer exists — while looking like it refreshed.
    write(config("zone:first"));

    return readBoundaryConfig(root, 0, CONFIG_FILE).then((first) => {
      expect(first.depConstraints[0].sourceTag).toBe("zone:first");
      write(config("zone:second"));

      return Promise.all([
        readBoundaryConfig(root, 0, CONFIG_FILE),
        readBoundaryConfig(root, 1, CONFIG_FILE),
      ]).then(([sameRevision, nextRevision]) => {
        // The same revision is the memoised module — deliberately, so a
        // diagnosis of ten open files pays for one load, not ten.
        expect(sameRevision.depConstraints[0].sourceTag).toBe("zone:first");
        expect(nextRevision.depConstraints[0].sourceTag).toBe("zone:second");
      });
    });
  });

  it("refuses a malformed table rather than enforcing the half of it that parsed", async () => {
    // The validation is `../config.mjs`'s, reached rather than restated: two
    // answers to "is this table well-formed" would disagree the day one moved.
    write(`
      export const depConstraints = [{ sourceTags: "typo" }];
      export const moduleBoundaryOptions = {};
    `);

    await expect(readBoundaryConfig(root, 2, CONFIG_FILE)).rejects.toThrow(/is malformed/u);
  });

  it("names the file it could not load, since a missing law enforces nothing silently", async () => {
    const empty = mkdtempSync(join(tmpdir(), "lattice-config-empty-"));
    try {
      await expect(readBoundaryConfig(empty, 0, CONFIG_FILE)).rejects.toThrow(
        // `RegExp.escape` rather than a hand-rolled `.` replacement: escaping
        // one meta-character leaves every other one live, which CodeQL flags as
        // `js/incomplete-sanitization` and is right to. Node 24 is the floor
        // here (`.node-version`), and it has the built-in.
        // @ts-expect-error -- `RegExp.escape` is real on Node >= 24
        // (`.node-version`); TypeScript 5.9 ships no lib that declares it yet.
        new RegExp(`cannot load .*${RegExp.escape(CONFIG_FILE)}`, "u"),
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("the .json dialect, which this server used to be unable to load at all", () => {
  // Before `readBoundaryConfig` dispatched on extension, a `.json`
  // `boundaryConfig` reached the `.mjs` arm's bare `import()`, which Node
  // refuses for JSON with `ERR_IMPORT_ATTRIBUTE_MISSING` — a message about
  // import attributes, not about the missing dialect support that was the
  // real cause.
  it("loads a .json boundaryConfig and reaches the same verdict as its .mjs sibling", async () => {
    write(config("zone:parity"));
    writeJson(jsonConfig("zone:parity"));

    const [fromModule, fromJson] = await Promise.all([
      readBoundaryConfig(root, 10, CONFIG_FILE),
      readBoundaryConfig(root, 10, CONFIG_FILE_JSON),
    ]);

    expect(fromJson).toEqual(fromModule);
  });

  it("refuses a malformed .json file rather than silently enforcing nothing", async () => {
    writeJson("{ this is not valid JSON");

    // Asserts an error was actually thrown — not only that its message
    // happens to contain the right words. A loader that swallowed the parse
    // failure and resolved to `{ depConstraints: [], options: {} }` would
    // still pass a message-only assertion made against a DIFFERENT, earlier
    // call; awaiting the rejection itself is what a silent fallback fails.
    await expect(readBoundaryConfig(root, 11, CONFIG_FILE_JSON)).rejects.toThrow(Error);
    await expect(readBoundaryConfig(root, 11, CONFIG_FILE_JSON)).rejects.toThrow(
      /cannot load .*boundaries\.fixture\.json/u,
    );
  });
});

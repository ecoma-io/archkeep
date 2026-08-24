/**
 * The config reader against a real file that really changes.
 *
 * Integration rather than unit, and the tier is the point: the behaviour being
 * pinned IS the ESM module cache, which only exists in a process that outlives
 * the edit. A mocked `import()` would agree with any implementation.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * Escapes every regular-expression meta-character in `text` so it can be
 * interpolated into a `RegExp` literal as a literal string.
 *
 * Stands in for `RegExp.escape` (a Node >= 24 built-in): the suite must also
 * run on Node 22, this package's declared floor (`package.json` engines), so
 * the same no-Node-24-only-API rule applies to tests as to shipped code.
 * Escaping every meta-character — rather than a hand-picked one of them —
 * is the half that keeps the assertion honest: a meta-character left live
 * in the filename would quietly widen what the pattern accepts, which
 * CodeQL flags as `js/incomplete-sanitization` and is right to.
 *
 * @param {string} text
 * @returns {string}
 */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// The red-direction for the helper: `.` matches a literal `.` even unescaped,
// so the assertions below that interpolate real filenames cannot tell an
// escaping helper from a no-op one. A `+` has no such fallback — `a+b`
// unescaped would match `aab` — so this is the case that goes red if the
// char class breaks.
expect(escapeRegExp("a+b")).toBe("a\\+b");
expect(new RegExp(escapeRegExp("a+b"), "u").test("aab")).toBe(false);
expect(new RegExp(escapeRegExp("a+b"), "u").test("a+b")).toBe(true);

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
  root = mkdtempSync(join(tmpdir(), "archkeep-config-"));
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

  it("refuses an unknown top-level export in the .mjs dialect, the same law the CLI's loader applies", async () => {
    // The silent-direction failure this guards: the editor arm of the `.mjs`
    // dialect used to load a misspelled export and diagnose every open file
    // against the no-op law it left behind — a typo'd rule that looked live.
    // The CLI's `loadBoundaryConfigFile` already refused the identical typo
    // at `../config.mjs`; the editor reads through the same two validators
    // now (`../config.mjs`'s `policyFrom` + `policyKeyViolations`), and a
    // config the CLI refuses must not load clean in the editor.
    write(`
      export const depConstraints = [];
      export const moduleBoundaryOptions = ${JSON.stringify(MODULE_BOUNDARY_OPTIONS)};
      export const moduleBoundaryOption = [];
    `);

    return expect(readBoundaryConfig(root, 4, CONFIG_FILE)).rejects.toThrow(
      /moduleBoundaryOption: not a recognised top-level key/,
    );
  });

  it("loads a policy that declares customRules, and refuses a malformed row the same way the CLI does", async () => {
    // The fifth top-level law reaches this face through the shared
    // `policyKeyViolations`/`policyFrom` pair, so no dispatch here knows about
    // it by name — which is exactly what has to be pinned: a law the CLI reads
    // and the editor refuses (or silently drops) would make one face's verdict
    // unexplainable from the other's. The server does not EVALUATE the rows —
    // a custom rule is a per-run workspace judgment, not a per-file diagnostic,
    // the same posture fitness takes — so what it owes them is to load them
    // and to fail loudly on a row it cannot read.
    const rule = {
      name: "no-interface-outside-domain",
      artifact: "tools/rules/no_interface_outside_domain.wasm",
      sha256: "d".repeat(64),
      reason: "interfaces are the domain's ports",
    };
    write(`${config("zone:custom")}export const customRules = ${JSON.stringify([rule])};\n`);
    const loaded = await readBoundaryConfig(root, 30, CONFIG_FILE);
    expect(loaded.customRules).toEqual([rule]);

    write(
      `${config("zone:custom")}export const customRules = ${JSON.stringify([
        { ...rule, artifact: "../outside/rule.wasm" },
      ])};\n`,
    );
    await expect(readBoundaryConfig(root, 31, CONFIG_FILE)).rejects.toThrow(
      /customRules\[0\]\.artifact: .* leaves the workspace/u,
    );
  });

  it("names the file it could not load, since a missing law enforces nothing silently", async () => {
    const empty = mkdtempSync(join(tmpdir(), "archkeep-config-empty-"));
    try {
      await expect(readBoundaryConfig(empty, 0, CONFIG_FILE)).rejects.toThrow(
        // `escapeRegExp` rather than `RegExp.escape` (Node >= 24, tests must
        // also run on Node 22): escaping every meta-character leaves none live,
        // which is the half that keeps a meta-character in the filename from
        // quietly widening what this pattern accepts.
        new RegExp(`cannot load .*${escapeRegExp(CONFIG_FILE)}`, "u"),
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("refuses a boundaryConfig whose symlinked intermediate resolves outside the workspace (G-10, LSP law read)", async () => {
    // The read escape held on the language-server face of the same law: a
    // committed symlink in an intermediate component of `boundaryConfig`
    // hands outside constraint rows in as the workspace's law, and the editor
    // re-diagnoses every open file against them — an open file judged clean
    // against bytes this tree never committed. `readBoundaryConfig` holds the
    // same containment refusal `../config.mjs`'s `loadBoundaryConfig` does.
    const escape = mkdtempSync(join(tmpdir(), "archkeep-config-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "archkeep-config-symlink-outside-"));
    try {
      writeFileSync(
        join(outside, "law.mjs"),
        `export const depConstraints = [];\nexport const moduleBoundaryOptions = [];\n`,
        "utf8",
      );
      mkdirSync(join(escape, "sub"), { recursive: true });
      rmSync(join(escape, "sub"), { recursive: true, force: true });
      symlinkSync(outside, join(escape, "sub"));

      await expect(readBoundaryConfig(escape, 0, "sub/law.mjs")).rejects.toThrow(
        /cannot load .*sub[\\/]law\.mjs: .*outside the workspace root/su,
      );
    } finally {
      rmSync(escape, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses an ESLint flat-config boundaryConfig by name, before ever importing it", async () => {
    // `../eslint-config.mjs` reads this dialect for the CLI and Nx-plugin
    // faces, but this reader was not built against either of its two
    // mechanisms (`@nx/eslint-plugin` resolution, revision-suffixed import) —
    // see this module's header. A workspace naming `eslint.config.mjs` here
    // must get a named refusal, not the misleading "not a module object" that
    // importing the flat-config array as a plain module would otherwise throw.
    writeFileSync(join(root, "eslint.config.mjs"), "export default [];", "utf8");

    await expect(readBoundaryConfig(root, 0, "eslint.config.mjs")).rejects.toThrow(
      /names an ESLint config .*eslint\.config\.mjs.* as boundaryConfig.*policy-schema\.md/su,
    );
  });

  it("refuses a legacy .eslintrc boundaryConfig by name, same as the ESLint flat-config dialect", async () => {
    writeFileSync(join(root, ".eslintrc.json"), "{}", "utf8");

    await expect(readBoundaryConfig(root, 0, ".eslintrc.json")).rejects.toThrow(
      /names an ESLint config .*\.eslintrc\.json.* as boundaryConfig/su,
    );
  });

  it("refuses an unsupported extension by name, which is a naming mistake and not a load failure", async () => {
    // The message separates the two problems: a `.yaml` boundaryConfig is a
    // filename problem, not a missing or unreadable file, and would read as
    // one otherwise.
    await expect(readBoundaryConfig(root, 0, "boundaries.config.yaml")).rejects.toThrow(
      /unsupported boundaryConfig extension '\.yaml'/,
    );
  });

  it("refuses an extensionless name with the empty extension spelled out", async () => {
    await expect(readBoundaryConfig(root, 0, "boundaries")).rejects.toThrow(
      /unsupported boundaryConfig extension '\(none\)'/,
    );
  });

  it("names the config file when the module itself throws on import", async () => {
    // A config whose module body throws is a load failure like any other, and
    // must name the file — a missing law enforces nothing silently. The throw
    // shape is a plain string, so the fallback path is exercised too.
    write("throw 'module exploded';\n");
    await expect(readBoundaryConfig(root, 3, CONFIG_FILE)).rejects.toThrow(
      /cannot load .*boundaries\.fixture\.mjs: module exploded/,
    );
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

  it("names the file when a .json boundaryConfig cannot be read at all", async () => {
    await expect(readBoundaryConfig(root, 12, "missing.json")).rejects.toThrow(
      /cannot load .*missing\.json/u,
    );
  });
});

describe("the inline dialect, where the law is data on archkeep.json rather than a file", () => {
  // The third spelling `./server.mjs`'s `readWorkspaceOptions` can hand this
  // reader: a native root that carries its policy on `archkeep.json`'s own
  // `boundaryConfig` field. It reaches the same `policyFrom` the two file
  // dialects do, and these cases are what hold it there.
  const inline = (tag) => ({
    depConstraints: [{ sourceTag: tag, onlyDependOnLibsWithTags: ["zone:inner"] }],
    moduleBoundaryOptions: MODULE_BOUNDARY_OPTIONS,
  });

  it("reaches the same verdict as the identical law written to a file", async () => {
    // The assertion that makes this dialect support rather than a second
    // implementation: same data, two spellings, one answer. A reader that
    // shaped the inline object differently — dropping `suppressions`'s `[]`
    // default, say — would pass every test that only checked it "loaded".
    write(config("zone:inline-parity"));

    const [fromModule, fromInline] = await Promise.all([
      readBoundaryConfig(root, 20, CONFIG_FILE),
      readBoundaryConfig(root, 20, inline("zone:inline-parity")),
    ]);

    expect(fromInline).toEqual(fromModule);
  });

  it("refuses a malformed inline policy rather than enforcing the half of it that is well-formed", async () => {
    // The silent direction for this dialect, and the row chosen is the one
    // `../config.mjs` describes as approving everything: no `sourceTag` and no
    // `allSourceTags` matches no project, so a reader that let it through
    // would enforce a table with a hole in it and report clean.
    // `../providers/native/model.mjs` validates the object at load, which
    // makes this the second pass — the one that matters if a future caller
    // ever reaches this function without going through that loader.
    const malformed = {
      depConstraints: [{ onlyDependOnLibsWithTags: ["zone:inner"] }],
      moduleBoundaryOptions: MODULE_BOUNDARY_OPTIONS,
    };

    await expect(readBoundaryConfig(root, 21, malformed)).rejects.toThrow(Error);
    await expect(readBoundaryConfig(root, 21, malformed)).rejects.toThrow(
      /inline policy on archkeep\.json's boundaryConfig/u,
    );
  });

  it("refuses an unknown top-level key, the same law both file dialects apply", async () => {
    // A typo'd key is the defect this law exists for: `moduleBoundaryOption`
    // silently ignored is a full green run against options nobody set. The
    // inline form gets the identical treatment, through the identical
    // validator, rather than a laxer one because it is "already validated".
    await expect(
      readBoundaryConfig(root, 22, { ...inline("zone:typo"), moduleBoundaryOption: {} }),
    ).rejects.toThrow(/moduleBoundaryOption/u);
  });

  it("accepts $schema, which an inline policy carries for the same reason a .json file does", async () => {
    const policy = { $schema: "https://example.invalid/archkeep.schema.json", ...inline("zone:s") };

    await expect(readBoundaryConfig(root, 23, policy)).resolves.toMatchObject({
      depConstraints: [{ sourceTag: "zone:s", onlyDependOnLibsWithTags: ["zone:inner"] }],
    });
  });

  it("carries customRules through the inline form too, validated by the same tail", async () => {
    const rule = {
      name: "no-interface-outside-domain",
      artifact: "tools/rules/no_interface_outside_domain.wasm",
      sha256: "e".repeat(64),
      reason: "interfaces are the domain's ports",
    };
    const loaded = await readBoundaryConfig(root, 25, {
      ...inline("zone:custom"),
      customRules: [rule],
    });
    expect(loaded.customRules).toEqual([rule]);

    await expect(
      readBoundaryConfig(root, 26, {
        ...inline("zone:custom"),
        customRules: [{ ...rule, name: "Not A Rule Name" }],
      }),
    ).rejects.toThrow(/customRules\[0\]\.name: must be a non-empty name of lowercase letters/u);
  });

  it("reads whatever object it is handed, so an edited inline law is never served from a cache", async () => {
    // The inline analogue of the revision test at the top of this file, and
    // the reason `readBoundaryConfig` spends no revision on this dialect: the
    // freshness guarantee lives one layer up, in `readWorkspaceOptions`
    // re-reading `archkeep.json` per invalidation. What this pins is that the
    // reader adds no cache of its own on top of it — two calls at the SAME
    // revision with different objects must not agree, which is exactly what a
    // memoised-by-revision implementation would get wrong.
    const before = await readBoundaryConfig(root, 24, inline("zone:before"));
    const after = await readBoundaryConfig(root, 24, inline("zone:after"));

    expect(before.depConstraints[0].sourceTag).toBe("zone:before");
    expect(after.depConstraints[0].sourceTag).toBe("zone:after");
  });
});

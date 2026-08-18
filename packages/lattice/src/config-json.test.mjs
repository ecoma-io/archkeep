import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadBoundaryConfig, loadBoundaryConfigFile } from "./config.mjs";

/** A minimal well-formed policy, in the shape either dialect reads. */
const wellFormedPolicy = () => ({
  depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
  moduleBoundaryOptions: {
    allow: [],
    buildTargets: ["build"],
    enforceBuildableLibDependency: false,
    allowCircularSelfDependency: false,
    checkDynamicDependenciesExceptions: [],
    ignoredCircularDependencies: [],
    banTransitiveDependencies: false,
    checkNestedExternalImports: false,
  },
});

/**
 * An injectable `readFile` over an in-memory file map — no tmpdir, no real
 * disk — for driving the `.json` dialect the same way every other resolver in
 * this package is tested: pure logic, a fake reader, no filesystem in the
 * loop. `loadModulePolicy` (the `.mjs`/`.js` half) has no such seam — it always
 * `import()`s — so tests that exercise it need real files, in the tmpdir
 * fixture further down this file.
 *
 * @param {Record<string, string>} files Absolute path → file contents.
 */
const fakeReadFile = (files) => async (path) => {
  if (!(path in files)) {
    const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
    // @ts-expect-error -- mirroring node:fs's own error shape closely enough
    // for `cause?.message` to read the same as a real ENOENT would.
    error.code = "ENOENT";
    throw error;
  }
  return files[path];
};

describe("loadBoundaryConfigFile — extension dispatch", () => {
  // The silent-direction failure this guards: a `boundaryConfig` misspelt to
  // an unsupported extension must not be swallowed into the generic
  // "cannot load" message, which reads exactly like a missing file and sends
  // a reader looking for a file that IS there, just under a spelling this
  // loader refuses to read.
  it("refuses an unsupported extension by name, distinct from a missing-file message", async () => {
    for (const path of [
      "/repo/module-boundaries.config.yaml",
      "/repo/module-boundaries.config.toml",
      "/repo/module-boundaries.config",
      "/repo/module-boundaries.config.mjsx",
      "/repo/module-boundaries.config.ts",
    ]) {
      let error;
      try {
        await loadBoundaryConfigFile(path);
      } catch (caught) {
        error = caught;
      }
      expect(error, path).toBeDefined();
      expect(error.message, path).toMatch(/unsupported boundaryConfig extension/);
      expect(error.message, path).not.toMatch(/cannot load/);
    }
  });

  it("names the empty extension distinctly, for a boundaryConfig with none at all", async () => {
    await expect(loadBoundaryConfigFile("/repo/module-boundaries-config")).rejects.toThrow(
      /unsupported boundaryConfig extension '\(none\)'/,
    );
  });

  it("treats .JSON as unsupported — dispatch is exact, not case-insensitive", async () => {
    // Not a defect this loader needs to correct: every filename it reads
    // comes from a workspace's own option or `lattice.json` field, and a
    // workspace that wrote `.JSON` gets a named refusal rather than a guess
    // at what it meant.
    await expect(loadBoundaryConfigFile("/repo/module-boundaries.config.JSON")).rejects.toThrow(
      /unsupported boundaryConfig extension '\.JSON'/,
    );
  });
});

describe("loadBoundaryConfigFile — the .mjs/.js dialect is unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "polyglot-config-mjs-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const write = (name, text) => writeFileSync(join(root, name), text);

  const moduleText = `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;

  write("policy.mjs", moduleText);
  write("policy.js", moduleText);

  it("still dispatches .mjs through import() with only the four recognised exports", async () => {
    const config = await loadBoundaryConfigFile(join(root, "policy.mjs"));
    expect(config.depConstraints).toHaveLength(1);
    expect(config.suppressions).toEqual([]);
  });

  it("dispatches .js through import() the same way .mjs does", async () => {
    const config = await loadBoundaryConfigFile(join(root, "policy.js"));
    expect(config.depConstraints).toHaveLength(1);
  });

  it("refuses an unknown top-level export in the .mjs dialect, by name — the same law the .json dialect has", async () => {
    write(
      "typo.mjs",
      `export const depConstraints = [];
export const moduleBoundaryOptions = ${JSON.stringify({
        allow: [],
        buildTargets: ["build"],
        enforceBuildableLibDependency: false,
        allowCircularSelfDependency: false,
        checkDynamicDependenciesExceptions: [],
        ignoredCircularDependencies: [],
        banTransitiveDependencies: false,
        checkNestedExternalImports: false,
      })};
export const moduleBoundaryOption = [];
`,
    );
    // The silent-direction failure this guards: a misspelled top-level export
    // used to load exit-0 and disappear — a typo'd law is a law that is not
    // enforced. The identical typo in `.json` was already refused by name.
    await expect(loadBoundaryConfigFile(join(root, "typo.mjs"))).rejects.toThrow(
      /moduleBoundaryOption: not a recognised top-level key/,
    );
  });

  it("still reports a malformed .mjs the same way it always has", async () => {
    write("broken.mjs", `export const depConstraints = "not an array";`);
    await expect(loadBoundaryConfigFile(join(root, "broken.mjs"))).rejects.toThrow(
      /is malformed:\n {2}depConstraints: must be an exported array/,
    );
  });
});

describe("loadBoundaryConfigFile — the .json dialect", () => {
  it("accepts a well-formed .json policy", async () => {
    const readFile = fakeReadFile({ "/repo/policy.json": JSON.stringify(wellFormedPolicy()) });
    const config = await loadBoundaryConfigFile("/repo/policy.json", { readFile });
    expect(config.depConstraints).toEqual(wellFormedPolicy().depConstraints);
    expect(config.options).toEqual(wellFormedPolicy().moduleBoundaryOptions);
    expect(config.suppressions).toEqual([]);
  });

  it("accepts a string $schema, the one carve-out from the unknown-key rejection", async () => {
    const readFile = fakeReadFile({
      "/repo/policy.json": JSON.stringify({
        $schema: "https://example.invalid/lattice-boundary-config.schema.json",
        ...wellFormedPolicy(),
      }),
    });
    const config = await loadBoundaryConfigFile("/repo/policy.json", { readFile });
    expect(config.depConstraints).toEqual(wellFormedPolicy().depConstraints);
  });

  it("rejects a $schema that is not a non-empty string — accepted is not the same as unchecked", () => {
    // The carve-out must not regress to silently tolerating a value that
    // states nothing: a `$schema` an editor cannot validate against reads as
    // a false green. The identical check binds the inline lattice.json form.
    const readFile = fakeReadFile({
      "/repo/policy.json": JSON.stringify({ ...wellFormedPolicy(), $schema: 42 }),
    });
    return expect(loadBoundaryConfigFile("/repo/policy.json", { readFile })).rejects.toThrow(
      /\$schema: must be a non-empty string naming the schema the editor should validate against, got number \(42\)/,
    );
  });

  // The silent-direction failure: an unrecognised key in a JSON object has no
  // legitimate reason to be there (unlike an ES module's exports), so it must
  // be named rather than dropped — dropping it would mean the constraint
  // table an author thought they wrote (under a misspelt key) never loads at
  // all, and the run reports a clean tree over a law that was never read.
  it("rejects an unrecognised top-level key by name", async () => {
    const readFile = fakeReadFile({
      "/repo/policy.json": JSON.stringify({ ...wellFormedPolicy(), depConstraint: [] }),
    });
    await expect(loadBoundaryConfigFile("/repo/policy.json", { readFile })).rejects.toThrow(
      /is malformed:\n {2}depConstraint: not a recognised top-level key/,
    );
  });

  // Spec's red-direction case: `{}` must not be read as a legal "no
  // constraints" statement. Both required keys are absent, so it has to
  // throw — a loader that instead reshaped it to
  // `{depConstraints: [], options: undefined, suppressions: []}` would
  // approve every import in the workspace while reporting nothing, and this
  // asserts the rejection itself, not merely that some later, unrelated
  // "no violations" read is absent.
  it("rejects {} as a .json policy, naming both missing required keys", async () => {
    const readFile = fakeReadFile({ "/repo/policy.json": "{}" });
    let error;
    try {
      await loadBoundaryConfigFile("/repo/policy.json", { readFile });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/depConstraints: must be an exported array/);
    expect(error.message).toMatch(/moduleBoundaryOptions: must be an exported object/);
  });

  it("rejects a missing file with the same 'cannot load' wrapper the .mjs dialect uses", async () => {
    const readFile = fakeReadFile({});
    await expect(loadBoundaryConfigFile("/repo/policy.json", { readFile })).rejects.toThrow(
      /lattice: cannot load \/repo\/policy\.json: ENOENT/,
    );
  });

  // Plain JSON.parse, never JSONC — unlike `lattice.json`'s own tolerant
  // parser (`./providers/native/model.mjs`). A trailing comma here must fail,
  // not be silently stripped, so a `.json` policy file carries no more syntax
  // than the format it declares itself to be.
  it("rejects a trailing comma — the .json dialect is never JSONC-tolerant", async () => {
    const readFile = fakeReadFile({
      "/repo/policy.json": `{"depConstraints": [],"moduleBoundaryOptions": {},}`,
    });
    await expect(loadBoundaryConfigFile("/repo/policy.json", { readFile })).rejects.toThrow(
      /lattice: cannot load \/repo\/policy\.json:/,
    );
  });

  it("rejects a comment — the .json dialect is never JSONC-tolerant either", async () => {
    const readFile = fakeReadFile({
      "/repo/policy.json": `{
        // not accepted here
        "depConstraints": [],
        "moduleBoundaryOptions": {}
      }`,
    });
    await expect(loadBoundaryConfigFile("/repo/policy.json", { readFile })).rejects.toThrow(
      /lattice: cannot load \/repo\/policy\.json:/,
    );
  });

  it("reports a non-object top level through the same validator every dialect shares", async () => {
    const readFile = fakeReadFile({ "/repo/policy.json": "[]" });
    await expect(loadBoundaryConfigFile("/repo/policy.json", { readFile })).rejects.toThrow(
      /is malformed:\n {2}config: expected a module object/,
    );
  });

  // Proves the two dialects share one validator rather than each carrying its
  // own copy: a pattern that will not compile is caught here with the exact
  // same message shape `config.test.mjs` pins for the .mjs dialect.
  it("reuses the shared matcher validator: an unbalanced bracket is rejected the same way", async () => {
    const readFile = fakeReadFile({
      "/repo/policy.json": JSON.stringify({
        ...wellFormedPolicy(),
        depConstraints: [{ sourceTag: "/(unclosed/" }],
      }),
    });
    await expect(loadBoundaryConfigFile("/repo/policy.json", { readFile })).rejects.toThrow(
      /depConstraints\[0\]\.sourceTag: '\/\(unclosed\/' is not a valid tag pattern/,
    );
  });

  it("rejects a missing required option, not a silently-defaulted one", async () => {
    const policy = wellFormedPolicy();
    delete policy.moduleBoundaryOptions.banTransitiveDependencies;
    const readFile = fakeReadFile({ "/repo/policy.json": JSON.stringify(policy) });
    await expect(loadBoundaryConfigFile("/repo/policy.json", { readFile })).rejects.toThrow(
      /moduleBoundaryOptions\.banTransitiveDependencies: missing/,
    );
  });

  // The red-direction case for coverage-reporting, not for this loader
  // directly: an empty table is well-formed — see `cli.integration.test.mjs`
  // for the proof that a run over it still states what it inspected, rather
  // than reading as "nothing to check".
  it("accepts an empty depConstraints table as well-formed, same as the .mjs dialect does", async () => {
    const readFile = fakeReadFile({
      "/repo/policy.json": JSON.stringify({ ...wellFormedPolicy(), depConstraints: [] }),
    });
    const config = await loadBoundaryConfigFile("/repo/policy.json", { readFile });
    expect(config.depConstraints).toEqual([]);
  });

  it("loads boundarySuppressions when present, with a mandatory reason enforced", async () => {
    const readFile = fakeReadFile({
      "/repo/policy.json": JSON.stringify({
        ...wellFormedPolicy(),
        boundarySuppressions: [
          { path: "libs/**/*.config.js", reason: "the loader cannot resolve it" },
        ],
      }),
    });
    const config = await loadBoundaryConfigFile("/repo/policy.json", { readFile });
    expect(config.suppressions).toEqual([
      { path: "libs/**/*.config.js", reason: "the loader cannot resolve it" },
    ]);
  });

  it("rejects a suppression entry with no reason, the same as the .mjs dialect does", async () => {
    const readFile = fakeReadFile({
      "/repo/policy.json": JSON.stringify({
        ...wellFormedPolicy(),
        boundarySuppressions: [{ path: "libs/**/*.config.js" }],
      }),
    });
    await expect(loadBoundaryConfigFile("/repo/policy.json", { readFile })).rejects.toThrow(
      /boundarySuppressions\[0\]\.reason: must be a non-empty string/,
    );
  });

  // Mutation guard: the `[]` default for an absent `boundarySuppressions`
  // must be a fresh array per call, never a module-scoped constant a later
  // caller could accidentally mutate and leak into an unrelated load.
  it("does not leak state between two independent loads", async () => {
    const readFile = fakeReadFile({
      "/repo/a.json": JSON.stringify(wellFormedPolicy()),
      "/repo/b.json": JSON.stringify(wellFormedPolicy()),
    });
    const a = await loadBoundaryConfigFile("/repo/a.json", { readFile });
    a.suppressions.push({ path: "x", reason: "mutated after the fact" });
    a.depConstraints.push({ sourceTag: "mutated", onlyDependOnLibsWithTags: ["mutated"] });
    const b = await loadBoundaryConfigFile("/repo/b.json", { readFile });
    expect(b.suppressions).toEqual([]);
    expect(b.depConstraints).toEqual(wellFormedPolicy().depConstraints);
  });
});

describe("loadBoundaryConfig threads the workspace root and an injected reader together", () => {
  it("builds the path from workspaceRoot + boundaryConfig and forwards io to the .json dialect", async () => {
    let requested;
    const readFile = async (path) => {
      requested = path;
      return JSON.stringify(wellFormedPolicy());
    };
    const config = await loadBoundaryConfig("/repo", "policy.json", { readFile });
    expect(requested).toBe("/repo/policy.json");
    expect(config.depConstraints).toEqual(wellFormedPolicy().depConstraints);
  });

  it("strips a trailing slash from the root before joining, same as the .mjs path always has", async () => {
    let requested;
    const readFile = async (path) => {
      requested = path;
      return JSON.stringify(wellFormedPolicy());
    };
    await loadBoundaryConfig("/repo/", "policy.json", { readFile });
    expect(requested).toBe("/repo/policy.json");
  });
});

describe("cross-dialect mutation guard — a .json load must not echo an .mjs sibling", () => {
  // Exists for M4a's sake, not this loader's: a differential that asserts two
  // dialects agree is only proof of anything if the two loaders can also
  // disagree when their files actually differ. Without this, M4a's
  // equivalence assertions could pass by comparing two objects that would
  // always compare equal for the wrong reason — one loader silently ignoring
  // the file it was handed and returning a fixed answer, say.
  const root = mkdtempSync(join(tmpdir(), "polyglot-config-mutation-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("returns objects that are NOT deep-equal when the .json sibling differs from the .mjs in one option", async () => {
    writeFileSync(
      join(root, "policy.mjs"),
      `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = ${JSON.stringify({
        ...wellFormedPolicy().moduleBoundaryOptions,
        enforceBuildableLibDependency: false,
      })};
`,
    );
    writeFileSync(
      join(root, "policy.json"),
      JSON.stringify({
        ...wellFormedPolicy(),
        moduleBoundaryOptions: {
          ...wellFormedPolicy().moduleBoundaryOptions,
          enforceBuildableLibDependency: true,
        },
      }),
    );

    const fromModule = await loadBoundaryConfigFile(join(root, "policy.mjs"));
    const fromJson = await loadBoundaryConfigFile(join(root, "policy.json"));

    expect(fromJson).not.toEqual(fromModule);
    expect(fromJson.options.enforceBuildableLibDependency).toBe(true);
    expect(fromModule.options.enforceBuildableLibDependency).toBe(false);
  });
});

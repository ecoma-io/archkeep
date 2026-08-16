import { describe, expect, it } from "vitest";

import { loadIntent, validateIntent } from "./intent.mjs";

const throwsWith = async (fn, needle) => {
  let caught = null;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected an error mentioning ${needle}`).not.toBeNull();
  expect(caught.message, `error should mention ${needle}`).toContain(needle);
  return caught;
};

describe("validateIntent", () => {
  it("accepts an empty intent — every section optional, nothing required", () => {
    expect(validateIntent({})).toEqual({
      requiredProjects: [],
      forbiddenProjects: [],
      allowedDependencies: [],
      forbiddenDependencies: [],
      forbiddenTags: [],
    });
  });

  it("normalises every section into the model computeDrift reads", () => {
    const parsed = validateIntent({
      projects: {
        required: [{ name: "app", tags: ["scope:app"] }, { name: "lib" }],
        forbidden: [{ name: "legacy" }],
      },
      dependencies: {
        allowed: [{ source: "app", target: "lib" }],
        forbidden: [{ source: "lib", target: "db" }],
      },
      tags: { forbid: [{ from: "layer:adapter", to: "layer:domain" }] },
    });
    expect(parsed.requiredProjects).toEqual([
      { name: "app", tags: ["scope:app"] },
      { name: "lib", tags: [] },
    ]);
    expect(parsed.forbiddenProjects).toEqual([{ name: "legacy" }]);
    expect(parsed.allowedDependencies).toEqual([{ source: "app", target: "lib" }]);
    expect(parsed.forbiddenDependencies).toEqual([{ source: "lib", target: "db" }]);
    expect(parsed.forbiddenTags).toEqual([{ from: "layer:adapter", to: "layer:domain" }]);
  });

  it("rejects an explicit empty allowlist — ambiguous between 'no allowlist' and 'nothing allowed'", () => {
    throwsWith(
      () => validateIntent({ dependencies: { allowed: [] } }),
      "may not be an explicit empty array",
    );
  });

  it("rejects a top-level unknown key, naming it", () => {
    throwsWith(() => validateIntent({ dependencs: {} }), 'unknown top-level key "dependencs"');
  });

  it("rejects an unknown key in projects, dependencies, and tags, naming the path", () => {
    throwsWith(() => validateIntent({ projects: { planned: [] } }), "unknown key in `projects`");
    throwsWith(
      () => validateIntent({ dependencies: { maybe: [] } }),
      "unknown key in `dependencies`",
    );
    throwsWith(() => validateIntent({ tags: { allow: [] } }), "unknown key in `tags`");
  });

  it("rejects a non-string project name", () => {
    throwsWith(
      () => validateIntent({ projects: { required: [{ name: "" }] } }),
      "non-empty string",
    );
    throwsWith(() => validateIntent({ projects: { required: [{ name: 5 }] } }), "non-empty string");
  });

  it("rejects a non-string dependency source or target", () => {
    throwsWith(
      () => validateIntent({ dependencies: { forbidden: [{ source: "a" }] } }),
      "non-empty string",
    );
  });

  it("rejects a tags.forbid row with from === to as a self-dependency no-op", () => {
    throwsWith(
      () => validateIntent({ tags: { forbid: [{ from: "layer:domain", to: "layer:domain" }] } }),
      "no-op",
    );
  });

  it("rejects a non-object default export", () => {
    throwsWith(() => validateIntent(null), "plain object");
    throwsWith(() => validateIntent([]), "plain object");
    throwsWith(() => validateIntent("intent"), "plain object");
  });
});

describe("loadIntent", () => {
  it("imports the module and returns its validated default export", async () => {
    const param = await loadIntent("/ws", "intent.config.mjs", {
      importModule: async () => ({ default: { projects: { required: [{ name: "app" }] } } }),
    });
    expect(param.requiredProjects).toEqual([{ name: "app", tags: [] }]);
  });

  it("refuses a module with no default export", async () => {
    throwsWith(
      () => loadIntent("/ws", "intent.config.mjs", { importModule: async () => ({}) }),
      "must default-export",
    );
  });

  it("wraps a load failure, naming the file", async () => {
    throwsWith(
      () =>
        loadIntent("/ws", "intent.config.mjs", {
          importModule: async () => {
            throw new Error("boom");
          },
        }),
      "could not load intent.config.mjs",
    );
  });

  it("surfaces a validation error from the loaded module", async () => {
    throwsWith(
      () =>
        loadIntent("/ws", "intent.config.mjs", {
          importModule: async () => ({ default: { dependencies: { allowed: [] } } }),
        }),
      "explicit empty array",
    );
  });
});

import { describe, expect, it } from "vitest";

import { isValidSelector, resolveMembers, selectProjects, splitSelector } from "./selectors.mjs";

const core = { name: "core", data: { root: "packages/core", tags: ["type-package"] } };
const ui = { name: "ui", data: { root: "packages/ui", tags: ["type-package"] } };
const web = { name: "web", data: { root: "apps/web", tags: ["type-extension"] } };
const NODES = { core, ui, web };

describe("splitSelector", () => {
  it("parses a labeled selector into label and value", () => {
    expect(splitSelector("tag:type-package")).toEqual({
      exclude: false,
      label: "tag",
      value: "type-package",
    });
  });

  it("parses an unlabeled selector as a bare project name", () => {
    expect(splitSelector("core")).toEqual({ exclude: false, label: null, value: "core" });
  });

  it("carries the '!' exclusion prefix separately from the body", () => {
    expect(splitSelector("!tag:x")).toEqual({ exclude: true, label: "tag", value: "x" });
    expect(splitSelector("!core")).toEqual({ exclude: true, label: null, value: "core" });
  });

  it("keeps '*' as a bare value with no label", () => {
    expect(splitSelector("*")).toEqual({ exclude: false, label: null, value: "*" });
  });
});

describe("isValidSelector", () => {
  it("accepts the four selector forms plus a bare project name", () => {
    for (const ok of ["name:core", "tag:type-package", "directory:packages/core", "*", "core"]) {
      expect(isValidSelector(ok), ok).toBe(true);
    }
  });

  it("accepts an exclusion-prefixed selector", () => {
    expect(isValidSelector("!tag:type-package")).toBe(true);
    expect(isValidSelector("!core")).toBe(true);
  });

  it("rejects an unknown selector label by name — the scop:core typo case", () => {
    expect(isValidSelector("scop:core")).toBe(false);
    expect(isValidSelector("tagz:type-package")).toBe(false);
  });

  it("rejects an empty value and a non-string", () => {
    expect(isValidSelector("tag:")).toBe(false);
    expect(isValidSelector("")).toBe(false);
    expect(isValidSelector(42)).toBe(false);
  });

  it("rejects empty after the '!' prefix", () => {
    expect(isValidSelector("!")).toBe(false);
  });
});

describe("selectProjects", () => {
  it("matches a project by exact name — the F1 case: no substring, no case folding", () => {
    // A `domain` selector must NOT match `platform-domain`. This is the whole
    // reason intent owns its own engine and not findMatchingProjects.
    const nodes = {
      domain: core,
      "platform-domain": ui,
    };
    expect(selectProjects("domain", nodes)).toEqual(["domain"]);
  });

  it("matches by tag exactly", () => {
    expect(selectProjects("tag:type-package", NODES)).toEqual(["core", "ui"]);
  });

  it("matches by directory root exactly", () => {
    expect(selectProjects("directory:packages/ui", NODES)).toEqual(["ui"]);
  });

  it("treats unlabeled and name: identically — exact name", () => {
    expect(selectProjects("core", NODES)).toEqual(["core"]);
    expect(selectProjects("name:core", NODES)).toEqual(["core"]);
  });

  it("is '*' for every node", () => {
    expect(selectProjects("*", NODES)).toEqual(["core", "ui", "web"]);
  });

  it("returns a fresh sorted array every call", () => {
    const a = selectProjects("*", NODES);
    const b = selectProjects("*", NODES);
    expect(a).not.toBe(b);
    expect(a).toEqual(["core", "ui", "web"]);
  });

  it("returns the empty list for a name that matches nothing — never a substring hit", () => {
    expect(selectProjects("plat", NODES)).toEqual([]);
  });

  it("ignores a tag a project does not carry", () => {
    expect(selectProjects("tag:scope-nx", NODES)).toEqual([]);
  });
});

describe("resolveMembers", () => {
  it("unions the positives of a boundary's match list, sorted", () => {
    expect(resolveMembers(["tag:type-package", "name:web"], NODES)).toEqual(["core", "ui", "web"]);
  });

  it("carves exclusions out of the union", () => {
    expect(resolveMembers(["*", "!name:web"], NODES)).toEqual(["core", "ui"]);
  });

  it("prepends an implicit '*' when the list opens with an exclusion", () => {
    expect(resolveMembers(["!tag:type-package"], NODES)).toEqual(["web"]);
  });

  it("is empty when selectors match nothing", () => {
    expect(resolveMembers(["name:missing"], NODES)).toEqual([]);
  });

  it("is deterministic across calls for the same inputs", () => {
    expect(resolveMembers(["*", "!tag:type-package"], NODES)).toEqual(
      resolveMembers(["*", "!tag:type-package"], NODES),
    );
  });
});

import { describe, expect, it } from "vitest";

import { documentSelector, ROUTED_EXTENSIONS } from "./languages.mjs";

describe("ROUTED_EXTENSIONS", () => {
  it("covers the seven extensions ESLint cannot read", () => {
    expect([...ROUTED_EXTENSIONS]).toStrictEqual([
      ".go",
      ".rs",
      ".py",
      ".vue",
      ".java",
      ".kt",
      ".kts",
    ]);
  });

  it("routes no TypeScript or JavaScript file", () => {
    // The near-miss for the list above. Adding `.ts` here would double every
    // violation in a workspace that also runs @nx/enforce-module-boundaries, and
    // a test that only pinned the four entries would not notice a fifth.
    for (const extension of [".ts", ".tsx", ".js", ".mjs", ".jsx"]) {
      expect(ROUTED_EXTENSIONS).not.toContain(extension);
    }
  });

  it("is frozen, because two copies of it exist and only one is authoritative", () => {
    expect(Object.isFrozen(ROUTED_EXTENSIONS)).toBe(true);
  });
});

describe("documentSelector", () => {
  it("matches by pattern rather than by language id", () => {
    // The silent-direction case: a selector of `{ language: "go" }` matches
    // nothing on a machine without the Go extension installed, and reports the
    // same empty diagnostic list a clean workspace does.
    for (const selector of documentSelector()) {
      expect(selector).not.toHaveProperty("language");
      expect(selector.pattern).toMatch(/^\*\*\/\*\./);
    }
  });

  it("produces one file-scheme selector per routed extension", () => {
    expect(documentSelector()).toStrictEqual([
      { scheme: "file", pattern: "**/*.go" },
      { scheme: "file", pattern: "**/*.rs" },
      { scheme: "file", pattern: "**/*.py" },
      { scheme: "file", pattern: "**/*.vue" },
      { scheme: "file", pattern: "**/*.java" },
      { scheme: "file", pattern: "**/*.kt" },
      { scheme: "file", pattern: "**/*.kts" },
    ]);
  });

  it("selects nothing when handed nothing, rather than defaulting to everything", () => {
    expect(documentSelector([])).toStrictEqual([]);
  });
});

import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import {
  emptyResult,
  fileFailure,
  perWorkspace,
  positionAt,
  projectOwning,
  trackedManifests,
} from "./source-util.mjs";

/** Where a line starts, counted independently of the function under test. */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

// Source text as a position reader meets it: line breaks in runs, at the
// start, at the end, and CRLF among LF.
const sourceText = fc
  .array(fc.constantFrom("a", "bb", "", "\n", "\r\n", "  x", "é"), { maxLength: 30 })
  .map((parts) => parts.join(""));

describe("positionAt", () => {
  it("counts from one, not from zero", () => {
    // The whole contract of this function is the convention: an editor
    // diagnostic and a `file:line:column` report are both 1-based, and the
    // conversion happens here once so no consumer has to remember it.
    expect(positionAt("import x", 0)).toEqual({ line: 1, column: 1 });
  });

  test.prop([sourceText, fc.nat()])(
    "reports a position that maps back to the offset it was given",
    (text, rawOffset) => {
      const offset = Math.min(rawOffset, text.length);
      const { line, column } = positionAt(text, offset);
      // The inverse, computed from the text rather than from the same code:
      // a wrong line count and a compensating wrong column cannot both
      // survive this, which a "line is right" assertion alone would allow.
      expect(lineStarts(text)[line - 1] + column - 1).toBe(offset);
    },
  );

  it("attributes a CRLF's carriage return to the line it ends, not the one it starts", () => {
    // The column of the first character after a CRLF must be 1. Counting the
    // `\r` into the following line shifts every column on every line of a
    // CRLF file by one — a whole-file off-by-one that never fails loudly.
    expect(positionAt("a\r\nb", 3)).toEqual({ line: 2, column: 1 });
  });

  it("clamps an out-of-range offset instead of reporting a negative column", () => {
    expect(positionAt("ab", 99)).toEqual({ line: 1, column: 3 });
    expect(positionAt("ab", -5)).toEqual({ line: 1, column: 1 });
  });
});

describe("projectOwning", () => {
  const projects = [
    { name: "outer", root: "area/libs" },
    { name: "inner", root: "area/libs/thing" },
    { name: "elsewhere", root: "other" },
  ];

  it("attributes a nested project's file to the nested project, not its parent", () => {
    // The failure this pins is total, not marginal: attribute the nested
    // project's files to its parent and every intra-project import reads as a
    // boundary crossing, while every real crossing out of it disappears.
    expect(projectOwning(projects, "area/libs/thing/src/a.ts").name).toBe("inner");
    expect(projectOwning(projects, "area/libs/other/src/a.ts").name).toBe("outer");
  });

  test.prop([fc.shuffledSubarray(projects, { minLength: 3 })])(
    "answers the same regardless of the order projects arrive in",
    (shuffled) => {
      expect(projectOwning(shuffled, "area/libs/thing/src/a.ts").name).toBe("inner");
    },
  );

  it("requires a path separator, so a sibling with a shared prefix is not a match", () => {
    expect(projectOwning(projects, "area/libs-extra/a.ts")).toBeNull();
  });

  it("matches the project root itself, and loses to any longer root", () => {
    expect(projectOwning(projects, "area/libs/thing").name).toBe("inner");
    expect(
      projectOwning([{ name: "root", root: "" }, ...projects], "area/libs/thing/a.ts").name,
    ).toBe("inner");
    expect(projectOwning([{ name: "root", root: "" }, ...projects], "README.md").name).toBe("root");
  });

  it("claims nothing for a path outside every project", () => {
    expect(projectOwning(projects, "package.json")).toBeNull();
  });
});

describe("perWorkspace", () => {
  it("builds once per workspace object so a whole-tree run does not re-read every manifest", () => {
    let builds = 0;
    const build = perWorkspace(() => ++builds);
    const workspace = { root: "/w" };
    expect(build(workspace)).toBe(1);
    expect(build(workspace)).toBe(1);
    expect(builds).toBe(1);
  });

  it("does not share an answer between two workspaces at the same root", () => {
    // Keyed on object identity, not on `root`: a test's in-memory tree and the
    // real one can carry the same root and completely different files, and one
    // answering for the other is a silently wrong analysis.
    let builds = 0;
    const build = perWorkspace(() => ++builds);
    expect(build({ root: "/w" })).toBe(1);
    expect(build({ root: "/w" })).toBe(2);
  });
});

describe("trackedManifests", () => {
  const workspace = {
    filesOf: () => [
      "Cargo.toml",
      "app/src-tauri/Cargo.toml",
      "app/vendor/Cargo.toml.bak",
      "app/my-Cargo.toml",
      "app/src/main.rs",
    ],
  };

  it("finds a manifest nested anywhere in the project, including at its root", () => {
    expect(trackedManifests(workspace, "app", "Cargo.toml")).toEqual([
      "Cargo.toml",
      "app/src-tauri/Cargo.toml",
    ]);
  });

  it("matches whole basenames, so a lookalike filename is not a manifest", () => {
    // `my-Cargo.toml` ends with the name but is a different file; a suffix
    // match would parse it as a crate manifest and invent a crate.
    expect(trackedManifests(workspace, "app", "Cargo.toml")).not.toContain("app/my-Cargo.toml");
  });
});

describe("envelope helpers", () => {
  it("gives every analyzer the same empty shape, with both arrays always present", () => {
    // A consumer iterating `result.failures` must never have to check for
    // undefined first — that is a promise of the contract, not a convenience.
    expect(emptyResult()).toEqual({ imports: [], failures: [] });
    expect(emptyResult().imports).not.toBe(emptyResult().imports);
  });

  it("marks a whole-file failure with explicit nulls rather than absent positions", () => {
    expect(fileFailure("a/b.go", "unreadable")).toEqual({
      sourceFile: "a/b.go",
      line: null,
      column: null,
      reason: "unreadable",
    });
  });
});

import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import {
  dedupeWholeFileFailures,
  emptyResult,
  fileFailure,
  lineStartsOf,
  ownershipRootComparisons,
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

describe("lineStartsOf", () => {
  it("holds the offset of every line, so a 1-based line number reads straight off it", () => {
    expect(lineStartsOf("a\nbb\n\nc")).toEqual([0, 2, 5, 6]);
    // Never empty: line 1 starts at 0, in an empty file as much as any other.
    expect(lineStartsOf("")).toEqual([0]);
  });

  test.prop([sourceText])("agrees with an index counted independently of it", (text) => {
    expect(lineStartsOf(text)).toEqual(lineStarts(text));
  });

  it("builds one index per text, however many positions are read off it", () => {
    // An operation count, not a stopwatch: the only observable difference
    // between an index built once per FILE and one rebuilt per CALL is
    // whether the same array comes back afterwards, and rebuilding per call
    // is exactly the quadratic this index replaced — a Go file with 8000
    // import sites cost 1668ms to position before it existed, against 10ms
    // now. A rebuild would leave a different array memoized here.
    const text = "use engine_core::task::Task;\n".repeat(4000);
    const index = lineStartsOf(text);
    for (let i = 0; i < 4000; i++) positionAt(text, i * 29 + 4);
    expect(lineStartsOf(text)).toBe(index);
  });
});

describe("positionAt costs a lookup, not a scan", () => {
  it("reads its answer off the index it is handed", () => {
    // This is what pins the MECHANISM rather than the result: hand it an
    // index claiming line 2 starts one character later than it does, and the
    // answer has to move with it. An implementation that rescanned the text
    // would return the same position for both, which is the quadratic coming
    // back with every existing assertion still green.
    const text = "ab\ncd";
    expect(positionAt(text, 3, [0, 3])).toEqual({ line: 2, column: 1 });
    expect(positionAt(text, 3, [0, 4])).toEqual({ line: 1, column: 4 });
  });

  it("builds the index once for a whole file's worth of lookups, however many there are", () => {
    // A count, not a clock. The measurement this memo exists for was a
    // stopwatch — a Go file with 8000 import sites cost 1668ms to position
    // before it existed, 10ms after — but a stopwatch is not what should hold
    // it: this suite runs on machines under arbitrary load, and a gate that
    // flakes gets ignored, which is the same outcome as not having one.
    //
    // What a rebuild would change is observable exactly: the memo holds one
    // array per text, so a `positionAt` that rescanned per call would leave a
    // DIFFERENT array behind each time round the loop.
    const text = "use engine_core::task::Task;\n".repeat(4000);
    let index = lineStartsOf(text);
    let rebuilds = 0;
    for (let i = 0; i < 4000; i++) {
      positionAt(text, i * 29 + 4);
      const current = lineStartsOf(text);
      if (current !== index) {
        rebuilds++;
        index = current;
      }
    }
    expect(rebuilds).toBe(0);
  });

  it("reads the memoized index when it is handed none, rather than the text", () => {
    // The half a rebuild count cannot see: a `positionAt` that rescanned the
    // text INSTEAD of consulting the memo would leave the memo untouched and
    // pass the count above while being exactly the quadratic it replaced.
    // The index is documented as shared and read-only, which is what makes
    // that observable — write a wrong line start into it and the answer has
    // to move with it, because there is nowhere else for the answer to come
    // from. A rescan would return the true position and turn this red.
    const text = "ab\ncd\nef";
    const doctored = lineStartsOf(text);
    expect(doctored).toEqual([0, 3, 6]);
    doctored[1] = 4;
    try {
      expect(positionAt(text, 3)).toEqual({ line: 1, column: 4 });
      expect(positionAt(text, 6)).toEqual({ line: 3, column: 1 });
    } finally {
      // The memo holds one entry, so asking about any other text drops the
      // doctored index rather than leaving it for whatever runs next.
      lineStartsOf("");
    }
  });
});

/**
 * The ownership answer as the linear scan stated it before the sorted-roots
 * walk replaced it (cf. #369) — kept here as the executable spec the walk is
 * held to, property-wise, below. This copy is the TEST's reference, not a
 * second implementation the engine runs: the engine's answer is the one under
 * test, and this one is frozen to the semantics the scan shipped.
 *
 * @param {{ name: string, root: string }[]} projects
 * @param {string} path
 * @returns {{ name: string, root: string }|null}
 */
function linearScan(projects, path) {
  let owner = null;
  for (const project of projects) {
    const root = project.root ?? "";
    if (root !== "" && path !== root && !path.startsWith(`${root}/`)) continue;
    if (owner === null || root.length > owner.root.length) owner = project;
  }
  return owner;
}

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

  it("requires a separator before a same-prefix sibling: libs/aux owns nothing of libs/auxiliary", () => {
    const projects = [
      { name: "aux", root: "libs/aux" },
      { name: "auxiliary", root: "libs/auxiliary" },
    ];
    expect(projectOwning(projects, "libs/auxiliary/src/a.ts").name).toBe("auxiliary");
    expect(projectOwning(projects, "libs/aux/src/a.ts").name).toBe("aux");
  });

  it("answers by the longest root at mixed depths, in whatever order the graph delivered them", () => {
    const projects = [
      { name: "web", root: "apps/web" },
      { name: "routes", root: "apps/web/src/routes" },
      { name: "libs", root: "libs" },
      { name: "deep", root: "libs/team-a/feature/src/pkg" },
    ];
    expect(projectOwning(projects, "apps/web/src/routes/ui/a.ts").name).toBe("routes");
    expect(projectOwning(projects, "apps/web/src/app.ts").name).toBe("web");
    expect(projectOwning(projects, "libs/team-a/feature/src/pkg/lib.rs").name).toBe("deep");
    expect(projectOwning(projects, "libs/other/go.mod").name).toBe("libs");
  });

  it("keeps the first of two projects that spell the same root", () => {
    const first = { name: "first", root: "libs/shared" };
    const second = { name: "second", root: "libs/shared" };
    expect(projectOwning([first, second], "libs/shared/a.ts")).toBe(first);
    expect(projectOwning([second, first], "libs/shared/a.ts")).toBe(second);
  });

  it("takes a root as the opaque string its provider normalized: './apps/web' and '.' own nothing spelled another way", () => {
    // Providers normalize root spellings at their own boundaries (Nx's '.' in
    // `../../workspace.mjs`, Moon's './x' in `../../providers/moon.mjs`); the
    // predicate itself matches strings, and this pins that it does — a root
    // the providers have not normalized is unmatched here, exactly as the
    // linear scan left it.
    const projects = [
      { name: "moonish", root: "./apps/web" },
      { name: "nxish", root: "." },
    ];
    expect(projectOwning(projects, "apps/web/src/main.ts")).toBeNull();
    expect(projectOwning(projects, "./apps/web/src/main.ts").name).toBe("moonish");
    expect(projectOwning(projects, "./README.md").name).toBe("nxish");
    expect(projectOwning(projects, "README.md")).toBeNull();
  });

  it("looks an owner up in comparisons that scale with the path's depth and log(projects), not projects", () => {
    // The linear scan this replaced tested every project's root per lookup.
    // The sorted-roots walk holds, per ancestor candidate of the path, one
    // lower bound of at most ceil(log2(n + 1)) binary-search steps plus one
    // equality probe — for 1,024 projects and a file at depth 8 that is under
    // 9 × 14 = 126, where the scan paid 1,024. The count is deterministic
    // (same input, same count — no clock involved; cf. #359), so a walk that
    // regressed toward scanning would blow the bound loudly, not flakily.
    const projects = Array.from({ length: 1024 }, (_, i) => ({
      name: `pkg-${i}`,
      root: `libs/team-${Math.floor(i / 8)}/area-${i % 8}/pkg-${i}`,
    }));
    const before = ownershipRootComparisons();
    const owner = projectOwning(projects, "libs/team-5/area-2/pkg-42/src/deep/mod/file.go");
    const used = ownershipRootComparisons() - before;
    expect(owner.name).toBe("pkg-42");
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThan(9 * 14);
  });

  test.prop([
    fc.array(
      fc
        .array(fc.constantFrom("apps", "libs", "a", "b", "aux", "auxiliary"), { maxLength: 3 })
        .map((segments) => segments.join("/")),
      { maxLength: 8 },
    ),
    fc
      .array(fc.constantFrom("apps", "libs", "a", "b", "aux", "auxiliary"), {
        minLength: 1,
        maxLength: 5,
      })
      .map((segments) => segments.join("/")),
  ])("answers exactly what the linear scan answered, over generated workspaces", (roots, path) => {
    const projects = roots.map((root, i) => ({ name: `p${i}`, root }));
    expect(projectOwning(projects, path)?.name).toBe(linearScan(projects, path)?.name);
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

  it("keeps one whole-file failure per file when the funnel hears it twice", () => {
    // An unreadable JVM source reaches the funnel through the analyzer's own
    // read failure AND the package index's row for the same file. Two rows
    // would tell a consumer "2 files" when one failed — one fact, one row.
    const merged = [
      fileFailure("libs/x/A.kt", "Kotlin analysis failed: EACCES"),
      { sourceFile: "libs/x/A.kt", line: 3, column: 8, reason: "a positioned blind spot" },
      fileFailure("libs/x/A.kt", "JVM source could not be read for the package index"),
      fileFailure("libs/y/B.go", "Go analysis failed: EACCES"),
    ];
    expect(dedupeWholeFileFailures(merged)).toEqual([
      fileFailure("libs/x/A.kt", "Kotlin analysis failed: EACCES"),
      { sourceFile: "libs/x/A.kt", line: 3, column: 8, reason: "a positioned blind spot" },
      fileFailure("libs/y/B.go", "Go analysis failed: EACCES"),
    ]);
  });

  it("keeps positioned failures whole — several blind spots in one file are distinct facts", () => {
    const sites = [
      { sourceFile: "libs/x/A.cs", line: 2, column: 1, reason: "first" },
      { sourceFile: "libs/x/A.cs", line: 5, column: 1, reason: "second" },
    ];
    expect(dedupeWholeFileFailures(sites)).toEqual(sites);
  });
});

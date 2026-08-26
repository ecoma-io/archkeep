import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import { posix } from "node:path";

import {
  basenameMatches,
  normalizePath,
  parseManifest,
  resolveWithinWorkspace,
} from "./manifest-util.mjs";

const segment = fc
  .array(fc.constantFrom(..."abcdefgh"), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(""));
// Path pieces including the ones a hand-written manifest actually carries:
// `..`, `.`, and the empty segment a doubled or trailing slash leaves behind.
const pathPiece = fc.oneof(segment, fc.constantFrom("..", ".", ""));
const pathText = fc.array(pathPiece, { maxLength: 8 }).map((pieces) => pieces.join("/"));
const value = fc
  .array(fc.constantFrom(..."abcdefgh -_/."), { maxLength: 12 })
  .map((chars) => chars.join(""));

describe("parseManifest", () => {
  it("parses TOML and returns null on malformed input", () => {
    expect(parseManifest('[package]\nname = "x"').package.name).toBe("x");
    expect(parseManifest("[package\nbroken")).toBeNull();
  });

  it("tolerates a leading UTF-8 BOM, which smol-toml alone rejects", () => {
    // Measured against smol-toml directly: a BOM aborts the parse outright,
    // so a manifest an editor wrote a BOM into came back null here and
    // everything read from it vanished — a Cargo crate dropping out of the
    // crate map, a pyproject layout going unmodelled. Manifests contribute
    // no position to any record (`./contract.md`), so removing the one
    // character shifts nothing.
    expect(parseManifest('\uFEFF[package]\nname = "x"').package.name).toBe("x");
    expect(parseManifest("\uFEFFbroken [")).toBeNull();
  });

  // This runs over every tracked Cargo.toml and pyproject.toml in the
  // workspace, including the half-written one on somebody's branch. A throw
  // here does not fail one project — it fails project-graph computation, so
  // every Nx command in the repository stops working until that file is fixed.
  test.prop([
    fc.oneof(
      fc.string(),
      fc.string({ unit: fc.constantFrom("[", "]", "=", '"', "'", "\n", "#", "\\", ".", "a", "1") }),
    ),
  ])("answers null instead of throwing, whatever the file holds", (text) => {
    const parsed = parseManifest(text);
    expect(parsed === null || typeof parsed === "object").toBe(true);
  });

  test.prop([fc.uniqueArray(fc.tuple(segment, value), { selector: ([key]) => key, maxLength: 5 })])(
    "reads back every key a well-formed manifest declares",
    (entries) => {
      const text = entries.map(([key, declared]) => `${key} = "${declared}"`).join("\n");
      expect(parseManifest(text)).toEqual(Object.fromEntries(entries));
    },
  );
});

describe("normalizePath", () => {
  it("normalizes ../ and ./ segments against a base directory", () => {
    expect(normalizePath("acme/libs/alpha", "../beta")).toBe("acme/libs/beta");
    expect(normalizePath("acme/libs/alpha", "./sub")).toBe("acme/libs/alpha/sub");
  });

  // The result is compared against project roots by string equality, so any
  // `.`, `..` or empty segment left in it resolves to no project and drops the
  // edge — a missing edge means `nx affected` skips a dependent, the one
  // failure this plugin exists to prevent, and it fails nothing visibly.
  test.prop([pathText, pathText])(
    "leaves no '.', '..' or empty segment in the path it returns",
    (baseDir, relative) => {
      const normalized = normalizePath(baseDir, relative);
      const segments = normalized === "" ? [] : normalized.split("/");
      for (const part of segments) expect([".", "..", ""]).not.toContain(part);
    },
  );

  test.prop([pathText, pathText])(
    "is idempotent: normalizing an already-normalized path changes nothing",
    (baseDir, relative) => {
      const once = normalizePath(baseDir, relative);
      expect(normalizePath(".", once)).toBe(once);
    },
  );

  // The shape every Cargo `{ path = "../other" }` dependency takes, over
  // arbitrary names rather than the two the example above happens to use.
  test.prop([segment, segment, segment])(
    "resolves a sibling of the directory the manifest declaring it sits in",
    (subsystem, declaring, sibling) => {
      expect(normalizePath(`${subsystem}/${declaring}`, `../${sibling}`)).toBe(
        `${subsystem}/${sibling}`,
      );
    },
  );
});

describe("resolveWithinWorkspace", () => {
  it("resolves like normalizePath while the path stays inside the tree", () => {
    expect(resolveWithinWorkspace("acme/libs/alpha", "../beta")).toBe("acme/libs/beta");
    expect(resolveWithinWorkspace("acme/libs/alpha", "./vendor//pkg/")).toBe(
      "acme/libs/alpha/vendor/pkg",
    );
  });

  // The distinction this function exists for: normalizePath answers
  // `elsewhere` here — an in-tree spelling of a directory that is NOT in the
  // tree — and a caller comparing that against project roots would reason
  // about the wrong directory. Escape has to be a distinct answer.
  it("answers null the moment the path climbs above the workspace root", () => {
    expect(resolveWithinWorkspace("acme/libs/alpha", "../../../../elsewhere")).toBeNull();
    expect(resolveWithinWorkspace("", "..")).toBeNull();
    // Escaping and coming back is still an escape: the segments walked through
    // are outside the tree, so nothing is known about where it landed.
    expect(resolveWithinWorkspace("acme", "../../acme")).toBeNull();
  });

  test.prop([pathText, pathText])(
    "either escapes to null or returns a path with no '.', '..' or empty segment",
    (baseDir, relative) => {
      const resolved = resolveWithinWorkspace(baseDir, relative);
      if (resolved === null) return;
      expect(resolved).toBe(normalizePath(baseDir, relative));
      const segments = resolved === "" ? [] : resolved.split("/");
      for (const part of segments) expect([".", "..", ""]).not.toContain(part);
    },
  );
});

describe("basenameMatches", () => {
  const patterns = ["go.mod", "Cargo.toml", "pyproject.toml", "pom.xml", "*.csproj"];
  // A stand-in with the one behavior that matters: it must never be called
  // for a metacharacter-free pattern — that is the fast path under test.
  const calls = [];
  const matchesGlob = (value, pattern) => {
    calls.push(pattern);
    return value.endsWith(".csproj") && pattern === "*.csproj";
  };

  it("answers literal patterns by equality without compiling them", () => {
    calls.length = 0;
    expect(basenameMatches("Cargo.toml", patterns, matchesGlob)).toBe(true);
    // A hit by equality stops the scan before any glob is consulted.
    expect(calls).toEqual([]);
  });

  it("hands only glob patterns to the injected matcher", () => {
    calls.length = 0;
    expect(basenameMatches("My.App.csproj", patterns, matchesGlob)).toBe(true);
    expect(calls).toEqual(["*.csproj"]);
    calls.length = 0;
    expect(basenameMatches("My.App.fsproj", patterns, matchesGlob)).toBe(false);
    expect(calls).toEqual(["*.csproj"]);
  });

  it("keeps glob semantics for a pattern the fast path could answer literally", () => {
    // A file literally named `foo[1]` and a pattern `foo[1]`: the pattern is
    // a character class, so the glob answer is false and the fast path must
    // not pre-empt it with string equality. The real matcher, because the
    // stand-in above does not implement classes.
    expect(basenameMatches("foo[1]", ["foo[1]"], posix.matchesGlob)).toBe(false);
    expect(basenameMatches("foo1", ["foo[1]"], posix.matchesGlob)).toBe(true);
  });
});

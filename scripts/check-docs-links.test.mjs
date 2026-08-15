// Tests for check-docs-links.mjs.
//
// `parseMarkdownLinks`, `parseDocCitations`, `githubSlug`, `headingAnchors`,
// and `evaluate` take every fact they need as an argument, so these run with
// no repository and no filesystem — the logic already sits at the isolation
// boundary. What is deliberately NOT tested is `readFacts`: it exists to ask
// `git ls-files` a question, and a test that stubbed the answer would only pin
// the stub. The real thing runs in CI against the real tracked tree.
//
// Every failure case below goes red in the SILENT direction first: a broken
// reference is a file that clicked through lands on nothing, and the gate's
// job is to make that read as a failure instead of a clean run. The case that
// removes the check entirely is `evaluate` with no files, which must fail
// loudly rather than report a clean scan of nothing.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluate,
  githubSlug,
  headingAnchors,
  parseDocCitations,
  parseMarkdownLinks,
  withDirectories,
} from "./check-docs-links.mjs";

test("parseMarkdownLinks keeps local paths with their line numbers", () => {
  const text = `# Title

See [policy](usage/configuration.md) and
[another](../reference/policy-schema.md#inline-policy) on line 4.`;
  assert.deepEqual(parseMarkdownLinks(text), [
    { target: "usage/configuration.md", line: 3 },
    { target: "../reference/policy-schema.md#inline-policy", line: 4 },
  ]);
});

test("parseMarkdownLinks keeps #anchors (heading checks) but drops external targets", () => {
  const text = `[web](https://example.com) [anchor](#same-file) [mail](mailto:x@y.z)
[dots](./local.md) [proto](javascript:void(0))`;
  assert.deepEqual(parseMarkdownLinks(text), [
    { target: "#same-file", line: 1 },
    { target: "./local.md", line: 2 },
  ]);
});

test("parseDocCitations finds docs/ citations, root-relative and carrying-file relative", () => {
  const text = "see `docs/usage/ci.md` here and `../../docs/reference/cli.md` there";
  assert.deepEqual(parseDocCitations(text), [
    { target: "docs/usage/ci.md", line: 1 },
    { target: "../../docs/reference/cli.md", line: 1 },
  ]);
});

test("parseDocCitations does not double-judge a markdown link target as a citation", () => {
  // `usage/configuration.md` is not a `docs/…` citation, and the `docs/…`
  // target it DOES carry is a link, already judged by the link parser with
  // the link's own resolution rule — the citation pass removes link syntax
  // so the same target is not judged twice by different rules.
  const text = "[policy](docs/usage/configuration.md)";
  assert.deepEqual(parseDocCitations(text), []);
});

test("githubSlug normalizes like GitHub's heading anchors", () => {
  assert.equal(githubSlug("boundaryConfig"), "boundaryconfig");
  assert.equal(
    githubSlug("nx affected still misses a dependency"),
    "nx-affected-still-misses-a-dependency",
  );
  assert.equal(githubSlug('Exit 3 — "no verdict"'), "exit-3-no-verdict");
  assert.equal(githubSlug("PLAIN"), "plain");
});

test("headingAnchors covers every heading and GitHub's duplicate suffix", () => {
  const text = `# One

## Two, repeated

## Two, repeated

### Three`;
  assert.deepEqual(
    [...headingAnchors(text)].sort(),
    ["one", "three", "two-repeated", "two-repeated-1"].sort(),
  );
});

test("withDirectories adds every parent directory of a path", () => {
  const paths = ["/repo/docs/usage/checking.md"];
  assert.ok(withDirectories(paths).has("/repo/docs/usage/checking.md"));
  assert.ok(withDirectories(paths).has("/repo/docs/usage"));
  assert.ok(withDirectories(paths).has("/repo/docs"));
  assert.ok(withDirectories(paths).has("/repo"));
});

function file(path, { links = [], citations = [], headings = new Set() } = {}) {
  return { path, links, citations, headings };
}

/** The absolute path a repo-relative `path` resolves to under `/repo`. */
function abs(path) {
  return `/repo/${path}`;
}

test("evaluate fails loudly on NO files, instead of reporting a clean scan", () => {
  const { failures } = evaluate({ files: [], existingPaths: new Set(), root: "/repo" });
  assert.ok(failures.length > 0);
  assert.match(failures[0], /no files were scanned/);
});

test("evaluate passes a link whose target file exists", () => {
  const { failures } = evaluate({
    files: [file("docs/a.md", { links: [{ target: "b.md", line: 1 }] })],
    existingPaths: new Set([abs("docs/b.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate FAILS a link whose target file does not exist — the silent direction", () => {
  const { failures } = evaluate({
    files: [file("docs/a.md", { links: [{ target: "gone.md", line: 4 }] })],
    existingPaths: new Set(),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /docs\/a\.md:4/);
  assert.match(failures[0], /gone\.md/);
});

test("evaluate resolves a link from the file that carries it, not the workspace root", () => {
  // `docs/usage/a.md` linking to `b.md` is `docs/usage/b.md` — existing —
  // not `docs/b.md` — missing. A root-relative read would fail this clean
  // tree, which is a violation that is not real.
  const { failures } = evaluate({
    files: [file("docs/usage/a.md", { links: [{ target: "b.md", line: 1 }] })],
    existingPaths: new Set([abs("docs/usage/b.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate FAILS a same-file anchor that names no heading", () => {
  const { failures } = evaluate({
    files: [
      file("docs/c.md", {
        links: [{ target: "#missing-heading", line: 2 }],
        headings: new Set(["present"]),
      }),
    ],
    existingPaths: new Set([abs("docs/c.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no heading/);
});

test("evaluate passes a same-file anchor that matches a heading", () => {
  const { failures } = evaluate({
    files: [
      file("docs/d.md", {
        links: [{ target: "#present", line: 2 }],
        headings: new Set(["present"]),
      }),
    ],
    existingPaths: new Set([abs("docs/d.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate FAILS a same-file anchor even when the file exists — the heading is gone", () => {
  const { failures } = evaluate({
    files: [
      file("docs/d.md", {
        links: [{ target: "#removed", line: 2 }],
        headings: new Set(["present"]),
      }),
    ],
    existingPaths: new Set([abs("docs/d.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /#removed/);
});

test("evaluate checks only the file half of a file.md#fragment link", () => {
  // The fragment promises a heading in ANOTHER file, which GitHub's own
  // anchor handling does not guarantee — so only the file half is checked.
  const { failures } = evaluate({
    files: [file("docs/e.md", { links: [{ target: "other.md#any-fragment", line: 1 }] })],
    existingPaths: new Set([abs("docs/other.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate FAILS a root-relative docs/ citation that does not exist", () => {
  const { failures } = evaluate({
    files: [
      file("packages/lattice/src/x.mjs", { citations: [{ target: "docs/gone.md", line: 3 }] }),
    ],
    existingPaths: new Set(),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /packages\/lattice\/src\/x\.mjs:3/);
});

test("evaluate resolves a ../ citation from its carrying file", () => {
  // `../../../docs/…` from `packages/lattice/src/x.mjs` climbs three levels
  // to the workspace root and lands on `docs/…` — the same path rule that
  // resolves the file, applied to the citation. A shorter climb would be
  // judged against `packages/docs/…` and fail: the file's own directory is
  // the base, not the workspace root.
  const { failures } = evaluate({
    files: [
      file("packages/lattice/src/x.mjs", {
        citations: [{ target: "../../../docs/usage/ci.md", line: 1 }],
      }),
    ],
    existingPaths: new Set([abs("docs/usage/ci.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate FAILS a ../ citation whose relative target does not exist", () => {
  const { failures } = evaluate({
    files: [
      file("packages/lattice/src/x.mjs", {
        citations: [{ target: "../../../docs/nope.md", line: 5 }],
      }),
    ],
    existingPaths: new Set(),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /nope\.md/);
});

test("evaluate passes a link to a directory — GitHub renders it as a listing", () => {
  const { failures } = evaluate({
    files: [file("docs/getting-started/x.md", { links: [{ target: "../usage/", line: 4 }] })],
    existingPaths: withDirectories([abs("docs/usage/checking.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate reports every broken reference, not just the first", () => {
  const { failures } = evaluate({
    files: [
      file("docs/a.md", {
        links: [
          { target: "one.md", line: 1 },
          { target: "two.md", line: 2 },
        ],
      }),
    ],
    existingPaths: new Set(),
    root: "/repo",
  });
  assert.equal(failures.length, 2);
});

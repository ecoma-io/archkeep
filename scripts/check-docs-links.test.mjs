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

test("parseDocCitations finds a top-level docs/ citation — not just a two-segment one", () => {
  // The old regex required exactly `docs/<segment>/<segment>.md`, so a
  // top-level file (`docs/README.md` — a real citation in this repository)
  // never matched and could be deleted or moved without the gate noticing.
  const text = "see docs/why.md";
  assert.deepEqual(parseDocCitations(text), [{ target: "docs/why.md", line: 1 }]);
});

test("parseDocCitations finds an uppercase-named and a three-deep docs/ citation", () => {
  const text = "cited in docs/README.md and also docs/usage/native/checking.md";
  assert.deepEqual(parseDocCitations(text), [
    { target: "docs/README.md", line: 1 },
    { target: "docs/usage/native/checking.md", line: 1 },
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

test("parseDocCitations drops a docs/adr/NNN-slug.md placeholder citation, backticked or not", () => {
  // The real production text (adr.mjs, arch-change/SKILL.md) writes this
  // inline-backtick-wrapped, describing the ADR filename PATTERN rather than
  // one real file — `NNN` is a placeholder for a real number, never a real
  // path component. Dropped whether or not it is backtick-wrapped, so a
  // maintainer copying it into plain prose does not accidentally make it
  // start failing.
  const backticked = "open `docs/adr/NNN-slug.md` and read the prose";
  const plain = "open docs/adr/NNN-slug.md and read the prose";
  assert.deepEqual(parseDocCitations(backticked), []);
  assert.deepEqual(parseDocCitations(plain), []);
});

test("parseDocCitations still finds a REAL backtick-wrapped citation — the placeholder rule does not narrow this", () => {
  // This repository's own convention for a live citation IS inline,
  // backtick-wrapped prose (see packages/lattice/src/rules/match.mjs,
  // src/report/json.mjs, and others) — the ADR-placeholder exclusion above
  // is deliberately narrow (matched on the literal "NNN" token) so it does
  // not also silence citations like this one, which name one real file.
  const text = "per `docs/reference/policy-schema.md`, the field is optional";
  assert.deepEqual(parseDocCitations(text), [
    { target: "docs/reference/policy-schema.md", line: 1 },
  ]);
});

test("parseDocCitations skips a docs/…md mention inside a fenced code block", () => {
  const text = ["See below:", "```", "docs/example-config.md", "```"].join("\n");
  assert.deepEqual(parseDocCitations(text), []);
});

test("parseDocCitations, for a non-markdown file, only extracts citations from COMMENTS", () => {
  // `write("docs/readme.md", …)` and `path: "docs/x.md"` are JS string
  // literals in test-fixture code, not citations of this repository's docs —
  // AGENTS.md's citation rule is about comments. A real citation just above,
  // in a `//` comment, is still found.
  const text = [
    "// see docs/reference/cli.md for the format",
    'write("docs/readme.md", "# docs\\n");',
    'const fixture = { path: "docs/x.md" };',
  ].join("\n");
  assert.deepEqual(parseDocCitations(text, { isMarkdown: false }), [
    { target: "docs/reference/cli.md", line: 1 },
  ]);
});

test("parseDocCitations, for a non-markdown file, finds a citation in a block/JSDoc comment", () => {
  const text = ["/**", " * per docs/reference/policy-schema.md", " */", "export const x = 1;"].join(
    "\n",
  );
  assert.deepEqual(parseDocCitations(text, { isMarkdown: false }), [
    { target: "docs/reference/policy-schema.md", line: 2 },
  ]);
});

test("githubSlug normalizes like GitHub's heading anchors", () => {
  assert.equal(githubSlug("boundaryConfig"), "boundaryconfig");
  assert.equal(
    githubSlug("nx affected still misses a dependency"),
    "nx-affected-still-misses-a-dependency",
  );
  // Punctuation is stripped, but EACH space that bordered it survives and
  // becomes its own hyphen — a collapsing slugger merges the two spaces
  // either side of the removed em-dash into one hyphen and gets
  // "exit-3-no-verdict", which is not the anchor GitHub actually renders for
  // this heading. Corrected from that value: the old assertion pinned the
  // collapsed (wrong) slug, which is the bug this case exists to catch.
  assert.equal(githubSlug('Exit 3 — "no verdict"'), "exit-3--no-verdict");
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

test("headingAnchors ignores a '#' line inside a fenced code block", () => {
  // A `# install deps` line inside a bash fence is source text a reader
  // sees, not a heading GitHub renders — a scan blind to fences mints a
  // phantom anchor for it, so a link to `#install-deps` would pass here
  // while it is broken on GitHub, which never rendered that heading at all.
  const text = `# Setup

\`\`\`bash
# install deps
pnpm install
\`\`\`

## Real heading`;
  assert.deepEqual([...headingAnchors(text)].sort(), ["real-heading", "setup"].sort());
});

test("headingAnchors only closes a fence with the same character", () => {
  // CommonMark: a \`\`\` fence is not closed by a ~~~ line, so a heading-shaped
  // line between them (misread as "still inside a fence" or "back outside
  // one" by a naive matcher) must be handled by the same rule either way —
  // here neither line inside is a real heading, and the real one after both
  // fences close still counts.
  const text = `\`\`\`
~~~
# not a heading
~~~
\`\`\`

## After`;
  assert.deepEqual([...headingAnchors(text)], ["after"]);
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

test("evaluate FAILS a link to an anchor that only exists inside a fenced code block", () => {
  // `headings` here is what `headingAnchors` would actually return for a doc
  // whose only `# install deps` is inside a bash fence — i.e. it does NOT
  // include "install-deps", because that heading is source text, not a real
  // one. A link to it must fail instead of passing on a phantom anchor.
  const { failures } = evaluate({
    files: [
      file("docs/f.md", {
        links: [{ target: "#install-deps", line: 6 }],
        headings: new Set(),
      }),
    ],
    existingPaths: new Set([abs("docs/f.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /#install-deps/);
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

test("evaluate FAILS a top-level docs/ citation that does not exist — the silent direction", () => {
  // `docs/why.md` has one segment after `docs/`, not two — the shape the old
  // citation regex silently ignored. A citation of it must still be checked.
  const { failures } = evaluate({
    files: [
      file("packages/lattice/src/x.mjs", { citations: [{ target: "docs/why.md", line: 7 }] }),
    ],
    existingPaths: new Set(),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /docs\/why\.md/);
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

test("evaluate FAILS a docs/ page linking OUTSIDE docs/ — the one-way door", () => {
  // A docs page linking to `../CONTRIBUTING.md` is a failure even though the
  // target exists: documentation is a self-contained tree, and a page inside
  // docs/ may only point at another page inside docs/.
  const { failures } = evaluate({
    files: [file("docs/README.md", { links: [{ target: "../CONTRIBUTING.md", line: 5 }] })],
    existingPaths: withDirectories([abs("CONTRIBUTING.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /OUTSIDE docs\//);
  assert.match(failures[0], /docs\/README\.md:5/);
});

test("evaluate allows a NON-docs markdown file to link INTO docs/", () => {
  // The direction a reader is steered toward: the root README points into
  // docs/, and that stays legal — only the reverse is refused.
  const { failures } = evaluate({
    files: [file("README.md", { links: [{ target: "docs/why.md", line: 2 }] })],
    existingPaths: withDirectories([abs("docs/why.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate FAILS a docs/ page linking outside docs/ even when the target exists", () => {
  // The existence check and the containment check are independent: a link to
  // a real file outside docs/ is still a containment failure.
  const { failures } = evaluate({
    files: [
      file("docs/usage/ci.md", {
        links: [{ target: "../../packages/lattice/README.md", line: 9 }],
      }),
    ],
    existingPaths: withDirectories([abs("packages/lattice/README.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /OUTSIDE docs\//);
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

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
// loudly rather than report a clean scan of nothing. The link-shape refusals
// (`parseMarkdownLinks`'s second return value) are held to the same bar from
// both ends: a parser test fails if a refused shape ever comes back empty,
// and an `evaluate` test fails if a refusal ever stops becoming a failure.

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
  assert.deepEqual(parseMarkdownLinks(text).links, [
    { target: "usage/configuration.md", line: 3 },
    { target: "../reference/policy-schema.md#inline-policy", line: 4 },
  ]);
});

test("parseMarkdownLinks keeps #anchors (heading checks) but drops external targets", () => {
  const text = `[web](https://example.com) [anchor](#same-file) [mail](mailto:x@y.z)
[dots](./local.md) [proto](javascript:void(0))`;
  assert.deepEqual(parseMarkdownLinks(text).links, [
    { target: "#same-file", line: 1 },
    { target: "./local.md", line: 2 },
  ]);
});

test("parseMarkdownLinks refuses a destination containing spaces — the silent direction", () => {
  // The issue's repro: `[docs](some file.md)` naming a file that does not
  // exist used to exit 0 — the old regex never matched a spaced destination,
  // so the broken reference escaped every check while the gate reported no
  // broken doc references. Now the shape is a named refusal; empty `refusals`
  // here would be this test going red in exactly that silent direction.
  const { links, refusals } = parseMarkdownLinks("see [docs](some file.md) here");
  assert.deepEqual(links, []);
  assert.deepEqual(refusals, [
    { line: 1, shape: "space-destination", snippet: "[docs](some file.md)" },
  ]);
});

test("parseMarkdownLinks unwraps an angle-bracketed destination — spaces and all", () => {
  // CommonMark's spelling for a destination that must contain whitespace.
  // The old regex matched `<user guide.md>` brackets-and-all as a bare target,
  // so an EXISTING spaced file failed loudly and a missing one failed for the
  // wrong name; both now resolve against the real spelling.
  const { links, refusals } = parseMarkdownLinks("[guide](<user guide.md>)");
  assert.deepEqual(links, [{ target: "user guide.md", line: 1 }]);
  assert.deepEqual(refusals, []);
});

test("parseMarkdownLinks refuses brackets separated from their parentheses, same line or next", () => {
  // A link split across lines (`]` then newline then `(`) never matched the
  // old single-line regex at all; the same-line gap whose parenthesised text
  // names a file is its sibling. Both render as literal text on GitHub, so
  // there is nothing to resolve — the refusal names the span instead of
  // letting it pass for clean.
  const sameLine = parseMarkdownLinks("read [docs] (gone.md) first");
  assert.deepEqual(sameLine.links, []);
  assert.equal(sameLine.refusals.length, 1);
  assert.equal(sameLine.refusals[0].shape, "separated-parens");
  const nextLine = parseMarkdownLinks("read [docs]\n(gone.md) first");
  assert.deepEqual(nextLine.links, []);
  assert.equal(nextLine.refusals.length, 1);
  assert.equal(nextLine.refusals[0].shape, "separated-parens");
  // The line is the OPENING BRACKET's — where the construct a reader sees
  // starts — the same anchor every parsed link reports.
  assert.equal(nextLine.refusals[0].line, 1);
  // The snippet collapses the line break, so a split attempt reads on one
  // line in the failure message.
  assert.equal(nextLine.refusals[0].snippet, "[docs] (gone.md)");
});

test("same-line bracket-plus-parenthetical PROSE is neither a link nor a refusal", () => {
  // Ordinary English does this constantly: a bracketed cross-reference
  // followed by an aside in parentheses. Neither half renders as a link, so
  // there is no reference to judge — both sentences must come back empty,
  // and version strings like "(v1.2)" stay prose too (the dot-extension
  // signal requires a letter after the dot).
  const roster = parseMarkdownLinks("The roster [above] (see the table) is the authority.");
  assert.deepEqual(roster.links, []);
  assert.deepEqual(roster.refusals, []);
  const value = parseMarkdownLinks("The value [0] (the first) wins.");
  assert.deepEqual(value.links, []);
  assert.deepEqual(value.refusals, []);
  const release = parseMarkdownLinks("The release [notes] (v1.2) are final.");
  assert.deepEqual(release.links, []);
  assert.deepEqual(release.refusals, []);
});

test("parseMarkdownLinks does not refuse a fenced EXAMPLE of a broken link", () => {
  // Documentation legitimately SHOWS broken syntax inside fences; the fence
  // marks it as shown rather than authored, so the refusal path judges the
  // maskFencedCodeBlocks surface and this shape never hard-fails the gate.
  const text = ["Example:", "", "```markdown", "Broken: [docs](some file.md)", "```"].join("\n");
  const { links, refusals } = parseMarkdownLinks(text);
  assert.deepEqual(links, []);
  assert.deepEqual(refusals, []);
});

test("link resolution inside fences stays over-checked — the tolerated asymmetry", () => {
  // Fence masking applies to the REFUSAL path only: a well-formed link
  // inside a fence is still extracted and existence-checked, loudly failing
  // when its target is absent — the tolerated direction issue #243 names.
  // This fixture pins the asymmetry from both sides at once: the link
  // survives, no refusal does.
  const text = ["```markdown", "See [guide](usage/configuration.md) for the options.", "```"].join(
    "\n",
  );
  const { links, refusals } = parseMarkdownLinks(text);
  assert.deepEqual(links, [{ target: "usage/configuration.md", line: 2 }]);
  assert.deepEqual(refusals, []);
});

test("same-line bracket-plus-parenthetical PROSE is neither a link nor a refusal", () => {
  // Ordinary English does this constantly: a bracketed cross-reference
  // followed by an aside in parentheses. Neither half renders as a link, so
  // there is no reference to judge — both sentences must come back empty,
  // and version strings like "(v1.2)" stay prose too (the dot-extension
  // signal requires a letter after the dot).
  const roster = parseMarkdownLinks("The roster [above] (see the table) is the authority.");
  assert.deepEqual(roster.links, []);
  assert.deepEqual(roster.refusals, []);
  const value = parseMarkdownLinks("The value [0] (the first) wins.");
  assert.deepEqual(value.links, []);
  assert.deepEqual(value.refusals, []);
  const release = parseMarkdownLinks("The release [notes] (v1.2) are final.");
  assert.deepEqual(release.links, []);
  assert.deepEqual(release.refusals, []);
});

test("parseMarkdownLinks does not refuse a fenced EXAMPLE of a broken link", () => {
  // Documentation legitimately SHOWS broken syntax inside fences; the fence
  // marks it as shown rather than authored, so the refusal path judges the
  // maskFencedCodeBlocks surface and this shape never hard-fails the gate.
  const text = ["Example:", "", "```markdown", "Broken: [docs](some file.md)", "```"].join("\n");
  const { links, refusals } = parseMarkdownLinks(text);
  assert.deepEqual(links, []);
  assert.deepEqual(refusals, []);
});

test("link resolution inside fences stays over-checked — the tolerated asymmetry", () => {
  // Fence masking applies to the REFUSAL path only: a well-formed link
  // inside a fence is still extracted and existence-checked, loudly failing
  // when its target is absent — the tolerated direction issue #243 names.
  // This pair of assertions pins the asymmetry from both sides at once.
  const text = ["```markdown", "See [guide](usage/configuration.md) for the options.", "```"].join(
    "\n",
  );
  const { links, refusals } = parseMarkdownLinks(text);
  assert.deepEqual(links, [{ target: "usage/configuration.md", line: 2 }]);
  assert.deepEqual(refusals, []);
});

test("same-line bracket-plus-parenthetical PROSE is neither a link nor a refusal", () => {
  // Ordinary English does this constantly: a bracketed cross-reference
  // followed by an aside in parentheses. Neither half renders as a link, so
  // there is no reference to judge — both sentences must come back empty.
  const roster = parseMarkdownLinks("The roster [above] (see the table) is the authority.");
  assert.deepEqual(roster.links, []);
  assert.deepEqual(roster.refusals, []);
  const value = parseMarkdownLinks("The value [0] (the first) wins.");
  assert.deepEqual(value.links, []);
  assert.deepEqual(value.refusals, []);
});

test("parseMarkdownLinks does not refuse a fenced EXAMPLE of a broken link", () => {
  // Documentation legitimately SHOWS broken syntax as an example; the fence
  // marks it as shown rather than authored, so the refusal path judges the
  // maskFencedCodeBlocks surface and this shape never hard-fails the gate.
  const text = ["Example:", "", "```markdown", "Broken: [docs](some file.md)", "```"].join("\n");
  const { links, refusals } = parseMarkdownLinks(text);
  assert.deepEqual(links, []);
  assert.deepEqual(refusals, []);
});

test("link resolution inside fences stays over-checked — the tolerated asymmetry", () => {
  // Masking fences applies to the REFUSAL path only: a well-formed link
  // inside a fence is still extracted and existence-checked, loudly failing
  // when its target is absent — the tolerated direction issue #243 names.
  const text = ["```markdown", "See [guide](usage/configuration.md) for the options.", "```"].join(
    "\n",
  );
  const { links, refusals } = parseMarkdownLinks(text);
  assert.deepEqual(links, [{ target: "usage/configuration.md", line: 2 }]);
  assert.deepEqual(refusals, []);
});

test("parseMarkdownLinks refuses a <…> destination crossed by a line break", () => {
  const { links, refusals } = parseMarkdownLinks("[x](<a\nb>)");
  assert.deepEqual(links, []);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].shape, "angle-destination");
});

test("parseMarkdownLinks still stops a bare destination at its first ')'", () => {
  // Deliberately NOT fixed alongside #243: the paren-bearing misparse fails
  // LOUDLY (as a false broken link on the nonexistent prefix), which is the
  // tolerated direction. This pin keeps the fix from widening into it by
  // accident — if this assertion ever moves, it is a separate decision.
  const { links, refusals } = parseMarkdownLinks("[x](a(b).md)");
  assert.deepEqual(links, [{ target: "a(b", line: 1 }]);
  assert.deepEqual(refusals, []);
});

test("parseMarkdownLinks keeps parsing well-formed links beside the ones it refuses", () => {
  const { links, refusals } = parseMarkdownLinks(
    '[ok](good.md) then [bad](some file.md) then [titled](other.md "Title")',
  );
  assert.deepEqual(links, [
    { target: "good.md", line: 1 },
    { target: "other.md", line: 1 },
  ]);
  assert.deepEqual(refusals, [
    { line: 1, shape: "space-destination", snippet: "[bad](some file.md)" },
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
  // backtick-wrapped prose (see packages/archkeep/src/rules/match.mjs,
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

function file(path, { links = [], refusals = [], citations = [], headings = new Set() } = {}) {
  return { path, links, refusals, citations, headings };
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
      file("packages/archkeep/src/x.mjs", { citations: [{ target: "docs/why.md", line: 7 }] }),
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
      file("packages/archkeep/src/x.mjs", { citations: [{ target: "docs/gone.md", line: 3 }] }),
    ],
    existingPaths: new Set(),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /packages\/archkeep\/src\/x\.mjs:3/);
});

test("evaluate resolves a ../ citation from its carrying file", () => {
  // `../../../docs/…` from `packages/archkeep/src/x.mjs` climbs three levels
  // to the workspace root and lands on `docs/…` — the same path rule that
  // resolves the file, applied to the citation. A shorter climb would be
  // judged against `packages/docs/…` and fail: the file's own directory is
  // the base, not the workspace root.
  const { failures } = evaluate({
    files: [
      file("packages/archkeep/src/x.mjs", {
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
      file("packages/archkeep/src/x.mjs", {
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
        links: [{ target: "../../packages/archkeep/README.md", line: 9 }],
      }),
    ],
    existingPaths: withDirectories([abs("packages/archkeep/README.md")]),
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

test("evaluate FAILS a refused space-destination link — the issue repro, end to end", () => {
  // The red-direction case requirement 2 asks for, driven exactly the way
  // `readFacts` drives the gate: parse the raw markdown, feed BOTH outputs to
  // `evaluate`, and require a failure naming the unresolvable reference. If
  // the parser ever skips the spaced shape silently again (empty refusals) or
  // evaluate stops honoring refusals, this goes red instead of the gate.
  const parsed = parseMarkdownLinks("see [docs](some file.md)");
  const { failures } = evaluate({
    files: [file("README.md", parsed)],
    existingPaths: new Set(),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /README\.md:1/);
  assert.match(failures[0], /space-destination/);
  assert.match(failures[0], /some file\.md/);
});

test("evaluate FAILS an angle-bracketed link whose spaced target does not exist", () => {
  const parsed = parseMarkdownLinks("[guide](<user guide.md>)");
  assert.deepEqual(parsed.refusals, []);
  const { failures } = evaluate({
    files: [file("docs/guide.md", parsed)],
    existingPaths: new Set(),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /docs\/guide\.md:1/);
  assert.match(failures[0], /user guide\.md/);
});

test("evaluate passes an angle-bracketed link whose spaced target exists", () => {
  const parsed = parseMarkdownLinks("[guide](<user guide.md>)");
  const { failures } = evaluate({
    files: [file("docs/guide.md", parsed)],
    existingPaths: new Set([abs("docs/user guide.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 0);
});

test("evaluate fails a link split across lines even when its target exists", () => {
  // The separated shape is not resolvable to anything — GitHub renders it as
  // literal text, so a real file behind it never gets clicked. The refusal
  // fires regardless of what the destination names; fixing the syntax is the
  // only way out.
  const parsed = parseMarkdownLinks("[docs]\n(real.md)");
  const { failures } = evaluate({
    files: [file("docs/a.md", parsed)],
    existingPaths: new Set([abs("docs/real.md")]),
    root: "/repo",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /separated-parens/);
});

test("evaluate reports every refusal, and an unknown shape still fails by name", () => {
  // A shape added to the parser before wording lands here must fail LOUDLY
  // (named by its raw shape value), never pass for lack of a message.
  const { failures } = evaluate({
    files: [
      file("docs/a.md", {
        refusals: [
          { line: 3, shape: "separated-parens", snippet: "[a] (b.md)" },
          { line: 4, shape: "some-future-shape", snippet: "[c] (d.md)" },
        ],
      }),
    ],
    existingPaths: new Set(),
    root: "/repo",
  });
  assert.equal(failures.length, 2);
  assert.match(failures[0], /docs\/a\.md:3/);
  assert.match(failures[0], /separated-parens/);
  assert.match(failures[1], /docs\/a\.md:4/);
  assert.match(failures[1], /some-future-shape/);
});

#!/usr/bin/env node
// Fails on any local reference to a document that does not exist, in either of
// the two shapes a reference takes in this repository:
//
//   1. Markdown links `[text](target)` — the target's file must exist, resolved
//      relative to the file that carries the link, and a `#anchor` fragment
//      naming a heading in that SAME file must match a heading actually there.
//      A link carried by a page INSIDE docs/ must land INSIDE docs/: the
//      documentation is a self-contained tree, so a docs page that links to
//      `../CONTRIBUTING.md` or `../../packages/…` is a failure — its subject
//      belongs in docs/, and a reader of docs/ is a docs reader. Markdown
//      files OUTSIDE docs/ keep the right to link INTO docs/ (the direction a
//      reader is steered toward); only the reverse is refused.
//   2. Prose citations `docs/...` or `../docs/...` in `.mjs` comments and
//      strings and in `.md` prose — resolved from the workspace root when they
//      begin with `docs/`, from the carrying file when they begin with `../` or
//      `./`.
//
// WHY this script exists. The documentation IA restructure deleted two pages
// from `docs/usage/` (the `policy-file.md` and `lattice-json.md` references
// below are the old names, gone from the tree) and moved `json-output.md` and
// `languages.md` out of that directory, and twenty-five references — including
// two inside shipped error messages — kept pointing at the old paths. No
// existing gate saw them: Prettier formats markdown but does not resolve a
// link, markdownlint's closest rule (MD051) checks only `#anchor`
// fragments within one file, and ESLint never reads prose. A broken reference
// is invisible until someone clicks it, and the two that lived in error
// messages were the tool itself sending a reader to a path that does not
// exist.
//
// The facts are read from the filesystem by `readFacts`; the judgment is the
// pure function `evaluate`, which takes those facts as arguments and returns
// verdicts — the same split `check-packages.mjs` and `check-skills.mjs` use,
// so the tests need no filesystem and no mocking library.
//
// Resolution rules, stated once:
//   - a markdown link target resolves relative to the file that carries it;
//   - a citation beginning with `docs/` resolves from the workspace root
//     (this repository's convention for prose references);
//   - a citation beginning with `../` or `./` resolves from its carrying file
//     (the same path rule AGENTS.md applies to comments that cite documents);
//   - a page inside docs/ may only link to another page inside docs/;
//   - everything else is not a reference to this repository's docs and is
//     ignored.
//
// External targets (`http:`, `https:`, `mailto:`) and fragment-only targets
// on a DIFFERENT file are not resolved: the first lives outside the tree this
// gate can see, and the second is a promise about another file's headings that
// GitHub's own anchor handling does not even guarantee — a `#fragment` on the
// same file is checked because markdownlint's MD051 does it and it is cheap;
// a `file.md#fragment` one is checked only for the file half.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Tracked files whose content is a candidate for either reference shape.
export const SCANNED_EXTENSIONS = [".md", ".mjs", ".js"];
// Tracked files that deliberately look broken and must not fail the gate:
// the Semgrep rule fixtures, and this gate's own test file, whose
// failure-direction cases hand it references that do not resolve on purpose
// (a gone target is the input, not a defect in the tree). Same argument
// Semgrep's fixtures get: deliberately unsafe content, checked by its own
// harness rather than by the gate it is written for.
export const IGNORED_PREFIXES = [
  ".github/semgrep/",
  ".claude/worktrees/",
  "scripts/check-docs-links.test.mjs",
];
// The directory a docs/ page may link into — and only into.
export const DOCS_DIR = "docs";

/**
 * Extracts the local targets of every `[text](target)` markdown link in text.
 * External targets and fragment-only anchors are dropped here: external ones
 * are out of this tree's reach, and a bare `#anchor` is the same-file heading
 * check `evaluate` performs, not a path to resolve.
 *
 * @param {string} text contents of a markdown file
 * @returns {{target: string, line: number}[]} local link targets, 1-based line
 */
export function parseMarkdownLinks(text) {
  const links = [];
  const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = re.exec(text))) {
    const target = match[1];
    if (/^(https?:|mailto:|data:|tel:|\/\/)/i.test(target)) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith(".")) continue;
    // A bare `#anchor` stays: it is the same-file heading check `evaluate`
    // performs, not a path to resolve.
    links.push({ target, line: text.slice(0, match.index).split("\n").length });
  }
  return links;
}

/**
 * Extracts prose citations of this repository's docs from a text: `docs/…`
 * (workspace-root relative) or `../docs/…` / `./docs/…` (carrying-file
 * relative). Markdown link syntax is removed first so a target that was
 * already judged as a link is not judged a second time by different rules.
 *
 * @param {string} text contents of a `.md`, `.mjs`, or `.js` file
 * @returns {{target: string, line: number}[]} citation targets, 1-based line
 */
export function parseDocCitations(text) {
  const withoutLinks = text.replace(/!?\[[^\]]*\]\([^)]*\)/g, "");
  const citations = [];
  const re = /((?:\.\.?\/)*)(docs\/[a-z0-9_.-]+\/[a-z0-9_.-]+\.md)/g;
  let match;
  while ((match = re.exec(withoutLinks))) {
    const prefix = match[1];
    const target = `${prefix}${match[2]}`;
    citations.push({ target, line: text.slice(0, match.index).split("\n").length });
  }
  return citations;
}

/**
 * GitHub's heading anchor: lowercase, keep letters/numbers/spaces/hyphens/
 * underscores, spaces become hyphens. This is the same normalization GitHub
 * applies when rendering `#heading` links.
 *
 * @param {string} heading raw heading text
 * @returns {string} the anchor GitHub would give it
 */
export function githubSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

/**
 * The set of anchors a document's headings produce, including GitHub's
 * duplicate-heading suffixes: the second heading with a slug gets `-1`, the
 * third `-2`, and so on.
 *
 * @param {string} text contents of a markdown file
 * @returns {Set<string>} every `#anchor` the file's headings legitimately have
 */
export function headingAnchors(text) {
  const anchors = new Set();
  const seen = new Map();
  const re = /^#{1,6}\s+(.+)$/gm;
  let match;
  while ((match = re.exec(text))) {
    const slug = githubSlug(match[1]);
    const count = seen.get(slug) ?? 0;
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
    seen.set(slug, count + 1);
  }
  return anchors;
}

/**
 * Adds every parent directory of the given paths. A markdown link may point
 * at a directory (`[docs](../usage/)`) and that is a real destination GitHub
 * renders — so a directory counts as existing, and git cannot track an empty
 * one, which means every parent of a tracked path exists on disk by
 * construction.
 *
 * @param {string[]} paths absolute tracked file paths
 * @returns {Set<string>} the paths and every directory containing them
 */
export function withDirectories(paths) {
  const result = new Set(paths);
  for (const path of paths) {
    let dir = dirname(path);
    while (dir !== path && dir !== "/") {
      result.add(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return result;
}

/**
 * Whether an absolute path lies inside `docs/` (or is that directory itself).
 *
 * @param {string} resolved absolute path
 * @param {string} docsDir absolute path of the docs/ directory
 * @returns {boolean}
 */
function insideDocs(resolved, docsDir) {
  return resolved === docsDir || resolved.startsWith(`${docsDir}${sep}`);
}

/**
 * Judges the reference facts and returns verdict lines and failures.
 *
 * `files` maps a repository-relative path to what its content references; each
 * reference is checked for the existence of its target file, and a `#anchor`
 * fragment on the same file is checked against the headings. `existingPaths`
 * is the set of absolute paths that exist, supplied by the caller — the
 * judgment never touches the filesystem itself, so a test drives it with a
 * hand-built set. Anything that cannot resolve is a failure — an empty verdict
 * list must mean "no broken reference", and nothing else.
 *
 * @param {object} input
 * @param {{path: string, links: {target: string, line: number}[], citations: {target: string, line: number}[], headings: Set<string>}[]} input.files
 *   per-file references and same-file heading anchors
 * @param {Set<string>} input.existingPaths absolute paths that exist on disk
 * @param {string} input.root absolute path of the repository root
 * @returns {{lines: string[], failures: string[]}}
 */
export function evaluate({ files, existingPaths, root }) {
  const lines = [];
  const failures = [];

  if (files.length === 0) {
    failures.push(
      "no files were scanned — the gate found nothing to judge, which reads as " +
        "a clean run but means the docs could have broken links in them. If " +
        "this repository has no tracked `.md`/`.mjs`/`.js` files, say so " +
        "explicitly instead of relying on an empty scan.",
    );
    return { lines, failures };
  }

  lines.push(`scanning ${files.length} files for doc references`);

  const docsDir = join(root, DOCS_DIR);

  for (const file of files) {
    const absolute = join(root, file.path);
    const inDocs = file.path.startsWith(`${DOCS_DIR}/`);
    for (const { target, line } of file.links) {
      const [pathPart, fragment] = target.split("#", 2);
      // A bare `#anchor` resolves to the carrying file itself: the part
      // before the fragment is empty and the headings check below applies.
      const resolved = pathPart === "" ? absolute : resolve(dirname(absolute), pathPart);
      if (inDocs && !insideDocs(resolved, docsDir)) {
        failures.push(
          `${file.path}:${line} links to \`${target}\` — a file OUTSIDE docs/. ` +
            `Documentation may link only within docs/, so a page in docs/ cannot ` +
            `point at \`${pathPart || "(this file)"}\` (which resolves to ${resolved}). ` +
            `Name the file in plain text instead of linking it.`,
        );
        continue;
      }
      if (!existingPaths.has(resolved)) {
        failures.push(
          `${file.path}:${line} links to \`${target}\` but \`${pathPart || "(this file)"}\` resolves to ` +
            `${resolved} — which does not exist.`,
        );
        continue;
      }
      if (fragment !== undefined && pathPart !== "") {
        // A fragment naming another file's heading is not checked: GitHub's
        // own anchor handling does not guarantee the heading, so a failure
        // here would be a promise the tool itself cannot keep.
        continue;
      }
      const anchor = fragment ?? "";
      if (anchor !== "" && !file.headings.has(anchor)) {
        failures.push(
          `${file.path}:${line} links to \`#${anchor}\` but no heading in that ` +
            `file produces that anchor.`,
        );
      }
    }
    for (const { target, line } of file.citations) {
      const [pathPart] = target.split("#", 2);
      const base = /^\.\.?\//.test(pathPart) ? dirname(absolute) : root;
      const resolved = resolve(base, pathPart);
      if (!existingPaths.has(resolved)) {
        failures.push(
          `${file.path}:${line} cites \`${target}\` but it resolves to ` +
            `${resolved} — which does not exist.`,
        );
      }
    }
  }

  lines.push(
    failures.length === 0 ? "no broken doc references" : `${failures.length} broken doc references`,
  );
  return { lines, failures };
}

/**
 * The tracked files the gate judges: every file `git ls-files` reports —
 * that list IS `existingPaths`, the set a reference may resolve to, so the
 * judgment and the existence set agree by construction — minus the
 * deliberately unsafe fixtures, plus the parsed references of every
 * `.md`/`.mjs`/`.js` file. Deliberately untested: a test that stubbed this
 * answer would pin the stub, and `git ls-files` is where "tracked" is defined.
 */
function readFacts() {
  const result = spawnSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    console.error(result.stdout ?? "");
    console.error(result.stderr ?? "");
    console.error("`git ls-files` failed, so the tracked file list could not be read.");
    process.exit(1);
  }

  const tracked = result.stdout.split("\n").filter((path) => path !== "");
  const existingPaths = withDirectories(tracked.map((path) => join(root, path)));

  const files = [];
  for (const path of tracked) {
    if (!SCANNED_EXTENSIONS.some((ext) => path.endsWith(ext))) continue;
    if (IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
    const text = readFileSync(join(root, path), "utf8");
    files.push({
      path,
      links: path.endsWith(".md") ? parseMarkdownLinks(text) : [],
      citations: parseDocCitations(text),
      headings: path.endsWith(".md") ? headingAnchors(text) : new Set(),
    });
  }
  return { files, existingPaths };
}

function main() {
  const { files, existingPaths } = readFacts();
  const { lines, failures } = evaluate({ files, existingPaths, root });

  for (const line of lines) console.log(line);

  if (failures.length > 0) {
    console.error("");
    for (const failure of failures) console.error(`✗ ${failure}`);
    process.exit(1);
  }
}

/**
 * Whether this file was RUN rather than imported, compared on real paths.
 * See `check-packages.mjs` for the reason this exists and why it is not shared.
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) main();

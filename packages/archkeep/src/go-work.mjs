/**
 * go.work drift — the workspace-level check that a developer's `go` and the Nx
 * graph select the same set of Go modules.
 *
 * A `go.work` at the workspace root decides, through its `use` directives,
 * which modules `go build` and gopls load on a developer's machine. The Nx
 * graph covers every project carrying `<projectRoot>/go.mod`, and nothing ties
 * the two lists together: a project whose directory is missing from `use`
 * builds differently on the dev machine than in CI, and the divergence is
 * byte-for-byte invisible — both sides look fine on their own. That silence is
 * the state this package exists to end, so both directions of drift are
 * findings and `../cli.mjs` fails the run on them the way it fails on a
 * boundary violation.
 *
 * The file is read statically, never by invoking `go` — the same refusal every
 * resolver here holds (project `AGENTS.md`, "Static analysis by design"), for
 * the same reason: this runs on machines that never installed the toolchain.
 * Only a TRACKED `go.work` at the workspace root is read, which is the
 * established keying — a workspace without one pays nothing and the report
 * says nothing about it. There is no switch.
 *
 * **This check runs on the CLI surface only, not in the language server.** A
 * drift finding describes the workspace — a list in one file against a graph —
 * not any document being edited. The LSP publishes per-document diagnostics,
 * and pinning a workspace-level finding to whichever file happens to be open
 * would put the report somewhere its fix is not.
 *
 * The grammar this reads is the documented one (go.dev/ref/mod, "Workspaces" —
 * `go.work` shares `go.mod`'s lexical elements): `//` comments and no block
 * comments, interpreted strings whose `\X` escape is replaced by `X`, raw
 * backquoted strings, identifiers and strings interchangeable, one directive
 * per line, and a keyword factored over a `( … )` block. `use` takes one
 * directory path, absolute or relative to the directory holding `go.work`.
 *
 * Known parse limits, deliberate and pinned by tests. The Go analyzers' limits
 * each err toward a spurious record; a manifest read errs the same way a
 * malformed boundary config does — it stops the run loudly — because here the
 * silent direction is an EMPTY use list, and a malformed `go.work` read as "no
 * drift" is exactly the false green this check exists to remove:
 *
 * - **A `go.work` this parser cannot read throws, never returns fewer
 *   entries.** An unterminated block or string, a `use` without a path, stray
 *   tokens, or a keyword outside go.work's five (below) each name their line;
 *   `../cli.mjs` turns the throw into a whole-file failure, so the run exits 3
 *   (no verdict), not 0.
 * - **A string may not span a line.** Legal `go.mod` syntax keeps strings on
 *   one line; a raw string left open runs to the end of the line and throws as
 *   unterminated rather than silently swallowing the directives below it.
 * - **Only go.work's own five directive keywords are skipped as unread,
 *   blocks included.** `use` is read; `go`, `toolchain`, `godebug` and
 *   `replace` are recognized and passed over without being mistaken for
 *   paths. Any other keyword throws — verified against `go work edit` itself
 *   (go1.24.7), which rejects one as `"unknown directive"` rather than
 *   skipping it, so text that is not a go.work file at all (an HTML error
 *   page from a bad download, a truncated checkout) is read as unparseable,
 *   never as zero `use` entries.
 * - **Paths are compared with `/` separators.** A `\`-separated Windows path
 *   or a drive-letter absolute path matches no project root and surfaces as a
 *   drift finding naming the text the file really contains — loud, never
 *   silent.
 *
 * The comparison follows the graph's model — one module per project root,
 * `<projectRoot>/go.mod` (project `AGENTS.md`, "One module/crate/package per
 * project root"). Consequences, both deliberate: a nested `go.mod` is never
 * REQUIRED to appear in `use`, because the graph does not model it either; but
 * a `use` entry that names one is reported, because that is the moment the
 * developer's build and the graph demonstrably diverge — the module builds
 * locally while `nx affected` and the boundary check never see it.
 */
import { isAbsolute, posix, relative, sep } from "node:path";

import { projectOwning } from "./analysis/source-util.mjs";

/**
 * What each drift finding means — one entry per `messageId` a finding can
 * carry. `../report/sarif.mjs` derives its rule descriptors from this table,
 * the same arrangement it has with `../rules/messages.mjs`, so a kind added
 * here cannot be nameless in a code-scanning upload.
 */
export const GO_WORK_MESSAGES = Object.freeze({
  goWorkMissingUse:
    "A project's go.mod is not in go.work's use list: a developer's go build and gopls skip a " +
    "module the Nx graph covers, so dev machines and CI select different module sets.",
  goWorkStaleUse:
    "A go.work use entry names a directory with no tracked go.mod: go commands fail on developer " +
    "machines while CI, which never reads go.work, stays green.",
  goWorkUnmodeledUse:
    "A go.work use entry names a module the Nx graph does not model: it builds on developer " +
    "machines while nx affected and the boundary check never see it.",
  goWorkOutsideUse:
    "A go.work use entry points outside the workspace: developer builds include a module no run " +
    "over this workspace can cover.",
});

export const GO_WORK_MESSAGE_IDS = Object.freeze(Object.keys(GO_WORK_MESSAGES));

/** A parse failure that names its line, so the failure record is actionable. */
const parseError = (line, reason) => new Error(`go.work:${line}: ${reason}`);

/** The characters that end an identifier token — go.mod's own boundaries. */
const IDENTIFIER_BOUNDARY = new Set([" ", "\t", "\r", '"', "`", "(", ")"]);

/**
 * One line of go.work as tokens: `(`/`)` punctuation, identifiers, and the
 * unquoted values of interpreted and raw strings. A `//` between tokens starts
 * a comment that runs to the end of the line; inside an identifier a `/` is an
 * ordinary path character, which is how `./a` and `example.com/x` stay whole.
 *
 * @param {string} line One line, without its newline.
 * @param {number} lineNumber 1-based, for error messages.
 * @returns {{ value: string, column: number, punct: boolean }[]} `column` is
 *   1-based and points at the token's first character in the line.
 * @throws {Error} on an unterminated string — a string left open would
 *   otherwise swallow the rest of the line silently.
 */
function tokenizeGoWorkLine(line, lineNumber) {
  const tokens = [];
  let at = 0;
  while (at < line.length) {
    const char = line[at];
    if (char === " " || char === "\t" || char === "\r") {
      at += 1;
    } else if (char === "/" && line[at + 1] === "/") {
      break;
    } else if (char === "(" || char === ")") {
      tokens.push({ value: char, column: at + 1, punct: true });
      at += 1;
    } else if (char === '"') {
      // Interpreted string: each `\X` escape is replaced by `X`, which is the
      // documented unquoting — `\"` is `"`, and `\n` is the letter n.
      let value = "";
      let cursor = at + 1;
      while (cursor < line.length && line[cursor] !== '"') {
        if (line[cursor] === "\\" && cursor + 1 < line.length) {
          value += line[cursor + 1];
          cursor += 2;
        } else {
          value += line[cursor];
          cursor += 1;
        }
      }
      if (cursor >= line.length) {
        throw parseError(lineNumber, "unterminated quoted string");
      }
      tokens.push({ value, column: at + 1, punct: false });
      at = cursor + 1;
    } else if (char === "`") {
      // Raw string: no escapes. One that never closes would swallow every
      // directive after it, so it throws instead — the header's second limit.
      const close = line.indexOf("`", at + 1);
      if (close === -1) {
        throw parseError(lineNumber, "unterminated raw string (strings may not span a line)");
      }
      tokens.push({ value: line.slice(at + 1, close), column: at + 1, punct: false });
      at = close + 1;
    } else {
      let end = at;
      while (end < line.length && !IDENTIFIER_BOUNDARY.has(line[end])) end += 1;
      tokens.push({ value: line.slice(at, end), column: at + 1, punct: false });
      at = end;
    }
  }
  return tokens;
}

/**
 * go.work's own directive keywords — verified against `go work edit` itself
 * (go1.24.7): a keyword outside this set is `go`'s own `"unknown directive"`
 * parse error, not a directive the format tolerates. `use` is the only one
 * this parser reads; the other four are recognized so their lines (and, for
 * `replace`, their block bodies) can be skipped without being mistaken for
 * paths — the header's "only five keywords are skipped as unread" limit.
 */
const KNOWN_DIRECTIVES = new Set(["go", "toolchain", "use", "replace", "godebug"]);

/**
 * Every `use` directive in a go.work, single-line and block form, with the
 * position of each path as written.
 *
 * Malformed input **throws** rather than returning what was readable so far:
 * this list's emptiness is the fact the drift check turns on, and a use list
 * truncated by a parse problem would read as projects the developer removed —
 * or, worse, as no drift at all (the header's first limit). A keyword outside
 * go.work's own five throws for the same reason: text that only coincidentally
 * tokenizes (an HTML error page, a truncated download) must not read as a
 * go.work with zero `use` entries.
 *
 * @param {string} text The go.work file's contents.
 * @returns {{ path: string, line: number, column: number }[]} In file order;
 *   `path` is unquoted but not normalized, so a finding can cite it as written.
 * @throws {Error} naming the offending line.
 */
export function parseGoWorkUse(text) {
  const uses = [];
  /** @type {{ keyword: string, line: number }|null} */
  let block = null;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const tokens = tokenizeGoWorkLine(lines[index], lineNumber);
    if (tokens.length === 0) continue;

    if (block !== null) {
      if (tokens[0].punct && tokens[0].value === ")") {
        if (tokens.length > 1) {
          throw parseError(lineNumber, "unexpected text after the ')' closing a block");
        }
        block = null;
      } else if (block.keyword !== "use") {
        // Another directive's block body — skipped, never read as paths.
      } else if (tokens.length !== 1 || tokens[0].punct) {
        throw parseError(lineNumber, "a use block line must hold exactly one directory path");
      } else {
        uses.push({ path: tokens[0].value, line: lineNumber, column: tokens[0].column });
      }
      continue;
    }

    const [keyword, ...rest] = tokens;
    if (keyword.punct) {
      throw parseError(lineNumber, `unexpected '${keyword.value}' outside any block`);
    }
    if (rest.length === 1 && rest[0].punct && rest[0].value === "(") {
      if (!KNOWN_DIRECTIVES.has(keyword.value)) {
        throw parseError(lineNumber, `unknown block type: ${keyword.value}`);
      }
      block = { keyword: keyword.value, line: lineNumber };
      continue;
    }
    if (keyword.value !== "use") {
      if (!KNOWN_DIRECTIVES.has(keyword.value)) {
        throw parseError(lineNumber, `unknown directive: ${keyword.value}`);
      }
      continue; // go, toolchain, replace, godebug one-liners
    }
    if (rest.length !== 1 || rest[0].punct) {
      throw parseError(
        lineNumber,
        rest.length === 0
          ? "'use' needs a directory path"
          : "'use' takes exactly one directory path (the block form puts '(' at the end of the line)",
      );
    }
    uses.push({ path: rest[0].value, line: lineNumber, column: rest[0].column });
  }
  if (block !== null) {
    throw parseError(block.line, `'${block.keyword} (' block is never closed`);
  }
  return uses;
}

/** Nx spells the workspace-root project's root as "." where files use "". */
const normalizeProjectRoot = (root) => (root === "." || root == null ? "" : root);

/** A directory for display, with the one root spelling that needs words. */
const displayDir = (dir) => (dir === "" ? "the workspace root" : dir);

/** The `use` argument that would name `dir`, for a fix the reader can paste. */
const useSpelling = (dir) => (dir === "" ? "." : `./${dir}`);

/**
 * A use path as a workspace-relative directory, or `null` when it points
 * outside the workspace. `go.work` sits at the workspace root, so a relative
 * path is relative to exactly that directory.
 *
 * @param {string} usePath As written (unquoted).
 * @param {string} workspaceRoot Absolute.
 * @returns {string|null} `""` for the root itself.
 */
function useDirectory(usePath, workspaceRoot) {
  if (isAbsolute(usePath)) {
    const rel = relative(workspaceRoot, usePath).split(sep).join("/");
    return rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? null : rel;
  }
  let dir = posix.normalize(usePath);
  while (dir.endsWith("/")) dir = dir.slice(0, -1);
  if (dir === ".") dir = "";
  return dir === ".." || dir.startsWith("../") ? null : dir;
}

/**
 * The drift between a go.work use list and the graph's Go module projects —
 * pure, facts as arguments, so the tests need no filesystem.
 *
 * Both directions are findings, because both mean the developer's `go` and CI
 * disagree about which modules exist:
 *
 * - **`goWorkMissingUse`** — a project with a tracked `<projectRoot>/go.mod`
 *   whose directory no `use` entry names. The graph judges it; the developer's
 *   build skips it.
 * - **`goWorkStaleUse`** — a `use` entry with no tracked `go.mod` at its
 *   directory. `go` itself refuses such an entry, so the developer's build is
 *   broken (or the `go.mod` is untracked, which reads the same to a tool whose
 *   file set is `git ls-files`) while CI never notices.
 * - **`goWorkUnmodeledUse`** — a `use` entry whose directory has a tracked
 *   `go.mod` but is no project root: a module nested inside a project, or
 *   inside no project at all. It builds locally; the graph draws no edge and
 *   no boundary verdict for it (the header's modeling note).
 * - **`goWorkOutsideUse`** — a `use` entry above the workspace root. Whatever
 *   it builds, no run over this workspace can cover it.
 *
 * One of the FOUR finding families — PD-13 (2026-09-06) outcome (c): no
 * Finding supertype exists, and the relationship pin lives on
 * `./rules/index.mjs`'s `violationOf` header. These findings stay this
 * family's own shape and fold into the one verdict lane as count keys into
 * `verdictFor` (`./verdict.mjs`). The canonical statement is the
 * "Finding — the unowned concept" section of
 * `../../../docs/architecture/refactor/SEMANTIC-MODEL.md`.
 *
 * @param {{ uses: { path: string, line: number, column: number }[],
 *   workspaceRoot: string,
 *   projects: { name: string, root: string }[],
 *   files: string[] }} facts `files` is the tracked-file list; `projects`
 *   comes from the graph.
 * @returns {{ findings: { messageId: string, file: string, line: number|null,
 *   column: number|null, message: string, directory: string|null,
 *   project: string|null }[], moduleProjects: number }} `moduleProjects`
 *   counts the go.mod-carrying projects, so the report can state the check's
 *   coverage beside its verdict.
 */
export function compareGoWork({ uses, workspaceRoot, projects, files }) {
  const tracked = new Set(files);
  const goModAt = (dir) => (dir === "" ? "go.mod" : `${dir}/go.mod`);
  const normalizedProjects = projects.map((project) => ({
    name: project.name,
    root: normalizeProjectRoot(project.root),
  }));
  const moduleProjects = normalizedProjects.filter((project) => tracked.has(goModAt(project.root)));
  const projectByRoot = new Map(moduleProjects.map((project) => [project.root, project]));

  const findings = [];
  const usedDirs = new Set();
  for (const use of uses) {
    const site = { file: "go.work", line: use.line, column: use.column };
    const dir = useDirectory(use.path, workspaceRoot);
    if (dir === null) {
      findings.push({
        messageId: "goWorkOutsideUse",
        ...site,
        directory: null,
        project: null,
        message:
          `go.work uses "${use.path}", which lies outside the workspace — a developer's go ` +
          `build includes a module that no graph, affected run, or boundary check over this ` +
          `workspace can ever cover.`,
      });
      continue;
    }
    usedDirs.add(dir);
    if (projectByRoot.has(dir)) continue;
    if (tracked.has(goModAt(dir))) {
      const owner = projectOwning(normalizedProjects, goModAt(dir));
      findings.push({
        messageId: "goWorkUnmodeledUse",
        ...site,
        directory: dir,
        project: owner?.name ?? null,
        message:
          `go.work uses "${use.path}", whose go.mod is ` +
          (owner
            ? `nested inside project "${owner.name}" — the graph models one module per project ` +
              `root (<projectRoot>/go.mod), so this module builds on developer machines while ` +
              `nx affected and the boundary check draw no edges for it. Split it into its own ` +
              `Nx project.`
            : `inside no Nx project — the module builds on developer machines while nx affected ` +
              `and the boundary check never see it. Declare a project there so the graph ` +
              `models it.`),
      });
    } else {
      findings.push({
        messageId: "goWorkStaleUse",
        ...site,
        directory: dir,
        project: null,
        message:
          `go.work uses "${use.path}", but the workspace has no tracked go.mod at ` +
          `${displayDir(dir)} — the entry names a module this workspace does not contain ` +
          `(moved, deleted, or untracked), so go commands fail on developer machines while CI, ` +
          `which never reads go.work, stays green. Remove the entry, or track the module.`,
      });
    }
  }

  for (const project of moduleProjects) {
    if (usedDirs.has(project.root)) continue;
    findings.push({
      messageId: "goWorkMissingUse",
      file: "go.work",
      line: null,
      column: null,
      directory: project.root,
      project: project.name,
      message:
        `go.work does not use ${displayDir(project.root)} — the graph covers project ` +
        `"${project.name}" (${goModAt(project.root)}), but a developer's go build and gopls ` +
        `skip it, so dev machines and CI select different module sets. Add ` +
        `"use ${useSpelling(project.root)}" to go.work.`,
    });
  }

  return { findings, moduleProjects: moduleProjects.length };
}

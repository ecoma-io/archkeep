/**
 * Rust resolver — reads Cargo manifests with a real TOML parser (smol-toml),
 * no `cargo` binary required.
 *
 * Model: one crate per Nx project (`<projectRoot>/Cargo.toml`). Edges come
 * from dependency entries that resolve to another project's directory:
 *   - `{ path = "…" }` entries, relative to the declaring manifest;
 *   - `{ workspace = true }` entries, resolved through the nearest ancestor
 *     manifest carrying `[workspace]` (its `[workspace.dependencies]` entry
 *     must itself be a `path` dependency to point at a project).
 * Registry (crates.io) dependencies are ignored — external nodes are out of
 * scope for this plugin; only project↔project edges matter to `nx affected`.
 *
 * ## Source level, alongside the manifests
 *
 * `analyzeRust` reads `.rs` sources for what the manifests cannot show: WHICH
 * file reaches another crate, on which line, through which path. A Cargo
 * manifest says a crate may be used; it never says a boundary was crossed, and
 * `Cargo.toml:1` is not a location a reader can act on.
 *
 * The crate a `use` names is the **import** name, which is not always the
 * package name. Two spellings have to be reconciled, and both occur in real
 * trees: Cargo replaces `-` with `_` for the identifier (`engine-core`
 * is `use engine_core::…`), and a `[lib] name` overrides the package name
 * outright — a Tauri desktop package declaring `[lib] name = "app_lib"` makes
 * that the only spelling its own `main.rs` can use. Both sides are normalised to
 * underscores before matching, and `[lib] name` wins when it is present.
 *
 * Known parse limits, deliberate and pinned by tests. The worst case of each
 * is a spurious record naming text the file really contains — never a missed
 * project, which is the standard the Go header sets:
 *
 * - **`use` is matched at a line start, after a `;`/`{`/`}`, or after a
 *   same-line attribute block**, read up to but NOT consuming the `;` that
 *   closes it — a lookahead, so that same `;` is still there to open the next
 *   match's `(?:^|[{;}])` when a second `use` shares the line. Every position
 *   Rust allows a `use` statement starts one of those ways, and the closing
 *   `;` is never swallowed, so two or more `use` statements sharing one line
 *   are each read, not just the first. A same-line attribute's bracketed
 *   content is read past a balanced quoted string rather than stopping at the
 *   first `]`, so `#[doc = "see [x]"] use a::b;` still reaches its `use`. A
 *   `use` inside a raw string literal that starts its own line would be read,
 *   and a `;` inside a comment or string can let a `use` written there be
 *   read — both are the accepted spurious-record trade (text the file really
 *   contains), never a missed project.
 * - **A `use` whose path opens with a brace group** — `use {a::b, c::d};` — is
 *   a LIST of paths and is read as one: each arm names its own crate at its
 *   head, so the statement means exactly `use a::b; use c::d;` and produces one
 *   record per arm, at the arm's own position. Nothing is guessed, because
 *   nothing is ambiguous. Only text that is not a well-formed group — braces
 *   that do not balance, or anything after the group's close — keeps the older
 *   answer: one record with `resolved: null` and a failure beside it, never a
 *   dropped record.
 * - **Uniform paths are ambiguous and resolved toward the crate.** Since Rust
 *   2018, `use foo::Bar` can name either an extern crate `foo` or a local
 *   `mod foo`. A first segment matching another project's crate name is read
 *   as that crate. A local module deliberately named after a sibling crate
 *   would produce a spurious record.
 * - **`mod` is not an import.** A `mod` declaration names a file inside the
 *   same crate, so it crosses no project boundary and is never recorded.
 * - **A UTF-8 BOM before a first-line statement is tolerated** (`contract.md`,
 *   byte tolerance): every anchor here is `^` or a character class the BOM
 *   fails, so an editor-written `\uFEFF` used to drop a first-line `use` and
 *   a first-line `extern crate` — records gone with no failure beside them.
 *   The BOM is blanked to a space, not stripped, so every offset stays an
 *   offset into the file as it sits on disk; the bare-path and fully-qualified
 *   forms needed nothing, their `(^|[^…])` prefix already reads the BOM as
 *   ordinary preceding text.
 *
 * **A renamed dependency IS followed, scoped to the project that renamed
 * it.** `dep = { package = "real", path = "../real" }` in a project's own
 * Cargo.toml makes `real`'s crate reachable from THAT project's `.rs` sources
 * only under the identifier `dep` — Rust builds a crate's `extern` prelude
 * from its own manifest alone, so a different project renaming something else
 * to `dep`, or `dep` happening to be nobody's rename at all, has no bearing on
 * what THIS project's `use dep::…` means. `renamedDepsOf` below resolves the
 * rename exactly the way `resolveRustDependencies` resolves the manifest
 * entry it comes from — same `path`/`workspace = true` handling — so a `use`
 * naming the rename lands on the same project the graph edge already points
 * at, never a second, disagreeing answer.
 */
import { normalizePath, parseManifest } from "./manifest-util.mjs";
import {
  emptyResult,
  fileFailure,
  perWorkspace,
  positionAt,
  projectOwning,
  trackedManifests,
} from "./source-util.mjs";

const DEP_SECTIONS = ["dependencies", "dev-dependencies", "build-dependencies"];

/** All dependency tables in a manifest: top-level plus per-target ones. */
function* depTables(manifest) {
  for (const section of DEP_SECTIONS) {
    if (manifest[section]) yield manifest[section];
  }
  for (const targetCfg of Object.values(manifest.target ?? {})) {
    for (const section of DEP_SECTIONS) {
      if (targetCfg?.[section]) yield targetCfg[section];
    }
  }
}

/**
 * Nearest ancestor dir (starting at the parent of `startDir`) whose
 * Cargo.toml declares `[workspace]`; `{ dir, manifest }` or null.
 */
function findWorkspaceManifest(startDir, readFile) {
  let dir = startDir;
  while (dir.includes("/")) {
    dir = dir.slice(0, dir.lastIndexOf("/"));
    const manifest = parseManifest(readFile(`${dir}/Cargo.toml`) ?? "");
    if (manifest?.workspace) return { dir, manifest };
  }
  const manifest = parseManifest(readFile("Cargo.toml") ?? "");
  return manifest?.workspace ? { dir: "", manifest } : null;
}

/**
 * Static edges between Rust projects. Same contract as the Go resolver:
 * `projects` [{ name, root }], `filesOf(name)`, `readFile(path)` → raw deps.
 */
export function resolveRustDependencies(projects, filesOf, readFile) {
  const projectByRoot = new Map();
  const crates = [];
  for (const project of projects) {
    const manifestPath = normalizePath(project.root, "Cargo.toml");
    if (!filesOf(project.name).includes(manifestPath)) continue;
    const manifest = parseManifest(readFile(manifestPath) ?? "");
    if (!manifest?.package?.name) continue; // workspace-only manifests are not crates
    // Normalized, not raw: Nx spells the workspace-root project's `root` as
    // `"."`, which `normalizePath` collapses to `""` — the same value a
    // dependency pointing AT that project resolves `pathDir` to below. Keying
    // on the raw `root` would leave `"."` in the map and miss every lookup.
    projectByRoot.set(normalizePath(project.root, ""), project.name);
    crates.push({ project, manifest, manifestPath });
  }

  const dependencies = [];
  for (const { project, manifest, manifestPath } of crates) {
    const workspace = { resolved: false, value: null }; // lazy per-crate lookup
    for (const table of depTables(manifest)) {
      for (const [depName, spec] of Object.entries(table)) {
        if (typeof spec !== "object" || spec === null) continue;
        let pathDir = null;
        if (typeof spec.path === "string") {
          pathDir = normalizePath(project.root, spec.path);
        } else if (spec.workspace === true) {
          if (!workspace.resolved) {
            workspace.resolved = true;
            workspace.value = findWorkspaceManifest(project.root, readFile);
          }
          // `[workspace.dependencies]` is keyed by the member's LOCAL name,
          // the key Cargo inherits from (measured against cargo 1.96: a member
          // `foo = { package = "bar", workspace = true }` fails to parse). A
          // rename on an inherited dep lives in the workspace spec's own
          // `package`, and `wsSpec.path` still resolves the crate.
          const wsSpec = workspace.value?.manifest.workspace?.dependencies?.[depName];
          if (typeof wsSpec?.path === "string") {
            pathDir = normalizePath(workspace.value.dir, wsSpec.path);
          }
        }
        // `pathDir` is `""` (falsy, but a real answer) when a dependency
        // points AT the workspace-root project — `normalizePath` resolves an
        // in-tree path that climbs all the way to the root as the empty
        // string. `projectByRoot` is keyed the same way (normalized, not
        // raw), so this matches that project regardless of whether its own
        // `root` is spelled `""` or Nx's `"."`. Only `null` (no
        // `path`/`workspace = true` resolved at all) means "no target".
        if (pathDir === null) continue;
        const target = projectByRoot.get(pathDir);
        if (target && target !== project.name) {
          dependencies.push({
            source: project.name,
            target,
            sourceFile: manifestPath,
            type: "static",
          });
        }
      }
    }
  }
  return dependencies;
}

/** Cargo's identifier spelling of a crate name: `-` and `.` become `_`. */
export function crateIdentifier(name) {
  return name.replace(/[-.]/g, "_");
}

/**
 * The name every `.rs` source must spell to reach a crate: `[lib] name` when
 * the manifest overrides it, the package name otherwise, always as an
 * identifier.
 *
 * @param {object} manifest A parsed Cargo.toml.
 * @returns {string|null}
 */
export function crateImportName(manifest) {
  const declared = manifest?.lib?.name ?? manifest?.package?.name;
  return typeof declared === "string" && declared !== "" ? crateIdentifier(declared) : null;
}

/**
 * Crate import name → project name, over every tracked `Cargo.toml` in each
 * project rather than only the one at its root — see `trackedManifests` for
 * why analysis is broader here than the edge resolver above, and for the one
 * project in this workspace that needs it. A workspace-only manifest declares
 * no `[package]`, so the repo-root `Cargo.toml` contributes nothing.
 */
const crateNamesOf = perWorkspace((workspace) => {
  const byCrate = new Map();
  for (const project of workspace.projects) {
    for (const manifestPath of trackedManifests(workspace, project.name, "Cargo.toml")) {
      const crate = crateImportName(parseManifest(workspace.readFile(manifestPath) ?? ""));
      if (crate) byCrate.set(crate, project.name);
    }
  }
  return byCrate;
});

/**
 * Per-project renamed-dependency aliases — see the header's "A renamed
 * dependency IS followed". Reads each project's OWN Cargo.toml dependency
 * tables (the same `depTables` the edge resolver walks) for an entry carrying
 * `package = "…"`, and resolves its `path`/`workspace = true` spec exactly
 * the way `resolveRustDependencies` does, so the two can never disagree about
 * which project a rename reaches.
 *
 * Scoped per project rather than folded into the single global `crateNamesOf`
 * map: the alias is a fact about the IMPORTER's manifest, not the imported
 * crate, and a sibling project could rename the very same dependency to a
 * different local name, or not rename it at all.
 *
 * Only at the project root, matching `resolveRustDependencies` rather than
 * `crateNamesOf`'s broader `trackedManifests` walk — a nested manifest (the
 * Tauri `src-tauri/` shape) draws no graph edge to resolve a rename against
 * in the first place, so there is no target here to be consistent with.
 *
 * @returns {Map<string, Map<string, string>>} project name -> (the identifier
 *   a `.rs` file spells -> the project the rename actually reaches).
 */
const renamedDepsOf = perWorkspace((workspace) => {
  const projectByRoot = new Map();
  // Normalized, not raw — see the identical comment in
  // `resolveRustDependencies` above: Nx's `"."` root spelling and `""` both
  // have to land on the same map key for a rename pointing at the
  // workspace-root project to resolve.
  for (const project of workspace.projects) {
    projectByRoot.set(normalizePath(project.root, ""), project.name);
  }

  const byProject = new Map();
  for (const project of workspace.projects) {
    const manifestPath = normalizePath(project.root, "Cargo.toml");
    if (!workspace.filesOf(project.name).includes(manifestPath)) continue;
    const manifest = parseManifest(workspace.readFile(manifestPath) ?? "");
    if (!manifest) continue;

    const aliases = new Map();
    const ws = { resolved: false, value: null }; // lazy per-crate lookup, as the edge resolver
    for (const table of depTables(manifest)) {
      for (const [depName, spec] of Object.entries(table)) {
        if (typeof spec !== "object" || spec === null) continue;
        let renamed = false;
        let pathDir = null;
        if (typeof spec.path === "string") {
          pathDir = normalizePath(project.root, spec.path);
          renamed = typeof spec.package === "string";
        } else if (spec.workspace === true) {
          if (!ws.resolved) {
            ws.resolved = true;
            ws.value = findWorkspaceManifest(project.root, workspace.readFile);
          }
          // `[workspace.dependencies]` is keyed by the member's LOCAL name
          // (`depName`), which is the key Cargo inherits from — measured
          // against cargo 1.96, a member `foo = { package = "bar",
          // workspace = true }` fails to parse. A rename on an inherited dep
          // lives in the WORKSPACE spec (`as_real = { path = …, package =
          // "real" }`), never on the member entry, which may carry no
          // `package` at all.
          const wsSpec = ws.value?.manifest.workspace?.dependencies?.[depName];
          if (typeof wsSpec?.path === "string") {
            pathDir = normalizePath(ws.value.dir, wsSpec.path);
            renamed = typeof spec.package === "string" || typeof wsSpec.package === "string";
          }
        }
        // A plain `use real::…` resolves through `crateNamesOf`; the alias
        // map is only for names the local spelling does not match, so an
        // entry that is not a rename contributes nothing here. `pathDir` is
        // `""` (falsy, but a real answer) when the dependency points AT the
        // workspace-root project — see the identical guard and its comment in
        // `resolveRustDependencies` above — so the "no target" check and the
        // "not a rename" check must stay two separate conditions.
        if (pathDir === null) continue;
        if (!renamed) continue;
        const target = projectByRoot.get(pathDir);
        if (target && target !== project.name) aliases.set(crateIdentifier(depName), target);
      }
    }
    if (aliases.size > 0) byProject.set(project.name, aliases);
  }
  return byProject;
});

/** Path prefixes that name the crate being compiled rather than another one. */
const OWN_CRATE_ROOTS = new Set(["crate", "self", "super"]);

/**
 * Is this `use` path spelled as a reference inside the file's own project —
 * the `spelling.relative` bit of the analysis record (`contract.md`)?
 *
 * Two spellings qualify, and the second is the one a JavaScript-shaped
 * predicate cannot see.
 *
 * 1. **`crate::`, `self::`, `super::`** — Rust's relative forms. They are what
 *    `./x` and `../x` are to JavaScript, and a `.rs` file that uses them has
 *    not left its crate at all.
 * 2. **A crate name this file's OWN project declares.** One Cargo package
 *    compiles several crates — a `[lib]`, a `[[bin]]`, tests, examples — and a
 *    binary reaches its package's library by naming it (`rba_desktop_lib::run`,
 *    which `[lib] name` may rename outright). Nx models the package as one
 *    project, so source and target land on the same node; Cargo offers no other
 *    spelling for it, and its crate graph cannot cycle, so this is never the
 *    round trip out through a public alias and back in that
 *    `noSelfCircularDependencies` names.
 *
 * Nothing here is a filesystem path: a `use` path names items inside a module
 * tree, so `spelling.path` is always false for Rust.
 *
 * @param {string|null} root The `use` path's first segment; `null` for a brace group.
 * @param {{name: string}|null} owner The project owning the source file.
 * @param {Map<string, string>} byCrate Crate import name → project name.
 * @returns {boolean}
 */
function isOwnProjectPath(root, owner, byCrate) {
  if (root === null) return false;
  if (OWN_CRATE_ROOTS.has(root)) return true;
  return owner !== null && byCrate.get(crateIdentifier(root)) === owner.name;
}

/**
 * The arms of a `use` path that opens with a brace group, each with its offset
 * inside `path`.
 *
 * `use {a::b, c::d};` is not ambiguous and never was: the group is a list, and
 * every arm is a complete path naming its own crate at its head — the
 * statement means exactly `use a::b; use c::d;`. Reading it as "names no crate"
 * cost every arm its record, which is what made 29 files of a real Rust
 * repository report dependencies nothing could see (`scripts/coverage-real-trees.mjs`
 * pins the count that found it).
 *
 * Splitting is done by hand rather than by a regex because commas nest:
 * `{a::{b, c}, d::e}` has two top-level arms, and a comma-split would produce
 * three. Depth is counted over `{}` only — a `use` path holds no other
 * bracket.
 *
 * Returns `null` for a group whose braces do not balance, which keeps the
 * loud path for text that is not a well-formed group: a half-read group is
 * exactly the guess this analyzer refuses.
 *
 * @param {string} path The `use` path, from the first non-space to the `;`.
 * @returns {{text: string, offset: number}[] | null}
 */
export function braceGroupArms(path) {
  const open = path.indexOf("{");
  if (open === -1 || path.slice(0, open).trim() !== "") return null;
  /** @type {{text: string, offset: number}[]} */
  const arms = [];
  let depth = 0;
  let start = -1;
  for (let index = open; index < path.length; index += 1) {
    const character = path[index];
    if (character === "{") {
      depth += 1;
      if (depth === 1) start = index + 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        arms.push({ text: path.slice(start, index), offset: start });
        // Anything after the group's close is not a path this reader knows how
        // to split — `use {a}::b;` is not Rust — so it is left to the caller's
        // loud path rather than half-read.
        if (path.slice(index + 1).trim() !== "") return null;
        start = -1;
      }
      if (depth < 0) return null;
      continue;
    }
    if (character === "," && depth === 1) {
      arms.push({ text: path.slice(start, index), offset: start });
      start = index + 1;
    }
  }
  if (depth !== 0 || start !== -1) return null;
  return arms
    .map((arm) => {
      // Each arm carries its own leading whitespace, so the offset moves with
      // the trim: a record's column must point at the arm, not at the comma
      // before it.
      const lead = arm.text.length - arm.text.trimStart().length;
      return { text: arm.text.trim().replace(/\s+/gu, " "), offset: arm.offset + lead };
    })
    .filter((arm) => arm.text !== "");
}

/**
 * The crate segment a `use` path starts with, or `null` when the path opens
 * with a brace group and names none.
 */
export function useRootSegment(path) {
  const match = /^\s*(?:::\s*)?([A-Za-z_]\w*)/.exec(path);
  return match ? match[1] : null;
}

/**
 * Every source-level crate reference in a `.rs` file, in source order.
 *
 * Four forms, matched separately and then merged: a `use` declaration, an
 * `extern crate`, a fully-qualified `::crate::` path, and — only for crates
 * named in `knownCrates` — a bare `crate_name::item` path written inline with
 * no `use` at all. The forms overlap (`use ::serde::de;` is two of them), so a
 * match inside a range already claimed by a `use` or `extern crate` is dropped
 * rather than recorded twice.
 *
 * **Why the bare form needs the crate list.** Since Rust 2018 a crate can be
 * used with no `use` line anywhere — this workspace's own `main.rs` is exactly
 * that, calling `rba_desktop_lib::run()` and importing nothing. But a bare
 * `Name::item` is far more often a type (`String::from`), an enum
 * (`Ordering::Less`), or a local module, and telling those apart needs the
 * resolver this file exists without. Matching only against crate names the
 * workspace actually declares is what makes the form decidable: the crossing
 * that matters is caught, and no identifier is guessed at. A crate outside the
 * workspace referenced only by a bare path is therefore not recorded here —
 * `resolveRustDependencies` above still reads it from `Cargo.toml`.
 *
 * @param {string} rustText
 * @param {Set<string>} [knownCrates] Crate identifiers the workspace declares.
 * @returns {{ specifier: string, root: string|null, kind: string, offset: number }[]}
 */
export function parseRustUseSites(rustText, knownCrates = new Set()) {
  // A UTF-8 BOM is blanked, not stripped (see the header's byte-tolerance
  // bullet): same length, so every offset below stays an offset into the
  // original, and `^`-anchored forms see a line that starts like any other.
  const source = rustText.replace(/^\uFEFF/, " ");
  const sites = [];
  const claimed = [];

  // `use` opens at a line start, after a same-line `;`/`{`/`}` statement
  // boundary, or after a same-line `#[…]` attribute block — every position
  // Rust allows one. `[{;}]` inside a string or comment can open a spurious
  // match (text the file really contains), never a missed one; the `#[…]`
  // token's content may itself hold a quoted string containing `]`
  // (`#[doc = "see [x]"]`), so it is read past a balanced quoted string
  // rather than stopping at the first `]`. The two alternatives inside that
  // repeated group — a quoted string, or a single non-`]` character — are
  // kept DISJOINT on `"` (the fallback is `[^"\]]`, not `[^\]]`): letting
  // both branches match `"` gives the regex engine two ways to reach the
  // same position for every quote character, and a `.rs` file with many `"`
  // and no closing `]` then backtracks exponentially over that ambiguity
  // (measured: ~285ms at 30 quote characters, seconds at ~50, `.rs` content
  // is attacker-supplied per SECURITY.md). Excluding `"` from the fallback
  // makes the split unambiguous — linear in input length — while still
  // reading the same attribute text: `"` can now only ever be consumed by
  // starting the string branch. The terminating `;` is matched as a
  // lookahead rather than consumed, so it is still there — unclaimed — for a
  // second `use` sharing the same line to open its own match against.
  for (const m of source.matchAll(
    /(?:^|[{;}])[ \t]*(?:(?:#\[(?:"(?:[^"\\]|\\.)*"|[^"\]])*\][ \t]*)+)?(pub(?:\s*\([^)]*\))?[ \t]+)?use[ \t\r\n]+([^;]*)(?=;)/gm,
  )) {
    // The match no longer includes the terminating `;`, so the path starts
    // exactly its own length back from the end.
    const path = m[2];
    const pathOffset = m.index + m[0].length - path.length;
    const lead = path.length - path.trimStart().length;
    // A use path may wrap across lines inside a brace group. The record is
    // printed in `file:line:column: specifier` reports, so line breaks are
    // collapsed — Rust has no single-token module specifier to keep verbatim.
    const specifier = path.trim().replace(/\s+/g, " ");
    const kind = m[1] ? "re-export" : "static";
    // A path opening with a brace group is a LIST of paths, and each arm names
    // its own crate — see `braceGroupArms`. One site per arm, at the arm's own
    // position, so a report sends a reader to the import they have to change.
    // `null` back from the splitter means the text is not a well-formed group,
    // and the single `root: null` site below keeps that loud.
    const arms = braceGroupArms(path);
    if (arms !== null) {
      for (const arm of arms) {
        sites.push({
          specifier: arm.text,
          root: useRootSegment(arm.text),
          kind,
          offset: pathOffset + arm.offset,
        });
      }
      claimed.push([m.index, m.index + m[0].length]);
      continue;
    }
    sites.push({
      specifier,
      root: useRootSegment(path),
      kind,
      offset: pathOffset + lead,
    });
    claimed.push([m.index, m.index + m[0].length]);
  }

  for (const m of source.matchAll(/^[ \t]*(?:pub[ \t]+)?extern[ \t]+crate[ \t]+([A-Za-z_]\w*)/gm)) {
    sites.push({
      specifier: m[1],
      root: m[1],
      kind: "static",
      offset: m.index + m[0].lastIndexOf(m[1]),
    });
    claimed.push([m.index, m.index + m[0].length]);
  }

  const unclaimed = (offset) => !claimed.some(([start, end]) => offset >= start && offset < end);

  for (const m of source.matchAll(/(^|[^:\w])::([A-Za-z_]\w*)::/gm)) {
    const offset = m.index + m[1].length;
    if (!unclaimed(offset)) continue;
    sites.push({ specifier: `::${m[2]}::`, root: m[2], kind: "static", offset });
  }

  if (knownCrates.size > 0) {
    for (const m of source.matchAll(/(^|[^:\w.])([A-Za-z_]\w*)::/gm)) {
      const offset = m.index + m[1].length;
      if (!knownCrates.has(crateIdentifier(m[2])) || !unclaimed(offset)) continue;
      sites.push({ specifier: `${m[2]}::`, root: m[2], kind: "static", offset });
    }
  }

  return sites.sort((a, b) => a.offset - b.offset);
}

/**
 * Analyzes one `.rs` file.
 *
 * `file` is always `null`: a Rust path names an item inside a crate, and which
 * `.rs` file defines it is a question only the compiler's module tree can
 * answer. `crate::`/`self::`/`super::` resolve to the file's own project —
 * intra-project imports are recorded, not dropped (`contract.md`) — and
 * `isOwnProjectPath` above states which spellings reach the file's own project
 * without leaving it, which is the fact the self-circular rule reads.
 *
 * @param {{ sourceFile: string, text: string, workspace: object }} request
 * @returns {{ imports: object[], failures: object[] }}
 */
export function analyzeRust({ sourceFile, text, workspace }) {
  const result = emptyResult();
  try {
    const byCrate = crateNamesOf(workspace);
    const owner = projectOwning(workspace.projects, sourceFile);
    // A rename is legible only inside the project whose OWN manifest declares
    // it — see the header's "A renamed dependency IS followed".
    const ownAliases = owner ? renamedDepsOf(workspace).get(owner.name) : undefined;
    const knownCrates = ownAliases
      ? new Set([...byCrate.keys(), ...ownAliases.keys()])
      : new Set(byCrate.keys());

    for (const site of parseRustUseSites(text, knownCrates)) {
      const { line, column } = positionAt(text, site.offset);
      let resolved = null;
      if (site.root === null) {
        result.failures.push({
          sourceFile,
          line,
          column,
          reason: `'use ${site.specifier}' opens with a brace group, so it names no crate to resolve`,
        });
      } else if (OWN_CRATE_ROOTS.has(site.root)) {
        resolved = {
          target: owner?.name ?? null,
          file: null,
          external: owner === null,
          packageName: null,
        };
      } else {
        const identifier = crateIdentifier(site.root);
        const target = byCrate.get(identifier) ?? ownAliases?.get(identifier) ?? null;
        resolved = {
          target,
          file: null,
          external: target === null,
          // The identifier spelling, which is the only one a source states.
          // A Cargo package name that hyphenates cannot be recovered from it,
          // so a `bannedExternalImports` glob is written against this form.
          packageName: target === null ? site.root : null,
        };
      }
      result.imports.push({
        sourceFile,
        line,
        column,
        specifier: site.specifier,
        kind: site.kind,
        spelling: { path: false, relative: isOwnProjectPath(site.root, owner, byCrate) },
        resolved,
      });
    }
  } catch (cause) {
    result.failures.push(
      fileFailure(sourceFile, `Rust analysis failed: ${cause?.message ?? cause}`),
    );
  }
  return result;
}

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
 * - **`use` is matched at the start of a line** (after optional indentation
 *   and an optional `pub`/`pub(crate)`), read to the first `;`. A `use` inside
 *   a raw string literal that starts its own line would be read; a `use`
 *   preceded on the same line by an attribute or another statement would not.
 *   `rustfmt` produces neither.
 * - **A `use` whose path opens with a brace group** — `use {a::b, c::d};` —
 *   names no crate before the group. It is recorded with `resolved: null` and
 *   a failure, because guessing which of the group's arms was meant is exactly
 *   the guessing the contract forbids; the record is never dropped.
 * - **Uniform paths are ambiguous and resolved toward the crate.** Since Rust
 *   2018, `use foo::Bar` can name either an extern crate `foo` or a local
 *   `mod foo`. A first segment matching another project's crate name is read
 *   as that crate. A local module deliberately named after a sibling crate
 *   would produce a spurious record.
 * - **A renamed dependency is not followed.** `dep = { package = "real" }`
 *   makes the source spell `dep` while the crate is `real`; the manifest
 *   resolver above still draws that edge, so the dependency is never lost —
 *   only its source-level location is.
 * - **`mod` is not an import.** A `mod` declaration names a file inside the
 *   same crate, so it crosses no project boundary and is never recorded.
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
    const manifestPath = `${project.root}/Cargo.toml`;
    if (!filesOf(project.name).includes(manifestPath)) continue;
    const manifest = parseManifest(readFile(manifestPath) ?? "");
    if (!manifest?.package?.name) continue; // workspace-only manifests are not crates
    projectByRoot.set(project.root, project.name);
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
          const wsSpec = workspace.value?.manifest.workspace?.dependencies?.[depName];
          if (typeof wsSpec?.path === "string") {
            pathDir = normalizePath(workspace.value.dir, wsSpec.path);
          }
        }
        if (!pathDir) continue;
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
  const sites = [];
  const claimed = [];

  for (const m of rustText.matchAll(
    /^[ \t]*(pub(?:\s*\([^)]*\))?[ \t]+)?use[ \t\r\n]+([^;]*);/gm,
  )) {
    // The whole match ends with the `;` that closed it, so the path starts
    // exactly its own length plus that one character back from the end.
    const path = m[2];
    const pathOffset = m.index + m[0].length - 1 - path.length;
    const lead = path.length - path.trimStart().length;
    // A use path may wrap across lines inside a brace group. The record is
    // printed in `file:line:column: specifier` reports, so line breaks are
    // collapsed — Rust has no single-token module specifier to keep verbatim.
    const specifier = path.trim().replace(/\s+/g, " ");
    sites.push({
      specifier,
      root: useRootSegment(path),
      kind: m[1] ? "re-export" : "static",
      offset: pathOffset + lead,
    });
    claimed.push([m.index, m.index + m[0].length]);
  }

  for (const m of rustText.matchAll(
    /^[ \t]*(?:pub[ \t]+)?extern[ \t]+crate[ \t]+([A-Za-z_]\w*)/gm,
  )) {
    sites.push({
      specifier: m[1],
      root: m[1],
      kind: "static",
      offset: m.index + m[0].lastIndexOf(m[1]),
    });
    claimed.push([m.index, m.index + m[0].length]);
  }

  const unclaimed = (offset) => !claimed.some(([start, end]) => offset >= start && offset < end);

  for (const m of rustText.matchAll(/(^|[^:\w])::([A-Za-z_]\w*)::/gm)) {
    const offset = m.index + m[1].length;
    if (!unclaimed(offset)) continue;
    sites.push({ specifier: `::${m[2]}::`, root: m[2], kind: "static", offset });
  }

  if (knownCrates.size > 0) {
    for (const m of rustText.matchAll(/(^|[^:\w.])([A-Za-z_]\w*)::/gm)) {
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

    for (const site of parseRustUseSites(text, new Set(byCrate.keys()))) {
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
        const target = byCrate.get(crateIdentifier(site.root)) ?? null;
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

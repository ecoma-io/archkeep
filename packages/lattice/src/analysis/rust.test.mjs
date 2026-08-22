import { describe, expect, it } from "vitest";

import {
  analyzeRust,
  crateIdentifier,
  crateImportName,
  parseRustUseSites,
  resolveRustDependencies,
  useRootSegment,
} from "./rust.mjs";

describe("resolveRustDependencies", () => {
  const projects = [
    { name: "alpha", root: "acme/libs/alpha" },
    { name: "beta", root: "acme/libs/beta" },
  ];
  const files = {
    alpha: ["acme/libs/alpha/Cargo.toml"],
    beta: ["acme/libs/beta/Cargo.toml"],
  };
  const filesOf = (name) => files[name] ?? [];

  it("draws an edge for a path dependency, from any dependency section", () => {
    const contents = {
      "acme/libs/alpha/Cargo.toml": [
        '[package]\nname = "alpha"\nversion = "0.1.0"',
        '[dev-dependencies]\nbeta = { path = "../beta" }',
        '[dependencies]\nserde = "1"',
      ].join("\n\n"),
      "acme/libs/beta/Cargo.toml": '[package]\nname = "beta"\nversion = "0.1.0"\n',
    };
    expect(resolveRustDependencies(projects, filesOf, (p) => contents[p] ?? null)).toEqual([
      {
        source: "alpha",
        target: "beta",
        sourceFile: "acme/libs/alpha/Cargo.toml",
        type: "static",
      },
    ]);
  });

  it("resolves `workspace = true` through the nearest ancestor [workspace] manifest", () => {
    const contents = {
      "acme/Cargo.toml": [
        "[workspace]",
        'members = ["libs/alpha", "libs/beta"]',
        "[workspace.dependencies]",
        'beta = { path = "libs/beta" }',
      ].join("\n"),
      "acme/libs/alpha/Cargo.toml": [
        '[package]\nname = "alpha"\nversion = "0.1.0"',
        "[dependencies]\nbeta = { workspace = true }",
      ].join("\n\n"),
      "acme/libs/beta/Cargo.toml": '[package]\nname = "beta"\nversion = "0.1.0"\n',
    };
    expect(resolveRustDependencies(projects, filesOf, (p) => contents[p] ?? null)).toEqual([
      {
        source: "alpha",
        target: "beta",
        sourceFile: "acme/libs/alpha/Cargo.toml",
        type: "static",
      },
    ]);
  });

  it("ignores registry dependencies and workspace-only manifests", () => {
    const contents = {
      "acme/libs/alpha/Cargo.toml": [
        '[package]\nname = "alpha"\nversion = "0.1.0"',
        '[dependencies]\nserde = "1"\ntokio = { version = "1", features = ["full"] }',
      ].join("\n\n"),
      "acme/libs/beta/Cargo.toml": "[workspace]\nmembers = []\n", // no [package]
    };
    expect(resolveRustDependencies(projects, filesOf, (p) => contents[p] ?? null)).toEqual([]);
  });

  it("draws target-specific dependencies too", () => {
    const contents = {
      "acme/libs/alpha/Cargo.toml": [
        '[package]\nname = "alpha"\nversion = "0.1.0"',
        '[target."cfg(unix)".dependencies]\nbeta = { path = "../beta" }',
      ].join("\n\n"),
      "acme/libs/beta/Cargo.toml": '[package]\nname = "beta"\nversion = "0.1.0"\n',
    };
    expect(resolveRustDependencies(projects, filesOf, (p) => contents[p] ?? null)).toHaveLength(1);
  });

  it("resolves `workspace = true` against a workspace manifest at the tree root, one lookup for the crate", () => {
    // The ancestor walk runs to the filesystem root (a `dir` of `""`), which
    // is where this fixture's [workspace] sits. Three workspace deps on one
    // crate also pin the lazy-lookup half: the manifest is read once, and the
    // second and third deps reuse the answer. Two of the deps must produce no
    // edge at all — a dependency on the crate's OWN root (Cargo would call
    // that a cycle) and a workspace dep declared without a path, which no
    // filesystem target can be recovered from.
    const contents = {
      "Cargo.toml": [
        "[workspace]",
        'members = ["libs/alpha", "libs/beta", "libs/gamma"]',
        "[workspace.dependencies]",
        'alpha = { path = "libs/alpha" }',
        'beta = "2.0"',
        'gamma = { path = "libs/gamma" }',
      ].join("\n"),
      "libs/alpha/Cargo.toml": [
        '[package]\nname = "alpha"\nversion = "0.1.0"',
        "[dependencies]",
        "alpha = { workspace = true }",
        "beta = { workspace = true }",
        "gamma = { workspace = true }",
      ].join("\n"),
      "libs/beta/Cargo.toml": '[package]\nname = "beta"\nversion = "0.1.0"\n',
      "libs/gamma/Cargo.toml": '[package]\nname = "gamma"\nversion = "0.1.0"\n',
    };
    const rootProjects = [
      { name: "alpha", root: "libs/alpha" },
      { name: "beta", root: "libs/beta" },
      { name: "gamma", root: "libs/gamma" },
    ];
    const roots = { alpha: "libs/alpha", beta: "libs/beta", gamma: "libs/gamma" };
    const filesOfRoot = (name) => (roots[name] ? [`${roots[name]}/Cargo.toml`] : []);
    expect(resolveRustDependencies(rootProjects, filesOfRoot, (p) => contents[p] ?? null)).toEqual([
      {
        source: "alpha",
        target: "gamma",
        sourceFile: "libs/alpha/Cargo.toml",
        type: "static",
      },
    ]);
  });

  it("draws no edge when `workspace = true` names a dep but no workspace manifest exists above", () => {
    // The walk runs out of ancestors: the root read comes back empty, so the
    // workspace resolution is `null` — no manifest, no declaration, no edge.
    // The dep must then be skipped, not guessed at.
    const contents = {
      "acme/libs/alpha/Cargo.toml": [
        '[package]\nname = "alpha"\nversion = "0.1.0"',
        "[dependencies]\nbeta = { workspace = true }",
      ].join("\n\n"),
      "acme/libs/beta/Cargo.toml": '[package]\nname = "beta"\nversion = "0.1.0"\n',
    };
    expect(resolveRustDependencies(projects, filesOf, (p) => contents[p] ?? null)).toEqual([]);
  });

  it("skips a crate whose manifest is listed but cannot be read", () => {
    // `filesOf` names the manifest; `readFile` cannot produce it (a file
    // deleted between the listing and the read). The crate must not be
    // guessed into existence, and the run must not throw.
    const contents = {
      "acme/libs/alpha/Cargo.toml": [
        '[package]\nname = "alpha"\nversion = "0.1.0"',
        '[dependencies]\nbeta = { path = "../beta" }',
      ].join("\n\n"),
      "acme/libs/beta/Cargo.toml": '[package]\nname = "beta"\nversion = "0.1.0"\n',
    };
    const withGhost = [...projects, { name: "ghost", root: "acme/libs/ghost" }];
    const filesOfGhost = (name) =>
      name === "ghost" ? ["acme/libs/ghost/Cargo.toml"] : filesOf(name);
    expect(resolveRustDependencies(withGhost, filesOfGhost, (p) => contents[p] ?? null)).toEqual([
      {
        source: "alpha",
        target: "beta",
        sourceFile: "acme/libs/alpha/Cargo.toml",
        type: "static",
      },
    ]);
  });

  it("draws edges in both directions when a project sits at the workspace root", () => {
    // Two silent-miss directions in one fixture. Before the fix: (1) the root
    // project's own manifest was looked up as `${"" }/Cargo.toml` = "/Cargo.toml"
    // (a leading slash), which matches no entry `filesOf` ever lists — the root
    // project was never even added to `crates`/`projectByRoot`, so BOTH edges
    // below would vanish, not just one. (2) even with that fixed, a dependency
    // FROM the nested project INTO the root project resolves `pathDir` to `""`
    // via `normalizePath`, which the old `if (!pathDir) continue;` guard read as
    // "no target" and dropped — the other direction of a root-project edge.
    const rootProjects = [
      { name: "root", root: "" },
      { name: "leaf", root: "libs/leaf" },
    ];
    const rootFiles = { root: ["Cargo.toml"], leaf: ["libs/leaf/Cargo.toml"] };
    const rootFilesOf = (name) => rootFiles[name] ?? [];
    const rootContents = {
      "Cargo.toml":
        '[package]\nname = "root_crate"\nversion = "0.1.0"\n\n[dependencies]\n' +
        'leaf = { path = "libs/leaf" }\n',
      "libs/leaf/Cargo.toml":
        '[package]\nname = "leaf"\nversion = "0.1.0"\n\n[dependencies]\n' +
        'root_crate = { path = "../.." }\n',
    };
    expect(
      resolveRustDependencies(rootProjects, rootFilesOf, (p) => rootContents[p] ?? null),
    ).toEqual(
      expect.arrayContaining([
        { source: "root", target: "leaf", sourceFile: "Cargo.toml", type: "static" },
        {
          source: "leaf",
          target: "root",
          sourceFile: "libs/leaf/Cargo.toml",
          type: "static",
        },
      ]),
    );
    expect(
      resolveRustDependencies(rootProjects, rootFilesOf, (p) => rootContents[p] ?? null),
    ).toHaveLength(2);
  });

  it("draws edges in both directions when the root project uses Nx's `.` spelling", () => {
    // The production spelling, and the ONLY one that reaches this resolver
    // from a real Nx graph — `""` above is a fixture convenience, never what
    // Nx actually sends. Before the fix, `projectByRoot` was keyed on the RAW
    // `project.root`, so it held `"."` while a dependency pointing AT the
    // root normalizes `pathDir` to `""` (via `normalizePath`) — `"." !== ""`,
    // so `projectByRoot.get("")` missed and the leaf→root edge (and, by the
    // same map, any `root→leaf` lookup keyed the other way) vanished
    // silently. `projectByRoot` is now keyed by the NORMALIZED root, so both
    // spellings land on the same key.
    const dotProjects = [
      { name: "root", root: "." },
      { name: "leaf", root: "libs/leaf" },
    ];
    const dotFiles = { root: ["Cargo.toml"], leaf: ["libs/leaf/Cargo.toml"] };
    const dotFilesOf = (name) => dotFiles[name] ?? [];
    const dotContents = {
      "Cargo.toml":
        '[package]\nname = "root_crate"\nversion = "0.1.0"\n\n[dependencies]\n' +
        'leaf = { path = "libs/leaf" }\n',
      "libs/leaf/Cargo.toml":
        '[package]\nname = "leaf"\nversion = "0.1.0"\n\n[dependencies]\n' +
        'root_crate = { path = "../.." }\n',
    };
    expect(resolveRustDependencies(dotProjects, dotFilesOf, (p) => dotContents[p] ?? null)).toEqual(
      expect.arrayContaining([
        { source: "root", target: "leaf", sourceFile: "Cargo.toml", type: "static" },
        {
          source: "leaf",
          target: "root",
          sourceFile: "libs/leaf/Cargo.toml",
          type: "static",
        },
      ]),
    );
    expect(
      resolveRustDependencies(dotProjects, dotFilesOf, (p) => dotContents[p] ?? null),
    ).toHaveLength(2);
  });
});

describe("crate naming", () => {
  it("spells a package name the way a source file has to", () => {
    // Cargo's own rule: the identifier a `use` writes replaces `-` and `.`.
    // Matching the two spellings by string equality misses every hyphenated
    // crate in the workspace, which is most of them.
    expect(crateIdentifier("engine-core")).toBe("engine_core");
    expect(crateImportName({ package: { name: "engine-core" } })).toBe("engine_core");
  });

  it("lets [lib] name override the package name, because only that spelling compiles", () => {
    // The shape Tauri prescribes: a desktop package renames its library crate,
    // and its own `main.rs` can spell nothing else.
    expect(
      crateImportName({ package: { name: "desktop-shell" }, lib: { name: "desktop_shell_lib" } }),
    ).toBe("desktop_shell_lib");
  });

  it("names no crate for a workspace-only manifest", () => {
    expect(crateImportName({ workspace: { members: [] } })).toBeNull();
    expect(crateImportName(null)).toBeNull();
  });
});

describe("useRootSegment", () => {
  it("reads the crate the path starts with, with or without a leading ::", () => {
    expect(useRootSegment("serde::de::Deserialize")).toBe("serde");
    expect(useRootSegment("::serde::de")).toBe("serde");
    expect(useRootSegment(" engine_core::{a, b}")).toBe("engine_core");
  });

  it("names none when the path opens with a brace group", () => {
    expect(useRootSegment("{std::fmt, std::io}")).toBeNull();
  });
});

describe("parseRustUseSites", () => {
  it("reads a first-line use and a first-line extern crate behind a UTF-8 BOM (#221)", () => {
    // Issue #221's Rust half: every anchor here is `^` or a character class
    // the BOM fails, so both first-line forms produced no record at all —
    // gone with no failure beside them. The offset must slice its crate name
    // out of the ORIGINAL text: the BOM is blanked to one space, never
    // stripped, so nothing after it moves.
    const source = "\uFEFFuse engine_core::task::Task;\n";
    const sites = parseRustUseSites(source);
    expect(sites.map((site) => [site.root, site.specifier])).toEqual([
      ["engine_core", "engine_core::task::Task"],
    ]);
    expect(source.slice(sites[0].offset, sites[0].offset + "engine_core".length)).toBe(
      "engine_core",
    );

    const extern = "\uFEFFextern crate legacy_crate;\n";
    const externSites = parseRustUseSites(extern);
    expect(externSites.map((site) => site.root)).toEqual(["legacy_crate"]);
    expect(extern.slice(externSites[0].offset)).toMatch(/^legacy_crate/);
  });

  it("reads a use, a pub use, an extern crate and an inline ::path", () => {
    const source = [
      "use engine_core::Task;", // 1
      "pub use engine_core::Role;", // 2
      "extern crate legacy_crate;", // 3
      "fn f() { let x = <T as ::other_crate::Trait>::go(); }", // 4
    ].join("\n");
    expect(
      parseRustUseSites(source).map((site) => `${site.kind} ${site.root} ${site.specifier}`),
    ).toEqual([
      "static engine_core engine_core::Task",
      "re-export engine_core engine_core::Role",
      "static legacy_crate legacy_crate",
      "static other_crate ::other_crate::",
    ]);
  });

  it("collapses a use path that wraps across lines so a report can print it", () => {
    const source = "use engine_core::{\n    task::Task,\n    role::Role,\n};\n";
    const [site] = parseRustUseSites(source);
    expect(site.specifier).toBe("engine_core::{ task::Task, role::Role, }");
    expect(site.root).toBe("engine_core");
  });

  it("does not read a use inside a line comment or a doc comment", () => {
    expect(parseRustUseSites("// use fake_crate::X;\n/// use other::Y;\n")).toEqual([]);
  });

  it("never records a mod declaration, which names a file in the same crate", () => {
    expect(parseRustUseSites("mod tests;\npub mod inner { }\n")).toEqual([]);
  });

  it("records an inline ::path only when no use already claimed it", () => {
    // `use ::serde::de;` is both forms at once; recording it twice would
    // double every such import in a report.
    expect(parseRustUseSites("use ::serde::de::Error;\n")).toHaveLength(1);
  });

  it("finds a bare crate path only for crates the workspace declares", () => {
    // Since Rust 2018 a crate can be used with no `use` anywhere — this
    // workspace's own `main.rs` is exactly that. But a bare `Name::item` is
    // far more often a type or an enum, so only declared crate names are read.
    const source = 'fn main() {\n    let s = String::from("x");\n    rba_desktop_lib::run();\n}\n';
    expect(parseRustUseSites(source)).toEqual([]);
    const withCrates = parseRustUseSites(source, new Set(["rba_desktop_lib"]));
    expect(withCrates.map((site) => site.root)).toEqual(["rba_desktop_lib"]);
  });

  it("reports positions at the crate segment, in source order", () => {
    const source = "fn f() {}\n\n    use engine_core::Task;\n";
    const [site] = parseRustUseSites(source);
    expect(source.slice(site.offset)).toBe("engine_core::Task;\n");
  });

  it("reads a use that shares its line with a same-line attribute (D-08), as the full specifier", () => {
    // The silent-miss directions of WSX-D08: before the fix, a same-line
    // `#[cfg(...)] use b::helper;` was excluded by the line anchor and the
    // bare-crate fallback claimed a truncated `b::` — a record naming text the
    // file does not contain.
    const source = '#[cfg(feature = "net")] use b::helper;\n';
    expect(parseRustUseSites(source, new Set(["b"])).map((site) => site.specifier)).toEqual([
      "b::helper",
    ]);
  });

  it("reads a use that follows a statement on the same line (C-03), for a crate the workspace does not declare", () => {
    // The silent direction of C-03: before the fix, a `; use` after a statement
    // vanished with no record and no failure at all. `inner` is not a known
    // crate, so the bare-form fallback cannot have been the source of the
    // record either — only the `use` pass itself.
    const source = "pub fn f(){}; use inner::Thing;\n";
    const sites = parseRustUseSites(source, new Set());
    expect(sites.map((site) => site.specifier)).toEqual(["inner::Thing"]);
    expect(sites[0].root).toBe("inner");
  });

  it("reads a use inside a function body, preceded by `{` (C-03)", () => {
    const source = 'fn main() { println!("hi"); use inner::Thing; }\n';
    expect(parseRustUseSites(source).map((site) => site.specifier)).toEqual(["inner::Thing"]);
  });

  it("does not let a string literal that is not a use create a record (C-03)", () => {
    // The same-line statement boundary only opens a `use`; text after a `{` or
    // `;` that merely calls a method must not be read as one.
    const source = "fn main() { let s = f(); s.trim(); }\n";
    expect(parseRustUseSites(source)).toEqual([]);
  });

  it("reads a second (and third) use sharing the same line", () => {
    // The silent-miss direction: before the fix, the main `use` regex
    // consumed the terminating `;`, so `matchAll` resumed past it and the
    // next `use` had no `(?:^|[{;}])` anchor left to open on — only the
    // first `use` on the line was ever recorded.
    const source = "use aaa::x; use bbb::y; use ccc::z;\n";
    expect(parseRustUseSites(source).map((site) => site.specifier)).toEqual([
      "aaa::x",
      "bbb::y",
      "ccc::z",
    ]);
  });

  it("reads a use behind a same-line attribute whose own content holds a bracketed string", () => {
    // The silent-miss direction: `#\[[^\]]*\]` stopped at the FIRST `]`, which
    // a quoted string inside the attribute can supply before the attribute's
    // own closing bracket — dropping the `use` entirely, with no record and
    // no failure.
    const source = '#[doc = "see [link]"] use aaa::x;\n';
    expect(parseRustUseSites(source).map((site) => site.specifier)).toEqual(["aaa::x"]);
  });

  it("returns promptly on a quote-heavy same-line attribute with no closing bracket (ReDoS)", () => {
    // `.rs` file contents are attacker-supplied per SECURITY.md. The quote-
    // aware attribute pattern's two branches — a quoted string, or a single
    // non-`]` character — used to overlap on `"` (`[^\]]` also matches `"`),
    // giving the regex engine two ways to reach the same position for every
    // quote character; with no closing `]` ever arriving, that ambiguity
    // backtracks exponentially (measured on the pre-fix pattern: ~285ms at 30
    // quote characters, seconds at ~50, unusable well before 2000). The
    // fallback now excludes `"` (`[^"\]]`), so `"` can only start the string
    // branch and the match is linear. This must return in well under a
    // second, not merely "eventually".
    const start = Date.now();
    const pathological = `#[${'"'.repeat(2000)}\n`;
    parseRustUseSites(pathological);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("analyzeRust", () => {
  const workspace = {
    root: "/w",
    projects: [
      { name: "core", root: "acme/libs/core" },
      { name: "shell", root: "acme/apps/shell" },
    ],
    filesOf: (name) =>
      ({
        core: ["acme/libs/core/Cargo.toml", "acme/libs/core/src/lib.rs"],
        // The Tauri layout: the crate is NOT at the project root.
        shell: ["acme/apps/shell/src-tauri/Cargo.toml", "acme/apps/shell/src-tauri/src/main.rs"],
      })[name] ?? [],
    readFile: (path) =>
      ({
        "acme/libs/core/Cargo.toml": '[package]\nname = "engine-core"\nversion = "0.1.0"\n',
        "acme/apps/shell/src-tauri/Cargo.toml":
          '[package]\nname = "shell"\nversion = "0.1.0"\n[lib]\nname = "shell_lib"\n',
      })[path] ?? null,
  };
  const analyze = (text, sourceFile = "acme/apps/shell/src-tauri/src/main.rs") =>
    analyzeRust({ sourceFile, text, workspace });

  it("crosses a boundary written after a statement on the same line (C-03)", () => {
    // The silent-miss direction: before the fix, a `; use` after a statement
    // produced no record and no failure — the crossing reported exactly like a
    // clean file, even with the crate declared.
    const { imports, failures } = analyze("pub fn f(){}; use engine_core::task::Task;\n");
    expect(failures).toEqual([]);
    expect(imports[0].resolved.target).toBe("core");
    expect(imports[0].specifier).toBe("engine_core::task::Task");
  });

  it("crosses a boundary written behind a UTF-8 BOM on the file's first line (#221)", () => {
    // The silent-miss direction for issue #221: the BOM failed every anchor,
    // so a first-line `use` of a declared crate recorded nothing and the
    // crossing reported exactly like a clean file. The column is what an
    // editor shows for this text: the BOM occupies column 1, `use ` columns
    // 2–5, and the path starts at column 6.
    const { imports, failures } = analyze("\uFEFFuse engine_core::task::Task;\n");
    expect(failures).toEqual([]);
    expect(imports[0].specifier).toBe("engine_core::task::Task");
    expect(imports[0].resolved.target).toBe("core");
    expect(imports[0]).toMatchObject({ line: 1, column: 6 });
  });

  it("crosses a boundary written behind a same-line attribute, with the full specifier (D-08)", () => {
    // D-08's truncation: before the fix, the same-line `#[cfg] use` was line-
    // anchored out and the bare fallback read `engine_core::` — a record naming
    // text the file does not contain. The record must name the full path.
    const { imports, failures } = analyze('#[cfg(feature = "net")] use engine_core::task::Task;\n');
    expect(failures).toEqual([]);
    expect(imports[0].resolved.target).toBe("core");
    expect(imports[0].specifier).toBe("engine_core::task::Task");
  });

  it("resolves a hyphenated package to the project a source spells with underscores", () => {
    // `engine-core` in Cargo.toml, `engine_core` in every `.rs` file. A
    // resolver that compares the two literally finds nothing at all.
    const { imports, failures } = analyze("use engine_core::task::Task;\n");
    expect(failures).toEqual([]);
    expect(imports[0]).toEqual({
      sourceFile: "acme/apps/shell/src-tauri/src/main.rs",
      line: 1,
      column: 5,
      specifier: "engine_core::task::Task",
      kind: "static",
      spelling: { path: false, relative: false },
      resolved: { target: "core", file: null, external: false, packageName: null },
    });
  });

  it("resolves a crate through its [lib] name, which is the only spelling that compiles", () => {
    const { imports } = analyze("fn main() {\n    shell_lib::run();\n}\n");
    expect(imports[0].resolved.target).toBe("shell");
  });

  it("finds the crate even though its manifest sits below the project root", () => {
    // The graph resolver models one manifest per project root and so draws no
    // edge for this project. Analysis attributes a file, so it sees the crate
    // — the two disagree here deliberately, and this pins which way.
    expect(
      resolveRustDependencies(workspace.projects, workspace.filesOf, workspace.readFile),
    ).toEqual([]);
    expect(analyze("use shell_lib::run;\n").imports[0].resolved.target).toBe("shell");
  });

  it("resolves crate::, self:: and super:: to the file's own project", () => {
    const { imports } = analyze("use crate::a::B;\nuse self::c::D;\nuse super::e::F;\n");
    expect(imports.map((record) => record.resolved.target)).toEqual(["shell", "shell", "shell"]);
    expect(imports.every((record) => record.resolved.external === false)).toBe(true);
  });

  it("calls crate::, self:: and super:: relative, which is what they are in Rust", () => {
    // `spelling.relative` is what keeps `noSelfCircularDependencies` off these,
    // and the rules layer cannot work it out: it used to test `.`, `..`, `./`
    // and `../`, which is JavaScript's shape and none of these.
    const { imports } = analyze("use crate::a::B;\nuse self::c::D;\nuse super::e::F;\n");
    expect(imports.map((record) => record.spelling)).toEqual([
      { path: false, relative: true },
      { path: false, relative: true },
      { path: false, relative: true },
    ]);
  });

  it("calls a crate the file's OWN project declares relative, because Cargo has no other spelling", () => {
    // A binary reaching its package's library crate — `shell_lib`, renamed by
    // `[lib] name` so no other spelling exists at all. Nx models the package as
    // one project, so source and target are the same node; Cargo compiles two
    // crates and its graph cannot cycle, so this is not the round trip out
    // through a public alias that the self-circular rule names.
    expect(analyze("fn main() {\n    shell_lib::run();\n}\n").imports[0].spelling).toEqual({
      path: false,
      relative: true,
    });
  });

  it("calls another project's crate neither relative nor a path", () => {
    // The near miss: same syntax, same `::` separator, a different project. And
    // no `use` path is ever a filesystem path, in any of these cases.
    expect(analyze("use engine_core::task::Task;\n").imports[0].spelling).toEqual({
      path: false,
      relative: false,
    });
    expect(analyze("use serde::de::Deserialize;\n").imports[0].spelling).toEqual({
      path: false,
      relative: false,
    });
  });

  it("calls a crate named from a file no project owns neither, having no own project to match", () => {
    // `owner` is null here and `byCrate.get(...)` is undefined; reading the two
    // as equal would make every loose `.rs` file in the tree call every crate
    // its own.
    const { imports } = analyze("use shell_lib::run;\n", "loose/script.rs");
    expect(imports[0].spelling).toEqual({ path: false, relative: false });
  });

  it("keeps crate::, self:: and super:: from a file no project owns as external", () => {
    // The relative forms are relative BY SPELLING — a loose file using them
    // resolves to no project at all, and must be marked external rather than
    // guessed into one. `owner?.name` is null here, which is the case that
    // decides the answer.
    const { imports } = analyze(
      "use crate::a::B;\nuse self::c::D;\nuse super::e::F;\n",
      "loose/script.rs",
    );
    expect(imports.map((record) => record.resolved)).toEqual([
      { target: null, file: null, external: true, packageName: null },
      { target: null, file: null, external: true, packageName: null },
      { target: null, file: null, external: true, packageName: null },
    ]);
  });

  it("marks an unknown crate external and names it in the spelling a source can write", () => {
    const { imports } = analyze("use serde::de::Deserialize;\nuse std::fmt;\n");
    expect(imports.map((record) => record.resolved)).toEqual([
      { target: null, file: null, external: true, packageName: "serde" },
      { target: null, file: null, external: true, packageName: "std" },
    ]);
  });

  it("keeps a pub use as a re-export, which builds a crate's public surface", () => {
    const { imports } = analyze("pub use engine_core::Task;\n");
    expect(imports[0].kind).toBe("re-export");
    expect(imports[0].resolved.target).toBe("core");
  });

  it("reads a brace-group use as the list of paths it is, one record per arm", () => {
    // `use {a::b, c::d};` means exactly `use a::b; use c::d;` — nothing about
    // it is ambiguous, and reading it as "names no crate" cost every arm its
    // record. Each arm resolves on its own, and the columns point at the arms
    // rather than at the statement, so a report sends a reader to the import
    // they have to change.
    const source = "use {engine_core::Task, serde::de};\n";
    const { imports, failures } = analyze(source);
    expect(failures).toEqual([]);
    expect(imports.map((record) => record.specifier)).toEqual(["engine_core::Task", "serde::de"]);
    expect(imports.map((record) => record.resolved.target)).toEqual(["core", null]);
    expect(imports.map((record) => record.column)).toEqual([
      source.indexOf("engine_core::Task") + 1,
      source.indexOf("serde::de") + 1,
    ]);
  });

  it("splits a brace group at its TOP level only, so a nested group stays one arm", () => {
    // A comma-split would read `{a::{b, c}, d::e}` as three arms and invent a
    // crate named `c`. Depth is what keeps the record count honest.
    const { imports, failures } = analyze("use {engine_core::{Task, Job}, serde::de};\n");
    expect(failures).toEqual([]);
    expect(imports.map((record) => record.specifier)).toEqual([
      "engine_core::{Task, Job}",
      "serde::de",
    ]);
  });

  it("collapses a brace group written across lines, at the arm's own position", () => {
    const source = "use {\n  engine_core::Task,\n  serde::de,\n};\n";
    const { imports, failures } = analyze(source);
    expect(failures).toEqual([]);
    expect(imports.map((record) => [record.line, record.specifier])).toEqual([
      [2, "engine_core::Task"],
      [3, "serde::de"],
    ]);
  });

  it("keeps the loud answer for text that is not a well-formed group", () => {
    // The red direction of the split. Braces that do not balance are not a
    // list this reader can split, and half-reading one would be the guessing
    // the contract forbids — so the older answer stands: one record with
    // `resolved: null` and a failure beside it, never a dropped record.
    const { imports, failures } = analyze("use {engine_core::Task, serde::de\n;\n");
    expect(imports[0].resolved).toBeNull();
    expect(failures[0].reason).toMatch(/opens with a brace group/u);
  });

  it("keeps a pub use's re-export kind on every arm of a group", () => {
    const { imports } = analyze("pub use {engine_core::Task, serde::de};\n");
    expect(imports.map((record) => record.kind)).toEqual(["re-export", "re-export"]);
  });

  it("reads nested manifests, and keeps one that is not a crate out of the crate map", () => {
    // `trackedManifests` is deliberately broader than the edge resolver: a
    // crate nested inside a project still belongs to it. Two nested shapes
    // must contribute nothing: a `[workspace]`-only manifest (a workspace
    // inside a project names no crate) and a listed manifest that cannot be
    // read, which must not be parsed as the empty string.
    const deep = {
      ...workspace,
      filesOf: (name) =>
        ({
          core: [
            "acme/libs/core/Cargo.toml",
            "acme/libs/core/vendor/Cargo.toml",
            "acme/libs/core/gone/Cargo.toml",
            "acme/libs/core/src/lib.rs",
          ],
          shell: ["acme/apps/shell/src-tauri/Cargo.toml", "acme/apps/shell/src-tauri/src/main.rs"],
        })[name] ?? [],
      readFile: (path) =>
        ({
          "acme/libs/core/Cargo.toml": '[package]\nname = "engine-core"\nversion = "0.1.0"\n',
          "acme/libs/core/vendor/Cargo.toml": "[workspace]\nmembers = []\n",
          "acme/apps/shell/src-tauri/Cargo.toml":
            '[package]\nname = "shell"\nversion = "0.1.0"\n[lib]\nname = "shell_lib"\n',
        })[path] ?? null,
    };
    const { imports } = analyzeRust({
      sourceFile: "acme/apps/shell/src-tauri/src/main.rs",
      text: "use vendor_crate::item;\nuse engine_core::task::Task;\n",
      workspace: deep,
    });
    // `vendor_crate` names no crate the workspace declares, so the bare and
    // use-site spellings stay external — the workspace manifest inside the
    // project never entered the map. The declared crate still does.
    expect(imports.map((record) => record.resolved)).toEqual([
      { target: null, file: null, external: true, packageName: "vendor_crate" },
      { target: "core", file: null, external: false, packageName: null },
    ]);
  });

  it("reports a banned import that follows another use on the same line", () => {
    // analyzeRust-level silent-miss: with the pre-fix regex, only the first
    // `use` on a shared line was ever recorded, so a rule checking
    // `bannedExternalImports` against `banned_ffi` would see nothing at all
    // for a file that plainly imports it — an enforcement gap indistinguishable
    // from a clean file.
    const { imports, failures } = analyze("use std::fmt; use banned_ffi::raw;\n");
    expect(failures).toEqual([]);
    expect(imports.map((record) => record.specifier)).toEqual(["std::fmt", "banned_ffi::raw"]);
    expect(imports[1].resolved).toEqual({
      target: null,
      file: null,
      external: true,
      packageName: "banned_ffi",
    });
  });

  it("returns an envelope rather than throwing when the workspace misbehaves", () => {
    const hostile = {
      ...workspace,
      filesOf: () => {
        throw new Error("graph unavailable");
      },
    };
    const result = analyzeRust({ sourceFile: "a/b.rs", text: "use x::Y;", workspace: hostile });
    expect(result.imports).toEqual([]);
    expect(result.failures[0].reason).toMatch(/graph unavailable/);
  });

  it("keeps returning an envelope when the workspace throws something that is not an Error", () => {
    // A thrown string carries no `message`; the fallback must still land in a
    // failure record rather than a crash.
    const hostile = {
      ...workspace,
      filesOf: () => {
        throw "graph unavailable";
      },
    };
    const result = analyzeRust({ sourceFile: "a/b.rs", text: "use x::Y;", workspace: hostile });
    expect(result.failures[0].reason).toBe("Rust analysis failed: graph unavailable");
  });
});

describe('analyzeRust — a dependency renamed via `package = "…"`', () => {
  const workspace = {
    root: "/w",
    projects: [
      { name: "engine", root: "acme/libs/engine" },
      { name: "other", root: "acme/libs/other" },
      { name: "app", root: "acme/apps/app" },
    ],
    filesOf: (name) =>
      ({
        engine: ["acme/libs/engine/Cargo.toml"],
        other: ["acme/libs/other/Cargo.toml"],
        app: ["acme/apps/app/Cargo.toml", "acme/apps/app/src/main.rs"],
      })[name] ?? [],
    readFile: (path) =>
      ({
        "acme/libs/engine/Cargo.toml": '[package]\nname = "engine"\nversion = "0.1.0"\n',
        "acme/libs/other/Cargo.toml": '[package]\nname = "other"\nversion = "0.1.0"\n',
        "acme/apps/app/Cargo.toml":
          '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\n' +
          'dep = { package = "engine", path = "../../libs/engine" }\n',
      })[path] ?? null,
  };
  const analyze = (text) =>
    analyzeRust({ sourceFile: "acme/apps/app/src/main.rs", text, workspace });

  it("crosses a boundary written under the renamed local identifier, via `use`", () => {
    // The silent-miss direction: before the fix, `dep` matched no known crate
    // and the record came back `external: true` naming `dep` — a real
    // cross-project dependency reporting as if it were a registry package,
    // with no failure marking the blind spot either.
    expect(
      resolveRustDependencies(workspace.projects, workspace.filesOf, workspace.readFile),
    ).toEqual([
      { source: "app", target: "engine", sourceFile: "acme/apps/app/Cargo.toml", type: "static" },
    ]);
    const { imports, failures } = analyze("use dep::widget;\n");
    expect(failures).toEqual([]);
    expect(imports[0].resolved).toEqual({
      target: "engine",
      file: null,
      external: false,
      packageName: null,
    });
  });

  it("crosses the same boundary written bare, with no `use` at all", () => {
    // Since Rust 2018 a crate needs no `use` line anywhere; the rename has to
    // be legible to the bare-path form too, the same as any other known crate.
    const { imports, failures } = analyze("fn main() {\n    dep::widget();\n}\n");
    expect(failures).toEqual([]);
    expect(imports[0].resolved.target).toBe("engine");
  });

  it("crosses the boundary when a workspace dep is inherited under an alias (C-02)", () => {
    // The C-02 silent-miss: the workspace table keys its entries by the member's
    // LOCAL name — `as_real = { path = "libs/real", package = "real" }` — so the
    // inherited member entry carries NO `package` key at all
    // (`as_real = { workspace = true }`; measured against cargo 1.96, the
    // `package` + `workspace = true` spelling fails to parse). The rename lives
    // in the WORKSPACE spec. OLD behavior: `renamedDepsOf` skipped the member
    // entry (`typeof spec.package !== "string"`), so `use as_real::widget`
    // resolved `external: true, target: null` — a boundary crossing read as an
    // external crate, byte-identical to a real external import.
    const ws = {
      root: "/w",
      projects: [
        { name: "real", root: "acme/libs/real" },
        { name: "app", root: "acme/apps/app" },
      ],
      filesOf: (name) =>
        ({
          real: ["acme/libs/real/Cargo.toml"],
          app: ["acme/apps/app/Cargo.toml", "acme/apps/app/src/main.rs"],
        })[name] ?? [],
      readFile: (path) =>
        ({
          "acme/Cargo.toml":
            '[workspace]\nmembers = ["libs/real", "apps/app"]\n' +
            '[workspace.dependencies]\nas_real = { path = "libs/real", package = "real" }\n',
          "acme/libs/real/Cargo.toml": '[package]\nname = "real"\nversion = "0.1.0"\n',
          "acme/apps/app/Cargo.toml":
            '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\n' +
            "as_real = { workspace = true }\n",
        })[path] ?? null,
    };
    expect(resolveRustDependencies(ws.projects, ws.filesOf, ws.readFile)).toEqual([
      {
        source: "app",
        target: "real",
        sourceFile: "acme/apps/app/Cargo.toml",
        type: "static",
      },
    ]);
    const { imports, failures } = analyzeRust({
      sourceFile: "acme/apps/app/src/main.rs",
      text: "use as_real::widget;\n",
      workspace: ws,
    });
    expect(failures).toEqual([]);
    expect(imports[0].resolved).toEqual({
      target: "real",
      file: null,
      external: false,
      packageName: null,
    });
  });

  it("scopes the rename to the project that declared it — a sibling's own `dep` reaches a different crate", () => {
    const withSibling = {
      ...workspace,
      projects: [...workspace.projects, { name: "app2", root: "acme/apps/app2" }],
      filesOf: (name) =>
        name === "app2"
          ? ["acme/apps/app2/Cargo.toml", "acme/apps/app2/src/main.rs"]
          : workspace.filesOf(name),
      readFile: (path) =>
        path === "acme/apps/app2/Cargo.toml"
          ? '[package]\nname = "app2"\nversion = "0.1.0"\n\n[dependencies]\n' +
            'dep = { package = "other", path = "../../libs/other" }\n'
          : workspace.readFile(path),
    };
    const app2 = analyzeRust({
      sourceFile: "acme/apps/app2/src/main.rs",
      text: "use dep::widget;\n",
      workspace: withSibling,
    });
    expect(app2.imports[0].resolved.target).toBe("other");
    // `app`'s own resolution is unaffected by `app2` sharing the same alias.
    const app = analyzeRust({
      sourceFile: "acme/apps/app/src/main.rs",
      text: "use dep::widget;\n",
      workspace: withSibling,
    });
    expect(app.imports[0].resolved.target).toBe("engine");
  });

  it("crosses the boundary when a rename points at the workspace-root project", () => {
    // The same `pathDir === ""` case as the edge resolver's root-project test,
    // now for `renamedDepsOf`: before the fix, `if (!pathDir || !renamed)
    // continue;` treated the root project's empty-string `pathDir` as "no
    // target" and dropped the alias — `use dep::…` would resolve
    // `external: true, target: null`, indistinguishable from an actual
    // external crate.
    const ws = {
      root: "/w",
      projects: [
        { name: "root", root: "" },
        { name: "app", root: "apps/app" },
      ],
      filesOf: (name) =>
        ({
          root: ["Cargo.toml"],
          app: ["apps/app/Cargo.toml", "apps/app/src/main.rs"],
        })[name] ?? [],
      readFile: (path) =>
        ({
          "Cargo.toml": '[package]\nname = "core_root"\nversion = "0.1.0"\n',
          "apps/app/Cargo.toml":
            '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\n' +
            'dep = { package = "core_root", path = "../.." }\n',
        })[path] ?? null,
    };
    expect(resolveRustDependencies(ws.projects, ws.filesOf, ws.readFile)).toEqual([
      { source: "app", target: "root", sourceFile: "apps/app/Cargo.toml", type: "static" },
    ]);
    const { imports, failures } = analyzeRust({
      sourceFile: "apps/app/src/main.rs",
      text: "use dep::widget;\n",
      workspace: ws,
    });
    expect(failures).toEqual([]);
    expect(imports[0].resolved).toEqual({
      target: "root",
      file: null,
      external: false,
      packageName: null,
    });
  });

  it("crosses the boundary when a rename points at a root project spelled Nx's `.` way", () => {
    // The production spelling of the test right above: before the fix,
    // `renamedDepsOf`'s `projectByRoot` was keyed on the raw `"."`, which
    // never equals the `""` a rename pointing at the root normalizes
    // `pathDir` to — the alias was dropped and `use dep::…` resolved
    // `external: true, target: null`, indistinguishable from a real external
    // crate. `projectByRoot` is now keyed by the normalized root, so `"."`
    // and `""` match the same project.
    const ws = {
      root: "/w",
      projects: [
        { name: "root", root: "." },
        { name: "app", root: "apps/app" },
      ],
      filesOf: (name) =>
        ({
          root: ["Cargo.toml"],
          app: ["apps/app/Cargo.toml", "apps/app/src/main.rs"],
        })[name] ?? [],
      readFile: (path) =>
        ({
          "Cargo.toml": '[package]\nname = "core_root"\nversion = "0.1.0"\n',
          "apps/app/Cargo.toml":
            '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\n' +
            'dep = { package = "core_root", path = "../.." }\n',
        })[path] ?? null,
    };
    expect(resolveRustDependencies(ws.projects, ws.filesOf, ws.readFile)).toEqual([
      { source: "app", target: "root", sourceFile: "apps/app/Cargo.toml", type: "static" },
    ]);
    const { imports, failures } = analyzeRust({
      sourceFile: "apps/app/src/main.rs",
      text: "use dep::widget;\n",
      workspace: ws,
    });
    expect(failures).toEqual([]);
    expect(imports[0].resolved).toEqual({
      target: "root",
      file: null,
      external: false,
      packageName: null,
    });
  });
});

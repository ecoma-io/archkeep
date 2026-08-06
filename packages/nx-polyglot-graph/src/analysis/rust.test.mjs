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

  it("records a brace-group use as unresolvable rather than guessing an arm of it", () => {
    const { imports, failures } = analyze("use {engine_core::Task, serde::de};\n");
    expect(imports[0].resolved).toBeNull();
    expect(imports[0].specifier).toBe("{engine_core::Task, serde::de}");
    expect(failures[0].reason).toMatch(/opens with a brace group/);
    expect(failures[0].line).toBe(1);
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
});

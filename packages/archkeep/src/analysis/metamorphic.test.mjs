import { describe, expect, it } from "vitest";

import { analyzeCSharp } from "./csharp.mjs";
import { analyzeGo } from "./go.mjs";
import { analyzeJava } from "./java.mjs";
import { analyzeKotlin } from "./kotlin.mjs";
import { analyzePython } from "./python.mjs";
import { analyzeRust } from "./rust.mjs";
import { analyzeTypeScript } from "./typescript.mjs";

/**
 * The metamorphic tier for the analyzers: an IRRELEVANT source change must not
 * change an architecture fact.
 *
 * An example test pins one input; this file pins a RELATION — original text
 * and transformed text over the same workspace must yield the same records,
 * because comments, blank lines and the names of locals are not dependencies.
 * The transformations below are the ones a formatter, a code comment or a
 * rename produces on real trees, which is why they are chosen rather than
 * generated: each stands for a class of edit every analyzer must survive
 * without gaining or losing an import record. A generator that also mutated
 * specifiers would test nothing — the interesting failures are exactly the
 * ones where the transform is innocent and the analyzer is not.
 *
 * Two tiers, stated apart because they assert different things:
 *
 - **layout-preserving** (append at end of file, rename a local): the records
   must be deep-equal INCLUDING line and column — nothing above any import
   moved, so a moved position would be a miscount an editor diagnostic would
   repeat confidently.
 - **layout-shifting** (comment lines inserted ABOVE the imports): positions
   legitimately move, so the comparison projects the records onto their
   architecture fields (specifier, kind, spelling, resolved) and pins the
   shift itself — `line` must grow by exactly the number of inserted lines,
   not by one more, not by zero.
 *
 * Every family carries two guards against the silent direction. The negative
 * control adds ONE real crossing under the same transformation and requires
 * the records to move — the relation must be able to see a change. And every
 * comparison runs through `expectRecordsUnchanged`, which refuses an EMPTY
 * baseline first: an analyzer that went quiet would make `[]` "equal" to `[]`
 * and satisfy every equality vacuously, so the comparator demands evidence
 * that there was something to compare.
 *
 * Declared limits stay out of the way: these fixtures use only shapes every
 * analyzer's header already reads (no triple-quoted lookalikes, no brace-group
 * edge cases) — this file proves invariance, not the limits' worst case.
 */

/** The architecture content of a record: everything but where it sits. */
const facts = (record) => {
  const { line: _line, column: _column, ...architecture } = record;
  return architecture;
};

const withLinesShifted = (records, by) =>
  records.map((record) => ({ ...record, line: record.line + by }));

/**
 * Layout-preserving comparison: deep-equal records including line and column,
 * over baselines proven non-empty. Returns nothing; it either passes or throws.
 *
 * The failure list rides the same equality as the import records — including
 * the disclosed classes (`dynamic`, `external`; #603), which a transform that
 * leaves the imports alone must leave alone too. A baseline may carry such
 * rows; what it may not carry is a row that CHANGED across an invariant
 * transform.
 */
const expectRecordsUnchanged = (analyze, original, transformed) => {
  const before = analyze(original);
  const after = analyze(transformed);
  // The vacuity guard: an analyzer returning nothing would satisfy the deep
  // equality below while seeing neither file. Both sides must hold records.
  expect(before.imports.length).toBeGreaterThan(0);
  expect(after.imports).toEqual(before.imports);
  expect(after.failures).toEqual(before.failures);
};

/**
 * Layout-shifting comparison: same architecture facts, positions moved by
 * exactly `by` lines — not zero, not one more.
 */
const expectOnlyShifted = (analyze, original, transformed, by) => {
  const before = analyze(original);
  const after = analyze(transformed);
  expect(before.imports.length).toBeGreaterThan(0);
  expect(after.imports.map(facts)).toEqual(before.imports.map(facts));
  expect(after.imports).toEqual(withLinesShifted(before.imports, by));
  expect(after.failures).toEqual(withLinesShifted(before.failures, by));
};

describe("Go — comments and renames are not dependencies", () => {
  const workspace = goWorkspace();
  const analyze = (text) => analyzeGo({ sourceFile: "acme/apps/gamma/main.go", text, workspace });

  const original = [
    "package main",
    "",
    'import "example.com/acme/core/api"',
    'import "fmt"',
    "",
    "func main() { msg := fmt.Sprint(api.Hello()); _ = msg }",
    "",
  ].join("\n");

  it("a comment appended at the end of the file changes nothing, byte for byte", () => {
    expectRecordsUnchanged(analyze, original, `${original}// TODO: split gamma off core\n`);
  });

  it("renaming a local identifier changes nothing — the import is the fact", () => {
    const renamed = original.replace("msg", "greeting");
    expect(renamed).not.toBe(original); // the transform happened
    expectRecordsUnchanged(analyze, original, renamed);
  });

  it("comment lines inserted above the block shift every line by exactly that many", () => {
    const header = ["// Package main is the gamma entry point.", "// It may import core."];
    expectOnlyShifted(analyze, original, [...header, original].join("\n"), header.length);
  });

  it("negative control: one added crossing moves the records the transforms must not", () => {
    const violated = original.replace(
      'import "example.com/acme/core/api"',
      'import (\n\t"example.com/acme/core/api"\n\t"example.com/acme/storage/kv"\n)',
    );
    const result = analyze(violated);
    // The only failure is `fmt`'s disclosure (#603) — the added crossing
    // produces a record, not a failure.
    expect(result.failures).toEqual([
      {
        sourceFile: "acme/apps/gamma/main.go",
        line: 7,
        column: 8,
        reason: "Go cannot resolve 'fmt' from 'acme/apps/gamma/main.go'",
        external: true,
      },
    ]);
    expect(
      result.imports.some((record) => record.specifier === "example.com/acme/storage/kv"),
    ).toBe(true);
  });
});

describe("Rust — comments and renames are not dependencies", () => {
  const workspace = rustWorkspace();
  const analyze = (text) =>
    analyzeRust({ sourceFile: "acme/apps/shell/src-tauri/src/main.rs", text, workspace });

  const original = [
    "mod config;",
    "",
    "fn load() -> String {",
    "    let value = engine_core::settings::default();",
    "    value",
    "}",
    "",
  ].join("\n");

  it("a line comment appended at the end of the file changes nothing", () => {
    expectRecordsUnchanged(analyze, original, `${original}// TODO: read the setting lazily\n`);
  });

  it("renaming a local binding changes nothing — the use path is the fact", () => {
    // Renamed on ITS OWN line: a rename sharing the `use`'s line would shift
    // the recorded column, which is a real movement this family must not fake.
    const renamed = original.replace("    value", "    fallback");
    expect(renamed).not.toBe(original);
    expectRecordsUnchanged(analyze, original, renamed);
  });

  it("an interior doc comment shifts the recorded line by exactly its own length", () => {
    const doc = ["/// Loads the startup settings.", "/// Kept beside `main`."];
    const lines = original.split("\n");
    const at = lines.findIndex((line) => line.startsWith("fn load"));
    const shiftedText = [...lines.slice(0, at), ...doc, ...lines.slice(at)].join("\n");
    expectOnlyShifted(analyze, original, shiftedText, doc.length);
  });

  it("negative control: one added crossing moves the records", () => {
    const violated = `${original}use storage_kv::bucket::Bucket;\n`;
    const result = analyze(violated);
    expect(result.imports.some((record) => record.specifier.startsWith("storage_kv"))).toBe(true);
  });
});

describe("Python — comments and renames are not dependencies", () => {
  const workspace = pythonWorkspace();
  const analyze = (text) =>
    analyzePython({ sourceFile: "apps/viewer/src/viewer/app.py", text, workspace });

  const original = [
    "from viewer.window import Window",
    "",
    "def open():",
    '    label = "app"',
    "    return Window(label)",
    "",
  ].join("\n");

  it("a comment appended at the end of the file changes nothing", () => {
    expectRecordsUnchanged(analyze, original, `${original}# TODO: close the window on exit\n`);
  });

  it("renaming a local variable changes nothing — the imported name is the fact", () => {
    const renamed = original.replaceAll("label", "caption");
    expect(renamed).not.toBe(original);
    expectRecordsUnchanged(analyze, original, renamed);
  });

  it("a comment block inserted above the imports shifts every line by exactly its length", () => {
    const header = ["# Viewer application.", "# Imports stay at the top."];
    expectOnlyShifted(analyze, original, [...header, original].join("\n"), header.length);
  });

  it("negative control: one added crossing moves the records", () => {
    const violated = `${original}import storage.secret\n`;
    const result = analyze(violated);
    expect(result.imports.some((record) => record.specifier === "storage.secret")).toBe(true);
  });
});

describe("TypeScript — comments and renames are not dependencies", () => {
  const workspace = tsWorkspace();
  const analyze = (text) =>
    analyzeTypeScript({
      sourceFile: "libs/ui/src/button.ts",
      text,
      workspace,
    });

  const original = [
    'import { render } from "./render";',
    'import { theme } from "@ui/theme";',
    "",
    "export function button() {",
    "  const label = render(theme.label());",
    "  return label;",
    "}",
    "",
  ].join("\n");

  it("a comment appended at the end of the file changes nothing, byte for byte", () => {
    expectRecordsUnchanged(analyze, original, `${original}// TODO: forward the aria attributes\n`);
  });

  it("renaming a local constant changes nothing — resolution runs on the specifier", () => {
    const renamed = original.replace("label", "caption");
    expect(renamed).not.toBe(original);
    expectRecordsUnchanged(analyze, original, renamed);
  });

  it("a banner comment inserted above the imports shifts every line by exactly its length", () => {
    const banner = [
      "/** Button primitives for the ui library. */",
      "/* eslint-disable @typescript-eslint/no-unused-vars */",
    ];
    expectOnlyShifted(analyze, original, [...banner, original].join("\n"), banner.length);
  });

  it("negative control: one added crossing moves the records", () => {
    const violated = `${original}import { helper } from "../../web/src/helper";\n`;
    const result = analyze(violated);
    expect(result.imports.some((record) => record.specifier.includes("../../web/"))).toBe(true);
  });
});

describe("Java — comments and renames are not dependencies", () => {
  const workspace = javaWorkspace();
  const analyze = (text) =>
    analyzeJava({
      sourceFile: "acme/apps/api/src/main/java/com/acme/api/Handler.java",
      text,
      workspace,
    });

  const original = [
    "package com.acme.api;",
    "",
    "import com.acme.core.Kernel;",
    "import com.acme.util.Strings;",
    "",
    "class Handler { String render() { return Strings.shout(Kernel.name()); } }",
    "",
  ].join("\n");

  it("a comment appended at the end of the file changes nothing, byte for byte", () => {
    expectRecordsUnchanged(analyze, original, `${original}// TODO: split api off core\n`);
  });

  it("renaming a local identifier changes nothing — the import is the fact", () => {
    const renamed = original.replace("render", "produce");
    expect(renamed).not.toBe(original); // the transform happened
    expectRecordsUnchanged(analyze, original, renamed);
  });

  it("comment lines inserted above the block shift every line by exactly that many", () => {
    const header = ["// Handler is the api entry point.", "// It may import core."];
    expectOnlyShifted(analyze, original, [...header, original].join("\n"), header.length);
  });

  it("negative control: one added crossing moves the records the transforms must not", () => {
    const violated = original.replace(
      "import com.acme.util.Strings;",
      "import com.acme.storage.Store;",
    );
    const result = analyze(violated);
    expect(result.failures).toEqual([]);
    expect(result.imports.some((record) => record.specifier === "com.acme.storage.Store")).toBe(
      true,
    );
  });
});

describe("Kotlin — comments and renames are not dependencies", () => {
  const workspace = kotlinWorkspace();
  const analyze = (text) =>
    analyzeKotlin({
      sourceFile: "acme/apps/api/src/main/kotlin/com/acme/api/Handler.kt",
      text,
      workspace,
    });

  const original = [
    "package com.acme.api",
    "",
    "import com.acme.core.Kernel",
    "import com.acme.util.Strings",
    "",
    "class Handler { fun render(): String = Strings.shout(Kernel.name()) }",
    "",
  ].join("\n");

  it("a comment appended at the end of the file changes nothing, byte for byte", () => {
    expectRecordsUnchanged(analyze, original, `${original}// TODO: split api off core\n`);
  });

  it("renaming a local identifier changes nothing — the import is the fact", () => {
    const renamed = original.replace("render", "produce");
    expect(renamed).not.toBe(original); // the transform happened
    expectRecordsUnchanged(analyze, original, renamed);
  });

  it("comment lines inserted above the block shift every line by exactly that many", () => {
    const header = ["// Handler is the api entry point.", "// It may import core."];
    expectOnlyShifted(analyze, original, [...header, original].join("\n"), header.length);
  });

  it("negative control: one added crossing moves the records the transforms must not", () => {
    const violated = original.replace(
      "import com.acme.util.Strings",
      "import com.acme.storage.Store",
    );
    const result = analyze(violated);
    expect(result.failures).toEqual([]);
    expect(result.imports.some((record) => record.specifier === "com.acme.storage.Store")).toBe(
      true,
    );
  });
});

describe("C# — comments and renames are not dependencies", () => {
  const workspace = csharpWorkspace();
  const analyze = (text) =>
    analyzeCSharp({
      sourceFile: "acme/apps/api/Handler.cs",
      text,
      workspace,
    });

  const original = [
    "using Acme.Core;",
    "using static Acme.Util.Strings;",
    "",
    "namespace Acme.Api;",
    "",
    "class Handler { string Render() => Strings.Shout(Kernel.Name); }",
    "",
  ].join("\n");

  it("a comment appended at the end of the file changes nothing, byte for byte", () => {
    expectRecordsUnchanged(analyze, original, `${original}// TODO: split api off core\n`);
  });

  it("renaming a local identifier changes nothing — the directive is the fact", () => {
    const renamed = original.replace("Render", "Produce");
    expect(renamed).not.toBe(original); // the transform happened
    expectRecordsUnchanged(analyze, original, renamed);
  });

  it("comment lines inserted above the block shift every line by exactly that many", () => {
    const header = ["// Handler is the api entry point.", "// It may import core."];
    expectOnlyShifted(analyze, original, [...header, original].join("\n"), header.length);
  });

  it("negative control: one added crossing moves the records the transforms must not", () => {
    const violated = original.replace(
      "using static Acme.Util.Strings;",
      "using static Acme.Storage.Store;",
    );
    const result = analyze(violated);
    expect(result.failures).toEqual([]);
    expect(result.imports.some((record) => record.specifier === "Acme.Storage.Store")).toBe(true);
  });
});

/** --- fixture workspaces ------------------------------------------------- */

function csharpWorkspace() {
  const files = {
    "acme/apps/api/Handler.cs": "",
    "acme/libs/core/Kernel.cs": "namespace Acme.Core;\npublic class Kernel { }\n",
    "acme/libs/util/Strings.cs": "namespace Acme.Util;\npublic static class Strings { }\n",
    "acme/libs/storage/Store.cs": "namespace Acme.Storage;\npublic class Store { }\n",
  };
  return {
    root: "/w",
    projects: [
      { name: "api", root: "acme/apps/api" },
      { name: "core", root: "acme/libs/core" },
      { name: "util", root: "acme/libs/util" },
      { name: "storage", root: "acme/libs/storage" },
    ],
    filesOf: (name) =>
      ({
        api: Object.keys(files).filter((file) => file.startsWith("acme/apps/api/")),
        core: Object.keys(files).filter((file) => file.startsWith("acme/libs/core/")),
        util: Object.keys(files).filter((file) => file.startsWith("acme/libs/util/")),
        storage: Object.keys(files).filter((file) => file.startsWith("acme/libs/storage/")),
      })[name] ?? [],
    readFile: (path) => files[path] ?? null,
  };
}

function kotlinWorkspace() {
  const files = {
    "acme/apps/api/src/main/kotlin/com/acme/api/Handler.kt": "",
    "acme/libs/core/src/main/java/com/acme/core/Kernel.java":
      "package com.acme.core;\nclass Kernel {}\n",
    "acme/libs/util/src/main/kotlin/com/acme/util/Strings.kt":
      "package com.acme.util\nfun shout(s: String) = s\n",
    "acme/libs/storage/src/main/kotlin/com/acme/storage/Store.kt":
      "package com.acme.storage\nclass Store\n",
  };
  return {
    root: "/w",
    projects: [
      { name: "api", root: "acme/apps/api" },
      { name: "core", root: "acme/libs/core" },
      { name: "util", root: "acme/libs/util" },
      { name: "storage", root: "acme/libs/storage" },
    ],
    filesOf: (name) =>
      ({
        api: Object.keys(files).filter((file) => file.startsWith("acme/apps/api/")),
        core: Object.keys(files).filter((file) => file.startsWith("acme/libs/core/")),
        util: Object.keys(files).filter((file) => file.startsWith("acme/libs/util/")),
        storage: Object.keys(files).filter((file) => file.startsWith("acme/libs/storage/")),
      })[name] ?? [],
    readFile: (path) => files[path] ?? null,
  };
}

function javaWorkspace() {
  const files = {
    "acme/apps/api/src/main/java/com/acme/api/Handler.java": "",
    "acme/libs/core/src/main/java/com/acme/core/Kernel.java":
      "package com.acme.core;\nclass Kernel {}\n",
    "acme/libs/util/src/main/java/com/acme/util/Strings.java":
      "package com.acme.util;\nclass Strings {}\n",
    "acme/libs/storage/src/main/java/com/acme/storage/Store.java":
      "package com.acme.storage;\nclass Store {}\n",
  };
  return {
    root: "/w",
    projects: [
      { name: "api", root: "acme/apps/api" },
      { name: "core", root: "acme/libs/core" },
      { name: "util", root: "acme/libs/util" },
      { name: "storage", root: "acme/libs/storage" },
    ],
    filesOf: (name) =>
      ({
        api: Object.keys(files).filter((file) => file.startsWith("acme/apps/api/")),
        core: Object.keys(files).filter((file) => file.startsWith("acme/libs/core/")),
        util: Object.keys(files).filter((file) => file.startsWith("acme/libs/util/")),
        storage: Object.keys(files).filter((file) => file.startsWith("acme/libs/storage/")),
      })[name] ?? [],
    readFile: (path) => files[path] ?? null,
  };
}

function goWorkspace() {
  const files = {
    "acme/go.mod": "module example.com/acme\n\ngo 1.22\n",
    "acme/apps/gamma/main.go": "",
    "acme/libs/core/go.mod": "module example.com/acme/core\n\ngo 1.22\n",
    "acme/libs/storage/go.mod": "module example.com/acme/storage\n\ngo 1.22\n",
  };
  return {
    root: "/w",
    projects: [
      { name: "gamma", root: "acme/apps/gamma" },
      { name: "core", root: "acme/libs/core" },
      { name: "storage", root: "acme/libs/storage" },
    ],
    filesOf: (name) =>
      ({
        gamma: Object.keys(files).filter((file) => file.startsWith("acme/apps/gamma/")),
        core: Object.keys(files).filter((file) => file.startsWith("acme/libs/core/")),
        storage: Object.keys(files).filter((file) => file.startsWith("acme/libs/storage/")),
      })[name] ?? [],
    readFile: (path) => files[path] ?? null,
  };
}

function rustWorkspace() {
  const files = {
    "acme/apps/shell/src-tauri/Cargo.toml": '[package]\nname = "shell"\nversion = "0.1.0"\n',
    "acme/apps/shell/src-tauri/src/main.rs": "",
    "acme/apps/shell/src-tauri/src/config.rs": "",
    "acme/libs/engine/Cargo.toml": '[package]\nname = "engine-core"\nversion = "0.1.0"\n',
    "acme/libs/storage/Cargo.toml": '[package]\nname = "storage-kv"\nversion = "0.1.0"\n',
  };
  return {
    root: "/w",
    projects: [
      { name: "shell", root: "acme/apps/shell" },
      { name: "engine", root: "acme/libs/engine" },
      { name: "storage", root: "acme/libs/storage" },
    ],
    filesOf: (name) =>
      ({
        shell: Object.keys(files).filter((file) => file.startsWith("acme/apps/shell/")),
        engine: Object.keys(files).filter((file) => file.startsWith("acme/libs/engine/")),
        storage: Object.keys(files).filter((file) => file.startsWith("acme/libs/storage/")),
      })[name] ?? [],
    readFile: (path) => files[path] ?? null,
  };
}

function pythonWorkspace() {
  const files = {
    "apps/viewer/pyproject.toml": '[project]\nname = "viewer"\n',
    "apps/viewer/src/viewer/__init__.py": "",
    "apps/viewer/src/viewer/app.py": "",
    "apps/viewer/src/viewer/window.py": "",
    "libs/storage/pyproject.toml": '[project]\nname = "storage"\n',
    "libs/storage/src/storage/__init__.py": "",
    "libs/storage/src/storage/secret.py": "",
  };
  return {
    root: "/w",
    projects: [
      { name: "viewer", root: "apps/viewer" },
      { name: "storage", root: "libs/storage" },
    ],
    filesOf: (name) =>
      ({
        viewer: Object.keys(files).filter((file) => file.startsWith("apps/viewer/")),
        storage: Object.keys(files).filter((file) => file.startsWith("libs/storage/")),
      })[name] ?? [],
    readFile: (path) => files[path] ?? null,
  };
}

function tsWorkspace() {
  const files = {
    "tsconfig.base.json":
      '{\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": {\n      "@ui/theme": ["libs/theme/src/index.ts"]\n    }\n  }\n}\n',
    "libs/ui/src/button.ts": "",
    "libs/ui/src/render.ts": "export const render = (x) => x;\n",
    "libs/theme/src/index.ts": 'export const theme = { label: "Button" };\n',
    "apps/web/src/helper.ts": "export const helper = () => 1;\n",
  };
  const PROJECTS = [
    { name: "ui", root: "libs/ui" },
    { name: "theme", root: "libs/theme" },
    { name: "web", root: "apps/web" },
  ];
  return {
    root: "/w",
    projects: PROJECTS,
    tsConfig: "tsconfig.base.json",
    filesOf: (name) =>
      PROJECTS.filter((project) => project.name === name).flatMap((project) =>
        Object.keys(files).filter(
          (file) => file === project.root || file.startsWith(`${project.root}/`),
        ),
      ),
    readFile: (path) => files[path] ?? null,
  };
}

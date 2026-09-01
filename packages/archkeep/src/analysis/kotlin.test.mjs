import { describe, expect, it } from "vitest";

import {
  analyzeKotlin,
  kotlinImportMalformations,
  parseKotlinImportSites,
  resolveKotlinDependencies,
} from "./kotlin.mjs";

const positionOf = (source, needle) => {
  const offset = source.indexOf(needle);
  expect(offset).toBeGreaterThanOrEqual(0);
  const before = source.slice(0, offset).split("\n");
  return { line: before.length, column: before[before.length - 1].length + 1 };
};

const workspaceOf = (files) => ({
  root: "/workspace",
  projects: [
    { name: "acme", root: "packages/acme" },
    { name: "core", root: "packages/core" },
    { name: "util", root: "packages/util" },
  ],
  filesOf: (name) => Object.keys(files).filter((f) => f.startsWith(`packages/${name}/`)),
  readFile: (path) => files[path] ?? null,
});

const baseWorkspace = () =>
  workspaceOf({
    "packages/acme/src/main/kotlin/com/acme/app/Main.kt": "package com.acme.app\n\nclass Main\n",
    "packages/core/src/main/kotlin/com/acme/core/Kernel.kt":
      'package com.acme.core\n\nclass Kernel {\n    companion object { const val VERSION = "1" }\n}\n',
    "packages/util/src/main/java/com/acme/util/Strings.java":
      "package com.acme.util;\nclass Strings {}\n",
  });

const analyzeIn = (workspace, fileName, text) =>
  analyzeKotlin({ sourceFile: fileName, text, workspace });

describe("parseKotlinImportSites", () => {
  it("reads the three import forms, alias included in neither name nor specifier", () => {
    const source = [
      "package p",
      "",
      "import com.acme.core.Kernel",
      "import com.acme.util.*",
      "import com.acme.core.Kernel as K",
      "",
      "class T",
    ].join("\n");
    const sites = parseKotlinImportSites(source);
    expect(sites.map((s) => s.specifier)).toEqual([
      "com.acme.core.Kernel",
      "com.acme.util.*",
      "com.acme.core.Kernel",
    ]);
    expect(sites.map((s) => s.importableName)).toEqual([
      "com.acme.core.Kernel",
      "com.acme.util",
      "com.acme.core.Kernel",
    ]);
  });

  it("points each site at the imported name's own coordinates", () => {
    const source = "package p\n\nimport com.acme.core.Kernel\n\nclass T\n";
    const [site] = parseKotlinImportSites(source);
    const expected = positionOf(source, "com.acme.core.Kernel");
    const before = source.slice(0, site.offset).split("\n");
    expect({ line: before.length, column: before[before.length - 1].length + 1 }).toEqual(expected);
  });

  it("reads backtick-quoted segments as identifiers", () => {
    const source = "package p\nimport com.acme.`when`.Guard\n\nclass T\n";
    const [site] = parseKotlinImportSites(source);
    expect(site.importableName).toBe("com.acme.`when`.Guard");
  });

  it("does not read a multi-line import — the pinned silent limit", () => {
    const source = "package p\nimport com.acme.\n    core.Kernel\n\nclass T\n";
    expect(parseKotlinImportSites(source)).toHaveLength(0);
  });

  it("never reads a package-less script's first import as a package", () => {
    // The default-package shape of a standalone .kts script.
    const source = "import one.pkg.A\n\nfun main() {}\n";
    expect(parseKotlinImportSites(source)).toHaveLength(1);
  });

  it("reads a CRLF file's imports identically to its LF twin (#406)", () => {
    const lf = [
      "package p",
      "",
      "import com.acme.core.Kernel",
      "import com.acme.util.Strings as S",
      "",
      "class T",
    ].join("\n");
    const expected = parseKotlinImportSites(lf);
    expect(expected).toHaveLength(2);
    expect(
      parseKotlinImportSites(lf.replaceAll("\n", "\r\n")).map((site) => site.specifier),
    ).toEqual(expected.map((site) => site.specifier));
  });

  it("reads a BOM-prefixed script's first import at its disk offset (#407)", () => {
    // The BOM is matched, not stripped, exactly as the C# directive parse does
    // (`./csharp.test.mjs`): the offset indexes the bytes on disk.
    const source = "﻿import com.acme.core.Kernel\n\nclass T\n";
    const sites = parseKotlinImportSites(source);
    expect(sites.map((site) => site.specifier)).toEqual(["com.acme.core.Kernel"]);
    expect(source.slice(sites[0].offset, sites[0].offset + sites[0].specifier.length)).toBe(
      "com.acme.core.Kernel",
    );
  });
});

describe("analyzeKotlin", () => {
  it("resolves through the unified index into a JAVA-declared namespace and back", () => {
    const workspace = baseWorkspace();
    // The importing file is Kotlin; the imported name is declared by a .java
    // source. One namespace, one index, one answer either direction.
    const caller =
      "package com.acme.app\n\nimport com.acme.util.Strings\n\nclass Main { val s = Strings.shout() }\n";
    const result = analyzeIn(
      workspace,
      "packages/acme/src/main/kotlin/com/acme/app/Main.kt",
      caller,
    );
    expect(result.failures).toEqual([]);
    expect(result.imports[0].resolved.target).toBe("util");
    expect(result.imports[0].spelling.relative).toBe(false);
  });

  it("marks an own-project import spelling.relative=true", () => {
    const inner =
      "package com.acme.app\n\nimport com.acme.app.internal.Bus\n\nclass Main { val b = Bus() }\n";
    const ws = workspaceOf({
      "packages/acme/src/main/kotlin/com/acme/app/Main.kt": inner,
      "packages/acme/src/main/kotlin/com/acme/app/internal/Bus.kt":
        "package com.acme.app.internal\n\nclass Bus\n",
    });
    const result = analyzeIn(ws, "packages/acme/src/main/kotlin/com/acme/app/Main.kt", inner);
    expect(result.imports[0].resolved.target).toBe("acme");
    expect(result.imports[0].spelling.relative).toBe(true);
  });

  it("classifies Kotlin stdlib externals by the defaults table", () => {
    const workspace = baseWorkspace();
    const caller =
      "package com.acme.app\n\nimport kotlin.math.abs\nimport java.io.File\n\nclass Main\n";
    const result = analyzeIn(
      workspace,
      "packages/acme/src/main/kotlin/com/acme/app/Main.kt",
      caller,
    );
    expect(result.imports.map((record) => record.resolved.packageName)).toEqual([
      "kotlin.math.abs",
      "java.io.File",
    ]);
    expect(result.imports.every((record) => record.resolved.external)).toBe(true);
  });

  it("counts nothing from comments or raw strings — the loud-direction guards", () => {
    const workspace = baseWorkspace();
    const tricky = [
      "package com.acme.app",
      "/** Javadoc {@code import com.acme.core.Ghost;} */",
      "// import com.acme.core.Commented",
      'val doc = """',
      "     import fake.other.Tool",
      '"""',
      "/* import com.acme.core.InBlock */",
      "class Main",
    ].join("\n");
    const result = analyzeIn(
      workspace,
      "packages/acme/src/main/kotlin/com/acme/app/Main.kt",
      tricky,
    );
    expect(result.imports).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("reports a split package ambiguously, naming every claimant", () => {
    const files = {
      "packages/acme/src/main/kotlin/shared/thing/A.kt": "package shared.thing\n\nclass A\n",
      "packages/core/src/main/kotlin/shared/thing/B.kt": "package shared.thing\n\nclass B\n",
      "packages/util/src/main/kotlin/com/acme/util/C.kt":
        "package com.acme.util\n\nimport shared.thing.Widget\n\nclass C\n",
    };
    const workspace = workspaceOf(files);
    const result = analyzeKotlin({
      sourceFile: "packages/util/src/main/kotlin/com/acme/util/C.kt",
      text: files["packages/util/src/main/kotlin/com/acme/util/C.kt"],
      workspace,
    });
    expect(result.imports[0].resolved).toBeNull();
    expect(result.failures[0].reason).toContain("shared.thing");
    expect(result.failures[0].reason).toContain("acme");
    expect(result.failures[0].reason).toContain("core");
    expect(result.failures[0].line).toBe(3);
  });

  it("never throws on malformed input — a whole-file failure carries it", () => {
    const hostile = {
      ...baseWorkspace(),
      readFile: (path) => {
        if (path.endsWith("Kernel.kt")) throw new Error("disk exploded");
        return baseWorkspace().readFile(path);
      },
    };
    const result = analyzeIn(
      hostile,
      "packages/acme/src/main/kotlin/com/acme/app/Main.kt",
      "package com.acme.app\nimport com.acme.core.Kernel\n",
    );
    expect(result.imports).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toContain("disk exploded");
  });

  it("reports the crossing in a CRLF file whose ONLY import violates — the silent direction (#406)", () => {
    // Windows `core.autocrlf=true` checkouts are CRLF throughout; before the
    // terminator carried `\r`, `analyzeKotlin` answered zero import sites for
    // such a file — byte-for-byte the answer a file with no imports gives.
    const workspace = baseWorkspace();
    const caller =
      "package com.acme.app\r\n\r\nimport com.acme.core.Kernel\r\n\r\nclass A { val k = Kernel() }\r\n";
    const result = analyzeIn(
      workspace,
      "packages/acme/src/main/kotlin/com/acme/app/Main.kt",
      caller,
    );
    expect(result.failures).toEqual([]);
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0].resolved.target).toBe("core");
    expect(result.imports[0].line).toBe(3);
  });

  it("reports the crossing behind a BOM before the first import — the silent direction (#407)", () => {
    const workspace = baseWorkspace();
    // A default-package script: no `package` line to absorb the BOM, so the
    // import itself is what a BOM-intolerant anchor skips.
    const caller = "﻿import com.acme.core.Kernel\n\nclass A { val k = Kernel() }\n";
    const result = analyzeIn(
      workspace,
      "packages/acme/src/main/kotlin/com/acme/app/Main.kt",
      caller,
    );
    expect(result.failures).toEqual([]);
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0].resolved.target).toBe("core");
    // The column counts the BOM, because the offset indexes the bytes on disk
    // — `../contract.md`'s byte-tolerance law.
    expect(result.imports[0].line).toBe(1);
    expect(result.imports[0].column).toBe(9);
  });
});

describe("resolveKotlinDependencies", () => {
  it("draws edges from .kt imports, including toward Java-only packages", () => {
    const tree = {
      "packages/acme/pom.xml": "<project></project>",
      "packages/acme/src/main/kotlin/com/acme/app/App.kt":
        "package com.acme.app\n\nimport com.acme.util.Strings\n\nclass App\n",
      "packages/util/src/main/java/com/acme/util/Strings.java":
        "package com.acme.util;\nclass Strings {}\n",
    };
    const ws = workspaceOf(tree);
    expect(resolveKotlinDependencies(ws)).toEqual([
      {
        source: "acme",
        target: "util",
        sourceFile: "packages/acme/src/main/kotlin/com/acme/app/App.kt",
        type: "static",
      },
    ]);
  });

  it("skips an ambiguous name rather than drawing an edge against a guess", () => {
    const tree = {
      "packages/acme/src/main/kotlin/shared/thing/A.kt": "package shared.thing\n\nclass A\n",
      "packages/core/src/main/kotlin/shared/thing/B.kt": "package shared.thing\n\nclass B\n",
      "packages/util/src/main/kotlin/com/acme/util/C.kt":
        "package com.acme.util\n\nimport shared.thing.W\n\nclass C\n",
    };
    const ws = workspaceOf(tree);
    expect(resolveKotlinDependencies(ws)).toEqual([]);
  });

  it("refuses the graph on a JVM source the package index could not read", () => {
    // #364, the same check `resolveJavaDependencies` holds over the one
    // shared index — spelled here too, because either resolver alone must
    // refuse a tree whose index is corrupt, whichever languages the tree has.
    const ws = {
      root: "/workspace",
      projects: [{ name: "acme", root: "packages/acme" }],
      filesOf: () => ["packages/acme/src/main/kotlin/com/acme/app/App.kt"],
      readFile: () => null,
    };
    expect(() => resolveKotlinDependencies(ws)).toThrow(
      /packages\/acme\/src\/main\/kotlin\/com\/acme\/app\/App\.kt/,
    );
  });
});

describe("Kotlin — malformed input edge cases", () => {
  // Bug: before adding kotlinImportMalformations, a truncated import silently
  // produced 0 imports with no failure — byte-for-byte identical to a clean
  // file with no imports (#419).
  it("flags an import truncated at EOF as a malformation", () => {
    const reasons = kotlinImportMalformations("package com.acme\n\nimport com.acme.");
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/truncated/);
  });

  // Bug: an import and `{` on the same line is not valid Kotlin, but was
  // silently dropped before the malformation detection was added.
  it("flags an import and `{` sharing a line as a malformation", () => {
    const reasons = kotlinImportMalformations("import com.acme.Kernel class App {");
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/share a line/);
  });
});

describe("Kotlin — determinism", () => {
  // Intentional limitation: the analyzer is a pure function of its inputs —
  // recomputing the same workspace must yield byte-for-byte the same result.
  it("produces the same result when run twice on the same input", () => {
    const text = "package com.acme.app\n\nimport com.acme.core.Kernel\n\nclass App {}";
    const workspace = {
      root: "/workspace",
      projects: [{ name: "acme", root: "packages/acme" }],
      filesOf: () => ["packages/acme/src/main/kotlin/com/acme/app/App.kt"],
      readFile: () => null,
    };
    const first = analyzeKotlin({
      sourceFile: "packages/acme/src/main/kotlin/com/acme/app/App.kt",
      text,
      workspace,
    });
    const second = analyzeKotlin({
      sourceFile: "packages/acme/src/main/kotlin/com/acme/app/App.kt",
      text,
      workspace,
    });
    expect(first).toEqual(second);
  });
});

describe("Kotlin — silent direction", () => {
  // Bug: before adding kotlinImportMalformations, a file truncated inside an
  // import parsed as importing nothing with no failure — the verdict was
  // indistinguishable from a clean file (#419).
  it("produces a whole-file failure for an import truncated at EOF", () => {
    const workspace = {
      root: "/workspace",
      projects: [{ name: "acme", root: "packages/acme" }],
      filesOf: () => ["packages/acme/src/main/kotlin/com/acme/app/App.kt"],
      readFile: () => null,
    };
    const { imports, failures } = analyzeKotlin({
      sourceFile: "packages/acme/src/main/kotlin/com/acme/app/App.kt",
      text: "package com.acme.app\n\nimport com.acme.core.",
      workspace,
    });
    expect(imports).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0].line).toBeNull();
    expect(failures[0].reason).toMatch(/truncated/);
  });
});

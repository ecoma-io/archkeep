import { describe, expect, it } from "vitest";

import { analyzeKotlin, parseKotlinImportSites, resolveKotlinDependencies } from "./kotlin.mjs";

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

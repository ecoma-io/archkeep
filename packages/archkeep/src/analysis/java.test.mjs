import { describe, expect, it } from "vitest";

import { analyzeJava, parseJavaImportSites, resolveJavaDependencies } from "./java.mjs";
import { maskJavaComments } from "./jvm/mask.mjs";

/**
 * Positions are pinned FROM the fixture, never as literals: the expected
 * line/column is found by searching the source text, so moving a line in the
 * fixture moves both sides and an off-by-one in the analyzer moves only one
 * (`../../AGENTS.md` — a diagnostic naming the wrong line is worse than none).
 */
const positionOf = (source, needle) => {
  const offset = source.indexOf(needle);
  expect(offset).toBeGreaterThanOrEqual(0);
  const before = source.slice(0, offset).split("\n");
  return { line: before.length, column: before[before.length - 1].length + 1 };
};

/** An in-memory workspace whose readFile backs real fixture text. */
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
    "packages/acme/src/main/java/com/acme/app/Application.java":
      "package com.acme.app;\nclass Application {}\n",
    // The package core declares lives under TWO spellings on purpose: a
    // shallow root and a deeper subpackage, so longest-prefix behavior is
    // observable against one project.
    "packages/core/src/main/java/com/acme/core/Kernel.java":
      "package com.acme.core;\nclass Kernel {}\n",
    "packages/core/src/main/java/com/acme/core/spi/KernelSpi.java":
      "package com.acme.core.spi;\nclass KernelSpi {}\n",
    "packages/util/src/main/java/com/acme/util/Strings.java":
      "package com.acme.util;\nclass Strings {}\n",
  });

const analyzeIn = (workspace, fileName, text) =>
  analyzeJava({ sourceFile: fileName, text, workspace });

describe("parseJavaImportSites", () => {
  it("reads all four JLS §7.5 import forms", () => {
    const source = [
      "package p;",
      "",
      "import com.acme.core.Kernel;",
      "import com.acme.util.*;",
      "import static com.acme.core.Kernel.VERSION;",
      "import static com.acme.util.Strings.*;",
      "",
      "class T {}",
    ].join("\n");
    const sites = parseJavaImportSites(source);
    expect(sites.map((s) => s.specifier)).toEqual([
      "com.acme.core.Kernel",
      "com.acme.util.*",
      "static com.acme.core.Kernel.VERSION",
      "static com.acme.util.Strings.*",
    ]);
    // Importable names strip what names members rather than packages.
    expect(sites.map((s) => s.importableName)).toEqual([
      "com.acme.core.Kernel",
      "com.acme.util",
      "com.acme.core.Kernel",
      "com.acme.util.Strings",
    ]);
  });

  it("points each site at the imported name's own coordinates", () => {
    const source = "package p;\nimport com.acme.core.Kernel;\nclass T {}\n";
    const [site] = parseJavaImportSites(source);
    const expected = positionOf(source, "com.acme.core.Kernel");
    const actual = (() => {
      const before = source.slice(0, site.offset).split("\n");
      return { line: before.length, column: before[before.length - 1].length + 1 };
    })();
    expect(actual).toEqual(expected);
  });

  it('reads an import following "package p;" on the same line', () => {
    const source = "package p; import com.acme.core.Kernel;\nclass T {}\n";
    expect(parseJavaImportSites(source)).toHaveLength(1);
  });

  it("does not read a multi-line import statement — the pinned silent limit", () => {
    const source = "package p;\nimport com.acme.\n    core.Kernel;\nclass T {}\n";
    // Every formatter writes imports onto one line; this test PINS that the
    // miss exists and is quiet about it, so a future reader learns it here
    // and not from a missing violation they expected.
    expect(parseJavaImportSites(source)).toHaveLength(0);
  });
});

describe("analyzeJava", () => {
  it("resolves through the content-derived index to the deepest declared prefix", () => {
    const workspace = baseWorkspace();
    const caller =
      "package com.acme.app;\nimport com.acme.core.spi.KernelSpi;\nclass A { KernelSpi s; }\n";
    const result = analyzeIn(workspace, "packages/acme/src/main/java/com/acme/app/A.java", caller);
    expect(result.failures).toEqual([]);
    expect(result.imports[0].resolved.target).toBe("core");
    // The record survives even when the exact dotted name is not itself an
    // index key — the PREFIX owns the answer.
    expect(result.imports[0].resolved.file).toBeNull();
  });

  it("repoints when the TARGET's package declaration moves — resolution reads content", () => {
    const workspace = baseWorkspace();
    // The metamorphic requirement, stated directly: change ONLY the target's
    // package line, keep the specifier identical, and the answer must move
    // with it — from `core` to external, because nothing declares
    // com.acme.core any more.
    const moved = workspaceOf({
      "packages/acme/src/main/java/com/acme/app/Application.java":
        "package com.acme.app;\nclass Application {}\n",
      "packages/core/src/main/java/com/acme/core/Kernel.java":
        "package com.acme.renamed;\nclass Kernel {}\n",
      "packages/core/src/main/java/com/acme/core/spi/KernelSpi.java":
        "package com.acme.core.spi;\nclass KernelSpi {}\n",
      "packages/util/src/main/java/com/acme/util/Strings.java":
        "package com.acme.util;\nclass Strings {}\n",
    });
    const caller = "package com.acme.app;\nimport com.acme.core.Kernel;\nclass A { Kernel k; }\n";
    const before = analyzeIn(workspace, "packages/acme/src/main/java/com/acme/app/A.java", caller);
    expect(before.imports[0].resolved.target).toBe("core");
    const after = analyzeIn(moved, "packages/acme/src/main/java/com/acme/app/A.java", caller);
    expect(after.imports[0].resolved.target).toBeNull();
    expect(after.imports[0].resolved.external).toBe(true);
    expect(after.imports[0].resolved.packageName).toBe("com.acme.core.Kernel");
  });

  it("marks an import landing in its own project spelling.relative=true", () => {
    const workspace = baseWorkspace();
    const inner =
      "package com.acme.core.spi;\nimport com.acme.core.Kernel;\nclass S extends Kernel {}\n";
    const result = analyzeIn(
      workspace,
      "packages/core/src/main/java/com/acme/core/spi/S.java",
      inner,
    );
    expect(result.imports[0].spelling.relative).toBe(true);
    expect(result.imports[0].resolved.target).toBe("core");
  });

  it("classifies externals with the full written name and no edge", () => {
    const workspace = baseWorkspace();
    const caller =
      "package com.acme.app;\n" +
      "import org.apache.commons.lang3.StringUtils;\n" +
      "import java.util.List;\n" +
      "class A {}\n";
    const result = analyzeIn(workspace, "packages/acme/src/main/java/com/acme/app/A.java", caller);
    const [apache, jl] = result.imports;
    expect(apache.resolved).toEqual({
      target: null,
      file: null,
      external: true,
      packageName: "org.apache.commons.lang3.StringUtils",
    });
    // java.lang is auto-imported anyway; written explicitly it is still just
    // an external name.
    expect(jl.resolved.external).toBe(true);
    expect(jl.resolved.packageName).toBe("java.util.List");
  });

  it("reports a split package ambiguously, naming every claimant, resolving nothing", () => {
    const files = {
      "packages/acme/src/main/java/shared/thing/A.java": "package shared.thing;\nclass A {}\n",
      "packages/core/src/main/java/shared/thing/B.java": "package shared.thing;\nclass B {}\n",
      "packages/util/src/main/java/com/acme/util/U.java": "package com.acme.util;\nclass U {}\n",
    };
    const workspace = workspaceOf(files);
    const caller = "package com.acme.util;\nimport shared.thing.Widget;\nclass C { Widget w; }\n";
    const result = analyzeIn(workspace, "packages/util/src/main/java/com/acme/util/C.java", caller);
    expect(result.imports[0].resolved).toBeNull();
    expect(result.imports[0].spelling.relative).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toContain("shared.thing");
    expect(result.failures[0].reason).toContain("acme");
    expect(result.failures[0].reason).toContain("core");
    expect(result.failures[0].line).toBe(2);
  });

  it("counts nothing from comments or literals — the loud-direction guards", () => {
    const workspace = baseWorkspace();
    const tricky = [
      "package com.acme.app;",
      "/** Javadoc {@code import com.acme.core.Ghost;} */",
      "// import com.acme.core.Commented;",
      'String s = "import com.acme.core.InString;";',
      'String doc = """',
      "     import com.acme.core.InTextBlock;",
      '     """;',
      "/* import com.acme.core.InBlock; */",
      "class A {}",
    ].join("\n");
    expect(maskJavaComments(tricky)).not.toContain("Ghost");
    const result = analyzeIn(workspace, "packages/acme/src/main/java/com/acme/app/A.java", tricky);
    expect(result.imports).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("never throws on malformed input — records survive, failures carry it", () => {
    const hostile = {
      ...baseWorkspace(),
      readFile: (path) => {
        if (path.endsWith("Kernel.java")) throw new Error("disk exploded");
        return baseWorkspace().readFile(path);
      },
    };
    const caller = "package com.acme.app;\nimport com.acme.core.Kernel;\nclass A {}\n";
    const result = analyzeIn(hostile, "packages/acme/src/main/java/com/acme/app/A.java", caller);
    expect(result.imports).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].line).toBeNull(); // whole-file failure shape
    expect(result.failures[0].reason).toContain("disk exploded");
  });

  it("leaves fully-qualified inline uses unseen — the documented silence", () => {
    const workspace = baseWorkspace();
    const fqnOnly = "package com.acme.app;\nclass A {\n  com.acme.core.Kernel k;\n}\n";
    const result = analyzeIn(workspace, "packages/acme/src/main/java/com/acme/app/A.java", fqnOnly);
    expect(result.imports).toEqual([]);
    expect(result.failures).toEqual([]);
  });
});

describe("resolveJavaDependencies", () => {
  it("draws one edge per crossing project pair, skipping self and externals", () => {
    const workspace = baseWorkspace();
    // The fixture index files declare no imports of their own, so a tree
    // without callers holds no edges — the empty answer is about coverage,
    // not absence of the resolver.
    expect(resolveJavaDependencies(workspace)).toEqual([]);

    const tree = {
      "packages/acme/src/main/java/com/acme/app/App.java":
        "package com.acme.app;\nimport com.acme.core.Kernel;\nimport com.acme.util.Strings;\nclass App {}\n",
      "packages/core/src/main/java/com/acme/core/Kernel.java":
        "package com.acme.core;\nimport com.acme.core.spi.X;\nclass Kernel {}\n",
      "packages/core/src/main/java/com/acme/core/spi/X.java":
        "package com.acme.core.spi;\nclass X {}\n",
      "packages/util/src/main/java/com/acme/util/Strings.java":
        "package com.acme.util;\nclass Strings {}\n",
    };
    const ws2 = workspaceOf(tree);
    const edges = resolveJavaDependencies(ws2);
    expect(edges).toEqual([
      {
        source: "acme",
        target: "core",
        sourceFile: "packages/acme/src/main/java/com/acme/app/App.java",
        type: "static",
      },
      {
        source: "acme",
        target: "util",
        sourceFile: "packages/acme/src/main/java/com/acme/app/App.java",
        type: "static",
      },
    ]);
  });

  it("skips an ambiguous name rather than drawing an edge against a guess", () => {
    const tree = {
      "packages/acme/src/main/java/shared/thing/A.java": "package shared.thing;\nclass A {}\n",
      "packages/core/src/main/java/shared/thing/B.java": "package shared.thing;\nclass B {}\n",
      "packages/util/src/main/java/com/acme/util/C.java":
        "package com.acme.util;\nimport shared.thing.W;\nclass C {}\n",
    };
    const ws = workspaceOf(tree);
    expect(resolveJavaDependencies(ws)).toEqual([]);
  });
});

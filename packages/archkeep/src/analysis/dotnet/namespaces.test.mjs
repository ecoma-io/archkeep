import { describe, expect, it } from "vitest";

import { csharpNamespaceIndex, parseCSharpNamespaceDeclarations } from "./namespaces.mjs";

describe("parseCSharpNamespaceDeclarations", () => {
  it("reads the block form at a line head", () => {
    const masked = "namespace A.B.C\n{\n    class T {}\n}\n";
    const declarations = parseCSharpNamespaceDeclarations(masked);
    expect(declarations).toHaveLength(1);
    expect(declarations[0].name).toBe("A.B.C");
    // The offset points at the NAME in the original coordinate system.
    expect(masked.slice(declarations[0].offset, declarations[0].offset + 5)).toBe("A.B.C");
  });

  it("reads a declaration indented at its own line start, as the JVM package parse tolerates one", () => {
    // Whitespace between the line break and the keyword is layout, not code;
    // the JVM package reader allows the same slack.
    const masked = "\n    namespace A.B;\n";
    expect(parseCSharpNamespaceDeclarations(masked)).toHaveLength(1);
  });

  it("does not read keyword text that never starts a line as a declaration", () => {
    const masked = 'string s = "one"; class X { namespace A.B {} }\n';
    expect(parseCSharpNamespaceDeclarations(masked)).toEqual([]);
  });

  it("reads the file-scoped form", () => {
    const declarations = parseCSharpNamespaceDeclarations("namespace A.B;\nclass T {}\n");
    expect(declarations).toHaveLength(1);
    expect(declarations[0].name).toBe("A.B");
  });

  it("tolerates spaces around dots", () => {
    const declarations = parseCSharpNamespaceDeclarations("namespace A . B ;\n");
    expect(declarations[0].name).toBe("A.B");
  });

  it("reads every declaration in one file, including a reopened name once per file at index time", () => {
    const masked = [
      "namespace Outer.One;",
      "class One {}",
      "namespace Outer.Two { }",
      "namespace Outer.One { }",
    ].join("\n");
    const names = parseCSharpNamespaceDeclarations(masked).map((d) => d.name);
    expect(names).toEqual(["Outer.One", "Outer.Two", "Outer.One"]);
  });

  it("matches through a leading UTF-8 BOM and still indexes the original offsets", () => {
    const masked = "\uFEFFnamespace A.B;\n";
    const declarations = parseCSharpNamespaceDeclarations(masked);
    expect(declarations).toHaveLength(1);
    expect(declarations[0].name).toBe("A.B");
    // The offset points at the NAME, not at the BOM or the keyword.
    expect(masked.slice(declarations[0].offset, declarations[0].offset + 3)).toBe("A.B");
  });

  it("does not read a verbatim identifier named namespace as a declaration", () => {
    const masked = "var @namespace = 1;\nint y = 2;\n";
    expect(parseCSharpNamespaceDeclarations(masked)).toEqual([]);
  });

  it("does not read mid-line keyword text as a declaration", () => {
    const masked = "class NamespaceUser { }\n// namespace Fake.Never\n";
    expect(parseCSharpNamespaceDeclarations(masked)).toEqual([]);
  });
});

/** An in-memory workspace over a small two-project tree. */
function workspaceOf(files) {
  const projects = [
    { name: "alpha", root: "libs/alpha" },
    { name: "beta", root: "libs/beta" },
  ];
  return {
    projects,
    filesOf: (name) =>
      Object.keys(files).filter((file) =>
        file.startsWith(name === "alpha" ? "libs/alpha" : "libs/beta"),
      ),
    readFile: (path) => files[path] ?? null,
  };
}

describe("csharpNamespaceIndex", () => {
  it("maps declared namespaces to their owning project", () => {
    const workspace = workspaceOf({
      "libs/alpha/One.cs": "namespace Alpha.Core;\n",
      "libs/beta/Two.cs": "namespace Beta.Things;\n",
    });
    const index = csharpNamespaceIndex(workspace);
    expect(index.get("Alpha.Core")).toEqual([{ project: "alpha", file: "libs/alpha/One.cs" }]);
    expect(index.get("Beta.Things")).toEqual([{ project: "beta", file: "libs/beta/Two.cs" }]);
  });

  it("records both owners when two projects declare the same namespace", () => {
    const workspace = workspaceOf({
      "libs/alpha/Shared.cs": "namespace Common.Util;\n",
      "libs/beta/Shared.cs": "namespace Common.Util;\n",
    });
    const owners = csharpNamespaceIndex(workspace).get("Common.Util");
    expect(owners.map((owner) => owner.project).sort()).toEqual(["alpha", "beta"]);
  });

  it("deduplicates a reopened namespace within one file to one entry", () => {
    const workspace = workspaceOf({
      "libs/alpha/Parts.cs": "namespace Alpha.Core; class A {}\nnamespace Alpha.Core { }\n",
    });
    const owners = csharpNamespaceIndex(workspace).get("Alpha.Core");
    expect(owners).toEqual([{ project: "alpha", file: "libs/alpha/Parts.cs" }]);
  });

  it("ignores non-C# files and unreadable paths instead of guessing ownership", () => {
    const workspace = workspaceOf({
      "libs/alpha/readme.md": "namespace Not.Really;\n",
      "libs/beta/gone.cs": null,
    });
    expect(csharpNamespaceIndex(workspace).size).toBe(0);
  });

  it("moves the answer when a declaration moves — resolution is content-derived", () => {
    // The anti-hardcoded-map rule: repointing a namespace declaration without
    // changing any importer must move who owns the name.
    const before = workspaceOf({
      "libs/alpha/Core.cs": "namespace Alpha.Core;\n",
    });
    const after = workspaceOf({
      "libs/beta/Core.cs": "namespace Alpha.Core;\n",
    });
    expect(csharpNamespaceIndex(before).get("Alpha.Core")[0].project).toBe("alpha");
    expect(csharpNamespaceIndex(after).get("Alpha.Core")[0].project).toBe("beta");
  });
});

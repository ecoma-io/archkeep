import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import {
  jvmIndexFailures,
  jvmPackageIndex,
  parseJvmPackageDeclaration,
  resolveJvmPackagePrefix,
} from "./packages.mjs";
import { maskJavaComments } from "./mask.mjs";

describe("parseJvmPackageDeclaration", () => {
  const declaredIn = (source) => {
    const masked = maskJavaComments(source);
    return parseJvmPackageDeclaration(masked);
  };

  it("reads a simple declaration and points at the name", () => {
    const source = "package com.acme.app;\n\nclass A {}\n";
    const declared = declaredIn(source);
    expect(declared.name).toBe("com.acme.app");
    expect(source.slice(declared.offset, declared.offset + "com.acme.app".length)).toBe(
      "com.acme.app",
    );
  });

  it("reads the first declaration only — later package tokens are not declarations", () => {
    // JLS §7.3 confines the declaration to the header; a second line is text
    // the file holds but no fact about ownership.
    const source = 'package real.one;\nclass X {\n  String s = "package fake.two";\n}\n';
    expect(declaredIn(source).name).toBe("real.one");
  });

  it("does not read a package token that is not at a line head", () => {
    const source = "class X { int package_; }\n// package commented.out;\nvoid f() {}\n";
    expect(declaredIn(source)).toBeNull();
  });

  it("tolerates a UTF-8 BOM before the declaration (#221's lesson)", () => {
    const source = "\uFEFFpackage com.acme.tool;\n";
    expect(parseJvmPackageDeclaration(source).name).toBe("com.acme.tool");
  });

  it("accepts spaces around the dots — legal if absurd", () => {
    const source = "package com . acme . deep ;\n";
    expect(declaredIn(source).name).toBe("com.acme.deep");
  });

  it("accepts a Kotlin-style missing semicolon", () => {
    const source = "package com.acme.kt\n\nfun main() {}\n";
    expect(declaredIn(source).name).toBe("com.acme.kt");
  });

  it("never reads a package-less file's first import as a package named 'import'", () => {
    // The Kotlin default-package shape: no declaration, imports from line
    // one. A lenient `package\s+name` would match across the newline and
    // crown "import" a package — every such file would then claim an index
    // entry no real package holds.
    const source = "import one.pkg.A\nimport two.pkg.B\nfun main() {}\n";
    expect(declaredIn(source)).toBeNull();
  });

  it("reads a Java same-line header: package then import after the semicolon", () => {
    const source = "package head.p; import other.q.R;\nclass C {}\n";
    const declared = declaredIn(source);
    expect(declared.name).toBe("head.p");
    expect(source.slice(declared.offset, declared.offset + "head.p".length)).toBe("head.p");
  });

  it("returns null for a default-package file", () => {
    expect(declaredIn("class Default {}\n")).toBeNull();
  });

  it("returns null for an empty file", () => {
    expect(declaredIn("")).toBeNull();
  });
});

/** An in-memory workspace in the shape every analyzer test injects. */
const workspaceOf = (files) => {
  const projects = [...new Set(Object.keys(files).map((file) => file.split("/")[0]))].map(
    (root) => ({ name: root === "" ? "root" : root, root }),
  );
  return {
    root: "/workspace",
    projects,
    filesOf: (name) => Object.keys(files).filter((f) => f.startsWith(`${name}/`)),
    readFile: (path) => files[path] ?? null,
  };
};

describe("jvmPackageIndex", () => {
  it("attributes packages by declared content, not directory layout", () => {
    // Directory says one thing, the package line another: the line wins,
    // which is the entire reason the index reads content.
    const workspace = workspaceOf({
      "app/src/main/java/com/acme/A.java": "package other.place;\nclass A {}\n",
    });
    expect([...jvmPackageIndex(workspace).byName.keys()]).toEqual(["other.place"]);
  });

  it("indexes Kotlin sources into the SAME map as Java ones", () => {
    const workspace = workspaceOf({
      "lib/src/main/kotlin/com/acme/K.kt": '@file:JvmName("K")\npackage com.acme.shared\n',
      "lib/src/main/java/com/acme/J.java": "package com.acme.other;\nclass J {}\n",
    });
    const { byName: index } = jvmPackageIndex(workspace);
    expect(index.get("com.acme.shared")[0].file).toContain(".kt");
    expect(index.get("com.acme.other")[0].file).toContain(".java");
  });

  it("keeps one entry per claiming project when two declare the same name", () => {
    const workspace = workspaceOf({
      "a/A.java": "package shared.pkg;\nclass A {}\n",
      "b/B.java": "package shared.pkg;\nclass B {}\n",
    });
    expect(
      jvmPackageIndex(workspace)
        .byName.get("shared.pkg")
        .map((o) => o.project),
    ).toEqual(["a", "b"]);
  });

  it("records an unreadable .java or .kt as a whole-file failure instead of dropping it", () => {
    // A file dropped from the index silently would make every import of its
    // package classify external — a first-party crossing wearing an external
    // face, the silent direction #374 names. Both extensions, because one
    // index spans them: a mixed Java/Kotlin module compiles into one package
    // namespace, so the drop is the same defect whichever half declares the
    // package. The failure funnels through jvmIndexFailures into the
    // could-not-complete class instead — the .NET twin's discipline
    // (`../dotnet/namespaces.test.mjs`).
    const workspace = workspaceOf({
      "a/gone.java": null,
      "b/vanished.kt": null,
      "a/Default.java": "class D {}\n",
      "a/Known.java": "package a.known;\nclass K {}\n",
    });
    const { byName, failures } = jvmPackageIndex(workspace);
    // A default-package file still contributes nothing — that skip is a fact
    // about the file, not a hole in the read.
    expect([...byName.keys()]).toEqual(["a.known"]);
    expect(failures).toHaveLength(2);
    expect(failures.map((failure) => failure.sourceFile).sort()).toEqual([
      "a/gone.java",
      "b/vanished.kt",
    ]);
    expect(failures.every((failure) => failure.reason.match(/could not be read/))).toBe(true);
    expect(jvmIndexFailures(workspace)).toEqual(failures);
  });
});

describe("resolveJvmPackagePrefix", () => {
  const index = new Map([
    ["com", [{ project: "root-lib", file: "L.java" }]],
    ["com.acme", [{ project: "acme", file: "A.java" }]],
    ["com.acme.core", [{ project: "core", file: "C.java" }]],
  ]);

  it("resolves to the DEEPEST declared prefix, never a shallow parent", () => {
    expect(resolveJvmPackagePrefix("com.acme.core.util.Lists", index).prefix).toBe("com.acme.core");
  });

  it("falls back to shorter prefixes the deeper ones leave unclaimed", () => {
    expect(resolveJvmPackagePrefix("com.acme.tools.Helper", index).prefix).toBe("com.acme");
    expect(resolveJvmPackagePrefix("com.orphan.X", index).prefix).toBe("com");
  });

  it("returns null when no prefix matches — outside every tracked project", () => {
    expect(resolveJvmPackagePrefix("org.apache.commons.LangUtils", index)).toBeNull();
    expect(resolveJvmPackagePrefix("java.lang.String", index)).toBeNull();
  });
});

const dottedName = fc
  .array(fc.constantFrom(..."abcdefgh"), { minLength: 1, maxLength: 5 })
  .map((parts) => parts.join("."));

describe("resolveJvmPackagePrefix properties", () => {
  test.prop([dottedName])("every resolved prefix is a dot-prefix of the specifier", (specifier) => {
    const index = new Map([
      [specifier, [{ project: "p", file: "F.java" }]],
      ["", []],
    ]);
    const resolved = resolveJvmPackagePrefix(`z.${specifier}.y`, index);
    if (!resolved) return;
    expect(`z.${specifier}.y`.startsWith(resolved.prefix)).toBe(true);
  });
});

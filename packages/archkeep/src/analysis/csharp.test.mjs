import { describe, expect, it } from "vitest";

import { dotnetIndexFailures } from "./dotnet/namespaces.mjs";

import { analyzeCSharp, parseCSharpDirectiveSites, resolveCsharpDependencies } from "./csharp.mjs";

/**
 * An in-memory workspace whose `readFile` backs a real fixture tree — the
 * same shape every analyzer's suite drives. The index is content-derived, so
 * repointing a namespace declaration must move the answer (the
 * anti-hardcoded-map rule); several tests below pin exactly that.
 */
function workspaceOf(files) {
  const projects = [
    { name: "shop-domain", root: "libs/shop/domain" },
    { name: "shop-app", root: "libs/shop/app" },
    { name: "shared-kernel", root: "libs/shared/kernel" },
  ];
  const rootOf = {
    "shop-domain": "libs/shop/domain",
    "shop-app": "libs/shop/app",
    "shared-kernel": "libs/shared/kernel",
  };
  return {
    root: "/w",
    projects,
    filesOf: (name) => Object.keys(files).filter((file) => file.startsWith(`${rootOf[name]}/`)),
    readFile: (path) => files[path] ?? null,
  };
}

const WORKSPACE = workspaceOf({
  "libs/shop/domain/Policy.cs": "namespace Shop.Domain;\n\npublic sealed class Policy { }\n",
  "libs/shop/domain/Deep.cs": "namespace Shop.Domain.Rules;\n\ninternal class Deep { }\n",
  "libs/shop/app/Service.cs": "",
  "libs/shared/kernel/Clock.cs": "namespace Shared.Kernel;\n\npublic class Clock { }\n",
});

describe("parseCSharpDirectiveSites", () => {
  it("reads the plain namespace form", () => {
    const sites = parseCSharpDirectiveSites("using Shop.Domain;\n");
    expect(sites).toHaveLength(1);
    expect(sites[0].specifier).toBe("Shop.Domain");
    expect(sites[0].importableName).toBe("Shop.Domain");
  });

  it("reads global and static forms with their keywords out of resolution", () => {
    const sites = parseCSharpDirectiveSites(
      "global using Shop.Domain;\nusing static Shop.Domain.Policy;\n",
    );
    expect(sites.map((site) => site.importableName)).toEqual(["Shop.Domain", "Shop.Domain.Policy"]);
  });

  it("resolves an alias by its right-hand side and keeps it out of the specifier position", () => {
    const source = "using Policies = Shop.Domain.Rules;\nclass C { }\n";
    const sites = parseCSharpDirectiveSites(source);
    expect(sites[0].specifier).toBe("Shop.Domain.Rules");
    expect(sites[0].importableName).toBe("Shop.Domain.Rules");
    // The offset points at the specifier's own start — the right-hand side.
    expect(source.slice(sites[0].offset, sites[0].offset + sites[0].specifier.length)).toBe(
      sites[0].specifier,
    );
  });

  it("strips a generic argument list from an alias's right-hand side", () => {
    const sites = parseCSharpDirectiveSites("using Grid = Shop.Domain.Grid<Policy>;\n");
    expect(sites[0].importableName).toBe("Shop.Domain.Grid");
  });

  it("classifies a tuple alias external without consulting any project", () => {
    const sites = parseCSharpDirectiveSites("using Pair = (int, string);\n");
    expect(sites[0].specifier).toBe("(int, string)");
    expect(sites[0].importableName).toBeNull();
  });

  it("records an extern alias as a site that resolves to nothing", () => {
    const sites = parseCSharpDirectiveSites("extern alias LegacyLib;\n");
    expect(sites[0].specifier).toBe("LegacyLib");
    expect(sites[0].importableName).toBeNull();
  });

  it("reads the global:: qualifier in every form and keeps it out of the specifier", () => {
    const sites = parseCSharpDirectiveSites(
      "using global::Shop.Domain;\nusing static global::Shop.Domain.Policy;\nusing Alias = global::Shop.Domain.Rules;\n",
    );
    expect(sites.map((site) => site.specifier)).toEqual([
      "Shop.Domain",
      "Shop.Domain.Policy",
      "Shop.Domain.Rules",
    ]);
    expect(sites.map((site) => site.importableName)).toEqual([
      "Shop.Domain",
      "Shop.Domain.Policy",
      "Shop.Domain.Rules",
    ]);
  });

  it("reads a directive on the same line as a brace", () => {
    const source = "namespace N { using A.B; }\n";
    const sites = parseCSharpDirectiveSites(source);
    expect(sites.map((site) => site.specifier)).toEqual(["A.B"]);
    expect(source.slice(sites[0].offset, sites[0].offset + 3)).toBe("A.B");
  });

  it("reads both directives when two share a line — the `;` anchors, never consumed (#407)", () => {
    // Consuming the `;` left the scan past the second directive's only legal
    // anchor, so `using A.B; using C.D;` read only `A.B`.
    const source = "using A.B; using C.D;\n";
    const sites = parseCSharpDirectiveSites(source);
    expect(sites.map((site) => site.specifier)).toEqual(["A.B", "C.D"]);
    for (const site of sites) {
      expect(source.slice(site.offset, site.offset + site.specifier.length)).toBe(site.specifier);
    }
  });

  it("matches a first-line directive through a UTF-8 BOM at its disk offset", () => {
    // The BOM is matched, not stripped: the offset indexes the bytes on disk,
    // so the reported column counts the BOM itself — the same answer the JVM
    // package declaration gives behind that byte (#221's lesson).
    const source = "﻿using Shop.Domain;\n";
    const sites = parseCSharpDirectiveSites(source);
    expect(sites.map((site) => site.specifier)).toEqual(["Shop.Domain"]);
    expect(source.slice(sites[0].offset, sites[0].offset + "Shop".length)).toBe("Shop");
  });

  it("never reads a using STATEMENT as a directive — all three shapes stay unread", () => {
    const source = [
      "class C",
      "{",
      "    void M()",
      "    {",
      "        using (var r = Open()) { }",
      "        using var s = Open();",
      "        using StreamReader t = Open();",
      "        using (Open()) { /* scoped */ }",
      "    }",
      "}",
    ].join("\n");
    expect(parseCSharpDirectiveSites(source)).toEqual([]);
  });

  it("does not read directives inside comments or string literals", () => {
    const source = [
      "// using Fake.Commented;",
      "/* using Fake.Blocked; */",
      'var hint = "using Fake.Quoted;";',
      "using Real.One;",
    ].join("\n");
    expect(parseCSharpDirectiveSites(source).map((site) => site.specifier)).toEqual(["Real.One"]);
  });
});

describe("analyzeCSharp", () => {
  it("resolves a cross-project using into the owning project and records the site", () => {
    const result = analyzeCSharp({
      sourceFile: "libs/shop/app/Service.cs",
      text: "using Shop.Domain;\nusing Shared.Kernel;\n",
      workspace: WORKSPACE,
    });
    expect(result.failures).toEqual([]);
    expect(result.imports).toHaveLength(2);
    expect(result.imports[0]).toMatchObject({
      sourceFile: "libs/shop/app/Service.cs",
      line: 1,
      column: 7,
      specifier: "Shop.Domain",
      kind: "static",
      resolved: { target: "shop-domain", file: null, external: false, packageName: null },
    });
    expect(result.imports[0].spelling).toEqual({ path: false, relative: false, namesOnly: true });
  });

  it("marks an intra-project directive relative and still emits it", () => {
    const result = analyzeCSharp({
      sourceFile: "libs/shop/domain/Rules.cs",
      text: "namespace Shop.Domain.Rules;\nusing Shop.Domain;\n",
      workspace: WORKSPACE,
    });
    // `Shop.Domain` resolves into shop-domain itself — the longest-prefix
    // walk stops at the DEEPEST declared prefix (`Shop.Domain.Rules` is also
    // shop-domain's), so this stays intra-project either way.
    expect(result.imports[0].spelling.relative).toBe(true);
    expect(result.imports[0].resolved.target).toBe("shop-domain");
  });

  it("classifies framework and NuGet namespaces external with the whole written name", () => {
    const result = analyzeCSharp({
      sourceFile: "libs/shop/app/Service.cs",
      text: "using System.Collections.Generic;\nusing Serilog.Configuration;\n",
      workspace: WORKSPACE,
    });
    expect(result.failures).toEqual([]);
    expect(result.imports[0].resolved).toEqual({
      target: null,
      file: null,
      external: true,
      packageName: "System.Collections.Generic",
    });
    expect(result.imports[1].resolved.packageName).toBe("Serilog.Configuration");
  });

  it("reports an ambiguous namespace loudly instead of guessing an owner", () => {
    const ambiguous = workspaceOf({
      "libs/shop/domain/One.cs": "namespace Clash.Here;\n",
      "libs/shop/app/Two.cs": "namespace Clash.Here;\n",
      "libs/shared/kernel/User.cs": "",
    });
    const result = analyzeCSharp({
      sourceFile: "libs/shared/kernel/User.cs",
      text: "using Clash.Here;\n",
      workspace: ambiguous,
    });
    expect(result.imports[0].resolved).toBeNull();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toContain(
      "'Clash.Here' is declared by more than one project",
    );
    expect(result.failures[0].reason).toContain("shop-domain, shop-app");
    expect(result.failures[0].line).toBe(1);
  });

  it("moves the answer when a declaration moves — resolution is content-derived", () => {
    const before = analyzeCSharp({
      sourceFile: "libs/shop/app/Service.cs",
      text: "using Shared.Kernel;\n",
      workspace: WORKSPACE,
    }).imports[0];
    expect(before.resolved.target).toBe("shared-kernel");

    const repointed = workspaceOf({
      "libs/shop/app/Clock.cs": "namespace Shared.Kernel;\n",
    });
    const after = analyzeCSharp({
      sourceFile: "libs/shop/app/Service.cs",
      text: "using Shared.Kernel;\n",
      workspace: repointed,
    }).imports[0];
    // The same specifier now resolves INTO the importing project.
    expect(after.resolved.target).toBe("shop-app");
    expect(after.spelling.relative).toBe(true);
  });

  it("answers external rather than throwing when the index cannot read — loudly at the funnel", () => {
    const broken = { ...WORKSPACE, readFile: () => null };
    const result = analyzeCSharp({
      sourceFile: "libs/shop/app/Service.cs",
      text: "using Shop.Domain;\n",
      // The analyzer itself still answers — external, never a throw — while
      // the unreadable sources surface as whole-file failures through
      // dotnetIndexFailures, which the command context funnels into the
      // could-not-complete class: the run never mistakes this workspace for
      // a checked, clean one.
      workspace: broken,
    });
    expect(result.failures).toEqual([]);
    expect(result.imports[0].resolved.external).toBe(true);
    const indexFailures = dotnetIndexFailures(broken);
    expect(indexFailures.length).toBeGreaterThan(0);
    expect(indexFailures.every((failure) => failure.reason.match(/could not be read/))).toBe(true);
  });

  it("reads a BOM-prefixed first-line directive — matched, not stripped", () => {
    const ws = workspaceOf({
      "libs/shop/app/Service.cs": "\ufeffusing Shop.Domain;\n",
      "libs/shop/domain/Policy.cs": WORKSPACE.readFile("libs/shop/domain/Policy.cs"),
    });
    const result = analyzeCSharp({
      sourceFile: "libs/shop/app/Service.cs",
      text: "\ufeffusing Shop.Domain;\n",
      workspace: ws,
    });
    expect(result.failures).toEqual([]);
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0].specifier).toBe("Shop.Domain");
    // The column counts the BOM, because the offset indexes the bytes on
    // disk — `../contract.md`'s byte-tolerance law, the same answer the JVM
    // declaration parse gives behind the same byte.
    expect(result.imports[0].line).toBe(1);
    expect(result.imports[0].column).toBe(8);
  });
});

describe("resolveCsharpDependencies", () => {
  it("draws cross-project edges from written usings and skips own-project ones", () => {
    const ws = workspaceOf({
      "libs/shop/app/Service.cs":
        "using Shop.Domain;\nusing Shared.Kernel;\nusing Shop.App.Internal;\n",
      "libs/shop/domain/Policy.cs": WORKSPACE.readFile("libs/shop/domain/Policy.cs"),
      "libs/shop/domain/Deep.cs": WORKSPACE.readFile("libs/shop/domain/Deep.cs"),
      "libs/shared/kernel/Clock.cs": WORKSPACE.readFile("libs/shared/kernel/Clock.cs"),
    });
    const edges = resolveCsharpDependencies(ws);
    expect(edges.sort((a, b) => a.target.localeCompare(b.target))).toEqual([
      {
        source: "shop-app",
        target: "shared-kernel",
        sourceFile: "libs/shop/app/Service.cs",
        type: "static",
      },
      {
        source: "shop-app",
        target: "shop-domain",
        sourceFile: "libs/shop/app/Service.cs",
        type: "static",
      },
    ]);
  });

  it("removes an edge when the directive behind it is deleted — the silent direction pinned", () => {
    const withEdge = workspaceOf({
      "libs/shop/app/Service.cs": "using Shop.Domain;\n",
      "libs/shop/domain/Policy.cs": WORKSPACE.readFile("libs/shop/domain/Policy.cs"),
    });
    const without = workspaceOf({
      "libs/shop/app/Service.cs": "namespace Shop.App;\n",
      "libs/shop/domain/Policy.cs": WORKSPACE.readFile("libs/shop/domain/Policy.cs"),
    });
    expect(resolveCsharpDependencies(withEdge)).toHaveLength(1);
    expect(resolveCsharpDependencies(without)).toHaveLength(0);
  });

  it("refuses the graph on a C# source the namespace index could not read", () => {
    // #364: the index failure — already a funnel failure via
    // `dotnetIndexFailures` — now refuses the graph face too, so an
    // unreadable source cannot silently degrade every importer of its
    // namespaces to external at `nx affected` time.
    const ws = {
      projects: [{ name: "shop-app", root: "libs/shop/app" }],
      filesOf: () => ["libs/shop/app/Service.cs"],
      readFile: () => null,
    };
    expect(() => resolveCsharpDependencies(ws)).toThrow(/libs\/shop\/app\/Service\.cs/);
  });
});

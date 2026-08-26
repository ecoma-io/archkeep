import { describe, expect, it } from "vitest";

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
    expect(sites[0].specifier).toBe("extern alias LegacyLib");
    expect(sites[0].importableName).toBeNull();
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
    expect(result.imports[0].spelling).toEqual({ path: false, relative: false });
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

  it("degrades a broken read into a failure record instead of throwing", () => {
    const broken = { ...WORKSPACE, readFile: () => null };
    const result = analyzeCSharp({
      sourceFile: "libs/shop/app/Service.cs",
      text: "using Shop.Domain;\n",
      // A workspace whose index build cannot read anything still answers:
      // every name falls to external, never a throw.
      workspace: broken,
    });
    expect(result.failures).toEqual([]);
    expect(result.imports[0].resolved.external).toBe(true);
  });

  it("strips UTF-8 BOM before parsing — VS default does not drop the first directive", () => {
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
    const edges = resolveCsharpDependencies(ws.projects, ws.filesOf, ws.readFile);
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
    expect(
      resolveCsharpDependencies(withEdge.projects, withEdge.filesOf, withEdge.readFile),
    ).toHaveLength(1);
    expect(
      resolveCsharpDependencies(without.projects, without.filesOf, without.readFile),
    ).toHaveLength(0);
  });
});

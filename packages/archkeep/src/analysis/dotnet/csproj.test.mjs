import { describe, expect, it } from "vitest";

import {
  parseCsproj,
  projectReferenceFacts,
  usingNamespacesOf,
  csprojEntryOf,
  resolveCsprojDependencies,
  dotnetManifestFailures,
} from "./csproj.mjs";

describe("parseCsproj", () => {
  it("parses a minimal csproj", () => {
    const result = parseCsproj(`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Domain/Domain.csproj" />
  </ItemGroup>
</Project>`);
    expect(result.reason).toBeUndefined();
    expect(result.project).toBeTruthy();
  });

  it("rejects missing <Project> element", () => {
    const result = parseCsproj(`<Root><ItemGroup></ItemGroup></Root>`);
    expect(result.reason).toMatch(/no <Project> element/);
  });

  it("rejects malformed XML", () => {
    const result = parseCsproj(`<Project><unclosed`);
    expect(result.reason).toMatch(/malformed XML/);
  });
});

describe("projectReferenceFacts", () => {
  it("extracts single ProjectReference", () => {
    const project = { ItemGroup: { ProjectReference: { "@_Include": "../Domain/Domain.csproj" } } };
    expect(projectReferenceFacts(project, "apps/myapp")).toEqual({
      paths: ["apps/Domain/Domain.csproj"],
      problems: [],
    });
  });

  it("extracts multiple ProjectReferences", () => {
    const project = {
      ItemGroup: {
        ProjectReference: [
          { "@_Include": "../Domain/Domain.csproj" },
          { "@_Include": "../Shared/Shared.csproj" },
        ],
      },
    };
    expect(projectReferenceFacts(project, "apps/myapp").paths).toEqual([
      "apps/Domain/Domain.csproj",
      "apps/Shared/Shared.csproj",
    ]);
  });

  it("normalizes Windows separators before resolving the path", () => {
    const project = {
      ItemGroup: { ProjectReference: { "@_Include": "..\\Domain\\Domain.csproj" } },
    };
    expect(projectReferenceFacts(project, "apps/myapp").paths).toEqual([
      "apps/Domain/Domain.csproj",
    ]);
  });

  it("returns empty for no references", () => {
    expect(projectReferenceFacts({}, "apps/myapp")).toEqual({ paths: [], problems: [] });
    expect(projectReferenceFacts({ PropertyGroup: {} }, "apps/myapp").paths).toEqual([]);
  });

  it("reports a ProjectReference with no readable Include as a problem, not a path", () => {
    const project = { ItemGroup: { ProjectReference: { Version: "1.0" } } };
    expect(projectReferenceFacts(project, "apps/myapp")).toEqual({
      paths: [],
      problems: ["a <ProjectReference> with no readable Include attribute"],
    });
  });

  it("reports an MSBuild placeholder Include as a problem, never a guessed path", () => {
    const project = {
      ItemGroup: { ProjectReference: { "@_Include": "$(SolutionDir)../Domain/Domain.csproj" } },
    };
    const facts = projectReferenceFacts(project, "apps/myapp");
    expect(facts.paths).toEqual([]);
    expect(facts.problems).toHaveLength(1);
    expect(facts.problems[0]).toContain("does not statically resolve");
  });

  it("collects references from Choose/When nests, not only top-level ItemGroups", () => {
    const project = {
      Choose: {
        When: {
          Condition: "'$(TargetFramework)' == 'net8.0'",
          ItemGroup: { ProjectReference: { "@_Include": "../Domain/Domain.csproj" } },
        },
      },
    };
    expect(projectReferenceFacts(project, "apps/myapp").paths).toEqual([
      "apps/Domain/Domain.csproj",
    ]);
  });
});

describe("usingNamespacesOf", () => {
  it("reads dotted Include values wherever the item sits", () => {
    const project = {
      ItemGroup: [
        { Using: { "@_Include": "Corp.Domain" } },
        {
          Using: [
            { "@_Include": "System.Linq" },
            { "@_Include": "Corp.Shared.Graph", Static: "true" },
          ],
        },
      ],
    };
    expect(usingNamespacesOf(project)).toEqual(["Corp.Domain", "System.Linq", "Corp.Shared.Graph"]);
  });

  it("skips values that are not dotted names rather than recording them", () => {
    const project = { ItemGroup: { Using: [{ "@_Include": "**" }, { "@_Include": "" }] } };
    expect(usingNamespacesOf(project)).toEqual([]);
  });
});

describe("csprojEntryOf", () => {
  it("extracts entry from well-formed csproj", () => {
    const xml = `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="../Domain/Domain.csproj" />
  </ItemGroup>
</Project>`;
    const result = csprojEntryOf("MyApp", "apps/MyApp/MyApp.csproj", xml);
    expect(result.reason).toBeUndefined();
    expect(result.problems).toEqual([]);
    expect(result.entry.projectName).toBe("MyApp");
    expect(result.entry.csprojPath).toBe("apps/MyApp/MyApp.csproj");
    expect(result.entry.projectRefPaths).toEqual(["apps/Domain/Domain.csproj"]);
  });

  it("resolves a reference from a csproj at the workspace root (#408)", () => {
    // A root-level .csproj has no `/` in its path. Before the guard, the
    // unguarded `slice(0, -1)` stripped the filename's last character —
    // `App.csproj` resolved as directory `App.cspro` — so every reference
    // landed on a path no project occupied.
    const result = csprojEntryOf(
      "RootApp",
      "RootApp.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="libs/Domain/Domain.csproj" />
  </ItemGroup>
</Project>`,
    );
    expect(result.reason).toBeUndefined();
    expect(result.problems).toEqual([]);
    expect(result.entry.projectRefPaths).toEqual(["libs/Domain/Domain.csproj"]);
  });
});

describe("resolveCsprojDependencies", () => {
  it("resolves a ProjectReference from a root-level csproj — the silent direction (#408)", () => {
    const workspace = {
      projects: [
        { name: "RootApp", root: "" },
        { name: "Domain", root: "libs/domain" },
      ],
      filesOf: (name) => {
        if (name === "RootApp") return ["RootApp.csproj"];
        if (name === "Domain") return ["libs/domain/Domain.csproj"];
        return [];
      },
      readFile: (path) => {
        if (path === "RootApp.csproj")
          return `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="libs/domain/Domain.csproj" />
  </ItemGroup>
</Project>`;
        if (path === "libs/domain/Domain.csproj")
          return `<Project Sdk="Microsoft.NET.Sdk"></Project>`;
        return null;
      },
    };
    const deps = resolveCsprojDependencies(workspace);
    expect(deps).toHaveLength(1);
    expect(deps[0].source).toBe("RootApp");
    expect(deps[0].target).toBe("Domain");
  });

  it("resolves ProjectReference to graph edge", () => {
    const workspace = {
      projects: [
        { name: "MyApp", root: "apps/myapp" },
        { name: "Domain", root: "libs/domain" },
      ],
      filesOf: (name) => {
        if (name === "MyApp") return ["apps/myapp/MyApp.csproj"];
        if (name === "Domain") return ["libs/domain/Domain.csproj"];
        return [];
      },
      readFile: (path) => {
        if (path === "apps/myapp/MyApp.csproj")
          return `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="../../libs/domain/Domain.csproj" />
  </ItemGroup>
</Project>`;
        if (path === "libs/domain/Domain.csproj")
          return `<Project Sdk="Microsoft.NET.Sdk"></Project>`;
        return null;
      },
    };
    const deps = resolveCsprojDependencies(workspace);
    expect(deps).toHaveLength(1);
    expect(deps[0].source).toBe("MyApp");
    expect(deps[0].target).toBe("Domain");
    expect(deps[0].sourceFile).toBe("apps/myapp/MyApp.csproj");
    expect(deps[0].type).toBe("static");
  });

  it("ignores PackageReference (NuGet, external)", () => {
    const workspace = {
      projects: [{ name: "MyApp", root: "apps/myapp" }],
      filesOf: () => ["apps/myapp/MyApp.csproj"],
      readFile: () => `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>`,
    };
    const deps = resolveCsprojDependencies(workspace);
    expect(deps).toHaveLength(0);
  });

  it("ignores self-references", () => {
    const workspace = {
      projects: [{ name: "Domain", root: "libs/domain" }],
      filesOf: () => ["libs/domain/Domain.csproj"],
      readFile: () => `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="Domain.csproj" />
  </ItemGroup>
</Project>`,
    };
    const deps = resolveCsprojDependencies(workspace);
    expect(deps).toHaveLength(0);
  });

  it("refuses the graph on an unreadable csproj", () => {
    const workspace = {
      projects: [{ name: "Bad", root: "bad" }],
      filesOf: () => ["bad/Bad.csproj"],
      readFile: () => null,
    };
    // #364's posture: an unreadable manifest is a could-not-complete state
    // the funnel exits 3 on, and the graph face refuses the same tree instead
    // of returning the edges it could draw without this one's.
    expect(() => resolveCsprojDependencies(workspace)).toThrow(/bad\/Bad\.csproj/);
  });

  it("draws a <Using Include> edge to the project owning the namespace", () => {
    const workspace = {
      projects: [
        { name: "MyApp", root: "apps/myapp" },
        { name: "Domain", root: "libs/domain" },
      ],
      filesOf: (name) => {
        if (name === "MyApp") return ["apps/myapp/MyApp.csproj"];
        if (name === "Domain") return ["libs/domain/Policy.cs"];
        return [];
      },
      readFile: (path) => {
        if (path === "apps/myapp/MyApp.csproj")
          return `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <Using Include="Corp.Domain" />
  </ItemGroup>
</Project>`;
        if (path === "libs/domain/Policy.cs") return "namespace Corp.Domain;\n";
        return null;
      },
    };
    const deps = resolveCsprojDependencies(workspace);
    expect(deps).toEqual([
      { source: "MyApp", target: "Domain", sourceFile: "apps/myapp/MyApp.csproj", type: "static" },
    ]);
  });

  it("keeps ONE edge when a ProjectReference and a Using name the same target", () => {
    const workspace = {
      projects: [
        { name: "MyApp", root: "apps/myapp" },
        { name: "Domain", root: "libs/domain" },
      ],
      filesOf: (name) => {
        if (name === "MyApp") return ["apps/myapp/MyApp.csproj"];
        if (name === "Domain") return ["libs/domain/Domain.csproj", "libs/domain/Policy.cs"];
        return [];
      },
      readFile: (path) => {
        if (path === "apps/myapp/MyApp.csproj")
          return `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="../../libs/domain/Domain.csproj" />
  </ItemGroup>
  <ItemGroup>
    <Using Include="Corp.Domain" />
  </ItemGroup>
</Project>`;
        if (path === "libs/domain/Domain.csproj")
          return `<Project Sdk="Microsoft.NET.Sdk"></Project>`;
        if (path === "libs/domain/Policy.cs") return "namespace Corp.Domain;\n";
        return null;
      },
    };
    const deps = resolveCsprojDependencies(workspace);
    expect(deps).toHaveLength(1);
    expect(deps[0].target).toBe("Domain");
  });

  it("draws a conditionally-present reference from inside Choose/When", () => {
    const workspace = {
      projects: [
        { name: "MyApp", root: "apps/myapp" },
        { name: "Domain", root: "libs/domain" },
      ],
      filesOf: (name) => {
        if (name === "MyApp") return ["apps/myapp/MyApp.csproj"];
        if (name === "Domain") return ["libs/domain/Domain.csproj"];
        return [];
      },
      readFile: (path) => {
        if (path === "apps/myapp/MyApp.csproj")
          return `<Project Sdk="Microsoft.NET.Sdk">
  <Choose>
    <When Condition="'$(TargetFramework)' == 'net8.0'">
      <ItemGroup>
        <ProjectReference Include="../../libs/domain/Domain.csproj" />
      </ItemGroup>
    </When>
  </Choose>
</Project>`;
        if (path === "libs/domain/Domain.csproj")
          return `<Project Sdk="Microsoft.NET.Sdk"></Project>`;
        return null;
      },
    };
    // The conditionally-absent branch would be the silent miss; the edge may
    // be spurious on the other framework, which is the self-correcting
    // direction (ADR 0006, Decision 3).
    const deps = resolveCsprojDependencies(workspace);
    expect(deps).toHaveLength(1);
    expect(deps[0].target).toBe("Domain");
  });
});

describe("dotnetManifestFailures", () => {
  it("reports unreadable csproj", () => {
    const workspace = {
      projects: [{ name: "Bad", root: "bad" }],
      filesOf: () => ["bad/Bad.csproj"],
      readFile: () => null,
    };
    const failures = dotnetManifestFailures(workspace);
    expect(failures).toHaveLength(1);
    expect(failures[0].sourceFile).toBe("bad/Bad.csproj");
    expect(failures[0].reason).toMatch(/could not be read/);
  });

  it("reports malformed csproj", () => {
    const workspace = {
      projects: [{ name: "Bad", root: "bad" }],
      filesOf: () => ["bad/Bad.csproj"],
      readFile: () => `<Project><unclosed`,
    };
    const failures = dotnetManifestFailures(workspace);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatch(/cannot be fully read/);
  });

  it("reports a ProjectReference whose Include attribute is missing", () => {
    const workspace = {
      projects: [{ name: "Bad", root: "bad" }],
      filesOf: () => ["bad/Bad.csproj"],
      readFile: () => `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference />
  </ItemGroup>
</Project>`,
    };
    const failures = dotnetManifestFailures(workspace);
    expect(failures).toHaveLength(1);
    expect(failures[0].sourceFile).toBe("bad/Bad.csproj");
    expect(failures[0].reason).toMatch(/no readable Include attribute/);
  });

  it("reports a ProjectReference that resolves to no tracked project", () => {
    const workspace = {
      projects: [{ name: "Solo", root: "libs/solo" }],
      filesOf: () => ["libs/solo/Solo.csproj"],
      readFile: () => `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="../gone/Gone.csproj" />
  </ItemGroup>
</Project>`,
    };
    const failures = dotnetManifestFailures(workspace);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toContain("libs/gone/Gone.csproj");
    expect(failures[0].reason).toContain("no tracked project owns");
  });

  it("reports a placeholder Include that cannot statically resolve", () => {
    const workspace = {
      projects: [{ name: "Props", root: "libs/props" }],
      filesOf: () => ["libs/props/Props.csproj"],
      readFile: () => `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="$(ExternalRoot)/Lib.csproj" />
  </ItemGroup>
</Project>`,
    };
    const failures = dotnetManifestFailures(workspace);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatch(/does not statically resolve/);
  });

  it("reports a <Using Include> whose namespace two projects declare", () => {
    const workspace = {
      projects: [
        { name: "One", root: "libs/one" },
        { name: "Two", root: "libs/two" },
      ],
      filesOf: (name) =>
        name === "One" ? ["libs/one/One.csproj", "libs/one/A.cs"] : ["libs/two/B.cs"],
      readFile: (path) => {
        if (path === "libs/one/One.csproj")
          return `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <Using Include="Clash.Here" />
  </ItemGroup>
</Project>`;
        if (path === "libs/one/A.cs") return "namespace Clash.Here;\n";
        if (path === "libs/two/B.cs") return "namespace Clash.Here;\n";
        return null;
      },
    };
    const failures = dotnetManifestFailures(workspace);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toContain("Clash.Here");
    expect(failures[0].reason).toContain("One, Two");
  });

  it("returns empty for valid workspace", () => {
    const workspace = {
      projects: [{ name: "App", root: "app" }],
      filesOf: () => ["app/App.csproj"],
      readFile: () => `<Project Sdk="Microsoft.NET.Sdk"></Project>`,
    };
    const failures = dotnetManifestFailures(workspace);
    expect(failures).toHaveLength(0);
  });
});

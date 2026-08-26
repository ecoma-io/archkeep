import { describe, expect, it } from "vitest";

import {
  parseCsproj,
  projectReferencePaths,
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

describe("projectReferencePaths", () => {
  it("extracts single ProjectReference", () => {
    const project = { ItemGroup: { ProjectReference: { "@_Include": "../Domain/Domain.csproj" } } };
    expect(projectReferencePaths(project, "apps/myapp")).toEqual(["apps/Domain/Domain.csproj"]);
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
    expect(projectReferencePaths(project, "apps/myapp")).toEqual([
      "apps/Domain/Domain.csproj",
      "apps/Shared/Shared.csproj",
    ]);
  });

  it("returns empty for no references", () => {
    expect(projectReferencePaths({}, "apps/myapp")).toEqual([]);
    expect(projectReferencePaths({ PropertyGroup: {} }, "apps/myapp")).toEqual([]);
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
    expect(result.entry.projectName).toBe("MyApp");
    expect(result.entry.csprojPath).toBe("apps/MyApp/MyApp.csproj");
    expect(result.entry.projectRefPaths).toEqual(["apps/Domain/Domain.csproj"]);
  });

  it("returns reason for malformed csproj", () => {
    const result = csprojEntryOf("Bad", "bad.csproj", `<Project><unclosed`);
    expect(result.reason).toMatch(/malformed XML/);
  });
});

describe("resolveCsprojDependencies", () => {
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

  it("skips unreadable csproj", () => {
    const workspace = {
      projects: [{ name: "Bad", root: "bad" }],
      filesOf: () => ["bad/Bad.csproj"],
      readFile: () => null,
    };
    const deps = resolveCsprojDependencies(workspace);
    expect(deps).toHaveLength(0);
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

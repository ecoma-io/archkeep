// .NET/C# language fixture: three `.csproj` projects with C# sources.
// Proves the two-track edge principle of
// `docs/adr/0006-dotnet-language-integration.md`: a `<ProjectReference>`
// (manifest track) and a written `using` (source track) witness the same
// boundary edge, and the graph carries it once.
//
// Architecture:
//   domain (layer:domain)           — leaf; no outbound references
//   application (layer:application) — `using Example.Domain` AND a
//                                     `<ProjectReference>` to domain: the
//                                     dual-track pair, deduped to one edge
//   api (layer:api)                 — `<ProjectReference>` to application
//                                     only, no written `using`: the
//                                     declared-only pair
//
// No .NET SDK anywhere — Archkeep statically parses `.cs` sources and
// `.csproj` manifests (ADR 0006, Decision 4). The ProjectReference paths are
// written with Windows `\` separators on purpose: separator normalization is
// part of the manifest reader's contract, and a fixture that never exercised
// it would let a reader regress to exact-match-only silently.

import { LAYERED_BOUNDARY_CONFIG } from "./boundary-law.mjs";

const PROJECT_SHELL =
  '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework>';

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function dotnetLanguageFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-lang-dotnet",
        private: true,
        type: "module",
        packageManager,
        devDependencies: {
          [packageName]: "*",
          "fast-xml-parser": "5.11.0",
        },
      },
      null,
      2,
    )}\n`,
    "archkeep.json": `${JSON.stringify(
      {
        boundaryConfig: "module-boundaries.config.mjs",
        projects: {
          declared: [
            { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
            { root: "libs/application", name: "application", tags: ["layer:application"] },
            { root: "libs/api", name: "api", tags: ["layer:api"] },
          ],
        },
        coverage: {
          exempt: [
            {
              path: "module-boundaries.config.mjs",
              reason: "workspace tooling config at the root, not itself a project",
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "module-boundaries.config.mjs": LAYERED_BOUNDARY_CONFIG,
    ".gitignore": "node_modules/\nbin/\nobj/\n",

    // Domain — leaf project, no references, no usings.
    "libs/domain/Domain.csproj": `${PROJECT_SHELL}</PropertyGroup></Project>\n`,
    "libs/domain/Name.cs": "namespace Example.Domain;\n\nclass Name {}\n",

    // Application — the dual-track pair: the written `using` is the source
    // track, the ProjectReference the manifest track. Both resolve to the
    // same application→domain edge, and the graph must carry ONE record.
    "libs/application/Application.csproj":
      `${PROJECT_SHELL}</PropertyGroup>` +
      '<ItemGroup><ProjectReference Include="..\\domain\\Domain.csproj" /></ItemGroup></Project>\n',
    "libs/application/App.cs":
      "using Example.Domain;\n\nnamespace Example.Application;\n\nclass App { Name name; }\n",

    // Api — the declared-only pair: a ProjectReference with no written
    // `using` anywhere. The manifest track alone must draw the edge.
    "libs/api/Api.csproj":
      `${PROJECT_SHELL}</PropertyGroup>` +
      '<ItemGroup><ProjectReference Include="..\\application\\Application.csproj" /></ItemGroup></Project>\n',
    "libs/api/Api.cs": "namespace Example.Api;\n\nclass Api {}\n",
  };
}

/**
 * The csproj-rename mutation: the identity anchor of a .NET project is its
 * ROOT, not its csproj filename (ADR 0006, Decision 2) — "csproj filenames
 * are arbitrary". Renaming `Application.csproj` and updating the reference
 * that lands on it must therefore move NOTHING: same projects, same edges,
 * an empty delta. Expressed as a map transform over the base fixture so the
 * old path is deleted and the reference cannot dangle.
 *
 * @param {Record<string, string>} files The base fixture's file map.
 * @returns {Record<string, string>} The renamed file map.
 */
export function withRenamedApplicationCsproj(files) {
  const renamed = { ...files };
  delete renamed["libs/application/Application.csproj"];
  renamed["libs/application/Application.Core.csproj"] =
    files["libs/application/Application.csproj"];
  renamed["libs/api/Api.csproj"] = files["libs/api/Api.csproj"].replace(
    "..\\application\\Application.csproj",
    "..\\application\\Application.Core.csproj",
  );
  return renamed;
}

/**
 * A solution file listing all three projects. Solutions are build-
 * orchestration views carrying no boundary law (ADR 0006's rejected
 * alternative): adding one must not add a project, an edge, or any
 * analyzable source — the graph must not move at all.
 *
 * @type {Record<string, string>}
 */
export const SLN_EDIT_MUTATION = {
  "Ecoma.sln": [
    "Microsoft Visual Studio Solution File, Format Version 12.00",
    "# Visual Studio Version 17",
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Domain", "libs\\domain\\Domain.csproj", "{11111111-1111-1111-1111-111111111111}"',
    "EndProject",
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Application", "libs\\application\\Application.csproj", "{22222222-2222-2222-2222-222222222222}"',
    "EndProject",
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "libs\\api\\Api.csproj", "{33333333-3333-3333-3333-333333333333}"',
    "EndProject",
    "Global",
    "\tGlobalSection(SolutionConfigurationPlatforms) = preSolution",
    "\t\tDebug|Any CPU = Debug|Any CPU",
    "\tEndGlobalSection",
    "EndGlobal",
    "",
  ].join("\n"),
};

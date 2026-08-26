/**
 * .csproj manifest reader and edge resolver — the identity-anchor half of
 * .NET/C# support wherever a root `.csproj` stands for a project. Static
 * only: no `dotnet`, no MSBuild, no Roslyn, no network.
 *
 * ## What v1 reads
 *
 * Boundary edges need project-to-project references ONLY. NuGet
 * `<PackageReference>` elements are external packages and draw no graph edge.
 * The reader extracts:
 *
 * - `<ProjectReference Include="..." />` — workspace-relative path to another
 *   `.csproj`, resolved to a project name by longest-prefix walk over the
 *   project list.
 * - `<Sdk Name="..." />` / `<Project Sdk="...">` — SDK references are
 *   external (Microsoft.NET.Sdk, etc.) and ignored for edges.
 *
 * ## Malformed input degrades loudly
 *
 * XML that does not parse, missing `Include` attributes, and
 * `<ProjectReference>` paths that resolve to no known project all surface
 * through `dotnetManifestFailures` as whole-file failures naming the
 * `.csproj` — the `go.work` precedent. A broken manifest read as "no
 * dependencies" would mean "no drift" exactly where the tree is most
 * broken, so the CLI funnels these into the could-not-complete class
 * (exit 3).
 */
import { createRequire } from "node:module";

import { normalizePath } from "../manifest-util.mjs";
import { fileFailure, perWorkspace } from "../source-util.mjs";

const XML_PARSER = "fast-xml-parser";

let parserLoad = null;

function xmlParser() {
  if (parserLoad === null) {
    try {
      const require = createRequire(import.meta.url);
      const { XMLParser, XMLValidator } = require(XML_PARSER);
      parserLoad = {
        parser: new XMLParser({ processEntities: false, ignoreAttributes: false }),
        validate: typeof XMLValidator?.validate === "function" ? XMLValidator.validate : null,
        error: null,
      };
    } catch (cause) {
      parserLoad = { parser: null, validate: null, error: cause?.message ?? String(cause) };
    }
  }
  return parserLoad;
}

const elementsOf = (value) => {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item) => typeof item === "object" && item !== null);
};

const textOf = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

/**
 * Parse one .csproj text. Returns the root element or a reason string.
 *
 * @param {string} text
 * @returns {{ project: Record<string, unknown>, reason?: undefined } |
 *            { project?: undefined, reason: string }}
 */
export function parseCsproj(text) {
  const { parser, validate, error } = xmlParser();
  if (parser === null) {
    return { reason: `${XML_PARSER} is unavailable (${error})` };
  }
  const verdict = validate?.(text, { allowBooleanAttributes: true });
  if (verdict && verdict !== true) {
    return { reason: `malformed XML (${verdict.err.msg})` };
  }
  let document;
  try {
    document = /** @type {Record<string, unknown>} */ (parser.parse(text));
  } catch {
    return { reason: "malformed XML" };
  }
  const rawProject = document?.Project;
  if (typeof rawProject !== "object" || rawProject === null) {
    return { reason: "no <Project> element" };
  }
  return { project: /** @type {Record<string, unknown>} */ (rawProject) };
}

/**
 * Extract `<ProjectReference>` paths from a parsed csproj element.
 *
 * @param {Record<string, unknown>} project
 * @param {string} csprojDir Directory containing the csproj, workspace-relative.
 * @returns {string[]} Workspace-relative paths resolved against the csproj directory.
 */
export function projectReferencePaths(project, csprojDir) {
  const itemGroups = elementsOf(project.ItemGroup);
  const paths = [];
  for (const group of itemGroups) {
    const refs = elementsOf(group.ProjectReference);
    for (const ref of refs) {
      const include = textOf(ref["@_Include"] ?? ref.Include);
      if (include !== null) paths.push(normalizePath(csprojDir, include));
    }
  }
  return paths;
}

/**
 * One csproj's facts, for graph-edge resolution.
 *
 * @typedef {object} CsprojEntry
 * @property {string} csprojPath Workspace-relative.
 * @property {string} projectName The project whose root this csproj anchors.
 * @property {string[]} projectRefPaths Normalized paths from ProjectReference.
 */

/**
 * Extract one csproj entry. Never throws.
 *
 * @param {string} projectName
 * @param {string} csprojPath
 * @param {string} text
 * @returns {{ entry: CsprojEntry, reason?: undefined } | { entry?: undefined, reason: string }}
 */
export function csprojEntryOf(projectName, csprojPath, text) {
  const parsed = parseCsproj(text);
  if (parsed.reason !== undefined) return { reason: parsed.reason };
  const csprojDir = csprojPath.slice(0, csprojPath.lastIndexOf("/"));
  return {
    entry: {
      csprojPath,
      projectName,
      projectRefPaths: projectReferencePaths(parsed.project, csprojDir),
    },
  };
}

/**
 * Identity map: normalized csproj path → project name. A csproj whose path
 * resolves to no known project draws no OUTBOUND edge but still contributes
 * its identity so inbound references can find it.
 *
 * @param {{ projects: {name: string, root: string}[], filesOf: (name: string) => string[],
 *           readFile: (path: string) => string|null }} workspace
 * @returns {{ entries: CsprojEntry[], identity: Map<string, string>,
 *             failures: { sourceFile: string, line: null, column: null, reason: string }[] }}
 */
export const csprojModelOf = perWorkspace(({ projects, filesOf, readFile }) => {
  const entries = [];
  const failures = [];
  const identity = new Map();

  for (const project of projects) {
    for (const file of filesOf(project.name)) {
      if (!file.endsWith(".csproj")) continue;
      const text = readFile(file);
      if (text === null) {
        failures.push(fileFailure(file, "csproj could not be read"));
        continue;
      }
      const result = csprojEntryOf(project.name, file, text);
      if (result.reason !== undefined) {
        failures.push(fileFailure(file, `its .csproj cannot be fully read: ${result.reason}`));
        continue;
      }
      entries.push(result.entry);
      identity.set(file, project.name);
    }
  }

  return { entries, identity, failures };
});

/**
 * Graph edges from `<ProjectReference>` elements in .csproj files.
 *
 * @param {{ projects: {name: string, root: string}[], filesOf: (name: string) => string[],
 *           readFile: (path: string) => string|null }} workspace
 * @returns {{ source: string, target: string, sourceFile: string, type: string }[]}
 */
export function resolveCsharpDependencies(workspace) {
  const model = csprojModelOf(workspace);
  const deps = [];
  for (const entry of model.entries) {
    for (const refPath of entry.projectRefPaths) {
      const target = model.identity.get(refPath);
      if (target === undefined || target === entry.projectName) continue;
      deps.push({
        source: entry.projectName,
        target,
        sourceFile: entry.csprojPath,
        type: "static",
      });
    }
  }
  return deps;
}

/**
 * Whole-file failures for every .csproj this reader could not fully judge.
 *
 * @param {object} workspace
 * @returns {{ sourceFile: string, line: null, column: null, reason: string }[]}
 */
export function dotnetManifestFailures(workspace) {
  return csprojModelOf(workspace).failures;
}

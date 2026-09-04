/**
 * .csproj manifest reader and edge resolver — the identity-anchor half of
 * .NET/C# support wherever a root `.csproj` stands for a project. Static
 * only: no `dotnet`, no MSBuild, no Roslyn, no network
 * (`docs/adr/0006-dotnet-language-integration.md`, Decision 4).
 *
 * ## What the reader extracts
 *
 * Boundary edges need project-to-project references ONLY. NuGet
 * `<PackageReference>` elements are external packages and draw no graph edge.
 * The reader extracts:
 *
 * - `<ProjectReference Include="..." />` — a path to another `.csproj`,
 *   written relative to the declaring project's directory with Windows `\`
 *   separators normalized, resolved to the project that owns the exact
 *   csproj path it lands on.
 * - `<Using Include="..." />` — a namespace made visible project-wide with
 *   no written directive (ADR 0006, Decision 4): it rides the reader and
 *   draws the edge its `using` spelling would. `Remove` items and `<Using>`
 *   items living in imported `.props` files are outside static scope — the
 *   csproj's own text is everything this reader sees.
 *
 * Elements are collected at ANY depth under `<Project>` — a plain
 * `<ItemGroup>`, but also the `<Choose>`/`<When>`/`<Otherwise>` and
 * `<Target>` nests a conditional reference lives in. Conditions are taken
 * loudly rather than evaluated: a conditionally-present reference draws its
 * possibly-spurious edge, the self-correcting direction, where skipping it
 * would risk the silent one (ADR 0006, Decision 3).
 *
 * ## Malformed input degrades loudly
 *
 * XML that does not parse, a `<ProjectReference>` with no readable `Include`
 * attribute, an `Include` holding an MSBuild placeholder (`$(…)` / `%(…)`),
 * a path that resolves to no tracked project's `.csproj`, and an ambiguous
 * `<Using>` namespace all surface through `dotnetManifestFailures` as
 * whole-file failures naming the `.csproj` — the same posture Maven's reader
 * holds for unresolvable placeholder coordinates (`../jvm/maven.mjs`), and
 * the `go.work` precedent one layer out. A broken manifest read as "no
 * dependencies" would mean "no drift" exactly where the tree is most broken,
 * so the CLI funnels these into the could-not-complete class (exit 3) — and
 * the graph resolver below THROWS on the same list (#364's posture,
 * `../source-util.mjs`'s `refuseUnreadTree`), so `nx affected` fails loudly
 * instead of under-selecting on it. One
 * reference stays quiet on purpose: a self-reference resolves to its own
 * project and draws no edge, because that csproj is legal and uninteresting.
 */
import { createRequire } from "node:module";

import { normalizePath } from "../manifest-util.mjs";
import { fileFailure, perWorkspace, refuseUnreadTree } from "../source-util.mjs";
import { csharpNamespaceIndex } from "./namespaces.mjs";
import { resolveCsharpSpecifier } from "./resolve.mjs";

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

const textOf = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

/**
 * Every element named `name` at any depth under `node`. fast-xml-parser's
 * default shape nests objects and arrays freely, so the walk handles both —
 * which is what reaches a `<ProjectReference>` inside `<Choose>`/`<When>`
 * that a top-level-only read would never see.
 *
 * @param {unknown} node
 * @param {string} name
 * @returns {Record<string, unknown>[]}
 */
function collectElements(node, name) {
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === name) {
        for (const element of Array.isArray(child) ? child : [child]) {
          if (typeof element === "object" && element !== null) found.push(element);
          // A valueless spelling — `<ProjectReference />` — arrives as an
          // empty string in fast-xml-parser's default shape; keep it as an
          // element with no facts so the missing-Include problem still fires
          // instead of the reference silently vanishing.
          else if (typeof element === "string") found.push({});
        }
      }
      walk(child);
    }
  };
  walk(node);
  return found;
}

/**
 * Parse one .csproj text. Returns the root element or a reason string.
 *
 * @param {string} text
 * @returns {{ project: Record<string, unknown>, reason?: undefined } |
 *            { project?: undefined, reason: string }}
 */
export function parseCsproj(text) {
  // used by its own test
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
 * One csproj's `<ProjectReference>` facts: the normalized workspace-relative
 * paths it declares, plus the problems that must degrade loudly instead of
 * silently erasing a declared dependency.
 *
 * @param {Record<string, unknown>} project
 * @param {string} csprojDir Directory containing the csproj, workspace-relative.
 * @returns {{ paths: string[], problems: string[] }}
 */
export function projectReferenceFacts(project, csprojDir) {
  // used by its own test
  const paths = [];
  const problems = [];
  for (const ref of collectElements(project, "ProjectReference")) {
    const include = textOf(ref["@_Include"] ?? ref.Include);
    if (include === null) {
      problems.push("a <ProjectReference> with no readable Include attribute");
      continue;
    }
    if (include.includes("$(") || include.includes("%(")) {
      problems.push(`an Include that does not statically resolve ('${include}')`);
      continue;
    }
    // MSBuild accepts either separator, and a Windows-authored tree writes
    // `\` — normalize before the path arithmetic, or the reference lands on
    // a path no identity ever held.
    paths.push(normalizePath(csprojDir, include.replace(/\\/g, "/")));
  }
  return { paths, problems };
}

/**
 * The dotted namespaces a csproj makes visible project-wide through
 * `<Using Include="…">`. v1 reads `Include` only — `Remove` items and values
 * living in imported `.props` files are outside static scope. A value that
 * is not a dotted name names no namespace any resolution could match, so it
 * is skipped rather than recorded.
 *
 * @param {Record<string, unknown>} project
 * @returns {string[]}
 */
export function usingNamespacesOf(project) {
  // used by its own test
  const namespaces = [];
  for (const item of collectElements(project, "Using")) {
    const include = textOf(item["@_Include"] ?? item.Include);
    if (include === null) continue;
    if (!/^[\p{L}_][\p{L}\p{Nd}_.]*$/u.test(include)) continue;
    namespaces.push(include);
  }
  return namespaces;
}

/**
 * One csproj's facts, for graph-edge resolution.
 *
 * @typedef {object} CsprojEntry
 * @property {string} csprojPath Workspace-relative.
 * @property {string} projectName The project whose root this csproj anchors.
 * @property {string[]} projectRefPaths Normalized paths from ProjectReference.
 * @property {string[]} usingNamespaces Dotted names from `<Using Include>`.
 */

/**
 * Extract one csproj entry. Never throws; a reference the reader cannot
 * trust arrives as a problem string rather than a path.
 *
 * @param {string} projectName
 * @param {string} csprojPath
 * @param {string} text
 * @returns {{ entry: CsprojEntry, problems: string[], reason?: undefined } |
 *            { entry?: undefined, problems?: undefined, reason: string }}
 */
export function csprojEntryOf(projectName, csprojPath, text) {
  // used by its own test
  const parsed = parseCsproj(text);
  if (parsed.reason !== undefined) return { reason: parsed.reason };
  // A manifest at the workspace root has no separator: `lastIndexOf` answers
  // -1 and the unguarded slice would strip the filename's last character —
  // `App.csproj` resolved as directory `App.cspro` (#408), so every reference
  // it declared landed on a path no project occupies. `""` is the root, the
  // same answer `../jvm/maven.mjs` and `../jvm/gradle.mjs` give their
  // root-level manifests.
  const csprojDir = csprojPath.includes("/")
    ? csprojPath.slice(0, csprojPath.lastIndexOf("/"))
    : "";
  const facts = projectReferenceFacts(parsed.project, csprojDir);
  return {
    entry: {
      csprojPath,
      projectName,
      projectRefPaths: facts.paths,
      usingNamespaces: usingNamespacesOf(parsed.project),
    },
    problems: facts.problems,
  };
}

/**
 * Identity map: normalized csproj path → project name, over the csproj files
 * the workspace's own projects track. A reference is resolved against this
 * map exactly — landing on no key is a failure the model records, never a
 * silent no-edge, because a dangling `<ProjectReference>` erases a declared
 * dependency the moment it is read as external-or-nothing.
 *
 * @param {{ projects: {name: string, root: string}[], filesOf: (name: string) => string[],
 *           readFile: (path: string) => string|null }} workspace
 * @returns {{ entries: CsprojEntry[], identity: Map<string, string>,
 *             usingEdges: { source: string, target: string, sourceFile: string, type: string }[],
 *             failures: { sourceFile: string, line: null, column: null, reason: string }[] }}
 */
const csprojModelOf = perWorkspace(({ projects, filesOf, readFile }) => {
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
      for (const problem of result.problems ?? []) {
        failures.push(fileFailure(file, `its .csproj declares ${problem}`));
      }
      entries.push(result.entry);
      identity.set(file, project.name);
    }
  }

  // Second pass, once every identity is known: a declared reference landing
  // on no tracked project's csproj is a hole in the model, not an external
  // package — external is `<PackageReference>`'s shape — and reading it as
  // "no edge" would drop a declared dependency silently.
  for (const entry of entries) {
    for (const refPath of entry.projectRefPaths) {
      if (identity.has(refPath)) continue;
      failures.push(
        fileFailure(
          entry.csprojPath,
          `its .csproj references '${refPath}', which no tracked project owns`,
        ),
      );
    }
  }

  // `<Using>` namespaces resolve through the same index the analyzer reads,
  // so one map answers who owns a name at every layer. An ambiguous owner
  // fails loudly like a directive's ambiguity would; an external namespace
  // (the SDK-fixed set and every NuGet default) draws nothing.
  const { byName: index } = csharpNamespaceIndex({ projects, filesOf, readFile });
  const usingEdges = [];
  for (const entry of entries) {
    for (const namespace of entry.usingNamespaces) {
      const resolved = resolveCsharpSpecifier(namespace, index);
      if (resolved.external) continue;
      if (resolved.ambiguous) {
        failures.push(
          fileFailure(
            entry.csprojPath,
            `its <Using Include="${namespace}"> names '${resolved.matchedPrefix}', ` +
              `declared by more than one project (${resolved.ambiguous.join(", ")})`,
          ),
        );
        continue;
      }
      if (resolved.target === entry.projectName) continue;
      usingEdges.push({
        source: entry.projectName,
        target: resolved.target,
        sourceFile: entry.csprojPath,
        type: "static",
      });
    }
  }

  return { entries, identity, usingEdges, failures };
});

/**
 * Graph edges from a workspace's `.csproj` files: one per declared
 * `<ProjectReference>`, plus one per `<Using Include>` that names another
 * tracked project's namespace. The two spellings of one dependency from the
 * same csproj yield ONE edge — the declared reference is the provenance
 * worth keeping. A model recording any could-not-complete failure refuses
 * the whole graph (#364's posture, `../source-util.mjs`'s `refuseUnreadTree`)
 * — silently omitting the affected edges is the under-selecting `nx affected`
 * this plugin exists to close.
 *
 * @param {{ projects: {name: string, root: string}[], filesOf: (name: string) => string[],
 *           readFile: (path: string) => string|null }} workspace
 * @returns {{ source: string, target: string, sourceFile: string, type: string }[]}
 * @throws {Error} when `csprojModelOf` recorded any failure, naming each
 *   csproj.
 */
export function resolveCsprojDependencies(workspace) {
  const model = csprojModelOf(workspace);
  refuseUnreadTree("the .csproj model", model.failures);
  const deps = [];
  const seen = new Set();
  for (const entry of model.entries) {
    for (const refPath of entry.projectRefPaths) {
      const target = model.identity.get(refPath);
      // `undefined` is unreachable while the refusal above holds (a dangling
      // reference is a recorded failure); kept as the belt beneath it.
      if (target === undefined || target === entry.projectName) continue;
      seen.add(`${entry.projectName} ${target} ${entry.csprojPath}`);
      deps.push({
        source: entry.projectName,
        target,
        sourceFile: entry.csprojPath,
        type: "static",
      });
    }
  }
  for (const edge of model.usingEdges) {
    if (seen.has(`${edge.source} ${edge.target} ${edge.sourceFile}`)) continue;
    deps.push(edge);
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

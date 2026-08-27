/**
 * Maven manifest reader and edge resolver — the identity-anchor half of JVM
 * support wherever a root `pom.xml` stands for a project. Static only: no
 * `mvn`, no JVM, no network (`docs/reference/languages.md` owns why graphs
 * compute on machines with no toolchain).
 *
 * ## What v1 reads, and the simplification that makes it safe
 *
 * Boundary edges need `(groupId, artifactId)` matching ONLY. Versions — hence
 * `<dependencyManagement>`, BOM imports, version ranges, mediation, and
 * profile activation — decide which jar downloads, and nothing archkeep
 * evaluates consumes that answer, so no code below ever reads a `<version>`
 * element. The version-resolution apparatus is out of scope by construction
 * rather than by omission.
 *
 * Read per ROOT pom (the one-manifest-per-project-root rule; a nested second
 * pom inside a project draws no graph edge — the documented modeling limit,
 * with analysis attributing the file instead):
 *
 * - `<groupId>` inherited along a parent chain found INSIDE the tracked tree.
 *   Each link resolves the way a reactor build resolves it: the declared
 *   `<relativePath>` first (default `../pom.xml`; a directory spelling gets
 *   `pom.xml` appended, matching Maven's own two-step resolution; an EMPTY
 *   element names no path at all — resolution by declaration only), then the
 *   parent's `(groupId, artifactId)` across every tracked root pom when the
 *   path step holds nothing. A parent neither step can name leaves the
 *   child's groupId unresolved: the project still draws its OUTBOUND edges,
 *   contributes no identity others can name, and `mavenManifestFailures`
 *   records the pom loudly — silence would read as "nobody depends on it",
 *   which is exactly what is unknown.
 * - `<properties>` merged down the same chain (nearest wins), then
 *   `-Dkey=value` lines from `.mvn/maven.config` beside the workspace root
 *   and beside the declaring project (user properties outrank pom
 *   properties). `${project.groupId}`-style built-ins resolve against the
 *   finished model. A placeholder resolving to nothing keeps its literal
 *   text visible inside a failure naming the pom — never shipped into a
 *   comparison, never silently dropped.
 * - main-scope `<dependencies>`; every scope, including `test`, draws the
 *   same edge (project granularity is the unit of law; the Gradle reader
 *   lands on the identical rule). `<profiles>` are NOT read: reading them
 *   would fabricate edges from configurations that never activate — the
 *   false-violation direction — while source-level analysis backstops
 *   whatever a skipped profile really carries.
 * - `<modules>` belong to discovery (the native provider phase), not edges.
 *
 * ## Malformed input degrades loudly
 *
 * A missing parser package, XML that does not parse, unresolvable placeholder
 * coordinates, duplicate identities across projects, and parent cycles all
 * surface through `mavenManifestFailures` as whole-file failures naming the
 * pom — the go.work precedent. A broken reactor read as "no dependencies"
 * would mean "no drift" exactly where the tree is most broken, so the CLI
 * funnels these into the could-not-complete class (exit 3) beside Python's
 * unmodelled manifests.
 */

import { createRequire } from "node:module";

import { normalizePath, resolveWithinWorkspace } from "../manifest-util.mjs";
import { fileFailure, perWorkspace } from "../source-util.mjs";

/** The parser's specifier, named once — the failure message quotes it. */
const XML_PARSER = "fast-xml-parser";

/** Resolved once, success or failure, and remembered either way. */
let parserLoad = null;

/**
 * The XML parser, loaded on first pom encounter through `createRequire`. An
 * optional peer: trees with no Maven pay nothing for it, and a missing
 * install becomes a failure record naming what is absent — never a throw
 * (`vue/compiler-sfc`'s precedent, `../vue.mjs`). Entity processing is off:
 * first-party tracked poms have no business carrying entity expansions, and
 * disabling the feature removes the XXE/billion-laughs class rather than
 * bounding it.
 */
function xmlParser() {
  if (parserLoad === null) {
    try {
      const require = createRequire(import.meta.url);
      const { XMLParser, XMLValidator } = require(XML_PARSER);
      // XMLValidator is a namespace; its .validate is the well-formedness gate.
      parserLoad = {
        parser: new XMLParser({ processEntities: false }),
        validate: typeof XMLValidator?.validate === "function" ? XMLValidator.validate : null,
        error: null,
      };
    } catch (cause) {
      parserLoad = { parser: null, validate: null, error: cause?.message ?? String(cause) };
    }
  }
  return parserLoad;
}

/**
 * Every value of a possibly-repeated element as an object list:
 * fast-xml-parser collapses singletons to scalars, and a pom with one
 * `<dependency>` must read exactly like one with two.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>[]}
 */
function elementsOf(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item) => typeof item === "object" && item !== null);
}

/** An element's trimmed text, or null when absent or empty. */
const textOf = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

/**
 * Parse one pom's text down to its `<project>` element.
 *
 * Well-formedness goes through the parser's own validator FIRST: the
 * tree-builder is lenient by design (it auto-closes unclosed tags), and a
 * pom an editor truncated mid-element must read as malformed, never as a
 * project with whatever elements happened to survive.
 *
 * @param {string} text Raw file contents.
 * @returns {{ project: Record<string, unknown>, reason?: undefined } |
 *            { project?: undefined, reason: string }}
 */
export function parsePomProject(text) {
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
  const rawProject = document?.project;
  if (typeof rawProject !== "object" || rawProject === null) {
    return { reason: "no <project> element" };
  }
  return { project: /** @type {Record<string, unknown>} */ (rawProject) };
}

/**
 * One root pom's facts. `effectiveGroupId`, `properties`, and
 * `resolvedDependencies` are filled in by the model builder — everything else
 * is what this pom itself says.
 *
 * @typedef {object} PomEntry
 * @property {string} pomPath Workspace-relative.
 * @property {string} projectName The project whose root this pom anchors.
 * @property {string|null} declaredGroupId Own `<groupId>`.
 * @property {string|null} artifactId
 * @property {{ groupId: string|null, artifactId: string|null,
 *   relativePath: string|null, explicitRemote: boolean }|null} parent
 * @property {Record<string, string>} ownProperties
 * @property {{ groupIdRaw: string, artifactIdRaw: string }[]} declaredDependencies
 * @property {string[]} declaredModules `<modules><module>` entries as written.
 * @property {string|null} effectiveGroupId
 * @property {Record<string, string>} properties Effective property table.
 * @property {{ groupId: string, artifactId: string }[]} resolvedDependencies
 */

/**
 * Extract one pom entry. Never throws; shapes it cannot trust become the
 * nulls the model builder already handles.
 *
 * @param {string} projectName
 * @param {string} pomPath
 * @param {string} text
 * @returns {{ entry: PomEntry, reason?: undefined } | { entry?: undefined, reason: string }}
 */
export function pomEntryOf(projectName, pomPath, text) {
  const parsed = parsePomProject(text);
  if (parsed.reason !== undefined) return { reason: parsed.reason };
  const project = parsed.project;

  const parentRaw = elementsOf(project.parent)[0];
  let parent = null;
  if (parentRaw) {
    const relativeText = textOf(parentRaw.relativePath);
    parent = {
      groupId: textOf(parentRaw.groupId),
      artifactId: textOf(parentRaw.artifactId),
      // Absent means Maven's documented `../pom.xml` default; present-but-
      // empty (`<relativePath/>`) means repository resolution by declaration.
      relativePath: relativeText,
      explicitRemote: relativeText === null && "relativePath" in parentRaw,
    };
  }

  const ownProperties = /** @type {Record<string, string>} */ ({});
  for (const [key, value] of Object.entries(elementsOf(project.properties)[0] ?? {})) {
    const propertyText = textOf(value);
    if (propertyText !== null) ownProperties[key] = propertyText;
  }

  const declaredDependencies = elementsOf(project.dependencies)
    .flatMap((block) => elementsOf(block.dependency))
    .map((dep) => ({
      groupIdRaw: textOf(dep.groupId) ?? "",
      artifactIdRaw: textOf(dep.artifactId) ?? "",
    }))
    .filter((dep) => dep.groupIdRaw !== "" && dep.artifactIdRaw !== "");

  // <module> children are TEXT elements, so fast-xml-parser hands them over
  // as strings (a bare string when there is one) — unlike <dependency>,
  // whose children are objects.
  const rawModules = elementsOf(project.modules)[0]?.module;
  const moduleValues = Array.isArray(rawModules)
    ? rawModules
    : rawModules === undefined
      ? []
      : [rawModules];
  const declaredModules = moduleValues
    .map((moduleName) => textOf(moduleName) ?? "")
    .filter((moduleName) => moduleName !== "");

  return {
    entry: {
      pomPath,
      projectName,
      declaredGroupId: textOf(project.groupId),
      artifactId: textOf(project.artifactId),
      parent,
      ownProperties,
      declaredDependencies,
      declaredModules,
      effectiveGroupId: null,
      properties: /** @type {Record<string, string>} */ ({}),
      resolvedDependencies: [],
    },
  };
}

/**
 * Where a parent `<relativePath>` lands — trying the file spelling and the
 * directory spelling Maven itself accepts — or null when it escapes the
 * workspace. `resolveWithinWorkspace` answers null on escape, so a
 * `../../..` chain cannot clamp onto a directory that was never in the tree.
 *
 * @param {string} pomPath The CHILD pom's workspace-relative path.
 * @param {string} relativePath As written; never empty (empty is remote).
 * @returns {string|null}
 */
export function parentPomPath(pomPath, relativePath) {
  const dir = pomPath.includes("/") ? pomPath.slice(0, pomPath.lastIndexOf("/")) : "";
  const direct = resolveWithinWorkspace(dir, relativePath);
  if (direct === null) return null;
  return direct.endsWith(".xml") ? direct : normalizePath(direct, "pom.xml");
}

/**
 * The `-Dkey=value` user properties a `.mvn/maven.config` contributes, one
 * token per line, optionally quoted. Only the two conventional locations are
 * consulted — the workspace root and the declaring project's root; a deeper
 * `.mvn` directory is a pinned limit, compensated by the loud-failure path
 * for any placeholder only it would have resolved.
 *
 * @param {(path: string) => string|null} readFile Workspace-relative reader.
 * @param {string[]} candidatePaths
 * @returns {Record<string, string>}
 */
export function mavenConfigProperties(readFile, candidatePaths) {
  const props = /** @type {Record<string, string>} */ ({});
  for (const path of candidatePaths) {
    const text = readFile(path);
    if (text === null || text === undefined) continue;
    for (const rawLine of text.split(/\r?\n/)) {
      const token = rawLine.trim().replace(/^["']+|["']+$/g, "");
      const definition = /^-D([^=]+)=(.*)$/.exec(token);
      if (definition) props[definition[1]] = definition[2];
      else {
        // `-Dkey` alone sets an empty user property in Maven.
        const bare = /^-D([^=]+)$/.exec(token);
        if (bare) props[bare[1]] = "";
      }
    }
  }
  return props;
}

/**
 * Interpolate one coordinate string against the effective table plus the
 * built-ins. Unresolvable placeholders stay visible in the output and fail
 * the coordinate, so a caller can name the pom instead of comparing against
 * a literal `${...}`.
 *
 * @param {string} value
 * @param {Record<string, string>} props
 * @param {Record<string, string>} builtins
 * @returns {{ value: string, resolved: boolean }}
 */
export function interpolateCoordinate(value, props, builtins) {
  let resolved = true;
  const out = value.replace(/\$\{([^}]+)\}/g, (_, key) => {
    if (Object.hasOwn(builtins, key)) return builtins[key];
    if (Object.hasOwn(props, key)) return props[key];
    resolved = false;
    return `\${${key}}`;
  });
  return { value: out, resolved };
}

/**
 * Build the workspace-wide Maven model once per workspace object: entries
 * with effective coordinates, the identity table, and the failures both
 * consumers read.
 *
 * @param {object} workspace `{ projects, filesOf(name), readFile(path), root? }`
 * @returns {{
 *   entries: PomEntry[],
 *   identityHolders: Map<string, { projectName: string, pomPath: string }[]>,
 *   failures: { sourceFile: string, reason: string }[]
 * }}
 */
function buildMavenModel(workspace) {
  const readFile = workspace.readFile;
  const failures = [];
  /** Every tracked file, for the module-drift check below. */
  const tracked = new Set();
  for (const project of workspace.projects) {
    for (const file of workspace.filesOf(project.name)) tracked.add(file);
  }
  /** @type {PomEntry[]} */
  const entries = [];

  // Pass 1 — parse every root pom.
  for (const project of workspace.projects) {
    const pomPath = normalizePath(project.root ?? "", "pom.xml");
    if (!workspace.filesOf(project.name).includes(pomPath)) continue;
    const text = readFile(pomPath);
    if (text === null || text === undefined) {
      failures.push({ sourceFile: pomPath, reason: "cannot be read" });
      continue;
    }
    const extracted = pomEntryOf(project.name, pomPath, text);
    if (extracted.reason !== undefined) {
      failures.push({ sourceFile: pomPath, reason: extracted.reason });
      continue;
    }
    entries.push(extracted.entry);
  }

  const entryByPomPath = new Map(entries.map((entry) => [entry.pomPath, entry]));

  // Pass 2 — parent links, each resolved the way a reactor build resolves
  // one: the declared <relativePath> first (Maven's default `../pom.xml`; a
  // directory spelling gets `pom.xml` appended), then — when that path holds
  // no tracked pom, or an empty <relativePath/> skipped the path step on
  // purpose — the parent's coordinates across every tracked root pom. A
  // reactor whose parent sits at the workspace root while its children sit
  // two levels deep is the shape the path step alone cannot serve, and the
  // coordinate step is what real Maven's own reactor resolution does there.
  /** @type {Map<string, PomEntry>} pom path -> the parent entry it resolved to. */
  const parentLink = new Map();
  for (const entry of entries) {
    const ref = entry.parent;
    if (!ref || ref.explicitRemote || ref.groupId === null) continue;
    const path = parentPomPath(entry.pomPath, ref.relativePath ?? "../pom.xml");
    const target = path === null ? undefined : entryByPomPath.get(path);
    if (target !== undefined) parentLink.set(entry.pomPath, target);
  }

  /**
   * The chain above one entry under the links resolved so far, with the pom a
   * cycle was entered through when the chain closes on itself. Pure on
   * purpose: the fixpoint below walks every entry once per round, and a walk
   * that recorded failures would record them once per round.
   *
   * @param {PomEntry} entry
   * @returns {{ chain: PomEntry[], cycleThrough: string|null }}
   */
  const walkFrom = (entry) => {
    const chain = [entry];
    const visited = new Set([entry.pomPath]);
    let current = entry;
    let cycleThrough = null;
    for (;;) {
      const next = parentLink.get(current.pomPath);
      if (next === undefined) break;
      if (visited.has(next.pomPath)) {
        cycleThrough = next.pomPath;
        break;
      }
      visited.add(next.pomPath);
      chain.push(next);
      current = next;
    }
    return { chain, cycleThrough };
  };

  // Linking iterates to a fixpoint because a parent found by coordinates can
  // complete the identity another entry's declaration is waiting on: the
  // child of a child whose groupIds both come from a root parent needs one
  // round per coordinate link. Each round links at least one more entry or
  // is the last — links only grow, over a finite set — so the loop cannot
  // outlive `entries`.
  for (;;) {
    /** Identities as they stand: "g:a" -> the entries carrying it. */
    const holdersNow = new Map();
    for (const entry of entries) {
      const { chain } = walkFrom(entry);
      const groupId = chain.find((link) => link.declaredGroupId !== null)?.declaredGroupId;
      if (groupId === undefined || entry.artifactId === null) continue;
      const key = `${groupId}:${entry.artifactId}`;
      holdersNow.set(key, [...(holdersNow.get(key) ?? []), entry]);
    }
    let linked = false;
    for (const entry of entries) {
      if (parentLink.has(entry.pomPath)) continue;
      const ref = entry.parent;
      if (!ref || ref.groupId === null || ref.artifactId === null) continue;
      // Ambiguous coordinates link nothing — pass 3 below fails the run on
      // the duplicate identity; a guess here would hide that there were two.
      const holders = holdersNow.get(`${ref.groupId}:${ref.artifactId}`);
      if (holders === undefined || holders.length !== 1) continue;
      parentLink.set(entry.pomPath, holders[0]);
      linked = true;
    }
    if (!linked) break;
  }

  // Per entry: the chain walked to its end (not just to the first groupId:
  // properties inherit from ancestors a nearer groupId would hide), its
  // failures, and its effective facts.
  for (const entry of entries) {
    const { chain, cycleThrough } = walkFrom(entry);
    if (cycleThrough !== null) {
      failures.push({
        sourceFile: entry.pomPath,
        reason: `sits on a parent cycle through ${cycleThrough}`,
      });
    }

    // Effective groupId: nearest link that declares one, own included.
    const owner = chain.find((link) => link.declaredGroupId !== null);
    entry.effectiveGroupId = owner?.declaredGroupId ?? null;
    if (entry.effectiveGroupId === null) {
      // The unresolved link belongs to the chain's top — the walk stopped
      // there — and that link's own shape decides which sentence names the
      // pom back.
      const top = chain[chain.length - 1];
      const ref = top.parent;
      failures.push({
        sourceFile: entry.pomPath,
        reason:
          ref === null
            ? "declares no groupId and no parent — its identity cannot be established"
            : ref.groupId === null
              ? "declares a <parent> without a groupId — its identity cannot be established"
              : `declares no groupId and its parent ${ref.groupId}:${ref.artifactId ?? "?"} is not a ` +
                `tracked workspace pom (${
                  ref.explicitRemote
                    ? "its <relativePath/> names no path"
                    : `looked for ${
                        parentPomPath(top.pomPath, ref.relativePath ?? "../pom.xml") ??
                        "(outside the workspace)"
                      }`
                }, and no tracked pom declares the identity ${ref.groupId}:${ref.artifactId ?? "?"})`,
      });
    }

    // Effective properties: root-most merges first, own last, then the
    // maven.config user properties on top. Both conventional locations are
    // workspace-relative paths — the workspace-root config and one beside
    // the declaring pom.
    const merged = /** @type {Record<string, string>} */ ({});
    for (let i = chain.length - 1; i >= 0; i--) Object.assign(merged, chain[i].ownProperties);
    const pomDir = entry.pomPath.includes("/")
      ? entry.pomPath.slice(0, entry.pomPath.lastIndexOf("/"))
      : "";
    Object.assign(
      merged,
      mavenConfigProperties(readFile, [
        ".mvn/maven.config",
        ...(pomDir === "" ? [] : [`${pomDir}/.mvn/maven.config`]),
      ]),
    );
    entry.properties = merged;
  }

  // Pass 3 — identities, duplicates surfaced rather than picked.
  const identityHolders = new Map();
  for (const entry of entries) {
    if (entry.effectiveGroupId === null || entry.artifactId === null) continue;
    const key = `${entry.effectiveGroupId}:${entry.artifactId}`;
    const holders = identityHolders.get(key) ?? [];
    holders.push({ projectName: entry.projectName, pomPath: entry.pomPath });
    identityHolders.set(key, holders);
  }
  for (const [key, holders] of identityHolders) {
    if (holders.length > 1) {
      failures.push({
        sourceFile: holders[0].pomPath,
        reason:
          `${holders.map((holder) => holder.pomPath).join(", ")} all declare the ` +
          `Maven identity ${key} — an edge toward either would be a guess`,
      });
    }
  }

  // Pass 3b — reactor drift: a <module> whose pom.xml the tree does not
  // track means the reactor model is incomplete — the subtree's identity
  // cannot be established and no rule can judge it. Recorded as a failure
  // naming the AGGREGATOR's pom (the go.work precedent: incompleteness here
  // is could-not-judge, not judged-and-violating), so `check` exits 3
  // instead of reporting clean over a hole.
  for (const entry of entries) {
    for (const moduleName of entry.declaredModules) {
      const dir = entry.pomPath.includes("/")
        ? entry.pomPath.slice(0, entry.pomPath.lastIndexOf("/"))
        : "";
      const childPom = resolveWithinWorkspace(dir, `${moduleName}/pom.xml`);
      if (childPom !== null && tracked.has(childPom)) continue;
      failures.push({
        sourceFile: entry.pomPath,
        reason:
          `declares module '${moduleName}' but ${childPom ?? "its pom.xml"} is not a ` +
          `tracked file — that subtree's projects cannot be discovered`,
      });
    }
  }

  // Pass 4 — dependency coordinates interpolated per declaring entry.
  for (const entry of entries) {
    const builtins = {
      "project.groupId": entry.effectiveGroupId ?? "",
      "pom.groupId": entry.effectiveGroupId ?? "",
      "project.artifactId": entry.artifactId ?? "",
      "pom.artifactId": entry.artifactId ?? "",
    };
    for (const dep of entry.declaredDependencies) {
      const groupId = interpolateCoordinate(dep.groupIdRaw, entry.properties, builtins);
      const artifactId = interpolateCoordinate(dep.artifactIdRaw, entry.properties, builtins);
      if (!groupId.resolved || !artifactId.resolved) {
        failures.push({
          sourceFile: entry.pomPath,
          reason:
            `declares a dependency whose coordinates do not statically resolve ` +
            `(${dep.groupIdRaw}:${dep.artifactIdRaw})`,
        });
        continue;
      }
      entry.resolvedDependencies.push({ groupId: groupId.value, artifactId: artifactId.value });
    }
  }

  return { entries, identityHolders, failures };
}

export const mavenModelOf = perWorkspace(buildMavenModel);

/**
 * Manifest-edge resolver: one edge per declared dependency whose coordinates
 * equal another project's SOLE identity. Collisions draw nothing here — the
 * failure list has already named them loudly.
 *
 * Takes ONE workspace-shaped object (`{ projects, filesOf, readFile }`) rather
 * than the positional triple, because the model is memoized on that object:
 * the caller's one object — shared with the source-track resolvers and with
 * `mavenManifestFailures` — is what keeps the whole model at one parse per
 * run (#363).
 *
 * @param {object} workspace `{ projects, filesOf(name), readFile(path), root? }`
 * @returns {{ source: string, target: string, sourceFile: string, type: string }[]}
 */
export function resolveMavenDependencies(workspace) {
  const model = mavenModelOf(workspace);
  const dependencies = [];
  for (const entry of model.entries) {
    for (const dep of entry.resolvedDependencies) {
      const holders = model.identityHolders.get(`${dep.groupId}:${dep.artifactId}`);
      if (!holders || holders.length !== 1) continue;
      if (holders[0].projectName === entry.projectName) continue;
      dependencies.push({
        source: entry.projectName,
        target: holders[0].projectName,
        sourceFile: entry.pomPath,
        type: "static",
      });
    }
  }
  return dependencies;
}

/**
 * Whole-file failures for every pom this reader could not fully judge — the
 * funnel `src/commands/context.mjs` spreads beside the analyzers' own
 * failures so a broken reactor exits 3 instead of reporting clean.
 *
 * @param {object} workspace
 * @returns {{ sourceFile: string, line: null, column: null, reason: string }[]}
 */
export function mavenManifestFailures(workspace) {
  return mavenModelOf(workspace).failures.map(({ sourceFile, reason }) =>
    fileFailure(sourceFile, `its pom.xml cannot be fully read: ${reason}`),
  );
}

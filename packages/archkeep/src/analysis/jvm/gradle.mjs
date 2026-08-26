/**
 * Gradle manifest reader and edge resolver — the identity-anchor half of JVM
 * support wherever a root Gradle project stands. Static only: no `gradle`,
 * no JVM, no network (`docs/adr/0005-jvm-language-integration.md` Decision 5
 * owns why graphs compute on machines with no toolchain).
 *
 * ## What v1 reads, and the simplification that makes it safe
 *
 * Boundary edges need project matching ONLY. Gradle's version catalogs,
 * dynamic versions, dependency constraints, and configurations decide which
 * artifact downloads, and nothing archkeep evaluates consumes that answer, so
 * no code below ever reads a `version:` element or a catalog's versions block.
 * The version-resolution apparatus is out of scope by construction rather
 * than by omission.
 *
 * Read per REACTOR (ADR 0005 Decision 2's directory mapping): a
 * `settings.gradle`/`settings.gradle.kts` probed at the workspace root or a
 * declared project's root — the two locations a reactor root takes in every
 * layout v1 models, the `.mvn/maven.config` precedent — defines one reactor.
 * Probing rather than walking tracked files is what makes the common layout
 * visible at all: a settings file at a workspace root that no declared
 * project owns appears in no project's `filesOf`, and a reader that found
 * manifests only there drew no edge for the whole reactor — green, and
 * hollow. `include("a:b")` maps the project path `:a:b` onto directory
 * `settingsDir/a/b`, and every declared project whose root a settings file
 * covers gets its own build file read. A settings file anywhere else, and a
 * root project's own build file when the workspace root is no declared
 * project, are unread — documented limits, not omissions. A nested second
 * build file inside one project directory draws no graph edge — the
 * documented modeling limit, with analysis attributing the file instead:
 *
 * - **Identity** from `settings.gradle` / `settings.gradle.kts`: root project
 *   name and `include(...)` declarations → the project-directory mapping
 *   (ADR 0005 Decision 2). Handles `include("a", "b")`, multi-arg includes,
 *   and ignores `includeBuild` in v1 (composite builds are a discovery-only
 *   signal for now; edges from included builds are not modeled).
 * - **Edges** from `build.gradle` / `build.gradle.kts` dependency declarations:
 *   `project(":x")` references in ANY configuration (`implementation`, `api`,
 *   `testImplementation`, `compileOnly`, `runtimeOnly`, `annotationProcessor`,
 *   custom configurations…). Both Groovy DSL (quotes optional, parentheses
 *   optional) and Kotlin DSL (strings required). Every scope, including test,
 *   draws the same edge — project granularity is the unit of law, matching the
 *   Maven reader's rule.
 * - **Version catalogs**: `libs.catalog.reference` forms are NOT read in v1.
 *   A catalog entry that cannot be resolved to a project in the same workspace
 *   stays silent (it may be an external Maven coordinate, a version reference,
 *   or a bundle — none of which are modeled here). Catalogs are a Gradle
 *   ecosystem feature that exists alongside Maven coordinates; their absence
 *   from this reader is a documented limit, not a bug.
 * - **External dependencies**: `implementation "group:artifact:version"` forms
 *   are NOT read. They resolve to artifacts from Maven Central or other
 *   repositories, not to workspace projects, so they belong to the external
 *   node synthesis layer when a rule needs a name.
 *
 * ## Malformed input degrades loudly
 *
 * A malformed settings file, a malformed build file, an `include` that maps
 * onto an untracked directory, a `project(...)` reference no settings file
 * defines, a reference whose directory no declared project owns, a
 * settings-less build file that declares project references, and two
 * settings files claiming the same directory all surface through
 * `gradleManifestFailures` as whole-file failures naming the manifest — the
 * go.work precedent. A
 * broken reactor read as "no dependencies" would mean "no drift" exactly where
 * the tree is most broken, so the CLI funnels these into the could-not-complete
 * class (exit 3) beside Python's unmodelled manifests.
 */

import { normalizePath } from "../manifest-util.mjs";
import { fileFailure, perWorkspace } from "../source-util.mjs";

/**
 * Parse one Gradle settings file's text to extract project information.
 * Handles both Groovy DSL (`settings.gradle`) and Kotlin DSL (`settings.gradle.kts`).
 *
 * Extracts:
 * - Root project name from `rootProject.name = ...` or `rootProject{name = ...}`
 * - Included projects from `include("a", "b")` or `include ":a", ":b"`
 * - Ignores `includeBuild` statements in v1 (composite builds not modeled for edges)
 *
 * @param {string} text Raw file contents.
 * @returns {{ rootProjectName: string|null, includedProjects: string[], reason?: undefined } |
 *            { rootProjectName?: undefined, includedProjects?: undefined, reason: string }}
 */
export function parseGradleSettings(text) {
  // First, remove block comments to avoid matching include statements inside them
  let processedText = text.replace(/\/\*[\s\S]*?\*\//g, "");

  // Then preprocess to handle multi-line includes by collapsing them
  // This regex finds include(...) calls and collapses newlines within them
  processedText = processedText.replace(/include\s*\([^)]*\)/g, (match) => {
    return match.replace(/\r?\n/g, " ");
  });

  const lines = processedText.split(/\r?\n/);
  let rootProjectName = null;
  const includedProjects = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and line comments
    if (trimmed === "" || trimmed.startsWith("//")) continue;

    // Parse rootProject.name = "name"
    if (trimmed.includes("rootProject.name")) {
      const nameMatch = /rootProject\.name\s*=\s*['"]([^'"]+)['"]/.exec(trimmed);
      if (nameMatch) {
        rootProjectName = nameMatch[1];
      }
    }

    // Parse rootProject { name = "xyz" }
    if (trimmed.includes("rootProject")) {
      const blockMatch = /rootProject\s*\{[^}]*name\s*=\s*['"]([^'"]+)['"]/.exec(trimmed);
      if (blockMatch) {
        rootProjectName = blockMatch[1];
      }
    }

    // Parse include("a", "b") or include ":a", ":b"
    const includeMatch = /include\s*\(([^)]*)\)/.exec(trimmed);
    if (includeMatch) {
      const args = includeMatch[1];
      // Split by commas, handling quoted strings
      const argMatches = args.match(/(['"])([^'"]+)\1/g) || [];
      for (const arg of argMatches) {
        const projectName = arg.slice(1, -1); // Remove quotes
        // Remove leading ":" if present
        const cleanName = projectName.startsWith(":") ? projectName.slice(1) : projectName;
        if (cleanName && !includedProjects.includes(cleanName)) {
          includedProjects.push(cleanName);
        }
      }
    }
  }

  if (!rootProjectName && includedProjects.length === 0) {
    return { reason: "no rootProject.name or include declarations found" };
  }

  return { rootProjectName, includedProjects };
}

/**
 * Parse one Gradle build file's text to extract project dependencies.
 * Handles both Groovy DSL (`build.gradle`) and Kotlin DSL (`build.gradle.kts`).
 *
 * Extracts `project(":x")` references from ANY configuration:
 * - implementation, api, testImplementation, compileOnly, runtimeOnly, etc.
 * - Custom configurations
 *
 * @param {string} text Raw file contents.
 * @returns {{ projectDependencies: string[], reason?: undefined } |
 *            { projectDependencies?: undefined, reason: string }}
 */
export function parseGradleBuild(text) {
  const lines = text.split(/\r?\n/);
  const projectDependencies = [];
  let inString = false;
  let stringChar = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and line comments
    if (trimmed === "" || trimmed.startsWith("//")) continue;

    let j = 0;
    let blockComment = false;

    while (j < trimmed.length) {
      const char = trimmed[j];
      const nextChar = trimmed[j + 1];

      // Handle string literals
      if (!blockComment) {
        if (!inString && (char === '"' || char === "'")) {
          inString = true;
          stringChar = char;
          j++;
          continue;
        }
        if (inString && char === stringChar) {
          // Check for escape
          if (trimmed[j - 1] !== "\\") {
            inString = false;
            stringChar = null;
          }
        }
        if (inString) {
          j++;
          continue;
        }
      }

      // Handle comments
      if (!inString) {
        if (char === "/" && nextChar === "*") {
          blockComment = true;
          j += 2;
          continue;
        }
        if (char === "*" && nextChar === "/") {
          blockComment = false;
          j += 2;
          continue;
        }
        if (blockComment) {
          j++;
          continue;
        }
        if (char === "/" && nextChar === "/") {
          break; // rest of line is comment
        }
      }

      // Match project(":name") in various forms:
      // - project(":name") - quoted
      // - project(':name') - single quoted
      // - project(":") - the root project, an empty path
      // - project(":name") with configuration
      // In Kotlin DSL: project(":name") (always quoted)
      // In Groovy DSL: project(":name") or project(':name') or project :name (no quotes)

      // Pattern 1: project(":xyz") or project(':xyz') — `[^'"]*` rather than
      // `+` so the root project's own spelling, `":"`, is read too. An empty
      // dep path resolves through the reactor map's root claim (`""`), the
      // same key every settings file registers; missing it would drop the
      // edge silently, which is the one failure this reader must not make.
      const quotedMatch = /project\s*\(\s*['"]:([^'"]*)['"]\s*\)/.exec(trimmed);
      if (quotedMatch) {
        const depName = quotedMatch[1];
        if (!projectDependencies.includes(depName)) {
          projectDependencies.push(depName);
        }
      }

      // Pattern 2: project(:xyz) - Groovy DSL without quotes
      const unquotedMatch = /project\s*\(\s*:([a-zA-Z0-9_-]+)\s*\)/.exec(trimmed);
      if (unquotedMatch) {
        const depName = unquotedMatch[1];
        if (depName && !projectDependencies.includes(depName)) {
          projectDependencies.push(depName);
        }
      }

      j++;
    }
  }

  return { projectDependencies };
}

/**
 * One declared project's Gradle facts: what its build file declares.
 *
 * @typedef {object} GradleEntry
 * @property {string} projectName The declared project's name.
 * @property {string} buildPath Workspace-relative path to its build file.
 * @property {string[]} declaredDependencies Project paths referenced by
 *   `project(":x")`, as written (`":"`-less, `":"`-separated).
 */

/** The settings basenames a reactor is recognised by. */
const SETTINGS_FILENAMES = ["settings.gradle.kts", "settings.gradle"];

/** The build basenames a project's dependency declarations live in. */
const BUILD_FILENAMES = ["build.gradle.kts", "build.gradle"];

/** The directory a workspace-relative path lives in (`""` for the root). */
const dirnameOf = (file) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");

/**
 * Build the workspace-wide Gradle model once per workspace object.
 *
 * A reactor is defined by its SETTINGS file, probed at the workspace root or
 * a declared project's root — a settings file at a root no declared project
 * owns appears in no `filesOf`, so discovery must probe rather than walk.
 * Every DECLARED project whose root a settings file covers gets its build
 * file read for `project(":x")` references, resolved through the settings'
 * path→directory map.
 *
 * @param {object} workspace `{ projects, filesOf(name), readFile(path), root? }`
 * @returns {{
 *   entries: GradleEntry[],
 *   pathToDirectory: Map<string, string>, // project path -> directory
 *   failures: { sourceFile: string, reason: string }[]
 * }}
 */
function buildGradleModel(workspace) {
  const readFile = workspace.readFile;
  const failures = [];
  /** Every tracked file, for validation. */
  const tracked = new Set();
  for (const project of workspace.projects) {
    for (const file of workspace.filesOf(project.name)) tracked.add(file);
  }

  /** Reactor map: project path (as written, ":"-less) -> directory. */
  const pathToDirectory = new Map();
  /** directory -> the settings file that claimed it, for loud duplicates. */
  const directoryOwner = new Map();

  const claim = (settingsPath, projectPath, directory) => {
    const owner = directoryOwner.get(directory);
    if (owner !== undefined) {
      failures.push({
        sourceFile: settingsPath,
        reason: `maps project ':${projectPath}' onto directory '${directory || "/"}', already claimed by ${owner}`,
      });
      return;
    }
    directoryOwner.set(directory, settingsPath);
    pathToDirectory.set(projectPath, directory);
  };

  // Pass 1 — probe for settings files at the workspace root and at each
  // declared project's root. A reactor's settings file sits at the reactor
  // root, and a reactor root is the workspace root or a declared project's
  // directory in every layout v1 models — the same two-location rule the
  // Maven reader applies to `.mvn/maven.config`. Probing `readFile` rather
  // than walking tracked files is what makes the common layout visible at
  // all: a settings file at a workspace root that no declared project owns
  // appears in no project's `filesOf`, and a reader that found manifests
  // only there drew no edge for the whole reactor — green, and hollow. A
  // settings file anywhere else is unread (a documented limit; nothing in
  // the tracked tree points at it).
  const settingsFiles = [];
  const candidateDirs = new Set([
    "",
    ...workspace.projects.map((project) => normalizePath(project.root ?? "", "")),
  ]);
  for (const dir of candidateDirs) {
    for (const name of SETTINGS_FILENAMES) {
      const path = normalizePath(dir, name);
      if (readFile(path) !== null && readFile(path) !== undefined) settingsFiles.push(path);
    }
  }
  for (const settingsPath of settingsFiles) {
    const settingsDir = dirnameOf(settingsPath);
    const settingsText = readFile(settingsPath);
    const settingsParsed = parseGradleSettings(settingsText ?? "");
    if (settingsParsed.reason !== undefined) {
      failures.push({
        sourceFile: settingsPath,
        reason: `its settings file ${settingsParsed.reason}`,
      });
      continue;
    }
    // The reactor's root project: path "" -> the settings file's own directory.
    claim(settingsPath, "", settingsDir);
    for (const includePath of settingsParsed.includedProjects) {
      const directory = normalizePath(settingsDir, includePath.split(":").join("/"));
      const trackedThere = [...tracked].some((file) => file.startsWith(`${directory}/`));
      if (!trackedThere) {
        failures.push({
          sourceFile: settingsPath,
          reason: `includes project ':${includePath}' but directory '${directory}' is not tracked`,
        });
        continue;
      }
      claim(settingsPath, includePath, directory);
    }
  }

  /** Declared project by normalized root directory. */
  const projectByDirectory = new Map(
    workspace.projects.map((project) => [normalizePath(project.root ?? "", ""), project]),
  );

  // Pass 2 — read the build file of every declared project that has one. A
  // project a settings file covers gets its references resolved; a build
  // file no settings file covers is loud ONLY when it declares project
  // references, because those are the bytes a silent skip would lose — a
  // settings-less build file with no `project(":x")` claims nothing.
  const coveredDirectories = new Set(pathToDirectory.values());
  /** @type {GradleEntry[]} */
  const entries = [];
  for (const project of workspace.projects) {
    const projectDir = normalizePath(project.root ?? "", "");
    const buildPath =
      BUILD_FILENAMES.map((name) => normalizePath(projectDir, name)).find((path) =>
        tracked.has(path),
      ) ?? null;
    if (buildPath === null) continue; // No build file: a reactor member declaring nothing.

    const buildText = readFile(buildPath);
    if (buildText === null || buildText === undefined) {
      failures.push({ sourceFile: buildPath, reason: "cannot be read" });
      continue;
    }
    const buildParsed = parseGradleBuild(buildText);
    if (buildParsed.reason !== undefined) {
      failures.push({ sourceFile: buildPath, reason: `its build file ${buildParsed.reason}` });
      continue;
    }

    if (!coveredDirectories.has(projectDir)) {
      if (buildParsed.projectDependencies.length > 0) {
        failures.push({
          sourceFile: buildPath,
          reason:
            "declares project references but its directory is covered by no Gradle settings file — they cannot be judged",
        });
      }
      continue;
    }
    entries.push({
      projectName: project.name,
      buildPath,
      declaredDependencies: buildParsed.projectDependencies,
    });
  }

  // Pass 3 — every reference must name a reactor path onto a declared project.
  for (const entry of entries) {
    for (const depRef of entry.declaredDependencies) {
      const directory = pathToDirectory.get(depRef);
      if (directory === undefined) {
        failures.push({
          sourceFile: entry.buildPath,
          reason: `declares dependency on project ':${depRef}' which no settings file defines`,
        });
        continue;
      }
      if (!projectByDirectory.has(directory)) {
        failures.push({
          sourceFile: entry.buildPath,
          reason: `declares dependency on project ':${depRef}' whose directory '${directory || "/"}' no declared project owns`,
        });
      }
    }
  }

  return { entries, pathToDirectory, failures };
}

export const gradleModelOf = perWorkspace(buildGradleModel);

/**
 * Manifest-edge resolver: one edge per declared project dependency whose
 * reference resolves onto another declared project's directory. References
 * that fail to resolve draw nothing here — the failure list has already
 * named them loudly, and the CLI turns that into exit 3.
 *
 * @param {{ name: string, root: string }[]} projects
 * @param {(name: string) => string[]} filesOf
 * @param {(path: string) => string|null} readFile
 * @returns {{ source: string, target: string, sourceFile: string, type: string }[]}
 */
export function resolveGradleDependencies(projects, filesOf, readFile) {
  const model = gradleModelOf({ projects, filesOf, readFile });
  const projectByDirectory = new Map(
    projects.map((project) => [normalizePath(project.root ?? "", ""), project]),
  );
  const dependencies = [];

  for (const entry of model.entries) {
    for (const depRef of entry.declaredDependencies) {
      const directory = model.pathToDirectory.get(depRef);
      if (directory === undefined) continue; // already a loud failure
      const targetProject = projectByDirectory.get(directory);
      if (targetProject === undefined) continue; // already a loud failure
      if (targetProject.name === entry.projectName) continue; // a self-reference claims no boundary

      dependencies.push({
        source: entry.projectName,
        target: targetProject.name,
        sourceFile: entry.buildPath,
        type: "static",
      });
    }
  }

  return dependencies;
}

/**
 * Whole-file failures for every Gradle manifest this reader could not fully
 * judge — the funnel `src/commands/context.mjs` spreads beside the analyzers'
 * own failures so a broken reactor exits 3 instead of reporting clean.
 *
 * @param {object} workspace
 * @returns {{ sourceFile: string, line: null, column: null, reason: string }[]}
 */
export function gradleManifestFailures(workspace) {
  return gradleModelOf(workspace).failures.map(({ sourceFile, reason }) =>
    fileFailure(sourceFile, `its Gradle manifest cannot be fully read: ${reason}`),
  );
}

/**
 * The graph layer: cross-project EDGES for Go, Rust, Python, Java, and C#/\.NET, in the shape
 * Nx's `createDependencies` hook returns. Nothing else — nodes still come from
 * each project's hand-written `project.json`, and targets are never inferred
 * (`packages/archkeep/AGENTS.md`).
 *
 * This is the plugin half of the tool, and it is deliberately separate from
 * `../analysis/`. The two answer different questions over the same tree: the
 * graph asks "does project A depend on project B", which is all `nx affected`
 * can act on, while analysis asks "which import, written where, in what form" —
 * a superset a boundary rule needs and an Nx edge cannot carry
 * (`../analysis/contract.md`). Keeping them apart is what stops the graph from
 * growing fields Nx will drop and analysis from being trimmed to what Nx keeps.
 *
 * Each resolver reads tracked manifests and sources statically (regex for Go
 * imports, smol-toml for Cargo/pyproject manifests) so the graph computes
 * without any language toolchain installed. A workspace with no Go/Rust/Python/
 * Java/C# projects pays nothing: every resolver keys off what it reads existing in
 * the project's tracked files.
 *
 * ## The hook's failure posture (#364)
 *
 * Edges and a throw are the only two outputs this hook has, and every
 * manifest reader and name index throws for the states its funnel
 * classifies as could-not-complete — the same failure lists the CLI turns
 * into exit 3: the Maven, Gradle and .csproj models, the JVM package index,
 * the C# namespace index (`../analysis/source-util.mjs`'s `refuseUnreadTree`).
 * Nx wraps a throwing hook's error and fails the whole graph computation —
 * measured against nx 23.1.1, which also has a dedicated `ProcessDependenciesError`
 * for the event and whose daemon refuses with an error rather than serving a
 * stale graph — so the throw is a designed-for channel, and `nx affected`
 * fails loudly on a broken reactor instead of under-selecting on it.
 *
 * The boundary: manifests and workspace-wide name indexes throw — one
 * unreadable entry corrupts resolution for every project that names that
 * identity, arbitrarily far from the file, so the failure cannot be
 * attributed to the file's own edges — while per-source import reads keep
 * the null-read posture the hook's `readFile` states below (a dropped source
 * loses only its own edges; a dropped manifest or index entry loses
 * everyone's). Python's dangling-path throw is the precedent that predates
 * the rule; its malformed-TOML tolerance stays the documented exception its
 * own header pins (`../analysis/python.mjs`).
 *
 * Resolver contract (see `../analysis/*.mjs`): every resolver returns raw Nx
 * edges — { source, target, sourceFile, type } and nothing else. Go, Rust and
 * Python take `resolve(projects, filesOf, readFile)`; the C# and JVM halves
 * instead take ONE workspace-shaped object (`{ projects, filesOf, readFile }`),
 * because everything they read is `perWorkspace`-memoized on that object — the
 * C# namespace index, the JVM package index, the Maven and Gradle models — and
 * a resolver destructuring its own arguments would have to build a fresh
 * object per call, defeating the memo (#363: three builds of the same index
 * per run).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { containmentViolation } from "../containment.mjs";
import { resolveCsharpDependencies } from "../analysis/csharp.mjs";
import { resolveCsprojDependencies, dotnetManifestFailures } from "../analysis/dotnet/csproj.mjs";
import { resolveGoDependencies } from "../analysis/go.mjs";
import { resolveJavaDependencies } from "../analysis/java.mjs";
import { resolveKotlinDependencies } from "../analysis/kotlin.mjs";
import { resolveMavenDependencies, mavenManifestFailures } from "../analysis/jvm/maven.mjs";
import { resolveGradleDependencies, gradleManifestFailures } from "../analysis/jvm/gradle.mjs";
import { dotnetIndexFailures } from "../analysis/dotnet/namespaces.mjs";
import { resolvePythonDependencies } from "../analysis/python.mjs";
import { resolveRustDependencies } from "../analysis/rust.mjs";
import { resolveOptions } from "../options.mjs";

/** Pure core over an abstract workspace; injectable for tests. */
export function resolvePolyglotDependencies(projects, filesOf, readFile) {
  // The C# and JVM halves read the same tree through ONE workspace-shaped
  // object: their memoized reads (namespace index, package index, Maven and
  // Gradle models) all key on the object itself, so every resolver handed the
  // same one shares a single build of each — and the memoized read behind the
  // object means no file's content is fetched twice on one graph computation.
  // The positional resolvers (Go, Rust, Python) hold no such memo, so they
  // keep taking the three values directly.
  const reads = new Map();
  const sharedWorkspace = {
    projects,
    filesOf,
    readFile: (path) => {
      if (!reads.has(path)) reads.set(path, readFile(path));
      return reads.get(path);
    },
  };
  const deps = [
    ...resolveGoDependencies(projects, filesOf, readFile),
    ...resolveRustDependencies(projects, filesOf, readFile),
    ...resolvePythonDependencies(projects, filesOf, readFile),
    ...resolveJavaDependencies(sharedWorkspace),
    ...resolveKotlinDependencies(sharedWorkspace),
    ...resolveCsharpDependencies(sharedWorkspace),
    // Manifest edges for .csproj trees: ProjectReference resolution,
    // independent of (and complementary to) the source-track edges above.
    ...resolveCsprojDependencies(sharedWorkspace),
    // Manifest edges for Maven/Gradle trees: the identity-anchor half of JVM
    // support, independent of (and complementary to) the import edges above
    // — a declared-but-unused dependency and an undeclared-but-imported one
    // are both findings.
    ...resolveMavenDependencies(sharedWorkspace),
    ...resolveGradleDependencies(sharedWorkspace),
  ];
  // One edge per (source, target, sourceFile) — a Go project importing a
  // sibling from ten files yields ten sourceFile-attributed edges upstream
  // of us; Nx dedupes too, this just keeps the plugin's output canonical.
  const seen = new Set();
  return deps.filter((d) => {
    const key = `${d.source} ${d.target} ${d.sourceFile}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The manifest-track edges in one list — `<ProjectReference>` (plus
 * `<Using Include>`) for .NET trees, Maven coordinate matching and Gradle
 * `project(":x")` for JVM ones. `resolvePolyglotDependencies` above already
 * folds these into the Nx plugin hook's answer; the CLI's native and Moon
 * branches and the language server's index build their graphs from import
 * sites alone, with no plugin host to call the hook, so they fold this list
 * themselves (`../providers/native/graph.mjs`'s `mergeDeclaredEdges`) — the
 * two-track contract of `../../../../docs/adr/0006-dotnet-language-integration.md`
 * (Decision 3) and `../../../../docs/adr/0005-jvm-language-integration.md`
 * (Decision 4) names no face it does not hold on.
 *
 * Each resolver refuses — throws — on exactly the failure list its
 * `*ManifestFailures` twin reports from the same memoized model
 * (`../../analysis/source-util.mjs`'s `perWorkspace` memoizes on the
 * workspace object, so twin calls share one build): a caller that has found
 * `mavenManifestFailures`/`gradleManifestFailures`/`dotnetManifestFailures`/
 * `dotnetIndexFailures` empty on THIS workspace cannot hit the throw.
 *
 * @param {object} workspace The shared workspace-shaped object.
 * @returns {{source: string, target: string, sourceFile: string, type: string}[]}
 */
export function resolveDeclaredManifestEdges(workspace) {
  return [
    ...resolveCsprojDependencies(workspace),
    ...resolveMavenDependencies(workspace),
    ...resolveGradleDependencies(workspace),
  ];
}

/**
 * The could-not-complete failures behind `resolveDeclaredManifestEdges`'s
 * refusal — the four manifest and index failure lists folded into one. A
 * caller uses this list twice: folded into its own whole-file failure
 * reporting, and as the no-throw guard for the edge call — each resolver
 * refuses on exactly the failures its `*ManifestFailures` twin reports from
 * the same memoized model, so an empty list here makes
 * `resolveDeclaredManifestEdges` unable to throw on this workspace. Both
 * halves of that sentence live beside each other here so the identity cannot
 * drift between a caller that forgets to report and one that skips the guard.
 *
 * `jvmIndexFailures` and `pythonUnmodelledFailures` are deliberately absent:
 * no resolver here reads the JVM package index or refuses on Python's
 * unmodelled posture, so neither is a condition of the no-throw guarantee —
 * callers keep those lists flowing through their own funnels.
 *
 * @param {object} workspace The shared workspace-shaped object.
 * @returns {{sourceFile: string, reason: string}[]}
 */
export function resolveDeclaredManifestFailures(workspace) {
  return [
    ...mavenManifestFailures(workspace),
    ...gradleManifestFailures(workspace),
    ...dotnetManifestFailures(workspace),
    ...dotnetIndexFailures(workspace),
  ];
}

/**
 * The Nx hook.
 *
 * `options` is validated and then not used, and both halves of that are
 * deliberate. Edge resolution reads language manifests, whose names are fixed
 * external contracts rather than options (`../options.mjs` says why) — so
 * nothing here needs a value from the table. Validating it anyway is what makes
 * a typo'd key fail at the FIRST graph computation, which every `nx` invocation
 * performs, instead of waiting for whichever later CLI or editor run happens to
 * read the same table. The alternative is a workspace that lints green all week
 * and discovers on Friday that its `tsConfig` was spelled `tsconfigBase` and no
 * path alias ever resolved.
 */
export const createDependencies = (options, context) => {
  resolveOptions(options);
  const projects = Object.entries(context.projects).map(([projectName, config]) => ({
    name: projectName,
    root: config.root,
  }));
  const filesOf = (projectName) =>
    (context.fileMap?.projectFileMap?.[projectName] ?? []).map((f) => f.file);
  const readFile = (workspaceRelativePath) => {
    const abs = join(context.workspaceRoot, workspaceRelativePath);
    // Every value this reader is handed comes from the tree's own `fileMap` —
    // attacker-supplied the moment a PR adds a tracked path. A tracked symlink
    // whose realpath leaves the workspace would draw a dependency edge from
    // outside bytes into `nx affected`'s graph; refusing (null) drops the
    // read. For a SOURCE file an import walk reads, that is the end of it:
    // null read = no edge, the file's own edges and nothing wider. For a
    // MANIFEST or an index-feeding file (a pom, a settings or build file, a
    // .csproj, a .java/.kt/.cs a name index reads), the reader records the
    // null read as a could-not-complete failure and its resolver throws on
    // it — the posture this file's header owns (#364). A plugin that never
    // resolves outside bytes stays silent-green only when the bytes are
    // really inside (`../containment.mjs`).
    if (containmentViolation(context.workspaceRoot, abs) !== null) return null;
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  };
  return resolvePolyglotDependencies(projects, filesOf, readFile);
};

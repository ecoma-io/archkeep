/**
 * Declared ∪ inferred project discovery over a `lattice.json`-rooted
 * workspace — no Nx, no `project.json` requirement, no assumption about
 * directory layout.
 *
 * Two sources merge into one project list, declared winning field-by-field:
 * every `projects.declared` row names a project outright, and every tracked
 * manifest matching `projects.infer` (`project.json`, `package.json`, `go.mod`,
 * `Cargo.toml`, `pyproject.toml` unless the model says otherwise) contributes
 * one more UNLESS its directory is already a declared root. Name precedence
 * reproduces Nx's own exactly — `discoverProjects` in `../../lsp/workspace-index.mjs`
 * is the oracle: `config.name ?? packageName ?? directoryBasename` — so a tree
 * that used to run Nx and now runs `lattice.json` names its projects the same
 * way it always did.
 *
 * Tags are a UNION, never a precedence: a project's own declared tags, every
 * `projectRules` row whose `match` covers its root, and its `project.json`
 * tags if it has one, all merge — sorted, deduplicated, with provenance kept
 * on the side (`tagOrigins`) rather than inside the tag list itself, because a
 * tag can arrive from more than one source and the rule engine
 * (`../../rules/tags.mjs`) only ever needs to know a project HAS a tag, never
 * where it came from.
 *
 * `nodeTypeOf` and `PROJECT_CONFIG_FILE` live here rather than in
 * `../../lsp/workspace-index.mjs`, which used to define them: this module is
 * the promotion target (`../../../CLAUDE.md`, "`src/providers/` is the layer
 * that supplies a graph to `evaluate()`"), and `../../lsp/workspace-index.mjs`
 * now imports both from here. Defining them there instead would mean
 * importing `../../lsp/workspace-index.mjs` from this module — which imports
 * `../../workspace.mjs`, which loads the TypeScript compiler at module scope
 * (`../../process.mjs`'s header) — for two functions that need nothing beyond
 * a string.
 */
import { fileFailure } from "../../analysis/source-util.mjs";
import { parseNxJson } from "../../nx-json.mjs";
import { projectPatternError } from "../../rules/match.mjs";
import { matchesGlob } from "./model.mjs";

/** The file Nx reads to learn a project exists — and so does this. */
export const PROJECT_CONFIG_FILE = "project.json";

/**
 * Nx's own `getProjectType`, reproduced over the same inputs.
 *
 * Reproduced rather than reached, unlike `../../nx-json.mjs`'s parser: Nx
 * keeps this one as a module-private function of `normalize-project-nodes`,
 * which exports two other names and not this. What makes reproducing it safe
 * is that the rule is Nx's own convention — the `-e2e` suffix is a naming Nx
 * defines, never one this workspace supplies — so nothing here assumes
 * anything about the tree it runs over.
 *
 * The filesystem fallbacks Nx applies when `projectType` is absent are NOT
 * reproduced. Nx probes for `tsconfig.lib.json`, `tsconfig.app.json` and a
 * `package.json` entry point; a project that states no `projectType` lands on
 * `lib` here. That direction is the safe one: `lib` is the only type with no
 * blanket import ban, so a mis-typed project is judged by its tags rather than
 * refused outright by a rule that never should have fired.
 *
 * @param {string} name
 * @param {string|undefined} projectType From `project.json`.
 * @returns {"app"|"e2e"|"lib"}
 */
export function nodeTypeOf(name, projectType) {
  if (projectType === "application") {
    return name.endsWith("-e2e") || name === "e2e" ? "e2e" : "app";
  }
  return "lib";
}

/** The directory part of a workspace-relative path; `""` at the tree root. */
const directoryOf = (file) => {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? "" : file.slice(0, slash);
};

/** `root`'s own basename, Nx's own fallback when nothing else names a project. */
const basenameOf = (root) => (root === "" ? "" : root.slice(root.lastIndexOf("/") + 1));

/**
 * `project.json` at `root`, parsed the same JSONC-tolerant way
 * `../../nx-json.mjs` reads every other config this package trusts —
 * `../../lsp/workspace-index.mjs` reads its own copy of `project.json` the
 * same way, so a trailing comma or a comment that Nx itself accepts is not a
 * reason for this provider to disagree with it.
 *
 * `.json` is not an analyzable extension (`../../analysis/analyze.mjs`'s
 * `LANGUAGE_BY_EXTENSION`), so `../../workspace.mjs`'s own analysis pass never
 * looks at this file and never reports it broken — a `project.json` this
 * function cannot parse would otherwise cost its project every field the
 * manifest carries (`tags`, `type`, `implicitDependencies`) with nothing
 * anywhere naming why, which is exactly the silent hole
 * `../../../../../AGENTS.md`'s invariant refuses. So a parse failure is returned
 * here as a `failure` (a `fileFailure`, the same whole-file record shape a
 * language analyzer produces for an unreadable file) rather than swallowed:
 * the project still keeps its row — `discoverNativeProjects` below, same as
 * before — but the caller surfaces the broken manifest as its own finding.
 *
 * @param {string} root
 * @param {(path: string) => string|null} readFile
 * @returns {{manifest: {name?: string, tags?: string[], projectType?: string, implicitDependencies?: string[]}|undefined, failure: object|undefined}}
 */
function readProjectManifest(root, readFile) {
  const path = root === "" ? PROJECT_CONFIG_FILE : `${root}/${PROJECT_CONFIG_FILE}`;
  const text = readFile(path);
  if (text === null) return { manifest: undefined, failure: undefined };
  try {
    return { manifest: parseNxJson(text), failure: undefined };
  } catch (cause) {
    return {
      manifest: undefined,
      failure: fileFailure(path, `could not be parsed as JSON: ${cause?.message ?? cause}`),
    };
  }
}

/**
 * `package.json`'s `name` at `root`, or `undefined` — the second rung of the
 * name-precedence ladder, read the same defensive way `project.json` is.
 *
 * @param {string} root
 * @param {(path: string) => string|null} readFile
 * @returns {string|undefined}
 */
function readPackageName(root, readFile) {
  const path = root === "" ? "package.json" : `${root}/package.json`;
  const text = readFile(path);
  if (text === null) return undefined;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every workspace-relative directory `projects.infer` covers: a tracked
 * manifest's own directory, when its basename is in `infer.manifests` and its
 * path matches `infer.include` and none of `infer.exclude`.
 *
 * @param {{files: string[], infer: {manifests: string[], include: string[], exclude: string[]}}} args
 * @returns {Set<string>}
 */
function inferProjectRoots({ files, infer }) {
  const roots = new Set();
  for (const file of files) {
    const base = file.slice(file.lastIndexOf("/") + 1);
    if (!infer.manifests.includes(base)) continue;
    if (!infer.include.some((pattern) => matchesGlob(file, pattern))) continue;
    if (infer.exclude.some((pattern) => matchesGlob(file, pattern))) continue;
    roots.add(directoryOf(file));
  }
  return roots;
}

/**
 * Declared ∪ inferred discovery, tag union, and every discovery-time defect
 * `lattice.json` can state that does not hold up against the tree: a declared
 * root with no tracked file under it, a `projectRules` row matching no
 * project, two projects resolving to the same name, and a workspace
 * describing zero projects at all.
 *
 * Every one of those throws — a defect in the model IS a "could not reach a
 * verdict" failure (`../../../../../AGENTS.md`, "An empty result is a claim, not a
 * shrug"): a `projectRules` row that silently matched nothing would report a
 * clean workspace exactly like one where every project really does carry the
 * tag, and the two are not the same fact.
 *
 * @param {{root: string, files: string[], readFile: (path: string) => string|null, model: object}} args
 *   `model` is a `NativeModel` from `./model.mjs`.
 * @returns {{projects: {name: string, root: string, type: "app"|"e2e"|"lib", tags: string[], tagOrigins: Record<string, string[]>, implicitDependencies: string[], targets: string[]}[], failures: object[]}}
 * @throws {Error} named `lattice: lattice.json describes a workspace that does not match the tree`.
 */
export function discoverNativeProjects({ root, files, readFile, model }) {
  const violations = [];
  const failures = [];
  const declaredByRoot = new Map();
  for (const row of model.projects.declared) {
    if (declaredByRoot.has(row.root)) {
      violations.push(`projects.declared: two rows declare the same root '${row.root}'`);
      continue;
    }
    declaredByRoot.set(row.root, row);
  }

  for (const declaredRoot of declaredByRoot.keys()) {
    // Strict containment only: `file === declaredRoot` used to also pass, so
    // a tracked FILE sharing its exact path with a declared root (a
    // `README.md` sitting where a project's directory ought to be, say)
    // could back a root that names no real directory at all. Only a file
    // genuinely inside the root's directory counts.
    const hasFile =
      declaredRoot === "" || files.some((file) => file.startsWith(`${declaredRoot}/`));
    if (!hasFile) {
      violations.push(
        `projects.declared: root '${declaredRoot}' has no tracked file under it — nothing in ` +
          `the tree backs this project`,
      );
    }
  }

  const inferredRoots = model.projects.infer
    ? inferProjectRoots({ files, infer: model.projects.infer })
    : new Set();

  const allRoots = new Set([...declaredByRoot.keys(), ...inferredRoots]);

  const resolved = [];
  for (const projectRoot of allRoots) {
    const declared = declaredByRoot.get(projectRoot);
    const { manifest, failure } = readProjectManifest(projectRoot, readFile);
    if (failure) failures.push(failure);
    const packageName = manifest ? undefined : readPackageName(projectRoot, readFile);
    // Nx's own precedence, reproduced exactly (`../../lsp/workspace-index.mjs`,
    // `discoverProjects`): a declared name, then `project.json`'s, then
    // `package.json`'s, then the directory basename.
    const name = declared?.name ?? manifest?.name ?? packageName ?? basenameOf(projectRoot);
    if (typeof name !== "string" || name === "") {
      violations.push(
        `projects: no name resolves for the project at root '${projectRoot}' — declare a ` +
          `'name' for it in projects.declared`,
      );
      continue;
    }

    const tagOrigins = /** @type {Record<string, Set<string>>} */ ({});
    const addTags = (tags, origin) => {
      for (const tag of tags ?? []) {
        (tagOrigins[tag] ??= new Set()).add(origin);
      }
    };
    addTags(declared?.tags, "declared");
    addTags(manifest?.tags, "project.json");
    for (const [index, rule] of model.projectRules.entries()) {
      if (matchesGlob(projectRoot, rule.match)) addTags(rule.tags, `projectRules[${index}]`);
    }

    // Spec D6: every `projectRules` row whose `match` covers this root and
    // states a `type` gets a vote, and the votes must agree. `.find()` used
    // to take the first match and ignore the rest, so reordering two rows in
    // `lattice.json` — a change that should never affect a verdict — could
    // silently flip a project's type and, with it, which import-ban rules
    // apply to it. A tie (every voting row names the SAME type) is fine and
    // resolves to that type; only disagreement is fatal.
    const typeVotes = model.projectRules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => rule.type && matchesGlob(projectRoot, rule.match));
    const distinctTypes = new Set(typeVotes.map(({ rule }) => rule.type));
    if (distinctTypes.size > 1) {
      violations.push(
        `projectRules: ${typeVotes.map(({ index }) => `[${index}]`).join(", ")} disagree on ` +
          `'${projectRoot}'s type (${[...distinctTypes].join(" vs. ")}) — every projectRules ` +
          `row matching one project must agree on its type`,
      );
      continue;
    }
    const type =
      declared?.type ?? typeVotes[0]?.rule.type ?? nodeTypeOf(name, manifest?.projectType);

    // A manifest-sourced implicitDependencies entry gets the same pattern
    // check `./model.mjs`'s `declaredProjectViolations` already runs on a
    // declared row's own list — the same matcher `./graph.mjs`'s
    // `buildDependencies` will eventually call
    // (`../../rules/match.mjs`'s `findMatchingProjects`) — so a pattern it
    // cannot resolve is a discovery-time defect named against this project,
    // never a silently dropped edge at graph-build time.
    for (const pattern of manifest?.implicitDependencies ?? []) {
      const error = projectPatternError(pattern);
      if (error) {
        violations.push(
          `${projectRoot}/${PROJECT_CONFIG_FILE}: implicitDependencies entry '${pattern}': ${error}`,
        );
      }
    }

    const implicitDependencies = [
      ...new Set([
        ...(declared?.implicitDependencies ?? []),
        ...(manifest?.implicitDependencies ?? []),
      ]),
    ];

    resolved.push({
      name,
      root: projectRoot,
      type: /** @type {"app"|"e2e"|"lib"} */ (type),
      tags: Object.keys(tagOrigins).sort(),
      tagOrigins: Object.fromEntries(
        Object.entries(tagOrigins).map(([tag, origins]) => [tag, [...origins].sort()]),
      ),
      implicitDependencies,
      // `targets` names target NAMES only — see `./model.mjs`'s
      // `declaredProjectViolations` for the shape validated, and
      // `./graph.mjs`'s `buildNativeGraph` for how each name becomes a
      // synthesized `{executor: "lattice:declared"}` entry. `project.json`
      // is not a source: this provider never reads its real target
      // definitions, only whether `lattice.json` declared the project has
      // one.
      targets: declared?.targets ?? [],
    });
  }

  const seenNames = new Map();
  for (const project of resolved) {
    if (seenNames.has(project.name)) {
      violations.push(
        `projects: '${project.name}' names both '${seenNames.get(project.name)}' and ` +
          `'${project.root}' — every project must resolve to a unique name`,
      );
      continue;
    }
    seenNames.set(project.name, project.root);
  }

  model.projectRules.forEach((rule, index) => {
    if (!resolved.some((project) => matchesGlob(project.root, rule.match))) {
      violations.push(`projectRules[${index}]: '${rule.match}' matches no discovered project`);
    }
  });

  if (violations.length === 0 && resolved.length === 0) {
    violations.push(
      "projects: this workspace describes zero projects — declare at least one in " +
        "projects.declared, or let projects.infer find one",
    );
  }

  if (violations.length > 0) {
    throw new Error(
      `lattice: ${root}/lattice.json describes a workspace that does not match the tree:\n  ` +
        violations.join("\n  "),
    );
  }

  return { projects: resolved, failures };
}

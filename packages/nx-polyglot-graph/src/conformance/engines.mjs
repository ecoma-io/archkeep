/**
 * The two engines, driven over one fixture tree.
 *
 * `runUpstream` runs the real `@nx/enforce-module-boundaries` through ESLint's
 * programmatic API. `runEngine` runs this project's `src/analysis` +
 * `src/rules` over the same files, the same graph and the same options. Nothing
 * is stubbed on either side: the point of the comparison is that both answers
 * come from the code that would run in production.
 *
 * ## Everything in this file is test-only, and the shipped code must stay clear of it
 *
 * `eslint`, `@nx/eslint-plugin` and `typescript-eslint` are imported HERE and
 * nowhere else in the project. The tool itself may import Node built-ins,
 * `typescript` and `vue/compiler-sfc` only (project `CLAUDE.md`), and the
 * `src/rules/` layer's whole value is being pure — importing the plugin would
 * drag `@nx/devkit` and a project-graph read into it. `boundary.test.mjs` is the
 * check that no shipped module ever reaches this directory.
 *
 * ## How upstream is made to judge a fixture instead of this repository
 *
 * The rule reads its workspace through four `globalThis` slots that
 * `readProjectGraph` fills from Nx's on-disk cache. It only fills them when
 * `isTerminalRun()` is false, so setting them AND making that predicate true is
 * what hands upstream the fixture's graph rather than this repository's. The
 * predicate reads `process.argv[1]`; it is pointed at an eslint-shaped path for
 * the duration of a lint and restored afterwards. Both moves are upstream's own
 * documented reuse path (`ensureGlobalProjectGraph`), not a patch of its
 * behaviour — no rule logic is replaced, and the rule cannot tell the
 * difference.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { analyzeFile, languageOf } from "../analysis/analyze.mjs";
import { evaluate } from "../rules/index.mjs";

/** `process.argv[1]` shapes upstream's `isTerminalRun()` accepts. */
const ESLINT_ARGV_PATH = "/conformance/node_modules/eslint";

/** Extensions the fixture ESLint config gives a parser. Anything else is unreadable to it. */
const UPSTREAM_READABLE = Object.freeze([".ts", ".tsx", ".js", ".mjs", ".cjs", ".vue"]);

/** Is this file one ESLint can parse at all in this workspace's configuration? */
export const isUpstreamReadable = (file) =>
  UPSTREAM_READABLE.some((extension) => file.endsWith(extension));

/**
 * Loads ESLint, the Nx plugin and the two nx internals upstream builds its
 * globals from, then hands back a runner bound to one fixture root.
 *
 * `@nx/devkit` and `@nx/js/internal` are not root dependencies of this
 * workspace, so they are reached through a require anchored at the PLUGIN's own
 * manifest — the same copies the plugin itself loads. Importing them by name
 * would be a phantom dependency pnpm's strict layout does not resolve.
 *
 * @param {string} root The fixture workspace root.
 */
export async function createUpstreamRunner(root) {
  const here = createRequire(import.meta.url);
  const viaPlugin = createRequire(here.resolve("@nx/eslint-plugin/package.json"));
  const { workspaceRoot } = viaPlugin("@nx/devkit");
  const { createProjectRootMappings } = viaPlugin(
    "nx/src/project-graph/utils/find-project-for-path",
  );
  const { TargetProjectLocator } = viaPlugin("@nx/js/internal");

  const { ESLint } = await import("eslint");
  const nxPlugin = (await import("@nx/eslint-plugin")).default;
  const tseslint = (await import("typescript-eslint")).default;
  const vueParser = await import("vue-eslint-parser");

  const rule = nxPlugin.rules["enforce-module-boundaries"];

  /**
   * The eight option values and the fifteen message ids, read off the INSTALLED
   * rule rather than restated— a case states only what it
   * overrides, and an Nx upgrade that changes a default changes both engines'
   * input at once instead of leaving a copy behind.
   */
  const defaultOptions = rule.defaultOptions[0];
  const upstreamMessageIds = Object.keys(rule.meta.messages);

  const lint = async (materialized, files) => {
    globalThis.projectGraph = materialized.graph;
    globalThis.projectRootMappings = createProjectRootMappings(materialized.graph.nodes);
    globalThis.projectFileMap = materialized.projectFileMap;
    globalThis.targetProjectLocator = new TargetProjectLocator(
      materialized.graph.nodes,
      materialized.graph.externalNodes,
    );
    globalThis.workspaceLayout = undefined;
    globalThis.projectPath = root;

    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ["**/*.{ts,tsx,js,mjs,cjs}"],
          languageOptions: { parser: tseslint.parser },
        },
        {
          files: ["**/*.vue"],
          languageOptions: { parser: vueParser, parserOptions: { parser: tseslint.parser } },
        },
        {
          files: ["**/*.{ts,tsx,js,mjs,cjs,vue}"],
          plugins: { "@nx": nxPlugin },
          rules: {
            "@nx/enforce-module-boundaries": [
              "error",
              { ...materialized.options, depConstraints: materialized.depConstraints },
            ],
          },
        },
      ],
    });

    const saved = process.argv[1];
    process.argv[1] = ESLINT_ARGV_PATH;
    try {
      return await eslint.lintFiles(files.map((file) => join(root, file)));
    } finally {
      // `require-atomic-updates` is right that this restores a global across an
      // await, and the exemption is scoped to this one line rather than to the
      // directory so the rule keeps judging every other case. Two facts make it
      // safe here: the save/restore pair brackets a single await with no other
      // writer, and the whole differential runs sequentially — `run()` awaits
      // one case at a time and nothing in this file starts a concurrent lint.
      // Should that ever change, this restore is where the interleaving would
      // land, so the comment is the marker for it.
      // eslint-disable-next-line require-atomic-updates
      process.argv[1] = saved;
    }
  };

  /**
   * Every message the boundary rule reports for one case, keyed by
   * workspace-relative file.
   *
   * A file ESLint has no parser for never reaches the rule, and saying so is
   * the point rather than an omission — it is the measured half of "ESLint
   * reads only JavaScript and TypeScript". Such a file is reported as
   * `readable: false` with whatever ESLint said about it, never as "clean".
   *
   * @returns {Promise<Map<string, {readable: boolean, messages: object[], notes: string[]}>>}
   */
  const run = async (materialized) => {
    const files = materialized.spec.probes.map((probe) => `${materialized.spec.id}/${probe.file}`);
    const readable = files.filter(isUpstreamReadable);
    const byFile = new Map();
    for (const file of files) {
      byFile.set(file, { readable: isUpstreamReadable(file), messages: [], notes: [] });
    }
    if (readable.length === 0) return byFile;

    const results = await lint(materialized, readable);
    for (const result of results) {
      const relative = result.filePath.slice(root.length + 1);
      const entry = byFile.get(relative);
      if (!entry) continue;
      for (const message of result.messages) {
        if (message.ruleId === "@nx/enforce-module-boundaries") {
          entry.messages.push(message);
          continue;
        }
        // Anything else is the fixture failing to parse or ESLint refusing the
        // file. Recorded so a broken fixture cannot masquerade as a clean one.
        entry.notes.push(`${message.ruleId ?? "eslint"}: ${message.message}`);
      }
    }
    return byFile;
  };

  return { workspaceRoot, defaultOptions, upstreamMessageIds, run };
}

/**
 * The `Workspace` shape `src/analysis/` takes, backed by the fixture on disk.
 *
 * One object per case: `perWorkspace` memoises TypeScript's parsed options
 * against object identity, and two cases sharing one object would share one
 * `filesOf`, whose project names are only unique within a case.
 */
function fixtureWorkspace(root, materialized) {
  const byProject = new Map(materialized.projects.map((project) => [project.name, []]));
  for (const file of materialized.files) {
    for (const project of materialized.projects) {
      if (file === project.root || file.startsWith(`${project.root}/`)) {
        byProject.get(project.name).push(file);
      }
    }
  }
  return {
    root,
    projects: materialized.projects,
    filesOf: (name) => byProject.get(name) ?? [],
    readFile: (relative) => {
      try {
        return readFileSync(join(root, relative), "utf8");
      } catch {
        return null;
      }
    },
  };
}

/**
 * This engine's verdict for one case: every violation, plus every analysis
 * failure, keyed by workspace-relative file.
 *
 * The whole case is analyzed rather than only the probed files, because that is
 * the view upstream has — its `projectFileMap` covers the workspace — and the
 * two messages that list files would otherwise print a shorter chain here for
 * no reason but the harness.
 *
 * @returns {{violations: object[], failures: object[]}}
 */
export function runEngine(root, materialized) {
  const workspace = fixtureWorkspace(root, materialized);
  const sites = [];
  const failures = [];
  for (const file of materialized.files) {
    if (languageOf(file) === null) continue;
    const text = workspace.readFile(file);
    if (text === null) continue;
    const result = analyzeFile({ sourceFile: file, text, workspace });
    sites.push(...result.imports);
    failures.push(...result.failures);
  }
  const violations = evaluate(sites, materialized.graph, {
    depConstraints: materialized.depConstraints,
    options: materialized.options,
    suppressions: materialized.suppressions,
  });
  return { violations, failures };
}

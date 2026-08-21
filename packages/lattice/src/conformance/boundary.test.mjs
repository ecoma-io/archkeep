/**
 * The constraint that lets this directory exist at all, made checkable — and
 * the allow-list it checks against, which lives here rather than in prose.
 *
 * `src/conformance/` imports ESLint and `@nx/eslint-plugin` on purpose — a
 * differential test that stubbed the thing it compares against would prove
 * nothing. The shipped tool must not, and the reason is not tidiness: the whole
 * value of `src/rules/` is being pure over records, and importing the plugin
 * would pull `@nx/devkit` and a project-graph read into it. Self-containment is
 * the other half: a project that imports a sibling cannot be published, and it
 * cannot run inside a consumer's workspace, which is where this tool spends
 * most of its life.
 *
 * `SHIPPED_PACKAGES` below is the single home of what the tool may depend on.
 * It was prose in the project's `AGENTS.md` before, and prose drifted: the list
 * there named three entries while the tree used five. A list nothing reads is a
 * list nobody updates, so `AGENTS.md` now states the rule and points here.
 *
 * The file list is derived by walking the project rather than written down, so
 * a module added tomorrow is covered without anyone remembering to add it.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Directories a walk never descends into: installed packages and build output. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "coverage", "dist"]);

/**
 * The throwaway fixture roots a run creates INSIDE this package, read off the
 * package's own `.gitignore` rather than restated here.
 *
 * Two tests deliberately build their trees under `packageRoot` instead of the
 * system tmpdir, because `@nx/devkit` and `@nx/eslint-plugin` resolve from
 * where the tree sits (`../providers/native/differential.integration.test.mjs`
 * and `../config-spelling.integration.test.mjs` each argue it in their own
 * header). Those roots hold `.mjs` files, and vitest runs test files in
 * parallel, so a walk that descended into them judged fixture modules as if
 * this package shipped them — and crashed with `ENOENT` whenever the fixture's
 * `afterAll` removed the tree between `readdirSync` and `readFileSync`. Both
 * halves are the same defect: a gate whose subject set depends on which OTHER
 * tests happen to be running is not measuring what it says it measures.
 *
 * Derived from `.gitignore` rather than hardcoded, and not from a bare
 * "skip dot-directories" rule, because that file is already the one place
 * naming these prefixes and already carries the reason each exists. A fixture
 * root added there is skipped here in the same edit; a fixture root that is
 * NOT there still trips this walk — which is the loud direction, and the same
 * leftovers `nx show projects` would read as a phantom project in this
 * repository's own tree.
 */
const IGNORED_FIXTURE_ROOTS = readFileSync(join(PROJECT_ROOT, ".gitignore"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

/** Whether `entry` is one of the gitignored fixture roots above. */
function isIgnoredFixtureRoot(entry) {
  return IGNORED_FIXTURE_ROOTS.some((pattern) =>
    pattern.endsWith("*") ? entry.startsWith(pattern.slice(0, -1)) : entry === pattern,
  );
}

/** Bare specifiers only this directory may name, each because a test needs the real thing. */
const TEST_ONLY_PACKAGES = [
  "eslint",
  "@nx/eslint-plugin",
  "@nx/devkit",
  "@nx/js",
  "nx/",
  "typescript-eslint",
  "vue-eslint-parser",
  "vitest",
  "@fast-check/vitest",
];

/**
 * Every third-party specifier a SHIPPED module may name, and why. Node
 * built-ins are allowed everywhere and are recognised by `isBuiltin` rather
 * than listed — a hand-kept list of them is a second registry that drifts from
 * Node.
 */
const SHIPPED_PACKAGES = new Map([
  ["typescript", "module resolution, delegated rather than reimplemented"],
  ["smol-toml", "Cargo.toml and pyproject.toml, which have no stdlib parser"],
  ["vue/compiler-sfc", "SFC parsing, reached through the root `vue` dependency's own subpath"],
  ["nx/package.json", "resolved for the CLI's path"],
  [
    "nx/src/utils/json.js",
    "`nx.json` and every `project.json` are read through Nx's own parseJson, so a config Nx " +
      "accepts — a trailing comma, a line or block comment — cannot drop a project from the " +
      "LSP graph while nx graph still sees it, nor lose the plugin options that decide which " +
      "file the boundary law is read from. Reached lazily, and a tree where it does not " +
      "resolve raises rather than falling back to JSON.parse, which would quietly restore the " +
      "blind spot it was added to end",
  ],
  [
    "@nx/eslint-plugin",
    "the ESLint boundaryConfig dialect (`../eslint-config.mjs`) reads enforce-module-boundaries' " +
      "own unstated option defaults off the workspace's own installed copy of the plugin, so a " +
      "workspace naming an eslint.config.* as its boundaryConfig does not also need a second, " +
      "hand-kept table of the same defaults. Resolved lazily via createRequire anchored at the " +
      "workspace's own ESLint config path, never at this package's own location, and never " +
      "loaded at all in a workspace that never names this dialect — the same lazy-and-optional " +
      "shape `vue/compiler-sfc` and `nx/src/utils/json.js` already have above, for the same " +
      "reason: a missing peer here must not break Go, Rust or Python analysis in a workspace " +
      "with no ESLint at all",
  ],
]);

/**
 * Specifiers that leave this project on purpose, with the reason each is not
 * the self-containment rule breaking. Every entry is asserted to still be
 * reached, so an exemption cannot outlive the code it was written for.
 *
 * **It is empty, and that is the state to keep it in.** It held two entries
 * while this tool lived inside a larger workspace: `vitest.config.mjs` read the
 * repo-root `coverage.config.json` and loaded a root property-seed setup, both
 * files no Nx project owned. Neither reach survived the move — the coverage
 * floor and the seed pin now sit beside the runner config, because this package
 * is the only consumer either had. Nothing else ever escaped.
 *
 * The map stays rather than the rule collapsing into "no `..` anywhere",
 * because the honest form of the constraint is "every escape is named with its
 * reason", and an empty list is that rule satisfied rather than that rule
 * absent. A future escape adds an entry here and states why in the same edit,
 * which is a review conversation; deleting the mechanism would make the next
 * one invisible.
 */
const ESCAPES_BY_DESIGN = new Map();

/** Every `.mjs` file the project owns, workspace-relative to the project root. */
function projectSources(directory = PROJECT_ROOT) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry) || isIgnoredFixtureRoot(entry)) continue;
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      found.push(...projectSources(absolute));
      continue;
    }
    if (entry.endsWith(".mjs")) found.push(relative(PROJECT_ROOT, absolute));
  }
  return found;
}

/**
 * The specifier forms whose argument is written inline.
 *
 * The clause between the keyword and `from` may not cross a newline. Without
 * that, an `export const X = {` whose object literal is many lines long swallows
 * everything up to the next `from "…"` — and `../rules/messages.mjs` holds
 * upstream's wording verbatim, one template of which reads `import from
 * "{{imp}}"`. The multi-line brace form is matched by its own pattern instead,
 * anchored on the closing brace, so `index.mjs`'s re-export is still seen.
 */
const INLINE_PATTERNS = [
  /(?:^|\n)\s*import\s[^;\n]*?from\s*["']([^"']+)["']/gu,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/gu,
  // The clause between `export` and `from` also excludes quotes: a re-export
  // clause can never contain one, and `export const X = freeze(["from", ...])`
  // would otherwise read the string contents as the `from` keyword.
  /(?:^|\n)\s*export\s[^;\n"']*?from\s*["']([^"']+)["']/gu,
  /(?:^|\n)\s*\}\s*from\s*["']([^"']+)["']/gu,
  /\brequire(?:_)?\(\s*["']([^"']+)["']\s*\)/gu,
  /\bimport\(\s*["']([^"']+)["']\s*\)/gu,
];

/** A JavaScript identifier, for the bindings the walk has to follow. */
const IDENTIFIER = String.raw`[A-Za-z_$][\w$]*`;

/**
 * Every module specifier a file names, and every load this walk could not read.
 *
 * Beyond the inline forms it follows the two-call `createRequire` shape — what
 * this project uses for a dependency it must not import at module scope
 * (`../analysis/vue.mjs`) and for the one Nx internal it reads lazily
 * (`../nx-json.mjs`). A regex over `import`/`require("…")` alone is blind to it,
 * and a blind spot in a boundary check reads exactly like compliance.
 *
 * `opaque` is the honest half: a call whose argument this walk cannot resolve
 * to a literal is reported rather than skipped, because skipping it would be
 * the same silent pass the two-call shape used to get. The cost is that a
 * comment or a template string written in the shape of such a call is read as
 * one — describe those in prose, the way the comments here do.
 *
 * @returns {{specifiers: string[], opaque: string[]}}
 */
function specifiersIn(file) {
  const text = readFileSync(join(PROJECT_ROOT, file), "utf8");
  const specifiers = [];
  const opaque = [];

  for (const pattern of INLINE_PATTERNS) {
    for (const match of text.matchAll(pattern)) specifiers.push(match[1]);
  }

  // Module-scope string constants, so a specifier held in a named constant is
  // still readable — `vue.mjs` names its parser once so a failure can quote it.
  const literals = new Map();
  for (const match of text.matchAll(
    new RegExp(String.raw`(?:^|\n)\s*const\s+(${IDENTIFIER})\s*=\s*["']([^"']+)["']`, "gu"),
  )) {
    literals.set(match[1], match[2]);
  }

  // Whatever `createRequire` is called here, including under an import alias,
  // plus every name a require function was bound to.
  const factories = new Set(["createRequire"]);
  for (const match of text.matchAll(
    new RegExp(String.raw`createRequire\s+as\s+(${IDENTIFIER})`, "gu"),
  )) {
    factories.add(match[1]);
  }
  const callees = new Set();
  for (const factory of factories) {
    for (const match of text.matchAll(
      new RegExp(String.raw`(?:const|let|var)\s+(${IDENTIFIER})\s*=\s*${factory}\s*\(`, "gu"),
    )) {
      callees.add(match[1]);
    }
  }

  /** One captured call argument, resolved to the specifier it names. */
  const readArgument = (raw, form) => {
    // A trailing comma survives a call the formatter broke across lines.
    const argument = raw.trim().replace(/,$/u, "").trim();
    const quoted = /^["']([^"']+)["']$/u.exec(argument);
    if (quoted) {
      specifiers.push(quoted[1]);
      return;
    }
    if (literals.has(argument)) {
      specifiers.push(literals.get(argument));
      return;
    }
    opaque.push(`${file}: ${form} loads '${argument}', which this walk cannot resolve`);
  };

  // The factory invoked where it is created, its second call naming the module.
  for (const factory of factories) {
    for (const match of text.matchAll(
      new RegExp(String.raw`${factory}\s*\((?:[^()]|\([^()]*\))*\)\s*\(\s*([^()]*?)\s*\)`, "gu"),
    )) {
      readArgument(match[1], `${factory}(…)(…)`);
    }
  }

  // A require function bound to a name, then called or asked to resolve.
  for (const callee of callees) {
    for (const match of text.matchAll(
      new RegExp(String.raw`\b${callee}\s*(?:\.resolve)?\s*\(\s*([^()]*?)\s*\)`, "gu"),
    )) {
      readArgument(match[1], `${callee}(…)`);
    }
  }

  return { specifiers, opaque };
}

const isTestFile = (file) => file.endsWith(".test.mjs") || file.endsWith(".e2e.mjs");
const isConformance = (file) => file.startsWith(`src${"/"}conformance/`);
/** E2E fixtures and harness are test infrastructure — they do not ship. */
const isE2eInfrastructure = (file) => file.startsWith("e2e/");
/**
 * The test runner's own configuration is part of the test tier, not of what the
 * tool ships — `package.json`'s `bin` entries are `cli.mjs` and `lsp.mjs`, and
 * neither can reach either file. `vitest.property-seed.mjs` is named alongside
 * the config because it is loaded only through that config's `setupFiles`; it
 * imports `@fast-check/vitest`, which nothing shipped may.
 */
const RUNNER_CONFIG_FILES = new Set([
  "vitest.config.mjs",
  "vitest.property-seed.mjs",
  "e2e/vitest.config.mjs",
]);
const isRunnerConfig = (file) => RUNNER_CONFIG_FILES.has(file);

describe("what the shipped tool is allowed to depend on", () => {
  const sources = projectSources();
  const isShipped = (file) =>
    !isConformance(file) &&
    !isTestFile(file) &&
    !isRunnerConfig(file) &&
    !isE2eInfrastructure(file);

  it("finds the modules it is meant to be checking", () => {
    // A walk that silently returned nothing would make every check below pass.
    expect(sources).toContain("index.mjs");
    expect(sources).toContain(join("src", "rules", "index.mjs"));
    expect(sources.filter(isConformance).length).toBeGreaterThan(3);
  });

  it("walks past a throwaway fixture root a sibling test is holding open", () => {
    // The guard for `IGNORED_FIXTURE_ROOTS`. Vitest runs test files in
    // parallel, and two of them build trees under this package on purpose, so
    // without the skip this suite judged fixture modules as shipped source and
    // crashed on `ENOENT` when the fixture was removed mid-walk. Both are the
    // same defect — a gate whose subject set depends on which other tests are
    // running — and neither is visible from a passing run, so it is measured
    // here against a root created for the purpose.
    const root = mkdtempSync(join(PROJECT_ROOT, ".oracle-boundary-walk-guard-"));
    try {
      writeFileSync(join(root, "fixture.mjs"), 'import "some-package-nobody-declared";\n');
      const walked = projectSources();
      expect(
        walked.filter((file) => file.includes("oracle-boundary-walk-guard")),
        "the walk descended into a gitignored fixture root",
      ).toEqual([]);
      // And the prefix really is the one `.gitignore` names, rather than the
      // skip happening for some unrelated reason.
      expect(isIgnoredFixtureRoot(relative(PROJECT_ROOT, root))).toBe(true);
      expect(isIgnoredFixtureRoot("src")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads every load the tool performs, including the ones behind createRequire", () => {
    // A specifier this walk cannot resolve is a hole in every check below, and
    // a hole reads as compliance. Two loads in this project are written that
    // way on purpose, so the walk is required to see them rather than trusted
    // to: naming them is what would fail if the walk regressed to matching
    // `import`/`require("…")` only.
    const opaque = sources.flatMap((file) => specifiersIn(file).opaque);
    expect(opaque, "loads this walk cannot resolve to a specifier").toEqual([]);

    expect(specifiersIn(join("src", "analysis", "vue.mjs")).specifiers).toContain(
      "vue/compiler-sfc",
    );
    expect(specifiersIn(join("src", "nx-json.mjs")).specifiers).toContain("nx/src/utils/json.js");
  });

  it("keeps ESLint and the Nx plugin out of every module that is not a test", () => {
    const offenders = [];
    for (const file of sources) {
      if (!isShipped(file)) continue;
      for (const specifier of specifiersIn(file).specifiers) {
        // An entry on the shipped list wins: `nx/package.json` is resolved for
        // a path and never loaded, which is not what `nx/` is fenced off for.
        if (SHIPPED_PACKAGES.has(specifier)) continue;
        if (TEST_ONLY_PACKAGES.some((name) => specifier === name || specifier.startsWith(name))) {
          offenders.push(`${file} imports '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names no third-party package the shipped tool has not declared a reason for", () => {
    // Deny by default, which is the half prose could never carry: the previous
    // statement of this rule listed three packages while the tree used five,
    // and nothing noticed. Adding a dependency now means adding it to
    // SHIPPED_PACKAGES with its reason, in the same diff.
    const offenders = [];
    for (const file of sources) {
      if (!isShipped(file)) continue;
      for (const specifier of specifiersIn(file).specifiers) {
        if (specifier.startsWith(".")) continue;
        if (isBuiltin(specifier)) continue;
        if (SHIPPED_PACKAGES.has(specifier)) continue;
        offenders.push(`${file} depends on '${specifier}'`);
      }
    }
    expect(offenders, "third-party specifiers with no entry in SHIPPED_PACKAGES").toEqual([]);
  });

  it("keeps the conformance suite unreachable from anything the tool ships", () => {
    // The suite is reachable only from its own tests. A shipped module that
    // imported it would drag ESLint into the plugin Nx loads on every graph
    // computation — which is the cost `index.mjs` exists to avoid.
    const offenders = [];
    for (const file of sources) {
      if (isConformance(file)) continue;
      for (const specifier of specifiersIn(file).specifiers) {
        if (specifier.includes("conformance")) offenders.push(`${file} imports '${specifier}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reaches outside its own directory only where an exemption says why", () => {
    // Self-contained is what keeps this package publishable, and it is the one
    // constraint that has to hold for the test tier too: a fixture reaching
    // into a sibling would make this project's suite unrunnable outside this
    // repository, which is where the tool also has to work.
    const offenders = [];
    for (const file of sources) {
      const exempt = ESCAPES_BY_DESIGN.get(file) ?? [];
      for (const specifier of specifiersIn(file).specifiers) {
        if (!specifier.startsWith(".")) continue;
        if (exempt.includes(specifier)) continue;
        const resolved = join(dirname(file), specifier);
        if (resolved.startsWith("..")) offenders.push(`${file} reaches '${specifier}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("carries no exemption for a reach that no longer happens", () => {
    // An exemption that outlives its code is how the next real escape gets
    // waved through by a line nobody rereads.
    const unused = [];
    for (const [file, exempt] of ESCAPES_BY_DESIGN) {
      const found = sources.includes(file) ? specifiersIn(file).specifiers : [];
      for (const specifier of exempt) {
        if (!found.includes(specifier)) unused.push(`${file} no longer reaches '${specifier}'`);
      }
    }
    expect(unused).toEqual([]);
  });

  it("declares in its manifest every package a shipped module imports", () => {
    // The check above proves nothing the tool imports is undeclared HERE; this
    // one proves it is declared where a consumer's installer reads. They are
    // the same fact in two files, and the failure mode of the second is the one
    // a local run cannot see: the package installs clean and throws at the
    // first `import ts from "typescript"`, because nothing told the installer
    // to supply it. That is exactly how this manifest stood before — zero
    // dependencies, green locally, because pnpm hoisted the workspace root's
    // copy and Node walked up to it.
    //
    // Both fields count as declared. Which one a package belongs in is a
    // judgement the manifest makes (a peer is the consumer's copy, shared with
    // Nx; a dependency is ours), and re-deciding it here would make this test
    // an opinion instead of a comparison.
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);

    // A subpath is supplied by its package: `vue/compiler-sfc` by `vue`,
    // `nx/package.json` by `nx`. Scoped names keep their first two segments.
    const packageOf = (specifier) =>
      specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];

    const undeclared = [...SHIPPED_PACKAGES.keys()]
      .map(packageOf)
      .filter((name) => !declared.has(name));

    expect(
      [...new Set(undeclared)],
      "imported by a shipped module, absent from package.json",
    ).toEqual([]);
  });

  it("declares nothing in its manifest that no shipped module imports", () => {
    // The other direction, and the one that rots quietly: a dependency left
    // behind by code that was deleted makes every consumer install a package
    // for nothing, and — for a peer — warns them about a version they have no
    // reason to hold.
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
    const packageOf = (specifier) =>
      specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
    const imported = new Set([...SHIPPED_PACKAGES.keys()].map(packageOf));

    const unused = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ].filter((name) => !imported.has(name));

    expect(unused, "declared in package.json, imported by nothing shipped").toEqual([]);
  });
});

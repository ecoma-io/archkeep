/**
 * The conformance catalogue: one minimal Nx-shaped workspace per behaviour,
 * built to make `@nx/enforce-module-boundaries` say something specific — and,
 * beside each one, the near-miss that must make it say nothing.
 *
 * ## Why every positive has a negative
 *
 * A suite of positives proves a reimplementation can be loud. It cannot
 * distinguish an engine that reproduces upstream's semantics from one that
 * reports on everything, and the reimplementation failures that matter are all
 * on the boundary: a glob that anchors where upstream's does not, an `every()`
 * whose empty case inverts, a constraint list read as OR instead of AND. So the
 * near-miss is the load-bearing half. It sits in the same case as its positive
 * whenever the two share a tree, because a reader deciding whether to trust a
 * rule wants both answers in one place.
 *
 * ## What a case declares, and why it declares its own answer
 *
 * Each probe states the message ids ESLint MUST report. Without that a case
 * that quietly stopped triggering its rule would still "agree" — both engines
 * silent, comparison green, nothing proven. Where the two engines are meant to
 * differ the probe also states this engine's own verdict plus the reason; a
 * verdict without a reason is rejected, because a deliberate difference from
 * ESLint is a decision and decisions get written down.
 *
 * ## `spelling`, and why a declared answer is not enough on its own
 *
 * A declaration can only be as good as the person who wrote it. Where ESLint
 * has no parser — `.go`, `.rs`, `.py` — there is nothing to diff against, so
 * `tool: [...]` is the ONLY assertion, and it is written by whoever built the
 * fixture. Write it wrong and the suite agrees with the wrong answer forever;
 * the shape nobody thought to write is not covered at all.
 *
 * So probes may also declare a `spelling`: a key naming the ONE import they
 * each write a different way. Every probe sharing a key must reach the same
 * verdict, and that assertion needs nobody to have predicted what the verdict
 * is. A package at `src/pkg` and the same package under a declared
 * `package-dir` are one import spelled two ways; if one is enforced and the
 * other silently reads as a PyPI distribution, the group disagrees with itself
 * and the run goes red even where every `tool: [...]` beside it says exactly
 * what the engine did.
 *
 * The mechanism is language-agnostic and takes one field per probe. A group
 * needs at least two members — one spelling cannot disagree with itself, and
 * the suite says so rather than passing a group that lost its siblings.
 *
 * ## What may not appear here
 *
 * No project name, tag value or area from any real workspace. This tool is
 * installed into trees whose vocabulary it cannot predict, and a fixture that
 * assumed any one workspace's would be testing a coincidence (project
 * `AGENTS.md`). Tags below are invented per case and mean nothing outside it.
 */

/** A barrel file that exports one constant, so an import of it has something to bind. */
const barrel = (name) => `export const ${name} = 1;\n`;

/** The `package.json` `exports` shape upstream's `parseExports` reads entry points out of. */
const secondaryEntryPoints = {
  name: "entry-point-fixture",
  exports: { ".": "./src/index.ts", "./sub": "./src/sub.ts" },
};

/** A module-federation config carrying the `exposes:` key upstream greps for. */
const MFE_CONFIG = "module.exports = { name: 'remote', exposes: { './App': './src/app.ts' } };\n";

/** The `.d.ts` files a fake npm package needs so both its entry and a nested path resolve. */
const packageFiles = {
  "index.d.ts": "export declare const entry: number;\n",
  "sub.d.ts": "export declare const nested: number;\n",
};

export const CONFORMANCE_CASES = [
  // ---------------------------------------------------------------- specifiers
  {
    id: "relative-and-absolute-imports-across-projects",
    intent:
      "A path that crosses a project boundary is judged on its text: the projects can be right and the spelling still be the violation.",
    projects: [
      {
        name: "source",
        root: "libs/source",
        files: {
          "src/crosses.ts":
            'import { target } from "../../target/src/index";\nexport const a = target;\n',
          "src/absolute.ts":
            'import { target } from "libs/target/src/index";\nexport const b = target;\n',
          "src/inside.ts": 'import { helper } from "./helper";\nexport const c = helper;\n',
          "src/helper.ts": barrel("helper"),
        },
      },
      { name: "target", root: "libs/target", files: { "src/index.ts": barrel("target") } },
    ],
    // The absolute spelling is judged before anything resolves it, so the path
    // it names deliberately does not exist.
    unresolvable: ["libs/target/src/index"],
    probes: [
      {
        file: "libs/source/src/crosses.ts",
        upstream: ["noRelativeOrAbsoluteImportsAcrossLibraries"],
      },
      {
        file: "libs/source/src/absolute.ts",
        upstream: ["noRelativeOrAbsoluteImportsAcrossLibraries"],
      },
      { file: "libs/source/src/inside.ts", upstream: [] },
    ],
  },
  {
    id: "absolute-imports-with-non-default-workspace-layout",
    intent:
      "A workspace that renames its libs directory rewrites which absolute spellings cross a project boundary — the rule reads the declared layout, not a hardcoded default.",
    workspaceLayout: { libsDir: "packages", appsDir: "apps" },
    projects: [
      {
        name: "pkg-source",
        root: "packages/pkg-source",
        files: {
          "src/absolute-into-lib-dir.ts":
            'import { target } from "packages/pkg-target/src/index";\nexport const a = target;\n',
          "src/spells-default-dir.ts":
            'import { target } from "libs/pkg-target/src/index";\nexport const b = target;\n',
          "src/relative.ts":
            'import { target } from "../../pkg-target/src/index";\nexport const c = target;\n',
        },
      },
      {
        name: "pkg-target",
        root: "packages/pkg-target",
        files: { "src/index.ts": barrel("target") },
      },
    ],
    unresolvable: ["packages/pkg-target/src/index", "libs/pkg-target/src/index"],
    probes: [
      {
        file: "packages/pkg-source/src/absolute-into-lib-dir.ts",
        upstream: ["noRelativeOrAbsoluteImportsAcrossLibraries"],
      },
      {
        // "libs/..." is not the declared libsDir, so it does not match the
        // absolute-into-another-project rule — but it also does not resolve
        // to any project (the tree has no libs/ directory), so both engines
        // report it as an unresolved import rather than a boundary violation.
        file: "packages/pkg-source/src/spells-default-dir.ts",
        upstream: [],
      },
      {
        file: "packages/pkg-source/src/relative.ts",
        upstream: ["noRelativeOrAbsoluteImportsAcrossLibraries"],
      },
    ],
  },
  {
    id: "an-exemption-both-enforcers-were-told-about",
    intent:
      "A violation the workspace decided to accept. ESLint is told with its directive comment, this engine with a `boundarySuppressions` entry carrying the same reason — the two mechanisms are different because a comment convention is JavaScript's and this tool judges four other languages. Both must go quiet, and the identical import one file over, told to neither, must still be reported by both. Because the mechanisms are different, telling only ONE of them is a configuration a workspace can reach by accident, and each half is probed rather than described: it is the only place the catalogue measures what the two mechanisms cost when they drift apart.",
    projects: [
      {
        name: "exempt-source",
        root: "libs/exempt-source",
        files: {
          "src/allowed.ts":
            "// eslint-disable-next-line @nx/enforce-module-boundaries -- the loader that reads this file resolves no alias\n" +
            'import { target } from "../../exempt-target/src/index";\nexport const a = target;\n',
          "src/reported.ts":
            'import { target } from "../../exempt-target/src/index";\nexport const b = target;\n',
          // Told to ESLint only: the directive is there, no suppression entry
          // names this path.
          "src/directive-only.ts":
            "// eslint-disable-next-line @nx/enforce-module-boundaries -- told to one enforcer only\n" +
            'import { target } from "../../exempt-target/src/index";\nexport const c = target;\n',
          // Told to this engine only: a suppression entry names it, no comment.
          "src/suppression-only.ts":
            'import { target } from "../../exempt-target/src/index";\nexport const d = target;\n',
        },
      },
      {
        name: "exempt-target",
        root: "libs/exempt-target",
        files: { "src/index.ts": barrel("target") },
      },
    ],
    suppressions: [
      {
        path: "libs/exempt-source/src/allowed.ts",
        messageId: "noRelativeOrAbsoluteImportsAcrossLibraries",
        reason: "the loader that reads this file resolves no alias",
      },
      {
        path: "libs/exempt-source/src/suppression-only.ts",
        messageId: "noRelativeOrAbsoluteImportsAcrossLibraries",
        reason: "the loader that reads this file resolves no alias",
      },
    ],
    probes: [
      { file: "libs/exempt-source/src/allowed.ts", upstream: [] },
      {
        file: "libs/exempt-source/src/reported.ts",
        upstream: ["noRelativeOrAbsoluteImportsAcrossLibraries"],
      },
      {
        file: "libs/exempt-source/src/directive-only.ts",
        upstream: [],
        tool: ["noRelativeOrAbsoluteImportsAcrossLibraries"],
        divergence: {
          direction: "stricter",
          reason:
            "an `eslint-disable` directive exempts upstream and nothing here: reading ESLint's comment syntax would tie a five-language tool to a JavaScript convention and give exemptions a second home besides the shared config",
        },
      },
      {
        file: "libs/exempt-source/src/suppression-only.ts",
        upstream: ["noRelativeOrAbsoluteImportsAcrossLibraries"],
        tool: [],
        divergence: {
          direction: "weaker",
          reason:
            "a `boundarySuppressions` entry exempts this engine and nothing upstream, which cannot read the shared config — the one weaker direction that is a mechanism difference rather than a missed import, and the reason a workspace running both must configure both",
        },
      },
    ],
  },
  {
    id: "external-resources-reached-by-path",
    intent:
      "A relative or absolute path that lands in no project is an external resource reached the wrong way — and the near-miss is the same spelling pointing at a file that does exist outside every project.",
    projects: [
      {
        name: "walker",
        root: "libs/walker",
        files: {
          "src/missing.ts":
            'import { gone } from "../../../outside/missing";\nexport const a = gone;\n',
          "src/present.ts":
            'import { there } from "../../../outside/present";\nexport const b = there;\n',
          "src/rooted.ts": 'import { abs } from "/outside/present";\nexport const c = abs;\n',
          "src/escapes.ts":
            'import { away } from "../../../../../../../../outside/present";\nexport const d = away;\n',
        },
      },
    ],
    looseFiles: { "outside/present.ts": barrel("there") },
    unresolvable: [
      "../../../outside/missing",
      "/outside/present",
      "../../../../../../../../outside/present",
    ],
    probes: [
      { file: "libs/walker/src/missing.ts", upstream: ["noRelativeOrAbsoluteExternals"] },
      { file: "libs/walker/src/present.ts", upstream: ["noRelativeOrAbsoluteExternals"] },
      { file: "libs/walker/src/rooted.ts", upstream: ["noRelativeOrAbsoluteExternals"] },
      { file: "libs/walker/src/escapes.ts", upstream: ["noRelativeOrAbsoluteExternals"] },
    ],
  },

  // ------------------------------------------------------------------ topology
  {
    id: "circular-dependency-between-projects",
    intent:
      "A cycle is detected on the path that already leads back from the target to the source; without that return path the same import is clean.",
    projects: [
      {
        name: "ring-left",
        root: "libs/ring-left",
        files: {
          "src/index.ts":
            'import { ringRight } from "@circle/right";\nexport const ringLeft = ringRight;\n',
        },
      },
      {
        name: "ring-right",
        root: "libs/ring-right",
        files: { "src/index.ts": barrel("ringRight") },
      },
      {
        name: "line-head",
        root: "libs/line-head",
        files: {
          "src/index.ts":
            'import { lineTail } from "@circle/tail";\nexport const lineHead = lineTail;\n',
        },
      },
      { name: "line-tail", root: "libs/line-tail", files: { "src/index.ts": barrel("lineTail") } },
    ],
    aliases: {
      "@circle/right": "libs/ring-right/src/index.ts",
      "@circle/tail": "libs/line-tail/src/index.ts",
    },
    edges: [
      { source: "ring-left", target: "ring-right" },
      { source: "ring-right", target: "ring-left" },
      { source: "line-head", target: "line-tail" },
    ],
    probes: [
      { file: "libs/ring-left/src/index.ts", upstream: ["noCircularDependencies"] },
      { file: "libs/line-head/src/index.ts", upstream: [] },
    ],
  },
  {
    id: "circular-dependency-on-an-ignored-pair",
    intent: "An ignored pair excuses the hop, so the same cycle reports nothing.",
    projects: [
      {
        name: "ignored-left",
        root: "libs/ignored-left",
        files: {
          "src/index.ts":
            'import { ignoredRight } from "@ignored/right";\nexport const ignoredLeft = ignoredRight;\n',
        },
      },
      {
        name: "ignored-right",
        root: "libs/ignored-right",
        files: { "src/index.ts": barrel("ignoredRight") },
      },
    ],
    aliases: { "@ignored/right": "libs/ignored-right/src/index.ts" },
    edges: [
      { source: "ignored-left", target: "ignored-right" },
      { source: "ignored-right", target: "ignored-left" },
    ],
    options: { ignoredCircularDependencies: [["ignored-left", "ignored-right"]] },
    probes: [{ file: "libs/ignored-left/src/index.ts", upstream: [] }],
  },
  {
    id: "self-import-through-the-project-alias",
    intent:
      "A file reaching its own project through the public alias is a cycle through the barrel; spelled relatively, or with the option on, it is not.",
    projects: [
      {
        name: "barrel-user",
        root: "libs/barrel-user",
        files: {
          "src/index.ts": barrel("published"),
          "src/through-alias.ts":
            'import { published } from "@self/barrel";\nexport const a = published;\n',
          "src/through-path.ts":
            'import { published } from "./index";\nexport const b = published;\n',
        },
      },
    ],
    aliases: { "@self/barrel": "libs/barrel-user/src/index.ts" },
    probes: [
      { file: "libs/barrel-user/src/through-alias.ts", upstream: ["noSelfCircularDependencies"] },
      { file: "libs/barrel-user/src/through-path.ts", upstream: [] },
    ],
  },
  {
    id: "self-import-permitted-by-the-circular-self-option",
    intent: "`allowCircularSelfDependency` turns the same self-import into a non-event.",
    projects: [
      {
        name: "permitted-barrel",
        root: "libs/permitted-barrel",
        files: {
          "src/index.ts": barrel("permitted"),
          "src/through-alias.ts":
            'import { permitted } from "@permitted/barrel";\nexport const a = permitted;\n',
        },
      },
    ],
    aliases: { "@permitted/barrel": "libs/permitted-barrel/src/index.ts" },
    options: { allowCircularSelfDependency: true },
    probes: [{ file: "libs/permitted-barrel/src/through-alias.ts", upstream: [] }],
  },
  {
    id: "self-import-from-a-secondary-entry-point",
    intent:
      "A file importing its own package's SECONDARY entry point is exempt — and only the exports map, never the directory walk, is what makes the exemption apply.",
    projects: [
      {
        name: "entry-aware",
        root: "libs/entry-aware",
        packageJson: secondaryEntryPoints,
        entryPoints: [{ path: "libs/entry-aware/sub", file: "libs/entry-aware/src/sub.ts" }],
        files: {
          "src/index.ts": 'import { sub } from "@entry/aware/sub";\nexport const main = sub;\n',
          "src/sub.ts": barrel("sub"),
        },
      },
    ],
    aliases: {
      "@entry/aware": "libs/entry-aware/src/index.ts",
      "@entry/aware/sub": "libs/entry-aware/src/sub.ts",
    },
    probes: [{ file: "libs/entry-aware/src/index.ts", upstream: [] }],
  },
  {
    id: "self-import-from-inside-a-secondary-entry-point-directory",
    intent:
      "The decisive test for `getEntryPoint`'s directory walk: a file INSIDE an entry point's own directory, importing that entry point. If the walk matched, the two entry points would be equal and the self-import would be reported. Both engines stay silent, because the walked value always carries a trailing slash and an entry point's path never does — the branch cannot fire.",
    projects: [
      {
        name: "entry-directory",
        root: "libs/entry-directory",
        packageJson: {
          name: "entry-directory-fixture",
          exports: { ".": "./src/index.ts", "./src/sub": "./src/sub/index.ts" },
        },
        entryPoints: [
          { path: "libs/entry-directory/src/sub", file: "libs/entry-directory/src/sub/index.ts" },
        ],
        files: {
          "src/index.ts": barrel("root"),
          "src/sub/index.ts": barrel("sub"),
          "src/sub/deep.ts":
            'import { sub } from "@entry/directory/src/sub";\nexport const a = sub;\n',
        },
      },
    ],
    aliases: {
      "@entry/directory": "libs/entry-directory/src/index.ts",
      "@entry/directory/src/sub": "libs/entry-directory/src/sub/index.ts",
    },
    probes: [{ file: "libs/entry-directory/src/sub/deep.ts", upstream: [] }],
  },
  {
    id: "secondary-entry-point-declared-with-a-trailing-slash",
    intent:
      "The other half of the same test: an `exports` key spelled with a trailing slash makes the entry point's path carry one too, the directory walk MATCHES, and the self-import is reported. The walk is therefore not dead in general — it is dead for every key shape but this one.",
    projects: [
      {
        name: "entry-slash",
        root: "libs/entry-slash",
        packageJson: {
          name: "entry-slash-fixture",
          exports: { ".": "./src/index.ts", "./src/sub/": "./src/sub/index.ts" },
        },
        entryPoints: [
          { path: "libs/entry-slash/src/sub/", file: "libs/entry-slash/src/sub/index.ts" },
        ],
        files: {
          "src/index.ts": barrel("root"),
          "src/sub/index.ts": barrel("sub"),
          "src/sub/deep.ts": 'import { sub } from "@entry/slash/src/sub";\nexport const a = sub;\n',
        },
      },
    ],
    aliases: {
      "@entry/slash": "libs/entry-slash/src/index.ts",
      "@entry/slash/src/sub": "libs/entry-slash/src/sub/index.ts",
    },
    probes: [
      { file: "libs/entry-slash/src/sub/deep.ts", upstream: ["noSelfCircularDependencies"] },
    ],
  },
  {
    id: "self-import-with-no-entry-point-data-on-the-node",
    intent:
      "The same tree with the graph node carrying no entry-point data: upstream reads the exports map off disk, this engine has nothing to read and fails closed.",
    projects: [
      {
        name: "entry-blind",
        root: "libs/entry-blind",
        packageJson: secondaryEntryPoints,
        files: {
          "src/index.ts": 'import { sub } from "@blind/aware/sub";\nexport const main = sub;\n',
          "src/sub.ts": barrel("sub"),
        },
      },
    ],
    aliases: {
      "@blind/aware": "libs/entry-blind/src/index.ts",
      "@blind/aware/sub": "libs/entry-blind/src/sub.ts",
    },
    probes: [
      {
        file: "libs/entry-blind/src/index.ts",
        upstream: [],
        tool: ["noSelfCircularDependencies"],
        divergence: {
          direction: "stricter",
          reason: "`data.entryPoints` absent — the secondary-entry-point exemption does not apply",
        },
      },
    ],
  },
  {
    id: "import-of-an-application",
    intent:
      "An app is not importable, unless it is a Module Federation remote — which upstream decides by reading a config file and this engine by reading a graph field.",
    projects: [
      {
        name: "app-consumer",
        root: "libs/app-consumer",
        files: {
          "src/plain.ts": 'import { plainApp } from "@apps/plain";\nexport const a = plainApp;\n',
          "src/remote.ts":
            'import { remoteApp } from "@apps/remote";\nexport const b = remoteApp;\n',
        },
      },
      {
        name: "plain-app",
        type: "app",
        root: "apps/plain",
        files: { "src/index.ts": barrel("plainApp") },
      },
      {
        name: "remote-app",
        type: "app",
        root: "apps/remote",
        mfeRemote: true,
        moduleFederation: MFE_CONFIG,
        files: { "src/index.ts": barrel("remoteApp") },
      },
    ],
    aliases: {
      "@apps/plain": "apps/plain/src/index.ts",
      "@apps/remote": "apps/remote/src/index.ts",
    },
    probes: [
      { file: "libs/app-consumer/src/plain.ts", upstream: ["noImportsOfApps"] },
      { file: "libs/app-consumer/src/remote.ts", upstream: [] },
    ],
  },
  {
    id: "import-of-a-remote-application-with-no-remote-data-on-the-node",
    intent:
      "The federation config is on disk but the graph node does not say so: upstream exempts the app, this engine cannot see the fact and reports.",
    projects: [
      {
        name: "blind-consumer",
        root: "libs/blind-consumer",
        files: {
          "src/index.ts": 'import { blindApp } from "@apps/blind";\nexport const a = blindApp;\n',
        },
      },
      {
        name: "blind-app",
        type: "app",
        root: "apps/blind",
        moduleFederation: MFE_CONFIG,
        files: { "src/index.ts": barrel("blindApp") },
      },
    ],
    aliases: { "@apps/blind": "apps/blind/src/index.ts" },
    probes: [
      {
        file: "libs/blind-consumer/src/index.ts",
        upstream: [],
        tool: ["noImportsOfApps"],
        divergence: {
          direction: "stricter",
          reason: "`data.mfeRemote` absent — the Module Federation exemption does not apply",
        },
      },
    ],
  },
  {
    id: "import-of-an-end-to-end-suite",
    intent:
      "An e2e project may not be imported; the rule is about the TARGET being e2e, so an e2e project importing a lib is fine.",
    projects: [
      {
        name: "suite-consumer",
        root: "libs/suite-consumer",
        files: { "src/index.ts": 'import { suite } from "@e2e/suite";\nexport const a = suite;\n' },
      },
      {
        name: "suite",
        type: "e2e",
        root: "apps/suite-e2e",
        files: { "src/index.ts": barrel("suite") },
      },
      {
        name: "suite-driver",
        type: "e2e",
        root: "apps/driver-e2e",
        files: {
          "src/index.ts": 'import { plainLib } from "@e2e/lib";\nexport const b = plainLib;\n',
        },
      },
      { name: "plain-lib", root: "libs/plain-lib", files: { "src/index.ts": barrel("plainLib") } },
    ],
    aliases: {
      "@e2e/suite": "apps/suite-e2e/src/index.ts",
      "@e2e/lib": "libs/plain-lib/src/index.ts",
    },
    probes: [
      { file: "libs/suite-consumer/src/index.ts", upstream: ["noImportsOfE2e"] },
      { file: "apps/driver-e2e/src/index.ts", upstream: [] },
    ],
  },
  {
    id: "buildable-library-importing-a-non-buildable-one",
    intent:
      "With the option on, a lib that has a build target may not import one that has none; two buildable libs are fine.",
    projects: [
      {
        name: "buildable-consumer",
        root: "libs/buildable-consumer",
        targets: { build: { executor: "nx:run-commands" } },
        files: {
          "src/loose.ts": 'import { loose } from "@build/loose";\nexport const a = loose;\n',
          "src/firm.ts": 'import { firm } from "@build/firm";\nexport const b = firm;\n',
        },
      },
      { name: "loose-lib", root: "libs/loose-lib", files: { "src/index.ts": barrel("loose") } },
      {
        name: "firm-lib",
        root: "libs/firm-lib",
        targets: { build: { executor: "nx:run-commands" } },
        files: { "src/index.ts": barrel("firm") },
      },
    ],
    aliases: {
      "@build/loose": "libs/loose-lib/src/index.ts",
      "@build/firm": "libs/firm-lib/src/index.ts",
    },
    options: { enforceBuildableLibDependency: true },
    probes: [
      {
        file: "libs/buildable-consumer/src/loose.ts",
        upstream: ["noImportOfNonBuildableLibraries"],
      },
      { file: "libs/buildable-consumer/src/firm.ts", upstream: [] },
    ],
  },
  {
    id: "static-import-of-a-lazy-loaded-library",
    intent:
      "A static import of a library something lazy-loads defeats the lazy loading — but only an `import` declaration counts: a dynamic import, a re-export and a type-only import are all exempt upstream.",
    projects: [
      {
        name: "lazy-consumer",
        root: "libs/lazy-consumer",
        files: {
          "src/static.ts": 'import { lazy } from "@lazy/target";\nexport const a = lazy;\n',
          "src/dynamic.ts": 'export const b = () => import("@lazy/target");\n',
          "src/re-export.ts": 'export * from "@lazy/target";\n',
          "src/type-only.ts":
            'import type { Lazy } from "@lazy/target";\nexport type Alias = Lazy;\n',
          "src/eager.ts": 'import { eager } from "@lazy/eager";\nexport const c = eager;\n',
        },
      },
      {
        name: "lazy-target",
        root: "libs/lazy-target",
        files: { "src/index.ts": "export const lazy = 1;\nexport type Lazy = number;\n" },
      },
      {
        name: "eager-target",
        root: "libs/eager-target",
        files: { "src/index.ts": barrel("eager") },
      },
    ],
    aliases: {
      "@lazy/target": "libs/lazy-target/src/index.ts",
      "@lazy/eager": "libs/eager-target/src/index.ts",
    },
    edges: [
      { source: "lazy-consumer", target: "lazy-target", type: "dynamic" },
      { source: "lazy-consumer", target: "eager-target", type: "static" },
    ],
    probes: [
      { file: "libs/lazy-consumer/src/static.ts", upstream: ["noImportsOfLazyLoadedLibraries"] },
      { file: "libs/lazy-consumer/src/dynamic.ts", upstream: [] },
      { file: "libs/lazy-consumer/src/re-export.ts", upstream: [] },
      { file: "libs/lazy-consumer/src/type-only.ts", upstream: [] },
      { file: "libs/lazy-consumer/src/eager.ts", upstream: [] },
    ],
  },
  {
    id: "lazy-loaded-library-named-in-the-dynamic-exception-list",
    intent: "`checkDynamicDependenciesExceptions` silences the same static import.",
    projects: [
      {
        name: "excepted-consumer",
        root: "libs/excepted-consumer",
        files: {
          "src/index.ts":
            'import { excepted } from "@excepted/target";\nexport const a = excepted;\n',
        },
      },
      {
        name: "excepted-target",
        root: "libs/excepted-target",
        files: { "src/index.ts": barrel("excepted") },
      },
    ],
    aliases: { "@excepted/target": "libs/excepted-target/src/index.ts" },
    edges: [{ source: "excepted-consumer", target: "excepted-target", type: "dynamic" }],
    options: { checkDynamicDependenciesExceptions: ["@excepted/target"] },
    probes: [{ file: "libs/excepted-consumer/src/index.ts", upstream: [] }],
  },
  {
    id: "require-of-a-lazy-loaded-library",
    intent:
      "`require()` reaches the rule as a call expression, which upstream excludes from the lazy-load check; the analysis contract records it as a static import and cannot tell the two apart.",
    projects: [
      {
        name: "require-consumer",
        root: "libs/require-consumer",
        files: {
          "src/index.cjs":
            'const { required } = require("@required/target");\nmodule.exports = { required };\n',
        },
      },
      {
        name: "require-target",
        root: "libs/require-target",
        files: { "src/index.ts": barrel("required") },
      },
    ],
    aliases: { "@required/target": "libs/require-target/src/index.ts" },
    edges: [{ source: "require-consumer", target: "require-target", type: "dynamic" }],
    probes: [
      {
        file: "libs/require-consumer/src/index.cjs",
        upstream: [],
        tool: ["noImportsOfLazyLoadedLibraries"],
        divergence: {
          direction: "stricter",
          reason:
            '`require()` is recorded as `kind: "static"`, which upstream\'s node-type test excludes',
        },
      },
    ],
  },

  // ---------------------------------------------------------------------- tags
  {
    id: "project-whose-tags-match-no-constraint",
    intent:
      "No matching constraint is an ERROR upstream, not a pass — the single semantic a reimplementation is most likely to invert.",
    projects: [
      {
        name: "untagged-source",
        root: "libs/untagged-source",
        tags: ["kind:unlisted"],
        files: {
          "src/index.ts": 'import { known } from "@orphan/known";\nexport const a = known;\n',
        },
      },
      {
        name: "known-target",
        root: "libs/known-target",
        tags: ["kind:known"],
        files: { "src/index.ts": barrel("known") },
      },
    ],
    aliases: { "@orphan/known": "libs/known-target/src/index.ts" },
    depConstraints: [{ sourceTag: "kind:known", onlyDependOnLibsWithTags: ["kind:known"] }],
    probes: [
      {
        file: "libs/untagged-source/src/index.ts",
        upstream: ["projectWithoutTagsCannotHaveDependencies"],
      },
    ],
  },
  {
    id: "constraint-rows-that-disarm-the-no-constraint-error",
    intent:
      "Two rows that state no constraint at all still count as matches, so the no-constraint error never fires: a wildcard source tag, and a row naming only its own source tag.",
    projects: [
      {
        name: "wildcard-source",
        root: "libs/wildcard-source",
        tags: ["kind:unlisted"],
        files: {
          "src/index.ts":
            'import { disarmed } from "@disarm/target";\nexport const a = disarmed;\n',
        },
      },
      {
        name: "named-source",
        root: "libs/named-source",
        tags: ["kind:named"],
        files: {
          "src/index.ts":
            'import { disarmed } from "@disarm/target";\nexport const b = disarmed;\n',
        },
      },
      {
        name: "disarm-target",
        root: "libs/disarm-target",
        tags: ["kind:known"],
        files: { "src/index.ts": barrel("disarmed") },
      },
    ],
    aliases: { "@disarm/target": "libs/disarm-target/src/index.ts" },
    depConstraints: [{ sourceTag: "*" }, { sourceTag: "kind:named" }],
    probes: [
      { file: "libs/wildcard-source/src/index.ts", upstream: [] },
      { file: "libs/named-source/src/index.ts", upstream: [] },
    ],
  },
  {
    id: "external-import-from-a-project-matching-no-constraint",
    intent:
      "An npm target returns before the tag block, so however untagged the source is, an external import can never produce the no-constraint error.",
    projects: [
      {
        name: "external-orphan",
        root: "libs/external-orphan",
        tags: ["kind:unlisted"],
        files: {
          "src/index.ts":
            'import { entry } from "@orphan-external/pkg";\nexport const a = entry;\n',
        },
      },
    ],
    externals: [{ name: "@orphan-external/pkg", files: packageFiles }],
    depConstraints: [{ sourceTag: "kind:listed", onlyDependOnLibsWithTags: ["kind:listed"] }],
    probes: [{ file: "libs/external-orphan/src/index.ts", upstream: [] }],
  },
  {
    id: "only-tags-constraint",
    intent: "The target must carry at least one of the allowed tags.",
    projects: [
      {
        name: "only-source",
        root: "libs/only-source",
        tags: ["axis:source"],
        files: {
          "src/wrong.ts": 'import { wrong } from "@only/wrong";\nexport const a = wrong;\n',
          "src/right.ts": 'import { right } from "@only/right";\nexport const b = right;\n',
        },
      },
      {
        name: "only-wrong",
        root: "libs/only-wrong",
        tags: ["axis:other"],
        files: { "src/index.ts": barrel("wrong") },
      },
      {
        name: "only-right",
        root: "libs/only-right",
        tags: ["axis:allowed"],
        files: { "src/index.ts": barrel("right") },
      },
    ],
    aliases: {
      "@only/wrong": "libs/only-wrong/src/index.ts",
      "@only/right": "libs/only-right/src/index.ts",
    },
    depConstraints: [{ sourceTag: "axis:source", onlyDependOnLibsWithTags: ["axis:allowed"] }],
    probes: [
      { file: "libs/only-source/src/wrong.ts", upstream: ["onlyTagsConstraintViolation"] },
      { file: "libs/only-source/src/right.ts", upstream: [] },
    ],
  },
  {
    id: "dependency-failing-one-of-four-matching-constraints",
    intent:
      "Several matching rows are AND, not OR: a source on four tag axes is held to all four, and satisfying three is still a violation.",
    projects: [
      {
        name: "four-axis-source",
        root: "libs/four-axis-source",
        tags: ["type:unit", "scope:inner", "layer:core", "licence:open"],
        files: {
          "src/near.ts": 'import { near } from "@four/near";\nexport const a = near;\n',
          "src/clean.ts": 'import { clean } from "@four/clean";\nexport const b = clean;\n',
        },
      },
      {
        name: "four-axis-near",
        root: "libs/four-axis-near",
        tags: ["type:unit", "scope:inner", "layer:core", "licence:closed"],
        files: { "src/index.ts": barrel("near") },
      },
      {
        name: "four-axis-clean",
        root: "libs/four-axis-clean",
        tags: ["type:unit", "scope:inner", "layer:core", "licence:open"],
        files: { "src/index.ts": barrel("clean") },
      },
    ],
    aliases: {
      "@four/near": "libs/four-axis-near/src/index.ts",
      "@four/clean": "libs/four-axis-clean/src/index.ts",
    },
    depConstraints: [
      { sourceTag: "type:unit", onlyDependOnLibsWithTags: ["type:unit"] },
      { sourceTag: "scope:inner", onlyDependOnLibsWithTags: ["scope:inner"] },
      { sourceTag: "layer:core", onlyDependOnLibsWithTags: ["layer:core"] },
      { sourceTag: "licence:open", onlyDependOnLibsWithTags: ["licence:open"] },
    ],
    probes: [
      { file: "libs/four-axis-source/src/near.ts", upstream: ["onlyTagsConstraintViolation"] },
      { file: "libs/four-axis-source/src/clean.ts", upstream: [] },
    ],
  },
  {
    id: "empty-only-tags-constraint",
    intent:
      "`onlyDependOnLibsWithTags: []` is a rule of its own — it bans TAGGED dependencies, so an untagged target passes it.",
    projects: [
      {
        name: "empty-only-source",
        root: "libs/empty-only-source",
        tags: ["axis:strict"],
        files: {
          "src/tagged.ts": 'import { tagged } from "@empty/tagged";\nexport const a = tagged;\n',
          "src/bare.ts": 'import { bare } from "@empty/bare";\nexport const b = bare;\n',
        },
      },
      {
        name: "empty-tagged",
        root: "libs/empty-tagged",
        tags: ["axis:any"],
        files: { "src/index.ts": barrel("tagged") },
      },
      {
        name: "empty-bare",
        root: "libs/empty-bare",
        tags: [],
        files: { "src/index.ts": barrel("bare") },
      },
    ],
    aliases: {
      "@empty/tagged": "libs/empty-tagged/src/index.ts",
      "@empty/bare": "libs/empty-bare/src/index.ts",
    },
    depConstraints: [{ sourceTag: "axis:strict", onlyDependOnLibsWithTags: [] }],
    probes: [
      {
        file: "libs/empty-only-source/src/tagged.ts",
        upstream: ["emptyOnlyTagsConstraintViolation"],
      },
      { file: "libs/empty-only-source/src/bare.ts", upstream: [] },
    ],
  },
  {
    id: "not-tags-constraint",
    intent:
      "`notDependOnLibsWithTags` is transitive: a clean library that itself reaches a forbidden one is still a violation.",
    projects: [
      {
        name: "not-source",
        root: "libs/not-source",
        tags: ["axis:guarded"],
        files: {
          "src/direct.ts":
            'import { forbidden } from "@not/forbidden";\nexport const a = forbidden;\n',
          "src/indirect.ts": 'import { relay } from "@not/relay";\nexport const b = relay;\n',
          "src/clean.ts": 'import { safe } from "@not/safe";\nexport const c = safe;\n',
        },
      },
      {
        name: "not-forbidden",
        root: "libs/not-forbidden",
        tags: ["axis:forbidden"],
        files: { "src/index.ts": barrel("forbidden") },
      },
      {
        name: "not-relay",
        root: "libs/not-relay",
        tags: ["axis:plain"],
        files: { "src/index.ts": barrel("relay") },
      },
      {
        name: "not-safe",
        root: "libs/not-safe",
        tags: ["axis:plain"],
        files: { "src/index.ts": barrel("safe") },
      },
    ],
    aliases: {
      "@not/forbidden": "libs/not-forbidden/src/index.ts",
      "@not/relay": "libs/not-relay/src/index.ts",
      "@not/safe": "libs/not-safe/src/index.ts",
    },
    edges: [{ source: "not-relay", target: "not-forbidden" }],
    depConstraints: [{ sourceTag: "axis:guarded", notDependOnLibsWithTags: ["axis:forbidden"] }],
    probes: [
      { file: "libs/not-source/src/direct.ts", upstream: ["notTagsConstraintViolation"] },
      { file: "libs/not-source/src/indirect.ts", upstream: ["notTagsConstraintViolation"] },
      { file: "libs/not-source/src/clean.ts", upstream: [] },
    ],
  },

  // ---------------------------------------------------------- external imports
  {
    id: "banned-external-imports",
    intent:
      "A ban is a glob over the FULL specifier, so `@scope/pkg/*` stops the deep paths and leaves the entry point importable.",
    projects: [
      {
        name: "ban-source",
        root: "libs/ban-source",
        tags: ["axis:banned"],
        files: {
          "src/nested.ts": 'import { nested } from "@banned/pkg/sub";\nexport const a = nested;\n',
          "src/entry.ts": 'import { entry } from "@banned/pkg";\nexport const b = entry;\n',
        },
      },
    ],
    externals: [{ name: "@banned/pkg", files: packageFiles }],
    depConstraints: [{ sourceTag: "axis:banned", bannedExternalImports: ["@banned/pkg/*"] }],
    probes: [
      { file: "libs/ban-source/src/nested.ts", upstream: ["bannedExternalImportsViolation"] },
      { file: "libs/ban-source/src/entry.ts", upstream: [] },
    ],
  },
  {
    id: "external-imports-under-an-allowlist",
    intent:
      "`allowedExternalImports` is evaluated with `every()`: an EMPTY list bans the package outright, an entry without a wildcard still bans the deep paths, and an absent list bans nothing.",
    projects: [
      {
        name: "allowlist-empty",
        root: "libs/allowlist-empty",
        tags: ["axis:empty-allow"],
        files: {
          "src/index.ts": 'import { entry } from "@allowlist/pkg";\nexport const a = entry;\n',
        },
      },
      {
        name: "allowlist-exact",
        root: "libs/allowlist-exact",
        tags: ["axis:exact-allow"],
        files: {
          "src/nested.ts":
            'import { nested } from "@allowlist/pkg/sub";\nexport const b = nested;\n',
          "src/entry.ts": 'import { entry } from "@allowlist/pkg";\nexport const c = entry;\n',
        },
      },
      {
        name: "allowlist-absent",
        root: "libs/allowlist-absent",
        tags: ["axis:no-allow"],
        files: {
          "src/index.ts":
            'import { nested } from "@allowlist/pkg/sub";\nexport const d = nested;\n',
        },
      },
    ],
    externals: [{ name: "@allowlist/pkg", files: packageFiles }],
    depConstraints: [
      { sourceTag: "axis:empty-allow", allowedExternalImports: [] },
      { sourceTag: "axis:exact-allow", allowedExternalImports: ["@allowlist/pkg"] },
      { sourceTag: "axis:no-allow" },
    ],
    probes: [
      { file: "libs/allowlist-empty/src/index.ts", upstream: ["bannedExternalImportsViolation"] },
      { file: "libs/allowlist-exact/src/nested.ts", upstream: ["bannedExternalImportsViolation"] },
      { file: "libs/allowlist-exact/src/entry.ts", upstream: [] },
      { file: "libs/allowlist-absent/src/index.ts", upstream: [] },
    ],
  },
  {
    id: "banned-external-import-of-a-package-that-is-not-installed",
    intent:
      "The exact edge of the synthesized-external-node divergence. Upstream's locator finds an npm target only through the graph's `externalNodes` — the `node_modules` read supplies the `name@version` it looks up there — so it comes up empty for anything absent from that map, and there the TypeScript analyzer also records the import as unresolvable, so this engine synthesizes nothing and is silent too. The synthesis therefore changes a verdict only for the languages whose analyzers name a package without needing it installed.",
    projects: [
      {
        name: "ghost-source",
        root: "libs/ghost-source",
        tags: ["axis:ghost"],
        files: { "src/index.ts": 'import { gone } from "@ghost/pkg";\nexport const a = gone;\n' },
      },
    ],
    unresolvable: ["@ghost/pkg"],
    depConstraints: [{ sourceTag: "axis:ghost", bannedExternalImports: ["@ghost/*"] }],
    probes: [{ file: "libs/ghost-source/src/index.ts", upstream: [] }],
  },
  {
    id: "nested-banned-external-import",
    intent:
      "The nested ban is checked against the specifier of the import being judged, which by then names a PROJECT — so it fires only where a project's alias and a reachable package name coincide, and stays silent when they differ or the option is off.",
    projects: [
      {
        name: "nested-source",
        root: "libs/nested-source",
        tags: ["axis:nested"],
        files: {
          "src/collides.ts": 'import { shared } from "nested-shared";\nexport const a = shared;\n',
          "src/differs.ts": 'import { apart } from "@nested/apart";\nexport const b = apart;\n',
        },
      },
      {
        name: "nested-collides",
        root: "libs/nested-collides",
        files: { "src/index.ts": barrel("shared") },
      },
      {
        name: "nested-apart",
        root: "libs/nested-apart",
        files: { "src/index.ts": barrel("apart") },
      },
    ],
    aliases: {
      "nested-shared": "libs/nested-collides/src/index.ts",
      "@nested/apart": "libs/nested-apart/src/index.ts",
    },
    externals: [{ name: "nested-shared", install: false }],
    edges: [
      { source: "nested-collides", target: "npm:nested-shared" },
      { source: "nested-apart", target: "npm:nested-shared" },
    ],
    options: { checkNestedExternalImports: true },
    depConstraints: [{ sourceTag: "axis:nested", bannedExternalImports: ["nested-shared"] }],
    probes: [
      {
        file: "libs/nested-source/src/collides.ts",
        upstream: ["nestedBannedExternalImportsViolation"],
      },
      { file: "libs/nested-source/src/differs.ts", upstream: [] },
    ],
  },
  {
    id: "nested-banned-external-import-with-the-check-off",
    intent: "The same collision with `checkNestedExternalImports` off reports nothing.",
    projects: [
      {
        name: "unchecked-source",
        root: "libs/unchecked-source",
        tags: ["axis:unchecked"],
        files: {
          "src/index.ts": 'import { shared } from "unchecked-shared";\nexport const a = shared;\n',
        },
      },
      {
        name: "unchecked-collides",
        root: "libs/unchecked-collides",
        files: { "src/index.ts": barrel("shared") },
      },
    ],
    aliases: { "unchecked-shared": "libs/unchecked-collides/src/index.ts" },
    externals: [{ name: "unchecked-shared", install: false }],
    edges: [{ source: "unchecked-collides", target: "npm:unchecked-shared" }],
    depConstraints: [{ sourceTag: "axis:unchecked", bannedExternalImports: ["unchecked-shared"] }],
    probes: [{ file: "libs/unchecked-source/src/index.ts", upstream: [] }],
  },
  {
    id: "transitive-dependencies-under-the-ban",
    intent:
      "With `banTransitiveDependencies` on, a package the source does not declare is reported, a declared one is not, and a Node built-in never is.",
    projects: [
      {
        name: "transitive-source",
        root: "libs/transitive-source",
        declaredPackages: ["@transitive/declared"],
        files: {
          "src/undeclared.ts":
            'import { entry } from "@transitive/undeclared";\nexport const a = entry;\n',
          "src/declared.ts":
            'import { entry } from "@transitive/declared";\nexport const b = entry;\n',
          "src/builtin.ts": 'import { join } from "node:path";\nexport const c = join;\n',
          "src/missing.ts":
            'import { gone } from "@transitive/never-installed";\nexport const d = gone;\n',
        },
      },
    ],
    externals: [
      { name: "@transitive/undeclared", files: packageFiles },
      { name: "@transitive/declared", files: packageFiles },
    ],
    rootDependencies: ["@transitive/declared"],
    // The fourth probe is the branch upstream reaches when it finds no target
    // at all, so the package it names must not exist.
    unresolvable: ["@transitive/never-installed"],
    options: { banTransitiveDependencies: true },
    probes: [
      { file: "libs/transitive-source/src/undeclared.ts", upstream: ["noTransitiveDependencies"] },
      { file: "libs/transitive-source/src/declared.ts", upstream: [] },
      { file: "libs/transitive-source/src/builtin.ts", upstream: [] },
      { file: "libs/transitive-source/src/missing.ts", upstream: ["noTransitiveDependencies"] },
    ],
  },
  {
    id: "transitive-dependency-with-no-declared-package-data-on-the-node",
    intent:
      "The package is declared in the workspace manifest, which upstream reads off disk; the graph node carries no declared-package list, so this engine cannot prove the dependency is direct and does not assume it.",
    projects: [
      {
        name: "undeclared-view",
        root: "libs/undeclared-view",
        files: {
          "src/index.ts": 'import { entry } from "@manifest/only";\nexport const a = entry;\n',
        },
      },
    ],
    externals: [{ name: "@manifest/only", files: packageFiles }],
    rootDependencies: ["@manifest/only"],
    options: { banTransitiveDependencies: true },
    probes: [
      {
        file: "libs/undeclared-view/src/index.ts",
        upstream: [],
        tool: ["noTransitiveDependencies"],
        divergence: {
          direction: "stricter",
          reason: "`data.declaredPackages` absent — the dependency cannot be shown to be direct",
        },
      },
    ],
  },
  {
    id: "transitive-dependencies-with-the-ban-off",
    intent: "The same undeclared package with the option off is not a violation.",
    projects: [
      {
        name: "unbanned-source",
        root: "libs/unbanned-source",
        files: {
          "src/index.ts": 'import { entry } from "@unbanned/pkg";\nexport const a = entry;\n',
        },
      },
    ],
    externals: [{ name: "@unbanned/pkg", files: packageFiles }],
    probes: [{ file: "libs/unbanned-source/src/index.ts", upstream: [] }],
  },

  // ------------------------------------------------------------------- `allow`
  {
    id: "allow-entries-and-what-they-really-match",
    intent:
      "`allow` is matched against the raw specifier by Nx's own matcher, whose fallback branch is an UNANCHORED regular expression — so an entry without a wildcard exempts every specifier that merely contains it.",
    projects: [
      {
        name: "allow-source",
        root: "libs/allow-source",
        tags: ["axis:allow"],
        files: {
          "src/wildcard.ts": 'import { wild } from "@allowed/wild/deep";\nexport const a = wild;\n',
          "src/surrounded.ts":
            'import { plain } from "wrapped-@allowed/plain-tail";\nexport const b = plain;\n',
          "src/uncovered.ts": 'import { wild } from "@allowed/wild";\nexport const c = wild;\n',
        },
      },
      {
        name: "allow-target",
        root: "libs/allow-target",
        tags: ["axis:refused"],
        files: { "src/index.ts": barrel("wild") },
      },
      {
        name: "allow-plain",
        root: "libs/allow-plain",
        tags: ["axis:refused"],
        files: { "src/index.ts": barrel("plain") },
      },
    ],
    aliases: {
      "@allowed/wild": "libs/allow-target/src/index.ts",
      "@allowed/wild/deep": "libs/allow-target/src/index.ts",
      "wrapped-@allowed/plain-tail": "libs/allow-plain/src/index.ts",
    },
    options: { allow: ["@allowed/wild/*", "@allowed/plain"] },
    depConstraints: [{ sourceTag: "axis:allow", onlyDependOnLibsWithTags: ["axis:permitted"] }],
    probes: [
      { file: "libs/allow-source/src/wildcard.ts", upstream: [] },
      { file: "libs/allow-source/src/surrounded.ts", upstream: [] },
      // The same package with the trailing `/*` entry NOT covering it: a
      // one-segment wildcard matches the children, never the package itself.
      { file: "libs/allow-source/src/uncovered.ts", upstream: ["onlyTagsConstraintViolation"] },
    ],
  },
  {
    id: "surrounded-specifier-with-no-allow-entry",
    intent:
      "The control for the case above: the same surrounded specifier, with no `allow` entry, really does violate — so the exemption there was doing the work.",
    projects: [
      {
        name: "unallowed-source",
        root: "libs/unallowed-source",
        tags: ["axis:unallowed"],
        files: {
          "src/index.ts":
            'import { plain } from "bare-@unallowed/plain-tail";\nexport const a = plain;\n',
        },
      },
      {
        name: "unallowed-target",
        root: "libs/unallowed-target",
        tags: ["axis:refused"],
        files: { "src/index.ts": barrel("plain") },
      },
    ],
    aliases: { "bare-@unallowed/plain-tail": "libs/unallowed-target/src/index.ts" },
    depConstraints: [{ sourceTag: "axis:unallowed", onlyDependOnLibsWithTags: ["axis:permitted"] }],
    probes: [
      { file: "libs/unallowed-source/src/index.ts", upstream: ["onlyTagsConstraintViolation"] },
    ],
  },

  {
    id: "import-forms-a-boundary-check-must-see",
    intent:
      "Every syntactic form that names a module crosses the same boundary, and the two engines find those forms by different means — one walks an ESLint AST looking for five node kinds, the other reads an analysis record. This is where a form falls between them.",
    projects: [
      {
        name: "forms-source",
        root: "libs/forms-source",
        tags: ["axis:forms"],
        files: {
          "src/type-only.ts":
            'import type { Refused } from "@forms/target";\nexport type Alias = Refused;\n',
          "src/named-re-export.ts": 'export { refused } from "@forms/target";\n',
          "src/star-re-export.ts": 'export * from "@forms/target";\n',
          "src/dynamic.ts": 'export const load = () => import("@forms/target");\n',
          "src/require.cjs":
            'const { refused } = require("@forms/target");\nmodule.exports = { refused };\n',
          "src/require-resolve.cjs":
            'const where = require.resolve("@forms/target");\nmodule.exports = { where };\n',
          "src/import-equals.ts":
            'import target = require("@forms/target");\nexport const value = target;\n',
          "src/import-type.ts":
            'type Refused = import("@forms/target").Refused;\nexport type Alias = Refused;\n',
        },
      },
      {
        name: "forms-target",
        root: "libs/forms-target",
        tags: ["axis:refused"],
        files: { "src/index.ts": "export const refused = 1;\nexport type Refused = number;\n" },
      },
    ],
    aliases: { "@forms/target": "libs/forms-target/src/index.ts" },
    depConstraints: [{ sourceTag: "axis:forms", onlyDependOnLibsWithTags: ["axis:permitted"] }],
    probes: [
      { file: "libs/forms-source/src/type-only.ts", upstream: ["onlyTagsConstraintViolation"] },
      {
        file: "libs/forms-source/src/named-re-export.ts",
        upstream: ["onlyTagsConstraintViolation"],
      },
      {
        file: "libs/forms-source/src/star-re-export.ts",
        upstream: ["onlyTagsConstraintViolation"],
      },
      { file: "libs/forms-source/src/dynamic.ts", upstream: ["onlyTagsConstraintViolation"] },
      { file: "libs/forms-source/src/require.cjs", upstream: ["onlyTagsConstraintViolation"] },
      {
        file: "libs/forms-source/src/require-resolve.cjs",
        upstream: ["onlyTagsConstraintViolation"],
      },
      {
        file: "libs/forms-source/src/import-equals.ts",
        upstream: [],
        tool: ["onlyTagsConstraintViolation"],
        divergence: {
          direction: "stricter",
          reason:
            "`import x = require(...)` is a TSImportEqualsDeclaration, which is in none of upstream's five visitors; the analyzer records it as a static import",
        },
      },
      {
        file: "libs/forms-source/src/import-type.ts",
        upstream: [],
        tool: ["onlyTagsConstraintViolation"],
        divergence: {
          direction: "stricter",
          reason:
            "`import('pkg').Foo` in a type position (TSImportType) is visited by this analyzer but has no corresponding visitor in @nx/enforce-module-boundaries",
        },
      },
    ],
  },

  // ----------------------------------------- the languages beyond TypeScript's
  // Vue leads deliberately: ESLint CAN read it, given a parser, and the case
  // measures that rather than assuming it. Everything after it is a language
  // ESLint has no parser for, where upstream's silence is inability and this
  // engine is the only enforcement.
  {
    id: "banned-external-import-in-a-vue-single-file-component",
    intent:
      "A `.vue` file is the one non-TypeScript surface ESLint can be given a parser for; whether the boundary rule really fires there is measured, not assumed.",
    projects: [
      {
        name: "vue-view",
        root: "libs/vue-view",
        tags: ["axis:vue-view"],
        files: {
          "src/Panel.vue":
            '<script setup lang="ts">\nimport { entry } from "@vue-banned/pkg";\nconst value = entry;\n</script>\n\n<template>\n  <div>{{ value }}</div>\n</template>\n',
        },
      },
    ],
    externals: [{ name: "@vue-banned/pkg", files: packageFiles }],
    depConstraints: [{ sourceTag: "axis:vue-view", bannedExternalImports: ["@vue-banned/*"] }],
    probes: [{ file: "libs/vue-view/src/Panel.vue", upstream: ["bannedExternalImportsViolation"] }],
  },
  {
    id: "banned-external-crate-import-in-rust",
    intent:
      "A `.rs` file has no ESLint parser at all, so upstream is not silent by judgement but by inability — and the ban's own prefix test decides which Rust spellings it can still reach.",
    projects: [
      {
        name: "rust-view",
        root: "libs/rust-view",
        tags: ["axis:rust-view"],
        files: {
          "src/bare.rs": "use rustshell;\n\npub fn open() {}\n",
          "src/nested.rs": "use rustshell::window::Manager;\n\npub fn close() {}\n",
        },
      },
    ],
    depConstraints: [{ sourceTag: "axis:rust-view", bannedExternalImports: ["rustshell*"] }],
    probes: [
      {
        file: "libs/rust-view/src/bare.rs",
        upstream: [],
        tool: ["bannedExternalImportsViolation"],
        divergence: {
          direction: "stricter",
          reason:
            "ESLint has no parser for `.rs`; the ban is reachable only because an external node is synthesized",
        },
      },
      {
        file: "libs/rust-view/src/nested.rs",
        upstream: [],
        note: "Neither engine reports: `isConstraintBanningProject` requires the specifier to be the package name or a path under it with a `/` separator, and a Rust `::` path is neither.",
      },
    ],
  },
  {
    id: "banned-external-module-import-in-python",
    intent: "The same for `.py`: the module form the ban can reach, and the dotted form it cannot.",
    projects: [
      {
        name: "python-view",
        root: "libs/python-view",
        tags: ["axis:python-view"],
        files: {
          "src/bare.py": "import pyshell\n",
          "src/nested.py": "import pyshell.window\n",
        },
      },
    ],
    depConstraints: [{ sourceTag: "axis:python-view", bannedExternalImports: ["pyshell*"] }],
    probes: [
      {
        file: "libs/python-view/src/bare.py",
        upstream: [],
        tool: ["bannedExternalImportsViolation"],
        divergence: {
          direction: "stricter",
          reason:
            "ESLint has no parser for `.py`; the ban is reachable only because an external node is synthesized",
        },
      },
      {
        file: "libs/python-view/src/nested.py",
        upstream: [],
        note: "Neither engine reports: the same `/`-separator prefix test does not reach a dotted Python module path.",
      },
    ],
  },
  {
    id: "paths-inside-a-crate-and-across-one-in-rust",
    intent:
      "Rust's relative forms are `crate::`, `self::` and `super::`; between the bin and lib crates Cargo builds from one package there is no relative form at all, and the library's own name is the only spelling. None is the round trip out through a public alias that `noSelfCircularDependencies` names, and the crossing probe proves the engine is reading these files rather than failing to.",
    projects: [
      {
        name: "rust-local",
        root: "libs/rust-local",
        tags: ["axis:rust-local"],
        files: {
          "Cargo.toml":
            '[package]\nname = "rustlocal"\nversion = "0.1.0"\n\n[lib]\nname = "rustlocal_lib"\n',
          "src/lib.rs":
            "pub mod helper;\n\nuse crate::helper::Thing;\n\npub fn run() -> Thing {\n    Thing\n}\n",
          "src/helper.rs": "use self::inner::Thing;\n\npub mod inner {\n    pub struct Thing;\n}\n",
          "src/probe.rs": "use super::helper::Thing;\n\npub fn probe() -> Thing {\n    Thing\n}\n",
          // A Tauri-shaped package in miniature: a binary calling into the
          // library crate of its own package, renamed by `[lib] name` so that
          // name is the only spelling that compiles.
          "src/main.rs": "fn main() {\n    rustlocal_lib::run();\n}\n",
          "src/crosses.rs": "use rustother::Store;\n\npub fn open() -> Store {\n    Store\n}\n",
        },
      },
      {
        name: "rust-neighbour",
        root: "libs/rust-neighbour",
        tags: ["axis:rust-refused"],
        files: {
          "Cargo.toml": '[package]\nname = "rustother"\nversion = "0.1.0"\n',
          "src/lib.rs": "pub struct Store;\n",
        },
      },
    ],
    depConstraints: [
      { sourceTag: "axis:rust-local", onlyDependOnLibsWithTags: ["axis:rust-permitted"] },
    ],
    probes: [
      { file: "libs/rust-local/src/lib.rs", upstream: [] },
      { file: "libs/rust-local/src/helper.rs", upstream: [] },
      { file: "libs/rust-local/src/probe.rs", upstream: [] },
      { file: "libs/rust-local/src/main.rs", upstream: [] },
      {
        file: "libs/rust-local/src/crosses.rs",
        upstream: [],
        tool: ["onlyTagsConstraintViolation"],
        divergence: {
          direction: "stricter",
          reason:
            "ESLint has no parser for `.rs`, so the tag axis has no mechanism behind it there",
        },
      },
    ],
  },
  {
    id: "relative-imports-inside-a-package-and-across-one-in-python",
    intent:
      "Python's relative forms are the leading-dot imports, and only two of their spellings — a bare `.` and `..` — happen to look like JavaScript's. `.helper` and `..helper` are the ones a JavaScript-shaped predicate reads as package names.",
    projects: [
      {
        name: "python-local",
        root: "libs/python-local",
        tags: ["axis:python-local"],
        files: {
          "src/pylocal/__init__.py": "",
          "src/pylocal/helper.py": "class Thing:\n    pass\n",
          "src/pylocal/service.py": "from . import helper\nfrom .helper import Thing\n",
          "src/pylocal/deep/__init__.py": "",
          "src/pylocal/deep/thing.py": "from ..helper import Thing\n",
          "src/pylocal/crosses.py": "from pyneighbour.store import Store\n",
        },
      },
      {
        name: "python-neighbour",
        root: "libs/python-neighbour",
        tags: ["axis:python-refused"],
        files: {
          "src/pyneighbour/__init__.py": "",
          "src/pyneighbour/store.py": "class Store:\n    pass\n",
        },
      },
    ],
    depConstraints: [
      { sourceTag: "axis:python-local", onlyDependOnLibsWithTags: ["axis:python-permitted"] },
    ],
    probes: [
      { file: "libs/python-local/src/pylocal/service.py", upstream: [] },
      { file: "libs/python-local/src/pylocal/deep/thing.py", upstream: [] },
      {
        file: "libs/python-local/src/pylocal/crosses.py",
        upstream: [],
        tool: ["onlyTagsConstraintViolation"],
        divergence: {
          direction: "stricter",
          reason:
            "ESLint has no parser for `.py`, so the tag axis has no mechanism behind it there",
        },
      },
    ],
  },
  {
    id: "one-crate-crossing-however-the-use-is-spelled",
    intent:
      "One crossing into a neighbouring crate, written four ways Rust accepts, and the same four spellings pointing back inside the crate. ESLint parses none of it, so the only thing that can catch a spelling the parser drops is the other three spellings of the same import disagreeing with it.",
    projects: [
      {
        name: "spelled-crate",
        root: "libs/spelled-crate",
        tags: ["axis:spelled-crate"],
        files: {
          "Cargo.toml": '[package]\nname = "spelledlocal"\nversion = "0.1.0"\n',
          "src/lib.rs": "pub mod helper;\n",
          "src/helper.rs": "pub struct Thing;\n",
          "src/plain.rs": "use spelledother::Store;\n\npub fn plain() -> Store {\n    Store\n}\n",
          "src/braced.rs":
            "use spelledother::{Store};\n\npub fn braced() -> Store {\n    Store\n}\n",
          "src/crate-visible.rs": "pub(crate) use spelledother::Store;\n",
          "src/renamed.rs":
            "use spelledother::Store as Shop;\n\npub fn renamed() -> Shop {\n    Shop\n}\n",
          "src/inside-plain.rs":
            "use crate::helper::Thing;\n\npub fn inside() -> Thing {\n    Thing\n}\n",
          "src/inside-braced.rs":
            "use crate::helper::{Thing};\n\npub fn inside_braced() -> Thing {\n    Thing\n}\n",
          "src/inside-crate-visible.rs": "pub(crate) use crate::helper::Thing;\n",
          "src/inside-renamed.rs":
            "use crate::helper::Thing as Other;\n\npub fn inside_renamed() -> Other {\n    Other\n}\n",
        },
      },
      {
        name: "spelled-crate-neighbour",
        root: "libs/spelled-crate-neighbour",
        tags: ["axis:spelled-crate-refused"],
        files: {
          "Cargo.toml": '[package]\nname = "spelledother"\nversion = "0.1.0"\n',
          "src/lib.rs": "pub struct Store;\n",
        },
      },
    ],
    depConstraints: [
      { sourceTag: "axis:spelled-crate", onlyDependOnLibsWithTags: ["axis:spelled-crate-allowed"] },
    ],
    probes: [
      ...["plain", "braced", "crate-visible", "renamed"].map((form) => ({
        file: `libs/spelled-crate/src/${form}.rs`,
        spelling: "a use that leaves the crate",
        upstream: [],
        tool: ["onlyTagsConstraintViolation"],
        divergence: {
          direction: "stricter",
          reason:
            "ESLint has no parser for `.rs`, so the tag axis has no mechanism behind it there",
        },
      })),
      ...["plain", "braced", "crate-visible", "renamed"].map((form) => ({
        file: `libs/spelled-crate/src/inside-${form}.rs`,
        spelling: "a use that stays inside the crate",
        upstream: [],
      })),
    ],
  },
  {
    id: "one-module-crossing-however-the-import-is-spelled",
    intent:
      "One crossing into a neighbouring package, written the three ways Python spells it, and the two spellings of a relative import that stays inside its own package. `from pkg import sub` names `pkg` where `import pkg.sub` names `pkg.sub`; the specifiers differ and the verdict may not.",
    projects: [
      {
        name: "spelled-module",
        root: "libs/spelled-module",
        tags: ["axis:spelled-module"],
        files: {
          "src/spelledlocal/__init__.py": "",
          "src/spelledlocal/helper.py": "class Thing:\n    pass\n",
          "src/spelledlocal/plain.py": "import spelledother.store\n",
          "src/spelledlocal/from_package.py": "from spelledother import store\n",
          "src/spelledlocal/from_module.py": "from spelledother.store import Store\n",
          "src/spelledlocal/inside_named.py": "from .helper import Thing\n",
          "src/spelledlocal/inside_module.py": "from . import helper\n",
        },
      },
      {
        name: "spelled-module-neighbour",
        root: "libs/spelled-module-neighbour",
        tags: ["axis:spelled-module-refused"],
        files: {
          "src/spelledother/__init__.py": "",
          "src/spelledother/store.py": "class Store:\n    pass\n",
        },
      },
    ],
    depConstraints: [
      {
        sourceTag: "axis:spelled-module",
        onlyDependOnLibsWithTags: ["axis:spelled-module-allowed"],
      },
    ],
    probes: [
      ...["plain", "from_package", "from_module"].map((form) => ({
        file: `libs/spelled-module/src/spelledlocal/${form}.py`,
        spelling: "an import that leaves the package",
        upstream: [],
        tool: ["onlyTagsConstraintViolation"],
        divergence: {
          direction: "stricter",
          reason:
            "ESLint has no parser for `.py`, so the tag axis has no mechanism behind it there",
        },
      })),
      ...["inside_named", "inside_module"].map((form) => ({
        file: `libs/spelled-module/src/spelledlocal/${form}.py`,
        spelling: "a relative import that stays inside the package",
        upstream: [],
      })),
    ],
  },
  {
    id: "one-package-however-its-manifest-places-it",
    intent:
      "Three first-party Python packages holding the same thing, placed three ways a build backend accepts: under `src/`, under a `[tool.setuptools] package-dir`, and under a `[tool.hatch.build.targets.wheel] packages` path. All three import identically at runtime, so all three crossings into them must be judged identically — a layout the resolver cannot read must never make a project read as a PyPI distribution, which is a verdict rather than a blind spot and erases every tag constraint on the way past.",
    projects: [
      {
        name: "layout-reader",
        root: "libs/layout-reader",
        tags: ["axis:layout-reader"],
        files: {
          "pyproject.toml": '[project]\nname = "layoutreader"\n',
          "src/layoutreader/__init__.py": "",
          "src/layoutreader/reaches_plain.py": "from layoutplain.item import Item\n",
          "src/layoutreader/reaches_declared.py": "from layoutdeclared.item import Item\n",
          "src/layoutreader/reaches_hatched.py": "from layouthatched.item import Item\n",
          "src/layoutreader/reaches_pypi.py": "import os\n",
        },
      },
      {
        name: "layout-plain",
        root: "libs/layout-plain",
        tags: ["axis:layout-refused"],
        files: {
          "pyproject.toml": '[project]\nname = "layoutplain"\n',
          "src/layoutplain/__init__.py": "",
          "src/layoutplain/item.py": "class Item:\n    pass\n",
        },
      },
      {
        name: "layout-declared",
        root: "libs/layout-declared",
        tags: ["axis:layout-refused"],
        files: {
          "pyproject.toml":
            '[project]\nname = "layoutdeclared"\n\n[tool.setuptools]\npackage-dir = { "" = "lib" }\n',
          "lib/layoutdeclared/__init__.py": "",
          "lib/layoutdeclared/item.py": "class Item:\n    pass\n",
        },
      },
      {
        name: "layout-hatched",
        root: "libs/layout-hatched",
        tags: ["axis:layout-refused"],
        files: {
          "pyproject.toml":
            '[project]\nname = "layouthatched"\n\n[tool.hatch.build.targets.wheel]\npackages = ["python/layouthatched"]\n',
          "python/layouthatched/__init__.py": "",
          "python/layouthatched/item.py": "class Item:\n    pass\n",
        },
      },
    ],
    depConstraints: [
      { sourceTag: "axis:layout-reader", onlyDependOnLibsWithTags: ["axis:layout-allowed"] },
    ],
    probes: [
      ...["plain", "declared", "hatched"].map((placement) => ({
        file: `libs/layout-reader/src/layoutreader/reaches_${placement}.py`,
        spelling: "a crossing into a first-party package",
        upstream: [],
        tool: ["onlyTagsConstraintViolation"],
        divergence: {
          direction: "stricter",
          reason:
            "ESLint has no parser for `.py`, so the tag axis has no mechanism behind it there",
        },
      })),
      // The near-miss the fix must not swallow: with every project's packages
      // where the resolver can see them, a name that reaches none of them is
      // external, silently and without a failure. A resolver that answered
      // "unplaceable" here would be honest and useless.
      { file: "libs/layout-reader/src/layoutreader/reaches_pypi.py", upstream: [] },
    ],
  },
  {
    id: "one-module-crossing-however-the-go-import-is-spelled",
    intent:
      "One crossing into a neighbouring Go module, written seven ways gofmt leaves untouched, and three spellings of an import that stays inside the module. ESLint parses none of it, so a form the parser drops is caught only by its own siblings disagreeing with it — which is exactly how a `)` inside a comment, truncating an `import (…)` block, stayed invisible while reporting no failure either.",
    projects: [
      {
        name: "spelled-go",
        root: "libs/spelled-go",
        tags: ["axis:spelled-go"],
        files: {
          "go.mod": "module example.test/spelledlocal\n\ngo 1.24\n",
          "helper/helper.go": "package helper\n\ntype Thing struct{}\n",
          "single.go": 'package spelledlocal\n\nimport "example.test/spelledother/store"\n',
          "block.go": 'package spelledlocal\n\nimport (\n\t"example.test/spelledother/store"\n)\n',
          // The false negative this group exists for: gofmt leaves this block
          // exactly as written, and a parser reading to the first `)` stops
          // inside the comment.
          "comment-paren.go":
            'package spelledlocal\n\nimport (\n\t// TODO(alice): drop this once the port lands\n\t"example.test/spelledother/store"\n)\n',
          // The same trigger in the form Go's own conventions ask for: a blank
          // import is expected to carry an explanation, and explanations have
          // parentheses in them.
          "blank.go":
            'package spelledlocal\n\nimport (\n\t_ "example.test/spelledother/store" // register the driver (postgres)\n)\n',
          "trailing-comment.go":
            'package spelledlocal\n\nimport (\n\t"example.test/spelledother/store" // keep until the port lands (see the note above)\n)\n',
          "aliased.go": 'package spelledlocal\n\nimport shop "example.test/spelledother/store"\n',
          "dot.go": 'package spelledlocal\n\nimport . "example.test/spelledother/store"\n',
          // Inside its own module. Go has no relative import form, so these are
          // spelled identically to a crossing and are told apart only by where
          // the module path lands — the reason a Go import of a sibling package
          // must not be read as a barrel cycle.
          "inside-single.go": 'package spelledlocal\n\nimport "example.test/spelledlocal/helper"\n',
          "inside-block.go":
            'package spelledlocal\n\nimport (\n\t"example.test/spelledlocal/helper"\n)\n',
          "inside-comment-paren.go":
            'package spelledlocal\n\nimport (\n\t// TODO(bob): fold this into the parent (later)\n\t"example.test/spelledlocal/helper"\n)\n',
        },
      },
      {
        name: "spelled-go-neighbour",
        root: "libs/spelled-go-neighbour",
        tags: ["axis:spelled-go-refused"],
        files: {
          "go.mod": "module example.test/spelledother\n\ngo 1.24\n",
          "store/store.go": "package store\n",
        },
      },
    ],
    depConstraints: [
      { sourceTag: "axis:spelled-go", onlyDependOnLibsWithTags: ["axis:spelled-go-allowed"] },
    ],
    probes: [
      ...["single", "block", "comment-paren", "blank", "trailing-comment", "aliased", "dot"].map(
        (form) => ({
          file: `libs/spelled-go/${form}.go`,
          spelling: "an import that leaves the module",
          upstream: [],
          tool: ["onlyTagsConstraintViolation"],
          divergence: {
            direction: "stricter",
            reason:
              "ESLint has no parser for `.go`, so the tag axis has no mechanism behind it there",
          },
        }),
      ),
      ...["inside-single", "inside-block", "inside-comment-paren"].map((form) => ({
        file: `libs/spelled-go/${form}.go`,
        spelling: "an import that stays inside the module",
        upstream: [],
      })),
    ],
  },
  {
    id: "layer-constraint-violation-in-go",
    intent:
      "A Go project's tags are a declaration with no mechanism behind them under ESLint; here the same tag axis is enforced across a real Go import.",
    projects: [
      {
        name: "go-consumer",
        root: "libs/go-consumer",
        tags: ["axis:go-source"],
        files: {
          "go.mod": "module example.test/consumer\n\ngo 1.24\n",
          "main.go": 'package main\n\nimport "example.test/provider/store"\n\nfunc main() {}\n',
        },
      },
      {
        name: "go-provider",
        root: "libs/go-provider",
        tags: ["axis:go-refused"],
        files: {
          "go.mod": "module example.test/provider\n\ngo 1.24\n",
          "store/store.go": "package store\n",
        },
      },
    ],
    depConstraints: [
      { sourceTag: "axis:go-source", onlyDependOnLibsWithTags: ["axis:go-permitted"] },
    ],
    probes: [
      {
        file: "libs/go-consumer/main.go",
        upstream: [],
        tool: ["onlyTagsConstraintViolation"],
        divergence: {
          direction: "stricter",
          reason:
            "ESLint has no parser for `.go`, so the tag axis has no mechanism behind it there",
        },
      },
    ],
  },
];

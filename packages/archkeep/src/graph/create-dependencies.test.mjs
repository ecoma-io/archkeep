import { describe, expect, it } from "vitest";

import { resolveJavaDependencies } from "../analysis/java.mjs";
import { resolveKotlinDependencies } from "../analysis/kotlin.mjs";
import { analyzeWorkspace } from "../workspace.mjs";
import { resolvePolyglotDependencies } from "./create-dependencies.mjs";

/**
 * The #363 invariant, pinned by counting reads: the JVM package index builds
 * ONCE per run, because every consumer — the Java resolver, the Kotlin
 * resolver, the analyzers — reads it through `perWorkspace` memoization keyed
 * on ONE workspace-shaped object. A resolver that builds its own object per
 * call re-reads and re-masks the whole JVM tree once per call site, and the
 * failure is silent: verdicts stay byte-identical while the run pays three
 * reads of every `.java`/`.kt` file. The counts below are therefore the whole
 * assertion — red at 3 reads per file (two index builds plus the direct
 * import sweep), green at 1.
 *
 * Unit counterpart to `./create-dependencies.integration.test.mjs`, which
 * drives the real filesystem through the Nx entry: this one injects a
 * counting reader, which only the pure core (`resolvePolyglotDependencies`)
 * accepts.
 */
const JAVA_APP = "jvm/app/src/main/java/com/acme/app/App.java";
const JAVA_LIB = "jvm/lib/src/main/java/com/acme/lib/Lib.java";
const KOTLIN_UTIL = "jvm/lib/src/main/kotlin/com/acme/lib/Util.kt";

/** One mixed Java/Kotlin pair: `app` imports a package only `lib` declares. */
const TREE = {
  [JAVA_APP]: "package com.acme.app;\nimport com.acme.lib.Lib;\nclass App {}\n",
  [JAVA_LIB]: "package com.acme.lib;\nclass Lib {}\n",
  [KOTLIN_UTIL]: "package com.acme.lib\n\nclass Util\n",
};

const PROJECTS = [
  { name: "jvm-app", root: "jvm/app" },
  { name: "jvm-lib", root: "jvm/lib" },
];

const filesOf = (projectName) => {
  const project = PROJECTS.find((candidate) => candidate.name === projectName);
  return project === undefined
    ? []
    : Object.keys(TREE).filter((file) => file.startsWith(`${project.root}/`));
};

/**
 * A reader that counts, per path, how many times it was called — the only
 * instrument that can see a redundant index build, since the verdicts it
 * feeds stay byte-identical either way.
 */
const readCounting = (files) => {
  const counts = new Map();
  return {
    readFile: (path) => {
      counts.set(path, (counts.get(path) ?? 0) + 1);
      return files[path] ?? null;
    },
    count: (path) => counts.get(path) ?? 0,
  };
};

describe("resolvePolyglotDependencies builds each JVM read-once structure once", () => {
  it("reads every JVM source exactly once across the Java and Kotlin resolvers", () => {
    const { readFile, count } = readCounting(TREE);
    const deps = resolvePolyglotDependencies(PROJECTS, filesOf, readFile);

    // The edge is pinned too — the sharing must change nothing about what the
    // graph pass answers, only what it pays to answer it.
    expect(deps).toEqual([
      { source: "jvm-app", target: "jvm-lib", sourceFile: JAVA_APP, type: "static" },
    ]);

    // One read per file is the one index build; the Java resolver's own
    // import sweep and the whole Kotlin resolver take their bytes from the
    // memoized read behind the shared workspace object. Before #363's fix
    // each of these was 3 — two fresh-literal index builds plus the sweep.
    expect(count(JAVA_APP)).toBe(1);
    expect(count(JAVA_LIB)).toBe(1);
    expect(count(KOTLIN_UTIL)).toBe(1);
  });

  it("hands the analysis pass the same index — the analyzers build no second one", () => {
    const { readFile, count } = readCounting(TREE);
    const workspace = { projects: PROJECTS, filesOf, readFile };

    // The graph half, keyed on the one workspace object…
    resolveJavaDependencies(workspace);
    resolveKotlinDependencies(workspace);
    const afterGraph = {
      [JAVA_APP]: count(JAVA_APP),
      [JAVA_LIB]: count(JAVA_LIB),
      [KOTLIN_UTIL]: count(KOTLIN_UTIL),
    };

    // …and the analysis half a CLI run performs over the same object. A
    // second index build here would surface as one more read per file than
    // the text `analyzeWorkspace` hands each analyzer.
    const analysis = analyzeWorkspace(workspace, [JAVA_APP, JAVA_LIB, KOTLIN_UTIL]);
    expect(analysis.imports).toEqual([
      expect.objectContaining({ sourceFile: JAVA_APP, specifier: "com.acme.lib.Lib" }),
    ]);
    expect(analysis.failures).toEqual([]);
    expect(count(JAVA_APP)).toBe(afterGraph[JAVA_APP] + 1);
    expect(count(JAVA_LIB)).toBe(afterGraph[JAVA_LIB] + 1);
    expect(count(KOTLIN_UTIL)).toBe(afterGraph[KOTLIN_UTIL] + 1);
  });
});

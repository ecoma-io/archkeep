/**
 * Gradle manifest reader tests — the silent-direction case, loud failures,
 * and DSL interplay (Groovy vs Kotlin).
 */

import { describe, it } from "vitest";
import assert from "node:assert";

import {
  parseGradleSettings,
  parseGradleBuild,
  resolveGradleDependencies,
  gradleManifestFailures,
} from "./gradle.mjs";

describe("Gradle manifest reader", () => {
  describe("parseGradleSettings", () => {
    it("extracts root project name from Groovy DSL", () => {
      const text = `rootProject.name = "my-app"`;
      const result = parseGradleSettings(text);
      assert.strictEqual(result.rootProjectName, "my-app");
      assert.deepStrictEqual(result.includedProjects, []);
    });

    it("extracts root project name from Kotlin DSL", () => {
      const text = `rootProject.name = "my-app"`;
      const result = parseGradleSettings(text);
      assert.strictEqual(result.rootProjectName, "my-app");
    });

    it("extracts root project name from block syntax", () => {
      const text = `rootProject { name = "my-app" }`;
      const result = parseGradleSettings(text);
      assert.strictEqual(result.rootProjectName, "my-app");
    });

    it("extracts included projects from Groovy DSL include", () => {
      const text = `
include("core", "app")
rootProject.name = "my-app"
`;
      const result = parseGradleSettings(text);
      assert.strictEqual(result.rootProjectName, "my-app");
      assert.deepStrictEqual(result.includedProjects, ["core", "app"]);
    });

    it("extracts included projects from Kotlin DSL include", () => {
      const text = `
include("core", "app")
rootProject.name = "my-app"
`;
      const result = parseGradleSettings(text);
      assert.deepStrictEqual(result.includedProjects, ["core", "app"]);
    });

    it("handles include with colons in project names", () => {
      const text = `include(":core", ":app")`;
      const result = parseGradleSettings(text);
      assert.deepStrictEqual(result.includedProjects, ["core", "app"]);
    });

    it("handles multi-line include statements", () => {
      const text = `
include(
    "core",
    "app"
)
`;
      const result = parseGradleSettings(text);
      assert.deepStrictEqual(result.includedProjects, ["core", "app"]);
    });

    it("ignores line comments", () => {
      const text = `
// include("ignored")
include("core")
// rootProject.name = "ignored"
rootProject.name = "my-app"
`;
      const result = parseGradleSettings(text);
      assert.strictEqual(result.rootProjectName, "my-app");
      assert.deepStrictEqual(result.includedProjects, ["core"]);
    });

    it("ignores block comments", () => {
      const text = `
/* include("ignored") */
include("core")
/* rootProject.name = "ignored" */
rootProject.name = "my-app"
`;
      const result = parseGradleSettings(text);
      assert.strictEqual(result.rootProjectName, "my-app");
      assert.deepStrictEqual(result.includedProjects, ["core"]);
    });

    it("handles mixed comments and code", () => {
      const text = `
// Comment at top
include("core")
/* Block comment */
rootProject.name = "my-app" // inline comment
`;
      const result = parseGradleSettings(text);
      assert.strictEqual(result.rootProjectName, "my-app");
      assert.deepStrictEqual(result.includedProjects, ["core"]);
    });

    it("handles empty file", () => {
      const text = ``;
      const result = parseGradleSettings(text);
      assert.ok(result.reason !== undefined);
      assert.ok(result.reason.includes("no rootProject.name or include declarations found"));
    });

    it("handles file with only comments", () => {
      const text = `
// Just comments
/* More comments */
`;
      const result = parseGradleSettings(text);
      assert.ok(result.reason !== undefined);
    });
  });

  describe("parseGradleBuild", () => {
    it("extracts project dependencies from Groovy DSL", () => {
      const text = `dependencies {
    implementation project(":core")
    testImplementation project(":utils")
}`;
      const result = parseGradleBuild(text);
      assert.deepStrictEqual(result.projectDependencies, ["core", "utils"]);
    });

    it("extracts project dependencies from Kotlin DSL", () => {
      const text = `dependencies {
    implementation(project(":core"))
    testImplementation(project(":utils"))
}`;
      const result = parseGradleBuild(text);
      assert.deepStrictEqual(result.projectDependencies, ["core", "utils"]);
    });

    it("handles quoted project references in Groovy", () => {
      const text = `dependencies {
    implementation project(":core")
    implementation project(':utils')
}`;
      const result = parseGradleBuild(text);
      assert.deepStrictEqual(result.projectDependencies, ["core", "utils"]);
    });

    it("handles unquoted project references in Groovy DSL", () => {
      const text = `dependencies {
    implementation project(:core)
}`;
      const result = parseGradleBuild(text);
      assert.deepStrictEqual(result.projectDependencies, ["core"]);
    });

    it("handles various configuration names", () => {
      const text = `dependencies {
    implementation project(":core")
    api project(":api")
    compileOnly project(":compile")
    runtimeOnly project(":runtime")
    annotationProcessor project(":processor")
}`;
      const result = parseGradleBuild(text);
      assert.deepStrictEqual(result.projectDependencies, [
        "core",
        "api",
        "compile",
        "runtime",
        "processor",
      ]);
    });

    it("handles custom configuration names", () => {
      const text = `dependencies {
    customConfig project(":custom")
}`;
      const result = parseGradleBuild(text);
      assert.deepStrictEqual(result.projectDependencies, ["custom"]);
    });

    it("ignores line comments", () => {
      const text = `dependencies {
    // implementation project(":ignored")
    implementation project(":core")
}`;
      const result = parseGradleBuild(text);
      assert.deepStrictEqual(result.projectDependencies, ["core"]);
    });

    it("ignores block comments", () => {
      const text = `dependencies {
    /* implementation project(":ignored") */
    implementation project(":core")
}`;
      const result = parseGradleBuild(text);
      assert.deepStrictEqual(result.projectDependencies, ["core"]);
    });

    it("handles mixed external and project dependencies", () => {
      const text = `dependencies {
    implementation "org.example:lib:1.0"
    implementation project(":core")
    testImplementation "junit:junit:4.13"
}`;
      const result = parseGradleBuild(text);
      assert.deepStrictEqual(result.projectDependencies, ["core"]);
    });

    it("handles empty build file", () => {
      const text = ``;
      const result = parseGradleBuild(text);
      assert.deepStrictEqual(result.projectDependencies, []);
    });

    it("handles build file with no project dependencies", () => {
      const text = `dependencies {
    implementation "org.example:lib:1.0"
}`;
      const result = parseGradleBuild(text);
      assert.deepStrictEqual(result.projectDependencies, []);
    });

    it("handles version catalog references (ignored in v1)", () => {
      const text = `dependencies {
    implementation libs.core.lib
}`;
      const result = parseGradleBuild(text);
      assert.deepStrictEqual(result.projectDependencies, []);
    });
  });

  describe("the reactor model", () => {
    // The canonical layout: one settings file at a workspace root that is no
    // declared project's directory, subproject build files under libs/. The
    // first version of this reader found settings only inside declared
    // project roots and drew no edge at all here — green, and hollow.
    const reactorWorkspace = {
      projects: [
        { name: "app", root: "libs/app" },
        { name: "core", root: "libs/core" },
        { name: "utils", root: "libs/utils" },
      ],
      filesOf: (projectName) => {
        const map = {
          app: ["libs/app/build.gradle"],
          core: ["libs/core/build.gradle"],
          utils: ["libs/utils/build.gradle"],
        };
        return map[projectName] || [];
      },
      readFile: (path) => {
        const fixtures = {
          "settings.gradle":
            'rootProject.name = "demo"\ninclude("libs:app", "libs:core", "libs:utils")\n',
          "libs/app/build.gradle": 'dependencies { implementation project(":libs:core") }\n',
          "libs/core/build.gradle": 'dependencies { implementation project(":libs:utils") }\n',
          "libs/utils/build.gradle": "dependencies { }\n",
        };
        return fixtures[path] || null;
      },
    };

    it("reads every covered project's build file, not just the settings owner's", () => {
      const deps = resolveGradleDependencies(
        reactorWorkspace.projects,
        reactorWorkspace.filesOf,
        reactorWorkspace.readFile,
      );
      assert.strictEqual(deps.length, 2);
      const appToCore = deps.find((d) => d.source === "app" && d.target === "core");
      assert.ok(appToCore !== undefined);
      assert.strictEqual(appToCore.sourceFile, "libs/app/build.gradle");
      assert.strictEqual(appToCore.type, "static");
      assert.ok(deps.some((d) => d.source === "core" && d.target === "utils"));
    });

    it("reports no failures for a fully covered reactor", () => {
      assert.deepStrictEqual(gradleManifestFailures(reactorWorkspace), []);
    });

    it("still reads a settings file a declared project owns at its own root", () => {
      const rootOwned = {
        projects: [
          { name: "my-app", root: "" },
          { name: "core", root: "core" },
        ],
        filesOf: (projectName) => {
          const map = {
            "my-app": ["settings.gradle", "build.gradle", "core/build.gradle"],
            core: ["core/build.gradle"],
          };
          return map[projectName] || [];
        },
        readFile: (path) => {
          const fixtures = {
            "settings.gradle": 'rootProject.name = "my-app"\ninclude("core")\n',
            "build.gradle": 'dependencies { implementation project(":core") }\n',
            "core/build.gradle": "dependencies { }\n",
          };
          return fixtures[path] || null;
        },
      };
      const deps = resolveGradleDependencies(
        rootOwned.projects,
        rootOwned.filesOf,
        rootOwned.readFile,
      );
      assert.strictEqual(deps.length, 1);
      assert.strictEqual(deps[0].source, "my-app");
      assert.strictEqual(deps[0].target, "core");
    });

    it('reads the root project\'s own spelling, project(":"), as an edge', () => {
      // `":"` is how a subproject names the reactor root in real Gradle. The
      // empty path resolves through the root claim every settings file
      // registers; a reader that missed it dropped the edge silently.
      const rootReferencing = {
        projects: [
          { name: "my-app", root: "" },
          { name: "core", root: "core" },
        ],
        filesOf: (projectName) => {
          const map = {
            "my-app": ["settings.gradle", "core/build.gradle"],
            core: ["core/build.gradle"],
          };
          return map[projectName] || [];
        },
        readFile: (path) => {
          const fixtures = {
            "settings.gradle": 'rootProject.name = "my-app"\ninclude("core")\n',
            "core/build.gradle": 'dependencies { implementation(project(":")) }\n',
          };
          return fixtures[path] || null;
        },
      };
      const deps = resolveGradleDependencies(
        rootReferencing.projects,
        rootReferencing.filesOf,
        rootReferencing.readFile,
      );
      assert.strictEqual(deps.length, 1);
      assert.strictEqual(deps[0].source, "core");
      assert.strictEqual(deps[0].target, "my-app");
    });
  });

  describe("gradleManifestFailures", () => {
    const workspaceOf = (files, fixtures, projects) => ({
      projects,
      filesOf: () => files,
      readFile: (path) => fixtures[path] ?? null,
    });

    it("reports an include whose directory is not tracked", () => {
      const failures = gradleManifestFailures(
        workspaceOf(
          ["settings.gradle", "build.gradle"],
          {
            "settings.gradle": 'rootProject.name = "my-app"\ninclude("missing")\n',
            "build.gradle": "dependencies { }\n",
          },
          [{ name: "my-app", root: "" }],
        ),
      );
      assert.ok(
        failures.some((f) => f.reason.includes("'missing'") && f.reason.includes("not tracked")),
      );
    });

    it("reports a project reference no settings file defines", () => {
      const failures = gradleManifestFailures(
        workspaceOf(
          ["settings.gradle", "build.gradle"],
          {
            "settings.gradle": 'rootProject.name = "my-app"\n',
            "build.gradle": 'dependencies { implementation project(":nowhere") }\n',
          },
          [{ name: "my-app", root: "" }],
        ),
      );
      assert.ok(
        failures.some(
          (f) => f.reason.includes("':nowhere'") && f.reason.includes("no settings file defines"),
        ),
      );
    });

    it("reports a reference onto a directory no declared project owns", () => {
      const failures = gradleManifestFailures(
        workspaceOf(
          ["settings.gradle", "build.gradle", "tools/build.gradle"],
          {
            "settings.gradle": 'rootProject.name = "my-app"\ninclude("tools")\n',
            "build.gradle": 'dependencies { implementation project(":tools") }\n',
          },
          [{ name: "my-app", root: "" }],
        ),
      );
      assert.ok(
        failures.some(
          (f) => f.reason.includes("':tools'") && f.reason.includes("no declared project owns"),
        ),
      );
    });

    it("reports a build file no settings file covers", () => {
      const failures = gradleManifestFailures(
        workspaceOf(
          ["libs/orphan/build.gradle"],
          {
            "libs/orphan/build.gradle": 'dependencies { implementation project(":x") }\n',
          },
          [{ name: "orphan", root: "libs/orphan" }],
        ),
      );
      assert.ok(failures.some((f) => f.reason.includes("covered by no Gradle settings file")));
    });

    it("reports two settings files claiming the same directory", () => {
      const failures = gradleManifestFailures(
        workspaceOf(
          ["settings.gradle", "settings.gradle.kts"],
          {
            "settings.gradle": 'rootProject.name = "a"\n',
            "settings.gradle.kts": 'rootProject.name = "b"\n',
          },
          [],
        ),
      );
      assert.ok(failures.some((f) => f.reason.includes("already claimed by")));
    });

    it("accepts a settings-only root with no root build file", () => {
      const failures = gradleManifestFailures(
        workspaceOf(
          ["settings.gradle", "core/build.gradle"],
          {
            "settings.gradle": 'rootProject.name = "my-app"\ninclude("core")\n',
            "core/build.gradle": "dependencies { }\n",
          },
          [{ name: "core", root: "core" }],
        ),
      );
      assert.deepStrictEqual(failures, []);
    });
  });

  describe("silent direction tests", () => {
    it("both halves of a two-project cycle are drawn, not just one side", () => {
      // If the reactor model ever stops drawing edges — as its first version
      // did for every workspace whose settings file sat at a root no declared
      // project owned — this is the test that goes red.
      const workspaceWithCycle = {
        projects: [
          { name: "app", root: "app" },
          { name: "core", root: "core" },
        ],
        filesOf: (projectName) => {
          const map = {
            app: ["app/build.gradle"],
            core: ["core/build.gradle"],
          };
          return map[projectName] || [];
        },
        readFile: (path) => {
          const fixtures = {
            "settings.gradle": `rootProject.name = "demo"\ninclude("app", "core")`,
            "app/build.gradle": `dependencies { implementation project(":core") }`,
            "core/build.gradle": `dependencies { implementation project(":app") }`,
          };
          return fixtures[path] || null;
        },
      };

      const deps = resolveGradleDependencies(
        workspaceWithCycle.projects,
        workspaceWithCycle.filesOf,
        workspaceWithCycle.readFile,
      );

      assert.strictEqual(deps.length, 2);
      assert.ok(deps.some((d) => d.source === "app" && d.target === "core"));
      assert.ok(deps.some((d) => d.source === "core" && d.target === "app"));
    });

    it("handles Kotlin DSL build scripts correctly", () => {
      const kotlinDslWorkspace = {
        projects: [
          { name: "my-app", root: "" },
          { name: "core", root: "core" },
        ],
        filesOf: (projectName) => {
          const map = {
            "my-app": ["settings.gradle.kts", "build.gradle.kts", "core/build.gradle.kts"],
            core: ["core/build.gradle.kts"],
          };
          return map[projectName] || [];
        },
        readFile: (path) => {
          const fixtures = {
            "settings.gradle.kts": `rootProject.name = "my-app"\ninclude("core")`,
            "build.gradle.kts": `dependencies { implementation(project(":core")) }`,
            "core/build.gradle.kts": `dependencies { }`,
          };
          return fixtures[path] || null;
        },
      };

      const deps = resolveGradleDependencies(
        kotlinDslWorkspace.projects,
        kotlinDslWorkspace.filesOf,
        kotlinDslWorkspace.readFile,
      );

      assert.strictEqual(deps.length, 1);
      assert.strictEqual(deps[0].source, "my-app");
      assert.strictEqual(deps[0].target, "core");
    });

    it("handles mixed Groovy and Kotlin DSL files", () => {
      const mixedDslWorkspace = {
        projects: [
          { name: "my-app", root: "" },
          { name: "core", root: "core" },
        ],
        filesOf: (projectName) => {
          const map = {
            "my-app": ["settings.gradle.kts", "build.gradle", "core/build.gradle"],
            core: ["core/build.gradle"],
          };
          return map[projectName] || [];
        },
        readFile: (path) => {
          const fixtures = {
            "settings.gradle.kts": `rootProject.name = "my-app"\ninclude("core")`,
            "build.gradle": `dependencies { implementation project(":core") }`,
            "core/build.gradle": `dependencies { }`,
          };
          return fixtures[path] || null;
        },
      };

      const deps = resolveGradleDependencies(
        mixedDslWorkspace.projects,
        mixedDslWorkspace.filesOf,
        mixedDslWorkspace.readFile,
      );

      assert.strictEqual(deps.length, 1);
      assert.strictEqual(deps[0].source, "my-app");
      assert.strictEqual(deps[0].target, "core");
    });
  });
});

/**
 * Gradle language fixture for E2E tests.
 *
 * A three-project Gradle workspace (domain, application, api) with Kotlin
 * sources, testing that Archkeep discovers Gradle manifests, builds the
 * correct graph, and enforces architecture boundaries through the real
 * installed CLI.
 *
 * @param {string} packageName
 * @param {Record<string, string>} peers
 * @param {string} packageManager
 * @returns {Record<string, string>}
 */
import { LAYERED_BOUNDARY_CONFIG } from "./boundary-law.mjs";

export function gradleLanguageFiles(packageName, peers, packageManager) {
  return {
    "package.json": JSON.stringify(
      {
        name: "gradle-e2e-consumer",
        version: "1.0.0",
        private: true,
        devDependencies: {
          [packageName]: "*",
          typescript: peers.typescript,
        },
        packageManager,
      },
      null,
      2,
    ),

    // Without this, `git add -A` commits node_modules and the engine's
    // `git ls-files` walk answers for whatever the installer laid down —
    // pnpm-version-dependent bytes the fixture never meant to ship.
    ".gitignore": "node_modules/\nbuild/\n.gradle/\n",

    "archkeep.json": `${JSON.stringify(
      {
        boundaryConfig: "module-boundaries.config.mjs",
        projects: {
          declared: [
            { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
            { root: "libs/application", name: "application", tags: ["layer:application"] },
            { root: "libs/api", name: "api", tags: ["layer:api"] },
          ],
        },
        coverage: {
          exempt: [
            {
              path: "module-boundaries.config.mjs",
              reason: "workspace tooling config at the root, not itself a project",
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "module-boundaries.config.mjs": LAYERED_BOUNDARY_CONFIG,

    // Gradle settings file at the root — no declared project owns the root,
    // which is the point: a reactor is its settings file's directory mapping.
    "settings.gradle":
      'rootProject.name = "gradle-layers"\ninclude("libs:domain", "libs:application", "libs:api")\n',

    // Domain project - Gradle build and Kotlin source. One package per
    // project, mirroring the other JVM fixtures: a package declared by two
    // projects is a split package, and the JVM index answers that with a
    // blind spot, not a guess.
    "libs/domain/build.gradle": "dependencies { }\n",

    "libs/domain/src/main/kotlin/com/example/domain/Domain.kt":
      "package com.example.domain\n\nclass Domain {}\n",

    // Application project - Gradle build with dependency
    "libs/application/build.gradle": 'dependencies { implementation project(":libs:domain") }\n',

    "libs/application/src/main/kotlin/com/example/application/Application.kt":
      "package com.example.application\n\nimport com.example.domain.Domain\n\nclass Application { val domain: Domain = Domain() }\n",

    // API project - Gradle build with dependency
    "libs/api/build.gradle": 'dependencies { implementation project(":libs:application") }\n',

    "libs/api/src/main/kotlin/com/example/api/Api.kt":
      "package com.example.api\n\nimport com.example.application.Application\n\nclass Api { val app: Application = Application() }\n",
  };
}

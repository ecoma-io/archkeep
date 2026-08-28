// JVM mixed-language fixture: three Maven projects whose canonical packages
// deliberately split across extensions — every edge below resolves through a
// package only the OTHER extension declares. One package index spans `.java`
// and `.kt` (`src/analysis/jvm/packages.mjs`); these files are the end-to-end
// witness of that decision, through the real installed CLI.

import { LAYERED_BOUNDARY_CONFIG } from "./boundary-law.mjs";

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function jvmMixedLanguageFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-lang-jvm-mixed",
        private: true,
        type: "module",
        packageManager,
        devDependencies: {
          [packageName]: "*",
          typescript: peers.typescript,
          "fast-xml-parser": "5.11.0",
        },
      },
      null,
      2,
    )}\n`,
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
    ".gitignore": "node_modules/\ntarget/\n",

    "libs/domain/pom.xml":
      "<project><groupId>com.example</groupId><artifactId>domain</artifactId>" +
      "<version>1.0.0</version></project>",
    "libs/domain/src/main/java/com/example/domain/Name.java":
      "package com.example.domain;\n\nclass Name {}\n",
    // The Kotlin-only package: no `.java` file anywhere declares it.
    "libs/domain/src/main/kotlin/com/example/kdomain/Helper.kt":
      "package com.example.kdomain\n\nclass Helper\n",

    "libs/application/pom.xml":
      "<project><groupId>com.example</groupId><artifactId>application</artifactId>" +
      "<version>1.0.0</version><dependencies><dependency>" +
      "<groupId>com.example</groupId><artifactId>domain</artifactId>" +
      "</dependency></dependencies></project>",
    // Resolves through a `.kt`-declared index entry — the Java→Kotlin
    // direction. Per-extension indexes would classify this import external.
    "libs/application/src/main/java/com/example/application/App.java":
      "package com.example.application;\n\nimport com.example.kdomain.Helper;\n\nclass App { Helper helper; }\n",

    "libs/api/pom.xml":
      "<project><groupId>com.example</groupId><artifactId>api</artifactId>" +
      "<version>1.0.0</version><dependencies><dependency>" +
      "<groupId>com.example</groupId><artifactId>application</artifactId>" +
      "</dependency></dependencies></project>",
    // Resolves through a `.java`-declared package — the Kotlin→Java direction.
    "libs/api/src/main/kotlin/com/example/api/Api.kt":
      "package com.example.api\n\nimport com.example.application.App\n\nclass Api { val app = App() }\n",
  };
}

/**
 * A second claimant for the Kotlin-only package: `App.java`'s import now has
 * two owners, resolution refuses to pick, and the graph must LOSE the
 * application→domain edge rather than draw one against a guess — with the
 * blind spot naming every claimant in its place.
 *
 * @type {Record<string, string>}
 */
export const SPLIT_PACKAGE_MUTATION = {
  "libs/application/src/main/kotlin/com/example/kdomain/Shadow.kt":
    "package com.example.kdomain\n\nclass Shadow\n",
};

/**
 * A Kotlin file in domain reaching UP into application's Java-only package:
 * domain→application violates the layered law's first row, resolved through
 * the same cross-extension resolution the clean tree proves. Also unwitnesses
 * the clean application→domain pair on BOTH tracks — `App.java` loses its
 * kdomain import and application's pom loses its declared `domain`
 * dependency — because either track surviving would close a project cycle,
 * and `noCircularDependencies` fires before the law table is ever read
 * (`./violations.mjs` documents the same convention for every per-language
 * violation). api→application still resolves cross-extension, so the
 * violation tree keeps a witness of the shared index.
 *
 * @type {Record<string, string>}
 */
export const MIXED_VIOLATION = {
  "libs/domain/src/main/kotlin/com/example/domain/Reach.kt":
    "package com.example.domain\n\nimport com.example.application.App\n\nclass Reach { val app = App() }\n",
  "libs/application/src/main/java/com/example/application/App.java":
    "package com.example.application;\n\nclass App {}\n",
  // The declared twin: application's pom loses its downward `domain`
  // dependency alongside the import, so no track of the downward pair
  // survives to close a project cycle and preempt the tag rule.
  "libs/application/pom.xml":
    "<project><groupId>com.example</groupId><artifactId>application</artifactId>" +
    "<version>1.0.0</version></project>",
};

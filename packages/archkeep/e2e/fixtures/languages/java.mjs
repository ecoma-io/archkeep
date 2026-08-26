// Java language fixture: three Maven projects with Java imports.
// Proves Java import discovery, package index resolution, and
// `pom.xml` manifest dependency edges.
//
// Architecture:
//   domain (layer:domain)     — no imports from other packages
//   application (layer:application) — imports from domain
//   api (layer:api)          — imports from application
//
// Uses standard Maven project structure with `pom.xml` manifests.
// No Java compilation required — Archkeep statically parses `.java` files
// and `pom.xml` manifests.

import { LAYERED_BOUNDARY_CONFIG } from "./boundary-law.mjs";

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function javaLanguageFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-lang-java",
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

    // Domain — leaf package, no dependencies.
    "libs/domain/pom.xml":
      "<project><groupId>com.example</groupId><artifactId>domain</artifactId>" +
      "<version>1.0.0</version></project>",
    "libs/domain/src/main/java/com/example/domain/Name.java":
      "package com.example.domain;\n\nclass Name {}\n",

    // Application — depends on domain via Maven dependency.
    "libs/application/pom.xml":
      "<project><groupId>com.example</groupId><artifactId>application</artifactId>" +
      "<version>1.0.0</version><dependencies><dependency>" +
      "<groupId>com.example</groupId><artifactId>domain</artifactId>" +
      "</dependency></dependencies></project>",
    "libs/application/src/main/java/com/example/application/App.java":
      "package com.example.application;\n\nimport com.example.domain.Name;\n\nclass App { Name name; }\n",

    // Api — depends on application via Maven dependency.
    "libs/api/pom.xml":
      "<project><groupId>com.example</groupId><artifactId>api</artifactId>" +
      "<version>1.0.0</version><dependencies><dependency>" +
      "<groupId>com.example</groupId><artifactId>application</artifactId>" +
      "</dependency></dependencies></project>",
    "libs/api/src/main/java/com/example/api/Api.java":
      "package com.example.api;\n\nimport com.example.application.App;\n\nclass Api { App app; }\n",
  };
}

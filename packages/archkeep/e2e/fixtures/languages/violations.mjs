// Per-language violation file maps: `domain` reaches up into `application`.
//
// Each entry is a set of files that, when committed into the corresponding
// clean language consumer, makes `domain` import from `application` —
// violating `onlyTagsConstraintViolation` because `layer:domain` may only
// depend on `layer:domain`.
//
// To avoid a circular dependency (application → domain + domain → application),
// each violation also replaces the application project's source file to remove
// its import from domain. Without this, `noCircularDependencies` would fire
// first and `onlyTagsConstraintViolation` would never be reported — the
// circular-dependency check short-circuits the tag constraint check.

/**
 * Go violation: `domain` imports `application`.
 * Replaces `libs/domain/go.mod` and adds `libs/domain/violate.go`.
 * Also replaces `libs/application/application.go` to remove the
 * domain import and prevent a circular dependency.
 */
export const GO_VIOLATION = {
  "libs/domain/go.mod":
    "module example.test/domain\n\ngo 1.22\n\nrequire example.test/application v0.0.0\n\n" +
    "replace example.test/application => ../application\n",
  "libs/domain/violate.go":
    'package domain\n\nimport "example.test/application"\n\nvar _ = application.Name\n',
  "libs/application/application.go": 'package application\n\nconst Name = "application"\n',
};

/**
 * TypeScript violation: `domain` imports `@example/application`.
 * Also replaces `libs/application/src/index.ts` to remove the
 * domain import and prevent a circular dependency.
 */
export const TYPESCRIPT_VIOLATION = {
  "libs/domain/violate.ts":
    'import { name } from "@example/application";\n\nexport const upward = name;\n',
  "libs/application/src/index.ts": 'export const app: string = "application";\n',
};

/**
 * JavaScript violation: `domain` imports `@example/application` (ESM).
 * Also replaces `libs/application/src/index.mjs` to remove the
 * domain import and prevent a circular dependency.
 */
export const JAVASCRIPT_VIOLATION = {
  "libs/domain/violate.mjs":
    'import { app } from "@example/application";\n\nexport const upward = app;\n',
  "libs/application/src/index.mjs": 'export const app = "application";\n',
};

/**
 * Vue violation: `domain` imports `@example/application` from a `.vue` SFC.
 * Also replaces `libs/application/src/App.vue` to remove the domain import
 * and prevent a circular dependency.
 */
export const VUE_VIOLATION = {
  "libs/domain/Violate.vue":
    '<script setup lang="ts">\nimport { label } from "@example/application";\nconst upward = label;\n</script>\n',
  "libs/application/src/App.vue":
    '<script setup lang="ts">\nconst appLabel = "application";\n</script>\n<template>\n  <div>{{ appLabel }}</div>\n</template>\n',
};

/**
 * Rust violation: `domain` crate uses `application`.
 * Also replaces `libs/application/src/lib.rs` to remove the
 * `use domain::NAME;` and prevent a circular dependency.
 */
export const RUST_VIOLATION = {
  "libs/domain/src/violate.rs": "use application::APP;\n\npub const UPWARD: &str = APP;\n",
  "libs/application/src/lib.rs": 'pub const APP: &str = "application";\n',
};

/**
 * Python violation: `domain` imports from `application`.
 * Also replaces `libs/application/src/application/__init__.py` to
 * remove the `from domain import NAME` and prevent a circular dependency.
 */
export const PYTHON_VIOLATION = {
  "libs/domain/src/domain/violate.py": "from application import APP\n\nUPWARD = APP\n",
  "libs/application/src/application/__init__.py": 'APP = "application"\n',
};

/**
 * Java violation: `domain` imports `application`.
 * Replaces `libs/domain/pom.xml` and adds `libs/domain/src/main/java/com/example/domain/Violate.java`.
 * Also replaces `libs/application/src/main/java/com/example/application/App.java` to remove the
 * domain import and prevent a circular dependency.
 */
export const JAVA_VIOLATION = {
  "libs/domain/pom.xml":
    "<project><groupId>com.example</groupId><artifactId>domain</artifactId>" +
    "<version>1.0.0</version><dependencies><dependency>" +
    "<groupId>com.example</groupId><artifactId>application</artifactId>" +
    "</dependency></dependencies></project>",
  "libs/domain/src/main/java/com/example/domain/Violate.java":
    "package com.example.domain;\n\nimport com.example.application.App;\n\nclass Violate { App app; }\n",
  // application's pom loses its downward `domain` dependency — the declared
  // twin of the removed import. Either witness surviving keeps the pair's
  // edge alive and closes a project cycle, and `noCircularDependencies`
  // fires before the tag table is ever read.
  "libs/application/src/main/java/com/example/application/App.java":
    "package com.example.application;\n\nclass App {}\n",
  "libs/application/pom.xml":
    "<project><groupId>com.example</groupId><artifactId>application</artifactId>" +
    "<version>1.0.0</version></project>",
};

/**
 * Kotlin violation: `domain` imports `application`.
 * Replaces `libs/domain/pom.xml` and adds `libs/domain/src/main/kotlin/com/example/domain/Violate.kt`.
 * Also unwitnesses the clean application→domain pair on BOTH tracks: `App.kt`
 * loses the domain import AND application's pom loses its declared `domain`
 * dependency — either track surviving keeps the pair's edge alive and closes
 * a project cycle, and `noCircularDependencies` fires before the tag table
 * is ever read.
 */
export const KOTLIN_VIOLATION = {
  "libs/domain/pom.xml":
    "<project><groupId>com.example</groupId><artifactId>domain</artifactId>" +
    "<version>1.0.0</version><dependencies><dependency>" +
    "<groupId>com.example</groupId><artifactId>application</artifactId>" +
    "</dependency></dependencies></project>",
  "libs/domain/src/main/kotlin/com/example/domain/Violate.kt":
    "package com.example.domain\n\nimport com.example.application.App\n\nclass Violate(val app: App)\n",
  "libs/application/src/main/kotlin/com/example/application/App.kt":
    "package com.example.application\n\nclass App\n",
  "libs/application/pom.xml":
    "<project><groupId>com.example</groupId><artifactId>application</artifactId>" +
    "<version>1.0.0</version></project>",
};

/**
 * Gradle violation: `domain` project depends on `:application`.
 * Replaces `libs/domain/build.gradle` to add the forbidden upward dependency,
 * and adds a Domain.kt importing upward alongside it. Also unwitnesses the
 * clean application→domain pair on BOTH tracks — `Application.kt` loses the
 * domain import and `libs/application/build.gradle` loses its
 * `project(":libs:domain")` — so neither track can close a project cycle
 * and preempt the tag rule.
 */
export const GRADLE_VIOLATION = {
  "libs/domain/build.gradle": 'dependencies { implementation project(":libs:application") }\n',
  "libs/domain/src/main/kotlin/com/example/domain/Violate.kt":
    "package com.example.domain\n\nimport com.example.application.Application\n\nclass Violate { val app: Application = Application() }\n",
  "libs/application/src/main/kotlin/com/example/application/Application.kt":
    "package com.example.application\n\nclass Application\n",
  "libs/application/build.gradle": "dependencies { }\n",
};

/**
 * .NET violation: `domain` uses `application` through a written `using`.
 * Adds `libs/domain/Reach.cs` — the source track, which carries the
 * position the report blames. Also unwitnesses the clean application→domain
 * edge on BOTH of its tracks — `App.cs` loses its `using Example.Domain`,
 * `Application.csproj` loses its `<ProjectReference>` — because either one
 * surviving would keep the pair's edge alive and close a project cycle,
 * and `noCircularDependencies` fires before the tag table is ever read
 * (this file's header documents the same convention for every language).
 */
export const DOTNET_VIOLATION = {
  "libs/domain/Reach.cs":
    "using Example.Application;\n\nnamespace Example.Domain;\n\nclass Reach { Application app; }\n",
  "libs/application/Application.csproj":
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n',
  "libs/application/App.cs": "namespace Example.Application;\n\nclass App {}\n",
};

/**
 * .NET violation witnessed by the MANIFEST track alone: `Domain.csproj`
 * gains an upward `<ProjectReference>` to `application`, closing the cycle
 * domain→application→domain with no `using` written anywhere — every other
 * file stays byte-identical to the clean fixture. The import track sees two
 * unrelated trees; only the declared application→domain edge (clean
 * fixture's own downward ProjectReference, witnessed by `App.cs` too) plus
 * this declared-only upward one closes the loop, so `noCircularDependencies`
 * is the finding and no tag rule has a position to blame. Before the
 * declared edges reached every face's graph, this tree reported EMPTY on
 * them — the silent direction this case exists to catch: exit 0,
 * byte-for-byte the clean answer, on a workspace whose check must refuse.
 */
export const DOTNET_DECLARED_CYCLE = {
  "libs/domain/Domain.csproj":
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include="..\\application\\Application.csproj" /></ItemGroup></Project>\n',
};

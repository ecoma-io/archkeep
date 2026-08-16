// Drift consumer workspace: the native monorepo (`app → api → core`, three Go
// projects with `lattice.json`, no `nx`) plus an `architecture-intent.config.mjs`
// at the root declaring the intended architecture.
//
// The intent is written as a plain-ESM module that default-exports the intent
// object, the exact contract `src/drift/intent.mjs` `loadIntent` recovers. The
// `.mjs` root file is an analyzable extension that is not itself a project, so
// it is added to `coverage.exempt` the same way `module-boundaries.config.mjs`
// is (`native-consumer.mjs` states that reasoning).

import { nativeMonorepoFiles } from "./native-monorepo.mjs";

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @param {object} intent The intended-architecture object to default-export.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function driftConsumerFiles(packageName, peers, packageManager, intent) {
  const files = nativeMonorepoFiles(packageName, peers, packageManager);

  const latticeJson = JSON.parse(files["lattice.json"]);
  latticeJson.coverage.exempt.push({
    path: "architecture-intent.config.mjs",
    reason: "workspace tooling config at the root, not itself a project",
  });
  files["lattice.json"] = `${JSON.stringify(latticeJson, null, 2)}\n`;

  files["architecture-intent.config.mjs"] = `export default ${JSON.stringify(intent, null, 2)}\n`;
  return files;
}

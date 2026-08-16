// Drift consumer workspace: the native monorepo (`app → api → core`, three Go
// projects with `lattice.json`, no `nx`) plus a canonical
// `architecture-intent.json` at the root declaring the intended architecture.
//
// The intent is written in the one canonical contract an installed Lattice
// reads — strict JSON, the `version`-leading schema `src/architecture-intent/
// model.mjs` validates — not an `.mjs` module. A root `.json` is not itself a
// project and needs no `coverage.exempt` entry (that list exists only for root
// `.mjs` analyzable files; `native-consumer.mjs` states the reasoning).

import { nativeMonorepoFiles } from "./native-monorepo.mjs";

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @param {object} intent The intended-architecture object to serialize.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function driftConsumerFiles(packageName, peers, packageManager, intent) {
  const files = nativeMonorepoFiles(packageName, peers, packageManager);
  files["architecture-intent.json"] = `${JSON.stringify(intent, null, "  ")}\n`;
  return files;
}

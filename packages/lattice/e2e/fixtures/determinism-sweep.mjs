// Determinism-sweep workspace: the native monorepo (`app → api → core`, three
// Go projects, `lattice.json`, no `nx`) declared in `native-monorepo.mjs`,
// plus the two files the sweep's command surface reads that the monorepo
// fixture alone does not carry: a canonical `architecture-intent.json` (for
// `drift`/`check`'s drift fold/`reconcile`) and a recorded architecture
// decision under `docs/adr/` (for `adr`).
//
// The intent is the one canonical contract an installed Lattice reads — strict
// JSON, the `version`-leading schema `src/architecture-intent/model.mjs`
// validates — matching the tree exactly so the sweep's clean runs are clean.
// The violating variant forbids the one dependency the observed graph really
// has (`app → api`), and can additionally carry a `boundarySuppressions`
// waiver so `waivers` has a wall-clock field to disclose.
//
// The Nx profile variant is the same two-Go-project Nx consumer the Nx
// fixture builds, with the plugin options naming a `profiles` registry and
// `boundaryConfig` as a profile NAME — the one provider shape where a policy
// is selected by name rather than by file (`docs/concepts/profiles.md`,
// "Selecting by name").

import { nativeMonorepoFiles } from "./native-monorepo.mjs";
import { MONOREPO_BOUNDARY_CONFIG } from "./boundary-law.mjs";
import { nxConsumerFiles } from "./nx-consumer.mjs";

/** The declared architecture the monorepo fixture's graph satisfies. */
const CLEAN_INTENT = {
  version: "1",
  boundaries: [
    { name: "core", match: ["name:core"] },
    { name: "api", match: ["name:api"] },
    { name: "app", match: ["name:app"] },
  ],
  allowed: [
    { from: "app", to: "api" },
    { from: "api", to: "core" },
  ],
  forbidden: [{ from: "core", to: "app", reason: "core must never reach the top" }],
};

/** An intent forbidding the one dependency the observed graph really has. */
const VIOLATING_INTENT = {
  version: "1",
  boundaries: [
    { name: "core", match: ["name:core"] },
    { name: "api", match: ["name:api"] },
    { name: "app", match: ["name:app"] },
  ],
  dependencies: {
    forbidden: [{ source: "app", target: "api" }],
  },
};

/** A recorded decision for the `adr` command to read; matches the audit fixture. */
const SWEEP_ADR = `---
id: 0001-layers
status: accepted
bindings:
  - intentForbiddenEdge
---
# Layers

Decisions have layers.
`;

/**
 * The sweep's violating law: `MONOREPO_BOUNDARY_CONFIG` plus a live waiver, so
 * every sweep target that reads the policy sees the same law except for the
 * `remainingMs` wall-clock field `waivers` discloses. Built by extending the
 * shared law rather than restating it, so the two cannot drift apart.
 */
const WITH_WAIVER = MONOREPO_BOUNDARY_CONFIG.replace(
  "export const boundarySuppressions = [];",
  "export const boundarySuppressions = [\n" +
    '  { path: "libs/app/**", reason: "app-to-core is being fixed", expiresAt: "2027-01-01T00:00:00.000Z" },\n' +
    "];",
);

/**
 * The sweep consumer: the native monorepo plus intent and ADR for the command
 * surface that reads them.
 *
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @param {object} intent The intended-architecture object to serialize.
 * @param {{withWaiver?: boolean}} [options] Carry a `boundarySuppressions`
 *   waiver on the law, so `waivers` lists a live waiver.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function determinismSweepFiles(packageName, peers, packageManager, intent, options = {}) {
  const files = nativeMonorepoFiles(packageName, peers, packageManager);
  files["architecture-intent.json"] = `${JSON.stringify(intent, null, 2)}\n`;
  files["docs/adr/0001-layers.md"] = SWEEP_ADR;
  if (options.withWaiver) files["module-boundaries.config.mjs"] = WITH_WAIVER;
  return files;
}

/**
 * The Nx profile consumer: the two-Go-project Nx workspace with the plugin
 * options naming a `profiles` registry, `boundaryConfig` selecting the
 * `strict` profile by name. The profile block restates the two-tag law the
 * `.mjs` law file carries, as data — a profile is a policy block, not a
 * reference to a file (`src/governance/profile-registry.mjs`).
 *
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function determinismSweepProfilesFiles(packageName, peers, packageManager) {
  const files = nxConsumerFiles(packageName, peers, packageManager);
  files["nx.json"] = `${JSON.stringify(
    {
      plugins: [
        {
          plugin: `${packageName}/nx`,
          options: { boundaryConfig: "strict", profiles: "law-profiles.json" },
        },
      ],
    },
    null,
    2,
  )}\n`;
  files["law-profiles.json"] = `${JSON.stringify(
    {
      version: 1,
      profiles: [
        {
          name: "strict",
          block: {
            depConstraints: [
              { sourceTag: "layer:core", onlyDependOnLibsWithTags: ["layer:core"] },
              { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:app", "layer:core"] },
            ],
            moduleBoundaryOptions: {
              allow: [],
              buildTargets: ["build"],
              enforceBuildableLibDependency: false,
              allowCircularSelfDependency: false,
              checkDynamicDependenciesExceptions: [],
              ignoredCircularDependencies: [],
              banTransitiveDependencies: false,
              checkNestedExternalImports: false,
            },
            boundarySuppressions: [],
          },
        },
      ],
    },
    null,
    2,
  )}\n`;
  return files;
}

export const sweepIntents = { CLEAN_INTENT, VIOLATING_INTENT };

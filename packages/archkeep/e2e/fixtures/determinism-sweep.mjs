// Determinism-sweep workspace: the native monorepo (`app → api → core`, three
// Go projects, `archkeep.json`, no `nx`) declared in `native-monorepo.mjs`,
// plus the two files the sweep's command surface reads that the monorepo
// fixture alone does not carry: a canonical `architecture-intent.json` (for
// `drift`/`check`'s drift fold/`reconcile`) and a recorded architecture
// decision under the ADR directory (for `adr`).
//
// The intent is the one canonical contract an installed Archkeep reads — strict
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
// The ADR directory name, read from the module that owns it rather than
// respelled: a written-out `docs/adr/…` here would read to
// `scripts/check-docs-links.mjs` as a citation to THIS repository's docs, on
// a record path that resolves nowhere. The same reason the registry's own
// tests build fixtures from `ADR_DIR` rather than spelling the path
// (`src/governance/adr-registry.test.mjs`, "tracked-only registry").
import { ADR_DIR } from "../../src/governance/adr-registry.mjs";

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
 *
 * The waiver expires a year from the moment the fixture is built, never at a
 * fixed calendar date: a fixed expiry would turn the waiver into an `expired`
 * entry once that instant passed, and the sweep would keep passing while
 * silently no longer exercising the live-waiver disclosure it exists to pin.
 */
const WITH_WAIVER = MONOREPO_BOUNDARY_CONFIG.replace(
  "export const boundarySuppressions = [];",
  "export const boundarySuppressions = [\n" +
    '  { path: "libs/app/**", reason: "app-to-core is being fixed", ' +
    `expiresAt: "${new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()}" },\n` +
    "];",
);

/**
 * A fitness export the monorepo's graph SATISFIES: the three linear projects
 * hold no cycle, so `fitness` reaches a real `pass` verdict (exit 0) — the
 * judged lane, not the no-policy refusal lane the sweep pinned before.
 */
const PASSING_FITNESS = `export const fitness = [
  {
    name: "cycle-free",
    match: ["*"],
    condition: { type: "cycle-free" },
    reason: "a cycle makes every layer statement unfalsifiable",
  },
];
`;

/**
 * A fitness export the monorepo's graph VIOLATES: the direct `app → api` edge
 * carries both tags, so a forbidden `layer-dependency` between them fails —
 * the loud direction, `fitness` exiting 1 on a real judged finding.
 */
const FAILING_FITNESS = `export const fitness = [
  {
    name: "app-must-not-reach-api",
    match: ["*"],
    condition: {
      type: "layer-dependency",
      from: "layer:app",
      to: "layer:api",
      direction: "forbidden",
    },
    reason: "the app layer is being decomposed away from the api layer",
  },
];
`;

/**
 * The sweep consumer: the native monorepo plus intent and ADR for the command
 * surface that reads them.
 *
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @param {object} intent The intended-architecture object to serialize.
 * @param {{withWaiver?: boolean, withFitness?: "passing"|"failing"}} [options]
 *   Carry a `boundarySuppressions` waiver on the law, so `waivers` lists a live
 *   waiver, or a real judged `fitness` export on the law — `"passing"` the
 *   graph satisfies, `"failing"` the direct app→api edge violates.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function determinismSweepFiles(packageName, peers, packageManager, intent, options = {}) {
  const files = nativeMonorepoFiles(packageName, peers, packageManager);
  files["architecture-intent.json"] = `${JSON.stringify(intent, null, 2)}\n`;
  files[`${ADR_DIR}/0001-layers.md`] = SWEEP_ADR;
  if (options.withWaiver) files["module-boundaries.config.mjs"] = WITH_WAIVER;
  if (options.withFitness === "passing") {
    files["module-boundaries.config.mjs"] = `${MONOREPO_BOUNDARY_CONFIG}\n${PASSING_FITNESS}`;
  }
  if (options.withFitness === "failing") {
    files["module-boundaries.config.mjs"] = `${MONOREPO_BOUNDARY_CONFIG}\n${FAILING_FITNESS}`;
  }
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

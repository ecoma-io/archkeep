/**
 * The boundary-policy ladder every command that reads a boundary law shares.
 *
 * A preamble rather than a command — the same kind of exception `./context.mjs`
 * is, and for the same reason: the `run*` functions in `../../cli.mjs` and
 * `./check.mjs` all need the identical resolution order, and a hand-copied
 * ladder is what let two defects land in it independently. `resolvePolicy`
 * below argues the order, each arm, and what `profile`/`source` name.
 */

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { containmentViolation } from "../containment.mjs";
import { loadBoundaryConfig, loadBoundaryConfigFile, policyFrom } from "../config.mjs";
import { profilePolicy } from "../governance/profile-registry.mjs";
import { ARCHKEEP_MODEL_FILE } from "../providers/native/model.mjs";

/**
 * Whether the workspace's resolved options name a `profiles` registry — the
 * check command's signal to enforce by profile NAME rather than by file. A
 * workspace that never registered the plugin carries the default `profiles:
 * undefined`, which is the same "no registry, no named law" state as a
 * workspace that declared nothing.
 *
 * @param {object} options The resolved options from `resolveCommandContext`.
 * @returns {boolean}
 */
function hasProfiles(options) {
  return typeof options?.profiles === "string" && options.profiles !== "";
}

/**
 * The boundary-policy "ladder" every command that reads a boundary law
 * shares, in the one place all of them now call it from. Hand-copied 11
 * times before this — `check`, `graph`, `diff`, `waivers`, `fitness`,
 * `impact`, `explain`, `context`, `history`'s `--capture` branch, `debt`,
 * `health` — the duplication is what let two defects land in it independently:
 * P1-25 found `graph`'s copy alone missing the inline-object arm, and P1-26
 * found only `check`'s copy aware of a `profiles` registry at all — the other
 * ten tried to resolve a profile NAME as a file, and named the wrong problem
 * when it could not: `loadBoundaryConfigFile` refuses a bare name like
 * `"strict"` as "names an unsupported boundaryConfig extension '(none)'",
 * which blames a typo that was never made rather than naming the real gap —
 * that command never knew profiles existed. One function, called from all
 * eleven sites, is what makes that defect class structurally impossible to
 * reintroduce one copy at a time.
 *
 * Checked in order, and the first match wins:
 *
 * 1. A `profiles` registry, when the workspace names one
 *    (`commandContext.options.profiles`) — `--config`, or absent that
 *    `boundaryConfig`, is then a profile NAME resolved from that registry,
 *    never a filename or an inline object at the same time
 *    (`docs/concepts/profiles.md`, "Selecting by name": the two never mix at
 *    one field).
 * 2. `--config`, a FILE path, resolved against `cwd` rather than the
 *    workspace root — the tool and the law it enforces may be in different
 *    trees, and the tree being judged is still the consumer's.
 * 3. The workspace's own `boundaryConfig`: a filename
 *    (`loadBoundaryConfig`), or — native workspaces only — the policy
 *    inline, as an object rather than a filename (`policyFrom`).
 * 4. `null`, when the workspace declares no law at all. No current provider
 *    ever reaches this arm — `boundaryConfig` always resolves to a non-empty
 *    string or a truthy inline object (`../options.mjs`'s
 *    `DEFAULT_OPTIONS`, `../providers/native/model.mjs`'s
 *    `normalizeNativeModel`) — but the guard stays rather than calling
 *    `policyFrom(undefined, ...)` unconditionally, so a future provider that
 *    leaves the option unset degrades to "no policy" instead of a crash on a
 *    value that was never validated.
 *
 * `profile`/`source` name WHICH of the four arms fired and where its bytes
 * came from — `profile` is the resolved profile name (`null` on every arm but
 * the first), `source` is always workspace-relative, the convention every
 * other file reference in a report already keeps (`sourceFile`, `tsConfig`,
 * intent's `file`). Only `check` reads either field today (P1-01, naming the
 * law that governed a run in its own report), but they are returned
 * unconditionally rather than as a second, `check`-only code path, so the
 * eleven callers keep sharing the one ladder this function exists to be.
 *
 * @param {{config: string|null}} options The command's own parsed flags —
 *   only `config` is read here, so a command with no `--config` flag at all
 *   (`graph` takes none) simply never sets it and this arm is skipped.
 * @param {object} commandContext From `resolveCommandContext` — `root` and
 *   `options` (the workspace's resolved `boundaryConfig`/`profiles`) are read.
 * @param {string} cwd The process's working directory a relative `--config`
 *   resolves against — kept separate from the workspace root for the reason
 *   above.
 * @returns {Promise<{config: {depConstraints: object[], options: object, suppressions: object[], fitness?: object[], customRules?: object[], coverage?: object, markdown?: {include: string[], markers: {pattern: string, edge: string}[]}, notes?: string[]}|null, profile: string|null, source: string|null}>}
 *   `fitness`, `customRules` and `markdown` are present only when the resolved
 *   policy declares them — an absent key is the workspace's decision not to
 *   declare that law, never an empty one (`../config.mjs`'s `policyFrom`).
 * @throws {Error} when a named profile, a `--config` file, or an inline
 *   policy cannot be resolved or is malformed — every arm's existing failure
 *   mode, unchanged by the extraction.
 */
export async function resolvePolicy(options, commandContext, cwd) {
  const resolved = await resolvePolicyArm(options, commandContext, cwd);
  // The policy's `coverage` key (unowned-file acceptances,
  // `../config.mjs`'s `findCoverageViolations`) is an Nx/Moon channel: a
  // native tree already records the identical decision on `archkeep.json`'s
  // own `coverage.exempt` (`../providers/native/coverage.mjs`), and two
  // channels for one decision on one tree is how copies drift. The inline
  // spelling is refused at model load
  // (`../providers/native/model.mjs`'s `findNativeModelViolations`); this is
  // the file-dialect spelling of the same refusal, held here because the
  // ladder below is the first point that knows both the provider and the
  // loaded policy — and held for every command that reads a policy, so the
  // editor-adjacent commands cannot accept a law `check` refuses.
  if (resolved.config?.coverage !== undefined && commandContext.provider === "native") {
    throw new Error(
      `archkeep: ${resolved.source ?? "the boundary config"} declares 'coverage', but this ` +
        `workspace's project model is ${ARCHKEEP_MODEL_FILE} — a native tree records ` +
        `unowned-file acceptances on ${ARCHKEEP_MODEL_FILE}'s own coverage.exempt, and a second ` +
        `channel for the same decision is a copy that will drift. Move the rows there and ` +
        `delete the policy key.`,
    );
  }
  return resolved;
}

/**
 * The policy load for a command that DESCRIBES the workspace rather than
 * judging it — `graph`'s own arm, held here beside the ladder it wraps so
 * every future descriptive surface (`./graph.mjs`'s MCP caller among them)
 * answers from one copy of the "absent default law" decision rather than
 * re-deriving it.
 *
 * What is skipped is the load of a file that is NOT THERE. A boundary config
 * that exists and will not load still fails the run, because an absent law
 * and a broken one must not report alike; a `--config`, a profile, and an
 * inline `archkeep.json` policy are explicit declarations and stay loud.
 * Every command that JUDGES against the law keeps loading it unconditionally
 * through `resolvePolicy` — making it optional for those would turn a missing
 * file into a silent no-law run.
 *
 * `boundaryConfigDeclared` is what keeps this guard to the un-overridden
 * default, and it is load-bearing rather than belt-and-braces. The name
 * alone cannot answer it: `commandContext.options.boundaryConfig` is a
 * string BOTH when it came from `../options.mjs`'s `DEFAULT_OPTIONS` and
 * when the consumer WROTE it into `nx.json`'s plugin options or
 * `archkeep.json`, and a workspace is free to declare the convention
 * filename itself, so comparing against the default would still read a
 * deliberate declaration as an assumption. Measured on a committed native
 * tree whose `archkeep.json` declares a `boundaryConfig` that file does not
 * contain: skipping on name alone made `graph` exit 0 with no `policy` field
 * — byte-identical to a workspace that never had a law — where the same tree
 * with that file present but unparseable exited 3. A law someone named and
 * then renamed or deleted is exactly the case that must stay loud, so the
 * provenance survives the options layer instead
 * (`../options.mjs`'s `resolveOptions`,
 * `../providers/native/model.mjs`'s `normalizeNativeModel`, and
 * `./context.mjs`'s three branches carry it; Moon answers `false` because it
 * has no table to declare one in).
 *
 * @param {{config: string|null}} options The command's own parsed flags.
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {string} cwd The process's working directory a relative `--config`
 *   resolves against.
 * @returns {Promise<{config: object|null, profile: string|null, source: string|null}>}
 *   `null` config only on the absent-un-overridden-default arm.
 * @throws {Error} through `resolvePolicy` for every law that is named but
 *   cannot be loaded.
 */
export async function resolveDescribedPolicy(options, commandContext, cwd) {
  const workspaceDefault =
    !options.config &&
    !hasProfiles(commandContext.options) &&
    commandContext.options.boundaryConfigDeclared === false &&
    typeof commandContext.options.boundaryConfig === "string"
      ? resolve(commandContext.root, commandContext.options.boundaryConfig)
      : null;
  return workspaceDefault !== null && !existsSync(workspaceDefault)
    ? { config: null, profile: null, source: null }
    : resolvePolicy(options, commandContext, cwd);
}

/**
 * The four arms of the ladder, unguarded — `resolvePolicy` above wraps this
 * with the one post-resolution refusal that needs both the provider and the
 * loaded policy in hand.
 *
 * @param {{config: string|null}} options
 * @param {object} commandContext
 * @param {string} cwd
 * @returns {Promise<{config: object|null, profile: string|null, source: string|null}>}
 */
async function resolvePolicyArm(options, commandContext, cwd) {
  const { root } = commandContext;
  if (hasProfiles(commandContext.options)) {
    const profileName = String(options.config ?? commandContext.options.boundaryConfig);
    const registryPath = resolve(root, commandContext.options.profiles);
    // `profiles` is a tree-derived filename (`nx.json`/`archkeep.json` options),
    // so a tracked symlink in an intermediate component of it would hand
    // outside profile rows in as the workspace's — the same read escape
    // `loadBoundaryConfig` now refuses at `loadBoundaryConfig`; held here for
    // the profiles arm (`../containment.mjs`, the read-side G-10 closure).
    const violation = containmentViolation(root, registryPath);
    if (violation !== null) {
      throw new Error(`archkeep: cannot load ${registryPath}: ${violation}`);
    }
    const config = profilePolicy(
      registryPath,
      profileName,
      options.config ?? commandContext.options.boundaryConfig,
    );
    return { config, profile: profileName, source: relative(root, registryPath) };
  }
  if (options.config) {
    const configPath = isAbsolute(options.config) ? options.config : resolve(cwd, options.config);
    const config = await loadBoundaryConfigFile(configPath);
    return { config, profile: null, source: relative(root, configPath) };
  }
  if (typeof commandContext.options.boundaryConfig === "string") {
    const config = await loadBoundaryConfig(root, commandContext.options.boundaryConfig);
    return {
      config,
      profile: null,
      source: relative(root, resolve(root, commandContext.options.boundaryConfig)),
    };
  }
  if (commandContext.options.boundaryConfig) {
    const config = policyFrom(
      commandContext.options.boundaryConfig,
      `${ARCHKEEP_MODEL_FILE}'s inline boundaryConfig`,
    );
    return { config, profile: null, source: ARCHKEEP_MODEL_FILE };
  }
  return { config: null, profile: null, source: null };
}

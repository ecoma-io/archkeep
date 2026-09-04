/**
 * The one gate deciding whether a workspace root may be judged at all: which
 * project model it declares, and a loud refusal when it declares more than
 * one.
 *
 * Lives in the providers layer because the decision it makes is a
 * provider-selection decision — `../commands/context.mjs` composes a provider
 * behind it, and `../lsp/workspace-index.mjs` branches on the same facts
 * before choosing one — and neither face may hold a second copy of the rule.
 * A second copy was exactly how the faces drifted apart once: the CLI refused
 * a tree carrying a Moon directory beside `nx.json`/`archkeep.json` while the
 * editor indexed it anyway — a clean diagnostic list over a tree nobody agreed
 * could be judged (#223's silent shape, one level up).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { NX_CONFIG_FILE } from "../options.mjs";
import { ARCHKEEP_MODEL_FILE } from "./native/model.mjs";
import { moonMarkerAt } from "./moon.mjs";

/**
 * The one gate deciding whether `root` may be judged at all: more than ONE
 * project-model marker present is refused, naming what conflicts.
 *
 * Every entry point that picks a provider must answer this identically —
 * `../commands/context.mjs`'s `resolveCommandContext` reads it before any
 * command runs, and `../lsp/workspace-index.mjs`'s index build reads it before
 * choosing a branch. Moon-versus-Moon coexistence (`.moon/` AND
 * `.config/moon/`) is refused inside `./moon.mjs`'s `moonMarkerAt`, which this
 * gate calls first; the cross-family pairs are refused here, all in the same
 * terms: which model to judge against is a decision nobody made, not one this
 * tool can make for them.
 *
 * @param {string} root
 * @param {{exists?: (path: string) => boolean}} [io] Injectable existence
 *   test (absolute paths), so a test drives this without a filesystem.
 * @returns {{hasNx: boolean, hasNative: boolean, moonMarker: string|null}}
 *   The facts a provider choice needs; `moonMarker` names whichever Moon
 *   directory is present, `null` when neither spelling is.
 * @throws {Error} when more than one marker is present.
 */
export function requireSingleProjectModel(root, { exists = existsSync } = {}) {
  const moonMarker = moonMarkerAt(root, { exists });
  const hasNx = exists(join(root, NX_CONFIG_FILE));
  const hasNative = exists(join(root, ARCHKEEP_MODEL_FILE));
  const refusal = (a, b) =>
    new Error(
      `archkeep: ${root} declares both ${a} and ${b} — this tool judges a workspace ` +
        `against exactly one project model, and a tree carrying both is a decision nobody made ` +
        `rather than one this tool can make for them. Remove whichever one is not the ` +
        `workspace's real source of truth for projects and tags.`,
    );
  if (moonMarker !== null && hasNx) throw refusal(moonMarker, NX_CONFIG_FILE);
  if (moonMarker !== null && hasNative) throw refusal(moonMarker, ARCHKEEP_MODEL_FILE);
  if (hasNx && hasNative) throw refusal(NX_CONFIG_FILE, ARCHKEEP_MODEL_FILE);
  return { hasNx, hasNative, moonMarker };
}

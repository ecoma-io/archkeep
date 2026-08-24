/**
 * What to do about one workspace folder, decided before anything is started.
 *
 * Everything that could go wrong with a folder — it is not a workspace, the
 * server is not installed, the configured path is wrong — is decided here, as
 * data, so that `extension.mjs` has nothing left to judge and the whole decision
 * is reachable from a test without a running editor.
 *
 * There are exactly three outcomes and no fourth, because the fourth is always
 * the same bug: starting a client that cannot work and letting an empty Problems
 * panel speak for it.
 */

/**
 * `root` and `searched` are optional on a blocked plan because not every
 * blockage comes from planning: `extension.mjs` builds one for a server that
 * died after starting, where there is no search trail to report. The
 * `?: undefined` members exist so a reader may ask the union for a property
 * only some states carry without narrowing first.
 *
 * @typedef {{ state: "start", root: string, serverPath: string, reason?: undefined }} StartPlan
 * @typedef {{ state: "idle", reason: string, searched?: undefined }} IdlePlan
 * @typedef {{ state: "blocked", root?: string, reason: string, searched?: string[] }} BlockedPlan
 * @typedef {StartPlan | IdlePlan | BlockedPlan} SessionPlan
 */

/**
 * Decide what a workspace folder gets.
 *
 * @param {object} input
 * @param {string} input.folderPath absolute path of the open workspace folder
 * @param {string} [input.configuredServerPath] the `archkeep.server.path` setting
 * @param {(startDirectory: string) => string | null} input.findRoot
 * @param {(input: { nxRoot: string, configuredPath: string }) => import("./server-module.mjs").ServerLocation} input.locateServer
 * @returns {SessionPlan}
 */
export function planSession({ folderPath, configuredServerPath = "", findRoot, locateServer }) {
  const root = findRoot(folderPath);

  if (root === null) {
    // Not a failure and not reported as one. A window with no workspace marker
    // in it is a window this extension has nothing true to say about, and saying
    // it quietly is the correct volume — the loud state below is for a workspace
    // that *is* ours and is going unchecked.
    return {
      state: "idle",
      reason: `No workspace marker (archkeep.json or nx.json) in ${folderPath} or any directory above it, so this folder is not part of a workspace Archkeep can check.`,
    };
  }

  const located = locateServer({ nxRoot: root, configuredPath: configuredServerPath });

  if (located.path === null) {
    return {
      state: "blocked",
      root,
      reason: located.reason ?? `No boundary server could be located under ${root}.`,
      searched: located.searched,
    };
  }

  return { state: "start", root, serverPath: located.path };
}

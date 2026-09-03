#!/usr/bin/env node
// Mints the tag that IS the Go SDK's release.
//
// Every other package this repository ships carries a version in a manifest,
// and release-please writes it. A Go module carries none: its version is a git
// tag, and Go's rule for a module below the repository root is that the tag is
// prefixed with the module's own directory — `packages/archkeep-rule-sdk-go/
// v0.11.0`, not the bare `v0.11.0` the release already cuts. Nothing minted it.
//
// That gap was invisible in the way this repository cares about most. Both
// `packages/archkeep-rule-sdk-go/go.mod` and
// `docs/adr/0002-custom-rules-one-contract.md` state that the release lane
// mints the prefixed tag "beside the bare `v<version>` it already tags"; the
// lane never did. Nothing was red, no gate had an opinion, and the only
// observable was a `go get` that resolved no released version at all — it falls
// back to a pseudo-version off the default branch, which looks like it worked.
// A document that is authoritative and wrong is worse than an absent one.
//
// What this script refuses to guess, and why each refusal is the loud half of a
// silent failure:
//
//   - **The module path must sit under this repository.** `go get` builds its
//     fetch URL from the module path, so a path naming a different repository
//     produces a tag here that nobody can ever resolve — and no error anywhere.
//   - **The directory the path implies must be the directory the go.mod is in.**
//     These agree today and nothing held them together. A `go.mod` moved without
//     its module path edited would tag a directory that has no module in it, and
//     the proxy would answer 404 for a version this lane reported as published.
//   - **An existing tag must point at the release commit.** Re-running a release
//     job is ordinary; silently leaving a tag that names EARLIER bytes under the
//     new version's name is not. Same commit is success, different commit is a
//     hard failure.
//
// One thing the script tolerates rather than refuses: a read-back that
// answers Not Found moments after its own POST. GitHub refs propagate, and
// release 0.21.0's lane went red exactly there — the tag existed at the
// released SHA (`git ls-remote` showed it) while the first read-back was
// answered 404. The read-back below therefore retries across a short backoff
// before it concludes anything, and only then fails, naming the tag and the
// POST that reported success. The tolerance bounds the same silence the
// refusals bound: a POST that never becomes a readable ref still exits 1.
//
// The proxy is deliberately not polled afterwards. proxy.golang.org is a cache
// that fetches from GitHub on first request, not a gatekeeper that grants
// publication: once the tag exists and points at the right commit, the version
// is resolvable, and a lane that went red because a cache had not warmed yet
// would be red for something no change here could fix.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { requestGit } from "./push-reformatted-files.mjs";

export const GO_SDK_DIR = "packages/archkeep-rule-sdk-go";

/**
 * How many times the freshly created ref is read back before the script
 * concludes the write never landed. Five reads across the backoff below
 * cover roughly fifteen seconds of propagation — the 0.21.0 race resolved
 * within seconds — while a genuinely failed write stays a loud exit 1.
 *
 * @type {number}
 */
export const READ_BACK_ATTEMPTS = 5;

/**
 * The default wait between read-back attempts, doubling per attempt.
 *
 * @param {number} attempt zero-based attempt just completed
 * @returns {number} milliseconds to wait before the next read
 */
export function readBackDelay(attempt) {
  return 1000 * 2 ** attempt;
}

/**
 * Read the freshly created ref back, retrying across GitHub's propagation
 * window. A Not Found (or an empty answer) immediately after the POST is not
 * obeyed as "the write failed" — it is retried; after the final attempt the
 * caller receives `null` and refuses loudly. The injected `readRef`/`sleep`
 * keep this testable with no network and no clock.
 *
 * @param {() => {object?: {sha: string}} | null | undefined} readRef one read
 *   attempt; a throw or a falsy result means "not visible yet"
 * @param {{attempts?: number, delayMs?: number, sleep?: (ms: number) => Promise<void>}} [options]
 * @returns {Promise<{object?: {sha: string}} | null>} the ref once it reads
 *   back, or `null` when every attempt failed
 */
export async function readCreatedRef(readRef, options = {}) {
  const attempts = options.attempts ?? READ_BACK_ATTEMPTS;
  const delayMs = options.delayMs ?? 1000;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(delayMs * 2 ** (attempt - 1));
    try {
      const ref = await readRef();
      if (ref) return ref;
    } catch {
      // Retried, then refused by the caller — never rounded into a verdict.
    }
  }
  return null;
}

/**
 * The `module` directive's path from a go.mod.
 *
 * Throws rather than returning null when there is none: a go.mod with no module
 * path is not a module, and computing a tag from a fallback would name a
 * version that resolves to nothing.
 *
 * @param {string} text full contents of go.mod
 * @returns {string} the module path
 */
export function goModulePath(text) {
  for (const line of text.split("\n")) {
    const match = /^module\s+(\S+)/.exec(line.trim());
    if (match) return match[1];
  }
  throw new Error(
    "go.mod carries no `module` directive, so it declares no module path — there is no " +
      "name to build a version tag for.",
  );
}

/**
 * The tag prefix Go requires for a module path inside `owner/repo`: the module's
 * directory relative to the repository root, or "" when the module IS the root.
 *
 * @param {string} modulePath the go.mod `module` directive's value
 * @param {string} repoSlug `owner/repo`
 * @returns {string} the directory prefix a version tag must carry
 */
export function goModuleTagPrefix(modulePath, repoSlug) {
  const rootPath = `github.com/${repoSlug}`;
  if (modulePath === rootPath) return "";
  if (!modulePath.startsWith(`${rootPath}/`)) {
    throw new Error(
      `the module path "${modulePath}" is not under "${rootPath}", so a tag cut in this ` +
        `repository could never serve it — \`go get\` resolves a module from its path, not ` +
        `from where the tag happens to live.`,
    );
  }
  return modulePath.slice(rootPath.length + 1);
}

/**
 * The tag name a version takes for a module at `prefix`.
 *
 * @param {string} prefix the directory prefix (`""` for a root module)
 * @param {string} version the version, with or without a leading `v`
 * @returns {string} the tag name
 */
export function goModuleTag(prefix, version) {
  const v = version.startsWith("v") ? version : `v${version}`;
  return prefix === "" ? v : `${prefix}/${v}`;
}

/**
 * Reads go.mod, computes the tag, and creates it. The only function here that
 * touches the outside world.
 */
export async function main() {
  const args = process.argv.slice(2);
  const argOf = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };

  const root = argOf("--root") ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // The lane passes the release TAG (`v0.11.0`), and a human running this by
  // hand is as likely to pass `0.11.0`. Normalised once, here, so every message
  // below spells the version one way rather than echoing whichever form the
  // caller happened to use — `@vv0.11.0` in a log line is a bug report waiting
  // to be filed against the tag itself.
  const rawVersion = argOf("--version");
  const version = rawVersion?.startsWith("v") ? rawVersion.slice(1) : rawVersion;
  const sha = argOf("--sha");
  const repoSlug = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;

  for (const [label, value] of [
    ["--version", rawVersion],
    ["--sha", sha],
    ["GITHUB_REPOSITORY", repoSlug],
    ["GH_TOKEN", token],
  ]) {
    if (!value) {
      console.error(`${label} is required.`);
      process.exit(2);
    }
  }

  const goModPath = join(root, GO_SDK_DIR, "go.mod");
  const modulePath = goModulePath(readFileSync(goModPath, "utf8"));
  const prefix = goModuleTagPrefix(modulePath, /** @type {string} */ (repoSlug));

  if (prefix === "") {
    console.error(
      `the module path "${modulePath}" is the repository root, so the bare v${version} tag ` +
        `already serves it and a prefixed tag would be wrong. This script exists for a ` +
        `module BELOW the root; if the module moved, this is the line that needs revisiting.`,
    );
    process.exit(1);
  }

  // The prefix is where Go will look for the module. Nothing else checks that
  // it is where the module actually is.
  if (!existsSync(join(root, prefix, "go.mod"))) {
    console.error(
      `the module path "${modulePath}" implies the directory "${prefix}", which holds no ` +
        `go.mod. The tag would name a directory with no module in it, and every \`go get\` ` +
        `of this version would 404 while this lane reported it published.`,
    );
    process.exit(1);
  }

  const tag = goModuleTag(prefix, /** @type {string} */ (version));
  const [owner, repo] = /** @type {string} */ (repoSlug).split("/");

  let existing = null;
  try {
    existing = requestGit(
      owner,
      repo,
      "GET",
      `/git/ref/tags/${tag}`,
      /** @type {string} */ (token),
    );
  } catch {
    // Absent is the ordinary case on a first run, and this catch deliberately
    // does not try to tell "absent" apart from "the read failed": both lead to
    // the same next step, and neither can end this run quietly. A tag that
    // exists at another commit makes the POST below fail 422, and a POST that
    // reports success without creating the ref is caught by the read-back
    // after it. The swallowed error is the only one here with a second net
    // under it.
  }

  if (existing) {
    if (existing.object?.sha === sha) {
      console.log(`${tag} already points at ${sha}; nothing to do`);
      return;
    }
    console.error(
      `${tag} already exists and points at ${existing.object?.sha}, not the released ` +
        `commit ${sha}. Refusing to move it: a consumer who resolved this version would ` +
        `silently get different bytes than one who resolves it after the move.`,
    );
    process.exit(1);
  }

  requestGit(owner, repo, "POST", "/git/refs", /** @type {string} */ (token), {
    ref: `refs/tags/${tag}`,
    sha,
  });

  // Read it back rather than trusting the write — and retry across the
  // propagation window, because a ref is visible to the next reader later
  // than the POST's own 2xx admits (the 0.21.0 failure is the header story).
  // A 2xx that created nothing, or a ref that never becomes readable, is the
  // shape of failure this whole file exists to refuse.
  const created = await readCreatedRef(() =>
    requestGit(owner, repo, "GET", `/git/ref/tags/${tag}`, /** @type {string} */ (token)),
  );
  if (created === null) {
    console.error(
      `created ${tag} but it did not read back after ${READ_BACK_ATTEMPTS} attempts. ` +
        `The POST above reported success; trusting it without a read is the failure ` +
        `this file refuses.`,
    );
    process.exit(1);
  }
  if (created.object?.sha !== sha) {
    console.error(
      `created ${tag} but it reads back pointing at ${created.object?.sha} rather than ${sha}.`,
    );
    process.exit(1);
  }
  console.log(`${tag} now points at ${sha} — \`go get ${modulePath}@v${version}\` resolves it`);
}

/**
 * Whether this file was RUN rather than imported, compared on real paths.
 * See `check-packages.mjs` for the reason this exists and why it is not shared.
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) void main();

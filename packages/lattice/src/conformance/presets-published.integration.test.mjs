/**
 * Whether the shipped policy packs are actually in the tarball, asked of the
 * packer rather than of the manifest.
 *
 * A preset is only a preset if a consumer can reach it. Everything else that
 * tests them — `../governance/presets.integration.test.mjs` — reads them from
 * the source tree, where they are there whether or not `package.json` was ever
 * told to publish them. That is the blind spot this file exists for, and it is
 * the same one `../../../../scripts/verify-package.mjs` was written against:
 * every other gate runs where the file it needs is already present.
 *
 * Two questions, both answered by a real run:
 *
 * - **`npm pack` selects them.** The `files` list is a glob set, so a pack
 *   whose name or extension falls outside it is dropped silently — the publish
 *   succeeds, the tarball is smaller, and the first consumer to point their
 *   `profiles` option at it gets "cannot read profiles file" from a version
 *   that cannot be unpublished. `npm pack --dry-run` is what the release lane
 *   itself re-packs with, so this asks the tool that will do the packing.
 * - **The `exports` subpath resolves.** A JSON file inside a package with an
 *   `exports` map is unreachable by specifier unless the map names it, so the
 *   documented `@ecoma-io/lattice/presets/<pack>.json` spelling is checked
 *   against Node's own resolver rather than against the manifest's text. The
 *   resolution happens in a spawned Node rather than in this process, and that
 *   is not incidental: `./boundary.test.mjs`'s walk requires every load in this
 *   package to name a literal specifier it can read, and a per-pack specifier
 *   built from a directory listing is exactly the opaque call it refuses. A
 *   subprocess asks the same resolver the same question without writing a load
 *   this package cannot account for.
 *
 * The pack list is read off the directory, never written down here: a fifth
 * pack added tomorrow is covered without anyone remembering to add it.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../../spawn-budget.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRESETS_DIR = join(PACKAGE_ROOT, "presets");

/** Every shipped pack, by filename, derived from the tree. */
const packFiles = readdirSync(PRESETS_DIR).filter((name) => name.endsWith(".json"));

/**
 * The paths `npm pack` would put in the tarball.
 *
 * The arguments are an array, never a built string — every value here comes
 * from the package tree (`../../../../AGENTS.md`), and a directory name is
 * attacker-supplied the moment a pull request adds one.
 *
 * A failure to run is thrown rather than skipped: a packaging check that
 * quietly did not run reads exactly like one that ran and found everything
 * present, which is the direction this repository refuses.
 */
function packedPaths() {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout)[0].files.map((file) => file.path);
}

// Every test here spawns a child (`npm pack`, or one Node resolve per pack),
// so the whole suite runs under the derived spawn-test ceiling instead of
// vitest's 5000 ms default. `../../spawn-budget.mjs` owns both numbers;
// the cold-CI measurement below is why the ceiling exists, not what sets it.
describe("the shipped policy packs reach a consumer", { timeout: SPAWN_TEST_BUDGET_MS }, () => {
  it("has packs to ship at all", () => {
    // Without this, every assertion below passes vacuously over an empty list
    // — a preset directory emptied by a bad merge would read as fully
    // published.
    expect(packFiles.length).toBeGreaterThan(0);
  });

  it("puts every pack in the tarball npm would publish", () => {
    // `npm pack --dry-run` walks the whole package on every run and has been
    // measured just over vitest's 5s default on a cold CI runner (5.9s on the
    // Node 24 lane) — a timing red that reads like a packaging regression.
    // The child process already carries the shared single-spawn budget above;
    // this suite's ceiling only stops vitest from racing it (#249).
    const packed = packedPaths();
    expect(packed.filter((path) => path.startsWith("presets/")).sort()).toEqual(
      packFiles.map((name) => `presets/${name}`).sort(),
    );
  });

  it.each(packFiles)("resolves %s by its documented package specifier", (name) => {
    const specifier = `@ecoma-io/lattice/presets/${name}`;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `process.stdout.write(import.meta.resolve(${JSON.stringify(specifier)}))`,
      ],
      {
        cwd: PACKAGE_ROOT,
        encoding: "utf8",
        timeout: SPAWN_BUDGET_MS,
        killSignal: "SIGKILL",
      },
    );
    if (result.error) throw result.error;
    // A specifier the `exports` map does not name exits non-zero with
    // ERR_PACKAGE_PATH_NOT_EXPORTED. Asserting the status before the path is
    // what keeps a failed probe from reading as a mismatched string.
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(pathToFileURL(join(PRESETS_DIR, name)).href);
  });
});

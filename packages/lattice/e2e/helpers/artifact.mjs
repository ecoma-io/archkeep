// Packs the `@ecoma-io/lattice` artifact once per E2E run.
//
// E2E tests run the installed CLI, which means they need a real `pnpm pack`
// tarball — the same artifact a consumer would install from npm. Packing once
// and sharing the tarball path across tests avoids the overhead of packing
// per scenario (~2 s per pack on CI).
//
// The returned `cleanup` removes the temporary pack directory. It should be
// called in a Vitest `afterAll` (or `afterAll`-equivalent) to avoid leaving
// tarballs in OS temp directories.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Packs the `@ecoma-io/lattice` artifact and returns the tarball path.
 *
 * @param {string} [packageDir] Absolute path to the package directory.
 *   Defaults to `packages/lattice` relative to the repository root.
 * @returns {{ tarballPath: string, peers: Record<string, string>, packageName: string, packageManager: string, cleanup: () => void }}
 */
export function packArtifact(packageDir) {
  const pkgDir = packageDir ?? resolve(root, "packages/lattice");
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  const packDir = realpathSync(mkdtempSync(join(tmpdir(), "lattice-e2e-pack-")));
  const packed = spawnSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: pkgDir,
    encoding: "utf8",
  });
  if (packed.status !== 0) {
    rmSync(packDir, { recursive: true, force: true });
    throw new Error(`\`pnpm pack\` failed:\n${packed.stdout ?? ""}\n${packed.stderr ?? ""}`);
  }

  const tarball = readdirSync(packDir).find((entry) => entry.endsWith(".tgz"));
  if (!tarball) {
    rmSync(packDir, { recursive: true, force: true });
    throw new Error(`\`pnpm pack\` reported success but wrote no .tgz into ${packDir}.`);
  }

  return {
    tarballPath: join(packDir, tarball),
    peers: manifest.peerDependencies ?? {},
    packageName: manifest.name,
    packageManager: rootManifest.packageManager,
    cleanup() {
      rmSync(packDir, { recursive: true, force: true });
    },
  };
}

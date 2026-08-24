/**
 * Provenance: does the committed source still build the committed artifact?
 *
 * Everything else this package runs checks the COMMITTED BYTES and nothing
 * else. `./artifact.test.mjs` hashes them against their sidecar digest;
 * `./golden.test.mjs` replays them through the engine's real host. Both stay
 * green when `../examples/forbidden-tag-dependency.ts` is edited in place,
 * because neither one reads it — and `typecheck` compiles the source with
 * `--noEmit`, which proves it still compiles and proves nothing about what it
 * builds. So a rule edit that never reruns `../rebuild-example.sh` diverges
 * from its own artifact indefinitely, green everywhere, until someone happens
 * to rebuild by hand.
 *
 * This file closes that gap by doing the one thing CI was right to refuse
 * elsewhere: it compiles the example SOURCE — with the same pinned `asc` the
 * rebuild script drives, reading the same `../asconfig.json` flags — and
 * requires the result to be the committed artifact, byte for byte. Two things
 * make that affordable where a rebuild gate would not be:
 *
 * - **No new toolchain.** `asc` is this package's own devDependency already;
 *   the `typecheck` target runs it in CI today. Nothing is installed for this
 *   test that `pnpm install` did not put there.
 * - **No bytes written into the tree.** The output lands in a temp directory
 *   and is compared, never copied over the committed file — the commit is
 *   still made by `../rebuild-example.sh`, by a human, with the digest beside
 *   it.
 *
 * The comparison is exact because the compiler is pinned and the build is
 * reproducible: two runs of the same `asc` over the same source produce the
 * same digest (measured, and recorded in `../README.md`'s "Building the
 * artifact" section), which is the property this file turns from a remark
 * into a gate. A different `asc` version breaks it too — deliberately, since
 * a version bump that changes the bytes without a rebuild is exactly the
 * drift being caught.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import asc from "assemblyscript/asc";

/** @param {string} relative @returns {string} */
const packagePath = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));

test("compiling the committed source reproduces the committed artifact byte for byte", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "archkeep-rule-sdk-ts-provenance-"));
  try {
    const outFile = join(outDir, "forbidden-tag-dependency.wasm");
    // The same three arguments `../rebuild-example.sh` passes, absolute only so
    // this file does not depend on the directory `node --test` was invoked
    // from. `stdout`/`stderr` are captured rather than inherited: a successful
    // converge still prints "Last converge was suboptimal.", which is a
    // property of the optimizer's fixpoint search and not a defect — the exit
    // value below is the verdict, not the chatter.
    const stdout = /** @type {any} */ (asc.createMemoryStream());
    const stderr = /** @type {any} */ (asc.createMemoryStream());
    const result = await asc.main(
      [
        packagePath("examples/forbidden-tag-dependency.ts"),
        "--config",
        packagePath("asconfig.json"),
        "--outFile",
        outFile,
      ],
      { stdout, stderr },
    );
    assert.equal(
      result.error,
      null,
      `the committed source no longer compiles under the pinned compiler:\n${stderr.toString()}`,
    );

    const rebuilt = readFileSync(outFile);
    const committed = readFileSync(packagePath("examples/forbidden-tag-dependency.wasm"));
    assert.ok(
      rebuilt.equals(committed),
      `compiling examples/forbidden-tag-dependency.ts produces ${rebuilt.length} bytes while the ` +
        `committed artifact is ${committed.length} bytes — the source and the artifact have drifted ` +
        "apart. Edit the source AND rebuild both files with ./rebuild-example.sh in the same change.",
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

#!/usr/bin/env node
// The `e2e:smoke` gate: runs the smoke subset, and FAILS when it ran nothing.
//
// WHY this script exists. `vitest run -t 'smoke'` treats a name pattern that
// matches zero tests as a successful run: it prints "Test Files N skipped /
// Tests M skipped" and exits 0. A future rename of every `(smoke)` describe
// block — or a misnamed new one — would then turn the PR path's fastest
// installed-artifact signal green-while-empty: byte-identical to a run that
// actually exercised the product, exactly the silence `AGENTS.md` refuses.
//
// `--passWithNoTests=false` does not close this: the flag only governs when no
// test FILES are found, and a `-t` filter still "finds" the files — every test
// inside them is just skipped, and the run exits 0. So the gate reads the
// JSON report vitest writes alongside its human output and counts the tests
// that actually EXECUTED (passed or failed). Zero executed means the filter
// selected nothing, and the gate fails loudly.
//
// The smoke subset is still what `package.json`'s `e2e:smoke` runs; this
// script only adds the "ran something" assertion around it. It also propagates
// vitest's own exit code for a failing smoke test, so a red smoke run stays red.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestBin = join(root, "node_modules", ".bin", "vitest");
const reportDir = mkdtempSync(join(tmpdir(), "lattice-e2e-smoke-"));
const outputFile = join(reportDir, "smoke.json");

/** Every test that ran, pass or fail — the count a zero-match `-t` makes 0. */
export function executedTests(report) {
  let ran = 0;
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === "passed" || assertion.status === "failed") ran += 1;
    }
  }
  return ran;
}

function main() {
  // `process.exit` inside the `try` would skip the `finally` cleanup — Node
  // honours the exit before any pending `finally`. So every failure path falls
  // through to the single exit below, after `finally` has removed the report
  // directory, and `status` carries the vitest exit code (1 for a red smoke
  // run) or 1 for the gate's own refusals.
  let status = 0;
  try {
    const result = spawnSync(
      vitestBin,
      [
        "run",
        "--config",
        join(root, "packages/lattice", "e2e", "vitest.config.mjs"),
        "-t",
        "smoke",
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${outputFile}`,
      ],
      { cwd: root, stdio: "inherit", encoding: "utf8" },
    );

    if (result.status !== 0) {
      // `status` is `null` when the spawn itself failed — a vitest bin the
      // workspace never installed (CI always has one, but a broken pnpm
      // layout or a moved tree does not). Without this, that path would exit
      // 1 in silence with the reason only in `result.error`, which
      // `stdio: "inherit"` never prints.
      if (result.status === null && result.error) {
        console.error(`e2e:smoke: could not launch vitest: ${result.error.message}`);
      }
      status = result.status ?? 1;
    } else {
      let report;
      try {
        report = JSON.parse(readFileSync(outputFile, "utf8"));
      } catch {
        console.error(
          "e2e:smoke: vitest exited 0 but wrote no readable JSON report — the gate cannot " +
            "prove anything ran, failing loudly.",
        );
        status = 1;
      }
      if (status === 0 && executedTests(report) === 0) {
        console.error(
          "e2e:smoke: zero tests ran — every '(smoke)' describe block is misnamed, missing, " +
            "or skipped. A smoke gate that runs nothing passes by accident; fix the filter " +
            "or the describes before merging.",
        );
        status = 1;
      }
    }
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
  if (status !== 0) process.exit(status);
}

// The same guard the other gate scripts use, so `node --test` importing this
// module for `executedTests` does not re-run the gate. The obvious spelling —
// `process.argv[1] === fileURLToPath(import.meta.url)` — is wrong under pnpm's
// symlinked layout, where the two resolve differently (see
// check-packages.mjs's `isProgramEntry` for the argument).
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

if (isProgramEntry(import.meta.url)) main();

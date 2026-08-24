#!/usr/bin/env node
// Proves the packed AssemblyScript rule SDK works for someone who is not this
// workspace — the `verify-package.mjs` discipline, applied to the second
// package this repository publishes to npm.
//
// WHY it needs its own script rather than an argument to that one: every check
// there drives an Nx workspace, a checker exit contract and a language server,
// and this package has none of those. It ships SOURCE — `assembly/` compiled by
// `asc` in the consumer's own tree — so the question a consumer's first hour
// asks is a different question, and only one thing can answer it: compile a
// rule from a directory that has the TARBALL installed.
//
// That question is not hypothetical here, and it is not covered anywhere else:
//
//   - `assembly/index.ts`'s header and `README.md`'s "What a rule is" both tell
//     an author to import from `@ecoma-io/archkeep-rule-sdk/assembly`, and state
//     that the `/assembly` subpath is load-bearing because asc maps a bare
//     package name onto `~lib/<name>.ts` and fails to find it. Nothing in this
//     repository compiles that specifier: the committed reference rule imports
//     `../assembly/index`, a relative path that resolves inside the package and
//     says nothing about resolving from `node_modules`. The manifest carries no
//     `exports` field, so what makes the documented import work is the `files`
//     list shipping `assembly/` at that exact path — a fact no test held.
//   - The manifest declares Apache-2.0 and the package directory holds no
//     LICENSE. `pnpm pack` copies the repository-root LICENSE into a tarball
//     and `npm publish` re-packs without it (the release lane's own comment
//     records the measurement, which is why `packages/archkeep` carries its own
//     copy). The lane verifies a pnpm tarball and publishes with npm, so a
//     licence present at verify time and absent at publish time is exactly the
//     shape of defect that reaches the registry unnoticed.
//
// So the checks below, in the order a consumer meets them:
//
//   1. `npm` and `pnpm` select the same files from the same tree — the verified
//      bytes are the published bytes.
//   2. The tarball carries a LICENSE, because the manifest claims one.
//   3. The tarball installs into a throwaway workspace beside `assemblyscript`.
//   4. The rule the SDK's own documentation prints — importing through
//      `@ecoma-io/archkeep-rule-sdk/assembly`, from a consumer directory, with
//      the shipped `asconfig.json` as `--config` — COMPILES.
//   5. The module it produces declares no imports at all.
//   6. It exports exactly the four symbols the ABI names, each of the right
//      kind — the same contract `test/artifact.test.mjs` holds for the
//      committed artifact, re-asked of a module built from installed bytes.
//   7. A rule reaching for the clock FAILS to compile. A verifier only proves
//      it runs when it can go red, and this is the direction that matters: the
//      `use: ["Date="]` refusal lives in the shipped asconfig.json, so a
//      tarball that forgot to ship that file would still pass checks 4-6 and
//      would silently stop refusing the ambient capabilities the contract is
//      built on.
//
// Unix-only by design, like `verify-package.mjs`: it shells out to `npm`,
// `pnpm` and `tar` by PATH, and every job in the release lane runs
// `ubuntu-latest`.

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_DIR = "packages/archkeep-rule-sdk-ts";

/** @type {string[]} */
const failures = [];

/** @param {string} text */
const note = (text) => console.log(text);

/**
 * @param {string} label
 * @param {boolean} ok
 * @param {string} evidence
 * @returns {boolean}
 */
function check(label, ok, evidence) {
  if (ok) {
    note(`ok   ${label}`);
    return true;
  }
  note(`FAIL ${label}`);
  failures.push(`${label}\n${evidence}`);
  return false;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @param {Record<string, string>} [extraEnv]
 */
function run(command, args, cwd, extraEnv = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

/**
 * The rule an author is told to copy, READ OUT of `assembly/index.ts`'s own
 * header rather than restated here.
 *
 * A copy would be the drift this repository refuses everywhere else: the header
 * is what an author actually reads, and a verifier holding its own
 * paraphrase would keep passing while the documented text stopped compiling.
 * So the fenced `ts` block is extracted, and a missing or unreadable block is a
 * hard failure — falling back to a built-in copy is exactly the silence that
 * would make this check stop meaning anything.
 *
 * @param {string} text full contents of assembly/index.ts
 * @returns {string} the documented rule, as AssemblyScript source
 */
export function documentedRuleSource(text) {
  const lines = text.split("\n");
  const open = lines.findIndex((line) => line.trim() === "// ```ts");
  if (open === -1) {
    throw new Error(
      "assembly/index.ts carries no ```ts block in its header, so there is no documented " +
        "rule to compile. Either the header was restructured and this extractor still " +
        "expects the old shape, or the example an author copies is gone.",
    );
  }
  const close = lines.findIndex((line, index) => index > open && line.trim() === "// ```");
  if (close === -1) {
    throw new Error("assembly/index.ts's ```ts block is never closed, so it cannot be extracted.");
  }
  const source = lines
    .slice(open + 1, close)
    .map((line) => line.replace(/^\/\/ ?/, ""))
    .join("\n");
  // A BARE specifier ending in `/assembly`, not merely the substring: a
  // relative `../assembly/index` contains it too, and compiling that would
  // prove the package's internal shape while saying nothing about resolving
  // out of `node_modules` — which is the whole question.
  if (!/from\s+"[^".][^"]*\/assembly"/.test(source)) {
    throw new Error(
      "the documented rule does not import through a bare `…/assembly` specifier, which is " +
        "the one thing compiling it from an installed tree exists to prove. A relative " +
        "import resolves inside the package and would make this check vacuous.",
    );
  }
  return `${source}\n`;
}

/** The four symbols the ABI names, and the kind each must be. */
const REQUIRED_EXPORTS = {
  memory: "memory",
  archkeep_alloc: "function",
  archkeep_describe: "function",
  archkeep_evaluate: "function",
};

/**
 * Packs, installs and compiles. The only function here that touches the
 * outside world, and it is deliberately not unit-tested: a test that stubbed
 * `pnpm pack` or `asc` would pin the stub, and the stub is precisely the part
 * that cannot be wrong for the check to mean anything.
 */
function main() {
  const packageDir = join(root, PACKAGE_DIR);
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const packageName = manifest.name;
  const assemblyscript = manifest.devDependencies?.assemblyscript;
  if (!assemblyscript) {
    console.error(
      `${PACKAGE_DIR}/package.json declares no assemblyscript devDependency, so this script ` +
        `has no compiler version to install. Refusing to guess one: a consumer compiles with ` +
        `the version this package develops against, and a different one is a different test.`,
    );
    process.exit(2);
  }

  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "verify-rule-sdk-ts-")));
  const packDir = join(workdir, "pack");
  const consumer = join(workdir, "consumer");
  mkdirSync(packDir);
  mkdirSync(consumer);

  let exitCode = 0;
  try {
    note(`packing ${packageName} from ${PACKAGE_DIR}`);
    const packed = run("pnpm", ["pack", "--pack-destination", packDir], packageDir);
    if (packed.status !== 0) {
      console.error(packed.stdout ?? "");
      console.error(packed.stderr ?? "");
      console.error("`pnpm pack` failed, so there is no artifact to verify.");
      process.exit(1);
    }
    const tarball = readdirSync(packDir).find((entry) => entry.endsWith(".tgz"));
    if (!tarball) {
      console.error(`\`pnpm pack\` reported success but wrote no .tgz into ${packDir}.`);
      process.exit(1);
    }
    const tarballPath = join(packDir, tarball);

    // 1. Selection parity. The lane verifies this pnpm tarball and publishes with
    //    `npm publish`, which re-packs — so a divergence would ship bytes nothing
    //    verified. Compared as sorted sets after stripping the `package/` prefix
    //    pnpm's tarball carries, because the two order entries differently.
    const listing = run("tar", ["-tzf", tarballPath], packageDir, { LC_ALL: "C" });
    const pnpmNames = (listing.stdout ?? "")
      .split("\n")
      .map((entry) => entry.replace(/\/$/, "").replace(/^package\//, ""))
      .filter(Boolean)
      .sort();
    const dryRun = run("npm", ["pack", "--dry-run", "--json"], packageDir, { LC_ALL: "C" });
    let npmNames = [];
    try {
      npmNames = (JSON.parse(dryRun.stdout ?? "")[0]?.files ?? []).map((file) => file.path).sort();
    } catch {
      // Will fail the check below.
    }
    check(
      "npm and pnpm select the same files from the same tree — the verified bytes are the published bytes",
      listing.status === 0 &&
        dryRun.status === 0 &&
        pnpmNames.length === npmNames.length &&
        pnpmNames.every((name, index) => name === npmNames[index]),
      `pnpm pack lists ${pnpmNames.length}; npm pack lists ${npmNames.length}\n` +
        `pnpm-only: ${pnpmNames.filter((n) => !npmNames.includes(n)).join(", ") || "(none)"}\n` +
        `npm-only: ${npmNames.filter((n) => !pnpmNames.includes(n)).join(", ") || "(none)"}`,
    );

    // 2. The licence the manifest claims must be IN the tarball. npm does not
    //    copy the repository-root LICENSE the way pnpm does, so this is checked
    //    against npm's selection specifically — the one the registry receives.
    check(
      `the tarball carries a LICENSE, which the manifest's "${manifest.license}" claims`,
      npmNames.some((name) => /^LICEN[CS]E/.test(name)),
      `npm selected: ${npmNames.join(", ") || "(nothing)"}`,
    );

    // 3. Install the tarball the way a consumer would, beside the compiler this
    //    package develops against.
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify({ name: "rule-sdk-consumer", private: true, type: "module" }, null, 2)}\n`,
    );
    const install = run(
      "npm",
      ["install", "--no-audit", "--no-fund", tarballPath, `assemblyscript@${assemblyscript}`],
      consumer,
    );
    const installed = check(
      "the tarball installs into a workspace that never built it",
      install.status === 0,
      `exit ${install.status}\n${install.stdout ?? ""}${install.stderr ?? ""}`,
    );

    if (installed) {
      const asc = join(consumer, "node_modules", ".bin", "asc");
      const asconfig = join(consumer, "node_modules", packageName, "asconfig.json");

      // 4. The documented import specifier compiles from an installed tree.
      const ruleSource = documentedRuleSource(
        readFileSync(join(packageDir, "assembly", "index.ts"), "utf8"),
      );
      writeFileSync(join(consumer, "rule.ts"), ruleSource);
      const build = run(asc, ["rule.ts", "--config", asconfig, "--outFile", "rule.wasm"], consumer);
      const built = check(
        `the rule assembly/index.ts documents, importing "${packageName}/assembly", compiles from a consumer directory`,
        build.status === 0,
        `exit ${build.status}\n${build.stdout ?? ""}${build.stderr ?? ""}`,
      );

      if (built) {
        const bytes = readFileSync(join(consumer, "rule.wasm"));
        const module = new WebAssembly.Module(bytes);

        // 5. Zero imports — the mechanism behind "a rule holds no ambient
        //    capability", read off bytes built from the shipped asconfig.
        const imports = WebAssembly.Module.imports(module);
        check(
          "the module built from the installed SDK declares no imports at all",
          imports.length === 0,
          `imports: ${imports.map((i) => `${i.module}.${i.name}`).join(", ") || "(none)"}`,
        );

        // 6. The four ABI exports, each of the right kind.
        const exports = WebAssembly.Module.exports(module);
        const byName = new Map(exports.map((entry) => [entry.name, entry.kind]));
        for (const [name, kind] of Object.entries(REQUIRED_EXPORTS)) {
          check(
            `the module exports ${name} as a ${kind}`,
            byName.get(name) === kind,
            `exports: ${exports.map((e) => `${e.name}:${e.kind}`).join(", ") || "(none)"}`,
          );
        }
      }

      // 7. The red direction. `use: ["Date="]` lives in the shipped
      //    asconfig.json, so a tarball missing that file would pass every check
      //    above and quietly stop refusing the clock.
      writeFileSync(
        join(consumer, "reaches-for-the-clock.ts"),
        `export { archkeep_alloc } from "${packageName}/assembly";\n` +
          `export function archkeep_describe(): i64 {\n` +
          `  return <i64>Date.now();\n` +
          `}\n`,
      );
      const refused = run(
        asc,
        ["reaches-for-the-clock.ts", "--config", asconfig, "--outFile", "clock.wasm"],
        consumer,
      );
      check(
        "a rule reaching for the clock is refused by the shipped asconfig.json",
        refused.status !== 0,
        `asc exited ${refused.status} — it should have failed\n${refused.stdout ?? ""}${refused.stderr ?? ""}`,
      );
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error("");
    for (const failure of failures) console.error(`✗ ${failure}\n`);
    console.error(
      `${failures.length} check(s) failed, so this tarball is not fit to publish. ` +
        `An npm version cannot be unpublished away.`,
    );
    exitCode = 1;
  }
  process.exit(exitCode);
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

if (isProgramEntry(import.meta.url)) main();

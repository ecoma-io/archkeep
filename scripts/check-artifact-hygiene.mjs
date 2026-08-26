#!/usr/bin/env node
// The gate that refuses a committed binary carrying its build machine inside it.
//
// Every SDK ships a compiled `.wasm` that a consumer runs and a reviewer cannot
// read. That combination is what makes this gate necessary: a text file leaking
// a token is caught by Gitleaks and by the reviewer's own eyes, and a binary
// leaking one is caught by neither — Gitleaks does not scan wasm, and no diff
// shows a reader what 6MB of bytes contains.
//
// This is not hypothetical. The Python SDK compiles RustPython from source, and
// a cargo build script records the environment it ran under INTO the artifact —
// every variable, name and value. A rebuild on a developer's own machine
// therefore bakes that machine's entire environment into a file that is
// committed and published: absolute paths, socket paths, session ids, and any
// secret that happened to be exported. Both spellings of that failure are
// already in this repository's history, which is why the gate exists rather
// than a paragraph asking people to be careful.
//
// The rule the gate enforces: an artifact must carry its own code and nothing
// about where it was built.
//
// What it cannot do is the reason the patterns below are shapes rather than a
// list of known secrets. A gate that looked for the tokens already leaked would
// pass the next one — so it looks for the SHAPE of a build environment instead:
// a home directory, a credential prefix, an environment variable this project
// never puts in a rule. Anything matching is a finding, and a finding is a
// failure rather than a warning, because a warning on a binary nobody reads is
// the silent direction `AGENTS.md` refuses.

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where a shipped artifact may live. Anything matching `*.wasm` under one of
 * these is in scope; a build output under `target/` is not, because it is not
 * committed and not published. */
export const ARTIFACT_ROOTS = [
  "packages/archkeep-rule-sdk-rust/examples",
  "packages/archkeep-rule-sdk-go/examples",
  "packages/archkeep-rule-sdk-ts/examples",
  "packages/archkeep-rule-sdk-python/examples",
  "packages/archkeep-rules/rules",
];

/**
 * The shapes that mean "this binary knows where it was built".
 *
 * Each is a class rather than an instance on purpose: `HOME` catches any
 * developer's home directory, not one person's; `CREDENTIAL` catches the
 * prefixes registries actually issue, not the tokens that already leaked.
 *
 * `AGENT_ENV` is the narrow one and needs its reason stated: these variable
 * names belong to the tools that DRIVE a build, never to a rule that runs
 * inside one. A wasm rule is a pure function from evidence to verdict — it has
 * no session, no socket and no agent — so the presence of one of these names is
 * proof the environment leaked in, whatever value sits beside it.
 */
export const FORBIDDEN = [
  { id: "HOME", pattern: /\/home\/[a-z0-9_-]+\//iu, why: "a build machine's home directory" },
  { id: "USERS", pattern: /\/Users\/[a-z0-9_-]+\//iu, why: "a build machine's home directory" },
  {
    id: "CREDENTIAL",
    pattern: /(github_pat_|ghp_|gho_|ghs_|ghr_|sk-|glpat-|npm_|pypi-)[A-Za-z0-9_-]{8,}/u,
    why: "something shaped like a credential",
  },
  {
    id: "AGENT_ENV",
    pattern:
      /(ORCA_[A-Z][A-Z_]{2,}|CLAUDE_CODE_[A-Z][A-Z_]{2,}|SSH_AUTH_SOCK|XAUTHORITY|AWS_SECRET|GITHUB_TOKEN)/u,
    why: "an environment variable from the tooling that ran the build",
  },
];

// No `\b` anchors anywhere above, and that absence is load-bearing rather than
// sloppiness. The environment table a build script embeds is written with no
// separators — `…1a7a88a823a5ORCA_AGENT_HOOK_TOKEN…`, one variable's value
// running straight into the next one's name — so there is no word boundary in
// front of `ORCA_` for `\b` to match. Anchored, these two patterns found
// NOTHING in the very artifact that leaked a live token and a GitHub PAT: only
// the `HOME` row matched, and it carried the whole failure by itself. A
// credential check that silently never fires is worse than no credential check
// at all, because the report it prints reads identically to a clean one.
// `./check-artifact-hygiene.test.mjs` pins each class against a sample in the
// concatenated shape, so an anchor cannot come back unnoticed.

/**
 * Every printable run of 4+ characters in a buffer — `strings(1)` in ten lines,
 * so the gate needs no binary on PATH and behaves the same on every platform.
 *
 * @param {Buffer} bytes
 * @returns {string} the runs, newline-joined
 */
export function printableRuns(bytes) {
  const out = [];
  let run = "";
  for (const byte of bytes) {
    if (byte >= 0x20 && byte <= 0x7e) {
      run += String.fromCharCode(byte);
      continue;
    }
    if (run.length >= 4) out.push(run);
    run = "";
  }
  if (run.length >= 4) out.push(run);
  return out.join("\n");
}

/**
 * Judges one artifact's extracted text. Pure, so its test needs no filesystem.
 *
 * @param {string} file the artifact's path, for the report
 * @param {string} text the artifact's printable runs
 * @returns {{file: string, id: string, why: string, sample: string}[]} findings
 */
export function findLeaks(file, text) {
  const findings = [];
  for (const { id, pattern, why } of FORBIDDEN) {
    const global = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
    const hits = [...text.matchAll(global)];
    if (hits.length === 0) continue;
    // The sample is truncated and the count is what carries the weight: a report
    // that printed every match of a leaked credential would leak it again, into
    // a CI log this time.
    findings.push({
      file,
      id,
      why,
      sample: `${hits.length} match(es), first is ${JSON.stringify(hits[0][0].slice(0, 24))}…`,
    });
  }
  return findings;
}

/** Every `*.wasm` under the roots above. */
export function artifacts(roots = ARTIFACT_ROOTS) {
  const found = [];
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      // A root that does not exist is a finding, not a skip: it means a package
      // moved and this list did not, and a gate scanning nothing passes
      // everything.
      throw new Error(`${root}: no such directory — ARTIFACT_ROOTS is stale`);
    }
    for (const entry of entries) {
      if (!entry.endsWith(".wasm")) continue;
      const path = join(root, entry);
      if (statSync(path).isFile()) found.push(path);
    }
  }
  if (found.length === 0)
    throw new Error("no .wasm artifacts found — the gate would pass vacuously");
  return found;
}

function main() {
  const files = artifacts();
  const findings = [];
  for (const file of files) {
    const bytes = execFileSync("cat", [file], { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
    findings.push(...findLeaks(file, printableRuns(bytes)));
  }

  for (const file of files) {
    const bad = findings.filter((f) => f.file === file);
    if (bad.length === 0) console.log(`ok   ${file} — carries no build environment`);
    else for (const f of bad) console.log(`FAIL ${file} — ${f.why} (${f.id}): ${f.sample}`);
  }

  if (findings.length > 0) {
    console.log(
      `\n${findings.length} artifact leak(s). A committed .wasm must carry its own code and nothing about where it was built.\n` +
        `Rebuild it in a container — the rebuild-example.sh headers say how — rather than on a developer machine,\n` +
        `then regenerate the .sha256 beside it.`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

/**
 * `adrForWorkspace` — the light preamble two faces share, composed.
 *
 * The command's own verdicts are `./adr.test.mjs`'s subject, so every case
 * here states only what the driver adds: the root found by walking up from
 * `cwd`, the tracked list read through the injectable seam, options
 * forwarded unchanged, and the `null` that hands the no-workspace refusal
 * back to the caller. The tracked-list case is the one that can fail
 * silently: a driver that dropped `tracked` would let the registry read
 * every file in `docs/adr/` — including the untracked one the fixture
 * plants — and report a decision the tree never committed, which is the
 * empty-but-clean direction the invariant (`../../../../AGENTS.md`) refuses.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../../spawn-budget.mjs";
import { adrForWorkspace } from "./adr-for-workspace.mjs";
import { adrCommand } from "./adr.mjs";
import { listTrackedFiles } from "../workspace.mjs";

/** Every fixture root, removed once at the end — each test names its own. */
const created = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

const ADR = `---
id: 0001-one-boundary
status: accepted
---

# One boundary law
`;

/**
 * A workspace the driver can find: a marker at the root, one recorded
 * decision. With `git`, the tree is staged so the DEFAULT tracked-file read
 * (a real `git ls-files`) names the record; without it the record on disk is
 * untracked and only an injected `listFiles` can.
 *
 * @param {{git?: boolean}} [options]
 * @returns {string} The fixture root.
 */
function fixture({ git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "adr-for-workspace-"));
  created.push(root);
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  writeFileSync(join(root, "nx.json"), "{}\n");
  writeFileSync(join(root, "docs", "adr", "0001-one-boundary.md"), ADR);
  if (git) {
    const run = (...args) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: root,
        encoding: "utf8",
        timeout: SPAWN_BUDGET_MS,
        killSignal: "SIGKILL",
      });
    run("init");
    run("add", ".");
  }
  return root;
}

describe("adrForWorkspace", { timeout: SPAWN_TEST_BUDGET_MS }, () => {
  it("runs the adr command for the workspace found by walking up from cwd", () => {
    // `cwd` is a subdirectory on purpose: the root the run answers for is the
    // walked-up one, not the directory the call started from, and the default
    // tracked read is the real `git ls-files` both callers rely on.
    const root = fixture({ git: true });
    const result = adrForWorkspace({ cwd: join(root, "docs") });
    expect(result.status).toBe("ok");
    expect(result.result.adrs).toEqual(["0001-one-boundary"]);
  });

  it("returns exactly what adrCommand returns for the inputs it resolved", () => {
    // The no-added-policy proof: over the same fixture, the driver's result
    // equals the command run directly on the root with the tracked list the
    // same primitive read. A default invented in the driver shows up here as
    // a diff.
    const root = fixture({ git: true });
    const result = adrForWorkspace({ cwd: root });
    expect(result).toEqual(adrCommand(root, {}, { tracked: listTrackedFiles(root) }));
  });

  it("returns null when no ancestor of cwd is a workspace root", () => {
    // A git repository holding no marker, so the walk is bounded by the
    // repository top the way it is in a real tree and answers `null`
    // deterministically instead of depending on what sits above tmpdir. The
    // refusal itself is the caller's — `runAdr` and the MCP history adapter
    // each render their own — which is why the driver's only honest answer
    // here is the null.
    const bare = mkdtempSync(join(tmpdir(), "adr-for-workspace-bare-"));
    created.push(bare);
    spawnSync("git", ["init"], {
      cwd: bare,
      encoding: "utf8",
      timeout: SPAWN_BUDGET_MS,
      killSignal: "SIGKILL",
    });
    expect(adrForWorkspace({ cwd: bare })).toBeNull();
  });

  it("feeds the registry only the tracked list the seam names", () => {
    // The record is on disk but the injected list does not name it, so the
    // registry must answer empty — `tracked` is the one exclusion the
    // registry applies before it validates. A driver that dropped the list
    // reads the record and reports a decision the tree never committed; a
    // driver that ignored the seam falls back to a git this fixture does not
    // have and throws. Either wrong composition is red here, not silent.
    const root = fixture();
    const result = adrForWorkspace({ cwd: root }, {}, { listFiles: () => ["nx.json"] });
    expect(result.status).toBe("ok");
    expect(result.result.adrs).toEqual([]);
  });

  it("forwards the options to the command unchanged", () => {
    const root = fixture();
    const tracked = ["docs/adr/0001-one-boundary.md", "nx.json"];
    const result = adrForWorkspace(
      { cwd: root },
      { id: "0001-one-boundary" },
      {
        listFiles: () => tracked,
      },
    );
    expect(result).toEqual(adrCommand(root, { id: "0001-one-boundary" }, { tracked }));
  });
});

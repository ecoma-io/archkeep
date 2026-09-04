// The MCP↔CLI envelope differential, over one frozen native-provider fixture.
//
// The adapters compose the engine's own command functions in-process — the
// same functions `cli.mjs` drives — but the two faces do not share the
// invocation: the CLI builds its run from parsed argv (`archkeep check
// --format json`), an adapter from its own option literal. The contract both
// must satisfy is stated once in `./engine.mjs`'s header: a completed call
// returns the versioned JSON envelope, "the same object `archkeep <command>
// --format json` renders, parsed from the bytes the command itself built".
// Nothing before this file held that sentence against both faces at once —
// each side had its own suite, so a default that grew on one face only (an
// option the CLI parses that the adapter's literal omits, or a field the
// adapter's parse drops) would pass every suite while an agent and a CI job
// over the same tree read different envelopes.
//
// So: one workspace on disk — the native-provider shape, no Nx installed, a
// real git repository with frozen identity and dates — and the SAME command
// through both faces. The spawned CLI and the adapter must agree byte for
// byte, key order included: `JSON.stringify` of the two parsed envelopes is
// the comparison, so a field that moved position is as red as a field that
// moved value. The fixture is the violating shape `scripts/verify-package.mjs`
// already proves the engine judges (a `layer:core` project reaching a
// `layer:app` one), so the differential runs across a findings envelope, not
// only a clean one.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkTool, graphTool } from "./engine.mjs";

/** The engine CLI, resolved through the workspace dependency — never a relative guess at the sibling layout. */
const CLI = join(
  dirname(fileURLToPath(import.meta.resolve("@ecoma-io/archkeep/package.json"))),
  "cli.mjs",
);

/** Frozen commit metadata — the fixture's provenance must be identical across runs. */
const FROZEN_DATE = "2026-01-01T00:00:00.000Z";

let root;

const git = (...args) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: FROZEN_DATE,
      GIT_COMMITTER_DATE: FROZEN_DATE,
      HOME: process.env.HOME,
    },
  });

/** The real CLI, the way a hook or a CI step runs it. */
const runCli = (args) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });

const write = (relativePath, text) => {
  mkdirSync(join(root, relativePath, ".."), { recursive: true });
  writeFileSync(join(root, relativePath), text);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "archkeep-mcp-cli-differential-"));
  // The native-provider workspace shape: `archkeep.json` at the root carries
  // the project list and the law's filename, and no `nx.json` exists — the
  // graph is built from the tree alone, so neither face needs Nx installed.
  // `coverage.exempt` waives the config module itself, an analyzable `.mjs`
  // at the root no project owns.
  write(
    "archkeep.json",
    `${JSON.stringify(
      {
        boundaryConfig: "module-boundaries.config.mjs",
        projects: {
          declared: [
            { root: "libs/core", name: "core", tags: ["layer:core"] },
            { root: "libs/app", name: "app", tags: ["layer:app"] },
          ],
        },
        coverage: {
          exempt: [
            {
              path: "module-boundaries.config.mjs",
              reason: "workspace tooling config at the root, not itself a project",
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  write(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "layer:core", onlyDependOnLibsWithTags: ["layer:core"] },
  { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:app", "layer:core"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
export const boundarySuppressions = [];
`,
  );
  write("libs/core/go.mod", "module example.test/core\n\ngo 1.22\n");
  write("libs/core/core.go", 'package core\n\nconst Name = "core"\n');
  write("libs/app/go.mod", "module example.test/app\n\ngo 1.22\n");
  write("libs/app/app.go", 'package app\n\nconst Name = "app"\n');
  // The violation, in the one direction the graph holds: core reaching up
  // into app under a row that allows core to reach only its own layer — the
  // shape `scripts/verify-package.mjs` proves the engine judges with exit 1.
  // app reaches nothing, so the graph holds exactly one edge and the check
  // produces exactly one finding — a cycle here would let the circular
  // dependency rule outrank the boundary row and change what the envelope
  // carries.
  write(
    "libs/core/go.mod",
    "module example.test/core\n\ngo 1.22\n\nrequire example.test/app v0.0.0\n\n" +
      "replace example.test/app => ../app\n",
  );
  write("libs/core/violate.go", 'package core\n\nimport "example.test/app"\n\nvar _ = app.Name\n');
  // A git repository with a committed, clean tree: the CLI's file list comes
  // from `git ls-files`, and the envelope's provenance must be a fact about
  // the committed state — identical for both faces and identical across runs.
  expect(git("init", "-q", "-b", "main").status).toBe(0);
  expect(git("add", "-A").status).toBe(0);
  expect(git("commit", "-q", "-m", "base").status).toBe(0);
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("the MCP face answers with the CLI face's own bytes", () => {
  it(
    "archkeep_check: the adapter's envelope is the CLI's envelope, key order included",
    { timeout: 120_000 },
    async () => {
      const cli = runCli(["check", "--format", "json"]);
      expect(cli.status).toBe(1); // findings — the violation is real, on both faces
      const cliEnvelope = JSON.parse(cli.stdout);
      expect(cliEnvelope.status).toBe("findings");
      expect(cliEnvelope.result.violations).toHaveLength(1);

      const result = await checkTool({ workspaceRoot: root });
      expect(result.runCompleted).toBe(true);
      expect(result.verdict).toBe("fail");
      // Stringify both sides after parsing: equality of the serialized forms
      // is deep equality AND key-order equality, so neither a moved value nor
      // a moved field can pass.
      expect(JSON.stringify(result.envelope)).toBe(JSON.stringify(cliEnvelope));
      // The finding itself survives the transport unchanged — the agent acts
      // on the same position a CI reader would.
      expect(result.envelope.result.violations[0]).toEqual(cliEnvelope.result.violations[0]);
    },
  );

  it(
    "archkeep_graph: the adapter's envelope is the CLI's envelope, law fingerprint included",
    { timeout: 120_000 },
    async () => {
      const cli = runCli(["graph", "--format", "json"]);
      expect(cli.status).toBe(0);
      const cliEnvelope = JSON.parse(cli.stdout);
      expect(cliEnvelope.result.projects.map((project) => project.name)).toEqual(["app", "core"]);

      const envelope = await graphTool({ workspaceRoot: root });
      expect(envelope.status).toBe("ok");
      expect(JSON.stringify(envelope)).toBe(JSON.stringify(cliEnvelope));
      // The law rode along on both faces: the boundary config the workspace
      // declares is fingerprinted identically, or one face answered under a
      // different law than the other.
      expect(envelope.result.policy.fingerprint).toBe(cliEnvelope.result.policy.fingerprint);
    },
  );
});

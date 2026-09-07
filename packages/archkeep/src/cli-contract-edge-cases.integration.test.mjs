/**
 * CLI contract edge cases: parser-level behavior that the exit-matrix
 * (per-command ok/refused worlds) does not cover — unknown commands,
 * unknown flags, invalid formats, help, version, and non-workspace
 * failures.
 *
 * Each test exercises the CLI's own parser and dispatch, not a
 * particular command's business logic — that is the exit-matrix's
 * contract. These tests run against `/nonexistent` as the working
 * directory, so they verify the parser layer alone without needing a
 * workspace fixture.
 */
import { describe, expect, it } from "vitest";

import { COMMAND_NAMES, runCli } from "../cli.mjs";

/**
 * Runs one command in-process, capturing both streams.
 *
 * @param {string[]} argv
 * @returns {Promise<{exitCode: number, out: string, err: string}>}
 */
async function run(argv) {
  const out = [];
  const err = [];
  const exitCode = await runCli(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: "/nonexistent",
    readGraph: () => ({
      nodes: {},
      dependencies: {},
    }),
    listFiles: () => [],
  });
  return { exitCode, out: out.join("\n"), err: err.join("\n") };
}

const EXIT = Object.freeze({
  ok: 0,
  usage: 2,
});

// ---------------------------------------------------------------------------
// Universal CLI flags
// ---------------------------------------------------------------------------

describe("CLI contract — universal flags", () => {
  it("--help exits 0 and prints usage", async () => {
    const { exitCode, out } = await run(["--help"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(out).toContain("archkeep");
  });

  it("-h exits 0 and prints usage", async () => {
    const { exitCode, out } = await run(["-h"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(out).toContain("archkeep");
  });

  it("--version exits 0 and prints version", async () => {
    const { exitCode, out } = await run(["--version"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(out).toMatch(/\d+\.\d+\.\d+/);
  });

  it("-v exits 0 and prints version", async () => {
    const { exitCode, out } = await run(["-v"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(out).toMatch(/\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// Unknown / missing commands
// ---------------------------------------------------------------------------

describe("CLI contract — unknown or missing commands", () => {
  it("no argument exits 2 with usage", async () => {
    const { exitCode, err } = await run([]);
    expect(exitCode).toBe(EXIT.usage);
    expect(err).toContain("no command given");
  });

  it("unknown command exits 2 with usage", async () => {
    const { exitCode, err } = await run(["nope"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(err).toContain("unknown command");
    expect(err).toContain("nope");
  });

  it("garbage command exits 2 with usage", async () => {
    const { exitCode, err } = await run(["!!invalid!!"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(err).toContain("unknown command");
  });
});

// ---------------------------------------------------------------------------
// Unknown / invalid flags
// ---------------------------------------------------------------------------

describe("CLI contract — unknown or invalid flags", () => {
  it("unknown flag on check exits 2 with usage", async () => {
    const { exitCode, err } = await run(["check", "--nope"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(err).toContain("unknown option");
  });

  it("unknown format on check exits 2 with usage", async () => {
    const { exitCode, err } = await run(["check", "--format", "xml"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(err).toContain("unknown format");
  });

  it("unknown flag on graph exits 2 with usage", async () => {
    const { exitCode, err } = await run(["graph", "--bogus"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(err).toContain("unknown option");
  });

  it("missing flag value exits 2 with usage", async () => {
    const { exitCode, err } = await run(["check", "--config"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(err).toContain("needs a value");
  });
});

// ---------------------------------------------------------------------------
// Per-command --help flag (exits 0, does NOT dispatch)
// ---------------------------------------------------------------------------

describe("CLI contract — per-command --help exits 0", () => {
  // The roster is derived from COMMAND_NAMES, never restated: this file's
  // hand-written copy once drifted (it named no `scenario`, so the one verb
  // added later went unexercised here while its --help worked, #771). The
  // parser-level claim below — --help/-h exit 0 without dispatching — is
  // owned per-command by every entry of the real roster; the usage text's
  // byte identity is the corpus gate's contract
  // (src/corpus/golden-output.integration.test.mjs, the --help lane), not
  // this file's.
  for (const cmd of COMMAND_NAMES) {
    it(`${cmd} --help exits 0`, async () => {
      const { exitCode, out } = await run([cmd, "--help"]);
      expect(exitCode).toBe(EXIT.ok);
      expect(out).toContain(cmd);
    });
  }

  for (const cmd of COMMAND_NAMES) {
    it(`${cmd} -h exits 0`, async () => {
      const { exitCode, out } = await run([cmd, "-h"]);
      expect(exitCode).toBe(EXIT.ok);
      expect(out).toContain(cmd);
    });
  }
});

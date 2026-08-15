/**
 * `runProcess`'s contract, driven through a mocked `node:child_process`.
 *
 * The mock is a `vi.fn`, so the error shape handed to `runProcess` is a test
 * decision: the real `execFileSync` always wraps its failures in an `Error`
 * that carries a message, which would leave the `|| cause` tail of the
 * error-naming line exercised by nothing. The contract pinned here — the
 * thrown `Error` names the full command and the directory, whatever shape the
 * child's failure took — is the one `./providers/nx.mjs` and
 * `./providers/native/` rely on when they wrap their own spawns.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { execFileSync } from "node:child_process";

import { runProcess } from "./process.mjs";

describe("runProcess", () => {
  it("returns the child's stdout", () => {
    execFileSync.mockReturnValue("out");
    expect(runProcess("git", ["ls-files"], "/repo")).toBe("out");
  });

  it("defaults the environment to one stripped of ambient git redirects", () => {
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = "/ambient/.git";
    try {
      execFileSync.mockReturnValue("out");
      runProcess("git", ["ls-files"], "/repo");
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
    const env = execFileSync.mock.calls.at(-1)[2].env;
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.PATH).toBeDefined();
  });

  it("passes an explicit environment through untouched, git redirects and all", () => {
    execFileSync.mockReturnValue("out");
    runProcess("git", ["ls-files"], "/repo", { GIT_DIR: "/elsewhere/.git", PATH: "/usr/bin" });
    expect(execFileSync.mock.calls.at(-1)[2].env).toEqual({
      GIT_DIR: "/elsewhere/.git",
      PATH: "/usr/bin",
    });
  });

  it("names the failing command with the child's stderr when there is one", () => {
    execFileSync.mockImplementation(() => {
      throw Object.assign(new Error("something broke"), { stderr: "fatal: not a git repo" });
    });
    expect(() => runProcess("git", ["status"], "/repo")).toThrow(
      /`git status` failed in \/repo: fatal: not a git repo/,
    );
  });

  it("falls back to the error message when the child leaves no stderr", () => {
    execFileSync.mockImplementation(() => {
      const cause = new Error("spawn definitely-not-a-program ENOENT");
      cause.code = "ENOENT";
      throw cause;
    });
    expect(() => runProcess("definitely-not-a-program", ["--x"], "/repo")).toThrow(
      /`definitely-not-a-program --x` failed in \/repo: spawn definitely-not-a-program ENOENT/,
    );
  });

  it("still names the command when the error carries neither stderr nor message", () => {
    // The `|| cause` tail: whatever the child's failure shape, the caller
    // hears which command, where, and why.
    execFileSync.mockImplementation(() => {
      throw new Error();
    });
    expect(() => runProcess("git", ["push"], "/repo")).toThrow(
      /`git push` failed in \/repo: Error/,
    );
  });
});

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

import { EXIT, runCli } from "../cli.mjs";
import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../spawn-budget.mjs";

// Every spawn in this file (the real-executable `run` below, plus the raw
// git spawns further down) stays under the single-spawn budget, but the
// tests that chain several of them need the derived, file-wide ceiling
// rather than vitest's 5000 ms default — one module-scope call, not a
// `{ timeout: SPAWN_TEST_BUDGET_MS }` repeated on whichever describe someone
// remembered. `vi.setConfig` scopes to this file only and vitest resets it
// afterwards. `../spawn-budget.mjs` owns both numbers;
// `spawn-budget.test.mjs` is the gate that requires this call.
vi.setConfig({ testTimeout: SPAWN_TEST_BUDGET_MS });

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));

/** Runs the real executable, the way a shell, a hook, or CI would. */
const run = (args, options = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    // One spawned child gets the shared single-spawn budget; without any
    // bound, a wedged spawn blocks this thread indefinitely — a state no
    // vitest timeout can interrupt. `../spawn-budget.mjs` owns the pair. cf. #41
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
    ...options,
  });

/**
 * A native workspace with three projects across two top-level directories and
 * one cross-directory edge, plus a tracked `architecture-intent.json`. The
 * intent is the write-back tripwire: `discover --propose` must never touch it,
 * and its bytes after any discover run are asserted identical to the bytes
 * this fixture pinned.
 */
const root = mkdtempSync(join(tmpdir(), "polyglot-cli-discover-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (relativePath, text) => {
  mkdirSync(join(root, relativePath, ".."), { recursive: true });
  writeFileSync(join(root, relativePath), text);
};

write(
  "archkeep.json",
  JSON.stringify({
    projects: {
      declared: [
        { root: "libs/core", name: "core", tags: ["layer:domain"] },
        { root: "libs/util", name: "util", tags: ["layer:domain"] },
        { root: "apps/app", name: "app", tags: [] },
      ],
    },
  }),
);
write("libs/core/go.mod", "module example.com/core\n\ngo 1.24\n");
write("libs/util/go.mod", "module example.com/util\n\ngo 1.24\n");
write("apps/app/go.mod", "module example.com/app\n\ngo 1.24\n");
// The cross-directory edge: app imports core. A same-directory edge core→util
// would be inside one component and propose no boundary assertion.
write(
  "libs/core/doc.go",
  `// Package core.
package core

import (
	"example.com/util"
)

var _ = util.Name
`,
);
write(
  "apps/app/doc.go",
  `// Package app.
package app

import (
	"example.com/core"
)

var _ = core.Name
`,
);

const INTENT = JSON.stringify(
  {
    version: "1",
    boundaries: [
      { name: "core", match: ["name:core"] },
      { name: "util", match: ["name:util"] },
    ],
  },
  null,
  2,
);
write("architecture-intent.json", INTENT);

const files = [
  "archkeep.json",
  "architecture-intent.json",
  "libs/core/go.mod",
  "libs/core/doc.go",
  "libs/util/go.mod",
  "apps/app/go.mod",
  "apps/app/doc.go",
];

const context = { cwd: root, listFiles: () => files };

/** `runCli`'s whole outside world: two capturing streams plus the seams above. */
const env = () => {
  const out = [];
  const err = [];
  return {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    lines: { out, err },
    ...context,
  };
};

describe("discover — descriptive by default", () => {
  it("exits 0 and reports the observed projects, edges and tags, with no proposal anywhere", async () => {
    const streams = env();
    expect(await runCli(["discover"], streams)).toBe(EXIT.ok);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("discovery complete");
    expect(out).toContain("3 projects");
    expect(out).toContain("app");
    expect(out).toContain("core");
    expect(out).toContain("util");
    expect(out).toContain("2 edges");
    expect(out).toContain("tags layer:domain");
    // No banner, no candidates, no boundary assertions.
    expect(out).not.toContain("proposed architecture");
    expect(out).not.toContain("not authoritative");
  });

  it("leaves the tracked intent byte-identical after a descriptive run", async () => {
    const streams = env();
    expect(await runCli(["discover"], streams)).toBe(EXIT.ok);
    expect(readFileSync(join(root, "architecture-intent.json"), "utf8")).toBe(INTENT);
  });

  it("reports the observations in the versioned JSON envelope, with no proposal key", async () => {
    const streams = env();
    expect(await runCli(["discover", "--format", "json"], streams)).toBe(EXIT.ok);
    const envelope = JSON.parse(streams.lines.out.join(""));
    expect(envelope.command).toBe("discover");
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.result.discovery.projects).toHaveLength(3);
    expect(envelope.result.discovery.edges).toHaveLength(2);
    // Additive envelope: descriptive runs carry no proposal at all.
    expect(envelope.result.proposal).toBeUndefined();
  });

  it("exits 2 on positional arguments, before any analysis runs", async () => {
    const streams = env();
    expect(await runCli(["discover", "libs/core"], streams)).toBe(EXIT.usage);
    expect(streams.lines.err.join("\n")).toContain(
      "archkeep: discover takes no positional arguments; got libs/core",
    );
  });
});

describe("discover --propose — candidates marked, never decisions", () => {
  it("exits 0 and marks every candidate proposed and not authoritative", async () => {
    const streams = env();
    expect(await runCli(["discover", "--propose"], streams)).toBe(EXIT.ok);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("proposed architecture — NOT authoritative, never written");
    expect(out).toContain("[proposed — not authoritative]");
    // The libs component (core+util) emerges.
    expect(out).toContain("component libs");
    // The app→core edge crosses apps/libs, so it proposes a boundary assertion.
    expect(out).toContain("boundary: app and core belong to different components");
  });

  it("writes the proposal to --output atomically and names the count on stderr", async () => {
    const target = join(root, "discover-proposal.json");
    const streams = env();
    expect(
      await runCli(["discover", "--propose", "--format", "json", "--output", target], streams),
    ).toBe(EXIT.ok);
    expect(streams.lines.err.join("\n")).toContain("3 projects, 2 edges, 2 boundary assertions");
    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written.command).toBe("discover");
    expect(written.result.proposal.proposed).toBe(true);
    expect(written.result.proposal.notAuthoritative).toBe(true);
  });

  it("never writes back to the tracked intent — the intent file is byte-identical after --propose", async () => {
    const streams = env();
    expect(await runCli(["discover", "--propose"], streams)).toBe(EXIT.ok);
    expect(readFileSync(join(root, "architecture-intent.json"), "utf8")).toBe(INTENT);
    // The printed proposal went to stdout, not into any file in the tree.
    expect(streams.lines.out.join("")).toContain("proposed architecture");
  });

  it("is deterministic: two --propose runs over the unchanged tree produce identical bytes", async () => {
    const first = env();
    const second = env();
    expect(await runCli(["discover", "--propose", "--format", "json"], first)).toBe(EXIT.ok);
    expect(await runCli(["discover", "--propose", "--format", "json"], second)).toBe(EXIT.ok);
    expect(first.lines.out.join("")).toBe(second.lines.out.join(""));
    const textFirst = env();
    const textSecond = env();
    expect(await runCli(["discover", "--propose"], textFirst)).toBe(EXIT.ok);
    expect(await runCli(["discover", "--propose"], textSecond)).toBe(EXIT.ok);
    expect(textFirst.lines.out.join("")).toBe(textSecond.lines.out.join(""));
  });
});

describe("discover --write-intent — a proposal that refuses to become the law", () => {
  it("writes the proposal to a file that does not exist yet, and says it is not the law", async () => {
    const target = join(root, "proposed-intent.json");
    const streams = env();
    expect(await runCli(["discover", "--propose", "--write-intent", target], streams)).toBe(
      EXIT.ok,
    );
    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written.version).toBe("1");
    expect(Array.isArray(written.boundaries)).toBe(true);
    const err = streams.lines.err.join("\n");
    expect(err).toContain("proposed architecture written to");
    // The write is the one step that can turn a proposal into the file a
    // later `check` gates on, so the run must say out loud what landed.
    expect(err).toContain("not the law");
  });

  it("refuses to overwrite a file that is already there, and leaves its bytes alone", async () => {
    // The tracked intent is the standing law of this fixture — exactly the
    // file a careless overwrite would replace with a proposal.
    const streams = env();
    expect(
      await runCli(
        ["discover", "--propose", "--write-intent", join(root, "architecture-intent.json")],
        streams,
      ),
    ).toBe(EXIT.error);
    const err = streams.lines.err.join("\n");
    expect(err).toContain("already exists");
    expect(err).toContain("never");
    expect(readFileSync(join(root, "architecture-intent.json"), "utf8")).toBe(INTENT);
  });

  it("still refuses when the file appears after the run started — the wx flag holds the line", async () => {
    // The exists-check and the write are two moments, not one; a file landing
    // between them must hit the same refusal, so the write itself carries
    // `flag: "wx"` and this test pins that the second line of defense exists.
    const target = join(root, "raced-intent.json");
    writeFileSync(target, INTENT);
    const streams = env();
    expect(await runCli(["discover", "--propose", "--write-intent", target], streams)).toBe(
      EXIT.error,
    );
    expect(streams.lines.err.join("\n")).toContain("already exists");
    expect(readFileSync(target, "utf8")).toBe(INTENT);
  });
});

describe("discover over a tree it cannot fully read — the silent direction", () => {
  // A second, near-identical workspace whose only difference is an analyzable
  // file no declared project owns — a whole-file failure, which is exactly the
  // state `discover --propose` must refuse: every missing edge would be
  // ambiguous between "gone" and "never seen".
  const brokenRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-discover-broken-"));
  afterAll(() => rmSync(brokenRoot, { recursive: true, force: true }));

  const writeBroken = (relativePath, text) => {
    mkdirSync(join(brokenRoot, relativePath, ".."), { recursive: true });
    writeFileSync(join(brokenRoot, relativePath), text);
  };

  writeBroken(
    "archkeep.json",
    JSON.stringify({
      projects: { declared: [{ root: "libs/core", name: "core", tags: [] }] },
    }),
  );
  writeBroken("libs/core/go.mod", "module example.com/core\n\ngo 1.24\n");
  writeBroken("libs/core/core.go", "package core\n");
  // An analyzable file no declared project owns: a whole-file failure.
  writeBroken("libs/orphan/orphan.py", "import os\n");

  const brokenContext = {
    cwd: brokenRoot,
    listFiles: () => [
      "archkeep.json",
      "libs/core/go.mod",
      "libs/core/core.go",
      "libs/orphan/orphan.py",
    ],
  };

  it("reports observations descriptively at no-verdict — the coverage gap is stated, not hidden", async () => {
    const streams = {
      out: (t) => streams.lines.out.push(t),
      err: (t) => streams.lines.err.push(t),
      lines: { out: [], err: [] },
      ...brokenContext,
    };
    expect(await runCli(["discover"], streams)).toBe(EXIT.error);
    const out = streams.lines.out.join("\n");
    expect(out).toContain("discovery incomplete — 1 file could not be analyzed");
    // No candidate is proposed and no "clean" claim is made over a tree the
    // run could not fully read.
    expect(out).not.toContain("discovery complete");
  });

  it("refuses --propose over incomplete coverage, loudly, naming the file", async () => {
    const streams = {
      out: (t) => streams.lines.out.push(t),
      err: (t) => streams.lines.err.push(t),
      lines: { out: [], err: [] },
      ...brokenContext,
    };
    expect(await runCli(["discover", "--propose"], streams)).toBe(EXIT.error);
    const err = streams.lines.err.join("\n");
    expect(err).toContain("discover --propose has incomplete coverage");
    // The refusal is loud: it names the count and the ambiguity, and it must
    // never fall through to a proposal over an unread tree.
    expect(err).toContain("1 file could not be analyzed");
    expect(streams.lines.out.join("")).not.toContain("proposed architecture");
  });
});

describe("discover over a malformed model — exit 3, with no fabricated proposal", () => {
  it("exits 3 and names the malformed file from the real executable", () => {
    // The malformed-model class: a archkeep.json that will not load. Spawned so
    // the exit code is the process's own, not a value the test computed. A git
    // repo and tracked files are required — the native provider resolves the
    // tree from `git ls-files`, the same way every real run does.
    const malformedRoot = mkdtempSync(join(tmpdir(), "polyglot-cli-discover-malformed-"));
    try {
      const writeMalformed = (relativePath, text) => {
        mkdirSync(join(malformedRoot, relativePath, ".."), { recursive: true });
        writeFileSync(join(malformedRoot, relativePath), text);
      };
      writeMalformed("archkeep.json", "{ this is not JSON");
      writeMalformed("libs/core/go.mod", "module example.com/core\n\ngo 1.24\n");
      writeMalformed("libs/core/core.go", "package core\n");
      spawnSync("git", ["init", "-q", malformedRoot], {
        encoding: "utf8",
        timeout: SPAWN_BUDGET_MS,
      });
      spawnSync(
        "git",
        ["-C", malformedRoot, "add", "archkeep.json", "libs/core/go.mod", "libs/core/core.go"],
        {
          encoding: "utf8",
          timeout: SPAWN_BUDGET_MS,
        },
      );
      spawnSync("git", ["-C", malformedRoot, "commit", "-q", "-m", "fixture"], {
        encoding: "utf8",
        timeout: SPAWN_BUDGET_MS,
      });
      const result = run(["discover", "--propose"], { cwd: malformedRoot });
      expect(result.status).toBe(EXIT.error);
      expect(result.stderr).toContain("archkeep.json");
      // No proposal may be printed over a model that never loaded.
      expect(result.stdout).not.toContain("proposed architecture");
    } finally {
      rmSync(malformedRoot, { recursive: true, force: true });
    }
  });
});

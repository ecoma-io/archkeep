// Determinism runtime sweep: every machine-readable command, run twice over
// an unchanged committed tree, must produce byte-identical stdout AND the same
// exit code AND stable stderr.
//
// The three existing cases in this file prove graph/check/impact byte-identity
// on one tree each. The audit's empirical matrix (workstream E, E-F03) proved
// the rest of the surface byte-identical on two runs too, but that matrix
// lived under `.claude/tmp/` and enforced nothing: a future edit that made any
// of those commands order- or time-dependent would go green against the
// contract. This sweep is that matrix, gated.
//
// Two wall-clock fields are disclosed in the envelope's own `coverage.notes`
// (the note names them and says to exclude them from any diff or hash):
// `debt`'s `result.sampleTime` and `waivers`' `result.waivers[].remainingMs`.
// They are excised from the parsed JSON before comparison, and each case
// asserts the disclosure note exists — the note is the contract's proof that
// the drift is documented rather than silent. `history --capture` is not
// swept: its output is a function of history-directory state (the second
// capture dedups, E-F05), so it lives in `history.e2e.mjs`, not here.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import { createNativeLanguageConsumer, createNxLanguageConsumer } from "./helpers/consumer.mjs";
import { lattice } from "./helpers/run.mjs";
import {
  determinismSweepFiles,
  determinismSweepProfilesFiles,
  sweepIntents,
} from "./fixtures/determinism-sweep.mjs";

let artifact;
let clean; // native monorepo + matching intent + ADR
let cleanWaiver; // clean tree whose law carries a live waiver
let violating; // same tree, intent forbids the observed app→api edge
let malformed; // same tree, intent is strict JSON but not a valid intent
let profile; // Nx consumer selecting the "strict" profile by name

const MALFORMED_INTENT = { dependencies: { allowed: [] } };

/** The sweep consumer: native monorepo + intent + ADR, from `makeSweepFiles`. */
const makeSweep = (artifact, intent, options) =>
  createNativeLanguageConsumer(artifact, (packageName, peers, packageManager) =>
    determinismSweepFiles(packageName, peers, packageManager, intent, options),
  );

beforeAll(() => {
  artifact = packArtifact();
  clean = makeSweep(artifact, sweepIntents.CLEAN_INTENT);
  cleanWaiver = makeSweep(artifact, sweepIntents.CLEAN_INTENT, { withWaiver: true });
  violating = makeSweep(artifact, sweepIntents.VIOLATING_INTENT);
  malformed = makeSweep(artifact, MALFORMED_INTENT);
  profile = createNxLanguageConsumer(artifact, determinismSweepProfilesFiles);
});

afterAll(() => {
  clean?.cleanup();
  cleanWaiver?.cleanup();
  violating?.cleanup();
  malformed?.cleanup();
  profile?.cleanup();
  artifact?.cleanup();
});

/** A fresh history directory, outside the consumer's git tree. */
function freshHistoryDir() {
  return mkdtempSync(join(tmpdir(), "lattice-e2e-sweep-hist-"));
}

/**
 * A baseline snapshot for `diff`, written next to the tree as a plain file
 * (untracked, so `check`'s git spawn never sees it) via the same `graph`
 * command the sweep is proving deterministic — the baseline's own bytes are
 * pinned by the graph case in `determinism (full)`.
 *
 * @param {string} dir A directory to write the baseline into.
 * @returns {string} The absolute baseline path.
 */
function writeBaseline(dir) {
  const file = join(dir, "baseline.json");
  const result = lattice(clean.root, ["graph", "--format", "json"]);
  expect(result.exitCode).toBe(0);
  writeFileSync(file, result.stdout, "utf8");
  return file;
}

/**
 * Runs `args` twice over `root` and asserts byte-identical stdout, identical
 * exit code, and identical stderr.
 *
 * `excise` names JSON paths whose values are the two disclosed wall-clock
 * fields — `result.sampleTime` for `debt`, `result.waivers[].remainingMs` for
 * `waivers`. Those fields are excluded from the comparison BECAUSE the
 * envelope's own `coverage.notes` names them and says so; every other byte of
 * the two envelopes must still match. The caller asserts the note exists,
 * which is the loud disclosure that turns a documented drift into a contract.
 *
 * `expectExit`, when given, pins the absolute exit code from the first run —
 * the cross-run equality by itself would certify a command that regressed to
 * the same wrong exit on both runs.
 *
 * @param {string} root The consumer workspace root.
 * @param {string[]} args CLI arguments after `lattice`.
 * @param {{excise?: string[], expectExit?: number}} [options]
 */
function assertDeterministic(root, args, options = {}) {
  const first = lattice(root, args);
  const second = lattice(root, args);
  expect(first.exitCode).toBe(second.exitCode);
  expect(first.stderr).toBe(second.stderr);
  if (options.expectExit !== undefined) expect(first.exitCode).toBe(options.expectExit);

  if (options.excise && options.excise.length > 0) {
    expect(first.json).not.toBeNull();
    expect(second.json).not.toBeNull();
    const redact = (value) => {
      const normalized = JSON.parse(JSON.stringify(value));
      for (const path of options.excise) {
        const segments = path.split(".");
        let cursor = normalized;
        for (let i = 0; i < segments.length; i++) {
          const segment = segments[i];
          if (segment.endsWith("[]")) {
            // Descend into the array, then delete the trailing field from
            // each row — the two excise paths are both scalar-field-in-array.
            const rows = cursor[segment.slice(0, -2)];
            if (Array.isArray(rows)) {
              for (const row of rows) delete row[segments[i + 1]];
            }
            break;
          }
          if (i === segments.length - 1) delete cursor[segment];
          else cursor = cursor[segment];
        }
      }
      return normalized;
    };
    expect(JSON.stringify(redact(first.json))).toBe(JSON.stringify(redact(second.json)));
    return;
  }

  expect(first.stdout).toBe(second.stdout);
}

describe("determinism sweep (full)", () => {
  it("drift --format json is byte-identical, matching intent, exit 0", () => {
    assertDeterministic(clean.root, ["drift", "--format", "json"], { expectExit: 0 });
  });

  it("reconcile --format json is byte-identical, exit 0", () => {
    assertDeterministic(clean.root, ["reconcile", "--format", "json"], { expectExit: 0 });
  });

  it("reconcile --propose --format json is byte-identical, exit 0", () => {
    assertDeterministic(clean.root, ["reconcile", "--propose", "--format", "json"], {
      expectExit: 0,
    });
  });

  it("context <project> --format json is byte-identical, exit 0", () => {
    assertDeterministic(clean.root, ["context", "core", "--format", "json"], { expectExit: 0 });
  });

  it("provenance --format json is byte-identical, exit 0", () => {
    assertDeterministic(clean.root, ["provenance", "--format", "json"], { expectExit: 0 });
  });

  it("adr --format json is byte-identical, exit 0", () => {
    assertDeterministic(clean.root, ["adr", "--format", "json"], { expectExit: 0 });
  });

  it("discover --format json is byte-identical, exit 0 (descriptive)", () => {
    assertDeterministic(clean.root, ["discover", "--format", "json"], { expectExit: 0 });
  });

  it("discover --propose --format json is byte-identical, exit 0 (candidate ranking)", () => {
    assertDeterministic(clean.root, ["discover", "--propose", "--format", "json"], {
      expectExit: 0,
    });
  });

  it("fitness --format json is byte-identical, exit 3, on a policy declaring none", () => {
    // The sweep fixture's boundary config declares no `fitness` export, so
    // this is the no-verdict refusal lane — "nothing to judge" must be as
    // deterministic as a clean verdict.
    assertDeterministic(clean.root, ["fitness", "--format", "json"], { expectExit: 3 });
  });

  it("explain <site> --format json is byte-identical, exit 0", () => {
    assertDeterministic(clean.root, ["explain", "libs/app/app.go:3:8", "--format", "json"], {
      expectExit: 0,
    });
  });

  it("health --format json is byte-identical, exit 0", () => {
    assertDeterministic(clean.root, ["health", "--format", "json"], { expectExit: 0 });
  });

  it("health <history-dir> --format json is byte-identical over a fixed history dir", () => {
    const dir = freshHistoryDir();
    try {
      const capture = lattice(clean.root, ["history", dir, "--capture"]);
      expect(capture.exitCode).toBe(0);
      assertDeterministic(clean.root, ["health", dir, "--format", "json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("debt <history-dir> is byte-identical except the disclosed sampleTime", () => {
    const dir = freshHistoryDir();
    try {
      const capture = lattice(clean.root, ["history", dir, "--capture"]);
      expect(capture.exitCode).toBe(0);
      assertDeterministic(clean.root, ["debt", dir, "--format", "json"], {
        excise: ["result.sampleTime"],
      });
      const result = lattice(clean.root, ["debt", dir, "--format", "json"]);
      expect(result.json.coverage.notes.join(" ")).toContain("sampleTime");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("history <history-dir> --format json is byte-identical over a fixed history dir", () => {
    const dir = freshHistoryDir();
    try {
      const capture = lattice(clean.root, ["history", dir, "--capture"]);
      expect(capture.exitCode).toBe(0);
      assertDeterministic(clean.root, ["history", dir, "--format", "json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diff <baseline> --format json is byte-identical, exit 0", () => {
    const dir = freshHistoryDir();
    try {
      const baseline = writeBaseline(dir);
      assertDeterministic(clean.root, ["diff", baseline, "--format", "json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("check --format json is byte-identical and stays exit 0 on the sweep tree", () => {
    assertDeterministic(clean.root, ["check", "--format", "json"], { expectExit: 0 });
  });

  it("check --format sarif is byte-identical on a clean tree, exit 0", () => {
    assertDeterministic(clean.root, ["check", "--format", "sarif"], { expectExit: 0 });
  });

  it("check --format json is byte-identical and stays exit 1 on a violating tree", () => {
    assertDeterministic(violating.root, ["check", "--format", "json"], { expectExit: 1 });
  });

  it("check --format sarif is byte-identical on a violating tree, exit 1", () => {
    assertDeterministic(violating.root, ["check", "--format", "sarif"], { expectExit: 1 });
  });

  it("drift --format json is byte-identical on a violating tree, exit 0 (descriptive)", () => {
    assertDeterministic(violating.root, ["drift", "--format", "json"], { expectExit: 0 });
  });

  it("waivers --format json is byte-identical except the disclosed remainingMs", () => {
    assertDeterministic(cleanWaiver.root, ["waivers", "--format", "json"], {
      excise: ["result.waivers[].remainingMs"],
      expectExit: 0,
    });
    const result = lattice(cleanWaiver.root, ["waivers", "--format", "json"]);
    expect(result.json.coverage.notes.join(" ")).toContain("remainingMs");
    expect(result.json.result.waivers).toHaveLength(1);
  });

  it("waivers --format json is byte-identical on a tree with no waiver", () => {
    assertDeterministic(clean.root, ["waivers", "--format", "json"], { expectExit: 0 });
  });

  it("check --format json is byte-identical, exit 3, on a malformed intent", () => {
    assertDeterministic(malformed.root, ["check", "--format", "json"], { expectExit: 3 });
  });

  it("drift --format json is byte-identical, exit 3, on a malformed intent", () => {
    assertDeterministic(malformed.root, ["drift", "--format", "json"], { expectExit: 3 });
  });

  it("check --format json is byte-identical on a tree with no workspace", () => {
    // No workspace root above the directory: `pnpm exec` cannot find the
    // package, so the observable contract is "not 0" (same reasoning as the
    // "exits 3 when run outside any workspace" case in `check.e2e.mjs`). The
    // two failures must be byte-identical all the same.
    const nowhere = mkdtempSync(join(tmpdir(), "lattice-e2e-sweep-nowhere-"));
    try {
      const first = lattice(nowhere, ["check", "--format", "json"]);
      const second = lattice(nowhere, ["check", "--format", "json"]);
      expect(first.exitCode).not.toBe(0);
      expect(first.exitCode).toBe(second.exitCode);
      expect(first.stdout).toBe(second.stdout);
      expect(first.stderr).toBe(second.stderr);
    } finally {
      rmSync(nowhere, { recursive: true, force: true });
    }
  });

  it("check --format json is byte-identical on an empty workspace, exit 3", () => {
    // A workspace with no projects at all is a no-verdict run (exit 3) — a
    // tree declaring zero projects cannot reach a verdict — and that refusal
    // must be as deterministic as a clean verdict.
    const empty = createNativeLanguageConsumer(artifact, (packageName, peers, packageManager) =>
      determinismSweepFiles(packageName, peers, packageManager, sweepIntents.CLEAN_INTENT),
    );
    try {
      writeFileSync(
        join(empty.root, "lattice.json"),
        JSON.stringify(
          {
            boundaryConfig: "module-boundaries.config.mjs",
            projects: { declared: [] },
            coverage: { exempt: [] },
          },
          null,
          2,
        ),
        "utf8",
      );
      assertDeterministic(empty.root, ["check", "--format", "json"], { expectExit: 3 });
    } finally {
      empty.cleanup();
    }
  });
});

// The Nx profile consumer installs the real `nx` package (a larger install
// than the native consumers above) and is created in the shared `beforeAll`
// alongside them. Its assertions live in a separate `describe` only so a
// failure there reads distinctly from a native-tree failure — the consumer
// itself lives and dies with the same `beforeAll`/`afterAll` as the rest.
describe("determinism sweep: profile-selected (full)", () => {
  it("check --format json is byte-identical on a profile-selected Nx tree, exit 0", () => {
    assertDeterministic(profile.root, ["check", "--format", "json"]);
    const result = lattice(profile.root, ["check", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json.result.policy.profile).toBe("strict");
  });
});

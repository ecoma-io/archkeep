import { describe, expect, it } from "vitest";

import { LANGUAGE_BY_EXTENSION } from "../../analysis/analyze.mjs";
import { fileFailure } from "../../analysis/source-util.mjs";
import { judgeCoverage } from "./coverage.mjs";

const unowned = () => undefined;

describe("judgeCoverage", () => {
  // The load-bearing case: a file no project owns must surface, both as
  // `unclaimed` and as the same whole-file `fileFailure` shape a language
  // analyzer produces for a file it could not read. The silent-direction bug
  // this guards against is the file being dropped instead — an empty
  // `failures` array reading exactly like a workspace with nothing wrong.
  it("reports an unowned analyzable file as unclaimed, with a matching whole-file failure", () => {
    const result = judgeCoverage({
      files: ["apps/orphan/main.py"],
      projectOf: unowned,
      exempt: [],
    });
    expect(result.unclaimed).toEqual(["apps/orphan/main.py"]);
    expect(result.failures).toEqual([
      fileFailure(
        "apps/orphan/main.py",
        "is not owned by any project declared or inferred from archkeep.json — every " +
          "analyzable tracked file must belong to exactly one project, or be named in " +
          "archkeep.json's coverage.exempt with a reason",
      ),
    ]);
  });

  // "coverage / scope": the near-miss that keeps the check usable. A README
  // or a lockfile sitting at a root with no project is not itself a coverage
  // hole — nothing claims to analyze it — so it must never appear beside a
  // real hole in the same run.
  it("does not report a file no analyzer claims, even at a root with no project", () => {
    const result = judgeCoverage({
      files: ["README.md", "pnpm-lock.yaml", "orphan.py"],
      projectOf: unowned,
      exempt: [],
    });
    expect(result.unclaimed).toEqual(["orphan.py"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].sourceFile).toBe("orphan.py");
  });

  // "coverage / registry": read the extension list FROM the real dispatcher
  // table rather than hand-copying it, so a language added to
  // `analysis/analyze.mjs` tomorrow is covered by this test with no edit
  // here. The silent-direction bug is `judgeCoverage` growing its own,
  // second copy of the extension list that quietly stops matching the first.
  it("treats every extension the analyzer registry claims today as analyzable", () => {
    for (const extension of Object.keys(LANGUAGE_BY_EXTENSION)) {
      const file = `orphan${extension}`;
      const result = judgeCoverage({ files: [file], projectOf: unowned, exempt: [] });
      expect(result.unclaimed, `extension ${extension}`).toEqual([file]);
    }
  });

  it("removes an exempted file from unclaimed and files it under exempted instead", () => {
    const result = judgeCoverage({
      files: ["scripts/gen.py"],
      projectOf: unowned,
      exempt: [{ path: "scripts/*.py", reason: "generated, reviewed at codegen time" }],
    });
    expect(result.unclaimed).toEqual([]);
    expect(result.exempted).toEqual(["scripts/gen.py"]);
    expect(result.failures).toEqual([]);
    expect(result.stale).toEqual([]);
  });

  // "coverage / stale waiver": a waiver matching nothing currently unclaimed
  // must be reported, not kept — the silent-direction bug is the hole a
  // waiver used to cover reopening (a file renamed, a project removed) with
  // the waiver still silently "covering" nothing at all.
  it("flags a coverage.exempt row that matches no unclaimed file as stale", () => {
    const result = judgeCoverage({
      files: ["src/main.py"],
      projectOf: () => "owner",
      exempt: [{ path: "scripts/*.py", reason: "nothing here uses this glob any more" }],
    });
    expect(result.stale).toEqual([
      { path: "scripts/*.py", reason: "nothing here uses this glob any more" },
    ]);
    expect(result.unclaimed).toEqual([]);
    expect(result.exempted).toEqual([]);
  });

  // The scoping is deliberately narrow: "matches no UNCLAIMED file", never
  // "matches nothing in the tree at all". A waiver whose glob still matches a
  // real file — one a project now legitimately owns — is exactly as stale as
  // one matching nothing, because the hole it used to cover is closed either
  // way. Reading it as "still covering something" would be the false-negative
  // this narrower definition exists to avoid papering over.
  it("flags a waiver as stale once a project claims the file it used to cover, even though the glob still matches that file in the tree", () => {
    const result = judgeCoverage({
      files: ["scripts/gen.py"],
      projectOf: (file) => (file === "scripts/gen.py" ? "codegen" : undefined),
      exempt: [{ path: "scripts/*.py", reason: "was unclaimed; codegen now owns it" }],
    });
    expect(result.stale).toEqual([
      { path: "scripts/*.py", reason: "was unclaimed; codegen now owns it" },
    ]);
    expect(result.unclaimed).toEqual([]);
    expect(result.exempted).toEqual([]);
  });

  it("distinguishes a live waiver from a stale one in the same call", () => {
    const result = judgeCoverage({
      files: ["scripts/gen.py", "scripts/old.py"],
      projectOf: unowned,
      exempt: [
        { path: "scripts/gen.py", reason: "generated, reviewed separately" },
        { path: "scripts/dead.py", reason: "no longer applies to anything tracked" },
      ],
    });
    expect(result.stale).toEqual([
      { path: "scripts/dead.py", reason: "no longer applies to anything tracked" },
    ]);
    expect(result.exempted).toEqual(["scripts/gen.py"]);
    expect(result.unclaimed).toEqual(["scripts/old.py"]);
  });

  // N3/N4: `files` and `claimed` ride ADDITIVELY alongside the existing
  // fields above — every prior assertion in this file still passes unchanged.
  // The silent-direction risk a caller wanting "what did this run inspect"
  // would hit without them: a `check` that only ever reports what is WRONG
  // has no way to also state what it looked at, and an empty `unclaimed`
  // would read identically whether coverage judged 3 files or 3,000 of them.
  it("counts only analyzable files in `files`, and only project-owned ones in `claimed`", () => {
    const result = judgeCoverage({
      files: ["apps/a/main.py", "apps/b/main.py", "README.md", "pnpm-lock.yaml"],
      projectOf: (file) => (file === "apps/a/main.py" ? "a" : undefined),
      exempt: [],
    });
    // README.md and pnpm-lock.yaml match no analyzer, so they never reach the
    // denominator — `files` counts what coverage judges, not the tree size.
    expect(result.files).toBe(2);
    expect(result.claimed).toBe(1);
    expect(result.unclaimed).toEqual(["apps/b/main.py"]);
  });

  // `claimed` means "a project owns it" specifically — an exempted file is
  // still NOT claimed by any project, only waived from failing. Collapsing
  // the two would silently overstate how much of the tree a project model
  // actually accounts for.
  it("does not count an exempted file as claimed — exempted and claimed are different facts", () => {
    const result = judgeCoverage({
      files: ["scripts/gen.py"],
      projectOf: unowned,
      exempt: [{ path: "scripts/*.py", reason: "generated, reviewed at codegen time" }],
    });
    expect(result.files).toBe(1);
    expect(result.claimed).toBe(0);
    expect(result.exempted).toEqual(["scripts/gen.py"]);
  });

  // The three-way split always accounts for every analyzable file: nothing
  // judged here is allowed to vanish between `claimed`, `unclaimed` and
  // `exempted` — a file lost between the three would be a silent hole in the
  // coverage count itself, one level up from the per-file failures above.
  it("keeps files === claimed + unclaimed + exempted for a mixed set", () => {
    const result = judgeCoverage({
      files: ["apps/a/main.py", "apps/orphan/main.py", "scripts/gen.py"],
      projectOf: (file) => (file === "apps/a/main.py" ? "a" : undefined),
      exempt: [{ path: "scripts/*.py", reason: "generated, reviewed at codegen time" }],
    });
    expect(result.files).toBe(3);
    expect(result.claimed + result.unclaimed.length + result.exempted.length).toBe(result.files);
  });
});

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ADR_DIR,
  ADR_ID_PATTERN,
  adrsBinding,
  boundFitnessIds,
  loadAdrRegistry,
  parseFrontmatterFields,
  resolveDecisionRef,
  resolveWithRemote,
  validateRecord,
} from "./adr-registry.mjs";

/** An in-memory `docs/adr/` tree for the loaders. */
function inMemoryTree(files) {
  return {
    readdirSync: () => Object.keys(files),
    readFileSync: (path) => {
      const name = path.split("/").pop();
      if (!(name in files)) {
        throw Object.assign(new Error(`ENOENT: no such file ${name}`), { code: "ENOENT" });
      }
      return files[name];
    },
  };
}

const VALID = [
  [
    "0001-bind-collaboration.md",
    `---
id: 0001-bind-collaboration
status: accepted
bindings:
  - rule:no-direct-dep
  - fitness:hotspot
---

# Bind collaboration
`,
  ],
];

function treeWith(files) {
  const extra = Object.fromEntries(VALID);
  return inMemoryTree({ ...extra, ...files });
}

describe("parseFrontmatterFields", () => {
  it("parses scalars and list fields", () => {
    expect(
      parseFrontmatterFields(
        "id: 0001-x\nstatus: accepted\nbindings:\n  - rule:one\n  - rule:two\n",
        "0001-x",
      ),
    ).toEqual({
      id: "0001-x",
      status: "accepted",
      bindings: ["rule:one", "rule:two"],
    });
  });

  it("parses an inline comma-separated list as a scalar — toList splits it", () => {
    expect(parseFrontmatterFields("bindings: rule:a, rule:b\n", "0001-x").bindings).toBe(
      "rule:a, rule:b",
    );
  });

  it("throws on a stray list item before any key", () => {
    expect(() => parseFrontmatterFields("- rule:x\n", "0001-x")).toThrow(/before any "key:" line/);
  });

  it("throws on an unparseable line", () => {
    expect(() => parseFrontmatterFields("not a key\n", "0001-x")).toThrow(
      /cannot parse frontmatter line/,
    );
  });
});

describe("validateRecord", () => {
  it("accepts a record with every field", () => {
    const record = validateRecord({
      id: "0001-bind",
      frontmatter:
        "id: 0001-bind\nstatus: superseded\nsupersedes:\n  - 0000-old\nbindings:\n  - rule:one\n",
    });
    expect(record).toEqual({
      id: "0001-bind",
      status: "superseded",
      supersedes: ["0000-old"],
      bindings: ["rule:one"],
    });
  });

  it("defaults status to proposed when absent", () => {
    expect(validateRecord({ id: "0001-x", frontmatter: "" }).status).toBe("proposed");
  });

  it("refuses a frontmatter id that disagrees with the filename", () => {
    expect(() => validateRecord({ id: "0001-x", frontmatter: "id: 0002-y\n" })).toThrow(
      /disagrees with the filename/,
    );
  });

  it("refuses an unknown status", () => {
    expect(() => validateRecord({ id: "0001-x", frontmatter: "status: ratified\n" })).toThrow(
      /status "ratified" is not one of/,
    );
  });

  it("refuses an unknown frontmatter key by name", () => {
    expect(() => validateRecord({ id: "0001-x", frontmatter: "statuz: accepted\n" })).toThrow(
      /unknown frontmatter key "statuz"/,
    );
  });

  it("refuses a malformed supersedes entry", () => {
    expect(() => validateRecord({ id: "0001-x", frontmatter: "supersedes:\n  - nope\n" })).toThrow(
      /supersedes entry/,
    );
  });
});

describe("loadAdrRegistry", () => {
  it("returns an empty registry for a workspace with no docs/adr", () => {
    const empty = inMemoryTree({});
    const { records, byId } = loadAdrRegistry("/tmp/x", empty);
    // The in-memory readdir returns nothing, so no adr dir exists.
    expect(records).toEqual([]);
    expect(byId.size).toBe(0);
  });

  it("indexes records deterministically in filename order", () => {
    // Defined out of sorted order to prove byte-sort, not insertion order.
    const extra = inMemoryTree({
      "0002-later.md": "---\nid: 0002-later\n---\n",
      ...Object.fromEntries(VALID),
    });
    const { records } = loadAdrRegistry("/tmp/x", extra);
    expect(records.map((r) => r.id)).toEqual(["0001-bind-collaboration", "0002-later"]);
  });

  it("throws on a filename that is not NNN-slug.md", () => {
    const io = treeWith({ "not-an-adr.md": "" });
    expect(() => loadAdrRegistry("/tmp/x", io)).toThrow(/not a valid ADR filename/);
  });

  it("throws on a malformed record file", () => {
    const io = treeWith({ "0001-bind-collaboration.md": "---\nstatus: bad\n---\n" });
    expect(() => loadAdrRegistry("/tmp/x", io)).toThrow(/status "bad"/);
  });

  it("throws when the registry cannot be read at all (unreadable ≠ empty)", () => {
    const io = {
      readdirSync: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    };
    expect(() => loadAdrRegistry("/tmp/x", io)).toThrow(/cannot read docs\/adr/);
  });
});

describe("supersedes chain", () => {
  it("reads a superseding record's chain back to the record it replaces", () => {
    const io = inMemoryTree({
      ...Object.fromEntries(VALID),
      "0002-bind-logs.md": `---
id: 0002-bind-logs
status: superseded
supersedes:
  - 0001-bind-collaboration
bindings:
  - rule:sticky-logs
---

# Bind logs
`,
    });
    const { records } = loadAdrRegistry("/tmp/x", io);
    const superseding = records.find((r) => r.id === "0002-bind-logs");
    expect(superseding.status).toBe("superseded");
    expect(superseding.supersedes).toEqual(["0001-bind-collaboration"]);
    // The superseded record still parses, still binds what it bound.
    const old = records.find((r) => r.id === "0001-bind-collaboration");
    expect(old.status).toBe("accepted");
    expect(old.bindings).toContain("rule:no-direct-dep");
  });
});

describe("binding and reverse lookup", () => {
  const { records, byId } = loadAdrRegistry("/tmp/x", treeWith({}));

  it("collects the bound rule/fitness ids", () => {
    expect([...boundFitnessIds(records)].sort()).toEqual(["fitness:hotspot", "rule:no-direct-dep"]);
  });

  it("answers which ADRs bind a given id", () => {
    expect(adrsBinding(records, "rule:no-direct-dep")).toEqual(["0001-bind-collaboration"]);
    expect(adrsBinding(records, "rule:missing")).toEqual([]);
  });

  it("resolves an ADR id and a known fitness id, and nothing else", () => {
    const known = boundFitnessIds(records);
    expect(resolveDecisionRef(byId, known, "0001-bind-collaboration")).toBe("adr");
    expect(resolveDecisionRef(byId, known, "rule:no-direct-dep")).toBe("fitness");
    expect(resolveDecisionRef(byId, known, "0000-missing")).toBe("unknown");
    expect(resolveDecisionRef(byId, known, "rule:missing")).toBe("unknown");
  });
});

describe("resolveWithRemote — remote is opt-in and never changes local resolution", () => {
  const { byId } = loadAdrRegistry("/tmp/x", treeWith({}));
  const known = boundFitnessIds(loadAdrRegistry("/tmp/x", treeWith({})).records);

  it("keeps a locally-resolved reference local, with no reference time", () => {
    const result = resolveWithRemote(byId, known, "0001-bind-collaboration", {
      remoteResolve: () => true,
      refTime: () => "2026-08-16T00:00:00Z",
    });
    expect(result).toEqual({ kind: "adr", referenceTime: null });
  });

  it("asks the remote only for an unknown reference and stamps the fetch", () => {
    const seen = [];
    const result = resolveWithRemote(byId, known, "0999-remote", {
      remoteResolve: (ref, stamp) => {
        seen.push([ref, stamp]);
        return true;
      },
      refTime: () => "2026-08-16T00:00:00Z",
    });
    expect(result.kind).toBe("fitness");
    expect(result.referenceTime).toBe("2026-08-16T00:00:00Z");
    expect(seen).toEqual([["0999-remote", "2026-08-16T00:00:00Z"]]);
  });

  it("fails closed when the remote cannot answer — still unknown, never pass", () => {
    const result = resolveWithRemote(byId, known, "0999-remote", {
      remoteResolve: () => false,
      refTime: () => "2026-08-16T00:00:00Z",
    });
    expect(result).toEqual({ kind: "unknown", referenceTime: null });
  });

  it("fails closed when the remote throws", () => {
    const result = resolveWithRemote(byId, known, "0999-remote", {
      remoteResolve: () => {
        throw new Error("network down");
      },
      refTime: () => "2026-08-16T00:00:00Z",
    });
    expect(result).toEqual({ kind: "unknown", referenceTime: null });
  });

  it("returns unknown with no remote configured", () => {
    expect(resolveWithRemote(byId, known, "0999-remote")).toEqual({
      kind: "unknown",
      referenceTime: null,
    });
  });
});

describe("ADR_ID_PATTERN", () => {
  it("accepts three-or-more-digit numbers and rejects fewer", () => {
    expect(ADR_ID_PATTERN.test("0012-api")).toBe(true);
    expect(ADR_ID_PATTERN.test("01-api")).toBe(false);
    expect(ADR_ID_PATTERN.test("12-api")).toBe(false);
  });
});

// P1-21: the registry used to read whatever `.md` files sat in `docs/adr/`
// regardless of git, and never looked at whether a directory entry was a
// symlink. A gitignored scratch file with an ADR-shaped name resolved
// exactly like a real record, and so did a symlink pointing outside the
// workspace — with manual lookup the only thing that would ever have caught
// it. `../architecture-intent/model.mjs`'s `loadIntent` already refuses an
// untracked `architecture-intent.json`; these cases hold `loadAdrRegistry` to
// the identical discipline.
describe("tracked-only registry (P1-21)", () => {
  it("keeps every entry when `tracked` is not supplied — existing callers unchanged", () => {
    const io = treeWith({ "0099-untracked.md": "---\nstatus: accepted\n---\n" });
    const { byId } = loadAdrRegistry("/tmp/x", io);
    expect(byId.has("0099-untracked")).toBe(true);
  });

  it("excludes a directory entry the tracked tree does not know about", () => {
    // A gitignored scratch file sitting right beside a real, tracked record.
    const io = treeWith({ "0099-untracked.md": "---\nstatus: accepted\n---\n" });
    const { records, byId } = loadAdrRegistry("/tmp/x", {
      ...io,
      // Only the VALID fixture's own path is tracked — 0099 is invisible to
      // git, exactly as a `.gitignore`d file would be. Built from `ADR_DIR`
      // rather than spelled whole, the same reason `cli.integration.test.mjs`'s
      // ADR fixture does — a literal `docs/adr/<id>.md` here would read to
      // `check-docs-links` as this file citing a decision record in THIS
      // repository, on a path that resolves nowhere.
      tracked: [`${ADR_DIR}/0001-bind-collaboration.md`],
    });
    expect(byId.has("0099-untracked")).toBe(false);
    expect(records.map((r) => r.id)).toEqual(["0001-bind-collaboration"]);
    // The invariant end to end: a decisionRef naming the untracked file
    // resolves unknown — the same answer a name nobody ever wrote gets, never
    // `adr`, no matter how closely a planted file's id matches.
    expect(resolveDecisionRef(byId, boundFitnessIds(records), "0099-untracked")).toBe("unknown");
  });

  it("never validates an untracked file's shape — a malformed one is excluded, not a load error", () => {
    // Silence here is the honest answer (this module's header): an untracked
    // file is treated as though it were never there at all, so it must not
    // even reach `validateRecord` — a malformed untracked file must not turn
    // "no such record" into "cannot read the registry" for every OTHER record
    // beside it.
    const io = treeWith({ "0099-untracked.md": "---\nstatus: not-a-real-status\n---\n" });
    expect(() =>
      loadAdrRegistry("/tmp/x", { ...io, tracked: [`${ADR_DIR}/0001-bind-collaboration.md`] }),
    ).not.toThrow();
  });
});

describe("symlink escape (P1-21) — real filesystem", () => {
  let root;
  let outside;

  beforeAll(() => {
    // `realpathSync` because a temp directory may itself be handed out
    // through a symlink (macOS `/tmp`), and the containment check this guards
    // compares real, canonical paths — `entry-point.test.mjs` and
    // `lsp.integration.test.mjs` take the identical precaution for the
    // identical reason.
    root = realpathSync(mkdtempSync(join(tmpdir(), "lattice-adr-registry-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "lattice-adr-registry-outside-")));
    mkdirSync(join(root, ADR_DIR), { recursive: true });
    // The external, attacker-controlled file: shaped exactly like a valid
    // ADR, sitting entirely outside `root`.
    writeFileSync(join(outside, "0099-planted.md"), "---\nstatus: accepted\n---\n");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("excludes a tracked-named file whose bytes are a symlink resolving outside the workspace", () => {
    // The tracked-name filter alone cannot catch this: `git ls-files` reports
    // paths, never modes, so a symlink committed at this path — or one
    // swapped in locally after the tracked-name check ran — passes it by name
    // alone. Only reading the file itself, past the symlink, tells the two
    // apart, the read-side twin of the write-side guard
    // `../../cli.mjs`'s `writeOutputReport` documents (P0-03).
    const escaping = join(root, ADR_DIR, "0099-planted.md");
    symlinkSync(join(outside, "0099-planted.md"), escaping);
    try {
      const { records, byId } = loadAdrRegistry(root, {
        tracked: [`${ADR_DIR}/0099-planted.md`],
      });
      expect(byId.has("0099-planted")).toBe(false);
      expect(records).toEqual([]);
      expect(resolveDecisionRef(byId, boundFitnessIds(records), "0099-planted")).toBe("unknown");
    } finally {
      rmSync(escaping);
    }
  });

  it("still reads a real, in-workspace record normally", () => {
    // The guard is specific to an escaping symlink, not to the directory in
    // general — a genuine tracked record still loads even while the escaping
    // symlink case above is exercised in the same suite.
    const real = join(root, ADR_DIR, "0001-real.md");
    writeFileSync(real, "---\nstatus: accepted\n---\n");
    try {
      const { records } = loadAdrRegistry(root, { tracked: [`${ADR_DIR}/0001-real.md`] });
      expect(records.map((r) => r.id)).toEqual(["0001-real"]);
    } finally {
      rmSync(real);
    }
  });

  it("still resolves a symlink whose target stays inside the workspace", () => {
    // Not every symlink is a threat — one resolving to another tracked file
    // INSIDE the tree is unremarkable and must keep working.
    const inside = join(root, ADR_DIR, "0002-inside-target.md");
    writeFileSync(inside, "---\nstatus: accepted\n---\n");
    const link = join(root, ADR_DIR, "0003-inside-link.md");
    symlinkSync(inside, link);
    try {
      const { records } = loadAdrRegistry(root, {
        tracked: [`${ADR_DIR}/0002-inside-target.md`, `${ADR_DIR}/0003-inside-link.md`],
      });
      expect(records.map((r) => r.id).sort()).toEqual(["0002-inside-target", "0003-inside-link"]);
    } finally {
      rmSync(link);
      rmSync(inside);
    }
  });

  it("excludes a dangling symlink the same way an unreadable file already throws", () => {
    // Not this fix's threat model (the bytes were never reachable either way),
    // but it must not regress: a dangling symlink still fails the read with
    // ENOENT, which the existing "cannot read" branch turns into the same
    // loud error it always has.
    const dangling = join(root, ADR_DIR, "0004-dangling.md");
    symlinkSync(join(root, ADR_DIR, "nowhere.md"), dangling);
    try {
      expect(() => loadAdrRegistry(root, { tracked: [`${ADR_DIR}/0004-dangling.md`] })).toThrow(
        /cannot read docs\/adr/,
      );
    } finally {
      rmSync(dangling);
    }
  });
});

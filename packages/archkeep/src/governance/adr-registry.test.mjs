import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ADR_DIR,
  ADR_ID_PATTERN,
  ADR_STATUSES,
  adrsBinding,
  boundFitnessIds,
  declaredFitnessNames,
  hasAuthority,
  loadAdrRegistry,
  parseFrontmatterFields,
  resolveDecisionRef,
  stripAdrPrefix,
  unresolvedDecisionRefRows,
  validateLineage,
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

  // P1-22: a repeated key used to hit the plain `fields[key] = …` write twice
  // and the second write won silently — no error, no warning, the first
  // occurrence just gone. That is exactly the "silently dropped" line this
  // function's own header says the strict dialect must never allow.
  describe("duplicate key (P1-22) — a repeat must never silently overwrite", () => {
    it("throws on a duplicate scalar key, instead of letting the second value win", () => {
      expect(() =>
        parseFrontmatterFields("status: proposed\nstatus: accepted\n", "0001-x"),
      ).toThrow(/duplicate frontmatter key "status"/);
    });

    it("throws on a duplicate list key, instead of discarding the first list", () => {
      expect(() =>
        parseFrontmatterFields("bindings:\n  - rule:one\nbindings:\n  - rule:two\n", "0001-x"),
      ).toThrow(/duplicate frontmatter key "bindings"/);
    });

    it("throws on the second of three repeats, naming the key — not just any later line", () => {
      expect(() =>
        parseFrontmatterFields("id: 0001-x\nid: 0002-x\nid: 0003-x\n", "0001-x"),
      ).toThrow(/duplicate frontmatter key "id"/);
    });
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

  it("reads the real fs's ENOENT for a missing docs/adr as an empty registry too", () => {
    // The test above drives an in-memory readdir that answers an absent
    // directory with an EMPTY LISTING — the real `readdirSync` answers it by
    // throwing ENOENT, and only the loader's ENOENT branch turns that throw
    // into the same empty-registry verdict. Pinning the throw itself is what
    // keeps that branch honest: if it stopped matching (or was removed), the
    // in-memory listing above would still pass while every real workspace
    // with no docs/adr started failing with `cannot read docs/adr` — absence
    // is the documented answer, and this is the test that says so.
    const io = {
      readdirSync: () => {
        throw Object.assign(
          new Error("ENOENT: no such file or directory, scandir '/tmp/x/docs/adr'"),
          {
            code: "ENOENT",
          },
        );
      },
    };
    const { records, byId } = loadAdrRegistry("/tmp/x", io);
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

  // The silent direction of the same check. An `.endsWith(".md")` pre-filter
  // ran BEFORE the `ADR_FILE_PATTERN` throw above, so an ADR-shaped record
  // whose extension missed by a case or a spelling was dropped without a word:
  // no record, no id claimed, no error. `resolveDecisionRef` then answered
  // `unknown` for an id sitting in the tree, and the reverse lookup answered
  // "no ADR in docs/adr/ binds rule:X — it is not enforced by any recorded
  // decision" about a binding the loader had simply refused to look at — the
  // same sentence a genuinely unbound rule gets. Two filters deciding the same
  // question is how one goes quiet: the pattern above is now the only one.
  it.each([
    ["0002-cased.MD", "an uppercase extension"],
    ["0003-thing.markdown", "a .markdown extension"],
    ["0004-thing.md.bak", "an editor backup suffix"],
  ])("refuses %s (%s) by name instead of dropping it before the check", (name) => {
    const io = treeWith({ [name]: "---\nstatus: accepted\n---\n" });
    // A returned registry — of ANY shape — is the defect: it is a registry
    // that silently does not contain a file its own directory holds.
    expect(() => loadAdrRegistry("/tmp/x", io)).toThrow(/not a valid ADR filename/);
  });

  it("still excludes an untracked entry silently, whatever its name", () => {
    // The one exclusion that stays quiet, and the guard that the refusal above
    // did not swallow it: `tracked` answers "are these the reviewed bytes",
    // a different question from "is this a record", and a gitignored scratch
    // file with any name at all is excluded exactly as if it were never there.
    const io = treeWith({ "scratch.txt": "", "0009-draft.markdown": "" });
    const { records } = loadAdrRegistry("/tmp/x", {
      ...io,
      tracked: ["docs/adr/0001-bind-collaboration.md"],
    });
    expect(records.map((r) => r.id)).toEqual(["0001-bind-collaboration"]);
  });

  it("throws on a malformed record file", () => {
    const io = treeWith({ "0001-bind-collaboration.md": "---\nstatus: bad\n---\n" });
    expect(() => loadAdrRegistry("/tmp/x", io)).toThrow(/status "bad"/);
  });

  // P1-22: end to end, a duplicate key must fail the whole registry load the
  // same way any other malformed record does — never a record read from the
  // last-value-wins guess. Both consumers of `loadAdrRegistry` (`resolveDecisionRef`
  // via `byId`, and `archkeep adr`'s report via `records`) sit downstream of this
  // one load, so a loud throw here is what keeps a duplicated `status`/`bindings`
  // from ever reaching either as a quietly-flipped verdict.
  it("throws on a record whose frontmatter repeats a key, rather than reading the last value (P1-22)", () => {
    const io = treeWith({
      "0001-bind-collaboration.md":
        "---\nid: 0001-bind-collaboration\nstatus: proposed\nstatus: accepted\n---\n",
    });
    expect(() => loadAdrRegistry("/tmp/x", io)).toThrow(/duplicate frontmatter key "status"/);
  });

  it("throws when the registry cannot be read at all (unreadable ≠ empty)", () => {
    const io = {
      readdirSync: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    };
    expect(() => loadAdrRegistry("/tmp/x", io)).toThrow(/cannot read docs\/adr/);
  });

  // The containment-probe gate is filesystem I/O like any other: before this
  // test, `existsSync` read the real disk even when every other seam was
  // injected — an in-memory tree that recorded its own calls would never see
  // the probe. Counting proves the injected one is the one that ran.
  it("routes the containment-probe existsSync through the injected io, not the real fs", () => {
    let probeCalls = 0;
    const io = {
      ...inMemoryTree(Object.fromEntries(VALID)),
      existsSync: () => {
        probeCalls++;
        return false;
      },
    };
    const { records } = loadAdrRegistry("/tmp/x", io);
    expect(records.map((r) => r.id)).toEqual(["0001-bind-collaboration"]);
    expect(probeCalls).toBe(records.length);
  });
});

describe("supersedes chain", () => {
  it("reads a superseding record's chain back to the record it replaces", () => {
    const io = inMemoryTree({
      "0001-bind-collaboration.md": `---
id: 0001-bind-collaboration
status: superseded
bindings:
  - rule:no-direct-dep
  - fitness:hotspot
---

# Bind collaboration
`,
      "0002-bind-logs.md": `---
id: 0002-bind-logs
status: active
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
    expect(superseding.status).toBe("active");
    expect(superseding.supersedes).toEqual(["0001-bind-collaboration"]);
    expect(superseding.supersededBy).toEqual([]);
    // The replaced record keeps its parsed content and gains the derived link.
    const old = records.find((r) => r.id === "0001-bind-collaboration");
    expect(old.status).toBe("superseded");
    expect(old.bindings).toContain("rule:no-direct-dep");
    expect(old.supersededBy).toEqual(["0002-bind-logs"]);
  });
});

describe("statuses and authority (wave 2)", () => {
  it("carries exactly the five lifecycle statuses", () => {
    expect(ADR_STATUSES).toEqual(["proposed", "accepted", "active", "superseded", "retired"]);
  });

  it("gives authority to active and accepted only", () => {
    expect(hasAuthority("active")).toBe(true);
    expect(hasAuthority("accepted")).toBe(true);
    expect(hasAuthority("proposed")).toBe(false);
    expect(hasAuthority("superseded")).toBe(false);
    expect(hasAuthority("retired")).toBe(false);
  });

  it("loads active and retired records as legal statuses", () => {
    const io = treeWith({
      "0002-active.md": "---\nid: 0002-active\nstatus: active\n---\n",
      "0003-retired.md": "---\nid: 0003-retired\nstatus: retired\n---\n",
    });
    const { records } = loadAdrRegistry("/tmp/x", io);
    expect(records.find((r) => r.id === "0002-active").status).toBe("active");
    expect(records.find((r) => r.id === "0003-retired").status).toBe("retired");
  });

  it("still refuses a status outside the five", () => {
    expect(() => validateRecord({ id: "0001-x", frontmatter: "status: launched\n" })).toThrow(
      /status "launched" is not one of proposed, accepted, active, superseded, retired/,
    );
  });
});

describe("prose fields (wave 2)", () => {
  const record = validateRecord({
    id: "0001-bind-collaboration",
    frontmatter: "id: 0001-bind-collaboration\nstatus: accepted\n",
    body: `## Context

The bind rule needs a home.

## Decision

We chose the registry form.

### Why

Because it is one contract.

## Alternatives

We considered dropping bindings.

## Consequences

The registry carries the load.

## Assumptions

Records stay markdown.
`,
  });

  it("surfaces each documented prose field from its ## heading", () => {
    expect(record.context).toBe("The bind rule needs a home.");
    expect(record.decision).toBe(
      "We chose the registry form.\n\n### Why\n\nBecause it is one contract.",
    );
    expect(record.alternatives).toBe("We considered dropping bindings.");
    expect(record.consequences).toBe("The registry carries the load.");
    expect(record.assumptions).toBe("Records stay markdown.");
    // An absent heading is an absent field, never an empty one.
    expect(record.rationale).toBeUndefined();
  });

  it("maps ## Refused alternatives to the same alternatives field", () => {
    const refused = validateRecord({
      id: "0003-x",
      frontmatter: null,
      body: "## Refused alternatives\n\nWe refused the flat file.\n",
    });
    expect(refused.alternatives).toBe("We refused the flat file.");
    expect(refused.context).toBeUndefined();
  });

  it("closes the open field at the next ## heading, and ## Status opens nothing", () => {
    const withStatus = validateRecord({
      id: "0004-x",
      frontmatter: null,
      body: `## Context

Before.

## Status

Accepted, since forever.

## Consequences

After.
`,
    });
    expect(withStatus.context).toBe("Before.");
    expect(withStatus.consequences).toBe("After.");
  });

  it("never throws on a body that is only prose or has no recognized heading", () => {
    for (const body of [
      "",
      "just prose, no headings at all",
      "## A heading we do not track\n\nSlack text.\n",
    ]) {
      expect(() => validateRecord({ id: "0005-x", frontmatter: null, body })).not.toThrow();
    }
  });

  it("keeps the last occurrence of a repeated heading", () => {
    const repeated = validateRecord({
      id: "0006-x",
      frontmatter: null,
      body: "## Context\n\nFirst.\n\n## Context\n\nLast.\n",
    });
    expect(repeated.context).toBe("Last.");
  });
});

describe("created / updated (wave 2)", () => {
  it("parses both string fields and keeps them off the record when absent", () => {
    const withMeta = validateRecord({
      id: "0001-x",
      frontmatter: "created: 2026-01-02\nupdated: 2026-03-04\n",
    });
    expect(withMeta.created).toBe("2026-01-02");
    expect(withMeta.updated).toBe("2026-03-04");

    const without = validateRecord({ id: "0002-x", frontmatter: "status: accepted\n" });
    expect(without.created).toBeUndefined();
    expect(without.updated).toBeUndefined();
  });

  it("refuses a non-string form loudly — the timeline is committed bytes, never generated", () => {
    expect(() =>
      validateRecord({ id: "0001-x", frontmatter: "created:\n  - 2026-01-02\n" }),
    ).toThrow(/0001-x: created must be a single string value/);
  });
});

describe("lineage validation (wave 2)", () => {
  const load = (files) =>
    loadAdrRegistry("/tmp/x", inMemoryTree({ ...Object.fromEntries(VALID), ...files }));

  it("refuses a supersedes target that is not a record — the chain renders as fact or not at all", () => {
    expect(() =>
      load({
        "0002-active.md":
          "---\nid: 0002-active\nstatus: active\nsupersedes:\n  - 0999-ghost\n---\n",
      }),
    ).toThrow(/0002-active supersedes 0999-ghost, which is not an ADR in docs\/adr/);
  });

  it("refuses a record superseding itself", () => {
    expect(() =>
      load({
        "0002-active.md":
          "---\nid: 0002-active\nstatus: active\nsupersedes:\n  - 0002-active\n---\n",
      }),
    ).toThrow(/0002-active supersedes itself/);
  });

  it("refuses a cycle, naming the chain — every member retired so no other rule trips", () => {
    expect(() =>
      load({
        "0002-a.md": "---\nid: 0002-a\nstatus: retired\nsupersedes:\n  - 0003-b\n---\n",
        "0003-b.md": "---\nid: 0003-b\nstatus: retired\nsupersedes:\n  - 0004-c\n---\n",
        "0004-c.md": "---\nid: 0004-c\nstatus: retired\nsupersedes:\n  - 0002-a\n---\n",
      }),
    ).toThrow(/supersedes cycle: 0002-a -> 0003-b -> 0004-c -> 0002-a/);
  });

  it("refuses a superseded record with no successor (dangling) — retired needs none", () => {
    expect(() =>
      load({
        "0002-abandoned.md": "---\nid: 0002-abandoned\nstatus: superseded\n---\n",
      }),
    ).toThrow(/0002-abandoned is superseded but nothing supersedes it/);
  });

  it("refuses a successor without authority — proposed may not replace another; the retired target keeps this the only violation", () => {
    expect(() =>
      load({
        "0002-draft.md":
          "---\nid: 0002-draft\nstatus: proposed\nsupersedes:\n  - 0003-retired\n---\n",
        "0003-retired.md": "---\nid: 0003-retired\nstatus: retired\n---\n",
      }),
    ).toThrow(/0002-draft is proposed and supersedes 0003-retired — only a record with authority/);
  });

  it("the old superseded-successor shape reports every violation at once", () => {
    expect(() =>
      load({
        "0002-bind-logs.md": `---
id: 0002-bind-logs
status: superseded
supersedes:
  - 0001-bind-collaboration
bindings:
  - rule:sticky-logs
---
`,
      }),
    ).toThrow(
      /0002-bind-logs is superseded and supersedes 0001-bind-collaboration[\s\S]*0001-bind-collaboration is accepted but superseded by \[0002-bind-logs\][\s\S]*0002-bind-logs is superseded but nothing supersedes it/,
    );
  });

  it("refuses an active record superseded by another — the contradiction rule", () => {
    expect(() =>
      load({
        "0002-active.md":
          "---\nid: 0002-active\nstatus: active\nsupersedes:\n  - 0001-bind-collaboration\n---\n",
      }),
    ).toThrow(/0001-bind-collaboration is accepted but superseded by \[0002-active\]/);
  });

  it("refuses the contradiction for accepted targets too", () => {
    expect(() =>
      load({
        "0002-superseding.md":
          "---\nid: 0002-superseding\nstatus: accepted\nsupersedes:\n  - 0001-bind-collaboration\n---\n",
      }),
    ).toThrow(/0001-bind-collaboration is accepted but superseded by \[0002-superseding\]/);
  });

  it("allows more than one successor, each with authority", () => {
    const io = inMemoryTree({
      "0001-bind-collaboration.md": `---
id: 0001-bind-collaboration
status: superseded
bindings:
  - rule:no-direct-dep
---
`,
      "0002-b.md":
        "---\nid: 0002-b\nstatus: active\nsupersedes:\n  - 0001-bind-collaboration\n---\n",
      "0003-c.md":
        "---\nid: 0003-c\nstatus: accepted\nsupersedes:\n  - 0001-bind-collaboration\n---\n",
    });
    const { byId } = loadAdrRegistry("/tmp/x", io);
    expect(byId.get("0001-bind-collaboration").supersededBy).toEqual(["0002-b", "0003-c"]);
  });

  it("exports validateLineage for direct use, attaching supersededBy in place", () => {
    const replaced = { id: "0001-old", status: "superseded", supersedes: [] };
    const successor = { id: "0002-new", status: "active", supersedes: ["0001-old"] };
    const out = validateLineage([replaced, successor]);
    expect(out).toStrictEqual([replaced, successor]);
    expect(replaced.supersededBy).toEqual(["0002-new"]);
    expect(successor.supersededBy).toEqual([]);
  });
});

describe("backward compatibility — the repository's own registry (wave 2)", () => {
  it("loads every existing record with its pre-existing fields unchanged", () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const { records } = loadAdrRegistry(root);
    expect(records.map((r) => r.id)).toEqual([
      "0001-boundary-levels",
      "0002-custom-rules-one-contract",
      "0003-rename-lattice-to-archkeep",
      "0004-correct-old-name-deprecation-mechanics",
      "0005-jvm-language-integration",
      "0006-dotnet-language-integration",
      "0007-no-semantic-model-expansion",
      "0008-snapshot-identity-per-family",
    ]);
    for (const record of records) {
      expect(record.status).toBe("accepted");
      expect(record.supersedes).toEqual([]);
      expect(record.supersededBy).toEqual([]);
      expect(record.created).toBeUndefined();
      expect(record.updated).toBeUndefined();
    }
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

  it("resolves an ADR id and a declared fitness id, and nothing else", () => {
    // F04: resolution is judged against the ids the policy DECLARES
    // (`declaredFitnessNames`), never against the ADRs' own `bindings` — the
    // fixture's bindings (`rule:no-direct-dep`, `fitness:hotspot`) are registry
    // facts, not declarations, so they must appear in `known` to resolve.
    const known = new Set(["no-direct-dep", "hotspot", "declared-only"]);
    expect(resolveDecisionRef(byId, known, "0001-bind-collaboration")).toBe("adr");
    expect(resolveDecisionRef(byId, known, "rule:no-direct-dep")).toBe("fitness");
    expect(resolveDecisionRef(byId, known, "0000-missing")).toBe("unknown");
    expect(resolveDecisionRef(byId, known, "rule:missing")).toBe("unknown");
  });

  it("is unknown when a binding names no declared fitness — a citation cannot resolve itself (F04)", () => {
    // The audit's exact reproduction: ADR frontmatter binds `hotspot`, but no
    // policy declares a fitness function named `hotspot`. The citation must
    // read unknown, never `fitness` — bound-by-itself is the silent direction.
    const known = new Set(); // no declared fitness anywhere
    expect(resolveDecisionRef(byId, known, "hotspot")).toBe("unknown");
    expect(resolveDecisionRef(byId, known, "fitness:hotspot")).toBe("unknown");
    expect(resolveDecisionRef(byId, known, "rule:no-direct-dep")).toBe("unknown");
  });

  it("resolves a bare declared fitness id and its `fitness:`/`rule:`-prefixed spelling alike", () => {
    const known = new Set(["hotspot"]);
    expect(resolveDecisionRef(byId, known, "hotspot")).toBe("fitness");
    expect(resolveDecisionRef(byId, known, "fitness:hotspot")).toBe("fitness");
    expect(resolveDecisionRef(byId, known, "rule:hotspot")).toBe("fitness");
  });

  // P1-23: `../governance/row-schema.mjs`'s decisionRef docs recommend
  // `adr:0012` as a valid ADR-id spelling beside the bare `0012-slug` form,
  // but `byId` is keyed on the bare form alone — a lookup that checked `ref`
  // verbatim could never match the one spelling this tool itself suggests.
  it("resolves the `adr:`-prefixed spelling to the same record as the bare id", () => {
    const known = new Set(["hotspot", "no-direct-dep"]);
    expect(resolveDecisionRef(byId, known, "adr:0001-bind-collaboration")).toBe("adr");
    // A prefix on an id that genuinely does not exist still resolves unknown
    // — stripping the prefix must not turn a real miss into a false match.
    expect(resolveDecisionRef(byId, known, "adr:0000-missing")).toBe("unknown");
    // Only the exact, documented lowercase prefix is an alias; a differently
    // cased one is a near-miss like any other, not a fuzzy match.
    expect(resolveDecisionRef(byId, known, "ADR:0001-bind-collaboration")).toBe("unknown");
  });
});

describe("stripAdrPrefix", () => {
  it("strips exactly the documented lowercase adr: prefix", () => {
    expect(stripAdrPrefix("adr:0001-bind-collaboration")).toBe("0001-bind-collaboration");
  });

  it("leaves a ref with no adr: prefix unchanged", () => {
    expect(stripAdrPrefix("0001-bind-collaboration")).toBe("0001-bind-collaboration");
  });

  it("leaves a differently-cased prefix unchanged — no fuzzy matching", () => {
    expect(stripAdrPrefix("ADR:0001-bind-collaboration")).toBe("ADR:0001-bind-collaboration");
  });
});

describe("declaredFitnessNames", () => {
  it("collects the name field off each well-formed row", () => {
    expect(declaredFitnessNames({ fitness: [{ name: "hotspot" }, { name: "coverage" }] })).toEqual(
      new Set(["hotspot", "coverage"]),
    );
  });

  it("is empty when the module has no fitness export", () => {
    expect(declaredFitnessNames({})).toEqual(new Set());
    expect(declaredFitnessNames(null)).toEqual(new Set());
    expect(declaredFitnessNames(undefined)).toEqual(new Set());
  });

  // `config.mjs`'s `findBoundaryConfigViolations` calls this to build its
  // default `io.resolve` BEFORE `findFitnessViolations` validates the
  // `fitness` shape (F05) — so a malformed `fitness` export must not throw
  // here. The proper named violation is `findFitnessViolations`' job; this
  // function only has to survive the shape so that call is reached.
  it("does not throw on a non-array fitness export — returns no declared names", () => {
    expect(declaredFitnessNames({ fitness: {} })).toEqual(new Set());
    expect(declaredFitnessNames({ fitness: "x" })).toEqual(new Set());
  });

  it("does not throw on a fitness list holding a non-object row", () => {
    expect(declaredFitnessNames({ fitness: [null] })).toEqual(new Set());
    expect(declaredFitnessNames({ fitness: ["not-an-object"] })).toEqual(new Set());
  });

  it("skips a row with no usable name rather than throwing", () => {
    expect(declaredFitnessNames({ fitness: [{ name: "ok" }, { name: 5 }, {}] })).toEqual(
      new Set(["ok"]),
    );
  });
});

// P1-02: `resolveDecisionRef` had zero production call sites — every row
// owner (`config.mjs`, `architecture-intent/model.mjs`) called
// `rowSchemaViolations` with no `io.resolve`, and every report that renders a
// `decisionRef` (`check`, `context`, `drift`, `provenance`) quoted it
// verbatim, unverified. `unresolvedDecisionRefRows` is the bulk primitive
// those reporting paths now call.
describe("unresolvedDecisionRefRows — the bulk form the reporting paths call", () => {
  const { byId } = loadAdrRegistry("/tmp/x", treeWith({}));
  // F04: the resolution set is the DECLARED fitness ids, not the fixture's
  // ADR bindings — `rule:no-direct-dep` only resolves because `no-direct-dep`
  // is declared below.
  const known = new Set(["no-direct-dep"]);

  it("is empty when every citation resolves — 'no fact, no claim'", () => {
    const rows = [
      { kind: "depConstraints[0]", row: { decisionRef: "0001-bind-collaboration" } },
      { kind: "forbidden[0]", row: { decisionRef: "rule:no-direct-dep" } },
    ];
    expect(unresolvedDecisionRefRows(rows, byId, known)).toEqual([]);
  });

  it("names the row and the unresolvable reference — the silent direction this fixes", () => {
    // The audit's own reproduction: a decisionRef naming a completely
    // nonexistent ADR id must not pass through unverified.
    const rows = [{ kind: "depConstraints[0]", row: { decisionRef: "9999-does-not-exist" } }];
    expect(unresolvedDecisionRefRows(rows, byId, known)).toEqual([
      { kind: "depConstraints[0]", row: rows[0].row, decisionRef: "9999-does-not-exist" },
    ]);
  });

  it("skips a row with no decisionRef at all", () => {
    const rows = [{ kind: "allowed[0]", row: { from: "a", to: "b" } }];
    expect(unresolvedDecisionRefRows(rows, byId, known)).toEqual([]);
  });

  it("skips a row whose decisionRef is empty or non-string — a shape error, not a resolution question", () => {
    const rows = [
      { kind: "allowed[0]", row: { decisionRef: "" } },
      { kind: "allowed[1]", row: { decisionRef: "   " } },
      { kind: "allowed[2]", row: { decisionRef: 42 } },
    ];
    expect(unresolvedDecisionRefRows(rows, byId, known)).toEqual([]);
  });

  it("reports one entry per unresolved row, preserving row order", () => {
    const rows = [
      { kind: "allowed[0]", row: { decisionRef: "0001-bind-collaboration" } },
      { kind: "forbidden[0]", row: { decisionRef: "0000-missing" } },
      { kind: "forbidden[1]", row: { decisionRef: "rule:also-missing" } },
    ];
    expect(unresolvedDecisionRefRows(rows, byId, known).map((r) => r.kind)).toEqual([
      "forbidden[0]",
      "forbidden[1]",
    ]);
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
    root = realpathSync(mkdtempSync(join(tmpdir(), "archkeep-adr-registry-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "archkeep-adr-registry-outside-")));
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

// G-10 (intermediate component): the escaping-file tests above plant the
// symlink at the FINAL component. A symlinked `docs/adr/` DIRECTORY — planted
// one level up, with every entry string still tracked inside the tree — passes
// a guard that only lstat's the final file (the local `escapesWorkspace` that
// `../containment.mjs`'s `containmentViolation` replaced did exactly that):
// `readdirSync` follows the directory symlink and hands back the target's
// entries, each one validated and indexed as the workspace's own decision.
// Only realpath of the full path walks the intermediate component.
describe("symlinked docs/adr directory (G-10) — real filesystem", () => {
  let root;
  let outside;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "archkeep-adr-registry-intermediate-")));
    outside = realpathSync(
      mkdtempSync(join(tmpdir(), "archkeep-adr-registry-intermediate-outside-")),
    );
    mkdirSync(join(root, "docs"), { recursive: true });
    // The external `docs/adr/`: a well-formed record the bytes of this
    // workspace never committed. Without the intermediate walk both entries
    // below would read and index as the workspace's own decisions.
    mkdirSync(join(outside, "docs", "adr"), { recursive: true });
    writeFileSync(join(outside, "docs", "adr", "0099-planted.md"), "---\nstatus: accepted\n---\n");
    writeFileSync(join(outside, "docs", "adr", "0001-real.md"), "---\nstatus: accepted\n---\n");
    symlinkSync(join(outside, "docs", "adr"), join(root, "docs", "adr"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("excludes every entry whose docs/adr directory is a symlink resolving outside the workspace", () => {
    const { records, byId } = loadAdrRegistry(root, {
      // Each name is TRACKED as a string — the directory's symlink is invisible
      // to `git ls-files`, which reports paths, never modes.
      tracked: [`${ADR_DIR}/0099-planted.md`, `${ADR_DIR}/0001-real.md`],
    });
    expect(records).toEqual([]);
    expect(byId.has("0099-planted")).toBe(false);
    expect(byId.has("0001-real")).toBe(false);
    expect(resolveDecisionRef(byId, boundFitnessIds(records), "0001-real")).toBe("unknown");
    expect(resolveDecisionRef(byId, boundFitnessIds(records), "0099-planted")).toBe("unknown");
  });
});

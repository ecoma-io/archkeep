import { describe, expect, it } from "vitest";

import { isValidSelector, resolveMembers, selectProjects, splitSelector } from "./selectors.mjs";

const core = { name: "core", data: { root: "packages/core", tags: ["type-package"] } };
const ui = { name: "ui", data: { root: "packages/ui", tags: ["type-package"] } };
const web = { name: "web", data: { root: "apps/web", tags: ["type-extension"] } };
const NODES = { core, ui, web };

describe("splitSelector", () => {
  it("parses a labeled selector into label and value", () => {
    expect(splitSelector("tag:type-package")).toEqual({
      exclude: false,
      label: "tag",
      value: "type-package",
    });
  });

  it("parses an unlabeled selector as a bare project name", () => {
    expect(splitSelector("core")).toEqual({ exclude: false, label: null, value: "core" });
  });

  it("carries the '!' exclusion prefix separately from the body", () => {
    expect(splitSelector("!tag:x")).toEqual({ exclude: true, label: "tag", value: "x" });
    expect(splitSelector("!core")).toEqual({ exclude: true, label: null, value: "core" });
  });

  it("keeps '*' as a bare value with no label", () => {
    expect(splitSelector("*")).toEqual({ exclude: false, label: null, value: "*" });
  });
});

describe("isValidSelector", () => {
  it("accepts the four selector forms plus a bare project name", () => {
    for (const ok of ["name:core", "tag:type-package", "directory:packages/core", "*", "core"]) {
      expect(isValidSelector(ok), ok).toBe(true);
    }
  });

  it("accepts an exclusion-prefixed selector", () => {
    expect(isValidSelector("!tag:type-package")).toBe(true);
    expect(isValidSelector("!core")).toBe(true);
  });

  it("rejects an unknown selector label by name — the scop:core typo case", () => {
    expect(isValidSelector("scop:core")).toBe(false);
    expect(isValidSelector("tagz:type-package")).toBe(false);
  });

  it("rejects an empty value and a non-string", () => {
    expect(isValidSelector("tag:")).toBe(false);
    expect(isValidSelector("")).toBe(false);
    expect(isValidSelector(42)).toBe(false);
  });

  it("rejects empty after the '!' prefix", () => {
    expect(isValidSelector("!")).toBe(false);
  });
});

describe("selectProjects", () => {
  it("matches a project by exact name — the F1 case: no substring, no case folding", () => {
    // A `domain` selector must NOT match `platform-domain`. This is the whole
    // reason intent owns its own engine and not findMatchingProjects.
    const nodes = {
      domain: core,
      "platform-domain": ui,
    };
    expect(selectProjects("domain", nodes)).toEqual(["domain"]);
  });

  it("matches by tag exactly", () => {
    expect(selectProjects("tag:type-package", NODES)).toEqual(["core", "ui"]);
  });

  it("matches by directory root exactly", () => {
    expect(selectProjects("directory:packages/ui", NODES)).toEqual(["ui"]);
  });

  it("treats unlabeled and name: identically — exact name", () => {
    expect(selectProjects("core", NODES)).toEqual(["core"]);
    expect(selectProjects("name:core", NODES)).toEqual(["core"]);
  });

  it("is '*' for every node", () => {
    expect(selectProjects("*", NODES)).toEqual(["core", "ui", "web"]);
  });

  it("returns a fresh sorted array every call", () => {
    const a = selectProjects("*", NODES);
    const b = selectProjects("*", NODES);
    expect(a).not.toBe(b);
    expect(a).toEqual(["core", "ui", "web"]);
  });

  it("returns the empty list for a name that matches nothing — never a substring hit", () => {
    expect(selectProjects("plat", NODES)).toEqual([]);
  });

  it("ignores a tag a project does not carry", () => {
    expect(selectProjects("tag:scope-nx", NODES)).toEqual([]);
  });

  // Every name below is a member of `Object.prototype`, and `NODES` is a plain
  // object literal, so `nodes[value]` answered all five from the prototype:
  // measured before the fix, `selectProjects("constructor", NODES)` returned
  // `["constructor"]` on a graph containing no such project — as did
  // `"toString"`, `"valueOf"`, `"hasOwnProperty"` and `"__proto__"` — while
  // `"nosuch"` correctly returned `[]`. The consequence is the silent one: a
  // boundary `{"match": ["constructor"]}` resolved to one phantom member, so
  // `./judge.mjs`'s zero-member no-verdict never fired, `intentUnresolved`
  // stayed 0, and `check` exited 0 where its contract owes 3. A selector that
  // names nothing must be indistinguishable from `"nosuch"`.
  const PROTOTYPE_MEMBERS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

  it("treats a prototype member name as an absent project, exactly like any other miss", () => {
    for (const name of PROTOTYPE_MEMBERS) {
      expect(selectProjects(name, NODES), name).toEqual([]);
      expect(selectProjects(`name:${name}`, NODES), `name:${name}`).toEqual([]);
      expect(selectProjects(`!${name}`, NODES), `!${name}`).toEqual([]);
    }
    // The control: the same call shape on a name that really is absent.
    expect(selectProjects("nosuch", NODES)).toEqual([]);
  });

  it("still selects a project genuinely NAMED like a prototype member", () => {
    // The near miss on the other side: an own-property test must not
    // over-reject. A workspace may really declare a project called
    // `constructor` or `__proto__` — the name comes from `archkeep.json` or a
    // tracked manifest — and refusing it would be the same silent boundary
    // hole from the opposite direction. The fixture has to be null-prototype:
    // `{ __proto__: node }` in an object literal sets the prototype instead of
    // adding a key, so the name would never reach `selectProjects` at all.
    const nodes = Object.create(null);
    nodes.constructor = { data: { root: "libs/ctor", tags: ["odd"] } };
    nodes.__proto__ = { data: { root: "libs/proto", tags: ["odd"] } };
    nodes.normal = { data: { root: "libs/normal", tags: [] } };

    expect(selectProjects("constructor", nodes)).toEqual(["constructor"]);
    expect(selectProjects("name:__proto__", nodes)).toEqual(["__proto__"]);
    expect(selectProjects("tag:odd", nodes)).toEqual(["__proto__", "constructor"]);
    expect(selectProjects("directory:libs/proto", nodes)).toEqual(["__proto__"]);
    expect(selectProjects("*", nodes)).toEqual(["__proto__", "constructor", "normal"]);
  });

  // `docs/reference/architecture-intent.md`'s selector table gives `*` its own
  // row ("every project") and defines each labeled row as an exact match, so
  // `*` is a token of the grammar rather than a wildcard character inside a
  // value. Testing `value === "*"` before the label branches discarded the
  // label: on this fixture — where no project carries a tag `*`, is rooted at
  // `*`, or is named `*` — `name:*`, `tag:*` and `directory:*` each returned
  // every project in the graph. A labeled `*` now selects by exact equality
  // and so selects nothing here, which is the fail-loud reading: the boundary
  // reaches `./judge.mjs`'s zero-member no-verdict instead of silently
  // standing for "all of them".
  it("does not let a LABELLED wildcard mean every project", () => {
    expect(selectProjects("name:*", NODES)).toEqual([]);
    expect(selectProjects("tag:*", NODES)).toEqual([]);
    expect(selectProjects("directory:*", NODES)).toEqual([]);
  });

  it("keeps the bare '*' meaning every project", () => {
    expect(selectProjects("*", NODES)).toEqual(["core", "ui", "web"]);
  });

  it("reads a labelled '*' as the literal value it is — exact match, not a wildcard", () => {
    // The half that proves the previous case is exactness rather than a blanket
    // refusal: a project really named `*`, tagged `*`, or rooted at `*` is
    // selected by the labeled form that names it, and by nothing else.
    const nodes = {
      "*": { data: { root: "*", tags: ["*"] } },
      other: { data: { root: "libs/other", tags: ["real"] } },
    };
    expect(selectProjects("name:*", nodes)).toEqual(["*"]);
    expect(selectProjects("tag:*", nodes)).toEqual(["*"]);
    expect(selectProjects("directory:*", nodes)).toEqual(["*"]);
    expect(selectProjects("*", nodes)).toEqual(["*", "other"]);
  });
});

describe("resolveMembers", () => {
  it("unions the positives of a boundary's match list, sorted", () => {
    expect(resolveMembers(["tag:type-package", "name:web"], NODES)).toEqual(["core", "ui", "web"]);
  });

  it("carves exclusions out of the union", () => {
    expect(resolveMembers(["*", "!name:web"], NODES)).toEqual(["core", "ui"]);
  });

  it("prepends an implicit '*' when the list opens with an exclusion", () => {
    expect(resolveMembers(["!tag:type-package"], NODES)).toEqual(["web"]);
  });

  it("is empty when selectors match nothing", () => {
    expect(resolveMembers(["name:missing"], NODES)).toEqual([]);
  });

  it("is empty for a boundary whose only selector is a prototype member name or a labelled '*'", () => {
    // The two fixes seen from the caller `./judge.mjs` actually uses: both
    // lists used to resolve to a non-empty member set — `["constructor"]` to
    // one phantom project, `["name:*"]` to every project in the graph — and
    // either way the boundary's zero-member no-verdict never fired. Empty here
    // is what makes the run exit 3 instead of 0.
    expect(resolveMembers(["constructor"], NODES)).toEqual([]);
    expect(resolveMembers(["toString", "name:__proto__"], NODES)).toEqual([]);
    expect(resolveMembers(["name:*"], NODES)).toEqual([]);
    expect(resolveMembers(["tag:*"], NODES)).toEqual([]);
  });

  it("still seeds the implicit '*' from the BARE wildcard, and excludes with it", () => {
    // The seed `resolveMembers` prepends for an all-exclusion list is a bare
    // `*`, so narrowing the wildcard to its unlabeled form must not have
    // narrowed the seed with it.
    expect(resolveMembers(["!name:web"], NODES)).toEqual(["core", "ui"]);
    expect(resolveMembers(["*", "!tag:type-package"], NODES)).toEqual(["web"]);
  });

  it("is deterministic across calls for the same inputs", () => {
    expect(resolveMembers(["*", "!tag:type-package"], NODES)).toEqual(
      resolveMembers(["*", "!tag:type-package"], NODES),
    );
  });

  it("excludes a project matching both a positive and a negative selector, regardless of list order", () => {
    // The P1-10 regression: a boundary meant to exclude anything tagged
    // `legacy` must not silently readmit a legacy project just because the
    // list also carries a positive selector that project happens to match
    // too. Before the fix, ONLY `patterns[0]` decided whether an implicit '*'
    // seeded the union — so `["!tag:legacy", "tag:layer:app"]` (exclusion
    // first) seeded the wildcard, and the later `tag:layer:app` selector then
    // re-added `legacyApp` right after the exclusion had removed it, while
    // the reverse order never seeded the wildcard and correctly dropped it.
    // A project that should be excluded silently reappearing is the exact
    // silent direction `AGENTS.md`'s empty-result invariant refuses.
    const legacyApp = {
      name: "legacyApp",
      data: { root: "apps/legacy-app", tags: ["layer:app", "legacy"] },
    };
    const freshApp = { name: "freshApp", data: { root: "apps/fresh-app", tags: ["layer:app"] } };
    const nodes = { legacyApp, freshApp };

    const exclusionFirst = resolveMembers(["!tag:legacy", "tag:layer:app"], nodes);
    const inclusionFirst = resolveMembers(["tag:layer:app", "!tag:legacy"], nodes);

    expect(exclusionFirst).toEqual(["freshApp"]);
    expect(inclusionFirst).toEqual(["freshApp"]);
    expect(exclusionFirst).toEqual(inclusionFirst);
  });
});

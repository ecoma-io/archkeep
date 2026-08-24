import { describe, expect, it } from "vitest";

import { orphanedNotDependOnTags, unmatchedConstraintRows } from "./tags.mjs";

/**
 * Two helpers answer the two directions a constraint row can be dead in:
 * `unmatchedConstraintRows` catches a row that selects no project as its
 * SOURCE (it never applies, so everything on its axis passes while the config
 * reads as enforced), and `orphanedNotDependOnTags` catches a forbidden-target
 * entry naming a tag no project carries (the ban covers nothing while reading
 * as a ban). Every case below is red in its silent direction: delete the
 * helpers and each fixture's dead vocabulary sits in the table unflagged.
 *
 * The `onlyDependOnLibsWithTags` list is deliberately absent: naming nothing
 * makes a row maximally STRICT — `onlyTagsViolation` fires when the target
 * carries none of the permitted list, so an empty carrier set violates every
 * dependency. Loud, self-correcting, and neither helper's business.
 */

const project = (name, tags = [], type = "lib") => ({
  name,
  type,
  data: { root: `area/${name}`, tags },
});

const graphOf = (...projects) => ({
  nodes: Object.fromEntries(projects.map((p) => [p.name, p])),
  dependencies: {},
});

describe("unmatchedConstraintRows", () => {
  it("names a row whose sourceTag no project carries", () => {
    const rows = [
      { sourceTag: "zone:x", onlyDependOnLibsWithTags: ["zone:x"] },
      { sourceTag: "zone:coree", description: "typo of zone:core" },
    ];
    expect(unmatchedConstraintRows(rows, graphOf(project("a", ["zone:x"])))).toEqual([
      { index: 1, row: rows[1] },
    ]);
  });

  it("names a combo row only when no project carries every one of its tags", () => {
    const rows = [{ allSourceTags: ["zone:x", "grade:open"] }];
    // Each tag is carried by SOME project, but none carries both — the row
    // still selects nothing.
    expect(
      unmatchedConstraintRows(
        rows,
        graphOf(project("a", ["zone:x"]), project("b", ["grade:open"])),
      ),
    ).toEqual([{ index: 0, row: rows[0] }]);
    expect(unmatchedConstraintRows(rows, graphOf(project("a", ["zone:x", "grade:open"])))).toEqual(
      [],
    );
  });

  it("answers every tag dialect through the matcher the rules judge with", () => {
    // `*` matches even an untagged project; `/regex/` and glob forms are live
    // when they match a tag some project carries.
    const rows = [{ sourceTag: "*" }, { sourceTag: "/^zone:/" }, { sourceTag: "zone:*" }];
    expect(unmatchedConstraintRows(rows, graphOf(project("a", ["zone:x"])))).toEqual([]);
    expect(
      unmatchedConstraintRows([{ sourceTag: "/^layer:/" }], graphOf(project("a", ["zone:x"]))),
    ).toEqual([{ index: 0, row: { sourceTag: "/^layer:/" } }]);
  });

  it("does not flag a row over a permitted-list entry naming nothing", () => {
    // `onlyDependOnLibsWithTags` naming nothing makes the row maximally
    // strict — every dependency violates — which is loud, not silent.
    const rows = [
      { sourceTag: "zone:x", onlyDependOnLibsWithTags: ["zone:absent"] },
      { sourceTag: "zone:x", notDependOnLibsWithTags: ["grade:absent"] },
    ];
    expect(unmatchedConstraintRows(rows, graphOf(project("a", ["zone:x"])))).toEqual([]);
  });

  it("skips a row whose selector is malformed rather than crashing on it", () => {
    // Shape is the config loader's refusal; by the time a table reaches here
    // every row has been through it. The guard keeps a direct caller honest
    // instead of throwing `startsWith of undefined`.
    expect(unmatchedConstraintRows([{}], graphOf(project("a", ["zone:x"])))).toEqual([]);
  });

  it("answers nothing about an empty graph, where there is nothing to select", () => {
    // With no projects at all every row trivially selects nothing, which is
    // why the check-time refusal guards the empty graph itself (the same
    // "an empty tree has nothing for an entry to select" bargain
    // `evaluate`'s buildTargets check strikes) and this helper stays pure.
    expect(unmatchedConstraintRows([{ sourceTag: "zone:x" }], { nodes: {} })).toEqual([
      { index: 0, row: { sourceTag: "zone:x" } },
    ]);
  });
});

describe("orphanedNotDependOnTags", () => {
  it("names each forbidden-target entry no project carries", () => {
    const rows = [
      { sourceTag: "zone:x", notDependOnLibsWithTags: ["grade:closed"] },
      { sourceTag: "zone:x", notDependOnLibsWithTags: ["grade:open", "grade:gonte"] },
    ];
    // `c` carries `grade:open`, so only the typo'd value is orphaned.
    expect(
      orphanedNotDependOnTags(
        rows,
        graphOf(
          project("a", ["zone:x"]),
          project("b", ["grade:closed"]),
          project("c", ["grade:open"]),
        ),
      ),
    ).toEqual([{ index: 1, position: 1, tag: "grade:gonte" }]);
  });

  it("answers every dialect through the matcher the transitive verdict judges with", () => {
    const rows = [{ sourceTag: "zone:x", notDependOnLibsWithTags: ["/^grade:/", "grade:*"] }];
    expect(
      orphanedNotDependOnTags(rows, graphOf(project("a", ["zone:x", "grade:sealed"]))),
    ).toEqual([]);
    expect(orphanedNotDependOnTags(rows, graphOf(project("a", ["zone:x"])))).toEqual([
      { index: 0, position: 0, tag: "/^grade:/" },
      { index: 0, position: 1, tag: "grade:*" },
    ]);
  });

  it("skips rows the shape loader would have refused, and empty graphs", () => {
    expect(
      orphanedNotDependOnTags([{ notDependOnLibsWithTags: ["grade:x"] }], { nodes: {} }),
    ).toEqual([]);
    expect(orphanedNotDependOnTags([{}], graphOf(project("a", [])))).toEqual([]);
  });
});

// The evidence bundle's bytes, over a real tree, pinned.
//
// ADR 0002 makes the bundle public API: "The evidence bundle becomes public
// API. Its schema is versioned like the JSON envelope and grows additively
// within a version. An engine change that alters what an evidence kind reports
// can change a custom rule's verdict on an unchanged workspace — from the
// first shipped kind onward, the evidence contract carries the same
// breaking-change discipline `AGENTS.md` already applies to what is reported."
//
// Nothing measured that. `./evidence.test.mjs` drives `buildEvidenceBundle`
// over records the test itself wrote, so it pins the assembly and cannot see
// the facts moving underneath it: an analyzer that started emitting one more
// field on every import record, an attribution that changed which project owns
// a file, a graph adapter that added a key to an edge — each of those changes
// what a rule reads on a tree that did not change, and every one of them would
// have stayed green. The SDK fixtures could not see it either: they are
// committed documents, so a change in what the engine PRODUCES leaves them
// untouched and all four SDKs still agreeing about yesterday's bytes.
//
// This file closes that. A committed fixture workspace goes through the real
// pipeline — the real `git ls-files` stand-in, the real Go analyzer, the real
// attribution, the real policy loader — and the bundle that comes out is
// compared byte for byte against the golden beside it. A diff here is not
// automatically a bug; it is the moment to decide whether the change is
// additive or breaking, and to say which in the commit message.
//
//   LATTICE_UPDATE_EVIDENCE_GOLDEN=1 npx vitest run src/custom-rules/evidence-golden.integration.test.mjs
//
// ## Why the whole document, rather than assertions about parts
//
// A test that asserted `imports[0].specifier` would pass through every change
// that added a field, and adding a field to a kind is precisely the change
// ADR 0002 says has to be argued. The unit of review is the document.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalizeJson } from "../canonical.mjs";
import { resolveCommandContext } from "../commands/context.mjs";
import { loadBoundaryConfig } from "../config.mjs";
import { buildEvidenceBundle, serializeEvidenceBundle } from "./evidence.mjs";

const GOLDEN = fileURLToPath(new URL("./evidence-golden.json", import.meta.url));
const UPDATING = process.env.LATTICE_UPDATE_EVIDENCE_GOLDEN === "1";

/**
 * The fixture tree, chosen so that every kind carries something worth pinning
 * rather than an empty array:
 *
 * - three projects, one of them **untagged** — a real state
 *   (`projectWithoutTagsCannotHaveDependencies` exists because of it) that must
 *   serialize as `[]` and never as an absent key;
 * - a Go import that resolves to a sibling project, and one that resolves to
 *   **nothing** (a module no project declares), because an unresolved site is
 *   the record shape most likely to change shape underneath a rule;
 * - a policy with a real constraint row, all eight options, and a suppression,
 *   so the `policy` kind pins the rename `options` → `moduleBoundaryOptions`
 *   and the two keys the contract carries — not the two it deliberately drops.
 */
const root = mkdtempSync(join(tmpdir(), "evidence-golden-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (relativePath, text) => {
  mkdirSync(join(root, relativePath, ".."), { recursive: true });
  writeFileSync(join(root, relativePath), text);
};

write(
  "module-boundaries.config.mjs",
  `export const depConstraints = [
  { sourceTag: "layer-app", onlyDependOnLibsWithTags: ["layer-core"] },
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

export const boundarySuppressions = [
  { path: "libs/loose/**", reason: "kept until the loose library is split", expiresAt: "2099-01-01T00:00:00.000Z" },
];
`,
);
write(
  "nx.json",
  `${JSON.stringify({
    plugins: [
      {
        plugin: "@ecoma-io/lattice/nx",
        options: { boundaryConfig: "module-boundaries.config.mjs" },
      },
    ],
  })}\n`,
);
write("libs/app/go.mod", "module example.test/app\n\ngo 1.24\n");
write(
  "libs/app/main.go",
  `package app

import (
\t"example.test/core"
\t"example.test/nowhere"
)

var _ = core.Name
var _ = nowhere.Name
`,
);
write("libs/core/go.mod", "module example.test/core\n\ngo 1.24\n");
write("libs/core/core.go", 'package core\n\nvar Name = "core"\n');
write("libs/loose/go.mod", "module example.test/loose\n\ngo 1.24\n");
write("libs/loose/loose.go", 'package loose\n\nvar Name = "loose"\n');

const graph = {
  nodes: {
    app: { name: "app", type: "lib", data: { root: "libs/app", tags: ["layer-app"] } },
    core: { name: "core", type: "lib", data: { root: "libs/core", tags: ["layer-core"] } },
    // Deliberately untagged: `tags: []` is a fact about this workspace, and
    // the bundle must say it rather than omit the key.
    loose: { name: "loose", type: "lib", data: { root: "libs/loose" } },
  },
  dependencies: {
    app: [{ source: "app", target: "core", type: "static", sourceFile: "libs/app/main.go" }],
    core: [],
    loose: [],
  },
};

const files = [
  "nx.json",
  "module-boundaries.config.mjs",
  "libs/app/go.mod",
  "libs/app/main.go",
  "libs/core/go.mod",
  "libs/core/core.go",
  "libs/loose/go.mod",
  "libs/loose/loose.go",
];

/** The declared row, params included — the one per-rule part of the bundle. */
const RULE_ROW = {
  name: "no-app-to-loose",
  artifact: "tools/rules/no-app-to-loose.wasm",
  sha256: "0".repeat(64),
  params: { forbiddenTag: "layer-loose", exemptTags: [] },
  reason: "the app layer stays off the loose library while it is being split",
};

describe("the evidence bundle over a real tree", () => {
  it("is byte-identical to the recorded golden", async () => {
    const commandContext = resolveCommandContext(
      { cwd: root, paths: [] },
      { readGraph: () => graph, listFiles: () => files },
    );
    const policy = await loadBoundaryConfig(root, "module-boundaries.config.mjs");

    // Assembled the way `../commands/custom-rules.mjs` assembles it. The two
    // are held together by `../custom-rules.check.integration.test.mjs`, which
    // drives the real command; what this file owns is the BYTES, which only a
    // golden can hold.
    const projectOfFile = new Map(commandContext.owned.map(({ file, project }) => [file, project]));
    const observed = {
      projects: Object.entries(graph.nodes).map(([key, node]) => ({
        name: node.name ?? key,
        root: node.data?.root,
        tags: Array.isArray(node.data?.tags) ? node.data.tags : [],
      })),
      edges: Object.values(graph.dependencies).flat(),
      imports: commandContext.analysis.imports.map((site) => ({
        site,
        sourceProject: projectOfFile.get(site.sourceFile),
      })),
      policy,
    };

    const canonical = new TextDecoder().decode(
      serializeEvidenceBundle(buildEvidenceBundle({ ...observed, rule: RULE_ROW })),
    );

    if (UPDATING) writeFileSync(GOLDEN, `${JSON.stringify(JSON.parse(canonical), null, 2)}\n`);
    const recorded = JSON.parse(readFileSync(GOLDEN, "utf8"));

    // Two assertions, and the order matters for the reader. The first gives a
    // structural diff naming the field that moved; the second is the actual
    // claim — the canonical BYTES the host writes into linear memory. The
    // golden file itself is stored pretty-printed and is re-canonicalized
    // here, so Prettier owns its layout and neither tool has to yield: what
    // is under contract is the document, and its indentation is not part of
    // it.
    expect(JSON.parse(canonical)).toEqual(recorded);
    expect(canonicalizeJson(recorded)).toBe(canonical);
  });

  it("carries every kind with something in it, so the golden holds a real document", () => {
    // A golden of a bundle whose kinds are all empty would pass through every
    // change to what a kind reports — it would be a snapshot of nothing. This
    // case is what keeps the fixture above honest as it is edited.
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(golden.model.projects.length).toBeGreaterThan(0);
    expect(golden.graph.edges.length).toBeGreaterThan(0);
    expect(golden.imports.length).toBeGreaterThan(0);
    expect(golden.policy.depConstraints.length).toBeGreaterThan(0);
    expect(Object.keys(golden.policy.moduleBoundaryOptions)).toHaveLength(8);
    // The untagged project and the unresolved import: the two shapes most
    // likely to be quietly normalised away by a change upstream of the bundle.
    expect(golden.model.projects.some((project) => project.tags.length === 0)).toBe(true);
    expect(golden.imports.some((site) => site.resolved.target === null)).toBe(true);
  });

  it("carries neither suppressions nor fitness, which acceptance owns", () => {
    // `./evidence.mjs`'s header states the refusal: a rule that could see
    // waivers could launder them into its own verdict. The fixture policy
    // declares a suppression precisely so this case can fail if one ever
    // reaches the wire.
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(Object.keys(golden.policy).sort()).toEqual(["depConstraints", "moduleBoundaryOptions"]);
    expect(JSON.stringify(golden)).not.toContain("boundarySuppressions");
  });
});

/**
 * The markdown document track, end to end through `check`: a policy that
 * declares a `markdown` block reads tracked documents, resolves each marker to
 * the project exporting the named symbol, folds the pairing into the graph the
 * way the declared manifest track folds a `ProjectReference`, and judges the
 * edge with `judgeEdge` — the same function every other declared edge is judged
 * by (`./rules/edge-constraints.mjs`). No new rule exists; the whole feature is
 * the fold and the existing tag rows.
 *
 * The red-first half of the contract is the invariant that named the feature:
 * before the fold existed, every run below reported ZERO violations and exit 0
 * on the identical tree — a document pairing crossing a forbidden boundary was
 * byte-for-byte identical to a clean workspace. Every test that asserts a
 * finding, an exit code, or a count here would have failed against that
 * engine, which is what makes the assertion load-bearing rather than
 * descriptive.
 *
 * The loud half is the whole-file posture: a marker the tree cannot resolve is
 * an `unchecked` document and exit 3 — never a clean verdict — because a
 * pairing the run could not judge must not be indistinguishable from one it
 * judged and kept.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { check } from "../cli.mjs";
import { writeAll, writeIn } from "./providers/native/differential.fixtures.mjs";

// ---------------------------------------------------------------------------
// The fixture: a native two-project tree with an owned document
// ---------------------------------------------------------------------------

const MODULE_BOUNDARY_OPTIONS = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

const MARKER_ROW = { pattern: "^<!-- @api (\\S+) -->$", edge: "resolvedExportOwner" };

const MARKDOWN_BLOCK = () => ({
  include: ["pages/**/*.md"],
  markers: [MARKER_ROW],
});

/**
 * `layer:docs` may depend only on itself, so a document pairing from `docs-site`
 * to `ui` is the fixture's forbidden claim. `forbidden` is the one knob the
 * per-test policies turn: adding `layer:ui` to the row's allow-list is what
 * makes the same pairing legal.
 *
 * @param {{markdown?: object, suppressions?: object[], forbidden?: boolean}} [options]
 */
const archkeepJson = ({ markdown, suppressions, forbidden = true } = {}) =>
  JSON.stringify(
    {
      projects: {
        declared: [
          { root: "pages", name: "docs-site", tags: ["layer:docs"] },
          { root: "packages/ui", name: "ui", tags: ["layer:ui"] },
        ],
      },
      boundaryConfig: {
        depConstraints: [
          {
            sourceTag: "layer:docs",
            onlyDependOnLibsWithTags: forbidden ? ["layer:docs"] : ["layer:docs", "layer:ui"],
          },
          { sourceTag: "layer:ui", onlyDependOnLibsWithTags: ["layer:ui", "layer:docs"] },
        ],
        moduleBoundaryOptions: MODULE_BOUNDARY_OPTIONS,
        ...(suppressions === undefined ? {} : { boundarySuppressions: suppressions }),
        ...(markdown === undefined ? {} : { markdown }),
      },
    },
    null,
    2,
  );

const TREE = {
  "pages/ui.md": "# Button\n\nSome prose about the component.\n\n<!-- @api Button -->\n",
  "packages/ui/button.ts": "export const Button = () => null;\n",
};

/**
 * Builds the fixture once and hands back a `run` bound to it, so one tree can
 * be checked twice for the determinism contract — two runs over two trees
 * would differ in `workspace.root` alone, which is the tmpdir, not the tool.
 *
 * @param {string} archkeepBytes
 * @param {Record<string, string>} [files] Extra tree files replacing the defaults.
 */
function makeTree(archkeepBytes, files = TREE) {
  const root = mkdtempSync(join(tmpdir(), "markdown-check-"));
  const write = writeIn(root);
  write("archkeep.json", archkeepBytes);
  writeAll(write, files);
  const tracked = ["archkeep.json", ...Object.keys(files)];
  return {
    run: (format = "json") =>
      check({ format, config: null, paths: [] }, { cwd: root, listFiles: () => tracked }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** @param {string} archkeepBytes One-shot convenience over `makeTree`. */
async function jsonRun(archkeepBytes) {
  const tree = makeTree(archkeepBytes);
  try {
    const result = await tree.run("json");
    return { result, envelope: JSON.parse(result.report) };
  } finally {
    tree.cleanup();
  }
}

describe("the markdown document track through check", () => {
  it("reports a forbidden document pairing as a violation AT THE MARKER, with the standard message", async () => {
    const { result, envelope } = await jsonRun(archkeepJson({ markdown: MARKDOWN_BLOCK() }));
    // Red-first: before the track existed this run reported 0 violations and
    // exit 0 — the pairing was invisible, byte-for-byte identical to clean.
    expect(result.violations).toBe(1);
    expect(envelope.status).toBe("findings");
    expect(envelope.exitCode).toBe(1);
    const [violation] = envelope.result.violations;
    expect(violation.sourceFile).toBe("pages/ui.md");
    expect(violation.line).toBe(5);
    expect(violation.column).toBe(1);
    expect(violation.specifier).toBe("Button");
    expect(violation.sourceProject).toBe("docs-site");
    expect(violation.targetProject).toBe("ui");
    expect(violation.messageId).toBe("onlyTagsConstraintViolation");
    expect(violation.message).toBe(
      'A project tagged with "layer:docs" can only depend on libs tagged with "layer:docs"',
    );
    expect(violation.constraint).toMatchObject({ sourceTag: "layer:docs" });
    // The track's own block names what it did: one document read, one marker
    // judged, one pairing resolved, none self-paired.
    expect(envelope.result.markdown).toEqual({
      checked: true,
      documents: 1,
      judged: 1,
      resolved: 1,
    });
  });

  it("renders the finding in the text report at the document's own file:line", async () => {
    const tree = makeTree(archkeepJson({ markdown: MARKDOWN_BLOCK() }));
    try {
      const textRun = await tree.run("text");
      expect(textRun.report).toContain("pages/ui.md:5:1  onlyTagsConstraintViolation");
      // The violation names the claimed symbol and the edge it drew — the
      // same `specifier`/`kind` pair an import-site violation renders with.
      expect(textRun.report).toContain('"Button" (resolvedExportOwner)  docs-site → ui');
    } finally {
      tree.cleanup();
    }
  });

  it("is ADDITIVE: the same tree without the markdown block has no markdown key, and adding one changes nothing else", async () => {
    const without = await jsonRun(archkeepJson({}));
    const withTrack = await jsonRun(archkeepJson({ markdown: MARKDOWN_BLOCK() }));
    // Config-absent (no markdown block): no track, no key, no finding — the
    // bytes the workspace got before this feature existed.
    expect(without.result.violations).toBe(0);
    expect("markdown" in without.envelope.result).toBe(false);
    expect(without.envelope.status).toBe("ok");
    // The only differences the block may introduce, by name: the violations
    // list grew by the marker's verdict, the `markdown` block appeared, and
    // the policy fingerprint moved — the block is law, and the fingerprint is
    // what `diff` reads to notice a law that changed.
    const strip = (result, keys) => {
      const clone = { ...result };
      for (const key of keys) delete clone[key];
      return clone;
    };
    expect(strip(withTrack.envelope.result, ["violations", "markdown", "policy"])).toEqual(
      strip(without.envelope.result, ["violations", "policy"]),
    );
    expect(withTrack.envelope.result.policy.source).toBe(without.envelope.result.policy.source);
    expect(withTrack.envelope.result.policy.fingerprint).not.toBe(
      without.envelope.result.policy.fingerprint,
    );
  });

  it("judges a LEGAL pairing clean, with the block stating the judged counts", async () => {
    const { result, envelope } = await jsonRun(
      archkeepJson({ markdown: MARKDOWN_BLOCK(), forbidden: false }),
    );
    expect(result.violations).toBe(0);
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.result.markdown).toEqual({
      checked: true,
      documents: 1,
      judged: 1,
      resolved: 1,
    });
  });

  it("resolves through a re-exporting barrel: the marker's verdict points at the document", async () => {
    const tree = makeTree(archkeepJson({ markdown: MARKDOWN_BLOCK() }), {
      "pages/ui.md": "<!-- @api Button -->\n",
      "packages/ui/button.ts": "const Button = () => null;\n",
      "packages/ui/index.ts": 'export { Button } from "./button.js";\n',
    });
    try {
      const result = await tree.run("json");
      const envelope = JSON.parse(result.report);
      // `Button` is declared nowhere; the barrel's re-export resolves it to
      // `ui`, whose pairing `layer:docs → layer:ui` forbids. A track that
      // could not resolve through the barrel would fail the file instead —
      // this assertion is the resolution half of the loudness contract.
      expect(result.violations).toBe(1);
      expect(envelope.result.violations[0].sourceFile).toBe("pages/ui.md");
      expect(envelope.result.violations[0].line).toBe(1);
      expect(envelope.result.markdown.resolved).toBe(1);
    } finally {
      tree.cleanup();
    }
  });

  it("judges EACH marker separately: two documents pairing the same projects report two violations, both at their own line", async () => {
    const tree = makeTree(archkeepJson({ markdown: MARKDOWN_BLOCK() }), {
      "pages/ui.md": "<!-- @api Button -->\n",
      "pages/guide.md": "# Guide\n\n<!-- @api Button -->\n",
      "packages/ui/button.ts": "export const Button = () => null;\n",
    });
    try {
      const result = await tree.run("json");
      const envelope = JSON.parse(result.report);
      // Two markers, one graph edge (the fold dedupes at project grain) — but
      // the VERDICTS are per marker, at the position a reader edits. A track
      // that judged the deduped edge once would report one violation for two
      // documents, and one of the two documents would read as clean.
      expect(result.violations).toBe(2);
      expect(
        envelope.result.violations.map((violation) => [violation.sourceFile, violation.line]),
      ).toEqual([
        ["pages/guide.md", 3],
        ["pages/ui.md", 1],
      ]);
      expect(envelope.result.markdown).toEqual({
        checked: true,
        documents: 2,
        judged: 2,
        resolved: 2,
      });
    } finally {
      tree.cleanup();
    }
  });

  it("counts a self-pairing as judged without an edge and without a violation", async () => {
    // The document lives INSIDE `ui` and names `ui`'s own export: the claimed
    // dependency would be `ui → ui`, which no track draws — no project
    // depends on itself — but the row matched and resolved, so the marker is
    // judged, not dropped.
    const tree = makeTree(
      JSON.stringify({
        projects: {
          declared: [
            { root: "pages", name: "docs-site", tags: ["layer:docs"] },
            { root: "packages/ui", name: "ui", tags: ["layer:ui"] },
          ],
        },
        boundaryConfig: {
          depConstraints: [
            { sourceTag: "layer:docs", onlyDependOnLibsWithTags: ["layer:docs"] },
            { sourceTag: "layer:ui", onlyDependOnLibsWithTags: ["layer:ui", "layer:docs"] },
          ],
          moduleBoundaryOptions: MODULE_BOUNDARY_OPTIONS,
          markdown: { include: ["packages/**/*.md"], markers: [MARKER_ROW] },
        },
      }),
      {
        "pages/keep.txt": "a tracked file so the docs project is backed by the tree\n",
        "packages/ui/notes.md": "<!-- @api Button -->\n",
        "packages/ui/button.ts": "export const Button = () => null;\n",
      },
    );
    try {
      const result = await tree.run("json");
      const envelope = JSON.parse(result.report);
      expect(result.violations).toBe(0);
      expect(envelope.status).toBe("ok");
      expect(envelope.result.markdown).toEqual({
        checked: true,
        documents: 1,
        judged: 1,
        resolved: 0,
        selfPaired: 1,
      });
    } finally {
      tree.cleanup();
    }
  });

  it("fails the run loudly (exit 3) when a marker names a symbol no project exports", async () => {
    const tree = makeTree(archkeepJson({ markdown: MARKDOWN_BLOCK() }), {
      "pages/ui.md": "<!-- @api Buttn -->\n",
      "packages/ui/button.ts": "export const Button = () => null;\n",
    });
    try {
      const result = await tree.run("json");
      const envelope = JSON.parse(result.report);
      // Not findings, not ok: the pairing went UNJUDGED, and an unchecked
      // document is the no-verdict lane.
      expect(envelope.status).toBe("no-verdict");
      expect(envelope.exitCode).toBe(3);
      expect(result.unchecked).toBe(1);
      expect(envelope.coverage.complete).toBe(false);
      expect(envelope.coverage.notAnalyzed).toEqual([
        {
          file: "pages/ui.md",
          reason: expect.stringMatching(
            /line 1: the marker names 'Buttn', which no tracked project/,
          ),
        },
      ]);
      // The marker was extracted but the graph carries no edge it did not
      // earn: `judged` counts the extraction, `resolved` the honest zero.
      expect(envelope.result.markdown).toMatchObject({ judged: 1, resolved: 0 });
    } finally {
      tree.cleanup();
    }
  });

  it("fails the run loudly when more than one project exports the name, naming both candidates", async () => {
    const tree = makeTree(
      JSON.stringify({
        projects: {
          declared: [
            { root: "pages", name: "docs-site", tags: ["layer:docs"] },
            { root: "packages/ui", name: "ui", tags: ["layer:ui"] },
            { root: "packages/web", name: "web", tags: ["layer:ui"] },
          ],
        },
        boundaryConfig: {
          depConstraints: [
            { sourceTag: "layer:docs", onlyDependOnLibsWithTags: ["layer:docs"] },
            { sourceTag: "layer:ui", onlyDependOnLibsWithTags: ["layer:ui"] },
          ],
          moduleBoundaryOptions: MODULE_BOUNDARY_OPTIONS,
          markdown: MARKDOWN_BLOCK(),
        },
      }),
      {
        "pages/ui.md": "<!-- @api Button -->\n",
        "packages/ui/button.ts": "export const Button = () => null;\n",
        "packages/web/button.ts": "export const Button = 2;\n",
      },
    );
    try {
      const result = await tree.run("json");
      const envelope = JSON.parse(result.report);
      expect(envelope.status).toBe("no-verdict");
      expect(result.unchecked).toBe(1);
      const reason = envelope.coverage.notAnalyzed[0].reason;
      expect(reason).toMatch(/more than one project exports/);
      expect(reason).toContain("'ui', 'web'");
    } finally {
      tree.cleanup();
    }
  });

  it("lets a suppression row covering the document remove the verdict — and the row stays alive", async () => {
    const { result, envelope } = await jsonRun(
      archkeepJson({
        markdown: MARKDOWN_BLOCK(),
        suppressions: [
          {
            path: "pages/**/*.md",
            reason: "the docs project is published externally; pairings are reviewed there",
          },
        ],
      }),
    );
    // The verdict the row removes is a DOCUMENT verdict — a table that only
    // measured import-site candidates would read this row as dead and refuse
    // the run, which is why the raw document records join the gate's inputs.
    expect(result.violations).toBe(0);
    expect(envelope.status).toBe("ok");
  });

  it("refuses an include glob that matches no tracked document, instead of running a track that reads nothing", async () => {
    await expect(
      jsonRun(
        archkeepJson({
          markdown: { include: ["writings/**/*.md"], markers: [MARKER_ROW] },
        }),
      ),
    ).rejects.toThrow(
      /markdown\.include\[0\]: 'writings\/\*\*\/\*\.md' matches no tracked document/,
    );
  });

  it("refuses a marker row that matches no line in any included document", async () => {
    await expect(
      jsonRun(
        archkeepJson({
          markdown: {
            include: ["pages/**/*.md"],
            markers: [{ pattern: "^@see (\\S+)$", edge: "resolvedExportOwner" }],
          },
        }),
      ),
    ).rejects.toThrow(
      /markdown\.markers\[0\]: the pattern matches no line in any included document/,
    );
  });

  it("is byte-deterministic: two runs over the same tree render identical JSON", async () => {
    const tree = makeTree(archkeepJson({ markdown: MARKDOWN_BLOCK() }));
    try {
      const first = await tree.run("json");
      const second = await tree.run("json");
      expect(second.report).toBe(first.report);
    } finally {
      tree.cleanup();
    }
  });
});

/**
 * Config-key-order independence (D1): the policy a run loads is a set of
 * facts, not a sequence of them, so rewriting the boundary config with every
 * object's keys in a different order — export order, row key order, options
 * key order, the workspace's own plugin options included — must not move one
 * byte of the verdict.
 *
 * The fingerprint side of this was already pinned (`computePolicyFingerprint`
 * canonicalizes before hashing, after the bug the manifest records); what was
 * unpinned is the verdict side: the config object flows from the file through
 * the policy ladder into `evaluateRun` and the envelope, and any step along
 * that path that iterated `Object.keys` instead of reading named fields would
 * turn a re-spelled config into a different verdict over an unchanged tree —
 * byte-for-byte, with nothing red. So the same tree is checked twice, the
 * config file re-spelled in between, and the two envelopes are held
 * byte-identical.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterAll } from "vitest";

import { EXIT, runCli } from "../cli.mjs";

const root = mkdtempSync(join(tmpdir(), "config-key-order-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (relativePath, text) => {
  mkdirSync(join(root, dirname(relativePath)), { recursive: true });
  writeFileSync(join(root, relativePath), text);
};

/** The workspace's own options, spelled with `plugin` before `options`. */
const NX_JSON_A = `${JSON.stringify({
  plugins: [
    {
      plugin: "@ecoma-io/archkeep/nx",
      options: { boundaryConfig: "module-boundaries.config.mjs" },
    },
  ],
})}\n`;

/** The same workspace options with every object's key order reversed. */
const NX_JSON_B = `{
  "plugins": [
    {
      "options": { "boundaryConfig": "module-boundaries.config.mjs" },
      "plugin": "@ecoma-io/archkeep/nx"
    }
  ]
}
`;

/** The same policy as CONFIG_B, spelled in the file's natural order. */
const CONFIG_A = `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
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
`;

/** CONFIG_A with every object's keys reversed and the exports swapped. */
const CONFIG_B = `export const moduleBoundaryOptions = {
  checkNestedExternalImports: false,
  banTransitiveDependencies: false,
  ignoredCircularDependencies: [],
  checkDynamicDependenciesExceptions: [],
  allowCircularSelfDependency: false,
  enforceBuildableLibDependency: false,
  buildTargets: ["build"],
  allow: [],
};
export const depConstraints = [
  { onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"], sourceTag: "layer:adapter" },
  { onlyDependOnLibsWithTags: ["layer:domain"], sourceTag: "layer:domain" },
];
`;

write("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
write("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
write("libs/adapter/adapter.go", "package adapter\n");
write(
  "libs/domain/doc.go",
  [
    "package domain",
    "",
    "import (",
    '\t"example.com/adapter"',
    ")",
    "",
    "var _ = adapter.Name",
    "",
  ].join("\n"),
);

const graph = {
  nodes: {
    domain: {
      name: "domain",
      type: "lib",
      data: { root: "libs/domain", tags: ["layer:domain"] },
    },
    adapter: {
      name: "adapter",
      type: "lib",
      data: { root: "libs/adapter", tags: ["layer:adapter"] },
    },
  },
  dependencies: { domain: [], adapter: [] },
};

const files = [
  "nx.json",
  "module-boundaries.config.mjs",
  "libs/domain/go.mod",
  "libs/domain/doc.go",
  "libs/adapter/go.mod",
  "libs/adapter/adapter.go",
];

const env = () => {
  const out = [];
  const err = [];
  return {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    lines: { out, err },
    cwd: root,
    readGraph: () => graph,
    listFiles: () => files,
  };
};

describe("config-key-order independence", () => {
  it("a re-spelled config produces a byte-identical verdict over the same tree", async () => {
    // The tree is unchanged across the two runs; only the key order of the
    // config file and of the workspace's own options is rewritten in between.
    write("nx.json", NX_JSON_A);
    write("module-boundaries.config.mjs", CONFIG_A);
    const first = env();
    const firstExit = await runCli(["check", "--format", "json"], first);
    const firstOut = first.lines.out.join("\n");

    write("nx.json", NX_JSON_B);
    write("module-boundaries.config.mjs", CONFIG_B);
    const second = env();
    const secondExit = await runCli(["check", "--format", "json"], second);
    const secondOut = second.lines.out.join("\n");

    expect(firstExit).toBe(EXIT.violations);
    expect(secondExit).toBe(EXIT.violations);
    // Byte-identical, key order included: JSON.stringify emits insertion
    // order, so any step that folded the config's key order into its output
    // would show here.
    expect(secondOut).toBe(firstOut);
  });

  it("the fixture's violation survives the re-spelling (loudness guard)", async () => {
    // The byte-identity above would pass vacuously over two empty verdicts,
    // so the same run must also be held to the finding the tree carries.
    write("module-boundaries.config.mjs", CONFIG_B);
    const streams = env();
    const exit = await runCli(["check", "--format", "json"], streams);
    const envelope = JSON.parse(streams.lines.out.join("\n"));
    expect(exit).toBe(EXIT.violations);
    expect(envelope.result.violations).toHaveLength(1);
    expect(envelope.result.violations[0].sourceFile).toBe("libs/domain/doc.go");
    // The fingerprint is computed over the same policy bytes under both
    // spellings — named here because it is the one field a diff between the
    // two runs would otherwise be tempted to blame.
    expect(typeof envelope.result.policy.fingerprint).toBe("string");
    expect(envelope.result.policy.fingerprint).toHaveLength(64);

    // And the first spelling reaches the identical fingerprint: the two runs
    // judged under one law, whatever order its keys were written in.
    write("module-boundaries.config.mjs", CONFIG_A);
    const first = env();
    await runCli(["check", "--format", "json"], first);
    const firstEnvelope = JSON.parse(first.lines.out.join("\n"));
    expect(firstEnvelope.result.policy.fingerprint).toBe(envelope.result.policy.fingerprint);
  });
});

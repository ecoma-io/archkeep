/**
 * The shipped policy packs, driven through the real machinery rather than
 * described.
 *
 * A preset is data: a profile registry this package publishes, which a
 * consumer's `profiles` option points at. That makes two things checkable, and
 * both have to be, because a preset that only ever appeared in a document
 * would be a law nobody ran:
 *
 * - **It loads.** Every profile in every shipped file goes through the real
 *   `./profile-registry.mjs` loader and the real `../config.mjs` validator, so
 *   a preset carrying a key `policyFrom` refuses cannot ship green. Loading is
 *   the half a hand-written fixture cannot fake — the file on disk is the file
 *   in the tarball.
 * - **It enforces.** Every profile gets a dependency its style forbids AND one
 *   its style allows, judged by the real `../rules/` engine. The forbidden one
 *   must be reported and the allowed one must not: a preset whose rows matched
 *   nothing would pass a loading test and report nothing forever, which is the
 *   silent direction `../../../../AGENTS.md` exists to refuse.
 *
 * The derived profiles carry a third assertion the other two cannot express.
 * A profile that inherits a `base` appends its rows to the base's, and rows
 * compose with AND (`../../../../docs/concepts/profiles.md`), so a derived
 * profile can only ever tighten. Each derived case therefore ALSO asserts its
 * base stays silent on the same import: without that, a test proving "the
 * strict profile reports it" would pass identically if the base had reported
 * it all along and the derived rows did nothing at all.
 *
 * Every project name, root and tag below is invented for these tests, the same
 * convention `../rules/index.test.mjs` keeps and for the same reason — this
 * tool runs over consumers' trees, whose names it has never seen
 * (`../../CLAUDE.md`).
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { check, EXIT } from "../../cli.mjs";
import { evaluate } from "../rules/index.mjs";
import { loadProfileRegistry, profilePolicy, resolveProfile } from "./profile-registry.mjs";

/** The directory the shipped packs live in, resolved from this file. */
const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "presets");

const presetPath = (pack) => join(PRESETS_DIR, `${pack}.json`);

/**
 * A project node in the shape `../rules/index.mjs` reads: `data.tags` is the
 * only field any preset row keys on.
 */
const project = (name, tags) => ({
  name,
  type: "lib",
  data: { root: `libs/${name}`, tags },
});

const graphOf = (projects, dependencies = {}) => ({
  nodes: Object.fromEntries(projects.map((p) => [p.name, p])),
  dependencies: Object.fromEntries(projects.map((p) => [p.name, dependencies[p.name] ?? []])),
});

/**
 * One analysis record, in the frozen shape `../analysis/contract.md` fixes.
 * `spelling` says how the specifier was written — a bare package specifier in
 * the JavaScript family is neither a path nor relative.
 */
const site = (from, { specifier, target }) => ({
  sourceFile: `libs/${from}/src/index.ts`,
  line: 1,
  column: 1,
  kind: "static",
  specifier,
  spelling: { path: false, relative: false },
  resolved:
    target === null
      ? { target: null, file: null, external: true, packageName: specifier }
      : { target, file: `libs/${target}/src/index.ts`, external: false, packageName: null },
});

/** An import of one workspace project by another. */
const crosses = (from, to) => site(from, { specifier: `@fixture/${to}`, target: to });

/** An import of a package outside the workspace — a real one, or a built-in. */
const reachesOutside = (from, packageName) => site(from, { specifier: packageName, target: null });

/**
 * Every shipped pack, every profile in it, and the two imports that decide
 * whether the profile is a law or a decoration.
 *
 * `forbidden` is the dependency the style exists to prevent; `allowed` is the
 * near miss that must stay silent. `base` names the profile a derived one
 * inherits, and is what the third assertion above is run against.
 */
const CASES = [
  {
    pack: "clean-architecture",
    profiles: [
      {
        name: "clean-architecture",
        projects: [
          project("entities", ["layer:entities"]),
          project("usecases", ["layer:use-cases"]),
          project("web", ["layer:frameworks"]),
        ],
        // The Dependency Rule, inverted: an entity reaching outward to the
        // use case that orchestrates it.
        forbidden: crosses("entities", "usecases"),
        forbiddenMessageId: "onlyTagsConstraintViolation",
        allowed: crosses("usecases", "entities"),
      },
      {
        name: "clean-architecture-pure-core",
        base: "clean-architecture",
        projects: [project("entities", ["layer:entities"]), project("web", ["layer:frameworks"])],
        forbidden: reachesOutside("entities", "node:crypto"),
        forbiddenMessageId: "bannedExternalImportsViolation",
        // The outermost layer is where a package is allowed to arrive.
        allowed: reachesOutside("web", "node:crypto"),
      },
    ],
  },
  {
    pack: "hexagonal",
    profiles: [
      {
        name: "hexagonal",
        projects: [
          project("domain", ["layer:domain"]),
          project("http", ["layer:adapters"]),
          project("store", ["layer:adapters"]),
          project("ports", ["layer:ports"]),
        ],
        // Two adapters talking to each other: a driven side used as a driving
        // one, which is the shape the port existed to prevent.
        forbidden: crosses("http", "store"),
        forbiddenMessageId: "onlyTagsConstraintViolation",
        allowed: crosses("http", "ports"),
      },
      {
        name: "hexagonal-pure-domain",
        base: "hexagonal",
        projects: [project("domain", ["layer:domain"]), project("http", ["layer:adapters"])],
        forbidden: reachesOutside("domain", "node:fs"),
        forbiddenMessageId: "bannedExternalImportsViolation",
        allowed: reachesOutside("http", "node:fs"),
      },
    ],
  },
  {
    pack: "modular-monolith",
    profiles: [
      {
        name: "modular-monolith",
        projects: [
          project("shell", ["layer:app"]),
          project("billing", ["layer:module"]),
          project("billing-core", ["layer:module-internal"]),
          project("kernel", ["layer:shared-kernel"]),
        ],
        // The deployable reaching past a module's published surface into what
        // the module keeps to itself.
        forbidden: crosses("shell", "billing-core"),
        forbiddenMessageId: "onlyTagsConstraintViolation",
        allowed: crosses("shell", "billing"),
      },
      {
        name: "modular-monolith-sealed-kernel",
        base: "modular-monolith",
        projects: [
          project("kernel", ["layer:shared-kernel"]),
          project("billing", ["layer:module"]),
        ],
        forbidden: reachesOutside("kernel", "node:zlib"),
        forbiddenMessageId: "bannedExternalImportsViolation",
        allowed: reachesOutside("billing", "node:zlib"),
      },
    ],
  },
  {
    pack: "ddd-bounded-contexts",
    profiles: [
      {
        name: "ddd-bounded-contexts",
        projects: [
          project("orders-model", ["layer:domain"]),
          project("orders-app", ["layer:application"]),
          project("orders-contracts", ["layer:published-language"]),
        ],
        // A published contract that names the model it was meant to shield
        // other contexts from.
        forbidden: crosses("orders-contracts", "orders-model"),
        forbiddenMessageId: "onlyTagsConstraintViolation",
        allowed: crosses("orders-app", "orders-contracts"),
      },
      {
        name: "ddd-bounded-contexts-isolated",
        base: "ddd-bounded-contexts",
        projects: [
          project("orders-app", ["layer:application", "share:private"]),
          project("billing-app", ["layer:application", "share:private"]),
          project("billing-contracts", ["layer:published-language", "share:published"]),
        ],
        // Both sides sit on the layer axis the base allows, so only the
        // isolation row this profile adds can see it.
        forbidden: crosses("orders-app", "billing-app"),
        forbiddenMessageId: "notTagsConstraintViolation",
        allowed: crosses("orders-app", "billing-contracts"),
      },
    ],
  },
];

describe("shipped policy packs", () => {
  it("exercises every pack the directory holds", () => {
    // The pack list above is hand-kept, so this is what keeps it honest: a
    // fifth pack added with no case would otherwise ship with nothing driving
    // it, and a suite that never ran it would still be green.
    expect(
      readdirSync(PRESETS_DIR)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.replace(/\.json$/u, ""))
        .sort(),
    ).toEqual(CASES.map(({ pack }) => pack).sort());
  });

  describe.each(CASES)("$pack", ({ pack, profiles }) => {
    it("loads through the real registry loader, with every profile named in this suite", () => {
      const registry = loadProfileRegistry(presetPath(pack));
      // Not `toEqual` on a literal list: the assertion that matters is that
      // the file and this suite name the same set, in both directions — a
      // profile added to the pack and not exercised here would otherwise ship
      // with no case at all.
      expect(registry.profiles.map((profile) => profile.name).sort()).toEqual(
        profiles.map((profile) => profile.name).sort(),
      );
      // The `base` links too, and for a sharper reason than tidiness: the
      // "its base does not report it" case below is generated from the cases'
      // own `base` fields, so a `base` dropped from this suite would delete
      // that assertion instead of failing it — a test removing itself is the
      // silent direction wearing a green tick.
      expect(
        registry.profiles
          .filter((profile) => profile.base !== undefined)
          .map((profile) => `${profile.name} on ${profile.base}`)
          .sort(),
      ).toEqual(
        profiles
          .filter((profile) => profile.base !== undefined)
          .map((profile) => `${profile.name} on ${profile.base}`)
          .sort(),
      );
    });

    it.each(profiles)("$name validates through policyFrom", ({ name }) => {
      const policy = profilePolicy(presetPath(pack), name, `presets/${pack}.json`);
      expect(policy.depConstraints.length).toBeGreaterThan(0);
      // All eight options resolved, whether stated here or inherited: a
      // profile reaching `policyFrom` with one missing would have thrown.
      expect(Object.keys(policy.options)).toHaveLength(8);
    });

    it.each(profiles)(
      "$name reports the dependency its style forbids",
      ({ name, projects, forbidden, forbiddenMessageId }) => {
        const policy = profilePolicy(presetPath(pack), name, `presets/${pack}.json`);
        const violations = evaluate([forbidden], graphOf(projects), policy);
        expect(violations.map((violation) => violation.messageId)).toContain(forbiddenMessageId);
      },
    );

    it.each(profiles)(
      "$name stays silent on the dependency its style allows",
      ({ name, projects, allowed }) => {
        const policy = profilePolicy(presetPath(pack), name, `presets/${pack}.json`);
        expect(evaluate([allowed], graphOf(projects), policy)).toEqual([]);
      },
    );

    const derived = profiles.filter((profile) => profile.base !== undefined);
    it.each(derived)(
      "$name is what reports it — its base does not",
      ({ base, projects, forbidden }) => {
        const basePolicy = profilePolicy(presetPath(pack), base, `presets/${pack}.json`);
        expect(evaluate([forbidden], graphOf(projects), basePolicy)).toEqual([]);
      },
    );
  });

  it("resolves a derived profile by appending to its base rather than replacing it", () => {
    const registry = loadProfileRegistry(presetPath("hexagonal"));
    const base = resolveProfile(registry.profiles, "hexagonal");
    const derived = resolveProfile(registry.profiles, "hexagonal-pure-domain");
    expect(derived.depConstraints.slice(0, base.depConstraints.length)).toEqual(
      base.depConstraints,
    );
    expect(derived.depConstraints.length).toBeGreaterThan(base.depConstraints.length);
    // The one key the derived profile restates overwrites; the other seven
    // fall through from the base.
    expect(derived.moduleBoundaryOptions.checkNestedExternalImports).toBe(true);
    expect(base.moduleBoundaryOptions.checkNestedExternalImports).toBe(false);
    expect(derived.moduleBoundaryOptions.buildTargets).toEqual(
      base.moduleBoundaryOptions.buildTargets,
    );
  });
});

/**
 * The consumption mechanism itself, end to end: a workspace whose `nx.json`
 * points its `profiles` option at a pack sitting where an install puts it,
 * and selects a profile from it by name.
 *
 * This is the half the fixtures above cannot answer. They prove the rows
 * enforce; this proves a consumer can actually reach them — the option is
 * read, the path resolves inside the workspace, the registry loads from
 * there, and the verdict comes back with the exit code a pipeline steers on.
 * Only Nx and git are injected, the same seam `../cli.integration.test.mjs`
 * uses: neither has anything to say about whether an import is allowed.
 */
describe("a workspace pointing its profiles option at an installed pack", () => {
  const root = mkdtempSync(join(tmpdir(), "lattice-presets-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const write = (relativePath, text) => {
    mkdirSync(join(root, relativePath, ".."), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  };

  /** Where a package manager puts this package's files in a consumer's tree. */
  const installedAt = "node_modules/@ecoma-io/lattice/presets/hexagonal.json";
  mkdirSync(join(root, installedAt, ".."), { recursive: true });
  cpSync(presetPath("hexagonal"), join(root, installedAt));

  write(
    "nx.json",
    `${JSON.stringify({
      plugins: [
        {
          plugin: "@ecoma-io/lattice/nx",
          options: { boundaryConfig: "hexagonal", profiles: installedAt },
        },
      ],
    })}\n`,
  );
  write("libs/http/go.mod", "module example.com/http\n\ngo 1.24\n");
  write("libs/store/go.mod", "module example.com/store\n\ngo 1.24\n");
  write("libs/store/store.go", 'package store\n\nconst Name = "store"\n');
  write(
    "libs/http/http.go",
    `package http

import (
	"example.com/store"
)

var _ = store.Name
`,
  );

  const graph = {
    nodes: {
      http: { name: "http", type: "lib", data: { root: "libs/http", tags: ["layer:adapters"] } },
      store: { name: "store", type: "lib", data: { root: "libs/store", tags: ["layer:adapters"] } },
    },
    dependencies: { http: [], store: [] },
  };
  const files = [
    "nx.json",
    "libs/http/go.mod",
    "libs/http/http.go",
    "libs/store/go.mod",
    "libs/store/store.go",
  ];
  const context = { cwd: root, readGraph: () => graph, listFiles: () => files };

  it("resolves the named profile from the installed file and reports the violation", async () => {
    const { violations, report } = await check(
      { format: "text", config: null, paths: [] },
      context,
    );
    expect(violations).toBe(1);
    expect(report).toContain("libs/http/http.go:4:2  onlyTagsConstraintViolation");
    // The report names the law that produced the verdict, so the run can be
    // read back against itself rather than taken on trust.
    expect(report).toContain('profile "hexagonal"');
    expect(report).toContain(installedAt);
  });

  it("exits clean on the same tree once the target is where the pack allows it", async () => {
    // The other half of the pair, and the one that makes the first mean
    // something: with only a red case, a preset whose rows fired on every
    // import would look identical. Nothing moves but the target's tag —
    // `store` becomes a port, which is exactly what an adapter is allowed to
    // depend on — so the same law reads the same tree as clean.
    const asPort = {
      ...graph.nodes.store,
      data: { ...graph.nodes.store.data, tags: ["layer:ports"] },
    };
    const { violations, report } = await check(
      { format: "text", config: null, paths: [] },
      {
        cwd: root,
        listFiles: () => files,
        readGraph: () => ({
          nodes: { ...graph.nodes, store: asPort },
          dependencies: graph.dependencies,
        }),
      },
    );
    expect(violations).toBe(0);
    expect(report).toContain("✔ no boundary violations");
  });

  it("selects a different profile for one run through --config", async () => {
    const { violations, report } = await check(
      { format: "text", config: "hexagonal-pure-domain", paths: [] },
      context,
    );
    // The derived profile inherits every base row, so the adapter-to-adapter
    // import is still the finding — selection by name reached the same
    // enforcement path a file would have.
    expect(violations).toBe(1);
    expect(report).toContain('profile "hexagonal-pure-domain"');
  });

  it("refuses a name the pack does not carry rather than falling back", async () => {
    await expect(check({ format: "text", config: "onion", paths: [] }, context)).rejects.toThrow(
      /profile "onion" does not exist/u,
    );
  });

  it("is the could-not-look exit class when the pack is not where the option says", async () => {
    const detached = mkdtempSync(join(tmpdir(), "lattice-presets-missing-"));
    try {
      writeFileSync(
        join(detached, "nx.json"),
        `${JSON.stringify({
          plugins: [
            {
              plugin: "@ecoma-io/lattice/nx",
              options: { boundaryConfig: "hexagonal", profiles: installedAt },
            },
          ],
        })}\n`,
      );
      await expect(
        check(
          { format: "text", config: null, paths: [] },
          { cwd: detached, readGraph: () => graph, listFiles: () => ["nx.json"] },
        ),
      ).rejects.toThrow(/cannot read profiles file/u);
    } finally {
      rmSync(detached, { recursive: true, force: true });
    }
    // Named here so the class is visible beside the assertion: a run that
    // could not read its law is exit 3, never the 0 a clean tree gets.
    expect(EXIT.error).toBe(3);
  });
});

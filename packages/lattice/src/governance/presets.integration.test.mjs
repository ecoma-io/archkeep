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
 * A pack's law is not only its constraint rows. A profile may also ship
 * `fitness` functions (`./fitness-registry.mjs`), which `evaluate` never sees
 * — so a profile whose whole point is a fitness row would pass both
 * assertions above while enforcing nothing. Every profile whose RESOLVED
 * policy declares fitness therefore also carries a `fitness` case here, and
 * the suite derives that requirement from the policy rather than from a
 * hand-kept flag: a profile that grows a fitness block and no case fails,
 * instead of shipping a function nothing has ever run.
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
 * (`../../AGENTS.md`).
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { check, EXIT } from "../../cli.mjs";
import { evaluate } from "../rules/index.mjs";
import { judgeFitnessRow } from "./fitness-registry.mjs";
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
 * One fitness function of a resolved profile, judged over a graph carrying a
 * single edge.
 *
 * `match` comes from the shipped row rather than from the case, so a pack that
 * narrowed its own `match` until it selected nothing turns the paired
 * assertions into `not_applicable` and fails, instead of passing because the
 * case supplied a wider one.
 */
function declaredFitnessRow(pack, profileName, fitness) {
  if (fitness === undefined) return null;
  const policy = profilePolicy(presetPath(pack), profileName, `presets/${pack}.json`);
  return (policy.fitness ?? []).find((row) => row.name === fitness.function) ?? null;
}

function judgeFitness(pack, profileName, projects, { function: fitnessName }, { source, target }) {
  const policy = profilePolicy(presetPath(pack), profileName, `presets/${pack}.json`);
  const row = (policy.fitness ?? []).find((candidate) => candidate.name === fitnessName);
  if (row === undefined) {
    throw new Error(
      `presets suite: profile "${profileName}" of pack "${pack}" declares no fitness function ` +
        `named "${fitnessName}" — the case names a function the pack does not ship`,
    );
  }
  const graph = graphOf(projects, { [source]: [{ source, target, type: "static" }] });
  return judgeFitnessRow(row, graph, {}, null, []);
}

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
 * One profile's enforcement case.
 *
 * Every field after `name` is optional because a profile's law can live in
 * either half of a policy — constraint rows, a `fitness` block, or both — and
 * the shape has to admit all three. It is not a licence to omit both: the
 * "carries a case for every half of the law it resolves to" assertion below
 * derives what a case must supply from the RESOLVED policy, so a profile with
 * neither half fails there rather than typing cleanly and running nothing.
 *
 * Stated as a typedef rather than left to inference: `it.each(profiles)` over
 * an array whose members differ in which keys they carry infers a union, and
 * TypeScript then resolves `it.each` to its tagged-template overload and
 * reports the array as a missing `TemplateStringsArray` — a real
 * `moon run lattice:typecheck` failure with nothing wrong in the test.
 *
 * @typedef {object} ProfileCase
 * @property {string} name The profile's name in its pack.
 * @property {string} [base] The profile it inherits, when it derives from one.
 * @property {object[]} projects The graph nodes both halves are judged over.
 * @property {object} [forbidden] An import site the style forbids.
 * @property {string} [forbiddenMessageId] The message id `forbidden` must produce.
 * @property {object} [allowed] An import site the style permits.
 * @property {{function: string, forbidden: {source: string, target: string},
 *   allowed: {source: string, target: string},
 *   exempted?: {source: string, target: string}}} [fitness] The declared fitness
 *   function this profile's law includes, with one edge that must fail it, one
 *   that must pass, and — when the function declares an `exempt` list — one
 *   that passes ONLY because of that exemption.
 */

/**
 * Every shipped pack, every profile in it, and the two imports that decide
 * whether the profile is a law or a decoration.
 *
 * `forbidden` is the dependency the style exists to prevent; `allowed` is the
 * near miss that must stay silent. `base` names the profile a derived one
 * inherits, and is what the third assertion above is run against.
 */
/** @type {{pack: string, profiles: ProfileCase[]}[]} */
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
      {
        name: "modular-monolith-sealed-modules",
        base: "modular-monolith",
        projects: [
          project("orders-api", ["module:orders", "layer:module"]),
          project("billing-api", ["module:billing", "layer:module"]),
          project("orders-internal", ["module:orders", "layer:module-internal"]),
          project("orders-core", ["module:orders", "layer:module-internal"]),
          project("billing-internal", ["module:billing", "layer:module-internal"]),
        ],
        // Its whole law is the fitness function: the base's four rows already
        // permit every import this profile is about, which is the false
        // negative it exists to close.
        fitness: {
          function: "module-encapsulation",
          forbidden: { source: "orders-internal", target: "billing-internal" },
          // Inside one module. NOT `orders-internal → orders-api`: the base
          // profile's own row forbids an internal reaching a published
          // surface at all, so asserting a fitness pass on it would claim the
          // profile permits an edge the same resolved policy rejects.
          allowed: { source: "orders-internal", target: "orders-core" },
          // Across modules, permitted only by the exemption — the edge the
          // pack exists to keep open while closing the two beside it.
          exempted: { source: "orders-api", target: "billing-api" },
        },
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
      {
        name: "ddd-bounded-contexts-partitioned",
        base: "ddd-bounded-contexts",
        projects: [
          project("orders-app", ["context:orders", "layer:application"]),
          project("orders-model", ["context:orders", "layer:domain"]),
          project("billing-model", ["context:billing", "layer:domain"]),
          project("billing-contracts", ["context:billing", "layer:published-language"]),
        ],
        // Tagged the way this profile's own page prescribes: `layer:` plus
        // `context:`, and no `share:` axis at all. The pair
        // `ddd-bounded-contexts-isolated` cannot separate is the first two —
        // it reports BOTH, because both are private-to-private. Only reading
        // the `context:` axis relative to the source tells the cross-context
        // reach from the within-context one.
        fitness: {
          function: "context-isolation",
          forbidden: { source: "orders-app", target: "billing-model" },
          allowed: { source: "orders-app", target: "orders-model" },
          exempted: { source: "orders-app", target: "billing-contracts" },
        },
      },
    ],
  },
  {
    pack: "layered",
    profiles: [
      {
        name: "layered-strict",
        projects: [
          project("web", ["tier:presentation"]),
          project("services", ["tier:application"]),
          project("model", ["tier:domain"]),
        ],
        // The finding only strict layering has: the edge points downward,
        // which every layered reading allows, and skips the tier between,
        // which only this one forbids.
        forbidden: crosses("web", "model"),
        forbiddenMessageId: "onlyTagsConstraintViolation",
        allowed: crosses("web", "services"),
      },
      {
        name: "layered-relaxed",
        projects: [
          project("web", ["tier:presentation"]),
          project("services", ["tier:application"]),
          project("model", ["tier:domain"]),
        ],
        // The one edge every layered reading forbids — upward.
        forbidden: crosses("model", "web"),
        forbiddenMessageId: "onlyTagsConstraintViolation",
        // And the discriminator against its sibling above: the skipped tier
        // that `layered-strict` reports is what "relaxed" means.
        allowed: crosses("web", "model"),
      },
    ],
  },
  {
    pack: "vertical-slice",
    profiles: [
      {
        name: "vertical-slice",
        projects: [
          project("orders", ["layer:slice", "feature:orders"]),
          project("catalog", ["layer:slice", "feature:catalog"]),
          project("kernel", ["layer:shared-kernel"]),
        ],
        // The kernel reaching into a slice: everything depends on the kernel,
        // so anything the kernel depends on is shared by every slice.
        forbidden: crosses("kernel", "orders"),
        forbiddenMessageId: "onlyTagsConstraintViolation",
        allowed: crosses("orders", "kernel"),
        // The row above cannot see this one: both slices carry `layer:slice`,
        // so a tag list permits any slice to reach any other. The feature:
        // axis is what separates them, and only the fitness function reads it.
        fitness: {
          function: "slice-isolation",
          forbidden: { source: "orders", target: "catalog" },
          // The kernel carries no `feature:` tag, so it belongs to no slice
          // and this edge is not the function's subject. That is the near-miss
          // that matters: a partition check reporting every kernel import
          // would be unusable in the style it was written for.
          allowed: { source: "orders", target: "kernel" },
        },
      },
      {
        name: "vertical-slice-sealed-kernel",
        base: "vertical-slice",
        projects: [
          project("orders", ["layer:slice", "feature:orders"]),
          project("catalog", ["layer:slice", "feature:catalog"]),
          project("kernel", ["layer:shared-kernel"]),
        ],
        forbidden: reachesOutside("kernel", "node:crypto"),
        forbiddenMessageId: "bannedExternalImportsViolation",
        // A slice is where a package is allowed to arrive.
        allowed: reachesOutside("orders", "node:crypto"),
        // Inherited from the base, so the base-does-not-report-it assertion
        // below correctly does NOT apply to it — the suite derives that from
        // which profile's own block declares the function.
        fitness: {
          function: "slice-isolation",
          forbidden: { source: "orders", target: "catalog" },
          // The kernel carries no `feature:` tag, so it belongs to no slice
          // and this edge is not the function's subject. That is the near-miss
          // that matters: a partition check reporting every kernel import
          // would be unusable in the style it was written for.
          allowed: { source: "orders", target: "kernel" },
        },
      },
    ],
  },
];

describe("shipped policy packs", () => {
  it("exercises every pack the directory holds", () => {
    // The pack list above is hand-kept, so this is what keeps it honest: a
    // pack added with no case would otherwise ship with nothing driving
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
      "$name carries a case for every half of the law it resolves to",
      ({ name, forbidden, fitness }) => {
        // The `exempt` half too: an exemption is a hole a profile deliberately
        // leaves in its own partition rule, and a hole nothing drives through
        // is a hole nobody has checked the shape of. Deleting `exempt` from a
        // shipped profile used to leave this suite green.
        const declared = declaredFitnessRow(pack, name, fitness);
        if (declared?.condition?.exempt?.length > 0) {
          expect(
            fitness.exempted,
            `${name}'s fitness function declares an exempt list that no case drives through`,
          ).toBeDefined();
        }
        // Derived from the resolved policy, never from a flag on the case: a
        // profile that grows a fitness block and no case fails here rather
        // than shipping a function nothing has ever run. The rule half is
        // required outright — every shipped profile resolves to constraint
        // rows, inherited or its own.
        const policy = profilePolicy(presetPath(pack), name, `presets/${pack}.json`);
        expect(
          policy.depConstraints.length,
          `${name} resolves to no constraint rows`,
        ).toBeGreaterThan(0);
        expect(
          fitness === undefined,
          `${name} resolves to a fitness block but this suite drives none of it`,
        ).toBe(policy.fitness === undefined);
        expect(
          forbidden === undefined && fitness === undefined,
          `${name} has no enforcement case at all`,
        ).toBe(false);
      },
    );

    const ruleCases = profiles.filter((profile) => profile.forbidden !== undefined);
    it.each(ruleCases)(
      "$name reports the dependency its style forbids",
      ({ name, projects, forbidden, forbiddenMessageId }) => {
        const policy = profilePolicy(presetPath(pack), name, `presets/${pack}.json`);
        const violations = evaluate([forbidden], graphOf(projects), policy);
        expect(violations.map((violation) => violation.messageId)).toContain(forbiddenMessageId);
      },
    );

    it.each(ruleCases)(
      "$name stays silent on the dependency its style allows",
      ({ name, projects, allowed }) => {
        const policy = profilePolicy(presetPath(pack), name, `presets/${pack}.json`);
        expect(evaluate([allowed], graphOf(projects), policy)).toEqual([]);
      },
    );

    const fitnessCases = profiles.filter((profile) => profile.fitness !== undefined);
    it.each(fitnessCases)(
      "$name fails its declared fitness function on the edge that style forbids",
      ({ name, projects, fitness }) => {
        expect(judgeFitness(pack, name, projects, fitness, fitness.forbidden).verdict).toBe("fail");
      },
    );

    it.each(fitnessCases)(
      "$name passes its declared fitness function on the edge that style allows",
      ({ name, projects, fitness }) => {
        expect(judgeFitness(pack, name, projects, fitness, fitness.allowed).verdict).toBe("pass");
      },
    );

    it.each(fitnessCases.filter((profile) => profile.fitness.exempted !== undefined))(
      "$name passes the cross-partition edge only its exemption allows",
      ({ name, projects, fitness }) => {
        expect(judgeFitness(pack, name, projects, fitness, fitness.exempted).verdict).toBe("pass");
        // And it really is the exemption doing it: the same edge judged by the
        // same row with its `exempt` list removed is a crossing. Without this,
        // an `exempted` edge that happened to share a partition would pass for
        // the wrong reason, and deleting `exempt` from the shipped profile
        // would leave this suite green.
        const declared = declaredFitnessRow(pack, name, fitness);
        const condition = { ...declared.condition };
        delete condition.exempt;
        const { source, target } = fitness.exempted;
        const graph = graphOf(projects, { [source]: [{ source, target, type: "static" }] });
        expect(judgeFitnessRow({ ...declared, condition }, graph, {}, null, []).verdict).toBe(
          "fail",
        );
      },
    );

    it.each(fitnessCases)(
      "$name does not claim a fitness pass on an edge its own rules reject",
      ({ name, projects, fitness }) => {
        // The two halves of a resolved policy are judged separately, so a
        // fitness case could assert `pass` on an edge the SAME policy's
        // constraint rows forbid — a profile that reads as permitting
        // something it rejects. Every edge a fitness case calls allowed goes
        // through `evaluate` as well.
        const policy = profilePolicy(presetPath(pack), name, `presets/${pack}.json`);
        for (const edge of [fitness.allowed, fitness.exempted].filter(Boolean)) {
          expect(
            evaluate([crosses(edge.source, edge.target)], graphOf(projects), policy),
            `${name}: ${edge.source} → ${edge.target} passes the fitness function but not the rules`,
          ).toEqual([]);
        }
      },
    );

    const derived = profiles.filter((profile) => profile.base !== undefined);
    it.each(derived.filter((profile) => profile.forbidden !== undefined))(
      "$name is what reports it — its base does not",
      ({ base, projects, forbidden }) => {
        const basePolicy = profilePolicy(presetPath(pack), base, `presets/${pack}.json`);
        expect(evaluate([forbidden], graphOf(projects), basePolicy)).toEqual([]);
      },
    );

    it.each(derived.filter((profile) => profile.fitness !== undefined))(
      "$name adds its fitness law rather than inheriting the verdict",
      ({ name, base, projects, fitness }) => {
        // Only when THIS profile's own block declares the function. A derived
        // profile that merely inherits one (vertical-slice-sealed-kernel) must
        // not be asserted to differ from its base about it — that would be a
        // test demanding the inheritance be broken.
        const own = loadProfileRegistry(presetPath(pack)).profiles.find(
          (profile) => profile.name === name,
        ).block.fitness;
        const declaredHere = (own ?? []).some((row) => row.name === fitness.function);
        if (!declaredHere) {
          expect(judgeFitness(pack, base, projects, fitness, fitness.forbidden).verdict).toBe(
            "fail",
          );
          return;
        }
        // The base cannot fail on the edge, because the base does not declare
        // the function at all — asserted as the fact it is, so a base that
        // silently grew one is a red test rather than a skipped branch.
        const basePolicy = profilePolicy(presetPath(pack), base, `presets/${pack}.json`);
        expect((basePolicy.fitness ?? []).map((row) => row.name)).not.toContain(fitness.function);
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

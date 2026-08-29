/**
 * The fixture workspaces the labeled corpus runs over — one native
 * (`archkeep.json`) tree per case, each in its own throwaway root.
 *
 * ## Why one root per case here, and one shared root next door
 *
 * `./fixture.mjs` puts every differential case under a SINGLE root because
 * `@nx/enforce-module-boundaries` reads its workspace root through
 * `@nx/devkit`, which resolves that root once per process and never again.
 * Nothing in this corpus loads Nx at all: the native provider takes its
 * project model from the `archkeep.json` at the root it is handed
 * (`../providers/native/model.mjs`), so each case can have its own root — and
 * gets one, because a per-case root is what makes a case's project names,
 * import aliases and package names local facts rather than workspace-wide
 * ones the whole catalogue has to keep unique.
 *
 * Nothing is ever written inside the repository: every root is a `mkdtemp`
 * directory under the OS temp dir, removed when the case's assertions are
 * done. That containment is what keeps this repository's own lint, format and
 * typecheck targets from ever reaching a fixture — the same arrangement
 * `./fixture.mjs` documents.
 *
 * ## What a case states, and what this module writes for it
 *
 * A case (`./corpus.mjs`) states its projects, its constraint table, its
 * sources and its manifests. It never writes `archkeep.json`, never repeats the
 * eight `moduleBoundaryOptions`, and never writes the deny-all policy below —
 * all three are assembled here, once, so twenty cases cannot drift into twenty
 * spellings of the same workspace scaffolding.
 *
 * A case that declares decision governance states it too: `decisions` (one
 * `docs/adr/` record written per entry — minimal, deterministic frontmatter
 * that parses under the registry's strict dialect) and, on a `depConstraints`
 * row, `decisionRef` (a pointer the verbatim policy serializer carries into
 * the rendered module unchanged, reaching the checker's decision-resolution
 * pass). A case never writes `docs/adr/` itself — the builder owns it, and
 * `decisionGovernanceViolations` refuses a case that would shadow one of its
 * own records.
 *
 * ## The deny-all policy, and why every case tree carries one
 *
 * A near-miss probe asserts silence. Silence is exactly what a probe the
 * engine never looked at also produces, so a corpus of near-misses can pass
 * while reading nothing at all — the failure `../../../../AGENTS.md`'s
 * invariant is about, aimed at this harness rather than at the tool.
 *
 * So every case tree gets a SECOND policy file which forbids everything: one
 * row matching every project (`sourceTag: "*"`) whose
 * `onlyDependOnLibsWithTags` names a tag no project carries and whose
 * `bannedExternalImports` is `*`. Under it, every import site that reaches
 * another project or a package the ban can match must report. Each probe
 * states how many findings that run must produce at its file, so a probe's
 * silence under its own case's policy is read against a measurement that the
 * site was seen at all. A probe whose analyzer stopped reading it goes from
 * `denyAll: 1` to `denyAll: 0` and takes the run red, with nothing about the
 * case's own policy involved.
 *
 * The deny-all file carries the CASE's own `moduleBoundaryOptions`, not a
 * second set: the point of the run is to change the constraint table and
 * nothing else, so a case that turns an option on is measured under that
 * option in both runs.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ADR_DIR, ADR_ID_PATTERN, ADR_STATUSES } from "../governance/adr-registry.mjs";

/** The boundary law each case declares, under the default name a workspace gets. */
export const BOUNDARY_CONFIG_FILE = "module-boundaries.config.mjs";

/** The forbid-everything law every case tree also carries — see the header. */
export const DENY_ALL_CONFIG_FILE = "deny-all.config.mjs";

/** The shared TypeScript config, written only for a case that declares aliases. */
export const TS_CONFIG_FILE = "tsconfig.base.json";

/**
 * The tag the deny-all policy demands and no case may declare.
 *
 * Asserted against every case's project tags rather than trusted
 * (`assertDenyAllTagIsUnclaimed`): a case that happened to carry this tag
 * would make its own deny-all run permissive, and every `denyAll: 0` in it
 * would then be measuring nothing.
 */
export const DENY_ALL_TAG = "corpus-tag-no-project-carries";

/**
 * The eight `@nx/enforce-module-boundaries` options, all in their inert
 * setting, which a case overrides one key at a time.
 *
 * Stated here and nowhere else in the corpus. It is a hand-written table, and
 * the thing that keeps it honest is that `../config.mjs` refuses a policy
 * missing any option by name ("every option is stated explicitly") — so an
 * option added to that validator turns every case in this corpus red at load
 * with the missing key named, rather than letting a case run under a value
 * nobody chose. That is the loud direction; a defaulted key would be the
 * silent one.
 *
 * `buildTargets` is the one entry that is not empty: it names the target the
 * buildable-library rule looks for, and it only ever acts in a case that also
 * turns `enforceBuildableLibDependency` on.
 */
export const NEUTRAL_OPTIONS = Object.freeze({
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
});

/** Creates a directory's parent chain and writes `text` into it. */
function write(root, relative, text) {
  const absolute = join(root, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

/**
 * A boundary policy as an `.mjs` module's source.
 *
 * `JSON.stringify` rather than a hand-built literal: a constraint table is
 * data in the case, and re-typing it as source text is where a fixture starts
 * disagreeing with the label written beside it.
 *
 * @param {object[]} depConstraints
 * @param {object} options The eight options, already merged.
 * @returns {string}
 */
export function renderPolicyModule(depConstraints, options) {
  return (
    `export const depConstraints = ${JSON.stringify(depConstraints, null, 2)};\n` +
    `export const moduleBoundaryOptions = ${JSON.stringify(options, null, 2)};\n`
  );
}

/**
 * The `moduleBoundaryOptions` a case runs under: the inert eight, with the
 * case's own overrides on top.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
export function optionsFor(overrides) {
  return { ...NEUTRAL_OPTIONS, ...(overrides ?? {}) };
}

/**
 * The deny-all constraint table — one row, matching every project.
 *
 * Both keys sit on the same row on purpose. `onlyDependOnLibsWithTags`
 * reaches an import whose target is another PROJECT; `bannedExternalImports`
 * reaches one whose target is a package, which never enters the tag block at
 * all (`../rules/README.md`, "an npm target returns before the tag block").
 * One row, both kinds of crossing.
 *
 * @returns {object[]}
 */
export function denyAllConstraints() {
  return [
    {
      sourceTag: "*",
      onlyDependOnLibsWithTags: [DENY_ALL_TAG],
      bannedExternalImports: ["*"],
    },
  ];
}

/**
 * Fails loudly when a case declares the tag the deny-all policy relies on
 * being unclaimed.
 *
 * @param {object[]} cases
 * @throws {Error} naming the case and project that claimed it.
 */
export function assertDenyAllTagIsUnclaimed(cases) {
  for (const spec of cases) {
    for (const project of spec.projects) {
      if ((project.tags ?? []).includes(DENY_ALL_TAG)) {
        throw new Error(
          `archkeep corpus: case '${spec.id}' tags project '${project.name}' with ` +
            `'${DENY_ALL_TAG}', the tag the deny-all policy names to match nothing. A project ` +
            `carrying it would make that policy permissive, and every 'denyAll: 0' in this case ` +
            `would then be measuring an engine that was never asked.`,
        );
      }
    }
  }
}

/**
 * The static, committed creation date every fixture decision record carries.
 *
 * A fixture is committed bytes, never the wall clock: the same date in every
 * generated record keeps `materializeCase` deterministic, so a case's evidence
 * is reproducible across runs and machines. `created` is the registry's key
 * for a record's date — `date` is not a frontmatter key the registry accepts.
 */
export const DECISION_RECORD_CREATED = "2026-08-30";

/**
 * One decision record's bytes, as the fixture writes them into `docs/adr/`.
 *
 * Minimal frontmatter (`id` / `status` / `created` / `bindings`, plus
 * `supersedes` when the decision replaces earlier records, then a heading
 * body) that parses identically under `adr-registry.mjs`'s strict dialect —
 * scalar `key: value`, list `- item` rows indented two spaces — so every
 * record a case declares is loadable the moment the checker reads the tree
 * (`readAdrContext` under `runCorpusCheck`). `JSON.stringify` is deliberately
 * not used here: the registry keys AGENTS.md's "one contract" on by authoring
 * records, not by emitting what its own serializer would.
 *
 * @param {string} slug The ADR id — also the filename stem `<slug>.md`.
 * @param {string} status One of `ADR_STATUSES`.
 * @param {string[]} bindings The constraint ids this decision makes
 *   enforceable — the case's own names for the `depConstraints` rows a row
 *   carrying `decisionRef` leans back on.
 * @param {string[]} [supersedes] The ids of the records this decision
 *   replaces. A `superseded` record is unloadable without an authoritative
 *   successor naming it here — `validateLineage` refuses it at load, so a
 *   case that needs a superseded citation must render the successor's chain.
 * @returns {string}
 */
export function renderAdrRecord(slug, status, bindings, supersedes = []) {
  const list = bindings.map((binding) => `  - ${binding}`).join("\n");
  const bindingsLine = list === "" ? "bindings:" : `bindings:\n${list}`;
  const supersedesList = supersedes.map((id) => `  - ${id}`).join("\n");
  const supersedesLine = supersedesList === "" ? "" : `supersedes:\n${supersedesList}\n`;
  return (
    `---\nid: ${slug}\nstatus: ${status}\ncreated: ${DECISION_RECORD_CREATED}\n${bindingsLine}\n` +
    `${supersedesLine}---\n\n# ${slug}\n`
  );
}

/**
 * Every reason a case's decision governance cannot be rendered — empty when
 * it can.
 *
 * A case may declare `decisions` (one record written to `docs/adr/` per
 * entry) and may point a `depConstraints` row at one of them with a
 * `decisionRef`. This guard holds both halves to the shapes the builder and
 * the registry can actually load: a bad slug or status, a binding that is not
 * a non-empty string, a `supersedes` chain to an undeclared decision, a row
 * citing a decision the case never declares, and — for a case carrying any
 * decision at all — a declared `files` entry inside `docs/adr/` that would
 * shadow a record the builder writes. Each is the loud direction of the
 * invariant: a case whose governance it cannot render must be refused with
 * the reason named, never silently stripped of the records or pointer it
 * claims to carry.
 *
 * @param {object} spec A case from `./corpus.mjs`.
 * @returns {string[]}
 */
export function decisionGovernanceViolations(spec) {
  const violations = [];
  const decisions = spec.decisions ?? [];
  const declared = new Set(decisions.map((decision) => decision.slug));
  for (const decision of decisions) {
    if (!ADR_ID_PATTERN.test(decision.slug)) {
      violations.push(
        `${spec.id}: decision slug '${decision.slug}' is not an ADR id — a decision must be ` +
          `NNN-slug, the form the docs/adr/ registry keys on`,
      );
    }
    if (!ADR_STATUSES.includes(decision.status)) {
      violations.push(
        `${spec.id}: decision '${decision.slug}' has status '${decision.status}' — not one of ` +
          `${ADR_STATUSES.join(", ")}`,
      );
    }
    if (
      !Array.isArray(decision.bindings) ||
      decision.bindings.some((binding) => typeof binding !== "string" || binding.trim() === "")
    ) {
      violations.push(
        `${spec.id}: decision '${decision.slug}' bindings must be a list of non-empty ` +
          `constraint ids (the case's names for the rows it leans on)`,
      );
    }
    if (Array.isArray(decision.supersedes)) {
      for (const ref of decision.supersedes) {
        if (!declared.has(ref)) {
          violations.push(
            `${spec.id}: decision '${decision.slug}' supersedes '${ref}', which is not a ` +
              `decision this case declares`,
          );
        }
      }
    }
  }
  for (const row of spec.depConstraints) {
    if (typeof row?.decisionRef === "string" && !declared.has(row.decisionRef)) {
      violations.push(
        `${spec.id}: a depConstraints row cites decisionRef '${row.decisionRef}' but the case ` +
          `declares no decision with that slug`,
      );
    }
  }
  const adrFiles = Object.keys(spec.files ?? {}).filter((file) => file.startsWith(`${ADR_DIR}/`));
  if (decisions.length > 0 && adrFiles.length > 0) {
    violations.push(
      `${spec.id}: declares ${adrFiles.join(", ")} inside ${ADR_DIR} — when a case declares ` +
        `'decisions', the fixture builder writes a record for each one there`,
    );
  }
  return violations;
}

/** The `archkeep.json` a case's projects and declared files add up to. */
function nativeModel(spec) {
  // Only the two policy modules are exempted, and only because they are
  // `.mjs`: coverage judges the ANALYZABLE files no project claims
  // (`../providers/native/coverage.mjs`), so `archkeep.json` and
  // `tsconfig.base.json` need no row — and a row for either would be refused
  // as stale, since it would match no unclaimed file. A case that declares
  // the workspace root itself as a project (a root-parent Maven reactor)
  // claims both modules instead: they are analyzed beside that project's
  // sources, declare only exports so they contribute no import site, and an
  // exempt row for a claimed file is exactly the stale shape the comment
  // above names.
  const rootClaimed = spec.projects.some((project) => project.root === "");
  const exempt = rootClaimed
    ? []
    : [
        { path: BOUNDARY_CONFIG_FILE, reason: "the workspace's boundary law, owned by no project" },
        {
          path: DENY_ALL_CONFIG_FILE,
          reason: "the corpus's forbid-everything law, owned by no project",
        },
      ];
  const model = {
    projects: {
      declared: spec.projects.map((project) => ({
        root: project.root,
        name: project.name,
        tags: project.tags ?? [],
        ...(project.type === undefined ? {} : { type: project.type }),
        ...(project.targets === undefined ? {} : { targets: project.targets }),
      })),
    },
    coverage: { exempt },
  };
  if (spec.aliases) model.tsConfig = TS_CONFIG_FILE;
  return model;
}

/**
 * Materialises one case into a fresh throwaway root.
 *
 * @param {object} spec A case from `./corpus.mjs`.
 * @returns {{root: string, files: string[]}} The absolute, symlink-resolved
 *   root, and every workspace-relative file in it — the list a run injects in
 *   place of `git ls-files`, so the corpus needs no git repository.
 */
export function materializeCase(spec) {
  // Checked before anything is created, so a refused case leaves no directory
  // behind — a case that declares governance this module cannot render (a
  // record it could not load, or a `docs/adr/` shadow of its own writing) is
  // refused with the reason named, never silently stripped of the governance
  // it claims to carry.
  const governance = decisionGovernanceViolations(spec);
  if (governance.length > 0) {
    throw new Error(
      `archkeep corpus: case '${spec.id}' declares decision governance it cannot render:\n` +
        `  ${governance.join("\n  ")}`,
    );
  }
  // Checked before anything is created, so a refused case leaves no directory
  // behind: a case declaring one of the four files this module owns would
  // overwrite the scaffolding AFTER it was written — a whole case's worth of
  // labels measuring a policy or a project model nobody could see in it.
  const reserved = ["archkeep.json", BOUNDARY_CONFIG_FILE, DENY_ALL_CONFIG_FILE, TS_CONFIG_FILE];
  const shadowed = Object.keys(spec.files).filter((relative) => reserved.includes(relative));
  if (shadowed.length > 0) {
    throw new Error(
      `archkeep corpus: case '${spec.id}' declares ${shadowed.join(", ")}, which this module ` +
        `writes for every case. A case states its projects, its constraint table and its sources; ` +
        `the workspace scaffolding is assembled around it.`,
    );
  }

  const root = mkdtempSync(join(realpathSync(tmpdir()), `archkeep-corpus-${spec.id}-`));
  const options = optionsFor(spec.options);
  const written = [];

  const put = (relative, text) => {
    write(root, relative, text);
    written.push(relative);
  };

  put("archkeep.json", `${JSON.stringify(nativeModel(spec), null, 2)}\n`);
  put(BOUNDARY_CONFIG_FILE, renderPolicyModule(spec.depConstraints, options));
  put(DENY_ALL_CONFIG_FILE, renderPolicyModule(denyAllConstraints(), options));
  if (spec.aliases) {
    put(
      TS_CONFIG_FILE,
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            baseUrl: ".",
            paths: Object.fromEntries(
              Object.entries(spec.aliases).map(([alias, target]) => [alias, [target]]),
            ),
          },
        },
        null,
        2,
      )}\n`,
    );
  }
  // A case that declares decision governance writes those records itself —
  // the same "the module owns its scaffolding" rule that keeps a case from
  // shadowing `archkeep.json`. Validated before anything is created so a
  // refused case leaves no directory behind.
  for (const decision of spec.decisions ?? []) {
    put(
      `${ADR_DIR}/${decision.slug}.md`,
      renderAdrRecord(decision.slug, decision.status, decision.bindings, decision.supersedes),
    );
  }
  for (const [relative, text] of Object.entries(spec.files)) put(relative, text);

  return { root, files: written };
}

/** Removes a case root and everything under it. */
export function removeCaseRoot(root) {
  rmSync(root, { recursive: true, force: true });
}
